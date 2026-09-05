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
    resize_ms: list[float] = []
    frame_ms: list[float] = []
    yuv_ms: list[float] = []
    fresh_consumed = reused = initial_blank = 0
    last_sequence = 0
    has_processed_frame = False
    consumer_deadline = started + consumer_phase_seconds
    try:
        while _wait_until(consumer_deadline, stop) and time.perf_counter() < finishes_at:
            consumer_timestamps.append(time.perf_counter())
            latest = buffer.consume_latest(last_sequence)
            if latest is None:
                if has_processed_frame:
                    reused += 1
                else:
                    initial_blank += 1
            else:
                sequence, shot = latest
                image = np.frombuffer(shot.raw, dtype=np.uint8).reshape(shot.height, shot.width, 4)
                resize_elapsed, frame_elapsed, yuv_elapsed, _ = resize_and_convert(
                    image, size, cv2.INTER_LINEAR
                )
                resize_ms.append(resize_elapsed)
                frame_ms.append(frame_elapsed)
                yuv_ms.append(yuv_elapsed)
                fresh_consumed += 1
                last_sequence = sequence
                has_processed_frame = True
            consumer_deadline += consumer_interval
    finally:
        stop.set()
        producer_thread.join(timeout=2.0)

    with producer_guard:
        producer_times = list(producer_timestamps)
        producer_grab = list(producer_grab_ms)
    processing_total_ms = sum(resize_ms) + sum(frame_ms) + sum(yuv_ms)
    return {
        "multiplier": multiplier,
        "captureFps": capture_fps,
        "producerPhaseMs": round(producer_phase_seconds * 1000, 3),
        "consumerPhaseMs": round(consumer_phase_seconds * 1000, 3),
        "producerJitterMs": [round(value * 1000, 3) for value in producer_jitter_seconds],
        "slowGrabMs": round(slow_grab_seconds * 1000, 3),
        "produced": buffer.produced,
        "freshConsumed": fresh_consumed,
        "reused": reused,
        "initialBlank": initial_blank,
        "overwrittenDropped": buffer.overwritten_dropped,
        "consumerTicks": len(consumer_timestamps),
        "consumerProcessingCalls": fresh_consumed,
        "producerGrab": timing_summary(producer_grab),
        "consumerResize": timing_summary(resize_ms),
        "consumerFrameConversion": timing_summary(frame_ms),
        "consumerBgraToYuv420": timing_summary(yuv_ms),
        "producerInterArrival": inter_arrival_summary(producer_times),
        "consumerInterArrival": inter_arrival_summary(consumer_timestamps),
        "costModel": {
            "producerGrabTotalMs": round(sum(producer_grab), 3),
            "freshProcessingTotalMs": round(processing_total_ms, 3),
            "producerCalls": len(producer_grab),
            "freshProcessingCalls": fresh_consumed,
            "note": "processing totals count only fresh-consumed frames; they are not multiplied by producer cadence",
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


def scheduler_scenarios(capture_fps: int) -> tuple[dict, ...]:
    return (
        {
            "name": "aligned",
            "producer_phase_seconds": 0.0,
            "consumer_phase_seconds": 0.0,
            "producer_jitter_seconds": (0.0,),
            "slow_grab_seconds": 0.0,
        },
        {
            "name": "consumer-first-jitter",
            "producer_phase_seconds": 0.5 / capture_fps,
            "consumer_phase_seconds": 0.0,
            "producer_jitter_seconds": (0.0, 0.002, -0.001),
            "slow_grab_seconds": 0.0,
        },
        {
            "name": "slow-grab",
            "producer_phase_seconds": 0.0,
            "consumer_phase_seconds": 0.25 / capture_fps,
            "producer_jitter_seconds": (0.0, 0.001),
            "slow_grab_seconds": 0.008,
        },
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
    for scenario in scheduler_scenarios(capture_fps):
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
