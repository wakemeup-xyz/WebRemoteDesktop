import json
import hashlib
import logging
import os
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path


_SENSITIVE_INPUT_KEYS = {"data", "key", "code", "text", "payload", "x", "y"}
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


def hash_input_ids(input_ids):
    normalized = [str(value) for value in (input_ids or []) if value is not None]
    if not normalized:
        return None
    digest = hashlib.sha256("\x1f".join(normalized).encode("utf-8", errors="replace")).hexdigest()
    return digest[:16]


def summarize_input_event(data, *, local_execute_ms=None):
    payload = data.get("payload", {}) if isinstance(data, dict) else {}
    try:
        payload_bytes = len(
            json.dumps(payload, ensure_ascii=True, separators=(",", ":"), default=str).encode("utf-8")
        )
    except (TypeError, ValueError):
        payload_bytes = 0
    input_ids = data.get("inputIds", []) if isinstance(data, dict) else []
    summary = {
        "inputType": str(data.get("type") or "unknown"),
        "action": str(data.get("action") or "unknown"),
        "transport": str(data.get("transport") or "socket"),
        "payloadBytes": payload_bytes,
        "inputIdCount": len(input_ids) if isinstance(input_ids, (list, tuple)) else 0,
        "inputIdHash": hash_input_ids(input_ids),
    }
    if local_execute_ms is not None:
        summary["localExecuteMs"] = round(max(0.0, float(local_execute_ms)), 3)
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
