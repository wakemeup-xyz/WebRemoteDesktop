import asyncio
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
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


def gate_value(status='observed'):
    return {'status':status,'blockedReasons':[],**dict.fromkeys(soak.GATE_BOOLEANS),
        **dict.fromkeys(soak.GATE_ENUMS,'unknown')}


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
            self.proofs = 0
            self.events = []

        async def evaluate(self, expression, arg=None):
            if expression == getattr(soak, 'PROOF_ADMISSION', None):
                self.proofs += 1
                self.events.append(('proof', self.now))
                return 'ready'
            return {'shellAvailable': True, 'clientAvailable': True, 'marksAvailable': True,
                'coreInstalled': True, 'authVerified': self.now >= self.ready_after,
                'queuedStart': False, 'socketPresent': False, 'pcPresent': False,
                'attemptPresent': False, 'htmlShellMarks': 1, 'coreInteractiveMarks': 1,
                'startClickMarks': self.clicks * self.mark_delta,
                'admissionCurrent': self.proofs == 1, **self.state}

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
            self.events.append(('start-click', self.now))
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
        self.assertEqual(page.proofs, 1)
        self.assertEqual([event[0] for event in page.events], ['proof', 'start-click'])
        self.assertTrue(all(when >= 0.3 for _, when in page.events))
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


class ProofTimingTest(unittest.IsolatedAsyncioTestCase):
    async def test_real_ui_login_precedes_ready_proof_and_single_start(self):
        class LoginPage(StartUiTest.Page):
            def locator(self, selector):
                owner = self
                class LoginLocator:
                    async def fill(self, value):
                        owner.events.append(('password-fill', 0))
                    async def click(self):
                        owner.events.append(('login-click', 0))
                return super().locator(selector) if selector == '#startBtn' else LoginLocator()
            async def wait_for_url(self, pattern, *, timeout):
                self.events.append(('login-complete', 0))
        login = getattr(soak, 'login_via_ui', None)
        self.assertIsNotNone(login, 'login must use UI before issuing proof')
        page = LoginPage(ready_after=0.3)
        await login(page, 'credential canary')
        await soak.start_via_ui(page, timeout_s=0.5, monotonic=lambda: page.now, sleep=page.sleep)
        self.assertEqual([event[0] for event in page.events],
            ['password-fill', 'login-click', 'login-complete', 'proof', 'start-click'])
        self.assertNotIn('credential canary', json.dumps(page.events))

    async def test_post_proof_auth_freshness_or_button_change_fails_without_start_or_remint(self):
        for change in ({'authVerified': False}, {'admissionCurrent': False},
                       {'socketPresent': True}, {'pcPresent': True},
                       {'startClickMarks': 1}, {'hidden': True}, {'disabled': True}):
            with self.subTest(change=change):
                class ChangedPage(StartUiTest.Page):
                    async def evaluate(self, expression, arg=None):
                        result = await super().evaluate(expression, arg)
                        if self.proofs: self.state.update(change)
                        return result
                page = ChangedPage()
                with self.assertRaisesRegex(RuntimeError, '^start-ui-state-changed$'):
                    await soak.start_via_ui(page, timeout_s=0.5,
                        monotonic=lambda: page.now, sleep=page.sleep)
                self.assertEqual((page.proofs, page.clicks), (1, 0))

    async def browser_fixture(self, expression, fixture, arg=None):
        # Runs the production browser function in a JS VM with fake fetch/storage,
        # never opens a browser or performs network requests.
        harness = r'''
const vm = require('node:vm');
let input = ''; process.stdin.on('data', part => input += part);
process.stdin.on('end', async () => {
  const {expression, fixture:f, arg} = JSON.parse(input);
  let token = 'private-token-canary', generation = 1, stored = null, elapsed = 0;
  const requests = [];
  const context = {TextDecoder, AbortController, performance:{now:() => elapsed},
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 20)), clearTimeout,
    Auth: {getToken: () => token, getGeneration: () => generation,
      isVerified: () => f.verified !== false, getCheck: () => ({state:f.authState || 'verified', token})},
    sessionStorage: {getItem: () => stored, setItem: (key, value) => { stored = value; }},
    fetch: async (path, options={}) => {
      requests.push({path, method:options.method || 'GET', authorized:options.headers?.Authorization === 'Bearer '+token});
      if (f.hang) return new Promise(() => {});
      const statusRequest = path === '/api/status';
      if ((f.changeAt === 'status' && statusRequest) || (f.changeAt === 'proof' && !statusRequest)) {
        generation++; token = 'new-private-token-canary';
      }
      const body = statusRequest ? {hostOnline:f.host !== false, viewerCount:f.viewer || 0}
        : {admission:{token:'private-proof-canary'}};
      let reads = 0;
      return {status:statusRequest ? 200 : f.refuse ? 409 : 201, body:{getReader:() => ({
        cancel: async () => {}, read: async () => {
          if (reads++) {
            if (f.expireAt === (statusRequest ? 'status-body' : 'proof-body')) elapsed = 1001;
            return {done:true};
          }
          if (f.changeAt === 'body') generation++;
          return {done:false, value:Buffer.from(f.oversize ? 'x'.repeat(16385) : JSON.stringify(body))};
        }})}};
    }, WebRTC: f.client || null, __wrdPassiveSampler: f.observer ? {sample(){}} : null};
  if (f.media && context.WebRTC) context.WebRTC.mediaActivityRuntime = {snapshot: () => f.media};
  context.window = context;
  try {
    const result = await vm.runInNewContext('('+expression+')', context)(arg);
    process.stdout.write(JSON.stringify({result, requests, proofStored:!!stored,
      guardCurrent:context.__wrdProofStartGuard?.() === true}));
  } catch (_) { process.stdout.write(JSON.stringify({unexpected:true})); }
});'''
        child = await asyncio.create_subprocess_exec('node', '-e', harness,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await asyncio.wait_for(child.communicate(
            json.dumps({'expression': expression, 'fixture': fixture, 'arg': arg}).encode()), timeout=2)
        self.assertEqual((child.returncode, stderr), (0, b''))
        return json.loads(stdout)

    async def test_actual_proof_fetch_is_once_uses_current_auth_and_never_ordinary_ticket(self):
        expression = getattr(soak, 'PROOF_ADMISSION', None)
        self.assertIsNotNone(expression, 'bounded proof must use current browser Auth')
        result = await self.browser_fixture(expression, {}, 1000)
        self.assertEqual(result, {'result':'ready', 'requests':[
            {'path':'/api/status', 'method':'GET', 'authorized':False},
            {'path':'/api/proof-admission', 'method':'POST', 'authorized':True}],
            'proofStored':True, 'guardCurrent':True})
        self.assertNotIn('private-', json.dumps(result))

    async def test_actual_proof_refuses_viewer_no_host_changed_auth_body_cap_and_timeout(self):
        expression = getattr(soak, 'PROOF_ADMISSION', None)
        self.assertIsNotNone(expression, 'bounded proof guard must exist')
        for fixture, expected, requests in [
            ({'viewer':1}, 'viewer-present-or-unknown', 1),
            ({'host':False}, 'host-unavailable', 1),
            ({'verified':False}, 'authentication-unavailable', 0),
            ({'changeAt':'status'}, 'admission-auth-changed', 1),
            ({'changeAt':'proof'}, 'admission-auth-changed', 2),
            ({'changeAt':'body'}, 'admission-auth-changed', 1),
            ({'oversize':True}, 'admission-body-cap', 1),
            ({'hang':True}, 'admission-deadline', 1),
            ({'expireAt':'status-body'}, 'admission-deadline', 1),
            ({'expireAt':'proof-body'}, 'admission-deadline', 2),
            ({'refuse':True}, 'admission-refused', 2)]:
            with self.subTest(fixture=fixture):
                result = await self.browser_fixture(expression, fixture, 1000)
                self.assertEqual(result['result'], expected)
                self.assertEqual(len(result['requests']), requests)
                self.assertFalse(result['proofStored'])
                self.assertNotIn('private-', json.dumps(result))
                class RefusedPage(StartUiTest.Page):
                    async def evaluate(self, expr, arg=None):
                        if expr == expression:
                            self.proofs += 1
                            return result['result']
                        return await super().evaluate(expr, arg)
                page = RefusedPage()
                with self.assertRaisesRegex(RuntimeError, '^'+expected+'$'):
                    await soak.start_via_ui(page, timeout_s=0.5,
                        monotonic=lambda:page.now, sleep=page.sleep)
                self.assertEqual((page.proofs, page.clicks), (1, 0))

    async def test_startup_projection_is_bounded_and_contains_no_arbitrary_fields(self):
        expression = getattr(soak, 'STARTUP_SUMMARY', None)
        self.assertIsNotNone(expression, 'failure/ready needs a safe phase projection')
        result = (await self.browser_fixture(expression, {'observer':True,
            'authState':'private-auth-text', 'client': {'socket':{'connected':True,'id':'private-id'},
            'pc':{'connectionState':'private-state'}, 'uiPhase':'private-html',
            'controlState':{'state':'private-state', 'hostOnline':True},
            '_superseded':True, 'arbitrary':'private-token'} }))['result']
        self.assertEqual(result, {'observerAvailable':True, 'socketPresent':True,
            'socketConnected':True, 'pcState':'unknown', 'uiPhase':'unknown',
            'controlState':'unknown', 'hostOnline':True, 'desiredMediaState':'unknown',
            'desiredGeneration':None, 'authState':'unknown', 'superseded':True,
            'failureCause':'unknown','browserNowMs':None})
        self.assertNotIn('private-', json.dumps(result))
        self.assertLess(len(json.dumps(result)), 1024)

    async def test_startup_projection_preserves_actual_product_phase_enums(self):
        for state in ('FREE', 'GRANTING', 'ACTIVE', 'REVOKING'):
            with self.subTest(state=state):
                result = (await self.browser_fixture(soak.STARTUP_SUMMARY,
                    {'client':{'uiPhase':'media-pending', 'controlState':{'state':state}},
                     'media':{'desiredState':'suspended', 'desiredGeneration':4}}))['result']
                self.assertEqual((result['controlState'], result['uiPhase'], result['desiredMediaState'],
                    result['desiredGeneration']), (state, 'media-pending', 'suspended', 4))


class StartupRunTest(unittest.IsolatedAsyncioTestCase):
    async def test_guard_and_media_failures_publish_phase_evidence_and_close_browser(self):
        for guard_failure in (True, False):
            with self.subTest(guard_failure=guard_failure):
                class Page(StartUiTest.Page):
                    def set_default_timeout(self, value): pass
                    async def add_init_script(self, script): pass
                    async def goto(self, origin, **kwargs): return SimpleNamespace(status=200)
                    async def wait_for_url(self, *args, **kwargs): pass
                    def locator(self, selector):
                        class LoginElement:
                            async def wait_for(self, **kwargs): pass
                            async def fill(self, password): pass
                            async def click(self): pass
                        return super().locator(selector) if selector == '#startBtn' else LoginElement()
                    async def evaluate(self, expression, arg=None):
                        if expression == soak.PROOF_ADMISSION and guard_failure:
                            self.proofs += 1
                            return 'viewer-present-or-unknown'
                        if expression == soak.STARTUP_SUMMARY:
                            return {'observerAvailable':not guard_failure,
                                'uiPhase':'idle' if guard_failure else 'signaling', 'failureCause':'unknown'}
                        if expression == '() => window.__wrdPassiveSampler.sample()':
                            return {'socketConnected':False}
                        if expression.startswith('/* Acceptance observer'): return None
                        return await super().evaluate(expression, arg)
                page = Page()
                class Browser:
                    closed = False
                    async def launch(self, **kwargs): return self
                    async def new_context(self): return self
                    async def new_page(self): return page
                    async def close(self): self.closed = True
                browser = Browser()
                class Playwright:
                    async def __aenter__(self): return SimpleNamespace(chromium=browser)
                    async def __aexit__(self, *args): pass
                async def no_sleep(delay): pass
                modules = {'dotenv':SimpleNamespace(dotenv_values=lambda _: {}),
                    'playwright':SimpleNamespace(),
                    'playwright.async_api':SimpleNamespace(async_playwright=Playwright)}
                with tempfile.TemporaryDirectory() as directory, patch.dict('sys.modules', modules), \
                    patch.dict(os.environ, {'VIEWER_ACCESS_PASSWORD':'private-password-canary'}), \
                    patch.object(soak.asyncio, 'sleep', no_sleep), patch('builtins.print'):
                    output = Path(directory)/'evidence'
                    result = await soak.run(SimpleNamespace(origin='https://fixture.invalid',
                        output_dir=output, duration_seconds=10800, mode='relay', runtime_config=None))
                    summary = json.loads((output/'summary.json').read_text())
                    self.assertEqual(result, 1)
                    self.assertEqual(summary['failure']['category'], 'startup-guard' if guard_failure else 'media-wait')
                    self.assertEqual(summary['failure']['reason'],
                        'viewer-present-or-unknown' if guard_failure else 'media-start-deadline')
                    self.assertEqual(summary['startProof']['status'], 'NOT_VERIFIED' if guard_failure else 'verified')
                    self.assertIsNone(summary['startupSummary'])
                    self.assertEqual(summary['startupSnapshot']['status'],'not-reached')
                    self.assertEqual(summary['failureSnapshot']['state']['uiPhase'], 'idle' if guard_failure else 'signaling')
                    self.assertEqual(summary['failureSnapshot']['state']['failureCause'], 'unknown')
                    self.assertEqual(summary['status'], 'INCOMPLETE')
                    self.assertEqual((summary['samples'], summary['elapsedSeconds']), (0, 0))
                    self.assertFalse(summary['threeHourContinuityMet'])
                    self.assertNotIn('private-', json.dumps(summary))
                self.assertTrue(browser.closed)
                self.assertEqual((page.proofs, page.clicks), (1, 0 if guard_failure else 1))



class LifecycleSchemaTest(unittest.TestCase):
    def test_safe_initial_observer_and_reject_unknown_keys(self):
        diagnostic = soak.empty_diagnostic()
        self.assertEqual(soak.validate_diagnostic(diagnostic), diagnostic)
        with self.assertRaises(ValueError):
            soak.validate_diagnostic({**diagnostic, 'private-canary': 'secret'})

class LifecycleRunTest(unittest.IsolatedAsyncioTestCase):
    class Rig:
        def __init__(self, output, *, fail_at=None, timeout_at=None, pause_at=None,
                     malformed_export=False, malformed_delta=False, disconnected=True):
            self.output = output
            self.fail_at, self.timeout_at, self.pause_at = fail_at, timeout_at, pause_at
            self.malformed_export, self.malformed_delta = malformed_export, malformed_delta
            self.disconnected = disconnected
            self.events = []
            self.entered = asyncio.Event()
            self.proofs = self.clicks = self.sample_count = 0
            self.closed = False
            self.console_listeners = []
            self.product_console = lambda message: None
            self.console_listeners.append(self.product_console)
            self.chromium = self
            self.diagnostic = soak.empty_diagnostic()
            self.diagnostic['coverage']['status'] = 'partial'
            self.diagnostic['state']['socketState'] = 'state-observed-disconnected'
            self.diagnostic['attribution']['firstDisconnectEvent'] = {
                't':20,'n':1,'k':'sd','o':'s1','c':True,'r':'transport-close'}
            self.diagnostic['events'] = [self.diagnostic['attribution']['firstDisconnectEvent']]
            if not disconnected:
                self.diagnostic['state']['socketState'] = 'connected'
                self.diagnostic['attribution']['firstDisconnectEvent'] = None
                self.diagnostic['events'] = []

        async def operation(self,name):
            self.events.append(name)
            if self.pause_at == name:
                self.entered.set()
                try: await asyncio.Event().wait()
                finally: self.events.append(name+'-settled')
            if self.timeout_at == name:
                try: await asyncio.Event().wait()
                finally: self.events.append(name+'-settled')
            if self.fail_at == name: raise RuntimeError('private-error-canary https://private.invalid')

        def on(self, name, handler):
            assert name == 'console'
            self.events.append('console-attach')
            self.console_listeners.append(handler)

        def remove_listener(self, name, handler):
            assert name == 'console'
            self.events.append('console-detach')
            self.console_listeners.remove(handler)

        async def start(self):
            # Initial committed files must predate manager entry.
            assert (self.output/'summary.json').exists()
            assert (self.output/'lifecycle.json').exists()
            assert json.loads((self.output/'summary.json').read_text())['status'] == 'INCOMPLETE'
            await self.operation('manager-start')
            return self

        async def launch(self,**kwargs):
            await self.operation('launch'); return self
        async def new_context(self): return self
        async def new_page(self): return self
        async def stop(self): await self.operation('manager-stop')
        def set_default_timeout(self,value): pass
        async def add_init_script(self,script): pass
        async def goto(self,*args,**kwargs):
            await self.operation('entry'); return SimpleNamespace(status=200)
        async def wait_for_url(self,*args,**kwargs): pass
        async def wait_for(self,**kwargs): pass
        def locator(self,selector):
            if selector == '#startBtn': return self
            owner = self
            class Login:
                async def fill(self,value): owner.events.append('login-fill')
                async def click(self): owner.events.append('login-click')
                async def wait_for(self,**kwargs): pass
            return Login()
        async def is_visible(self): return True
        async def is_enabled(self): return True
        async def click(self,**kwargs): self.clicks += 1; self.events.append('start-click')
        async def evaluate(self,expression,arg=None):
            assert not self.closed, 'evaluate after close'
            if expression == soak.STARTUP_SUMMARY:
                await self.operation('startup-summary')
                return {'observerAvailable':True,'failureCause':'unknown','uiPhase':'connected'}
            if expression == soak.PROOF_ADMISSION:
                self.proofs += 1; self.events.append('proof'); return 'ready'
            if expression == soak.START_UI_SNAPSHOT:
                return {'shellAvailable':True,'clientAvailable':True,'marksAvailable':True,
                    'coreInstalled':True,'authVerified':True,'queuedStart':False,
                    'socketPresent':False,'pcPresent':False,'attemptPresent':False,
                    'admissionCurrent':self.proofs == 1,'htmlShellMarks':1,
                    'coreInteractiveMarks':1,'startClickMarks':self.clicks}
            if expression.startswith('/* Acceptance observer'):
                await self.operation('observer-install'); return None
            if expression == soak.FINAL_EXPORT:
                await self.operation('export')
                if self.malformed_export: return {'private-canary':'secret'}
                value = json.loads(json.dumps(self.diagnostic))
                value['events'].append({'t':21,'n':len(value['events'])+1,'k':'preclose'})
                self.events.append('preclose')
                return value
            if expression == '() => window.__wrdPassiveSampler.sample()':
                await self.operation('sample')
                self.sample_count += 1
                sample = row(self.sample_count)['sample']
                sample['attempt'] = 'private-attempt-canary'
                sample['socketConnected'] = self.sample_count == 1 or not self.disconnected
                sample['callbacks'] = 2+self.sample_count
                if self.sample_count > 1:
                    sample['diagnostics'] = {'schemaVersion':1,'events':self.diagnostic['events'],
                        'cursor':len(self.diagnostic['events']),'gap':0,'truncated':False,'droppedEvents':0,
                        'coverageStatus':'partial','firstDisconnectEvent':self.diagnostic['attribution']['firstDisconnectEvent'],
                        'cause':'unknown'}
                    if self.malformed_delta: sample['diagnostics']['secret'] = 'private-canary'
                return sample
            raise AssertionError('unexpected evaluate')
        async def close(self):
            # Both preliminary artifacts, original strict failure and exported
            # preclose event are committed before the first browser close call.
            self.events.append('preliminary-check')
            assert self.console_listeners == [self.product_console], 'owned console observer must detach before close'
            lifecycle = json.loads((self.output/'lifecycle.json').read_text())
            summary = json.loads((self.output/'summary.json').read_text())
            assert lifecycle['python']['browserClose']['status'] == 'not-created'
            assert summary['status'] == 'INCOMPLETE'
            if lifecycle['captureStatus'] == 'ok':
                assert lifecycle['diagnostics']['events'][-1]['k'] == 'preclose'
            await self.operation('close')
            self.closed = True

    async def execute(self, rig, **kwargs):
        modules = {'dotenv':SimpleNamespace(dotenv_values=lambda _: {})}
        factory = kwargs.pop('manager_factory',lambda:rig)
        with patch.dict('sys.modules',modules), \
             patch.dict(os.environ,{'VIEWER_ACCESS_PASSWORD':'private-password-canary'}), \
             patch('builtins.print'):
            return await soak.run(SimpleNamespace(origin='https://fixture.invalid',output_dir=rig.output,
                duration_seconds=1,mode='relay',runtime_config=None),manager_factory=factory,
                limits={key:.08 for key in ('managerStart','managerLaunch','export','browserClose','managerStop')},
                **kwargs)

    def artifacts(self, rig):
        lifecycle = json.loads((rig.output/'lifecycle.json').read_text())
        summary = json.loads((rig.output/'summary.json').read_text())
        for name in ('lifecycle.json','summary.json','samples.jsonl'):
            self.assertEqual((rig.output/name).stat().st_mode & 0o777,0o600)
        self.assertEqual(rig.output.stat().st_mode & 0o777,0o700)
        self.assertLessEqual((rig.output/'lifecycle.json').stat().st_size,32768)
        self.assertNotIn('private-',json.dumps((lifecycle,summary)))
        self.assertEqual(lifecycle['ownedProcessExitEvidence'],'not-observed')
        self.assertEqual(summary['status'],'INCOMPLETE')
        return lifecycle,summary

    async def test_startup_is_immutable_when_post_failure_state_changes(self):
        class ChangedRig(self.Rig):
            captures = 0
            async def evaluate(self, expression, arg=None):
                if expression == soak.STARTUP_SUMMARY:
                    self.captures += 1
                    return {'observerAvailable':True, 'failureCause':'unknown','browserNowMs':104 if self.captures == 1 else 207,
                        'uiPhase':'connected' if self.captures == 1 else 'disconnected',
                        'inputGate':gate_value(),'startupMarks':dict.fromkeys(soak.MARK_NAMES)}
                return await super().evaluate(expression, arg)
        with tempfile.TemporaryDirectory() as directory:
            rig = ChangedRig(Path(directory)/'evidence')
            self.assertEqual(await self.execute(rig), 1)
            _, summary = self.artifacts(rig)
            self.assertEqual(summary['startupSummary']['uiPhase'], 'connected')
            self.assertEqual(summary['failureSnapshot']['state']['uiPhase'], 'disconnected')
            self.assertEqual(summary['startupSnapshot']['state'],summary['startupSummary'])
            self.assertEqual(summary['startupSnapshot']['browserNowMs'],104)
            self.assertEqual(summary['failureSnapshot']['browserNowMs'],207)
            self.assertEqual(summary['startupSnapshot']['browserClock'],'performance-now')
            self.assertEqual(summary['startupSnapshot']['pythonClock'],'monotonic')
            self.assertEqual(summary['startupSnapshot']['stage'], 'startup-baseline')
            self.assertEqual(summary['failureSnapshot']['stage'], 'post-failure-preclose')
            self.assertLessEqual(summary['startupSnapshot']['pythonCompletedMs'],
                summary['failureSnapshot']['pythonRequestedMs'])

    async def test_persisted_gate_failure_observation_and_prestart_console_are_separate(self):
        class EvidenceRig(self.Rig):
            captures = 0
            async def click(self,**kwargs):
                await super().click(**kwargs)
                message=SimpleNamespace(type='log',text='[PAINT-GATE] uiPhase=disconnected reason=first-frame-timeout painted=false')
                for listener in list(self.console_listeners): listener(message)
            async def evaluate(self,expression,arg=None):
                if expression == soak.STARTUP_SUMMARY:
                    self.captures += 1
                    return {'observerAvailable':True,'uiPhase':'disconnected','browserNowMs':100*self.captures,
                        'inputGate':{**gate_value(),'allowed':False,'inputActive':False,'blockedReasons':['inactive']},
                        'startupMarks':{**dict.fromkeys(soak.MARK_NAMES),'active':91,'first-frame':91}}
                value=await super().evaluate(expression,arg)
                if expression == '() => window.__wrdPassiveSampler.sample()':
                    value.update(browserNowMs=self.sample_count*1000,inputGate={**gate_value(),
                        'allowed':False,'inputActive':False,'uiPhase':'disconnected',
                        'hasPaintedFrame':True,'currentAttemptReady':True,'hasActiveControl':True,
                        'socketConnected':value['socketConnected'],'blockedReasons':['inactive']},inputAllowed=False)
                return value
            async def close(self):
                self.preclose_summary=(self.output/'summary.json').read_bytes()
                await super().close()
        with tempfile.TemporaryDirectory() as directory:
            rig=EvidenceRig(Path(directory)/'evidence')
            self.assertEqual(await self.execute(rig),1)
            _,summary=self.artifacts(rig)
            preliminary=json.loads(rig.preclose_summary)
            self.assertEqual(preliminary['startupSummary'],summary['startupSummary'])
            self.assertEqual(preliminary['startupSnapshot'],summary['startupSnapshot'])
            self.assertEqual(preliminary['failureSnapshot'],summary['failureSnapshot'])
            self.assertEqual(summary['startupSnapshot']['browserNowMs'],100)
            self.assertEqual(summary['failureSnapshot']['browserNowMs'],200)
            self.assertEqual(summary['failureObservation']['browserNowMs'],2000)
            self.assertEqual(summary['failureObservation']['inputGate']['blockedReasons'],['inactive'])
            self.assertEqual(summary['timeoutConsole']['acceptedCount'],1)
            self.assertEqual(summary['timeoutConsole']['firstEvent']['painted'],False)
            self.assertEqual(summary['timeoutConsole']['status'],'detached')
            self.assertEqual(summary['failure']['reason'],'session-changed-or-disconnected')
            rows=[json.loads(line) for line in (rig.output/'samples.jsonl').read_text().splitlines()]
            self.assertFalse(rows[0]['sample']['inputAllowed'])
            self.assertEqual(rows[0]['sample']['inputGate'],summary['failureObservation']['inputGate'])
            self.assertLessEqual(summary['timeoutConsole']['firstEvent']['pythonReceiptMs'],summary['startupSnapshot']['pythonRequestedMs'])

    async def test_postfailure_snapshot_errors_timeout_cancellation_preserve_startup_and_original_failure(self):
        for outcome in ('error','timeout','cancelled','schema-rejected'):
            class Rig(self.Rig):
                captures = 0
                async def evaluate(self,expression,arg=None):
                    if expression == soak.STARTUP_SUMMARY:
                        self.captures += 1
                        if self.captures > 1:
                            if outcome == 'error': raise RuntimeError('private-canary')
                            if outcome == 'timeout': await asyncio.Event().wait()
                            if outcome == 'cancelled': raise asyncio.CancelledError()
                            return {'secret':'private-canary'}
                        return {'uiPhase':'connected','browserNowMs':77}
                    return await super().evaluate(expression,arg)
            with self.subTest(outcome=outcome),tempfile.TemporaryDirectory() as directory:
                rig=Rig(Path(directory)/'evidence')
                self.assertEqual(await self.execute(rig),1)
                _,summary=self.artifacts(rig)
                self.assertEqual(summary['startupSummary'],{'uiPhase':'connected','browserNowMs':77})
                self.assertEqual(summary['startupSnapshot']['status'],'ok')
                self.assertEqual(summary['failureSnapshot']['status'],outcome)
                self.assertIsNone(summary['failureSnapshot']['state'])
                self.assertEqual(summary['failure']['reason'],'session-changed-or-disconnected')
                self.assertEqual(rig.captures,2)
                self.assertLess(rig.events.index('console-detach'),rig.events.index('close'))

    async def test_strict_disconnect_commits_preclose_before_close_and_preserves_first_terminal(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = self.Rig(Path(directory)/'evidence')
            self.assertEqual(await self.execute(rig),1)
            lifecycle,summary = self.artifacts(rig)
            self.assertEqual(summary['failure']['reason'],'session-changed-or-disconnected')
            self.assertEqual(lifecycle['diagnostics']['attribution']['firstDisconnectEvent']['r'],'transport-close')
            self.assertEqual(lifecycle['python']['browserClose']['status'],'closed')
            self.assertEqual(lifecycle['python']['managerStop']['status'],'ok')
            self.assertLess(rig.events.index('preclose'),rig.events.index('close'))
            self.assertLess(rig.events.index('close'),rig.events.index('manager-stop'))
            self.assertEqual((rig.proofs,rig.clicks),(1,1))
            self.assertLess(rig.events.index('observer-install'),rig.events.index('console-attach'))
            self.assertLess(rig.events.index('console-attach'),rig.events.index('start-click'))
            self.assertLess(rig.events.index('console-detach'),rig.events.index('close'))
            self.assertLessEqual(lifecycle['python']['failureDetectedMs'],lifecycle['python']['browserClose']['startedMs'])

    async def test_outer_start_launch_entry_export_close_and_stop_errors_keep_evidence(self):
        for stage in ('manager-start','launch','entry','observer-install','startup-summary','export','close','manager-stop'):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as directory:
                rig = self.Rig(Path(directory)/'evidence',fail_at=stage)
                self.assertEqual(await self.execute(rig),1)
                lifecycle,summary = self.artifacts(rig)
                if stage in ('export','close','manager-stop'):
                    self.assertEqual(summary['failure']['reason'],'session-changed-or-disconnected')
                self.assertIn('manager-stop',rig.events)
                if stage in ('manager-start','launch'): self.assertNotIn('close',rig.events)
                self.assertNotEqual(summary['status'],'PASS')

    async def test_cooperative_deadlines_settle_all_fake_stage_tasks(self):
        for stage in ('manager-start','launch','export','close','manager-stop'):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as directory:
                baseline = set(asyncio.all_tasks())
                rig = self.Rig(Path(directory)/'evidence',timeout_at=stage)
                self.assertEqual(await self.execute(rig),1)
                lifecycle,summary = self.artifacts(rig)
                self.assertIn(stage+'-settled',rig.events)
                self.assertEqual(set(asyncio.all_tasks())-baseline,set())
                key = {'manager-start':'managerStart','launch':'managerLaunch','close':'browserClose','manager-stop':'managerStop'}.get(stage)
                self.assertEqual(lifecycle['python'][key]['status'] if key else lifecycle['captureStatus'],'timeout')
                if stage not in ('manager-start','launch'):
                    self.assertEqual(summary['failure']['reason'],'session-changed-or-disconnected')

    async def test_external_and_repeated_cancellation_during_entry_launch_export_close_stop(self):
        for stage in ('manager-start','launch','export','close','manager-stop'):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as directory:
                baseline = set(asyncio.all_tasks())
                rig = self.Rig(Path(directory)/'evidence',pause_at=stage)
                task = asyncio.create_task(self.execute(rig))
                await asyncio.wait_for(rig.entered.wait(),1)
                task.cancel('first-private-cancel')
                await asyncio.sleep(0)
                task.cancel('second-private-cancel')
                with self.assertRaises(asyncio.CancelledError): await task
                lifecycle,summary = self.artifacts(rig)
                self.assertEqual(set(asyncio.all_tasks())-baseline,set())
                if stage in ('manager-start','launch'):
                    self.assertEqual(summary['failure']['reason'],'cancelled')
                else: self.assertEqual(summary['failure']['reason'],'session-changed-or-disconnected')
                self.assertIn('manager-stop',rig.events)

    async def test_bad_final_snapshot_falls_back_to_validated_last_delta(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = self.Rig(Path(directory)/'evidence',malformed_export=True)
            await self.execute(rig)
            lifecycle,summary = self.artifacts(rig)
            self.assertEqual(lifecycle['captureStatus'],'schema-rejected')
            self.assertEqual(lifecycle['diagnostics']['attribution']['firstDisconnectEvent']['r'],'transport-close')
            self.assertEqual(summary['failure']['reason'],'session-changed-or-disconnected')

    async def test_bad_delta_cannot_reach_sample_or_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = self.Rig(Path(directory)/'evidence',malformed_delta=True)
            await self.execute(rig)
            _,summary = self.artifacts(rig)
            self.assertEqual(summary['failure']['reason'],'sample-continuity-lost')
            self.assertNotIn('private-',(rig.output/'samples.jsonl').read_text())

    async def test_noncooperative_api_is_explicit_gate_failure_never_success(self):
        # Such an API cannot be forcibly settled in-process. Own and release the
        # adversarial fake in the test so the runner itself retains no live task.
        release = asyncio.Event()
        started = asyncio.Event()
        async def resistant():
            started.set()
            try: await release.wait()
            except asyncio.CancelledError: await release.wait()
        child = asyncio.create_task(resistant())
        await started.wait()
        try:
            with self.assertRaises(soak.CancellationCooperationError):
                await soak.lifecycle_stage(child,.04,settlement=.01)
        finally:
            release.set()
            await child
        self.assertTrue(child.done())

    async def test_successful_sampling_still_waits_for_cleanup_before_final_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = self.Rig(Path(directory)/'evidence',disconnected=False)
            self.assertEqual(await self.execute(rig),0)
            summary = json.loads((rig.output/'summary.json').read_text())
            self.assertEqual(summary['status'],'PASS')
            self.assertEqual(summary['activeControl'],'NOT_RUN')
            self.assertEqual(summary['visibleEffect'],'NOT_RUN')
            self.assertEqual(summary['lifecycle']['ownedProcessExitEvidence'],'not-observed')
            self.assertEqual((rig.proofs,rig.clicks),(1,1))

    async def test_missing_observer_and_sample_exception_are_explicit_incomplete(self):
        for fail_sample in (False,True):
            with self.subTest(fail_sample=fail_sample),tempfile.TemporaryDirectory() as directory:
                class Rig(self.Rig):
                    async def evaluate(self,expression,arg=None):
                        if expression == soak.FINAL_EXPORT:
                            self.events.append('export-unavailable'); return None
                        return await super().evaluate(expression,arg)
                rig = Rig(Path(directory)/'evidence',fail_at='sample' if fail_sample else None)
                self.assertEqual(await self.execute(rig),1)
                lifecycle,summary = self.artifacts(rig)
                self.assertEqual(lifecycle['captureStatus'],'unavailable')
                if fail_sample:
                    self.assertEqual(summary['failure']['stage'],'media-start')
                    self.assertIsNone(lifecycle['diagnostics']['attribution']['firstDisconnectEvent'])
                else:
                    self.assertEqual(summary['failure']['reason'],'session-changed-or-disconnected')
                    self.assertIsNotNone(lifecycle['diagnostics']['attribution']['firstDisconnectEvent'])

    async def test_final_write_failure_keeps_committed_preclose_failure_artifacts(self):
        original = soak.atomic_evidence
        with tempfile.TemporaryDirectory() as directory:
            rig = self.Rig(Path(directory)/'evidence')
            def write(path,value,**kwargs):
                if rig.closed: raise OSError('private-filesystem-canary')
                return original(path,value,**kwargs)
            with patch.object(soak,'atomic_evidence',write):
                self.assertEqual(await self.execute(rig),1)
            lifecycle,summary = self.artifacts(rig)
            self.assertEqual(summary['failure']['reason'],'session-changed-or-disconnected')
            self.assertEqual(lifecycle['diagnostics']['events'][-1]['k'],'preclose')
            self.assertEqual(lifecycle['python']['browserClose']['status'],'not-created')
            self.assertFalse(list(rig.output.glob('.*.tmp')))


    async def test_healthy_session_startup_summary_error_and_timeout_cannot_pass(self):
        for outcome in ('error','timeout'):
            with self.subTest(outcome=outcome),tempfile.TemporaryDirectory() as directory:
                baseline = set(asyncio.all_tasks())
                rig = self.Rig(Path(directory)/'evidence',disconnected=False,
                    fail_at='startup-summary' if outcome == 'error' else None,
                    timeout_at='startup-summary' if outcome == 'timeout' else None)
                self.assertEqual(await self.execute(rig),1)
                lifecycle,summary = self.artifacts(rig)
                self.assertEqual(summary['failure'],{'stage':'startup-summary','category':'runtime',
                    'reason':'startup-summary-deadline' if outcome == 'timeout' else 'startup-summary-unavailable'})
                self.assertEqual(summary['samples'],0)
                self.assertEqual(rig.sample_count,1)
                self.assertEqual((rig.proofs,rig.clicks),(1,1))
                self.assertEqual(lifecycle['diagnostics']['state']['socketState'],'connected')
                self.assertIsNone(lifecycle['diagnostics']['attribution']['firstDisconnectEvent'])
                self.assertEqual(lifecycle['python']['browserClose']['status'],'closed')
                self.assertEqual(lifecycle['python']['managerStop']['status'],'ok')
                self.assertEqual(set(asyncio.all_tasks())-baseline,set())

    async def test_initial_artifact_failure_aborts_before_manager_factory_and_keeps_other_artifact(self):
        original = soak.atomic_evidence
        for failed_name in ('lifecycle.json','summary.json'):
            with self.subTest(failed_name=failed_name),tempfile.TemporaryDirectory() as directory:
                rig = self.Rig(Path(directory)/'evidence',disconnected=False)
                attempts,constructions = [],[]
                def factory():
                    constructions.append('constructed')
                    return rig
                def write(path,value,**kwargs):
                    attempts.append((path.name,kwargs.get('initial',False),json.loads(json.dumps(value))))
                    if path.name == failed_name: raise OSError('private-initial-write-canary')
                    return original(path,value,**kwargs)
                with patch.object(soak,'atomic_evidence',write):
                    self.assertEqual(await self.execute(rig,manager_factory=factory),1)
                self.assertEqual(constructions,[])
                self.assertEqual(rig.events,[])
                self.assertEqual((rig.proofs,rig.clicks,rig.sample_count),(0,0,0))
                self.assertEqual([(name,initial) for name,initial,_ in attempts[:2]],
                    [('lifecycle.json',True),('summary.json',True)])
                self.assertEqual((rig.output/'samples.jsonl').read_text(),'')
                successful_name = 'summary.json' if failed_name == 'lifecycle.json' else 'lifecycle.json'
                retained = json.loads((rig.output/successful_name).read_text())
                self.assertEqual((rig.output/successful_name).stat().st_mode & 0o777,0o600)
                self.assertFalse((rig.output/failed_name).exists())
                summary_attempts = [value for name,_,value in attempts if name == 'summary.json']
                self.assertEqual(summary_attempts[-1]['status'],'INCOMPLETE')
                self.assertEqual(summary_attempts[-1]['failure']['reason'],'evidence-write-failed')
                self.assertEqual(summary_attempts[-1]['failure']['stage'],'not-started')
                if successful_name == 'summary.json':
                    self.assertEqual(retained['failure']['reason'],'evidence-write-failed')
                else:
                    self.assertEqual(retained['writeStatus'],'error')
                    self.assertIsNotNone(retained['python']['failureDetectedMs'])
                    self.assertEqual(retained['python']['managerStart']['status'],'not-started')
                self.assertNotIn('private-',json.dumps(retained))


class LifecycleBoundaryTest(unittest.TestCase):
    def test_each_allowlist_and_numeric_boundary_rejects_malformed_or_canary(self):
        import copy
        good = soak.empty_diagnostic()
        mutations = [
            lambda d:d.update(private='private-canary'),
            lambda d:d.update(schemaVersion=True),
            lambda d:d['anchors'].update(browserWallEpochMs=float('nan')),
            lambda d:d['anchors'].update(browserTimeOriginEpochMs=float('inf')),
            lambda d:d['anchors'].update(browserAnchorNowMs=10000000000000),
            lambda d:d['counters'].update(sd=-1),
            lambda d:d['counters'].update(sd=True),
            lambda d:d['counters'].update(sd=1000000000),
            lambda d:d['coverage'].update(transport='https://private.invalid'),
            lambda d:d['coverage'].update(boundAtMs={'s':0,'m':0,'e':'private-id'}),
            lambda d:d['state'].update(visibility='private-canary'),
            lambda d:d['state'].update(focus='private-target'),
            lambda d:d['state']['lag'].update(buckets=[0]*5),
            lambda d:d.update(events=[{'t':0,'n':1,'k':'sd','o':'private-socket-id','c':True,'r':'unknown'}]),
            lambda d:d.update(events=[{'t':0,'n':1,'k':'ec','o':'e1','c':True,'r':'client'}]),
            lambda d:d.update(events=[{'t':0,'n':1,'k':'se','o':'s1','c':True,'r':'private-error'}]),
            lambda d:d.update(events=[{'t':0,'n':1,'k':'sd','o':'s1','c':True,'r':'unknown','payload':'private-input'}]),
            lambda d:d.update(events=[{'t':0,'n':1,'k':'rx','o':'e1','c':True,'p':'private-packet'}]),
            lambda d:d.update(events=[{'t':43320001,'n':1,'k':'preclose'}]),
            lambda d:d.update(events=[{'t':0.1,'n':1,'k':'preclose'}]),
            lambda d:d.update(events=[{'t':0,'n':0,'k':'preclose'}]),
            lambda d:d.update(events=[{'t':0,'n':1,'k':'preclose'}]*129),
        ]
        for mutation in mutations:
            candidate = copy.deepcopy(good); mutation(candidate)
            with self.subTest(candidate=candidate),self.assertRaises(ValueError):
                soak.validate_diagnostic(candidate)
        delta = {'schemaVersion':1,'events':[],'cursor':0,'gap':0,'truncated':False,
            'droppedEvents':0,'coverageStatus':'unavailable','firstDisconnectEvent':None,'cause':'unknown'}
        self.assertEqual(soak.validate_delta(delta),delta)
        for patch in ({'cursor':float('inf')},{'gap':-1},{'truncated':1}, {'cause':'private-canary'},
                      {'events':[{'t':0,'n':1,'k':'preclose'}]*17},{'private':'canary'}):
            with self.subTest(patch=patch),self.assertRaises(ValueError):
                soak.validate_delta({**delta,**patch})

    def test_ec_optional_ws_exact_types_and_legacy_compatibility(self):
        base = {'t':0,'n':1,'k':'ec','o':'e1','c':True,'r':'transport-close'}
        self.assertEqual(soak.validate_event(base),base)
        for code, clean in [(1000,True),(1006,False),(1005,False),(1015,False),(4999,True)]:
            event = {**base,'ws':{'code':code,'wasClean':clean}}
            self.assertEqual(soak.validate_event(event),event)
        invalid = [None,[],{}, {'code':1006}, {'wasClean':False},
                   {'code':1006,'wasClean':False,'reason':'private-canary'},
                   *[{'code':code,'wasClean':False} for code in
                     [True,1000.0,1000.5,float('nan'),float('inf'),'1006',999,5000]],
                   {'code':1006,'wasClean':'false'}]
        for ws in invalid:
            with self.subTest(ws=ws),self.assertRaises(ValueError):
                soak.validate_event({**base,'ws':ws})
        for kind, label in [('sd','s1'),('mc','m1'),('se','s1'),('re','m1'),('ep','e1')]:
            event = {**base,'k':kind,'o':label,'r':'unknown'}
            if kind == 'ep': del event['r']
            with self.subTest(kind=kind),self.assertRaises(ValueError):
                soak.validate_event({**event,'ws':{'code':1006,'wasClean':False}})

    def test_two_final_files_reserved_and_atomic_replacement_modes_and_caps(self):
        writer = EvidenceWriter(io.StringIO())
        self.assertEqual(writer.max_bytes,67108864-2*32768)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)/'lifecycle.json'
            soak.atomic_evidence(target,{'status':'initial'},initial=True)
            with self.assertRaises(ValueError): soak.atomic_evidence(target,{'x':'x'*32768})
            self.assertEqual(json.loads(target.read_text()),{'status':'initial'})
            soak.atomic_evidence(target,{'status':'final'})
            self.assertEqual(json.loads(target.read_text()),{'status':'final'})
            self.assertEqual(target.stat().st_mode & 0o777,0o600)
            self.assertEqual(list(Path(directory).iterdir()),[target])

    def test_production_js_snapshot_and_delta_pass_actual_python_validator(self):
        import subprocess
        script = r'''
const vm=require('node:vm'),fs=require('node:fs'),{EventEmitter}=require('node:events');
let timer=0;
const engine=Object.assign(new EventEmitter(),{transport:{name:'websocket'}});
const manager=Object.assign(new EventEmitter(),{engine});
const socket=Object.assign(new EventEmitter(),{io:manager,connected:false});
const context={window:{},document:{getElementById:()=>null},WebRTC:{socket,uiPhase:'disconnected',hasPaintedFrame:true},
Input:{isActive:false,getEffectiveInputGate:()=>({allowed:false,blockedReasons:['inactive','private-canary']})},
StartupTelemetry:{snapshot:()=>({marks:[{name:'first-frame',atMs:400,detail:'private-canary'},{name:'private-canary',atMs:42}],resources:['private-canary']})},
performance:{now:()=>500,timeOrigin:1800000000000},setTimeout:()=>++timer,clearTimeout:()=>{}};
vm.runInNewContext(fs.readFileSync('scripts/passive_session_sampler.js','utf8'),context);
socket.emit('disconnect','transport close');
engine.emit('close','transport close',{description:'websocket connection closed',context:{code:1006,wasClean:false,reason:'private-canary',url:'https://private.invalid'}});
(async()=>{const sampler=context.window.__wrdPassiveSampler;
const sample=await sampler.sample();const snapshot=sampler.finalize();
process.stdout.write(JSON.stringify({snapshot,delta:sample.diagnostics,sample,capture:sampler.evidenceSnapshot()}));})();'''
        child = subprocess.run(['node','-e',script],cwd=Path(__file__).resolve().parents[1],
            capture_output=True,text=True,check=True,timeout=2)
        value = json.loads(child.stdout)
        soak.validate_diagnostic(value['snapshot'])
        soak.validate_delta(value['delta'])
        soak.validate_gate_fields(value['capture'])
        self.assertEqual(value['sample']['inputGate']['blockedReasons'],['inactive','unknown'])
        self.assertEqual(value['sample']['inputAllowed'],False)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)/'sample.jsonl'
            with target.open('w') as stream:
                EvidenceWriter(stream).write({'sample':private_row(value['sample'],b'salt')})
            saved = json.loads(target.read_text())
            soak.validate_gate_fields(saved['sample'])
            self.assertEqual(saved['sample']['startupMarks']['first-frame'],400)
            self.assertNotIn('private-',target.read_text())
        self.assertEqual(value['snapshot']['state']['socketState'],'state-observed-disconnected')
        for output in (value['snapshot'],value['delta']):
            self.assertEqual(next(e for e in output['events'] if e['k'] == 'ec')['ws'],
                             {'code':1006,'wasClean':False})
            first = output.get('firstDisconnectEvent',output.get('attribution',{}).get('firstDisconnectEvent'))
            self.assertEqual(first['k'],'sd')
            self.assertNotIn('ws',first)
        self.assertNotIn('private-',child.stdout)
        self.assertLessEqual(len(soak.compact(value['delta'])),4096)
        self.assertLessEqual(len(soak.compact(value['snapshot'])),32768)

class GateEvidenceBoundaryTest(unittest.TestCase):
    def test_gate_states_reasons_nullable_values_and_all_persistence_boundaries(self):
        import copy
        good = gate_value()
        for reason in soak.GATE_REASONS:
            value = {**good,'blockedReasons':[reason]}
            soak.validate_gate(value)
        for key,values in soak.GATE_ENUMS.items():
            for value in values: soak.validate_gate({**good,key:value})
        for key in soak.GATE_BOOLEANS:
            for value in (True,False,None): soak.validate_gate({**good,key:value})
        for status in ('unavailable','scope-changed'): soak.validate_gate(gate_value(status))
        mutations = [lambda g:g.update(secret='private-canary'),lambda g:g.pop('allowed'),
            lambda g:g.update(status='private-canary'),lambda g:g.update(blockedReasons=['private-canary']),
            lambda g:g.update(blockedReasons=['inactive','inactive']),lambda g:g.update(blockedReasons=['inactive']*33),
            lambda g:g.update(blockedReasons=[{}]),lambda g:g.update(blockedReasons=None),
            *[lambda g,k=k:g.update({k:1}) for k in soak.GATE_BOOLEANS],
            *[lambda g,k=k:g.update({k:'private-canary'}) for k in soak.GATE_ENUMS],
            lambda g:g.update(status='scope-changed',allowed=False)]
        for mutate in mutations:
            value = copy.deepcopy(good);mutate(value)
            with self.subTest(value=value):
                with self.assertRaises(ValueError): private_row({'inputGate':value},b'salt')
                stream=io.StringIO()
                with self.assertRaises(ValueError): EvidenceWriter(stream).write({'sample':{'inputGate':value}})
                self.assertEqual(stream.getvalue(),'')
                with tempfile.TemporaryDirectory() as directory:
                    target=Path(directory)/'summary.json'
                    with self.assertRaises(ValueError): soak.atomic_evidence(target,{'inputGate':value},initial=True)
                    self.assertFalse(target.exists())
        # Legacy rows remain readable and verdicts retain their old meaning.
        soak.validate_additive_evidence({'startupSummary':{'uiPhase':'connected'}})
        self.assertEqual(private_row({'inputAllowed':False},b'salt')['inputAllowed'],False)

    def test_marks_snapshots_clock_types_and_canaries_rejected_before_atomic_replace(self):
        import copy
        state={'uiPhase':'disconnected','browserNowMs':150.5,'inputGate':gate_value(),
            'startupMarks':dict.fromkeys(soak.MARK_NAMES)}
        capture=soak.empty_capture('startup-baseline')
        capture.update(status='ok',state=state,browserNowMs=150.5,pythonRequestedMs=200,pythonCompletedMs=201)
        soak.validate_capture(capture)
        mutations=[lambda c:c.update(secret='private-canary'),lambda c:c.update(browserClock='wall'),
            lambda c:c.update(pythonClock='browser'),lambda c:c.update(status='private-canary'),
            lambda c:c.update(stage='private-canary'),lambda c:c.update(pythonCompletedMs=199),
            lambda c:c.update(browserNowMs=151),lambda c:c['state'].update(secret='private-canary'),
            lambda c:c['state']['startupMarks'].update(secret='private-canary'),
            lambda c:c['state']['startupMarks'].pop('active'),
            *[lambda c,v=v:c.update(pythonRequestedMs=v) for v in (True,-1,float('inf'),float('nan'),'private-canary',1e14)],
            *[lambda c,v=v:c['state']['startupMarks'].update(active=v) for v in (True,-1,float('inf'),'private-canary',1e14)]]
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'summary.json'
            original={'startupSnapshot':capture,'startupSummary':state}
            soak.atomic_evidence(target,original,initial=True)
            prior=target.read_bytes()
            for mutate in mutations:
                value=copy.deepcopy(capture);mutate(value)
                with self.subTest(value=value),self.assertRaises(ValueError):
                    soak.atomic_evidence(target,{'startupSnapshot':value})
                self.assertEqual(target.read_bytes(),prior)
                self.assertFalse(list(Path(directory).glob('.*.tmp')))
            for status in ('not-reached','unavailable','timeout','schema-rejected','cancelled','error'):
                value=soak.empty_capture('post-failure-preclose');value['status']=status
                soak.atomic_evidence(target,{'failureSnapshot':value})
                self.assertEqual(json.loads(target.read_text())['failureSnapshot']['status'],status)


class TimeoutConsoleTest(unittest.TestCase):
    class Page:
        def __init__(self): self.listeners=[lambda message: None]
        def on(self,name,handler): self.listeners.append(handler)
        def remove_listener(self,name,handler): self.listeners.remove(handler)
        def emit(self,message):
            for listener in list(self.listeners): listener(message)

    def test_exact_positive_lines_first_event_receipt_time_cap_and_owned_cleanup(self):
        page=self.Page();product=page.listeners[0]
        observer=soak.TimeoutConsoleObserver()
        with patch.object(soak,'monotonic_ms',side_effect=range(100,200)):
            observer.attach(page)
            prefix='[PAINT-GATE] uiPhase=disconnected reason=first-frame-timeout painted='
            for painted in (True,False): page.emit(SimpleNamespace(type='log',text=prefix+str(painted).lower()))
            first=json.loads(json.dumps(observer.value['firstEvent']))
            self.assertEqual(first,{'class':'first-frame-timeout-transition','painted':True,'pythonReceiptMs':101})
            for text in ('prefix '+prefix+'true',prefix+'true private-secret',prefix+'true\n',prefix+'true\n'+prefix+'false',
                prefix+'TRUE',prefix+'<html>',prefix+'false'+'x'*128,
                prefix.replace('disconnected','connected')+'true',prefix.replace('first-frame-timeout','secret-reason')+'true'):
                page.emit(SimpleNamespace(type='log',text=text))
            page.emit(SimpleNamespace(type='warning',text=prefix+'true'))
            self.assertEqual(observer.value['acceptedCount'],2)
            for _ in range(100): page.emit(SimpleNamespace(type='log',text=prefix+'false'))
            self.assertEqual(observer.value['acceptedCount'],64)
            self.assertTrue(observer.value['capped'])
            self.assertEqual(observer.value['firstEvent'],first)
            observer.detach();observer.detach()
            self.assertEqual(page.listeners,[product])
            self.assertEqual(observer.value['status'],'detached')
            self.assertTrue(observer.value['installedBeforeStart'])
            observer.observe(SimpleNamespace(type='log',text=prefix+'false'))
            self.assertEqual(observer.value['firstEvent'],first)
            with tempfile.TemporaryDirectory() as directory:
                target=Path(directory)/'summary.json'
                soak.atomic_evidence(target,{'timeoutConsole':observer.value},initial=True)
                saved=json.loads(target.read_text())['timeoutConsole']
                self.assertEqual(saved['acceptedCount'],64)
                self.assertEqual(saved['firstEvent'],first)
                self.assertNotIn('private-',target.read_text())
                self.assertNotIn('painted=',target.read_text())

    def test_missing_failed_parser_and_detach_coverage_never_throw_or_remove_product(self):
        observer=soak.TimeoutConsoleObserver();observer.attach(object())
        self.assertEqual(observer.value['status'],'unavailable')
        class Failed(self.Page):
            def on(self,name,handler):
                super().on(name,handler);raise RuntimeError('private-canary')
        page=Failed();observer.attach(page)
        self.assertEqual(observer.value['status'],'failed')
        self.assertEqual(observer.value['error'],'attach-error')
        self.assertEqual(len(page.listeners),1)
        class Unreadable:
            type='log'
            @property
            def text(self): raise ValueError('private-canary')
            @property
            def args(self): raise AssertionError('must not inspect args')
        page=self.Page();observer=soak.TimeoutConsoleObserver();observer.attach(page)
        page.emit(Unreadable())
        self.assertEqual(observer.value['error'],'parser-error')
        self.assertEqual(observer.value['acceptedCount'],0)
        observer.detach()
        soak.validate_console(observer.value)
        self.assertNotIn('private-',json.dumps(observer.value))
        class FailedDetach(self.Page):
            def remove_listener(self,name,handler): raise RuntimeError('private-canary')
        observer=soak.TimeoutConsoleObserver();observer.attach(FailedDetach());observer.detach()
        self.assertEqual(observer.value['error'],'detach-error')
        observer.observe(SimpleNamespace(type='log',text='[PAINT-GATE] uiPhase=disconnected reason=first-frame-timeout painted=true'))
        self.assertEqual(observer.value['acceptedCount'],0)

    def test_console_schema_is_revalidated_before_every_persistence(self):
        import copy
        good=soak.TimeoutConsoleObserver().value
        for mutate in [lambda c:c.update(secret='private-canary'),lambda c:c.update(status='private-canary'),
            lambda c:c.update(acceptedCount=65),lambda c:c.update(capped=1),lambda c:c.update(attachedMs=float('inf')),
            lambda c:c.update(installedBeforeStart=1),lambda c:c.update(error='private-canary'),
            lambda c:c.update(firstEvent={'class':'first-frame-timeout-transition','painted':False,'pythonReceiptMs':0}),
            lambda c:c.update(acceptedCount=1,firstEvent={'class':'private-canary','painted':False,'pythonReceiptMs':0})]:
            value=copy.deepcopy(good);mutate(value)
            with self.subTest(value=value),tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(ValueError):
                    soak.atomic_evidence(Path(directory)/'summary.json',{'timeoutConsole':value},initial=True)
                self.assertEqual(list(Path(directory).iterdir()),[])


if __name__ == '__main__': unittest.main()
