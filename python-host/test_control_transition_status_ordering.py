"""Pure Host ordering tests: actual AST methods, deterministic fake await gates."""
import ast
import asyncio
import inspect
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

from peer_cleanup_observation import PeerCleanupObservation, SEQUENCE_CAP, peer_cleanup_json


RESOURCES = ('relay_streamer', 'pc', 'screen_track', 'video_sender',
             '_input_datachannel', '_input_move_datachannel', 'media_sender', 'capture_adapter')


class BoundedList(list):
    def append(self, value):
        if len(self) >= 32:
            raise AssertionError('unexpected fake output growth')
        super().append(value)


class Log:
    def __init__(self):
        self.records = []

    def info(self, message, *args):
        if len(self.records) >= 128:
            raise AssertionError('unexpected diagnostic growth')
        self.records.append(message % args if args else message)

    warning = error = info

    def terminals(self):
        return [json.loads(line.split(' ', 1)[1]) for line in self.records
                if line.startswith('WRD_PEER_CLEANUP ') and '"terminal"' in line]


class Gate:
    def __init__(self):
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def wait(self):
        self.entered.set()
        await self.release.wait()


async def turn():
    """Yield one event-loop turn without a timer or wall-clock sleep."""
    loop = asyncio.get_running_loop()
    ready = loop.create_future()
    loop.call_soon(ready.set_result, None)
    await ready


def host_code():
    tree = ast.parse(Path(__file__).with_name('host.py').read_text())
    source = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                  and node.name == 'WebRemoteHost')
    names = {'_advance_authority', '_capture_authority', '_authority_matches',
             '_authority_input_queue', '_reset_keyboard_lifecycle', '_bind_input_authority',
             '_transition_desktop_writes', '_emit_control_transition_ack',
             'on_control_transition', '_apply_control_transition', 'on_viewer_status',
             '_close_peer_connection', 'on_disconnect'}
    methods = [node for node in source.body if getattr(node, 'name', None) in names]
    assert len(methods) == len(names)
    return names, compile(ast.Module(body=methods, type_ignores=[]), '<AST Host ordering>', 'exec')


METHOD_NAMES, HOST_CODE = host_code()


def host_methods(log):
    namespace = dict(asyncio=asyncio, inspect=inspect, json=json, logger=log,
                     time=SimpleNamespace(monotonic_ns=lambda: 1_000_000),
                     PeerCleanupObservation=PeerCleanupObservation,
                     SEQUENCE_CAP=SEQUENCE_CAP, peer_cleanup_json=peer_cleanup_json)
    exec(HOST_CODE, namespace)
    return type('PureHost', (), {name: namespace[name] for name in METHOD_NAMES})


class Queue:
    def __init__(self):
        self.frozen = []
        self.resets = 0
        self.resumes = 0

    def freeze(self, authority, reason):
        self.frozen.append((authority, reason))

    async def reset_after_quiescent(self, authority, apply):
        self.resets += 1
        return await apply()

    def resume(self):
        self.resumes += 1
        return True


class Fixture:
    def __init__(self):
        self.log = Log()
        self.host = host_methods(self.log)()
        self.calls, self.acks, self.overlays = [], BoundedList(), BoundedList()
        self.reset_gate = self.bind_gate = self.relay_gate = self.pc_gate = self.track_gate = None
        self.reset_results = []
        self.reset_error = self.relay_error = self.pc_error = None
        host = self.host
        host._authority_revision = 0
        host._signal_generation, host._signal_ready = 1, True
        host._connection_generation = 1
        host._active_input_binding = dict(viewerId='old-viewer', leaseId='old-lease-00000001',
            leaseEpoch=7, connectionAttemptId='old-attempt', connectionAttemptSequence=1,
            connectionGeneration=1)
        host.current_viewer_id, host._offer_epoch = 'old-viewer', 4
        host._control_operation = (7, 'grant', 'applied')
        host._input_admission = Queue()
        host.pending_candidates = []
        host._keyframe_recovery_state, host._frame_trace_context = {}, None
        for name in RESOURCES:
            setattr(host, name, None)
        host.sio = SimpleNamespace(emit=self.emit)
        host.overlay = SimpleNamespace(send=self.overlays.append)
        host.input_handler = SimpleNamespace(reset_keyboard=self.reset,
            reset_desktop_writes=self.desktop_reset, transition_keyboard=self.bind,
            transition_desktop_writes_async=self.desktop_bind)

    async def emit(self, event, payload):
        assert event == 'control-transition-ack'
        self.acks.append(dict(payload))
        self.calls.append('ack:' + payload['status'])

    async def reset(self, **kwargs):
        self.calls.append('reset')
        if self.reset_gate:
            await self.reset_gate.wait()
        if self.reset_error:
            error, self.reset_error = self.reset_error, None
            raise error
        return self.reset_results.pop(0) if self.reset_results else {'status': 'applied'}

    async def desktop_reset(self, **kwargs):
        self.calls.append('desktop-reset')
        return {'status': 'applied'}

    async def bind(self, **kwargs):
        self.calls.append('bind')
        if self.bind_gate:
            await self.bind_gate.wait()
        return {'status': 'applied'}

    async def desktop_bind(self, **kwargs):
        return SimpleNamespace(status='applied')

    def resources(self, *, relay=False):
        fixture = self
        class PC:
            connectionState = 'connected'

            async def close(self):
                fixture.calls.append('peer')
                if fixture.pc_gate:
                    await fixture.pc_gate.wait()
                if fixture.pc_error:
                    raise fixture.pc_error
                self.connectionState = 'closed'

        class Track:
            closed = False

            def set_suspended(self, value):
                fixture.calls.append('suspend')

            async def shutdown(self):
                fixture.calls.append('track')
                if fixture.track_gate:
                    await fixture.track_gate.wait()
                self.closed = True

            def resource_snapshot(self):
                return dict(captureThreadAlive=not self.closed,
                    captureCloseState='closed' if self.closed else 'unknown',
                    captureShutdownJoin='returned' if self.closed else 'unknown')

        self.pc, self.track, self.sender = PC(), Track(), object()
        host = self.host
        host.pc, host.screen_track, host.video_sender = self.pc, self.track, self.sender
        host._input_datachannel, host._input_move_datachannel = object(), object()
        host.media_sender = SimpleNamespace(sender=self.sender,
            invalidate=lambda: self.calls.append('invalidate'))
        host.capture_adapter = SimpleNamespace(track=self.track)
        if relay:
            async def stop():
                self.calls.append('relay')
                if self.relay_gate:
                    await self.relay_gate.wait()
                if self.relay_error:
                    raise self.relay_error
            host.relay_streamer = SimpleNamespace(stop=stop)


class StatusOrderingTest(unittest.IsolatedAsyncioTestCase):
    async def reached(self, gate):
        await turn()
        self.assertTrue(gate.entered.is_set(), 'expected fake stage was not reached')

    async def test_detached_peer_reset_gets_first_applied_ack_after_both_resources_return(self):
        fixture = Fixture()
        fixture.resources()
        fixture.pc_gate, fixture.track_gate = Gate(), Gate()
        host = fixture.host
        reset = asyncio.create_task(host.on_control_transition({'leaseEpoch': 8}))
        await self.reached(fixture.pc_gate)
        authority = host._capture_authority()
        self.assertIsNone(host.pc)
        status = asyncio.create_task(host.on_viewer_status({'onlineCount': 0}))
        await turn()
        self.assertEqual(fixture.acks, [])
        fixture.pc_gate.release.set()
        await self.reached(fixture.track_gate)
        self.assertEqual(fixture.acks, [])
        fixture.track_gate.release.set()
        await reset
        await status
        self.assertEqual(fixture.acks, [{'leaseEpoch': 8, 'status': 'applied'}])
        self.assertEqual(host._control_operation, (8, 'reset', 'applied'))
        self.assertEqual(host._capture_authority(), authority)
        self.assertEqual(fixture.calls.count('reset'), 1)
        self.assertEqual(fixture.calls.count('peer'), 1)
        self.assertEqual(fixture.calls.count('track'), 1)
        self.assertGreater(fixture.calls.index('ack:applied'), fixture.calls.index('track'))
        self.assertEqual(len(fixture.overlays), 1)
        self.assertTrue(all(getattr(host, name) is None for name in RESOURCES))


    async def test_earlier_relay_and_native_reset_waits_get_one_first_ack(self):
        for stage in ('relay', 'reset'):
            with self.subTest(stage=stage):
                fixture = Fixture()
                fixture.resources(relay=True)
                gate = Gate()
                setattr(fixture, ('pc' if stage == 'peer' else stage) + '_gate', gate)
                host = fixture.host
                reset = asyncio.create_task(host.on_control_transition({'leaseEpoch': 8}))
                await self.reached(gate)
                authority = host._capture_authority()
                status = asyncio.create_task(host.on_viewer_status({'onlineCount': 0}))
                await turn()
                self.assertEqual(fixture.acks, [])
                self.assertEqual(fixture.calls.count('reset'), int(stage == 'reset'))
                gate.release.set()
                await reset
                await status
                self.assertEqual(fixture.acks, [{'leaseEpoch': 8, 'status': 'applied'}])
                self.assertEqual(host._capture_authority(), authority)
                for name in ('relay', 'reset', 'peer', 'track'):
                    self.assertEqual(fixture.calls.count(name), 1, name)
                self.assertEqual(len(fixture.overlays), 1)

    async def test_each_full_authority_field_and_signal_generation_fence_queued_status(self):
        fields = ('viewerId', 'leaseId', 'leaseEpoch', 'connectionAttemptId',
                  'connectionAttemptSequence', 'connectionGeneration', 'revision', 'signal')
        for field in fields:
            with self.subTest(field=field):
                fixture = Fixture()
                fixture.resources(relay=True)
                host = fixture.host
                host._control_transition_lock = lock = asyncio.Lock()
                await lock.acquire()
                status = asyncio.create_task(host.on_viewer_status({'onlineCount': 0}))
                await turn()
                if field == 'signal':
                    host._signal_generation += 1
                elif field == 'revision':
                    host._advance_authority()
                else:
                    old = host._active_input_binding[field]
                    host._active_input_binding[field] = old + 1 if type(old) is int else old + '-new'
                successor = {name: getattr(host, name) for name in RESOURCES}
                lock.release()
                await status
                self.assertEqual(fixture.calls, [])
                for name, value in successor.items():
                    self.assertIs(getattr(host, name), value, name)
                self.assertFalse(lock.locked())
                self.assertEqual(fixture.overlays, [])

    async def test_signal_disconnect_and_replacement_cleanup_still_suppress_old_ack(self):
        for kind in ('disconnect', 'replacement', 'direct-cleanup'):
            with self.subTest(kind=kind):
                fixture = Fixture()
                fixture.resources()
                fixture.pc_gate = Gate()
                host = fixture.host
                reset = asyncio.create_task(host.on_control_transition({'leaseEpoch': 8}))
                await self.reached(fixture.pc_gate)
                status = asyncio.create_task(host.on_viewer_status({'onlineCount': 0}))
                await turn()
                if kind == 'disconnect':
                    await host.on_disconnect()
                elif kind == 'replacement':
                    host._advance_authority()
                else:
                    await host._close_peer_connection(reason='manual')
                new_pc, new_track, new_relay = object(), object(), object()
                host.pc, host.screen_track, host.relay_streamer = new_pc, new_track, new_relay
                host.current_viewer_id = 'new-viewer'
                host._active_input_binding = dict(viewerId='new-viewer', leaseEpoch=9,
                    connectionAttemptId='new-attempt', connectionAttemptSequence=2)
                fixture.pc_gate.release.set()
                await reset
                await status
                self.assertEqual(fixture.acks, [])
                self.assertIs(host.pc, new_pc)
                self.assertIs(host.screen_track, new_track)
                self.assertIs(host.relay_streamer, new_relay)
                self.assertEqual(fixture.calls.count('peer'), 1)
                self.assertEqual(fixture.calls.count('track'), 1)
                self.assertEqual(fixture.pc.connectionState, 'closed')
                self.assertFalse(fixture.log.terminals()[-1]['authorityCurrent'])

    async def queued_completion(self, fixture, *, operation=(8, 'reset', 'pending'),
                                current=(8, 'reset', 'applied'), before=None):
        host = fixture.host
        host._active_input_binding = None
        host.current_viewer_id = None
        host._control_operation = operation
        if before:
            before(host)
        host._control_transition_lock = lock = asyncio.Lock()
        await lock.acquire()
        status = asyncio.create_task(host.on_viewer_status({'onlineCount': 0}))
        await turn()
        host._control_operation = current
        lock.release()
        await status
        self.assertFalse(lock.locked())

    async def test_each_present_resource_including_falsey_prevents_coalescing(self):
        class Falsey(SimpleNamespace):
            def __bool__(self):
                return False

        for name in RESOURCES:
            for resource_type in (SimpleNamespace, Falsey):
                with self.subTest(resource=name, falsey=resource_type is Falsey):
                    fixture = Fixture()
                    operations = []
                    async def no_op():
                        operations.append('returned')
                    resource = resource_type(stop=no_op, close=no_op, shutdown=no_op)
                    await self.queued_completion(fixture,
                        before=lambda host: setattr(host, name, resource))
                    self.assertEqual(fixture.calls.count('reset'), 1)
                    self.assertEqual(fixture.host._authority_revision, 1)
                    self.assertEqual(fixture.acks, [])
                    self.assertEqual(len(fixture.overlays), 1)
                    if name == 'relay_streamer':
                        self.assertEqual(len(operations), int(resource_type is SimpleNamespace))

    async def test_exact_valid_pending_to_same_applied_tuple_is_required(self):
        invalid_entries = (None, (), (8, 'reset'), (8, 'reset', 'pending', 'extra'),
            [8, 'reset', 'pending'], (True, 'reset', 'pending'), (0, 'reset', 'pending'),
            (-1, 'reset', 'pending'), ('8', 'reset', 'pending'), (8, 'grant', 'pending'),
            (8, 'reset', 'rejected'), (8, 'reset', 'applied'))
        invalid_results = ((9, 'reset', 'applied'), (8, 'grant', 'applied'),
                           (8, 'reset', 'pending'), (8, 'reset', 'rejected'), None)
        for entry, current in ([(entry, (8, 'reset', 'applied')) for entry in invalid_entries]
                               + [((8, 'reset', 'pending'), current) for current in invalid_results]):
            with self.subTest(entry=entry, current=current):
                fixture = Fixture()
                await self.queued_completion(fixture, operation=entry, current=current)
                self.assertEqual(fixture.calls.count('reset'), 1)
                self.assertEqual(fixture.acks, [])

    async def test_falsey_binding_or_current_viewer_prevents_coalescing(self):
        for field, value in (('_active_input_binding', {}), ('current_viewer_id', ''),
                             ('current_viewer_id', 'other-viewer')):
            with self.subTest(field=field, value=value):
                fixture = Fixture()
                await self.queued_completion(fixture,
                    before=lambda host: setattr(host, field, value))
                self.assertEqual(fixture.calls.count('reset'), 1)
                self.assertEqual(fixture.acks, [])

    async def test_missing_legacy_resource_fields_can_coalesce_and_update_overlay(self):
        fixture = Fixture()
        for name in RESOURCES:
            delattr(fixture.host, name)
        await self.queued_completion(fixture)
        self.assertEqual(fixture.calls, [])
        self.assertEqual(fixture.host._authority_revision, 0)
        self.assertEqual(fixture.overlays, [{'type': 'viewer-status', 'onlineCount': 0, 'viewers': []}])

    async def test_rejected_native_or_peer_error_runs_fallback_without_false_applied(self):
        for kind in ('rejected', 'native-error', 'peer-error'):
            with self.subTest(kind=kind):
                fixture = Fixture()
                fixture.resources()
                gate = Gate()
                if kind == 'peer-error':
                    fixture.pc_gate = gate
                    fixture.pc_error = RuntimeError('peer failure')
                else:
                    fixture.reset_gate = gate
                    if kind == 'rejected':
                        fixture.reset_results = [{'status': 'rejected'}]
                    else:
                        fixture.reset_error = RuntimeError('native failure')
                host = fixture.host
                reset = asyncio.create_task(host.on_control_transition({'leaseEpoch': 8}))
                await self.reached(gate)
                status = asyncio.create_task(host.on_viewer_status({'onlineCount': 0}))
                await turn()
                gate.release.set()
                await reset
                await status
                self.assertEqual(fixture.acks, [{'leaseEpoch': 8, 'status': 'rejected',
                                                'reason': 'reset-failed'}])
                self.assertEqual(host._control_operation, (8, 'reset', 'rejected'))
                self.assertEqual(fixture.calls.count('reset'), 2)
                self.assertEqual(host._authority_revision, 2)
                self.assertFalse(host._control_transition_lock.locked())
                self.assertEqual(len(fixture.overlays), 1)
                if kind == 'peer-error':
                    self.assertEqual(fixture.pc.connectionState, 'connected')
                    self.assertFalse(fixture.track.closed)
                    terminal = fixture.log.terminals()[0]
                    self.assertEqual(terminal['outcome'], 'failed')
                    self.assertFalse(terminal['peerConnectionClosed'])

    async def test_cancelled_reset_runs_fallback_but_detached_release_remains_unknown(self):
        for stage in ('relay', 'reset', 'peer', 'track'):
            with self.subTest(stage=stage):
                fixture = Fixture()
                fixture.resources(relay=True)
                gate = Gate()
                setattr(fixture, ('pc' if stage == 'peer' else stage) + '_gate', gate)
                host = fixture.host
                reset = asyncio.create_task(host.on_control_transition({'leaseEpoch': 8}))
                await self.reached(gate)
                status = asyncio.create_task(host.on_viewer_status({'onlineCount': 0}))
                await turn()
                reset.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await reset
                # Subsequent fallback native/PC work may proceed; cancelled detached
                # resources are never presented as having returned their release.
                gate.release.set()
                await status
                self.assertEqual(fixture.acks, [])
                self.assertEqual(host._control_operation, (8, 'reset', 'pending'))
                self.assertEqual(host._authority_revision, 2)
                self.assertFalse(host._control_transition_lock.locked())
                self.assertEqual(len(fixture.overlays), 1)
                if stage in ('peer', 'track'):
                    terminal = fixture.log.terminals()[0]
                    self.assertEqual(terminal['outcome'], 'cancelled')
                    self.assertEqual(terminal['stages']['peerClose' if stage == 'peer' else 'trackShutdown'],
                                     'cancelled')
                    self.assertFalse(fixture.track.closed)
                    self.assertIsNone(terminal['senderReleaseConfirmed'])
                    self.assertEqual(fixture.calls.count('peer'), 1)
                    if stage == 'peer':
                        self.assertFalse(terminal['peerConnectionClosed'])
                        self.assertEqual(terminal['stages']['trackShutdown'], 'not-started')

    async def test_ordinary_zero_and_positive_preserve_overlay_and_operational_stop(self):
        fixture = Fixture()
        fixture.resources(relay=True)
        viewers = [{'id': 'viewer'}]
        before = fixture.host._capture_authority()
        await fixture.host.on_viewer_status({'onlineCount': 2, 'viewers': viewers})
        self.assertEqual(fixture.calls, [])
        self.assertEqual(fixture.host._capture_authority(), before)
        self.assertFalse(hasattr(fixture.host, '_control_transition_lock'))
        self.assertEqual(fixture.overlays, [{'type': 'viewer-status', 'onlineCount': 2, 'viewers': viewers}])
        await fixture.host.on_viewer_status({'onlineCount': 0, 'viewers': []})
        self.assertEqual(fixture.calls.count('relay'), 1)
        self.assertEqual(fixture.calls.count('reset'), 1)
        self.assertEqual(fixture.calls.count('peer'), 1)
        self.assertEqual(fixture.calls.count('track'), 1)
        self.assertEqual(fixture.host._authority_revision, 1)
        self.assertEqual(fixture.overlays[-1], {'type': 'viewer-status', 'onlineCount': 0, 'viewers': []})
        self.assertEqual(fixture.acks, [])

    async def test_applied_before_status_entry_still_runs_ordinary_cleanup(self):
        fixture = Fixture()
        host = fixture.host
        host._active_input_binding = None
        host.current_viewer_id = None
        host._control_operation = (8, 'reset', 'applied')
        await host.on_viewer_status({'onlineCount': 0})
        self.assertEqual(fixture.calls.count('reset'), 1)
        self.assertEqual(host._authority_revision, 1)

    async def test_grant_inflight_publishes_binding_and_stales_waiting_status(self):
        fixture = Fixture()
        fixture.resources()
        fixture.bind_gate = Gate()
        host = fixture.host
        grant = asyncio.create_task(host.on_control_transition(dict(leaseEpoch=8,
            viewerId='new-viewer', leaseId='new-lease-00000008')))
        await self.reached(fixture.bind_gate)
        status = asyncio.create_task(host.on_viewer_status({'onlineCount': 0}))
        await turn()
        fixture.bind_gate.release.set()
        await grant
        await status
        self.assertEqual(fixture.acks, [{'leaseEpoch': 8, 'status': 'applied'}])
        self.assertEqual(host._control_operation, (8, 'grant', 'applied'))
        self.assertEqual(host._active_input_binding['viewerId'], 'new-viewer')
        self.assertEqual(host.current_viewer_id, 'new-viewer')
        self.assertEqual(fixture.calls.count('reset'), 1)
        self.assertEqual(fixture.calls.count('peer'), 1)
        self.assertEqual(fixture.overlays, [])

    async def test_replacement_during_fallback_relay_stop_preserves_successor(self):
        for changed in ('signal', 'revision', 'binding-attempt'):
            with self.subTest(changed=changed):
                fixture = Fixture()
                fixture.resources(relay=True)
                fixture.relay_gate = Gate()
                host = fixture.host
                old_relay = host.relay_streamer
                status = asyncio.create_task(host.on_viewer_status({'onlineCount': 0}))
                await self.reached(fixture.relay_gate)
                if changed == 'signal':
                    host._signal_generation += 1
                elif changed == 'revision':
                    host._advance_authority()
                else:
                    host._active_input_binding['connectionAttemptId'] = 'replacement'
                replacements = {name: object() for name in RESOURCES}
                for name, resource in replacements.items():
                    setattr(host, name, resource)
                fixture.relay_gate.release.set()
                await status
                for name, resource in replacements.items():
                    self.assertIs(getattr(host, name), resource, name)
                self.assertIsNot(host.relay_streamer, old_relay)
                self.assertEqual(fixture.calls, ['relay'])
                self.assertEqual(fixture.acks, [])
                self.assertFalse(host._control_transition_lock.locked())

    async def test_fallback_errors_and_cancellation_keep_logging_and_release_lock(self):
        for kind in ('relay-error', 'reset-error', 'cancel-relay', 'cancel-reset', 'cancel-wait'):
            with self.subTest(kind=kind):
                fixture = Fixture()
                fixture.resources(relay=True)
                host = fixture.host
                if kind == 'relay-error':
                    fixture.relay_error = RuntimeError('relay failure')
                elif kind == 'reset-error':
                    fixture.reset_error = RuntimeError('reset failure')
                elif kind == 'cancel-relay':
                    fixture.relay_gate = Gate()
                elif kind == 'cancel-reset':
                    fixture.reset_gate = Gate()
                else:
                    host._control_transition_lock = asyncio.Lock()
                    await host._control_transition_lock.acquire()
                status = asyncio.create_task(host.on_viewer_status({'onlineCount': 0}))
                if kind.startswith('cancel'):
                    if kind == 'cancel-wait':
                        await turn()
                    else:
                        await self.reached((fixture.relay_gate or fixture.reset_gate))
                    status.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await status
                    if kind == 'cancel-wait':
                        self.assertTrue(host._control_transition_lock.locked())
                        host._control_transition_lock.release()
                    self.assertFalse(any('Error handling viewer status:' in line for line in fixture.log.records))
                else:
                    await status
                    self.assertEqual(sum('Error handling viewer status:' in line for line in fixture.log.records), 1)
                self.assertFalse(host._control_transition_lock.locked())
                self.assertEqual(fixture.acks, [])
                self.assertEqual(fixture.overlays, [])


if __name__ == '__main__':
    unittest.main()
