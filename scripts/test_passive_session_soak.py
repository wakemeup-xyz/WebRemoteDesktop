import asyncio
import io
import json
import unittest
from scripts import passive_session_soak as soak
from scripts.passive_session_soak import (ContinuitySummary, EvidenceWriter, collect_samples,
    private_row, record_missed_ticks)


def row(tick, **changes):
    sample = {'socketConnected': True, 'pcState': 'connected', 'pcIdentity': 1,
        'attemptHash': 'a', 'generation': 1, 'leaseEpoch': 1, 'scopeStable': True,
        'frameAgeMs': 10, 'maxFrameGapMs': 50, 'buildId':'release-a', 'callbacks': tick*20+1,
        'transport': {'status':'observed', 'localType':'relay', 'remoteType':'host', 'protocol':'udp', 'pathIdentity':'path-1'}}
    sample.update(changes)
    return {'status':'observed', 'elapsedSeconds':tick, 'sample':sample}


class ContinuityTest(unittest.TestCase):
    def test_complete_sequence_passes_only_passive_continuity(self):
        summary = ContinuitySummary(duration_s=10, mode='relay')
        for tick in range(11): summary.observe(row(tick))
        result = summary.result(elapsed_s=10)
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual(result['visibleEffect'], 'NOT_RUN')
        self.assertEqual(result['activeControl'], 'NOT_RUN')

    def test_short_missing_churn_and_wrong_path_cannot_pass(self):
        for change in ('short', 'missing', 'churn', 'path', 'build'):
            summary = ContinuitySummary(duration_s=10, mode='relay')
            for tick in range(5 if change == 'short' else 11):
                item = row(tick)
                if tick == 2:
                    if change == 'missing': item = {'status':'missing', 'elapsedSeconds':tick}
                    if change == 'churn': item['sample']['pcIdentity'] = 2
                    if change == 'path': item['sample']['transport']['localType'] = 'host'
                    if change == 'build': item['sample']['buildId'] = None
                summary.observe(item)
            self.assertNotEqual(summary.result(elapsed_s=10)['status'], 'PASS', change)

    def test_no_render_progress_is_failure_even_if_connected(self):
        summary = ContinuitySummary(duration_s=10, mode='relay')
        for tick in range(11): summary.observe(row(tick, callbacks=1))
        self.assertEqual(summary.result(elapsed_s=10)['status'], 'FAIL')

    def test_between_tick_render_gap_and_stale_age_cannot_pass(self):
        for problem in ('gap', 'age', 'missing-age', 'missing-gap'):
            summary = ContinuitySummary(duration_s=10, mode='relay')
            counts = [1, 2, 2, 2, 2, 2, 3, 4, 5, 6, 7]
            for tick, count in enumerate(counts):
                item = row(tick, callbacks=count)
                if problem == 'gap' and tick >= 6: item['sample']['maxFrameGapMs'] = 5800
                if problem == 'age' and tick == 5: item['sample']['frameAgeMs'] = 5000
                if problem == 'missing-age': item['sample']['frameAgeMs'] = None
                if problem == 'missing-gap': item['sample']['maxFrameGapMs'] = None
                summary.observe(item)
            self.assertEqual(summary.result(elapsed_s=10)['status'], 'FAIL', problem)

    def test_one_second_without_new_frame_cannot_pass(self):
        summary = ContinuitySummary(duration_s=1, mode='relay')
        for tick in range(2): summary.observe(row(tick, callbacks=2))
        self.assertEqual(summary.result(elapsed_s=1)['status'], 'FAIL')

    def test_lease_pair_protocol_change_and_missing_scope_cannot_pass(self):
        for field, value in [('leaseEpoch', 2), ('leaseEpoch', None), ('generation', None),
                             ('pcIdentity', None), ('scopeStable', False),
                             ('pathIdentity', 'path-2'), ('pathIdentity', None), ('protocol', 'tcp')]:
            summary = ContinuitySummary(duration_s=10, mode='relay')
            for tick in range(11):
                item = row(tick)
                if tick >= 5:
                    target = item['sample']['transport'] if field in ('pathIdentity', 'protocol') else item['sample']
                    target[field] = value
                summary.observe(item)
            self.assertEqual(summary.result(elapsed_s=10)['status'], 'FAIL', (field, value))

    def test_tunnel_requires_fresh_loads_and_progress_not_optical_presentation(self):
        for problem in ('none', 'stale', 'gap', 'no-progress', 'missing-age'):
            summary = ContinuitySummary(duration_s=1, mode='tunnel')
            for tick in range(2):
                item = row(tick, pcIdentity=None, relayFrameSeq=tick+1, tunnelRelayActive=True,
                    relayLoadCallbacks=2 if problem == 'no-progress' else tick+1,
                    relayLoadAgeMs=None if problem == 'missing-age' else 5000 if problem == 'stale' else 10,
                    maxRelayLoadGapMs=5800 if problem == 'gap' else 50)
                summary.observe(item)
            self.assertEqual(summary.result(elapsed_s=1)['status'], 'PASS' if problem == 'none' else 'FAIL', problem)

    def test_private_attempt_is_salted_and_removed(self):
        result = private_row({'attempt':'private-id', 'buildId':'release-a'}, b'one')
        self.assertNotIn('attempt', result)
        self.assertNotIn('private-id', str(result))
        self.assertNotEqual(result['attemptHash'], private_row({'attempt':'private-id'}, b'two')['attemptHash'])


class ScheduleBudgetTest(unittest.IsolatedAsyncioTestCase):
    async def collect(self, *, duration=3, budget=100000, stall=10**9, sample_stall=0):
        stream = io.StringIO()
        writer = EvidenceWriter(stream, max_bytes=budget)
        summary = ContinuitySummary(duration_s=duration, mode='relay')
        clock = {'now': 0, 'sleeps': 0, 'samples': 0}
        async def sleep(delay):
            clock['sleeps'] += 1
            clock['now'] += stall if clock['sleeps'] == 2 else delay
        async def sample():
            clock['samples'] += 1
            value = row(int(clock['now']))['sample']
            value['attempt'] = 'private-attempt'
            if clock['now'] >= duration: clock['now'] += sample_stall
            return value
        failure = None
        try:
            await collect_samples(sample, writer, summary, b'salt', start=0,
                duration_s=duration, monotonic=lambda: clock['now'], sleep=sleep)
        except RuntimeError as exc: failure = str(exc)
        return stream, writer, summary, clock, failure

    async def test_fake_clock_stall_beyond_deadline_is_bounded_and_incomplete(self):
        stream, writer, summary, clock, failure = await self.collect()
        rows = [json.loads(line) for line in stream.getvalue().splitlines()]
        self.assertEqual(failure, 'sampling-deadline-overrun')
        self.assertEqual(clock['samples'], 1)
        self.assertEqual([item['tick'] for item in rows], [0, 1, 2, 3])
        self.assertEqual(summary.missing, 3)
        self.assertEqual(writer.total_bytes, len(stream.getvalue().encode()))
        self.assertEqual(summary.result(elapsed_s=clock['now'], interrupted=True)['status'], 'INCOMPLETE')

    async def test_missing_ticks_share_nearly_exhausted_byte_budget(self):
        baseline, _, _, _, _ = await self.collect()
        first_two = baseline.getvalue().splitlines(keepends=True)[:2]
        budget = len(''.join(first_two).encode()) + 5
        stream, writer, summary, clock, failure = await self.collect(budget=budget)
        self.assertEqual(failure, 'evidence-budget-exceeded')
        self.assertEqual(clock['samples'], 1)
        self.assertEqual(summary.missing, 1)
        self.assertEqual(len(stream.getvalue().splitlines()), 2)
        self.assertEqual(writer.total_bytes, len(stream.getvalue().encode()))
        self.assertLessEqual(writer.total_bytes, budget)

    async def test_in_window_stall_records_missing_ticks_and_normal_run_passes(self):
        for stall, expected in [(1, 'PASS'), (3.2, 'FAIL')]:
            stream, _, summary, clock, failure = await self.collect(duration=5, stall=stall)
            self.assertIsNone(failure)
            rows = [json.loads(line) for line in stream.getvalue().splitlines()]
            self.assertEqual([item['tick'] for item in rows], list(range(6)))
            self.assertEqual(summary.result(elapsed_s=clock['now'])['status'], expected)

    async def test_sample_finishing_far_past_end_cannot_complete(self):
        _, _, summary, clock, failure = await self.collect(stall=1, sample_stall=1000)
        self.assertEqual(failure, 'sampling-deadline-overrun')
        self.assertEqual(summary.result(elapsed_s=clock['now'], interrupted=True)['status'], 'INCOMPLETE')

    async def test_all_rows_enforce_row_cap_without_partial_writes(self):
        stream = io.StringIO()
        writer = EvidenceWriter(stream, max_row_bytes=10)
        summary = ContinuitySummary(duration_s=3, mode='relay')
        with self.assertRaisesRegex(RuntimeError, 'evidence-budget-exceeded'):
            record_missed_ticks(writer, summary, tick=0, elapsed_s=10**9, duration_s=3)
        self.assertEqual(stream.getvalue(), '')
        self.assertEqual(writer.total_bytes, 0)
        self.assertEqual(summary.missing, 0)


class StartUiTest(unittest.IsolatedAsyncioTestCase):
    class Page:
        def __init__(self, *, ready_after=0, state=None, mark_delta=1, click_error=False):
            self.now = 0
            self.ready_after = ready_after
            self.state = state or {}
            self.mark_delta, self.click_error = mark_delta, click_error
            self.clicks = 0

        async def evaluate(self, expression):
            return {'shellAvailable': True, 'clientAvailable': True, 'marksAvailable': True,
                'coreInstalled': True, 'authVerified': self.now >= self.ready_after,
                'queuedStart': False, 'socketPresent': False, 'pcPresent': False,
                'attemptPresent': False, 'htmlShellMarks': 1, 'coreInteractiveMarks': 1,
                'startClickMarks': self.clicks * self.mark_delta, **self.state}

        def locator(self, selector):
            if selector != '#startBtn': raise AssertionError(selector)
            return self

        async def is_visible(self):
            return self.now >= self.ready_after and not self.state.get('hidden', False)

        async def is_enabled(self):
            return self.now >= self.ready_after and not self.state.get('disabled', False)

        async def click(self, *, timeout):
            if timeout <= 0 or not await self.is_visible() or not await self.is_enabled():
                raise AssertionError('click before ready or outside deadline')
            self.clicks += 1
            if self.click_error: raise RuntimeError('private credential canary')

        async def sleep(self, delay):
            self.now += delay

    async def start(self, page):
        helper = getattr(soak, 'start_via_ui', None)
        self.assertIsNotNone(helper, 'Start must be a required asynchronous proof step')
        return await helper(page, timeout_s=0.5, monotonic=lambda: page.now, sleep=page.sleep)

    async def test_delayed_auth_and_visible_enabled_button_get_exactly_one_ui_click(self):
        page = self.Page(ready_after=0.3)
        proof = await self.start(page)
        self.assertGreaterEqual(page.now, 0.3)
        self.assertEqual(page.clicks, 1)
        self.assertEqual(proof, {'status': 'verified', 'freshPage': True,
            'coreInstalled': True, 'authVerified': True,
            'startClickMarksBefore': 0, 'startClickMarksAfter': 1})

    async def test_missing_shell_client_or_marks_and_unavailable_button_cannot_skip_start(self):
        for state in ({'shellAvailable': False}, {'clientAvailable': False},
                      {'marksAvailable': False}, {'htmlShellMarks': 0},
                      {'coreInteractiveMarks': 0}, {'hidden': True}, {'disabled': True},
                      {'coreInstalled': False}, {'authVerified': False}):
            with self.subTest(state=state):
                page = self.Page(state=state)
                with self.assertRaisesRegex(RuntimeError, '^start-ui-(unavailable|deadline)$'):
                    await self.start(page)
                self.assertEqual(page.clicks, 0)
                self.assertLessEqual(page.now, 0.5)

    async def test_prior_socket_pc_attempt_queued_or_click_fails_before_click(self):
        for state in ({'socketPresent': True}, {'pcPresent': True}, {'attemptPresent': True},
                      {'queuedStart': True}, {'startClickMarks': 1}):
            with self.subTest(state=state):
                page = self.Page(state=state)
                with self.assertRaisesRegex(RuntimeError, '^start-ui-not-fresh$'):
                    await self.start(page)
                self.assertEqual(page.clicks, 0)

    async def test_missing_or_duplicate_click_mark_is_never_verified_or_retried(self):
        for delta in (0, 2):
            with self.subTest(delta=delta):
                page = self.Page(mark_delta=delta)
                with self.assertRaisesRegex(RuntimeError, '^start-ui-click-unproven$'):
                    await self.start(page)
                self.assertEqual(page.clicks, 1)
                self.assertLessEqual(page.now, 0.5)

    async def test_click_exception_has_fixed_private_safe_reason_and_no_retry(self):
        page = self.Page(click_error=True)
        with self.assertRaisesRegex(RuntimeError, '^start-ui-unavailable$'):
            await self.start(page)
        self.assertEqual(page.clicks, 1)


if __name__ == '__main__': unittest.main()
