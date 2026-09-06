"""Controller for an isolated, disposable TURN loss fixture.

This module deliberately has no host-network fallback.  Its rule backend is
only useful from the ``loss-controller`` sidecar described in compose.yaml.
"""
from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import secrets
import shutil
import socketserver
import subprocess
import threading
import time
import uuid
import fcntl
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Mapping, Protocol


_SCHEMA_FIELDS = frozenset({
    "schemaVersion", "runId", "realm", "namespace", "interface",
    "udpLegSelector", "controlEndpoint", "credentialsFile", "receiverEvidenceFile", "versionDigest", "imageDigests",
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
    egress_selector: dict[str, Any]
    control_endpoint: dict[str, Any]
    credentials_file: str
    receiver_evidence_file: str
    version_digest: str
    image_digests: dict[str, str]

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
        source_is_relay, destination_is_relay = selector["sourcePort"] in _RELAY_PORTS, selector["destinationPort"] in _RELAY_PORTS
        if source_is_relay == destination_is_relay:
            raise ValueError("udpLegSelector must have exactly one dedicated fixture relay port")
        if source_is_relay:
            egress_selector = dict(selector)
        else:
            # The selected pair can be reported from the peer's perspective.
            # Rules always run at TURN's OUTPUT boundary, so canonicalize it.
            egress_selector = {
                "protocol": "udp", "source": selector["destination"], "sourcePort": selector["destinationPort"],
                "destination": selector["source"], "destinationPort": selector["sourcePort"],
            }
        credentials_file = _require_string(raw["credentialsFile"], "credentialsFile")
        credential_path = PurePosixPath(credentials_file)
        if credential_path.is_absolute() or ".." in credential_path.parts:
            raise ValueError("credentialsFile must be a relative fixture reference")
        receiver_evidence_file = _require_string(raw["receiverEvidenceFile"], "receiverEvidenceFile")
        receiver_path = PurePosixPath(receiver_evidence_file)
        if receiver_path.is_absolute() or ".." in receiver_path.parts or receiver_path != PurePosixPath("receiver/sequence.json"):
            raise ValueError("receiverEvidenceFile must be the isolated receiver/sequence.json reference")
        digest = _require_string(raw["versionDigest"], "versionDigest")
        if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            raise ValueError("versionDigest must be a sha256 hex digest")
        images_raw = raw["imageDigests"]
        if not isinstance(images_raw, Mapping) or set(images_raw) != {"turn", "controller"}:
            raise ValueError("imageDigests must identify immutable turn and controller images")
        image_digests: dict[str, str] = {}
        for name in ("turn", "controller"):
            image = _require_string(images_raw[name], f"imageDigests.{name}")
            repository, separator, image_digest = image.partition("@sha256:")
            if not repository or separator != "@sha256:" or len(image_digest) != 64 or any(char not in "0123456789abcdef" for char in image_digest):
                raise ValueError("fixture images must be immutable sha256 digests")
            image_digests[name] = image
        return cls(run_id, realm, namespace, interface, selector, egress_selector, endpoint, credentials_file, receiver_evidence_file, digest, image_digests)


class RuleBackend(Protocol):
    def add_rule(self, argv: list[str]) -> None: ...
    def remove_rule(self, argv: list[str]) -> None: ...
    def read_rule_counter(self, argv: list[str]) -> int: ...


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
        try:
            self._run(["iptables", "-w", "-t", "mangle", "-D", "OUTPUT", *argv])
        except subprocess.CalledProcessError as exc:
            # An independent watchdog may have won the race.  Treat only the
            # kernel's no-such-rule response as idempotent success.
            if "Bad rule" not in (exc.stderr or ""):
                raise

    def read_rule_counter(self, argv: list[str]) -> int:
        completed = subprocess.run(["iptables-save", "-c", "-t", "mangle"], check=True, capture_output=True, text=True)
        marker = next((part for part in argv if part.startswith("wrd-loss:")), None)
        if marker is None:
            raise RuntimeError("fixture rule has no unique counter marker")
        for line in completed.stdout.splitlines():
            if marker in line and line.startswith("["):
                closing = line.find(":")
                if closing > 1:
                    return int(line[1:closing])
        raise RuntimeError("fixture rule counter was not found")


class RuntimeBlocked(RuntimeError):
    pass


_RESOLVED_IMAGES_SEAL = object()


@dataclass(frozen=True, init=False)
class ResolvedImageEvidence:
    images: dict[str, str]

    def __init__(self, images: Mapping[str, str], *, _seal: object | None = None) -> None:
        if _seal is not _RESOLVED_IMAGES_SEAL:
            raise TypeError("ResolvedImageEvidence is sealed; use DockerRuntimeProbe")
        object.__setattr__(self, "images", dict(images))


def _test_resolved_images(images: Mapping[str, str]) -> ResolvedImageEvidence:
    """Private test fixture; operational callers must use DockerRuntimeProbe."""
    return ResolvedImageEvidence(images, _seal=_RESOLVED_IMAGES_SEAL)


class DeadlineState(Protocol):
    def save(self, event: Mapping[str, Any]) -> None: ...
    def load(self) -> dict[str, Any] | None: ...
    def clear(self) -> None: ...


class MemoryDeadlineState:
    def __init__(self) -> None:
        self.event: dict[str, Any] | None = None

    def save(self, event: Mapping[str, Any]) -> None:
        self.event = dict(event)

    def load(self) -> dict[str, Any] | None:
        return dict(self.event) if self.event is not None else None

    def clear(self) -> None:
        self.event = None


class DeadlineStateStore:
    """Shared run-state file consumed by a process independent watchdog."""
    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def _lock_path(self) -> Path:
        return self.path.with_suffix(".lock")

    def _with_lock(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self._lock_path().open("a+", encoding="utf-8")
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        return handle

    def _load_unlocked(self) -> dict[str, Any] | None:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        if (not isinstance(raw, dict) or raw.get("schemaVersion") != 1
                or raw.get("state") not in {"installing", "armed", "cleanupPending"}
                or not isinstance(raw.get("runId"), str) or not isinstance(raw.get("comment"), str)
                or not isinstance(raw.get("rule"), list) or not all(isinstance(item, str) for item in raw["rule"])
                or not isinstance(raw.get("deadlineMonotonicNs"), int)):
            raise RuntimeError("deadline state is corrupt; fixture must remain blocked")
        return raw

    def _save_unlocked(self, event: Mapping[str, Any]) -> None:
        temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        temporary.write_text(json.dumps(dict(event), sort_keys=True), encoding="utf-8")
        os.replace(temporary, self.path)

    def save(self, event: Mapping[str, Any]) -> None:
        handle = self._with_lock()
        try:
            self._save_unlocked(event)
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            handle.close()

    def load(self) -> dict[str, Any] | None:
        handle = self._with_lock()
        try:
            return self._load_unlocked()
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            handle.close()

    def clear(self) -> None:
        handle = self._with_lock()
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            handle.close()

    def recover(self, backend: RuleBackend, now_ns: int | None) -> dict[str, Any]:
        handle = self._with_lock()
        try:
            event = self._load_unlocked()
            if event is None:
                return {"status": "IDLE"}
            current = time.monotonic_ns() if now_ns is None else now_ns
            if event["state"] == "armed" and current < event["deadlineMonotonicNs"]:
                return {"status": "ARMED", "deadlineMonotonicNs": event["deadlineMonotonicNs"]}
            try:
                backend.remove_rule(list(event["rule"]))
            except Exception as exc:
                event["state"] = "cleanupPending"
                event["cleanupError"] = str(exc)
                self._save_unlocked(event)
                return {"status": "CLEANUP_PENDING", "reason": str(exc)}
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass
            return {"status": "CLEARED", "runId": event.get("runId")}
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            handle.close()


def recover_deadline_state(state_store: DeadlineState, backend: RuleBackend, *, now_ns: int | None = None) -> dict[str, Any]:
    """Independently remove an expired or retry-pending persisted fixture rule."""
    if isinstance(state_store, DeadlineStateStore):
        return state_store.recover(backend, now_ns)
    event = state_store.load()
    if event is None:
        return {"status": "IDLE"}
    current = time.monotonic_ns() if now_ns is None else now_ns
    if event["state"] == "armed" and current < event["deadlineMonotonicNs"]:
        return {"status": "ARMED", "deadlineMonotonicNs": event["deadlineMonotonicNs"]}
    try:
        backend.remove_rule(list(event["rule"]))
    except Exception as exc:
        event["state"] = "cleanupPending"
        event["cleanupError"] = str(exc)
        state_store.save(event)
        return {"status": "CLEANUP_PENDING", "reason": str(exc)}
    state_store.clear()
    return {"status": "CLEARED", "runId": event.get("runId")}


class LossControlSession:
    def __init__(self, controller: "LossController", run_id: str, session_id: str, generation: int) -> None:
        self._controller = controller
        self.run_id = run_id
        self.session_id = session_id
        self.generation = generation
        self.closed = False

    def confirm_selected_leg(self, selector: Mapping[str, Any], packet_count: int, *, observed_monotonic_ns: int | None = None) -> None:
        self._controller._confirm_selected_leg(self, selector, packet_count, observed_monotonic_ns)

    def apply_loss(self, run_id: str, pattern: str, duration_ms: int) -> dict[str, Any]:
        return self._controller._apply_loss(self, run_id, pattern, duration_ms)

    def collect_receiver_evidence(self) -> None:
        self._controller.collect_receiver_evidence(self.run_id)

    def close(self) -> dict[str, Any]:
        if self.closed:
            return {"runId": self.run_id, "cleared": False}
        self.closed = True
        return self._controller._close_session(self)


class ReceiverEvidenceSource(Protocol):
    def sequences_for(self, manifest: LossFixtureManifest, event: Mapping[str, Any]) -> list[int]: ...


class FileReceiverEvidenceSource:
    """Read-only receiver-owned evidence, never supplied in the control RPC."""
    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def sequences_for(self, manifest: LossFixtureManifest, event: Mapping[str, Any]) -> list[int]:
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        expected = {"runId", "sessionId", "generation", "selector", "sequences", "captureDigest"}
        if not isinstance(raw, dict) or set(raw) != expected or raw["runId"] != manifest.run_id or raw["sessionId"] != event["sessionId"] or raw["generation"] != event["generation"] or raw["selector"] != manifest.selector:
            raise RuntimeError("receiver evidence does not bind the active fixture run")
        if not isinstance(raw["sequences"], list) or not isinstance(raw["captureDigest"], str) or len(raw["captureDigest"]) != 64:
            raise RuntimeError("receiver evidence is incomplete")
        return list(raw["sequences"])


class LossController:
    """Manifest-bound controller. Deadline removal belongs to another process."""
    def __init__(self, manifest: LossFixtureManifest, *, backend: RuleBackend, state_store: DeadlineState | None = None, receiver_source: ReceiverEvidenceSource | None = None, baseline_ttl_ns: int = 10_000_000_000, monotonic_ns: Callable[[], int] = time.monotonic_ns) -> None:
        self.manifest = manifest
        self._backend = backend
        self._state_store = state_store or MemoryDeadlineState()
        self._receiver_source = receiver_source
        self._baseline_ttl_ns = baseline_ttl_ns
        self._monotonic_ns = monotonic_ns
        self._lock = threading.RLock()
        self._baselines: dict[str, dict[str, Any]] = {}
        self._session_generations: dict[str, int] = {}
        self.active_event: dict[str, Any] | None = None
        self._last_event: dict[str, Any] | None = None

    def _require_run(self, run_id: str) -> None:
        if run_id != self.manifest.run_id:
            raise ValueError("runId does not match the fixture manifest")

    def open_session(self, run_id: str, session_id: str, generation: int, *, clock: Any | None = None) -> LossControlSession:
        self._require_run(run_id)
        if not isinstance(session_id, str) or not session_id or not isinstance(generation, int) or generation < 0:
            raise ValueError("control session and generation are required")
        with self._lock:
            known = self._session_generations.get(session_id)
            if known is not None and known != generation:
                raise ValueError("control session generation cannot change")
            self._session_generations[session_id] = generation
        return LossControlSession(self, run_id, session_id, generation)

    def _confirm_selected_leg(self, session: LossControlSession, selector: Mapping[str, Any], packet_count: int, observed_monotonic_ns: int | None) -> None:
        if session.closed:
            raise RuntimeError("control session is closed")
        if dict(selector) != self.manifest.selector:
            raise ValueError("selected-leg selector does not exactly match the fixture manifest")
        if not isinstance(packet_count, int) or isinstance(packet_count, bool) or packet_count <= 0:
            raise ValueError("selected-leg dry-run requires a nonzero packet baseline")
        observed = self._monotonic_ns() if observed_monotonic_ns is None else observed_monotonic_ns
        if not isinstance(observed, int) or observed < 0:
            raise ValueError("dry-run observation time is invalid")
        with self._lock:
            self._baselines[session.session_id] = {"sessionId": session.session_id, "generation": session.generation, "selector": dict(selector), "packetCount": packet_count, "observedMonotonicNs": observed}

    def _rule_for(self, pattern: str, comment: str) -> list[str]:
        selector = self.manifest.egress_selector
        rule = [
            "-o", self.manifest.interface, "-p", "udp",
            "-s", selector["source"], "--sport", str(selector["sourcePort"]),
            "-d", selector["destination"], "--dport", str(selector["destinationPort"]),
        ]
        if pattern == "every_100th_for_30s":
            rule.extend(["-m", "statistic", "--mode", "nth", "--every", "100", "--packet", "0"])
        rule.extend(["-m", "comment", "--comment", comment])
        rule.extend(["-j", "DROP"])
        return rule

    def _apply_loss(self, session: LossControlSession, run_id: str, pattern: str, duration_ms: int) -> dict[str, Any]:
        if session.closed:
            raise RuntimeError("control session is closed")
        self._require_run(run_id)
        if pattern not in _PATTERNS or duration_ms != _PATTERNS.get(pattern) or duration_ms > _MAX_DURATION_MS:
            raise ValueError("pattern and duration must be one approved finite loss scenario")
        with self._lock:
            baseline = self._baselines.pop(session.session_id, None)  # one dry-run can arm one injection only
            if baseline is None:
                raise RuntimeError("selected-leg nonzero baseline is required before loss injection")
            if baseline["generation"] != session.generation or baseline["selector"] != self.manifest.selector:
                raise RuntimeError("selected-leg baseline does not match this control session")
            now = self._monotonic_ns()
            if now < baseline["observedMonotonicNs"] or now - baseline["observedMonotonicNs"] > self._baseline_ttl_ns:
                raise RuntimeError("selected-leg baseline expired before loss injection")
            if self.active_event is not None:
                raise RuntimeError("another loss rule is already active")
            comment = f"wrd-loss:{run_id[:8]}:{session.session_id}:{session.generation}"
            rule = self._rule_for(pattern, comment)
            event = {
                "schemaVersion": 1, "state": "installing", "comment": comment,
                "runId": run_id, "realm": self.manifest.realm, "namespace": self.manifest.namespace,
                "interface": self.manifest.interface, "selector": dict(self.manifest.selector), "egressSelector": dict(self.manifest.egress_selector),
                "sessionId": session.session_id, "generation": session.generation, "pattern": pattern, "durationMs": duration_ms, "baselinePackets": baseline["packetCount"],
                "rule": rule, "startedMonotonicNs": now, "deadlineMonotonicNs": now + duration_ms * 1_000_000, "endedMonotonicNs": None,
                "actualDropCount": 0, "receiverSequenceGaps": [], "clearReason": None, "dropCounterAtInstall": None,
            }
            try:
                self._state_store.save(event)
                self._backend.add_rule(rule)
                event["dropCounterAtInstall"] = self._backend.read_rule_counter(rule)
                event["state"] = "armed"
                self._state_store.save(event)
            except Exception:
                try:
                    self._backend.remove_rule(rule)
                except Exception as rollback_error:
                    raise RuntimeError("deadline state write failed and rule rollback failed") from rollback_error
                raise
            self.active_event = event
            return dict(event)

    def collect_receiver_evidence(self, run_id: str) -> None:
        self._require_run(run_id)
        with self._lock:
            event = self.active_event or self._last_event
            if event is None or event.get("runId") != run_id:
                raise RuntimeError("no active loss rule records this delivery")
            if self._receiver_source is None:
                raise RuntimeError("receiver evidence source is unavailable")
            gaps = sequence_gaps(self._receiver_source.sequences_for(self.manifest, event))
            current = self._backend.read_rule_counter(list(event["rule"]))
            baseline = event.get("dropCounterAtInstall")
            if not isinstance(baseline, int) or current < baseline:
                raise RuntimeError("iptables counter evidence is invalid")
            event["actualDropCount"] = current - baseline
            event["receiverSequenceGaps"] = gaps
            if event is self.active_event:
                self._state_store.save(event)

    def clear_loss(self, run_id: str, *, reason: str = "explicit") -> dict[str, Any]:
        self._require_run(run_id)
        with self._lock:
            if self.active_event is None:
                return {"runId": run_id, "cleared": False}
            event = self.active_event
            try:
                self._backend.remove_rule(list(event["rule"]))
            except Exception as exc:
                event["state"] = "cleanupPending"
                event["cleanupError"] = str(exc)
                self._state_store.save(event)
                return {**event, "cleared": False}
            event["endedMonotonicNs"] = self._monotonic_ns()
            event["clearReason"] = reason
            event["state"] = "armed"
            self._state_store.clear()
            self.active_event = None
            self._last_event = event
            return {**event, "cleared": True}

    def _close_session(self, session: LossControlSession) -> dict[str, Any]:
        self._baselines.pop(session.session_id, None)
        if self.active_event is not None and self.active_event.get("sessionId") == session.session_id:
            return self.clear_loss(session.run_id, reason="control-connection-closed")
        return {"runId": session.run_id, "cleared": False}

    def verify_final_evidence(self, run_id: str) -> dict[str, Any]:
        self._require_run(run_id)
        event = self._last_event
        if event is None or event.get("runId") != run_id or event.get("endedMonotonicNs") is None:
            return {"status": "FAIL", "reason": "loss rule has not been cleanly removed"}
        if event.get("actualDropCount", 0) <= 0 or not event.get("receiverSequenceGaps"):
            return {"status": "FAIL", "reason": "loss had zero observed media effect", "event": dict(event)}
        return {"status": "PASS", "event": dict(event)}


def sequence_gaps(sequences: list[int]) -> list[int]:
    if any(not isinstance(value, int) or not 0 <= value <= 65535 for value in sequences):
        raise ValueError("receiver sequences must be RTP uint16 values")
    if len(sequences) < 2:
        return []
    result: list[int] = []
    seen = {sequences[0]}
    for previous, current in zip(sequences, sequences[1:]):
        if current in seen:
            raise ValueError("receiver sequence contains a duplicate")
        seen.add(current)
        distance = (current - previous) % 65536
        if distance == 0 or distance > 4097:
            raise ValueError("receiver sequence gap is too large for bounded fixture evidence")
        result.extend((previous + offset) % 65536 for offset in range(1, distance))
    return result


class ControlRequestRouter:
    """Authenticated JSON command contract used by the loopback control TCP service."""
    def __init__(self, controller: LossController, control_token: str) -> None:
        self.controller = controller
        self.control_token = control_token

    def authorize(self, request: Mapping[str, Any]) -> None:
        token = request.get("controlToken")
        if not isinstance(token, str) or not secrets.compare_digest(token, self.control_token):
            raise PermissionError("fixture control token is invalid")

    def validate_request(self, request: Mapping[str, Any]) -> None:
        if not isinstance(request, Mapping) or not isinstance(request.get("operation"), str):
            raise ValueError("control request must be an object with an operation")
        expected = {
            "health": {"operation", "controlToken"},
            "open": {"operation", "controlToken", "runId", "sessionId", "generation"},
            "confirm": {"operation", "controlToken", "selector", "packetCount", "observedMonotonicNs"},
            "apply": {"operation", "controlToken", "runId", "pattern", "durationMs"},
            "collect": {"operation", "controlToken"},
            "clear": {"operation", "controlToken"},
        }.get(request["operation"])
        if expected is None or set(request) != expected:
            if "actualDropCount" in request:
                raise ValueError("actualDropCount is not accepted from the control caller")
            raise ValueError("control request fields are invalid")
        for field in ("generation", "packetCount", "observedMonotonicNs", "durationMs"):
            if field in request and (not isinstance(request[field], int) or isinstance(request[field], bool)):
                raise ValueError(f"control field {field} must be an integer")


class _ControlHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        router: ControlRequestRouter = self.server.router  # type: ignore[attr-defined]
        session: LossControlSession | None = None
        try:
            for line in self.rfile:
                request = json.loads(line, parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("non-finite JSON is forbidden")))
                router.authorize(request)
                router.validate_request(request)
                operation = request.get("operation")
                if operation == "health":
                    response: Mapping[str, Any] = {"status": "READY", "deadline": router.controller.active_event is not None}
                elif operation == "open":
                    if session is not None:
                        raise RuntimeError("control session is already open")
                    session = router.controller.open_session(request["runId"], request["sessionId"], request["generation"])
                    response = {"status": "OPEN", "generation": session.generation}
                elif session is None:
                    raise RuntimeError("open a control session before this command")
                elif operation == "confirm":
                    session.confirm_selected_leg(request["selector"], request["packetCount"], observed_monotonic_ns=request.get("observedMonotonicNs"))
                    response = {"status": "BASELINE_CONFIRMED"}
                elif operation == "apply":
                    response = session.apply_loss(request["runId"], request["pattern"], request["durationMs"])
                elif operation == "collect":
                    session.collect_receiver_evidence()
                    response = {"status": "RECEIVER_EVIDENCE_COLLECTED"}
                elif operation == "clear":
                    response = router.controller.clear_loss(session.run_id)
                else:
                    raise ValueError("unknown fixture control operation")
                self.wfile.write((json.dumps(response, sort_keys=True) + "\n").encode())
        except Exception as exc:
            self.wfile.write((json.dumps({"status": "ERROR", "reason": str(exc)}) + "\n").encode())
        finally:
            if session is not None:
                session.close()


class LossControlServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, endpoint: Mapping[str, Any], router: ControlRequestRouter) -> None:
        super().__init__((endpoint["host"], endpoint["port"]), _ControlHandler)
        self.router = router


def load_fixture_credentials(path: Path, realm: str) -> dict[str, str]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("realm") != realm:
        raise ValueError("fixture credentials do not bind the manifest realm")
    required = ("turnUsername", "turnPassword", "controlToken")
    if any(not isinstance(raw.get(key), str) or not raw[key] for key in required):
        raise ValueError("fixture credentials are incomplete")
    return {key: raw[key] for key in required}


def _derived_ports(manifest: LossFixtureManifest) -> tuple[int, int]:
    value = int(hashlib.sha256(manifest.run_id.encode()).hexdigest()[:8], 16)
    return 20000 + value % 10000, 40000 + value % 10000


def prepare_runtime(raw_manifest: Mapping[str, Any], runtime_dir: Path, *, resolved_images: ResolvedImageEvidence | None = None) -> dict[str, str]:
    """Validate one manifest and derive the only supported compose inputs.

    The generated override is intentionally separate from compose.yaml: callers
    must use it with the project name returned here.  No Compose environment
    variable may choose a realm, run ID, listener, or image.
    """
    manifest = LossFixtureManifest.parse(raw_manifest)
    if resolved_images is None:
        raise RuntimeBlocked("Docker resolved image evidence is required before fixture runtime preparation")
    if resolved_images.images != manifest.image_digests:
        raise RuntimeBlocked("resolved image evidence does not exactly match the fixture manifest")
    runtime_dir = Path(runtime_dir)
    credentials_dir = runtime_dir / "credentials"
    credentials_dir.mkdir(parents=True, exist_ok=False)
    (runtime_dir / "receiver").mkdir(mode=0o700)
    credentials = {
        "realm": manifest.realm,
        "turnUsername": f"turn-loss-{manifest.run_id[:8]}",
        "turnPassword": secrets.token_urlsafe(32),
        "controlToken": secrets.token_urlsafe(32),
    }
    credential_path = runtime_dir / manifest.credentials_file
    if credential_path != credentials_dir / "turn.json":
        raise ValueError("fixture credentialsFile must be credentials/turn.json")
    credential_path.write_text(json.dumps(credentials, sort_keys=True), encoding="utf-8")
    credential_path.chmod(0o600)
    (runtime_dir / "turn.env").write_text(
        f"TURN_USERNAME={credentials['turnUsername']}\nTURN_PASSWORD={credentials['turnPassword']}\nTURN_REALM={manifest.realm}\n",
        encoding="utf-8",
    )
    (runtime_dir / "turn.env").chmod(0o600)
    (runtime_dir / "manifest.json").write_text(json.dumps(dict(raw_manifest), sort_keys=True), encoding="utf-8")
    (runtime_dir / "manifest.json").chmod(0o600)
    shutil.copyfile(Path(__file__).with_name("turn-entrypoint.sh"), runtime_dir / "turn-entrypoint.sh")
    turn_port, control_port = _derived_ports(manifest)
    (runtime_dir / "compose.generated.yaml").write_text(
        "services:\n"
        f"  turn:\n    image: {manifest.image_digests['turn']}\n    env_file:\n      - {runtime_dir / 'turn.env'}\n    volumes:\n      - {runtime_dir}:/runtime:ro\n    ports:\n      - 127.0.0.1:{turn_port}:3478/udp\n      - 127.0.0.1:{control_port}:19091/tcp\n      - 127.0.0.1:51000-51009:51000-51009/udp\n    labels:\n      com.wrd.turn-loss-run-id: {manifest.run_id}\n"
        f"  loss-controller:\n    image: {manifest.image_digests['controller']}\n    volumes:\n      - {runtime_dir}:/runtime:ro\n      - {runtime_dir / 'receiver'}:/receiver:ro\n    labels:\n      com.wrd.turn-loss-run-id: {manifest.run_id}\n"
        f"  loss-watchdog:\n    image: {manifest.image_digests['controller']}\n    volumes:\n      - {runtime_dir}:/runtime:ro\n    labels:\n      com.wrd.turn-loss-run-id: {manifest.run_id}\n",
        encoding="utf-8",
    )
    project = f"turn-loss-{manifest.run_id[:8]}"
    return {"projectName": project, "networkName": f"{project}_turn-loss", "runtimeDir": str(runtime_dir), "composeOverride": str(runtime_dir / "compose.generated.yaml"), "turnEndpoint": f"127.0.0.1:{turn_port}", "controlEndpoint": f"127.0.0.1:{control_port}"}


def verify_started_fixture(prepared: Mapping[str, str], *, run: Callable[[list[str]], tuple[int, str, str]]) -> dict[str, str]:
    """Verify Docker's post-start mappings instead of trusting planned ports."""
    required = {"projectName", "networkName", "composeOverride", "turnEndpoint", "controlEndpoint"}
    if set(prepared) < required:
        raise ValueError("prepared fixture layout is incomplete")
    compose = ["docker", "compose", "--project-name", prepared["projectName"], "-f", str(Path(__file__).with_name("compose.yaml")), "-f", prepared["composeOverride"]]
    for target, expected in (("3478", prepared["turnEndpoint"]), ("19091", prepared["controlEndpoint"])):
        code, stdout, stderr = run([*compose, "port", "turn", target])
        if code != 0 or stdout.strip() != expected:
            raise RuntimeBlocked(f"fixture {target} mapping does not match prepared manifest layout: {stderr}")
    code, stdout, stderr = run(["docker", "network", "inspect", "--format", "{{.Name}}", prepared["networkName"]])
    if code != 0 or stdout.strip() != prepared["networkName"]:
        raise RuntimeBlocked(f"fixture network is missing or mismatched: {stderr}")
    return {"status": "READY", "turnEndpoint": prepared["turnEndpoint"], "controlEndpoint": prepared["controlEndpoint"], "networkName": prepared["networkName"]}


def _main() -> None:
    parser = argparse.ArgumentParser()
    subcommands = parser.add_subparsers(dest="command", required=True)
    for name in ("serve", "watchdog"):
        command = subcommands.add_parser(name)
        command.add_argument("--manifest", type=Path, required=True)
        command.add_argument("--state", type=Path, required=True)
    subcommands.choices["serve"].add_argument("--credentials", type=Path, required=True)
    prepare = subcommands.add_parser("prepare")
    prepare.add_argument("--manifest", type=Path, required=True)
    prepare.add_argument("--runtime", type=Path, required=True)
    arguments = parser.parse_args()
    if arguments.command == "prepare":
        raw_manifest = json.loads(arguments.manifest.read_text(encoding="utf-8"))
        manifest = LossFixtureManifest.parse(raw_manifest)
        try:
            result = prepare_runtime(raw_manifest, arguments.runtime, resolved_images=DockerRuntimeProbe().resolve_fixture_images(manifest.image_digests))
        except RuntimeBlocked as exc:
            print(json.dumps({"status": "BLOCKED", "execution": "NOT_RUN", "reason": str(exc)}, sort_keys=True))
            raise SystemExit(2) from exc
        print(json.dumps(result, sort_keys=True))
        return
    manifest = LossFixtureManifest.parse(json.loads(arguments.manifest.read_text(encoding="utf-8")))
    store = DeadlineStateStore(arguments.state)
    backend = IptablesRuleBackend()
    if arguments.command == "watchdog":
        while True:
            recover_deadline_state(store, backend)
            time.sleep(0.1)
    credentials = load_fixture_credentials(arguments.credentials, manifest.realm)
    controller = LossController(manifest, backend=backend, state_store=store, receiver_source=FileReceiverEvidenceSource(Path("/receiver/sequence.json")))
    server = LossControlServer(manifest.control_endpoint, ControlRequestRouter(controller, credentials["controlToken"]))
    server.serve_forever()


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

    def resolve_fixture_images(self, images: Mapping[str, str]) -> ResolvedImageEvidence:
        if self.status()["status"] != "READY":
            raise RuntimeBlocked("Docker daemon is unavailable; fixture preparation is BLOCKED")
        if set(images) != {"turn", "controller"}:
            raise RuntimeBlocked("fixture image set is incomplete")
        observed = self.image_digests(list(images.values()))
        if any(observed.get(image) != image for image in images.values()):
            raise RuntimeBlocked("Docker image digest does not match manifest")
        controller_image = images["controller"]
        code, _stdout, stderr = self._run(["docker", "run", "--rm", "--network", "none", "--entrypoint", "/bin/sh", controller_image, "-c", "test -f /fixture/controller.py && command -v iptables"])
        if code != 0:
            raise RuntimeBlocked(f"controller image lacks controller.py or iptables: {stderr}")
        return ResolvedImageEvidence(images, _seal=_RESOLVED_IMAGES_SEAL)


if __name__ == "__main__":
    _main()
