import logging
from types import SimpleNamespace

import pytest
import host as host_module

from host import WebRemoteHost, build_ice_servers


class ListHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        self.records.append(record)


@pytest.mark.asyncio
async def test_host_reauthenticates_before_reconnecting_after_signal_restart():
    calls = []
    host = object.__new__(WebRemoteHost)
    host._reconnecting = False
    host.token = "expired-host-token"

    async def disconnect():
        calls.append("disconnect")

    host.sio = SimpleNamespace(connected=False, disconnect=disconnect)
    host.relay_streamer = object()

    async def authenticate():
        calls.append("authenticate")
        host.token = "fresh-host-token"
        return True

    async def connect():
        calls.append(("connect", host.token))
        return True

    host.authenticate = authenticate
    host.connect = connect

    assert await host.ensure_connected() is True
    assert calls == ["disconnect", "authenticate", ("connect", "fresh-host-token")]
    assert host.sio is None
    assert host.relay_streamer is None


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


@pytest.mark.asyncio
async def test_host_input_logs_metadata_without_payload_or_cross_clock_delay(caplog):
    host = object.__new__(WebRemoteHost)
    host.current_viewer_id = "viewer-1"
    host._active_input_binding = {
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 12,
        "connectionGeneration": 1,
    }
    host.overlay = SimpleNamespace(send=lambda _payload: None)
    host.screen_track = None

    async def apply_keyboard(_data, **_kwargs):
        return {
            "inputIds": ["input-Secret123"],
            "receiveTime": 10.0,
            "executeTime": 10.012,
        }

    host.input_handler = SimpleNamespace(apply_keyboard=apply_keyboard)
    payload = {
        "viewerId": "viewer-1",
        "type": "keyboard",
        "action": "keydown",
        "transport": "datachannel",
        "timestamp": 1,
        "inputIds": ["input-Secret123"],
        "payload": {
            "key": "Secret123",
            "code": "KeyA",
            "x": 987.654,
        },
    }

    with caplog.at_level(logging.INFO, logger="host"):
        await host.on_input(payload)

    text = "\n".join(record.getMessage() for record in caplog.records if record.name == "host")
    assert "Secret123" not in text
    assert "KeyA" not in text
    assert "987.654" not in text
    assert "payload=" not in text
    assert "input_delay" not in text
    assert "host_input_received" in text
    assert '"transport":"datachannel"' in text
    assert '"payloadBytes":' in text
    assert '"inputIdHash":' in text
    assert '"localExecuteMs":12.0' in text


@pytest.mark.asyncio
async def test_host_sends_independent_input_ack_without_waiting_for_screen_track():
    sent = []
    host = object.__new__(WebRemoteHost)
    host.current_viewer_id = "viewer-1"
    host._active_input_binding = {
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 12,
        "connectionGeneration": 1,
    }
    host.overlay = SimpleNamespace(send=lambda _payload: None)
    host.screen_track = None
    host._input_datachannel = SimpleNamespace(send=lambda value: sent.append(value), readyState="open")

    async def apply_keyboard(_data, **_kwargs):
        return {
            "inputIds": ["input-1"],
            "receiveTime": 20.0,
            "executeTime": 20.009,
            "appliedSeq": 7,
            "status": "applied",
            "pressedKeyCount": 1,
            "modifierMask": 0x100000,
        }

    host.input_handler = SimpleNamespace(apply_keyboard=apply_keyboard)
    await host.on_input({
        "viewerId": "viewer-1",
        "schemaVersion": 2,
        "type": "keyboard",
        "action": "keydown",
        "transport": "datachannel",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 12,
        "seq": 7,
        "inputIds": ["input-1"],
        "payload": {"key": "SecretKey", "code": "KeyA"},
    })

    assert len(sent) == 1
    ack = __import__("json").loads(sent[0])
    assert ack == {
        "type": "input_ack",
        "schemaVersion": 2,
        "leaseEpoch": 12,
        "appliedSeq": 7,
        "status": "applied",
        "pressedKeyCount": 1,
        "modifierMask": 0x100000,
        "inputIds": ["input-1"],
        "hostExecuteMs": 9.0,
        "transport": "datachannel",
    }
    assert "key" not in ack
    assert "payload" not in ack


def test_event_loop_lag_context_is_bounded_and_actionable(monkeypatch):
    host = object.__new__(WebRemoteHost)
    host.media_profile = {"profile": "survival", "target_fps": 8}
    host.pc = SimpleNamespace(connectionState="connected", iceConnectionState="connected")
    host.screen_track = SimpleNamespace(_capture_seq=321, _target_fps=8)
    host.input_handler = SimpleNamespace(_lock_waiters=2)
    host.relay_streamer = SimpleNamespace(pending_frame_count=lambda: 1, running=True)
    host._input_event_count = 44
    host._last_input_at_monotonic = 90.0
    monkeypatch.setattr(host_module.time, "perf_counter", lambda: 100.0)
    monkeypatch.setattr(host_module.os, "getloadavg", lambda: (2.5, 2.0, 1.5))
    monkeypatch.setattr(
        host_module.resource,
        "getrusage",
        lambda _who: SimpleNamespace(ru_utime=12.5, ru_stime=3.5, ru_maxrss=64 * 1024 * 1024),
    )

    context = host.build_event_loop_lag_context(
        lag_ms=142.2,
        sample_count=3,
        max_lag_ms=142.2,
        task_count=17,
    )

    assert context == {
        "lagMs": 142.2,
        "maxLagMs": 142.2,
        "sampleCount": 3,
        "severity": "critical",
        "mediaProfile": "survival",
        "targetFps": 8,
        "pcState": "connected",
        "iceState": "connected",
        "captureSeq": 321,
        "inputEventCount": 44,
        "lastInputAgeMs": 10000.0,
        "inputWaiters": 2,
        "relayRunning": True,
        "pendingRelayFrames": 1,
        "taskCount": 17,
        "threadCount": host_module.threading.active_count(),
        "processCpuSeconds": 16.0,
        "rssMiB": 64.0,
        "systemLoad1": 2.5,
    }
    assert "payload" not in context


@pytest.mark.asyncio
async def test_on_diagnostic_logs_summary_without_viewer_log_dump_by_default(monkeypatch, caplog):
    monkeypatch.delenv("WRD_HOST_VERBOSE_DIAGNOSTICS", raising=False)

    host = object.__new__(WebRemoteHost)
    host._last_diag_network = None

    payload = {
        "browserSessionId": "browser-1",
        "connectionAttemptId": "attempt-1",
        "trigger": "manual",
        "reason": "ice-failed",
        "logs": [{"level": "ERR", "message": "boom"}],
        "network": {
            "networkMode": "auto",
            "turnConfigured": False,
            "turnStatus": "missing",
        },
    }

    with caplog.at_level(logging.INFO, logger="host"):
        await host.on_diagnostic(payload)

    text = "\n".join(record.getMessage() for record in caplog.records if record.name == "host")
    assert "host_viewer_diagnostic_summary" in text
    assert "[VIEWER]" not in text


@pytest.mark.asyncio
async def test_on_diagnostic_logs_schema_v3_selected_candidate_pair(caplog):
    host = object.__new__(WebRemoteHost)
    host._last_diag_network = None

    payload = {
        "schemaVersion": 3,
        "browserSessionId": "browser-1",
        "connectionAttemptId": "attempt-1",
        "trigger": "auto-failure",
        "reason": "pc-failed",
        "logs": [],
        "network": {
            "networkMode": "stun",
            "turnConfigured": False,
            "turnStatus": "missing",
            "candidateSummary": {
                "local": {"host": 2, "srflx": 1, "relay": 0},
                "remote": {"host": 1, "srflx": 1, "relay": 0},
            },
            "selectedCandidatePair": {
                "localType": "srflx",
                "remoteType": "host",
                "protocol": "udp",
                "localAddress": "203.0.113.1:5000",
                "remoteAddress": "2001:db8::1:6000",
            },
            "pc": {
                "connectionState": "failed",
                "iceConnectionState": "failed",
            },
        },
    }

    with caplog.at_level(logging.INFO, logger="host"):
        await host.on_diagnostic(payload)

    text = "\n".join(record.getMessage() for record in caplog.records if record.name == "host")
    assert "WRD_FAILURE_DIAG" in text
    assert "selectedCandidatePair=" in text
    assert "203.0.113.1:5000" in text
    assert "local={'host': 2, 'srflx': 1, 'relay': 0}" in text
    assert "remote={'host': 1, 'srflx': 1, 'relay': 0}" in text
