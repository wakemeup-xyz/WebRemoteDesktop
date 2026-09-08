#!/usr/bin/env python3
"""Run the strict, offline Viewer mobile-interaction acceptance suite.

The fixture is assembled from the checked-out Viewer HTML/CSS/JavaScript.  It
never opens an origin, reads credentials, starts a service, or writes payloads
to the result.  Only scenario names, boolean checks, safe counts, and compact
layout summaries are emitted.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable


REPO = Path(__file__).resolve().parents[1]
HTML_PATH = REPO / "web-client" / "viewer.html"
CSS_FILES = ("tokens.css", "viewer.css")
JS_FILES = (
    "input-geometry.js",
    "keyboard-transport.js",
    "remote-keyboard-controller.js",
    "mobile-text-input.js",
    "touch-input-adapter.js",
    "input.js",
    "chrome-layout.js",
    "ui.js",
)
TRACE_JS_FILES = (
    "input-trace.js",
    "diagnostic-core.js",
)
TERMINAL_JS_FILES = (
    "terminal-session-fsm.js",
    "terminal.js",
)

SCENARIO_NAMES = (
    "focus-continuity",
    "text-edit-transaction",
    "physical-keyup-release",
    "surface-confirmation-gate",
    "modal-context-change",
    "collapse-reopen-context",
    "virtual-modifier-release",
    "unsupported-viewport-continuity",
    "layout-matrix",
    "terminal-lifecycle",
    "fullscreen-native-containment",
    "fullscreen-fallback-focus",
    "recovery-layout",
    "retry-button",
    "trace-observability",
    "timeout-incident-eligibility",
    "deferred-incident-eligibility",
    "blocked-gate-incident",
    "release-ack-loss",
    "desktop-draft-entry",
    "browser-signal-ingestion",
    "draft-retention-exactness",
)

OFFLINE_NETWORK_STATS = {
    "requests": 0,
    "sensitivePayloads": 0,
}
SENSITIVE_REQUEST_MARKERS = re.compile(
    r"(?:password|token|secret|authorization|cookie|inputids|leaseid|payload)",
    re.IGNORECASE,
)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run local-source, offline-synthetic mobile Viewer acceptance."
    )
    parser.add_argument(
        "--out",
        required=True,
        help="JSON artifact path; only safe scenario summaries are written.",
    )
    parser.add_argument(
        "--browser",
        choices=("chromium", "webkit"),
        default="chromium",
        help="Playwright browser engine (default: chromium).",
    )
    return parser.parse_args(argv)


def write_json(path: str, value: dict[str, Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def result(
    name: str,
    status: str,
    *,
    checks: dict[str, bool] | None = None,
    counts: dict[str, int] | None = None,
    layout: dict[str, Any] | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "name": name,
        "status": status,
        "checks": checks or {},
        "counts": counts or {},
    }
    if layout:
        payload["layout"] = layout
    if reason:
        payload["reason"] = reason
    return payload


def not_run_results(reason: str) -> list[dict[str, Any]]:
    return [result(name, "NOT RUN", reason=reason) for name in SCENARIO_NAMES]


def strip_external_markup(html: str) -> str:
    # set_content receives only static DOM.  Every script/link in the original
    # page is removed so no runtime URL can be fetched by this harness.
    html = re.sub(r"<script\b[^>]*>.*?</script>", "", html, flags=re.IGNORECASE | re.DOTALL)
    return re.sub(r"<link\b[^>]*>", "", html, flags=re.IGNORECASE)


def source(relative: str) -> str:
    return (REPO / relative).read_text()


class OfflineFixture:
    """One isolated page with the real Input/controller/transport modules."""

    def __init__(
        self,
        browser: Any,
        *,
        width: int = 1024,
        height: int = 768,
        touch: bool = True,
        inset: int = 0,
        overlay: bool = False,
        offset_top: int = 0,
        safe_bottom: int = 0,
        show_mobile: bool = True,
        include_terminal: bool = False,
        include_diagnostics: bool = False,
    ) -> None:
        self.page = browser.new_page(
            viewport={"width": width, "height": height},
            has_touch=touch,
        )
        self.page.set_default_timeout(2500)
        self.page.set_default_navigation_timeout(2500)
        # This route is intentionally installed before set_content and remains
        # active for the lifetime of the page.
        def abort_offline_request(route: Any) -> None:
            try:
                request = route.request
                OFFLINE_NETWORK_STATS["requests"] += 1
                request_metadata = f"{request.url}\n{request.post_data or ''}"
                if SENSITIVE_REQUEST_MARKERS.search(request_metadata):
                    OFFLINE_NETWORK_STATS["sensitivePayloads"] += 1
            except Exception:
                # The request observer is diagnostic-only.  A malformed
                # request object must never prevent the deny-by-default route
                # from aborting the request.
                pass
            finally:
                route.abort()

        self.page.route("**/*", abort_offline_request)
        self.page.set_content(strip_external_markup(HTML_PATH.read_text()))
        for css_name in CSS_FILES:
            self.page.add_style_tag(content=source(f"web-client/css/{css_name}"))
        self.page.add_style_tag(
            content=(
                "* { transition: none !important; animation: none !important; }\n"
                f"#mobileSafeAreaProbe {{ padding-bottom: {max(0, safe_bottom)}px !important; }}"
            )
        )
        self.page.evaluate(
            """
            ({touch, inset, overlay, offsetTop}) => {
              const wire = [];
              const model = { value: [], cursor: 0, modifiers: new Set() };
              const scalarText = (value) => Array.from(String(value || ''));
              const insert = (value) => {
                const points = scalarText(value);
                model.value.splice(model.cursor, 0, ...points);
                model.cursor += points.length;
              };
              const applyStep = (step) => {
                if (!step || step.phase !== 'down') return;
                const code = String(step.code || '');
                if (/^(Control|Shift|Alt|Meta)(Left|Right)$/.test(code)) {
                  model.modifiers.add(code);
                  return;
                }
                if (code === 'ArrowLeft' && !step.modifiers?.shiftKey
                    && !step.modifiers?.ctrlKey && !step.modifiers?.altKey
                    && !step.modifiers?.metaKey) {
                  model.cursor = Math.max(0, model.cursor - 1);
                  return;
                }
                if (code === 'ArrowRight' && !step.modifiers?.shiftKey
                    && !step.modifiers?.ctrlKey && !step.modifiers?.altKey
                    && !step.modifiers?.metaKey) {
                  model.cursor = Math.min(model.value.length, model.cursor + 1);
                  return;
                }
                if (code === 'Backspace' && !step.modifiers?.shiftKey
                    && !step.modifiers?.ctrlKey && !step.modifiers?.altKey
                    && !step.modifiers?.metaKey) {
                  if (model.cursor > 0) {
                    model.value.splice(model.cursor - 1, 1);
                    model.cursor -= 1;
                  }
                  return;
                }
                if (/^Key[A-Z]$/.test(code)
                    && !step.modifiers?.ctrlKey && !step.modifiers?.altKey
                    && !step.modifiers?.metaKey) {
                  insert(step.modifiers?.shiftKey ? code.slice(-1) : code.slice(-1).toLowerCase());
                }
              };
              const applyPayload = (payload) => {
                if (!payload || payload.action === 'reset') return;
                if (payload.action === 'text') insert(payload.payload?.text);
                if (payload.action === 'key') applyStep(payload.payload);
                if (payload.action === 'batch') {
                  for (const step of payload.payload?.steps || []) {
                    applyStep(step);
                    if (step?.phase === 'up') model.modifiers.delete(step.code);
                  }
                }
                if (payload.action === 'key' && payload.payload?.phase === 'up') {
                  model.modifiers.delete(payload.payload.code);
                }
              };
              const acceptSend = (payload) => {
                if (!payload) return false;
                if (globalThis.__offlineFailNext === payload.action) {
                  globalThis.__offlineFailNext = null;
                  return false;
                }
                wire.push(payload);
                return true;
              };
              globalThis.__offlineWire = wire;
              globalThis.__offlineModel = model;
              globalThis.__offlineModelApply = applyPayload;
              globalThis.__offlineFailNext = null;
              globalThis.__offlineAckIndex = 0;
              globalThis.__offlineAckAll = (status = 'applied') => {
                const pending = wire.slice(globalThis.__offlineAckIndex);
                globalThis.__offlineAckIndex = wire.length;
                for (const payload of pending) {
                  const ids = Array.isArray(payload.inputIds) ? payload.inputIds : [];
                  if (!ids.length) continue;
                  const ack = {
                    schemaVersion: 2,
                    leaseId: payload.leaseId,
                    leaseEpoch: payload.leaseEpoch,
                    inputIds: ids,
                    inputType: payload.type,
                    status,
                    appliedSeq: Number.isSafeInteger(payload.seq) ? payload.seq : 0,
                  };
                  if (payload.type === 'keyboard') Input.acceptKeyboardAck(ack);
                  else Input.acceptMouseAck(ack);
                  if (status === 'applied') applyPayload(payload);
                }
                return pending.length;
              };
              globalThis.__offlineModelDigest = () => ({
                length: model.value.length,
                cursor: model.cursor,
                modifierCount: model.modifiers.size,
              });
              globalThis.__offlineSetKeyboardInset = (nextInset) => {
                const keyboard = navigator.virtualKeyboard;
                if (keyboard) keyboard.boundingRect = { height: Number(nextInset) || 0 };
                const vv = window.visualViewport;
                if (vv) vv.height = Math.max(0, innerHeight - (Number(nextInset) || 0) - (Number(vv.offsetTop) || 0));
                window.dispatchEvent(new Event('resize'));
                navigator.virtualKeyboard?.dispatchEvent?.(new Event('geometrychange'));
                ChromeLayout.recalculate();
              };
              const viewport = new EventTarget();
              viewport.height = Math.max(0, innerHeight - (Number(inset) || 0) - (Number(offsetTop) || 0));
              viewport.offsetTop = Number(offsetTop) || 0;
              Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
              if (overlay) {
                const keyboard = new EventTarget();
                keyboard.overlaysContent = true;
                keyboard.boundingRect = { height: Number(inset) || 0 };
                Object.defineProperty(navigator, 'virtualKeyboard', { value: keyboard, configurable: true });
              }
              Object.defineProperty(navigator, 'maxTouchPoints', { value: touch ? 1 : 0, configurable: true });
              Object.defineProperty(window, 'localStorage', {
                value: { getItem: () => null, setItem() {} },
                configurable: true,
              });
              Object.defineProperty(window, 'sessionStorage', {
                value: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
                configurable: true,
              });
              globalThis.WebRTC = {
                socket: {
                  connected: true,
                  emit(event, payload) { if (event === 'input') acceptSend(payload); },
                },
                inputChannel: { readyState: 'open' },
                sendInput(payload) { return acceptSend(payload); },
                canEnableDesktopInput: () => true,
                syncDesktopInputGate() {},
                getDesktopInputGateSnapshot: () => ({
                  enabled: true,
                  hasActiveControl: true,
                  manualDisconnect: false,
                  mediaState: 'active',
                  runtimePhase: 'active',
                  currentConnectionAttemptId: null,
                  mediaReadyConnectionAttemptId: null,
                  inputIsActive: true,
                  blockedReasons: [],
                }),
                getDesktopSessionSnapshot: () => ({ canInput: true }),
                getMediaActivitySnapshot: () => ({ reasons: [] }),
                setMediaActivityReason() {},
              };
              globalThis.LatencyMonitor = { recordInputSend() {} };
              globalThis.confirm = () => true;
              document.body.classList.add('stream-connected');
              document.getElementById('loading')?.classList.add('hidden');
              document.getElementById('relayImage')?.classList.add('hidden');
              const video = document.getElementById('remoteVideo');
              try {
                Object.defineProperty(video, 'videoWidth', { value: 1280, configurable: true });
                Object.defineProperty(video, 'videoHeight', { value: 720, configurable: true });
              } catch (_) {}
              // Synthetic touch events do not own a native pointer in the
              // browser, so Pointer Capture can throw before the adapter
              // enters PRESSED.  Wrap only touch fixtures: native mouse
              // capture still calls the browser implementation and is never
              // replaced with an unconditional no-op.
              if (touch) {
                for (const surface of [video, document.getElementById('relayImage')]) {
                  if (!surface) continue;
                  const nativeSet = surface.setPointerCapture?.bind(surface);
                  const nativeRelease = surface.releasePointerCapture?.bind(surface);
                  const nativeHas = surface.hasPointerCapture?.bind(surface);
                  surface.setPointerCapture = (pointerId) => {
                    try { return nativeSet?.(pointerId); } catch (_) { return undefined; }
                  };
                  surface.releasePointerCapture = (pointerId) => {
                    try { return nativeRelease?.(pointerId); } catch (_) { return undefined; }
                  };
                  surface.hasPointerCapture = (pointerId) => {
                    try { return nativeHas?.(pointerId) === true; } catch (_) { return false; }
                  };
                }
              }
            }
            """,
            {
                "touch": touch,
                "inset": inset,
                "overlay": overlay,
                "offsetTop": offset_top,
            },
        )
        if include_diagnostics:
            for js_name in TRACE_JS_FILES:
                self.page.add_script_tag(content=source(f"web-client/js/{js_name}"))
        for js_name in JS_FILES[:6]:
            self.page.add_script_tag(content=source(f"web-client/js/{js_name}"))
        if include_terminal:
            for js_name in TERMINAL_JS_FILES:
                self.page.add_script_tag(content=source(f"web-client/js/{js_name}"))
        for js_name in JS_FILES[6:]:
            self.page.add_script_tag(content=source(f"web-client/js/{js_name}"))
        self.page.evaluate(
            """
            () => {
              Input.init();
              Input.setControlLease({ leaseId: 'offline-mobile-interaction', leaseEpoch: 1 });
              Input.setActive(true);
              ChromeLayout.init();
              ChromeLayout.applyCapabilities({
                uiPhase: 'connected', streamReady: true, activeControl: true,
                transportReady: true,
              });
              UI.setupControlButtons();
            }
            """
        )
        if show_mobile and touch:
            self.show_mobile()

    def show_mobile(self) -> None:
        self.page.evaluate(
            """
            () => {
              const button = document.getElementById('mobileTextInputBtn');
              if (button) { button.hidden = false; button.disabled = false; }
              button?.click();
              if (Input.mobileTextInputAdapter && !Input.mobileTextInputAdapter.getSnapshot().shown) {
                Input.mobileTextInputAdapter.show();
                document.getElementById('mobileInputDock').hidden = false;
              }
              ChromeLayout.recalculate();
            }
            """
        )

    def settle(self, status: str = "applied") -> int:
        return int(self.page.evaluate("status => globalThis.__offlineAckAll(status)", status))

    def close(self) -> None:
        self.page.close()


def wait_frames(page: Any, count: int) -> None:
    page.evaluate(
        """
        async (frames) => {
          for (let index = 0; index < frames; index += 1) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
        }
        """,
        count,
    )


def set_mobile_text_visible(page: Any, visible: bool) -> None:
    """Use the production mobile-text toggle while fullscreen chrome is hidden."""
    current = bool(
        page.evaluate(
            "() => Input.mobileTextInputAdapter?.getSnapshot?.().shown === true"
        )
    )
    if current == visible:
        return
    page.evaluate(
        """
        (visible) => {
          const button = document.getElementById('mobileTextInputBtn');
          if (!button) return;
          button.hidden = false;
          button.disabled = false;
          button.click();
          if (visible && Input.mobileTextInputAdapter
              && !Input.mobileTextInputAdapter.getSnapshot().shown) {
            Input.mobileTextInputAdapter.show();
            document.getElementById('mobileInputDock').hidden = false;
          }
          ChromeLayout.recalculate();
        }
        """,
        visible,
    )
    wait_frames(page, 4)


def wire_counts(page: Any) -> dict[str, int]:
    return page.evaluate(
        """
        () => {
          const wire = globalThis.__offlineWire || [];
          const count = (predicate) => wire.filter(predicate).length;
          return {
            total: wire.length,
            keyboard: count((item) => item.type === 'keyboard'),
            keyboardText: count((item) => item.type === 'keyboard' && item.action === 'text'),
            keyboardKey: count((item) => item.type === 'keyboard' && item.action === 'key'),
            keyboardBatch: count((item) => item.type === 'keyboard' && item.action === 'batch'),
            keyboardReset: count((item) => item.type === 'keyboard' && item.action === 'reset'),
            mouseDown: count((item) => item.type === 'mouse' && item.action === 'down'),
            mouseMove: count((item) => item.type === 'mouse' && item.action === 'move'),
            mouseUp: count((item) => item.type === 'mouse' && item.action === 'up'),
            mouseWheel: count((item) => item.type === 'mouse' && item.action === 'wheel'),
            mouseReset: count((item) => item.type === 'mouse' && item.action === 'reset'),
          };
        }
        """
    )


def keyboard_key_phase_counts(page: Any, code: str) -> dict[str, int]:
    """Count one keyboard code's accepted down/up phases without exposing it."""
    return page.evaluate(
        """
        (code) => {
          const keys = (globalThis.__offlineWire || [])
            .filter((item) => item.type === 'keyboard' && item.action === 'key'
              && item.payload?.code === code);
          return {
            down: keys.filter((item) => item.payload?.phase === 'down').length,
            up: keys.filter((item) => item.payload?.phase === 'up').length,
          };
        }
        """,
        code,
    )


def safe_state(page: Any) -> dict[str, Any]:
    return page.evaluate(
        """
        () => {
          const state = Input.getDiagnosticState();
          const adapter = Input.mobileTextInputAdapter?.getSnapshot?.() || {};
          const surface = Input.getMobileSurfaceContextSnapshot?.() || {};
          return {
            activeElement: document.activeElement?.id || '',
            mobileShown: adapter.shown === true,
            mobilePending: adapter.hasPending === true,
            mobileUncertain: adapter.deliveryUncertain === true,
            mobileStatus: String(adapter.status || ''),
            surfaceState: String(surface.state || ''),
            surfaceGeneration: Number(surface.generation || 0),
            pressedKeys: Number(state.keyboard?.pressedCount || 0),
            virtualModifierCount: Number(Input.keyboardController?.getSnapshot?.().virtualModifiers?.length || 0),
            pressedMouse: Number(state.pressedMouseButtonCount || 0),
            pendingMouseReset: Boolean(state.pendingMouseReset),
          };
        }
        """
    )


def dispatch_mobile_input(page: Any, value: str) -> None:
    page.evaluate(
        """
        (value) => {
          const input = document.getElementById('mobileTextInput');
          input.value = `${value}\u200b`;
          input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        }
        """,
        value,
    )


def dispatch_composition_mobile_input(page: Any, value: str) -> None:
    """Drive one non-empty composition transaction through the real adapter."""
    page.locator('#mobileTextInput').dispatch_event('compositionstart', {"bubbles": True})
    page.evaluate(
        """
        (value) => {
          const input = document.getElementById('mobileTextInput');
          input.value = `${value}\u200b`;
          input.dispatchEvent(new CompositionEvent('compositionupdate', {
            bubbles: true, data: value,
          }));
          input.dispatchEvent(new InputEvent('input', {
            bubbles: true, inputType: 'insertCompositionText', data: value,
          }));
        }
        """,
        value,
    )


def dispatch_pending_mobile_draft(page: Any, suffix: str = "pending") -> None:
    """Append a local draft at the adapter's current remote cursor.

    The production diff is intentionally anchored to the accepted prefix and
    cursor.  Replacing the whole textarea with unrelated text is correctly
    rejected as an ambiguous edit, so a pending-gate fixture must model the
    actual user operation: preserve the accepted prefix and append a draft.
    """
    page.evaluate(
        """
        (suffix) => {
          const input = document.getElementById('mobileTextInput');
          const content = input.value.replaceAll('\u200b', '');
          input.value = `${content}${suffix}\u200b`;
          input.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: suffix,
          }));
        }
        """,
        suffix,
    )


def ingest_browser_diagnostic(page: Any) -> dict[str, Any]:
    """Send one real fixture snapshot through the Signal redaction boundary."""
    payload = page.evaluate(
        """
        () => ({
          schemaVersion: 2,
          connectionAttemptId: WebRTC.currentConnectionAttemptId || null,
          inputState: Input.getDiagnosticState(),
          inputTrace: Diagnostic.getInputTraceSnapshot(),
        })
        """
    )
    node_program = r"""
const fs = require('fs');
const { ingestDiagnosticPayload } = require('./signal-server/lib/diagnostic');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(input);
  const result = ingestDiagnosticPayload({
    role: 'viewer',
    viewerId: 'offline-browser-ingestion',
    data: payload,
    config: { enableDiagPersist: false },
    logger: { log() {}, info() {}, warn() {}, error() {} },
  });
  const report = result.report || {};
  const trace = report.inputTrace || {};
  const events = Array.isArray(trace.events) ? trace.events : [];
  const inputState = report.inputState;
  const inputStateShape = inputState !== null && typeof inputState === 'object'
    && !Array.isArray(inputState)
    && inputState.effectiveGate !== null
    && typeof inputState.effectiveGate === 'object'
    && !Array.isArray(inputState.effectiveGate)
    && inputState.surface !== null
    && typeof inputState.surface === 'object'
    && !Array.isArray(inputState.surface)
    && inputState.draft !== null
    && typeof inputState.draft === 'object'
    && !Array.isArray(inputState.draft)
    && inputState.recovery !== null
    && typeof inputState.recovery === 'object'
    && !Array.isArray(inputState.recovery);
  const inputTraceShape = report.inputTrace !== null
    && typeof report.inputTrace === 'object'
    && !Array.isArray(report.inputTrace)
    && Array.isArray(report.inputTrace.events)
    && report.inputTrace.counters !== null
    && typeof report.inputTrace.counters === 'object'
    && !Array.isArray(report.inputTrace.counters);
  const expectedSends = (payload.inputTrace?.events || []).filter((event) => (
    event && event.stage === 'transport-send' && event.accepted === true
  ));
  const actualSends = events.filter((event) => (
    event && event.stage === 'transport-send' && event.accepted === true
  ));
  const sendFields = [
    'eventId', 'inputType', 'action', 'transport', 'seq', 'leaseEpoch',
    'connectionAttemptId', 'inputIdHash', 'inputIdCount',
  ];
  const sendCorrelationPreserved = expectedSends.length === actualSends.length
    && expectedSends.every((expected, index) => sendFields.every((field) => (
      (actualSends[index][field] ?? null) === (expected[field] ?? null)
    )));
  const hashesSafe = events.every((event) => (
    !Object.prototype.hasOwnProperty.call(event, 'inputIdHash')
      || event.inputIdHash === null
      || /^[0-9a-f]{16}$/.test(event.inputIdHash)
  ));
  const reasonsSafe = events.every((event) => (
    !Object.prototype.hasOwnProperty.call(event, 'reason')
      || event.reason === null
      || (typeof event.reason === 'string' && event.reason.length <= 64)
  ));
  const summary = result.summaryEvent?.meta || {};
  const sourceGateAllowed = payload.inputState?.effectiveGate?.allowed;
  const sourceRecoveryState = payload.inputState?.recovery?.state;
  const sourceSurfaceState = payload.inputState?.surface?.state;
  process.stdout.write(JSON.stringify({
    accepted: result.accepted === true,
    attemptPreserved: result.connectionAttemptId === payload.connectionAttemptId,
    inputStateRetained: inputStateShape,
    inputTraceRetained: inputTraceShape,
    gatePreserved: inputStateShape && inputState.effectiveGate.allowed === sourceGateAllowed,
    recoveryPreserved: inputStateShape && inputState.recovery.state === sourceRecoveryState,
    surfacePreserved: inputStateShape && inputState.surface.state === sourceSurfaceState,
    summaryGatePresent: summary.inputGate !== null
      && typeof summary.inputGate === 'object'
      && summary.inputGate.allowed === sourceGateAllowed,
    summaryTracePresent: summary.inputTrace !== null
      && typeof summary.inputTrace === 'object'
      && Number.isSafeInteger(summary.inputTrace.droppedEvents),
    sendCorrelationPreserved,
    acceptedSendCount: actualSends.length,
    expectedSendCount: expectedSends.length,
    hashesSafe,
    reasonsSafe,
    eventCount: events.length,
    droppedEvents: Number.isSafeInteger(trace.counters?.droppedEvents)
      ? trace.counters.droppedEvents : 0,
    persisted: summary.persisted === true,
  }));
});
"""
    completed = subprocess.run(
        ["node", "-e", node_program],
        cwd=REPO,
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError("diagnostic ingestion helper failed")
    try:
        parsed = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("diagnostic ingestion helper returned invalid summary") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError("diagnostic ingestion helper returned non-object summary")
    return parsed


def scenario_focus(browser: Any) -> dict[str, Any]:
    fixture = OfflineFixture(browser, width=768, height=1024, touch=True)
    page = fixture.page
    try:
        page.locator('#mobileTextInput').dispatch_event('compositionstart', {"bubbles": True})
        frame_probe = page.evaluate(
            """
            async () => {
              const focusFrames = [];
              const compositionFrames = [];
              for (let index = 0; index < 120; index += 1) {
                Input.setActive(true);
                focusFrames.push(document.activeElement?.id === 'mobileTextInput');
                compositionFrames.push(Input.mobileTextInputAdapter?.getSnapshot?.().composing === true);
                await new Promise((resolve) => requestAnimationFrame(resolve));
              }
              return {
                frameCount: focusFrames.length,
                focusEveryFrame: focusFrames.every(Boolean),
                compositionEveryFrame: compositionFrames.every(Boolean),
                finalFocus: document.activeElement?.id === 'mobileTextInput',
              };
            }
            """
        )
        page.locator('#mobileTextInput').dispatch_event('compositionend', {"bubbles": True})
        page.locator('[data-mobile-action="left"]').click()
        navigation_count = fixture.settle()
        checks = page.evaluate(
            """
            () => ({
              focusStaysOnMobileInput: document.activeElement?.id === 'mobileTextInput',
              dockRemainsInDocument: document.documentElement.contains(document.getElementById('mobileInputDock')),
              mobileDockShown: Input.mobileTextInputAdapter?.getSnapshot?.().shown === true,
              compositionEndedForNavigation: Input.mobileTextInputAdapter?.getSnapshot?.().composing === false,
            })
            """
        )
        checks.update({
            "oneHundredTwentyFramesObserved": frame_probe["frameCount"] == 120,
            "focusEveryGateFrame": frame_probe["focusEveryFrame"] and frame_probe["finalFocus"],
            "compositionEveryGateFrame": frame_probe["compositionEveryFrame"],
            "navigationAfterCompositionAccepted": navigation_count == 1,
        })
        return result("focus-continuity", "PASS" if all(checks.values()) else "FAIL", checks=checks)
    finally:
        fixture.close()


def scenario_text_transaction(browser: Any) -> dict[str, Any]:
    fixture = OfflineFixture(browser, width=768, height=1024, touch=True)
    page = fixture.page
    try:
        # Start the same transaction with a non-empty composition.  The
        # adapter must retain the composing DOM value and focus through every
        # real animation frame, without putting composition text on the wire.
        dispatch_composition_mobile_input(page, "abcdefghijklmnopqrst")
        before_composition_end = wire_counts(page)
        composition_probe = page.evaluate(
            """
            async () => {
              const input = document.getElementById('mobileTextInput');
              const focusFrames = [];
              const compositionFrames = [];
              const nonEmptyFrames = [];
              for (let index = 0; index < 120; index += 1) {
                Input.setActive(true);
                focusFrames.push(document.activeElement?.id === 'mobileTextInput');
                compositionFrames.push(Input.mobileTextInputAdapter?.getSnapshot?.().composing === true);
                nonEmptyFrames.push(input.value.replaceAll('\\u200b', '').length > 0);
                await new Promise((resolve) => requestAnimationFrame(resolve));
              }
              return {
                frameCount: focusFrames.length,
                focusEveryFrame: focusFrames.every(Boolean),
                compositionEveryFrame: compositionFrames.every(Boolean),
                nonEmptyEveryFrame: nonEmptyFrames.every(Boolean),
                finalFocus: document.activeElement?.id === 'mobileTextInput',
                recoveryNoticeHidden: document.getElementById('inputRecoveryNotice')?.hidden === true,
                recoveryDraftEntryHidden: document.getElementById('inputRecoveryDraftBtn')?.hidden === true,
              };
            }
            """
        )
        after_composition_frames = wire_counts(page)
        page.locator('#mobileTextInput').dispatch_event('compositionend', {"bubbles": True})
        first_count = fixture.settle()
        page.locator('[data-mobile-action="left"]').click()
        navigation_count = fixture.settle()
        # Continue editing at the cursor established by the toolbar action.
        page.evaluate(
            """
            () => {
              const input = document.getElementById('mobileTextInput');
              const points = Array.from(input.value.replace(/\u200b/g, ''));
              points.splice(Math.max(0, points.length - 1), 0, 'z');
              input.value = `${points.join('')}\u200b`;
              input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'z' }));
            }
            """
        )
        continued_count = fixture.settle()
        page.locator('[data-mobile-action="right"]').click()
        end_navigation_count = fixture.settle()
        # Fail after two accepted deletion steps.  The adapter must retain the
        # unsent suffix and only explicit retry may continue it.
        before_partial = wire_counts(page)
        page.evaluate(
            """
            () => {
              const controller = Input.keyboardController;
              const original = controller.sendChord.bind(controller);
              let attempts = 0;
              controller.sendChord = (chord) => {
                if (chord?.code === 'Backspace') {
                  attempts += 1;
                  if (attempts > 2) return false;
                }
                return original(chord);
              };
              globalThis.__offlineRestoreSendChord = () => { controller.sendChord = original; };
              const input = document.getElementById('mobileTextInput');
              input.value = '\u200b';
              input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
            }
            """
        )
        partial_state = safe_state(page)
        partial_counts = wire_counts(page)
        # Acknowledge only the accepted prefix before the explicit retry.
        fixture.settle()
        partial_model = page.evaluate(
            """
            () => {
              const expected = Array.from('abcdefghijklmnopqrs');
              const actual = globalThis.__offlineModel;
              return actual.cursor === expected.length
                && actual.value.length === expected.length
                && actual.value.every((value, index) => value === expected[index]);
            }
            """
        )
        page.evaluate("() => globalThis.__offlineRestoreSendChord?.()")
        retry_accepted = bool(page.evaluate("() => Input.mobileTextInputAdapter.retryPending()"))
        retry_count = fixture.settle()
        wait_frames(page, 2)
        after_retry = safe_state(page)
        retry_model = page.evaluate(
            "() => globalThis.__offlineModel.value.length === 0 && globalThis.__offlineModel.cursor === 0"
        )
        # Establish a real 20-scalar accepted baseline first.  Then the
        # textarea deletion emits exactly the first 16 Backspace batches in
        # the same synchronous transaction; reset in that same page task so
        # the scheduled four-step continuation cannot run before cancellation.
        dispatch_mobile_input(page, "abcdefghijklmnopqrst")
        baseline_count = fixture.settle()
        reset_probe = page.evaluate(
            """
            () => {
              const count = (action) => (globalThis.__offlineWire || [])
                .filter((item) => item.type === 'keyboard' && item.action === action).length;
              const input = document.getElementById('mobileTextInput');
              const beforeDeleteBatch = count('batch');
              input.value = '\u200b';
              input.dispatchEvent(new InputEvent('input', {
                bubbles: true, inputType: 'deleteContentBackward',
              }));
              const beforeReset = {
                keyboardBatch: count('batch'),
                keyboardText: count('text'),
              };
              const resetAccepted = Input.resetKeyboard('offline-reset-cancel');
              return {
                ...beforeReset,
                beforeDeleteBatch,
                afterResetBatch: count('batch'),
                afterResetText: count('text'),
                keyboardReset: count('reset'),
                resetAccepted: resetAccepted === true,
              };
            }
            """
        )
        fixture.settle()
        wait_frames(page, 2)
        after_reset = safe_state(page)
        after_reset_counts = wire_counts(page)
        checks = {
            "compositionFrameCount": composition_probe["frameCount"] == 120,
            "compositionFocusEveryFrame": composition_probe["focusEveryFrame"] and composition_probe["finalFocus"],
            "compositionEveryFrame": composition_probe["compositionEveryFrame"],
            "compositionNonEmptyEveryFrame": composition_probe["nonEmptyEveryFrame"],
            "normalCompositionDoesNotShowRecovery": composition_probe["recoveryNoticeHidden"]
                and composition_probe["recoveryDraftEntryHidden"],
            "compositionNoWireBeforeEnd": after_composition_frames["total"] == before_composition_end["total"],
            "initialDomInputAccepted": first_count == 1,
            "toolbarNavigationAccepted": navigation_count >= 1,
            "continuedDomInputAccepted": continued_count == 1,
            "cursorReturnedToEnd": end_navigation_count == 1,
            "partialFailureRetainsDraft": partial_state["mobilePending"] is True,
            "partialFailureStopsAtAcceptedPrefix": partial_counts["keyboardBatch"] - before_partial["keyboardBatch"] == 2,
            "partialRemoteModelMatchesAcceptedPrefix": bool(partial_model),
            "explicitRetryAccepted": (retry_accepted or retry_count >= 1) and retry_count >= 1,
            "retrySettlesDraft": not after_retry["mobilePending"],
            "retryRemoteModelMatchesExpected": bool(retry_model),
            "deletionBaselineAccepted": baseline_count == 1,
            "sixteenStepDeletionBatchSent": reset_probe["keyboardBatch"] - reset_probe["beforeDeleteBatch"] == 16,
            "resetAcceptedImmediately": reset_probe["resetAccepted"] and reset_probe["keyboardReset"] >= 1,
            "sixteenStepContinuationCancelled": reset_probe["afterResetBatch"] == reset_probe["keyboardBatch"]
                and after_reset_counts["keyboardBatch"] == reset_probe["keyboardBatch"],
            "resetRetainsDraftUncertainty": after_reset["mobilePending"]
                and after_reset["mobileUncertain"]
                and after_reset["mobileShown"],
            "resetDoesNotReemitCancelledText": after_reset_counts["keyboardText"] == reset_probe["keyboardText"],
        }
        counts = {
            "compositionFrames": composition_probe["frameCount"],
            "initialText": first_count,
            "toolbarNavigation": navigation_count,
            "continuedText": continued_count,
            "retryWrites": retry_count,
            "partialDeletionBatches": partial_counts["keyboardBatch"],
            "partialDeletionBatchDelta": partial_counts["keyboardBatch"] - before_partial["keyboardBatch"],
            "resetDeletionBatches": reset_probe["keyboardBatch"],
            "resetDeletionBatchDelta": reset_probe["keyboardBatch"] - reset_probe["beforeDeleteBatch"],
            "totalWrites": after_reset_counts["total"],
        }
        return result("text-edit-transaction", "PASS" if all(checks.values()) else "FAIL", checks=checks, counts=counts)
    finally:
        fixture.close()


def scenario_physical_keyup(browser: Any) -> dict[str, Any]:
    fixture = OfflineFixture(browser, width=768, height=1024, touch=True, show_mobile=False)
    page = fixture.page
    try:
        initial = page.evaluate(
            """
            () => ({
              mobileHidden: Input.mobileTextInputAdapter?.getSnapshot?.().shown !== true,
              activeElement: document.activeElement?.id || '',
            })
            """
        )
        page.locator('#remoteVideo').focus()
        desktop_focus = page.evaluate("() => document.activeElement?.id === 'remoteVideo'")
        down_before = keyboard_key_phase_counts(page, "ShiftLeft")
        page.keyboard.down('Shift')
        down_count = fixture.settle()
        down_after = keyboard_key_phase_counts(page, "ShiftLeft")
        down_state = safe_state(page)
        mobile_button_ready = page.locator('#mobileTextInputBtn').evaluate(
            "el => !el.hidden && !el.disabled"
        )
        page.locator('#mobileTextInputBtn').click()
        mobile_transition = page.evaluate(
            """
            () => ({
              mobileShown: Input.mobileTextInputAdapter?.getSnapshot?.().shown === true,
              activeElement: document.activeElement?.id || '',
            })
            """
        )
        page.keyboard.up('Shift')
        up_count = fixture.settle()
        up_after = keyboard_key_phase_counts(page, "ShiftLeft")
        state = safe_state(page)

        # Keep the textarea Shift+Arrow path separate from the desktop-to-mobile
        # transition above.  Native textarea modifier keydown is local-only;
        # ArrowLeft creates one balanced production chord, and its native
        # keyups must not create standalone releases for untracked keys.
        chord_seed_before = wire_counts(page)
        dispatch_mobile_input(page, "abc")
        chord_seed_writes = fixture.settle()
        chord_seed_after = wire_counts(page)
        chord_seed_state = safe_state(page)
        chord_before = wire_counts(page)
        chord_shift_before = keyboard_key_phase_counts(page, "ShiftLeft")
        chord_arrow_before = keyboard_key_phase_counts(page, "ArrowLeft")
        page.keyboard.down('Shift')
        page.keyboard.down('ArrowLeft')
        page.keyboard.up('ArrowLeft')
        page.keyboard.up('Shift')
        chord_writes = fixture.settle()
        chord_after = wire_counts(page)
        chord_shift_after = keyboard_key_phase_counts(page, "ShiftLeft")
        chord_arrow_after = keyboard_key_phase_counts(page, "ArrowLeft")
        chord_state = safe_state(page)
        chord_probe = page.evaluate(
            """
            (beforeBatch) => {
              const batches = (globalThis.__offlineWire || [])
                .filter((item) => item.type === 'keyboard' && item.action === 'batch');
              const branchBatches = batches.slice(beforeBatch);
              const steps = branchBatches.length === 1
                ? branchBatches[0]?.payload?.steps || [] : [];
              return {
                exactlyOneBatch: branchBatches.length === 1,
                balanced: steps.length === 4
                  && steps[0]?.code === 'ShiftLeft' && steps[0]?.phase === 'down'
                  && steps[1]?.code === 'ArrowLeft' && steps[1]?.phase === 'down'
                  && steps[2]?.code === 'ArrowLeft' && steps[2]?.phase === 'up'
                  && steps[3]?.code === 'ShiftLeft' && steps[3]?.phase === 'up',
                carriesShiftFlags: steps.length === 4 && steps.every((step) =>
                  step.modifiers?.shiftKey === true
                  && step.modifiers?.ctrlKey === false
                  && step.modifiers?.altKey === false
                  && step.modifiers?.metaKey === false),
              };
            }
            """,
            chord_before["keyboardBatch"],
        )
        post_chord_text_before = wire_counts(page)
        dispatch_mobile_input(page, "X")
        post_chord_text_writes = fixture.settle()
        post_chord_text_after = wire_counts(page)
        post_chord_state = safe_state(page)
        post_chord_model_nonempty = page.evaluate(
            "() => (globalThis.__offlineModel?.value?.length || 0) > 0"
        )
        counts = wire_counts(page)
        checks = {
            "startsOnDesktopSurface": bool(initial["mobileHidden"])
                and bool(desktop_focus) and initial["activeElement"] == "",
            "physicalModifierDownAccepted": down_count == 1
                and down_after["down"] - down_before["down"] == 1
                and down_state["pressedKeys"] == 1,
            "nativeMobileShowTransition": bool(mobile_button_ready)
                and bool(mobile_transition["mobileShown"])
                and mobile_transition["activeElement"] == "mobileTextInput",
            "trackedKeyupAccepted": up_count == 1
                and up_after["up"] - down_after["up"] == 1,
            "pressedTruthReleased": state["pressedKeys"] == 0,
            "exactlyOnePhysicalModifierDown": down_after["down"] == 1,
            "exactlyOnePhysicalModifierUp": up_after["up"] == 1,
            "mobileFocusPreserved": state["activeElement"] == "mobileTextInput",
            "textAfterTrackedReleaseAccepted": chord_seed_writes == 1
                and chord_seed_after["keyboardText"] - chord_seed_before["keyboardText"] == 1
                and chord_seed_state["mobilePending"] is False
                and chord_seed_state["activeElement"] == "mobileTextInput",
            "textareaChordHasOneAcceptedBatch": chord_writes == 1
                and chord_after["keyboardBatch"] - chord_before["keyboardBatch"] == 1
                and bool(chord_probe["exactlyOneBatch"]),
            "textareaChordIsBalancedWithFlags": bool(chord_probe["balanced"])
                and bool(chord_probe["carriesShiftFlags"]),
            "textareaChordHasNoStandaloneKeyWrites": chord_after["keyboardKey"]
                - chord_before["keyboardKey"] == 0,
            "textareaChordHasNoUntrackedKeyupRelease": chord_shift_after == chord_shift_before
                and chord_arrow_after == chord_arrow_before,
            "textareaChordLeavesPressedTruthReleased": chord_state["pressedKeys"] == 0,
            "textAfterTextareaChordAccepted": post_chord_text_writes == 1
                and post_chord_text_after["keyboardText"] - post_chord_text_before["keyboardText"] == 1
                and post_chord_model_nonempty
                and post_chord_state["mobilePending"] is False
                and post_chord_state["activeElement"] == "mobileTextInput",
        }
        return result(
            "physical-keyup-release",
            "PASS" if all(checks.values()) else "FAIL",
            checks=checks,
            counts={
                "writes": counts["total"],
                "keyboardKeys": counts["keyboardKey"],
                "shiftDown": up_after["down"],
                "shiftUp": up_after["up"],
                "textareaSeedWrites": chord_seed_writes,
                "textareaChordWrites": chord_writes,
                "textareaChordBatches": chord_after["keyboardBatch"] - chord_before["keyboardBatch"],
                "textareaChordStandaloneKeys": chord_after["keyboardKey"] - chord_before["keyboardKey"],
                "postChordTextWrites": post_chord_text_writes,
            },
        )
    finally:
        fixture.close()


def surface_point(page: Any) -> dict[str, float]:
    box = page.locator('.viewer-container').bounding_box()
    if not box:
        return {"x": 10.0, "y": 60.0}
    return {"x": box["x"] + max(8.0, box["width"] / 2), "y": box["y"] + max(8.0, box["height"] / 2)}


def scenario_surface_confirmation(browser: Any) -> dict[str, Any]:
    fixture = OfflineFixture(browser, width=1024, height=768, touch=True)
    page = fixture.page
    try:
        point = surface_point(page)
        page.mouse.move(point["x"], point["y"])
        page.mouse.down()
        pending = safe_state(page)
        page.mouse.up()
        up_before_ack = safe_state(page)
        # The draft is entered after the real pointerup but before the target
        # confirmation ACK.  This is the R10 ordering that proves text stays
        # local and is not accidentally coupled to pointer geometry.
        dispatch_mobile_input(page, "draft")
        draft_before_ack = safe_state(page)
        before_surface_ack = wire_counts(page)
        fixture.settle()
        settled = safe_state(page)
        after_surface_ack = wire_counts(page)
        retry_accepted = bool(page.evaluate("() => Input.mobileTextInputAdapter.retryPending()"))
        retry_count = fixture.settle()
        wait_frames(page, 2)
        after_surface_retry = safe_state(page)
        after_surface_retry_counts = wire_counts(page)

        # A real mouse drag crosses multiple animation frames.  Capture the
        # native rect before down and compare it after the pending interval;
        # the down payload must use the independently supplied start point,
        # while move payloads are allowed to advance from it.
        drag_point = surface_point(page)
        page.evaluate(
            """
            () => {
              const rect = document.getElementById('remoteVideo').getBoundingClientRect();
              globalThis.__offlineDragRect = {
                left: rect.left, top: rect.top, width: rect.width, height: rect.height,
              };
            }
            """
        )
        drag_before = wire_counts(page)
        page.mouse.move(drag_point["x"], drag_point["y"])
        page.mouse.down()
        wait_frames(page, 5)
        page.mouse.move(drag_point["x"] + 20, drag_point["y"])
        wait_frames(page, 5)
        page.mouse.move(drag_point["x"] + 40, drag_point["y"] + 4)
        wait_frames(page, 2)
        drag_mid = safe_state(page)
        drag_geometry_stable = page.evaluate(
            """
            () => {
              const before = globalThis.__offlineDragRect;
              const rect = document.getElementById('remoteVideo').getBoundingClientRect();
              return ['left', 'top', 'width', 'height'].every((key) =>
                Math.abs(Number(rect[key]) - Number(before?.[key])) <= 1);
            }
            """
        )
        page.mouse.up()
        drag_before_ack = safe_state(page)
        fixture.settle()
        drag_after_ack = safe_state(page)
        drag_after = wire_counts(page)
        drag_payload_checks = page.evaluate(
            """
            ({x, y}) => {
              const video = document.getElementById('remoteVideo').getBoundingClientRect();
              const expectedX = (x - video.left) / Math.max(1, video.width);
              const expectedY = (y - video.top) / Math.max(1, video.height);
              const wire = globalThis.__offlineWire || [];
              const downs = wire.filter((item) => item.type === 'mouse' && item.action === 'down');
              const moves = wire.filter((item) => item.type === 'mouse' && item.action === 'move');
              const down = downs.at(-1)?.payload;
              const firstMove = moves.at(-1)?.payload;
              return {
                startPointPreserved: Boolean(down)
                  && Math.abs(Number(down.relX) - expectedX) <= 0.03
                  && Math.abs(Number(down.relY) - expectedY) <= 0.03,
                moveAdvancesFromStart: Boolean(down && firstMove)
                  && (Math.abs(Number(firstMove.relX) - Number(down.relX)) > 0.001
                    || Math.abs(Number(firstMove.relY) - Number(down.relY)) > 0.001),
              };
            }
            """,
            drag_point,
        )

        # Deliberately mutate the rendered surface during a second accepted
        # gesture.  The browser resize changes the actual video rect; the next
        # pointer move must issue one safety reset, suppress the stale move/up,
        # and require the production discard path before a fresh pointer works.
        geometry_before_rect = page.evaluate(
            """
            () => {
              const rect = document.getElementById('remoteVideo').getBoundingClientRect();
              return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
            }
            """
        )
        geometry_before = wire_counts(page)
        geometry_point = surface_point(page)
        page.mouse.move(geometry_point['x'], geometry_point['y'])
        page.mouse.down()
        geometry_down = safe_state(page)
        page.set_viewport_size({"width": 900, "height": 768})
        wait_frames(page, 2)
        geometry_after_rect_changed = page.evaluate(
            """
            (before) => {
              const rect = document.getElementById('remoteVideo').getBoundingClientRect();
              return ['left', 'top', 'width', 'height'].some((key) =>
                Math.abs(Number(rect[key]) - Number(before[key])) > 1);
            }
            """,
            geometry_before_rect,
        )
        geometry_before_move = wire_counts(page)
        geometry_move_point = surface_point(page)
        page.mouse.move(geometry_move_point['x'] + 18, geometry_move_point['y'])
        wait_frames(page, 2)
        geometry_after_move = wire_counts(page)
        geometry_reset_state = safe_state(page)
        page.mouse.up()
        geometry_after_stale_up = wire_counts(page)
        fixture.settle()
        geometry_after_reset_ack = safe_state(page)
        geometry_discard_visible = page.locator('#mobileInputDiscardBtn').evaluate(
            "el => !el.hidden && !el.disabled"
        )
        page.locator('#mobileInputDiscardBtn').click()
        geometry_recovered = safe_state(page)
        fresh_point = surface_point(page)
        fresh_before = wire_counts(page)
        page.mouse.move(fresh_point['x'], fresh_point['y'])
        page.mouse.down()
        fresh_down = safe_state(page)
        page.mouse.up()
        fixture.settle()
        fresh_after = safe_state(page)
        fresh_after_counts = wire_counts(page)

        # Two touch pointers switch to the production scrolling state without
        # fabricating another mouse down.  Re-read the post-resize surface only
        # after a settled layout frame; never reuse the pre-resize drag point.
        wait_frames(page, 2)
        two_point = surface_point(page)
        two_before = wire_counts(page)
        dispatch_touch(page, 'pointerdown', 40, two_point['x'], two_point['y'], 1)
        dispatch_touch(page, 'pointerdown', 41, two_point['x'] + 20, two_point['y'], 1, is_primary=False)
        dispatch_touch(page, 'pointermove', 41, two_point['x'] + 36, two_point['y'] + 12, 1, is_primary=False)
        wait_frames(page, 2)
        dispatch_touch(page, 'pointerup', 41, two_point['x'] + 36, two_point['y'] + 12, 0, is_primary=False)
        dispatch_touch(page, 'pointerup', 40, two_point['x'], two_point['y'], 0)
        fixture.settle()
        two_after = wire_counts(page)

        # Start one more accepted gesture and draft, then replace the lease
        # before ACK.  Lease reset must consume the old context and never replay
        # either the pointer or local draft under the new identity.
        page.mouse.move(drag_point['x'], drag_point['y'])
        page.mouse.down()
        page.mouse.up()
        dispatch_mobile_input(page, "lease")
        lease_before = wire_counts(page)
        page.evaluate(
            "() => Input.setControlLease({ leaseId: 'offline-surface-lease-cancel', leaseEpoch: 4 })"
        )
        wait_frames(page, 3)
        lease_after = wire_counts(page)
        lease_state = safe_state(page)

        # A failed target confirmation enters uncertain and keeps subsequent
        # text local.  A fresh lease is used solely to isolate the timeout
        # branch from the failed branch; this is not a production re-acquire.
        page.evaluate("() => Input.setControlLease({ leaseId: 'offline-surface-failure', leaseEpoch: 5 })")
        fixture.show_mobile()
        page.mouse.move(point['x'], point['y'])
        page.mouse.down()
        failure_before_text = wire_counts(page)
        fixture.settle('execution-failed')
        failure_state = safe_state(page)
        page.evaluate("() => Input.resetKeyboard('surface-keyboard-reset')")
        fixture.settle()
        after_keyboard_reset = safe_state(page)
        dispatch_mobile_input(page, "g")
        failure_after_text = wire_counts(page)
        page.mouse.up()
        fixture.settle()

        page.evaluate("() => Input.setControlLease({ leaseId: 'offline-surface-timeout', leaseEpoch: 6 })")
        fixture.show_mobile()
        page.mouse.move(point['x'], point['y'])
        page.mouse.down()
        page.wait_for_timeout(3100)
        timeout_state = safe_state(page)
        timeout_before_late_ack = wire_counts(page)
        fixture.settle()
        timeout_after_late_ack = safe_state(page)
        timeout_after_late_ack_counts = wire_counts(page)
        checks = {
            "mouseDownEntersPending": pending["surfaceState"] == "pending",
            "draftRetainedBeforeTargetAck": draft_before_ack["surfaceState"] == "pending"
                and draft_before_ack["mobilePending"] is True,
            "textNotSentBeforeTargetAck": before_surface_ack["keyboardText"] == 0,
            "upKeepsConfirmationPending": up_before_ack["surfaceState"] == "pending",
            "downUpAckSettlesSurface": settled["surfaceState"] == "settled",
            "surfaceHasNoPressedButton": settled["pressedMouse"] == 0,
            "targetAckDoesNotAutoReplayDraft": after_surface_ack["keyboardText"] == before_surface_ack["keyboardText"],
            "explicitRetrySendsExactlyOnce": retry_accepted and retry_count == 1
                and after_surface_retry["mobilePending"] is False
                and after_surface_retry_counts["keyboardText"] - after_surface_ack["keyboardText"] == 1,
            "dragCrossFrameStaysGeometryStable": bool(drag_geometry_stable),
            "dragEndsWithPendingUp": drag_mid["surfaceState"] == "pending"
                and drag_before_ack["surfaceState"] == "pending",
            "dragAckSettlesSurface": drag_after_ack["surfaceState"] == "settled",
            "dragHasOneDownAndUp": drag_after["mouseDown"] - drag_before["mouseDown"] == 1
                and drag_after["mouseUp"] - drag_before["mouseUp"] == 1,
            "dragStartPointPreserved": bool(drag_payload_checks["startPointPreserved"]),
            "dragMoveUsesCurrentPoint": bool(drag_payload_checks["moveAdvancesFromStart"]),
            "geometryMutationChangesRenderedRect": bool(geometry_after_rect_changed),
            "geometryMutationStartsAcceptedGesture": geometry_down["surfaceState"] == "pending",
            "geometryMutationIssuesExactlyOneReset": geometry_after_move["mouseReset"]
                - geometry_before["mouseReset"] == 1,
            "geometryMutationKeepsExactlyOneResetThroughStaleUp": geometry_after_stale_up["mouseReset"]
                - geometry_before["mouseReset"] == 1,
            "geometryMutationSuppressesStaleMove": geometry_after_move["mouseMove"]
                == geometry_before_move["mouseMove"],
            "geometryMutationSuppressesStaleUp": geometry_after_stale_up["mouseUp"]
                == geometry_after_move["mouseUp"],
            "geometryResetAckClearsPressedState": geometry_after_reset_ack["pendingMouseReset"] is False
                and geometry_after_reset_ack["pressedMouse"] == 0,
            "geometryResetUsesNativeDiscardRecovery": geometry_reset_state["mobileUncertain"] is True
                and geometry_after_reset_ack["surfaceState"] == "uncertain"
                and geometry_discard_visible,
            "geometryRecoveryClearsSurfaceUncertainty": geometry_recovered["surfaceState"] == "settled"
                and geometry_recovered["mobileUncertain"] is False
                and geometry_recovered["mobilePending"] is False,
            "freshPointerWorksAfterGeometryRecovery": fresh_down["surfaceState"] == "pending"
                and fresh_after["surfaceState"] == "settled"
                and fresh_after_counts["mouseDown"] - fresh_before["mouseDown"] == 1
                and fresh_after_counts["mouseUp"] - fresh_before["mouseUp"] == 1
                and fresh_after_counts["mouseReset"] - fresh_before["mouseReset"] == 0,
            "secondFingerSwitchesToScroll": two_after["mouseDown"] - two_before["mouseDown"] == 0
                and two_after["mouseWheel"] - two_before["mouseWheel"] >= 1,
            "leaseChangeClearsDraftAndDoesNotReplay": lease_state["mobilePending"] is False
                and lease_state["mobileShown"] is False
                and lease_after["keyboardText"] == lease_before["keyboardText"],
            "failedDownEntersUncertain": failure_state["surfaceState"] == "uncertain",
            "keyboardResetAckDoesNotClearSurfaceUncertainty": after_keyboard_reset["surfaceState"] == "uncertain"
                and after_keyboard_reset["mobileUncertain"] is True,
            "failedTargetBlocksText": failure_after_text["keyboardText"] == failure_before_text["keyboardText"],
            "confirmationTimeoutEntersUncertain": timeout_state["surfaceState"] == "uncertain",
            "lateAckCannotUnlock": timeout_after_late_ack["surfaceState"] == "uncertain",
        }
        counts = wire_counts(page)
        checks["oneMouseDownAndUp"] = after_surface_retry_counts["mouseDown"] == 1 and after_surface_retry_counts["mouseUp"] == 1
        checks["timeoutCreatedNoExtraReset"] = timeout_after_late_ack_counts["mouseReset"] == timeout_before_late_ack["mouseReset"]
        return result("surface-confirmation-gate", "PASS" if all(checks.values()) else "FAIL", checks=checks, counts={"mouseDown": counts["mouseDown"], "mouseUp": counts["mouseUp"], "keyboardText": counts["keyboardText"]})
    finally:
        fixture.close()


def scenario_modal(browser: Any) -> dict[str, Any]:
    fixture = OfflineFixture(browser, width=768, height=1024, touch=True)
    page = fixture.page
    try:
        dispatch_mobile_input(page, "abc")
        initial_writes = fixture.settle()
        page.locator('#textInputBtn').click()
        opened = page.locator('#textInputModal').evaluate("el => !el.hidden && !el.classList.contains('hidden')")
        page.locator('#remoteTextInput').fill('X')
        accepted_before = wire_counts(page)
        page.locator('#textInputSubmitBtn').click()
        submit_writes = fixture.settle()
        after_submit = safe_state(page)
        accepted_after = wire_counts(page)
        modal_closed = page.locator('#textInputModal').evaluate("el => el.hidden")
        after_submit_model_matches = page.evaluate(
            """
            () => {
              const expected = Array.from('abcX');
              const actual = globalThis.__offlineModel;
              return actual.cursor === expected.length
                && actual.value.length === expected.length
                && actual.value.every((value, index) => value === expected[index]);
            }
            """
        )
        after_submit_history = page.evaluate(
            """
            () => {
              const input = document.getElementById('mobileTextInput');
              const adapter = Input.mobileTextInputAdapter?.getSnapshot?.() || {};
              return {
                acceptedBufferReset: input?.value === '\u200b'
                  && input.selectionStart === 0 && input.selectionEnd === 0,
                mobileFocusRestored: document.activeElement?.id === 'mobileTextInput',
                mobileHistoryIdle: adapter.shown === true && adapter.hasPending !== true,
              };
            }
            """
        )

        # A later mobile navigation must be a fresh context transaction after
        # the modal write, then a new mobile character must use that same
        # remote model without inheriting the old textarea cursor.
        page.locator('[data-mobile-action="left"]').click()
        navigation_writes = fixture.settle()
        after_navigation_model_matches = page.evaluate(
            """
            () => {
              const expected = Array.from('abcX');
              const actual = globalThis.__offlineModel;
              return actual.cursor === 3
                && actual.value.length === expected.length
                && actual.value.every((value, index) => value === expected[index]);
            }
            """
        )
        dispatch_mobile_input(page, "Y")
        follow_up_writes = fixture.settle()
        after_follow_up_model_matches = page.evaluate(
            """
            () => {
              const expected = Array.from('abcYX');
              const actual = globalThis.__offlineModel;
              return actual.cursor === 4
                && actual.value.length === expected.length
                && actual.value.every((value, index) => value === expected[index]);
            }
            """
        )

        # A pending mobile draft blocks opening the external modal and must not
        # be sent by that blocked attempt.  The draft is then explicitly
        # discarded so each subsequent branch starts from a known context.
        page.evaluate("() => Input.mobileTextInputAdapter.discardPending()")
        page.evaluate(
            """
            () => {
              const controller = Input.keyboardController;
              globalThis.__offlineOriginalSendText = controller.sendText.bind(controller);
              controller.sendText = () => false;
            }
            """
        )
        dispatch_pending_mobile_draft(page, "pending")
        pending_state = safe_state(page)
        pending_before = wire_counts(page)
        page.locator('#textInputBtn').click()
        pending_modal_open = page.locator('#textInputModal').evaluate(
            "el => !el.hidden && !el.classList.contains('hidden')"
        )
        pending_after = wire_counts(page)
        page.evaluate(
            """
            () => {
              Input.keyboardController.sendText = globalThis.__offlineOriginalSendText;
              Input.mobileTextInputAdapter.discardPending();
            }
            """
        )

        # Seed a non-empty accepted mobile history for the failure/cancel
        # branch.  Keep the comparison in page memory so neither the draft nor
        # model content can enter the safe artifact.
        dispatch_mobile_input(page, "retain")
        baseline_seed_writes = fixture.settle()
        failure_baseline = page.evaluate(
            """
            () => {
              const input = document.getElementById('mobileTextInput');
              const model = globalThis.__offlineModel;
              const content = input.value.replaceAll('\u200b', '');
              globalThis.__offlineModalFailureBaseline = {
                inputValue: input.value,
                selectionStart: input.selectionStart,
                selectionEnd: input.selectionEnd,
                modelValue: [...model.value],
                modelCursor: model.cursor,
              };
              return {
                nonEmpty: content.length > 0,
                cursorAtEnd: input.selectionStart === content.length
                  && input.selectionEnd === content.length,
              };
            }
            """
        )

        # An accepted modal submission is a transaction; a failed one keeps
        # the modal and its local value, while cancel only closes it.
        page.locator('#textInputBtn').click()
        page.locator('#remoteTextInput').fill('retry')
        page.evaluate(
            """
            () => {
              const controller = Input.keyboardController;
              globalThis.__offlineOriginalSendText = controller.sendText.bind(controller);
              controller.sendText = () => false;
            }
            """
        )
        failure_before = wire_counts(page)
        page.locator('#textInputSubmitBtn').click()
        failure_settle_writes = fixture.settle()
        failed_open = page.locator('#textInputModal').evaluate(
            "el => !el.hidden && !el.classList.contains('hidden')"
        )
        failed_value_retained = page.locator('#remoteTextInput').evaluate(
            "el => String(el.value || '').length > 0"
        )
        failure_after = wire_counts(page)
        failure_preservation = page.evaluate(
            """
            () => {
              const input = document.getElementById('mobileTextInput');
              const model = globalThis.__offlineModel;
              const baseline = globalThis.__offlineModalFailureBaseline;
              return {
                mobileHistoryPreserved: input.value === baseline?.inputValue
                  && input.selectionStart === baseline?.selectionStart
                  && input.selectionEnd === baseline?.selectionEnd,
                remoteModelUnchanged: model.cursor === baseline?.modelCursor
                  && model.value.length === baseline?.modelValue?.length
                  && model.value.every((value, index) => value === baseline?.modelValue?.[index]),
              };
            }
            """
        )
        page.locator('#textInputCancelBtn').click()
        cancel_after = wire_counts(page)
        after_cancel = safe_state(page)
        modal_closed_after_cancel = page.locator('#textInputModal').evaluate("el => el.hidden")
        cancel_preservation = page.evaluate(
            """
            () => {
              const input = document.getElementById('mobileTextInput');
              const model = globalThis.__offlineModel;
              const baseline = globalThis.__offlineModalFailureBaseline;
              return {
                mobileHistoryPreserved: input.value === baseline?.inputValue
                  && input.selectionStart === baseline?.selectionStart
                  && input.selectionEnd === baseline?.selectionEnd,
                remoteModelUnchanged: model.cursor === baseline?.modelCursor
                  && model.value.length === baseline?.modelValue?.length
                  && model.value.every((value, index) => value === baseline?.modelValue?.[index]),
              };
            }
            """
        )
        page.evaluate("() => { Input.keyboardController.sendText = globalThis.__offlineOriginalSendText; }")

        # The remote input's compositionend listener and the submit click share
        # one commit path.  Reopening and clicking with the cleared value must
        # not duplicate the accepted composition write.
        page.locator('#textInputBtn').click()
        page.locator('#remoteTextInput').fill('compose')
        composition_before = wire_counts(page)
        page.locator('#remoteTextInput').dispatch_event('compositionend', {"bubbles": True})
        composition_commit_writes = fixture.settle()
        composition_closed = page.locator('#textInputModal').evaluate("el => el.hidden")
        page.locator('#textInputBtn').click()
        page.locator('#textInputSubmitBtn').click()
        composition_click_writes = fixture.settle()
        composition_after = wire_counts(page)

        checks = {
            "modalOpensFromMobileContext": bool(opened),
            "initialMobileWriteAccepted": initial_writes == 1,
            "acceptedSubmitClearsMobileHistory": bool(after_submit_history["acceptedBufferReset"]),
            "acceptedSubmitRestoresMobileFocus": bool(after_submit_history["mobileFocusRestored"]),
            "acceptedSubmitLeavesMobileHistoryIdle": bool(after_submit_history["mobileHistoryIdle"]),
            "acceptedSubmitClosesModal": bool(modal_closed),
            "acceptedSubmitProducedExactlyOneWrite": submit_writes == 1
                and accepted_after["keyboardText"] - accepted_before["keyboardText"] == 1,
            "remoteModelAfterAcceptedModal": bool(after_submit_model_matches),
            "mobileNavigationAfterModalAcceptedOnce": navigation_writes == 1,
            "remoteModelAfterMobileNavigation": bool(after_navigation_model_matches),
            "mobileFollowUpAfterModalAcceptedOnce": follow_up_writes == 1,
            "remoteModelAfterMobileFollowUp": bool(after_follow_up_model_matches),
            "pendingDraftBlocksModalOpen": pending_state["mobilePending"] is True
                and not pending_modal_open
                and pending_after["keyboardText"] == pending_before["keyboardText"],
            "failedSubmitRetainsModal": bool(failed_open),
            "failedSubmitRetainsValue": bool(failed_value_retained),
            "failureBranchStartsWithAcceptedMobileHistory": bool(failure_baseline["nonEmpty"])
                and bool(failure_baseline["cursorAtEnd"]) and baseline_seed_writes == 1,
            "failedSubmitPreservesMobileHistory": bool(failure_preservation["mobileHistoryPreserved"])
                and bool(failure_preservation["remoteModelUnchanged"]),
            "failedSubmitProducesNoWrite": failure_settle_writes == 0
                and failure_after["keyboardText"] == failure_before["keyboardText"],
            "cancelClosesModalWithoutWrite": bool(modal_closed_after_cancel)
                and cancel_after["keyboardText"] == failure_after["keyboardText"],
            "cancelPreservesMobileHistory": bool(cancel_preservation["mobileHistoryPreserved"])
                and bool(cancel_preservation["remoteModelUnchanged"]),
            "cancelDoesNotCreateRecoveryState": not after_cancel["mobileUncertain"],
            "compositionendCommitsExactlyOnce": composition_commit_writes == 1
                and composition_after["keyboardText"] - composition_before["keyboardText"] == 1,
            "compositionendThenSubmitDoesNotDuplicate": composition_closed
                and composition_click_writes == 0
                and composition_after["keyboardText"] - composition_before["keyboardText"] == 1,
        }
        return result(
            "modal-context-change",
            "PASS" if all(checks.values()) else "FAIL",
            checks=checks,
            counts={
                "initialWrites": initial_writes,
                "submitWrites": submit_writes,
                "navigationWrites": navigation_writes,
                "followUpWrites": follow_up_writes,
                "baselineSeedWrites": baseline_seed_writes,
                "failureWrites": failure_settle_writes,
                "cancelWrites": cancel_after["keyboardText"] - failure_after["keyboardText"],
                "compositionWrites": composition_after["keyboardText"] - composition_before["keyboardText"],
            },
        )
    finally:
        fixture.close()


def scenario_collapse_reopen(browser: Any) -> dict[str, Any]:
    fixture = OfflineFixture(browser, width=768, height=1024, touch=True)
    page = fixture.page
    try:
        dispatch_mobile_input(page, "abc")
        initial = fixture.settle()
        page.locator('#mobileTextInputBtn').click()
        hidden = safe_state(page)
        page.evaluate(
            """
            () => document.body.dispatchEvent(new KeyboardEvent('keydown', {
              bubbles: true, code: 'ArrowLeft', key: 'ArrowLeft',
            }))
            """
        )
        nav = fixture.settle()
        page.evaluate(
            """
            () => document.body.dispatchEvent(new KeyboardEvent('keyup', {
              bubbles: true, code: 'ArrowLeft', key: 'ArrowLeft',
            }))
            """
        )
        fixture.settle()
        page.evaluate(
            """
            () => document.body.dispatchEvent(new KeyboardEvent('keydown', {
              bubbles: true, code: 'KeyA', key: 'a',
            }))
            """
        )
        printable = fixture.settle()
        page.evaluate(
            """
            () => document.body.dispatchEvent(new KeyboardEvent('keyup', {
              bubbles: true, code: 'KeyA', key: 'a',
            }))
            """
        )
        fixture.settle()
        page.locator('#mobileTextInputBtn').click()
        dispatch_mobile_input(page, "fresh")
        reopened = fixture.settle()
        state = safe_state(page)
        digest = page.evaluate(
            """
            () => {
              // This expected sequence is deliberately independent of the
              // fixture's applyPayload implementation: abc, left, a at the
              // middle cursor, then fresh at that resulting cursor.
              const expected = Array.from('abafreshc');
              const actual = globalThis.__offlineModel;
              return {
                finiteCursor: actual.cursor <= actual.value.length,
                modelMatchesExpected: actual.cursor === 8
                  && actual.value.length === expected.length
                  && actual.value.every((value, index) => value === expected[index]),
              };
            }
            """
        )
        checks = {
            "initialTextAccepted": initial == 1,
            "collapseHidesMobileInput": hidden["mobileShown"] is False,
            "entityNavigationAccepted": nav == 1,
            "entityPrintableAccepted": printable == 1,
            "reopenDoesNotReplayOldText": reopened == 1,
            "newBaselineSettled": not state["mobilePending"],
            "remoteModelHasFiniteCursor": bool(digest["finiteCursor"]),
            "remoteModelMatchesIndependentEditSequence": bool(digest["modelMatchesExpected"]),
        }
        return result("collapse-reopen-context", "PASS" if all(checks.values()) else "FAIL", checks=checks, counts={"initialText": initial, "navigation": nav, "printable": printable, "reopenedText": reopened})
    finally:
        fixture.close()


def scenario_virtual_modifier(browser: Any) -> dict[str, Any]:
    fixture = OfflineFixture(browser, width=375, height=812, touch=True)
    page = fixture.page
    try:
        dispatch_mobile_input(page, "abc")
        initial_text = fixture.settle()
        modifier = page.locator('[data-mobile-modifier="shift"]')

        def native_shift_click() -> dict[str, Any]:
            before = wire_counts(page)
            before_phase = keyboard_key_phase_counts(page, "ShiftLeft")
            modifier.click()
            writes = fixture.settle()
            after = wire_counts(page)
            after_phase = keyboard_key_phase_counts(page, "ShiftLeft")
            return {
                "before": before,
                "after": after,
                "beforePhase": before_phase,
                "afterPhase": after_phase,
                "writes": writes,
                "keyboardDelta": after["keyboard"] - before["keyboard"],
                "state": safe_state(page),
                "ariaPressed": modifier.get_attribute("aria-pressed") == "true",
                "renderedAndEnabled": modifier.evaluate("el => !el.hidden && !el.disabled"),
            }

        shift_on = native_shift_click()
        page.locator('[data-mobile-action="left"]').click()
        chord = fixture.settle()
        after_chord = safe_state(page)
        chord_payload = page.evaluate(
            """
            () => {
              const batches = (globalThis.__offlineWire || [])
                .filter((item) => item.type === 'keyboard' && item.action === 'batch');
              const steps = batches.at(-1)?.payload?.steps || [];
              const model = globalThis.__offlineModel;
              return {
                carriesShiftFlags: steps.length === 2
                  && steps.every((step) => step.modifiers?.shiftKey === true),
                noSyntheticModifierStep: steps.every((step) => step.code !== 'ShiftLeft'),
                remoteCursorUnchangedByModifiedNavigation: model.cursor === 3 && model.value.length === 3,
              };
            }
            """
        )
        # Native locator click is the production capability path for OFF.
        shift_off = native_shift_click()
        dispatch_mobile_input(page, "z")
        context_text = fixture.settle()
        context_model = page.evaluate(
            """
            () => {
              const expected = Array.from('abcz');
              const actual = globalThis.__offlineModel;
              return actual.cursor === expected.length
                && actual.value.length === expected.length
                && actual.value.every((value, index) => value === expected[index]);
            }
            """
        )

        # Each local editing gate first locks Shift through the real native
        # capability-rendered button, then proves native OFF is still reachable
        # while the gate is active.  A second native click proves a new ON is
        # blocked after release; no button state is manually toggled.
        composition_on = native_shift_click()
        page.locator('#mobileTextInput').dispatch_event('compositionstart', {"bubbles": True})
        composition_state = safe_state(page)
        composition_off = native_shift_click()
        composition_blocked_before = wire_counts(page)
        modifier.click()
        composition_blocked_after = wire_counts(page)
        composition_blocked_state = safe_state(page)
        page.locator('#mobileTextInput').dispatch_event('compositionend', {"bubbles": True})
        fixture.settle()

        pending_on = native_shift_click()
        pending_point = surface_point(page)
        dispatch_touch(page, 'pointerdown', 70, pending_point['x'], pending_point['y'], 1)
        dispatch_touch(page, 'pointermove', 70, pending_point['x'] + 20, pending_point['y'], 1)
        wait_frames(page, 2)
        pending_surface_state = safe_state(page)
        dispatch_pending_mobile_draft(page)
        pending_state = safe_state(page)
        pending_off = native_shift_click()
        pending_blocked_before = wire_counts(page)
        modifier.click()
        pending_blocked_after = wire_counts(page)
        pending_blocked_state = safe_state(page)
        dispatch_touch(page, 'pointerup', 70, pending_point['x'], pending_point['y'], 0)
        fixture.settle()
        pending_discard_visible = page.locator('#mobileInputDiscardBtn').evaluate(
            "el => !el.hidden && !el.disabled"
        )
        page.locator('#mobileInputDiscardBtn').click()
        pending_cleanup_state = safe_state(page)

        uncertain_on = native_shift_click()
        page.evaluate("() => Input.mobileTextInputAdapter.onTransportState('reacquire-required')")
        uncertain_state = safe_state(page)
        uncertain_off = native_shift_click()
        uncertain_blocked_before = wire_counts(page)
        modifier.click()
        uncertain_blocked_after = wire_counts(page)
        uncertain_blocked_state = safe_state(page)

        # Re-arm only after the gate checks; this is a fixture lease transition
        # and must not turn any blocked click into a replayed modifier write.
        page.evaluate(
            "() => Input.setControlLease({ leaseId: 'offline-virtual-recover', leaseEpoch: 2 })"
        )
        fixture.show_mobile()
        counts = wire_counts(page)
        checks = {
            "initialTextAccepted": initial_text == 1,
            "virtualShiftOnAccepted": shift_on["writes"] == 1
                and shift_on["afterPhase"]["down"] - shift_on["beforePhase"]["down"] == 1,
            "virtualShiftPressedTruth": shift_on["state"]["virtualModifierCount"] == 1
                and shift_on["ariaPressed"] and shift_on["renderedAndEnabled"],
            "navigationChordAccepted": chord == 1,
            "chordKeepsVirtualShift": after_chord["virtualModifierCount"] == 1,
            "chordCarriesModifierFlags": bool(chord_payload["carriesShiftFlags"]),
            "chordHasNoSyntheticModifierStep": bool(chord_payload["noSyntheticModifierStep"]),
            "modifiedNavigationKeepsRemoteCursor": bool(chord_payload["remoteCursorUnchangedByModifiedNavigation"]),
            "offButtonRenderedAndEnabled": shift_off["renderedAndEnabled"],
            "virtualShiftOffAccepted": shift_off["keyboardDelta"] == 1,
            "virtualShiftReleasedExactlyOnce": shift_off["state"]["virtualModifierCount"] == 0
                and not shift_off["ariaPressed"]
                and shift_off["afterPhase"]["up"] - shift_off["beforePhase"]["up"] == 1,
            "noPressedKeysRemain": shift_off["state"]["pressedKeys"] == 0,
            "postChordTextUsesFreshModelBaseline": context_text == 1 and bool(context_model),
            "compositionGateLatchesBeforeOff": composition_on["state"]["virtualModifierCount"] == 1
                and composition_on["ariaPressed"] and composition_on["renderedAndEnabled"],
            "compositionGateBlocksNewModifierOn": composition_state["mobileStatus"] == "composing"
                and composition_blocked_after["keyboard"] == composition_blocked_before["keyboard"]
                and composition_blocked_state["virtualModifierCount"] == 0,
            "compositionGateReleasesExactlyOnce": composition_off["keyboardDelta"] == 1
                and composition_off["state"]["virtualModifierCount"] == 0
                and not composition_off["ariaPressed"]
                and composition_off["afterPhase"]["up"] - composition_off["beforePhase"]["up"] == 1,
            "pendingGateCreatesLocalDraft": pending_surface_state["surfaceState"] == "pending"
                and pending_state["mobilePending"] is True,
            "pendingGateLatchesBeforeOff": pending_on["state"]["virtualModifierCount"] == 1
                and pending_on["ariaPressed"] and pending_on["renderedAndEnabled"],
            "pendingGateBlocksNewModifierOn": pending_blocked_after["keyboard"] == pending_blocked_before["keyboard"]
                and pending_blocked_state["virtualModifierCount"] == 0,
            "pendingGateReleasesExactlyOnce": pending_off["keyboardDelta"] == 1
                and pending_off["state"]["virtualModifierCount"] == 0
                and not pending_off["ariaPressed"]
                and pending_off["afterPhase"]["up"] - pending_off["beforePhase"]["up"] == 1,
            "pendingGateUsesNativeDiscardCleanup": pending_discard_visible
                and pending_cleanup_state["surfaceState"] == "settled"
                and not pending_cleanup_state["mobilePending"],
            "uncertainGateLatchesBeforeOff": uncertain_on["state"]["virtualModifierCount"] == 1
                and uncertain_on["ariaPressed"] and uncertain_on["renderedAndEnabled"],
            "uncertainGateBlocksNewModifierOn": uncertain_state["mobileUncertain"] is True
                and uncertain_blocked_after["keyboard"] == uncertain_blocked_before["keyboard"]
                and uncertain_blocked_state["virtualModifierCount"] == 0,
            "uncertainGateReleasesExactlyOnce": uncertain_off["keyboardDelta"] == 1
                and uncertain_off["state"]["virtualModifierCount"] == 0
                and not uncertain_off["ariaPressed"]
                and uncertain_off["afterPhase"]["up"] - uncertain_off["beforePhase"]["up"] == 1,
        }
        return result(
            "virtual-modifier-release",
            "PASS" if all(checks.values()) else "FAIL",
            checks=checks,
            counts={
                "keyboardWrites": counts["keyboard"],
                "keyboardBatches": counts["keyboardBatch"],
                "compositionOffWrites": composition_off["keyboardDelta"],
                "pendingOffWrites": pending_off["keyboardDelta"],
                "uncertainOffWrites": uncertain_off["keyboardDelta"],
            },
        )
    finally:
        fixture.close()


def dispatch_touch(
    page: Any,
    kind: str,
    pointer_id: int,
    x: float,
    y: float,
    buttons: int,
    *,
    is_primary: bool = True,
) -> None:
    page.evaluate(
        """
        ({kind, pointerId, x, y, buttons, isPrimary}) => {
          const video = document.getElementById('remoteVideo');
          video.dispatchEvent(new PointerEvent(kind, {
            bubbles: true, cancelable: true, pointerType: 'touch', isPrimary,
            pointerId, clientX: x, clientY: y, buttons, button: 0,
          }));
        }
        """,
        {
            "kind": kind,
            "pointerId": pointer_id,
            "x": x,
            "y": y,
            "buttons": buttons,
            "isPrimary": is_primary,
        },
    )


def scenario_unsupported(browser: Any) -> dict[str, Any]:
    fixture = OfflineFixture(browser, width=568, height=320, touch=True, inset=160, overlay=True, safe_bottom=0)
    page = fixture.page
    try:
        point = surface_point(page)
        dispatch_touch(page, 'pointerdown', 31, point['x'], point['y'], 1)
        wait_frames(page, 5)
        dispatch_touch(page, 'pointermove', 31, point['x'] + 20, point['y'], 1)
        wait_frames(page, 5)
        dispatch_touch(page, 'pointermove', 31, point['x'] + 40, point['y'] + 4, 1)
        wait_frames(page, 2)
        accepted_before_gate = wire_counts(page)
        page.evaluate("() => Input.setViewportInputSupported(false)")
        dispatch_touch(page, 'pointermove', 31, point['x'] + 50, point['y'] + 8, 1)
        dispatch_touch(page, 'pointerup', 31, point['x'] + 50, point['y'] + 8, 0)
        fixture.settle()
        continued = wire_counts(page)
        touch_drag_payload = page.evaluate(
            """
            ({x, y}) => {
              const video = document.getElementById('remoteVideo').getBoundingClientRect();
              const expectedX = (x - video.left) / Math.max(1, video.width);
              const expectedY = (y - video.top) / Math.max(1, video.height);
              const wire = globalThis.__offlineWire || [];
              const down = wire.find((item) => item.type === 'mouse' && item.action === 'down')?.payload;
              const move = wire.find((item) => item.type === 'mouse' && item.action === 'move')?.payload;
              return {
                startPointPreserved: Boolean(down)
                  && Math.abs(Number(down.relX) - expectedX) <= 0.03
                  && Math.abs(Number(down.relY) - expectedY) <= 0.03,
                moveAdvancesFromStart: Boolean(down && move)
                  && (Math.abs(Number(move.relX) - Number(down.relX)) > 0.001
                    || Math.abs(Number(move.relY) - Number(down.relY)) > 0.001),
              };
            }
            """,
            point,
        )
        page.evaluate("() => Input.mobileTextInputAdapter.discardPending()")
        page.evaluate("() => Input.setViewportInputSupported(false)")
        before_new = wire_counts(page)
        dispatch_touch(page, 'pointerdown', 32, point['x'], point['y'], 1)
        dispatch_mobile_input(page, 'h')
        after_new = wire_counts(page)
        unsupported_state = page.evaluate(
            """
            () => ({
              hintVisible: (() => {
                const el = document.getElementById('mobileInputStatus');
                const style = getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return !el.hidden && style.display !== 'none' && rect.width > 0 && rect.height > 0;
              })(),
              statusTextPresent: document.getElementById('mobileInputStatus')?.textContent.length > 0,
            })
            """
        )
        page.evaluate("() => Input.setViewportInputSupported(true)")
        after_restore_before_retry = wire_counts(page)
        retry = bool(page.evaluate("() => Input.mobileTextInputAdapter.retryPending()"))
        retry_count = fixture.settle()

        # A supported two-finger gesture enters scrolling without creating a
        # new target-confirmation down.  This branch uses the same synthetic
        # touch event adapter as the preceding drag; native mouse capture is
        # exercised separately by the surface scenario.
        page.evaluate("() => Input.setViewportInputSupported(true)")
        two_before = wire_counts(page)
        dispatch_touch(page, 'pointerdown', 43, point['x'], point['y'], 1)
        # Ultra-compact video may be letterboxed to a narrow 16:9 media box;
        # keep the second pointer inside that real hit region.
        dispatch_touch(page, 'pointerdown', 44, point['x'] + 2, point['y'], 1, is_primary=False)
        dispatch_touch(page, 'pointermove', 44, point['x'] + 8, point['y'] + 4, 1, is_primary=False)
        wait_frames(page, 2)
        dispatch_touch(page, 'pointerup', 44, point['x'] + 8, point['y'] + 4, 0, is_primary=False)
        dispatch_touch(page, 'pointerup', 43, point['x'], point['y'], 0)
        fixture.settle()
        two_after = wire_counts(page)

        # Leave an accepted touch tap and a local draft unacknowledged, then
        # change lease identity.  The lease reset must consume both contexts
        # without replaying the draft under the replacement lease.
        dispatch_touch(page, 'pointerdown', 45, point['x'], point['y'], 1)
        dispatch_touch(page, 'pointerup', 45, point['x'], point['y'], 0)
        dispatch_mobile_input(page, "lease")
        lease_before = wire_counts(page)
        lease_draft = safe_state(page)
        page.evaluate(
            "() => Input.setControlLease({ leaseId: 'offline-unsupported-lease', leaseEpoch: 7 })"
        )
        wait_frames(page, 3)
        lease_after = wire_counts(page)
        lease_state = safe_state(page)
        checks = {
            "acceptedGestureDownExists": accepted_before_gate["mouseDown"] == 1,
            "acceptedGestureMoveContinuesUnsupported": continued["mouseMove"] >= 1,
            "acceptedGestureUpContinuesUnsupported": continued["mouseUp"] == 1,
            "noSyntheticResetForGateOnly": continued["mouseReset"] == 0,
            "touchDragStartPointPreserved": bool(touch_drag_payload["startPointPreserved"]),
            "touchDragMoveUsesCurrentPoint": bool(touch_drag_payload["moveAdvancesFromStart"]),
            "newGestureRejectedUnsupported": after_new["mouseDown"] == before_new["mouseDown"],
            "draftRetainedWithoutAutoSend": after_restore_before_retry["keyboardText"] == after_new["keyboardText"],
            "explicitRetrySendsOnce": retry and retry_count == 1,
            "secondFingerUsesScrollWithoutDown": two_after["mouseDown"] - two_before["mouseDown"] == 0
                and two_after["mouseWheel"] - two_before["mouseWheel"] >= 1,
            "leaseCancelRetainsNoDraftOrReplay": lease_draft["mobilePending"] is True
                and lease_state["mobilePending"] is False
                and lease_state["mobileShown"] is False
                and lease_after["keyboardText"] == lease_before["keyboardText"],
            "unsupportedHintVisible": unsupported_state["hintVisible"] and unsupported_state["statusTextPresent"],
        }
        return result("unsupported-viewport-continuity", "PASS" if all(checks.values()) else "FAIL", checks=checks, counts={"acceptedMouseMoves": continued["mouseMove"], "touchWheel": two_after["mouseWheel"] - two_before["mouseWheel"], "retryWrites": retry_count})
    finally:
        fixture.close()


def scenario_recovery_layout(browser: Any) -> dict[str, Any]:
    """Exercise blur recovery and fresh input on desktop, phone, and root fullscreen."""
    viewports = (
        ("desktop", 1440, 900, False, False),
        ("phone", 390, 844, True, False),
        ("tablet-fullscreen", 1024, 768, True, True),
    )
    checks: dict[str, bool] = {}
    fresh_counts = {"mouseDown": 0, "mouseUp": 0, "keyboardKeys": 0}
    for name, width, height, touch, fullscreen in viewports:
        fixture = OfflineFixture(
            browser,
            width=width,
            height=height,
            touch=touch,
            show_mobile=False,
            include_diagnostics=True,
        )
        page = fixture.page
        try:
            page.evaluate(
                "() => { WebRTC.currentConnectionAttemptId = 'offline-recovery-layout'; }"
            )
            fixture.settle()
            if fullscreen:
                enter_native_fullscreen(page)
                fixture.settle()

            point = surface_point(page)
            page.mouse.click(point["x"], point["y"])
            page.evaluate("() => window.dispatchEvent(new Event('blur'))")
            fixture.settle()
            page.evaluate("() => window.dispatchEvent(new Event('focus'))")
            waiting = page.evaluate(
                """
                () => {
                  const notice = document.getElementById('inputRecoveryNotice');
                  const text = document.getElementById('inputRecoveryNoticeText');
                  const rect = notice?.getBoundingClientRect();
                  const status = document.getElementById('statusBar');
                  const docks = document.getElementById('chromeDocks');
                  const hidden = (element) => {
                    const style = element ? getComputedStyle(element) : null;
                    return style?.visibility === 'hidden' && style?.pointerEvents === 'none';
                  };
                  const recovery = Input.getEffectiveInputGate().recovery;
                  return {
                    waiting: recovery.state === 'waiting',
                    visible: Boolean(notice && !notice.hidden),
                    readable: Boolean(text && text.textContent.trim().length > 0),
                    withinViewport: Boolean(rect && rect.width > 0 && rect.height > 0
                      && rect.left >= 0 && rect.top >= 0
                      && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1),
                    rootFullscreen: document.fullscreenElement === document.documentElement,
                    statusHidden: hidden(status),
                    docksHidden: hidden(docks),
                  };
                }
                """
            )
            fixture.settle()
            before_new = wire_counts(page)
            point = surface_point(page)
            page.mouse.click(point["x"], point["y"])
            fixture.settle()
            page.keyboard.press("a")
            fixture.settle()
            after_new = wire_counts(page)
            recovered = page.evaluate(
                """
                () => ({
                  allowed: Input.getEffectiveInputGate().allowed,
                  state: Input.getEffectiveInputGate().recovery.state,
                  noticeVisible: !document.getElementById('inputRecoveryNotice').hidden,
                })
                """
            )
            prefix = f"{name}-"
            checks.update(
                {
                    f"{prefix}recoveryWaitsForOwnedResets": waiting["waiting"],
                    f"{prefix}recoveryNoticeVisible": waiting["visible"],
                    f"{prefix}recoveryNoticeReadable": waiting["readable"],
                    f"{prefix}recoveryNoticeWithinViewport": waiting["withinViewport"],
                    f"{prefix}freshMouseDownAccepted": after_new["mouseDown"] - before_new["mouseDown"] == 1,
                    f"{prefix}freshMouseUpAccepted": after_new["mouseUp"] - before_new["mouseUp"] == 1,
                    f"{prefix}freshKeyboardDownUpAccepted": after_new["keyboardKey"] - before_new["keyboardKey"] == 2,
                    f"{prefix}recoveryClearsAfterFreshInput": recovered == {
                        "allowed": True,
                        "state": "recovered",
                        "noticeVisible": False,
                    },
                    f"{prefix}rootFullscreenTarget": not fullscreen or waiting["rootFullscreen"],
                    f"{prefix}statusChromeHiddenInRootFullscreen": not fullscreen or waiting["statusHidden"],
                    f"{prefix}docksHiddenInRootFullscreen": not fullscreen or waiting["docksHidden"],
                }
            )
            fresh_counts["mouseDown"] += after_new["mouseDown"] - before_new["mouseDown"]
            fresh_counts["mouseUp"] += after_new["mouseUp"] - before_new["mouseUp"]
            fresh_counts["keyboardKeys"] += after_new["keyboardKey"] - before_new["keyboardKey"]
        finally:
            fixture.close()
    return result(
        "recovery-layout",
        "PASS" if all(checks.values()) else "FAIL",
        checks=checks,
        counts={"viewports": len(viewports), **fresh_counts},
        layout={"desktop": "1440x900", "phone": "390x844", "rootFullscreen": "1024x768"},
    )


def scenario_retry_button(browser: Any) -> dict[str, Any]:
    """Use the real fixed retry button after a bounded failed recovery cycle."""
    fixture = OfflineFixture(
        browser,
        width=390,
        height=844,
        touch=True,
        show_mobile=False,
        include_diagnostics=True,
    )
    page = fixture.page
    try:
        page.evaluate(
            "() => { WebRTC.currentConnectionAttemptId = 'offline-retry-button'; }"
        )
        fixture.settle()
        point = surface_point(page)
        page.mouse.click(point["x"], point["y"])
        page.evaluate("() => window.dispatchEvent(new Event('blur'))")
        fixture.settle()
        page.evaluate("() => window.dispatchEvent(new Event('focus'))")
        # Only keyboard reset is acknowledged.  The real recovery deadline
        # must expose a failed cycle and the locator action must send both
        # owned resets exactly once.
        page.evaluate(
            """
            () => {
              for (const payload of __offlineWire.slice(__offlineAckIndex)
                .filter((item) => item.type === 'keyboard')) {
                Input.acceptKeyboardAck({
                  schemaVersion: 2,
                  inputType: 'keyboard',
                  inputIds: payload.inputIds,
                  leaseEpoch: payload.leaseEpoch,
                  appliedSeq: payload.seq,
                  status: 'applied',
                });
              }
            }
            """
        )
        page.wait_for_timeout(3200)
        before_retry = wire_counts(page)
        failed_state = page.evaluate("() => Input.getEffectiveInputGate().recovery.state")
        page.locator("#inputRecoveryRetryBtn").click()
        after_retry_click = wire_counts(page)
        waiting_state = page.evaluate("() => Input.getEffectiveInputGate().recovery.state")
        fixture.settle()
        before_new = wire_counts(page)
        point = surface_point(page)
        page.mouse.click(point["x"], point["y"])
        fixture.settle()
        page.keyboard.press("a")
        fixture.settle()
        after_new = wire_counts(page)
        checks = {
            "failedCycleIsVisible": failed_state == "failed",
            "retryReturnsToWaiting": waiting_state == "waiting",
            "retryEmitsExactlyTwoResets": after_retry_click["total"] - before_retry["total"] == 2,
            "retryEmitsOneMouseAndKeyboardReset": (
                after_retry_click["mouseReset"] - before_retry["mouseReset"] == 1
                and after_retry_click["keyboardReset"] - before_retry["keyboardReset"] == 1
            ),
            "retryDoesNotReplayOrdinaryInput": after_retry_click["mouseDown"] == before_retry["mouseDown"]
                and after_retry_click["mouseUp"] == before_retry["mouseUp"]
                and after_retry_click["keyboardKey"] == before_retry["keyboardKey"],
            "freshMouseDownAccepted": after_new["mouseDown"] - before_new["mouseDown"] == 1,
            "freshMouseUpAccepted": after_new["mouseUp"] - before_new["mouseUp"] == 1,
            "freshKeyboardDownUpAccepted": after_new["keyboardKey"] - before_new["keyboardKey"] == 2,
            "freshGateAllowed": page.evaluate("() => Input.getEffectiveInputGate().allowed") is True,
        }
        return result(
            "retry-button",
            "PASS" if all(checks.values()) else "FAIL",
            checks=checks,
            counts={
                "retryWrites": after_retry_click["total"] - before_retry["total"],
                "freshMouseDown": after_new["mouseDown"] - before_new["mouseDown"],
                "freshMouseUp": after_new["mouseUp"] - before_new["mouseUp"],
                "freshKeyboardKeys": after_new["keyboardKey"] - before_new["keyboardKey"],
            },
        )
    finally:
        fixture.close()


def scenario_trace_observability(browser: Any) -> dict[str, Any]:
    """Capture actual DOM sends and ACKs through the production trace core."""
    fixture = OfflineFixture(
        browser,
        width=1024,
        height=768,
        touch=False,
        show_mobile=False,
        include_diagnostics=True,
    )
    page = fixture.page
    try:
        page.evaluate(
            "() => { WebRTC.currentConnectionAttemptId = 'offline-trace-observability'; }"
        )
        fixture.settle()
        point = surface_point(page)
        page.mouse.click(point["x"], point["y"])
        fixture.settle()
        page.keyboard.press("a")
        fixture.settle()
        trace = page.evaluate(
            """
            () => {
              const snapshot = Diagnostic.getInputTraceSnapshot();
              const accepted = snapshot.events.filter((event) => (
                event.stage === 'transport-send' && event.accepted && event.action !== 'reset'
              ));
              const acks = snapshot.events.filter((event) => event.stage === 'ack' && event.accepted);
              const domSends = accepted.filter((event) => Number.isSafeInteger(event.eventId));
              const safeEvents = snapshot.events.every((event) => (
                !['code', 'key', 'keyCode', 'text', 'payload', 'inputIds', 'leaseId']
                  .some((field) => Object.prototype.hasOwnProperty.call(event, field))
              ));
              const safeHashes = accepted.every((event) => (
                !Object.prototype.hasOwnProperty.call(event, 'inputIdHash')
                  || event.inputIdHash === null
                  || /^[0-9a-f]{16}$/.test(event.inputIdHash)
              ));
              return {
                traceLoaded: typeof InputTrace?.create === 'function',
                exactLiveInput: Diagnostic._currentInput() === Input,
                schemaVersion: snapshot.schemaVersion,
                hasPointerDom: snapshot.events.some((event) => (
                  event.stage === 'dom-received' && event.inputType === 'pointer'
                )),
                hasKeyboardDom: snapshot.events.some((event) => (
                  event.stage === 'dom-received' && event.inputType === 'keyboard'
                )),
                acceptedPointerSends: accepted.filter((event) => event.inputType === 'pointer').length,
                acceptedKeyboardSends: accepted.filter((event) => (
                  event.inputType === 'keyboard' && event.action === 'key'
                )).length,
                allDomSendsHaveAssociatedAck: domSends.length === 4
                  && domSends.every((send) => acks.some((ack) => ack.eventId === send.eventId)),
                safeEvents,
                safeHashes,
                pendingAckCount: snapshot.counters.pendingAckCount,
                pendingHashCount: snapshot.counters.pendingHashCount,
                traceEventCount: snapshot.events.length,
              };
            }
            """
        )
        checks = {
            "traceCoreLoadedOnceThroughFixture": trace["traceLoaded"],
            "traceUsesRealInputBinding": trace["exactLiveInput"],
            "traceSchemaIsCurrent": trace["schemaVersion"] == 1,
            "pointerDomObserved": trace["hasPointerDom"],
            "keyboardDomObserved": trace["hasKeyboardDom"],
            "twoPointerWritesObserved": trace["acceptedPointerSends"] == 2,
            "twoKeyboardWritesObserved": trace["acceptedKeyboardSends"] == 2,
            "everyDomWriteHasAck": trace["allDomSendsHaveAssociatedAck"],
            "traceEventsAreAllowlisted": trace["safeEvents"],
            "traceHashesAreNullOrBounded": trace["safeHashes"],
            "traceHasNoPendingAcks": trace["pendingAckCount"] == 0,
            "traceHashWorkIsSettled": trace["pendingHashCount"] == 0,
        }
        return result(
            "trace-observability",
            "PASS" if all(checks.values()) else "FAIL",
            checks=checks,
            counts={
                "acceptedPointerSends": trace["acceptedPointerSends"],
                "acceptedKeyboardSends": trace["acceptedKeyboardSends"],
                "traceEvents": trace["traceEventCount"],
            },
        )
    finally:
        fixture.close()


def scenario_timeout_incident_eligibility(browser: Any) -> dict[str, Any]:
    """Ensure real physical, touch, and IME writes leave timeout evidence."""
    outcomes: list[dict[str, int | bool]] = []
    expected = {
        "physical": {"writes": 2, "ackTimeouts": 2},
        "touch": {"writes": 2, "ackTimeouts": 2},
        "ime": {"writes": 1, "ackTimeouts": 1},
    }
    for kind in ("physical", "touch", "ime"):
        fixture = OfflineFixture(
            browser,
            touch=kind != "physical",
            show_mobile=kind == "ime",
            include_diagnostics=True,
        )
        page = fixture.page
        try:
            page.evaluate(
                "() => { WebRTC.currentConnectionAttemptId = 'offline-timeout-incident'; }"
            )
            fixture.settle()
            if kind == "ime":
                dispatch_composition_mobile_input(page, "offline-timeout")
                page.locator("#mobileTextInput").dispatch_event("compositionend", {"bubbles": True})
            elif kind == "touch":
                point = surface_point(page)
                page.touchscreen.tap(point["x"], point["y"])
            else:
                page.locator("#remoteVideo").focus()
                page.keyboard.press("a")
            page.wait_for_timeout(3200)
            outcome = page.evaluate(
                """
                () => {
                  const trace = Diagnostic.getInputTraceSnapshot();
                  const writes = trace.events.filter((event) => (
                    event.stage === 'transport-send' && event.accepted && event.action !== 'reset'
                  ));
                  return {
                    writes: writes.length,
                    ackTimeouts: trace.counters.ackTimeoutCount,
                    incidents: Diagnostic._pendingInputIncidents.length,
                    allWritesHaveEventId: writes.every((event) => Number.isSafeInteger(event.eventId)),
                    hasTimeoutIncident: Diagnostic._pendingInputIncidents.some((item) => (
                      item.reason === 'input-ack-timeout'
                    )),
                  };
                }
                """
            )
            outcomes.append(outcome)
        finally:
            fixture.close()
    checks = {
        **{
            f"{kind}HasExactWriteTimeoutCounts": (
                outcome["writes"] == expected[kind]["writes"]
                and outcome["ackTimeouts"] == expected[kind]["ackTimeouts"]
            )
            for kind, outcome in zip(("physical", "touch", "ime"), outcomes)
        },
        **{
            f"{kind}DelayedWritesHaveOriginatingEventId": outcome["allWritesHaveEventId"]
            for kind, outcome in zip(("physical", "touch", "ime"), outcomes)
        },
        **{
            f"{kind}TimeoutLeavesOneIncident": outcome["incidents"] == 1
            and outcome["hasTimeoutIncident"]
            for kind, outcome in zip(("physical", "touch", "ime"), outcomes)
        },
    }
    return result(
        "timeout-incident-eligibility",
        "PASS" if len(outcomes) == 3 and all(checks.values()) else "FAIL",
        checks=checks,
        counts={
            "kinds": len(outcomes),
            "writes": sum(int(outcome["writes"]) for outcome in outcomes),
            "ackTimeouts": sum(int(outcome["ackTimeouts"]) for outcome in outcomes),
            "incidents": sum(int(outcome["incidents"]) for outcome in outcomes),
        },
    )


def scenario_deferred_incident_eligibility(browser: Any) -> dict[str, Any]:
    """Keep timeout evidence for long-press, drag-start, and deferred drains."""
    outcomes: list[dict[str, int | bool]] = []
    expected = {
        "longPress": {"sends": 1, "ackTimeouts": 1, "acceptedAcks": 0},
        "dragStart": {"sends": 1, "ackTimeouts": 1, "acceptedAcks": 0},
        "deferredDrain": {"sends": 17, "ackTimeouts": 1, "acceptedAcks": 16},
    }
    for kind in ("long-press", "drag-start", "deferred-drain"):
        fixture = OfflineFixture(
            browser,
            touch=True,
            show_mobile=kind == "deferred-drain",
            include_diagnostics=True,
        )
        page = fixture.page
        try:
            page.evaluate(
                "() => { WebRTC.currentConnectionAttemptId = 'offline-deferred-incident'; }"
            )
            fixture.settle()
            if kind == "deferred-drain":
                dispatch_mobile_input(page, "a" * 17)
                fixture.settle()
                seeded = page.evaluate("() => Diagnostic.getInputTraceSnapshot().events.length")
                page.evaluate(
                    """
                    () => {
                      const input = document.getElementById('mobileTextInput');
                      input.value = '\u200b';
                      input.dispatchEvent(new InputEvent('input', {
                        bubbles: true,
                        inputType: 'deleteContentBackward',
                      }));
                      // Only the synchronous batch is acknowledged; the real
                      // adapter drain remains unacknowledged and must time out.
                      globalThis.__offlineAckAll();
                    }
                    """
                )
            else:
                seeded = page.evaluate("() => Diagnostic.getInputTraceSnapshot().events.length")
                point = surface_point(page)
                dispatch_touch(page, "pointerdown", 88, point["x"], point["y"], 1)
                if kind == "drag-start":
                    dispatch_touch(page, "pointermove", 88, point["x"] + 20, point["y"], 1)
            page.wait_for_timeout(4000)
            outcome = page.evaluate(
                """
                (seeded) => {
                  const trace = Diagnostic.getInputTraceSnapshot();
                  const records = trace.events.slice(seeded);
                  const sends = records.filter((event) => (
                    event.stage === 'transport-send' && event.accepted && event.action !== 'reset'
                  ));
                  return {
                    sends: sends.length,
                    ackTimeouts: trace.counters.ackTimeoutCount,
                    incidents: Diagnostic._pendingInputIncidents.length,
                    acceptedAcks: records.filter((event) => event.stage === 'ack' && event.accepted).length,
                    allSendsHaveEventId: sends.every((event) => Number.isSafeInteger(event.eventId)),
                    hasTimeoutRecord: records.some((event) => event.stage === 'ack-timeout'),
                  };
                }
                """,
                seeded,
            )
            outcomes.append(outcome)
        finally:
            fixture.close()
    checks = {
        **{
            f"{kind}HasExactDeferredOutcome": (
                outcome["sends"] == expected[kind]["sends"]
                and outcome["ackTimeouts"] == expected[kind]["ackTimeouts"]
                and outcome["acceptedAcks"] == expected[kind]["acceptedAcks"]
            )
            for kind, outcome in zip(("longPress", "dragStart", "deferredDrain"), outcomes)
        },
        **{
            f"{kind}DeferredWritesHaveOriginatingEventId": outcome["allSendsHaveEventId"]
            for kind, outcome in zip(("longPress", "dragStart", "deferredDrain"), outcomes)
        },
        **{
            f"{kind}DeferredTimeoutLeavesOneIncident": outcome["incidents"] == 1
            and outcome["hasTimeoutRecord"]
            for kind, outcome in zip(("longPress", "dragStart", "deferredDrain"), outcomes)
        },
    }
    return result(
        "deferred-incident-eligibility",
        "PASS" if len(outcomes) == 3 and all(checks.values()) else "FAIL",
        checks=checks,
        counts={
            "kinds": len(outcomes),
            "sends": sum(int(outcome["sends"]) for outcome in outcomes),
            "ackTimeouts": sum(int(outcome["ackTimeouts"]) for outcome in outcomes),
            "incidents": sum(int(outcome["incidents"]) for outcome in outcomes),
        },
    )


def scenario_blocked_gate_incident(browser: Any) -> dict[str, Any]:
    """Preserve unexpected-gate diagnostics for a visible blocked user input."""
    fixture = OfflineFixture(
        browser,
        touch=False,
        show_mobile=False,
        include_diagnostics=True,
    )
    page = fixture.page
    try:
        page.evaluate(
            "() => { WebRTC.currentConnectionAttemptId = 'offline-blocked-gate'; }"
        )
        fixture.settle()
        page.locator('[data-action="showDock"]').click()
        page.evaluate(
            """
            () => {
              const payload = __offlineWire.find((item) => (
                item.type === 'command' && item.action === 'showDock'
              ));
              if (!payload) throw new Error('toolbar emitted no command');
              Input.acceptMouseAck({
                schemaVersion: 2,
                inputType: 'command',
                inputIds: payload.inputIds,
                leaseEpoch: payload.leaseEpoch,
                appliedSeq: 0,
                status: 'resync-required',
              });
            }
            """
        )
        before_blocked_input = page.evaluate("() => __offlineWire.length")
        page.locator("#remoteVideo").focus()
        page.keyboard.down("a")
        state = page.evaluate(
            """
            (beforeBlockedInput) => {
              const trace = Diagnostic.getInputTraceSnapshot();
              const gate = Input.getEffectiveInputGate();
              const mobile = Input.mobileTextInputAdapter.getSnapshot();
              return {
                blocked: gate.allowed === false
                  && gate.blockedReasons.includes('desktop-write-reacquire-required'),
                noNewWrite: __offlineWire.length === beforeBlockedInput,
                noDraftMutation: mobile.deliveryUncertain === false && mobile.hasPending === false,
                gateRejected: trace.events.some((event) => (
                  event.stage === 'gate' && event.accepted === false
                    && event.reason === 'desktop-write-reacquire-required'
                )),
                unexpectedIncident: Diagnostic._pendingInputIncidents.some((item) => (
                  item.reason === 'input-gate-unexpected'
                )),
              };
            }
            """,
            before_blocked_input,
        )
        # The value is only read inside the browser expression; it is never
        # serialized in the safe result artifact.
        checks = {
            "blockedGateIsFailClosed": state["blocked"],
            "blockedInputEmitsNoWrite": state["noNewWrite"],
            "blockedInputDoesNotCreateDraft": state["noDraftMutation"],
            "blockedGateTraceIsRecorded": state["gateRejected"],
            "blockedGateLeavesUnexpectedIncident": state["unexpectedIncident"],
        }
        return result(
            "blocked-gate-incident",
            "PASS" if all(checks.values()) else "FAIL",
            checks=checks,
            counts={"blockedWrites": 0 if state["noNewWrite"] else 1, "incidents": 1 if state["unexpectedIncident"] else 0},
        )
    finally:
        fixture.close()


def scenario_release_ack_loss(browser: Any) -> dict[str, Any]:
    """Exercise release-only ACK loss for mouse, physical keyboard, and touch."""
    outcomes: list[dict[str, int | bool]] = []
    for kind in ("mouse-up", "key-up", "touch-up"):
        fixture = OfflineFixture(
            browser,
            touch=kind == "touch-up",
            show_mobile=False,
            include_diagnostics=True,
        )
        page = fixture.page
        try:
            page.evaluate(
                "() => { WebRTC.currentConnectionAttemptId = 'offline-release-ack-loss'; }"
            )
            fixture.settle()
            if kind == "key-up":
                page.locator("#remoteVideo").focus()
                page.keyboard.press("a")
            else:
                point = surface_point(page)
                if kind == "touch-up":
                    page.touchscreen.tap(point["x"], point["y"])
                else:
                    page.mouse.click(point["x"], point["y"])
            page.evaluate(
                """
                () => {
                  for (const payload of __offlineWire.slice(__offlineAckIndex)) {
                    if (payload.action !== 'down'
                      && !(payload.action === 'key' && payload.payload?.phase === 'down')) continue;
                    const ack = {
                      schemaVersion: 2,
                      inputType: payload.type,
                      inputIds: payload.inputIds,
                      leaseEpoch: payload.leaseEpoch,
                      appliedSeq: payload.seq,
                      status: 'applied',
                    };
                    if (payload.type === 'keyboard') Input.acceptKeyboardAck(ack);
                    else Input.acceptMouseAck(ack);
                  }
                }
                """
            )
            page.wait_for_timeout(3400)
            outcome = page.evaluate(
                """
                () => {
                  const trace = Diagnostic.getInputTraceSnapshot();
                  return {
                    sends: trace.events.filter((event) => (
                      event.stage === 'transport-send' && event.accepted && event.action !== 'reset'
                    )).length,
                    acceptedDownAcks: trace.events.filter((event) => (
                      event.stage === 'ack' && event.accepted
                    )).length,
                    timeouts: trace.counters.ackTimeoutCount,
                    incidents: Diagnostic._pendingInputIncidents.length,
                    releaseTimeoutRecorded: trace.events.some((event) => event.stage === 'ack-timeout'),
                  };
                }
                """
            )
            outcomes.append(outcome)
        finally:
            fixture.close()
    checks = {
        **{
            f"{kind}HasDownAndReleaseWrites": outcome["sends"] == 2
            for kind, outcome in zip(("mouseUp", "keyUp", "touchUp"), outcomes)
        },
        **{
            f"{kind}OnlyReleaseAckTimesOut": (
                outcome["acceptedDownAcks"] == 1
                and outcome["timeouts"] == 1
                and outcome["releaseTimeoutRecorded"]
            )
            for kind, outcome in zip(("mouseUp", "keyUp", "touchUp"), outcomes)
        },
        **{
            f"{kind}ReleaseTimeoutLeavesIncident": outcome["incidents"] > 0
            for kind, outcome in zip(("mouseUp", "keyUp", "touchUp"), outcomes)
        },
    }
    return result(
        "release-ack-loss",
        "PASS" if len(outcomes) == 3 and all(checks.values()) else "FAIL",
        checks=checks,
        counts={
            "kinds": len(outcomes),
            "writes": sum(int(outcome["sends"]) for outcome in outcomes),
            "downAcks": sum(int(outcome["acceptedDownAcks"]) for outcome in outcomes),
            "releaseTimeouts": sum(int(outcome["timeouts"]) for outcome in outcomes),
            "incidents": sum(int(outcome["incidents"]) for outcome in outcomes),
        },
    )


def scenario_desktop_draft_entry(browser: Any) -> dict[str, Any]:
    """Use the fixed recovery draft entry from a non-touch desktop surface."""
    fixture = OfflineFixture(
        browser,
        touch=False,
        show_mobile=True,
        include_diagnostics=True,
    )
    page = fixture.page
    try:
        fixture.settle()
        page.evaluate(
            """
            () => {
              globalThis.__offlineFailNext = 'text';
            }
            """
        )
        dispatch_mobile_input(page, "offline-unsent-draft")
        fixture.settle()
        initial_editor_hidden = page.locator("#mobileInputDock").is_hidden()
        before = page.evaluate("() => __offlineWire.length")
        page.locator("#inputRecoveryDraftBtn").click()
        fixture.settle()
        state = page.evaluate(
            """
            () => {
              const mobile = Input.mobileTextInputAdapter.getSnapshot();
              const draftEntry = document.getElementById('inputRecoveryDraftBtn');
              const editor = document.getElementById('mobileInputDock');
              return {
                desktop: navigator.maxTouchPoints === 0,
                entryVisible: !draftEntry.hidden,
                editorVisible: !editor.hidden,
                pending: mobile.hasPending,
                uncertain: mobile.deliveryUncertain,
                wireCount: __offlineWire.length,
                textWrites: __offlineWire.filter((event) => event.action === 'text').length,
              };
            }
            """
        )
        checks = {
            "nonTouchDesktopStartsWithHiddenEditor": initial_editor_hidden,
            "nonTouchSurfaceIsDetected": state["desktop"],
            "fixedDraftEntryVisible": state["entryVisible"],
            "draftEntryOpensEditor": state["editorVisible"],
            "draftRemainsPendingAndUncertain": state["pending"] and state["uncertain"],
            "draftEntryDoesNotReplayText": state["textWrites"] == 0 and state["wireCount"] == before,
        }
        return result(
            "desktop-draft-entry",
            "PASS" if all(checks.values()) else "FAIL",
            checks=checks,
            counts={"textWrites": state["textWrites"], "wireWritesAfterEntry": state["wireCount"] - before},
        )
    finally:
        fixture.close()


def scenario_browser_signal_ingestion(browser: Any) -> dict[str, Any]:
    """Exercise the real browser producer through the Signal redaction seam."""
    fixture = OfflineFixture(
        browser,
        touch=False,
        show_mobile=False,
        include_diagnostics=True,
    )
    network_before = OFFLINE_NETWORK_STATS.copy()
    page = fixture.page
    try:
        page.evaluate(
            "() => { WebRTC.currentConnectionAttemptId = 'offline-browser-ingestion'; }"
        )
        fixture.settle()
        point = surface_point(page)
        page.mouse.click(point["x"], point["y"])
        page.evaluate("() => window.dispatchEvent(new Event('blur'))")
        wire_writes = fixture.settle()
        page.evaluate("() => window.dispatchEvent(new Event('focus'))")
        page.wait_for_function(
            "() => Diagnostic.getInputTraceSnapshot().counters.pendingHashCount === 0"
        )
        produced = page.evaluate(
            """
            () => {
              const state = Input.getDiagnosticState();
              const trace = Diagnostic.getInputTraceSnapshot();
              const accepted = trace.events.filter((item) => (
                item.stage === 'transport-send' && item.accepted === true
              ));
              return {
                acceptedWrites: (globalThis.__offlineWire || []).filter((item) => (
                  item.type === 'mouse' && item.action !== 'reset'
                )).length,
                acceptedSendEvents: accepted.length,
                traceEvents: trace.events.length,
                recoveryWaiting: state.recovery.state === 'waiting',
                effectiveGateBlocked: state.effectiveGate.allowed === false,
                surfaceState: state.surface.state,
              };
            }
            """
        )
        ingested = ingest_browser_diagnostic(page)
        checks = {
            "realBrowserWriteProduced": wire_writes >= 2 and produced["acceptedWrites"] >= 1,
            "recoveryWaitingAfterBlurFocus": produced["recoveryWaiting"],
            "effectiveGateBlockedDuringRecovery": produced["effectiveGateBlocked"],
            "signalIngestionAccepted": ingested.get("accepted") is True,
            "attemptIdentityPreserved": ingested.get("attemptPreserved") is True,
            "safeInputStateRetained": ingested.get("inputStateRetained") is True,
            "safeInputTraceRetained": ingested.get("inputTraceRetained") is True,
            "gateStatePreserved": ingested.get("gatePreserved") is True,
            "recoveryStatePreserved": ingested.get("recoveryPreserved") is True,
            "surfaceStatePreserved": ingested.get("surfacePreserved") is True,
            "summaryGateAndTracePresent": ingested.get("summaryGatePresent") is True
                and ingested.get("summaryTracePresent") is True,
            "acceptedSendsCorrelated": ingested.get("sendCorrelationPreserved") is True
                and ingested.get("acceptedSendCount") == produced["acceptedSendEvents"],
            "nullableHashAndReasonAreSafe": ingested.get("hashesSafe") is True
                and ingested.get("reasonsSafe") is True,
            "diagnosticPersistenceDisabled": ingested.get("persisted") is False,
            "networkDenied": OFFLINE_NETWORK_STATS["requests"] == network_before["requests"]
                and OFFLINE_NETWORK_STATS["sensitivePayloads"] == network_before["sensitivePayloads"],
        }
        return result(
            "browser-signal-ingestion",
            "PASS" if all(checks.values()) else "FAIL",
            checks=checks,
            counts={
                "browserWrites": produced["acceptedWrites"],
                "producerAcceptedSends": produced["acceptedSendEvents"],
                "producerTraceEvents": produced["traceEvents"],
                "ingestedAcceptedSends": int(ingested.get("acceptedSendCount", 0)),
                "ingestedTraceEvents": int(ingested.get("eventCount", 0)),
                "ingestedDroppedEvents": int(ingested.get("droppedEvents", 0)),
            },
        )
    finally:
        fixture.close()


def scenario_draft_retention_exactness(browser: Any) -> dict[str, Any]:
    """Keep the exact local draft through reset and canceled drain work."""
    fixture = OfflineFixture(
        browser,
        touch=True,
        show_mobile=True,
        include_diagnostics=True,
    )
    page = fixture.page
    try:
        page.evaluate(
            "() => { WebRTC.currentConnectionAttemptId = 'offline-draft-retention'; }"
        )
        fixture.settle()
        dispatch_mobile_input(page, "retainedabcdefghijklmnopqrst")
        fixture.settle()
        probe = page.evaluate(
            """
            () => {
              const input = document.getElementById('mobileTextInput');
              const adapter = Input.mobileTextInputAdapter;
              const countBatches = () => (globalThis.__offlineWire || [])
                .filter((item) => item.type === 'keyboard' && item.action === 'batch').length;
              const batchesBeforeDeletion = countBatches();
              const content = input.value.replaceAll('\u200b', '');
              input.value = `${content.slice(0, -20)}\u200b`;
              input.dispatchEvent(new InputEvent('input', {
                bubbles: true, inputType: 'deleteContentBackward',
              }));
              const beforeReset = input.value;
              const beforeBatchCount = countBatches();
              const pendingBeforeReset = adapter.getSnapshot().hasPending === true;
              const resetAccepted = Input.resetKeyboard('offline-draft-retention') === true;
              globalThis.__offlineDraftRetention = {
                value: beforeReset,
                batchCount: beforeBatchCount,
                deletionBatchCount: beforeBatchCount - batchesBeforeDeletion,
              };
              return {
                pendingBeforeReset,
                resetAccepted,
                sameAfterReset: input.value === beforeReset,
                batchesBeforeReset: beforeBatchCount,
                deletionBatchCount: beforeBatchCount - batchesBeforeDeletion,
              };
            }
            """
        )
        fixture.settle()
        wait_frames(page, 4)
        after = page.evaluate(
            """
            () => {
              const input = document.getElementById('mobileTextInput');
              const adapter = Input.mobileTextInputAdapter;
              const batchCount = (globalThis.__offlineWire || [])
                .filter((item) => item.type === 'keyboard' && item.action === 'batch').length;
              const retained = globalThis.__offlineDraftRetention || {};
              return {
                sameAfterCanceledDeferredCallback: input.value === retained.value,
                noDeferredReplay: batchCount === retained.batchCount,
                pendingRetained: adapter.getSnapshot().hasPending === true,
                uncertaintyRetained: adapter.getSnapshot().deliveryUncertain === true,
                batchCount,
              };
            }
            """
        )
        checks = {
            "draftPendingBeforeReset": probe["pendingBeforeReset"],
            "resetAccepted": probe["resetAccepted"],
            "exactDraftAfterReset": probe["sameAfterReset"],
            "exactDraftAfterCanceledDeferredCallback": after["sameAfterCanceledDeferredCallback"],
            "canceledDeferredCallbackDoesNotReplay": after["noDeferredReplay"],
            "draftRemainsFailClosed": after["pendingRetained"] and after["uncertaintyRetained"],
            "deferredDrainWasExercised": probe["deletionBatchCount"] >= 1,
        }
        return result(
            "draft-retention-exactness",
            "PASS" if all(checks.values()) else "FAIL",
            checks=checks,
            counts={"deletionBatches": probe["deletionBatchCount"]},
        )
    finally:
        fixture.close()


def geometry_page(
    browser: Any,
    width: int,
    height: int,
    inset: int,
    overlay: bool,
    *,
    touch: bool,
    offset_top: int,
    safe_bottom: int,
) -> tuple[OfflineFixture, dict[str, Any]]:
    fixture = OfflineFixture(
        browser,
        width=width,
        height=height,
        touch=touch,
        inset=inset,
        overlay=overlay,
        offset_top=offset_top,
        safe_bottom=safe_bottom,
        show_mobile=touch,
    )
    page = fixture.page
    wait_frames(page, 3)
    checks = page.evaluate(
        """
        async ({width, height, inset, overlay, offsetTop, safeBottom, touch}) => {
          const close = (a, b) => Math.abs(Number(a) - Number(b)) <= 1;
          const box = (selector) => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return {
              top: Number(rect.top), bottom: Number(rect.bottom), left: Number(rect.left),
              right: Number(rect.right), width: Number(rect.width), height: Number(rect.height),
            };
          };
          const viewer = box('.viewer-container');
          const docks = box('#chromeDocks');
          const text = box('#mobileInputDock');
          const status = box('#statusBar');
          const surface = box('#mobileKeySurface');
          const surfaceElement = document.getElementById('mobileKeySurface');
          const expected = ChromeLayout.computeMobileLayout({
            layoutHeight: height,
            visualHeight: Math.max(0, height - inset - (overlay ? 0 : offsetTop)),
            offsetTop,
            keyboardRectHeight: overlay ? inset : 0,
            keyboardOverlay: overlay,
            safeBottom,
            chromeTop: status?.height || 0,
            dockContentHeight: docks?.height || 0,
            textDockHeight: text?.height || 0,
            textVisible: touch,
            touchSupported: touch,
          });
          const probeValue = Number.parseFloat(getComputedStyle(document.getElementById('mobileSafeAreaProbe')).paddingBottom);
          const rows = [...document.querySelectorAll('.mobile-key-row')];
          const button44 = [...document.querySelectorAll('#mobileKeySurface .mobile-key-btn')]
            .every((el) => el.getBoundingClientRect().width >= 44 - 1 && el.getBoundingClientRect().height >= 44 - 1);
          const readFrame = () => ({
            viewer: box('.viewer-container'),
            docks: box('#chromeDocks'),
            text: box('#mobileInputDock'),
            status: box('#statusBar'),
          });
          const frames = [];
          for (let index = 0; index < 20; index += 1) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
            frames.push(readFrame());
          }
          const requiredRects = (frame) => frame.viewer && frame.docks && frame.text && frame.status;
          const firstFrame = frames[0];
          const finalFrame = frames.at(-1);
          const frameFields = ['viewer', 'docks', 'text', 'status'];
          const rectFields = ['top', 'bottom', 'left', 'right', 'width', 'height'];
          const stable20Frames = frames.length === 20
            && frames.every((frame) => requiredRects(frame))
            && frames.every((frame) => frameFields.every((field) => rectFields.every((key) =>
              close(frame[field][key], firstFrame[field][key]))));
          const strictTouch = touch === true;
          const unsupported = expected.unsupportedViewport === true;
          const desktopStyleClean = [
            '--mobile-visible-top', '--mobile-viewer-top', '--mobile-viewer-height',
            '--mobile-dock-bottom', '--mobile-text-bottom',
          ].every((property) => !document.documentElement.style.getPropertyValue(property));
          const keyboardState = String(Input.keyboardController?.getSnapshot?.().state || '');
          const desktopInputUnblocked = Input.isActive === true
            && !['BLOCKED', 'RESET_REQUIRED', 'reacquire-required', 'revoked'].includes(keyboardState);
          return {
            managedOnlyForTouch: document.body.classList.contains('mobile-layout-managed') === strictTouch,
            compactForTouchText: document.body.classList.contains('mobile-layout-compact') === strictTouch,
            desktopStyleClean: strictTouch || desktopStyleClean,
            desktopInputUnblocked: strictTouch || desktopInputUnblocked,
            viewerTop: !strictTouch || close(finalFrame?.viewer?.top, expected.viewerTop),
            viewerBottomBeforeDock: !strictTouch || unsupported || Number(finalFrame?.viewer?.bottom || 0) <= Number(finalFrame?.docks?.top || 0) + 1,
            viewerHeightFormula: !strictTouch || close(finalFrame?.viewer?.height, expected.viewerHeight),
            dockBottomFormula: !strictTouch || close(finalFrame?.docks?.bottom, expected.visibleBottom - safeBottom - (finalFrame?.text?.height || 0) - 8),
            textBottomFormula: !strictTouch || close(finalFrame?.text?.bottom, expected.visibleBottom - safeBottom),
            statusAboveViewer: !strictTouch || Number(finalFrame?.status?.bottom || 0) <= Number(finalFrame?.viewer?.top || 0) + 1,
            safeProbeInjected: close(probeValue, safeBottom),
            offsetTopRespected: !strictTouch || (overlay ? expected.visibleTop === 0 : expected.visibleTop === Math.min(offsetTop, height)),
            visibleBottomBounded: expected.visibleBottom >= expected.visibleTop && expected.visibleBottom <= height,
            rowsRemainTwoAndHorizontal: !strictTouch || (rows.length === 2 && close(surface?.height, 44) && surfaceElement.scrollWidth >= surfaceElement.clientWidth),
            keysHaveNativeMinimum: !strictTouch || button44,
            compactViewerMinimum: !strictTouch || width === 568 || expected.viewerHeight >= 120,
            unsupportedMatchesFormula: !strictTouch || document.body.classList.contains('mobile-layout-unsupported') === expected.unsupportedViewport,
            nativeRectRead20Frames: frames.length === 20 && Boolean(firstFrame && finalFrame),
            stable20Frames: stable20Frames,
          };
        }
        """,
        {
            "width": width,
            "height": height,
            "inset": inset,
            "overlay": overlay,
            "offsetTop": offset_top,
            "safeBottom": safe_bottom,
            "touch": touch,
        },
    )
    return fixture, checks


def exercise_last_keys(fixture: OfflineFixture) -> dict[str, bool]:
    page = fixture.page
    point = surface_point(page)
    # Give the right-click button a trusted last point through a real accepted
    # gesture before clicking that production button.
    dispatch_touch(page, 'pointerdown', 99, point['x'], point['y'], 1)
    dispatch_touch(page, 'pointerup', 99, point['x'], point['y'], 0)
    fixture.settle()
    before = wire_counts(page)
    first = page.locator('.mobile-key-row').nth(0).locator('button').last
    second = page.locator('.mobile-key-row').nth(1).locator('button').last
    first.scroll_into_view_if_needed()
    first.click()
    first_delta = fixture.settle()
    second.scroll_into_view_if_needed()
    second.click()
    second_delta = fixture.settle()
    after = wire_counts(page)
    return {
        'firstRowLastProductionAction': after['mouseDown'] - before['mouseDown'] == 1 and after['mouseUp'] - before['mouseUp'] == 1,
        'secondRowLastProductionAction': after['keyboardBatch'] - before['keyboardBatch'] == 1,
        'firstRowNativeClickSettled': first_delta >= 1,
        'secondRowNativeClickSettled': second_delta == 1,
    }


def exercise_supported_recovery_controls(fixture: OfflineFixture) -> dict[str, bool]:
    """Measure and click the real retry/discard controls above a keyboard inset."""
    page = fixture.page
    page.evaluate(
        """
        () => {
          const controller = Input.keyboardController;
          globalThis.__offlineRecoveryOriginalSendText = controller.sendText.bind(controller);
          controller.sendText = () => false;
        }
        """
    )
    dispatch_mobile_input(page, "recover")
    wait_frames(page, 2)
    pending_counts = wire_counts(page)
    geometry = page.evaluate(
        """
        () => {
          const visibleBottom = Number(ChromeLayout._mobileLayoutResult?.visibleBottom || innerHeight);
          const centerHit = (element, rect) => {
            if (!element || !rect || rect.width <= 0 || rect.height <= 0) return false;
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return hit === element || element.contains(hit);
          };
          const probe = (selector) => {
            const element = document.querySelector(selector);
            const rect = element?.getBoundingClientRect();
            const size = Boolean(rect && rect.width >= 44 && rect.height >= 44);
            const centerInViewport = Boolean(rect
              && rect.left + rect.width / 2 >= 0
              && rect.left + rect.width / 2 <= innerWidth
              && rect.top + rect.height / 2 >= 0
              && rect.top + rect.height / 2 <= innerHeight);
            const aboveKeyboard = Boolean(rect && rect.bottom <= visibleBottom + 1);
            const visible = Boolean(element && !element.hidden && !element.disabled && size
              && centerInViewport && aboveKeyboard);
            return { visible, hit: visible && centerHit(element, rect) };
          };
          return {
            pending: Input.mobileTextInputAdapter?.getSnapshot?.().hasPending === true,
            retry: probe('#mobileInputRetryBtn'),
            discard: probe('#mobileInputDiscardBtn'),
            navigation: probe('[data-mobile-action="left"]'),
            mobileDockAboveKeyboard: (() => {
              const rect = document.getElementById('mobileInputDock')?.getBoundingClientRect();
              return Boolean(rect && rect.bottom <= visibleBottom + 1);
            })(),
          };
        }
        """
    )
    nav_before = wire_counts(page)
    page.locator('[data-mobile-action="left"]').click()
    nav_after = wire_counts(page)
    nav_state = safe_state(page)

    # Restore the send path only for the explicit retry click.  The first
    # failed transaction must not have been emitted or replayed by layout.
    page.evaluate(
        "() => { Input.keyboardController.sendText = globalThis.__offlineRecoveryOriginalSendText; }"
    )
    page.locator('#mobileInputRetryBtn').click()
    retry_count = fixture.settle()
    retry_after = safe_state(page)
    retry_counts = wire_counts(page)

    # Create a second rejected draft and exercise the native discard action;
    # it must clear only local state and never write another text payload.
    page.evaluate(
        """
        () => {
          const controller = Input.keyboardController;
          globalThis.__offlineRecoveryOriginalSendText = controller.sendText.bind(controller);
          controller.sendText = () => false;
        }
        """
    )
    dispatch_pending_mobile_draft(page, "discard")
    discard_before = wire_counts(page)
    page.locator('#mobileInputDiscardBtn').click()
    wait_frames(page, 2)
    discard_after = wire_counts(page)
    discard_state = safe_state(page)
    page.evaluate(
        "() => { Input.keyboardController.sendText = globalThis.__offlineRecoveryOriginalSendText; }"
    )
    return {
        "pendingDraftVisible": geometry["pending"],
        "retryReachableAboveKeyboard": geometry["retry"]["visible"] and geometry["retry"]["hit"],
        "discardReachableAboveKeyboard": geometry["discard"]["visible"] and geometry["discard"]["hit"],
        "navigationReachableAboveKeyboard": geometry["navigation"]["visible"] and geometry["navigation"]["hit"],
        "mobileDockAboveKeyboard": geometry["mobileDockAboveKeyboard"],
        "navigationNativeClickBlockedWhilePending": nav_after["total"] == nav_before["total"]
            and nav_state["activeElement"] == "mobileTextInput",
        "retryNativeClickSendsExactlyOnce": retry_count == 1
            and retry_counts["keyboardText"] - pending_counts["keyboardText"] == 1
            and retry_after["mobilePending"] is False,
        "discardNativeClickClearsWithoutWrite": discard_after["keyboardText"] == discard_before["keyboardText"]
            and discard_state["mobilePending"] is False,
    }


def exercise_899_boundary_context(browser: Any) -> dict[str, bool]:
    """Exercise the production More/close paths while crossing the 899px edge."""
    fixture = OfflineFixture(browser, width=900, height=812, touch=True, inset=0, safe_bottom=0)
    page = fixture.page
    checks: dict[str, bool] = {}
    try:
        dispatch_mobile_input(page, "boundary")
        initial_count = fixture.settle()
        per_width: list[dict[str, bool]] = []
        for width in (900, 899):
            resize_fixture_viewport(page, width, 812)
            wait_frames(page, 4)
            before = page.evaluate(
                """
                () => {
                  const docks = document.getElementById('chromeDocks')?.getBoundingClientRect();
                  const text = document.getElementById('mobileInputDock')?.getBoundingClientRect();
                  return {
                    managed: document.body.classList.contains('mobile-layout-managed'),
                    compact: document.body.classList.contains('mobile-layout-compact'),
                    textShown: Input.mobileTextInputAdapter?.getSnapshot?.().shown === true,
                    docksHeight: Number(docks?.height || 0),
                    textBottom: Number(text?.bottom || 0),
                    textBottomStyle: document.documentElement.style.getPropertyValue('--mobile-text-bottom'),
                  };
                }
                """
            )
            page.locator('#moreActionsBtn').click()
            wait_frames(page, 2)
            # Save the two values independently of the menu DOM; opening More
            # is an overlay action and must not grow the measured dock.
            opened = page.evaluate(
                """
                ({before}) => {
                  const docks = document.getElementById('chromeDocks')?.getBoundingClientRect();
                  const menu = document.getElementById('moreActionsMenu');
                  return {
                    menuOpen: menu?.hidden === false
                      && document.getElementById('moreActionsBtn')?.getAttribute('aria-expanded') === 'true',
                    productionActionMoved: Boolean(menu?.contains(document.getElementById('scaleBtn'))),
                    docksHeightStable: Math.abs(Number(docks?.height || 0) - Number(before.docksHeight || 0)) <= 1,
                    textBottomStable: document.documentElement.style.getPropertyValue('--mobile-text-bottom')
                      === before.textBottomStyle,
                  };
                }
                """,
                {"before": before},
            )
            initial_scale_label = page.locator('#scaleBtn').text_content()
            page.locator('#scaleBtn').click()
            scale_action = page.locator('#scaleBtn').text_content() != initial_scale_label
            page.locator('#moreActionsBtn').click()
            wait_frames(page, 2)
            closed = page.evaluate(
                """
                ({before}) => {
                  const docks = document.getElementById('chromeDocks')?.getBoundingClientRect();
                  const menu = document.getElementById('moreActionsMenu');
                  return {
                    menuClosed: menu?.hidden === true
                      && document.getElementById('moreActionsBtn')?.getAttribute('aria-expanded') === 'false',
                    productionActionRestored: !menu?.contains(document.getElementById('scaleBtn'))
                      && document.querySelector('.control-bar')?.contains(document.getElementById('scaleBtn')),
                    docksHeightStable: Math.abs(Number(docks?.height || 0) - Number(before.docksHeight || 0)) <= 1,
                    textBottomStable: document.documentElement.style.getPropertyValue('--mobile-text-bottom')
                      === before.textBottomStyle,
                  };
                }
                """,
                {"before": before},
            )

            # Hide/reopen the real mobile input toggle.  The managed layout
            # remains the touch path, while compact is selected only while the
            # text dock is visible; reopening must not replay the baseline.
            page.locator('#mobileTextInputBtn').click()
            wait_frames(page, 4)
            hidden = page.evaluate(
                """
                () => ({
                  mobileHidden: Input.mobileTextInputAdapter?.getSnapshot?.().shown === false,
                  managedRetained: document.body.classList.contains('mobile-layout-managed'),
                  compactExited: !document.body.classList.contains('mobile-layout-compact'),
                })
                """
            )
            hidden_count = fixture.settle()
            page.locator('#mobileTextInputBtn').click()
            wait_frames(page, 4)
            reopened = page.evaluate(
                """
                () => ({
                  mobileShown: Input.mobileTextInputAdapter?.getSnapshot?.().shown === true,
                  managedRestored: document.body.classList.contains('mobile-layout-managed'),
                  compactRestored: document.body.classList.contains('mobile-layout-compact'),
                  mobileFocusRestored: document.activeElement?.id === 'mobileTextInput',
                })
                """
            )
            reopened_count = fixture.settle()
            per_width.append({
                f"width{width}Managed": before["managed"],
                f"width{width}Compact": before["compact"],
                f"width{width}MoreOpen": opened["menuOpen"],
                f"width{width}MoreMovesProductionAction": opened["productionActionMoved"],
                f"width{width}MoreKeepsDockHeight": opened["docksHeightStable"] and closed["docksHeightStable"],
                f"width{width}MoreKeepsTextReserve": opened["textBottomStable"] and closed["textBottomStable"],
                f"width{width}MoreActionClicked": scale_action,
                f"width{width}MoreCloseRestoresAction": closed["menuClosed"] and closed["productionActionRestored"],
                f"width{width}CloseExitsCompact": hidden["mobileHidden"] and hidden["managedRetained"] and hidden["compactExited"],
                f"width{width}ReopenRestoresCompact": reopened["mobileShown"] and reopened["managedRestored"]
                    and reopened["compactRestored"] and reopened["mobileFocusRestored"],
                f"width{width}ReopenDoesNotReplay": hidden_count == 0 and reopened_count == 0,
            })
        for values in per_width:
            checks.update(values)
        checks["boundaryInitialInputAccepted"] = initial_count == 1
    finally:
        fixture.close()

    # The same 899px width without touch must take the legacy desktop path;
    # its More menu still moves only actions and never enters managed layout.
    desktop_fixture = OfflineFixture(browser, width=899, height=812, touch=False, show_mobile=False)
    desktop_page = desktop_fixture.page
    try:
        before = desktop_page.evaluate(
            """
            () => ({
              managed: document.body.classList.contains('mobile-layout-managed'),
              hasManagedViewerStyle: Boolean(document.documentElement.style.getPropertyValue('--mobile-viewer-top')),
            })
            """
        )
        desktop_page.locator('#moreActionsBtn').click()
        wait_frames(desktop_page, 2)
        opened = desktop_page.evaluate(
            """
            () => {
              const menu = document.getElementById('moreActionsMenu');
              return {
                menuOpen: menu?.hidden === false,
                actionMoved: Boolean(menu?.contains(document.querySelector('[data-action="copy"]'))),
                controlStayedOut: !menu?.contains(document.getElementById('scaleBtn')),
              };
            }
            """
        )
        desktop_page.locator('#moreActionsBtn').click()
        wait_frames(desktop_page, 2)
        closed = desktop_page.evaluate(
            """
            () => ({
              menuClosed: document.getElementById('moreActionsMenu')?.hidden === true,
              actionRestored: document.querySelector('.action-bar')?.contains(document.querySelector('[data-action="copy"]')),
            })
            """
        )
        checks.update({
            "desktop899ManagedExit": before["managed"] is False and before["hasManagedViewerStyle"] is False,
            "desktop899MoreActionWorks": opened["menuOpen"] and opened["actionMoved"] and opened["controlStayedOut"]
                and closed["menuClosed"] and closed["actionRestored"],
        })
    finally:
        desktop_fixture.close()
    return checks


def scenario_layout_matrix(browser: Any) -> dict[str, Any]:
    matrix = (
        (375, 812, 0), (375, 812, 300),
        (768, 1024, 0), (768, 1024, 300),
        (1024, 1366, 0), (1024, 1366, 300),
        (1440, 900, 0), (1440, 900, 300),
        (568, 320, 0), (568, 320, 160), (568, 320, 300),
    )
    all_checks: dict[str, bool] = {}
    compact_checks: dict[str, bool] | None = None
    pages = 0
    try:
        for width, height, inset in matrix:
            for overlay in (False, True):
                for touch in (False, True):
                    # A resize visual viewport needs a non-zero offsetTop; the
                    # overlay branch proves it does not add that offset twice.
                    offset_top = 18 if not overlay else 24
                    safe_bottom = 12 if width != 568 else 0
                    fixture, checks = geometry_page(
                        browser,
                        width,
                        height,
                        inset,
                        overlay,
                        touch=touch,
                        offset_top=offset_top,
                        safe_bottom=safe_bottom,
                    )
                    try:
                        pages += 1
                        keyboard_mode = 'overlay' if overlay else 'resize'
                        device_mode = 'touch' if touch else 'desktop'
                        for key, value in checks.items():
                            all_checks[f'{width}x{height}-inset{inset}-{keyboard_mode}-{device_mode}-{key}'] = bool(value)
                        if touch and width == 375 and height == 812 and inset == 0 and overlay and compact_checks is None:
                            compact_checks = exercise_last_keys(fixture)
                            for key, value in compact_checks.items():
                                all_checks[f'compact-{key}'] = value
                        if touch and inset == 300 and width in (375, 768, 1024):
                            recovery_checks = exercise_supported_recovery_controls(fixture)
                            for key, value in recovery_checks.items():
                                all_checks[
                                    f'{width}x{height}-inset{inset}-{keyboard_mode}-recovery-{key}'
                                ] = bool(value)
                    finally:
                        fixture.close()
    except Exception:
        # The caller converts unexpected browser actions to a safe FAIL result.
        raise
    boundary_checks = exercise_899_boundary_context(browser)
    all_checks.update({f'boundary-{key}': bool(value) for key, value in boundary_checks.items()})
    status = "PASS" if all(all_checks.values()) else "FAIL"
    return result(
        "layout-matrix",
        status,
        checks=all_checks,
        counts={"matrixPages": pages, "checks": len(all_checks)},
        layout={
            "dimensions": len(matrix),
            "insetVariants": 3,
            "touchModes": 2,
            "keyboardModes": 2,
            "safeProbe": "injected-and-measured",
            "offsetTop": "nonzero-resize-and-overlay-zero-top",
            "boundary": "900-to-899-and-managed-recovery-controls",
        },
    )


def scenario_terminal_lifecycle(browser: Any) -> dict[str, Any]:
    """Exercise the existing TerminalPanel DOM lifecycle without transport."""
    fixture = OfflineFixture(
        browser,
        width=1024,
        height=768,
        touch=True,
        include_terminal=True,
    )
    page = fixture.page
    try:
        initialized = page.evaluate(
            """
            () => {
              const initialized = TerminalPanel.init();
              return {
                fsmLoaded: typeof TerminalSessionFsm?.createTerminalState === 'function',
                terminalLoaded: typeof TerminalPanel?.showTerminal === 'function',
                initReturnedTrue: initialized === true,
                elementsCached: Boolean(
                  TerminalPanel.elements?.root
                  && TerminalPanel.elements?.desktopPanel
                  && TerminalPanel.elements?.terminalPanel
                  && TerminalPanel.elements?.workspace
                  && TerminalPanel.elements?.composer
                ),
                noAdminCredential: TerminalPanel.hasAdminToken() === false,
                noSocketBeforeShow: TerminalPanel.socket === null,
                mobileFocusBeforeShow: document.activeElement?.id === 'mobileTextInput',
              };
            }
            """
        )
        page.evaluate("() => TerminalPanel.showTerminal()")
        # Let the production MutationObserver/animation-frame wiring observe
        # the real TerminalPanel DOM transition.  Do not hide a missing
        # observer by manually invoking ChromeLayout.recalculate().
        wait_frames(page, 4)
        terminal_state = page.evaluate(
            """
            () => {
              const root = document.getElementById('terminalPanel');
              const desktop = document.getElementById('desktopPanel');
              const style = document.documentElement.style;
              return {
                bodyTerminalActive: document.body.classList.contains('terminal-active'),
                terminalVisible: !root.hidden && !root.classList.contains('hidden'),
                desktopHidden: desktop.hidden && desktop.classList.contains('hidden'),
                terminalTabSelected: document.getElementById('terminalTabBtn')?.getAttribute('aria-selected') === 'true',
                terminalDomContainsWorkspace: root.contains(document.getElementById('terminalWorkspace')),
                terminalDomContainsComposer: root.contains(document.getElementById('terminalComposer')),
                terminalModeExitsManagedLayout: !document.body.classList.contains('mobile-layout-managed'),
                mobileLayoutOverridesCleared: [
                  '--mobile-visible-top', '--mobile-viewer-top', '--mobile-viewer-height',
                  '--mobile-dock-bottom', '--mobile-text-bottom',
                ].every((name) => !style.getPropertyValue(name)),
                mobileFocusRetained: document.activeElement?.id === 'mobileTextInput',
                noAdminCredential: TerminalPanel.hasAdminToken() === false,
                noSocketWithoutCredential: TerminalPanel.socket === null,
              };
            }
            """
        )

        # This is the native TerminalPanel-bound desktop tab action, not a
        # hand-written class toggle.  Allow the production observer to prove
        # the managed layout is restored when the desktop DOM is shown again.
        page.locator('#desktopTabBtn').click()
        wait_frames(page, 4)
        desktop_state = page.evaluate(
            """
            () => {
              const root = document.getElementById('terminalPanel');
              const desktop = document.getElementById('desktopPanel');
              const style = document.documentElement.style;
              return {
                bodyTerminalInactive: !document.body.classList.contains('terminal-active'),
                terminalHidden: root.hidden && root.classList.contains('hidden'),
                desktopVisible: !desktop.hidden && !desktop.classList.contains('hidden'),
                desktopTabSelected: document.getElementById('desktopTabBtn')?.getAttribute('aria-selected') === 'true',
                managedLayoutRestored: document.body.classList.contains('mobile-layout-managed'),
                mobileDockStillPresent: document.documentElement.contains(document.getElementById('mobileInputDock')),
                desktopTabReceivesNativeActionFocus: document.activeElement?.id === 'desktopTabBtn',
                managedOverrideReapplied: Boolean(style.getPropertyValue('--mobile-viewer-top')),
                terminalDomRetained: document.documentElement.contains(root)
                  && document.documentElement.contains(document.getElementById('terminalWorkspace')),
                noSocketWithoutCredential: TerminalPanel.socket === null,
              };
            }
            """
        )
        checks = {
            **initialized,
            **{f'terminal_{key}': value for key, value in terminal_state.items()},
            **{f'desktop_{key}': value for key, value in desktop_state.items()},
        }
        return result(
            "terminal-lifecycle",
            "PASS" if all(checks.values()) else "FAIL",
            checks=checks,
            counts={"terminalTransitions": 2},
        )
    finally:
        fixture.close()


def fullscreen_button_probe(page: Any) -> dict[str, bool]:
    return page.evaluate(
        """
        () => {
          const button = document.getElementById('fullscreenBtn');
          const rect = button?.getBoundingClientRect();
          const target44 = Boolean(rect && rect.width >= 44 && rect.height >= 44);
          const fullViewportBounds = Boolean(rect
            && rect.top >= -1 && rect.left >= -1
            && rect.bottom <= innerHeight + 1 && rect.right <= innerWidth + 1);
          const centerInViewport = Boolean(rect
            && rect.left + rect.width / 2 >= 0
            && rect.left + rect.width / 2 <= innerWidth
            && rect.top + rect.height / 2 >= 0
            && rect.top + rect.height / 2 <= innerHeight);
          const hit = rect && centerInViewport
            ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
            : null;
          return {
            visible: target44,
            target44,
            fullViewportBounds,
            hitTarget: Boolean(button && hit === button || button?.contains(hit)),
          };
        }
        """
    )


def prepare_fullscreen_button(page: Any) -> dict[str, bool]:
    """Expose the real fullscreen button without locator-driven scrolling."""
    fullscreen_button = page.locator('#fullscreenBtn')
    menu_state = page.evaluate(
        """
        () => {
          const button = document.getElementById('fullscreenBtn');
          const menu = document.getElementById('moreActionsMenu');
          return {
            inMoreMenu: Boolean(menu?.contains(button)),
            menuOpen: menu?.hidden === false,
          };
        }
        """
    )
    if not fullscreen_button.bounding_box() and not menu_state["menuOpen"]:
        page.locator('#moreActionsBtn').click(timeout=1000)
        wait_frames(page, 1)
        menu_state = page.evaluate(
            """
            () => {
              const button = document.getElementById('fullscreenBtn');
              const menu = document.getElementById('moreActionsMenu');
              return {
                inMoreMenu: Boolean(menu?.contains(button)),
                menuOpen: menu?.hidden === false,
              };
            }
            """
        )
    menu_scroll_changed = False
    menu_target_already_visible = False
    if menu_state["inMoreMenu"] and menu_state["menuOpen"]:
        menu = page.locator('#moreActionsMenu')
        before_scroll = int(page.evaluate("() => document.getElementById('moreActionsMenu').scrollTop"))
        # More is a genuine scroll container for the control bar in managed
        # compact mode.  Scroll it through the native pointer/wheel path so a
        # locator auto-scroll cannot conceal an unreachable fullscreen entry.
        for _ in range(8):
            probe = fullscreen_button_probe(page)
            if probe["target44"] and probe["fullViewportBounds"] and probe["hitTarget"]:
                menu_target_already_visible = True
                break
            box = menu.bounding_box()
            if not box:
                break
            page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            page.mouse.wheel(0, 400)
            wait_frames(page, 1)
        after_scroll = int(page.evaluate("() => document.getElementById('moreActionsMenu').scrollTop"))
        menu_scroll_changed = after_scroll != before_scroll
    before_autoscroll = fullscreen_button_probe(page)
    return {
        **before_autoscroll,
        "preAutoscrollTarget": bool(
            before_autoscroll["target44"]
            and before_autoscroll["fullViewportBounds"]
            and before_autoscroll["hitTarget"]
        ),
        "postAutoscrollTarget": bool(
            before_autoscroll["target44"]
            and before_autoscroll["fullViewportBounds"]
            and before_autoscroll["hitTarget"]
        ),
        "menuScrollChangedOrNotNeeded": bool(
            menu_scroll_changed or menu_target_already_visible or not menu_state["inMoreMenu"]
        ),
        "menuScrollChanged": menu_scroll_changed,
    }


def fullscreen_exit_probe(page: Any) -> dict[str, bool]:
    """Probe the safe-edge reveal handle and the expanded exit button separately."""
    return page.evaluate(
        """
        () => {
          const probe = (selector) => {
            const node = document.querySelector(selector);
            const rect = node?.getBoundingClientRect();
            const style = node ? getComputedStyle(node) : null;
            const rendered = Boolean(node && !node.hidden && style
              && style.display !== 'none' && style.visibility !== 'hidden'
              && rect && rect.width > 0 && rect.height > 0);
            const target44 = Boolean(rendered && rect.width >= 44 && rect.height >= 44);
            const fullViewportBounds = Boolean(rendered
              && rect.top >= -1 && rect.left >= -1
              && rect.bottom <= innerHeight + 1 && rect.right <= innerWidth + 1);
            const centerInViewport = Boolean(rendered
              && rect.left + rect.width / 2 >= 0
              && rect.left + rect.width / 2 <= innerWidth
              && rect.top + rect.height / 2 >= 0
              && rect.top + rect.height / 2 <= innerHeight);
            const hit = rect && centerInViewport
              ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
              : null;
            const hitTarget = Boolean(node && (hit === node || node.contains(hit)));
            return {
              rendered,
              target44,
              fullViewportBounds,
              hitTarget,
              available: target44 && fullViewportBounds && hitTarget,
            };
          };
          const reveal = probe('#fullscreenExitRevealBtn');
          const exit = probe('#exitFullscreenBtn');
          return {
            revealVisible: reveal.rendered,
            revealTarget44: reveal.target44,
            revealInsideViewport: reveal.fullViewportBounds,
            revealHitTarget: reveal.hitTarget,
            revealAvailable: reveal.available,
            exitVisibleAfterReveal: exit.rendered,
            exitTarget44AfterReveal: exit.target44,
            exitInsideViewportAfterReveal: exit.fullViewportBounds,
            exitHitTargetAfterReveal: exit.hitTarget,
            exitAvailableAfterReveal: exit.available,
          };
        }
        """
    )


def click_fullscreen_reveal(page: Any) -> dict[str, bool]:
    """Click the measured reveal handle through its native pointer path."""
    target = page.evaluate(
        """
        () => {
          const node = document.getElementById('fullscreenExitRevealBtn');
          const rect = node?.getBoundingClientRect();
          const style = node ? getComputedStyle(node) : null;
          const rendered = Boolean(node && !node.hidden && style
            && style.display !== 'none' && style.visibility !== 'hidden'
            && rect && rect.width > 0 && rect.height > 0);
          const centerInViewport = Boolean(rendered
            && rect.left + rect.width / 2 >= 0
            && rect.left + rect.width / 2 <= innerWidth
            && rect.top + rect.height / 2 >= 0
            && rect.top + rect.height / 2 <= innerHeight);
          const hit = rect && centerInViewport
            ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
            : null;
          return {
            available: Boolean(rendered && rect.width >= 44 && rect.height >= 44
              && rect.top >= -1 && rect.left >= -1
              && rect.bottom <= innerHeight + 1 && rect.right <= innerWidth + 1
              && node && (hit === node || node.contains(hit))),
            x: rendered ? rect.left + rect.width / 2 : 0,
            y: rendered ? rect.top + rect.height / 2 : 0,
          };
        }
        """
    )
    if not target["available"]:
        return {
            "revealHandleClicked": False,
            "exitAvailableAfterHandle": False,
        }
    page.mouse.click(float(target["x"]), float(target["y"]))
    wait_frames(page, 1)
    after = fullscreen_exit_probe(page)
    return {
        "revealHandleClicked": True,
        "exitAvailableAfterHandle": after["exitAvailableAfterReveal"],
    }


def click_fullscreen_exit(page: Any) -> dict[str, bool]:
    """Reveal the exit control explicitly, then click its measured hit target."""
    reveal = click_fullscreen_reveal(page)
    if not reveal["exitAvailableAfterHandle"]:
        return {**reveal, "exitButtonClicked": False, "exitLeavesFullscreen": False}
    target = page.evaluate(
        """
        () => {
          const node = document.getElementById('exitFullscreenBtn');
          const rect = node?.getBoundingClientRect();
          const style = node ? getComputedStyle(node) : null;
          const rendered = Boolean(node && !node.hidden && style
            && style.display !== 'none' && style.visibility !== 'hidden'
            && rect && rect.width > 0 && rect.height > 0);
          const centerInViewport = Boolean(rendered
            && rect.left + rect.width / 2 >= 0
            && rect.left + rect.width / 2 <= innerWidth
            && rect.top + rect.height / 2 >= 0
            && rect.top + rect.height / 2 <= innerHeight);
          const hit = rect && centerInViewport
            ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
            : null;
          return {
            available: Boolean(rendered && rect.width >= 44 && rect.height >= 44
              && rect.top >= -1 && rect.left >= -1
              && rect.bottom <= innerHeight + 1 && rect.right <= innerWidth + 1
              && node && (hit === node || node.contains(hit))),
            x: rendered ? rect.left + rect.width / 2 : 0,
            y: rendered ? rect.top + rect.height / 2 : 0,
          };
        }
        """
    )
    if not target["available"]:
        return {**reveal, "exitButtonClicked": False, "exitLeavesFullscreen": False}
    page.mouse.click(float(target["x"]), float(target["y"]))
    page.wait_for_function("() => document.fullscreenElement === null", timeout=3000)
    return {**reveal, "exitButtonClicked": True, "exitLeavesFullscreen": True}


def enter_native_fullscreen(page: Any) -> dict[str, bool]:
    target_before_click = prepare_fullscreen_button(page)
    page.locator('#fullscreenBtn').click(timeout=1000)
    page.wait_for_function("() => document.fullscreenElement === document.documentElement", timeout=3000)
    wait_frames(page, 5)
    return {
        "fullscreenButtonHitTargetBeforeClick": bool(
            target_before_click["visible"] and target_before_click["hitTarget"]
        ),
        "fullscreenButtonFullyInsideBeforeLocatorAutoscroll": target_before_click["preAutoscrollTarget"],
        "fullscreenButtonMenuScrollChangedOrNotNeeded": target_before_click[
            "menuScrollChangedOrNotNeeded"
        ],
        "fullscreenButtonMenuScrollChanged": target_before_click["menuScrollChanged"],
    }


def fullscreen_containment(page: Any, *, expect_text_visible: bool = False) -> dict[str, bool]:
    exit_probe = fullscreen_exit_probe(page)
    geometry = page.evaluate(
        """
        (expectTextVisible) => {
          const target = document.fullscreenElement;
          const viewer = document.querySelector('.viewer-container').getBoundingClientRect();
          const video = document.getElementById('remoteVideo').getBoundingClientRect();
          const text = document.getElementById('mobileInputDock');
          const statusNode = document.getElementById('statusBar');
          const docksNode = document.getElementById('chromeDocks');
          const textRect = text.getBoundingClientRect();
          const statusStyle = getComputedStyle(statusNode);
          const docksStyle = getComputedStyle(docksNode);
          const safeBottom = Number.parseFloat(
            getComputedStyle(document.getElementById('mobileSafeAreaProbe')).paddingBottom,
          ) || 0;
          const textVisible = !text.hidden && textRect.width > 0 && textRect.height > 0;
          const visibleTopValue = Number.parseFloat(
            document.documentElement.style.getPropertyValue('--mobile-visible-top'),
          );
          const visibleTop = Number.isFinite(visibleTopValue) ? visibleTopValue : 0;
          const expectedTextViewerBottom = innerHeight - textRect.height - safeBottom - 8;
          return {
            rootIsFullscreenTarget: target === document.documentElement,
            mobileDockContained: Boolean(target?.contains(document.getElementById('mobileInputDock'))),
            mobileKeysContained: Boolean(target?.contains(document.getElementById('mobileKeySurface'))),
            modalContained: Boolean(target?.contains(document.getElementById('textInputModal'))),
            statusChromeHidden: statusStyle.visibility === 'hidden' && statusStyle.pointerEvents === 'none',
            dockChromeHidden: docksStyle.visibility === 'hidden' && docksStyle.pointerEvents === 'none',
            viewerStartsAtVisibleTop: Math.abs(viewer.top - visibleTop) <= 1,
            viewerFillsVisibleViewportWithoutTextDock: textVisible
              || Math.abs(viewer.bottom - innerHeight) <= 1,
            viewerRetainsExistingTextReserve: !textVisible
              || Math.abs(viewer.bottom - expectedTextViewerBottom) <= 1,
            textDockDoesNotOverlapViewer: !textVisible || viewer.bottom <= textRect.top + 1,
            textDockStateAsExpected: textVisible === expectTextVisible,
            textInputFocusRetained: !textVisible || document.activeElement?.id === 'mobileTextInput',
            mediaFillsViewer: Math.abs(video.top - viewer.top) <= 1
              && Math.abs(video.left - viewer.left) <= 1
              && Math.abs(video.width - viewer.width) <= 1
              && Math.abs(video.height - viewer.height) <= 1,
          };
        }
        """,
        expect_text_visible,
    )
    return {
        **geometry,
        "revealTarget44": exit_probe["revealTarget44"],
        "revealHitTarget": exit_probe["revealHitTarget"],
        "revealInsideViewport": exit_probe["revealInsideViewport"],
        "exitTarget44AfterReveal": exit_probe["exitTarget44AfterReveal"],
        "exitHitTargetAfterReveal": exit_probe["exitHitTargetAfterReveal"],
        "exitInsideViewportAfterReveal": exit_probe["exitInsideViewportAfterReveal"],
        "exitAvailableAfterReveal": exit_probe["exitAvailableAfterReveal"],
    }


def resize_fixture_viewport(page: Any, width: int, height: int) -> None:
    page.set_viewport_size({"width": width, "height": height})
    page.evaluate(
        """
        () => {
          if (window.visualViewport) {
            window.visualViewport.height = innerHeight;
            window.visualViewport.offsetTop = 0;
            window.visualViewport.dispatchEvent(new Event('resize'));
          }
          window.dispatchEvent(new Event('resize'));
        }
        """
    )
    wait_frames(page, 4)


def scenario_fullscreen_native(browser: Any) -> dict[str, Any]:
    fixture = OfflineFixture(
        browser,
        width=1440,
        height=900,
        touch=True,
        include_terminal=True,
    )
    page = fixture.page
    checks: dict[str, bool] = {}
    try:
        if not page.evaluate("() => typeof document.documentElement.requestFullscreen === 'function'"):
            return result(
                "fullscreen-native-containment",
                "NOT RUN",
                reason="native-fullscreen-unsupported",
            )
        page.evaluate("() => TerminalPanel.init()")

        # Each viewport first exercises the real toggle's closed state.  The
        # text dock is opened as a separate phase below so its existing
        # reserve/focus contract cannot hide a fullscreen geometry defect.
        set_mobile_text_visible(page, False)
        wide_button = enter_native_fullscreen(page)
        wide = fullscreen_containment(page)
        set_mobile_text_visible(page, True)
        wide_text = fullscreen_containment(page, expect_text_visible=True)
        set_mobile_text_visible(page, False)

        # Terminal is the real tab lifecycle while the documentElement is
        # fullscreen; no socket/auth path is available in this fixture.
        page.evaluate("() => TerminalPanel.showTerminal()")
        wait_frames(page, 4)
        terminal = page.evaluate(
            """
            () => ({
              fullscreenRetained: document.fullscreenElement === document.documentElement,
              terminalVisible: !document.getElementById('terminalPanel').hidden
                && !document.getElementById('terminalPanel').classList.contains('hidden'),
              desktopHidden: document.getElementById('desktopPanel').hidden,
              terminalDomContained: document.documentElement.contains(document.getElementById('terminalWorkspace')),
              terminalNoSocketWithoutCredential: TerminalPanel.socket === null
                && TerminalPanel.hasAdminToken() === false,
            })
            """
        )
        terminal_reveal = click_fullscreen_reveal(page)
        terminal.update({
            "revealHandleClicked": terminal_reveal["revealHandleClicked"],
            "exitAvailableAfterHandle": terminal_reveal["exitAvailableAfterHandle"],
        })
        page.evaluate("() => document.getElementById('desktopTabBtn')?.click()")
        wait_frames(page, 4)
        desktop = page.evaluate(
            """
            () => ({
              fullscreenRetained: document.fullscreenElement === document.documentElement,
              terminalHidden: document.getElementById('terminalPanel').hidden,
              desktopVisible: !document.getElementById('desktopPanel').hidden,
              terminalInactive: !document.body.classList.contains('terminal-active'),
              managedLayoutRestored: document.body.classList.contains('mobile-layout-managed'),
            })
            """
        )

        idle = page.evaluate(
            """
            () => {
              document.body.classList.remove('chrome-idle');
              ChromeLayout.enterIdle();
              const fullscreenDoesNotWriteChromeIdle = !document.body.classList.contains('chrome-idle');
              document.body.classList.add('chrome-idle');
              ChromeLayout.enterIdle();
              return {
                fullscreenDoesNotWriteChromeIdle,
                preExistingChromeIdlePreserved: document.body.classList.contains('chrome-idle'),
              };
            }
            """
        )
        idle_reveal = click_fullscreen_reveal(page)
        idle.update({
            "revealHandleClicked": idle_reveal["revealHandleClicked"],
            "exitAvailableAfterHandle": idle_reveal["exitAvailableAfterHandle"],
        })

        # A lease loss cannot tear down documentElement fullscreen or remove
        # the independent safety exit; the lease is restored only for the narrow
        # re-entry portion below.
        page.evaluate("() => Input.setControlLease(null)")
        wait_frames(page, 3)
        lease_loss = page.evaluate(
            """
            () => ({
              leaseRemoved: Input.activeControlLease === null,
              fullscreenRetainedAfterLeaseLoss: document.fullscreenElement === document.documentElement,
            })
            """
        )
        first_exit = click_fullscreen_exit(page)
        lease_loss.update({
            "revealHandleClicked": first_exit["revealHandleClicked"],
            "exitAvailableAfterHandle": first_exit["exitAvailableAfterHandle"],
            "exitButtonClicked": first_exit["exitButtonClicked"],
        })

        page.evaluate(
            """
            () => {
              Input.setControlLease({ leaseId: 'offline-fullscreen-recover', leaseEpoch: 2 });
              Input.setActive(true);
            }
            """
        )
        resize_fixture_viewport(page, 375, 812)
        set_mobile_text_visible(page, False)
        narrow_button = enter_native_fullscreen(page)
        narrow = fullscreen_containment(page)
        set_mobile_text_visible(page, True)
        narrow_text = fullscreen_containment(page, expect_text_visible=True)
        set_mobile_text_visible(page, False)
        second_exit = click_fullscreen_exit(page)
        checks = {
            **{f"wide_{key}": value for key, value in wide.items()},
            **{f"wideText_{key}": value for key, value in wide_text.items()},
            **{f"terminal_{key}": value for key, value in terminal.items()},
            **{f"desktop_{key}": value for key, value in desktop.items()},
            **{f"idle_{key}": value for key, value in idle.items()},
            **{f"leaseLoss_{key}": value for key, value in lease_loss.items()},
            **{f"narrow_{key}": value for key, value in narrow.items()},
            **{f"narrowText_{key}": value for key, value in narrow_text.items()},
            "wideFullscreenButtonHitTargetBeforeClick": wide_button["fullscreenButtonHitTargetBeforeClick"],
            "wideFullscreenButtonFullyInsideBeforeLocatorAutoscroll": wide_button[
                "fullscreenButtonFullyInsideBeforeLocatorAutoscroll"
            ],
            "wideFullscreenButtonMenuScrollChangedOrNotNeeded": wide_button[
                "fullscreenButtonMenuScrollChangedOrNotNeeded"
            ],
            "narrowFullscreenButtonHitTargetBeforeClick": narrow_button["fullscreenButtonHitTargetBeforeClick"],
            "narrowFullscreenButtonFullyInsideBeforeLocatorAutoscroll": narrow_button[
                "fullscreenButtonFullyInsideBeforeLocatorAutoscroll"
            ],
            "narrowFullscreenButtonMenuScrollChangedOrNotNeeded": narrow_button[
                "fullscreenButtonMenuScrollChangedOrNotNeeded"
            ],
            "firstExitRevealHandleClicked": first_exit["revealHandleClicked"],
            "firstExitButtonClicked": first_exit["exitButtonClicked"],
            "firstExitClickLeavesFullscreen": first_exit["exitLeavesFullscreen"],
            "secondExitRevealHandleClicked": second_exit["revealHandleClicked"],
            "secondExitButtonClicked": second_exit["exitButtonClicked"],
            "secondExitClickLeavesFullscreen": second_exit["exitLeavesFullscreen"],
        }
        return result(
            "fullscreen-native-containment",
            "PASS" if all(checks.values()) else "FAIL",
            checks=checks,
            counts={"nativeEnter": 2, "nativeExit": 2, "terminalTransitions": 2},
        )
    except Exception:
        if not checks:
            try:
                probe = fullscreen_exit_probe(page)
                checks = {
                    "nativeFullscreenFlow": False,
                    "revealTarget44": probe["revealTarget44"],
                    "revealHitTarget": probe["revealHitTarget"],
                    "exitTarget44AfterReveal": probe["exitTarget44AfterReveal"],
                    "exitHitTargetAfterReveal": probe["exitHitTargetAfterReveal"],
                }
            except Exception:
                checks = {"nativeFullscreenFlow": False}
        return result("fullscreen-native-containment", "FAIL", checks=checks, reason="browser-action-failed")
    finally:
        fixture.close()


def scenario_fullscreen_fallback(browser: Any) -> dict[str, Any]:
    fixture = OfflineFixture(browser, width=1024, height=768, touch=True)
    page = fixture.page
    try:
        page.locator('#mobileTextInput').dispatch_event('compositionstart', {"bubbles": True})
        page.evaluate(
            """
            () => {
              document.documentElement.requestFullscreen = undefined;
              document.querySelector('.viewer-container').requestFullscreen = undefined;
            }
            """
        )
        target_before_click = prepare_fullscreen_button(page)
        page.locator('#fullscreenBtn').click(timeout=1000)
        composing_state = safe_state(page)
        missing_api = page.evaluate(
            """
            () => {
              const hint = document.getElementById('fullscreenStatus');
              const rect = hint.getBoundingClientRect();
              const style = getComputedStyle(hint);
              return {
                ordinaryViewRetained: document.fullscreenElement === null,
                mobileFocusPreserved: document.activeElement?.id === 'mobileTextInput',
                compositionPreserved: Input.mobileTextInputAdapter?.getSnapshot?.().composing === true,
                fallbackHintVisible: !hint.hidden && style.display !== 'none' && style.visibility !== 'hidden'
                  && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight
                  && rect.right > 0 && rect.left < innerWidth,
                ariaNotPretendingSuccess: document.getElementById('fullscreenBtn').getAttribute('aria-pressed') !== 'true',
              };
            }
            """
        )

        # Also exercise a real promise rejection with a draft, not only a
        # missing API.  The draft is anchored to the current accepted prefix
        # and the rejection must keep both draft state and focus local.
        page.locator('#mobileTextInput').dispatch_event('compositionend', {"bubbles": True})
        page.evaluate(
            """
            () => {
              const controller = Input.keyboardController;
              globalThis.__offlineFallbackOriginalSendText = controller.sendText.bind(controller);
              controller.sendText = () => false;
            }
            """
        )
        dispatch_pending_mobile_draft(page, "fallback")
        draft_before_reject = safe_state(page)
        page.evaluate(
            """
            () => {
              document.documentElement.requestFullscreen = () => Promise.reject(new Error('offline-rejected'));
            }
            """
        )
        rejection_target = prepare_fullscreen_button(page)
        page.locator('#fullscreenBtn').click(timeout=1000)
        wait_frames(page, 2)
        rejected_state = safe_state(page)
        rejection_checks = page.evaluate(
            """
            () => {
              const hint = document.getElementById('fullscreenStatus');
              const rect = hint.getBoundingClientRect();
              const style = getComputedStyle(hint);
              return {
                ordinaryViewRetained: document.fullscreenElement === null,
                fallbackHintVisible: !hint.hidden && style.display !== 'none' && style.visibility !== 'hidden'
                  && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight,
                ariaNotPretendingSuccess: document.getElementById('fullscreenBtn').getAttribute('aria-pressed') !== 'true',
              };
            }
            """
        )
        page.evaluate(
            "() => { Input.keyboardController.sendText = globalThis.__offlineFallbackOriginalSendText; "
            "Input.mobileTextInputAdapter.discardPending(); }"
        )
        checks = {
            **{f"missingApi_{key}": value for key, value in missing_api.items()},
            **{f"rejected_{key}": value for key, value in rejection_checks.items()},
            "missingApiButtonHitTargetBeforeClick": bool(target_before_click["visible"] and target_before_click["hitTarget"]),
            "missingApiButtonFullyInsideBeforeLocatorAutoscroll": target_before_click[
                "preAutoscrollTarget"
            ],
            "missingApiMenuScrollChangedOrNotNeeded": target_before_click[
                "menuScrollChangedOrNotNeeded"
            ],
            "missingApiMenuScrollChanged": target_before_click["menuScrollChanged"],
            "rejectedButtonHitTargetBeforeClick": bool(rejection_target["visible"] and rejection_target["hitTarget"]),
            "rejectedButtonFullyInsideBeforeLocatorAutoscroll": rejection_target[
                "preAutoscrollTarget"
            ],
            "rejectedMenuScrollChangedOrNotNeeded": rejection_target[
                "menuScrollChangedOrNotNeeded"
            ],
            "missingApiCompositionState": composing_state["mobileStatus"] == "composing",
            "rejectedDraftRetained": draft_before_reject["mobilePending"] is True
                and rejected_state["mobilePending"] is True,
            "rejectedFocusRetained": rejected_state["activeElement"] == "mobileTextInput",
        }
        return result("fullscreen-fallback-focus", "PASS" if all(checks.values()) else "FAIL", checks=checks)
    finally:
        fixture.close()


def run_browser_suite(browser: Any) -> list[dict[str, Any]]:
    runners: tuple[Callable[[Any], dict[str, Any]], ...] = (
        scenario_focus,
        scenario_text_transaction,
        scenario_physical_keyup,
        scenario_surface_confirmation,
        scenario_modal,
        scenario_collapse_reopen,
        scenario_virtual_modifier,
        scenario_unsupported,
        scenario_recovery_layout,
        scenario_retry_button,
        scenario_trace_observability,
        scenario_timeout_incident_eligibility,
        scenario_deferred_incident_eligibility,
        scenario_blocked_gate_incident,
        scenario_release_ack_loss,
        scenario_desktop_draft_entry,
        scenario_browser_signal_ingestion,
        scenario_draft_retention_exactness,
        scenario_layout_matrix,
        scenario_terminal_lifecycle,
        scenario_fullscreen_native,
        scenario_fullscreen_fallback,
    )
    results: list[dict[str, Any]] = []
    for runner in runners:
        name = runner.__name__.removeprefix("scenario_").replace("_", "-")
        try:
            results.append(runner(browser))
        except Exception:
            results.append(result(name, "FAIL", checks={"scenarioCompleted": False}, reason="browser-action-failed"))
    return results


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    OFFLINE_NETWORK_STATS["requests"] = 0
    OFFLINE_NETWORK_STATS["sensitivePayloads"] = 0
    artifact_base = {
        "scope": "offline-synthetic",
        "browser": args.browser,
        "network": OFFLINE_NETWORK_STATS.copy(),
        "scenarios": [],
    }
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        artifact_base["scenarios"] = not_run_results("browser-runtime-missing")
        write_json(args.out, artifact_base)
        print(json.dumps(artifact_base, ensure_ascii=False))
        return 2

    try:
        playwright_context = sync_playwright()
        playwright = playwright_context.start()
    except Exception:
        artifact_base["scenarios"] = not_run_results("browser-runtime-missing")
        write_json(args.out, artifact_base)
        print(json.dumps(artifact_base, ensure_ascii=False))
        return 2

    browser = None
    browser_launched = False
    launch_failed = False
    postlaunch_failure = False
    try:
        browser_type = getattr(playwright, args.browser, None)
        if browser_type is None:
            launch_failed = True
            artifact_base["scenarios"] = not_run_results("browser-runtime-missing")
        else:
            try:
                browser = browser_type.launch(headless=True)
                browser_launched = browser is not None
            except Exception:
                launch_failed = True
                artifact_base["scenarios"] = not_run_results("browser-runtime-missing")
            if not launch_failed:
                try:
                    artifact_base["scenarios"] = run_browser_suite(browser)
                except Exception:
                    # A launched browser means the runtime exists.  Preserve a
                    # safe FAIL artifact instead of misclassifying a
                    # suite/cleanup defect as missing browser dependencies.
                    artifact_base["scenarios"] = [
                        result(name, "FAIL", checks={"suiteCompleted": False}, reason="browser-action-failed")
                        for name in SCENARIO_NAMES
                    ]
    finally:
        try:
            if browser is not None:
                browser.close()
        except Exception:
            if browser_launched:
                postlaunch_failure = True
        try:
            # ``sync_playwright().start()`` returns the started Playwright
            # facade; the context-manager helper itself has no ``stop``
            # method.  Keep teardown explicit so a real browser run cannot
            # be reported as a synthetic cleanup failure.
            playwright.stop()
        except Exception:
            if browser_launched:
                postlaunch_failure = True

    if launch_failed:
        write_json(args.out, artifact_base)
        print(json.dumps(artifact_base, ensure_ascii=False))
        return 2
    if postlaunch_failure:
        # Preserve every collected scenario and expose cleanup failure as a
        # safe FAIL result; never turn an already-started browser into NOT RUN.
        artifact_base["scenarios"].append(
            result("runtime-cleanup", "FAIL", checks={"cleanupCompleted": False}, reason="browser-action-failed")
        )

    artifact_base["network"] = OFFLINE_NETWORK_STATS.copy()
    write_json(args.out, artifact_base)
    print(json.dumps(artifact_base, ensure_ascii=False))
    return 1 if any(item["status"] == "FAIL" for item in artifact_base["scenarios"]) else 0


if __name__ == "__main__":
    sys.exit(main())
