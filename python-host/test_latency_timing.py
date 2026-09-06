import time
import threading
import unittest
import sys
import os
import json
import subprocess
import textwrap
from types import SimpleNamespace

import numpy as np

# Add parent dir to path to import host module
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from host import ScreenCaptureTrack, WebRemoteHost
from media_timing import RtpFrameClock
from media_stage_metrics import FrameKey, FrameTraceRegistry, SenderFrameTraceContext, StageMetrics
from rtp_frame_observer import RtpFrameObserver
from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy
from h264_videotoolbox_encoder import H264VideoToolboxEncoder
from test_frame_worker import Screenshot, bare_track


class TestFrameTiming(unittest.TestCase):
    def test_timing_capture_order(self):
        """Verify T0 <= T1 <= T2 <= T3 <= T4"""
        t0 = time.perf_counter()
        time.sleep(0.001)
        t1 = time.perf_counter()
        time.sleep(0.001)
        t2 = time.perf_counter()
        time.sleep(0.001)
        t3 = time.perf_counter()
        time.sleep(0.001)
        t4 = time.perf_counter()

        self.assertLessEqual(t0, t1)
        self.assertLessEqual(t1, t2)
        self.assertLessEqual(t2, t3)
        self.assertLessEqual(t3, t4)

    def test_screen_capture_track_has_timing_fields(self):
        """Verify ScreenCaptureTrack initializes timing fields"""
        track = ScreenCaptureTrack(target_fps=1, max_width=640, max_height=480)
        self.assertTrue(hasattr(track, '_pending_input_ids'))
        self.assertTrue(hasattr(track, '_pending_input_lock'))
        self.assertTrue(hasattr(track, '_timing_seq'))
        self.assertTrue(hasattr(track, '_host_ref'))
        self.assertIsInstance(track._frame_clock, RtpFrameClock)
        self.assertEqual(track._pending_input_ids, set())
        self.assertEqual(track._timing_seq, 0)
        track.sct.close()  # Clean up MSS resources

    def test_frame_timing_v2_only_names_measured_boundaries(self):
        sent = []
        track = object.__new__(ScreenCaptureTrack)
        track._host_ref = type("Host", (), {"get_input_datachannel": lambda self: type("DC", (), {"send": lambda self, value: sent.append(value)})()})()
        track._pending_input_lock = __import__("threading").Lock()
        track._pending_input_ids = set()
        track._pending_input_data = []
        track._timing_seq = 7

        track._send_frame_timing(capture_prepare_ms=3.5, frame_convert_ms=1.25)
        payload = __import__("json").loads(sent[0])

        self.assertEqual(payload["schemaVersion"], 2)
        self.assertEqual(payload["timings"]["capturePrepareMs"], 3.5)
        self.assertEqual(payload["timings"]["frameConvertMs"], 1.25)
        self.assertIsNone(payload["timings"]["imgprocQueueMs"])
        self.assertIsNone(payload["timings"]["imgprocBuildMs"])
        self.assertIsNone(payload["timings"]["encoderMs"])
        self.assertIsNone(payload["timings"]["rtpSendMs"])
        self.assertIsNone(payload["timings"]["endToEndVideoMs"])
        self.assertNotIn("encodeEnd", payload["timings"])
        self.assertNotIn("packetSend", payload["timings"])

    def test_frame_trace_summary_reports_real_denominators_and_resets_interval(self):
        registry = FrameTraceRegistry()
        metrics = StageMetrics(registry=registry)
        context = SenderFrameTraceContext(registry, metrics, "attempt", 1)
        key = FrameKey("attempt", 1, "video", 1, 9000)
        self.assertTrue(registry.register_capture(key, 100))
        self.assertTrue(registry.bind_wire(key, 7, 77))
        self.assertTrue(metrics.record(key, "grab", 0, 1_000_000))
        track = object.__new__(ScreenCaptureTrack)
        track._trace_interval = {
            "captures": 2, "outputs": 2, "outputsWithCapture": 1, "reusedOutputs": 1,
            "cpuStartedNs": time.process_time_ns(),
        }
        track._trace_interval_lock = __import__("threading").Lock()

        first = track._frame_trace_summary(context)
        second = track._frame_trace_summary(context)
        self.assertEqual(first["counts"], {"captures": 2, "outputs": 2, "outputsWithCapture": 1, "reusedOutputs": 1})
        self.assertEqual(first["coverage"]["sourceToWire"], 1.0)
        self.assertEqual(first["coverage"]["stages"]["grab"], 0.5)
        self.assertEqual(first["alignmentState"], "OBSERVED")
        self.assertEqual(second["counts"]["outputs"], 0)
        self.assertIsNone(second["coverage"]["sourceToWire"])
        self.assertEqual(second["alignmentState"], "UNALIGNED")

    def test_trace_interval_lock_serializes_a_capture_increment_before_snapshot_reset(self):
        class GateLock:
            def __init__(self):
                self._lock = threading.Lock()
                self.first_entered = threading.Event()
                self.second_waiting = threading.Event()
                self.release_first = threading.Event()
                self._first = True

            def __enter__(self):
                if self._first:
                    self._first = False
                    self._lock.acquire()
                    self.first_entered.set()
                    assert self.release_first.wait(timeout=1)
                else:
                    self.second_waiting.set()
                    self._lock.acquire()
                return self

            def __exit__(self, *_args):
                self._lock.release()

        registry = FrameTraceRegistry()
        metrics = StageMetrics(registry=registry)
        context = SenderFrameTraceContext(registry, metrics, "attempt", 1)
        track = object.__new__(ScreenCaptureTrack)
        track._trace_interval = {
            "captures": 0, "outputs": 0, "outputsWithCapture": 0, "reusedOutputs": 0,
            "cpuStartedNs": time.process_time_ns(),
        }
        gate = GateLock()
        track._trace_interval_lock = gate
        writer = threading.Thread(target=lambda: track._increment_trace_interval(captures=1))
        snapshots = []
        reader = threading.Thread(target=lambda: snapshots.append(track._frame_trace_summary(context)))
        writer.start()
        self.assertTrue(gate.first_entered.wait(timeout=1))
        reader.start()
        self.assertTrue(gate.second_waiting.wait(timeout=1))
        gate.release_first.set()
        writer.join(timeout=1)
        reader.join(timeout=1)

        self.assertFalse(writer.is_alive())
        self.assertFalse(reader.is_alive())
        self.assertEqual(snapshots[0]["counts"]["captures"], 1)
        self.assertEqual(track._frame_trace_summary(context)["counts"]["captures"], 0)

    def test_real_capture_encoder_rtp_datachannel_and_viewer_trace_wiring_preserves_legacy_timing(self):
        """Exercise the production hand-offs; no registry annotation is injected."""
        registry = FrameTraceRegistry()
        host = object.__new__(WebRemoteHost)
        host._frame_trace_registry = registry
        host._stage_metrics = StageMetrics(registry=registry)
        host.media_profile = {"width": 1280, "height": 720, "target_fps": 20}
        host._user_resolution = {"width": 1280, "height": 720}
        host._h264_policy_version = "relay-legacy-v1"
        host._connection_generation = 0
        # Use the Host's existing viewer session payload source.  In particular,
        # this must retain connectionAttemptSequence rather than a media state.
        host._bind_session_presentation({
            "connectionAttemptId": "attempt-live", "connectionAttemptSequence": 7,
            "networkMode": "relay", "width": 1280, "height": 720,
        })
        policy = host._h264_policy_provider.current_policy()
        context = host._frame_trace_context_for_policy(policy)

        async def produce_host_messages():
            track = bare_track(max_width=16, max_height=16)
            sent = []
            track._host_ref = type("Host", (), {
                "get_input_datachannel": lambda _self: type("DC", (), {"send": lambda _dc, value: sent.append(value)})(),
            })()
            track._frame_trace_context = context
            track._capture_buffer = Screenshot(np.zeros((16, 16, 4), dtype=np.uint8))
            track._capture_seq = 1
            now_ns = time.monotonic_ns()
            track._capture_bounds_ns[1] = (now_ns - 1_000_000, now_ns)
            try:
                frame = await track.recv()
                encoder = H264VideoToolboxEncoder(policy=policy, frame_trace_context=context)
                packetized, encoder_timestamp = encoder.encode(frame)
                self.assertTrue(packetized)

                import aiortc.rtcrtpsender as sender_module
                import aiortc.rtcdtlstransport as dtls_module
                import rtp_frame_observer as observer_module
                saved_next = sender_module.RTCRtpSender._next_encoded_frame
                saved_send = dtls_module.RTCDtlsTransport._send_rtp

                async def fake_next(_sender, _codec):
                    return SimpleNamespace(timestamp=encoder_timestamp)

                async def fake_send(transport, data):
                    transport.sent.append(bytes(data))

                sender_module.RTCRtpSender._next_encoded_frame = fake_next
                dtls_module.RTCDtlsTransport._send_rtp = fake_send
                try:
                    observer = RtpFrameObserver(registry)
                    original_compatibility = observer_module.aiortc_observer_compatibility
                    observer_module.aiortc_observer_compatibility = lambda **_kwargs: (True, "ok")
                    try:
                        installed, reason = observer_module.install_aiortc_observer(observer)
                        self.assertTrue(installed, reason)
                        sender = SimpleNamespace(_wrd_frame_trace_context=context, _ssrc=7)
                        await sender_module.RTCRtpSender._next_encoded_frame(sender, None)
                        packet = b"\x80\x60\x00\x01\x00\x00\x00\x4d\x00\x00\x00\x07x"
                        transport = SimpleNamespace(sent=[])
                        await dtls_module.RTCDtlsTransport._send_rtp(transport, packet)
                        self.assertEqual(transport.sent, [packet])
                    finally:
                        observer_module.aiortc_observer_compatibility = original_compatibility
                finally:
                    sender_module.RTCRtpSender._next_encoded_frame = saved_next
                    dtls_module.RTCDtlsTransport._send_rtp = saved_send

                track._last_trace_send_ns = 0
                track._send_frame_trace_batch()
                track._send_frame_timing(capture_prepare_ms=1.25, frame_convert_ms=2.5)
                return sent
            finally:
                track._process_executor.shutdown(wait=True)

        asyncio = __import__("asyncio")
        try:
            prior_loop = asyncio.get_event_loop()
        except RuntimeError:
            prior_loop = None
        loop = asyncio.new_event_loop()
        try:
            asyncio.set_event_loop(loop)
            sent = loop.run_until_complete(produce_host_messages())
        finally:
            loop.close()
            asyncio.set_event_loop(prior_loop if prior_loop is not None and not prior_loop.is_closed()
                                   else asyncio.new_event_loop())
        trace_raw = next(raw for raw in sent if json.loads(raw).get("type") == "frame_trace_batch")
        timing_raw = sent[-1]
        self.assertEqual(timing_raw, json.dumps({
            "type": "frame_timing", "schemaVersion": 2, "frameId": 1,
            "timings": {
                "capturePrepareMs": 1.25, "frameConvertMs": 2.5,
                "imgprocQueueMs": None, "imgprocBuildMs": None,
                "encoderMs": None, "rtpSendMs": None, "endToEndVideoMs": None,
            },
        }))

        viewer_script = textwrap.dedent("""
            const fs = require('fs'), vm = require('vm');
            let callback = null;
            function element() { return { classList: { add(){}, remove(){}, contains(){ return false; } }, style: {}, dataset: {}, addEventListener(){}, removeAttribute(){}, setAttribute(){}, getAttribute(){ return null; }, textContent: '', disabled: false }; }
            const video = element(); video.videoWidth = 16; video.requestVideoFrameCallback = (fn) => { callback = fn; return 1; }; video.cancelVideoFrameCallback = () => {};
            const context = { console: { log(){}, warn(){}, error(){}, info(){} }, performance: { now: () => 0 }, localStorage: { getItem(){ return null; }, setItem(){}, removeItem(){} }, document: { readyState: 'loading', body: element(), addEventListener(){}, querySelector(){ return null; }, getElementById(id){ return id === 'remoteVideo' ? video : element(); } }, window: { location: { origin: 'http://127.0.0.1:8080' }, RTCRtpReceiver: null }, navigator: { platform: 'MacIntel', userAgent: 'trace-fixture' }, setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: (fn) => fn(), getComputedStyle: () => ({ objectFit: 'contain' }), io: () => ({ on(){}, emit(){}, disconnect(){}, connected: true }), Auth: { getToken: () => 'token', isLoggedIn: () => true, logout(){} } };
            context.globalThis = context; vm.createContext(context);
            vm.runInContext(fs.readFileSync(process.argv[1], 'utf8') + '\\nglobalThis.__WebRTC = WebRTC;', context);
            const WebRTC = context.__WebRTC; WebRTC.connectionAttemptSequence = 6; WebRTC.createConnectionAttemptId = () => 'attempt-live'; WebRTC.pc = { connectionState: 'connected', iceConnectionState: 'connected', createDataChannel(){ return { readyState: 'open', on(){}, send(){} }; } }; WebRTC._mediaIntent = { generation: 99 };
            WebRTC.beginConnectionAttempt('viewer-open'); WebRTC.startVideoFrameTracking(); callback(10, { rtpTimestamp: 77 }); WebRTC.createInputChannel(); WebRTC.inputChannel.onmessage({ data: fs.readFileSync(0, 'utf8') });
            process.stdout.write(JSON.stringify({ matched: WebRTC.frameTraceCollector.takeMatched(), diagnostics: WebRTC.getFrameTraceDiagnostics() }), () => process.exit(0));
        """)
        webrtc_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "web-client", "js", "webrtc.js")
        viewer = subprocess.run(["node", "-e", viewer_script, webrtc_path], input=trace_raw,
                                text=True, capture_output=True, check=True, timeout=10)
        viewer_result = json.loads(viewer.stdout)
        self.assertEqual(viewer_result["matched"][0]["captureSeq"], 1)
        self.assertEqual(viewer_result["matched"][0]["roi"]["metadata"]["rtpTimestamp"], 77)
        self.assertEqual(viewer_result["diagnostics"]["acceptanceState"], "PENDING")


if __name__ == '__main__':
    unittest.main()
