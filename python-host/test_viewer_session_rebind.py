"""Offline reconnect tests: no live Host, capture, network or native input."""

import asyncio
from copy import deepcopy
from types import SimpleNamespace

import pytest

import host as host_module
from host import WebRemoteHost
from remote_desktop_write_state import ReliableDesktopWriteState


def make_host():
    host = object.__new__(WebRemoteHost)
    host.current_viewer_id = "viewer-old"
    host._connection_generation = 4
    host._offer_epoch = 9
    host._offer_lock = asyncio.Lock()
    host._active_input_binding = {
        "viewerId": "viewer-old",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 7,
        "connectionGeneration": 4,
        "connectionAttemptId": "attempt-1",
        "connectionAttemptSequence": 3,
    }
    host._media_activity_binding = {
        "viewerId": "viewer-old",
        "connectionAttemptId": "attempt-1",
        "connectionAttemptSequence": 3,
        "generation": 12,
        "state": "suspended",
    }
    host.relay_streamer = SimpleNamespace(viewer_id="viewer-old", frame_id=17)
    host.pc = SimpleNamespace(connectionState="connected")
    host._input_datachannel = SimpleNamespace(label="input")
    host._input_move_datachannel = SimpleNamespace(label="input-move")
    host.screen_track = None
    host.overlay = SimpleNamespace(send=lambda _data: None)
    host.sio = None
    desktop = ReliableDesktopWriteState()
    desktop.transition(lease_id="lease-000000000001", lease_epoch=7)
    desktop.commit(1)
    desktop.commit(2)
    host.input_handler = SimpleNamespace(_desktop_writes=desktop)
    return host


def payload(**updates):
    return {
        "previousViewerId": "viewer-old",
        "viewerId": "viewer-new",
        "leaseId": "lease-000000000001",
        "leaseEpoch": 7,
        "connectionAttemptId": "attempt-1",
        "connectionAttemptSequence": 3,
        **updates,
    }


@pytest.mark.asyncio
async def test_rebind_preserves_peer_input_sequence_and_media_progress():
    host = make_host()
    peer, channel = host.pc, host._input_datachannel
    before = host.input_handler._desktop_writes.snapshot()
    captured = dict(host._active_input_binding)

    assert await host.on_viewer_session_rebind(payload()) == {"status": "applied"}

    assert host.current_viewer_id == "viewer-new"
    assert host._active_input_binding == {**captured, "viewerId": "viewer-new"}
    assert host._media_activity_binding == {
        "viewerId": "viewer-new", "connectionAttemptId": "attempt-1",
        "connectionAttemptSequence": 3, "generation": 12, "state": "suspended",
    }
    assert host.relay_streamer.viewer_id == "viewer-new"
    assert host.relay_streamer.frame_id == 17
    assert host.pc is peer and host._input_datachannel is channel
    assert host._connection_generation == 4 and host._offer_epoch == 9
    assert host.input_handler._desktop_writes.snapshot() == before
    assert host.input_handler._desktop_writes.commit(3).status == "applied"
    bound = host._prepare_bound_datachannel_input(captured, {
        "schemaVersion": 2, "type": "keyboard", "action": "key",
        "leaseId": captured["leaseId"], "leaseEpoch": 7,
        "seq": 9, "inputIds": ["test-input"], "payload": {},
    }, channel=channel)
    assert bound["viewerId"] == "viewer-new"
    assert bound["connectionGeneration"] == 4


@pytest.mark.asyncio
@pytest.mark.parametrize("updates", [
    {"previousViewerId": "viewer-unrelated"},
    {"viewerId": "viewer-old"},
    {"viewerId": ""},
    {"leaseId": "lease-000000000002"},
    {"leaseEpoch": 8},
    {"leaseEpoch": True},
    {"connectionAttemptId": "attempt-stale"},
    {"connectionAttemptId": None},
    {"connectionAttemptSequence": 2},
    {"connectionAttemptSequence": 4},
    {"connectionAttemptSequence": None},
])
async def test_rebind_rejects_unowned_identity_without_mutation(updates):
    host = make_host()
    binding, media = deepcopy(host._active_input_binding), deepcopy(host._media_activity_binding)
    before = host.input_handler._desktop_writes.snapshot()
    assert await host.on_viewer_session_rebind(payload(**updates)) == {"status": "rejected"}
    assert host._active_input_binding == binding
    assert host._media_activity_binding == media
    assert host.current_viewer_id == host.relay_streamer.viewer_id == "viewer-old"
    assert host.input_handler._desktop_writes.snapshot() == before


@pytest.mark.asyncio
@pytest.mark.parametrize("owner", ["peer", "media", "relay"])
async def test_rebind_does_not_move_another_viewers_resources(owner):
    host = make_host()
    if owner == "peer":
        host.current_viewer_id = "different-viewer"
    elif owner == "media":
        host._media_activity_binding["viewerId"] = "different-viewer"
    else:
        host.relay_streamer.viewer_id = "different-viewer"
    assert await host.on_viewer_session_rebind(payload()) == {"status": "rejected"}
    assert host._active_input_binding["viewerId"] == "viewer-old"


@pytest.mark.asyncio
async def test_regrant_uses_retained_media_attempt_without_resetting_sequence():
    host = make_host()
    del host._active_input_binding["connectionAttemptId"]
    del host._active_input_binding["connectionAttemptSequence"]
    assert await host.on_viewer_session_rebind(payload()) == {"status": "applied"}
    assert host.input_handler._desktop_writes.snapshot().last_applied_seq == 2


@pytest.mark.asyncio
async def test_socket_input_accepts_new_identity_and_rejects_old_identity():
    host = make_host()
    received = []

    async def apply_keyboard(data, **_kwargs):
        received.append(data["viewerId"])
        return {"inputIds": [], "status": "applied", "appliedSeq": 3}

    host.input_handler.apply_keyboard = apply_keyboard
    assert await host.on_viewer_session_rebind(payload()) == {"status": "applied"}
    data = {
        "schemaVersion": 2, "type": "keyboard", "action": "reset",
        "leaseId": "lease-000000000001", "leaseEpoch": 7,
        "seq": 3, "payload": {"reason": "transport-change"},
    }
    await host.on_input({**data, "viewerId": "viewer-new"})
    await host.on_input({**data, "viewerId": "viewer-old"})
    assert received == ["viewer-new"]


@pytest.mark.asyncio
async def test_rebind_waits_for_offer_then_rejects_replaced_attempt():
    host = make_host()
    await host._offer_lock.acquire()
    task = asyncio.create_task(host.on_viewer_session_rebind(payload()))
    await asyncio.sleep(0)
    assert not task.done()
    host._active_input_binding["connectionAttemptId"] = "new-attempt"
    host._media_activity_binding["connectionAttemptId"] = "new-attempt"
    host._offer_lock.release()
    assert await task == {"status": "rejected"}
    assert host._active_input_binding["viewerId"] == "viewer-old"


@pytest.mark.asyncio
@pytest.mark.parametrize("tunnel_control", [False, True])
async def test_rebind_waits_for_media_write_and_preserves_attempt_sequence(tunnel_control):
    host = make_host()
    entered, release = asyncio.Event(), asyncio.Event()

    async def stop_relay():
        entered.set()
        await release.wait()

    host.relay_streamer.enabled = True
    host.relay_streamer.stop = stop_relay
    host.media_sender = SimpleNamespace(suspend=lambda: True)
    host.input_handler.release_all_mouse_buttons = lambda **_kwargs: None
    host.input_handler.release_all_keys = lambda **_kwargs: None
    # Exercise retention from media progress after a lease re-grant has
    # replaced the input binding on the same peer.
    del host._active_input_binding["connectionAttemptId"]
    del host._active_input_binding["connectionAttemptSequence"]
    request = {
        "schemaVersion": 1,
        "mediaControlSchemaVersion": 1,
        "state": "suspended", "generation": 13,
        "viewerId": "viewer-old", "connectionAttemptId": "attempt-1",
        "leaseId": "lease-000000000001", "leaseEpoch": 7,
    }
    handler = host.on_relay_stream_control if tunnel_control else host.on_media_activity_change
    activity = asyncio.create_task(handler(request))
    await entered.wait()
    rebind = asyncio.create_task(host.on_viewer_session_rebind(payload()))
    await asyncio.sleep(0)
    assert not rebind.done()
    release.set()
    await activity
    assert await rebind == {"status": "applied"}
    assert host._media_activity_binding["viewerId"] == "viewer-new"
    assert host._media_activity_binding["generation"] == 13
    assert host._media_activity_binding["connectionAttemptSequence"] == 3
    assert host.input_handler._desktop_writes.snapshot().last_applied_seq == 2


@pytest.mark.asyncio
async def test_rebind_handler_is_registered_only_on_host_signaling_client(monkeypatch):
    registered = {}
    client = SimpleNamespace(on=lambda event, handler: registered.setdefault(event, handler))
    monkeypatch.setattr(host_module.socketio, "AsyncClient", lambda **_kwargs: client)
    host = make_host()
    assert host._build_socket_client() is client
    host.sio = client
    assert await registered["viewer-session-rebind"](payload()) == {"status": "applied"}
    host.sio = object()
    assert await registered["viewer-session-rebind"](payload()) == {"status": "rejected"}
