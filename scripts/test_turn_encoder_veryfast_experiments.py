"""Contract tests for the one-candidate veryfast encoder matrix."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("turn_encoder_veryfast_experiments.py")
SPEC = importlib.util.spec_from_file_location("turn_encoder_veryfast_experiments", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class VeryfastExperimentContractTest(unittest.TestCase):
    def test_matrix_is_superfast_control_with_only_veryfast_candidate_preset_and_digest_changed(self):
        control, candidate = MODULE.build_veryfast_experiments()

        self.assertEqual(control.id, "on-demand-cap-vbv200-superfast")
        self.assertEqual(control.preset, "superfast")
        self.assertEqual(candidate.id, "on-demand-cap-vbv200-veryfast")
        self.assertEqual(candidate.preset, "veryfast")
        self.assertNotEqual(control.options_digest, candidate.options_digest)
        for field in (
            "codec", "profile", "fps", "bitrate_by_resolution", "vbv_ms",
            "periodic_idr_frames",
        ):
            self.assertEqual(getattr(control, field), getattr(candidate, field), field)
        options = MODULE.submitted_options(candidate, (1728, 1080))
        self.assertEqual(options["preset"], "veryfast")
        self.assertEqual(
            options["x264-params"],
            "keyint=1201:min-keyint=1201:scenecut=0:bframes=0:"
            "threads=1:sliced-threads=0:slices=1:sync-lookahead=0:"
            "rc-lookahead=0:repeat-headers=1:open-gop=0:intra-refresh=0:"
            "forced-idr=1:vbv-maxrate=5000:vbv-bufsize=1000:"
            "vbv-init=0.4:nal-hrd=none",
        )


if __name__ == "__main__":
    unittest.main()
