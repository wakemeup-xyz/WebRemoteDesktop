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


def test_tunnel_relay_blocks_capture_when_inflight_window_is_full():
    sio = FakeSio()
    relay = TunnelRelayStreamer(sio)
    relay.inflight_frames = {
        1: {"sent_at_ms": 1000.0},
        2: {"sent_at_ms": 2000.0},
    }
    relay.max_in_flight_frames = 2

    assert relay.should_wait_before_capture() is True

    relay.inflight_frames.pop(1)

    assert relay.should_wait_before_capture() is False


def test_tunnel_relay_downshifts_and_recovers_from_ack_feedback():
    sio = FakeSio()
    relay = TunnelRelayStreamer(sio)

    assert relay.profile_name == "medium"
    assert relay.jpeg_quality == 26

    relay.ack(1, latency_ms=1500)
    assert relay.profile_name == "low"
    assert relay.max_in_flight_frames == 1

    relay.ack(2, latency_ms=1500)
    assert relay.profile_name == "survival"
    assert relay.jpeg_quality == 18

    relay.good_ack_streak = 3
    relay.ack(3, latency_ms=180)

    assert relay.profile_name == "low"


def test_tunnel_relay_initial_profile_never_starts_on_high():
    sio = FakeSio()
    relay = TunnelRelayStreamer(sio)

    assert relay._pick_initial_profile(1280, 720, 8) == "medium"
    assert relay._pick_initial_profile(960, 540, 6) == "medium"
    assert relay._pick_initial_profile(854, 480, 4) == "low"
    assert relay._pick_initial_profile(640, 360, 2) == "survival"
    assert relay._pick_initial_profile(1920, 1080, 30) == "medium"


def test_tunnel_relay_step_up_caps_at_medium():
    sio = FakeSio()
    relay = TunnelRelayStreamer(sio)
    relay._apply_profile("low", reason="test", log=False)

    relay.good_ack_streak = 3
    relay.ack(10, latency_ms=50)
    assert relay.profile_name == "medium"

    relay.good_ack_streak = 3
    relay.ack(11, latency_ms=20)
    assert relay.profile_name == "medium"


def test_select_capture_monitor_skips_zero_sized_entries():
    monitor = select_capture_monitor([
        {"left": 0, "top": 0, "width": 0, "height": 0},
        {"left": 0, "top": 0, "width": 0, "height": 0},
        {"left": 10, "top": 20, "width": 1512, "height": 982},
    ])

    assert monitor == {"left": 10, "top": 20, "width": 1512, "height": 982}


def test_select_capture_monitor_falls_back_to_screeninfo_when_mss_is_zero_sized():
    monitor = select_capture_monitor(
        [
            {"left": 0, "top": 0, "width": 0, "height": 0},
        ],
        fallback_monitors=[
            SimpleNamespace(x=32, y=64, width=1728, height=1117),
        ],
    )

    assert monitor == {"left": 32, "top": 64, "width": 1728, "height": 1117}


def test_tunnel_relay_suspend_blocks_production():
    sio = FakeSio()
    relay = TunnelRelayStreamer(sio)
    relay.enabled = True
    relay.viewer_id = "viewer-1"
    relay.inflight_frames = {1: {"sent_at_ms": 1.0}}
    gen = relay.set_suspended(True)
    assert relay.suspended is True
    assert relay.inflight_frames == {}
    assert gen >= 1
    # running property reflects suspension
    assert relay.running is False
    relay.set_suspended(False)
    assert relay.suspended is False
