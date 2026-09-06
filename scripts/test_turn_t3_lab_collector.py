import importlib.util
import sys
from pathlib import Path


SCRIPT = Path(__file__).with_name("turn_t3_lab_collector.py")
SPEC = importlib.util.spec_from_file_location("turn_t3_lab_collector", SCRIPT)
collector = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = collector
SPEC.loader.exec_module(collector)


SCOPE = {"attemptId": "attempt", "generation": 2, "streamId": "video"}
VIEWER_SESSION = {**SCOPE, "sourceWidth": 1280, "sourceHeight": 720}


class Clock:
    def __init__(self): self.value = 0.0
    def now(self): return self.value
    def wait(self, seconds): self.value += seconds


def sample(index):
    return {
        "sampleIndex": index,
        "scope": SCOPE,
        "viewerSession": VIEWER_SESSION,
        "hostSummaries": ([{"alignmentState": "OBSERVED", "counts": {"outputs": 5},
                            "coverage": {"sourceToWire": 1.0},
                            "traces": {"sourceOutputFrameCount": 5, "wireBoundCount": 5,
                                       "alignmentFailureCount": 0, "droppedTraceCount": 0},
                            "observer": {"enabled": True, "rtxPayloadTypes": [97],
                                         "originByStream": {"attempt|2|video|7": 64}}}]
                          if index and index % 5 == 0 else []),
        "frameTraceBatches": [{"type": "frame_trace_batch", "schemaVersion": 1, "traces": [{**SCOPE, "wireTimestamp": index}]}],
        "rvfcJoins": [{**SCOPE, "traceStatus": "matched", "wireTimestamp": index}],
        "viewerDiagnostics": {"acceptanceState": "PENDING", "droppedTraceCount": 0,
                              "invalidBatchCount": 0, "staleTraceCount": 0, "conflictingTraceCount": 0},
    }


def test_sixty_second_artifact_archives_host_summaries_raw_batches_rvfc_and_observer_state_with_a_run_signature():
    """Dropping an evidence class or changing a stored sample invalidates the sealed Lab artifact."""
    clock = Clock()
    artifact = collector.collect_fixed_60_seconds(
        identity={"runId": "run", "realm": "lab", "origin": "http://127.0.0.1:49999", "epoch": 2},
        sample=sample,
        verifier=b"per-run-secret",
        now=clock.now, wait=clock.wait,
    )

    assert artifact["durationSeconds"] == 60
    assert len(artifact["samples"]) == 61
    assert len(artifact["hostSummaries"]) == 12
    assert len(artifact["frameTraceBatches"]) == 61
    assert len(artifact["rvfcJoins"]) == 61
    assert artifact["observer"]["rtxPayloadTypes"] == [97]
    assert artifact["scope"] == SCOPE
    assert artifact["samples"][-1]["elapsedMs"] >= 60_000
    assert artifact["verification"]["selfVerified"] is True
    assert artifact["verification"]["verifiedBeforeLabClose"] is True
    assert artifact["verification"]["verifierSource"].startswith("lab-transcript-verifier/sha256:")
    assert b"per-run-secret" not in collector._canonical(artifact)
    assert artifact["reformat"]["status"] == "UNAVAILABLE"
    assert collector.verify_artifact(artifact, b"per-run-secret")
    artifact["rvfcJoins"][0]["wireTimestamp"] = 999
    assert not collector.verify_artifact(artifact, b"per-run-secret")


def test_sixty_second_artifact_rejects_a_first_sample_only_run_and_a_nonadvancing_clock():
    """One good initial row cannot certify later empty windows or a zero-duration run."""
    def incomplete(index):
        return sample(index) if index == 0 else {"scope": SCOPE, "hostSummaries": [], "frameTraceBatches": [],
                                                  "rvfcJoins": [], "viewerDiagnostics": sample(0)["viewerDiagnostics"]}

    artifact = collector.collect_fixed_60_seconds(
        identity={"runId": "run", "realm": "lab", "origin": "http://127.0.0.1:49999", "epoch": 2},
        sample=incomplete,
        verifier=b"per-run-secret",
        now=lambda: 0.0, wait=lambda _seconds: None,
    )

    assert artifact["status"] == "UNALIGNED"
    assert "window-5-raw-batch-missing" in artifact["failures"]
    assert "final-elapsed-under-60s" in artifact["failures"]
    assert "sample-cadence-too-early" in artifact["failures"]
    assert "window-5-host-summary-missing" in artifact["failures"]


def test_sixty_second_artifact_rejects_wrong_scope_diagnostic_loss_and_host_alignment_failure():
    """Unaccepted Viewer batches and a single failed Host window make the whole run UNALIGNED."""
    clock = Clock()
    def broken(index):
        row = sample(index)
        if index == 17:
            row["frameTraceBatches"][0]["traces"][0]["generation"] = 1
        if index == 16:
            row["viewerSession"] = {**VIEWER_SESSION, "sourceWidth": 1920}
        if index == 18:
            row["viewerDiagnostics"] = {**row["viewerDiagnostics"], "droppedTraceCount": 1}
        if index == 19:
            row["frameTraceBatches"][0]["droppedTraceCount"] = 1
        if index == 20:
            row["hostSummaries"][0]["traces"]["alignmentFailureCount"] = 1
            row["hostSummaries"][0]["observer"]["originByStream"] = {"other|2|video|7": 64}
        return row

    artifact = collector.collect_fixed_60_seconds(
        identity={"runId": "run", "realm": "lab", "origin": "http://127.0.0.1:49999", "epoch": 2},
        sample=broken, verifier=b"per-run-secret", now=clock.now, wait=clock.wait,
    )

    assert artifact["status"] == "UNALIGNED"
    assert "batch-scope-mismatch" in artifact["failures"]
    assert "viewer-session-changed" in artifact["failures"]
    assert "viewer-diagnostics-droppedTraceCount" in artifact["failures"]
    assert "raw-batch-diagnostic-drop" in artifact["failures"]
    assert "host-alignment-failure" in artifact["failures"]
    assert "observer-origin-missing-or-invalid" in artifact["failures"]


def test_sixty_second_artifact_rejects_both_early_and_late_sampling_offsets():
    """A 60-second total cannot conceal a sample more than the 250ms cadence bound from schedule."""
    class OffsetClock:
        def __init__(self, factor): self.factor, self.value = factor, 0.0
        def now(self): return self.value
        def wait(self, seconds): self.value += seconds * self.factor

    late_clock, early_clock = OffsetClock(3), OffsetClock(.5)
    late = collector.collect_fixed_60_seconds(
        identity={"runId": "late", "realm": "lab", "origin": "http://127.0.0.1:49999", "epoch": 2},
        sample=sample, verifier=b"per-run-secret", now=late_clock.now, wait=late_clock.wait,
    )
    early = collector.collect_fixed_60_seconds(
        identity={"runId": "early", "realm": "lab", "origin": "http://127.0.0.1:49999", "epoch": 2},
        sample=sample, verifier=b"per-run-secret", now=early_clock.now, wait=early_clock.wait,
    )

    assert late["status"] == early["status"] == "UNALIGNED"
    assert "sample-cadence-too-late" in late["failures"]
    assert "sample-cadence-too-early" in early["failures"]


def test_live_viewer_session_reader_rejects_a_presentation_and_rvfc_scope_split():
    """The live collector never repairs a changed Viewer identity with startup metadata."""
    class Page:
        def __init__(self): self.scope = SCOPE
        def evaluate(self, _script): return self.scope

    class Adapter:
        def __init__(self): self.viewer_page = Page()
        def viewer_session_identity(self): return {**VIEWER_SESSION}

    adapter = Adapter()
    assert collector._read_live_viewer_session(adapter) == VIEWER_SESSION
    adapter.viewer_page.scope = {**SCOPE, "generation": 3}
    assert collector._read_live_viewer_session(adapter) is None
