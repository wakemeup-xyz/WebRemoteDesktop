"""Contract tests for the isolated TURN lab boundary."""
from __future__ import annotations

import hashlib
import json
import os
import asyncio
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "python-host"), str(ROOT / "scripts")]
from h264_encoder_policy import H264SessionPolicyProvider, MediaSessionIntent  # noqa: E402
from capture_experiment import CaptureExperiment  # noqa: E402
import host as host_module  # noqa: E402
from turn_lab import (LabIdentity, LabRun, LabTurnBootstrap, ProductionAdmissionClient, ProductionProof, _make_test_lab_run, _make_test_production_client, validate_lab_origin)  # noqa: E402
import turn_lab as turn_lab_module  # noqa: E402
import turn_lab_host as turn_lab_host_module  # noqa: E402
from turn_lab_host import LabWebRemoteHost, VerifiedLabContext, _context_from_verified_binding, _test_verified_context, verify_candidate_manifest  # noqa: E402


class _ProofFixture:
    """Real loopback HTTP fixture; never points at the production port."""
    def __init__(self):
        self.epoch, self.viewers, self.proofs, self.fail_status, self.leases = 0, 0, 0, False, {}
        self.turn_bootstrap_enabled = True
        self.turn_host_ready = True
        self.turn_urls = ["turn:relay.fixture.invalid:3478?transport=udp"]
        self.turn_username = "fixture-turn-user"
        self.turn_credential = "fixture-turn-credential"
        self.turn_server_id = "fixture-turn"
        self.turn_fingerprint = "fixture-turn-fingerprint"
        self.omit_admission_realm = False
        self.legacy_proof_lease_routes = False
        self.fail_proof_status_once = False
        self.block_next_status = False
        self.status_block_entered = threading.Event()
        self.status_block_release = threading.Event()
        self.block_next_admission = False
        self.admission_block_entered = threading.Event()
        self.admission_block_release = threading.Event()
        self._fixture_lock = threading.Lock()
        fixture = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def _json(self, status, body):
                self.send_response(status); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(json.dumps(body).encode())
            def do_GET(self):
                if self.path == "/api/status":
                    if fixture.fail_status: return self._json(503, {})
                    with fixture._fixture_lock:
                        block = fixture.block_next_status
                        fixture.block_next_status = False
                    if block:
                        fixture.status_block_entered.set()
                        fixture.status_block_release.wait(3)
                    return self._json(200, {"viewerEpoch": fixture.epoch, "viewerCount": fixture.viewers})
                if self.path == "/api/webrtc-config" and self.headers.get("Authorization") == "Bearer fixture-token":
                    if not fixture.turn_bootstrap_enabled:
                        return self._json(200, {"turnConfigured": False, "hostTurnReady": False})
                    host_id = fixture.turn_server_id if fixture.turn_host_ready else "other-turn"
                    host_fingerprint = fixture.turn_fingerprint if fixture.turn_host_ready else "other-fingerprint"
                    return self._json(200, {
                        "turnConfigured": True,
                        "turnUrls": fixture.turn_urls,
                        "turnFingerprint": fixture.turn_fingerprint,
                        "selectedTurnServerId": fixture.turn_server_id,
                        "hostTurnReady": fixture.turn_host_ready,
                        "hostTurnServerId": host_id,
                        "hostTurnFingerprint": host_fingerprint,
                        "iceServers": [{"urls": ["stun:fixture.invalid:3478"]}, {"urls": fixture.turn_urls, "username": fixture.turn_username, "credential": fixture.turn_credential}],
                    })
                return self._json(404, {})
            def do_POST(self):
                if self.path == "/api/proof-admission" and self.headers.get("Authorization") == "Bearer fixture-token":
                    with fixture._fixture_lock:
                        block_admission = fixture.block_next_admission
                        fixture.block_next_admission = False
                    if block_admission:
                        fixture.admission_block_entered.set()
                        fixture.admission_block_release.wait(3)
                    fixture.proofs += 1
                    token = f"proof-token-{fixture.proofs}-long"
                    fixture.leases[token] = {"token": token, "epoch": fixture.epoch, "realm": "production"}
                    admission = dict(fixture.leases[token])
                    if fixture.omit_admission_realm:
                        admission.pop("realm")
                    return self._json(201, {"admission": admission})
                if self.path in {"/api/proof-admission/status", "/api/proof-admission/release"} and self.headers.get("Authorization") == "Bearer fixture-token":
                    if fixture.legacy_proof_lease_routes:
                        return self._json(404, {})
                    if self.path.endswith("status") and fixture.fail_proof_status_once:
                        fixture.fail_proof_status_once = False
                        return self._json(503, {})
                    length = int(self.headers.get("content-length", "0")); body = json.loads(self.rfile.read(length))
                    active = fixture.leases.get(body.get("token")) == body
                    if self.path.endswith("release") and active: fixture.leases.pop(body["token"])
                    return self._json(200, {"active" if self.path.endswith("status") else "released": active})
                return self._json(401, {})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"
    def close(self): self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=1)


@pytest.fixture
def proof_fixture():
    fixture = _ProofFixture()
    try: yield fixture
    finally: fixture.close()


def _run(tmp_path, fixture):
    client = _make_test_production_client(origin=fixture.origin, viewer_token="fixture-token")
    return _make_test_lab_run(runtime_root=tmp_path, production_client=client)


def _intent(generation=1, sequence=0): return MediaSessionIntent("lab-attempt", generation, "relay", 1280, 720, 20, 1_800_000, sequence)
def _context(): return _test_verified_context(origin="http://127.0.0.1:40123", realm="lab-test-realm", proof_token="proof-token", epoch=4)
def _wait(condition):
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        if condition(): return
        time.sleep(.05)
    raise AssertionError("condition did not become true")


def test_lab_host_requires_verified_context_and_rejects_viewer_selection():
    with pytest.raises(TypeError): LabWebRemoteHost()  # type: ignore[call-arg]
    with pytest.raises(TypeError): LabWebRemoteHost(_context(), policy_selection="candidate")  # type: ignore[call-arg]
    with pytest.raises(TypeError): VerifiedLabContext("http://127.0.0.1:40123", "lab-r", "x", 0, _context().selection, "legacy", "run", CaptureExperiment(2, 0))


def test_lab_capture_factory_and_opencv_derive_only_from_the_sealed_context(monkeypatch):
    context = _test_verified_context(origin="http://127.0.0.1:40123", realm="lab-test-realm", proof_token="proof-token", epoch=4,
                                     capture_experiment=CaptureExperiment(1, 1))
    created, calls = {}, []
    class Track:
        def __init__(self, **kwargs): created.update(kwargs)
    class Cv2:
        @staticmethod
        def setNumThreads(value): calls.append(value)
    monkeypatch.setattr(turn_lab_host_module, "ScreenCaptureTrack", Track)
    monkeypatch.setattr(host_module, "HAS_CV2", True)
    monkeypatch.setattr(host_module, "cv2", Cv2)
    lab_host = object.__new__(LabWebRemoteHost)
    lab_host._verified_lab_context = context
    lab_host.media_profile = {"target_fps": 20, "width": 1280, "height": 720}
    lab_host._frame_trace_context = object()
    lab_host._create_screen_track()
    turn_lab_host_module.configure_lab_opencv_threads_before_host_start(context)
    assert created["capture_strategy"] is context.capture_experiment
    assert calls == [1]


def test_strict_production_client_accepts_the_legacy_token_epoch_admission_shape_as_production(monkeypatch, proof_fixture):
    proof_fixture.omit_admission_realm = True
    client = _make_test_production_client(origin=proof_fixture.origin, viewer_token="fixture-token")
    # The test-only client origin is deliberately not production, so this
    # compatibility rule must remain unavailable outside the exact origin.
    with pytest.raises(RuntimeError, match="production proof admission"):
        client.admit()

    monkeypatch.setattr(turn_lab_module, "_PRODUCTION_ORIGIN", proof_fixture.origin)
    strict = ProductionAdmissionClient(viewer_token="fixture-token", origin=proof_fixture.origin)
    admitted = strict.admit()
    assert admitted.realm == "production"
    assert admitted.epoch == proof_fixture.epoch


def test_strict_production_client_uses_a_fresh_zero_viewer_snapshot_when_legacy_lease_status_route_is_absent(monkeypatch, proof_fixture):
    proof_fixture.omit_admission_realm = True
    proof_fixture.legacy_proof_lease_routes = True
    monkeypatch.setattr(turn_lab_module, "_PRODUCTION_ORIGIN", proof_fixture.origin)
    client = ProductionAdmissionClient(viewer_token="fixture-token", origin=proof_fixture.origin)
    proof = client.admit()
    assert client.proof_active(proof) is True
    proof_fixture.epoch += 1
    assert client.proof_active(proof) is False
    proof_fixture.epoch -= 1
    assert client.release(proof) is True


def test_authenticated_turn_bootstrap_keeps_the_selected_host_and_viewer_path_together(proof_fixture):
    client = _make_test_production_client(origin=proof_fixture.origin, viewer_token="fixture-token")
    proof = client.admit()
    bootstrap = client.lab_turn_bootstrap(proof)
    assert bootstrap.selected_turn_server_id == proof_fixture.turn_server_id
    assert bootstrap.turn_urls == tuple(proof_fixture.turn_urls)
    assert bootstrap.signal_payload()["turnCredential"] == proof_fixture.turn_credential
    assert client.release(proof)


@pytest.mark.parametrize("change", ["not-configured", "host-mismatch"])
def test_turn_bootstrap_fails_closed_when_the_production_path_is_missing_or_not_shared(proof_fixture, change):
    client = _make_test_production_client(origin=proof_fixture.origin, viewer_token="fixture-token")
    proof = client.admit()
    if change == "not-configured":
        proof_fixture.turn_bootstrap_enabled = False
    else:
        proof_fixture.turn_host_ready = False
    with pytest.raises(RuntimeError, match="TURN"):
        client.lab_turn_bootstrap(proof)
    assert client.release(proof)


def test_lab_start_does_not_spawn_signal_when_authenticated_turn_bootstrap_is_unavailable(tmp_path, proof_fixture, monkeypatch):
    proof_fixture.turn_bootstrap_enabled = False
    run = _run(tmp_path, proof_fixture)
    calls = []
    monkeypatch.setattr(turn_lab_module.subprocess, "Popen", lambda *args, **kwargs: calls.append((args, kwargs)))
    with pytest.raises(RuntimeError, match="TURN"):
        run.start("legacy")
    assert not calls and run.closed and not proof_fixture.leases


def test_turn_credential_is_pipe_only_not_argv_environment_or_runtime_artifacts(tmp_path, proof_fixture, monkeypatch):
    run = _run(tmp_path, proof_fixture)
    captured = []
    original = turn_lab_module.subprocess.Popen

    def inspect_spawn(*args, **kwargs):
        captured.append((args, kwargs))
        return original(*args, **kwargs)

    monkeypatch.setattr(turn_lab_module.subprocess, "Popen", inspect_spawn)
    try:
        run.start("legacy")
        assert len(captured) == 1
        args, kwargs = captured[0]
        assert proof_fixture.turn_credential not in repr(args)
        assert proof_fixture.turn_credential not in repr(kwargs.get("env", {}))
        assert kwargs["stdin"] is turn_lab_module.subprocess.PIPE
        runtime_dir = run.runtime_dir()
        assert all(proof_fixture.turn_credential.encode() not in path.read_bytes() for path in runtime_dir.rglob("*") if path.is_file())
        assert not hasattr(run, "_turn_bootstrap")
    finally:
        run.close()


def test_lab_host_installs_the_guard_only_after_the_real_fixture_lease_arms_it(monkeypatch):
    class Adapter:
        async def apply_keyboard(self, *_args, **_kwargs): return {"status": "applied"}
        async def handle_input(self, *_args, **_kwargs): return {"status": "applied"}
    monkeypatch.setattr(turn_lab_host_module.WebRemoteHost, "__init__", lambda self: setattr(self, "input_adapter", Adapter()))
    host = LabWebRemoteHost(_context())
    host._local_fixture_probe = lambda **_kwargs: {"leaseId": "lease-1", "fixtureId": "fixture-1",
                                                   "isolated": True, "foreground": True, "fixtureWindow": True}
    assert host.controlled_input_guard is None
    assert type(host.input_adapter).__name__ == "Adapter"
    host.arm_controlled_input(
        lease_id="lease-1", fixture_id="fixture-1",
        fixture_proof=lambda: {"leaseId": "lease-1", "proofToken": _context().proof_token,
                               "fixtureId": "fixture-1", "isolated": True,
                               "foreground": True, "fixtureWindow": True},
    )
    assert host.controlled_input_guard.installed
    assert type(host.input_adapter).__name__ == "GuardedLabInputAdapter"
    host.bind_controlled_input({"inputId": "input-1", "leaseId": "lease-1",
                                "proofToken": _context().proof_token, "fixtureId": "fixture-1"})
    assert host.controlled_input_guard.is_input_bound("input-1")


def test_lab_host_control_plane_arm_installs_the_real_adapter_guard_and_reports_the_applied_turn_digest(monkeypatch):
    class Adapter:
        async def apply_keyboard(self, *_args, **_kwargs): return {"status": "applied"}
        async def handle_input(self, *_args, **_kwargs): return {"status": "applied"}
    class Sio:
        def __init__(self): self.events = []
        async def emit(self, name, payload): self.events.append((name, payload))
    monkeypatch.setattr(turn_lab_host_module.WebRemoteHost, "__init__", lambda self: setattr(self, "input_adapter", Adapter()))
    context = _context()
    host = LabWebRemoteHost(context)
    host.sio = Sio()
    digest = turn_lab_host_module._turn_applied_digest(
        selected_id="fixture-turn", fingerprint="fixture-fp",
        urls=["turn:relay.fixture.invalid:3478"], username="fixture-user",
    )
    host._session_turn_override = {"selectedTurnServerId": "fixture-turn", "turnFingerprint": "fixture-fp",
                                   "urls": ["turn:relay.fixture.invalid:3478"], "username": "fixture-user",
                                   "credential": "not-persisted", "appliedDigest": digest}
    host._local_fixture_probe = lambda **_kwargs: {"leaseId": "lease-1", "fixtureId": "fixture-1",
                                                   "isolated": True, "foreground": True, "fixtureWindow": True}
    asyncio.run(host.on_lab_controlled_input_arm({
        "armId": "arm-1", "realm": context.realm, "runId": context.run_id, "epoch": context.epoch,
        "leaseId": "lease-1", "leaseEpoch": 2, "fixtureId": "fixture-1",
    }))
    assert host.controlled_input_guard is not None and host.controlled_input_guard.installed
    assert host.sio.events == [("lab-controlled-input-arm-ack", {"armId": "arm-1", "status": "armed", "turnAppliedDigest": digest})]


def test_lab_host_rejects_runner_or_viewer_claimed_fixture_flags_without_its_private_native_probe(monkeypatch):
    class Adapter:
        async def apply_keyboard(self, *_args, **_kwargs): return {"status": "applied"}
        async def handle_input(self, *_args, **_kwargs): return {"status": "applied"}
    class Sio:
        def __init__(self): self.events = []
        async def emit(self, name, payload): self.events.append((name, payload))
    monkeypatch.setattr(turn_lab_host_module.WebRemoteHost, "__init__", lambda self: setattr(self, "input_adapter", Adapter()))
    context = _context(); host = LabWebRemoteHost(context); host.sio = Sio()
    asyncio.run(host.on_lab_controlled_input_arm({
        "armId": "arm-fake", "realm": context.realm, "runId": context.run_id, "epoch": context.epoch,
        "leaseId": "lease-1", "leaseEpoch": 2, "fixtureId": "fixture-1",
    }))
    assert host.controlled_input_guard is None
    assert host.sio.events == [("lab-controlled-input-arm-ack", {"armId": "arm-fake", "status": "rejected"})]


def test_lab_selection_uses_exact_experiment_policy_for_publish_refresh_and_rebuild():
    context, received = _context(), []
    original = context.selection.resolver
    def recording(intent, policy_id): received.append(policy_id); return original(intent, policy_id)
    provider = H264SessionPolicyProvider(resolver=recording); provider.bind_attempt("lab-attempt")
    assert provider.publish(_intent(), context.selection.policy_id).accepted
    assert provider.refresh_profile(_intent(sequence=1), context.selection.policy_id).accepted
    rebuilt = H264SessionPolicyProvider(resolver=recording); rebuilt.bind_attempt("lab-attempt")
    assert rebuilt.publish(_intent(), context.selection.policy_id).accepted
    assert received == [context.selection.policy_id] * 3
    with pytest.raises(ValueError): original(_intent(), "relay-legacy-v1")


def test_unknown_or_unqualified_candidate_manifest_fails_closed(tmp_path):
    artifact = tmp_path / "evidence.json"; artifact.write_text('{"status":"NOT_RUN"}', encoding="utf-8")
    manifest = {"schemaVersion": 1, "mode": "candidate", "evidencePath": str(artifact), "evidenceSha256": hashlib.sha256(artifact.read_bytes()).hexdigest(), "offlineStatus": "NO_QUALIFIED_CANDIDATE"}
    with pytest.raises(ValueError, match="qualified"): verify_candidate_manifest(manifest)
    manifest["unexpected"] = True
    with pytest.raises(ValueError, match="unknown"): verify_candidate_manifest(manifest)


def test_public_lab_paths_cannot_inject_or_forge_proofs(tmp_path):
    with pytest.raises(TypeError): LabRun(runtime_root=tmp_path, signal_launcher=lambda: None)  # type: ignore[call-arg]
    with pytest.raises(TypeError): LabRun(runtime_root=tmp_path, production_client=lambda: None)  # type: ignore[call-arg]
    with pytest.raises(TypeError, match="sealed"): ProductionProof("production", "forged", 0, 0)
    with pytest.raises(TypeError, match="final"):
        class Forged(ProductionAdmissionClient): pass
    with pytest.raises(ValueError): ProductionAdmissionClient(viewer_token="x", origin="http://127.0.0.1:40123")


def test_host_context_binding_rejects_token_realm_epoch_policy_mode_unknown_and_replay_shape():
    context = _context()
    raw = {"origin": context.origin, "realm": context.realm, "proofToken": context.proof_token, "epoch": context.epoch, "mode": "legacy", "runId": "run-1", "policyId": context.selection.policy_id, "captureExperiment": context.capture_experiment.to_binding(), "credential": "one-time"}
    issued = {key: value for key, value in raw.items() if key != "credential"}
    assert _context_from_verified_binding(raw, issued).selection.policy_id == context.selection.policy_id
    for field, value in [("proofToken", "swapped"), ("realm", "lab-other"), ("epoch", 5), ("policyId", "experiment/other"), ("mode", "candidate")]:
        modified = dict(raw); modified[field] = value
        with pytest.raises(ValueError): _context_from_verified_binding(modified, issued)
    with pytest.raises(ValueError): _context_from_verified_binding({**raw, "unknown": True}, issued)
    with pytest.raises(ValueError): _context_from_verified_binding({key: value for key, value in raw.items() if key != "credential"}, issued)


@pytest.mark.parametrize("origin", [
    "http://127.0.0.1:8080/path", "http://127.0.0.1:5173", "http://127.0.0.1:80@attacker.invalid", "http://user@127.0.0.1:40123", "http://127.0.0.1:40123?x=1", "https://127.0.0.1:40123", "http://[::1]:8080", "http://[::1]:5173", "http://[::1]:40123/path", "http://127.0.0.1:40123/",
])
def test_lab_origin_rejects_ambiguous_or_production_urls(origin):
    with pytest.raises(ValueError): validate_lab_origin(origin)


def test_real_loopback_proof_fixture_admits_once_and_watchdog_stops_on_epoch(tmp_path, proof_fixture):
    run = _run(tmp_path, proof_fixture)
    identity = run.start("legacy")
    assert identity.realm.startswith("lab-") and proof_fixture.proofs == 1
    proof_fixture.epoch = 1
    _wait(lambda: run.closed)
    assert run.monitor() == "stopped:production-epoch-changed"


def test_lab_run_refuses_to_bind_controlled_input_before_a_real_lab_viewer_exists(tmp_path, proof_fixture):
    run = _run(tmp_path, proof_fixture)
    run.start("legacy")
    with pytest.raises(RuntimeError, match="refused"):
        run.bind_controlled_input(input_id="input-1", lease_id="lease-1", lease_epoch=1, fixture_id="fixture-1",
                                  action={"type": "mouse", "action": "down", "payload": {}})
    run.close()


def test_production_proof_lease_is_readable_released_and_loss_stops_watchdog(tmp_path, proof_fixture):
    client = _make_test_production_client(origin=proof_fixture.origin, viewer_token="fixture-token")
    proof = client.admit(); assert client.proof_active(proof)
    assert client.release(proof) and not client.proof_active(proof) and not client.release(proof)
    run = _run(tmp_path, proof_fixture); run.start("legacy")
    proof_fixture.leases.clear()
    _wait(lambda: run.closed); assert run.monitor() == "stopped:production-proof-lost"


def test_admission_rejects_second_active_proof_without_leaking_first(proof_fixture):
    client = _make_test_production_client(origin=proof_fixture.origin, viewer_token="fixture-token")
    first = client.admit()
    with pytest.raises(RuntimeError, match="active proof"): client.admit()
    assert client.proof_active(first) and len(proof_fixture.leases) == 1
    assert client.release(first) and not proof_fixture.leases


def test_transient_proof_status_failure_keeps_the_only_tracked_lease(proof_fixture):
    client = _make_test_production_client(origin=proof_fixture.origin, viewer_token="fixture-token")
    first = client.admit()
    proof_fixture.fail_proof_status_once = True
    with pytest.raises(RuntimeError, match="proof status"):
        client.admit()
    assert client.proof_active(first)
    assert proof_fixture.proofs == 1 and len(proof_fixture.leases) == 1


def test_concurrent_admit_has_exactly_one_success_and_one_active_lease(proof_fixture):
    client = _make_test_production_client(origin=proof_fixture.origin, viewer_token="fixture-token")
    proof_fixture.block_next_status = True
    outcomes = []

    def admit():
        try:
            outcomes.append(("proof", client.admit()))
        except RuntimeError as exc:
            outcomes.append(("error", str(exc)))

    first = threading.Thread(target=admit); second = threading.Thread(target=admit)
    first.start(); _wait(proof_fixture.status_block_entered.is_set); second.start()
    proof_fixture.status_block_release.set()
    first.join(timeout=3); second.join(timeout=3)
    assert not first.is_alive() and not second.is_alive()
    assert [kind for kind, _ in outcomes].count("proof") == 1
    assert [kind for kind, _ in outcomes].count("error") == 1
    assert proof_fixture.proofs == 1 and len(proof_fixture.leases) == 1


def test_close_cancels_a_blocked_admission_before_it_can_publish_a_run(tmp_path, proof_fixture):
    run = _run(tmp_path, proof_fixture)
    proof_fixture.block_next_admission = True
    start_errors = []

    def start():
        try: run.start("legacy")
        except RuntimeError as exc: start_errors.append(str(exc))

    starter = threading.Thread(target=start); starter.start()
    _wait(proof_fixture.admission_block_entered.is_set)
    closer = threading.Thread(target=run.close); closer.start()
    time.sleep(.05)
    assert closer.is_alive()
    proof_fixture.admission_block_release.set()
    starter.join(timeout=3); closer.join(timeout=3)
    assert not starter.is_alive() and not closer.is_alive()
    assert start_errors == ["lab run was closed or replaced during production admission"]
    assert run.closed and run.monitor() == "closed"
    assert not proof_fixture.leases and not run._children
    assert not list(tmp_path.glob("wrd-turn-lab-*"))


def test_start_filesystem_failure_releases_owned_proof(tmp_path, proof_fixture, monkeypatch):
    run = _run(tmp_path / "blocked-parent", proof_fixture)
    original = Path.mkdir
    def fail_runtime_parent(path, *args, **kwargs):
        if path == run._runtime_root: raise OSError("fixture mkdir failure")
        return original(path, *args, **kwargs)
    monkeypatch.setattr(turn_lab_module.Path, "mkdir", fail_runtime_parent)
    with pytest.raises(OSError, match="mkdir failure"): run.start("legacy")
    assert run.closed and not proof_fixture.leases and not run._children


def test_start_signal_handshake_failure_releases_owned_proof_and_runtime(tmp_path, proof_fixture, monkeypatch):
    run = _run(tmp_path, proof_fixture)
    monkeypatch.setattr(run, "_spawn_signal", lambda *_args: (_ for _ in ()).throw(RuntimeError("fixture signal failure")))
    with pytest.raises(RuntimeError, match="signal failure"): run.start("legacy")
    assert run.closed and not proof_fixture.leases and not run._children
    assert not list(tmp_path.glob("wrd-turn-lab-*"))


@pytest.mark.parametrize("change", ["viewer", "epoch", "proof"])
def test_start_rechecks_production_before_announcing_running(tmp_path, proof_fixture, monkeypatch, change):
    run = _run(tmp_path, proof_fixture)
    original = run._issue_host_context

    def mutate_after_context(*args):
        result = original(*args)
        if change == "viewer": proof_fixture.viewers = 1
        elif change == "epoch": proof_fixture.epoch += 1
        else: proof_fixture.leases.clear()
        return result

    monkeypatch.setattr(run, "_issue_host_context", mutate_after_context)
    with pytest.raises(RuntimeError, match="production"):
        run.start("legacy")
    assert run.closed and run.monitor() == "closed" and not proof_fixture.leases


@pytest.mark.parametrize("change", ["viewer", "epoch", "proof"])
def test_start_host_rechecks_production_before_spawning(tmp_path, proof_fixture, monkeypatch, change):
    run = _run(tmp_path, proof_fixture); run.start("legacy")
    if change == "viewer": proof_fixture.viewers = 1
    elif change == "epoch": proof_fixture.epoch += 1
    else: proof_fixture.leases.clear()
    calls = []
    original = turn_lab_module.subprocess.Popen

    def fail_if_called(*args, **kwargs):
        calls.append(args)
        return original(*args, **kwargs)

    monkeypatch.setattr(turn_lab_module.subprocess, "Popen", fail_if_called)
    with pytest.raises(RuntimeError, match="production"):
        run.start_host()
    assert not calls and run.closed and not proof_fixture.leases


def test_human_arrival_after_host_preflight_is_reaped_by_watchdog(tmp_path, proof_fixture, monkeypatch):
    watchdog_ready, release_watchdog = threading.Event(), threading.Event()
    original_watchdog = LabRun._watchdog

    def delayed_watchdog(*args):
        watchdog_ready.set()
        assert release_watchdog.wait(3)
        return original_watchdog(*args)

    monkeypatch.setattr(LabRun, "_watchdog", delayed_watchdog)
    run = _run(tmp_path, proof_fixture); run.start("legacy")
    _wait(watchdog_ready.is_set)
    preflight_done, allow_spawn, spawned = threading.Event(), threading.Event(), []
    original_preflight = run._production_preflight
    original_popen = turn_lab_module.subprocess.Popen

    def pause_after_preflight(*args):
        original_preflight(*args)
        preflight_done.set()
        assert allow_spawn.wait(3)

    def long_lived_host(*_args, **kwargs):
        proc = original_popen([sys.executable, "-c", "import time; time.sleep(30)"], **kwargs)
        spawned.append(proc)
        return proc

    monkeypatch.setattr(run, "_production_preflight", pause_after_preflight)
    monkeypatch.setattr(turn_lab_module.subprocess, "Popen", long_lived_host)
    launcher = threading.Thread(target=run.start_host); launcher.start(); _wait(preflight_done.is_set)
    proof_fixture.viewers = 1
    allow_spawn.set(); launcher.join(timeout=3)
    assert not launcher.is_alive() and spawned
    release_watchdog.set()
    _wait(lambda: run.closed)
    assert run.monitor() == "stopped:human-viewer"
    _wait(lambda: spawned[0].poll() is not None)
    _wait(lambda: not proof_fixture.leases)


def test_host_spawn_failure_closes_run_releases_lease_and_reaps_signal(tmp_path, proof_fixture, monkeypatch):
    run = _run(tmp_path, proof_fixture); run.start("legacy")
    signal_child, runtime_dir = run._children[0], run._runtime_dir

    def fail_host_spawn(*_args, **_kwargs):
        raise OSError("fixture Host spawn failure")

    monkeypatch.setattr(turn_lab_module.subprocess, "Popen", fail_host_spawn)
    with pytest.raises(OSError, match="Host spawn failure"):
        run.start_host()
    assert run.closed and not proof_fixture.leases
    assert signal_child.poll() is not None
    assert runtime_dir is not None and not runtime_dir.exists()


def test_close_reaps_signal_while_startup_json_read_is_blocked(tmp_path, proof_fixture, monkeypatch):
    run = _run(tmp_path, proof_fixture)
    entered, release, captured, errors = threading.Event(), threading.Event(), [], []
    original = LabRun._read_startup_json

    def blocked_read(proc, output, **kwargs):
        captured.append(proc); entered.set()
        assert release.wait(3)
        return original(proc, output, **kwargs)

    monkeypatch.setattr(LabRun, "_read_startup_json", staticmethod(blocked_read))

    def start():
        try: run.start("legacy")
        except Exception as exc: errors.append(str(exc))

    starter = threading.Thread(target=start); starter.start(); _wait(entered.is_set)
    try:
        runtime_dir = run._runtime_dir
        close_started = time.monotonic()
        run.close()
        assert time.monotonic() - close_started < 2
        assert captured and captured[0].poll() is not None
        assert not run._children and runtime_dir is not None and not runtime_dir.exists()
    finally:
        release.set(); starter.join(timeout=3)
    assert not starter.is_alive() and errors


def test_stale_watchdog_cannot_close_or_rewrite_a_restarted_run(tmp_path, proof_fixture):
    run = _run(tmp_path, proof_fixture); run.start("legacy")
    proof_fixture.block_next_status = True
    _wait(proof_fixture.status_block_entered.is_set)
    run.close()
    current = run.start("legacy")
    proof_fixture.status_block_release.set()
    time.sleep(.35)
    assert not run.closed and run.identity == current and run.monitor() == "running"
    run.close()


def test_manual_close_reports_closed_and_preserves_stop_reason(tmp_path, proof_fixture):
    run = _run(tmp_path, proof_fixture); run.start("legacy"); run.close(); run.close()
    assert run.monitor() == "closed"
    run = _run(tmp_path, proof_fixture); identity = run.start("legacy")
    run.monitor(lab_identity=LabIdentity("other", identity.origin, identity.epoch, identity.realm, "other")); run.close()
    assert run.monitor() == "stopped:lab-identity-changed"


def test_manual_close_erases_the_per_run_transcript_verifier(tmp_path, proof_fixture):
    """The collector may retain a captured local verifier, but LabRun must not retain it after close."""
    run = _run(tmp_path, proof_fixture)
    run.start("legacy")
    verifier = run.transcript_verifier()

    run.close()

    assert verifier
    assert run._transcript_secret == ""
    with pytest.raises(RuntimeError, match="transcript verifier"):
        run.transcript_verifier()


def test_lab_viewer_credentials_publish_the_web_client_proof_admission_shape(tmp_path, proof_fixture):
    run = _run(tmp_path, proof_fixture)
    identity = run.start("legacy")
    try:
        credentials = run.viewer_credentials()
        assert credentials["origin"] == identity.origin
        assert credentials["password"]
        assert credentials["proofAdmission"] == {
            "token": identity._proof_token, "epoch": identity.epoch, "realm": identity.realm,
        }
    finally:
        run.close()


def test_monitor_identity_gate_and_watchdog_internal_identity_check_fail_closed(tmp_path, proof_fixture):
    run = _run(tmp_path, proof_fixture); identity = run.start("legacy")
    forged = LabIdentity("other", identity.origin, identity.epoch, identity.realm, "other")
    assert run.monitor(lab_identity=forged) == "stopped:lab-identity-changed"
    assert run.closed and run.monitor() == "stopped:lab-identity-changed"
    run = _run(tmp_path, proof_fixture); run.start("legacy")
    run.identity = forged
    _wait(lambda: run.closed); assert run.monitor() == "stopped:lab-identity-changed"


def test_old_identity_cannot_impersonate_restarted_run(tmp_path, proof_fixture):
    run = _run(tmp_path, proof_fixture); old = run.start("legacy"); run.close()
    assert not proof_fixture.leases
    current = run.start("legacy")
    assert old != current
    assert run.monitor(lab_identity=old) == "stopped:lab-identity-changed"
    assert run.closed


def test_identity_mismatch_reason_survives_concurrent_close(tmp_path, proof_fixture):
    run = _run(tmp_path, proof_fixture); identity = run.start("legacy")
    forged = LabIdentity("other", identity.origin, identity.epoch, identity.realm, "other")
    monitor = threading.Thread(target=lambda: run.monitor(lab_identity=forged)); monitor.start(); monitor.join(timeout=2)
    closer = threading.Thread(target=run.close); closer.start(); closer.join(timeout=2)
    assert run.monitor() == "stopped:lab-identity-changed" and run.closed


def test_watchdog_stops_on_human_viewer_and_child_exit(tmp_path, proof_fixture):
    run = _run(tmp_path, proof_fixture); run.start("legacy"); proof_fixture.viewers = 1
    _wait(lambda: run.closed); assert run.monitor() == "stopped:human-viewer"
    proof_fixture.viewers = 0
    run = _run(tmp_path, proof_fixture); run.start("legacy")
    child = run._children[0]; child.terminate()
    _wait(lambda: run.closed); assert run.monitor() == "stopped:lab-child-exited"


def test_watchdog_stops_when_production_status_fails(tmp_path, proof_fixture):
    run = _run(tmp_path, proof_fixture); run.start("legacy"); proof_fixture.fail_status = True
    _wait(lambda: run.closed); assert run.monitor() == "stopped:production-status-failed"


def test_candidate_rejection_happens_before_any_lab_child_starts(tmp_path, proof_fixture):
    run = _run(tmp_path, proof_fixture)
    with pytest.raises(ValueError, match="candidate manifest"): run.start("candidate")
    assert not run._children and run.closed


def test_lab_run_finally_cleanup_removes_its_runtime(tmp_path, proof_fixture):
    run = _run(tmp_path, proof_fixture)
    with run:
        run.start("legacy"); runtime_dir = run._runtime_dir; assert runtime_dir and runtime_dir.is_dir()
    assert runtime_dir is not None and not runtime_dir.exists()


def test_lab_host_launcher_has_no_arbitrary_command_escape_hatch(tmp_path, proof_fixture):
    run = _run(tmp_path, proof_fixture); run.start("legacy")
    with pytest.raises(TypeError): run.start_host([sys.executable])  # type: ignore[call-arg]
    run.close()


def test_close_waits_for_host_popen_return_then_reaps_the_registered_child(tmp_path, proof_fixture, monkeypatch):
    run = _run(tmp_path, proof_fixture); run.start("legacy")
    entered, release, spawned, errors = threading.Event(), threading.Event(), [], []
    original = turn_lab_module.subprocess.Popen
    def blocked_host_spawn(*_args, **kwargs):
        proc = original([sys.executable, "-c", "import time; time.sleep(30)"], **kwargs)
        spawned.append(proc); entered.set(); assert release.wait(2)
        return proc
    monkeypatch.setattr(turn_lab_module.subprocess, "Popen", blocked_host_spawn)
    def launch():
        try: run.start_host()
        except RuntimeError as exc: errors.append(str(exc))
    launcher = threading.Thread(target=launch)
    launcher.start(); _wait(entered.is_set)
    closer = threading.Thread(target=run.close); closer.start()
    time.sleep(.05)
    assert closer.is_alive() and spawned[0].poll() is None
    release.set(); launcher.join(timeout=3); closer.join(timeout=3)
    assert not launcher.is_alive() and not closer.is_alive() and run.closed
    assert not errors
    assert spawned and spawned[0].poll() is not None


def test_close_winning_before_host_spawn_never_calls_popen(tmp_path, proof_fixture, monkeypatch):
    run = _run(tmp_path, proof_fixture); run.start("legacy")
    entered, release, calls, errors = threading.Event(), threading.Event(), [], []
    original_preflight = run._production_preflight
    original_popen = turn_lab_module.subprocess.Popen

    def paused_preflight(*args):
        original_preflight(*args); entered.set()
        assert release.wait(2)

    def unexpected_popen(*args, **kwargs):
        calls.append(args)
        return original_popen(*args, **kwargs)

    monkeypatch.setattr(run, "_production_preflight", paused_preflight)
    monkeypatch.setattr(turn_lab_module.subprocess, "Popen", unexpected_popen)

    def launch():
        try: run.start_host()
        except RuntimeError as exc: errors.append(str(exc))

    launcher = threading.Thread(target=launch); launcher.start(); _wait(entered.is_set)
    run.close(); release.set(); launcher.join(timeout=3)
    assert not launcher.is_alive() and not calls
    assert errors == ["lab run was closed or replaced during startup"]


def test_close_waits_for_signal_popen_return_then_reaps_the_registered_child(tmp_path, proof_fixture, monkeypatch):
    run = _run(tmp_path, proof_fixture)
    entered, release, spawned, errors = threading.Event(), threading.Event(), [], []
    original = turn_lab_module.subprocess.Popen

    def blocked_signal_spawn(*_args, **kwargs):
        proc = original([sys.executable, "-c", "import time; time.sleep(30)"], **kwargs)
        spawned.append(proc); entered.set(); assert release.wait(2)
        return proc

    monkeypatch.setattr(turn_lab_module.subprocess, "Popen", blocked_signal_spawn)

    def start():
        try: run.start("legacy")
        except RuntimeError as exc: errors.append(str(exc))

    starter = threading.Thread(target=start); starter.start(); _wait(entered.is_set)
    closer = threading.Thread(target=run.close); closer.start()
    time.sleep(.05)
    assert closer.is_alive() and spawned[0].poll() is None
    release.set(); starter.join(timeout=3); closer.join(timeout=3)
    assert not starter.is_alive() and not closer.is_alive() and run.closed
    assert spawned[0].poll() is not None and not run._children
    assert errors


def _reap_group_and_close_stdout(proc):
    try: os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError: pass
    proc.wait(timeout=2)
    if proc.stdout is not None: proc.stdout.close()


def test_partial_startup_output_hits_bounded_timeout():
    proc = subprocess.Popen([sys.executable, "-c", "import sys,time;sys.stdout.write('{');sys.stdout.flush();time.sleep(2)"], stdout=subprocess.PIPE, start_new_session=True)
    try:
        assert proc.stdout is not None
        with pytest.raises(RuntimeError, match="timed out"): LabRun._read_startup_json(proc, proc.stdout, timeout_seconds=.1)
    finally:
        _reap_group_and_close_stdout(proc)


def test_oversize_startup_output_is_rejected_and_reaped():
    proc = subprocess.Popen([sys.executable, "-c", "import sys,time;sys.stdout.write('x'*9000);sys.stdout.flush();time.sleep(2)"], stdout=subprocess.PIPE, start_new_session=True)
    try:
        assert proc.stdout is not None
        with pytest.raises(RuntimeError, match="exceeded limit"): LabRun._read_startup_json(proc, proc.stdout, timeout_seconds=1)
    finally:
        _reap_group_and_close_stdout(proc)


def test_fixture_turn_requires_production_zero_viewer_lease_and_watchdog(tmp_path, proof_fixture):
    fixture_turn = LabTurnBootstrap("fixture-turn", "fixture-fingerprint", ("turn:127.0.0.1:57004?transport=udp",), "once", "secret")
    with pytest.raises(RuntimeError, match="zero-viewer proof"):
        LabRun(runtime_root=tmp_path).start_fixture_turn(fixture_turn)
    run = _run(tmp_path, proof_fixture)
    identity = run.start_fixture_turn(fixture_turn)
    assert identity.realm.startswith("lab-") and proof_fixture.proofs == 1
    proof_fixture.epoch += 1; _wait(lambda: run.closed); _wait(lambda: not proof_fixture.leases)
    assert run.monitor() == "stopped:production-epoch-changed"


def test_fixture_start_host_revalidates_production_proof_before_spawning(tmp_path, proof_fixture, monkeypatch):
    fixture_turn = LabTurnBootstrap("fixture-turn", "fixture-fingerprint", ("turn:127.0.0.1:57004?transport=udp",), "once", "secret")
    run = _run(tmp_path, proof_fixture); run.start_fixture_turn(fixture_turn)
    proof_fixture.viewers = 1
    calls = []
    original = turn_lab_module.subprocess.Popen
    monkeypatch.setattr(turn_lab_module.subprocess, "Popen", lambda *args, **kwargs: calls.append(args) or original(*args, **kwargs))
    with pytest.raises(RuntimeError, match="production preflight"):
        run.start_host()
    assert calls == [] and run.closed and not proof_fixture.leases
