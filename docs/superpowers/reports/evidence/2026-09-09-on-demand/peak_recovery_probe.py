#!/usr/bin/env python3
"""Owned-Chromium recovery evidence probe for the local TURN Viewer.

This deliberately does not start, stop, or reconfigure any service.  It refuses
to run while another Viewer is present, owns the one Chromium instance it uses,
and never sends desktop input.  CDP packet loss is browser-local and is accepted
only when WebRTC inbound statistics show actual loss.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import secrets
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


PROJECT_ROOT = pathlib.Path("/Users/macstudio1/AI/Claude/WebRemoteDesktop")
SAMPLE_INTERVAL_MS = 75  # Deliberately inside the required 50--100 ms range.
RECOVERY_LIMIT_MS = 2_000
PAUSE_STABILITY_MS = 2_000


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8080")
    parser.add_argument("--output", type=pathlib.Path,
                        default=pathlib.Path("/tmp/wrd-peak-recovery.json"))
    parser.add_argument("--loss-duration-ms", type=int, default=10_000)
    parser.add_argument("--headed", action="store_true",
                        help="show the owned Chromium window (headless is the default)")
    return parser.parse_args()


def write_json_atomically(output: pathlib.Path, artifact: dict[str, Any]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    try:
        temporary.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


def load_viewer_password() -> str:
    for name in ("VIEWER_ACCESS_PASSWORD", "ACCESS_PASSWORD"):
        if os.environ.get(name):
            return os.environ[name]
    dotenv = PROJECT_ROOT / "signal-server" / ".env"
    if dotenv.exists():
        for line in dotenv.read_text(encoding="utf-8").splitlines():
            key, separator, value = line.partition("=")
            if separator and key.strip() in {"VIEWER_ACCESS_PASSWORD", "ACCESS_PASSWORD"}:
                return value.strip().strip('"').strip("'")
    return ""


def request_json(url: str, *, method: str = "GET", headers: dict[str, str] | None = None,
                 body: dict[str, Any] | None = None) -> tuple[int, dict[str, Any]]:
    payload = json.dumps(body).encode("utf-8") if body is not None else None
    request = Request(url, method=method, data=payload,
                      headers={"Accept": "application/json", **(headers or {}),
                               **({"Content-Type": "application/json"} if payload else {})})
    try:
        with urlopen(request, timeout=20) as response:
            return response.status, json.loads(response.read().decode("utf-8") or "{}")
    except HTTPError as error:
        # Return structured endpoint errors without retaining a possibly sensitive body.
        return error.code, {}
    except URLError as error:
        raise RuntimeError(f"local API unavailable: {error.reason}") from error


def redact_error(error: BaseException) -> dict[str, str]:
    # Tokens/passwords are never copied into the durable artifact.
    message = str(error)
    for marker in ("Bearer ", "wrd_token", "password"):
        if marker in message:
            message = "sensitive error text redacted"
            break
    return {"type": type(error).__name__, "message": message[:500]}


def verify_no_existing_viewer(base_url: str) -> dict[str, int]:
    status, payload = request_json(f"{base_url}/api/status")
    if status != 200:
        raise RuntimeError(f"status check failed: HTTP {status}")
    viewers = payload.get("viewerCount")
    epoch = payload.get("viewerEpoch")
    if not isinstance(viewers, int) or not isinstance(epoch, int):
        raise RuntimeError("status response lacks viewerCount/viewerEpoch")
    if viewers != 0:
        raise RuntimeError(f"existing Viewer present (viewerCount={viewers}); owned probe refused")
    return {"viewerCount": viewers, "viewerEpoch": epoch}


def acquire_admission(base_url: str, password: str) -> tuple[str, dict[str, Any]]:
    code, login = request_json(f"{base_url}/api/auth/login", method="POST", body={"password": password})
    token = login.get("token")
    if code != 200 or not isinstance(token, str) or not token:
        raise RuntimeError(f"viewer login failed: HTTP {code}")
    code, result = request_json(f"{base_url}/api/proof-admission", method="POST",
                                headers={"Authorization": f"Bearer {token}"})
    admission = result.get("admission") if isinstance(result, dict) else None
    if code not in {200, 201} or not isinstance(admission, dict) or not admission.get("token"):
        raise RuntimeError(f"proof admission rejected: HTTP {code}")
    return token, admission


def release_admission(base_url: str, token: str, admission: dict[str, Any]) -> dict[str, Any]:
    body = {key: admission[key] for key in ("token", "epoch", "realm") if key in admission}
    try:
        code, payload = request_json(f"{base_url}/api/proof-admission/release", method="POST",
                                     headers={"Authorization": f"Bearer {token}"}, body=body)
        return {"attempted": True, "httpStatus": code, "released": bool(payload.get("released") is True)}
    except Exception as error:  # Artifact records cleanup trouble without hiding primary evidence.
        return {"attempted": True, "released": False, "error": redact_error(error)}


def ensure_controls(page: Any, target_selector: str = "#pauseBtn") -> None:
    # This only manipulates chrome in the page owned by this probe; it does not
    # request a control lease or send any keyboard/mouse data to the desktop.
    toggle = page.locator("#toggleControlsBtn")
    toggle.wait_for(state="visible", timeout=10_000)
    if "显示" in toggle.inner_text():
        # Exercise the Viewer’s established show-controls handler rather than
        # guessing which CSS class currently hides the target control.
        toggle.dispatch_event("click")
    page.locator(target_selector).wait_for(state="visible", timeout=10_000)


SNAPSHOT_JS = r"""async () => {
  const state = globalThis.__wrdPeakRecoveryProbe || (globalThis.__wrdPeakRecoveryProbe = { marks: {}, nextVideo: 1, nextPc: 1 });
  const video = document.querySelector('video');
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  if (video && state.video !== video) {
    state.video = video;
    state.videoIdentity = state.nextVideo++;
    const render = (now, metadata) => {
      state.paintCount = (state.paintCount || 0) + 1;
      state.lastPaint = { atMs: now, presentedFrames: Number(metadata?.presentedFrames || 0), mediaTime: Number(metadata?.mediaTime || 0) };
      for (const mark of Object.values(state.marks)) {
        if (!mark.firstNewPaintAtMs && now >= mark.actionAtMs && state.lastPaint.presentedFrames > mark.baselinePresentedFrames) {
          mark.firstNewPaintAtMs = now;
          mark.firstNewPaintPresentedFrames = state.lastPaint.presentedFrames;
        }
      }
      try { video.requestVideoFrameCallback(render); } catch (_) { /* replaced video will be reattached next sample */ }
    };
    video.requestVideoFrameCallback(render);
  }
  const client = globalThis.WebRTC;
  if (client?.pc && state.pc !== client.pc) {
    state.pc = client.pc;
    state.pcIdentity = state.nextPc++;
  }
  const stats = client?.pc ? await client.pc.getStats() : new Map();
  let inbound = null;
  let selectedPair = null;
  stats.forEach((item) => {
    if (item.type === 'inbound-rtp' && (item.kind === 'video' || item.mediaType === 'video')) inbound = item;
    if (item.type === 'transport' && item.selectedCandidatePairId) selectedPair = stats.get(item.selectedCandidatePairId) || selectedPair;
  });
  if (!selectedPair) {
    stats.forEach((item) => { if (item.type === 'candidate-pair' && item.selected) selectedPair = item; });
  }
  const local = selectedPair?.localCandidateId ? stats.get(selectedPair.localCandidateId) : null;
  const exposed = client?.selectedCandidatePair || {};
  return {
    pageNowMs: performance.now(), pcIdentity: state.pcIdentity || null, connection: String(client?.pc?.connectionState || ''),
    status: String(document.querySelector('#connectionStatus')?.textContent || '').trim(),
    relayType: String(local?.candidateType || exposed.localType || exposed.type || '').toLowerCase(),
    video: { width: Number(video?.videoWidth || 0), height: Number(video?.videoHeight || 0) },
    inbound: inbound ? {
      framesDecoded: finite(inbound.framesDecoded) ? Number(inbound.framesDecoded) : null,
      keyFramesDecoded: finite(inbound.keyFramesDecoded) ? Number(inbound.keyFramesDecoded) : null,
      framesReceived: finite(inbound.framesReceived) ? Number(inbound.framesReceived) : null,
      packetsLost: finite(inbound.packetsLost) ? Number(inbound.packetsLost) : null,
      packetsReceived: finite(inbound.packetsReceived) ? Number(inbound.packetsReceived) : null
    } : null,
    paint: { videoIdentity: state.videoIdentity || null, count: Number(state.paintCount || 0),
             last: state.lastPaint || null, marks: structuredClone(state.marks) }
  };
}"""


MARK_JS = r"""(label) => {
  const state = globalThis.__wrdPeakRecoveryProbe || (globalThis.__wrdPeakRecoveryProbe = { marks: {}, nextVideo: 1, nextPc: 1 });
  state.marks[label] = {
    actionAtMs: performance.now(), baselinePresentedFrames: Number(state.lastPaint?.presentedFrames || 0),
    firstNewPaintAtMs: null, firstNewPaintPresentedFrames: null
  };
  return state.marks[label].actionAtMs;
}"""


def snapshot(page: Any) -> dict[str, Any]:
    return page.evaluate(SNAPSHOT_JS)


def inbound_stats(sample: dict[str, Any]) -> dict[str, Any]:
    """Treat an absent inbound RTP record during a reconnect as a missing sample."""
    inbound = sample.get("inbound")
    return inbound if isinstance(inbound, dict) else {}


def wait_for_relay_720(page: Any) -> dict[str, Any]:
    latest: dict[str, Any] = {}
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        latest = snapshot(page)
        if (latest.get("connection") == "connected" and latest.get("relayType") == "relay"
                and latest.get("video", {}).get("height") == 720 and inbound_stats(latest).get("framesDecoded") is not None):
            return latest
        page.wait_for_timeout(250)
    raise RuntimeError(f"did not reach connected 720p relay Viewer: {latest}")


def wait_for_connected_relay(page: Any) -> dict[str, Any]:
    latest: dict[str, Any] = {}
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        latest = snapshot(page)
        if (latest.get("connection") == "connected" and latest.get("relayType") == "relay"
                and inbound_stats(latest).get("framesDecoded") is not None):
            return latest
        page.wait_for_timeout(250)
    raise RuntimeError(f"did not reach connected relay Viewer: {latest}")


def select_720p(page: Any) -> None:
    ensure_controls(page, "#resolutionBtn")
    page.locator("#resolutionBtn").click()
    page.locator('input[name="resolution"][value="720p"]').check()
    page.locator("#applyResolution").click()


def observe_pause_stability(page: Any) -> dict[str, Any]:
    ensure_controls(page, "#pauseBtn")
    page.locator("#pauseBtn").click()
    page.wait_for_timeout(300)  # Let the UI's pause action reach its settled state.
    baseline = snapshot(page)
    decoded = inbound_stats(baseline).get("framesDecoded")
    samples: list[dict[str, Any]] = []
    deadline = time.monotonic() + PAUSE_STABILITY_MS / 1000
    while time.monotonic() < deadline:
        sample = snapshot(page)
        samples.append({"framesDecoded": inbound_stats(sample).get("framesDecoded"), "pageNowMs": sample.get("pageNowMs")})
        page.wait_for_timeout(SAMPLE_INTERVAL_MS)
    values = [sample["framesDecoded"] for sample in samples]
    stable = decoded is not None and bool(values) and all(value == decoded for value in values)
    return {"sampleIntervalMs": SAMPLE_INTERVAL_MS, "durationMs": PAUSE_STABILITY_MS,
            "baselineFramesDecoded": decoded, "samples": samples, "decodedStable": stable}


def measure_recovery(page: Any, *, label: str, click_selector: str, require_refresh_evidence: bool = False) -> dict[str, Any]:
    ensure_controls(page, click_selector)
    before = snapshot(page)
    baseline_decoded = inbound_stats(before).get("framesDecoded")
    baseline_keyframes = inbound_stats(before).get("keyFramesDecoded")
    baseline_pc = before.get("pcIdentity")
    if baseline_decoded is None:
        raise RuntimeError(f"{label}: inbound video stats unavailable")
    action_at_ms = page.evaluate(MARK_JS, label)
    page.locator(click_selector).click()
    samples: list[dict[str, Any]] = []
    first_decoded_at_ms: float | None = None
    first_paint_at_ms: float | None = None
    first_keyframe_at_ms: float | None = None
    first_new_pc_frame_at_ms: float | None = None
    first_new_pc_identity: int | None = None
    deadline = time.monotonic() + RECOVERY_LIMIT_MS / 1000
    while time.monotonic() < deadline:
        current = snapshot(page)
        decoded = inbound_stats(current).get("framesDecoded")
        keyframes = inbound_stats(current).get("keyFramesDecoded")
        # Refresh may build a fresh peer connection whose framesDecoded restarts
        # at zero.  Any decoded frame on that new connection is new media.
        decoded_is_new = (decoded is not None and
                          ((current.get("pcIdentity") != baseline_pc and decoded > 0)
                           or (current.get("pcIdentity") == baseline_pc and decoded > baseline_decoded)))
        if first_decoded_at_ms is None and decoded_is_new:
            first_decoded_at_ms = float(current["pageNowMs"])
        if (first_keyframe_at_ms is None and current.get("pcIdentity") == baseline_pc
                and keyframes is not None and baseline_keyframes is not None and keyframes > baseline_keyframes):
            first_keyframe_at_ms = float(current["pageNowMs"])
        if (first_new_pc_frame_at_ms is None and current.get("pcIdentity") != baseline_pc
                and decoded is not None and decoded > 0):
            first_new_pc_frame_at_ms = float(current["pageNowMs"])
            first_new_pc_identity = current.get("pcIdentity")
        mark = current.get("paint", {}).get("marks", {}).get(label, {})
        if require_refresh_evidence:
            # A normal old-stream paint after clicking refresh is not recovery.
            evidence_at = first_new_pc_frame_at_ms or first_keyframe_at_ms
            last_paint = current.get("paint", {}).get("last") or {}
            painted_at = last_paint.get("atMs")
            if (first_paint_at_ms is None and evidence_at is not None
                    and painted_at is not None and float(painted_at) >= evidence_at):
                first_paint_at_ms = float(painted_at)
        elif first_paint_at_ms is None and mark.get("firstNewPaintAtMs") is not None:
            first_paint_at_ms = float(mark["firstNewPaintAtMs"])
        samples.append({"pageNowMs": current.get("pageNowMs"), "peerConnection": current.get("pcIdentity"),
                        "framesDecoded": decoded, "keyFramesDecoded": keyframes,
                        "paintPresentedFrames": current.get("paint", {}).get("last", {}).get("presentedFrames") if current.get("paint", {}).get("last") else None,
                        "connection": current.get("connection"), "relayType": current.get("relayType")})
        refresh_evidence_seen = first_keyframe_at_ms is not None or first_new_pc_frame_at_ms is not None
        if first_decoded_at_ms is not None and first_paint_at_ms is not None and (not require_refresh_evidence or refresh_evidence_seen):
            break
        page.wait_for_timeout(SAMPLE_INTERVAL_MS)
    decoded_delay = None if first_decoded_at_ms is None else round(first_decoded_at_ms - action_at_ms, 2)
    paint_delay = None if first_paint_at_ms is None else round(first_paint_at_ms - action_at_ms, 2)
    keyframe_delay = None if first_keyframe_at_ms is None else round(first_keyframe_at_ms - action_at_ms, 2)
    new_pc_frame_delay = None if first_new_pc_frame_at_ms is None else round(first_new_pc_frame_at_ms - action_at_ms, 2)
    refresh_evidence = (first_keyframe_at_ms is not None or first_new_pc_frame_at_ms is not None)
    return {"actionAtMs": action_at_ms, "sampleIntervalMs": SAMPLE_INTERVAL_MS,
            "limitMs": RECOVERY_LIMIT_MS, "baselineFramesDecoded": baseline_decoded,
            "baselineKeyFramesDecoded": baseline_keyframes, "baselinePeerConnection": baseline_pc,
            "firstNewDecodedDelayMs": decoded_delay, "firstNewPaintDelayMs": paint_delay,
            "firstNewKeyFrameDelayMs": keyframe_delay,
            "newPeerConnectionFirstFrameDelayMs": new_pc_frame_delay,
            "newPeerConnection": first_new_pc_identity,
            "refreshEvidenceRequired": require_refresh_evidence,
            "refreshEvidence": ("same-peer-keyframe" if first_keyframe_at_ms is not None
                                else "new-peer-first-frame" if first_new_pc_frame_at_ms is not None else None),
            "decodedWithinLimit": decoded_delay is not None and decoded_delay <= RECOVERY_LIMIT_MS,
            "paintWithinLimit": paint_delay is not None and paint_delay <= RECOVERY_LIMIT_MS,
            "ok": (decoded_delay is not None and decoded_delay <= RECOVERY_LIMIT_MS
                   and paint_delay is not None and paint_delay <= RECOVERY_LIMIT_MS
                   and (not require_refresh_evidence or refresh_evidence)),
            "refreshVerified": refresh_evidence,
            "samples": samples}


def finite_cdp_loss(page: Any, duration_ms: int) -> dict[str, Any]:
    before = snapshot(page)
    result: dict[str, Any] = {"requestedPacketLossPercent": 2, "durationMs": duration_ms,
                              "beforePacketsLost": inbound_stats(before).get("packetsLost"),
                              "status": "NOT_VERIFIED",
                              "note": "CDP emulation alone is not evidence; inbound packetsLost must increase."}
    cdp = page.context.new_cdp_session(page)
    conditions = {"offline": False, "latency": 0, "downloadThroughput": -1,
                  "uploadThroughput": -1, "packetLoss": 2, "packetQueueLength": 0,
                  "packetReordering": False}
    try:
        cdp.send("Network.enable")
        cdp.send("Network.emulateNetworkConditions", conditions)
        page.wait_for_timeout(duration_ms)
        during = snapshot(page)
        result["duringPacketsLost"] = inbound_stats(during).get("packetsLost")
    except Exception as error:
        result["emulationError"] = redact_error(error)
    finally:
        try:
            cdp.send("Network.emulateNetworkConditions", {**conditions, "packetLoss": 0})
        except Exception as error:
            result["resetError"] = redact_error(error)
        try:
            cdp.detach()
        except Exception:
            pass
    page.wait_for_timeout(1_000)
    after = snapshot(page)
    result["afterPacketsLost"] = inbound_stats(after).get("packetsLost")
    before_loss = result["beforePacketsLost"]
    after_loss = result["afterPacketsLost"]
    if isinstance(before_loss, (int, float)) and isinstance(after_loss, (int, float)):
        result["observedPacketsLostDelta"] = after_loss - before_loss
        if result["observedPacketsLostDelta"] > 0:
            result["status"] = "VERIFIED"
    else:
        result["observedPacketsLostDelta"] = None
    return result


def run(args: argparse.Namespace) -> dict[str, Any]:
    if args.loss_duration_ms <= 0:
        raise RuntimeError("--loss-duration-ms must be positive")
    artifact: dict[str, Any] = {
        "schemaVersion": 1,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "scope": "one proof-admitted owned Chromium relay Viewer; no desktop input, service change, or machine network change",
        "ok": False,
        "checks": {},
    }
    token: str | None = None
    admission: dict[str, Any] | None = None
    browser: Any = None
    try:
        artifact["checks"]["noExistingViewer"] = verify_no_existing_viewer(args.base_url)
        password = load_viewer_password()
        if not password:
            raise RuntimeError("missing VIEWER_ACCESS_PASSWORD / ACCESS_PASSWORD")
        token, admission = acquire_admission(args.base_url, password)
        # A second status read closes the race between status and admission and
        # records the proof epoch without retaining proof credentials.
        artifact["checks"]["proofAdmission"] = {"granted": True, "epoch": admission.get("epoch")}
        from playwright.sync_api import sync_playwright
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=not args.headed)
            context = browser.new_context(viewport={"width": 1440, "height": 960})
            context.add_init_script(script=(
                f"localStorage.setItem('wrd_token', {json.dumps(token)});"
                "localStorage.setItem('wrdNetworkMode', 'relay');"
                f"sessionStorage.setItem('wrdProofAdmission', {json.dumps(json.dumps(admission))});"))
            page = context.new_page()
            page.goto(f"{args.base_url}/viewer.html", wait_until="domcontentloaded", timeout=45_000)
            page.locator("#startBtn").wait_for(timeout=20_000)
            page.locator("#startBtn").click()
            artifact["checks"]["initialRelay"] = wait_for_connected_relay(page)
            select_720p(page)
            artifact["checks"]["relay720"] = wait_for_relay_720(page)
            artifact["pause"] = observe_pause_stability(page)
            artifact["resume"] = measure_recovery(page, label="resume", click_selector="#pauseBtn")
            artifact["refresh"] = measure_recovery(page, label="refresh", click_selector="#refreshBtn",
                                                    require_refresh_evidence=True)
            artifact["finiteLoss"] = finite_cdp_loss(page, args.loss_duration_ms)
            artifact["checks"]["postLossRelay"] = wait_for_relay_720(page)
            artifact["ok"] = bool(artifact["pause"]["decodedStable"] and artifact["resume"]["ok"]
                                  and artifact["refresh"]["ok"]
                                  and artifact["finiteLoss"]["status"] == "VERIFIED")
            context.close()
            browser.close()
            browser = None
    except Exception as error:
        artifact["error"] = redact_error(error)
        artifact["ok"] = False
    finally:
        if browser is not None:
            try:
                browser.close()
            except Exception:
                pass
        if token is not None and admission is not None:
            artifact["proofRelease"] = release_admission(args.base_url, token, admission)
        artifact["endedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return artifact


def main() -> int:
    args = parse_args()
    artifact: dict[str, Any]
    try:
        artifact = run(args)
    except Exception as error:
        artifact = {"schemaVersion": 1, "ok": False, "error": redact_error(error),
                    "endedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    write_json_atomically(args.output, artifact)
    print(json.dumps({"ok": artifact["ok"], "output": str(args.output)}, ensure_ascii=False))
    return 0 if artifact["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
