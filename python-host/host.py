#!/usr/bin/env python3
"""
Python-based macOS Host for Web Remote Desktop
Captures screen using MSS and streams via aiortc (WebRTC)
"""

import asyncio
import json
import socketio
import requests
import sys
import threading
import time
import re
import subprocess
import io
import os
import resource
import sys
from mss import mss as MSS
import numpy as np
import av
from av import VideoFrame
from PIL import Image
try:
    import cv2
    HAS_CV2 = True
except ImportError:
    cv2 = None
    HAS_CV2 = False
from aiortc import RTCPeerConnection, RTCSessionDescription, VideoStreamTrack, RTCConfiguration, RTCIceServer
import logging
from concurrent.futures import ThreadPoolExecutor
import screeninfo
from input_handler import InputHandler
from h264_videotoolbox_encoder import H264VideoToolboxEncoder
from observability import configure_host_logging, emit_host_event, summarize_input_event

if __name__ == "__main__":
    configure_host_logging()
else:
    logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Monkey-patch aiortc to use VideoToolbox hardware encoder for H.264
try:
    import aiortc.codecs as _aiortc_codecs
    import aiortc.rtcrtpsender as _aiortc_rtcrtpsender
    _original_get_encoder = _aiortc_codecs.get_encoder

    def _patched_get_encoder(codec):
        if codec.mimeType.lower() == "video/h264":
            logger.info("Using custom H.264 encoder for negotiated codec: %s", codec)
            return H264VideoToolboxEncoder()
        logger.info("Using aiortc default encoder for negotiated codec: %s", codec)
        return _original_get_encoder(codec)

    _aiortc_codecs.get_encoder = _patched_get_encoder
    _aiortc_rtcrtpsender.get_encoder = _patched_get_encoder

    # Reorder video codecs so H.264 is preferred over VP8 in SDP negotiation
    video_codecs = _aiortc_codecs.CODECS["video"]
    h264_codecs = [c for c in video_codecs if c.mimeType == "video/H264"]
    h264_rtx = [c for c in video_codecs if c.mimeType == "video/rtx" and c.parameters.get("apt") in {c.payloadType for c in h264_codecs}]
    vp8_codecs = [c for c in video_codecs if c.mimeType == "video/VP8"]
    vp8_rtx = [c for c in video_codecs if c.mimeType == "video/rtx" and c not in h264_rtx]
    video_codecs[:] = h264_codecs + h264_rtx + vp8_codecs + vp8_rtx

    logger.info("Patched aiortc H.264 encoder to use VideoToolbox and reordered codecs")
except Exception as e:
    logger.warning(f"Failed to patch VideoToolbox encoder: {e}")

# Monkey-patch aioice consent timeout: increase tolerance for system load spikes.
# Default CONSENT_FAILURES=6 × CONSENT_INTERVAL=5s = 30s timeout.
# Under load the event loop may not process STUN responses in time.
# Increase to 12 failures × ~4s interval = ~48s effective timeout.
try:
    import aioice.ice as _aioice_ice
    _aioice_ice.CONSENT_FAILURES = 12
    _aioice_ice.CONSENT_INTERVAL = 4
    logger.info("Patched aioice consent: failures=%d interval=%ds (effective timeout ~%ds)",
                _aioice_ice.CONSENT_FAILURES, _aioice_ice.CONSENT_INTERVAL,
                _aioice_ice.CONSENT_FAILURES * _aioice_ice.CONSENT_INTERVAL)
except Exception as e:
    logger.warning(f"Failed to patch aioice consent timeout: {e}")

# Monkey-patch aioice Transaction.__retry: when the underlying UDP transport
# is closed (e.g. PC teardown), retry timers fire on a dead socket and spam
# the logs with uncaught exceptions. Cancel the timer and fail the future
# gracefully instead of leaving orphaned retry callbacks.
try:
    import aioice.stun as _aioice_stun
    _original_tx_retry = _aioice_stun.Transaction._Transaction__retry

    def _patched_tx_retry(self):
        try:
            _original_tx_retry(self)
        except Exception as exc:
            handle = getattr(self, '_Transaction__timeout_handle', None)
            if handle:
                handle.cancel()
            future = getattr(self, '_Transaction__future', None)
            if future and not future.done():
                future.set_exception(exc)

    _aioice_stun.Transaction._Transaction__retry = _patched_tx_retry
    logger.info("Patched aioice Transaction.__retry to handle closed transports gracefully")
except Exception as e:
    logger.warning(f"Failed to patch aioice Transaction.__retry: {e}")

# Configuration
SERVER_URL = os.environ.get('SERVER_URL', "http://127.0.0.1:8080")
HOST_SHARED_SECRET = os.environ.get('HOST_SHARED_SECRET') or os.environ.get('HOST_PASSWORD', '')

MEDIA_PROFILE_DEFAULT = {
    "profile": "high",
    "width": 1280,
    "height": 720,
    "target_fps": 20,
    "video_bitrate_kbps": 2500,
}

TUNNEL_RELAY_PROFILE_ORDER = ["high", "medium", "low", "survival"]
TUNNEL_RELAY_PROFILES = {
    "high": {
        "name": "high",
        "width": 1280,
        "height": 720,
        "fps": 8,
        "jpeg_quality": 30,
        "max_in_flight_frames": 2,
    },
    "medium": {
        "name": "medium",
        "width": 960,
        "height": 540,
        "fps": 6,
        "jpeg_quality": 26,
        "max_in_flight_frames": 2,
    },
    "low": {
        "name": "low",
        "width": 854,
        "height": 480,
        "fps": 4,
        "jpeg_quality": 22,
        "max_in_flight_frames": 1,
    },
    "survival": {
        "name": "survival",
        "width": 640,
        "height": 360,
        "fps": 2,
        "jpeg_quality": 18,
        "max_in_flight_frames": 1,
    },
}


def should_verify_tls(server_url: str) -> bool:
    from urllib.parse import urlparse

    if os.environ.get("WRD_INSECURE_SKIP_TLS_VERIFY") != "1":
        return True
    host = urlparse(server_url).hostname or ""
    return host not in {"127.0.0.1", "localhost"}


def split_env_list(value):
    return [item.strip() for item in str(value or "").split(",") if item.strip()]


def is_strict_stun_policy():
    media_policy = (os.environ.get("WRD_MEDIA_POLICY") or os.environ.get("MEDIA_POLICY") or "").strip().lower()
    if not media_policy:
        return True
    return media_policy == "strict-stun"


def format_diag_value(value):
    if isinstance(value, (dict, list, tuple)):
        try:
            return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        except Exception:
            return str(value)
    return str(value) if value is not None else "-"


def clamp_int(value, minimum, maximum, fallback):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, parsed))


def build_ice_servers():
    """Build Host ICE config from env so external viewers can use TURN relay."""
    ice_servers = []
    stun_urls = split_env_list(
        os.environ.get("STUN_URLS", "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302")
    )
    if stun_urls:
        ice_servers.append(RTCIceServer(urls=stun_urls))

    turn_urls = split_env_list(os.environ.get("TURN_URLS"))
    turn_username = os.environ.get("TURN_USERNAME")
    turn_credential = os.environ.get("TURN_CREDENTIAL")
    if turn_urls and is_strict_stun_policy():
        logger.warning(
            "WRD_POLICY_WARNING turn_ignored_strict_stun turn_urls=%s",
            ",".join(turn_urls),
        )
    elif turn_urls and turn_username and turn_credential:
        ice_servers.append(
            RTCIceServer(
                urls=turn_urls,
                username=turn_username,
                credential=turn_credential,
            )
        )
        logger.info("TURN relay configured for Host ICE: %s", ",".join(turn_urls))
    elif turn_urls:
        logger.warning("TURN_URLS is set but TURN_USERNAME/TURN_CREDENTIAL is missing; TURN disabled")

    return ice_servers


def _monitor_value(monitor, key):
    if isinstance(monitor, dict):
        return monitor.get(key)
    return getattr(monitor, key, None)


def normalize_monitor_region(monitor):
    width = int(_monitor_value(monitor, "width") or 0)
    height = int(_monitor_value(monitor, "height") or 0)
    if width <= 0 or height <= 0:
        return None
    return {
        "left": int(_monitor_value(monitor, "left") if _monitor_value(monitor, "left") is not None else _monitor_value(monitor, "x") or 0),
        "top": int(_monitor_value(monitor, "top") if _monitor_value(monitor, "top") is not None else _monitor_value(monitor, "y") or 0),
        "width": width,
        "height": height,
    }


def is_valid_monitor_region(monitor):
    return normalize_monitor_region(monitor) is not None


def select_capture_monitor(monitors, fallback_monitors=None):
    if not monitors:
        raise RuntimeError("No monitors reported by MSS")

    candidates = list(monitors[1:] if len(monitors) > 1 else monitors)
    for monitor in candidates:
        normalized = normalize_monitor_region(monitor)
        if normalized:
            return normalized

    for monitor in monitors:
        normalized = normalize_monitor_region(monitor)
        if normalized:
            return normalized

    for monitor in fallback_monitors or []:
        normalized = normalize_monitor_region(monitor)
        if normalized:
            logger.warning("MSS reported only zero-sized monitors; using screeninfo fallback: %s", normalized)
            return normalized

    raise RuntimeError(f"No usable monitor reported by MSS: {monitors!r}")


def get_screeninfo_monitors():
    try:
        return screeninfo.get_monitors()
    except Exception as exc:
        logger.warning("Failed to read screeninfo monitors for fallback: %s", exc)
        return []


class OverlayNotifier:
    def __init__(self):
        self.proc = None
        self._lock = threading.Lock()
        self._start()

    def _start(self):
        if os.environ.get("WRD_DISABLE_OVERLAY") == "1":
            return
        try:
            script = os.path.join(os.path.dirname(__file__), "overlay_window.py")
            self.proc = subprocess.Popen(
                [sys.executable, script],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=open("/tmp/wrd-overlay.log", "a", encoding="utf-8"),
                text=True,
                bufsize=1,
            )
            logger.info("Started host overlay window")
        except Exception as e:
            logger.warning(f"Failed to start host overlay window: {e}")
            self.proc = None

    def send(self, event):
        if not self.proc or not self.proc.stdin or self.proc.poll() is not None:
            return
        try:
            with self._lock:
                self.proc.stdin.write(json.dumps(event, ensure_ascii=False) + "\n")
                self.proc.stdin.flush()
        except Exception as e:
            logger.debug(f"Failed to send overlay event: {e}")

    def stop(self):
        if not self.proc:
            return
        try:
            self.proc.terminate()
        except Exception:
            pass


class TunnelRelayStreamer:
    """Low-FPS JPEG stream over Socket.IO/Cloudflare for networks where WebRTC ICE fails."""

    def __init__(self, sio):
        self.sio = sio
        self.task = None
        self.viewer_id = None
        self.enabled = False
        self.width = 960
        self.height = 540
        self.fps = 8
        self.profile_name = "medium"
        self.jpeg_quality = 26
        self.frame_id = 0
        self.ack_event = asyncio.Event()
        self.last_acked_frame_id = 0
        self.inflight_frames = {}
        self.stats_started_at = time.time()
        self.stats_frames = 0
        self.stats_acked = 0
        self.stats_bytes = 0
        self.stats_encode_ms = 0.0
        self.stats_ack_latency_ms = 0.0
        self.stats_ack_samples = 0
        self.stats_timeout_count = 0
        self.good_ack_streak = 0
        self.last_ack_latency_ms = None
        self.max_in_flight_frames = 2
        self._apply_profile("medium", reason="init", log=False)

    def _profile_spec(self, profile_name):
        return TUNNEL_RELAY_PROFILES.get(profile_name) or TUNNEL_RELAY_PROFILES["medium"]

    def _profile_index(self, profile_name):
        try:
            return TUNNEL_RELAY_PROFILE_ORDER.index(profile_name)
        except ValueError:
            return TUNNEL_RELAY_PROFILE_ORDER.index("medium")

    def _pick_initial_profile(self, width, height, fps):
        width = int(width or 0)
        height = int(height or 0)
        fps = int(fps or 0)
        if width >= 1200 or height >= 680 or fps >= 8:
            return "high"
        if width >= 900 or height >= 500 or fps >= 6:
            return "medium"
        if width >= 760 or height >= 420 or fps >= 4:
            return "low"
        return "survival"

    def _apply_profile(self, profile_name, reason, log=True):
        spec = self._profile_spec(profile_name)
        next_name = spec["name"]
        changed = next_name != self.profile_name
        self.profile_name = next_name
        self.width = spec["width"]
        self.height = spec["height"]
        self.fps = spec["fps"]
        self.jpeg_quality = spec["jpeg_quality"]
        self.max_in_flight_frames = spec["max_in_flight_frames"]
        if log and (changed or reason != "init"):
            logger.info(
                "TUNNEL_RELAY_PROFILE viewer=%s profile=%s size=%sx%s fps=%s quality=%s max_in_flight=%s reason=%s",
                self.viewer_id,
                self.profile_name,
                self.width,
                self.height,
                self.fps,
                self.jpeg_quality,
                self.max_in_flight_frames,
                reason,
            )
        return changed

    def step_down_profile(self, reason):
        current = self._profile_index(self.profile_name)
        next_index = min(len(TUNNEL_RELAY_PROFILE_ORDER) - 1, current + 1)
        return self._apply_profile(TUNNEL_RELAY_PROFILE_ORDER[next_index], reason)

    def step_up_profile(self, reason):
        current = self._profile_index(self.profile_name)
        next_index = max(0, current - 1)
        return self._apply_profile(TUNNEL_RELAY_PROFILE_ORDER[next_index], reason)

    def pending_frame_count(self):
        return len(self.inflight_frames)

    def should_wait_before_capture(self):
        return self.pending_frame_count() >= self.max_in_flight_frames

    def _record_ack_feedback(self, latency_ms):
        try:
            latency_ms = float(latency_ms)
        except (TypeError, ValueError):
            return

        self.last_ack_latency_ms = max(0.0, latency_ms)
        self.stats_ack_latency_ms += self.last_ack_latency_ms
        self.stats_ack_samples += 1

        pending = self.pending_frame_count()
        if self.last_ack_latency_ms >= 1000 or pending >= self.max_in_flight_frames:
            self.good_ack_streak = 0
            self.step_down_profile(f"ack-latency-{int(self.last_ack_latency_ms)}ms")
            return

        if self.last_ack_latency_ms <= 250 and pending <= 1:
            self.good_ack_streak += 1
            if self.good_ack_streak >= 4:
                self.good_ack_streak = 0
                self.step_up_profile(f"stable-ack-{int(self.last_ack_latency_ms)}ms")
        else:
            self.good_ack_streak = 0

    async def start(self, viewer_id, width=960, height=540, fps=8):
        await self.stop()
        self.viewer_id = viewer_id
        self._apply_profile(self._pick_initial_profile(width, height, fps), reason="start", log=False)
        self.frame_id = 0
        self.last_acked_frame_id = 0
        self.inflight_frames = {}
        self.ack_event.clear()
        self.stats_started_at = time.time()
        self.stats_frames = 0
        self.stats_acked = 0
        self.stats_bytes = 0
        self.stats_encode_ms = 0.0
        self.stats_ack_latency_ms = 0.0
        self.stats_ack_samples = 0
        self.stats_timeout_count = 0
        self.good_ack_streak = 0
        self.last_ack_latency_ms = None
        self.enabled = True
        self.task = asyncio.create_task(self._run())
        logger.info(
            "Tunnel relay stream started viewer=%s profile=%s size=%sx%s fps=%s quality=%s max_in_flight=%s",
            self.viewer_id,
            self.profile_name,
            self.width,
            self.height,
            self.fps,
            self.jpeg_quality,
            self.max_in_flight_frames,
        )

    async def stop(self):
        self.enabled = False
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
            self.task = None

    def ack(self, frame_id, latency_ms=None):
        try:
            frame_id = int(frame_id)
        except Exception:
            return
        if frame_id > self.last_acked_frame_id:
            frame_meta = self.inflight_frames.pop(frame_id, None)
            self.last_acked_frame_id = frame_id
            self.stats_acked += 1
            self.ack_event.set()
            measured_ms = latency_ms
            if measured_ms is None and frame_meta and frame_meta.get("sent_at_ms") is not None:
                measured_ms = time.monotonic() * 1000.0 - frame_meta["sent_at_ms"]
            if measured_ms is not None:
                self._record_ack_feedback(measured_ms)

    def note_ack_timeout(self, reason):
        self.stats_timeout_count += 1
        self.good_ack_streak = 0
        self.step_down_profile(reason)

    def should_wait_for_ack(self):
        return (self.frame_id - self.last_acked_frame_id) > self.max_in_flight_frames

    async def _run(self):
        with MSS() as sct:
            monitor = select_capture_monitor(sct.monitors, fallback_monitors=get_screeninfo_monitors())
            while self.enabled and self.viewer_id:
                frame_interval = 1 / max(1, self.fps)
                ack_timeout = max(0.35, min(1.5, frame_interval * 4))
                if self.should_wait_before_capture():
                    try:
                        await asyncio.wait_for(self.ack_event.wait(), timeout=ack_timeout)
                        self.ack_event.clear()
                        continue
                    except asyncio.TimeoutError:
                        self.ack_event.clear()
                        logger.debug(
                            "Tunnel relay backpressure timeout viewer=%s pending=%s profile=%s",
                            self.viewer_id,
                            self.pending_frame_count(),
                            self.profile_name,
                        )
                        self.note_ack_timeout("pre-capture-backpressure")
                        continue

                started = time.time()
                try:
                    shot = sct.grab(monitor)
                    # Fast path: numpy stride downsample then PIL JPEG encode
                    img = np.array(shot)  # BGRA
                    h, w = img.shape[:2]
                    # Pick integer stride factor for fast downsample
                    factor = 1
                    for f in (2, 3, 4):
                        if w // f <= self.width and h // f <= self.height:
                            factor = f
                            break
                    if factor > 1:
                        img = img[::factor, ::factor]
                    # Convert BGRA to RGB for JPEG
                    rgb = img[:, :, 2::-1]
                    image = Image.fromarray(rgb)
                    buffer = io.BytesIO()
                    image.save(buffer, format="JPEG", quality=self.jpeg_quality, optimize=False, subsampling=2)
                    jpeg_bytes = buffer.getvalue()
                    encode_ms = (time.time() - started) * 1000
                    self.frame_id += 1
                    frame_id = self.frame_id
                    sent_at_ms = time.monotonic() * 1000.0
                    self.inflight_frames[frame_id] = {
                        "sent_at_ms": sent_at_ms,
                        "profile": self.profile_name,
                        "quality": self.jpeg_quality,
                        "width": image.width,
                        "height": image.height,
                    }
                    try:
                        await self.sio.emit("relay-frame", {
                            "viewerId": self.viewer_id,
                            "frameId": frame_id,
                            "width": image.width,
                            "height": image.height,
                            "timestamp": int(time.time() * 1000),
                            "mime": "image/jpeg",
                            "bytes": len(jpeg_bytes),
                            "profile": self.profile_name,
                            "quality": self.jpeg_quality,
                            "maxInFlightFrames": self.max_in_flight_frames,
                            "data": jpeg_bytes,
                        })
                        self.stats_frames += 1
                        self.stats_bytes += len(jpeg_bytes)
                        self.stats_encode_ms += encode_ms
                    except Exception:
                        self.inflight_frames.pop(frame_id, None)
                        raise
                except asyncio.TimeoutError:
                    logger.debug("Tunnel relay frame ack timeout viewer=%s frame=%s", self.viewer_id, self.frame_id)
                    self.note_ack_timeout("post-send-backpressure")
                except Exception as e:
                    logger.warning(f"Tunnel relay frame failed: {e}")

                elapsed = time.time() - started
                now = time.time()
                if now - self.stats_started_at >= 5:
                    duration = max(0.001, now - self.stats_started_at)
                    avg_kb = (self.stats_bytes / max(1, self.stats_frames)) / 1024
                    avg_encode = self.stats_encode_ms / max(1, self.stats_frames)
                    avg_ack_latency = self.stats_ack_latency_ms / max(1, self.stats_ack_samples)
                    logger.info(
                        "TUNNEL_RELAY_STATS viewer=%s profile=%s fps=%.1f sent=%s acked=%s pending=%s timeouts=%s avg_kb=%.1f avg_encode_ms=%.1f avg_ack_ms=%.1f size=%sx%s quality=%s max_in_flight=%s",
                        self.viewer_id,
                        self.profile_name,
                        self.stats_frames / duration,
                        self.stats_frames,
                        self.stats_acked,
                        self.pending_frame_count(),
                        self.stats_timeout_count,
                        avg_kb,
                        avg_encode,
                        avg_ack_latency,
                        self.width,
                        self.height,
                        self.jpeg_quality,
                        self.max_in_flight_frames,
                    )
                    self.stats_started_at = now
                    self.stats_frames = 0
                    self.stats_acked = 0
                    self.stats_bytes = 0
                    self.stats_encode_ms = 0.0
                    self.stats_ack_latency_ms = 0.0
                    self.stats_ack_samples = 0
                    self.stats_timeout_count = 0
                await asyncio.sleep(max(0.001, frame_interval - elapsed))


def format_keyboard_command(action, payload):
    key = payload.get("key") or payload.get("code") or ""
    mods = payload.get("modifiers") or {}
    parts = []
    if mods.get("meta"):
        parts.append("⌘")
    if mods.get("ctrl"):
        parts.append("Ctrl")
    if mods.get("alt"):
        parts.append("⌥")
    if mods.get("shift"):
        parts.append("⇧")

    if key in ("Meta", "Control", "Alt", "Shift"):
        if key == "Meta":
            key = "⌘"
        elif key == "Alt":
            key = "⌥"
        elif key == "Shift":
            key = "⇧"
    elif len(key) == 1:
        key = key.upper()

    command = "+".join(parts + ([key] if key else []))
    arrow = "↓" if action == "keydown" else "↑"
    return f"{arrow}{command or key}"


def parse_ice_candidate(candidate_str):
    """Parse ICE candidate string into components for RTCIceCandidate"""
    try:
        if candidate_str.startswith('candidate:'):
            candidate_str = candidate_str[10:]

        parts = candidate_str.split()
        if len(parts) < 7:
            return None

        foundation = parts[0]
        component = int(parts[1])
        protocol = parts[2]
        priority = int(parts[3])
        ip = parts[4]
        port = int(parts[5])
        type_ = parts[7] if len(parts) > 7 else 'host'

        relatedAddress = None
        relatedPort = None
        if 'raddr' in parts:
            raddr_idx = parts.index('raddr')
            if raddr_idx + 1 < len(parts):
                relatedAddress = parts[raddr_idx + 1]
        if 'rport' in parts:
            rport_idx = parts.index('rport')
            if rport_idx + 1 < len(parts):
                try:
                    relatedPort = int(parts[rport_idx + 1])
                except:
                    pass

        # Replace mDNS with localhost
        if '.local' in ip:
            ip = '127.0.0.1'

        return {
            'foundation': foundation,
            'component': component,
            'protocol': protocol,
            'priority': priority,
            'ip': ip,
            'port': port,
            'type': type_,
            'relatedAddress': relatedAddress,
            'relatedPort': relatedPort
        }
    except Exception as e:
        logger.error(f"Failed to parse ICE candidate: {e}")
        return None


class ScreenCaptureTrack(VideoStreamTrack):
    """Captures screen using MSS library with continuous background capture."""

    kind = "video"

    def __init__(self, target_fps=20, max_width=1280, max_height=720):
        super().__init__()
        self.sct = MSS()
        self.monitor = select_capture_monitor(self.sct.monitors, fallback_monitors=get_screeninfo_monitors())
        self.frame_count = 0
        self.last_time = time.time()
        self._start = time.time()
        self._last_frame_time = 0
        self._target_fps = target_fps
        self._frame_interval = 1.0 / target_fps
        self._max_width = max_width
        self._max_height = max_height
        self._target_lock = threading.Lock()
        self._pending_input_ids = set()
        self._pending_input_data = []
        self._pending_input_lock = threading.Lock()
        self._timing_seq = 0
        self._process_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="imgproc")
        self._timing_totals = {
            "sleep": 0.0,
            "capture_wait": 0.0,
            "convert": 0.0,
            "total": 0.0,
        }
        self._timing_count = 0
        self._ps_count = 0

        # Continuous background capture: thread runs sct.grab() in a loop,
        # main thread reads latest screenshot without blocking.
        self._capture_lock = threading.Lock()
        self._capture_buffer = None
        self._capture_seq = 0
        self._last_consumed_seq = -1
        self._capture_running = True
        self._capture_thread = threading.Thread(target=self._capture_loop, daemon=True)
        self._capture_thread.start()

        # Cache last processed frame for reuse when capture starves
        self._last_img = None
        self._last_img_shape = (0, 0)
        self._reuse_count = 0
        self._total_reuse = 0

        # Capture thread timing
        self._capture_total_time = 0.0
        self._capture_total_count = 0
        self._capture_last_log = time.time()

        logger.info(
            "ScreenCaptureTrack initialized: %s, target_fps=%s, max_resolution=%sx%s, cv2=%s",
            self.monitor,
            target_fps,
            max_width,
            max_height,
            HAS_CV2,
        )
        self._host_ref = None

    def _capture_loop(self):
        """Continuously capture screenshots in background thread.
        Capture pacing follows the current media profile to avoid wasted work."""
        while self._capture_running:
            with self._target_lock:
                target_fps = self._target_fps
            _min_interval = 1.0 / self.capture_fps_for_target(target_fps)
            t0 = time.perf_counter()
            try:
                shot = self.sct.grab(self.monitor)
                with self._capture_lock:
                    self._capture_buffer = shot
                    self._capture_seq += 1
            except Exception:
                time.sleep(0.005)
                continue
            elapsed = time.perf_counter() - t0
            sleep_time = max(0.0, _min_interval - elapsed)
            if sleep_time > 0.001:
                time.sleep(sleep_time)

    async def shutdown(self):
        """Async shutdown: never blocks the event loop."""
        self._capture_running = False
        if self._capture_thread and self._capture_thread.is_alive():
            try:
                await asyncio.to_thread(self._capture_thread.join, timeout=2.0)
            except Exception:
                pass
        self._process_executor.shutdown(wait=False)
        if self.sct:
            try:
                await asyncio.to_thread(self.sct.close)
            except Exception:
                pass

    async def next_timestamp(self):
        pts = int((time.time() - self._start) * 90000)
        return pts, 90000

    async def recv(self):
        loop = asyncio.get_event_loop()
        recv_start = time.perf_counter()
        sleep_time = 0.0

        # Frame-rate control
        now = time.time()
        elapsed = now - self._last_frame_time
        if elapsed < self._frame_interval:
            sleep_time = self._frame_interval - elapsed
            await asyncio.sleep(sleep_time)
        self._last_frame_time = time.time()

        capture_prepare_start = time.perf_counter()

        # Zero-wait: grab latest capture from background thread
        with self._capture_lock:
            screenshot = self._capture_buffer
            seq = self._capture_seq
            self._capture_buffer = None

        capture_wait = 0.0  # never block — capture runs independently

        if screenshot is not None and seq != self._last_consumed_seq:
            # Fresh frame available: process it
            self._last_consumed_seq = seq
            try:
                img = await loop.run_in_executor(
                    self._process_executor,
                    self._process_screenshot,
                    screenshot
                )
                if isinstance(img, np.ndarray) and img.ndim == 3 and img.shape[2] >= 3:
                    self._last_img = img
                    self._last_img_shape = img.shape[:2]
                    self._reuse_count = 0
                else:
                    img = self._last_img
            except Exception:
                img = self._last_img
                self._reuse_count += 1
        elif self._last_img is not None:
            # Capture starving: reuse last frame (copy to avoid corrupting encoder buffer)
            img = self._last_img.copy()
            self._reuse_count += 1
            self._total_reuse += 1
        else:
            img = np.zeros((self._max_height, self._max_width, 4), dtype=np.uint8)

        capture_prepare_ms = (time.perf_counter() - capture_prepare_start) * 1000

        # Validate frame data
        if not isinstance(img, np.ndarray) or img.ndim != 3 or img.shape[2] < 3:
            img = np.zeros((self._max_height, self._max_width, 4), dtype=np.uint8)

        convert_start = time.perf_counter()
        try:
            if img.shape[2] == 4:
                frame = av.VideoFrame.from_ndarray(img, format="bgra")
            else:
                bgr = np.ascontiguousarray(img[:, :, :3], dtype=np.uint8)
                frame = av.VideoFrame.from_ndarray(bgr[:, :, ::-1], format="rgb24")
        except Exception as e:
            logger.error(f"Frame conversion failed: {e}")
            frame = av.VideoFrame.from_ndarray(
                np.zeros((self._max_height, self._max_width, 4), dtype=np.uint8),
                format="bgra",
            )
        pts, time_base = await self.next_timestamp()
        frame.pts = pts
        frame.time_base = time_base
        convert_time = time.perf_counter() - convert_start
        total_time = time.perf_counter() - recv_start

        self._timing_totals["sleep"] += sleep_time
        self._timing_totals["capture_wait"] += capture_wait
        self._timing_totals["convert"] += convert_time
        self._timing_totals["total"] += total_time
        self._timing_count += 1

        self.frame_count += 1
        current_time = time.time()
        if current_time - self.last_time >= 5:
            fps = self.frame_count / (current_time - self.last_time)
            if self._timing_count:
                avg = {
                    key: value / self._timing_count * 1000
                    for key, value in self._timing_totals.items()
                }
                logger.info(
                    "CAPTURE_STATS fps=%.1f frames=%d avg_ms sleep=%.1f capture_wait=%.1f convert=%.1f recv_total=%.1f frame=%dx%d reuse=%d",
                    fps,
                    self.frame_count,
                    avg["sleep"],
                    avg["capture_wait"],
                    avg["convert"],
                    avg["total"],
                    frame.width,
                    frame.height,
                    self._total_reuse,
                )
                for key in self._timing_totals:
                    self._timing_totals[key] = 0.0
                self._timing_count = 0
            else:
                logger.info(f"FPS: {fps:.1f} ({self.frame_count} frames)")
            self.frame_count = 0
            self.last_time = current_time
            self._total_reuse = 0

            # Send capture stats to viewer via DataChannel for FPS/latency display
            host = getattr(self, '_host_ref', None)
            if host is not None:
                dc = host.get_input_datachannel()
                if dc is not None and hasattr(dc, 'send'):
                    try:
                        dc.send(json.dumps({
                            "type": "capture_stats",
                            "fps": round(fps, 1),
                            "width": frame.width,
                            "height": frame.height,
                            "reuse": self._total_reuse,
                        }))
                    except Exception:
                        pass

        self._send_frame_timing(
            capture_prepare_ms=capture_prepare_ms,
            frame_convert_ms=convert_time * 1000,
        )

        return frame

    def _send_frame_timing(self, *, capture_prepare_ms, frame_convert_ms):
        host = getattr(self, '_host_ref', None)
        if host is None:
            return
        dc = host.get_input_datachannel()
        if dc is None or not hasattr(dc, 'send'):
            return

        with self._pending_input_lock:
            input_ids = list(self._pending_input_ids)
            self._pending_input_ids.clear()
            input_data_list = list(self._pending_input_data)
            self._pending_input_data.clear()

        timing = {
            "type": "frame_timing",
            "schemaVersion": 2,
            "frameId": self._timing_seq,
            "timings": {
                "capturePrepareMs": round(float(capture_prepare_ms), 3),
                "frameConvertMs": round(float(frame_convert_ms), 3),
                "encoderMs": None,
                "rtpSendMs": None,
                "endToEndVideoMs": None,
            },
        }
        if input_ids:
            timing["inputIds"] = input_ids
        if input_data_list:
            timing["inputs"] = input_data_list

        self._timing_seq += 1
        try:
            dc.send(json.dumps(timing))
        except Exception as e:
            logger.debug("Frame timing send failed: %s", e)

    def set_max_resolution(self, width, height):
        ABSOLUTE_MAX_WIDTH = 1920
        ABSOLUTE_MAX_HEIGHT = 1080
        width = max(320, min(int(width), self.monitor["width"], ABSOLUTE_MAX_WIDTH))
        height = max(180, min(int(height), self.monitor["height"], ABSOLUTE_MAX_HEIGHT))
        with self._target_lock:
            self._max_width = width
            self._max_height = height
        logger.info("Screen stream max resolution set to %sx%s (requested capped at %sx%s, monitor=%sx%s)",
                    width, height, ABSOLUTE_MAX_WIDTH, ABSOLUTE_MAX_HEIGHT,
                    self.monitor["width"], self.monitor["height"])

    def set_target_fps(self, target_fps):
        target_fps = max(5, min(int(target_fps), 30))
        with self._target_lock:
            self._target_fps = target_fps
            self._frame_interval = 1.0 / target_fps
        logger.info("Screen stream target FPS set to %s", target_fps)

    @staticmethod
    def capture_fps_for_target(target_fps):
        target_fps = max(1, int(target_fps))
        return min(60, max(target_fps * 2, target_fps + 5))

    def apply_media_profile(self, profile):
        self.set_max_resolution(profile["width"], profile["height"])
        self.set_target_fps(profile["target_fps"])

    def _scale_image_array(self, img):
        with self._target_lock:
            max_width = self._max_width
            max_height = self._max_height

        height, width = img.shape[:2]
        if width <= max_width and height <= max_height:
            return img

        scale = min(max_width / width, max_height / height)
        scaled_width = max(2, int(width * scale) // 2 * 2)
        scaled_height = max(2, int(height * scale) // 2 * 2)

        if HAS_CV2:
            return cv2.resize(img, (scaled_width, scaled_height), interpolation=cv2.INTER_LINEAR)

        # Fallback: PIL with BOX filter (faster than BILINEAR, good for screen content)
        if not getattr(self, '_pil_fallback_logged', False):
            logger.warning("cv2 not available, using PIL BOX for image scaling (slower)")
            self._pil_fallback_logged = True
        pil_img = Image.fromarray(img)
        pil_img = pil_img.resize((scaled_width, scaled_height), Image.BOX)
        return np.array(pil_img)

    def _process_screenshot(self, screenshot):
        """Run numpy conversion + resize (may be called from thread).
        Uses zero-copy np.frombuffer on the raw bytearray for speed."""
        t0 = time.perf_counter()
        img = np.frombuffer(screenshot.raw, dtype=np.uint8).reshape(
            screenshot.height, screenshot.width, 4
        )
        t1 = time.perf_counter()
        result = self._scale_image_array(img)
        t2 = time.perf_counter()
        elapsed = (t2 - t0) * 1000
        count = getattr(self, '_ps_count', 0) + 1
        self._ps_count = count
        if count <= 3 or elapsed > 50:
            logger.info("_process_screenshot[%d]: total=%.1fms frombuffer=%.1fms resize=%.1fms size=%dx%d",
                        count, elapsed, (t1 - t0) * 1000, (t2 - t1) * 1000,
                        screenshot.width, screenshot.height)
        return result


class WebRemoteHost:
    def __init__(self):
        self.sio = None
        self.pc = None
        self.token = None
        self.screen_track = None
        self.current_viewer_id = None
        self.pending_candidates = []
        self.input_handler = InputHandler()
        self.input_handler.start()
        self.overlay = OverlayNotifier()
        self.relay_streamer = None
        self._input_datachannel = None
        self._active_input_binding = None
        self._connection_generation = 0
        self._input_lifecycle_tasks = set()
        self._offer_lock = asyncio.Lock()
        self._offer_epoch = 0
        self._reconnecting = False
        self._last_diag_network = None
        self.media_profile = dict(MEDIA_PROFILE_DEFAULT)
        self._input_event_count = 0
        self._last_input_at_monotonic = None

    async def authenticate(self):
        try:
            loop = asyncio.get_event_loop()
            verify_tls = should_verify_tls(SERVER_URL)
            def post_login():
                session = requests.Session()
                session.trust_env = False
                return session.post(
                    f"{SERVER_URL}/api/auth/login/host",
                    json={"secret": HOST_SHARED_SECRET},
                    headers={"Connection": "close"},
                    verify=verify_tls,
                    timeout=10,
                )

            response = await loop.run_in_executor(None, post_login)
            response.raise_for_status()
            body = response.json()
            if body.get('role') != 'host':
                raise RuntimeError('unexpected login role')
            self.token = body['token']
            logger.info("Authenticated as host")
            return True
        except Exception as e:
            logger.error(f"Auth failed: {e}")
            return False

    def _build_socket_client(self):
        sio = socketio.AsyncClient(reconnection=False, ssl_verify=should_verify_tls(SERVER_URL))
        sio.on('connected', self.on_connected)
        sio.on('offer', self.on_offer)
        sio.on('host-status', self.on_host_status)
        sio.on('disconnect', self.on_disconnect)
        sio.on('input', self.on_input)
        sio.on('control-transition', self.on_control_transition)
        sio.on('ice-candidate', self.on_ice_candidate)
        sio.on('diagnostic', self.on_diagnostic)
        sio.on('viewer-status', self.on_viewer_status)
        sio.on('viewer-stats', self.on_viewer_stats)
        sio.on('resolution-change', self.on_resolution_change)
        sio.on('media-profile-change', self.on_media_profile_change)
        sio.on('relay-stream-control', self.on_relay_stream_control)
        sio.on('relay-frame-ack', self.on_relay_frame_ack)
        return sio

    async def connect(self):
        try:
            if self.sio and self.sio.connected:
                return True
            if self.sio is None:
                self.sio = self._build_socket_client()
                self.relay_streamer = TunnelRelayStreamer(self.sio)

            await self.sio.connect(SERVER_URL, auth={"token": self.token, "role": "host"})
            logger.info("Connected to signaling server")
            return True
        except Exception as e:
            logger.error(f"Connection failed: {e}")
            return False

    async def on_input(self, data):
        """Handle input commands from viewer"""
        try:
            # Basic validation
            if not isinstance(data, dict):
                logger.warning(f"Invalid input data type: {type(data)}")
                return
            viewer_id = data.get("viewerId")
            if viewer_id and self.current_viewer_id and viewer_id != self.current_viewer_id:
                logger.warning(
                    "Ignoring input from stale viewer %s (current=%s)",
                    viewer_id,
                    self.current_viewer_id,
                )
                return
            input_type = data.get('type')
            if input_type not in ('mouse', 'keyboard', 'command'):
                logger.warning("Unknown input type")
                return
            payload = data.get('payload', {})
            if input_type == 'mouse':
                rel_x = payload.get('relX')
                rel_y = payload.get('relY')
                if rel_x is not None and not (0 <= rel_x <= 1):
                    logger.warning("Invalid mouse coordinate field=relX")
                    return
                if rel_y is not None and not (0 <= rel_y <= 1):
                    logger.warning("Invalid mouse coordinate field=relY")
                    return
            action = data.get('action')
            transport = data.get("transport", "socket")
            input_ids = data.get("inputIds", [])
            self._input_event_count = int(getattr(self, "_input_event_count", 0) or 0) + 1
            self._last_input_at_monotonic = time.perf_counter()
            if input_type == 'keyboard' or action != 'move':
                emit_host_event(
                    logger,
                    event="host_input_received",
                    message="Remote input received",
                    meta=summarize_input_event(data),
                )
            else:
                logger.debug("Input received: type=mouse action=move transport=%s", transport)
            if input_type == 'keyboard' and action == 'reset':
                logger.info("Keyboard reset observed transport=%s", transport)
            if input_type == 'keyboard' and action != 'reset':
                self.overlay.send({
                    "type": "key",
                    "text": format_keyboard_command(action, payload),
                    "viewerId": data.get("viewerId")
                })
            if input_type == 'keyboard' and data.get('schemaVersion') == 2:
                result = await self.input_handler.apply_keyboard(data)
            else:
                result = await self.input_handler.handle_input(data)
            if result and isinstance(result, dict):
                receive_time = result.get("receiveTime")
                execute_time = result.get("executeTime")
                local_execute_ms = None
                if isinstance(receive_time, (int, float)) and isinstance(execute_time, (int, float)):
                    local_execute_ms = (execute_time - receive_time) * 1000
                if input_type == 'keyboard' or action != 'move':
                    emit_host_event(
                        logger,
                        event="host_input_executed",
                        message="Remote input executed",
                        meta=summarize_input_event(data, local_execute_ms=local_execute_ms),
                    )
                await self._send_input_ack(data, result, local_execute_ms)
            if result and isinstance(result, dict) and result.get("inputIds"):
                if self.screen_track:
                    with self.screen_track._pending_input_lock:
                        self.screen_track._pending_input_ids.update(result["inputIds"])
                        self.screen_track._pending_input_data.append({
                            "ids": result["inputIds"],
                            "receiveTime": result.get("receiveTime"),
                            "executeTime": result.get("executeTime"),
                        })
        except Exception as e:
            logger.error("Input handling error: %s", type(e).__name__, exc_info=True)

    async def _send_input_ack(self, data, result, local_execute_ms):
        input_ids = result.get("inputIds", []) if isinstance(result, dict) else []
        if not input_ids:
            return False
        transport = str(data.get("transport") or "socket")
        if data.get("schemaVersion") == 2:
            # v2 keyboard transport acknowledges the applied sequence and the
            # Host's post-execution state; never echo the input payload.
            pressed_key_count = result.get("pressedKeyCount")
            modifier_mask = result.get("modifierMask")
            if not isinstance(pressed_key_count, int):
                pressed_key_count = len(getattr(self.input_handler, "_pressed_key_codes", ()))
            if not isinstance(modifier_mask, int):
                modifier_mask = int(getattr(self.input_handler, "_modifier_flags", 0) or 0)
            ack = {
                "type": "input_ack",
                "schemaVersion": 2,
                "leaseEpoch": data.get("leaseEpoch"),
                "appliedSeq": result.get("appliedSeq", data.get("seq")),
                "status": result.get("status") or "applied",
                "pressedKeyCount": max(0, pressed_key_count),
                "modifierMask": max(0, modifier_mask),
                "inputIds": list(input_ids),
                "hostExecuteMs": round(max(0.0, float(local_execute_ms or 0.0)), 3),
                "transport": transport,
            }
        else:
            ack = {
                "type": "input_ack",
                "schemaVersion": 1,
                "inputIds": list(input_ids),
                "hostExecuteMs": round(max(0.0, float(local_execute_ms or 0.0)), 3),
                "transport": transport,
            }
        if transport == "datachannel":
            channel = self.get_input_datachannel()
            if channel is None or not hasattr(channel, "send"):
                return False
            channel.send(json.dumps(ack))
            return True
        if self.sio is None:
            return False
        await self.sio.emit("input-ack", {
            **ack,
            "viewerId": data.get("viewerId"),
        })
        return True

    async def on_connected(self, data):
        logger.info(f"Connected: {data}")

    def build_event_loop_lag_context(self, *, lag_ms, sample_count, max_lag_ms, task_count):
        usage = resource.getrusage(resource.RUSAGE_SELF)
        rss_divisor = 1024 * 1024 if sys.platform == "darwin" else 1024
        try:
            system_load_1 = round(float(os.getloadavg()[0]), 3)
        except (AttributeError, OSError):
            system_load_1 = None
        last_input_at = getattr(self, "_last_input_at_monotonic", None)
        last_input_age_ms = None
        if isinstance(last_input_at, (int, float)):
            last_input_age_ms = round(max(0.0, (time.perf_counter() - last_input_at) * 1000), 3)
        relay = getattr(self, "relay_streamer", None)
        pending_relay_frames = 0
        if relay is not None and hasattr(relay, "pending_frame_count"):
            pending_relay_frames = int(relay.pending_frame_count())
        profile = getattr(self, "media_profile", {}) or {}
        pc = getattr(self, "pc", None)
        screen_track = getattr(self, "screen_track", None)
        input_handler = getattr(self, "input_handler", None)
        severity = "critical" if float(max_lag_ms) >= 100 else "warning"
        return {
            "lagMs": round(max(0.0, float(lag_ms)), 3),
            "maxLagMs": round(max(0.0, float(max_lag_ms)), 3),
            "sampleCount": int(sample_count),
            "severity": severity,
            "mediaProfile": str(profile.get("profile") or "unknown"),
            "targetFps": int(profile.get("target_fps") or getattr(screen_track, "_target_fps", 0) or 0),
            "pcState": str(getattr(pc, "connectionState", "none") or "none"),
            "iceState": str(getattr(pc, "iceConnectionState", "none") or "none"),
            "captureSeq": int(getattr(screen_track, "_capture_seq", 0) or 0),
            "inputEventCount": int(getattr(self, "_input_event_count", 0) or 0),
            "lastInputAgeMs": last_input_age_ms,
            "inputWaiters": int(getattr(input_handler, "_lock_waiters", 0) or 0),
            "relayRunning": bool(getattr(relay, "running", getattr(relay, "enabled", False))),
            "pendingRelayFrames": pending_relay_frames,
            "taskCount": int(task_count),
            "threadCount": threading.active_count(),
            "processCpuSeconds": round(float(usage.ru_utime + usage.ru_stime), 3),
            "rssMiB": round(float(usage.ru_maxrss) / rss_divisor, 3),
            "systemLoad1": system_load_1,
        }

    def _should_process_offer(self, viewer_id, offer_epoch):
        """Return whether an offer is current, tracking epochs per viewer socket."""
        pc_state = self.pc.connectionState if self.pc is not None else None
        pc_active = pc_state not in (None, 'failed', 'closed')

        if not pc_active:
            if self._offer_epoch > 0:
                logger.info("Resetting offer epoch from %s to 0 (no active PC)", self._offer_epoch)
            self._offer_epoch = 0
            self.current_viewer_id = None

        if offer_epoch is None:
            if pc_active:
                logger.warning("Ignoring duplicate offer from old viewer (pcState=%s)", pc_state)
                return False
            self.current_viewer_id = viewer_id
            return True

        if viewer_id and viewer_id != self.current_viewer_id:
            if self.current_viewer_id is not None:
                logger.warning(
                    "Viewer takeover: new viewer %s replacing %s (pcState=%s, epoch=%s)",
                    viewer_id,
                    self.current_viewer_id,
                    pc_state,
                    self._offer_epoch,
                )
            self.current_viewer_id = viewer_id
            self._offer_epoch = 0

        if offer_epoch <= self._offer_epoch:
            logger.warning(
                "Ignoring stale/duplicate offer viewer=%s epoch=%s <= current=%s",
                viewer_id,
                offer_epoch,
                self._offer_epoch,
            )
            return False

        self._offer_epoch = offer_epoch
        self.current_viewer_id = viewer_id
        return True

    @staticmethod
    def _binding_matches(left, right):
        return bool(left) and bool(right) and all(
            left.get(field) == right.get(field)
            for field in ("viewerId", "leaseId", "leaseEpoch", "connectionGeneration")
        )

    def _prepare_bound_datachannel_input(self, binding, data):
        """Apply immutable offer context to one direct DataChannel message."""
        if not isinstance(data, dict) or not self._binding_matches(
            binding, getattr(self, "_active_input_binding", None)
        ):
            return None
        if data.get("schemaVersion") == 2 and (
            data.get("leaseId") != binding["leaseId"]
            or data.get("leaseEpoch") != binding["leaseEpoch"]
        ):
            return None
        bound = dict(data)
        bound.update({
            "viewerId": binding["viewerId"],
            "leaseId": binding["leaseId"],
            "leaseEpoch": binding["leaseEpoch"],
            "connectionGeneration": binding["connectionGeneration"],
            "transport": "datachannel",
        })
        return bound

    def _schedule_input_lifecycle(self, coroutine):
        """Keep callback-created work bounded and observable during teardown."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return None
        task = loop.create_task(coroutine)
        tasks = getattr(self, "_input_lifecycle_tasks", None)
        if tasks is None:
            tasks = self._input_lifecycle_tasks = set()
        tasks.add(task)
        task.add_done_callback(tasks.discard)
        return task

    async def _reset_keyboard_lifecycle(self, reason, lease_epoch=None):
        handler = getattr(self, "input_handler", None)
        if handler is None:
            return None
        result = await handler.reset_keyboard(reason=reason, lease_epoch=lease_epoch)
        handler.release_all_mouse_buttons(reason=reason)
        return result

    async def on_control_transition(self, data):
        """Acknowledge Signal's reset barrier before any new keyboard lease is active."""
        if not isinstance(data, dict):
            return
        lease_epoch = data.get("leaseEpoch")
        if not isinstance(lease_epoch, int) or lease_epoch < 1:
            return
        self._connection_generation = int(getattr(self, "_connection_generation", 0) or 0) + 1
        await self._reset_keyboard_lifecycle(data.get("reason") or "pending-reset")
        lease_id = data.get("leaseId")
        viewer_id = data.get("viewerId")
        if isinstance(lease_id, str) and len(lease_id) >= 16 and viewer_id:
            binding = {
                "viewerId": viewer_id,
                "leaseId": lease_id,
                "leaseEpoch": lease_epoch,
                "connectionGeneration": self._connection_generation,
            }
            result = await self.input_handler.transition_keyboard(
                connection_generation=binding["connectionGeneration"],
                lease_id=binding["leaseId"],
                lease_epoch=binding["leaseEpoch"],
            )
            if result.get("status") != "applied":
                return
            self._active_input_binding = binding
        else:
            self._active_input_binding = None
        if self.sio is not None:
            await self.sio.emit("control-transition-ack", {
                "leaseEpoch": lease_epoch,
                "status": "applied",
            })

    async def _close_peer_connection(self, reason="manual", reset_offer_state=False):
        await self._reset_keyboard_lifecycle(reason)
        if self.pc:
            logger.info("Closing peer connection reason=%s", reason)
            await self.pc.close()
            self.pc = None

        if self.screen_track:
            await self.screen_track.shutdown()
            self.screen_track = None

        self._input_datachannel = None
        self._active_input_binding = None
        self.pending_candidates = []

        if reset_offer_state:
            self.current_viewer_id = None
            self._offer_epoch = 0

    async def on_offer(self, data):
        viewer_id = data.get('viewerId')
        offer_epoch = data.get('epoch')  # None if old viewer doesn't send epoch
        logger.info(f"Received offer from viewer {viewer_id} epoch={offer_epoch}")

        # Serialize offer processing to prevent race conditions
        async with self._offer_lock:
            if not self._should_process_offer(viewer_id, offer_epoch):
                return

            try:
                await self._close_peer_connection(reason="new-offer", reset_offer_state=False)

                lease_id = data.get("leaseId")
                lease_epoch = data.get("leaseEpoch")
                if isinstance(lease_id, str) and len(lease_id) >= 16 and isinstance(lease_epoch, int) and lease_epoch >= 1:
                    self._connection_generation = max(
                        int(getattr(self, "_connection_generation", 0) or 0) + 1,
                        int(data.get("connectionGeneration") or 0),
                    )
                    binding = {
                        "viewerId": viewer_id,
                        "leaseId": lease_id,
                        "leaseEpoch": lease_epoch,
                        "connectionGeneration": self._connection_generation,
                    }
                    result = await self.input_handler.transition_keyboard(
                        connection_generation=binding["connectionGeneration"],
                        lease_id=binding["leaseId"],
                        lease_epoch=binding["leaseEpoch"],
                    )
                    if result.get("status") != "applied":
                        logger.warning("Ignoring offer with rejected keyboard binding")
                        return
                    self._active_input_binding = binding

                # Create peer connection
                config = RTCConfiguration(iceServers=build_ice_servers())
                self.pc = RTCPeerConnection(configuration=config)

                # Setup handlers BEFORE setting local description
                ice_complete = asyncio.Event()

                @self.pc.on("icecandidate")
                async def on_icecandidate(candidate):
                    if candidate and viewer_id:
                        logger.info(f"Host ICE: {candidate.sdp[:50]}...")
                        try:
                            await self.sio.emit('ice-candidate', {
                                'target': 'viewer',
                                'viewerId': viewer_id,
                                'candidate': {
                                    'candidate': candidate.sdp,
                                    'sdpMLineIndex': candidate.sdpMLineIndex,
                                    'sdpMid': candidate.sdpMid
                                }
                            })
                        except Exception as e:
                            logger.error(f"Failed to send ICE: {e}")

                @self.pc.on("icegatheringstatechange")
                def on_icegatheringstatechange():
                    state = self.pc.iceGatheringState
                    logger.info(f"ICE gathering: {state}")
                    if state == "complete":
                        ice_complete.set()

                @self.pc.on("connectionstatechange")
                def on_connectionstatechange():
                    state = self.pc.connectionState
                    logger.info(f"Connection: {state}")
                    if state == 'connected':
                        logger.info("WebRTC CONNECTED!")
                    elif state in ('failed', 'closed', 'disconnected'):
                        self._schedule_input_lifecycle(
                            self._reset_keyboard_lifecycle(f"webrtc-{state}")
                        )
                        if state == 'failed':
                            logger.error("WebRTC FAILED")

                @self.pc.on("iceconnectionstatechange")
                def on_iceconnectionstatechange():
                    logger.info(f"ICE connection: {self.pc.iceConnectionState}")

                @self.pc.on("datachannel")
                def on_datachannel(channel):
                    logger.info("DataChannel received: label=%s id=%s", channel.label, channel.id)
                    binding = dict(self._active_input_binding or {})
                    if channel.label == "input":
                        self._input_datachannel = channel

                    @channel.on("close")
                    def on_close():
                        pc_state = self.pc.connectionState if self.pc else 'no-pc'
                        ice_state = self.pc.iceConnectionState if self.pc else 'no-pc'
                        logger.warning("DataChannel CLOSED: label=%s pc=%s ice=%s",
                                       channel.label, pc_state, ice_state)
                        if channel.label == "input":
                            self._input_datachannel = None
                        if binding:
                            self._schedule_input_lifecycle(
                                self._reset_keyboard_lifecycle(
                                    "datachannel-closed",
                                    lease_epoch=binding.get("leaseEpoch"),
                                )
                            )

                    @channel.on("message")
                    def on_message(message):
                        if channel.label not in ("input", "input-move"):
                            logger.debug("Ignoring message on datachannel %s", channel.label)
                            return
                        try:
                            if isinstance(message, bytes):
                                message = message.decode("utf-8")
                            data = json.loads(message)

                            # Handle clock sync request
                            if data.get("type") == "clock_sync_req":
                                v0 = data.get("v0", 0)
                                h0 = time.time()
                                h1 = time.time()
                                resp = {
                                    "type": "clock_sync_resp",
                                    "v0": v0,
                                    "h0": h0,
                                    "h1": h1,
                                }
                                channel.send(json.dumps(resp))
                                return

                            bound = self._prepare_bound_datachannel_input(binding, data)
                            if bound is None:
                                logger.warning("Ignoring unbound or stale DataChannel input")
                                return
                            self._schedule_input_lifecycle(self.on_input(bound))
                        except Exception as e:
                            logger.error(f"DataChannel input parse error: {e}")

                # Add video track
                self.screen_track = ScreenCaptureTrack(
                    target_fps=self.media_profile["target_fps"],
                    max_width=self.media_profile["width"],
                    max_height=self.media_profile["height"],
                )
                self.screen_track._host_ref = self
                self.pc.addTrack(self.screen_track)
                self._prefer_h264_transceivers()
                logger.info("Added video track")

                # Process offer - replace mDNS with localhost
                offer_data = data.get('offer')
                if not offer_data or 'sdp' not in offer_data:
                    logger.error("Invalid offer: missing 'offer' or 'sdp' field")
                    return
                offer_sdp = offer_data['sdp']
                offer_sdp = re.sub(r'[a-f0-9-]+\.local', '127.0.0.1', offer_sdp)
                self._log_video_codecs("viewer-offer", offer_sdp)

                await self.pc.setRemoteDescription(
                    RTCSessionDescription(sdp=offer_sdp, type=offer_data['type'])
                )
                logger.info("Set remote description")

                # Create answer
                answer = await self.pc.createAnswer()
                await self.pc.setLocalDescription(answer)
                logger.info("Set local description")
                local_description = self.pc.localDescription or answer
                if local_description and hasattr(local_description, 'sdp'):
                    self._log_video_codecs("host-answer", local_description.sdp)
                else:
                    logger.warning("localDescription is None after setLocalDescription")

                # Wait for ICE gathering to complete
                try:
                    await asyncio.wait_for(ice_complete.wait(), timeout=5.0)
                    logger.info("ICE gathering complete")
                except asyncio.TimeoutError:
                    logger.warning("ICE gathering timeout")

                # Send answer with ICE candidates included
                local_description = self.pc.localDescription or answer
                await self.sio.emit('answer', {
                    'answer': {
                        'type': local_description.type,
                        'sdp': local_description.sdp
                    },
                    'viewerId': viewer_id
                })
                logger.info("Sent answer")

                # Process any pending candidates received before PC was ready
                for cand in self.pending_candidates:
                    await self._add_ice_candidate(cand)
                self.pending_candidates = []

            except Exception as e:
                logger.error(f"Error in on_offer: {e}", exc_info=True)

    async def on_ice_candidate(self, data):
        candidate_viewer_id = data.get('from')
        if (
            candidate_viewer_id
            and self.current_viewer_id
            and candidate_viewer_id != self.current_viewer_id
        ):
            logger.warning(
                "Ignoring ICE from stale viewer %s (current=%s)",
                candidate_viewer_id,
                self.current_viewer_id,
            )
            return

        candidate = data.get('candidate', {})
        candidate_str = candidate.get('candidate', '')

        if not candidate_str:
            logger.debug("Null ICE candidate (end of candidates)")
            return

        logger.info(f"Received ICE from viewer: {candidate_str[:60]}...")

        if not self.pc:
            logger.warning("PC not ready, buffering candidate")
            self.pending_candidates.append(candidate)
            return

        await self._add_ice_candidate(candidate)

    async def _add_ice_candidate(self, candidate):
        try:
            parsed = parse_ice_candidate(candidate.get('candidate', ''))
            if not parsed:
                return

            from aiortc import RTCIceCandidate
            ice_candidate = RTCIceCandidate(
                foundation=parsed['foundation'],
                component=parsed['component'],
                protocol=parsed['protocol'],
                priority=parsed['priority'],
                ip=parsed['ip'],
                port=parsed['port'],
                type=parsed['type'],
                relatedAddress=parsed.get('relatedAddress'),
                relatedPort=parsed.get('relatedPort'),
                sdpMid=candidate.get('sdpMid', '0'),
                sdpMLineIndex=candidate.get('sdpMLineIndex', 0)
            )
            await self.pc.addIceCandidate(ice_candidate)
            logger.info(f"Added ICE: {parsed['ip']}:{parsed['port']}")
        except Exception as e:
            logger.error(f"Failed to add ICE: {e}")

    async def on_diagnostic(self, data):
        """Handle diagnostic logs from viewer"""
        try:
            logs = data.get('logs', [])
            ua = data.get('userAgent', 'unknown')
            screen = data.get('screen', 'unknown')
            trigger = data.get('trigger', 'manual')
            reason = data.get('reason') or '-'
            network = data.get('network') or {}
            schema_version = int(data.get('schemaVersion') or 0)
            self._last_diag_network = network
            candidate_summary = network.get('candidateSummary') or {}
            selected_candidate_pair = (
                data.get('selectedCandidatePair')
                or network.get('selectedCandidatePair')
                or {}
            )
            pc_state = data.get('pc') or network.get('pc') or {}
            ice_state = data.get('ice') or network.get('ice') or {}
            candidate = (
                data.get('candidate')
                or network.get('lastCandidateType')
                or data.get('selectedCandidateType')
                or '-'
            )
            verbose_diagnostics = os.environ.get("WRD_HOST_VERBOSE_DIAGNOSTICS", "0") == "1"
            emit_host_event(
                logger,
                event="host_viewer_diagnostic_summary",
                message="Viewer diagnostic received by host",
                correlation={
                    "browserSessionId": data.get("browserSessionId"),
                    "connectionAttemptId": data.get("connectionAttemptId"),
                },
                meta={
                    "userAgent": ua,
                    "screen": screen,
                    "trigger": trigger,
                    "reason": reason,
                    "logCount": len(logs),
                    "networkMode": network.get("networkMode", "-"),
                    "turnConfigured": network.get("turnConfigured", False),
                    "turnStatus": network.get("turnStatus", "unknown"),
                },
            )
            if schema_version == 2:
                logger.info(
                    "WRD_STUN_FAILURE connectionAttemptId=%s failureCategory=%s candidateSummary=%s selectedCandidatePair=%s pc=%s ice=%s candidate=%s",
                    data.get('connectionAttemptId') or '-',
                    data.get('failureCategory') or '-',
                    format_diag_value(data.get('candidateSummary') or candidate_summary),
                    format_diag_value(selected_candidate_pair),
                    format_diag_value(pc_state),
                    format_diag_value(ice_state),
                    format_diag_value(candidate),
                )
            logger.info(
                "WRD_FAILURE_DIAG trigger=%s reason=%s mode=%s turn=%s/%s pc=%s ice=%s candidate=%s selectedCandidatePair=%s local=%s remote=%s",
                trigger,
                reason,
                network.get('networkMode', '-'),
                network.get('turnConfigured', False),
                network.get('turnStatus', 'unknown'),
                (network.get('pc') or {}).get('connectionState', '-'),
                (network.get('pc') or {}).get('iceConnectionState', '-'),
                network.get('lastCandidateType', '-'),
                format_diag_value(selected_candidate_pair),
                candidate_summary.get('local', {}),
                candidate_summary.get('remote', {}),
            )
            if verbose_diagnostics:
                logger.info("=== DIAGNOSTIC LOGS FROM VIEWER ===")
                logger.info(f"User-Agent: {ua}")
                logger.info(f"Screen: {screen}")
                for line in logs:
                    if isinstance(line, dict):
                        logger.info("[VIEWER] %s", json.dumps(line, ensure_ascii=True, sort_keys=True))
                    else:
                        logger.info(f"[VIEWER] {line}")
                logger.info(f"=== END DIAGNOSTIC LOGS ({len(logs)} lines) ===")
        except Exception as e:
            logger.error(f"Error handling diagnostic logs: {e}")

    async def on_viewer_stats(self, data):
        """Handle periodic WebRTC stats from viewer."""
        try:
            logger.info(
                "VIEWER_STATS viewer=%s codec=%s fps=%.1f rtt=%sms jitter_buffer=%sms decoded=%s received=%s lost=%s candidate=%s bytes=%.2fMB",
                data.get("viewerId", "-"),
                data.get("codec") or "unknown",
                float(data.get("fps") or 0),
                data.get("rttMs", 0),
                data.get("jitterBufferMs", 0),
                data.get("framesDecoded", 0),
                data.get("framesReceived", 0),
                data.get("packetsLost", 0),
                data.get("selectedCandidateType") or "unknown",
                float(data.get("bytesReceived") or 0) / 1024 / 1024,
            )
            logger.info(
                "WRD_VIEWER_SUMMARY viewer=%s candidate=%s fps=%.1f rtt=%s mode=%s turn=%s/%s",
                data.get("viewerId", "-"),
                data.get("selectedCandidateType") or "unknown",
                float(data.get("fps") or 0),
                data.get("rttMs", 0),
                (self._last_diag_network or {}).get("networkMode", "-"),
                (self._last_diag_network or {}).get("turnConfigured", False),
                (self._last_diag_network or {}).get("turnStatus", "unknown"),
            )
        except Exception as e:
            logger.error(f"Error handling viewer stats: {e}")

    async def on_resolution_change(self, data):
        """Apply viewer requested max stream resolution."""
        try:
            width = int(data.get("width"))
            height = int(data.get("height"))
            logger.info(
                "Resolution request from viewer=%s max=%sx%s",
                data.get("viewerId", "-"),
                width,
                height,
            )
            if self.screen_track:
                self.screen_track.set_max_resolution(width, height)
        except Exception as e:
            logger.error(f"Error handling resolution change: {e}")

    def on_media_profile_change(self, data):
        """Apply adaptive media profile requested by the active viewer."""
        try:
            allowed_profiles = {"high", "medium", "low", "survival"}
            profile = data.get("profile") if data.get("profile") in allowed_profiles else "medium"
            next_profile = {
                "profile": profile,
                "width": clamp_int(data.get("width"), 320, 1920, 960),
                "height": clamp_int(data.get("height"), 180, 1080, 540),
                "target_fps": clamp_int(data.get("targetFps"), 5, 30, 15),
                "video_bitrate_kbps": clamp_int(data.get("videoBitrateKbps"), 250, 5000, 1400),
            }
            self.media_profile = next_profile
            viewer_id = data.get("viewerId", "-")
            reason = str(data.get("reason", "quality"))[:80]
            logger.info(
                "WRD_MEDIA_PROFILE viewer=%s profile=%s size=%sx%s fps=%s bitrate_kbps=%s reason=%s",
                viewer_id,
                next_profile["profile"],
                next_profile["width"],
                next_profile["height"],
                next_profile["target_fps"],
                next_profile["video_bitrate_kbps"],
                reason,
            )
            if self.screen_track and hasattr(self.screen_track, "apply_media_profile"):
                self.screen_track.apply_media_profile(next_profile)
        except Exception as e:
            logger.error(f"Error handling media profile change: {e}")

    async def on_relay_stream_control(self, data):
        """Start/stop Socket.IO tunnel video relay for networks where WebRTC ICE fails."""
        try:
            enabled = bool(data.get("enabled"))
            viewer_id = data.get("viewerId")
            if not self.relay_streamer:
                self.relay_streamer = TunnelRelayStreamer(self.sio)
            if enabled and viewer_id:
                await self.relay_streamer.start(
                    viewer_id,
                    width=data.get("width", 960),
                    height=data.get("height", 540),
                    fps=data.get("fps", 8),
                )
            else:
                active_viewer_id = getattr(self.relay_streamer, "viewer_id", None)
                if viewer_id and active_viewer_id and viewer_id != active_viewer_id:
                    logger.info(
                        "Ignoring stale tunnel relay stop viewer=%s active=%s",
                        viewer_id,
                        active_viewer_id,
                    )
                    return
                await self.relay_streamer.stop()
                logger.info("Tunnel relay stream stopped viewer=%s", viewer_id)
        except Exception as e:
            logger.error(f"Error handling relay stream control: {e}")

    async def on_relay_frame_ack(self, data):
        try:
            if self.relay_streamer and data.get("viewerId") == self.relay_streamer.viewer_id:
                self.relay_streamer.ack(data.get("frameId"), latency_ms=data.get("latencyMs"))
        except Exception as e:
            logger.debug(f"Error handling relay frame ack: {e}")

    async def on_viewer_status(self, data):
        """Update local floating overlay with viewer count and visitors."""
        try:
            logger.info(f"Viewer status: {data.get('onlineCount', 0)} online")
            if data.get("onlineCount", 0) == 0:
                if self.relay_streamer:
                    await self.relay_streamer.stop()
                await self._close_peer_connection(
                    reason="viewer-disconnected",
                    reset_offer_state=True,
                )
            self.overlay.send({
                "type": "viewer-status",
                "onlineCount": data.get("onlineCount", 0),
                "viewers": data.get("viewers", [])
            })
        except Exception as e:
            logger.error(f"Error handling viewer status: {e}")

    async def on_host_status(self, data):
        logger.info(f"Host status: {data}")

    def _log_video_codecs(self, label, sdp):
        """Log the negotiated video codec order without dumping full SDP."""
        try:
            video_payloads = []
            payload_names = {}
            fmtp = {}
            in_video = False
            for line in sdp.splitlines():
                if line.startswith("m="):
                    in_video = line.startswith("m=video")
                    if in_video:
                        parts = line.split()
                        video_payloads = parts[3:]
                    continue
                if not in_video:
                    continue
                if line.startswith("a=rtpmap:"):
                    payload, name = line[9:].split(" ", 1)
                    payload_names[payload] = name
                elif line.startswith("a=fmtp:"):
                    payload, params = line[7:].split(" ", 1)
                    fmtp[payload] = params

            ordered = []
            for payload in video_payloads:
                name = payload_names.get(payload, f"pt/{payload}")
                params = fmtp.get(payload)
                if params:
                    ordered.append(f"{payload}:{name} [{params}]")
                else:
                    ordered.append(f"{payload}:{name}")
            logger.info("SDP_%s video_codecs=%s", label, " | ".join(ordered[:12]) or "none")
            self._log_ice_candidate_summary(label, sdp)
        except Exception as e:
            logger.warning(f"Failed to parse {label} video codecs: {e}")

    def _log_ice_candidate_summary(self, label, sdp):
        """Log SDP ICE candidate types without dumping full private SDP."""
        try:
            summary = {}
            for line in sdp.splitlines():
                if not line.startswith("a=candidate:"):
                    continue
                parts = line[12:].split()
                if len(parts) < 8:
                    continue
                protocol = parts[2].lower()
                ip = parts[4]
                port = parts[5]
                cand_type = parts[7]
                summary[cand_type] = summary.get(cand_type, 0) + 1
                logger.info(
                    "SDP_%s ice_candidate type=%s protocol=%s endpoint=%s:%s",
                    label,
                    cand_type,
                    protocol,
                    ip,
                    port,
                )
            if not summary:
                logger.info("SDP_%s ice_candidates=none", label)
            else:
                logger.info("SDP_%s ice_candidate_summary=%s", label, summary)
                logger.info("WRD_CANDIDATE_SUMMARY side=%s summary=%s", label, summary)
        except Exception as e:
            logger.warning(f"Failed to parse {label} ICE candidates: {e}")

    def _prefer_h264_transceivers(self):
        """Prefer H.264 for lower latency and better browser decoder support."""
        try:
            from aiortc import RTCRtpSender

            video_codecs = list(RTCRtpSender.getCapabilities("video").codecs)
            h264_codecs = [codec for codec in video_codecs if codec.mimeType.lower() == "video/h264"]
            if not h264_codecs:
                logger.warning("No H.264 codecs available in aiortc codec registry")
                return

            h264_rtx = [codec for codec in video_codecs if codec.mimeType.lower() == "video/rtx"]
            fallback = [codec for codec in video_codecs if codec not in h264_codecs and codec not in h264_rtx]
            preferred = h264_codecs + h264_rtx + fallback

            for transceiver in self.pc.getTransceivers():
                if transceiver.kind == "video":
                    transceiver.setCodecPreferences(preferred)
                    logger.info("Preferred host video codecs: %s", " | ".join(str(codec) for codec in preferred))
        except Exception as e:
            logger.warning(f"Failed to set host H.264 codec preferences: {e}")

    def get_input_datachannel(self):
        return self._input_datachannel

    async def on_disconnect(self):
        logger.warning("Disconnected from signaling server")
        if self.relay_streamer:
            await self.relay_streamer.stop()
        await self._close_peer_connection(reason='signal-disconnect', reset_offer_state=True)

    async def ensure_connected(self):
        if self._reconnecting:
            return False
        if self.sio and self.sio.connected:
            return True
        self._reconnecting = True
        try:
            logger.warning('Host offline, attempting reconnect...')
            if self.sio:
                try:
                    await self.sio.disconnect()
                except Exception:
                    pass
                self.sio = None
                self.relay_streamer = None
            if not await self.authenticate():
                return False
            return await self.connect()
        finally:
            self._reconnecting = False

    async def run(self):
        logger.info("Starting Host...")

        if not await self.authenticate():
            return
        if not await self.connect():
            return

        logger.info("Host running. Press Ctrl+C to stop.")

        # Event loop lag monitor
        async def monitor_event_loop_lag():
            interval_seconds = 1.0
            emit_cooldown_seconds = 5.0
            deadline = time.perf_counter() + interval_seconds
            last_emitted_at = 0.0
            pending_count = 0
            pending_max_lag_ms = 0.0
            while True:
                await asyncio.sleep(max(0.0, deadline - time.perf_counter()))
                observed_at = time.perf_counter()
                lag_ms = max(0.0, (observed_at - deadline) * 1000)
                deadline = observed_at + interval_seconds
                if lag_ms > 20:
                    pending_count += 1
                    pending_max_lag_ms = max(pending_max_lag_ms, lag_ms)
                should_emit = pending_count > 0 and (
                    pending_max_lag_ms >= 100
                    or observed_at - last_emitted_at >= emit_cooldown_seconds
                )
                if should_emit:
                    emit_host_event(
                        logger,
                        event="host_event_loop_lag",
                        message="Host event loop lag exceeded threshold",
                        level="warning",
                        meta=self.build_event_loop_lag_context(
                            lag_ms=pending_max_lag_ms,
                            sample_count=pending_count,
                            max_lag_ms=pending_max_lag_ms,
                            task_count=len(asyncio.all_tasks()),
                        ),
                    )
                    pending_count = 0
                    pending_max_lag_ms = 0.0
                    last_emitted_at = observed_at

        lag_task = asyncio.create_task(monitor_event_loop_lag())

        try:
            while True:
                await asyncio.sleep(1)
                if not self.sio or not self.sio.connected:
                    await self.ensure_connected()
        except KeyboardInterrupt:
            logger.info("Shutting down...")
        finally:
            lag_task.cancel()
            if self.relay_streamer:
                await self.relay_streamer.stop()
            await self._close_peer_connection(reason="host-stop", reset_offer_state=True)
            lifecycle_tasks = list(self._input_lifecycle_tasks)
            if lifecycle_tasks:
                await asyncio.gather(*lifecycle_tasks, return_exceptions=True)
            if self.sio and self.sio.connected:
                await self.sio.disconnect()
            self.overlay.stop()


if __name__ == "__main__":
    host = WebRemoteHost()
    try:
        asyncio.run(host.run())
    except Exception as e:
        logger.error(f"Fatal: {e}", exc_info=True)
        sys.exit(1)
