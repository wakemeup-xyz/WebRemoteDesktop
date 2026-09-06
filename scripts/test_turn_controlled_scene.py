import importlib.util
import sys
from pathlib import Path

from turn_lab_input_guard import LabInputGuard


SCRIPT = Path(__file__).with_name("turn_controlled_scene.py")
SPEC = importlib.util.spec_from_file_location("turn_controlled_scene", SCRIPT)
scene = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = scene
SPEC.loader.exec_module(scene)


def proof(**changes):
    values = dict(run_nonce=0x0102030405060708, scene_id=7, origin="http://127.0.0.1:49152",
                  attempt_id="attempt-a", generation=3, realm="lab-test", run_id="run-test")
    values.update(changes)
    return scene.ProducerProof(**values)


def test_marker_round_trip_is_a_fixed_32_by_16_dual_crc_payload():
    encoded = scene.encode_marker(proof(), tick=9, action_id=42)
    decoded = scene.decode_marker(encoded, roi=(0, 0, 256, 128))
    assert decoded.status == scene.PASS
    assert decoded.payload.run_nonce == 0x0102030405060708
    assert decoded.payload.scene_id == 7
    assert decoded.payload.tick == 9
    assert decoded.payload.action_id == 42


def test_marker_rejects_crc_damage_and_does_not_vote_across_frames():
    first = scene.encode_marker(proof(), tick=1, action_id=1)
    second = scene.encode_marker(proof(), tick=2, action_id=2)
    scene.flip_payload_bit(first, copy_index=0, bit_index=191)
    scene.flip_payload_bit(first, copy_index=1, bit_index=191)
    assert scene.decode_marker(first, roi=(0, 0, 256, 128)).status == scene.FAIL
    assert scene.decode_marker_pair(first, second, roi=(0, 0, 256, 128)).status == scene.UNALIGNED


def test_marker_rejects_single_frame_copy_disagreement_and_scale_mismatch():
    encoded = scene.encode_marker(proof(), tick=9, action_id=42)
    scene.flip_payload_bit(encoded, copy_index=1, bit_index=20)
    assert scene.decode_marker(encoded, roi=(0, 0, 256, 128)).status == scene.UNALIGNED
    clean = scene.encode_marker(proof(), tick=9, action_id=42)
    assert scene.decode_marker(clean, roi=(0, 0, 255, 128)).status == scene.FAIL


def test_static_scene_marker_is_frozen_and_only_an_explicit_action_ticks_it():
    producer = scene.ControlledProducer(proof())
    first = producer.render_marker()
    assert producer.render_marker() == first
    producer.apply_action("text", action_id=11)
    changed = producer.render_marker()
    assert changed != first
    assert producer.render_marker() == changed


def test_remote_scene_requires_complete_same_identity_causal_chain():
    result = scene.evaluate_scene_result(
        proof(), execution_mode=scene.AUTOMATIC_ISOLATED,
        input_ids=["i-1"],
        send_samples=[{"inputId": "i-1", "viewerClockMs": 0, "attemptId": "attempt-a", "generation": 3, "streamId": "video"}],
        ack_samples=[{"inputId": "i-1", "status": "applied", "attemptId": "attempt-a", "generation": 3, "streamId": "video", "viewerClockMs": 10}],
        producer_samples=[{"inputId": "i-1", "runNonce": 0x0102030405060708, "sceneId": 7, "actionId": 42, "tick": 1, "focused": True, "attemptId": "attempt-a", "generation": 3, "streamId": "video"}],
        visual_samples=[{"marker": {"runNonce": 0x0102030405060708, "sceneId": 7, "actionId": 42, "tick": 1}, "attemptId": "attempt-a", "generation": 3, "streamId": "video", "rtpTimestamp": 90000, "wireTimestamp": 90000, "captureSeq": 8, "rtpOrigin": 1, "traceStatus": "matched", "viewerClockMs": 30}],
    )
    assert result.status == scene.PASS
    assert result.execution_mode == scene.AUTOMATIC_ISOLATED
    assert result.latencies["sendToAckMs"] == [10]
    assert result.latencies["sendToVisualMs"] == [30]


def test_ack_nonce_attempt_focus_or_rtp_gaps_fail_closed_without_sending_input():
    invalid = scene.evaluate_scene_result(
        proof(), execution_mode=scene.AUTOMATIC_ISOLATED, input_ids=["i-1"],
        send_samples=[{"inputId": "i-1", "viewerClockMs": 0, "attemptId": "attempt-a", "generation": 3, "streamId": "video"}],
        ack_samples=[{"inputId": "i-1", "status": "applied", "attemptId": "attempt-a", "generation": 3, "streamId": "video", "viewerClockMs": 10}],
        producer_samples=[{"inputId": "i-1", "runNonce": 99, "sceneId": 7, "actionId": 1, "tick": 1, "focused": False, "attemptId": "attempt-a", "generation": 3, "streamId": "video"}],
        visual_samples=[{"marker": {"runNonce": 99, "sceneId": 7, "actionId": 1, "tick": 1}, "attemptId": "old", "generation": 2, "streamId": "video", "rtpTimestamp": 0, "wireTimestamp": 0, "captureSeq": 1, "rtpOrigin": 0, "traceStatus": "matched", "viewerClockMs": 20}],
    )
    assert invalid.status == scene.FAIL
    assert {"producer-focus", "nonce-mismatch", "attempt-generation-mismatch", "wire-rtp-unaligned"}.issubset(invalid.failures)

    class Viewer:
        sent = []
        def send_input(self, *_args, **_kwargs):
            self.sent.append(True)

    viewer = Viewer()
    blocked = scene.run_controlled_scenes(viewer, object(), proof(attempt_id=""))
    assert blocked.status == scene.BLOCKED
    assert viewer.sent == []


def test_producer_local_cannot_satisfy_remote_input_gate_or_clear_marker_failure():
    result = scene.evaluate_scene_result(
        proof(), execution_mode=scene.PRODUCER_LOCAL, input_ids=["i-1"],
        ack_samples=[{"inputId": "i-1", "status": "applied", "attemptId": "attempt-a", "generation": 3}],
        producer_samples=[{"inputId": "i-1", "runNonce": 0x0102030405060708, "sceneId": 7, "actionId": 1, "focused": True, "attemptId": "attempt-a", "generation": 3}],
        visual_samples=[{"runNonce": 0x0102030405060708, "sceneId": 7, "actionId": 1, "attemptId": "attempt-a", "generation": 3, "rtpAligned": True, "rtpTimestamp": 1, "wireTimestamp": 1, "captureSeq": 1}],
    )
    assert result.status == scene.NOT_RUN
    assert "producer-local-is-not-remote-input" in result.failures


def test_operator_remote_without_independent_control_endpoint_is_blocked():
    result = scene.run_controlled_scenes(object(), object(), proof(), execution_mode=scene.OPERATOR_REMOTE,
                                         operator_endpoint=None)
    assert result.status == scene.BLOCKED
    assert "independent-operator-endpoint-required" in result.failures


def test_producer_proof_must_match_the_verified_lab_origin_realm_and_run_identity():
    context = type("Context", (), {"origin": "http://127.0.0.1:49152", "realm": "lab-test", "run_id": "run-test"})()
    assert scene.proof_matches_verified_lab_context(proof(), context)
    for field, value in (("origin", "http://127.0.0.1:49153"), ("realm", "lab-other"), ("run_id", "other-run")):
        changed = dict(run_nonce=0x0102030405060708, scene_id=7, origin="http://127.0.0.1:49152", attempt_id="attempt-a", generation=3, realm="lab-test", run_id="run-test")
        changed[field] = value
        assert not scene.proof_matches_verified_lab_context(scene.ProducerProof(**changed), context)


def test_marker_identity_without_the_t3_wire_rtp_join_is_unaligned_not_a_pass():
    result = scene.evaluate_scene_result(
        proof(), execution_mode=scene.AUTOMATIC_ISOLATED, input_ids=["i-1"],
        send_samples=[{"inputId": "i-1", "viewerClockMs": 0, "attemptId": "attempt-a", "generation": 3, "streamId": "video"}],
        ack_samples=[{"inputId": "i-1", "status": "applied", "attemptId": "attempt-a", "generation": 3, "streamId": "video", "viewerClockMs": 10}],
        producer_samples=[{"inputId": "i-1", "runNonce": 0x0102030405060708, "sceneId": 7, "actionId": 3, "tick": 1, "focused": True, "attemptId": "attempt-a", "generation": 3, "streamId": "video"}],
        visual_samples=[{"marker": {"runNonce": 0x0102030405060708, "sceneId": 7, "actionId": 3, "tick": 1}, "attemptId": "attempt-a", "generation": 3, "streamId": "video", "rtpTimestamp": 0, "wireTimestamp": 0, "captureSeq": 1, "rtpOrigin": 0, "traceStatus": "matched", "viewerClockMs": 20}],
    )
    assert result.status == scene.UNALIGNED
    assert "wire-rtp-unaligned" in result.failures


def test_real_h264_marker_roundtrip_covers_720p_and_1080p_or_reports_dependency_blocker():
    result = scene.h264_marker_roundtrip(proof(), resolutions=[(1280, 720), (1920, 1080)])
    assert result["status"] in {scene.PASS, scene.BLOCKED}
    if result["status"] == scene.PASS:
        assert result["decodedResolutions"] == [[1280, 720], [1920, 1080]]
    else:
        assert result["reason"]


def test_marker_decodes_from_a_declared_nonzero_full_frame_roi_and_rejects_oob_stride_or_scale():
    marker = scene.encode_marker(proof(), tick=5, action_id=9)
    width, height, stride, x, y = 1280, 720, 1296, 64, 48
    pixels = bytearray([scene.BLACK]) * (stride * height)
    for row in range(128):
        pixels[(y + row) * stride + x:(y + row) * stride + x + 256] = marker[row * 256:(row + 1) * 256]
    frame = scene.FrameBuffer(pixels, width=width, height=height, stride=stride)
    assert scene.decode_marker(frame, roi=(x, y, 256, 128)).status == scene.PASS
    assert scene.decode_marker(frame, roi=(width - 128, y, 256, 128)).status == scene.FAIL
    assert scene.decode_marker(frame, roi=(x, y, 255, 128)).status == scene.FAIL
    assert scene.decode_marker(scene.FrameBuffer(pixels[:-1], width=width, height=height, stride=stride), roi=(x, y, 256, 128)).status == scene.FAIL


def test_h264_roundtrip_uses_full_frames_nonzero_roi_and_reports_corruption_and_scale_vectors():
    result = scene.h264_marker_roundtrip(proof(), resolutions=[(1280, 720), (1920, 1080)])
    assert result["status"] in {scene.PASS, scene.BLOCKED}
    if result["status"] == scene.PASS:
        assert result["decodedResolutions"] == [[1280, 720], [1920, 1080]]
        assert result["roi"] != [0, 0, 256, 128]
        assert result["corruptionStatus"] in {scene.FAIL, scene.UNALIGNED}
        assert result["scaleStatus"] == scene.FAIL
        assert result["corruptionFailure"] in {"copies-disagree", "crc", "grey-zone"}
        assert result["scaleFailure"]


def test_scene_evaluator_rejects_duplicates_bad_types_and_incomplete_marker_or_t3_join():
    result = scene.evaluate_scene_result(
        proof(), execution_mode=scene.AUTOMATIC_ISOLATED, input_ids=["i", "i"],
        send_samples="not-a-list", ack_samples=[], producer_samples=[], visual_samples=[],
    )
    assert result.status == scene.FAIL
    assert {"duplicate-input-id", "invalid-send-samples"}.issubset(result.failures)

    incomplete = scene.evaluate_scene_result(
        proof(), execution_mode=scene.AUTOMATIC_ISOLATED, input_ids=["i"],
        send_samples=[{"inputId": "i", "viewerClockMs": 10, "attemptId": "attempt-a", "generation": 3, "streamId": "video"}],
        ack_samples=[{"inputId": "i", "status": "applied", "viewerClockMs": 20, "attemptId": "attempt-a", "generation": 3, "streamId": "video"}],
        producer_samples=[{"inputId": "i", "runNonce": 0x0102030405060708, "sceneId": 7, "actionId": 4, "tick": 1, "focused": True, "attemptId": "attempt-a", "generation": 3, "streamId": "video"}],
        visual_samples=[{"marker": {"runNonce": 0x0102030405060708, "sceneId": 7, "tick": 1, "actionId": 4}, "viewerClockMs": 30, "attemptId": "attempt-a", "generation": 3, "streamId": "video", "rtpTimestamp": 0, "wireTimestamp": 0, "captureSeq": 1, "rtpOrigin": 0, "traceStatus": "matched"}],
    )
    assert incomplete.status == scene.UNALIGNED
    assert "wire-rtp-unaligned" in incomplete.failures


def test_scene_evaluator_fails_closed_for_unhashable_or_non_numeric_evidence_values():
    result = scene.evaluate_scene_result(
        proof(), execution_mode=scene.AUTOMATIC_ISOLATED, input_ids=["i"],
        send_samples=[{"inputId": "i", "viewerClockMs": 10, "attemptId": "attempt-a", "generation": 3, "streamId": "video"}],
        ack_samples=[{"inputId": "i", "status": "applied", "viewerClockMs": 20, "attemptId": "attempt-a", "generation": 3, "streamId": "video"}],
        producer_samples=[{"inputId": "i", "runNonce": [], "sceneId": 7, "actionId": 4, "tick": 1, "focused": True, "attemptId": "attempt-a", "generation": 3, "streamId": "video"}],
        visual_samples=[{"marker": {"runNonce": 0x0102030405060708, "sceneId": 7, "tick": 1, "actionId": 4}, "viewerClockMs": 30, "attemptId": "attempt-a", "generation": 3, "streamId": "video", "rtpTimestamp": 1, "wireTimestamp": 1, "captureSeq": 1, "rtpOrigin": 1, "traceStatus": "matched"}],
    )
    assert result.status == scene.FAIL
    assert "invalid-producer-nonce" in result.failures


def test_scene_evaluator_uses_viewer_clock_deltas_and_rejects_conflicting_actions():
    good = scene.evaluate_scene_result(
        proof(), execution_mode=scene.AUTOMATIC_ISOLATED, input_ids=["i"],
        send_samples=[{"inputId": "i", "viewerClockMs": 100, "attemptId": "attempt-a", "generation": 3, "streamId": "video"}],
        ack_samples=[{"inputId": "i", "status": "applied", "viewerClockMs": 125, "attemptId": "attempt-a", "generation": 3, "streamId": "video"}],
        producer_samples=[{"inputId": "i", "runNonce": 0x0102030405060708, "sceneId": 7, "actionId": 9, "tick": 2, "focused": True, "attemptId": "attempt-a", "generation": 3, "streamId": "video"}],
        visual_samples=[{"marker": {"runNonce": 0x0102030405060708, "sceneId": 7, "tick": 2, "actionId": 9}, "viewerClockMs": 150, "attemptId": "attempt-a", "generation": 3, "streamId": "video", "rtpTimestamp": 200, "wireTimestamp": 200, "captureSeq": 2, "rtpOrigin": 10, "traceStatus": "matched"}],
    )
    assert good.status == scene.PASS
    assert good.latencies == {"sendToAckMs": [25.0], "sendToVisualMs": [50.0]}
    conflicting = scene.evaluate_scene_result(
        proof(), execution_mode=scene.AUTOMATIC_ISOLATED, input_ids=["i"],
        send_samples=[{"inputId": "i", "viewerClockMs": 100, "attemptId": "attempt-a", "generation": 3, "streamId": "video"}],
        ack_samples=[{"inputId": "i", "status": "applied", "viewerClockMs": 125, "attemptId": "attempt-a", "generation": 3, "streamId": "video"}],
        producer_samples=[{"inputId": "i", "runNonce": 0x0102030405060708, "sceneId": 7, "actionId": 9, "tick": 2, "focused": True, "attemptId": "attempt-a", "generation": 3, "streamId": "video"}],
        visual_samples=[{"marker": {"runNonce": 0x0102030405060708, "sceneId": 7, "tick": 2, "actionId": 9}, "viewerClockMs": 150, "attemptId": "attempt-a", "generation": 3, "streamId": "video", "rtpTimestamp": 200, "wireTimestamp": 200, "captureSeq": 2, "rtpOrigin": 10, "traceStatus": "matched"}, {"marker": {"runNonce": 0x0102030405060708, "sceneId": 7, "tick": 3, "actionId": 9}, "viewerClockMs": 160, "attemptId": "attempt-a", "generation": 3, "streamId": "video", "rtpTimestamp": 201, "wireTimestamp": 201, "captureSeq": 3, "rtpOrigin": 10, "traceStatus": "matched"}],
    )
    assert conflicting.status == scene.FAIL
    assert "conflicting-action-id" in conflicting.failures


def test_orchestration_uses_one_viewer_send_then_waits_for_host_boundary_ack_without_os_input():
    class Viewer:
        sends = 0
        def send_input(self, action, **_kwargs):
            self.sends += 1
            return {"inputId": action["inputId"], "viewerClockMs": 10, "attemptId": "attempt-a", "generation": 3, "streamId": "video"}
        def wait_for_applied_ack(self, input_id):
            return {"inputId": input_id, "status": "applied", "viewerClockMs": 20, "attemptId": "attempt-a", "generation": 3, "streamId": "video"}
        def decoded_visual(self, input_id):
            return {"marker": {"runNonce": 0x0102030405060708, "sceneId": 7, "tick": 1, "actionId": 1}, "viewerClockMs": 30, "attemptId": "attempt-a", "generation": 3, "streamId": "video", "rtpTimestamp": 88, "wireTimestamp": 88, "captureSeq": 2, "rtpOrigin": 1, "traceStatus": "matched"}
    class Producer:
        def event_for(self, input_id):
            return {"inputId": input_id, "runNonce": 0x0102030405060708, "sceneId": 7, "actionId": 1, "tick": 1, "focused": True, "attemptId": "attempt-a", "generation": 3, "streamId": "video"}
    guard = LabInputGuard(
        expected_lease_id="lease", expected_proof_token="proof", expected_fixture_id="fixture",
        desktop_proof=lambda: {"leaseId": "lease", "proofToken": "proof", "fixtureId": "fixture", "isolated": True, "foreground": True, "fixtureWindow": True},
        input_handler=lambda action: {"inputId": action["inputId"], "status": "applied", "viewerClockMs": 20, "attemptId": "attempt-a", "generation": 3, "streamId": "video"},
    )
    # The Host installs this boundary around its existing InputAdapter.  The
    # scene runner must never invoke it a second time after Viewer send.
    guard.bind_controlled_input({"inputId": "i", "leaseId": "lease", "proofToken": "proof", "fixtureId": "fixture"})
    guard.install_at_lab_host(object())
    viewer = Viewer()
    result = scene.run_controlled_scenes(viewer, Producer(), proof(), guard=guard, actions=[{"inputId": "i", "actionId": 1, "leaseId": "lease", "proofToken": "proof", "fixtureId": "fixture"}])
    assert result.status == scene.PASS
    assert viewer.sends == 1
    assert result.driver_generated
    assert result.as_dict()["producerProof"]["origin"] == "http://127.0.0.1:49152"


def test_automatic_orchestration_rejects_an_arbitrary_guard_object():
    result = scene.run_controlled_scenes(object(), object(), proof(), guard=object(), actions=[{"inputId": "i", "actionId": 1}])
    assert result.status == scene.BLOCKED
    assert "lab-input-guard-required" in result.failures


def test_automatic_orchestration_never_sends_an_unbound_declared_input_id():
    class Viewer:
        sends = 0
        def send_input(self, *_args, **_kwargs): self.sends += 1
    guard = LabInputGuard(
        expected_lease_id="lease", expected_proof_token="proof", expected_fixture_id="fixture",
        desktop_proof=lambda: {"leaseId": "lease", "proofToken": "proof", "fixtureId": "fixture", "isolated": True, "foreground": True, "fixtureWindow": True},
        input_handler=lambda _action: None,
    )
    guard.install_at_lab_host(object())
    viewer = Viewer()
    result = scene.run_controlled_scenes(viewer, object(), proof(), guard=guard,
                                         actions=[{"inputId": "unbound", "actionId": 1, "leaseId": "lease", "proofToken": "proof", "fixtureId": "fixture"}])
    assert result.status == scene.FAIL
    assert viewer.sends == 0


def test_controlled_producer_records_immutable_input_bound_event_and_freezes_for_sixty_seconds():
    producer = scene.ControlledProducer(proof(), clock=lambda: 0)
    marker = producer.render_marker()
    assert producer.assert_frozen_for(60_000, sample_every_ms=1000) == marker
    event = producer.apply_action("text", action_id=4, input_id="i")
    assert event.input_id == "i"
    assert event.action_id == 4
    with __import__("pytest").raises(Exception):
        event.action_id = 5
