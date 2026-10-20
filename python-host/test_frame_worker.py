import asyncio
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
from types import SimpleNamespace

import av
import numpy as np
import pytest
from aiortc.mediastreams import MediaStreamError

import host
from host import CaptureExperiment, ScreenCaptureTrack, WebRemoteHost
from media_stage_metrics import FrameTraceRegistry, SenderFrameTraceContext, StageMetrics
from host import detailed_frame_trace_enabled


class Screenshot:
    def __init__(self, pixels):
        self.height, self.width = pixels.shape[:2]
        self.raw = pixels.tobytes()


def bare_track(*, max_width=2, max_height=2):
    """Build a track without MSS or its capture thread; tests supply its latest frame."""
    track = object.__new__(ScreenCaptureTrack)
    track._capture_running = True
    track._suspended = False
    track._capture_generation = 0
    track._target_generation = 0
    track._activity_condition = threading.Condition()
    track._capture_lock = threading.Lock()
    track._target_lock = threading.Lock()
    track._capture_buffer = None
    track._capture_seq = 0
    track._capture_bounds_ns = {}
    track._last_consumed_seq = -1
    track._last_img = None
    track._last_img_shape = (0, 0)
    track._last_img_target_generation = -1
    track._max_width = max_width
    track._max_height = max_height
    track.monitor = {"width": max_width, "height": max_height}
    track._target_fps = 30
    track._capture_strategy = None
    track._frame_interval = 0
    track._last_frame_time = 0
    track._process_executor = ThreadPoolExecutor(max_workers=1)
    track._reuse_count = 0
    track._total_reuse = 0
    track._timing_totals = {"sleep": 0.0, "capture_wait": 0.0, "convert": 0.0, "total": 0.0}
    track._timing_count = 0
    track._host_ref = None
    track._frame_trace_context = None
    track._last_trace_send_ns = 0
    track._trace_interval = {
        "captures": 0, "outputs": 0, "outputsWithCapture": 0, "reusedOutputs": 0,
        "cpuStartedNs": time.process_time_ns(),
    }
    track._trace_interval_lock = threading.Lock()
    track._pending_input_lock = threading.Lock()
    track._pending_input_ids = set()
    track._pending_input_data = []
    track._timing_seq = 0
    track.frame_count = 0
    track.last_time = time.monotonic()
    track._ps_count = 0
    track._capture_thread = None
    track.sct = None
    timestamps = iter(((9000, Fraction(1, 90000)), (12000, Fraction(1, 90000)), (15000, Fraction(1, 90000))))

    async def next_timestamp():
        return next(timestamps)

    track.next_timestamp = next_timestamp
    return track


class MediaClock:
    """Independent clock domains, scoped to Host so asyncio keeps its real clock."""
    def __init__(self, monkeypatch):
        self.mono = 100.0
        self.wall = 1_792_208_500.0
        self.sleeps = []
        monkeypatch.setattr(host, "time", SimpleNamespace(**{
            **vars(time), "time": lambda: self.wall, "monotonic": lambda: self.mono,
            "monotonic_ns": lambda: int(self.mono * 1e9),
            "perf_counter": lambda: self.mono,
        }))

    async def sleep(self, delay):
        self.sleeps.append(delay)
        self.mono += delay
        self.wall += delay


@pytest.mark.asyncio
@pytest.mark.parametrize("wall_jump", [0.0, -4.24, 4.24])
@pytest.mark.parametrize("elapsed, expected", [(0.020, [0.030]), (0.080, [])])
async def test_media_clock_recv_paces_from_actual_previous_output(monkeypatch, wall_jump, elapsed, expected):
    clock = MediaClock(monkeypatch)
    monkeypatch.setattr(host.asyncio, "sleep", clock.sleep)
    track = bare_track()
    track.last_time = clock.mono
    track._frame_interval = 0.05
    try:
        first = await track.recv()
        assert clock.sleeps == []  # Initial sentinel permits the first frame.
        clock.mono += elapsed
        clock.wall += elapsed + wall_jump
        second = await track.recv()
        assert clock.sleeps == pytest.approx(expected)
        assert (first.pts, second.pts) == (9000, 12000)
    finally:
        await track.shutdown()


@pytest.mark.asyncio
async def test_media_clock_recv_resume_resets_pacing_and_uses_fresh_pixels(monkeypatch):
    clock = MediaClock(monkeypatch)
    monkeypatch.setattr(host.asyncio, "sleep", clock.sleep)
    track = bare_track(max_width=1, max_height=1)
    track.last_time = clock.mono
    track._frame_interval = 0.05
    try:
        await track.recv()
        track.set_suspended(True)
        clock.wall -= 4.24
        track.set_suspended(False)
        track._capture_buffer = Screenshot(np.full((1, 1, 4), 7, dtype=np.uint8))
        track._capture_seq = 1
        frame = await track.recv()
        assert clock.sleeps == []
        assert frame.pts == 12000
        assert np.all(frame.to_ndarray(format="bgra") == 7)
    finally:
        await track.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize("transition", ["suspend", "shutdown"])
async def test_media_clock_recv_rechecks_lifecycle_after_pacing(monkeypatch, transition):
    clock = MediaClock(monkeypatch)
    track = bare_track(max_width=1, max_height=1)
    track.last_time = clock.mono
    track._frame_interval = 0.05
    try:
        await track.recv()
        clock.mono += 0.02
        clock.wall += 0.02

        async def sleep(delay):
            await clock.sleep(delay)
            if len(clock.sleeps) == 1:
                if transition == "shutdown":
                    await track.shutdown()
                else:
                    track.set_suspended(True)
            else:
                track.set_suspended(False)
                track._capture_buffer = Screenshot(np.full((1, 1, 4), 9, dtype=np.uint8))
                track._capture_seq = 1

        monkeypatch.setattr(host.asyncio, "sleep", sleep)
        if transition == "shutdown":
            with pytest.raises(MediaStreamError):
                await track.recv()
            assert clock.sleeps == pytest.approx([0.03])
        else:
            frame = await track.recv()
            assert clock.sleeps == pytest.approx([0.03, 0.05])
            assert np.all(frame.to_ndarray(format="bgra") == 9)
            assert frame.pts == 12000
    finally:
        await track.shutdown()


def test_capture_strategy_keeps_none_at_legacy_two_times_and_candidate_at_target_rate():
    candidate = CaptureExperiment(capture_multiplier=1.0, opencv_threads=None)

    assert ScreenCaptureTrack.capture_fps_for_target(20) == 40
    assert ScreenCaptureTrack.capture_fps_for_target(20, capture_strategy=candidate) == 20
    assert ScreenCaptureTrack.capture_fps_for_target(12) == 24


def test_normal_host_track_factory_uses_bounded_capture_strategy(monkeypatch):
    created = {}

    class StubTrack:
        def __init__(self, **kwargs):
            created.update(kwargs)

    monkeypatch.setattr(host, "ScreenCaptureTrack", StubTrack)
    remote_host = object.__new__(WebRemoteHost)
    remote_host.media_profile = {"target_fps": 20, "width": 1280, "height": 720}
    remote_host._frame_trace_context = object()

    remote_host._create_screen_track()

    strategy = created["capture_strategy"]
    assert strategy.capture_multiplier == 1.0
    assert strategy.opencv_threads == 1


@pytest.mark.asyncio
async def test_capture_loop_pauses_grabs_then_resumes_fresh_dimensions_pts_and_input_effect(monkeypatch):
    class CountingMss:
        monitors = [{"left": 0, "top": 0, "width": 2, "height": 1}]
        def __init__(self): self.calls = 0
        def grab(self, _monitor):
            self.calls += 1
            return Screenshot(np.full((1, 2, 4), self.calls, dtype=np.uint8))
        def close(self): pass

    capture = CountingMss()
    monkeypatch.setattr(host, "MSS", lambda: capture)
    monkeypatch.setattr(host, "get_screeninfo_monitors", lambda: [])
    track = ScreenCaptureTrack(target_fps=20, max_width=2, max_height=1,
                               capture_strategy=CaptureExperiment(1.0, None))
    sent = []
    track._host_ref = type("Host", (), {"get_input_datachannel": lambda _self: type("DC", (), {"send": sent.append})()})()
    try:
        assert await asyncio.to_thread(track.wait_for_fresh_capture, 0, 1.0)
        baseline = track.set_suspended(True)
        await asyncio.sleep(0.12)
        assert capture.calls == baseline
        track.apply_media_profile({"width": 2, "height": 1, "target_fps": 20})
        track.set_suspended(False)
        assert await asyncio.to_thread(track.wait_for_fresh_capture, baseline, 1.0)
        with track._pending_input_lock:
            track._pending_input_ids.add("input-1")
        first, second = await track.recv(), await track.recv()
    finally:
        await track.shutdown()

    assert (first.width, first.height) == (2, 1)
    assert second.pts > first.pts
    assert any('"inputIds": ["input-1"]' in payload for payload in sent)


@pytest.mark.asyncio
async def test_same_frame_stage_hooks_preserve_worker_pixels_and_loop_owned_pts():
    """Timing evidence must not add frame attributes or change the established PTS path."""
    pixels = np.array([[[7, 8, 9, 255]]], dtype=np.uint8)
    track = bare_track(max_width=1, max_height=1)
    registry = FrameTraceRegistry()
    metrics = StageMetrics(registry=registry)
    track._frame_trace_context = SenderFrameTraceContext(
        registry=registry, metrics=metrics, attempt_id="attempt", generation=1,
    )
    track._capture_buffer = Screenshot(pixels)
    track._capture_seq = 1
    now_ns = time.monotonic_ns()
    track._capture_bounds_ns[1] = (now_ns - 3_000_000, now_ns - 2_000_000)
    try:
        frame = await track.recv()
    finally:
        track._process_executor.shutdown(wait=True)

    assert frame.pts == 9000
    assert np.array_equal(frame.to_ndarray(format="bgra"), pixels)
    stages = metrics.snapshot()["stages"]
    assert all(stages[name]["count"] == 1 for name in ("grab", "age_at_recv", "worker_queue", "prepare", "build"))
    assert stages["reformat"]["count"] == 0


@pytest.mark.asyncio
async def test_detailed_trace_on_off_preserves_media_pixels_pts_and_capture_lifecycle():
    """Turning evidence on must only add sidecars, never change the media frame."""
    pixels = np.array([[[7, 8, 9, 255]]], dtype=np.uint8)
    off, on = bare_track(max_width=1, max_height=1), bare_track(max_width=1, max_height=1)
    registry = FrameTraceRegistry()
    on._frame_trace_context = SenderFrameTraceContext(registry, StageMetrics(registry=registry), "attempt", 1)
    for track in (off, on):
        track._capture_buffer = Screenshot(pixels)
        track._capture_seq = 1
        now_ns = time.monotonic_ns()
        track._capture_bounds_ns[1] = (now_ns - 1_000_000, now_ns)
    try:
        off_frame, on_frame = await off.recv(), await on.recv()
    finally:
        off._process_executor.shutdown(wait=True)
        on._process_executor.shutdown(wait=True)

    assert detailed_frame_trace_enabled({}) is False
    assert detailed_frame_trace_enabled({"WRD_FRAME_TRACE_DETAIL": "1"}) is True
    assert off_frame.pts == on_frame.pts == 9000
    assert np.array_equal(off_frame.to_ndarray(format="bgra"), on_frame.to_ndarray(format="bgra"))
    assert off._capture_running is on._capture_running is True
    assert registry.snapshot()["sourceOutputFrameCount"] == 1


@pytest.mark.asyncio
async def test_output_trace_transaction_cannot_split_registered_output_from_summary_denominator():
    """The old cut could observe registered=1 with outputs=0 mid-recv."""
    class BlockingRegistry(FrameTraceRegistry):
        def __init__(self):
            super().__init__()
            self.registered = threading.Event()
            self.release = threading.Event()

        def register_capture(self, key, frame_pts):
            result = super().register_capture(key, frame_pts)
            self.registered.set()
            assert self.release.wait(timeout=1)
            return result

    pixels = np.zeros((1, 1, 4), dtype=np.uint8)
    track = bare_track(max_width=1, max_height=1)
    registry = BlockingRegistry()
    metrics = StageMetrics(registry=registry)
    context = SenderFrameTraceContext(registry, metrics, "attempt", 1)
    track._frame_trace_context = context
    track._capture_buffer = Screenshot(pixels)
    track._capture_seq = 1
    now_ns = time.monotonic_ns()
    track._capture_bounds_ns[1] = (now_ns - 1_000_000, now_ns)
    summaries = []

    def snapshot_during_registration():
        assert registry.registered.wait(timeout=1)
        summaries.append(track._frame_trace_summary(context))

    snapshotter = threading.Thread(target=snapshot_during_registration)
    snapshotter.start()
    release = threading.Timer(0.05, registry.release.set)
    release.start()
    try:
        await track.recv()
    finally:
        release.cancel()
        snapshotter.join(timeout=1)
        track._process_executor.shutdown(wait=True)

    assert not snapshotter.is_alive()
    assert summaries[0]["counts"]["outputs"] == 1
    assert summaries[0]["traces"]["registeredOutputFrameCount"] == 1


@pytest.mark.asyncio
async def test_frame_construction_waits_in_imgproc_worker_without_blocking_event_loop(monkeypatch):
    """Moving construction back to recv would make the worker miss the heartbeat."""
    track = bare_track()
    track._last_img = np.array([[[1, 2, 3, 255], [4, 5, 6, 255]]], dtype=np.uint8)
    original = av.VideoFrame.from_ndarray
    construction_started = threading.Event()
    heartbeat = threading.Event()
    observed_heartbeat = []

    class BlockingVideoFrame:
        @staticmethod
        def from_ndarray(img, format):
            construction_started.set()
            observed_heartbeat.append(heartbeat.wait(timeout=0.25))
            return original(img, format=format)

    monkeypatch.setattr(host.av, "VideoFrame", BlockingVideoFrame)
    try:
        recv_task = asyncio.create_task(track.recv())
        await asyncio.to_thread(construction_started.wait, 0.5)
        heartbeat.set()
        frame = await asyncio.wait_for(recv_task, timeout=1)
    finally:
        track._process_executor.shutdown(wait=True)

    assert observed_heartbeat == [True]
    assert frame.pts == 9000


@pytest.mark.asyncio
async def test_fresh_reuse_and_conversion_failure_make_independent_bgra_frames_with_loop_pts():
    """A bad worker result must fall back to a fresh frame, never a shared VideoFrame."""
    pixels = np.array([[[7, 8, 9, 255], [10, 11, 12, 255]]], dtype=np.uint8)
    track = bare_track()
    track._capture_buffer = Screenshot(pixels)
    track._capture_seq = 1
    try:
        fresh = await track.recv()
        reused = await track.recv()
        track._capture_buffer = Screenshot(pixels)
        track._capture_seq = 2
        original = track._process_screenshot
        track._process_screenshot = lambda screenshot: (_ for _ in ()).throw(ValueError("bad resize"))
        fallback = await track.recv()
    finally:
        track._process_executor.shutdown(wait=True)

    assert fresh is not reused
    assert reused is not fallback
    assert fresh.format.name == "bgra"
    assert fresh.width == 2 and fresh.height == 1
    assert np.array_equal(fresh.to_ndarray(format="bgra"), pixels)
    assert np.array_equal(reused.to_ndarray(format="bgra"), pixels)
    assert np.array_equal(fallback.to_ndarray(format="bgra"), pixels)
    assert (fresh.pts, reused.pts) == (9000, 12000)


@pytest.mark.asyncio
async def test_suspension_drops_a_frame_that_finished_after_its_capture_generation(monkeypatch):
    """Returning a pre-suspend worker result would resume video while media is paused."""
    pixels = np.array([[[9, 8, 7, 255]]], dtype=np.uint8)
    track = bare_track(max_width=1, max_height=1)
    track._capture_buffer = Screenshot(pixels)
    track._capture_seq = 1
    started = threading.Event()
    release = threading.Event()
    original = track._process_screenshot

    def blocked_process(screenshot, *args):
        started.set()
        assert release.wait(timeout=1)
        return original(screenshot)

    monkeypatch.setattr(track, "_process_screenshot", blocked_process)
    try:
        recv_task = asyncio.create_task(track.recv())
        await asyncio.to_thread(started.wait, 0.5)
        track.set_suspended(True)
        release.set()
        await asyncio.sleep(0.05)
        assert not recv_task.done()
        recv_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await recv_task
    finally:
        track._process_executor.shutdown(wait=True)


@pytest.mark.asyncio
async def test_profile_change_drops_a_worker_result_built_for_the_old_dimensions(monkeypatch):
    """Publishing the old-size result after a profile switch corrupts the next encoder frame."""
    pixels = np.array([[[1, 2, 3, 255]]], dtype=np.uint8)
    track = bare_track(max_width=1280, max_height=720)
    track.monitor = {"width": 1792, "height": 1120}
    track._last_img = pixels.copy()
    track._last_img_target_generation = 0
    track._capture_buffer = Screenshot(pixels)
    track._capture_seq = 1
    started = threading.Event()
    release = threading.Event()
    original = track._process_screenshot

    def blocked_process(screenshot, *args):
        started.set()
        assert release.wait(timeout=1)
        return original(screenshot)

    monkeypatch.setattr(track, "_process_screenshot", blocked_process)
    try:
        recv_task = asyncio.create_task(track.recv())
        await asyncio.to_thread(started.wait, 0.5)
        result = track.apply_media_profile({"width": 640, "height": 360, "target_fps": 30})
        assert result == {"sizeChanged": True, "width": 640, "height": 360}
        assert track._target_generation == 1
        release.set()
        frame = await asyncio.wait_for(recv_task, timeout=1)
    finally:
        track._process_executor.shutdown(wait=True)

    assert (frame.width, frame.height) == (640, 360)
    assert np.all(frame.to_ndarray(format="bgra") == 0)


@pytest.mark.asyncio
async def test_invalid_cached_fallback_builds_a_valid_blank_frame(monkeypatch):
    """A corrupt ndarray cache must not escape the worker as a conversion failure."""
    track = bare_track(max_width=2, max_height=1)
    track._last_img = np.array([1], dtype=np.uint8)
    track._last_img_target_generation = 0
    track._capture_buffer = Screenshot(np.zeros((1, 1, 4), dtype=np.uint8))
    track._capture_seq = 1
    monkeypatch.setattr(track, "_process_screenshot", lambda screenshot, *args: np.array([1], dtype=np.uint8))
    try:
        frame = await track.recv()
    finally:
        track._process_executor.shutdown(wait=True)

    assert frame.format.name == "bgra"
    assert (frame.width, frame.height) == (2, 1)
    assert np.array_equal(frame.to_ndarray(format="bgra"), np.zeros((1, 2, 4), dtype=np.uint8))


@pytest.mark.asyncio
async def test_shutdown_rejects_a_worker_result_that_was_already_in_flight(monkeypatch):
    """A queued frame after shutdown is stale media, so recv must end instead of publishing it."""
    pixels = np.array([[[1, 2, 3, 255]]], dtype=np.uint8)
    track = bare_track(max_width=1, max_height=1)
    track._capture_buffer = Screenshot(pixels)
    track._capture_seq = 1
    started = threading.Event()
    release = threading.Event()
    original = track._process_screenshot

    def blocked_process(screenshot, *args):
        started.set()
        assert release.wait(timeout=1)
        return original(screenshot)

    monkeypatch.setattr(track, "_process_screenshot", blocked_process)
    recv_task = asyncio.create_task(track.recv())
    await asyncio.to_thread(started.wait, 0.5)
    shutdown_task = asyncio.create_task(track.shutdown())
    release.set()
    await shutdown_task

    with pytest.raises(MediaStreamError):
        await recv_task


def epoch_track():
    track = bare_track(max_width=1280, max_height=720)
    track.monitor = {"width": 1792, "height": 1120}
    track._target_generation = 9
    track._target_fps = 20
    track._frame_interval = 1 / 20
    track._last_img = np.full((720, 1152, 4), 7, dtype=np.uint8)
    track._last_img_target_generation = 9
    track._last_img_capture = (42, (100, 200))
    releases = []
    track._release_input_frame_reservations = lambda: releases.append(True)
    return track, releases


def test_image_epoch_changes_only_for_effective_dimensions():
    track, releases = epoch_track()
    try:
        for fps in (15, 20, 20):
            result = track.apply_media_profile({"width": 1280, "height": 720,
                                                "target_fps": fps, "bitrate": 1800000})
            assert result == {"sizeChanged": False, "width": 1280, "height": 720}
            assert track._target_generation == 9
            assert track._frame_interval == 1 / fps
            assert releases == []
        result = track.apply_media_profile({"width": 9999, "height": 9999, "target_fps": 15})
        assert result == {"sizeChanged": True, "width": 1792, "height": 1080}
        assert track._target_generation == 10
        assert len(releases) == 1
        assert track.apply_media_profile({"width": 2000, "height": 1200, "target_fps": 20}) == {
            "sizeChanged": False, "width": 1792, "height": 1080}
        assert track._target_generation == 10
        assert len(releases) == 1
    finally:
        track._process_executor.shutdown(wait=True)


@pytest.mark.asyncio
async def test_fps_profile_preserves_cache_pixels_and_capture_identity():
    track, releases = epoch_track()
    outputs = []
    track._frame_trace_context = SimpleNamespace(key=lambda seq, timestamp: (seq, timestamp))
    track._record_output_trace = lambda context, key, pts, bounds, selected, timing, **flags: outputs.append(
        (key[0], bounds, timing["source"], flags))
    track._send_frame_trace_batch = lambda: None
    try:
        track.apply_media_profile({"width": 1280, "height": 720, "target_fps": 15})
        frame = await track.recv()
        assert (frame.width, frame.height) == (1152, 720)
        assert np.all(frame.to_ndarray(format="bgra") == 7)
        assert outputs == [(42, (100, 200), "cache", {"fresh": False, "reused": True})]
        assert track._last_img_capture == (42, (100, 200))
        assert releases == []
    finally:
        await track.shutdown()


@pytest.mark.asyncio
async def test_fps_change_preserves_inflight_image_and_reservations(monkeypatch):
    track, releases = epoch_track()
    track._capture_buffer = Screenshot(np.full((720, 1152, 4), 8, dtype=np.uint8))
    track._capture_seq = 43
    started, release = threading.Event(), threading.Event()
    original = track._process_screenshot

    def blocked(screenshot, *args):
        started.set()
        assert release.wait(timeout=2)
        return original(screenshot, *args)

    monkeypatch.setattr(track, "_process_screenshot", blocked)
    try:
        task = asyncio.create_task(track.recv())
        assert await asyncio.to_thread(started.wait, 1)
        track.apply_media_profile({"width": 1280, "height": 720, "target_fps": 15})
        release.set()
        frame = await asyncio.wait_for(task, 2)
        assert np.all(frame.to_ndarray(format="bgra") == 8)
        assert track._last_img_capture == (43, None)
        assert track._target_generation == 9
        assert releases == []
    finally:
        release.set()
        await track.shutdown()
