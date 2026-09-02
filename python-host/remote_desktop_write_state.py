"""Lease-bound ordering for reliable mouse actions and Host commands."""

from dataclasses import dataclass
from typing import Any, Optional


_SAFE_INTEGER_MAX = (1 << 53) - 1
_RELIABLE_MOUSE_ACTIONS = frozenset({"down", "up", "wheel", "reset"})
_MOUSE_ACTIONS = _RELIABLE_MOUSE_ACTIONS | {"move"}
_COMMAND_ACTIONS = frozenset({"showDock", "switchInputMethod"})


@dataclass(frozen=True)
class DesktopWriteResult:
    status: str
    applied_seq: int


@dataclass(frozen=True)
class DesktopWriteSnapshot:
    lease_epoch: int
    last_applied_seq: int


def is_reliable_desktop_write(data: Any) -> bool:
    return isinstance(data, dict) and (
        data.get("type") == "command"
        or (data.get("type") == "mouse" and data.get("action") in _RELIABLE_MOUSE_ACTIONS)
    )


def validate_desktop_write(data: Any) -> bool:
    if not isinstance(data, dict) or data.get("schemaVersion") != 2:
        return False
    allowed = {"schemaVersion", "type", "action", "leaseId", "leaseEpoch", "seq", "inputIds", "payload"}
    if not set(data).issubset(allowed) or data.get("type") not in {"mouse", "command"}:
        return False
    if not isinstance(data.get("leaseId"), str) or len(data["leaseId"]) < 16:
        return False
    if type(data.get("leaseEpoch")) is not int or not 1 <= data["leaseEpoch"] <= _SAFE_INTEGER_MAX:
        return False
    if not isinstance(data.get("inputIds"), list) or not data["inputIds"] or not isinstance(data.get("payload"), dict):
        return False
    reliable = is_reliable_desktop_write(data)
    if reliable and (type(data.get("seq")) is not int or not 1 <= data["seq"] <= _SAFE_INTEGER_MAX):
        return False
    if not reliable and data.get("seq") is not None:
        return False
    if data["type"] == "command":
        return data.get("action") in _COMMAND_ACTIONS and data["payload"] == {}
    action = data.get("action")
    if action not in _MOUSE_ACTIONS:
        return False
    payload = data["payload"]
    if action == "reset":
        return set(payload) == {"reason"} and isinstance(payload["reason"], str) and bool(payload["reason"])
    if not all(isinstance(payload.get(key), (int, float)) and 0 <= payload[key] <= 1 for key in ("relX", "relY")):
        return False
    if action == "wheel":
        return set(payload) == {"relX", "relY", "deltaX", "deltaY"} and all(isinstance(payload.get(key), (int, float)) for key in ("deltaX", "deltaY"))
    if action == "move":
        return set(payload) == {"relX", "relY", "buttons"} and type(payload.get("buttons")) is int and 0 <= payload["buttons"] <= 7
    return set(payload) == {"relX", "relY", "button", "clickCount", "buttons"} and payload.get("button") in {"left", "middle", "right"} and type(payload.get("clickCount")) is int and 1 <= payload["clickCount"] <= 3 and type(payload.get("buttons")) is int and 0 <= payload["buttons"] <= 7


class ReliableDesktopWriteState:
    def __init__(self):
        self._lease_id: Optional[str] = None
        self._lease_epoch = 0
        self._last_applied_seq = 0

    def transition(self, *, lease_id: str, lease_epoch: int) -> DesktopWriteResult:
        if not isinstance(lease_id, str) or len(lease_id) < 16 or type(lease_epoch) is not int or lease_epoch < 1:
            return self._result("invalid-input")
        self._lease_id, self._lease_epoch, self._last_applied_seq = lease_id, lease_epoch, 0
        return self._result("applied")

    def apply(self, data: Any) -> DesktopWriteResult:
        if not validate_desktop_write(data):
            return self._result("invalid-input")
        if data["leaseId"] != self._lease_id or data["leaseEpoch"] != self._lease_epoch:
            return self._result("stale-lease")
        if not is_reliable_desktop_write(data):
            return self._result("unordered")
        sequence = data["seq"]
        if sequence <= self._last_applied_seq:
            return self._result("duplicate")
        if sequence != self._last_applied_seq + 1:
            return self._result("sequence-gap")
        self._last_applied_seq = sequence
        return self._result("applied")

    def snapshot(self) -> DesktopWriteSnapshot:
        return DesktopWriteSnapshot(self._lease_epoch, self._last_applied_seq)

    def _result(self, status: str) -> DesktopWriteResult:
        return DesktopWriteResult(status, self._last_applied_seq)
