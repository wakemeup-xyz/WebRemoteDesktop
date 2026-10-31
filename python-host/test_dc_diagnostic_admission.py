"""Pure-memory actual Host methods: no Host import or native/network effects."""
import ast
import asyncio
from collections import deque
import json
import logging
from pathlib import Path
import threading
import time
from types import SimpleNamespace
import pytest
from aiortc.rtcdatachannel import RTCDataChannel, RTCDataChannelParameters
from aiortc.rtcsctptransport import RTCSctpTransport


def track_for(dc):
    tree = ast.parse(Path(__file__).with_name('host.py').read_text())
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'ScreenCaptureTrack')
    names = {'_send_frame_timing', '_send_frame_trace_batch', '_send_disposable_diagnostic',
             '_should_send_frame_timing'}
    methods = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name in names]
    ns = dict(json=json, time=time, logger=logging.getLogger(__name__))
    try:
        from dc_diagnostic_admission import DiagnosticAdmission
        ns['DiagnosticAdmission'] = DiagnosticAdmission
    except ImportError:
        pass
    exec(compile(ast.Module(body=methods, type_ignores=[]), 'host-methods', 'exec'), ns)
    track = type('Track', (), {n.name: ns[n.name] for n in methods})()
    track._host_ref = SimpleNamespace(get_input_datachannel=lambda: dc)
    track._pending_input_lock = threading.Lock()
    track._pending_input_ids = set()
    track._pending_input_data = []
    track._timing_seq = 0
    track._frame_timing_sample_seq = 0
    track._last_frame_timing_send_ns = 0
    return track


def timing(track):
    track._send_frame_timing(capture_prepare_ms=1, frame_convert_ms=2)


def test_frame_timing_sampling_preserves_input_rows_and_bounds_idle_rows():
    track = track_for(Channel())
    assert [track._should_send_frame_timing() for _ in range(10)] == [True, False, False, False, False,
                                                                      True, False, False, False, False]
    track._pending_input_ids.add('input-hash')
    assert track._should_send_frame_timing() is True
    track._pending_input_ids.clear()
    assert track._should_send_frame_timing() is False


def test_input_associated_frame_timing_is_rate_limited_during_diagnostic_bursts():
    track = track_for(Channel())
    track._pending_input_ids.add('input-hash')
    track._last_frame_timing_send_ns = time.monotonic_ns()
    assert track._should_send_frame_timing() is False
    track._last_frame_timing_send_ns = 0
    assert track._should_send_frame_timing() is True


@pytest.mark.asyncio
async def test_real_aiortc_busy_outbound_does_not_grow_diagnostics_linearly():
    transport = object.__new__(RTCSctpTransport)
    transport._association_state = RTCSctpTransport.State.ESTABLISHED
    transport._outbound_queue = deque([object()])
    transport._data_channel_queue = deque()
    dc = RTCDataChannel(transport, RTCDataChannelParameters(label='input'), send_open=False)
    dc._setReadyState('open')
    track = track_for(dc)
    for _ in range(200):
        timing(track)
    await asyncio.sleep(0)  # Only aiortc's admitted-send flush tasks.
    assert dc.bufferedAmount <= 4096
    size = len(transport._data_channel_queue)
    for _ in range(200):
        timing(track)
    await asyncio.sleep(0)
    assert len(transport._data_channel_queue) == size

from dc_diagnostic_admission import DiagnosticAdmission, COUNTER_MAX
from media_stage_metrics import FrameTraceRegistry, FrameKey


class Channel:
    readyState = 'open'
    bufferedAmount = 0

    def __init__(self):
        self.sent = []

    def send(self, value):
        self.sent.append(json.loads(value))
        self.bufferedAmount += len(value.encode('utf-8'))


def test_utf8_exact_boundary_and_one_byte_over_and_oversized():
    payload = {'type': 'frame_timing', 'text': '汉🙂'}
    size = len(json.dumps(payload, ensure_ascii=False).encode('utf-8'))
    assert size > len(json.dumps(payload, ensure_ascii=False))
    for excess, expected in [(0, True), (1, False)]:
        dc = Channel()
        dc.bufferedAmount = 4096 - size + excess
        gate = DiagnosticAdmission()
        assert gate.send(SimpleNamespace(get_input_datachannel=lambda: dc), dc, payload) is expected
        assert len(dc.sent) == int(expected)
    dc = Channel()
    gate = DiagnosticAdmission()
    assert not gate.send(SimpleNamespace(get_input_datachannel=lambda: dc), dc,
                         {'type': 'frame_timing', 'text': '汉' * 2000})
    assert gate.reasons['oversized'] == 1
    assert not dc.sent


@pytest.mark.parametrize('value', [None, True, False, -1, 0.0, float('nan'), float('inf'), '0'])
def test_invalid_buffer_fails_closed(value):
    dc = Channel()
    dc.bufferedAmount = value
    track = track_for(dc)
    timing(track)
    assert not dc.sent
    assert track._diagnostic_admission.reasons['invalid_buffer'] == 1


@pytest.mark.parametrize('mode', ['host_none', 'dc_none', 'replaced', 'closed', 'missing_buffer',
                                  'property_error', 'getter_error', 'not_callable', 'send_error',
                                  'congested', 'oversized', 'serialization'])
def test_all_drop_paths_consume_legacy_without_later_replay(mode):
    dc = Channel()
    track = track_for(dc)
    track._pending_input_ids = {'legacy'}
    track._pending_input_data = [{'value': 'x'}]
    if mode == 'host_none':
        track._host_ref = None
    elif mode == 'dc_none':
        track._host_ref.get_input_datachannel = lambda: None
    elif mode == 'replaced':
        calls = iter([dc, Channel()])
        track._host_ref.get_input_datachannel = lambda: next(calls)
    elif mode == 'closed':
        dc.readyState = 'closing'
    elif mode == 'missing_buffer':
        dc = SimpleNamespace(readyState='open', send=lambda value: pytest.fail('send'))
        track._host_ref.get_input_datachannel = lambda: dc
    elif mode == 'property_error':
        class Broken(Channel):
            @property
            def bufferedAmount(self):
                raise RuntimeError('property')
        dc = Broken()
        track._host_ref.get_input_datachannel = lambda: dc
    elif mode == 'getter_error':
        def broken():
            raise RuntimeError('getter')
        track._host_ref.get_input_datachannel = broken
    elif mode == 'not_callable':
        dc.send = None
    elif mode == 'send_error':
        def broken(value):
            raise RuntimeError('send')
        dc.send = broken
    elif mode == 'congested':
        dc.bufferedAmount = 4096
    elif mode == 'oversized':
        track._pending_input_data = [{'value': 'x' * 5000}]
    elif mode == 'serialization':
        track._pending_input_data = [object()]
    timing(track)
    assert track._pending_input_ids == set()
    assert track._pending_input_data == []
    assert track._timing_seq == 1
    assert track._diagnostic_admission.legacy == {'ids': 1, 'metadata': 1}
    fresh = Channel()
    track._host_ref = SimpleNamespace(get_input_datachannel=lambda: fresh)
    timing(track)
    assert fresh.sent[0]['frameId'] == 1
    assert 'inputs' not in fresh.sent[0] and 'inputIds' not in fresh.sent[0]
    assert fresh.sent[0]['timings']['endToEndVideoMs'] is None


def trace_track(dc):
    track = track_for(dc)
    registry = FrameTraceRegistry(lab_loss_trace=True)
    registry.begin_loss_lab_trace(1)
    track._frame_trace_context = SimpleNamespace(registry=registry)
    track._last_trace_send_ns = 0
    return track, registry


def flush(track):
    track._last_trace_send_ns = 0
    track._send_frame_trace_batch()


def test_loss_prior_drop_returned_and_count_only_batch_reported_exactly_once():
    dc = Channel()
    track, registry = trace_track(dc)
    registry.note_dropped_loss_lab_events(4)
    registry.record_lab_pc_state(identifier='pc', state='connected', width=2, height=2)
    dc.bufferedAmount = 4096
    flush(track)
    assert not dc.sent
    dc.bufferedAmount = 0
    flush(track)
    assert dc.sent[0]['events'] == []
    assert dc.sent[0]['droppedEventCount'] == 5
    flush(track)
    assert len(dc.sent) == 1


@pytest.mark.parametrize('fail_type', ['frame_trace_batch', 'loss_lab_host_trace_batch'])
def test_trace_batches_have_independent_failure_accounting(fail_type):
    dc = Channel()
    original_send = dc.send
    def send(value):
        if json.loads(value)['type'] == fail_type:
            raise RuntimeError('deliberate')
        original_send(value)
    dc.send = send
    track, registry = trace_track(dc)
    key = FrameKey('attempt', 1, 'video', 1, 9000)
    registry.register_capture(key, 100)
    registry.bind_wire(key, 7, 77)
    registry.note_dropped_trace(3)
    registry.note_dropped_loss_lab_events(4)
    registry.record_lab_pc_state(identifier='pc', state='connected', width=2, height=2)
    flush(track)
    assert registry.snapshot()['droppedTraceCount'] == (4 if fail_type == 'frame_trace_batch' else 3)
    loss = registry.take_loss_lab_trace_batch()
    assert loss['droppedEventCount'] == (5 if fail_type == 'loss_lab_host_trace_batch' else 0)
    assert len(dc.sent) == 1


def test_allowlist_and_bounded_scalar_counters():
    gate, dc = DiagnosticAdmission(), Channel()
    host = SimpleNamespace(get_input_datachannel=lambda: dc)
    for kind in ['input_ack', 'input_frame_binding', 'clock_sync_resp', 'loss_lab_trace_flush_ack', [], 'other']:
        assert not gate.send(host, dc, {'type': kind})
    assert not dc.sent
    gate.reasons['unsupported'] = COUNTER_MAX
    gate.send(host, dc, {'type': 'other'})
    gate.note_legacy_drop(COUNTER_MAX, COUNTER_MAX)
    gate.note_legacy_drop(1, 1)
    assert gate.reasons['unsupported'] == COUNTER_MAX
    assert gate.legacy == {'ids': COUNTER_MAX, 'metadata': COUNTER_MAX}
    assert len(gate.counts) == 4 and len(gate.reasons) == 10


def host_methods(names, **extra):
    from input_timing import relay_ack_duration_ms
    tree = ast.parse(Path(__file__).with_name('host.py').read_text())
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'WebRemoteHost')
    nodes = [n for n in ast.walk(cls) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
    for node in nodes:
        node.decorator_list = []
    ns = dict(json=json, time=time, logger=logging.getLogger(__name__),
              relay_ack_duration_ms=relay_ack_duration_ms, **extra)
    exec(compile(ast.Module(body=nodes, type_ignores=[]), 'host-reliable-methods', 'exec'), ns)
    return ns


@pytest.mark.asyncio
async def test_reliable_ack_binding_clock_and_lab_flush_still_send_over_budget():
    dc = Channel()
    dc.label = 'input'
    dc.bufferedAmount = 4096
    track = track_for(dc)
    timing(track)
    assert not dc.sent
    registry = FrameTraceRegistry(lab_loss_trace=True)
    registry.record_lab_pc_state(identifier='old', state='connected', width=2, height=2)
    host = SimpleNamespace(
        get_input_datachannel=lambda: dc,
        _emit_input_observation=lambda *a, **kw: None,
        _input_result_status=lambda result: 'applied',
        _input_observation_scope=lambda: ('attempt', 1, 2),
        _input_frame_causality=SimpleNamespace(commit_first_packet=lambda *a, **kw: ['id']),
        _frame_trace_registry=registry, _lab_loss_trace_enabled=True,
        _lab_host_selected_pair=lambda: {'type': 'loss_lab_host_selected_pair'},
    )
    ns = host_methods({'_send_input_ack', '_commit_input_frame', 'on_message'}, self=host, channel=dc)
    assert await ns['_send_input_ack'](host, {'transport': 'datachannel'}, {'inputIds': ['id']}, 1)
    ns['_commit_input_frame'](host, FrameKey('attempt', 1, 'video', 1, 9000), ('attempt', 1, 2), 7, 99)
    ns['on_message'](json.dumps({'type': 'clock_sync_req', 'v0': 1}))
    ns['on_message'](json.dumps({'type': 'loss_lab_selected_pair_request'}))
    ns['on_message'](json.dumps({'type': 'loss_lab_trace_begin', 'epoch': 7}))
    assert [row['type'] for row in dc.sent] == [
        'input_ack', 'input_frame_binding', 'clock_sync_resp',
        'loss_lab_host_selected_pair', 'loss_lab_trace_flush_ack']
    assert dc.bufferedAmount > 4096
    assert dc.sent[-1]['epoch'] == 7
    assert registry.take_loss_lab_trace_batch()['events'] == []


def test_second_batch_sees_first_send_bytes():
    dc = Channel()
    gate = DiagnosticAdmission()
    host = SimpleNamespace(get_input_datachannel=lambda: dc)
    payload = {'type': 'frame_trace_batch', 'traces': ['x' * 2100]}
    assert gate.send(host, dc, payload)
    assert not gate.send(host, dc, payload)
    assert len(dc.sent) == 1
    assert gate.reasons['congested'] == 1


@pytest.mark.parametrize('field', ['readyState', 'send', 'bufferedAmount'])
def test_missing_channel_fields_fail_closed(field):
    fields = dict(readyState='open', send=lambda value: pytest.fail('send'), bufferedAmount=0)
    del fields[field]
    dc = SimpleNamespace(**fields)
    gate = DiagnosticAdmission()
    assert not gate.send(SimpleNamespace(get_input_datachannel=lambda: dc), dc, {'type': 'capture_stats'})


def test_identity_getter_exception_fails_closed_and_success_preserves_legacy_wire():
    dc = Channel()
    def broken():
        raise RuntimeError('identity getter')
    gate = DiagnosticAdmission()
    assert not gate.send(SimpleNamespace(get_input_datachannel=broken), dc, {'type': 'frame_timing'})
    track = track_for(dc)
    track._pending_input_ids = {'legacy'}
    track._pending_input_data = [{'duration': None}]
    timing(track)
    assert dc.sent[0]['inputIds'] == ['legacy']
    assert dc.sent[0]['inputs'] == [{'duration': None}]
    assert track._diagnostic_admission.legacy == {'ids': 0, 'metadata': 0}
    assert track._diagnostic_admission.counts['frame_timing'] == {'sent': 1, 'dropped': 0}
