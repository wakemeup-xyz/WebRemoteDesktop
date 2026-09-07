"""Bounded, header-only evidence primitives for the Lab gateway."""
from __future__ import annotations

import hashlib
import json
import os
import time
from collections.abc import Mapping
from pathlib import Path


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

    _EVENT_FIELDS = frozenset({"eventHandle", "mediaBindingDigest", "startedMonotonicNs", "deadlineMonotonicNs",
                               "eligibleCount", "forwardedCount", "droppedCount", "sendFailureCount",
                               "beforeForwardedSequences", "duringForwardedSequences", "afterForwardedSequences",
                               "droppedSequences"})

    @staticmethod
    def _digest_binding(media_binding: Mapping[str, object]) -> str:
        return hashlib.sha256(_canonical(dict(media_binding))).hexdigest()

    def begin(self, event_id: str, *, media_binding: Mapping[str, object], started_ns: int,
              deadline_ns: int, before_sequences: list[int] | tuple[int, ...] = ()) -> None:
        """Create one immutable-target gateway event before counting packets."""
        if (not isinstance(event_id, str) or not event_id or not isinstance(started_ns, int)
                or not isinstance(deadline_ns, int) or deadline_ns < started_ns):
            raise ValueError("gateway event metadata is invalid")
        if any(not isinstance(value, int) or not 0 <= value <= 65535 for value in before_sequences):
            raise ValueError("gateway before sequence is invalid")
        digest = self._digest_binding(media_binding)
        raw = self._read()
        event = raw["events"].get(event_id)
        if event is None:
            raw["events"][event_id] = {"eventHandle": event_id, "mediaBindingDigest": digest,
                                       "startedMonotonicNs": started_ns, "deadlineMonotonicNs": deadline_ns,
                                       "eligibleCount": 0, "forwardedCount": 0, "droppedCount": 0,
                                       "sendFailureCount": 0, "beforeForwardedSequences": list(before_sequences),
                                       "duringForwardedSequences": [], "afterForwardedSequences": [],
                                       "droppedSequences": []}
            self._write(raw)
            return
        if (not isinstance(event, dict) or set(event) != self._EVENT_FIELDS
                or event["mediaBindingDigest"] != digest or event["startedMonotonicNs"] != started_ns
                or event["deadlineMonotonicNs"] != deadline_ns):
            raise RuntimeError("gateway event target is absent or changed")

    def record(self, event_id: str, *, phase: str = "during", eligible: bool, dropped: bool,
               sequence: int, forwarded: bool | None = None) -> None:
        if not isinstance(event_id, str) or not event_id or len(event_id) > 256:
            raise ValueError("gateway event id is invalid")
        if not isinstance(eligible, bool) or not isinstance(dropped, bool) or (dropped and not eligible):
            raise ValueError("gateway counter outcome is invalid")
        if not isinstance(sequence, int) or not 0 <= sequence <= 65535:
            raise ValueError("gateway RTP sequence is invalid")
        if phase not in {"before", "during", "after"} or (phase != "during" and (eligible or dropped)):
            raise ValueError("gateway counter phase is invalid")
        if forwarded is None:
            forwarded = not dropped
        if not isinstance(forwarded, bool) or (dropped and forwarded):
            raise ValueError("gateway forward outcome is invalid")
        raw = self._read()
        event = raw["events"].get(event_id)
        if not isinstance(event, dict) or set(event) != self._EVENT_FIELDS:
            raise RuntimeError("gateway counter event has invalid schema")
        if phase == "during" and eligible:
            event["eligibleCount"] += 1
            if dropped:
                event["droppedCount"] += 1
                event["droppedSequences"].append(sequence)
            elif forwarded:
                event["forwardedCount"] += 1
                event["duringForwardedSequences"].append(sequence)
        elif phase != "during" and forwarded:
            event[f"{phase}ForwardedSequences"].append(sequence)
        self._write(raw)

    def record_send_failure(self, event_id: str) -> None:
        raw = self._read(); event = raw["events"].get(event_id)
        if not isinstance(event, dict) or set(event) != self._EVENT_FIELDS:
            raise RuntimeError("gateway counter event has invalid schema")
        event["sendFailureCount"] += 1
        self._write(raw)

    def count(self, event_id: str) -> dict:
        if not isinstance(event_id, str) or not event_id:
            raise ValueError("gateway event id is invalid")
        event = self._read()["events"].get(event_id)
        if event is None:
            return {"eventHandle": event_id, "mediaBindingDigest": None, "startedMonotonicNs": None,
                    "deadlineMonotonicNs": None, "eligibleCount": 0, "forwardedCount": 0,
                    "droppedCount": 0, "sendFailureCount": 0, "beforeForwardedSequences": [],
                    "duringForwardedSequences": [], "afterForwardedSequences": [], "droppedSequences": []}
        if not isinstance(event, dict) or set(event) != self._EVENT_FIELDS:
            raise RuntimeError("gateway counter event has invalid schema")
        return {key: (list(value) if isinstance(value, list) else value) for key, value in event.items()}
