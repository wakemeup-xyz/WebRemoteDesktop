"""Pure recorder and AST cleanup tests; no Host/native imports or actual tasks."""
import ast
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
import unittest


class Hold:
    def __await__(self):
        yield 'held'
        return None


class Log:
    def __init__(self):
        self.records = []
        self.legacy_reasons = []
        self.fail = False
        self.attempts = 0
    def info(self, message, *args):
        self.attempts += 1
        if self.fail:
            raise self.fail if isinstance(self.fail, BaseException) else RuntimeError('logger-secret-canary')
        if message.startswith('WRD_PEER_CLEANUP '):
            self.records.append(json.loads(args[0]))
        elif message.startswith('WRD_MEDIA_RESOURCES '):
            self.legacy_reasons.append(args[0])
        else:
            self.legacy_reasons.append(message % args if args else message)
    warning = error = info
    def terminal(self):
        return [record for record in self.records if record['event'] == 'terminal']


def close_method(log, clock=None):
    tree = ast.parse(Path(__file__).with_name('host.py').read_text())
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'WebRemoteHost')
    node = next(node for node in cls.body if isinstance(node, ast.AsyncFunctionDef)
                and node.name == '_close_peer_connection')
    namespace = dict(logger=log, asyncio=asyncio, json=json,
        time=SimpleNamespace(monotonic_ns=clock or (lambda: 1_000_000)))
    if Path(__file__).with_name('peer_cleanup_observation.py').exists():
        import peer_cleanup_observation
        namespace.update(vars(peer_cleanup_observation))
    exec(compile(ast.Module(body=[node], type_ignores=[]), '<AST peer cleanup>', 'exec'), namespace)
    return namespace['_close_peer_connection']


def recovery_close_method(log):
    tree = ast.parse(Path(__file__).with_name('host.py').read_text())
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'WebRemoteHost')
    node = next(node for node in cls.body if isinstance(node, ast.AsyncFunctionDef)
                and node.name == '_close_peer_for_recovery')
    namespace = dict(logger=log, asyncio=asyncio)
    exec(compile(ast.Module(body=[node], type_ignores=[]), '<AST peer recovery>', 'exec'), namespace)
    return namespace['_close_peer_for_recovery']


def host():
    obj = SimpleNamespace(pc=None, screen_track=None, video_sender=None,
        pending_candidates=[], _active_input_binding={'leaseEpoch': 7},
        _input_datachannel=None, _input_move_datachannel=None,
        _keyframe_recovery_state={'old': True}, _frame_trace_context='old',
        _media_apply_coordinator=SimpleNamespace(cancel_pending=lambda: None),
        _authority=0, calls=[])
    def advance():
        obj._authority += 1
    async def reset(*args, **kwargs):
        obj.calls.append('reset')
        return {'status': 'applied'}
    obj._advance_authority = advance
    obj._capture_authority = lambda: obj._authority
    obj._authority_matches = lambda value: value == obj._authority
    obj._reset_keyboard_lifecycle = reset
    return obj


def complete(coroutine):
    try:
        coroutine.send(None)
    except StopIteration as result:
        return result.value
    raise AssertionError('unexpected suspension')


class HostPeerCleanupTest(unittest.TestCase):
    def test_overlapping_invocations_keep_both_terminals_and_new_peer_state(self):
        log = Log()
        close = close_method(log)
        obj = host()
        old_pc = SimpleNamespace(connectionState='connected')
        async def pc_close():
            obj.calls.append('peer')
            await Hold()
            old_pc.connectionState = 'closed'
        old_pc.close = pc_close
        async def shutdown():
            obj.calls.append('track')
        old_track = SimpleNamespace(shutdown=shutdown, set_suspended=lambda value: None,
            resource_snapshot=lambda: {'captureThreadAlive': False,
                'captureCloseState': 'closed', 'captureShutdownJoin': 'returned',
                'executorShutdownRequested': True})
        obj.pc, obj.screen_track, obj.video_sender = old_pc, old_track, object()
        first = close(obj, reason='manual')
        self.assertEqual(first.send(None), 'held')
        self.assertIsNone(obj.pc)
        complete(close(obj, reason='viewer-disconnected'))
        new_pc, new_track, new_sender = object(), object(), object()
        recovery, trace = {'new': True}, object()
        coordinator_calls = []
        coordinator = SimpleNamespace(cancel_pending=lambda: coordinator_calls.append('cancel'))
        obj.pc, obj.screen_track, obj.video_sender = new_pc, new_track, new_sender
        obj._keyframe_recovery_state, obj._frame_trace_context = recovery, trace
        obj._media_apply_coordinator = coordinator
        complete(first)
        self.assertIs(obj.pc, new_pc)
        self.assertIs(obj.screen_track, new_track)
        self.assertIs(obj.video_sender, new_sender)
        self.assertIs(obj._keyframe_recovery_state, recovery)
        self.assertIs(obj._frame_trace_context, trace)
        self.assertIs(obj._media_apply_coordinator, coordinator)
        self.assertEqual(coordinator_calls, [])
        self.assertEqual(obj.calls, ['reset', 'peer', 'reset', 'track'])
        terminal_reasons = {record['reason'] for record in log.terminal()} | set(log.legacy_reasons)
        self.assertEqual(terminal_reasons, {'manual', 'viewer-disconnected'})
        self.assertEqual(len(log.records), 4)

        starts = [item for item in log.records if item['event'] == 'start']
        terminals = log.terminal()
        self.assertEqual([item['cleanupSequence'] for item in starts], [1, 2])
        self.assertEqual([item['cleanupSequence'] for item in terminals], [2, 1])
        empty, old = terminals
        self.assertFalse(empty['peerPresent'])
        self.assertFalse(empty['trackPresent'])
        self.assertTrue(old['peerPresent'])
        self.assertTrue(old['trackPresent'])
        self.assertTrue(old['peerConnectionClosed'])
        self.assertEqual(old['captureCloseState'], 'closed')
        self.assertFalse(old['authorityCurrent'])
        self.assertTrue(old['currentPeerPresent'])
        self.assertIsNone(old['senderReleaseConfirmed'])

    def test_recovery_peer_close_timeout_keeps_background_cleanup_and_emits_bounded_diagnostic(self):
        async def scenario():
            log = Log()
            close = recovery_close_method(log)
            finished = asyncio.Event()

            class Peer:
                connectionState = 'connected'

                async def close(self):
                    await finished.wait()

            obj = SimpleNamespace()
            task = asyncio.create_task(close(obj, Peer(), timeout_ms=1))
            await asyncio.sleep(0)
            status = await task
            self.assertEqual(status, 'timed-out')
            self.assertTrue(any('WRD_PEER_CLOSE_TIMEOUT' in line for line in log.legacy_reasons))
            pending = list(getattr(obj, '_peer_close_tasks', ()))
            self.assertEqual(len(pending), 1)
            for item in pending:
                item.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

        asyncio.run(scenario())


class PeerCleanupObservationTest(unittest.TestCase):
    def record(self, **kwargs):
        from peer_cleanup_observation import PeerCleanupObservation
        options = dict(peer_present=True, track_present=True, sender_present=True, now_ns=0)
        options.update(kwargs)
        return PeerCleanupObservation(1, 'manual', **options)

    def test_fixed_shape_and_independent_release_facts(self):
        from peer_cleanup_observation import peer_cleanup_json
        record = self.record()
        record.stage('resetInput', 'returned', 'rejected')
        record.stage('peerClose', 'returned')
        record.stage('trackShutdown', 'returned')
        terminal = record.terminal('returned', 1_000_000, dict(
            peerConnectionClosed=False, captureThreadAlive=True,
            captureCloseState='worker-owned', captureShutdownJoin='pending',
            executorShutdownRequested=True, senderReleaseConfirmed=True,
            authorityCurrent=False, currentPeerPresent=True, secret='secret-canary'))
        self.assertEqual(terminal['stages'], dict(resetInput='returned',
            peerClose='returned', trackShutdown='returned'))
        self.assertEqual(terminal['resetResult'], 'rejected')
        self.assertFalse(terminal['peerConnectionClosed'])
        self.assertTrue(terminal['captureThreadAlive'])
        self.assertEqual(terminal['captureCloseState'], 'worker-owned')
        self.assertIsNone(terminal['senderReleaseConfirmed'])
        base = {'schemaVersion', 'cleanupSequence', 'sequenceClipped', 'sequenceUnique',
                'reason', 'peerPresent', 'trackPresent', 'senderPresent', 'event'}
        self.assertEqual(set(record.start_record()), base)
        self.assertEqual(set(terminal), base | {'outcome', 'elapsedMs', 'clipped', 'stages',
            'resetResult', 'peerConnectionClosed', 'captureThreadAlive', 'captureCloseState',
            'captureShutdownJoin', 'executorShutdownRequested', 'senderReleaseConfirmed',
            'authorityCurrent', 'currentPeerPresent'})
        for value in (record.start_record(), terminal):
            encoded = peer_cleanup_json(value)
            self.assertLessEqual(len(encoded.encode()), 2048)
            self.assertNotIn('secret-canary', encoded)
            self.assertEqual(json.loads(encoded), value)
        terminal['stages']['peerClose'] = 'failed'
        self.assertEqual(record.terminal('returned', 0, {})['stages']['peerClose'], 'returned')
        record.start_record()['reason'] = 'changed'
        self.assertEqual(record.start_record()['reason'], 'manual')

    def test_timeout_terminal_includes_only_bounded_close_metadata(self):
        from peer_cleanup_observation import peer_cleanup_json
        record = self.record()
        record.stage('peerClose', 'timed-out')
        record.peer_close_timeout(3000)
        terminal = record.terminal('returned', 1_000_000, {
            'peerConnectionClosed': False,
            'captureCloseState': 'unknown',
        })
        self.assertTrue(terminal['peerCloseTimedOut'])
        self.assertEqual(terminal['peerCloseTimeoutMs'], 3000)
        encoded = peer_cleanup_json(terminal)
        self.assertLessEqual(len(encoded.encode()), 2048)
        self.assertEqual(json.loads(encoded), terminal)

    def test_scalar_allowlists_never_evaluate_or_retain_objects(self):
        from peer_cleanup_observation import PeerCleanupObservation, peer_cleanup_json
        class Secret:
            def __repr__(self):
                raise AssertionError('representation used')
            def __bool__(self):
                raise AssertionError('truthiness used')
            def __eq__(self, other):
                raise AssertionError('equality used')
        for bad in ('secret-canary', [], {}, Secret(), True, 1, None):
            with self.subTest(value_type=type(bad).__name__):
                record = PeerCleanupObservation(1, bad, peer_present=bad,
                    track_present=bad, sender_present=bad, now_ns=bad)
                record.stage(bad, bad, bad)
                record.stage('resetInput', bad, bad)
                terminal = record.terminal(bad, bad, dict(peerConnectionClosed=bad,
                    captureCloseState=bad, captureShutdownJoin=bad,
                    captureThreadAlive=bad, executorShutdownRequested=bad))
                encoded = peer_cleanup_json(terminal)
                self.assertNotIn('secret-canary', encoded)
                self.assertEqual(terminal['reason'], 'unknown')
                self.assertEqual(terminal['resetResult'], 'unknown')
                self.assertIsNone(terminal['senderReleaseConfirmed'])

    def test_duration_invalid_backward_and_capped(self):
        from peer_cleanup_observation import DURATION_CAP_NS
        for start, end in ((True, 1), (0, False), (None, 2), (0, 'secret'),
                           (-1, 0), (0, -1), (2, 1), (1.5, 2), (0, float('inf'))):
            with self.subTest(start=start, end=end):
                self.assertIsNone(self.record(now_ns=start).terminal('returned', end, {})['elapsedMs'])
        self.assertEqual(self.record().terminal('returned', 0, {})['elapsedMs'], 0)
        capped = self.record().terminal('returned', DURATION_CAP_NS + 1, {})
        self.assertEqual(capped['elapsedMs'], DURATION_CAP_NS / 1_000_000)
        self.assertTrue(capped['clipped'])

    def test_sequence_saturation_and_invalid_sequences(self):
        from peer_cleanup_observation import PeerCleanupObservation, SEQUENCE_CAP
        for sequence in (SEQUENCE_CAP, SEQUENCE_CAP + 1, 10 ** 100):
            item = PeerCleanupObservation(sequence, 'manual', peer_present=False,
                track_present=False, sender_present=False, now_ns=0).start_record()
            self.assertEqual(item['cleanupSequence'], SEQUENCE_CAP)
            self.assertTrue(item['sequenceClipped'])
            self.assertFalse(item['sequenceUnique'])
        for sequence in (None, True, -1, 0, 'secret-canary'):
            item = PeerCleanupObservation(sequence, 'manual', peer_present=False,
                track_present=False, sender_present=False, now_ns=0).start_record()
            self.assertIsNone(item['cleanupSequence'])
            self.assertFalse(item['sequenceUnique'])


class HostPeerCleanupEdgesTest(unittest.TestCase):
    def configured(self, target=None, *, hold=False, error=None, log=None):
        obj, log = host(), log or Log()
        pc = SimpleNamespace(connectionState='connected')
        track = SimpleNamespace(set_suspended=lambda value: None,
            resource_snapshot=lambda: {'captureThreadAlive': True,
                'captureCloseState': 'worker-owned', 'captureShutdownJoin': 'pending',
                'executorShutdownRequested': True})
        def step(name):
            async def action(*args, **kwargs):
                obj.calls.append(name)
                if target == name:
                    if hold:
                        await Hold()
                    if error is not None:
                        raise error
                return {'status': 'applied'}
            return action
        obj._reset_keyboard_lifecycle, pc.close, track.shutdown = [step(name)
            for name in ('reset', 'peer', 'track')]
        obj.pc, obj.screen_track, obj.video_sender = pc, track, object()
        return obj, log, close_method(log)

    def test_each_await_failure_preserves_error_and_skips_later_stages(self):
        for index, target in enumerate(('reset', 'peer', 'track')):
            error = RuntimeError('exception-secret-canary')
            with self.subTest(target=target):
                obj, log, close = self.configured(target, error=error)
                with self.assertRaises(RuntimeError) as caught:
                    complete(close(obj, reason='reason-secret-canary'))
                self.assertIs(caught.exception, error)
                terminal, = log.terminal()
                names = ('resetInput', 'peerClose', 'trackShutdown')
                self.assertEqual([terminal['stages'][name] for name in names],
                    ['returned'] * index + ['failed'] + ['not-started'] * (2 - index))
                self.assertEqual(obj.calls, ['reset', 'peer', 'track'][:index + 1])
                self.assertEqual(terminal['outcome'], 'failed')
                self.assertEqual(len(log.records), 2)
                self.assertNotIn('secret-canary', json.dumps(log.records))

    def test_cancellation_at_each_await_propagates_same_object_and_skips_later(self):
        for index, target in enumerate(('reset', 'peer', 'track')):
            with self.subTest(target=target):
                obj, log, close = self.configured(target, hold=True)
                coroutine = close(obj)
                self.assertEqual(coroutine.send(None), 'held')
                cancellation = asyncio.CancelledError('cancel-secret-canary')
                with self.assertRaises(asyncio.CancelledError) as caught:
                    coroutine.throw(cancellation)
                self.assertIs(caught.exception, cancellation)
                terminal, = log.terminal()
                self.assertEqual(terminal['outcome'], 'cancelled')
                self.assertEqual([terminal['stages'][name] for name in
                    ('resetInput', 'peerClose', 'trackShutdown')],
                    ['returned'] * index + ['cancelled'] + ['not-started'] * (2 - index))
                self.assertEqual(obj.calls, ['reset', 'peer', 'track'][:index + 1])
                self.assertEqual(len(log.records), 2)
                self.assertNotIn('secret-canary', json.dumps(log.records))

    def test_new_state_installed_during_each_await_survives_old_cleanup(self):
        for target in ('reset', 'peer', 'track'):
            with self.subTest(target=target):
                obj, log, close = self.configured(target, hold=True)
                coroutine = close(obj)
                self.assertEqual(coroutine.send(None), 'held')
                new_pc, new_track, new_sender = object(), object(), object()
                new_channel, new_move, new_candidates = object(), object(), ['new']
                new_binding, new_recovery, new_trace = {'new': True}, {'new': True}, object()
                coordinator = SimpleNamespace(cancel_pending=lambda: self.fail('new coordinator cancelled'))
                media_sender = SimpleNamespace(sender=new_sender,
                    invalidate=lambda: self.fail('new sender invalidated'))
                adapter = SimpleNamespace(track=new_track)
                obj._advance_authority()
                obj.pc, obj.screen_track, obj.video_sender = new_pc, new_track, new_sender
                obj._input_datachannel, obj._input_move_datachannel = new_channel, new_move
                obj.pending_candidates, obj._active_input_binding = new_candidates, new_binding
                obj._keyframe_recovery_state, obj._frame_trace_context = new_recovery, new_trace
                obj._media_apply_coordinator, obj.media_sender = coordinator, media_sender
                obj.capture_adapter = adapter
                complete(coroutine)
                for name, value in dict(pc=new_pc, screen_track=new_track, video_sender=new_sender,
                    _input_datachannel=new_channel, _input_move_datachannel=new_move,
                    pending_candidates=new_candidates, _active_input_binding=new_binding,
                    _keyframe_recovery_state=new_recovery, _frame_trace_context=new_trace,
                    _media_apply_coordinator=coordinator, media_sender=media_sender,
                    capture_adapter=adapter).items():
                    self.assertIs(getattr(obj, name), value, name)
                terminal, = log.terminal()
                self.assertFalse(terminal['authorityCurrent'])
                self.assertTrue(terminal['currentPeerPresent'])

    def test_current_authority_with_new_peer_still_preserves_new_recovery(self):
        obj, log, close = self.configured('peer', hold=True)
        obj.current_viewer_id, obj._offer_epoch = 'old-viewer', 23
        coroutine = close(obj, preserve_authority=True, reset_offer_state=True)
        self.assertEqual(coroutine.send(None), 'held')
        self.assertEqual(obj._authority, 0)
        self.assertIsNone(obj.current_viewer_id)
        self.assertEqual(obj._offer_epoch, 0)
        new_pc, new_recovery, new_trace = object(), {'new': True}, object()
        obj.pc = new_pc
        obj._keyframe_recovery_state, obj._frame_trace_context = new_recovery, new_trace
        complete(coroutine)
        self.assertIs(obj.pc, new_pc)
        self.assertIs(obj._keyframe_recovery_state, new_recovery)
        self.assertIs(obj._frame_trace_context, new_trace)
        terminal, = log.terminal()
        self.assertTrue(terminal['authorityCurrent'])
        self.assertTrue(terminal['currentPeerPresent'])

    def test_pre_await_operational_failure_still_emits_terminal_without_cleanup_retry(self):
        obj, log, close = self.configured()
        error = RuntimeError('suspend-secret-canary')
        def suspend(value):
            raise error
        obj.screen_track.set_suspended = suspend
        with self.assertRaises(RuntimeError) as caught:
            complete(close(obj))
        self.assertIs(caught.exception, error)
        self.assertEqual(obj.calls, [])
        terminal, = log.terminal()
        self.assertEqual(terminal['outcome'], 'failed')
        self.assertEqual(set(terminal['stages'].values()), {'not-started'})
        self.assertIsNone(terminal['authorityCurrent'])
        self.assertNotIn('secret-canary', json.dumps(log.records))

    def test_empty_and_reset_not_requested(self):
        obj, log = host(), Log()
        complete(close_method(log)(obj, reset_input=False))
        terminal, = log.terminal()
        self.assertEqual(terminal['stages'], dict(resetInput='not-requested',
            peerClose='absent', trackShutdown='absent'))
        self.assertEqual(obj.calls, [])
        for field in ('peerPresent', 'trackPresent', 'senderPresent', 'currentPeerPresent'):
            self.assertFalse(terminal[field])
        for field in ('peerConnectionClosed', 'captureThreadAlive',
                      'executorShutdownRequested', 'senderReleaseConfirmed'):
            self.assertIsNone(terminal[field])

    def test_falsey_presence_preserves_existing_operational_guards(self):
        class Falsey(SimpleNamespace):
            def __bool__(self):
                return False
        obj, log = host(), Log()
        obj.pc = Falsey(connectionState='closed', close=lambda: self.fail('new cleanup path'))
        obj.screen_track = Falsey(resource_snapshot=lambda: {'captureCloseState': 'closed'},
            shutdown=lambda: self.fail('new cleanup path'))
        obj.video_sender = Falsey()
        complete(close_method(log)(obj, reset_input=False))
        terminal, = log.terminal()
        self.assertTrue(terminal['peerPresent'])
        self.assertTrue(terminal['trackPresent'])
        self.assertTrue(terminal['senderPresent'])
        self.assertEqual(terminal['stages']['peerClose'], 'not-started')
        self.assertEqual(terminal['stages']['trackShutdown'], 'not-started')
        self.assertTrue(terminal['peerConnectionClosed'])
        self.assertEqual(terminal['captureCloseState'], 'closed')

    def test_returned_awaits_do_not_claim_closed_or_resource_release(self):
        obj, log, close = self.configured()
        complete(close(obj))
        terminal, = log.terminal()
        self.assertEqual(terminal['stages']['peerClose'], 'returned')
        self.assertEqual(terminal['stages']['trackShutdown'], 'returned')
        self.assertFalse(terminal['peerConnectionClosed'])
        self.assertTrue(terminal['captureThreadAlive'])
        self.assertEqual(terminal['captureCloseState'], 'worker-owned')
        self.assertEqual(terminal['captureShutdownJoin'], 'pending')
        self.assertTrue(terminal['executorShutdownRequested'])
        self.assertIsNone(terminal['senderReleaseConfirmed'])

    def test_missing_broken_and_non_scalar_getters_remain_unknown(self):
        class BrokenPeer:
            async def close(self):
                pass
            @property
            def connectionState(self):
                raise RuntimeError('peer-secret-canary')
        class BrokenTrack:
            async def shutdown(self):
                pass
            @property
            def resource_snapshot(self):
                raise RuntimeError('track-secret-canary')
        for pc, track in ((BrokenPeer(), BrokenTrack()), (SimpleNamespace(), SimpleNamespace())):
            with self.subTest(broken=type(pc).__name__):
                obj, log = host(), Log()
                # Missing operational methods are an original operational failure;
                # diagnostic getter failures must not mask it.
                obj.pc, obj.screen_track = pc, track
                if isinstance(pc, SimpleNamespace):
                    with self.assertRaises(AttributeError):
                        complete(close_method(log)(obj))
                else:
                    complete(close_method(log)(obj))
                terminal, = log.terminal()
                self.assertIsNone(terminal['peerConnectionClosed'])
                self.assertIsNone(terminal['captureThreadAlive'])
                self.assertEqual(terminal['captureCloseState'], 'unknown')
                self.assertNotIn('secret-canary', json.dumps(log.records))

    def test_logger_failures_do_not_change_return_error_or_cancel(self):
        for kind in ('returned', 'failed', 'cancelled'):
            with self.subTest(kind=kind):
                error = RuntimeError('business') if kind == 'failed' else (
                    asyncio.CancelledError('business') if kind == 'cancelled' else None)
                obj, log, close = self.configured('peer', error=error)
                log.fail = True
                if error is None:
                    self.assertIsNone(complete(close(obj)))
                    self.assertEqual(obj.calls, ['reset', 'peer', 'track'])
                else:
                    with self.assertRaises(type(error)) as caught:
                        complete(close(obj))
                    self.assertIs(caught.exception, error)
                    self.assertEqual(obj.calls, ['reset', 'peer'])
                self.assertEqual(log.attempts, 2)

    def test_diagnostic_base_exceptions_do_not_mask_business_errors(self):
        class DiagnosticAbort(BaseException):
            pass
        for exception_type in (DiagnosticAbort, asyncio.CancelledError):
            for source in ('logger', 'peer', 'track', 'clock'):
                with self.subTest(exception_type=exception_type.__name__, source=source):
                    diagnostic_error = exception_type('diagnostic-secret-canary')
                    business_error = RuntimeError('original-error')
                    obj, log, close = self.configured('reset', error=business_error)
                    if source == 'logger':
                        log.fail = diagnostic_error
                    elif source == 'peer':
                        class BrokenPeer:
                            @property
                            def connectionState(self):
                                raise diagnostic_error
                        obj.pc = BrokenPeer()
                    elif source == 'track':
                        def broken_snapshot():
                            raise diagnostic_error
                        obj.screen_track.resource_snapshot = broken_snapshot
                    else:
                        def broken_clock():
                            raise diagnostic_error
                        close = close_method(log, broken_clock)
                    with self.assertRaises(RuntimeError) as caught:
                        complete(close(obj))
                    self.assertIs(caught.exception, business_error)
                    self.assertEqual(obj.calls, ['reset'])
                    self.assertEqual(log.attempts, 2)
                    self.assertNotIn('secret-canary', json.dumps(log.records))

    def test_reset_result_is_allowlisted_independent_of_await_return(self):
        for value, expected in (({'status': 'applied'}, 'applied'),
            ({'status': 'rejected', 'secret': 'secret-canary'}, 'rejected'),
            ({'status': 'secret-canary'}, 'unknown'), (False, 'unknown'),
            (SimpleNamespace(status='applied'), 'unknown')):
            with self.subTest(expected=expected):
                obj, log = host(), Log()
                async def reset(*args, **kwargs):
                    return value
                obj._reset_keyboard_lifecycle = reset
                complete(close_method(log)(obj))
                terminal, = log.terminal()
                self.assertEqual(terminal['stages']['resetInput'], 'returned')
                self.assertEqual(terminal['resetResult'], expected)
                self.assertNotIn('secret-canary', json.dumps(log.records))

    def test_host_sequence_caps_before_first_await_and_clocks_fail_open(self):
        from peer_cleanup_observation import SEQUENCE_CAP
        obj, log = host(), Log()
        obj._peer_cleanup_sequence = SEQUENCE_CAP - 1
        for clock in (lambda: True, lambda: -1, lambda: 'secret-canary'):
            complete(close_method(log, clock)(obj))
        self.assertEqual(obj._peer_cleanup_sequence, SEQUENCE_CAP)
        for record in log.records:
            self.assertEqual(record['cleanupSequence'], SEQUENCE_CAP)
            self.assertTrue(record['sequenceClipped'])
            self.assertFalse(record['sequenceUnique'])
        for record in log.terminal():
            self.assertIsNone(record['elapsedMs'])
        def broken_clock():
            raise RuntimeError('clock-secret-canary')
        complete(close_method(log, broken_clock)(obj))
        self.assertIsNone(log.terminal()[-1]['elapsedMs'])

    def test_no_new_tasks_threads_retries_or_deadlines(self):
        tree = ast.parse(Path(__file__).with_name('host.py').read_text())
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'WebRemoteHost')
        method = next(n for n in cls.body if getattr(n, 'name', None) == '_close_peer_connection')
        self.assertFalse(any(isinstance(n, (ast.While, ast.For, ast.AsyncFor)) for n in ast.walk(method)))
        forbidden = {'create_task', 'ensure_future', 'Thread', 'ThreadPoolExecutor',
                     'to_thread', 'run_in_executor', 'wait_for', 'sleep'}
        calls = {getattr(n.func, 'attr', getattr(n.func, 'id', None)) for n in ast.walk(method)
                 if isinstance(n, ast.Call)}
        self.assertEqual(calls & forbidden, set())


if __name__ == '__main__':
    unittest.main()
