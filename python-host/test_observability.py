import json
import logging
import observability

from observability import (
    DEFAULT_LOG_BACKUP_COUNT,
    DEFAULT_LOG_MAX_BYTES,
    configure_host_logging,
    load_log_bounds,
    hash_input_ids,
    summarize_high_frequency_input_event,
    summarize_input_event,
)


def test_log_bounds_default_to_ten_mib_and_three_backups(monkeypatch):
    monkeypatch.delenv("WRD_LOG_MAX_BYTES", raising=False)
    monkeypatch.delenv("WRD_LOG_BACKUP_COUNT", raising=False)

    assert DEFAULT_LOG_MAX_BYTES == 10 * 1024 * 1024
    assert DEFAULT_LOG_BACKUP_COUNT == 3
    assert load_log_bounds() == (10 * 1024 * 1024, 3)


def test_host_rotating_handler_stays_bounded_and_is_not_duplicated(tmp_path):
    log_path = tmp_path / "host.log"
    logger = logging.getLogger("wrd-test-rotating-host")
    logger.handlers.clear()
    logger.propagate = False

    handler = configure_host_logging(
        logger=logger, log_file=log_path, max_bytes=96, backup_count=2,
    )
    try:
        assert configure_host_logging(
            logger=logger, log_file=log_path, max_bytes=96, backup_count=2,
        ) is handler
        for index in range(30):
            logger.info("line-%02d-%s", index, "x" * 32)
        assert handler.flush(timeout=1)
        files = sorted(tmp_path.glob("host.log*"))
        assert [path.name for path in files] == ["host.log", "host.log.1", "host.log.2"]
        assert len(logger.handlers) == 1
        assert all(path.stat().st_size <= 96 for path in files)
    finally:
        assert handler.close()
        logger.removeHandler(handler)
        assert not handler.snapshot()["writer_alive"]


def test_input_hash_matches_viewer_fixture():
    assert hash_input_ids(["kbd_fixture_1"]) == "3e9fd6a21afbb55b"
    assert hash_input_ids(["inp_fixture_a", "inp_fixture_b"]) == "1721100bdad63938"


def test_input_hash_rejects_unbounded_or_malformed_ids():
    assert hash_input_ids(["bad input id"]) is None
    assert hash_input_ids([f"input-{index}" for index in range(65)]) is None


def test_input_summary_whitelists_outcome_fields_without_raw_input_values():
    summary = summarize_input_event({
        "type": "keyboard",
        "action": "key",
        "transport": "datachannel",
        "inputIds": ["kbd_fixture_1"],
        "seq": 9,
        "leaseEpoch": 12,
        "payload": {"key": "CANARY", "code": "KeyA", "x": 987.654},
        "status": "execution-failed",
        "appliedSeq": 7,
    }, local_execute_ms=12.3456)

    assert summary == {
        "inputType": "keyboard",
        "action": "key",
        "transport": "datachannel",
        "payloadBytes": 42,
        "inputIdCount": 1,
        "inputIdHash": "3e9fd6a21afbb55b",
        "status": "execution-failed",
        "seq": 9,
        "leaseEpoch": 12,
        "appliedSeq": 7,
        "reason": None,
        "hostAdmissionWaitMs": None,
        "localExecuteMs": 12.346,
        "timingScope": "host-adapter-await",
        "timingIncludesQueueWait": True,
    }


def test_input_summary_rejects_unhashable_enum_fields_without_raising():
    summary = summarize_input_event({
        "type": ["keyboard", "TYPE_CANARY"],
        "action": {"name": "ACTION_CANARY"},
        "transport": ["datachannel"],
        "status": {"name": "STATUS_CANARY"},
        "reason": ["REASON_CANARY"],
        "payload": {"text": "PAYLOAD_CANARY"},
    })

    assert summary["inputType"] == "unknown"
    assert summary["action"] == "unknown"
    assert summary["transport"] == "socket"
    assert summary["status"] == "unknown"
    assert summary["reason"] is None


def test_high_frequency_input_summary_does_not_hash_or_copy_input_fields(monkeypatch):
    def fail_hash(_input_ids):
        raise AssertionError("high-frequency input must not hash")

    monkeypatch.setattr(observability, "hash_input_ids", fail_hash)
    summary = summarize_high_frequency_input_event({
        "type": "mouse",
        "action": "move",
        "transport": "socket",
        "inputIds": ["mouse-fixture"],
        "seq": 17,
        "payload": {"relX": 0.5, "relY": 0.5, "text": "PAYLOAD_CANARY"},
    }, status="accepted")

    assert summary == {
        "inputType": "mouse",
        "action": "move",
        "transport": "socket",
        "status": "accepted",
    }


def test_root_logging_producer_returns_while_owned_sink_is_blocked(monkeypatch, tmp_path):
    import threading
    from bounded_log_writer import BoundedLogHandler

    class Sink(logging.Handler):
        def __init__(self):
            super().__init__()
            self.entered = threading.Event()
            self.write_release = threading.Event()
            self.lines = []
        def createLock(self):
            self.lock = None
        def emit(self, record):
            self.write(self.format(record) + "\n")
        def write(self, text):
            self.entered.set()
            assert self.write_release.wait(5)
            self.lines.append(text)

    sink = Sink()
    # The old synchronous implementation and new owned sink use the same gate,
    # so RED proves the existing logger boundary, not merely a missing symbol.
    monkeypatch.setattr(observability, "RotatingFileHandler", lambda *a, **kw: sink, raising=False)
    monkeypatch.setattr(observability, "OwnedRotatingSink", lambda *a, **kw: sink, raising=False)
    root = logging.getLogger()
    previous = (list(root.handlers), root.level, root.propagate,
                getattr(root, "_wrd_host_log_owner", None))
    root.handlers = []
    handler = None
    producer = None
    try:
        handler = configure_host_logging(log_file=tmp_path / "root.log")
        producer = threading.Thread(target=root.info, args=("root producer",))
        producer.start()
        assert sink.entered.wait(1)
        producer.join(0.2)
        assert not producer.is_alive(), "logger producer is blocked on file sink"
        assert isinstance(handler, BoundedLogHandler)
        assert configure_host_logging(log_file=tmp_path / "root.log") is handler
        sink.write_release.set()
        assert handler.flush(1)
        assert "INFO root root producer\n" in sink.lines[0]
    finally:
        sink.write_release.set()
        if producer:
            producer.join(1)
        if handler:
            handler.close()
            if isinstance(handler, BoundedLogHandler):
                handler._writer.join(1)
                assert not handler._writer.is_alive()
        root.handlers, root.level, root.propagate, root._wrd_host_log_owner = previous


def test_reconfiguration_refuses_live_stopping_writer_even_when_detached(monkeypatch, tmp_path):
    import threading
    import pytest

    entered = threading.Event()
    release = threading.Event()
    sinks = []
    class Sink:
        def write(self, text):
            entered.set()
            assert release.wait(5)
        def flush(self):
            pass
        def close(self):
            pass
    def factory(*args, **kwargs):
        sink = Sink()
        sinks.append(sink)
        return sink
    monkeypatch.setattr(observability, "OwnedRotatingSink", factory)
    logger = logging.getLogger("wrd-test-reconfiguration")
    logger.handlers.clear()
    handler = configure_host_logging(logger=logger, log_file=tmp_path / "one.log")
    replacement = None
    try:
        logger.info("blocked")
        assert entered.wait(1)
        assert not handler.shutdown(0.01)
        logger.removeHandler(handler)
        for path in ("one.log", "two.log"):
            with pytest.raises(RuntimeError, match="^Host log writer is still stopping$"):
                configure_host_logging(logger=logger, log_file=tmp_path / path)
        assert sinks and len(sinks) == 1
        assert logger.handlers == []
        assert logger._wrd_host_log_owner is handler
        release.set()
        handler._writer.join(1)
        assert not handler._writer.is_alive()
        replacement = configure_host_logging(logger=logger, log_file=tmp_path / "two.log")
        assert replacement is not handler
        logger.info("replacement")
        assert replacement.flush(1)
        assert len(sinks) == 2
    finally:
        release.set()
        handler.close()
        handler._writer.join(1)
        if replacement:
            replacement.close()
            assert not replacement._writer.is_alive()
        logger.handlers.clear()
        assert not handler._writer.is_alive()


def test_changed_signature_waits_for_owner_exit_before_constructing_replacement(monkeypatch, tmp_path):
    import threading
    owners = []
    closed = []
    class Sink:
        def write(self, text):
            pass
        def flush(self):
            pass
        def close(self):
            closed.append(threading.current_thread())
    def factory(*args, **kwargs):
        if owners:
            assert not owners[0].is_alive()
            assert closed == owners
        owners.append(threading.current_thread())
        return Sink()
    monkeypatch.setattr(observability, "OwnedRotatingSink", factory)
    logger = logging.getLogger("wrd-test-owner-replacement")
    logger.handlers.clear()
    first = configure_host_logging(logger=logger, log_file=tmp_path / "one.log")
    second = None
    try:
        assert first.flush(1)
        second = configure_host_logging(logger=logger, log_file=tmp_path / "two.log")
        assert second.flush(1)
        assert not first._writer.is_alive()
        assert owners == [first._writer, second._writer]
    finally:
        first.close()
        if second:
            second.close()
            assert not second._writer.is_alive()
        logger.handlers.clear()


def test_structured_payload_redaction_and_return_contract_survive_file_facade(tmp_path):
    import json
    logger = logging.getLogger("wrd-test-structured-file")
    logger.handlers.clear()
    path = tmp_path / "structured.log"
    handler = configure_host_logging(logger=logger, log_file=path)
    try:
        payload = observability.emit_host_event(
            logger, event="test_event", message="safe message",
            correlation={"token": "TOKEN_CANARY", "id": "safe-id"},
            meta={"password": "PASSWORD_CANARY", "nested": {"text": "TEXT_CANARY"}},
        )
        assert payload["schemaVersion"] == payload["redactionVersion"] == 1
        assert payload["correlation"] == {"token": "[redacted]", "id": "safe-id"}
        assert payload["meta"] == {"password": "[redacted]", "nested": {"text": "[redacted]"}}
        assert handler.flush(1)
        text = path.read_text()
        assert "CANARY" not in text
        assert json.loads(text[text.index('{'):]) == payload
    finally:
        handler.close()
        logger.handlers.clear()
        assert not handler._writer.is_alive()


def test_structured_lifecycle_correlation_hashes_raw_viewer_attempt_and_session_ids():
    records = []
    logger = logging.getLogger("wrd-test-lifecycle-correlation")
    logger.handlers.clear()
    class Capture(logging.Handler):
        def __init__(self):
            super().__init__()
        def emit(self, record):
            records.append(json.loads(record.getMessage()))
    handler = Capture()
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    try:
        payload = observability.emit_host_event(
            logger, event="lifecycle", message="safe",
            correlation={"viewerId": "viewer-private", "previousViewerId": "viewer-old",
                         "connectionAttemptId": "attempt-private", "browserSessionId": "session-private",
                         "leaseEpoch": 4},
        )
        correlation = payload["correlation"]
        assert set(correlation) == {"viewerHash", "previousViewerHash", "attemptHash", "browserSessionHash", "leaseEpoch"}
        assert all(len(correlation[key]) == 32 for key in ("viewerHash", "previousViewerHash", "attemptHash", "browserSessionHash"))
        assert "private" not in json.dumps(payload)
    finally:
        logger.handlers.clear()


def test_host_terminal_finally_stops_owned_handler_after_run_and_fatal_log():
    import ast
    from pathlib import Path
    tree = ast.parse(Path(__file__).with_name("host.py").read_text())
    main_blocks = [node for node in tree.body if isinstance(node, ast.If)
                   and ast.unparse(node.test) == "__name__ == '__main__'"]
    assert ast.unparse(main_blocks[0].body[0]) == "host_log_handler = configure_host_logging()"
    terminal = main_blocks[-1].body
    assert len(terminal) == 1 and isinstance(terminal[0], ast.Try)
    outer = terminal[0]
    assert ast.unparse(outer.finalbody[0]) == "host_log_handler.shutdown()"
    assert len(outer.finalbody) == 1
    assert ast.unparse(outer.body[0]) == "host = WebRemoteHost()"
    inner = outer.body[1]
    assert isinstance(inner, ast.Try)
    assert ast.unparse(inner.body[-1]) == "asyncio.run(host.run())"
    assert ast.unparse(inner.handlers[0].type) == "Exception"
    assert [ast.unparse(node) for node in inner.handlers[0].body] == [
        "logger.error(f'Fatal: {e}', exc_info=True)", "sys.exit(1)"]
    assert not any(isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                   and node.func.attr in {"to_thread", "run_in_executor"} for node in ast.walk(outer))


def test_changed_configuration_cannot_replace_blocked_accepting_owner(monkeypatch, tmp_path):
    import threading
    import pytest
    entered = threading.Event()
    release = threading.Event()
    created = []
    class Sink:
        def write(self, text):
            entered.set()
            assert release.wait(5)
        def flush(self):
            pass
        def close(self):
            pass
    def factory(*args, **kwargs):
        created.append(threading.current_thread())
        return Sink()
    monkeypatch.setattr(observability, "OwnedRotatingSink", factory)
    logger = logging.getLogger("wrd-test-blocked-accepting-owner")
    logger.handlers.clear()
    handler = configure_host_logging(logger=logger, log_file=tmp_path / "one.log")
    try:
        logger.info("blocked")
        assert entered.wait(1)
        with pytest.raises(RuntimeError, match="^Host log writer is still stopping$"):
            configure_host_logging(logger=logger, log_file=tmp_path / "two.log")
        assert logger.handlers == [handler]
        assert logger._wrd_host_log_owner is handler
        assert created == [handler._writer]
    finally:
        release.set()
        handler._writer.join(1)
        handler.close()
        logger.handlers.clear()
        assert not handler._writer.is_alive()


def test_log_environment_bounds_and_path_are_preserved(monkeypatch, tmp_path):
    monkeypatch.setenv("WRD_LOG_MAX_BYTES", "0")
    monkeypatch.setenv("WRD_LOG_BACKUP_COUNT", "-1")
    monkeypatch.setenv("WRD_HOST_LOG_FILE", str(tmp_path / "env.log"))
    assert load_log_bounds() == (1, 0)
    logger = logging.getLogger("wrd-test-log-env")
    logger.handlers.clear()
    handler = configure_host_logging(logger=logger)
    try:
        assert handler._wrd_host_log_signature == (str(tmp_path / "env.log"), 1, 0)
        logger.info("env")
        assert handler.flush(1)
        assert "INFO wrd-test-log-env env\n" in (tmp_path / "env.log").read_text()
    finally:
        handler.close()
        logger.handlers.clear()
        assert not handler._writer.is_alive()
    monkeypatch.setenv("WRD_LOG_MAX_BYTES", "invalid")
    monkeypatch.setenv("WRD_LOG_BACKUP_COUNT", "invalid")
    assert load_log_bounds() == (DEFAULT_LOG_MAX_BYTES, DEFAULT_LOG_BACKUP_COUNT)
