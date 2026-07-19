import input_handler
import asyncio
import inspect
import logging
import pytest
from input_handler import InputHandler


def test_input_method_switch_remains_an_explicit_quartz_command():
    source = inspect.getsource(input_handler)

    assert "switchInputMethod" in source
    assert "TISSelectInputSource" not in source
    assert "ctypes" not in source


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
async def test_cancelled_input_waiter_does_not_leave_stale_waiter_count(monkeypatch):
    handler = InputHandler()
    handler._running = True

    await handler._input_lock.acquire()
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
        handler._input_lock.release()

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
    handler.release_all_mouse_buttons(reason="viewer-disconnected")
    handler.release_all_mouse_buttons(reason="duplicate")

    assert [event["event_type"] for event in posted] == [input_handler.kCGEventRightMouseUp]


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
