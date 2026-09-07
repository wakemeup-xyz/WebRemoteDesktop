"""Regression tests for receiver-owned RTP headers; no Host sender rows are accepted."""
from __future__ import annotations
import importlib.util
import os
from pathlib import Path

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("receiver_capture", HERE / "receiver_capture.py")
receiver = importlib.util.module_from_spec(spec); assert spec.loader; spec.loader.exec_module(receiver)

LEG = {"protocol": "udp", "source": "172.31.0.3", "sourcePort": 57004, "destination": "172.31.0.4", "destinationPort": 51002}
MEDIA = {"channelNumber": 0x4001, "rtpSsrc": 9, "payloadType": 96}

def _rtp(sequence: int, timestamp: int = 1, ssrc: int = 9) -> bytes:
    return bytes([0x80, 96]) + sequence.to_bytes(2, "big") + timestamp.to_bytes(4, "big") + ssrc.to_bytes(4, "big")

def test_af_packet_observer_filters_receiver_leg_and_keeps_only_rtp_headers():
    # Ethernet + IPv4 + UDP around a trusted receiver-directed RTP packet.
    ip = bytes([0x45, 0, 0, 40, 0, 0, 0, 0, 64, 17, 0, 0]) + bytes([172,31,0,3]) + bytes([172,31,0,4])
    observer = receiver.ReceiverDirectedObserver(interface="eth0", selected_leg=LEG, media_binding=MEDIA, clock_ns=lambda: 77)
    payload = (0x4001).to_bytes(2, "big") + len(_rtp(12, 34)).to_bytes(2, "big") + _rtp(12, 34)
    udp = (57004).to_bytes(2,"big") + (51002).to_bytes(2,"big") + (8 + len(payload)).to_bytes(2,"big") + b"\0\0"
    observer.accept_frame(b"\0" * 12 + b"\x08\x00" + ip + udp + payload)
    assert observer.rows == ({"sequence": 12, "rtpTimestamp": 34, "ssrc": 9, "fixtureClockNs": 77, "arrivalSeq": 1},)

def test_af_packet_observer_rejects_stun_rtcp_data_and_wrong_video_ssrc():
    ip = bytes([0x45, 0, 0, 40, 0, 0, 0, 0, 64, 17, 0, 0]) + bytes([172,31,0,3]) + bytes([172,31,0,4])
    observer = receiver.ReceiverDirectedObserver(interface="eth0", selected_leg=LEG, media_binding=MEDIA, clock_ns=lambda: 77)
    def frame(payload: bytes) -> bytes:
        udp = (57004).to_bytes(2,"big") + (51002).to_bytes(2,"big") + (8 + len(payload)).to_bytes(2,"big") + b"\0\0"
        return b"\0" * 12 + b"\x08\x00" + ip + udp + payload
    # STUN and RTCP are not ChannelData/RTP.  A separate ChannelData stream
    # and a wrong SSRC share the outer tuple but must remain invisible.
    observer.accept_frame(frame(b"\x00\x01" + b"\0" * 18))
    observer.accept_frame(frame((0x4001).to_bytes(2,"big") + (12).to_bytes(2,"big") + bytes([0x80, 72]) + b"\0" * 10))
    wrong = _rtp(1, 1, ssrc=10)
    observer.accept_frame(frame((0x4001).to_bytes(2,"big") + len(wrong).to_bytes(2,"big") + wrong))
    other_channel = _rtp(2)
    observer.accept_frame(frame((0x4002).to_bytes(2,"big") + len(other_channel).to_bytes(2,"big") + other_channel))
    assert observer.rows == ()

def test_passive_turn_observer_selects_browser_allocation_not_readiness_allocation():
    probe_spec = importlib.util.spec_from_file_location("turn_probe", HERE / "turn_udp_probe.py")
    probe = importlib.util.module_from_spec(probe_spec); assert probe_spec.loader; probe_spec.loader.exec_module(probe)
    observer = receiver.TurnProtocolObserver()
    server, client, peer = ("172.31.0.20", 3478), ("172.31.0.21", 48000), ("172.31.0.8", 59000)
    def leg(source, destination): return {"protocol":"udp", "source":source[0], "sourcePort":source[1], "destination":destination[0], "destinationPort":destination[1]}
    # This record models a separate readiness allocation: it is never selected.
    stale = os.urandom(12); observer.accept(leg(("172.31.0.30", 49000), server), probe._message(0x0003, stale, b""))
    observer.accept(leg(server, ("172.31.0.30", 49000)), probe._message(0x0103, stale, probe._attr(0x0016, probe._xor_peer("172.31.0.99", 51001, stale))))
    tx = os.urandom(12); observer.accept(leg(client, server), probe._message(0x0003, tx, b""))
    observer.accept(leg(server, client), probe._message(0x0103, tx, probe._attr(0x0016, probe._xor_peer("172.31.0.9", 51007, tx))))
    bind_tx = os.urandom(12); bind = probe._attr(0x000c, b"\x40\x01\0\0") + probe._attr(0x0012, probe._xor_peer(*peer, bind_tx))
    observer.accept(leg(client, server), probe._message(0x0009, bind_tx, bind))
    rtp = _rtp(12, 34, 0x10203040); observer.accept(leg(server, client), b"\x40\x01" + len(rtp).to_bytes(2,"big") + rtp)
    selected = observer.select(relay={"address":"172.31.0.9","port":51007}, peer={"address":peer[0],"port":peer[1]}, ssrc=0x10203040)
    assert selected and selected["outerEgress"] == leg(server, client)
    assert observer.select(relay={"address":"172.31.0.99","port":51001}, peer={"address":peer[0],"port":peer[1]}, ssrc=0x10203040) is None
    assert observer.select(relay={"address":"172.31.0.9","port":51007}, peer={"address":peer[0],"port":peer[1]}, ssrc=9) is None

def test_capture_rejects_sender_only_rows_tuple_change_and_ssrc_change():
    rows = {"before": [{"sequence": 1,"rtpTimestamp":1,"ssrc":9,"fixtureClockNs":1}], "during": [{"sequence":3,"rtpTimestamp":3,"ssrc":9,"fixtureClockNs":2}], "after": [{"sequence":4,"rtpTimestamp":4,"ssrc":9,"fixtureClockNs":3}]}
    sealed = receiver.seal_received_capture(run_id="r", event_handle="e", selected_leg=LEG, kernel_drop_count=1, received_rtp=rows, ssrc=9, cursor={"first":1,"last":3})
    assert sealed["direction"] == "turn-to-viewer" and sealed["receivedRtp"]["during"][0]["sequence"] == 3
    bad = {**rows, "during": [{"sequence":3,"rtpTimestamp":3,"ssrc":10,"fixtureClockNs":2}]}
    try: receiver.seal_received_capture(run_id="r", event_handle="e", selected_leg=LEG, kernel_drop_count=1, received_rtp=bad, ssrc=9, cursor={"first":1,"last":3})
    except ValueError as exc: assert "invalid" in str(exc)
    else: assert False, "mixed SSRC must block"
