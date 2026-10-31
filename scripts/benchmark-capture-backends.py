#!/usr/bin/env python3
"""Compare MSS and CoreGraphics screen capture under bounded local load.

This probe never starts Host, Signal, a browser, input injection, or a tunnel.
It measures the native capture call and the returned BGRA view only; resize,
PyAV conversion, encoding, RTP and browser paint remain outside this probe.
"""

from __future__ import annotations

import argparse
import json
import math
import platform
import statistics
import threading
import time
from pathlib import Path

import numpy as np
from mss import MSS


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = (len(ordered) - 1) * fraction
    lower, upper = math.floor(index), math.ceil(index)
    if lower == upper:
        return round(float(ordered[lower]), 3)
    return round(float(ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower)), 3)


def summary(values: list[float]) -> dict:
    return {
        "count": len(values),
        "p50Ms": percentile(values, 0.50),
        "p95Ms": percentile(values, 0.95),
        "p99Ms": percentile(values, 0.99),
        "maxMs": round(max(values), 3) if values else None,
        "meanMs": round(statistics.fmean(values), 3) if values else None,
    }


def start_load(workers: int):
    stop = threading.Event()
    threads = []

    def burn():
        value = 0x12345678
        while not stop.is_set():
            value = ((value * 1103515245) + 12345) & 0x7FFFFFFF
            if value == -1:  # keep the loop observable without retaining data
                break

    for _ in range(max(0, workers)):
        thread = threading.Thread(target=burn, daemon=True, name="capture-ab-load")
        thread.start()
        threads.append(thread)
    return stop, threads


class MssBackend:
    name = "mss"

    def __enter__(self):
        self.sct = MSS()
        monitors = self.sct.monitors
        self.monitor = next((item for item in monitors[1:] if item.get("width", 0) and item.get("height", 0)), monitors[0])
        return self

    def capture(self):
        shot = self.sct.grab(self.monitor)
        image = np.frombuffer(shot.raw, dtype=np.uint8).reshape(shot.height, shot.width, 4)
        return {"width": int(shot.width), "height": int(shot.height), "bytes": int(image.nbytes)}

    def __exit__(self, *_args):
        self.sct.close()


class CoreGraphicsBackend:
    name = "coregraphics"

    def __enter__(self):
        import Quartz

        self.Quartz = Quartz
        self.display = Quartz.CGMainDisplayID()
        self.bounds = Quartz.CGDisplayBounds(self.display)
        return self

    def capture(self):
        q = self.Quartz
        image = q.CGWindowListCreateImage(
            self.bounds,
            q.kCGWindowListOptionOnScreenOnly,
            q.kCGNullWindowID,
            q.kCGWindowImageNominalResolution,
        )
        if image is None:
            raise RuntimeError("CGWindowListCreateImage returned null")
        width = int(q.CGImageGetWidth(image))
        height = int(q.CGImageGetHeight(image))
        row_bytes = int(q.CGImageGetBytesPerRow(image))
        provider = q.CGImageGetDataProvider(image)
        data = q.CGDataProviderCopyData(provider)
        expected = row_bytes * height
        if len(data) < expected or row_bytes < width * 4:
            raise RuntimeError("CoreGraphics returned an invalid BGRA buffer")
        # Keep the view local; no image bytes are written to disk.
        np.frombuffer(data, dtype=np.uint8).reshape(height, row_bytes // 4, 4)[:, :width]
        return {"width": width, "height": height, "bytes": expected}

    def __exit__(self, *_args):
        self.Quartz = None


BACKENDS = {"mss": MssBackend, "coregraphics": CoreGraphicsBackend}


def run_backend(backend_name: str, samples: int, load_workers: int, warmup: int) -> dict:
    result = {"backend": backend_name, "loadWorkers": load_workers, "samples": samples,
              "status": "ok", "errors": [], "shape": None}
    wall, cpu, non_cpu = [], [], []
    stop, threads = start_load(load_workers)
    try:
        with BACKENDS[backend_name]() as backend:
            for _ in range(max(0, warmup)):
                backend.capture()
            for _ in range(samples):
                started = time.perf_counter_ns()
                cpu_started = time.thread_time_ns()
                try:
                    shape = backend.capture()
                    result["shape"] = shape
                    elapsed = (time.perf_counter_ns() - started) / 1_000_000
                    cpu_elapsed = (time.thread_time_ns() - cpu_started) / 1_000_000
                    wall.append(elapsed)
                    cpu.append(cpu_elapsed)
                    non_cpu.append(max(0.0, elapsed - cpu_elapsed))
                except Exception as exc:  # bounded error evidence only
                    result["errors"].append(type(exc).__name__)
    except Exception as exc:
        result["status"] = "unavailable"
        result["errors"].append(type(exc).__name__)
    finally:
        stop.set()
        for thread in threads:
            thread.join(timeout=1.0)
    result["completed"] = len(wall)
    result["wallMs"] = summary(wall)
    result["threadCpuMs"] = summary(cpu)
    result["nonCpuMs"] = summary(non_cpu)
    result["errors"] = sorted(set(result["errors"]))
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--samples", type=int, default=40)
    parser.add_argument("--warmup", type=int, default=3)
    parser.add_argument("--load-workers", default="0,1", help="comma-separated bounded CPU load worker counts")
    parser.add_argument("--backends", default="mss,coregraphics")
    args = parser.parse_args()
    if args.samples <= 0 or args.warmup < 0:
        raise SystemExit("--samples must be positive and --warmup must be non-negative")
    loads = [int(value) for value in str(args.load_workers).split(",") if value.strip()]
    backends = [value.strip() for value in str(args.backends).split(",") if value.strip()]
    unknown = sorted(set(backends) - set(BACKENDS))
    if unknown:
        raise SystemExit(f"unknown backend: {','.join(unknown)}")
    rows = [run_backend(name, args.samples, load, args.warmup)
            for load in loads for name in backends]
    output = {
        "schemaVersion": 1,
        "scope": "local native capture call only; no Host/browser/relay/tunnel/input",
        "environment": {"python": platform.python_version(), "platform": platform.platform()},
        "config": {"samples": args.samples, "warmup": args.warmup, "loadWorkers": loads, "backends": backends},
        "results": rows,
        "interpretation": {
            "nonCpuMs": "wall capture time minus this thread's CPU time; includes native IPC, WindowServer, scheduling and memory waits",
            "productionGate": "PENDING: compare with selected-relay frame cadence and visible output before changing the default backend",
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2, sort_keys=True) + "\n")
    print(json.dumps(output["results"], indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

