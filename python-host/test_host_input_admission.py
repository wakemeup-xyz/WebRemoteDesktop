"""Real Host callbacks with fake adapters only: no capture, native input or sockets."""
import asyncio
import pytest
from types import SimpleNamespace
from host import WebRemoteHost
from input_admission_queue import InputAdmissionQueue


@pytest.mark.asyncio
async def test_host_flood_has_one_drain_one_rejection_and_no_stale_ack():
    host = WebRemoteHost.__new__(WebRemoteHost)
    host._active_input_binding = {'viewerId':'viewer', 'leaseId':'lease-000000000001', 'leaseEpoch':1}
    host.screen_track = None
    host.overlay = SimpleNamespace(send=lambda _: None)
    entered, release = asyncio.Event(), asyncio.Event()
    calls, acks = [], []
    async def native(data):
        entered.set()
        await release.wait()
        calls.append(data['seq'])
        return {'status':'applied', 'inputIds':data['inputIds'], 'appliedSeq':data['seq']}
    async def ack(data, result, duration):
        acks.append((data['seq'], result['status']))
    host.input_handler = SimpleNamespace(handle_input=native)
    host._send_input_ack = ack
    host._input_admission = InputAdmissionQueue(host._execute_input, host._authority_matches, max_pending=1)
    def submit(seq):
        return host.on_input({'schemaVersion':2, 'type':'command', 'action':'showDock', 'payload':{},
                              **host._active_input_binding, 'seq':seq, 'inputIds':[f'test-{seq}']})
    one = submit(1)
    await entered.wait()
    two = submit(2)
    for seq in range(3, 1003):
        assert submit(seq).done()
    assert len(host._input_lifecycle_tasks) == 1
    await asyncio.sleep(0)
    assert acks == [(3, 'resync-required')]
    host._advance_authority()
    async def reset():
        return {'status':'applied'}
    barrier = asyncio.create_task(host._input_admission.reset_after_quiescent(1, reset))
    await asyncio.sleep(0)
    assert not barrier.done()
    release.set()
    await barrier
    assert (await one).outcome == 'cancelled'
    assert (await two).outcome == 'cancelled'
    assert calls == [1]
    assert acks == [(3, 'resync-required')]


def grant_bridge():
    """Real Host transition/reset/bind code; only the native adapter is fake."""
    host = WebRemoteHost.__new__(WebRemoteHost)
    old = {'viewerId':'old-viewer', 'leaseId':'lease-000000000001', 'leaseEpoch':1}
    host._active_input_binding = old.copy()
    host.current_viewer_id = old['viewerId']
    host.pc = host.relay_streamer = host.screen_track = None
    host.overlay = SimpleNamespace(send=lambda _: None)
    entered, release = asyncio.Event(), asyncio.Event()
    reset_calls, input_calls, control_acks = [], [], []
    async def reset_keyboard(**kwargs):
        reset_calls.append('keyboard')
        return {'status':'applied'}
    async def reset_desktop(**kwargs):
        reset_calls.append('desktop')
        return {'status':'applied'}
    async def transition_keyboard(**kwargs):
        entered.set()
        await release.wait()
        return {'status':'applied'}
    async def transition_desktop(**kwargs):
        return SimpleNamespace(status='applied')
    async def native(data):
        input_calls.append(data['seq'])
        return {'status':'applied', 'inputIds':[]}
    host.input_handler = SimpleNamespace(reset_keyboard=reset_keyboard, reset_desktop_writes=reset_desktop,
        transition_keyboard=transition_keyboard, transition_desktop_writes_async=transition_desktop,
        handle_input=native)
    async def emit(event, data):
        if event == 'control-transition-ack': control_acks.append(data)
    host.sio = SimpleNamespace(emit=emit)
    host._get_input_admission()
    next_grant = {'viewerId':'new-viewer', 'leaseId':'lease-000000000002', 'leaseEpoch':2}
    return host, old, next_grant, entered, release, reset_calls, input_calls, control_acks


@pytest.mark.asyncio
async def test_late_input_between_reset_and_bind_cannot_poison_new_grant():
    host, old, grant, entered, release, resets, calls, acks = grant_bridge()
    transition = asyncio.create_task(host.on_control_transition(grant))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        assert resets == ['keyboard', 'desktop']
        before = host._input_admission.snapshot()
        for envelope in (old, grant):
            result = await host.on_input({**envelope, 'schemaVersion':2, 'type':'command',
                'action':'showDock', 'payload':{}, 'seq':1, 'inputIds':['late']})
            assert result.outcome == 'cancelled'
        assert host._input_admission.snapshot() == before
    finally:
        release.set()
        await transition
    assert acks[-1]['status'] == 'applied'
    assert host._input_admission.snapshot()['frozen'] is False
    result = await host.on_input({**grant, 'schemaVersion':2, 'type':'command',
        'action':'showDock', 'payload':{}, 'seq':1, 'inputIds':['fresh']})
    assert result.result['status'] == 'applied'
    assert calls == [1]


@pytest.mark.asyncio
async def test_grant_rejects_when_admission_cannot_reopen_after_bind():
    host, old, grant, entered, release, resets, calls, acks = grant_bridge()
    transition = asyncio.create_task(host.on_control_transition(grant))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        host._input_admission.freeze(host._capture_authority(), 'execution-failed')
    finally:
        release.set()
        await transition
    assert acks[-1]['status'] == 'rejected'
    assert host._active_input_binding is None
    assert host._input_admission.snapshot()['frozen'] is True
    assert calls == []


@pytest.mark.asyncio
async def test_stale_safety_release_cannot_freeze_a_full_current_queue():
    host, old, grant, entered, release, resets, calls, acks = grant_bridge()
    queue = host._input_admission
    queue.max_pending = 1
    current = host.on_input({**old, 'schemaVersion':2, 'type':'command', 'action':'showDock',
                            'payload':{}, 'seq':1, 'inputIds':['current']})
    before = queue.snapshot()
    stale = await host.on_input({**old, 'leaseEpoch':0, 'schemaVersion':2, 'type':'mouse',
                                'action':'reset', 'payload':{'reason':'lost-up'}, 'inputIds':['stale']})
    assert stale.outcome == 'cancelled'
    assert queue.snapshot() == before
    assert (await current).result['status'] == 'applied'
    assert calls == [1]
