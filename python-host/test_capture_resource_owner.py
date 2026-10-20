"""Pure ownership state tests with callbacks; no worker threads or native APIs."""
import json
from types import SimpleNamespace
import unittest

from capture_resource_owner import CaptureResourceOwner


class CaptureResourceOwnerTest(unittest.TestCase):
    def test_worker_claim_wins_fallback_and_duplicate_entry_or_close(self):
        calls = []
        resource = SimpleNamespace(close=lambda: calls.append('closed'))
        owner = CaptureResourceOwner(resource)
        self.assertEqual(owner.snapshot(), {'state': 'unclaimed'})
        self.assertIs(owner.claim_worker(), resource)
        self.assertEqual(owner.snapshot(), {'state': 'worker-owned'})
        self.assertIsNone(owner.claim_worker())
        self.assertFalse(owner.close_unclaimed())
        self.assertEqual(calls, [])
        owner.close_worker()
        owner.close_worker()
        self.assertFalse(owner.close_unclaimed())
        self.assertEqual(calls, ['closed'])
        self.assertEqual(owner.snapshot(), {'state': 'closed'})
        self.assertIsNone(owner._resource)

    def test_fallback_claim_blocks_late_worker_even_during_close(self):
        calls = []
        def close():
            calls.append(owner.snapshot())
            self.assertIsNone(owner.claim_worker())
            self.assertFalse(owner.close_unclaimed())
            owner.close_worker()
        owner = CaptureResourceOwner(SimpleNamespace(close=close))
        self.assertTrue(owner.close_unclaimed())
        self.assertEqual(calls, [{'state': 'closing'}])
        self.assertIsNone(owner.claim_worker())
        self.assertEqual(owner.snapshot(), {'state': 'closed'})

    def test_falsey_resource_is_claimed_and_closed(self):
        class Resource:
            calls = 0
            def __bool__(self):
                return False
            def close(self):
                self.calls += 1
        for fallback in (True, False):
            with self.subTest(fallback=fallback):
                resource = Resource()
                owner = CaptureResourceOwner(resource)
                if fallback:
                    self.assertTrue(owner.close_unclaimed())
                else:
                    self.assertIs(owner.claim_worker(), resource)
                    owner.close_worker()
                self.assertEqual(resource.calls, 1)
                self.assertEqual(owner.snapshot(), {'state': 'closed'})

    def test_close_error_is_fixed_and_fallback_result_means_claim_only(self):
        def fail():
            raise RuntimeError('native-secret-canary')
        for fallback in (True, False):
            with self.subTest(fallback=fallback):
                owner = CaptureResourceOwner(SimpleNamespace(close=fail))
                if fallback:
                    self.assertTrue(owner.close_unclaimed())
                else:
                    owner.claim_worker()
                    owner.close_worker()
                owner.close_worker()
                self.assertFalse(owner.close_unclaimed())
                self.assertEqual(owner.snapshot(), {'state': 'close-failed'})
                self.assertNotIn('canary', json.dumps(owner.snapshot()) + repr(owner.__dict__))

    def test_snapshot_is_fresh_immutable_publication_without_lock_or_native_work(self):
        class ForbiddenLock:
            def __enter__(self):
                raise AssertionError('snapshot acquired claim lock')
            def __exit__(self, *args):
                pass
        observed = []
        def close():
            owner._claim_lock = ForbiddenLock()
            result = owner.snapshot()
            self.assertEqual(result, {'state': 'closing'})
            result['state'] = 'mutated'
            observed.append(owner.snapshot())
        owner = CaptureResourceOwner(SimpleNamespace(close=close))
        owner.claim_worker()
        owner.close_worker()
        self.assertEqual(observed, [{'state': 'closing'}])
        self.assertEqual(owner.snapshot(), {'state': 'closed'})

    def test_worker_close_blocks_duplicate_fallback_during_native_close(self):
        calls = []
        def close():
            calls.append(1)
            self.assertFalse(owner.close_unclaimed())
            owner.close_worker()
            self.assertIsNone(owner.claim_worker())
        owner = CaptureResourceOwner(SimpleNamespace(close=close))
        owner.claim_worker()
        owner.close_worker()
        self.assertEqual(calls, [1])
        self.assertEqual(owner.snapshot(), {'state': 'closed'})


if __name__ == '__main__':
    unittest.main()
