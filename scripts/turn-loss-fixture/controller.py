"""Controller for an isolated, disposable TURN loss fixture.

This module deliberately has no host-network fallback.  Its rule backend is
only useful from the ``loss-controller`` sidecar described in compose.yaml.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import shutil
import socket
import socketserver
import subprocess
import tempfile
import threading
import time
import uuid
import fcntl
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Mapping, Protocol
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from gateway_evidence import GatewayCounterStore


_SCHEMA_FIELDS = frozenset({
    "schemaVersion", "runId", "realm", "namespace", "interface",
    "udpLegSelector", "controlEndpoint", "credentialsFile", "receiverEvidenceFile", "receiverBridgeFile", "selectedTurn", "versionDigest", "imageDigests",
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
    receiver_bridge_file: str
    selected_turn: dict[str, str]
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
        receiver_bridge_file = _require_string(raw["receiverBridgeFile"], "receiverBridgeFile")
        bridge_path = PurePosixPath(receiver_bridge_file)
        if bridge_path.is_absolute() or ".." in bridge_path.parts or bridge_path != PurePosixPath("receiver/bridge.json"):
            raise ValueError("receiverBridgeFile must be the isolated receiver/bridge.json reference")
        selected_turn_raw = raw["selectedTurn"]
        if not isinstance(selected_turn_raw, Mapping) or set(selected_turn_raw) != {"id", "fingerprint", "digest"}:
            raise ValueError("selectedTurn must identify the selected TURN candidate")
        selected_turn = {"id": _require_string(selected_turn_raw["id"], "selectedTurn.id"),
                         "fingerprint": _require_string(selected_turn_raw["fingerprint"], "selectedTurn.fingerprint"),
                         "digest": _require_string(selected_turn_raw["digest"], "selectedTurn.digest")}
        fingerprint = selected_turn["fingerprint"]
        if not fingerprint.startswith("sha256:") or len(fingerprint) != 71 or any(char not in "0123456789abcdef" for char in fingerprint[7:]):
            raise ValueError("selectedTurn fingerprint must be a sha256 digest")
        if len(selected_turn["digest"]) != 64 or any(char not in "0123456789abcdef" for char in selected_turn["digest"]):
            raise ValueError("selectedTurn digest must be a sha256 hex digest")
        digest = _require_string(raw["versionDigest"], "versionDigest")
        if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            raise ValueError("versionDigest must be a sha256 hex digest")
        images_raw = raw["imageDigests"]
        if not isinstance(images_raw, Mapping) or set(images_raw) != {"turn", "controller"}:
            raise ValueError("imageDigests must identify immutable turn and controller images")
        turn_image = _require_string(images_raw["turn"], "imageDigests.turn")
        repository, separator, turn_digest = turn_image.partition("@sha256:")
        if not repository or separator != "@sha256:" or len(turn_digest) != 64 or any(char not in "0123456789abcdef" for char in turn_digest):
            raise ValueError("TURN image must be a remote repo@sha256 immutable digest")
        controller_image = _require_string(images_raw["controller"], "imageDigests.controller")
        controller_prefix = "sha256:"
        controller_digest = controller_image.removeprefix(controller_prefix)
        if not controller_image.startswith(controller_prefix) or len(controller_digest) != 64 or any(char not in "0123456789abcdef" for char in controller_digest):
            raise ValueError("controller image must be a local OCI sha256 image ID")
        image_digests = {"turn": turn_image, "controller": controller_image}
        return cls(run_id, realm, namespace, interface, selector, egress_selector, endpoint, credentials_file, receiver_evidence_file, receiver_bridge_file, selected_turn, digest, image_digests)


_RUNTIME_RELAY_FIELDS = frozenset({"schemaVersion", "runId", "expectedEgressSelector", "actualEgressSelector", "viewerPair", "hostPair", "mediaBinding"})
_PAIR_FIELDS = frozenset({"pairId", "localCandidateId", "remoteCandidateId", "local", "remote"})
_CANDIDATE_FIELDS = frozenset({"id", "candidateType", "address", "port", "protocol"})


def _require_lab_ip(value: Any, field: str) -> str:
    """Accept fixture-network addresses and the published loopback gateway.

    Docker Desktop presents the public fixture endpoint as loopback to the
    external Lab process.  It is still an observed, non-routable Lab endpoint,
    whereas unspecified, multicast, and arbitrary public addresses remain
    invalid.
    """
    address = ipaddress.ip_address(_require_string(value, field))
    if address.is_loopback:
        return str(address)
    return _require_fixture_ip(str(address), field)


def _runtime_leg(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, Mapping) or set(value) != {"protocol", "source", "sourcePort", "destination", "destinationPort"}:
        raise RuntimeBlocked(f"{field} must identify one actual UDP egress tuple")
    if value.get("protocol") != "udp": raise RuntimeBlocked(f"{field} protocol must be udp")
    return {"protocol": "udp", "source": _require_lab_ip(value.get("source"), f"{field}.source"),
            "sourcePort": _require_port(value.get("sourcePort"), f"{field}.sourcePort"),
            "destination": _require_lab_ip(value.get("destination"), f"{field}.destination"),
            "destinationPort": _require_port(value.get("destinationPort"), f"{field}.destinationPort")}


def _runtime_candidate(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, Mapping) or set(value) != _CANDIDATE_FIELDS:
        raise RuntimeBlocked(f"{field} candidate schema is invalid")
    candidate_type = _require_string(value.get("candidateType"), f"{field}.candidateType")
    if value.get("protocol") != "udp": raise RuntimeBlocked(f"{field}.protocol must be udp")
    return {"id": _require_string(value.get("id"), f"{field}.id"), "candidateType": candidate_type,
            "address": _require_lab_ip(value.get("address"), f"{field}.address"),
            "port": _require_port(value.get("port"), f"{field}.port"), "protocol": "udp"}


def _runtime_pair(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, Mapping) or set(value) != _PAIR_FIELDS:
        raise RuntimeBlocked(f"{field} selected pair schema is invalid")
    result = {"pairId": _require_string(value.get("pairId"), f"{field}.pairId"),
              "localCandidateId": _require_string(value.get("localCandidateId"), f"{field}.localCandidateId"),
              "remoteCandidateId": _require_string(value.get("remoteCandidateId"), f"{field}.remoteCandidateId"),
              "local": _runtime_candidate(value.get("local"), f"{field}.local"),
              "remote": _runtime_candidate(value.get("remote"), f"{field}.remote")}
    if result["localCandidateId"] != result["local"]["id"] or result["remoteCandidateId"] != result["remote"]["id"]:
        raise RuntimeBlocked(f"{field} candidate ids do not bind the selected pair")
    return result


def runtime_relay_binding(*, manifest: LossFixtureManifest, actual_egress: Mapping[str, Any], viewer_pair: Mapping[str, Any], host_pair: Mapping[str, Any], media_binding: Mapping[str, Any]) -> dict[str, Any]:
    """Build a parent-owned binding from live Viewer and Host selected pairs.

    The manifest's static tuple is retained solely as an expected fixture map;
    the controller consumes only ``actualEgressSelector`` after this reciprocal
    pair proof has been validated and written read-only into the namespace.
    """
    return {"schemaVersion": 1, "runId": manifest.run_id, "expectedEgressSelector": dict(manifest.egress_selector),
            "actualEgressSelector": dict(actual_egress), "viewerPair": dict(viewer_pair), "hostPair": dict(host_pair), "mediaBinding": dict(media_binding)}


def load_runtime_relay_binding(path: Path, manifest: LossFixtureManifest) -> dict[str, Any]:
    try: raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError) as exc: raise RuntimeBlocked("actual TURN relay binding is unavailable") from exc
    if not isinstance(raw, Mapping) or set(raw) != _RUNTIME_RELAY_FIELDS or raw.get("schemaVersion") != 1 or raw.get("runId") != manifest.run_id or raw.get("expectedEgressSelector") != manifest.egress_selector:
        raise RuntimeBlocked("actual TURN relay binding does not match the fixture expectation")
    actual, viewer, host = _runtime_leg(raw.get("actualEgressSelector"), "actualEgressSelector"), _runtime_pair(raw.get("viewerPair"), "viewerPair"), _runtime_pair(raw.get("hostPair"), "hostPair")
    media = raw.get("mediaBinding")
    if (not isinstance(media, Mapping) or set(media) != {"outerEgress", "allocationRelay", "peer", "channelNumber", "encapsulation", "rtpSsrc", "payloadType"}
            or _runtime_leg(media.get("outerEgress"), "mediaBinding.outerEgress") != actual
            or not isinstance(media.get("channelNumber"), int) or not 0x4000 <= media["channelNumber"] <= 0x7fff
            or media.get("encapsulation") != "channel-data" or not isinstance(media.get("rtpSsrc"), int) or not 0 <= media["rtpSsrc"] <= 0xffffffff
            or media.get("payloadType") != 96):
        raise RuntimeBlocked("trusted TURN media binding is incomplete")
    def endpoint(candidate: Mapping[str, Any]) -> tuple[str, int, str, str]:
        return (str(candidate["address"]), int(candidate["port"]), str(candidate["protocol"]), str(candidate["candidateType"]))
    if (viewer["local"]["candidateType"] != "relay" or host["remote"]["candidateType"] != "relay"
            or endpoint(viewer["remote"]) != endpoint(host["local"])
            or endpoint(viewer["local"]) != endpoint(host["remote"])):
        raise RuntimeBlocked("Viewer and host selected pair reciprocity is invalid")
    allocation, peer = media.get("allocationRelay"), media.get("peer")
    if (not isinstance(allocation, Mapping) or set(allocation) != {"address", "port"}
            or not isinstance(peer, Mapping) or set(peer) != {"address", "port"}):
        raise RuntimeBlocked("trusted TURN media allocation mapping is incomplete")
    relay = (_require_lab_ip(allocation.get("address"), "mediaBinding.allocationRelay.address"),
             _require_port(allocation.get("port"), "mediaBinding.allocationRelay.port"))
    peer_endpoint = (_require_lab_ip(peer.get("address"), "mediaBinding.peer.address"),
                     _require_port(peer.get("port"), "mediaBinding.peer.port"))
    # Browser stats identify R<->H; the packet observer proves S->C.  Neither
    # may substitute for the other.  The two legs are joined only through the
    # Allocate/ChannelBind mapping carried in ``mediaBinding``.
    if ((viewer["local"]["address"], viewer["local"]["port"]) != relay
            or (viewer["remote"]["address"], viewer["remote"]["port"]) != peer_endpoint):
        raise RuntimeBlocked("selected relay pair does not match TURN allocation mapping")
    return {"actualEgressSelector": actual, "viewerPair": viewer, "hostPair": host, "mediaBinding": dict(media)}


def write_runtime_relay_binding(path: Path, binding: Mapping[str, Any]) -> None:
    destination = Path(path); destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(dict(binding), sort_keys=True), encoding="utf-8"); temporary.chmod(0o600)
    os.replace(temporary, destination); destination.chmod(0o600)


class RuleBackend(Protocol):
    def add_rule(self, argv: list[str]) -> None: ...
    def remove_rule(self, argv: list[str]) -> None: ...
    def read_rule_counter(self, argv: list[str]) -> int: ...
    def add_probe(self, chain: str, jump: list[str], counter_rule: list[str]) -> None: ...
    def remove_probe(self, chain: str, jump: list[str], counter_rule: list[str]) -> None: ...
    def read_probe_counter(self, counter_rule: list[str]) -> int: ...


def verify_gateway_binding(sealed: Mapping[str, Any], *, run_id: str, realm: str) -> dict[str, Any]:
    """Verify the gateway-signed unique media selection before persisting it."""
    if not isinstance(sealed, Mapping) or sealed.get("status") != "SEALED" or sealed.get("signatureAlgorithm") != "Ed25519":
        raise RuntimeBlocked("gateway media-binding receipt is unavailable")
    signed = {key: value for key, value in sealed.items() if key not in {"status", "signature", "signatureAlgorithm"}}
    if (sealed.get("runId") != run_id or sealed.get("realm") != realm or not isinstance(sealed.get("publicKey"), str)
            or not isinstance(sealed.get("gatewayInstanceId"), str) or not isinstance(sealed.get("instanceDigest"), str)
            or not isinstance(sealed.get("mediaBinding"), Mapping) or not isinstance(sealed.get("mediaBindingDigest"), str)):
        raise RuntimeBlocked("gateway media-binding receipt identity is invalid")
    canonical = lambda value: json.dumps(dict(value), sort_keys=True, separators=(",", ":")).encode()
    instance = {key: sealed[key] for key in ("runId", "realm", "gatewayInstanceId", "publicKey")}
    if hashlib.sha256(canonical(instance)).hexdigest() != sealed["instanceDigest"]:
        raise RuntimeBlocked("gateway media-binding instance digest is invalid")
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(sealed["publicKey"])).verify(base64.b64decode(str(sealed.get("signature")), validate=True), canonical(signed))
    except Exception as exc:
        raise RuntimeBlocked("gateway media-binding signature is invalid") from exc
    media = dict(sealed["mediaBinding"])
    if GatewayCounterStore._digest_binding(media) != sealed["mediaBindingDigest"]:
        raise RuntimeBlocked("gateway media-binding digest is invalid")
    return media


def verify_gateway_receipt(receipt: Mapping[str, Any], *, run_id: str, realm: str, event: Mapping[str, Any]) -> dict[str, Any]:
    """Verify the gateway's Ed25519 event receipt without trusting shared JSON."""
    if not isinstance(receipt, Mapping) or receipt.get("signatureAlgorithm") != "Ed25519":
        raise RuntimeError("gateway receipt signature is unavailable")
    signed = {key: value for key, value in receipt.items() if key not in {"signature", "signatureAlgorithm"}}
    if (receipt.get("runId") != run_id or receipt.get("realm") != realm or receipt.get("eventHandle") != event.get("comment")
            or not isinstance(receipt.get("publicKey"), str) or not isinstance(receipt.get("signature"), str)
            or not isinstance(receipt.get("gatewayInstanceId"), str) or not isinstance(receipt.get("instanceDigest"), str)):
        raise RuntimeError("gateway receipt identity is invalid")
    manifest = {key: receipt[key] for key in ("runId", "realm", "gatewayInstanceId", "publicKey")}
    canonical = lambda value: json.dumps(dict(value), sort_keys=True, separators=(",", ":")).encode()
    if hashlib.sha256(canonical(manifest)).hexdigest() != receipt["instanceDigest"]:
        raise RuntimeError("gateway receipt instance digest is invalid")
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(receipt["publicKey"])).verify(base64.b64decode(receipt["signature"], validate=True), canonical(signed))
    except Exception as exc:
        raise RuntimeError("gateway receipt signature is invalid") from exc
    counter = receipt.get("gatewayCounters")
    media = event.get("mediaBinding")
    if (not isinstance(counter, dict) or receipt.get("mediaBindingDigest") != counter.get("mediaBindingDigest")
            or not isinstance(media, Mapping) or counter.get("mediaBindingDigest") != GatewayCounterStore._digest_binding(media)):
        raise RuntimeError("gateway receipt counters are invalid")
    return counter


class GatewayCounterBackend:
    """Controller adapter for the inline Lab gateway's header-only counters.

    It deliberately has the existing ``RuleBackend`` shape so the fixed
    controller protocol and final causal verifier remain unchanged.  No
    network namespace capability or packet-filter operation is involved.
    """
    def __init__(self, counter_path: Path, *, authority_endpoint: tuple[str, int] | None = None,
                 control_token: str | None = None, run_id: str | None = None, realm: str | None = None) -> None:
        self._store = GatewayCounterStore(counter_path)
        self._authority_endpoint, self._control_token = authority_endpoint, control_token
        self._run_id, self._realm = run_id, realm
        if authority_endpoint is not None and (not control_token or not run_id or not realm):
            raise ValueError("gateway receipt verifier identity is incomplete")

    @staticmethod
    def _canonical(value: Mapping[str, Any]) -> bytes:
        return json.dumps(dict(value), sort_keys=True, separators=(",", ":")).encode()

    def _authority_call(self, body: Mapping[str, Any]) -> dict[str, Any]:
        if self._authority_endpoint is None or self._control_token is None:
            raise RuntimeError("gateway receipt authority is unavailable")
        try:
            with socket.create_connection(self._authority_endpoint, timeout=2) as client:
                client.sendall((json.dumps({"controlToken": self._control_token, **dict(body)}, sort_keys=True) + "\n").encode())
                raw = json.loads(client.makefile("rb").readline(1_000_000))
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError("gateway receipt authority is unavailable") from exc
        if not isinstance(raw, dict) or raw.get("status") != "SEALED":
            raise RuntimeError("gateway receipt authority refused request")
        return raw

    def _receipt_for(self, event: Mapping[str, Any]) -> dict[str, Any]:
        event_id = event.get("comment")
        if not isinstance(event_id, str):
            raise RuntimeError("gateway event handle is invalid")
        reply = self._authority_call({"operation": "event-receipt", "eventHandle": event_id})
        receipt = reply.get("receipt")
        if not isinstance(receipt, dict):
            raise RuntimeError("gateway receipt is unavailable")
        verify_gateway_receipt(receipt, run_id=str(self._run_id), realm=str(self._realm), event=event)
        return receipt

    def _verified_receipt(self, event: Mapping[str, Any]) -> dict[str, Any]:
        return verify_gateway_receipt(self._receipt_for(event), run_id=str(self._run_id), realm=str(self._realm), event=event)

    @staticmethod
    def _marker(argv: list[str]) -> str:
        marker = next((part for part in argv if isinstance(part, str) and part.startswith(("wrd-loss:", "wrd-baseline:"))), None)
        if marker is None:
            raise RuntimeError("gateway counter request lacks an event marker")
        return marker

    def add_rule(self, argv: list[str]) -> None:
        self._marker(argv)

    def remove_rule(self, argv: list[str]) -> None:
        self._marker(argv)

    def read_rule_counter(self, argv: list[str]) -> int:
        return int(self._store.count(self._marker(argv))["droppedCount"])

    def add_probe(self, chain: str, jump: list[str], counter_rule: list[str]) -> None:
        self._marker(counter_rule)

    def remove_probe(self, chain: str, jump: list[str], counter_rule: list[str]) -> None:
        self._marker(counter_rule)

    def read_probe_counter(self, counter_rule: list[str]) -> int:
        return int(self._store.count(self._marker(counter_rule))["eligibleCount"])

    def receiver_capture(self, event: Mapping[str, Any]) -> dict[str, Any]:
        """Return the gateway's own receiver-directed header evidence.

        The inline gateway is the only component that sees both the confirmed
        ChannelData stream and the actual successful send to the Viewer.  This
        replaces the privileged host packet-capture sidecar for final PASS.
        """
        event_id = event.get("comment")
        media, selector = event.get("mediaBinding"), event.get("egressSelector")
        started, ended = event.get("startedMonotonicNs"), event.get("endedMonotonicNs")
        if (not isinstance(event_id, str) or not isinstance(media, Mapping) or not isinstance(selector, Mapping)
                or not isinstance(started, int) or not isinstance(ended, int) or ended < started):
            raise RuntimeError("gateway event binding is unavailable")
        receipt = self._receipt_for(event) if self._authority_endpoint is not None else None
        count = (verify_gateway_receipt(receipt, run_id=str(self._run_id), realm=str(self._realm), event=event) if receipt is not None else self._store.count(event_id))
        digest = GatewayCounterStore._digest_binding(media)
        if (count["eventHandle"] != event_id or count["mediaBindingDigest"] != digest
                or count["startedMonotonicNs"] != started or count["deadlineMonotonicNs"] != event.get("deadlineMonotonicNs")
                or count["sendFailureCount"] != 0 or count["eligibleCount"] <= 0
                or count["droppedCount"] <= 0):
            raise RuntimeError("gateway counter evidence is incomplete")
        ssrc = media.get("rtpSsrc")
        if not isinstance(ssrc, int) or not 0 <= ssrc <= 0xffffffff:
            raise RuntimeError("gateway media SSRC is invalid")
        def rows(sequences: Any, clock: int, *, allow_empty: bool = False) -> list[dict[str, int]]:
            if not isinstance(sequences, list) or (not allow_empty and not sequences):
                raise RuntimeError("gateway receiver-directed phase is empty")
            if any(not isinstance(value, int) or not 0 <= value <= 65535 for value in sequences):
                raise RuntimeError("gateway receiver-directed sequence is invalid")
            return [{"sequence": value, "rtpTimestamp": 0, "ssrc": ssrc, "fixtureClockNs": clock} for value in sequences]
        received = {"before": rows(count["beforeForwardedSequences"], max(0, started - 1)),
                    "during": rows(count["duringForwardedSequences"], started, allow_empty=True),
                    "after": rows(count["afterForwardedSequences"], ended + 1)}
        body = {"source": "gateway-channeldata", "direction": "turn-to-viewer", "runId": event.get("runId"),
                "eventHandle": event_id, "selectedLeg": dict(selector), "gatewayCounters": count,
                "ssrc": ssrc, "receivedRtp": received, **({"gatewayReceipt": receipt} if receipt is not None else {})}
        body["captureDigest"] = hashlib.sha256(_canonical_evidence(body)).hexdigest()
        return body


class RuntimeBlocked(RuntimeError):
    pass


_RESOLVED_IMAGES_SEAL = object()


@dataclass(frozen=True, init=False)
class ResolvedImageEvidence:
    images: dict[str, str]
    controller_base_digest: str
    controller_source_sha256: str
    controller_dockerfile_sha256: str

    def __init__(self, images: Mapping[str, str], *, controller_base_digest: str, controller_source_sha256: str,
                 controller_dockerfile_sha256: str, _seal: object | None = None) -> None:
        if _seal is not _RESOLVED_IMAGES_SEAL:
            raise TypeError("ResolvedImageEvidence is sealed; use DockerRuntimeProbe")
        object.__setattr__(self, "images", dict(images))
        object.__setattr__(self, "controller_base_digest", controller_base_digest)
        object.__setattr__(self, "controller_source_sha256", controller_source_sha256)
        object.__setattr__(self, "controller_dockerfile_sha256", controller_dockerfile_sha256)


def _test_resolved_images(images: Mapping[str, str]) -> ResolvedImageEvidence:
    """Private test fixture; operational callers must use DockerRuntimeProbe."""
    return ResolvedImageEvidence(
        images, controller_base_digest="python@sha256:" + "d" * 64,
        controller_source_sha256="e" * 64, controller_dockerfile_sha256="f" * 64,
        _seal=_RESOLVED_IMAGES_SEAL,
    )


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
                or raw.get("state") not in {"probing", "installing", "armed", "cleanupPending"}
                or not isinstance(raw.get("runId"), str) or not isinstance(raw.get("comment"), str)
                or not isinstance(raw.get("deadlineMonotonicNs"), int)):
            raise RuntimeError("deadline state is corrupt; fixture must remain blocked")
        probe = raw.get("probe")
        if probe is not None:
            if (not isinstance(probe, dict) or set(probe) != {"chain", "jump", "counterRule"}
                    or not isinstance(probe["chain"], str) or not probe["chain"].startswith("WRDB")
                    or not all(isinstance(probe[key], list) and all(isinstance(item, str) for item in probe[key])
                               for key in ("jump", "counterRule"))):
                raise RuntimeError("deadline probe state is corrupt; fixture must remain blocked")
        elif not isinstance(raw.get("rule"), list) or not all(isinstance(item, str) for item in raw["rule"]):
            raise RuntimeError("deadline loss state is corrupt; fixture must remain blocked")
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

    def install_rule(self, event: dict[str, Any], backend: RuleBackend) -> dict[str, Any]:
        """Persist and arm one rule while holding the watchdog's same lock.

        If this process is killed after ``add_rule``, the durable ``installing``
        intent remains for the next watchdog. A concurrent watchdog cannot
        clear that intent while this method is still adding or arming it.
        """
        handle = self._with_lock()
        installed = False
        try:
            if self._load_unlocked() is not None:
                raise RuntimeError("a probe or loss transaction is already active")
            self._save_unlocked(event)
            backend.add_rule(list(event["rule"]))
            installed = True
            event["dropCounterAtInstall"] = backend.read_rule_counter(list(event["rule"]))
            event["state"] = "armed"
            self._save_unlocked(event)
            return event
        except Exception:
            if installed:
                try:
                    backend.remove_rule(list(event["rule"]))
                except Exception as rollback_error:
                    event["state"] = "cleanupPending"
                    event["cleanupError"] = str(rollback_error)
                    self._save_unlocked(event)
                    raise RuntimeError("atomic rule installation rollback failed") from rollback_error
                try:
                    self.path.unlink()
                except FileNotFoundError:
                    pass
            # An add failure can occur after the kernel accepted a rule but
            # before a process receives its result. Keep installing intent so
            # the independent watchdog performs the idempotent delete.
            raise
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            handle.close()

    def run_probe(self, event: dict[str, Any], backend: RuleBackend, observe: Callable[[], None]) -> tuple[int, int]:
        """Run a nonterminal user-chain counter probe under the watchdog lock."""
        handle = self._with_lock()
        probe = event["probe"]
        try:
            if self._load_unlocked() is not None:
                raise RuntimeError("a probe or loss transaction is already active")
            self._save_unlocked(event)
            backend.add_probe(probe["chain"], probe["jump"], probe["counterRule"])
            before = backend.read_probe_counter(probe["counterRule"])
            observe()
            after = backend.read_probe_counter(probe["counterRule"])
            backend.remove_probe(probe["chain"], probe["jump"], probe["counterRule"])
            self.path.unlink(missing_ok=True)
            return before, after
        except Exception:
            try:
                backend.remove_probe(probe["chain"], probe["jump"], probe["counterRule"])
            except Exception as cleanup_error:
                event["state"] = "cleanupPending"
                event["cleanupError"] = str(cleanup_error)
                self._save_unlocked(event)
                raise RuntimeError("probe cleanup failed") from cleanup_error
            self.path.unlink(missing_ok=True)
            raise
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
            if event["state"] == "armed" and event.get("mode") != "baseline" and current < event["deadlineMonotonicNs"]:
                return {"status": "ARMED", "deadlineMonotonicNs": event["deadlineMonotonicNs"]}
            try:
                if "probe" in event:
                    probe = event["probe"]
                    backend.remove_probe(probe["chain"], probe["jump"], probe["counterRule"])
                else:
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
    if event["state"] == "armed" and event.get("mode") != "baseline" and current < event["deadlineMonotonicNs"]:
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
    def __init__(self, controller: "LossController", run_id: str, session_id: str, generation: int, attempt_id: str, stream_id: str) -> None:
        self._controller = controller
        self.run_id = run_id
        self.session_id = session_id
        self.generation = generation
        self.attempt_id = attempt_id
        self.stream_id = stream_id
        self.closed = False

    def confirm_selected_leg(self) -> None:
        self._controller._confirm_selected_leg(self)

    def apply_loss(self, run_id: str, pattern: str, duration_ms: int) -> dict[str, Any]:
        return self._controller._apply_loss(self, run_id, pattern, duration_ms)

    def collect_receiver_evidence(self) -> Mapping[str, Any] | None:
        return self._controller.collect_receiver_evidence(self.run_id)

    def close(self) -> dict[str, Any]:
        if self.closed:
            return {"runId": self.run_id, "cleared": False}
        self.closed = True
        return self._controller._close_session(self)


class ReceiverEvidenceSource(Protocol):
    def sequences_for(self, manifest: LossFixtureManifest, event: Mapping[str, Any]) -> list[int]: ...


class FileReceiverEvidenceSource:
    """Untrusted staging reader; it cannot authorize a media-effect PASS."""
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


def _canonical_evidence(value: Mapping[str, Any]) -> bytes:
    return json.dumps(dict(value), sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def _without_signature(value: Mapping[str, Any]) -> dict[str, Any]:
    return {key: item for key, item in value.items() if key != "signature"}


def _event_binding(value: Mapping[str, Any]) -> dict[str, Any]:
    """`clear_loss` adds a response-only marker that is not event evidence."""
    return {key: item for key, item in value.items() if key not in {"cleared", "receiverCapture"}}


def sign_t3_artifact(artifact: Mapping[str, Any], verifier: bytes) -> str:
    """Mirror T3's sealed artifact contract without importing an untrusted file."""
    return hmac.new(bytes(verifier), _canonical_evidence(_without_signature(artifact)), hashlib.sha256).hexdigest()


def sign_t5_transcript(transcript: Mapping[str, Any], verifier: bytes) -> str:
    body = {key: transcript[key] for key in ("identity", "static", "automatic", "receipts")}
    return hmac.new(bytes(verifier), _canonical_evidence(body), hashlib.sha256).hexdigest()


def sign_receiver_bridge(bridge: Mapping[str, Any], verifier: bytes) -> str:
    return hmac.new(bytes(verifier), _canonical_evidence(_without_signature(bridge)), hashlib.sha256).hexdigest()


def _canonical_t5_segments() -> list[tuple[int, str, str, str]]:
    rows = [(101, "scroll", "wheel", "")]
    for logical in range(2, 12):
        rows.extend((logical * 100 + offset, "drag", phase, "") for offset, phase in ((1, "down"), (2, "move"), (3, "up")))
    for logical in range(12, 32):
        rows.extend((logical * 100 + offset, "text", phase, f"t{logical - 11:02d}" if phase == "text" else "") for offset, phase in ((1, "focus-down"), (2, "focus-up"), (3, "text")))
    return rows


class SignedT3T5ReceiverEvidenceSource:
    """A live-Lab-only receiver bridge, not a persisted JSON assertion.

    T3 and T5 are both HMAC sealed with LabRun.transcript_verifier().  That
    verifier is intentionally unavailable after Lab close.  Requiring it here
    means a copied bridge file, a self-declared capture digest, or a replay
    from another run cannot make the media-effect gate pass.
    """
    _BRIDGE_FIELDS = frozenset({"schemaVersion", "kind", "t3", "t5", "loss", "timeline", "signature"})
    _LOSS_FIELDS = frozenset({"runId", "realm", "sessionId", "attemptId", "generation", "streamId", "selectedTurn", "eventHandle", "startedMonotonicNs", "endedMonotonicNs", "receiverCapture", "receiverCaptures", "eventHandles", "eventBindings"})
    _TIMELINE_FIELDS = frozenset({"feedback", "idr", "paint", "pc", "recovery"})

    def __init__(self, bridge: Mapping[str, Any] | Callable[[], Mapping[str, Any]], *, verifier: bytes) -> None:
        if (not isinstance(bridge, Mapping) and not callable(bridge)) or not isinstance(verifier, bytes) or not verifier:
            raise ValueError("a live Lab verifier and receiver bridge are required")
        self._bridge_reader = bridge if callable(bridge) else lambda: dict(bridge)
        self._verifier = bytes(verifier)

    @classmethod
    def from_file(cls, path: Path, *, verifier: bytes) -> "SignedT3T5ReceiverEvidenceSource":
        def read() -> Mapping[str, Any]:
            raw = json.loads(Path(path).read_text(encoding="utf-8"))
            if not isinstance(raw, Mapping):
                raise RuntimeError("receiver bridge must be an object")
            return raw
        return cls(read, verifier=verifier)

    def _verify_t3(self, value: Any, manifest: LossFixtureManifest, scope: Mapping[str, Any]) -> None:
        if not isinstance(value, Mapping) or not hmac.compare_digest(str(value.get("signature") or ""), sign_t3_artifact(value, self._verifier)):
            raise RuntimeError("T3 artifact signature is unavailable or invalid")
        identity, verification = value.get("identity"), value.get("verification")
        if (value.get("schemaVersion") != 1 or value.get("kind") != "turn-t3-lab-stage-run" or value.get("runId") != manifest.run_id
                or value.get("durationSeconds") != 60 or value.get("status") != "OBSERVED" or value.get("failures") != []
                or not isinstance(identity, Mapping) or identity.get("runId") != manifest.run_id or identity.get("realm") != manifest.realm
                or identity.get("selectedTurn") != manifest.selected_turn
                or value.get("scope") != dict(scope) or not isinstance(verification, Mapping)
                or verification.get("algorithm") != "HMAC-SHA256" or verification.get("selfVerified") is not True
                or verification.get("verifiedBeforeLabClose") is not True):
            raise RuntimeError("T3 artifact does not bind the active Lab scope")

    def _verify_t5(self, value: Any, manifest: LossFixtureManifest, scope: Mapping[str, Any]) -> None:
        if not isinstance(value, Mapping) or set(value) != {"identity", "static", "automatic", "receipts", "signature"}:
            raise RuntimeError("T5 transcript schema is invalid")
        if not hmac.compare_digest(str(value.get("signature") or ""), sign_t5_transcript(value, self._verifier)):
            raise RuntimeError("T5 transcript signature is unavailable or invalid")
        identity, receipts = value["identity"], value["receipts"]
        workload = value["automatic"].get("workload") if isinstance(value.get("automatic"), Mapping) else None
        if (not isinstance(identity, Mapping) or identity.get("runId") != manifest.run_id or identity.get("realm") != manifest.realm
                or identity.get("scope") != dict(scope) or identity.get("selectedTurn") != manifest.selected_turn
                or not isinstance(value["static"], Mapping) or value["static"].get("status") != "PASS"
                or not isinstance(value["automatic"], Mapping) or value["automatic"].get("status") != "PASS"
                or not isinstance(receipts, list) or not receipts or not isinstance(workload, list) or not workload):
            raise RuntimeError("T5 five-way evidence is incomplete")
        input_ids, action_ids, logical_ids = set(), set(), set()
        for receipt in receipts:
            if (not isinstance(receipt, Mapping) or not isinstance(receipt.get("inputId"), str) or not isinstance(receipt.get("actionId"), int)
                    or not isinstance(receipt.get("logicalActionId"), int) or receipt["inputId"] in input_ids or receipt["actionId"] in action_ids
                    or not all(isinstance(receipt.get(key), Mapping) for key in ("reservation", "binding", "ack", "claim", "native", "visual"))):
                raise RuntimeError("T5 receipt does not contain five-way evidence")
            input_ids.add(receipt["inputId"]); action_ids.add(receipt["actionId"])
            input_id = receipt["inputId"]
            logical_ids.add(receipt["logicalActionId"])
            if any(receipt[key].get("inputId") != input_id for key in ("reservation", "ack", "claim", "native", "visual")):
                raise RuntimeError("T5 five-way receipt has mismatched input identity")
        expected = _canonical_t5_segments()
        observed = [(row.get("actionId"), row.get("kind"), row.get("phase"), row.get("text", "")) for row in receipts]
        workload_ids = {row.get("actionId") for row in workload if isinstance(row, Mapping)}
        if observed != expected or workload_ids != set(range(1, 32)) or logical_ids != set(range(1, 32)):
            raise RuntimeError("T5 exact workload does not match five-way receipts")

    def sequences_for(self, manifest: LossFixtureManifest, event: Mapping[str, Any]) -> list[int]:
        bridge = dict(self._bridge_reader())
        if set(bridge) != self._BRIDGE_FIELDS or bridge.get("schemaVersion") != 1 or bridge.get("kind") != "turn-loss-receiver-bridge":
            raise RuntimeError("receiver bridge schema is invalid")
        if not hmac.compare_digest(str(bridge.get("signature") or ""), sign_receiver_bridge(bridge, self._verifier)):
            raise RuntimeError("receiver bridge signature is unavailable or invalid")
        loss, timeline = bridge.get("loss"), bridge.get("timeline")
        if not isinstance(loss, Mapping) or set(loss) != self._LOSS_FIELDS or not isinstance(timeline, Mapping) or set(timeline) != self._TIMELINE_FIELDS:
            raise RuntimeError("receiver bridge fields are invalid")
        scope = {"attemptId": event.get("attemptId"), "generation": event.get("generation"), "streamId": event.get("streamId")}
        if (not isinstance(scope["attemptId"], str) or not isinstance(scope["generation"], int) or isinstance(scope["generation"], bool) or not isinstance(scope["streamId"], str)
                or any(loss.get(key) != value for key, value in {"runId": manifest.run_id, "realm": manifest.realm, "sessionId": event.get("sessionId"), **scope}.items())
                or loss.get("selectedTurn") != manifest.selected_turn or loss.get("eventHandle") != event.get("comment")
                or loss.get("startedMonotonicNs") != event.get("startedMonotonicNs")
                or loss.get("endedMonotonicNs") != event.get("endedMonotonicNs")
                or not isinstance(loss.get("endedMonotonicNs"), int) or loss["endedMonotonicNs"] < loss["startedMonotonicNs"]):
            raise RuntimeError("receiver bridge does not bind the active loss event")
        feedback, idr, paint, pc = timeline["feedback"], timeline["idr"], timeline["paint"], timeline["pc"]
        if (not isinstance(feedback, list) or not feedback or not all(isinstance(row, Mapping) and row.get("kind") in {"PLI", "FIR"} and isinstance(row.get("runnerObservedNs", row.get("monotonicNs")), int) for row in feedback)
                or not isinstance(idr, Mapping) or not isinstance(paint, Mapping) or not isinstance(pc, list) or len(pc) < 2):
            raise RuntimeError("receiver bridge recovery proof is incomplete")
        idr_key, paint_key = idr.get("frameKey"), paint.get("frameKey")
        if (not isinstance(idr_key, Mapping) or not isinstance(paint_key, Mapping)
                or set(idr_key) != {"attemptId", "generation", "streamId", "captureSeq", "wireTimestamp"}
                or idr_key != paint_key or idr.get("wireTimestamp") != idr_key.get("wireTimestamp")
                or paint.get("wireTimestamp") != idr_key.get("wireTimestamp")):
            raise RuntimeError("receiver bridge FrameKey recovery join is invalid")
        pc_ids = {(row.get("id"), row.get("state"), json.dumps(row.get("resolution"), sort_keys=True)) for row in pc if isinstance(row, Mapping)}
        if len(pc_ids) != 1 or next(iter(pc_ids))[1] != "connected": raise RuntimeError("receiver bridge PC identity or resolution changed")
        captures, handles, bindings = loss.get("receiverCaptures"), loss.get("eventHandles"), loss.get("eventBindings")
        if (not isinstance(handles, list) or len(handles) != 2 or len(set(handles)) != 2 or not all(isinstance(item, str) and item for item in handles)
                or not isinstance(captures, Mapping) or set(captures) != set(handles)
                or not isinstance(bindings, Mapping) or set(bindings) != set(handles) or event.get("comment") not in captures
                or any(not isinstance(value, Mapping) or value.get("eventHandle") != handle for handle, value in captures.items())):
            raise RuntimeError("receiver bridge does not contain one capture per approved event")
        # Every approved event has its own clear binding.  Signature-shaped
        # archive rows cannot substitute for a real tuple/kernel/gap proof.
        for handle, capture in captures.items():
            binding = bindings.get(handle)
            expected_binding_scope = {"runId": manifest.run_id, "sessionId": loss.get("sessionId"),
                                      "attemptId": loss.get("attemptId"), "generation": loss.get("generation"),
                                      "streamId": loss.get("streamId"), "comment": handle}
            if (not isinstance(binding, Mapping) or any(binding.get(key) != value for key, value in expected_binding_scope.items())
                    or not isinstance(binding.get("startedMonotonicNs"), int)
                    or not isinstance(binding.get("endedMonotonicNs"), int)
                    or binding["endedMonotonicNs"] < binding["startedMonotonicNs"]):
                raise RuntimeError("receiver event binding is invalid")
            if handle == event.get("comment") and dict(binding) != _event_binding(event):
                raise RuntimeError("receiver bridge final binding is not the cleared control event")
            sequences = _received_sequences_for_capture(capture, manifest, binding, self._verifier)
            if not sequence_gaps(sequences):
                raise RuntimeError("receiver capture has no verified gap")
        if loss.get("receiverCapture") != captures.get(event.get("comment")):
            raise RuntimeError("receiver bridge final capture is not its approved event capture")
        result = _received_sequences_for_capture(loss.get("receiverCapture"), manifest, event, self._verifier)
        recovery = timeline.get("recovery")
        recovery_handles = [row.get("eventHandle") for row in recovery if isinstance(row, Mapping)] if isinstance(recovery, list) else []
        if (len(recovery_handles) != len(handles) or set(recovery_handles) != set(handles)):
            raise RuntimeError("receiver bridge lacks exactly one per-pattern clear recovery")
        for row in recovery:
            if (not isinstance(row, Mapping) or set(row) != {"eventHandle", "clearReplyObservedNs", "feedbackObservedNs", "idrObservedNs", "paintObservedNs", "tapEpoch"}
                    or not all(isinstance(row[key], int) for key in ("clearReplyObservedNs", "feedbackObservedNs", "idrObservedNs", "paintObservedNs", "tapEpoch"))
                    or not isinstance(row.get("eventHandle"), str)
                    or not (row["clearReplyObservedNs"] <= row["feedbackObservedNs"] <= row["idrObservedNs"] <= row["paintObservedNs"])
                    or row["paintObservedNs"] - row["clearReplyObservedNs"] > 2_000_000_000):
                raise RuntimeError("receiver bridge clear recovery is not bounded by runner clock")
        self._verify_t3(bridge.get("t3"), manifest, scope)
        self._verify_t5(bridge.get("t5"), manifest, scope)
        return result

    @property
    def authenticated(self) -> bool:
        return True


def _received_sequences_for_capture(value: Any, manifest: LossFixtureManifest, event: Mapping[str, Any], verifier: bytes) -> list[int]:
    """Accept an authority-sealed gateway send ledger, never Host diagnostics."""
    if not isinstance(value, Mapping): raise RuntimeError("receiver capture is unavailable")
    gateway = value.get("source") == "gateway-channeldata"
    has_receipt = isinstance(value.get("gatewayReceipt"), Mapping)
    required = ({"source", "direction", "runId", "eventHandle", "selectedLeg", "gatewayCounters", "ssrc", "receivedRtp", "captureDigest", "gatewayReceipt"}
                if has_receipt else {"source", "direction", "runId", "eventHandle", "selectedLeg", "gatewayCounters", "ssrc", "receivedRtp", "captureDigest", "authoritySignature"})
    if not gateway or set(value) != required or value.get("direction") != "turn-to-viewer":
        raise RuntimeError("receiver capture provenance is invalid")
    if value.get("runId") != manifest.run_id or value.get("eventHandle") != event.get("comment") or value.get("selectedLeg") != event.get("egressSelector"):
        raise RuntimeError("receiver capture does not bind selected relay leg")
    counter = value.get("gatewayCounters")
    if (not isinstance(counter, Mapping) or not isinstance(value.get("ssrc"), int)
            or not isinstance(event.get("mediaBinding"), Mapping) or value.get("ssrc") != event["mediaBinding"].get("rtpSsrc")):
        raise RuntimeError("receiver capture kernel counter or SSRC is invalid")
    if gateway:
        expected_counter = {"eventHandle", "mediaBindingDigest", "startedMonotonicNs", "deadlineMonotonicNs", "eligibleCount", "forwardedCount", "droppedCount", "sendFailureCount", "beforeForwardedSequences", "duringForwardedSequences", "afterForwardedSequences", "droppedSequences"}
        if (set(counter) != expected_counter or counter.get("eventHandle") != event.get("comment")
                or counter.get("mediaBindingDigest") != GatewayCounterStore._digest_binding(event["mediaBinding"])
                or counter.get("startedMonotonicNs") != event.get("startedMonotonicNs")
                or counter.get("deadlineMonotonicNs") != event.get("deadlineMonotonicNs")
                or not all(isinstance(counter.get(key), int) and counter[key] >= 0 for key in ("eligibleCount", "forwardedCount", "droppedCount", "sendFailureCount"))
                or counter["sendFailureCount"] != 0 or counter["droppedCount"] <= 0):
            raise RuntimeError("gateway counter evidence is invalid")
        if (counter["eligibleCount"] != counter["forwardedCount"] + counter["droppedCount"]
                or len(counter["duringForwardedSequences"]) != counter["forwardedCount"]
                or len(counter["droppedSequences"]) != counter["droppedCount"]
                or event.get("actualDropCount") != counter["droppedCount"]):
            raise RuntimeError("gateway counter totals do not bind the cleared event")
    if has_receipt:
        receipt_counter = verify_gateway_receipt(value["gatewayReceipt"], run_id=manifest.run_id, realm=manifest.realm, event=event)
        if receipt_counter != counter:
            raise RuntimeError("gateway receipt does not bind capture counters")
    cursor, groups = value.get("cursor"), value.get("receivedRtp")
    if (not isinstance(groups, Mapping) or set(groups) != {"before", "during", "after"}):
        raise RuntimeError("receiver capture cursor or phases are invalid")
    digest_body = {key: value[key] for key in required - {"captureDigest", "authoritySignature"}}
    actual = hashlib.sha256(_canonical_evidence(digest_body)).hexdigest()
    if not hmac.compare_digest(str(value.get("captureDigest")), actual): raise RuntimeError("receiver capture digest is invalid")
    # The authority owns this HMAC; a runner-written JSON capture has no way
    # to produce it, even when it knows packet-like rows.
    if not has_receipt:
        expected_signature = hmac.new(verifier, _canonical_evidence({key: value[key] for key in required - {"authoritySignature"}}), hashlib.sha256).hexdigest()
        if not verifier or not hmac.compare_digest(str(value.get("authoritySignature")), expected_signature): raise RuntimeError("receiver capture authority signature is invalid")
    rows: list[Mapping[str, Any]] = []
    for phase in ("before", "during", "after"):
        group = groups[phase]
        if not isinstance(group, list) or (not group and not (gateway and phase == "during")):
            raise RuntimeError("receiver capture misses a phase")
        for row in group:
            if (not isinstance(row, Mapping) or set(row) != {"sequence", "rtpTimestamp", "ssrc", "fixtureClockNs"}
                    or not all(isinstance(row.get(k), int) for k in row) or row.get("ssrc") != value["ssrc"]):
                raise RuntimeError("receiver capture RTP row is invalid")
            rows.append(row)
    started, ended = event.get("startedMonotonicNs"), event.get("endedMonotonicNs")
    during = groups["during"]
    if (not isinstance(started, int) or not isinstance(ended, int) or started > ended
            or not all(started <= row["fixtureClockNs"] <= ended for row in during)):
        raise RuntimeError("receiver capture is not in active loss interval")
    sequences = [row["sequence"] for row in rows]
    if gateway and not set(counter["droppedSequences"]).issubset(set(sequence_gaps(sequences))):
        raise RuntimeError("gateway dropped headers do not match receiver-directed gaps")
    return sequences


class LabReceiverBridgeAuthority:
    """Host-side verifier for a Compose-mounted, per-run Unix socket.

    The Lab parent owns the T3/T5 HMAC verifier.  The controller gets no
    verifier, secret file, environment value, or argv value: it can only ask
    this authority to verify a previously sealed receipt over the dedicated
    socket.  The authority's in-memory receipt table makes a copied seal or a
    second run unable to authenticate after the Lab closes.
    """
    def __init__(self, manifest: LossFixtureManifest, *, verifier: bytes, socket_path: Path) -> None:
        if not isinstance(verifier, bytes) or not verifier:
            raise ValueError("a running Lab transcript verifier is required")
        self.manifest, self._verifier, self.socket_path = manifest, bytes(verifier), Path(socket_path)
        self._receipts: dict[str, dict[str, Any]] = {}
        self._lock = threading.RLock()
        self._servers: list[socketserver.ThreadingUnixStreamServer] = []

    def seal(self, raw_bridge: Mapping[str, Any], event: Mapping[str, Any]) -> dict[str, Any]:
        # The parent signs the raw bridge only after T3/T5 validation. The raw
        # object itself is never accepted as a controller-side assertion.
        bridge = dict(raw_bridge)
        bridge.pop("signature", None)
        bridge["signature"] = sign_receiver_bridge(bridge, self._verifier)
        sequences = SignedT3T5ReceiverEvidenceSource(bridge, verifier=self._verifier).sequences_for(self.manifest, event)
        seal_id = secrets.token_urlsafe(24)
        body = {"runId": self.manifest.run_id, "sealId": seal_id, "event": _event_binding(event), "sequences": sequences}
        signature = hmac.new(self._verifier, _canonical_evidence(body), hashlib.sha256).hexdigest()
        receipt = {**body, "signature": signature}
        with self._lock:
            self._receipts[seal_id] = receipt
        return {"status": "SEALED", "sealId": seal_id, "signature": signature}

    def verify(self, seal: Mapping[str, Any], event: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(seal, Mapping) or set(seal) != {"sealId", "signature"}:
            raise RuntimeError("receiver seal schema is invalid")
        seal_id, signature = seal.get("sealId"), seal.get("signature")
        if not isinstance(seal_id, str) or not isinstance(signature, str):
            raise RuntimeError("receiver seal is invalid")
        with self._lock:
            receipt = self._receipts.get(seal_id)
        if receipt is None or receipt["event"] != _event_binding(event):
            raise RuntimeError("receiver seal does not bind this loss event")
        expected = hmac.new(self._verifier, _canonical_evidence({key: receipt[key] for key in ("runId", "sealId", "event", "sequences")}), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected) or not hmac.compare_digest(receipt["signature"], expected):
            raise RuntimeError("receiver seal signature is invalid")
        with self._lock:
            if self._receipts.pop(seal_id, None) is None:
                raise RuntimeError("receiver seal was already consumed")
        return {"status": "VERIFIED", "sequences": list(receipt["sequences"])}

    def start(self) -> None:
        self.socket_path.parent.mkdir(parents=True, exist_ok=True)
        self.socket_path.unlink(missing_ok=True)
        owner = self
        class VerifyHandler(socketserver.StreamRequestHandler):
            def handle(self) -> None:
                try:
                    raw = json.loads(self.rfile.readline(1_000_000), parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("non-finite JSON is forbidden")))
                    if not isinstance(raw, Mapping) or not isinstance(raw.get("operation"), str):
                        raise ValueError("bridge request is invalid")
                    if raw["operation"] == "seal" and set(raw) == {"operation", "runId", "bridge", "event"} and raw["runId"] == owner.manifest.run_id:
                        result = owner.seal(raw["bridge"], raw["event"])
                    elif raw["operation"] == "verify" and set(raw) == {"operation", "runId", "seal", "event"} and raw["runId"] == owner.manifest.run_id:
                        result = owner.verify(raw["seal"], raw["event"])
                    else:
                        raise ValueError("bridge request schema is invalid")
                except Exception as exc:
                    result = {"status": "BLOCKED", "reason": type(exc).__name__}
                self.wfile.write((json.dumps(result, sort_keys=True) + "\n").encode())
        server = socketserver.ThreadingUnixStreamServer(str(self.socket_path), VerifyHandler)
        self.socket_path.chmod(0o600)
        self._servers.append(server)
        threading.Thread(target=server.serve_forever, daemon=True).start()

    def close(self) -> None:
        for server in self._servers:
            server.shutdown(); server.server_close()
        self._servers = []
        try: self.socket_path.unlink(missing_ok=True)
        except OSError: pass
        try: self.socket_path.parent.rmdir()
        except OSError: pass


class UnixSealedReceiverEvidenceSource:
    """Controller-side socket client; it never receives the Lab verifier."""
    deferred = True
    authenticated = True
    def __init__(self, socket_path: Path, seal_path: Path) -> None:
        self.socket_path, self.seal_path = Path(socket_path), Path(seal_path)

    def sequences_for(self, manifest: LossFixtureManifest, event: Mapping[str, Any]) -> list[int]:
        seal = json.loads(self.seal_path.read_text(encoding="utf-8"))
        request = {"operation": "verify", "runId": manifest.run_id, "seal": seal, "event": dict(event)}
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(2); client.connect(str(self.socket_path)); client.sendall((json.dumps(request, sort_keys=True) + "\n").encode())
            reply = json.loads(client.makefile("rb").readline(1_000_000))
        if not isinstance(reply, Mapping) or reply.get("status") != "VERIFIED" or not isinstance(reply.get("sequences"), list):
            raise RuntimeError("Lab bridge did not verify receiver evidence")
        return list(reply["sequences"])


class LossController:
    """Manifest-bound controller. Deadline removal belongs to another process."""
    def __init__(self, manifest: LossFixtureManifest, *, backend: RuleBackend, state_store: DeadlineState | None = None, receiver_source: ReceiverEvidenceSource | None = None, relay_binding_path: Path | None = None, baseline_ttl_ns: int = 10_000_000_000, monotonic_ns: Callable[[], int] = time.monotonic_ns, probe_window_s: float = 0.25, probe_sleep: Callable[[float], None] = time.sleep) -> None:
        self.manifest = manifest
        self._backend = backend
        self._state_store = state_store or MemoryDeadlineState()
        self._receiver_source = receiver_source
        self._relay_binding_path = Path(relay_binding_path) if relay_binding_path is not None else None
        # T4/T5 do not yet expose a signed receiver-bridge artifact bound to
        # run/attempt/generation/selected pair. Plain files are useful for
        # diagnostics only and must never close the media-effect gate.
        self._receiver_evidence_authenticated = False
        self._baseline_ttl_ns = baseline_ttl_ns
        self._monotonic_ns = monotonic_ns
        self._probe_window_s = probe_window_s
        self._probe_sleep = probe_sleep
        self._lock = threading.RLock()
        self._baselines: dict[str, dict[str, Any]] = {}
        self._session_generations: dict[str, int] = {}
        self.active_event: dict[str, Any] | None = None
        self._last_event: dict[str, Any] | None = None

    def _active_egress_selector(self) -> dict[str, Any]:
        if self._relay_binding_path is None:
            # Unit-only compatibility; the Compose controller is always given
            # the parent-owned live binding path and therefore cannot authorize
            # a static manifest tuple.
            return dict(self.manifest.egress_selector)
        return dict(load_runtime_relay_binding(self._relay_binding_path, self.manifest)["actualEgressSelector"])

    def _active_media_binding(self) -> dict[str, Any]:
        if self._relay_binding_path is None:
            # Legacy in-memory unit backends do not represent a namespace or
            # expose a writable binding path.  This branch is unreachable in
            # Compose: prepare_runtime always supplies --relay-binding.
            selector = self.manifest.egress_selector
            return {"outerEgress": dict(selector), "allocationRelay": {"address": selector["source"], "port": selector["sourcePort"]},
                    "peer": {"address": selector["destination"], "port": selector["destinationPort"]},
                    "channelNumber": 0x4001, "encapsulation": "channel-data", "rtpSsrc": 7, "payloadType": 96}
        return dict(load_runtime_relay_binding(self._relay_binding_path, self.manifest)["mediaBinding"])

    @staticmethod
    def _channel_rtp_classifier(media: Mapping[str, Any]) -> list[str]:
        channel, ssrc = media.get("channelNumber"), media.get("rtpSsrc")
        if not isinstance(channel, int) or not isinstance(ssrc, int): raise RuntimeBlocked("trusted TURN media classifier is unavailable")
        # IP header length + UDP header points at ChannelData.  Match its
        # channel prefix and the encapsulated RTP SSRC, so STUN, RTCP and other
        # data-channel payloads on the identical S->C five-tuple cannot match.
        expr = f"0>>22&0x3C@8&0xffff0000=0x{channel:04x}0000 && 0>>22&0x3C@20=0x{ssrc:08x}"
        return ["-m", "u32", "--u32", expr]

    def _require_run(self, run_id: str) -> None:
        if run_id != self.manifest.run_id:
            raise ValueError("runId does not match the fixture manifest")

    def open_session(self, run_id: str, session_id: str, generation: int, *, attempt_id: str, stream_id: str, clock: Any | None = None) -> LossControlSession:
        self._require_run(run_id)
        if (not isinstance(session_id, str) or not session_id or not isinstance(generation, int) or generation < 0
                or not isinstance(attempt_id, str) or not attempt_id or not isinstance(stream_id, str) or not stream_id):
            raise ValueError("control session, attempt, stream, and generation are required")
        with self._lock:
            known = self._session_generations.get(session_id)
            if known is not None and known != generation:
                raise ValueError("control session generation cannot change")
            self._session_generations[session_id] = generation
        return LossControlSession(self, run_id, session_id, generation, attempt_id, stream_id)

    def _confirm_selected_leg(self, session: LossControlSession) -> None:
        if session.closed:
            raise RuntimeError("control session is closed")
        if self.active_event is not None:
            raise RuntimeError("cannot probe while a loss rule is active")
        nonce = secrets.token_hex(6)
        comment = f"wrd-baseline:{self.manifest.run_id[:8]}:{nonce}"
        chain = f"WRDB{self.manifest.run_id.replace('-', '')[:8]}{nonce[:8]}"
        selector = self._active_egress_selector()
        media = self._active_media_binding()
        jump = [
            "-o", self.manifest.interface, "-p", "udp",
            "-s", selector["source"], "--sport", str(selector["sourcePort"]),
            "-d", selector["destination"], "--dport", str(selector["destinationPort"]),
            *self._channel_rtp_classifier(media),
            "-m", "comment", "--comment", f"{comment}:jump", "-j", chain,
        ]
        counter_rule = ["-m", "comment", "--comment", comment, "-j", "RETURN"]
        started = self._monotonic_ns()
        event = {
            "schemaVersion": 1, "state": "armed", "mode": "baseline", "runId": self.manifest.run_id,
            "comment": comment, "startedMonotonicNs": started,
            "deadlineMonotonicNs": started + 2_000_000_000,
            "mediaBinding": dict(media),
            "probe": {"chain": chain, "jump": jump, "counterRule": counter_rule},
        }
        if isinstance(self._state_store, DeadlineStateStore):
            before, after = self._state_store.run_probe(event, self._backend, lambda: self._probe_sleep(self._probe_window_s))
        else:
            self._backend.add_probe(chain, jump, counter_rule)
            try:
                before = self._backend.read_probe_counter(counter_rule)
                self._probe_sleep(self._probe_window_s)
                after = self._backend.read_probe_counter(counter_rule)
            finally:
                self._backend.remove_probe(chain, jump, counter_rule)
        if not isinstance(before, int) or not isinstance(after, int) or after <= before:
            raise RuntimeError("selected-leg kernel counter probe observed no matching UDP traffic")
        observed = self._monotonic_ns()
        with self._lock:
            self._baselines[session.session_id] = {"sessionId": session.session_id, "generation": session.generation, "selector": dict(selector), "mediaBinding": dict(media), "packetCount": after - before, "observedMonotonicNs": observed}

    def _rule_for(self, pattern: str, comment: str) -> list[str]:
        selector = self._active_egress_selector()
        rule = [
            "-o", self.manifest.interface, "-p", "udp",
            "-s", selector["source"], "--sport", str(selector["sourcePort"]),
            "-d", selector["destination"], "--dport", str(selector["destinationPort"]),
        ]
        rule.extend(self._channel_rtp_classifier(self._active_media_binding()))
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
            if (baseline["generation"] != session.generation or baseline["selector"] != self._active_egress_selector()
                    or baseline["mediaBinding"] != self._active_media_binding()):
                raise RuntimeError("selected-leg baseline does not match this control session")
            now = self._monotonic_ns()
            if now < baseline["observedMonotonicNs"] or now - baseline["observedMonotonicNs"] > self._baseline_ttl_ns:
                raise RuntimeError("selected-leg baseline expired before loss injection")
            if self.active_event is not None:
                raise RuntimeError("another loss rule is already active")
            comment = f"wrd-loss:{run_id[:8]}:{session.session_id}:{session.generation}:{secrets.token_hex(6)}"
            rule = self._rule_for(pattern, comment)
            event = {
                "schemaVersion": 1, "state": "installing", "mode": "loss", "comment": comment,
                "runId": run_id, "realm": self.manifest.realm, "namespace": self.manifest.namespace,
                "interface": self.manifest.interface, "selector": dict(self.manifest.selector), "egressSelector": self._active_egress_selector(), "mediaBinding": self._active_media_binding(), "expectedEgressSelector": dict(self.manifest.egress_selector),
                "sessionId": session.session_id, "attemptId": session.attempt_id, "streamId": session.stream_id, "generation": session.generation, "pattern": pattern, "durationMs": duration_ms, "baselinePackets": baseline["packetCount"],
                "rule": rule, "startedMonotonicNs": now, "deadlineMonotonicNs": now + duration_ms * 1_000_000, "endedMonotonicNs": None,
                "actualDropCount": 0, "receiverSequenceGaps": [], "clearReason": None, "dropCounterAtInstall": None,
            }
            try:
                if isinstance(self._state_store, DeadlineStateStore):
                    event = self._state_store.install_rule(event, self._backend)
                else:
                    self._state_store.save(event)
                    self._backend.add_rule(rule)
                    event["dropCounterAtInstall"] = self._backend.read_rule_counter(rule)
                    event["state"] = "armed"
                    self._state_store.save(event)
            except Exception:
                if isinstance(self._state_store, DeadlineStateStore):
                    raise
                try:
                    self._backend.remove_rule(rule)
                except Exception as rollback_error:
                    raise RuntimeError("deadline state write failed and rule rollback failed") from rollback_error
                raise
            self.active_event = event
            return dict(event)

    def collect_receiver_evidence(self, run_id: str) -> Mapping[str, Any] | None:
        self._require_run(run_id)
        with self._lock:
            event = self.active_event or self._last_event
            if event is None or event.get("runId") != run_id:
                raise RuntimeError("no active loss rule records this delivery")
            if self._receiver_source is None:
                raise RuntimeError("receiver evidence source is unavailable")
            if event is self.active_event:
                current = self._backend.read_rule_counter(list(event["rule"]))
                baseline = event.get("dropCounterAtInstall")
                if not isinstance(baseline, int) or current < baseline:
                    raise RuntimeError("gateway counter evidence is invalid")
                event["actualDropCount"] = current - baseline
            capture: Mapping[str, Any] | None = None
            # The active window has no receiver-directed after segment yet.
            # Once clear has completed, derive every accepted sequence from
            # the gateway's confirmed ChannelData send ledger.
            if event is self._last_event and isinstance(self._backend, GatewayCounterBackend):
                capture = self._backend.receiver_capture(event)
                event["receiverCapture"] = dict(capture)
            # A signed T3/T5 bridge is constructed only after the loss closes,
            # because its recovery proof includes the post-clear IDR and paint.
            # Plain staging files remain diagnostic-only and keep legacy gap
            # collection for debugging; neither path authorizes PASS here.
            if not getattr(self._receiver_source, "deferred", False):
                event["receiverSequenceGaps"] = sequence_gaps(self._receiver_source.sequences_for(self.manifest, event))
            if event is self.active_event:
                self._state_store.save(event)
            return capture

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
            # Persist only the just-cleared event metadata for the independent
            # gateway-state watchdog; media evidence stays in its own ledger.
            if isinstance(self._state_store, DeadlineStateStore):
                cleared_path = self._state_store.path.with_name("last-cleared.json")
                cleared_path.write_text(json.dumps(event, sort_keys=True), encoding="utf-8")
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
        if self._receiver_source is None or not getattr(self._receiver_source, "authenticated", False):
            return {"status": "BLOCKED", "reason": "authenticated T3/T5 receiver evidence bridge is unavailable", "event": dict(event)}
        try:
            event["receiverSequenceGaps"] = sequence_gaps(self._receiver_source.sequences_for(self.manifest, event))
        except Exception as exc:
            return {"status": "BLOCKED", "reason": f"authenticated receiver bridge rejected: {type(exc).__name__}", "event": dict(event)}
        self._receiver_evidence_authenticated = True
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
            "open": {"operation", "controlToken", "runId", "sessionId", "attemptId", "streamId", "generation"},
            "confirm": {"operation", "controlToken"},
            "apply": {"operation", "controlToken", "runId", "pattern", "durationMs"},
            "collect": {"operation", "controlToken"},
            "clear": {"operation", "controlToken"},
            "verify": {"operation", "controlToken", "runId"},
        }.get(request["operation"])
        if expected is None or set(request) != expected:
            if "actualDropCount" in request:
                raise ValueError("actualDropCount is not accepted from the control caller")
            raise ValueError("control request fields are invalid")
        for field in ("generation", "durationMs"):
            if field in request and (not isinstance(request[field], int) or isinstance(request[field], bool)):
                raise ValueError(f"control field {field} must be an integer")
        for field in ("controlToken", "runId", "sessionId", "attemptId", "streamId", "pattern"):
            if field in request and (not isinstance(request[field], str) or not request[field]):
                raise ValueError(f"control field {field} must be a non-empty string")


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
                    session = router.controller.open_session(request["runId"], request["sessionId"], request["generation"], attempt_id=request["attemptId"], stream_id=request["streamId"])
                    response = {"status": "OPEN", "generation": session.generation}
                elif operation == "verify":
                    response = router.controller.verify_final_evidence(request["runId"])
                elif session is None:
                    raise RuntimeError("open a control session before this command")
                elif operation == "confirm":
                    session.confirm_selected_leg()
                    response = {"status": "BASELINE_CONFIRMED"}
                elif operation == "apply":
                    response = session.apply_loss(request["runId"], request["pattern"], request["durationMs"])
                elif operation == "collect":
                    capture = session.collect_receiver_evidence()
                    response = {"status": "RECEIVER_EVIDENCE_COLLECTED", **({"receiverCapture": capture} if capture is not None else {})}
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


def _derived_ports(manifest: LossFixtureManifest) -> tuple[int, int, int]:
    value = int(hashlib.sha256(manifest.run_id.encode()).hexdigest()[:8], 16)
    offset = value % 9000
    return 20000 + offset, 40000 + offset, 50000 + offset


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
    # AF_UNIX has a short kernel path limit. Keep the host authority socket in
    # a run-unique /tmp directory and bind only that directory into Compose;
    # arbitrary caller-selected runtime directories may be much longer.
    runtime_key = hashlib.sha256(str(runtime_dir.resolve()).encode()).hexdigest()[:8]
    bridge_dir = Path(tempfile.gettempdir()) / f"wrd-turn-loss-{manifest.run_id[:8]}-{runtime_key}"
    if bridge_dir.exists() and any(bridge_dir.iterdir()):
        raise RuntimeBlocked("per-run Lab bridge directory is not empty")
    bridge_dir.mkdir(mode=0o700, exist_ok=True)
    bridge_dir.chmod(0o700)
    capture_dir, verify_dir = bridge_dir / "capture", bridge_dir / "verify"
    capture_dir.mkdir(mode=0o700)
    verify_dir.mkdir(mode=0o700)
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
    # The receiver may write a bridge here, but a file alone is never trusted:
    # serve has no Lab verifier and consequently keeps final evidence BLOCKED.
    bridge_path = runtime_dir / manifest.receiver_bridge_file
    bridge_path.write_text(json.dumps({"status": "NOT_RUN", "reason": "requires-live-lab-transcript-verifier"}), encoding="utf-8")
    bridge_path.chmod(0o600)
    (runtime_dir / "image-evidence.json").write_text(json.dumps({
        "turnRepoDigest": resolved_images.images["turn"],
        "controllerImageId": resolved_images.images["controller"],
        "controllerBaseRepoDigest": resolved_images.controller_base_digest,
        "controllerSourceSha256": resolved_images.controller_source_sha256,
        "dockerfileSha256": resolved_images.controller_dockerfile_sha256,
    }, sort_keys=True), encoding="utf-8")
    (runtime_dir / "image-evidence.json").chmod(0o600)
    shutil.copyfile(Path(__file__).with_name("turn-entrypoint.sh"), runtime_dir / "turn-entrypoint.sh")
    turn_port, control_port, authority_port = _derived_ports(manifest)
    (runtime_dir / "compose.generated.yaml").write_text(
        "services:\n"
        f"  turn:\n    image: {manifest.image_digests['turn']}\n    env_file:\n      - {runtime_dir / 'turn.env'}\n    volumes:\n      - {runtime_dir}:/runtime:ro\n    labels:\n      com.wrd.turn-loss-run-id: {manifest.run_id}\n"
        f"  turn-gateway:\n    image: {manifest.image_digests['controller']}\n    command: [\"python\", \"/fixture/turn_gateway.py\", \"--turn-host\", \"turn\", \"--turn-port\", \"3478\", \"--state\", \"/state/active-loss.json\", \"--relay-binding\", \"/runtime/actual-relay.json\", \"--counters\", \"/state/gateway-counters.json\", \"--credentials\", \"/runtime/credentials/turn.json\", \"--run-id\", \"{manifest.run_id}\", \"--authority-port\", \"19092\"]\n    ports:\n      - 127.0.0.1:{turn_port}:3478/udp\n      - 127.0.0.1:{authority_port}:19092/tcp\n      - 127.0.0.1:51000-51009:51000-51009/udp\n    volumes:\n      - {runtime_dir}:/runtime:ro\n    labels:\n      com.wrd.turn-loss-run-id: {manifest.run_id}\n"
        f"  loss-controller:\n    image: {manifest.image_digests['controller']}\n    command: [\"python\", \"/fixture/controller.py\", \"serve\", \"--manifest\", \"/runtime/manifest.json\", \"--credentials\", \"/runtime/credentials/turn.json\", \"--state\", \"/state/active-loss.json\", \"--relay-binding\", \"/runtime/actual-relay.json\", \"--gateway-counters\", \"/state/gateway-counters.json\", \"--gateway-authority-host\", \"turn-gateway\", \"--gateway-authority-port\", \"19092\"]\n    ports:\n      - 127.0.0.1:{control_port}:19091/tcp\n    volumes:\n      - {runtime_dir}:/runtime:ro\n      - {verify_dir}:/lab-bridge:ro\n    labels:\n      com.wrd.turn-loss-run-id: {manifest.run_id}\n"
        f"  loss-watchdog:\n    image: {manifest.image_digests['controller']}\n    command: [\"python\", \"/fixture/controller.py\", \"watchdog\", \"--manifest\", \"/runtime/manifest.json\", \"--credentials\", \"/runtime/credentials/turn.json\", \"--state\", \"/state/active-loss.json\", \"--gateway-counters\", \"/state/gateway-counters.json\", \"--gateway-authority-host\", \"turn-gateway\", \"--gateway-authority-port\", \"19092\"]\n    volumes:\n      - {runtime_dir}:/runtime:ro\n    labels:\n      com.wrd.turn-loss-run-id: {manifest.run_id}\n"
        f"  udp-echo-peer:\n    image: {manifest.image_digests['controller']}\n    labels:\n      com.wrd.turn-loss-run-id: {manifest.run_id}\n",
        encoding="utf-8",
    )
    project = f"turn-loss-{manifest.run_id[:8]}"
    return {"projectName": project, "networkName": f"{project}_turn-loss", "runtimeDir": str(runtime_dir), "composeOverride": str(runtime_dir / "compose.generated.yaml"), "turnEndpoint": f"127.0.0.1:{turn_port}", "controlEndpoint": f"127.0.0.1:{control_port}", "gatewayAuthorityEndpoint": f"127.0.0.1:{authority_port}", "bridgeSocket": str(verify_dir / "authority.sock"), "relayBinding": str(runtime_dir / "actual-relay.json")}


def verify_started_fixture(prepared: Mapping[str, str], *, run: Callable[[list[str]], tuple[int, str, str]]) -> dict[str, str]:
    """Verify Docker's post-start mappings instead of trusting planned ports."""
    required = {"projectName", "networkName", "composeOverride", "turnEndpoint", "controlEndpoint", "gatewayAuthorityEndpoint"}
    if set(prepared) < required:
        raise ValueError("prepared fixture layout is incomplete")
    for service, target, expected in (("turn-gateway", "3478/udp", prepared["turnEndpoint"]), ("turn-gateway", "19092/tcp", prepared["gatewayAuthorityEndpoint"]), ("loss-controller", "19091/tcp", prepared["controlEndpoint"])):
        container = f"{prepared['projectName']}-{service}-1"
        template = f'{{{{with index .NetworkSettings.Ports "{target}"}}}}{{{{(index . 0).HostIp}}}}:{{{{(index . 0).HostPort}}}}{{{{end}}}}'
        code, stdout, stderr = run(["docker", "inspect", "--format", template, container])
        if code != 0 or stdout.strip() != expected:
            raise RuntimeBlocked(f"fixture {target} mapping does not match prepared manifest layout: {stderr}")
    code, stdout, stderr = run(["docker", "network", "inspect", "--format", "{{.Name}}", prepared["networkName"]])
    if code != 0 or stdout.strip() != prepared["networkName"]:
        raise RuntimeBlocked(f"fixture network is missing or mismatched: {stderr}")
    return {"status": "READY", "turnEndpoint": prepared["turnEndpoint"], "controlEndpoint": prepared["controlEndpoint"], "gatewayAuthorityEndpoint": prepared["gatewayAuthorityEndpoint"], "networkName": prepared["networkName"]}


def cleanup_prepared_bridge(prepared: Mapping[str, str]) -> None:
    """Remove only known per-run authority artifacts after every lifecycle exit."""
    try:
        verify = Path(str(prepared["bridgeSocket"]))
    except (KeyError, TypeError):
        return
    try: verify.unlink(missing_ok=True)
    except OSError: pass
    try: verify.parent.rmdir()
    except OSError: pass
    root = verify.parent.parent
    if root.name.startswith("wrd-turn-loss-"):
        try: root.rmdir()
        except OSError: pass


def run_isolated_loss_lifecycle(*, prepared: Mapping[str, str], compose_file: Path, authority: LabReceiverBridgeAuthority | None,
                                authority_factory: Callable[[], LabReceiverBridgeAuthority] | None = None,
                                fixture_start: Callable[[], None] | None = None,
                                fixture_probe: Callable[[], None] | None = None,
                                run: Callable[[list[str]], tuple[int, str, str]], drive: Callable[[], Mapping[str, Any]]) -> dict[str, Any]:
    """Start the disposable TURN fixture before creating any Lab peer.

    ``authority_factory`` permits a fixture-first Lab to create its ephemeral
    transcript verifier only after Compose has proved the relay ready.
    """
    project, override = prepared["projectName"], prepared["composeOverride"]
    command = ["docker", "compose", "--project-name", project, "-f", str(compose_file), "-f", override]
    active_authority = authority
    try:
        code, _out, err = run([*command, "up", "-d"])
        if code: raise RuntimeBlocked(f"isolated compose up failed: {err}")
        verify_started_fixture(prepared, run=run)
        if fixture_probe is not None: fixture_probe()
        if fixture_start is not None: fixture_start()
        if active_authority is None:
            if authority_factory is None: raise RuntimeBlocked("fixture authority is unavailable")
            active_authority = authority_factory()
        if not active_authority._servers:
            active_authority.start()
        return dict(drive())
    finally:
        try: run([*command, "down", "-v"])
        finally:
            if active_authority is not None: active_authority.close()
            cleanup_prepared_bridge(prepared)


def _main() -> None:
    parser = argparse.ArgumentParser()
    subcommands = parser.add_subparsers(dest="command", required=True)
    for name in ("serve", "watchdog"):
        command = subcommands.add_parser(name)
        command.add_argument("--manifest", type=Path, required=True)
        command.add_argument("--credentials", type=Path, required=True)
        command.add_argument("--state", type=Path, required=True)
        command.add_argument("--gateway-counters", type=Path, required=True)
        command.add_argument("--gateway-authority-host", default="turn-gateway")
        command.add_argument("--gateway-authority-port", type=int, default=19092)
    subcommands.choices["serve"].add_argument("--receiver-bridge", type=Path, default=Path("/receiver/bridge.json"))
    subcommands.choices["serve"].add_argument("--relay-binding", type=Path, required=True)
    subcommands.choices["serve"].add_argument("--receiver-verifier-fd", type=int,
                                                help="inherited live-Lab verifier descriptor; never a path, argv secret, or environment variable")
    prepare = subcommands.add_parser("prepare")
    prepare.add_argument("--manifest", type=Path, required=True)
    prepare.add_argument("--runtime", type=Path, required=True)
    build_controller = subcommands.add_parser("build-controller")
    build_controller.add_argument("--base-image", required=True)
    authority = subcommands.add_parser("bridge-authority")
    authority.add_argument("--manifest", type=Path, required=True)
    authority.add_argument("--socket", type=Path, required=True)
    authority.add_argument("--verifier-fd", type=int, required=True)
    seal = subcommands.add_parser("seal-bridge")
    seal.add_argument("--manifest", type=Path, required=True)
    seal.add_argument("--socket", type=Path, required=True)
    seal.add_argument("--bridge", type=Path, required=True)
    seal.add_argument("--event", type=Path, required=True)
    seal.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    if arguments.command == "build-controller":
        try:
            print(json.dumps(DockerRuntimeProbe().build_local_controller_image(arguments.base_image), sort_keys=True))
        except RuntimeBlocked as exc:
            print(json.dumps({"status": "BLOCKED", "execution": "NOT_RUN", "reason": str(exc)}, sort_keys=True))
            raise SystemExit(2) from exc
        return
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
    if arguments.command == "bridge-authority":
        manifest = LossFixtureManifest.parse(json.loads(arguments.manifest.read_text(encoding="utf-8")))
        verifier = os.read(arguments.verifier_fd, 4096)
        if not verifier or len(verifier) >= 4096:
            raise RuntimeError("inherited live Lab verifier is unavailable or oversized")
        authority = LabReceiverBridgeAuthority(manifest, verifier=verifier, socket_path=arguments.socket)
        authority.start()
        try:
            while True: time.sleep(0.2)
        finally:
            authority.close()
    if arguments.command == "seal-bridge":
        manifest = LossFixtureManifest.parse(json.loads(arguments.manifest.read_text(encoding="utf-8")))
        bridge = json.loads(arguments.bridge.read_text(encoding="utf-8")); event = json.loads(arguments.event.read_text(encoding="utf-8"))
        request = {"operation": "seal", "runId": manifest.run_id, "bridge": bridge, "event": event}
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(2); client.connect(str(arguments.socket)); client.sendall((json.dumps(request, sort_keys=True) + "\n").encode())
            reply = json.loads(client.makefile("rb").readline(1_000_000))
        if not isinstance(reply, Mapping) or reply.get("status") != "SEALED":
            raise RuntimeError("Lab bridge refused receiver evidence")
        arguments.output.write_text(json.dumps({"sealId": reply["sealId"], "signature": reply["signature"]}, sort_keys=True), encoding="utf-8")
        arguments.output.chmod(0o600)
        print(json.dumps({"status": "SEALED"}, sort_keys=True)); return
    manifest = LossFixtureManifest.parse(json.loads(arguments.manifest.read_text(encoding="utf-8")))
    credentials = load_fixture_credentials(arguments.credentials, manifest.realm)
    store = DeadlineStateStore(arguments.state)
    backend: RuleBackend = GatewayCounterBackend(arguments.gateway_counters,
        authority_endpoint=(arguments.gateway_authority_host, arguments.gateway_authority_port),
        control_token=credentials["controlToken"], run_id=manifest.run_id, realm=manifest.realm)
    if arguments.command == "watchdog":
        while True:
            recover_deadline_state(store, backend)
            time.sleep(0.1)
    receiver_source: ReceiverEvidenceSource
    if arguments.receiver_verifier_fd is None:
        # The Compose mount is deliberately not authentication. A runtime that
        # cannot inherit the still-live Lab verifier stays BLOCKED at final
        # evidence verification.
        receiver_source = UnixSealedReceiverEvidenceSource(Path("/lab-bridge/authority.sock"), arguments.receiver_bridge)
    else:
        verifier = os.read(arguments.receiver_verifier_fd, 4096)
        if not verifier or len(verifier) >= 4096:
            raise RuntimeError("inherited live Lab verifier is unavailable or oversized")
        receiver_source = SignedT3T5ReceiverEvidenceSource.from_file(arguments.receiver_bridge, verifier=verifier)
    controller = LossController(manifest, backend=backend, state_store=store, receiver_source=receiver_source, relay_binding_path=arguments.relay_binding)
    # Docker forwards the loopback-published host port to the fixture bridge
    # address, not the container loopback. The Compose override restricts the
    # published side to 127.0.0.1; this listener still exists only in TURN's
    # dedicated, non-host namespace.
    server = LossControlServer({"host": "0.0.0.0", "port": manifest.control_endpoint["port"]}, ControlRequestRouter(controller, credentials["controlToken"]))
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

    def build_local_controller_image(self, base_image: str) -> dict[str, str]:
        """Build an untagged controller image from a resolved base RepoDigest.

        The returned OCI image ID is the only value Compose may execute.  The
        input can be a pull reference, but the Dockerfile receives the resolved
        RepoDigest, never that mutable reference.
        """
        if self.status()["status"] != "READY":
            raise RuntimeBlocked("Docker daemon is unavailable; controller build is BLOCKED")
        try:
            base_digest = self.image_digests([base_image])[base_image]
        except RuntimeError as exc:
            raise RuntimeBlocked(str(exc)) from exc
        fixture_dir = Path(__file__).parent
        controller_sha = hashlib.sha256((fixture_dir / "controller.py").read_bytes()).hexdigest()
        dockerfile_sha = hashlib.sha256((fixture_dir / "Dockerfile").read_bytes()).hexdigest()
        with tempfile.NamedTemporaryFile(prefix="turn-loss-controller-", suffix=".iid", delete=False) as handle:
            iid_path = Path(handle.name)
        try:
            command = [
                "docker", "build", "--iidfile", str(iid_path),
                "--build-arg", f"CONTROLLER_BASE_IMAGE={base_digest}",
                "--label", f"org.wrd.turn-loss.base-repodigest={base_digest}",
                "--label", f"org.wrd.turn-loss.controller-sha256={controller_sha}",
                "--label", f"org.wrd.turn-loss.dockerfile-sha256={dockerfile_sha}",
                "--file", str(fixture_dir / "Dockerfile"), str(fixture_dir),
            ]
            code, _stdout, stderr = self._run(command)
            if code != 0:
                raise RuntimeBlocked(f"local controller image build failed: {stderr}")
            image_id = iid_path.read_text(encoding="utf-8").strip()
        finally:
            iid_path.unlink(missing_ok=True)
        if not image_id.startswith("sha256:") or len(image_id) != 71 or any(char not in "0123456789abcdef" for char in image_id[7:]):
            raise RuntimeBlocked("Docker build did not return a local OCI image ID")
        return {
            "status": "READY", "controllerImageId": image_id,
            "baseRepoDigest": base_digest, "controllerSourceSha256": controller_sha,
            "dockerfileSha256": dockerfile_sha,
        }

    def resolve_fixture_images(self, images: Mapping[str, str]) -> ResolvedImageEvidence:
        if self.status()["status"] != "READY":
            raise RuntimeBlocked("Docker daemon is unavailable; fixture preparation is BLOCKED")
        if set(images) != {"turn", "controller"}:
            raise RuntimeBlocked("fixture image set is incomplete")
        turn_image = images["turn"]
        observed = self.image_digests([turn_image])
        if observed.get(turn_image) != turn_image:
            raise RuntimeBlocked("TURN image digest does not match manifest")
        controller_image = images["controller"]
        code, image_id, stderr = self._run(["docker", "image", "inspect", "--format", "{{.Id}}", controller_image])
        if code != 0 or image_id != controller_image:
            raise RuntimeBlocked(f"controller local OCI image ID does not match manifest: {stderr}")
        code, label_json, stderr = self._run(["docker", "image", "inspect", "--format", "{{json .Config.Labels}}", controller_image])
        if code != 0:
            raise RuntimeBlocked(f"controller image labels cannot be inspected: {stderr}")
        try:
            labels = json.loads(label_json)
        except json.JSONDecodeError as exc:
            raise RuntimeBlocked("controller image labels are malformed") from exc
        if not isinstance(labels, dict):
            raise RuntimeBlocked("controller image labels are unavailable")
        base_digest = labels.get("org.wrd.turn-loss.base-repodigest")
        source_digest = labels.get("org.wrd.turn-loss.controller-sha256")
        dockerfile_digest = labels.get("org.wrd.turn-loss.dockerfile-sha256")
        fixture_dir = Path(__file__).parent
        expected_source_digest = hashlib.sha256((fixture_dir / "controller.py").read_bytes()).hexdigest()
        expected_dockerfile_digest = hashlib.sha256((fixture_dir / "Dockerfile").read_bytes()).hexdigest()
        if (not isinstance(base_digest, str) or "@sha256:" not in base_digest
                or not all(isinstance(item, str) and len(item) == 64 and all(char in "0123456789abcdef" for char in item)
                           for item in (source_digest, dockerfile_digest))
                or source_digest != expected_source_digest or dockerfile_digest != expected_dockerfile_digest):
            raise RuntimeBlocked("controller build provenance labels are incomplete")
        code, _stdout, stderr = self._run(["docker", "run", "--rm", "--network", "none", "--entrypoint", "/bin/sh", controller_image, "-c", "test -f /fixture/controller.py && test -f /fixture/turn_gateway.py && test -f /fixture/turn_wire.py"])
        if code != 0:
            raise RuntimeBlocked(f"controller image lacks inline gateway sources: {stderr}")
        return ResolvedImageEvidence(images, controller_base_digest=base_digest, controller_source_sha256=source_digest,
                                     controller_dockerfile_sha256=dockerfile_digest, _seal=_RESOLVED_IMAGES_SEAL)


if __name__ == "__main__":
    _main()
