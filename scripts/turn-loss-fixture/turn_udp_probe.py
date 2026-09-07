"""Bounded TURN/UDP Allocate readiness probe for the disposable fixture."""
from __future__ import annotations
import hashlib, hmac, os, socket, struct
from typing import Any
COOKIE = 0x2112A442

def _pad(value: bytes) -> bytes: return value + b"\0" * ((-len(value)) % 4)
def _attr(kind: int, value: bytes) -> bytes: return struct.pack("!HH", kind, len(value)) + _pad(value)
def _message(kind: int, txid: bytes, attributes: bytes) -> bytes: return struct.pack("!HHI", kind, len(attributes), COOKIE) + txid + attributes
def _parse(data: bytes) -> tuple[int, bytes, dict[int, bytes]]:
    if len(data) < 20: raise RuntimeError("short STUN response")
    kind, length, cookie = struct.unpack("!HHI", data[:8])
    if cookie != COOKIE or length + 20 != len(data): raise RuntimeError("invalid STUN response")
    result: dict[int, bytes] = {}; i = 20
    while i < len(data):
        if i + 4 > len(data): raise RuntimeError("truncated STUN attribute")
        code, size = struct.unpack("!HH", data[i:i+4]); i += 4
        if i + size > len(data): raise RuntimeError("truncated STUN value")
        result[code] = data[i:i+size]; i += size + ((-size) % 4)
    return kind, data[8:20], result

def allocate_probe(host: str, port: int, username: str, password: str, *, timeout: float = 2.0, udp_socket: Any = None) -> dict[str, Any]:
    """Perform actual long-term TURN Allocate and require relayed-address proof."""
    if not all(isinstance(v, str) and v for v in (host, username, password)) or not isinstance(port, int): raise ValueError("fixture TURN credentials are required")
    sock = udp_socket or socket.socket(socket.AF_INET, socket.SOCK_DGRAM); own = udp_socket is None
    try:
        sock.settimeout(timeout); txid = os.urandom(12); request = _message(0x0003, txid, _attr(0x0019, b"\x11\0\0\0")); sock.sendto(request, (host, port)); data, _ = sock.recvfrom(4096)
        kind, received, attrs = _parse(data)
        if received != txid or kind != 0x0113 or 0x0014 not in attrs or 0x0015 not in attrs: raise RuntimeError("TURN Allocate did not return a credential challenge")
        realm, nonce = attrs[0x0014], attrs[0x0015]
        second = os.urandom(12)
        sock.sendto(_authenticated(0x0003, second, username, password, realm, nonce, _attr(0x0019, b"\x11\0\0\0")), (host, port)); data, _ = sock.recvfrom(4096); kind, received, attrs = _parse(data)
        if received != second or kind != 0x0103 or 0x0016 not in attrs: raise RuntimeError("TURN Allocate did not establish a relay allocation")
        return {"status":"READY", "relayAddressAttribute": attrs[0x0016].hex(), "realm": realm.decode(errors="strict")}
    except (OSError, UnicodeDecodeError) as exc: raise RuntimeError("TURN UDP Allocate probe failed") from exc
    finally:
        if own: sock.close()

def _xor_peer(host: str, port: int, txid: bytes) -> bytes:
    raw = socket.inet_aton(host); return b'\0\x01' + struct.pack('!H', port ^ (COOKIE >> 16)) + bytes(a ^ b for a,b in zip(raw, struct.pack('!I', COOKIE)))
def _xor_decode(value: bytes, txid: bytes) -> tuple[str,int]:
    if len(value) != 8: raise RuntimeError('invalid XOR peer')
    port=struct.unpack('!H',value[2:4])[0] ^ (COOKIE>>16); raw=bytes(a^b for a,b in zip(value[4:],struct.pack('!I',COOKIE))); return socket.inet_ntoa(raw),port

def relay_echo_probe(host: str, port: int, username: str, password: str, peer_host: str, peer_port: int, *, timeout: float=2.0, udp_socket: Any=None) -> dict[str,Any]:
    """Allocate, CreatePermission, and require nonce returned as TURN DATA."""
    allocation=allocate_probe(host,port,username,password,timeout=timeout,udp_socket=udp_socket)
    # A concrete socket adapter may preserve the authenticated challenge; the
    # fixture's operational implementation provides this method atomically.
    if not hasattr(udp_socket, 'turn_permission_echo'):
        raise RuntimeError('TURN relay echo transport is unavailable')
    nonce=os.urandom(24); echoed=udp_socket.turn_permission_echo(peer_host,peer_port,nonce,timeout)
    if not isinstance(echoed,bytes) or not hmac.compare_digest(echoed,nonce): raise RuntimeError('TURN relay echo payload mismatch')
    body={'allocation':allocation['relayAddressAttribute'],'peer':f'{peer_host}:{peer_port}','nonce':nonce.hex()}
    return {**allocation,'peer':body['peer'],'nonce':body['nonce'],'echoDigest':hashlib.sha256(repr(body).encode()).hexdigest()}

def _authenticated(kind: int, txid: bytes, username: str, password: str, realm: bytes, nonce: bytes, extra: bytes) -> bytes:
    attrs=extra+_attr(0x0006,username.encode())+_attr(0x0014,realm)+_attr(0x0015,nonce)
    key=hashlib.md5(username.encode()+b':'+realm+b':'+password.encode()).digest()
    # RFC 5389 computes HMAC over the message through the attribute *before*
    # MESSAGE-INTEGRITY.  The header length nevertheless includes its 24-byte
    # TLV, otherwise coturn rightfully returns 401 Unauthorized.
    header=struct.pack("!HHI",kind,len(attrs)+24,COOKIE)+txid
    integrity=hmac.new(key,header+attrs,hashlib.sha1).digest()
    return header+attrs+_attr(0x0008,integrity)


class PersistentTurnAllocation:
    """Fixture-test TURN allocation that keeps one authenticated UDP socket alive."""
    def __init__(self, host: str, port: int, username: str, password: str, peer_host: str, peer_port: int, *, timeout: float = 2.0, channel: int = 0x4001) -> None:
        self.host, self.port, self.username, self.password = host, int(port), username, password
        self.peer_host, self.peer_port, self.timeout, self.channel = peer_host, int(peer_port), float(timeout), int(channel)
        self.sock: socket.socket | None = None; self.realm = self.nonce = None
        self.relay_host = self.relay_port = None; self.last_server: tuple[str, int] | None = None

    def __enter__(self) -> "PersistentTurnAllocation":
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); self.sock.settimeout(self.timeout)
        # A connected UDP socket gives the passive receiver a concrete local
        # destination rather than the wildcard address returned by an
        # unconnected socket.  TURN control and ChannelData still retain the
        # same allocation/socket for their whole lifetime.
        self.sock.connect((self.host, self.port))
        tx = os.urandom(12); self.sock.send(_message(0x0003, tx, _attr(0x0019, b"\x11\0\0\0"))); raw, _ = self.sock.recvfrom(4096); kind, got, attrs = _parse(raw)
        if kind != 0x0113 or got != tx or 0x0014 not in attrs or 0x0015 not in attrs: raise RuntimeError("TURN allocation challenge unavailable")
        self.realm, self.nonce = attrs[0x0014], attrs[0x0015]; tx = os.urandom(12)
        self.sock.send(_authenticated(0x0003, tx, self.username, self.password, self.realm, self.nonce, _attr(0x0019, b"\x11\0\0\0"))); raw, _ = self.sock.recvfrom(4096); kind, got, attrs = _parse(raw)
        if kind != 0x0103 or got != tx or 0x0016 not in attrs: raise RuntimeError("TURN allocation unavailable")
        self.relay_host, self.relay_port = _xor_decode(attrs[0x0016], tx)
        tx = os.urandom(12)
        self.sock.send(_authenticated(0x0008, tx, self.username, self.password, self.realm, self.nonce, _attr(0x0012, _xor_peer(self.peer_host, self.peer_port, tx)))); raw, _ = self.sock.recvfrom(4096); kind, got, _ = _parse(raw)
        if kind != 0x0108 or got != tx: raise RuntimeError("TURN CreatePermission failed")
        self.bind_channel(self.channel)
        return self

    def bind_channel(self, channel: int, *, peer_host: str | None = None, peer_port: int | None = None) -> int:
        if self.sock is None or self.realm is None or self.nonce is None:
            raise RuntimeError("TURN allocation is closed")
        channel = int(channel)
        if not 0x4000 <= channel <= 0x7FFF:
            raise ValueError("TURN channel is invalid")
        peer_host = self.peer_host if peer_host is None else peer_host
        peer_port = self.peer_port if peer_port is None else int(peer_port)
        tx = os.urandom(12)
        bind = _attr(0x000C, struct.pack("!H", channel) + b"\0\0") + _attr(0x0012, _xor_peer(peer_host, peer_port, tx))
        self.sock.send(_authenticated(0x0009, tx, self.username, self.password, self.realm, self.nonce, bind)); raw, _ = self.sock.recvfrom(4096); kind, got, _ = _parse(raw)
        if kind != 0x0109 or got != tx: raise RuntimeError("TURN ChannelBind failed")
        return channel

    def send_channel_payload(self, channel: int, payload: bytes, *, expect_echo: bool = True) -> bytes | None:
        if self.sock is None: raise RuntimeError("TURN allocation is closed")
        if not isinstance(payload, bytes) or not 0x4000 <= int(channel) <= 0x7FFF:
            raise ValueError("TURN ChannelData payload is invalid")
        packet = struct.pack("!HH", int(channel), len(payload)) + _pad(payload)
        self.sock.send(packet)
        if not expect_echo:
            return None
        raw, server = self.sock.recvfrom(4096)
        if len(raw) < 4 or struct.unpack("!HH", raw[:4]) != (int(channel), len(payload)) or raw[4:4 + len(payload)] != payload:
            raise RuntimeError(f"TURN ChannelData media echo mismatch: {raw[:64].hex()}")
        self.last_server = (str(server[0]), int(server[1]))
        return raw[4:4 + len(payload)]

    def send_rtp(self, sequence: int, ssrc: int, *, payload_type: int = 96, expect_echo: bool = True) -> dict[str, Any] | None:
        if self.sock is None or self.relay_host is None or self.relay_port is None: raise RuntimeError("TURN allocation is closed")
        rtp = bytes((0x80, payload_type)) + struct.pack("!HII", int(sequence), int(sequence), int(ssrc)) + b"fixture"
        echoed = self.send_channel_payload(self.channel, rtp, expect_echo=expect_echo)
        if echoed is None:
            return None
        local = self.sock.getsockname()
        server = self.last_server
        if server is None: raise RuntimeError("TURN ChannelData sender is unavailable")
        return {"outerEgress": {"protocol": "udp", "source": server[0], "sourcePort": server[1], "destination": str(local[0]), "destinationPort": int(local[1])},
                "allocationRelay": {"address": self.relay_host, "port": self.relay_port}, "peer": {"address": self.peer_host, "port": self.peer_port},
                "channelNumber": self.channel, "encapsulation": "channel-data", "rtpSsrc": int(ssrc), "payloadType": int(payload_type)}

    def close(self) -> None:
        if self.sock is None: return
        try:
            tx = os.urandom(12); self.sock.send(_authenticated(0x0004, tx, self.username, self.password, self.realm, self.nonce, _attr(0x000D, b"\0\0\0\0")))
            self.sock.recvfrom(4096)
        except (OSError, RuntimeError, TypeError): pass
        self.sock.close(); self.sock = None

    def __exit__(self, *_: object) -> None: self.close()

def permission_send_data_echo(host: str, port: int, username: str, password: str, peer_host: str, peer_port: int, *, timeout: float=2.0, udp_socket: Any=None) -> dict[str,Any]:
    """Concrete TURN UDP CreatePermission -> Send -> Data indication exchange."""
    sock=udp_socket or socket.socket(socket.AF_INET,socket.SOCK_DGRAM); own=udp_socket is None
    try:
      sock.settimeout(timeout); tx=os.urandom(12); sock.sendto(_message(0x0003,tx,_attr(0x0019,b'\x11\0\0\0')),(host,port)); raw,_=sock.recvfrom(4096); kind,got,a=_parse(raw)
      if kind != 0x0113 or got != tx or 0x0014 not in a or 0x0015 not in a: raise RuntimeError('TURN allocation challenge unavailable')
      realm,nonce=a[0x0014],a[0x0015]; tx=os.urandom(12); sock.sendto(_authenticated(0x0003,tx,username,password,realm,nonce,_attr(0x0019,b'\x11\0\0\0')),(host,port)); raw,_=sock.recvfrom(4096); kind,got,a=_parse(raw)
      if kind != 0x0103 or got != tx or 0x0016 not in a:
          error = a.get(0x0009, b"").decode(errors="replace")
          raise RuntimeError(f'TURN allocation unavailable: {error or hex(kind)}')
      allocation=a[0x0016].hex(); peer=_xor_peer(peer_host,peer_port,tx); tx=os.urandom(12); sock.sendto(_authenticated(0x0008,tx,username,password,realm,nonce,_attr(0x0012,peer)),(host,port)); raw,_=sock.recvfrom(4096); kind,got,a=_parse(raw)
      if kind != 0x0108 or got != tx: raise RuntimeError('TURN CreatePermission failed')
      payload=os.urandom(24); sock.sendto(_message(0x0016,os.urandom(12),_attr(0x0012,_xor_peer(peer_host,peer_port,b''))+_attr(0x0013,payload)),(host,port)); raw,_=sock.recvfrom(4096); kind,_,a=_parse(raw)
      if kind != 0x0017 or 0x0012 not in a or 0x0013 not in a or _xor_decode(a[0x0012],b'') != (peer_host,peer_port) or not hmac.compare_digest(a[0x0013],payload): raise RuntimeError('TURN relay Data indication mismatch')
      body={'allocation':allocation,'peer':f'{peer_host}:{peer_port}','nonce':payload.hex()}; return {**body,'digest':hashlib.sha256(repr(body).encode()).hexdigest()}
    except OSError as exc: raise RuntimeError('TURN relay echo timed out') from exc
    finally:
      if own: sock.close()


def channel_media_binding_echo(host: str, port: int, username: str, password: str, peer_host: str, peer_port: int, *, rtp_ssrc: int, timeout: float = 2.0) -> dict[str, Any]:
    """Prove one real coturn allocation, ChannelBind and inbound RTP payload.

    The returned tuple is observer evidence, never a browser self-report: C is
    the TURN client socket, S is recvfrom()'s TURN endpoint, R comes from the
    authenticated Allocate response, and H/channel originate in the successful
    CreatePermission/ChannelBind exchange.
    """
    if not isinstance(rtp_ssrc, int) or not 0 <= rtp_ssrc <= 0xffffffff: raise ValueError("RTP SSRC is required")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.settimeout(timeout)
        tx = os.urandom(12); sock.sendto(_message(0x0003, tx, _attr(0x0019, b"\x11\0\0\0")), (host, port)); raw, _ = sock.recvfrom(4096); kind, got, attrs = _parse(raw)
        if kind != 0x0113 or got != tx or 0x0014 not in attrs or 0x0015 not in attrs: raise RuntimeError("TURN allocation challenge unavailable")
        realm, nonce = attrs[0x0014], attrs[0x0015]; tx = os.urandom(12)
        sock.sendto(_authenticated(0x0003, tx, username, password, realm, nonce, _attr(0x0019, b"\x11\0\0\0")), (host, port)); raw, _ = sock.recvfrom(4096); kind, got, attrs = _parse(raw)
        if kind != 0x0103 or got != tx or 0x0016 not in attrs: raise RuntimeError("TURN allocation unavailable")
        relay_host, relay_port = _xor_decode(attrs[0x0016], tx)
        peer = _xor_peer(peer_host, peer_port, tx); tx = os.urandom(12)
        sock.sendto(_authenticated(0x0008, tx, username, password, realm, nonce, _attr(0x0012, peer)), (host, port)); raw, _ = sock.recvfrom(4096); kind, got, _ = _parse(raw)
        if kind != 0x0108 or got != tx: raise RuntimeError("TURN CreatePermission failed")
        channel = 0x4001; tx = os.urandom(12)
        bind = _attr(0x000C, struct.pack("!H", channel) + b"\0\0") + _attr(0x0012, _xor_peer(peer_host, peer_port, tx))
        sock.sendto(_authenticated(0x0009, tx, username, password, realm, nonce, bind), (host, port)); raw, _ = sock.recvfrom(4096); kind, got, _ = _parse(raw)
        if kind != 0x0109 or got != tx: raise RuntimeError("TURN ChannelBind failed")
        rtp = bytes([0x80, 96, 0, 1, 0, 0, 0, 1]) + struct.pack("!I", rtp_ssrc) + os.urandom(12)
        sock.sendto(struct.pack("!HH", channel, len(rtp)) + rtp + b"\0" * ((-len(rtp)) % 4), (host, port))
        raw, server = sock.recvfrom(4096)
        if len(raw) < 16 or struct.unpack("!H", raw[:2])[0] != channel or struct.unpack("!H", raw[2:4])[0] != len(rtp) or raw[4:4 + len(rtp)] != rtp:
            raise RuntimeError("TURN ChannelData media echo mismatch")
        client_host, client_port = sock.getsockname()[:2]
        return {"outerEgress": {"protocol": "udp", "source": str(server[0]), "sourcePort": int(server[1]), "destination": str(client_host), "destinationPort": int(client_port)},
                "allocationRelay": {"address": relay_host, "port": relay_port}, "peer": {"address": peer_host, "port": peer_port},
                "channelNumber": channel, "encapsulation": "channel-data", "rtpSsrc": rtp_ssrc, "payloadType": 96}
    except OSError as exc:
        raise RuntimeError("TURN ChannelData media binding timed out") from exc
    finally:
        sock.close()
