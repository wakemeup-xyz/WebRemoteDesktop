import sys
import unittest

from scripts.wrd_deadline import Deadline, run_owned_probe, wait_formal_health


class DeadlineTest(unittest.TestCase):
    def test_health_wait_cannot_spend_more_than_total_budget(self):
        clock, budgets = [0.0], []
        def probe(remaining_s):
            budgets.append(remaining_s)
            clock[0] += min(10.0, remaining_s)
            return {"outcome": "failed"}
        def info(remaining_s):
            clock[0] += min(10.0, remaining_s)
        result = wait_formal_health(timeout_s=45, probe=probe, info=info,
            now=lambda: clock[0], sleep=lambda s: clock.__setitem__(0, clock[0] + s))
        self.assertLessEqual(clock[0], 45)
        self.assertEqual(result["outcome"], "timeout")
        self.assertTrue(all(0 < b <= 45 for b in budgets))

    def test_late_success_cannot_be_accepted(self):
        clock = [0.0]
        def probe(remaining_s):
            clock[0] = 46
            return {"outcome": "ok"}
        result = wait_formal_health(timeout_s=45, probe=probe, info=lambda **kw: None,
                                   now=lambda: clock[0], sleep=lambda s: None)
        self.assertEqual(result["outcome"], "timeout")
        self.assertEqual(result["attempts"], 1)

    def test_probe_output_is_bounded_and_owned_process_reaped(self):
        result = run_owned_probe([sys.executable, "-c", "import sys; sys.stdout.write('x'*70000)"],
                                 deadline=Deadline(5), allowed_executables={sys.executable})
        self.assertEqual(result["outcome"], "output-limit")
        self.assertLessEqual(len(result["stdout"]) + len(result["stderr"]), 65536)
        self.assertTrue(result["reaped"])

    def test_probe_timeout_and_command_allowlist(self):
        result = run_owned_probe([sys.executable, "-c", "import time; time.sleep(5)"],
                                 deadline=Deadline(0.05), allowed_executables={sys.executable})
        self.assertEqual(result["outcome"], "timeout")
        self.assertTrue(result["reaped"])
        with self.assertRaises(ValueError):
            run_owned_probe(["unexpected"], deadline=Deadline(1), allowed_executables={sys.executable})


if __name__ == "__main__":
    unittest.main()
