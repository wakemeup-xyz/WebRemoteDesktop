"""Synthetic phase-gate counterexample; no browser, service, or media run."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[5]
source = root / "scripts/test_turn_runtime_collector.py"
spec = importlib.util.spec_from_file_location("collector_test_helpers", source)
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
pattern = [50] * 17 + [150]
samples = [helpers.paint_sample(i, age=0, maximum=max(pattern), interval=max(pattern)) for i in range(601)]
for sample in samples:
    sample.update(derivedFps=1000 * len(pattern) / sum(pattern), jitterBufferMs=50)
print(json.dumps({
    "kind": "synthetic acceptance counterexample, not a live Viewer run",
    "sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
    "sourceSha256": {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
                     for path in (source, root / "scripts/turn_runtime_collector.py")},
    "frameGapPatternMs": pattern,
    "patternDurationMs": sum(pattern), "repeatCount": 600,
    "summary": helpers.collector.summarize_phase("720p", samples),
    "boundary": "Only current numeric phase gates tested; scene/input/loss gates are not fabricated or exercised.",
}, indent=2))
