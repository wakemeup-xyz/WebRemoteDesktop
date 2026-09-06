from __future__ import annotations

from dataclasses import replace

from media_stage_metrics import FrameKey, FrameTraceRegistry, StageMetrics


class Clock:
    def __init__(self, now=0):
        self.now = now

    def __call__(self):
        return self.now


def key(*, seq=1, pts=9000, generation=1):
    return FrameKey("attempt-a", generation, "video", seq, pts)


def test_stage_metrics_reports_nearest_rank_quantiles_without_summing_overlap():
    """Adding overlapping stages would turn one frame's wall time into a fiction."""
    metrics = StageMetrics()
    frame = key()

    assert metrics.record(frame, "worker_queue", 0, 1_000_000)
    assert metrics.record(frame, "worker_queue", 0, 9_000_000)
    assert metrics.record(frame, "prepare", 0, 9_000_000)

    snapshot = metrics.snapshot()
    assert snapshot["stages"]["worker_queue"] == {
        "count": 2, "p50Ms": 1.0, "p95Ms": 9.0, "maxMs": 9.0,
    }
    assert snapshot["stages"]["prepare"]["p95Ms"] == 9.0
    assert "pipelineTotalMs" not in snapshot


def test_stage_metrics_rejects_negative_intervals_and_keeps_empty_stages_null():
    """A backwards monotonic boundary must never become a zero-duration sample."""
    metrics = StageMetrics()

    assert not metrics.record(key(), "encode", 9, 8)
    snapshot = metrics.snapshot()
    assert snapshot["invalidIntervalCount"] == 1
    assert snapshot["stages"]["encode"] == {
        "count": 0, "p50Ms": None, "p95Ms": None, "maxMs": None,
    }


def test_stage_metrics_rolls_each_stage_at_2048_samples():
    """An unbounded diagnostic buffer would itself become a media regression."""
    metrics = StageMetrics()
    frame = key()
    for value in range(2050):
        assert metrics.record(frame, "grab", value, value + 1)

    stage = metrics.snapshot()["stages"]["grab"]
    assert stage["count"] == 2048
    assert stage["p50Ms"] == 0.0
    assert metrics.snapshot()["droppedStageSamples"] == 2


def test_registry_allows_capture_reuse_but_requires_unique_output_timestamp():
    """Reused pixels have separate RTP identities; reused output PTS would not."""
    clock = Clock(1)
    registry = FrameTraceRegistry(clock_ns=clock)
    first = key(seq=7, pts=90_000)
    reused = key(seq=7, pts=93_000)

    assert registry.register_capture(first, frame_pts=100)
    assert registry.register_capture(reused, frame_pts=100)
    assert not registry.register_capture(replace(reused, capture_seq=8), frame_pts=101)
    assert registry.snapshot()["conflictCount"] == 1


def test_registry_expires_old_stream_records_and_rejects_old_generation_annotation():
    """A late encoder result must not attach to a new media generation."""
    clock = Clock(0)
    registry = FrameTraceRegistry(clock_ns=clock, ttl_ns=120_000_000_000)
    old = key(generation=1)
    assert registry.register_capture(old, frame_pts=10)
    clock.now = 120_000_000_001
    current = key(generation=2, pts=12_000)
    assert registry.register_capture(current, frame_pts=11)

    assert not registry.annotate_encoder(old, "idr", "periodic", "digest")
    snapshot = registry.snapshot()
    assert snapshot["expiredCount"] == 1
    assert snapshot["crossGenerationCount"] == 1


def test_registry_discards_queued_old_generation_diagnostics():
    """A late data-channel row from a replaced generation must not match a new viewer."""
    registry = FrameTraceRegistry()
    old = key(generation=1)
    assert registry.register_capture(old, frame_pts=10)
    assert registry.bind_wire(old, 7, 12)
    assert registry.register_capture(key(generation=2, pts=12_000), frame_pts=11)

    assert registry.take_frame_trace_batch()["traces"] == []


def test_registry_bounds_and_expires_pending_and_active_attempt_scopes():
    """A long reconnect history must not retain active scopes or stale diagnostics."""
    clock = Clock(0)
    registry = FrameTraceRegistry(clock_ns=clock, capacity=2, ttl_ns=10)
    for attempt, timestamp in (("a", 1), ("b", 2), ("c", 3)):
        item = FrameKey(attempt, 1, "video", 1, timestamp)
        assert registry.register_capture(item, 1)
        assert registry.bind_wire(item, 7, timestamp)
    clock.now = 11

    assert registry.take_frame_trace_batch()["traces"] == []
    assert registry.snapshot()["activeScopeCount"] == 0


def test_registry_snapshot_reset_keeps_live_rows_but_clears_interval_evidence():
    registry = FrameTraceRegistry()
    key = FrameKey("attempt", 1, "video", 1, 90)
    assert registry.register_capture(key, 1)
    registry.note_unmatched_wire()

    first = registry.snapshot(reset=True)
    second = registry.snapshot()

    assert first["registeredCaptureCount"] == 1
    assert first["unmatchedWireCount"] == 1
    assert second["traceCount"] == 1
    assert second["registeredCaptureCount"] == 0
    assert second["unmatchedWireCount"] == 0


def test_source_to_wire_uses_registered_output_denominator_and_rejects_cross_window_overflow():
    registry = FrameTraceRegistry()
    key = FrameKey("attempt", 1, "video", 1, 90)
    assert registry.register_capture(key, 1)
    registry.snapshot(reset=True)
    # The observer may report a packet from the preceding interval.  It must
    # not produce a >1 rate by dividing it by raw MSS capture count or zero.
    assert registry.bind_wire(key, 7, 77)
    snapshot = registry.snapshot()

    assert snapshot["registeredOutputFrameCount"] == 0
    assert snapshot["wireBoundCount"] == 1
    assert snapshot["sourceToWireCoverage"] is None

    complete = FrameTraceRegistry()
    complete_key = FrameKey("complete", 1, "video", 1, 90)
    assert complete.register_capture(complete_key, 1)
    assert complete.snapshot()["sourceToWireCoverage"] is None
    assert complete.bind_wire(complete_key, 7, 77)
    assert complete.snapshot()["sourceToWireCoverage"] == 1.0


def test_registry_binds_wire_identity_per_reused_capture_and_batches_bounded_entries():
    """Matching by capture sequence would merge two encoded copies into one rVFC row."""
    registry = FrameTraceRegistry()
    one = key(seq=9, pts=90_000)
    two = key(seq=9, pts=93_000)
    assert registry.register_capture(one, frame_pts=100)
    assert registry.register_capture(two, frame_pts=100)
    assert registry.annotate_encoder(one, "idr", "explicit", "policy-a")
    assert registry.bind_wire(one, 7, 0xFFFFFFF0)
    assert registry.bind_wire(two, 7, 0x00000020)
    assert not registry.bind_wire(two, 7, 0xFFFFFFF0)

    batch = registry.take_frame_trace_batch(limit=64)
    assert batch["type"] == "frame_trace_batch"
    assert batch["schemaVersion"] == 1
    assert [(row["captureSeq"], row["wireTimestamp"]) for row in batch["traces"]] == [
        (9, 0xFFFFFFF0), (9, 0x20),
    ]
    assert batch["traces"][0]["stages"]["reformat"] is None
    assert registry.snapshot()["conflictCount"] == 1
