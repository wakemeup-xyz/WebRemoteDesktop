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


class RelayCaptureEncodeWorker:
    """Bounded latest-slot capture/encode pipeline for the tunnel relay.

    Capture and JPEG encoding deliberately run on different native threads.  Each
    stage has one running item and one replaceable pending item, so a slow encoder
    can never grow a queue or make the caller wait for a native ``recv``/capture
    operation.  The capture processor owns native screen resources; the encoder
    only receives a detached frame package and releases it after encoding.

    ``RelayFrameWorker`` remains available for simple one-stage processors and for
    compatibility with existing fixtures.  This class is the production path for
    ``RelayJpegProcessor``.
    """

    def __new__(cls, processor, *args, **kwargs):
        # Keep old one-stage processors (and their test doubles) operational
        # while the production processor opts into the split pipeline. Because
        # the returned object is not an instance of this class, Python skips our
        # initializer and the legacy worker owns its usual shutdown contract.
        if not (callable(getattr(processor, 'capture', None))
                and callable(getattr(processor, 'encode', None))):
            return RelayFrameWorker(processor, *args, **kwargs)
        return super().__new__(cls)

    def __init__(self, processor, *, max_pending=1, now_ns=time.monotonic_ns):
        if max_pending != 1:
            raise ValueError('relay retains exactly one latest pending request per stage')
        if not callable(getattr(processor, 'capture', None)) or not callable(getattr(processor, 'encode', None)):
            raise TypeError('capture/encode processor must expose capture() and encode()')
        self._processor = processor
        self._now_ns = now_ns
        self._loop = asyncio.get_running_loop()
        self._loop_thread_id = threading.get_ident()
        self._condition = threading.Condition()
        self._capture_pending = None
        self._capture_inflight = None
        self._encode_pending = None
        self._encode_inflight = None
        self._delivery_pending = False
        self._capture_started_ns = None
        self._encode_started_ns = None
        self._delivery_started_ns = None
        self._last_capture_ms = None
        self._last_encode_ms = None
        self._last_capture_queue_wait_ms = None
        self._last_encode_queue_wait_ms = None
        self._last_delivery_wait_ms = None
        self._generation = None
        self._stopping = False
        self._capture_stopped = False
        self._encode_stopped = False
        self._stopped = self._loop.create_future()
        self._idle = asyncio.Event()
        self._idle.set()
        self._dropped = 0
        self._coalesced = 0
        self._capture_thread = threading.Thread(target=self._capture_run, name='relay-capture', daemon=True)
        self._encode_thread = threading.Thread(target=self._encode_run, name='relay-jpeg', daemon=True)
        self._capture_thread.start()
        self._encode_thread.start()

    @staticmethod
    def _finish(future, result):
        if not future.done():
            future.set_result(result)

    def _resolve(self, future, result):
        """Resolve a loop-owned Future without mutating it from a stage thread."""
        if future.done():
            return
        if threading.get_ident() == self._loop_thread_id:
            self._finish(future, result)
        else:
            self._loop.call_soon_threadsafe(self._finish, future, result)

    def _release_capture(self, captured):
        if captured is None:
            return
        release = getattr(self._processor, 'release', None)
        if callable(release):
            try:
                release(captured)
                return
            except Exception:
                return
        image = captured.get('image') if isinstance(captured, dict) else None
        close = getattr(image, 'close', None)
        if callable(close):
            try:
                close()
            except Exception:
                pass

    def submit_latest(self, request):
        byte_count = len(json.dumps(request, separators=(',', ':')).encode('utf-8'))
        with self._condition:
            generation = request.get('generation')
            if self._generation is None:
                self._generation = generation
            if (self._stopping or byte_count > 4096 or generation != self._generation):
                self._dropped += 1
                return completed_future(None)
            if self._capture_pending:
                self._resolve(self._capture_pending[2], None)
                self._capture_pending = None
                self._dropped += 1
                self._coalesced += 1
            future = self._loop.create_future()
            self._capture_pending = (request, byte_count, future, self._now_ns())
            self._idle.clear()
            self._condition.notify_all()
            return future

    def invalidate(self, generation):
        with self._condition:
            self._generation = generation
            if self._capture_pending:
                self._resolve(self._capture_pending[2], None)
                self._capture_pending = None
                self._dropped += 1
            if self._encode_pending:
                item = self._encode_pending
                self._encode_pending = None
                self._resolve(item[2], None)
                self._release_capture(item[1])
                self._dropped += 1
            if (self._capture_inflight is None and self._encode_inflight is None
                    and not self._delivery_pending):
                self._idle.set()
            self._condition.notify_all()

    def _publish_capture(self, item, captured, error):
        with self._condition:
            valid = not self._stopping and item[0].get('generation') == self._generation
            if error or not valid or captured is None:
                self._resolve(item[2], None)
                if captured is not None:
                    self._release_capture(captured)
                self._dropped += 1
            else:
                if self._encode_pending:
                    old = self._encode_pending
                    self._encode_pending = None
                    self._resolve(old[2], None)
                    self._release_capture(old[1])
                    self._dropped += 1
                    self._coalesced += 1
                self._encode_pending = (item[0], captured, item[2], item[3], self._now_ns())
            self._capture_inflight = None
            self._capture_started_ns = None
            self._condition.notify_all()
            if (self._capture_pending is None and self._encode_pending is None
                    and self._capture_inflight is None and self._encode_inflight is None
                    and not self._delivery_pending):
                self._idle.set()

    def _complete(self, item, result, error):
        with self._condition:
            self._last_delivery_wait_ms = elapsed_ms(self._delivery_started_ns, self._now_ns())
            self._delivery_started_ns = None
            self._delivery_pending = False
            valid = not self._stopping and item[0].get('generation') == self._generation
            if not valid:
                self._dropped += 1
            if error and valid and not item[2].done():
                item[2].set_exception(error)
            else:
                self._resolve(item[2], result if valid else None)
            self._condition.notify_all()
            if (self._capture_pending is None and self._encode_pending is None
                    and self._capture_inflight is None and self._encode_inflight is None
                    and not self._delivery_pending):
                self._idle.set()

    def _capture_run(self):
        try:
            while True:
                with self._condition:
                    while self._capture_pending is None and not self._stopping:
                        self._condition.wait()
                    if self._stopping:
                        break
                    item, self._capture_pending = self._capture_pending, None
                    self._capture_inflight = item
                    now = self._now_ns()
                    self._last_capture_queue_wait_ms = elapsed_ms(item[3], now)
                    self._capture_started_ns = now
                captured, error = None, None
                try:
                    captured = self._processor.capture(item[0])
                except Exception as exc:
                    error = exc
                with self._condition:
                    self._last_capture_ms = elapsed_ms(self._capture_started_ns, self._now_ns())
                self._publish_capture(item, captured, error)
        finally:
            # MSS/native capture belongs to the capture stage.  It is closed on
            # that stage's thread as soon as no further grab can occur; the
            # encoder can safely drain detached PIL buffers afterwards.
            close = getattr(self._processor, 'close', None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass
            with self._condition:
                self._capture_stopped = True
                self._condition.notify_all()
            self._maybe_finish_stop()

    def _encode_run(self):
        try:
            while True:
                with self._condition:
                    while ((self._encode_pending is None or self._delivery_pending)
                           and not self._stopping):
                        self._condition.wait()
                    if self._stopping:
                        break
                    item, self._encode_pending = self._encode_pending, None
                    self._encode_inflight = item
                    now = self._now_ns()
                    self._last_encode_queue_wait_ms = elapsed_ms(item[4], now)
                    self._encode_started_ns = now
                result, error = None, None
                try:
                    result = self._processor.encode(item[1], item[0])
                except Exception as exc:
                    error = exc
                finally:
                    # The encoder stage owns the detached package for the whole
                    # call.  Release it on both success and error so a custom
                    # processor cannot retain an image after delivery.
                    self._release_capture(item[1])
                with self._condition:
                    self._last_encode_ms = elapsed_ms(self._encode_started_ns, self._now_ns())
                    self._encode_started_ns = None
                    self._encode_inflight = None
                    self._delivery_pending = True
                    self._delivery_started_ns = self._now_ns()
                self._loop.call_soon_threadsafe(self._complete, item, result, error)
                item = result = error = None
        finally:
            with self._condition:
                self._encode_stopped = True
                self._condition.notify_all()
            self._maybe_finish_stop()

    def _maybe_finish_stop(self):
        with self._condition:
            done = self._capture_stopped and self._encode_stopped
        if done:
            self._loop.call_soon_threadsafe(self._finish, self._stopped, True)
            self._loop.call_soon_threadsafe(self._idle.set)

    async def drain(self):
        await self._idle.wait()

    async def stop(self):
        with self._condition:
            self._stopping = True
            if self._capture_pending:
                self._resolve(self._capture_pending[2], None)
                self._capture_pending = None
                self._dropped += 1
            if self._encode_pending:
                item = self._encode_pending
                self._encode_pending = None
                self._resolve(item[2], None)
                self._release_capture(item[1])
                self._dropped += 1
            self._condition.notify_all()
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
            active_started_ns = (self._encode_started_ns
                                 if self._encode_started_ns is not None
                                 else self._capture_started_ns)
            return dict(
                processorActive=self._capture_inflight is not None or self._encode_inflight is not None,
                deliveryPending=self._delivery_pending,
                pendingAgeMs=elapsed_ms(
                    self._capture_pending[3] if self._capture_pending else
                    (self._encode_pending[4] if self._encode_pending else None), now),
                processorAgeMs=elapsed_ms(active_started_ns, now),
                deliveryAgeMs=elapsed_ms(self._delivery_started_ns, now),
                lastQueueWaitMs=self._last_capture_queue_wait_ms,
                lastProcessorMs=self._last_encode_ms,
                lastDeliveryWaitMs=self._last_delivery_wait_ms,
                captureActive=self._capture_inflight is not None,
                encodeActive=self._encode_inflight is not None,
                capturePendingCount=int(self._capture_pending is not None),
                encodePendingCount=int(self._encode_pending is not None),
                lastCaptureMs=self._last_capture_ms,
                lastEncodeMs=self._last_encode_ms,
                lastCaptureQueueWaitMs=self._last_capture_queue_wait_ms,
                lastEncodeQueueWaitMs=self._last_encode_queue_wait_ms,
                pendingCount=int(self._capture_pending is not None or self._encode_pending is not None),
                pendingBytes=(self._capture_pending[1] if self._capture_pending else 0),
                inFlightCount=int(self._capture_inflight is not None or self._encode_inflight is not None or self._delivery_pending),
                droppedCount=self._dropped,
                coalescedCount=self._coalesced,
                frozen=self._stopping,
            )
