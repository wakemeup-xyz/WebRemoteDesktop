"""Contract tests for the isolated TURN lab boundary (written before implementation)."""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "python-host"), str(ROOT / "scripts")]

from h264_encoder_policy import H264SessionPolicyProvider, MediaSessionIntent  # noqa: E402
from turn_lab import (  # noqa: E402
    LabIdentity, LabRun, LabSignal, ProductionAdmissionClient, ProductionProof,
    validate_lab_origin,
)
from turn_lab_host import LabWebRemoteHost, VerifiedLabContext, _test_verified_context, verify_candidate_manifest  # noqa: E402


def _intent(generation=1, sequence=0):
    return MediaSessionIntent("lab-attempt", generation, "relay", 1280, 720, 20, 1_800_000, sequence)


def _context():
    return _test_verified_context(
        origin="http://127.0.0.1:40123", realm="lab-test-realm", proof_token="proof-token", epoch=4
    )


def _proof(epoch=7, viewers=0):
    return ProductionProof._sealed("production", "in-memory", epoch, viewers)


class _TestProductionClient(ProductionAdmissionClient):
    def __init__(self, proofs): self.proofs = list(proofs); self.current = None
    def admit(self): self.current = self.proofs.pop(0); return self.current
    def status(self):
        self.current = self.proofs.pop(0) if self.proofs else self.current
        return self.current.epoch, self.current.viewer_count


def _signal(_runtime, realm):
    return LabSignal("http://127.0.0.1:40123", realm, "lab-host-secret", "lab-viewer-password", "context-secret", lambda: None)


def _lab_proof(signal):
    return {"token": "lab-proof", "epoch": 4, "realm": signal.realm}


def _lab_context(*_args): return "test-context-credential"


def test_lab_host_requires_verified_context_and_rejects_viewer_selection():
    with pytest.raises(TypeError):
        LabWebRemoteHost()  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        LabWebRemoteHost(_context(), policy_selection="candidate")  # type: ignore[call-arg]


def test_lab_selection_uses_exact_experiment_policy_for_publish_refresh_and_rebuild():
    context = _context()
    received = []
    original = context.selection.resolver

    def recording_resolver(intent, policy_id):
        received.append(policy_id)
        return original(intent, policy_id)

    provider = H264SessionPolicyProvider(resolver=recording_resolver)
    provider.bind_attempt("lab-attempt")
    assert provider.publish(_intent(), context.selection.policy_id).accepted
    assert provider.refresh_profile(_intent(sequence=1), context.selection.policy_id).accepted
    rebuilt = H264SessionPolicyProvider(resolver=recording_resolver)
    rebuilt.bind_attempt("lab-attempt")
    assert rebuilt.publish(_intent(), context.selection.policy_id).accepted
    assert received == [context.selection.policy_id] * 3
    with pytest.raises(ValueError, match="experiment policy"):
        original(_intent(), "relay-legacy-v1")


def test_unknown_or_unqualified_candidate_manifest_fails_closed(tmp_path):
    artifact = tmp_path / "evidence.json"
    artifact.write_text('{"status":"NOT_RUN"}', encoding="utf-8")
    manifest = {
        "schemaVersion": 1,
        "mode": "candidate",
        "evidencePath": str(artifact),
        "evidenceSha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
        "offlineStatus": "NO_QUALIFIED_CANDIDATE",
    }
    with pytest.raises(ValueError, match="qualified"):
        verify_candidate_manifest(manifest)
    manifest["unexpected"] = True
    with pytest.raises(ValueError, match="unknown"):
        verify_candidate_manifest(manifest)
    manifest.pop("unexpected")
    manifest["evidenceSha256"] = "0" * 64
    with pytest.raises(ValueError, match="hash"):
        verify_candidate_manifest(manifest)


def test_lab_run_requires_production_proof_and_stops_on_epoch_or_human_viewer(tmp_path):
    no_probe = LabRun(runtime_root=tmp_path, signal_launcher=_signal)
    with pytest.raises(RuntimeError, match="production proof"):
        no_probe.start("legacy")
    proofs = [_proof(), _proof(epoch=8)]
    run = LabRun(runtime_root=tmp_path, signal_launcher=_signal, production_client=_TestProductionClient(proofs), lab_proof_issuer=_lab_proof, lab_context_issuer=_lab_context)
    identity = run.start("legacy")
    assert identity.realm.startswith("lab-") and identity.origin.startswith("http://127.0.0.1:")
    assert run.monitor() == "stopped:production-epoch-changed"
    assert run.closed


def test_lab_identity_never_accepts_production_realm_proof():
    identity = LabIdentity("run", "http://127.0.0.1:41000", 3, "lab-run", "lab-token")
    assert identity.accepts_proof({"realm": "lab-run", "epoch": 3, "token": "lab-token"})
    assert not identity.accepts_proof({"realm": "production", "epoch": 3, "token": "lab-token"})


def test_candidate_rejection_happens_before_any_lab_child_starts(tmp_path):
    started = []
    run = LabRun(runtime_root=tmp_path, signal_launcher=lambda *_args: (started.append(True), _signal(*_args))[1], production_client=_TestProductionClient([_proof()]), lab_proof_issuer=_lab_proof, lab_context_issuer=_lab_context)
    with pytest.raises(ValueError, match="candidate manifest"):
        run.start("candidate")
    assert started == []
    assert run.closed


def test_lab_run_finally_cleanup_removes_only_its_own_runtime(tmp_path):
    stopped = []
    run = LabRun(runtime_root=tmp_path, signal_launcher=lambda _runtime, realm: LabSignal("http://127.0.0.1:40123", realm, "secret", "viewer", "context", lambda: stopped.append(True)), production_client=_TestProductionClient([_proof()]), lab_proof_issuer=_lab_proof, lab_context_issuer=_lab_context)
    with run:
        run.start("legacy")
        runtime_dir = run._runtime_dir
        assert runtime_dir and runtime_dir.is_dir()
    assert stopped == [True]
    assert runtime_dir is not None and not runtime_dir.exists()


def test_lab_host_launcher_has_no_arbitrary_command_escape_hatch(tmp_path):
    run = LabRun(runtime_root=tmp_path, signal_launcher=_signal, production_client=_TestProductionClient([_proof()]), lab_proof_issuer=_lab_proof, lab_context_issuer=_lab_context)
    run.start("legacy")
    with pytest.raises(TypeError):
        run.start_host([sys.executable])  # type: ignore[call-arg]
    run.close()


@pytest.mark.parametrize("origin", [
    "http://127.0.0.1:8080/path", "http://127.0.0.1:5173", "http://127.0.0.1:80@attacker.invalid",
    "http://user@127.0.0.1:40123", "http://127.0.0.1:40123?x=1", "https://127.0.0.1:40123",
    "http://[::1]:8080", "http://[::1]:5173", "http://[::1]:40123/path",
])
def test_lab_origin_rejects_ambiguous_or_production_urls(origin):
    with pytest.raises(ValueError):
        validate_lab_origin(origin)


def test_public_lab_run_rejects_callable_and_manual_proof_sources(tmp_path):
    with pytest.raises(TypeError, match="ProductionAdmissionClient"):
        LabRun(runtime_root=tmp_path, production_client=lambda: _proof())  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="sealed"):
        ProductionProof(realm="production", token="forged", epoch=0, viewer_count=0)
