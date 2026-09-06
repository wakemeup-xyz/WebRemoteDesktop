"""Controller for an isolated, disposable TURN loss fixture.

This module deliberately has no host-network fallback.  Its rule backend is
only useful from the ``loss-controller`` sidecar described in compose.yaml.
"""
from __future__ import annotations

import ipaddress
import json
import subprocess
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any, Callable, Iterator, Mapping, Protocol


_SCHEMA_FIELDS = frozenset({
    "schemaVersion", "runId", "realm", "namespace", "interface",
    "udpLegSelector", "controlEndpoint", "credentialsFile", "versionDigest",
})
_PATTERNS = {
    "every_100th_for_30s": 30_000,
    "all_for_200ms": 200,
}
_MAX_DURATION_MS = 35_000
_RELAY_PORTS = range(51_000, 51_010)
_HOST_INTERFACES = frozenset({"lo", "en0", "docker0", "bridge0", "utun0"})


def _require_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{field} must be a non-empty string")
    return value


def _require_port(value: Any, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 65535:
        raise ValueError(f"{field} must be a UDP port")
    return value


def _require_fixture_ip(value: Any, field: str) -> str:
    raw = _require_string(value, field)
    try:
        parsed = ipaddress.ip_address(raw)
    except ValueError as exc:
        raise ValueError(f"{field} must be an IP address") from exc
    if parsed.is_loopback or parsed.is_unspecified or parsed.is_multicast:
        raise ValueError(f"{field} cannot target a host/control address")
    return str(parsed)


@dataclass(frozen=True)
class LossFixtureManifest:
    run_id: str
    realm: str
    namespace: str
    interface: str
    selector: dict[str, Any]
    control_endpoint: dict[str, Any]
    credentials_file: str
    version_digest: str

    @classmethod
    def parse(cls, raw: Mapping[str, Any]) -> "LossFixtureManifest":
        if not isinstance(raw, Mapping):
            raise ValueError("fixture manifest must be an object")
        unknown, missing = set(raw) - _SCHEMA_FIELDS, _SCHEMA_FIELDS - set(raw)
        if unknown or missing:
            raise ValueError(f"fixture manifest fields invalid: unknown={sorted(unknown)} missing={sorted(missing)}")
        if raw.get("schemaVersion") != 1:
            raise ValueError("fixture manifest schemaVersion must be 1")
        run_id = _require_string(raw["runId"], "runId")
        try:
            if str(uuid.UUID(run_id)) != run_id:
                raise ValueError
        except (ValueError, AttributeError) as exc:
            raise ValueError("runId must be a canonical UUID") from exc
        realm = _require_string(raw["realm"], "realm")
        if realm == "production" or realm.startswith(("prod", "production")) or not realm.startswith("turn-loss-lab-"):
            raise ValueError("fixture realm must be a non-production turn-loss-lab realm")
        namespace = _require_string(raw["namespace"], "namespace")
        if namespace in {"host", "default"} or not namespace.startswith("turn-loss-") or run_id[:8] not in namespace:
            raise ValueError("fixture namespace must be unique to this run")
        interface = _require_string(raw["interface"], "interface")
        if interface in _HOST_INTERFACES or interface != "eth0":
            raise ValueError("fixture interface must be the isolated container eth0")
        selector_raw = raw["udpLegSelector"]
        if not isinstance(selector_raw, Mapping) or set(selector_raw) != {"protocol", "source", "sourcePort", "destination", "destinationPort"}:
            raise ValueError("udpLegSelector must fully identify exactly one UDP leg")
        if selector_raw.get("protocol") != "udp":
            raise ValueError("udpLegSelector protocol must be udp")
        selector = {
            "protocol": "udp",
            "source": _require_fixture_ip(selector_raw["source"], "udpLegSelector.source"),
            "sourcePort": _require_port(selector_raw["sourcePort"], "udpLegSelector.sourcePort"),
            "destination": _require_fixture_ip(selector_raw["destination"], "udpLegSelector.destination"),
            "destinationPort": _require_port(selector_raw["destinationPort"], "udpLegSelector.destinationPort"),
        }
        endpoint_raw = raw["controlEndpoint"]
        if not isinstance(endpoint_raw, Mapping) or set(endpoint_raw) != {"host", "port"}:
            raise ValueError("controlEndpoint must contain host and port")
        if endpoint_raw["host"] not in {"127.0.0.1", "::1"}:
            raise ValueError("controlEndpoint must remain loopback-only inside the fixture")
        endpoint = {"host": endpoint_raw["host"], "port": _require_port(endpoint_raw["port"], "controlEndpoint.port")}
        if endpoint["port"] in {selector["sourcePort"], selector["destinationPort"]}:
            raise ValueError("control endpoint cannot be selected as media")
        if selector["sourcePort"] not in _RELAY_PORTS:
            raise ValueError("udpLegSelector sourcePort must be in the dedicated fixture relay range")
        credentials_file = _require_string(raw["credentialsFile"], "credentialsFile")
        credential_path = PurePosixPath(credentials_file)
        if credential_path.is_absolute() or ".." in credential_path.parts:
            raise ValueError("credentialsFile must be a relative fixture reference")
        digest = _require_string(raw["versionDigest"], "versionDigest")
        if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            raise ValueError("versionDigest must be a sha256 hex digest")
        return cls(run_id, realm, namespace, interface, selector, endpoint, credentials_file, digest)


class RuleBackend(Protocol):
    def add_rule(self, argv: list[str]) -> None: ...
    def remove_rule(self, argv: list[str]) -> None: ...


class IptablesRuleBackend:
    """Apply exact fixture rules from inside the controller sidecar only."""
    def __init__(self, run: Callable[[list[str]], Any] | None = None) -> None:
        self._run = run or self._subprocess_run

    @staticmethod
    def _subprocess_run(argv: list[str]) -> None:
        subprocess.run(argv, check=True, capture_output=True, text=True)

    def add_rule(self, argv: list[str]) -> None:
        self._run(["iptables", "-w", "-t", "mangle", "-A", "OUTPUT", *argv])

    def remove_rule(self, argv: list[str]) -> None:
        self._run(["iptables", "-w", "-t", "mangle", "-D", "OUTPUT", *argv])


class LossController:
    """Manifest-bound loss controller with watchdog and disconnect cleanup."""
    def __init__(self, manifest: LossFixtureManifest, *, backend: RuleBackend, timer_factory: Callable[[float, Callable[[], None]], Any] = threading.Timer, monotonic_ns: Callable[[], int] = time.monotonic_ns) -> None:
        self.manifest = manifest
        self._backend = backend
        self._timer_factory = timer_factory
        self._monotonic_ns = monotonic_ns
        self._lock = threading.RLock()
        self._baseline_packets = 0
        self._baseline_confirmed = False
        self._timer: Any | None = None
        self._rule: list[str] | None = None
        self.active_event: dict[str, Any] | None = None

    def _require_run(self, run_id: str) -> None:
        if run_id != self.manifest.run_id:
            raise ValueError("runId does not match the fixture manifest")

    def confirm_selected_leg(self, run_id: str, selector: Mapping[str, Any], packet_count: int) -> None:
        """Accept a dry-run only if observed packets used this exact selected leg."""
        self._require_run(run_id)
        if dict(selector) != self.manifest.selector:
            raise ValueError("selected-leg selector does not exactly match the fixture manifest")
        if not isinstance(packet_count, int) or isinstance(packet_count, bool) or packet_count <= 0:
            raise ValueError("selected-leg dry-run requires a nonzero packet baseline")
        with self._lock:
            self._baseline_packets = packet_count
            self._baseline_confirmed = True

    def _rule_for(self, pattern: str) -> list[str]:
        selector = self.manifest.selector
        rule = [
            "-o", self.manifest.interface, "-p", "udp",
            "-s", selector["source"], "--sport", str(selector["sourcePort"]),
            "-d", selector["destination"], "--dport", str(selector["destinationPort"]),
        ]
        if pattern == "every_100th_for_30s":
            rule.extend(["-m", "statistic", "--mode", "nth", "--every", "100", "--packet", "0"])
        rule.extend(["-j", "DROP"])
        return rule

    def apply_loss(self, run_id: str, pattern: str, duration_ms: int) -> dict[str, Any]:
        self._require_run(run_id)
        if pattern not in _PATTERNS or duration_ms != _PATTERNS.get(pattern) or duration_ms > _MAX_DURATION_MS:
            raise ValueError("pattern and duration must be one approved finite loss scenario")
        with self._lock:
            if not self._baseline_confirmed or self._baseline_packets <= 0:
                raise RuntimeError("selected-leg nonzero baseline is required before loss injection")
            if self.active_event is not None:
                raise RuntimeError("another loss rule is already active")
            rule = self._rule_for(pattern)
            self._backend.add_rule(rule)
            event = {
                "runId": run_id, "realm": self.manifest.realm, "namespace": self.manifest.namespace,
                "interface": self.manifest.interface, "selector": dict(self.manifest.selector),
                "pattern": pattern, "durationMs": duration_ms, "baselinePackets": self._baseline_packets,
                "startedMonotonicNs": self._monotonic_ns(), "endedMonotonicNs": None,
                "actualDropCount": 0, "receiverSequenceGaps": [], "clearReason": None,
            }
            self._rule = rule
            self.active_event = event
            self._timer = self._timer_factory(duration_ms / 1000, lambda: self.clear_loss(run_id, reason="watchdog"))
            self._timer.start()
            return dict(event)

    def record_delivery(self, run_id: str, *, actual_drop_count: int, receiver_sequences: list[int]) -> None:
        self._require_run(run_id)
        if not isinstance(actual_drop_count, int) or actual_drop_count < 0:
            raise ValueError("actual_drop_count must be non-negative")
        gaps = _sequence_gaps(receiver_sequences)
        with self._lock:
            if self.active_event is None:
                raise RuntimeError("no active loss rule records this delivery")
            self.active_event["actualDropCount"] += actual_drop_count
            self.active_event["receiverSequenceGaps"] = gaps

    def clear_loss(self, run_id: str, *, reason: str = "explicit") -> dict[str, Any]:
        self._require_run(run_id)
        with self._lock:
            if self.active_event is None:
                return {"runId": run_id, "cleared": False}
            event, rule, timer = self.active_event, self._rule, self._timer
            self.active_event = None
            self._rule = None
            self._timer = None
            if timer is not None:
                timer.cancel()
            try:
                assert rule is not None
                self._backend.remove_rule(rule)
            finally:
                event["endedMonotonicNs"] = self._monotonic_ns()
                event["clearReason"] = reason
            return dict(event)

    @contextmanager
    def connection(self, run_id: str) -> Iterator["LossController"]:
        """A control connection: any exit, including disconnect, removes loss."""
        self._require_run(run_id)
        try:
            yield self
        finally:
            self.clear_loss(run_id, reason="control-connection-closed")


def _sequence_gaps(sequences: list[int]) -> list[int]:
    if any(not isinstance(value, int) or not 0 <= value <= 65535 for value in sequences):
        raise ValueError("receiver sequences must be RTP uint16 values")
    if len(sequences) < 2:
        return []
    # Fixture runs are bounded; reject a wrap/huge gap instead of inventing one.
    ordered = sorted(set(sequences))
    result: list[int] = []
    for previous, current in zip(ordered, ordered[1:]):
        if current - previous > 4097:
            raise ValueError("receiver sequence gap is too large for bounded fixture evidence")
        result.extend(range(previous + 1, current))
    return result


class DockerRuntimeProbe:
    """Read-only daemon probe.  CLI presence alone never means runtime-ready."""
    def __init__(self, *, run: Callable[[list[str]], tuple[int, str, str]] | None = None) -> None:
        self._run = run or self._run_command

    @staticmethod
    def _run_command(argv: list[str]) -> tuple[int, str, str]:
        completed = subprocess.run(argv, text=True, capture_output=True, check=False)
        return completed.returncode, completed.stdout.strip(), completed.stderr.strip()

    def status(self) -> dict[str, str]:
        code, stdout, stderr = self._run(["docker", "version", "--format", "{{.Server.Version}}"])
        if code != 0 or not stdout:
            return {"status": "BLOCKED", "execution": "NOT_RUN", "reason": stderr or "Docker daemon is unavailable"}
        return {"status": "READY", "execution": "NOT_RUN", "daemonVersion": stdout}

    def image_digests(self, images: list[str]) -> dict[str, str]:
        """Resolve pulled images to immutable RepoDigests for run metadata."""
        if self.status()["status"] != "READY":
            raise RuntimeError("Docker daemon is unavailable; fixture image digests are BLOCKED")
        resolved: dict[str, str] = {}
        for image in images:
            code, stdout, stderr = self._run(["docker", "image", "inspect", "--format", "{{json .RepoDigests}}", image])
            if code != 0:
                raise RuntimeError(f"could not resolve image digest for {image}: {stderr}")
            try:
                digests = json.loads(stdout)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"image digest metadata for {image} was not JSON") from exc
            if not isinstance(digests, list):
                raise RuntimeError(f"image digest metadata for {image} was missing")
            digest = next((item for item in digests if isinstance(item, str) and "@sha256:" in item), None)
            if digest is None or len(digest.rsplit("@sha256:", 1)[1]) != 64:
                raise RuntimeError(f"image digest metadata for {image} was missing")
            resolved[image] = digest
        return resolved
