"""Production desktop execution path with AST extraction; never import Quartz.

Selected methods are compiled without module imports or constructors. Native
mouse/command calls use in-memory fakes; release-helper cases use fake CG globals.
Every owned executor is shut down.
"""
import ast
import asyncio
from concurrent.futures import ThreadPoolExecutor
import logging
from pathlib import Path
import threading
import time
from types import SimpleNamespace

import pytest

from input_admission_queue import input_commit_fence
from input_timing import InputTiming
from remote_desktop_write_state import ReliableDesktopWriteState


LEASE = "lease-000000000001"


def message(action="reset", seq=3, input_id="reset-fence"):
    return {"schemaVersion": 2, "type": "mouse" if action == "reset" else "command",
            "action": action, "seq": seq, "leaseId": LEASE, "leaseEpoch": 4,
            "inputIds": [input_id], "payload": {"reason": "manual"} if action == "reset" else {}}


def handler_with_fake_native(native):
    tree = ast.parse(Path(__file__).with_name("input_handler.py").read_text())
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "InputHandler")
    method = next(node for node in cls.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "handle_input")
    env = {"asyncio": asyncio, "time": time, "logger": logging.getLogger(__name__),
           "InputTiming": InputTiming, "input_commit_fence": input_commit_fence}
    exec(compile(ast.Module(body=[method], type_ignores=[]), "input_handler.py", "exec"), env)
    handler = type("FakeNativeHandler", (), {"handle_input": env["handle_input"]})()
    handler._running = True
    handler._input_lock = asyncio.Lock()
    handler._lock_waiters = 0
    handler._lock_contention_logged = False
    handler._input_thread_pool = ThreadPoolExecutor(max_workers=1)
    handler._desktop_writes = ReliableDesktopWriteState()
    handler._desktop_writes.transition(lease_id=LEASE, lease_epoch=4)
    handler._handle_mouse = native
    handler._handle_command = native
    return handler


def attach_mouse_release_helpers(handler, *, fail_button=None, fail_stage="post"):
    """Compile only production helpers with fake CG globals, never Quartz."""
    tree = ast.parse(Path(__file__).with_name("input_handler.py").read_text())
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "InputHandler")
    methods = [node for node in cls.body if isinstance(node, ast.FunctionDef)
               and node.name in {"release_all_mouse_buttons", "_handle_mouse"}]
    attempts, posted = [], []
    remaining_failures = [1 if fail_button else 0]
    def create(source, event_type, position, button):
        if fail_stage == "create" and button == fail_button and remaining_failures[0]:
            remaining_failures[0] -= 1
            return None
        return button
    def post(tap, event):
        attempts.append(event)
        if fail_stage == "post" and event == fail_button and remaining_failures[0]:
            remaining_failures[0] -= 1
            raise RuntimeError("fake-post-failed")
        if event is None:
            raise RuntimeError("fake-null-event")
        posted.append(event)
    env = {"logger": logging.getLogger(__name__), "CGEventCreateMouseEvent": create,
           "CGEventPost": post, "kCGHIDEventTap": "fake-tap",
           "kCGEventLeftMouseUp": "left-up", "kCGEventRightMouseUp": "right-up",
           "kCGEventOtherMouseUp": "middle-up"}
    exec(compile(ast.Module(body=methods, type_ignores=[]), "input_handler.py", "exec"), env)
    handler.release_all_mouse_buttons = env["release_all_mouse_buttons"].__get__(handler)
    handler._handle_mouse = env["_handle_mouse"].__get__(handler)
    handler.monitor = SimpleNamespace(x=0, y=0)
    handler.source = "fake-source"
    handler._get_mouse_button = lambda button: button
    handler._last_mouse_position = None
    handler._pressed_mouse_buttons = {"left", "right"}
    handler._pressed_mouse_button = "left"
    return attempts, posted


@pytest.mark.asyncio
async def test_native_reset_commits_fence_once_and_late_input_never_executes():
    calls = []
    handler = handler_with_fake_native(lambda action, payload: calls.append(action) or True)
    try:
        assert (await handler.handle_input(message("showDock", 1, "ordinary-1")))["status"] == "applied"
        reset = message()
        result = await handler.handle_input(reset)
        assert result["status"] == "applied" and result["appliedSeq"] == 3
        assert (await handler.handle_input(message("showDock", 2, "late-2")))["status"] == "duplicate"
        assert (await handler.handle_input(reset))["status"] == "duplicate"
        assert (await handler.handle_input(reset | {"inputIds": ["another"]}))["status"] == "resync-required"
        assert calls == ["showDock", "reset"]
    finally:
        handler._input_thread_pool.shutdown(wait=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["false", "raise", "stale"])
async def test_failed_native_or_stale_fence_never_proves_reset(failure):
    current = [True]
    def native(action, payload):
        if action == "reset":
            if failure == "raise":
                raise RuntimeError("fake-native-failure")
            if failure == "false":
                return False
            current[0] = False
        return True
    handler = handler_with_fake_native(native)
    token = input_commit_fence.set(lambda: current[0])
    try:
        reset = message()
        result = await handler.handle_input(reset)
        assert result["status"] == ("stale-lease" if failure == "stale" else "execution-failed")
        assert handler._desktop_writes.snapshot().last_applied_seq == 0
        current[0] = True
        for seq in range(1, 4):
            assert (await handler.handle_input(message("showDock", seq, f"ordinary-{seq}")))["status"] == "applied"
        assert (await handler.handle_input(reset))["status"] == "resync-required"
    finally:
        input_commit_fence.reset(token)
        handler._input_thread_pool.shutdown(wait=True)


@pytest.mark.asyncio
async def test_reset_waits_for_inflight_native_before_validating_and_committing():
    entered, release = threading.Event(), threading.Event()
    calls = []
    def native(action, payload):
        calls.append(action)
        if action == "showDock":
            entered.set()
            assert release.wait(2)
        return True
    handler = handler_with_fake_native(native)
    first = asyncio.create_task(handler.handle_input(message("showDock", 1, "ordinary-1")))
    reset = None
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        reset = asyncio.create_task(handler.handle_input(message()))
        await asyncio.sleep(0)
        assert not reset.done()
        assert calls == ["showDock"]
        assert handler._desktop_writes.snapshot().last_applied_seq == 0
        release.set()
        assert (await first)["status"] == "applied"
        assert (await reset)["status"] == "applied"
        assert calls == ["showDock", "reset"]
        assert handler._desktop_writes.snapshot().last_applied_seq == 3
    finally:
        release.set()
        await asyncio.gather(first, *([reset] if reset else []), return_exceptions=True)
        handler._input_thread_pool.shutdown(wait=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("fail_button,fail_stage", [("left", "post"), ("right", "post"), ("left", "create")])
async def test_mouse_release_failure_retains_unreleased_tracking_until_real_retry(fail_button, fail_stage):
    handler = handler_with_fake_native(None)
    attempts, posted = attach_mouse_release_helpers(handler, fail_button=fail_button, fail_stage=fail_stage)
    try:
        reset = message()
        assert (await handler.handle_input(reset))["status"] == "execution-failed"
        assert handler._desktop_writes.snapshot().last_applied_seq == 0
        expected_remaining = {"right"} if fail_button == "right" else {"left", "right"}
        assert handler._pressed_mouse_buttons == expected_remaining
        assert handler._pressed_mouse_button == (None if fail_button == "right" else "left")
        assert (await handler.handle_input(reset))["status"] == "applied"
        assert posted == ["left", "right"]
        assert handler._pressed_mouse_buttons == set()
        assert handler._pressed_mouse_button is None
        prior_attempts = list(attempts)
        assert (await handler.handle_input(reset))["status"] == "duplicate"
        assert attempts == prior_attempts
    finally:
        handler._input_thread_pool.shutdown(wait=True)


def test_mouse_release_without_monitor_cannot_clear_or_claim_success():
    handler = SimpleNamespace()
    _, posted = attach_mouse_release_helpers(handler)
    handler.monitor = None
    with pytest.raises(RuntimeError):
        handler.release_all_mouse_buttons()
    assert handler._pressed_mouse_buttons == {"left", "right"}
    assert handler._pressed_mouse_button == "left"
    assert posted == []
