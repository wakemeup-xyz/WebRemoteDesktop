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
    nearest_rank,
    write_immutable_report,
)


def test_nearest_rank_p95_and_report_redaction(tmp_path):
    samples = list(range(1, 21))
    assert nearest_rank(samples, 0.95) == 19
    report = build_report(
        origin="https://link.stockhub.wiki",
        samples=[{"coreInteractiveMs": 1000, "token": "must-not-appear"}],
    )
    text = json.dumps(report)
    assert "must-not-appear" not in text
    path, digest = write_immutable_report(report, tmp_path)
    assert path.exists()
    assert len(digest) == 64
