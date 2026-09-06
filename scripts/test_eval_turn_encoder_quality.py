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


if __name__ == "__main__":
    unittest.main()
