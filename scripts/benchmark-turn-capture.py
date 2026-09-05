#!/usr/bin/env python3
"""Probe the producer/consumer capture pipeline without starting the Host.

The probe mirrors ScreenCaptureTrack's latest-frame contract: a producer only
performs MSS grabs, while a target-FPS consumer takes the newest sequence and
only converts a fresh frame. Results are local offline evidence; they cannot
authorize a production cadence change without selected-relay browser paint
evidence.
"""

from __future__ import annotations

import argparse
import json
import math
import platform
import statistics
import sys
import threading
import time
from pathlib import Path

import av
import cv2
import numpy as np
from mss import MSS


MULTIPLIERS = (1.0, 1.25, 1.5)
LEGACY_MULTIPLIER = 2.0
INTERPOLATIONS = {"INTER_LINEAR": cv2.INTER_LINEAR, "INTER_AREA": cv2.INTER_AREA}
PATH_STAGES = ("copy", "fromBuffer", "resize", "blankAllocate", "fromNdarray", "reformat")


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        raise ValueError("cannot summarize an empty sample")
    ordered = sorted(float(value) for value in values)
    index = (len(ordered) - 1) * fraction
    lower, upper = math.floor(index), math.ceil(index)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower)


def timing_summary(values: list[float]) -> dict[str, float | int | None]:
    if not values:
        return {"count": 0, "p50Ms": None, "p95Ms": None, "maxMs": None, "meanMs": None}
    return {
        "count": len(values),
        "p50Ms": round(percentile(values, 0.50), 3),
        "p95Ms": round(percentile(values, 0.95), 3),
        "maxMs": round(max(values), 3),
        "meanMs": round(statistics.fmean(values), 3),
    }


def inter_arrival_summary(timestamps: list[float]) -> dict[str, float | int | None]:
    return timing_summary([(later - earlier) * 1000 for earlier, later in zip(timestamps, timestamps[1:])])


def scaled_size(width: int, height: int, max_width: int, max_height: int) -> tuple[int, int]:
    if width <= max_width and height <= max_height:
        return width, height
    scale = min(max_width / width, max_height / height)
    return max(2, int(width * scale) // 2 * 2), max(2, int(height * scale) // 2 * 2)


def resize_and_convert(
    image: np.ndarray, size: tuple[int, int], interpolation: int
) -> tuple[float, float, float, np.ndarray]:
    resize_started = time.perf_counter()
    resized = cv2.resize(image, size, interpolation=interpolation)
    resize_ms = (time.perf_counter() - resize_started) * 1000
    frame_started = time.perf_counter()
    frame = av.VideoFrame.from_ndarray(resized, format="bgra")
    frame_ms = (time.perf_counter() - frame_started) * 1000
    yuv_started = time.perf_counter()
    yuv = frame.reformat(format="yuv420p")
    if (frame.width, frame.height) != size or (yuv.width, yuv.height) != size:
        raise RuntimeError("frame conversion changed the requested size")
    yuv_ms = (time.perf_counter() - yuv_started) * 1000
    return resize_ms, frame_ms, yuv_ms, resized


class LatestFrameBuffer:
    """Thread-safe latest-frame slot with production-equivalent overwrite truth."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._latest: tuple[int, object] | None = None
        self._sequence = 0
        self.produced = 0
        self.overwritten_dropped = 0

    def publish(self, shot: object) -> None:
        with self._lock:
            if self._latest is not None:
                self.overwritten_dropped += 1
            self._sequence += 1
            self._latest = (self._sequence, shot)
            self.produced += 1

    def consume_latest(self, after_sequence: int) -> tuple[int, object] | None:
        with self._lock:
            if self._latest is None or self._latest[0] <= after_sequence:
                return None
            latest = self._latest
            self._latest = None
            return latest

    def pending_count(self) -> int:
        with self._lock:
            return int(self._latest is not None)


def _wait_until(deadline: float, stop: threading.Event) -> bool:
    while not stop.is_set():
        remaining = deadline - time.perf_counter()
        if remaining <= 0:
            return True
        stop.wait(min(remaining, 0.003))
    return False


def run_capture_candidate(
    sct: MSS,
    monitor: dict,
    *,
    target_fps: int,
    multiplier: float,
    duration_seconds: float,
    size: tuple[int, int],
    producer_phase_seconds: float = 0.0,
    consumer_phase_seconds: float = 0.0,
    producer_jitter_seconds: tuple[float, ...] = (0.0,),
    slow_grab_seconds: float = 0.0,
    consumer_jitter_seconds: tuple[float, ...] = (0.0,),
    consumer_delay_seconds: float = 0.0,
) -> dict:
    """Run separate producer and consumer schedulers for one cadence candidate."""
    capture_fps = math.ceil(target_fps * multiplier)
    producer_interval = 1.0 / capture_fps
    consumer_interval = 1.0 / target_fps
    started = time.perf_counter()
    finishes_at = started + duration_seconds
    buffer = LatestFrameBuffer()
    stop = threading.Event()
    producer_grab_ms: list[float] = []
    producer_timestamps: list[float] = []
    producer_guard = threading.Lock()

    def producer() -> None:
        deadline = started + producer_phase_seconds
        index = 0
        while _wait_until(deadline, stop) and time.perf_counter() < finishes_at:
            grab_started = time.perf_counter()
            shot = sct.grab(monitor)
            if slow_grab_seconds:
                time.sleep(slow_grab_seconds)
            completed_at = time.perf_counter()
            with producer_guard:
                producer_grab_ms.append((completed_at - grab_started) * 1000)
                producer_timestamps.append(completed_at)
            buffer.publish(shot)
            jitter = producer_jitter_seconds[index % len(producer_jitter_seconds)]
            deadline += producer_interval + jitter
            index += 1

    producer_thread = threading.Thread(target=producer, daemon=True, name="capture-benchmark-producer")
    producer_thread.start()

    consumer_timestamps: list[float] = []
    path_values = {
        path: {stage: [] for stage in PATH_STAGES}
        for path in ("fresh", "reused", "initialBlank")
    }
    fresh_consumed = reused = initial_blank = 0
    last_sequence = 0
    last_image = None
    consumer_deadline = started + consumer_phase_seconds
    consumer_index = 0
    try:
        while _wait_until(consumer_deadline, stop) and time.perf_counter() < finishes_at:
            consumer_timestamps.append(time.perf_counter())
            latest = buffer.consume_latest(last_sequence)
            if latest is not None:
                sequence, shot = latest
                from_buffer_started = time.perf_counter()
                image = np.frombuffer(shot.raw, dtype=np.uint8).reshape(shot.height, shot.width, 4)
                path_values["fresh"]["fromBuffer"].append((time.perf_counter() - from_buffer_started) * 1000)
                resize_started = time.perf_counter()
                consumer_image = cv2.resize(image, size, interpolation=cv2.INTER_LINEAR)
                path_values["fresh"]["resize"].append((time.perf_counter() - resize_started) * 1000)
                fresh_consumed += 1
                last_sequence = sequence
                last_image = consumer_image
                path = "fresh"
            elif last_image is not None:
                copy_started = time.perf_counter()
                consumer_image = last_image.copy()
                path_values["reused"]["copy"].append((time.perf_counter() - copy_started) * 1000)
                reused += 1
                path = "reused"
            else:
                blank_started = time.perf_counter()
                consumer_image = np.zeros((size[1], size[0], 4), dtype=np.uint8)
                path_values["initialBlank"]["blankAllocate"].append((time.perf_counter() - blank_started) * 1000)
                initial_blank += 1
                path = "initialBlank"

            frame_started = time.perf_counter()
            frame = av.VideoFrame.from_ndarray(consumer_image, format="bgra")
            path_values[path]["fromNdarray"].append((time.perf_counter() - frame_started) * 1000)
            yuv_started = time.perf_counter()
            yuv = frame.reformat(format="yuv420p")
            if (frame.width, frame.height) != size or (yuv.width, yuv.height) != size:
                raise RuntimeError("consumer frame conversion changed the requested size")
            path_values[path]["reformat"].append((time.perf_counter() - yuv_started) * 1000)
            if consumer_delay_seconds:
                time.sleep(consumer_delay_seconds)
            consumer_deadline += consumer_interval + consumer_jitter_seconds[consumer_index % len(consumer_jitter_seconds)]
            consumer_index += 1
    finally:
        stop.set()
        producer_thread.join(timeout=2.0)

    with producer_guard:
        producer_times = list(producer_timestamps)
        producer_grab = list(producer_grab_ms)
    path_costs = {
        path: {stage: timing_summary(values) for stage, values in stages.items()}
        for path, stages in path_values.items()
    }
    path_totals = {
        path: sum(sum(values) for values in stages.values())
        for path, stages in path_values.items()
    }
    frame_conversion_calls = sum(len(path_values[path]["fromNdarray"]) for path in path_values)
    pending_at_stop = buffer.pending_count()
    return {
        "multiplier": multiplier,
        "captureFps": capture_fps,
        "producerPhaseMs": round(producer_phase_seconds * 1000, 3),
        "consumerPhaseMs": round(consumer_phase_seconds * 1000, 3),
        "producerJitterMs": [round(value * 1000, 3) for value in producer_jitter_seconds],
        "slowGrabMs": round(slow_grab_seconds * 1000, 3),
        "consumerJitterMs": [round(value * 1000, 3) for value in consumer_jitter_seconds],
        "consumerDelayMs": round(consumer_delay_seconds * 1000, 3),
        "produced": buffer.produced,
        "consumed": fresh_consumed,
        "freshConsumed": fresh_consumed,
        "reused": reused,
        "initialBlank": initial_blank,
        "overwrittenDropped": buffer.overwritten_dropped,
        "consumerTicks": len(consumer_timestamps),
        "consumerProcessingCalls": fresh_consumed,
        "unconsumedAtStop": pending_at_stop,
        "producerGrab": timing_summary(producer_grab),
        "pathCosts": path_costs,
        "consumerResize": timing_summary(path_values["fresh"]["resize"]),
        "consumerFrameConversion": timing_summary(
            [value for path in path_values.values() for value in path["fromNdarray"]]
        ),
        "consumerBgraToYuv420": timing_summary(
            [value for path in path_values.values() for value in path["reformat"]]
        ),
        "producerInterArrival": inter_arrival_summary(producer_times),
        "consumerInterArrival": inter_arrival_summary(consumer_timestamps),
        "costModel": {
            "producerGrabTotalMs": round(sum(producer_grab), 3),
            "freshProcessingTotalMs": round(path_totals["fresh"], 3),
            "reuseProcessingTotalMs": round(path_totals["reused"], 3),
            "initialBlankProcessingTotalMs": round(path_totals["initialBlank"], 3),
            "totalConsumerProcessingMs": round(sum(path_totals.values()), 3),
            "producerCalls": len(producer_grab),
            "freshProcessingCalls": fresh_consumed,
            "reuseCopyCalls": len(path_values["reused"]["copy"]),
            "frameConversionCalls": frame_conversion_calls,
            "reformatCalls": frame_conversion_calls,
            "note": "totals use actual path calls; producer cadence never multiplies consumer processing",
        },
    }


def quality_proxy(source: np.ndarray, resized: np.ndarray) -> dict[str, float]:
    restored = cv2.resize(resized, (source.shape[1], source.shape[0]), interpolation=cv2.INTER_LINEAR)
    source_rgb = source[:, :, :3].astype(np.float32)
    restored_rgb = restored[:, :, :3].astype(np.float32)
    mse = float(np.mean((source_rgb - restored_rgb) ** 2))
    psnr = 99.0 if mse == 0 else 20 * math.log10(255.0 / math.sqrt(mse))
    source_edges = float(np.mean(np.abs(cv2.Laplacian(source_rgb, cv2.CV_32F))))
    restored_edges = float(np.mean(np.abs(cv2.Laplacian(restored_rgb, cv2.CV_32F))))
    return {
        "roundTripPsnrDb": round(psnr, 3),
        "edgeRetentionRatio": round(restored_edges / source_edges, 5) if source_edges else 1.0,
    }


def run_interpolation_candidate(source: np.ndarray, size: tuple[int, int], name: str) -> dict:
    resize_values: list[float] = []
    frame_values: list[float] = []
    yuv_values: list[float] = []
    resized = None
    for _ in range(40):
        resize_elapsed, frame_elapsed, yuv_elapsed, resized = resize_and_convert(source, size, INTERPOLATIONS[name])
        resize_values.append(resize_elapsed)
        frame_values.append(frame_elapsed)
        yuv_values.append(yuv_elapsed)
    assert resized is not None
    return {
        "interpolation": name,
        "resize": timing_summary(resize_values),
        "frameConversion": timing_summary(frame_values),
        "bgraToYuv420": timing_summary(yuv_values),
        "qualityProxy": quality_proxy(source, resized),
        "offlineEligibility": "LOCAL_PROXY_ONLY",
        "runtimePaintGate": "PENDING",
    }


def select_multiplier(candidates: list[dict], legacy_baseline: dict) -> dict:
    """Record offline candidates but never turn them into a production selection."""
    eligible = [
        candidate["multiplier"]
        for candidate in candidates
        if candidate.get("offlineEligible", candidate.get("targetFrameAvailable", False))
    ]
    return {
        "applied": False,
        "value": legacy_baseline.get("multiplier", LEGACY_MULTIPLIER),
        "offlineEligibleMultipliers": eligible,
        "runtimePaintGate": "PENDING",
        "reason": "selected-relay browser paint A/B is required before changing legacy capture cadence",
    }


def select_interpolation(candidates: list[dict], *, resize_budget_ms: float) -> dict:
    linear = next(candidate for candidate in candidates if candidate["interpolation"] == "INTER_LINEAR")
    area = next(candidate for candidate in candidates if candidate["interpolation"] == "INTER_AREA")
    local_proxy_improved = (
        area["qualityProxy"]["roundTripPsnrDb"] > linear["qualityProxy"]["roundTripPsnrDb"]
        and area["qualityProxy"]["edgeRetentionRatio"] >= linear["qualityProxy"]["edgeRetentionRatio"]
    )
    within_budget = area["resize"]["p95Ms"] <= resize_budget_ms
    return {
        "applied": False,
        "value": "INTER_LINEAR",
        "offlineEligible": bool(local_proxy_improved and within_budget),
        "runtimePaintGate": "PENDING",
        "reason": "local resize evidence does not replace selected-relay browser paint validation",
    }


def scheduler_scenarios(capture_fps: int, *, target_fps: int = 20) -> tuple[dict, ...]:
    producer_conditions = (
        ("producer-stable", 0.0, (0.0,), 0.0),
        ("producer-jitter", 0.5 / capture_fps, (0.0, 0.002, -0.001), 0.0),
        ("producer-slow-grab", 0.0, (0.0, 0.001), 0.008),
    )
    consumer_conditions = (
        ("consumer-aligned", 0.0, (0.0,), 0.0),
        ("consumer-phase-jitter-delay", 0.5 / target_fps, (0.0, 0.003, -0.001), 0.004),
    )
    return tuple(
        {
            "name": f"{producer_name}-{consumer_name}",
            "producer_phase_seconds": producer_phase,
            "consumer_phase_seconds": consumer_phase,
            "producer_jitter_seconds": producer_jitter,
            "slow_grab_seconds": slow_grab,
            "consumer_jitter_seconds": consumer_jitter,
            "consumer_delay_seconds": consumer_delay,
        }
        for producer_name, producer_phase, producer_jitter, slow_grab in producer_conditions
        for consumer_name, consumer_phase, consumer_jitter, consumer_delay in consumer_conditions
    )


def run_multiplier_scenarios(
    sct: MSS,
    monitor: dict,
    *,
    target_fps: int,
    multiplier: float,
    duration_seconds: float,
    size: tuple[int, int],
) -> dict:
    capture_fps = math.ceil(target_fps * multiplier)
    scenarios = []
    for scenario in scheduler_scenarios(capture_fps, target_fps=target_fps):
        result = run_capture_candidate(
            sct,
            monitor,
            target_fps=target_fps,
            multiplier=multiplier,
            duration_seconds=duration_seconds,
            size=size,
            **{key: value for key, value in scenario.items() if key != "name"},
        )
        result["name"] = scenario["name"]
        scenarios.append(result)
    return {
        "multiplier": multiplier,
        "captureFps": capture_fps,
        "scenarios": scenarios,
        "offlineEligible": False,
        "runtimePaintGate": "PENDING",
        "offlineEligibility": "LOCAL_CAPTURE_ONLY",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--target-fps", default=20, type=int)
    parser.add_argument("--duration", default=4.0, type=float)
    parser.add_argument("--max-width", default=1280, type=int)
    parser.add_argument("--max-height", default=720, type=int)
    parser.add_argument("--resize-budget-ms", default=25.0, type=float)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.target_fps <= 0 or args.duration <= 0:
        raise SystemExit("--target-fps and --duration must be positive")
    with MSS() as sct:
        monitor = sct.monitors[1]
        first_shot = sct.grab(monitor)
        source = np.frombuffer(first_shot.raw, dtype=np.uint8).reshape(
            first_shot.height, first_shot.width, 4
        )
        output_size = scaled_size(source.shape[1], source.shape[0], args.max_width, args.max_height)
        legacy_baseline = run_multiplier_scenarios(
            sct,
            monitor,
            target_fps=args.target_fps,
            multiplier=LEGACY_MULTIPLIER,
            duration_seconds=args.duration,
            size=output_size,
        )
        candidates = [
            run_multiplier_scenarios(
                sct,
                monitor,
                target_fps=args.target_fps,
                multiplier=multiplier,
                duration_seconds=args.duration,
                size=output_size,
            )
            for multiplier in MULTIPLIERS
        ]
        interpolations = [run_interpolation_candidate(source, output_size, name) for name in INTERPOLATIONS]
    result = {
        "schemaVersion": 2,
        "scope": "local dual-scheduler capture probe; no Host, browser, relay, tunnel, or encoder was started",
        "environment": {
            "python": sys.version,
            "platform": platform.platform(),
            "opencv": cv2.__version__,
            "pyav": av.__version__,
        },
        "input": {
            "monitor": {key: monitor[key] for key in ("left", "top", "width", "height")},
            "targetFps": args.target_fps,
            "durationSecondsPerScenario": args.duration,
            "outputSize": {"width": output_size[0], "height": output_size[1]},
            "resizeBudgetMs": args.resize_budget_ms,
        },
        "legacyCaptureBaseline": legacy_baseline,
        "captureMultiplierCandidates": candidates,
        "resizeInterpolationCandidates": interpolations,
        "selection": {
            "captureMultiplier": select_multiplier(candidates, legacy_baseline),
            "resizeInterpolation": select_interpolation(interpolations, resize_budget_ms=args.resize_budget_ms),
        },
        "limitations": {
            "runtimePaintGate": "PENDING: only Task 9 selected-relay browser A/B can prove paint FPS does not regress",
            "periodicIdrQuality": "NOT EVALUATED: this probe does not encode or change codec, GOP, bitrate, VBV, or policy",
            "bgraToYuv": "Measured only for fresh-consumed PyAV frames; no copy-elimination change is applied",
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps(result["selection"], indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
