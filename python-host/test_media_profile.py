import logging

from host import WebRemoteHost


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
    host.screen_track = None

    handler = ListHandler()
    logger = logging.getLogger("host")
    original_level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

    try:
        host.on_media_profile_change({
            "viewerId": "viewer-1",
            "profile": "low",
            "width": 854,
            "height": 480,
            "targetFps": 12,
            "videoBitrateKbps": 900,
            "reason": "packet-loss",
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
    host.screen_track = None

    host.on_media_profile_change({
        "viewerId": "viewer-1",
        "profile": "invalid",
        "width": 99999,
        "height": 1,
        "targetFps": 99,
        "videoBitrateKbps": 99999,
        "reason": "bad",
    })

    assert host.media_profile["profile"] == "medium"
    assert host.media_profile["width"] == 1920
    assert host.media_profile["height"] == 180
    assert host.media_profile["target_fps"] == 30
    assert host.media_profile["video_bitrate_kbps"] == 5000
