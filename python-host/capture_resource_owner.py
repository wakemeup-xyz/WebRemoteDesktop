"""Exactly-once capture resource closure, owned by the existing capture worker.

Only entry and closure acquire the claim lock. Snapshots copy an immutable
scalar publication and never wait for a native grab or close.
"""
from threading import Lock


class CaptureResourceOwner:
    def __init__(self, resource):
        self._resource = resource
        self._claim_lock = Lock()
        self._state = 'unclaimed'

    def claim_worker(self):
        with self._claim_lock:
            if self._state != 'unclaimed':
                return None
            self._state = 'worker-owned'
            return self._resource

    def _claim_close(self, expected):
        with self._claim_lock:
            if self._state != expected:
                return False, None
            self._state = 'closing'
            resource = self._resource
            self._resource = None
            return True, resource

    def _close(self, resource):
        state = 'close-failed'
        try:
            resource.close()
            state = 'closed'
        except Exception:
            # Fixed evidence only: never retain native exceptions or messages.
            pass
        finally:
            self._state = state

    def close_worker(self):
        won, resource = self._claim_close('worker-owned')
        if won:
            self._close(resource)

    def close_unclaimed(self):
        """Return whether fallback won the claim, independently of close success."""
        won, resource = self._claim_close('unclaimed')
        if won:
            self._close(resource)
        return won

    def snapshot(self):
        return {'state': self._state}
