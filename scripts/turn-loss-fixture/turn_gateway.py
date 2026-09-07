"""Lab-only in-path UDP TURN gateway state; network loop is deliberately separate."""
from __future__ import annotations

from dataclasses import dataclass
import selectors
import socket
import time

from gateway_evidence import GatewayLossCounter
from turn_wire import COOKIE, WireProtocolError, parse_channel_data_video, parse_stun


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

    def decide(self, *, client_id: str, payload: bytes, now_ns: int | None = None) -> GatewayDecision:
        target, armed = self._target, self.armed
        if target is None or armed is None or target[0] != client_id:
            return GatewayDecision(False, payload)
        video = parse_channel_data_video(payload, channel_number=target[1], payload_type=target[2], ssrc=target[3])
        if video is None:
            return GatewayDecision(False, payload)
        forward = armed.observe(sequence=video.sequence, now_ns=time.monotonic_ns() if now_ns is None else int(now_ns))
        if armed.deadline_expired:
            self.armed = None
        return GatewayDecision(not forward, payload, video.sequence)


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

    @property
    def control_endpoint(self) -> tuple[str, int]:
        if self.control_port not in self._front:
            raise GatewayBlocked("gateway is not started")
        return self._front[self.control_port].getsockname()[:2]

    def start(self) -> None:
        if self._front:
            raise GatewayBlocked("gateway is already started")
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
        if source[0] != self.turn_endpoint[0] or source[1] not in {self.turn_endpoint[1], *self.relay_ports}:
            return
        association.observe_server(payload)
        mapping = next((item for item in self._table.values() if item.upstream_id == upstream_id), None)
        if mapping is None:
            return
        decision = self.media.decide(client_id=str(upstream_id), payload=payload)
        if decision.drop:
            return
        self._front.get(int(source[1]), self._front[self.control_port]).sendto(decision.payload, mapping.client_endpoint)

    def _from_relay_upstream(self, key: tuple[int, tuple[str, int]]) -> None:
        upstream = self._relay_runtime[key]
        payload, source = upstream.recvfrom(65535)
        port, peer = key
        expected = self.relay_endpoints.get(port, (self.turn_endpoint[0], port))
        if (str(source[0]), int(source[1])) != expected:
            return
        self._front[port].sendto(payload, peer)

    def poll(self, *, timeout_s: float = .1) -> None:
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
