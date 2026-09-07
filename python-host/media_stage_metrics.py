"""Bounded, same-host-clock evidence for one encoded video frame.

This module deliberately keeps browser time out of the model.  A FrameKey has
both the encoder's 90 kHz timestamp and the eventual RTP timestamp, but only
the latter is usable by a browser rVFC callback.
"""

from __future__ import annotations

import time
import threading
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from typing import Callable


STAGES = (
    "grab", "age_at_recv", "worker_queue", "prepare", "build",
    "reformat", "encode", "packetize", "encode_total",
)
MAX_RECORDS = 2048
TTL_NS = 120_000_000_000


@dataclass(frozen=True)
class FrameKey:
    attempt_id: str
    generation: int
    stream_id: str
    capture_seq: int
    encoder_timestamp: int


@dataclass
class FrameTrace:
    key: FrameKey
    frame_pts: int
    created_ns: int
    idr_kind: str | None = None
    idr_reason: str | None = None
    policy_digest: str | None = None
    ssrc: int | None = None
    wire_timestamp: int | None = None
    stages: dict[str, float | None] = field(default_factory=dict)

    def as_wire_row(self) -> dict:
        return {
            "attemptId": self.key.attempt_id,
            "generation": self.key.generation,
            "streamId": self.key.stream_id,
            "captureSeq": self.key.capture_seq,
            "encoderTimestamp": self.key.encoder_timestamp,
            "wireTimestamp": self.wire_timestamp,
            "ssrc": self.ssrc,
            "framePts": self.frame_pts,
            "idrKind": self.idr_kind,
            "idrReason": self.idr_reason,
            "policyDigest": self.policy_digest,
            "stages": {stage: self.stages.get(stage) for stage in STAGES},
        }


@dataclass(frozen=True)
class SenderFrameTraceContext:
    """Immutable sender-owned identity; PyAV frames never carry this state."""
    registry: "FrameTraceRegistry"
    metrics: "StageMetrics"
    attempt_id: str
    generation: int
    stream_id: str = "video"
    policy_digest: str | None = None

    def key(self, capture_seq: int, encoder_timestamp: int) -> FrameKey:
        return FrameKey(self.attempt_id, int(self.generation), self.stream_id,
                        int(capture_seq), int(encoder_timestamp) & 0xFFFFFFFF)


class FrameTraceRegistry:
    """A per-stream bounded join table.  False always means no causal join."""

    def __init__(
        self,
        *,
        clock_ns: Callable[[], int] = time.monotonic_ns,
        capacity: int = MAX_RECORDS,
        ttl_ns: int = TTL_NS,
        lab_loss_trace: bool = False,
        lab_loss_capacity: int = 512,
    ) -> None:
        self._clock_ns = clock_ns
        self._lock = threading.RLock()
        self._capacity = int(capacity)
        self._ttl_ns = int(ttl_ns)
        # This higher-detail stream is exclusively for a disposable Lab run.
        # It is off in ordinary detailed tracing and is bounded independently
        # so a loss experiment cannot retain an unbounded packet history.
        self._lab_loss_trace = bool(lab_loss_trace)
        self._lab_loss_capacity = max(1, min(int(lab_loss_capacity), 2048))
        self._lab_loss_events: deque[dict] = deque()
        self._lab_loss_dropped = 0
        self._traces: dict[tuple[str, int, str], OrderedDict[int, FrameTrace]] = {}
        self._active_generation: OrderedDict[tuple[str, str], tuple[int, int]] = OrderedDict()
        self._wire: dict[tuple[str, int, str, int, int], FrameTrace] = {}
        self._pending: deque[FrameTrace] = deque()
        self.expired_count = 0
        self.evicted_count = 0
        self.conflict_count = 0
        self.cross_generation_count = 0
        self.unmatched_encoder_count = 0
        self.unmatched_wire_count = 0
        self.dropped_trace_count = 0
        self.expired_pending_count = 0
        self.active_scope_eviction_count = 0
        # Every successful registration is one encoded output identity, not a
        # raw MSS capture. Raw capture count lives on ScreenCaptureTrack.
        # ``source`` counts every output presented for registration, including
        # a rejected conflict or stale-generation output. It is the only safe
        # coverage denominator.
        self._interval_source_output_count = 0
        self._interval_registered_output_count = 0
        self._interval_wire_count = 0

    @staticmethod
    def _scope(key: FrameKey) -> tuple[str, int, str]:
        return (str(key.attempt_id), int(key.generation), str(key.stream_id))

    @staticmethod
    def _generation_scope(key: FrameKey) -> tuple[str, str]:
        return (str(key.attempt_id), str(key.stream_id))

    def _purge(self, now: int) -> None:
        for scope, (_generation, last_seen_ns) in list(self._active_generation.items()):
            if now - last_seen_ns > self._ttl_ns:
                self._active_generation.pop(scope, None)
        for scope, entries in list(self._traces.items()):
            while entries:
                timestamp, trace = next(iter(entries.items()))
                if now - trace.created_ns <= self._ttl_ns:
                    break
                entries.pop(timestamp)
                if trace.ssrc is not None and trace.wire_timestamp is not None:
                    self._wire.pop((trace.key.attempt_id, trace.key.generation, trace.key.stream_id,
                                    trace.ssrc, trace.wire_timestamp), None)
                self.expired_count += 1
            if not entries:
                self._traces.pop(scope, None)
        retained_pending = deque()
        for trace in self._pending:
            if now - trace.created_ns > self._ttl_ns:
                self.expired_pending_count += 1
                self.dropped_trace_count += 1
            else:
                retained_pending.append(trace)
        self._pending = retained_pending

    def _is_current(self, key: FrameKey) -> bool:
        active = self._active_generation.get(self._generation_scope(key))
        return active is not None and active[0] == int(key.generation)

    def _discard_attempt_stream(self, attempt_id: str, stream_id: str) -> None:
        for scope in [scope for scope in self._traces if scope[0] == attempt_id and scope[2] == stream_id]:
            for trace in self._traces.pop(scope).values():
                if trace.ssrc is not None and trace.wire_timestamp is not None:
                    self._wire.pop((trace.key.attempt_id, trace.key.generation, trace.key.stream_id,
                                    trace.ssrc, trace.wire_timestamp), None)
        self._pending = deque(
            trace for trace in self._pending
            if not (trace.key.attempt_id == attempt_id and trace.key.stream_id == stream_id)
        )

    def register_capture(self, key: FrameKey, frame_pts: int) -> bool:
        with self._lock:
            return self._register_capture(key, frame_pts)

    def _register_capture(self, key: FrameKey, frame_pts: int) -> bool:
        now = int(self._clock_ns())
        self._purge(now)
        self._interval_source_output_count += 1
        stream_scope = self._generation_scope(key)
        active_entry = self._active_generation.get(stream_scope)
        active = active_entry[0] if active_entry is not None else None
        if active is not None and int(key.generation) < active:
            self.cross_generation_count += 1
            return False
        if active is not None and int(key.generation) > active:
            # A generation boundary invalidates all joins from the previous one.
            self._discard_attempt_stream(key.attempt_id, key.stream_id)
        self._active_generation[stream_scope] = (int(key.generation), now)
        self._active_generation.move_to_end(stream_scope)
        while len(self._active_generation) > self._capacity:
            (evicted_attempt, evicted_stream), _ = self._active_generation.popitem(last=False)
            self._discard_attempt_stream(evicted_attempt, evicted_stream)
            self.active_scope_eviction_count += 1
        scope = self._scope(key)
        entries = self._traces.setdefault(scope, OrderedDict())
        timestamp = int(key.encoder_timestamp) & 0xFFFFFFFF
        if timestamp in entries:
            self.conflict_count += 1
            return False
        while len(entries) >= self._capacity:
            _, discarded = entries.popitem(last=False)
            if discarded.ssrc is not None and discarded.wire_timestamp is not None:
                self._wire.pop((discarded.key.attempt_id, discarded.key.generation, discarded.key.stream_id,
                                discarded.ssrc, discarded.wire_timestamp), None)
            self.evicted_count += 1
        entries[timestamp] = FrameTrace(key=key, frame_pts=int(frame_pts), created_ns=now)
        self._interval_registered_output_count += 1
        return True

    def _get(self, key: FrameKey) -> FrameTrace | None:
        if not self._is_current(key):
            self.cross_generation_count += 1
            return None
        self._purge(int(self._clock_ns()))
        trace = self._traces.get(self._scope(key), {}).get(int(key.encoder_timestamp) & 0xFFFFFFFF)
        if trace is None:
            self.unmatched_encoder_count += 1
        return trace

    def find_by_encoder_timestamp(
        self, encoder_timestamp: int, *, attempt_id: str | None = None,
        generation: int | None = None, stream_id: str | None = None,
    ) -> FrameKey | None:
        """Resolve only a unique live key; ambiguity is an explicit miss."""
        with self._lock:
            return self._find_by_encoder_timestamp(encoder_timestamp, attempt_id=attempt_id,
                                                   generation=generation, stream_id=stream_id)

    def _find_by_encoder_timestamp(
        self, encoder_timestamp: int, *, attempt_id: str | None = None,
        generation: int | None = None, stream_id: str | None = None,
    ) -> FrameKey | None:
        self._purge(int(self._clock_ns()))
        matches: list[FrameTrace] = []
        wanted = int(encoder_timestamp) & 0xFFFFFFFF
        for scope, entries in self._traces.items():
            if attempt_id is not None and scope[0] != str(attempt_id):
                continue
            if generation is not None and scope[1] != int(generation):
                continue
            if stream_id is not None and scope[2] != str(stream_id):
                continue
            trace = entries.get(wanted)
            if trace is not None and self._is_current(trace.key):
                matches.append(trace)
        if len(matches) != 1:
            self.unmatched_encoder_count += 1
            return None
        return matches[0].key

    def annotate_encoder(self, key: FrameKey, idr_kind, reason, policy_digest) -> bool:
        with self._lock:
            trace = self._get(key)
            if trace is None:
                return False
            trace.idr_kind = None if idr_kind is None else str(idr_kind)
            trace.idr_reason = None if reason is None else str(reason)
            trace.policy_digest = None if policy_digest is None else str(policy_digest)
            if trace.idr_kind is not None:
                self._append_lab_loss_event({
                    "type": "encoder_idr", "monotonicNs": int(self._clock_ns()),
                    "frameKey": self._lab_frame_key(key), "idrKind": trace.idr_kind,
                    "requestToken": trace.idr_reason, "policyDigest": trace.policy_digest,
                })
            return True

    @staticmethod
    def _lab_frame_key(key: FrameKey) -> dict:
        return {"attemptId": key.attempt_id, "generation": int(key.generation),
                "streamId": key.stream_id, "captureSeq": int(key.capture_seq),
                "encoderTimestamp": int(key.encoder_timestamp) & 0xFFFFFFFF}

    def _append_lab_loss_event(self, event: dict) -> None:
        if not self._lab_loss_trace:
            return
        if len(self._lab_loss_events) >= self._lab_loss_capacity:
            self._lab_loss_events.popleft()
            self._lab_loss_dropped += 1
        self._lab_loss_events.append(event)

    def record_lab_rtcp_feedback(self, kind: str, *, sender: object | None = None) -> None:
        if kind not in {"PLI", "FIR"}:
            return
        with self._lock:
            self._append_lab_loss_event({"type": "rtcp_feedback", "kind": kind,
                                         "monotonicNs": int(self._clock_ns()),
                                         "senderId": str(id(sender)) if sender is not None else None})

    def record_lab_rtp_send(self, key: FrameKey, *, sequence: int, rtp_timestamp: int, ssrc: int) -> None:
        if not (0 <= int(sequence) <= 0xFFFF and 0 <= int(rtp_timestamp) <= 0xFFFFFFFF):
            return
        with self._lock:
            self._append_lab_loss_event({"type": "rtp_send", "monotonicNs": int(self._clock_ns()),
                                         "frameKey": self._lab_frame_key(key), "sequence": int(sequence),
                                         "rtpTimestamp": int(rtp_timestamp), "ssrc": int(ssrc)})

    def record_lab_pc_state(self, *, identifier: str, state: str, width: int, height: int) -> None:
        if not isinstance(identifier, str) or not identifier or not isinstance(state, str) or not state:
            return
        with self._lock:
            self._append_lab_loss_event({"type": "pc_state", "monotonicNs": int(self._clock_ns()),
                                         "pcId": identifier, "state": state,
                                         "resolution": {"width": max(0, int(width)), "height": max(0, int(height))}})

    def take_loss_lab_trace_batch(self, limit: int = 64) -> dict:
        """Drain bounded raw Lab diagnostics; callers cannot synthesize rows."""
        with self._lock:
            rows = []
            for _ in range(min(max(0, int(limit)), 64)):
                if not self._lab_loss_events:
                    break
                rows.append(self._lab_loss_events.popleft())
            dropped = self._lab_loss_dropped
            self._lab_loss_dropped = 0
            return {"type": "loss_lab_host_trace_batch", "schemaVersion": 1,
                    "events": rows, "droppedEventCount": dropped}

    def note_dropped_loss_lab_events(self, count: int) -> None:
        with self._lock:
            if self._lab_loss_trace:
                self._lab_loss_dropped += max(0, int(count))

    def annotate_stage(self, key: FrameKey, stage: str, value_ms: float | None) -> bool:
        with self._lock:
            trace = self._get(key)
            if trace is None:
                return False
            trace.stages[str(stage)] = value_ms
            return True

    def bind_wire(self, key: FrameKey, ssrc: int, wire_timestamp: int) -> bool:
        with self._lock:
            return self._bind_wire(key, ssrc, wire_timestamp)

    def _bind_wire(self, key: FrameKey, ssrc: int, wire_timestamp: int) -> bool:
        trace = self._get(key)
        if trace is None:
            self.unmatched_wire_count += 1
            return False
        identity = (key.attempt_id, int(key.generation), key.stream_id, int(ssrc), int(wire_timestamp) & 0xFFFFFFFF)
        existing = self._wire.get(identity)
        if existing is not None and existing is not trace:
            self.conflict_count += 1
            return False
        if trace.wire_timestamp is not None:
            self.conflict_count += 1
            return False
        trace.ssrc = int(ssrc)
        trace.wire_timestamp = int(wire_timestamp) & 0xFFFFFFFF
        self._wire[identity] = trace
        while len(self._pending) >= self._capacity:
            self._pending.popleft()
            self.dropped_trace_count += 1
        self._pending.append(trace)
        self._interval_wire_count += 1
        return True

    def note_unmatched_wire(self) -> None:
        """Record an observed RTP packet that was deliberately not associated."""
        with self._lock:
            self.unmatched_wire_count += 1

    def note_dropped_trace(self, count: int = 1) -> None:
        with self._lock:
            self.dropped_trace_count += max(0, int(count))

    def take_frame_trace_batch(self, limit: int = 64) -> dict:
        with self._lock:
            self._purge(int(self._clock_ns()))
            rows = []
            for _ in range(min(max(0, int(limit)), 64)):
                if not self._pending:
                    break
                rows.append(self._pending.popleft().as_wire_row())
            return {"type": "frame_trace_batch", "schemaVersion": 1, "traces": rows}

    def snapshot(self, reset: bool = False) -> dict:
        with self._lock:
            self._purge(int(self._clock_ns()))
            alignment_failures = sum((
                self.expired_count,
                self.expired_pending_count,
                self.evicted_count,
                self.active_scope_eviction_count,
                self.conflict_count,
                self.cross_generation_count,
                self.unmatched_encoder_count,
                self.unmatched_wire_count,
                self.dropped_trace_count,
            ))
            source_to_wire = (
                round(self._interval_wire_count / self._interval_source_output_count, 3)
                if self._interval_wire_count
                and self._interval_source_output_count
                and self._interval_wire_count <= self._interval_source_output_count
                and not alignment_failures else None
            )
            snapshot = {
                "traceCount": sum(len(values) for values in self._traces.values()),
                "activeScopeCount": len(self._active_generation),
                "pendingCount": len(self._pending),
                "sourceOutputFrameCount": self._interval_source_output_count,
                "registeredOutputFrameCount": self._interval_registered_output_count,
                # Kept for diagnostic consumers that shipped in the first T3
                # commit; its meaning is registered output frames, never MSS grabs.
                "registeredCaptureCount": self._interval_registered_output_count,
                "wireBoundCount": self._interval_wire_count,
                "sourceToWireCoverage": source_to_wire,
                "expiredCount": self.expired_count,
                "expiredPendingCount": self.expired_pending_count,
                "evictedCount": self.evicted_count,
                "activeScopeEvictionCount": self.active_scope_eviction_count,
                "conflictCount": self.conflict_count,
                "crossGenerationCount": self.cross_generation_count,
                "unmatchedEncoderCount": self.unmatched_encoder_count,
                "unmatchedWireCount": self.unmatched_wire_count,
                "droppedTraceCount": self.dropped_trace_count,
                "alignmentFailureCount": alignment_failures,
            }
            if reset:
                self._interval_source_output_count = 0
                self._interval_registered_output_count = 0
                self._interval_wire_count = 0
                self.expired_count = 0
                self.evicted_count = 0
                self.conflict_count = 0
                self.cross_generation_count = 0
                self.unmatched_encoder_count = 0
                self.unmatched_wire_count = 0
                self.dropped_trace_count = 0
                self.expired_pending_count = 0
                self.active_scope_eviction_count = 0
            return snapshot


class StageMetrics:
    """Rolling per-stage distributions.  There is intentionally no pipeline sum."""

    def __init__(self, *, registry: FrameTraceRegistry | None = None, capacity: int = MAX_RECORDS) -> None:
        self._lock = threading.RLock()
        self._registry = registry
        self._capacity = int(capacity)
        self._samples = {stage: deque(maxlen=self._capacity) for stage in STAGES}
        self.invalid_interval_count = 0
        self.invalid_stage_count = 0
        self.dropped_stage_samples = 0

    def record(self, key: FrameKey, stage: str, start_ns: int, end_ns: int) -> bool:
        with self._lock:
            return self._record(key, stage, start_ns, end_ns)

    def _record(self, key: FrameKey, stage: str, start_ns: int, end_ns: int) -> bool:
        if stage not in self._samples:
            self.invalid_stage_count += 1
            return False
        elapsed = int(end_ns) - int(start_ns)
        if elapsed < 0:
            self.invalid_interval_count += 1
            return False
        samples = self._samples[stage]
        if len(samples) == self._capacity:
            self.dropped_stage_samples += 1
        value = round(elapsed / 1_000_000, 3)
        samples.append(value)
        if self._registry is not None:
            self._registry.annotate_stage(key, stage, value)
        return True

    @staticmethod
    def _percentile(values: list[float], fraction: float) -> float | None:
        if not values:
            return None
        ordered = sorted(values)
        index = max(0, min(len(ordered) - 1, int(__import__("math").ceil(len(ordered) * fraction)) - 1))
        return ordered[index]

    def snapshot(self, reset: bool = False) -> dict:
        with self._lock:
            return self._snapshot(reset)

    def _snapshot(self, reset: bool = False) -> dict:
        stages = {}
        for name, samples in self._samples.items():
            values = list(samples)
            stages[name] = {
                "count": len(values), "p50Ms": self._percentile(values, 0.50),
                "p95Ms": self._percentile(values, 0.95), "maxMs": max(values) if values else None,
            }
        snapshot = {
            "stages": stages,
            "invalidIntervalCount": self.invalid_interval_count,
            "invalidStageCount": self.invalid_stage_count,
            "droppedStageSamples": self.dropped_stage_samples,
        }
        if reset:
            for samples in self._samples.values():
                samples.clear()
            self.invalid_interval_count = 0
            self.invalid_stage_count = 0
            self.dropped_stage_samples = 0
        return snapshot
