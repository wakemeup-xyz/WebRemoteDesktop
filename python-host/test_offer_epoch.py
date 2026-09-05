from types import SimpleNamespace
import asyncio
import host as host_module

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


def test_live_datachannel_follows_control_rebind_without_new_offer():
    """Granting control updates the lease; the existing DC must use the new binding."""
    host = object.__new__(WebRemoteHost)
    old_binding = {
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 7,
        "connectionGeneration": 4,
    }
    new_binding = {
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000002",
        "leaseEpoch": 8,
        "connectionGeneration": 5,
    }
    channel = SimpleNamespace(label="input")
    host._active_input_binding = new_binding
    host._input_datachannel = channel
    host._input_move_datachannel = None

    data = host._prepare_bound_datachannel_input(old_binding, {
        "schemaVersion": 2,
        "type": "keyboard",
        "action": "key",
        "leaseId": new_binding["leaseId"],
        "leaseEpoch": new_binding["leaseEpoch"],
        "seq": 1,
        "inputIds": ["input-1"],
        "payload": {},
    }, channel=channel)

    assert data["viewerId"] == "viewer-1"
    assert data["leaseId"] == new_binding["leaseId"]
    assert data["leaseEpoch"] == 8
    assert data["connectionGeneration"] == 5


def test_stale_datachannel_does_not_inherit_rebinding_even_for_same_viewer():
    host = object.__new__(WebRemoteHost)
    old_binding = {
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 7,
        "connectionGeneration": 4,
    }
    host._active_input_binding = {
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000002",
        "leaseEpoch": 8,
        "connectionGeneration": 5,
    }
    stale = SimpleNamespace(label="input")
    live = SimpleNamespace(label="input")
    host._input_datachannel = live
    host._input_move_datachannel = None

    assert host._prepare_bound_datachannel_input(old_binding, {
        "schemaVersion": 2,
        "type": "mouse",
        "action": "move",
        "leaseId": "lease-000000000002",
        "leaseEpoch": 8,
        "payload": {"relX": 0.5, "relY": 0.5},
    }, channel=stale) is None


@pytest.mark.asyncio
async def test_v2_input_uses_active_lease_binding_instead_of_legacy_offer_viewer():
    binding = {
        "viewerId": "viewer-b",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 2,
        "connectionGeneration": 4,
    }
    applied = []

    async def apply_keyboard(data, **_kwargs):
        applied.append(data)
        return {"inputIds": []}

    host = object.__new__(WebRemoteHost)
    host.current_viewer_id = "viewer-a"
    host._active_input_binding = binding
    host.input_handler = SimpleNamespace(apply_keyboard=apply_keyboard)
    host.overlay = SimpleNamespace(send=lambda _payload: None)
    host.screen_track = None
    host.sio = None

    v2_input = {
        "schemaVersion": 2,
        "type": "keyboard",
        "action": "key",
        "viewerId": "viewer-b",
        "leaseId": binding["leaseId"],
        "leaseEpoch": binding["leaseEpoch"],
        "seq": 1,
        "inputIds": ["input-1"],
        "payload": {},
    }
    await host.on_input(v2_input)
    await host.on_input({**v2_input, "viewerId": "viewer-forged"})

    assert applied == [v2_input]


@pytest.mark.asyncio
async def test_newer_transition_freezes_prior_v2_lease_before_reset_completes():
    old_binding = {
        "viewerId": "viewer-a",
        "leaseId": "lease-0000000000000001",
        "leaseEpoch": 1,
        "connectionGeneration": 1,
    }

    class BlockingInputHandler:
        def __init__(self):
            self.reset_started = asyncio.Event()
            self.allow_reset = asyncio.Event()
            self.applied = []

        async def reset_keyboard(self, **_kwargs):
            self.reset_started.set()
            await self.allow_reset.wait()
            return {"status": "applied"}

        async def transition_keyboard(self, **_kwargs):
            return {"status": "applied"}

        def transition_desktop_writes(self, **_kwargs):
            return SimpleNamespace(status="applied")

        async def apply_keyboard(self, data):
            self.applied.append(data)
            return {"inputIds": []}

        def release_all_mouse_buttons(self, **_kwargs):
            return None

    host = object.__new__(WebRemoteHost)
    host.current_viewer_id = "viewer-a"
    host._active_input_binding = old_binding
    host._connection_generation = 1
    host.input_handler = BlockingInputHandler()
    host.overlay = SimpleNamespace(send=lambda _payload: None)
    host.screen_track = None
    host.sio = None

    transition = asyncio.create_task(host.on_control_transition({
        "viewerId": "viewer-b",
        "leaseId": "lease-0000000000000002",
        "leaseEpoch": 2,
    }))
    await asyncio.wait_for(host.input_handler.reset_started.wait(), timeout=1)

    await host.on_input({
        "schemaVersion": 2,
        "type": "keyboard",
        "action": "key",
        "viewerId": old_binding["viewerId"],
        "leaseId": old_binding["leaseId"],
        "leaseEpoch": old_binding["leaseEpoch"],
        "seq": 1,
        "inputIds": ["input-old"],
        "payload": {},
    })

    assert host.input_handler.applied == []
    assert host._active_input_binding is None

    host.input_handler.allow_reset.set()
    await transition
    assert host._active_input_binding["viewerId"] == "viewer-b"


@pytest.mark.asyncio
async def test_peer_teardown_freezes_old_lease_without_clobbering_replacement():
    old_binding = {
        "viewerId": "viewer-a",
        "leaseId": "lease-0000000000000001",
        "leaseEpoch": 1,
        "connectionGeneration": 1,
    }
    new_binding = {
        "viewerId": "viewer-b",
        "leaseId": "lease-0000000000000002",
        "leaseEpoch": 2,
        "connectionGeneration": 2,
    }

    class FakePeer:
        def __init__(self):
            self.close_calls = 0

        async def close(self):
            self.close_calls += 1

    class FakeTrack:
        def __init__(self):
            self.shutdown_calls = 0

        async def shutdown(self):
            self.shutdown_calls += 1

    class BlockingInputHandler:
        def __init__(self):
            self.reset_started = asyncio.Event()
            self.allow_reset = asyncio.Event()
            self.applied = []

        async def reset_keyboard(self, **_kwargs):
            self.reset_started.set()
            await self.allow_reset.wait()
            return {"status": "applied"}

        async def apply_keyboard(self, data):
            self.applied.append(data)
            return {"inputIds": []}

        def release_all_mouse_buttons(self, **_kwargs):
            return None

    old_peer, new_peer = FakePeer(), FakePeer()
    old_track, new_track = FakeTrack(), FakeTrack()
    old_channel, new_channel = object(), object()
    host = object.__new__(WebRemoteHost)
    host.current_viewer_id = "viewer-a"
    host._offer_epoch = 1
    host._active_input_binding = old_binding
    host._input_datachannel = old_channel
    host.pending_candidates = [{"candidate": "old"}]
    host.pc = old_peer
    host.screen_track = old_track
    host.input_handler = BlockingInputHandler()
    host.overlay = SimpleNamespace(send=lambda _payload: None)
    host.sio = None

    teardown = asyncio.create_task(
        host._close_peer_connection(reason="viewer-disconnected", reset_offer_state=True)
    )
    await asyncio.wait_for(host.input_handler.reset_started.wait(), timeout=1)
    await host.on_input({
        "schemaVersion": 2,
        "type": "keyboard",
        "action": "key",
        "viewerId": old_binding["viewerId"],
        "leaseId": old_binding["leaseId"],
        "leaseEpoch": old_binding["leaseEpoch"],
        "seq": 1,
        "inputIds": ["input-old"],
        "payload": {},
    })

    host.current_viewer_id = "viewer-b"
    host._offer_epoch = 2
    host._active_input_binding = new_binding
    host._input_datachannel = new_channel
    host.pending_candidates = [{"candidate": "new"}]
    host.pc = new_peer
    host.screen_track = new_track
    host.input_handler.allow_reset.set()
    await teardown

    assert host.input_handler.applied == []
    assert old_peer.close_calls == 1
    assert old_track.shutdown_calls == 1
    assert new_peer.close_calls == 0
    assert new_track.shutdown_calls == 0
    assert host.pc is new_peer
    assert host.screen_track is new_track
    assert host._input_datachannel is new_channel
    assert host._active_input_binding == new_binding
    assert host.pending_candidates == [{"candidate": "new"}]
    assert host.current_viewer_id == "viewer-b"
    assert host._offer_epoch == 2


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
async def test_input_close_uses_live_binding_after_grant_without_pc_rebuild():
    old_binding = {
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 1,
        "connectionGeneration": 4,
    }
    live_binding = {
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000002",
        "leaseEpoch": 2,
        "connectionGeneration": 5,
    }

    class FakeChannel:
        label = "input"

    class FakeInputHandler:
        def __init__(self):
            self.reset_calls = []
            self.release_calls = []

        async def reset_keyboard(self, **kwargs):
            self.reset_calls.append(kwargs)
            return {"status": "applied"}

        def release_all_mouse_buttons(self, **kwargs):
            self.release_calls.append(kwargs)

    host = object.__new__(WebRemoteHost)
    host._active_input_binding = live_binding
    host._input_lifecycle_tasks = set()
    host.input_handler = FakeInputHandler()
    channel = FakeChannel()
    host._input_datachannel = channel

    host._handle_datachannel_close(channel, old_binding)
    await asyncio.gather(*host._input_lifecycle_tasks)

    assert host.input_handler.reset_calls == [{
        "reason": "datachannel-closed",
        "lease_epoch": 2,
    }]
    assert host.input_handler.release_calls == [{"reason": "datachannel-closed"}]


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

        def transition_desktop_writes(self, **_kwargs):
            return SimpleNamespace(status="applied")

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
async def test_grant_and_same_epoch_revoke_are_serialized_without_late_rebind():
    class BlockingInputHandler:
        def __init__(self):
            self.reset_started = asyncio.Event()
            self.allow_first_reset = asyncio.Event()
            self.reset_calls = []
            self.transition_calls = []

        async def reset_keyboard(self, **kwargs):
            self.reset_calls.append(kwargs)
            if len(self.reset_calls) == 1:
                self.reset_started.set()
                await self.allow_first_reset.wait()
            return {"status": "applied"}

        async def transition_keyboard(self, **kwargs):
            self.transition_calls.append(kwargs)
            return {"status": "applied"}

        def transition_desktop_writes(self, **_kwargs):
            return SimpleNamespace(status="applied")

        def release_all_mouse_buttons(self, **_kwargs):
            return None

    sent = []
    host = object.__new__(WebRemoteHost)
    host._active_input_binding = {
        "viewerId": "viewer-old",
        "leaseId": "lease-0000000000000001",
        "leaseEpoch": 1,
        "connectionGeneration": 1,
    }
    host._connection_generation = 1
    host.input_handler = BlockingInputHandler()

    async def emit(event, payload):
        binding = host._active_input_binding
        sent.append((event, payload, dict(binding) if binding else None))

    host.sio = SimpleNamespace(emit=emit)
    grant = asyncio.create_task(host.on_control_transition({
        "viewerId": "viewer-new",
        "leaseId": "lease-0000000000000002",
        "leaseEpoch": 2,
    }))
    await asyncio.wait_for(host.input_handler.reset_started.wait(), timeout=1)
    revoke = asyncio.create_task(host.on_control_transition({
        "leaseEpoch": 2,
        "reason": "control-revoked",
    }))
    await asyncio.sleep(0)
    assert not revoke.done()

    host.input_handler.allow_first_reset.set()
    await asyncio.gather(grant, revoke)

    assert host._active_input_binding is None
    assert host.input_handler.transition_calls == [{
        "connection_generation": 2,
        "lease_id": "lease-0000000000000002",
        "lease_epoch": 2,
    }]
    assert [call["reason"] for call in host.input_handler.reset_calls] == [
        "pending-reset",
        "control-revoked",
    ]
    assert sent == [
        ("control-transition-ack", {"leaseEpoch": 2, "status": "applied"}, {
            "viewerId": "viewer-new",
            "leaseId": "lease-0000000000000002",
            "leaseEpoch": 2,
            "connectionGeneration": 2,
        }),
        ("control-transition-ack", {"leaseEpoch": 2, "status": "applied"}, None),
    ]


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
async def test_failed_keyboard_transition_rejects_with_safe_ack_and_clears_binding():
    sent = []

    async def emit(event, payload):
        sent.append((event, payload))

    class FailingInputHandler:
        async def reset_keyboard(self, **_kwargs):
            return {"status": "applied"}

        async def transition_keyboard(self, **_kwargs):
            return {"status": "execution-failed", "raw": "Secret keyboard failure"}

        def release_all_mouse_buttons(self, **_kwargs):
            return None

    host = object.__new__(WebRemoteHost)
    host._active_input_binding = {
        "viewerId": "viewer-old",
        "leaseId": "lease-0000000000000001",
        "leaseEpoch": 1,
        "connectionGeneration": 1,
    }
    host._connection_generation = 1
    host.input_handler = FailingInputHandler()
    host.sio = SimpleNamespace(emit=emit)

    await host.on_control_transition({
        "viewerId": "viewer-new",
        "leaseId": "lease-0000000000000002",
        "leaseEpoch": 2,
    })

    assert host._active_input_binding is None
    assert sent == [("control-transition-ack", {
        "leaseEpoch": 2,
        "status": "rejected",
        "reason": "reset-failed",
    })]
    assert "Secret" not in repr(sent)


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
async def test_late_offer_with_stale_attempt_sequence_is_ignored():
    """Tunnel bind with a newer sequence must not be clobbered by a late WebRTC offer."""
    host = object.__new__(WebRemoteHost)
    host.pc = None
    host._offer_epoch = 0
    host.current_viewer_id = 'viewer-1'
    host._offer_lock = __import__('asyncio').Lock()
    host._connection_generation = 3
    host._active_input_binding = {
        'viewerId': 'viewer-1',
        'leaseId': 'lease-000000000001',
        'leaseEpoch': 5,
        'connectionGeneration': 3,
        'connectionAttemptId': 'attempt-tunnel',
        'connectionAttemptSequence': 3,
    }
    host._media_activity_binding = {
        'viewerId': 'viewer-1',
        'connectionAttemptId': 'attempt-tunnel',
        'generation': 0,
        'state': 'active',
    }
    host.input_handler = type('IH', (), {
        'transition_keyboard': staticmethod(lambda **kwargs: (_ for _ in ()).throw(AssertionError('must not rebind'))),
    })()
    host.sio = type('S', (), {'emit': staticmethod(lambda *a, **k: None)})()
    host.screen_track = None
    host.media_sender = None
    host.relay_streamer = None
    host.pending_candidates = None
    host._input_datachannel = None

    closed = {'count': 0}
    async def fake_close(**kwargs):
        closed['count'] += 1
    host._close_peer_connection = fake_close

    await host.on_offer({
        'viewerId': 'viewer-1',
        'epoch': 9,
        'offer': {'type': 'offer', 'sdp': 'v=0'},
        'leaseId': 'lease-000000000001',
        'leaseEpoch': 5,
        'connectionAttemptId': 'attempt-old-webrtc',
        'connectionAttemptSequence': 1,
        'networkMode': 'auto',
    })

    assert closed['count'] == 0
    assert host._active_input_binding['connectionAttemptId'] == 'attempt-tunnel'
    assert host._active_input_binding['connectionAttemptSequence'] == 3
    assert host._media_activity_binding['connectionAttemptId'] == 'attempt-tunnel'


@pytest.mark.asyncio
async def test_tunnel_media_control_acks_only_after_producer_suspend_and_rejects_stale_attempt():
    events = []

    class FakeRelay:
        viewer_id = "viewer-1"
        production_generation = 1
        suspended = False
        frames_emitted = 0

        def set_suspended(self, suspended):
            self.suspended = bool(suspended)
            self.production_generation += 1
            if suspended:
                # producer stopped: no new frames after this generation bump
                return self.production_generation
            return self.production_generation

        async def start(self, *args, **kwargs):
            raise AssertionError("media control must not restart producer")

        async def stop(self):
            raise AssertionError("media control must not stop producer")

    class FakeSio:
        async def emit(self, event, payload):
            events.append((event, payload))

    host = object.__new__(WebRemoteHost)
    host.sio = FakeSio()
    host.relay_streamer = FakeRelay()
    host._active_input_binding = {
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 2,
        "connectionGeneration": 1,
        "connectionAttemptId": "attempt-B",
    }
    host._media_activity_binding = {
        "viewerId": "viewer-1",
        "connectionAttemptId": "attempt-B",
        "generation": 0,
        "state": "active",
    }
    host._media_activity_suspended = False
    host.input_handler = None
    host.screen_track = None
    host.media_sender = None
    host.pc = None

    # Stale attempt cannot stop current controller relay.
    await host.on_relay_stream_control({
        "schemaVersion": 2,
        "mediaControlSchemaVersion": 1,
        "enabled": False,
        "state": "suspended",
        "generation": 1,
        "connectionAttemptId": "attempt-A",
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 2,
    })
    assert host.relay_streamer.suspended is False
    assert events[-1][0] == "relay-stream-control-ack"
    assert events[-1][1]["applied"] is False
    assert events[-1][1]["reason"] == "wrong-attempt"
    assert "leaseId" not in events[-1][1]

    # Matching suspend applies only after producer set_suspended.
    await host.on_relay_stream_control({
        "schemaVersion": 2,
        "mediaControlSchemaVersion": 1,
        "enabled": False,
        "state": "suspended",
        "generation": 1,
        "connectionAttemptId": "attempt-B",
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 2,
    })
    assert host.relay_streamer.suspended is True
    assert host._media_activity_suspended is True
    assert events[-1][0] == "relay-stream-control-ack"
    assert events[-1][1]["applied"] is True
    assert events[-1][1]["state"] == "suspended"
    assert events[-1][1]["generation"] == 1
    assert events[-1][1]["connectionAttemptId"] == "attempt-B"
    assert "leaseId" not in events[-1][1]

    # Resume ack after producer resume.
    await host.on_relay_stream_control({
        "schemaVersion": 2,
        "mediaControlSchemaVersion": 1,
        "enabled": True,
        "state": "active",
        "generation": 2,
        "connectionAttemptId": "attempt-B",
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 2,
    })
    assert host.relay_streamer.suspended is False
    assert events[-1][1]["applied"] is True
    assert events[-1][1]["state"] == "active"
    assert events[-1][1]["generation"] == 2


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


@pytest.mark.asyncio
async def test_stale_v2_mouse_reset_releases_buttons_without_reentering_write_state():
    calls = []

    class FakeInputHandler:
        async def handle_input(self, _data):
            calls.append("handle_input")

        def release_all_mouse_buttons(self, **kwargs):
            calls.append(("release_all_mouse_buttons", kwargs))

    host = object.__new__(WebRemoteHost)
    host.current_viewer_id = "viewer-1"
    host._active_input_binding = {
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 2,
        "connectionGeneration": 1,
    }
    host.input_handler = FakeInputHandler()
    host.overlay = SimpleNamespace(send=lambda _payload: None)
    host.screen_track = None
    host.sio = None

    await host.on_input({
        "schemaVersion": 2,
        "type": "mouse",
        "action": "reset",
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000000",
        "leaseEpoch": 1,
        "inputIds": ["reset-stale"],
        "payload": {"reason": "lost-up"},
    })

    assert calls == [("release_all_mouse_buttons", {"reason": "stale-lease-safety"})]


@pytest.mark.asyncio
async def test_offer_rejects_binding_when_desktop_transition_fails(monkeypatch):
    transitions = []

    class FakeInputHandler:
        async def transition_keyboard(self, **kwargs):
            transitions.append(("keyboard", kwargs))
            return {"status": "applied"}

        def transition_desktop_writes(self, **kwargs):
            transitions.append(("desktop", kwargs))
            return SimpleNamespace(status="execution-failed")

    host = object.__new__(WebRemoteHost)
    host.current_viewer_id = None
    host._offer_epoch = 0
    host.pc = None
    host._offer_lock = asyncio.Lock()
    host._active_input_binding = None
    host._connection_generation = 0
    host.input_handler = FakeInputHandler()

    async def fake_close(**_kwargs):
        return None

    host._close_peer_connection = fake_close
    # The pre-fix path continues into WebRTC setup after keyboard binding. Keep
    # this test focused on the binding gate and avoid constructing a real PC.
    monkeypatch.setattr(
        host_module,
        "RTCPeerConnection",
        lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("stop after binding")),
    )

    await host.on_offer({
        "viewerId": "viewer-1",
        "epoch": 1,
        "leaseId": "lease-000000000001",
        "leaseEpoch": 2,
        "connectionAttemptId": "attempt-1",
        "offer": {"type": "offer", "sdp": "v=0"},
    })

    assert transitions == [
        (
            "keyboard",
            {
                "connection_generation": 1,
                "lease_id": "lease-000000000001",
                "lease_epoch": 2,
            },
        ),
        (
            "desktop",
            {
                "lease_id": "lease-000000000001",
                "lease_epoch": 2,
            },
        ),
    ]
    assert host._active_input_binding is None


@pytest.mark.asyncio
async def test_rejected_desktop_offer_cleans_up_keyboard_binding(monkeypatch):
    transitions = []
    resets = []

    class FakeInputHandler:
        def __init__(self):
            self.keyboard_bound = False

        async def transition_keyboard(self, **kwargs):
            transitions.append(("keyboard", kwargs))
            self.keyboard_bound = True
            return {"status": "applied"}

        def transition_desktop_writes(self, **kwargs):
            transitions.append(("desktop", kwargs))
            return SimpleNamespace(status="execution-failed")

        async def reset_keyboard(self, **kwargs):
            resets.append(kwargs)
            self.keyboard_bound = False
            return {"status": "applied"}

        def release_all_mouse_buttons(self, **_kwargs):
            return None

    host = object.__new__(WebRemoteHost)
    host.current_viewer_id = None
    host._offer_epoch = 0
    host.pc = None
    host._offer_lock = asyncio.Lock()
    host._active_input_binding = None
    host._connection_generation = 0
    host.input_handler = FakeInputHandler()

    async def fake_close(**_kwargs):
        return None

    host._close_peer_connection = fake_close
    monkeypatch.setattr(
        host_module,
        "RTCPeerConnection",
        lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("must reject before pc setup")),
    )

    await host.on_offer({
        "viewerId": "viewer-1",
        "epoch": 1,
        "leaseId": "lease-000000000001",
        "leaseEpoch": 2,
        "connectionAttemptId": "attempt-1",
        "offer": {"type": "offer", "sdp": "v=0"},
    })

    assert host.input_handler.keyboard_bound is False
    assert host._active_input_binding is None
    assert resets == [{"reason": "desktop-binding-rejected", "lease_epoch": 2}]


@pytest.mark.asyncio
async def test_successful_offer_transitions_desktop_writes_before_assigning_binding(monkeypatch):
    transitions = []

    class FakeInputHandler:
        async def transition_keyboard(self, **kwargs):
            transitions.append(("keyboard", kwargs))
            return {"status": "applied"}

        def transition_desktop_writes(self, **kwargs):
            transitions.append(("desktop", kwargs))
            return SimpleNamespace(status="applied")

    host = object.__new__(WebRemoteHost)
    host.current_viewer_id = None
    host._offer_epoch = 0
    host.pc = None
    host._offer_lock = asyncio.Lock()
    host._active_input_binding = None
    host._connection_generation = 0
    host.input_handler = FakeInputHandler()

    async def fake_close(**_kwargs):
        return None

    host._close_peer_connection = fake_close
    monkeypatch.setattr(
        host_module,
        "RTCPeerConnection",
        lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("stop after binding")),
    )

    await host.on_offer({
        "viewerId": "viewer-1",
        "epoch": 1,
        "leaseId": "lease-000000000001",
        "leaseEpoch": 2,
        "connectionAttemptId": "attempt-1",
        "offer": {"type": "offer", "sdp": "v=0"},
    })

    assert [name for name, _kwargs in transitions] == ["keyboard", "desktop"]
    assert host._active_input_binding == {
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 2,
        "connectionGeneration": 1,
        "connectionAttemptId": "attempt-1",
    }


@pytest.mark.asyncio
async def test_media_activity_rejects_old_connection_attempt_and_accepts_new_attempt_low_generation():
    host = object.__new__(WebRemoteHost)
    host._active_input_binding = {
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 3,
        "connectionGeneration": 2,
        "connectionAttemptId": "attempt-B",
    }
    host._media_activity_binding = {
        "viewerId": "viewer-1",
        "connectionAttemptId": "attempt-A",
        "generation": 50,
        "state": "active",
    }
    host._media_activity_suspended = False
    host._media_activity_lock = asyncio.Lock()
    host.input_handler = None
    host.media_sender = None
    host.pc = None
    host.screen_track = None
    host.tunnel_relay = None
    acks = []

    class FakeSio:
        async def emit(self, event, payload):
            acks.append((event, payload))

    host.sio = FakeSio()

    # Old attempt cannot suspend the new session.
    await host.on_media_activity_change({
        "schemaVersion": 1,
        "state": "suspended",
        "reasons": ["manual-pause"],
        "generation": 51,
        "connectionAttemptId": "attempt-A",
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 3,
    })
    assert acks[-1][1]["applied"] is False
    assert acks[-1][1]["reason"] == "wrong-attempt"
    assert host._media_activity_suspended is False

    # New attempt may restart generation from a small value.
    await host.on_media_activity_change({
        "schemaVersion": 1,
        "state": "suspended",
        "reasons": ["manual-pause"],
        "generation": 1,
        "connectionAttemptId": "attempt-B",
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 3,
    })
    assert acks[-1][1]["applied"] is True
    assert acks[-1][1]["connectionAttemptId"] == "attempt-B"
    assert acks[-1][1]["generation"] == 1
    assert host._media_activity_binding["connectionAttemptId"] == "attempt-B"
    assert host._media_activity_binding["generation"] == 1
    assert host._media_activity_suspended is True


@pytest.mark.asyncio
async def test_media_activity_rejects_stale_lease_and_generation():
    host = object.__new__(WebRemoteHost)
    host._active_input_binding = {
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 3,
        "connectionGeneration": 1,
        "connectionAttemptId": "wrd-1",
    }
    host._media_activity_binding = {
        "viewerId": "viewer-1",
        "connectionAttemptId": "wrd-1",
        "generation": 2,
        "state": "active",
    }
    host._media_activity_suspended = False
    host._media_activity_lock = asyncio.Lock()
    acks = []

    class FakeSio:
        async def emit(self, event, payload):
            acks.append((event, payload))

    host.sio = FakeSio()

    # Stale generation
    await host.on_media_activity_change({
        "schemaVersion": 1,
        "state": "suspended",
        "reasons": ["manual-pause"],
        "generation": 2,
        "connectionAttemptId": "wrd-1",
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 3,
    })
    assert acks[-1][0] == "media-activity-ack"
    assert acks[-1][1]["applied"] is False
    assert acks[-1][1]["reason"] == "stale-generation"
    assert "leaseId" not in acks[-1][1]

    # Wrong lease
    await host.on_media_activity_change({
        "schemaVersion": 1,
        "state": "suspended",
        "reasons": ["manual-pause"],
        "generation": 3,
        "connectionAttemptId": "wrd-1",
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000099",
        "leaseEpoch": 3,
    })
    assert acks[-1][1]["applied"] is False
    assert acks[-1][1]["reason"] == "stale-lease"

    # Valid newer generation
    await host.on_media_activity_change({
        "schemaVersion": 1,
        "state": "suspended",
        "reasons": ["manual-pause"],
        "generation": 3,
        "connectionAttemptId": "wrd-1",
        "viewerId": "viewer-1",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 3,
    })
    assert acks[-1][1]["applied"] is True
    assert acks[-1][1]["generation"] == 3
    assert host._media_activity_suspended is True
    assert host._media_activity_binding["generation"] == 3


@pytest.mark.asyncio
async def test_media_activity_rejects_read_only_viewer_without_touching_binding():
    host = object.__new__(WebRemoteHost)
    host._active_input_binding = {
        "viewerId": "controller",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 1,
        "connectionGeneration": 1,
    }
    host._media_activity_binding = None
    host._media_activity_suspended = False
    host._media_activity_lock = asyncio.Lock()
    acks = []

    class FakeSio:
        async def emit(self, event, payload):
            acks.append((event, payload))

    host.sio = FakeSio()
    await host.on_media_activity_change({
        "schemaVersion": 1,
        "state": "suspended",
        "reasons": ["manual-pause"],
        "generation": 1,
        "connectionAttemptId": "wrd-1",
        "viewerId": "readonly",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 1,
    })
    assert acks[-1][1]["applied"] is False
    assert acks[-1][1]["reason"] == "viewer-mismatch"
    assert host._media_activity_binding is None
