import logging

from host import ScreenCaptureTrack, WebRemoteHost


class ListHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        self.records.append(record)


def test_media_profile_change_updates_host_state_and_logs():
    host = object.__new__(WebRemoteHost)
    host.media_profile = {
        "profile": "high",
        "width": 1280,
        "height": 720,
        "target_fps": 20,
        "video_bitrate_kbps": 2500,
    }
    host._user_resolution = {"width": 1280, "height": 720}
    host._last_keyframe_request_at = 0.0
    host.screen_track = None
    host.media_sender = None
    host.video_sender = None

    handler = ListHandler()
    logger = logging.getLogger("host")
    original_level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

    try:
        # adaptiveResolution true preserves legacy size-ladder behaviour.
        host.on_media_profile_change({
            "viewerId": "viewer-1",
            "profile": "low",
            "width": 854,
            "height": 480,
            "targetFps": 12,
            "videoBitrateKbps": 900,
            "reason": "packet-loss",
            "adaptiveResolution": True,
        })
    finally:
        logger.removeHandler(handler)
        logger.setLevel(original_level)

    assert host.media_profile["profile"] == "low"
    assert host.media_profile["width"] == 854
    assert host.media_profile["height"] == 480
    assert host.media_profile["target_fps"] == 12
    assert host.media_profile["video_bitrate_kbps"] == 900
    assert any("WRD_MEDIA_PROFILE viewer=viewer-1 profile=low" in record.getMessage() for record in handler.records)


def test_invalid_media_profile_is_clamped():
    host = object.__new__(WebRemoteHost)
    host.media_profile = {
        "profile": "high",
        "width": 1280,
        "height": 720,
        "target_fps": 20,
        "video_bitrate_kbps": 2500,
    }
    host._user_resolution = {"width": 1280, "height": 720}
    host._last_keyframe_request_at = 0.0
    host.screen_track = None
    host.media_sender = None
    host.video_sender = None

    host.on_media_profile_change({
        "viewerId": "viewer-1",
        "profile": "invalid",
        "width": 99999,
        "height": 1,
        "targetFps": 99,
        "videoBitrateKbps": 99999,
        "reason": "bad",
        "adaptiveResolution": True,
    })

    assert host.media_profile["profile"] == "medium"
    assert host.media_profile["width"] == 1920
    assert host.media_profile["height"] == 180
    assert host.media_profile["target_fps"] == 30
    assert host.media_profile["video_bitrate_kbps"] == 5000


def test_stale_profile_generation_cannot_override_current_h264_policy():
    from h264_encoder_policy import H264SessionPolicyProvider, MediaSessionIntent

    host = object.__new__(WebRemoteHost)
    host.media_profile = {
        "profile": "high",
        "width": 1280,
        "height": 720,
        "target_fps": 20,
        "video_bitrate_kbps": 2500,
    }
    host._user_resolution = {"width": 1280, "height": 720}
    host._last_keyframe_request_at = 0.0
    host.screen_track = None
    host.media_sender = None
    host.video_sender = None
    host._h264_policy_version = "relay-legacy-v1"
    host._h264_policy_provider = H264SessionPolicyProvider()
    host._h264_policy_provider.bind_attempt("attempt-current")
    host._h264_policy_provider.publish(
        MediaSessionIntent("attempt-current", 3, "relay", 1280, 720, 20, 0),
        "relay-legacy-v1",
    )

    host.on_media_profile_change({
        "viewerId": "viewer-1",
        "connectionAttemptId": "attempt-current",
        "generation": 2,
        "profile": "low",
        "width": 854,
        "height": 480,
        "targetFps": 12,
        "videoBitrateKbps": 900,
        "reason": "stale",
        "adaptiveResolution": True,
    })

    assert host.media_profile["profile"] == "high"
    assert host.media_profile["video_bitrate_kbps"] == 2500


def test_current_profile_sequence_applies_once_and_rejects_lower_sequence():
    from h264_encoder_policy import H264SessionPolicyProvider, MediaSessionIntent

    host = object.__new__(WebRemoteHost)
    host.media_profile = {
        "profile": "high",
        "width": 1280,
        "height": 720,
        "target_fps": 20,
        "video_bitrate_kbps": 2500,
    }
    host._user_resolution = {"width": 1280, "height": 720}
    host._last_keyframe_request_at = 0.0
    host.screen_track = None
    host.media_sender = None
    host.video_sender = None
    host._h264_policy_version = "relay-legacy-v1"
    host._h264_policy_provider = H264SessionPolicyProvider()
    host._h264_policy_provider.bind_attempt("attempt-current")
    host._h264_policy_provider.publish(
        MediaSessionIntent("attempt-current", 7, "relay", 1280, 720, 20, 0),
        "relay-legacy-v1",
    )
    current = {
        "viewerId": "viewer-1",
        "connectionAttemptId": "attempt-current",
        "generation": 7,
        "profileSequence": 1,
        "profile": "medium",
        "width": 1280,
        "height": 720,
        "targetFps": 15,
        "videoBitrateKbps": 2000,
        "reason": "quality",
        "adaptiveResolution": False,
    }

    host.on_media_profile_change(current)
    host.on_media_profile_change({**current, "profileSequence": 0, "profile": "low"})

    assert host.media_profile["profile"] == "medium"
    assert host.media_profile["video_bitrate_kbps"] == 2000
    assert host._h264_policy_provider.current().intent.profile_sequence == 1


def test_capture_fps_tracks_current_media_target_with_a_60_fps_cap():
    assert ScreenCaptureTrack.capture_fps_for_target(20) == 40
    assert ScreenCaptureTrack.capture_fps_for_target(15) == 30
    assert ScreenCaptureTrack.capture_fps_for_target(12) == 24
    assert ScreenCaptureTrack.capture_fps_for_target(8) == 16
    assert ScreenCaptureTrack.capture_fps_for_target(30) == 60
