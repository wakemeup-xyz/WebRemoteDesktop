import unittest

from scripts.wrd_watch_runtime import WatchRuntime


class WatchRuntimeTest(unittest.TestCase):
    def ready(self):
        runtime = WatchRuntime(clock_epoch="boot-a")
        runtime.tick(0, {"origin": True, "formal": False})
        runtime.tick(180, {"origin": True, "formal": False})
        self.assertTrue(runtime.begin_recovery("one", worker_pid=123, worker_start="start-a"))
        return runtime

    def test_cooldown_is_from_confirmed_completion(self):
        r = self.ready()
        self.assertEqual(r.tick(400, {"origin": True, "formal": False})["action"], "none")
        self.assertTrue(r.complete_recovery("one", 430, "failed", terminated=True))
        self.assertEqual(r.tick(498, {"origin": True, "formal": False})["action"], "none")
        self.assertEqual(r.tick(730, {"origin": True, "formal": False})["action"], "restart")

    def test_unconfirmed_timeout_blocks_indefinitely_but_sampling_continues(self):
        r = self.ready()
        self.assertFalse(r.complete_recovery("one", 430, "timeout"))
        r.tick(5000, {"origin": True, "formal": False})
        self.assertFalse(r.begin_recovery("two"))
        self.assertEqual(r.snapshot()["observations"]["formal"], False)
        self.assertEqual(r.snapshot()["operation"]["state"], "unknown")
        self.assertFalse(r.complete_recovery("old", 5000, "ok", terminated=True))

    def test_restart_and_pid_reuse_never_clear_inflight(self):
        r = self.ready()
        restarted = WatchRuntime(state=r.snapshot(), clock_epoch="boot-a")
        restarted.reconcile_worker(123, "different-start", alive=True)
        self.assertEqual(restarted.tick(5000, {"origin": True, "formal": False})["action"], "none")
        self.assertEqual(restarted.snapshot()["operation"]["state"], "unknown")

    def test_budget_clock_migration_waits_full_window_across_restarts(self):
        r = self.ready()
        r.complete_recovery("one", 200, "failed", terminated=True)
        r.tick(500, {"origin": True, "formal": False})
        self.assertTrue(r.begin_recovery("two"))
        r.complete_recovery("two", 510, "failed", terminated=True)
        migrated = WatchRuntime(state=r.snapshot(), clock_epoch="boot-b")
        self.assertEqual(migrated.tick(10, {"origin": True, "formal": False})["action"], "none")
        restarted = WatchRuntime(state=migrated.snapshot(), clock_epoch="boot-b")
        self.assertEqual(restarted.tick(310, {"origin": True, "formal": False})["action"], "none")
        self.assertEqual(restarted.tick(3609, {"origin": True, "formal": False})["action"], "none")
        self.assertEqual(restarted.tick(3610, {"origin": True, "formal": False})["action"], "restart")

    def test_unknown_or_assets_only_cannot_authorize_recovery(self):
        for observation in [{"origin": None, "formal": False}, {"origin": True, "formal": None},
                            {"origin": False, "formal": False}, {"origin": True, "formal": True, "assets": False}]:
            r = WatchRuntime(clock_epoch="a")
            r.tick(0, observation)
            self.assertEqual(r.tick(1000, observation)["action"], "none")


if __name__ == "__main__":
    unittest.main()
