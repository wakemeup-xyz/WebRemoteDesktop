import importlib.util
import sys
from pathlib import Path


SCRIPT = Path(__file__).with_name("turn_t3_lab_collector.py")
SPEC = importlib.util.spec_from_file_location("turn_t3_lab_collector", SCRIPT)
collector = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = collector
SPEC.loader.exec_module(collector)


def sample(index):
    return {
        "sampleIndex": index,
        "hostSummaries": [{"alignmentState": "OBSERVED", "observer": {"enabled": True,
                            "rtxPayloadTypes": [97], "originByStream": {"a|1|video|7": 64}}}],
        "frameTraceBatches": [{"type": "frame_trace_batch", "schemaVersion": 1, "traces": [{"wireTimestamp": index}]}],
        "rvfcJoins": [{"traceStatus": "matched", "wireTimestamp": index}],
    }


def test_sixty_second_artifact_archives_host_summaries_raw_batches_rvfc_and_observer_state_with_a_run_signature():
    """Dropping an evidence class or changing a stored sample invalidates the sealed Lab artifact."""
    artifact = collector.collect_fixed_60_seconds(
        identity={"runId": "run", "realm": "lab", "origin": "http://127.0.0.1:49999", "epoch": 2},
        sample=sample,
        verifier=b"per-run-secret",
        wait=lambda _seconds: None,
    )

    assert artifact["durationSeconds"] == 60
    assert len(artifact["samples"]) == 61
    assert len(artifact["hostSummaries"]) == 61
    assert len(artifact["frameTraceBatches"]) == 61
    assert len(artifact["rvfcJoins"]) == 61
    assert artifact["observer"]["rtxPayloadTypes"] == [97]
    assert artifact["reformat"]["status"] == "UNAVAILABLE"
    assert collector.verify_artifact(artifact, b"per-run-secret")
    artifact["rvfcJoins"][0]["wireTimestamp"] = 999
    assert not collector.verify_artifact(artifact, b"per-run-secret")


def test_sixty_second_artifact_fails_closed_when_a_sample_omits_raw_trace_or_observer_compatibility():
    """A summary alone cannot substitute for raw frame trace and observer evidence."""
    def incomplete(index):
        row = sample(index)
        row["frameTraceBatches"] = []
        if index == 10:
            row["hostSummaries"] = [{"alignmentState": "OBSERVED", "observer": {"enabled": False}}]
        return row

    artifact = collector.collect_fixed_60_seconds(
        identity={"runId": "run", "realm": "lab", "origin": "http://127.0.0.1:49999", "epoch": 2},
        sample=incomplete,
        verifier=b"per-run-secret",
        wait=lambda _seconds: None,
    )

    assert artifact["status"] == "UNALIGNED"
    assert "missing-raw-frame-trace-batch" in artifact["failures"]
    assert "observer-incompatible" in artifact["failures"]
