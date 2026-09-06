import importlib.util
from pathlib import Path

import pytest


SCRIPT = Path(__file__).with_name("turn_runtime_collector.py")
SPEC = importlib.util.spec_from_file_location("turn_runtime_collector", SCRIPT)
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


def test_collector_defaults_to_required_720p_and_explicit_1080p_durations():
    args = collector.parse_args([])
    assert args.phase == "both"
    assert args.output is None
    assert args.duration_seconds is None
    assert collector.phase_duration_seconds("720p", args.duration_seconds) == 600
    assert collector.phase_duration_seconds("1080p", args.duration_seconds) == 300
    with pytest.raises(SystemExit):
        collector.parse_args(["--phase", "4k"])


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


def test_phase_summary_rejects_later_disconnected_or_non_relay_sample():
    summary = collector.summarize_phase("720p", [
        {"elapsedMs": 0, "cadenceLateMs": 0, "selectedPair": {"type": "relay"}, "pcConnectionState": "connected", "socketConnected": True, "resolution": {"height": 720}, "decodedDelta": 20, "derivedFps": 20, "paintGapMs": 50, "jitterBufferMs": 20},
        {"elapsedMs": 1000, "cadenceLateMs": 0, "selectedPair": {"type": "host"}, "pcConnectionState": "disconnected", "socketConnected": True, "resolution": {"height": 720}, "decodedDelta": 0, "derivedFps": 0, "paintGapMs": 1200, "jitterBufferMs": 20},
    ], duration_seconds=1)
    assert summary["ok"] is False
    assert sorted(summary["failures"]) == ["fps-p50", "non-relay-sample", "pc-not-connected", "post-warmup-paint-gap"]


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
    assert {"socket-not-connected", "resolution-class", "missing-paint-gap"}.issubset(summary["failures"])


def test_boundary_warmup_sample_may_lack_paint_but_later_samples_must_have_it():
    samples = [{"elapsedMs": index * 1000, "cadenceLateMs": 0, "selectedPair": {"type": "relay"}, "pcConnectionState": "connected", "socketConnected": True,
                "resolution": {"width": 1280, "height": 720}, "derivedFps": 20, "paintGapMs": None if index == 0 else 20, "jitterBufferMs": 20}
               for index in range(3)]
    assert "missing-paint-gap" not in collector.summarize_phase("720p", samples, duration_seconds=2)["failures"]
    samples[2]["paintGapMs"] = None
    assert "missing-paint-gap" in collector.summarize_phase("720p", samples, duration_seconds=2)["failures"]


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
