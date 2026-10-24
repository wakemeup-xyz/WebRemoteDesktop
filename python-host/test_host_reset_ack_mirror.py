"""Production Host methods with in-memory transports; no Host/native imports."""
import ast
import asyncio
import json
import math
from pathlib import Path
from types import SimpleNamespace
import time
import unittest

from input_admission_queue import InputAdmissionQueue, AdmissionResult, completed_future

HOST_TREE = ast.parse(Path(__file__).with_name('host.py').read_text())


class PrivateLog:
    def __init__(self):
        self.rows = []

    def info(self, message, *args):
        self.rows.append((message, args))

    warning = error = info


class CleanupRecord:
    def __init__(self, *args, **kwargs):
        pass

    def start_record(self):
        return {}

    def stage(self, *args):
        pass

    def terminal(self, *args):
        return {}


def host_methods(log):
    """Compile exact method bodies, never execute host.py imports or __init__."""
    tree = HOST_TREE
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'WebRemoteHost')
    names = {'_send_input_ack', '_mirror_socket_reset_ack', '_capture_authority',
             '_authority_matches', '_advance_authority', '_handle_datachannel_close',
             '_close_peer_connection', '_apply_viewer_session_rebind', '_execute_input',
             'on_input', '_get_input_admission'}
    methods = [n for n in cls.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
    selected = ast.ClassDef(name='Host', bases=[], keywords=[], body=methods, decorator_list=[])
    namespace = dict(json=json, asyncio=asyncio, time=time, logger=log,
                     InputAdmissionQueue=InputAdmissionQueue, AdmissionResult=AdmissionResult,
                     completed_future=completed_future, SEQUENCE_CAP=999999999,
                     PeerCleanupObservation=CleanupRecord, peer_cleanup_json=lambda _: '{}',
                     V2_INPUT_ACK_STATUSES={'applied', 'duplicate', 'stale-lease', 'sequence-gap',
                         'resync-required', 'invalid-input', 'unsupported-code', 'execution-failed'},
                     relay_ack_duration_ms=lambda a, b: b-a if type(b) in (int, float)
                         and math.isfinite(b) and b >= a else None)
    constants = [n for n in tree.body if isinstance(n, ast.Assign) and any(
        isinstance(t, ast.Name) and t.id in {'RESET_ACK_MIRROR_MAX_BUFFER_BYTES',
            'RESET_ACK_MIRROR_MAX_PACKET_BYTES'} for t in n.targets)]
    exec(compile(ast.fix_missing_locations(ast.Module(body=[*constants, selected], type_ignores=[])),
                 '<Host ACK mirror methods>', 'exec'), namespace)
    callback = next(n for n in ast.walk(cls) if isinstance(n, ast.FunctionDef) and n.name == 'on_datachannel')
    callback.decorator_list = []
    return namespace['Host'], callback, namespace


class Channel:
    id = 1
    label = 'input'
    readyState = 'open'
    bufferedAmount = 0

    def __init__(self, order):
        self.order, self.sent, self.handlers = order, [], {}
        self.fail = False

    def on(self, name):
        def register(callback):
            self.handlers[name] = callback
            return callback
        return register

    def send(self, message):
        if self.fail:
            raise RuntimeError('private-channel-error-canary')
        self.order.append('dc')
        self.sent.append(json.loads(message))


class Peer:
    connectionState = 'connected'
    iceConnectionState = 'connected'

    async def close(self):
        self.connectionState = 'closed'


def fixture(input_type='mouse'):
    log = PrivateLog()
    Host, callback, namespace = host_methods(log)
    host = Host()
    binding = dict(viewerId='viewer-private-canary', leaseId='lease-private-canary-0001',
                   leaseEpoch=7, connectionAttemptId='attempt-private-canary',
                   connectionAttemptSequence=3, connectionGeneration=2)
    host._active_input_binding = binding
    host._authority_revision = 1
    host._signal_ready = True
    host.current_viewer_id = binding['viewerId']
    host._input_datachannel = host._input_move_datachannel = None
    host.pc = Peer()
    host.pc._wrd_owner = tuple(binding[k] for k in ('viewerId', 'leaseId', 'leaseEpoch'))
    host.screen_track = host.video_sender = host.relay_streamer = None
    host.pending_candidates = []
    host.overlay = SimpleNamespace(send=lambda _: None)
    order, socket, observations, native = [], [], [], []
    channel = Channel(order)
    namespace.update(self=host, offer_pc=host.pc)
    exec(compile(ast.Module(body=[callback], type_ignores=[]), '<Host real datachannel callback>', 'exec'), namespace)
    namespace['on_datachannel'](channel)
    host.get_input_datachannel = lambda: host._input_datachannel
    host._emit_input_observation = lambda event, data, **meta: observations.append((event, meta))
    host._input_result_status = lambda result: result.get('status', 'applied')
    host._note_input_applied = lambda *args, **kwargs: None
    host._input_coordinate_is_valid = lambda value: True
    host._input_is_keepalive = lambda data: False

    async def emit(event, data):
        order.append('socket')
        socket.append((event, data))
    host.sio = SimpleNamespace(emit=emit)
    data = dict(schemaVersion=2, type=input_type, action='reset', transport='socket',
                viewerId=binding['viewerId'], leaseId=binding['leaseId'], leaseEpoch=7,
                seq=4, inputIds=['reset-private-canary'], payload={'reason': 'manual'})
    result = dict(inputIds=list(data['inputIds']), status='applied', appliedSeq=4,
                  pressedKeyCount=0, modifierMask=0, hostQueueMs=0.1, hostApplyMs=0.2)

    async def apply(envelope, **kwargs):
        native.append(envelope)
        return result
    host.input_handler = host.input_adapter = SimpleNamespace(handle_input=apply, apply_keyboard=apply)
    return SimpleNamespace(host=host, channel=channel, peer=host.pc, data=data, result=result,
                           socket=socket, observations=observations, order=order, native=native,
                           namespace=namespace, callback=callback, log=log)


class ResetAckMirrorTests(unittest.IsolatedAsyncioTestCase):
    async def test_single_successful_socket_reset_mirrors_before_original_ack(self):
        for kind in ('mouse', 'keyboard'):
            for status in ('applied', 'duplicate'):
                with self.subTest(kind=kind, status=status):
                    h = fixture(kind)
                    h.result['status'] = status
                    self.assertTrue(await h.host._send_input_ack(h.data, h.result, 1.2))
                    self.assertEqual(h.order, ['dc', 'socket'])
                    self.assertEqual(len(h.channel.sent), 1)
                    mirror = h.channel.sent[0]
                    self.assertEqual(mirror['resetAckMirrorVersion'], 1)
                    self.assertEqual(mirror['transport'], 'socket')
                    self.assertEqual(mirror['inputIds'], h.data['inputIds'])
                    self.assertEqual(mirror['inputType'], kind)
                    for private in ('viewerId', 'leaseId', 'payload', 'connectionAttemptId'):
                        self.assertNotIn(private, mirror)
                    original = h.socket[0][1]
                    self.assertNotIn('resetAckMirrorVersion', original)
                    self.assertEqual({k:v for k,v in mirror.items() if k!='resetAckMirrorVersion'},
                                     {k:v for k,v in original.items() if k!='viewerId'})

    async def test_real_admission_executes_native_once_for_both_ack_paths(self):
        for kind in ('mouse','keyboard'):
            with self.subTest(kind=kind):
                h = fixture(kind)
                outcome = await h.host.on_input(h.data)
                self.assertEqual(outcome.outcome, 'applied')
                self.assertEqual(len(h.native), 1)
                self.assertEqual(h.order, ['dc', 'socket'])

    async def test_old_native_completion_cannot_mirror_or_emit_socket_ack(self):
        h=fixture('keyboard');entered=asyncio.Event();release=asyncio.Event()
        async def delayed(envelope,**kwargs):
            h.native.append(envelope)
            entered.set()
            await release.wait()
            return h.result
        h.host.input_adapter.apply_keyboard=delayed
        result=h.host.on_input(h.data)
        await entered.wait()
        h.host._advance_authority()
        release.set()
        self.assertEqual((await result).outcome,'cancelled')
        self.assertEqual(len(h.native),1)
        self.assertEqual(h.order,[])
        self.assertEqual(h.channel.sent,[])
        self.assertEqual(h.socket,[])

    async def test_ineligible_envelopes_keep_original_socket_ack(self):
        changes = [dict(schemaVersion=1), dict(action='key'), dict(type='command'),
                   dict(transport='none'), dict(inputIds=['first', 'second'])]
        for change in changes:
            with self.subTest(change=change):
                h=fixture()
                h.data.update(change)
                if 'inputIds' in change: h.result['inputIds']=change['inputIds']
                self.assertTrue(await h.host._send_input_ack(h.data,h.result,1))
                self.assertEqual(h.channel.sent, [])
                self.assertEqual(len(h.socket), 1)
        for status in ('sequence-gap','execution-failed','stale-lease','invalid-input','unordered'):
            with self.subTest(status=status):
                h=fixture();h.result['status']=status
                self.assertTrue(await h.host._send_input_ack(h.data,h.result,1))
                self.assertEqual(h.channel.sent, [])
                self.assertEqual(len(h.socket),1)

    async def test_request_result_id_mismatch_cannot_mirror(self):
        h=fixture();h.result['inputIds']=['different-result-id']
        self.assertTrue(await h.host._send_input_ack(h.data,h.result,1))
        self.assertEqual(h.channel.sent, [])

    async def test_old_binding_unknown_owner_and_replaced_resources_only_use_socket(self):
        mutations = [lambda h:setattr(h.host,'_input_datachannel_owner',None),
            lambda h:setattr(h.host,'pc',Peer()),
            lambda h:setattr(h.host,'_input_datachannel',Channel(h.order)),
            lambda h:setattr(h.peer,'_wrd_owner',('foreign',h.data['leaseId'],7)),
            lambda h:setattr(h.peer,'connectionState','disconnected'),
            lambda h:h.host._active_input_binding.update(viewerId='foreign'),
            lambda h:h.host._active_input_binding.update(leaseEpoch=8),
            lambda h:h.host._active_input_binding.update(connectionAttemptId='new-attempt'),
            lambda h:h.host._active_input_binding.update(connectionAttemptSequence=4),
            lambda h:h.host._active_input_binding.update(connectionGeneration=3)]
        for index,change in enumerate(mutations):
            with self.subTest(case=index):
                h=fixture();change(h)
                self.assertTrue(await h.host._send_input_ack(h.data,h.result,1))
                self.assertEqual(h.channel.sent,[])
                self.assertEqual(len(h.socket),1)

    async def test_healthy_channel_needs_real_callback_owner_registration(self):
        h=fixture()
        replacement=Channel(h.order)
        h.host._input_datachannel=replacement
        self.assertTrue(await h.host._send_input_ack(h.data,h.result,1))
        self.assertEqual(replacement.sent,[])
        h.namespace['on_datachannel'](replacement)
        self.assertTrue(await h.host._send_input_ack(h.data,h.result,1))
        self.assertEqual(len(replacement.sent),1)

    async def test_old_authority_snapshot_cannot_send_mirror(self):
        h=fixture();authority=h.host._capture_authority();h.host._advance_authority()
        ack=dict(type='input_ack',schemaVersion=2,inputType='mouse',leaseEpoch=7,
                 status='applied',appliedSeq=4,inputIds=h.data['inputIds'],transport='socket')
        self.assertFalse(h.host._mirror_socket_reset_ack(h.data,ack,authority))
        self.assertEqual(h.channel.sent,[])

    async def test_mirror_packet_whitelists_fields_without_raw_lease_or_viewer(self):
        h=fixture()
        ack=dict(type='input_ack',schemaVersion=2,inputType='mouse',leaseEpoch=7,
            status='applied',appliedSeq=4,inputIds=h.data['inputIds'],transport='socket',
            viewerId='private-viewer-canary',leaseId='private-lease-canary',
            payload={'text':'private-content-canary'})
        self.assertTrue(h.host._mirror_socket_reset_ack(h.data,ack,h.host._capture_authority()))
        packet=json.dumps(h.channel.sent[0])
        for value in ('private-viewer-canary','private-lease-canary','private-content-canary'):
            self.assertNotIn(value,packet)

    async def test_resource_or_authority_changed_during_last_read_cannot_enqueue(self):
        for kind in ('peer','channel','authority'):
            with self.subTest(kind=kind):
                h=fixture()
                class ChangingChannel(Channel):
                    @property
                    def bufferedAmount(self):
                        if kind=='peer': h.host.pc=Peer()
                        elif kind=='channel': h.host._input_datachannel=Channel(h.order)
                        else: h.host._advance_authority()
                        return 0
                channel=ChangingChannel(h.order)
                h.namespace['on_datachannel'](channel)
                self.assertTrue(await h.host._send_input_ack(h.data,h.result,1))
                self.assertEqual(channel.sent,[])
                self.assertEqual(len(h.socket),1)

    async def test_original_datachannel_ack_path_has_no_mirror_marker_or_socket_copy(self):
        h=fixture();h.data['transport']='datachannel'
        self.assertTrue(await h.host._send_input_ack(h.data,h.result,1))
        self.assertEqual(h.order,['dc'])
        self.assertNotIn('resetAckMirrorVersion',h.channel.sent[0])
        self.assertEqual(h.socket,[])

    async def test_unavailable_congested_and_throwing_dc_never_skip_socket(self):
        changes=[lambda h:setattr(h.channel,'readyState','closing'),
                 lambda h:setattr(h.channel,'bufferedAmount',32768),
                 lambda h:setattr(h.channel,'bufferedAmount',float('nan')),
                 lambda h:setattr(h.channel,'bufferedAmount',None),
                 lambda h:setattr(h.channel,'fail',True)]
        for index,change in enumerate(changes):
            with self.subTest(case=index):
                h=fixture();change(h)
                self.assertTrue(await h.host._send_input_ack(h.data,h.result,1))
                self.assertEqual(h.channel.sent,[])
                self.assertEqual(len(h.socket),1)
                self.assertTrue(h.observations[-1][1]['ack_accepted'])
                self.assertNotIn('private-channel-error-canary',repr(h.log.rows))

    async def test_packet_and_total_buffer_budget_are_bounded(self):
        h=fixture()
        self.assertTrue(await h.host._send_input_ack(h.data,h.result,1))
        packet_bytes=len(json.dumps(h.channel.sent[0]).encode())
        h=fixture();h.channel.bufferedAmount=32768-packet_bytes
        self.assertTrue(await h.host._send_input_ack(h.data,h.result,1))
        self.assertEqual(len(h.channel.sent),1)
        h=fixture();h.channel.bufferedAmount=32769-packet_bytes
        self.assertTrue(await h.host._send_input_ack(h.data,h.result,1))
        self.assertEqual(h.channel.sent,[])
        h=fixture();h.result['pressedKeyCount']=10**4200;h.data['type']='keyboard'
        self.assertTrue(await h.host._send_input_ack(h.data,h.result,1))
        self.assertEqual(h.channel.sent,[])

    async def test_socket_failure_is_not_reported_as_socket_enqueue_success(self):
        h=fixture()
        async def fail(event,data):
            h.order.append('socket')
            raise RuntimeError('private-socket-error-canary')
        h.host.sio.emit=fail
        self.assertFalse(await h.host._send_input_ack(h.data,h.result,1))
        self.assertEqual(h.order,['dc','socket'])
        self.assertEqual(len(h.channel.sent),1)
        self.assertFalse(h.observations[-1][1]['ack_accepted'])
        self.assertNotIn('private-socket-error-canary',repr(h.log.rows))

    async def test_socket_await_cannot_mirror_later_to_a_successor_peer(self):
        h=fixture();new_channel=Channel(h.order)
        async def replace(event,data):
            h.order.append('socket')
            h.host.pc=Peer();h.host._input_datachannel=new_channel
            h.host._advance_authority()
            await asyncio.sleep(0)
            h.socket.append((event,data))
        h.host.sio.emit=replace
        self.assertTrue(await h.host._send_input_ack(h.data,h.result,1))
        self.assertEqual(h.order,['dc','socket'])
        self.assertEqual(len(h.channel.sent),1)
        self.assertEqual(new_channel.sent,[])

    async def test_same_attempt_authenticated_rebind_keeps_mirror_eligible(self):
        h=fixture();old=dict(h.host._active_input_binding)
        reply=h.host._apply_viewer_session_rebind(dict(previousViewerId=old['viewerId'],
            viewerId='rebound-viewer',**{k:old[k] for k in ('leaseId','leaseEpoch',
                'connectionAttemptId','connectionAttemptSequence')}))
        self.assertEqual(reply,{'status':'applied'})
        h.data['viewerId']='rebound-viewer'
        self.assertTrue(await h.host._send_input_ack(h.data,h.result,1))
        self.assertEqual(h.order,['dc','socket'])

    async def test_channel_close_clears_owner_and_old_close_keeps_successor(self):
        h=fixture()
        async def reset(*args,**kwargs):
            return {'status':'applied'}
        h.host._reset_keyboard_lifecycle=reset
        h.host._schedule_input_lifecycle=lambda coroutine:coroutine.close()
        h.host._handle_datachannel_close(h.channel)
        self.assertIsNone(h.host._input_datachannel_owner)
        replacement=Channel(h.order);h.namespace['on_datachannel'](replacement)
        owner=h.host._input_datachannel_owner
        h.host._handle_datachannel_close(h.channel)
        self.assertIs(h.host._input_datachannel_owner,owner)
        self.assertIs(h.host._input_datachannel,replacement)

    async def test_peer_cleanup_detaches_owner_before_close_and_preserves_successor(self):
        h=fixture();replacement=Channel(h.order);new_peer=Peer()
        async def close():
            self.assertIsNone(h.host._input_datachannel_owner)
            h.host.pc=new_peer
            h.namespace['offer_pc']=new_peer
            h.namespace['on_datachannel'](replacement)
            await asyncio.sleep(0)
        h.peer.close=close
        await h.host._close_peer_connection(preserve_authority=True,reset_input=False)
        self.assertIs(h.host.pc,new_peer)
        self.assertIs(h.host._input_datachannel,replacement)
        self.assertIs(h.host._input_datachannel_owner[0],new_peer)


if __name__=='__main__':
    unittest.main()
