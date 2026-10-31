"""Offline contracts for layered entry probes and production sampling."""
import io
import json
import socket
import ssl
import tempfile
import unittest
import urllib.error
from pathlib import Path
from scripts.wrd_deadline import Deadline
from scripts.wrd_entry_health import probe_layers


class ProbeLayersTest(unittest.TestCase):
    def test_health_ok_and_core_missing_stay_separate(self):
        responses = {'origin-health': (200, b'{"status":"ok"}'),
                     'formal-health': (200, b'{"status":"ok"}'),
                     'viewer-html': (200, b'<html>fixture</html>'),
                     'core-asset': (404, b'missing')}
        rows = probe_layers({'origin': 'fixture-origin', 'formal': 'fixture-formal',
                             'viewer-html': '/desktop.html',
                             'manifest': {'desktopJs': 'assets/desktop-core.0123456789abcdef.js'}},
                            deadline=Deadline(15, lambda: 0),
                            fetch=lambda layer, **kwargs: responses[layer], now=lambda: 0)
        by_layer = {row['layer']: row for row in rows}
        self.assertEqual(by_layer['formal-health']['outcome'], 'ok')
        self.assertEqual(by_layer['core-asset']['httpStatus'], 404)
        self.assertEqual(by_layer['core-asset']['outcome'], 'failed')
        self.assertEqual(by_layer['login-html']['outcome'], 'unknown')
        self.assertNotIn('checked_url', by_layer['core-asset'])

class ProbeBoundariesTest(unittest.TestCase):
    config = {'origin': 'https://origin.invalid/health', 'formal': 'https://formal.invalid/health',
              'login-html': '/login.html', 'viewer-html': '/desktop.html',
              'manifest': {'assets': {'desktopJs': 'assets/desktop-core.0123456789abcdef.js'}}}

    def rows(self, fetch, **kw):
        return {row['layer']: row for row in probe_layers(self.config, deadline=Deadline(15, lambda: 0),
                                                        fetch=fetch, now=lambda: 0, **kw)}

    def test_proxy_403_retains_status_origin_200_and_redacts_every_field(self):
        def fetch(layer, **kw):
            if layer == 'formal-health':
                raise urllib.error.HTTPError('https://secret.invalid/?token=private', 403, 'raw secret',
                                             {'Via': 'secret proxy'}, io.BytesIO(b'secret body'))
            return (200, b'{"status":"ok"}')
        rows = self.rows(fetch)
        self.assertEqual(rows['origin-health']['outcome'], 'ok')
        self.assertEqual(rows['formal-health']['reason'], 'http-auth')
        self.assertEqual(rows['formal-health']['routeClass'], 'proxy')
        self.assertEqual(rows['formal-health']['httpStatus'], 403)
        text = json.dumps(rows)
        for secret in ('https://', 'secret', 'token=', 'checked_url'):
            self.assertNotIn(secret, text)

    def test_actual_exception_types_classify_dns_tls_connect_and_unknown(self):
        for error, stage, reason, outcome in (
            (urllib.error.URLError(socket.gaierror(-2, 'sensitive host')), 'dns', 'dns-failed', 'failed'),
            (urllib.error.URLError(ssl.SSLError('sensitive certificate')), 'tls', 'tls-failed', 'failed'),
            (ConnectionRefusedError('sensitive address'), 'connect', 'connect-failed', 'failed'),
            (TimeoutError('sensitive body'), 'deadline', 'timeout', 'unknown'),
            (RuntimeError('Cloudflare secret'), 'content', 'unavailable', 'unknown')):
            with self.subTest(reason=reason):
                def fail(*args, **kwargs):
                    raise error
                row = self.rows(fail)['formal-health']
                self.assertEqual((row['stage'], row['reason'], row['outcome']), (stage, reason, outcome))
                self.assertNotIn('sensitive', json.dumps(row))

    def test_oversize_is_detected_for_health_html_and_core(self):
        def fetch(layer, **kw):
            return (200, b'x' * (kw['limit'] + 1))
        for row in self.rows(fetch).values():
            if row['layer'] != 'passive-runtime':
                self.assertEqual(row['reason'], 'content-limit')
                self.assertEqual(row['bytesRead'], (1024*1024 if row['layer'] == 'core-asset' else 65536) + 1)

    def test_no_cross_origin_or_traversal_asset_is_fetched(self):
        for path in ('https://evil.invalid/a.js', '//evil.invalid/a.js', '../assets/a.js',
                     'assets/../a.0123456789abcdef.js', 'assets/%2e%2e/a.js',
                     'assets/a.0123456789abcdef.js?token=private'):
            calls = []
            config = {**self.config, 'manifest': {'desktopJs': path}}
            rows = probe_layers(config, deadline=Deadline(15, lambda: 0), now=lambda: 0,
                                fetch=lambda layer, **kwargs: calls.append(layer) or (200, b'{"status":"ok"}'))
            self.assertNotIn('core-asset', calls)
            self.assertEqual(next(row for row in rows if row['layer'] == 'core-asset')['reason'], 'invalid-manifest')

    def test_missing_html_never_calls_adapter(self):
        calls = []
        rows = probe_layers({'origin': 'fixture', 'formal': 'fixture'}, deadline=Deadline(15, lambda: 0),
                            now=lambda: 0, fetch=lambda layer, **kw: calls.append(layer) or (200, b'{"status":"ok"}'))
        self.assertEqual(calls, ['origin-health', 'formal-health'])
        self.assertEqual(next(row for row in rows if row['layer'] == 'passive-runtime')['outcome'], 'unknown')

    def test_common_budget_exhaustion_stops_following_stages(self):
        clock, calls = [0], []
        deadline = Deadline(15, lambda: clock[0])
        def fetch(layer, **kw):
            self.assertIs(kw['deadline'], deadline)
            calls.append(layer)
            clock[0] += 15
            return (200, b'{"status":"ok"}')
        rows = probe_layers(self.config, deadline=deadline, fetch=fetch, now=lambda: clock[0])
        self.assertEqual(calls, ['origin-health'])
        self.assertTrue(all(row['outcome'] == 'unknown' for row in rows))

    def test_owned_body_hang_and_dns_are_bounded_by_exact_deadline(self):
        from unittest.mock import patch
        from scripts.wrd_entry_health import _owned_fetch
        deadline = Deadline(15, lambda: 0)
        def hung(command, **kw):
            self.assertIs(kw['deadline'], deadline)
            self.assertIn('--probe-worker', command)
            return {'outcome': 'timeout', 'stdout': b'', 'stderr': b'private', 'reaped': True}
        with patch('scripts.wrd_entry_health.run_owned_probe', side_effect=hung):
            row = _owned_fetch('formal-health', target='https://formal.invalid/health', deadline=deadline,
                               limit=65536, proxy_mode='environment')
        self.assertEqual(row['outcome'], 'unknown')
        self.assertEqual(row['reason'], 'deadline-exceeded')
        self.assertNotIn('private', json.dumps(row))

    def test_dns_fallback_ips_share_remaining_budget_and_redact_stderr(self):
        from unittest.mock import patch
        from scripts.wrd_entry_health import _default_resolved_checker
        clock, budgets = [0], []
        deadline = Deadline(15, lambda: clock[0])
        def failure(command, **kw):
            self.assertLessEqual(kw['deadline'].ends_at, deadline.ends_at)
            self.assertFalse(kw['private_group'])
            budgets.append(float(command[command.index('--max-time')+1]))
            clock[0] += 8
            return {'outcome': 'failed', 'stdout': b'', 'stderr': b'secret URL'}
        with patch('scripts.wrd_entry_health.run_owned_probe', side_effect=failure):
            row = _default_resolved_checker('https://fixture.invalid/health', 'fixture.invalid',443,
                                           ['192.0.2.1', '192.0.2.2', '192.0.2.3'], 15, deadline=deadline)
        self.assertEqual(budgets, [14.5, 6.5])
        self.assertEqual(row['resolverMode'], 'configured-public')
        self.assertEqual(row['outcome'], 'unknown')
        self.assertNotIn('secret', json.dumps(row))

    def test_http_body_read_limit_and_explicit_proxy_mode(self):
        from unittest.mock import patch
        from scripts.wrd_entry_health import _http_fetch, _NoRedirectHandler
        sizes = []
        class Response:
            status, headers = 200, {}
            def read(self, size):
                sizes.append(size)
                return b'{"status":"ok"}'
            def close(self):
                pass
        class Opener:
            def open(self, request, timeout):
                return Response()
        for mode in ('environment', 'direct'):
            with patch('scripts.wrd_entry_health.urllib.request.build_opener', return_value=Opener()) as build:
                _http_fetch('https://fixture.invalid', layer='formal-health', deadline=Deadline(15, lambda: 0), limit=65536, proxy_mode=mode)
                self.assertEqual(len(build.call_args.args), 2 if mode == 'direct' else 1)
                self.assertIsInstance(build.call_args.args[0], _NoRedirectHandler)
        self.assertEqual(sizes, [65537, 65537])

class ProductionSamplerTest(unittest.TestCase):
    def test_production_entry_paths_match_served_assets(self):
        from scripts.wrd_watch_coordinator import DEFAULT_ENTRY_PATHS, LayeredSampler
        self.assertEqual(DEFAULT_ENTRY_PATHS, {'login-html': '/index.html', 'viewer-html': '/viewer.html'})
        calls = []
        def fetch(layer, **kwargs):
            calls.append((layer, kwargs['target']))
            return 200, b'{"status":"ok"}' if layer.endswith('-health') else b'<html>served</html>'
        sampler = LayeredSampler({
            'origin': 'https://link.stockhub.wiki/health',
            'formal': 'https://link.stockhub.wiki/health',
            **DEFAULT_ENTRY_PATHS,
            'manifest': {'desktopJs': 'assets/desktop-core.0123456789abcdef.js'},
        }, fetch=fetch, now=lambda: 0)
        rows = {row['layer']: row for row in sampler()['probes']}
        self.assertEqual(rows['login-html']['outcome'], 'ok')
        self.assertEqual(rows['viewer-html']['outcome'], 'ok')
        self.assertEqual(rows['core-asset']['outcome'], 'ok')
        self.assertIn(('login-html', 'https://link.stockhub.wiki/index.html'), calls)
        self.assertIn(('viewer-html', 'https://link.stockhub.wiki/viewer.html'), calls)
        self.assertIn(('core-asset', 'https://link.stockhub.wiki/assets/desktop-core.0123456789abcdef.js'), calls)

    def test_passive_external_target_is_rejected_without_network(self):
        from scripts.wrd_watch_coordinator import read_local_passive_runtime
        row = read_local_passive_runtime(deadline=Deadline(15, lambda: 0), base_url='https://external.invalid')
        self.assertEqual((row['outcome'], row['reason']), ('unknown', 'invalid-target'))

    def test_local_passive_runtime_is_bounded_and_metadata_only(self):
        from unittest.mock import patch
        from scripts.wrd_watch_coordinator import read_local_passive_runtime
        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, _):
                return b'{"status":"ok","hostOnline":true,"viewerCount":1,"relayViewerCount":0,"mediaState":"suspended","mediaFresh":false,"mediaStateAgeMs":1200,"secret":"drop"}'
        class Opener:
            def open(self, request, timeout):
                self.request, self.timeout = request, timeout
                return Response()
        opener = Opener()
        with patch('scripts.wrd_watch_coordinator.urllib.request.build_opener', return_value=opener):
            row = read_local_passive_runtime(deadline=Deadline(15, lambda: 0))
        self.assertEqual(row['outcome'], 'ok')
        self.assertEqual(row['stage'], 'passive')
        self.assertEqual(row['runtime'], {'hostOnline': True, 'mediaFresh': False,
                                          'viewerCount': 1, 'relayViewerCount': 0,
                                          'mediaState': 'suspended', 'mediaStateAgeMs': 1200})
        self.assertNotIn('secret', json.dumps(row))

    def test_asset_300_health_60_cadence_skip_tick_and_no_recovery_on_asset_failure(self):
        from scripts.wrd_watch_coordinator import WatchCoordinator, LayeredSampler
        from scripts.wrd_watch_runtime import WatchRuntime
        clock, calls, workers = [0], [], []
        def fetch(layer, **kw):
            calls.append((clock[0], layer))
            return (404, b'missing') if layer == 'core-asset' else (200, b'{"status":"ok"}')
        sample = LayeredSampler(ProbeBoundariesTest.config, now=lambda: clock[0], fetch=fetch)
        with tempfile.TemporaryDirectory() as directory:
            runtime = WatchRuntime(clock_epoch='fixture')
            coordinator = WatchCoordinator(runtime=runtime, state_path=Path(directory)/'state', sample=sample,
                preflight=lambda: True, start_worker=lambda: workers.append(True), now=lambda: clock[0])
            for tick in (0, 30, 60, 120, 180, 240, 300, 600):
                clock[0] = tick
                coordinator.step()
            self.assertEqual([at for at, layer in calls if layer == 'formal-health'], [0,60,120,180,240,300,600])
            self.assertEqual([at for at, layer in calls if layer == 'core-asset'], [0,300,600])
            self.assertEqual(runtime.snapshot()['lastTick']['skippedTicks'], 4)
            self.assertEqual(workers, [])
            self.assertEqual(runtime.snapshot()['status'], 'entry-degraded')
            self.assertNotIn('https://', (Path(directory)/'state').read_text())

    def test_auth_passive_unknown_and_asset_only_failure_do_not_recover(self):
        from scripts.wrd_watch_coordinator import LayeredSampler
        from scripts.wrd_watch_runtime import WatchRuntime
        for failure in ('auth', 'unknown', 'assets', 'passive'):
            clock = [0]
            def fetch(layer, **kw):
                if failure == 'unknown' and layer == 'formal-health':
                    raise RuntimeError('private exception')
                if failure == 'auth' and layer == 'formal-health':
                    return 403, b'proxy login'
                if failure == 'assets' and layer == 'core-asset':
                    return 404, b'missing'
                return 200, b'{"status":"ok"}'
            def missing_passive():
                raise RuntimeError('private passive summary')
            sampler = LayeredSampler(ProbeBoundariesTest.config, now=lambda: clock[0], fetch=fetch,
                                     passive_summary=missing_passive)
            runtime = WatchRuntime(clock_epoch='fixture')
            for tick in range(0, 1201, 60):
                clock[0] = tick
                state = runtime.tick(tick, sampler())
                self.assertEqual(state['action'], 'none', failure)
                passive = next(row for row in state['probeLayers'] if row['layer'] == 'passive-runtime')
                self.assertEqual(passive['outcome'], 'unknown')
            self.assertIsNone(state['failStartedAt'])
            self.assertNotIn('private', json.dumps(state))

    def test_only_continuous_known_formal_health_failure_consumes_existing_policy(self):
        from scripts.wrd_watch_coordinator import LayeredSampler
        from scripts.wrd_watch_runtime import WatchRuntime
        clock, status = [0], [503]
        def fetch(layer, **kw):
            return (status[0], b'failed') if layer == 'formal-health' else (200, b'{"status":"ok"}')
        sampler = LayeredSampler(ProbeBoundariesTest.config, now=lambda: clock[0], fetch=fetch,
                                 proxy_mode='direct')
        runtime = WatchRuntime(clock_epoch='fixture')
        for tick in (0,60,120):
            clock[0] = tick
            self.assertEqual(runtime.tick(tick, sampler())['action'], 'none')
        status[0], clock[0] = 403, 180
        self.assertEqual(runtime.tick(180, sampler())['action'], 'none')
        self.assertIsNone(runtime.snapshot()['failStartedAt'])
        status[0] = 503
        for tick in (240,300,360):
            clock[0] = tick
            self.assertEqual(runtime.tick(tick, sampler())['action'], 'none')
        clock[0] = 420
        self.assertEqual(runtime.tick(420, sampler())['action'], 'restart')
        self.assertTrue(runtime.begin_recovery('fixture-operation'))
        self.assertEqual(runtime.snapshot()['recoveries'], [420])

    def test_runtime_filters_unknown_keys_and_cannot_override_layers_with_booleans(self):
        from scripts.wrd_entry_health import probe_result
        from scripts.wrd_watch_runtime import WatchRuntime
        runtime = WatchRuntime(clock_epoch='fixture')
        for tick in (0, 180, 360):
            state = runtime.tick(tick, {'origin': True, 'formal': False, 'probes': [
                {**probe_result('origin-health', outcome='ok', reason='ok'), 'rawUrl': 'private'},
                {**probe_result('formal-health', outcome='unknown'), 'exception': 'private'}]})
            self.assertEqual(state['action'], 'none')
            self.assertIsNone(state['observations']['formal'])
        self.assertNotIn('private', json.dumps(state))


class OwnedFixtureDeadlineTest(unittest.TestCase):
    def test_real_owned_fixture_children_hanging_in_dns_or_body_are_reaped(self):
        # These are pure fake openers in disposable Python children: no socket,
        # service, native input, Viewer, tunnel or deployed file is touched.
        from unittest.mock import patch
        import sys
        from scripts.wrd_deadline import run_owned_probe
        from scripts.wrd_entry_health import _owned_fetch
        for stage in ('dns', 'body'):
            records = []
            code = """
import time
from scripts.wrd_entry_health import _http_fetch
from scripts.wrd_deadline import Deadline
class Response:
    status, headers = 200, {}
    def read(self, size):
        print('body', flush=True)
        time.sleep(60)
    def close(self): pass
class Opener:
    def open(self, request, timeout):
        if STAGE == 'dns':
            print('dns', flush=True)
            time.sleep(60)
        return Response()
_http_fetch('https://fixture.invalid', layer='formal-health', deadline=Deadline(60),
            limit=65536, proxy_mode='environment', opener=Opener())
""".replace('STAGE', repr(stage))
            def fixture_child(command, **kw):
                result = run_owned_probe([sys.executable, '-c', code], **kw)
                records.append(result)
                return result
            with patch('scripts.wrd_entry_health.run_owned_probe', side_effect=fixture_child):
                row = _owned_fetch('formal-health', target='https://fixture.invalid',
                                   deadline=Deadline(0.7), limit=65536, proxy_mode='environment')
            self.assertEqual(row['reason'], 'deadline-exceeded')
            self.assertEqual(row['outcome'], 'unknown')
            self.assertEqual(records[0]['outcome'], 'timeout')
            self.assertTrue(records[0]['reaped'])
            self.assertIn(stage.encode(), records[0]['stdout'])


class NestedFallbackLifecycleTest(unittest.TestCase):
    def test_nested_dns_and_curl_helpers_never_escape_outer_probe_timeout(self):
        import os
        import signal
        import sys
        import time
        from scripts.wrd_deadline import run_owned_probe
        for helper in ('dns', 'curl'):
            with self.subTest(helper=helper), tempfile.TemporaryDirectory() as directory:
                marker = Path(directory)/'leaf.json'
                leaf = ("import json,os,time; "
                        "open(" + repr(str(marker)) + ",'w').write(json.dumps({'pid':os.getpid(),'pgid':os.getpgrp()})); "
                        "time.sleep(60)")
                code = """
import json,os,sys,time
from unittest.mock import patch
from scripts.wrd_deadline import Deadline,run_owned_probe
import scripts.wrd_entry_health as entry
actual_runner = run_owned_probe
def fixture_runner(command, **kwargs):
    return actual_runner([sys.executable, '-c', LEAF],
                         **{**kwargs, 'allowed_executables': {sys.executable}})
print(json.dumps({'workerPid':os.getpid(),'workerGroup':os.getpgrp()}), flush=True)
with patch.object(entry, 'run_owned_probe', side_effect=fixture_runner):
    deadline = Deadline(60)
    if HELPER == 'dns':
        entry._default_public_resolver('fixture.invalid', deadline=deadline)
    else:
        entry._default_resolved_checker('https://fixture.invalid/health','fixture.invalid',443,
                                        ['192.0.2.1'],60,deadline=deadline)
""".replace('LEAF', repr(leaf)).replace('HELPER', repr(helper))
                total_deadline = Deadline(1.5)
                result = run_owned_probe([sys.executable, '-c', code], deadline=total_deadline,
                                         allowed_executables={sys.executable})
                record = json.loads(marker.read_text())
                worker = json.loads(result['stdout'])
                # Always clean up exactly the disposable child on RED too.
                try:
                    try:
                        os.kill(record['pid'], 0)
                        alive = True
                    except ProcessLookupError:
                        alive = False
                    # A zombie has exited; Linux may leave it awaiting init reap.
                    proc_stat = Path('/proc')/str(record['pid'])/'stat'
                    if proc_stat.exists() and proc_stat.read_text().split()[2] == 'Z':
                        alive = False
                    while alive and not total_deadline.expired():
                        time.sleep(0.01)
                        try:
                            os.kill(record['pid'], 0)
                        except ProcessLookupError:
                            alive = False
                        if proc_stat.exists() and proc_stat.read_text().split()[2] == 'Z':
                            alive = False
                    self.assertEqual(result['outcome'], 'timeout')
                    self.assertTrue(result['reaped'])
                    self.assertEqual(record['pgid'], worker['workerGroup'])
                    self.assertFalse(alive)
                finally:
                    try:
                        os.kill(record['pid'], signal.SIGKILL)
                    except ProcessLookupError:
                        pass


class FallbackDeadlineContractTest(unittest.TestCase):
    def test_parent_passes_exact_absolute_cutoff_to_worker(self):
        from unittest.mock import patch
        from scripts.wrd_entry_health import _owned_fetch
        deadline = Deadline(7)
        def capture(command, **kw):
            self.assertEqual(float(command[command.index('--deadline-at')+1]), deadline.ends_at)
            self.assertIs(kw['deadline'], deadline)
            return {'outcome':'timeout','stdout':b''}
        with patch('scripts.wrd_entry_health.run_owned_probe', side_effect=capture):
            _owned_fetch('formal-health', target='https://fixture.invalid', deadline=deadline,
                         limit=65536, proxy_mode='environment')

    def test_worker_does_not_renew_relative_timeout(self):
        from contextlib import redirect_stdout
        from unittest.mock import patch
        from scripts.wrd_entry_health import main, probe_result
        cutoff = __import__('time').monotonic() + 0.25
        def observe(layer, target, **kw):
            self.assertEqual(kw['deadline'].ends_at, cutoff)
            return probe_result(layer, outcome='ok', reason='ok')
        with patch('scripts.wrd_entry_health._observe', side_effect=observe), redirect_stdout(io.StringIO()):
            self.assertEqual(main(['--probe-worker','formal-health','--url','https://fixture.invalid',
                                   '--timeout','60','--deadline-at',str(cutoff)]), 0)

    def test_health_wait_cli_owns_worker_directly_and_passes_absolute_cutoff(self):
        from contextlib import redirect_stdout
        from unittest.mock import patch
        from scripts.wrd_deadline import main
        def capture(command, **kw):
            self.assertIn('--probe-worker', command)
            self.assertEqual(command[command.index('--probe-worker')+1], 'formal-health')
            self.assertEqual(float(command[command.index('--deadline-at')+1]), kw['deadline'].ends_at)
            self.assertAlmostEqual(kw['deadline'].remaining(), 7, delta=0.1)
            return {'outcome':'ok','stdout':b'{"outcome":"ok"}'}
        def wait(**kw):
            return kw['probe'](remaining_s=7)
        with patch('scripts.wrd_deadline.run_owned_probe', side_effect=capture), \
             patch('scripts.wrd_deadline.wait_formal_health', side_effect=wait), redirect_stdout(io.StringIO()):
            self.assertEqual(main(['--health-url','https://fixture.invalid',
                                   '--cloudflared','fixture-unused','--tunnel-name','fixture-unused']), 0)

    def test_nested_helpers_are_reaped_before_worker_cutoff(self):
        import os
        import sys
        import time
        from scripts.wrd_deadline import run_owned_probe
        for helper in ('dns','curl'):
            with self.subTest(helper=helper), tempfile.TemporaryDirectory() as directory:
                marker, record_path = Path(directory)/'pid', Path(directory)/'result'
                leaf = 'import os,time; open(' + repr(str(marker)) + ",'w').write(str(os.getpid())); time.sleep(60)"
                cutoff = time.monotonic() + 1.5
                code = """
import json,sys,socket
from unittest.mock import patch
import scripts.wrd_entry_health as entry
from scripts.wrd_deadline import run_owned_probe
actual_runner = run_owned_probe
def fixture_runner(command, **kwargs):
    if HELPER == 'curl' and command[0] == 'nslookup':
        return {'outcome':'ok','stdout':b'Address: 192.0.2.1'}
    result = actual_runner([sys.executable,'-c',LEAF],
                          **{**kwargs,'allowed_executables':{sys.executable}})
    open(RECORD, 'w').write(json.dumps({'outcome':result['outcome'],'reaped':result['reaped'],
                                      'returncode':result['returncode']}))
    return result
with patch.object(entry, 'run_owned_probe', side_effect=fixture_runner), \
     patch.object(entry, '_http_fetch', side_effect=socket.gaierror(-2, 'fixture')):
    entry.main(['--probe-worker','formal-health','--url','https://fixture.trycloudflare.com/health',
                '--timeout','60','--deadline-at',str(CUTOFF)])
""".replace('HELPER',repr(helper)).replace('LEAF',repr(leaf)).replace('RECORD',repr(str(record_path))).replace('CUTOFF',repr(cutoff))
                outer_deadline = Deadline(0)
                outer_deadline.ends_at = cutoff
                result = run_owned_probe([sys.executable,'-c',code], deadline=outer_deadline,
                                         allowed_executables={sys.executable})
                self.assertEqual(result['outcome'], 'ok', result['stderr'])
                record = json.loads(record_path.read_text())
                self.assertEqual(record['outcome'], 'timeout')
                self.assertTrue(record['reaped'])
                self.assertIsNotNone(record['returncode'])
                pid = int(marker.read_text())
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
                self.assertLessEqual(time.monotonic(), cutoff)


class InheritedLeafCleanupTest(unittest.TestCase):
    def test_output_limit_kills_only_leaf_and_retains_bounded_output(self):
        import sys
        from scripts.wrd_deadline import run_owned_probe
        code = """
import json,sys
from scripts.wrd_deadline import Deadline,run_owned_probe
result = run_owned_probe([sys.executable,'-c',"import sys,time;sys.stdout.write('x'*70000);sys.stdout.flush();time.sleep(60)"],
                         deadline=Deadline(1),allowed_executables={sys.executable},
                         output_limit=512,private_group=False)
print(json.dumps({'outcome':result['outcome'],'reaped':result['reaped'],
                  'bytes':len(result['stdout'])+len(result['stderr'])}),flush=True)
"""
        result = run_owned_probe([sys.executable,'-c',code],deadline=Deadline(2),allowed_executables={sys.executable})
        self.assertEqual(result['outcome'],'ok',result['stderr'])
        record = json.loads(result['stdout'])
        self.assertEqual(record,{'outcome':'output-limit','reaped':True,'bytes':512})


if __name__ == '__main__':
    unittest.main()
