"""Offline contract tests for the isolated TURN loss fixture."""
from __future__ import annotations

import importlib.util
import hashlib
import json
import shutil
import socket
import subprocess
import sys
import threading
import time
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
        "receiverBridgeFile": "receiver/bridge.json",
        "selectedTurn": {"id": "turn-candidate-1", "fingerprint": "sha256:" + "d" * 64, "digest": "e" * 64},
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
        self.probes: list[tuple[str, list[str], list[str]]] = []
        self.removed_probes: list[tuple[str, list[str], list[str]]] = []
        self._probe_counts: dict[tuple[str, ...], int] = {}

    def add_rule(self, argv):
        self.added.append(list(argv))

    def remove_rule(self, argv):
        self.removed.append(list(argv))

    def read_rule_counter(self, _argv):
        return getattr(self, "counter", 0)

    def add_probe(self, chain, jump, counter_rule):
        self.probes.append((chain, list(jump), list(counter_rule)))

    def remove_probe(self, chain, jump, counter_rule):
        self.removed_probes.append((chain, list(jump), list(counter_rule)))

    def read_probe_counter(self, counter_rule):
        key = tuple(counter_rule)
        value = self._probe_counts.get(key, 0)
        self._probe_counts[key] = value + 1
        return value


class FailingRemovalBackend(RecordingBackend):
    def __init__(self):
        super().__init__()
        self.failures = 1

    def remove_rule(self, argv):
        if self.failures and any(part.startswith("wrd-loss:") for part in argv):
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


class ProbeCounterBackend(RecordingBackend):
    def __init__(self, probe_counts):
        super().__init__()
        self.probe_counts = iter(probe_counts)

    def read_probe_counter(self, _counter_rule):
        return next(self.probe_counts)


class BlockingAddBackend(ProbeCounterBackend):
    def __init__(self):
        super().__init__([0, 1])
        self.added_event = threading.Event()
        self.resume_add = threading.Event()

    def add_rule(self, argv):
        super().add_rule(argv)
        if any(part.startswith("wrd-loss:") for part in argv):
            self.added_event.set()
            assert self.resume_add.wait(2)


class ProbeCrashBackend(RecordingBackend):
    def add_probe(self, chain, jump, counter_rule):
        super().add_probe(chain, jump, counter_rule)
        raise KeyboardInterrupt("simulated SIGKILL after probe chain install")


class BlockingProbeBackend(ProbeCounterBackend):
    def __init__(self):
        super().__init__([0, 1])
        self.installed = threading.Event()
        self.resume = threading.Event()

    def add_probe(self, chain, jump, counter_rule):
        super().add_probe(chain, jump, counter_rule)
        self.installed.set()
        assert self.resume.wait(2)


def test_baseline_is_kernel_counter_probe_not_control_caller_packet_count():
    backend = ProbeCounterBackend([17, 20])
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=backend, probe_sleep=lambda _seconds: None)
    session = _session(fixture)
    session.confirm_selected_leg()
    chain, jump, counter_rule = backend.probes[0]
    assert chain.startswith("WRDB") and jump[-1] == chain
    assert counter_rule[-1] == "RETURN"
    assert backend.removed_probes == [(chain, jump, counter_rule)]
    assert fixture._baselines[session.session_id]["packetCount"] == 3


def test_zero_kernel_probe_delta_refuses_loss_without_arming_rule():
    backend = ProbeCounterBackend([9, 9])
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=backend, probe_sleep=lambda _seconds: None)
    with pytest.raises(RuntimeError, match="kernel counter"):
        _session(fixture).confirm_selected_leg()
    assert backend.probes == backend.removed_probes


def test_probe_uses_user_chain_return_so_output_traversal_continues():
    backend = ProbeCounterBackend([0, 1])
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=backend, probe_sleep=lambda _seconds: None)
    _session(fixture).confirm_selected_leg()
    chain, jump, counter_rule = backend.probes[0]
    assert jump[-1] == chain and "RETURN" not in jump
    assert counter_rule[-1] == "RETURN"


def test_sigkill_after_probe_install_leaves_durable_handles_for_watchdog_cleanup(tmp_path):
    store = controller.DeadlineStateStore(tmp_path / "probe-state.json")
    backend = ProbeCrashBackend()
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=backend, state_store=store, probe_sleep=lambda _seconds: None)
    with pytest.raises(KeyboardInterrupt, match="SIGKILL"):
        _session(fixture).confirm_selected_leg()
    event = store.load()
    assert event and event["state"] == "probing" and event["probe"]["chain"].startswith("WRDB")
    assert controller.recover_deadline_state(store, backend, now_ns=0)["status"] == "CLEARED"
    assert backend.removed_probes == backend.probes


def test_watchdog_cannot_clear_probe_intent_while_probe_transaction_holds_flock(tmp_path):
    store = controller.DeadlineStateStore(tmp_path / "probe-state.json")
    backend = BlockingProbeBackend()
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=backend, state_store=store, probe_sleep=lambda _seconds: None)
    session = _session(fixture)
    confirm_done = threading.Event()
    reaper_done = threading.Event()
    worker = threading.Thread(target=lambda: (session.confirm_selected_leg(), confirm_done.set()))
    worker.start()
    assert backend.installed.wait(1)
    reaper = threading.Thread(target=lambda: (controller.recover_deadline_state(store, backend, now_ns=0), reaper_done.set()))
    reaper.start()
    time.sleep(.05)
    assert not reaper_done.is_set()
    backend.resume.set()
    worker.join(1); reaper.join(1)
    assert confirm_done.is_set() and reaper_done.is_set() and store.load() is None


def test_watchdog_cannot_observe_installing_state_until_atomic_install_transaction_releases_lock(tmp_path):
    store = controller.DeadlineStateStore(tmp_path / "state.json")
    backend = BlockingAddBackend()
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=backend, state_store=store, probe_sleep=lambda _seconds: None)
    session = _session(fixture)
    session.confirm_selected_leg()
    apply_done = threading.Event()
    watchdog_done = threading.Event()
    errors = []

    def apply():
        try:
            session.apply_loss(manifest()["runId"], "all_for_200ms", 200)
        except Exception as exc:  # pragma: no cover - asserted below
            errors.append(exc)
        finally:
            apply_done.set()

    def watchdog():
        controller.recover_deadline_state(store, backend, now_ns=0)
        watchdog_done.set()

    installer = threading.Thread(target=apply)
    installer.start()
    assert backend.added_event.wait(1)
    reaper = threading.Thread(target=watchdog)
    reaper.start()
    time.sleep(.05)
    assert not watchdog_done.is_set()
    backend.resume_add.set()
    installer.join(1)
    reaper.join(1)
    assert not errors and apply_done.is_set() and watchdog_done.is_set()
    assert not any(any(part.startswith("wrd-loss:") for part in rule) for rule in backend.removed)


def test_persisted_installing_state_after_simulated_sigkill_removes_the_actual_rule(tmp_path):
    store = controller.DeadlineStateStore(tmp_path / "state.json")
    backend = RecordingBackend()
    rule = ["-m", "comment", "--comment", "wrd-loss:crash", "-j", "DROP"]
    event = {"schemaVersion": 1, "state": "installing", "comment": "wrd-loss:crash", "runId": manifest()["runId"], "rule": rule, "deadlineMonotonicNs": 999}
    # This is the process-death point: kernel rule added, then no controller
    # code runs. The persisted install intent must remain recoverable.
    store.save(event)
    backend.add_rule(rule)
    assert controller.recover_deadline_state(store, backend, now_ns=0)["status"] == "CLEARED"
    assert backend.removed == [rule]


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
    session.confirm_selected_leg()
    with pytest.raises(ValueError, match="runId"):
        session.apply_loss("wrong-run", "all_for_200ms", 200)


@pytest.mark.parametrize(("pattern", "duration"), [
    ("unknown", 200), ("all_for_200ms", 201), ("every_100th_for_30s", 30001),
    ("every_100th_for_30s", 35_001),
])
def test_apply_rejects_unapproved_patterns_and_duration(pattern, duration):
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=RecordingBackend())
    session = _session(fixture)
    session.confirm_selected_leg()
    with pytest.raises(ValueError):
        session.apply_loss(manifest()["runId"], pattern, duration)


def test_apply_generates_udp_media_rule_excluding_control_and_records_evidence():
    backend = RecordingBackend()
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=backend, receiver_source=StaticReceiver([3, 4, 6, 7]))
    session = _session(fixture)
    session.confirm_selected_leg()
    event = session.apply_loss(manifest()["runId"], "every_100th_for_30s", 30_000)
    rule = next(rule for rule in backend.added if any(part.startswith("wrd-loss:") for part in rule))
    assert "--every" in rule and "100" in rule and "19091" not in rule
    assert event["selector"] == manifest()["udpLegSelector"]
    assert event["startedMonotonicNs"] > 0
    backend.counter = 1
    fixture.collect_receiver_evidence(manifest()["runId"])
    cleared = fixture.clear_loss(manifest()["runId"])
    assert cleared["actualDropCount"] == 1
    assert cleared["receiverSequenceGaps"] == [5]
    assert cleared["endedMonotonicNs"] >= event["startedMonotonicNs"]
    assert backend.removed[-1] == rule


def test_connection_close_always_clears_active_loss():
    backend = RecordingBackend()
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=backend)
    session = _session(fixture)
    session.confirm_selected_leg()
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
    return fixture.open_session(manifest()["runId"], "control-session-a", generation, attempt_id="attempt-a", stream_id="video-a", clock=clock)


def test_apply_rolls_back_installed_rule_when_deadline_state_cannot_be_persisted():
    backend = RecordingBackend()
    fixture = controller.LossController(
        controller.LossFixtureManifest.parse(manifest()), backend=backend,
        state_store=FailingStateStore(),
    )
    session = _session(fixture)
    session.confirm_selected_leg()
    with pytest.raises(OSError, match="state volume"):
        session.apply_loss(manifest()["runId"], "all_for_200ms", 200)
    assert backend.removed == backend.added
    assert fixture.active_event is None


def test_remove_failure_stays_cleanup_pending_and_a_retry_keeps_the_rule_handle():
    backend = FailingRemovalBackend()
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=backend)
    session = _session(fixture)
    session.confirm_selected_leg()
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
    clock = iter([99, 100, 103, 101, 102, 103])
    fixture = controller.LossController(
        controller.LossFixtureManifest.parse(manifest()), backend=RecordingBackend(),
        baseline_ttl_ns=2, monotonic_ns=lambda: next(clock),
    )
    session = _session(fixture, generation=8)
    session.confirm_selected_leg()
    with pytest.raises(RuntimeError, match="expired"):
        session.apply_loss(manifest()["runId"], "all_for_200ms", 200)
    session.confirm_selected_leg()
    session.apply_loss(manifest()["runId"], "all_for_200ms", 200)
    with pytest.raises(RuntimeError, match="baseline"):
        session.apply_loss(manifest()["runId"], "all_for_200ms", 200)
    with pytest.raises(ValueError, match="generation"):
        fixture.open_session(manifest()["runId"], "control-session-a", 9, attempt_id="attempt-a", stream_id="video-a")


def test_final_evidence_requires_nonzero_drop_and_strict_receiver_sequence_gaps():
    backend = RecordingBackend()
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=backend, receiver_source=StaticReceiver([65534, 65535, 1]))
    session = _session(fixture)
    session.confirm_selected_leg()
    session.apply_loss(manifest()["runId"], "all_for_200ms", 200)
    fixture.clear_loss(manifest()["runId"])
    assert fixture.verify_final_evidence(manifest()["runId"])["status"] == "BLOCKED"
    backend.counter = 1
    fixture.collect_receiver_evidence(manifest()["runId"])
    assert fixture.verify_final_evidence(manifest()["runId"])["status"] == "BLOCKED"
    for invalid in ([4, 4], [5, 4], [65535, 0, 65535]):
        with pytest.raises(ValueError):
            controller.sequence_gaps(invalid)


def test_forged_plain_receiver_file_with_sha_shaped_digest_cannot_pass_media_effect(tmp_path):
    evidence_path = tmp_path / "sequence.json"
    evidence_path.write_text(__import__("json").dumps({
        "runId": manifest()["runId"], "sessionId": "control-session-a", "generation": 7,
        "selector": manifest()["udpLegSelector"], "sequences": [1, 3], "captureDigest": "a" * 64,
    }))
    backend = RecordingBackend()
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=backend, receiver_source=controller.FileReceiverEvidenceSource(evidence_path))
    session = _session(fixture)
    session.confirm_selected_leg()
    session.apply_loss(manifest()["runId"], "all_for_200ms", 200)
    backend.counter = 1
    fixture.collect_receiver_evidence(manifest()["runId"])
    fixture.clear_loss(manifest()["runId"])
    assert fixture.verify_final_evidence(manifest()["runId"])["status"] == "BLOCKED"


def _signed_receiver_bridge(raw_manifest, event, *, verifier=b"live-lab-verifier", **changes):
    """Make the same in-memory-only T3/T5 verifier bridge used by the Lab."""
    scope = {"attemptId": event["attemptId"], "generation": event["generation"], "streamId": event["streamId"]}
    t3 = {
        "schemaVersion": 1, "kind": "turn-t3-lab-stage-run", "runId": raw_manifest["runId"],
        "identity": {"runId": raw_manifest["runId"], "realm": raw_manifest["realm"], "origin": "http://lab.invalid", "epoch": 1,
                     "selectedTurn": raw_manifest["selectedTurn"]},
        "durationSeconds": 60, "scope": scope, "status": "OBSERVED", "failures": [],
        "verification": {"algorithm": "HMAC-SHA256", "verifierSource": "lab-transcript-verifier/sha256:" + hashlib.sha256(verifier).hexdigest(), "selfVerified": True, "verifiedBeforeLabClose": True},
    }
    t3["signature"] = controller.sign_t3_artifact(t3, verifier)
    segments = controller._canonical_t5_segments()
    receipts = [{"inputId": f"input-{action}", "actionId": action, "logicalActionId": action // 100,
                 "kind": kind, "phase": phase, **({"text": text} if text else {}),
                 "reservation": {"inputId": f"input-{action}"}, "binding": {"fixtureId": "fixture", "leaseId": "lease", "leaseEpoch": 1, "action": {}},
                 "ack": {"inputId": f"input-{action}", "status": "applied"}, "claim": {"inputId": f"input-{action}", "status": "claimed"}, "native": {"inputId": f"input-{action}"}, "visual": {"inputId": f"input-{action}", "status": "PASS"}}
                for action, kind, phase, text in segments]
    t5 = {"identity": {"runId": raw_manifest["runId"], "realm": raw_manifest["realm"], "origin": "http://lab.invalid", "epoch": 1, "scope": scope, "selectedTurn": raw_manifest["selectedTurn"]},
          "static": {"status": "PASS"}, "automatic": {"status": "PASS", "workload": [{"actionId": action} for action in range(1, 32)]}, "receipts": receipts}
    t5["signature"] = controller.sign_t5_transcript(t5, verifier)
    bridge = {
        "schemaVersion": 1, "kind": "turn-loss-receiver-bridge", "t3": t3, "t5": t5,
        "loss": {"runId": raw_manifest["runId"], "realm": raw_manifest["realm"], "sessionId": event["sessionId"],
                 **scope, "selectedTurn": raw_manifest["selectedTurn"], "eventHandle": event["comment"],
                 "startedMonotonicNs": event["startedMonotonicNs"], "endedMonotonicNs": event["endedMonotonicNs"],
                 "receiverCapture": {"source": "fixture-af-packet", "direction": "turn-to-viewer", "runId": raw_manifest["runId"], "eventHandle": event["comment"], "selectedLeg": controller.LossFixtureManifest.parse(raw_manifest).egress_selector, "kernelDropCount": 1, "ssrc": 7, "cursor": {"first": 1, "last": 6}, "receivedRtp": {"before": [{"sequence": 10, "rtpTimestamp": 1, "ssrc": 7, "fixtureClockNs": event["startedMonotonicNs"] - 1}, {"sequence": 11, "rtpTimestamp": 2, "ssrc": 7, "fixtureClockNs": event["startedMonotonicNs"]}], "during": [{"sequence": 13, "rtpTimestamp": 4, "ssrc": 7, "fixtureClockNs": event["startedMonotonicNs"]}, {"sequence": 14, "rtpTimestamp": 5, "ssrc": 7, "fixtureClockNs": event["endedMonotonicNs"]}], "after": [{"sequence": 15, "rtpTimestamp": 6, "ssrc": 7, "fixtureClockNs": event["endedMonotonicNs"] + 1}, {"sequence": 16, "rtpTimestamp": 7, "ssrc": 7, "fixtureClockNs": event["endedMonotonicNs"] + 2}]}, "captureDigest": ""}, "receiverCaptures": {}, "eventHandles": []},
        "timeline": {"feedback": [{"kind": "PLI", "monotonicNs": event["endedMonotonicNs"]}], "idr": {"frameKey": {"attemptId": scope["attemptId"], "generation": scope["generation"], "streamId": scope["streamId"], "captureSeq": 1, "wireTimestamp": 8}, "wireTimestamp": 8, "hostMonotonicNs": event["endedMonotonicNs"] + 1}, "paint": {"frameKey": {"attemptId": scope["attemptId"], "generation": scope["generation"], "streamId": scope["streamId"], "captureSeq": 1, "wireTimestamp": 8}, "wireTimestamp": 8, "viewerAcceptedMs": 42.0}, "pc": [{"id": "pc-1", "state": "connected", "resolution": {"width": 1280, "height": 720}}, {"id": "pc-1", "state": "connected", "resolution": {"width": 1280, "height": 720}}], "recovery": [{"eventHandle": event["comment"], "clearReplyObservedNs": 10, "feedbackObservedNs": 11, "idrObservedNs": 12, "paintObservedNs": 13, "tapEpoch": 1}]},
    }
    bridge.update(changes)
    capture = bridge.get("loss", {}).get("receiverCapture")
    if isinstance(capture, dict) and not capture.get("captureDigest"):
        body = {key: value for key, value in capture.items() if key != "captureDigest"}
        capture["captureDigest"] = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if isinstance(capture, dict) and not capture.get("authoritySignature"):
        capture["authoritySignature"] = __import__("hmac").new(verifier, json.dumps({key: value for key, value in capture.items() if key != "authoritySignature"}, sort_keys=True, separators=(",", ":")).encode(), hashlib.sha256).hexdigest()
    if isinstance(capture, dict):
        archive = dict(capture); archive_handle = capture["eventHandle"] + "-archive"; archive["eventHandle"] = archive_handle
        archive["authoritySignature"] = __import__("hmac").new(verifier, json.dumps({key: value for key, value in archive.items() if key != "authoritySignature"}, sort_keys=True, separators=(",", ":")).encode(), hashlib.sha256).hexdigest()
        bridge["loss"]["eventHandles"] = [capture["eventHandle"], archive_handle]; bridge["loss"]["receiverCaptures"] = {capture["eventHandle"]: capture, archive_handle: archive}
    bridge["signature"] = controller.sign_receiver_bridge(bridge, verifier)
    return bridge


def _signed_fixture(raw_manifest, backend, *, verifier=b"live-lab-verifier"):
    fixture = controller.LossController(controller.LossFixtureManifest.parse(raw_manifest), backend=backend, receiver_source=StaticReceiver([1, 2]))
    session = fixture.open_session(raw_manifest["runId"], "control-session-a", 7, attempt_id="attempt-a", stream_id="video-a")
    session.confirm_selected_leg()
    event = session.apply_loss(raw_manifest["runId"], "all_for_200ms", 200)
    return fixture, event, verifier


def test_authenticated_t3_t5_bridge_requires_live_verifier_and_all_recovery_links():
    raw, backend = manifest(), RecordingBackend()
    fixture, event, verifier = _signed_fixture(raw, backend)
    backend.counter = 2
    fixture.collect_receiver_evidence(raw["runId"])
    event = fixture.clear_loss(raw["runId"])
    bridge = _signed_receiver_bridge(raw, event, verifier=verifier)
    fixture._receiver_source = controller.SignedT3T5ReceiverEvidenceSource(bridge, verifier=verifier)
    result = fixture.verify_final_evidence(raw["runId"])
    assert result["status"] == "PASS", result
    assert result["event"]["receiverSequenceGaps"] == [12]


@pytest.mark.parametrize("mutation", [
    lambda bridge: bridge["t3"].__setitem__("runId", "other-run"),
    lambda bridge: bridge["loss"].__setitem__("attemptId", "other-attempt"),
    lambda bridge: bridge["loss"].__setitem__("selectedTurn", {"id": "other", "fingerprint": "sha256:" + "e" * 64, "digest": "f" * 64}),
    lambda bridge: bridge["timeline"].__setitem__("idr", {}),
    lambda bridge: bridge["timeline"]["pc"].append({"id": "pc-2", "state": "connected", "resolution": {"width": 1280, "height": 720}}),
])
def test_authenticated_bridge_rejects_forgery_replay_cross_attempt_and_partial_recovery(mutation):
    raw, backend = manifest(), RecordingBackend()
    fixture, event, verifier = _signed_fixture(raw, backend)
    backend.counter = 1
    fixture.collect_receiver_evidence(raw["runId"])
    event = fixture.clear_loss(raw["runId"])
    bridge = _signed_receiver_bridge(raw, event, verifier=verifier)
    mutation(bridge)  # Signature is intentionally not recomputed: persisted JSON is untrusted.
    fixture._receiver_source = controller.SignedT3T5ReceiverEvidenceSource(bridge, verifier=verifier)
    assert fixture.verify_final_evidence(raw["runId"])["status"] == "BLOCKED"


def test_authenticated_bridge_rejects_counter_only_or_visual_only_evidence():
    raw, backend = manifest(), RecordingBackend()
    fixture, event, verifier = _signed_fixture(raw, backend)
    backend.counter = 1
    fixture.collect_receiver_evidence(raw["runId"])
    event = fixture.clear_loss(raw["runId"])
    bridge = _signed_receiver_bridge(raw, event, verifier=verifier)
    bridge["loss"]["sequences"] = {"before": [], "during": [], "after": []}
    bridge["signature"] = controller.sign_receiver_bridge(bridge, verifier)
    fixture._receiver_source = controller.SignedT3T5ReceiverEvidenceSource(bridge, verifier=verifier)
    assert fixture.verify_final_evidence(raw["runId"])["status"] == "BLOCKED"


def test_authenticated_bridge_rejects_a_validly_signed_cross_attempt_replay():
    raw, backend = manifest(), RecordingBackend()
    fixture, event, verifier = _signed_fixture(raw, backend)
    backend.counter = 1
    fixture.collect_receiver_evidence(raw["runId"])
    event = fixture.clear_loss(raw["runId"])
    bridge = _signed_receiver_bridge(raw, event, verifier=verifier)
    bridge["loss"]["attemptId"] = "replayed-attempt"
    bridge["t3"]["scope"]["attemptId"] = "replayed-attempt"
    bridge["t3"]["signature"] = controller.sign_t3_artifact(bridge["t3"], verifier)
    bridge["signature"] = controller.sign_receiver_bridge(bridge, verifier)
    fixture._receiver_source = controller.SignedT3T5ReceiverEvidenceSource(bridge, verifier=verifier)
    assert fixture.verify_final_evidence(raw["runId"])["status"] == "BLOCKED"


def test_authenticated_bridge_rejects_a_validly_signed_legacy_t5_without_scope_or_native_receipt():
    raw, backend = manifest(), RecordingBackend()
    fixture, event, verifier = _signed_fixture(raw, backend)
    backend.counter = 1
    fixture.collect_receiver_evidence(raw["runId"])
    event = fixture.clear_loss(raw["runId"])
    bridge = _signed_receiver_bridge(raw, event, verifier=verifier)
    bridge["t5"]["identity"].pop("scope")
    bridge["t5"]["receipts"][0].pop("native")
    bridge["t5"]["signature"] = controller.sign_t5_transcript(bridge["t5"], verifier)
    bridge["signature"] = controller.sign_receiver_bridge(bridge, verifier)
    fixture._receiver_source = controller.SignedT3T5ReceiverEvidenceSource(bridge, verifier=verifier)
    assert fixture.verify_final_evidence(raw["runId"])["status"] == "BLOCKED"


def test_compose_controller_uses_per_run_unix_authority_without_receiving_the_lab_verifier(tmp_path):
    raw, backend = manifest(), RecordingBackend()
    fixture, event, verifier = _signed_fixture(raw, backend)
    backend.counter = 1
    fixture.collect_receiver_evidence(raw["runId"])
    event = fixture.clear_loss(raw["runId"])
    socket_path = Path("/tmp") / f"wrd-t6-{__import__('os').getpid()}.sock"
    authority = controller.LabReceiverBridgeAuthority(controller.LossFixtureManifest.parse(raw), verifier=verifier, socket_path=socket_path)
    authority.start()
    try:
        sealed = authority.seal(_signed_receiver_bridge(raw, event, verifier=verifier), event)
        seal_path = tmp_path / "bridge.json"
        seal_path.write_text(__import__("json").dumps({"sealId": sealed["sealId"], "signature": sealed["signature"]}))
        fixture._receiver_source = controller.UnixSealedReceiverEvidenceSource(socket_path, seal_path)
        assert fixture.verify_final_evidence(raw["runId"])["status"] == "PASS"
        forged = __import__("json").loads(seal_path.read_text()); forged["sealId"] = "other"
        seal_path.write_text(__import__("json").dumps(forged))
        assert fixture.verify_final_evidence(raw["runId"])["status"] == "BLOCKED"
    finally:
        authority.close()


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


def test_controller_image_contains_the_fixture_udp_echo_peer_source():
    dockerfile = (HERE / "Dockerfile").read_text()
    assert "COPY udp_echo_peer.py /fixture/udp_echo_peer.py" in dockerfile
    assert "COPY receiver_capture.py /fixture/receiver_capture.py" in dockerfile


def test_real_compose_smoke_runs_all_fixture_services_and_relays_udp_echo(tmp_path):
    """Exercise the generated fixture against a real coturn and UDP peer."""
    if not shutil.which("docker"):
        pytest.skip("Docker CLI is unavailable")
    probe = controller.DockerRuntimeProbe()
    if probe.status()["status"] != "READY":
        pytest.skip("Docker daemon is unavailable")
    try:
        turn = probe.image_digests(["coturn/coturn:4.6.2"])["coturn/coturn:4.6.2"]
        built = probe.build_local_controller_image("python:3.11-alpine")
    except controller.RuntimeBlocked as exc:
        pytest.skip(str(exc))
    raw = manifest(imageDigests={"turn": turn, "controller": built["controllerImageId"]})
    resolved = probe.resolve_fixture_images(raw["imageDigests"])
    prepared = controller.prepare_runtime(raw, tmp_path / "runtime", resolved_images=resolved)
    compose = HERE / "compose.yaml"
    command = ["docker", "compose", "--project-name", prepared["projectName"], "-f", str(compose), "-f", prepared["composeOverride"]]
    try:
        assert subprocess.run([*command, "up", "-d"], text=True, capture_output=True, check=False).returncode == 0
        expected = {"turn", "loss-controller", "receiver-capture", "udp-echo-peer", "loss-watchdog"}
        deadline = time.monotonic() + 12
        running: set[str | None] = set()
        while time.monotonic() < deadline:
            result = subprocess.run([*command, "ps", "--format", "json"], text=True, capture_output=True, check=False)
            rows = [json.loads(line) for line in result.stdout.splitlines() if line] if result.returncode == 0 else []
            running = {row.get("Service") for row in rows if row.get("State") == "running"}
            if running == expected:
                break
            time.sleep(.25)
        assert running == expected
        echo = subprocess.run(["docker", "inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", f"{prepared['projectName']}-udp-echo-peer-1"], text=True, capture_output=True, check=False)
        assert echo.returncode == 0 and echo.stdout.strip()
        probe_spec = importlib.util.spec_from_file_location("real_turn_udp_probe", HERE / "turn_udp_probe.py")
        assert probe_spec and probe_spec.loader
        module = importlib.util.module_from_spec(probe_spec); probe_spec.loader.exec_module(module)
        host, port = prepared["turnEndpoint"].rsplit(":", 1)
        credentials = controller.load_fixture_credentials(tmp_path / "runtime" / raw["credentialsFile"], raw["realm"])
        assert module.permission_send_data_echo(host, int(port), credentials["turnUsername"], credentials["turnPassword"], echo.stdout.strip(), 59000, timeout=3)["peer"].endswith(":59000")
    finally:
        subprocess.run([*command, "down", "-v"], text=True, capture_output=True, check=False)


def test_loopback_control_server_runs_the_authenticated_open_command_then_closes_session():
    fixture = controller.LossController(controller.LossFixtureManifest.parse(manifest()), backend=RecordingBackend())
    server = controller.LossControlServer({"host": "127.0.0.1", "port": 0}, controller.ControlRequestRouter(fixture, "temporary-token"))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with socket.create_connection(server.server_address, timeout=1) as client:
            client.sendall(b'{"operation":"open","controlToken":"temporary-token","runId":"6ed74e8f-0d87-4c3a-8675-b3834de2db01","sessionId":"socket-session","attemptId":"attempt-a","streamId":"video-a","generation":1}\n')
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
    assert ":/lab-bridge:ro" in override
    # The echo peer participates in the real TURN readiness transaction.  It
    # must receive the same locally-built controller image as the other
    # fixture sidecars, so Compose never attempts its placeholder registry.
    assert f"udp-echo-peer:\n    image: {raw['imageDigests']['controller']}" in override
    assert generated["controlEndpoint"].startswith("127.0.0.1:")
    assert generated["bridgeSocket"].endswith("/authority.sock")
    assert generated["turnEndpoint"].startswith("127.0.0.1:")
    assert generated["projectName"] in generated["networkName"]
    assert (tmp_path / "credentials" / "turn.json").stat().st_mode & 0o777 == 0o600
    assert (tmp_path / "turn.env").stat().st_mode & 0o777 == 0o600
    assert (tmp_path / "manifest.json").stat().st_mode & 0o777 == 0o600
    assert (tmp_path / "image-evidence.json").stat().st_mode & 0o777 == 0o600
    assert (tmp_path / "receiver" / "bridge.json").stat().st_mode & 0o777 == 0o600


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
    session.confirm_selected_leg()
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
    router.validate_request({"operation": "confirm", "controlToken": "token"})
    with pytest.raises(ValueError, match="fields"):
        router.validate_request({"operation": "confirm", "controlToken": "token", "packetCount": 1})
    with pytest.raises(ValueError, match="attemptId"):
        router.validate_request({"operation": "open", "controlToken": "token", "runId": manifest()["runId"], "sessionId": "s", "attemptId": 1, "streamId": "v", "generation": 1})


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
    assert 'add_parser("bridge-authority")' in source and 'add_parser("seal-bridge")' in source
    assert 'Path("/lab-bridge/authority.sock")' in source


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

def test_signed_bridge_rejects_host_sender_sequences_even_when_they_show_a_gap():
    """Regression: Host rtp_send 1,3 cannot replace receiver AF_PACKET evidence."""
    raw, backend = manifest(), RecordingBackend()
    fixture, _event, verifier = _signed_fixture(raw, backend)
    backend.counter = 2; fixture.collect_receiver_evidence(raw["runId"]); event = fixture.clear_loss(raw["runId"])
    bridge = _signed_receiver_bridge(raw, event, verifier=verifier)
    bridge["loss"].pop("receiverCapture")
    bridge["loss"]["sequences"] = {"before": [{"sequence": 1, "rtpTimestamp": 1}], "during": [{"sequence": 3, "rtpTimestamp": 3}], "after": [{"sequence": 4, "rtpTimestamp": 4}]}
    bridge["signature"] = controller.sign_receiver_bridge(bridge, verifier)
    fixture._receiver_source = controller.SignedT3T5ReceiverEvidenceSource(bridge, verifier=verifier)
    assert fixture.verify_final_evidence(raw["runId"])["status"] == "BLOCKED"
