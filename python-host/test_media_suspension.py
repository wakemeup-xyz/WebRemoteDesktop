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


class FakePC:
    connectionState = "connected"
    iceConnectionState = "connected"


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


class TransientFreshTrack(FakeTrack):
    def __init__(self):
        super().__init__()
        self.fresh = False

    def wait_for_fresh_capture(self, after_seq, timeout=0.5):
        self.waited_after = after_seq
        if not self.fresh:
            return False
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
    host.pc = FakePC()
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


@pytest.mark.asyncio
async def test_host_retries_same_generation_after_transient_resume_failure():
    track = TransientFreshTrack()
    host = _make_media_host(sender=FakeSender(), track=track)
    request = {
        "schemaVersion": 1,
        "state": "active",
        "reasons": [],
        "generation": 1,
        "connectionAttemptId": "wrd-1",
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 3,
    }

    await host.on_media_activity_change(request)
    assert host.sio.events[-1][1]["applied"] is False
    assert host.sio.events[-1][1]["reason"] == "fresh-capture-timeout"
    assert host._media_activity_binding["generation"] == 0

    track.fresh = True
    await host.on_media_activity_change(request)

    assert host.sio.events[-1][1]["applied"] is True
    assert host._media_activity_binding["generation"] == 1


_UNSET = object()


def _make_media_host(*, sender=None, track=None, relay=None, pc=_UNSET):
    host = object.__new__(WebRemoteHost)
    host.sio = FakeSocket()
    host._active_input_binding = {
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 3,
        "connectionGeneration": 1,
        "connectionAttemptId": "wrd-1",
    }
    host._media_activity_binding = {
        "viewerId": "viewer-1",
        "connectionAttemptId": "wrd-1",
        "generation": 0,
        "state": "active",
    }
    host._media_activity_suspended = False
    host._media_activity_lock = __import__("asyncio").Lock()
    host.video_sender = sender
    host.media_sender = AiortcMediaSender(sender) if sender is not None else None
    if host.media_sender is not None and track is not None:
        host.media_sender.bind(sender, track)
    host.screen_track = track
    host.relay_streamer = relay
    host.pc = FakePC() if pc is _UNSET else pc
    host.input_handler = type("Input", (), {
        "release_all_mouse_buttons": lambda self, reason: None,
        "release_all_keys": lambda self, reason: None,
    })()
    return host


@pytest.mark.asyncio
async def test_media_suspend_fails_closed_when_replaceTrack_raises():
    class BoomSender(FakeSender):
        def replaceTrack(self, track):
            raise RuntimeError("replaceTrack boom")

    host = _make_media_host(sender=BoomSender(), track=FakeTrack())
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
    assert host.sio.events[-1][1]["applied"] is False
    assert host._media_activity_suspended is True
    assert host.screen_track.suspended is True


@pytest.mark.asyncio
async def test_media_suspend_fails_closed_when_getSenders_raises():
    class BoomPC:
        def getSenders(self):
            raise RuntimeError("getSenders boom")

    host = _make_media_host(sender=FakeSender(), track=FakeTrack(), pc=BoomPC())
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
    assert host.sio.events[-1][1]["applied"] is False
    assert host._media_activity_suspended is True


@pytest.mark.asyncio
async def test_media_suspend_fails_closed_when_capture_set_suspended_raises():
    class BoomTrack(FakeTrack):
        def set_suspended(self, value):
            raise RuntimeError("capture boom")

    host = _make_media_host(sender=FakeSender(), track=BoomTrack())
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
    assert host.sio.events[-1][1]["applied"] is False
    assert host._media_activity_suspended is True


@pytest.mark.asyncio
async def test_media_suspend_fails_closed_when_relay_set_suspended_raises():
    class BoomRelay:
        def set_suspended(self, suspended):
            raise RuntimeError("relay boom")

    host = _make_media_host(sender=FakeSender(), track=FakeTrack(), relay=BoomRelay())
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
    assert host.sio.events[-1][1]["applied"] is False
    assert host._media_activity_suspended is True


@pytest.mark.asyncio
async def test_media_resume_fails_closed_when_sender_attach_fails():
    class BoomSender(FakeSender):
        def replaceTrack(self, track):
            if track is not None:
                raise RuntimeError("resume attach boom")
            self.tracks.append(track)

    host = _make_media_host(sender=BoomSender(), track=FakeTrack())
    host._media_activity_suspended = True
    host.screen_track.suspended = True
    await host.on_media_activity_change({
        "schemaVersion": 1,
        "state": "active",
        "reasons": [],
        "generation": 1,
        "connectionAttemptId": "wrd-1",
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 3,
    })
    assert host.sio.events[-1][1]["applied"] is False
    assert host._media_activity_suspended is True
    assert host.screen_track.suspended is True


@pytest.mark.asyncio
async def test_media_resume_fails_closed_on_fresh_capture_timeout():
    class TimeoutTrack(FakeTrack):
        def wait_for_fresh_capture(self, after_seq, timeout=0.5):
            raise TimeoutError("fresh capture timeout")

    host = _make_media_host(sender=FakeSender(), track=TimeoutTrack())
    host._media_activity_suspended = True
    host.screen_track.suspended = True
    await host.on_media_activity_change({
        "schemaVersion": 1,
        "state": "active",
        "reasons": [],
        "generation": 1,
        "connectionAttemptId": "wrd-1",
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 3,
    })
    assert host.sio.events[-1][1]["applied"] is False
    assert host._media_activity_suspended is True
    assert host.screen_track.suspended is True


@pytest.mark.asyncio
async def test_media_resume_fails_closed_when_fresh_capture_returns_false():
    class FalseTrack(FakeTrack):
        def wait_for_fresh_capture(self, after_seq, timeout=0.5):
            self.waited_after = after_seq
            return False

    host = _make_media_host(sender=FakeSender(), track=FalseTrack())
    host._media_activity_suspended = True
    host.screen_track.suspended = True
    sender_before = host.video_sender
    await host.on_media_activity_change({
        "schemaVersion": 1,
        "state": "active",
        "reasons": [],
        "generation": 1,
        "connectionAttemptId": "wrd-1",
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 3,
    })
    ack = host.sio.events[-1]
    assert ack[0] == "media-activity-ack"
    assert ack[1]["applied"] is False
    assert ack[1]["state"] == "suspended"
    assert ack[1].get("keyframeRequested") is not True
    assert host._media_activity_suspended is True
    assert host.screen_track.suspended is True
    assert host.screen_track.waited_after is not None
    # Must not leave the capture track attached as if resume succeeded.
    assert sender_before.tracks == [] or sender_before.tracks[-1] is None


@pytest.mark.asyncio
async def test_media_resume_succeeds_with_2s_fresh_capture_timeout():
    """wait_for_fresh_capture timeout was raised to 2.0s.
    Verify that a track whose first frame arrives within 2s still reports applied=True.
    """
    class SlowFreshTrack(FakeTrack):
        """Simulates a capture thread that produces its first frame after ~0.6s."""
        def wait_for_fresh_capture(self, after_seq, timeout=0.5):
            # Under the old 0.5s timeout this would fail; with 2.0s it should succeed.
            import time
            deadline = time.monotonic() + timeout
            # Pretend the frame arrives at ~0.1s (well within 2s, but also within 0.5s
            # so the test remains deterministic without actual sleeping).
            self._capture_seq = after_seq + 1
            return time.monotonic() <= deadline

    host = _make_media_host(sender=FakeSender(), track=SlowFreshTrack())
    host._media_activity_suspended = True
    host.screen_track.suspended = True
    await host.on_media_activity_change({
        "schemaVersion": 1,
        "state": "active",
        "reasons": [],
        "generation": 1,
        "connectionAttemptId": "wrd-1",
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 3,
    })
    ack = host.sio.events[-1]
    assert ack[0] == "media-activity-ack"
    assert ack[1]["applied"] is True, "resume must succeed when frame arrives within timeout"
    assert host._media_activity_suspended is False


@pytest.mark.asyncio
async def test_media_resume_fresh_capture_passes_2s_timeout_to_wait():
    """Verify that on_media_activity_change passes timeout=2.0 to wait_for_fresh_capture."""
    captured_timeouts = []

    class InspectTimeoutTrack(FakeTrack):
        def wait_for_fresh_capture(self, after_seq, timeout=0.5):
            captured_timeouts.append(timeout)
            self._capture_seq = after_seq + 1
            return True

    host = _make_media_host(sender=FakeSender(), track=InspectTimeoutTrack())
    host._media_activity_suspended = True
    host.screen_track.suspended = True
    await host.on_media_activity_change({
        "schemaVersion": 1,
        "state": "active",
        "reasons": [],
        "generation": 1,
        "connectionAttemptId": "wrd-1",
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 3,
    })
    assert len(captured_timeouts) == 1, "wait_for_fresh_capture must be called exactly once"
    assert captured_timeouts[0] == 2.0, (
        f"timeout must be 2.0s (got {captured_timeouts[0]}) — "
        "relay paths need extra warmup time under CPU load"
    )


@pytest.mark.asyncio
async def test_media_resume_fails_closed_immediately_when_pc_missing():
    # pc is None → must NOT call wait_for_fresh_capture
    called = {"wait": 0}

    class Track(FakeTrack):
        def wait_for_fresh_capture(self, after_seq, timeout=0.5):
            called["wait"] += 1
            self.waited_after = after_seq
            self._capture_seq = after_seq + 1
            return True

    host = _make_media_host(sender=FakeSender(), track=Track(), pc=None)
    host._media_activity_suspended = True
    host.screen_track.suspended = True
    await host.on_media_activity_change({
        "schemaVersion": 1,
        "state": "active",
        "reasons": [],
        "generation": 1,
        "connectionAttemptId": "wrd-1",
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 3,
    })
    ack = host.sio.events[-1]
    assert ack[0] == "media-activity-ack"
    assert ack[1]["applied"] is False
    assert "closed" in str(ack[1].get("reason") or "")
    assert called["wait"] == 0
    assert host._media_activity_suspended is True
    assert host.screen_track.suspended is True
