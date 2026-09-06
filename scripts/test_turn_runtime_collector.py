import importlib.util
from pathlib import Path

import pytest


SCRIPT = Path(__file__).with_name("turn_runtime_collector.py")
SPEC = importlib.util.spec_from_file_location("turn_runtime_collector", SCRIPT)
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


def paint_sample(index, *, age=None, maximum=None, interval=None, attempt="attempt-a", video=1, geometry=None):
    geometry = geometry or {"x": 10, "y": 20, "width": 1280, "height": 720,
                            "minX": 10, "maxX": 10, "minY": 20, "maxY": 20,
                            "minWidth": 1280, "maxWidth": 1280, "minHeight": 720, "maxHeight": 720}
    return {"elapsedMs": index * 1000, "cadenceLateMs": 0, "selectedPair": {"type": "relay"},
            "pcConnectionState": "connected", "socketConnected": True, "connectionAttemptId": attempt,
            "videoIdentity": video, "collectorPhaseId": 3, "resolution": {"width": 1280, "height": 720},
            "paintResolution": {"minWidth": 1280, "maxWidth": 1280, "minHeight": 720, "maxHeight": 720},
            "derivedFps": 20, "jitterBufferMs": 20, "paintAgeMs": age, "maxPaintGapMs": maximum,
            "intervalMaxPaintGapMs": interval, "firstPaintObserved": index > 0,
            "paintEvidenceStatus": "complete" if index > 0 else "awaiting-first-paint", "geometry": geometry}


def test_collector_defaults_to_required_720p_and_explicit_1080p_durations():
    args = collector.parse_args([])
    assert args.phase == "both"
    assert args.output is None
    assert args.duration_seconds is None
    assert collector.phase_duration_seconds("720p", args.duration_seconds) == 600
    assert collector.phase_duration_seconds("1080p", args.duration_seconds) == 300
    with pytest.raises(SystemExit):
        collector.parse_args(["--phase", "4k"])


def test_summary_rejects_transient_painted_resolution_and_missing_bounds():
    samples = [paint_sample(i, age=10, maximum=50, interval=50) for i in range(3)]
    assert collector.summarize_phase("720p", samples, duration_seconds=2)["ok"]
    samples[1]["paintResolution"]["minWidth"] = 640
    assert "resolution-changed" in collector.summarize_phase("720p", samples, duration_seconds=2)["failures"]
    samples[1]["paintResolution"] = None
    assert "missing-paint-resolution" in collector.summarize_phase("720p", samples, duration_seconds=2)["failures"]


def test_continuous_collector_retains_each_one_hertz_sample_after_first_healthy_sample():
    now = [0]

    def wait(milliseconds):
        now[0] += milliseconds

    samples = collector.collect_phase_samples(
        3,
        sample=lambda index: {
            "sampleIndex": index,
            "selectedPair": {"type": "relay", "protocol": "udp"},
            "pcConnectionState": "connected",
            "derivedFps": 20,
            "paintGapMs": 50,
        },
        now_ms=lambda: now[0],
        wait_ms=wait,
    )
    assert len(samples) == 4
    assert [sample["sampleIndex"] for sample in samples] == [0, 1, 2, 3]
    assert [sample["elapsedMs"] for sample in samples] == [0, 1000, 2000, 3000]


def test_continuous_collector_marks_slow_samples_and_summary_fails_cadence():
    now = [0]
    def slow_sample(_index):
        now[0] += 2500
        return {"selectedPair": {"type": "relay"}, "pcConnectionState": "connected", "socketConnected": True,
                "resolution": {"width": 1280, "height": 720}, "derivedFps": 20, "paintGapMs": 10, "jitterBufferMs": 20}
    samples = collector.collect_phase_samples(2, sample=slow_sample, now_ms=lambda: now[0], wait_ms=lambda ms: now.__setitem__(0, now[0] + ms))
    assert samples[-1]["elapsedMs"] >= 2000
    assert any(sample["cadenceLateMs"] > 250 for sample in samples)
    assert "sample-cadence" in collector.summarize_phase("720p", samples)["failures"]


@pytest.mark.parametrize("sidecar_ms, next_late_ms", [(500, 0), (1500, 500)])
def test_screenshot_sidecar_runs_after_measurement_without_hiding_overrun(sidecar_ms, next_late_ms):
    now = [0]

    def sidecar(index):
        if index == 0:
            now[0] += sidecar_ms

    samples = collector.collect_phase_samples(
        2, sample=lambda index: paint_sample(index, age=10, maximum=50, interval=50),
        now_ms=lambda: now[0], wait_ms=lambda ms: now.__setitem__(0, now[0] + ms),
        after_sample=sidecar,
    )
    assert samples[0]["elapsedMs"] == 0
    assert samples[1]["cadenceLateMs"] == next_late_ms
    assert samples[2]["elapsedMs"] == 2000
    assert ("sample-cadence" in collector.summarize_phase("720p", samples, duration_seconds=2)["failures"]) == (next_late_ms > 250)


def test_phase_summary_rejects_later_disconnected_or_non_relay_sample():
    summary = collector.summarize_phase("720p", [
        {"elapsedMs": 0, "cadenceLateMs": 0, "selectedPair": {"type": "relay"}, "pcConnectionState": "connected", "socketConnected": True, "resolution": {"height": 720}, "decodedDelta": 20, "derivedFps": 20, "paintGapMs": 50, "jitterBufferMs": 20},
        {"elapsedMs": 1000, "cadenceLateMs": 0, "selectedPair": {"type": "host"}, "pcConnectionState": "disconnected", "socketConnected": True, "resolution": {"height": 720}, "decodedDelta": 0, "derivedFps": 0, "paintGapMs": 1200, "jitterBufferMs": 20},
    ], duration_seconds=1)
    assert summary["ok"] is False
    assert {"fps-p50", "non-relay-sample", "pc-not-connected", "missing-max-paint-gap"}.issubset(summary["failures"])


def test_runtime_sample_redacts_candidate_addresses_and_credentials():
    sample = collector.redact_runtime_sample({
        "selectedPair": {"type": "relay", "protocol": "udp", "localAddress": "10.0.0.2:5000", "remoteAddress": "203.0.113.7:3478"},
        "turnUsername": "secret-user",
        "turnCredential": "secret-password",
    })
    assert sample == {"selectedPair": {"type": "relay", "protocol": "udp"}}


def test_summary_fails_closed_for_missing_paint_socket_or_wrong_resolution():
    samples = [{"elapsedMs": 0, "cadenceLateMs": 0, "selectedPair": {"type": "relay"}, "pcConnectionState": "connected", "socketConnected": False,
                "resolution": {"width": 0, "height": 0}, "derivedFps": 20, "paintGapMs": None, "jitterBufferMs": 20} for _ in range(601)]
    summary = collector.summarize_phase("720p", samples)
    assert {"socket-not-connected", "resolution-class", "missing-first-paint"}.issubset(summary["failures"])


def test_boundary_warmup_sample_may_lack_paint_but_later_samples_must_have_it():
    samples = [{"elapsedMs": index * 1000, "cadenceLateMs": 0, "selectedPair": {"type": "relay"}, "pcConnectionState": "connected", "socketConnected": True,
                "resolution": {"width": 1280, "height": 720}, "derivedFps": 20, "paintGapMs": None if index == 0 else 20, "jitterBufferMs": 20}
               for index in range(3)]
    assert "missing-first-paint" in collector.summarize_phase("720p", samples, duration_seconds=2)["failures"]
    samples[2]["paintGapMs"] = None
    assert "invalid-paint-age" in collector.summarize_phase("720p", samples, duration_seconds=2)["failures"]


def test_phase_summary_rejects_old_paint_age_artifacts_without_interval_or_geometry_evidence():
    samples = [
        {"elapsedMs": 0, "cadenceLateMs": 0, "selectedPair": {"type": "relay"}, "pcConnectionState": "connected", "socketConnected": True,
         "connectionAttemptId": "attempt-a", "videoIdentity": 1, "resolution": {"width": 1280, "height": 720}, "derivedFps": 20, "paintAgeMs": None, "jitterBufferMs": 20},
        {"elapsedMs": 1000, "cadenceLateMs": 0, "selectedPair": {"type": "relay"}, "pcConnectionState": "connected", "socketConnected": True,
         "connectionAttemptId": "attempt-a", "videoIdentity": 1, "resolution": {"width": 1280, "height": 720}, "derivedFps": 20, "paintAgeMs": 1000, "jitterBufferMs": 20},
        {"elapsedMs": 2000, "cadenceLateMs": 0, "selectedPair": {"type": "relay"}, "pcConnectionState": "connected", "socketConnected": True,
         "connectionAttemptId": "attempt-a", "videoIdentity": 1, "resolution": {"width": 1280, "height": 720}, "derivedFps": 20, "paintAgeMs": 510, "jitterBufferMs": 20},
    ]
    summary = collector.summarize_phase("720p", samples, duration_seconds=2)
    assert summary["ok"] is False
    assert "missing-max-paint-gap" in summary["failures"]


def test_phase_summary_rejects_a_1490ms_gap_even_when_sampled_paint_ages_are_below_the_limit():
    samples = [paint_sample(0), paint_sample(1, age=1000, maximum=1000, interval=1000),
               paint_sample(2, age=510, maximum=1490, interval=1490)]
    summary = collector.summarize_phase("720p", samples, duration_seconds=2)
    assert summary["ok"] is False
    assert {"max-paint-gap", "interval-paint-gap"}.issubset(summary["failures"])
    assert summary["maxPaintGapMs"] == 1490


def test_phase_summary_accepts_complete_20fps_evidence_with_one_pixel_geometry_tolerance():
    shifted = {"x": 11, "y": 20.5, "width": 1281, "height": 719,
               "minX": 10, "maxX": 11, "minY": 20, "maxY": 20.5,
               "minWidth": 1280, "maxWidth": 1281, "minHeight": 719, "maxHeight": 720}
    samples = [paint_sample(0), paint_sample(1, age=50, maximum=50, interval=50),
               paint_sample(2, age=50, maximum=50, interval=50, geometry=shifted)]
    assert collector.summarize_phase("720p", samples, duration_seconds=2)["ok"] is True


def test_periodic_paint_stall_gate_rejects_600_repeated_subsecond_pulses():
    frame_gaps = [gap for _ in range(600) for gap in ([50] * 17 + [150])]
    failures = collector.periodic_paint_stall_failures([
        {"frameGapsMs": frame_gaps, "paintFrameSampleStatus": "complete", "paintFrameSegment": "a"}
    ], target_fps=20)
    assert "periodic-paint-stall" in failures


def test_periodic_paint_stall_gate_retains_rvfc_timing_across_one_second_samples():
    samples = [{"frameGapsMs": [50] * 17 + [150], "paintFrameSampleStatus": "complete", "paintFrameSegment": "a"}
               for _ in range(5)]
    assert "periodic-paint-stall" in collector.periodic_paint_stall_failures(samples, target_fps=20)


def test_periodic_paint_stall_gate_accepts_uniform_and_isolated_but_fails_closed_on_missing_frames():
    assert collector.periodic_paint_stall_failures([
        {"frameGapsMs": [50] * 120, "paintFrameSampleStatus": "complete", "paintFrameSegment": "a"}
    ], target_fps=20) == []
    assert collector.periodic_paint_stall_failures([
        {"frameGapsMs": [50] * 17 + [150] + [50] * 240, "paintFrameSampleStatus": "complete", "paintFrameSegment": "a"}
    ], target_fps=20) == []
    assert "periodic-paint-unaligned" in collector.periodic_paint_stall_failures([
        {"frameGapsMs": [50], "paintFrameSampleStatus": "dropped", "paintFrameSegment": "a"}
    ], target_fps=20)


def test_periodic_paint_stall_does_not_join_events_across_pause_or_generation_boundaries():
    samples = [
        {"frameGapsMs": [50] * 17 + [150], "paintFrameSampleStatus": "complete", "paintFrameSegment": "a"},
        {"frameGapsMs": [50] * 17 + [150], "paintFrameSampleStatus": "complete", "paintFrameSegment": "paused"},
        {"frameGapsMs": [50] * 17 + [150], "paintFrameSampleStatus": "complete", "paintFrameSegment": "new-generation"},
    ]
    assert collector.periodic_paint_stall_failures(samples, target_fps=20) == []


def test_marker_failures_only_lifts_static_input_gate_for_full_remote_scene_pass_and_pause_requires_two_seconds():
    base = {"pauseResumeRefresh": {"pauseResume": {"suspended": True, "active": True, "freshFrame": True, "resumeAfterMs": 1999},
                                   "refresh": {"healthyRelay": True, "freshFrame": True}}}
    assert "pause-resume" in collector.marker_failures(base)
    base["pauseResumeRefresh"]["pauseResume"]["resumeAfterMs"] = 2000
    base["sceneResult"] = {"status": "PASS", "executionMode": "producer-local"}
    assert "static-text-and-input-not-run" in collector.marker_failures(base)
    base["sceneResult"] = {"status": "PASS", "executionMode": "automatic-isolated", "producerProof": {"run_nonce": 5, "scene_id": 1, "origin": "http://127.0.0.1:9999", "attempt_id": "a", "generation": 1}, "inputIds": ["i"], "sendSamples": [{"inputId": "i", "viewerClockMs": 1, "attemptId": "a", "generation": 1, "streamId": "video"}], "ackSamples": [{"inputId": "i", "status": "applied", "viewerClockMs": 2, "attemptId": "a", "generation": 1, "streamId": "video"}], "producerSamples": [{"inputId": "i", "focused": True, "runNonce": 5, "actionId": 8, "tick": 1, "attemptId": "a", "generation": 1, "streamId": "video"}], "visualSamples": [{"marker": {"runNonce": 5, "sceneId": 1, "actionId": 8, "tick": 1}, "viewerClockMs": 3, "attemptId": "a", "generation": 1, "streamId": "video", "rtpTimestamp": 3, "wireTimestamp": 3, "captureSeq": 4, "rtpOrigin": 1, "traceStatus": "matched"}]}
    # JSON evidence cannot self-certify a remote scene; only the in-process
    # registered driver result is trusted by the collector.
    assert "static-text-and-input-not-run" in collector.marker_failures(base)


def test_marker_failures_rejects_a_scene_result_without_the_t3_wire_join_fields():
    marker = {"pauseResumeRefresh": {"pauseResume": {"suspended": True, "active": True, "freshFrame": True, "resumeAfterMs": 2000},
                                      "refresh": {"healthyRelay": True, "freshFrame": True}},
              "sceneResult": {"status": "PASS", "executionMode": "automatic-isolated", "inputIds": ["i"], "ackSamples": [{"inputId": "i"}], "visualSamples": [{"rtpAligned": True}]}}
    assert "static-text-and-input-not-run" in collector.marker_failures(marker)


def test_marker_failures_rejects_forged_mode_and_input_lists_without_producer_causality():
    marker = {"pauseResumeRefresh": {"pauseResume": {"suspended": True, "active": True, "freshFrame": True, "resumeAfterMs": 2000},
                                      "refresh": {"healthyRelay": True, "freshFrame": True}},
              "sceneResult": {"status": "PASS", "executionMode": "operator-remote", "inputIds": ["invented"], "ackSamples": [{"inputId": "invented", "status": "applied"}], "visualSamples": [{"rtpAligned": True, "rtpTimestamp": 1, "wireTimestamp": 1, "captureSeq": 1}]}}
    assert "static-text-and-input-not-run" in collector.marker_failures(marker)


def test_controlled_producer_id_alone_stays_not_run_and_never_dispatches_input():
    result = collector.record_interactions(object(), enabled=True)
    assert result["status"] == "NOT_RUN"
    assert result["inputIds"] == []
    assert "Viewer-only" in result["reason"]


def test_registered_lab_driver_can_supply_a_sealed_remote_scene_to_the_collector():
    from turn_controlled_scene import (AUTOMATIC_ISOLATED, ControlledSceneDriver, ProducerProof)
    from turn_lab_input_guard import LabInputGuard
    proof = ProducerProof(5, 7, "http://127.0.0.1:49999", "a", 1)
    class Viewer:
        def send_input(self, action, **_kwargs): return {"inputId": action["inputId"], "viewerClockMs": 1, "attemptId": "a", "generation": 1, "streamId": "video"}
        def wait_for_applied_ack(self, input_id): return {"inputId": input_id, "status": "applied", "viewerClockMs": 2, "attemptId": "a", "generation": 1, "streamId": "video"}
        def decoded_visual(self, _input_id): return {"marker": {"runNonce": 5, "sceneId": 7, "tick": 1, "actionId": 8}, "viewerClockMs": 3, "attemptId": "a", "generation": 1, "streamId": "video", "rtpTimestamp": 9, "wireTimestamp": 9, "captureSeq": 1, "rtpOrigin": 1, "traceStatus": "matched"}
    class Producer:
        def event_for(self, input_id): return {"inputId": input_id, "runNonce": 5, "sceneId": 7, "actionId": 8, "tick": 1, "focused": True, "attemptId": "a", "generation": 1, "streamId": "video"}
    guard = LabInputGuard(expected_lease_id="lease", expected_proof_token="proof", expected_fixture_id="fixture", desktop_proof=lambda: {"leaseId": "lease", "proofToken": "proof", "fixtureId": "fixture", "isolated": True, "foreground": True, "fixtureWindow": True}, input_handler=lambda _action: None)
    action = {"inputId": "i", "actionId": 8, "leaseId": "lease", "proofToken": "proof", "fixtureId": "fixture"}
    guard.bind_controlled_input({key: action[key] for key in ("inputId", "leaseId", "proofToken", "fixtureId")})
    guard.install_at_lab_host(object())
    evidence = collector.record_interactions(None, True, scene_driver=ControlledSceneDriver(viewer=Viewer(), producer=Producer(), proof=proof, execution_mode=AUTOMATIC_ISOLATED, guard=guard, actions=[action]))
    assert evidence["status"] == "PASS" and evidence.result.driver_generated
    assert "_trustedSceneResult" not in evidence
    assert "_trustedSceneResult" not in __import__("json").dumps(evidence)
    marker = {"pauseResumeRefresh": {"pauseResume": {"suspended": True, "active": True, "freshFrame": True, "resumeAfterMs": 2000}, "refresh": {"healthyRelay": True, "freshFrame": True}}, "sceneResult": evidence}
    assert "static-text-and-input-not-run" not in collector.marker_failures(marker)


def test_lab_viewer_roi_adapter_requires_encoded_size_and_declares_nonzero_marker_roi():
    calls = []
    class Page:
        def evaluate(self, script, value=None): calls.append((script, value)); return True
    adapter = collector.LabViewerEvidenceAdapter(Page(), roi={"x": 64, "y": 48, "width": 256, "height": 128}, source_size=(1280, 720), dpr=2)
    assert adapter.configure()
    assert calls[0][1]["sourceWidth"] == 1280 and calls[0][1]["roi"]["x"] == 64
    with pytest.raises(ValueError):
        collector.LabViewerEvidenceAdapter(Page(), roi={"x": 0, "y": 48, "width": 256, "height": 128}, source_size=(1280, 720), dpr=2)


def test_malformed_scene_result_fails_closed_instead_of_crashing_the_collector():
    marker = {"pauseResumeRefresh": {"pauseResume": {"suspended": True, "active": True, "freshFrame": True, "resumeAfterMs": 2000},
                                      "refresh": {"healthyRelay": True, "freshFrame": True}}, "sceneResult": "PASS"}
    assert "static-text-and-input-not-run" in collector.marker_failures(marker)


def test_malformed_pause_timing_fails_closed_instead_of_throwing():
    marker = {"pauseResumeRefresh": {"pauseResume": {"suspended": True, "active": True, "freshFrame": True, "resumeAfterMs": "not-a-number"},
                                      "refresh": {"healthyRelay": True, "freshFrame": True}}}
    assert "pause-resume" in collector.marker_failures(marker)


def test_marker_failures_reuses_strict_scene_validation_for_wrong_scene_and_zero_join():
    marker = {"pauseResumeRefresh": {"pauseResume": {"suspended": True, "active": True, "freshFrame": True, "resumeAfterMs": 2000}, "refresh": {"healthyRelay": True, "freshFrame": True}},
              "sceneResult": {"status": "PASS", "executionMode": "automatic-isolated",
                              "producerProof": {"run_nonce": 5, "scene_id": 7, "origin": "http://127.0.0.1:9999", "attempt_id": "a", "generation": 1},
                              "inputIds": ["i"], "sendSamples": [{"inputId": "i", "viewerClockMs": 1, "attemptId": "a", "generation": 1, "streamId": "video"}],
                              "ackSamples": [{"inputId": "i", "status": "applied", "viewerClockMs": 2, "attemptId": "a", "generation": 1, "streamId": "video"}],
                              "producerSamples": [{"inputId": "i", "focused": True, "runNonce": 5, "actionId": 1, "tick": 1, "attemptId": "a", "generation": 1, "streamId": "video"}],
                              "visualSamples": [{"marker": {"runNonce": 5, "sceneId": 999, "tick": 1, "actionId": 1}, "viewerClockMs": 3, "attemptId": "a", "generation": 1, "streamId": "video", "rtpTimestamp": 0, "wireTimestamp": 0, "captureSeq": 1, "rtpOrigin": 0}]}}
    assert "static-text-and-input-not-run" in collector.marker_failures(marker)


def test_periodic_gate_requires_one_frozen_active_target_fps_in_summary():
    samples = [paint_sample(0), paint_sample(1, age=50, maximum=50, interval=50)]
    for item in samples:
        item.update({"paintFrameSampleStatus": "complete", "paintFrameSegment": "a", "frameGapsMs": [50], "activeTargetFps": 20})
    samples[1]["activeTargetFps"] = 15
    assert "periodic-paint-unaligned" in collector.summarize_phase("720p", samples, duration_seconds=1)["failures"]


def test_pause_resume_keeps_the_media_phase_suspended_for_two_seconds(monkeypatch):
    now = [0]
    phase = ["active"]
    class Locator:
        def click(self):
            phase[0] = "suspended" if phase[0] == "active" else "active"
    class Page:
        def locator(self, _selector): return Locator()
        def evaluate(self, _script):
            if "getMediaAppliedPhase" in _script: return phase[0]
            if "Number(WebRTC?._videoFrameSeq" in _script and "attempt" not in _script: return 2
            return {"attempt": "a", "frame": 1}
        def wait_for_timeout(self, milliseconds): now[0] += milliseconds
    monkeypatch.setattr(collector, "_wait_for_phase", lambda _page, expected, **_kwargs: phase[0] == expected)
    monkeypatch.setattr(collector, "wait_for_healthy_relay", lambda _page, **_kwargs: True)
    result = collector.record_pause_resume_refresh(Page(), clock=lambda: now[0] / 1000)
    assert result["pauseResume"]["resumeAfterMs"] >= 2000
    assert result["pauseResume"]["suspendedAtMs"] == 0
    assert result["pauseResume"]["resumeRequestedAtMs"] >= 2000


def test_pause_resume_does_not_toggle_again_when_suspend_never_applies(monkeypatch):
    clicks, now = [], [0]
    class Locator:
        def __init__(self, selector): self.selector = selector
        def click(self): clicks.append(self.selector)
    class Page:
        def locator(self, selector): return Locator(selector)
        def evaluate(self, _script):
            if "getMediaAppliedPhase" in _script: return "active"
            if "Number(WebRTC?._videoFrameSeq" in _script and "attempt" not in _script: return 1
            return {"attempt": "a", "frame": 1}
        def wait_for_timeout(self, milliseconds): now[0] += milliseconds
    monkeypatch.setattr(collector, "_wait_for_phase", lambda _page, expected, **_kwargs: False)
    monkeypatch.setattr(collector, "wait_for_healthy_relay", lambda _page, **_kwargs: True)
    result = collector.record_pause_resume_refresh(Page(), clock=lambda: now[0] / 1000)
    assert clicks == ["#pauseBtn"]
    assert result["pauseResume"]["suspended"] is False
    assert result["pauseResume"]["active"] is False
    assert result["pauseResume"]["resumeRequestedAtMs"] is None


def test_phase_summary_fails_when_the_connection_attempt_or_geometry_changes():
    changed_geometry = {"x": 12, "y": 20, "width": 1280, "height": 720,
                        "minX": 10, "maxX": 12, "minY": 20, "maxY": 20,
                        "minWidth": 1280, "maxWidth": 1280, "minHeight": 720, "maxHeight": 720}
    samples = [paint_sample(0), paint_sample(1, age=50, maximum=50, interval=50),
               paint_sample(2, age=50, maximum=50, interval=50, attempt="attempt-b", geometry=changed_geometry)]
    failures = collector.summarize_phase("720p", samples, duration_seconds=2)["failures"]
    assert {"connection-attempt-changed", "geometry-changed"}.issubset(failures)


def test_phase_summary_fails_closed_for_nonfinite_paint_or_resolution_values():
    samples = [paint_sample(0), paint_sample(1, age=float("nan"), maximum=50, interval=50),
               paint_sample(2, age=50, maximum=50, interval=50)]
    samples[2]["resolution"]["width"] = float("inf")
    failures = collector.summarize_phase("720p", samples, duration_seconds=2)["failures"]
    assert {"invalid-paint-age", "missing-resolution"}.issubset(failures)


def test_seeded_storage_uses_python_playwright_single_script_argument():
    calls = []
    class Context:
        def add_init_script(self, script=None, *, path=None):
            calls.append((script, path))
    collector.seed_viewer_storage(Context(), "token-value", {"token": "admission-value"})
    assert len(calls) == 1
    assert "token-value" in calls[0][0]
    assert "admission-value" in calls[0][0]


def test_proof_admission_accepts_server_created_status():
    assert collector.proof_admission_accepted(201, {"admission": {"token": "one-time"}})
    assert not collector.proof_admission_accepted(200, {"admission": {}})


def test_viewer_bootstrap_clicks_start_after_admission_storage_is_seeded():
    calls = []

    class Button:
        def click(self):
            calls.append("click")

    class Page:
        def locator(self, selector):
            calls.append(selector)
            return Button()

    collector.start_viewer(Page())
    assert calls == ["#startBtn", "click"]
