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
    assert len(samples) == 3
    assert [sample["sampleIndex"] for sample in samples] == [0, 1, 2]
    assert [sample["elapsedMs"] for sample in samples] == [0, 1000, 2000]


def test_phase_summary_rejects_later_disconnected_or_non_relay_sample():
    summary = collector.summarize_phase("720p", [
        {"selectedPair": {"type": "relay"}, "pcConnectionState": "connected", "decodedDelta": 20, "derivedFps": 20, "paintGapMs": 50, "jitterBufferMs": 20},
        {"selectedPair": {"type": "host"}, "pcConnectionState": "disconnected", "decodedDelta": 0, "derivedFps": 0, "paintGapMs": 1200, "jitterBufferMs": 20},
    ])
    assert summary["ok"] is False
    assert sorted(summary["failures"]) == ["fps-p50", "non-relay-sample", "pc-not-connected", "post-warmup-paint-gap"]


def test_runtime_sample_redacts_candidate_addresses_and_credentials():
    sample = collector.redact_runtime_sample({
        "selectedPair": {"type": "relay", "protocol": "udp", "localAddress": "10.0.0.2:5000", "remoteAddress": "203.0.113.7:3478"},
        "turnUsername": "secret-user",
        "turnCredential": "secret-password",
    })
    assert sample == {"selectedPair": {"type": "relay", "protocol": "udp"}}


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
