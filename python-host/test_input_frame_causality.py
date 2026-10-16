import unittest
from input_frame_causality import InputFrameCausality
from media_stage_metrics import FrameKey

class TestInputFrameCausality(unittest.TestCase):
    def test_input_needs_a_successful_apply_and_later_new_capture(self):
        scope = ('a', 1, 7)
        c = InputFrameCausality(now_ns=lambda: 300)
        c.reset_scope(scope)
        for status in ('sequence-gap', 'execution-failed', 'duplicate'):
            self.assertEqual(c.note_applied([status], scope=scope, applied_ns=100, status=status), 0)
        self.assertEqual(c.note_applied(['ok'], scope=scope, applied_ns=200, status='applied'), 1)
        key = FrameKey('a', 1, 'video', 2, 12000)
        self.assertEqual(c.reserve_for_capture(key, capture_started_ns=100, reused=False, scope=scope), ())
        self.assertEqual(c.reserve_for_capture(key, capture_started_ns=250, reused=True, scope=scope), ())
        self.assertEqual(c.reserve_for_capture(key, capture_started_ns=250, reused=False, scope=scope), ('ok',))
        c.release_capture(key)
        self.assertEqual(c.reserve_for_capture(key, capture_started_ns=250, reused=False, scope=scope), ('ok',))
        self.assertEqual(c.commit_first_packet(key, wire_timestamp=123, ssrc=1, scope=scope), ('ok',))
        self.assertEqual(c.commit_first_packet(key, wire_timestamp=123, ssrc=1, scope=scope), ())

    def test_capacity_expiry_and_scope(self):
        now = [100]
        c = InputFrameCausality(now_ns=lambda: now[0], max_pending=2)
        scope = ('a', 1, 1); c.reset_scope(scope)
        c.note_applied(['one', 'two', 'three'], scope=scope, applied_ns=1, status='applied')
        self.assertEqual(c.snapshot()['pending'], 2)
        key = FrameKey('a', 1, 'video', 1, 1)
        self.assertEqual(c.reserve_for_capture(key, capture_started_ns=2, reused=False, scope=('a', 2, 1)), ())
        now[0] = 10_000_000_101
        self.assertEqual(c.reserve_for_capture(key, capture_started_ns=2, reused=False, scope=scope), ())
        self.assertEqual(c.snapshot()['pending'], 0)

class HostCausalityTests(unittest.IsolatedAsyncioTestCase):
    async def test_selected_old_capture_and_reuse_cannot_take_input_during_worker(self):
        import asyncio
        import threading
        import numpy as np
        from host import WebRemoteHost
        from test_frame_worker import Screenshot, bare_track
        host = WebRemoteHost.__new__(WebRemoteHost)
        host._active_input_binding = {'connectionAttemptId':'a', 'connectionAttemptSequence':1, 'leaseEpoch':7}
        host._input_frame_causality = InputFrameCausality(now_ns=lambda: 1000)
        scope = host._input_observation_scope(); host._input_frame_causality.reset_scope(scope)
        host.get_input_datachannel = lambda: None
        track = bare_track(); track._host_ref = host
        track._capture_seq = 1
        track._capture_bounds_ns[1] = (100, 110)
        track._capture_buffer = Screenshot(np.zeros((2, 2, 4), dtype=np.uint8))
        entered, release = asyncio.Event(), threading.Event()
        loop = asyncio.get_running_loop(); original = track._build_video_frame
        def blocked(*args):
            loop.call_soon_threadsafe(entered.set)
            if not release.wait(2): raise AssertionError('worker barrier timeout')
            return original(*args)
        track._build_video_frame = blocked
        try:
            task = asyncio.create_task(track.recv()); await entered.wait()
            host._input_frame_causality.note_applied(['new'], scope=scope, applied_ns=200, status='applied')
            # Mutating the capture publisher after selection cannot alter selected tuple.
            track._capture_bounds_ns[1] = (300, 310)
            release.set(); await task
            self.assertEqual(host._input_frame_causality.snapshot()['reservations'], 0)
            await track.recv()  # reused cached image
            self.assertEqual(host._input_frame_causality.snapshot()['reservations'], 0)
            track._capture_buffer = Screenshot(np.zeros((2, 2, 4), dtype=np.uint8))
            track._capture_seq = 2; track._capture_bounds_ns[2] = (400, 410)
            await track.recv()
            self.assertEqual(host._input_frame_causality.snapshot()['reservations'], 1)
        finally:
            release.set(); track._process_executor.shutdown(wait=True)

    async def test_real_host_adapter_results_only_success_is_candidate(self):
        from types import SimpleNamespace
        from host import WebRemoteHost
        for status in ('applied', 'sequence-gap', 'execution-failed'):
            host = WebRemoteHost.__new__(WebRemoteHost)
            host._active_input_binding = {'viewerId':'viewer', 'leaseId':'lease-000000000001', 'leaseEpoch':7,
                'connectionAttemptId':'a', 'connectionAttemptSequence':1, 'connectionGeneration':1}
            host.screen_track = None; host.overlay = SimpleNamespace(send=lambda _: None)
            async def adapter(data): return {'status':status, 'inputIds':data['inputIds'], 'appliedSeq':1}
            async def ack(*args): pass
            host.input_handler = SimpleNamespace(handle_input=adapter); host._send_input_ack = ack
            await host.on_input({'schemaVersion':2, 'type':'command', 'action':'showDock', 'payload':{},
                **host._active_input_binding, 'seq':1, 'inputIds':['test-input']})
            self.assertEqual(host._input_frame_causality.snapshot()['pending'], 1 if status == 'applied' else 0)

    async def test_sender_identity_and_failed_send_preserve_candidate_until_successful_binding(self):
        import json
        from types import SimpleNamespace
        from host import WebRemoteHost
        from rtp_frame_observer import RtpFrameObserver, send_with_observation
        host = WebRemoteHost.__new__(WebRemoteHost)
        host._active_input_binding = {'connectionAttemptId':'a', 'connectionAttemptSequence':1, 'leaseEpoch':7}
        host._input_frame_causality = InputFrameCausality(now_ns=lambda: 1000)
        scope = host._input_observation_scope(); host._input_frame_causality.reset_scope(scope)
        host._input_frame_causality.note_applied(['ok'], scope=scope, applied_ns=100, status='applied')
        key = FrameKey('a', 1, 'video', 1, 9000)
        host._input_frame_causality.reserve_for_capture(key, capture_started_ns=200, reused=False, scope=scope)
        sender = SimpleNamespace(_wrd_input_frame_host=host, _ssrc=7)
        host.video_sender = sender
        observer = RtpFrameObserver()
        old_sender = SimpleNamespace(_wrd_input_frame_host=host, _ssrc=7)
        self.assertFalse(observer.observe_encoded_frame(old_sender, encoder_timestamp=9000))
        self.assertTrue(observer.observe_encoded_frame(sender, encoder_timestamp=9000))
        sent = []; host.get_input_datachannel = lambda: SimpleNamespace(send=lambda text: sent.append(json.loads(text)))
        packet = b'\x80\x60\x00\x01' + (123).to_bytes(4, 'big') + (7).to_bytes(4, 'big') + b'x'
        async def fail(*args): raise ConnectionError('fake')
        with self.assertRaises(ConnectionError): await send_with_observation(observer, None, packet, fail)
        self.assertEqual(sent, [])
        self.assertEqual(host._input_frame_causality.snapshot()['pending'], 1)
        self.assertEqual(host._input_frame_causality.snapshot()['reservations'], 0)
        host._input_frame_causality.reserve_for_capture(key, capture_started_ns=200, reused=False, scope=scope)
        observer.observe_encoded_frame(sender, encoder_timestamp=9000)
        async def success(*args): return None
        await send_with_observation(observer, None, packet, success)
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]['type'], 'input_frame_binding')
        self.assertEqual(sent[0]['inputIds'], ['ok'])
        self.assertEqual(sent[0]['wireTimestamp'], 123)
