from __future__ import annotations

import importlib.util
import struct
import sys
from pathlib import Path

import pytest


def _module():
    path = Path(__file__).with_name("turn_gateway.py")
    spec = importlib.util.spec_from_file_location("turn_gateway", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _rtp(sequence: int, *, ssrc: int = 7, payload_type: int = 96) -> bytes:
    return bytes((0x80, payload_type)) + struct.pack("!HII", sequence, 1, ssrc) + b"x"


def _channel(channel: int, body: bytes) -> bytes:
    return struct.pack("!HH", channel, len(body)) + body + b"\0" * ((-len(body)) % 4)


def test_gateway_allocates_distinct_unconnected_upstreams_for_three_clients():
    gateway = _module()
    table = gateway.ClientMappingTable(max_clients=3)
    mappings = [table.bind(("127.0.0.1", 41000 + number)) for number in range(3)]
    assert len({mapping.upstream_id for mapping in mappings}) == 3
    assert all(not mapping.upstream_connected for mapping in mappings)
    with pytest.raises(gateway.GatewayBlocked):
        table.bind(("127.0.0.1", 41003))


def test_gateway_drops_only_confirmed_channel_video_and_forwards_control_bytes():
    gateway = _module()
    state = gateway.GatewayMediaState()
    state.confirm_channel(client_id="viewer", channel_number=0x4001, peer=("127.0.0.1", 51002))
    state.seal_target(client_id="viewer", channel_number=0x4001, payload_type=96, ssrc=7)
    state.arm("all_for_200ms", now_ns=1)
    assert state.decide(client_id="viewer", payload=_channel(0x4001, _rtp(1)), now_ns=2).drop is True
    stun = b"\x01\x03" + b"\0" * 18
    result = state.decide(client_id="viewer", payload=stun, now_ns=2)
    assert result.drop is False and result.payload == stun


def test_gateway_refuses_to_seal_an_unconfirmed_channel():
    gateway = _module()
    state = gateway.GatewayMediaState()
    with pytest.raises(gateway.GatewayBlocked):
        state.seal_target(client_id="viewer", channel_number=0x4001, payload_type=96, ssrc=7)


def test_gateway_disconnect_clears_an_armed_loss_rule():
    gateway = _module()
    state = gateway.GatewayMediaState()
    state.arm("every_100th_for_30s", now_ns=1)
    state.clear_on_control_disconnect()
    assert state.armed is None
