"""Bounded text admission with one daemon owning all file operations.

Formatting still runs on the producer. Short state/queue critical sections are
not a real-time guarantee. A stuck filesystem operation may outlive bounded stop.
"""
import logging
import math
import queue
import threading
import time
from logging.handlers import RotatingFileHandler

QUEUE_CAPACITY = 64
MAX_LINE_BYTES = 65536
MAX_COUNTER = 2**53 - 1
DEFAULT_TIMEOUT = 1.0
POLL_SECONDS = 0.05
_COUNTERS = ("accepted", "processed", "full", "oversize", "closed", "writer_error", "abandoned")


class OwnedRotatingSink(RotatingFileHandler):
    """Stdlib rotation, with no cross-thread I/O via logging.shutdown.

    Handler construction registers this sink with logging's public shutdown
    machinery. Non-owner flush/close must therefore be harmless, even when the
    writer is blocked. Never remove it from logging's private registries.
    """
    def __init__(self, filename, *, max_bytes, backup_count):
        self._owner = threading.current_thread()
        super().__init__(filename, maxBytes=max_bytes, backupCount=backup_count,
                         encoding="utf-8", delay=True)

    def createLock(self):
        self.lock = None

    def write(self, text):
        if threading.current_thread() is not self._owner:
            raise RuntimeError("Host log sink ownership violation")
        # Only this disposable text record reaches stdlib rollover. No original
        # args, extra, exception or frame graph crosses the admission boundary.
        record = logging.LogRecord("", logging.INFO, "", 0, text[:-1], (), None)
        if self.shouldRollover(record):
            self.doRollover()
        if self.stream is None:
            self.stream = self._open()
        # One exception boundary in the writer; avoid emit/handleError's raw
        # record/traceback fallback (and nested duplicate error accounting).
        self.stream.write(text)
        self.flush()

    def flush(self):
        if threading.current_thread() is self._owner:
            super().flush()

    def close(self):
        if threading.current_thread() is self._owner:
            super().close()

    def handleError(self, record):
        # Defensive: our write path never calls this stdlib fallback.
        return


def _budget(timeout):
    value = float(timeout)
    if not math.isfinite(value):
        return DEFAULT_TIMEOUT
    return max(0.0, value)


class BoundedLogHandler(logging.Handler):
    """Facade whose flush/stop wait without acquiring any producer I/O lock."""
    def __init__(self, sink_factory):
        super().__init__()
        self._condition = threading.Condition()
        self._queue = queue.Queue(maxsize=QUEUE_CAPACITY)
        self._counts = dict.fromkeys(_COUNTERS, 0)
        self._saturated = False
        self._accepting = True
        self._in_flight = 0
        self._admitted = 0
        self._completed = 0
        self._requested = -1
        self._flushed = -1
        self._failed = False
        self._aborting = False
        self._stop = threading.Event()
        self._done = threading.Event()
        self._stop_deadline = None
        self._writer = threading.Thread(target=self._run, args=(sink_factory,),
                                        name="wrd-host-log-writer", daemon=True)
        self._writer.start()

    def createLock(self):
        self.lock = None

    def _increment(self, name, amount=1):
        # Caller holds _condition; public counters are not watermark identities.
        value = self._counts[name] + amount
        if value >= MAX_COUNTER:
            self._saturated = True
        self._counts[name] = min(value, MAX_COUNTER)

    def emit(self, record):
        try:
            text = self.format(record) + "\n"
            size = len(text.encode("utf-8"))
        except Exception:
            with self._condition:
                self._increment("writer_error")
            return
        with self._condition:
            if not self._accepting:
                self._increment("closed")
            elif size > MAX_LINE_BYTES:
                self._increment("oversize")
            else:
                try:
                    self._queue.put_nowait((self._admitted + 1, text))
                except queue.Full:
                    self._increment("full")
                else:
                    self._admitted += 1
                    self._increment("accepted")
                    self._condition.notify_all()

    def snapshot(self):
        with self._condition:
            return dict(self._counts, saturated=self._saturated,
                        queue_depth=self._queue.qsize(), capacity=QUEUE_CAPACITY,
                        in_flight=self._in_flight, accepting=self._accepting,
                        writer_alive=self._writer.is_alive(),
                        stop_requested=self._stop.is_set(), stopped=self._done.is_set(),
                        failed=self._failed)

    def flush(self, timeout=DEFAULT_TIMEOUT):
        deadline = time.monotonic() + _budget(timeout)
        with self._condition:
            target = self._admitted
            self._requested = max(self._requested, target)
            self._condition.notify_all()
            while self._flushed < target:
                if self._failed or self._aborting or self._done.is_set():
                    return False
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._condition.wait(remaining)
            return not self._failed and not self._aborting

    def _abandon_queued(self):
        # Dequeue and abandonment are serialized so an in-flight item is never
        # also counted as abandoned. No I/O or waits occur under this lock.
        while True:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                break
            self._increment("abandoned")

    def shutdown(self, timeout=DEFAULT_TIMEOUT):
        now = time.monotonic()
        with self._condition:
            if self._stop_deadline is None:
                self._stop_deadline = now + _budget(timeout)
            deadline = self._stop_deadline
            self._accepting = False
            self._stop.set()
            self._requested = max(self._requested, self._admitted)
            self._condition.notify_all()
        if threading.current_thread() is not self._writer:
            self._writer.join(max(0.0, deadline - time.monotonic()))
        with self._condition:
            if self._writer.is_alive():
                self._aborting = True
                self._abandon_queued()
                self._condition.notify_all()
                return False
            return not self._failed and not self._aborting

    def close(self):
        result = self.shutdown()
        super().close()
        return result

    def _run(self, sink_factory):
        sink = None
        flush_target = None
        try:
            sink = sink_factory()
            while True:
                with self._condition:
                    if (self._stop_deadline is not None
                            and time.monotonic() >= self._stop_deadline):
                        self._aborting = True
                    if self._aborting:
                        break
                    # Freeze one prefix while later requests coalesce in one
                    # scalar. Later producers cannot keep moving this goalpost.
                    if flush_target is None and self._requested > self._flushed:
                        flush_target = self._requested
                    if flush_target is not None and self._completed >= flush_target:
                        action = "flush"
                    elif not self._queue.empty():
                        ticket, text = self._queue.get_nowait()
                        self._in_flight = 1
                        action = "write"
                    elif self._stop.is_set():
                        break
                    else:
                        self._condition.wait(POLL_SECONDS)
                        continue
                # All open/write/rotate/flush/close work happens outside locks.
                if action == "write":
                    try:
                        sink.write(text)
                    except Exception:
                        with self._condition:
                            self._increment("writer_error")
                            self._failed = True
                    finally:
                        # Release the last text reference before the next wait.
                        text = None
                        with self._condition:
                            self._completed = ticket
                            self._in_flight = 0
                            self._increment("processed")
                            self._condition.notify_all()
                else:
                    try:
                        sink.flush()
                    except Exception:
                        with self._condition:
                            self._increment("writer_error")
                            self._failed = True
                    with self._condition:
                        self._flushed = flush_target
                        flush_target = None
                        self._condition.notify_all()
        except Exception:
            with self._condition:
                self._increment("writer_error")
                self._failed = True
        finally:
            with self._condition:
                self._accepting = False
                self._abandon_queued()
                self._condition.notify_all()
            if sink is not None:
                try:
                    sink.close()
                except Exception:
                    with self._condition:
                        self._increment("writer_error")
                        self._failed = True
            with self._condition:
                self._done.set()
                self._condition.notify_all()
