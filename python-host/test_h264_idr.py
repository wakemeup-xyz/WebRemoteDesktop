from unittest.mock import MagicMock

from h264_videotoolbox_encoder import (
    bitstream_contains_idr,
    set_session_gop_size,
    get_session_gop_size,
    H264VideoToolboxEncoder,
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
    def __init__(self, payloads):
        self.width = 16
        self.height = 16
        self._payloads = list(payloads)
        self.closed = False

    def encode(self, frame):
        if not self._payloads:
            return []
        return [FakePacket(self._payloads.pop(0))]


def _fake_frame():
    frame = MagicMock()
    frame.width = 16
    frame.height = 16
    return frame


def test_force_keyframe_recreates_when_first_encode_has_no_idr(monkeypatch):
    enc = H264VideoToolboxEncoder()
    p_slice = bytes([0, 0, 0, 1, 0x41, 0])
    idr = bytes([0, 0, 0, 1, 0x65, 0])
    calls = {"create": 0}
    codecs = [FakeCodec([p_slice]), FakeCodec([idr])]

    def fake_create(self, frame, codec_name):
        calls["create"] += 1
        return codecs.pop(0)

    monkeypatch.setattr(H264VideoToolboxEncoder, "_create_codec", fake_create)
    list(enc._encode_frame(_fake_frame(), force_keyframe=True))
    assert calls["create"] == 2
    assert enc.last_force_emitted_idr is True
    assert enc.last_idr_recreated is True


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


def test_force_keyframe_recreates_at_most_once(monkeypatch):
    enc = H264VideoToolboxEncoder()
    p_slice = bytes([0, 0, 0, 1, 0x41, 0])
    calls = {"create": 0}
    codecs = [FakeCodec([p_slice]), FakeCodec([p_slice]), FakeCodec([p_slice])]

    def fake_create(self, frame, codec_name):
        calls["create"] += 1
        return codecs.pop(0)

    monkeypatch.setattr(H264VideoToolboxEncoder, "_create_codec", fake_create)
    list(enc._encode_frame(_fake_frame(), force_keyframe=True))
    assert calls["create"] == 2
    assert enc.last_force_emitted_idr is False
    assert enc.last_idr_recreated is True
