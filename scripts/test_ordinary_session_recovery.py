"""Pure bounded recovery evidence tests; no service or browser access."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.ordinary_session_recovery import (
    ServerRecoveryEvidence, HostContinuityObserver, hash_identity,
    read_local_host_status, validate_recovery_row,
)

SALT = b'0123456789abcdef'
IDS = {'sessionId': 'session-canary', 'socketId': 'socket-new', 'previousSocketId': 'socket-old'}


def event(name='viewer_disconnect_grace_started', *, viewer='socket-old', session='session-canary', meta=None, ts='2026-10-18T01:00:00.000Z'):
    return {'ts': ts, 'level': 'info', 'domain': 'control', 'event': name, 'message': name,
            'source': 'signal-server', 'schemaVersion': 1, 'correlation': {'viewerId': viewer, 'browserSessionId': session},
            'meta': meta if meta is not None else {'graceMs': 8000}, 'redactionVersion': 1}


class LogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/'signal.jsonl'; self.path.write_bytes(b'')
        self.e = ServerRecoveryEvidence(self.path, SALT); self.addCleanup(self.e.close)

    def append(self, value):
        with self.path.open('ab') as f: f.write(json.dumps(value).encode()+b'\n')

    def test_current_eof_exact_matching_and_private_projection(self):
        self.append(event()); self.e.start(); self.assertEqual(self.e.read_tick(IDS), [])
        self.append(event(viewer='socket-old-suffix')); self.append(event(session='other'))
        self.append(event()); rows = self.e.read_tick(IDS)
        self.assertEqual(len(rows), 1); self.assertEqual(rows[0]['n'], 1)
        self.assertEqual(rows[0]['viewerHash'], hashlib.sha256(SALT+b'socket-old').hexdigest()[:16])
        encoded = json.dumps(self.e.snapshot())
        for private in ('session-canary', 'socket-old', str(self.path), 'token-canary'): self.assertNotIn(private, encoded)
        self.assertEqual(self.e.read_tick(IDS), [])

    def test_reset_only_after_matching_expiry(self):
        self.e.start()
        reset = event('control_reset_completed', meta={'leaseEpoch': 2, 'status': 'applied', 'state': 'FREE'}); reset['correlation'] = {}
        self.append(reset); self.assertEqual(self.e.read_tick(IDS), [])
        self.append(event('viewer_disconnect_grace_expired', meta={'leaseEpoch': 2, 'state': 'REVOKING', 'reason': 'viewer-disconnect-timeout'}))
        self.append(reset); rows = self.e.read_tick(IDS)
        self.assertEqual([r['event'] for r in rows], ['grace-expired', 'reset-completed'])
        self.assertIsNone(rows[1]['viewerHash'])

    def test_competing_admission_invalidates_reset_binding(self):
        self.e.start()
        self.append(event('viewer_disconnect_grace_expired', meta={'leaseEpoch': 2, 'state': 'REVOKING', 'reason': 'viewer-disconnect-timeout'}))
        self.append(event('viewer_connected', viewer='human', session='human-session', meta={}))
        reset = event('control_reset_completed', meta={'leaseEpoch': 2, 'status': 'applied', 'state': 'FREE'}); reset['correlation'] = {}
        self.append(reset)
        with self.assertRaisesRegex(ValueError, '^server-log-gap$'): self.e.read_tick(IDS)
        self.assertEqual(self.e.snapshot()['coverage'], 'incomplete')

    def test_host_disconnect_role_and_sticky_alarm(self):
        self.e.start(); h = event('signal_socket_disconnected', meta={'role': 'host', 'reason': 'transport close'})
        h['domain'] = 'signaling'; h['correlation'] = {}; self.append(h)
        rows = self.e.read_tick(IDS); self.assertEqual(rows[0]['event'], 'host-disconnected')
        self.assertIsNone(rows[0]['leaseEpoch']); self.assertIsNone(rows[0]['viewerHash'])
        o = HostContinuityObserver(SALT); o.observe_status({'hostOnline': True, 'hostId': 'host-canary'}, 0)
        o.observe_host_disconnect(); value = o.observe_status({'hostOnline': True, 'hostId': 'host-canary'}, 1000)
        self.assertEqual(value['status'], 'unavailable'); self.assertEqual(value['coverage'], 'incomplete')
        self.assertTrue(value['hostDisconnectObserved'])

    def test_malformed_unknown_and_clock_regression_fail_closed(self):
        for change in ('extra', 'epoch', 'timestamp', 'role', 'json'):
            with self.subTest(change=change):
                self.e.close(); self.path.write_bytes(b''); self.e = ServerRecoveryEvidence(self.path, SALT); self.e.start()
                e = event()
                if change == 'extra': e['meta']['credential'] = 'token-canary'
                if change == 'epoch': e = event('viewer_rebind_confirmed', meta={'leaseEpoch': True})
                if change == 'timestamp': e['ts'] = 'URL-canary'
                if change == 'role': e = event('signal_socket_disconnected', meta={})
                if change == 'json':
                    with self.path.open('ab') as f: f.write(b'{broken\n')
                else: self.append(e)
                with self.assertRaisesRegex(ValueError, '^server-log-schema$'): self.e.read_tick(IDS)
                self.assertEqual(self.e.snapshot()['coverage'], 'incomplete')
                self.assertEqual(self.e.snapshot()['status'], 'failed')
        self.e.close(); self.path.write_bytes(b''); self.e = ServerRecoveryEvidence(self.path, SALT); self.e.start()
        self.append(event()); self.e.read_tick(IDS); self.append(event(ts='2026-10-18T00:00:00.000Z'))
        with self.assertRaisesRegex(ValueError, '^server-clock-regression$'): self.e.read_tick(IDS)

    def test_rotation_truncation_symlink_and_missing(self):
        for kind in ('rotation', 'truncate'):
            with self.subTest(kind=kind):
                self.e.close(); self.path.write_bytes(b'history\n'); self.e = ServerRecoveryEvidence(self.path, SALT); self.e.start()
                if kind == 'rotation': self.path.rename(self.path.with_suffix('.old')); self.path.write_bytes(b'')
                else: self.path.write_bytes(b'')
                with self.assertRaisesRegex(ValueError, '^server-log-(identity-changed|gap)$'): self.e.read_tick(IDS)
        self.e.close(); self.path.unlink(); self.path.symlink_to(self.path.with_suffix('.old'))
        self.e = ServerRecoveryEvidence(self.path, SALT)
        with self.assertRaisesRegex(ValueError, '^server-log-unavailable$'): self.e.start()

    def test_line_tick_event_caps_and_partial_lines(self):
        for data in (b'x'*16385, b'x\n'*32769):
            self.e.close(); self.path.unlink(); self.path.write_bytes(b''); self.e = ServerRecoveryEvidence(self.path, SALT); self.e.start()
            with self.path.open('ab') as f: f.write(data)
            with self.assertRaisesRegex(ValueError, '^server-log-capacity$'): self.e.read_tick(IDS)
            self.assertEqual(self.e.snapshot()['coverage'], 'incomplete')
        self.e.close(); self.path.write_bytes(b''); self.e = ServerRecoveryEvidence(self.path, SALT); self.e.start()
        data = json.dumps(event()).encode(); self.path.write_bytes(data[:20]); self.assertEqual(self.e.read_tick(IDS), [])
        with self.path.open('ab') as f: f.write(data[20:]+b'\n')
        self.assertEqual(len(self.e.read_tick(IDS)), 1)
        for _ in range(1023): self.append(event()); self.e.read_tick(IDS)
        self.append(event())
        with self.assertRaisesRegex(ValueError, '^server-log-capacity$'): self.e.read_tick(IDS)
        self.assertEqual(len(self.e.snapshot()['selectedEvents']), 1024)


class HostTests(unittest.TestCase):
    def test_hash_and_stable_projection(self):
        for v in (None, '', True, {}, 'x'*129): self.assertIsNone(hash_identity(v, SALT))
        self.assertEqual(hash_identity('id', SALT), hashlib.sha256(SALT+b'id').hexdigest()[:16])
        o = HostContinuityObserver(SALT)
        self.assertEqual(o.snapshot()['status'], 'not-started')
        for i in range(3): v = o.observe_status({'hostOnline': True, 'hostId': 'host-canary'}, i*1000)
        self.assertEqual(v, {'status': 'stable', 'hostHash': hash_identity('host-canary', SALT), 'coverage': 'complete', 'samples': 3, 'hostDisconnectObserved': False})
        self.assertNotIn('host-canary', json.dumps(v))

    def test_changed_offline_invalid_gap_are_terminal(self):
        for fault, reason in (({'hostOnline': False, 'hostId': 'other'}, 'host-replaced'), ({'hostOnline': False, 'hostId': 'id'}, 'host-unavailable'), (None, 'host-observation-unavailable')):
            o = HostContinuityObserver(SALT); o.observe_status({'hostOnline': True, 'hostId': 'id'}, 0)
            o.observe_status(fault, 1000); self.assertEqual(o.reason, reason)
            final = o.observe_status({'hostOnline': True, 'hostId': 'id'}, 2000)
            self.assertEqual(final['coverage'], 'incomplete'); self.assertNotEqual(final['status'], 'stable')
        for tick in (1501, -1, True, float('nan')):
            o = HostContinuityObserver(SALT); o.observe_status({'hostOnline': True, 'hostId': 'id'}, 0)
            self.assertEqual(o.observe_status({'hostOnline': True, 'hostId': 'id'}, tick)['coverage'], 'incomplete')
            self.assertEqual(o.reason, 'host-observation-gap')

    def test_initial_offline_and_raw_schema(self):
        for value in ({'hostOnline': False, 'hostId': None}, {'hostOnline': 1, 'hostId': 'id'}, {'hostOnline': True, 'hostId': 'x'*129}, {'hostOnline': True, 'hostId': 'id', 'secret': 'canary'}):
            o = HostContinuityObserver(SALT); self.assertEqual(o.observe_status(value, 0)['coverage'], 'incomplete')


class Writer:
    def __init__(self, *, close_wait=None): self.data = b''; self.closed = False; self.close_wait = close_wait; self.waited = False
    def write(self, data): self.data += data
    async def drain(self): pass
    def close(self): self.closed = True
    async def wait_closed(self):
        try:
            if self.close_wait: await self.close_wait()
        finally: self.waited = True


def response(body=b'{"hostOnline":true,"hostId":"host-canary","unrelated":"discard-canary"}', *, headers=None, status=b'HTTP/1.1 200 OK'):
    return status+b'\r\n'+(headers if headers is not None else b'Content-Type: application/json\r\nContent-Length: '+str(len(body)).encode())+b'\r\n\r\n'+body


class HttpTests(unittest.IsolatedAsyncioTestCase):
    async def call(self, data, writer=None):
        reader = asyncio.StreamReader(); reader.feed_data(data); reader.feed_eof(); writer = writer or Writer()
        calls = []
        async def connect(*args, **kwargs): calls.append((args, kwargs)); return reader, writer
        with patch('scripts.ordinary_session_recovery.asyncio.open_connection', connect):
            value = await read_local_host_status()
        return value, writer, calls

    async def test_fixed_local_one_owned_request_no_proxy_or_credentials(self):
        with patch.dict(os.environ, {'HTTP_PROXY': 'http://proxy-canary', 'HTTPS_PROXY': 'http://proxy-canary'}):
            value, writer, calls = await self.call(response())
        self.assertEqual(value, {'hostOnline': True, 'hostId': 'host-canary'})
        self.assertEqual(calls, [(('127.0.0.1', 8080), {})]); self.assertTrue(writer.closed); self.assertTrue(writer.waited)
        self.assertEqual(writer.data, b'GET /api/status HTTP/1.1\r\nHost: 127.0.0.1:8080\r\nConnection: close\r\nCache-Control: no-store\r\nAccept: application/json\r\n\r\n')

    async def test_http_json_framing_bounds_fail_fixed_private(self):
        cases = [response(status=b'HTTP/1.1 302 Found'), response(headers=b'Content-Type: text/html\r\nContent-Length: 0'),
            response(headers=b'Content-Type: application/json\r\nContent-Length: 0\r\nContent-Length: 0'),
            response(headers=b'Content-Type: application/json\r\nContent-Length: 0\r\nTransfer-Encoding: chunked'),
            response(headers=b'Content-Type: application/json\r\nContent-Length: 16385'), response(body=b'{bad-canary'),
            response(body=b'{"hostOnline":true,"hostId":"id","hostId":"other"}'),
            response(body=b'\xff'), response(body=b'{"hostOnline":false}'), response(body=b'{"hostOnline":1,"hostId":"id"}'),
            response(headers=b'Content-Type: application/json\r\nContent-Length: 10\r\nContent-Encoding: gzip'),
            response(headers=b'Content-Type: application/json\r\nContent-Length: 10000'),
            response(headers=b'X: '+b'x'*1024), response(headers=b'\r\n'.join([b'X: a']*33)),
            response(headers=b'\r\n'.join([b'X: '+b'x'*1000]*9))]
        for case in cases:
            with self.subTest(case=case[:40]):
                writer = Writer()
                with self.assertRaisesRegex(ValueError, '^host-observation-unavailable$'): await self.call(case, writer)
                self.assertTrue(writer.closed)

    async def test_timeout_cancel_and_writer_close_timeout_owned(self):
        async def never(): await asyncio.Event().wait()
        reader = asyncio.StreamReader(); writer = Writer()
        async def connect(*args): return reader, writer
        with patch('scripts.ordinary_session_recovery.asyncio.open_connection', connect):
            started = asyncio.get_running_loop().time()
            with self.assertRaisesRegex(ValueError, '^host-observation-unavailable$'): await read_local_host_status()
            self.assertLess(asyncio.get_running_loop().time()-started, .9)
        self.assertTrue(writer.closed); self.assertTrue(writer.waited)
        writer = Writer(close_wait=never)
        with self.assertRaisesRegex(ValueError, '^host-observation-unavailable$'): await self.call(response(), writer)
        self.assertTrue(writer.closed); self.assertTrue(writer.waited)
        writer = Writer(); entered = asyncio.Event()
        async def cancellable(*args): entered.set(); return reader, writer
        with patch('scripts.ordinary_session_recovery.asyncio.open_connection', cancellable):
            task = asyncio.create_task(read_local_host_status()); await entered.wait(); await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError): await task
        self.assertTrue(writer.closed); self.assertTrue(writer.waited)
        self.assertEqual([t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()], [])


def private_sample():
    from scripts import passive_session_soak as old
    from scripts import ordinary_session_recovery as recovery
    sample = dict.fromkeys(recovery._SAMPLE_KEYS)
    sample.update(schemaVersion=1, browserNowMs=0, scopeStable=True, socketConnected=True,
        pcState='connected', mediaPhase='active', inputAllowed=False, tunnelRelayActive=False,
        transport={'status': 'unavailable'}, buildId='0123456789abcdef',
        relayEvidenceKind='image-load-event-not-optical-presentation',
        inputGate={'status': 'unavailable', 'blockedReasons': [], **dict.fromkeys(old.GATE_BOOLEANS), **dict.fromkeys(old.GATE_ENUMS, 'unknown')},
        startupMarks=dict.fromkeys(old.MARK_NAMES), metrics=dict.fromkeys(recovery._METRICS),
        diagnostics={'schemaVersion': 1, 'events': [], 'cursor': 0, 'gap': 0, 'truncated': False,
            'droppedEvents': 0, 'coverageStatus': 'partial', 'firstDisconnectEvent': None, 'cause': 'unknown'})
    return sample


def recovery_row():
    return {'schemaVersion': 1, 'scenario': 'after-grace', 'elapsedSeconds': 1, 'phase': 'recovering',
        'qualificationEvidenceScope': 'ordinary-functional-playwright-routed-stimulus',
        'hostObservation': HostContinuityObserver(SALT).observe_status({'hostOnline': True, 'hostId': 'host-canary'}, 0),
        'sample': private_sample(), 'identity': dict.fromkeys(('sessionHash', 'socketHash', 'admissionHash')),
        'serverEvents': []}


class SchemaTests(unittest.TestCase):
    def test_exact_private_sample_and_scope(self):
        row = recovery_row(); self.assertIs(validate_recovery_row(row), row)
        row['sample'] = None; self.assertIs(validate_recovery_row(row), row)
        for container, key, value in (
            ('row', 'error', 'error-canary'), ('row', 'schemaVersion', True),
            ('row', 'elapsedSeconds', float('nan')), ('row', 'phase', 'RUNNING'),
            ('row', 'qualificationEvidenceScope', 'native-passive-continuity'),
            ('sample', 'attempt', 'raw-id-canary'), ('sample', 'url', 'https://url-canary'),
            ('sample', 'token', 'token-canary'), ('sample', 'generation', True),
            ('sample', 'width', float('inf')), ('sample', 'buildId', 'x'*129),
            ('identity', 'sessionHash', 'raw-id-canary'), ('identity', 'extra', 'credential-canary'),
            ('hostObservation', 'hostHash', 'host-canary'), ('hostObservation', 'samples', True)):
            with self.subTest(container=container, key=key):
                row = recovery_row(); target = row if container == 'row' else row[container]; target[key] = value
                with self.assertRaisesRegex(ValueError, '^schema-rejected$'): validate_recovery_row(row)
        for section, key, value in (('metrics', 'secret', 'canary'), ('transport', 'url', 'https://canary'), ('diagnostics', 'error', 'canary'), ('inputGate', 'secret', 'canary')):
            row = recovery_row(); row['sample'][section][key] = value
            with self.assertRaisesRegex(ValueError, '^schema-rejected$'): validate_recovery_row(row)

    def test_nested_transport_metrics_caps_and_event_sequence(self):
        row = recovery_row()
        row['sample']['transport'] = {'status': 'observed', 'pathIdentity': 'path-1', 'localType': 'host', 'remoteType': 'srflx',
            'protocol': 'udp', 'remoteProtocol': 'udp', 'relayProtocol': 'unknown', 'rttMs': 1.5,
            'bytesReceived': 1, 'framesDecoded': 1, 'framesDropped': 0, 'codec': 'video/h264'}
        row['sample']['metrics']['decodeMs'] = {'available': True, 'count': 2, 'last': 1.5, 'p95': 2, 'lastSampleAgeMs': 0}
        self.assertIs(validate_recovery_row(row), row)
        row['sample']['transport']['pathIdentity'] = 'path-1025'
        with self.assertRaises(ValueError): validate_recovery_row(row)
        row = recovery_row(); projected = {'n': 1, 'event': 'host-disconnected', 'serverTimestampMs': 0,
            'viewerHash': None, 'sessionHash': None, 'leaseEpoch': None, 'state': None}
        row['serverEvents'] = [projected, dict(projected)]
        with self.assertRaises(ValueError): validate_recovery_row(row)
        row['serverEvents'] = [dict(projected, n=n) for n in range(1, 1025)]
        with self.assertRaisesRegex(ValueError, '^schema-rejected$'): validate_recovery_row(row)

    def test_unchanged_good_viewer_gates_do_not_clear_host_replacement_or_disconnect(self):
        for disconnect in (False, True):
            row = recovery_row()
            row['sample'].update(inputAllowed=True, pcIdentity=1, generation=1, leaseEpoch=3,
                attemptHash='0123456789abcdef', callbacks=20, frameAgeMs=10, maxFrameGapMs=20)
            gate = row['sample']['inputGate']; gate.update(status='observed',
                **dict.fromkeys(('allowed', 'inputActive', 'hasInputLease', 'viewportSupported', 'hasPaintedFrame',
                    'currentAttemptReady', 'hasActiveControl', 'socketConnected'), True),
                **dict.fromkeys(('manualDisconnect', 'superseded', 'mouseResetPending', 'draftComposing',
                    'draftPending', 'draftUncertain', 'firstFrameTimerHandlePresent'), False),
                uiPhase='connected', desiredMediaState='active', mediaRuntimePhase='active',
                keyboardControllerState='READY', keyboardTransportState='ready', surfaceState='settled',
                desktopWriteRecoveryState='reconciled', recoveryState='recovered')
            before = json.dumps(row['sample'], sort_keys=True)
            observer = HostContinuityObserver(SALT)
            observer.observe_status({'hostOnline': True, 'hostId': 'host-canary'}, 0)
            if disconnect: observer.observe_host_disconnect()
            else: observer.observe_status({'hostOnline': False, 'hostId': 'replacement-canary'}, 1000)
            row['hostObservation'] = observer.observe_status({'hostOnline': True, 'hostId': 'host-canary'}, 2000)
            self.assertIs(validate_recovery_row(row), row)
            self.assertEqual(json.dumps(row['sample'], sort_keys=True), before)
            self.assertEqual(row['hostObservation']['coverage'], 'incomplete')
            self.assertNotEqual(row['hostObservation']['status'], 'stable')
            self.assertNotIn('canary', json.dumps(row))


class MoreHttpTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_one_outstanding_request_and_cancel_before_open(self):
        entered = asyncio.Event(); calls = []
        async def connect(*args):
            calls.append(args); entered.set(); await asyncio.Event().wait()
        with patch('scripts.ordinary_session_recovery.asyncio.open_connection', connect):
            task = asyncio.create_task(read_local_host_status()); await entered.wait()
            with self.assertRaisesRegex(ValueError, '^host-observation-unavailable$'): await read_local_host_status()
            self.assertEqual(len(calls), 1); task.cancel()
            with self.assertRaises(asyncio.CancelledError): await task
        self.assertEqual([t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()], [])

    async def test_noncooperative_open_is_explicit_and_not_available_for_retry(self):
        from scripts.passive_session_soak import CancellationCooperationError
        release = asyncio.Event(); cancelled = asyncio.Event()
        async def connect(*args):
            while not release.is_set():
                try: await release.wait()
                except asyncio.CancelledError: cancelled.set()
            raise OSError('private-error-canary')
        with patch('scripts.ordinary_session_recovery.asyncio.open_connection', connect):
            with self.assertRaisesRegex(CancellationCooperationError, '^cancellation-noncooperative$'):
                await read_local_host_status()
            self.assertTrue(cancelled.is_set())
            with self.assertRaisesRegex(ValueError, '^host-observation-unavailable$'): await read_local_host_status()
            # The fake is released explicitly; a real noncooperative backend is a
            # hard gate failure, never an observation or successful cleanup.
            from scripts import ordinary_session_recovery as recovery
            release.set()
            with self.assertRaises(OSError): await recovery._status_owner
            recovery._status_owner = None

    async def test_cancel_during_writer_close_is_owned(self):
        entered = asyncio.Event(); finished = asyncio.Event()
        async def closing():
            entered.set()
            try: await asyncio.Event().wait()
            finally: finished.set()
        reader = asyncio.StreamReader(); reader.feed_data(response()); reader.feed_eof(); writer = Writer(close_wait=closing)
        async def connect(*args): return reader, writer
        with patch('scripts.ordinary_session_recovery.asyncio.open_connection', connect):
            task = asyncio.create_task(read_local_host_status()); await entered.wait(); task.cancel()
            with self.assertRaises(asyncio.CancelledError): await task
        self.assertTrue(writer.closed); self.assertTrue(finished.is_set()); self.assertTrue(writer.waited)
        self.assertEqual([t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()], [])


class AdditionalLogTests(unittest.TestCase):
    setUp = LogTests.setUp
    append = LogTests.append
    def test_confirmed_rebind_and_duplicate_reset_projection(self):
        self.e.start()
        rebind = event('viewer_rebind_confirmed', viewer='socket-new', meta={'leaseEpoch': 1})
        rebind['correlation'] = {'viewerId': 'socket-new', 'previousViewerId': 'socket-old', 'browserSessionId': 'session-canary'}
        self.append(rebind)
        self.assertEqual(self.e.read_tick(IDS)[0]['event'], 'rebind-confirmed')
        self.append(event('viewer_disconnect_grace_expired', meta={'leaseEpoch': 2, 'state': 'REVOKING', 'reason': 'viewer-disconnect-timeout'}))
        reset = event('control_reset_completed', meta={'leaseEpoch': 2, 'status': 'applied', 'state': 'FREE'}); reset['correlation'] = {}
        self.append(reset); self.append(reset)
        self.assertEqual([e['event'] for e in self.e.read_tick(IDS)], ['grace-expired', 'reset-completed'])

    def test_missing_epoch_and_null_expiry_state_fail_closed(self):
        for bad in ({'leaseEpoch': None, 'state': 'REVOKING', 'reason': 'viewer-disconnect-timeout'},
                    {'leaseEpoch': 2, 'state': None, 'reason': 'viewer-disconnect-timeout'}):
            self.e.close(); self.path.write_bytes(b''); self.e = ServerRecoveryEvidence(self.path, SALT); self.e.start()
            self.append(event('viewer_disconnect_grace_expired', meta=bad))
            with self.assertRaisesRegex(ValueError, '^server-log-schema$'): self.e.read_tick(IDS)

    def test_partial_final_close_and_unknown_identity_keys_are_incomplete(self):
        self.e.start(); self.path.write_bytes(b'{')
        self.e.read_tick(IDS); self.e.close(); self.e.close()
        self.assertEqual(self.e.snapshot()['coverage'], 'incomplete')
        self.e = ServerRecoveryEvidence(self.path, SALT); self.e.start()
        with self.assertRaisesRegex(ValueError, '^server-log-schema$'): self.e.read_tick(dict(IDS, token='canary'))

    def test_host_disconnect_before_viewer_known_and_malformed_selected_envelope(self):
        self.e.start(); h = event('signal_socket_disconnected', meta={'role': 'host', 'reason': 'other'})
        h['domain'] = 'signaling'; h['correlation'] = {}; self.append(h)
        rows = self.e.read_tick(dict.fromkeys(IDS)); self.assertEqual(rows[0]['event'], 'host-disconnected')
        self.append(dict(event(), token='token-canary'))
        with self.assertRaisesRegex(ValueError, '^server-log-schema$'): self.e.read_tick(IDS)


class MalformedLogTests(unittest.TestCase):
    setUp = LogTests.setUp
    append = LogTests.append

    def test_malformed_selected_values_never_escape_fixed_schema_reason(self):
        for key, value in (('event', []), ('correlation', {'viewerId': []}), ('correlation', {'viewerId': 'socket-old', 'browserSessionId': 'session-canary', 'credential': 'private-canary'})):
            self.e.close(); self.path.write_bytes(b''); self.e = ServerRecoveryEvidence(self.path, SALT); self.e.start()
            bad = event(); bad[key] = value; self.append(bad)
            with self.assertRaisesRegex(ValueError, '^server-log-schema$'): self.e.read_tick(IDS)
            self.assertNotIn('private-canary', json.dumps(self.e.snapshot()))


class BoundariesTests(unittest.TestCase):
    def test_observer_sample_cap_and_status_consistency(self):
        observer = HostContinuityObserver(SALT)
        for n in range(12000): observer.observe_status({'hostOnline': True, 'hostId': 'bounded'}, n*1000)
        value = observer.observe_status({'hostOnline': True, 'hostId': 'bounded'}, 12000000)
        self.assertEqual(value['samples'], 12000); self.assertEqual(value['coverage'], 'incomplete')
        row = recovery_row(); row['hostObservation']['status'] = 'changed'
        with self.assertRaisesRegex(ValueError, '^schema-rejected$'): validate_recovery_row(row)
        observer = HostContinuityObserver(SALT)
        value = observer.observe_status({'hostOnline': True, 'hostId': chr(0xd800)}, 0)
        self.assertEqual(value['coverage'], 'incomplete'); self.assertIsNone(value['hostHash'])


class HttpBoundaryTests(unittest.IsolatedAsyncioTestCase):
    call = HttpTests.call
    async def test_exact_body_cap_discards_unrelated_fields_and_rejects_surrogate_id(self):
        prefix = b'{"hostOnline":true,"hostId":"id","padding":"'
        body = prefix+b'x'*(16384-len(prefix)-2)+b'"}'
        self.assertEqual(len(body), 16384)
        value, _, _ = await self.call(response(body=body))
        self.assertEqual(value, {'hostOnline': True, 'hostId': 'id'})
        with self.assertRaisesRegex(ValueError, '^host-observation-unavailable$'):
            await self.call(response(body=b'{"hostOnline":true,"hostId":"\\ud800"}'))


class AmbiguousEpochTests(unittest.TestCase):
    setUp = LogTests.setUp
    append = LogTests.append

    def test_two_different_pending_expiry_epochs_cannot_bind_reset(self):
        self.e.start()
        for epoch in (2, 3):
            self.append(event('viewer_disconnect_grace_expired', meta={'leaseEpoch': epoch, 'state': 'REVOKING', 'reason': 'viewer-disconnect-timeout'}))
        with self.assertRaisesRegex(ValueError, '^server-log-gap$'): self.e.read_tick(IDS)
        self.assertEqual(self.e.snapshot()['coverage'], 'incomplete')


class OneShotLogTests(unittest.TestCase):
    setUp = LogTests.setUp
    append = LogTests.append

    def test_closed_complete_cannot_reopen_and_skip_host_disconnect(self):
        self.e.start(); self.append(event()); self.e.read_tick(IDS)
        selected = self.e.snapshot()['selectedEvents']
        self.e.close(); self.assertEqual(self.e.snapshot()['coverage'], 'complete')
        h = event('signal_socket_disconnected', meta={'role': 'host', 'reason': 'other'})
        h['domain'] = 'signaling'; h['correlation'] = {}; self.append(h)
        with self.assertRaisesRegex(ValueError, '^server-log-unavailable$'): self.e.start()
        self.assertEqual(self.e.snapshot()['coverage'], 'incomplete')
        self.assertEqual(self.e.snapshot()['status'], 'failed')
        self.assertEqual(self.e.snapshot()['selectedEvents'], selected)
        self.assertIsNone(self.e._fd)
        # A separate run needs a fresh instance. It cannot repair this interval.
        fresh = ServerRecoveryEvidence(self.path, SALT); self.addCleanup(fresh.close)
        fresh.start(); self.assertEqual(fresh.read_tick(IDS), [])
        self.assertEqual(self.e.snapshot()['coverage'], 'incomplete')

    def test_closed_incomplete_cannot_reopen_or_clear_first_failure(self):
        self.e.start(); self.path.write_bytes(b'{'); self.e.read_tick(IDS); self.e.close()
        self.assertEqual(self.e.reason, 'server-log-gap')
        with self.assertRaisesRegex(ValueError, '^server-log-gap$'): self.e.start()
        self.assertEqual(self.e.snapshot()['coverage'], 'incomplete')
        self.assertEqual(self.e.reason, 'server-log-gap'); self.assertIsNone(self.e._fd)
        with self.assertRaisesRegex(ValueError, '^server-log-gap$'): self.e.start()
        self.assertEqual(self.e.snapshot()['status'], 'failed')


class SettlingHttpOwnershipTests(unittest.IsolatedAsyncioTestCase):
    async def test_done_child_reserves_slot_until_wrapper_settles(self):
        from scripts import ordinary_session_recovery as recovery
        real_stage = recovery.lifecycle_stage
        for cancel_first in (False, True):
            with self.subTest(cancel_first=cancel_first):
                done_child = asyncio.Event(); release_wrapper = asyncio.Event()
                calls = []; owned_tasks = []; writers = []
                async def connect(*args):
                    calls.append(args)
                    reader = asyncio.StreamReader(); reader.feed_data(response()); reader.feed_eof()
                    writer = Writer(); writers.append(writer)
                    return reader, writer
                async def paused_stage(operation, timeout, *, settlement):
                    owned_tasks.append(operation)
                    value = await real_stage(operation, timeout, settlement=settlement)
                    if len(owned_tasks) == 1:
                        done_child.set(); await release_wrapper.wait()
                    return value
                first = None
                with patch('scripts.ordinary_session_recovery.asyncio.open_connection', connect), patch('scripts.ordinary_session_recovery.lifecycle_stage', paused_stage):
                    try:
                        first = asyncio.create_task(read_local_host_status())
                        await done_child.wait()
                        self.assertTrue(owned_tasks[0].done()); self.assertFalse(first.done())
                        second_result, = await asyncio.gather(read_local_host_status(), return_exceptions=True)
                    finally:
                        if cancel_first: first.cancel()
                        release_wrapper.set()
                        first_result, = await asyncio.gather(first, return_exceptions=True)
                self.assertIsInstance(second_result, ValueError, f'first={first_result!r}; second={second_result!r}')
                self.assertEqual(str(second_result), 'host-observation-unavailable')
                if cancel_first: self.assertIsInstance(first_result, asyncio.CancelledError)
                else: self.assertEqual(first_result, {'hostOnline': True, 'hostId': 'host-canary'})
                self.assertEqual(len(calls), 1); self.assertEqual(len(owned_tasks), 1)
                self.assertTrue(all(w.closed and w.waited for w in writers))
                self.assertIsNone(recovery._status_owner)
                self.assertEqual([t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()], [])


def rebind_event(name='viewer_rebind_confirmed', **correlation_changes):
    value = event(name, viewer='server-new-canary', meta={'leaseEpoch': 1} if name == 'viewer_rebind_confirmed' else {'reason': 'rebind-rejected'})
    value['correlation'] = {'viewerId': 'server-new-canary', 'previousViewerId': 'socket-old',
                            'browserSessionId': 'session-canary', **correlation_changes}
    return value


class DirectRebindCorrelationTests(unittest.TestCase):
    setUp = LogTests.setUp
    append = LogTests.append

    def test_server_before_browser_rebind_retains_direct_session_hash_only(self):
        self.e.start(); ids = dict(IDS, socketId='socket-old', previousSocketId=None)
        self.append(event()); self.assertEqual(self.e.read_tick(ids)[0]['event'], 'grace-started')
        self.append(rebind_event())
        rows = self.e.read_tick(ids)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['event'], 'rebind-confirmed')
        self.assertEqual(rows[0]['sessionHash'], hash_identity('session-canary', SALT))
        self.assertEqual(rows[0]['viewerHash'], hash_identity('server-new-canary', SALT))
        self.assertEqual(self.e.read_tick(ids), [])
        # A direct rebind observation must not promote the new socket into the
        # browser identity set or relax matching for a different event kind.
        self.append(event(viewer='server-new-canary'))
        self.assertEqual(self.e.read_tick(ids), [])
        browser_ids = dict(IDS, socketId='server-new-canary', previousSocketId='socket-old')
        self.append(event(viewer='server-new-canary'))
        self.assertEqual(self.e.read_tick(browser_ids)[0]['event'], 'grace-started')
        projection = json.dumps(self.e.snapshot())
        for private in ('server-new-canary', 'socket-old', 'session-canary', str(self.path), 'https://url-canary', 'token-canary'):
            self.assertNotIn(private, projection)

    def test_known_current_rebind_projects_session_from_its_logged_field(self):
        self.e.start(); self.append(rebind_event(viewerId='socket-new'))
        rows = self.e.read_tick(IDS)
        self.assertEqual(rows[0]['sessionHash'], hash_identity('session-canary', SALT))
        self.assertEqual(rows[0]['viewerHash'], hash_identity('socket-new', SALT))

    def test_failed_rebind_before_browser_has_direct_session_for_each_server_reason(self):
        self.e.start()
        for reason in ('rebind-cancelled', 'rebind-rejected', 'rebind-timeout'):
            value = rebind_event('viewer_rebind_failed'); value['meta']['reason'] = reason
            self.append(value)
        rows = self.e.read_tick(dict(IDS, socketId='socket-old', previousSocketId=None))
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(row['event'] == 'rebind-failed' and row['sessionHash'] == hash_identity('session-canary', SALT) for row in rows))
        self.assertEqual(self.e.snapshot()['coverage'], 'complete')

    def test_foreign_session_unknown_previous_or_unknown_stable_session_cannot_bind(self):
        self.e.start()
        for changes in ({'browserSessionId': 'foreign-session-canary'}, {'previousViewerId': 'unknown-previous-canary'},
                        {'viewerId': 'socket-new', 'browserSessionId': 'foreign-session-canary'},
                        {'viewerId': 'socket-new', 'previousViewerId': 'unknown-previous-canary'}):
            self.append(rebind_event(**changes))
        self.assertEqual(self.e.read_tick(IDS), [])
        self.assertEqual(self.e.snapshot()['coverage'], 'complete')
        fresh = ServerRecoveryEvidence(self.path, SALT); self.addCleanup(fresh.close); fresh.start()
        self.append(rebind_event(viewerId='socket-new'))
        self.assertEqual(fresh.read_tick(dict(IDS, sessionId=None)), [])

    def test_missing_malformed_and_unknown_matching_rebind_correlation_fails_closed(self):
        cases = [None, {}, {'viewerId': 'socket-new', 'previousViewerId': 'socket-old'},
            {'viewerId': 'server-new-canary', 'previousViewerId': 'socket-old'},
            {'viewerId': 'server-new-canary', 'previousViewerId': 'socket-old', 'browserSessionId': None},
            {'viewerId': [], 'previousViewerId': 'socket-old', 'browserSessionId': 'session-canary'},
            {'viewerId': 'server-new-canary', 'previousViewerId': [], 'browserSessionId': 'session-canary'},
            {'viewerId': 'server-new-canary', 'previousViewerId': 'socket-old', 'browserSessionId': 'session-canary', 'token': 'token-canary'},
            {'viewerId': 'server-new-canary', 'previousViewerId': 'socket-old', 'browserSessionId': 'session-canary', 'url': 'https://url-canary'}]
        for name in ('viewer_rebind_confirmed', 'viewer_rebind_failed'):
            for correlation in cases:
                with self.subTest(name=name, correlation=correlation):
                    self.e.close(); self.path.write_bytes(b''); self.e = ServerRecoveryEvidence(self.path, SALT); self.e.start()
                    value = rebind_event(name)
                    if correlation is None: value.pop('correlation')
                    else: value['correlation'] = correlation
                    self.append(value)
                    with self.assertRaisesRegex(ValueError, '^server-log-schema$'): self.e.read_tick(IDS)
                    self.assertEqual(self.e.snapshot()['coverage'], 'incomplete')
                    projection = json.dumps(self.e.snapshot())
                    for private in ('server-new-canary', 'session-canary', 'token-canary', 'https://url-canary'):
                        self.assertNotIn(private, projection)

# Task 4 tests exercise only owned fakes and temporary private artifacts.
from scripts import ordinary_session_recovery as runner
from types import SimpleNamespace


def valid_manifest(log, now=1000000):
    info = log.stat()
    return dict(schemaVersion=1, runNonce='1'*32, createdAtEpochMs=now,
        validUntilEpochMs=now+12000000, scenario='baseline', mode='stun',
        originSource='formal-configured', originEvidenceSha256='2'*64,
        originSha256=hashlib.sha256(b'https://example.invalid').hexdigest(),
        deploymentEvidence={'kind':'root-verified-local-deployment','sha256':'3'*64},
        signal={'sourceCommit':'4'*40,'sourceTreeSha256':'5'*64},
        host={'sourceCommit':'6'*40,'sourceTreeSha256':'7'*64},
        viewer={'sourceCommit':'8'*40,'buildId':'0123456789abcdef'},
        signalLog={'path':str(log),'device':info.st_dev,'inode':info.st_ino})


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.log = Path(self.temp.name)/'signal.jsonl'; self.log.write_bytes(b'')
        self.path = Path(self.temp.name)/'manifest.json'; self.value = valid_manifest(self.log)
        self.save()

    def save(self, raw=None):
        data = json.dumps(self.value).encode() if raw is None else raw
        self.path.write_bytes(data); self.path.chmod(0o600)
        self.sha = hashlib.sha256(data).hexdigest()

    def read(self, **changes):
        options = dict(origin='https://example.invalid', scenario='baseline', mode='stun', now_epoch_ms=1000000)
        options.update(changes)
        return runner.read_runtime_manifest(self.path, self.sha, **options)

    def test_exact_pin_root_attestation_and_mutation(self):
        manifest = self.read()
        self.assertEqual(manifest['viewer']['buildId'], '0123456789abcdef')
        self.assertEqual(manifest.projection()['sourceEvidence'], 'root-attested')
        self.assertNotIn(str(self.log), json.dumps(manifest.projection()))
        self.path.write_bytes(self.path.read_bytes()+b' ')
        with self.assertRaisesRegex(ValueError, '^runtime-manifest-changed$'): manifest.recheck(1000001)

    def test_invalid_schema_bytes_and_pin(self):
        for field, value in [('schemaVersion',True),('createdAtEpochMs',float('inf')),('secret','canary'),
                             ('originSha256','X'*64),('runNonce','x'*32)]:
            with self.subTest(field=field):
                self.value = valid_manifest(self.log); self.value[field] = value; self.save()
                with self.assertRaisesRegex(ValueError, '^runtime-manifest-invalid$'): self.read()
        for raw in (b'{"schemaVersion":1,"schemaVersion":1}', b'x'*16385, b'\xff'):
            self.save(raw)
            with self.assertRaisesRegex(ValueError, '^runtime-manifest-invalid$'): self.read()
        self.value = valid_manifest(self.log); self.save(); self.sha = 'f'*64
        with self.assertRaisesRegex(ValueError, '^runtime-manifest-pin-mismatch$'): self.read()

    def test_time_cli_owner_permissions_and_file_identity(self):
        for opts in ({'now_epoch_ms':999999},{'now_epoch_ms':1900001}, {'scenario':'continuity'},
                     {'mode':'relay'},{'origin':'https://other.invalid'},{'origin':'https://example.invalid/path'}):
            with self.subTest(opts=opts), self.assertRaises(ValueError): self.read(**opts)
        self.value['validUntilEpochMs'] = 1100000; self.save()
        with self.assertRaisesRegex(ValueError, '^runtime-manifest-stale$'): self.read()
        self.value = valid_manifest(self.log); self.save(); self.path.chmod(0o644)
        with self.assertRaises(ValueError): self.read()
        self.path.chmod(0o600)
        with patch.object(runner.os,'getuid',return_value=os.getuid()+1), self.assertRaises(ValueError): self.read()
        self.path.rename(self.path.with_suffix('.real')); self.path.symlink_to(self.path.with_suffix('.real'))
        with self.assertRaises(ValueError): self.read()
        self.path.unlink(); self.path.mkdir()
        with self.assertRaises(ValueError): self.read()

    def test_log_identity_and_poststart_inode_substitution(self):
        self.value['signalLog']['inode'] += 1; self.save()
        with self.assertRaisesRegex(ValueError, '^server-log-identity-changed$'): self.read()
        self.value = valid_manifest(self.log); self.save(); manifest = self.read()
        data = self.path.read_bytes(); self.path.rename(self.path.with_suffix('.old')); self.save(data)
        with self.assertRaisesRegex(ValueError, '^runtime-manifest-changed$'): manifest.recheck(1000001)


def ready_sample(count=10, epoch=3):
    value = private_sample()
    value.update(inputAllowed=True, pcIdentity=1, generation=1, leaseEpoch=epoch,
        attemptHash='a'*16, callbacks=count, frameAgeMs=10, maxFrameGapMs=20)
    value['transport'] = dict(status='observed',pathIdentity='path-1',localType='host',remoteType='srflx',
        protocol='udp',remoteProtocol='udp',relayProtocol='unknown',rttMs=1,bytesReceived=2000000000,
        framesDecoded=count,framesDropped=0,codec='video/h264')
    value['inputGate'].update(status='observed',
        **dict.fromkeys(('allowed','inputActive','hasInputLease','viewportSupported','hasPaintedFrame',
            'currentAttemptReady','hasActiveControl','socketConnected'),True),
        **dict.fromkeys(('manualDisconnect','superseded','mouseResetPending','draftComposing','draftPending',
            'draftUncertain','firstFrameTimerHandlePresent'),False),uiPhase='connected',desiredMediaState='active',
        mediaRuntimePhase='active',keyboardControllerState='READY',keyboardTransportState='ready',
        surfaceState='settled',desktopWriteRecoveryState='reconciled',recoveryState='recovered')
    return value


def model_row(model, at, *, sample=None, events=(), socket='b'*16):
    return dict(schemaVersion=1,scenario=model.scenario,elapsedSeconds=at,phase=model.phase,
        qualificationEvidenceScope=runner.SCOPES[model.scenario],hostObservation=recovery_row()['hostObservation'],
        sample=ready_sample(10+int(at)) if sample is None else sample,
        identity=dict(sessionHash='c'*16,socketHash=socket,admissionHash='d'*16),serverEvents=list(events))


class ClassifierTests(unittest.TestCase):
    def model(self, scenario='within-grace'):
        m = runner.OrdinaryRecoverySummary(scenario,'stun'); m.transition('startup')
        m.startup = dict(runner.VERIFIED_STARTUP); m.expected_build = '0123456789abcdef'
        m.server_coverage = 'complete'
        for n in range(302): m.observe(model_row(m,n))
        self.assertTrue(m.baseline_ready)
        return m

    def events(self, after=False):
        def e(n,name,epoch=None,viewer=None,session=None,state=None):
            return dict(n=n,event=name,serverTimestampMs=1000+n,viewerHash=viewer,sessionHash=session,
                        leaseEpoch=epoch,state=state)
        start = e(1,'grace-started',viewer='b'*16,session='c'*16)
        if not after: return [start,e(2,'rebind-confirmed',3,viewer='e'*16,session='c'*16)]
        return [start,e(2,'grace-expired',4,viewer='b'*16,session='c'*16,state='REVOKING'),
                e(3,'reset-completed',4,state='FREE')]

    def test_fractional_counters_rejected_large_bytes_accepted(self):
        row = recovery_row(); row['sample'] = ready_sample()
        validate_recovery_row(row)
        for key in ('bytesReceived','framesDecoded','framesDropped'):
            row['sample'] = ready_sample(); row['sample']['transport'][key] = 1.5
            with self.assertRaises(ValueError): validate_recovery_row(row)

    def test_within_and_after_require_order_then_stability_and_cleanup(self):
        for scenario in ('within-grace','after-grace'):
            m = self.model(scenario); m.observe(model_row(m,302)); m.confirm_fault(302); self.assertEqual(m.phase,'fault'); m.transition('recovering')
            after = scenario == 'after-grace'
            m.observe(model_row(m,303,events=self.events(after),socket='e'*16,sample=ready_sample(400,5 if after else 3)))
            self.assertEqual(m.phase,'recovered-stability')
            for n in range(304,334): m.observe(model_row(m,n,socket='e'*16,sample=ready_sample(100+n,5 if after else 3)))
            self.assertEqual(m.result(cleanup_complete=True)['ordinaryRecovery']['status'],'PASS')
            incomplete = m.result(cleanup_complete=False)
            self.assertEqual(incomplete['ordinaryRecovery']['status'],'INCOMPLETE')
            self.assertEqual(incomplete['ordinaryRecovery']['reason'],'cleanup-incomplete')
            self.assertEqual(incomplete['continuity']['status'],'INCOMPLETE')

    def test_wrong_class_missing_reset_host_change_and_owner_never_pass(self):
        for kind in ('wrong','reset','host','disconnect','owner','stale','clock','gap','human'):
            with self.subTest(kind=kind):
                m = self.model(); m.observe(model_row(m,302)); m.confirm_fault(302); m.transition('recovering')
                row = model_row(m,303,events=self.events(kind in ('wrong','reset')),socket='e'*16)
                if kind == 'reset': row['serverEvents'][-1]['leaseEpoch'] = 8
                if kind == 'host': row['hostObservation'].update(status='changed',coverage='incomplete')
                if kind == 'disconnect': row['hostObservation'].update(status='unavailable',coverage='incomplete',hostDisconnectObserved=True)
                if kind == 'owner': row['identity']['admissionHash'] = 'f'*16
                if kind == 'stale': row['serverEvents'][1]['viewerHash'] = 'f'*16
                if kind == 'clock': row['serverEvents'][1]['serverTimestampMs'] = 999
                if kind == 'gap': row['sample'] = None
                if kind == 'human': row['sample']['inputGate']['superseded'] = True
                m.observe(row)
                if m.phase != 'terminal': m.expire(363)
                result = m.result(cleanup_complete=True)
                self.assertNotEqual(result['ordinaryRecovery']['status'],'PASS')
                self.assertIsNotNone(result['failure'])

    def test_phase_graph_first_failure_and_baseline_disconnect(self):
        m = runner.OrdinaryRecoverySummary('baseline','stun')
        with self.assertRaises(ValueError): m.transition('fault')
        m.transition('startup'); m.startup = dict(runner.VERIFIED_STARTUP); m.expected_build = '0'*16
        m.observe(model_row(m,0)); m.fail('cleanup-incomplete')
        self.assertEqual(m.result(cleanup_complete=False)['failure']['reason'],'deployment-build-mismatch')
        self.assertEqual(m.result(cleanup_complete=False)['ordinaryRecovery']['reason'],'scenario-not-requested')
        m = self.model('baseline'); row = model_row(m,302); row['sample']['socketConnected'] = False
        m.observe(row); self.assertEqual(m.failure['reason'],'baseline-failed')


class FakeManager:
    def __init__(self, fail=None):
        self.fail=fail; self.calls=[]; self.chromium=self
    async def start(self):
        self.calls.append('start')
        if self.fail=='start': raise RuntimeError('secret')
        return self
    async def launch(self, **kwargs):
        self.calls.append(('launch',kwargs))
        if self.fail=='launch': raise RuntimeError('secret')
        return self
    async def new_context(self, **kwargs):
        self.calls.append(('context',kwargs))
        if self.fail=='context': raise RuntimeError('secret')
        return self
    async def new_page(self):
        self.calls.append('page')
        if self.fail=='page': raise RuntimeError('secret')
        return self
    async def close(self):
        self.calls.append('close')
        if self.fail=='close': raise RuntimeError('secret')
    async def stop(self): self.calls.append('stop')


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_factory_and_all_partial_start_failures_owned(self):
        for stage in ('factory','start','launch','context','page'):
            manager=FakeManager(stage); life=runner.OwnedBrowserLifecycle()
            def factory():
                if stage=='factory': raise RuntimeError('secret')
                return manager
            with self.assertRaises(RuntimeError): await life.start(factory)
            await life.cleanup(lambda: asyncio.sleep(0,result=runner.empty_diagnostic()))
            self.assertEqual('stop' in manager.calls, stage!='factory')
            self.assertEqual(life.snapshot()['ownedProcessExitEvidence'],'not-observed')

    async def test_close_failure_export_timeout_and_independent_stop(self):
        for kind in ('close','export'):
            manager=FakeManager(kind); life=runner.OwnedBrowserLifecycle(limits={'export':.04,'cleanup':.2,'managerStop':.04,'browserClose':.06})
            await life.start(lambda:manager)
            async def export():
                if kind=='export': await asyncio.sleep(5)
                return runner.empty_diagnostic()
            await life.cleanup(export)
            self.assertIn('stop',manager.calls)
            self.assertEqual(life.snapshot()['cleanupStatus'],'incomplete')
            self.assertNotIn('secret',json.dumps(life.record()))

    async def test_success_status_and_disarm_before_export(self):
        manager=FakeManager(); life=runner.OwnedBrowserLifecycle(); await life.start(lambda:manager)
        order=[]
        async def disarm(): order.append('disarm')
        async def export(): order.append('export'); return runner.empty_diagnostic()
        life.disarm=disarm; await life.cleanup(export)
        self.assertEqual(order,['disarm','export'])
        self.assertEqual(life.record()['python']['browserClose']['status'],'closed')
        self.assertEqual(life.record()['python']['managerStop']['status'],'ok')
        self.assertEqual(life.snapshot()['cleanupStatus'],'api-finished-exit-unknown')


def ui_state(**changes):
    return dict(shellAvailable=True,clientAvailable=True,marksAvailable=True,coreInstalled=True,
        authVerified=True,authCaptured=True,authCurrent=True,ownerCurrent=True,selectorValid=True,proofPresent=False,
        queuedStart=False,socketPresent=False,pcPresent=False,attemptPresent=False,
        htmlShellMarks=1,coreInteractiveMarks=1,startClickMarks=0,
        sessionId=None,socketId=None,admissionId=None,networkMode='stun',**changes)


class FakePage:
    def __init__(self, states=None, kind=None):
        self.url='https://example.invalid/viewer.html?wrdAdmission=vacant-only-v1'
        self.states=states or [ui_state()]; self.kind=kind; self.listeners={}; self.clicks=0; self.checks=0
    def on(self,name,fn): self.listeners.setdefault(name,[]).append(fn)
    def remove_listener(self,name,fn): self.listeners[name].remove(fn)
    def emit(self,name,value):
        for fn in self.listeners.get(name,[]): fn(value)
    def locator(self,selector): return self
    async def evaluate(self,script):
        value=dict(self.states.pop(0) if len(self.states)>1 else self.states[0])
        if self.clicks:
            value['startClickMarks']=2 if self.kind=='double-start' else 1
            if self.kind=='selector-after': value['selectorValid']=False
        return value
    async def is_visible(self): return self.kind!='hidden'
    async def is_enabled(self):
        self.checks+=1
        if self.kind=='auth-change' and self.checks==2: self.states[-1]['authCurrent']=False
        return True
    async def click(self,**kwargs):
        self.clicks+=1
        request=SimpleNamespace(url='https://example.invalid/api/auth/viewer-admission',method='POST',
            post_data=json.dumps({'viewerSessionId':'raw-session-canary','initialPolicy':'vacant-only-v1'}))
        self.emit('request',request)
        if self.kind=='double-api': self.emit('request',request)
        self.emit('response',SimpleNamespace(url=request.url,status=201))


class GuardedUiTests(unittest.IsolatedAsyncioTestCase):
    async def test_one_click_waits_for_delayed_core_and_auth(self):
        first=ui_state(); first.update(coreInstalled=False,authVerified=False,authCaptured=False,authCurrent=False)
        page=FakePage([first,ui_state()])
        value=await runner.start_guarded_via_ui(page,timeout_s=.4)
        self.assertEqual(value,runner.VERIFIED_STARTUP); self.assertEqual(page.clicks,1)
        self.assertNotIn('canary',json.dumps(value))

    async def test_stale_work_selector_proof_auth_and_duplicate_observations(self):
        cases=[('socketPresent',True),('pcPresent',True),('attemptPresent',True),('queuedStart',True),
               ('selectorValid',False),('proofPresent',True),('htmlShellMarks',2),('coreInteractiveMarks',2)]
        for field,value in cases:
            state=ui_state(); state[field]=value; page=FakePage([state])
            with self.subTest(field=field), self.assertRaises((ValueError,RuntimeError)):
                await runner.start_guarded_via_ui(page,timeout_s=.05)
            self.assertEqual(page.clicks,0)
        for kind in ('auth-change','selector-after','double-start','double-api','hidden'):
            page=FakePage(kind=kind)
            with self.subTest(kind=kind), self.assertRaises((ValueError,RuntimeError)):
                await runner.start_guarded_via_ui(page,timeout_s=.06)
            self.assertLessEqual(page.clicks,1)

    async def test_wrong_url_rejected_before_click_and_unknown_state_private(self):
        page=FakePage(); page.url='https://example.invalid/viewer.html'
        with self.assertRaisesRegex(ValueError,'selector-invalid'): await runner.start_guarded_via_ui(page)
        self.assertEqual(page.clicks,0)
        state=ui_state(); state['token']='token-canary'; page=FakePage([state])
        with self.assertRaisesRegex(ValueError,'schema-rejected'): await runner.start_guarded_via_ui(page)


class OwnedObservationTests(unittest.IsolatedAsyncioTestCase):
    async def test_pair_concurrent_failure_settles_other_and_no_default_reader(self):
        entered=asyncio.Event(); cancelled=asyncio.Event()
        async def page():
            entered.set()
            try: await asyncio.Event().wait()
            finally: cancelled.set()
        async def status():
            await entered.wait(); raise ValueError('host-observation-unavailable')
        with patch.object(runner,'read_local_host_status',side_effect=AssertionError('must inject')):
            with self.assertRaises(ValueError): await runner._observation_pair(page,status)
        self.assertTrue(cancelled.is_set())
        self.assertEqual([t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()],[])

    async def test_start_observations_continue_until_ui_finishes_and_settle_on_failure(self):
        ticks=[]; stopped=asyncio.Event()
        async def action():
            try: await asyncio.sleep(.045); return 'verified'
            finally: stopped.set()
        async def tick(): ticks.append(1)
        result=await runner._observe_start(action(),tick,interval=.01)
        self.assertEqual(result,'verified'); self.assertGreaterEqual(len(ticks),3); self.assertTrue(stopped.is_set())
        stopped.clear(); entered=asyncio.Event()
        async def pending():
            entered.set()
            try: await asyncio.Event().wait()
            finally: stopped.set()
        async def failure():
            await entered.wait(); raise ValueError('host-replaced')
        with self.assertRaisesRegex(ValueError,'host-replaced'): await runner._observe_start(pending(),failure,interval=.01)
        self.assertTrue(stopped.is_set())


class RunPreflightTests(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_manifest_persists_preflight_without_optional_imports(self):
        with tempfile.TemporaryDirectory() as folder:
            args=SimpleNamespace(origin='https://example.invalid',scenario='within-grace',mode='stun',
                runtime_manifest=str(Path(folder)/'missing'),runtime_manifest_sha256='a'*64,
                output_dir=str(Path(folder)/'out'),runtime_config=str(Path(folder)/'env'))
            import builtins
            real=builtins.__import__; seen=[]
            def restricted(name,*a,**kw):
                if name in ('dotenv','playwright.async_api'): seen.append(name); raise AssertionError('optional-import')
                return real(name,*a,**kw)
            with patch('builtins.__import__',restricted): result=await runner.run(args,manager_factory=lambda:None,status_reader=lambda:None)
            self.assertEqual(result,1); self.assertEqual(seen,[])
            value=json.loads((Path(args.output_dir)/'summary.json').read_text())
            self.assertEqual(value['failure'],{'phase':'preflight','reason':'runtime-manifest-unavailable'})
            self.assertIsNone(value['manifest']); self.assertEqual(value['ordinaryRecovery']['status'],'NOT_RUN')


class RecoveryBoundaryTests(unittest.TestCase):
    def test_lifetime_gap_does_not_erase_recovery_but_current_stall_or_no_progress_does(self):
        helper=ClassifierTests()
        for case in ('fresh','stale','no-progress','regressed'):
            m=helper.model('after-grace'); m.observe(model_row(m,302)); m.confirm_fault(302); m.transition('recovering')
            for n in range(303,334):
                count=400+n if case!='no-progress' else 703
                if case=='regressed' and n==308: count=1
                sample=ready_sample(count,5); sample['maxFrameGapMs']=13000
                if case=='stale' and n==308: sample['frameAgeMs']=5000
                m.observe(model_row(m,n,sample=sample,socket='e'*16,events=helper.events(True) if n==303 else []))
                if m.phase=='terminal': break
            result=m.result(cleanup_complete=True)
            self.assertEqual(result['ordinaryRecovery']['status']=='PASS',case=='fresh')
            self.assertEqual(result['continuity']['status'],'INCOMPLETE')

    def test_recovered_stability_not_finished_and_missing_reset_deadline(self):
        h=ClassifierTests(); m=h.model(); m.observe(model_row(m,302)); m.confirm_fault(302); m.transition('recovering')
        m.observe(model_row(m,303,socket='e'*16,events=h.events(),sample=ready_sample(500)))
        self.assertEqual(m.result(cleanup_complete=True)['ordinaryRecovery']['status'],'INCOMPLETE')
        m=h.model('after-grace'); m.observe(model_row(m,302)); m.confirm_fault(302); m.transition('recovering')
        m.observe(model_row(m,303,events=h.events(True)[:2],sample=ready_sample(500,5)))
        m.expire(362)
        self.assertEqual(m.failure['reason'],'reset-unconfirmed')
        self.assertEqual(m.result(cleanup_complete=True)['ordinaryRecovery']['status'],'INCOMPLETE')

    def test_actual_reader_failure_causes_share_generic_matched_outcome(self):
        h=ClassifierTests()
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'signal.jsonl'; path.write_bytes(b'')
            for cause in ('rebind-timeout','rebind-rejected','rebind-cancelled'):
                for coverage in ('complete','incomplete'):
                    with self.subTest(cause=cause,coverage=coverage):
                        e=ServerRecoveryEvidence(path,SALT); e.start()
                        start=event(); failed=rebind_event('viewer_rebind_failed',viewerId='socket-new'); failed['meta']['reason']=cause
                        with path.open('ab') as f:
                            for raw in (start,failed): f.write(json.dumps(raw).encode()+b'\n')
                        events=e.read_tick(IDS); e.close()
                        m=h.model(); m.identity=dict(sessionHash=hash_identity('session-canary',SALT),socketHash=hash_identity('socket-old',SALT),admissionHash='d'*16)
                        m.confirm_fault(301); m.transition('recovering'); m.server_coverage=coverage
                        row=model_row(m,302,events=events,socket=hash_identity('socket-new',SALT)); row['identity']['sessionHash']=m.identity['sessionHash']
                        m.observe(row); result=m.result(cleanup_complete=True)
                        self.assertEqual(result['ordinaryRecovery']['reason'],'recovery-gates-unmet')
                        self.assertEqual(result['ordinaryRecovery']['status'],'FAIL' if coverage=='complete' else 'INCOMPLETE')
                        self.assertNotIn(cause,json.dumps(result))

    def test_foreign_failure_never_binds_current_reducer(self):
        h=ClassifierTests(); m=h.model(); m.observe(model_row(m,302)); m.confirm_fault(302); m.transition('recovering')
        events=h.events(); events[1].update(event='rebind-failed',sessionHash='f'*16,leaseEpoch=None)
        m.observe(model_row(m,303,events=events,socket='e'*16))
        self.assertIsNone(m.failure); self.assertEqual(m.classification,'unclassified')

    def test_first_disconnect_terminal_even_if_current_sample_looks_ready(self):
        h=ClassifierTests(); m=h.model('baseline'); row=model_row(m,302)
        row['sample']['diagnostics']['firstDisconnectEvent']={'t':10,'n':1,'k':'sd','o':'s1','c':True,'r':'transport-close'}
        m.observe(row); self.assertEqual(m.failure['reason'],'baseline-failed')


class RuntimePage(FakePage):
    def __init__(self,kind=None):
        super().__init__(kind=kind); self.navigation=[]; self.selected=None; self.samples=0; self.installations=[]
        self.login_entered=asyncio.Event()
    def set_default_timeout(self,value): pass
    async def add_init_script(self,value): self.installations.append('mode')
    async def goto(self,url,**kwargs):
        self.url=url; self.navigation.append(url); return SimpleNamespace(status=200)
    def locator(self,selector): self.selected=selector; return self
    async def fill(self,value): pass
    async def click(self,**kwargs):
        if self.selected!='#startBtn':
            self.url='https://example.invalid/viewer.html'; return
        return await super().click(**kwargs)
    async def wait_for_url(self,*a,**kw):
        self.login_entered.set()
        if self.kind=='login-wait': await asyncio.Event().wait()
    async def evaluate(self,script):
        if script==runner.OBSERVATION_INSTALL: self.installations.append('observation'); return None
        if script==runner.OBSERVE_UI: return await super().evaluate(script)
        if 'window.__wrdPassiveSampler.sample()' in script:
            self.samples+=1
            if self.samples>=3 and 'finalize' not in script: raise ValueError('human-priority')
            state=ui_state(); state['startClickMarks']=int(self.clicks>0)
            state.update(sessionId='session-canary',socketId='socket-canary',admissionId='admission-canary')
            sample=ready_sample(10+self.samples); sample.pop('attemptHash'); sample['attempt']='attempt-canary'
            value=dict(state=state,sample=sample)
            if 'finalize' in script: value['diagnostic']=runner.empty_diagnostic()
            return value
        self.installations.append('sampler'); return None


class RuntimeManager(FakeManager):
    def __init__(self,page): super().__init__(); self.page=page
    async def new_page(self): self.calls.append('page'); return self.page


class RuntimeRunTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup); self.root=Path(self.temp.name)
        self.log=self.root/'signal.jsonl'; self.log.write_bytes(b'')
        value=valid_manifest(self.log,round(runner.time.time()*1000)); self.manifest=self.root/'manifest.json'
        self.manifest.write_text(json.dumps(value)); self.manifest.chmod(0o600)
        self.args=SimpleNamespace(origin='https://example.invalid',scenario='baseline',mode='stun',runtime_manifest=self.manifest,
            runtime_manifest_sha256=hashlib.sha256(self.manifest.read_bytes()).hexdigest(),output_dir=str(self.root/'out'),runtime_config=self.root/'env')
        self.patch=patch.dict('sys.modules',{'dotenv':SimpleNamespace(dotenv_values=lambda _: {'VIEWER_ACCESS_PASSWORD':'password-canary'})})
        self.patch.start(); self.addCleanup(self.patch.stop)
    async def status(self): return dict(hostOnline=True,hostId='host-canary')
    def summary(self): return json.loads((Path(self.args.output_dir)/'summary.json').read_text())

    async def test_login_redirect_final_guarded_navigation_one_start_and_private_terminal_evidence(self):
        page=RuntimePage(); manager=RuntimeManager(page)
        result=await runner.run(self.args,manager_factory=lambda:manager,status_reader=self.status)
        self.assertEqual(result,1); self.assertEqual(page.clicks,1)
        self.assertEqual(page.navigation,['https://example.invalid','https://example.invalid/viewer.html?wrdAdmission=vacant-only-v1'])
        self.assertEqual(page.installations,['mode','observation','sampler'])
        self.assertEqual(self.summary()['failure']['reason'],'human-priority')
        self.assertIn('close',manager.calls); self.assertIn('stop',manager.calls)
        output=''.join(p.read_text() for p in Path(self.args.output_dir).iterdir())
        for private in ('password-canary','session-canary','socket-canary','attempt-canary','host-canary',str(self.log)):
            self.assertNotIn(private,output)
        for path in Path(self.args.output_dir).iterdir(): self.assertEqual(path.stat().st_mode&0o777,0o600)

    async def test_initial_write_failure_never_constructs_manager(self):
        calls=[]
        with patch.object(runner.passive,'atomic_evidence',side_effect=OSError('secret-error')):
            result=await runner.run(self.args,manager_factory=lambda:calls.append(1),status_reader=self.status)
        self.assertEqual(result,1); self.assertEqual(calls,[])

    async def test_final_write_failure_still_closes_and_stops(self):
        page=RuntimePage(); manager=RuntimeManager(page); original=runner.passive.atomic_evidence
        def write(path,value,**kw):
            if not kw.get('initial'): raise OSError('secret-write')
            return original(path,value,**kw)
        with patch.object(runner.passive,'atomic_evidence',write):
            result=await runner.run(self.args,manager_factory=lambda:manager,status_reader=self.status)
        self.assertEqual(result,1); self.assertIn('close',manager.calls); self.assertIn('stop',manager.calls)

    async def test_repeated_cancel_keeps_one_cleanup_coordinator_and_original_deadline(self):
        page=RuntimePage('login-wait'); manager=RuntimeManager(page); entered=asyncio.Event()
        async def close():
            manager.calls.append('close'); entered.set(); await asyncio.sleep(.03)
        manager.close=close
        task=asyncio.create_task(runner.run(self.args,manager_factory=lambda:manager,status_reader=self.status,
            limits={'cleanup':.3,'export':.05,'browserClose':.1,'managerStop':.1}))
        await page.login_entered.wait(); task.cancel(); await entered.wait()
        for _ in range(3): task.cancel(); await asyncio.sleep(.005)
        self.assertEqual(await task,1); self.assertEqual(manager.calls.count('close'),1); self.assertEqual(manager.calls.count('stop'),1)
        self.assertEqual(self.summary()['failure']['reason'],'cancelled')
        self.assertEqual([t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()],[])

    async def test_final_status_host_change_cannot_be_cleared_by_ready_viewer(self):
        page=RuntimePage(); manager=RuntimeManager(page); calls=0
        async def status():
            nonlocal calls
            calls+=1; return dict(hostOnline=True,hostId='replacement' if calls>=4 else 'host-canary')
        await runner.run(self.args,manager_factory=lambda:manager,status_reader=status)
        self.assertEqual(self.summary()['hostObservation']['status'],'changed')
        self.assertEqual(self.summary()['ordinaryRecovery']['status'],'NOT_RUN')

    async def test_dependency_absence_and_absent_fault_adapter_before_manager(self):
        import builtins
        real=builtins.__import__; calls=[]
        def no_dotenv(name,*a,**kw):
            if name=='dotenv': raise ImportError()
            return real(name,*a,**kw)
        with patch('builtins.__import__',no_dotenv):
            self.assertEqual(await runner.run(self.args,manager_factory=lambda:calls.append(1),status_reader=self.status),1)
        self.assertEqual(calls,[]); self.assertEqual(self.summary()['failure']['reason'],'runtime-dependency-unavailable')


class TerminalSafetyTests(unittest.IsolatedAsyncioTestCase):
    async def test_first_close_retained_when_export_mutates_last_delta(self):
        life=runner.OwnedBrowserLifecycle(); await life.start(lambda:FakeManager())
        first={'t':10,'n':1,'k':'sd','o':'s1','c':True,'r':'transport-close'}
        life.diagnostic['attribution']=dict(firstDisconnectEvent=first,cause='unknown')
        async def export():
            life.diagnostic=runner.empty_diagnostic()
            return runner.empty_diagnostic()
        await life.cleanup(export)
        self.assertEqual(life.record()['diagnostics']['attribution']['firstDisconnectEvent'],first)

    async def test_noncooperative_browser_close_remains_incomplete_and_manager_stops(self):
        manager=FakeManager(); released=asyncio.Event(); task_ref=[]
        async def close():
            task_ref.append(asyncio.current_task())
            while not released.is_set():
                try: await released.wait()
                except asyncio.CancelledError: pass
        manager.close=close
        life=runner.OwnedBrowserLifecycle(limits={'cleanup':.2,'browserClose':.04,'managerStop':.05,'export':.03})
        await life.start(lambda:manager)
        await life.cleanup(lambda:asyncio.sleep(0,result=runner.empty_diagnostic()))
        self.assertEqual(life.python['browserClose']['status'],'noncooperative')
        self.assertIn('stop',manager.calls); self.assertEqual(life.snapshot()['cleanupStatus'],'incomplete')
        released.set(); await task_ref[0]

    async def test_status_timeout_is_host_unavailable_and_other_child_settles(self):
        async def page(): await asyncio.Event().wait()
        async def status(): raise TimeoutError()
        with self.assertRaisesRegex(ValueError,'host-observation-unavailable'):
            await runner._observation_pair(page,status)

    def test_late_expiry_and_recovered_path_change_prevent_pass(self):
        helper=ClassifierTests()
        for kind in ('expiry','path'):
            m=helper.model(); m.observe(model_row(m,302)); m.confirm_fault(302); m.transition('recovering')
            m.observe(model_row(m,303,sample=ready_sample(500),socket='e'*16,events=helper.events()))
            row=model_row(m,304,sample=ready_sample(501),socket='e'*16)
            if kind=='expiry':
                event=helper.events(True)[1]; event['n']=3; row['serverEvents']=[event]
            else: row['sample']['transport']['pathIdentity']='path-2'
            m.observe(row)
            self.assertIsNotNone(m.failure)
            self.assertNotEqual(m.result(cleanup_complete=True)['ordinaryRecovery']['status'],'PASS')

    def test_exact_summary_rejects_unknown_private_fields_and_impossible_pass(self):
        m=runner.OrdinaryRecoverySummary('baseline','stun'); original=m.result(cleanup_complete=False)
        self.assertIs(runner.validate_summary(original),original)
        for container,key,value in (('root','url','https://canary'),('fault','error','error-canary'),
                                   ('lifecycle','token','token-canary'),('ordinaryRecovery','status','PASS')):
            item=json.loads(json.dumps(original)); target=item if container=='root' else item[container]; target[key]=value
            with self.subTest(container=container), self.assertRaises(ValueError): runner.validate_summary(item)


class AdditionalOwnershipTests(unittest.IsolatedAsyncioTestCase):
    async def test_sync_start_and_manager_exit_fallback(self):
        calls=[]
        class Browser:
            def new_context(self,**kwargs):
                calls.append(kwargs); return self
            def new_page(self): return self
            async def close(self): calls.append('closed')
        class Playwright:
            def __init__(self): self.chromium=self
            def launch(self,**kw): return Browser()
        class Manager:
            def __aenter__(self): return Playwright()
            async def __aexit__(self,*args): calls.append(('exit',args))
        life=runner.OwnedBrowserLifecycle(); await life.start(Manager)
        await life.cleanup(lambda:asyncio.sleep(0,result=runner.empty_diagnostic()))
        self.assertIn({'service_workers':'block'},calls); self.assertIn(('exit',(None,None,None)),calls)
        self.assertEqual(life.snapshot()['cleanupStatus'],'api-finished-exit-unknown')

    async def test_partial_final_export_cancels_status_inside_same_deadline(self):
        stopped=asyncio.Event(); started=asyncio.Event()
        async def status():
            started.set()
            try: await asyncio.Event().wait()
            finally: stopped.set()
        async def page(): await started.wait(); return runner.empty_diagnostic()
        with self.assertRaises(TimeoutError):
            await runner.lifecycle_stage(runner._observation_pair(page,status),.12,settlement=.08)
        self.assertTrue(stopped.is_set())
        self.assertEqual([t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()],[])

    async def test_status_gap_in_startup_stops_owned_ui_and_never_restarts(self):
        entered=asyncio.Event(); stopped=asyncio.Event(); calls=[]; observer=HostContinuityObserver(SALT)
        observer.observe_status(dict(hostOnline=True,hostId='host-canary'),0)
        async def action():
            calls.append('action'); entered.set()
            try: await asyncio.Event().wait()
            finally: stopped.set()
        async def tick():
            await entered.wait(); observer.observe_status(dict(hostOnline=True,hostId='host-canary'),1600)
            raise ValueError(observer.reason)
        with self.assertRaisesRegex(ValueError,'host-observation-gap'):
            await runner._observe_start(action(),tick,interval=.01)
        self.assertTrue(stopped.is_set()); self.assertEqual(calls,['action'])
        self.assertEqual(observer.snapshot()['coverage'],'incomplete')


class MoreRuntimeTests(unittest.IsolatedAsyncioTestCase):
    setUp=RuntimeRunTests.setUp
    status=RuntimeRunTests.status
    summary=RuntimeRunTests.summary
    async def test_manifest_changed_during_ui_final_export_preserves_first_failure(self):
        page=RuntimePage(); manager=RuntimeManager(page)
        async def status():
            self.manifest.write_bytes(self.manifest.read_bytes()+b' ')
            return await self.status()
        await runner.run(self.args,manager_factory=lambda:manager,status_reader=status)
        value=self.summary()
        self.assertEqual(value['failure']['reason'],'human-priority')
        self.assertEqual(value['lifecycle']['cleanupStatus'],'incomplete')
        self.assertNotIn(str(self.manifest),json.dumps(value))

    async def test_fault_module_absence_before_factory_and_no_fault_does_not_import(self):
        self.args.scenario='within-grace'
        value=json.loads(self.manifest.read_text()); value['scenario']='within-grace'; self.manifest.write_text(json.dumps(value))
        self.args.runtime_manifest_sha256=hashlib.sha256(self.manifest.read_bytes()).hexdigest(); calls=[]
        with patch.dict('sys.modules',{'scripts.ordinary_recovery_fault':None}):
            result=await runner.run(self.args,manager_factory=lambda:calls.append(1),status_reader=self.status)
        self.assertEqual(result,1); self.assertEqual(calls,[])
        self.assertEqual(self.summary()['ordinaryRecovery']['status'],'NOT_RUN')
        self.assertEqual(self.summary()['failure']['reason'],'fault-capability-unavailable')


class CliTests(unittest.TestCase):
    def test_direct_help_and_invalid_manifest_need_no_runtime(self):
        import subprocess
        executable='/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11'
        script=str(Path(runner.__file__).resolve())
        help_result=subprocess.run([executable,script,'--help'],capture_output=True,text=True)
        self.assertEqual(help_result.returncode,0); self.assertIn('--runtime-manifest',help_result.stdout)
        with tempfile.TemporaryDirectory() as folder:
            result=subprocess.run([executable,script,'--origin','https://example.invalid','--mode','stun','--scenario','baseline',
                '--runtime-manifest',str(Path(folder)/'missing'),'--runtime-manifest-sha256','a'*64,
                '--output-dir',str(Path(folder)/'out')],capture_output=True,text=True)
            self.assertEqual(result.returncode,1); self.assertEqual(result.stderr,'')
            summary=json.loads((Path(folder)/'out'/'summary.json').read_text())
            self.assertEqual(summary['failure']['reason'],'runtime-manifest-unavailable')


class FinalCoverageTests(unittest.IsolatedAsyncioTestCase):
    setUp=RuntimeRunTests.setUp
    status=RuntimeRunTests.status
    summary=RuntimeRunTests.summary

    async def test_wrong_loaded_build_stops_before_start(self):
        page=RuntimePage(); evaluate=page.evaluate
        async def changed(script):
            result=await evaluate(script)
            if type(result) is dict and 'sample' in result: result['sample']['buildId']='f'*16
            return result
        page.evaluate=changed; manager=RuntimeManager(page)
        self.assertEqual(await runner.run(self.args,manager_factory=lambda:manager,status_reader=self.status),1)
        self.assertEqual(page.clicks,0); self.assertEqual(self.summary()['failure']['reason'],'deployment-build-mismatch')

    async def test_log_alarm_still_drained_when_page_sample_fails(self):
        page=RuntimePage(); manager=RuntimeManager(page); count=0
        async def status():
            nonlocal count
            count+=1
            if count==3:
                raw=event('signal_socket_disconnected',meta={'role':'host','reason':'transport close'})
                raw['domain']='signaling'; raw['correlation']={}
                with self.log.open('ab') as f: f.write(json.dumps(raw).encode()+b'\n')
            return await self.status()
        await runner.run(self.args,manager_factory=lambda:manager,status_reader=status)
        self.assertTrue(self.summary()['hostObservation']['hostDisconnectObserved'])
        self.assertEqual(self.summary()['failure']['reason'],'human-priority')

    def test_after_grace_host_replacement_or_disconnect_remains_incomplete_with_good_final_gates(self):
        h=ClassifierTests()
        for kind in ('replacement','disconnect'):
            m=h.model('after-grace'); m.observe(model_row(m,302)); m.confirm_fault(302); m.transition('recovering')
            observer=HostContinuityObserver(SALT); observer.observe_status(dict(hostOnline=True,hostId='original'),0)
            if kind=='replacement': observer.observe_status(dict(hostOnline=True,hostId='replacement'),1000)
            else: observer.observe_host_disconnect()
            host=observer.observe_status(dict(hostOnline=True,hostId='original'),2000)
            row=model_row(m,303,socket='e'*16,sample=ready_sample(500,5),events=h.events(True)); row['hostObservation']=host
            m.observe(row); result=m.result(cleanup_complete=True)
            self.assertEqual(result['ordinaryRecovery']['status'],'INCOMPLETE')
            self.assertEqual(result['hostObservation']['coverage'],'incomplete')
            self.assertTrue(row['sample']['inputAllowed']); self.assertEqual(row['identity']['admissionHash'],'d'*16)
