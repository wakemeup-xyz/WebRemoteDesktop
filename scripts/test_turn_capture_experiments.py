from __future__ import annotations

import importlib.util
import hashlib
import json
import sys
import tempfile
from pathlib import Path

import pytest


SCRIPT_PATH = Path(__file__).with_name("turn_capture_experiments.py")
SPEC = importlib.util.spec_from_file_location("turn_capture_experiments", SCRIPT_PATH)
experiments = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = experiments
SPEC.loader.exec_module(experiments)


def _run(variant: str, run_id: str, cost: float, *, metric: str = "resizeP95Ms", scene: str = "scene-a") -> dict:
    constant_config = {"codec": "relay-legacy-v1", "targetFps": 20}
    artifact_dir = Path(tempfile.gettempdir()) / "wrd-turn-capture-test-artifacts"
    artifact_dir.mkdir(exist_ok=True)
    t3_path, t5_path = artifact_dir / f"{run_id}.t3.json", artifact_dir / f"{run_id}.t5.json"
    t3_path.write_text(json.dumps({"run": run_id, "kind": "t3"}))
    t5_path.write_text(json.dumps({"run": run_id, "kind": "t5"}))
    source_binding = {
        "sourceCommit": "a" * 40,
        "policyDigest": "b" * 64,
        "sceneId": scene,
        "sceneProofDigest": "c" * 64,
        "t3Status": "PASS",
        "t5Status": "PASS",
        "stageCoverage": 1.0,
        "inputEvidence": {"status": "PASS", "actionCount": 20, "effectCount": 20},
        "t3Path": str(t3_path), "t5Path": str(t5_path),
        "t3Sha256": hashlib.sha256(t3_path.read_bytes()).hexdigest(),
        "t5Sha256": hashlib.sha256(t5_path.read_bytes()).hexdigest(),
    }
    return {
        "schemaVersion": 1,
        "runId": run_id,
        "variant": variant,
        "durationSeconds": 60,
        "sceneId": scene,
        "constantConfigDigest": experiments._canonical_digest(constant_config, source_binding),
        "constantConfig": constant_config,
        "sourceBinding": source_binding,
        "variableName": "captureMultiplier",
        "variableValue": 2.0 if variant == "A" else 1.0,
        "declaredCostMetric": metric,
        "metrics": {
            metric: cost,
            "fpsLowerBound": 19.0,
            "captureAgeP95Ms": 10.0,
            "presentIntervalP95Ms": 50.0,
            "inputAckP95Ms": 20.0,
            "inputEffectP95Ms": 25.0,
        },
        "functionalFailures": [],
    }


def test_capture_experiment_is_frozen_and_preserves_explicit_single_variable():
    experiment = experiments.CaptureExperiment(capture_multiplier=1.0, opencv_threads=None)

    assert experiment.capture_multiplier == 1.0
    assert experiment.opencv_threads is None
    assert experiment.capture_fps_for_target(20) == 20


@pytest.mark.parametrize(
    "multiplier,threads",
    [(True, None), (1.5, None), (3.0, None), (1.0, True), (1.0, 2)],
)
def test_capture_experiment_rejects_boolean_and_out_of_plan_parameters(multiplier, threads):
    with pytest.raises((TypeError, ValueError)):
        experiments.CaptureExperiment(multiplier, threads)


@pytest.mark.parametrize("threads", [0, 1])
def test_capture_experiment_accepts_the_explicit_lab_opencv_choices(threads):
    assert experiments.CaptureExperiment(1.0, threads).opencv_threads == threads


@pytest.mark.parametrize("target_fps", [True, False, 4, 31, 20.0, "20"])
def test_capture_experiment_rejects_non_runtime_target_fps(target_fps):
    with pytest.raises((TypeError, ValueError)):
        experiments.CaptureExperiment(1.0, None).capture_fps_for_target(target_fps)


def test_repeated_runs_require_complete_aba_bab_and_only_yield_confirmation_candidate():
    aba = [_run("A", "a1", 12), _run("B", "b1", 8), _run("A", "a2", 11)]
    bab = [_run("B", "b2", 7), _run("A", "a3", 10), _run("B", "b3", 9)]

    result = experiments.evaluate_repeated_runs(aba, bab, "resizeP95Ms")

    assert result["status"] == "candidate-requires-confirmation"
    assert result["metric"] == "resizeP95Ms"
    assert result["candidateRequiresConfirmation"] is True


def test_repeated_runs_reject_missing_window_wrong_order_and_late_metric_change():
    valid_aba = [_run("A", "a1", 12), _run("B", "b1", 8), _run("A", "a2", 11)]
    valid_bab = [_run("B", "b2", 7), _run("A", "a3", 10), _run("B", "b3", 9)]

    missing = experiments.evaluate_repeated_runs(valid_aba[:2], valid_bab, "resizeP95Ms")
    wrong_order = experiments.evaluate_repeated_runs(
        valid_aba, [valid_bab[1], valid_bab[0], valid_bab[2]], "resizeP95Ms"
    )
    late_metric = experiments.evaluate_repeated_runs(
        valid_aba,
        [_run("B", "b2", 7, metric="encodeP95Ms"), _run("A", "a3", 10), _run("B", "b3", 9)],
        "resizeP95Ms",
    )

    assert [result["status"] for result in (missing, wrong_order, late_metric)] == ["INCONCLUSIVE"] * 3


def test_repeated_runs_do_not_turn_frame_samples_or_partial_evidence_into_a_pass():
    aba = [_run("A", "a1", 8), _run("B", "b1", 9), _run("A", "a2", 10)]
    bab = [_run("B", "b2", 11), _run("A", "a3", 7), _run("B", "b3", 12)]
    bab[0]["sourceBinding"]["stageCoverage"] = 0.9

    result = experiments.evaluate_repeated_runs(aba, bab, "resizeP95Ms")

    assert result["status"] == "INCONCLUSIVE"
    assert result["status"] != "PASS"


def test_repeated_runs_reject_a_hidden_fixed_configuration_change():
    aba = [_run("A", "a1", 12), _run("B", "b1", 8), _run("A", "a2", 11)]
    bab = [_run("B", "b2", 7), _run("A", "a3", 10), _run("B", "b3", 9)]
    bab[2]["constantConfig"] = {"codec": "relay-legacy-v1", "targetFps": 15}

    result = experiments.evaluate_repeated_runs(aba, bab, "resizeP95Ms")

    assert result["status"] == "INCONCLUSIVE"
    assert "constant" in result["reason"]


def test_repeated_runs_reject_unbound_digest_or_incomplete_t3_t5_input_evidence():
    aba = [_run("A", "a1", 12), _run("B", "b1", 8), _run("A", "a2", 11)]
    bab = [_run("B", "b2", 7), _run("A", "a3", 10), _run("B", "b3", 9)]
    for run in [*aba, *bab]:
        run["constantConfigDigest"] = "forged"
    bab[2]["sourceBinding"]["inputEvidence"]["effectCount"] = 0

    result = experiments.evaluate_repeated_runs(aba, bab, "resizeP95Ms")

    assert result["status"] == "INCONCLUSIVE"


def test_trace_overhead_report_is_read_only_and_labels_both_modes():
    trace_off = {"resizeP95Ms": 4.0, "traceEnabled": False}
    trace_on = {"resizeP95Ms": 5.5, "traceEnabled": True}

    report = experiments.trace_overhead_report(trace_off, trace_on, "resizeP95Ms")

    assert report == {
        "metric": "resizeP95Ms",
        "traceOff": 4.0,
        "traceOn": 5.5,
        "overhead": 1.5,
    }
    assert trace_off == {"resizeP95Ms": 4.0, "traceEnabled": False}
    assert trace_on == {"resizeP95Ms": 5.5, "traceEnabled": True}


def test_experiment_manifest_driver_evaluates_runs_and_requires_a_trace_pair():
    aba = [_run("A", "a1", 12), _run("B", "b1", 8), _run("A", "a2", 11)]
    bab = [_run("B", "b2", 7), _run("A", "a3", 10), _run("B", "b3", 9)]
    manifest = {
        "schemaVersion": 1,
        "declaredCostMetric": "resizeP95Ms",
        "aba": aba,
        "bab": bab,
        "tracePair": {
            "off": {"resizeP95Ms": 4.0, "traceEnabled": False, "constantConfigDigest": aba[0]["constantConfigDigest"]},
            "on": {"resizeP95Ms": 5.5, "traceEnabled": True, "constantConfigDigest": aba[0]["constantConfigDigest"]},
        },
    }

    result = experiments.evaluate_experiment_manifest(manifest)

    assert result["evaluation"]["status"] == "candidate-requires-confirmation"
    assert result["traceOverhead"]["overhead"] == 1.5
    assert experiments.evaluate_experiment_manifest({**manifest, "tracePair": {}})["evaluation"]["status"] == "INCONCLUSIVE"


def test_runner_uses_aba_bab_and_a_real_trace_off_on_pair(monkeypatch, tmp_path):
    calls, closed = [], []
    class Identity:
        def __init__(self, run_id):
            self.run_id, self.origin, self.realm, self.epoch = run_id, "http://127.0.0.1:49999", "lab-test", 1
    class Lab:
        def start(self, _mode, *, capture_experiment):
            calls.append((capture_experiment.capture_multiplier, None))
            return Identity(f"run-{len(calls)}")
        def close(self): closed.append(True)
    class Collector:
        def collect(self, _lab, identity, *, duration_seconds, trace_enabled):
            calls[-1] = (calls[-1][0], trace_enabled)
            return experiments.TrustedArtifacts(tmp_path / "t3", tmp_path / "t5", {"runId": identity.run_id}, b"live", "b" * 64)
    def summary(_trusted, *, expected_run_id):
        return {"metrics": {"resizeP95Ms": 1.0, "fpsLowerBound": 19.0, "captureAgeP95Ms": 1.0,
                             "presentIntervalP95Ms": 50.0, "inputAckP95Ms": 1.0, "inputEffectP95Ms": 1.0},
                "inputEvidence": {"status": "PASS", "actionCount": 31, "effectCount": 31},
                "t3Path": str(tmp_path / expected_run_id), "t5Path": str(tmp_path / expected_run_id),
                "t3Sha256": "a" * 64, "t5Sha256": "b" * 64}
    monkeypatch.setattr(experiments, "summary_from_artifacts", summary)
    runner = experiments.CaptureExperimentRunner(Lab, Collector(), declared_cost_metric="resizeP95Ms", opencv_threads=0)
    manifest = runner.run()
    assert [row[0] for row in calls] == [2.0, 1.0, 2.0, 1.0, 2.0, 1.0, 2.0, 2.0]
    assert [row[1] for row in calls] == [True] * 6 + [False, True]
    assert [row["variant"] for row in manifest["aba"]] == ["A", "B", "A"]
    assert [row["variant"] for row in manifest["bab"]] == ["B", "A", "B"]
    assert len(closed) == 8


def test_concrete_collector_allows_trace_off_to_reach_the_existing_desktop_gate(tmp_path):
    """The trace-overhead pair needs a real trace-disabled collection path."""
    collector = experiments.LabCaptureCollector(
        output_dir=tmp_path, headed_producer=False, dedicated_desktop=False, fixture_window=False,
    )

    with pytest.raises(RuntimeError, match="headed producer and dedicated fixture desktop"):
        collector.collect(None, None, duration_seconds=60, trace_enabled=False)


@pytest.mark.parametrize("mutation", ["missing", "wrong-run", "bad-status", "short-window"])
def test_artifact_summary_fail_closes_missing_or_invalid_t3_t5_evidence(tmp_path, mutation):
    t3, t5 = tmp_path / "t3.json", tmp_path / "t5.json"
    t3.write_text(json.dumps({"schemaVersion": 1, "runId": "run", "durationSeconds": 60, "status": "PASS", "metrics": {"resizeP95Ms": 1}}))
    t5.write_text(json.dumps({"schemaVersion": 1, "runId": "run", "durationSeconds": 60, "status": "PASS", "inputEvidence": {"status": "PASS"}}))
    if mutation == "missing": t5.unlink()
    elif mutation == "wrong-run": t5.write_text(t5.read_text().replace('"run"', '"other"'))
    elif mutation == "bad-status": t5.write_text(t5.read_text().replace('"PASS"', '"NOT_RUN"', 1))
    elif mutation == "short-window": t5.write_text(t5.read_text().replace('60', '59', 1))
    trusted = experiments.TrustedArtifacts(t3, t5, {"runId": "run", "realm": "lab", "origin": "http://127.0.0.1:49999", "epoch": 1}, b"live", "a" * 64)
    with pytest.raises((ValueError, RuntimeError)):
        experiments.summary_from_artifacts(trusted, expected_run_id="run")


@pytest.mark.parametrize(
    "aba,bab,metric",
    [
        (None, [], "resizeP95Ms"),
        ("ABA", [], "resizeP95Ms"),
        ([{"variant": ["unhashable"]}], [], "resizeP95Ms"),
        ([_run("A", "a1", 1), _run("B", "b1", 1), _run("A", "a2", 1)], [], True),
    ],
)
def test_evaluator_fail_closes_arbitrary_json_without_raising(aba, bab, metric):
    result = experiments.evaluate_repeated_runs(aba, bab, metric)

    assert result["status"] == "INCONCLUSIVE"
