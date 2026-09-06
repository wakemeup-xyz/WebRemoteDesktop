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
import threading
import time
from dataclasses import asdict, dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol

from turn_controlled_scene import BLOCKED, FAIL, NOT_RUN, PASS, ProducerProof
from turn_controlled_scene_runtime import (MarkerLayout, aggregate_action_evidence,
                                           FixtureBroker, exact_workload, run_automatic_scene,
                                           static_text_evidence, workload_failures,
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
        for item in workload:
            try:
                reservation = self.viewer.prepare_lab_input(item)
                if not isinstance(reservation, Mapping):
                    raise RuntimeError("viewer-lab-input-not-prepared")
                input_id, lease_id, lease_epoch = reservation.get("inputId"), reservation.get("leaseId"), reservation.get("leaseEpoch")
                action = {key: reservation.get(key) for key in ("type", "action", "payload")}
                if (not isinstance(input_id, str) or not input_id or not isinstance(lease_id, str) or not lease_id
                        or not isinstance(lease_epoch, int) or isinstance(lease_epoch, bool) or lease_epoch < 0
                        or not isinstance(action["type"], str) or not isinstance(action["action"], str)
                        or not isinstance(action["payload"], Mapping)):
                    raise RuntimeError("viewer-lab-input-metadata-invalid")
                self.broker.reserve(input_id=input_id, action_id=item.action_id)
                self.lab_run.bind_controlled_input(input_id=input_id, lease_id=lease_id, lease_epoch=lease_epoch,
                                                    fixture_id=self.fixture_id, action=action)
                self.producer.prepare_native_action(item.action_id)
                dispatched = self.viewer.dispatch_prepared_lab_input(reservation)
                if dispatched != input_id:
                    raise RuntimeError("viewer-lab-input-dispatch-refused")
                ack = self.viewer.wait_for_applied_ack(input_id)
                receipt = self.broker.wait_for_receipt(input_id)
                visual = self.viewer.wait_for_decoded_visual(input_id, item.action_id)
                result = aggregate_action_evidence(reservation=reservation, ack=ack, receipt=receipt, visual=visual)
                if result["status"] != PASS:
                    raise RuntimeError(str(result.get("failure") or "four-way-evidence-failed"))
                receipts.append({"inputId": input_id, "actionId": item.action_id, "kind": item.kind,
                                 **({"text": item.text} if item.kind == "text" else {}),
                                 "ack": dict(ack), "receipt": dict(receipt), "visual": dict(visual)})
            except Exception as error:
                failures.append(f"action-{item.action_id}:{type(error).__name__}:{error}")
                break
        workload_rows = [{"kind": row["kind"], "actionId": row["actionId"],
                          **({"text": row["text"]} if "text" in row else {})}
                         for row in receipts]
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

    @staticmethod
    def _input_spec(item: Any) -> dict[str, Any]:
        """Map the immutable work declaration to the existing v2 input API."""
        if item.kind == "scroll":
            return {"type": "mouse", "action": "wheel",
                    "payload": {"relX": .5, "relY": .5, "deltaX": 0, "deltaY": 80}}
        if item.kind == "drag":
            # The Host's normal mouse down path is the causal start of every
            # drag.  Dedicated-fixture runs retain the pending button state
            # only on their disposable desktop; a no-input rehearsal never
            # reaches this method.
            return {"type": "mouse", "action": "down",
                    "payload": {"relX": .5, "relY": .5, "button": "left", "buttons": 1, "clickCount": 1}}
        if item.kind == "text":
            return {"type": "keyboard", "action": "keydown",
                    "payload": {"code": "KeyT", "key": item.text, "modifiers": {}}}
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
          return { left: box.left, top: box.top, width: box.width, height: box.height,
                   screenX: window.screenX, screenY: window.screenY,
                   outerWidth: window.outerWidth, outerHeight: window.outerHeight,
                   innerWidth: window.innerWidth, innerHeight: window.innerHeight,
                   screenWidth: window.screen.width, screenHeight: window.screen.height,
                   dpr: window.devicePixelRatio };
        }""")
        required = ("left", "top", "width", "height", "screenX", "screenY", "outerWidth", "outerHeight",
                    "innerWidth", "innerHeight", "screenWidth", "screenHeight", "dpr")
        if not isinstance(raw, Mapping) or not all(isinstance(raw.get(key), (int, float)) for key in required):
            raise RuntimeError("producer-marker-runtime-geometry-unavailable")
        if raw["width"] != 256 or raw["height"] != 128 or raw["screenWidth"] <= 0 or raw["screenHeight"] <= 0:
            raise RuntimeError("producer-marker-runtime-geometry-invalid")
        border_x = max(0.0, (float(raw["outerWidth"]) - float(raw["innerWidth"])) / 2)
        chrome_y = max(0.0, float(raw["outerHeight"]) - float(raw["innerHeight"]) - border_x)
        x_css = float(raw["screenX"]) + border_x + float(raw["left"])
        y_css = float(raw["screenY"]) + chrome_y + float(raw["top"])
        x = round(x_css * source_width / float(raw["screenWidth"]))
        y = round(y_css * source_height / float(raw["screenHeight"]))
        return MarkerLayout.create(attempt_id="calibration", generation=0, source_width=source_width,
                                   source_height=source_height, roi=(x, y, 256, 128)).roi

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
          sourceWidth: Number(document.getElementById('remoteVideo')?.videoWidth || 0),
          sourceHeight: Number(document.getElementById('remoteVideo')?.videoHeight || 0),
        })""")
        if (not isinstance(row, dict) or not isinstance(row.get("attemptId"), str) or not row["attemptId"]
                or not isinstance(row.get("generation"), int) or row["generation"] <= 0
                or not isinstance(row.get("sourceWidth"), int) or row["sourceWidth"] <= 0
                or not isinstance(row.get("sourceHeight"), int) or row["sourceHeight"] <= 0):
            return None
        return row

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
        roi = adapter.calibrate_marker_roi(source_width=session["sourceWidth"], source_height=session["sourceHeight"])
        layout = MarkerLayout.create(attempt_id=proof.attempt_id, generation=proof.generation,
                                     source_width=session["sourceWidth"], source_height=session["sourceHeight"], roi=roi)
        visible, reason = adapter.producer_window_precondition()
        identity_record = {"origin": identity.origin, "realm": identity.realm, "runId": identity.run_id, "epoch": identity.epoch}
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
            # This branch is reachable only when the caller explicitly proves
            # an isolated desktop and fixture window.  The normal Viewer input
            # transport remains the sole injection path; a shared desktop
            # never gets here, so the run cannot emit Quartz events there.
            broker = FixtureBroker(proof, layout)
            with LoopbackFixtureReceiver(broker) as receiver:
                adapter.install_input_ack_observer()
                adapter.configure_loopback_producer(endpoint=receiver.endpoint, proof=proof, layout=layout)
                automatic = ExecutableLabDriver(lab_run=lab, viewer=adapter, producer=adapter,
                                                 broker=receiver, fixture_id=f"fixture-{identity.run_id}").run()
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
