"""Offline contract tests for the isolated TURN loss fixture."""
from __future__ import annotations

import importlib.util
import sys
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


class ManualTimer:
    def __init__(self, _seconds, callback):
        self.callback = callback
        self.cancelled = False

    def start(self):
        return None

    def cancel(self):
        self.cancelled = True

    def fire(self):
        self.callback()


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
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=backend, timer_factory=ManualTimer)
    with pytest.raises(RuntimeError, match="baseline"):
        fixture.apply_loss("6ed74e8f-0d87-4c3a-8675-b3834de2db01", "all_for_200ms", 200)
    with pytest.raises(ValueError, match="selector"):
        fixture.confirm_selected_leg("6ed74e8f-0d87-4c3a-8675-b3834de2db01", {"protocol": "udp"}, 1)
    with pytest.raises(ValueError, match="nonzero"):
        fixture.confirm_selected_leg("6ed74e8f-0d87-4c3a-8675-b3834de2db01", manifest()["udpLegSelector"], 0)
    fixture.confirm_selected_leg("6ed74e8f-0d87-4c3a-8675-b3834de2db01", manifest()["udpLegSelector"], 17)
    with pytest.raises(ValueError, match="runId"):
        fixture.apply_loss("wrong-run", "all_for_200ms", 200)


@pytest.mark.parametrize(("pattern", "duration"), [
    ("unknown", 200), ("all_for_200ms", 201), ("every_100th_for_30s", 30001),
    ("every_100th_for_30s", 35_001),
])
def test_apply_rejects_unapproved_patterns_and_duration(pattern, duration):
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=RecordingBackend(), timer_factory=ManualTimer)
    fixture.confirm_selected_leg(manifest()["runId"], manifest()["udpLegSelector"], 1)
    with pytest.raises(ValueError):
        fixture.apply_loss(manifest()["runId"], pattern, duration)


def test_apply_generates_udp_media_rule_excluding_control_and_records_evidence():
    backend = RecordingBackend()
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=backend, timer_factory=ManualTimer)
    fixture.confirm_selected_leg(manifest()["runId"], manifest()["udpLegSelector"], 117)
    event = fixture.apply_loss(manifest()["runId"], "every_100th_for_30s", 30_000)
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


def test_watchdog_exception_and_connection_close_always_clear_active_loss():
    backend = RecordingBackend()
    timers: list[ManualTimer] = []
    def make_timer(seconds, callback):
        timer = ManualTimer(seconds, callback)
        timers.append(timer)
        return timer
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=backend, timer_factory=make_timer)
    fixture.confirm_selected_leg(manifest()["runId"], manifest()["udpLegSelector"], 2)
    fixture.apply_loss(manifest()["runId"], "all_for_200ms", 200)
    timers[0].fire()
    assert backend.removed and fixture.active_event is None
    fixture.confirm_selected_leg(manifest()["runId"], manifest()["udpLegSelector"], 3)
    with pytest.raises(RuntimeError):
        with fixture.connection(manifest()["runId"]):
            fixture.apply_loss(manifest()["runId"], "all_for_200ms", 200)
            raise RuntimeError("simulated control disconnect")
    assert len(backend.removed) == 2


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
    assert compose.count("NET_ADMIN") == 1
    assert "network_mode: service:turn" in compose
