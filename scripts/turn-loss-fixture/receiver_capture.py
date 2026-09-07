"""Unprivileged-runner reader and AF_PACKET receiver-leg observer for T6.

The runner never provides RTP rows.  This process owns the packet socket in the
isolated TURN namespace and writes a sealed header-only capture.  It discards
payload bytes and accepts only TURN-to-Viewer UDP on the manifest egress leg.
"""
from __future__ import annotations
import hashlib, ipaddress, json, socket, struct, time
from pathlib import Path
from typing import Any, Iterable, Mapping


def parse_rtp_header(packet: bytes) -> dict[str, int] | None:
    if not isinstance(packet, bytes) or len(packet) < 12 or packet[0] >> 6 != 2:
        return None
    csrc = packet[0] & 0x0F
    if len(packet) < 12 + csrc * 4:
        return None
    return {"sequence": int.from_bytes(packet[2:4], "big"), "rtpTimestamp": int.from_bytes(packet[4:8], "big"),
            "ssrc": int.from_bytes(packet[8:12], "big")}


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
    def __init__(self, *, interface: str, selected_leg: Mapping[str, Any], clock_ns=time.monotonic_ns) -> None:
        self.interface, self.selected_leg, self.clock_ns = interface, dict(selected_leg), clock_ns
        self._rows: list[dict[str, int]] = []; self._arrival = 0

    def accept_frame(self, frame: bytes) -> None:
        decoded = _udp_payload(frame)
        if decoded is None: return
        leg, payload = decoded
        if leg != self.selected_leg: return
        rtp = parse_rtp_header(payload)
        if rtp is None: return
        self._arrival += 1
        self._rows.append({**rtp, "fixtureClockNs": int(self.clock_ns()), "arrivalSeq": self._arrival})

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
    def __init__(self, *, observer: ReceiverDirectedObserver, manifest: Mapping[str, Any], state_path: Path, output: Path) -> None:
        self.observer, self.manifest, self.state_path, self.output = observer, dict(manifest), Path(state_path), Path(output)
        self._ring: list[dict[str, int]] = []; self._event: Mapping[str, Any] | None = None
        self._during: list[dict[str, int]] = []; self._after: list[dict[str, int]] = []
    def _state(self) -> Mapping[str, Any] | None:
        try:
            row = json.loads(self.state_path.read_text(encoding="utf-8"))
            return row if isinstance(row, Mapping) and row.get("state") == "armed" else None
        except (OSError, ValueError): return None
    def poll(self) -> None:
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
                write_capture(self.output, capture); self._event = None

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    observe = sub.add_parser("observe"); observe.add_argument("--manifest", type=Path, required=True); observe.add_argument("--state", type=Path, required=True); observe.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "observe":
        raw = json.loads(args.manifest.read_text(encoding="utf-8")); selector = raw["udpLegSelector"]
        # Canonical relay egress from manifest's sole relay port.
        leg = selector if selector["sourcePort"] in {57004, 57005} else {"protocol": "udp", "source": selector["destination"], "sourcePort": selector["destinationPort"], "destination": selector["source"], "destinationPort": selector["sourcePort"]}
        service = FixtureCaptureService(observer=ReceiverDirectedObserver(interface=raw["interface"], selected_leg=leg), manifest=raw, state_path=args.state, output=args.output)
        while True: service.poll()

