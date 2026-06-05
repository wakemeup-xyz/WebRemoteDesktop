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
from input_handler import InputHandler
from h264_videotoolbox_encoder import H264VideoToolboxEncoder

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
import os
SERVER_URL = os.environ.get('SERVER_URL', "http://127.0.0.1:8080")
HOST_SHARED_SECRET = os.environ.get('HOST_SHARED_SECRET') or os.environ.get('HOST_PASSWORD', '')


def should_verify_tls(server_url: str) -> bool:
    from urllib.parse import urlparse

    if os.environ.get("WRD_INSECURE_SKIP_TLS_VERIFY") != "1":
        return True
    host = urlparse(server_url).hostname or ""
    return host not in {"127.0.0.1", "localhost"}


def split_env_list(value):
    return [item.strip() for item in str(value or "").split(",") if item.strip()]


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
    if turn_urls and turn_username and turn_credential:
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
        self.frame_id = 0
        self.ack_event = asyncio.Event()
        self.last_acked_frame_id = 0
        self.stats_started_at = time.time()
        self.stats_frames = 0
        self.stats_acked = 0
        self.stats_bytes = 0
        self.stats_encode_ms = 0.0

    async def start(self, viewer_id, width=960, height=540, fps=8):
        await self.stop()
        self.viewer_id = viewer_id
        self.width = max(320, min(int(width or 960), 1280))
        self.height = max(180, min(int(height or 540), 720))
        self.fps = max(1, min(int(fps or 8), 12))
        self.frame_id = 0
        self.last_acked_frame_id = 0
        self.ack_event.clear()
        self.stats_started_at = time.time()
        self.stats_frames = 0
        self.stats_acked = 0
        self.stats_bytes = 0
        self.stats_encode_ms = 0.0
        self.enabled = True
        self.task = asyncio.create_task(self._run())
        logger.info(
            "Tunnel relay stream started viewer=%s size=%sx%s fps=%s",
            self.viewer_id,
            self.width,
            self.height,
            self.fps,
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

    def ack(self, frame_id):
        try:
            frame_id = int(frame_id)
        except Exception:
            return
        if frame_id > self.last_acked_frame_id:
            self.last_acked_frame_id = frame_id
            self.stats_acked += 1
            self.ack_event.set()

    async def _run(self):
        frame_interval = 1 / self.fps
        ack_timeout = max(0.35, min(1.0, frame_interval * 4))
        with MSS() as sct:
            monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
            while self.enabled and self.viewer_id:
                started = time.time()
                try:
                    self.ack_event.clear()
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
                    image.save(buffer, format="JPEG", quality=30, optimize=False, subsampling=2)
                    jpeg_bytes = buffer.getvalue()
                    encode_ms = (time.time() - started) * 1000
                    self.frame_id += 1
                    self.stats_frames += 1
                    self.stats_bytes += len(jpeg_bytes)
                    self.stats_encode_ms += encode_ms
                    await self.sio.emit("relay-frame", {
                        "viewerId": self.viewer_id,
                        "frameId": self.frame_id,
                        "width": image.width,
                        "height": image.height,
                        "timestamp": int(time.time() * 1000),
                        "mime": "image/jpeg",
                        "bytes": len(jpeg_bytes),
                        "data": jpeg_bytes,
                    })
                    await asyncio.wait_for(self.ack_event.wait(), timeout=ack_timeout)
                except asyncio.TimeoutError:
                    logger.debug("Tunnel relay frame ack timeout viewer=%s frame=%s", self.viewer_id, self.frame_id)
                except Exception as e:
                    logger.warning(f"Tunnel relay frame failed: {e}")

                elapsed = time.time() - started
                now = time.time()
                if now - self.stats_started_at >= 5:
                    duration = max(0.001, now - self.stats_started_at)
                    avg_kb = (self.stats_bytes / max(1, self.stats_frames)) / 1024
                    avg_encode = self.stats_encode_ms / max(1, self.stats_frames)
                    logger.info(
                        "TUNNEL_RELAY_STATS viewer=%s fps=%.1f sent=%s acked=%s avg_kb=%.1f avg_encode_ms=%.1f size=%sx%s",
                        self.viewer_id,
                        self.stats_frames / duration,
                        self.stats_frames,
                        self.stats_acked,
                        avg_kb,
                        avg_encode,
                        self.width,
                        self.height,
                    )
                    self.stats_started_at = now
                    self.stats_frames = 0
                    self.stats_acked = 0
                    self.stats_bytes = 0
                    self.stats_encode_ms = 0.0
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
        self.monitor = self.sct.monitors[1] if len(self.sct.monitors) > 1 else self.sct.monitors[0]
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
        Target ~3x frame rate (min 60 FPS) with adaptive sleep to prevent
        CPU spin while ensuring fresh frames for recv()."""
        _min_interval = 1.0 / max(self._target_fps * 3, 60)
        while self._capture_running:
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

        t0 = time.time()

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

        t1 = time.time()
        t2 = t1  # scale/convert timestamp (processing happened above)

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
        t3 = time.time()
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

        t4 = time.time()
        self._send_frame_timing(t0, t1, t2, t3, t4)

        return frame

    def _send_frame_timing(self, t0, t1, t2, t3, t4):
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
            "frameId": self._timing_seq,
            "timings": {
                "captureStart": t0,
                "captureEnd": t1,
                "scaleEnd": t2,
                "encodeEnd": t3,
                "packetSend": t4,
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
        self._offer_lock = asyncio.Lock()
        self._offer_epoch = 0
        self._reconnecting = False

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
        sio.on('ice-candidate', self.on_ice_candidate)
        sio.on('diagnostic', self.on_diagnostic)
        sio.on('viewer-status', self.on_viewer_status)
        sio.on('viewer-stats', self.on_viewer_stats)
        sio.on('resolution-change', self.on_resolution_change)
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
                logger.warning(f"Unknown input type: {input_type}")
                return
            payload = data.get('payload', {})
            if input_type == 'mouse':
                rel_x = payload.get('relX')
                rel_y = payload.get('relY')
                if rel_x is not None and not (0 <= rel_x <= 1):
                    logger.warning(f"Invalid relX: {rel_x}")
                    return
                if rel_y is not None and not (0 <= rel_y <= 1):
                    logger.warning(f"Invalid relY: {rel_y}")
                    return
            action = data.get('action')
            transport = data.get("transport", "socket")
            sent_at = data.get("timestamp")
            input_delay = None
            if isinstance(sent_at, (int, float)):
                input_delay = time.time() * 1000 - float(sent_at)
            input_ids = data.get("inputIds", [])
            ids_str = f" ids={input_ids}" if input_ids else ""
            if input_type == 'keyboard' or action != 'move':
                if input_delay is not None and -10000 < input_delay < 60000:
                    logger.info(
                        "Input received: %s %s transport=%s%s input_delay=%.1fms payload=%s",
                        input_type,
                        action,
                        transport,
                        ids_str,
                        input_delay,
                        payload,
                    )
                else:
                    logger.info(f"Input received: {input_type} {action} transport={transport}{ids_str} payload={payload}")
            else:
                logger.debug(f"Input received: {input_type} {action} transport={transport}")
            if input_type == 'keyboard' and action == 'reset':
                logger.info(
                    "Keyboard reset observed: viewer=%s transport=%s reason=%s ids=%s",
                    data.get("viewerId"),
                    transport,
                    payload.get("reason", "remote-reset"),
                    input_ids,
                )
            if input_type == 'keyboard' and action != 'reset':
                self.overlay.send({
                    "type": "key",
                    "text": format_keyboard_command(action, payload),
                    "viewerId": data.get("viewerId")
                })
            result = await self.input_handler.handle_input(data)
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
            logger.error(f"Input handling error: {e}")

    async def on_connected(self, data):
        logger.info(f"Connected: {data}")

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

    async def _close_peer_connection(self, reason="manual", reset_offer_state=False):
        if self.pc:
            logger.info("Closing peer connection reason=%s", reason)
            await self.pc.close()
            self.pc = None

        if self.screen_track:
            await self.screen_track.shutdown()
            self.screen_track = None

        self._input_datachannel = None
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
                        self.input_handler.release_all_keys(reason=f"webrtc-{state}")
                        if state == 'failed':
                            logger.error("WebRTC FAILED")

                @self.pc.on("iceconnectionstatechange")
                def on_iceconnectionstatechange():
                    logger.info(f"ICE connection: {self.pc.iceConnectionState}")

                @self.pc.on("datachannel")
                def on_datachannel(channel):
                    logger.info("DataChannel received: label=%s id=%s", channel.label, channel.id)
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

                            data.setdefault("viewerId", viewer_id)
                            data["transport"] = "datachannel"
                            asyncio.ensure_future(self.on_input(data))
                        except Exception as e:
                            logger.error(f"DataChannel input parse error: {e}")

                # Add video track
                self.screen_track = ScreenCaptureTrack()
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
            logger.info(f"=== DIAGNOSTIC LOGS FROM VIEWER ===")
            logger.info(f"User-Agent: {ua}")
            logger.info(f"Screen: {screen}")
            for line in logs:
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
                self.relay_streamer.ack(data.get("frameId"))
        except Exception as e:
            logger.debug(f"Error handling relay frame ack: {e}")

    async def on_viewer_status(self, data):
        """Update local floating overlay with viewer count and visitors."""
        try:
            logger.info(f"Viewer status: {data.get('onlineCount', 0)} online")
            if data.get("onlineCount", 0) == 0:
                self.input_handler.release_all_keys(reason="viewer-disconnected")
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
            while True:
                await asyncio.sleep(1)
                t0 = time.perf_counter()
                await asyncio.sleep(0)  # yield to event loop
                lag_ms = (time.perf_counter() - t0) * 1000
                if lag_ms > 20:
                    logger.warning("Event loop lag: %.1fms (loop may be blocked)", lag_ms)

        lag_task = asyncio.create_task(monitor_event_loop_lag())

        async def monitor_input_stale():
            while True:
                await asyncio.sleep(2)
                try:
                    await self.input_handler.check_stale_keys()
                except Exception as e:
                    logger.debug(f"Input stale check error: {e}")

        stale_task = asyncio.create_task(monitor_input_stale())

        try:
            while True:
                await asyncio.sleep(1)
                if not self.sio or not self.sio.connected:
                    await self.ensure_connected()
        except KeyboardInterrupt:
            logger.info("Shutting down...")
        finally:
            lag_task.cancel()
            stale_task.cancel()
            if self.relay_streamer:
                await self.relay_streamer.stop()
            if self.pc:
                await self.pc.close()
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
