"""Offline contract tests for the isolated TURN loss fixture."""
from __future__ import annotations

import importlib.util
import shutil
import socket
import subprocess
import sys
import threading
from pathlib import Path

import pytest


HERE = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("turn_loss_controller", HERE / "controller.py")
assert SPEC and SPEC.loader
controller = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = controller
SPEC.loader.exec_module(controller)


def manifest(**overrides):
    result = {
        "schemaVersion": 1,
        "runId": "6ed74e8f-0d87-4c3a-8675-b3834de2db01",
        "realm": "turn-loss-lab-6ed74e8f",
        "namespace": "turn-loss-6ed74e8f",
        "interface": "eth0",
        "udpLegSelector": {
            "protocol": "udp", "source": "172.31.0.4", "sourcePort": 51002,
            "destination": "172.31.0.3", "destinationPort": 57004,
        },
        "controlEndpoint": {"host": "127.0.0.1", "port": 19091},
        "credentialsFile": "credentials/turn.json",
        "versionDigest": "a" * 64,
        "imageDigests": {
            "turn": "registry.example/turn@sha256:" + "b" * 64,
            "controller": "registry.example/controller@sha256:" + "c" * 64,
        },
    }
    result.update(overrides)
    return result


class RecordingBackend:
    def __init__(self):
        self.added: list[list[str]] = []
        self.removed: list[list[str]] = []

    def add_rule(self, argv):
        self.added.append(list(argv))

    def remove_rule(self, argv):
        self.removed.append(list(argv))


class FailingRemovalBackend(RecordingBackend):
    def __init__(self):
        super().__init__()
        self.failures = 1

    def remove_rule(self, argv):
        if self.failures:
            self.failures -= 1
            raise RuntimeError("iptables delete failed")
        super().remove_rule(argv)


class FailingStateStore:
    def save(self, _event):
        raise OSError("state volume unavailable")

    def load(self):
        return None

    def clear(self):
        return None


def test_fixture_manifest_is_strict_and_rejects_production_or_host_targets():
    parsed = controller.LossFixtureManifest.parse(manifest())
    assert parsed.realm.startswith("turn-loss-lab-")
    for field, value in [
        ("realm", "production"), ("realm", "prod-turn"),
        ("interface", "lo"), ("interface", "en0"),
        ("interface", "docker0"), ("namespace", "host"),
    ]:
        with pytest.raises(ValueError):
            controller.LossFixtureManifest.parse(manifest(**{field: value}))
    unsafe = manifest()
    unsafe["udpLegSelector"] = {**unsafe["udpLegSelector"], "destinationPort": 19091}
    with pytest.raises(ValueError, match="control"):
        controller.LossFixtureManifest.parse(unsafe)


def test_fixture_manifest_requires_a_canonical_unique_uuid_run_id():
    with pytest.raises(ValueError, match="runId"):
        controller.LossFixtureManifest.parse(manifest(runId="same-run-again"))


def test_apply_requires_matching_run_selector_and_observed_nonzero_baseline():
    backend = RecordingBackend()
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=backend)
    session = _session(fixture)
    with pytest.raises(RuntimeError, match="baseline"):
        session.apply_loss("6ed74e8f-0d87-4c3a-8675-b3834de2db01", "all_for_200ms", 200)
    with pytest.raises(ValueError, match="selector"):
        session.confirm_selected_leg({"protocol": "udp"}, 1)
    with pytest.raises(ValueError, match="nonzero"):
        session.confirm_selected_leg(manifest()["udpLegSelector"], 0)
    session.confirm_selected_leg(manifest()["udpLegSelector"], 17)
    with pytest.raises(ValueError, match="runId"):
        session.apply_loss("wrong-run", "all_for_200ms", 200)


@pytest.mark.parametrize(("pattern", "duration"), [
    ("unknown", 200), ("all_for_200ms", 201), ("every_100th_for_30s", 30001),
    ("every_100th_for_30s", 35_001),
])
def test_apply_rejects_unapproved_patterns_and_duration(pattern, duration):
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=RecordingBackend())
    session = _session(fixture)
    session.confirm_selected_leg(manifest()["udpLegSelector"], 1)
    with pytest.raises(ValueError):
        session.apply_loss(manifest()["runId"], pattern, duration)


def test_apply_generates_udp_media_rule_excluding_control_and_records_evidence():
    backend = RecordingBackend()
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=backend)
    session = _session(fixture)
    session.confirm_selected_leg(manifest()["udpLegSelector"], 117)
    event = session.apply_loss(manifest()["runId"], "every_100th_for_30s", 30_000)
    rule = backend.added[0]
    assert "--every" in rule and "100" in rule and "19091" not in rule
    assert event["selector"] == manifest()["udpLegSelector"]
    assert event["startedMonotonicNs"] > 0
    fixture.record_delivery(manifest()["runId"], actual_drop_count=1, receiver_sequences=[3, 4, 6, 7])
    cleared = fixture.clear_loss(manifest()["runId"])
    assert cleared["actualDropCount"] == 1
    assert cleared["receiverSequenceGaps"] == [5]
    assert cleared["endedMonotonicNs"] >= event["startedMonotonicNs"]
    assert backend.removed == [rule]


def test_connection_close_always_clears_active_loss():
    backend = RecordingBackend()
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=backend)
    session = _session(fixture)
    session.confirm_selected_leg(manifest()["udpLegSelector"], 2)
    session.apply_loss(manifest()["runId"], "all_for_200ms", 200)
    assert session.close()["cleared"] is True
    assert backend.removed and fixture.active_event is None


def test_runtime_probe_does_not_claim_fixture_ready_when_docker_daemon_is_unavailable():
    probe = controller.DockerRuntimeProbe(run=lambda _argv: (1, "", "Cannot connect to the Docker daemon"))
    status = probe.status()
    assert status["status"] == "BLOCKED"
    assert status["execution"] == "NOT_RUN"


def test_runtime_probe_requires_resolved_repo_digests_for_fixture_metadata():
    responses = iter([
        (0, "27.5.1", ""),
        (0, '["coturn/coturn@sha256:' + "b" * 64 + '"]', ""),
    ])
    probe = controller.DockerRuntimeProbe(run=lambda _argv: next(responses))
    assert probe.image_digests(["coturn/coturn:4.6.2"]) == {
        "coturn/coturn:4.6.2": "coturn/coturn@sha256:" + "b" * 64,
    }


def test_compose_keeps_host_namespaces_out_and_grants_net_admin_only_to_controller():
    compose = (HERE / "compose.yaml").read_text()
    assert "network_mode: host" not in compose and "pid: host" not in compose
    assert compose.count("NET_ADMIN") == 2
    assert "network_mode: service:turn" in compose


def _session(fixture, *, generation=7, clock=None):
    return fixture.open_session(manifest()["runId"], "control-session-a", generation, clock=clock)


def test_apply_rolls_back_installed_rule_when_deadline_state_cannot_be_persisted():
    backend = RecordingBackend()
    fixture = controller.LossController(
        controller.LossFixtureManifest.parse(manifest()), backend=backend,
        state_store=FailingStateStore(),
    )
    session = _session(fixture)
    session.confirm_selected_leg(manifest()["udpLegSelector"], 1)
    with pytest.raises(OSError, match="state volume"):
        session.apply_loss(manifest()["runId"], "all_for_200ms", 200)
    assert backend.removed == backend.added
    assert fixture.active_event is None


def test_remove_failure_stays_cleanup_pending_and_a_retry_keeps_the_rule_handle():
    backend = FailingRemovalBackend()
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=backend)
    session = _session(fixture)
    session.confirm_selected_leg(manifest()["udpLegSelector"], 1)
    session.apply_loss(manifest()["runId"], "all_for_200ms", 200)
    pending = fixture.clear_loss(manifest()["runId"])
    assert pending["cleared"] is False and pending["cleanupPending"] is True
    assert fixture.active_event is not None
    cleared = fixture.clear_loss(manifest()["runId"])
    assert cleared["cleared"] is True and fixture.active_event is None
    assert backend.removed == backend.added


def test_external_deadline_cleanup_reclaims_expired_persisted_rule_without_controller_process(tmp_path):
    store = controller.DeadlineStateStore(tmp_path / "active-loss.json")
    backend = RecordingBackend()
    event = {"runId": manifest()["runId"], "rule": ["-j", "DROP"], "deadlineMonotonicNs": 8, "cleanupPending": False}
    store.save(event)
    result = controller.recover_deadline_state(store, backend, now_ns=9)
    assert result["status"] == "CLEARED" and backend.removed == [["-j", "DROP"]]
    assert store.load() is None


def test_control_service_and_compose_expose_real_loopback_endpoint_and_temporary_turn_credentials():
    compose = (HERE / "compose.yaml").read_text()
    entrypoint = (HERE / "turn-entrypoint.sh").read_text()
    assert "controller.py" in compose and "serve" in compose
    assert "loss-watchdog" in compose and "watchdog" in compose
    assert "RUN_ID" not in compose and "TURN_REALM" not in compose
    assert "127.0.0.1::19091/tcp" in compose
    assert "127.0.0.1:51000-51009:51000-51009/udp" in compose
    assert "runtime/turn.env" in compose
    assert "TURN_USERNAME" in entrypoint and "TURN_PASSWORD" in entrypoint and "--user" in entrypoint
    assert "--external-ip=127.0.0.1" in entrypoint
    assert controller.ControlRequestRouter


def test_reverse_selected_leg_is_canonicalized_to_egress_relay_port():
    raw = manifest()
    raw["udpLegSelector"] = {
        "protocol": "udp", "source": "172.31.0.3", "sourcePort": 57004,
        "destination": "172.31.0.4", "destinationPort": 51002,
    }
    parsed = controller.LossFixtureManifest.parse(raw)
    assert parsed.selector["destinationPort"] == 51002
    assert parsed.egress_selector["sourcePort"] == 51002


def test_baseline_is_bound_to_session_generation_and_time_then_consumed():
    clock = iter([103, 103])
    fixture = controller.LossController(
        controller.LossFixtureManifest.parse(manifest()), backend=RecordingBackend(),
        baseline_ttl_ns=2, monotonic_ns=lambda: next(clock),
    )
    session = _session(fixture, generation=8)
    session.confirm_selected_leg(manifest()["udpLegSelector"], 9, observed_monotonic_ns=100)
    with pytest.raises(RuntimeError, match="expired"):
        session.apply_loss(manifest()["runId"], "all_for_200ms", 200)
    session.confirm_selected_leg(manifest()["udpLegSelector"], 9, observed_monotonic_ns=102)
    session.apply_loss(manifest()["runId"], "all_for_200ms", 200)
    with pytest.raises(RuntimeError, match="baseline"):
        session.apply_loss(manifest()["runId"], "all_for_200ms", 200)
    with pytest.raises(ValueError, match="generation"):
        fixture.open_session(manifest()["runId"], "control-session-a", 9)


def test_final_evidence_requires_nonzero_drop_and_strict_receiver_sequence_gaps():
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=RecordingBackend())
    session = _session(fixture)
    session.confirm_selected_leg(manifest()["udpLegSelector"], 1)
    session.apply_loss(manifest()["runId"], "all_for_200ms", 200)
    fixture.clear_loss(manifest()["runId"])
    assert fixture.verify_final_evidence(manifest()["runId"])["status"] == "FAIL"
    fixture.record_delivery(manifest()["runId"], actual_drop_count=1, receiver_sequences=[65534, 65535, 1])
    assert fixture.verify_final_evidence(manifest()["runId"])["status"] == "PASS"
    for invalid in ([4, 4], [5, 4], [65535, 0, 65535]):
        with pytest.raises(ValueError):
            controller.sequence_gaps(invalid)


def test_prepare_runtime_derives_immutable_compose_override_and_credentials_only_from_valid_manifest(tmp_path):
    raw = manifest()
    generated = controller.prepare_runtime(raw, tmp_path)
    assert generated["projectName"] == "turn-loss-6ed74e8f"
    assert (tmp_path / "credentials" / "turn.json").exists()
    assert (tmp_path / "turn-entrypoint.sh").read_text() == (HERE / "turn-entrypoint.sh").read_text()
    assert "TURN_USERNAME=" in (tmp_path / "turn.env").read_text()
    override = (tmp_path / "compose.generated.yaml").read_text()
    assert raw["imageDigests"]["turn"] in override and raw["imageDigests"]["controller"] in override
    assert "RUN_ID" not in (HERE / "compose.yaml").read_text()
    for unsafe in (
        {**raw, "realm": "production"},
        {**raw, "imageDigests": {"turn": "coturn/coturn:latest", "controller": raw["imageDigests"]["controller"]}},
    ):
        with pytest.raises(ValueError):
            controller.prepare_runtime(unsafe, tmp_path / "unsafe")


def test_generated_compose_is_syntactically_valid_without_user_environment(tmp_path):
    for name in ("compose.yaml", "turn-entrypoint.sh", "controller.py"):
        shutil.copyfile(HERE / name, tmp_path / name)
    generated = controller.prepare_runtime(manifest(), tmp_path / "runtime")
    completed = subprocess.run(
        ["docker", "compose", "-f", str(tmp_path / "compose.yaml"), "-f", generated["composeOverride"], "config", "--quiet"],
        text=True, capture_output=True, check=False,
    )
    assert completed.returncode == 0, completed.stderr


def test_loopback_control_server_runs_the_authenticated_open_command_then_closes_session():
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=RecordingBackend())
    server = controller.LossControlServer({"host": "127.0.0.1", "port": 0}, controller.ControlRequestRouter(fixture, "temporary-token"))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with socket.create_connection(server.server_address, timeout=1) as client:
            client.sendall(b'{"operation":"open","controlToken":"temporary-token","runId":"6ed74e8f-0d87-4c3a-8675-b3834de2db01","sessionId":"socket-session","generation":1}\n')
            assert b'"OPEN"' in client.recv(4096)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(1)
