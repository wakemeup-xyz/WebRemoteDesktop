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
    # Browser/producer adapters are intentionally required rather than guessed
    # from a personal desktop.  The lifecycle executable remains reviewable and
    # emits a durable BLOCKED artifact when no adapter was supplied.
    blocked = LabTranscript.create(verifier=b"unstarted-lab", identity={}, static={"status": NOT_RUN, "failures": ["real-lab-viewer-adapter-required"]},
                                    automatic={"status": BLOCKED, "failures": ["real-lab-viewer-adapter-required"]}, receipts=[])
    write_artifact(args.output, blocked)
    print(json.dumps(blocked.as_dict()))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
