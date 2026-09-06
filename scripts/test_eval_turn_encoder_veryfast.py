"""CLI-evaluator tests for the independent veryfast matrix."""

from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("eval-turn-encoder-quality.py")
SPEC = importlib.util.spec_from_file_location("eval_turn_encoder_quality_veryfast", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class VeryfastMatrixCliTest(unittest.TestCase):
    def test_evaluator_uses_superfast_control_then_only_veryfast_candidate(self):
        control = types.SimpleNamespace(
            id="on-demand-cap-vbv200-superfast",
            options_digest="control-digest",
            to_dict=lambda: {"id": "on-demand-cap-vbv200-superfast", "encoderParameterDigest": "control-digest"},
        )
        candidate = types.SimpleNamespace(
            id="on-demand-cap-vbv200-veryfast",
            options_digest="candidate-digest",
            to_dict=lambda: {"id": "on-demand-cap-vbv200-veryfast", "encoderParameterDigest": "candidate-digest"},
        )
        experiment = types.ModuleType("turn_encoder_veryfast_experiments")
        experiment.build_veryfast_experiments = lambda: (control, candidate)
        experiment.submitted_options = lambda _config, resolution: {"preset": _config.id.rsplit("-", 1)[1], "resolution": str(resolution)}
        experiment.validate_control_integrity = lambda _base: []
        experiment.validate_comparison = lambda _base, _candidate: ["candidate: forced test failure"]
        previous = sys.modules.get("turn_encoder_veryfast_experiments")
        sys.modules["turn_encoder_veryfast_experiments"] = experiment
        self.addCleanup(
            lambda: sys.modules.__setitem__("turn_encoder_veryfast_experiments", previous)
            if previous is not None else sys.modules.pop("turn_encoder_veryfast_experiments", None)
        )

        calls = []

        class Probe:
            def evaluate_preset_scenario_matrix(self, config):
                calls.append(config.id)
                return {"config": config.to_dict(), "input": {"fixed": True}, "runs": []}

        result = MODULE.evaluate_veryfast_matrix(Probe())

        self.assertEqual(calls, [control.id, candidate.id])
        self.assertEqual(result["kind"], "relay-veryfast-refinement")
        self.assertEqual(result["candidates"][0]["id"], candidate.id)
        self.assertEqual(result["candidates"][0]["offline"]["status"], "FAIL")
        self.assertEqual(result["defaultPolicy"], "relay-legacy-v1")


if __name__ == "__main__":
    unittest.main()
