"""Lab-only in-path UDP TURN gateway state; network loop is deliberately separate."""
from __future__ import annotations

from dataclasses import dataclass
import argparse
from collections import deque
import json
from pathlib import Path
import selectors
import socket
import time

from gateway_evidence import GatewayCounterStore, GatewayLossCounter
from turn_wire import COOKIE, WireProtocolError, parse_channel_data, parse_channel_data_video, parse_rtp, parse_stun


class GatewayBlocked(RuntimeError):
    pass


@dataclass(frozen=True)
class ClientMapping:
    client_endpoint: tuple[str, int]
    upstream_id: int
    upstream_connected: bool = False


@dataclass(frozen=True)
class GatewayDecision:
    drop: bool
    payload: bytes
    sequence: int | None = None
    eligible: bool = False


def _xor_endpoint(value: bytes) -> tuple[str, int] | None:
    if len(value) != 8 or value[:2] != b"\0\x01":
        return None
    raw = bytes(left ^ right for left, right in zip(value[4:], COOKIE.to_bytes(4, "big")))
    try:
        host = ".".join(str(part) for part in raw)
        port = int.from_bytes(value[2:4], "big") ^ (COOKIE >> 16)
    except (TypeError, ValueError):
        return None
    return host, port


class TurnAssociation:
    """Associates TURN transactions without modifying their authenticated bytes."""
    def __init__(self, *, client_id: str) -> None:
        self.client_id = client_id
        self.relay: tuple[str, int] | None = None
        self.confirmed_channels: dict[int, tuple[str, int]] = {}
        self._allocate_transactions: set[bytes] = set()
        self._pending_channel_binds: dict[bytes, tuple[int, tuple[str, int]]] = {}

    def observe_client(self, packet: bytes) -> None:
        try:
            message = parse_stun(packet)
        except WireProtocolError:
            return
        if message.message_type == 0x0003:
            self._allocate_transactions.add(message.transaction_id)
        elif message.message_type == 0x0009:
            channel, peer = message.attribute(0x000C), _xor_endpoint(message.attribute(0x0012) or b"")
            if channel is not None and len(channel) == 4 and peer is not None:
                number = int.from_bytes(channel[:2], "big")
                if 0x4000 <= number <= 0x7FFF:
                    self._pending_channel_binds[message.transaction_id] = (number, peer)

    def observe_server(self, packet: bytes) -> None:
        try:
            message = parse_stun(packet)
        except WireProtocolError:
            return
        if message.message_type == 0x0103 and message.transaction_id in self._allocate_transactions:
            relay = _xor_endpoint(message.attribute(0x0016) or b"")
            if relay is not None:
                self.relay = relay
            self._allocate_transactions.discard(message.transaction_id)
        elif message.message_type == 0x0109:
            pending = self._pending_channel_binds.pop(message.transaction_id, None)
            if pending is not None:
                self.confirmed_channels[pending[0]] = pending[1]


class ClientMappingTable:
    def __init__(self, *, max_clients: int = 3) -> None:
        if not 1 <= int(max_clients) <= 3:
            raise ValueError("Lab gateway must allow one readiness, Viewer, and Host allocation")
        self.max_clients, self._by_client = int(max_clients), {}
        self._next_id = 1

    def bind(self, client_endpoint: tuple[str, int]) -> ClientMapping:
        if not isinstance(client_endpoint, tuple) or len(client_endpoint) != 2 or not isinstance(client_endpoint[0], str) or not isinstance(client_endpoint[1], int):
            raise GatewayBlocked("client endpoint is invalid")
        existing = self._by_client.get(client_endpoint)
        if existing is not None:
            return existing
        if len(self._by_client) >= self.max_clients:
            raise GatewayBlocked("Lab gateway allocation limit reached")
        result = ClientMapping(client_endpoint, self._next_id)
        self._next_id += 1
        self._by_client[client_endpoint] = result
        return result

    def values(self) -> tuple[ClientMapping, ...]:
        return tuple(self._by_client.values())


class GatewayMediaState:
    def __init__(self) -> None:
        self._confirmed: dict[tuple[str, int], tuple[str, int]] = {}
        self._target: tuple[str, int, int, int] | None = None
        self.armed: GatewayLossCounter | None = None

    def confirm_channel(self, *, client_id: str, channel_number: int, peer: tuple[str, int]) -> None:
        if not isinstance(client_id, str) or not client_id or not 0x4000 <= int(channel_number) <= 0x7FFF:
            raise GatewayBlocked("confirmed ChannelBind is invalid")
        self._confirmed[(client_id, int(channel_number))] = peer

    def seal_target(self, *, client_id: str, channel_number: int, payload_type: int, ssrc: int) -> None:
        if (client_id, int(channel_number)) not in self._confirmed:
            raise GatewayBlocked("loss target requires confirmed ChannelBind")
        if not 0 <= int(payload_type) <= 127 or not 0 <= int(ssrc) <= 0xFFFFFFFF:
            raise GatewayBlocked("loss target media identity is invalid")
        self._target = (client_id, int(channel_number), int(payload_type), int(ssrc))

    def arm(self, pattern: str, *, now_ns: int | None = None) -> None:
        self.armed = GatewayLossCounter(pattern, started_ns=time.monotonic_ns() if now_ns is None else int(now_ns))

    def clear_on_control_disconnect(self) -> None:
        self.armed = None

    def observe_baseline(self, *, client_id: str, payload: bytes) -> GatewayDecision:
        """Classify only the sealed receiver-directed video for a dry run."""
        target = self._target
        if target is None or target[0] != client_id:
            return GatewayDecision(False, payload)
        video = parse_channel_data_video(payload, channel_number=target[1], payload_type=target[2], ssrc=target[3])
        if video is None:
            return GatewayDecision(False, payload)
        return GatewayDecision(False, payload, video.sequence, True)

    def decide(self, *, client_id: str, payload: bytes, now_ns: int | None = None) -> GatewayDecision:
        target, armed = self._target, self.armed
        if target is None or target[0] != client_id:
            return GatewayDecision(False, payload)
        video = parse_channel_data_video(payload, channel_number=target[1], payload_type=target[2], ssrc=target[3])
        if video is None:
            return GatewayDecision(False, payload)
        if armed is None:
            return GatewayDecision(False, payload, video.sequence)
        forward = armed.observe(sequence=video.sequence, now_ns=time.monotonic_ns() if now_ns is None else int(now_ns))
        eligible = not armed.deadline_expired
        if armed.deadline_expired:
            self.armed = None
        return GatewayDecision(not forward, payload, video.sequence, eligible)


class InlineTurnGateway:
    """Owns public Lab UDP sockets and forwards each TURN client via its own socket.

    Upstream sockets intentionally remain unconnected.  coturn may return
    ChannelData from an allocation relay port instead of its control port.
    """
    def __init__(self, *, turn_endpoint: tuple[str, int], bind_host: str, control_port: int = 3478,
                 relay_ports: tuple[int, ...] = tuple(range(51000, 51010)),
                 relay_endpoints: dict[int, tuple[str, int]] | None = None, max_clients: int = 3) -> None:
        host, port = turn_endpoint
        if not isinstance(host, str) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError("private coturn endpoint is invalid")
        self.turn_endpoint, self.bind_host, self.control_port = (host, port), bind_host, int(control_port)
        self.relay_ports = tuple(int(value) for value in relay_ports)
        self.relay_endpoints = {int(port): (str(endpoint[0]), int(endpoint[1])) for port, endpoint in (relay_endpoints or {}).items()}
        if set(self.relay_endpoints) - set(self.relay_ports):
            raise ValueError("private relay endpoints must have a public gateway port")
        self._table, self.media = ClientMappingTable(max_clients=max_clients), GatewayMediaState()
        self._selector = selectors.DefaultSelector(); self._front: dict[int, socket.socket] = {}
        self._runtime: dict[int, tuple[socket.socket, TurnAssociation]] = {}
        self._relay_runtime: dict[tuple[int, tuple[str, int]], socket.socket] = {}
        # coturn's ``external-ip`` may be a loopback fixture address while
        # its control listener remains on the private Compose network.
        self._allowed_turn_hosts = {host, "127.0.0.1"}
        try:
            self._allowed_turn_hosts.update(row[4][0] for row in socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_DGRAM))
        except socket.gaierror:
            pass
        self._state_path: Path | None = None
        self._relay_binding_path: Path | None = None
        self._counter_store: GatewayCounterStore | None = None
        self._active_event_id: str | None = None
        self._after_event_id: str | None = None
        self._probe_event_id: str | None = None
        self._completed_event_ids: set[str] = set()
        self._capture_socket_path: Path | None = None
        self._capture_capability_path: Path | None = None
        self._run_id: str | None = None
        self._observed_media: set[tuple[int, int, int]] = set()
        self._recent_forwarded: deque[int] = deque(maxlen=256)

    def configure_control_bridge(self, *, state_path: Path, relay_binding_path: Path, counter_path: Path) -> None:
        """Attach the Lab-only file bridge after all paths have been fixed.

        The controller owns the control state.  This gateway only reads the
        selected, sealed binding and records header counters under `/state`.
        """
        self._state_path = Path(state_path)
        self._relay_binding_path = Path(relay_binding_path)
        self._counter_store = GatewayCounterStore(counter_path)

    def configure_observation_bridge(self, *, capture_socket_path: Path, capture_capability_path: Path, run_id: str) -> None:
        if not isinstance(run_id, str) or not run_id:
            raise ValueError("gateway observation run id is invalid")
        self._capture_socket_path, self._capture_capability_path, self._run_id = Path(capture_socket_path), Path(capture_capability_path), run_id

    def _record_media_observation(self, *, upstream_id: int, association: TurnAssociation, payload: bytes, source: tuple[str, int], upstream: socket.socket) -> None:
        """Offer one passive header-only ChannelData observation to authority."""
        if self._capture_socket_path is None or self._capture_capability_path is None or self._run_id is None:
            return
        parsed = parse_channel_data(payload)
        if parsed is None or parsed[0] not in association.confirmed_channels:
            return
        rtp = parse_rtp(parsed[1], payload_type=96)
        if rtp is None or association.relay is None:
            return
        key = (upstream_id, parsed[0], rtp.ssrc)
        if key in self._observed_media:
            return
        try:
            capability = self._capture_capability_path.read_text(encoding="utf-8").strip()
            local = upstream.getsockname()
            observation = {"outerEgress": {"protocol": "udp", "source": str(source[0]), "sourcePort": int(source[1]),
                                             "destination": str(local[0]), "destinationPort": int(local[1])},
                           "allocationRelay": {"address": association.relay[0], "port": association.relay[1]},
                           "peer": {"address": association.confirmed_channels[parsed[0]][0], "port": association.confirmed_channels[parsed[0]][1]},
                           "channelNumber": parsed[0], "encapsulation": "channel-data", "rtpSsrc": rtp.ssrc, "payloadType": rtp.payload_type}
            request = {"operation": "media-observation", "runId": self._run_id, "observation": observation, "captureCapability": capability}
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(.25); client.connect(str(self._capture_socket_path)); client.sendall((json.dumps(request, sort_keys=True) + "\n").encode())
                reply = json.loads(client.makefile("rb").readline(65536))
            if isinstance(reply, dict) and reply.get("status") == "OBSERVED":
                self._observed_media.add(key)
        except (OSError, ValueError, json.JSONDecodeError):
            # The authority may start after Compose or the one-shot capability
            # may already be consumed.  Do not affect TURN byte forwarding.
            return

    @staticmethod
    def _read_json(path: Path) -> dict | None:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            return None
        return raw if isinstance(raw, dict) else None

    def _target_from_binding(self, binding: dict) -> tuple[str, int, int, int] | None:
        media = binding.get("mediaBinding")
        if not isinstance(media, dict):
            return None
        channel, payload_type, ssrc = media.get("channelNumber"), media.get("payloadType"), media.get("rtpSsrc")
        allocation, peer = media.get("allocationRelay"), media.get("peer")
        if (not isinstance(channel, int) or not isinstance(payload_type, int) or not isinstance(ssrc, int)
                or not isinstance(allocation, dict) or not isinstance(peer, dict)):
            return None
        relay = (allocation.get("address"), allocation.get("port")); peer_tuple = (peer.get("address"), peer.get("port"))
        if not all(isinstance(value, (str, int)) for value in (*relay, *peer_tuple)):
            return None
        for mapping in self._table.values():
            _upstream, association = self._runtime.get(mapping.upstream_id, (None, None))
            if association is None or association.relay != relay or association.confirmed_channels.get(channel) != peer_tuple:
                continue
            self.media.confirm_channel(client_id=str(mapping.upstream_id), channel_number=channel, peer=peer_tuple)
            self.media.seal_target(client_id=str(mapping.upstream_id), channel_number=channel, payload_type=payload_type, ssrc=ssrc)
            return self.media._target
        return None

    def sync_control_state(self) -> None:
        if self._state_path is None or self._relay_binding_path is None:
            return
        event = self._read_json(self._state_path)
        if event is None or event.get("state") != "armed" or event.get("mode") not in {"baseline", "loss"}:
            if self._active_event_id is not None:
                self._after_event_id = self._active_event_id
            self.media.clear_on_control_disconnect(); self._active_event_id = self._probe_event_id = None
            return
        event_id, pattern = event.get("comment"), event.get("pattern")
        if not isinstance(event_id, str) or not event_id:
            self.media.clear_on_control_disconnect(); self._active_event_id = self._probe_event_id = None; return
        binding = self._read_json(self._relay_binding_path)
        # The controller persists the authority-sealed media tuple in the
        # event before it becomes armed.  A later binding-file replacement
        # must never retarget that event to a different ChannelData stream.
        # Leave the event unarmed until the exact sealed tuple is present.
        if (binding is None or event.get("mediaBinding") != binding.get("mediaBinding")
                or self._target_from_binding(binding) is None):
            self.media.clear_on_control_disconnect()
            return
        if self._counter_store is None:
            return
        media = event["mediaBinding"]
        started, deadline = event.get("startedMonotonicNs"), event.get("deadlineMonotonicNs")
        if not isinstance(started, int) or not isinstance(deadline, int):
            self.media.clear_on_control_disconnect(); return
        try:
            self._counter_store.begin(event_id, media_binding=media, started_ns=started,
                                      deadline_ns=deadline, before_sequences=tuple(self._recent_forwarded))
        except (RuntimeError, ValueError):
            self.media.clear_on_control_disconnect(); return
        if event.get("mode") == "baseline":
            self.media.clear_on_control_disconnect(); self._probe_event_id = event_id; self._active_event_id = None
            return
        self._probe_event_id = None
        if event_id in self._completed_event_ids:
            self.media.clear_on_control_disconnect(); return
        if self._active_event_id != event_id:
            if not isinstance(pattern, str): return
            self.media.arm(pattern, now_ns=started)
            self._active_event_id = event_id

    @property
    def control_endpoint(self) -> tuple[str, int]:
        if self.control_port not in self._front:
            raise GatewayBlocked("gateway is not started")
        return self._front[self.control_port].getsockname()[:2]

    def start(self) -> None:
        if self._front:
            raise GatewayBlocked("gateway is already started")
        # An inline forwarder has no durable ownership of a previously armed
        # fault.  On process restart, remove the per-run intent before opening
        # any public socket so a stale 30-second window cannot be replayed.
        if self._state_path is not None:
            try:
                self._state_path.unlink()
            except FileNotFoundError:
                pass
        for requested in (self.control_port, *self.relay_ports):
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.bind((self.bind_host, requested)); sock.setblocking(False)
            actual_port = int(sock.getsockname()[1])
            if actual_port in self._front:
                sock.close(); raise GatewayBlocked("gateway public port collision")
            self._front[actual_port] = sock
            self._selector.register(sock, selectors.EVENT_READ, ("front", actual_port))
        # A requested port 0 becomes its bound port and remains the control one.
        if self.control_port == 0:
            self.control_port = next(iter(self._front))

    def client_mappings(self) -> tuple[ClientMapping, ...]:
        return self._table.values()

    def _ensure_runtime(self, mapping: ClientMapping) -> tuple[socket.socket, TurnAssociation]:
        existing = self._runtime.get(mapping.upstream_id)
        if existing is not None:
            return existing
        upstream = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # bind without connect: data may arrive from coturn's relay ports.
        upstream.bind((self.bind_host, 0)); upstream.setblocking(False)
        association = TurnAssociation(client_id=str(mapping.upstream_id))
        self._runtime[mapping.upstream_id] = (upstream, association)
        self._selector.register(upstream, selectors.EVENT_READ, ("upstream", mapping.upstream_id))
        return upstream, association

    def _from_front(self, port: int) -> None:
        front = self._front[port]
        payload, endpoint = front.recvfrom(65535)
        if port != self.control_port:
            target = self.relay_endpoints.get(port, (self.turn_endpoint[0], port))
            key = (port, (str(endpoint[0]), int(endpoint[1])))
            upstream = self._relay_runtime.get(key)
            if upstream is None:
                upstream = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                upstream.bind((self.bind_host, 0)); upstream.setblocking(False)
                self._relay_runtime[key] = upstream
                self._selector.register(upstream, selectors.EVENT_READ, ("relay", key))
            upstream.sendto(payload, target)
            return
        mapping = self._table.bind((str(endpoint[0]), int(endpoint[1])))
        upstream, association = self._ensure_runtime(mapping)
        association.observe_client(payload)
        upstream.sendto(payload, self.turn_endpoint)

    def _from_upstream(self, upstream_id: int) -> None:
        upstream, association = self._runtime[upstream_id]
        payload, source = upstream.recvfrom(65535)
        if source[0] not in self._allowed_turn_hosts or source[1] not in {self.turn_endpoint[1], *self.relay_ports}:
            return
        association.observe_server(payload)
        mapping = next((item for item in self._table.values() if item.upstream_id == upstream_id), None)
        if mapping is None:
            return
        self._record_media_observation(upstream_id=upstream_id, association=association, payload=payload, source=source, upstream=upstream)
        decision = (self.media.observe_baseline(client_id=str(upstream_id), payload=payload)
                    if self._probe_event_id is not None else self.media.decide(client_id=str(upstream_id), payload=payload))
        event_id = self._active_event_id or self._probe_event_id
        if decision.sequence is not None and self._counter_store is not None and event_id is not None and decision.drop:
            self._counter_store.record(event_id, phase="during", eligible=decision.eligible, dropped=True, sequence=decision.sequence)
        if self.media.armed is None and self._active_event_id is not None:
            self._completed_event_ids.add(self._active_event_id)
        if decision.drop:
            return
        try:
            self._front.get(int(source[1]), self._front[self.control_port]).sendto(decision.payload, mapping.client_endpoint)
        except OSError:
            if decision.sequence is not None and self._counter_store is not None and event_id is not None:
                self._counter_store.record_send_failure(event_id)
            return
        if decision.sequence is not None:
            self._recent_forwarded.append(decision.sequence)
            if self._counter_store is not None:
                if event_id is not None:
                    self._counter_store.record(event_id, phase="during", eligible=decision.eligible, dropped=False, sequence=decision.sequence)
                elif self._after_event_id is not None:
                    self._counter_store.record(self._after_event_id, phase="after", eligible=False, dropped=False, sequence=decision.sequence)

    def _from_relay_upstream(self, key: tuple[int, tuple[str, int]]) -> None:
        upstream = self._relay_runtime[key]
        payload, source = upstream.recvfrom(65535)
        port, peer = key
        expected = self.relay_endpoints.get(port, (self.turn_endpoint[0], port))
        if (str(source[0]), int(source[1])) != expected:
            return
        self._front[port].sendto(payload, peer)

    def poll(self, *, timeout_s: float = .1) -> None:
        self.sync_control_state()
        for key, _ in self._selector.select(timeout_s):
            kind, value = key.data
            if kind == "front":
                self._from_front(value)
            elif kind == "upstream":
                self._from_upstream(value)
            else:
                self._from_relay_upstream(value)

    def close(self) -> None:
        self.media.clear_on_control_disconnect()
        for sock, _ in self._runtime.values():
            try: self._selector.unregister(sock)
            except Exception: pass
            sock.close()
        self._runtime.clear()
        for sock in self._relay_runtime.values():
            try: self._selector.unregister(sock)
            except Exception: pass
            sock.close()
        self._relay_runtime.clear()
        for sock in self._front.values():
            try: self._selector.unregister(sock)
            except Exception: pass
            sock.close()
        self._front.clear(); self._selector.close()


def _main() -> None:
    parser = argparse.ArgumentParser(description="Lab-only inline UDP TURN gateway")
    parser.add_argument("--turn-host", required=True)
    parser.add_argument("--turn-port", type=int, default=3478)
    parser.add_argument("--bind-host", default="0.0.0.0")
    parser.add_argument("--control-port", type=int, default=3478)
    parser.add_argument("--relay-start", type=int, default=51000)
    parser.add_argument("--relay-end", type=int, default=51009)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--relay-binding", type=Path, required=True)
    parser.add_argument("--counters", type=Path, required=True)
    parser.add_argument("--capture-authority", type=Path)
    parser.add_argument("--capture-capability", type=Path)
    parser.add_argument("--run-id")
    arguments = parser.parse_args()
    gateway = InlineTurnGateway(turn_endpoint=(arguments.turn_host, arguments.turn_port), bind_host=arguments.bind_host,
                                control_port=arguments.control_port, relay_ports=tuple(range(arguments.relay_start, arguments.relay_end + 1)))
    gateway.configure_control_bridge(state_path=arguments.state, relay_binding_path=arguments.relay_binding, counter_path=arguments.counters)
    if any(value is not None for value in (arguments.capture_authority, arguments.capture_capability, arguments.run_id)):
        if arguments.capture_authority is None or arguments.capture_capability is None or arguments.run_id is None:
            raise SystemExit("gateway observation bridge arguments must be supplied together")
        gateway.configure_observation_bridge(capture_socket_path=arguments.capture_authority, capture_capability_path=arguments.capture_capability, run_id=arguments.run_id)
    gateway.start()
    try:
        while True: gateway.poll(timeout_s=.1)
    except KeyboardInterrupt:
        pass
    finally:
        gateway.close()


if __name__ == "__main__":
    _main()
