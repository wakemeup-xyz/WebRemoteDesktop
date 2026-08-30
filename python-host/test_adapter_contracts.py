import asyncio

from adapters.capture import CaptureAdapter
from adapters.input import InputAdapter
from adapters.lifecycle import LifecycleCoordinator


def run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
        asyncio.set_event_loop(asyncio.new_event_loop())


class FakeTrack:
    def __init__(self):
        self.calls = []

    def set_suspended(self, value):
        self.calls.append(("suspend", value))
        return len(self.calls)

    async def shutdown(self):
        self.calls.append(("shutdown",))


class FakeInput:
    def start(self):
        return "started"

    async def handle_input(self, data):
        return {"data": data}


def test_capture_adapter_preserves_suspend_resume_and_shutdown():
    track = FakeTrack()
    adapter = CaptureAdapter(track=track)
    assert adapter.suspend() == 1
    assert adapter.resume() == 2
    run(adapter.shutdown())
    assert track.calls == [("suspend", True), ("suspend", False), ("shutdown",)]


def test_input_adapter_delegates_to_existing_handler():
    adapter = InputAdapter(FakeInput())
    assert adapter.start() == "started"
    assert run(adapter.handle_input({"type": "mouse"})) == {"data": {"type": "mouse"}}


def test_lifecycle_shutdown_is_idempotent_and_ordered():
    calls = []

    async def mark(name):
        calls.append(name)

    coordinator = LifecycleCoordinator(
        close_peer=lambda: mark("peer"),
        stop_relay=lambda: mark("relay"),
        disconnect=lambda: mark("socket"),
        stop_overlay=lambda: calls.append("overlay"),
    )
    assert run(coordinator.shutdown()) is True
    assert run(coordinator.shutdown()) is False
    assert calls == ["relay", "peer", "socket", "overlay"]
