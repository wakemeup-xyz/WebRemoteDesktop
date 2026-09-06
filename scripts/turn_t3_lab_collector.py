#!/usr/bin/env python3
"""Archive one fixed 60-second, detailed-trace Lab evidence run.

This collector is deliberately separate from the controlled-input driver.  It
only reads the Lab Host log and the already-decoded Viewer evidence.  No normal
Host, tunnel, service configuration, or input path is changed.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any, Callable, Mapping


RUN_SECONDS = 60
CADENCE_TOLERANCE_MS = 250


def _canonical(value: Mapping[str, Any]) -> bytes:
    return json.dumps(dict(value), sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def _unsigned(artifact: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in artifact.items() if key != "signature"}


def sign_artifact(artifact: Mapping[str, Any], verifier: bytes) -> str:
    return hmac.new(bytes(verifier), _canonical(_unsigned(artifact)), hashlib.sha256).hexdigest()


def verify_artifact(artifact: Mapping[str, Any], verifier: bytes) -> bool:
    signature = artifact.get("signature") if isinstance(artifact, Mapping) else None
    return isinstance(signature, str) and hmac.compare_digest(signature, sign_artifact(artifact, verifier))


def _seal_artifact(artifact: dict[str, Any], verifier: bytes) -> dict[str, Any]:
    """Record an in-Lab self-verification without ever serializing its secret."""
    artifact["verification"] = {
        "algorithm": "HMAC-SHA256",
        "verifierSource": "lab-transcript-verifier/sha256:" + hashlib.sha256(verifier).hexdigest(),
        "selfVerified": True,
        "verifiedBeforeLabClose": True,
    }
    artifact["signature"] = sign_artifact(artifact, verifier)
    if not verify_artifact(artifact, verifier):
        raise RuntimeError("Lab artifact self-verification failed")
    return artifact


def _identity(identity: Mapping[str, Any]) -> dict[str, Any]:
    required = ("runId", "realm", "origin", "epoch")
    if not all(isinstance(identity.get(key), str) and identity[key] for key in required[:-1]) or not isinstance(identity.get("epoch"), int):
        raise ValueError("a live Lab identity is required")
    return {key: identity[key] for key in required}


def _observer_state(summaries: list[Mapping[str, Any]]) -> dict[str, Any]:
    observer: dict[str, Any] = {}
    for summary in summaries:
        candidate = summary.get("observer")
        if isinstance(candidate, Mapping):
            observer = dict(candidate)
    return observer


def _valid_scope(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    attempt, generation, stream = value.get("attemptId"), value.get("generation"), value.get("streamId")
    if not isinstance(attempt, str) or not attempt or not isinstance(generation, int) or isinstance(generation, bool) or generation < 0 or not isinstance(stream, str) or not stream:
        return None
    return {"attemptId": attempt, "generation": generation, "streamId": stream}


def _valid_viewer_session(value: Any) -> dict[str, Any] | None:
    scope = _valid_scope(value)
    if scope is None or not isinstance(value, Mapping):
        return None
    width, height = value.get("sourceWidth"), value.get("sourceHeight")
    if (not isinstance(width, int) or isinstance(width, bool) or width <= 0
            or not isinstance(height, int) or isinstance(height, bool) or height <= 0):
        return None
    return {**scope, "sourceWidth": width, "sourceHeight": height}


def _valid_viewer_presentation(value: Any) -> dict[str, Any] | None:
    """Validate the adapter's documented attempt/generation/resolution shape."""
    if not isinstance(value, Mapping):
        return None
    attempt, generation = value.get("attemptId"), value.get("generation")
    width, height = value.get("sourceWidth"), value.get("sourceHeight")
    if (not isinstance(attempt, str) or not attempt
            or not isinstance(generation, int) or isinstance(generation, bool) or generation < 0
            or not isinstance(width, int) or isinstance(width, bool) or width <= 0
            or not isinstance(height, int) or isinstance(height, bool) or height <= 0):
        return None
    return {"attemptId": attempt, "generation": generation, "sourceWidth": width, "sourceHeight": height}


def _matches_scope(value: Mapping[str, Any], scope: Mapping[str, Any]) -> bool:
    return all(value.get(key) == scope[key] for key in ("attemptId", "generation", "streamId"))


def _has_valid_observer_origin(observer: Mapping[str, Any], scope: Mapping[str, Any] | None) -> bool:
    """Require the Host snapshot to preserve a nonzero uint32 mapping for this Viewer stream."""
    if scope is None:
        return False
    origins = observer.get("originByStream")
    if not isinstance(origins, Mapping):
        return False
    prefix = "|".join((scope["attemptId"], str(scope["generation"]), scope["streamId"])) + "|"
    return any(
        isinstance(key, str) and key.startswith(prefix)
        and isinstance(origin, int) and not isinstance(origin, bool) and 0 < origin <= 0xFFFFFFFF
        for key, origin in origins.items()
    )


def _diagnostics_failures(value: Any) -> set[str]:
    if not isinstance(value, Mapping):
        return {"viewer-diagnostics-missing"}
    failures: set[str] = set()
    if value.get("acceptanceState") == "UNALIGNED":
        failures.add("viewer-diagnostics-unaligned")
    for field in ("droppedTraceCount", "invalidBatchCount", "staleTraceCount", "conflictingTraceCount"):
        count = value.get(field)
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            failures.add(f"viewer-diagnostics-{field}-invalid")
        elif count:
            failures.add(f"viewer-diagnostics-{field}")
    return failures


def collect_fixed_60_seconds(*, identity: Mapping[str, Any], sample: Callable[[int], Mapping[str, Any]],
                             verifier: bytes, now: Callable[[], float] = time.monotonic,
                             wait: Callable[[float], None] = time.sleep,
                             expected_viewer_session: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Capture 0..60 inclusive samples and seal all T3 evidence classes.

    There are 61 observations so the final sample proves the wall-clock end of
    the requested 60-second window.  A missing raw batch or incompatible
    observer leaves a signed but UNALIGNED artifact; summaries cannot fill the
    gap.
    """
    samples: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []
    batches: list[dict[str, Any]] = []
    joins: list[dict[str, Any]] = []
    diagnostics: list[dict[str, Any]] = []
    windows: list[dict[str, Any]] = []
    failures: set[str] = set()
    expected_scope: dict[str, Any] | None = None
    expected_viewer = _valid_viewer_session(expected_viewer_session) if expected_viewer_session is not None else None
    if expected_viewer_session is not None and expected_viewer is None:
        failures.add("viewer-session-invalid")
    samples_by_index: dict[int, dict[str, Any]] = {}
    started = now()
    for index in range(RUN_SECONDS + 1):
        delay = started + index - now()
        if delay > 0:
            wait(delay)
        raw = sample(index)
        if not isinstance(raw, Mapping):
            raw = {}
        host_summaries = raw.get("hostSummaries")
        trace_batches = raw.get("frameTraceBatches")
        rvfc_joins = raw.get("rvfcJoins")
        viewer_diagnostics = raw.get("viewerDiagnostics")
        viewer_session = _valid_viewer_session(raw.get("viewerSession"))
        current_scope = _valid_scope(raw.get("scope"))
        if viewer_session is None:
            failures.add("viewer-session-invalid")
        elif expected_viewer is None:
            expected_viewer = viewer_session
        elif viewer_session != expected_viewer:
            failures.add("viewer-session-changed")
        if current_scope is None:
            failures.add("sample-scope-invalid")
        elif expected_scope is None:
            expected_scope = current_scope
        elif current_scope != expected_scope:
            failures.add("sample-scope-mismatch")
        if viewer_session is not None and current_scope is not None and _valid_scope(viewer_session) != current_scope:
            failures.add("viewer-session-scope-mismatch")
        if not isinstance(host_summaries, list):
            failures.add("malformed-host-summary")
            host_summaries = []
        if not isinstance(trace_batches, list):
            failures.add("malformed-raw-frame-trace-batch")
            trace_batches = []
        if not isinstance(rvfc_joins, list):
            failures.add("missing-rvfc-join")
            rvfc_joins = []
        host_rows = [dict(value) for value in host_summaries if isinstance(value, Mapping)]
        batch_rows = [dict(value) for value in trace_batches if isinstance(value, Mapping)]
        join_rows = [dict(value) for value in rvfc_joins if isinstance(value, Mapping)]
        if len(host_rows) != len(host_summaries) or len(batch_rows) != len(trace_batches) or len(join_rows) != len(rvfc_joins):
            failures.add("malformed-evidence-row")
        for summary in host_rows:
            observer = summary.get("observer")
            if not isinstance(observer, Mapping) or observer.get("enabled") is not True:
                failures.add("observer-incompatible")
            elif not _has_valid_observer_origin(observer, expected_scope):
                failures.add("observer-origin-missing-or-invalid")
            if summary.get("alignmentState") != "OBSERVED":
                failures.add("host-summary-unaligned")
            counts = summary.get("counts")
            coverage = summary.get("coverage")
            trace_state = summary.get("traces")
            output_count = counts.get("outputs") if isinstance(counts, Mapping) else None
            source_output_count = trace_state.get("sourceOutputFrameCount") if isinstance(trace_state, Mapping) else None
            wire_bound_count = trace_state.get("wireBoundCount") if isinstance(trace_state, Mapping) else None
            if (not isinstance(output_count, int) or isinstance(output_count, bool) or output_count <= 0
                    or not isinstance(source_output_count, int) or isinstance(source_output_count, bool)
                    or not isinstance(wire_bound_count, int) or isinstance(wire_bound_count, bool)
                    or source_output_count != output_count or wire_bound_count != output_count):
                failures.add("host-output-count-mismatch")
            if not isinstance(coverage, Mapping) or coverage.get("sourceToWire") != 1.0:
                failures.add("host-source-to-wire-incomplete")
            if not isinstance(trace_state, Mapping) or trace_state.get("alignmentFailureCount") != 0:
                failures.add("host-alignment-failure")
            if not isinstance(trace_state, Mapping) or trace_state.get("droppedTraceCount") != 0:
                failures.add("host-diagnostic-drop")
        for batch in batch_rows:
            traces = batch.get("traces")
            if batch.get("type") != "frame_trace_batch" or batch.get("schemaVersion") != 1 or not isinstance(traces, list) or not traces:
                failures.add("invalid-raw-frame-trace-batch")
            elif (batch.get("droppedTraceCount") is not None
                  and (not isinstance(batch.get("droppedTraceCount"), int)
                       or isinstance(batch.get("droppedTraceCount"), bool)
                       or batch["droppedTraceCount"] < 0)):
                failures.add("invalid-raw-frame-trace-batch")
            elif batch.get("droppedTraceCount", 0) != 0:
                failures.add("raw-batch-diagnostic-drop")
            elif expected_scope is not None and any(not isinstance(trace, Mapping) or not _matches_scope(trace, expected_scope) for trace in traces):
                failures.add("batch-scope-mismatch")
        if expected_scope is not None and any(not _matches_scope(join, expected_scope) or join.get("traceStatus") != "matched" for join in join_rows):
            failures.add("rvfc-join-scope-or-status-mismatch")
        failures.update(_diagnostics_failures(viewer_diagnostics))
        elapsed_ms = max(0, round((now() - started) * 1000))
        scheduled_elapsed_ms = index * 1000
        cadence_offset_ms = elapsed_ms - scheduled_elapsed_ms
        if cadence_offset_ms < -CADENCE_TOLERANCE_MS:
            failures.add("sample-cadence-too-early")
        elif cadence_offset_ms > CADENCE_TOLERANCE_MS:
            failures.add("sample-cadence-too-late")
        sample_row = {"sampleIndex": index, "elapsedMs": elapsed_ms,
                      "scheduledElapsedMs": scheduled_elapsed_ms, "cadenceOffsetMs": cadence_offset_ms,
                      "hostSummaryCount": len(host_rows), "frameTraceBatchCount": len(batch_rows),
                      "rvfcJoinCount": len(join_rows), "viewerSession": viewer_session,
                      "viewerDiagnostics": dict(viewer_diagnostics) if isinstance(viewer_diagnostics, Mapping) else None}
        samples.append(sample_row); samples_by_index[index] = {**sample_row, "hostSummaries": host_rows,
                                                                 "frameTraceBatches": batch_rows, "rvfcJoins": join_rows}
        summaries.extend(host_rows); batches.extend(batch_rows); joins.extend(join_rows)
        if isinstance(viewer_diagnostics, Mapping):
            diagnostics.append(dict(viewer_diagnostics))
    if not summaries:
        failures.add("missing-host-summary")
    if not batches:
        failures.add("missing-raw-frame-trace-batch")
    if expected_scope is None:
        failures.add("sample-scope-invalid")
        expected_scope = {}
    for end in range(5, RUN_SECONDS + 1, 5):
        rows = [samples_by_index[index] for index in range(end - 4, end + 1)]
        host_count = sum(len(row["hostSummaries"]) for row in rows)
        batch_count = sum(len(row["frameTraceBatches"]) for row in rows)
        join_count = sum(len(row["rvfcJoins"]) for row in rows)
        window = {"startSecond": end - 4, "endSecond": end, "hostSummaryCount": host_count,
                  "frameTraceBatchCount": batch_count, "rvfcJoinCount": join_count}
        windows.append(window)
        if not host_count:
            failures.add(f"window-{end}-host-summary-missing")
        if not batch_count:
            failures.add(f"window-{end}-raw-batch-missing")
        if not join_count:
            failures.add(f"window-{end}-rvfc-join-missing")
    if samples[-1]["elapsedMs"] < RUN_SECONDS * 1000:
        failures.add("final-elapsed-under-60s")
    observer = _observer_state(summaries)
    if not observer or observer.get("enabled") is not True:
        failures.add("observer-incompatible")
    artifact: dict[str, Any] = {
        "schemaVersion": 1,
        "kind": "turn-t3-lab-stage-run",
        "runId": _identity(identity)["runId"],
        "identity": _identity(identity),
        "durationSeconds": RUN_SECONDS,
        "samples": samples,
        "hostSummaries": summaries,
        "frameTraceBatches": batches,
        "rvfcJoins": joins,
        "viewerDiagnostics": diagnostics,
        "scope": expected_scope,
        "viewerSession": expected_viewer,
        "windows": windows,
        "observer": observer,
        # The existing encoder cannot independently delimit a reformat stage.
        # Leave it explicit instead of converting an absent boundary into 0ms.
        "reformat": {"status": "UNAVAILABLE", "reason": "no-independent-reformat-boundary"},
        "failures": sorted(failures),
        "status": "OBSERVED" if not failures else "UNALIGNED",
    }
    return _seal_artifact(artifact, verifier)


def write_artifact(path: Path, artifact: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    with temporary.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps(dict(artifact), ensure_ascii=False, indent=2) + "\n")
        handle.flush(); os.fsync(handle.fileno())
    os.replace(temporary, path)


def _drain_host_summaries(log_path: Path, offset: int) -> tuple[int, list[dict[str, Any]]]:
    if not log_path.exists():
        return offset, []
    with log_path.open("r", encoding="utf-8", errors="replace") as handle:
        handle.seek(offset)
        chunk = handle.read()
        offset = handle.tell()
    rows = []
    for line in chunk.splitlines():
        marker = "WRD_FRAME_TRACE_SUMMARY "
        if marker not in line:
            continue
        try:
            value = json.loads(line.split(marker, 1)[1])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            rows.append(value)
    return offset, rows


def _install_viewer_trace_tap(page: Any) -> None:
    page.evaluate("""() => {
      window.__wrdT3TraceBatches = [];
      const prior = WebRTC.acceptFrameTraceBatch.bind(WebRTC);
      WebRTC.acceptFrameTraceBatch = (batch) => {
        const before = WebRTC.getFrameTraceDiagnostics();
        const result = prior(batch);
        const after = WebRTC.getFrameTraceDiagnostics();
        // The raw batch is evidence only after the real Viewer collector has
        // accepted it.  A rejected, stale, conflicting, or dropped batch must
        // not become archival evidence merely because it reached this hook.
        const accepted = after.acceptanceState !== 'UNALIGNED'
          && after.droppedTraceCount === before.droppedTraceCount
          && after.invalidBatchCount === before.invalidBatchCount
          && after.staleTraceCount === before.staleTraceCount
          && after.conflictingTraceCount === before.conflictingTraceCount;
        if (accepted) {
          try { window.__wrdT3TraceBatches.push(JSON.parse(JSON.stringify(batch))); } catch (_) {}
        }
        return result;
      };
    }""")


def _drain_viewer_trace_tap(page: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    value = page.evaluate("""() => {
      const batches = Array.isArray(window.__wrdT3TraceBatches) ? window.__wrdT3TraceBatches.splice(0) : [];
      const joins = WebRTC.frameTraceCollector?.takeMatched?.() || [];
      return { batches, joins, diagnostics: WebRTC.getFrameTraceDiagnostics?.() || null };
    }""")
    if not isinstance(value, Mapping):
        return [], [], {}
    diagnostics = value.get("diagnostics")
    return (list(value.get("batches") or []), list(value.get("joins") or []),
            dict(diagnostics) if isinstance(diagnostics, Mapping) else {})


def _read_live_viewer_session(adapter: Any) -> dict[str, Any] | None:
    """Read the live rVFC scope and resolution together for every collector tick."""
    presentation = _valid_viewer_presentation(adapter.viewer_session_identity())
    trace_scope = _valid_scope(adapter.viewer_page.evaluate("""() => (
      typeof WebRTC === 'object' && typeof WebRTC.currentFrameTraceIdentity === 'function'
        ? WebRTC.currentFrameTraceIdentity() : null
    )"""))
    if (presentation is None or trace_scope is None or trace_scope["streamId"] != "video"
            or presentation["attemptId"] != trace_scope["attemptId"]
            or presentation["generation"] != trace_scope["generation"]):
        return None
    return {**trace_scope, "sourceWidth": presentation["sourceWidth"], "sourceHeight": presentation["sourceHeight"]}


def run_live(*, viewer_token: str, output: Path, headed_producer: bool) -> int:
    """Run the isolated Lab route when the headed fixture is available.

    The T5 driver remains the owner of producer/input wiring.  This collector
    requires its headed fixture; if that fixture cannot become capture-visible,
    a signed runtime artifact is written with the concrete external gate.
    """
    from turn_lab import LabRun
    from turn_controlled_scene import ProducerProof
    from turn_controlled_scene_lab_runner import PlaywrightLabViewerAdapter

    lab = LabRun(viewer_token=viewer_token)
    adapter = None
    try:
        identity = lab.start("legacy")
        lab.start_host()
        proof = ProducerProof(secrets.randbits(64), 1, identity.origin, "pending", 0, identity.realm, identity.run_id)
        adapter = PlaywrightLabViewerAdapter.open(lab, proof, headed_producer=headed_producer)
        visible, reason = adapter.producer_window_precondition()
        if not visible:
            artifact = {"schemaVersion": 1, "kind": "turn-t3-lab-stage-run", "runId": identity.run_id,
                        "identity": {"runId": identity.run_id, "realm": identity.realm, "origin": identity.origin, "epoch": identity.epoch},
                        "durationSeconds": RUN_SECONDS, "status": "BLOCKED", "failures": [reason, "headed-fixture-required"],
                        "reformat": {"status": "UNAVAILABLE", "reason": "no-independent-reformat-boundary"}}
            artifact = _seal_artifact(artifact, lab.transcript_verifier())
            write_artifact(output, artifact)
            return 2
        initial_viewer_session = _read_live_viewer_session(adapter)
        if initial_viewer_session is None:
            raise RuntimeError("Lab Viewer did not expose a stable trace scope")
        _install_viewer_trace_tap(adapter.viewer_page)
        log_path = lab.runtime_dir() / "host.stderr.log"
        offset = 0

        def one_sample(_index: int) -> dict[str, Any]:
            nonlocal offset
            offset, summaries = _drain_host_summaries(log_path, offset)
            batches, joins, diagnostics = _drain_viewer_trace_tap(adapter.viewer_page)
            viewer_session = _read_live_viewer_session(adapter)
            scope = _valid_scope(viewer_session)
            return {"scope": scope, "viewerSession": viewer_session, "hostSummaries": summaries, "frameTraceBatches": batches,
                    "rvfcJoins": joins, "viewerDiagnostics": diagnostics}

        captured_verifier = lab.transcript_verifier()
        artifact = collect_fixed_60_seconds(
            identity={"runId": identity.run_id, "realm": identity.realm, "origin": identity.origin, "epoch": identity.epoch},
            sample=one_sample, verifier=captured_verifier, wait=lambda seconds: adapter.viewer_page.wait_for_timeout(seconds * 1000),
            expected_viewer_session=initial_viewer_session,
        )
        if not verify_artifact(artifact, captured_verifier) or artifact.get("verification", {}).get("selfVerified") is not True:
            raise RuntimeError("Lab artifact did not verify before close")
        write_artifact(output, artifact)
        return 0 if artifact["status"] == "OBSERVED" else 1
    finally:
        if adapter is not None:
            adapter.close()
        lab.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Collect one signed, isolated 60-second T3 Lab stage artifact.")
    parser.add_argument("--viewer-token", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--headed-producer", action="store_true", help="Require the T5 headed fixture; no headless substitute exists.")
    args = parser.parse_args(argv)
    return run_live(viewer_token=args.viewer_token, output=args.output, headed_producer=args.headed_producer)


if __name__ == "__main__":
    raise SystemExit(main())
