import unittest
from input_timing import InputTiming, relay_ack_duration_ms

class TestInputTimingContract(unittest.TestCase):
    def test_queue_and_execution_are_measured_before_result_construction(self):
        clock = iter([1_000_000, 41_000_000, 71_000_000])
        timing = InputTiming(clock_ns=lambda: next(clock))
        timing.start_apply()
        timing.finish_apply()
        self.assertEqual(timing.durations(), {"hostQueueMs": 40.0, "hostApplyMs": 30.0})
        self.assertEqual(timing.durations()["hostApplyMs"], 30.0)

    def test_relay_duration_rejects_missing_nonfinite_and_reversed_values(self):
        self.assertEqual(relay_ack_duration_ms(1000, 1200), 200)
        for start, end in [(None, 1), (1, None), (2, 1), (float('nan'), 2), (1, float('inf')), (True, 2)]:
            self.assertIsNone(relay_ack_duration_ms(start, end))

# Extract production classes without importing Host/Quartz or starting services.
import ast
import asyncio
import logging
from pathlib import Path
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import patch


def production_class(filename, name, **namespace):
    tree = ast.parse(Path(__file__).with_name(filename).read_text())
    node = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == name)
    env = {"asyncio": asyncio, "time": time, "InputTiming": InputTiming, "logger": logging.getLogger(__name__),
           "relay_ack_duration_ms": relay_ack_duration_ms, **namespace}
    exec(compile(ast.Module(body=[node], type_ignores=[]), filename, 'exec'), env)
    return env[name]


class TestActualKeyboardTiming(unittest.IsolatedAsyncioTestCase):
    async def test_worker_hooks_surround_apply_and_ignore_result_construction(self):
        Handler = production_class('input_handler.py', 'InputHandler')
        handler = Handler.__new__(Handler)
        handler._keyboard_lock = asyncio.Lock()
        handler._keyboard_executor = ThreadPoolExecutor(max_workers=1)
        entered, release = threading.Event(), threading.Event()
        ticks = [1_000_000]
        class Adapter:
            def apply(self, envelope):
                entered.set()
                release.wait(2)
                ticks[0] = 71_000_000
                return SimpleNamespace(applied_seq=1, status='applied', pressed_key_count=0, modifier_mask=0)
        handler._remote_keyboard = Adapter()
        real_result = handler._keyboard_result
        def delayed_result(*args, **kwargs):
            ticks[0] = 999_000_000
            return real_result(*args, **kwargs)
        handler._keyboard_result = delayed_result
        # Holding the lock simulates queue delay before worker admission.
        await handler._keyboard_lock.acquire()
        with patch.object(InputTiming, '__init__', lambda obj: original_init(obj, clock_ns=lambda: ticks[0])):
            task = asyncio.create_task(handler.apply_keyboard({'schemaVersion': 2, 'inputIds': ['one']}))
            await asyncio.sleep(0)
            ticks[0] = 41_000_000
            handler._keyboard_lock.release()
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 2))
                self.assertFalse(task.done())
                release.set()
                result = await task
                self.assertEqual(result['hostQueueMs'], 40)
                self.assertEqual(result['hostApplyMs'], 30)
            finally:
                release.set()
                handler._keyboard_executor.shutdown(wait=True)


original_init = InputTiming.__init__

class TestActualRelayAck(unittest.TestCase):
    def test_client_latency_unknown_and_old_generation_do_not_control_feedback(self):
        Relay = production_class('host.py', 'TunnelRelayStreamer')
        for client_ms in [5100, 0]:
            relay = Relay.__new__(Relay)
            relay.production_generation = 3
            relay.inflight_frames = {1: {'sent_at_ms': 1000, 'generation': 3}, 2: {'sent_at_ms': 1000, 'generation': 2}, 3: {'sent_at_ms': -10000, 'generation': 3}}
            relay.last_acked_frame_id = 0
            relay.stats_acked = 0
            relay.ack_event = threading.Event()
            feedback = []
            relay._record_ack_feedback = feedback.append
            with patch.object(time, 'monotonic', return_value=1.2):
                relay.ack(1, latency_ms=client_ms)
                relay.ack(1, latency_ms=client_ms)
                relay.ack(2, latency_ms=client_ms)
                relay.ack(99, latency_ms=client_ms)
                relay.ack(3, latency_ms=client_ms)
            self.assertEqual(feedback, [200])
            self.assertEqual(relay.stats_acked, 1)
