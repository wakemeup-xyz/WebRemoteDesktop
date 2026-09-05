#!/usr/bin/env python3
"""Run the deterministic offline relay encoder baseline from repository root."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROBE_PATH = ROOT / "docs/superpowers/reports/evidence/2026-09-05-turn-quality/encoder_probe.py"


def load_probe_module():
    spec = importlib.util.spec_from_file_location("turn_encoder_probe", PROBE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load probe from {PROBE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", required=True, choices=("relay-legacy-v1",))
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    probe = load_probe_module()
    evidence = probe.evaluate_legacy_policy()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
