"""Offline contract tests for the isolated TURN loss fixture."""
from __future__ import annotations

import importlib.util
import hashlib
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
        "receiverEvidenceFile": "receiver/sequence.json",
        "versionDigest": "a" * 64,
        "imageDigests": {
            "turn": "registry.example/turn@sha256:" + "b" * 64,
            "controller": "sha256:" + "c" * 64,
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

    def read_rule_counter(self, _argv):
        return getattr(self, "counter", 0)


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
    def __init__(self):
        self.calls = 0

    def save(self, _event):
        self.calls += 1
        if self.calls > 1:
            raise OSError("state volume unavailable")

    def load(self):
        return None

    def clear(self):
        return None


class StaticReceiver:
    def __init__(self, sequences):
        self.sequences = sequences

    def sequences_for(self, _manifest, _event):
        return self.sequences


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
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=backend, receiver_source=StaticReceiver([3, 4, 6, 7]))
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
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=backend, receiver_source=StaticReceiver([3, 4, 6, 7]))
    session = _session(fixture)
    session.confirm_selected_leg(manifest()["udpLegSelector"], 117)
    event = session.apply_loss(manifest()["runId"], "every_100th_for_30s", 30_000)
    rule = backend.added[0]
    assert "--every" in rule and "100" in rule and "19091" not in rule
    assert event["selector"] == manifest()["udpLegSelector"]
    assert event["startedMonotonicNs"] > 0
    backend.counter = 1
    fixture.collect_receiver_evidence(manifest()["runId"])
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
    # A dedicated bridge must permit the fixture's explicitly loopback-bound
    # relay/control ports. Docker Desktop suppresses those mappings for an
    # `internal` bridge.
    assert "internal: true" not in compose


def test_turn_entrypoint_can_execute_coturn_with_its_image_file_capability():
    compose = (HERE / "compose.yaml").read_text(encoding="utf-8")
    turn_block = compose.split("  loss-controller:", 1)[0]
    # coturn ships turnserver with a file capability; Docker's
    # no-new-privileges and an empty capability set reject exec before the
    # isolated process starts.
    assert "no-new-privileges" not in turn_block
    assert "NET_BIND_SERVICE" in turn_block


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
    assert pending["cleared"] is False and pending["state"] == "cleanupPending"
    assert fixture.active_event is not None
    cleared = fixture.clear_loss(manifest()["runId"])
    assert cleared["cleared"] is True and fixture.active_event is None
    assert backend.removed == backend.added


def test_external_deadline_cleanup_reclaims_expired_persisted_rule_without_controller_process(tmp_path):
    store = controller.DeadlineStateStore(tmp_path / "active-loss.json")
    backend = RecordingBackend()
    event = {"schemaVersion": 1, "state": "armed", "comment": "wrd-loss-test", "runId": manifest()["runId"], "rule": ["-j", "DROP"], "deadlineMonotonicNs": 8}
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
    assert "./runtime" not in compose and "ports:" not in compose
    assert "TURN_USERNAME" in entrypoint and "TURN_PASSWORD" in entrypoint and "--user" in entrypoint
    assert "--external-ip=127.0.0.1" in entrypoint
    assert controller.ControlRequestRouter


def test_serving_binds_inside_the_isolated_namespace_while_compose_publishes_only_loopback(tmp_path):
    source = (HERE / "controller.py").read_text(encoding="utf-8")
    assert 'server = LossControlServer({"host": "0.0.0.0", "port": manifest.control_endpoint["port"]}' in source
    override = controller.prepare_runtime(manifest(), tmp_path, resolved_images=controller._test_resolved_images(manifest()["imageDigests"]))
    assert "127.0.0.1:" in Path(override["composeOverride"]).read_text(encoding="utf-8")


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
    backend = RecordingBackend()
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=backend, receiver_source=StaticReceiver([65534, 65535, 1]))
    session = _session(fixture)
    session.confirm_selected_leg(manifest()["udpLegSelector"], 1)
    session.apply_loss(manifest()["runId"], "all_for_200ms", 200)
    fixture.clear_loss(manifest()["runId"])
    assert fixture.verify_final_evidence(manifest()["runId"])["status"] == "FAIL"
    backend.counter = 1
    fixture.collect_receiver_evidence(manifest()["runId"])
    assert fixture.verify_final_evidence(manifest()["runId"])["status"] == "PASS"
    for invalid in ([4, 4], [5, 4], [65535, 0, 65535]):
        with pytest.raises(ValueError):
            controller.sequence_gaps(invalid)


def test_prepare_runtime_derives_immutable_compose_override_and_credentials_only_from_valid_manifest(tmp_path):
    raw = manifest()
    generated = controller.prepare_runtime(raw, tmp_path, resolved_images=controller._test_resolved_images(raw["imageDigests"]))
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
            controller.prepare_runtime(unsafe, tmp_path / "unsafe", resolved_images=controller._test_resolved_images(raw["imageDigests"]))


def test_generated_compose_is_syntactically_valid_without_user_environment(tmp_path):
    for name in ("compose.yaml", "turn-entrypoint.sh", "controller.py"):
        shutil.copyfile(HERE / name, tmp_path / name)
    generated = controller.prepare_runtime(manifest(), tmp_path / "runtime", resolved_images=controller._test_resolved_images(manifest()["imageDigests"]))
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


def test_prepare_is_blocked_without_a_docker_resolved_image_evidence(tmp_path):
    with pytest.raises(controller.RuntimeBlocked):
        controller.prepare_runtime(manifest(), tmp_path)


def test_generated_override_binds_the_arbitrary_runtime_and_returns_manifest_derived_endpoints(tmp_path):
    raw = manifest()
    generated = controller.prepare_runtime(raw, tmp_path, resolved_images=controller._test_resolved_images(raw["imageDigests"]))
    override = (tmp_path / "compose.generated.yaml").read_text()
    assert f"{tmp_path}:/runtime:ro" in override
    assert f"{tmp_path / 'turn.env'}" in override
    assert generated["controlEndpoint"].startswith("127.0.0.1:")
    assert generated["turnEndpoint"].startswith("127.0.0.1:")
    assert generated["projectName"] in generated["networkName"]
    assert (tmp_path / "credentials" / "turn.json").stat().st_mode & 0o777 == 0o600
    assert (tmp_path / "turn.env").stat().st_mode & 0o777 == 0o600
    assert (tmp_path / "manifest.json").stat().st_mode & 0o777 == 0o600
    assert (tmp_path / "image-evidence.json").stat().st_mode & 0o777 == 0o600


def test_started_fixture_layout_verifies_the_manifest_derived_host_ports_and_network(tmp_path):
    raw = manifest()
    generated = controller.prepare_runtime(raw, tmp_path, resolved_images=controller._test_resolved_images(raw["imageDigests"]))
    calls = []
    replies = iter([
        (0, generated["turnEndpoint"] + "\n", ""),
        (0, generated["controlEndpoint"] + "\n", ""),
        (0, generated["networkName"] + "\n", ""),
    ])
    def run(argv):
        calls.append(argv)
        return next(replies)
    assert controller.verify_started_fixture(generated, run=run)["status"] == "READY"
    assert calls[0][:3] == ["docker", "inspect", "--format"]
    assert calls[0][-1] == generated["projectName"] + "-turn-1"


def test_installing_state_is_persisted_before_rule_and_watchdog_cleans_it(tmp_path):
    store = controller.DeadlineStateStore(tmp_path / "state.json")
    backend = RecordingBackend()
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=backend, state_store=store)
    session = _session(fixture)
    session.confirm_selected_leg(manifest()["udpLegSelector"], 1)
    # The explicit state contract lets a process that starts later clean an
    # interrupted installation without consulting controller memory.
    event = {"schemaVersion": 1, "state": "installing", "runId": manifest()["runId"], "rule": ["-j", "DROP"], "deadlineMonotonicNs": 999, "comment": "wrd-loss-test"}
    store.save(event)
    assert controller.recover_deadline_state(store, backend, now_ns=1)["status"] == "CLEARED"


def test_control_rejects_extra_fields_and_self_reported_drop_counts():
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=RecordingBackend())
    router = controller.ControlRequestRouter(fixture, "token")
    with pytest.raises(ValueError, match="fields"):
        router.validate_request({"operation": "health", "controlToken": "token", "extra": True})
    with pytest.raises(ValueError, match="actualDropCount"):
        router.validate_request({"operation": "delivery", "controlToken": "token", "actualDropCount": 1})


def test_manifest_distinguishes_remote_turn_digest_from_local_controller_oci_id():
    parsed = controller.LossFixtureManifest.parse(manifest())
    assert parsed.image_digests["turn"].startswith("registry.example/turn@sha256:")
    assert parsed.image_digests["controller"].startswith("sha256:")
    bad_turn = manifest()
    bad_turn["imageDigests"] = {**bad_turn["imageDigests"], "turn": "sha256:" + "b" * 64}
    with pytest.raises(ValueError, match="TURN image"):
        controller.LossFixtureManifest.parse(bad_turn)
    bad_controller = manifest()
    bad_controller["imageDigests"] = {**bad_controller["imageDigests"], "controller": "registry.example/controller@sha256:" + "c" * 64}
    with pytest.raises(ValueError, match="controller image"):
        controller.LossFixtureManifest.parse(bad_controller)


def test_controller_dockerfile_uses_a_digest_pinned_base_and_installs_iptables():
    source = (HERE / "Dockerfile").read_text(encoding="utf-8")
    assert "ARG CONTROLLER_BASE_IMAGE" in source
    assert "FROM ${CONTROLLER_BASE_IMAGE}" in source
    assert "iptables" in source
    assert "COPY controller.py /fixture/controller.py" in source


def test_controller_build_entrypoint_has_no_mutable_runtime_tag():
    source = (HERE / "controller.py").read_text(encoding="utf-8")
    assert 'add_parser("build-controller")' in source
    assert '"--iidfile"' in source
    assert '"--build-arg", f"CONTROLLER_BASE_IMAGE={base_digest}"' in source
    assert '"org.wrd.turn-loss.base-repodigest"' in source


def test_runtime_probe_verifies_local_controller_id_labels_and_network_none_contents():
    labels = {
        "org.wrd.turn-loss.base-repodigest": "python@sha256:" + "d" * 64,
        "org.wrd.turn-loss.controller-sha256": hashlib.sha256((HERE / "controller.py").read_bytes()).hexdigest(),
        "org.wrd.turn-loss.dockerfile-sha256": hashlib.sha256((HERE / "Dockerfile").read_bytes()).hexdigest(),
    }
    responses = iter([
        (0, "27.5.1", ""),
        (0, "27.5.1", ""),
        (0, '["registry.example/turn@sha256:' + "b" * 64 + '"]', ""),
        (0, "sha256:" + "c" * 64, ""),
        (0, __import__("json").dumps(labels), ""),
        (0, "", ""),
    ])
    probe = controller.DockerRuntimeProbe(run=lambda _argv: next(responses))
    resolved = probe.resolve_fixture_images(manifest()["imageDigests"])
    assert resolved.images == manifest()["imageDigests"]
    assert resolved.controller_base_digest == labels["org.wrd.turn-loss.base-repodigest"]
    assert resolved.controller_source_sha256 == labels["org.wrd.turn-loss.controller-sha256"]
    assert resolved.controller_dockerfile_sha256 == labels["org.wrd.turn-loss.dockerfile-sha256"]
