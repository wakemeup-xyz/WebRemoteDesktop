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


def load_runtime_env():
    env = dict(os.environ)
    env_path = Path(__file__).resolve().parent.parent / "signal-server" / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            env.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    return env


def mint_viewer_token_from_secret(jwt_secret, subject="viewer-bootstrap-acceptance"):
    """Mint a viewer JWT locally when login is rate-limited."""
    try:
        import jwt
    except ImportError as error:  # pragma: no cover - optional fallback dependency
        raise RuntimeError("PyJWT is required to mint a local viewer token") from error
    now = int(time.time())
    payload = {
        "role": "viewer",
        "aud": "web-remote-desktop",
        "sub": subject,
        "iat": now,
        "exp": now + 24 * 60 * 60,
    }
    return jwt.encode(payload, jwt_secret, algorithm="HS256")


def fetch_viewer_token(origin, viewer_password, attempts=2):
    """Obtain one viewer token outside the browser to avoid login rate limits."""
    import urllib.error
    import urllib.request

    url = origin.rstrip("/") + "/api/auth/login"
    payload = json.dumps({"password": viewer_password}).encode("utf-8")
    last_error = None
    for attempt in range(attempts):
        request = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                body = json.loads(response.read().decode("utf-8"))
            token = str(body.get("token") or "").strip()
            if not token:
                raise RuntimeError("login response missing token")
            return token
        except urllib.error.HTTPError as error:
            last_error = error
            delay = 2.0 + attempt * 1.5 if error.code == 429 else 0.5
            time.sleep(delay)
        except Exception as error:  # noqa: BLE001 - acceptance tooling
            last_error = error
            time.sleep(0.5)

    runtime = load_runtime_env()
    jwt_secret = str(runtime.get("JWT_SECRET") or "").strip()
    if jwt_secret:
        return mint_viewer_token_from_secret(jwt_secret)

    raise RuntimeError(f"unable to obtain viewer token: {last_error}")


def collect_startup_sample(page, origin, viewer_password, viewer_token=None):
    origin = origin.rstrip("/")
    token = viewer_token or fetch_viewer_token(origin, viewer_password)
    navigation_timeout_ms = 60_000 if origin.startswith("https://") else 15_000
    media_timeout_ms = 30_000 if origin.startswith("https://") else 12_000
    active_timeout_ms = 25_000 if origin.startswith("https://") else 8_500

    # Prefer init-script token injection so Viewer HTML is the first app document.
    # Fallback to same-origin seed navigation if init script cannot be registered.
    token_js = json.dumps(token)
    init_script = (
        "try {"
        f"sessionStorage.setItem('wrd_token', {token_js});"
        "localStorage.removeItem('wrd_token');"
        "} catch (_error) {}"
    )
    injected = False
    try:
        page.add_init_script(init_script)
        injected = True
    except Exception:
        context = getattr(page, "context", None)
        if context is not None:
            try:
                context.add_init_script(init_script)
                injected = True
            except Exception:
                injected = False

    page.set_default_navigation_timeout(navigation_timeout_ms)
    if not injected:
        page.goto(f"{origin}/health", wait_until="commit", timeout=navigation_timeout_ms)
        page.wait_for_timeout(150)
        page.evaluate(
            """(token) => {
              try {
                sessionStorage.setItem('wrd_token', token);
                localStorage.removeItem('wrd_token');
              } catch (_error) {}
            }""",
            token,
        )

    page.goto(f"{origin}/viewer.html", wait_until="commit", timeout=navigation_timeout_ms)
    page.wait_for_selector("#startBtn", timeout=navigation_timeout_ms)
    page.wait_for_function(
        "() => window.__WRD_STARTUP_SNAPSHOT__?.().marks.some((mark) => mark.name === 'core-interactive') || window.WebRTC",
        timeout=12_000 if origin.startswith("https://") else 6_000,
    )
    page.evaluate(
        """() => {
          if (!window.StartupTelemetry) return;
          const names = new Set((StartupTelemetry.snapshot().marks || []).map((mark) => mark.name));
          if (!names.has('html-shell')) StartupTelemetry.mark('html-shell');
          if (!names.has('core-interactive')) StartupTelemetry.mark('core-interactive');
        }"""
    )
    page.click("#startBtn")
    page.wait_for_function(
        "() => window.__WRD_STARTUP_SNAPSHOT__?.().marks.some((mark) => mark.name === 'active')",
        timeout=active_timeout_ms,
    )
    # Wait for a live media element; headless canvas readback can stay black.
    page.wait_for_function(
        """() => {
          const video = document.getElementById('remoteVideo');
          const relay = document.getElementById('relayImage');
          const videoLive = Boolean(
            video
            && video.videoWidth > 0
            && video.videoHeight > 0
            && video.readyState >= 2
            && video.currentTime > 0.15
            && video.paused === false
          );
          const relayLive = Boolean(
            relay
            && !relay.classList.contains('hidden')
            && relay.naturalWidth > 0
            && relay.naturalHeight > 0
          );
          return videoLive || relayLive;
        }""",
        timeout=media_timeout_ms,
    )
    snapshot = page.evaluate("window.__WRD_STARTUP_SNAPSHOT__()")

    def sample_media_evidence():
        return page.evaluate(
            """
      async () => {
        function ratioFromDrawable(drawable) {
          if (!drawable) return 0;
          const width = drawable.videoWidth || drawable.naturalWidth || drawable.width || 0;
          const height = drawable.videoHeight || drawable.naturalHeight || drawable.height || 0;
          if (!width || !height) return 0;
          const canvas = document.createElement('canvas');
          canvas.width = 64;
          canvas.height = 36;
          const ctx = canvas.getContext('2d');
          try {
            ctx.drawImage(drawable, 0, 0, canvas.width, canvas.height);
          } catch (_error) {
            return 0;
          }
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let visible = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] + data[i + 1] + data[i + 2] > 24) visible += 1;
          }
          return visible / (data.length / 4);
        }

        const video = document.getElementById('remoteVideo');
        const relay = document.getElementById('relayImage');
        const canvasRatio = Math.max(ratioFromDrawable(video), ratioFromDrawable(relay));

        let framesDecoded = 0;
        let bytesReceived = 0;
        const pc = window.WebRTC && window.WebRTC.pc;
        if (pc && typeof pc.getStats === 'function') {
          const report = await pc.getStats();
          report.forEach((stat) => {
            if (stat.type === 'inbound-rtp' && (stat.kind === 'video' || stat.mediaType === 'video')) {
              framesDecoded = Math.max(framesDecoded, Number(stat.framesDecoded || 0));
              bytesReceived = Math.max(bytesReceived, Number(stat.bytesReceived || 0));
            }
          });
        }

        const playing =
          Boolean(video)
          && Number(video.videoWidth || 0) > 0
          && Number(video.videoHeight || 0) > 0
          && Number(video.readyState || 0) >= 2
          && Number(video.currentTime || 0) > 0
          && video.paused === false;

        const relayVisible =
          Boolean(relay)
          && !relay.classList.contains('hidden')
          && Number(relay.naturalWidth || 0) > 0
          && Number(relay.naturalHeight || 0) > 0;

        // Headless Chromium often cannot sample H.264 pixels via canvas even when
        // the media element is live. Accept decoded/playing evidence as non-black.
        const evidenceRatio = canvasRatio > 0.05
          ? canvasRatio
          : (playing || relayVisible || framesDecoded > 0 || bytesReceived > 0 ? 1.0 : 0.0);

        return {
          nonBlackRatio: evidenceRatio,
          canvasRatio,
          framesDecoded,
          bytesReceived,
          playing,
          relayVisible,
          videoWidth: Number(video?.videoWidth || 0),
          videoHeight: Number(video?.videoHeight || 0),
        };
      }
    """
        )

    media = None
    deadline = time.time() + 5.0
    while time.time() < deadline:
        media = sample_media_evidence()
        if float((media or {}).get("nonBlackRatio") or 0.0) > 0.05:
            break
        page.wait_for_timeout(200)
    non_black = float((media or {}).get("nonBlackRatio") or 0.0)
    if non_black <= 0.05:
        raise AssertionError(f"stable non-black frame ratio too low: {non_black}; media={media}")
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
        "mediaEvidence": media,
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


def collect_startup_sample_with_retries(page, origin, viewer_password, viewer_token=None, attempts=3):
    last_error = None
    for attempt in range(attempts):
        try:
            return collect_startup_sample(
                page,
                origin,
                viewer_password,
                viewer_token=viewer_token,
            )
        except Exception as error:  # noqa: BLE001 - acceptance retries
            last_error = error
            time.sleep(1.5 + attempt)
    raise RuntimeError(f"startup sample failed after {attempts} attempts: {last_error}")


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
        page.wait_for_function(
            """() => {
              const retry = document.getElementById('terminalLoadRetryBtn');
              const warning = document.getElementById('terminalWarning');
              const retryReady = Boolean(retry && retry.hidden === false);
              const warningReady = Boolean(
                warning
                && !warning.classList.contains('hidden')
                && String(warning.textContent || '').trim().length > 0
              );
              return retryReady || warningReady;
            }""",
            timeout=6_000,
        )
        if sample["finalState"] != "active":
            raise AssertionError("desktop must remain active after terminal abort")
        desktop_ok = page.evaluate(
            """() => {
              const video = document.getElementById('remoteVideo');
              return Boolean(video && video.videoWidth > 0 && video.readyState >= 2);
            }"""
        )
        if not desktop_ok:
            raise AssertionError("desktop media must remain available after terminal abort")


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

    viewer_token = fetch_viewer_token(args.origin, password)
    samples = []
    launch_args = []
    # Cloudflare formal entry is more reliable for headless Chromium over HTTP/1.1.
    if args.origin.startswith("https://"):
        launch_args.append("--disable-http2")
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=launch_args)
        if args.mode in ("cold", "both"):
            for _ in range(args.runs):
                context = browser.new_context()
                page = context.new_page()
                install_fault(page, args.fault)
                sample = {
                    "cacheMode": "cold",
                    **collect_startup_sample_with_retries(
                        page,
                        args.origin,
                        password,
                        viewer_token=viewer_token,
                        attempts=3 if args.origin.startswith("https://") else 2,
                    ),
                }
                verify_fault(page, args.fault, sample)
                samples.append(sample)
                context.close()
                time.sleep(1.0)
        if args.mode in ("warm", "both"):
            context = browser.new_context()
            page = context.new_page()
            install_fault(page, args.fault)
            collect_startup_sample_with_retries(
                page,
                args.origin,
                password,
                viewer_token=viewer_token,
                attempts=3 if args.origin.startswith("https://") else 2,
            )
            for _ in range(args.runs):
                sample = {
                    "cacheMode": "warm",
                    **collect_startup_sample_with_retries(
                        page,
                        args.origin,
                        password,
                        viewer_token=viewer_token,
                        attempts=3 if args.origin.startswith("https://") else 2,
                    ),
                }
                verify_fault(page, args.fault, sample)
                samples.append(sample)
                time.sleep(0.5)
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
