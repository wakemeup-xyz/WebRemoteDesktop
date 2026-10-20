"""Deterministic tests of actual capture lifecycle methods extracted by AST."""
import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace
import unittest

from capture_cadence import CaptureCadenceObserver
from capture_resource_owner import CaptureResourceOwner
from runtime_observability import CaptureObservation
from test_capture_observation import Guard, method


class LatePublicationTest(unittest.TestCase):
    def run_late_grab(self, transition):
        clock = SimpleNamespace(now=0)
        trace = []
        track = SimpleNamespace(_capture_running=True, _suspended=False,
            _capture_generation=0, _target_generation=0, _target_fps=20,
            _capture_strategy=None, _activity_condition=Guard(), _target_lock=Guard(),
            _capture_lock=Guard(), _capture_observation=CaptureObservation(),
            _capture_cadence=CaptureCadenceObserver(), monitor=None,
            _capture_buffer='old', _capture_seq=8, _capture_bounds_ns={8: (0, 1)},
            _frame_trace_context=object(), _increment_trace_interval=lambda **kw: trace.append(kw),
            capture_fps_for_target=lambda fps, **kw: fps)
        def grab(_):
            clock.now = 10_000_000
            track._capture_buffer = None
            track._capture_bounds_ns.clear()
            if transition == 'stop':
                track._capture_running = False
            else:
                track._suspended = True
                track._capture_generation += 1
                track._suspended = False
                track._capture_generation += 1
            return 'late-pixels'
        track.sct = SimpleNamespace(grab=grab, close=lambda: None)
        track._capture_resource_owner = CaptureResourceOwner(track.sct)
        gates = []
        def gate():
            gates.append(1)
            if len(gates) > 1:
                track._capture_running = False
        track._activity_condition.enter = gate
        loop = method('ScreenCaptureTrack', '_capture_loop', time=SimpleNamespace(
            monotonic_ns=lambda: clock.now, thread_time_ns=lambda: 0,
            sleep=lambda _: None))
        loop(track)
        return track, trace, clock

    def test_stop_inside_grab_does_not_refill_cleared_pixels_or_publish_trace(self):
        track, trace, clock = self.run_late_grab('stop')
        self.assertIsNone(track._capture_buffer)
        self.assertEqual(track._capture_bounds_ns, {})
        self.assertEqual(track._capture_seq, 8)
        self.assertEqual(trace, [])
        result = track._capture_observation.snapshot(clock.now, running=False,
            suspended=False, thread_alive=False, thread_started=True)
        self.assertEqual((result['attempted'], result['completed'], result['failed']), (1, 1, 0))
        cadence = track._capture_cadence.snapshot(clock.now)
        self.assertEqual((cadence['published'], cadence['discarded']), (0, 1))

    def test_pause_resume_crossing_discards_completed_grab(self):
        track, trace, _ = self.run_late_grab('resume')
        self.assertIsNone(track._capture_buffer)
        self.assertEqual(track._capture_bounds_ns, {})
        self.assertEqual(track._capture_seq, 8)
        self.assertEqual(trace, [])


class FakeExecutor:
    def __init__(self, **kwargs):
        self.calls = []
        self._shutdown = False
    def shutdown(self, *, wait):
        self.calls.append(wait)
        self._shutdown = True


def extracted_track(resource, *, on_start=None, on_join=None, to_thread=None):
    """Construct the real AST class with only deterministic fake dependencies."""
    threads = []
    clock = SimpleNamespace(now=0, sleeps=[])
    class FakeThread:
        ident = None
        alive = False
        def __init__(self, *, target, daemon):
            self.target = target
            threads.append(self)
        def start(self):
            if on_start is not None:
                on_start(self)
        def is_alive(self):
            return self.alive
        def join(self, *, timeout):
            self.timeout = timeout
            if on_join is not None:
                on_join(self)
    async def inline_to_thread(fn, **kwargs):
        return fn(**kwargs)
    def sleep(delay):
        clock.sleeps.append(delay)
        clock.now += int(delay * 1_000_000_000)
        threads[0].target.__self__._capture_running = False
    tree = ast.parse(Path(__file__).with_name('host.py').read_text())
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'ScreenCaptureTrack')
    names = {'__init__', '_capture_loop', 'shutdown', 'resource_snapshot'}
    selected = ast.ClassDef(name='ScreenCaptureTrack',
        bases=[ast.Name(id='VideoStreamTrack', ctx=ast.Load())], keywords=[],
        body=[n for n in cls.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names],
        decorator_list=[])
    namespace = dict(VideoStreamTrack=type('Base', (), {}),
        CaptureExperiment=type('Experiment', (), {}), MSS=lambda: resource,
        CaptureResourceOwner=CaptureResourceOwner, CaptureObservation=CaptureObservation,
        CaptureCadenceObserver=CaptureCadenceObserver, HAS_CV2=False,
        select_capture_monitor=lambda *args, **kw: {}, get_screeninfo_monitors=lambda: [],
        RtpFrameClock=lambda: None, ThreadPoolExecutor=FakeExecutor,
        threading=SimpleNamespace(Lock=Guard, Condition=Guard, Thread=FakeThread),
        asyncio=SimpleNamespace(to_thread=to_thread or inline_to_thread, CancelledError=asyncio.CancelledError),
        time=SimpleNamespace(monotonic=lambda: 0, monotonic_ns=lambda: clock.now,
            thread_time_ns=lambda: 0, process_time_ns=lambda: 0, time=lambda: 0, sleep=sleep),
        logger=SimpleNamespace(info=lambda *args, **kw: None))
    exec(compile(ast.fix_missing_locations(ast.Module(body=[selected], type_ignores=[])),
        '<AST capture lifecycle>', 'exec'), namespace)
    selected_cls = namespace['ScreenCaptureTrack']
    selected_cls.capture_fps_for_target = staticmethod(lambda fps, **kw: fps)
    selected_cls._release_input_frame_reservations = lambda self: None
    return selected_cls, threads, clock


class CaptureShutdownContractTest(unittest.TestCase):
    def resource(self, grab=None, close=None):
        calls = []
        resource = SimpleNamespace(monitors=[], grab=grab or (lambda _: 'pixels'),
            close=close or (lambda: calls.append('close')))
        return resource, calls

    def test_worker_stop_and_fatal_exception_close_in_actual_finally(self):
        class Fatal(BaseException):
            pass
        for fatal in (False, True):
            with self.subTest(fatal=fatal):
                resource, calls = self.resource()
                cls, threads, _ = extracted_track(resource)
                track = cls()
                def grab(_):
                    if fatal:
                        raise Fatal()
                    track._capture_running = False
                    return 'late'
                resource.grab = grab
                if fatal:
                    with self.assertRaises(Fatal):
                        track._capture_loop()
                else:
                    track._capture_loop()
                self.assertEqual(calls, ['close'])
                self.assertEqual(track.resource_snapshot()['captureCloseState'], 'closed')
                self.assertIsNone(track._capture_buffer)
                # The owner cannot close or lend the resource a second time.
                track._capture_loop()
                self.assertEqual(calls, ['close'])

    def test_loop_claim_lock_only_at_entry_and_closure_not_grab_or_reader(self):
        resource, calls = self.resource()
        cls, _, _ = extracted_track(resource)
        track = cls()
        claims = []
        class ClaimLock(Guard):
            def __enter__(self):
                claims.append('lock')
                return self
        track._capture_resource_owner._claim_lock = ClaimLock()
        grabs = []
        def grab(_):
            grabs.append('grab')
            self.assertEqual(claims, ['lock'])
            self.assertEqual(track.resource_snapshot()['captureCloseState'], 'worker-owned')
            return 'pixels'
        resource.grab = grab
        track._capture_loop()
        self.assertEqual(grabs, ['grab'])
        self.assertEqual(claims, ['lock', 'lock'])
        self.assertEqual(calls, ['close'])
        self.assertEqual(track._capture_seq, 1)

    def test_start_failure_stops_notifies_before_fallback_and_late_entry_is_inert(self):
        resource, calls = self.resource()
        holder = []
        def start(thread):
            holder.append(thread.target.__self__)
            raise RuntimeError('start failed')
        cls, threads, _ = extracted_track(resource, on_start=start)
        def close():
            track = holder[0]
            self.assertFalse(track._capture_running)
            self.assertEqual(track._activity_condition.notifications, 1)
            self.assertEqual(track._capture_generation, 1)
            calls.append('close')
        resource.close = close
        resource.grab = lambda _: self.fail('late entry grabbed closed resource')
        with self.assertRaisesRegex(RuntimeError, 'start failed'):
            cls()
        track = holder[0]
        self.assertEqual(calls, ['close'])
        self.assertEqual(track.resource_snapshot()['captureCloseState'], 'closed')
        threads[0].target()
        self.assertEqual(calls, ['close'])
        self.assertEqual(track._process_executor.calls, [False])
        self.assertTrue(track.resource_snapshot()['executorShutdownRequested'])

    def test_start_failure_does_not_take_already_claimed_worker_resource(self):
        resource, calls = self.resource()
        holder = []
        def start(thread):
            track = thread.target.__self__
            holder.append(track)
            # Deterministic scheduling point: worker has claimed entry but its
            # continuation is held until after start reports failure.
            self.assertIs(track._capture_resource_owner.claim_worker(), resource)
            thread.alive = True
            raise RuntimeError('start failed after entry')
        cls, _, _ = extracted_track(resource, on_start=start)
        with self.assertRaisesRegex(RuntimeError, 'start failed after entry'):
            cls()
        track = holder[0]
        self.assertFalse(track._capture_running)
        self.assertEqual(calls, [])
        self.assertEqual(track.resource_snapshot()['captureCloseState'], 'worker-owned')
        track._capture_resource_owner.close_worker()  # Release held worker finally.
        self.assertEqual(calls, ['close'])

    def test_shutdown_during_grab_joins_2s_without_closing_then_worker_closes(self):
        resource, calls = self.resource()
        held = SimpleNamespace(active=False, grabs=0)
        def start(thread):
            thread.alive = True
        cls, threads, _ = extracted_track(resource, on_start=start)
        track = cls()
        def grab(_):
            held.active = True
            held.grabs += 1
            try:
                track._capture_buffer = 'old'
                track._capture_bounds_ns[9] = (0, 1)
                asyncio.run(track.shutdown())
                self.assertEqual(threads[0].timeout, 2.0)
                self.assertEqual(calls, [])
                self.assertEqual(track.resource_snapshot()['captureCloseState'], 'worker-owned')
                self.assertTrue(track.resource_snapshot()['captureThreadAlive'])
                self.assertEqual(track.resource_snapshot()['captureShutdownJoin'], 'pending')
                self.assertEqual(track._process_executor.calls, [False])
                self.assertIsNone(track.sct)
                self.assertIsNone(track._capture_buffer)
                return 'late-pixels'
            finally:
                held.active = False
        def close():
            self.assertFalse(held.active, 'native close overlapped fake grab')
            self.assertEqual(held.grabs, 1)
            calls.append('close')
        resource.grab = grab
        resource.close = close
        track._capture_loop()
        threads[0].alive = False
        self.assertEqual(calls, ['close'])
        self.assertFalse(held.active)
        self.assertIsNone(track._capture_buffer)
        self.assertEqual(track._capture_bounds_ns, {})
        self.assertEqual(track._capture_seq, 0)
        self.assertEqual(track._capture_observation.snapshot(0, running=False,
            suspended=False, thread_alive=False, thread_started=True)['completed'], 1)
        self.assertEqual(track.resource_snapshot()['captureCloseState'], 'closed')
        # The prior timeout remains evidence even after eventual worker exit.
        self.assertEqual(track.resource_snapshot()['captureShutdownJoin'], 'pending')
        asyncio.run(track.shutdown())
        self.assertEqual(calls, ['close'])

    def test_join_return_error_and_cancel_report_observation_clear_and_propagate(self):
        for outcome in ('returned', 'error', 'cancelled'):
            with self.subTest(outcome=outcome):
                resource, calls = self.resource()
                async def to_thread(fn, **kwargs):
                    self.assertEqual(kwargs, {'timeout': 2.0})
                    if outcome == 'cancelled':
                        raise asyncio.CancelledError()
                    if outcome == 'error':
                        raise RuntimeError('join-secret-canary')
                    return fn(**kwargs)
                cls, threads, _ = extracted_track(resource,
                    on_start=lambda thread: setattr(thread, 'alive', True),
                    on_join=lambda thread: setattr(thread, 'alive', False), to_thread=to_thread)
                track = cls()
                track._capture_resource_owner.claim_worker()
                track._capture_buffer = 'old'
                track._capture_bounds_ns[1] = (0, 1)
                track._pending_input_ids.add('private')
                track._pending_input_data.append('private')
                track._last_img = 'pixels'
                if outcome == 'cancelled':
                    with self.assertRaises(asyncio.CancelledError):
                        asyncio.run(track.shutdown())
                else:
                    asyncio.run(track.shutdown())
                result = track.resource_snapshot()
                self.assertEqual(result['captureShutdownJoin'], 'returned' if outcome == 'returned' else 'unknown')
                self.assertEqual(result['captureThreadAlive'], outcome != 'returned')
                self.assertEqual(result['captureCloseState'], 'worker-owned')
                self.assertEqual(calls, [])
                self.assertEqual(track._process_executor.calls, [False])
                self.assertTrue(result['executorShutdownRequested'])
                self.assertIsNone(track._capture_buffer)
                self.assertEqual(track._capture_bounds_ns, {})
                self.assertEqual(track._pending_input_ids, set())
                self.assertEqual(track._pending_input_data, [])
                self.assertIsNone(track._last_img)
                track._capture_resource_owner.close_worker()
                self.assertEqual(calls, ['close'])

    def test_native_close_failure_does_not_change_grab_completion_or_pacing(self):
        def close():
            raise RuntimeError('native-close-secret-canary')
        resource, _ = self.resource(close=close)
        cls, _, clock = extracted_track(resource)
        track = cls()
        track._capture_loop()
        result = track.resource_snapshot()
        self.assertEqual(result['captureCloseState'], 'close-failed')
        self.assertEqual(track._capture_seq, 1)
        self.assertEqual(clock.sleeps, [.05])
        grab = track._capture_observation.snapshot(clock.now, running=False,
            suspended=False, thread_alive=False, thread_started=True)
        self.assertEqual((grab['completed'], grab['failed']), (1, 0))
        self.assertNotIn('canary', repr(result))

    def test_legacy_no_owner_shutdown_never_assumes_native_resource_safe_to_close(self):
        resource, calls = self.resource()
        cls, _, _ = extracted_track(resource)
        track = cls()
        del track._capture_resource_owner
        # Legacy tests can lack a native resource; an unexpected old reference
        # still must not induce caller-side close.
        for old_resource in (None, resource):
            track.sct = old_resource
            asyncio.run(track.shutdown())
            self.assertEqual(track.resource_snapshot()['captureCloseState'], 'unknown')
            self.assertEqual(calls, [])

    def test_snapshot_while_native_close_reports_closing_without_wait(self):
        resource, calls = self.resource()
        cls, _, _ = extracted_track(resource)
        track = cls()
        def close():
            result = track.resource_snapshot()
            self.assertEqual(result['captureCloseState'], 'closing')
            self.assertFalse(result['executorShutdownRequested'])
            calls.append('close')
        resource.close = close
        track._capture_running = False
        track._capture_loop()
        self.assertEqual(calls, ['close'])
        self.assertEqual(track.resource_snapshot()['captureCloseState'], 'closed')


if __name__ == '__main__':
    unittest.main()
