#!/usr/bin/env python3
"""Lifecycle collector for the isolated controlled-scene laboratory.

It owns only the LabRun it creates.  It can run the signal/Host/static Viewer
phase without a dedicated desktop; automatic actions are stopped immediately
before dispatch when that desktop precondition is absent.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import secrets
import subprocess
import sys
import threading
import time
from dataclasses import asdict, dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol

from turn_controlled_scene import BLOCKED, FAIL, NOT_RUN, PASS, ProducerProof
from turn_controlled_scene_runtime import (MarkerLayout, aggregate_action_evidence,
                                           FixtureBroker, exact_workload, run_automatic_scene,
                                           static_text_evidence, work_steps, workload_failures,
                                           workload_record)


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def lifecycle_failure(error: Exception) -> str:
    """Persist a bounded lifecycle category, never exception text or secrets."""
    if str(error) == "production proof admission was not granted for the observed epoch":
        return f"lifecycle:{type(error).__name__}:production-proof-admission-epoch-mismatch"
    return f"lifecycle:{type(error).__name__}"


def resolve_viewer_token(args: Any, *, environ: Mapping[str, str] | None = None) -> str | None:
    direct = getattr(args, "viewer_token", None)
    if isinstance(direct, str) and direct:
        return direct
    env_name = getattr(args, "viewer_token_env", None)
    value = (environ or os.environ).get(env_name) if isinstance(env_name, str) and env_name else None
    return value if isinstance(value, str) and value else None


@dataclass(frozen=True)
class LabTranscript:
    identity: dict[str, Any]
    static: dict[str, Any]
    automatic: dict[str, Any]
    receipts: list[dict[str, Any]]
    signature: str

    @classmethod
    def create(cls, *, verifier: bytes, identity: Mapping[str, Any], static: Mapping[str, Any], automatic: Mapping[str, Any], receipts: list[Mapping[str, Any]]) -> "LabTranscript":
        if not isinstance(verifier, bytes) or not verifier:
            raise ValueError("captured Lab transcript verifier is required")
        body = {"identity": dict(identity), "static": dict(static), "automatic": dict(automatic), "receipts": [dict(row) for row in receipts]}
        return cls(body["identity"], body["static"], body["automatic"], body["receipts"], hmac.new(verifier, _canonical(body), hashlib.sha256).hexdigest())

    def as_dict(self) -> dict[str, Any]:
        return {"identity": self.identity, "static": self.static, "automatic": self.automatic,
                "receipts": self.receipts, "signature": self.signature}


def verify_transcript(raw: Mapping[str, Any], *, identity: Mapping[str, Any], verifier: bytes) -> bool:
    if not isinstance(raw, Mapping) or set(raw) != {"identity", "static", "automatic", "receipts", "signature"}:
        return False
    if raw["identity"] != dict(identity) or not isinstance(raw["receipts"], list) or not isinstance(raw["signature"], str) or not isinstance(verifier, bytes):
        return False
    body = {key: raw[key] for key in ("identity", "static", "automatic", "receipts")}
    expected = hmac.new(verifier, _canonical(body), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, raw["signature"])


class StaticViewer(Protocol):
    def static_frames(self, layout: MarkerLayout) -> list[dict[str, Any]]: ...


class ExecutableLabDriver:
    """Dispatch the declared controlled workload through the existing Viewer path.

    This driver deliberately has no input-emission implementation of its own.
    The Viewer adapter must call ``Input.prepareLabInput`` and
    ``Input.dispatchPreparedLabInput``; the Lab Host claims the resulting
    normal v2 envelope through its existing binding guard.  A failed evidence
    boundary makes the complete workload fail -- receipts are never invented.
    """

    def __init__(self, *, lab_run: Any, viewer: Any, producer: Any, broker: Any, fixture_id: str) -> None:
        if not isinstance(fixture_id, str) or not fixture_id:
            raise ValueError("a fixture id is required for controlled dispatch")
        self.lab_run, self.viewer, self.producer, self.broker = lab_run, viewer, producer, broker
        self.fixture_id = fixture_id

    def run(self) -> dict[str, Any]:
        receipts: list[dict[str, Any]] = []
        failures: list[str] = []
        workload = list(exact_workload())
        completed_workload: list[dict[str, Any]] = []
        for item in workload:
            drag_started = False
            try:
                for step in work_steps(item):
                    reservation = self.viewer.prepare_lab_input(step)
                    if not isinstance(reservation, Mapping):
                        raise RuntimeError("viewer-lab-input-not-prepared")
                    input_id, lease_id, lease_epoch = reservation.get("inputId"), reservation.get("leaseId"), reservation.get("leaseEpoch")
                    action = {key: reservation.get(key) for key in ("type", "action", "payload")}
                    if (not isinstance(input_id, str) or not input_id or not isinstance(lease_id, str) or not lease_id
                            or not isinstance(lease_epoch, int) or isinstance(lease_epoch, bool) or lease_epoch < 0
                            or not isinstance(action["type"], str) or not isinstance(action["action"], str)
                            or not isinstance(action["payload"], Mapping)):
                        raise RuntimeError("viewer-lab-input-metadata-invalid")
                    self.broker.reserve(input_id=input_id, action_id=step.action_id)
                    self.lab_run.bind_controlled_input(input_id=input_id, lease_id=lease_id, lease_epoch=lease_epoch,
                                                        fixture_id=self.fixture_id, action=action)
                    self.producer.prepare_native_action(step.action_id)
                    dispatched = self.viewer.dispatch_prepared_lab_input(reservation)
                    if dispatched != input_id:
                        raise RuntimeError("viewer-lab-input-dispatch-refused")
                    if step.kind == "drag" and step.phase == "down":
                        drag_started = True
                    ack = self.viewer.wait_for_applied_ack(input_id)
                    claim = self.lab_run.wait_for_controlled_claim(input_id)
                    receipt = self.broker.wait_for_receipt(input_id)
                    visual = self.viewer.wait_for_decoded_visual(input_id, step.action_id)
                    result = aggregate_action_evidence(reservation=reservation, ack=ack, claim=claim, receipt=receipt, visual=visual)
                    if result["status"] != PASS:
                        raise RuntimeError(str(result.get("failure") or "five-way-evidence-failed"))
                    receipts.append({"inputId": input_id, "actionId": step.action_id, "logicalActionId": item.action_id, "markerActionId": step.action_id,
                                     "kind": item.kind, "phase": step.phase,
                                     # The exact T5 transcript carries text on
                                     # the keyboard submission boundary only;
                                     # focus steps are mouse actions.
                                     **({"text": item.text} if step.kind == "text" and step.phase == "text" else {}),
                                     "reservation": dict(reservation),
                                     "binding": {"fixtureId": self.fixture_id, "leaseId": lease_id, "leaseEpoch": lease_epoch, "action": action},
                                     "claim": dict(claim), "ack": dict(ack), "native": dict(receipt), "visual": dict(visual)})
                    if step.kind == "drag" and step.phase == "up":
                        drag_started = False
                completed_workload.append(workload_record(item))
            except Exception as error:
                failures.append(f"action-{item.action_id}:{type(error).__name__}:{error}")
                break
            finally:
                if drag_started:
                    try:
                        self.viewer.dispatch_safety_release()
                    except Exception:
                        failures.append(f"action-{item.action_id}:safety-release-failed")
        workload_rows = [{"kind": row["kind"], "actionId": row["actionId"],
                          **({"text": row["text"]} if "text" in row else {})}
                         for row in completed_workload]
        failures.extend(workload_failures(workload_rows))
        return {"status": PASS if not failures else FAIL, "executionMode": "automatic-isolated",
                "workload": [workload_record(item) for item in workload], "receipts": receipts,
                "failures": failures}


class LoopbackFixtureReceiver:
    """Receive browser-native fixture events on a per-run loopback listener.

    The receiver carries no Viewer input id in its request contract.  It gives
    an id to the event only by asking the proof-bound ``FixtureBroker`` for a
    matching pending action.  CORS is limited to the disposable local producer
    page's opaque origin; the socket itself is loopback-only.
    """

    def __init__(self, broker: FixtureBroker) -> None:
        self.broker = broker
        self._condition = threading.Condition()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, _format: str, *_args: Any) -> None: pass

            def _headers(self, status: int) -> None:
                self.send_response(status)
                self.send_header("Access-Control-Allow-Origin", "null")
                self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.end_headers()

            def do_OPTIONS(self) -> None: self._headers(204)

            def do_POST(self) -> None:
                if self.path != "/native-event":
                    self._headers(404); return
                try:
                    length = int(self.headers.get("Content-Length", "-1"))
                    if length < 2 or length > 8192:
                        raise ValueError("invalid body size")
                    raw = json.loads(self.rfile.read(length).decode("utf-8"))
                    if not isinstance(raw, Mapping):
                        raise ValueError("event must be an object")
                    receipt = owner.broker.record_native_event(raw)
                except Exception:
                    self._headers(400); return
                with owner._condition:
                    owner._condition.notify_all()
                self._headers(202 if receipt is not None else 409)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        port = int(self._server.server_address[1])
        self.endpoint = f"http://127.0.0.1:{port}/native-event"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def __enter__(self) -> "LoopbackFixtureReceiver":
        self._thread.start()
        return self

    def reserve(self, *, input_id: str, action_id: int) -> None:
        self.broker.reserve(input_id=input_id, action_id=action_id)

    def __exit__(self, *_args: Any) -> None:
        self._server.shutdown(); self._server.server_close(); self._thread.join(timeout=2)

    def wait_for_receipt(self, input_id: str, *, timeout_seconds: float = 10) -> dict[str, Any] | None:
        deadline = time.monotonic() + timeout_seconds
        with self._condition:
            while True:
                receipt = self.broker.receipt_for(input_id)
                if receipt is not None:
                    return receipt
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self._condition.wait(remaining)


class PlaywrightLabViewerAdapter:
    """Concrete isolated Viewer adapter; it uses no OS input APIs.

    The producer browser tab is intentionally separate from the Viewer tab.
    A real fixture desktop must display that producer before decoded static
    frames can pass; this adapter reports the missing visual evidence instead
    of fabricating it.
    """
    def __init__(self, *, playwright: Any, browser: Any, context: Any, viewer_page: Any, producer_page: Any, headed_producer: bool) -> None:
        self._playwright, self._browser, self._context = playwright, browser, context
        self.viewer_page, self.producer_page = viewer_page, producer_page
        self._headed_producer = headed_producer
        self._fixture_geometry: dict[str, dict[str, float]] | None = None

    @classmethod
    def open(cls, lab_run: Any, proof: ProducerProof, *, headed_producer: bool = False) -> "PlaywrightLabViewerAdapter":
        from turn_runtime_collector import _json_request, seed_viewer_storage, start_viewer, wait_for_healthy_relay
        from playwright.sync_api import sync_playwright
        credentials = lab_run.viewer_credentials()
        status, login = _json_request(f"{credentials['origin']}/api/auth/login", method="POST", body={"password": credentials["password"]})
        if status != 200 or not isinstance(login.get("token"), str):
            raise RuntimeError("isolated Lab Viewer login failed")
        playwright = sync_playwright().start()
        # A headed browser is the minimum producer fixture that can be seen by
        # MSS on a disposable desktop.  Headless remains diagnostic-only.
        browser = playwright.chromium.launch(headless=not headed_producer)
        context = browser.new_context(viewport={"width": 1440, "height": 960})
        try:
            seed_viewer_storage(context, login["token"], credentials["proofAdmission"])
            viewer = context.new_page(); viewer.goto(f"{credentials['origin']}/viewer.html", wait_until="domcontentloaded", timeout=45000)
            start_viewer(viewer); wait_for_healthy_relay(viewer)
            producer_url = Path(__file__).with_name("turn-runtime-controlled-producer.html").as_uri()
            producer_url += f"?runNonce={proof.run_nonce}&sceneId={proof.scene_id}"
            producer = context.new_page(); producer.goto(producer_url, wait_until="domcontentloaded")
            return cls(playwright=playwright, browser=browser, context=context, viewer_page=viewer, producer_page=producer, headed_producer=headed_producer)
        except Exception:
            browser.close(); playwright.stop(); raise

    def static_frames(self, layout: MarkerLayout) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for _ in range(61):
            row = self.viewer_page.evaluate("() => WebRTC.frameTraceCollector?.takeControlledVisualEvidence?.()?.[0] || null")
            if isinstance(row, dict):
                rows.append(row)
            self.viewer_page.wait_for_timeout(1000)
        return rows

    def set_producer_proof(self, proof: ProducerProof) -> None:
        """Reload the independent fixture with the scope proven by Viewer."""
        url = Path(__file__).with_name("turn-runtime-controlled-producer.html").as_uri()
        self.producer_page.goto(f"{url}?runNonce={proof.run_nonce}&sceneId={proof.scene_id}", wait_until="domcontentloaded")

    def _input_spec(self, item: Any) -> dict[str, Any]:
        """Map the immutable work declaration to the existing v2 input API."""
        geometry = self._fixture_geometry
        if not isinstance(geometry, Mapping):
            raise RuntimeError("producer-fixture-geometry-is-not-proven")
        def payload(name: str, **extra: Any) -> dict[str, Any]:
            point = geometry.get(name)
            if not isinstance(point, Mapping):
                raise RuntimeError("producer-fixture-geometry-is-not-proven")
            return {"relX": point["relX"], "relY": point["relY"], **extra}
        if item.kind == "scroll" and item.phase == "wheel":
            return {"type": "mouse", "action": "wheel",
                    "payload": payload("scroll", deltaX=0, deltaY=80)}
        if item.kind == "drag" and item.phase == "down":
            # The Host's normal mouse down path is the causal start of every
            # drag.  Dedicated-fixture runs retain the pending button state
            # only on their disposable desktop; a no-input rehearsal never
            # reaches this method.
            return {"type": "mouse", "action": "down",
                    "payload": payload("dragStart", button="left", buttons=1, clickCount=1)}
        if item.kind == "drag" and item.phase == "move":
            return {"type": "mouse", "action": "move",
                    "payload": payload("dragEnd", buttons=1)}
        if item.kind == "drag" and item.phase == "up":
            return {"type": "mouse", "action": "up",
                    "payload": payload("dragEnd", button="left", buttons=0)}
        if item.kind == "text" and item.phase == "focus-down":
            return {"type": "mouse", "action": "down",
                    "payload": payload("text", button="left", buttons=1, clickCount=1)}
        if item.kind == "text" and item.phase == "focus-up":
            return {"type": "mouse", "action": "up",
                    "payload": payload("text", button="left", buttons=0)}
        if item.kind == "text" and item.phase == "text":
            return {"type": "keyboard", "action": "text", "payload": {"text": item.text}}
        raise ValueError("unknown controlled workload item")

    def prepare_lab_input(self, item: Any) -> dict[str, Any] | None:
        spec = self._input_spec(item)
        return self.viewer_page.evaluate("""(spec) => {
          if (!window.Input?.prepareLabInput || !window.Input?.activeControlLease) return null;
          const reservation = window.Input.prepareLabInput(spec.type, spec.action, spec.payload);
          const lease = window.Input.activeControlLease;
          if (!reservation || !lease?.leaseId || !Number.isInteger(lease.leaseEpoch)) return null;
          const pending = window.__wrdLabPreparedInputs || (window.__wrdLabPreparedInputs = new Map());
          pending.set(reservation.inputId, reservation);
          return { inputId: reservation.inputId, leaseId: lease.leaseId, leaseEpoch: lease.leaseEpoch,
                   type: spec.type, action: spec.action, payload: spec.payload };
        }""", spec)

    def dispatch_prepared_lab_input(self, reservation: Mapping[str, Any]) -> str | None:
        input_id = reservation.get("inputId") if isinstance(reservation, Mapping) else None
        if not isinstance(input_id, str) or not input_id:
            return None
        return self.viewer_page.evaluate("""(inputId) => {
          const pending = window.__wrdLabPreparedInputs;
          const reservation = pending?.get(inputId);
          if (!reservation || !window.Input?.dispatchPreparedLabInput) return null;
          pending.delete(inputId);
          return window.Input.dispatchPreparedLabInput(reservation);
        }""", input_id)

    def dispatch_safety_release(self) -> str | None:
        """Use the normal Viewer safety-release path after an incomplete drag."""
        geometry = self._fixture_geometry
        if not isinstance(geometry, Mapping) or not isinstance(geometry.get("dragEnd"), Mapping):
            return None
        point = geometry["dragEnd"]
        return self.viewer_page.evaluate("""(point) =>
          window.Input?.sendInput?.('mouse', 'up', { relX: point.relX, relY: point.relY, button: 'left', buttons: 0 }) || null
        """, point)

    def acquire_controlled_lease(self, *, timeout_seconds: float = 15) -> dict[str, Any] | None:
        """Request the normal Viewer lease only in the dedicated input branch."""
        if not self.viewer_page.evaluate("() => !!window.WebRTC?.hasActiveControl?.()"):
            self.viewer_page.locator("#requestControlBtn").click()
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            lease = self.viewer_page.evaluate("""() => {
              const lease = window.Input?.activeControlLease;
              return lease && typeof lease.leaseId === 'string' && Number.isInteger(lease.leaseEpoch)
                ? { leaseId: lease.leaseId, leaseEpoch: lease.leaseEpoch } : null;
            }""")
            if isinstance(lease, dict) and isinstance(lease.get("leaseId"), str) and lease["leaseId"] and isinstance(lease.get("leaseEpoch"), int):
                return lease
            self.viewer_page.wait_for_timeout(100)
        return None

    def install_input_ack_observer(self) -> None:
        self.viewer_page.evaluate("""() => {
          const state = window.__wrdLabInputEvidence || (window.__wrdLabInputEvidence = { acks: [], bound: false });
          if (state.bound || !window.Input) return;
          state.bound = true;
          for (const name of ['acceptMouseAck', 'acceptKeyboardAck']) {
            const original = window.Input[name];
            if (typeof original !== 'function') continue;
            window.Input[name] = function(ack) {
              const ids = Array.isArray(ack?.inputIds) ? ack.inputIds : [];
              for (const inputId of ids) state.acks.push({ inputId, status: ack?.status || null });
              return original.call(this, ack);
            };
          }
        }""")

    def wait_for_applied_ack(self, input_id: str, *, timeout_seconds: float = 10) -> dict[str, Any] | None:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            row = self.viewer_page.evaluate("""(inputId) => {
              const rows = window.__wrdLabInputEvidence?.acks || [];
              const index = rows.findIndex((row) => row?.inputId === inputId);
              return index < 0 ? null : rows.splice(index, 1)[0];
            }""", input_id)
            if isinstance(row, dict) and row.get("status") == "applied":
                return row
            self.viewer_page.wait_for_timeout(100)
        return None

    def wait_for_decoded_visual(self, input_id: str, action_id: int, *, timeout_seconds: float = 10) -> dict[str, Any] | None:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            rows = self.viewer_page.evaluate("() => WebRTC.frameTraceCollector?.takeControlledVisualEvidence?.() || []")
            if isinstance(rows, list):
                for row in rows:
                    if isinstance(row, dict) and row.get("marker", {}).get("actionId") == action_id:
                        return {"inputId": input_id, **row}
            self.viewer_page.wait_for_timeout(100)
        return None

    def configure_loopback_producer(self, *, endpoint: str, proof: ProducerProof, layout: MarkerLayout) -> None:
        identity = {"runNonce": str(proof.run_nonce), "sceneId": proof.scene_id, "attemptId": proof.attempt_id,
                    "generation": proof.generation, "realm": proof.realm, "runId": proof.run_id,
                    "sourceWidth": layout.source_width, "sourceHeight": layout.source_height,
                    "roi": list(layout.roi), "layoutDigest": layout.layout_digest}
        configured = self.producer_page.evaluate("""({ endpoint, identity }) => {
          const api = window.WRDTurnControlledProducer;
          if (!api?.configureLoopbackProducer) return false;
          api.configureLoopbackProducer({ endpoint, identity });
          return true;
        }""", {"endpoint": endpoint, "identity": identity})
        if configured is not True:
            raise RuntimeError("producer-loopback-configuration-refused")

    def calibrate_marker_roi(self, *, source_width: int, source_height: int) -> tuple[int, int, int, int]:
        """Project the runtime producer canvas into encoded-video pixels.

        This is an estimate from the actual browser-window and canvas geometry,
        never the old fixed 64x48 test ROI.  The subsequent independent marker
        decode remains authoritative and turns a bad projection into FAIL.
        """
        raw = self.producer_page.evaluate("""() => {
          const marker = document.getElementById('marker');
          if (!marker) return null;
          const box = marker.getBoundingClientRect();
          const style = getComputedStyle(marker);
          return { left: box.left, top: box.top, width: box.width, height: box.height,
                   contentWidth: marker.width, contentHeight: marker.height,
                   borderLeft: parseFloat(style.borderLeftWidth), borderTop: parseFloat(style.borderTopWidth),
                   screenX: window.screenX, screenY: window.screenY,
                   outerWidth: window.outerWidth, outerHeight: window.outerHeight,
                   innerWidth: window.innerWidth, innerHeight: window.innerHeight,
                   screenWidth: window.screen.width, screenHeight: window.screen.height,
                   dpr: window.devicePixelRatio };
        }""")
        required = ("left", "top", "width", "height", "contentWidth", "contentHeight", "borderLeft", "borderTop",
                    "screenX", "screenY", "outerWidth", "outerHeight", "innerWidth", "innerHeight", "screenWidth", "screenHeight", "dpr")
        if not isinstance(raw, Mapping) or not all(isinstance(raw.get(key), (int, float)) for key in required):
            raise RuntimeError("producer-marker-runtime-geometry-unavailable")
        if (raw["contentWidth"] != 256 or raw["contentHeight"] != 128
                or raw["width"] < raw["contentWidth"] or raw["height"] < raw["contentHeight"]
                or raw["borderLeft"] < 0 or raw["borderTop"] < 0
                or raw["screenWidth"] <= 0 or raw["screenHeight"] <= 0):
            raise RuntimeError("producer-marker-runtime-geometry-invalid")
        border_x = max(0.0, (float(raw["outerWidth"]) - float(raw["innerWidth"])) / 2)
        chrome_y = max(0.0, float(raw["outerHeight"]) - float(raw["innerHeight"]) - border_x)
        # getBoundingClientRect includes the fixture's decorative border;
        # marker decoding is for the canvas pixels inside that border.
        x_css = float(raw["screenX"]) + border_x + float(raw["left"]) + float(raw["borderLeft"])
        y_css = float(raw["screenY"]) + chrome_y + float(raw["top"]) + float(raw["borderTop"])
        x = round(x_css * source_width / float(raw["screenWidth"]))
        y = round(y_css * source_height / float(raw["screenHeight"]))
        return MarkerLayout.create(attempt_id="calibration", generation=0, source_width=source_width,
                                   source_height=source_height, roi=(x, y, 256, 128)).roi

    def calibrate_fixture_input_geometry(self, *, source_width: int, source_height: int) -> dict[str, dict[str, float]]:
        """Map actual fixture DOM points through window content and Host capture.

        The mapping is explicit: CSS element coordinates are shifted by the
        observed browser chrome/content origin into screen CSS coordinates,
        then scaled into the current decoded Host source. It is rejected if
        any point falls outside the measured window/screen/source bounds.
        """
        raw = self.producer_page.evaluate("""() => {
          const box = (id) => {
            const element = document.getElementById(id);
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
          };
          return { scroll: box('scroll'), drag: box('drag'), text: box('text'),
            screenX: window.screenX, screenY: window.screenY, outerWidth: window.outerWidth,
            outerHeight: window.outerHeight, innerWidth: window.innerWidth, innerHeight: window.innerHeight,
            screenWidth: window.screen.width, screenHeight: window.screen.height, dpr: window.devicePixelRatio };
        }""")
        scalar = ("screenX", "screenY", "outerWidth", "outerHeight", "innerWidth", "innerHeight", "screenWidth", "screenHeight", "dpr")
        if (not isinstance(raw, Mapping) or source_width <= 0 or source_height <= 0
                or not all(isinstance(raw.get(key), (int, float)) for key in scalar)
                or any(float(raw[key]) <= 0 for key in ("outerWidth", "outerHeight", "innerWidth", "innerHeight", "screenWidth", "screenHeight", "dpr"))):
            raise RuntimeError("producer-fixture-geometry-unavailable")
        boxes = {name: raw.get(name) for name in ("scroll", "drag", "text")}
        if not all(isinstance(box, Mapping) and all(isinstance(box.get(key), (int, float)) and float(box[key]) > 0 for key in ("width", "height")) for box in boxes.values()):
            raise RuntimeError("producer-fixture-geometry-invalid")
        border_x = max(0.0, (float(raw["outerWidth"]) - float(raw["innerWidth"])) / 2)
        chrome_y = max(0.0, float(raw["outerHeight"]) - float(raw["innerHeight"]) - border_x)
        def project(box: Mapping[str, Any], x_fraction: float, y_fraction: float) -> dict[str, float]:
            css_x, css_y = float(box["left"]) + float(box["width"]) * x_fraction, float(box["top"]) + float(box["height"]) * y_fraction
            if not (0 <= css_x <= float(raw["innerWidth"]) and 0 <= css_y <= float(raw["innerHeight"])):
                raise RuntimeError("producer-fixture-geometry-outside-window-content")
            screen_x, screen_y = float(raw["screenX"]) + border_x + css_x, float(raw["screenY"]) + chrome_y + css_y
            source_x = screen_x * source_width / float(raw["screenWidth"]); source_y = screen_y * source_height / float(raw["screenHeight"])
            if not (0 <= source_x < source_width and 0 <= source_y < source_height):
                raise RuntimeError("producer-fixture-geometry-outside-host-capture")
            return {"relX": source_x / source_width, "relY": source_y / source_height,
                    "sourceX": source_x, "sourceY": source_y, "dpr": float(raw["dpr"])}
        geometry = {"scroll": project(boxes["scroll"], .5, .5), "dragStart": project(boxes["drag"], .25, .5),
                    "dragEnd": project(boxes["drag"], .75, .5), "text": project(boxes["text"], .5, .5)}
        self._fixture_geometry = geometry
        return geometry

    def configure_marker_roi(self, layout: MarkerLayout) -> None:
        x, y, width, height = layout.roi
        configured = self.viewer_page.evaluate("""(roi) =>
          Boolean(window.WebRTC?.configureControlledSceneMarkerRoi?.(roi))
        """, {"x": x, "y": y, "width": width, "height": height})
        if configured is not True:
            raise RuntimeError("viewer-controlled-marker-roi-configuration-refused")

    def prepare_native_action(self, action_id: int) -> None:
        result = self.producer_page.evaluate("""(actionId) => {
          if (!window.WRDTurnControlledProducer?.prepareNativeAction) return false;
          window.WRDTurnControlledProducer.prepareNativeAction(actionId);
          return true;
        }""", action_id)
        if result is not True:
            raise RuntimeError("producer-native-action-preparation-refused")

    def viewer_session_identity(self) -> dict[str, Any] | None:
        row = self.viewer_page.evaluate("""() => ({
          attemptId: WebRTC?.currentConnectionAttemptId || '',
          generation: Number(WebRTC?.connectionAttemptSequence || 0),
          streamId: String(WebRTC?.activeVideoStreamId || WebRTC?.remoteStream?.getVideoTracks?.()[0]?.id || ''),
          sourceWidth: Number(document.getElementById('remoteVideo')?.videoWidth || 0),
          sourceHeight: Number(document.getElementById('remoteVideo')?.videoHeight || 0),
        })""")
        if (not isinstance(row, dict) or not isinstance(row.get("attemptId"), str) or not row["attemptId"]
                or not isinstance(row.get("generation"), int) or row["generation"] <= 0
                or not isinstance(row.get("streamId"), str) or not row["streamId"]
                or not isinstance(row.get("sourceWidth"), int) or row["sourceWidth"] <= 0
                or not isinstance(row.get("sourceHeight"), int) or row["sourceHeight"] <= 0):
            return None
        return row

    def selected_relay_leg(self, catalog: list[Mapping[str, Any]]) -> dict[str, Any] | None:
        rows = self.viewer_page.evaluate("""async () => {
          const pc = WebRTC?.peerConnection || WebRTC?.pc;
          if (!pc?.getStats) return [];
          return [...(await pc.getStats()).values()].map(row => ({id: row.id, type: row.type, selected: row.selected,
            nominated: row.nominated, state: row.state, localCandidateId: row.localCandidateId,
            candidateType: row.candidateType, address: row.address, port: row.port, protocol: row.protocol}));
        }""")
        return selected_relay_leg_from_stats(rows, catalog) if isinstance(rows, list) else None

    def arm_loss_lab_taps(self) -> bool:
        """Arm the Viewer-owned, loopback-only raw loss tap before loss starts."""
        return self.viewer_page.evaluate("() => window.WebRTC?.beginLossLabTrace?.() === true") is True

    def sample_loss_lab_taps(self) -> dict[str, Any] | None:
        """Read native rVFC/PC stats and Host DataChannel rows from this page."""
        row = self.viewer_page.evaluate("""async () => {
          const result = await window.WebRTC?.takeLossLabTraceSnapshot?.();
          return result && typeof result === 'object' ? result : null;
        }""")
        return dict(row) if isinstance(row, Mapping) else None

    def close(self) -> None:
        self._browser.close(); self._playwright.stop()

    def producer_window_precondition(self) -> tuple[bool, str]:
        # A headless browser page is not an MSS-captured fixture window.  This
        # is intentionally stricter than DOM visibility: a separate browser
        # tab cannot prove that the Lab Host captured this producer.
        if not getattr(self, "_headed_producer", False):
            return False, "producer-window-is-not-visible-to-host-capture"
        visible = bool(self.producer_page.evaluate("() => document.visibilityState === 'visible' && !document.hidden"))
        return (visible, "headed-producer-window-visible" if visible else "producer-window-is-not-visible-to-host-capture")


class LabLifecycleCollector:
    """Wire LabRun, Host lifecycle, static Viewer evidence and transcript.

    ``viewer`` is a concrete browser adapter in production and a narrow fake in
    tests.  It is intentionally read-only during the no-input phase.
    """
    def __init__(self, *, lab_run: Any, viewer: StaticViewer, proof_factory: Callable[[Any], ProducerProof],
                 layout_factory: Callable[[Any], MarkerLayout]) -> None:
        self.lab_run, self.viewer = lab_run, viewer
        self.proof_factory, self.layout_factory = proof_factory, layout_factory

    def collect(self, *, dedicated_desktop: bool, fixture_window: bool) -> LabTranscript:
        identity = self.lab_run.start("legacy")
        try:
            self.lab_run.start_host()
            proof, layout = self.proof_factory(identity), self.layout_factory(identity)
            static = static_text_evidence(proof, layout, self.viewer.static_frames(layout))
            automatic = run_automatic_scene(proof=proof, verified_context=identity, layout=layout,
                                             dedicated_desktop=dedicated_desktop, fixture_window=fixture_window)
            return LabTranscript.create(verifier=self.lab_run.transcript_verifier(), identity={"origin": identity.origin, "realm": identity.realm,
                                                  "runId": identity.run_id, "epoch": identity.epoch},
                                        static=static, automatic=automatic, receipts=[])
        finally:
            self.lab_run.close()


def write_artifact(path: Path, transcript: LabTranscript | Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = transcript.as_dict() if isinstance(transcript, LabTranscript) else dict(transcript)
    path.write_text(json.dumps(body, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def seal_loss_bridge_after_clear(*, manifest_path: Path, socket_path: Path, raw_bridge_path: Path,
                                 cleared_event_path: Path, seal_path: Path,
                                 run: Callable[[list[str]], Any] | None = None) -> None:
    """T4/T5 owner entrypoint after controller `clear` returns its event.

    The parent invokes this while its LabRun still owns the Unix authority.
    It forwards no verifier: `bridge-authority` already holds it in memory.
    """
    command = [sys.executable, str(Path(__file__).with_name("turn-loss-fixture") / "controller.py"), "seal-bridge",
               "--manifest", str(manifest_path), "--socket", str(socket_path), "--bridge", str(raw_bridge_path),
               "--event", str(cleared_event_path), "--output", str(seal_path)]
    completed = (run or (lambda argv: subprocess.run(argv, check=False, capture_output=True, text=True)))(command)
    if getattr(completed, "returncode", 0) != 0:
        raise RuntimeError("isolated loss bridge seal was refused")


def selected_relay_leg_from_stats(rows: list[Mapping[str, Any]], catalog: list[Mapping[str, Any]]) -> dict[str, Any] | None:
    """Bind the *selected* WebRTC relay candidate to one public catalog row."""
    pairs = [row for row in rows if row.get("type") == "candidate-pair" and (row.get("selected") is True or row.get("nominated") is True) and row.get("state") == "succeeded"]
    if len(pairs) != 1:
        return None
    pair = pairs[0]; local_id = pair.get("localCandidateId")
    local = next((row for row in rows if row.get("id") == local_id and row.get("type") == "local-candidate"), None)
    if not isinstance(local, Mapping) or local.get("candidateType") != "relay":
        return None
    matches = [row for row in catalog if row.get("address") == local.get("address") and row.get("port") == local.get("port") and row.get("protocol") == local.get("protocol")]
    return dict(matches[0]) if len(matches) == 1 else None


def turn_catalog(identity: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Create a credential-free relay catalog from the current server config."""
    result = []
    for url in identity.get("urls", []) if isinstance(identity.get("urls"), list) else []:
        if not isinstance(url, str) or not url.startswith("turn:"): continue
        body = url[5:].split("?", 1)[0]; host, sep, port = body.rpartition(":")
        if not host or not sep or not port.isdigit(): continue
        result.append({"address": host, "port": int(port), "protocol": "udp", "id": identity.get("id"), "fingerprint": identity.get("fingerprint"), "digest": identity.get("digest")})
    return result


class RawLossTimelineCollector:
    """Lab-only callback accumulator with a single runner-observed ordering clock.

    Host timestamps and browser performance clocks remain diagnostic fields.  A
    recovery decision is made only from the runner's receipt clock after a
    clear barrier raises ``tapEpoch``; stale callbacks cannot satisfy it.
    """
    def __init__(self, *, started_ns: int, ended_ns: int) -> None:
        self.started_ns, self.ended_ns = started_ns, ended_ns
        self.rtp = {"before": [], "during": [], "after": []}; self.phase = "before"
        self.feedback: list[dict[str, Any]] = []; self.idr: dict[str, Any] | None = None
        self.paint: dict[str, Any] | None = None; self.pc: list[dict[str, Any]] = []
        self.recovery: list[dict[str, Any]] = []; self.tap_epoch = 0; self.arrival_seq = 0
        self._clear: dict[str, Any] | None = None
    def set_phase(self, phase: str) -> None:
        if phase not in {*self.rtp, "recovery"}: raise ValueError("loss trace phase invalid")
        self.phase = phase
    def clear_barrier(self, *, event_handle: str, observed_ns: int) -> None:
        if not isinstance(event_handle, str) or not event_handle or not isinstance(observed_ns, int):
            raise ValueError("clear barrier is invalid")
        self.tap_epoch += 1; self._clear = {"eventHandle": event_handle, "clearReplyObservedNs": observed_ns, "tapEpoch": self.tap_epoch}
        self.feedback, self.idr, self.paint = [], None, None
    def rtp_packet(self, phase: str, *, sequence: int, rtp_timestamp: int) -> None:
        # Sender RTP is retained as diagnostics only; bridge verification uses
        # receiver_capture.py's AF_PACKET rows exclusively.
        if phase == "recovery": return
        if phase not in self.rtp or not isinstance(sequence, int) or not isinstance(rtp_timestamp, int): raise ValueError("raw RTP event invalid")
        self.rtp[phase].append({"sequence": sequence, "rtpTimestamp": rtp_timestamp})
    def feedback_event(self, kind: str, monotonic_ns: int) -> None:
        if kind not in {"PLI", "FIR"}: raise ValueError("feedback kind invalid")
        self.feedback.append({"kind": kind, "hostMonotonicNs": monotonic_ns, "runnerObservedNs": monotonic_ns, "tapEpoch": self.tap_epoch, "arrivalSeq": self.arrival_seq})
    def idr_event(self, *, frame_id: str, wire_timestamp: int, monotonic_ns: int) -> None:
        self.idr = {"frameId": frame_id, "wireTimestamp": wire_timestamp, "runnerObservedNs": monotonic_ns, "tapEpoch": self.tap_epoch, "arrivalSeq": self.arrival_seq}
    def rvfc_paint(self, *, frame_id: str, wire_timestamp: int, monotonic_ns: int) -> None:
        self.paint = {"frameId": frame_id, "wireTimestamp": wire_timestamp, "runnerObservedNs": monotonic_ns, "tapEpoch": self.tap_epoch, "arrivalSeq": self.arrival_seq}; self._maybe_recovery()
    def pc_snapshot(self, *, identifier: str, state: str, resolution: Mapping[str, Any]) -> None:
        self.pc.append({"id": identifier, "state": state, "resolution": dict(resolution)})
    def _maybe_recovery(self) -> None:
        clear = self._clear
        if clear is None or self.idr is None or self.paint is None or not self.feedback: return
        feedback_at = max(row["runnerObservedNs"] for row in self.feedback if row["tapEpoch"] == self.tap_epoch)
        idr_at, paint_at = self.idr["runnerObservedNs"], self.paint["runnerObservedNs"]
        if clear["clearReplyObservedNs"] <= feedback_at <= idr_at <= paint_at:
            candidate = {**clear, "feedbackObservedNs": feedback_at, "idrObservedNs": idr_at, "paintObservedNs": paint_at}
            if not any(row.get("eventHandle") == clear["eventHandle"] for row in self.recovery): self.recovery.append(candidate)
    def ingest_viewer_tap(self, raw: Mapping[str, Any] | None, *, runner_observed_ns: int | None = None) -> None:
        if not isinstance(raw, Mapping) or raw.get("droppedHostEvents") != 0: raise ValueError("viewer loss tap is missing or dropped raw Host events")
        if runner_observed_ns is None: runner_observed_ns = time.monotonic_ns()
        if not isinstance(runner_observed_ns, int): raise ValueError("runner observation clock is required")
        stats = raw.get("stats")
        if not isinstance(stats, Mapping) or stats.get("state") != "connected": raise ValueError("viewer loss tap has no connected PeerConnection")
        inbound, relay = stats.get("inbound"), stats.get("selectedRelay")
        if (not isinstance(inbound, Mapping) or not isinstance(relay, Mapping) or not isinstance(inbound.get("packetsReceived"), (int, float)) or not isinstance(inbound.get("packetsLost"), (int, float))):
            raise ValueError("viewer loss tap lacks selected relay/inbound stats")
        self.arrival_seq += 1
        for event in raw.get("host", []):
            if not isinstance(event, Mapping): raise ValueError("invalid Host loss tap event")
            if event.get("type") == "rtcp_feedback":
                kind = str(event.get("kind"))
                if kind not in {"PLI", "FIR"}: raise ValueError("feedback kind invalid")
                self.feedback.append({"kind": kind, "hostMonotonicNs": int(event.get("monotonicNs")), "runnerObservedNs": runner_observed_ns, "tapEpoch": self.tap_epoch, "arrivalSeq": self.arrival_seq})
            elif event.get("type") == "encoder_idr" and isinstance(event.get("frameKey"), Mapping):
                self.idr = {"hostFrameKey": dict(event["frameKey"]), "frameKey": None, "wireTimestamp": None, "hostMonotonicNs": int(event.get("monotonicNs")), "requestToken": event.get("requestToken"), "runnerObservedNs": runner_observed_ns, "tapEpoch": self.tap_epoch, "arrivalSeq": self.arrival_seq}
            elif event.get("type") == "rtp_send":
                # Never derive receiver gaps from this host diagnostic.
                key = event.get("frameKey")
                if isinstance(key, Mapping) and self.idr is not None:
                    host_key = self.idr.get("hostFrameKey")
                    if isinstance(host_key, Mapping) and all(host_key.get(field) == key.get(field) for field in ("attemptId", "generation", "streamId", "captureSeq")):
                        wire = int(event.get("rtpTimestamp")); self.idr["frameKey"] = {field: key.get(field) for field in ("attemptId", "generation", "streamId", "captureSeq")}; self.idr["frameKey"]["wireTimestamp"] = wire; self.idr["wireTimestamp"] = wire
            elif event.get("type") == "pc_state": self.pc_snapshot(identifier=str(event.get("pcId")), state=str(event.get("state")), resolution=event.get("resolution") if isinstance(event.get("resolution"), Mapping) else {})
        for event in raw.get("rvfc", []):
            if not isinstance(event, Mapping): raise ValueError("invalid rVFC tap event")
            key = {field: event.get(field) for field in ("attemptId", "generation", "streamId", "captureSeq", "wireTimestamp")}
            if (not isinstance(key["attemptId"], str) or not isinstance(key["generation"], int) or not isinstance(key["streamId"], str) or not isinstance(key["captureSeq"], int) or not isinstance(key["wireTimestamp"], int) or not isinstance(event.get("viewerAcceptedMs"), (int, float))): raise ValueError("rVFC loss tap lacks a matched T3 FrameKey")
            if self.idr is not None and self.idr.get("frameKey") == key:
                self.paint = {"frameKey": key, "wireTimestamp": key["wireTimestamp"], "viewerAcceptedMs": float(event["viewerAcceptedMs"]), "runnerObservedNs": runner_observed_ns, "tapEpoch": self.tap_epoch, "arrivalSeq": self.arrival_seq}; self._maybe_recovery()
            self.pc_snapshot(identifier=str(event.get("pcId")), state=str(stats.get("state")), resolution=event.get("resolution") if isinstance(event.get("resolution"), Mapping) else {})
    def as_bridge_fields(self) -> dict[str, Any]:
        return {"sequences": self.rtp, "timeline": {"feedback": self.feedback, "idr": self.idr, "paint": self.paint, "pc": self.pc, "recovery": self.recovery}}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run isolated Lab Signal/Host/static lifecycle; never falls back to personal-desktop input.")
    token_group = parser.add_mutually_exclusive_group(required=True)
    token_group.add_argument("--viewer-token", help="Production Viewer bearer token used only for the zero-viewer proof preflight.")
    token_group.add_argument("--viewer-token-env", help="Environment variable holding the production Viewer bearer token.")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--dedicated-desktop", action="store_true")
    parser.add_argument("--fixture-window", action="store_true")
    parser.add_argument("--headed-producer", action="store_true", help="Open the producer in a visible disposable-desktop browser window.")
    args = parser.parse_args(argv)
    from turn_lab import LabRun
    viewer_token = resolve_viewer_token(args)
    if viewer_token is None:
        parser.error("--viewer-token-env did not name a nonempty environment variable")
    lab = LabRun(viewer_token=viewer_token)
    adapter = None
    try:
        identity = lab.start("legacy")
        lab.start_host()
        proof = ProducerProof(secrets.randbits(64), 1, identity.origin, "pending-viewer-attempt", 0, identity.realm, identity.run_id)
        layout = MarkerLayout.create(attempt_id=proof.attempt_id, generation=proof.generation,
                                     source_width=1280, source_height=720, roi=(64, 48, 256, 128))
        adapter = PlaywrightLabViewerAdapter.open(lab, proof, headed_producer=args.headed_producer)
        session = adapter.viewer_session_identity()
        if session is None:
            raise RuntimeError("viewer session has no stable attempt/generation/resolution")
        proof = ProducerProof(proof.run_nonce, proof.scene_id, identity.origin, session["attemptId"], session["generation"], identity.realm, identity.run_id)
        adapter.set_producer_proof(proof)
        roi = adapter.calibrate_marker_roi(source_width=session["sourceWidth"], source_height=session["sourceHeight"])
        layout = MarkerLayout.create(attempt_id=proof.attempt_id, generation=proof.generation,
                                     source_width=session["sourceWidth"], source_height=session["sourceHeight"], roi=roi)
        adapter.configure_marker_roi(layout)
        visible, reason = adapter.producer_window_precondition()
        selected_turn = lab.selected_turn_identity()
        selected_leg = adapter.selected_relay_leg(turn_catalog(selected_turn))
        if selected_leg is None:
            raise RuntimeError("getStats did not prove a selected relay/catalog mapping")
        selected_turn = {key: selected_leg[key] for key in ("id", "fingerprint", "digest")}
        identity_record = {"origin": identity.origin, "realm": identity.realm, "runId": identity.run_id, "epoch": identity.epoch,
                           "scope": {"attemptId": session["attemptId"], "generation": session["generation"], "streamId": session["streamId"]},
                           "selectedTurn": selected_turn}
        if not visible:
            transcript = LabTranscript.create(verifier=lab.transcript_verifier(), identity=identity_record,
                static={"status": NOT_RUN, "failures": [reason], "layout": asdict(layout)},
                automatic={"status": BLOCKED, "executionMode": "automatic-isolated", "failures": [reason],
                           "workload": [workload_record(item) for item in exact_workload()]}, receipts=[])
            write_artifact(args.output, transcript); print(json.dumps(transcript.as_dict())); return 2
        # A visible producer fixture reaches this path; decoded static evidence
        # must pass before automatic dispatch is even considered.
        static = static_text_evidence(proof, layout, adapter.static_frames(layout))
        preflight = run_automatic_scene(proof=proof, verified_context=identity, layout=layout,
                                        dedicated_desktop=args.dedicated_desktop, fixture_window=args.fixture_window)
        if static["status"] != PASS:
            automatic = {"status": BLOCKED, "executionMode": "automatic-isolated",
                         "failures": ["decoded-static-fixture-evidence-required"],
                         "workload": [workload_record(item) for item in exact_workload()]}
        elif preflight["status"] == BLOCKED:
            automatic = preflight
        else:
            # This branch is unreachable on the shared desktop: only a future
            # Host-native atomic probe can make the preflight non-BLOCKED.
            # This remains unreachable until the Host-native probe is
            # implemented. Keep the future automatic branch strict: no
            # dispatch is possible without independently calibrated element
            # targets in the current Host-captured source coordinates.
            adapter.calibrate_fixture_input_geometry(source_width=session["sourceWidth"], source_height=session["sourceHeight"])
            broker = FixtureBroker(proof, layout)
            with LoopbackFixtureReceiver(broker) as receiver:
                # Independent Signal control-plane arming must complete before
                # any prepared input is bound or dispatched. The Host reports
                # its applied secret-free TURN digest first.
                lab.wait_host_turn_applied()
                lease = adapter.acquire_controlled_lease()
                if lease is None:
                    raise RuntimeError("Viewer did not receive a controlled lease")
                fixture_id = f"fixture-{identity.run_id}"
                lab.arm_controlled_input(lease_id=lease["leaseId"], lease_epoch=lease["leaseEpoch"], fixture_id=fixture_id)
                adapter.install_input_ack_observer()
                adapter.configure_loopback_producer(endpoint=receiver.endpoint, proof=proof, layout=layout)
                automatic = ExecutableLabDriver(lab_run=lab, viewer=adapter, producer=adapter,
                                                 broker=receiver, fixture_id=fixture_id).run()
        transcript = LabTranscript.create(verifier=lab.transcript_verifier(), identity=identity_record,
            static=static, automatic=automatic,
            receipts=automatic.get("receipts", []) if isinstance(automatic.get("receipts"), list) else [])
        write_artifact(args.output, transcript); print(json.dumps(transcript.as_dict())); return 0 if static["status"] == PASS and automatic["status"] == PASS else 1
    except Exception as exc:
        # A lifecycle failure never reached a per-run verifier.  It must not
        # impersonate a signed Lab transcript with a predictable static key.
        artifact = {"artifactStatus": NOT_RUN, "identity": {},
                    "static": {"status": NOT_RUN, "failures": [lifecycle_failure(exc)]},
                    "automatic": {"status": BLOCKED, "failures": ["lab-lifecycle-unavailable"]},
                    "receipts": [], "signature": None, "signatureStatus": "unavailable"}
        write_artifact(args.output, artifact); print(json.dumps(artifact)); return 2
    finally:
        if adapter is not None: adapter.close()
        lab.close()


if __name__ == "__main__":
    raise SystemExit(main())
