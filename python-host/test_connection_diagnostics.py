import logging
from types import SimpleNamespace

import pytest

from host import WebRemoteHost, build_ice_servers


class ListHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        self.records.append(record)


@pytest.mark.asyncio
async def test_schema_v2_diagnostic_logs_single_stun_failure_summary():
    host = object.__new__(WebRemoteHost)
    host._last_diag_network = None

    handler = ListHandler()
    logger = logging.getLogger("host")
    original_level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

    payload = {
        "schemaVersion": 2,
        "connectionAttemptId": "wrd-20260627-abc123",
        "failureCategory": "candidate-check-failed",
        "candidateSummary": {
            "local": {"host": 2, "srflx": 1},
            "remote": {"host": 1},
        },
        "selectedCandidatePair": {
            "local": "192.168.1.20:5000",
            "remote": "203.0.113.10:443",
        },
        "pc": {"connectionState": "failed", "iceConnectionState": "failed"},
        "ice": {"gatheringState": "complete"},
        "candidate": "candidate:1 1 udp 1 192.168.1.20 5000 typ host",
        "logs": [],
    }

    try:
        await host.on_diagnostic(payload)
    finally:
        logger.removeHandler(handler)
        logger.setLevel(original_level)

    messages = [record.getMessage() for record in handler.records]
    summary_lines = [msg for msg in messages if msg.startswith("WRD_STUN_FAILURE")]

    assert len(summary_lines) == 1
    summary = summary_lines[0]
    assert "WRD_STUN_FAILURE" in summary
    assert "connectionAttemptId=wrd-20260627-abc123" in summary
    assert "failureCategory=candidate-check-failed" in summary
    assert "pc=" in summary
    assert "ice=" in summary
    assert "candidate=" in summary


def test_turn_env_is_ignored_under_strict_stun_policy(monkeypatch):
    monkeypatch.setenv("TURN_URLS", "turn:relay.example.com:3478")
    monkeypatch.setenv("TURN_USERNAME", "user")
    monkeypatch.setenv("TURN_CREDENTIAL", "secret")

    handler = ListHandler()
    logger = logging.getLogger("host")
    original_level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

    try:
        ice_servers = build_ice_servers()
    finally:
        logger.removeHandler(handler)
        logger.setLevel(original_level)

    messages = [record.getMessage() for record in handler.records]
    assert any("WRD_POLICY_WARNING turn_ignored_strict_stun" in msg for msg in messages)
    assert len(ice_servers) == 1
    assert all("turn:" not in repr(server) for server in ice_servers)
