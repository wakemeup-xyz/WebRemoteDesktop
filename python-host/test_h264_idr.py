from unittest.mock import MagicMock

from h264_videotoolbox_encoder import (
    bitstream_contains_idr,
    set_session_gop_size,
    get_session_gop_size,
    codec_name_for_gop,
    min_bitrate_bps,
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
    stap = next(p for p in packets if (p[0] & 0x1F) == 24)
    pos = 1
    units = []
    while pos + 2 <= len(stap):
        length = int.from_bytes(stap[pos:pos + 2], "big")
        pos += 2
        unit = stap[pos:pos + length]
        pos += length
        if unit:
            units.append(unit[0] & 0x1F)
    assert 6 not in units
    assert 7 in units and 8 in units


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
    enc = H264VideoToolboxEncoder()
    enc.gop_size = 3
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
    enc = H264VideoToolboxEncoder()
    enc.gop_size = 3
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
    enc = H264VideoToolboxEncoder()
    enc.gop_size = 3
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


def test_relay_gop_uses_libx264_and_vbv_cap():
    assert codec_name_for_gop(20) == "libx264"
    assert codec_name_for_gop(40) == "h264_videotoolbox"
    assert min_bitrate_bps(20, 1280, 720) == 1_800_000
    assert min_bitrate_bps(20, 1152, 720) == 1_800_000
    assert min_bitrate_bps(20, 1920, 1080) == 2_500_000
    assert min_bitrate_bps(40, 1280, 720) == 500_000
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
    set_session_gop_size(20)
    try:
        enc = H264VideoToolboxEncoder()
        assert enc.codec_name == "libx264"
    finally:
        set_session_gop_size(40)


def test_encoder_adopts_relay_gop_from_session(monkeypatch):
    set_session_gop_size(40)
    enc = H264VideoToolboxEncoder()
    assert enc.codec_name == "h264_videotoolbox"
    created = []

    def fake_create(self, frame, codec_name):
        created.append(codec_name)
        return FakeCodec([bytes([0, 0, 0, 1, 0x65, 0])])

    monkeypatch.setattr(H264VideoToolboxEncoder, "_create_codec", fake_create)
    set_session_gop_size(20)
    try:
        list(enc._encode_frame(_fake_frame(), force_keyframe=True))
        assert enc.gop_size == 20
        assert enc.codec_name == "libx264"
        assert created[-1] == "libx264"
    finally:
        set_session_gop_size(40)


def test_libx264_wait_does_not_recreate_codec(monkeypatch):
    """VT wait-window recreate is for delayed IDR; libx264 must keep one codec."""
    set_session_gop_size(20)
    try:
        enc = H264VideoToolboxEncoder()
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
    finally:
        set_session_gop_size(40)
