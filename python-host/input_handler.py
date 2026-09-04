#!/usr/bin/env python3
"""macOS Input Controller using Quartz"""
import asyncio
import logging
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from Quartz import (
    CGEventCreateMouseEvent, CGEventPost, CGEventCreateKeyboardEvent,
    CGEventSetFlags, kCGHIDEventTap, kCGMouseButtonLeft,
    kCGMouseButtonRight, kCGMouseButtonCenter,
    kCGEventMouseMoved, kCGEventLeftMouseDown, kCGEventLeftMouseUp,
    kCGEventRightMouseDown, kCGEventRightMouseUp,
    kCGEventOtherMouseDown, kCGEventOtherMouseUp,
    kCGEventLeftMouseDragged, kCGEventRightMouseDragged,
    kCGEventOtherMouseDragged,
    kCGEventScrollWheel,
    CGEventSourceCreate, kCGEventSourceStateHIDSystemState,
    kCGEventFlagMaskCommand, kCGEventFlagMaskShift,
    kCGEventFlagMaskAlternate, kCGEventFlagMaskControl,
    CGEventCreateScrollWheelEvent, kCGScrollEventUnitLine,
    CGEventCreate, CGEventGetLocation, CGEventSetIntegerValueField,
    kCGMouseEventClickState
)
import screeninfo

from quartz_keyboard_adapter import (
    QuartzKeyboardAdapter,
    UnsupportedPhysicalCode,
    mac_key_code_for_dom_code,
)
from remote_keyboard_state import LegacyInputAdapter, RemoteKeyboardState
from remote_desktop_write_state import ReliableDesktopWriteState

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class InputHandler:
    """Handles mouse and keyboard input from remote viewer using macOS native APIs"""

    def __init__(self, *, keyboard_adapter=None):
        self._running = False
        self.monitor = None
        self.source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState)
        self._input_lock = asyncio.Lock()
        self._input_thread_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="input")
        self._keyboard_lock = asyncio.Lock()
        self._keyboard_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="keyboard")
        self._keyboard_adapter = keyboard_adapter or QuartzKeyboardAdapter(source=self.source)
        self._remote_keyboard = RemoteKeyboardState(self._keyboard_adapter)
        self._legacy_keyboard = LegacyInputAdapter(self._remote_keyboard)
        self._desktop_writes = ReliableDesktopWriteState()
        self._keyboard_connection_generation = 0
        self._modifier_flags = 0
        self._pressed_modifier_key_codes = set()
        self._pressed_key_codes = set()
        self._last_modifier_event_time = 0.0
        self._last_key_flags = {}
        self._modifier_stale_seconds = 8.0
        self._lock_waiters = 0
        self._lock_contention_logged = False
        self._pressed_mouse_button = None  # legacy single-button mirror (primary)
        self._pressed_mouse_buttons = set()  # all currently pressed buttons
        self._last_mouse_position = None

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

    def _switch_input_method(self):
        """Invoke the user's configured macOS input-source shortcut."""
        steps = (
            (59, True, 0),
            (49, True, kCGEventFlagMaskControl),
            (49, False, kCGEventFlagMaskControl),
            (59, False, 0),
        )
        for key_code, is_down, flags in steps:
            event = CGEventCreateKeyboardEvent(self.source, key_code, is_down)
            CGEventSetFlags(event, flags)
            CGEventPost(kCGHIDEventTap, event)
        logger.info("Requested input method switch with Control+Space")
        return True

    def stop(self):
        """Stop the input handler"""
        self._running = False
        self.release_all_mouse_buttons(reason="handler-stop")
        self.release_all_keys(reason="handler-stop")
        logger.info("Input handler stopped")

    async def transition_keyboard(self, *, connection_generation, lease_id, lease_epoch):
        """Install Signal-owned keyboard authority before accepting v2 input."""
        async with self._keyboard_lock:
            loop = asyncio.get_running_loop()

            def bind():
                self._legacy_keyboard = LegacyInputAdapter(self._remote_keyboard)
                return self._legacy_keyboard.bind(
                    connection_generation=connection_generation,
                    lease_id=lease_id,
                    lease_epoch=lease_epoch,
                )

            result = await loop.run_in_executor(
                self._keyboard_executor,
                bind,
            )
            if result.status == "applied":
                self._keyboard_connection_generation = connection_generation
            return self._keyboard_result(result)

    async def apply_keyboard(self, envelope, *, transport=None):
        """Apply v2 or lease-bound legacy keyboard input on the ordered worker."""
        async with self._keyboard_lock:
            loop = asyncio.get_running_loop()

            def apply():
                if envelope.get("schemaVersion") == 2:
                    protocol_envelope = {
                        field: envelope[field]
                        for field in (
                            "schemaVersion", "type", "action", "leaseId",
                            "leaseEpoch", "seq", "inputIds", "payload",
                        )
                        if field in envelope
                    }
                    return self._remote_keyboard.apply(protocol_envelope)
                return self._legacy_keyboard.apply(
                    envelope,
                    transport=str(transport or envelope.get("transport") or "socket"),
                )

            result = await loop.run_in_executor(
                self._keyboard_executor, apply
            )
            return self._keyboard_result(result, input_ids=envelope.get("inputIds", []))

    def transition_desktop_writes(self, *, lease_id, lease_epoch):
        return self._desktop_writes.transition(lease_id=lease_id, lease_epoch=lease_epoch)

    async def transition_desktop_writes_async(self, *, lease_id, lease_epoch):
        """Transition desktop-write authority after in-flight input drains."""
        async with self._input_lock:
            return self._desktop_writes.transition(
                lease_id=lease_id,
                lease_epoch=lease_epoch,
            )

    async def reset_desktop_writes(self, reason="manual"):
        """Release mouse state after in-flight native input has completed."""
        async with self._input_lock:
            self.release_all_mouse_buttons(reason=reason)

    async def reset_keyboard(self, reason="manual", lease_epoch=None):
        """Release keyboard state in the same queue as key execution."""
        async with self._keyboard_lock:
            loop = asyncio.get_running_loop()

            def reset():
                effective_epoch = (
                    self._remote_keyboard.snapshot().lease_epoch
                    if lease_epoch is None else lease_epoch
                )
                return self._remote_keyboard.reset(
                    lease_epoch=effective_epoch,
                    reason=reason,
                )

            result = await loop.run_in_executor(self._keyboard_executor, reset)
            return self._keyboard_result(result)

    def get_keyboard_snapshot(self):
        """Return the last ordered keyboard state for diagnostics and tests."""
        return self._remote_keyboard.snapshot()

    @staticmethod
    def _keyboard_result(result, *, input_ids=None):
        return {
            "inputIds": list(input_ids or []),
            "appliedSeq": result.applied_seq,
            "status": result.status,
            "pressedKeyCount": result.pressed_key_count,
            "modifierMask": result.modifier_mask,
            "receiveTime": time.perf_counter(),
            "executeTime": time.perf_counter(),
        }

    async def handle_input(self, data):
        """Handle incoming input commands"""
        if not self._running:
            return

        i1 = time.perf_counter()
        try:
            input_type = data.get('type')
            action = data.get('action')
            payload = data.get('payload', {})

            if input_type == 'keyboard':
                return await self.apply_keyboard(data, transport=data.get("transport"))

            desktop = None
            desktop_data = None
            if data.get("schemaVersion") == 2 and input_type in {'mouse', 'command'}:
                desktop_data = {
                    field: data[field] for field in (
                        "schemaVersion", "type", "action", "leaseId", "leaseEpoch", "seq", "inputIds", "payload",
                    ) if field in data
                }

            if input_type == 'mouse' and action == 'move' and (
                self._input_lock.locked() or self._lock_waiters > 0
            ):
                return {
                    "inputIds": data.get("inputIds", []),
                    "receiveTime": i1,
                    "executeTime": time.perf_counter(),
                    "dropped": True,
                }

            # Track lock contention
            self._lock_waiters += 1
            waiters_before = self._lock_waiters

            lock_start = time.perf_counter()
            lock_acquired_flag = False
            try:
                await self._input_lock.acquire()
                lock_acquired_flag = True
                lock_acquired = time.perf_counter()
                lock_wait_ms = (lock_acquired - lock_start) * 1000
            finally:
                self._lock_waiters = max(0, self._lock_waiters - 1)

            try:
                # Log lock contention: if > 3 waiters or wait > 10ms
                if waiters_before > 3 or lock_wait_ms > 10:
                    if not self._lock_contention_logged or lock_wait_ms > 50:
                        logger.warning(
                            "Input lock contention: waiters_before=%d lock_wait=%.1fms type=%s action=%s",
                            waiters_before, lock_wait_ms, input_type, action
                        )
                        self._lock_contention_logged = True
                elif lock_wait_ms < 10:
                    self._lock_contention_logged = False

                # Validate reliable writes while the execution lock is held,
                # then commit their sequence only after native execution has
                # returned successfully. This keeps concurrent writes ordered
                # without reserving a sequence for a failed operation.
                if desktop_data is not None:
                    desktop = self._desktop_writes.validate(desktop_data)
                    if desktop.status not in {"applied", "unordered"}:
                        return {
                            "inputIds": data.get("inputIds", []), "status": desktop.status,
                            "appliedSeq": desktop.applied_seq, "receiveTime": i1, "executeTime": time.perf_counter(),
                        }

                to_thread_start = time.perf_counter()
                loop = asyncio.get_running_loop()
                execution_result = None
                try:
                    if input_type == 'mouse':
                        execution_result = await loop.run_in_executor(
                            self._input_thread_pool, self._handle_mouse, action, payload
                        )
                    elif input_type == 'command':
                        execution_result = await loop.run_in_executor(
                            self._input_thread_pool, self._handle_command, action, payload
                        )
                except Exception:
                    logger.error(
                        "Error executing input: type=%s action=%s",
                        input_type,
                        action,
                        exc_info=True,
                    )
                    execution_result = False
                to_thread_ms = (time.perf_counter() - to_thread_start) * 1000

                if execution_result is False:
                    i2 = time.perf_counter()
                    result = {
                        "inputIds": data.get("inputIds", []),
                        "status": "execution-failed",
                        "receiveTime": i1,
                        "executeTime": i2,
                    }
                    if desktop is not None:
                        result["appliedSeq"] = self._desktop_writes.snapshot().last_applied_seq
                    return result

                if desktop is not None and desktop.status == "applied":
                    desktop = self._desktop_writes.commit(
                        data["seq"],
                        lease_id=data.get("leaseId"),
                        lease_epoch=data.get("leaseEpoch"),
                    )
            finally:
                if lock_acquired_flag:
                    self._input_lock.release()

            i2 = time.perf_counter()
            total_ms = (i2 - i1) * 1000

            # Log timing for non-move events or if total > 50ms
            if action != 'move' or total_ms > 50:
                logger.info(
                    "Input timing: type=%s action=%s total=%.1fms lock_wait=%.1fms to_thread=%.1fms",
                    input_type, action, total_ms, lock_wait_ms, to_thread_ms
                )

            result = {
                "inputIds": data.get("inputIds", []),
                "receiveTime": i1,
                "executeTime": i2,
            }
            if desktop is not None:
                result.update(status=desktop.status, appliedSeq=desktop.applied_seq)
            return result

        except Exception as e:
            logger.error("Error handling input: %s", type(e).__name__, exc_info=True)

    def _handle_command(self, action, payload):
        """Handle special command actions."""
        if action == 'showDock':
            return self._show_dock()
        elif action == 'switchInputMethod':
            return self._switch_input_method()
        return False

    def _show_dock(self):
        """Open Launchpad (启动台). The toolbar label is 显示程序坞; operators
        expect the app grid, not a silent cursor nudge toward the Dock edge.
        """
        try:
            result = subprocess.run(
                ["open", "-a", "Launchpad"],
                capture_output=True,
                text=True,
                timeout=2.0,
                check=False,
            )
            if result.returncode != 0:
                logger.warning(
                    "Show dock: open Launchpad failed rc=%s stderr=%s",
                    result.returncode,
                    (result.stderr or "").strip(),
                )
                return False
            logger.info("Show dock: opened Launchpad")
            return True
        except Exception as e:
            logger.error("Show dock failed: %s", e, exc_info=True)
            return False

    def _handle_mouse(self, action, payload):
        """Handle mouse events using Quartz"""
        if not self.monitor:
            if action == 'reset':
                self.release_all_mouse_buttons(reason=payload.get('reason', 'remote-reset'))
            logger.warning("Ignoring mouse action without a monitor: action=%s", action)
            return False
        if action == 'reset':
            self.release_all_mouse_buttons(reason=payload.get('reason', 'remote-reset'))
            return True

        # Get screen coordinates (macOS uses top-left as origin)
        rel_x = payload.get('relX', 0)
        rel_y = payload.get('relY', 0)

        # Calculate absolute position
        # NOTE: macOS Quartz uses top-left origin (same as web), so NO inversion needed.
        x = self.monitor.x + rel_x * self.monitor.width
        y = self.monitor.y + rel_y * self.monitor.height
        self._last_mouse_position = (x, y)

        if action != 'move':
            logger.info("mouse_input action=%s", action)

        button = payload.get('button', 'left')
        button_type = self._get_mouse_button(button)
        try:
            click_count = max(1, min(int(payload.get('clickCount', 1)), 3))
        except (TypeError, ValueError):
            click_count = 1

        if action == 'move':
            # Viewer may report the live button mask. buttons===0 while we still
            # track a pressed button means the matching up was lost (DC drop /
            # gate flip) — clear before synthesizing the move or every subsequent
            # move becomes a drag with no user click held.
            if "buttons" in payload:
                try:
                    buttons = int(payload.get("buttons") or 0)
                except (TypeError, ValueError):
                    buttons = 0
                if buttons == 0 and self._pressed_mouse_buttons:
                    self.release_all_mouse_buttons(reason="move-buttons-clear")
            # Use dragged event type when a button is held (critical for drag to work)
            drag_map = {
                'left': kCGEventLeftMouseDragged,
                'right': kCGEventRightMouseDragged,
                'middle': kCGEventOtherMouseDragged,
            }
            # Prefer left, then right, then middle for the drag event type.
            primary = None
            for name in ('left', 'right', 'middle'):
                if name in self._pressed_mouse_buttons:
                    primary = name
                    break
            if primary is None:
                primary = self._pressed_mouse_button
            if primary and primary in drag_map:
                move_type = drag_map[primary]
            else:
                move_type = kCGEventMouseMoved
            event = CGEventCreateMouseEvent(
                self.source, move_type, (x, y), button_type
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
            if click_count > 1:
                CGEventSetIntegerValueField(event, kCGMouseEventClickState, click_count)
            CGEventPost(kCGHIDEventTap, event)
            self._pressed_mouse_buttons.add(button)
            self._pressed_mouse_button = button

        elif action == 'up':
            event_type = {
                'left': kCGEventLeftMouseUp,
                'right': kCGEventRightMouseUp,
                'middle': kCGEventOtherMouseUp
            }.get(button, kCGEventLeftMouseUp)
            event = CGEventCreateMouseEvent(
                self.source, event_type, (x, y), button_type
            )
            if click_count > 1:
                CGEventSetIntegerValueField(event, kCGMouseEventClickState, click_count)
            try:
                CGEventPost(kCGHIDEventTap, event)
            finally:
                self._pressed_mouse_buttons.discard(button)
                if self._pressed_mouse_button == button:
                    self._pressed_mouse_button = next(
                        (name for name in ('left', 'right', 'middle')
                         if name in self._pressed_mouse_buttons),
                        None,
                    )

        elif action == 'click':
            # click is now a no-op: viewer sends mousedown + mouseup which
            # already constitute a complete click.  Processing click again
            # would double-fire, cancelling toggles / checkboxes.
            pass

        elif action == 'dblclick':
            # Simulate a proper double-click at the target position.
            # The viewer already sent individual mousedown/mouseup events;
            # this ensures a clean double-click rhythm regardless of network jitter.
            down1 = CGEventCreateMouseEvent(
                self.source, kCGEventLeftMouseDown, (x, y), kCGMouseButtonLeft
            )
            CGEventPost(kCGHIDEventTap, down1)
            up1 = CGEventCreateMouseEvent(
                self.source, kCGEventLeftMouseUp, (x, y), kCGMouseButtonLeft
            )
            CGEventPost(kCGHIDEventTap, up1)
            # macOS double-click interval is ~0.3s; 0.08s gap reliably triggers it
            time.sleep(0.08)
            down2 = CGEventCreateMouseEvent(
                self.source, kCGEventLeftMouseDown, (x, y), kCGMouseButtonLeft
            )
            CGEventPost(kCGHIDEventTap, down2)
            up2 = CGEventCreateMouseEvent(
                self.source, kCGEventLeftMouseUp, (x, y), kCGMouseButtonLeft
            )
            CGEventPost(kCGHIDEventTap, up2)

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

        return True

    def release_all_mouse_buttons(self, reason="remote-reset"):
        buttons = set(self._pressed_mouse_buttons)
        if self._pressed_mouse_button:
            buttons.add(self._pressed_mouse_button)
        if not buttons:
            return
        logger.warning(
            "Releasing stuck mouse button reason=%s buttons=%s",
            reason,
            ",".join(sorted(buttons)),
        )
        try:
            if not self.monitor:
                return
            position = self._last_mouse_position or (self.monitor.x, self.monitor.y)
            for button in ('left', 'right', 'middle'):
                if button not in buttons:
                    continue
                event_type = {
                    'left': kCGEventLeftMouseUp,
                    'right': kCGEventRightMouseUp,
                    'middle': kCGEventOtherMouseUp,
                }.get(button, kCGEventLeftMouseUp)
                event = CGEventCreateMouseEvent(
                    self.source, event_type, position, self._get_mouse_button(button)
                )
                CGEventPost(kCGHIDEventTap, event)
        finally:
            self._pressed_mouse_buttons.clear()
            self._pressed_mouse_button = None

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
            'PrintScreen': 105,
            'ScrollLock': 107,
            'Pause': 113,
            'NumLock': 71,
            'Clear': 71,
            'ContextMenu': 119,
            'F1': 122, 'F2': 120, 'F3': 99, 'F4': 118,
            'F5': 96, 'F6': 97, 'F7': 98, 'F8': 100,
            'F9': 101, 'F10': 109, 'F11': 103, 'F12': 111,
            'F13': 105, 'F14': 107, 'F15': 113, 'F16': 106,
            'F17': 64, 'F18': 79, 'F19': 80, 'F20': 90,
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
            '~': 50, ' ': 49,
        }

        modifier_key_flags = {
            54: kCGEventFlagMaskCommand,  # Right Command
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
        payload_flags = flags

        # Determine key code: prefer 'code' (physical key), then 'key' name,
        # then single-char fallback.
        mapped = False
        if code:
            try:
                physical_key_code = mac_key_code_for_dom_code(code)
            except UnsupportedPhysicalCode:
                logger.warning("keyboard_unsupported_physical_code action=%s", action)
                return "unsupported-code"
            if physical_key_code is not None:
                key_code = physical_key_code
                mapped = True
        if not mapped and key_char in key_map:
            key_code = key_map[key_char]
            mapped = True
        elif not mapped and len(key_char) == 1 and key_char in char_to_code:
            key_code = char_to_code[key_char]
            mapped = True

        if not mapped:
            logger.warning("keyboard_unhandled action=%s", action)
            return

        # Detect modifier keys: do not attach modifier flags to the modifier key itself
        is_modifier = key_code in (54, 55, 56, 58, 59, 60, 61, 62, 57)
        modifier_flag = modifier_key_flags.get(key_code, 0)

        logger.info(
            "keyboard_input action=%s mac_code=%s flags=0x%08x is_modifier=%s",
            action,
            key_code,
            flags,
            is_modifier,
        )
        logger.info(
            "[KEYMAP] action=%s payload_flags=0x%08x host_flags=0x%08x mac_code=%s is_modifier=%s pressed_mods=%s",
            action,
            payload_flags,
            self._modifier_flags,
            key_code,
            is_modifier,
            sorted(self._pressed_modifier_key_codes),
        )

        # Navigation keys that control IME (arrow keys, ESC) must always
        # be sent clean — no stuck modifiers attached.  Otherwise macOS
        # interprets e.g. Cmd+Arrow instead of Arrow and dismisses the
        # Pinyin candidate window instead of navigating it.
        _ime_nav_keys = {123, 124, 125, 126, 53}  # Left, Right, Down, Up, Escape

        # Reconcile: browser payload is the authoritative modifier state.
        # Any bit set in _modifier_flags but absent in payload_flags means the
        # keyup was lost (e.g. DataChannel drop). Clear phantom bits immediately
        # so macOS does not misinterpret subsequent keystrokes as Ctrl/Cmd chords.
        if action == 'keydown' and not is_modifier and key_code not in _ime_nav_keys:
            lost_flags = self._modifier_flags & ~payload_flags
            if lost_flags:
                self._release_lost_modifier_flags(lost_flags, reason="reconcile")

        if action == 'keydown' and not is_modifier and self._modifier_flags and flags == 0 and key_code not in _ime_nav_keys:
            self.release_all_modifiers(reason="plain-key-reset")

        # Create and post event
        if action == 'keydown':
            if modifier_flag:
                self._modifier_flags |= modifier_flag
                self._pressed_modifier_key_codes.add(key_code)
                self._last_modifier_event_time = time.monotonic()
                flags = self._modifier_flags
            elif payload_flags:
                self._modifier_flags |= payload_flags
            elif self._modifier_flags and key_code not in _ime_nav_keys:
                flags = self._modifier_flags
            self._pressed_key_codes.add(key_code)
            self._last_key_flags[key_code] = payload_flags

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
            # NOTE: keyup of a non-modifier key must never SET modifier
            # flags.  A lost modifier-keydown would otherwise create a
            # phantom flag that can never be cleared, corrupting every
            # subsequent keystroke — especially arrow keys used for IME
            # candidate navigation.
            elif self._modifier_flags and key_code not in _ime_nav_keys and self._should_apply_sticky_flags(key_code, payload_flags, action):
                flags = self._modifier_flags
            self._pressed_key_codes.discard(key_code)
            self._last_key_flags.pop(key_code, None)

            event = CGEventCreateKeyboardEvent(self.source, key_code, False)
            if flags and key_code != 57:
                CGEventSetFlags(event, flags)
                logger.info(f"  -> CGEventSetFlags(0x{flags:08x}) on keyup")
            CGEventPost(kCGHIDEventTap, event)
            logger.info(f"  -> CGEventPost keyup mac_code={key_code}")

    def _should_apply_sticky_flags(self, key_code, payload_flags, action):
        """Only preserve modifier flags when the browser explicitly sent them for this key."""
        if action == 'keydown':
            return bool(payload_flags)
        return bool(payload_flags) and self._last_key_flags.get(key_code) == payload_flags

    def _release_lost_modifier_flags(self, lost_flags: int, reason: str = "reconcile") -> None:
        """
        Reconcile: clear modifier flags whose keyup was lost (e.g. DataChannel drop).
        Emits CGEvent keyup for each flag bit found in _pressed_modifier_key_codes;
        always clears the bit from _modifier_flags even if no physical code is tracked.
        """
        flag_to_keycodes = {
            kCGEventFlagMaskCommand:   [55, 54],   # MetaLeft, MetaRight
            kCGEventFlagMaskShift:     [56, 60],   # ShiftLeft, ShiftRight
            kCGEventFlagMaskAlternate: [58, 61],   # AltLeft, AltRight
            kCGEventFlagMaskControl:   [59, 62],   # ControlLeft, ControlRight
        }
        logger.warning(
            "reconcile: releasing lost modifier flags=0x%08x reason=%s",
            lost_flags, reason,
        )
        for flag, keycodes in flag_to_keycodes.items():
            if not (lost_flags & flag):
                continue
            self._modifier_flags &= ~flag
            # Emit a physical keyup only if we tracked the key as pressed
            for kc in keycodes:
                if kc in self._pressed_modifier_key_codes:
                    self._pressed_modifier_key_codes.discard(kc)
                    self._pressed_key_codes.discard(kc)
                    event = CGEventCreateKeyboardEvent(self.source, kc, False)
                    CGEventSetFlags(event, self._modifier_flags)
                    CGEventPost(kCGHIDEventTap, event)
                    logger.info(
                        "  -> reconcile keyup mac_code=%s flag=0x%08x reason=%s",
                        kc, flag, reason,
                    )
                    break  # one keyup per modifier family is enough

    def release_all_modifiers(self, reason="manual"):
        """Release host-side modifier state when a browser keyup is lost."""
        if not self._modifier_flags and not self._pressed_modifier_key_codes:
            return

        modifier_order = [
            (55, kCGEventFlagMaskCommand),
            (54, kCGEventFlagMaskCommand),
            (56, kCGEventFlagMaskShift),
            (60, kCGEventFlagMaskShift),
            (58, kCGEventFlagMaskAlternate),
            (61, kCGEventFlagMaskAlternate),
            (59, kCGEventFlagMaskControl),
            (62, kCGEventFlagMaskControl),
        ]

        pressed = set(self._pressed_modifier_key_codes)
        if not pressed:
            if self._modifier_flags & kCGEventFlagMaskCommand:
                pressed.add(55)
            if self._modifier_flags & kCGEventFlagMaskShift:
                pressed.add(56)
            if self._modifier_flags & kCGEventFlagMaskAlternate:
                pressed.add(58)
            if self._modifier_flags & kCGEventFlagMaskControl:
                pressed.add(59)

        logger.warning("Releasing stuck modifiers flags=0x%08x key_count=%s", self._modifier_flags, len(pressed))
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
        logger.warning("Releasing stuck keys key_count=%s flags=0x%08x", len(pressed), self._modifier_flags)

        non_modifiers = sorted(pressed - modifier_keys)
        for key_code in non_modifiers:
            event = CGEventCreateKeyboardEvent(self.source, key_code, False)
            CGEventSetFlags(event, 0)
            CGEventPost(kCGHIDEventTap, event)
            logger.info("  -> Released keyup mac_code=%s", key_code)

        self.release_all_modifiers(reason=reason)
        self._pressed_key_codes.clear()


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
