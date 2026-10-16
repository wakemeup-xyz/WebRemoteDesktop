import asyncio
import unittest
from input_admission_queue import InputAdmissionQueue


class AdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def test_overflow_freezes_and_waits_for_native_completion(self):
        entered, release = asyncio.Event(), asyncio.Event()
        current, applied, resets = [1], [], []
        async def execute(data, authority):
            entered.set()
            await release.wait()
            applied.append(data['seq'])
            return {'status': 'applied'}
        q = InputAdmissionQueue(execute, lambda a: a == current[0], max_pending=1, max_pending_bytes=8)
        one = q.submit({'seq': 1}, authority=1, byte_count=4)
        await entered.wait()
        two = q.submit({'seq': 2}, authority=1, byte_count=4)
        over = q.submit({'seq': 3}, authority=1, byte_count=4)
        self.assertEqual((await over).outcome, 'resync-required')
        current[0] = 2
        async def reset():
            resets.append(True)
            return {'status': 'applied'}
        barrier = asyncio.create_task(q.reset_after_quiescent(1, reset))
        await asyncio.sleep(0)
        self.assertEqual(resets, [])
        release.set()
        self.assertEqual(await barrier, {'status': 'applied'})
        self.assertEqual((await one).outcome, 'cancelled')
        self.assertEqual((await two).outcome, 'cancelled')
        self.assertEqual(applied, [1])

    async def test_move_latest_and_reliable_fairness(self):
        entered, release = asyncio.Event(), asyncio.Event()
        seen = []
        async def execute(data, authority):
            seen.append(data['seq'])
            if len(seen) == 1:
                entered.set()
                await release.wait()
            return {'status': 'applied'}
        q = InputAdmissionQueue(execute, lambda a: True)
        first = q.submit({'seq': 1}, authority=1, byte_count=4)
        await entered.wait()
        old = q.submit({'seq': 2, 'type':'mouse', 'action':'move'}, authority=1, byte_count=4)
        latest = q.submit({'seq': 3, 'type':'mouse', 'action':'move'}, authority=1, byte_count=4)
        reliable = q.submit({'seq': 4}, authority=1, byte_count=4)
        self.assertEqual((await old).outcome, 'cancelled')
        self.assertEqual(q.snapshot()['pendingCount'], 1)
        self.assertEqual(q.unordered_snapshot()['pendingCount'], 1)
        release.set()
        await asyncio.gather(first, latest, reliable)
        self.assertEqual(seen, [1, 4, 3])

    async def test_failure_and_stale_are_not_applied(self):
        async def fail(data, authority):
            raise RuntimeError('native failure')
        q = InputAdmissionQueue(fail, lambda a: a == 1)
        self.assertEqual((await q.submit({}, authority=2, byte_count=1)).outcome, 'cancelled')
        result = await q.submit({}, authority=1, byte_count=1)
        self.assertEqual(result.result['status'], 'execution-failed')
        self.assertEqual((await q.submit({}, authority=1, byte_count=65537)).outcome, 'resync-required')
        self.assertTrue(q.snapshot()['frozen'])

    async def test_cancelled_observer_does_not_cancel_native_and_reset_failure_stays_frozen(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def execute(data, authority):
            entered.set()
            await release.wait()
            return {'status': 'applied'}
        q = InputAdmissionQueue(execute, lambda _: True)
        future = q.submit({}, authority=1, byte_count=1)
        await entered.wait()
        future.cancel()
        async def fail_reset():
            return {'status': 'rejected'}
        reset = asyncio.create_task(q.reset_after_quiescent(1, fail_reset))
        await asyncio.sleep(0)
        self.assertFalse(reset.done())
        release.set()
        self.assertEqual(await reset, {'status': 'rejected'})
        self.assertTrue(q.snapshot()['frozen'])

    async def test_timeout_does_not_cancel_execution_or_reopen_admission(self):
        entered, release = asyncio.Event(), asyncio.Event()
        reset_calls = []
        async def execute(data, authority):
            entered.set()
            await release.wait()
            return {'status':'applied'}
        q = InputAdmissionQueue(execute, lambda _: True)
        one = q.submit({}, authority=1, byte_count=1)
        await entered.wait()
        async def reset():
            reset_calls.append(True)
            return {'status':'applied'}
        try:
            self.assertEqual(await q.reset_after_quiescent(1, reset), {'status':'rejected'})
            self.assertFalse(one.done())
            self.assertFalse(q.resume())
            self.assertEqual(reset_calls, [])
            release.set()
            self.assertEqual(await q.reset_after_quiescent(1, reset), {'status':'applied'})
            self.assertEqual(reset_calls, [True])
        finally:
            release.set()
            await one
