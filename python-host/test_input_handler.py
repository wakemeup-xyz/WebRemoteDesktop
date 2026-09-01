import input_handler
import asyncio
import inspect
import logging
import threading
import time
import pytest
from input_handler import InputHandler
from remote_keyboard_state import LegacyInputAdapter


LEASE_ID = "lease-000000000001"


class BlockingAdapter:
    def __init__(self):
        self.events = []
        self.started = threading.Event()
        self.allow = threading.Event()

    def post_key(self, code, is_down, modifier_mask):
        self.started.set()
        while not self.allow.is_set():
            time.sleep(0.001)
        self.events.append((code, is_down, modifier_mask))

    def post_text(self, text):
        self.events.append(("text", text))


class RecordingAdapter:
    def __init__(self):
        self.events = []

    def post_key(self, code, is_down, modifier_mask):
        self.events.append((code, is_down, modifier_mask))

    def post_text(self, text):
        self.events.append(("text", text))


def key_envelope(*, seq, phase, code="KeyA", epoch=1, lease_id=LEASE_ID):
    return {
        "schemaVersion": 2,
        "type": "keyboard",
        "action": "key",
        "leaseId": lease_id,
        "leaseEpoch": epoch,
        "seq": seq,
        "inputIds": [f"input-{seq}"],
        "payload": {
            "phase": phase,
            "code": code,
            "location": 0,
            "repeat": False,
            "modifiers": {
                "altKey": False,
                "ctrlKey": False,
                "metaKey": False,
                "shiftKey": False,
            },
            "locks": {"capsLock": False},
        },
    }


@pytest.mark.asyncio
async def test_disconnect_reset_is_serialized_after_inflight_keydown():
    async def run_case():
        adapter = BlockingAdapter()
        handler = InputHandler(keyboard_adapter=adapter)
        handler._running = True
        await handler.transition_keyboard(
            connection_generation=1,
            lease_id=LEASE_ID,
            lease_epoch=1,
        )
        apply_task = asyncio.create_task(handler.apply_keyboard(key_envelope(seq=1, phase="down")))
        assert await asyncio.to_thread(adapter.started.wait, 1)
        reset_task = asyncio.create_task(handler.reset_keyboard(reason="signal-disconnect"))
        adapter.allow.set()
        await asyncio.gather(apply_task, reset_task)
        return handler, adapter

    handler, adapter = await asyncio.wait_for(run_case(), timeout=1)

    assert adapter.events[-1][:2] == ("KeyA", False)
    assert handler.get_keyboard_snapshot().pressed_key_count == 0


@pytest.mark.asyncio
async def test_v2_keyboard_state_ignores_host_routing_metadata():
    adapter = RecordingAdapter()
    handler = InputHandler(keyboard_adapter=adapter)
    handler._running = True
    await handler.transition_keyboard(
        connection_generation=1,
        lease_id=LEASE_ID,
        lease_epoch=1,
    )
    routed = key_envelope(seq=1, phase="down")
    routed.update({
        "viewerId": "viewer-1",
        "connectionGeneration": 1,
        "transport": "datachannel",
    })

    result = await handler.apply_keyboard(routed)

    assert result["status"] == "applied"
    assert result["pressedKeyCount"] == 1
    assert adapter.events == [("KeyA", True, 0)]


@pytest.mark.asyncio
async def test_legacy_keyboard_uses_leased_executor_and_resets_before_transport_switch(monkeypatch):
    adapter = RecordingAdapter()
    handler = InputHandler(keyboard_adapter=adapter)
    handler._running = True
    await handler.transition_keyboard(
        connection_generation=1,
        lease_id=LEASE_ID,
        lease_epoch=1,
    )
    monkeypatch.setattr(
        handler,
        "_handle_keyboard",
        lambda *_args: pytest.fail("legacy keyboard bypassed the leased executor"),
    )

    first = await handler.apply_keyboard({
        "type": "keyboard",
        "action": "keydown",
        "payload": {"code": "KeyA"},
        "inputIds": ["legacy-a"],
    }, transport="socket")
    second = await handler.apply_keyboard({
        "type": "keyboard",
        "action": "keydown",
        "payload": {"code": "KeyB"},
        "inputIds": ["legacy-b"],
    }, transport="datachannel")

    assert first["status"] == "applied"
    assert second["status"] == "applied"
    assert adapter.events == [
        ("KeyA", True, 0),
        ("KeyA", False, 0),
        ("KeyB", True, 0),
    ]
    assert handler.get_keyboard_snapshot().pressed_codes == frozenset({"KeyB"})


@pytest.mark.asyncio
async def test_legacy_reset_normalizes_unknown_reason_and_releases_leased_key_state():
    adapter = RecordingAdapter()
    handler = InputHandler(keyboard_adapter=adapter)
    handler._running = True
    await handler.transition_keyboard(
        connection_generation=1,
        lease_id=LEASE_ID,
        lease_epoch=1,
    )

    await handler.apply_keyboard({
        "type": "keyboard",
        "action": "keydown",
        "payload": {"code": "KeyA"},
        "inputIds": ["legacy-down"],
    }, transport="socket")
    reset = await handler.apply_keyboard({
        "type": "keyboard",
        "action": "reset",
        "payload": {"reason": "activated"},
        "inputIds": ["legacy-reset"],
    }, transport="socket")

    assert reset["status"] == "applied"
    assert adapter.events == [("KeyA", True, 0), ("KeyA", False, 0)]
    snapshot = handler.get_keyboard_snapshot()
    assert snapshot.pressed_key_count == 0
    assert snapshot.last_applied_seq == 2


def test_legacy_reset_reason_keeps_known_values_and_normalizes_unknown_values():
    assert LegacyInputAdapter._normalise({
        "action": "reset",
        "payload": {"reason": "window-blur"},
    }) == ("reset", {"reason": "window-blur"})
    assert LegacyInputAdapter._normalise({
        "action": "reset",
        "payload": {"reason": "activated"},
    }) == ("reset", {"reason": "unspecified"})


def test_input_method_switch_remains_an_explicit_quartz_command():
    source = inspect.getsource(input_handler)

    assert "switchInputMethod" in source
    assert "TISSelectInputSource" not in source
    assert "ctypes" not in source


def test_show_dock_opens_launchpad(monkeypatch):
    import subprocess

    calls = []

    class Result:
        returncode = 0
        stdout = ""
        stderr = ""

    def fake_run(argv, **kwargs):
        calls.append(list(argv))
        return Result()

    monkeypatch.setattr(subprocess, "run", fake_run)
    handler = InputHandler()
    handler._show_dock()
    assert ["open", "-a", "Launchpad"] in calls


@pytest.mark.asyncio
@pytest.mark.parametrize("code", ("ContextMenu", "Convert", "NonConvert"))
async def test_unsupported_physical_codes_do_not_fall_back_to_legacy_key_names(monkeypatch, code):
    posted = []
    monkeypatch.setattr(
        input_handler,
        "CGEventCreateKeyboardEvent",
        lambda _source, key_code, is_down: {"key_code": key_code, "is_down": is_down},
    )
    monkeypatch.setattr(input_handler, "CGEventPost", lambda _tap, event: posted.append(event))

    handler = InputHandler()
    handler._running = True
    await handler.transition_keyboard(
        connection_generation=1,
        lease_id=LEASE_ID,
        lease_epoch=1,
    )
    result = await handler.handle_input({
        "type": "keyboard",
        "action": "keydown",
        "payload": {"code": code, "key": code, "modifiers": {}},
    })

    assert result["status"] == "unsupported-code"
    assert posted == []


def test_unknown_physical_code_keeps_legacy_key_name_fallback(monkeypatch):
    posted = []
    monkeypatch.setattr(
        input_handler,
        "CGEventCreateKeyboardEvent",
        lambda _source, key_code, is_down: {"key_code": key_code, "is_down": is_down},
    )
    monkeypatch.setattr(input_handler, "CGEventPost", lambda _tap, event: posted.append(event))

    InputHandler()._handle_keyboard(
        "keydown", {"code": "Unidentified", "key": "Enter", "modifiers": {}}
    )

    assert [(event["key_code"], event["is_down"]) for event in posted] == [(36, True)]


def test_release_all_modifiers_posts_stuck_alt_keyup(monkeypatch):
    posted = []

    def fake_create_keyboard_event(source, key_code, is_down):
        return {"key_code": key_code, "is_down": is_down, "flags": None}

    def fake_set_flags(event, flags):
        event["flags"] = flags

    def fake_post(tap, event):
        posted.append(event)

    monkeypatch.setattr(input_handler, "CGEventCreateKeyboardEvent", fake_create_keyboard_event)
    monkeypatch.setattr(input_handler, "CGEventSetFlags", fake_set_flags)
    monkeypatch.setattr(input_handler, "CGEventPost", fake_post)

    handler = InputHandler()
    handler._handle_keyboard(
        "keydown",
        {
            "key": "Alt",
            "code": "AltLeft",
            "keyCode": 18,
            "modifiers": {"ctrl": 0, "shift": 0, "alt": 1, "meta": 0},
        },
    )

    handler.release_all_modifiers(reason="test")

    assert posted[-1]["key_code"] == 58
    assert posted[-1]["is_down"] is False
    assert handler._modifier_flags == 0


def test_mouse_wheel_uses_scroll_wheel_event_with_normalized_deltas(monkeypatch):
    posted = []
    created = []

    def fake_create_scroll_event(source, unit, wheel_count, axis1, axis2):
        event = {
            "source": source,
            "unit": unit,
            "wheel_count": wheel_count,
            "axis1": axis1,
            "axis2": axis2,
        }
        created.append(event)
        return event

    def fake_post(tap, event):
        posted.append(event)

    monkeypatch.setattr(input_handler, "CGEventCreateScrollWheelEvent", fake_create_scroll_event)
    monkeypatch.setattr(input_handler, "CGEventPost", fake_post)

    handler = InputHandler()
    handler.monitor = type("Monitor", (), {"x": 0, "y": 0, "width": 1000, "height": 800})()

    handler._handle_mouse(
        "wheel",
        {
            "relX": 0.5,
            "relY": 0.5,
            "deltaX": 40,
            "deltaY": 120,
        },
    )

    assert posted == created
    assert created[0]["wheel_count"] == 2
    assert created[0]["axis1"] == -3
    assert created[0]["axis2"] == -1


def test_release_all_keys_posts_stuck_regular_keyup(monkeypatch):
    posted = []

    def fake_create_keyboard_event(source, key_code, is_down):
        return {"key_code": key_code, "is_down": is_down, "flags": None}

    def fake_set_flags(event, flags):
        event["flags"] = flags

    def fake_post(tap, event):
        posted.append(event)

    monkeypatch.setattr(input_handler, "CGEventCreateKeyboardEvent", fake_create_keyboard_event)
    monkeypatch.setattr(input_handler, "CGEventSetFlags", fake_set_flags)
    monkeypatch.setattr(input_handler, "CGEventPost", fake_post)

    handler = InputHandler()
    handler._handle_keyboard(
        "keydown",
        {
            "key": "s",
            "code": "KeyS",
            "keyCode": 83,
            "modifiers": {"ctrl": 0, "shift": 0, "alt": 0, "meta": 0},
        },
    )

    handler.release_all_keys(reason="test")

    assert posted[-1]["key_code"] == 1
    assert posted[-1]["is_down"] is False
    assert handler._pressed_key_codes == set()


def test_plain_key_releases_stuck_modifier_before_posting(monkeypatch):
    posted = []

    def fake_create_keyboard_event(source, key_code, is_down):
        return {"key_code": key_code, "is_down": is_down, "flags": None}

    def fake_set_flags(event, flags):
        event["flags"] = flags

    def fake_post(tap, event):
        posted.append(event)

    monkeypatch.setattr(input_handler, "CGEventCreateKeyboardEvent", fake_create_keyboard_event)
    monkeypatch.setattr(input_handler, "CGEventSetFlags", fake_set_flags)
    monkeypatch.setattr(input_handler, "CGEventPost", fake_post)

    handler = InputHandler()
    handler._handle_keyboard(
        "keydown",
        {
            "key": "Shift",
            "code": "ShiftLeft",
            "keyCode": 16,
            "modifiers": {"ctrl": 0, "shift": 1, "alt": 0, "meta": 0},
        },
    )
    handler._handle_keyboard(
        "keydown",
        {
            "key": "s",
            "code": "KeyS",
            "keyCode": 83,
            "modifiers": {"ctrl": 0, "shift": 0, "alt": 0, "meta": 0},
        },
    )

    assert posted[-2]["key_code"] == 56
    assert posted[-2]["is_down"] is False
    assert posted[-1]["key_code"] == 1
    assert posted[-1]["is_down"] is True
    assert posted[-1]["flags"] in (None, 0)


@pytest.mark.asyncio
async def test_mouse_move_is_dropped_when_input_lock_is_busy(monkeypatch):
    calls = []
    handler = InputHandler()
    handler._running = True
    handler._handle_mouse = lambda action, payload: calls.append((action, payload))

    await handler._input_lock.acquire()
    try:
        result = await asyncio.wait_for(
            handler.handle_input({
                "type": "mouse",
                "action": "move",
                "payload": {"relX": 0.5, "relY": 0.5},
                "inputIds": ["move-1"],
            }),
            timeout=0.05,
        )
    finally:
        handler._input_lock.release()

    assert calls == []
    assert result["inputIds"] == ["move-1"]


@pytest.mark.asyncio
async def test_mouse_and_command_accept_v2_sequence_metadata_without_keyboard_routing():
    calls = []
    handler = InputHandler()
    handler._running = True
    handler._handle_mouse = lambda action, payload: calls.append(("mouse", action))
    handler._handle_command = lambda action, payload: calls.append(("command", action))

    mouse_result = await handler.handle_input({
        "schemaVersion": 2,
        "type": "mouse",
        "action": "reset",
        "seq": 1,
        "inputIds": ["mouse-v2"],
        "payload": {},
    })
    command_result = await handler.handle_input({
        "schemaVersion": 2,
        "type": "command",
        "action": "showDock",
        "seq": 2,
        "inputIds": ["command-v2"],
        "payload": {},
    })

    assert calls == [("mouse", "reset"), ("command", "showDock")]
    assert mouse_result["inputIds"] == ["mouse-v2"]
    assert command_result["inputIds"] == ["command-v2"]


@pytest.mark.asyncio
async def test_cancelled_input_waiter_does_not_leave_stale_waiter_count(monkeypatch):
    handler = InputHandler()
    handler._running = True

    await handler._keyboard_lock.acquire()
    try:
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(
                handler.handle_input({
                    "type": "keyboard",
                    "action": "keydown",
                    "payload": {"key": "a", "code": "KeyA"},
                }),
                timeout=0.01,
            )
    finally:
        handler._keyboard_lock.release()

    assert handler._lock_waiters == 0


@pytest.mark.asyncio
async def test_keyboard_handler_does_not_sleep_while_input_lock_is_held(monkeypatch):
    handler = InputHandler()
    handler._running = True
    handler._handle_keyboard = lambda action, payload: None
    sleep_lock_states = []

    async def fake_sleep(seconds):
        sleep_lock_states.append(handler._input_lock.locked())

    monkeypatch.setattr(input_handler.asyncio, "sleep", fake_sleep)

    await handler.handle_input({
        "type": "keyboard",
        "action": "keydown",
        "payload": {"key": "a", "code": "KeyA"},
    })

    assert True not in sleep_lock_states


def test_mouse_reset_releases_tracked_button_once(monkeypatch):
    posted = []

    def fake_create_mouse_event(source, event_type, position, button_type):
        return {"event_type": event_type, "position": position, "button_type": button_type}

    monkeypatch.setattr(input_handler, "CGEventCreateMouseEvent", fake_create_mouse_event)
    monkeypatch.setattr(input_handler, "CGEventPost", lambda _tap, event: posted.append(event))

    handler = InputHandler()
    handler.monitor = type("Monitor", (), {"x": 0, "y": 0, "width": 1000, "height": 800})()
    handler._handle_mouse("down", {"button": "left", "relX": 0.2, "relY": 0.3})
    handler._handle_mouse("reset", {"reason": "pointer-cancel"})
    handler._handle_mouse("reset", {"reason": "duplicate"})

    assert [event["event_type"] for event in posted] == [
        input_handler.kCGEventLeftMouseDown,
        input_handler.kCGEventLeftMouseUp,
    ]
    assert handler._pressed_mouse_button is None


def test_mouse_down_and_up_apply_click_count(monkeypatch):
    posted = []

    def fake_create_mouse_event(source, event_type, position, button_type):
        return {"event_type": event_type, "position": position, "button_type": button_type}

    def fake_set_integer(event, field, value):
        event["integer"] = (field, value)

    monkeypatch.setattr(input_handler, "CGEventCreateMouseEvent", fake_create_mouse_event)
    monkeypatch.setattr(input_handler, "CGEventSetIntegerValueField", fake_set_integer)
    monkeypatch.setattr(input_handler, "CGEventPost", lambda _tap, event: posted.append(event))

    handler = InputHandler()
    handler.monitor = type("Monitor", (), {"x": 0, "y": 0, "width": 1000, "height": 800})()
    handler._handle_mouse("down", {"button": "left", "relX": 0.5, "relY": 0.5, "clickCount": 2})
    handler._handle_mouse("up", {"button": "left", "relX": 0.5, "relY": 0.5, "clickCount": 2})

    assert [event["integer"] for event in posted] == [
        (input_handler.kCGMouseEventClickState, 2),
        (input_handler.kCGMouseEventClickState, 2),
    ]


def test_release_all_mouse_buttons_is_public_and_idempotent(monkeypatch):
    posted = []
    monkeypatch.setattr(
        input_handler,
        "CGEventCreateMouseEvent",
        lambda _source, event_type, _position, _button: {"event_type": event_type},
    )
    monkeypatch.setattr(input_handler, "CGEventPost", lambda _tap, event: posted.append(event))

    handler = InputHandler()
    handler.monitor = type("Monitor", (), {"x": 0, "y": 0, "width": 1000, "height": 800})()
    handler._pressed_mouse_button = "right"
    handler._pressed_mouse_buttons = {"right"}
    handler.release_all_mouse_buttons(reason="viewer-disconnected")
    handler.release_all_mouse_buttons(reason="duplicate")

    assert [event["event_type"] for event in posted] == [input_handler.kCGEventRightMouseUp]
    assert handler._pressed_mouse_buttons == set()
    assert handler._pressed_mouse_button is None


def test_mouse_tracks_multiple_buttons_and_releases_each(monkeypatch):
    posted = []

    def fake_create_mouse_event(source, event_type, position, button_type):
        return {"event_type": event_type, "position": position, "button_type": button_type}

    monkeypatch.setattr(input_handler, "CGEventCreateMouseEvent", fake_create_mouse_event)
    monkeypatch.setattr(input_handler, "CGEventPost", lambda _tap, event: posted.append(event))

    handler = InputHandler()
    handler.monitor = type("Monitor", (), {"x": 0, "y": 0, "width": 1000, "height": 800})()
    handler._handle_mouse("down", {"button": "left", "relX": 0.1, "relY": 0.1})
    handler._handle_mouse("down", {"button": "right", "relX": 0.1, "relY": 0.1})
    assert handler._pressed_mouse_buttons == {"left", "right"}
    handler._handle_mouse("move", {"relX": 0.2, "relY": 0.2})
    assert posted[-1]["event_type"] == input_handler.kCGEventLeftMouseDragged
    handler._handle_mouse("up", {"button": "left", "relX": 0.2, "relY": 0.2})
    assert handler._pressed_mouse_buttons == {"right"}
    handler._handle_mouse("move", {"relX": 0.3, "relY": 0.3})
    assert posted[-1]["event_type"] == input_handler.kCGEventRightMouseDragged
    handler.release_all_mouse_buttons(reason="test")
    assert handler._pressed_mouse_buttons == set()
    assert handler._pressed_mouse_button is None


def test_mouse_move_with_buttons_zero_clears_stuck_pressed_button(monkeypatch):
    posted = []

    def fake_create_mouse_event(source, event_type, position, button_type):
        return {"event_type": event_type, "position": position, "button_type": button_type}

    monkeypatch.setattr(input_handler, "CGEventCreateMouseEvent", fake_create_mouse_event)
    monkeypatch.setattr(input_handler, "CGEventPost", lambda _tap, event: posted.append(event))

    handler = InputHandler()
    handler.monitor = type("Monitor", (), {"x": 0, "y": 0, "width": 1000, "height": 800})()
    handler._handle_mouse("down", {"button": "left", "relX": 0.2, "relY": 0.3})
    assert handler._pressed_mouse_button == "left"

    # Lost up: move arrives with buttons===0 and must not stay in drag mode.
    handler._handle_mouse("move", {"relX": 0.4, "relY": 0.5, "buttons": 0})

    assert handler._pressed_mouse_button is None
    assert posted[-2]["event_type"] == input_handler.kCGEventLeftMouseUp
    assert posted[-1]["event_type"] == input_handler.kCGEventMouseMoved


def test_mouse_move_without_buttons_field_keeps_drag_while_pressed(monkeypatch):
    posted = []

    def fake_create_mouse_event(source, event_type, position, button_type):
        return {"event_type": event_type, "position": position, "button_type": button_type}

    monkeypatch.setattr(input_handler, "CGEventCreateMouseEvent", fake_create_mouse_event)
    monkeypatch.setattr(input_handler, "CGEventPost", lambda _tap, event: posted.append(event))

    handler = InputHandler()
    handler.monitor = type("Monitor", (), {"x": 0, "y": 0, "width": 1000, "height": 800})()
    handler._handle_mouse("down", {"button": "left", "relX": 0.1, "relY": 0.1})
    handler._handle_mouse("move", {"relX": 0.2, "relY": 0.2})

    assert handler._pressed_mouse_button == "left"
    assert posted[-1]["event_type"] == input_handler.kCGEventLeftMouseDragged


def test_input_handler_logs_no_keyboard_values_or_mouse_coordinates(monkeypatch, caplog):
    posted = []
    monkeypatch.setattr(
        input_handler,
        "CGEventCreateMouseEvent",
        lambda _source, event_type, position, _button: {"event_type": event_type, "position": position},
    )
    monkeypatch.setattr(input_handler, "CGEventPost", lambda _tap, event: posted.append(event))

    handler = InputHandler()
    handler.monitor = type("Monitor", (), {"x": 0, "y": 0, "width": 1000, "height": 800})()
    with caplog.at_level(logging.INFO, logger="input_handler"):
        handler._handle_keyboard("keydown", {
            "key": "Secret123",
            "code": "KeyA",
            "keyCode": 65,
            "modifiers": {},
        })
        handler._handle_mouse("down", {
            "button": "left",
            "relX": 0.987654,
            "relY": 0.5,
        })

    text = "\n".join(record.getMessage() for record in caplog.records if record.name == "input_handler")
    assert "Secret123" not in text
    assert "KeyA" not in text
    assert "0.9877" not in text
    assert "screen=(" not in text
    assert "keyboard_input action=keydown" in text
    assert "mouse_input action=down" in text
