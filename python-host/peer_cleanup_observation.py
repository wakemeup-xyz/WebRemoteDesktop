"""Bounded scalar facts for one peer-cleanup invocation, never release claims.

Only fixed keys/enums, exact booleans and bounded numbers reach JSON. No object,
reason or exception representation is retained. This module performs no I/O.
"""
import json


SEQUENCE_CAP = 999_999_999
DURATION_CAP_NS = 3_600_000_000_000
REASONS = frozenset({'manual', 'host-stop', 'new-offer', 'control-transition',
                     'viewer-disconnected', 'signal-disconnect'})
STAGES = ('resetInput', 'peerClose', 'trackShutdown')
STATUSES = frozenset({'not-requested', 'absent', 'not-started', 'running',
                      'returned', 'timed-out', 'failed', 'cancelled'})
CLOSE_STATES = frozenset({'unclaimed', 'worker-owned', 'closing', 'closed',
                         'close-failed', 'unknown'})
JOIN_STATES = frozenset({'not-requested', 'pending', 'returned', 'unknown'})


def _choice(value, allowed, fallback='unknown'):
    return value if type(value) is str and value in allowed else fallback


def _boolean(value):
    return value if type(value) is bool else None


def _clock(value):
    return value if type(value) is int and value >= 0 else None


class PeerCleanupObservation:
    def __init__(self, sequence, reason, *, peer_present, track_present,
                 sender_present, now_ns):
        valid_sequence = type(sequence) is int and sequence > 0
        self._base = {
            'schemaVersion': 1,
            'cleanupSequence': min(sequence, SEQUENCE_CAP) if valid_sequence else None,
            # At saturation even the first capped value makes no uniqueness claim.
            'sequenceClipped': valid_sequence and sequence >= SEQUENCE_CAP,
            'sequenceUnique': valid_sequence and sequence < SEQUENCE_CAP,
            'reason': _choice(reason, REASONS),
            'peerPresent': _boolean(peer_present),
            'trackPresent': _boolean(track_present),
            'senderPresent': _boolean(sender_present),
        }
        self._started_ns = _clock(now_ns)
        self._stages = {'resetInput': 'not-started',
                        'peerClose': 'not-started' if peer_present is True else 'absent',
                        'trackShutdown': 'not-started' if track_present is True else 'absent'}
        self._reset_result = 'unknown'
        self._peer_close_timeout_ms = None

    def stage(self, name, status, result=None):
        if type(name) is not str or name not in STAGES:
            return
        self._stages[name] = _choice(status, STATUSES, 'not-started')
        if name == 'resetInput':
            self._reset_result = _choice(result, {'applied', 'rejected'})

    def peer_close_timeout(self, timeout_ms):
        """Record a bounded recovery close without retaining the peer/task."""
        if type(timeout_ms) is int and 0 < timeout_ms <= 60_000:
            self._peer_close_timeout_ms = timeout_ms

    def start_record(self):
        return dict(self._base, event='start')

    def terminal(self, outcome, now_ns, observations):
        ended_ns = _clock(now_ns)
        elapsed = None
        clipped = self._base['sequenceClipped']
        if (self._started_ns is not None and ended_ns is not None
                and ended_ns >= self._started_ns):
            duration = ended_ns - self._started_ns
            clipped = clipped or duration > DURATION_CAP_NS
            elapsed = min(duration, DURATION_CAP_NS) / 1_000_000
        facts = observations if type(observations) is dict else {}
        result = dict(self._base, event='terminal',
            outcome=_choice(outcome, {'returned', 'failed', 'cancelled'}),
            elapsedMs=elapsed, clipped=clipped, stages=dict(self._stages),
            resetResult=self._reset_result,
            peerConnectionClosed=_boolean(facts.get('peerConnectionClosed')),
            captureThreadAlive=_boolean(facts.get('captureThreadAlive')),
            captureCloseState=_choice(facts.get('captureCloseState'), CLOSE_STATES),
            captureShutdownJoin=_choice(facts.get('captureShutdownJoin'), JOIN_STATES),
            executorShutdownRequested=_boolean(facts.get('executorShutdownRequested')),
            senderReleaseConfirmed=None,
            authorityCurrent=_boolean(facts.get('authorityCurrent')),
            currentPeerPresent=_boolean(facts.get('currentPeerPresent')))
        if self._peer_close_timeout_ms is not None:
            result['peerCloseTimedOut'] = True
            result['peerCloseTimeoutMs'] = self._peer_close_timeout_ms
        return result


def peer_cleanup_json(record):
    """Serialize recorder-produced fixed records (worst case comfortably <2048B)."""
    payload = json.dumps(record, separators=(',', ':'), ensure_ascii=True, allow_nan=False)
    if len(payload.encode('utf-8')) > 2048:
        raise ValueError('peer-cleanup-record-limit')
    return payload
