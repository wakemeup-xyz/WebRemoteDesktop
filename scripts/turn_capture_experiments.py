"""Read-only evaluation helpers for isolated TURN capture experiments.

This module deliberately evaluates run-level summaries only.  It never starts a
Host, changes a capture rate, or turns experimental evidence into production
policy.
"""
from __future__ import annotations

import hashlib
import json
import argparse
from math import isfinite
from pathlib import Path
import sys
import subprocess
import secrets
import os
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "python-host") not in sys.path:
    sys.path.insert(0, str(ROOT / "python-host"))
from capture_experiment import CaptureExperiment


_STATUS_CANDIDATE = "candidate-requires-confirmation"
_STATUS_INCONCLUSIVE = "INCONCLUSIVE"
_STATUS_NO_BENEFIT = "no-benefit"


class CaptureEvidenceError(ValueError):
    """An expected, persisted T3/T5 evidence-schema rejection."""
_REQUIRED_GUARD_METRICS = (
    "fpsLowerBound",
    "captureAgeP95Ms",
    "presentIntervalP95Ms",
    "inputAckP95Ms",
    "inputEffectP95Ms",
)
_DECLARED_STAGE_METRICS = frozenset({"resizeP95Ms", "grabP95Ms", "prepareP95Ms", "buildP95Ms", "encodeP95Ms", "packetizeP95Ms"})


def _result(status: str, reason: str, metric: str) -> dict[str, Any]:
    return {
        "status": status,
        "reason": reason,
        "metric": metric,
        "candidateRequiresConfirmation": status == _STATUS_CANDIDATE,
    }


def _finite_number(value: object) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if isfinite(number) else None


def _canonical_digest(constant_config: Mapping[str, Any], source_binding: Mapping[str, Any]) -> str:
    # Per-run transcript and artifact hashes must differ.  The comparison
    # digest binds only the declared fixed environment; each run still carries
    # (and the evaluator re-hashes) its own source artifacts separately.
    stable_source = {key: source_binding.get(key) for key in ("sourceCommit", "sceneId", "sceneProofDigest")}
    body = json.dumps(
        {"constantConfig": constant_config, "sourceBinding": stable_source},
        sort_keys=True, separators=(",", ":"), allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


_AUTHORITY_FIELDS = frozenset({"origin", "realm", "runId", "epoch", "policyId", "policyDigest",
                               "finalVerifierDigest", "t3Signature", "t5Signature"})
_BINDING_FIELDS = frozenset({"sourceCommit", "policyDigest", "sceneId", "sceneProofDigest", "authority",
                             "t3Status", "t5Status", "stageCoverage", "dedicatedDesktop", "fixtureWindow",
                             "headedProducer", "inputEvidence", "t3Path", "t5Path", "t3Sha256", "t5Sha256"})


def _is_digest(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(char in "0123456789abcdef" for char in value)


def _validate_artifact_authority(binding: Mapping[str, Any], run_id: str) -> str | None:
    authority = binding.get("authority")
    if not isinstance(authority, Mapping) or set(authority) != _AUTHORITY_FIELDS:
        return "sealed Lab authority is missing"
    if (authority.get("runId") != run_id or not isinstance(authority.get("origin"), str)
            or not authority["origin"].startswith(("http://127.0.0.1:", "http://[::1]:"))
            or not isinstance(authority.get("realm"), str) or not authority["realm"].startswith("lab-")
            or type(authority.get("epoch")) is not int):
        return "Lab authority does not bind this run"
    policy_digest = authority.get("policyDigest")
    if (not _is_digest(policy_digest) or policy_digest == "0" * 64
            or authority.get("policyId") != f"experiment/{policy_digest}"
            or binding.get("policyDigest") != policy_digest):
        return "sealed Lab policy digest is invalid"
    if not all(_is_digest(authority.get(key)) for key in ("finalVerifierDigest", "t3Signature", "t5Signature")):
        return "signed artifact authority is invalid"
    return None


def _validate_signed_source_artifacts(binding: Mapping[str, Any], run_id: str, expected_seconds: int) -> str | None:
    authority = binding["authority"]
    base_identity = {key: authority[key] for key in ("origin", "realm", "runId", "epoch")}
    try:
        t3, t5 = _load_json(binding["t3Path"]), _load_json(binding["t5Path"])
    except ValueError:
        return "signed T3/T5 source is unreadable"
    t3_identity = t3.get("identity")
    if (t3.get("kind") != "turn-t3-lab-stage-run" or t3.get("runId") != run_id
            or not isinstance(t3_identity, Mapping)
            or any(t3_identity.get(key) != value for key, value in base_identity.items())
            or t3.get("durationSeconds") != expected_seconds
            or t3.get("status") != "OBSERVED" or t3.get("signature") != authority["t3Signature"]):
        return "signed T3 source does not match the Lab authority"
    verification = t3.get("verification")
    if (not isinstance(verification, Mapping) or verification.get("algorithm") != "HMAC-SHA256"
            or verification.get("verifierSource") != "lab-transcript-verifier/sha256:" + authority["finalVerifierDigest"]
            or verification.get("selfVerified") is not True or verification.get("verifiedBeforeLabClose") is not True):
        return "T3 HMAC verification authority is incomplete"
    t5_identity = t5.get("identity")
    if (not isinstance(t5_identity, Mapping) or any(t5_identity.get(key) != value for key, value in base_identity.items())
            or t5.get("signature") != authority["t5Signature"]):
        return "signed T5 source does not match the Lab authority"
    automatic, static, receipts = t5.get("automatic"), t5.get("static"), t5.get("receipts")
    if (not isinstance(automatic, Mapping) or automatic.get("status") != "PASS"
            or not isinstance(static, Mapping) or static.get("status") != "PASS"
            or not isinstance(receipts, list) or len(receipts) < 20):
        return "signed T5 evidence is incomplete"
    return None


def _validate_sequence(runs: Sequence[Mapping[str, Any]], expected: tuple[str, ...], metric: str,
                       *, trace_enabled: tuple[bool, ...] | None = None) -> str | None:
    if not isinstance(runs, (list, tuple)) or not all(isinstance(run, Mapping) for run in runs):
        return "runs must be JSON arrays of objects"
    if len(runs) != len(expected):
        return "each ordered sequence requires exactly the declared independent 60-second runs"
    if tuple(run.get("variant") for run in runs) != expected:
        return f"run order must be {'/'.join(expected)}"
    run_ids = [run.get("runId") for run in runs]
    if any(not isinstance(run_id, str) or not run_id for run_id in run_ids) or len(set(run_ids)) != len(expected):
        return "each ordered sequence requires distinct run identifiers"

    required_fields = {
        "schemaVersion", "runId", "variant", "durationSeconds", "sceneId", "constantConfigDigest",
        "constantConfig", "sourceBinding", "variableName", "variableValue", "declaredCostMetric",
        "metrics", "functionalFailures",
    }
    if trace_enabled is not None:
        required_fields = {*required_fields, "traceEnabled"}
    for index, (run, variant) in enumerate(zip(runs, expected)):
        if set(run) != required_fields:
            return "run has missing or unknown schema fields"
        if run.get("schemaVersion") != 1 or not isinstance(run.get("runId"), str) or not run.get("runId"):
            return "run identity schema is invalid"
        if run.get("variant") != variant or run.get("variableName") != "captureMultiplier":
            return "variant binding is invalid"
        if trace_enabled is not None and run.get("traceEnabled") is not trace_enabled[index]:
            return "trace mode is not bound to the full run record"
        expected_multiplier = 2.0 if variant == "A" else 1.0
        if isinstance(run.get("variableValue"), bool) or run.get("variableValue") != expected_multiplier:
            return "variant capture multiplier is invalid"
        if type(run.get("durationSeconds")) is not int or run.get("durationSeconds") != 60:
            return "every run must contain the full 60-second window"
        if run.get("declaredCostMetric") != metric:
            return "cost metric must be declared before every run and cannot change later"
        if run.get("functionalFailures") not in (None, [], ()):
            return "a run contains a functional failure"
        metrics = run.get("metrics")
        if not isinstance(metrics, Mapping) or set(metrics) != {metric, *_REQUIRED_GUARD_METRICS}:
            return "run metrics are missing"
        for required in (metric, *_REQUIRED_GUARD_METRICS):
            if _finite_number(metrics.get(required)) is None:
                return f"run is missing a finite {required} measurement"
        config, binding = run.get("constantConfig"), run.get("sourceBinding")
        if not isinstance(config, Mapping) or not isinstance(binding, Mapping):
            return "constant configuration binding is missing"
        if set(binding) != _BINDING_FIELDS or binding.get("sceneId") != run.get("sceneId"):
            return "source binding is invalid"
        if not all(isinstance(binding.get(name), str) and len(binding[name]) == length for name, length in (("sourceCommit", 40), ("policyDigest", 64), ("sceneProofDigest", 64))):
            return "source binding digest is invalid"
        if (binding.get("t3Status") != "PASS" or binding.get("t5Status") != "PASS"
                or _finite_number(binding.get("stageCoverage")) != 1.0
                or binding.get("dedicatedDesktop") is not True or binding.get("fixtureWindow") is not True
                or binding.get("headedProducer") is not True):
            return "T3/T5 evidence coverage is incomplete"
        input_evidence = binding.get("inputEvidence")
        if not isinstance(input_evidence, Mapping) or set(input_evidence) != {"status", "actionCount", "effectCount"}:
            return "input effect evidence is invalid"
        if input_evidence.get("status") != "PASS" or type(input_evidence.get("actionCount")) is not int or type(input_evidence.get("effectCount")) is not int or input_evidence["actionCount"] < 20 or input_evidence["effectCount"] < input_evidence["actionCount"]:
            return "input effect evidence is incomplete"
        for prefix in ("t3", "t5"):
            path, declared_hash = binding.get(f"{prefix}Path"), binding.get(f"{prefix}Sha256")
            if not isinstance(path, str) or not path or not isinstance(declared_hash, str) or len(declared_hash) != 64:
                return "artifact source binding is invalid"
            try:
                if artifact_sha256(path) != declared_hash:
                    return "artifact source hash mismatch"
            except OSError:
                return "artifact source is missing"
        try:
            digest = _canonical_digest(config, binding)
        except (TypeError, ValueError):
            return "constant configuration cannot be canonically bound"
        if run.get("constantConfigDigest") != digest:
            return "constant configuration digest is not bound to source evidence"
        authority_error = _validate_artifact_authority(binding, run["runId"])
        if authority_error:
            return authority_error
        artifact_error = _validate_signed_source_artifacts(binding, run["runId"], run["durationSeconds"])
        if artifact_error:
            return artifact_error
    return None


def _shared_context_error(runs: Sequence[Mapping[str, Any]]) -> str | None:
    for key in ("sceneId", "constantConfigDigest", "variableName"):
        values = {run.get(key) for run in runs}
        if len(values) != 1 or None in values:
            return f"{key} differs across runs"
    fixed_configs = [run.get("constantConfig") for run in runs]
    if any(not isinstance(config, Mapping) for config in fixed_configs):
        return "constantConfig is missing from a run"
    baseline_config = dict(fixed_configs[0])
    if any(dict(config) != baseline_config for config in fixed_configs[1:]):
        return "constantConfig differs across runs"
    values_by_variant: dict[str, set[object]] = {"A": set(), "B": set()}
    for run in runs:
        values_by_variant[str(run["variant"])].add(run.get("variableValue"))
    if any(len(values) != 1 or None in values for values in values_by_variant.values()):
        return "the declared single variable is not fixed per variant"
    if values_by_variant["A"] == values_by_variant["B"]:
        return "the variants do not differ by their declared single variable"
    return None


def _sequence_benefits(runs: Sequence[Mapping[str, Any]], metric: str) -> bool:
    costs_a = [_finite_number(run["metrics"][metric]) for run in runs if run["variant"] == "A"]
    costs_b = [_finite_number(run["metrics"][metric]) for run in runs if run["variant"] == "B"]
    return bool(costs_a and costs_b and max(costs_b) < min(costs_a))


def evaluate_repeated_runs(
    aba: Sequence[Mapping[str, Any]],
    bab: Sequence[Mapping[str, Any]],
    declared_cost_metric: str,
) -> dict[str, Any]:
    """Compare a predeclared metric across exactly A/B/A then B/A/B runs.

    The outcome is intentionally limited to a tentative candidate, inconclusive
    evidence, or no benefit.  It does not compute significance from correlated
    frame samples and never yields a product pass.
    """
    metric = declared_cost_metric if isinstance(declared_cost_metric, str) else ""
    if metric not in _DECLARED_STAGE_METRICS:
        return _result(_STATUS_INCONCLUSIVE, "a permitted cost metric must be predeclared", metric)
    try:
        for runs, expected in ((aba, ("A", "B", "A")), (bab, ("B", "A", "B"))):
            error = _validate_sequence(runs, expected, metric)
            if error:
                return _result(_STATUS_INCONCLUSIVE, error, metric)
        all_runs = [*aba, *bab]
        run_ids = [run["runId"] for run in all_runs]
        if len(set(run_ids)) != 6:
            return _result(_STATUS_INCONCLUSIVE, "all six sessions must be independent", metric)
        error = _shared_context_error(all_runs)
        if error:
            return _result(_STATUS_INCONCLUSIVE, error, metric)
    except (AttributeError, KeyError, TypeError, ValueError):
        return _result(_STATUS_INCONCLUSIVE, "run evidence has an invalid JSON shape", metric)

    aba_benefit = _sequence_benefits(aba, metric)
    bab_benefit = _sequence_benefits(bab, metric)
    if aba_benefit != bab_benefit:
        return _result(_STATUS_INCONCLUSIVE, "the ordered sequences reach opposite conclusions", metric)

    a_runs = [run for run in all_runs if run["variant"] == "A"]
    b_runs = [run for run in all_runs if run["variant"] == "B"]
    costs_a = [_finite_number(run["metrics"][metric]) for run in a_runs]
    costs_b = [_finite_number(run["metrics"][metric]) for run in b_runs]
    if not all(cost_b < min(costs_a) for cost_b in costs_b):
        return _result(_STATUS_NO_BENEFIT, "candidate cost is not below every baseline run", metric)

    if min(_finite_number(run["metrics"]["fpsLowerBound"]) for run in b_runs) < min(
        _finite_number(run["metrics"]["fpsLowerBound"]) for run in a_runs
    ):
        return _result(_STATUS_NO_BENEFIT, "candidate lowers the FPS lower bound", metric)
    for guard_metric in _REQUIRED_GUARD_METRICS[1:]:
        if max(_finite_number(run["metrics"][guard_metric]) for run in b_runs) > max(
            _finite_number(run["metrics"][guard_metric]) for run in a_runs
        ):
            return _result(_STATUS_NO_BENEFIT, f"candidate worsens {guard_metric}", metric)
    return _result(_STATUS_CANDIDATE, "run-level ranges satisfy the predeclared screening rule", metric)


def trace_overhead_report(
    trace_off: Mapping[str, Any], trace_on: Mapping[str, Any], declared_cost_metric: str
) -> dict[str, float | str]:
    """Report a read-only trace-off/on cost delta from already-collected summaries."""
    metric = str(declared_cost_metric)
    if trace_off.get("traceEnabled") is not False or trace_on.get("traceEnabled") is not True:
        raise ValueError("trace summaries must identify trace-off and trace-on modes")
    off_metrics = trace_off.get("metrics") if isinstance(trace_off.get("metrics"), Mapping) else trace_off
    on_metrics = trace_on.get("metrics") if isinstance(trace_on.get("metrics"), Mapping) else trace_on
    off = _finite_number(off_metrics.get(metric))
    on = _finite_number(on_metrics.get(metric))
    if off is None or on is None:
        raise ValueError("trace summaries are missing the declared finite metric")
    return {"metric": metric, "traceOff": off, "traceOn": on, "overhead": on - off}


def evaluate_experiment_manifest(manifest: object) -> dict[str, Any]:
    """Execute the read-only manifest contract; this never launches a Host."""
    if not isinstance(manifest, Mapping) or set(manifest) != {"schemaVersion", "declaredCostMetric", "aba", "bab", "tracePair"}:
        return {"evaluation": _result(_STATUS_INCONCLUSIVE, "experiment manifest has missing or unknown fields", ""), "traceOverhead": None}
    metric = manifest.get("declaredCostMetric")
    evaluation = evaluate_repeated_runs(manifest.get("aba"), manifest.get("bab"), metric)
    if evaluation["status"] == _STATUS_INCONCLUSIVE:
        return {"evaluation": evaluation, "traceOverhead": None}
    pair = manifest.get("tracePair")
    if not isinstance(pair, Mapping) or set(pair) != {"off", "on"}:
        return {"evaluation": _result(_STATUS_INCONCLUSIVE, "trace-off/on pair is required", evaluation["metric"]), "traceOverhead": None}
    try:
        off, on = pair["off"], pair["on"]
        trace_error = _validate_sequence([off, on], ("A", "A"), evaluation["metric"], trace_enabled=(False, True))
        if trace_error:
            raise ValueError(trace_error)
        all_runs = [*manifest["aba"], *manifest["bab"]]
        if ({off["runId"], on["runId"]} & {run["runId"] for run in all_runs}
                or off["constantConfig"] != on["constantConfig"]
                or off["constantConfigDigest"] != all_runs[0]["constantConfigDigest"]
                or on["constantConfigDigest"] != all_runs[0]["constantConfigDigest"]):
            raise ValueError("trace pair context mismatch")
        trace = trace_overhead_report(off, on, evaluation["metric"])
    except (TypeError, ValueError, KeyError):
        return {"evaluation": _result(_STATUS_INCONCLUSIVE, "trace-off/on pair is invalid", evaluation["metric"]), "traceOverhead": None}
    return {"evaluation": evaluation, "traceOverhead": trace}


def artifact_sha256(path: str | Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


@dataclass(frozen=True)
class TrustedArtifacts:
    t3: Path
    t5: Path
    identity: Mapping[str, Any]
    verifier: bytes
    policy_digest: str
    authority: Mapping[str, Any]

    def __post_init__(self) -> None:
        if not _is_digest(self.policy_digest) or self.policy_digest == "0" * 64:
            raise ValueError("trusted artifact policy digest must be sealed and non-empty")
        error = _validate_artifact_authority({"authority": self.authority, "policyDigest": self.policy_digest},
                                             str(self.authority.get("runId", "")) if isinstance(self.authority, Mapping) else "")
        if error:
            raise ValueError(error)


def _load_json(path: str | Path) -> Mapping[str, Any]:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("collector artifacts are unreadable") from exc
    if not isinstance(value, Mapping):
        raise ValueError("collector artifact must be an object")
    return value


def _stage_p95(t3: Mapping[str, Any], stage: str) -> float:
    values: list[float] = []
    for row in t3.get("hostSummaries", []):
        candidate = row.get("stages", {}).get("stages", {}).get(stage, {}).get("p95Ms") if isinstance(row, Mapping) else None
        value = _finite_number(candidate)
        if value is not None:
            values.append(value)
    if not values:
        raise RuntimeError(f"BLOCKED: signed T3 artifact has no {stage} p95")
    return max(values)


def summary_from_artifacts(artifacts: TrustedArtifacts, *, expected_run_id: str,
                           expected_seconds: int = 60) -> dict[str, Any]:
    """Use the official T3/T5 validators while the per-run verifier is live.

    The caller cannot supply metrics or an input summary.  The HMAC verifier is
    retained only by the live LabRun, so this function must be called before it
    closes.  Durable manifests keep file hashes and are re-hashed by the
    evaluator; they never claim a post-close HMAC verification they cannot do.
    """
    from turn_t3_lab_collector import verify_artifact
    from turn_controlled_scene_lab_runner import verify_transcript

    if not isinstance(artifacts, TrustedArtifacts) or not isinstance(artifacts.verifier, bytes):
        raise TypeError("live trusted artifact handles are required")
    t3, t5 = _load_json(artifacts.t3), _load_json(artifacts.t5)
    identity = dict(artifacts.identity)
    if identity.get("runId") != expected_run_id:
        raise ValueError("collector artifact identity mismatch")
    authority = dict(artifacts.authority)
    if any(authority.get(key) != identity.get(key) for key in ("origin", "realm", "runId", "epoch")):
        raise RuntimeError("BLOCKED: T3/T5 authority belongs to a different Lab")
    if not verify_artifact(t3, artifacts.verifier) or not verify_transcript(t5, identity=identity, verifier=artifacts.verifier):
        raise ValueError("collector artifact signature validation failed")
    verification = t3.get("verification")
    if (not isinstance(verification, Mapping) or verification.get("algorithm") != "HMAC-SHA256"
            or verification.get("verifierSource") != "lab-transcript-verifier/sha256:" + authority["finalVerifierDigest"]
            or verification.get("selfVerified") is not True or verification.get("verifiedBeforeLabClose") is not True):
        raise RuntimeError("BLOCKED: T3 HMAC authority is inconsistent with the final verifier")
    t3_identity = {key: identity.get(key) for key in ("origin", "realm", "runId", "epoch")}
    if identity.get("selectedTurn") is not None:
        t3_identity["selectedTurn"] = identity["selectedTurn"]
    if (t3.get("kind") != "turn-t3-lab-stage-run" or t3.get("runId") != expected_run_id
            or t3.get("identity") != t3_identity or t3.get("durationSeconds") != expected_seconds
            or t3.get("status") != "OBSERVED" or t5.get("identity") != identity
            or t3.get("signature") != authority["t3Signature"] or t5.get("signature") != authority["t5Signature"]):
        raise RuntimeError("BLOCKED: T3/T5 collector evidence is unavailable")
    automatic, static, receipts = t5.get("automatic"), t5.get("static"), t5.get("receipts")
    if (not isinstance(automatic, Mapping) or automatic.get("status") != "PASS"
            or not isinstance(static, Mapping) or static.get("status") != "PASS"
            or not isinstance(receipts, list) or len(receipts) < 20):
        raise RuntimeError("BLOCKED: signed T5 input evidence is incomplete")
    # T3 is the only timing source.  Values unavailable from its signed rows
    # block the experiment instead of accepting caller-provided replacements.
    metrics = {
        "grabP95Ms": _stage_p95(t3, "grab"), "prepareP95Ms": _stage_p95(t3, "prepare"),
        "buildP95Ms": _stage_p95(t3, "build"), "encodeP95Ms": _stage_p95(t3, "encode"),
        "packetizeP95Ms": _stage_p95(t3, "packetize"),
    }
    return {
        "t3Sha256": artifact_sha256(artifacts.t3), "t5Sha256": artifact_sha256(artifacts.t5),
        "t3Path": str(artifacts.t3.resolve()), "t5Path": str(artifacts.t5.resolve()),
        "metrics": metrics, "inputEvidence": {"status": "PASS", "actionCount": len(receipts), "effectCount": len(receipts)},
        "authority": authority,
    }


class LabCaptureCollector:
    """Concrete, headed T3/T5 collector for one already-started LabRun."""
    def __init__(self, *, output_dir: Path, headed_producer: bool, dedicated_desktop: bool, fixture_window: bool) -> None:
        self.output_dir = Path(output_dir)
        self.headed_producer, self.dedicated_desktop, self.fixture_window = headed_producer, dedicated_desktop, fixture_window

    def collect(self, lab: Any, identity: Any, *, duration_seconds: int, trace_enabled: bool) -> TrustedArtifacts:
        if duration_seconds != 60 or not isinstance(trace_enabled, bool):
            raise RuntimeError("BLOCKED: T3/T5 requires a 60-second collection with an explicit trace mode")
        if not (self.headed_producer and self.dedicated_desktop and self.fixture_window):
            raise RuntimeError("BLOCKED: headed producer and dedicated fixture desktop are required")
        # Import the existing formal collector/driver at the boundary.  This
        # makes no production Host, policy, or environment modification.
        from turn_t3_lab_collector import (collect_fixed_60_seconds, write_artifact,
                                           _drain_host_summaries, _drain_viewer_trace_tap,
                                           _install_viewer_trace_tap, _valid_scope)
        from turn_controlled_scene import ProducerProof
        from turn_controlled_scene_lab_runner import (ExecutableLabDriver, FixtureBroker,
                                                       LabTranscript, LoopbackFixtureReceiver,
                                                       MarkerLayout, PlaywrightLabViewerAdapter,
                                                       static_text_evidence)
        lab.start_host(trace_enabled=trace_enabled)
        proof = ProducerProof(secrets.randbits(64), 1, identity.origin, "pending", 0, identity.realm, identity.run_id)
        adapter = PlaywrightLabViewerAdapter.open(lab, proof, headed_producer=True)
        try:
            visible, reason = adapter.producer_window_precondition()
            if not visible:
                raise RuntimeError(f"BLOCKED: {reason}")
            session = adapter.viewer_session_identity()
            if session is None:
                raise RuntimeError("BLOCKED: headed T5 Viewer has no stable identity")
            selected_turn = lab.selected_turn_identity()
            if (session["selectedTurnId"] != selected_turn["id"]
                    or session["turnFingerprint"] != selected_turn["fingerprint"]
                    or session["turnDigest"] != selected_turn["digest"]):
                raise RuntimeError("BLOCKED: Viewer TURN identity differs from the preflighted Lab path")
            proof = ProducerProof(proof.run_nonce, proof.scene_id, identity.origin, session["attemptId"], session["generation"], identity.realm, identity.run_id)
            roi = adapter.calibrate_marker_roi(source_width=session["sourceWidth"], source_height=session["sourceHeight"])
            layout = MarkerLayout.create(attempt_id=proof.attempt_id, generation=proof.generation,
                                         source_width=session["sourceWidth"], source_height=session["sourceHeight"], roi=roi)
            adapter.configure_marker_roi(layout)
            scope = _valid_scope(session)
            if scope is None:
                raise RuntimeError("BLOCKED: T3 Viewer trace identity is unavailable")
            _install_viewer_trace_tap(adapter.viewer_page)
            log_path, offset, static_rows = lab.runtime_dir() / "host.stderr.log", 0, []
            def sample(_index: int) -> Mapping[str, Any]:
                nonlocal offset
                offset, summaries = _drain_host_summaries(log_path, offset)
                batches, joins, diagnostics = _drain_viewer_trace_tap(adapter.viewer_page)
                visual = adapter.viewer_page.evaluate("() => WebRTC.frameTraceCollector?.takeControlledVisualEvidence?.()?.[0] || null")
                if isinstance(visual, Mapping): static_rows.append(dict(visual))
                current_session = adapter.viewer_session_identity()
                return {"scope": scope, "viewerSession": current_session, "hostSummaries": summaries, "frameTraceBatches": batches,
                        "rvfcJoins": joins, "viewerDiagnostics": diagnostics}
            verifier = lab.transcript_verifier()
            identity_record = {"origin": identity.origin, "realm": identity.realm, "runId": identity.run_id, "epoch": identity.epoch,
                               "scope": {"attemptId": session["attemptId"], "generation": session["generation"], "streamId": session["streamId"]},
                               "selectedTurn": selected_turn}
            t3 = collect_fixed_60_seconds(identity=identity_record, sample=sample, verifier=verifier,
                                           wait=lambda seconds: adapter.viewer_page.wait_for_timeout(seconds * 1000),
                                           expected_viewer_session=session)
            static = static_text_evidence(proof, layout, static_rows)
            if static.get("status") != "PASS":
                automatic = {"status": "BLOCKED", "failures": ["signed-static-evidence-required"]}; receipts = []
            else:
                broker = FixtureBroker(proof, layout)
                with LoopbackFixtureReceiver(broker) as receiver:
                    adapter.calibrate_fixture_input_geometry(source_width=session["sourceWidth"], source_height=session["sourceHeight"])
                    lab.wait_host_turn_applied()
                    lease = adapter.acquire_controlled_lease()
                    if lease is None:
                        raise RuntimeError("BLOCKED: Viewer controlled lease is unavailable")
                    fixture_id = f"fixture-{identity.run_id}"
                    lab.arm_controlled_input(lease_id=lease["leaseId"], lease_epoch=lease["leaseEpoch"], fixture_id=fixture_id)
                    adapter.install_input_ack_observer(); adapter.configure_loopback_producer(endpoint=receiver.endpoint, proof=proof, layout=layout)
                    automatic = ExecutableLabDriver(lab_run=lab, viewer=adapter, producer=adapter, broker=receiver,
                                                     fixture_id=fixture_id).run()
                    receipts = automatic.get("receipts", []) if isinstance(automatic.get("receipts"), list) else []
            t5 = LabTranscript.create(verifier=verifier, identity=identity_record, static=static, automatic=automatic, receipts=receipts).as_dict()
            self.output_dir.mkdir(parents=True, exist_ok=True)
            t3_path, t5_path = self.output_dir / f"{identity.run_id}.t3.json", self.output_dir / f"{identity.run_id}.t5.json"
            write_artifact(t3_path, t3); t5_path.write_text(json.dumps(t5, sort_keys=True) + "\n", encoding="utf-8")
            authority = lab.capture_experiment_authority()
            verifier_digest = hashlib.sha256(verifier).hexdigest()
            authority = {**authority, "finalVerifierDigest": verifier_digest,
                         "t3Signature": str(t3["signature"]), "t5Signature": str(t5["signature"])}
            return TrustedArtifacts(t3_path, t5_path, identity_record, verifier, authority["policyDigest"], authority)
        finally:
            adapter.close()


class CaptureExperimentRunner:
    """Execute fixed A/B/A and B/A/B sessions plus a separate trace pair."""
    _ORDER = ("A", "B", "A", "B", "A", "B")
    def __init__(self, lab_run_factory: Any, collector: Any, *, declared_cost_metric: str,
                 opencv_threads: int, constant_config: Mapping[str, Any] | None = None) -> None:
        self._lab_run_factory, self._collector = lab_run_factory, collector
        self.metric, self.opencv_threads = declared_cost_metric, opencv_threads
        self.constant_config = dict(constant_config or {"targetFps": 20, "codec": "relay-legacy-v1", "opencvThreads": opencv_threads})

    def _one(self, variant: str, *, trace_enabled: bool) -> dict[str, Any]:
        experiment = CaptureExperiment(2.0 if variant == "A" else 1.0, self.opencv_threads)
        lab = self._lab_run_factory(); identity = lab.start("legacy", capture_experiment=experiment)
        try:
            trusted = self._collector.collect(lab, identity, duration_seconds=60, trace_enabled=trace_enabled)
            try:
                summary = summary_from_artifacts(trusted, expected_run_id=identity.run_id)
            except ValueError as exc:
                raise CaptureEvidenceError(f"BLOCKED: signed T3/T5 schema rejected: {exc}") from exc
            if not isinstance(summary.get("authority"), Mapping) or dict(summary["authority"]) != dict(trusted.authority):
                raise CaptureEvidenceError("BLOCKED: final verifier authority differs from the sealed Lab authority")
            # Current signed T3 does not yet expose all guard metrics.  Refuse
            # to invent them; this run remains a durable BLOCKED artifact.
            required = (self.metric, *_REQUIRED_GUARD_METRICS)
            if any(name not in summary["metrics"] for name in required):
                raise RuntimeError("BLOCKED: T3/T5 formal artifacts lack required guard metrics")
            binding = {"sourceCommit": _source_commit(), "policyDigest": trusted.policy_digest,
                       "sceneId": "headed-controlled-scene-v1", "sceneProofDigest": hashlib.sha256(b"headed-controlled-scene-v1").hexdigest(),
                       "authority": summary.pop("authority"), "t3Status": "PASS", "t5Status": "PASS", "stageCoverage": 1.0,
                       "dedicatedDesktop": True, "fixtureWindow": True, "headedProducer": True,
                       "inputEvidence": summary.pop("inputEvidence"), "t3Path": summary.pop("t3Path"), "t5Path": summary.pop("t5Path"),
                       "t3Sha256": summary.pop("t3Sha256"), "t5Sha256": summary.pop("t5Sha256")}
            digest = _canonical_digest(self.constant_config, binding)
            return {"schemaVersion": 1, "runId": identity.run_id, "variant": variant, "durationSeconds": 60,
                    "sceneId": binding["sceneId"], "constantConfigDigest": digest, "constantConfig": self.constant_config,
                    "sourceBinding": binding, "variableName": "captureMultiplier", "variableValue": experiment.capture_multiplier,
                    "declaredCostMetric": self.metric, "metrics": summary["metrics"], "functionalFailures": []}
        finally:
            lab.close()

    def run(self) -> dict[str, Any]:
        if not callable(self._lab_run_factory) or not hasattr(self._collector, "collect"):
            raise RuntimeError("BLOCKED: concrete LabRun and T3/T5 collector are required")
        rows = [self._one(variant, trace_enabled=True) for variant in self._ORDER]
        # Trace cost is an independent, fixed-order pair, not a label on the
        # six comparison sessions.  A is the production-equivalent 2x control.
        off, on = self._one("A", trace_enabled=False), self._one("A", trace_enabled=True)
        off["traceEnabled"], on["traceEnabled"] = False, True
        return {"schemaVersion": 1, "declaredCostMetric": self.metric, "aba": rows[:3], "bab": rows[3:], "tracePair": {"off": off, "on": on}}


def _source_commit() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    except Exception:
        return "0" * 40


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Evaluate a completed isolated capture experiment manifest")
    subcommands = parser.add_subparsers(dest="command", required=True)
    evaluate_parser = subcommands.add_parser("evaluate")
    evaluate_parser.add_argument("--manifest", required=True, help="JSON manifest containing complete A/B/A and B/A/B windows")
    run_parser = subcommands.add_parser("run", help="execute the isolated headed Lab matrix; never starts production Host")
    run_parser.add_argument("--output", required=True, type=Path, help="durable manifest or BLOCKED artifact")
    run_parser.add_argument("--artifact-dir", type=Path, required=True, help="directory for signed T3/T5 source artifacts")
    run_parser.add_argument("--viewer-token-env", required=True, help="environment variable containing the production proof token")
    run_parser.add_argument("--declared-cost-metric", choices=sorted(_DECLARED_STAGE_METRICS), required=True)
    run_parser.add_argument("--opencv-threads", choices=(0, 1), type=int, required=True)
    run_parser.add_argument("--headed-producer", action="store_true")
    run_parser.add_argument("--dedicated-desktop", action="store_true")
    run_parser.add_argument("--fixture-window", action="store_true")
    args = parser.parse_args(argv)
    if args.command == "run":
        token = os.environ.get(args.viewer_token_env)
        if not isinstance(token, str) or not token:
            result = {"schemaVersion": 1, "status": "BLOCKED", "reason": "viewer proof token environment variable is empty", "runtime": "NOT_RUN"}
        else:
            try:
                from turn_lab import LabRun
                collector = LabCaptureCollector(output_dir=args.artifact_dir, headed_producer=args.headed_producer,
                                                dedicated_desktop=args.dedicated_desktop, fixture_window=args.fixture_window)
                manifest = CaptureExperimentRunner(lambda: LabRun(viewer_token=token), collector,
                                                   declared_cost_metric=args.declared_cost_metric,
                                                   opencv_threads=args.opencv_threads).run()
                result = {"schemaVersion": 1, "status": "COMPLETE", "manifest": manifest,
                          "evaluation": evaluate_experiment_manifest(manifest), "runtime": "RUN"}
            except (RuntimeError, CaptureEvidenceError) as exc:
                result = {"schemaVersion": 1, "status": "BLOCKED", "reason": str(exc), "runtime": "NOT_RUN"}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, sort_keys=True) + "\n", encoding="utf-8")
        print(json.dumps(result, sort_keys=True))
        return 0 if result["status"] == "COMPLETE" else 2
    try:
        with open(args.manifest, encoding="utf-8") as handle:
            result = evaluate_experiment_manifest(json.load(handle))
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(json.dumps({"evaluation": _result(_STATUS_INCONCLUSIVE, f"manifest unreadable: {exc}", ""), "traceOverhead": None}, sort_keys=True))
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0 if result["evaluation"]["status"] != _STATUS_INCONCLUSIVE else 2


if __name__ == "__main__":
    raise SystemExit(main())
