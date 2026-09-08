"""Contract tests for the sole offline peak-headroom candidate."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("turn_encoder_peak_headroom_experiments.py")
SPEC = importlib.util.spec_from_file_location("turn_encoder_peak_headroom_experiments", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class PeakHeadroomExperimentContractTest(unittest.TestCase):
    def test_only_candidate_freezes_independent_average_maxrate_buffer_and_init(self):
        candidate = MODULE.build_peak_headroom_candidate()

        self.assertEqual(candidate.id, "on-demand-peak-headroom-v1")
        self.assertEqual(candidate.preset, "superfast")
        self.assertEqual(candidate.codec, "libx264")
        self.assertEqual(candidate.profile, "Baseline")
        self.assertEqual(candidate.fps, 20)
        self.assertEqual(candidate.periodic_idr_frames, 0)
        self.assertEqual(candidate.bitrate_by_resolution, {"1152x720": 3_200_000, "1728x1080": 5_000_000})
        self.assertEqual(candidate.vbv_maxrate_by_resolution, {"1152x720": 4_800_000, "1728x1080": 7_200_000})
        self.assertEqual(candidate.vbv_bufsize_kbits_by_resolution, {"1152x720": 1_000, "1728x1080": 1_300})
        self.assertEqual(candidate.vbv_init, 1.0)
        self.assertEqual(candidate.slice_threads, 1)

        options = MODULE.submitted_options(candidate, (1728, 1080))
        self.assertEqual(options["forced-idr"], "1")
        self.assertEqual(
            options["x264-params"],
            "keyint=1201:min-keyint=1201:scenecut=0:bframes=0:"
            "threads=1:sliced-threads=0:slices=1:sync-lookahead=0:"
            "rc-lookahead=0:repeat-headers=1:open-gop=0:intra-refresh=0:"
            "vbv-maxrate=7200:vbv-bufsize=1300:"
            "vbv-init=1:nal-hrd=none",
        )

    def test_sliced2_candidate_is_versioned_and_changes_only_the_thread_contract(self):
        candidate = MODULE.build_peak_headroom_candidate()
        sliced2 = MODULE.build_peak_headroom_sliced2_candidate()

        self.assertEqual(sliced2.id, "on-demand-peak-headroom-sliced2-v1")
        self.assertEqual(sliced2.slice_threads, 2)
        self.assertEqual(sliced2.to_dict()["sliceThreads"], 2)
        self.assertNotEqual(sliced2.options_digest, candidate.options_digest)
        self.assertEqual(
            MODULE.submitted_options(sliced2, (1728, 1080))["x264-params"],
            "keyint=1201:min-keyint=1201:scenecut=0:bframes=0:"
            "threads=2:sliced-threads=1:slices=2:sync-lookahead=0:"
            "rc-lookahead=0:repeat-headers=1:open-gop=0:intra-refresh=0:"
            "vbv-maxrate=7200:vbv-bufsize=1300:"
            "vbv-init=1:nal-hrd=none",
        )

    def test_rolling_on_demand_mae_is_not_a_quality_gate_but_safety_net_mae_is(self):
        candidate = MODULE.build_peak_headroom_candidate()
        resolution = (1152, 720)

        def scenario(scenario_id, start, count, requests=(), safety=False):
            frames = []
            for phase_index in range(count):
                index = start + phase_index
                kind = "initial" if index == start and scenario_id != "post-scroll-static" else None
                if index in requests:
                    kind = "on-demand"
                if safety and index == 1201:
                    kind = "encoder-safety-net"
                frames.append({
                    "index": index, "phaseIndex": phase_index, "inputHash": f"h-{index}",
                    "pts": index * 4500, "timeBase": "1/90000", "idr": kind is not None,
                    "bitstreamIdrKind": kind, "idrKind": kind,
                    "requestToken": f"{scenario_id}:{index}" if index in requests else None,
                    "bytes": 100, "idrBytes": 100 if kind else 0, "psnr": 30.0,
                    "changeMAE": 0.0, "encodeMs": 1.0, "decodeMs": 1.0,
                })
            key = "1152x720"
            return {
                "scenarioId": scenario_id, "frames": frames,
                "requestTokens": [f"{scenario_id}:{index}" for index in requests],
                "configuredOptions": MODULE.submitted_options(candidate, resolution),
                "cost": {"encodeMsP95": 1.0},
                "burst": {"idrBytes": [100 for frame in frames if frame["idr"]]},
                "codecCreationRecords": [{
                    "creationIndex": 1, "reopenReason": "initial", "requestedPreset": candidate.preset,
                    "submittedCodecOptions": MODULE.submitted_options(candidate, resolution),
                    "configuredBitrateBps": candidate.bitrate_by_resolution[key],
                    "configuredAverageBitrateBps": candidate.bitrate_by_resolution[key],
                    "submittedVbvMaxrateKbps": "4800", "submittedVbvBufsizeKbits": "1000",
                    "submittedVbvInit": "1",
                }],
            }

        rolling = scenario("scrolling-text", 0, 300, (5, 200))
        rolling["frames"][5]["changeMAE"] = 99.0
        rolling["frames"][200]["changeMAE"] = 99.0
        errors = MODULE._scenario_errors(
            rolling, expected=("scrolling-text", 0, 300, (5, 200)), config=candidate,
            resolution=resolution, require_initial_quality=False,
        )
        self.assertFalse(any("quality failure" in error for error in errors), errors)

        safety = scenario("safety-net", 0, 1226, safety=True)
        safety["frames"][1201]["changeMAE"] = 3.1
        errors = MODULE._scenario_errors(
            safety, expected=("safety-net", 0, 1226, ()), config=candidate,
            resolution=resolution, require_initial_quality=True,
        )
        self.assertTrue(any("quality failure" in error for error in errors), errors)


if __name__ == "__main__":
    unittest.main()
