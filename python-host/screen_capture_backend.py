"""Bounded screen-capture backends for the WebRTC capture worker.

The backend owns only the native screenshot resource.  Image conversion stays
in ``ScreenCaptureTrack``'s existing bounded processing worker so backend A/B
does not change the media or input contracts.
"""

from __future__ import annotations

import ctypes
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


class _CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]


class _CGSize(ctypes.Structure):
    _fields_ = [("width", ctypes.c_double), ("height", ctypes.c_double)]


class _CGRect(ctypes.Structure):
    _fields_ = [("origin", _CGPoint), ("size", _CGSize)]


class CoreGraphicsCaptureBackend:
    name = "coregraphics"

    def __init__(self):
        # The PyObjC wrappers for CGImage/CFData do not provide a reliable
        # per-frame ownership boundary here: copying one full-screen image
        # per frame makes the Host RSS grow without bound.  Use the C APIs so
        # every Create/Copy object is released in the same call.
        self._cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
        self._cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        self._configure_api()
        self.monitors = _screeninfo_regions()
        if not self.monitors:
            display = self._cg.CGMainDisplayID()
            bounds = self._cg.CGDisplayBounds(display)
            self.monitors = [{
                "left": int(bounds.origin.x), "top": int(bounds.origin.y),
                "width": int(bounds.size.width), "height": int(bounds.size.height),
            }]

    def _configure_api(self):
        cg, cf = self._cg, self._cf
        cg.CGWindowListCreateImage.argtypes = [_CGRect, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32]
        cg.CGWindowListCreateImage.restype = ctypes.c_void_p
        cg.CGImageGetWidth.argtypes = [ctypes.c_void_p]
        cg.CGImageGetWidth.restype = ctypes.c_size_t
        cg.CGImageGetHeight.argtypes = [ctypes.c_void_p]
        cg.CGImageGetHeight.restype = ctypes.c_size_t
        cg.CGImageGetBytesPerRow.argtypes = [ctypes.c_void_p]
        cg.CGImageGetBytesPerRow.restype = ctypes.c_size_t
        cg.CGImageGetDataProvider.argtypes = [ctypes.c_void_p]
        cg.CGImageGetDataProvider.restype = ctypes.c_void_p
        cg.CGDataProviderCopyData.argtypes = [ctypes.c_void_p]
        cg.CGDataProviderCopyData.restype = ctypes.c_void_p
        cg.CGMainDisplayID.argtypes = []
        cg.CGMainDisplayID.restype = ctypes.c_uint32
        cg.CGDisplayBounds.argtypes = [ctypes.c_uint32]
        cg.CGDisplayBounds.restype = _CGRect
        cf.CFDataGetLength.argtypes = [ctypes.c_void_p]
        cf.CFDataGetLength.restype = ctypes.c_long
        cf.CFDataGetBytePtr.argtypes = [ctypes.c_void_p]
        cf.CFDataGetBytePtr.restype = ctypes.POINTER(ctypes.c_ubyte)
        cf.CFRelease.argtypes = [ctypes.c_void_p]
        cf.CFRelease.restype = None

    def grab(self, monitor):
        cg, cf = self._cg, self._cf
        region = _CGRect(
            _CGPoint(int(monitor.get("left", 0)), int(monitor.get("top", 0))),
            _CGSize(int(monitor["width"]), int(monitor["height"])),
        )
        image = cg.CGWindowListCreateImage(region, 1, 0, 0)
        if not image:
            raise RuntimeError("CoreGraphics returned no image")
        copied = None
        try:
            width = int(cg.CGImageGetWidth(image))
            height = int(cg.CGImageGetHeight(image))
            row_bytes = int(cg.CGImageGetBytesPerRow(image))
            provider = cg.CGImageGetDataProvider(image)
            copied = cg.CGDataProviderCopyData(provider)
            if not copied:
                raise RuntimeError("CoreGraphics returned no pixel data")
            length = int(cf.CFDataGetLength(copied))
            pointer = cf.CFDataGetBytePtr(copied)
            data = ctypes.string_at(pointer, length)
            raw = pack_coregraphics_bgra(data, row_bytes=row_bytes, width=width, height=height)
            return CaptureShot(raw=raw, width=width, height=height)
        finally:
            if copied:
                cf.CFRelease(copied)
            cf.CFRelease(image)

    def close(self):
        self._cg = None
        self._cf = None


def create_capture_backend(requested="mss"):
    name = str(requested or "mss").strip().lower()
    if name in {"", "mss"}:
        return MssCaptureBackend()
    if name == "coregraphics":
        return CoreGraphicsCaptureBackend()
    raise ValueError("unsupported capture backend")

