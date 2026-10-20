"""Synchronous, disposable-only admission; not an SCTP or reliable-message bound."""
import json

BUDGET_BYTES = 4096
COUNTER_MAX = (1 << 63) - 1
TYPES = ('frame_timing', 'capture_stats', 'frame_trace_batch', 'loss_lab_host_trace_batch')
REASONS = ('unsupported', 'serialization', 'oversized', 'unavailable', 'replaced',
           'closed', 'invalid_channel', 'invalid_buffer', 'congested', 'send_error')


class DiagnosticAdmission:
    def __init__(self):
        self.counts = {kind: {'sent': 0, 'dropped': 0} for kind in TYPES}
        self.reasons = dict.fromkeys(REASONS, 0)
        self.legacy = {'ids': 0, 'metadata': 0}

    @staticmethod
    def _add(counters, key, count=1):
        counters[key] = min(COUNTER_MAX, counters[key] + count)

    def note_legacy_drop(self, ids, metadata):
        self._add(self.legacy, 'ids', ids)
        self._add(self.legacy, 'metadata', metadata)

    def snapshot(self):
        return {'types': {k: dict(v) for k, v in self.counts.items()},
                'reasons': dict(self.reasons), 'legacyDropped': dict(self.legacy)}

    def send(self, host, dc, payload):
        kind = payload.get('type') if isinstance(payload, dict) else None
        if not isinstance(kind, str) or kind not in TYPES:
            reason = 'unsupported'
        else:
            reason = self._attempt(host, dc, payload)
            self._add(self.counts[kind], 'dropped' if reason else 'sent')
        if reason:
            self._add(self.reasons, reason)
        return reason is None

    @staticmethod
    def _attempt(host, dc, payload):
        try:
            serialized = json.dumps(payload, ensure_ascii=False)
            size = len(serialized.encode('utf-8'))
        except Exception:
            return 'serialization'
        if size > BUDGET_BYTES:
            return 'oversized'
        if host is None or dc is None:
            return 'unavailable'
        try:
            if dc is not host.get_input_datachannel():
                return 'replaced'
            if dc.readyState != 'open':
                return 'closed'
            send = dc.send
            if not callable(send):
                return 'invalid_channel'
            amount = dc.bufferedAmount
        except Exception:
            return 'invalid_channel'
        if isinstance(amount, bool) or not isinstance(amount, int) or amount < 0:
            return 'invalid_buffer'
        if amount > BUDGET_BYTES - size:
            return 'congested'
        try:
            send(serialized)
        except Exception:
            return 'send_error'
        return None
