import asyncio
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction

import av
import numpy as np
import pytest
from aiortc.mediastreams import MediaStreamError

import host
from host import ScreenCaptureTrack


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
    track._last_consumed_seq = -1
    track._last_img = None
    track._last_img_shape = (0, 0)
    track._last_img_target_generation = -1
    track._max_width = max_width
    track._max_height = max_height
    track.monitor = {"width": max_width, "height": max_height}
    track._target_fps = 30
    track._frame_interval = 0
    track._last_frame_time = 0
    track._process_executor = ThreadPoolExecutor(max_workers=1)
    track._reuse_count = 0
    track._total_reuse = 0
    track._timing_totals = {"sleep": 0.0, "capture_wait": 0.0, "convert": 0.0, "total": 0.0}
    track._timing_count = 0
    track._host_ref = None
    track._pending_input_lock = threading.Lock()
    track._pending_input_ids = set()
    track._pending_input_data = []
    track._timing_seq = 0
    track.frame_count = 0
    track.last_time = time.time()
    track._ps_count = 0
    track._capture_thread = None
    track.sct = None
    timestamps = iter(((9000, Fraction(1, 90000)), (12000, Fraction(1, 90000)), (15000, Fraction(1, 90000))))

    async def next_timestamp():
        return next(timestamps)

    track.next_timestamp = next_timestamp
    return track


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
    track = bare_track(max_width=1, max_height=1)
    track.monitor = {"width": 2, "height": 1}
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
        track.apply_media_profile({"width": 2, "height": 1, "target_fps": 30})
        release.set()
        frame = await asyncio.wait_for(recv_task, timeout=1)
    finally:
        track._process_executor.shutdown(wait=True)

    assert (frame.width, frame.height) == (320, 180)


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
