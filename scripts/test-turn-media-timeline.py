"""Contract test for offline TURN encoder-quality evidence, not RTP timeline.

The filename is retained as the Task 0 plan entry point. RTP timeline assertions
belong to Task 1, when the timeline implementation exists.
"""

from __future__ import annotations

import json
import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EVALUATOR = ROOT / "scripts" / "eval-turn-encoder-quality.py"


def _load_evaluator_module():
    spec = importlib.util.spec_from_file_location("turn_encoder_evaluator", EVALUATOR)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load evaluator from {EVALUATOR}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TurnEncoderQualityEvidenceTest(unittest.TestCase):
    def test_relay_selection_has_explicit_offline_runtime_and_validated_states(self) -> None:
        """Only real runtime gates may promote an offline winner to the default."""
        evaluator = _load_evaluator_module()

        no_winner = evaluator.select_relay_candidate(
            [
                {
                    "id": "fails-quality",
                    "offline": {"status": "FAIL"},
                    "runtime": {"status": "NOT RUN", "gates": {}},
                }
            ]
        )
        runtime_candidate = evaluator.select_relay_candidate(
            [
                {
                    "id": "fails-quality",
                    "offline": {"status": "FAIL"},
                    "runtime": {"status": "NOT RUN", "gates": {}},
                },
                {
                    "id": "blocked-offline-winner",
                    "offline": {"status": "PASS"},
                    "runtime": {"status": "NOT RUN", "gates": {}},
                    "eligible": False,
                    "dependencies": ["control-gop-2s"],
                    "ineligibleReason": ["control-gop-2s failed offline gates"],
                },
                {
                    "id": "eligible-offline-winner",
                    "offline": {"status": "PASS"},
                    "runtime": {"status": "NOT RUN", "gates": {}},
                    "eligible": True,
                    "dependencies": ["control-vbv-150"],
                    "ineligibleReason": [],
                },
            ]
        )
        validated = evaluator.select_relay_candidate(
            [
                {
                    "id": "runtime-validated-winner",
                    "offline": {"status": "PASS"},
                    "eligible": True,
                    "dependencies": [],
                    "ineligibleReason": [],
                    "runtime": {
                        "status": "PASS",
                        "gates": {
                            "viewerBufferAndDecodeContinuity": "PASS",
                            "hostEventLoopAndInputAck": "PASS",
                            "finiteLossRecovery": "PASS",
                        },
                    },
                }
            ]
        )

        self.assertEqual(no_winner["state"], "no-offline-winner")
        self.assertEqual(no_winner["candidateId"], None)
        self.assertEqual(no_winner["defaultPolicy"], "relay-legacy-v1")
        self.assertEqual(runtime_candidate["state"], "runtime-validation-candidate")
        self.assertEqual(runtime_candidate["candidateId"], "eligible-offline-winner")
        self.assertEqual(runtime_candidate["defaultPolicy"], "relay-legacy-v1")
        self.assertEqual(runtime_candidate["runtimeGateStatus"], "PENDING")
        self.assertEqual(validated["state"], "validated")
        self.assertEqual(validated["candidateId"], "runtime-validated-winner")
        self.assertEqual(validated["defaultPolicy"], "relay-balanced-v2")

    def test_relay_matrix_records_two_resolution_offline_gates_without_faking_runtime_proof(self) -> None:
        """Matrix evidence must preserve the boundary between offline and relay proof."""
        with tempfile.TemporaryDirectory() as temporary_directory:
            output = Path(temporary_directory) / "relay-matrix.json"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(EVALUATOR),
                    "--matrix",
                    "relay",
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

        self.assertEqual(evidence["kind"], "relay-encoder-quality-matrix")
        self.assertEqual(evidence["defaultPolicy"], "relay-legacy-v1")
        self.assertTrue(evidence["controls"])
        self.assertGreaterEqual(len(evidence["candidates"]), 1)
        self.assertIn(evidence["selection"]["state"], {
            "no-offline-winner",
            "runtime-validation-candidate",
        })

        for candidate in evidence["candidates"]:
            self.assertTrue(
                {
                    "id",
                    "parameters",
                    "offline",
                    "runtime",
                    "eligible",
                    "dependencies",
                    "ineligibleReason",
                }
                <= candidate.keys()
            )
            self.assertEqual(candidate["runtime"]["status"], "NOT RUN")
            self.assertEqual(
                candidate["runtime"]["gates"],
                {
                    "viewerBufferAndDecodeContinuity": "NOT RUN",
                    "hostEventLoopAndInputAck": "NOT RUN",
                    "finiteLossRecovery": "NOT RUN",
                },
            )
            self.assertIn(candidate["offline"]["status"], {"PASS", "FAIL"})
            resolution_gates = candidate["offline"]["resolutionGates"]
            self.assertEqual(set(resolution_gates), {"1152x720", "1728x1080"})
            for gates in resolution_gates.values():
                self.assertTrue(
                    {
                        "qualityPulse",
                        "periodicIdrQuality",
                        "onDemandIdrPsnr",
                        "encodeBudget",
                    }
                    <= gates.keys()
                )
                self.assertTrue(
                    {"p", "idr", "idrToPAvgBurstRatio"}
                    <= candidate["offline"]["runs"][0]["summary"]["frameBytes"].keys()
                )

        on_demand = next(
            candidate
            for candidate in evidence["candidates"]
            if candidate["parameters"]["periodicIdrFrames"] is None
        )
        self.assertEqual(on_demand["offline"]["logicalHealthWindow"]["seconds"], 60)
        self.assertEqual(
            on_demand["offline"]["logicalHealthWindow"]["applicationPeriodicIdrFrames"],
            [],
        )
        self.assertEqual(on_demand["offline"]["encodedSample"]["frameCount"], 65)

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

        self.assertTrue(
            {
                "policy",
                "scope",
                "input",
                "versions",
                "machine",
                "runs",
            }
            <= evidence.keys()
        )
        self.assertEqual(evidence["policy"], "relay-legacy-v1")
        self.assertTrue(
            {"randomSeed", "frameCount", "frameRate", "timeBase", "content", "font"}
            <= evidence["input"].keys()
        )
        self.assertEqual(evidence["input"]["randomSeed"], 20260905)
        self.assertEqual(evidence["input"]["frameCount"], 65)
        self.assertEqual(evidence["input"]["frameRate"], 20)
        self.assertEqual(evidence["input"]["timeBase"], "1/90000")
        self.assertTrue({"requested", "resolved", "fallback"} <= evidence["input"]["font"].keys())
        self.assertTrue({"pyav", "aiortc"} <= evidence["versions"].keys())
        self.assertTrue({"platform", "machine", "python", "cpuCount"} <= evidence["machine"].keys())

        runs = evidence["runs"]
        self.assertEqual({tuple(run["resolution"]) for run in runs}, {(1152, 720), (1728, 1080)})
        for run in runs:
            self.assertTrue({"resolution", "encoder", "frames", "summary"} <= run.keys())
            self.assertEqual(len(run["resolution"]), 2)
            self.assertTrue(all(isinstance(value, int) and value > 0 for value in run["resolution"]))

            encoder = run["encoder"]
            self.assertTrue(
                {"codec", "bitrateBps", "gopFrames", "vbvKbits", "vbvMs", "x264Params"}
                <= encoder.keys()
            )
            self.assertEqual(encoder["codec"], "libx264")
            self.assertEqual(encoder["gopFrames"], 20)
            self.assertEqual(encoder["vbvMs"], 100)
            self.assertIsInstance(encoder["bitrateBps"], int)
            self.assertGreater(encoder["bitrateBps"], 0)
            self.assertIsInstance(encoder["vbvKbits"], int)
            self.assertGreater(encoder["vbvKbits"], 0)
            self.assertIn("vbv-bufsize=", encoder["x264Params"])

            self.assertEqual(len(run["frames"]), 65)
            for index, frame in enumerate(run["frames"]):
                self.assertTrue(
                    {"index", "bytes", "idr", "psnr", "changeMAE", "encodeMs"}
                    <= frame.keys()
                )
                self.assertEqual(frame["index"], index)
                self.assertIsInstance(frame["bytes"], int)
                self.assertGreater(frame["bytes"], 0)
                self.assertIsInstance(frame["idr"], bool)
                self.assertIsInstance(frame["psnr"], (int, float))
                self.assertGreater(frame["psnr"], 0)
                self.assertIsInstance(frame["changeMAE"], (int, float))
                self.assertGreaterEqual(frame["changeMAE"], 0)
                self.assertIsInstance(frame["encodeMs"], (int, float))
                self.assertGreater(frame["encodeMs"], 0)

            periodic_idr_frames = [frame for frame in run["frames"] if frame["idr"] and frame["index"] > 0]
            self.assertEqual([frame["index"] for frame in periodic_idr_frames], [20, 40, 60])
            self.assertTrue(all(frame["changeMAE"] > 3.0 for frame in periodic_idr_frames))
            self.assertTrue(all(frame["psnr"] < 28.0 for frame in periodic_idr_frames))

            summary = run["summary"]
            self.assertTrue(
                {"encodeMsMedian", "encodeMsP95", "idrFrames", "idrChangeMAE", "idrPsnr"}
                <= summary.keys()
            )
            self.assertIsInstance(summary["encodeMsMedian"], (int, float))
            self.assertIsInstance(summary["encodeMsP95"], (int, float))
            self.assertGreater(summary["encodeMsMedian"], 0)
            self.assertGreaterEqual(summary["encodeMsP95"], summary["encodeMsMedian"])
            self.assertEqual(summary["idrFrames"], [0, 20, 40, 60])
            self.assertEqual(len(summary["idrChangeMAE"]), len(summary["idrFrames"]))
            self.assertEqual(len(summary["idrPsnr"]), len(summary["idrFrames"]))


if __name__ == "__main__":
    unittest.main()
