from types import SimpleNamespace
import asyncio

import pytest

from host import WebRemoteHost


def make_host(current_viewer_id=None, offer_epoch=0, pc_state="connected"):
    host = object.__new__(WebRemoteHost)
    host.current_viewer_id = current_viewer_id
    host._offer_epoch = offer_epoch
    host.pc = SimpleNamespace(connectionState=pc_state) if pc_state else None
    return host


def test_new_viewer_epoch_starts_from_one_after_previous_viewer():
    host = make_host(current_viewer_id="old-viewer", offer_epoch=2, pc_state="connected")

    assert host._should_process_offer("new-viewer", 1) is True
    assert host.current_viewer_id == "new-viewer"
    assert host._offer_epoch == 1


def test_same_viewer_duplicate_epoch_is_rejected():
    host = make_host(current_viewer_id="viewer-1", offer_epoch=2, pc_state="connected")

    assert host._should_process_offer("viewer-1", 2) is False
    assert host.current_viewer_id == "viewer-1"
    assert host._offer_epoch == 2


def test_direct_datachannel_input_inherits_only_offer_binding():
    host = object.__new__(WebRemoteHost)
    binding = {
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 7,
        "connectionGeneration": 4,
    }
    host._active_input_binding = binding

    data = host._prepare_bound_datachannel_input(binding, {
        "viewerId": "attacker",
        "schemaVersion": 2,
        "type": "keyboard",
        "action": "key",
        "leaseId": binding["leaseId"],
        "leaseEpoch": binding["leaseEpoch"],
        "seq": 1,
        "inputIds": ["input-1"],
        "payload": {},
    })

    assert data["viewerId"] == "viewer-1"
    assert data["leaseId"] == binding["leaseId"]
    assert data["leaseEpoch"] == binding["leaseEpoch"]
    assert data["connectionGeneration"] == 4
    assert data["transport"] == "datachannel"


def test_old_datachannel_and_mismatched_lease_are_rejected_after_takeover():
    host = object.__new__(WebRemoteHost)
    old_binding = {
        "viewerId": "viewer-old",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 7,
        "connectionGeneration": 4,
    }
    host._active_input_binding = {
        "viewerId": "viewer-new",
        "leaseId": "lease-000000000002",
        "leaseEpoch": 8,
        "connectionGeneration": 5,
    }
    v2 = {
        "schemaVersion": 2,
        "type": "keyboard",
        "action": "key",
        "leaseId": old_binding["leaseId"],
        "leaseEpoch": old_binding["leaseEpoch"],
        "seq": 1,
        "inputIds": ["input-1"],
        "payload": {},
    }

    assert host._prepare_bound_datachannel_input(old_binding, v2) is None
    assert host._prepare_bound_datachannel_input(host._active_input_binding, {
        **v2,
        "leaseId": "lease-not-bound",
    }) is None


@pytest.mark.asyncio
async def test_input_move_close_does_not_reset_bound_keyboard_but_input_close_does():
    binding = {
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 7,
        "connectionGeneration": 4,
    }

    class FakeChannel:
        def __init__(self, label):
            self.label = label

    class FakeInputHandler:
        def __init__(self):
            self.pressed_key_count = 1
            self.reset_reasons = []

        async def reset_keyboard(self, **kwargs):
            self.reset_reasons.append(kwargs)
            self.pressed_key_count = 0
            return {"status": "applied"}

        def release_all_mouse_buttons(self, **_kwargs):
            return None

    host = object.__new__(WebRemoteHost)
    host._active_input_binding = binding
    host._input_lifecycle_tasks = set()
    host.input_handler = FakeInputHandler()
    move_channel = FakeChannel("input-move")
    input_channel = FakeChannel("input")
    host._input_datachannel = input_channel

    host._handle_datachannel_close(move_channel, binding)
    await asyncio.sleep(0)
    assert host.input_handler.reset_reasons == []
    assert host.input_handler.pressed_key_count == 1

    host._handle_datachannel_close(input_channel, binding)
    await asyncio.gather(*host._input_lifecycle_tasks)
    assert host.input_handler.reset_reasons == [{
        "reason": "datachannel-closed",
        "lease_epoch": 7,
    }]
    assert host.input_handler.pressed_key_count == 0


@pytest.mark.asyncio
async def test_stale_control_transition_preserves_active_keyboard_binding_without_ack():
    binding = {
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 2,
        "connectionGeneration": 4,
    }

    class FakeInputHandler:
        def __init__(self):
            self.pressed_key_count = 1
            self.reset_calls = []
            self.transition_calls = []

        async def reset_keyboard(self, **kwargs):
            self.reset_calls.append(kwargs)
            self.pressed_key_count = 0
            return {"status": "applied"}

        async def transition_keyboard(self, **kwargs):
            self.transition_calls.append(kwargs)
            return {"status": "applied"}

        def release_all_mouse_buttons(self, **_kwargs):
            return None

    sent = []

    async def emit(event, payload):
        sent.append((event, payload))

    host = object.__new__(WebRemoteHost)
    host._active_input_binding = binding
    host._connection_generation = 4
    host.input_handler = FakeInputHandler()
    host.sio = SimpleNamespace(emit=emit)

    await host.on_control_transition({
        "viewerId": "viewer-stale",
        "leaseId": "lease-0000000000000002",
        "leaseEpoch": 1,
    })

    assert host._active_input_binding == binding
    assert host._connection_generation == 4
    assert host.input_handler.pressed_key_count == 1
    assert host.input_handler.reset_calls == []
    assert host.input_handler.transition_calls == []
    assert sent == []


@pytest.mark.asyncio
async def test_same_epoch_reset_only_control_transition_clears_and_acknowledges():
    binding = {
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 2,
        "connectionGeneration": 4,
    }

    class FakeInputHandler:
        def __init__(self):
            self.pressed_key_count = 1
            self.reset_calls = []

        async def reset_keyboard(self, **kwargs):
            self.reset_calls.append(kwargs)
            self.pressed_key_count = 0
            return {"status": "applied"}

        def release_all_mouse_buttons(self, **_kwargs):
            return None

    sent = []

    async def emit(event, payload):
        sent.append((event, payload))

    host = object.__new__(WebRemoteHost)
    host._active_input_binding = binding
    host._connection_generation = 4
    host.input_handler = FakeInputHandler()
    host.sio = SimpleNamespace(emit=emit)

    await host.on_control_transition({"leaseEpoch": 2, "reason": "control-revoked"})

    assert host._active_input_binding is None
    assert host._connection_generation == 5
    assert host.input_handler.pressed_key_count == 0
    assert host.input_handler.reset_calls == [{
        "reason": "control-revoked",
        "lease_epoch": None,
    }]
    assert sent == [("control-transition-ack", {"leaseEpoch": 2, "status": "applied"})]


@pytest.mark.asyncio
async def test_newer_reset_only_control_transition_still_resets_and_acknowledges():
    binding = {
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 2,
        "connectionGeneration": 4,
    }

    class FakeInputHandler:
        def __init__(self):
            self.pressed_key_count = 1
            self.reset_calls = []

        async def reset_keyboard(self, **kwargs):
            self.reset_calls.append(kwargs)
            self.pressed_key_count = 0
            return {"status": "applied"}

        def release_all_mouse_buttons(self, **_kwargs):
            return None

    sent = []

    async def emit(event, payload):
        sent.append((event, payload))

    host = object.__new__(WebRemoteHost)
    host._active_input_binding = binding
    host._connection_generation = 4
    host.input_handler = FakeInputHandler()
    host.sio = SimpleNamespace(emit=emit)

    await host.on_control_transition({"leaseEpoch": 3, "reason": "control-revoked"})

    assert host._active_input_binding is None
    assert host._connection_generation == 5
    assert host.input_handler.pressed_key_count == 0
    assert host.input_handler.reset_calls == [{
        "reason": "control-revoked",
        "lease_epoch": None,
    }]
    assert sent == [("control-transition-ack", {"leaseEpoch": 3, "status": "applied"})]


@pytest.mark.asyncio
async def test_ice_candidate_from_stale_viewer_is_ignored():
    host = make_host(current_viewer_id="viewer-1", offer_epoch=1, pc_state="connected")
    host.pending_candidates = []
    calls = []

    async def fake_add_ice_candidate(candidate):
        calls.append(candidate)

    host._add_ice_candidate = fake_add_ice_candidate

    await host.on_ice_candidate({
        "from": "old-viewer",
        "candidate": {"candidate": "candidate:1 1 udp 1 127.0.0.1 9999 typ host"},
    })

    assert calls == []
    assert host.pending_candidates == []


@pytest.mark.asyncio
async def test_viewer_status_zero_closes_stale_peer_connection():
    closed = []
    shut_down = []

    class FakePC:
        async def close(self):
            closed.append(True)

    class FakeTrack:
        async def shutdown(self):
            shut_down.append(True)

    host = make_host(current_viewer_id="viewer-1", offer_epoch=3, pc_state=None)
    host.pc = FakePC()
    host.screen_track = FakeTrack()
    host._input_datachannel = object()
    host.pending_candidates = [{"candidate": "old"}]
    host.relay_streamer = None
    async def reset_keyboard(**_kwargs):
        return {"status": "applied"}

    host.input_handler = SimpleNamespace(
        reset_keyboard=reset_keyboard,
        release_all_mouse_buttons=lambda reason: None,
    )
    host.overlay = SimpleNamespace(send=lambda event: None)

    await host.on_viewer_status({"onlineCount": 0, "viewers": []})

    assert closed == [True]
    assert shut_down == [True]
    assert host.pc is None
    assert host.screen_track is None
    assert host._input_datachannel is None
    assert host.current_viewer_id is None
    assert host._offer_epoch == 0
    assert host.pending_candidates == []


@pytest.mark.asyncio
async def test_relay_stop_from_stale_viewer_does_not_stop_active_relay():
    stops = []

    class FakeRelayStreamer:
        viewer_id = "active-relay"

        async def stop(self):
            stops.append(True)

    host = make_host(current_viewer_id="viewer-1", offer_epoch=1, pc_state=None)
    host.sio = None
    host.relay_streamer = FakeRelayStreamer()

    await host.on_relay_stream_control({
        "enabled": False,
        "viewerId": "stale-relay",
    })

    assert stops == []


@pytest.mark.asyncio
async def test_input_from_stale_viewer_is_ignored():
    calls = []

    class FakeInputHandler:
        async def handle_input(self, data):
            calls.append(data)

    host = make_host(current_viewer_id="active-viewer", offer_epoch=1, pc_state="connected")
    host.input_handler = FakeInputHandler()
    host.overlay = SimpleNamespace(send=lambda event: None)
    host.screen_track = None

    await host.on_input({
        "viewerId": "old-viewer",
        "type": "keyboard",
        "action": "keydown",
        "payload": {"key": "a", "code": "KeyA"},
    })

    assert calls == []
