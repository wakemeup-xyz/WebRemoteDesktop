import logging
import time
from unittest.mock import MagicMock

from host import WebRemoteHost


class ListHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        self.records.append(record)


def _make_host(width=1280, height=720):
    host = object.__new__(WebRemoteHost)
    host.media_profile = {
        "profile": "high",
        "width": width,
        "height": height,
        "target_fps": 20,
        "video_bitrate_kbps": 2500,
    }
    host._user_resolution = {"width": width, "height": height}
    host._last_keyframe_request_at = 0.0
    host.screen_track = None
    host.video_sender = None
    host.media_sender = MagicMock()
    host.media_sender.request_keyframe.return_value = True
    return host


def test_adaptive_resolution_false_ignores_smaller_size():
    host = _make_host(1280, 720)
    handler = ListHandler()
    logger = logging.getLogger("host")
    original_level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    try:
        host.on_media_profile_change({
            "viewerId": "viewer-1",
            "profile": "survival",
            "width": 640,
            "height": 360,
            "targetFps": 10,
            "videoBitrateKbps": 900,
            "reason": "packet-loss",
            "adaptiveResolution": False,
        })
    finally:
        logger.removeHandler(handler)
        logger.setLevel(original_level)

    assert host.media_profile["width"] == 1280
    assert host.media_profile["height"] == 720
    assert host.media_profile["target_fps"] == 10
    assert host.media_profile["video_bitrate_kbps"] == 900
    assert host.media_profile["profile"] == "survival"
    assert any(
        "WRD_MEDIA_PROFILE size locked user=1280x720 requested=640x360" in record.getMessage()
        for record in handler.records
    )


def test_adaptive_resolution_missing_defaults_to_lock():
    host = _make_host(1280, 720)
    host.on_media_profile_change({
        "viewerId": "viewer-1",
        "profile": "low",
        "width": 854,
        "height": 480,
        "targetFps": 12,
        "videoBitrateKbps": 900,
        "reason": "packet-loss",
    })
    assert host.media_profile["width"] == 1280
    assert host.media_profile["height"] == 720
    assert host.media_profile["target_fps"] == 12
    assert host.media_profile["video_bitrate_kbps"] == 900


def test_adaptive_resolution_true_allows_size_change():
    host = _make_host(1280, 720)
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
    assert host.media_profile["width"] == 854
    assert host.media_profile["height"] == 480
    assert host._user_resolution == {"width": 854, "height": 480}
    assert host.media_profile["target_fps"] == 12


def test_resolution_change_updates_user_size_truth():
    host = _make_host(1280, 720)

    import asyncio
    asyncio.get_event_loop().run_until_complete(
        host.on_resolution_change({"viewerId": "viewer-1", "width": 1920, "height": 1080})
    )
    assert host._user_resolution == {"width": 1920, "height": 1080}
    assert host.media_profile["width"] == 1920
    assert host.media_profile["height"] == 1080

    host.on_media_profile_change({
        "viewerId": "viewer-1",
        "profile": "medium",
        "width": 640,
        "height": 360,
        "targetFps": 15,
        "videoBitrateKbps": 1400,
        "adaptiveResolution": False,
    })
    assert host.media_profile["width"] == 1920
    assert host.media_profile["height"] == 1080
    assert host.media_profile["target_fps"] == 15


def test_keyframe_handler_invokes_request_path():
    host = _make_host()
    handler = ListHandler()
    logger = logging.getLogger("host")
    original_level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    try:
        host.on_request_keyframe({
            "viewerId": "viewer-1",
            "reason": "media-stalled",
        })
    finally:
        logger.removeHandler(handler)
        logger.setLevel(original_level)

    host.media_sender.request_keyframe.assert_called_once()
    assert any(
        "WRD_KEYFRAME reason=media-stalled" in record.getMessage()
        for record in handler.records
    )


def test_keyframe_rate_limited_to_one_per_second():
    host = _make_host()
    assert host._request_keyframe(reason="media-stalled", viewer_id="v1") is True
    assert host.media_sender.request_keyframe.call_count == 1
    assert host._request_keyframe(reason="media-stalled", viewer_id="v1") is False
    assert host.media_sender.request_keyframe.call_count == 1
    host._last_keyframe_request_at = time.monotonic() - 1.1
    assert host._request_keyframe(reason="media-stalled", viewer_id="v1") is True
    assert host.media_sender.request_keyframe.call_count == 2


def test_continuity_action_keyframe_on_media_profile():
    host = _make_host()
    host.on_media_profile_change({
        "viewerId": "viewer-1",
        "profile": "high",
        "width": 1280,
        "height": 720,
        "targetFps": 20,
        "videoBitrateKbps": 2500,
        "reason": "keyframe-recovery",
        "adaptiveResolution": False,
        "continuityAction": "keyframe",
    })
    # Profile unchanged, but keyframe still requested.
    host.media_sender.request_keyframe.assert_called_once()


def test_lock_adopts_720p_connection_sync_over_stale_1080p():
    host = _make_host(1920, 1080)
    host.screen_track = MagicMock()
    host.screen_track.apply_media_profile.return_value = {"sizeChanged": True}
    host.on_media_profile_change({
        "viewerId": "viewer-1",
        "profile": "high",
        "width": 1280,
        "height": 720,
        "targetFps": 20,
        "videoBitrateKbps": 2500,
        "reason": "connection-sync",
        "adaptiveResolution": False,
        "connectionAttemptId": "wrd-new",
    })
    assert host.media_profile["width"] == 1280
    assert host.media_profile["height"] == 720
    assert host._user_resolution == {"width": 1280, "height": 720}
    host.screen_track.apply_media_profile.assert_called_once()
    applied = host.screen_track.apply_media_profile.call_args[0][0]
    assert applied["width"] == 1280
    assert applied["height"] == 720


def test_lock_still_rejects_survival_auto_size():
    host = _make_host(1280, 720)
    host.on_media_profile_change({
        "viewerId": "viewer-1",
        "profile": "survival",
        "width": 640,
        "height": 360,
        "targetFps": 8,
        "videoBitrateKbps": 500,
        "reason": "packet-loss",
        "adaptiveResolution": False,
    })
    assert host.media_profile["width"] == 1280
    assert host.media_profile["height"] == 720


def test_bind_session_presentation_resets_stale_user_resolution():
    host = _make_host(1920, 1080)
    host._bind_session_presentation({
        "width": 1280,
        "height": 720,
        "networkMode": "relay",
        "connectionAttemptId": "wrd-1",
        "viewerId": "v1",
    })
    assert host._user_resolution == {"width": 1280, "height": 720}
