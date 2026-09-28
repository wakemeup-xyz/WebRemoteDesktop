from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy
from h264_videotoolbox_encoder import H264VideoToolboxEncoder


def _peak_policy():
    return resolve_h264_policy(
        MediaSessionIntent("attempt-peak", 1, "relay", 1152, 720, 20, 0),
        "relay-peak-sliced-v1",
    )


def test_fixed_peak_rate_storm_is_bounded_to_noop():
    encoder = H264VideoToolboxEncoder(policy=_peak_policy())
    encoder.codec = type("Codec", (), {"bit_rate": 3_200_000})()
    encoder.note_bitrate_request("media-profile")

    results = [encoder.set_target_bitrate(value) for value in range(400_000, 1_500_000, 10_000)]

    assert len(results) > 50
    assert all(result["applyMode"] == "no-op" for result in results)
    assert all(result["reopenRequired"] is False for result in results)
    assert encoder.bitrate_source_counts == {"media-profile": 1}


def test_same_generation_fixed_policy_does_not_stage_a_reopen():
    encoder = H264VideoToolboxEncoder(policy=_peak_policy())
    assert encoder.stage_policy_update(_peak_policy()) is False
    assert encoder._pending_policy is None


def test_target_bitrate_property_records_aiortc_remb_source():
    encoder = H264VideoToolboxEncoder(policy=_peak_policy())
    encoder.codec = type("Codec", (), {"bit_rate": 3_200_000})()

    encoder.target_bitrate = 700_000

    assert encoder.bitrate_source_counts == {"aiortc-remb": 1}
