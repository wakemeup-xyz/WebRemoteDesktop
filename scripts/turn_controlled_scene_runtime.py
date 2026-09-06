#!/usr/bin/env python3
"""Executable, fail-closed controlled-scene harness for the isolated TURN lab.

The harness never talks to a production Host.  A caller supplies the already
verified Lab identity plus adapters for the real Viewer, Host acknowledgement,
and loopback producer.  Its no-input static path is deliberately runnable on
its own; automatic input refuses to run until a disposable desktop is proven.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable, Mapping

from turn_controlled_scene import BLOCKED, FAIL, NOT_RUN, PASS, ProducerProof, proof_matches_verified_lab_context


_CANONICAL_NONCE = re.compile(r"(?:0|[1-9][0-9]{0,19})\Z")


def canonical_run_nonce(value: Any) -> str | None:
    """Return the one decimal nonce wire representation, or reject it.

    Marker decoders and browser-native events cross JSON, where an uint64
    cannot safely be represented as a JavaScript Number. The proof remains
    an integer in Python, while all external evidence is compared as this
    exact decimal spelling. Signs, whitespace, leading zeroes and values
    outside uint64 are never silently normalised.
    """
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value) if 0 <= value < 2**64 else None
    if not isinstance(value, str) or not _CANONICAL_NONCE.fullmatch(value):
        return None
    return value if int(value) < 2**64 else None


def _digest(value: Mapping[str, Any]) -> str:
    return hashlib.sha256(json.dumps(dict(value), sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()


@dataclass(frozen=True)
class MarkerLayout:
    attempt_id: str
    generation: int
    source_width: int
    source_height: int
    roi: tuple[int, int, int, int]
    layout_digest: str

    @classmethod
    def create(cls, *, attempt_id: str, generation: int, source_width: int, source_height: int,
               roi: tuple[int, int, int, int]) -> "MarkerLayout":
        if (not isinstance(attempt_id, str) or not attempt_id or not isinstance(generation, int) or generation < 0
                or not all(isinstance(value, int) for value in (source_width, source_height, *roi))):
            raise ValueError("invalid marker layout identity")
        x, y, width, height = roi
        if source_width <= 0 or source_height <= 0 or x <= 0 or y <= 0 or width != 256 or height != 128 or x + width > source_width or y + height > source_height:
            raise ValueError("marker layout must declare a nonzero 256x128 encoded ROI")
        raw = {"attemptId": attempt_id, "generation": generation, "sourceWidth": source_width,
               "sourceHeight": source_height, "roi": list(roi)}
        return cls(attempt_id, generation, source_width, source_height, roi, _digest(raw))

    def matches(self, row: Mapping[str, Any]) -> bool:
        return (row.get("attemptId") == self.attempt_id and row.get("generation") == self.generation
                and row.get("sourceWidth") == self.source_width and row.get("sourceHeight") == self.source_height
                and row.get("roi") == list(self.roi) and row.get("layoutDigest") == self.layout_digest)


@dataclass(frozen=True)
class WorkItem:
    kind: str
    action_id: int
    text: str = ""


@dataclass(frozen=True)
class WorkStep:
    """One normal Viewer input in a logical controlled transaction."""
    action_id: int
    logical_action_id: int
    kind: str
    phase: str
    text: str = ""


def exact_workload() -> tuple[WorkItem, ...]:
    """The declared sequence is part of acceptance, never a best-effort loop."""
    actions = [WorkItem("scroll", 1)]
    actions.extend(WorkItem("drag", index) for index in range(2, 12))
    actions.extend(WorkItem("text", index, f"t{index - 11:02d}") for index in range(12, 32))
    return tuple(actions)


def workload_record(item: WorkItem) -> dict[str, Any]:
    return {"kind": item.kind, "actionId": item.action_id,
            "transaction": [step.phase for step in work_steps(item)],
            **({"text": item.text} if item.kind == "text" else {})}


def work_steps(item: WorkItem) -> tuple[WorkStep, ...]:
    """Expand each declared workload operation into leak-safe real inputs."""
    base = item.action_id * 100
    if item.kind == "scroll":
        return (WorkStep(base + 1, item.action_id, item.kind, "wheel"),)
    if item.kind == "drag":
        return (WorkStep(base + 1, item.action_id, item.kind, "down"),
                WorkStep(base + 2, item.action_id, item.kind, "move"),
                WorkStep(base + 3, item.action_id, item.kind, "up"))
    if item.kind == "text":
        # keyboard/text is the project's normal keyboard-submission protocol.
        return (WorkStep(base + 1, item.action_id, item.kind, "text", item.text),)
    raise ValueError("unknown controlled workload item")


def workload_failures(rows: list[Mapping[str, Any]]) -> list[str]:
    required = exact_workload()
    if len(rows) != len(required):
        return ["controlled-workload-count"]
    failures: list[str] = []
    for expected, actual in zip(required, rows):
        if actual.get("kind") != expected.kind or actual.get("actionId") != expected.action_id:
            failures.append("controlled-workload-order")
            break
        if expected.kind == "text" and actual.get("text") != expected.text:
            failures.append("controlled-workload-text")
            break
    return failures


class FixtureBroker:
    """Merge a native producer event only with the pending proof-bound input.

    The producer endpoint never receives an input id.  It may report only the
    native event it observed; this broker adds the reserved id after checking
    proof, action, attempt/generation and MarkerLayout.
    """
    def __init__(self, proof: ProducerProof, layout: MarkerLayout) -> None:
        self.proof, self.layout = proof, layout
        self._pending: dict[int, str] = {}
        self._receipts: dict[str, dict[str, Any]] = {}

    def reserve(self, *, input_id: str, action_id: int) -> None:
        if not isinstance(input_id, str) or not input_id or action_id in self._pending:
            raise ValueError("input reservation is invalid or already used")
        self._pending[action_id] = input_id

    def record_native_event(self, event: Mapping[str, Any]) -> dict[str, Any] | None:
        action_id = event.get("actionId")
        input_id = self._pending.pop(action_id, None) if isinstance(action_id, int) else None
        if input_id is None:
            return None
        if (canonical_run_nonce(event.get("runNonce")) != canonical_run_nonce(self.proof.run_nonce)
                or event.get("sceneId") != self.proof.scene_id
                or event.get("attemptId") != self.proof.attempt_id or event.get("generation") != self.proof.generation
                or event.get("realm") != self.proof.realm or event.get("runId") != self.proof.run_id
                or event.get("focused") is not True or not self.layout.matches(event)):
            return None
        receipt = {"inputId": input_id, **dict(event)}
        self._receipts[input_id] = receipt
        return receipt

    def receipt_for(self, input_id: str) -> dict[str, Any] | None:
        return self._receipts.get(input_id)


def aggregate_action_evidence(*, reservation: Mapping[str, Any] | None, ack: Mapping[str, Any] | None,
                              claim: Mapping[str, Any] | None, receipt: Mapping[str, Any] | None,
                              visual: Mapping[str, Any] | None) -> dict[str, Any]:
    """One step passes only with all five real causal boundaries."""
    input_id = reservation.get("inputId") if isinstance(reservation, Mapping) else None
    if not isinstance(input_id, str) or not input_id:
        return {"status": FAIL, "failure": "missing-reservation"}
    if not isinstance(ack, Mapping) or ack.get("inputId") != input_id or ack.get("status") != "applied":
        return {"status": FAIL, "failure": "missing-applied-ack"}
    if not isinstance(claim, Mapping) or claim.get("inputId") != input_id or claim.get("status") != "claimed":
        return {"status": FAIL, "failure": "missing-host-guard-claim"}
    if not isinstance(receipt, Mapping) or receipt.get("inputId") != input_id:
        return {"status": FAIL, "failure": "missing-broker-receipt"}
    if not isinstance(visual, Mapping) or visual.get("inputId") != input_id or visual.get("traceStatus") != "matched" or not visual.get("rtpTimestamp") or not visual.get("wireTimestamp"):
        return {"status": FAIL, "failure": "missing-matched-wire-visual"}
    return {"status": PASS, "inputId": input_id}


def static_text_evidence(proof: ProducerProof, layout: MarkerLayout, frames: list[Mapping[str, Any]], *, seconds: int = 60) -> dict[str, Any]:
    """Validate an explicit frozen marker record independently of input scenes."""
    if seconds != 60 or len(frames) != 61:
        return {"status": NOT_RUN, "failures": ["static-text-60s-samples-required"]}
    baseline: tuple[Any, ...] | None = None
    for frame in frames:
        identity = (frame.get("runNonce"), frame.get("sceneId"), frame.get("tick"), frame.get("actionId"))
        if (canonical_run_nonce(identity[0]) != canonical_run_nonce(proof.run_nonce)
                or identity[1] != proof.scene_id or not layout.matches(frame)
                or frame.get("attemptId") != proof.attempt_id or frame.get("generation") != proof.generation):
            return {"status": FAIL, "failures": ["static-text-identity"]}
        if baseline is None:
            baseline = identity
        elif identity != baseline:
            return {"status": FAIL, "failures": ["static-text-marker-changed"]}
    return {"status": PASS, "seconds": seconds, "samples": len(frames), "layout": asdict(layout)}


def run_automatic_scene(*, proof: ProducerProof, verified_context: Any, layout: MarkerLayout,
                        dedicated_desktop: bool, fixture_window: bool) -> dict[str, Any]:
    if not proof_matches_verified_lab_context(proof, verified_context):
        return {"status": BLOCKED, "failures": ["producer-proof-context-mismatch"]}
    if not dedicated_desktop or not fixture_window:
        return {"status": BLOCKED, "executionMode": "automatic-isolated",
                "failures": ["dedicated-desktop-and-fixture-window-required"],
                "workload": [workload_record(item) for item in exact_workload()]}
    # A concrete Viewer/Host/producer adapter is deliberately required here;
    # this function never falls back to Quartz or page-script input.
    return {"status": NOT_RUN, "executionMode": "automatic-isolated",
            "failures": ["real-lab-adapter-required"], "workload": [workload_record(item) for item in exact_workload()]}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run only the isolated controlled-scene harness; never injects desktop input.")
    parser.add_argument("--static-evidence", type=Path, help="JSON array of 61 independently decoded static frames")
    args = parser.parse_args(argv)
    if args.static_evidence is None:
        print(json.dumps({"status": BLOCKED, "reason": "static evidence input is required; automatic desktop input is disabled"}))
        return 2
    try:
        frames = json.loads(args.static_evidence.read_text(encoding="utf-8"))
        if not isinstance(frames, list):
            raise ValueError("static evidence must be an array")
    except Exception as exc:
        print(json.dumps({"status": BLOCKED, "reason": f"invalid-static-evidence:{type(exc).__name__}"}))
        return 2
    # The CLI intentionally cannot self-invent the proof/layout that authenticate
    # evidence.  It validates workload availability and fails closed otherwise.
    print(json.dumps({"status": NOT_RUN, "staticSamples": len(frames), "workload": [workload_record(item) for item in exact_workload()]}))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
