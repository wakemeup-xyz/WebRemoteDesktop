import input_handler
import asyncio
import pytest
from input_handler import InputHandler


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
