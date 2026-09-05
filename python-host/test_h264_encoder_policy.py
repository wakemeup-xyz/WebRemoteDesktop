import sys
from pathlib import Path

import pytest


sys.path.insert(0, str(Path(__file__).resolve().parent))

from h264_encoder_policy import (  # noqa: E402
    H264SessionPolicyProvider,
    MediaSessionIntent,
    policy_version_from_environment,
    resolve_h264_policy,
)


def _intent(*, attempt="attempt-1", generation=1, path="relay", width=1280, height=720, bitrate=0):
    return MediaSessionIntent(
        connection_attempt_id=attempt,
        generation=generation,
        path=path,
        width=width,
        height=height,
        target_fps=20,
        requested_bitrate_bps=bitrate,
    )


def test_relay_policy_keeps_codec_independent_from_periodic_idr_cadence():
    policy = resolve_h264_policy(_intent(), "relay-legacy-v1")

    assert policy.codec_name == "libx264"
    assert policy.periodic_idr_frames == 20

    # A policy with another periodic cadence still describes the selected codec;
    # GOP is a policy field, never a codec-selection input.
    slower = resolve_h264_policy(_intent(path="relay", width=1280, height=720), "relay-balanced-v2")
    assert slower.codec_name == "libx264"
    assert slower.periodic_idr_frames == 20


@pytest.mark.parametrize(
    ("intent", "expected"),
    [
        (_intent(width=1280, height=720), (1_800_000, 1_800_000, 2_500_000)),
        (_intent(width=1920, height=1080), (2_500_000, 2_500_000, 2_500_000)),
        (_intent(path="direct", width=1280, height=720), (500_000, 2_500_000, 8_000_000)),
    ],
)
def test_legacy_policy_resolves_explicit_bitrate_ranges(intent, expected):
    policy = resolve_h264_policy(intent, "relay-legacy-v1")

    assert (
        policy.min_bitrate_bps,
        policy.target_bitrate_bps,
        policy.max_bitrate_bps,
    ) == expected


def test_policy_environment_defaults_allows_known_override_and_rejects_unknown():
    assert policy_version_from_environment({}) == "relay-legacy-v1"
    assert policy_version_from_environment({"WRD_RELAY_ENCODER_POLICY": "relay-balanced-v2"}) == "relay-balanced-v2"

    with pytest.raises(ValueError, match="WRD_RELAY_ENCODER_POLICY") as exc_info:
        policy_version_from_environment({"WRD_RELAY_ENCODER_POLICY": "not-a-policy"})
    assert "relay-legacy-v1" in str(exc_info.value)
    assert "relay-balanced-v2" in str(exc_info.value)


def test_policy_provider_rejects_old_attempt_and_old_generation_without_replacement():
    provider = H264SessionPolicyProvider()
    provider.bind_attempt("attempt-new")
    current = provider.publish(_intent(attempt="attempt-new", generation=2), "relay-legacy-v1")
    assert current.accepted is True

    stale_generation = provider.publish(_intent(attempt="attempt-new", generation=1), "relay-legacy-v1")
    stale_attempt = provider.publish(_intent(attempt="attempt-old", generation=99), "relay-legacy-v1")

    assert stale_generation.accepted is False
    assert stale_generation.reason == "stale-generation"
    assert stale_attempt.accepted is False
    assert stale_attempt.reason == "stale-attempt"
    assert provider.current().intent.generation == 2
