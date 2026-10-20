"""Pure boundary tests; no native Host imports or real subprocesses."""
import asyncio
import threading
import time
import unittest
from unittest.mock import patch

from runtime_observability import ResourceSampler


class ResourceIsolationTest(unittest.IsolatedAsyncioTestCase):
    async def test_default_collector_sync_block_does_not_block_caller_deadline(self):
        release = threading.Event()
        entered = threading.Event()
        heartbeat = []
        collector_threads = []
        async def collect(pid, **kwargs):
            collector_threads.append(threading.get_ident())
            entered.set()
            release.wait(2)  # releases the GIL; models the pre-first-await spawn boundary
            return {'sampledNs': time.monotonic_ns(), 'currentRssMiB': 33}
        watchdog = threading.Timer(.4, release.set)
        sampler = ResourceSampler(123, registered_pids={123}, budget_seconds=.04)
        async def beat():
            await asyncio.sleep(.01)
            heartbeat.append(not release.is_set())
        watchdog.start()
        try:
            with patch('runtime_observability.collect_resources', collect):
                pulse = asyncio.create_task(beat())
                started = time.monotonic()
                await sampler.sample_once()
                elapsed = time.monotonic() - started
                await pulse
                self.assertTrue(entered.is_set())
                self.assertLess(elapsed, .25)
                self.assertEqual(heartbeat, [True])
                self.assertNotEqual(collector_threads, [threading.get_ident()])
                self.assertEqual(sampler.snapshot()['status'], 'timeout')
        finally:
            release.set()
            watchdog.cancel()
            watchdog.join(2)
            await sampler.close()
            owner = getattr(sampler, '_owner', None)
            if owner is not None and owner._thread is not None:
                owner._thread.join(2)  # fixture only; production close must never join
                self.assertFalse(owner._thread.is_alive())

    async def wait_until(self, predicate, seconds=1):
        deadline = asyncio.get_running_loop().time() + seconds
        while not predicate():
            if asyncio.get_running_loop().time() >= deadline:
                self.fail('fixture did not reach expected state')
            await asyncio.sleep(.002)

    async def retire(self, sampler, *gates):
        for gate in gates:
            gate.set()
        await sampler.close()
        owner = getattr(sampler, '_owner', None)
        if owner is not None and owner._thread is not None:
            owner._thread.join(2)
            self.assertFalse(owner._thread.is_alive())

    async def test_timeout_reserves_slot_until_cleanup_ack_and_fences_late_result(self):
        release, cleanup_entered, cleanup_release = (threading.Event() for _ in range(3))
        calls = []
        async def collect(pid, **kwargs):
            calls.append(pid)
            if len(calls) == 1:
                return {'sampledNs': 1_000_000_000, 'currentRssMiB': 33,
                        'swapIns': 1, 'pageSize': 10}
            try:
                release.wait(2)
                await asyncio.sleep(0)
            finally:
                cleanup_entered.set()
                cleanup_release.wait(2)
            return {'sampledNs': 2_000_000_000, 'currentRssMiB': 999}
        sampler = ResourceSampler(123, registered_pids={123}, budget_seconds=.04,
                                  now_ns=lambda: 3_000_000_000)
        try:
            with patch('runtime_observability.collect_resources', collect):
                await sampler.sample_once()
                await sampler.sample_once()
                self.assertEqual(sampler.snapshot()['status'], 'timeout')
                self.assertTrue(sampler.snapshot()['collector']['cleanupPending'])
                release.set()
                await self.wait_until(cleanup_entered.is_set)
                for _ in range(20):
                    await sampler.sample_once()
                self.assertEqual(calls, [123, 123])
                self.assertEqual(sampler.snapshot()['currentRssMiB'], 33)
                cleanup_release.set()
                await self.wait_until(lambda: not sampler.snapshot()['collector']['busy'])
                self.assertEqual(sampler.snapshot()['currentRssMiB'], 33)
                self.assertEqual(sampler._previous['sampledNs'], 1_000_000_000)
        finally:
            await self.retire(sampler, release, cleanup_release)

    async def test_close_uses_one_persisted_budget_and_reports_pending_cleanup(self):
        entered, release = threading.Event(), threading.Event()
        async def collect(pid, **kwargs):
            entered.set()
            release.wait(2)
            return {'sampledNs': time.monotonic_ns(), 'currentRssMiB': 33}
        sampler = ResourceSampler(123, registered_pids={123}, budget_seconds=.04)
        try:
            with patch('runtime_observability.collect_resources', collect):
                task = asyncio.create_task(sampler.sample_once())
                await self.wait_until(entered.is_set)
                started = time.monotonic()
                await sampler.close()
                self.assertLess(time.monotonic() - started, .2)
                first = sampler.snapshot()['collector']
                self.assertTrue(first['cleanupPending'])
                self.assertTrue(first['ownerAlive'])
                started = time.monotonic()
                for _ in range(20):
                    await sampler.close()
                    sampler.start()
                    await sampler.sample_once()
                self.assertLess(time.monotonic() - started, .03)
                self.assertTrue(task.done())
                self.assertFalse(sampler.snapshot()['available'])
        finally:
            await self.retire(sampler, release)

    async def test_passive_constructor_start_failure_no_replacement_and_private_state(self):
        sampler = ResourceSampler(123, registered_pids={123})
        with patch('threading.Thread.start', side_effect=RuntimeError('secret-canary')) as start:
            self.assertFalse(sampler.snapshot()['collector']['ownerAlive'])
            await sampler.sample_once()
            await sampler.sample_once()
            await sampler.close()
            self.assertEqual(start.call_count, 1)
        self.assertEqual(sampler.snapshot()['status'], 'unavailable')
        self.assertNotIn('secret-canary', repr(sampler.snapshot()))

    async def test_default_result_is_whitelisted_and_uses_collection_time_and_delta(self):
        now = [3_000_000_000]
        responses = iter([
            {'sampledNs': 1_000_000_000, 'currentRssMiB': 33, 'swapIns': 10,
             'pageSize': 10, 'raw': 'secret-canary'},
            {'sampledNs': 3_000_000_000, 'currentRssMiB': 34, 'swapIns': 14,
             'pageSize': 10},
        ])
        async def collect(pid, **kwargs):
            self.assertEqual(pid, 123)
            return next(responses)
        sampler = ResourceSampler(123, registered_pids={123}, now_ns=lambda: now[0])
        try:
            with patch('runtime_observability.collect_resources', collect):
                await sampler.sample_once()
                self.assertEqual(sampler.snapshot()['ageMs'], 2000)
                self.assertNotIn('secret-canary', repr(sampler._owner.read()))
                await sampler.sample_once()
                self.assertEqual(sampler.snapshot()['swapInBytesPerSec'], 20)
                now[0] = 14_000_000_000
                self.assertFalse(sampler.snapshot()['available'])
                self.assertIsNone(sampler.snapshot()['currentRssMiB'])
        finally:
            await self.retire(sampler)

    async def test_close_cancels_periodic_and_explicit_caller_once(self):
        entered, release = threading.Event(), threading.Event()
        async def collect(pid, **kwargs):
            entered.set()
            release.wait(2)
            return {'sampledNs': time.monotonic_ns(), 'currentRssMiB': 33}
        sampler = ResourceSampler(123, registered_pids={123}, budget_seconds=.04)
        task = None
        try:
            with patch('runtime_observability.collect_resources', collect):
                task = asyncio.create_task(sampler.sample_once())
                await self.wait_until(entered.is_set)
                sampler.start()
                await asyncio.sleep(0)
                await sampler.close()
                self.assertTrue(task.done())
                self.assertTrue(sampler._task.done())
        finally:
            release.set()
            if sampler._task is not None:
                sampler._task.cancel()  # fixture also retires the pre-fix leaked cadence task
                await asyncio.gather(sampler._task, return_exceptions=True)
            await self.retire(sampler)

    async def test_registered_pid_set_is_captured_before_owner_start(self):
        registered = {123}
        sampler = ResourceSampler(123, registered_pids=registered)
        registered.clear()
        # Exercise the real collect_resources PID guard, with only command I/O replaced.
        async def command(*args):
            return '1024' if args[0] == '/bin/ps' else ''
        import runtime_observability as runtime
        real_collect = runtime.collect_resources
        async def collect(pid, **kwargs):
            return await real_collect(pid, command=command, platform='linux', **kwargs)
        try:
            with patch('runtime_observability.collect_resources', collect):
                await sampler.sample_once()
                self.assertEqual(sampler.snapshot()['currentRssMiB'], 1)
        finally:
            await self.retire(sampler)

    async def test_default_spawn_timeout_waits_for_actual_kill_and_reap(self):
        spawning, release_spawn, reaping, release_reap = (threading.Event() for _ in range(4))
        calls = []
        class Process:
            returncode = None
            killed = False
            reaped = False
            def kill(self):
                self.killed = True
            async def communicate(self):
                if not self.killed:
                    await asyncio.Future()
                reaping.set()
                release_reap.wait(2)
                self.reaped = True
                self.returncode = -9
                return b'', None
        child = Process()
        async def spawn(*args, **kwargs):
            calls.append(args)
            spawning.set()
            release_spawn.wait(2)
            return child
        sampler = ResourceSampler(123, registered_pids={123}, budget_seconds=.04)
        try:
            with patch('runtime_observability.asyncio.create_subprocess_exec', spawn):
                await sampler.sample_once()
                self.assertTrue(spawning.is_set())
                self.assertFalse(child.killed)
                self.assertTrue(sampler.snapshot()['collector']['cleanupPending'])
                release_spawn.set()
                await self.wait_until(reaping.is_set)
                self.assertTrue(child.killed)
                self.assertFalse(child.reaped)
                await sampler.sample_once()
                await sampler.close()
                await sampler.close()
                self.assertEqual(len(calls), 1)
                self.assertTrue(sampler.snapshot()['collector']['busy'])
                release_reap.set()
                await self.wait_until(lambda: not sampler.snapshot()['collector']['ownerAlive'])
                self.assertTrue(child.reaped)
                self.assertFalse(sampler.snapshot()['collector']['cleanupPending'])
                self.assertIsNone(sampler._previous)
        finally:
            await self.retire(sampler, release_spawn, release_reap)

    async def test_unexpected_owner_initialization_exit_is_unavailable_without_replacement(self):
        sampler = ResourceSampler(123, registered_pids={123})
        try:
            with patch('runtime_observability.asyncio.new_event_loop', side_effect=RuntimeError('private-canary')) as create:
                await sampler.sample_once()
                await sampler.sample_once()
                self.assertEqual(create.call_count, 1)
                self.assertEqual(sampler.snapshot()['status'], 'unavailable')
                self.assertTrue(sampler.snapshot()['collector']['cleanupPending'])
                self.assertNotIn('private-canary', repr(sampler.snapshot()))
        finally:
            await self.retire(sampler)

    async def test_cancel_latch_and_completion_slots_are_bounded(self):
        entered, release = threading.Event(), threading.Event()
        async def collect(pid, **kwargs):
            entered.set()
            release.wait(2)
            return {'sampledNs': time.monotonic_ns(), 'currentRssMiB': 33}
        sampler = ResourceSampler(123, registered_pids={123}, budget_seconds=.04)
        try:
            with patch('runtime_observability.collect_resources', collect):
                task = asyncio.create_task(sampler.sample_once())
                await self.wait_until(entered.is_set)
                owner_loop = sampler._owner._loop
                with patch.object(owner_loop, 'call_soon_threadsafe', wraps=owner_loop.call_soon_threadsafe) as notify:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                    for _ in range(50):
                        await sampler.sample_once()
                        sampler._owner.cancel(1)
                        sampler._owner.cancel(999)
                    await sampler.close()
                    self.assertEqual(notify.call_count, 1)
                self.assertIsNone(sampler._owner.read())
                self.assertEqual(sampler._owner._job, (1, 123))
        finally:
            await self.retire(sampler, release)

    async def test_passive_file_location_import_keeps_one_shot_caller_compatible(self):
        import importlib.util
        from pathlib import Path
        path = Path(__file__).with_name('runtime_observability.py')
        spec = importlib.util.spec_from_file_location('resource_probe_test', path)
        module = importlib.util.module_from_spec(spec)
        with patch('threading.Thread.start', side_effect=AssertionError('must stay passive')):
            spec.loader.exec_module(module)
            sampler = module.ResourceSampler(123, registered_pids={123})
            self.assertEqual(sampler.snapshot()['collector']['state'], 'not-started')
            await sampler.close()

    async def test_owner_loop_failure_cannot_publish_false_cleanup_ack(self):
        class IncompleteTask:
            def done(self):
                return False
            def cancel(self):
                pass
        class FailedLoop:
            def create_task(self, coroutine):
                coroutine.close()  # fake has no child; do not leave a coroutine fixture behind
                return IncompleteTask()
            def run_until_complete(self, task):
                raise RuntimeError('loop failed before collector completed')
            def close(self):
                pass
        sampler = ResourceSampler(123, registered_pids={123}, budget_seconds=.04)
        try:
            with patch('runtime_observability.asyncio.new_event_loop', return_value=FailedLoop()), \
                    patch('runtime_observability.asyncio.set_event_loop'):
                await sampler.sample_once()
                self.assertEqual(sampler.snapshot()['status'], 'unavailable')
                self.assertTrue(sampler.snapshot()['collector']['cleanupPending'])
                self.assertIsNone(sampler._owner.read())
        finally:
            await self.retire(sampler)
