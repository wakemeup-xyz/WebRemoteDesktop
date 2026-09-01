#!/usr/bin/env python3
"""Run mobile Viewer acceptance against an operator-supplied existing origin.

The artifact intentionally contains only scenario labels, status/reason, transport,
ACK summary, pressed counts, and layout bounding boxes. Credentials, text input,
keys, clipboard contents, URLs, and event coordinates never enter the artifact.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse


SCENARIOS = (
    "active-control-click",
    "double-click",
    "long-press-right-click",
    "drag-pointercancel",
    "two-finger-wheel",
    "text-input",
    "cjk-composition",
    "emoji",
    "modifier-latch",
    "visibility-hide",
    "transport-fallback",
    "control-revoke-reconnect",
)
VIEWPORTS = ((375, 812), (768, 1024), (1024, 1366), (1440, 900))


class AcceptanceError(RuntimeError):
    """Known acceptance failures whose reason can be safely serialized."""


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True, help="Existing Viewer origin; this command never starts services.")
    parser.add_argument("--password-env", default="VIEWER_ACCESS_PASSWORD", help="Environment variable holding the Viewer password.")
    parser.add_argument("--out", default="artifacts/mobile-viewer-acceptance.json", help="JSON artifact path.")
    return parser.parse_args(argv)


def validate_base_url(value):
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise AcceptanceError("invalid-base-url")
    return value.rstrip("/")


def fetch_viewer_token(base_url, password):
    payload = json.dumps({"password": password}).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url}/api/auth/login",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise AcceptanceError("login-rejected") from error
    except urllib.error.URLError as error:
        raise AcceptanceError("origin-unreachable") from error
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise AcceptanceError("login-unavailable") from error
    token = body.get("token") if isinstance(body, dict) else None
    if not isinstance(token, str) or not token:
        raise AcceptanceError("login-token-missing")
    return token


def safe_reason(error):
    if isinstance(error, AcceptanceError):
        return str(error)
    name = type(error).__name__
    if name == "TimeoutError":
        return "timeout"
    return "browser-action-failed"


def box(page, selector):
    value = page.locator(selector).evaluate(
        """element => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, top: rect.top, width: rect.width, height: rect.height,
            right: rect.right, bottom: rect.bottom, visible: !(element.hidden || getComputedStyle(element).display === 'none') };
        }"""
    )
    numeric_keys = ("left", "top", "width", "height", "right", "bottom")
    return {
        **{key: round(float(value[key]), 2) for key in numeric_keys},
        "visible": bool(value.get("visible")),
    }


def overlaps(left, right):
    if not left["visible"] or not right["visible"]:
        return False
    return not (
        left["right"] <= right["left"]
        or right["right"] <= left["left"]
        or left["bottom"] <= right["top"]
        or right["bottom"] <= left["top"]
    )


def contains(outer, inner):
    return (
        outer["visible"] and inner["visible"]
        and outer["left"] <= inner["left"]
        and outer["top"] <= inner["top"]
        and outer["right"] >= inner["right"]
        and outer["bottom"] >= inner["bottom"]
    )


def validate_geometry(boxes):
    required = ("statusBar", "viewerSurface", "dock", "mobileKeyboard", "fullscreen")
    if any(not boxes[name]["visible"] for name in required):
        return "mobile-keyboard-not-visible" if not boxes["mobileKeyboard"]["visible"] else "layout-element-not-visible"
    if not contains(boxes["dock"], boxes["fullscreen"]):
        return "fullscreen-not-in-dock"
    allowed_containment = {frozenset(("dock", "fullscreen"))}
    for index, left_name in enumerate(required):
        for right_name in required[index + 1:]:
            if frozenset((left_name, right_name)) in allowed_containment:
                continue
            if overlaps(boxes[left_name], boxes[right_name]):
                return "layout-overlap"
    return None


def completion_ok(state, observations, expected):
    if (
        state.get("pressedKeyCount") != 0
        or state.get("pressedMouseButtonCount") != 0
        or state.get("pendingMouseReset")
        or state.get("pendingKeyboard") != 0
        or state.get("keyboardState") in {"RESET_REQUIRED", "BLOCKED", "reacquire-required"}
    ):
        return False
    for input_type, action in expected:
        if not any(
            observation.get("type") == input_type
            and observation.get("action") == action
            and observation.get("transport") in {"datachannel", "socket"}
            and observation.get("ackStatus") in {"applied", "duplicate"}
            for observation in observations
        ):
            return False
    return True


def install_observer(page):
    page.evaluate(
        """() => {
          if (window.__mobileAcceptanceObserver) return;
          const observer = { sent: [], acknowledgements: new Map() };
          const record = (payload, transport) => {
            if (!payload || !Array.isArray(payload.inputIds)) return;
            for (const inputId of payload.inputIds) {
              if (typeof inputId !== 'string') continue;
              observer.sent.push({ inputId, type: String(payload.type || 'unknown'), action: String(payload.action || 'unknown'), transport });
            }
          };
          const acknowledge = (ack) => {
            const status = String(ack?.status || 'unknown');
            for (const inputId of Array.isArray(ack?.inputIds) ? ack.inputIds : []) {
              if (typeof inputId === 'string') observer.acknowledgements.set(inputId, status);
            }
          };
          const webRtcSend = window.WebRTC?.sendInput?.bind(window.WebRTC);
          if (webRtcSend) {
            window.WebRTC.sendInput = (payload) => {
              const accepted = webRtcSend(payload);
              if (accepted === true) record(payload, 'datachannel');
              return accepted;
            };
          }
          const socket = window.WebRTC?.socket;
          const socketEmit = socket?.emit?.bind(socket);
          if (socketEmit) {
            socket.emit = (event, payload, ...rest) => {
              if (event === 'input') record(payload, 'socket');
              return socketEmit(event, payload, ...rest);
            };
          }
          for (const method of ['acceptMouseAck', 'acceptKeyboardAck']) {
            const original = window.Input?.[method]?.bind(window.Input);
            if (!original) continue;
            window.Input[method] = (ack) => { acknowledge(ack); return original(ack); };
          }
          window.__mobileAcceptanceObserver = observer;
        }"""
    )


def safe_state(page):
    return page.evaluate(
        """() => {
          const input = window.Input?.getDiagnosticState?.() || {};
          const latency = window.LatencyMonitor?.getStats?.()?.inputRtt || {};
          const observer = window.__mobileAcceptanceObserver || { sent: [], acknowledgements: new Map() };
          return {
            transport: input.keyboard?.adapter || null,
            ackRttMs: Number.isFinite(Number(latency.last)) ? Number(latency.last) : null,
            pressedKeyCount: Number(input.keyboard?.pressedCount || 0),
            pressedMouseButtonCount: Number(input.pressedMouseButtonCount || 0),
            pendingMouseReset: Boolean(input.pendingMouseReset),
            pendingKeyboard: Number(input.keyboard?.pendingCount || 0),
            keyboardState: String(input.keyboard?.leaseState || 'INACTIVE'),
            observations: observer.sent.map((item) => ({
              type: item.type,
              action: item.action,
              transport: item.transport,
              ackStatus: observer.acknowledgements.get(item.inputId) || null,
            })),
          };
        }"""
    )


def wait_for_expected_ack(page, expected):
    expected_data = [{"type": item[0], "action": item[1]} for item in expected]
    page.wait_for_function(
        """expected => {
          const observer = window.__mobileAcceptanceObserver;
          if (!observer) return false;
          return expected.every((wanted) => observer.sent.some((item) => (
            item.type === wanted.type
            && item.action === wanted.action
            && (item.transport === 'datachannel' || item.transport === 'socket')
            && ['applied', 'duplicate'].includes(observer.acknowledgements.get(item.inputId))
          )));
        }""",
        expected_data,
        timeout=15000,
    )


def assert_teardown(page, expected):
    page.evaluate(
        """() => {
          window.Input?.releasePointer?.('acceptance-teardown');
          window.Input?.resetKeyboard?.('acceptance-teardown');
        }"""
    )
    page.wait_for_function(
        """() => {
          const input = window.Input?.getDiagnosticState?.() || {};
          const observer = window.__mobileAcceptanceObserver;
          const allAcknowledged = observer && observer.sent.every((item) =>
            ['applied', 'duplicate'].includes(observer.acknowledgements.get(item.inputId)));
          return allAcknowledged
            && !input.pendingMouseReset
            && Number(input.keyboard?.pendingCount || 0) === 0
            && Number(input.keyboard?.pressedCount || 0) === 0
            && Number(input.pressedMouseButtonCount || 0) === 0
            && !['RESET_REQUIRED', 'BLOCKED', 'reacquire-required'].includes(String(input.keyboard?.leaseState || 'INACTIVE'));
        }""",
        timeout=15000,
    )
    state = safe_state(page)
    if not completion_ok(state, state["observations"], expected):
        raise AcceptanceError("unacknowledged-or-unsafe-input")
    return state


def open_active_viewer(browser, base_url, token, viewport):
    context = browser.new_context(
        viewport={"width": viewport[0], "height": viewport[1]},
        screen={"width": viewport[0], "height": viewport[1]},
        is_mobile=True,
        has_touch=True,
        device_scale_factor=1,
    )
    page = context.new_page()
    # The token is injected before Viewer scripts execute and is never written to disk.
    page.add_init_script("token => sessionStorage.setItem('wrd_token', token)", token)
    page.goto(f"{base_url}/viewer.html", wait_until="domcontentloaded", timeout=15000)
    page.locator("#remoteVideo").wait_for(state="attached", timeout=10000)
    start = page.locator("#startBtn")
    if start.is_visible():
        start.click(timeout=5000)
    page.locator("#requestControlBtn").click(timeout=10000)
    page.wait_for_function(
        """() => Boolean(window.WebRTC?.hasActiveControl?.() && window.Input?.isActive)""",
        timeout=20000,
    )
    return context, page


def touch_event(page, event_type, pointer_id, x, y):
    page.evaluate(
        """({eventType, pointerId, x, y}) => {
          const surface = document.getElementById('remoteVideo');
          surface.dispatchEvent(new PointerEvent(eventType, {
            bubbles: true, cancelable: true, pointerType: 'touch', pointerId,
            isPrimary: pointerId === 1, clientX: x, clientY: y, buttons: eventType === 'pointerup' ? 0 : 1,
          }));
        }""",
        {"eventType": event_type, "pointerId": pointer_id, "x": x, "y": y},
    )


def run_scenario(page, name):
    surface = page.locator("#remoteVideo")
    expected = ()
    if name == "active-control-click":
        touch_event(page, "pointerdown", 1, 80, 80)
        touch_event(page, "pointerup", 1, 80, 80)
        expected = (("mouse", "down"), ("mouse", "up"))
    elif name == "double-click":
        for _ in range(2):
            touch_event(page, "pointerdown", 1, 80, 80)
            touch_event(page, "pointerup", 1, 80, 80)
        expected = (("mouse", "down"), ("mouse", "up"))
    elif name == "long-press-right-click":
        touch_event(page, "pointerdown", 1, 80, 80)
        page.wait_for_timeout(575)
        touch_event(page, "pointerup", 1, 80, 80)
        expected = (("mouse", "down"), ("mouse", "up"))
    elif name == "drag-pointercancel":
        touch_event(page, "pointerdown", 1, 80, 80)
        touch_event(page, "pointermove", 1, 110, 80)
        wait_for_expected_ack(page, (("mouse", "move"),))
        touch_event(page, "pointercancel", 1, 110, 80)
        expected = (("mouse", "down"), ("mouse", "move"), ("mouse", "reset"))
    elif name == "two-finger-wheel":
        touch_event(page, "pointerdown", 1, 80, 80)
        touch_event(page, "pointerdown", 2, 120, 80)
        touch_event(page, "pointermove", 2, 120, 120)
        wait_for_expected_ack(page, (("mouse", "wheel"),))
        touch_event(page, "pointerup", 2, 120, 120)
        touch_event(page, "pointerup", 1, 80, 80)
        expected = (("mouse", "wheel"),)
    elif name in {"text-input", "cjk-composition", "emoji"}:
        page.locator("#mobileTextInputBtn").click(timeout=5000)
        if name == "cjk-composition":
            page.locator("#mobileTextInput").evaluate(
                """input => { input.dispatchEvent(new CompositionEvent('compositionstart')); input.value = '\\u4e2d\\u6587'; input.dispatchEvent(new CompositionEvent('compositionend')); }"""
            )
        elif name == "emoji":
            page.locator("#mobileTextInput").evaluate(
                """input => { input.value = '\\ud83d\\ude00'; input.dispatchEvent(new Event('input', { bubbles: true })); }"""
            )
        else:
            page.locator("#mobileTextInput").evaluate(
                """input => { input.value = 'mobile-acceptance'; input.dispatchEvent(new Event('input', { bubbles: true })); }"""
            )
        expected = (("keyboard", "text"),)
    elif name == "modifier-latch":
        page.locator('[data-mobile-action="shift"]').click(timeout=5000)
        page.locator('[data-mobile-action="shift"]').click(timeout=5000)
        expected = (("keyboard", "key"),)
    elif name == "visibility-hide":
        page.evaluate(
            """() => {
              Object.defineProperty(document, 'hidden', { configurable: true, value: true });
              document.dispatchEvent(new Event('visibilitychange'));
            }"""
        )
        expected = (("keyboard", "reset"),)
    elif name == "transport-fallback":
        page.evaluate("""() => window.WebRTC?.inputChannel?.close?.()""")
        wait_for_expected_ack(page, (("keyboard", "reset"),))
        fallback = safe_state(page)["observations"]
        if not any(item["type"] == "keyboard" and item["action"] == "reset" and item["transport"] == "socket" and item["ackStatus"] in {"applied", "duplicate"} for item in fallback):
            raise AcceptanceError("socket-reset-not-acknowledged")
        page.locator('[data-mobile-action="enter"]').click(timeout=5000)
        expected = (("keyboard", "reset"), ("keyboard", "batch"))
    elif name == "control-revoke-reconnect":
        page.locator("#disconnectBtn").click(timeout=5000)
        page.locator("#startBtn").click(timeout=10000)
        page.locator("#requestControlBtn").click(timeout=10000)
        page.wait_for_function(
            """() => Boolean(window.WebRTC?.hasActiveControl?.() && window.Input?.isActive)""",
            timeout=20000,
        )
        page.locator('[data-mobile-action="enter"]').click(timeout=5000)
        expected = (("keyboard", "batch"),)
    else:  # pragma: no cover - static scenario list guards this.
        raise AcceptanceError("unknown-scenario")
    surface.wait_for(state="attached", timeout=1000)
    wait_for_expected_ack(page, expected)
    return expected


def artifact_entry(name, status, reason=None, state=None, actions=()):
    entry = {"scenario": name, "status": status, "actions": list(actions)}
    if reason is not None:
        entry["reason"] = reason
    if state is not None:
        entry.update(state)
    return entry


def run_browser_acceptance(base_url, token, out_path):
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as error:
        raise AcceptanceError("playwright-unavailable") from error

    artifact = {"scenarios": [], "viewports": [], "devices": []}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for scenario in SCENARIOS:
                context = None
                try:
                    context, page = open_active_viewer(browser, base_url, token, VIEWPORTS[0])
                    install_observer(page)
                    expected = run_scenario(page, scenario)
                    state = assert_teardown(page, expected)
                    artifact["scenarios"].append(artifact_entry(
                        scenario, "PASS", state={key: value for key, value in state.items() if key != "observations"},
                        actions=(scenario,),
                    ))
                except Exception as error:  # noqa: BLE001 - artifact keeps only safe reasons.
                    artifact["scenarios"].append(artifact_entry(
                        scenario, "FAIL", safe_reason(error), actions=(scenario,),
                    ))
                finally:
                    if context is not None:
                        context.close()

            for width, height in VIEWPORTS:
                context = None
                try:
                    context, page = open_active_viewer(browser, base_url, token, (width, height))
                    install_observer(page)
                    page.locator("#mobileTextInputBtn").click(timeout=5000)
                    page.wait_for_function(
                        """() => Boolean(document.body.classList.contains('mobile-input-visible')
                          && !document.getElementById('mobileInputDock')?.hidden)""",
                        timeout=5000,
                    )
                    boxes = {
                        "statusBar": box(page, "#statusBar"),
                        "viewerSurface": box(page, "#remoteVideo"),
                        "dock": box(page, "#chromeDocks"),
                        "mobileKeyboard": box(page, "#mobileInputDock"),
                        "fullscreen": box(page, "#fullscreenBtn"),
                    }
                    geometry_error = validate_geometry(boxes)
                    if geometry_error:
                        raise AcceptanceError(geometry_error)
                    state = assert_teardown(page, ())
                    artifact["viewports"].append({
                        "scenario": f"geometry-{width}x{height}",
                        "status": "PASS",
                        "actions": ["geometry-capture", "teardown-mouse-reset", "teardown-keyboard-reset"],
                        "boundingBoxes": boxes,
                        **{key: value for key, value in state.items() if key != "observations"},
                    })
                except Exception as error:  # noqa: BLE001
                    artifact["viewports"].append(artifact_entry(
                        f"geometry-{width}x{height}", "FAIL", safe_reason(error), actions=("geometry-capture",),
                    ))
                finally:
                    if context is not None:
                        context.close()
        finally:
            browser.close()

    unavailable = "NOT RUN: no physical device/browser was supplied to this offline harness"
    artifact["devices"] = [
        artifact_entry("android-chrome", "NOT RUN", unavailable),
        artifact_entry("iphone-safari", "NOT RUN", unavailable),
        artifact_entry("ipad-safari", "NOT RUN", unavailable),
    ]
    return artifact


def write_atomically(artifact, out_path):
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(artifact, ensure_ascii=True, indent=2, sort_keys=True) + "\n").encode("utf-8")
    with tempfile.NamedTemporaryFile(dir=out_path.parent, prefix=f".{out_path.name}.", delete=False) as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
        temporary = Path(handle.name)
    os.replace(temporary, out_path)
    digest = hashlib.sha256(out_path.read_bytes()).hexdigest()
    digest_path = out_path.with_suffix(out_path.suffix + ".sha256")
    digest_path.write_text(f"{digest}  {out_path.name}\n", encoding="ascii")
    return digest_path


def main(argv=None):
    args = parse_args(argv)
    base_url = validate_base_url(args.base_url)
    password = os.environ.get(args.password_env)
    if not password:
        raise SystemExit(f"{args.password_env} is required")
    out_path = Path(args.out)
    try:
        token = fetch_viewer_token(base_url, password)
        artifact = run_browser_acceptance(base_url, token, out_path)
    except AcceptanceError as error:
        artifact = {
            "scenarios": [artifact_entry("harness", "NOT RUN", safe_reason(error))],
            "viewports": [],
            "devices": [
                artifact_entry("android-chrome", "NOT RUN", "no physical device/browser was supplied to this offline harness"),
                artifact_entry("iphone-safari", "NOT RUN", "no physical device/browser was supplied to this offline harness"),
                artifact_entry("ipad-safari", "NOT RUN", "no physical device/browser was supplied to this offline harness"),
            ],
        }
    write_atomically(artifact, out_path)


if __name__ == "__main__":
    main()
