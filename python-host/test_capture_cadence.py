"""Deterministic cadence math; no Host, native imports or real threads."""
import json
import unittest

from capture_cadence import CaptureCadenceObserver, unavailable_capture_cadence

MS = 1_000_000
CAP = 999_999_999
NS_CAP = 3_600_000_000_000


def start(observer, now, capture=0, target=0, interval=50 * MS):
    observer.start(now, capture_generation=capture, target_generation=target,
                   min_interval_ns=interval)


def finish(observer, grab=10 * MS, post=15 * MS, sleep_start=16 * MS,
           sleep_end=51 * MS, requested=30 * MS, wait=2 * MS, critical=MS,
           published=True):
    observer.finish(grab_finished_ns=grab, post_grab_finished_ns=post,
        sleep_started_ns=sleep_start, sleep_finished_ns=sleep_end,
        sleep_requested_ns=requested, publish_lock_wait_ns=wait,
        publish_critical_ns=critical, published=published)


class CaptureCadenceTest(unittest.TestCase):
    def test_exact_closed_interval_and_one_paired_max(self):
        observer = CaptureCadenceObserver()
        start(observer, 0)
        finish(observer)
        self.assertEqual(observer.snapshot(51 * MS)['intervalCount'], 0)
        self.assertIsNone(observer.snapshot(51 * MS)['lastInterval'])
        start(observer, 60 * MS)
        result = observer.snapshot(60 * MS)
        self.assertEqual(result['lastInterval'], dict(intervalMs=60, grabMs=10,
            postGrabMs=5, pacingActualMs=35, otherMs=10, minIntervalMs=50,
            pacingRequestedMs=30, pacingExcessMs=5, publishLockWaitMs=2,
            publishCriticalMs=1))
        self.assertEqual(result['activeIntervalCoveredMs'], 60)
        self.assertAlmostEqual(result['activeIntervalRateHz'], 1000 / 60)
        finish(observer, grab=80 * MS, post=82 * MS, sleep_start=82 * MS,
               sleep_end=82 * MS, requested=0, wait=MS, critical=MS)
        start(observer, 90 * MS)
        result = observer.snapshot(90 * MS)
        self.assertEqual(result['intervalCount'], 2)
        self.assertEqual(result['lastInterval']['grabMs'], 20)
        self.assertEqual(result['maxInterval']['grabMs'], 10)
        self.assertEqual(result['maxInterval']['intervalMs'], 60)
        self.assertEqual(result['stages']['grab'], dict(count=2, sumMs=30, meanMs=15, maxMs=20))

class CaptureCadenceEdgeTest(unittest.TestCase):
    def observer_with_interval(self, *, end=60 * MS):
        observer = CaptureCadenceObserver()
        start(observer, 0)
        finish(observer)
        start(observer, end)
        return observer

    def test_unavailable_initialized_and_unfinished_values(self):
        missing = unavailable_capture_cadence()
        result = CaptureCadenceObserver().snapshot(0)
        self.assertEqual(set(missing), set(result))
        self.assertEqual(result['intervalCount'], 0)
        self.assertIsNone(result['activeIntervalCoveredMs'])
        self.assertIsNone(result['activeIntervalRateHz'])
        self.assertIsNone(result['maxInterval'])
        self.assertTrue(all(v is None for v in missing['stages']['grab'].values()))
        missing['stages']['grab']['count'] = 99
        self.assertIsNone(unavailable_capture_cadence()['stages']['grab']['count'])
        start_result = CaptureCadenceObserver()
        start(start_result, 0)
        self.assertIsNone(start_result.snapshot(10 * MS)['lastInterval'])

    def test_breaks_and_generation_changes_exclude_continuity(self):
        for reason in ('startup', 'suspended', 'profile-change', 'error', 'stopped',
                       'publish-error', 'invalid-clock', 'discarded', 'secret-canary', object()):
            with self.subTest(reason=reason):
                observer = CaptureCadenceObserver()
                start(observer, 0)
                finish(observer)
                observer.break_continuity(reason)
                start(observer, 60 * MS)
                result = observer.snapshot(60 * MS)
                self.assertEqual(result['intervalCount'], 0)
                self.assertIsNone(result['lastInterval'])
                self.assertEqual(result['discontinuous'], 1)
                self.assertNotIn('secret-canary', repr(observer._state) + json.dumps(result))
        for capture, target in ((1, 0), (0, 1), (1, 1)):
            observer = CaptureCadenceObserver()
            start(observer, 0)
            finish(observer)
            start(observer, 60 * MS, capture, target)
            self.assertEqual(observer.snapshot(60 * MS)['discontinuous'], 1)
            self.assertEqual(observer.snapshot(60 * MS)['intervalCount'], 0)
            finish(observer, grab=70 * MS, post=75 * MS, sleep_start=76 * MS,
                   sleep_end=111 * MS)
            start(observer, 120 * MS, capture, target)
            self.assertEqual(observer.snapshot(120 * MS)['intervalCount'], 1)

    def test_whole_interval_invalid_on_bad_clocks_and_subsets(self):
        for kwargs in (dict(grab=-1), dict(grab=False), dict(grab=1.5), dict(grab='secret-canary'),
                       dict(post=9 * MS), dict(sleep_start=14 * MS), dict(sleep_end=15 * MS),
                       dict(wait=6 * MS), dict(wait=3 * MS, critical=3 * MS),
                       dict(requested=True), dict(published='secret-canary')):
            with self.subTest(kwargs=kwargs):
                observer = CaptureCadenceObserver()
                start(observer, 0)
                finish(observer, **kwargs)
                start(observer, 60 * MS)
                result = observer.snapshot(60 * MS)
                self.assertEqual(result['intervalCount'], 0)
                self.assertGreaterEqual(result['invalidTiming'], 1)
                self.assertTrue(all(s['count'] == 0 for s in result['stages'].values()))
                self.assertNotIn('secret-canary', repr(observer._state) + json.dumps(result))
        observer = CaptureCadenceObserver()
        start(observer, 0)
        finish(observer)
        start(observer, 50 * MS)  # Next start predates previous sleep end.
        self.assertEqual(observer.snapshot(51 * MS)['invalidTiming'], 1)
        self.assertEqual(observer.snapshot(51 * MS)['intervalCount'], 0)

    def test_bad_start_generation_minimum_and_phase_clock_are_sanitized(self):
        for value in (None, True, False, -1, 1.5, 'secret-canary', object()):
            for field in ('now', 'capture', 'target', 'interval'):
                with self.subTest(value=value, field=field):
                    observer = CaptureCadenceObserver()
                    args = dict(now=0, capture=0, target=0, interval=50 * MS)
                    args[field] = value
                    start(observer, **args)
                    result = observer.snapshot(0)
                    self.assertEqual(result['invalidTiming'], 1)
                    self.assertNotIn('secret-canary', repr(observer._state) + json.dumps(result))
        observer = CaptureCadenceObserver()
        start(observer, 0)
        finish(observer)
        observer.phase('pacing', 52 * MS)
        observer.phase('secret-canary', 51 * MS)
        start(observer, 60 * MS)
        result = observer.snapshot(60 * MS)
        self.assertEqual(result['intervalCount'], 0)
        self.assertEqual(result['invalidTiming'], 1)
        self.assertNotIn('secret-canary', repr(observer._state) + json.dumps(result))

    def test_expiry_exact_boundary_and_huge_jump_do_not_catch_up(self):
        observer = self.observer_with_interval()
        self.assertEqual(observer.snapshot(59_999_999_999)['intervalCount'], 1)
        self.assertEqual(observer.snapshot(60_000_000_000)['intervalCount'], 0)
        self.assertIsNone(observer.snapshot(60_000_000_000)['lastInterval'])
        observer.break_continuity('suspended')
        start(observer, 10 ** 1000)
        state = observer._state
        self.assertLessEqual(len(state.history), 59)
        self.assertEqual(len(state.history), 0)
        self.assertEqual(observer.snapshot(10 ** 1000)['intervalCount'], 0)
        for i in range(65):
            base = 10 ** 1000 + (i + 1) * 1_000_000_000
            observer.break_continuity('suspended')
            start(observer, base)
        self.assertLessEqual(len(observer._state.history) + 1, 60)

    def test_completion_bucket_can_cover_start_before_left_boundary(self):
        observer = CaptureCadenceObserver()
        start(observer, 0)
        finish(observer, grab=MS, post=2 * MS, sleep_start=2 * MS,
               sleep_end=2 * MS, requested=0, wait=0, critical=0)
        start(observer, 2_000_000_000)
        self.assertEqual(observer.snapshot(61_000_000_000)['intervalCount'], 1)
        self.assertEqual(observer.snapshot(62_000_000_000)['intervalCount'], 0)

    def test_caps_invalid_pair_sticky_clipping_and_capped_scalars(self):
        observer = CaptureCadenceObserver()
        start(observer, 0)
        finish(observer, grab=MS, post=MS, sleep_start=MS, sleep_end=MS,
               requested=0, wait=0, critical=0)
        start(observer, NS_CAP + 1)
        result = observer.snapshot(NS_CAP + 1)
        self.assertEqual(result['intervalCount'], 0)
        self.assertIsNone(result['lastInterval'])
        self.assertTrue(result['clipped'])
        observer.break_continuity('error')
        self.assertTrue(observer.snapshot(NS_CAP + 1)['clipped'])
        for field in ('interval', 'capture', 'target'):
            capped = CaptureCadenceObserver()
            args = dict(now=0, capture=0, target=0, interval=50 * MS)
            args[field] = NS_CAP + 1 if field == 'interval' else CAP + 1
            start(capped, **args)
            self.assertEqual(capped.snapshot(0)['invalidTiming'], 1)
        observer = self.observer_with_interval()
        current = observer._state.current
        observer._state = observer._state._replace(current=current._replace(counters=(CAP, 0, 0, 0, 0)))
        finish(observer, grab=70 * MS, post=75 * MS, sleep_start=76 * MS, sleep_end=111 * MS)
        result = observer.snapshot(111 * MS)
        self.assertEqual(result['published'], CAP)
        self.assertTrue(result['clipped'])

    def test_exact_duration_cap_and_sum_saturation_keep_pairs_exact(self):
        observer = CaptureCadenceObserver()
        start(observer, 0)
        finish(observer, grab=MS, post=MS, sleep_start=MS, sleep_end=MS,
               requested=0, wait=0, critical=0)
        start(observer, NS_CAP)
        exact = observer.snapshot(NS_CAP)
        self.assertFalse(exact['clipped'])
        self.assertEqual(exact['activeIntervalCoveredMs'], NS_CAP / MS)
        finish(observer, grab=NS_CAP + MS, post=NS_CAP + MS,
               sleep_start=NS_CAP + MS, sleep_end=NS_CAP + MS,
               requested=0, wait=0, critical=0)
        start(observer, NS_CAP + 50 * MS)
        capped = observer.snapshot(NS_CAP + 50 * MS)
        self.assertTrue(capped['clipped'])
        self.assertEqual(capped['intervalCount'], 2)
        self.assertEqual(capped['activeIntervalCoveredMs'], NS_CAP / MS)
        self.assertIsNone(capped['activeIntervalRateHz'])
        self.assertIsNone(capped['stages']['interval']['meanMs'])
        self.assertEqual(capped['maxInterval']['intervalMs'], NS_CAP / MS)
        self.assertEqual(capped['lastInterval']['intervalMs'], 50)
        observer.break_continuity('suspended')
        observer.phase('suspended', NS_CAP + 60_000 * MS)
        self.assertTrue(observer.snapshot(NS_CAP + 60_000 * MS)['clipped'])
        self.assertIsNone(observer.snapshot(NS_CAP + 60_000 * MS)['maxInterval'])

    def test_snapshot_reads_one_publication_and_returns_fresh_nested_dicts(self):
        class Switching(CaptureCadenceObserver):
            replacement = None
            reads = 0
            def __getattribute__(self, name):
                value = super().__getattribute__(name)
                if name == '_state' and self.replacement is not None:
                    self.reads += 1
                    object.__setattr__(self, '_state', self.replacement)
                return value
        observer = Switching()
        start(observer, 0)
        old = observer._state
        finish(observer)
        start(observer, 60 * MS)
        observer.replacement = observer._state
        observer._state = old
        result = observer.snapshot(60 * MS)
        self.assertEqual(observer.reads, 1)
        self.assertEqual(result['intervalCount'], 0)
        observer.replacement = None
        result = observer.snapshot(60 * MS)
        result['lastInterval']['grabMs'] = 'mutation'
        result['maxInterval']['intervalMs'] = 'mutation'
        result['stages']['grab']['count'] = 'mutation'
        fresh = observer.snapshot(60 * MS)
        self.assertEqual(fresh['lastInterval']['grabMs'], 10)
        self.assertEqual(fresh['maxInterval']['intervalMs'], 60)
        self.assertEqual(fresh['stages']['grab']['count'], 1)
        self.assertIsInstance(observer._state, tuple)

    def test_nanosecond_pairs_keep_identity_and_invalid_read_has_no_window(self):
        observer = CaptureCadenceObserver()
        start(observer, 0)
        finish(observer, grab=500, post=1000, sleep_start=1000, sleep_end=1000,
               requested=0, wait=250, critical=250)
        start(observer, 1000)
        pair = observer.snapshot(1000)['lastInterval']
        self.assertEqual(pair['intervalMs'], pair['grabMs'] + pair['postGrabMs'] +
                         pair['pacingActualMs'] + pair['otherMs'])
        self.assertEqual(pair['grabMs'], .0005)
        for bad in (None, True, -1, 999, 'secret-canary'):
            result = observer.snapshot(bad)
            self.assertIsNone(result['intervalCount'])
            self.assertIsNone(result['lastInterval'])
            self.assertIsNone(result['stages']['grab']['count'])

    def test_phase_age_and_read_clipping_never_mutate_writer(self):
        observer = CaptureCadenceObserver()
        observer.phase('grab', 10)
        state = observer._state
        for value in (None, True, -1, 9, 'secret-canary'):
            self.assertIsNone(observer.snapshot(value)['phaseAgeMs'])
        self.assertEqual(observer.snapshot(10)['phaseAgeMs'], 0)
        self.assertEqual(observer.snapshot(2_000_010)['phaseAgeMs'], 2)
        self.assertTrue(observer.snapshot(NS_CAP + 11)['clipped'])
        self.assertIs(observer._state, state)
        self.assertFalse(observer.snapshot(10)['clipped'])
        observer.phase('secret-canary', 20)
        self.assertEqual(observer.snapshot(20)['phase'], 'unknown')
        self.assertNotIn('secret-canary', repr(observer._state))


if __name__ == '__main__':
    unittest.main()
