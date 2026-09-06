import importlib.util
import json
import sys
from pathlib import Path
from urllib.request import Request, urlopen

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
    def transcript_verifier(self): return b"captured-lab-secret"


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
    assert runner.verify_transcript(result.as_dict(), identity=result.identity, verifier=b"captured-lab-secret")


def test_transcript_signature_rejects_a_receipt_forgery_even_when_attacker_recomputes_an_unkeyed_digest():
    result = runner.LabTranscript.create(verifier=b"captured", identity={"runId": "r"}, static={"status": "PASS"}, automatic={"status": "BLOCKED"}, receipts=[]).as_dict()
    assert runner.verify_transcript(result, identity={"runId": "r"}, verifier=b"captured")
    result["receipts"].append({"inputId": "forged"})
    # An unkeyed recomputation is irrelevant: validation requires the captured
    # run verifier, which is not present in the durable artifact.
    result["signature"] = __import__("hashlib").sha256(__import__("json").dumps({key: result[key] for key in ("identity", "static", "automatic", "receipts")}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    assert not runner.verify_transcript(result, identity={"runId": "r"}, verifier=b"captured")


def test_headless_producer_adapter_requires_an_mss_visible_fixture_window_before_static_or_input_evidence():
    adapter = object.__new__(runner.PlaywrightLabViewerAdapter)
    assert adapter.producer_window_precondition() == (False, "producer-window-is-not-visible-to-host-capture")


def test_viewer_session_identity_rejects_pending_attempt_zero_generation_or_unknown_resolution_without_hardcoded_defaults():
    adapter = object.__new__(runner.PlaywrightLabViewerAdapter)
    class Page:
        def evaluate(self, _script): return {"attemptId": "", "generation": 0, "sourceWidth": 0, "sourceHeight": 720}
    adapter.viewer_page = Page()
    assert adapter.viewer_session_identity() is None


def test_viewer_session_identity_uses_the_live_webrtc_connection_sequence_for_generation():
    adapter = object.__new__(runner.PlaywrightLabViewerAdapter)
    class Page:
        def evaluate(self, _script):
            return {"attemptId": "runtime-attempt", "generation": 7, "sourceWidth": 1920, "sourceHeight": 1080}
    adapter.viewer_page = Page()
    assert adapter.viewer_session_identity() == {"attemptId": "runtime-attempt", "generation": 7, "sourceWidth": 1920, "sourceHeight": 1080}


def test_marker_roi_calibration_uses_canvas_content_inside_the_visible_fixture_border():
    adapter = object.__new__(runner.PlaywrightLabViewerAdapter)
    class Page:
        def evaluate(self, _script):
            return {"left": 32, "top": 155.1171875, "width": 272, "height": 144,
                    "contentWidth": 256, "contentHeight": 128, "borderLeft": 8, "borderTop": 8,
                    "screenX": 22, "screenY": 25, "outerWidth": 1442, "outerHeight": 1006,
                    "innerWidth": 1440, "innerHeight": 960, "screenWidth": 1440, "screenHeight": 960, "dpr": 1}
    adapter.producer_page = Page()
    assert adapter.calibrate_marker_roi(source_width=1152, source_height=720) == (50, 175, 256, 128)


def test_executable_driver_runs_each_declared_work_item_through_prepare_bind_dispatch_and_four_way_evidence():
    rows = []

    class Adapter:
        def prepare_lab_input(self, item):
            return {"inputId": f"i-{item.action_id}", "leaseId": "lease", "leaseEpoch": 4,
                    "type": "mouse", "action": "wheel", "payload": {"relX": .5, "relY": .5}}
        def dispatch_prepared_lab_input(self, reservation):
            rows.append(("dispatch", reservation["inputId"]))
            return reservation["inputId"]
        def wait_for_applied_ack(self, input_id):
            return {"inputId": input_id, "status": "applied"}
        def wait_for_decoded_visual(self, input_id, action_id):
            return {"inputId": input_id, "traceStatus": "matched", "rtpTimestamp": action_id, "wireTimestamp": action_id}

    class Run:
        def bind_controlled_input(self, **kwargs):
            rows.append(("bind", kwargs["input_id"], kwargs["action"]))

    class Producer:
        def prepare_native_action(self, action_id): rows.append(("native", action_id))

    class Broker:
        def reserve(self, *, input_id, action_id): rows.append(("reserve", input_id, action_id))
        def wait_for_receipt(self, input_id): return {"inputId": input_id}

    result = runner.ExecutableLabDriver(lab_run=Run(), viewer=Adapter(), producer=Producer(), broker=Broker(), fixture_id="fixture").run()

    assert result["status"] == runner.PASS
    assert result["failures"] == []
    assert len(result["receipts"]) == 31
    assert result["workload"] == [runner.workload_record(item) for item in runner.exact_workload()]
    assert [row for row in rows if row[0] == "dispatch"] == [("dispatch", f"i-{item.action_id}") for item in runner.exact_workload()]


def test_loopback_fixture_receiver_merges_only_a_native_event_with_its_reserved_input_id():
    proof = runner.ProducerProof(7, 3, Identity.origin, "attempt", 2, Identity.realm, Identity.run_id)
    layout = runner.MarkerLayout.create(attempt_id="attempt", generation=2, source_width=1280, source_height=720, roi=(64, 48, 256, 128))
    broker = runner.FixtureBroker(proof, layout)
    broker.reserve(input_id="i-12", action_id=12)
    with runner.LoopbackFixtureReceiver(broker) as receiver:
        body = {"runNonce": 7, "sceneId": 3, "tick": 1, "actionId": 12, "attemptId": "attempt", "generation": 2,
                "realm": Identity.realm, "runId": Identity.run_id, "focused": True,
                "sourceWidth": 1280, "sourceHeight": 720, "roi": [64, 48, 256, 128], "layoutDigest": layout.layout_digest}
        request = Request(receiver.endpoint, method="POST", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        with urlopen(request, timeout=2) as response:
            assert response.status == 202
        assert receiver.wait_for_receipt("i-12", timeout_seconds=.2)["inputId"] == "i-12"


def test_playwright_adapter_prepares_then_dispatches_the_same_page_owned_reservation_through_input_api():
    calls = []
    class Page:
        def evaluate(self, script, value=None):
            calls.append((script, value))
            if "prepareLabInput" in script:
                return {"inputId": "i-1", "leaseId": "lease", "leaseEpoch": 2,
                        "type": "mouse", "action": "wheel", "payload": {"relX": .5, "relY": .5, "deltaY": 80}}
            if "dispatchPreparedLabInput" in script:
                return "i-1"
            return True
    adapter = object.__new__(runner.PlaywrightLabViewerAdapter)
    adapter.viewer_page = Page()
    reservation = adapter.prepare_lab_input(runner.exact_workload()[0])
    assert adapter.dispatch_prepared_lab_input(reservation) == "i-1"
    assert "Input.prepareLabInput" in calls[0][0]
    assert "Input.dispatchPreparedLabInput" in calls[1][0]


def test_viewer_token_can_be_loaded_from_a_named_environment_variable_without_putting_it_in_argv():
    args = type("Args", (), {"viewer_token": None, "viewer_token_env": "WRD_LAB_VIEWER_TOKEN"})()
    assert runner.resolve_viewer_token(args, environ={"WRD_LAB_VIEWER_TOKEN": "token-from-env"}) == "token-from-env"
    assert runner.resolve_viewer_token(args, environ={}) is None


def test_lifecycle_failure_keeps_the_known_admission_contract_error_but_redacts_unknown_exception_text():
    assert runner.lifecycle_failure(RuntimeError("production proof admission was not granted for the observed epoch")) == "lifecycle:RuntimeError:production-proof-admission-epoch-mismatch"
    assert runner.lifecycle_failure(RuntimeError("secret=must-not-persist")) == "lifecycle:RuntimeError"
