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
