import json
import logging
from types import SimpleNamespace

import pytest
import host as host_module
import observability

from adapters import InputAdapter
from host import WebRemoteHost, build_ice_servers
from input_handler import InputHandler


class ListHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        self.records.append(record)


@pytest.mark.asyncio
async def test_host_advertises_input_protocol_v2_when_connecting():
    calls = []
    host = object.__new__(WebRemoteHost)
    host.token = "host-token"

    async def connect(url, *, auth):
        calls.append((url, auth))

    host.sio = SimpleNamespace(connected=False, connect=connect)

    assert await host.connect() is True
    assert calls == [(host_module.SERVER_URL, {
        "token": "host-token", "role": "host", "inputProtocolVersion": 2,
    })]


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
    monkeypatch.delenv("WRD_MEDIA_POLICY", raising=False)
    monkeypatch.delenv("MEDIA_POLICY", raising=False)

    handler = ListHandler()
    logger = logging.getLogger("host")
    original_level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

    try:
        ice_servers = build_ice_servers("auto")
    finally:
        logger.removeHandler(handler)
        logger.setLevel(original_level)

    messages = [record.getMessage() for record in handler.records]
    assert any("WRD_POLICY_INFO turn_omitted_for_mode" in msg for msg in messages)
    assert len(ice_servers) == 1
    assert all("turn:" not in repr(server) for server in ice_servers)


def test_turn_env_is_included_for_relay_even_under_strict_stun(monkeypatch):
    monkeypatch.setenv("TURN_URLS", "turn:relay.example.com:3478")
    monkeypatch.setenv("TURN_USERNAME", "user")
    monkeypatch.setenv("TURN_CREDENTIAL", "secret")
    monkeypatch.setenv("WRD_MEDIA_POLICY", "strict-stun")

    ice_servers = build_ice_servers("relay")
    assert len(ice_servers) == 1  # TURN only; no STUN in relay mode
    assert any("turn:" in repr(server) for server in ice_servers)
    assert all("stun:" not in repr(server) for server in ice_servers)


def test_turn_fingerprint_matches_node_normalization_vector(monkeypatch):
    from host import get_turn_fingerprint, normalize_turn_url

    assert normalize_turn_url("turn:relay.example.com:3478") == (
        "turn:relay.example.com:3478?transport=udp"
    )
    bare = get_turn_fingerprint(
        ["turn:relay.example.com:3478"],
        "user",
    )
    with_query = get_turn_fingerprint(
        ["turn:relay.example.com:3478?transport=udp"],
        "user",
    )
    assert bare == with_query
    assert len(bare) == 64


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
    assert '"localExecuteMs":' in text
    assert '"timingScope":"host-adapter-await"' in text
    assert '"timingIncludesQueueWait":true' in text


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
        "inputType": "keyboard",
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


@pytest.mark.asyncio
async def test_host_v2_ack_normalizes_unknown_status_without_echoing_input():
    sent = []
    host = object.__new__(WebRemoteHost)
    host._input_datachannel = SimpleNamespace(send=lambda value: sent.append(value), readyState="open")
    host.input_handler = SimpleNamespace(_pressed_key_codes=(), _modifier_flags=0)

    await host._send_input_ack({
        "schemaVersion": 2,
        "type": "keyboard",
        "transport": "datachannel",
        "leaseEpoch": 12,
        "seq": 7,
        "payload": {"key": "SecretKey"},
    }, {
        "inputIds": ["input-1"],
        "appliedSeq": 7,
        "status": "unexpected-status",
    }, 9.0)

    ack = __import__("json").loads(sent[0])
    assert ack["status"] == "execution-failed"
    assert "payload" not in ack
    assert "key" not in ack


@pytest.mark.asyncio
async def test_host_v2_mouse_ack_uses_independent_contract_without_keyboard_fields():
    sent = []
    host = object.__new__(WebRemoteHost)
    host._input_datachannel = SimpleNamespace(send=lambda value: sent.append(value), readyState="open")
    host.input_handler = SimpleNamespace(_pressed_key_codes=(), _modifier_flags=0)
    await host._send_input_ack({"schemaVersion": 2, "type": "mouse", "transport": "datachannel", "leaseEpoch": 12}, {"inputIds": ["mouse-reset-1"], "status": "applied"}, 2.0)
    ack = __import__("json").loads(sent[0])
    assert ack["inputType"] == "mouse"
    assert "appliedSeq" not in ack and "pressedKeyCount" not in ack and "modifierMask" not in ack


@pytest.mark.asyncio
async def test_host_unordered_mouse_move_ack_normalizes_to_applied_without_a_sequence():
    sent = []
    host = object.__new__(WebRemoteHost)
    host._input_datachannel = SimpleNamespace(send=lambda value: sent.append(value), readyState="open")
    host.input_handler = SimpleNamespace(_pressed_key_codes=(), _modifier_flags=0)

    await host._send_input_ack(
        {"schemaVersion": 2, "type": "mouse", "action": "move", "transport": "datachannel", "leaseEpoch": 12},
        {"inputIds": ["mouse-move-1"], "status": "unordered"},
        2.0,
    )

    ack = __import__("json").loads(sent[0])
    assert ack["status"] == "applied"
    assert "appliedSeq" not in ack


@pytest.mark.asyncio
async def test_host_v2_mouse_socket_ack_keeps_applied_sequence_without_keyboard_state():
    emitted = []
    host = object.__new__(WebRemoteHost)
    async def emit(event, payload):
        emitted.append((event, payload))
    host.sio = SimpleNamespace(emit=emit)
    host.input_handler = SimpleNamespace(_pressed_key_codes=(), _modifier_flags=0)
    await host._send_input_ack({"schemaVersion": 2, "type": "mouse", "transport": "socket", "leaseEpoch": 12, "viewerId": "viewer-1", "seq": 8}, {"inputIds": ["mouse-reset-2"], "status": "duplicate", "appliedSeq": 8}, 3.0)
    assert emitted[0][0] == "input-ack"
    assert emitted[0][1]["inputType"] == "mouse"
    assert emitted[0][1]["appliedSeq"] == 8
    assert "pressedKeyCount" not in emitted[0][1]


@pytest.mark.asyncio
async def test_host_v2_command_ack_keeps_its_type_with_applied_sequence():
    sent = []
    host = object.__new__(WebRemoteHost)
    host._input_datachannel = SimpleNamespace(send=lambda value: sent.append(value), readyState="open")
    host.input_handler = SimpleNamespace(_pressed_key_codes=(), _modifier_flags=0)

    await host._send_input_ack({
        "schemaVersion": 2,
        "type": "command",
        "transport": "datachannel",
        "leaseEpoch": 12,
        "seq": 7,
    }, {
        "inputIds": ["command-1"],
        "appliedSeq": 7,
        "status": "applied",
        "pressedKeyCount": 0,
        "modifierMask": 0,
    }, 2.0)

    ack = __import__("json").loads(sent[0])
    assert ack["inputType"] == "command"
    assert ack["appliedSeq"] == 7


@pytest.mark.asyncio
async def test_host_input_outcomes_report_status_and_ack_enqueue_result_without_raw_values(caplog):
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
    host.input_handler = SimpleNamespace(_pressed_key_codes=(), _modifier_flags=0)

    async def apply_keyboard(data, **_kwargs):
        return {
            "inputIds": data["inputIds"],
            "status": data["payload"]["status"],
            "appliedSeq": data["seq"],
            "pressedKeyCount": 0,
            "modifierMask": 0,
        }

    host.input_adapter = SimpleNamespace(apply_keyboard=apply_keyboard)
    base = {
        "viewerId": "viewer-1",
        "schemaVersion": 2,
        "type": "keyboard",
        "action": "key",
        "transport": "datachannel",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 12,
        "inputIds": ["kbd_fixture_1"],
        "payload": {"phase": "down", "status": "applied", "code": "KeyA"},
    }

    with caplog.at_level(logging.INFO, logger="host"):
        for seq, status in enumerate(("applied", "duplicate", "execution-failed"), start=1):
            data = {**base, "seq": seq, "payload": {**base["payload"], "status": status}}
            await host.on_input(data)

    messages = [record.getMessage() for record in caplog.records if record.name == "host"]
    result_lines = [json.loads(message) for message in messages if '"event":"host_input_result"' in message]
    ack_lines = [json.loads(message) for message in messages if '"event":"host_input_ack_sent"' in message]
    assert [line["meta"]["status"] for line in result_lines] == ["applied", "duplicate", "execution-failed"]
    assert [line["meta"]["appliedSeq"] for line in result_lines] == [1, 2, 3]
    assert all(line["meta"]["ackAccepted"] is True for line in ack_lines)
    assert all(line["meta"]["inputIdHash"] == "3e9fd6a21afbb55b" for line in result_lines)
    text = "\n".join(messages)
    assert "CANARY" not in text
    assert "KeyA" not in text
    assert "kbd_fixture_1" not in text


@pytest.mark.asyncio
async def test_host_input_ack_enqueue_failure_is_reported_without_claiming_client_receipt(caplog):
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
    host._input_datachannel = SimpleNamespace(send=lambda _value: (_ for _ in ()).throw(RuntimeError("CANARY")), readyState="open")
    host.input_handler = SimpleNamespace(_pressed_key_codes=(), _modifier_flags=0)

    async def apply_keyboard(data, **_kwargs):
        return {"inputIds": data["inputIds"], "status": "applied", "appliedSeq": data["seq"]}

    host.input_adapter = SimpleNamespace(apply_keyboard=apply_keyboard)
    with caplog.at_level(logging.INFO, logger="host"):
        await host.on_input({
            "viewerId": "viewer-1", "schemaVersion": 2, "type": "keyboard", "action": "key",
            "transport": "datachannel", "leaseId": "lease-000000000001", "leaseEpoch": 12,
            "seq": 1, "inputIds": ["kbd_fixture_1"],
            "payload": {"phase": "down", "code": "KeyA"},
        })

    messages = [record.getMessage() for record in caplog.records if record.name == "host"]
    ack_line = next(json.loads(message) for message in messages if '"event":"host_input_ack_sent"' in message)
    assert ack_line["meta"]["status"] == "applied"
    assert ack_line["meta"]["ackAccepted"] is False
    assert "CANARY" not in "\n".join(messages)


@pytest.mark.asyncio
async def test_host_real_input_handler_exception_is_private_across_chain(caplog):
    sent = []
    handler = InputHandler()
    handler._running = True

    def boom(_action, _payload):
        raise RuntimeError("CANARY")

    handler._handle_mouse = boom
    host = object.__new__(WebRemoteHost)
    host.current_viewer_id = "viewer-1"
    host.overlay = SimpleNamespace(send=lambda _payload: None)
    host.screen_track = None
    host.input_handler = handler
    host.input_adapter = InputAdapter(handler)

    async def emit(event, payload):
        sent.append((event, payload))

    host.sio = SimpleNamespace(emit=emit)
    with caplog.at_level(logging.INFO):
        await host.on_input({
            "viewerId": "viewer-1",
            "type": "mouse",
            "action": "down",
            "transport": "socket",
            "inputIds": ["kbd_fixture_1"],
            "payload": {"relX": 0.2, "relY": 0.3, "button": "left", "clickCount": 1, "buttons": 1},
        })

    records = [record for record in caplog.records if record.name in {"host", "input_handler"}]
    formatted = "\n".join(logging.Formatter().format(record) for record in records)
    host_events = [json.loads(record.getMessage()) for record in records if '"domain":"host"' in record.getMessage()]
    result = next(event for event in host_events if event["event"] == "host_input_result")
    ack = next(event for event in host_events if event["event"] == "host_input_ack_sent")
    assert result["meta"]["status"] == "execution-failed"
    assert ack["meta"]["status"] == "execution-failed"
    assert ack["meta"]["ackAccepted"] is True
    assert [event for event, _payload in sent] == ["input-ack"]
    assert "CANARY" not in formatted
    assert "Traceback" not in formatted
    assert all(record.exc_info is None for record in records)


@pytest.mark.asyncio
async def test_host_stale_lease_and_datachannel_binding_rejections_are_structured_and_safe(caplog):
    host = object.__new__(WebRemoteHost)
    host.current_viewer_id = "viewer-1"
    host._active_input_binding = {
        "viewerId": "viewer-1", "leaseId": "lease-000000000001", "leaseEpoch": 12,
        "connectionGeneration": 1,
    }
    host.overlay = SimpleNamespace(send=lambda _payload: None)
    host.screen_track = None
    host.input_handler = SimpleNamespace()
    host.input_adapter = host.input_handler
    with caplog.at_level(logging.INFO, logger="host"):
        await host.on_input({
            "viewerId": "viewer-1", "schemaVersion": 2, "type": "keyboard", "action": "key",
            "transport": "socket", "leaseId": "lease-stale-canary", "leaseEpoch": 11,
            "seq": 1, "inputIds": ["kbd_fixture_1"],
            "payload": {"phase": "down", "code": "KeyA", "text": "CANARY"},
        })
        assert host._prepare_bound_datachannel_input(
            host._active_input_binding,
            {"schemaVersion": 2, "type": "keyboard", "action": "key", "leaseId": "lease-stale-canary", "leaseEpoch": 11,
             "inputIds": ["kbd_fixture_1"], "payload": {"phase": "down", "code": "KeyA"}},
            channel=SimpleNamespace(),
        ) is None
        assert host._prepare_bound_datachannel_input(
            {**host._active_input_binding, "connectionGeneration": 0},
            {"type": "dc_keepalive", "action": "ping", "payload": {"text": "CANARY"}},
            channel=SimpleNamespace(),
        ) is None

    messages = [record.getMessage() for record in caplog.records if record.name == "host"]
    rejected = [json.loads(message) for message in messages if '"event":"host_input_rejected"' in message]
    assert len(rejected) >= 2
    assert all(line["meta"]["status"] in {"stale-lease", "invalid-input"} for line in rejected)
    assert any(line["meta"]["transport"] == "datachannel" for line in rejected)
    assert "CANARY" not in "\n".join(messages)
    assert "kbd_fixture_1" not in "\n".join(messages)


@pytest.mark.asyncio
async def test_host_malformed_input_metadata_rejects_without_observation_error(caplog):
    host = object.__new__(WebRemoteHost)
    host.current_viewer_id = "viewer-1"
    host.overlay = SimpleNamespace(send=lambda _payload: None)
    host.screen_track = None

    async def handle_input(_data):
        return {"inputIds": [], "status": "applied"}

    host.input_adapter = SimpleNamespace(handle_input=handle_input)

    with caplog.at_level(logging.INFO, logger="host"):
        await host.on_input({
            "viewerId": "viewer-1",
            "type": ["keyboard", "TYPE_CANARY"],
            "action": {"name": "ACTION_CANARY"},
            "transport": ["socket"],
            "status": {"name": "STATUS_CANARY"},
            "reason": ["REASON_CANARY"],
            "payload": {"text": "PAYLOAD_CANARY"},
        })
        for action in (["move", "ACTION_CANARY"], {"name": "move"}):
            await host.on_input({
                "viewerId": "viewer-1",
                "type": "mouse",
                "action": action,
                "transport": "socket",
                "inputIds": ["mouse_fixture"],
                "payload": {"relX": 0.2, "relY": 0.3},
            })

    messages = [record.getMessage() for record in caplog.records if record.name == "host"]
    rejected = [json.loads(message) for message in messages if '"event":"host_input_rejected"' in message]
    assert len(rejected) == 1
    assert rejected[0]["meta"]["status"] == "invalid-input"
    assert rejected[0]["meta"]["inputType"] == "unknown"
    assert "CANARY" not in "\n".join(messages)


@pytest.mark.asyncio
async def test_host_aggregates_high_frequency_mouse_outcomes_without_hashing(caplog, monkeypatch):
    host = object.__new__(WebRemoteHost)
    host.current_viewer_id = "viewer-1"
    host.overlay = SimpleNamespace(send=lambda _payload: None)
    host.screen_track = None

    async def handle_input(_data):
        return {"inputIds": [], "status": "unordered"}

    host.input_adapter = SimpleNamespace(handle_input=handle_input)
    def fail_hash(_input_ids):
        raise AssertionError("high-frequency input must not hash")

    monkeypatch.setattr(observability, "hash_input_ids", fail_hash)
    host.input_handler = host.input_adapter
    with caplog.at_level(logging.INFO, logger="host"):
        for action in ("move", "wheel"):
            for _index in range(100):
                await host.on_input({
                    "viewerId": "viewer-1",
                    "type": "mouse",
                    "action": action,
                    "transport": "socket",
                    "inputIds": ["mouse_fixture"],
                    "payload": {
                        "relX": 0.5,
                        "relY": 0.5,
                        **({"buttons": 0} if action == "move" else {"deltaX": 0, "deltaY": 120}),
                    },
                })

    messages = [record.getMessage() for record in caplog.records if record.name == "host"]
    aggregates = [json.loads(message) for message in messages if '"event":"host_input_aggregate"' in message]
    assert len(aggregates) == 4
    assert {line["meta"]["action"] for line in aggregates} == {"move", "wheel"}
    assert {line["meta"]["count"] for line in aggregates} == {100}
    assert {line["meta"]["status"] for line in aggregates} == {"accepted", "unordered"}
    assert all(
        field not in line["meta"]
        for line in aggregates
        for field in (
            "inputIdHash", "inputIdCount", "payloadBytes", "seq", "leaseEpoch",
            "appliedSeq", "localExecuteMs", "timingScope", "timingIncludesQueueWait", "ackAccepted",
        )
    )
    text = "\n".join(messages)
    assert "mouse_fixture" not in text


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
