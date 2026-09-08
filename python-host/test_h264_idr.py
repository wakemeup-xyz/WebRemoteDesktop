import asyncio
import json
import logging
from unittest.mock import MagicMock

import pytest

import host as host_module

from h264_videotoolbox_encoder import (
    bitstream_contains_idr,
    set_session_gop_size,
    get_session_gop_size,
    libx264_zerolatency_options,
    periodic_idr_due,
    H264VideoToolboxEncoder,
    IDR_WAIT_FRAMES,
)


def test_idr_detects_annexb_type5():
    nal = bytes([0, 0, 0, 1, 0x65, 0, 1, 2])  # nal_ref_idc=3, type=5
    assert bitstream_contains_idr(nal) is True


def test_idr_detects_fu_a_idr():
    # FU-A indicator type 28, start bit, original type 5
    fu = bytes([0, 0, 0, 1, 0x7C, 0x85, 0, 1])
    assert bitstream_contains_idr(fu) is True


def test_non_idr_slice_false():
    nal = bytes([0, 0, 0, 1, 0x41, 0, 1])  # type 1
    assert bitstream_contains_idr(nal) is False


def test_idr_detects_avcc_length_prefixed_type5():
    nal = bytes([0x65, 0, 1, 2])
    avcc = (4).to_bytes(4, "big") + nal
    assert bitstream_contains_idr(avcc) is True


def test_idr_detects_bare_type5_without_start_code():
    assert bitstream_contains_idr(bytes([0x65, 0, 1])) is True


def test_packetize_does_not_staple_sei_with_sps_pps():
    sps = bytes([0x67, 0x42, 0xC0, 0x1E] + [0] * 18)
    pps = bytes([0x68, 0xCE, 0x38, 0x80])
    sei = bytes([0x06] + [0xAB] * 200)
    idr = bytes([0x65] + [0x11] * 40)
    packets = H264VideoToolboxEncoder._packetize([sps, pps, sei, idr])
    types = [p[0] & 0x1F for p in packets]
    assert 6 not in types
    assert types[:2] == [7, 8]
    assert 24 not in types


def test_annexb_p_slice_payload_0x65_is_not_idr():
    """AVCC fallback must not treat Annex-B payload bytes as a length+NAL."""
    # start-code + type1 + fake length=5 + 0x65. Annex-B scan is one P-slice.
    p_slice = bytes([0, 0, 0, 1, 0x41, 0, 0, 0, 5, 0x65, 0, 0, 0])
    assert bitstream_contains_idr(p_slice) is False


def test_set_session_gop_clamps():
    assert set_session_gop_size(20) == 20
    assert get_session_gop_size() == 20
    assert set_session_gop_size(1) == 10
    set_session_gop_size(40)


def test_on_demand_policy_schedules_no_application_periodic_idr_in_a_sixty_second_window():
    assert not any(periodic_idr_due(frame_index, 0) for frame_index in range(1, 1_201))
    assert periodic_idr_due(40, 40) is True


def test_libx264_peak_headroom_overrides_submit_independent_rate_buffer_and_init():
    legacy = libx264_zerolatency_options(3_200_000, 0)
    assert legacy["x264-params"].endswith("vbv-maxrate=3200:vbv-bufsize=320:vbv-init=0.4:nal-hrd=none")

    options = libx264_zerolatency_options(
        3_200_000,
        0,
        preset="superfast",
        vbv_maxrate_bps=4_800_000,
        vbv_bufsize_kbits=1_000,
        vbv_init=1.0,
        force_idr_option=True,
    )

    assert options == {
        "preset": "superfast",
        "tune": "zerolatency",
        "forced-idr": "1",
        "x264-params": (
            "keyint=1201:min-keyint=1201:scenecut=0:bframes=0:"
            "threads=1:sliced-threads=0:slices=1:sync-lookahead=0:"
            "rc-lookahead=0:repeat-headers=1:open-gop=0:intra-refresh=0:"
            "vbv-maxrate=4800:vbv-bufsize=1000:"
            "vbv-init=1:nal-hrd=none"
        ),
    }


def test_encoder_emits_one_five_second_aggregate_with_policy_and_measured_fields(caplog):
    """Encoder observability is bounded and only reports locally measured work."""
    from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy

    policy = resolve_h264_policy(
        MediaSessionIntent("attempt-observe", 7, "relay", 1280, 720, 20, 0),
        "relay-legacy-v1",
    )
    enc = H264VideoToolboxEncoder(policy=policy)
    with caplog.at_level(logging.INFO, logger="h264_videotoolbox_encoder"):
        enc._record_encoder_sample(
            elapsed_ms=12.5,
            encoded_bytes=400,
            idr_bytes=400,
            keyframe_kind="forced",
            now=100.0,
        )
        enc._record_encoder_sample(
            elapsed_ms=7.5,
            encoded_bytes=200,
            idr_bytes=0,
            keyframe_kind=None,
            now=104.9,
        )
        enc._record_encoder_sample(
            elapsed_ms=10.0,
            encoded_bytes=300,
            idr_bytes=0,
            keyframe_kind="periodic",
            now=105.0,
        )

    samples = [record.message for record in caplog.records if record.message.startswith("WRD_ENCODER_SAMPLE ")]
    assert len(samples) == 1
    sample = json.loads(samples[0].removeprefix("WRD_ENCODER_SAMPLE "))
    assert sample["connectionAttemptId"] == "attempt-observe"
    assert sample["generation"] == 7
    assert sample["policyId"] == "relay-legacy-v1"
    assert sample["encode"] == {"count": 3, "avgMs": 10.0, "p95Ms": 12.5, "maxMs": 12.5}
    assert sample["bytes"] == {"total": 900, "idrCount": 1, "idrAvg": 400.0, "idrMax": 400}
    assert sample["keyframes"] == {
        "forced": 1, "periodic": 1, "pli": 0, "initial": 0, "safety": 0,
    }


def test_encoder_discards_partial_aggregate_when_policy_identity_changes(caplog):
    from dataclasses import replace
    from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy

    first = resolve_h264_policy(MediaSessionIntent("attempt-a", 1, "relay", 1280, 720, 20, 0), "relay-legacy-v1")
    second = replace(first, connection_attempt_id="attempt-b", generation=2)
    enc = H264VideoToolboxEncoder(policy=first)
    enc._record_encoder_sample(elapsed_ms=5, encoded_bytes=10, idr_bytes=0, keyframe_kind=None, now=100)
    enc.stage_policy_update(second)
    enc._adopt_pending_policy()
    with caplog.at_level(logging.INFO, logger="h264_videotoolbox_encoder"):
        enc._record_encoder_sample(elapsed_ms=6, encoded_bytes=20, idr_bytes=0, keyframe_kind=None, now=105)
        enc._record_encoder_sample(elapsed_ms=7, encoded_bytes=30, idr_bytes=0, keyframe_kind=None, now=110)
    sample = json.loads(next(record.message.removeprefix("WRD_ENCODER_SAMPLE ") for record in caplog.records if record.message.startswith("WRD_ENCODER_SAMPLE ")))
    assert sample["connectionAttemptId"] == "attempt-b"
    assert sample["generation"] == 2
    assert sample["encode"]["count"] == 2


def test_waited_and_recreated_idr_keep_the_application_request_reason(monkeypatch):
    enc = H264VideoToolboxEncoder()
    p_slice = bytes([0, 0, 0, 1, 0x41, 0])
    idr = bytes([0, 0, 0, 1, 0x65, 0])
    codecs = [FakeCodec([p_slice], repeat=True), FakeCodec([idr])]
    monkeypatch.setattr(H264VideoToolboxEncoder, "_create_codec", lambda self, frame, codec_name: codecs.pop(0))
    list(enc._encode_frame(_fake_frame(), force_keyframe=True))
    # The request arrives while VideoToolbox still waits for an earlier I-frame.
    # It must own the actual delayed/recreated IDR rather than a synthetic log.
    enc.note_keyframe_request("paint-stall", "attempt-a", 2, 9)
    list(enc._encode_frame(_fake_frame(), force_keyframe=True))
    for _ in range(IDR_WAIT_FRAMES):
        list(enc._encode_frame(_fake_frame(), force_keyframe=False))
        if enc.last_requested_keyframe_emitted:
            break
    assert enc.last_requested_keyframe_emitted is True
    assert enc._last_encoded_keyframe_kind == "forced"
    assert enc._last_encoded_keyframe_reason == "paint-stall"


class FakePacket:
    def __init__(self, data):
        self._data = data

    def __bytes__(self):
        return self._data


class FakeCodec:
    def __init__(self, payloads, repeat=False):
        self.width = 16
        self.height = 16
        self._payloads = list(payloads)
        self._repeat = repeat
        self.closed = False

    def encode(self, frame):
        if not self._payloads:
            return []
        payload = self._payloads[0] if self._repeat else self._payloads.pop(0)
        return [FakePacket(payload)]


def _fake_frame():
    frame = MagicMock()
    frame.width = 16
    frame.height = 16
    return frame


def test_force_keyframe_skips_recreate_when_first_encode_has_idr(monkeypatch):
    enc = H264VideoToolboxEncoder()
    idr = bytes([0, 0, 0, 1, 0x65, 0])
    calls = {"create": 0}

    def fake_create(self, frame, codec_name):
        calls["create"] += 1
        return FakeCodec([idr])

    monkeypatch.setattr(H264VideoToolboxEncoder, "_create_codec", fake_create)
    list(enc._encode_frame(_fake_frame(), force_keyframe=True))
    assert calls["create"] == 1
    assert enc.last_force_emitted_idr is True
    assert enc.last_idr_recreated is False


def test_force_keyframe_empty_output_waits_for_delayed_idr(monkeypatch):
    """VideoToolbox delays IDR ~4-6 frames; empty force must not reopen."""
    enc = H264VideoToolboxEncoder()
    idr = bytes([0, 0, 0, 1, 0x65, 0])
    calls = {"create": 0}
    codec = FakeCodec([b"", b"", idr])

    def fake_create(self, frame, codec_name):
        calls["create"] += 1
        return codec

    monkeypatch.setattr(H264VideoToolboxEncoder, "_create_codec", fake_create)
    import av
    first = _fake_frame()
    second = _fake_frame()
    third = _fake_frame()
    list(enc._encode_frame(first, force_keyframe=True))
    assert calls["create"] == 1
    assert enc.last_force_emitted_idr is False
    assert enc.last_idr_recreated is False
    assert first.pict_type == av.video.frame.PictureType.I
    list(enc._encode_frame(second, force_keyframe=False))
    assert calls["create"] == 1
    assert second.pict_type == av.video.frame.PictureType.NONE
    list(enc._encode_frame(third, force_keyframe=False))
    assert calls["create"] == 1
    assert enc.last_force_emitted_idr is True
    assert enc.last_idr_recreated is False


def test_host_force_during_wait_does_not_stuff_another_i(monkeypatch):
    enc = H264VideoToolboxEncoder()
    p_slice = bytes([0, 0, 0, 1, 0x41, 0])
    idr = bytes([0, 0, 0, 1, 0x65, 0])
    codec = FakeCodec([b"", p_slice, idr])
    monkeypatch.setattr(
        H264VideoToolboxEncoder,
        "_create_codec",
        lambda self, frame, codec_name: codec,
    )
    import av
    first = _fake_frame()
    second = _fake_frame()
    third = _fake_frame()
    list(enc._encode_frame(first, force_keyframe=True))
    assert first.pict_type == av.video.frame.PictureType.I
    list(enc._encode_frame(second, force_keyframe=True))
    assert second.pict_type == av.video.frame.PictureType.NONE
    list(enc._encode_frame(third, force_keyframe=False))
    assert enc.last_force_emitted_idr is True


def test_force_keyframe_p_slice_does_not_recreate_immediately(monkeypatch):
    enc = H264VideoToolboxEncoder()
    p_slice = bytes([0, 0, 0, 1, 0x41, 0])
    calls = {"create": 0}

    def fake_create(self, frame, codec_name):
        calls["create"] += 1
        return FakeCodec([p_slice], repeat=True)

    monkeypatch.setattr(H264VideoToolboxEncoder, "_create_codec", fake_create)
    list(enc._encode_frame(_fake_frame(), force_keyframe=True))
    assert calls["create"] == 1
    assert enc.last_idr_recreated is False


def test_force_keyframe_recreates_after_wait_when_no_idr(monkeypatch):
    enc = H264VideoToolboxEncoder()
    p_slice = bytes([0, 0, 0, 1, 0x41, 0])
    idr = bytes([0, 0, 0, 1, 0x65, 0])
    calls = {"create": 0}
    codecs = [FakeCodec([p_slice], repeat=True), FakeCodec([idr])]

    def fake_create(self, frame, codec_name):
        calls["create"] += 1
        return codecs.pop(0)

    monkeypatch.setattr(H264VideoToolboxEncoder, "_create_codec", fake_create)
    list(enc._encode_frame(_fake_frame(), force_keyframe=True))
    assert calls["create"] == 1
    for _ in range(IDR_WAIT_FRAMES - 2):
        list(enc._encode_frame(_fake_frame(), force_keyframe=False))
        assert calls["create"] == 1
    list(enc._encode_frame(_fake_frame(), force_keyframe=False))
    assert calls["create"] == 2
    assert enc.last_force_emitted_idr is True


def test_force_keyframe_recreates_at_most_once(monkeypatch):
    enc = H264VideoToolboxEncoder()
    p_slice = bytes([0, 0, 0, 1, 0x41, 0])
    calls = {"create": 0}
    codecs = [
        FakeCodec([p_slice], repeat=True),
        FakeCodec([p_slice], repeat=True),
        FakeCodec([p_slice], repeat=True),
    ]

    def fake_create(self, frame, codec_name):
        calls["create"] += 1
        return codecs.pop(0)

    monkeypatch.setattr(H264VideoToolboxEncoder, "_create_codec", fake_create)
    list(enc._encode_frame(_fake_frame(), force_keyframe=True))
    for _ in range(IDR_WAIT_FRAMES):
        list(enc._encode_frame(_fake_frame(), force_keyframe=False))
    assert calls["create"] == 2
    assert enc.last_idr_recreated is True
    assert enc.last_force_emitted_idr is False
    list(enc._encode_frame(_fake_frame(), force_keyframe=True))
    for _ in range(IDR_WAIT_FRAMES):
        list(enc._encode_frame(_fake_frame(), force_keyframe=False))
    assert calls["create"] == 2
    assert enc.last_idr_recreated is True


def test_periodic_gop_forces_idr_without_host_keyframe(monkeypatch):
    from dataclasses import replace
    from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy

    enc = H264VideoToolboxEncoder(policy=replace(
        resolve_h264_policy(
            MediaSessionIntent("attempt-1", 1, "direct", 1280, 720, 20, 0),
            "relay-legacy-v1",
        ),
        periodic_idr_frames=3,
    ))
    p_slice = bytes([0, 0, 0, 1, 0x41, 0])
    idr = bytes([0, 0, 0, 1, 0x65, 0])
    calls = {"create": 0}
    codec = FakeCodec([p_slice, p_slice, p_slice, b"", b"", idr])

    def fake_create(self, frame, codec_name):
        calls["create"] += 1
        return codec

    monkeypatch.setattr(H264VideoToolboxEncoder, "_create_codec", fake_create)
    for _ in range(6):
        list(enc._encode_frame(_fake_frame(), force_keyframe=False))
    assert calls["create"] == 1
    assert enc.last_force_emitted_idr is True
    assert enc.last_idr_recreated is False


def test_on_demand_initial_and_safety_idr_are_not_reported_as_periodic(monkeypatch):
    """Codec-start/keyint safety IDRs stay observable without looking 1 Hz."""
    from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy

    policy = resolve_h264_policy(
        MediaSessionIntent("attempt-1", 1, "relay", 1280, 720, 20, 0),
        "relay-on-demand-v1",
    )
    enc = H264VideoToolboxEncoder(policy=policy)
    idr = bytes([0, 0, 0, 1, 0x65, 0])
    monkeypatch.setattr(
        H264VideoToolboxEncoder,
        "_create_codec",
        lambda self, frame, codec_name: FakeCodec([idr], repeat=True),
    )

    list(enc._encode_frame(_fake_frame(), force_keyframe=False))

    assert enc._last_encoded_keyframe_kind == "initial"
    assert enc._last_encoded_keyframe_reason == "initial"

    enc._frames_encoded = 1_201
    list(enc._encode_frame(_fake_frame(), force_keyframe=False))

    assert enc._last_encoded_keyframe_kind == "safety"
    assert enc._last_encoded_keyframe_reason == "safety-net"


def test_false_idr_scan_does_not_skip_software_gop(monkeypatch):
    """Cadence is encode-count, not bitstream scan; false IDRs must not skip I."""
    from dataclasses import replace
    from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy

    enc = H264VideoToolboxEncoder(policy=replace(
        resolve_h264_policy(
            MediaSessionIntent("attempt-1", 1, "direct", 1280, 720, 20, 0),
            "relay-legacy-v1",
        ),
        periodic_idr_frames=3,
    ))
    idr = bytes([0, 0, 0, 1, 0x65, 0])
    codec = FakeCodec([idr], repeat=True)
    monkeypatch.setattr(
        H264VideoToolboxEncoder,
        "_create_codec",
        lambda self, frame, codec_name: codec,
    )
    import av
    frames = [_fake_frame() for _ in range(6)]
    for frame in frames:
        list(enc._encode_frame(frame, force_keyframe=False))
    assert frames[0].pict_type == av.video.frame.PictureType.NONE
    assert frames[3].pict_type == av.video.frame.PictureType.I


def test_p_slice_payload_does_not_reset_gop_counter(monkeypatch):
    from dataclasses import replace
    from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy

    enc = H264VideoToolboxEncoder(policy=replace(
        resolve_h264_policy(
            MediaSessionIntent("attempt-1", 1, "direct", 1280, 720, 20, 0),
            "relay-legacy-v1",
        ),
        periodic_idr_frames=3,
    ))
    p_slice = bytes([0, 0, 0, 1, 0x41, 0, 0, 0, 5, 0x65, 0, 0, 0])
    idr = bytes([0, 0, 0, 1, 0x65, 0])
    codec = FakeCodec([p_slice, p_slice, p_slice, idr])
    monkeypatch.setattr(
        H264VideoToolboxEncoder,
        "_create_codec",
        lambda self, frame, codec_name: codec,
    )
    import av
    frames = [_fake_frame() for _ in range(4)]
    for frame in frames:
        list(enc._encode_frame(frame, force_keyframe=False))
    assert frames[3].pict_type == av.video.frame.PictureType.I
    assert enc.last_force_emitted_idr is True


def test_relay_policy_uses_libx264_and_vbv_cap():
    from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy

    policy = resolve_h264_policy(
        MediaSessionIntent("attempt-1", 1, "relay", 1280, 720, 20, 0),
        "relay-legacy-v1",
    )
    assert policy.codec_name == "libx264"
    assert policy.min_bitrate_bps == 1_800_000
    assert policy.max_bitrate_bps == 2_500_000
    opts = libx264_zerolatency_options(1_800_000, 20)
    assert opts["tune"] == "zerolatency"
    params = opts["x264-params"]
    assert "scenecut=0" in params
    assert "vbv-maxrate=1800" in params
    assert "vbv-bufsize=180" in params
    assert "vbv-init=0.4" in params
    assert "nal-hrd=none" in params
    assert "sliced-threads=0" in params
    assert "slices=1" in params
    assert "threads=1" in params
    assert "forced-idr=1" in params
    assert "open-gop=0" in params
    assert "intra-refresh=0" in params
    enc = H264VideoToolboxEncoder(policy=policy)
    assert enc.codec_name == "libx264"


def test_libx264_options_allow_veryfast_without_changing_frozen_on_demand_vbv_settings():
    options = libx264_zerolatency_options(5_000_000, 0, 200, preset="veryfast")

    assert options["preset"] == "veryfast"
    assert options["tune"] == "zerolatency"
    assert options["x264-params"] == (
        "keyint=1201:min-keyint=1201:scenecut=0:bframes=0:"
        "threads=1:sliced-threads=0:slices=1:sync-lookahead=0:"
        "rc-lookahead=0:repeat-headers=1:open-gop=0:intra-refresh=0:"
        "forced-idr=1:vbv-maxrate=5000:vbv-bufsize=1000:"
        "vbv-init=0.4:nal-hrd=none"
    )


def test_real_codec_creation_submits_policy_preset_and_preserves_frozen_legacy_options():
    """A policy preset must reach the real libx264 codec configuration."""
    from dataclasses import replace

    import av
    import numpy as np
    from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy

    intent = MediaSessionIntent("preset-test", 1, "relay", 1152, 720, 20, 0)
    legacy_policy = resolve_h264_policy(intent, "relay-legacy-v1")
    real_bgra_frame = av.VideoFrame.from_ndarray(
        np.zeros((720, 1152, 4), dtype=np.uint8), format="bgra"
    )
    expected_legacy_options = {
        "preset": "ultrafast",
        "tune": "zerolatency",
        "x264-params": (
            "keyint=20:min-keyint=20:scenecut=0:bframes=0:"
            "threads=1:sliced-threads=0:slices=1:sync-lookahead=0:"
            "rc-lookahead=0:repeat-headers=1:open-gop=0:intra-refresh=0:"
            "forced-idr=1:vbv-maxrate=1800:vbv-bufsize=180:"
            "vbv-init=0.4:nal-hrd=none"
        ),
    }

    legacy_encoder = H264VideoToolboxEncoder(policy=legacy_policy)
    legacy_codec = legacy_encoder._create_codec(real_bgra_frame, "libx264")
    assert legacy_codec.options == expected_legacy_options

    policy = replace(legacy_policy, preset="superfast")
    encoder = H264VideoToolboxEncoder(policy=policy)
    codec = encoder._create_codec(real_bgra_frame, "libx264")

    assert codec.options["preset"] == "superfast"
    record = encoder.codec_creation_records[0]
    assert record.scenario_id == "preset-test"
    assert record.resolution == (1152, 720)
    assert record.creation_index == 1
    assert record.requested_preset == "superfast"
    assert dict(record.submitted_codec_options)["preset"] == "superfast"
    assert record.configured_profile == "Baseline"
    assert record.configured_fps == 20
    assert record.configured_bitrate_bps == 1_800_000
    assert record.generation == 1
    assert record.reopen_reason == "initial"
    with pytest.raises(TypeError):
        record.submitted_codec_options["preset"] = "ultrafast"


def test_real_peak_headroom_codec_uses_ffmpeg_forced_idr_and_aligned_rc_context():
    """The candidate must submit its forced-IDR and VBV caps through accepted fields."""
    from dataclasses import replace

    import av
    import numpy as np
    from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy

    legacy = resolve_h264_policy(
        MediaSessionIntent("peak-headroom", 1, "relay", 1152, 720, 20, 0),
        "relay-legacy-v1",
    )
    policy = replace(
        legacy, periodic_idr_frames=0, target_bitrate_bps=3_200_000,
        max_bitrate_bps=4_800_000, preset="superfast", vbv_maxrate_bps=4_800_000,
        vbv_bufsize_kbits=1_000, vbv_init=1.0, force_idr_option=True,
    )
    frame = av.VideoFrame.from_ndarray(np.zeros((720, 1152, 4), dtype=np.uint8), format="bgra")
    encoder = H264VideoToolboxEncoder(policy=policy)
    nals = list(encoder._encode_frame(frame, True))
    codec = encoder.codec
    record = encoder.codec_creation_records[0]

    assert nals
    assert any((nal[0] & 0x1F) == 5 for nal in nals if nal)
    assert dict(record.submitted_codec_options)["forced-idr"] == "1"
    assert "forced-idr=" not in dict(record.submitted_codec_options)["x264-params"]
    assert record.configured_bitrate_bps == 3_200_000
    assert record.configured_rc_max_rate_bps is None
    assert record.configured_rc_buffer_size_bits is None


def _real_bgra_frame(frame_index, *, width=160, height=96):
    import av
    import numpy as np

    pixels = np.empty((height, width, 4), dtype=np.uint8)
    pixels[:, :, 0] = frame_index % 256
    pixels[:, :, 1] = (frame_index * 3) % 256
    pixels[:, :, 2] = (frame_index * 7) % 256
    pixels[:, :, 3] = 255
    return av.VideoFrame.from_ndarray(pixels, format="bgra")


def _encode_and_decode_real_h264(policy, *, frame_count, force_at=None, request_at=None):
    import av

    encoder = H264VideoToolboxEncoder(policy=policy)
    decoder = av.CodecContext.create("h264", "r")
    decoded = 0
    idr_indices = []
    keyframe_events = []
    forced_nals = []
    recovery_annex_b = []
    for frame_index in range(frame_count):
        if frame_index == request_at:
            encoder.note_keyframe_request(
                "decoder-stalled",
                policy.connection_attempt_id,
                policy.generation,
                9,
            )
        nals = list(encoder._encode_frame(
            _real_bgra_frame(frame_index),
            force_keyframe=frame_index == force_at or frame_index == request_at,
        ))
        if any((nal[0] & 0x1F) == 5 for nal in nals if nal):
            idr_indices.append(frame_index)
            keyframe_events.append((
                frame_index,
                encoder._last_encoded_keyframe_kind,
                encoder._last_encoded_keyframe_reason,
            ))
        if frame_index == force_at:
            forced_nals = nals
        if nals:
            annex_b = b"".join(b"\x00\x00\x00\x01" + nal for nal in nals)
            decoded += len(decoder.decode(av.Packet(annex_b)))
            if force_at is not None and frame_index >= force_at:
                recovery_annex_b.append(annex_b)
    decoded += len(decoder.decode(None))
    recovery_decoded = 0
    if force_at is not None:
        recovery_decoder = av.CodecContext.create("h264", "r")
        for annex_b in recovery_annex_b:
            recovery_decoded += len(recovery_decoder.decode(av.Packet(annex_b)))
        recovery_decoded += len(recovery_decoder.decode(None))
    return (
        idr_indices,
        forced_nals,
        decoded,
        recovery_decoded,
        keyframe_events,
        encoder.last_keyframe_request_ack,
    )


def test_real_pyav_on_demand_policy_removes_legacy_1hz_idr_and_keeps_requested_idr_decodable():
    """Exercise the real libx264 submission, NAL output, and decoder path."""
    from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy

    intent = MediaSessionIntent("real-on-demand", 1, "relay", 160, 96, 20, 0)
    legacy = resolve_h264_policy(intent, "relay-legacy-v1")
    on_demand = resolve_h264_policy(intent, "relay-on-demand-v1")

    legacy_idrs, _, legacy_decoded, _, _, _ = _encode_and_decode_real_h264(
        legacy,
        frame_count=240,
    )
    on_demand_idrs, forced_nals, on_demand_decoded, recovery_decoded, _, request_ack = _encode_and_decode_real_h264(
        on_demand,
        frame_count=400,
        force_at=173,
        request_at=173,
    )

    # Legacy's 20-frame cadence is the measured ~1 Hz pulse at 20 fps.
    assert legacy_idrs[:4] == [0, 20, 40, 60]
    assert len(legacy_idrs) >= 12
    assert legacy_decoded == 240

    # There is no automatic 20-frame cadence under the new production policy.
    # The one recovery request is accepted on the exact frame and is a real
    # IDR NAL, while the complete stream still decodes.
    assert on_demand_idrs == [0, 173]
    assert any((nal[0] & 0x1F) == 5 for nal in forced_nals if nal)
    assert on_demand_decoded == 400
    assert request_ack == ("real-on-demand", 1, 9)
    # Decode from the forced-IDR frame alone, as a decoder that lost prior
    # references would. This is not an end-to-end packet-loss acceptance.
    assert recovery_decoded == 400 - 173


def test_real_pyav_on_demand_policy_uses_the_existing_1201_frame_safety_net():
    from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy

    policy = resolve_h264_policy(
        MediaSessionIntent("real-safety", 1, "relay", 160, 96, 20, 0),
        "relay-on-demand-v1",
    )

    idrs, _, decoded, _, events, _ = _encode_and_decode_real_h264(
        policy,
        frame_count=1_226,
    )

    assert idrs == [0, 1_201]
    assert events == [(0, "initial", "initial"), (1_201, "safety", "safety-net")]
    assert decoded == 1_226


def test_real_codec_creation_rejects_unknown_preset_before_opening_codec(monkeypatch):
    """Invalid policy data must fail before PyAV is allowed to allocate a codec."""
    from dataclasses import replace

    import av
    import h264_videotoolbox_encoder as encoder_module
    import numpy as np
    from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy

    class UnexpectedCodecContext:
        @staticmethod
        def create(*_args, **_kwargs):
            raise AssertionError("codec creation must not run for an invalid preset")

    policy = replace(
        resolve_h264_policy(
            MediaSessionIntent("invalid-preset", 1, "relay", 1152, 720, 20, 0),
            "relay-legacy-v1",
        ),
        preset="medium",
    )
    frame = av.VideoFrame.from_ndarray(
        np.zeros((720, 1152, 4), dtype=np.uint8), format="bgra"
    )
    monkeypatch.setattr(encoder_module.av, "CodecContext", UnexpectedCodecContext)

    with pytest.raises(ValueError, match="unsupported libx264 preset"):
        H264VideoToolboxEncoder(policy=policy)._create_codec(frame, "libx264")


def test_encoder_does_not_change_codec_when_legacy_gop_changes():
    """Codec comes from the session policy rather than the mutable GOP setting."""
    from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy

    policy = resolve_h264_policy(
        MediaSessionIntent("attempt-1", 1, "relay", 1280, 720, 20, 0),
        "relay-legacy-v1",
    )
    enc = H264VideoToolboxEncoder(policy=policy)
    set_session_gop_size(80)
    try:
        assert enc.codec_name == "libx264"
        assert enc.gop_size == policy.periodic_idr_frames
    finally:
        set_session_gop_size(40)


def test_open_libx264_bitrate_update_reports_reopen_required():
    from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy

    policy = resolve_h264_policy(
        MediaSessionIntent("attempt-1", 1, "relay", 1280, 720, 20, 0),
        "relay-legacy-v1",
    )
    enc = H264VideoToolboxEncoder(policy=policy)
    enc.codec = type("Codec", (), {"width": 1280, "height": 720})()

    result = enc.set_target_bitrate(9_000_000)

    assert result == {
        "requested": 9_000_000,
        "clamped": 2_500_000,
        "effective": 0,
        "applied": False,
        "applyMode": "reopen-required",
        "reopenRequired": True,
    }


def test_encoder_captures_attempt_policy_and_ignores_later_provider_attempt(monkeypatch):
    from h264_encoder_policy import H264SessionPolicyProvider, MediaSessionIntent

    provider = H264SessionPolicyProvider()
    provider.bind_attempt("attempt-old")
    provider.publish(
        MediaSessionIntent("attempt-old", 1, "relay", 1280, 720, 20, 0),
        "relay-legacy-v1",
    )
    enc = H264VideoToolboxEncoder(policy=provider.current_policy())
    p_slice = bytes([0, 0, 0, 1, 0x41, 0])
    created = []
    monkeypatch.setattr(
        H264VideoToolboxEncoder,
        "_create_codec",
        lambda self, frame, codec_name: (created.append(codec_name) or FakeCodec([p_slice], repeat=True)),
    )
    list(enc._encode_frame(_fake_frame(), force_keyframe=False))

    provider.bind_attempt("attempt-new")
    provider.publish(
        MediaSessionIntent("attempt-new", 2, "direct", 1280, 720, 20, 0),
        "relay-legacy-v1",
    )
    list(enc._encode_frame(_fake_frame(), force_keyframe=False))

    assert enc.codec_name == "libx264"
    assert created == ["libx264"]


def test_sender_factory_keeps_attempt_policy_when_encoder_is_created_after_new_attempt(monkeypatch):
    """Delayed creation/rebuild resolves the sender's frozen policy, never global state."""
    from h264_encoder_policy import H264SessionPolicyProvider, MediaSessionIntent

    provider_a = H264SessionPolicyProvider()
    provider_a.bind_attempt("attempt-a")
    policy_a = provider_a.publish(
        MediaSessionIntent("attempt-a", 1, "relay", 1280, 720, 20, 0),
        "relay-legacy-v1",
    ).policy
    provider_b = H264SessionPolicyProvider()
    provider_b.bind_attempt("attempt-b")
    provider_b.publish(
        MediaSessionIntent("attempt-b", 2, "direct", 1920, 1080, 20, 0),
        "relay-balanced-v2",
    )
    # Attempt B publishes before A's sender first asks aiortc to create an
    # encoder. The patched sender boundary is the actual factory call path.
    sender = type("Sender", (), {"_wrd_h264_policy": policy_a})()
    codec = type("Codec", (), {"mimeType": "video/H264"})()

    async def delayed_factory(_sender, _codec):
        return host_module._patched_get_encoder(_codec)

    monkeypatch.setattr(host_module, "_original_next_encoded_frame", delayed_factory)
    loop = asyncio.new_event_loop()
    try:
        encoder = loop.run_until_complete(host_module._patched_next_encoded_frame(sender, codec))
        rebuilt = loop.run_until_complete(host_module._patched_next_encoded_frame(sender, codec))
    finally:
        loop.close()

    assert encoder._policy is policy_a
    assert encoder._policy.target_bitrate_bps == 1_800_000
    assert rebuilt._policy is policy_a


def test_staged_policy_update_reopens_once_at_the_next_frame_boundary(monkeypatch):
    from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy

    legacy = resolve_h264_policy(
        MediaSessionIntent("attempt-1", 1, "relay", 1280, 720, 20, 0),
        "relay-legacy-v1",
    )
    balanced = resolve_h264_policy(
        MediaSessionIntent("attempt-1", 1, "relay", 1920, 1080, 20, 4_000_000),
        "relay-balanced-v2",
    )
    enc = H264VideoToolboxEncoder(policy=legacy)
    p_slice = bytes([0, 0, 0, 1, 0x41, 0])
    opened = []

    def fake_create(self, frame, codec_name):
        opened.append((codec_name, self._policy.target_bitrate_bps))
        return FakeCodec([p_slice], repeat=True)

    monkeypatch.setattr(H264VideoToolboxEncoder, "_create_codec", fake_create)
    list(enc._encode_frame(_fake_frame(), force_keyframe=False))
    assert enc.stage_policy_update(balanced) is True
    list(enc._encode_frame(_fake_frame(), force_keyframe=False))
    list(enc._encode_frame(_fake_frame(), force_keyframe=False))

    assert opened == [("libx264", 1_800_000), ("libx264", 4_000_000)]


def test_staged_1080p_resolution_policy_reopens_next_small_frame_at_its_2_5mbps_target(monkeypatch):
    """A resolution policy applies as one next-frame codec reopen, not an old-rate setter."""
    from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy

    policy_720 = resolve_h264_policy(
        MediaSessionIntent("attempt-1", 1, "relay", 1280, 720, 20, 1_800_000),
        "relay-on-demand-v1",
    )
    policy_1080 = resolve_h264_policy(
        MediaSessionIntent("attempt-1", 1, "relay", 1920, 1080, 20, 1_800_000, 1),
        "relay-on-demand-v1",
    )
    enc = H264VideoToolboxEncoder(policy=policy_720)
    p_slice = bytes([0, 0, 0, 1, 0x41, 0])
    opened = []

    def fake_create(self, frame, codec_name):
        opened.append({
            "size": (frame.width, frame.height),
            "bitrate": self._policy.target_bitrate_bps,
            "policy": self._policy.policy_id,
        })
        return FakeCodec([p_slice], repeat=True)

    monkeypatch.setattr(H264VideoToolboxEncoder, "_create_codec", fake_create)
    list(enc._encode_frame(_fake_frame(), force_keyframe=False))
    assert enc.stage_policy_update(policy_1080) is True
    list(enc._encode_frame(_fake_frame(), force_keyframe=False))

    assert opened == [
        {"size": (16, 16), "bitrate": 1_800_000, "policy": "relay-on-demand-v1"},
        {"size": (16, 16), "bitrate": 2_500_000, "policy": "relay-on-demand-v1"},
    ]


def test_encoder_adopts_published_relay_policy(monkeypatch):
    from h264_encoder_policy import H264SessionPolicyProvider, MediaSessionIntent

    provider = H264SessionPolicyProvider()
    provider.bind_attempt("attempt-1")
    provider.publish(
        MediaSessionIntent("attempt-1", 1, "relay", 1280, 720, 20, 0),
        "relay-legacy-v1",
    )
    enc = H264VideoToolboxEncoder(policy=provider.current_policy())
    assert enc.codec_name == "libx264"
    created = []

    def fake_create(self, frame, codec_name):
        created.append(codec_name)
        return FakeCodec([bytes([0, 0, 0, 1, 0x65, 0])])

    monkeypatch.setattr(H264VideoToolboxEncoder, "_create_codec", fake_create)
    list(enc._encode_frame(_fake_frame(), force_keyframe=True))
    assert enc.gop_size == 20
    assert enc.codec_name == "libx264"
    assert created[-1] == "libx264"


def test_libx264_wait_does_not_recreate_codec(monkeypatch):
    """VT wait-window recreate is for delayed IDR; libx264 must keep one codec."""
    from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy

    policy = resolve_h264_policy(
        MediaSessionIntent("attempt-1", 1, "relay", 1280, 720, 20, 0),
        "relay-legacy-v1",
    )
    enc = H264VideoToolboxEncoder(policy=policy)
    assert enc.codec_name == "libx264"
    p_slice = bytes([0, 0, 0, 1, 0x41, 0])
    calls = {"create": 0}

    def fake_create(self, frame, codec_name):
        calls["create"] += 1
        return FakeCodec([p_slice], repeat=True)

    monkeypatch.setattr(H264VideoToolboxEncoder, "_create_codec", fake_create)
    list(enc._encode_frame(_fake_frame(), force_keyframe=True))
    for _ in range(IDR_WAIT_FRAMES + 4):
        list(enc._encode_frame(_fake_frame(), force_keyframe=False))
    assert calls["create"] == 1
    assert enc.last_idr_recreated is False


def test_request_decoder_refresh_reopens_same_size(monkeypatch):
    from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy

    policy = resolve_h264_policy(
        MediaSessionIntent("attempt-1", 1, "relay", 1280, 720, 20, 0),
        "relay-legacy-v1",
    )
    enc = H264VideoToolboxEncoder(policy=policy)
    p_slice = bytes([0, 0, 0, 1, 0x41, 0])
    calls = {"create": 0}

    def fake_create(self, frame, codec_name):
        calls["create"] += 1
        return FakeCodec([p_slice], repeat=True)

    monkeypatch.setattr(H264VideoToolboxEncoder, "_create_codec", fake_create)
    list(enc._encode_frame(_fake_frame(), force_keyframe=True))
    assert calls["create"] == 1
    assert enc.request_decoder_refresh() is True
    assert enc.codec is None
    list(enc._encode_frame(_fake_frame(), force_keyframe=False))
    assert calls["create"] == 2
    assert enc.request_decoder_refresh() is True
    assert enc.request_decoder_refresh() is False


def test_application_keyframe_request_tracks_reason_and_generation_until_an_idr_is_emitted(monkeypatch):
    enc = H264VideoToolboxEncoder()
    p_slice = bytes([0, 0, 0, 1, 0x41, 0])
    idr = bytes([0, 0, 0, 1, 0x65, 0])
    codec = FakeCodec([p_slice, idr])
    monkeypatch.setattr(
        H264VideoToolboxEncoder,
        "_create_codec",
        lambda self, frame, codec_name: codec,
    )

    enc.note_keyframe_request("decoder-stalled", "attempt-7", 7, 11)
    assert enc.last_requested_keyframe_emitted is False
    list(enc._encode_frame(_fake_frame(), force_keyframe=True))
    assert enc.last_requested_keyframe_emitted is False
    list(enc._encode_frame(_fake_frame(), force_keyframe=False))
    assert enc.last_keyframe_request_ack == ("attempt-7", 7, 11)
    assert enc.keyframe_reason_counts["decoder-stalled"] == 1
    assert enc.last_keyframe_request_generation == ("attempt-7", 7)


def test_periodic_or_old_force_idr_cannot_ack_a_newer_application_request(monkeypatch):
    enc = H264VideoToolboxEncoder()
    p_slice = bytes([0, 0, 0, 1, 0x41, 0])
    idr = bytes([0, 0, 0, 1, 0x65, 0])
    codec = FakeCodec([idr, p_slice, p_slice, idr, idr])
    monkeypatch.setattr(H264VideoToolboxEncoder, "_create_codec", lambda self, frame, codec_name: codec)

    enc.note_keyframe_request("decoder-stalled", "attempt-1", 1, 1)
    list(enc._encode_frame(_fake_frame(), force_keyframe=False))
    assert enc.last_keyframe_request_ack is None

    list(enc._encode_frame(_fake_frame(), force_keyframe=True))
    enc.note_keyframe_request("decoder-stalled", "attempt-2", 2, 2)
    # The second force arrives while VideoToolbox still awaits attempt-1's
    # IDR. It must not transfer attempt-2's token to that old submission.
    list(enc._encode_frame(_fake_frame(), force_keyframe=True))
    assert enc.last_keyframe_request_ack is None
    list(enc._encode_frame(_fake_frame(), force_keyframe=False))
    assert enc.last_keyframe_request_ack == ("attempt-1", 1, 1)
    list(enc._encode_frame(_fake_frame(), force_keyframe=True))
    assert enc.last_keyframe_request_ack == ("attempt-2", 2, 2)
