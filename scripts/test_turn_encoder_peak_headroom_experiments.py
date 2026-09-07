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

        self.assertEqual(
            MODULE.submitted_options(candidate, (1728, 1080))["x264-params"],
            "keyint=1201:min-keyint=1201:scenecut=0:bframes=0:"
            "threads=1:sliced-threads=0:slices=1:sync-lookahead=0:"
            "rc-lookahead=0:repeat-headers=1:open-gop=0:intra-refresh=0:"
            "forced-idr=1:vbv-maxrate=7200:vbv-bufsize=1300:"
            "vbv-init=1:nal-hrd=none",
        )


if __name__ == "__main__":
    unittest.main()
