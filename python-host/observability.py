import json
import hashlib
import logging
import math
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

from bounded_log_writer import BoundedLogHandler, OwnedRotatingSink


_SENSITIVE_INPUT_KEYS = {"data", "key", "code", "text", "payload", "x", "y"}
_MAX_INPUT_IDS = 64
_MAX_INPUT_ID_LENGTH = 128
_MAX_PAYLOAD_BYTES = 64 * 1024
_MAX_INPUT_DURATION_MS = 0x7FFFFFFF
_SAFE_INPUT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
_SAFE_INPUT_TYPES = frozenset({"keyboard", "mouse", "command"})
_SAFE_INPUT_ACTIONS = frozenset({
    "key", "keydown", "keyup", "text", "batch", "down", "up", "move", "wheel", "reset", "showDock", "switchInputMethod",
})
_SAFE_INPUT_TRANSPORTS = frozenset({"datachannel", "socket", "none"})
_SAFE_INPUT_STATUSES = frozenset({
    "applied", "duplicate", "stale", "late", "timeout", "stale-lease", "sequence-gap",
    "resync-required", "invalid-input", "unsupported-code", "execution-failed", "rejected",
    "accepted", "unordered", "failed", "pending", "unknown",
})
_SAFE_INPUT_REASONS = frozenset({
    "invalid-envelope", "invalid-input", "stale-lease", "role-rejected", "inactive-viewer",
    "protocol-too-old", "host-unavailable", "adapter-error", "ack-send-failed", "unbound-channel",
})
DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024
DEFAULT_LOG_BACKUP_COUNT = 3
_LOG_CONFIGURATION_LOCK = threading.Lock()


def hash_correlation(value, *, maximum=128):
    """Return a stable bounded correlation hash without retaining the raw ID."""
    if not isinstance(value, str) or not 1 <= len(value) <= maximum:
        return None
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:32]


def input_event_correlation(data):
    """Project only deidentified input/session identities for log correlation."""
    if not isinstance(data, dict):
        return {}
    correlation = {}
    for source, target in (("viewerId", "viewerHash"),
                           ("connectionAttemptId", "attemptHash"),
                           ("inputIdHash", "inputIdHash")):
        value = data.get(source)
        if source == "inputIdHash":
            if isinstance(value, str) and re.fullmatch(r"[0-9a-f]{16,64}", value):
                correlation[target] = value
        else:
            hashed = hash_correlation(value)
            if hashed:
                correlation[target] = hashed
    if isinstance(data.get("leaseEpoch"), int) and data["leaseEpoch"] >= 0:
        correlation["leaseEpoch"] = min(data["leaseEpoch"], 0x7FFFFFFF)
    for source, target in (("generation", "generation"),
                           ("mediaGeneration", "mediaGeneration"),
                           ("connectionAttemptSequence", "attemptSequence")):
        value = data.get(source)
        if isinstance(value, int) and value >= 0:
            correlation[target] = min(value, 0x7FFFFFFF)
    return correlation


def _bounded_int(value, default, *, minimum):
    try:
        return max(minimum, int(value))
    except (TypeError, ValueError):
        return default


def load_log_bounds():
    return (
        _bounded_int(os.environ.get("WRD_LOG_MAX_BYTES"), DEFAULT_LOG_MAX_BYTES, minimum=1),
        _bounded_int(os.environ.get("WRD_LOG_BACKUP_COUNT"), DEFAULT_LOG_BACKUP_COUNT, minimum=0),
    )


def configure_host_logging(*, logger=None, log_file=None, max_bytes=None, backup_count=None):
    target_logger = logger or logging.getLogger()
    env_max_bytes, env_backup_count = load_log_bounds()
    resolved_max_bytes = _bounded_int(max_bytes, env_max_bytes, minimum=1)
    resolved_backup_count = _bounded_int(backup_count, env_backup_count, minimum=0)
    resolved_log_file = Path(
        log_file
        or os.environ.get("WRD_HOST_LOG_FILE")
        or Path(__file__).resolve().parent.parent / "back-debug.log"
    ).resolve()
    resolved_log_file.parent.mkdir(parents=True, exist_ok=True)

    signature = (str(resolved_log_file), resolved_max_bytes, resolved_backup_count)
    with _LOG_CONFIGURATION_LOCK:
        # Keep ownership on the logger even if a caller detaches its handler.
        # A detached, blocked writer must never be hidden by handlers.clear().
        owner = getattr(target_logger, "_wrd_host_log_owner", None)
        if owner is not None:
            state = owner.snapshot()
            if state["writer_alive"]:
                if not state["accepting"]:
                    raise RuntimeError("Host log writer is still stopping")
                if owner._wrd_host_log_signature == signature:
                    if owner not in target_logger.handlers:
                        target_logger.addHandler(owner)
                    target_logger.setLevel(logging.INFO)
                    target_logger.propagate = False
                    return owner
                owner.shutdown()
                if owner.snapshot()["writer_alive"]:
                    raise RuntimeError("Host log writer is still stopping")

        for handler in list(target_logger.handlers):
            target_logger.removeHandler(handler)
            handler.close()

        handler = BoundedLogHandler(lambda: OwnedRotatingSink(
            resolved_log_file, max_bytes=resolved_max_bytes,
            backup_count=resolved_backup_count,
        ))
        handler._wrd_host_log_signature = signature
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
        target_logger._wrd_host_log_owner = handler
        target_logger.addHandler(handler)
        target_logger.setLevel(logging.INFO)
        target_logger.propagate = False
        return handler


def redact_host_value(value, key=""):
    normalized_key = str(key or "").lower()
    if normalized_key in _SENSITIVE_INPUT_KEYS or any(
        marker in normalized_key
        for marker in ("token", "secret", "password", "authorization", "cookie", "credential")
    ):
        return "[redacted]"
    if isinstance(value, dict):
        return {item_key: redact_host_value(item_value, item_key) for item_key, item_value in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact_host_value(item) for item in value]
    return value


def redact_host_correlation(value):
    """Hash lifecycle identities while preserving bounded non-identity fields."""
    if not isinstance(value, dict):
        return {}
    clean = redact_host_value(value)
    for source, target in (("viewerId", "viewerHash"),
                           ("previousViewerId", "previousViewerHash"),
                           ("connectionAttemptId", "attemptHash"),
                           ("browserSessionId", "browserSessionHash")):
        raw = value.get(source)
        clean.pop(source, None)
        hashed = hash_correlation(raw)
        if hashed:
            clean[target] = hashed
    return clean


_IDENTITY_META_KEYS = {
    "viewerId": "viewerHash",
    "previousViewerId": "previousViewerHash",
    "connectionAttemptId": "attemptHash",
    "browserSessionId": "browserSessionHash",
}


def redact_host_meta(value):
    """Redact lifecycle identities anywhere inside structured event metadata.

    Host metadata is diagnostic-only; preserving raw viewer/session/attempt IDs
    there would defeat the deidentified correlation contract even when the
    top-level ``correlation`` object is already hashed.
    """
    if isinstance(value, dict):
        clean = {}
        for key, item in value.items():
            target = _IDENTITY_META_KEYS.get(key)
            if target is not None:
                hashed = hash_correlation(item)
                if hashed:
                    clean[target] = hashed
                continue
            clean[key] = redact_host_meta(item)
        return redact_host_value(clean)
    if isinstance(value, (list, tuple)):
        return [redact_host_meta(item) for item in value]
    return redact_host_value(value)


def _valid_input_ids(input_ids):
    if not isinstance(input_ids, (list, tuple)) or not 1 <= len(input_ids) <= _MAX_INPUT_IDS:
        return None
    if not all(
        isinstance(value, str)
        and 1 <= len(value) <= _MAX_INPUT_ID_LENGTH
        and _SAFE_INPUT_ID.fullmatch(value)
        for value in input_ids
    ):
        return None
    return list(input_ids)


def _safe_enum(value, allowed, default):
    return value if isinstance(value, str) and value in allowed else default


def hash_input_ids(input_ids):
    normalized = _valid_input_ids(input_ids)
    if normalized is None:
        return None
    digest = hashlib.sha256("\x1f".join(normalized).encode("utf-8")).hexdigest()
    return digest[:16]


def summarize_input_event(
    data,
    *,
    local_execute_ms=None,
    status=None,
    applied_seq=None,
    ack_accepted=None,
    admission_wait_ms=None,
    reason=None,
):
    payload = data.get("payload", {}) if isinstance(data, dict) else {}
    try:
        payload_bytes = min(_MAX_PAYLOAD_BYTES, len(
            json.dumps(payload, ensure_ascii=True, separators=(",", ":"), default=str).encode("utf-8")
        ))
    except (TypeError, ValueError):
        payload_bytes = 0
    input_ids = data.get("inputIds", []) if isinstance(data, dict) else []
    normalized_ids = _valid_input_ids(input_ids)
    raw_type = data.get("type") if isinstance(data, dict) else None
    raw_action = data.get("action") if isinstance(data, dict) else None
    raw_transport = data.get("transport") if isinstance(data, dict) else None
    raw_status = status if status is not None else (data.get("status") if isinstance(data, dict) else None)
    raw_applied_seq = applied_seq if applied_seq is not None else (
        data.get("appliedSeq") if isinstance(data, dict) else None
    )
    try:
        bounded_seq = max(0, min(int(data.get("seq")), 0x7FFFFFFF)) if isinstance(data, dict) else 0
    except (TypeError, ValueError, OverflowError):
        bounded_seq = 0
    try:
        bounded_lease_epoch = max(0, min(int(data.get("leaseEpoch")), 0x7FFFFFFF)) if isinstance(data, dict) else 0
    except (TypeError, ValueError, OverflowError):
        bounded_lease_epoch = 0
    try:
        bounded_applied_seq = max(0, min(int(raw_applied_seq), 0x7FFFFFFF))
    except (TypeError, ValueError, OverflowError):
        bounded_applied_seq = 0
    summary = {
        "inputType": _safe_enum(raw_type, _SAFE_INPUT_TYPES, "unknown"),
        "action": _safe_enum(raw_action, _SAFE_INPUT_ACTIONS, "unknown"),
        "transport": _safe_enum(raw_transport, _SAFE_INPUT_TRANSPORTS, "socket"),
        "payloadBytes": payload_bytes,
        "inputIdCount": len(normalized_ids) if normalized_ids is not None else 0,
        "inputIdHash": hash_input_ids(normalized_ids),
        "status": _safe_enum(raw_status, _SAFE_INPUT_STATUSES, "unknown"),
        "seq": bounded_seq,
        "leaseEpoch": bounded_lease_epoch,
        "appliedSeq": bounded_applied_seq,
    }
    for source, target in (("generation", "generation"), ("mediaGeneration", "mediaGeneration")):
        value = data.get(source) if isinstance(data, dict) else None
        if isinstance(value, int) and value >= 0:
            summary[target] = min(value, 0x7FFFFFFF)
    raw_reason = reason if reason is not None else (data.get("reason") if isinstance(data, dict) else None)
    summary["reason"] = _safe_enum(raw_reason, _SAFE_INPUT_REASONS, None)
    # Nullable observation only: reject coerced/invalid/unbounded durations
    # instead of clamping them into a fabricated measured value.
    admission_wait = None
    if type(admission_wait_ms) in (int, float):
        try:
            if math.isfinite(admission_wait_ms) and 0 <= admission_wait_ms <= _MAX_INPUT_DURATION_MS:
                admission_wait = round(float(admission_wait_ms), 3)
        except (TypeError, ValueError, OverflowError):
            pass
    summary["hostAdmissionWaitMs"] = admission_wait
    if local_execute_ms is not None:
        try:
            summary["localExecuteMs"] = round(max(0.0, min(float(local_execute_ms), _MAX_PAYLOAD_BYTES)), 3)
        except (TypeError, ValueError, OverflowError):
            pass
        summary["timingScope"] = "host-adapter-await"
        summary["timingIncludesQueueWait"] = True
    if ack_accepted is not None:
        summary["ackAccepted"] = ack_accepted is True
    return summary


def summarize_high_frequency_input_event(data, *, status=None):
    """Summarize move/wheel traffic without reading payload or input IDs."""
    input_data = data if isinstance(data, dict) else {}
    raw_status = status if status is not None else input_data.get("status")
    return {
        "inputType": _safe_enum(input_data.get("type"), _SAFE_INPUT_TYPES, "unknown"),
        "action": _safe_enum(input_data.get("action"), _SAFE_INPUT_ACTIONS, "unknown"),
        "transport": _safe_enum(input_data.get("transport"), _SAFE_INPUT_TRANSPORTS, "socket"),
        "status": _safe_enum(raw_status, _SAFE_INPUT_STATUSES, "unknown"),
    }


def emit_host_event(logger, *, event, message, correlation=None, meta=None, level="info"):
    payload = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "domain": "host",
        "event": event,
        "message": message,
        "source": "python-host",
        "schemaVersion": 1,
        "correlation": redact_host_correlation(correlation or {}),
        "meta": redact_host_meta(meta or {}),
        "redactionVersion": 1,
    }
    getattr(logger, level)(json.dumps(payload, ensure_ascii=True, separators=(",", ":")))
    return payload
