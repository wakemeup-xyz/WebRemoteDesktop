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
import secrets
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol

from turn_controlled_scene import BLOCKED, FAIL, NOT_RUN, PASS, ProducerProof
from turn_controlled_scene_runtime import MarkerLayout, exact_workload, run_automatic_scene, static_text_evidence, workload_record


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


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


class PlaywrightLabViewerAdapter:
    """Concrete isolated Viewer adapter; it uses no OS input APIs.

    The producer browser tab is intentionally separate from the Viewer tab.
    A real fixture desktop must display that producer before decoded static
    frames can pass; this adapter reports the missing visual evidence instead
    of fabricating it.
    """
    def __init__(self, *, playwright: Any, browser: Any, context: Any, viewer_page: Any, producer_page: Any) -> None:
        self._playwright, self._browser, self._context = playwright, browser, context
        self.viewer_page, self.producer_page = viewer_page, producer_page

    @classmethod
    def open(cls, lab_run: Any, proof: ProducerProof) -> "PlaywrightLabViewerAdapter":
        from turn_runtime_collector import _json_request, seed_viewer_storage, start_viewer, wait_for_healthy_relay
        from playwright.sync_api import sync_playwright
        credentials = lab_run.viewer_credentials()
        status, login = _json_request(f"{credentials['origin']}/api/auth/login", method="POST", body={"password": credentials["password"]})
        if status != 200 or not isinstance(login.get("token"), str):
            raise RuntimeError("isolated Lab Viewer login failed")
        playwright = sync_playwright().start()
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 960})
        try:
            seed_viewer_storage(context, login["token"], credentials["proofAdmission"])
            viewer = context.new_page(); viewer.goto(f"{credentials['origin']}/viewer.html", wait_until="domcontentloaded", timeout=45000)
            start_viewer(viewer); wait_for_healthy_relay(viewer)
            producer_url = Path(__file__).with_name("turn-runtime-controlled-producer.html").as_uri()
            producer_url += f"?runNonce={proof.run_nonce}&sceneId={proof.scene_id}"
            producer = context.new_page(); producer.goto(producer_url, wait_until="domcontentloaded")
            return cls(playwright=playwright, browser=browser, context=context, viewer_page=viewer, producer_page=producer)
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

    def close(self) -> None:
        self._browser.close(); self._playwright.stop()

    def producer_window_precondition(self) -> tuple[bool, str]:
        # A headless browser page is not an MSS-captured fixture window.  This
        # is intentionally stricter than DOM visibility: a separate browser
        # tab cannot prove that the Lab Host captured this producer.
        return False, "producer-window-is-not-visible-to-host-capture"


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


def write_artifact(path: Path, transcript: LabTranscript) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(transcript.as_dict(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run isolated Lab Signal/Host/static lifecycle; never falls back to personal-desktop input.")
    parser.add_argument("--viewer-token", required=True, help="Production Viewer bearer token used only for the zero-viewer proof preflight.")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--dedicated-desktop", action="store_true")
    parser.add_argument("--fixture-window", action="store_true")
    args = parser.parse_args(argv)
    from turn_lab import LabRun
    lab = LabRun(viewer_token=args.viewer_token)
    adapter = None
    try:
        identity = lab.start("legacy")
        lab.start_host()
        proof = ProducerProof(secrets.randbits(64), 1, identity.origin, "pending-viewer-attempt", 0, identity.realm, identity.run_id)
        layout = MarkerLayout.create(attempt_id=proof.attempt_id, generation=proof.generation,
                                     source_width=1280, source_height=720, roi=(64, 48, 256, 128))
        adapter = PlaywrightLabViewerAdapter.open(lab, proof)
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
        automatic = run_automatic_scene(proof=proof, verified_context=identity, layout=layout,
                                         dedicated_desktop=args.dedicated_desktop, fixture_window=args.fixture_window)
        transcript = LabTranscript.create(verifier=lab.transcript_verifier(), identity=identity_record,
            static=static, automatic=automatic, receipts=[])
        write_artifact(args.output, transcript); print(json.dumps(transcript.as_dict())); return 0 if static["status"] == PASS and automatic["status"] == PASS else 1
    except Exception as exc:
        transcript = LabTranscript.create(verifier=b"lab-start-failed", identity={}, static={"status": NOT_RUN, "failures": [f"lifecycle:{type(exc).__name__}"]},
            automatic={"status": BLOCKED, "failures": ["lab-lifecycle-unavailable"]}, receipts=[])
        write_artifact(args.output, transcript); print(json.dumps(transcript.as_dict())); return 2
    finally:
        if adapter is not None: adapter.close()
        lab.close()


if __name__ == "__main__":
    raise SystemExit(main())
