"""Exact Host methods, fake adapters and private memory logs; no native/Host import."""
import ast
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

import input_admission_queue
import observability
from input_admission_queue import (
    AdmissionResult, InputAdmissionQueue, completed_future, input_queued_ns,
)
from input_timing import relay_ack_duration_ms
from observability import (
    emit_host_event, summarize_high_frequency_input_event, summarize_input_event,
)


class MemoryLog:
    def __init__(self):
        self.rows = []

    def info(self, message, *args):
        self.rows.append(message % args if args else message)

    warning = error = info

    def events(self):
        return [json.loads(row) for row in self.rows if row.startswith('{')]


def fixture(*, entered_ns=41_000_000, queued_source=input_queued_ns):
    tree = ast.parse(Path(__file__).with_name('host.py').read_text())
    original = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'WebRemoteHost')
    names = {'_execute_input', '_emit_input_observation', '_send_input_ack', 'on_input', '_get_input_admission'}
    methods = [n for n in original.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
    selected = ast.ClassDef(name='Host', bases=[], keywords=[], body=methods, decorator_list=[])
    log = MemoryLog()
    clock = SimpleNamespace(perf_counter_ns=lambda: entered_ns, perf_counter=lambda: .041,
                            monotonic_ns=lambda: 41_000_000)
    namespace = dict(json=json, time=clock, logger=log, input_queued_ns=queued_source,
        InputAdmissionQueue=InputAdmissionQueue, AdmissionResult=AdmissionResult,
        completed_future=completed_future, relay_ack_duration_ms=relay_ack_duration_ms,
        summarize_input_event=summarize_input_event,
        summarize_high_frequency_input_event=summarize_high_frequency_input_event,
        emit_host_event=emit_host_event,
        V2_INPUT_ACK_STATUSES={'applied', 'duplicate', 'execution-failed'})
    exec(compile(ast.fix_missing_locations(ast.Module(body=[selected], type_ignores=[])),
                 '<Host admission timing observation>', 'exec'), namespace)
    host = namespace['Host']()
    binding = dict(viewerId='VIEWER_PRIVATE_CANARY', leaseId='LEASE_PRIVATE_CANARY', leaseEpoch=4)
    host._active_input_binding = binding
    host.current_viewer_id = binding['viewerId']
    authority = object()
    host._capture_authority = lambda: authority
    host._authority_matches = lambda value: value is authority
    host._input_coordinate_is_valid = lambda value: True
    host._note_input_applied = lambda *a, **kw: None
    host._input_result_status = lambda result: result['status']
    host._mirror_socket_reset_ack = lambda *a: False
    host.overlay = SimpleNamespace(send=lambda _: None)
    native, acks = [], []
    result = dict(status='applied', inputIds=['private-admission-input'], appliedSeq=1,
                  hostQueueMs=17.5, hostApplyMs=3.25, pressedKeyCount=0, modifierMask=0)

    async def apply(data, **kwargs):
        native.append(data)
        return result

    async def emit(event, data):
        acks.append((event, data))

    host.input_adapter = host.input_handler = SimpleNamespace(handle_input=apply, apply_keyboard=apply)
    host.sio = SimpleNamespace(emit=emit)
    data = dict(schemaVersion=2, type='mouse', action='reset', transport='socket', **binding,
                seq=1, inputIds=result['inputIds'], payload={'reason': 'manual', 'text': 'PAYLOAD_PRIVATE_CANARY'})
    return SimpleNamespace(host=host, data=data, authority=authority, native=native, acks=acks,
                           result=result, log=log, namespace=namespace)


@pytest.mark.parametrize('value,expected', [(40, 40), (0, 0), (.125, .125), (1.23456, 1.235)])
def test_summary_accepts_only_measured_bounded_admission_wait(value, expected):
    summary = summarize_input_event({}, admission_wait_ms=value)
    assert summary['hostAdmissionWaitMs'] == expected


@pytest.mark.parametrize('value', [None, True, False, '', '40', [], {}, float('nan'),
    float('inf'), -1, 0x80000000, 10 ** 1000], ids=['missing', 'true', 'false',
    'empty-string', 'numeric-string', 'list', 'dict', 'nan', 'infinity', 'negative', 'over-bound', 'huge-int'])
def test_summary_invalid_admission_wait_remains_null(value):
    summary = summarize_input_event({}, admission_wait_ms=value)
    assert 'hostAdmissionWaitMs' in summary
    assert summary['hostAdmissionWaitMs'] is None


def test_summary_missing_admission_wait_is_null_without_reading_input_fields():
    summary = summarize_input_event({'type': 'mouse', 'action': 'reset',
        'inputIds': ['private-admission-input'], 'leaseId': 'LEASE_PRIVATE_CANARY',
        'payload': {'text': 'PAYLOAD_PRIVATE_CANARY', 'relX': .7}})
    assert summary['hostAdmissionWaitMs'] is None
    serialized = json.dumps(summary)
    assert 'PRIVATE_CANARY' not in serialized
    assert 'private-admission-input' not in serialized
    assert 'relX' not in serialized


@pytest.mark.asyncio
async def test_real_submit_to_drain_wait_is_separate_from_adapter_and_ack(monkeypatch):
    h = fixture()
    monkeypatch.setattr(input_admission_queue, 'time', SimpleNamespace(perf_counter_ns=lambda: 1_000_000))
    outcome = await h.host.on_input(h.data)
    assert outcome.outcome == 'applied'
    assert len(h.native) == len(h.acks) == 1
    events = h.log.events()
    assert [row['event'] for row in events] == ['host_input_received', 'host_input_result', 'host_input_ack_sent']
    assert events[0]['meta']['hostAdmissionWaitMs'] == 40
    assert all('hostAdmissionWaitMs' not in row['meta'] for row in events[1:])
    ack = h.acks[0][1]
    assert ack['hostQueueMs'] == 17.5
    assert ack['hostApplyMs'] == 3.25
    assert ack['hostAdapterAwaitMs'] == 0
    assert 'hostAdmissionWaitMs' not in ack
    assert h.result['hostQueueMs'] == 17.5
    assert h.data['seq'] == 1
    assert input_queued_ns.get() is None
    serialized = '\n'.join(h.log.rows)
    assert 'PRIVATE_CANARY' not in serialized
    assert 'private-admission-input' not in serialized


@pytest.mark.parametrize('queued,entered,expected', [
    (1_000_000, 1_000_000, 0),
    (None, 41_000_000, None),
    (-1, 41_000_000, None),
    (42_000_000, 41_000_000, None),
    ('1000000', 41_000_000, None),
    (True, 41_000_000, None),
    (float('nan'), 41_000_000, None),
    (1_000_000, -1, None),
    (1_000_000, True, None),
    (1_000_000, float('inf'), None),
])
@pytest.mark.asyncio
async def test_entry_clock_invalid_or_missing_is_observation_only(queued, entered, expected):
    h = fixture(entered_ns=entered)
    token = input_queued_ns.set(queued)
    try:
        result = await h.host._execute_input(h.data, h.authority)
    finally:
        input_queued_ns.reset(token)
    assert result is h.result
    assert len(h.native) == len(h.acks) == 1
    received = next(row for row in h.log.events() if row['event'] == 'host_input_received')
    assert received['meta']['hostAdmissionWaitMs'] == expected


@pytest.mark.asyncio
async def test_context_clock_failure_cannot_block_native_or_ack():
    def fail():
        raise RuntimeError('CLOCK_PRIVATE_CANARY')
    for source in ('context', 'clock'):
        h = fixture(queued_source=SimpleNamespace(get=fail) if source == 'context' else input_queued_ns)
        if source == 'clock':
            h.namespace['time'].perf_counter_ns = fail
        assert await h.host._execute_input(h.data, h.authority) is h.result
        assert len(h.native) == len(h.acks) == 1
        received = next(row for row in h.log.events() if row['event'] == 'host_input_received')
        assert received['meta']['hostAdmissionWaitMs'] is None
        assert 'CLOCK_PRIVATE_CANARY' not in '\n'.join(h.log.rows)


@pytest.mark.parametrize('action', ['move', 'wheel'])
def test_high_frequency_admission_wait_never_adds_hash_or_per_message_logs(monkeypatch, action):
    def fail_hash(_):
        raise AssertionError('high frequency hashing forbidden')
    monkeypatch.setattr(observability, 'hash_input_ids', fail_hash)
    h = fixture()
    data = {'type': 'mouse', 'action': action, 'transport': 'socket',
            'payload': object(), 'inputIds': object()}
    for _ in range(99):
        assert h.host._emit_input_observation('host_input_received', data,
            status='accepted', admission_wait_ms=40) is False
    assert h.log.events() == []
    assert h.host._emit_input_observation('host_input_received', data,
        status='accepted', admission_wait_ms=40) is True
    row, = h.log.events()
    assert row['event'] == 'host_input_aggregate'
    assert row['meta'] == {'inputType': 'mouse', 'action': action, 'transport': 'socket',
        'status': 'accepted', 'count': 100, 'aggregated': True}


def test_admission_metric_does_not_enter_other_low_frequency_events():
    h = fixture()
    for event in ('host_input_rejected', 'host_input_result', 'host_input_ack_sent'):
        assert h.host._emit_input_observation(event, h.data, admission_wait_ms=40)
    assert all('hostAdmissionWaitMs' not in row['meta'] for row in h.log.events())
