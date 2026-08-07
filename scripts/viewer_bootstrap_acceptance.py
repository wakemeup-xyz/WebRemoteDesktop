#!/usr/bin/env python3
"""Viewer bootstrap acceptance CLI — honest, single-attempt, navigation-timed evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
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


def git_commit_sha():
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=Path(__file__).resolve().parent.parent,
            text=True,
        ).strip()
    except Exception:  # noqa: BLE001
        return None


def load_manifest_hash():
    manifest_path = Path(__file__).resolve().parent.parent / "web-client" / "dist" / "asset-manifest.json"
    if not manifest_path.exists():
        return None
    raw = manifest_path.read_bytes()
    return {
        "sha256": hashlib.sha256(raw).hexdigest(),
        "manifest": json.loads(raw.decode("utf-8")),
    }


def build_report(origin, samples, *, mode="both", runs=20, fault="none"):
    clean_samples = redact_value(samples)
    successes = [s for s in clean_samples if s.get("finalState") == "active" and not s.get("failed")]
    failures = [s for s in clean_samples if s.get("failed")]
    metric_names = (
        "htmlResponseMs",
        "navToCoreInteractiveMs",
        "clickToSignalMs",
        "clickToStableNonBlackMs",
        "coreInteractiveMarkMs",
    )
    summaries = {}
    for metric in metric_names:
        values = [sample[metric] for sample in successes if sample.get(metric) is not None]
        summaries[f"{metric.removesuffix('Ms')}P50Ms"] = nearest_rank(values, 0.50)
        summaries[f"{metric.removesuffix('Ms')}P95Ms"] = nearest_rank(values, 0.95)

    attempt_count = len(clean_samples)
    success_count = len(successes)
    failure_count = len(failures)
    failure_stages = {}
    for sample in failures:
        stage = str(sample.get("failureStage") or "unknown")
        failure_stages[stage] = failure_stages.get(stage, 0) + 1

    return {
        "schemaVersion": 2,
        "origin": origin,
        "mode": mode,
        "fault": fault,
        "requestedRuns": runs,
        "attemptCount": attempt_count,
        "successCount": success_count,
        "failureCount": failure_count,
        "failureRate": (failure_count / attempt_count) if attempt_count else None,
        "failureStages": failure_stages,
        "commitSha": git_commit_sha(),
        "assetManifest": load_manifest_hash(),
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
    try:
        import jwt
    except ImportError as error:  # pragma: no cover
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
            time.sleep(2.0 + attempt * 1.5 if error.code == 429 else 0.5)
        except Exception as error:  # noqa: BLE001
            last_error = error
            time.sleep(0.5)

    runtime = load_runtime_env()
    jwt_secret = str(runtime.get("JWT_SECRET") or "").strip()
    if jwt_secret:
        return mint_viewer_token_from_secret(jwt_secret)
    raise RuntimeError(f"unable to obtain viewer token: {last_error}")


def _navigation_metrics(page):
    return page.evaluate(
        """() => {
          const nav = performance.getEntriesByType('navigation')[0];
          const marks = (window.__WRD_STARTUP_SNAPSHOT__?.().marks || []);
          const byName = Object.fromEntries(marks.map((m) => [m.name, m.atMs]));
          const htmlResponseMs = nav
            ? Math.round((nav.responseStart || 0) * 100) / 100
            : null;
          const navToCore = (byName['core-interactive'] != null && nav)
            ? Math.round((byName['core-interactive']) * 100) / 100
            : (byName['core-interactive'] ?? null);
          return {
            htmlResponseMs,
            domContentLoadedMs: nav ? Math.round((nav.domContentLoadedEventEnd || 0) * 100) / 100 : null,
            loadEventMs: nav ? Math.round((nav.loadEventEnd || 0) * 100) / 100 : null,
            markCoreInteractiveMs: byName['core-interactive'] ?? null,
            markHtmlShellMs: byName['html-shell'] ?? null,
            markStartClickMs: byName['start-click'] ?? null,
            markSignalMs: byName['signal-connected'] ?? null,
            markActiveMs: byName['active'] ?? null,
            resources: (performance.getEntriesByType('resource') || []).slice(0, 30).map((r) => ({
              name: String(r.name || '').split('?')[0],
              durationMs: Math.round(Number(r.duration || 0) * 100) / 100,
              transferSize: Number(r.transferSize || 0),
              initiatorType: r.initiatorType || null,
            })),
          };
        }"""
    )


def _canvas_non_black_ratio(page):
    return page.evaluate(
        """() => {
          function ratioFromDrawable(drawable) {
            if (!drawable) return 0;
            const width = drawable.videoWidth || drawable.naturalWidth || drawable.width || 0;
            const height = drawable.videoHeight || drawable.naturalHeight || drawable.height || 0;
            if (!width || !height) return 0;
            const canvas = document.createElement('canvas');
            canvas.width = 64;
            canvas.height = 36;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
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
          return Math.max(ratioFromDrawable(video), ratioFromDrawable(relay));
        }"""
    )


def _media_aux_evidence(page):
    return page.evaluate(
        """async () => {
          const video = document.getElementById('remoteVideo');
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
          return {
            framesDecoded,
            bytesReceived,
            playing: Boolean(
              video
              && video.videoWidth > 0
              && video.readyState >= 2
              && video.currentTime > 0
              && video.paused === false
            ),
            videoWidth: Number(video?.videoWidth || 0),
            videoHeight: Number(video?.videoHeight || 0),
          };
        }"""
    )


def collect_startup_sample(page, origin, viewer_password, viewer_token=None, *, immediate_start=False):
    """Single planned attempt. Raises on failure; caller must record the failure sample."""
    origin = origin.rstrip("/")
    token = viewer_token or fetch_viewer_token(origin, viewer_password)
    token_js = json.dumps(token)
    page.add_init_script(
        "try {"
        f"sessionStorage.setItem('wrd_token', {token_js});"
        "localStorage.removeItem('wrd_token');"
        "} catch (_error) {}"
    )

    # navigationStart → HTML / core use Performance timeline (ms since navigationStart).
    page.goto(f"{origin}/viewer.html", wait_until="commit", timeout=15_000)
    page.wait_for_selector("#startBtn", timeout=10_000)

    if immediate_start:
        # Click as soon as the Start control exists (<100ms feedback contract).
        t0 = time.time()
        page.click("#startBtn", no_wait_after=False)
        click_wall = time.time()
        feedback_ms = round((click_wall - t0) * 1000, 2)
        text = page.evaluate("() => document.getElementById('loadingText')?.textContent || ''")
        if feedback_ms > 100 and "正在" not in text and "连接" not in text:
            # Feedback must be visible quickly; shell queues or starts connection.
            raise AssertionError(f"immediate start feedback too slow: {feedback_ms}ms text={text!r}")
    else:
        page.wait_for_function(
            "() => window.__WRD_SHELL__?.snapshot?.().marks?.some((m) => m.name === 'core-interactive') "
            "|| window.WebRTC",
            timeout=5_000,
        )
        page.click("#startBtn")
        click_wall = time.time()

    page.wait_for_function(
        "() => window.__WRD_STARTUP_SNAPSHOT__?.().marks.some((m) => m.name === 'signal-connected')",
        timeout=5_000,
    )

    # Stable non-black: first canvas ratio > 0.05, deadline from Start click (not active+extra).
    non_black = 0.0
    stable_non_black_at_ms = None
    non_black_deadline = click_wall + 8.0
    while time.time() < non_black_deadline:
        non_black = float(_canvas_non_black_ratio(page) or 0.0)
        if non_black > 0.05:
            stable_non_black_at_ms = page.evaluate(
                """() => {
                  const atMs = (typeof performance !== 'undefined' && performance.now)
                    ? Math.round(performance.now() * 100) / 100
                    : null;
                  if (typeof StartupTelemetry !== 'undefined' && StartupTelemetry?.mark) {
                    const names = new Set((StartupTelemetry.snapshot?.().marks || []).map((m) => m.name));
                    if (!names.has('stable-non-black')) {
                      StartupTelemetry.mark('stable-non-black');
                    }
                  } else if (window.__WRD_SHELL__?.mark) {
                    const snap = window.__WRD_SHELL__.snapshot?.();
                    const names = new Set((snap?.marks || []).map((m) => m.name));
                    if (!names.has('stable-non-black')) window.__WRD_SHELL__.mark('stable-non-black');
                  }
                  const marks = window.__WRD_STARTUP_SNAPSHOT__?.().marks
                    || window.__WRD_SHELL__?.snapshot?.().marks
                    || [];
                  const hit = marks.find((m) => m.name === 'stable-non-black');
                  return hit?.atMs ?? atMs;
                }"""
            )
            break
        page.wait_for_timeout(100)
    aux = _media_aux_evidence(page)
    if non_black <= 0.05 or stable_non_black_at_ms is None:
        raise AssertionError(
            f"stable non-black canvas ratio too low within 8s of start-click: {non_black}; aux={aux}"
        )

    # active/first-frame may lag slightly after pixels; still require within remaining budget if possible.
    try:
        remaining_ms = max(500, int((non_black_deadline - time.time()) * 1000))
        page.wait_for_function(
            "() => window.__WRD_STARTUP_SNAPSHOT__?.().marks.some((m) => m.name === 'active')",
            timeout=remaining_ms,
        )
    except Exception:  # noqa: BLE001
        # Pixels already proved non-black; active mark is supporting evidence only.
        pass

    snapshot = page.evaluate("window.__WRD_STARTUP_SNAPSHOT__()")
    # Never invent marks in the harness.
    mark_names = {m.get("name") for m in (snapshot.get("marks") or [])}
    for required in ("html-shell", "core-interactive", "start-click", "signal-connected", "stable-non-black"):
        if required not in mark_names:
            raise AssertionError(f"missing required startup mark: {required}; have={sorted(mark_names)}")

    nav = _navigation_metrics(page)
    marks = {m["name"]: m["atMs"] for m in snapshot["marks"]}

    def mark_elapsed(start, end):
        if start not in marks or end not in marks:
            return None
        return round(marks[end] - marks[start], 2)

    click_to_stable = mark_elapsed("start-click", "stable-non-black")
    if click_to_stable is None and stable_non_black_at_ms is not None and "start-click" in marks:
        click_to_stable = round(float(stable_non_black_at_ms) - float(marks["start-click"]), 2)
    if click_to_stable is not None and click_to_stable > 8000:
        raise AssertionError(
            f"stable non-black exceeded 8s from start-click: {click_to_stable}ms"
        )

    # navToCoreInteractiveMs: performance mark atMs is already relative to navigationStart.
    sample = {
        "failed": False,
        "finalState": "active" if "active" in mark_names else "stable-non-black",
        "htmlResponseMs": nav.get("htmlResponseMs"),
        "navToCoreInteractiveMs": marks.get("core-interactive"),
        "coreInteractiveMarkMs": mark_elapsed("html-shell", "core-interactive"),
        "clickToSignalMs": mark_elapsed("start-click", "signal-connected"),
        # Honest pixel gate — never proxy with the active mark alone.
        "clickToStableNonBlackMs": click_to_stable,
        "nonBlackRatio": non_black,
        "mediaEvidence": aux,
        "navigation": nav,
        "startup": snapshot,
        "immediateStart": bool(immediate_start),
    }
    return sample


def failure_sample(error, stage="unknown", **extra):
    return {
        "failed": True,
        "finalState": "failed",
        "failureStage": stage,
        "error": str(error)[:500],
        **extra,
    }


def classify_failure_stage(error):
    text = str(error).lower()
    if "non-black" in text or "canvas" in text:
        return "stable-non-black"
    if "signal-connected" in text:
        return "signal-connected"
    if "active" in text and "mark" not in text:
        return "first-frame-active"
    if "core-interactive" in text or "webrtc" in text:
        return "core-interactive"
    if "wait_for_function" in text and "5000" in text:
        return "bounded-wait-5s"
    if "wait_for_function" in text and "8000" in text:
        return "bounded-wait-8s"
    if "startbtn" in text or "goto" in text or "navigation" in text:
        return "html-or-navigation"
    if "feedback" in text:
        return "immediate-start-feedback"
    if "mark" in text:
        return "startup-marks"
    if "timeout" in text:
        return "timeout"
    return "unknown"


def install_fault(page, fault):
    if fault == "cdn-block":
        page.route(
            "**/*",
            lambda route: route.abort()
            if "cdn.jsdelivr.net" in route.request.url
            or "cdn.socket.io" in route.request.url
            or "fonts.googleapis.com" in route.request.url
            or "fonts.gstatic.com" in route.request.url
            else route.continue_(),
        )
    elif fault == "bootstrap-delay":
        def delay_bootstrap(route):
            time.sleep(10)
            route.continue_()

        page.route("**/api/viewer-bootstrap*", delay_bootstrap)
    elif fault == "terminal-abort":
        page.route("**/assets/terminal.*", lambda route: route.abort())
    elif fault == "deferred-abort":
        page.route("**/assets/desktop-deferred*", lambda route: route.abort())


def verify_fault(page, fault, sample):
    if sample.get("failed") and fault != "deferred-abort":
        return
    if fault == "bootstrap-delay":
        marks = {mark["name"]: mark["atMs"] for mark in sample["startup"]["marks"]}
        degraded = marks.get("bootstrap-degraded")
        started = marks.get("bootstrap-start")
        if degraded is None or started is None:
            raise AssertionError("bootstrap-delay fault missing timing marks")
        if degraded - started > 5000:
            raise AssertionError("bootstrap wait exceeded 5s budget")
    elif fault == "terminal-abort":
        if sample.get("failed"):
            return
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
    elif fault == "deferred-abort":
        page.wait_for_function(
            """() => {
              const diag = document.getElementById('diagBtn');
              const port = document.getElementById('portSearchBtn');
              function isRetryOrLoading(btn, retryRe) {
                if (!btn) return false;
                const state = btn.dataset.wrdDiagState || btn.dataset.wrdOperatorState || '';
                const label = String(btn.textContent || '');
                if (state === 'failed' || retryRe.test(label)) return btn.disabled === false;
                if (state === 'loading' || btn.getAttribute('aria-busy') === 'true') {
                  return btn.disabled === true;
                }
                return false;
              }
              const diagOk = isRetryOrLoading(diag, /重试/);
              const portOk = isRetryOrLoading(port, /重试|加载/);
              return diagOk && portOk;
            }""",
            timeout=6_000,
        )


def parse_args(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--origin", required=True)
    parser.add_argument("--runs", type=int, default=20)
    parser.add_argument("--mode", choices=("cold", "warm", "both", "immediate-start"), default="both")
    parser.add_argument(
        "--fault",
        choices=("bootstrap-delay", "terminal-abort", "cdn-block", "deferred-abort", "none"),
        default="none",
    )
    parser.add_argument("--output-dir", default="artifacts/viewer-bootstrap")
    return parser.parse_args(argv)


def run_attempt(browser, *, origin, password, token, cache_mode, fault, immediate_start=False):
    # Cold: brand-new context, cache disabled. Warm: caller reuses context.
    context = browser.new_context(ignore_https_errors=False)
    if cache_mode == "cold":
        # Disable HTTP cache for cold samples.
        context.route(
            "**/*",
            lambda route: route.continue_(
                headers={
                    **route.request.headers,
                    "Cache-Control": "no-cache",
                    "Pragma": "no-cache",
                }
            ),
        )
    page = context.new_page()
    install_fault(page, fault)
    try:
        sample = collect_startup_sample(
            page,
            origin,
            password,
            viewer_token=token,
            immediate_start=immediate_start,
        )
        sample["cacheMode"] = cache_mode
        verify_fault(page, fault, sample)
        return sample, context, page
    except Exception as error:  # noqa: BLE001 - record every planned attempt
        sample = failure_sample(
            error,
            stage=classify_failure_stage(error),
            cacheMode=cache_mode,
            immediateStart=bool(immediate_start),
        )
        return sample, context, page


def main(argv=None):
    args = parse_args(argv)
    password = os.environ.get("VIEWER_ACCESS_PASSWORD", "")
    if not password:
        raise SystemExit("VIEWER_ACCESS_PASSWORD is required")

    from playwright.sync_api import sync_playwright

    viewer_token = fetch_viewer_token(args.origin, password)
    samples = []

    # Never alter the ordinary user path with --disable-http2 or similar.
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        if args.mode in ("cold", "both"):
            for index in range(args.runs):
                sample, context, _page = run_attempt(
                    browser,
                    origin=args.origin,
                    password=password,
                    token=viewer_token,
                    cache_mode="cold",
                    fault=args.fault,
                )
                sample["attemptIndex"] = index
                samples.append(sample)
                context.close()
                time.sleep(0.5)

        if args.mode in ("warm", "both"):
            # Explicit warmup, then N warm samples on the same warmed context/cache.
            warm_context = browser.new_context()
            warm_page = warm_context.new_page()
            install_fault(warm_page, args.fault)
            try:
                collect_startup_sample(
                    warm_page,
                    args.origin,
                    password,
                    viewer_token=viewer_token,
                )
            except Exception as error:  # noqa: BLE001
                samples.append(
                    failure_sample(
                        error,
                        stage=classify_failure_stage(error),
                        cacheMode="warm-seed",
                        attemptIndex=-1,
                    )
                )
            for index in range(args.runs):
                try:
                    sample = collect_startup_sample(
                        warm_page,
                        args.origin,
                        password,
                        viewer_token=viewer_token,
                    )
                    sample["cacheMode"] = "warm"
                    sample["attemptIndex"] = index
                    verify_fault(warm_page, args.fault, sample)
                    samples.append(sample)
                except Exception as error:  # noqa: BLE001
                    samples.append(
                        failure_sample(
                            error,
                            stage=classify_failure_stage(error),
                            cacheMode="warm",
                            attemptIndex=index,
                        )
                    )
                time.sleep(0.3)
            warm_context.close()

        if args.mode == "immediate-start":
            for index in range(args.runs):
                sample, context, _page = run_attempt(
                    browser,
                    origin=args.origin,
                    password=password,
                    token=viewer_token,
                    cache_mode="cold",
                    fault=args.fault,
                    immediate_start=True,
                )
                sample["attemptIndex"] = index
                samples.append(sample)
                context.close()

        browser.close()

    report = build_report(
        args.origin,
        samples,
        mode=args.mode,
        runs=args.runs,
        fault=args.fault,
    )
    path, digest = write_immutable_report(report, args.output_dir)
    print(
        json.dumps(
            {
                "report": str(path),
                "sha256": digest,
                "summary": report["summary"],
                "attemptCount": report["attemptCount"],
                "successCount": report["successCount"],
                "failureCount": report["failureCount"],
                "failureRate": report["failureRate"],
                "failureStages": report["failureStages"],
                "commitSha": report["commitSha"],
            },
            ensure_ascii=True,
        )
    )

    # Gate: for formal cold 20/20, any failure fails the process.
    if args.mode in ("cold", "both", "immediate-start") and args.fault == "none":
        cold = [s for s in samples if s.get("cacheMode") == "cold"]
        if cold and any(s.get("failed") for s in cold):
            raise SystemExit(2)


if __name__ == "__main__":
    main()
