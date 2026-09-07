#!/usr/bin/env python3
"""Concrete owner CLI for the disposable T6 lifecycle.

It intentionally stops before Compose when the live Lab/desktop precondition is
absent; it never substitutes synthetic media for the loss transaction.
"""
from __future__ import annotations
import argparse, json
from pathlib import Path

from controller import DockerRuntimeProbe, LossFixtureManifest, RuntimeBlocked

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--dedicated-desktop", action="store_true")
    args = parser.parse_args()
    manifest = LossFixtureManifest.parse(json.loads(args.manifest.read_text()))
    status = DockerRuntimeProbe().status()
    if status["status"] != "READY" or not args.dedicated_desktop:
        print(json.dumps({"status":"BLOCKED", "execution":"NOT_RUN", "reason":"dedicated live Lab desktop is required", "runId":manifest.run_id}))
        return 2
    # The live owner follows this concrete command path after its T3/T5 taps
    # are armed: prepare -> authority -> compose -> control -> clear -> seal.
    print(json.dumps({"status":"BLOCKED", "execution":"NOT_RUN", "reason":"live owner must arm T3/T5 taps before isolated loss", "runId":manifest.run_id}))
    return 2
if __name__ == "__main__": raise SystemExit(main())
