"""Small boundary around aiortc video sender suspend/resume.

Private keyframe hooks stay isolated here. If unavailable, resume still
reattaches the track and reports keyframeRequested=False.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


class AiortcMediaSender:
    def __init__(self, sender=None):
        self._sender = sender
        self._enabled = True
        self._track = None

    @property
    def sender(self):
        return self._sender

    @property
    def enabled(self):
        return self._enabled

    def bind(self, sender, track=None):
        self._sender = sender
        if track is not None:
            self._track = track
        self._enabled = True

    def invalidate(self):
        self._sender = None
        self._track = None
        self._enabled = False

    def suspend(self) -> bool:
        sender = self._sender
        if sender is None:
            self._enabled = False
            return False
        try:
            sender.replaceTrack(None)
            self._enabled = False
            return True
        except Exception as exc:
            logger.warning("aiortc suspend failed: %s", type(exc).__name__)
            self._enabled = False
            return False

    def resume(self, track=None) -> dict:
        sender = self._sender
        track = track if track is not None else self._track
        if track is not None:
            self._track = track
        if sender is None or track is None:
            self._enabled = False
            return {"ok": False, "keyframeRequested": False}
        try:
            sender.replaceTrack(track)
            self._enabled = True
            keyframe = self.request_keyframe()
            return {"ok": True, "keyframeRequested": keyframe}
        except Exception as exc:
            logger.warning("aiortc resume failed: %s", type(exc).__name__)
            return {"ok": False, "keyframeRequested": False}

    def request_keyframe(self) -> bool:
        sender = self._sender
        if sender is None:
            return False
        callback = getattr(sender, "_send_keyframe", None)
        if not callable(callback):
            logger.debug("aiortc sender has no keyframe request hook")
            return False
        try:
            callback()
            return True
        except Exception as exc:
            logger.warning("aiortc keyframe request failed: %s", type(exc).__name__)
            return False


def suspend_sender(sender) -> None:
    if sender is None:
        return
    AiortcMediaSender(sender).suspend()


def resume_sender(sender, track) -> bool:
    if sender is None:
        return False
    return AiortcMediaSender(sender).resume(track).get("keyframeRequested", False)


def request_keyframe(sender) -> bool:
    if sender is None:
        return False
    return AiortcMediaSender(sender).request_keyframe()
