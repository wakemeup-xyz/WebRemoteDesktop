"""Unprivileged-runner reader and AF_PACKET receiver-leg observer for T6.

The runner never provides RTP rows.  This process owns the packet socket in the
isolated TURN namespace and writes a sealed header-only capture.  It discards
payload bytes and accepts only TURN-to-Viewer UDP on the manifest egress leg.
"""
from __future__ import annotations
import hashlib, ipaddress, json, socket, struct, time
from controller import LossFixtureManifest, RuntimeBlocked, load_runtime_relay_binding
from pathlib import Path
from typing import Any, Iterable, Mapping


def parse_rtp_header(packet: bytes) -> dict[str, int] | None:
    if not isinstance(packet, bytes) or len(packet) < 12 or packet[0] >> 6 != 2:
        return None
    csrc = packet[0] & 0x0F
    if len(packet) < 12 + csrc * 4:
        return None
    return {"sequence": int.from_bytes(packet[2:4], "big"), "rtpTimestamp": int.from_bytes(packet[4:8], "big"),
            "ssrc": int.from_bytes(packet[8:12], "big"), "payloadType": packet[1] & 0x7f}


def channel_data_media_payload(packet: bytes, media: Mapping[str, Any]) -> bytes | None:
    """Accept exactly the ChannelData frame authorized by the TURN observer.

    This is deliberately stricter than RTP parsing: STUN starts with a 0-bit
    top type and DataChannel/RTCP/wrong-SSRC payloads never enter the capture.
    The controller uses the equivalent kernel u32 selector before DROP.
    """
    if not isinstance(media, Mapping) or len(packet) < 4:
        return None
    channel, length = struct.unpack("!HH", packet[:4])
    if channel != media.get("channelNumber") or length < 12 or len(packet) < 4 + length:
        return None
    payload = packet[4:4 + length]
    rtp = parse_rtp_header(payload)
    if rtp is None or rtp["ssrc"] != media.get("rtpSsrc") or rtp["payloadType"] != media.get("payloadType"):
        return None
    return payload


def _udp_payload(frame: bytes) -> tuple[dict[str, Any], bytes] | None:
    """Decode Ethernet/IPv4/UDP enough to filter, retaining no media payload."""
    if len(frame) < 14 or frame[12:14] != b"\x08\x00": return None
    ip = frame[14:]
    if len(ip) < 20 or ip[0] >> 4 != 4 or ip[9] != 17: return None
    ihl = (ip[0] & 0x0F) * 4
    if len(ip) < ihl + 8: return None
    source, destination = str(ipaddress.ip_address(ip[12:16])), str(ipaddress.ip_address(ip[16:20]))
    sport, dport, length = struct.unpack("!HHH", ip[ihl:ihl + 6])
    if length < 8 or len(ip) < ihl + length: return None
    return ({"protocol": "udp", "source": source, "sourcePort": sport, "destination": destination, "destinationPort": dport}, ip[ihl + 8:ihl + length])


def _stun(packet: bytes) -> tuple[int, bytes, dict[int, bytes]] | None:
    """Minimal TURN/STUN decoder used only by the namespace packet owner."""
    if len(packet) < 20 or packet[:2][0] & 0xC0 or packet[4:8] != b"\x21\x12\xa4\x42": return None
    kind, size = struct.unpack("!HH", packet[:4])
    if size + 20 != len(packet): return None
    attrs: dict[int, bytes] = {}; offset = 20
    while offset < len(packet):
        if offset + 4 > len(packet): return None
        code, length = struct.unpack("!HH", packet[offset:offset + 4]); offset += 4
        if offset + length > len(packet): return None
        attrs[code] = packet[offset:offset + length]; offset += length + ((-length) % 4)
    return kind, packet[8:20], attrs


def _xor_endpoint(value: bytes, txid: bytes) -> tuple[str, int] | None:
    if len(value) != 8 or value[:2] != b"\0\x01": return None
    port = struct.unpack("!H", value[2:4])[0] ^ 0x2112
    raw = bytes(a ^ b for a, b in zip(value[4:], b"\x21\x12\xa4\x42"))
    try: return str(ipaddress.ip_address(raw)), port
    except ValueError: return None


class TurnProtocolObserver:
    """Receiver-owned passive association of C↔S, R, H, ChannelData and RTP.

    No runner row is accepted: allocations originate only in AF_PACKET frames.
    A readiness probe can create an entry, but later selection is exact on its
    relay R, peer H, channel and video SSRC, so a different browser allocation
    cannot borrow it.
    """
    def __init__(self) -> None:
        self._allocate: dict[bytes, tuple[tuple[str, int], tuple[str, int]]] = {}
        self._allocations: dict[tuple[str, int], dict[str, Any]] = {}
        self._observed: list[dict[str, Any]] = []

    def accept(self, leg: Mapping[str, Any], payload: bytes) -> None:
        source, destination = (str(leg["source"]), int(leg["sourcePort"])), (str(leg["destination"]), int(leg["destinationPort"]))
        parsed = _stun(payload)
        if parsed is not None:
            kind, txid, attrs = parsed
            if kind == 0x0003: self._allocate[txid] = (source, destination); return
            if kind == 0x0103 and txid in self._allocate and 0x0016 in attrs:
                client, server = self._allocate.pop(txid)
                relay = _xor_endpoint(attrs[0x0016], txid)
                if relay is not None and source == server and destination == client:
                    self._allocations[client] = {"client": client, "server": server, "allocationRelay": relay, "peer": None, "channels": {}}
                return
            # TURN Data indication is a valid receive encoding.  Keep the
            # observation for audit/selection, but it deliberately cannot
            # authorize a DROP rule until a payload-safe classifier exists.
            if kind == 0x0017:
                allocation = self._allocations.get(destination)
                peer = _xor_endpoint(attrs[0x0012], txid) if 0x0012 in attrs else None
                rtp = parse_rtp_header(attrs[0x0013]) if 0x0013 in attrs else None
                if allocation is not None and source == allocation["server"] and peer is not None and rtp is not None and rtp["payloadType"] == 96:
                    self._observed.append({"outerEgress": dict(leg), "allocationRelay": {"address": allocation["allocationRelay"][0], "port": allocation["allocationRelay"][1]}, "peer": {"address": peer[0], "port": peer[1]}, "channelNumber": None, "encapsulation": "data-indication", "rtpSsrc": rtp["ssrc"], "payloadType": 96})
                return
            allocation = self._allocations.get(source)
            if allocation is None or destination != allocation["server"]: return
            if kind == 0x0008 and 0x0012 in attrs:
                allocation["peer"] = _xor_endpoint(attrs[0x0012], txid); return
            if kind == 0x0009 and 0x000c in attrs and 0x0012 in attrs and len(attrs[0x000c]) == 4:
                channel = struct.unpack("!H", attrs[0x000c][:2])[0]; peer = _xor_endpoint(attrs[0x0012], txid)
                if 0x4000 <= channel <= 0x7fff and peer is not None:
                    allocation["peer"] = peer; allocation["channels"][channel] = peer
            return
        if len(payload) < 16 or payload[0] >> 6 != 1: return  # ChannelData only; STUN/Data indication cannot authorize DROP.
        allocation = self._allocations.get(destination)
        if allocation is None or source != allocation["server"]: return
        channel, length = struct.unpack("!HH", payload[:4])
        peer = allocation["channels"].get(channel)
        rtp = parse_rtp_header(payload[4:4 + length]) if len(payload) >= 4 + length else None
        if peer is None or rtp is None or rtp["payloadType"] != 96: return
        self._observed.append({"outerEgress": dict(leg), "allocationRelay": {"address": allocation["allocationRelay"][0], "port": allocation["allocationRelay"][1]}, "peer": {"address": peer[0], "port": peer[1]}, "channelNumber": channel, "encapsulation": "channel-data", "rtpSsrc": rtp["ssrc"], "payloadType": 96})

    def select(self, *, relay: Mapping[str, Any], peer: Mapping[str, Any], ssrc: int) -> dict[str, Any] | None:
        matches = [row for row in self._observed if row["allocationRelay"] == dict(relay) and row["peer"] == dict(peer) and row["rtpSsrc"] == ssrc]
        return dict(matches[-1]) if len(matches) else None


def _canonical(value: Mapping[str, Any]) -> str:
    return json.dumps(dict(value), sort_keys=True, separators=(",", ":"))


def seal_received_capture(*, run_id: str, event_handle: str, selected_leg: Mapping[str, Any],
                          kernel_drop_count: int, received_rtp: Mapping[str, Iterable[Mapping[str, Any]]],
                          ssrc: int, cursor: Mapping[str, int]) -> dict[str, Any]:
    """Seal capture rows emitted by this observer; sender rows cannot fit this schema."""
    if (not isinstance(run_id, str) or not run_id or not isinstance(event_handle, str) or not event_handle
            or not isinstance(kernel_drop_count, int) or kernel_drop_count <= 0 or not isinstance(ssrc, int)):
        raise ValueError("receiver capture binding is invalid")
    expected_leg = {"protocol", "source", "sourcePort", "destination", "destinationPort"}
    if not isinstance(selected_leg, Mapping) or set(selected_leg) != expected_leg or selected_leg.get("protocol") != "udp":
        raise ValueError("receiver capture selected leg is invalid")
    if not isinstance(cursor, Mapping) or set(cursor) != {"first", "last"} or not all(isinstance(cursor[k], int) for k in cursor):
        raise ValueError("receiver capture cursor is invalid")
    if not isinstance(received_rtp, Mapping) or set(received_rtp) != {"before", "during", "after"}:
        raise ValueError("receiver capture phases are invalid")
    normalized: dict[str, list[dict[str, int]]] = {}
    for phase, rows in received_rtp.items():
        normalized[phase] = []
        for row in rows:
            if not isinstance(row, Mapping) or set(row) != {"sequence", "rtpTimestamp", "ssrc", "fixtureClockNs"}:
                raise ValueError("receiver capture row is malformed")
            if (not all(isinstance(row[k], int) and not isinstance(row[k], bool) for k in row)
                    or not 0 <= row["sequence"] <= 65535 or not 0 <= row["rtpTimestamp"] <= 0xFFFFFFFF
                    or row["ssrc"] != ssrc or row["fixtureClockNs"] < 0):
                raise ValueError("receiver capture row is invalid")
            normalized[phase].append(dict(row))
        if not normalized[phase]: raise ValueError("receiver capture requires all phases")
    body = {"source": "fixture-af-packet", "direction": "turn-to-viewer", "runId": run_id,
            "eventHandle": event_handle, "selectedLeg": dict(selected_leg), "kernelDropCount": kernel_drop_count,
            "ssrc": ssrc, "cursor": dict(cursor), "receivedRtp": normalized}
    return {**body, "captureDigest": hashlib.sha256(_canonical(body).encode()).hexdigest()}


class ReceiverDirectedObserver:
    """Owns AF_PACKET and only emits headers matching one selected receiver leg."""
    def __init__(self, *, interface: str, selected_leg: Mapping[str, Any], media_binding: Mapping[str, Any] | None = None, protocol_observer: TurnProtocolObserver | None = None, clock_ns=time.monotonic_ns) -> None:
        self.interface, self.selected_leg, self.clock_ns = interface, dict(selected_leg), clock_ns
        self.media_binding = dict(media_binding) if media_binding is not None else None
        self.protocol_observer = protocol_observer
        self._rows: list[dict[str, int]] = []; self._arrival = 0

    def accept_frame(self, frame: bytes) -> None:
        decoded = _udp_payload(frame)
        if decoded is None: return
        leg, payload = decoded
        if self.protocol_observer is not None:
            self.protocol_observer.accept(leg, payload)
        if leg != self.selected_leg: return
        if self.media_binding is None: return
        payload = channel_data_media_payload(payload, self.media_binding)
        if payload is None: return
        rtp = parse_rtp_header(payload)
        if rtp is None: return
        self._arrival += 1
        self._rows.append({key: rtp[key] for key in ("sequence", "rtpTimestamp", "ssrc")} | {"fixtureClockNs": int(self.clock_ns()), "arrivalSeq": self._arrival})

    def capture_once(self, *, timeout_s: float = 0.25) -> int:
        """Read kernel frames directly.  No runner callback can submit a row."""
        with socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(0x0003)) as raw:
            raw.bind((self.interface, 0)); raw.settimeout(timeout_s)
            try: self.accept_frame(raw.recv(65535))
            except TimeoutError: pass
        return self._arrival

    @property
    def rows(self) -> tuple[dict[str, int], ...]: return tuple(self._rows)


def write_capture(path: Path, capture: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(_canonical(capture), encoding="utf-8")
    temporary.chmod(0o600); temporary.replace(path)

class FixtureCaptureService:
    """State-driven observer; runner has no write path into this object."""
    def __init__(self, *, observer: ReceiverDirectedObserver, manifest: Mapping[str, Any], state_path: Path, output: Path, authority_socket: Path, capture_capability: str, relay_binding: Path) -> None:
        if not isinstance(capture_capability, str) or not capture_capability:
            raise ValueError("receiver capture capability is required")
        self.observer, self.manifest, self.state_path, self.output, self.authority_socket, self.capture_capability, self.relay_binding = observer, dict(manifest), Path(state_path), Path(output), Path(authority_socket), capture_capability, Path(relay_binding)
        self._ring: list[dict[str, int]] = []; self._event: Mapping[str, Any] | None = None
        self._during: list[dict[str, int]] = []; self._after: list[dict[str, int]] = []
    def _state(self) -> Mapping[str, Any] | None:
        try:
            row = json.loads(self.state_path.read_text(encoding="utf-8"))
            return row if isinstance(row, Mapping) and row.get("state") == "armed" else None
        except (OSError, ValueError): return None
    def poll(self) -> None:
        # Do not retain a static-manifest packet ring.  The parent must first
        # bind the actual reciprocal Viewer/Host selected pair into this
        # namespace; only that tuple can authorize AF_PACKET observation.
        try:
            runtime = load_runtime_relay_binding(self.relay_binding, LossFixtureManifest.parse(self.manifest))
        except RuntimeBlocked:
            time.sleep(.05)
            return
        self.observer.selected_leg = dict(runtime["actualEgressSelector"])
        self.observer.media_binding = dict(runtime["mediaBinding"])
        previous = len(self.observer.rows); self.observer.capture_once(timeout_s=.25)
        fresh = list(self.observer.rows)[previous:]
        active = self._state()
        if active is not None and self._event is None:
            self._event, self._during, self._after = dict(active), [], []
        if self._event is None:
            self._ring = (self._ring + fresh)[-256:]; return
        if active is not None: self._during.extend(fresh); return
        self._after.extend(fresh)
        if len(self._ring) and len(self._during) and len(self._after):
            event = self._event
            ssrc = self._during[0]["ssrc"]
            groups = {"before": [{k:v for k,v in row.items() if k != "arrivalSeq"} for row in self._ring if row["ssrc"] == ssrc],
                      "during": [{k:v for k,v in row.items() if k != "arrivalSeq"} for row in self._during if row["ssrc"] == ssrc],
                      "after": [{k:v for k,v in row.items() if k != "arrivalSeq"} for row in self._after if row["ssrc"] == ssrc]}
            if all(groups.values()) and isinstance(event.get("actualDropCount"), int) and event["actualDropCount"] > 0:
                capture = seal_received_capture(run_id=str(event["runId"]), event_handle=str(event["comment"]), selected_leg=self.observer.selected_leg, kernel_drop_count=event["actualDropCount"], received_rtp=groups, ssrc=ssrc, cursor={"first": self._ring[0]["arrivalSeq"], "last": self._after[-1]["arrivalSeq"]})
                request = {"operation": "capture", "runId": self.manifest["runId"], "capture": capture, "captureCapability": self.capture_capability}
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.settimeout(2); client.connect(str(self.authority_socket)); client.sendall((json.dumps(request, sort_keys=True) + "\n").encode()); reply = json.loads(client.recv(1_000_000))
                if not isinstance(reply, Mapping) or reply.get("status") != "ATTESTED" or not isinstance(reply.get("capture"), Mapping): raise RuntimeError("Lab authority refused receiver capture")
                write_capture(self.output, reply["capture"]); self._event = None

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    observe = sub.add_parser("observe"); observe.add_argument("--manifest", type=Path, required=True); observe.add_argument("--state", type=Path, required=True); observe.add_argument("--output", type=Path, required=True); observe.add_argument("--authority-socket", type=Path, required=True); observe.add_argument("--capture-capability", type=Path, required=True); observe.add_argument("--relay-binding", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "observe":
        raw = json.loads(args.manifest.read_text(encoding="utf-8")); selector = raw["udpLegSelector"]
        # Canonical relay egress from manifest's sole relay port.
        leg = selector if selector["sourcePort"] in {57004, 57005} else {"protocol": "udp", "source": selector["destination"], "sourcePort": selector["destinationPort"], "destination": selector["source"], "destinationPort": selector["sourcePort"]}
        capability = args.capture_capability.read_text(encoding="utf-8").strip()
        service = FixtureCaptureService(observer=ReceiverDirectedObserver(interface=raw["interface"], selected_leg=leg), manifest=raw, state_path=args.state, output=args.output, authority_socket=args.authority_socket, capture_capability=capability, relay_binding=args.relay_binding)
        while True: service.poll()
