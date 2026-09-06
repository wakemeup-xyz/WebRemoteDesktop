from types import SimpleNamespace

import host as host_module
from h264_encoder_policy import H264SessionPolicyProvider, MediaSessionIntent
from host import WebRemoteHost


class FakeEncoder:
    def __init__(self):
        self.calls = 0
        self.last_keyframe_request_ack = None
        self.keyframe_requests = []

    def note_keyframe_request(self, reason, attempt, generation, request_sequence):
        self.keyframe_requests.append((reason, attempt, generation, request_sequence))

    def request_decoder_refresh(self):
        self.calls += 1
        return True


class FakeMediaSender:
    def __init__(self):
        self.calls = 0

    def request_keyframe(self):
        self.calls += 1
        return True


def _host_with_current_recovery_identity(encoder):
    host = object.__new__(WebRemoteHost)
    host._h264_policy_provider = H264SessionPolicyProvider()
    host._h264_policy_provider.bind_attempt("attempt-current")
    host._h264_policy_provider.publish(
        MediaSessionIntent(
            "attempt-current", 1, "relay", 1280, 720, 20, 0,
            profile_sequence=3,
        ),
        "relay-legacy-v1",
    )
    host._keyframe_recovery_state = {}
    host._last_keyframe_request_at = 0.0
    host._user_resolution = {}
    host.media_sender = FakeMediaSender()
    host.video_sender = SimpleNamespace(_encoder=encoder)
    return host


def _stats(*, decoded=0):
    return {
        "viewerId": "viewer-current",
        "connectionAttemptId": "attempt-current",
        "connectionAttemptSequence": 1,
        "generation": 1,
        "profileSequence": 3,
        "receivedDelta": 19,
        "decodedDelta": decoded,
    }


def test_decoder_refresh_requires_matching_idr_and_two_current_stall_samples(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(host_module.time, "monotonic", lambda: now[0])

    encoder = FakeEncoder()
    host = _host_with_current_recovery_identity(encoder)
    stalled = _stats()

    # The current attempt/generation/profile may request a keyframe, but cannot
    # reopen before the encoder confirms the matching causal IDR.
    assert host._refresh_decoder_on_stall(stalled) is False
    assert encoder.calls == 0
    assert host.media_sender.calls == 1
    assert encoder.keyframe_requests == [("decoder-stalled", "attempt-current", 1, 1)]

    # A periodic or an older request's IDR never arms this recovery episode.
    encoder.last_keyframe_request_ack = ("attempt-current", 1, 0)
    assert host._refresh_decoder_on_stall(stalled) is False
    assert encoder.calls == 0

    encoder.last_keyframe_request_ack = ("attempt-current", 1, 1)
    assert host._refresh_decoder_on_stall(stalled) is False
    assert host._refresh_decoder_on_stall(stalled) is True
    assert encoder.calls == 1

    # A healthy current decoded delta resets the episode. A later causal IDR
    # needs two new stalled samples and can reopen exactly once.
    assert host._refresh_decoder_on_stall(_stats(decoded=19)) is False
    now[0] += 2.0
    assert host._refresh_decoder_on_stall(stalled) is False
    assert host.media_sender.calls == 2
    encoder.last_keyframe_request_ack = ("attempt-current", 1, 2)
    assert host._refresh_decoder_on_stall(stalled) is False
    assert host._refresh_decoder_on_stall(stalled) is True
    assert encoder.calls == 2
