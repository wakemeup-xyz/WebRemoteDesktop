import threading

import pytest

from aiortc_media_sender import AiortcMediaSender
from host import ScreenCaptureTrack, WebRemoteHost


class FakeSender:
    def __init__(self):
        self.tracks = []
        self.keyframes = 0

    def replaceTrack(self, track):
        self.tracks.append(track)

    def _send_keyframe(self):
        self.keyframes += 1


def test_capture_suspension_clears_buffer_and_resets_frame_pacing():
    track = object.__new__(ScreenCaptureTrack)
    track._activity_condition = threading.Condition()
    track._suspended = False
    track._capture_generation = 0
    track._capture_lock = threading.Lock()
    track._pending_input_lock = threading.Lock()
    track._pending_input_ids = {"x"}
    track._pending_input_data = [{"a": 1}]
    track._capture_buffer = object()
    track._last_img = object()
    track._capture_seq = 4
    track._last_frame_time = 123
    track._capture_running = True

    baseline = track.set_suspended(True)

    assert baseline == 4
    assert track._suspended is True
    assert track._capture_buffer is None
    assert track._last_img is None
    assert track._pending_input_ids == set()
    assert track._pending_input_data == []
    assert track._capture_generation == 1

    track.set_suspended(False)
    assert track._last_frame_time == 0
    assert track._suspended is False


def test_capture_suspend_idempotent():
    track = object.__new__(ScreenCaptureTrack)
    track._activity_condition = threading.Condition()
    track._suspended = False
    track._capture_generation = 0
    track._capture_lock = threading.Lock()
    track._pending_input_lock = threading.Lock()
    track._pending_input_ids = set()
    track._pending_input_data = []
    track._capture_buffer = None
    track._last_img = None
    track._capture_seq = 1
    track._last_frame_time = 0
    track._capture_running = True

    track.set_suspended(True)
    gen = track._capture_generation
    track.set_suspended(True)
    assert track._capture_generation == gen


class FakeSocket:
    def __init__(self):
        self.events = []

    async def emit(self, event, payload):
        self.events.append((event, payload))


class FakeTrack:
    def __init__(self):
        self.suspended = False
        self.waited_after = None
        self._capture_seq = 10

    def set_suspended(self, value):
        self.suspended = bool(value)
        return self._capture_seq

    def wait_for_fresh_capture(self, after_seq, timeout=0.5):
        self.waited_after = after_seq
        self._capture_seq = after_seq + 1
        return True


@pytest.mark.asyncio
async def test_host_applies_suspend_and_resume_with_sender_and_capture():
    host = object.__new__(WebRemoteHost)
    host.sio = FakeSocket()
    host._active_input_binding = {
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 3,
        "connectionGeneration": 1,
    }
    host._media_activity_binding = None
    host._media_activity_suspended = False
    host._media_activity_lock = __import__("asyncio").Lock()
    host.video_sender = FakeSender()
    host.media_sender = AiortcMediaSender(host.video_sender)
    host.media_sender.bind(host.video_sender, object())
    host.screen_track = FakeTrack()
    host.relay_streamer = None
    host.input_handler = type("Input", (), {
        "release_all_mouse_buttons": lambda self, reason: None,
        "release_all_keys": lambda self, reason: None,
    })()

    await host.on_media_activity_change({
        "schemaVersion": 1,
        "state": "suspended",
        "reasons": ["manual-pause"],
        "generation": 1,
        "connectionAttemptId": "wrd-1",
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 3,
    })
    assert host._media_activity_suspended is True
    assert host.screen_track.suspended is True
    assert host.video_sender.tracks[-1] is None
    assert host.sio.events[-1][1]["applied"] is True

    await host.on_media_activity_change({
        "schemaVersion": 1,
        "state": "active",
        "reasons": [],
        "generation": 2,
        "connectionAttemptId": "wrd-1",
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 3,
    })
    assert host._media_activity_suspended is False
    assert host.screen_track.suspended is False
    assert host.screen_track.waited_after is not None
    assert host.video_sender.keyframes == 1
    assert host.sio.events[-1][1]["applied"] is True
    assert host.sio.events[-1][1]["keyframeRequested"] is True
