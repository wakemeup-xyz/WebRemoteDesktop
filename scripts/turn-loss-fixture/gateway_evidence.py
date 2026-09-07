"""Bounded, header-only evidence and capability primitives for the Lab gateway."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path
from typing import Callable


_DURATION_MS = {"every_100th_for_30s": 30_000, "all_for_200ms": 200}
_MAX_DURATION_MS = 35_000


def _canonical(value: dict) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


class GatewayLossCounter:
    def __init__(self, pattern: str, *, started_ns: int, duration_ms: int | None = None) -> None:
        if pattern not in _DURATION_MS:
            raise ValueError("unknown finite-loss pattern")
        self.pattern = pattern
        self.started_ns = int(started_ns)
        self.duration_ms = _DURATION_MS[pattern] if duration_ms is None else int(duration_ms)
        if not 0 < self.duration_ms <= _MAX_DURATION_MS:
            raise ValueError("loss duration exceeds Lab watchdog")
        self.deadline_ns = self.started_ns + self.duration_ms * 1_000_000
        self.eligible_count = self.dropped_count = 0
        self.forwarded_sequences: list[int] = []
        self.dropped_sequences: list[int] = []
        self.deadline_expired = False

    def observe(self, *, sequence: int, now_ns: int) -> bool:
        """Record one eligible RTP datagram and return whether it must forward."""
        if int(now_ns) > self.deadline_ns:
            self.deadline_expired = True
            self.forwarded_sequences.append(int(sequence))
            return True
        self.eligible_count += 1
        drop = self.pattern == "all_for_200ms" or self.eligible_count % 100 == 0
        if drop:
            self.dropped_count += 1
            self.dropped_sequences.append(int(sequence))
            return False
        self.forwarded_sequences.append(int(sequence))
        return True

    def seal(self, *, ended_ns: int) -> dict:
        return {"pattern": self.pattern, "startedMonotonicNs": self.started_ns, "endedMonotonicNs": int(ended_ns),
                "deadlineMonotonicNs": self.deadline_ns, "deadlineExpired": self.deadline_expired,
                "eligibleCount": self.eligible_count, "droppedCount": self.dropped_count,
                "forwardedSequences": list(self.forwarded_sequences), "droppedSequences": list(self.dropped_sequences)}


class GatewayCounterStore:
    """Small atomic state bridge from the inline gateway to the controller.

    It deliberately persists only packet headers that the causal verifier needs:
    event-local counters and RTP sequence numbers.  RTP payload bytes never
    cross this boundary.
    """
    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    @staticmethod
    def _empty() -> dict:
        return {"events": {}}

    def _read(self) -> dict:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return self._empty()
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError("gateway counter state is unreadable") from exc
        if not isinstance(raw, dict) or set(raw) != {"events"} or not isinstance(raw["events"], dict):
            raise RuntimeError("gateway counter state has invalid schema")
        return raw

    def _write(self, raw: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(raw, sort_keys=True, separators=(",", ":")), encoding="utf-8")
        temporary.chmod(0o600)
        os.replace(temporary, self.path)
        self.path.chmod(0o600)

    def record(self, event_id: str, *, eligible: bool, dropped: bool, sequence: int) -> None:
        if not isinstance(event_id, str) or not event_id or len(event_id) > 256:
            raise ValueError("gateway event id is invalid")
        if not isinstance(eligible, bool) or not isinstance(dropped, bool) or (dropped and not eligible):
            raise ValueError("gateway counter outcome is invalid")
        if not isinstance(sequence, int) or not 0 <= sequence <= 65535:
            raise ValueError("gateway RTP sequence is invalid")
        raw = self._read()
        event = raw["events"].setdefault(event_id, {"eligibleCount": 0, "droppedCount": 0,
                                                     "forwardedSequences": [], "droppedSequences": []})
        if set(event) != {"eligibleCount", "droppedCount", "forwardedSequences", "droppedSequences"}:
            raise RuntimeError("gateway counter event has invalid schema")
        if eligible:
            event["eligibleCount"] += 1
            event["droppedSequences" if dropped else "forwardedSequences"].append(sequence)
            if dropped:
                event["droppedCount"] += 1
        self._write(raw)

    def count(self, event_id: str) -> dict:
        if not isinstance(event_id, str) or not event_id:
            raise ValueError("gateway event id is invalid")
        event = self._read()["events"].get(event_id)
        if event is None:
            return {"eligibleCount": 0, "droppedCount": 0, "forwardedSequences": [], "droppedSequences": []}
        if not isinstance(event, dict) or set(event) != {"eligibleCount", "droppedCount", "forwardedSequences", "droppedSequences"}:
            raise RuntimeError("gateway counter event has invalid schema")
        return {key: (list(value) if isinstance(value, list) else value) for key, value in event.items()}


class ReceiverCapabilityIssuer:
    """The gateway gets a signed, scoped bearer; only authority holds the key."""
    def __init__(self, key: bytes, *, now_ns: Callable[[], int] = time.monotonic_ns) -> None:
        if not isinstance(key, bytes) or len(key) < 32:
            raise ValueError("receiver capability key is invalid")
        self._key, self._now_ns, self._used = key, now_ns, set()

    def issue(self, *, run_id: str, realm: str, gateway_id: str, operation: str, ttl_ns: int) -> str:
        now = int(self._now_ns())
        if not all(isinstance(value, str) and value for value in (run_id, realm, gateway_id, operation)) or not 0 < int(ttl_ns) <= 120_000_000_000:
            raise ValueError("receiver capability claims are invalid")
        claims = {"v": 1, "runId": run_id, "realm": realm, "gatewayId": gateway_id, "operation": operation,
                  "issuedNs": now, "expiresNs": now + int(ttl_ns), "nonce": secrets.token_urlsafe(18)}
        body = base64.urlsafe_b64encode(_canonical(claims)).decode("ascii").rstrip("=")
        signature = hmac.new(self._key, body.encode("ascii"), hashlib.sha256).hexdigest()
        return f"{body}.{signature}"

    def consume(self, capability: str, *, run_id: str, realm: str, gateway_id: str, operation: str, now_ns: int | None = None) -> bool:
        try:
            body, signature = capability.split(".", 1)
            expected = hmac.new(self._key, body.encode("ascii"), hashlib.sha256).hexdigest()
            padding = "=" * ((-len(body)) % 4)
            claims = json.loads(base64.urlsafe_b64decode(body + padding))
            now = int(self._now_ns() if now_ns is None else now_ns)
        except (AttributeError, ValueError, UnicodeError, json.JSONDecodeError):
            return False
        nonce = claims.get("nonce") if isinstance(claims, dict) else None
        expected_claims = {"runId": run_id, "realm": realm, "gatewayId": gateway_id, "operation": operation}
        if (not hmac.compare_digest(signature, expected) or not isinstance(nonce, str) or nonce in self._used
                or any(claims.get(key) != value for key, value in expected_claims.items())
                or not isinstance(claims.get("expiresNs"), int) or now > claims["expiresNs"]):
            return False
        self._used.add(nonce)
        return True
