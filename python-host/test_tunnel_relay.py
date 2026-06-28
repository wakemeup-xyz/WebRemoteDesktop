import asyncio
from types import SimpleNamespace

import pytest

from host import TunnelRelayStreamer, select_capture_monitor


class FakeSio:
    def __init__(self):
        self.emits = []

    async def emit(self, event, data):
        self.emits.append((event, data))


@pytest.mark.asyncio
async def test_tunnel_relay_allows_multiple_frames_in_flight_before_waiting_for_ack():
    sio = FakeSio()
    relay = TunnelRelayStreamer(sio)
    relay.frame_id = 2
    relay.last_acked_frame_id = 0

    assert relay.max_in_flight_frames == 2
    assert relay.should_wait_for_ack() is False

    relay.frame_id = 3
    assert relay.should_wait_for_ack() is True

    relay.ack_event = asyncio.Event()
    relay.ack(2)
    assert relay.last_acked_frame_id == 2
    assert relay.ack_event.is_set() is True


def test_select_capture_monitor_skips_zero_sized_entries():
    monitor = select_capture_monitor([
        {"left": 0, "top": 0, "width": 0, "height": 0},
        {"left": 0, "top": 0, "width": 0, "height": 0},
        {"left": 10, "top": 20, "width": 1512, "height": 982},
    ])

    assert monitor == {"left": 10, "top": 20, "width": 1512, "height": 982}
