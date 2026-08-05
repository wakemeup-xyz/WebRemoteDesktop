#!/usr/bin/env python3
"""Viewer bootstrap acceptance CLI for local/public cold/warm/fault evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import time
from datetime import datetime, timezone
from pathlib import Path

SENSITIVE_KEYS = {"token", "password", "credential", "authorization", "cookie"}


def nearest_rank(values, percentile):
    ordered = sorted(float(value) for value in values)
    if not ordered:
        return None
    index = max(0, math.ceil(percentile * len(ordered)) - 1)
    return ordered[index]


def redact_value(value):
    if isinstance(value, dict):
        return {
            key: redact_value(item)
            for key, item in value.items()
            if key.lower() not in SENSITIVE_KEYS
        }
    if isinstance(value, list):
        return [redact_value(item) for item in value]
    return value


def build_report(origin, samples):
    clean_samples = redact_value(samples)
    metric_names = ("coreInteractiveMs", "clickToSignalMs", "clickToActiveMs")
    summaries = {}
    for metric in metric_names:
        values = [sample[metric] for sample in clean_samples if sample.get(metric) is not None]
        summaries[f"{metric.removesuffix('Ms')}P50Ms"] = nearest_rank(values, 0.50)
        summaries[f"{metric.removesuffix('Ms')}P95Ms"] = nearest_rank(values, 0.95)
    return {
        "schemaVersion": 1,
        "origin": origin,
        "sampleCount": len(clean_samples),
        "summary": summaries,
        "samples": clean_samples,
    }


def write_immutable_report(report, output_dir):
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    path = output_dir / f"viewer-bootstrap-{stamp}.json"
    payload = (json.dumps(report, ensure_ascii=True, indent=2, sort_keys=True) + "\n").encode()
    path.write_bytes(payload)
    digest = hashlib.sha256(payload).hexdigest()
    (output_dir / "latest.json").write_bytes(payload)
    (output_dir / "latest.sha256").write_text(f"{digest}  {path.name}\n", encoding="ascii")
    return path, digest


def collect_startup_sample(page, origin, viewer_password):
    page.goto(origin, wait_until="domcontentloaded", timeout=15_000)
    if page.locator("#loginForm").count():
        page.fill("#password", viewer_password)
        page.click("button[type=submit]")
        page.wait_for_url("**/viewer.html", timeout=10_000)
    page.click("#startBtn")
    page.wait_for_function(
        "() => window.__WRD_STARTUP_SNAPSHOT__?.().marks.some(m => m.name === 'active')",
        timeout=8_500,
    )
    snapshot = page.evaluate("window.__WRD_STARTUP_SNAPSHOT__()")
    non_black = page.evaluate(
        """
      () => {
        const video = document.getElementById('remoteVideo');
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 36;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let visible = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] + data[i + 1] + data[i + 2] > 24) visible += 1;
        }
        return visible / (data.length / 4);
      }
    """
    )
    if non_black <= 0.05:
        raise AssertionError(f"stable non-black frame ratio too low: {non_black}")
    marks = {mark["name"]: mark["atMs"] for mark in snapshot["marks"]}

    def elapsed(start, end):
        if start not in marks or end not in marks:
            return None
        return round(marks[end] - marks[start], 2)

    sample = {
        "coreInteractiveMs": elapsed("html-shell", "core-interactive"),
        "clickToSignalMs": elapsed("start-click", "signal-connected"),
        "clickToActiveMs": elapsed("start-click", "active"),
        "nonBlackRatio": non_black,
        "finalState": "active",
        "startup": snapshot,
    }
    if sample["coreInteractiveMs"] is None:
        raise AssertionError("missing coreInteractiveMs marks")
    if sample["clickToSignalMs"] is None:
        raise AssertionError("missing clickToSignalMs marks")
    if sample["clickToActiveMs"] is None:
        raise AssertionError("missing clickToActiveMs marks")
    return sample


def install_fault(page, fault):
    if fault == "cdn-block":
        page.route(
            "**/*",
            lambda route: route.abort()
            if "cdn.jsdelivr.net" in route.request.url or "cdn.socket.io" in route.request.url
            else route.continue_(),
        )
    elif fault == "bootstrap-delay":
        def delay_bootstrap(route):
            time.sleep(10)
            route.continue_()

        page.route("**/api/viewer-bootstrap*", delay_bootstrap)
    elif fault == "terminal-abort":
        page.route("**/assets/terminal.*", lambda route: route.abort())


def verify_fault(page, fault, sample):
    if fault == "bootstrap-delay":
        marks = {mark["name"]: mark["atMs"] for mark in sample["startup"]["marks"]}
        degraded = marks.get("bootstrap-degraded")
        started = marks.get("bootstrap-start")
        if degraded is None or started is None:
            raise AssertionError("bootstrap-delay fault missing timing marks")
        if degraded - started > 5000:
            raise AssertionError("bootstrap wait exceeded 5s budget")
    elif fault == "terminal-abort":
        page.click("#terminalTabBtn")
        page.wait_for_selector("#terminalLoadRetryBtn:not([hidden])", timeout=5500)
        if sample["finalState"] != "active":
            raise AssertionError("desktop must remain active after terminal abort")


def parse_args(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--origin", required=True)
    parser.add_argument("--runs", type=int, default=20)
    parser.add_argument("--mode", choices=("cold", "warm", "both"), default="both")
    parser.add_argument(
        "--fault",
        choices=("bootstrap-delay", "terminal-abort", "cdn-block", "none"),
        default="none",
    )
    parser.add_argument("--output-dir", default="artifacts/viewer-bootstrap")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    password = os.environ.get("VIEWER_ACCESS_PASSWORD", "")
    if not password:
        raise SystemExit("VIEWER_ACCESS_PASSWORD is required")

    from playwright.sync_api import sync_playwright

    samples = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        if args.mode in ("cold", "both"):
            for _ in range(args.runs):
                context = browser.new_context()
                page = context.new_page()
                install_fault(page, args.fault)
                sample = {"cacheMode": "cold", **collect_startup_sample(page, args.origin, password)}
                verify_fault(page, args.fault, sample)
                samples.append(sample)
                context.close()
        if args.mode in ("warm", "both"):
            context = browser.new_context()
            page = context.new_page()
            install_fault(page, args.fault)
            collect_startup_sample(page, args.origin, password)
            for _ in range(args.runs):
                sample = {"cacheMode": "warm", **collect_startup_sample(page, args.origin, password)}
                verify_fault(page, args.fault, sample)
                samples.append(sample)
            context.close()
        browser.close()

    report = build_report(args.origin, samples)
    path, digest = write_immutable_report(report, args.output_dir)
    print(
        json.dumps(
            {"report": str(path), "sha256": digest, "summary": report["summary"]},
            ensure_ascii=True,
        )
    )


if __name__ == "__main__":
    main()
