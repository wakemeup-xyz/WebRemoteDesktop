"""Pure scalar and AST-only capture accounting tests: no Host/native imports."""
import ast
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

from capture_cadence import CaptureCadenceObserver, unavailable_capture_cadence
from capture_resource_owner import CaptureResourceOwner

from runtime_observability import (
    CaptureObservation, RuntimeObservability, unavailable_capture_observation,
)


KEYS = {'scope', 'state', 'attempted', 'completed', 'failed', 'currentGrabAgeMs',
        'lastCompletionAgeMs', 'lastDurationMs', 'maxDurationMs', 'clipped',
        'lastThreadCpuMs', 'lastNonCpuMs', 'maxDurationThreadCpuMs',
        'maxDurationNonCpuMs'}
FLAGS = dict(running=True, suspended=False, thread_alive=True, thread_started=True)
CAP = 999_999_999
NS_CAP = 3_600_000_000_000


def snapshot(observer, now=0, **flags):
    return observer.snapshot(now, **(FLAGS | flags))


def method(class_name, method_name, **namespace):
    tree = ast.parse(Path(__file__).with_name('host.py').read_text())
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == class_name)
    selected = next(node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == method_name)
    exec(compile(ast.Module(body=[selected], type_ignores=[]), '<AST capture only>', 'exec'), namespace)
    return namespace[method_name]


class CaptureObservationTest(unittest.TestCase):
    def test_wall_and_thread_cpu_pairs_share_one_completed_grab(self):
        observer = CaptureObservation()
        observer.begin(1_000_000, thread_cpu_ns=5_000_000)
        observer.finish(11_000_000, succeeded=True, thread_cpu_ns=8_000_000)
        result = snapshot(observer, 11_000_000)
        self.assertEqual((result['lastDurationMs'], result['lastThreadCpuMs'], result['lastNonCpuMs']),
                         (10, 3, 7))
        self.assertEqual((result['maxDurationMs'], result['maxDurationThreadCpuMs'],
                          result['maxDurationNonCpuMs']), (10, 3, 7))
        observer.begin(20_000_000, thread_cpu_ns=8_000_000)
        self.assertEqual(snapshot(observer, 21_000_000)['lastThreadCpuMs'], 3)
        observer.finish(25_000_000, succeeded=False, thread_cpu_ns=12_000_000)
        result = snapshot(observer, 25_000_000)
        self.assertEqual((result['lastThreadCpuMs'], result['lastNonCpuMs']), (4, 1))
        self.assertEqual((result['maxDurationThreadCpuMs'], result['maxDurationNonCpuMs']), (3, 7))
        observer.begin(30_000_000)
        observer.finish(40_000_000, succeeded=True)
        result = snapshot(observer, 40_000_000)
        self.assertEqual((result['lastThreadCpuMs'], result['lastNonCpuMs']), (None, None))
        self.assertEqual((result['maxDurationThreadCpuMs'], result['maxDurationNonCpuMs']), (3, 7))

    def test_invalid_cpu_pair_never_changes_wall_or_carries_previous_pair(self):
        invalid_cases = ((None, 1), (0, None), (True, 1), (0, False), (-1, 1),
                         (0, -1), (1.5, 2), (0, 'secret-canary'), (object(), 1),
                         (2, 1), (0, 12))
        for cpu_start, cpu_end in invalid_cases:
            with self.subTest(cpu_start=cpu_start, cpu_end=cpu_end):
                observer = CaptureObservation()
                observer.begin(0, thread_cpu_ns=0)
                observer.finish(1, succeeded=True, thread_cpu_ns=0)
                observer.begin(10, thread_cpu_ns=cpu_start)
                observer.finish(20, succeeded=False, thread_cpu_ns=cpu_end)
                result = snapshot(observer, 20)
                self.assertEqual((result['attempted'], result['completed'], result['failed']), (2, 1, 1))
                self.assertEqual(result['lastDurationMs'], 0)
                self.assertEqual((result['lastThreadCpuMs'], result['lastNonCpuMs']), (None, None))
                self.assertFalse(result['clipped'])
                self.assertNotIn('secret-canary', repr(observer._state) + json.dumps(result))
        observer = CaptureObservation()
        observer.begin(0, thread_cpu_ns=0)
        observer.finish(0, succeeded=True, thread_cpu_ns=0)
        result = snapshot(observer, 0)
        self.assertEqual((result['lastThreadCpuMs'], result['lastNonCpuMs']), (0, 0))
        observer.begin(10, thread_cpu_ns=10)
        observer.finish(9, succeeded=True, thread_cpu_ns=10)
        result = snapshot(observer, 10)
        self.assertIsNone(result['lastDurationMs'])
        self.assertEqual((result['lastThreadCpuMs'], result['lastNonCpuMs']), (None, None))

    def test_max_companion_follows_raw_wall_ties_and_cap(self):
        observer = CaptureObservation()
        observer.begin(0, thread_cpu_ns=0)
        observer.finish(10_000_000, succeeded=True, thread_cpu_ns=2_000_000)
        observer.begin(20_000_000, thread_cpu_ns=2_000_000)
        observer.finish(25_000_000, succeeded=True, thread_cpu_ns=6_000_000)
        observer.begin(30_000_000, thread_cpu_ns=6_000_000)
        observer.finish(40_000_000, succeeded=False, thread_cpu_ns=7_000_000)
        result = snapshot(observer, 40_000_000)
        self.assertEqual((result['maxDurationMs'], result['maxDurationThreadCpuMs'],
                          result['maxDurationNonCpuMs']), (10, 2, 8))
        observer.begin(50_000_000)
        observer.finish(61_000_000, succeeded=False)
        result = snapshot(observer, 61_000_000)
        self.assertEqual(result['maxDurationMs'], 11)
        self.assertEqual((result['maxDurationThreadCpuMs'], result['maxDurationNonCpuMs']), (None, None))
        capped = CaptureObservation()
        capped.begin(0, thread_cpu_ns=0)
        capped.finish(NS_CAP, succeeded=True, thread_cpu_ns=1_000_000)
        self.assertEqual(snapshot(capped, NS_CAP)['maxDurationThreadCpuMs'], 1)
        capped.begin(0, thread_cpu_ns=0)
        capped.finish(NS_CAP + 1, succeeded=False, thread_cpu_ns=1_000_000)
        result = snapshot(capped, NS_CAP + 1)
        self.assertEqual(result['maxDurationMs'], 3_600_000)
        self.assertEqual((result['lastThreadCpuMs'], result['lastNonCpuMs'],
                          result['maxDurationThreadCpuMs'], result['maxDurationNonCpuMs']),
                         (None, None, None, None))
        self.assertTrue(result['clipped'])
        capped.begin(0, thread_cpu_ns=0)
        capped.finish(NS_CAP, succeeded=True, thread_cpu_ns=2_000_000)
        self.assertEqual(snapshot(capped, NS_CAP)['maxDurationThreadCpuMs'], None)

    def test_initialized_zero_and_unavailable_are_distinct_fixed_schemas(self):
        result = snapshot(CaptureObservation())
        missing = unavailable_capture_observation()
        self.assertEqual(set(result), KEYS)
        self.assertEqual(set(missing), KEYS | {'cadence'})
        self.assertEqual(result['scope'], 'track-lifetime')
        self.assertEqual(result['state'], 'starting')
        self.assertEqual([result[key] for key in ('attempted', 'completed', 'failed')], [0, 0, 0])
        self.assertEqual(missing['state'], 'unavailable')
        self.assertEqual(missing['cadence'], unavailable_capture_cadence())
        self.assertFalse(missing['clipped'])
        self.assertTrue(all(missing[key] is None for key in KEYS - {'scope', 'state', 'clipped'}))
        missing['attempted'] = 99
        self.assertIsNone(unavailable_capture_observation()['attempted'])

    def test_success_failure_and_active_age_are_independent_of_completion(self):
        observer = CaptureObservation()
        observer.begin(0)
        active = snapshot(observer, 2_000_000_000)
        self.assertEqual(active['state'], 'grabbing')
        self.assertEqual(active['currentGrabAgeMs'], 2000)
        self.assertIsNone(active['lastDurationMs'])
        self.assertIsNone(active['maxDurationMs'])
        observer.finish(3_000_000_000, succeeded=True)
        observer.begin(4_000_000_000)
        observer.finish(8_000_000_000, succeeded=False)
        result = snapshot(observer, 9_000_000_000)
        self.assertEqual(result['state'], 'error')
        self.assertEqual((result['attempted'], result['completed'], result['failed']), (2, 1, 1))
        self.assertEqual(result['lastCompletionAgeMs'], 6000)
        self.assertEqual(result['lastDurationMs'], 4000)
        self.assertEqual(result['maxDurationMs'], 4000)
        observer.begin(10_000_000_000)
        self.assertEqual(snapshot(observer, 10_000_000_000)['state'], 'grabbing')
        observer.finish(10_000_001_234, succeeded=True)
        self.assertEqual(snapshot(observer, 10_000_002_468)['lastDurationMs'], .001)
        self.assertEqual(snapshot(observer, 10_000_002_468)['lastCompletionAgeMs'], .001)

    def test_lifecycle_precedence_preserves_unfinished_evidence(self):
        observer = CaptureObservation()
        observer.begin(0)
        for flags, expected in [({'suspended': True}, 'suspended'),
                ({'running': False, 'suspended': True}, 'stopping'),
                ({'thread_alive': False}, 'stopped'),
                ({'thread_alive': False, 'thread_started': False}, 'starting')]:
            result = snapshot(observer, 1_000_000, **flags)
            self.assertEqual(result['state'], expected)
            self.assertEqual(result['currentGrabAgeMs'], 1)
            self.assertEqual((result['completed'], result['failed']), (0, 0))
        observer.finish(2_000_000, succeeded=True)
        self.assertEqual(snapshot(observer, 3_000_000)['state'], 'idle')
        self.assertEqual(snapshot(CaptureObservation())['attempted'], 0)

    def test_invalid_start_still_publishes_inflight_without_retaining_objects(self):
        for invalid in (None, False, True, -1, 1.5, 'secret-canary', object()):
            observer = CaptureObservation()
            observer.begin(invalid)
            result = snapshot(observer, 10)
            self.assertEqual(result['state'], 'grabbing')
            self.assertEqual(result['attempted'], 1)
            self.assertIsNone(result['currentGrabAgeMs'])
            self.assertNotIn('secret-canary', repr(observer._state))
            observer.finish(20, succeeded=False)
            result = snapshot(observer, 30)
            self.assertEqual(result['failed'], 1)
            self.assertIsNone(result['lastDurationMs'])

    def test_invalid_finish_counts_outcome_and_preserves_valid_max(self):
        for invalid in (None, False, True, -1, 1.5, 'secret-canary', object()):
            observer = CaptureObservation()
            observer.begin(0)
            observer.finish(2_000_000, succeeded=True)
            observer.begin(3_000_000)
            observer.finish(invalid, succeeded=True)
            result = snapshot(observer, 4_000_000)
            self.assertEqual(result['completed'], 2)
            self.assertIsNone(result['lastDurationMs'])
            self.assertIsNone(result['lastCompletionAgeMs'])
            self.assertEqual(result['maxDurationMs'], 2)
            self.assertNotIn('secret-canary', repr(observer._state))

    def test_backward_and_invalid_read_clocks_do_not_manufacture_zero(self):
        observer = CaptureObservation()
        observer.begin(100)
        for invalid in (None, False, True, -1, 1.5, 'secret-canary', 99):
            self.assertIsNone(snapshot(observer, invalid)['currentGrabAgeMs'])
        observer.finish(99, succeeded=False)
        result = snapshot(observer, 200)
        self.assertIsNone(result['lastDurationMs'])
        self.assertEqual(result['failed'], 1)
        observer.begin(200)
        observer.finish(300, succeeded=True)
        self.assertIsNone(snapshot(observer, 299)['lastCompletionAgeMs'])
        self.assertEqual(snapshot(observer, 300)['lastCompletionAgeMs'], 0)

    def test_zero_duration_and_backward_success_clear_latest_success_age(self):
        observer = CaptureObservation()
        observer.begin(0)
        observer.finish(0, succeeded=True)
        result = snapshot(observer, 0)
        self.assertEqual(result['lastDurationMs'], 0)
        self.assertEqual(result['maxDurationMs'], 0)
        self.assertEqual(result['lastCompletionAgeMs'], 0)
        observer.begin(2_000_000)
        observer.finish(1_000_000, succeeded=True)
        result = snapshot(observer, 3_000_000)
        self.assertEqual(result['completed'], 2)
        self.assertIsNone(result['lastDurationMs'])
        self.assertIsNone(result['lastCompletionAgeMs'])
        self.assertEqual(result['maxDurationMs'], 0)

    def test_invalid_failed_finish_keeps_prior_success_and_valid_max(self):
        observer = CaptureObservation()
        observer.begin(0)
        observer.finish(2_000_000, succeeded=True)
        observer.begin(3_000_000)
        observer.finish(None, succeeded=False)
        result = snapshot(observer, 4_000_000)
        self.assertEqual(result['lastCompletionAgeMs'], 2)
        self.assertEqual(result['maxDurationMs'], 2)
        self.assertIsNone(result['lastDurationMs'])
        self.assertEqual(result['failed'], 1)

    def test_saturation_bounded_integers_and_sticky_writer_clipping(self):
        observer = CaptureObservation()
        observer._state = observer._state._replace(attempted=CAP, completed=CAP)
        observer.begin(0)
        observer.finish(10 ** 1000, succeeded=True)
        result = snapshot(observer, 10 ** 1001)
        self.assertEqual(result['attempted'], CAP)
        self.assertEqual(result['completed'], CAP)
        self.assertEqual(result['maxDurationMs'], 3_600_000)
        self.assertEqual(result['lastDurationMs'], 3_600_000)
        self.assertEqual(result['lastCompletionAgeMs'], 3_600_000)
        self.assertTrue(result['clipped'])
        observer.begin(0)
        observer.finish(1, succeeded=False)
        self.assertTrue(snapshot(observer)['clipped'])
        observer._state = observer._state._replace(failed=CAP)
        observer.begin(0)
        observer.finish(1, succeeded=False)
        self.assertEqual(snapshot(observer)['failed'], CAP)

    def test_age_clipping_is_read_only_and_exact_cap_does_not_clip(self):
        observer = CaptureObservation()
        observer.begin(0)
        state = observer._state
        self.assertFalse(snapshot(observer, NS_CAP)['clipped'])
        self.assertTrue(snapshot(observer, NS_CAP + 1)['clipped'])
        self.assertIs(observer._state, state)
        self.assertFalse(snapshot(observer, 0)['clipped'])
        observer.finish(NS_CAP, succeeded=True)
        self.assertFalse(snapshot(observer, NS_CAP)['clipped'])

    def test_repeated_reads_fixed_storage_and_unsaturated_invariant(self):
        observer = CaptureObservation()
        width = len(observer._state)
        for i in range(1000):
            observer.begin(i * 10)
            result = snapshot(observer, i * 10)
            self.assertEqual(result['attempted'], result['completed'] + result['failed'] + 1)
            observer.finish(i * 10 + 1, succeeded=i % 2 == 0)
            result = snapshot(observer, i * 10 + 2)
            self.assertEqual(result['attempted'], result['completed'] + result['failed'])
        state = observer._state
        first = snapshot(observer, 10000)
        first['attempted'] = 'mutated'
        self.assertIs(observer._state, state)
        self.assertEqual(snapshot(observer, 10000)['attempted'], 1000)
        self.assertIsInstance(state, tuple)
        self.assertEqual(len(state), width)
        self.assertTrue(all(value is None or type(value) in (int, bool) for value in state))
        self.assertEqual(set(json.loads(json.dumps(snapshot(observer)))), KEYS)

    def test_snapshot_copies_exactly_one_published_tuple_reference(self):
        class Switching(CaptureObservation):
            reads = 0
            replacement = None
            def __getattribute__(self, name):
                value = super().__getattribute__(name)
                if name == '_state' and self.replacement is not None:
                    self.reads += 1
                    object.__setattr__(self, '_state', self.replacement)
                return value
        observer = Switching()
        observer.begin(0)
        old = observer._state
        observer.finish(1_000_000, succeeded=True)
        observer.replacement = observer._state
        observer._state = old
        result = snapshot(observer, 2_000_000)
        self.assertEqual(observer.reads, 1)
        self.assertEqual((result['attempted'], result['completed'], result['currentGrabAgeMs']), (1, 0, 2))


class Guard:
    def __init__(self, enter=None):
        self.enter = enter
        self.notifications = 0
    def __enter__(self):
        if self.enter:
            self.enter()
        return self
    def __exit__(self, *args):
        pass
    def notify_all(self):
        self.notifications += 1
    def wait(self, *, timeout):
        raise AssertionError('unexpected wait')


class CaptureLoopTest(unittest.TestCase):
    def run_loop(self, action=None, publication_error=False, gate_cancel=False, suspended=False,
                 cpu_fail_at=None):
        clock = SimpleNamespace(now=0, cpu=1_000_000, sleeps=[], events=[])
        def wall_ns():
            clock.events.append('wall')
            return clock.now
        def cpu_ns():
            clock.events.append('cpu')
            if clock.events.count('cpu') == cpu_fail_at:
                raise OSError('clock-secret-canary')
            return clock.cpu
        def sleep(delay):
            clock.sleeps.append(delay)
            clock.now += int(delay * 1_000_000_000)
            track._capture_running = False
        class ObservedCapture(CaptureObservation):
            def begin(self, *args, **kwargs):
                clock.events.append('begin')
                clock.cpu += 1_000_000
                return super().begin(*args, **kwargs)
            def finish(self, *args, **kwargs):
                clock.events.append('finish')
                return super().finish(*args, **kwargs)
        track = SimpleNamespace(_capture_running=True, _suspended=suspended,
            _target_fps=20, _capture_generation=0, _capture_strategy=None, _activity_condition=Guard(),
            _target_lock=Guard(), _capture_lock=Guard(), _capture_observation=ObservedCapture(),
            monitor=object(), _capture_buffer=None, _capture_seq=0, _capture_bounds_ns={},
            _frame_trace_context=None,
            capture_fps_for_target=lambda fps, **kwargs: fps)
        if gate_cancel:
            track._target_lock.enter = lambda: setattr(track, '_capture_running', False)
        def grab(monitor):
            clock.events.append('grab')
            self.assertIs(monitor, track.monitor)
            track.inside = snapshot(track._capture_observation, clock.now)
            clock.now = 10_000_000
            clock.cpu += 2_000_000
            if action:
                action(track)
            return 'pixels-canary'
        track.sct = SimpleNamespace(grab=grab, close=lambda: None)
        track._capture_resource_owner = CaptureResourceOwner(track.sct)
        def stop_after_discard():
            if clock.events.count('grab') and track._suspended:
                track._capture_running = False
        track._activity_condition.enter = stop_after_discard
        if publication_error:
            track._capture_lock.enter = lambda: (_ for _ in ()).throw(RuntimeError('publication-secret-canary'))
        if suspended:
            def resume(*, timeout):
                self.assertEqual(timeout, .2)
                self.assertEqual(snapshot(track._capture_observation)['attempted'], 0)
                track._suspended = False
            track._activity_condition.wait = resume
        loop = method('ScreenCaptureTrack', '_capture_loop', time=SimpleNamespace(
            monotonic_ns=wall_ns, thread_time_ns=cpu_ns, sleep=sleep))
        loop(track)
        return track, clock, snapshot(track._capture_observation, clock.now, running=False)

    def test_begin_visible_inside_grab_without_recv_and_success_keeps_pacing(self):
        track, clock, result = self.run_loop()
        self.assertEqual(track.inside['state'], 'grabbing')
        self.assertEqual(track.inside['attempted'], 1)
        self.assertEqual(track.inside['completed'], 0)
        self.assertIsNone(track.inside['lastDurationMs'])
        self.assertEqual((result['completed'], result['failed']), (1, 0))
        self.assertEqual(result['lastDurationMs'], 10)
        self.assertEqual(clock.sleeps, [.04])
        self.assertEqual(track._capture_buffer, 'pixels-canary')
        self.assertEqual(track._capture_seq, 1)
        self.assertEqual(track._capture_bounds_ns, {1: (0, 10_000_000)})
        self.assertEqual(track._activity_condition.notifications, 1)
        self.assertNotIn('canary', json.dumps(result))

    def test_real_loop_samples_current_thread_cpu_inside_wall_bracket(self):
        track, clock, result = self.run_loop()
        self.assertEqual(clock.events, ['wall', 'cpu', 'begin', 'grab', 'cpu', 'wall', 'finish', 'wall'])
        self.assertEqual((result['lastDurationMs'], result['lastThreadCpuMs'], result['lastNonCpuMs']),
                         (10, 3, 7))
        self.assertEqual((result['maxDurationThreadCpuMs'], result['maxDurationNonCpuMs']), (3, 7))
        self.assertEqual(track._capture_bounds_ns, {1: (0, 10_000_000)})
        self.assertEqual(clock.sleeps, [.04])

    def test_cpu_clock_exception_does_not_prevent_grab_or_failed_grab_settlement(self):
        for at in (1, 2):
            with self.subTest(at=at):
                track, clock, result = self.run_loop(cpu_fail_at=at)
                self.assertEqual(clock.events.count('grab'), 1)
                self.assertEqual(clock.events.count('cpu'), 2)
                self.assertEqual((result['completed'], result['failed']), (1, 0))
                self.assertEqual((result['lastThreadCpuMs'], result['lastNonCpuMs']), (None, None))
                self.assertEqual(clock.sleeps, [.04])
                self.assertNotIn('clock-secret-canary', json.dumps(result))
        def fail(_):
            raise RuntimeError('grab-secret-canary')
        _, clock, result = self.run_loop(fail, cpu_fail_at=2)
        self.assertEqual(clock.events[:7], ['wall', 'cpu', 'begin', 'grab', 'cpu', 'wall', 'finish'])
        self.assertEqual((result['attempted'], result['completed'], result['failed']), (1, 0, 1))
        self.assertEqual(clock.sleeps, [.005])


    def test_grab_exception_counts_failure_only_and_keeps_existing_retry(self):
        def fail(track):
            raise RuntimeError('native-secret-canary')
        track, clock, result = self.run_loop(fail)
        self.assertEqual((result['attempted'], result['completed'], result['failed']), (1, 0, 1))
        self.assertEqual(result['lastDurationMs'], 10)
        self.assertEqual((result['lastThreadCpuMs'], result['lastNonCpuMs']), (3, 7))
        self.assertEqual(clock.sleeps, [.005])
        self.assertEqual(track._capture_seq, 0)
        self.assertIsNone(track._capture_buffer)
        self.assertNotIn('canary', json.dumps(result))

    def test_publication_exception_does_not_reclassify_success(self):
        track, clock, result = self.run_loop(publication_error=True)
        self.assertEqual((result['attempted'], result['completed'], result['failed']), (1, 1, 0))
        self.assertEqual(clock.sleeps, [.005])
        self.assertEqual(track._capture_seq, 0)

    def test_fatal_grab_interruption_does_not_forge_settlement(self):
        class Fatal(BaseException):
            pass
        captured = []
        def interrupt(track):
            captured.append(track)
            raise Fatal()
        with self.assertRaises(Fatal):
            self.run_loop(interrupt)
        result = snapshot(captured[0]._capture_observation, 20_000_000, running=False,
                          thread_alive=False)
        self.assertEqual(result['state'], 'stopped')
        self.assertEqual((result['attempted'], result['completed'], result['failed']), (1, 0, 0))
        self.assertEqual(result['currentGrabAgeMs'], 20)

    def test_suspension_inside_grab_keeps_completion_and_original_discard(self):
        track, clock, result = self.run_loop(lambda track: setattr(track, '_suspended', True))
        self.assertEqual(result['completed'], 1)
        self.assertEqual(track._capture_seq, 0)
        self.assertIsNone(track._capture_buffer)
        self.assertEqual(clock.sleeps, [])
        self.assertEqual(track._activity_condition.notifications, 0)

    def test_stop_inside_grab_keeps_completion_and_discards_publication(self):
        track, clock, result = self.run_loop(lambda track: setattr(track, '_capture_running', False))
        self.assertFalse(track._capture_running)
        self.assertEqual(result['completed'], 1)
        self.assertEqual(track._capture_seq, 0)
        self.assertIsNone(track._capture_buffer)
        self.assertEqual(track._capture_bounds_ns, {})
        self.assertEqual(clock.sleeps, [])

    def test_stop_before_final_gate_does_not_count_attempt(self):
        track, clock, result = self.run_loop(gate_cancel=True)
        self.assertEqual(result['attempted'], 0)
        self.assertEqual(clock.events.count('cpu'), 0)
        self.assertEqual(clock.sleeps, [])
        self.assertEqual(track._capture_seq, 0)

    def test_idle_suspend_wait_does_not_count_until_resumed(self):
        track, clock, result = self.run_loop(suspended=True)
        self.assertEqual(result['attempted'], 1)
        self.assertEqual(result['completed'], 1)

    def test_immediate_thread_start_publishes_and_keeps_trace_count(self):
        clock = SimpleNamespace(now=0, sleeps=[])
        track_holder = []
        class ImmediateThread:
            ident = 1
            def __init__(self, *, target, daemon):
                self.target = target
                track_holder.append(target.__self__)
            def start(self):
                self.target()
        def sleep(delay):
            clock.sleeps.append(delay)
            clock.now += int(delay * 1_000_000_000)
            track_holder[0]._capture_running = False
        def grab(_):
            clock.now = 10_000_000
            return 'pixels'
        tree = ast.parse(Path(__file__).with_name('host.py').read_text())
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'ScreenCaptureTrack')
        names = {'__init__', '_capture_loop', '_increment_trace_interval'}
        selected = ast.ClassDef(name='ScreenCaptureTrack', bases=[ast.Name(id='VideoStreamTrack', ctx=ast.Load())],
            keywords=[], body=[n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name in names], decorator_list=[])
        namespace = dict(VideoStreamTrack=type('Base', (), {}), CaptureExperiment=type('Experiment', (), {}),
            MSS=lambda: SimpleNamespace(monitors=[], grab=grab, close=lambda: None),
            select_capture_monitor=lambda *a, **k: {}, get_screeninfo_monitors=lambda: [],
            RtpFrameClock=lambda: None, HAS_CV2=False,
            threading=SimpleNamespace(Lock=Guard, Condition=Guard, Thread=ImmediateThread),
            ThreadPoolExecutor=lambda **k: None, CaptureObservation=CaptureObservation,
            CaptureResourceOwner=CaptureResourceOwner,
            time=SimpleNamespace(monotonic=lambda: 0, monotonic_ns=lambda: clock.now,
                thread_time_ns=lambda: 0, process_time_ns=lambda: 0, time=lambda: 0, sleep=sleep),
            logger=SimpleNamespace(info=lambda *a, **k: None))
        # The optional pure cadence class exists only after its capability is implemented.
        try:
            from capture_cadence import CaptureCadenceObserver
            namespace['CaptureCadenceObserver'] = CaptureCadenceObserver
        except ImportError:
            pass
        exec(compile(ast.fix_missing_locations(ast.Module(body=[selected], type_ignores=[])),
            '<AST immediate capture>', 'exec'), namespace)
        cls = namespace['ScreenCaptureTrack']
        cls.capture_fps_for_target = staticmethod(lambda fps, **k: fps)
        track = cls(frame_trace_context=object())
        self.assertEqual(track._capture_seq, 1)
        self.assertEqual(track._activity_condition.notifications, 1)
        self.assertEqual(track._trace_interval['captures'], 1)
        self.assertEqual(clock.sleeps, [.04])
        self.assertEqual(snapshot(track._capture_observation, clock.now)['completed'], 1)

    def run_cadence_loop(self, grabs, *, oversleep_ns=0, config_ns=0, observer=None,
                         fail_grab_at=None, fail_publish_at=None, suspend_at=None, profile_at=None, fps=20, fail_trace_at=None, cadence_start_cost_ns=0):
        clock = SimpleNamespace(now=0, cpu=0, sleeps=[], calls=0, lock_calls=0, config_calls=0)
        class CostedCadence(CaptureCadenceObserver):
            def start(self, *args, **kwargs):
                clock.now += cadence_start_cost_ns
                clock.cpu += cadence_start_cost_ns
                return super().start(*args, **kwargs)
        cadence = observer if observer is not None else CostedCadence()
        track = SimpleNamespace(_capture_running=True, _suspended=False, _target_fps=fps,
            _capture_strategy=None, _activity_condition=Guard(), _target_lock=Guard(),
            _capture_lock=Guard(), _capture_observation=CaptureObservation(),
            _capture_cadence=cadence, _capture_generation=0, _target_generation=0,
            monitor=None, _capture_buffer=None, _capture_seq=0, _capture_bounds_ns={},
            _frame_trace_context=None, capture_fps_for_target=lambda fps, **k: fps)
        def target_config():
            clock.config_calls += 1
            if clock.config_calls > 1:
                clock.now += config_ns
            if clock.calls == len(grabs):
                track._capture_running = False
        track._target_lock.enter = target_config
        if fail_trace_at is not None:
            track._frame_trace_context = object()
            def trace(**kwargs):
                if clock.calls == fail_trace_at:
                    raise RuntimeError('trace-canary')
            track._increment_trace_interval = trace
        def publish():
            clock.lock_calls += 1
            if clock.lock_calls == fail_publish_at:
                raise RuntimeError('publication-canary')
        track._capture_lock.enter = publish
        def grab(_):
            clock.calls += 1
            clock.now += grabs[clock.calls - 1]
            clock.cpu += grabs[clock.calls - 1]
            if clock.calls == suspend_at:
                # A full pause/resume crossing must break cadence even if the
                # next admitted grab sees active state again.
                track._capture_generation += 2
            if clock.calls == profile_at:
                track._target_generation += 1
            if clock.calls == fail_grab_at:
                raise RuntimeError('grab-canary')
            return 'pixels'
        def sleep(delay):
            clock.sleeps.append(delay)
            clock.now += int(delay * 1_000_000_000) + (oversleep_ns if delay != .005 else 0)
        track.sct = SimpleNamespace(grab=grab, close=lambda: None)
        track._capture_resource_owner = CaptureResourceOwner(track.sct)
        loop = method('ScreenCaptureTrack', '_capture_loop', time=SimpleNamespace(
            monotonic_ns=lambda: clock.now, thread_time_ns=lambda: clock.cpu, sleep=sleep))
        loop(track)
        return track, clock, cadence.snapshot(clock.now) if isinstance(cadence, CaptureCadenceObserver) else None

    def test_cadence_bookkeeping_cpu_is_outside_paired_native_grab_measurement(self):
        track, clock, result = self.run_cadence_loop([10_000_000] * 2,
            cadence_start_cost_ns=7_000_000)
        grab = snapshot(track._capture_observation, clock.now)
        self.assertEqual((grab['lastDurationMs'], grab['lastThreadCpuMs'], grab['lastNonCpuMs']),
                         (10, 10, 0))
        self.assertEqual((grab['maxDurationMs'], grab['maxDurationThreadCpuMs'],
                          grab['maxDurationNonCpuMs']), (10, 10, 0))
        self.assertEqual(result['intervalCount'], 1)
        self.assertEqual(result['lastInterval'], dict(intervalMs=50, grabMs=10,
            postGrabMs=7, pacingActualMs=33, otherMs=0, minIntervalMs=50,
            pacingRequestedMs=33, pacingExcessMs=0, publishLockWaitMs=0, publishCriticalMs=0))
        self.assertEqual(result['invalidTiming'], 0)
        self.assertEqual(clock.sleeps, [.033, .033])

    def test_deferred_cadence_start_closes_previous_cycle_before_failed_grab_break(self):
        track, clock, result = self.run_cadence_loop([10_000_000] * 3,
            cadence_start_cost_ns=7_000_000, fail_grab_at=2)
        self.assertEqual(result['intervalCount'], 1)
        self.assertEqual(result['lastInterval']['grabMs'], 10)
        self.assertEqual(result['lastInterval']['postGrabMs'], 7)
        self.assertEqual(result['lastInterval']['intervalMs'], 50)
        self.assertEqual(result['error'], 1)
        self.assertEqual(result['invalidTiming'], 0)
        self.assertEqual(clock.sleeps, [.033, .005, .033])
        grab = snapshot(track._capture_observation, clock.now)
        self.assertEqual((grab['completed'], grab['failed']), (2, 1))
        self.assertEqual((grab['lastDurationMs'], grab['lastThreadCpuMs'], grab['lastNonCpuMs']),
                         (10, 10, 0))

    def test_real_loop_closed_cycles_oversleep_and_lock_subsets(self):
        track, clock, result = self.run_cadence_loop([10_000_000] * 3,
            oversleep_ns=5_000_000, config_ns=5_000_000)
        self.assertEqual(clock.sleeps, [.04] * 3)
        self.assertEqual(result['intervalCount'], 2)
        self.assertEqual(result['lastInterval'], dict(intervalMs=60, grabMs=10,
            postGrabMs=0, pacingActualMs=45, otherMs=5, minIntervalMs=50,
            pacingRequestedMs=40, pacingExcessMs=5, publishLockWaitMs=0, publishCriticalMs=0))
        self.assertEqual(result['published'], 3)
        self.assertEqual(track._capture_seq, 3)
        self.assertEqual(track._activity_condition.notifications, 3)

    def test_real_loop_slow_grab_and_exact_1ms_keep_original_no_sleep(self):
        for duration, fps in ((60_000_000, 20), (0, 1000)):
            with self.subTest(duration=duration, fps=fps):
                _, clock, result = self.run_cadence_loop([duration] * 2, fps=fps)
                self.assertEqual(clock.sleeps, [])
                self.assertEqual(result['intervalCount'], 1)
                pair = result['lastInterval']
                self.assertEqual(pair['grabMs'], duration / 1_000_000)
                self.assertEqual(pair['pacingActualMs'], 0)
                self.assertEqual(pair['pacingRequestedMs'], 0)
                self.assertEqual(pair['pacingExcessMs'], 0)

    def test_original_float_subtraction_near_1ms_is_preserved(self):
        _, clock, result = self.run_cadence_loop([49_000_000] * 2)
        self.assertEqual(clock.sleeps, [0.05 - 0.049] * 2)
        self.assertGreater(clock.sleeps[0], .001)
        self.assertEqual(result['lastInterval']['pacingRequestedMs'], 1)

    def test_real_loop_retry_error_and_publish_error_exclude_intervals(self):
        for option, expected_completed, expected_failed in (
                ('fail_grab_at', 2, 1), ('fail_publish_at', 3, 0)):
            with self.subTest(option=option):
                track, clock, result = self.run_cadence_loop([10_000_000] * 3, **{option: 1})
                self.assertEqual(clock.sleeps, [.005, .04, .04])
                self.assertEqual(result['intervalCount'], 1)
                self.assertEqual(result['error'], 1)
                self.assertEqual(result['published'], 2)
                grabs = snapshot(track._capture_observation, clock.now)
                self.assertEqual((grabs['completed'], grabs['failed']), (expected_completed, expected_failed))

    def test_trace_failure_after_publication_keeps_actual_published_count(self):
        track, clock, result = self.run_cadence_loop([10_000_000] * 3, fail_trace_at=1)
        self.assertEqual(clock.sleeps, [.005, .04, .04])
        self.assertEqual(track._capture_seq, 3)
        self.assertEqual(result['published'], 3)
        self.assertEqual(result['error'], 1)
        self.assertEqual(result['intervalCount'], 1)
        self.assertEqual(snapshot(track._capture_observation, clock.now)['completed'], 3)

    def test_real_loop_pause_resume_and_profile_generation_changes_break_pairs(self):
        for option in ('suspend_at', 'profile_at'):
            with self.subTest(option=option):
                _, clock, result = self.run_cadence_loop([10_000_000] * 3, **{option: 1})
                self.assertEqual(clock.sleeps, [.04] * (2 if option == 'suspend_at' else 3))
                self.assertEqual(result['intervalCount'], 1)
                self.assertEqual(result['discontinuous'], 2)  # Discard/mismatch plus final stop.
                self.assertEqual(result['discarded'], 1 if option == 'suspend_at' else 0)
                self.assertEqual(result['published'], 2 if option == 'suspend_at' else 3)

    def test_observation_failures_cannot_add_error_retry_or_block_publication(self):
        class Broken:
            def __getattr__(self, name):
                raise RuntimeError('observer-canary')
        track, clock, _ = self.run_cadence_loop([10_000_000] * 2, observer=Broken())
        self.assertEqual(track._capture_seq, 2)
        self.assertEqual(track._activity_condition.notifications, 2)
        self.assertEqual(clock.sleeps, [.04, .04])

    def test_observer_initialized_before_thread_creation_and_start(self):
        tree = ast.parse(Path(__file__).with_name('host.py').read_text())
        cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'ScreenCaptureTrack')
        init = next(node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == '__init__')
        assignments = {node.targets[0].attr: node.lineno for node in init.body
            if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Attribute)}
        self.assertLess(assignments['_capture_observation'], assignments['_capture_thread'])


class CaptureAdapterTest(unittest.TestCase):
    def test_track_adapter_only_reads_flags_and_never_resets(self):
        calls = []
        reader = method('ScreenCaptureTrack', 'capture_observation_snapshot',
            unavailable_capture_observation=unavailable_capture_observation,
            unavailable_capture_cadence=unavailable_capture_cadence)
        self.assertEqual(reader(SimpleNamespace(), 0), unavailable_capture_observation())
        thread = SimpleNamespace(ident=None, is_alive=lambda: False)
        track = SimpleNamespace(_capture_observation=SimpleNamespace(snapshot=lambda *a, **k: calls.append((a, k)) or {}),
            _capture_running=True, _suspended=False, _capture_thread=thread)
        self.assertEqual(reader(track, 0), {'cadence': unavailable_capture_cadence()})
        self.assertEqual(calls, [((0,), dict(running=True, suspended=False, thread_alive=False, thread_started=False))])
        thread.ident = 12345
        thread.is_alive = lambda: True
        reader(track, 1)
        self.assertTrue(calls[-1][1]['thread_started'])
        self.assertNotIn('12345', repr(calls))

    def test_track_adapter_cadence_is_selected_once_or_unavailable(self):
        reader = method('ScreenCaptureTrack', 'capture_observation_snapshot',
            unavailable_capture_observation=unavailable_capture_observation,
            unavailable_capture_cadence=unavailable_capture_cadence)
        calls = []
        cadence = CaptureCadenceObserver()
        class Selected:
            _capture_observation = CaptureObservation()
            _capture_running = True
            _suspended = False
            _capture_thread = None
            @property
            def _capture_cadence(self):
                calls.append('selected')
                return cadence
        result = reader(Selected(), 0)
        self.assertEqual(calls, ['selected'])
        self.assertEqual(result['cadence']['intervalCount'], 0)
        result['cadence']['stages']['grab']['count'] = 99
        self.assertEqual(reader(Selected(), 0)['cadence']['stages']['grab']['count'], 0)
        failing = SimpleNamespace(_capture_observation=CaptureObservation(),
            _capture_cadence=SimpleNamespace(snapshot=lambda _: (_ for _ in ()).throw(ValueError('canary'))))
        self.assertEqual(reader(failing, 0)['cadence'], unavailable_capture_cadence())

    def test_track_adapter_exposes_fresh_capture_and_reuse_evidence(self):
        reader = method('ScreenCaptureTrack', 'capture_observation_snapshot',
            unavailable_capture_observation=unavailable_capture_observation,
            unavailable_capture_cadence=unavailable_capture_cadence)
        track = SimpleNamespace(
            _capture_observation=CaptureObservation(), _capture_running=True, _suspended=False,
            _capture_thread=None, _capture_cadence=None,
            _last_fresh_capture_ns=1_000_000_000, _fresh_capture_count=12,
            _output_count=20, _reused_output_count=8, _reuse_count=3,
        )
        freshness = reader(track, 2_000_000_000)['freshness']
        self.assertEqual(freshness, {
            'freshCaptureCount': 12, 'outputCount': 20, 'reusedOutputCount': 8,
            'reuseRatio': .4, 'lastFreshCaptureAgeMs': 1000, 'consecutiveReuseCount': 3,
        })

    def test_context_current_track_once_missing_legacy_throw_and_replacement(self):
        context = method('WebRemoteHost', 'build_event_loop_lag_context',
            RuntimeObservability=RuntimeObservability,
            unavailable_capture_observation=unavailable_capture_observation,
            resource=SimpleNamespace(RUSAGE_SELF=0, getrusage=lambda _: SimpleNamespace(ru_utime=1, ru_stime=2)),
            time=SimpleNamespace(monotonic_ns=lambda: 123, perf_counter=lambda: 1),
            os=SimpleNamespace(getloadavg=lambda: (0, 0, 0)), threading=SimpleNamespace(active_count=lambda: 1))
        calls = []
        class Host:
            selected = None
            reads = 0
            @property
            def screen_track(self):
                self.reads += 1
                return self.selected
        host = Host()
        def read():
            before = host.reads
            result = context(host, lag_ms=0, sample_count=1, max_lag_ms=0, task_count=0)
            self.assertEqual(host.reads - before, 1)
            self.assertNotIn('capture', result['queues'])
            return result['capture']
        self.assertEqual(read(), unavailable_capture_observation())
        host.selected = SimpleNamespace()
        self.assertEqual(read(), unavailable_capture_observation())
        def fail(now):
            calls.append(now)
            raise RuntimeError('snapshot-secret-canary')
        host.selected = SimpleNamespace(capture_observation_snapshot=fail)
        self.assertEqual(read(), unavailable_capture_observation())
        observer = CaptureObservation()
        observer.begin(0)
        host.selected = SimpleNamespace(capture_observation_snapshot=lambda now: calls.append(now) or snapshot(observer, now))
        self.assertEqual(read()['attempted'], 1)
        observer.finish(1, succeeded=True)
        host.selected = SimpleNamespace(capture_observation_snapshot=lambda now: calls.append(now) or snapshot(CaptureObservation(), now))
        self.assertEqual(read()['attempted'], 0)
        self.assertEqual(calls, [123, 123, 123])


if __name__ == '__main__':
    unittest.main()
