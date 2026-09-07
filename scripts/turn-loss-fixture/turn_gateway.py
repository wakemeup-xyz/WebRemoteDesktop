"""Lab-only in-path UDP TURN gateway state; network loop is deliberately separate."""
from __future__ import annotations

from dataclasses import dataclass
import argparse
import base64
from collections import deque
import hashlib
import hmac
import json
from pathlib import Path
import selectors
import secrets
import socket
import socketserver
import threading
import time

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

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


class GatewayObservationAuthority:
    """Gateway-owned passive observations and Ed25519-signed receipts.

    The private key lives only in the gateway process.  Control callers may
    submit an expectation, but cannot submit observations or write ledger rows.
    """
    def __init__(self, *, run_id: str, realm: str, control_token: str) -> None:
        if not isinstance(run_id, str) or not run_id or not isinstance(realm, str) or not realm or not isinstance(control_token, str) or not control_token:
            raise ValueError("gateway authority identity is invalid")
        self.run_id, self.realm, self.instance_id, self._token = run_id, realm, secrets.token_urlsafe(18), control_token
        self._private = Ed25519PrivateKey.generate()
        self._public_key = self._private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()
        self.instance_digest = hashlib.sha256(self._canonical({"runId": run_id, "realm": realm, "gatewayInstanceId": self.instance_id, "publicKey": self._public_key})).hexdigest()
        self._observations: list[dict] = []
        self._lock = threading.RLock()

    @staticmethod
    def _canonical(value: object) -> bytes:
        return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()

    def _signed(self, body: dict) -> dict:
        signature = base64.b64encode(self._private.sign(self._canonical(body))).decode("ascii")
        return {**body, "signatureAlgorithm": "Ed25519", "signature": signature}

    def manifest(self) -> dict:
        return {"runId": self.run_id, "realm": self.realm, "gatewayInstanceId": self.instance_id,
                "publicKey": self._public_key, "instanceDigest": self.instance_digest}

    def observe(self, row: dict) -> None:
        with self._lock:
            if row not in self._observations:
                self._observations.append(dict(row))

    def select(self, expected: dict) -> dict:
        required = {"allocationRelay", "peer", "rtpSsrc", "viewerPair", "hostPair"}
        if not isinstance(expected, dict) or set(expected) != required:
            raise GatewayBlocked("gateway media expectation is invalid")
        relay, peer, ssrc, viewer, host = expected["allocationRelay"], expected["peer"], expected["rtpSsrc"], expected["viewerPair"], expected["hostPair"]
        if (not isinstance(relay, dict) or not isinstance(peer, dict) or not isinstance(ssrc, int)
                or not isinstance(viewer, dict) or not isinstance(host, dict) or not isinstance(host.get("videoSsrc"), int)
                or host["videoSsrc"] != ssrc):
            raise GatewayBlocked("gateway browser/Host media expectation is invalid")
        try:
            vl, vr, hl, hr = viewer["local"], viewer["remote"], host["local"], host["remote"]
            endpoint = lambda value: (value["address"], value["port"])
            if (vl.get("candidateType") != "relay" or hr.get("candidateType") != "relay"
                    or endpoint(vr) != endpoint(hl) or endpoint(vl) != endpoint(hr)
                    or endpoint(vl) != (relay["address"], relay["port"])
                    or endpoint(vr) != (peer["address"], peer["port"])):
                raise GatewayBlocked("gateway selected pair is not reciprocal")
        except (KeyError, TypeError):
            raise GatewayBlocked("gateway selected pair is invalid") from None
        with self._lock:
            matches = [row for row in self._observations if all(row.get(key) == expected[key] for key in ("allocationRelay", "peer", "rtpSsrc"))]
            count = len(self._observations)
        if len(matches) != 1:
            raise GatewayBlocked("gateway media observation is absent or ambiguous")
        digest = hashlib.sha256(self._canonical(matches[0])).hexdigest()
        body = {**self.manifest(), "mediaBinding": matches[0], "mediaBindingDigest": digest, "observationCount": count}
        return {"status": "SEALED", **self._signed(body)}

    def receipt(self, event_handle: str, store: GatewayCounterStore) -> dict:
        count = store.count(event_handle)
        body = {**self.manifest(), "eventHandle": event_handle, "mediaBindingDigest": count["mediaBindingDigest"], "gatewayCounters": count}
        return {"status": "SEALED", "receipt": self._signed(body)}

    def status(self) -> dict:
        with self._lock:
            return {"status": "READY", **self.manifest(), "observationCount": len(self._observations)}

    def authorized(self, token: object) -> bool:
        return isinstance(token, str) and hmac.compare_digest(token, self._token)


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
        self._authority: GatewayObservationAuthority | None = None
        self._authority_server: socketserver.ThreadingTCPServer | None = None
        self._authority_port: int | None = None
        self._observed_media: set[tuple[int, int, int]] = set()
        self._sealed_binding: dict | None = None
        self._observation_host: str | None = None
        self._recent_forwarded: deque[int] = deque(maxlen=256)

    def _gateway_address(self) -> str:
        if self._observation_host is not None:
            return self._observation_host
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(self.turn_endpoint)
            self._observation_host = str(probe.getsockname()[0])
        except OSError:
            self._observation_host = self.bind_host
        finally:
            probe.close()
        return self._observation_host

    def configure_control_bridge(self, *, state_path: Path, relay_binding_path: Path, counter_path: Path) -> None:
        """Attach the Lab-only file bridge after all paths have been fixed.

        The controller owns the control state.  This gateway only reads the
        selected, sealed binding and records header counters under `/state`.
        """
        self._state_path = Path(state_path)
        self._relay_binding_path = Path(relay_binding_path)
        self._counter_store = GatewayCounterStore(counter_path)

    def configure_authority(self, *, run_id: str, realm: str, control_token: str, port: int) -> None:
        if not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError("gateway authority port is invalid")
        self._authority = GatewayObservationAuthority(run_id=run_id, realm=realm, control_token=control_token)
        self._authority_port = port

    def _record_media_observation(self, *, upstream_id: int, association: TurnAssociation, payload: bytes, source: tuple[str, int], upstream: socket.socket) -> None:
        """Record a passive header-only observation inside the gateway process."""
        if self._authority is None:
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
        local = upstream.getsockname()
        observation = {"outerEgress": {"protocol": "udp", "source": str(source[0]), "sourcePort": int(source[1]),
                                         "destination": str(local[0]), "destinationPort": int(local[1])},
                       "allocationRelay": {"address": association.relay[0], "port": association.relay[1]},
                       "peer": {"address": association.confirmed_channels[parsed[0]][0], "port": association.confirmed_channels[parsed[0]][1]},
                       "channelNumber": parsed[0], "encapsulation": "channel-data", "rtpSsrc": rtp.ssrc, "payloadType": rtp.payload_type}
        self._authority.observe(observation)
        self._observed_media.add(key)

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
        binding = self._sealed_binding
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
            # The controller timestamp binds the ledger, while the finite
            # packet window begins only once this in-path gateway actually
            # consumes the armed control state.  Starting at the controller
            # write time could make the 200ms test expire before the gateway
            # has observed a single packet.
            self.media.arm(pattern)
            self._active_event_id = event_id

    @property
    def control_endpoint(self) -> tuple[str, int]:
        if self.control_port not in self._front:
            raise GatewayBlocked("gateway is not started")
        return self._front[self.control_port].getsockname()[:2]

    def _start_authority_server(self) -> None:
        authority = self._authority
        if authority is None or self._authority_port is None:
            return
        gateway = self
        class Handler(socketserver.StreamRequestHandler):
            def handle(self) -> None:
                try:
                    raw = json.loads(self.rfile.readline(65536))
                    if not isinstance(raw, dict) or not authority.authorized(raw.get("controlToken")):
                        raise GatewayBlocked("gateway authority token is invalid")
                    operation = raw.get("operation")
                    if operation == "health" and set(raw) == {"operation", "controlToken"}:
                        reply = authority.status()
                        reply["activeEvent"] = gateway._active_event_id
                        reply["baselineEvent"] = gateway._probe_event_id
                    elif operation == "select-media-binding" and set(raw) == {"operation", "controlToken", "expected"}:
                        reply = authority.select(raw["expected"])
                        gateway._sealed_binding = {"mediaBinding": reply["mediaBinding"]}
                    elif operation == "event-receipt" and set(raw) == {"operation", "controlToken", "eventHandle"} and isinstance(raw.get("eventHandle"), str) and gateway._counter_store is not None:
                        reply = authority.receipt(raw["eventHandle"], gateway._counter_store)
                    else:
                        raise GatewayBlocked("gateway authority operation is unavailable")
                except Exception as exc:
                    reply = {"status": "BLOCKED", "reason": type(exc).__name__}
                self.wfile.write((json.dumps(reply, sort_keys=True) + "\n").encode())
        server = socketserver.ThreadingTCPServer((self.bind_host, self._authority_port), Handler)
        server.allow_reuse_address = True
        server.daemon_threads = True
        self._authority_server = server
        threading.Thread(target=server.serve_forever, daemon=True).start()

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
        self._start_authority_server()

    def client_mappings(self) -> tuple[ClientMapping, ...]:
        return self._table.values()

    def _ensure_runtime(self, mapping: ClientMapping) -> tuple[socket.socket, TurnAssociation]:
        existing = self._runtime.get(mapping.upstream_id)
        if existing is not None:
            return existing
        upstream = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # bind without connect: data may arrive from coturn's relay ports.
        upstream.bind((self._gateway_address(), 0)); upstream.setblocking(False)
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
        if self._authority_server is not None:
            self._authority_server.shutdown(); self._authority_server.server_close(); self._authority_server = None
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
    parser.add_argument("--credentials", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--authority-port", type=int, default=19092)
    arguments = parser.parse_args()
    gateway = InlineTurnGateway(turn_endpoint=(arguments.turn_host, arguments.turn_port), bind_host=arguments.bind_host,
                                control_port=arguments.control_port, relay_ports=tuple(range(arguments.relay_start, arguments.relay_end + 1)))
    gateway.configure_control_bridge(state_path=arguments.state, relay_binding_path=arguments.relay_binding, counter_path=arguments.counters)
    credentials = json.loads(arguments.credentials.read_text(encoding="utf-8"))
    token = credentials.get("controlToken") if isinstance(credentials, dict) else None
    if not isinstance(token, str) or not token:
        raise SystemExit("gateway authority control token is unavailable")
    realm = credentials.get("realm") if isinstance(credentials, dict) else None
    if not isinstance(realm, str) or not realm:
        raise SystemExit("gateway authority realm is unavailable")
    gateway.configure_authority(run_id=arguments.run_id, realm=realm, control_token=token, port=arguments.authority_port)
    gateway.start()
    try:
        while True: gateway.poll(timeout_s=.1)
    except KeyboardInterrupt:
        pass
    finally:
        gateway.close()


if __name__ == "__main__":
    _main()
