from __future__ import annotations

import importlib.util
import struct
import sys
from pathlib import Path

import pytest


def _module():
    path = Path(__file__).with_name("turn_wire.py")
    spec = importlib.util.spec_from_file_location("turn_wire", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _attr(kind: int, value: bytes) -> bytes:
    return struct.pack("!HH", kind, len(value)) + value + b"\0" * ((-len(value)) % 4)


def _stun(kind: int, txid: bytes, attrs: bytes = b"") -> bytes:
    return struct.pack("!HHI", kind, len(attrs), 0x2112A442) + txid + attrs


def _rtp(*, sequence: int = 7, ssrc: int = 0x10203040, payload_type: int = 96) -> bytes:
    return bytes((0x80, payload_type)) + struct.pack("!HII", sequence, 1234, ssrc) + b"frame"


def _channel(channel: int, body: bytes, *, pad: bool = True) -> bytes:
    return struct.pack("!HH", channel, len(body)) + body + (b"\0" * ((-len(body)) % 4) if pad else b"")


def test_allocate_success_exposes_relayed_address_and_transaction_id():
    wire = _module()
    txid = b"allocate-txi"
    message = wire.parse_stun(_stun(0x0103, txid, _attr(0x0016, b"\0\x01\x9f\x02\x01\x02\x03\x04")))
    assert message.message_type == 0x0103
    assert message.transaction_id == txid
    assert message.attribute(0x0016) == b"\0\x01\x9f\x02\x01\x02\x03\x04"


def test_stun_rejects_trailing_or_malformed_attribute_bytes():
    wire = _module()
    with pytest.raises(wire.WireProtocolError):
        wire.parse_stun(_stun(0x0103, b"allocate-txi", b"\0\x16\0\x08\x01"))


def test_channel_data_video_classifier_accepts_only_exact_video_rtp():
    wire = _module()
    frame = _channel(0x4001, _rtp(sequence=99))
    result = wire.parse_channel_data_video(frame, channel_number=0x4001, payload_type=96, ssrc=0x10203040)
    assert result.sequence == 99
    assert result.payload == _rtp(sequence=99)


@pytest.mark.parametrize("packet", [
    _stun(0x0103, b"allocate-txi"),
    b"\x16" + b"\0" * 31,  # DTLS record content type
    _channel(0x4001, bytes((0x80, 200)) + b"\0" * 14),  # RTCP-like, not dynamic RTP PT 96
    _channel(0x4002, _rtp()),
    _channel(0x4001, _rtp(ssrc=9)),
])
def test_non_video_or_wrong_channel_packets_are_not_loss_eligible(packet: bytes):
    wire = _module()
    assert wire.parse_channel_data_video(packet, channel_number=0x4001, payload_type=96, ssrc=0x10203040) is None
