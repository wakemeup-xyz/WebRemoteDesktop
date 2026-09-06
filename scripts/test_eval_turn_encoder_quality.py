import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("eval-turn-encoder-quality.py")
SPEC = importlib.util.spec_from_file_location("eval_turn_encoder_quality", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def passing_runtime():
    return {
        "status": "PASS",
        "gates": {gate: "PASS" for gate in MODULE.RUNTIME_GATES},
    }


class SelectRelayCandidateTest(unittest.TestCase):
    def test_later_runtime_validated_candidate_beats_first_offline_pending_candidate(self):
        """A pending offline choice must not mask a later runtime-proven choice."""
        result = MODULE.select_relay_candidate([
            {"id": "offline-first", "eligible": True, "offline": {"status": "PASS"}, "runtime": {"status": "PENDING", "gates": {}}},
            {"id": "validated-later", "eligible": True, "offline": {"status": "PASS"}, "runtime": passing_runtime()},
        ])

        self.assertEqual(result["state"], "validated")
        self.assertEqual(result["candidateId"], "validated-later")
        self.assertEqual(result["defaultPolicy"], "relay-balanced-v2")

    def test_first_offline_pass_is_retained_when_no_candidate_has_all_runtime_gates(self):
        """Without a runtime winner, selection remains a pending offline proposal."""
        result = MODULE.select_relay_candidate([
            {"id": "offline-first", "eligible": True, "offline": {"status": "PASS"}, "runtime": {"status": "PENDING", "gates": {}}},
            {"id": "offline-second", "eligible": True, "offline": {"status": "PASS"}, "runtime": {"status": "FAIL", "gates": {}}},
        ])

        self.assertEqual(result["state"], "runtime-validation-candidate")
        self.assertEqual(result["candidateId"], "offline-first")
        self.assertEqual(result["defaultPolicy"], "relay-legacy-v1")


def refinement_measurement(candidate, *, status="PASS", input_data=None, versions=None):
    """Build finite, dual-resolution offline evidence without encoding anything."""
    parameters = candidate["parameters"]
    runs = []
    for width, height in MODULE.RELAY_RESOLUTIONS:
        key = f"{width}x{height}"
        bitrate = parameters["bitrateBpsByResolution"][key]
        vbv_kbits = bitrate * parameters["vbvBufferMs"] // 1_000_000
        x264_params = (
            "keyint=1201:min-keyint=1201:scenecut=0:bframes=0:"
            "threads=1:sliced-threads=0:slices=1:sync-lookahead=0:"
            "rc-lookahead=0:repeat-headers=1:open-gop=0:intra-refresh=0:"
            f"forced-idr=1:vbv-maxrate={bitrate // 1000}:vbv-bufsize={vbv_kbits}:"
            "vbv-init=0.4:nal-hrd=none"
        )
        frames = []
        for index in range(65):
            frames.append(
                {
                    "index": index,
                    "bytes": 100,
                    "idr": index in {0, 5},
                    "psnr": 30.0,
                    "changeMAE": 0.0,
                    "encodeMs": 1.0,
                    "idrKind": "on-demand-probe" if index == 5 else "initial" if index == 0 else None,
                }
            )
        runs.append(
            {
                "resolution": [width, height],
                "encoder": {
                    "codec": parameters["codec"],
                    "preset": "ultrafast",
                    "tune": "zerolatency",
                    "profile": "Baseline",
                    "targetFps": 20,
                    "bitrateBps": bitrate,
                    "gopFrames": 0,
                    "vbvMs": parameters["vbvBufferMs"],
                    "x264Params": x264_params,
                },
                "frames": frames,
                "summary": {
                    "encodeMsMedian": 1.0,
                    "encodeMsP95": 1.0,
                    "idrFrames": [0, 5],
                    "idrChangeMAE": [0.0, 0.0],
                    "idrPsnr": [30.0, 30.0],
                    "onDemandIdrPsnr": [30.0],
                    "frameBytes": {"p": {"count": 63}, "idr": {"count": 2}},
                },
            }
        )
    return {
        "status": status,
        "input": {
            "randomSeed": 20260905,
            "frameRate": 20,
            "timeBase": "1/90000",
            "content": "fixed synthetic static text with one direct on-demand encoder request",
            "font": {"requested": "/System/Library/Fonts/Menlo.ttc", "resolved": "Menlo 15", "fallback": False},
        },
        "versions": {"pyav": "1", "aiortc": "2"},
        "runs": runs,
        "encodedSample": {"frameCount": 65, "purpose": "measure direct forced-IDR quality, encode time, and encoded-byte burst size"},
    }


class RelayVbvRefinementTest(unittest.TestCase):
    def setUp(self):
        self.baseline = MODULE.relay_vbv_refinement_baseline()
        self.candidates = MODULE.relay_vbv_refinement_candidates()
        self.measurements = {
            self.baseline["id"]: refinement_measurement(self.baseline, status="FAIL"),
            self.candidates[0]["id"]: refinement_measurement(self.candidates[0]),
            self.candidates[1]["id"]: refinement_measurement(self.candidates[1]),
        }
        self.measured_ids = []
        self.original_measure = getattr(MODULE, "_evaluate_offline_candidate", None)

        def fake_measure(_probe, candidate):
            self.measured_ids.append(candidate["id"])
            return self.measurements[candidate["id"]]

        MODULE._evaluate_offline_candidate = fake_measure
        self.addCleanup(setattr, MODULE, "_evaluate_offline_candidate", self.original_measure)

    def test_complete_baseline_that_fails_quality_does_not_block_passing_225_candidate(self):
        """The base is a measurement control, not a global quality prerequisite."""
        result = MODULE.evaluate_relay_vbv_refinement(object())

        self.assertEqual(self.measured_ids, [
            "on-demand-cap-bitrate-vbv200-baseline",
            "on-demand-cap-bitrate-vbv225",
        ])
        self.assertEqual(result["selection"]["state"], "runtime-validation-candidate")
        self.assertEqual(result["selection"]["candidateId"], "on-demand-cap-bitrate-vbv225")
        self.assertEqual(result["defaultPolicy"], "relay-legacy-v1")
        self.assertEqual(result["candidates"][0]["runtime"]["status"], "NOT RUN")

    def test_missing_baseline_measurement_blocks_candidate(self):
        """A candidate needs a complete fresh base before its one-variable result is usable."""
        self.measurements[self.baseline["id"]].pop("input")

        result = MODULE.evaluate_relay_vbv_refinement(object())

        self.assertEqual(result["selection"]["state"], "no-offline-winner")
        self.assertEqual(self.measured_ids, ["on-demand-cap-bitrate-vbv200-baseline"])
        self.assertEqual(result["candidates"], [])
        self.assertIn(
            "baseline measurement invalid: missing input",
            result["baseline"]["ineligibleReason"],
        )

    def test_parameter_drift_in_baseline_blocks_candidates(self):
        """Only the declared VBV value may differ across comparable measurements."""
        self.measurements[self.baseline["id"]]["runs"][0]["encoder"]["bitrateBps"] = 1

        result = MODULE.evaluate_relay_vbv_refinement(object())

        self.assertEqual(result["selection"]["state"], "no-offline-winner")
        self.assertEqual(self.measured_ids, ["on-demand-cap-bitrate-vbv200-baseline"])
        self.assertIn(
            "baseline measurement invalid: 1152x720 bitrateBps drift",
            result["baseline"]["ineligibleReason"],
        )

    def test_empty_input_or_version_metadata_stops_ladder(self):
        """A truthy object is insufficient; reproducibility fields must be populated."""
        for key in ("input", "versions"):
            with self.subTest(key=key):
                self.measurements[self.baseline["id"]][key] = {}

                result = MODULE.evaluate_relay_vbv_refinement(object())

                self.assertEqual(self.measured_ids, ["on-demand-cap-bitrate-vbv200-baseline"])
                self.assertIn(
                    f"baseline measurement invalid: incomplete {key}",
                    result["baseline"]["ineligibleReason"],
                )
                self.measured_ids.clear()
                self.measurements[self.baseline["id"]] = refinement_measurement(self.baseline, status="FAIL")

    def test_incomplete_baseline_frame_sequence_stops_ladder(self):
        """Both baseline runs must preserve the 65 unique probe-frame results."""
        self.measurements[self.baseline["id"]]["runs"][0]["frames"].pop()

        result = MODULE.evaluate_relay_vbv_refinement(object())

        self.assertEqual(self.measured_ids, ["on-demand-cap-bitrate-vbv200-baseline"])
        self.assertIn(
            "baseline measurement invalid: 1152x720 incomplete frame sequence",
            result["baseline"]["ineligibleReason"],
        )

    def test_matching_wrong_encoder_configuration_stops_ladder(self):
        """Matching controls cannot mask an experiment outside the frozen encoder setup."""
        for measurement in self.measurements.values():
            measurement["runs"][0]["encoder"].update(
                {"preset": "slow", "profile": "High", "targetFps": 60}
            )

        result = MODULE.evaluate_relay_vbv_refinement(object())

        self.assertEqual(self.measured_ids, ["on-demand-cap-bitrate-vbv200-baseline"])
        self.assertIn(
            "baseline measurement invalid: 1152x720 preset drift",
            result["baseline"]["ineligibleReason"],
        )

    def test_passing_225_short_circuits_250(self):
        """The bounded ladder stops at the first fully offline-passing candidate."""
        result = MODULE.evaluate_relay_vbv_refinement(object())

        self.assertEqual(len(result["candidates"]), 1)
        self.assertNotIn("on-demand-cap-bitrate-vbv250", self.measured_ids)

    def test_failing_225_measures_250_and_keeps_legacy_default(self):
        """A failed first rung permits exactly the capped 250-ms fallback measurement."""
        self.measurements[self.candidates[0]["id"]]["status"] = "FAIL"

        result = MODULE.evaluate_relay_vbv_refinement(object())

        self.assertEqual(self.measured_ids[-1], "on-demand-cap-bitrate-vbv250")
        self.assertEqual(result["selection"]["candidateId"], "on-demand-cap-bitrate-vbv250")
        self.assertEqual(result["selection"]["defaultPolicy"], "relay-legacy-v1")

    def test_invalid_225_comparability_stops_before_250(self):
        """Only a complete, comparable own-gate failure permits the final rung."""
        self.measurements[self.candidates[0]["id"]]["status"] = "FAIL"
        self.measurements[self.candidates[0]["id"]]["runs"][0]["encoder"]["preset"] = "slow"

        result = MODULE.evaluate_relay_vbv_refinement(object())

        self.assertEqual(self.measured_ids, [
            "on-demand-cap-bitrate-vbv200-baseline",
            "on-demand-cap-bitrate-vbv225",
        ])
        self.assertIn(
            "candidate measurement comparability failed: 1152x720 preset drift",
            result["candidates"][0]["ineligibleReason"],
        )

    def test_both_failed_rungs_preserve_no_offline_winner(self):
        """No partial result may be promoted when neither candidate clears its own gates."""
        self.measurements[self.candidates[0]["id"]]["status"] = "FAIL"
        self.measurements[self.candidates[1]["id"]]["status"] = "FAIL"

        result = MODULE.evaluate_relay_vbv_refinement(object())

        self.assertEqual(result["selection"]["state"], "no-offline-winner")
        self.assertEqual(result["selection"]["defaultPolicy"], "relay-legacy-v1")


if __name__ == "__main__":
    unittest.main()
