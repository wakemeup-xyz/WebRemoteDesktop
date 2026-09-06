import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).with_name("turn_controlled_scene_runtime.py")
SPEC = importlib.util.spec_from_file_location("turn_controlled_scene_runtime", SCRIPT)
runtime = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runtime
SPEC.loader.exec_module(runtime)


def proof():
    return runtime.ProducerProof(7, 3, "http://127.0.0.1:49999", "attempt", 2, "lab-run", "run-1")


def layout():
    return runtime.MarkerLayout.create(attempt_id="attempt", generation=2, source_width=1280, source_height=720, roi=(64, 48, 256, 128))


def frame(*, tick=0, action_id=0):
    result = {"runNonce": 7, "sceneId": 3, "tick": tick, "actionId": action_id, "attemptId": "attempt", "generation": 2,
              "sourceWidth": 1280, "sourceHeight": 720, "roi": [64, 48, 256, 128], "layoutDigest": layout().layout_digest}
    return result


def test_exact_workload_has_60s_static_then_scroll_10_drags_and_20_independent_text_samples():
    rows = [runtime.workload_record(item) for item in runtime.exact_workload()]
    assert [row["kind"] for row in rows].count("scroll") == 1
    assert [row["kind"] for row in rows].count("drag") == 10
    assert [row["kind"] for row in rows].count("text") == 20
    assert runtime.workload_failures(rows) == []
    assert runtime.workload_failures(rows[:-1]) == ["controlled-workload-count"]


def test_static_text_requires_a_full_frozen_60_second_marker_record_and_is_independent_of_input():
    good = [frame() for _ in range(61)]
    assert runtime.static_text_evidence(proof(), layout(), good)["status"] == runtime.PASS
    assert runtime.static_text_evidence(proof(), layout(), good[:-1])["status"] == runtime.NOT_RUN
    changed = list(good); changed[-1] = frame(tick=1, action_id=1)
    assert runtime.static_text_evidence(proof(), layout(), changed)["status"] == runtime.FAIL


def test_fixture_broker_adds_only_reserved_input_id_to_a_matching_native_producer_event():
    broker = runtime.FixtureBroker(proof(), layout()); broker.reserve(input_id="i-1", action_id=12)
    native = {**frame(tick=1, action_id=12), "realm": "lab-run", "runId": "run-1", "focused": True}
    assert broker.record_native_event(native)["inputId"] == "i-1"
    assert broker.receipt_for("i-1")["actionId"] == 12
    broker.reserve(input_id="i-2", action_id=13)
    assert broker.record_native_event({**native, "actionId": 13, "generation": 1}) is None


def test_automatic_scene_is_blocked_without_a_dedicated_fixture_desktop_and_never_falls_back_to_local_input():
    context = type("Context", (), {"origin": "http://127.0.0.1:49999", "realm": "lab-run", "run_id": "run-1"})()
    result = runtime.run_automatic_scene(proof=proof(), verified_context=context, layout=layout(), dedicated_desktop=False, fixture_window=False)
    assert result["status"] == runtime.BLOCKED
    assert result["failures"] == ["dedicated-desktop-and-fixture-window-required"]


def test_action_aggregate_requires_reservation_ack_broker_receipt_and_matched_rtp_visual():
    rows = dict(reservation={"inputId": "i"}, ack={"inputId": "i", "status": "applied"}, receipt={"inputId": "i"}, visual={"inputId": "i", "traceStatus": "matched", "rtpTimestamp": 1, "wireTimestamp": 1})
    assert runtime.aggregate_action_evidence(**rows)["status"] == runtime.PASS
    for key in rows:
        broken = dict(rows); broken[key] = None
        assert runtime.aggregate_action_evidence(**broken)["status"] == runtime.FAIL
