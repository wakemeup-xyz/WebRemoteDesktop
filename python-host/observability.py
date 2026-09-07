import json
import hashlib
import logging
import os
import re
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path


_SENSITIVE_INPUT_KEYS = {"data", "key", "code", "text", "payload", "x", "y"}
_MAX_INPUT_IDS = 64
_MAX_INPUT_ID_LENGTH = 128
_MAX_PAYLOAD_BYTES = 64 * 1024
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
    for handler in target_logger.handlers:
        if getattr(handler, "_wrd_host_log_signature", None) == signature:
            target_logger.setLevel(logging.INFO)
            target_logger.propagate = False
            return handler

    for handler in list(target_logger.handlers):
        target_logger.removeHandler(handler)
        handler.close()

    handler = RotatingFileHandler(
        resolved_log_file,
        maxBytes=resolved_max_bytes,
        backupCount=resolved_backup_count,
        encoding="utf-8",
    )
    handler._wrd_host_log_signature = signature
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
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
    raw_reason = reason if reason is not None else (data.get("reason") if isinstance(data, dict) else None)
    summary["reason"] = _safe_enum(raw_reason, _SAFE_INPUT_REASONS, None)
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


def emit_host_event(logger, *, event, message, correlation=None, meta=None, level="info"):
    payload = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "domain": "host",
        "event": event,
        "message": message,
        "source": "python-host",
        "schemaVersion": 1,
        "correlation": redact_host_value(correlation or {}),
        "meta": redact_host_value(meta or {}),
        "redactionVersion": 1,
    }
    getattr(logger, level)(json.dumps(payload, ensure_ascii=True, separators=(",", ":")))
    return payload
