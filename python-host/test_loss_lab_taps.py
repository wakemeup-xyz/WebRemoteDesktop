import asyncio
from types import SimpleNamespace

from media_stage_metrics import FrameKey, FrameTraceRegistry, SenderFrameTraceContext, StageMetrics
from rtp_frame_observer import RtpFrameObserver


def test_lab_loss_trace_records_actual_observer_rtcp_and_rtp_callbacks():
    registry = FrameTraceRegistry(lab_loss_trace=True)
    key = FrameKey("attempt", 3, "video", 7, 90000)
    assert registry.register_capture(key, 7)
    registry.annotate_encoder(key, "pli", "viewer-loss", "policy")
    observer = RtpFrameObserver(registry)
    # RTP v2 / PT 96 / seq 18 / timestamp 91000 / ssrc 9.  This is the same
    # raw-header parser used by the aiortc send wrapper, not a collector feed.
    packet = bytes([0x80, 96, 0, 18, 0, 1, 0x63, 0x78, 0, 0, 0, 9]) + b"payload"
    sender = SimpleNamespace(_ssrc=9, _wrd_frame_trace_context=SenderFrameTraceContext(registry, StageMetrics(registry=registry), "attempt", 3))

    async def observe_real_wrapper_callbacks():
        assert observer.observe_encoded_frame(sender, encoder_timestamp=90000, ssrc=9)
        observer.observe_lab_rtcp_feedback("PLI", sender=sender)
        assert observer.observe_outgoing_rtp(packet, ssrc=9)

    asyncio.run(observe_real_wrapper_callbacks())

    events = registry.take_loss_lab_trace_batch(limit=16)["events"]
    assert {event["type"] for event in events} >= {"rtcp_feedback", "encoder_idr", "rtp_send"}
    rtp = next(event for event in events if event["type"] == "rtp_send")
    assert rtp["sequence"] == 18 and rtp["rtpTimestamp"] == 91000
    assert rtp["frameKey"] == {"attemptId": "attempt", "generation": 3, "streamId": "video", "captureSeq": 7, "encoderTimestamp": 90000}


def test_lab_loss_trace_is_disabled_by_default_and_bounded():
    registry = FrameTraceRegistry()
    key = FrameKey("attempt", 1, "video", 1, 1)
    registry.register_capture(key, 1)
    registry.annotate_encoder(key, "forced", "test", "policy")
    registry.bind_wire(key, 2, 3)
    assert registry.take_loss_lab_trace_batch()["events"] == []

    bounded = FrameTraceRegistry(lab_loss_trace=True, lab_loss_capacity=2)
    for number in range(3):
        key = FrameKey("attempt", 1, "video", number, number + 1)
        bounded.register_capture(key, number)
        bounded.annotate_encoder(key, "forced", "test", "policy")
        bounded.bind_wire(key, 2, number + 2)
    batch = bounded.take_loss_lab_trace_batch(limit=16)
    assert len(batch["events"]) == 2
    assert batch["droppedEventCount"] == 1
