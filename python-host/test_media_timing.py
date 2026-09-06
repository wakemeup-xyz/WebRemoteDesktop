import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import av
from aiortc.mediastreams import VIDEO_TIME_BASE

sys.path.insert(0, str(Path(__file__).resolve().parent))

from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy
from h264_videotoolbox_encoder import H264VideoToolboxEncoder
from media_timing import RtpFrameClock


class FakeClock:
    def __init__(self, now_ns):
        self.now_ns = now_ns

    def __call__(self):
        return self.now_ns


class RtpFrameClockTest(unittest.TestCase):
    def test_twenty_fps_uses_video_time_base_and_4500_rtp_ticks(self):
        """A 20 FPS clock change must advance one 90 kHz RTP frame interval."""
        source = FakeClock(1_000_000_000)
        clock = RtpFrameClock(now_ns=source)

        timestamps = [clock.next_timestamp()]
        for _ in range(3):
            source.now_ns += 50_000_000
            timestamps.append(clock.next_timestamp())

        self.assertEqual(
            timestamps,
            [(0, VIDEO_TIME_BASE), (4500, VIDEO_TIME_BASE), (9000, VIDEO_TIME_BASE), (13500, VIDEO_TIME_BASE)],
        )

    def test_repeated_clock_values_still_produce_strictly_increasing_pts(self):
        """A stalled monotonic source must not emit duplicate RTP timestamps."""
        source = FakeClock(1_000_000_000)
        clock = RtpFrameClock(now_ns=source)

        pts = [clock.next_timestamp()[0] for _ in range(3)]

        self.assertEqual(pts, [0, 1, 2])

    def test_wall_clock_rollback_does_not_reverse_media_time(self):
        """RTP timing must use monotonic_ns, so wall-clock changes cannot reverse it."""
        source = FakeClock(1_000_000_000)
        with patch("media_timing.time.monotonic_ns", source), patch("media_timing.time.time", side_effect=[2_000_000_000, 1]):
            clock = RtpFrameClock()
            first = clock.next_timestamp()[0]
            source.now_ns += 50_000_000
            second = clock.next_timestamp()[0]

        self.assertEqual([first, second], [0, 4500])

    def test_pause_produces_one_forward_jump_without_backfill(self):
        """A paused track resumes at one later timestamp instead of synthesizing frames."""
        source = FakeClock(1_000_000_000)
        clock = RtpFrameClock(now_ns=source)

        before_pause = clock.next_timestamp()[0]
        source.now_ns += 10_000_000_000
        after_pause = clock.next_timestamp()[0]

        self.assertEqual([before_pause, after_pause], [0, 900000])

    def test_tracks_have_independent_relative_time_origins(self):
        """A new track starts from zero even if another track has already advanced."""
        first_source = FakeClock(1_000_000_000)
        second_source = FakeClock(50_000_000_000)
        first_track = RtpFrameClock(now_ns=first_source)
        second_track = RtpFrameClock(now_ns=second_source)

        self.assertEqual(first_track.next_timestamp()[0], 0)
        first_source.now_ns += 50_000_000
        self.assertEqual(first_track.next_timestamp()[0], 4500)
        self.assertEqual(second_track.next_timestamp()[0], 0)

    def test_encoder_returns_clock_rtp_timestamps(self):
        """A real PyAV/aiortc libx264 boundary preserves the clock RTP timeline."""
        source = FakeClock(1_000_000_000)
        clock = RtpFrameClock(now_ns=source)
        policy = resolve_h264_policy(
            MediaSessionIntent("clock-test", 1, "relay", 16, 16, 20, 0),
            "relay-legacy-v1",
        )
        encoder = H264VideoToolboxEncoder(policy=policy)
        self.assertEqual(encoder.codec_name, "libx264")
        timestamps = []
        for _ in range(4):
            frame = av.VideoFrame(width=16, height=16, format="yuv420p")
            frame.pts, frame.time_base = clock.next_timestamp()
            timestamps.append(encoder.encode(frame)[1])
            source.now_ns += 50_000_000

        self.assertEqual(timestamps, [0, 4500, 9000, 13500])


if __name__ == "__main__":
    unittest.main()
