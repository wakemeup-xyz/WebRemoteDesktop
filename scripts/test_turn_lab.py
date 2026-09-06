"""Contract tests for the isolated TURN lab boundary."""
from __future__ import annotations

import hashlib
import json
import os
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
from turn_lab import (LabIdentity, LabRun, ProductionAdmissionClient, ProductionProof, _make_test_lab_run, _make_test_production_client, validate_lab_origin)  # noqa: E402
import turn_lab as turn_lab_module  # noqa: E402
from turn_lab_host import LabWebRemoteHost, VerifiedLabContext, _context_from_verified_binding, _test_verified_context, verify_candidate_manifest  # noqa: E402


class _ProofFixture:
    """Real loopback HTTP fixture; never points at the production port."""
    def __init__(self):
        self.epoch, self.viewers, self.proofs, self.fail_status, self.leases = 0, 0, 0, False, {}
        self.fail_proof_status_once = False
        self.block_next_status = False
        self.status_block_entered = threading.Event()
        self.status_block_release = threading.Event()
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
                return self._json(404, {})
            def do_POST(self):
                if self.path == "/api/proof-admission" and self.headers.get("Authorization") == "Bearer fixture-token":
                    fixture.proofs += 1
                    token = f"proof-token-{fixture.proofs}-long"
                    fixture.leases[token] = {"token": token, "epoch": fixture.epoch, "realm": "production"}
                    return self._json(201, {"admission": fixture.leases[token]})
                if self.path in {"/api/proof-admission/status", "/api/proof-admission/release"} and self.headers.get("Authorization") == "Bearer fixture-token":
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
    with pytest.raises(TypeError): VerifiedLabContext("http://127.0.0.1:40123", "lab-r", "x", 0, _context().selection, "legacy")


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
    raw = {"origin": context.origin, "realm": context.realm, "proofToken": context.proof_token, "epoch": context.epoch, "mode": "legacy", "runId": "run-1", "policyId": context.selection.policy_id, "credential": "one-time"}
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


def test_close_and_start_host_race_cannot_leave_an_unregistered_child(tmp_path, proof_fixture, monkeypatch):
    run = _run(tmp_path, proof_fixture); run.start("legacy")
    entered, release, spawned, errors = threading.Event(), threading.Event(), [], []
    original = turn_lab_module.subprocess.Popen
    def blocked_host_spawn(*_args, **kwargs):
        entered.set(); assert release.wait(2)
        proc = original([sys.executable, "-c", "import time; time.sleep(30)"], **kwargs)
        spawned.append(proc); return proc
    monkeypatch.setattr(turn_lab_module.subprocess, "Popen", blocked_host_spawn)
    def launch():
        try: run.start_host()
        except RuntimeError as exc: errors.append(str(exc))
    launcher = threading.Thread(target=launch)
    launcher.start(); _wait(entered.is_set)
    closer = threading.Thread(target=run.close); closer.start()
    release.set(); launcher.join(timeout=3); closer.join(timeout=3)
    assert not launcher.is_alive() and not closer.is_alive() and run.closed
    assert errors == ["lab run was closed or replaced during Host startup"]
    assert spawned and spawned[0].poll() is not None


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
