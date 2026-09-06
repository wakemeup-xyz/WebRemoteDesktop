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


def _canonical(value: Mapping[str, Any]) -> bytes:
    return json.dumps(dict(value), sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def _unsigned(artifact: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in artifact.items() if key != "signature"}


def sign_artifact(artifact: Mapping[str, Any], verifier: bytes) -> str:
    return hmac.new(bytes(verifier), _canonical(_unsigned(artifact)), hashlib.sha256).hexdigest()


def verify_artifact(artifact: Mapping[str, Any], verifier: bytes) -> bool:
    signature = artifact.get("signature") if isinstance(artifact, Mapping) else None
    return isinstance(signature, str) and hmac.compare_digest(signature, sign_artifact(artifact, verifier))


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


def collect_fixed_60_seconds(*, identity: Mapping[str, Any], sample: Callable[[int], Mapping[str, Any]],
                             verifier: bytes, wait: Callable[[float], None] = time.sleep) -> dict[str, Any]:
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
    failures: set[str] = set()
    started = time.monotonic()
    for index in range(RUN_SECONDS + 1):
        delay = started + index - time.monotonic()
        if delay > 0:
            wait(delay)
        raw = sample(index)
        if not isinstance(raw, Mapping):
            raw = {}
        host_summaries = raw.get("hostSummaries")
        trace_batches = raw.get("frameTraceBatches")
        rvfc_joins = raw.get("rvfcJoins")
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
            if summary.get("alignmentState") != "OBSERVED":
                failures.add("host-summary-unaligned")
        for batch in batch_rows:
            if batch.get("type") != "frame_trace_batch" or batch.get("schemaVersion") != 1:
                failures.add("invalid-raw-frame-trace-batch")
        elapsed_ms = max(0, round((time.monotonic() - started) * 1000))
        samples.append({"sampleIndex": index, "elapsedMs": elapsed_ms,
                        "hostSummaryCount": len(host_rows), "frameTraceBatchCount": len(batch_rows),
                        "rvfcJoinCount": len(join_rows)})
        summaries.extend(host_rows); batches.extend(batch_rows); joins.extend(join_rows)
    if not summaries:
        failures.add("missing-host-summary")
    if not batches:
        failures.add("missing-raw-frame-trace-batch")
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
        "observer": observer,
        # The existing encoder cannot independently delimit a reformat stage.
        # Leave it explicit instead of converting an absent boundary into 0ms.
        "reformat": {"status": "UNAVAILABLE", "reason": "no-independent-reformat-boundary"},
        "failures": sorted(failures),
        "status": "OBSERVED" if not failures else "UNALIGNED",
    }
    artifact["signature"] = sign_artifact(artifact, verifier)
    return artifact


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
        try { window.__wrdT3TraceBatches.push(JSON.parse(JSON.stringify(batch))); } catch (_) {}
        return prior(batch);
      };
    }""")


def _drain_viewer_trace_tap(page: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    value = page.evaluate("""() => {
      const batches = Array.isArray(window.__wrdT3TraceBatches) ? window.__wrdT3TraceBatches.splice(0) : [];
      const joins = WebRTC.frameTraceCollector?.takeMatched?.() || [];
      return { batches, joins };
    }""")
    if not isinstance(value, Mapping):
        return [], []
    return (list(value.get("batches") or []), list(value.get("joins") or []))


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
            artifact["signature"] = sign_artifact(artifact, lab.transcript_verifier())
            write_artifact(output, artifact)
            return 2
        _install_viewer_trace_tap(adapter.viewer_page)
        log_path = lab.runtime_dir() / "host.stderr.log"
        offset = 0

        def one_sample(_index: int) -> dict[str, Any]:
            nonlocal offset
            offset, summaries = _drain_host_summaries(log_path, offset)
            batches, joins = _drain_viewer_trace_tap(adapter.viewer_page)
            return {"hostSummaries": summaries, "frameTraceBatches": batches, "rvfcJoins": joins}

        artifact = collect_fixed_60_seconds(
            identity={"runId": identity.run_id, "realm": identity.realm, "origin": identity.origin, "epoch": identity.epoch},
            sample=one_sample, verifier=lab.transcript_verifier(), wait=lambda seconds: adapter.viewer_page.wait_for_timeout(seconds * 1000),
        )
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
