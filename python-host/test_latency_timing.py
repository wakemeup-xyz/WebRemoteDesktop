import time
import unittest
import sys
import os

# Add parent dir to path to import host module
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from host import ScreenCaptureTrack, WebRemoteHost
from media_timing import RtpFrameClock
from media_stage_metrics import FrameKey, FrameTraceRegistry, SenderFrameTraceContext, StageMetrics
from rtp_frame_observer import RtpFrameObserver


class TestFrameTiming(unittest.TestCase):
    def test_timing_capture_order(self):
        """Verify T0 <= T1 <= T2 <= T3 <= T4"""
        t0 = time.perf_counter()
        time.sleep(0.001)
        t1 = time.perf_counter()
        time.sleep(0.001)
        t2 = time.perf_counter()
        time.sleep(0.001)
        t3 = time.perf_counter()
        time.sleep(0.001)
        t4 = time.perf_counter()

        self.assertLessEqual(t0, t1)
        self.assertLessEqual(t1, t2)
        self.assertLessEqual(t2, t3)
        self.assertLessEqual(t3, t4)

    def test_screen_capture_track_has_timing_fields(self):
        """Verify ScreenCaptureTrack initializes timing fields"""
        track = ScreenCaptureTrack(target_fps=1, max_width=640, max_height=480)
        self.assertTrue(hasattr(track, '_pending_input_ids'))
        self.assertTrue(hasattr(track, '_pending_input_lock'))
        self.assertTrue(hasattr(track, '_timing_seq'))
        self.assertTrue(hasattr(track, '_host_ref'))
        self.assertIsInstance(track._frame_clock, RtpFrameClock)
        self.assertEqual(track._pending_input_ids, set())
        self.assertEqual(track._timing_seq, 0)
        track.sct.close()  # Clean up MSS resources

    def test_frame_timing_v2_only_names_measured_boundaries(self):
        sent = []
        track = object.__new__(ScreenCaptureTrack)
        track._host_ref = type("Host", (), {"get_input_datachannel": lambda self: type("DC", (), {"send": lambda self, value: sent.append(value)})()})()
        track._pending_input_lock = __import__("threading").Lock()
        track._pending_input_ids = set()
        track._pending_input_data = []
        track._timing_seq = 7

        track._send_frame_timing(capture_prepare_ms=3.5, frame_convert_ms=1.25)
        payload = __import__("json").loads(sent[0])

        self.assertEqual(payload["schemaVersion"], 2)
        self.assertEqual(payload["timings"]["capturePrepareMs"], 3.5)
        self.assertEqual(payload["timings"]["frameConvertMs"], 1.25)
        self.assertIsNone(payload["timings"]["imgprocQueueMs"])
        self.assertIsNone(payload["timings"]["imgprocBuildMs"])
        self.assertIsNone(payload["timings"]["encoderMs"])
        self.assertIsNone(payload["timings"]["rtpSendMs"])
        self.assertIsNone(payload["timings"]["endToEndVideoMs"])
        self.assertNotIn("encodeEnd", payload["timings"])
        self.assertNotIn("packetSend", payload["timings"])

    def test_frame_trace_summary_reports_real_denominators_and_resets_interval(self):
        registry = FrameTraceRegistry()
        metrics = StageMetrics(registry=registry)
        context = SenderFrameTraceContext(registry, metrics, "attempt", 1)
        key = FrameKey("attempt", 1, "video", 1, 9000)
        self.assertTrue(registry.register_capture(key, 100))
        self.assertTrue(registry.bind_wire(key, 7, 77))
        self.assertTrue(metrics.record(key, "grab", 0, 1_000_000))
        track = object.__new__(ScreenCaptureTrack)
        track._trace_interval = {
            "captures": 2, "outputs": 2, "outputsWithCapture": 1, "reusedOutputs": 1,
            "cpuStartedNs": time.process_time_ns(),
        }

        first = track._frame_trace_summary(context)
        second = track._frame_trace_summary(context)
        self.assertEqual(first["counts"], {"captures": 2, "outputs": 2, "outputsWithCapture": 1, "reusedOutputs": 1})
        self.assertEqual(first["coverage"]["sourceToWire"], 1.0)
        self.assertEqual(first["coverage"]["stages"]["grab"], 0.5)
        self.assertEqual(first["alignmentState"], "OBSERVED")
        self.assertEqual(second["counts"]["outputs"], 0)
        self.assertIsNone(second["coverage"]["sourceToWire"])
        self.assertEqual(second["alignmentState"], "UNALIGNED")

    def test_host_attempt_identity_reaches_rtp_trace_batch_without_touching_legacy_timing(self):
        registry = FrameTraceRegistry()
        host = object.__new__(WebRemoteHost)
        host._frame_trace_registry = registry
        host._stage_metrics = StageMetrics(registry=registry)
        host.media_profile = {"width": 1280, "height": 720, "target_fps": 20}
        host._user_resolution = {"width": 1280, "height": 720}
        host._h264_policy_version = "relay-legacy-v1"
        host._connection_generation = 0
        # Use the Host's existing viewer session payload source.  In particular,
        # this must retain connectionAttemptSequence rather than a media state.
        host._bind_session_presentation({
            "connectionAttemptId": "attempt-live", "connectionAttemptSequence": 7,
            "networkMode": "relay", "width": 1280, "height": 720,
        })
        policy = host._h264_policy_provider.current_policy()
        context = host._frame_trace_context_for_policy(policy)
        key = context.key(capture_seq=2, encoder_timestamp=9000)
        self.assertTrue(registry.register_capture(key, frame_pts=100))
        self.assertTrue(registry.annotate_encoder(key, "idr", "periodic", context.policy_digest))
        observer = RtpFrameObserver(registry)

        async def bind_actual_rtp_header():
            observer.observe_encoded_frame(object(), encoder_timestamp=9000, ssrc=7)
            packet = b"\x80\x60\x00\x01\x00\x00\x00\x4d\x00\x00\x00\x07x"
            self.assertTrue(observer.observe_outgoing_rtp(packet, ssrc=7))

        asyncio = __import__("asyncio")
        try:
            prior_loop = asyncio.get_event_loop()
        except RuntimeError:
            prior_loop = None
        loop = asyncio.new_event_loop()
        try:
            asyncio.set_event_loop(loop)
            loop.run_until_complete(bind_actual_rtp_header())
        finally:
            loop.close()
            asyncio.set_event_loop(prior_loop if prior_loop is not None and not prior_loop.is_closed()
                                   else asyncio.new_event_loop())
        batch = registry.take_frame_trace_batch()
        self.assertEqual(batch["traces"][0]["attemptId"], "attempt-live")
        self.assertEqual(batch["traces"][0]["generation"], 7)
        self.assertEqual(batch["traces"][0]["wireTimestamp"], 77)

        sent = []
        track = object.__new__(ScreenCaptureTrack)
        track._host_ref = type("Host", (), {"get_input_datachannel": lambda self: type("DC", (), {"send": lambda self, value: sent.append(value)})()})()
        track._pending_input_lock = __import__("threading").Lock()
        track._pending_input_ids = set()
        track._pending_input_data = []
        track._timing_seq = 0
        track._send_frame_timing(capture_prepare_ms=1, frame_convert_ms=2)
        self.assertEqual(__import__("json").loads(sent[0])["type"], "frame_timing")


if __name__ == '__main__':
    unittest.main()
