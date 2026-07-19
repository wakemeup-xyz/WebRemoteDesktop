"""Quartz implementation of the remote keyboard adapter contract."""

from Quartz import (
    CGEventCreateKeyboardEvent,
    CGEventKeyboardSetUnicodeString,
    CGEventPost,
    CGEventSetFlags,
    CGEventSourceCreate,
    CGEventSourceFlagsState,
    kCGEventFlagMaskAlphaShift,
    kCGEventSourceStateHIDSystemState,
    kCGHIDEventTap,
)

from remote_keyboard_state import UnsupportedPhysicalCode


MAC_KEY_CODE_BY_DOM_CODE = {
    # Letters
    "KeyA": 0, "KeyB": 11, "KeyC": 8, "KeyD": 2, "KeyE": 14,
    "KeyF": 3, "KeyG": 5, "KeyH": 4, "KeyI": 34, "KeyJ": 38,
    "KeyK": 40, "KeyL": 37, "KeyM": 46, "KeyN": 45, "KeyO": 31,
    "KeyP": 35, "KeyQ": 12, "KeyR": 15, "KeyS": 1, "KeyT": 17,
    "KeyU": 32, "KeyV": 9, "KeyW": 13, "KeyX": 7, "KeyY": 16,
    "KeyZ": 6,
    # Digits
    "Digit0": 29, "Digit1": 18, "Digit2": 19, "Digit3": 20,
    "Digit4": 21, "Digit5": 23, "Digit6": 22, "Digit7": 26,
    "Digit8": 28, "Digit9": 25,
    # Function keys
    "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96,
    "F6": 97, "F7": 98, "F8": 100, "F9": 101, "F10": 109,
    "F11": 103, "F12": 111, "F13": 105, "F14": 107, "F15": 113,
    "F16": 106, "F17": 64, "F18": 79, "F19": 80, "F20": 90,
    # Control and navigation
    "Enter": 36, "NumpadEnter": 36, "Escape": 53, "Backspace": 51,
    "Tab": 48, "Space": 49, "ArrowUp": 126, "ArrowDown": 125,
    "ArrowLeft": 123, "ArrowRight": 124, "ControlLeft": 59,
    "ControlRight": 62, "AltLeft": 58, "AltRight": 61,
    "ShiftLeft": 56, "ShiftRight": 60, "MetaLeft": 55, "MetaRight": 54,
    "CapsLock": 57, "Delete": 117, "Home": 115, "End": 119,
    "PageUp": 116, "PageDown": 121, "Insert": 114,
    # Punctuation and layout-specific physical keys
    "Period": 47, "Comma": 43, "Semicolon": 41, "Quote": 39,
    "Slash": 44, "Backslash": 42, "BracketLeft": 33, "BracketRight": 30,
    "Backquote": 50, "Minus": 27, "Equal": 24,
    "IntlBackslash": 10, "IntlYen": 93, "IntlRo": 94,
    "Lang2": 102, "Lang1": 104, "KanaMode": 104,
    # Numpad
    "Numpad0": 82, "Numpad1": 83, "Numpad2": 84, "Numpad3": 85,
    "Numpad4": 86, "Numpad5": 87, "Numpad6": 88, "Numpad7": 89,
    "Numpad8": 91, "Numpad9": 92, "NumpadMultiply": 67,
    "NumpadAdd": 69, "NumpadSubtract": 78, "NumpadDecimal": 65,
    "NumpadDivide": 75, "NumpadEqual": 81, "NumpadClear": 71,
    "NumLock": 71, "NumpadComma": 95,
}

_MAX_UNICODE_UTF16_UNITS = 1024


def _unicode_chunks(text: str):
    chunk = []
    unit_count = 0
    for character in text:
        character_units = len(character.encode("utf-16-le", errors="surrogatepass")) // 2
        if chunk and unit_count + character_units > _MAX_UNICODE_UTF16_UNITS:
            yield "".join(chunk)
            chunk = []
            unit_count = 0
        chunk.append(character)
        unit_count += character_units
    if chunk:
        yield "".join(chunk)


class QuartzKeyboardAdapter:
    """Posts physical keys and Unicode text through Quartz's HID event tap."""

    def __init__(self, *, source=None, step_delay_ms: float = 0):
        self._source = (
            source if source is not None
            else CGEventSourceCreate(kCGEventSourceStateHIDSystemState)
        )
        self.step_delay_ms = max(0.0, min(float(step_delay_ms), 12.0))

    def post_key(self, code: str, is_down: bool, modifier_mask: int) -> None:
        mac_code = MAC_KEY_CODE_BY_DOM_CODE.get(code)
        if mac_code is None:
            raise UnsupportedPhysicalCode(code)
        event = CGEventCreateKeyboardEvent(self._source, mac_code, is_down)
        if modifier_mask:
            CGEventSetFlags(event, modifier_mask)
        CGEventPost(kCGHIDEventTap, event)

    def post_text(self, text: str) -> None:
        for chunk in _unicode_chunks(text):
            event = CGEventCreateKeyboardEvent(self._source, 0, True)
            CGEventKeyboardSetUnicodeString(
                event,
                len(chunk.encode("utf-16-le", errors="surrogatepass")) // 2,
                chunk,
            )
            CGEventPost(kCGHIDEventTap, event)

    def get_caps_lock(self) -> bool:
        flags = CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState)
        return bool(flags & kCGEventFlagMaskAlphaShift)

    def set_caps_lock(self, desired) -> None:
        if desired is None or bool(desired) == self.get_caps_lock():
            return
        self.post_key("CapsLock", True, 0)
        self.post_key("CapsLock", False, 0)
