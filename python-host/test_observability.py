import logging

from observability import (
    DEFAULT_LOG_BACKUP_COUNT,
    DEFAULT_LOG_MAX_BYTES,
    configure_host_logging,
    load_log_bounds,
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
