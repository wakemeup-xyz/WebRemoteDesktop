from __future__ import annotations

import asyncio

from media_stage_metrics import FrameKey, FrameTraceRegistry
import rtp_frame_observer as observer_module
from rtp_frame_observer import RtpFrameObserver, aiortc_observer_compatibility, parse_rtp_timestamp


def rtp(timestamp, payload=b"x", payload_type=96):
    return bytes([0x80, payload_type]) + b"\x00\x01" + int(timestamp).to_bytes(4, "big") + b"\x00\x00\x00\x07" + payload


def test_rtp_parser_reads_real_header_and_rejects_rtcp_or_empty_payload():
    """Treating a control or empty packet as video would create a false causal join."""
    assert parse_rtp_timestamp(rtp(0xFFFFFFF0)) == 0xFFFFFFF0
    assert parse_rtp_timestamp(bytes([0x80, 200]) + b"\x00" * 10) is None
    assert parse_rtp_timestamp(rtp(9, b"")) is None


def test_observer_binds_first_real_wire_packet_after_nonzero_origin_and_wrap():
    """Using encoder PTS as rVFC timestamp would fail as soon as aiortc adds origin."""
    registry = FrameTraceRegistry()
    key = FrameKey("a", 1, "video", 3, 0xFFFFFFF0)
    assert registry.register_capture(key, 12)
    observer = RtpFrameObserver(registry)

    async def send_from_sender_task():
        observer.observe_encoded_frame(object(), encoder_timestamp=key.encoder_timestamp, ssrc=7)
        assert observer.observe_outgoing_rtp(rtp(0x00000030), ssrc=7)

    asyncio.run(send_from_sender_task())
    row = registry.take_frame_trace_batch()["traces"][0]
    assert row["wireTimestamp"] == 0x30
    assert row["encoderTimestamp"] == 0xFFFFFFF0


def test_observer_rejects_rtx_conflicts_and_foreign_tasks_without_changing_media_bytes():
    """A retransmission must not overwrite the packet identity of the original frame."""
    registry = FrameTraceRegistry()
    key = FrameKey("a", 1, "video", 3, 9000)
    assert registry.register_capture(key, 12)
    observer = RtpFrameObserver(registry, rtx_payload_types={97})

    async def origin_task():
        observer.observe_encoded_frame(object(), encoder_timestamp=9000, ssrc=7)
        assert not observer.observe_outgoing_rtp(rtp(123, payload_type=97), ssrc=7)
        packet = rtp(123)
        assert observer.observe_outgoing_rtp(packet, ssrc=7)
        assert packet == rtp(123)

    asyncio.run(origin_task())
    assert registry.snapshot()["unmatchedWireCount"] >= 1


def test_observer_compatibility_fails_closed_for_unknown_aiortc_signature():
    """Private API drift may remove evidence, but must never stop media."""
    compatible, reason = aiortc_observer_compatibility(version="0.0", next_signature="(self)", send_signature="(self, data: bytes)")
    assert compatible is False
    assert "version" in reason


def test_abi_mismatch_does_not_patch_or_interrupt_the_existing_media_send(monkeypatch):
    """An unsupported observer leaves the installed aiortc media functions alone."""
    import aiortc.rtcrtpsender as sender_module
    import aiortc.rtcdtlstransport as dtls_module

    original_next = sender_module.RTCRtpSender._next_encoded_frame
    original_send = dtls_module.RTCDtlsTransport._send_rtp
    monkeypatch.setattr(observer_module, "aiortc_observer_compatibility", lambda **_kwargs: (False, "version-mismatch"))
    observer = RtpFrameObserver(FrameTraceRegistry())
    installed, reason = observer_module.install_aiortc_observer(observer)

    assert installed is False
    assert reason == "version-mismatch"
    assert observer.enabled is False
    assert sender_module.RTCRtpSender._next_encoded_frame is original_next
    assert dtls_module.RTCDtlsTransport._send_rtp is original_send
