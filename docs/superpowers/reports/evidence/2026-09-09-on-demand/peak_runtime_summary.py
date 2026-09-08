#!/usr/bin/env python3
"""Read-only summary for one WRD peak-runtime attempt.

The runtime JSON supplies Viewer/rVFC/CPU samples.  Encoder data is parsed only
from WRD_ENCODER_SAMPLE log records whose connectionAttemptId equals --attempt.
It deliberately reports the range of Host five-second rolling P95 values; it
never manufactures a pooled encoder P95 from those windows.
"""
from __future__ import annotations

import argparse
import json
import math
import re
from datetime import datetime
from pathlib import Path
from statistics import median
from zoneinfo import ZoneInfo

LOCAL_TZ = ZoneInfo("Asia/Shanghai")
ENCODER_MARKER = "WRD_ENCODER_SAMPLE "
LOG_TS = re.compile(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d\d\d) ")


def percentile(values: list[float], p: float) -> float | None:
    values = sorted(float(x) for x in values if x is not None)
    if not values:
        return None
    return values[max(0, math.ceil(len(values) * p / 100) - 1)]


def rounded(value: float | None, digits: int = 3) -> float | None:
    return None if value is None else round(value, digits)


def parse_encoder(log: Path, attempt: str) -> list[dict]:
    rows: list[dict] = []
    for line in log.read_text(errors="replace").splitlines():
        if ENCODER_MARKER not in line:
            continue
        match = LOG_TS.match(line)
        if not match:
            continue
        try:
            payload = json.loads(line.split(ENCODER_MARKER, 1)[1])
        except json.JSONDecodeError:
            continue
        if payload.get("connectionAttemptId") != attempt:
            continue
        ts = datetime.strptime(match.group(1), "%Y-%m-%d %H:%M:%S,%f").replace(tzinfo=LOCAL_TZ).timestamp()
        rows.append({"at": ts, "payload": payload})
    return rows


def sample_at_seconds(sample: dict) -> float:
    return float(sample["at"]) / 1000.0


def phase_window(runtime: dict, phases: list[dict], index: int) -> tuple[float, float, str]:
    """Strictly bound a phase to persisted first/last Viewer snapshots.

    The pulse runner does not persist lifecycle timestamps.  No inferred settle
    allowance is included, so a five-second encoder window may include frames
    before its first Viewer snapshot.  Such partial overlap is disclosed rather
    than attributed precisely.  Initial IDRs outside this strict window remain
    available only in attemptEncoderTotals.
    """
    samples = phases[index].get("samples", [])
    if not samples:
        raise ValueError(f"phase {index} has no samples")
    return (sample_at_seconds(samples[0]), sample_at_seconds(samples[-1]),
            "strict first/last persisted Viewer snapshot only; a native five-second encoder window can partially overlap a boundary; no settle/post-phase allowance")


def delta(last: dict | None, first: dict | None, key: str) -> float | int | None:
    if not isinstance(last, dict) or not isinstance(first, dict):
        return None
    a, b = last.get(key), first.get(key)
    return None if a is None or b is None else a - b


def summarize_viewer(samples: list[dict]) -> dict:
    if len(samples) < 2:
        return {"sampleCount": len(samples), "insufficient": True}
    fps: list[float] = []
    buffers: list[float] = []
    for before, after in zip(samples, samples[1:]):
        elapsed = (sample_at_seconds(after) - sample_at_seconds(before))
        a, b = before.get("video") or {}, after.get("video") or {}
        if elapsed > 0:
            decoded = delta(b, a, "framesDecoded")
            if decoded is not None and decoded >= 0:
                fps.append(decoded / elapsed)
            delay = delta(b, a, "jitterBufferDelay")
            emitted = delta(b, a, "jitterBufferEmittedCount")
            if delay is not None and emitted and emitted > 0 and delay >= 0:
                buffers.append(delay * 1000.0 / emitted)
    first, last = samples[0], samples[-1]
    elapsed = sample_at_seconds(last) - sample_at_seconds(first)
    decoded = delta(last.get("video") or {}, first.get("video") or {}, "framesDecoded")
    gaps = [((s.get("paint") or {}).get("maxGapMs")) for s in samples]
    obs_max = [(((s.get("paintObservation") or {}).get("intervalMs") or {}).get("max")) for s in samples]
    geometry = [((s.get("paintObservation") or {}).get("geometry") or {}).get("changes") for s in samples]
    return {
        "sampleCount": len(samples),
        "observedSeconds": rounded(elapsed),
        "intervalDecodedFps": {"p50": rounded(median(fps)) if fps else None, "p95": rounded(percentile(fps, 95)), "count": len(fps)},
        "overallDecodedFps": rounded(decoded / elapsed) if decoded is not None and elapsed > 0 else None,
        "rVfc": {"phaseMaxGapMs": rounded(max(x for x in gaps if x is not None), 3) if any(x is not None for x in gaps) else None,
                 "intervalMaxGapMs": rounded(max(x for x in obs_max if x is not None), 3) if any(x is not None for x in obs_max) else None,
                 "geometryChangesMax": max(x for x in geometry if x is not None) if any(x is not None for x in geometry) else None},
        "jitterBufferPerEmittedFrameMs": {"meaning": "per-snapshot-interval average residence time: delta jitterBufferDelay / delta jitterBufferEmittedCount; p95/max describe the distribution of window averages, not a strict per-frame maximum", "p95": rounded(percentile(buffers, 95)), "max": rounded(max(buffers), 3) if buffers else None, "count": len(buffers)},
        "deltas": {key: delta(last.get("video") or {}, first.get("video") or {}, key) for key in ("freezeCount", "totalFreezesDuration", "framesDropped", "packetsLost", "nackCount", "pliCount", "firCount")},
    }


def summarize_cpu(samples: list[dict]) -> dict:
    values = [((s.get("projectCpu") or {}).get("sum")) for s in samples]
    values = [float(v) for v in values if v is not None]
    scopes = sorted({(s.get("projectCpu") or {}).get("scope") for s in samples if (s.get("projectCpu") or {}).get("scope")})
    return {"sampleCount": len(values), "scope": scopes, "percentOfOneLogicalCore": {"p50": rounded(median(values)) if values else None, "p95": rounded(percentile(values, 95)), "max": rounded(max(values)) if values else None}}


def summarize_encoder(rows: list[dict]) -> dict:
    if not rows:
        return {"sampleCount": 0, "missing": True}
    payloads = [row["payload"] for row in rows]
    counts = [float((p.get("encode") or {}).get("count") or 0) for p in payloads]
    avgs = [float((p.get("encode") or {}).get("avgMs") or 0) for p in payloads]
    total = sum(counts)
    p95s = [float((p.get("encode") or {}).get("p95Ms")) for p in payloads if (p.get("encode") or {}).get("p95Ms") is not None]
    reasons: dict[str, int] = {}
    wanted_keys = ("initial", "periodic", "forced", "pli", "safety")
    key_sums: dict[str, int] = {}
    key_seen: set[str] = set()
    effective: list[float] = []
    for p in payloads:
        keyframe_data = p.get("keyframes")
        if isinstance(keyframe_data, dict):
            for key in wanted_keys:
                if key in keyframe_data and keyframe_data[key] is not None:
                    key_seen.add(key)
                    key_sums[key] = key_sums.get(key, 0) + int(keyframe_data[key])
        for key, value in (p.get("keyframeReasons") or {}).items():
            reasons[key] = reasons.get(key, 0) + int(value or 0)
        value = (p.get("bitrate") or {}).get("effective")
        if value is not None:
            effective.append(float(value))
    return {
        "sampleCount": len(rows),
        "encodedFramesInWindows": int(total),
        "weightedMeanMs": rounded(sum(a * c for a, c in zip(avgs, counts)) / total) if total else None,
        "rollingP95Ms": {"min": rounded(min(p95s)) if p95s else None, "max": rounded(max(p95s)) if p95s else None, "valuesNotPooled": True, "windowCount": len(p95s)},
        "keyframes": {key: key_sums.get(key) if key in key_seen else None for key in wanted_keys},
        "keyframeReasons": reasons,
        "effectiveBitrateBps": {"min": int(min(effective)) if effective else None, "max": int(max(effective)) if effective else None, "values": sorted(set(int(x) for x in effective))},
        "policyIds": sorted({p.get("policyId") for p in payloads}),
        "sizes": sorted({f"{(p.get('size') or {}).get('width')}x{(p.get('size') or {}).get('height')}" for p in payloads}),
    }


def baseline_trend(baseline_path: Path | None, phases: list[dict]) -> dict | None:
    if baseline_path is None or not baseline_path.exists():
        return None
    base = json.loads(baseline_path.read_text())
    indexed = {x.get("height"): x for x in base.get("phases", [])}
    changes = []
    for phase in phases:
        old = indexed.get(phase["height"])
        if old:
            changes.append({"height": phase["height"], "baseline": {k: old.get(k) for k in ("decodedFps", "freezeDelta", "maxPaintGapMs", "encoderWeightedMeanMs")}, "current": {"overallDecodedFps": phase["viewer"].get("overallDecodedFps"), "freezeDelta": phase["viewer"].get("deltas", {}).get("freezeCount"), "maxPaintGapMs": phase["viewer"].get("rVfc", {}).get("phaseMaxGapMs"), "encoderWeightedMeanMs": phase["encoder"].get("weightedMeanMs")}})
    return {"source": str(baseline_path), "comparability": "NON_CONTROLLED_TREND_ONLY: different commit/session/desktop/network; no causal or strict A/B claim.", "phases": changes}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("runtime_json", type=Path)
    ap.add_argument("host_log", type=Path)
    ap.add_argument("--attempt", required=True)
    ap.add_argument("--baseline", type=Path, default=Path("docs/superpowers/reports/evidence/2026-09-09-on-demand/initial-production-summary.json"))
    ap.add_argument("--output", type=Path)
    args = ap.parse_args()
    runtime = json.loads(args.runtime_json.read_text())
    encoder = parse_encoder(args.host_log, args.attempt)
    phases_out = []
    phases = runtime.get("phases", [])
    for index, phase in enumerate(phases):
        samples = phase.get("samples", [])
        if not samples:
            continue
        start, end, note = phase_window(runtime, phases, index)
        height = phase.get("height")
        matching = [r for r in encoder if start <= r["at"] <= end and (r["payload"].get("size") or {}).get("height") == height]
        phases_out.append({"height": height, "timeWindow": {"startLocal": datetime.fromtimestamp(start, LOCAL_TZ).isoformat(), "endLocal": datetime.fromtimestamp(end, LOCAL_TZ).isoformat(), "boundaryMethod": note}, "viewer": summarize_viewer(samples), "projectCpu": summarize_cpu(samples), "encoder": summarize_encoder(matching)})
    out = {"attempt": args.attempt, "runtimeJson": str(args.runtime_json), "hostLog": str(args.host_log), "runtimeComplete": bool(runtime.get("endedAt")), "runtimeOk": runtime.get("ok"), "interpretation": {"encoder": "weighted mean is valid only over logged five-second windows; rollingP95Ms is min/max of native rolling P95 values and is explicitly not a pooled raw P95. Phase membership uses strict Viewer snapshot time only, so boundary windows can be partial.", "viewer": "rVFC and inbound-rtp measurements are from the local Chromium TURN run; geometry changes are browser presentation geometry only.", "cpu": "only runtime-captured projectCpu scope is reported; it is not used to debias encode timing.", "missingData": "Absent source fields remain null; no missing metric is converted to zero."}, "attemptEncoderTotals": {"scope": "all matching encoder samples for this unique attempt, including samples outside strict Viewer phase windows (for example an initial IDR before the first snapshot)", **summarize_encoder(encoder)}, "phases": phases_out}
    out["initialProductionTrend"] = baseline_trend(args.baseline, phases_out)
    text = json.dumps(out, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(text + "\n")
    print(text)

if __name__ == "__main__":
    main()
