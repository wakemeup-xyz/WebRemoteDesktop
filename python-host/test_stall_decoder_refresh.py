from types import SimpleNamespace

import host as host_module
from host import WebRemoteHost


class FakeEncoder:
    def __init__(self):
        self.calls = 0

    def request_decoder_refresh(self):
        self.calls += 1
        return True


def test_decoder_refresh_requires_a_healthy_fps_sample(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(host_module.time, "monotonic", lambda: now[0])

    encoder = FakeEncoder()
    host = object.__new__(WebRemoteHost)
    host._stall_decoder_refresh_at = 0.0
    host.video_sender = SimpleNamespace(_encoder=encoder)

    freeze = {"fps": 0, "framesReceived": 10}
    healthy = {"fps": 20, "framesReceived": 10}

    assert host._refresh_decoder_on_stall(freeze) is False
    assert encoder.calls == 0

    assert host._refresh_decoder_on_stall(healthy) is False
    assert host._refresh_decoder_on_stall(freeze) is True
    assert encoder.calls == 1
