from __future__ import annotations

import importlib.util
import json
import socket
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


def _attr(kind: int, value: bytes) -> bytes:
    return struct.pack("!HH", kind, len(value)) + value + b"\0" * ((-len(value)) % 4)


def _stun(kind: int, txid: bytes, attrs: bytes = b"") -> bytes:
    return struct.pack("!HHI", kind, len(attrs), 0x2112A442) + txid + attrs


def _xor_endpoint(host: bytes, port: int) -> bytes:
    return b"\0\x01" + struct.pack("!H", port ^ 0x2112) + bytes(value ^ mask for value, mask in zip(host, b"\x21\x12\xa4\x42"))


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


def test_gateway_baseline_mode_counts_only_the_sealed_video_without_dropping():
    gateway = _module()
    state = gateway.GatewayMediaState()
    state.confirm_channel(client_id="viewer", channel_number=0x4001, peer=("127.0.0.1", 51002))
    state.seal_target(client_id="viewer", channel_number=0x4001, payload_type=96, ssrc=7)

    video = state.observe_baseline(client_id="viewer", payload=_channel(0x4001, _rtp(1)))
    other = state.observe_baseline(client_id="viewer", payload=_channel(0x4001, _rtp(2, ssrc=8)))

    assert video.eligible is True and video.drop is False and video.sequence == 1
    assert other.eligible is False and other.drop is False


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


def test_gateway_refuses_to_arm_when_active_event_and_sealed_binding_disagree(tmp_path):
    """A replacement relay binding cannot retarget an already-authorized event."""
    gateway_module = _module()
    state_path, binding_path, counters = (tmp_path / name for name in ("active.json", "binding.json", "counters.json"))
    gateway = gateway_module.InlineTurnGateway(turn_endpoint=("127.0.0.1", 3478), bind_host="127.0.0.1", relay_ports=())
    mapping = gateway._table.bind(("127.0.0.1", 40000))
    association = gateway_module.TurnAssociation(client_id=str(mapping.upstream_id))
    association.relay = ("10.0.0.9", 51000)
    association.confirmed_channels[0x4001] = ("10.0.0.8", 59000)
    gateway._runtime[mapping.upstream_id] = (None, association)
    sealed_media = {"outerEgress": {"protocol": "udp", "source": "10.0.0.2", "sourcePort": 3478, "destination": "10.0.0.3", "destinationPort": 40000}, "allocationRelay": {"address": "10.0.0.9", "port": 51000}, "peer": {"address": "10.0.0.8", "port": 59000}, "channelNumber": 0x4001, "encapsulation": "channel-data", "rtpSsrc": 7, "payloadType": 96}
    binding_path.write_text(json.dumps({"mediaBinding": sealed_media}))
    state_path.write_text(json.dumps({"state": "armed", "comment": "wrd-loss:one", "pattern": "all_for_200ms", "mediaBinding": {**sealed_media, "rtpSsrc": 8}}))
    gateway.configure_control_bridge(state_path=state_path, relay_binding_path=binding_path, counter_path=counters)

    gateway.sync_control_state()

    assert gateway.media.armed is None


def test_gateway_restart_clears_a_persisted_active_fault_before_listening(tmp_path):
    """Restart is a fail-safe clear, never a second full fault window."""
    gateway_module = _module()
    state_path = tmp_path / "active.json"
    state_path.write_text(json.dumps({"state": "armed", "comment": "wrd-loss:one", "pattern": "every_100th_for_30s"}))
    gateway = gateway_module.InlineTurnGateway(turn_endpoint=("127.0.0.1", 3478), bind_host="127.0.0.1", control_port=0, relay_ports=())
    gateway.configure_control_bridge(state_path=state_path, relay_binding_path=tmp_path / "binding.json", counter_path=tmp_path / "counters.json")
    try:
        gateway.start()
        assert not state_path.exists()
        assert gateway.media.armed is None
    finally:
        gateway.close()


def test_gateway_confirms_channel_only_after_the_matching_turn_success_response():
    gateway = _module()
    association = gateway.TurnAssociation(client_id="viewer")
    txid = b"channel-bind"
    association.observe_client(_stun(0x0009, txid, _attr(0x000C, b"\x40\x01\0\0") + _attr(0x0012, _xor_endpoint(b"\x0a\0\0\x02", 51002))))
    assert association.confirmed_channels == {}
    association.observe_server(_stun(0x0109, txid))
    assert association.confirmed_channels == {0x4001: ("10.0.0.2", 51002)}


def test_gateway_tracks_only_an_allocate_success_with_its_request_transaction():
    gateway = _module()
    association = gateway.TurnAssociation(client_id="viewer")
    txid = b"allocation!!"
    association.observe_client(_stun(0x0003, txid))
    association.observe_server(_stun(0x0103, txid, _attr(0x0016, _xor_endpoint(b"\x7f\0\0\x01", 51000))))
    assert association.relay == ("127.0.0.1", 51000)


def test_inline_gateway_forwards_control_datagrams_without_connecting_upstream_socket():
    gateway_module = _module()
    upstream = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    upstream.bind(("127.0.0.1", 0)); upstream.settimeout(1)
    gateway = gateway_module.InlineTurnGateway(turn_endpoint=upstream.getsockname(), bind_host="127.0.0.1", control_port=0, relay_ports=())
    client = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); client.settimeout(1)
    try:
        gateway.start()
        client.sendto(b"opaque-turn-control", gateway.control_endpoint)
        gateway.poll(timeout_s=.1)
        payload, gateway_upstream = upstream.recvfrom(4096)
        assert payload == b"opaque-turn-control"
        upstream.sendto(b"opaque-turn-reply", gateway_upstream)
        gateway.poll(timeout_s=.1)
        assert client.recvfrom(4096)[0] == b"opaque-turn-reply"
        assert gateway.client_mappings()[0].upstream_connected is False
    finally:
        client.close(); upstream.close(); gateway.close()


def test_inline_gateway_preserves_the_public_relay_source_port_for_peer_packets():
    gateway_module = _module()
    control = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); control.bind(("127.0.0.1", 0))
    relay = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); relay.bind(("127.0.0.1", 0)); relay.settimeout(1)
    public = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); public.bind(("127.0.0.1", 0)); relay_port = public.getsockname()[1]; public.close()
    gateway = gateway_module.InlineTurnGateway(turn_endpoint=control.getsockname(), relay_endpoints={relay_port: relay.getsockname()}, bind_host="127.0.0.1", control_port=0, relay_ports=(relay_port,))
    peer = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); peer.settimeout(1)
    try:
        gateway.start()
        peer.sendto(b"peer-ice-check", ("127.0.0.1", relay_port)); gateway.poll(timeout_s=.1)
        payload, gateway_path = relay.recvfrom(4096)
        assert payload == b"peer-ice-check"
        relay.sendto(b"peer-ice-response", gateway_path); gateway.poll(timeout_s=.1)
        response, source = peer.recvfrom(4096)
        assert response == b"peer-ice-response" and source[1] == relay_port
    finally:
        peer.close(); control.close(); relay.close(); gateway.close()
