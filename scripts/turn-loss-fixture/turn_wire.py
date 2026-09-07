"""Strict, side-effect-free TURN-over-UDP framing helpers for the Lab gateway."""
from __future__ import annotations

from dataclasses import dataclass
import struct


COOKIE = 0x2112A442


class WireProtocolError(ValueError):
    pass


@dataclass(frozen=True)
class StunMessage:
    message_type: int
    transaction_id: bytes
    attributes: tuple[tuple[int, bytes], ...]

    def attribute(self, kind: int) -> bytes | None:
        values = [value for code, value in self.attributes if code == kind]
        return values[-1] if values else None


@dataclass(frozen=True)
class VideoRtp:
    sequence: int
    timestamp: int
    ssrc: int
    payload_type: int
    payload: bytes


def parse_stun(packet: bytes) -> StunMessage:
    if not isinstance(packet, bytes) or len(packet) < 20:
        raise WireProtocolError("short STUN message")
    message_type, length, cookie = struct.unpack("!HHI", packet[:8])
    if message_type & 0xC000 or cookie != COOKIE or length + 20 != len(packet):
        raise WireProtocolError("invalid STUN framing")
    cursor, values = 20, []
    while cursor < len(packet):
        if cursor + 4 > len(packet):
            raise WireProtocolError("truncated STUN attribute")
        code, size = struct.unpack("!HH", packet[cursor:cursor + 4]); cursor += 4
        if cursor + size > len(packet):
            raise WireProtocolError("truncated STUN attribute value")
        values.append((code, packet[cursor:cursor + size]))
        cursor += size + ((-size) % 4)
        if cursor > len(packet):
            raise WireProtocolError("truncated STUN attribute padding")
    return StunMessage(message_type, packet[8:20], tuple(values))


def parse_channel_data(packet: bytes) -> tuple[int, bytes] | None:
    if not isinstance(packet, bytes) or len(packet) < 4 or packet[0] >> 6 != 1:
        return None
    channel, length = struct.unpack("!HH", packet[:4])
    padding = (-length) % 4
    if not 0x4000 <= channel <= 0x7FFF or len(packet) not in {4 + length, 4 + length + padding}:
        return None
    if len(packet) == 4 + length + padding and packet[4 + length:] != b"\0" * padding:
        return None
    return channel, packet[4:4 + length]


def parse_channel_data_video(packet: bytes, *, channel_number: int, payload_type: int, ssrc: int) -> VideoRtp | None:
    parsed = parse_channel_data(packet)
    if parsed is None or parsed[0] != channel_number:
        return None
    payload = parsed[1]
    if len(payload) < 12 or payload[0] >> 6 != 2:
        return None
    csrc_count = payload[0] & 0x0F
    if len(payload) < 12 + csrc_count * 4:
        return None
    actual_payload_type = payload[1] & 0x7F
    sequence, timestamp, actual_ssrc = struct.unpack("!HII", payload[2:12])
    if actual_payload_type != payload_type or actual_ssrc != ssrc:
        return None
    return VideoRtp(sequence, timestamp, actual_ssrc, actual_payload_type, payload)
