from types import SimpleNamespace
import inspect

import pytest

import input_handler
import quartz_keyboard_adapter as adapter_module
from quartz_keyboard_adapter import (
    MAC_KEY_CODE_BY_DOM_CODE,
    QuartzKeyboardAdapter,
    UnsupportedPhysicalCode,
)


EXISTING_DOM_CODE_MAPPINGS = {
    "KeyA": 0, "KeyB": 11, "KeyC": 8, "KeyD": 2, "KeyE": 14,
    "KeyF": 3, "KeyG": 5, "KeyH": 4, "KeyI": 34, "KeyJ": 38,
    "KeyK": 40, "KeyL": 37, "KeyM": 46, "KeyN": 45, "KeyO": 31,
    "KeyP": 35, "KeyQ": 12, "KeyR": 15, "KeyS": 1, "KeyT": 17,
    "KeyU": 32, "KeyV": 9, "KeyW": 13, "KeyX": 7, "KeyY": 16,
    "KeyZ": 6,
    "Digit0": 29, "Digit1": 18, "Digit2": 19, "Digit3": 20,
    "Digit4": 21, "Digit5": 23, "Digit6": 22, "Digit7": 26,
    "Digit8": 28, "Digit9": 25,
    "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96,
    "F6": 97, "F7": 98, "F8": 100, "F9": 101, "F10": 109,
    "F11": 103, "F12": 111, "F13": 105, "F14": 107, "F15": 113,
    "F16": 106, "F17": 64, "F18": 79, "F19": 80, "F20": 90,
    "Enter": 36, "NumpadEnter": 76, "Escape": 53, "Backspace": 51,
    "Tab": 48, "Space": 49, "ArrowUp": 126, "ArrowDown": 125,
    "ArrowLeft": 123, "ArrowRight": 124, "ControlLeft": 59,
    "ControlRight": 62, "AltLeft": 58, "AltRight": 61,
    "ShiftLeft": 56, "ShiftRight": 60, "MetaLeft": 55, "MetaRight": 54,
    "CapsLock": 57, "Delete": 117, "Home": 115, "End": 119,
    "PageUp": 116, "PageDown": 121, "Insert": 114,
    "Period": 47, "Comma": 43, "Semicolon": 41, "Quote": 39,
    "Slash": 44, "Backslash": 42, "BracketLeft": 33, "BracketRight": 30,
    "Backquote": 50, "Minus": 27, "Equal": 24,
    "Numpad0": 82, "Numpad1": 83, "Numpad2": 84, "Numpad3": 85,
    "Numpad4": 86, "Numpad5": 87, "Numpad6": 88, "Numpad7": 89,
    "Numpad8": 91, "Numpad9": 92, "NumpadMultiply": 67,
    "NumpadAdd": 69, "NumpadSubtract": 78, "NumpadDecimal": 65,
    "NumpadDivide": 75, "NumpadEqual": 81, "NumpadClear": 71,
    "NumLock": 71,
}


def patch_quartz(monkeypatch, *, caps_flags=0):
    calls = SimpleNamespace(events=[], unicode_strings=[], source_creations=[])
    monkeypatch.setattr(
        adapter_module,
        "CGEventSourceCreate",
        lambda state: calls.source_creations.append(state) or "source",
    )
    monkeypatch.setattr(
        adapter_module,
        "CGEventCreateKeyboardEvent",
        lambda source, key_code, is_down: {
            "source": source,
            "key_code": key_code,
            "is_down": is_down,
            "flags": None,
        },
    )
    monkeypatch.setattr(
        adapter_module,
        "CGEventSetFlags",
        lambda event, flags: event.__setitem__("flags", flags),
    )
    monkeypatch.setattr(
        adapter_module,
        "CGEventPost",
        lambda _tap, event: calls.events.append(event),
    )
    monkeypatch.setattr(
        adapter_module,
        "CGEventKeyboardSetUnicodeString",
        lambda _event, _length, value: calls.unicode_strings.append(value),
    )
    monkeypatch.setattr(
        adapter_module,
        "CGEventSourceFlagsState",
        lambda _state: caps_flags,
    )
    return calls


def test_existing_physical_code_mappings_are_retained():
    for code, mac_code in EXISTING_DOM_CODE_MAPPINGS.items():
        assert MAC_KEY_CODE_BY_DOM_CODE[code] == mac_code


@pytest.mark.parametrize(("code", "mac_code"), [
    ("IntlBackslash", 10),
    ("IntlYen", 93),
    ("IntlRo", 94),
    ("NumpadComma", 95),
    ("Lang2", 102),
    ("Lang1", 104),
    ("KanaMode", 104),
    ("ShiftLeft", 56),
    ("ShiftRight", 60),
])
def test_physical_code_mapping(code, mac_code):
    assert MAC_KEY_CODE_BY_DOM_CODE[code] == mac_code


@pytest.mark.parametrize("code", ["ContextMenu", "Convert", "NonConvert"])
def test_unsupported_physical_codes_raise(code, monkeypatch):
    patch_quartz(monkeypatch)
    with pytest.raises(UnsupportedPhysicalCode):
        QuartzKeyboardAdapter().post_key(code, True, 0)


def test_numpad_decimal_and_comma_are_distinct():
    assert MAC_KEY_CODE_BY_DOM_CODE["NumpadDecimal"] == 65
    assert MAC_KEY_CODE_BY_DOM_CODE["NumpadComma"] == 95


def test_post_key_uses_optional_source_and_posts_modifier_flags(monkeypatch):
    calls = patch_quartz(monkeypatch)
    adapter = QuartzKeyboardAdapter(source="given-source")

    adapter.post_key("KeyA", True, 0x20000)

    assert calls.source_creations == []
    assert calls.events == [{
        "source": "given-source", "key_code": 0, "is_down": True, "flags": 0x20000,
    }]


def test_text_uses_unicode_events_without_global_input_source_mutation(monkeypatch):
    calls = patch_quartz(monkeypatch)
    QuartzKeyboardAdapter().post_text("中文🙂")

    assert calls.unicode_strings == ["中文🙂"]
    assert [event["key_code"] for event in calls.events] == [0]


def test_text_chunks_without_splitting_utf16_surrogate_pairs(monkeypatch):
    calls = patch_quartz(monkeypatch)
    text = "x" * 1023 + "🙂" + "y" * 1023

    QuartzKeyboardAdapter().post_text(text)

    assert "".join(calls.unicode_strings) == text
    assert all(len(chunk.encode("utf-16-le")) // 2 <= 1024 for chunk in calls.unicode_strings)


@pytest.mark.parametrize(("requested", "expected"), [(-1, 0), (0, 0), (4.5, 4.5), (12, 12), (99, 12)])
def test_step_delay_is_clamped_to_supported_range(requested, expected):
    adapter = QuartzKeyboardAdapter(source="source", step_delay_ms=requested)
    assert adapter.step_delay_ms == expected


def test_caps_lock_reads_quartz_lock_flag(monkeypatch):
    patch_quartz(monkeypatch, caps_flags=adapter_module.kCGEventFlagMaskAlphaShift)
    assert QuartzKeyboardAdapter().get_caps_lock() is True


def test_caps_lock_taps_only_when_current_state_differs(monkeypatch):
    calls = patch_quartz(monkeypatch, caps_flags=0)
    adapter = QuartzKeyboardAdapter()

    adapter.set_caps_lock(None)
    adapter.set_caps_lock(False)
    adapter.set_caps_lock(True)

    assert [(event["key_code"], event["is_down"]) for event in calls.events] == [
        (57, True), (57, False),
    ]


def test_no_startup_input_method_side_effects_remain():
    adapter_source = inspect.getsource(adapter_module)
    handler_source = inspect.getsource(input_handler)
    assert "subprocess" not in adapter_source
    assert "ApplePressAndHoldEnabled" not in handler_source
    assert "_setup_macos_input" not in handler_source
    assert "_switch_to_abc_keyboard" not in handler_source


def test_reconcile_releases_phantom_control_on_next_plain_keydown(monkeypatch):
    """
    Scenario: viewer sent ControlLeft keydown but its keyup was lost (DataChannel hiccup).
    On the next plain-key keydown with modifiers.ctrl=False, the phantom Control
    must be cleared via _release_lost_modifier_flags before the key is posted.
    """
    calls = patch_quartz(monkeypatch)
    import input_handler as ih
    monkeypatch.setattr(ih, "CGEventCreateKeyboardEvent",
                        lambda src, kc, down: {"source": src, "key_code": kc, "is_down": down, "flags": None})
    monkeypatch.setattr(ih, "CGEventSetFlags",
                        lambda ev, fl: ev.__setitem__("flags", fl))
    monkeypatch.setattr(ih, "CGEventPost",
                        lambda _tap, ev: calls.events.append(ev))
    monkeypatch.setattr(ih, "CGEventSourceCreate", lambda _: "source")

    handler = ih.InputHandler.__new__(ih.InputHandler)
    handler.source = "source"
    handler._modifier_flags = ih.kCGEventFlagMaskControl  # phantom Control
    handler._pressed_modifier_key_codes = set()            # keyup was lost — not tracked
    handler._pressed_key_codes = set()
    handler._last_key_flags = {}
    handler._modifier_stale_seconds = 8.0

    # Simulate plain 'A' keydown (code=KeyA) with no modifiers from browser
    payload = {
        "code": "KeyA",
        "key": "a",
        "modifiers": {"ctrl": False, "shift": False, "alt": False, "meta": False},
        "phase": "down",
    }
    handler._handle_keyboard("keydown", payload)

    # _modifier_flags must be cleared
    assert handler._modifier_flags == 0, \
        f"phantom Control flag not cleared: 0x{handler._modifier_flags:08x}"
    # No CGEvent keyup for Control should have been posted because pressed set was empty
    # (the flag is still cleared via bit mask even without a physical keyup event)


def test_reconcile_preserves_real_cmd_c_modifier(monkeypatch):
    """
    Scenario: user presses Cmd+C normally — MetaLeft is truly held.
    The reconcile must NOT clear the Meta flag because payload.meta=True matches.
    """
    calls = patch_quartz(monkeypatch)
    import input_handler as ih
    monkeypatch.setattr(ih, "CGEventCreateKeyboardEvent",
                        lambda src, kc, down: {"source": src, "key_code": kc, "is_down": down, "flags": None})
    monkeypatch.setattr(ih, "CGEventSetFlags",
                        lambda ev, fl: ev.__setitem__("flags", fl))
    monkeypatch.setattr(ih, "CGEventPost",
                        lambda _tap, ev: calls.events.append(ev))
    monkeypatch.setattr(ih, "CGEventSourceCreate", lambda _: "source")

    handler = ih.InputHandler.__new__(ih.InputHandler)
    handler.source = "source"
    handler._modifier_flags = ih.kCGEventFlagMaskCommand  # real Cmd held
    handler._pressed_modifier_key_codes = {55}             # MetaLeft tracked
    handler._pressed_key_codes = {55}
    handler._last_key_flags = {}
    handler._modifier_stale_seconds = 8.0

    # C keydown while Cmd is genuinely held
    payload = {
        "code": "KeyC",
        "key": "c",
        "modifiers": {"ctrl": False, "shift": False, "alt": False, "meta": True},
        "phase": "down",
    }
    handler._handle_keyboard("keydown", payload)

    assert handler._modifier_flags & ih.kCGEventFlagMaskCommand, \
        "real Cmd flag must NOT be cleared during Cmd+C"


def test_reconcile_does_not_fire_for_ime_nav_keys(monkeypatch):
    """Arrow keys must bypass reconcile even when phantom modifier flags are set."""
    calls = patch_quartz(monkeypatch)
    import input_handler as ih
    monkeypatch.setattr(ih, "CGEventCreateKeyboardEvent",
                        lambda src, kc, down: {"source": src, "key_code": kc, "is_down": down, "flags": None})
    monkeypatch.setattr(ih, "CGEventSetFlags",
                        lambda ev, fl: ev.__setitem__("flags", fl))
    monkeypatch.setattr(ih, "CGEventPost",
                        lambda _tap, ev: calls.events.append(ev))
    monkeypatch.setattr(ih, "CGEventSourceCreate", lambda _: "source")

    handler = ih.InputHandler.__new__(ih.InputHandler)
    handler.source = "source"
    handler._modifier_flags = ih.kCGEventFlagMaskControl  # phantom Control
    handler._pressed_modifier_key_codes = set()
    handler._pressed_key_codes = set()
    handler._last_key_flags = {}
    handler._modifier_stale_seconds = 8.0

    # Left Arrow (key_code=123) is in _ime_nav_keys — reconcile must NOT fire
    payload = {
        "code": "ArrowLeft",
        "key": "ArrowLeft",
        "modifiers": {"ctrl": False, "shift": False, "alt": False, "meta": False},
        "phase": "down",
    }
    handler._handle_keyboard("keydown", payload)

    assert handler._modifier_flags & ih.kCGEventFlagMaskControl, \
        "reconcile must NOT clear phantom Control when key is an IME nav key (arrow/Esc)"
