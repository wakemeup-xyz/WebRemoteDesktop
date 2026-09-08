import sys
from dataclasses import replace
from pathlib import Path

import pytest


sys.path.insert(0, str(Path(__file__).resolve().parent))

from h264_encoder_policy import (  # noqa: E402
    H264SessionPolicyProvider,
    MediaSessionIntent,
    policy_version_from_environment,
    resolve_h264_policy,
)
from host import WebRemoteHost  # noqa: E402


def _intent(*, attempt="attempt-1", generation=1, path="relay", width=1280, height=720, bitrate=0, fps=20):
    return MediaSessionIntent(
        connection_attempt_id=attempt,
        generation=generation,
        path=path,
        width=width,
        height=height,
        target_fps=fps,
        requested_bitrate_bps=bitrate,
    )


def test_relay_policy_keeps_codec_independent_from_periodic_idr_cadence():
    policy = resolve_h264_policy(_intent(), "relay-legacy-v1")

    assert policy.codec_name == "libx264"
    assert policy.periodic_idr_frames == 20

    # The production pulse fix changes only the periodic/recovery keyframe
    # controls. Its codec and cost envelope remain the legacy relay values.
    on_demand = resolve_h264_policy(_intent(), "relay-on-demand-v1")
    assert on_demand.codec_name == "libx264"
    assert on_demand.periodic_idr_frames == 0
    assert on_demand.force_idr_option is True
    assert policy.slice_threads == 1
    assert on_demand.slice_threads == 1
    assert (
        on_demand.target_fps,
        on_demand.min_bitrate_bps,
        on_demand.target_bitrate_bps,
        on_demand.max_bitrate_bps,
        on_demand.vbv_buffer_ms,
        on_demand.preset,
        on_demand.profile,
    ) == (
        policy.target_fps,
        policy.min_bitrate_bps,
        policy.target_bitrate_bps,
        policy.max_bitrate_bps,
        policy.vbv_buffer_ms,
        policy.preset,
        policy.profile,
    )


def test_session_policy_rejects_unmeasurable_slice_thread_counts():
    policy = resolve_h264_policy(_intent(), "relay-legacy-v1")

    with pytest.raises(ValueError, match="slice_threads"):
        replace(policy, slice_threads=3)


def test_on_demand_relay_policy_leaves_direct_policy_unchanged():
    direct = resolve_h264_policy(_intent(path="direct"), "relay-on-demand-v1")

    assert direct.codec_name == "h264_videotoolbox"
    assert direct.periodic_idr_frames == 40
    assert direct.force_idr_option is False
    assert (
        direct.min_bitrate_bps,
        direct.target_bitrate_bps,
        direct.max_bitrate_bps,
        direct.vbv_buffer_ms,
        direct.preset,
    ) == (500_000, 2_500_000, 8_000_000, 100, "default")


def test_peak_sliced_policy_uses_only_qualified_relay_resolutions():
    relay_720 = resolve_h264_policy(
        _intent(width=1152, height=720, bitrate=9_000_000),
        "relay-peak-sliced-v1",
    )
    relay_1080 = resolve_h264_policy(
        _intent(width=1728, height=1080),
        "relay-peak-sliced-v1",
    )
    low_resolution = resolve_h264_policy(
        _intent(width=960, height=540),
        "relay-peak-sliced-v1",
    )
    unqualified_fps = resolve_h264_policy(
        _intent(width=1152, height=720, fps=15),
        "relay-peak-sliced-v1",
    )
    unqualified_resolution = resolve_h264_policy(
        _intent(width=1600, height=900),
        "relay-peak-sliced-v1",
    )
    direct = resolve_h264_policy(
        _intent(path="direct", width=1920, height=1080),
        "relay-peak-sliced-v1",
    )

    assert (
        relay_720.policy_id,
        relay_720.min_bitrate_bps,
        relay_720.target_bitrate_bps,
        relay_720.max_bitrate_bps,
        relay_720.vbv_maxrate_bps,
        relay_720.vbv_bufsize_kbits,
        relay_720.vbv_init,
        relay_720.preset,
        relay_720.slice_threads,
        relay_720.periodic_idr_frames,
        relay_720.force_idr_option,
    ) == (
        "relay-peak-sliced-v1", 3_200_000, 3_200_000, 3_200_000,
        4_800_000, 1_000, 1.0, "superfast", 2, 0, True,
    )
    assert (
        relay_1080.min_bitrate_bps,
        relay_1080.target_bitrate_bps,
        relay_1080.max_bitrate_bps,
        relay_1080.vbv_maxrate_bps,
        relay_1080.vbv_bufsize_kbits,
    ) == (5_000_000, 5_000_000, 5_000_000, 7_200_000, 1_300)
    assert low_resolution.policy_id == "relay-on-demand-v1"
    assert low_resolution.preset == "ultrafast"
    assert low_resolution.slice_threads == 1
    assert unqualified_fps.policy_id == "relay-on-demand-v1"
    assert unqualified_fps.target_fps == 15
    assert unqualified_resolution.policy_id == "relay-on-demand-v1"
    assert direct.codec_name == "h264_videotoolbox"
    assert direct.periodic_idr_frames == 40


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


def test_policy_environment_fails_closed_when_v2_has_no_validated_selection():
    assert policy_version_from_environment({}) == "relay-peak-sliced-v1"
    assert policy_version_from_environment({"WRD_RELAY_ENCODER_POLICY": "relay-on-demand-v1"}) == "relay-on-demand-v1"
    assert policy_version_from_environment({"WRD_RELAY_ENCODER_POLICY": "relay-legacy-v1"}) == "relay-legacy-v1"

    with pytest.raises(ValueError, match="offline gate") as exc_info:
        policy_version_from_environment({"WRD_RELAY_ENCODER_POLICY": "relay-balanced-v2"})
    assert "relay-peak-sliced-v1" in str(exc_info.value)
    assert "relay-on-demand-v1" in str(exc_info.value)
    assert "relay-legacy-v1" in str(exc_info.value)

    with pytest.raises(ValueError, match="WRD_RELAY_ENCODER_POLICY") as exc_info:
        policy_version_from_environment({"WRD_RELAY_ENCODER_POLICY": "not-a-policy"})
    assert "relay-peak-sliced-v1" in str(exc_info.value)


def test_host_constructor_rejects_unvalidated_v2_before_starting_host_resources(monkeypatch):
    monkeypatch.setenv("WRD_RELAY_ENCODER_POLICY", "relay-balanced-v2")

    with pytest.raises(ValueError, match="offline gate"):
        WebRemoteHost()


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


def test_policy_provider_requires_an_authoritative_attempt_binding():
    provider = H264SessionPolicyProvider()

    result = provider.publish(_intent(), "relay-legacy-v1")

    assert result.accepted is False
    assert result.reason == "no-active-attempt"


@pytest.mark.parametrize(
    ("requested", "expected"),
    [
        (1_000_000, (2_500_000, 2_500_000, 5_000_000)),
        (4_000_000, (2_500_000, 4_000_000, 5_000_000)),
        (9_000_000, (2_500_000, 5_000_000, 5_000_000)),
    ],
)
def test_balanced_1080p_policy_exposes_measurable_bitrate_candidates(requested, expected):
    policy = resolve_h264_policy(
        _intent(width=1920, height=1080, bitrate=requested),
        "relay-balanced-v2",
    )

    assert (
        policy.min_bitrate_bps,
        policy.target_bitrate_bps,
        policy.max_bitrate_bps,
    ) == expected


def test_profile_sequence_allows_only_identical_same_sequence_replay():
    provider = H264SessionPolicyProvider()
    provider.bind_attempt("attempt-1")
    provider.publish(_intent(generation=4), "relay-legacy-v1")
    update = MediaSessionIntent("attempt-1", 4, "relay", 1280, 720, 20, 2_000_000, 1)
    accepted = provider.refresh_profile(update, "relay-legacy-v1")
    replay = provider.refresh_profile(update, "relay-legacy-v1")
    conflict = provider.refresh_profile(
        MediaSessionIntent("attempt-1", 4, "relay", 1280, 720, 15, 1_800_000, 1),
        "relay-legacy-v1",
    )

    assert accepted.accepted is True
    assert replay.accepted is True
    assert replay.reason == "idempotent-replay"
    assert conflict.accepted is False
    assert conflict.reason == "conflicting-profile-sequence"
