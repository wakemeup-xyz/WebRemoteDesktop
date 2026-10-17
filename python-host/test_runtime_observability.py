import asyncio
import unittest

from runtime_observability import (
    RuntimeObservability, ResourceSampler, resource_delta, unavailable_capture_observation,
)


class RuntimeObservabilityTest(unittest.TestCase):
    def test_current_memory_and_complete_low_frequency_window(self):
        observer = RuntimeObservability(now_ns=lambda: 5_000_000_000,
            read_current_rss=lambda: 100.0, read_peak_rss=lambda: 900.0)
        for sec, lag_ms in [(1, 0), (2, 5), (3, 30), (4, 100)]:
            observer.observe_loop(sec * 1_000_000_000, sec * 1_000_000_000 + lag_ms * 1_000_000)
        result = observer.snapshot(5_000_000_000)
        self.assertEqual(result['currentRssMiB'], 100.0)
        self.assertEqual(result['peakRssMiB'], 900.0)
        self.assertEqual(result['eventLoop']['count'], 4)
        self.assertEqual(result['eventLoop']['last'], 100.0)
        self.assertEqual(result['eventLoop']['p50'], 5.0)

    def test_window_expires_on_read_and_missed_deadlines_are_not_zero_samples(self):
        observer = RuntimeObservability(read_current_rss=lambda: None, read_peak_rss=lambda: None)
        observer.observe_loop(1_000_000_000, 4_000_000_000)
        result = observer.snapshot(4_000_000_000)
        self.assertEqual(result['eventLoop']['count'], 1)
        self.assertEqual(result['eventLoop']['missedSampleCount'], 3)
        self.assertEqual(result['eventLoop']['last'], 3000.0)
        self.assertEqual(observer.snapshot(65_000_000_000)['eventLoop']['count'], 0)
        self.assertIsNone(observer.snapshot(65_000_000_000)['eventLoop']['last'])

    def test_queue_whitelist_and_bound(self):
        observer = RuntimeObservability()
        canary = 'secret-input-canary'
        observer.register_queue('inputReliable', lambda: {'pendingCount': 2, 'pendingBytes': 7,
            'inFlightCount': 1, 'droppedCount': 0, 'frozen': False, 'payload': canary})
        with self.assertRaises(ValueError):
            observer.register_queue('payload', lambda: {})
        result = observer.snapshot(0)
        self.assertEqual(result['queues']['inputReliable']['pendingCount'], 2)
        self.assertIsNone(result['queues']['inputUnordered'])
        self.assertNotIn(canary, str(result))
        for sec in range(200):
            observer.observe_loop(sec * 1_000_000_000, sec * 1_000_000_000)
        self.assertLessEqual(len(observer._loop_samples), 120)
        self.assertEqual(observer.snapshot(199_000_000_000)['eventLoop']['count'], 60)

    def test_resource_delta_uses_actual_elapsed_and_page_size(self):
        previous = {'sampledNs': 1_000_000_000, 'swapIns': 10, 'swapOuts': 4}
        current = {'sampledNs': 3_000_000_000, 'swapIns': 14, 'swapOuts': 3,
                   'pageSize': 16384, 'currentRssMiB': 10, 'peakRssMiB': 20}
        result = resource_delta(previous, current)
        self.assertEqual(result['elapsedMs'], 2000)
        self.assertEqual(result['swapInBytesPerSec'], 32768)
        self.assertIsNone(result['swapOutBytesPerSec'])
        self.assertEqual(result['memoryPressure'], 'unknown')
        self.assertIsNone(resource_delta(None, current)['swapInBytesPerSec'])
        self.assertIsNone(resource_delta(current, current)['swapInBytesPerSec'])


class ResourceSamplerTest(unittest.IsolatedAsyncioTestCase):
    async def test_pending_worker_never_blocks_snapshot_and_close_joins(self):
        now = [1_000_000_000]
        entered = asyncio.Event()
        cancelled = asyncio.Event()
        async def collect(pid):
            entered.set()
            try:
                await asyncio.Future()
            finally:
                cancelled.set()
        sampler = ResourceSampler(123, registered_pids={123}, collect=collect,
            now_ns=lambda: now[0], interval_seconds=5, budget_seconds=1)
        sampler.start()
        await entered.wait()
        self.assertFalse(sampler.snapshot()['available'])
        await sampler.close()
        self.assertTrue(cancelled.is_set())
        self.assertTrue(sampler._task.done())

    async def test_cached_sample_age_expiry_timeout_and_explicit_pid(self):
        with self.assertRaises(ValueError):
            ResourceSampler(123, registered_pids={124})
        now = [1_000_000_000]
        async def collect(pid):
            self.assertEqual(pid, 123)
            return {'sampledNs': now[0], 'currentRssMiB': 33, 'peakRssMiB': 99}
        sampler = ResourceSampler(123, registered_pids={123}, collect=collect, now_ns=lambda: now[0])
        await sampler.sample_once()
        self.assertEqual(sampler.snapshot()['currentRssMiB'], 33)
        now[0] += 11_000_000_000
        self.assertFalse(sampler.snapshot()['available'])
        self.assertIsNone(sampler.snapshot()['currentRssMiB'])
        self.assertEqual(sampler.snapshot()['ageMs'], 11000)
        async def pending(pid):
            await asyncio.Future()
        sampler._collect = pending
        sampler.budget_seconds = 0.001
        await sampler.sample_once()
        self.assertEqual(sampler.snapshot()['status'], 'timeout')
        await sampler.close()


class ResourceCommandTest(unittest.IsolatedAsyncioTestCase):
    async def test_explicit_pid_and_failing_ps_return_unavailable(self):
        from runtime_observability import collect_resources
        calls = []
        async def command(*args):
            calls.append(args)
            return 'no such pid'
        current = await collect_resources(123, registered_pids={123}, command=command, platform='linux')
        self.assertEqual(calls, [('/bin/ps', '-o', 'rss=', '-p', '123')])
        self.assertIsNone(current['currentRssMiB'])
        with self.assertRaises(ValueError):
            await collect_resources(124, registered_pids={123}, command=command)
        self.assertEqual(len(calls), 1)

    async def test_timeout_kills_and_reaps_owned_child(self):
        from unittest.mock import patch
        from runtime_observability import run_command
        class Process:
            returncode = None
            killed = False
            reaped = False
            async def communicate(self):
                if not self.killed:
                    await asyncio.Future()
                self.returncode = -9
                self.reaped = True
                return b'', None
            def kill(self):
                self.killed = True
        process = Process()
        async def spawn(*args, **kwargs):
            return process
        with patch('runtime_observability.asyncio.create_subprocess_exec', spawn):
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(run_command('/bin/ps'), .001)
        self.assertTrue(process.killed)
        self.assertTrue(process.reaped)

    async def test_cancel_during_spawn_reaps_late_child(self):
        from unittest.mock import patch
        from runtime_observability import run_command
        entered = asyncio.Event()
        release = asyncio.Event()
        class Process:
            returncode = None
            killed = False
            reaped = False
            def kill(self):
                self.killed = True
            async def communicate(self):
                self.returncode = -9
                self.reaped = True
                return b'', None
        process = Process()
        async def spawn(*args, **kwargs):
            entered.set()
            await release.wait()
            return process
        with patch('runtime_observability.asyncio.create_subprocess_exec', spawn):
            task = asyncio.create_task(run_command('/bin/ps'))
            await entered.wait()
            task.cancel()
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertTrue(process.killed)
        self.assertTrue(process.reaped)


class HostRuntimeAdapterTest(unittest.TestCase):
    def test_context_reads_only_cached_resources_without_importing_host(self):
        import ast
        from pathlib import Path
        from types import SimpleNamespace
        source = ast.parse(Path(__file__).with_name('host.py').read_text())
        host = next(node for node in source.body if isinstance(node, ast.ClassDef) and node.name == 'WebRemoteHost')
        method = next(node for node in host.body if isinstance(node, ast.FunctionDef)
                      and node.name == 'build_event_loop_lag_context')
        namespace = {
            'RuntimeObservability': RuntimeObservability,
            'resource': SimpleNamespace(RUSAGE_SELF=0, getrusage=lambda _: SimpleNamespace(ru_utime=1, ru_stime=2)),
            'time': SimpleNamespace(perf_counter=lambda: 10, monotonic_ns=lambda: 0),
            'unavailable_capture_observation': unavailable_capture_observation,
            'os': SimpleNamespace(getloadavg=lambda: (0, 0, 0)),
            'threading': SimpleNamespace(active_count=lambda: 1),
        }
        exec(compile(ast.Module(body=[method], type_ignores=[]), '<host context only>', 'exec'), namespace)
        instance = SimpleNamespace(_runtime_observability=RuntimeObservability(
            read_current_rss=lambda: 100, read_peak_rss=lambda: 900))
        result = namespace['build_event_loop_lag_context'](instance,
            lag_ms=0, sample_count=1, max_lag_ms=0, task_count=2)
        self.assertEqual(result['currentRssMiB'], 100)
        self.assertEqual(result['peakRssMiB'], 900)
        self.assertNotIn('rssMiB', result)
        self.assertEqual(result['severity'], 'normal')

    def test_peak_rss_platform_units_are_explicit(self):
        from unittest.mock import patch
        import runtime_observability as runtime
        from types import SimpleNamespace
        with patch.object(runtime.resource, 'getrusage', return_value=SimpleNamespace(ru_maxrss=1048576)):
            with patch.object(runtime.sys, 'platform', 'darwin'):
                self.assertEqual(runtime.read_peak_rss_mib(), 1)
            with patch.object(runtime.sys, 'platform', 'linux'):
                self.assertEqual(runtime.read_peak_rss_mib(), 1024)


class ResourceBudgetTest(unittest.IsolatedAsyncioTestCase):
    async def test_commands_share_total_budget_and_pending_keeps_previous_cache(self):
        from runtime_observability import collect_resources
        now = [1_000_000_000]
        async def initial(pid):
            return {'sampledNs': now[0], 'currentRssMiB': 33, 'peakRssMiB': 99}
        sampler = ResourceSampler(123, registered_pids={123}, collect=initial, now_ns=lambda: now[0])
        await sampler.sample_once()
        calls = []
        entered = asyncio.Event()
        async def command(*args):
            calls.append(args)
            if args[0] == '/bin/ps':
                return '204800'
            entered.set()
            await asyncio.Future()
        async def collect(pid):
            return await collect_resources(pid, registered_pids={123}, command=command, platform='darwin')
        sampler._collect = collect
        sampler.budget_seconds = .01
        task = asyncio.create_task(sampler.sample_once())
        await entered.wait()
        now[0] += 1_000_000_000
        cached = sampler.snapshot()
        self.assertEqual(cached['currentRssMiB'], 33)
        self.assertEqual(cached['ageMs'], 1000)
        await task
        self.assertEqual(sampler.snapshot()['status'], 'timeout')
        self.assertEqual(len(calls), 2)
        self.assertEqual(sampler.snapshot()['currentRssMiB'], 33)
        await sampler.close()


class RelaySnapshotTest(unittest.TestCase):
    def test_relay_queue_contention_is_unavailable_without_waiting(self):
        from runtime_observability import snapshot_relay_queue
        from types import SimpleNamespace
        calls = []
        import threading
        condition = threading.Condition()
        condition.acquire = lambda **kwargs: calls.append(kwargs) or False
        worker = SimpleNamespace(_condition=condition,
            snapshot=lambda: self.fail('contended worker must not be read'))
        self.assertIsNone(snapshot_relay_queue(worker))
        self.assertEqual(calls, [{'blocking': False}])
        unknown = SimpleNamespace(snapshot=lambda: self.fail('unknown worker must not be read'))
        self.assertIsNone(snapshot_relay_queue(unknown))
        unknown._condition = threading.Condition(threading.Lock())
        self.assertIsNone(snapshot_relay_queue(unknown))

    def test_relay_queue_reentrant_lock_is_released_and_fields_are_sanitized(self):
        import threading
        from runtime_observability import snapshot_relay_queue
        from types import SimpleNamespace
        condition = threading.Condition()
        class Worker:
            _condition = condition
            def snapshot(self):
                with self._condition:
                    return {'pendingCount': 1, 'payload': 'relay-secret-canary'}
        observer = RuntimeObservability()
        observer.register_queue('relayFrames', lambda: snapshot_relay_queue(Worker()))
        result = observer.snapshot(0)
        self.assertNotIn('relay-secret-canary', str(result))
        self.assertEqual(result['queues']['relayFrames']['pendingCount'], 1)
        self.assertIsNone(result['queues']['relayFrames']['pendingBytes'])
        self.assertFalse(condition._is_owned())


class RelayStageWhitelistTest(unittest.TestCase):
    def test_stage_types_zero_and_input_schema(self):
        numeric = ('pendingAgeMs', 'processorAgeMs', 'deliveryAgeMs',
                   'lastQueueWaitMs', 'lastProcessorMs', 'lastDeliveryWaitMs')
        for value in (False, True, float('nan'), -1, None, 0, 7.5):
            for flag in (False, True, 0, 'true', None):
                raw = dict.fromkeys(numeric, value)
                raw.update(processorActive=flag, deliveryPending=flag, payload='stage-canary')
                observer = RuntimeObservability()
                observer.register_queue('relayFrames', lambda: raw)
                observer.register_queue('inputReliable', lambda: raw)
                observer.register_queue('inputUnordered', lambda: raw)
                result = observer.snapshot(0)['queues']
                relay = result['relayFrames']
                for field in numeric:
                    self.assertEqual(relay[field], value if type(value) in (int, float) and value >= 0 else None)
                for field in ('processorActive', 'deliveryPending'):
                    self.assertIs(relay[field], flag if isinstance(flag, bool) else None)
                for name in ('inputReliable', 'inputUnordered'):
                    self.assertEqual(set(result[name]), {'pendingCount', 'pendingBytes', 'inFlightCount', 'droppedCount', 'frozen'})
                self.assertNotIn('stage-canary', str(result))


    def test_real_relay_lock_contention_returns_before_owner_releases(self):
        import threading
        from types import SimpleNamespace
        from runtime_observability import snapshot_relay_queue
        condition = threading.Condition()
        entered, release = threading.Event(), threading.Event()
        def hold():
            with condition:
                entered.set()
                release.wait(2)
        owner = threading.Thread(target=hold)
        owner.start()
        try:
            self.assertTrue(entered.wait(1))
            worker = SimpleNamespace(_condition=condition,
                snapshot=lambda: self.fail('busy worker must not be read'))
            self.assertIsNone(snapshot_relay_queue(worker))
            self.assertFalse(release.is_set())
        finally:
            release.set()
            owner.join(2)
        self.assertFalse(owner.is_alive())
