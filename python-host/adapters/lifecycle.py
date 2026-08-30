"""Lifecycle coordinator for deterministic, idempotent Host shutdown."""


class LifecycleCoordinator:
    def __init__(self, close_peer=None, stop_relay=None, disconnect=None, stop_overlay=None):
        self.close_peer = close_peer
        self.stop_relay = stop_relay
        self.disconnect = disconnect
        self.stop_overlay = stop_overlay
        self._closed = False

    @property
    def closed(self):
        return self._closed

    async def shutdown(self):
        if self._closed:
            return False
        self._closed = True
        if self.stop_relay is not None:
            await self.stop_relay()
        if self.close_peer is not None:
            await self.close_peer()
        if self.disconnect is not None:
            await self.disconnect()
        if self.stop_overlay is not None:
            self.stop_overlay()
        return True
