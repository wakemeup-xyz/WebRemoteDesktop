"""Loopback integration test for the owner control client and adapter taps."""
from __future__ import annotations
import importlib.util
import sys
import threading
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
    def read_rule_counter(self, _): return self.counter
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
        return {"host": [{"type": "rtcp_feedback", "kind": "PLI", "monotonicNs": self.samples}], "rvfc": [{"rtpTimestamp": self.samples, "monotonicMs": self.samples, "pcId": "viewer-pc", "resolution": {"width": 1280, "height": 720}}], "droppedHostEvents": 0, "stats": {"pcId": "viewer-pc", "state": "connected", "selectedRelay": {"address": "127.0.0.1", "port": 51002, "protocol": "udp"}, "inbound": {"packetsReceived": self.samples, "packetsLost": 0, "jitter": 0, "width": 1280, "height": 720}}}


def test_runner_drives_loopback_controller_and_its_adapter_taps():
    manifest = _manifest(); fixture = controller.LossController(manifest, backend=Backend(), receiver_source=DeferredEvidence())
    server = controller.LossControlServer({"host": "127.0.0.1", "port": 0}, controller.ControlRequestRouter(fixture, "token"))
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    adapter = Adapter(); timeline = RawLossTimelineCollector(started_ns=1, ended_ns=2)
    try:
        result = runner.run_controlled_loss_transaction(manifest=manifest, endpoint=f"127.0.0.1:{server.server_address[1]}", control_token="token", adapter=adapter, timeline=timeline, wait=lambda _: None)
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=2)
    assert len(result["events"]) == 2
    assert adapter.armed == 1 and adapter.samples == 11
    assert timeline.feedback and timeline.paint and timeline.pc
