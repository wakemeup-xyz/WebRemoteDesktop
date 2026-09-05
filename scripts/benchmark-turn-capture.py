#!/usr/bin/env python3
"""Measure the local capture-stage choices without starting the Host or a tunnel.

The probe samples the active desktop through MSS, but never creates a
ScreenCaptureTrack, PeerConnection, or encoder.  It deliberately reports only
capture-stage availability; browser paint FPS remains a separate runtime gate.
"""

from __future__ import annotations

import argparse
import json
import math
import platform
import statistics
import sys
import time
from pathlib import Path

import av
import cv2
import numpy as np
from mss import MSS


MULTIPLIERS = (1.0, 1.25, 1.5)
LEGACY_MULTIPLIER = 2.0
INTERPOLATIONS = {
    "INTER_LINEAR": cv2.INTER_LINEAR,
    "INTER_AREA": cv2.INTER_AREA,
}


def percentile(values: list[float], fraction: float) -> float:
    """Return a stable linear percentile for a non-empty millisecond sample."""
    if not values:
        raise ValueError("cannot summarize an empty sample")
    ordered = sorted(float(value) for value in values)
    index = (len(ordered) - 1) * fraction
    lower = math.floor(index)
    upper = math.ceil(index)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower)


def timing_summary(values: list[float]) -> dict[str, float]:
    return {
        "count": len(values),
        "p50Ms": round(percentile(values, 0.50), 3),
        "p95Ms": round(percentile(values, 0.95), 3),
        "meanMs": round(statistics.fmean(values), 3),
    }


def scaled_size(width: int, height: int, max_width: int, max_height: int) -> tuple[int, int]:
    if width <= max_width and height <= max_height:
        return width, height
    scale = min(max_width / width, max_height / height)
    return (
        max(2, int(width * scale) // 2 * 2),
        max(2, int(height * scale) // 2 * 2),
    )


def resize_and_convert(
    img: np.ndarray, size: tuple[int, int], interpolation: int
) -> tuple[float, float, float, np.ndarray]:
    resize_started = time.perf_counter()
    resized = cv2.resize(img, size, interpolation=interpolation)
    resize_ms = (time.perf_counter() - resize_started) * 1000
    convert_started = time.perf_counter()
    frame = av.VideoFrame.from_ndarray(resized, format="bgra")
    # Touch the frame's public dimensions so the conversion cannot be optimized
    # away by a future wrapper.
    if frame.width != size[0] or frame.height != size[1]:
        raise RuntimeError("VideoFrame dimensions do not match the requested resize")
    convert_ms = (time.perf_counter() - convert_started) * 1000
    yuv_started = time.perf_counter()
    yuv = frame.reformat(format="yuv420p")
    if yuv.width != size[0] or yuv.height != size[1]:
        raise RuntimeError("YUV conversion dimensions do not match the requested resize")
    bgra_to_yuv_ms = (time.perf_counter() - yuv_started) * 1000
    return resize_ms, convert_ms, bgra_to_yuv_ms, resized


def run_capture_candidate(
    sct: MSS,
    monitor: dict,
    *,
    target_fps: int,
    multiplier: float,
    duration_seconds: float,
    size: tuple[int, int],
) -> dict:
    """Run one cadence variable with the legacy linear resize held constant."""
    capture_fps = math.ceil(target_fps * multiplier)
    interval = 1.0 / capture_fps
    target_frames = math.ceil(target_fps * duration_seconds)
    capture_ms: list[float] = []
    resize_ms: list[float] = []
    convert_ms: list[float] = []
    bgra_to_yuv_ms: list[float] = []
    started = time.perf_counter()
    deadline = started
    while time.perf_counter() - started < duration_seconds:
        capture_started = time.perf_counter()
        shot = sct.grab(monitor)
        capture_ms.append((time.perf_counter() - capture_started) * 1000)
        image = np.frombuffer(shot.raw, dtype=np.uint8).reshape(shot.height, shot.width, 4)
        resize_elapsed, convert_elapsed, bgra_to_yuv_elapsed, _ = resize_and_convert(
            image, size, cv2.INTER_LINEAR
        )
        resize_ms.append(resize_elapsed)
        convert_ms.append(convert_elapsed)
        bgra_to_yuv_ms.append(bgra_to_yuv_elapsed)
        deadline += interval
        remaining = deadline - time.perf_counter()
        if remaining > 0:
            time.sleep(remaining)

    elapsed_seconds = time.perf_counter() - started
    frame_count = len(capture_ms)
    # This confirms that capture can produce at least the requested media rate.
    # It is deliberately not a browser paint-FPS assertion.
    target_available = frame_count >= target_frames
    return {
        "multiplier": multiplier,
        "captureFps": capture_fps,
        "elapsedSeconds": round(elapsed_seconds, 3),
        "frames": frame_count,
        "targetFrames": target_frames,
        "targetFrameAvailability": round(min(1.0, frame_count / target_frames), 3),
        "targetFrameAvailable": target_available,
        "capture": timing_summary(capture_ms),
        "resize": timing_summary(resize_ms),
        "frameConversion": timing_summary(convert_ms),
        "bgraToYuv420": timing_summary(bgra_to_yuv_ms),
        "costPerTargetFrameMs": round(
            (
                statistics.fmean(capture_ms)
                + statistics.fmean(resize_ms)
                + statistics.fmean(convert_ms)
                + statistics.fmean(bgra_to_yuv_ms)
            )
            * capture_fps / target_fps,
            3,
        ),
    }


def quality_proxy(source: np.ndarray, resized: np.ndarray) -> dict[str, float]:
    """Use round-trip edge retention and PSNR only as local resize proxies."""
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
    resize_ms: list[float] = []
    convert_ms: list[float] = []
    bgra_to_yuv_ms: list[float] = []
    final_resized = None
    for _ in range(40):
        resize_elapsed, convert_elapsed, bgra_to_yuv_elapsed, final_resized = resize_and_convert(
            source, size, INTERPOLATIONS[name]
        )
        resize_ms.append(resize_elapsed)
        convert_ms.append(convert_elapsed)
        bgra_to_yuv_ms.append(bgra_to_yuv_elapsed)
    assert final_resized is not None
    return {
        "interpolation": name,
        "resize": timing_summary(resize_ms),
        "frameConversion": timing_summary(convert_ms),
        "bgraToYuv420": timing_summary(bgra_to_yuv_ms),
        "qualityProxy": quality_proxy(source, final_resized),
    }


def select_multiplier(candidates: list[dict], legacy_baseline: dict) -> dict:
    """Choose the least capture cadence that demonstrably meets capture demand."""
    eligible = [
        candidate
        for candidate in candidates
        if candidate["targetFrameAvailable"]
        and candidate["costPerTargetFrameMs"] < legacy_baseline["costPerTargetFrameMs"]
    ]
    if not eligible:
        return {
            "applied": False,
            "value": None,
            "reason": "no candidate both supplied target FPS and reduced measured capture-stage cost",
        }
    chosen = min(eligible, key=lambda candidate: candidate["multiplier"])
    return {
        "applied": True,
        "value": chosen["multiplier"],
        "reason": "lowest multiplier with target-frame availability and lower cost than legacy 2x",
    }


def select_interpolation(candidates: list[dict], *, resize_budget_ms: float) -> dict:
    linear = next(candidate for candidate in candidates if candidate["interpolation"] == "INTER_LINEAR")
    area = next(candidate for candidate in candidates if candidate["interpolation"] == "INTER_AREA")
    quality_improved = (
        area["qualityProxy"]["roundTripPsnrDb"] > linear["qualityProxy"]["roundTripPsnrDb"]
        and area["qualityProxy"]["edgeRetentionRatio"] >= linear["qualityProxy"]["edgeRetentionRatio"]
    )
    within_budget = area["resize"]["p95Ms"] <= resize_budget_ms
    if quality_improved and within_budget:
        return {"applied": True, "value": "INTER_AREA", "reason": "quality proxy improved within resize budget"}
    return {
        "applied": False,
        "value": "INTER_LINEAR",
        "reason": "INTER_AREA did not both improve the proxy and satisfy the resize budget",
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
        legacy_baseline = run_capture_candidate(
            sct,
            monitor,
            target_fps=args.target_fps,
            multiplier=LEGACY_MULTIPLIER,
            duration_seconds=args.duration,
            size=output_size,
        )
        capture_candidates = [
            run_capture_candidate(
                sct,
                monitor,
                target_fps=args.target_fps,
                multiplier=multiplier,
                duration_seconds=args.duration,
                size=output_size,
            )
            for multiplier in MULTIPLIERS
        ]
        interpolation_candidates = [
            run_interpolation_candidate(source, output_size, name)
            for name in INTERPOLATIONS
        ]

    result = {
        "schemaVersion": 1,
        "scope": "local desktop capture probe; no Host, browser, relay, tunnel, or encoder was started",
        "environment": {
            "python": sys.version,
            "platform": platform.platform(),
            "opencv": cv2.__version__,
            "pyav": av.__version__,
        },
        "input": {
            "monitor": {key: monitor[key] for key in ("left", "top", "width", "height")},
            "targetFps": args.target_fps,
            "durationSecondsPerMultiplier": args.duration,
            "outputSize": {"width": output_size[0], "height": output_size[1]},
            "resizeBudgetMs": args.resize_budget_ms,
        },
        "captureMultiplierCandidates": capture_candidates,
        "legacyCaptureBaseline": legacy_baseline,
        "resizeInterpolationCandidates": interpolation_candidates,
        "selection": {
            "captureMultiplier": select_multiplier(capture_candidates, legacy_baseline),
            "resizeInterpolation": select_interpolation(
                interpolation_candidates, resize_budget_ms=args.resize_budget_ms
            ),
        },
        "limitations": {
            "paintFps": "NOT RUN: capture-stage availability is not browser paint evidence",
            "periodicIdrQuality": "NOT EVALUATED: this probe does not encode or change codec, GOP, bitrate, VBV, or policy",
            "bgraToYuv": "Measured as PyAV BGRA VideoFrame reformat to yuv420p; no copy-elimination change is applied",
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps(result["selection"], indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
