"""Fail-closed orchestration tests for the peak-headroom prescreen."""

from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("eval-turn-encoder-quality.py")
SPEC = importlib.util.spec_from_file_location("eval_turn_encoder_quality_peak_headroom", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class PeakHeadroomMatrixCliTest(unittest.TestCase):
    def test_failed_prescreen_is_archived_without_running_the_full_matrix(self):
        candidate = types.SimpleNamespace(
            id="on-demand-peak-headroom-v1",
            options_digest="candidate-digest",
            to_dict=lambda: {"id": "on-demand-peak-headroom-v1", "encoderParameterDigest": "candidate-digest"},
        )
        experiment = types.ModuleType("turn_encoder_peak_headroom_experiments")
        experiment.build_peak_headroom_candidate = lambda: candidate
        experiment.submitted_options = lambda _config, resolution: {"resolution": str(resolution)}
        experiment.validate_prescreen = lambda _evidence: ["safety-net: quality failure"]
        experiment.validate_full_matrix = lambda _evidence: (_ for _ in ()).throw(AssertionError("full matrix must not validate"))
        previous = sys.modules.get("turn_encoder_peak_headroom_experiments")
        sys.modules["turn_encoder_peak_headroom_experiments"] = experiment
        self.addCleanup(
            lambda: sys.modules.__setitem__("turn_encoder_peak_headroom_experiments", previous)
            if previous is not None else sys.modules.pop("turn_encoder_peak_headroom_experiments", None)
        )
        calls = []

        class Probe:
            def evaluate_peak_headroom_prescreen(self, config):
                calls.append(("prescreen", config.id))
                return {"config": config.to_dict(), "input": {"fixed": True}, "runs": []}

            def evaluate_preset_scenario_matrix(self, _config):
                calls.append(("full", _config.id))
                raise AssertionError("must not run full matrix")

        result = MODULE.evaluate_peak_headroom_matrix(Probe())

        self.assertEqual(calls, [("prescreen", candidate.id)])
        self.assertEqual(result["status"], "NO_QUALIFIED_CANDIDATE")
        self.assertEqual(result["candidate"]["execution"]["fullMatrix"], "NOT RUN")
        self.assertEqual(result["defaultPolicy"], "relay-legacy-v1")


if __name__ == "__main__":
    unittest.main()
