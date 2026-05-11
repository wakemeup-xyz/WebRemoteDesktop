#!/usr/bin/env python3
"""macOS Input Controller using Quartz"""
import asyncio
import ctypes
import logging
import subprocess
import time
from Quartz import (
    CGEventCreateMouseEvent, CGEventPost, CGEventCreateKeyboardEvent,
    CGEventSetFlags, kCGHIDEventTap, kCGMouseButtonLeft,
    kCGMouseButtonRight, kCGMouseButtonCenter,
    kCGEventMouseMoved, kCGEventLeftMouseDown, kCGEventLeftMouseUp,
    kCGEventRightMouseDown, kCGEventRightMouseUp,
    kCGEventOtherMouseDown, kCGEventOtherMouseUp,
    kCGEventScrollWheel,
    CGEventSourceCreate, kCGEventSourceStateHIDSystemState,
    kCGEventFlagMaskCommand, kCGEventFlagMaskShift,
    kCGEventFlagMaskAlternate, kCGEventFlagMaskControl,
    CGEventCreateScrollWheelEvent, kCGScrollEventUnitLine
)
import screeninfo

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class InputHandler:
    """Handles mouse and keyboard input from remote viewer using macOS native APIs"""

    def __init__(self):
        self._running = False
        self.monitor = None
        self.source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState)
        self._input_lock = asyncio.Lock()
        self._modifier_flags = 0
        self._pressed_modifier_key_codes = set()
        self._pressed_key_codes = set()
        self._last_modifier_event_time = 0.0
        self._last_key_event_time = 0.0
        self._modifier_stale_seconds = 3.0
        self._key_stale_seconds = 3.0

    def start(self):
        """Start the input handler"""
        self._running = True
        # Disable macOS Press-and-Hold accent picker and switch to ABC keyboard
        self._setup_macos_input()
        # Get primary monitor
        try:
            monitors = screeninfo.get_monitors()
            self.monitor = monitors[0] if monitors else None
            if self.monitor:
                logger.info(f"Input handler started, monitor: {self.monitor}")
            else:
                logger.warning("No monitor found")
        except Exception as e:
            logger.error(f"Failed to get monitor info: {e}")
            self.monitor = None

    def _setup_macos_input(self):
        """Disable Press-and-Hold and switch to ABC keyboard to prevent IME interference."""
        # 1. Disable Press-and-Hold (accent character picker)
        try:
            subprocess.run(
                ['defaults', 'write', '-g', 'ApplePressAndHoldEnabled', '-bool', 'false'],
                check=True, capture_output=True
            )
            logger.info("Disabled macOS Press-and-Hold (ApplePressAndHoldEnabled=false)")
        except Exception as e:
            logger.warning(f"Failed to disable Press-and-Hold: {e}")

        # 2. Switch input source to ABC (English) keyboard to bypass Chinese IME
        try:
            self._switch_to_abc_keyboard()
        except Exception as e:
            logger.warning(f"Failed to switch input source: {e}")

    def _switch_to_abc_keyboard(self):
        """Switch macOS input source to ABC English keyboard using Carbon TIS API."""
        carbon = ctypes.cdll.LoadLibrary(
            '/System/Library/Frameworks/Carbon.framework/Carbon'
        )
        cf = ctypes.cdll.LoadLibrary(
            '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'
        )

        kCFStringEncodingUTF8 = 0x08000100

        CFStringCreateWithCString = cf.CFStringCreateWithCString
        CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
        CFStringCreateWithCString.restype = ctypes.c_void_p

        CFStringGetCString = cf.CFStringGetCString
        CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
        CFStringGetCString.restype = ctypes.c_bool

        TISCreateInputSourceList = carbon.TISCreateInputSourceList
        TISCreateInputSourceList.argtypes = [ctypes.c_void_p, ctypes.c_bool]
        TISCreateInputSourceList.restype = ctypes.c_void_p

        TISGetInputSourceProperty = carbon.TISGetInputSourceProperty
        TISGetInputSourceProperty.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        TISGetInputSourceProperty.restype = ctypes.c_void_p

        TISSelectInputSource = carbon.TISSelectInputSource
        TISSelectInputSource.argtypes = [ctypes.c_void_p]
        TISSelectInputSource.restype = ctypes.c_int32

        CFArrayGetCount = cf.CFArrayGetCount
        CFArrayGetCount.argtypes = [ctypes.c_void_p]
        CFArrayGetCount.restype = ctypes.c_long

        CFArrayGetValueAtIndex = cf.CFArrayGetValueAtIndex
        CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
        CFArrayGetValueAtIndex.restype = ctypes.c_void_p

        id_key = CFStringCreateWithCString(None, b'TISPropertyInputSourceID', kCFStringEncodingUTF8)
        sources = TISCreateInputSourceList(None, False)
        count = CFArrayGetCount(sources)

        for i in range(count):
            src = CFArrayGetValueAtIndex(sources, i)
            prop = TISGetInputSourceProperty(src, id_key)
            if not prop:
                continue
            buf = ctypes.create_string_buffer(256)
            if CFStringGetCString(prop, buf, 256, kCFStringEncodingUTF8):
                src_id = buf.value.decode()
                if src_id == 'com.apple.keylayout.ABC':
                    result = TISSelectInputSource(src)
                    logger.info(f"Switched input source to ABC (result={result})")
                    return

        logger.warning("ABC keyboard layout not found, keeping current input source")

    def stop(self):
        """Stop the input handler"""
        self._running = False
        logger.info("Input handler stopped")

    async def handle_input(self, data):
        """Handle incoming input commands"""
        if not self._running:
            return

        try:
            input_type = data.get('type')
            action = data.get('action')
            payload = data.get('payload', {})

            if input_type == 'keyboard' or action != 'move':
                logger.info(f"Input: {input_type} {action}")
            else:
                logger.debug(f"Input: {input_type} {action}")

            async with self._input_lock:
                if input_type == 'mouse':
                    self._release_stale_keys()
                if input_type == 'mouse':
                    await asyncio.to_thread(self._handle_mouse, action, payload)
                elif input_type == 'keyboard':
                    if action == 'reset':
                        self.release_all_keys(reason=payload.get("reason", "remote-reset"))
                        return
                    # Keyboard events must be processed serially with small delays
                    # so macOS Quartz can correctly recognize combo keys.
                    self._handle_keyboard(action, payload)
                    await asyncio.sleep(0.02)

        except Exception as e:
            logger.error(f"Error handling input: {e}")

    def _handle_mouse(self, action, payload):
        """Handle mouse events using Quartz"""
        if not self.monitor:
            return

        # Get screen coordinates (macOS uses top-left as origin)
        rel_x = payload.get('relX', 0)
        rel_y = payload.get('relY', 0)

        # Calculate absolute position
        # NOTE: macOS Quartz uses top-left origin (same as web), so NO inversion needed.
        x = self.monitor.x + rel_x * self.monitor.width
        y = self.monitor.y + rel_y * self.monitor.height

        if action != 'move':
            logger.info(
                f"Mouse {action}: screen=({x:.0f}, {y:.0f}) "
                f"rel=({rel_x:.4f}, {rel_y:.4f}) "
                f"monitor=({self.monitor.x},{self.monitor.y},{self.monitor.width},{self.monitor.height})"
            )

        button = payload.get('button', 'left')
        button_type = self._get_mouse_button(button)

        if action == 'move':
            event = CGEventCreateMouseEvent(
                self.source, kCGEventMouseMoved, (x, y), button_type
            )
            CGEventPost(kCGHIDEventTap, event)

        elif action == 'down':
            event_type = {
                'left': kCGEventLeftMouseDown,
                'right': kCGEventRightMouseDown,
                'middle': kCGEventOtherMouseDown
            }.get(button, kCGEventLeftMouseDown)
            event = CGEventCreateMouseEvent(
                self.source, event_type, (x, y), button_type
            )
            CGEventPost(kCGHIDEventTap, event)

        elif action == 'up':
            event_type = {
                'left': kCGEventLeftMouseUp,
                'right': kCGEventRightMouseUp,
                'middle': kCGEventOtherMouseUp
            }.get(button, kCGEventLeftMouseUp)
            event = CGEventCreateMouseEvent(
                self.source, event_type, (x, y), button_type
            )
            CGEventPost(kCGHIDEventTap, event)

        elif action == 'click':
            # click is now a no-op: viewer sends mousedown + mouseup which
            # already constitute a complete click.  Processing click again
            # would double-fire, cancelling toggles / checkboxes.
            pass

        elif action == 'dblclick':
            # Two clicks
            for _ in range(2):
                down_event = CGEventCreateMouseEvent(
                    self.source, kCGEventLeftMouseDown, (x, y), kCGMouseButtonLeft
                )
                CGEventPost(kCGHIDEventTap, down_event)
                up_event = CGEventCreateMouseEvent(
                    self.source, kCGEventLeftMouseUp, (x, y), kCGMouseButtonLeft
                )
                CGEventPost(kCGHIDEventTap, up_event)

        elif action == 'wheel':
            delta_x = payload.get('deltaX', 0)
            delta_y = payload.get('deltaY', 0)
            scroll_x, scroll_y = self._normalize_scroll_delta(delta_x, delta_y)
            event = CGEventCreateScrollWheelEvent(
                self.source,
                kCGScrollEventUnitLine,
                2,
                scroll_y,
                scroll_x,
            )
            CGEventPost(kCGHIDEventTap, event)

    def _normalize_scroll_delta(self, delta_x, delta_y):
        """Convert browser wheel deltas to compact Quartz line scroll units."""
        def convert(value):
            try:
                value = float(value)
            except (TypeError, ValueError):
                return 0
            if value == 0:
                return 0
            magnitude = max(1, min(12, round(abs(value) / 40)))
            # Browser deltaY > 0 means scroll down. Quartz positive axis1 scrolls up.
            return -magnitude if value > 0 else magnitude

        return convert(delta_x), convert(delta_y)

    def _get_mouse_button(self, button_name):
        """Get Quartz mouse button constant"""
        button_map = {
            'left': kCGMouseButtonLeft,
            'right': kCGMouseButtonRight,
            'middle': kCGMouseButtonCenter
        }
        return button_map.get(button_name, kCGMouseButtonLeft)

    def _handle_keyboard(self, action, payload):
        """Handle keyboard events using Quartz"""
        key_code = payload.get('keyCode', 0)
        key_char = payload.get('key', '')
        code = payload.get('code', '')

        # Map common keys to macOS key codes
        key_map = {
            'Enter': 36, 'Return': 36,
            'Escape': 53,
            'Backspace': 51,
            'Tab': 48,
            'Space': 49, ' ': 49,
            'ArrowUp': 126, 'Up': 126,
            'ArrowDown': 125, 'Down': 125,
            'ArrowLeft': 123, 'Left': 123,
            'ArrowRight': 124, 'Right': 124,
            'Control': 59,
            'Alt': 58, 'Option': 58,
            'Shift': 56,
            'Meta': 55, 'Command': 55, 'OS': 55,
            'CapsLock': 57,
            'Delete': 117,
            'Home': 115,
            'End': 119,
            'PageUp': 116,
            'PageDown': 121,
            'Insert': 114,
            'PrintScreen': 92,
            'ScrollLock': 107,
            'Pause': 113,
            'NumLock': 71,
            'Clear': 71,
            'F1': 122, 'F2': 120, 'F3': 99, 'F4': 118,
            'F5': 96, 'F6': 97, 'F7': 98, 'F8': 100,
            'F9': 101, 'F10': 109, 'F11': 103, 'F12': 111,
        }

        # Single-char fallback (lowercase + uppercase + shifted symbols)
        char_to_code = {
            'a': 0, 'b': 11, 'c': 8, 'd': 2, 'e': 14, 'f': 3, 'g': 5,
            'h': 4, 'i': 34, 'j': 38, 'k': 40, 'l': 37, 'm': 46,
            'n': 45, 'o': 31, 'p': 35, 'q': 12, 'r': 15, 's': 1,
            't': 17, 'u': 32, 'v': 9, 'w': 13, 'x': 7, 'y': 16, 'z': 6,
            'A': 0, 'B': 11, 'C': 8, 'D': 2, 'E': 14, 'F': 3, 'G': 5,
            'H': 4, 'I': 34, 'J': 38, 'K': 40, 'L': 37, 'M': 46,
            'N': 45, 'O': 31, 'P': 35, 'Q': 12, 'R': 15, 'S': 1,
            'T': 17, 'U': 32, 'V': 9, 'W': 13, 'X': 7, 'Y': 16, 'Z': 6,
            '0': 29, '1': 18, '2': 19, '3': 20, '4': 21, '5': 23,
            '6': 22, '7': 26, '8': 28, '9': 25,
            '.': 47, ',': 43, ';': 41, "'": 39, '/': 44, '\\': 42,
            '[': 33, ']': 30, '`': 50, '-': 27, '=': 24,
            '!': 18, '@': 19, '#': 20, '$': 21, '%': 23,
            '^': 22, '&': 26, '*': 28, '(': 25, ')': 29,
            '_': 27, '+': 24, '{': 33, '}': 30, '|': 42,
            ':': 41, '"': 39, '<': 43, '>': 47, '?': 44,
            '~': 50,
        }

        modifier_key_flags = {
            55: kCGEventFlagMaskCommand,
            56: kCGEventFlagMaskShift,
            58: kCGEventFlagMaskAlternate,
            59: kCGEventFlagMaskControl,
            60: kCGEventFlagMaskShift,
            61: kCGEventFlagMaskAlternate,
            62: kCGEventFlagMaskControl,
        }

        # Handle modifiers from payload. Prefer explicit browser state for
        # non-modifier keys, but also keep a host-side modifier state so
        # Windows keyboard remaps and Shift/Command chords remain stable.
        modifiers = payload.get('modifiers', {})
        flags = 0
        if modifiers.get('meta'):  # Command
            flags |= kCGEventFlagMaskCommand
        if modifiers.get('shift'):
            flags |= kCGEventFlagMaskShift
        if modifiers.get('alt'):  # Option
            flags |= kCGEventFlagMaskAlternate
        if modifiers.get('ctrl'):
            flags |= kCGEventFlagMaskControl

        # Map from Web KeyboardEvent.code (physical key) to macOS keyCode.
        # This is more reliable than keyCode or key values because 'code'
        # represents the physical key location (USB HID Usage) which is
        # consistent across platforms.
        code_map = {
            # Letters
            'KeyA': 0, 'KeyB': 11, 'KeyC': 8, 'KeyD': 2, 'KeyE': 14,
            'KeyF': 3, 'KeyG': 5, 'KeyH': 4, 'KeyI': 34, 'KeyJ': 38,
            'KeyK': 40, 'KeyL': 37, 'KeyM': 46, 'KeyN': 45, 'KeyO': 31,
            'KeyP': 35, 'KeyQ': 12, 'KeyR': 15, 'KeyS': 1, 'KeyT': 17,
            'KeyU': 32, 'KeyV': 9, 'KeyW': 13, 'KeyX': 7, 'KeyY': 16,
            'KeyZ': 6,
            # Digits
            'Digit0': 29, 'Digit1': 18, 'Digit2': 19, 'Digit3': 20,
            'Digit4': 21, 'Digit5': 23, 'Digit6': 22, 'Digit7': 26,
            'Digit8': 28, 'Digit9': 25,
            # Function keys
            'F1': 122, 'F2': 120, 'F3': 99, 'F4': 118, 'F5': 96,
            'F6': 97, 'F7': 98, 'F8': 100, 'F9': 101, 'F10': 109,
            'F11': 103, 'F12': 111,
            # Control / navigation
            'Enter': 36, 'NumpadEnter': 36,
            'Escape': 53,
            'Backspace': 51,
            'Tab': 48,
            'Space': 49,
            'ArrowUp': 126, 'ArrowDown': 125,
            'ArrowLeft': 123, 'ArrowRight': 124,
            'ControlLeft': 59, 'ControlRight': 62,
            'AltLeft': 58, 'AltRight': 61,
            'ShiftLeft': 56, 'ShiftRight': 60,
            'MetaLeft': 55, 'MetaRight': 55,
            'CapsLock': 57,
            'Delete': 117,
            'Home': 115, 'End': 119,
            'PageUp': 116, 'PageDown': 121,
            'Insert': 114,
            # Punctuation / symbols
            'Period': 47, 'Comma': 43, 'Semicolon': 41,
            'Quote': 39, 'Slash': 44, 'Backslash': 42,
            'BracketLeft': 33, 'BracketRight': 30,
            'Backquote': 50, 'Minus': 27, 'Equal': 24,
            'IntlBackslash': 42,
            # Numpad
            'Numpad0': 82, 'Numpad1': 83, 'Numpad2': 84, 'Numpad3': 85,
            'Numpad4': 86, 'Numpad5': 87, 'Numpad6': 88, 'Numpad7': 89,
            'Numpad8': 91, 'Numpad9': 92,
            'NumpadMultiply': 67, 'NumpadAdd': 69,
            'NumpadSubtract': 78, 'NumpadDecimal': 65,
            'NumpadDivide': 75, 'NumpadEqual': 81,
        }

        # Determine key code: prefer 'code' (physical key), then 'key' name,
        # then single-char fallback.
        mapped = False
        if code in code_map:
            key_code = code_map[code]
            mapped = True
        elif key_char in key_map:
            key_code = key_map[key_char]
            mapped = True
        elif len(key_char) == 1 and key_char in char_to_code:
            key_code = char_to_code[key_char]
            mapped = True

        if not mapped:
            logger.warning(f"Unhandled key: key='{key_char}', code='{code}', keyCode={payload.get('keyCode')}")
            return

        # Detect modifier keys: do not attach modifier flags to the modifier key itself
        is_modifier = key_code in (55, 56, 58, 59, 60, 61, 62, 57)
        modifier_flag = modifier_key_flags.get(key_code, 0)

        logger.info(f"Keyboard {action}: key='{key_char}', code='{code}', mac_code={key_code}, flags=0x{flags:08x}, is_modifier={is_modifier}")

        if action == 'keydown' and not is_modifier and self._modifier_flags and flags == 0:
            self.release_all_modifiers(reason="plain-key-reset")

        # Create and post event
        if action == 'keydown':
            if modifier_flag:
                self._modifier_flags |= modifier_flag
                self._pressed_modifier_key_codes.add(key_code)
                self._last_modifier_event_time = time.monotonic()
                flags = self._modifier_flags
            elif flags:
                self._modifier_flags |= flags
            elif self._modifier_flags:
                flags = self._modifier_flags
            self._pressed_key_codes.add(key_code)
            self._last_key_event_time = time.monotonic()

            event = CGEventCreateKeyboardEvent(self.source, key_code, True)
            if flags and key_code != 57:
                CGEventSetFlags(event, flags)
                logger.info(f"  -> CGEventSetFlags(0x{flags:08x}) on keydown")
            CGEventPost(kCGHIDEventTap, event)
            logger.info(f"  -> CGEventPost keydown mac_code={key_code}")
        elif action == 'keyup':
            if modifier_flag:
                self._modifier_flags &= ~modifier_flag
                self._pressed_modifier_key_codes.discard(key_code)
                self._last_modifier_event_time = time.monotonic()
                flags = self._modifier_flags
            elif flags:
                self._modifier_flags |= flags
            elif self._modifier_flags:
                flags = self._modifier_flags
            self._pressed_key_codes.discard(key_code)
            self._last_key_event_time = time.monotonic()

            event = CGEventCreateKeyboardEvent(self.source, key_code, False)
            if flags and key_code != 57:
                CGEventSetFlags(event, flags)
                logger.info(f"  -> CGEventSetFlags(0x{flags:08x}) on keyup")
            CGEventPost(kCGHIDEventTap, event)
            logger.info(f"  -> CGEventPost keyup mac_code={key_code}")

    def _release_stale_keys(self):
        if not self._last_key_event_time:
            return
        age = time.monotonic() - self._last_key_event_time
        if age >= self._key_stale_seconds:
            self.release_all_keys(reason=f"stale-{age:.1f}s")

    def release_all_modifiers(self, reason="manual"):
        """Release host-side modifier state when a browser keyup is lost."""
        if not self._modifier_flags and not self._pressed_modifier_key_codes:
            return

        modifier_order = [
            (55, kCGEventFlagMaskCommand),
            (56, kCGEventFlagMaskShift),
            (60, kCGEventFlagMaskShift),
            (58, kCGEventFlagMaskAlternate),
            (61, kCGEventFlagMaskAlternate),
            (59, kCGEventFlagMaskControl),
            (62, kCGEventFlagMaskControl),
        ]

        pressed = set(self._pressed_modifier_key_codes)
        if self._modifier_flags & kCGEventFlagMaskCommand:
            pressed.add(55)
        if self._modifier_flags & kCGEventFlagMaskShift:
            pressed.add(56)
        if self._modifier_flags & kCGEventFlagMaskAlternate:
            pressed.add(58)
        if self._modifier_flags & kCGEventFlagMaskControl:
            pressed.add(59)

        logger.warning("Releasing stuck modifiers reason=%s flags=0x%08x keys=%s", reason, self._modifier_flags, sorted(pressed))
        self._modifier_flags = 0
        self._pressed_modifier_key_codes.clear()
        self._pressed_key_codes.difference_update(pressed)
        self._last_modifier_event_time = 0.0

        for key_code, _flag in modifier_order:
            if key_code not in pressed:
                continue
            event = CGEventCreateKeyboardEvent(self.source, key_code, False)
            CGEventSetFlags(event, self._modifier_flags)
            CGEventPost(kCGHIDEventTap, event)
            logger.info("  -> Released modifier keyup mac_code=%s", key_code)

    def release_all_keys(self, reason="manual"):
        """Release every host-side pressed key to recover from dropped keyup events."""
        if not self._pressed_key_codes and not self._modifier_flags and not self._pressed_modifier_key_codes:
            return

        pressed = set(self._pressed_key_codes)
        modifier_keys = set(self._pressed_modifier_key_codes)
        logger.warning("Releasing stuck keys reason=%s keys=%s flags=0x%08x", reason, sorted(pressed), self._modifier_flags)

        non_modifiers = sorted(pressed - modifier_keys)
        for key_code in non_modifiers:
            event = CGEventCreateKeyboardEvent(self.source, key_code, False)
            CGEventSetFlags(event, 0)
            CGEventPost(kCGHIDEventTap, event)
            logger.info("  -> Released keyup mac_code=%s", key_code)

        self.release_all_modifiers(reason=reason)
        self._pressed_key_codes.clear()
        self._last_key_event_time = 0.0


if __name__ == "__main__":
    handler = InputHandler()
    handler.start()

    async def test():
        # Test mouse movement
        print("Testing mouse movement...")
        await handler.handle_input({
            'type': 'mouse',
            'action': 'move',
            'payload': {'relX': 0.5, 'relY': 0.5}
        })
        await asyncio.sleep(1)

        # Test keyboard
        print("Testing keyboard...")
        await handler.handle_input({
            'type': 'keyboard',
            'action': 'keydown',
            'payload': {'key': 'a', 'keyCode': 0}
        })
        await asyncio.sleep(0.1)
        await handler.handle_input({
            'type': 'keyboard',
            'action': 'keyup',
            'payload': {'key': 'a', 'keyCode': 0}
        })

    asyncio.run(test())
    handler.stop()
