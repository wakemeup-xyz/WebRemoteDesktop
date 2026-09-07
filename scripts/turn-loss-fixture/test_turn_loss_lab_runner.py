"""Loopback integration test for the owner control client and adapter taps."""
from __future__ import annotations
import importlib.util
import json
import hashlib
import sys
import threading
import tempfile
import time
import urllib.request
from types import SimpleNamespace
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import controller
sys.path.insert(0, str(HERE.parent))
from turn_controlled_scene_lab_runner import RawLossTimelineCollector

SPEC = importlib.util.spec_from_file_location("turn_loss_runner", HERE / "turn_loss_lab_runner.py")
runner = importlib.util.module_from_spec(SPEC); assert SPEC.loader; SPEC.loader.exec_module(runner)


def _manifest():
    return controller.LossFixtureManifest.parse({"schemaVersion": 1, "runId": "6ed74e8f-0d87-4c3a-8675-b3834de2db01", "realm": "turn-loss-lab-6ed74e8f", "namespace": "turn-loss-6ed74e8f", "interface": "eth0", "udpLegSelector": {"protocol": "udp", "source": "172.31.0.4", "sourcePort": 51002, "destination": "172.31.0.3", "destinationPort": 57004}, "controlEndpoint": {"host": "127.0.0.1", "port": 19091}, "credentialsFile": "credentials/turn.json", "receiverEvidenceFile": "receiver/sequence.json", "receiverBridgeFile": "receiver/bridge.json", "selectedTurn": {"id": "turn-candidate-1", "fingerprint": "sha256:" + "d" * 64, "digest": "e" * 64}, "versionDigest": "a" * 64, "imageDigests": {"turn": "registry.example/turn@sha256:" + "b" * 64, "controller": "sha256:" + "c" * 64}})


class Backend:
    def __init__(self): self.counter = 1; self.probe_counter = 0
    def add_rule(self, _): pass
    def remove_rule(self, _): pass
    def read_rule_counter(self, _): self.counter += 1; return self.counter
    def add_probe(self, *_): pass
    def remove_probe(self, *_): pass
    def read_probe_counter(self, _): self.probe_counter += 1; return self.probe_counter


class DeferredEvidence:
    deferred = True
    def sequences_for(self, *_): return []


class Adapter:
    def __init__(self): self.armed = 0; self.samples = 0
    def arm_loss_lab_taps(self): self.armed += 1; return True
    def viewer_session_identity(self): return {"attemptId": "attempt", "generation": 2, "streamId": "video"}
    def sample_loss_lab_taps(self):
        self.samples += 1
        timestamp = time.monotonic_ns()
        # The fake media source exposes a real RTP sequence discontinuity
        # while the control rule is active; the final verifier derives its
        # media effect from this raw stream rather than a synthetic boolean.
        sequence = self.samples if self.samples == 1 else self.samples + 10
        host_key = {"attemptId": "attempt", "generation": 2, "streamId": "video", "captureSeq": self.samples, "encoderTimestamp": self.samples}
        viewer_key = {"attemptId": "attempt", "generation": 2, "streamId": "video", "captureSeq": self.samples, "wireTimestamp": self.samples}
        return {"host": [{"type": "rtcp_feedback", "kind": "PLI", "monotonicNs": timestamp}, {"type": "encoder_idr", "monotonicNs": timestamp, "frameKey": host_key, "requestToken": "request"}, {"type": "rtp_send", "monotonicNs": timestamp, "frameKey": host_key, "sequence": sequence, "rtpTimestamp": self.samples, "ssrc": 1}], "rvfc": [{**viewer_key, "rtpTimestamp": self.samples, "viewerAcceptedMs": self.samples, "pcId": "viewer-pc", "resolution": {"width": 1280, "height": 720}}], "droppedHostEvents": 0, "stats": {"pcId": "viewer-pc", "state": "connected", "selectedRelay": {"address": "127.0.0.1", "port": 51002, "protocol": "udp"}, "inbound": {"packetsReceived": self.samples, "packetsLost": 0, "jitter": 0, "width": 1280, "height": 720}}}


    def read_receiver_capture(self, *, manifest, event):
        leg = manifest.egress_selector; start, end = event["startedMonotonicNs"], event["endedMonotonicNs"]
        capture = {"source": "fixture-af-packet", "direction": "turn-to-viewer", "runId": manifest.run_id, "eventHandle": event["comment"], "selectedLeg": leg, "kernelDropCount": 1, "ssrc": 9, "cursor": {"first": 1, "last": 6}, "receivedRtp": {"before": [{"sequence": 10, "rtpTimestamp": 1, "ssrc": 9, "fixtureClockNs": start - 1}, {"sequence": 11, "rtpTimestamp": 2, "ssrc": 9, "fixtureClockNs": start}], "during": [{"sequence": 13, "rtpTimestamp": 4, "ssrc": 9, "fixtureClockNs": start}, {"sequence": 14, "rtpTimestamp": 5, "ssrc": 9, "fixtureClockNs": end}], "after": [{"sequence": 15, "rtpTimestamp": 6, "ssrc": 9, "fixtureClockNs": end + 1}, {"sequence": 16, "rtpTimestamp": 7, "ssrc": 9, "fixtureClockNs": end + 2}]}}
        capture["captureDigest"] = hashlib.sha256(json.dumps(capture, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        return capture


def test_runner_drives_loopback_controller_and_its_adapter_taps():
    manifest = _manifest(); fixture = controller.LossController(manifest, backend=Backend(), receiver_source=DeferredEvidence())
    server = controller.LossControlServer({"host": "127.0.0.1", "port": 0}, controller.ControlRequestRouter(fixture, "token"))
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    adapter = Adapter(); timeline = RawLossTimelineCollector(started_ns=1, ended_ns=2); waits = []
    try:
        result = runner.run_controlled_loss_transaction(manifest=manifest, endpoint=f"127.0.0.1:{server.server_address[1]}", control_token="token", adapter=adapter, timeline=timeline, wait=waits.append)
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=2)
    assert len(result["events"]) == 2
    assert adapter.armed == 1 and adapter.samples == 52
    assert sum(waits) == 50.2 and waits.count(1.0) == 50 and waits.count(0.2) == 1
    assert len(timeline.recovery) == 2
    assert timeline.feedback and timeline.paint and timeline.pc


def test_runner_rejects_a_cleared_rule_with_zero_counter_delta():
    class ZeroBackend(Backend):
        def read_rule_counter(self, _): return 1
    manifest = _manifest(); fixture = controller.LossController(manifest, backend=ZeroBackend(), receiver_source=DeferredEvidence())
    server = controller.LossControlServer({"host": "127.0.0.1", "port": 0}, controller.ControlRequestRouter(fixture, "token"))
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        try:
            runner.run_controlled_loss_transaction(manifest=manifest, endpoint=f"127.0.0.1:{server.server_address[1]}", control_token="token", adapter=Adapter(), timeline=RawLossTimelineCollector(started_ns=1, ended_ns=2), wait=lambda _: None)
            assert False, "zero counter delta must block"
        except RuntimeError as error:
            assert "did not clear" in str(error)
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=2)


class FakeClock:
    def __init__(self): self.value = 0.0
    def now(self): return self.value
    def wait(self, seconds): self.value += seconds


class FakeLab:
    def __init__(self, root, manifest):
        self.identity = SimpleNamespace(run_id=manifest.run_id, realm=manifest.realm, origin="http://127.0.0.1:49999", epoch=1)
        self.root, self.manifest, self.secret = Path(root), manifest, b"fake-current-lab-verifier"
        self.log = self.root / "host.stderr.log"; self.write_summary()
        self.claims = set()
    def transcript_verifier(self): return self.secret
    def runtime_dir(self): return self.root
    def write_summary(self):
        row = {"alignmentState": "OBSERVED", "counts": {"outputs": 1}, "coverage": {"sourceToWire": 1.0},
               "traces": {"sourceOutputFrameCount": 1, "wireBoundCount": 1, "alignmentFailureCount": 0, "droppedTraceCount": 0},
               "observer": {"enabled": True, "originByStream": {"attempt|2|video|1": 7}}}
        with self.log.open("a", encoding="utf-8") as handle: handle.write("WRD_FRAME_TRACE_SUMMARY " + json.dumps(row) + "\n")
    def wait_host_turn_applied(self): return True
    def arm_controlled_input(self, *, lease_id, lease_epoch, fixture_id): return True
    def bind_controlled_input(self, *, input_id, **_): self.claims.add(input_id)
    def wait_for_controlled_claim(self, input_id): return {"inputId": input_id, "status": "claimed"} if input_id in self.claims else None


class FakePage:
    def __init__(self, clock, lab): self.clock, self.lab = clock, lab
    def evaluate(self, script):
        if "currentFrameTraceIdentity" in script: return {"attemptId": "attempt", "generation": 2, "streamId": "video"}
        if "__wrdT3TraceBatches" in script:
            row = {"attemptId": "attempt", "generation": 2, "streamId": "video", "wireTimestamp": int(self.clock.value) + 1}
            return {"batches": [{"type": "frame_trace_batch", "schemaVersion": 1, "traces": [row]}],
                    "joins": [{**row, "traceStatus": "matched"}],
                    "diagnostics": {"acceptanceState": "PENDING", "droppedTraceCount": 0, "invalidBatchCount": 0, "staleTraceCount": 0, "conflictingTraceCount": 0}}
        return None
    def wait_for_timeout(self, milliseconds): self.clock.wait(milliseconds / 1000); self.lab.write_summary()


class FullPathAdapter(Adapter):
    def __init__(self, clock, lab):
        super().__init__(); self.clock, self.lab, self.viewer_page = clock, lab, FakePage(clock, lab)
        self.proof = self.layout = None; self.endpoint = None; self.current = None; self.inputs = 0
    def viewer_session_identity(self): return {"attemptId": "attempt", "generation": 2, "streamId": "video", "sourceWidth": 1280, "sourceHeight": 720}
    def producer_window_precondition(self): return True, "fake-visible-fixture"
    def set_producer_proof(self, proof): self.proof = proof
    def calibrate_marker_roi(self, **_): return (64, 48, 256, 128)
    def configure_marker_roi(self, layout): self.layout = layout
    def static_frames(self, layout):
        return [{"runNonce": str(self.proof.run_nonce), "sceneId": self.proof.scene_id, "tick": 0, "actionId": 0,
                 "attemptId": self.proof.attempt_id, "generation": self.proof.generation,
                 "sourceWidth": layout.source_width, "sourceHeight": layout.source_height, "roi": list(layout.roi), "layoutDigest": layout.layout_digest}
                for _ in range(61)]
    def calibrate_fixture_input_geometry(self, **_): return {}
    def acquire_controlled_lease(self): return {"leaseId": "lease", "leaseEpoch": 1}
    def install_input_ack_observer(self): return None
    def configure_loopback_producer(self, *, endpoint, proof, layout): self.endpoint, self.proof, self.layout = endpoint, proof, layout
    def prepare_lab_input(self, step):
        self.inputs += 1; self.current = step
        return {"inputId": f"input-{step.action_id}", "leaseId": "lease", "leaseEpoch": 1,
                "type": "keyboard" if step.kind == "text" and step.phase == "text" else "mouse", "action": step.phase, "payload": {}}
    def prepare_native_action(self, _action_id): return None
    def dispatch_prepared_lab_input(self, reservation):
        event = {"runNonce": str(self.proof.run_nonce), "sceneId": self.proof.scene_id, "attemptId": self.proof.attempt_id,
                 "generation": self.proof.generation, "realm": self.proof.realm, "runId": self.proof.run_id, "focused": True,
                 "actionId": self.current.action_id, "sourceWidth": self.layout.source_width, "sourceHeight": self.layout.source_height,
                 "roi": list(self.layout.roi), "layoutDigest": self.layout.layout_digest}
        request = urllib.request.Request(self.endpoint, data=json.dumps(event).encode(), headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(request, timeout=2) as response: assert response.status == 202
        return reservation["inputId"]
    def wait_for_applied_ack(self, input_id): return {"inputId": input_id, "status": "applied"}
    def wait_for_decoded_visual(self, input_id, _action_id): return {"inputId": input_id, "traceStatus": "matched", "rtpTimestamp": 1, "wireTimestamp": 1}
    def dispatch_safety_release(self): return None


def test_runner_full_fake_lab_path_generates_stages_then_seals_and_verifies_once():
    """No final collector feed: the runner drains fake live callbacks end-to-end."""
    manifest = _manifest(); clock = FakeClock()
    with tempfile.TemporaryDirectory() as directory:
        lab, adapter = FakeLab(directory, manifest), FullPathAdapter(clock, None)
        adapter.lab = lab; adapter.viewer_page.lab = lab
        t5 = runner._collect_current_t5(lab=lab, adapter=adapter, scope={"attemptId": "attempt", "generation": 2, "streamId": "video"}, selected_turn=manifest.selected_turn)
        t3 = runner._collect_current_t3(lab=lab, adapter=adapter, scope={"attemptId": "attempt", "generation": 2, "streamId": "video"}, selected_turn=manifest.selected_turn, now=clock.now)
        fixture = controller.LossController(manifest, backend=Backend(), receiver_source=DeferredEvidence())
        server = controller.LossControlServer({"host": "127.0.0.1", "port": 0}, controller.ControlRequestRouter(fixture, "token"))
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        authority = controller.LabReceiverBridgeAuthority(manifest, verifier=lab.transcript_verifier(), socket_path=Path(directory) / "authority.sock")
        authority.start()
        try:
            timeline = RawLossTimelineCollector(started_ns=1, ended_ns=2)
            transaction = runner.run_controlled_loss_transaction(manifest=manifest, endpoint=f"127.0.0.1:{server.server_address[1]}", control_token="token", adapter=adapter, timeline=timeline, wait=clock.wait)
            final = runner.seal_and_verify_live_bridge(manifest=manifest, authority=authority, fixture=fixture, seal_path=Path(directory) / "seal.json", transaction=transaction, timeline=timeline, t3=t3, t5=t5)
        finally:
            authority.close(); server.shutdown(); server.server_close(); thread.join(timeout=2)
    assert t3["status"] == "OBSERVED" and t5["automatic"]["status"] == "PASS"
    assert final["status"] == "PASS" and adapter.inputs > 0


def test_runner_full_path_blocks_when_t3_live_callback_is_missing():
    manifest = _manifest(); clock = FakeClock()
    with tempfile.TemporaryDirectory() as directory:
        lab, adapter = FakeLab(directory, manifest), FullPathAdapter(clock, None)
        adapter.lab = lab; adapter.viewer_page.lab = lab
        adapter.viewer_page.evaluate = lambda _script: None
        try:
            runner._collect_current_t3(lab=lab, adapter=adapter, scope={"attemptId": "attempt", "generation": 2, "streamId": "video"}, selected_turn=manifest.selected_turn, now=clock.now)
            assert False, "missing live callback must block"
        except RuntimeError as error:
            assert "scope" in str(error) or "T3" in str(error)


def test_runner_full_path_blocks_when_t5_static_callbacks_are_missing():
    manifest = _manifest(); clock = FakeClock()
    with tempfile.TemporaryDirectory() as directory:
        lab, adapter = FakeLab(directory, manifest), FullPathAdapter(clock, None)
        adapter.lab = lab; adapter.viewer_page.lab = lab
        adapter.static_frames = lambda _layout: []
        try:
            runner._collect_current_t5(lab=lab, adapter=adapter, scope={"attemptId": "attempt", "generation": 2, "streamId": "video"}, selected_turn=manifest.selected_turn)
            assert False, "missing T5 static callback must block"
        except RuntimeError as error:
            assert "static" in str(error)
