"""Pure logging tests: never import Host or native/runtime adapters."""
import io
import logging
import threading
import time
import weakref

import pytest

from bounded_log_writer import BoundedLogHandler, MAX_COUNTER, OwnedRotatingSink


class GatedSink:
    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.lines = []
        self.owners = []

    def write(self, text):
        self.owners.append(threading.current_thread())
        self.entered.set()
        assert self.release.wait(5), "test failed to release writer"
        self.lines.append(text)

    def flush(self):
        self.owners.append(threading.current_thread())

    def close(self):
        self.owners.append(threading.current_thread())


def record(text):
    return logging.LogRecord("test", logging.INFO, "", 0, text, (), None)


def test_blocked_sink_has_64_queued_plus_one_inflight_and_nonblocking_producers():
    sink = GatedSink()
    handler = BoundedLogHandler(lambda: sink)
    try:
        handler.handle(record("inflight"))
        assert sink.entered.wait(1)
        for index in range(64):
            handler.handle(record(str(index)))
        producer = threading.Thread(target=handler.handle, args=(record("full"),))
        producer.start()
        producer.join(0.5)
        assert not producer.is_alive()
        stats = handler.snapshot()
        assert stats["accepted"] == 65
        assert stats["queue_depth"] == 64
        assert stats["in_flight"] == 1
        assert stats["full"] == 1
        assert handler.flush(timeout=0.02) is False
    finally:
        sink.release.set()
        assert handler.shutdown(timeout=1)
        handler.close()
    assert sink.lines == ["inflight\n"] + [str(index) + "\n" for index in range(64)]
    assert all(owner is handler._writer for owner in sink.owners)


@pytest.fixture
def managed_handler():
    owned = []

    def make(sink=None):
        sink = sink or GatedSink()
        handler = BoundedLogHandler(lambda: sink)
        owned.append((handler, sink))
        return handler, sink

    yield make
    for handler, sink in owned:
        sink.release.set()
        for gate in ("flush_release", "close_release"):
            if hasattr(sink, gate):
                getattr(sink, gate).set()
        handler.shutdown(timeout=1)
        handler._writer.join(1)
        handler.close()
        assert not handler._writer.is_alive(), "owned test writer leaked"


def test_whole_utf8_line_limit_and_no_original_record_graph(managed_handler):
    handler, sink = managed_handler()
    handler.handle(record("first"))
    assert sink.entered.wait(1)
    class Payload:
        def __str__(self):
            return "immutable"
    payload = Payload()
    original = record("%s")
    original.args = (payload,)
    original.extra = payload
    reference = weakref.ref(payload)
    handler.handle(original)
    del original, payload
    assert reference() is None
    exact = "é" * 32767 + "a"  # 65535 UTF-8 bytes, plus newline.
    handler.handle(record(exact))
    handler.handle(record(exact + "b"))
    assert handler.snapshot()["accepted"] == 3
    assert handler.snapshot()["oversize"] == 1
    sink.release.set()
    assert handler.flush(1)
    assert sink.lines == ["first\n", "immutable\n", exact + "\n"]


def test_stop_full_queue_is_bounded_abandons_exact_queue_and_never_closes_on_caller(managed_handler):
    handler, sink = managed_handler()
    handler.handle(record("blocked"))
    assert sink.entered.wait(1)
    for _ in range(64):
        handler.handle(record("queued"))
    start = time.monotonic()
    assert handler.shutdown(0.03) is False
    assert time.monotonic() - start < 0.5
    stats = handler.snapshot()
    assert stats["abandoned"] == 64
    assert stats["queue_depth"] == 0
    assert stats["in_flight"] == 1
    assert stats["writer_alive"] and stats["stop_requested"]
    assert len(sink.owners) == 1  # Still only the blocked write.
    handler.handle(record("closed"))
    assert handler.snapshot()["closed"] == 1
    start = time.monotonic()
    assert handler.close() is False
    assert time.monotonic() - start < 0.2
    sink.release.set()
    handler._writer.join(1)
    assert not handler._writer.is_alive()
    assert sink.lines == ["blocked\n"]
    assert all(owner is handler._writer for owner in sink.owners)


def test_flush_wait_does_not_lock_producers(managed_handler):
    handler, sink = managed_handler()
    handler.handle(record("blocked"))
    assert sink.entered.wait(1)
    outcome = []
    waiter = threading.Thread(target=lambda: outcome.append(handler.flush(0.15)))
    waiter.start()
    try:
        producer = threading.Thread(target=handler.handle, args=(record("later"),))
        producer.start()
        producer.join(0.3)
        assert not producer.is_alive()
        waiter.join(0.5)
        assert outcome == [False]
    finally:
        sink.release.set()
        waiter.join(1)


class PrefixSink(GatedSink):
    def __init__(self):
        super().__init__()
        self.flush_entered = threading.Event()
        self.flush_release = threading.Event()
        self.later_entered = threading.Event()
        self.later_release = self.release

    def write(self, text):
        self.lines.append(text)
        if text == "later\n":
            self.later_entered.set()
            assert self.later_release.wait(5)

    def flush(self):
        self.flush_entered.set()
        assert self.flush_release.wait(5)


def test_prefix_flush_succeeds_while_later_write_remains_blocked(managed_handler):
    handler, sink = managed_handler(PrefixSink())
    handler.handle(record("prefix"))
    results = []
    waiter = threading.Thread(target=lambda: results.append(handler.flush(1)))
    waiter.start()
    try:
        assert sink.flush_entered.wait(1)
        handler.handle(record("later"))
        sink.flush_release.set()
        assert sink.later_entered.wait(1)
        waiter.join(0.5)
        assert results == [True]
        assert handler.flush(0.01) is False
    finally:
        sink.release.set()
        sink.flush_release.set()
        waiter.join(1)


class ControlGatedSink(GatedSink):
    def __init__(self, operation):
        super().__init__()
        self.release.set()
        self.operation = operation
        self.control_entered = threading.Event()
        self.flush_release = threading.Event()
        self.close_release = threading.Event()

    def flush(self):
        super().flush()
        if self.operation == "flush":
            self.control_entered.set()
            assert self.flush_release.wait(5)

    def close(self):
        super().close()
        if self.operation == "close":
            self.control_entered.set()
            assert self.close_release.wait(5)


@pytest.mark.parametrize("operation", ["flush", "close"])
def test_stop_deadline_covers_blocked_final_flush_or_close(managed_handler, operation):
    handler, sink = managed_handler(ControlGatedSink(operation))
    handler.handle(record("data"))
    start = time.monotonic()
    assert handler.shutdown(0.05) is False
    assert sink.control_entered.is_set()
    assert time.monotonic() - start < 0.5
    assert handler.snapshot()["writer_alive"]
    assert all(owner is handler._writer for owner in sink.owners)


def test_errors_never_fall_back_to_stderr_or_claim_flush_success(managed_handler, capsys):
    class BrokenSink(GatedSink):
        def write(self, text):
            raise OSError("PRIVATE_CANARY " + text)
    handler, sink = managed_handler(BrokenSink())
    handler.handle(record("RECORD_CANARY"))
    assert handler.flush(1) is False
    handler.shutdown(1)
    stats = handler.snapshot()
    assert stats["writer_error"] == 1
    assert stats["processed"] == 1
    assert stats["failed"]
    assert "CANARY" not in repr(stats)
    assert capsys.readouterr().err == ""


def test_fixed_counters_saturate_without_breaking_flush_tickets(managed_handler):
    handler, sink = managed_handler()
    sink.release.set()
    with handler._condition:
        for name in handler._counts:
            handler._counts[name] = MAX_COUNTER - 1
            handler._increment(name, 10)
    handler.handle(record("still works"))
    assert handler.flush(1)
    stats = handler.snapshot()
    assert all(stats[name] == MAX_COUNTER for name in handler._counts)
    assert stats["saturated"]
    stats["accepted"] = -1
    assert handler.snapshot()["accepted"] == MAX_COUNTER
    assert set(stats) == {"accepted", "processed", "full", "oversize", "closed",
                          "writer_error", "abandoned", "saturated", "queue_depth",
                          "capacity", "in_flight", "accepting", "writer_alive",
                          "stop_requested", "stopped", "failed"}


def test_empty_prefix_flush_reaches_sink_and_factory_runs_on_writer(managed_handler):
    handler, sink = managed_handler()
    assert handler.flush(1)
    assert sink.owners == [handler._writer]
    assert handler._writer.daemon


def test_automatic_shutdown_visits_real_sink_first_without_waiting_for_its_io_lock(tmp_path):
    entered = threading.Event()
    release = threading.Event()
    made = threading.Event()
    instances = []
    operations = []

    class BlockingStream(io.StringIO):
        def write(self, text):
            operations.append(("write", threading.current_thread()))
            entered.set()
            assert release.wait(5)
            return super().write(text)

        def flush(self):
            operations.append(("flush", threading.current_thread()))
            return super().flush()

        def close(self):
            operations.append(("close", threading.current_thread()))
            return super().close()

    def factory():
        sink = OwnedRotatingSink(tmp_path / "unused.log", max_bytes=100000, backup_count=3)
        sink.stream = BlockingStream()
        instances.append(sink)
        made.set()
        return sink

    handler = BoundedLogHandler(factory)
    shutdown_done = threading.Event()
    shutdown_thread = None
    try:
        handler.handle(record("PRIVATE_CANARY"))
        assert made.wait(1) and entered.wait(1)
        assert handler.lock is None and instances[0].lock is None
        # Real public shutdown's reverse construction order: sink, then facade.
        def automatic_shutdown():
            logging.shutdown([weakref.ref(handler), weakref.ref(instances[0])])
            shutdown_done.set()
        shutdown_thread = threading.Thread(target=automatic_shutdown)
        start = time.monotonic()
        shutdown_thread.start()
        producer = threading.Thread(target=handler.handle, args=(record("later"),))
        producer.start()
        producer.join(0.3)
        assert not producer.is_alive()
        assert shutdown_done.wait(2.7)
        assert time.monotonic() - start < 2.8
        assert handler.snapshot()["writer_alive"]
        assert operations == [("write", handler._writer)]
    finally:
        release.set()
        if shutdown_thread:
            shutdown_thread.join(3)
        handler.shutdown(1)
        handler._writer.join(1)
        handler.close()
        assert not handler._writer.is_alive()
    assert all(owner is handler._writer for _, owner in operations)
    assert operations[-1][0] == "close"


@pytest.mark.parametrize("operation", ["open", "write", "flush", "rotate"])
def test_real_rotating_sink_errors_have_one_boundary_and_no_stderr(tmp_path, capsys, operation):
    class FailedStream(io.StringIO):
        def write(self, text):
            if operation == "write":
                raise OSError("PRIVATE_WRITE_CANARY " + text)
            return super().write(text)
        def flush(self):
            if operation == "flush":
                raise OSError("PRIVATE_FLUSH_CANARY")
            return super().flush()
    class FailedSink(OwnedRotatingSink):
        def _open(self):
            if operation == "open":
                raise OSError("PRIVATE_PATH_CANARY")
            return FailedStream()
        def doRollover(self):
            if operation == "rotate":
                raise OSError("PRIVATE_ROTATE_CANARY")
            return super().doRollover()
    handler = BoundedLogHandler(lambda: FailedSink(
        tmp_path / "sink.log", max_bytes=1 if operation == "rotate" else 10000,
        backup_count=3))
    try:
        handler.handle(record("PRIVATE_RECORD_CANARY"))
        assert not handler.flush(1)
        handler.shutdown(1)
        assert not handler._writer.is_alive()
        stats = handler.snapshot()
        assert stats["processed"] == 1
        # Flush failure can recur during explicit flush and owner close. Each
        # attempt is counted once; other failures occur only on the write.
        assert stats["writer_error"] == (3 if operation == "flush" else 1)
        assert "CANARY" not in repr(stats)
        assert capsys.readouterr().err == ""
    finally:
        handler.close()
        handler._writer.join(1)
        assert not handler._writer.is_alive()


def test_factory_failure_abandons_queue_without_retaining_exception_or_stderr(capsys):
    entered = threading.Event()
    release = threading.Event()
    def factory():
        entered.set()
        assert release.wait(5)
        raise OSError("PRIVATE_FACTORY_CANARY")
    handler = BoundedLogHandler(factory)
    try:
        assert entered.wait(1)
        handler.handle(record("PRIVATE_RECORD_CANARY"))
        release.set()
        assert not handler.flush(1)
        handler.shutdown(1)
        assert handler.snapshot()["abandoned"] == 1
        assert handler.snapshot()["writer_error"] == 1
        assert not handler.snapshot()["accepting"]
        assert capsys.readouterr().err == ""
    finally:
        release.set()
        handler.close()
        handler._writer.join(1)
        assert not handler._writer.is_alive()


def test_format_exception_has_no_raw_fallback_and_does_not_poison_admitted_prefix(managed_handler, capsys):
    handler, sink = managed_handler()
    sink.release.set()
    class BadText:
        def __str__(self):
            raise ValueError("PRIVATE_FORMAT_CANARY")
    handler.handle(record(BadText()))
    handler.handle(record("good"))
    assert handler.flush(1)
    assert handler.snapshot()["writer_error"] == 1
    assert handler.snapshot()["accepted"] == 1
    assert sink.lines == ["good\n"]
    assert capsys.readouterr().err == ""
