import importlib.util
from pathlib import Path

import numpy as np


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "benchmark-turn-capture.py"
SPEC = importlib.util.spec_from_file_location("benchmark_turn_capture", SCRIPT_PATH)
benchmark = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(benchmark)


class FakeShot:
    width = 64
    height = 48
    raw = np.zeros((height, width, 4), dtype=np.uint8).tobytes()


class FakeMSS:
    def grab(self, _monitor):
        return FakeShot()


def test_offline_candidate_cannot_change_the_legacy_production_multiplier():
    decision = benchmark.select_multiplier(
        [{"multiplier": 1.0, "targetFrameAvailable": True, "costPerTargetFrameMs": 1.0}],
        {"costPerTargetFrameMs": 2.0},
    )

    assert decision["applied"] is False
    assert decision["value"] == 2.0
    assert decision["runtimePaintGate"] == "PENDING"
    assert decision["offlineEligibleMultipliers"] == [1.0]


def test_consumer_processes_only_fresh_latest_frames_and_reports_overwrites():
    result = benchmark.run_capture_candidate(
        FakeMSS(),
        {"left": 0, "top": 0, "width": 64, "height": 48},
        target_fps=20,
        multiplier=2.0,
        duration_seconds=0.12,
        size=(32, 24),
        producer_phase_seconds=0.01,
        consumer_phase_seconds=0.0,
        producer_jitter_seconds=(0.0, 0.002),
        slow_grab_seconds=0.0,
    )

    assert result["freshConsumed"] >= 1
    assert result["initialBlank"] >= 1
    assert result["overwrittenDropped"] >= 1
    assert result["produced"] == (
        result["consumed"] + result["overwrittenDropped"] + result["unconsumedAtStop"]
    )
    assert result["consumerTicks"] == (
        result["freshConsumed"] + result["reused"] + result["initialBlank"]
    )
    assert result["consumerProcessingCalls"] == result["freshConsumed"]
    assert result["producerInterArrival"]["count"] == result["produced"] - 1
    assert result["consumerInterArrival"]["count"] == result["consumerTicks"] - 1


def test_consumer_cost_model_counts_reuse_copy_and_every_recv_conversion():
    result = benchmark.run_capture_candidate(
        FakeMSS(),
        {"left": 0, "top": 0, "width": 64, "height": 48},
        target_fps=20,
        multiplier=1.0,
        duration_seconds=0.16,
        size=(32, 24),
        producer_phase_seconds=0.01,
        producer_jitter_seconds=(0.0, 0.04),
        slow_grab_seconds=0.03,
    )

    assert "pathCosts" in result
    assert result["pathCosts"]["fresh"]["fromNdarray"]["count"] == result["freshConsumed"]
    assert result["pathCosts"]["reused"]["copy"]["count"] == result["reused"]
    assert result["pathCosts"]["initialBlank"]["fromNdarray"]["count"] == result["initialBlank"]
    assert result["costModel"]["frameConversionCalls"] == result["consumerTicks"]
    assert result["reused"] >= 1
    assert result["produced"] == (
        result["consumed"] + result["overwrittenDropped"] + result["unconsumedAtStop"]
    )


def test_scheduler_matrix_varies_consumer_phase_jitter_and_delay_independently():
    scenarios = benchmark.scheduler_scenarios(40)

    assert any("consumer_delay_seconds" in row for row in scenarios)
    assert any("consumer_jitter_seconds" in row for row in scenarios)
    assert any(row["producer_jitter_seconds"] != (0.0,) for row in scenarios)
    assert any(row["slow_grab_seconds"] > 0 for row in scenarios)
