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

    class BlockingInputHandler(_AuthorityInputHandler):
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

    host = _authority_host(epoch=1)
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
async def test_same_epoch_grant_to_reset_is_rejected():
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

    assert host._active_input_binding == binding
    assert host._connection_generation == 4
    assert host.input_handler.pressed_key_count == 1
    assert host.input_handler.reset_calls == []
    assert sent == []


@pytest.mark.asyncio
async def test_grant_and_new_epoch_revoke_are_serialized_without_late_rebind():
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
        "leaseEpoch": 3,
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
        ("control-transition-ack", {"leaseEpoch": 3, "status": "applied"}, None),
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


class _AuthorityInputHandler:
    async def reset_keyboard(self, **kwargs):
        return {"status": "applied"}
    async def transition_keyboard(self, **kwargs):
        return {"status": "applied"}
    def transition_desktop_writes(self, **kwargs):
        return SimpleNamespace(status="applied")
    def release_all_mouse_buttons(self, **kwargs):
        pass


def _authority_host(epoch=7):
    """No native input/capture: the lifecycle handlers remain real."""
    host = object.__new__(WebRemoteHost)
    host.current_viewer_id = "viewer-a"
    host._active_input_binding = {"viewerId": "viewer-a", "leaseId": "lease-0000000000000001", "leaseEpoch": epoch, "connectionGeneration": 1}
    host._connection_generation = 1
    host._offer_epoch = 0
    host._offer_lock = asyncio.Lock()
    host.pc = host.screen_track = host.video_sender = host.relay_streamer = None
    host.pending_candidates = []
    host._media_activity_binding = None
    host._media_activity_suspended = False
    host.overlay = SimpleNamespace(send=lambda _payload: None)
    events = []
    async def emit(event, payload):
        events.append((event, payload))
    host.input_handler = _AuthorityInputHandler()
    host.sio = SimpleNamespace(emit=emit, events=events)
    return host


@pytest.mark.asyncio
async def test_old_offer_close_cannot_restore_authority_after_reset_and_grant(monkeypatch):
    host = _authority_host()
    entered, release = asyncio.Event(), asyncio.Event()
    class Peer:
        connectionState = "connected"
        async def close(self):
            entered.set()
            await release.wait()
    old_pc = host.pc = Peer()
    monkeypatch.setattr(host_module, "RTCPeerConnection", lambda **kw: pytest.fail("stale offer constructed PC"))
    pending = asyncio.create_task(host.on_offer({
        "viewerId": "viewer-a", "epoch": 1, "leaseId": "lease-0000000000000001", "leaseEpoch": 7,
        "connectionAttemptId": "attempt-old", "offer": {"type": "offer", "sdp": "v=0"},
    }))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        await host.on_control_transition({"leaseEpoch": 8})
        await host.on_control_transition({"viewerId": "viewer-b", "leaseId": "lease-0000000000000002", "leaseEpoch": 9})
    finally:
        release.set()
        await pending
    assert host._active_input_binding["leaseEpoch"] == 9
    assert host.current_viewer_id == "viewer-b"
    assert host.pc is not old_pc
    assert not any(e == "answer" for e, _ in host.sio.events)


def _mock_media_construction(monkeypatch, host):
    peers = []
    class Peer:
        connectionState = "connected"
        iceGatheringState = "complete"
        def __init__(self, **kwargs):
            self.handlers, self.candidates = {}, []
            self.closed = 0
            peers.append(self)
        def on(self, event):
            def register(fn):
                self.handlers[event] = fn
                return fn
            return register
        def addTrack(self, track):
            sender = SimpleNamespace(track=track)
            sender.replaceTrack = lambda replacement: setattr(sender, "track", replacement)
            return sender
        def getTransceivers(self):
            return []
        async def setRemoteDescription(self, description):
            pass
        async def createAnswer(self):
            return SimpleNamespace(sdp="v=0", type="answer")
        async def setLocalDescription(self, description):
            self.localDescription = description
            self.handlers["icegatheringstatechange"]()
        async def addIceCandidate(self, candidate):
            self.candidates.append(candidate)
        async def close(self):
            self.closed += 1
    class Track:
        def __init__(self):
            self.suspended = False
        def set_suspended(self, suspended):
            self.suspended = bool(suspended)
            return 0
        async def shutdown(self):
            pass
    monkeypatch.setattr(host_module, "RTCPeerConnection", Peer)
    host._frame_trace_registry = None
    host._user_resolution = {}
    host._h264_policy_provider = SimpleNamespace(current_policy=lambda: None)
    host._frame_trace_context_for_policy = lambda policy: None
    host._host_turn_capability = lambda *args: {}
    host._bind_session_presentation = lambda data: None
    host._create_screen_track = Track
    return peers


def _offer(viewer="viewer-a", epoch=7, lease="lease-0000000000000001", attempt="attempt-a"):
    return {"viewerId": viewer, "leaseEpoch": epoch, "leaseId": lease, "epoch": 1,
            "connectionAttemptId": attempt, "connectionAttemptSequence": 1,
            "offer": {"type": "offer", "sdp": "v=0"}}


@pytest.mark.asyncio
async def test_initial_attempt_bind_then_offer_starts_media_without_resume_request(monkeypatch):
    # A fresh visible Viewer has active/generation 0 and sends no resume request.
    host = _authority_host()
    _mock_media_construction(monkeypatch, host)

    await host.on_connection_attempt_bind({**_offer(), "networkMode": "relay"})
    await host.on_offer(_offer())

    assert any(event == "answer" for event, _ in host.sio.events)
    assert host.screen_track.suspended is False
    assert host.video_sender.track is host.screen_track
    assert host._media_activity_suspended is False


@pytest.mark.asyncio
async def test_attempt_replacement_keeps_old_resources_frozen_but_starts_new_media(monkeypatch):
    host = _authority_host()
    peers = _mock_media_construction(monkeypatch, host)
    await host.on_offer(_offer())
    old_track, old_sender = host.screen_track, host.video_sender
    relay = SimpleNamespace(suspended=False)
    relay.set_suspended = lambda value: setattr(relay, "suspended", value)
    host.relay_streamer = relay
    replacement = {**_offer(attempt="attempt-b"), "epoch": 2,
                   "connectionAttemptSequence": 2, "networkMode": "relay"}

    await host.on_connection_attempt_bind(replacement)
    assert old_track.suspended is True
    assert old_sender.track is None
    assert relay.suspended is True
    await host.on_offer(replacement)

    assert peers[0].closed == 1
    assert old_track.suspended is True
    assert old_sender.track is None
    assert relay.suspended is True
    assert host.screen_track is not old_track
    assert host.screen_track.suspended is False
    assert host.video_sender.track is host.screen_track


@pytest.mark.asyncio
@pytest.mark.parametrize("reason", ["manual-pause", "terminal-active"])
async def test_explicit_pause_between_attempt_bind_and_offer_remains_suspended(monkeypatch, reason):
    host = _authority_host()
    _mock_media_construction(monkeypatch, host)
    bind = {**_offer(), "networkMode": "relay"}
    await host.on_connection_attempt_bind(bind)
    await host.on_media_activity_change({
        **bind, "schemaVersion": 1, "state": "suspended",
        "reasons": [reason], "generation": 1,
    })
    assert host.sio.events[-1][1]["applied"] is True
    # Reasserting the same bind must not erase an explicit pause.
    await host.on_connection_attempt_bind(bind)
    await host.on_offer(_offer())

    assert host.screen_track.suspended is True
    assert host.video_sender.track is None
    assert host._media_activity_suspended is True


@pytest.mark.asyncio
async def test_explicit_pause_during_offer_sdp_remains_suspended_at_commit(monkeypatch):
    host = _authority_host()
    _mock_media_construction(monkeypatch, host)
    entered, release = asyncio.Event(), asyncio.Event()
    async def remote_description(self, description):
        entered.set()
        await release.wait()
    monkeypatch.setattr(host_module.RTCPeerConnection, "setRemoteDescription", remote_description)
    await host.on_connection_attempt_bind({**_offer(), "networkMode": "relay"})
    pending = asyncio.create_task(host.on_offer(_offer()))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        await host.on_media_activity_change({
            **_offer(), "schemaVersion": 1, "state": "suspended",
            "reasons": ["manual-pause"], "generation": 1,
        })
        assert host.sio.events[-1][1]["applied"] is True
    finally:
        release.set()
        await pending

    assert host.screen_track.suspended is True
    assert host.video_sender.track is None
    assert host._media_activity_suspended is True


@pytest.mark.asyncio
async def test_rejected_rebind_reset_fresh_grant_replaces_peer_and_allows_next_rebind(monkeypatch):
    host = _authority_host()
    peers = _mock_media_construction(monkeypatch, host)
    await host.on_offer(_offer())
    old_pc = host.pc
    assert old_pc is peers[0]
    assert await host.on_viewer_session_rebind({
        "previousViewerId": "viewer-a", "viewerId": "viewer-b", "leaseId": "lease-0000000000000001",
        "leaseEpoch": 7, "connectionAttemptId": "wrong-attempt", "connectionAttemptSequence": 1,
    }) == {"status": "rejected"}
    await host.on_control_transition({"leaseEpoch": 8})
    await host.on_control_transition({"viewerId": "viewer-b", "leaseId": "lease-0000000000000002", "leaseEpoch": 9})
    assert old_pc.closed == 1
    await host.on_offer(_offer("viewer-b", 9, "lease-0000000000000002", "attempt-b"))
    new_pc = host.pc
    assert new_pc is peers[1]
    await host.on_ice_candidate({"from": "viewer-b", "candidate": {"candidate": "candidate:1 1 UDP 1 127.0.0.1 12345 typ host"}})
    assert len(new_pc.candidates) == 1
    assert await host.on_viewer_session_rebind({
        "previousViewerId": "viewer-b", "viewerId": "viewer-c", "leaseId": "lease-0000000000000002",
        "leaseEpoch": 9, "connectionAttemptId": "attempt-b", "connectionAttemptSequence": 1,
    }) == {"status": "applied"}
    assert host.pc is new_pc and new_pc.closed == 0
    assert host.pc._wrd_owner == ("viewer-c", "lease-0000000000000002", 9)
    assert host.current_viewer_id == host._active_input_binding["viewerId"] == "viewer-c"


@pytest.mark.asyncio
async def test_disconnect_new_authenticated_connection_resets_epoch_namespace(monkeypatch):
    host = _authority_host(epoch=20)
    entered, release = asyncio.Event(), asyncio.Event()
    class Peer:
        connectionState = "connected"
        async def close(self):
            entered.set()
            await release.wait()
    host.pc = Peer()
    monkeypatch.setattr(host_module, "RTCPeerConnection", lambda **kw: pytest.fail("old connection created PC"))
    pending = asyncio.create_task(host.on_offer(_offer(epoch=20)))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        await host.on_disconnect()
        disconnected_revision = host._authority_revision
        await host.on_connected({"role": "host", "status": "ok"})
        await host.on_control_transition({"viewerId": "viewer-b", "leaseId": "lease-0000000000000002", "leaseEpoch": 1})
    finally:
        release.set()
        await pending
    assert host._authority_revision > disconnected_revision
    assert host._active_input_binding["leaseEpoch"] == 1
    assert host.current_viewer_id == "viewer-b"
    assert not any(e == "answer" for e, _ in host.sio.events)


@pytest.mark.asyncio
async def test_completed_reset_retry_is_idempotent_and_lower_epochs_stay_stale():
    host = _authority_host()
    count = 0
    reset = host.input_handler.reset_keyboard
    async def counted(**kwargs):
        nonlocal count
        count += 1
        return await reset(**kwargs)
    host.input_handler.reset_keyboard = counted
    await host.on_control_transition({"leaseEpoch": 8})
    await host.on_control_transition({"leaseEpoch": 8})
    await host.on_control_transition({"viewerId": "viewer-a", "leaseId": "lease-0000000000000001", "leaseEpoch": 7})
    await host.on_control_transition({"viewerId": "viewer-a", "leaseId": "lease-0000000000000001", "leaseEpoch": 8})
    assert count == 1
    assert host._active_input_binding is None
    assert host.sio.events == [("control-transition-ack", {"leaseEpoch": 8, "status": "applied"})] * 2


@pytest.mark.asyncio
async def test_failed_reset_retries_native_reset_at_same_epoch():
    host = _authority_host()
    results = iter([{"status": "execution-failed"}, {"status": "applied"}])
    async def reset(**kwargs):
        return next(results)
    host.input_handler.reset_keyboard = reset
    await host.on_control_transition({"leaseEpoch": 8})
    await host.on_control_transition({"leaseEpoch": 8})
    assert [data["status"] for event, data in host.sio.events] == ["rejected", "applied"]


@pytest.mark.asyncio
async def test_inflight_adapter_bind_drains_before_reset_and_cannot_rebind_new_scope(monkeypatch):
    host = _authority_host()
    entered, release, reset_requested = asyncio.Event(), asyncio.Event(), asyncio.Event()
    state = {"lease": None}
    original_bind = host.input_handler.transition_keyboard
    async def bind(**kwargs):
        if kwargs["lease_epoch"] == 7:
            entered.set()
            await release.wait()
        state["lease"] = kwargs["lease_epoch"]
        return await original_bind(**kwargs)
    async def reset(**kwargs):
        state["lease"] = None
        return {"status": "applied"}
    host.input_handler.transition_keyboard = bind
    host.input_handler.reset_keyboard = reset
    original_reset = host._reset_keyboard_lifecycle
    async def observe_reset(*args, **kwargs):
        if args[0] == "new-reset":
            reset_requested.set()
        return await original_reset(*args, **kwargs)
    host._reset_keyboard_lifecycle = observe_reset
    monkeypatch.setattr(host_module, "RTCPeerConnection", lambda **kw: pytest.fail("stale binding constructed PC"))
    offer = asyncio.create_task(host.on_offer(_offer()))
    await asyncio.wait_for(entered.wait(), 1)
    transition = asyncio.create_task(host.on_control_transition({"leaseEpoch": 8, "reason": "new-reset"}))
    try:
        await asyncio.wait_for(reset_requested.wait(), 1)
        assert not transition.done()
    finally:
        release.set()
        await asyncio.gather(offer, transition)
    await host.on_control_transition({"viewerId": "viewer-b", "leaseId": "lease-0000000000000002", "leaseEpoch": 9})
    assert state["lease"] == host._active_input_binding["leaseEpoch"] == 9


@pytest.mark.asyncio
async def test_candidate_sdp_completion_closes_only_candidate_after_new_grant(monkeypatch):
    host = _authority_host()
    peers = _mock_media_construction(monkeypatch, host)
    entered, release = asyncio.Event(), asyncio.Event()
    peer_type = host_module.RTCPeerConnection
    async def remote(self, description):
        entered.set()
        await release.wait()
    monkeypatch.setattr(peer_type, "setRemoteDescription", remote)
    pending = asyncio.create_task(host.on_offer(_offer()))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        assert host.pc is None  # The uncommitted SDP candidate is local.
        await host.on_control_transition({"leaseEpoch": 8})
        await host.on_control_transition({"viewerId": "viewer-b", "leaseId": "lease-0000000000000002", "leaseEpoch": 9})
    finally:
        release.set()
        await pending
    assert peers[0].closed == 1
    assert host.pc is None
    assert host._active_input_binding["leaseEpoch"] == 9
    assert host.current_viewer_id == "viewer-b"
    assert not any(event == "answer" for event, data in host.sio.events)


@pytest.mark.asyncio
async def test_track_shutdown_completion_cannot_clear_new_recovery_resources():
    host = _authority_host()
    entered, release = asyncio.Event(), asyncio.Event()
    class Track:
        async def shutdown(self):
            entered.set()
            await release.wait()
    host.screen_track = Track()
    pending = asyncio.create_task(host._close_peer_connection())
    try:
        await asyncio.wait_for(entered.wait(), 1)
        await host.on_control_transition({"viewerId": "viewer-b", "leaseId": "lease-0000000000000002", "leaseEpoch": 9})
        host._keyframe_recovery_state = {"new": True}
        host._frame_trace_context = object()
        context = host._frame_trace_context
    finally:
        release.set()
        await pending
    assert host._keyframe_recovery_state == {"new": True}
    assert host._frame_trace_context is context


@pytest.mark.asyncio
async def test_current_connection_grant_waits_for_authenticated_reset():
    host = _authority_host(epoch=20)
    entered, release, grant_entered = asyncio.Event(), asyncio.Event(), asyncio.Event()
    original = host.input_handler.reset_keyboard
    async def reset(**kwargs):
        if kwargs.get("reason") == "signal-connected":
            entered.set()
            await release.wait()
        return await original(**kwargs)
    host.input_handler.reset_keyboard = reset
    connected = asyncio.create_task(host.on_connected({"role": "host", "status": "ok"}))
    await asyncio.wait_for(entered.wait(), 1)
    async def grant():
        grant_entered.set()
        await host.on_control_transition({"viewerId": "viewer-b", "leaseId": "lease-0000000000000002", "leaseEpoch": 1})
    pending = asyncio.create_task(grant())
    try:
        await asyncio.wait_for(grant_entered.wait(), 1)
        assert host._active_input_binding is None
        assert host.sio.events == []
    finally:
        release.set()
        await asyncio.gather(connected, pending)
    assert host._active_input_binding["leaseEpoch"] == 1
    assert host._active_input_binding["viewerId"] == "viewer-b"
    assert host.sio.events == [("control-transition-ack", {"leaseEpoch": 1, "status": "applied"})]


@pytest.mark.asyncio
async def test_failed_authenticated_reset_is_retried_by_current_control_transition():
    host = _authority_host(epoch=20)
    calls = []
    async def reset(**kwargs):
        calls.append(kwargs["reason"])
        return {"status": "execution-failed" if len(calls) == 1 else "applied"}
    host.input_handler.reset_keyboard = reset
    await host.on_connected({"role": "host", "status": "ok"})
    assert host._signal_ready is False
    assert host._active_input_binding is None
    await host.on_control_transition({"viewerId": "viewer-b", "leaseId": "lease-0000000000000002", "leaseEpoch": 1})
    assert host._signal_ready is True
    assert host._active_input_binding["leaseEpoch"] == 1
    assert calls == ["signal-connected", "signal-connected", "pending-reset"]


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy", [False, True])
async def test_reset_invalidates_real_relay_start_before_producer_creation(monkeypatch, legacy):
    host = _authority_host()
    host._active_input_binding.update(connectionAttemptId="attempt-a", connectionAttemptSequence=1)
    relay = host.relay_streamer = host_module.TunnelRelayStreamer(host.sio)
    entered, release = asyncio.Event(), asyncio.Event()
    producer_runs = []
    async def no_capture_run():
        producer_runs.append(relay.viewer_id)
    monkeypatch.setattr(relay, "_run", no_capture_run)
    stop = relay.stop
    first = True
    async def paused_stop():
        nonlocal first
        result = await stop()
        if first:
            first = False
            entered.set()
            await release.wait()
        return result
    monkeypatch.setattr(relay, "stop", paused_stop)
    request = {
        "schemaVersion": 2, "mediaControlSchemaVersion": 1, "enabled": True,
        "state": "active", "generation": 1, "connectionAttemptId": "attempt-a",
        "viewerId": "viewer-a", "leaseId": "lease-0000000000000001", "leaseEpoch": 7,
    }
    if legacy:
        request = {"enabled": True, "viewerId": "viewer-a"}
    pending = asyncio.create_task(host.on_relay_stream_control(request))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        await host.on_control_transition({"leaseEpoch": 8})
        await host.on_control_transition({"viewerId": "viewer-b", "leaseId": "lease-0000000000000002", "leaseEpoch": 9})
    finally:
        release.set()
        await pending
        if relay.task:
            await relay.task
    assert relay.enabled is False
    assert producer_runs == []
    assert host._active_input_binding["viewerId"] == "viewer-b"
    assert host._media_activity_binding is None
    assert not any(event == "relay-stream-control-ack" and data.get("applied") for event, data in host.sio.events)


@pytest.mark.asyncio
async def test_failed_initialization_retry_stays_blocked_and_rejects_until_reset_succeeds():
    host = _authority_host(epoch=20)
    async def reset(**kwargs):
        return {"status": "execution-failed"}
    host.input_handler.reset_keyboard = reset
    await host.on_connected({"role": "host", "status": "ok"})
    await host.on_control_transition({"viewerId": "viewer-b", "leaseId": "lease-0000000000000002", "leaseEpoch": 1})
    assert host._signal_ready is False
    assert host._active_input_binding is None
    assert host.sio.events == [("control-transition-ack", {"leaseEpoch": 1, "status": "rejected", "reason": "initialization-reset-failed"})]


@pytest.mark.asyncio
async def test_disconnected_connection_cannot_retry_initialization_without_authentication():
    host = _authority_host()
    await host.on_connected({"role": "host", "status": "ok"})
    await host.on_disconnect()
    await host.on_control_transition({"viewerId": "viewer-b", "leaseId": "lease-0000000000000002", "leaseEpoch": 1})
    assert host._signal_ready is False
    assert host._active_input_binding is None
    assert not any(data.get("status") == "applied" for event, data in host.sio.events)


@pytest.mark.asyncio
async def test_old_relay_stop_completion_does_not_clear_replacement_producer(monkeypatch):
    relay = host_module.TunnelRelayStreamer(SimpleNamespace())
    old_running, cancelled, release, new_running = (asyncio.Event() for _ in range(4))
    runs = 0
    async def no_capture_run():
        nonlocal runs
        runs += 1
        if runs == 1:
            old_running.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                await release.wait()
        else:
            new_running.set()
            await asyncio.Event().wait()
    monkeypatch.setattr(relay, "_run", no_capture_run)
    await relay.start("viewer-a")
    await asyncio.wait_for(old_running.wait(), 1)
    stopping = asyncio.create_task(relay.stop())
    try:
        await asyncio.wait_for(cancelled.wait(), 1)
        await relay.start("viewer-b")
        await asyncio.wait_for(new_running.wait(), 1)
        current_task = relay.task
    finally:
        release.set()
        await stopping
    try:
        assert relay.enabled is True
        assert relay.viewer_id == "viewer-b"
        assert relay.task is current_task
        assert not current_task.done()
    finally:
        await relay.stop()


@pytest.mark.asyncio
async def test_trusted_reset_stops_actual_old_relay_after_viewer_index_migration():
    host = _authority_host()
    stopped = []
    class Relay:
        viewer_id = "viewer-a"
        async def stop(self):
            stopped.append(self.viewer_id)
    host.relay_streamer = Relay()
    # Signal moved its index to B, but rejected rebind leaves A's producer.
    host.current_viewer_id = "viewer-b"
    await host.on_control_transition({"leaseEpoch": 8, "reason": "rebind-rejected"})
    assert stopped == ["viewer-a"]
    assert host.relay_streamer is None
    assert host.sio.events[-1] == ("control-transition-ack", {"leaseEpoch": 8, "status": "applied"})


@pytest.mark.asyncio
async def test_trusted_reset_old_stop_completion_cannot_clear_new_relay_or_ack():
    host = _authority_host()
    entered, release = asyncio.Event(), asyncio.Event()
    class Relay:
        viewer_id = "viewer-a"
        async def stop(self):
            entered.set()
            await release.wait()
    host.relay_streamer = Relay()
    reset = asyncio.create_task(host.on_control_transition({"leaseEpoch": 8, "reason": "rebind-rejected"}))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        host._advance_authority()
        current = SimpleNamespace(viewer_id="viewer-b")
        host.relay_streamer = current
    finally:
        release.set()
        await reset
    assert host.relay_streamer is current
    assert not any(event == "control-transition-ack" and data["status"] == "applied"
                   for event, data in host.sio.events)


@pytest.mark.asyncio
async def test_trusted_reset_freezes_old_producer_before_waiting_for_input_reset():
    host = _authority_host()
    reset_entered, release = asyncio.Event(), asyncio.Event()
    stopped = []
    class Relay:
        viewer_id = "viewer-a"
        async def stop(self):
            stopped.append(self.viewer_id)
    host.relay_streamer = Relay()
    original_reset = host._reset_keyboard_lifecycle
    async def delayed_reset(reason):
        reset_entered.set()
        await release.wait()
        return await original_reset(reason)
    host._reset_keyboard_lifecycle = delayed_reset
    reset = asyncio.create_task(host.on_control_transition({"leaseEpoch": 8, "reason": "rebind-timeout"}))
    try:
        await asyncio.wait_for(reset_entered.wait(), 1)
        assert stopped == ["viewer-a"]
        assert host.relay_streamer is None
    finally:
        release.set()
        await reset
