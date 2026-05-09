#!/usr/bin/env python3
"""macOS Input Controller using Quartz"""
import asyncio
import logging
from Quartz import (
    CGEventCreateMouseEvent, CGEventPost, CGEventCreateKeyboardEvent,
    CGEventSetFlags, kCGHIDEventTap, kCGMouseButtonLeft,
    kCGMouseButtonRight, kCGMouseButtonCenter,
    kCGEventMouseMoved, kCGEventLeftMouseDown, kCGEventLeftMouseUp,
    kCGEventRightMouseDown, kCGEventRightMouseUp,
    kCGEventOtherMouseDown, kCGEventOtherMouseUp,
    kCGEventScrollWheel,
    CGEventSourceCreate, kCGEventSourceStateHIDSystemState
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

    def start(self):
        """Start the input handler"""
        self._running = True
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

            logger.info(f"Input: {input_type} {action}")

            if input_type == 'mouse':
                await asyncio.to_thread(self._handle_mouse, action, payload)
            elif input_type == 'keyboard':
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
            # Down
            down_type = {
                'left': kCGEventLeftMouseDown,
                'right': kCGEventRightMouseDown,
                'middle': kCGEventOtherMouseDown
            }.get(button, kCGEventLeftMouseDown)
            down_event = CGEventCreateMouseEvent(
                self.source, down_type, (x, y), button_type
            )
            CGEventPost(kCGHIDEventTap, down_event)
            # Up
            up_type = {
                'left': kCGEventLeftMouseUp,
                'right': kCGEventRightMouseUp,
                'middle': kCGEventOtherMouseUp
            }.get(button, kCGEventLeftMouseUp)
            up_event = CGEventCreateMouseEvent(
                self.source, up_type, (x, y), button_type
            )
            CGEventPost(kCGHIDEventTap, up_event)

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
            event = CGEventCreateMouseEvent(
                self.source, kCGEventScrollWheel, (x, y), 0
            )
            # Set scroll wheel deltas
            from Quartz import CGEventSetIntegerValueField, kCGScrollWheelEventDeltaAxis1, kCGScrollWheelEventDeltaAxis2
            CGEventSetIntegerValueField(event, kCGScrollWheelEventDeltaAxis1, int(delta_y))
            CGEventSetIntegerValueField(event, kCGScrollWheelEventDeltaAxis2, int(delta_x))
            CGEventPost(kCGHIDEventTap, event)

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

        # Handle modifiers from payload
        modifiers = payload.get('modifiers', {})
        flags = 0
        from Quartz import kCGEventFlagMaskCommand, kCGEventFlagMaskShift, kCGEventFlagMaskAlternate, kCGEventFlagMaskControl
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
        code = payload.get('code', '')
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
        if code in code_map:
            key_code = code_map[code]
        elif key_char in key_map:
            key_code = key_map[key_char]
        elif len(key_char) == 1:
            char_to_code = {
                'a': 0, 'b': 11, 'c': 8, 'd': 2, 'e': 14, 'f': 3, 'g': 5,
                'h': 4, 'i': 34, 'j': 38, 'k': 40, 'l': 37, 'm': 46,
                'n': 45, 'o': 31, 'p': 35, 'q': 12, 'r': 15, 's': 1,
                't': 17, 'u': 32, 'v': 9, 'w': 13, 'x': 7, 'y': 16, 'z': 6,
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
            key_code = char_to_code.get(key_char, 0)

        if not key_code:
            logger.warning(f"Unhandled key: key='{key_char}', code='{code}', keyCode={payload.get('keyCode')}")
            return

        logger.info(f"Keyboard {action}: key='{key_char}', code='{code}', mac_code={key_code}")

        # Modifier keys (Control, Shift, Alt, Command) should not carry their own
        # flag on keydown, otherwise macOS cannot form proper combos.
        is_modifier = key_code in (55, 56, 58, 59, 60, 61, 62, 57)

        # Create and post event
        if action == 'keydown':
            event = CGEventCreateKeyboardEvent(self.source, key_code, True)
            if flags and not is_modifier:
                CGEventSetFlags(event, flags)
            CGEventPost(kCGHIDEventTap, event)
        elif action == 'keyup':
            event = CGEventCreateKeyboardEvent(self.source, key_code, False)
            if flags:
                CGEventSetFlags(event, flags)
            CGEventPost(kCGHIDEventTap, event)


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
