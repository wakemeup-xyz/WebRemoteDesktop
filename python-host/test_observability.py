import logging

from observability import (
    DEFAULT_LOG_BACKUP_COUNT,
    DEFAULT_LOG_MAX_BYTES,
    configure_host_logging,
    load_log_bounds,
    hash_input_ids,
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

    configure_host_logging(
        logger=logger,
        log_file=log_path,
        max_bytes=96,
        backup_count=2,
    )
    configure_host_logging(
        logger=logger,
        log_file=log_path,
        max_bytes=96,
        backup_count=2,
    )
    for index in range(30):
        logger.info("line-%02d-%s", index, "x" * 32)
    for handler in logger.handlers:
        handler.flush()

    files = sorted(tmp_path.glob("host.log*"))
    assert [path.name for path in files] == ["host.log", "host.log.1", "host.log.2"]
    assert len(logger.handlers) == 1
    assert all(path.stat().st_size <= 96 for path in files)


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
