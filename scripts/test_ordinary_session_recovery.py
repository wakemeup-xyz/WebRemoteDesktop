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
        rebind['correlation'] = {'viewerId': 'socket-new', 'previousViewerId': 'socket-old'}
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
