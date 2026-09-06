import importlib.util
import sys
from pathlib import Path


SCRIPT = Path(__file__).with_name("turn_controlled_scene.py")
SPEC = importlib.util.spec_from_file_location("turn_controlled_scene", SCRIPT)
scene = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = scene
SPEC.loader.exec_module(scene)


def proof(**changes):
    values = dict(run_nonce=0x0102030405060708, scene_id=7, origin="http://127.0.0.1:49152",
                  attempt_id="attempt-a", generation=3)
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
        ack_samples=[{"inputId": "i-1", "status": "applied", "attemptId": "attempt-a", "generation": 3, "atMs": 10}],
        producer_samples=[{"inputId": "i-1", "runNonce": 0x0102030405060708, "actionId": 42, "focused": True, "attemptId": "attempt-a", "generation": 3}],
        visual_samples=[{"runNonce": 0x0102030405060708, "sceneId": 7, "actionId": 42, "attemptId": "attempt-a", "generation": 3, "rtpAligned": True, "rtpTimestamp": 90000, "wireTimestamp": 90000, "captureSeq": 8, "atMs": 30}],
    )
    assert result.status == scene.PASS
    assert result.execution_mode == scene.AUTOMATIC_ISOLATED
    assert result.latencies["sendToAckMs"] == [10]
    assert result.latencies["sendToVisualMs"] == [30]


def test_ack_nonce_attempt_focus_or_rtp_gaps_fail_closed_without_sending_input():
    invalid = scene.evaluate_scene_result(
        proof(), execution_mode=scene.AUTOMATIC_ISOLATED, input_ids=["i-1"],
        ack_samples=[{"inputId": "i-1", "status": "applied", "attemptId": "attempt-a", "generation": 3}],
        producer_samples=[{"inputId": "i-1", "runNonce": 99, "actionId": 1, "focused": False, "attemptId": "attempt-a", "generation": 3}],
        visual_samples=[{"runNonce": 99, "sceneId": 7, "actionId": 1, "attemptId": "old", "generation": 2, "rtpAligned": False}],
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
        producer_samples=[{"inputId": "i-1", "runNonce": 0x0102030405060708, "actionId": 1, "focused": True, "attemptId": "attempt-a", "generation": 3}],
        visual_samples=[{"runNonce": 0x0102030405060708, "sceneId": 7, "actionId": 1, "attemptId": "attempt-a", "generation": 3, "rtpAligned": True, "rtpTimestamp": 1, "wireTimestamp": 1, "captureSeq": 1}],
    )
    assert result.status == scene.NOT_RUN
    assert "producer-local-is-not-remote-input" in result.failures


def test_operator_remote_without_independent_control_endpoint_is_blocked():
    result = scene.run_controlled_scenes(object(), object(), proof(), execution_mode=scene.OPERATOR_REMOTE,
                                         operator_endpoint=None)
    assert result.status == scene.BLOCKED
    assert "independent-operator-endpoint-required" in result.failures


def test_marker_identity_without_the_t3_wire_rtp_join_is_unaligned_not_a_pass():
    result = scene.evaluate_scene_result(
        proof(), execution_mode=scene.AUTOMATIC_ISOLATED, input_ids=["i-1"],
        ack_samples=[{"inputId": "i-1", "status": "applied", "attemptId": "attempt-a", "generation": 3}],
        producer_samples=[{"inputId": "i-1", "runNonce": 0x0102030405060708, "actionId": 3, "focused": True, "attemptId": "attempt-a", "generation": 3}],
        visual_samples=[{"runNonce": 0x0102030405060708, "sceneId": 7, "actionId": 3, "attemptId": "attempt-a", "generation": 3, "rtpAligned": True}],
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
