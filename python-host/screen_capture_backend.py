"""Bounded screen-capture backends for the WebRTC capture worker.

The backend owns only the native screenshot resource.  Image conversion stays
in ``ScreenCaptureTrack``'s existing bounded processing worker so backend A/B
does not change the media or input contracts.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from mss import mss as MSS
import screeninfo


@dataclass(frozen=True)
class CaptureShot:
    raw: bytes
    width: int
    height: int


def _screeninfo_regions():
    try:
        monitors = screeninfo.get_monitors()
    except Exception:
        monitors = []
    regions = []
    for monitor in monitors:
        width = int(getattr(monitor, "width", 0) or 0)
        height = int(getattr(monitor, "height", 0) or 0)
        if width > 0 and height > 0:
            regions.append({
                "left": int(getattr(monitor, "x", 0) or 0),
                "top": int(getattr(monitor, "y", 0) or 0),
                "width": width,
                "height": height,
            })
    return regions


class MssCaptureBackend:
    name = "mss"

    def __init__(self):
        self._source = MSS()
        self.monitors = self._source.monitors

    def grab(self, monitor):
        return self._source.grab(monitor)

    def close(self):
        self._source.close()


def pack_coregraphics_bgra(data, *, row_bytes, width, height):
    """Copy a bounded CoreGraphics row layout into contiguous BGRA bytes."""
    if type(width) is not int or type(height) is not int or width <= 0 or height <= 0:
        raise ValueError("invalid CoreGraphics dimensions")
    if type(row_bytes) is not int or row_bytes < width * 4:
        raise ValueError("invalid CoreGraphics row stride")
    expected = row_bytes * height
    if len(data) < expected:
        raise ValueError("truncated CoreGraphics pixels")
    rows = np.frombuffer(data, dtype=np.uint8, count=expected).reshape(height, row_bytes)
    return np.ascontiguousarray(rows[:, :width * 4]).tobytes()


class CoreGraphicsCaptureBackend:
    name = "coregraphics"

    def __init__(self):
        import Quartz

        self._quartz = Quartz
        self.monitors = _screeninfo_regions()
        if not self.monitors:
            display = Quartz.CGMainDisplayID()
            bounds = Quartz.CGDisplayBounds(display)
            self.monitors = [{
                "left": int(bounds.origin.x), "top": int(bounds.origin.y),
                "width": int(bounds.size.width), "height": int(bounds.size.height),
            }]

    def grab(self, monitor):
        q = self._quartz
        region = q.CGRectMake(
            int(monitor.get("left", 0)), int(monitor.get("top", 0)),
            int(monitor["width"]), int(monitor["height"]),
        )
        image = q.CGWindowListCreateImage(
            region,
            q.kCGWindowListOptionOnScreenOnly,
            q.kCGNullWindowID,
            q.kCGWindowImageNominalResolution,
        )
        if image is None:
            raise RuntimeError("CoreGraphics returned no image")
        width = int(q.CGImageGetWidth(image))
        height = int(q.CGImageGetHeight(image))
        row_bytes = int(q.CGImageGetBytesPerRow(image))
        provider = q.CGImageGetDataProvider(image)
        data = bytes(q.CGDataProviderCopyData(provider))
        raw = pack_coregraphics_bgra(data, row_bytes=row_bytes, width=width, height=height)
        return CaptureShot(raw=raw, width=width, height=height)

    def close(self):
        self._quartz = None


def create_capture_backend(requested="mss"):
    name = str(requested or "mss").strip().lower()
    if name in {"", "mss"}:
        return MssCaptureBackend()
    if name == "coregraphics":
        return CoreGraphicsCaptureBackend()
    raise ValueError("unsupported capture backend")

