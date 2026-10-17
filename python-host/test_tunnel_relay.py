import asyncio
from types import SimpleNamespace

import pytest

from host import TunnelRelayStreamer, select_capture_monitor


class FakeSio:
    def __init__(self):
        self.emits = []

    async def emit(self, event, data):
        self.emits.append((event, data))


@pytest.fixture(autouse=True)
def forbid_native_capture(monkeypatch):
    calls = []
    def forbidden(*args, **kwargs):
        calls.append(True)
        raise AssertionError('native capture is prohibited in offline relay tests')
    monkeypatch.setattr('host.MSS', forbidden)
    yield
    assert not calls, 'an offline fixture attempted native capture'


@pytest.mark.asyncio
async def test_tunnel_relay_allows_multiple_frames_in_flight_before_waiting_for_ack():
    sio = FakeSio()
    relay = TunnelRelayStreamer(sio)
    relay.frame_id = 2
    relay.last_acked_frame_id = 0

    assert relay.max_in_flight_frames == 2
    assert relay.should_wait_for_ack() is False

    relay.frame_id = 3
    assert relay.should_wait_for_ack() is True

    relay.ack_event = asyncio.Event()
    import time
    relay.inflight_frames[2] = {"sent_at_ms": time.monotonic() * 1000, "generation": relay.production_generation}
    relay.ack(2)
    assert relay.last_acked_frame_id == 2
    assert relay.ack_event.is_set() is True


def test_tunnel_relay_blocks_capture_when_inflight_window_is_full():
    sio = FakeSio()
    relay = TunnelRelayStreamer(sio)
    relay.inflight_frames = {
        1: {"sent_at_ms": 1000.0},
        2: {"sent_at_ms": 2000.0},
    }
    relay.max_in_flight_frames = 2

    assert relay.should_wait_before_capture() is True

    relay.inflight_frames.pop(1)

    assert relay.should_wait_before_capture() is False


def test_tunnel_relay_downshifts_and_recovers_from_ack_feedback(monkeypatch):
    sio = FakeSio()
    relay = TunnelRelayStreamer(sio)

    assert relay.profile_name == "medium"
    assert relay.jpeg_quality == 26

    monkeypatch.setattr("host.time.monotonic", lambda: 2.0)
    relay.inflight_frames[1] = {"sent_at_ms": 500, "generation": relay.production_generation}
    relay.ack(1, latency_ms=0)
    assert relay.profile_name == "low"
    assert relay.max_in_flight_frames == 1

    relay.inflight_frames[2] = {"sent_at_ms": 500, "generation": relay.production_generation}
    relay.ack(2, latency_ms=0)
    assert relay.profile_name == "survival"
    assert relay.jpeg_quality == 18

    relay.good_ack_streak = 3
    relay.inflight_frames[3] = {"sent_at_ms": 1820, "generation": relay.production_generation}
    relay.ack(3, latency_ms=9999)

    assert relay.profile_name == "low"


def test_tunnel_relay_initial_profile_never_starts_on_high():
    sio = FakeSio()
    relay = TunnelRelayStreamer(sio)

    assert relay._pick_initial_profile(1280, 720, 8) == "medium"
    assert relay._pick_initial_profile(960, 540, 6) == "medium"
    assert relay._pick_initial_profile(854, 480, 4) == "low"
    assert relay._pick_initial_profile(640, 360, 2) == "survival"
    assert relay._pick_initial_profile(1920, 1080, 30) == "medium"


def test_tunnel_relay_step_up_caps_at_medium(monkeypatch):
    sio = FakeSio()
    relay = TunnelRelayStreamer(sio)
    relay._apply_profile("low", reason="test", log=False)

    relay.good_ack_streak = 3
    monkeypatch.setattr("host.time.monotonic", lambda: 1.0)
    relay.inflight_frames[10] = {"sent_at_ms": 950, "generation": relay.production_generation}
    relay.ack(10, latency_ms=9999)
    assert relay.profile_name == "medium"

    relay.good_ack_streak = 3
    relay.inflight_frames[11] = {"sent_at_ms": 980, "generation": relay.production_generation}
    relay.ack(11, latency_ms=9999)
    assert relay.profile_name == "medium"


def test_select_capture_monitor_skips_zero_sized_entries():
    monitor = select_capture_monitor([
        {"left": 0, "top": 0, "width": 0, "height": 0},
        {"left": 0, "top": 0, "width": 0, "height": 0},
        {"left": 10, "top": 20, "width": 1512, "height": 982},
    ])

    assert monitor == {"left": 10, "top": 20, "width": 1512, "height": 982}


def test_select_capture_monitor_falls_back_to_screeninfo_when_mss_is_zero_sized():
    monitor = select_capture_monitor(
        [
            {"left": 0, "top": 0, "width": 0, "height": 0},
        ],
        fallback_monitors=[
            SimpleNamespace(x=32, y=64, width=1728, height=1117),
        ],
    )

    assert monitor == {"left": 32, "top": 64, "width": 1728, "height": 1117}


def test_tunnel_relay_suspend_blocks_production():
    sio = FakeSio()
    relay = TunnelRelayStreamer(sio)
    relay.enabled = True
    relay.viewer_id = "viewer-1"
    relay.inflight_frames = {1: {"sent_at_ms": 1.0}}
    gen = relay.set_suspended(True)
    assert relay.suspended is True
    assert relay.inflight_frames == {}
    assert gen >= 1
    # running property reflects suspension
    assert relay.running is False
    relay.set_suspended(False)
    assert relay.suspended is False

@pytest.mark.asyncio
async def test_relay_worker_generation_is_checked_before_real_emit(monkeypatch):
    import threading
    import host as module
    entered, release = threading.Event(), threading.Event()
    class Processor:
        def __call__(self, request):
            entered.set()
            assert release.wait(2)
            return {'data': b'fake-jpeg', 'width': 10, 'height': 10, 'encodeMs': 1}
        def close(self):
            pass
    monkeypatch.setattr(module, 'RelayJpegProcessor', Processor)
    sio = FakeSio()
    relay = TunnelRelayStreamer(sio)
    await relay.start('fake-viewer')
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        relay.set_suspended(True)
        release.set()
        await relay._jpeg_worker.drain()
        await asyncio.sleep(0)
        assert sio.emits == []
    finally:
        release.set()
        await relay.stop()


def test_reordered_ack_releases_its_own_slot(monkeypatch):
    relay = TunnelRelayStreamer(FakeSio())
    monkeypatch.setattr('host.time.monotonic', lambda: 1.0)
    relay.inflight_frames = {
        n: {'sent_at_ms': 900.0, 'generation': relay.production_generation}
        for n in (98, 99)
    }
    relay.ack(99)
    relay.ack(98)
    assert relay.inflight_frames == {}
    assert relay.last_acked_frame_id == 99
    assert relay.ack_event.is_set()


def test_expiry_releases_slots_without_ack():
    relay = TunnelRelayStreamer(FakeSio())
    relay.inflight_frames = {1: {'sent_at_ms': 10.0, 'generation': relay.production_generation}}
    assert relay.expire_inflight(2009.0) == 0
    assert relay.expire_inflight(2010.0) == 1
    assert relay.pending_frame_count() == 0
    assert relay.ack_event.is_set()


@pytest.mark.asyncio
@pytest.mark.parametrize('duration_seconds', [12, 900])
async def test_actual_run_retires_no_ack_window_and_keeps_one_worker(monkeypatch, duration_seconds):
    import host as module
    clock, workers, emitted, pending, feedback, emit_timeouts = [0.0], [], [], [], [], []
    relay = TunnelRelayStreamer(FakeSio())
    class Worker:
        def __init__(self, _):
            self.captures = 0
            workers.append(self)
        def invalidate(self, _): pass
        async def submit_latest(self, request):
            self.captures += 1
            return {'data': bytes([self.captures % 256]), 'width': 4, 'height': 4, 'encodeMs': 1}
    async def emit(event, data):
        if event == 'relay-frame':
            emitted.append(data)
            emit_timeouts.append(relay.timeout_count)
            pending.append(relay.pending_frame_count())
        elif event == 'relay-frame-feedback':
            feedback.append((clock[0], data))
    async def sleep(seconds):
        clock[0] += seconds
        if clock[0] >= duration_seconds: relay.enabled = False
    async def timeout(waiter, timeout):
        waiter.close()
        clock[0] += timeout
        if clock[0] >= duration_seconds: relay.enabled = False
        raise asyncio.TimeoutError
    monkeypatch.setattr(module, 'RelayFrameWorker', Worker)
    monkeypatch.setattr(module.time, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(module.asyncio, 'sleep', sleep)
    monkeypatch.setattr(module.asyncio, 'wait_for', timeout)
    relay.sio.emit = emit
    relay.enabled, relay.viewer_id, relay.production_generation, relay.producer_id = True, 'viewer-1', 1, 'producer-1'
    relay.bind_media_scope({'connectionAttemptId': 'attempt-1', 'mediaGeneration': 0, 'leaseEpoch': 1})
    relay.task = asyncio.current_task()
    await relay._run()
    assert len(workers) == 1
    assert len(emitted) > 2
    assert emit_timeouts[2] <= 4, 'third distinct capture resumes within four wait timeouts'
    assert len({f['frameId'] for f in emitted}) == len(emitted)
    assert max(pending) <= 2
    assert relay.expired_frame_count > 0 and relay.timeout_count > 0
    assert relay.pending_frame_count() <= 1  # Existing downshift eventually caps at one.
    assert len(feedback) > 3
    assert all(b[0] - a[0] >= 1 for a, b in zip(feedback, feedback[1:]))
    assert all(f['sample'] is None for _, f in feedback)
    assert any(f['oldestPendingAgeMs'] is not None for _, f in feedback)


def scoped_relay():
    relay = TunnelRelayStreamer(FakeSio())
    relay.production_generation, relay.producer_id, relay.viewer_id = 1, 'producer-1', 'viewer-1'
    relay.bind_media_scope({'connectionAttemptId': 'attempt-1', 'mediaGeneration': 0, 'leaseEpoch': 1})
    return relay


def reserve(relay, frame_id, sent_at_ms):
    relay.inflight_frames[frame_id] = {'sent_at_ms': sent_at_ms, 'generation': relay.production_generation,
                                      'relayScope': relay.relay_scope}


def ack(relay, frame_id, scope=None):
    return relay.ack(frame_id, relay_scope=scope or relay.relay_scope, relay_frame_schema_version=1)


def test_old_producer_and_scope_cannot_release_reused_id(monkeypatch):
    first, current = scoped_relay(), scoped_relay()
    current.producer_id = 'producer-2'
    monkeypatch.setattr('host.time.monotonic', lambda: 1)
    reserve(current, 1, 900)
    assert ack(current, 1, first.relay_scope) is False
    assert current.pending_frame_count() == 1
    assert ack(current, 1) is True
    assert ack(current, 1) is False
    old_scope = current.relay_scope
    current.set_suspended(True)
    current.set_suspended(False, media_scope={'connectionAttemptId': 'attempt-1', 'mediaGeneration': 2, 'leaseEpoch': 1})
    reserve(current, 1, 900)
    assert ack(current, 1, old_scope) is False
    assert current.pending_frame_count() == 1
    assert ack(current, 1) is True


@pytest.mark.asyncio
async def test_feedback_ttl_boundary_latest_coalescing_and_scope_reset(monkeypatch):
    relay, clock = scoped_relay(), [1.999]
    monkeypatch.setattr('host.time.monotonic', lambda: clock[0])
    reserve(relay, 1, 0)
    assert ack(relay, 1) is True
    clock[0] = 2.0
    reserve(relay, 2, 1900)
    assert ack(relay, 2) is True
    assert relay.coalesced_count == 1
    await relay.emit_feedback_if_due(2000)
    assert relay.sio.emits[-1][1]['sample'] == {'sampleSequence': 2, 'relayFrameAckRttMs': 100}
    await relay.emit_feedback_if_due(2999)
    assert len(relay.sio.emits) == 1
    reserve(relay, 3, 1000)
    clock[0] = 3.0
    assert ack(relay, 3) is False
    assert relay.expired_frame_count == relay.unmatched_ack_count == 1
    await relay.emit_feedback_if_due(3000)
    assert relay.sio.emits[-1][1]['sample'] is None and relay.coalesced_count == 1
    assert relay.last_ack_latency_ms == 100
    clock[0] = 11
    reserve(relay, 4, 0)
    assert ack(relay, 4) is False
    assert not relay.inflight_frames and relay.last_acked_frame_id == 2
    relay.set_suspended(False, media_scope={'connectionAttemptId': 'attempt-1', 'mediaGeneration': 2, 'leaseEpoch': 1})
    assert relay.expired_frame_count == relay.unmatched_ack_count == relay.coalesced_count == 0
    reserve(relay, 1, 10900)
    assert ack(relay, 1) is True
    await relay.emit_feedback_if_due(11000)
    assert relay.sio.emits[-1][1]['sample']['sampleSequence'] == relay.sio.emits[-1][1]['feedbackSequence'] == 1


@pytest.mark.asyncio
async def test_emit_failure_releases_slot_and_wakes_real_run(monkeypatch):
    import host as module
    relay = TunnelRelayStreamer(FakeSio())
    class Worker:
        def __init__(self, _): pass
        def invalidate(self, _): pass
        async def submit_latest(self, _):
            return {'data': b'x', 'width': 4, 'height': 4, 'encodeMs': 1}
    async def emit(*_):
        relay.enabled = False
        raise RuntimeError('offline failed emit')
    monkeypatch.setattr(module, 'RelayFrameWorker', Worker)
    relay.sio.emit, relay.viewer_id, relay.enabled, relay.task = emit, 'viewer-1', True, asyncio.current_task()
    await relay._run()
    assert not relay.inflight_frames and relay.ack_event.is_set()


def relay_handshake_host(sio):
    from host import WebRemoteHost
    instance = object.__new__(WebRemoteHost)
    instance.sio = sio
    instance.pc = instance.screen_track = instance.media_sender = instance.input_handler = instance.relay_streamer = None
    instance._active_input_binding = {'viewerId': 'viewer-1', 'leaseId': 'lease-000000000001',
                                      'leaseEpoch': 1, 'connectionGeneration': 1}
    instance._media_activity_binding, instance._media_activity_suspended = None, False
    return instance


@pytest.mark.asyncio
async def test_real_host_bind_ordinary_zero_start_scope_and_ack_authority():
    sio = FakeSio()
    instance = relay_handshake_host(sio)
    bind = {**instance._active_input_binding, 'connectionAttemptId': 'attempt-1',
            'connectionAttemptSequence': 1, 'networkMode': 'tunnel'}
    await instance.on_connection_attempt_bind(bind)
    assert instance._media_activity_binding['generation'] == 0
    request = {**bind, 'schemaVersion': 2, 'enabled': True, 'relayFrameSchemaVersion': 1,
               'relayStartRequestId': 'start-1', 'relayMediaGeneration': 0,
               'relayScope': {'producerId': 'untrusted-request-nonce'}}
    await instance.on_relay_stream_control(request)
    relay = instance.relay_streamer
    try:
        event, reply = sio.emits[-1]
        assert event == 'relay-stream-control-ack' and reply['applied'] is True
        assert reply['relayControlKind'] == 'start'
        assert reply['generation'] == reply['relayScope']['mediaGeneration'] == 0
        assert reply['relayScope']['producerId'] != 'untrusted-request-nonce'
        assert reply['relayScope'] == relay.relay_scope
        reserve(relay, 1, __import__('time').monotonic() * 1000)
        feedback = {**request, 'frameId': 1, 'relayScope': reply['relayScope']}
        await instance.on_relay_frame_ack({**feedback, 'leaseEpoch': 2})
        assert relay.pending_frame_count() == 1
        await instance.on_relay_frame_ack(feedback)
        assert not relay.inflight_frames
        await instance.on_relay_stream_control({**request, 'mediaControlSchemaVersion': 1,
            'state': 'suspended', 'generation': 1, 'enabled': False})
        assert sio.emits[-1][1]['relayScope']['mediaGeneration'] == 1
        await instance.on_relay_stream_control(request)
        assert sio.emits[-1][1]['applied'] is False
        await instance.on_relay_stream_control({**request, 'mediaControlSchemaVersion': 1,
            'state': 'active', 'generation': 2})
        assert sio.emits[-1][1]['applied'] is True
        assert sio.emits[-1][1]['relayScope']['mediaGeneration'] == 2
        assert sio.emits[-1][1]['relayScope']['productionGeneration'] != reply['relayScope']['productionGeneration']
    finally:
        await relay.stop()


# Node supplies the exact request forwarded by the registered Signal handlers.
# Stop before yielding to the capture task: no network or native capture occurs.
if __name__ == '__main__':
    import json
    import sys
    async def bridge():
        supplied = json.load(sys.stdin)
        import host as module
        module.RelayJpegProcessor = lambda: lambda request: {'data': b'offline', 'width': 4, 'height': 4, 'encodeMs': 1}
        sio = FakeSio()
        instance = relay_handshake_host(sio)
        instance._active_input_binding = supplied['leaseBinding']
        await instance.on_connection_attempt_bind(supplied['bind'])
        await instance.on_relay_stream_control(supplied['request'])
        result = [data for event, data in sio.emits if event == 'relay-stream-control-ack'][-1]
        if instance.relay_streamer: await instance.relay_streamer.stop()
        print(json.dumps(result))
    asyncio.run(bridge())


@pytest.mark.asyncio
async def test_two_real_starts_get_distinct_producers_despite_reused_frame_and_generation(monkeypatch):
    import host as module
    processed = []
    class OfflineProcessor:
        def __call__(self, request):
            processed.append(request)
            return {'data': b'offline-jpeg', 'width': 4, 'height': 4, 'encodeMs': 1}
        def close(self): pass
    monkeypatch.setattr(module, 'RelayJpegProcessor', OfflineProcessor)
    first, second = TunnelRelayStreamer(FakeSio()), TunnelRelayStreamer(FakeSio())
    binding = {'connectionAttemptId': 'attempt-1', 'mediaGeneration': 0, 'leaseEpoch': 1}
    await first.start('viewer-1', media_scope=binding)
    await second.start('viewer-1', media_scope=binding)
    try:
        assert first.production_generation == second.production_generation
        assert first.producer_id != second.producer_id
        monkeypatch.setattr('host.time.monotonic', lambda: 1)
        reserve(first, 1, 900)
        reserve(second, 1, 900)
        assert ack(second, 1, first.relay_scope) is False
        assert second.pending_frame_count() == 1
        assert ack(second, 1) is True
    finally:
        first.task.cancel()
        second.task.cancel()
        await first.stop()
        await second.stop()
    assert first.task is second.task is None
    assert first._jpeg_worker is second._jpeg_worker is None
    assert not processed


@pytest.mark.asyncio
async def test_scope_change_during_actual_worker_result_drops_it_before_emit(monkeypatch):
    import host as module
    relay = scoped_relay()
    class Worker:
        def __init__(self, _): pass
        def invalidate(self, _): pass
        async def submit_latest(self, request):
            assert request['relayScope']['mediaGeneration'] == 0
            relay.bind_media_scope({'connectionAttemptId': 'attempt-1', 'mediaGeneration': 2, 'leaseEpoch': 1})
            relay.enabled = False
            return {'data': b'x', 'width': 4, 'height': 4, 'encodeMs': 1}
    monkeypatch.setattr(module, 'RelayFrameWorker', Worker)
    relay.enabled, relay.task = True, asyncio.current_task()
    await relay._run()
    assert not [data for event, data in relay.sio.emits if event == 'relay-frame']
    assert not relay.inflight_frames


@pytest.mark.asyncio
async def test_scope_counters_saturate_and_sequences_exhaust_without_reuse(monkeypatch):
    from host import RELAY_SAFE_INTEGER
    relay = scoped_relay()
    monkeypatch.setattr('host.time.monotonic', lambda: 1)
    relay.unmatched_ack_count = RELAY_SAFE_INTEGER
    ack(relay, 999)
    assert relay.unmatched_ack_count == RELAY_SAFE_INTEGER
    relay.expired_frame_count = RELAY_SAFE_INTEGER
    reserve(relay, 1, -2000)
    relay.expire_inflight(1000)
    assert relay.expired_frame_count == RELAY_SAFE_INTEGER
    relay.sample_sequence = RELAY_SAFE_INTEGER
    reserve(relay, 2, 900)
    ack(relay, 2)
    assert relay.sample_sequence == RELAY_SAFE_INTEGER and relay._feedback_unavailable
    await relay.emit_feedback_if_due(1000)
    assert not relay.sio.emits
    relay._reset_relay_observation()
    relay.feedback_sequence = RELAY_SAFE_INTEGER
    await relay.emit_feedback_if_due(2000)
    assert relay.feedback_sequence == RELAY_SAFE_INTEGER and relay._feedback_unavailable
    assert not relay.sio.emits


@pytest.mark.parametrize('patch', [
    {'producerId': ''}, {'producerId': 'x' * 65}, {'producerId': 'é'},
    {'connectionAttemptId': 'a' * 129}, {'mediaGeneration': -1}, {'mediaGeneration': True},
    {'productionGeneration': False}, {'leaseEpoch': True}, {'leaseEpoch': 9007199254740992},
])
def test_strict_scope_boundary_rejects_ambiguous_values(patch):
    from host import valid_relay_scope
    relay = scoped_relay()
    assert valid_relay_scope(relay.relay_scope)
    assert not valid_relay_scope({**relay.relay_scope, **patch})
