import asyncio
import json
import logging
from unittest.mock import MagicMock

import host as host_module

from h264_videotoolbox_encoder import (
    bitstream_contains_idr,
    set_session_gop_size,
    get_session_gop_size,
    libx264_zerolatency_options,
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
    assert sample["keyframes"] == {"forced": 1, "periodic": 1, "pli": 0}


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
