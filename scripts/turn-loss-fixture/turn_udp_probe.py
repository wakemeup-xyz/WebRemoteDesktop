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
        realm, nonce = attrs[0x0014], attrs[0x0015]; body = _attr(0x0019,b"\x11\0\0\0") + _attr(0x0006,username.encode()) + _attr(0x0014,realm) + _attr(0x0015,nonce)
        second = os.urandom(12); prefix = _message(0x0003, second, body + _attr(0x0008, b"\0"*20)); key = hashlib.md5(username.encode()+b":"+realm+b":"+password.encode()).digest(); integrity = hmac.new(key, prefix, hashlib.sha1).digest()
        sock.sendto(_message(0x0003, second, body + _attr(0x0008, integrity)), (host, port)); data, _ = sock.recvfrom(4096); kind, received, attrs = _parse(data)
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
