"""Fail-closed aiortc private-API observer for real RTP timestamps.

It observes the existing media call path only.  It never changes packet bytes,
packet ordering, or the sender's error handling.
"""

from __future__ import annotations

import asyncio
import inspect
from dataclasses import dataclass
from typing import Iterable

from media_stage_metrics import FrameTraceRegistry


EXPECTED_AIORCTC_VERSION = "1.14.0"
EXPECTED_NEXT_SIGNATURE = "(self, codec: aiortc.rtcrtpparameters.RTCRtpCodecParameters) -> Optional[aiortc.rtcrtpsender.RTCEncodedFrame]"
EXPECTED_SEND_SIGNATURE = "(self, data: bytes) -> None"


def parse_rtp_timestamp(data: bytes) -> int | None:
    """Read a real RTP header without mutating or decoding its payload."""
    if not isinstance(data, (bytes, bytearray, memoryview)) or len(data) < 12:
        return None
    raw = bytes(data)
    if raw[0] >> 6 != 2 or 192 <= raw[1] <= 223:  # RTCP packet type range
        return None
    csrc_count = raw[0] & 0x0F
    offset = 12 + csrc_count * 4
    if len(raw) < offset:
        return None
    if raw[0] & 0x10:
        if len(raw) < offset + 4:
            return None
        extension_words = int.from_bytes(raw[offset + 2:offset + 4], "big")
        offset += 4 + extension_words * 4
    padding = raw[-1] if raw[0] & 0x20 else 0
    if offset >= len(raw) or padding > len(raw) - offset:
        return None
    return int.from_bytes(raw[4:8], "big")


def aiortc_observer_compatibility(*, version: str, next_signature: str, send_signature: str) -> tuple[bool, str]:
    if version != EXPECTED_AIORCTC_VERSION:
        return False, "aiortc-version-mismatch"
    if next_signature != EXPECTED_NEXT_SIGNATURE:
        return False, "next-encoded-frame-signature-mismatch"
    if send_signature != EXPECTED_SEND_SIGNATURE:
        return False, "send-rtp-signature-mismatch"
    return True, "ok"


@dataclass
class _Pending:
    registry: FrameTraceRegistry
    key: object
    ssrc: int
    stream_scope: tuple[str, int, str]


class RtpFrameObserver:
    def __init__(self, registry: FrameTraceRegistry | None = None, *, rtx_payload_types: Iterable[int] = ()) -> None:
        self.registry = registry
        self.rtx_payload_types = {int(value) for value in rtx_payload_types}
        self._pending_by_task: dict[asyncio.Task, _Pending] = {}
        self.enabled = True
        self.unmatched_count = 0
        self.origin_mismatch_count = 0
        self.zero_origin_count = 0
        self.ignored_rtcp_count = 0
        self.ignored_empty_count = 0
        self.ignored_rtx_count = 0
        self._origin_by_stream: dict[tuple[str, int, str, int], int] = {}

    def observe_encoded_frame(self, sender, *, encoder_timestamp: int, ssrc: int | None = None) -> bool:
        if not self.enabled:
            return False
        context = getattr(sender, "_wrd_frame_trace_context", None)
        registry = getattr(context, "registry", None) or self.registry
        if registry is None:
            self.unmatched_count += 1
            return False
        key = registry.find_by_encoder_timestamp(
            int(encoder_timestamp),
            attempt_id=getattr(context, "attempt_id", None),
            generation=getattr(context, "generation", None),
            stream_id=getattr(context, "stream_id", None),
        )
        task = asyncio.current_task()
        if key is None or task is None:
            self.unmatched_count += 1
            return False
        rtx_payload_type = getattr(sender, "_RTCRtpSender__rtx_payload_type", None)
        if isinstance(rtx_payload_type, int) and 0 <= rtx_payload_type <= 127:
            self.rtx_payload_types.add(rtx_payload_type)
        self._pending_by_task[task] = _Pending(
            registry=registry, key=key,
            ssrc=int(ssrc if ssrc is not None else getattr(sender, "_ssrc", 0)),
            stream_scope=(str(key.attempt_id), int(key.generation), str(key.stream_id)),
        )
        return True

    def observe_outgoing_rtp(self, data: bytes, *, ssrc: int | None = None) -> bool:
        if not self.enabled:
            return False
        task = asyncio.current_task()
        pending = self._pending_by_task.get(task) if task is not None else None
        raw = bytes(data) if isinstance(data, (bytes, bytearray, memoryview)) else b""
        payload_type = raw[1] & 0x7F if len(raw) >= 2 else -1
        if len(raw) >= 2 and raw[0] >> 6 == 2 and 192 <= raw[1] <= 223:
            self.ignored_rtcp_count += 1
            return False
        timestamp = parse_rtp_timestamp(raw)
        if timestamp is None:
            self.ignored_empty_count += 1
            return False
        if payload_type in self.rtx_payload_types:
            self.ignored_rtx_count += 1
            return False
        if pending is None:
            self.unmatched_count += 1
            target_registry = self.registry
            if target_registry is not None:
                target_registry.note_unmatched_wire()
            return False
        packet_ssrc = int.from_bytes(raw[8:12], "big") if ssrc is None else int(ssrc)
        if packet_ssrc != pending.ssrc:
            self.unmatched_count += 1
            pending.registry.note_unmatched_wire()
            return False
        origin = (int(timestamp) - int(pending.key.encoder_timestamp)) & 0xFFFFFFFF
        origin_key = (*pending.stream_scope, packet_ssrc)
        expected_origin = self._origin_by_stream.get(origin_key)
        if origin == 0:
            self.zero_origin_count += 1
            self.unmatched_count += 1
            pending.registry.note_unmatched_wire()
            return False
        if expected_origin is None:
            self._origin_by_stream[origin_key] = origin
        elif expected_origin != origin:
            self.origin_mismatch_count += 1
            self.unmatched_count += 1
            pending.registry.note_unmatched_wire()
            return False
        # Only the first new RTP packet for this encoded frame owns the wire ID.
        self._pending_by_task.pop(task, None)
        return pending.registry.bind_wire(pending.key, packet_ssrc, timestamp)

    def snapshot(self) -> dict:
        return {
            "enabled": bool(self.enabled),
            "unmatchedCount": self.unmatched_count,
            "originMismatchCount": self.origin_mismatch_count,
            "zeroOriginCount": self.zero_origin_count,
            "ignoredRtcpCount": self.ignored_rtcp_count,
            "ignoredEmptyCount": self.ignored_empty_count,
            "ignoredRtxCount": self.ignored_rtx_count,
            "rtxPayloadTypes": sorted(self.rtx_payload_types),
            "originByStream": {
                "|".join((attempt, str(generation), stream, str(ssrc))): origin
                for (attempt, generation, stream, ssrc), origin in self._origin_by_stream.items()
            },
        }


def install_aiortc_observer(observer: RtpFrameObserver):
    """Install pass-through wrappers only for the tested local aiortc ABI."""
    try:
        import aiortc
        import aiortc.rtcrtpsender as sender_module
        import aiortc.rtcdtlstransport as dtls_module
        compatible, reason = aiortc_observer_compatibility(
            version=aiortc.__version__,
            next_signature=str(inspect.signature(sender_module.RTCRtpSender._next_encoded_frame)),
            send_signature=str(inspect.signature(dtls_module.RTCDtlsTransport._send_rtp)),
        )
        if not compatible:
            observer.enabled = False
            return False, reason
        original_next = sender_module.RTCRtpSender._next_encoded_frame
        original_send = dtls_module.RTCDtlsTransport._send_rtp

        async def observed_next(sender, codec):
            encoded = await original_next(sender, codec)
            if encoded is not None:
                observer.observe_encoded_frame(sender, encoder_timestamp=encoded.timestamp, ssrc=getattr(sender, "_ssrc", 0))
            return encoded

        async def observed_send(transport, data):
            observer.observe_outgoing_rtp(data)
            return await original_send(transport, data)

        sender_module.RTCRtpSender._next_encoded_frame = observed_next
        dtls_module.RTCDtlsTransport._send_rtp = observed_send
        return True, "ok"
    except Exception:
        observer.enabled = False
        return False, "observer-install-failed"
