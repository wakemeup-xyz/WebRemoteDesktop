import asyncio
import threading
import unittest
from relay_frame_worker import RelayFrameWorker


class RelayTests(unittest.IsolatedAsyncioTestCase):
    async def test_off_loop_latest_only_and_stale_result(self):
        loop = asyncio.get_running_loop()
        entered, release = asyncio.Event(), threading.Event()
        seen = []
        loop_thread = threading.get_ident()
        def process(request):
            self.assertNotEqual(threading.get_ident(), loop_thread)
            seen.append(request['id'])
            loop.call_soon_threadsafe(entered.set)
            if request['id'] == 1:
                self.assertTrue(release.wait(2))
            return b'jpeg'
        w = RelayFrameWorker(process)
        try:
            one = w.submit_latest({'id':1, 'generation':1})
            await entered.wait()
            two = w.submit_latest({'id':2, 'generation':1})
            three = w.submit_latest({'id':3, 'generation':1})
            self.assertEqual(w.snapshot()['pendingCount'], 1)
            self.assertEqual(w.snapshot()['droppedCount'], 1)
            self.assertIsNone(await two)
            release.set()
            await w.drain()
            self.assertEqual(seen, [1, 3])
            self.assertEqual(await one, b'jpeg')
            self.assertEqual(await three, b'jpeg')
            w.invalidate(2)
            self.assertIsNone(await w.submit_latest({'id':4, 'generation':1}))
        finally:
            release.set()
            await w.stop()
        self.assertIsNone(await w.submit_latest({'id':5, 'generation':2}))

    async def test_invalidate_drops_inflight_and_pending(self):
        entered, release = threading.Event(), threading.Event()
        def process(request):
            entered.set()
            release.wait(2)
            return b'old'
        w = RelayFrameWorker(process)
        try:
            one = w.submit_latest({'generation':1})
            while not entered.is_set():
                await asyncio.sleep(0)
            two = w.submit_latest({'generation':1})
            w.invalidate(2)
            self.assertIsNone(await two)
            release.set()
            await w.drain()
            self.assertIsNone(await one)
        finally:
            release.set()
            await w.stop()

    async def test_stop_timeout_retains_worker_and_closes_on_own_thread(self):
        loop = asyncio.get_running_loop()
        entered, release = asyncio.Event(), threading.Event()
        threads = []
        class Processor:
            def __call__(self, request):
                threads.append(threading.get_ident())
                loop.call_soon_threadsafe(entered.set)
                release.wait(4)
                return b'old'
            def close(self):
                threads.append(threading.get_ident())
        w = RelayFrameWorker(Processor())
        try:
            output = w.submit_latest({'generation':1})
            await entered.wait()
            self.assertFalse(await w.stop())
            self.assertTrue(w.snapshot()['frozen'])
            self.assertFalse(w.stopped)
            self.assertTrue(w.snapshot()['processorActive'])
            self.assertFalse(w.snapshot()['deliveryPending'])
            self.assertIsNone(await w.submit_latest({'generation':1}))
            release.set()
            self.assertTrue(await w.stop())
            self.assertIsNone(await output)
            self.assertEqual(len(set(threads)), 1)
            self.assertNotEqual(threads[0], threading.get_ident())
        finally:
            release.set()
            await w.stop()

    async def test_worker_does_not_retain_the_last_encoded_output_while_idle(self):
        import gc
        import weakref
        refs = []
        class Buffer(bytearray):
            pass
        def process(request):
            encoded = Buffer(b'jpeg')
            refs.append(weakref.ref(encoded))
            return {'data':encoded}
        w = RelayFrameWorker(process)
        try:
            future = w.submit_latest({'generation':1})
            await w.drain()
            del future
            await asyncio.sleep(0)
            gc.collect()
            self.assertIsNone(refs[0]())
        finally:
            await w.stop()


class StageTests(unittest.IsolatedAsyncioTestCase):
    async def exercise_stages(self, fail=False):
        now = [0]
        entered, release = threading.Event(), threading.Event()
        held = []
        loop = asyncio.get_running_loop()
        def process(request):
            entered.set()
            release.wait(4)
            if fail:
                raise ValueError('processor failed')
            return b'jpeg'
        worker = RelayFrameWorker(process, now_ns=lambda: now[0])
        class CompletionAdapter:
            def call_soon_threadsafe(self, callback, *args):
                if callback == worker._complete:
                    held.append((callback, args))
                else:
                    loop.call_soon_threadsafe(callback, *args)
        worker._loop = CompletionAdapter()
        # Future creation remains on the real offline loop.
        worker._loop.create_future = loop.create_future
        async def until(predicate):
            async with asyncio.timeout(2):
                while not predicate():
                    await asyncio.sleep(0)
        try:
            one = worker.submit_latest({'generation': 1})
            await until(entered.is_set)
            snapshot = worker.snapshot()
            self.assertTrue(snapshot['processorActive'])
            self.assertFalse(snapshot['deliveryPending'])
            self.assertEqual(snapshot['processorAgeMs'], 0)
            self.assertEqual(snapshot['lastQueueWaitMs'], 0)
            now[0] = 2_000_000
            two = worker.submit_latest({'generation': 1})
            now[0] = 5_000_000
            self.assertEqual(worker.snapshot()['pendingAgeMs'], 3)
            three = worker.submit_latest({'generation': 1})
            self.assertIsNone(await two)
            self.assertEqual(worker.snapshot()['pendingAgeMs'], 0)
            worker.invalidate(2)
            self.assertIsNone(await three)
            self.assertTrue(worker.snapshot()['processorActive'])
            self.assertIsNone(worker.snapshot()['pendingAgeMs'])
            release.set()
            await until(lambda: bool(held))
            now[0] = 12_000_000
            snapshot = worker.snapshot()
            self.assertFalse(snapshot['processorActive'])
            self.assertIsNone(snapshot['processorAgeMs'])
            self.assertTrue(snapshot['deliveryPending'])
            self.assertEqual(snapshot['deliveryAgeMs'], 7)
            self.assertEqual(snapshot['lastProcessorMs'], 5)
            worker.invalidate(3)
            self.assertTrue(worker.snapshot()['deliveryPending'])
            self.assertTrue(await worker.stop())
            self.assertTrue(worker.snapshot()['deliveryPending'])
            callback, args = held.pop()
            callback(*args)
            self.assertIsNone(await one)
            self.assertIsNone(worker.snapshot()['deliveryAgeMs'])
            self.assertEqual(worker.snapshot()['lastDeliveryWaitMs'], 7)
        finally:
            release.set()
            await worker.stop()
            for callback, args in held:
                callback(*args)

    async def test_processor_and_loop_delivery_are_distinct(self):
        await self.exercise_stages()

    async def test_processor_error_still_enters_delivery(self):
        await self.exercise_stages(fail=True)


    async def test_pending_wait_and_valid_error_delivery(self):
        now = [0]
        def process(request):
            now[0] = 9_000_000
            raise ValueError('processor failed')
        worker = RelayFrameWorker(process, now_ns=lambda: now[0])
        try:
            # Keep the worker from dequeuing until the pending age is observed.
            with worker._condition:
                future = worker.submit_latest({'generation': 1})
                now[0] = 4_000_000
                self.assertEqual(worker.snapshot()['pendingAgeMs'], 4)
                self.assertFalse(worker.snapshot()['processorActive'])
                self.assertIsNone(worker.snapshot()['lastQueueWaitMs'])
            with self.assertRaisesRegex(ValueError, 'processor failed'):
                await future
            snapshot = worker.snapshot()
            self.assertEqual(snapshot['lastQueueWaitMs'], 4)
            self.assertEqual(snapshot['lastProcessorMs'], 5)
            self.assertEqual(snapshot['lastDeliveryWaitMs'], 0)
            self.assertFalse(snapshot['deliveryPending'])
            self.assertIsNone(snapshot['pendingAgeMs'])
        finally:
            await worker.stop()
