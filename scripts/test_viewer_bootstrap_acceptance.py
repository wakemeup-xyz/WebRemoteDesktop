#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from viewer_bootstrap_acceptance import (  # noqa: E402
    build_report,
    classify_failure_stage,
    failure_sample,
    nearest_rank,
    write_immutable_report,
)


def test_nearest_rank_p95_and_report_redaction(tmp_path):
    samples = list(range(1, 21))
    assert nearest_rank(samples, 0.95) == 19
    report = build_report(
        origin="https://link.stockhub.wiki",
        samples=[
            {
                "finalState": "active",
                "failed": False,
                "htmlResponseMs": 100,
                "navToCoreInteractiveMs": 200,
                "clickToSignalMs": 300,
                "clickToStableNonBlackMs": 400,
                "coreInteractiveMarkMs": 50,
                "token": "must-not-appear",
            },
            failure_sample("boom", stage="signal-connected", cacheMode="cold"),
        ],
        mode="cold",
        runs=20,
    )
    text = json.dumps(report)
    assert "must-not-appear" not in text
    assert report["attemptCount"] == 2
    assert report["successCount"] == 1
    assert report["failureCount"] == 1
    assert report["failureStages"]["signal-connected"] == 1
    path, digest = write_immutable_report(report, tmp_path)
    assert path.exists()
    assert len(digest) == 64


def test_classify_failure_stage_and_no_retry_helper():
    assert classify_failure_stage("stable non-black canvas ratio too low") == "stable-non-black"
    assert classify_failure_stage("stable non-black exceeded 8s from start-click") == "stable-non-black"
    assert classify_failure_stage("missing required startup mark: html-shell") == "startup-marks"
    sample = failure_sample(AssertionError("x"), stage="core-interactive")
    assert sample["failed"] is True
    assert sample["finalState"] == "failed"


def test_stable_non_black_metric_must_not_use_active_proxy():
    """Document the contract: clickToStableNonBlackMs is start-click → stable-non-black."""
    marks = {
        "start-click": 100.0,
        "signal-connected": 400.0,
        "active": 900.0,
        "stable-non-black": 700.0,
    }
    click_to_active = marks["active"] - marks["start-click"]
    click_to_stable = marks["stable-non-black"] - marks["start-click"]
    assert click_to_stable == 600.0
    assert click_to_stable != click_to_active
    assert click_to_stable <= 8000
