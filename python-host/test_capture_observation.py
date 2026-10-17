"""Pure scalar and AST-only capture accounting tests: no Host/native imports."""
import ast
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

from runtime_observability import (
    CaptureObservation, RuntimeObservability, unavailable_capture_observation,
)


KEYS = {'scope', 'state', 'attempted', 'completed', 'failed', 'currentGrabAgeMs',
        'lastCompletionAgeMs', 'lastDurationMs', 'maxDurationMs', 'clipped'}
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
    def test_initialized_zero_and_unavailable_are_distinct_fixed_schemas(self):
        result = snapshot(CaptureObservation())
        missing = unavailable_capture_observation()
        self.assertEqual(set(result), KEYS)
        self.assertEqual(set(missing), KEYS)
        self.assertEqual(result['scope'], 'track-lifetime')
        self.assertEqual(result['state'], 'starting')
        self.assertEqual([result[key] for key in ('attempted', 'completed', 'failed')], [0, 0, 0])
        self.assertEqual(missing['state'], 'unavailable')
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
    def run_loop(self, action=None, publication_error=False, gate_cancel=False, suspended=False):
        clock = SimpleNamespace(now=0, sleeps=[])
        def sleep(delay):
            clock.sleeps.append(delay)
            clock.now += int(delay * 1_000_000_000)
        track = SimpleNamespace(_capture_running=True, _suspended=suspended,
            _target_fps=20, _capture_strategy=None, _activity_condition=Guard(),
            _target_lock=Guard(), _capture_lock=Guard(), _capture_observation=CaptureObservation(),
            monitor=object(), _capture_buffer=None, _capture_seq=0, _capture_bounds_ns={},
            _frame_trace_context=None,
            capture_fps_for_target=lambda fps, **kwargs: fps)
        if gate_cancel:
            track._target_lock.enter = lambda: setattr(track, '_capture_running', False)
        def grab(monitor):
            self.assertIs(monitor, track.monitor)
            track.inside = snapshot(track._capture_observation, clock.now)
            clock.now = 10_000_000
            track._capture_running = False
            if action:
                action(track)
            return 'pixels-canary'
        track.sct = SimpleNamespace(grab=grab)
        if publication_error:
            track._capture_lock.enter = lambda: (_ for _ in ()).throw(RuntimeError('publication-secret-canary'))
        if suspended:
            def resume(*, timeout):
                self.assertEqual(timeout, .2)
                self.assertEqual(snapshot(track._capture_observation)['attempted'], 0)
                track._suspended = False
            track._activity_condition.wait = resume
        loop = method('ScreenCaptureTrack', '_capture_loop', time=SimpleNamespace(
            monotonic_ns=lambda: clock.now, sleep=sleep))
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

    def test_grab_exception_counts_failure_only_and_keeps_existing_retry(self):
        def fail(track):
            raise RuntimeError('native-secret-canary')
        track, clock, result = self.run_loop(fail)
        self.assertEqual((result['attempted'], result['completed'], result['failed']), (1, 0, 1))
        self.assertEqual(result['lastDurationMs'], 10)
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

    def test_stop_inside_grab_keeps_original_publication(self):
        track, clock, result = self.run_loop()
        self.assertFalse(track._capture_running)
        self.assertEqual(result['completed'], 1)
        self.assertEqual(track._capture_seq, 1)

    def test_stop_before_final_gate_does_not_count_attempt(self):
        track, clock, result = self.run_loop(gate_cancel=True)
        self.assertEqual(result['attempted'], 0)
        self.assertEqual(clock.sleeps, [])
        self.assertEqual(track._capture_seq, 0)

    def test_idle_suspend_wait_does_not_count_until_resumed(self):
        track, clock, result = self.run_loop(suspended=True)
        self.assertEqual(result['attempted'], 1)
        self.assertEqual(result['completed'], 1)

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
            unavailable_capture_observation=unavailable_capture_observation)
        self.assertEqual(reader(SimpleNamespace(), 0), unavailable_capture_observation())
        thread = SimpleNamespace(ident=None, is_alive=lambda: False)
        track = SimpleNamespace(_capture_observation=SimpleNamespace(snapshot=lambda *a, **k: calls.append((a, k)) or {}),
            _capture_running=True, _suspended=False, _capture_thread=thread)
        self.assertEqual(reader(track, 0), {})
        self.assertEqual(calls, [((0,), dict(running=True, suspended=False, thread_alive=False, thread_started=False))])
        thread.ident = 12345
        thread.is_alive = lambda: True
        reader(track, 1)
        self.assertTrue(calls[-1][1]['thread_started'])
        self.assertNotIn('12345', repr(calls))

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
