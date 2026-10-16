import tempfile
import subprocess
import unittest
from unittest.mock import patch
from pathlib import Path

from scripts.wrd_watch_coordinator import WatchCoordinator, RecoveryWorker, notify_status
from scripts.wrd_watch_runtime import WatchRuntime


class FakeWorker:
    pid = 123
    start_identity = "fixture-start"
    def __init__(self):
        self.finished, self.group_empty = False, False
    def completion(self):
        return {"terminated": self.finished and self.group_empty, "outcome": "failed"}


class CoordinatorTest(unittest.TestCase):
    def test_worker_parent_exit_does_not_prove_children_finished(self):
        class Process:
            def poll(self):
                return 0
        worker = RecoveryWorker.__new__(RecoveryWorker)
        worker.process, worker.pid = Process(), 123
        with patch('scripts.wrd_watch_coordinator.os.killpg', return_value=None):
            self.assertFalse(worker.completion()["terminated"])
        with patch('scripts.wrd_watch_coordinator.os.killpg', side_effect=PermissionError):
            self.assertFalse(worker.completion()["terminated"])
        with patch('scripts.wrd_watch_coordinator.os.killpg', side_effect=ProcessLookupError):
            self.assertTrue(worker.completion()["terminated"])

    def test_samples_continue_while_worker_or_children_remain_and_skip_missed_ticks(self):
        with tempfile.TemporaryDirectory() as d:
            clock, samples, workers = [0.0], [], []
            def sample():
                samples.append(clock[0])
                return {"origin": True, "formal": False}
            def start():
                worker = FakeWorker()
                workers.append(worker)
                return worker
            c = WatchCoordinator(runtime=WatchRuntime(clock_epoch="a"), state_path=Path(d)/"state.json",
                sample=sample, preflight=lambda: True, start_worker=start, now=lambda: clock[0], interval_s=60)
            c.step()
            clock[0] = 180
            c.step()
            self.assertEqual(len(workers), 1)
            self.assertEqual(c.runtime.snapshot()["lastTick"]["skippedTicks"], 2)
            clock[0] = 240
            c.step()
            workers[0].finished = True  # Parent exited but mutating child still exists.
            clock[0] = 500
            c.step()
            self.assertEqual(len(workers), 1)
            self.assertEqual(len(samples), 4)
            workers[0].group_empty = True
            c.step()
            self.assertEqual(c.runtime.snapshot()["cooldownUntil"], 800)
            self.assertEqual(c.runtime.snapshot()["operation"]["state"], "terminal")
            self.assertTrue((Path(d)/"state.json").is_file())

    def test_missing_worker_handle_after_restart_stays_unknown(self):
        with tempfile.TemporaryDirectory() as d:
            r = WatchRuntime(clock_epoch="a")
            r.tick(0, {"origin": True, "formal": False})
            r.tick(180, {"origin": True, "formal": False})
            r.begin_recovery("orphan", worker_pid=123, worker_start="old")
            c = WatchCoordinator(runtime=WatchRuntime(state=r.snapshot(), clock_epoch="a"), state_path=Path(d)/"s",
                sample=lambda: {"origin": True, "formal": False}, preflight=lambda: True,
                start_worker=lambda: self.fail("must not start second worker"), now=lambda: 5000)
            c.step()
            self.assertEqual(c.runtime.snapshot()["operation"]["state"], "unknown")

    def test_failed_preflight_consumes_no_recovery_budget(self):
        with tempfile.TemporaryDirectory() as d:
            r = WatchRuntime(clock_epoch="a")
            r.tick(0, {"origin": True, "formal": False})
            c = WatchCoordinator(runtime=r, state_path=Path(d)/"s", sample=lambda: {"origin": True, "formal": False},
                preflight=lambda: False, start_worker=lambda: self.fail("unsafe launch"), now=lambda: 180)
            c.step()
            self.assertEqual(c.runtime.snapshot()["recoveries"], [])

    def test_shutdown_cannot_launch_a_new_worker(self):
        with tempfile.TemporaryDirectory() as d:
            r = WatchRuntime(clock_epoch="a")
            r.tick(0, {"origin": True, "formal": False})
            c = WatchCoordinator(runtime=r, state_path=Path(d)/"s", sample=lambda: {"origin": True, "formal": False},
                preflight=lambda: self.fail("shutdown preflight"), start_worker=lambda: self.fail("shutdown launch"), now=lambda: 180)
            c.step(allow_recovery=False)
            self.assertEqual(c.runtime.snapshot()["recoveries"], [])

    def test_notification_timeout_reaps_only_owned_helper(self):
        class Notification:
            returncode = None
            killed = False
            def wait(self, timeout):
                if not self.killed:
                    raise subprocess.TimeoutExpired("fixture", timeout)
                self.returncode = -9
            def kill(self):
                self.killed = True
        process = Notification()
        self.assertEqual(notify_status("budget-exhausted", popen=lambda *a, **kw: process), "timeout")
        self.assertTrue(process.killed)


if __name__ == "__main__":
    unittest.main()
