"""The sole constructor boundary for an isolated encoder-policy lab.

This module deliberately does not read environment policy settings.  A lab Host
can only be built from a context already verified by the lab driver.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable, Mapping

_CONTEXT_SEAL = object()

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "python-host") not in sys.path:
    sys.path.insert(0, str(ROOT / "python-host"))

# A process launched as the lab Host must be pointed at the random lab Signal
# before importing host.py, whose SERVER_URL constant is intentionally read at
# import time. Unit-test imports do not start a Host and do not opt into this
# entry guard.
def _validate_lab_origin(origin: str) -> str:
    try:
        parsed = urlsplit(origin)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("lab origin must be exact loopback") from exc
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1"}
        or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment
        or port is None or not 1 <= port <= 65535 or port in {8080, 5173}):
        raise ValueError("lab origin must be exact loopback")
    canonical = f"http://{'[::1]' if parsed.hostname == '::1' else '127.0.0.1'}:{port}"
    if origin != canonical:
        raise ValueError("lab origin must be exact loopback")
    return canonical


if os.environ.get("WRD_LAB_HOST_ENTRY") == "1":
    _entry_origin = os.environ.get("SERVER_URL", "")
    try: _validate_lab_origin(_entry_origin)
    except ValueError as exc: raise RuntimeError("lab Host requires a non-production loopback SERVER_URL before import") from exc

from h264_encoder_policy import H264SessionPolicy, MediaSessionIntent, PolicySelection, RELAY_LEGACY_V1, resolve_h264_policy
from host import WebRemoteHost


def _is_loopback_origin(origin: str) -> bool:
    try:
        _validate_lab_origin(origin)
        return True
    except ValueError:
        return False


def _experiment_resolver(policy_id: str, parameter_digest: str) -> Callable[[MediaSessionIntent, str], H264SessionPolicy]:
    def resolve(intent: MediaSessionIntent, received_policy_id: str) -> H264SessionPolicy:
        if received_policy_id != policy_id:
            raise ValueError("experiment policy resolver rejected a different policy id")
        if str(intent.path).lower() != "relay" or int(intent.width) <= 0 or int(intent.height) <= 0:
            raise ValueError("experiment policy requires a known relay presentation")
        # Legacy labs exercise the production-equivalent resolver while keeping
        # the selection label separate. Candidate contexts are not constructible
        # until their evidence is independently qualified.
        policy = resolve_h264_policy(intent, RELAY_LEGACY_V1)
        return replace(policy, policy_id=policy_id)
    return resolve


@dataclass(frozen=True, init=False)
class VerifiedLabContext:
    origin: str
    realm: str
    proof_token: str
    epoch: int
    selection: PolicySelection
    mode: str

    def __init__(self, origin: str, realm: str, proof_token: str, epoch: int, selection: PolicySelection, mode: str, *, _seal: object | None = None) -> None:
        if _seal is not _CONTEXT_SEAL:
            raise TypeError("VerifiedLabContext is sealed; Signal-issued context required")
        if not _is_loopback_origin(origin):
            raise ValueError("lab origin must be non-production loopback")
        if not realm.startswith("lab-") or not proof_token or epoch < 0:
            raise ValueError("verified lab context requires an isolated realm and proof")
        if not selection.policy_id.startswith("experiment/"):
            raise ValueError("lab policy selection must be an experiment policy")
        if mode not in {"legacy", "candidate"}:
            raise ValueError("invalid lab mode")
        object.__setattr__(self, "origin", origin); object.__setattr__(self, "realm", realm)
        object.__setattr__(self, "proof_token", proof_token); object.__setattr__(self, "epoch", epoch)
        object.__setattr__(self, "selection", selection); object.__setattr__(self, "mode", mode)

def _context_from_consumed_signal(*, origin: str, realm: str, proof_token: str, epoch: int) -> VerifiedLabContext:
    """Module-private conversion after the one-time Signal credential is consumed."""
    digest = hashlib.sha256(f"legacy:{origin}:{realm}".encode()).hexdigest()
    policy_id = f"experiment/{digest}"
    return VerifiedLabContext(origin, realm, proof_token, epoch, PolicySelection(policy_id, _experiment_resolver(policy_id, digest), digest), "legacy", _seal=_CONTEXT_SEAL)


def _test_verified_context(*, origin: str, realm: str, proof_token: str, epoch: int) -> VerifiedLabContext:
    """Private test seam; production entrypoints consume a Signal credential."""
    return _context_from_consumed_signal(origin=origin, realm=realm, proof_token=proof_token, epoch=epoch)


_CANDIDATE_FIELDS = frozenset({"schemaVersion", "mode", "evidencePath", "evidenceSha256", "offlineStatus"})


def verify_candidate_manifest(manifest: Mapping[str, Any]) -> Mapping[str, Any]:
    """Validate the small, data-only candidate admission envelope.

    The current T2 evidence advertises NO_QUALIFIED_CANDIDATE, so this always
    rejects it before any Host or signal process can be started.
    """
    if not isinstance(manifest, Mapping):
        raise ValueError("candidate manifest must be an object")
    unknown = set(manifest) - _CANDIDATE_FIELDS
    missing = _CANDIDATE_FIELDS - set(manifest)
    if unknown:
        raise ValueError(f"candidate manifest has unknown fields: {sorted(unknown)}")
    if missing:
        raise ValueError(f"candidate manifest missing fields: {sorted(missing)}")
    if manifest.get("schemaVersion") != 1 or manifest.get("mode") != "candidate":
        raise ValueError("candidate manifest schema is invalid")
    evidence = Path(str(manifest["evidencePath"])).resolve()
    if not evidence.is_file():
        raise ValueError("candidate evidence is missing")
    actual = hashlib.sha256(evidence.read_bytes()).hexdigest()
    if actual != manifest.get("evidenceSha256"):
        raise ValueError("candidate evidence hash mismatch")
    # T2's bound evidence has NO_QUALIFIED_CANDIDATE. There is intentionally no
    # generic "status=PASS" admission path: accepting a fresh hand-written
    # file before a dedicated per-frame recomputation implementation exists
    # would promote an untrusted candidate. A future qualified format must add
    # source hashes and the full T2 gate recomputation in this function.
    raise ValueError("candidate evidence is not qualified for runtime admission")


class LabWebRemoteHost(WebRemoteHost):
    def __init__(self, verified_context: VerifiedLabContext) -> None:
        if not isinstance(verified_context, VerifiedLabContext):
            raise TypeError("LabWebRemoteHost requires VerifiedLabContext")
        self._verified_lab_context = verified_context
        super().__init__()

    def _create_policy_selection(self) -> PolicySelection:
        context = getattr(self, "_verified_lab_context", None)
        if not isinstance(context, VerifiedLabContext):
            raise TypeError("LabWebRemoteHost requires VerifiedLabContext")
        return context.selection


def _context_from_verified_binding(raw: Mapping[str, Any], issued: Mapping[str, Any]) -> VerifiedLabContext:
    """Validate every raw Host binding after Signal consumed its credential."""
    required = {"origin", "realm", "proofToken", "epoch", "mode", "runId", "policyId", "credential"}
    if not isinstance(raw, Mapping) or set(raw) != required:
        raise ValueError("lab Host context has missing or unknown fields")
    origin = _validate_lab_origin(str(raw["origin"]))
    for field in ("origin", "realm", "proofToken", "epoch", "mode", "runId", "policyId"):
        if issued.get(field) != raw.get(field):
            raise ValueError("Signal-issued lab context binding mismatch")
    if raw.get("mode") != "legacy":
        raise ValueError("candidate lab Host is unavailable without qualified T2 evidence")
    context = _context_from_consumed_signal(origin=origin, realm=str(raw["realm"]), proof_token=str(raw["proofToken"]), epoch=int(raw["epoch"]))
    if context.selection.policy_id != raw["policyId"]:
        raise ValueError("Signal-issued lab policy binding mismatch")
    return context


def main() -> int:
    try:
        raw = json.loads(os.environ["WRD_LAB_CONTEXT"])
        required = {"origin", "realm", "proofToken", "epoch", "mode", "runId", "policyId", "credential"}
        if not isinstance(raw, dict) or set(raw) != required:
            raise ValueError("lab Host context has missing or unknown fields")
        origin = _validate_lab_origin(str(raw["origin"]))
        consume = Request(
            f"{origin}/api/lab-context/consume", method="POST",
            data=json.dumps({"credential": raw["credential"]}).encode(), headers={"Content-Type": "application/json"},
        )
        with urlopen(consume, timeout=5) as response:
            issued = json.loads(response.read().decode())["context"]
        context = _context_from_verified_binding(raw, issued)
        import asyncio
        asyncio.run(LabWebRemoteHost(context).run())
    except Exception as exc:
        print(f"lab Host refused: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
_CONTEXT_SEAL = object()
