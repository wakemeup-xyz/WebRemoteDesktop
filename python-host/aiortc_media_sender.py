"""Small boundary around aiortc video sender suspend/resume.

Private keyframe hooks stay isolated here. If unavailable, resume still
reattaches the track and reports keyframeRequested=False.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


class AiortcMediaSender:
    def __init__(self, sender=None, pc=None):
        self._sender = sender
        self._enabled = True
        self._track = None
        self._pc = pc

    @property
    def sender(self):
        return self._sender

    @property
    def enabled(self):
        return self._enabled

    def bind(self, sender, track=None, pc=None):
        self._sender = sender
        if track is not None:
            self._track = track
        if pc is not None:
            self._pc = pc
        self._enabled = True

    def invalidate(self):
        self._sender = None
        self._track = None
        self._pc = None
        self._enabled = False

    def _set_transceiver_direction(self, direction: str) -> None:
        sender = self._sender
        pc = self._pc
        if sender is None or pc is None or not hasattr(pc, "getTransceivers"):
            return
        try:
            for tr in list(pc.getTransceivers() or []):
                if getattr(tr, "sender", None) is sender:
                    tr.direction = direction
                    return
        except Exception as exc:
            logger.debug("transceiver direction set failed: %s", type(exc).__name__)

    def suspend(self) -> bool:
        sender = self._sender
        if sender is None:
            self._enabled = False
            return False
        try:
            track = getattr(sender, "track", None)
            if track is not None and hasattr(track, "enabled"):
                try:
                    track.enabled = False
                except Exception:
                    pass
            sender.replaceTrack(None)
            self._set_transceiver_direction("inactive")
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
            if hasattr(track, "enabled"):
                try:
                    track.enabled = True
                except Exception:
                    pass
            self._set_transceiver_direction("sendonly")
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
