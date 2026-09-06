#!/usr/bin/env python3
"""Continuous, proof-admitted TURN runtime collector.

This is a maintenance-window tool.  It opens exactly one headless Viewer only
after the server reports no human Viewer, uses the server proof-admission flow,
and records every one-second sample for the requested phase duration.  It never
changes service configuration, restarts services, or injects network loss.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen


DEFAULT_BASE_URL = "http://127.0.0.1:8080"
PHASE_DURATIONS = {"720p": 600, "1080p": 300}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Collect continuous selected-TURN relay evidence. Does not inject loss or restart services."
    )
    parser.add_argument("--phase", choices=("720p", "1080p", "both"), default="both")
    parser.add_argument("--duration-seconds", type=int, default=None,
                        help="Override one selected phase only (1..3600); omitted uses 720p=600, 1080p=300.")
    parser.add_argument("--output", help="Atomic JSON evidence path. Required for a maintenance run.")
    parser.add_argument("--base-url", default=os.environ.get("WRD_BASE_URL", DEFAULT_BASE_URL))
    parser.add_argument("--controlled-producer-id", default=None,
                        help="Opt in to mouse/keyboard only after a human displays the controlled producer page.")
    args = parser.parse_args(argv)
    if args.duration_seconds is not None and not 1 <= args.duration_seconds <= 3600:
        parser.error("--duration-seconds must be an integer from 1 to 3600")
    if args.duration_seconds is not None and args.phase == "both":
        parser.error("--duration-seconds requires --phase 720p or --phase 1080p")
    args.base_url = str(args.base_url).rstrip("/")
    return args


def phase_duration_seconds(phase: str, override: int | None) -> int:
    return int(override if override is not None else PHASE_DURATIONS[phase])


def percentile(values: list[float], fraction: float) -> float | None:
    numbers = sorted(float(value) for value in values if value is not None)
    if not numbers:
        return None
    return numbers[min(len(numbers) - 1, int(len(numbers) * fraction))]


def redact_runtime_sample(sample: dict[str, Any]) -> dict[str, Any]:
    """Keep diagnostic fields while dropping endpoints, credentials, and tokens."""
    forbidden = {"localAddress", "remoteAddress", "address", "ip", "username", "credential", "turnUsername", "turnCredential", "token"}

    def clean(value: Any) -> Any:
        if isinstance(value, dict):
            return {key: clean(item) for key, item in value.items() if key not in forbidden}
        if isinstance(value, list):
            return [clean(item) for item in value]
        return value

    return clean(sample)


def collect_phase_samples(
    duration_seconds: int,
    sample: Callable[[int], dict[str, Any]],
    now_ms: Callable[[], int] | None = None,
    wait_ms: Callable[[int], None] | None = None,
) -> list[dict[str, Any]]:
    """Collect exactly one sample per requested second; healthy samples never end the run."""
    now_ms = now_ms or (lambda: time.monotonic_ns() // 1_000_000)
    wait_ms = wait_ms or (lambda milliseconds: time.sleep(milliseconds / 1000))
    started = now_ms()
    records: list[dict[str, Any]] = []
    for index in range(duration_seconds):
        target = started + index * 1000
        remaining = target - now_ms()
        if remaining > 0:
            wait_ms(remaining)
        record = dict(sample(index) or {})
        record["sampleIndex"] = index
        record["elapsedMs"] = max(0, now_ms() - started)
        records.append(redact_runtime_sample(record))
    return records


def summarize_phase(phase: str, samples: list[dict[str, Any]]) -> dict[str, Any]:
    """Evaluate every sample.  A good final sample cannot hide an earlier outage."""
    failures: set[str] = set()
    fps = [sample.get("derivedFps") for sample in samples[1:]]
    buffers = [sample.get("jitterBufferMs") for sample in samples[1:]]
    for sample in samples:
        selected = sample.get("selectedPair") or {}
        if str(selected.get("type") or "").lower() != "relay":
            failures.add("non-relay-sample")
        if sample.get("pcConnectionState") != "connected":
            failures.add("pc-not-connected")
    for sample in samples[1:]:
        if float(sample.get("paintGapMs") or 0) > 1000:
            failures.add("post-warmup-paint-gap")
    fps_p50 = percentile(fps, 0.5)
    jitter_p95 = percentile(buffers, 0.95)
    jitter_max = max((float(value) for value in buffers if value is not None), default=None)
    required_fps = 18 if phase == "720p" else 15
    if fps_p50 is None or fps_p50 < required_fps:
        failures.add("fps-p50")
    if jitter_p95 is None or jitter_p95 > 150:
        failures.add("jitter-buffer-p95")
    if jitter_max is None or jitter_max > 300:
        failures.add("jitter-buffer-max")
    return {
        "phase": phase,
        "sampleCount": len(samples),
        "requiredSampleCount": PHASE_DURATIONS[phase],
        "derivedFpsP50": fps_p50,
        "jitterBufferMsP95": jitter_p95,
        "jitterBufferMsMax": jitter_max,
        "failures": sorted(failures),
        "ok": not failures,
    }


def _json_request(url: str, method: str = "GET", headers: dict[str, str] | None = None, body: dict[str, Any] | None = None) -> tuple[int, dict[str, Any]]:
    encoded = json.dumps(body).encode("utf-8") if body is not None else None
    request_headers = {"Accept": "application/json", **(headers or {})}
    if encoded is not None:
        request_headers["Content-Type"] = "application/json"
    request = Request(url, method=method, headers=request_headers, data=encoded)
    try:
        with urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read().decode("utf-8") or "{}")
    except HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8") or "{}")


def load_viewer_password(project_root: Path) -> str:
    for name in ("VIEWER_ACCESS_PASSWORD", "ACCESS_PASSWORD"):
        if os.environ.get(name):
            return os.environ[name]
    dotenv = project_root / "signal-server" / ".env"
    if dotenv.exists():
        for line in dotenv.read_text(encoding="utf-8").splitlines():
            key, separator, value = line.partition("=")
            if separator and key.strip() in {"VIEWER_ACCESS_PASSWORD", "ACCESS_PASSWORD"}:
                return value.strip().strip('"').strip("'")
    return ""


def start_viewer(page: Any) -> None:
    """The viewer does not connect merely from seeded storage; start it explicitly."""
    page.locator("#startBtn").click()


def wait_for_healthy_relay(page: Any, timeout_seconds: int = 45) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    latest: dict[str, Any] = {}
    while time.monotonic() < deadline:
        latest = page.evaluate("""async () => {
          const client = window.WebRTC;
          const selected = client?.selectedCandidatePair || {};
          const fps = Number((document.getElementById('fpsDisplay')?.textContent || '').replace(/[^\\d.]/g, '')) || 0;
          return { fps, socketConnected: !!client?.socket?.connected,
            pcConnectionState: String(client?.pc?.connectionState || ''),
            connectionStatus: document.getElementById('connectionStatus')?.textContent?.trim() || '',
            selectedPair: { type: String(selected.localType || selected.type || '').toLowerCase(), protocol: String(selected.protocol || '').toLowerCase() } };
        }""")
        if (latest.get("fps", 0) > 0 and latest.get("socketConnected")
                and latest.get("pcConnectionState") == "connected"
                and latest.get("connectionStatus") == "已连接"
                and latest.get("selectedPair", {}).get("type") == "relay"):
            return redact_runtime_sample(latest)
        page.wait_for_timeout(1000)
    raise RuntimeError(f"timed out waiting for started connected selected-relay Viewer: {redact_runtime_sample(latest)}")


SAMPLE_JS = r"""async () => {
  const now = performance.now();
  const state = window.__wrdTurnCollector || (window.__wrdTurnCollector = { previous: null, lastPaintAt: null, trackerBound: false, inputAcks: [] });
  const video = document.getElementById('remoteVideo');
  if (video && !state.trackerBound && typeof video.requestVideoFrameCallback === 'function') {
    state.trackerBound = true;
    const tick = () => { state.lastPaintAt = performance.now(); video.requestVideoFrameCallback(tick); };
    video.requestVideoFrameCallback(tick);
  }
  const reports = WebRTC?.pc ? Array.from((await WebRTC.pc.getStats()).values()) : [];
  const inbound = reports.find((r) => r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) || {};
  const transport = reports.find((r) => r.type === 'transport' && r.selectedCandidatePairId);
  const pair = reports.find((r) => r.id === transport?.selectedCandidatePairId) || reports.find((r) => r.type === 'candidate-pair' && r.state === 'succeeded' && (r.selected || r.nominated)) || {};
  const local = reports.find((r) => r.id === pair.localCandidateId) || {};
  const previous = state.previous;
  const total = (name) => Number(inbound[name] || 0);
  const delta = (name) => previous ? Math.max(0, total(name) - Number(previous[name] || 0)) : 0;
  const elapsed = previous ? Math.max(1, now - previous.now) : 0;
  const jitterCount = delta('jitterBufferEmittedCount');
  const paint = WebRTC?._lastPaintStats || {};
  const controller = window.LinkQualityController?.snapshot?.() || null;
  const input = window.Input?.getDiagnosticState?.() || null;
  const latency = window.LatencyMonitor?.getStats?.() || null;
  const sample = {
    selectedPair: { type: String(local.candidateType || pair.localCandidateType || '').toLowerCase(), protocol: String(local.protocol || pair.protocol || '').toLowerCase(), rttMs: Number.isFinite(Number(pair.currentRoundTripTime)) ? Math.round(Number(pair.currentRoundTripTime) * 1000) : null },
    pcConnectionState: String(WebRTC?.pc?.connectionState || ''), socketConnected: !!WebRTC?.socket?.connected,
    connectionAttemptId: WebRTC?.currentConnectionAttemptId || null,
    resolution: { width: Number(video?.videoWidth || 0), height: Number(video?.videoHeight || 0), cssWidth: Math.round(video?.getBoundingClientRect?.().width || 0), cssHeight: Math.round(video?.getBoundingClientRect?.().height || 0) },
    frameSequence: Number(WebRTC?._videoFrameSeq || 0), browserReportedFps: Number(inbound.framesPerSecond || 0),
    receivedDelta: delta('framesReceived'), decodedDelta: delta('framesDecoded'), packetsLostDelta: delta('packetsLost'), bytesDelta: delta('bytesReceived'),
    derivedFps: elapsed ? Math.round((delta('framesDecoded') * 1000 / elapsed) * 10) / 10 : 0,
    jitterBufferMs: jitterCount ? Math.round((delta('jitterBufferDelay') / jitterCount * 1000) * 10) / 10 : 0,
    framesDroppedDelta: delta('framesDropped'), packetsReceivedDelta: delta('packetsReceived'), nackCountDelta: delta('nackCount'), pliCountDelta: delta('pliCount'), firCountDelta: delta('firCount'), freezeDelta: delta('freezeCount'),
    paintGapMs: state.lastPaintAt === null ? null : Math.round(now - state.lastPaintAt), paint: { ...paint },
    latency, input, policy: { networkMode: WebRTC?.networkMode || null, profile: controller?.currentProfile || null, profileChanges: controller?.profileChanges || [], keyframeRequested: WebRTC?._keyframeRequested === true, keyframeEmitted: WebRTC?._keyframeEmitted === true, keyframeRequestSequence: Number(WebRTC?._keyframeRequestSequence || 0) },
    inputAcks: state.inputAcks.splice(0), mediaPhase: WebRTC?.getMediaAppliedPhase?.() || null,
  };
  state.previous = { now, framesReceived: total('framesReceived'), framesDecoded: total('framesDecoded'), packetsLost: total('packetsLost'), bytesReceived: total('bytesReceived'), jitterBufferDelay: total('jitterBufferDelay'), jitterBufferEmittedCount: total('jitterBufferEmittedCount'), framesDropped: total('framesDropped'), packetsReceived: total('packetsReceived'), nackCount: total('nackCount'), pliCount: total('pliCount'), firCount: total('firCount'), freezeCount: total('freezeCount') };
  return sample;
}"""


def _install_input_ack_observer(page: Any) -> None:
    page.evaluate("""() => {
      const state = window.__wrdTurnCollector || (window.__wrdTurnCollector = { previous: null, lastPaintAt: null, trackerBound: false, inputAcks: [] });
      if (state.inputAckBound || !WebRTC?.socket?.on) return;
      state.inputAckBound = true;
      WebRTC.socket.on('input-ack', (ack) => state.inputAcks.push({ inputType: ack?.inputType || null, status: ack?.status || null, inputIds: Array.isArray(ack?.inputIds) ? ack.inputIds.length : (ack?.inputId ? 1 : 0) }));
    }""")


def select_resolution(page: Any, phase: str) -> None:
    page.locator("#resolutionBtn").click()
    page.locator("#adaptiveResolutionToggle").uncheck()
    page.locator(f'input[name="resolution"][value="{phase}"]').check()
    page.locator("#applyResolution").click()


def _wait_for_phase(page: Any, expected: str, timeout_seconds: int = 15) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if page.evaluate("() => WebRTC?.getMediaAppliedPhase?.()") == expected:
            return True
        page.wait_for_timeout(100)
    return page.evaluate("() => WebRTC?.getMediaAppliedPhase?.()") == expected


def record_interactions(page: Any, enabled: bool) -> dict[str, Any]:
    if not enabled:
        return {"status": "NOT_RUN", "reason": "requires --controlled-producer-id; collector never sends desktop input to an uncontrolled host"}
    page.locator("#requestControlBtn").click()
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        active = page.evaluate("() => !!(WebRTC?.canEnableDesktopInput?.() && Input?.isActive)")
        if active:
            break
        page.wait_for_timeout(100)
    box = page.locator("#remoteVideo").bounding_box()
    if not box:
        return {"status": "FAIL", "reason": "remote video has no bounding box"}
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(x, y)
    page.mouse.wheel(0, 120)
    page.mouse.move(x - 20, y - 20); page.mouse.down(); page.mouse.move(x + 20, y + 20, steps=4); page.mouse.up()
    page.locator("#remoteVideo").focus(); page.keyboard.press("Tab")
    page.wait_for_timeout(1000)
    return {"status": "RECORDED", "input": redact_runtime_sample(page.evaluate(SAMPLE_JS)).get("input"), "acks": redact_runtime_sample(page.evaluate(SAMPLE_JS)).get("inputAcks")}


def record_pause_resume_refresh(page: Any) -> dict[str, Any]:
    baseline = page.evaluate("() => ({ attempt: WebRTC?.currentConnectionAttemptId || null, frame: Number(WebRTC?._videoFrameSeq || 0) })")
    page.locator("#pauseBtn").click()
    suspended = _wait_for_phase(page, "suspended")
    page.locator("#pauseBtn").click()
    active = _wait_for_phase(page, "active")
    deadline = time.monotonic() + 5
    resumed = False
    while time.monotonic() < deadline:
        current = page.evaluate("() => Number(WebRTC?._videoFrameSeq || 0)")
        if current > baseline["frame"]:
            resumed = True; break
        page.wait_for_timeout(100)
    before_refresh = page.evaluate("() => ({ attempt: WebRTC?.currentConnectionAttemptId || null, frame: Number(WebRTC?._videoFrameSeq || 0) })")
    page.locator("#refreshBtn").click()
    page.wait_for_timeout(1000)
    after_refresh = page.evaluate("() => ({ attempt: WebRTC?.currentConnectionAttemptId || null, frame: Number(WebRTC?._videoFrameSeq || 0) })")
    return {"pauseResume": {"suspended": suspended, "active": active, "freshFrame": resumed, "baseline": baseline}, "refresh": {"before": before_refresh, "after": after_refresh}}


def write_json_atomically(output: Path, artifact: dict[str, Any]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(artifact, ensure_ascii=False, indent=2) + "\n"
    temporary = output.with_name(f".{output.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    with temporary.open("x", encoding="utf-8") as handle:
        handle.write(payload); handle.flush(); os.fsync(handle.fileno())
    os.replace(temporary, output)


def run(args: argparse.Namespace, project_root: Path) -> dict[str, Any]:
    if not args.output:
        raise RuntimeError("--output is required; preserve a durable run artifact")
    password = load_viewer_password(project_root)
    if not password:
        raise RuntimeError("Missing VIEWER_ACCESS_PASSWORD / ACCESS_PASSWORD")
    status, login = _json_request(f"{args.base_url}/api/auth/login", method="POST", body={"password": password})
    if status != 200 or not login.get("token"):
        raise RuntimeError(f"login failed: HTTP {status}")
    token = login["token"]
    headers = {"Authorization": f"Bearer {token}"}
    status_code, status_body = _json_request(f"{args.base_url}/api/status")
    if status_code != 200 or int(status_body.get("viewerCount") or 0) > 0:
        raise RuntimeError(f"active Viewer present (viewerCount={status_body.get('viewerCount')}); refusing headless collector")
    admission_code, admission_body = _json_request(f"{args.base_url}/api/proof-admission", method="POST", headers=headers)
    admission = admission_body.get("admission") or {}
    if admission_code != 200 or not admission.get("token"):
        raise RuntimeError(f"proof admission failed: HTTP {admission_code}")
    cfg_code, cfg = _json_request(f"{args.base_url}/api/webrtc-config", headers=headers)
    if cfg_code != 200 or not cfg.get("turnConfigured") or not cfg.get("hostTurnReady") or cfg.get("turnFingerprint") != cfg.get("hostTurnFingerprint"):
        raise RuntimeError("TURN configuration fingerprint/readiness check failed")
    selftest_code, selftest = _json_request(f"{args.base_url}/api/turn-selftest", method="POST", headers=headers, body={"timeoutMs": 12000})
    if selftest_code != 200 or not selftest.get("ok"):
        raise RuntimeError(f"TURN selftest failed: {selftest.get('code') or selftest.get('reason')}")
    from playwright.sync_api import sync_playwright
    phases = [args.phase] if args.phase != "both" else ["720p", "1080p"]
    artifact: dict[str, Any] = {"runId": f"turn-runtime-{secrets.token_hex(8)}", "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "baseUrl": args.base_url, "proof": {"viewerEpoch": status_body.get("viewerEpoch"), "admissionEpoch": admission.get("epoch"), "turnFingerprintMatch": True, "relayCandidateCount": selftest.get("relayCandidateCount")}, "phases": [], "finiteLoss": {"status": "NOT_RUN", "reason": "requires isolated TURN network injection; HTTP throttling and host firewall/pf are forbidden"}}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            context = browser.new_context(viewport={"width": 1440, "height": 960})
            page = context.new_page()
            page.add_init_script("""({ token, admission }) => { localStorage.setItem('wrd_token', token); localStorage.setItem('wrdNetworkMode', 'relay'); sessionStorage.setItem('wrdProofAdmission', JSON.stringify(admission)); }""", {"token": token, "admission": admission})
            page.goto(f"{args.base_url}/viewer.html", wait_until="domcontentloaded", timeout=45000)
            page.locator("#startBtn").wait_for(timeout=20000)
            start_viewer(page)
            artifact["startedRelay"] = wait_for_healthy_relay(page)
            _install_input_ack_observer(page)
            for phase in phases:
                select_resolution(page, phase)
                page.wait_for_timeout(1500)
                duration = phase_duration_seconds(phase, args.duration_seconds)
                marker = {"staticText": "RECORDED", "scrollDragKeyboard": record_interactions(page, bool(args.controlled_producer_id)), "pauseResumeRefresh": record_pause_resume_refresh(page)}
                screenshots = []
                output_path = Path(args.output)
                screenshot_dir = output_path.with_suffix(output_path.suffix + ".screens")
                screenshot_dir.mkdir(parents=True, exist_ok=True)
                screenshot_marks = {0: "static-start", duration // 2: "static-middle", duration - 1: "static-end"}

                def sample(index: int) -> dict[str, Any]:
                    label = screenshot_marks.get(index)
                    if label:
                        target = screenshot_dir / f"{artifact['runId']}-{phase}-{label}.png"
                        page.locator("#remoteVideo").screenshot(path=str(target))
                        screenshots.append(str(target))
                    return page.evaluate(SAMPLE_JS)

                samples = collect_phase_samples(duration, sample=sample, wait_ms=page.wait_for_timeout)
                summary = summarize_phase(phase, samples)
                summary["requiredSampleCount"] = duration
                summary["ok"] = summary["ok"] and len(samples) == duration
                artifact["phases"].append({"phase": phase, "durationSeconds": duration, "markers": marker, "screenshots": screenshots, "samples": samples, "summary": summary})
        finally:
            browser.close()
    artifact["ok"] = bool(artifact["phases"]) and all(phase["summary"]["ok"] for phase in artifact["phases"])
    return redact_runtime_sample(artifact)


def main() -> int:
    args = parse_args()
    root = Path(__file__).resolve().parents[1]
    output = Path(args.output) if args.output else None
    try:
        result = run(args, root)
    except Exception as error:  # Persist a fresh failure record rather than leave stale success evidence.
        result = {"runId": f"turn-runtime-{secrets.token_hex(8)}", "ok": False, "error": {"message": str(error)}, "finiteLoss": {"status": "NOT_RUN", "reason": "requires isolated TURN network injection; HTTP throttling and host firewall/pf are forbidden"}}
    if output:
        write_json_atomically(output, result)
    print(json.dumps({key: value for key, value in result.items() if key != "phases"}, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
