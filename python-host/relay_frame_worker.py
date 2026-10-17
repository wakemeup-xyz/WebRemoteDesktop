"""One dedicated thread, one running request and one replaceable pending request."""
import asyncio
import json
import threading
import time
from input_admission_queue import completed_future


def elapsed_ms(started_ns, now_ns):
    return None if started_ns is None else max(0, now_ns - started_ns) / 1_000_000


class RelayFrameWorker:
    def __init__(self, process, *, max_pending=1, now_ns=time.monotonic_ns):
        if max_pending != 1:
            raise ValueError('relay retains exactly one latest pending request')
        self._now_ns = now_ns
        self._processor_started_ns = None
        self._delivery_started_ns = None
        self._last_queue_wait_ms = None
        self._last_processor_ms = None
        self._last_delivery_wait_ms = None
        self._process = process
        self._loop = asyncio.get_running_loop()
        self._condition = threading.Condition()
        self._pending = None
        self._inflight = None
        self._delivery_pending = False
        self._generation = None
        self._stopping = False
        self._stopped = self._loop.create_future()
        self._idle = asyncio.Event()
        self._idle.set()
        self._dropped = 0
        self._thread = threading.Thread(target=self._run, name='relay-jpeg', daemon=True)
        self._thread.start()

    def submit_latest(self, request):
        byte_count = len(json.dumps(request, separators=(',', ':')).encode('utf-8'))
        with self._condition:
            if self._generation is None:
                self._generation = request.get('generation')
            if self._stopping or byte_count > 4096 or request.get('generation') != self._generation:
                self._dropped += 1
                return completed_future(None)
            if self._pending:
                self._finish(self._pending[2], None)
                self._dropped += 1
            future = self._loop.create_future()
            self._pending = (request, byte_count, future, self._now_ns())
            self._idle.clear()
            self._condition.notify()
            return future

    @staticmethod
    def _finish(future, result):
        if not future.done():
            future.set_result(result)

    def invalidate(self, generation):
        with self._condition:
            self._generation = generation
            if self._pending:
                self._finish(self._pending[2], None)
                self._pending = None
                self._dropped += 1
            if self._inflight is None and not self._delivery_pending:
                self._idle.set()

    def _complete(self, item, result, error):
        with self._condition:
            self._last_delivery_wait_ms = elapsed_ms(self._delivery_started_ns, self._now_ns())
            self._delivery_started_ns = None
            self._delivery_pending = False
            self._condition.notify()
            valid = not self._stopping and item[0].get('generation') == self._generation
            if not valid:
                self._dropped += 1
            if error and valid and not item[2].done():
                item[2].set_exception(error)
            else:
                self._finish(item[2], result if valid else None)
            if self._pending is None and self._inflight is None:
                self._idle.set()

    def _run(self):
        try:
            while True:
                with self._condition:
                    while (self._pending is None or self._delivery_pending) and not self._stopping:
                        self._condition.wait()
                    if self._stopping:
                        break
                    item, self._pending = self._pending, None
                    self._inflight = item
                    now = self._now_ns()
                    self._last_queue_wait_ms = elapsed_ms(item[3], now)
                    self._processor_started_ns = now
                result, error, encoded = None, None, None
                try:
                    result = self._process(item[0])
                    encoded = result.get('data') if isinstance(result, dict) else result
                    if isinstance(encoded, (bytes, bytearray)) and len(encoded) > 16 * 1024 * 1024:
                        raise ValueError('relay output exceeds budget')
                except Exception as exc:
                    error = exc
                with self._condition:
                    now = self._now_ns()
                    self._last_processor_ms = elapsed_ms(self._processor_started_ns, now)
                    self._processor_started_ns = None
                    self._inflight = None
                    self._delivery_pending = True
                    self._delivery_started_ns = now
                self._loop.call_soon_threadsafe(self._complete, item, result, error)
                # Do not retain the encoded result between jobs.
                item = result = error = encoded = None
        finally:
            try:
                close = getattr(self._process, 'close', None)
                if close:
                    close()
            finally:
                self._loop.call_soon_threadsafe(self._finish, self._stopped, True)
                self._loop.call_soon_threadsafe(self._idle.set)

    async def drain(self):
        await self._idle.wait()

    async def stop(self):
        with self._condition:
            self._stopping = True
            if self._pending:
                self._finish(self._pending[2], None)
                self._pending = None
                self._dropped += 1
            self._condition.notify()
        try:
            await asyncio.wait_for(asyncio.shield(self._stopped), 2)
            return True
        except asyncio.TimeoutError:
            return False

    @property
    def stopped(self):
        return self._stopped.done()

    def snapshot(self):
        with self._condition:
            now = self._now_ns()
            return dict(processorActive=self._inflight is not None, deliveryPending=self._delivery_pending,
                        pendingAgeMs=elapsed_ms(self._pending[3] if self._pending else None, now),
                        processorAgeMs=elapsed_ms(self._processor_started_ns, now),
                        deliveryAgeMs=elapsed_ms(self._delivery_started_ns, now),
                        lastQueueWaitMs=self._last_queue_wait_ms, lastProcessorMs=self._last_processor_ms,
                        lastDeliveryWaitMs=self._last_delivery_wait_ms, pendingCount=int(self._pending is not None), pendingBytes=self._pending[1] if self._pending else 0,
                        inFlightCount=int(self._inflight is not None or self._delivery_pending), droppedCount=self._dropped, frozen=self._stopping)
