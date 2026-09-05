#!/usr/bin/env python3
"""
Python-based macOS Host for Web Remote Desktop
Captures screen using MSS and streams via aiortc (WebRTC)
"""

import asyncio
import contextvars
import hashlib
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
import inspect
import resource
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
from h264_videotoolbox_encoder import (
    H264VideoToolboxEncoder,
)
from h264_encoder_policy import (
    H264SessionPolicyProvider,
    MediaSessionIntent,
    policy_version_from_environment,
)
from media_timing import RtpFrameClock
from observability import configure_host_logging, emit_host_event, summarize_input_event
from aiortc_media_sender import AiortcMediaSender
from adapters import CaptureAdapter, InputAdapter, LifecycleCoordinator, MediaSenderAdapter

if __name__ == "__main__":
    configure_host_logging()
else:
    logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def _noop_async():
    return None

V2_INPUT_ACK_STATUSES = frozenset({
    "applied",
    "duplicate",
    "stale-lease",
    "sequence-gap",
    "resync-required",
    "invalid-input",
    "unsupported-code",
    "execution-failed",
})

# aiortc's encoder factory has no sender parameter. Its sender coroutine
# supplies the immutable policy snapshot for just that PeerConnection.
_sender_h264_policy = contextvars.ContextVar("wrd_sender_h264_policy", default=None)

# Monkey-patch aiortc to use VideoToolbox hardware encoder for H.264
try:
    import aiortc.codecs as _aiortc_codecs
    import aiortc.rtcrtpsender as _aiortc_rtcrtpsender
    _original_get_encoder = _aiortc_codecs.get_encoder
    _original_next_encoded_frame = _aiortc_rtcrtpsender.RTCRtpSender._next_encoded_frame

    async def _patched_next_encoded_frame(sender, codec):
        token = _sender_h264_policy.set(getattr(sender, "_wrd_h264_policy", None))
        try:
            return await _original_next_encoded_frame(sender, codec)
        finally:
            _sender_h264_policy.reset(token)

    def _patched_get_encoder(codec):
        if codec.mimeType.lower() == "video/h264":
            policy = _sender_h264_policy.get()
            if policy is not None:
                logger.info("Using session-bound custom H.264 encoder for negotiated codec: %s", codec)
                return H264VideoToolboxEncoder(policy=policy)
            # Never source a policy from process-global state for an arbitrary
            # aiortc sender outside this Host session.
            return _original_get_encoder(codec)
        logger.info("Using aiortc default encoder for negotiated codec: %s", codec)
        return _original_get_encoder(codec)

    _aiortc_codecs.get_encoder = _patched_get_encoder
    _aiortc_rtcrtpsender.get_encoder = _patched_get_encoder
    _aiortc_rtcrtpsender.RTCRtpSender._next_encoded_frame = _patched_next_encoded_frame

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

LOCK_AUTO_SHRINK_SIZES = {(640, 360), (854, 480)}
PRESENTATION_RUNGS = {(960, 540), (1280, 720), (1600, 900), (1920, 1080)}

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


def normalize_network_mode(mode):
    value = str(mode or "").strip().lower()
    if value in {"lan", "auto", "stun", "relay", "tunnel"}:
        return value
    return ""


def should_include_turn_for_mode(mode):
    """Session-scoped TURN: always on for relay; optional for auto; never for lan/stun/tunnel."""
    normalized = normalize_network_mode(mode)
    if normalized == "relay":
        return True
    if normalized in {"lan", "stun", "tunnel"}:
        return False
    # auto / unknown: include TURN only when not under strict-stun default policy
    return not is_strict_stun_policy()


def normalize_turn_url(url):
    """Match signal-server normalizeTurnUrl so env/json fingerprints agree."""
    raw = str(url or "").strip()
    if not raw:
        return ""
    match = re.match(r"^(turns?):([^?]+)(?:\?(.*))?$", raw, flags=re.IGNORECASE)
    if not match:
        return raw
    scheme = match.group(1).lower()
    host_port = match.group(2).strip()
    query = match.group(3) or ""
    transport = "udp"
    for part in query.split("&"):
        if not part:
            continue
        key, _, value = part.partition("=")
        if key.strip().lower() == "transport" and value.strip():
            candidate = value.strip().lower()
            transport = candidate if candidate in {"udp", "tcp"} else "udp"
            break
    return f"{scheme}:{host_port}?transport={transport}"


def normalize_turn_urls(value):
    if isinstance(value, (list, tuple)):
        items = [str(item).strip() for item in value if str(item or "").strip()]
    else:
        items = split_env_list(value)
    normalized = []
    for item in items:
        url = normalize_turn_url(item)
        if url and url not in normalized:
            normalized.append(url)
    return normalized


def get_turn_fingerprint(turn_urls=None, username=None):
    try:
        from turn_catalog import get_turn_fingerprint as catalog_fingerprint
        from turn_catalog import get_cached_turn_catalog, resolve_turn_server
    except ImportError:
        catalog_fingerprint = None
        get_cached_turn_catalog = None
        resolve_turn_server = None

    if catalog_fingerprint is not None and turn_urls is None and username is None:
        catalog = get_cached_turn_catalog()
        selected = resolve_turn_server(catalog, catalog.get("defaultId"))
        if selected:
            return catalog_fingerprint(selected.get("urls"), selected.get("username"))
    if catalog_fingerprint is not None:
        return catalog_fingerprint(turn_urls, username)

    raw_urls = turn_urls if turn_urls is not None else os.environ.get("TURN_URLS")
    urls = sorted(normalize_turn_urls(raw_urls))
    user = str(username if username is not None else os.environ.get("TURN_USERNAME") or "").strip()
    if not urls:
        return ""
    material = f"{','.join(urls)}|{user}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def get_host_turn_capability(selected_turn_server_id=None):
    try:
        from turn_catalog import get_cached_turn_catalog, resolve_turn_server
    except ImportError:
        turn_urls = normalize_turn_urls(os.environ.get("TURN_URLS"))
        turn_username = str(os.environ.get("TURN_USERNAME") or "").strip()
        turn_credential = str(os.environ.get("TURN_CREDENTIAL") or "").strip()
        turn_ready = bool(turn_urls and turn_username and turn_credential)
        return {
            "turnReady": turn_ready,
            "turnFingerprint": get_turn_fingerprint(turn_urls, turn_username) if turn_ready else "",
            "supportsSessionTurn": True,
            "supportsMultiTurn": False,
            "turnServerId": "",
            "defaultTurnServerId": "",
            "turnServerIds": [],
        }

    catalog = get_cached_turn_catalog()
    servers = list(catalog.get("servers") or [])
    default_id = str(catalog.get("defaultId") or "")
    selected = resolve_turn_server(catalog, selected_turn_server_id or default_id)
    configured_servers = [server for server in servers if server.get("configured")]
    turn_ready = bool(selected and selected.get("configured")) or bool(configured_servers)
    selected_id = str((selected or {}).get("id") or default_id or "")
    fingerprint = ""
    if selected and selected.get("configured"):
        fingerprint = str(selected.get("fingerprint") or "")
    elif configured_servers:
        fingerprint = str(configured_servers[0].get("fingerprint") or "")
    return {
        "turnReady": turn_ready,
        "turnFingerprint": fingerprint,
        "supportsSessionTurn": True,
        "supportsMultiTurn": len(servers) >= 1,
        "turnServerId": selected_id,
        "defaultTurnServerId": default_id,
        "turnServerIds": [str(server.get("id") or "") for server in servers if server.get("id")],
    }


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


def is_lock_rejected_size(width, height) -> bool:
    return (int(width), int(height)) in LOCK_AUTO_SHRINK_SIZES


def build_ice_servers(mode="auto", turn_server_id=None):
    """Build Host ICE config; TURN inclusion is session/mode/id scoped."""
    ice_servers = []
    normalized_mode = normalize_network_mode(mode) or "auto"
    stun_urls = split_env_list(
        os.environ.get("STUN_URLS", "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302")
    )
    # relay mode: TURN only — avoid host/srflx distraction (no iceTransportPolicy in aiortc).
    if stun_urls and normalized_mode != "relay":
        ice_servers.append(RTCIceServer(urls=stun_urls))

    turn_urls = []
    turn_username = ""
    turn_credential = ""
    selected_id = ""
    try:
        from turn_catalog import get_cached_turn_catalog, resolve_turn_server
        catalog = get_cached_turn_catalog()
        selected = resolve_turn_server(catalog, turn_server_id)
        if selected:
            turn_urls = normalize_turn_urls(selected.get("urls") or [])
            turn_username = str(selected.get("username") or "").strip()
            turn_credential = str(selected.get("credential") or "").strip()
            selected_id = str(selected.get("id") or "")
    except ImportError:
        turn_urls = normalize_turn_urls(os.environ.get("TURN_URLS"))
        turn_username = str(os.environ.get("TURN_USERNAME") or "").strip()
        turn_credential = str(os.environ.get("TURN_CREDENTIAL") or "").strip()

    include_turn = should_include_turn_for_mode(mode)

    if turn_urls and not include_turn:
        logger.info(
            "WRD_POLICY_INFO turn_omitted_for_mode mode=%s turn_server_id=%s turn_urls=%s",
            normalized_mode,
            selected_id or turn_server_id or "-",
            ",".join(turn_urls),
        )
    elif turn_urls and turn_username and turn_credential and include_turn:
        ice_servers.append(
            RTCIceServer(
                urls=turn_urls,
                username=turn_username,
                credential=turn_credential,
            )
        )
        logger.info(
            "TURN relay configured for Host ICE: mode=%s turn_server_id=%s urls=%s fingerprint=%s",
            normalized_mode,
            selected_id or turn_server_id or "-",
            ",".join(turn_urls),
            get_turn_fingerprint(turn_urls, turn_username)[:12],
        )
    elif turn_urls and include_turn:
        logger.warning(
            "TURN urls present for turn_server_id=%s but username/credential missing; TURN disabled",
            selected_id or turn_server_id or "-",
        )

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
        self.suspended = False
        self.production_generation = 0
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

    @property
    def running(self):
        return bool(self.enabled and self.task is not None and not self.suspended)

    def _profile_spec(self, profile_name):
        return TUNNEL_RELAY_PROFILES.get(profile_name) or TUNNEL_RELAY_PROFILES["medium"]

    def _profile_index(self, profile_name):
        try:
            return TUNNEL_RELAY_PROFILE_ORDER.index(profile_name)
        except ValueError:
            return TUNNEL_RELAY_PROFILE_ORDER.index("medium")

    def _pick_initial_profile(self, width, height, fps):
        """Pick a conservative start profile.

        Never open on "high": JPEG-over-Socket.IO easily backpressures at 1280x720,
        which freezes the stream at survival. Stable ACK feedback can still step up.
        """
        width = int(width or 0)
        height = int(height or 0)
        fps = int(fps or 0)
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
        # Never auto-promote above medium. High (1280x720 JPEG) frequently
        # reintroduces pre-capture-backpressure even after a short good-ack streak.
        floor_index = self._profile_index("medium")
        next_index = max(floor_index, current - 1)
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
        self.suspended = False
        self.production_generation += 1
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
        self.suspended = False
        self.inflight_frames = {}
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
            self.task = None

    def set_suspended(self, suspended):
        """Pause production without tearing down the relay task lifecycle."""
        suspended = bool(suspended)
        self.suspended = suspended
        if suspended:
            # Invalidate queued work; tolerate one already in-flight emit.
            self.inflight_frames = {}
            self.production_generation += 1
            self.ack_event.set()
        else:
            self.production_generation += 1
            self.ack_event.set()
        return self.production_generation

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
                if self.suspended:
                    # No new capture/encode/emit while media is intentionally suspended.
                    await asyncio.sleep(max(0.05, frame_interval))
                    continue
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
                production_generation = self.production_generation
                try:
                    if self.suspended:
                        continue
                    shot = sct.grab(monitor)
                    if self.suspended or production_generation != self.production_generation:
                        continue
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
                    if self.suspended or production_generation != self.production_generation:
                        self.inflight_frames.pop(frame_id, None)
                        continue
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
                            "productionGeneration": production_generation,
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


def ice_candidate_type_from_sdp(candidate_sdp: str) -> str:
    text = str(candidate_sdp or "").strip()
    if text.startswith("candidate:"):
        text = text[len("candidate:"):]
    parts = text.split()
    if "typ" in parts:
        idx = parts.index("typ")
        if idx + 1 < len(parts):
            return str(parts[idx + 1]).lower()
    return ""


def should_emit_ice_candidate(mode, candidate_sdp: str) -> bool:
    normalized = normalize_network_mode(mode) or "auto"
    if normalized != "relay":
        return True
    return ice_candidate_type_from_sdp(candidate_sdp) == "relay"


def filter_sdp_ice_candidates(mode, sdp: str) -> str:
    normalized = normalize_network_mode(mode) or "auto"
    if normalized != "relay" or not sdp:
        return sdp
    lines = str(sdp).splitlines()
    kept = []
    for line in lines:
        if line.startswith("a=candidate:"):
            candidate = line[len("a="):]
            if not should_emit_ice_candidate(normalized, candidate):
                continue
        kept.append(line)
    # Preserve whether original ended with a trailing newline.
    body = "\r\n".join(kept)
    if str(sdp).endswith("\n"):
        return body + ("\r\n" if "\r\n" in str(sdp) else "\n")
    return body


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
        self._frame_clock = RtpFrameClock()
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
        self._activity_condition = threading.Condition()
        self._suspended = False
        self._capture_generation = 0
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
            with self._activity_condition:
                while self._capture_running and self._suspended:
                    self._activity_condition.wait(timeout=0.2)
                if not self._capture_running:
                    break
            with self._target_lock:
                target_fps = self._target_fps
            _min_interval = 1.0 / self.capture_fps_for_target(target_fps)
            t0 = time.perf_counter()
            try:
                # Gate again immediately before MSS grab.
                if self._suspended or not self._capture_running:
                    continue
                shot = self.sct.grab(self.monitor)
                with self._capture_lock:
                    if self._suspended:
                        continue
                    self._capture_buffer = shot
                    self._capture_seq += 1
                with self._activity_condition:
                    self._activity_condition.notify_all()
            except Exception:
                time.sleep(0.005)
                continue
            elapsed = time.perf_counter() - t0
            sleep_time = max(0.0, _min_interval - elapsed)
            if sleep_time > 0.001:
                time.sleep(sleep_time)

    def set_suspended(self, suspended):
        """Gate MSS capture/conversion. Returns capture_seq baseline at transition."""
        suspended = bool(suspended)
        with self._activity_condition:
            was = self._suspended
            self._suspended = suspended
            if was != suspended:
                self._capture_generation += 1
            self._activity_condition.notify_all()
        if suspended:
            with self._capture_lock:
                self._capture_buffer = None
                self._last_img = None
            with self._pending_input_lock:
                self._pending_input_ids.clear()
                self._pending_input_data.clear()
        else:
            self._last_frame_time = 0
        return int(self._capture_seq or 0)

    def wait_for_fresh_capture(self, after_seq, timeout=0.5):
        deadline = time.monotonic() + max(0.0, float(timeout))
        with self._activity_condition:
            while self._capture_running and not self._suspended and self._capture_seq <= after_seq:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._activity_condition.wait(timeout=remaining)
        return self._capture_seq > after_seq

    async def shutdown(self):
        """Async shutdown: never blocks the event loop."""
        with self._activity_condition:
            self._capture_running = False
            self._suspended = False
            self._activity_condition.notify_all()
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
        return self._frame_clock.next_timestamp()

    async def recv(self):
        loop = asyncio.get_event_loop()
        recv_start = time.perf_counter()
        sleep_time = 0.0

        # Suspended: block until resumed/stop. Do not return blank frames that
        # would still be encoded and inflate RTP while media is paused.
        while self._suspended and self._capture_running:
            await asyncio.sleep(0.05)
        if not self._capture_running:
            pts, time_base = await self.next_timestamp()
            blank = np.zeros((max(1, self._max_height // 4), max(1, self._max_width // 4), 3), dtype=np.uint8)
            frame = VideoFrame.from_ndarray(blank, format="rgb24")
            frame.pts = pts
            frame.time_base = time_base
            return frame

        # Frame-rate control
        now = time.time()
        elapsed = now - self._last_frame_time
        if elapsed < self._frame_interval:
            sleep_time = self._frame_interval - elapsed
            await asyncio.sleep(sleep_time)
        # Re-check after pacing sleep: suspension may have started mid-wait.
        if self._suspended:
            while self._suspended and self._capture_running:
                await asyncio.sleep(0.05)
            if not self._capture_running:
                pts, time_base = await self.next_timestamp()
                blank = np.zeros((max(1, self._max_height // 4), max(1, self._max_width // 4), 3), dtype=np.uint8)
                frame = VideoFrame.from_ndarray(blank, format="rgb24")
                frame.pts = pts
                frame.time_base = time_base
                return frame
        self._last_frame_time = time.time()

        capture_prepare_start = time.perf_counter()

        # Zero-wait: grab latest capture from background thread
        with self._capture_lock:
            if self._suspended:
                screenshot = None
                seq = self._capture_seq
            else:
                screenshot = self._capture_buffer
                seq = self._capture_seq
                self._capture_buffer = None

        capture_wait = 0.0  # never block — capture runs independently

        if self._suspended:
            while self._suspended and self._capture_running:
                await asyncio.sleep(0.05)
            # After resume, fall through to capture a fresh frame on next loop.
            return await self.recv()

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
        prev_w = getattr(self, "_max_width", None)
        prev_h = getattr(self, "_max_height", None)
        next_w = int(profile.get("width") or prev_w or 1280)
        next_h = int(profile.get("height") or prev_h or 720)
        size_changed = prev_w != next_w or prev_h != next_h
        self.set_max_resolution(next_w, next_h)
        self.set_target_fps(profile["target_fps"])
        return {"sizeChanged": size_changed, "width": next_w, "height": next_h}

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
        # Resolve this Host-local enum at startup. Unknown values fail before a
        # media session or PeerConnection is created.
        self._h264_policy_version = policy_version_from_environment()
        self._h264_policy_provider = H264SessionPolicyProvider()
        self.sio = None
        self.pc = None
        self.token = None
        self.screen_track = None
        self.video_sender = None
        self.media_sender = MediaSenderAdapter()
        self.current_viewer_id = None
        self.pending_candidates = []
        self.input_handler = InputHandler()
        self.input_handler.start()
        self.input_adapter = InputAdapter(self.input_handler)
        self.capture_adapter = None
        self.overlay = OverlayNotifier()
        self.relay_streamer = None
        self.lifecycle_coordinator = LifecycleCoordinator(
            close_peer=lambda: self._close_peer_connection(reason="host-stop", reset_offer_state=True),
            stop_relay=lambda: self.relay_streamer.stop() if self.relay_streamer else _noop_async(),
            disconnect=lambda: self.sio.disconnect() if self.sio and self.sio.connected else _noop_async(),
            stop_overlay=self.overlay.stop,
        )
        self._input_datachannel = None
        self._input_move_datachannel = None
        self._active_input_binding = None
        self._connection_generation = 0
        self._input_lifecycle_tasks = set()
        self._control_transition_lock = asyncio.Lock()
        self._offer_lock = asyncio.Lock()
        self._media_activity_lock = asyncio.Lock()
        self._offer_epoch = 0
        self._reconnecting = False
        self._last_diag_network = None
        self._stall_decoder_refresh_armed = False
        self._stall_decoder_refresh_at = 0.0
        self.media_profile = dict(MEDIA_PROFILE_DEFAULT)
        # User-owned presentation size (resolution-change / adaptive size). Quality Lock
        # ignores media-profile size when adaptiveResolution is false.
        self._user_resolution = {
            "width": MEDIA_PROFILE_DEFAULT["width"],
            "height": MEDIA_PROFILE_DEFAULT["height"],
        }
        self._last_keyframe_request_at = 0.0
        self._keyframe_recovery_state = {}
        self._stall_sample_count = 0
        self._input_event_count = 0
        self._last_input_at_monotonic = None
        # Per-offer media demand binding: generation is monotonic per attempt.
        self._media_activity_binding = None
        self._media_activity_suspended = False
        self._session_turn_server_id = None

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
        sio.on('request-keyframe', self.on_request_keyframe)
        sio.on('media-activity-change', self.on_media_activity_change)
        sio.on('relay-stream-control', self.on_relay_stream_control)
        sio.on('connection-attempt-bind', self.on_connection_attempt_bind)
        sio.on('relay-frame-ack', self.on_relay_frame_ack)
        return sio

    async def connect(self):
        try:
            if self.sio and self.sio.connected:
                return True
            if self.sio is None:
                self.sio = self._build_socket_client()
                self.relay_streamer = TunnelRelayStreamer(self.sio)

            await self.sio.connect(
                SERVER_URL,
                auth={"token": self.token, "role": "host", "inputProtocolVersion": 2},
            )
            logger.info("Connected to signaling server")
            try:
                capability = get_host_turn_capability()
                await self.sio.emit("host-capabilities", capability)
                logger.info(
                    "Host capabilities reported turnReady=%s multi=%s default=%s fingerprint=%s ids=%s",
                    capability.get("turnReady"),
                    capability.get("supportsMultiTurn"),
                    capability.get("defaultTurnServerId") or "-",
                    (capability.get("turnFingerprint") or "")[:12] or "-",
                    ",".join(capability.get("turnServerIds") or []) or "-",
                )
            except Exception as cap_err:
                logger.warning("Failed to report host capabilities: %s", cap_err)
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
            is_v2 = data.get("schemaVersion") == 2
            input_type = data.get('type')
            action = data.get('action')
            if is_v2:
                binding = getattr(self, "_active_input_binding", None)
                lease_ok = (
                    isinstance(binding, dict)
                    and viewer_id == binding.get("viewerId")
                    and data.get("leaseId") == binding.get("leaseId")
                    and data.get("leaseEpoch") == binding.get("leaseEpoch")
                )
                if not lease_ok:
                    # Mouse up/reset are safety releases: honor them even on a
                    # stale/mismatched lease so a lost-up cannot keep Host dragging
                    # after rebind or mid-transition.
                    if input_type == "mouse" and action in ("up", "reset"):
                        logger.warning(
                            "Applying mouse safety release despite lease mismatch "
                            "type=%s action=%s viewer=%s",
                            input_type,
                            action,
                            viewer_id,
                        )
                        try:
                            input_adapter = getattr(self, "input_adapter", None) or self.input_handler
                            reset_desktop = getattr(input_adapter, "reset_desktop_writes", None)
                            if callable(reset_desktop):
                                await reset_desktop(reason="stale-lease-safety")
                            else:
                                input_adapter.release_all_mouse_buttons(reason="stale-lease-safety")
                        except Exception:
                            logger.exception("Mouse safety release failed")
                        return
                    logger.warning(
                        "Ignoring input that does not match the active lease binding "
                        "type=%s action=%s viewer=%s hasBinding=%s",
                        input_type,
                        action,
                        viewer_id,
                        isinstance(binding, dict),
                    )
                    return
            elif viewer_id and self.current_viewer_id and viewer_id != self.current_viewer_id:
                logger.warning(
                    "Ignoring input from stale viewer %s (current=%s)",
                    viewer_id,
                    self.current_viewer_id,
                )
                return
            if input_type == 'dc_keepalive':
                # Viewer-side keepalive ping to prevent SCTP idle timeout and
                # maintain Chrome background-tab exemption. No action needed.
                return
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
            if input_type == 'keyboard':
                input_adapter = getattr(self, "input_adapter", None) or self.input_handler
                result = await input_adapter.apply_keyboard(data, transport=transport)
            else:
                input_adapter = getattr(self, "input_adapter", None) or self.input_handler
                result = await input_adapter.handle_input(data)
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
        if data.get("schemaVersion") == 2 and data.get("type") == "mouse":
            # Mouse actions use the v2 envelope but intentionally do not share
            # the ordered keyboard sequence/state contract. Keep their ACK
            # independently correlatable by lease and input id.
            ack = {
                "type": "input_ack",
                "schemaVersion": 2,
                "inputType": "mouse",
                "leaseEpoch": data.get("leaseEpoch"),
                **({"appliedSeq": result["appliedSeq"]} if result.get("appliedSeq") is not None else {}),
                "status": "applied" if result.get("status") == "unordered" else (result.get("status") or "applied"),
                "inputIds": list(input_ids),
                "hostExecuteMs": round(max(0.0, float(local_execute_ms or 0.0)), 3),
                "transport": transport,
            }
        elif data.get("schemaVersion") == 2:
            # v2 keyboard transport acknowledges the applied sequence and the
            # Host's post-execution state; never echo the input payload.
            pressed_key_count = result.get("pressedKeyCount")
            modifier_mask = result.get("modifierMask")
            if not isinstance(pressed_key_count, int):
                pressed_key_count = len(getattr(self.input_handler, "_pressed_key_codes", ()))
            if not isinstance(modifier_mask, int):
                modifier_mask = int(getattr(self.input_handler, "_modifier_flags", 0) or 0)
            status = result.get("status") or "applied"
            if status not in V2_INPUT_ACK_STATUSES:
                status = "execution-failed"
            ack = {
                "type": "input_ack",
                "schemaVersion": 2,
                "inputType": data.get("type"),
                "leaseEpoch": data.get("leaseEpoch"),
                "appliedSeq": result.get("appliedSeq", data.get("seq")),
                "status": status,
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

    def _offer_attempt_is_stale(self, viewer_id, offer_sequence):
        """Return True when a newer tunnel/bind sequence already owns this viewer."""
        binding = getattr(self, "_active_input_binding", None)
        if not isinstance(binding, dict):
            return False
        if binding.get("viewerId") != viewer_id:
            return False
        current_sequence = binding.get("connectionAttemptSequence")
        if not isinstance(current_sequence, int) or current_sequence < 1:
            return False
        if not isinstance(offer_sequence, int) or offer_sequence < 1:
            # A newer explicit bind already advanced authority; bare offers must not
            # clobber tunnel attempt ownership after mode switch.
            return True
        return offer_sequence < current_sequence

    @staticmethod
    def _binding_matches(left, right):
        return bool(left) and bool(right) and all(
            left.get(field) == right.get(field)
            for field in ("viewerId", "leaseId", "leaseEpoch", "connectionGeneration")
        )

    def _is_live_input_channel(self, channel):
        return channel is not None and (
            channel is getattr(self, "_input_datachannel", None)
            or channel is getattr(self, "_input_move_datachannel", None)
        )

    def _prepare_bound_datachannel_input(self, binding, data, channel=None):
        """Stamp one DataChannel message with the current live lease.

        Control grant updates `_active_input_binding` without a new offer.
        The live input/input-move channels must follow that lease; a captured
        snapshot from channel-open is only used to reject leftover channels.
        """
        if not isinstance(data, dict):
            return None
        active = getattr(self, "_active_input_binding", None)
        if self._is_live_input_channel(channel) and isinstance(active, dict):
            binding = active
        elif not self._binding_matches(binding, active):
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

    async def _transition_desktop_writes(self, *, lease_id, lease_epoch):
        """Use the serialized desktop transition when the handler provides it."""
        transition_async = getattr(self.input_handler, "transition_desktop_writes_async", None)
        if callable(transition_async):
            return await transition_async(
                lease_id=lease_id,
                lease_epoch=lease_epoch,
            )
        result = self.input_handler.transition_desktop_writes(
            lease_id=lease_id,
            lease_epoch=lease_epoch,
        )
        if inspect.isawaitable(result):
            return await result
        return result

    def _handle_datachannel_close(self, channel, _captured_binding=None):
        """Only the active reliable input channel can end a keyboard lease."""
        if getattr(channel, "label", None) == "input-move":
            if channel is getattr(self, "_input_move_datachannel", None):
                self._input_move_datachannel = None
            return
        if getattr(channel, "label", None) != "input":
            return
        if channel is not getattr(self, "_input_datachannel", None):
            return
        self._input_datachannel = None
        # The channel callback captures the binding that existed at open time,
        # but a control grant can update the live lease without rebuilding the
        # peer connection.  Always reset using the current active binding while
        # this channel is still the live input channel; never gate cleanup on
        # the stale callback snapshot.
        active_binding = getattr(self, "_active_input_binding", None)
        active_epoch = (
            active_binding.get("leaseEpoch")
            if isinstance(active_binding, dict) else None
        )
        self._schedule_input_lifecycle(
            self._reset_keyboard_lifecycle(
                "datachannel-closed",
                lease_epoch=active_epoch,
            )
        )

    async def _reset_keyboard_lifecycle(self, reason, lease_epoch=None):
        handler = getattr(self, "input_handler", None)
        if handler is None:
            return None
        result = await handler.reset_keyboard(reason=reason, lease_epoch=lease_epoch)
        reset_desktop = getattr(handler, "reset_desktop_writes", None)
        if callable(reset_desktop):
            await reset_desktop(reason=reason)
        else:
            handler.release_all_mouse_buttons(reason=reason)
        return result

    async def _emit_control_transition_ack(self, lease_epoch, status, reason=None):
        sio = getattr(self, "sio", None)
        if sio is None:
            return
        payload = {"leaseEpoch": lease_epoch, "status": status}
        if reason is not None:
            payload["reason"] = reason
        await sio.emit("control-transition-ack", payload)

    async def on_control_transition(self, data):
        """Acknowledge Signal's reset barrier before any new keyboard lease is active."""
        lock = getattr(self, "_control_transition_lock", None)
        if lock is None:
            lock = self._control_transition_lock = asyncio.Lock()
        async with lock:
            await self._apply_control_transition(data)

    async def _apply_control_transition(self, data):
        if not isinstance(data, dict):
            return
        lease_epoch = data.get("leaseEpoch")
        if not isinstance(lease_epoch, int) or lease_epoch < 1:
            return
        lease_id = data.get("leaseId")
        viewer_id = data.get("viewerId")
        has_binding_identity = (
            isinstance(lease_id, str)
            and len(lease_id) >= 16
            and isinstance(viewer_id, str)
            and bool(viewer_id)
        )
        active_binding = getattr(self, "_active_input_binding", None)
        active_epoch = active_binding.get("leaseEpoch") if isinstance(active_binding, dict) else None
        is_stale = isinstance(active_epoch, int) and (
            lease_epoch < active_epoch
            or (lease_epoch == active_epoch and has_binding_identity)
        )
        if is_stale:
            logger.warning(
                "Ignoring stale control transition epoch=%s active_epoch=%s",
                lease_epoch,
                active_epoch,
            )
            return
        # Freeze the previous authority before yielding to the reset queue so
        # no old Socket.IO or DataChannel input remains executable mid-handoff.
        self._active_input_binding = None
        self._connection_generation = int(getattr(self, "_connection_generation", 0) or 0) + 1

        async def reject_transition():
            self._active_input_binding = None
            logger.warning("Rejecting keyboard control transition epoch=%s", lease_epoch)
            await self._emit_control_transition_ack(
                lease_epoch,
                "rejected",
                reason="reset-failed",
            )

        try:
            reset_result = await self._reset_keyboard_lifecycle(
                data.get("reason") or "pending-reset"
            )
        except Exception:
            await reject_transition()
            return
        if not isinstance(reset_result, dict) or reset_result.get("status") != "applied":
            await reject_transition()
            return
        if has_binding_identity:
            binding = {
                "viewerId": viewer_id,
                "leaseId": lease_id,
                "leaseEpoch": lease_epoch,
                "connectionGeneration": self._connection_generation,
            }
            try:
                result = await self.input_handler.transition_keyboard(
                    connection_generation=binding["connectionGeneration"],
                    lease_id=binding["leaseId"],
                    lease_epoch=binding["leaseEpoch"],
                )
                desktop_result = await self._transition_desktop_writes(
                    lease_id=binding["leaseId"], lease_epoch=binding["leaseEpoch"],
                )
            except Exception:
                await reject_transition()
                return
            if not isinstance(result, dict) or result.get("status") != "applied" or desktop_result.status != "applied":
                await reject_transition()
                return
            self._active_input_binding = binding
        elif isinstance(viewer_id, str) and viewer_id:
            # Signal deliberately withholds the v2 token during transition.
            # Legacy input gets an opaque Host-internal lease until its offer
            # arrives; it is never sent to the viewer or accepted as v2 input.
            binding = {
                "viewerId": viewer_id,
                "leaseId": f"legacy-host-{lease_epoch}-{viewer_id}",
                "leaseEpoch": lease_epoch,
                "connectionGeneration": self._connection_generation,
            }
            try:
                result = await self.input_handler.transition_keyboard(
                    connection_generation=binding["connectionGeneration"],
                    lease_id=binding["leaseId"],
                    lease_epoch=binding["leaseEpoch"],
                )
                desktop_result = await self._transition_desktop_writes(
                    lease_id=binding["leaseId"], lease_epoch=binding["leaseEpoch"],
                )
            except Exception:
                await reject_transition()
                return
            if not isinstance(result, dict) or result.get("status") != "applied" or desktop_result.status != "applied":
                await reject_transition()
                return
            self._active_input_binding = binding
        else:
            self._active_input_binding = None
        await self._emit_control_transition_ack(lease_epoch, "applied")

    async def _close_peer_connection(self, reason="manual", reset_offer_state=False):
        closing_pc = getattr(self, "pc", None)
        closing_track = getattr(self, "screen_track", None)
        closing_channel = getattr(self, "_input_datachannel", None)
        closing_move_channel = getattr(self, "_input_move_datachannel", None)
        closing_candidates = getattr(self, "pending_candidates", None)
        closing_binding = getattr(self, "_active_input_binding", None)
        closing_epoch = (
            closing_binding.get("leaseEpoch")
            if isinstance(closing_binding, dict) else None
        )

        # Freeze this connection's lease before yielding to the reset worker.
        self._active_input_binding = None
        if self._input_datachannel is closing_channel:
            self._input_datachannel = None
        if getattr(self, "_input_move_datachannel", None) is closing_move_channel:
            self._input_move_datachannel = None
        await self._reset_keyboard_lifecycle(reason, lease_epoch=closing_epoch)

        if closing_pc:
            logger.info("Closing peer connection reason=%s", reason)
            await closing_pc.close()
        owns_peer = self.pc is closing_pc
        if owns_peer and self.pc is closing_pc:
            self.pc = None

        if closing_track:
            await closing_track.shutdown()
        if self.screen_track is closing_track:
            self.screen_track = None

        if self.pending_candidates is closing_candidates:
            self.pending_candidates = []

        if reset_offer_state and owns_peer:
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
            offer_sequence = data.get("connectionAttemptSequence")
            if self._offer_attempt_is_stale(viewer_id, offer_sequence):
                logger.info(
                    "Ignoring stale offer attempt viewer=%s offerSequence=%s activeSequence=%s",
                    viewer_id,
                    offer_sequence,
                    (getattr(self, "_active_input_binding", None) or {}).get("connectionAttemptSequence"),
                )
                return

            try:
                await self._close_peer_connection(reason="new-offer", reset_offer_state=False)

                lease_id = data.get("leaseId")
                lease_epoch = data.get("leaseEpoch")
                connection_attempt_id = data.get("connectionAttemptId")
                if isinstance(lease_id, str) and len(lease_id) >= 16 and isinstance(lease_epoch, int) and lease_epoch >= 1:
                    if not isinstance(connection_attempt_id, str) or not connection_attempt_id:
                        logger.warning("Ignoring offer without connectionAttemptId")
                        return
                    self._connection_generation = max(
                        int(getattr(self, "_connection_generation", 0) or 0) + 1,
                        int(data.get("connectionGeneration") or 0),
                    )
                    binding = {
                        "viewerId": viewer_id,
                        "leaseId": lease_id,
                        "leaseEpoch": lease_epoch,
                        "connectionGeneration": self._connection_generation,
                        "connectionAttemptId": connection_attempt_id,
                    }
                    if isinstance(offer_sequence, int) and offer_sequence >= 1:
                        binding["connectionAttemptSequence"] = offer_sequence
                    result = await self.input_handler.transition_keyboard(
                        connection_generation=binding["connectionGeneration"],
                        lease_id=binding["leaseId"],
                        lease_epoch=binding["leaseEpoch"],
                    )
                    if result.get("status") != "applied":
                        logger.warning("Ignoring offer with rejected keyboard binding")
                        return
                    try:
                        desktop_result = await self._transition_desktop_writes(
                            lease_id=binding["leaseId"],
                            lease_epoch=binding["leaseEpoch"],
                        )
                    except Exception:
                        logger.exception("Rejecting offer with failed desktop write binding")
                        desktop_result = None
                    if getattr(desktop_result, "status", None) != "applied":
                        logger.warning("Ignoring offer with rejected desktop write binding")
                        self._active_input_binding = None
                        try:
                            await self._reset_keyboard_lifecycle(
                                "desktop-binding-rejected",
                                lease_epoch=binding["leaseEpoch"],
                            )
                        except Exception:
                            logger.exception("Failed to clean up rejected offer binding")
                        return
                    self._active_input_binding = binding
                    # New offer/attempt invalidates prior media activity progress.
                    self._media_activity_binding = {
                        "viewerId": viewer_id,
                        "connectionAttemptId": connection_attempt_id,
                        "generation": 0,
                        "state": "active",
                    }

                try:
                    offer_width = int(data.get("width") or 0)
                    offer_height = int(data.get("height") or 0)
                except (TypeError, ValueError):
                    offer_width = 0
                    offer_height = 0
                self._bind_session_presentation(data)

                # Create peer connection with session-scoped ICE (relay always allows TURN)
                network_mode = data.get("networkMode") or data.get("iceMode") or "auto"
                turn_server_id = (
                    data.get("turnServerId")
                    or data.get("turn_server_id")
                    or getattr(self, "_session_turn_server_id", None)
                )
                self._session_turn_server_id = str(turn_server_id or "").strip() or None
                config = RTCConfiguration(
                    iceServers=build_ice_servers(network_mode, self._session_turn_server_id)
                )
                self.pc = RTCPeerConnection(configuration=config)
                try:
                    session_caps = get_host_turn_capability(self._session_turn_server_id)
                    await self.sio.emit("host-capabilities", session_caps)
                except Exception as cap_err:
                    logger.warning("Failed to refresh host TURN capability after offer: %s", cap_err)

                # Setup handlers BEFORE setting local description
                ice_complete = asyncio.Event()

                @self.pc.on("icecandidate")
                async def on_icecandidate(candidate):
                    if candidate and viewer_id:
                        if not should_emit_ice_candidate(network_mode, candidate.sdp):
                            logger.info(
                                "WRD_POLICY_INFO ice_candidate_dropped mode=%s sdp=%s",
                                network_mode,
                                (candidate.sdp or "")[:60],
                            )
                            return
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
                    elif channel.label == "input-move":
                        self._input_move_datachannel = channel

                    @channel.on("close")
                    def on_close():
                        pc_state = self.pc.connectionState if self.pc else 'no-pc'
                        ice_state = self.pc.iceConnectionState if self.pc else 'no-pc'
                        logger.warning("DataChannel CLOSED: label=%s pc=%s ice=%s",
                                       channel.label, pc_state, ice_state)
                        self._handle_datachannel_close(channel)

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

                            bound = self._prepare_bound_datachannel_input(binding, data, channel=channel)
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
                self.capture_adapter = CaptureAdapter(track=self.screen_track)
                self.screen_track._host_ref = self
                self.video_sender = self.pc.addTrack(self.screen_track)
                self.video_sender._wrd_h264_policy = self._h264_policy_provider.current_policy()
                self.media_sender = MediaSenderAdapter()
                self.media_sender.bind(self.video_sender, self.screen_track, pc=self.pc)
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
                if not (local_description and hasattr(local_description, 'sdp')):
                    logger.warning("localDescription is None after setLocalDescription")

                # Wait for ICE gathering to complete
                try:
                    await asyncio.wait_for(ice_complete.wait(), timeout=5.0)
                    logger.info("ICE gathering complete")
                except asyncio.TimeoutError:
                    logger.warning("ICE gathering timeout")

                # Send answer with ICE candidates included (relay mode filters non-relay)
                local_description = self.pc.localDescription or answer
                answer_sdp = filter_sdp_ice_candidates(
                    network_mode,
                    local_description.sdp if local_description else "",
                )
                if answer_sdp:
                    self._log_video_codecs("host-answer", answer_sdp)
                await self.sio.emit('answer', {
                    'answer': {
                        'type': local_description.type,
                        'sdp': answer_sdp
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
                "VIEWER_STATS viewer=%s codec=%s fps=%.1f rtt=%sms jitter_buffer=%sms decoded=%s received=%s lost=%s dropped=%s packets=%s nack=%s pli=%s fir=%s freeze=%s candidate=%s bytes=%.2fMB",
                data.get("viewerId", "-"),
                data.get("codec") or "unknown",
                float(data.get("fps") or 0),
                data.get("rttMs", 0),
                data.get("jitterBufferMs", 0),
                data.get("framesDecoded", 0),
                data.get("framesReceived", 0),
                data.get("packetsLost", 0),
                data.get("framesDropped", 0),
                data.get("packetsReceived", 0),
                data.get("nackCount", 0),
                data.get("pliCount", 0),
                data.get("firCount", 0),
                data.get("freezeCount", 0),
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
            fps = float(data.get("derivedFps", data.get("fps")) or 0)
            received = int(data.get("receivedDelta", data.get("framesReceived")) or 0)
            decoded = int(data.get("decodedDelta", data.get("framesDecoded")) or 0)
            warmup = data.get("warmup") is True
            suppressed = data.get("mediaHealthSuppressed") is True
            recovery_admitted = self._has_exact_recovery_identity(data)
            # A live media session has a policy intent. Do not allow a
            # legacy/unbound telemetry envelope to advance its stall counter
            # or recovery state: Signal cannot safely distinguish delayed A
            # telemetry from B after a rebind without this correlation.
            if getattr(self, "_h264_policy_provider", None) is not None and not recovery_admitted:
                return
            if not warmup and not suppressed and decoded == 0 and received > 0:
                count = int(getattr(self, "_stall_sample_count", 0) or 0) + 1
                self._stall_sample_count = count
                if count % 5 == 0:
                    logger.info(
                        "WRD_STALL_SAMPLE count=%s received=%s decoded=%s dropped=%s packets=%s nack=%s pli=%s fir=%s freeze=%s viewer=%s",
                        count,
                        received,
                        decoded,
                        int(data.get("framesDropped") or 0),
                        int(data.get("packetsReceived") or 0),
                        int(data.get("nackCount") or 0),
                        int(data.get("pliCount") or 0),
                        int(data.get("firCount") or 0),
                        int(data.get("freezeCount") or 0),
                        data.get("viewerId", "-"),
                    )
            else:
                self._stall_sample_count = 0
            if not warmup and not suppressed and recovery_admitted:
                self._observe_decoder_stall(data, received=received, decoded=decoded)
        except Exception as e:
            logger.error(f"Error handling viewer stats: {e}")

    def _locked_user_size(self):
        """Return user presentation width/height for Quality Lock."""
        user = getattr(self, "_user_resolution", None) or {}
        width = int(user.get("width") or 0)
        height = int(user.get("height") or 0)
        if width > 0 and height > 0:
            return width, height
        current = getattr(self, "media_profile", None) or {}
        return (
            int(current.get("width") or MEDIA_PROFILE_DEFAULT["width"]),
            int(current.get("height") or MEDIA_PROFILE_DEFAULT["height"]),
        )

    def _set_user_resolution(self, width, height):
        width = clamp_int(width, 320, 1920, MEDIA_PROFILE_DEFAULT["width"])
        height = clamp_int(height, 180, 1080, MEDIA_PROFILE_DEFAULT["height"])
        self._user_resolution = {"width": width, "height": height}
        profile = getattr(self, "media_profile", None)
        if isinstance(profile, dict):
            profile["width"] = width
            profile["height"] = height
        return width, height

    def _bind_session_presentation(self, data):
        width = clamp_int(data.get("width"), 320, 1920, MEDIA_PROFILE_DEFAULT["width"])
        height = clamp_int(data.get("height"), 180, 1080, MEDIA_PROFILE_DEFAULT["height"])
        prev = dict(getattr(self, "_user_resolution", None) or {})
        adopted = self._set_user_resolution(width, height)
        attempt_id = data.get("connectionAttemptId")
        if not isinstance(attempt_id, str) or not attempt_id:
            raise ValueError("connectionAttemptId is required before binding H.264 session policy")
        provider = getattr(self, "_h264_policy_provider", None)
        if provider is None:
            provider = H264SessionPolicyProvider()
            self._h264_policy_provider = provider
        provider.bind_attempt(attempt_id)
        generation = int(data.get("connectionAttemptSequence") or getattr(self, "_connection_generation", 0) or 0)
        policy_update = provider.publish(
            MediaSessionIntent(
                connection_attempt_id=attempt_id,
                generation=generation,
                path=data.get("networkMode") or data.get("iceMode") or "auto",
                width=adopted[0],
                height=adopted[1],
                target_fps=int((getattr(self, "media_profile", None) or {}).get("target_fps") or 20),
                requested_bitrate_bps=0,
                profile_sequence=0,
            ),
            getattr(self, "_h264_policy_version", None) or policy_version_from_environment(),
        )
        if not policy_update.accepted or policy_update.policy is None:
            raise ValueError(f"failed to publish H.264 policy: {policy_update.reason}")
        policy = policy_update.policy
        emit_host_event(
            logger,
            event="host_session_presentation",
            message="Session presentation bound",
            correlation={"connectionAttemptId": data.get("connectionAttemptId")},
            meta={
                "width": adopted[0],
                "height": adopted[1],
                "networkMode": data.get("networkMode") or data.get("iceMode"),
                "previousUserResolution": prev,
                "adopted": True,
                "path": data.get("networkMode") or data.get("iceMode"),
                "policyId": policy.policy_id,
                "codec": policy.codec_name,
            },
        )
        logger.info(
            "WRD_SESSION_PRESENTATION size=%sx%s path=%s previous=%s adopted=true attempt=%s policy=%s codec=%s periodicIdrFrames=%s",
            adopted[0], adopted[1],
            data.get("networkMode") or "-",
            prev,
            attempt_id,
            policy.policy_id,
            policy.codec_name,
            policy.periodic_idr_frames,
        )
        return adopted

    def _keyframe_recovery_key(self, connection_attempt_id=None, generation=None):
        current = getattr(getattr(self, "_h264_policy_provider", None), "current", lambda: None)()
        intent = getattr(current, "intent", None)
        attempt = connection_attempt_id or getattr(intent, "connection_attempt_id", "") or "-"
        resolved_generation = generation if isinstance(generation, int) and generation >= 0 else getattr(intent, "generation", 0)
        return str(attempt), int(resolved_generation or 0)

    def _has_exact_recovery_identity(self, data):
        if not isinstance(data, dict):
            return False
        current = getattr(getattr(self, "_h264_policy_provider", None), "current", lambda: None)()
        intent = getattr(current, "intent", None)
        attempt = data.get("connectionAttemptId")
        generation = data.get("generation")
        sequence = data.get("connectionAttemptSequence")
        return bool(
            intent is not None
            and isinstance(attempt, str)
            and attempt
            and isinstance(generation, int)
            and generation >= 1
            and isinstance(sequence, int)
            and sequence == generation
            and attempt == intent.connection_attempt_id
            and generation == intent.generation
        )

    def _keyframe_state(self, connection_attempt_id=None, generation=None):
        key = self._keyframe_recovery_key(connection_attempt_id, generation)
        states = getattr(self, "_keyframe_recovery_state", None)
        if not isinstance(states, dict):
            states = {}
            self._keyframe_recovery_state = states
        return key, states.setdefault(key, {
            "last_request_at": 0.0,
            "idr_requested": False,
            "post_idr_stall_samples": 0,
            "decoder_refresh_used": False,
            "next_request_sequence": 0,
            "active_request_sequence": None,
            "ack_consumed": False,
        })

    def _request_keyframe(self, reason="media-stalled", viewer_id="-", connection_attempt_id=None, generation=None, request_sequence=None):
        """Request one keyframe per current attempt/generation cooldown."""
        now = time.monotonic()
        key, state = self._keyframe_state(connection_attempt_id, generation)
        last = float(state.get("last_request_at", 0.0) or 0.0)
        reason_s = str(reason or "media-stalled")[:80]
        viewer_s = str(viewer_id or "-")[:64]
        if now - last < 1.0:
            logger.debug(
                "WRD_KEYFRAME rate-limited reason=%s viewer=%s",
                reason_s,
                viewer_s,
            )
            return False
        state["last_request_at"] = now
        state["idr_requested"] = False
        state["post_idr_stall_samples"] = 0
        if not isinstance(request_sequence, int) or request_sequence < 1:
            request_sequence = int(state.get("next_request_sequence", 0) or 0) + 1
        state["next_request_sequence"] = max(int(state.get("next_request_sequence", 0) or 0), request_sequence)
        state["active_request_sequence"] = request_sequence
        state["ack_consumed"] = False
        self._last_keyframe_request_at = now
        ok = False
        media_sender = getattr(self, "media_sender", None)
        if media_sender is not None and hasattr(media_sender, "request_keyframe"):
            try:
                ok = bool(media_sender.request_keyframe())
            except Exception as exc:
                logger.debug("media_sender keyframe failed: %s", type(exc).__name__)
                ok = False
        if not ok:
            try:
                ok = bool(AiortcMediaSender(getattr(self, "video_sender", None)).request_keyframe())
            except Exception as exc:
                logger.debug("video_sender keyframe failed: %s", type(exc).__name__)
                ok = False
        if ok:
            encoder = self._video_encoder()
            note = getattr(encoder, "note_keyframe_request", None)
            if callable(note):
                note(reason_s, key[0], key[1], request_sequence)
            state["idr_requested"] = True
        logger.info(
            "WRD_KEYFRAME requested=true emitted=%s reason=%s viewer=%s attempt=%s generation=%s codec=%s gop=%s size=%sx%s",
            "pending" if ok else "false",
            reason_s,
            viewer_s,
            key[0],
            key[1],
            getattr(getattr(self, "media_sender", None), "codec_name", "-"),
            (
                getattr(
                    (getattr(self, "_h264_policy_provider", None) or H264SessionPolicyProvider()).current_policy(),
                    "periodic_idr_frames",
                    "-",
                )
            ),
            (self._user_resolution or {}).get("width"),
            (self._user_resolution or {}).get("height"),
        )
        return ok

    def on_request_keyframe(self, data):
        """Handle viewer continuity keyframe request (lease checked by signal)."""
        try:
            payload = data if isinstance(data, dict) else {}
            reason = payload.get("reason", "media-stalled")
            viewer_id = payload.get("viewerId", "-")
            current = getattr(getattr(self, "_h264_policy_provider", None), "current", lambda: None)()
            intent = getattr(current, "intent", None)
            attempt = payload.get("connectionAttemptId")
            generation = payload.get("generation")
            connection_attempt_sequence = payload.get("connectionAttemptSequence")
            request_sequence = payload.get("requestSequence")
            if (
                intent is None
                or not isinstance(attempt, str)
                or not attempt
                or not isinstance(generation, int)
                or generation < 1
                or not isinstance(connection_attempt_sequence, int)
                or connection_attempt_sequence != generation
                or not isinstance(request_sequence, int)
                or request_sequence < 1
                or attempt != intent.connection_attempt_id
                or generation != intent.generation
            ):
                logger.info("Ignoring stale keyframe request attempt=%s generation=%s", attempt, generation)
                return
            self._request_keyframe(
                reason=reason,
                viewer_id=viewer_id,
                connection_attempt_id=attempt,
                generation=generation,
                request_sequence=request_sequence,
            )
        except Exception as e:
            logger.error(f"Error handling request-keyframe: {e}")

    async def on_resolution_change(self, data):
        """Apply viewer requested max stream resolution."""
        try:
            width = clamp_int(data.get("width"), 320, 1920, MEDIA_PROFILE_DEFAULT["width"])
            height = clamp_int(data.get("height"), 180, 1080, MEDIA_PROFILE_DEFAULT["height"])
            width, height = self._set_user_resolution(width, height)
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

    def _admit_media_profile_change(self, payload, candidate_intent, next_profile):
        """Fail closed before any profile, capture, or encoder mutation."""
        provider = getattr(self, "_h264_policy_provider", None)
        current = provider.current() if provider is not None else None
        if current is None or current.intent is None or not current.accepted:
            logger.info("Ignoring media profile without a published H.264 policy")
            return None
        intent = current.intent
        sequence = payload.get("profileSequence")
        if (
            payload.get("connectionAttemptId") != intent.connection_attempt_id
            or payload.get("generation") != intent.generation
            or type(sequence) is not int
            or sequence < 1
            or sequence > 9007199254740991
        ):
            logger.info("Ignoring media profile with invalid session identity")
            return None
        binding = getattr(self, "_active_input_binding", None)
        bound_viewer = binding.get("viewerId") if isinstance(binding, dict) else None
        expected_viewer = bound_viewer if isinstance(bound_viewer, str) else getattr(self, "current_viewer_id", None)
        if isinstance(expected_viewer, str) and expected_viewer and payload.get("viewerId") != expected_viewer:
            logger.info("Ignoring media profile from non-active viewer")
            return None
        if isinstance(binding, dict):
            bound_attempt = binding.get("connectionAttemptId")
            if not isinstance(bound_attempt, str) or bound_attempt != intent.connection_attempt_id:
                logger.info("Ignoring media profile with inactive attempt binding")
                return None
        if sequence < intent.profile_sequence:
            logger.info("Ignoring media profile with stale profile sequence")
            return None
        if sequence == intent.profile_sequence:
            profile_same = all(
                (getattr(self, "media_profile", None) or {}).get(key) == next_profile.get(key)
                for key in ("profile", "width", "height", "target_fps", "video_bitrate_kbps")
            )
            if candidate_intent != intent or not profile_same:
                logger.info("Ignoring conflicting media profile replay")
                return None
        return current

    def on_media_profile_change(self, data):
        """Apply adaptive media profile requested by the active viewer."""
        try:
            payload = data if isinstance(data, dict) else {}
            policy_provider = getattr(self, "_h264_policy_provider", None)
            allowed_profiles = {"high", "medium", "low", "survival"}
            profile = payload.get("profile") if payload.get("profile") in allowed_profiles else "medium"
            # Quality Lock default: missing adaptiveResolution means false.
            adaptive_resolution = payload.get("adaptiveResolution") is True
            requested_width = clamp_int(payload.get("width"), 320, 1920, 960)
            requested_height = clamp_int(payload.get("height"), 180, 1080, 540)
            current = dict(getattr(self, "media_profile", None) or {})
            if adaptive_resolution:
                width, height = requested_width, requested_height
            else:
                if is_lock_rejected_size(requested_width, requested_height):
                    width, height = self._locked_user_size()
                    logger.info(
                        "WRD_MEDIA_PROFILE size locked user=%sx%s requested=%sx%s viewer=%s adaptiveResolution=%s",
                        width,
                        height,
                        requested_width,
                        requested_height,
                        payload.get("viewerId", "-"),
                        adaptive_resolution,
                    )
                elif (requested_width, requested_height) in PRESENTATION_RUNGS:
                    width, height = requested_width, requested_height
                else:
                    width, height = self._locked_user_size()
                    if requested_width != width or requested_height != height:
                        logger.info(
                            "WRD_MEDIA_PROFILE size locked user=%sx%s requested=%sx%s viewer=%s adaptiveResolution=%s",
                            width,
                            height,
                            requested_width,
                            requested_height,
                            payload.get("viewerId", "-"),
                            adaptive_resolution,
                        )
            next_profile = {
                "profile": profile,
                "width": width,
                "height": height,
                "target_fps": clamp_int(payload.get("targetFps"), 5, 30, 15),
                "video_bitrate_kbps": clamp_int(payload.get("videoBitrateKbps"), 250, 5000, 1400),
            }
            current_policy = policy_provider.current() if policy_provider is not None else None
            current_intent = current_policy.intent if current_policy is not None else None
            candidate_intent = MediaSessionIntent(
                connection_attempt_id=current_intent.connection_attempt_id if current_intent else "",
                generation=current_intent.generation if current_intent else -1,
                path=current_intent.path if current_intent else "",
                width=width,
                height=height,
                target_fps=next_profile["target_fps"],
                requested_bitrate_bps=next_profile["video_bitrate_kbps"] * 1000,
                profile_sequence=payload.get("profileSequence", 0),
            )
            current_policy = self._admit_media_profile_change(payload, candidate_intent, next_profile)
            if current_policy is None:
                return
            refreshed = policy_provider.refresh_profile(
                candidate_intent,
                getattr(self, "_h264_policy_version", None) or policy_version_from_environment(),
            )
            if not refreshed.accepted:
                logger.info("Ignoring media profile rejected by H.264 policy: %s", refreshed.reason)
                return
            same = (
                current.get("profile") == next_profile["profile"]
                and int(current.get("width") or 0) == next_profile["width"]
                and int(current.get("height") or 0) == next_profile["height"]
                and int(current.get("target_fps") or 0) == next_profile["target_fps"]
                and int(current.get("video_bitrate_kbps") or 0) == next_profile["video_bitrate_kbps"]
            )
            continuity_action = payload.get("continuityAction")
            viewer_id = payload.get("viewerId", "-")
            reason = str(payload.get("reason", "quality"))[:80]
            if same:
                logger.debug(
                    "WRD_MEDIA_PROFILE unchanged viewer=%s profile=%s reason=%s",
                    viewer_id,
                    next_profile["profile"],
                    reason,
                )
                if continuity_action == "keyframe":
                    self._request_keyframe(reason=reason or "keyframe", viewer_id=viewer_id)
                return
            if adaptive_resolution or (requested_width, requested_height) in PRESENTATION_RUNGS:
                self._set_user_resolution(width, height)
            self.media_profile = next_profile
            logger.info(
                "WRD_MEDIA_PROFILE viewer=%s profile=%s size=%sx%s fps=%s bitrate_kbps=%s reason=%s adaptiveResolution=%s",
                viewer_id,
                next_profile["profile"],
                next_profile["width"],
                next_profile["height"],
                next_profile["target_fps"],
                next_profile["video_bitrate_kbps"],
                reason,
                adaptive_resolution,
            )
            if self.screen_track and hasattr(self.screen_track, "apply_media_profile"):
                apply_result = self.screen_track.apply_media_profile(next_profile) or {}
            else:
                apply_result = {}
            bitrate_kbps = int(next_profile["video_bitrate_kbps"])
            encoder_reopen = bool(apply_result.get("sizeChanged"))
            bitrate_result = self._apply_encoder_bitrate_kbps(
                bitrate_kbps,
                policy=refreshed.policy if current_policy is not None else None,
            )
            logger.info(
                "WRD_ENCODER_RATE requested=%s clamped=%s effective=%s applied=%s applyMode=%s reopenRequired=%s encoderReopen=%s size=%sx%s",
                bitrate_kbps,
                bitrate_result["clamped"] // 1000,
                bitrate_result["effective"],
                bitrate_result["applied"],
                bitrate_result["applyMode"],
                bitrate_result["reopenRequired"],
                encoder_reopen,
                next_profile["width"],
                next_profile["height"],
            )
            if continuity_action == "keyframe":
                self._request_keyframe(reason=reason or "keyframe", viewer_id=viewer_id)
        except Exception as e:
            logger.error(f"Error handling media profile change: {e}")

    def _video_encoder(self):
        sender = getattr(self, "video_sender", None)
        if sender is None:
            return None
        encoder = getattr(sender, "_encoder", None)
        if encoder is None:
            encoder = getattr(sender, "_RTCRtpSender__encoder", None)
        return encoder

    def _observe_decoder_stall(self, data, *, received, decoded):
        """Escalate an admitted decoder stall only after an IDR has been observed."""
        if not self._has_exact_recovery_identity(data):
            return False
        if decoded > 0:
            _key, state = self._keyframe_state(
                data.get("connectionAttemptId"), data.get("connectionAttemptSequence"),
            )
            state["idr_requested"] = False
            state["post_idr_stall_samples"] = 0
            return False
        if received <= 0:
            return False
        key, state = self._keyframe_state(
            data.get("connectionAttemptId"), data.get("connectionAttemptSequence"),
        )
        if not state.get("idr_requested"):
            self._request_keyframe(
                reason="decoder-stalled",
                viewer_id=data.get("viewerId", "-"),
                connection_attempt_id=key[0],
                generation=key[1],
            )
            return False
        encoder = self._video_encoder()
        expected_ack = (key[0], key[1], state.get("active_request_sequence"))
        if getattr(encoder, "last_keyframe_request_ack", None) != expected_ack or state.get("decoder_refresh_used"):
            return False
        state["ack_consumed"] = True
        state["post_idr_stall_samples"] = int(state.get("post_idr_stall_samples", 0) or 0) + 1
        if state["post_idr_stall_samples"] < 2:
            return False
        refresh = getattr(encoder, "request_decoder_refresh", None)
        if callable(refresh) and refresh():
            state["decoder_refresh_used"] = True
            return True
        return False

    def _refresh_decoder_on_stall(self, data):
        """Compatibility entrypoint for the IDR-gated decoder-stall state machine."""
        try:
            received = int(data.get("receivedDelta", data.get("framesReceived")) or 0)
            decoded = int(data.get("decodedDelta", data.get("framesDecoded")) or 0)
        except (TypeError, ValueError):
            return False
        if data.get("warmup") is True or data.get("mediaHealthSuppressed") is True:
            return False
        if not self._has_exact_recovery_identity(data):
            return False
        return self._observe_decoder_stall(data, received=received, decoded=decoded)

    def _apply_encoder_bitrate_kbps(self, bitrate_kbps, policy=None):
        """Return an honest bitrate-application result for the current encoder."""
        try:
            bitrate_bps = max(250_000, min(int(bitrate_kbps) * 1000, 8_000_000))
        except (TypeError, ValueError):
            return {
                "requested": 0,
                "clamped": 0,
                "effective": 0,
                "applied": False,
                "applyMode": "invalid",
                "reopenRequired": False,
            }
        sender = getattr(self, "video_sender", None)
        if policy is not None and sender is not None:
            # Lazy creation/rebuild uses the policy owned by this sender.
            sender._wrd_h264_policy = policy
        encoder = self._video_encoder()
        if encoder is None:
            return {
                "requested": bitrate_bps,
                "clamped": bitrate_bps,
                "effective": 0,
                "applied": False,
                "applyMode": "no-encoder",
                "reopenRequired": False,
            }
        try:
            setter = getattr(encoder, "set_target_bitrate", None)
            if callable(setter):
                result = setter(bitrate_bps)
                stage = getattr(encoder, "stage_policy_update", None)
                if policy is not None and callable(stage):
                    stage(policy)
                return result
        except Exception as exc:
            logger.debug("encoder bitrate hot-update failed: %s", type(exc).__name__)
        return {
            "requested": bitrate_bps,
            "clamped": bitrate_bps,
            "effective": int(getattr(getattr(encoder, "codec", None), "bit_rate", 0) or 0),
            "applied": False,
            "applyMode": "reopen-required",
            "reopenRequired": True,
        }

    def _validate_media_activity_request(self, data):
        """Pure validation for Signal-forwarded media-activity-change (no side effects)."""
        if not isinstance(data, dict):
            return False, "invalid-envelope", None
        if data.get("schemaVersion") != 1:
            return False, "invalid-schema", None
        state = data.get("state")
        if state not in ("active", "suspended"):
            return False, "invalid-state", None
        generation = data.get("generation")
        if not isinstance(generation, int) or generation < 1:
            return False, "invalid-generation", None
        attempt_id = data.get("connectionAttemptId")
        if not isinstance(attempt_id, str) or not attempt_id:
            return False, "invalid-attempt", None
        viewer_id = data.get("viewerId")
        if not isinstance(viewer_id, str) or not viewer_id:
            return False, "invalid-viewer", None
        lease_id = data.get("leaseId")
        lease_epoch = data.get("leaseEpoch")
        if not isinstance(lease_id, str) or len(lease_id) < 16:
            return False, "invalid-lease", None
        if not isinstance(lease_epoch, int) or lease_epoch < 1:
            return False, "invalid-lease", None

        binding = getattr(self, "_active_input_binding", None)
        if not isinstance(binding, dict):
            return False, "no-active-binding", None
        if binding.get("viewerId") != viewer_id:
            return False, "viewer-mismatch", None
        if binding.get("leaseId") != lease_id or binding.get("leaseEpoch") != lease_epoch:
            return False, "stale-lease", None
        # Media activity must match the current offer binding attempt. Prior media
        # progress from a different attempt is irrelevant and must not block the
        # new attempt (generation may restart from a small value).
        bound_attempt = binding.get("connectionAttemptId")
        if isinstance(bound_attempt, str) and bound_attempt and bound_attempt != attempt_id:
            return False, "wrong-attempt", None

        current = getattr(self, "_media_activity_binding", None)
        if (
            isinstance(current, dict)
            and current.get("connectionAttemptId") == attempt_id
            and isinstance(current.get("generation"), int)
            and generation <= current["generation"]
        ):
            return False, "stale-generation", None

        return True, None, {
            "schemaVersion": 1,
            "state": state,
            "generation": generation,
            "connectionAttemptId": attempt_id,
            "viewerId": viewer_id,
            "leaseEpoch": lease_epoch,
            "reasons": data.get("reasons") if isinstance(data.get("reasons"), list) else [],
        }

    async def on_media_activity_change(self, data):
        """Apply lease-bound media suspend/resume demand from the active controller."""
        lock = getattr(self, "_media_activity_lock", None)
        if lock is None:
            lock = self._media_activity_lock = asyncio.Lock()
        async with lock:
            ok, reason, normalized = self._validate_media_activity_request(data)
            if not ok:
                await self._emit_media_activity_ack(
                    viewer_id=data.get("viewerId") if isinstance(data, dict) else None,
                    state=data.get("state") if isinstance(data, dict) else "suspended",
                    generation=data.get("generation") if isinstance(data, dict) else None,
                    connection_attempt_id=data.get("connectionAttemptId") if isinstance(data, dict) else None,
                    applied=False,
                    reject_reason=reason,
                )
                return

            applied = False
            keyframe_requested = False
            screen_track = getattr(self, "screen_track", None)
            capture_seq = int(getattr(screen_track, "_capture_seq", 0) or 0)
            step_ok = {
                "input": True,
                "sender": True,
                "capture": True,
                "relay": True,
            }
            network_mode = None
            try:
                binding = getattr(self, "_active_input_binding", None)
                if isinstance(binding, dict):
                    network_mode = binding.get("networkMode")
            except Exception:
                network_mode = None
            tunnel_mode = network_mode == "tunnel" or (
                getattr(self, "relay_streamer", None) is not None
                and getattr(self, "pc", None) is None
                and getattr(self, "video_sender", None) is None
            )
            try:
                if normalized["state"] == "suspended":
                    # 1) freeze desktop input for this attempt
                    try:
                        if getattr(self, "input_handler", None) is not None:
                            self.input_handler.release_all_mouse_buttons(reason="media-suspended")
                            if hasattr(self.input_handler, "release_all_keys"):
                                self.input_handler.release_all_keys(reason="media-suspended")
                    except Exception as exc:
                        step_ok["input"] = False
                        logger.warning("media suspend input freeze failed: %s", type(exc).__name__)
                    # 2) suspend every live video sender on the current PC
                    sender_adapter = getattr(self, "media_sender", None)
                    if sender_adapter is None:
                        sender_adapter = AiortcMediaSender(getattr(self, "video_sender", None))
                    primary_suspend = sender_adapter.suspend()
                    self.media_sender = sender_adapter
                    sender_needed = (
                        getattr(self, "video_sender", None) is not None
                        or getattr(self, "pc", None) is not None
                    )
                    if sender_needed and primary_suspend is False and getattr(self, "video_sender", None) is not None:
                        step_ok["sender"] = False
                    pc = getattr(self, "pc", None)
                    if pc is not None and hasattr(pc, "getSenders"):
                        try:
                            for sender in list(pc.getSenders() or []):
                                track = getattr(sender, "track", None)
                                if track is None and sender is getattr(self, "video_sender", None):
                                    if AiortcMediaSender(sender).suspend() is False:
                                        step_ok["sender"] = False
                                    continue
                                kind = getattr(track, "kind", None) if track is not None else None
                                if kind == "video" or sender is getattr(self, "video_sender", None) or track is screen_track:
                                    if AiortcMediaSender(sender).suspend() is False:
                                        step_ok["sender"] = False
                        except Exception as exc:
                            step_ok["sender"] = False
                            logger.warning("media suspend getSenders failed: %s", type(exc).__name__)
                    # 3) suspend capture and clear buffers (before any further recv work)
                    if screen_track is not None and hasattr(screen_track, "set_suspended"):
                        try:
                            capture_seq = screen_track.set_suspended(True)
                        except Exception as exc:
                            step_ok["capture"] = False
                            logger.warning("media suspend capture failed: %s", type(exc).__name__)
                    # 4) suspend tunnel production without tearing down control/terminal.
                    relay = getattr(self, "relay_streamer", None)
                    if relay is not None and hasattr(relay, "set_suspended"):
                        try:
                            relay.set_suspended(True)
                        except Exception as exc:
                            step_ok["relay"] = False
                            logger.warning("media suspend relay failed: %s", type(exc).__name__)
                    elif relay is not None and getattr(relay, "enabled", False):
                        try:
                            await relay.stop()
                        except Exception as exc:
                            step_ok["relay"] = False
                            logger.warning("media suspend relay stop failed: %s", type(exc).__name__)
                    applied = all(step_ok.values())
                    # Fail-closed: always land in suspended even when one step fails.
                    self._media_activity_suspended = True
                    try:
                        if screen_track is not None and hasattr(screen_track, "set_suspended"):
                            screen_track.set_suspended(True)
                    except Exception:
                        pass
                    try:
                        if getattr(self, "media_sender", None) is not None:
                            self.media_sender.suspend()
                    except Exception:
                        pass
                    emit_host_event(
                        logger,
                        event="host_media_suspended" if applied else "host_media_suspend_failed",
                        message="Host media suspended" if applied else "Host media suspend failed closed",
                        meta={
                            "generation": normalized["generation"],
                            "connectionAttemptId": normalized["connectionAttemptId"],
                            "captureSeq": capture_seq,
                            "senderEnabled": False,
                            "keyframeRequested": False,
                            "steps": step_ok,
                            "reasons": list(normalized.get("reasons") or [])[:8],
                        },
                    )
                else:
                    # Resume: capture ready, then sender/keyframe, then tunnel.
                    capture_failed_reason = None
                    relay = getattr(self, "relay_streamer", None)
                    pc = getattr(self, "pc", None)
                    pc_state = None
                    try:
                        pc_state = getattr(pc, "connectionState", None) or getattr(pc, "iceConnectionState", None)
                    except Exception:
                        pc_state = None
                    # Tunnel has no PC by design. WebRTC resume on a missing/dead PC
                    # must not wait 2s for capture or report success on a dead sender.
                    if not tunnel_mode and (pc is None or pc_state in {"closed", "failed"}):
                        step_ok["sender"] = False
                        capture_failed_reason = "closed"
                    elif screen_track is not None and hasattr(screen_track, "set_suspended"):
                        try:
                            baseline = screen_track.set_suspended(False)
                            if hasattr(screen_track, "wait_for_fresh_capture"):
                                fresh = await asyncio.to_thread(
                                    screen_track.wait_for_fresh_capture,
                                    baseline,
                                    2.0,  # relay paths need more warmup time under CPU load
                                )
                                if fresh is not True:
                                    step_ok["capture"] = False
                                    capture_failed_reason = "fresh-capture-timeout"
                            capture_seq = int(getattr(screen_track, "_capture_seq", 0) or 0)
                        except Exception as exc:
                            step_ok["capture"] = False
                            capture_failed_reason = "fresh-capture-timeout"
                            logger.warning("media resume capture failed: %s", type(exc).__name__)
                    keyframe_requested = False
                    if step_ok["capture"] and capture_failed_reason != "closed":
                        sender_adapter = getattr(self, "media_sender", None)
                        if sender_adapter is None:
                            sender_adapter = AiortcMediaSender(getattr(self, "video_sender", None))
                        resume_result = sender_adapter.resume(screen_track)
                        self.media_sender = sender_adapter
                        keyframe_requested = bool(resume_result.get("keyframeRequested"))
                        sender_present = getattr(self, "video_sender", None) is not None or getattr(sender_adapter, "_sender", None) is not None
                        if sender_present and not bool(resume_result.get("ok")):
                            step_ok["sender"] = False
                        elif not sender_present and not tunnel_mode and screen_track is not None:
                            # WebRTC path expected a sender when capture track is live.
                            step_ok["sender"] = False
                        if relay is not None and hasattr(relay, "set_suspended"):
                            try:
                                relay.set_suspended(False)
                            except Exception as exc:
                                step_ok["relay"] = False
                                logger.warning("media resume relay failed: %s", type(exc).__name__)
                        if tunnel_mode and relay is None and not sender_present and screen_track is None:
                            step_ok["relay"] = False
                    applied = all(step_ok.values())
                    if not applied:
                        # Fail closed: re-suspend and never partially restore input/media.
                        self._media_activity_suspended = True
                        try:
                            if screen_track is not None and hasattr(screen_track, "set_suspended"):
                                screen_track.set_suspended(True)
                        except Exception:
                            pass
                        try:
                            if getattr(self, "media_sender", None) is not None:
                                self.media_sender.suspend()
                        except Exception:
                            pass
                        try:
                            if relay is not None and hasattr(relay, "set_suspended"):
                                relay.set_suspended(True)
                        except Exception:
                            pass
                    else:
                        self._media_activity_suspended = False
                    emit_host_event(
                        logger,
                        event="host_media_resumed" if applied else "host_media_resume_failed",
                        message="Host media resumed" if applied else "Host media resume failed closed",
                        meta={
                            "generation": normalized["generation"],
                            "connectionAttemptId": normalized["connectionAttemptId"],
                            "captureSeq": capture_seq,
                            "senderEnabled": applied,
                            "keyframeRequested": keyframe_requested if applied else False,
                            "steps": step_ok,
                            "reason": None if applied else (capture_failed_reason or "execution-failed"),
                        },
                    )
            except Exception as exc:
                logger.error("media activity apply failed: %s", type(exc).__name__)
                applied = False
                # Stay safe/suspended on failure.
                self._media_activity_suspended = True
                try:
                    screen_track = getattr(self, "screen_track", None)
                    if screen_track is not None and hasattr(screen_track, "set_suspended"):
                        screen_track.set_suspended(True)
                except Exception:
                    pass
                try:
                    if getattr(self, "media_sender", None) is not None:
                        self.media_sender.suspend()
                except Exception:
                    pass

            if applied:
                # This binding is applied progress, not request history. Preserve
                # the previous generation so a transient failure can replay once.
                self._media_activity_binding = {
                    "viewerId": normalized["viewerId"],
                    "connectionAttemptId": normalized["connectionAttemptId"],
                    "generation": normalized["generation"],
                    "state": "suspended" if self._media_activity_suspended else normalized["state"],
                }
            reject_reason = None
            if not applied:
                reject_reason = locals().get("capture_failed_reason") or "execution-failed"
            await self._emit_media_activity_ack(
                viewer_id=normalized["viewerId"],
                state="suspended" if self._media_activity_suspended else normalized["state"],
                generation=normalized["generation"],
                connection_attempt_id=normalized["connectionAttemptId"],
                applied=applied,
                keyframe_requested=keyframe_requested if applied else False,
                reject_reason=reject_reason,
            )

    async def _emit_media_activity_ack(
        self,
        viewer_id,
        state,
        generation,
        connection_attempt_id,
        applied,
        reject_reason=None,
        keyframe_requested=False,
    ):
        sio = getattr(self, "sio", None)
        if sio is None:
            return
        payload = {
            "schemaVersion": 1,
            "state": "active" if state == "active" else "suspended",
            "generation": generation if isinstance(generation, int) else None,
            "connectionAttemptId": connection_attempt_id if isinstance(connection_attempt_id, str) else None,
            "applied": bool(applied),
            "keyframeRequested": bool(keyframe_requested),
            "viewerId": viewer_id if isinstance(viewer_id, str) else None,
        }
        if reject_reason:
            payload["reason"] = str(reject_reason)[:64]
        # Never echo leaseId.
        await sio.emit("media-activity-ack", payload)

    async def _emit_relay_stream_control_ack(
        self,
        *,
        viewer_id,
        state,
        generation,
        connection_attempt_id,
        applied,
        reject_reason=None,
    ):
        sio = getattr(self, "sio", None)
        if sio is None:
            return
        payload = {
            "schemaVersion": 1,
            "state": "active" if state == "active" else "suspended",
            "generation": generation if isinstance(generation, int) else None,
            "connectionAttemptId": connection_attempt_id if isinstance(connection_attempt_id, str) else None,
            "applied": bool(applied),
            "viewerId": viewer_id if isinstance(viewer_id, str) else None,
        }
        if reject_reason:
            payload["reason"] = str(reject_reason)[:64]
        await sio.emit("relay-stream-control-ack", payload)

    def _is_tunnel_media_control(self, data):
        if not isinstance(data, dict):
            return False
        if data.get("mediaControlSchemaVersion") == 1:
            return True
        return (
            data.get("schemaVersion") == 2
            and data.get("state") in ("active", "suspended")
            and isinstance(data.get("generation"), int)
            and isinstance(data.get("connectionAttemptId"), str)
        )

    async def _apply_tunnel_media_control(self, data):
        """Suspend/resume tunnel producer for the current attempt without rebuilding PC."""
        viewer_id = data.get("viewerId")
        state = data.get("state")
        if state not in ("active", "suspended"):
            state = "active" if data.get("enabled") else "suspended"
        generation = data.get("generation")
        attempt_id = data.get("connectionAttemptId")
        lease_id = data.get("leaseId")
        lease_epoch = data.get("leaseEpoch")

        ok, reason, _normalized = self._validate_media_activity_request({
            "schemaVersion": 1,
            "state": state,
            "generation": generation,
            "connectionAttemptId": attempt_id,
            "viewerId": viewer_id,
            "leaseId": lease_id,
            "leaseEpoch": lease_epoch,
            "reasons": data.get("reasons") if isinstance(data.get("reasons"), list) else [],
        })
        if not ok:
            await self._emit_relay_stream_control_ack(
                viewer_id=viewer_id,
                state=state,
                generation=generation,
                connection_attempt_id=attempt_id,
                applied=False,
                reject_reason=reason,
            )
            return

        applied = False
        try:
            if not self.relay_streamer:
                self.relay_streamer = TunnelRelayStreamer(self.sio)
            relay = self.relay_streamer
            if state == "suspended":
                # Freeze input + stop new capture/JPEG/relay without tearing Socket lifecycle.
                try:
                    if getattr(self, "input_handler", None) is not None:
                        self.input_handler.release_all_mouse_buttons(reason="media-suspended")
                        if hasattr(self.input_handler, "release_all_keys"):
                            self.input_handler.release_all_keys(reason="media-suspended")
                except Exception as exc:
                    logger.warning("tunnel suspend input freeze failed: %s", type(exc).__name__)
                    raise
                if hasattr(relay, "set_suspended"):
                    relay.set_suspended(True)
                else:
                    await relay.stop()
                self._media_activity_suspended = True
                applied = True
            else:
                # Resume producer for current generation; Viewer still waits for fresh frame.
                if getattr(relay, "viewer_id", None) != viewer_id or not getattr(relay, "enabled", True):
                    await relay.start(
                        viewer_id,
                        width=data.get("width", 960),
                        height=data.get("height", 540),
                        fps=data.get("fps", 8),
                    )
                if hasattr(relay, "set_suspended"):
                    relay.set_suspended(False)
                self._media_activity_suspended = False
                applied = True

            self._media_activity_binding = {
                "viewerId": viewer_id,
                "connectionAttemptId": attempt_id,
                "generation": generation,
                "state": state,
            }
        except Exception as exc:
            logger.warning("tunnel media control apply failed: %s", type(exc).__name__)
            applied = False
            try:
                if hasattr(self.relay_streamer, "set_suspended"):
                    self.relay_streamer.set_suspended(True)
            except Exception:
                pass
            self._media_activity_suspended = True
            state = "suspended"

        await self._emit_relay_stream_control_ack(
            viewer_id=viewer_id,
            state=state if applied else "suspended",
            generation=generation,
            connection_attempt_id=attempt_id,
            applied=applied,
            reject_reason=None if applied else "execution-failed",
        )

    async def on_relay_stream_control(self, data):
        """Start/stop Socket.IO tunnel video relay for networks where WebRTC ICE fails."""
        try:
            if self._is_tunnel_media_control(data):
                await self._apply_tunnel_media_control(data)
                return
            enabled = bool(data.get("enabled"))
            viewer_id = data.get("viewerId")
            if not self.relay_streamer:
                self.relay_streamer = TunnelRelayStreamer(self.sio)
            if enabled and viewer_id:
                # Attempt authority is established only by offer or
                # connection-attempt-bind. Do not invent it from relay start.
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

    async def on_connection_attempt_bind(self, data):
        """Adopt Signal's authoritative viewer/attempt bind for tunnel (no SDP offer)."""
        if not isinstance(data, dict):
            return
        binding = getattr(self, "_active_input_binding", None)
        attempt_id = data.get("connectionAttemptId")
        viewer_id = data.get("viewerId")
        if not isinstance(binding, dict) or not isinstance(attempt_id, str) or not attempt_id:
            return
        if not isinstance(viewer_id, str) or not viewer_id:
            return
        # Signal is the authority for active controller + attempt; Host only accepts
        # binds that match the currently granted viewer lease identity.
        if binding.get("viewerId") != viewer_id:
            return
        lease_id = data.get("leaseId")
        lease_epoch = data.get("leaseEpoch")
        if isinstance(lease_id, str) and lease_id and binding.get("leaseId") not in (None, lease_id):
            return
        if isinstance(lease_epoch, int) and lease_epoch >= 1 and binding.get("leaseEpoch") not in (None, lease_epoch):
            return
        sequence = data.get("connectionAttemptSequence")
        prior_sequence = binding.get("connectionAttemptSequence")
        if isinstance(sequence, int) and sequence >= 1:
            if isinstance(prior_sequence, int) and sequence < prior_sequence:
                return
            if (
                isinstance(prior_sequence, int)
                and sequence == prior_sequence
                and binding.get("connectionAttemptId") not in (None, attempt_id)
            ):
                return
            binding["connectionAttemptSequence"] = sequence
        binding["connectionAttemptId"] = attempt_id
        # Tunnel path has no offer networkMode; keep explicit tunnel when bound this way.
        if data.get("networkMode") in ("tunnel", "stun", "relay", "auto"):
            binding["networkMode"] = data.get("networkMode")
        elif not binding.get("networkMode"):
            binding["networkMode"] = "tunnel"
        self._media_activity_binding = {
            "viewerId": viewer_id,
            "connectionAttemptId": attempt_id,
            "generation": 0,
            "state": "active",
        }

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
            lifecycle_tasks = list(self._input_lifecycle_tasks)
            if lifecycle_tasks:
                await asyncio.gather(*lifecycle_tasks, return_exceptions=True)
            await self.lifecycle_coordinator.shutdown()


if __name__ == "__main__":
    host = WebRemoteHost()
    try:
        asyncio.run(host.run())
    except Exception as e:
        logger.error(f"Fatal: {e}", exc_info=True)
        sys.exit(1)
