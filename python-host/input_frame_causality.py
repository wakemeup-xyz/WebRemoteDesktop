"""Bounded observations only; never grants input or holds pixels/payloads."""
import threading
import time
from collections import OrderedDict

class InputFrameCausality:
    def __init__(self, *, now_ns=time.monotonic_ns, max_pending=512):
        self._now = now_ns
        self._limit = min(512, max(1, max_pending))
        self._scope = None
        self._pending = OrderedDict()
        self._reservations = OrderedDict()
        self._lock = threading.RLock()
        self.unmatched = 0

    def reset_scope(self, scope):
        with self._lock:
            if scope != self._scope:
                self.unmatched += len(self._pending)
                self._pending.clear(); self._reservations.clear()
                self._scope = scope

    def _expire(self):
        now = self._now()
        for key, applied in list(self._pending.items()):
            if now - applied >= 10_000_000_000:
                del self._pending[key]; self.unmatched += 1
        for key, ids in list(self._reservations.items()):
            live = tuple(i for i in ids if i in self._pending)
            if live: self._reservations[key] = live
            else: del self._reservations[key]

    def note_applied(self, input_ids, *, scope, applied_ns, status):
        with self._lock:
            self._expire()
            if status != 'applied' or scope != self._scope or not isinstance(input_ids, (list, tuple)): return 0
            count = 0
            for identifier in input_ids[:64]:
                if not isinstance(identifier, str) or not 1 <= len(identifier) <= 128 or not identifier.isascii(): continue
                if identifier in self._pending: continue
                while len(self._pending) >= self._limit:
                    self._pending.popitem(last=False); self.unmatched += 1
                self._pending[identifier] = int(applied_ns); count += 1
            return count

    def reserve_for_capture(self, frame_key, *, capture_started_ns, reused, scope):
        with self._lock:
            self._expire()
            if (reused or scope != self._scope or scope is None
                or (frame_key.attempt_id, frame_key.generation) != scope[:2]): return ()
            if frame_key in self._reservations: return self._reservations[frame_key]
            reserved = {i for ids in self._reservations.values() for i in ids}
            ids = tuple(i for i, at in self._pending.items() if at < capture_started_ns and i not in reserved)[:64]
            if ids:
                while len(self._reservations) >= 4:
                    self._reservations.popitem(last=False); self.unmatched += 1
                self._reservations[frame_key] = ids
            return ids

    def find_frame(self, encoder_timestamp):
        with self._lock:
            self._expire()
            keys = [k for k in self._reservations if k.encoder_timestamp == encoder_timestamp]
            return keys[0] if len(keys) == 1 else None

    def commit_first_packet(self, frame_key, *, wire_timestamp, ssrc, scope):
        with self._lock:
            self._expire()
            if scope != self._scope or not 0 <= wire_timestamp <= 0xffffffff or not 0 <= ssrc <= 0xffffffff: return ()
            ids = self._reservations.pop(frame_key, ())
            for identifier in ids: self._pending.pop(identifier, None)
            return ids

    def release_capture(self, frame_key):
        with self._lock: self._reservations.pop(frame_key, None)

    def release_all(self):
        with self._lock: self._reservations.clear()

    def snapshot(self):
        with self._lock:
            self._expire()
            return {'pending': len(self._pending), 'reservations': len(self._reservations), 'unmatched': self.unmatched}
