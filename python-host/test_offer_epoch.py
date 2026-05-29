from types import SimpleNamespace

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
    host.input_handler = SimpleNamespace(release_all_keys=lambda reason: None)
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
