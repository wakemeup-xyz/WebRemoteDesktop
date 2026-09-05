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


def test_viewer_stats_logs_stall_sample_every_five_zero_fps():
    import asyncio

    host = object.__new__(WebRemoteHost)
    host._last_diag_network = {}
    host._stall_sample_count = 0
    handler = ListHandler()
    logger = logging.getLogger("host")
    original_level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    try:
        loop = asyncio.get_event_loop()
        payload = {
            "viewerId": "viewer-1",
            "fps": 0,
            "framesReceived": 19,
            "framesDecoded": 0,
            "rttMs": 180,
            "jitterBufferMs": 40,
            "packetsLost": 0,
            "bytesReceived": 1234,
            "codec": "H264",
            "selectedCandidateType": "relay",
            "framesDropped": 3,
            "packetsReceived": 40,
            "nackCount": 2,
            "pliCount": 1,
            "firCount": 0,
            "freezeCount": 1,
        }
        for _ in range(4):
            loop.run_until_complete(host.on_viewer_stats(payload))
        stall_before = [
            record.getMessage()
            for record in handler.records
            if "WRD_STALL_SAMPLE" in record.getMessage()
        ]
        assert stall_before == []
        loop.run_until_complete(host.on_viewer_stats(payload))
    finally:
        logger.removeHandler(handler)
        logger.setLevel(original_level)

    messages = [record.getMessage() for record in handler.records]
    stall = [msg for msg in messages if "WRD_STALL_SAMPLE" in msg]
    assert len(stall) == 1
    assert "count=5" in stall[0]
    assert "received=19" in stall[0]
    assert "decoded=0" in stall[0]
    assert "dropped=3" in stall[0]
    assert "pli=1" in stall[0]
    assert "nack=2" in stall[0]
    assert "freeze=1" in stall[0]
    assert "packets=40" in stall[0]
    assert "viewer=viewer-1" in stall[0]
    stats = [msg for msg in messages if "VIEWER_STATS" in msg]
    assert stats
    assert "dropped=3" in stats[-1]


def test_viewer_stats_refreshes_decoder_once_per_freeze():
    import asyncio

    class FakeEncoder:
        def __init__(self):
            self.calls = 0
            self.codec = object()

        def request_decoder_refresh(self):
            self.calls += 1
            self.codec = None
            return True

    host = object.__new__(WebRemoteHost)
    host._last_diag_network = {"networkMode": "relay"}
    host._stall_sample_count = 0
    host._stall_decoder_refresh_armed = True
    host._stall_decoder_refresh_at = 0.0
    encoder = FakeEncoder()
    host.video_sender = type("Sender", (), {"_encoder": encoder})()
    loop = asyncio.get_event_loop()
    freeze = {
        "viewerId": "viewer-1",
        "fps": 0,
        "framesReceived": 19,
        "framesDecoded": 0,
        "rttMs": 40,
        "jitterBufferMs": 0,
        "packetsLost": 0,
        "bytesReceived": 1234,
        "codec": "H264",
        "selectedCandidateType": "relay",
    }
    spike = dict(freeze, fps=88, framesDecoded=10)
    healthy = dict(freeze, fps=19, framesDecoded=19)
    loop.run_until_complete(host.on_viewer_stats(freeze))
    assert encoder.calls == 1
    loop.run_until_complete(host.on_viewer_stats(freeze))
    assert encoder.calls == 1
    loop.run_until_complete(host.on_viewer_stats(spike))
    loop.run_until_complete(host.on_viewer_stats(freeze))
    assert encoder.calls == 1
    host._stall_decoder_refresh_at = 0.0
    loop.run_until_complete(host.on_viewer_stats(healthy))
    loop.run_until_complete(host.on_viewer_stats(freeze))
    assert encoder.calls == 2


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
    messages = [record.getMessage() for record in handler.records]
    assert any("WRD_KEYFRAME requested=true emitted=pending" in msg for msg in messages)
    assert any("reason=media-stalled" in msg for msg in messages)
    assert any("viewer=viewer-1" in msg for msg in messages)
    assert any("gop=" in msg for msg in messages)
    assert any("size=" in msg for msg in messages)


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


def test_bind_session_presentation_publishes_relay_policy_and_logs_it():
    host = _make_host(1920, 1080)
    handler = ListHandler()
    logger = logging.getLogger("host")
    original_level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    try:
        host._bind_session_presentation({
            "width": 1280,
            "height": 720,
            "networkMode": "relay",
            "connectionAttemptId": "wrd-1",
            "viewerId": "v1",
        })
        policy = host._h264_policy_provider.current_policy()
        assert policy.codec_name == "libx264"
        assert policy.periodic_idr_frames == 20
        assert any(
            "WRD_SESSION_PRESENTATION" in record.getMessage() and "codec=libx264" in record.getMessage()
            for record in handler.records
        )
    finally:
        logger.removeHandler(handler)
        logger.setLevel(original_level)


def test_bind_session_presentation_publishes_direct_policy():
    host = _make_host(1280, 720)
    host._bind_session_presentation({
        "width": 1280,
        "height": 720,
        "networkMode": "direct",
        "connectionAttemptId": "wrd-2",
    })
    policy = host._h264_policy_provider.current_policy()
    assert policy.codec_name == "h264_videotoolbox"
    assert policy.periodic_idr_frames == 40
