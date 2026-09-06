import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).with_name("turn_controlled_scene_lab_runner.py")
SPEC = importlib.util.spec_from_file_location("turn_controlled_scene_lab_runner", SCRIPT)
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)


class Identity:
    origin = "http://127.0.0.1:49999"
    realm = "lab-run"
    run_id = "run-1"
    epoch = 2


class Run:
    def __init__(self): self.calls = []
    def start(self, mode): self.calls.append(("start", mode)); return Identity()
    def start_host(self): self.calls.append(("host",))
    def close(self): self.calls.append(("close",))


def proof(_identity): return runner.ProducerProof(7, 3, Identity.origin, "attempt", 2, Identity.realm, Identity.run_id)
def layout(_identity): return runner.MarkerLayout.create(attempt_id="attempt", generation=2, source_width=1280, source_height=720, roi=(64, 48, 256, 128))


class Viewer:
    def static_frames(self, current_layout):
        return [{"runNonce": 7, "sceneId": 3, "tick": 0, "actionId": 0, "attemptId": "attempt", "generation": 2,
                 "sourceWidth": 1280, "sourceHeight": 720, "roi": [64, 48, 256, 128], "layoutDigest": current_layout.layout_digest} for _ in range(61)]


def test_no_input_rehearsal_starts_lab_and_host_collects_static_then_blocks_only_before_automatic_dispatch():
    run = Run()
    result = runner.LabLifecycleCollector(lab_run=run, viewer=Viewer(), proof_factory=proof, layout_factory=layout).collect(dedicated_desktop=False, fixture_window=False)
    assert run.calls == [("start", "legacy"), ("host",), ("close",)]
    assert result.static["status"] == runner.PASS
    assert result.automatic["status"] == runner.BLOCKED
    assert runner.verify_transcript(result.as_dict(), identity=result.identity)


def test_transcript_digest_rejects_forged_receipt_or_identity():
    result = runner.LabTranscript.create(identity={"runId": "r"}, static={"status": "PASS"}, automatic={"status": "BLOCKED"}, receipts=[]).as_dict()
    assert runner.verify_transcript(result, identity={"runId": "r"})
    result["receipts"].append({"inputId": "forged"})
    assert not runner.verify_transcript(result, identity={"runId": "r"})
