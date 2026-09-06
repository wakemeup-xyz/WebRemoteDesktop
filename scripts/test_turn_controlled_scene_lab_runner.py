import importlib.util
import json
import sys
from pathlib import Path
from urllib.request import Request, urlopen

import pytest

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
                return {"attemptId": "runtime-attempt", "generation": 7, "streamId": "video-track-1", "selectedTurnId": "turn-1", "turnFingerprint": "fingerprint", "turnDigest": "d" * 64, "sourceWidth": 1920, "sourceHeight": 1080}
    adapter.viewer_page = Page()
    assert adapter.viewer_session_identity() == {"attemptId": "runtime-attempt", "generation": 7, "streamId": "video-track-1", "selectedTurnId": "turn-1", "turnFingerprint": "fingerprint", "turnDigest": "d" * 64, "sourceWidth": 1920, "sourceHeight": 1080}


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


def test_marker_roi_is_configured_on_the_live_viewer_before_collecting_static_evidence():
    calls = []
    class Page:
        def evaluate(self, script, value):
            calls.append((script, value))
            return True
    adapter = object.__new__(runner.PlaywrightLabViewerAdapter)
    adapter.viewer_page = Page()
    marker_layout = runner.MarkerLayout.create(attempt_id="attempt", generation=1, source_width=1152, source_height=720, roi=(50, 175, 256, 128))
    adapter.configure_marker_roi(marker_layout)
    assert calls[0][1] == {"x": 50, "y": 175, "width": 256, "height": 128}


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
        def wait_for_controlled_claim(self, input_id):
            return {"inputId": input_id, "status": "claimed"}

    class Producer:
        def prepare_native_action(self, action_id): rows.append(("native", action_id))

    class Broker:
        def reserve(self, *, input_id, action_id): rows.append(("reserve", input_id, action_id))
        def wait_for_receipt(self, input_id): return {"inputId": input_id}

    result = runner.ExecutableLabDriver(lab_run=Run(), viewer=Adapter(), producer=Producer(), broker=Broker(), fixture_id="fixture").run()

    assert result["status"] == runner.PASS
    assert result["failures"] == []
    assert len(result["receipts"]) == 91
    assert result["workload"] == [runner.workload_record(item) for item in runner.exact_workload()]
    assert [row for row in rows if row[0] == "dispatch"] == [
        ("dispatch", f"i-{step.action_id}") for item in runner.exact_workload() for step in runner.work_steps(item)
    ]


def test_workload_expands_drag_transactions_and_keyboard_submission_without_leaving_a_pressed_input():
    drag = next(item for item in runner.exact_workload() if item.kind == "drag")
    text = next(item for item in runner.exact_workload() if item.kind == "text")
    assert [step.phase for step in runner.work_steps(drag)] == ["down", "move", "up"]
    assert [step.phase for step in runner.work_steps(text)] == ["focus-down", "focus-up", "text"]


def test_driver_sends_a_normal_safety_release_when_a_drag_fails_before_up():
    releases = []
    class Adapter:
        def prepare_lab_input(self, step):
            return {"inputId": f"i-{step.action_id}", "leaseId": "lease", "leaseEpoch": 4,
                    "type": "mouse", "action": step.phase, "payload": {}}
        def dispatch_prepared_lab_input(self, reservation): return reservation["inputId"]
        def wait_for_applied_ack(self, input_id): return None
        def wait_for_decoded_visual(self, input_id, action_id): return None
        def dispatch_safety_release(self): releases.append("up")
    class Run:
        def bind_controlled_input(self, **_kwargs): pass
        def wait_for_controlled_claim(self, input_id): return {"inputId": input_id, "status": "claimed"}
    class Producer:
        def prepare_native_action(self, _action_id): pass
    class Broker:
        def reserve(self, **_kwargs): pass
        def wait_for_receipt(self, _input_id): return None
    drag = next(item for item in runner.exact_workload() if item.kind == "drag")
    original = runner.exact_workload
    runner.exact_workload = lambda: (drag,)
    try:
        result = runner.ExecutableLabDriver(lab_run=Run(), viewer=Adapter(), producer=Producer(), broker=Broker(), fixture_id="fixture").run()
    finally:
        runner.exact_workload = original
    assert result["status"] == runner.FAIL
    assert releases == ["up"]


def test_loopback_fixture_receiver_merges_only_a_native_event_with_its_reserved_input_id():
    proof = runner.ProducerProof(7, 3, Identity.origin, "attempt", 2, Identity.realm, Identity.run_id)
    layout = runner.MarkerLayout.create(attempt_id="attempt", generation=2, source_width=1280, source_height=720, roi=(64, 48, 256, 128))
    broker = runner.FixtureBroker(proof, layout)
    broker.reserve(input_id="i-12", action_id=12)
    with runner.LoopbackFixtureReceiver(broker) as receiver:
        body = {"runNonce": "7", "sceneId": 3, "tick": 1, "actionId": 12, "attemptId": "attempt", "generation": 2,
                "realm": Identity.realm, "runId": Identity.run_id, "focused": True,
                "sourceWidth": 1280, "sourceHeight": 720, "roi": [64, 48, 256, 128], "layoutDigest": layout.layout_digest}
        request = Request(receiver.endpoint, method="POST", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        with urlopen(request, timeout=2) as response:
            assert response.status == 202
        assert receiver.wait_for_receipt("i-12", timeout_seconds=.2)["inputId"] == "i-12"


def test_loopback_nonce_accepts_the_canonical_marker_string_for_an_integer_proof_and_rejects_ambiguous_spellings():
    proof = runner.ProducerProof(7, 3, Identity.origin, "attempt", 2, Identity.realm, Identity.run_id)
    layout = runner.MarkerLayout.create(attempt_id="attempt", generation=2, source_width=1280, source_height=720, roi=(64, 48, 256, 128))
    broker = runner.FixtureBroker(proof, layout)
    for action_id, nonce in enumerate(("07", "+7", " 7", "7.0", -1), start=1):
        broker.reserve(input_id=f"i-{action_id}", action_id=action_id)
        event = {"runNonce": nonce, "sceneId": 3, "tick": 1, "actionId": action_id, "attemptId": "attempt", "generation": 2,
                 "realm": Identity.realm, "runId": Identity.run_id, "focused": True,
                 "sourceWidth": 1280, "sourceHeight": 720, "roi": [64, 48, 256, 128], "layoutDigest": layout.layout_digest}
        assert broker.record_native_event(event) is None


def test_five_way_gate_refuses_a_pass_without_the_host_input_adapter_claim_receipt():
    result = runner.aggregate_action_evidence(
        reservation={"inputId": "i-1"},
        ack={"inputId": "i-1", "status": "applied"},
        claim=None,
        receipt={"inputId": "i-1"},
        visual={"inputId": "i-1", "traceStatus": "matched", "rtpTimestamp": 1, "wireTimestamp": 1},
    )
    assert result == {"status": runner.FAIL, "failure": "missing-host-guard-claim"}


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
    adapter._fixture_geometry = {"scroll": {"relX": .5, "relY": .5}, "dragStart": {"relX": .4, "relY": .5},
                                 "dragEnd": {"relX": .6, "relY": .5}, "text": {"relX": .5, "relY": .4}}
    reservation = adapter.prepare_lab_input(runner.work_steps(runner.exact_workload()[0])[0])
    assert adapter.dispatch_prepared_lab_input(reservation) == "i-1"
    assert "Input.prepareLabInput" in calls[0][0]
    assert "Input.dispatchPreparedLabInput" in calls[1][0]


def test_fixture_input_geometry_maps_actual_scroll_drag_and_text_boxes_through_window_to_host_capture():
    adapter = object.__new__(runner.PlaywrightLabViewerAdapter)
    class Page:
        def evaluate(self, _script):
            return {"scroll": {"left": 100, "top": 200, "width": 200, "height": 160},
                    "drag": {"left": 400, "top": 300, "width": 80, "height": 48},
                    "text": {"left": 200, "top": 100, "width": 240, "height": 32},
                    "screenX": 10, "screenY": 30, "outerWidth": 1004, "outerHeight": 824,
                    "innerWidth": 1000, "innerHeight": 800, "screenWidth": 1000, "screenHeight": 800, "dpr": 1}
    adapter.producer_page = Page()
    geometry = adapter.calibrate_fixture_input_geometry(source_width=500, source_height=400)
    assert geometry["scroll"]["sourceX"] == 106
    assert geometry["scroll"]["sourceY"] == 166
    assert geometry["dragStart"]["relX"] < geometry["dragEnd"]["relX"]
    adapter._fixture_geometry = geometry
    focus = adapter._input_spec(runner.work_steps(next(item for item in runner.exact_workload() if item.kind == "text"))[0])
    assert focus["action"] == "down" and focus["payload"]["relX"] == geometry["text"]["relX"]


def test_fixture_input_geometry_rejects_a_dom_box_that_cannot_be_mapped_inside_host_capture():
    adapter = object.__new__(runner.PlaywrightLabViewerAdapter)
    class Page:
        def evaluate(self, _script):
            box = {"left": 999, "top": 999, "width": 20, "height": 20}
            return {"scroll": box, "drag": box, "text": box, "screenX": 0, "screenY": 0,
                    "outerWidth": 1004, "outerHeight": 824, "innerWidth": 1000, "innerHeight": 800,
                    "screenWidth": 1000, "screenHeight": 800, "dpr": 1}
    adapter.producer_page = Page()
    with pytest.raises(RuntimeError, match="outside-window-content"):
        adapter.calibrate_fixture_input_geometry(source_width=500, source_height=400)


def test_viewer_token_can_be_loaded_from_a_named_environment_variable_without_putting_it_in_argv():
    args = type("Args", (), {"viewer_token": None, "viewer_token_env": "WRD_LAB_VIEWER_TOKEN"})()
    assert runner.resolve_viewer_token(args, environ={"WRD_LAB_VIEWER_TOKEN": "token-from-env"}) == "token-from-env"
    assert runner.resolve_viewer_token(args, environ={}) is None


def test_lifecycle_failure_keeps_the_known_admission_contract_error_but_redacts_unknown_exception_text():
    assert runner.lifecycle_failure(RuntimeError("production proof admission was not granted for the observed epoch")) == "lifecycle:RuntimeError:production-proof-admission-epoch-mismatch"


def test_t4_t5_owner_seals_only_after_clear_through_the_host_unix_authority(tmp_path):
    commands = []
    result = type("Result", (), {"returncode": 0})()
    runner.seal_loss_bridge_after_clear(
        manifest_path=tmp_path / "manifest.json", socket_path=tmp_path / "authority.sock",
        raw_bridge_path=tmp_path / "raw.json", cleared_event_path=tmp_path / "cleared.json", seal_path=tmp_path / "seal.json",
        run=lambda command: commands.append(command) or result,
    )
    assert commands[0][2] == "seal-bridge"
    assert "--verifier-fd" not in commands[0] and "--event" in commands[0]
    assert runner.lifecycle_failure(RuntimeError("secret=must-not-persist")) == "lifecycle:RuntimeError"
