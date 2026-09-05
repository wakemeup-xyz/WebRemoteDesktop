"""Pure, session-scoped H.264 policy selection for the Host encoder."""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from typing import Mapping


RELAY_LEGACY_V1 = "relay-legacy-v1"
RELAY_BALANCED_V2 = "relay-balanced-v2"
SUPPORTED_POLICY_VERSIONS = frozenset({RELAY_LEGACY_V1, RELAY_BALANCED_V2})
DEFAULT_POLICY_VERSION = RELAY_LEGACY_V1


@dataclass(frozen=True)
class MediaSessionIntent:
    connection_attempt_id: str
    generation: int
    path: str
    width: int
    height: int
    target_fps: int
    requested_bitrate_bps: int


@dataclass(frozen=True)
class H264SessionPolicy:
    policy_id: str
    codec_name: str
    target_fps: int
    periodic_idr_frames: int
    keyframe_cooldown_ms: int
    min_bitrate_bps: int
    target_bitrate_bps: int
    max_bitrate_bps: int
    vbv_buffer_ms: int
    preset: str
    profile: str


@dataclass(frozen=True)
class PublishedH264Policy:
    accepted: bool
    reason: str | None
    intent: MediaSessionIntent | None
    policy: H264SessionPolicy | None


def policy_version_from_environment(environment: Mapping[str, str] | None = None) -> str:
    """Read the Host-local policy selection and reject invalid startup config."""
    source = os.environ if environment is None else environment
    value = str(source.get("WRD_RELAY_ENCODER_POLICY", DEFAULT_POLICY_VERSION)).strip()
    if not value:
        value = DEFAULT_POLICY_VERSION
    if value not in SUPPORTED_POLICY_VERSIONS:
        allowed = ", ".join(sorted(SUPPORTED_POLICY_VERSIONS))
        raise ValueError(
            "WRD_RELAY_ENCODER_POLICY must be one of "
            f"{allowed}; received {value!r}"
        )
    return value


def _is_1080p(intent: MediaSessionIntent) -> bool:
    return int(intent.height) >= 1000 or int(intent.width) * int(intent.height) >= 1920 * 1080


def _relay_legacy_bitrate_range(intent: MediaSessionIntent) -> tuple[int, int, int]:
    # Preserve the existing relay encoder's floor and 2.5 Mbps cap exactly.
    if _is_1080p(intent):
        return 2_500_000, 2_500_000, 2_500_000
    if int(intent.height) >= 700 or int(intent.width) * int(intent.height) >= 1152 * 720:
        return 1_800_000, 1_800_000, 2_500_000
    return 1_200_000, 1_200_000, 2_500_000


def _direct_bitrate_range(intent: MediaSessionIntent) -> tuple[int, int, int]:
    pixels = int(intent.width) * int(intent.height)
    if pixels <= 1280 * 720:
        target = 2_500_000
    elif pixels <= 1920 * 1080:
        target = 4_000_000
    else:
        target = 6_000_000
    return 500_000, target, 8_000_000


def resolve_h264_policy(intent: MediaSessionIntent, policy_version: str) -> H264SessionPolicy:
    """Resolve every encoder choice from an explicit session intent and version."""
    if policy_version not in SUPPORTED_POLICY_VERSIONS:
        allowed = ", ".join(sorted(SUPPORTED_POLICY_VERSIONS))
        raise ValueError(f"unsupported H.264 policy {policy_version!r}; allowed: {allowed}")
    if not isinstance(intent.connection_attempt_id, str) or not intent.connection_attempt_id:
        raise ValueError("connection_attempt_id is required for an H.264 media session")
    if not isinstance(intent.generation, int) or intent.generation < 0:
        raise ValueError("generation must be a non-negative integer")

    path = str(intent.path or "auto").lower()
    relay = path == "relay"
    if relay:
        if policy_version == RELAY_LEGACY_V1:
            minimum, target, maximum = _relay_legacy_bitrate_range(intent)
            vbv_buffer_ms = 100
        else:
            # Candidate only: Task 6 freezes balanced values after measurement.
            minimum, target, maximum = _relay_legacy_bitrate_range(intent)
            vbv_buffer_ms = 100
        requested = int(intent.requested_bitrate_bps or target)
        target = max(minimum, min(requested, maximum))
        return H264SessionPolicy(
            policy_id=policy_version,
            codec_name="libx264",
            target_fps=max(1, int(intent.target_fps or 20)),
            periodic_idr_frames=20,
            keyframe_cooldown_ms=1000,
            min_bitrate_bps=minimum,
            target_bitrate_bps=target,
            max_bitrate_bps=maximum,
            vbv_buffer_ms=vbv_buffer_ms,
            preset="ultrafast",
            profile="Baseline",
        )

    minimum, target, maximum = _direct_bitrate_range(intent)
    requested = int(intent.requested_bitrate_bps or target)
    target = max(minimum, min(requested, maximum))
    return H264SessionPolicy(
        policy_id=RELAY_LEGACY_V1,
        codec_name="h264_videotoolbox",
        target_fps=max(1, int(intent.target_fps or 20)),
        periodic_idr_frames=40,
        keyframe_cooldown_ms=1000,
        min_bitrate_bps=minimum,
        target_bitrate_bps=target,
        max_bitrate_bps=maximum,
        vbv_buffer_ms=100,
        preset="default",
        profile="Baseline",
    )


class H264SessionPolicyProvider:
    """Thread-safe current-policy provider bound to one authoritative attempt."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._active_attempt_id: str | None = None
        self._current: PublishedH264Policy | None = None

    def bind_attempt(self, connection_attempt_id: str) -> None:
        if not isinstance(connection_attempt_id, str) or not connection_attempt_id:
            raise ValueError("connection_attempt_id is required to bind an H.264 policy provider")
        with self._lock:
            self._active_attempt_id = connection_attempt_id
            self._current = None

    def publish(self, intent: MediaSessionIntent, policy_version: str) -> PublishedH264Policy:
        with self._lock:
            if self._active_attempt_id is None:
                self._active_attempt_id = intent.connection_attempt_id
            if intent.connection_attempt_id != self._active_attempt_id:
                return PublishedH264Policy(False, "stale-attempt", None, self.current_policy())
            current = self._current
            if (
                current is not None
                and current.intent is not None
                and intent.generation <= current.intent.generation
            ):
                return PublishedH264Policy(False, "stale-generation", current.intent, current.policy)
            policy = resolve_h264_policy(intent, policy_version)
            published = PublishedH264Policy(True, None, intent, policy)
            self._current = published
            return published

    def refresh_profile(self, intent: MediaSessionIntent, policy_version: str) -> PublishedH264Policy:
        """Refresh policy inputs only for the current attempt and generation."""
        with self._lock:
            current = self._current
            if self._active_attempt_id != intent.connection_attempt_id:
                return PublishedH264Policy(False, "stale-attempt", None, self.current_policy())
            if current is None or current.intent is None or intent.generation != current.intent.generation:
                return PublishedH264Policy(False, "stale-generation", current.intent if current else None, current.policy if current else None)
            policy = resolve_h264_policy(intent, policy_version)
            published = PublishedH264Policy(True, None, intent, policy)
            self._current = published
            return published

    def current(self) -> PublishedH264Policy | None:
        with self._lock:
            return self._current

    def current_policy(self) -> H264SessionPolicy | None:
        current = self.current()
        return current.policy if current is not None else None
