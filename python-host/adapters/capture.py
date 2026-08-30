"""Capture adapter with an explicit lifecycle and fresh-frame contract."""

from __future__ import annotations


class CaptureAdapter:
    def __init__(self, track=None, factory=None):
        self._track = track
        self._factory = factory

    @property
    def track(self):
        return self._track

    def start(self, **kwargs):
        if self._track is None and self._factory is not None:
            self._track = self._factory(**kwargs)
        return self._track

    def suspend(self):
        if self._track is None:
            return False
        return self._track.set_suspended(True)

    def resume(self):
        if self._track is None:
            return False
        return self._track.set_suspended(False)

    async def shutdown(self):
        if self._track is None:
            return
        await self._track.shutdown()
        self._track = None

    def __getattr__(self, name):
        if self._track is None:
            raise AttributeError(name)
        return getattr(self._track, name)
