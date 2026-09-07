"""Lab-only in-path UDP TURN gateway state; network loop is deliberately separate."""
from __future__ import annotations

from dataclasses import dataclass
import time

from gateway_evidence import GatewayLossCounter
from turn_wire import parse_channel_data_video


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
