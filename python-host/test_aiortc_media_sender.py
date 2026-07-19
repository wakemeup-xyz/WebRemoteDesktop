from aiortc_media_sender import AiortcMediaSender, resume_sender, suspend_sender


class FakeSender:
    def __init__(self, has_keyframe=True):
        self.tracks = []
        self.keyframes = 0
        self._has_keyframe = has_keyframe

    def replaceTrack(self, track):
        self.tracks.append(track)

    def _send_keyframe(self):
        if not self._has_keyframe:
            raise AttributeError("no hook")
        self.keyframes += 1


def test_suspend_disables_sender_without_closing():
    sender = FakeSender()
    adapter = AiortcMediaSender(sender)
    track = object()
    adapter.bind(sender, track)
    assert adapter.suspend() is True
    assert sender.tracks == [None]
    assert adapter.enabled is False
    assert sender is adapter.sender


def test_resume_reattaches_and_requests_one_keyframe():
    sender = FakeSender()
    adapter = AiortcMediaSender(sender)
    track = object()
    adapter.bind(sender, track)
    adapter.suspend()
    result = adapter.resume(track)
    assert result["ok"] is True
    assert result["keyframeRequested"] is True
    assert sender.tracks == [None, track]
    assert sender.keyframes == 1
    assert adapter.enabled is True


def test_resume_without_keyframe_hook_still_succeeds():
    class NoKeyframeSender:
        def __init__(self):
            self.tracks = []

        def replaceTrack(self, track):
            self.tracks.append(track)

    sender = NoKeyframeSender()
    adapter = AiortcMediaSender(sender)
    track = object()
    adapter.bind(sender, track)
    result = adapter.resume(track)
    assert result["ok"] is True
    assert result["keyframeRequested"] is False
    assert sender.tracks == [track]


def test_idempotent_same_state_and_invalidate():
    sender = FakeSender()
    adapter = AiortcMediaSender(sender)
    track = object()
    adapter.bind(sender, track)
    assert adapter.suspend() is True
    assert adapter.suspend() is True
    adapter.invalidate()
    assert adapter.sender is None
    assert adapter.suspend() is False
    assert adapter.resume(track)["ok"] is False


def test_module_helpers_match_adapter():
    sender = FakeSender()
    track = object()
    suspend_sender(sender)
    assert sender.tracks[-1] is None
    assert resume_sender(sender, track) is True
    assert sender.tracks[-1] is track
