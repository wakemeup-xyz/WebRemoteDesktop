#!/usr/bin/env python3
"""Input handling for remote control - mouse and keyboard simulation"""

import asyncio
import logging
from pynput.mouse import Controller as MouseController, Button
from pynput.keyboard import Controller as KeyboardController, Key
import screeninfo
import threading

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class InputHandler:
    """Handles mouse and keyboard input from remote viewer"""

    def __init__(self):
        self.mouse = MouseController()
        self.keyboard = KeyboardController()
        self._running = False
        self._input_queue = asyncio.Queue()

        # Get primary monitor
        monitors = screeninfo.get_monitors()
        self.monitor = monitors[0] if monitors else None

    def start(self):
        """Start the input handler"""
        self._running = True
        logger.info("Input handler started")

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

            if input_type == 'mouse':
                self._handle_mouse(action, payload)
            elif input_type == 'keyboard':
                self._handle_keyboard(action, payload)

        except Exception as e:
            logger.error(f"Error handling input: {e}")

    def _handle_mouse(self, action, payload):
        """Handle mouse events"""
        if not self.monitor:
            return

        rel_x = payload.get('relX', 0)
        rel_y = payload.get('relY', 0)

        # Convert relative coordinates to absolute
        x = self.monitor.x + rel_x * self.monitor.width
        y = self.monitor.y + rel_y * self.monitor.height

        if action == 'move':
            self.mouse.position = (x, y)

        elif action == 'down':
            button = self._get_mouse_button(payload.get('button', 'left'))
            self.mouse.press(button)

        elif action == 'up':
            button = self._get_mouse_button(payload.get('button', 'left'))
            self.mouse.release(button)

        elif action == 'click':
            button = self._get_mouse_button(payload.get('button', 'left'))
            self.mouse.click(button)

        elif action == 'dblclick':
            button = self._get_mouse_button(payload.get('button', 'left'))
            self.mouse.click(button, 2)

        elif action == 'wheel':
            delta_x = payload.get('deltaX', 0)
            delta_y = payload.get('deltaY', 0)
            self.mouse.scroll(int(delta_y), int(delta_x))

    def _get_mouse_button(self, button_name):
        """Get mouse button from string name"""
        button_map = {
            'left': Button.left,
            'right': Button.right,
            'middle': Button.middle
        }
        return button_map.get(button_name, Button.left)

    def _handle_keyboard(self, action, payload):
        """Handle keyboard events"""
        key_code = payload.get('keyCode')
        key_char = payload.get('key', '')

        if not key_char and not key_code:
            return

        # Try to get the key
        key = None
        if len(key_char) == 1:
            key = key_char
        else:
            # Map special keys
            key_map = {
                'Enter': Key.enter,
                'Escape': Key.esc,
                'Backspace': Key.backspace,
                'Tab': Key.tab,
                'Space': Key.space,
                'ArrowUp': Key.up,
                'ArrowDown': Key.down,
                'ArrowLeft': Key.left,
                'ArrowRight': Key.right,
                'Control': Key.ctrl,
                'Alt': Key.alt,
                'Shift': Key.shift,
                'Meta': Key.cmd,
            }
            key = key_map.get(key_char)

        if key:
            if action == 'keydown':
                self.keyboard.press(key)
            elif action == 'keyup':
                self.keyboard.release(key)


if __name__ == "__main__":
    # Test the input handler
    handler = InputHandler()
    handler.start()

    # Test mouse movement
    print("Testing mouse movement...")
    handler.mouse.position = (100, 100)

    # Test keyboard input
    print("Testing keyboard input...")
    handler.keyboard.type("Hello, World!")

    handler.stop()
