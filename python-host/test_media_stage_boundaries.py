"""Behavioral stage boundaries without native capture or hardware encoding."""

import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import av
import pytest
from aiortc.mediastreams import VIDEO_TIME_BASE

from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy
from h264_videotoolbox_encoder import H264VideoToolboxEncoder
from media_stage_metrics import FrameTraceRegistry, SenderFrameTraceContext, StageMetrics


@pytest.mark.asyncio
@pytest.mark.parametrize("wall_jump", [0.0, -4.24, 4.24])
async def test_media_clock_capture_stats_and_trace_follow_five_second_windows(monkeypatch, wall_jump):
    from test_frame_worker import bare_track, MediaClock
    clock = MediaClock(monkeypatch)
    track = bare_track()
    track.last_time = clock.mono
    registry = FrameTraceRegistry()
    track._frame_trace_context = SenderFrameTraceContext(
        registry, StageMetrics(registry=registry), "clock-test", 1)
    sent, log = [], Mock()
    dc = SimpleNamespace(readyState="open", bufferedAmount=0,
                         send=lambda value: sent.append(json.loads(value)))
    track._host_ref = SimpleNamespace(get_input_datachannel=lambda: dc)
    monkeypatch.setattr("host.logger.info", log)
    try:
        for now, expected_reports in [(104.999, 0), (105.0, 1), (110.0, 2)]:
            clock.mono = now
            clock.wall += wall_jump  # Stationary, backward or forward wall clock.
            await track.recv()
            assert len([row for row in sent if row["type"] == "capture_stats"]) == expected_reports
            assert len([call for call in log.call_args_list
                        if call.args[0].startswith("WRD_FRAME_TRACE_SUMMARY")]) == expected_reports
        reports = [row for row in sent if row["type"] == "capture_stats"]
        assert [row["fps"] for row in reports] == [0.4, 0.2]
        assert [row["frames"] for row in reports] == [2, 1]
        assert set(reports[0]["diagnosticAdmission"]) == {"types", "reasons", "legacyDropped"}
        assert set(reports[0]["diagnosticAdmission"]["types"]) == {
            "frame_timing", "capture_stats", "frame_trace_batch", "loss_lab_host_trace_batch"}
        capture_logs = [call.args for call in log.call_args_list if call.args[0].startswith("CAPTURE_STATS")]
        assert [row[1] for row in capture_logs] == pytest.approx([0.4, 0.2])
        assert track.last_time == 110.0
        assert track.frame_count == track._timing_count == 0
    finally:
        await track.shutdown()


@pytest.mark.asyncio
async def test_media_clock_capture_constructor_initializes_stats_without_native_capture(monkeypatch):
    from host import ScreenCaptureTrack
    from test_frame_worker import MediaClock
    clock = MediaClock(monkeypatch)
    capture = SimpleNamespace(monitors=[{"left": 0, "top": 0, "width": 2, "height": 2}], close=lambda: None)
    monkeypatch.setattr("host.MSS", lambda: capture)
    monkeypatch.setattr("host.get_screeninfo_monitors", lambda: [])
    with patch("host.threading.Thread") as thread:
        thread.return_value.is_alive.return_value = False
        track = ScreenCaptureTrack()
    try:
        assert track.last_time == clock.mono
        assert track._last_frame_time == 0
    finally:
        await track.shutdown()


class TestStageBoundaries(unittest.TestCase):
    def test_generator_work_is_encode_not_packetize(self):
        from media_timing import materialize_and_packetize

        now = [0]

        def produce():
            now[0] += 40_000_000
            yield b"nal"

        def packetize(nals):
            result = list(nals)
            now[0] += 3_000_000
            return result

        packets, durations = materialize_and_packetize(produce, packetize, lambda: now[0])
        self.assertEqual(packets, [b"nal"])
        self.assertEqual(durations, {
            "encoderMs": 40.0, "packetizeMs": 3.0, "encodeTotalMs": 43.0,
        })

    def test_actual_encoder_consumes_lazy_codec_before_packetization(self):
        now = [0]
        registry = FrameTraceRegistry(clock_ns=lambda: now[0])
        metrics = StageMetrics(registry=registry)
        context = SenderFrameTraceContext(registry, metrics, "stage-test", 1)
        policy = resolve_h264_policy(
            MediaSessionIntent("stage-test", 1, "relay", 16, 16, 20, 0),
            "relay-legacy-v1",
        )
        encoder = H264VideoToolboxEncoder(policy=policy, frame_trace_context=context)

        class FakeCodec:
            width = height = 16

            def encode(self, frame):
                # Work happens on iteration, just like _encode_frame itself.
                now[0] += 40_000_000
                yield b"\x00\x00\x00\x01\x61\x01"

        encoder.codec = FakeCodec()
        frame = av.VideoFrame(width=16, height=16, format="yuv420p")
        frame.pts, frame.time_base = 9000, VIDEO_TIME_BASE
        key = context.key(7, 9000)
        self.assertTrue(registry.register_capture(key, frame.pts))
        real_packetize = encoder._packetize

        def packetize(nals):
            packets = real_packetize(nals)
            now[0] += 3_000_000
            return packets

        encoder._packetize = packetize
        encoder._record_encoder_sample = Mock()
        with patch("h264_videotoolbox_encoder.time.monotonic_ns", lambda: now[0]), \
                patch("h264_videotoolbox_encoder.time.monotonic", lambda: now[0] / 1e9):
            packets, timestamp = encoder.encode(frame)

        self.assertEqual((packets, timestamp), ([b"\x61\x01"], 9000))
        stages = metrics.snapshot()["stages"]
        self.assertEqual(stages["encode"]["p50Ms"], 40.0)
        self.assertEqual(stages["packetize"]["p50Ms"], 3.0)
        self.assertEqual(stages["encode_total"]["p50Ms"], 43.0)
        self.assertIsNone(stages["reformat"]["p50Ms"])
        # Ordinary encoder telemetry remains elapsed wall time, including the
        # packetizer, rather than CPU time or generator-construction time.
        self.assertEqual(encoder._record_encoder_sample.call_args.kwargs["elapsed_ms"], 43.0)


class TestCaptureBoundaries(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # This factory never constructs MSS, capture threads, or a real Host.
        from test_frame_worker import bare_track
        self.track = bare_track(max_width=2, max_height=2)

    async def asyncTearDown(self):
        self.track._process_executor.shutdown(wait=True)

    def publish(self, seq, bounds):
        import numpy as np
        from test_frame_worker import Screenshot
        self.track._capture_buffer = Screenshot(np.full((2, 2, 4), seq, dtype=np.uint8))
        self.track._capture_seq = seq
        self.track._capture_bounds_ns[seq] = bounds

    def trace_context(self):
        registry = FrameTraceRegistry()
        context = SenderFrameTraceContext(registry, StageMetrics(registry=registry), "capture-test", 1)
        self.track._frame_trace_context = context
        return context

    async def test_capture_stats_log_and_wire_share_reuse_snapshot_then_reset(self):
        now = [0.0]
        sent = []
        self.track.last_time = 0.0
        dc = SimpleNamespace(readyState="open", bufferedAmount=0,
                             send=lambda value: sent.append(json.loads(value)))
        self.track._host_ref = SimpleNamespace(get_input_datachannel=lambda: dc)
        self.publish(1, (0, 1))
        with patch("host.time.monotonic", lambda: now[0]), patch("host.logger.info") as log:
            await self.track.recv()
            now[0] = 1.0
            await self.track.recv()
            now[0] = 5.0
            await self.track.recv()
            first = [row for row in sent if row["type"] == "capture_stats"][0]
            self.assertEqual(first["reuse"], 2)
            self.assertEqual(first["frames"], 3)
            message = next(call.args[0] % call.args[1:] for call in log.call_args_list
                           if call.args[0].startswith("CAPTURE_STATS"))
            self.assertIn("frames=3", message)
            self.assertIn("reuse=2", message)
            self.assertEqual((self.track.frame_count, self.track._total_reuse), (0, 0))
            self.publish(2, (2, 3))
            now[0] = 10.0
            async def timestamp(): return 18000, VIDEO_TIME_BASE
            self.track.next_timestamp = timestamp
            await self.track.recv()
        second = [row for row in sent if row["type"] == "capture_stats"][1]
        self.assertEqual((second["reuse"], second["frames"]), (0, 1))

    async def test_five_minute_pause_is_separate_from_active_recv_total(self):
        now = [0]
        self.track._suspended = True
        self.publish(1, (0, 1))
        original_process = self.track._process_screenshot

        async def resume(_delay):
            now[0] += 300_000_000_000
            self.track._suspended = False

        def process(*args):
            now[0] += 2_000_000
            return original_process(*args)

        self.track._process_screenshot = process
        # Avoid the reporting cut resetting the totals under inspection.
        self.track.last_time = 1e9
        with patch("host.asyncio.sleep", resume), \
                patch("host.time.perf_counter", lambda: now[0] / 1e9), \
                patch("host.time.monotonic", lambda: now[0] / 1e9), \
                patch("host.time.monotonic_ns", lambda: now[0]):
            await self.track.recv()
        self.assertAlmostEqual(self.track._timing_totals["total"], 0.002)
        self.assertEqual(self.track._timing_totals["pause_wait"], 300.0)

    async def test_failed_new_capture_reuses_original_identity_and_grab_bounds(self):
        from input_frame_causality import InputFrameCausality
        context = self.trace_context()
        scope = ("capture-test", 1, 7)
        causality = InputFrameCausality(now_ns=lambda: 20_000_000)
        causality.reset_scope(scope)
        self.track._host_ref = SimpleNamespace(
            _input_observation_scope=lambda: scope, _input_frame_causality=causality,
            get_input_datachannel=lambda: None)
        self.publish(1, (1_000_000, 3_000_000))
        original_frame = await self.track.recv()
        causality.note_applied(["pending"], scope=scope, applied_ns=4_000_000, status="applied")
        self.publish(2, (5_000_000, 9_000_000))
        self.track._capture_bounds_ns[1] = (11_000_000, 19_000_000)
        # A valid new capture whose conversion fails must not advance the
        # identity of the old pixels actually returned by the worker.
        original = self.track._video_frame_from_image
        calls = [0]

        def fail_new_image_once(image):
            calls[0] += 1
            if calls[0] == 1:
                raise ValueError("fake conversion failure")
            return original(image)

        self.track._video_frame_from_image = fail_new_image_once
        fallback_frame = await self.track.recv()
        self.assertEqual(fallback_frame.to_ndarray(format="bgra").tolist(),
                         original_frame.to_ndarray(format="bgra").tolist())
        await self.track.recv()
        for timestamp in (12000, 15000):
            key = context.registry.find_by_encoder_timestamp(timestamp)
            self.assertEqual(key.capture_seq, 1)
            context.registry.bind_wire(key, 7, timestamp)
        rows = context.registry.take_frame_trace_batch()["traces"]
        self.assertEqual([row["stages"]["grab"] for row in rows], [2.0, 2.0])
        self.assertEqual(self.track._capture_seq, 2)
        self.assertEqual(causality.snapshot()["reservations"], 0)
        self.assertEqual(causality.snapshot()["pending"], 1)

    async def test_pause_started_during_pacing_is_excluded_from_active_recv(self):
        now = [1_000_000_000]
        self.track._frame_interval = 0.05
        self.track._last_frame_time = 1.0
        self.track.last_time = 1e9
        self.publish(1, (0, 1))
        sleeps = [0]

        async def sleep(_delay):
            sleeps[0] += 1
            if sleeps[0] == 1:
                now[0] += 50_000_000
                self.track._suspended = True
            else:
                now[0] += 300_000_000_000
                self.track._suspended = False

        with patch("host.asyncio.sleep", sleep), \
                patch("host.time.perf_counter", lambda: now[0] / 1e9), \
                patch("host.time.monotonic", lambda: now[0] / 1e9), \
                patch("host.time.monotonic_ns", lambda: now[0]):
            await self.track.recv()
        self.assertAlmostEqual(self.track._timing_totals["total"], 0.05)
        self.assertEqual(self.track._timing_totals["pause_wait"], 300.0)

    async def test_failed_capture_without_valid_cache_has_no_capture_evidence(self):
        context = self.trace_context()
        self.publish(3, (1_000_000, 2_000_000))
        self.track._process_screenshot = Mock(side_effect=ValueError("fake preparation failure"))
        await self.track.recv()
        key = context.registry.find_by_encoder_timestamp(9000)
        self.assertEqual(key.capture_seq, 0)
        context.registry.bind_wire(key, 7, 9000)
        stages = context.registry.take_frame_trace_batch()["traces"][0]["stages"]
        self.assertIsNone(stages["grab"])
        self.assertIsNone(stages["age_at_recv"])

    async def test_worker_stages_measure_queue_prepare_convert_and_enclosing_build(self):
        import numpy as np
        now = [10_000_000]
        context = self.trace_context()
        key = context.key(7, 9000)

        def prepare(*args):
            now[0] += 5_000_000
            return np.zeros((2, 2, 4), dtype=np.uint8)

        def convert(image):
            now[0] += 2_000_000
            return av.VideoFrame(width=2, height=2, format="bgra")

        with patch.object(self.track, "_process_screenshot", prepare), \
                patch.object(self.track, "_video_frame_from_image", convert), \
                patch("host.time.monotonic_ns", lambda: now[0]):
            frame, image, reused, timing = self.track._build_video_frame(object(), None, True, 2, 2, 0)
        self.track._record_output_trace(context, key, 9000, (0, 1), 2, timing, fresh=True, reused=False)
        stages = context.metrics.snapshot()["stages"]
        for name, duration in (("worker_queue", 10.0), ("prepare", 5.0), ("convert", 2.0), ("build", 7.0)):
            self.assertEqual(stages[name]["p50Ms"], duration)
        self.assertIsNone(stages["reformat"]["p50Ms"])
        self.assertNotIn("pipelineTotalMs", context.metrics.snapshot())
        # convert is the existing frameConvertMs boundary. It is internal to
        # StageMetrics so strict frame_trace_batch v1 stays wire-compatible.
        context.registry.bind_wire(key, 7, 9000)
        row = context.registry.take_frame_trace_batch()["traces"][0]
        self.assertEqual(set(row["stages"]), {
            "grab", "age_at_recv", "worker_queue", "prepare", "build",
            "reformat", "encode", "packetize", "encode_total",
        })

    async def test_production_factory_passes_one_times_capture_and_one_opencv_thread(self):
        from host import WebRemoteHost
        host = object.__new__(WebRemoteHost)
        host.media_profile = {"target_fps": 20, "width": 1280, "height": 720}
        host._frame_trace_context = None
        with patch("host.ScreenCaptureTrack") as track_factory:
            host._create_screen_track()
        strategy = track_factory.call_args.kwargs["capture_strategy"]
        self.assertEqual((strategy.capture_multiplier, strategy.opencv_threads), (1.0, 1))


if __name__ == "__main__":
    unittest.main()
