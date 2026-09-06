"""Relative RTP timestamps for host video tracks."""

import time

from aiortc.mediastreams import VIDEO_TIME_BASE


RTP_CLOCK_RATE = 90_000
NANOSECONDS_PER_SECOND = 1_000_000_000


class RtpFrameClock:
    """Produce strictly increasing video PTS values from a monotonic clock."""

    def __init__(self, now_ns=None):
        self._now_ns = time.monotonic_ns if now_ns is None else now_ns
        self._origin_ns = None
        self._last_pts = -1

    def next_timestamp(self):
        now_ns = self._now_ns()
        if self._origin_ns is None:
            self._origin_ns = now_ns
        elapsed_ns = max(0, now_ns - self._origin_ns)
        pts = elapsed_ns * RTP_CLOCK_RATE // NANOSECONDS_PER_SECOND
        if pts <= self._last_pts:
            pts = self._last_pts + 1
        self._last_pts = pts
        return pts, VIDEO_TIME_BASE
