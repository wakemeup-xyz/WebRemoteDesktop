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
            self.assertIs(kw['deadline'], deadline)
            budgets.append(float(command[command.index('--max-time')+1]))
            clock[0] += 8
            return {'outcome': 'failed', 'stdout': b'', 'stderr': b'secret URL'}
        with patch('scripts.wrd_entry_health.run_owned_probe', side_effect=failure):
            row = _default_resolved_checker('https://fixture.invalid/health', 'fixture.invalid',443,
                                           ['192.0.2.1', '192.0.2.2', '192.0.2.3'], 15, deadline=deadline)
        self.assertEqual(budgets, [15, 7])
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
            self.assertEqual(runtime.snapshot()['status'], 'entry-healthy')
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
        sampler = LayeredSampler(ProbeBoundariesTest.config, now=lambda: clock[0], fetch=fetch)
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


if __name__ == '__main__':
    unittest.main()
