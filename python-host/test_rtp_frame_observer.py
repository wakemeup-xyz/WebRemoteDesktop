from __future__ import annotations

import asyncio
from fractions import Fraction

from media_stage_metrics import FrameKey, FrameTraceRegistry, SenderFrameTraceContext, StageMetrics
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
    assert registry.snapshot()["unmatchedWireCount"] == 0
    assert observer.snapshot()["ignoredRtxCount"] == 1


def test_observer_compatibility_fails_closed_for_unknown_aiortc_signature():
    """Private API drift may remove evidence, but must never stop media."""
    compatible, reason = aiortc_observer_compatibility(version="0.0", next_signature="(self)", send_signature="(self, data: bytes)")
    assert compatible is False
    assert "version" in reason


def test_observer_rejects_a_changed_nonzero_origin_for_the_same_stream_across_uint32_wrap():
    """A foreign packet sharing a task must not overwrite a sender's random RTP origin."""
    registry = FrameTraceRegistry()
    first = FrameKey("a", 1, "video", 1, 0xFFFFFFF0)
    second = FrameKey("a", 1, "video", 2, 0x20)
    assert registry.register_capture(first, 1)
    assert registry.register_capture(second, 2)
    observer = RtpFrameObserver(registry)

    async def send():
        observer.observe_encoded_frame(object(), encoder_timestamp=first.encoder_timestamp, ssrc=7)
        assert observer.observe_outgoing_rtp(rtp(0x30), ssrc=7)  # origin = 0x40
        observer.observe_encoded_frame(object(), encoder_timestamp=second.encoder_timestamp, ssrc=7)
        assert not observer.observe_outgoing_rtp(rtp(0x61), ssrc=7)  # origin = 0x41

    asyncio.run(send())
    assert registry.snapshot()["unmatchedWireCount"] >= 1
    assert observer.snapshot()["originMismatchCount"] == 1


def test_actual_aiortc_sender_hook_records_one_nonzero_origin_through_wrap_and_ignores_negotiated_rtx(monkeypatch):
    """Breaking the actual _run_rtp hook, rather than synthetic bytes, loses this causal join."""
    import aiortc.rtcrtpsender as sender_module
    import aiortc.rtcdtlstransport as dtls_module
    from aiortc import MediaStreamError, MediaStreamTrack
    from aiortc.rtcrtpparameters import (RTCRtpCodecParameters, RTCRtpEncodingParameters,
                                         RTCRtpRtxParameters, RTCRtpSendParameters)

    registry = FrameTraceRegistry()
    metrics = StageMetrics(registry=registry)
    context = SenderFrameTraceContext(registry, metrics, "attempt", 1)
    first = FrameKey("attempt", 1, "video", 1, 0xFFFFFFF0)
    second = FrameKey("attempt", 1, "video", 2, 0x20)
    assert registry.register_capture(first, 1)
    assert registry.register_capture(second, 2)

    class Track(MediaStreamTrack):
        kind = "video"
        def __init__(self):
            super().__init__(); self.values = [0xFFFFFFF0, 0x20]
        async def recv(self):
            if not self.values: raise MediaStreamError
            from av import VideoFrame
            frame = VideoFrame(width=2, height=2, format="yuv420p")
            frame.pts = self.values.pop(0); frame.time_base = Fraction(1, 90000)
            return frame

    class Transport:
        state = "connected"
        _stats_id = "test"
        def __init__(self): self.packets = []
        async def _send_rtp(self, data):
            await dtls_module.RTCDtlsTransport._send_rtp(self, data)
        def _register_rtp_sender(self, _sender, _parameters): pass
        def _unregister_rtp_sender(self, _sender): pass

    class Encoder:
        def encode(self, frame, force_keyframe): return [b"payload"], int(frame.pts)

    original_next = sender_module.RTCRtpSender._next_encoded_frame
    async def fake_dtls_send(transport, data):
        transport.packets.append(bytes(data))

    monkeypatch.setattr(observer_module, "aiortc_observer_compatibility", lambda **_kwargs: (True, "ok"))
    monkeypatch.setattr(sender_module, "random32", lambda: 0x40)
    monkeypatch.setattr(dtls_module.RTCDtlsTransport, "_send_rtp", fake_dtls_send)
    observer = RtpFrameObserver(registry)
    installed, reason = observer_module.install_aiortc_observer(observer)
    assert installed, reason
    try:
        async def exercise_sender():
            transport = Transport()
            sender = sender_module.RTCRtpSender(Track(), transport)
            sender._RTCRtpSender__encoder = Encoder()
            sender._wrd_frame_trace_context = context
            codec = RTCRtpCodecParameters(mimeType="video/H264", clockRate=90000, payloadType=96)
            rtx = RTCRtpCodecParameters(mimeType="video/rtx", clockRate=90000, payloadType=97, parameters={"apt": 96})
            parameters = RTCRtpSendParameters(codecs=[codec, rtx], encodings=[RTCRtpEncodingParameters(
                ssrc=sender._ssrc, payloadType=96, rtx=RTCRtpRtxParameters(ssrc=sender._rtx_ssrc))])
            await sender.send(parameters)
            await asyncio.sleep(0.05)
            history = sender._RTCRtpSender__rtp_history
            await sender._retransmit(next(iter(history.values())).sequence_number)
            await sender.stop()
            return sender, transport

        sender, transport = asyncio.run(exercise_sender())
        # A negotiated RTX packet belongs to a retransmission path and must not
        # become the pending frame's wire identity.
        assert 97 in observer.snapshot()["rtxPayloadTypes"]
        # sender.stop() emits one RTCP BYE in addition to the two media packets
        # and the deliberate RTX retransmission.
        assert len(transport.packets) == 4
        assert len([packet for packet in transport.packets if packet[1] & 0x7F == 96]) == 2
        rows = registry.take_frame_trace_batch()["traces"]
        assert [row["wireTimestamp"] for row in rows] == [0x30, 0x60]
        assert observer.snapshot()["originByStream"]["attempt|1|video|" + str(sender._ssrc)] == 0x40
        assert observer.snapshot()["ignoredRtxCount"] == 1
        assert observer.snapshot()["ignoredRtcpCount"] == 1
    finally:
        sender_module.RTCRtpSender._next_encoded_frame = original_next


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
