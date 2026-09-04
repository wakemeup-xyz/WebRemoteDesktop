"""Ordered, lease-bound keyboard state independent of the macOS adapter."""

from dataclasses import dataclass
import re
from typing import Any, FrozenSet, Optional


MAX_TEXT_SCALARS = 4096
MAX_BATCH_STEPS = 16
MAX_INPUT_IDS = 64
MAX_INPUT_ID_LENGTH = 128

SHIFT_MASK = 0x00020000
CONTROL_MASK = 0x00040000
ALT_MASK = 0x00080000
META_MASK = 0x00100000

_ACTIONS = frozenset({"key", "text", "batch", "reset"})
_RESET_REASONS = frozenset({
    "window-blur", "visibility-hidden", "deactivated", "keyboard-mode-change",
    "transport-change", "control-revoked", "controller-disconnect", "lease-expired",
    "signal-disconnect", "webrtc-disconnected", "datachannel-closed", "viewer-disconnect",
    "host-reconnect", "host-stop", "batch-failed", "pending-reset", "manual", "unspecified",
})
_ENVELOPE_FIELDS = frozenset({
    "schemaVersion", "type", "action", "leaseId", "leaseEpoch", "seq", "inputIds", "payload",
})
_KEY_FIELDS = frozenset({"phase", "code", "location", "repeat", "modifiers", "locks"})
_MODIFIER_FIELDS = frozenset({"altKey", "ctrlKey", "metaKey", "shiftKey"})
_LOCK_FIELDS = frozenset({"capsLock"})
_SAFE_INTEGER_MAX = (1 << 53) - 1
_CODE_RE = re.compile(r"^[A-Z][A-Za-z0-9]+$")
_INPUT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
_MODIFIER_MASK_BY_CODE = {
    "ShiftLeft": SHIFT_MASK,
    "ShiftRight": SHIFT_MASK,
    "ControlLeft": CONTROL_MASK,
    "ControlRight": CONTROL_MASK,
    "AltLeft": ALT_MASK,
    "AltRight": ALT_MASK,
    "MetaLeft": META_MASK,
    "MetaRight": META_MASK,
}
_MODIFIER_MASK_BY_PAYLOAD = {
    "ctrlKey": CONTROL_MASK,
    "shiftKey": SHIFT_MASK,
    "altKey": ALT_MASK,
    "metaKey": META_MASK,
}
_IME_NAV_CODES = frozenset({
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape",
})


class UnsupportedPhysicalCode(Exception):
    """The platform adapter cannot map a DOM physical key code."""


@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    value: Optional[dict] = None
    code: Optional[str] = None


@dataclass(frozen=True)
class ApplyResult:
    status: str
    lease_epoch: int
    applied_seq: int
    pressed_key_count: int
    modifier_mask: int


@dataclass(frozen=True)
class KeyboardSnapshot:
    connection_generation: int
    lease_epoch: int
    last_applied_seq: int
    pressed_codes: FrozenSet[str]
    pressed_key_count: int
    modifier_mask: int


def _failed(code: str) -> ValidationResult:
    return ValidationResult(ok=False, code=code)


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def _has_only_fields(value: Any, allowed: FrozenSet[str]) -> bool:
    return _is_record(value) and set(value).issubset(allowed)


def _exact_boolean_record(value: Any, allowed: FrozenSet[str], *, nullable_caps: bool = False) -> bool:
    if not _has_only_fields(value, allowed) or set(value) != set(allowed):
        return False
    if nullable_caps:
        return value["capsLock"] is None or type(value["capsLock"]) is bool
    return all(type(item) is bool for item in value.values())


def _safe_positive_integer(value: Any) -> bool:
    return type(value) is int and 1 <= value <= _SAFE_INTEGER_MAX


def _validate_key_payload(payload: Any) -> Optional[str]:
    if not _has_only_fields(payload, _KEY_FIELDS):
        return "UNKNOWN_FIELD"
    if payload.get("phase") not in {"down", "up"}:
        return "INVALID_KEY_PHASE"
    code = payload.get("code")
    if not isinstance(code, str) or not (1 <= len(code) <= 32) or not _CODE_RE.fullmatch(code):
        return "INVALID_PHYSICAL_CODE"
    if type(payload.get("location")) is not int or not 0 <= payload["location"] <= 3:
        return "INVALID_LOCATION"
    if type(payload.get("repeat")) is not bool:
        return "INVALID_REPEAT"
    if not _exact_boolean_record(payload.get("modifiers"), _MODIFIER_FIELDS):
        return "INVALID_MODIFIERS"
    if not _exact_boolean_record(payload.get("locks"), _LOCK_FIELDS, nullable_caps=True):
        return "INVALID_LOCKS"
    return None


def _validate_input_ids(input_ids: Any, *, present: bool) -> Optional[str]:
    if not present:
        return "MISSING_INPUT_IDS"
    if not isinstance(input_ids, list) or not 1 <= len(input_ids) <= MAX_INPUT_IDS:
        return "INVALID_INPUT_IDS"
    if not all(
        isinstance(input_id, str)
        and 1 <= len(input_id) <= MAX_INPUT_ID_LENGTH
        and _INPUT_ID_RE.fullmatch(input_id)
        for input_id in input_ids
    ):
        return "INVALID_INPUT_IDS"
    return None


def validate_remote_input(data: Any) -> ValidationResult:
    """Parse protocol v2 input without retaining untrusted values in errors."""
    try:
        if not _is_record(data):
            return _failed("INVALID_ENVELOPE")
        if not _has_only_fields(data, _ENVELOPE_FIELDS):
            return _failed("UNKNOWN_FIELD")
        if data.get("schemaVersion") != 2:
            return _failed("INVALID_SCHEMA_VERSION")
        if data.get("type") != "keyboard":
            return _failed("INVALID_TYPE")
        action = data.get("action")
        if action not in _ACTIONS:
            return _failed("UNKNOWN_ACTION")
        if "leaseId" not in data:
            return _failed("MISSING_LEASE_ID")
        if not isinstance(data["leaseId"], str) or len(data["leaseId"]) < 16:
            return _failed("INVALID_LEASE_ID")
        if not _safe_positive_integer(data.get("leaseEpoch")):
            return _failed("INVALID_LEASE_EPOCH")
        if not _safe_positive_integer(data.get("seq")):
            return _failed("INVALID_SEQ")
        if not _is_record(data.get("payload")):
            return _failed("INVALID_PAYLOAD")

        if action == "key":
            error = _validate_key_payload(data["payload"])
        elif action == "text":
            if not _has_only_fields(data["payload"], frozenset({"text"})):
                error = "UNKNOWN_FIELD"
            elif not isinstance(data["payload"].get("text"), str):
                error = "INVALID_TEXT"
            elif len(data["payload"]["text"]) > MAX_TEXT_SCALARS:
                error = "TEXT_TOO_LONG"
            else:
                error = None
        elif action == "batch":
            steps = data["payload"].get("steps")
            if not _has_only_fields(data["payload"], frozenset({"steps"})):
                error = "UNKNOWN_FIELD"
            elif not isinstance(steps, list) or not steps:
                error = "INVALID_BATCH"
            elif len(steps) > MAX_BATCH_STEPS:
                error = "BATCH_TOO_LARGE"
            else:
                error = next((item for step in steps if (item := _validate_key_payload(step))), None)
        else:
            if not _has_only_fields(data["payload"], frozenset({"reason"})):
                error = "UNKNOWN_FIELD"
            elif data["payload"].get("reason") not in _RESET_REASONS:
                error = "INVALID_RESET_REASON"
            else:
                error = None
        if error:
            return _failed(error)
        input_id_error = _validate_input_ids(data.get("inputIds"), present="inputIds" in data)
        return _failed(input_id_error) if input_id_error else ValidationResult(ok=True, value=data)
    except Exception:
        return _failed("INVALID_ENVELOPE")


class RemoteKeyboardState:
    def __init__(self, adapter: Any):
        self._adapter = adapter
        self._connection_generation = 0
        self._lease_id: Optional[str] = None
        self._lease_epoch = 0
        self._last_applied_seq = 0
        self._pressed_codes: set[str] = set()

    def transition(self, *, connection_generation: int, lease_id: str, lease_epoch: int) -> ApplyResult:
        if type(connection_generation) is not int or connection_generation < self._connection_generation:
            return self._result("stale-lease")
        if type(lease_epoch) is not int or lease_epoch < 1:
            return self._result("invalid-input")
        if connection_generation == self._connection_generation and lease_epoch <= self._lease_epoch:
            return self._result("stale-lease")
        self._release_all("lease-transition")
        self._connection_generation = connection_generation
        self._lease_id = lease_id
        self._lease_epoch = lease_epoch
        self._last_applied_seq = 0
        return self._result("applied")

    def apply(self, envelope: Any) -> ApplyResult:
        parsed = validate_remote_input(envelope)
        if not parsed.ok:
            return self._result("invalid-input")
        value = parsed.value
        if value["leaseId"] != self._lease_id or value["leaseEpoch"] != self._lease_epoch:
            return self._result("stale-lease")
        sequence = value["seq"]
        if sequence <= self._last_applied_seq:
            return self._result("duplicate")
        if value["action"] != "reset" and sequence != self._last_applied_seq + 1:
            return self._result("sequence-gap")
        try:
            if value["action"] == "reset":
                self._release_all(value["payload"]["reason"])
            elif value["action"] == "key":
                self._apply_key(value["payload"])
            elif value["action"] == "text":
                self._adapter.post_text(value["payload"]["text"])
            else:
                self._apply_batch(value["payload"]["steps"])
        except UnsupportedPhysicalCode:
            return self._result("unsupported-code")
        except Exception:
            self._release_all("execution-failed")
            return self._result("execution-failed")
        self._last_applied_seq = sequence
        return self._result("applied")

    def reset(self, *, lease_epoch: int, reason: str) -> ApplyResult:
        if lease_epoch != self._lease_epoch:
            return self._result("stale-lease")
        self._release_all(reason if reason in _RESET_REASONS else "unspecified")
        return self._result("applied")

    def snapshot(self) -> KeyboardSnapshot:
        return KeyboardSnapshot(
            connection_generation=self._connection_generation,
            lease_epoch=self._lease_epoch,
            last_applied_seq=self._last_applied_seq,
            pressed_codes=frozenset(self._pressed_codes),
            pressed_key_count=len(self._pressed_codes),
            modifier_mask=self._modifier_mask(),
        )

    def _result(self, status: str) -> ApplyResult:
        return ApplyResult(
            status=status,
            lease_epoch=self._lease_epoch,
            applied_seq=self._last_applied_seq,
            pressed_key_count=len(self._pressed_codes),
            modifier_mask=self._modifier_mask(),
        )

    def _modifier_mask(self, *, excluding: Optional[str] = None) -> int:
        mask = 0
        for code in self._pressed_codes:
            if code == excluding:
                continue
            mask |= _MODIFIER_MASK_BY_CODE.get(code, 0)
        return mask

    @staticmethod
    def _payload_modifier_mask(modifiers: dict) -> int:
        return sum(
            mask for field, mask in _MODIFIER_MASK_BY_PAYLOAD.items()
            if modifiers.get(field) is True
        )

    def _release_lost_modifiers(self, desired_mask: int) -> None:
        """Release physical modifier codes absent from browser state."""
        current_mask = self._modifier_mask()
        lost_mask = current_mask & ~desired_mask
        if not lost_mask:
            return

        for code in sorted(self._pressed_codes):
            code_mask = _MODIFIER_MASK_BY_CODE.get(code, 0)
            if not code_mask or not (code_mask & lost_mask):
                continue
            # Remove the code before deriving flags for its keyup so the event
            # reflects the remaining physical modifier state.
            self._pressed_codes.remove(code)
            self._adapter.post_key(code, False, self._modifier_mask())

    def _apply_key(self, payload: dict) -> None:
        code = payload["code"]
        phase = payload["phase"]
        if phase == "down":
            if payload["repeat"] and code not in self._pressed_codes:
                return
            if not payload["repeat"] and code in self._pressed_codes:
                return
            modifier_mask = self._modifier_mask()
            if code not in _MODIFIER_MASK_BY_CODE:
                desired_mask = self._payload_modifier_mask(payload["modifiers"])
                self._release_lost_modifiers(desired_mask)
                modifier_mask = self._modifier_mask()
                if code in _IME_NAV_CODES:
                    modifier_mask &= desired_mask
            self._adapter.post_key(code, True, modifier_mask)
            self._pressed_codes.add(code)
        elif code in self._pressed_codes:
            self._adapter.post_key(code, False, self._modifier_mask(excluding=code))
            self._pressed_codes.remove(code)
        desired_caps_lock = payload["locks"]["capsLock"]
        if desired_caps_lock is not None and hasattr(self._adapter, "set_caps_lock"):
            self._adapter.set_caps_lock(desired_caps_lock)

    def _apply_batch(self, steps: list[dict]) -> None:
        try:
            for step in steps:
                self._apply_key(step)
        except Exception:
            self._release_all("batch-failed")
            raise

    def _release_all(self, _reason: str) -> None:
        for code in sorted(self._pressed_codes):
            self._pressed_codes.remove(code)
            try:
                self._adapter.post_key(code, False, self._modifier_mask())
            except Exception:
                pass


class LegacyInputAdapter:
    """Converts an already-authorized v1 stream into host-owned v2 sequences."""

    def __init__(self, state: RemoteKeyboardState):
        self._state = state
        self._lease_id: Optional[str] = None
        self._lease_epoch = 0
        self._next_seq = 1
        self._transport: Optional[str] = None

    def bind(self, *, connection_generation: int, lease_id: str, lease_epoch: int) -> ApplyResult:
        result = self._state.transition(
            connection_generation=connection_generation, lease_id=lease_id, lease_epoch=lease_epoch
        )
        if result.status == "applied":
            self._lease_id = lease_id
            self._lease_epoch = lease_epoch
            self._next_seq = 1
            self._transport = None
        return result

    def apply(self, legacy: Any, *, transport: str) -> ApplyResult:
        if self._lease_id is None:
            return self._state._result("stale-lease")
        if self._transport is not None and transport != self._transport:
            reset = self._envelope("reset", {"reason": "transport-change"})
            result = self._state.apply(reset)
            self._next_seq += 1
            if result.status != "applied":
                return result
        self._transport = transport
        action, payload = self._normalise(legacy)
        result = self._state.apply(self._envelope(action, payload))
        self._next_seq += 1
        return result

    def _envelope(self, action: str, payload: dict) -> dict:
        return {
            "schemaVersion": 2,
            "type": "keyboard",
            "action": action,
            "leaseId": self._lease_id,
            "leaseEpoch": self._lease_epoch,
            "seq": self._next_seq,
            "inputIds": [f"legacy-{self._next_seq}"],
            "payload": payload,
        }

    @staticmethod
    def _normalise(legacy: Any) -> tuple[str, dict]:
        source = legacy if isinstance(legacy, dict) else {}
        payload = source.get("payload") if isinstance(source.get("payload"), dict) else {}
        action = source.get("action")
        if action in {"keydown", "keyup"}:
            phase = "down" if action == "keydown" else "up"
            modifiers = payload.get("modifiers") if isinstance(payload.get("modifiers"), dict) else {}
            return "key", {
                "phase": phase,
                "code": payload.get("code", ""),
                "location": payload.get("location", 0),
                "repeat": bool(payload.get("repeat", False)),
                "modifiers": {
                    "altKey": bool(modifiers.get("altKey", modifiers.get("alt", False))),
                    "ctrlKey": bool(modifiers.get("ctrlKey", modifiers.get("ctrl", False))),
                    "metaKey": bool(modifiers.get("metaKey", modifiers.get("meta", False))),
                    "shiftKey": bool(modifiers.get("shiftKey", modifiers.get("shift", False))),
                },
                "locks": {"capsLock": None},
            }
        if action == "reset":
            reason = payload.get("reason")
            return "reset", {
                "reason": reason if reason in _RESET_REASONS else "unspecified",
            }
        if action in _ACTIONS:
            return action, payload
        return "reset", {"reason": "unspecified"}
