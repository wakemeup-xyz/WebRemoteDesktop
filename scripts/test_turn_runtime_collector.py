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
