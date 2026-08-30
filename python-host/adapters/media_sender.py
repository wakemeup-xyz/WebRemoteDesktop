"""Media sender adapter preserving the aiortc sender implementation."""

from aiortc_media_sender import AiortcMediaSender


class MediaSenderAdapter:
    def __init__(self, implementation=None):
        self.implementation = implementation or AiortcMediaSender()

    @property
    def enabled(self):
        return self.implementation.enabled

    def bind(self, sender, track=None, pc=None):
        return self.implementation.bind(sender, track, pc)

    def invalidate(self):
        return self.implementation.invalidate()

    def suspend(self):
        return self.implementation.suspend()

    def resume(self, track=None):
        return self.implementation.resume(track)

    def request_keyframe(self):
        return self.implementation.request_keyframe()

    def __getattr__(self, name):
        return getattr(self.implementation, name)
