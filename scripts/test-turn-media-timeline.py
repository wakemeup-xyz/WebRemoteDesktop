"""Contract test for the deterministic offline TURN encoder evidence probe."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EVALUATOR = ROOT / "scripts" / "eval-turn-encoder-quality.py"


class TurnEncoderQualityEvidenceTest(unittest.TestCase):
    def test_legacy_policy_reports_reproducible_idr_quality_pulse_evidence(self) -> None:
        """A policy/encoder change should fail this contract if baseline evidence drifts."""
        with tempfile.TemporaryDirectory() as temporary_directory:
            output = Path(temporary_directory) / "relay-legacy-v1.json"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(EVALUATOR),
                    "--policy",
                    "relay-legacy-v1",
                    "--output",
                    str(output),
                ],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            evidence = json.loads(output.read_text())

        self.assertEqual(evidence["policy"], "relay-legacy-v1")
        self.assertEqual(evidence["input"]["randomSeed"], 20260905)
        self.assertIn("font", evidence["input"])
        self.assertIn("machine", evidence)
        self.assertIn("pyav", evidence["versions"])
        self.assertIn("aiortc", evidence["versions"])

        runs = evidence["runs"]
        self.assertEqual({tuple(run["resolution"]) for run in runs}, {(1152, 720), (1728, 1080)})
        for run in runs:
            self.assertEqual(run["encoder"]["gopFrames"], 20)
            self.assertEqual(run["encoder"]["vbvMs"], 100)
            self.assertEqual(len(run["frames"]), 65)
            self.assertTrue(all({"index", "bytes", "idr", "psnr", "changeMAE", "encodeMs"} <= frame.keys() for frame in run["frames"]))

            periodic_idr_frames = [frame for frame in run["frames"] if frame["idr"] and frame["index"] > 0]
            self.assertEqual([frame["index"] for frame in periodic_idr_frames], [20, 40, 60])
            self.assertTrue(all(frame["changeMAE"] > 3.0 for frame in periodic_idr_frames))
            self.assertTrue(all(frame["psnr"] < 28.0 for frame in periodic_idr_frames))


if __name__ == "__main__":
    unittest.main()
