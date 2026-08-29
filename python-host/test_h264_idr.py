from unittest.mock import MagicMock

from h264_videotoolbox_encoder import (
    bitstream_contains_idr,
    set_session_gop_size,
    get_session_gop_size,
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
