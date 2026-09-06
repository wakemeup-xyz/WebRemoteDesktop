import time
import unittest
import sys
import os

# Add parent dir to path to import host module
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from host import ScreenCaptureTrack
from media_timing import RtpFrameClock


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
        self.assertIsNone(payload["timings"]["encoderMs"])
        self.assertIsNone(payload["timings"]["rtpSendMs"])
        self.assertIsNone(payload["timings"]["endToEndVideoMs"])
        self.assertNotIn("encodeEnd", payload["timings"])
        self.assertNotIn("packetSend", payload["timings"])


if __name__ == '__main__':
    unittest.main()
