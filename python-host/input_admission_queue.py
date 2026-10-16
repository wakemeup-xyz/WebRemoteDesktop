"""Loop-owned bounded input admission. Never cancel native work to fake quiescence."""
import asyncio
import time
from collections import deque
from dataclasses import dataclass
from contextvars import ContextVar

# Adapter code captures this callable before submitting to its native executor.
input_commit_fence = ContextVar('input_commit_fence', default=lambda: True)
input_queued_ns = ContextVar('input_queued_ns', default=None)


@dataclass(frozen=True)
class AdmissionResult:
    outcome: str
    result: dict | None


def completed_future(value):
    future = asyncio.get_running_loop().create_future()
    future.set_result(value)
    return future


class InputAdmissionQueue:
    def __init__(self, execute, authority_matches, max_pending=64, max_pending_bytes=262144):
        self.execute = execute
        self.authority_matches = authority_matches
        self.max_pending = max_pending
        self.max_pending_bytes = max_pending_bytes
        self._pending = deque()
        self._bytes = 0
        self._move = None
        self._inflight = None
        self._task = None
        self._reset_task = None
        self._frozen = False
        self._requires_reset = False
        self._dropped = 0
        self._move_dropped = 0

    def submit(self, data, *, authority, byte_count):
        if not self.authority_matches(authority):
            return completed_future(AdmissionResult('cancelled', None))
        if self._frozen:
            if self._requires_reset:
                self._dropped += 1
            outcome = 'resync-required' if self._requires_reset else 'cancelled'
            return completed_future(AdmissionResult(outcome, None))
        move = data.get('type') == 'mouse' and data.get('action') == 'move'
        invalid_size = type(byte_count) is not int or byte_count < 0 or byte_count > (1024 if move else 65536)
        if invalid_size or (not move and (
            len(self._pending) >= self.max_pending or self._bytes + byte_count > self.max_pending_bytes
        )):
            self.freeze(authority, 'input-overload')
            self._dropped += 1
            return completed_future(AdmissionResult('resync-required', None))
        future = asyncio.get_running_loop().create_future()
        item = (data, authority, byte_count, future, time.perf_counter_ns())
        if move:
            if self._move is not None:
                self._finish(self._move, AdmissionResult('cancelled', None))
                self._move_dropped += 1
            self._move = item
        else:
            self._pending.append(item)
            self._bytes += byte_count
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._drain())
        return future

    @staticmethod
    def _finish(item, result):
        if not item[3].done():
            item[3].set_result(result)

    async def _drain(self):
        while not self._frozen and (self._pending or self._move is not None):
            if self._pending:
                item = self._pending.popleft()
                self._bytes -= item[2]
            else:
                item, self._move = self._move, None
            data, authority, _, _, queued_ns = item
            if not self.authority_matches(authority):
                self._finish(item, AdmissionResult('cancelled', None))
                continue
            self._inflight = item
            token = input_commit_fence.set(lambda: self.authority_matches(authority))
            timing_token = input_queued_ns.set(queued_ns)
            try:
                result = await self.execute(data, authority)
                outcome = 'applied' if self.authority_matches(authority) else 'cancelled'
                self._finish(item, AdmissionResult(outcome, result if outcome == 'applied' else None))
            except Exception:
                result = AdmissionResult('applied', {'status': 'execution-failed'}) if self.authority_matches(authority) else AdmissionResult('cancelled', None)
                self._finish(item, result)
                self.freeze(authority, 'execution-failed')
            finally:
                input_commit_fence.reset(token)
                input_queued_ns.reset(timing_token)
                self._inflight = None

    def freeze(self, scope, reason):
        self._frozen = True
        if reason != 'authority-transition':
            self._requires_reset = True

    def resume(self):
        """Only C may reopen admission after successful reset/bind."""
        if self._requires_reset or self._pending or self._move is not None or self._inflight is not None or (self._reset_task and not self._reset_task.done()):
            return False
        self._frozen = False
        return True

    async def reset_after_quiescent(self, old_scope, apply_reset):
        self.freeze(old_scope, 'reset')
        while self._pending:
            self._finish(self._pending.popleft(), AdmissionResult('cancelled', None))
        self._bytes = 0
        if self._move is not None:
            self._finish(self._move, AdmissionResult('cancelled', None))
            self._move = None
        # Reuse a still-running barrier after timeout; never schedule a second reset.
        if self._reset_task is None or self._reset_task.done():
            async def barrier():
                if self._task is not None:
                    await asyncio.shield(self._task)
                return await apply_reset()
            self._reset_task = asyncio.create_task(barrier())
        try:
            result = await asyncio.wait_for(asyncio.shield(self._reset_task), 2)
            if isinstance(result, dict) and result.get('status') == 'applied':
                self._requires_reset = False
                return result
            return {'status': 'rejected'}
        except Exception:
            return {'status': 'rejected'}

    def snapshot(self):
        return dict(pendingCount=len(self._pending), pendingBytes=self._bytes,
                    inFlightCount=int(self._inflight is not None and not (
                        self._inflight[0].get('type') == 'mouse' and self._inflight[0].get('action') == 'move')),
                    droppedCount=self._dropped, frozen=self._frozen)

    def unordered_snapshot(self):
        return dict(pendingCount=int(self._move is not None), pendingBytes=self._move[2] if self._move else 0,
                    inFlightCount=int(self._inflight is not None and self._inflight[0].get('type') == 'mouse'
                                      and self._inflight[0].get('action') == 'move'),
                    droppedCount=self._move_dropped, frozen=self._frozen)
