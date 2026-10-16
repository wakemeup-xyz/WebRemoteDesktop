import unittest
from types import SimpleNamespace
from rtp_frame_observer import send_with_observation

class BoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_success_and_failure(self):
        for fail in (False, True):
            calls = []
            observer = SimpleNamespace(prepare_outgoing_rtp=lambda data: 'token',
                commit_outgoing_rtp=lambda token: calls.append('commit'),
                reject_outgoing_rtp=lambda token: calls.append('reject'))
            async def send(transport, data):
                calls.append('send')
                if fail: raise ConnectionError('fake')
                return 42
            if fail:
                with self.assertRaises(ConnectionError): await send_with_observation(observer, None, b'', send)
            else: self.assertEqual(await send_with_observation(observer, None, b'', send), 42)
            self.assertEqual(calls, ['send', 'reject' if fail else 'commit'])

    async def test_observer_failure_does_not_change_send(self):
        def broken(*args): raise ValueError('observer')
        calls = []
        async def send(*args): calls.append(1); return 7
        observer = SimpleNamespace(prepare_outgoing_rtp=broken, commit_outgoing_rtp=broken)
        self.assertEqual(await send_with_observation(observer, None, b'', send), 7)
        self.assertEqual(calls, [1])

    async def test_actual_new_dtls_transport_rejects_before_encryption_and_binding(self):
        from aiortc import RTCCertificate, RTCDtlsTransport, RTCIceGatherer, RTCIceTransport
        from media_stage_metrics import FrameKey, FrameTraceRegistry
        from rtp_frame_observer import RtpFrameObserver
        registry = FrameTraceRegistry()
        key = FrameKey('a', 1, 'video', 1, 100)
        registry.register_capture(key, 100)
        observer = RtpFrameObserver(registry)
        observer.observe_encoded_frame(object(), encoder_timestamp=100, ssrc=7)
        transport = RTCDtlsTransport(RTCIceTransport(RTCIceGatherer()), [RTCCertificate.generateCertificate()])
        self.assertEqual(transport.state, 'new')
        class EncryptionMustNotRun:
            def protect(self, data): raise AssertionError('encryption called')
        transport._tx_srtp = EncryptionMustNotRun()
        packet = b'\x80\x60\x00\x01' + (123).to_bytes(4, 'big') + (7).to_bytes(4, 'big') + b'x'
        with self.assertRaises(ConnectionError):
            await send_with_observation(observer, transport, packet, RTCDtlsTransport._send_rtp)
        self.assertEqual(registry.snapshot()['wireBoundCount'], 0)
        self.assertEqual(registry.take_frame_trace_batch()['traces'], [])
