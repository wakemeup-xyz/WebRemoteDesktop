"""Real relay loop with synthetic transports; no native or network imports."""
import ast
import asyncio
from contextlib import asynccontextmanager
import logging
from pathlib import Path
from types import SimpleNamespace
import time
import uuid

import pytest
from input_timing import relay_ack_duration_ms


def load_relay():
    source = ast.parse(Path(__file__).with_name('host.py').read_text())
    names = {'TunnelRelayStreamer', 'valid_relay_nonce', 'valid_relay_integer',
             'valid_relay_scope', 'relay_ack_duration_ms', 'RELAY_FRAME_SLOT_TTL_MS',
             'RELAY_SAFE_INTEGER', 'TUNNEL_RELAY_PROFILES', 'TUNNEL_RELAY_PROFILE_ORDER'}
    nodes = [node for node in source.body if getattr(node, 'name', None) in names or
             isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in names for t in node.targets)]
    scope = dict(asyncio=asyncio, time=time, uuid=uuid, logger=logging.getLogger(__name__),
                 relay_ack_duration_ms=relay_ack_duration_ms)
    exec(compile(ast.Module(body=nodes, type_ignores=[]), 'host.py', 'exec'), scope)
    return scope


class Transport:
    def __init__(self, writer):
        self.connected = True
        self.eio = SimpleNamespace(state='connected', queue=asyncio.Queue(), write_loop_task=writer)
        self.emits = []

    async def emit(self, event, payload):
        self.emits.append((event, payload))
        # JPEG transport accounting remains unfinished until the test writer drains it.
        if event == 'relay-frame':
            self.eio.queue.put_nowait(payload['data'])


@asynccontextmanager
async def harness():
    module = load_relay()
    tasks = []
    async def writer():
        await asyncio.Event().wait()
    def transport():
        task = asyncio.create_task(writer())
        tasks.append(task)
        return Transport(task)
    captures, entered, release = [], asyncio.Event(), asyncio.Event()
    class Worker:
        stopped = False
        def __init__(self, _): pass
        def invalidate(self, _): pass
        async def stop(self):
            self.stopped = True
            return True
        async def submit_latest(self, request):
            captures.append(request)
            entered.set()
            await release.wait()
            return {'data': b'jpeg', 'width': 4, 'height': 4, 'encodeMs': 1}
    module.update(RelayFrameWorker=Worker, RelayJpegProcessor=lambda: None)
    relay = module['TunnelRelayStreamer'](transport())
    binding = {'connectionAttemptId': 'attempt', 'mediaGeneration': 0, 'leaseEpoch': 1}
    relay.enabled, relay.viewer_id, relay.producer_id = True, 'viewer', 'producer'
    relay.production_generation = 1
    relay.bind_media_scope(binding)
    def run():
        task = asyncio.create_task(relay._run())
        tasks.append(task)
        relay.task = task
        return task
    state = SimpleNamespace(relay=relay, captures=captures, entered=entered, release=release,
                            transport=transport, run=run, binding=binding, tasks=tasks)
    try:
        yield state
    finally:
        state.relay.enabled = False
        relay.enabled = False
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await relay.stop()


def held_packet(queue):
    queue.put_nowait(b'old-binary')
    queue.get_nowait()
    assert queue.qsize() == 0


def jpeg_events(sio):
    return [payload for event, payload in sio.emits if event == 'relay-frame']


@pytest.mark.asyncio
async def test_writer_owned_packet_blocks_capture_feedback_across_deadlines_and_ack_expiry():
    async with harness() as h:
        q = h.relay.sio.eio.queue
        held_packet(q)
        h.relay.inflight_frames[1] = {'sent_at_ms': time.monotonic() * 1000 - 2100}
        h.run()
        await asyncio.sleep(.8)
        assert h.relay.expired_frame_count == 1
        assert not h.captures and not h.relay.sio.emits
        assert h.relay.timeout_count == 0
        q.task_done()
        await asyncio.wait_for(h.entered.wait(), .5)
        assert len(h.captures) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('lifecycle', ['resume', 'restart', 'replacement'])
async def test_first_frame_after_lifecycle_still_waits_old_accounting(lifecycle):
    async with harness() as h:
        q = h.relay.sio.eio.queue
        held_packet(q)
        h.run()
        await asyncio.sleep(.03)
        if lifecycle == 'resume':
            h.relay.set_suspended(True)
            h.relay.set_suspended(False)
        else:
            await h.relay.stop()
            if lifecycle == 'replacement':
                h.relay = type(h.relay)(h.relay.sio)
            await h.relay.start('viewer', media_scope=h.binding)
            h.tasks.append(h.relay.task)
        await asyncio.sleep(.3)
        assert not h.captures and not h.relay.sio.emits
        q.task_done()
        await asyncio.wait_for(h.entered.wait(), .7)
        assert len(h.captures) == 1


async def mutate(h, kind):
    relay = h.relay
    if kind == 'client': relay.sio = h.transport()
    elif kind == 'eio': relay.sio.eio = h.transport().eio
    elif kind == 'queue': relay.sio.eio.queue = asyncio.Queue()
    elif kind == 'writer': relay.sio.eio.write_loop_task = h.transport().eio.write_loop_task
    elif kind == 'dead-writer':
        relay.sio.eio.write_loop_task.cancel()
        await asyncio.gather(relay.sio.eio.write_loop_task, return_exceptions=True)
    elif kind == 'task': relay.task = h.transport().eio.write_loop_task
    elif kind == 'authority': relay._authority_is_current = lambda: False
    elif kind == 'generation': relay.production_generation += 1
    elif kind == 'scope': relay._relay_binding['mediaGeneration'] += 1
    elif kind == 'disconnected': relay.sio.connected = False


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['client', 'eio', 'queue', 'writer', 'dead-writer', 'task', 'authority', 'generation', 'scope', 'disconnected'])
@pytest.mark.parametrize('phase', ['join', 'capture', 'feedback'])
async def test_stale_token_cannot_capture_or_emit(kind, phase):
    async with harness() as h:
        sio, q = h.relay.sio, h.relay.sio.eio.queue
        feedback_entered, feedback_release = asyncio.Event(), asyncio.Event()
        if phase == 'join': held_packet(q)
        if phase == 'feedback':
            original = h.relay.emit_feedback_if_due
            async def feedback(now):
                feedback_entered.set()
                await feedback_release.wait()
                await original(now)
            h.relay.emit_feedback_if_due = feedback
        task = h.run()
        if phase == 'capture': await asyncio.wait_for(h.entered.wait(), .5)
        elif phase == 'feedback': await asyncio.wait_for(feedback_entered.wait(), .5)
        else: await asyncio.sleep(.03)
        await mutate(h, kind)
        # Freeze the next generation so only the original continuation is examined.
        if kind in ('client', 'eio', 'queue', 'writer', 'generation', 'scope'):
            held_packet(h.relay.sio.eio.queue)
        if phase == 'join': q.task_done()
        h.release.set()
        feedback_release.set()
        await asyncio.sleep(.08)
        assert not jpeg_events(sio) and not jpeg_events(h.relay.sio)
        assert not h.relay.inflight_frames
        if phase != 'capture': assert not h.captures
        task.cancel()


@pytest.mark.asyncio
async def test_new_client_does_not_wait_for_orphan_queue():
    async with harness() as h:
        old = h.relay.sio.eio.queue
        held_packet(old)
        h.run()
        await asyncio.sleep(.03)
        h.relay.sio = h.transport()
        await asyncio.wait_for(h.entered.wait(), .8)
        assert old._unfinished_tasks == 1


@pytest.mark.asyncio
async def test_dead_writer_with_empty_queue_fails_closed():
    async with harness() as h:
        await mutate(h, 'dead-writer')
        h.run()
        await asyncio.sleep(.3)
        assert not h.captures and not h.relay.sio.emits


@pytest.mark.asyncio
async def test_cancellation_removes_join_waiter_without_changing_accounting():
    async with harness() as h:
        q = h.relay.sio.eio.queue
        held_packet(q)
        task = h.run()
        await asyncio.sleep(.55)
        assert len(q._finished._waiters) == 1
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        assert not q._finished._waiters
        assert q._unfinished_tasks == 1 and q.qsize() == 0


@pytest.mark.asyncio
async def test_healthy_drain_allows_next_frame_but_ack_window_still_blocks():
    async with harness() as h:
        h.relay.max_in_flight_frames = 1
        h.release.set()
        h.run()
        await asyncio.wait_for(h.entered.wait(), .5)
        await asyncio.sleep(.03)
        q = h.relay.sio.eio.queue
        assert len(jpeg_events(h.relay.sio)) == 1
        q.get_nowait()
        q.task_done()
        await asyncio.sleep(.2)
        assert len(h.captures) == 1
        payload = jpeg_events(h.relay.sio)[0]
        assert h.relay.ack(payload['frameId'], relay_scope=payload['relayScope'], relay_frame_schema_version=1)
        await asyncio.sleep(.2)
        assert len(h.captures) == len(jpeg_events(h.relay.sio)) == 2


@pytest.mark.asyncio
async def test_installed_asyncclient_binary_emit_enqueues_without_scheduler_interleave():
    import socketio
    client = socketio.AsyncClient()
    client.namespaces['/'] = 'synthetic'
    client.eio.state = 'connected'
    turns = []
    async def sibling(): turns.append('turn')
    task = asyncio.create_task(sibling())
    try:
        await client.emit('relay-frame', {'data': b'jpeg'})
        assert client.eio.queue.qsize() == 2
        assert not turns
        envelope = client.eio.queue.get_nowait()
        attachment = client.eio.queue.get_nowait()
        assert isinstance(envelope.data, str)
        assert attachment.data == b'jpeg'
        client.eio.queue.task_done()
        client.eio.queue.task_done()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['client', 'eio', 'queue', 'writer', 'dead-writer', 'task', 'authority', 'generation', 'scope', 'disconnected'])
async def test_join_completion_rechecks_original_token(kind):
    async with harness() as h:
        q = h.relay.sio.eio.queue
        held_packet(q)
        h.relay.task = asyncio.current_task()
        token = h.relay._capture_transport_token()
        async def change():
            await asyncio.sleep(.01)
            await mutate(h, kind)
            q.task_done()
        task = asyncio.create_task(change())
        h.tasks.append(task)
        try:
            assert not await h.relay._wait_for_transport_admission(token)
        finally:
            # Do not let harness stop() cancel this pytest task.
            h.relay.task = None


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['missing-eio', 'missing-writer', 'missing-join', 'raising-join', 'raising-authority'])
async def test_malformed_transport_fails_closed_and_yields(kind):
    async with harness() as h:
        h.relay.task = asyncio.current_task()
        if kind == 'missing-eio': del h.relay.sio.eio
        elif kind == 'missing-writer': h.relay.sio.eio.write_loop_task = None
        elif kind == 'missing-join': h.relay.sio.eio.queue = object()
        elif kind == 'raising-join':
            async def broken(): raise RuntimeError('synthetic')
            h.relay.sio.eio.queue = SimpleNamespace(join=broken)
        else:
            def broken(): raise RuntimeError('synthetic')
            h.relay._authority_is_current = broken
        token = h.relay._capture_transport_token()
        turns = []
        async def sibling(): turns.append(1)
        task = asyncio.create_task(sibling())
        h.tasks.append(task)
        try:
            assert not await h.relay._wait_for_transport_admission(token)
            assert turns
        finally:
            h.relay.task = None
