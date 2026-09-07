"""Regression tests for receiver-owned RTP headers; no Host sender rows are accepted."""
from __future__ import annotations
import importlib.util
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

def test_capture_rejects_sender_only_rows_tuple_change_and_ssrc_change():
    rows = {"before": [{"sequence": 1,"rtpTimestamp":1,"ssrc":9,"fixtureClockNs":1}], "during": [{"sequence":3,"rtpTimestamp":3,"ssrc":9,"fixtureClockNs":2}], "after": [{"sequence":4,"rtpTimestamp":4,"ssrc":9,"fixtureClockNs":3}]}
    sealed = receiver.seal_received_capture(run_id="r", event_handle="e", selected_leg=LEG, kernel_drop_count=1, received_rtp=rows, ssrc=9, cursor={"first":1,"last":3})
    assert sealed["direction"] == "turn-to-viewer" and sealed["receivedRtp"]["during"][0]["sequence"] == 3
    bad = {**rows, "during": [{"sequence":3,"rtpTimestamp":3,"ssrc":10,"fixtureClockNs":2}]}
    try: receiver.seal_received_capture(run_id="r", event_handle="e", selected_leg=LEG, kernel_drop_count=1, received_rtp=bad, ssrc=9, cursor={"first":1,"last":3})
    except ValueError as exc: assert "invalid" in str(exc)
    else: assert False, "mixed SSRC must block"
