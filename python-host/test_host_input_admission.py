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
