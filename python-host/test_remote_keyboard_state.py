import copy
import json
from pathlib import Path

import pytest

from remote_keyboard_state import (
    SHIFT_MASK,
    LegacyInputAdapter,
    RemoteKeyboardState,
    UnsupportedPhysicalCode,
    validate_remote_input,
)


LEASE_ID = "lease-000000000001"


class RecordingKeyboardAdapter:
    def __init__(self):
        self.events = []
        self.last_modifier_mask = 0
        self.caps_lock = False

    def post_key(self, code, is_down, modifier_mask):
        self.events.append((code, is_down, modifier_mask))
        self.last_modifier_mask = modifier_mask

    def post_text(self, text):
        self.events.append(("text", text))

    def get_caps_lock(self):
        return self.caps_lock

    def set_caps_lock(self, desired):
        if desired is not None:
            self.caps_lock = bool(desired)


class FailingKeyboardAdapter(RecordingKeyboardAdapter):
    def __init__(self, fail_code, error=RuntimeError):
        super().__init__()
        self.fail_code = fail_code
        self.error = error

    def post_key(self, code, is_down, modifier_mask):
        if code == self.fail_code and is_down:
            raise self.error(code)
        super().post_key(code, is_down, modifier_mask)


def key_payload(phase, code, *, repeat=False, caps_lock=False):
    return {
        "phase": phase,
        "code": code,
        "location": 0,
        "repeat": repeat,
        "modifiers": {
            "altKey": False,
            "ctrlKey": False,
            "metaKey": False,
            "shiftKey": False,
        },
        "locks": {"capsLock": caps_lock},
    }


def envelope(action, *, epoch=1, seq=1, lease_id=LEASE_ID, payload=None):
    return {
        "schemaVersion": 2,
        "type": "keyboard",
        "action": action,
        "leaseId": lease_id,
        "leaseEpoch": epoch,
        "seq": seq,
        "inputIds": [f"input-{seq}"],
        "payload": payload or {},
    }


def key_envelope(*, epoch=1, seq, phase, code, repeat=False, caps_lock=False, lease_id=LEASE_ID):
    return envelope(
        "key",
        epoch=epoch,
        seq=seq,
        lease_id=lease_id,
        payload=key_payload(phase, code, repeat=repeat, caps_lock=caps_lock),
    )


def reset_envelope(*, epoch=1, seq, lease_id=LEASE_ID, reason="transport-change"):
    return envelope("reset", epoch=epoch, seq=seq, lease_id=lease_id, payload={"reason": reason})


def active_state(adapter, *, generation=1, epoch=1):
    state = RemoteKeyboardState(adapter)
    assert state.transition(
        connection_generation=generation, lease_id=LEASE_ID, lease_epoch=epoch
    ).status == "applied"
    return state


def test_shared_v2_fixtures_validate_without_disclosing_raw_values():
    fixture_path = Path(__file__).parents[1] / "shared" / "remote-input-v2-fixtures.json"
    fixtures = json.loads(fixture_path.read_text())

    for fixture in fixtures["valid"]:
        result = validate_remote_input(fixture["input"])
        assert result.ok, fixture["name"]
        assert result.value["seq"] == fixture["input"]["seq"]

    for fixture in fixtures["invalid"]:
        result = validate_remote_input(fixture["input"])
        assert not result.ok, fixture["name"]
        assert result.code == fixture["expectedCode"]
        assert fixture["input"].get("leaseId", "not-present") not in repr(result)
        assert fixture["input"].get("payload", {}).get("text", "not-present") not in repr(result)


def test_validation_requires_bounded_safe_input_ids_and_accepts_null_caps_lock():
    valid = key_envelope(seq=1, phase="down", code="KeyA", caps_lock=None)
    assert validate_remote_input(valid).ok

    missing = copy.deepcopy(valid)
    del missing["inputIds"]
    assert validate_remote_input(missing).code == "MISSING_INPUT_IDS"

    invalid = copy.deepcopy(valid)
    invalid["inputIds"] = None
    assert validate_remote_input(invalid).code == "INVALID_INPUT_IDS"

    invalid["inputIds"] = ["unsafe id"]
    assert validate_remote_input(invalid).code == "INVALID_INPUT_IDS"

    invalid["inputIds"] = [f"input-{index}" for index in range(65)]
    assert validate_remote_input(invalid).code == "INVALID_INPUT_IDS"


def test_reset_high_water_rejects_late_key_and_is_idempotent():
    adapter = RecordingKeyboardAdapter()
    state = active_state(adapter, generation=3, epoch=7)
    assert state.apply(key_envelope(epoch=7, seq=1, phase="down", code="KeyA")).status == "applied"
    assert state.apply(reset_envelope(epoch=7, seq=3)).status == "applied"
    assert state.apply(key_envelope(epoch=7, seq=2, phase="down", code="KeyB")).status == "duplicate"
    assert state.reset(lease_epoch=7, reason="manual").status == "applied"
    assert state.snapshot().pressed_key_count == 0
    assert state.snapshot().last_applied_seq == 3


def test_sided_modifier_mask_comes_only_from_pressed_physical_codes():
    adapter = RecordingKeyboardAdapter()
    state = active_state(adapter)
    assert state.apply(key_envelope(seq=1, phase="down", code="ShiftLeft")).status == "applied"
    assert state.apply(key_envelope(seq=2, phase="down", code="ShiftRight")).status == "applied"
    assert state.apply(key_envelope(seq=3, phase="up", code="ShiftLeft")).status == "applied"
    assert state.snapshot().pressed_codes == frozenset({"ShiftRight"})
    assert adapter.last_modifier_mask == SHIFT_MASK


def test_duplicate_gap_stale_stolen_token_and_future_epoch_do_not_execute():
    adapter = RecordingKeyboardAdapter()
    state = active_state(adapter)
    assert state.apply(key_envelope(seq=1, phase="down", code="KeyA")).status == "applied"
    assert state.apply(key_envelope(seq=1, phase="down", code="KeyB")).status == "duplicate"
    assert state.apply(key_envelope(seq=3, phase="down", code="KeyB")).status == "sequence-gap"
    assert state.apply(key_envelope(seq=2, phase="down", code="KeyB", lease_id="other-lease-token-1")).status == "stale-lease"
    assert state.apply(key_envelope(seq=2, epoch=2, phase="down", code="KeyB")).status == "stale-lease"
    assert [event[0] for event in adapter.events] == ["KeyA"]


def test_transition_releases_pressed_keys_and_connection_generation_controls_epoch_changes():
    adapter = RecordingKeyboardAdapter()
    state = active_state(adapter, generation=2, epoch=8)
    state.apply(key_envelope(epoch=8, seq=1, phase="down", code="KeyA"))
    assert state.transition(connection_generation=1, lease_id=LEASE_ID, lease_epoch=9).status == "stale-lease"
    assert state.snapshot().lease_epoch == 8
    assert state.transition(connection_generation=3, lease_id="lease-000000000002", lease_epoch=1).status == "applied"
    assert adapter.events[-1][0:2] == ("KeyA", False)
    assert state.snapshot().connection_generation == 3
    assert state.snapshot().lease_epoch == 1


def test_key_phases_and_repeat_preserve_one_physical_pressed_code():
    adapter = RecordingKeyboardAdapter()
    state = active_state(adapter)
    assert state.apply(key_envelope(seq=1, phase="down", code="KeyR")).status == "applied"
    assert state.apply(key_envelope(seq=2, phase="down", code="KeyR", repeat=True)).status == "applied"
    assert state.snapshot().pressed_codes == frozenset({"KeyR"})
    assert state.apply(key_envelope(seq=3, phase="up", code="KeyR")).status == "applied"
    assert [event[:2] for event in adapter.events] == [("KeyR", True), ("KeyR", True), ("KeyR", False)]


def test_batch_applies_in_order_without_releasing_previously_pressed_key():
    adapter = RecordingKeyboardAdapter()
    state = active_state(adapter)
    state.apply(key_envelope(seq=1, phase="down", code="MetaLeft"))
    batch = envelope(
        "batch",
        seq=2,
        payload={
            "steps": [
                key_payload("down", "KeyC"),
                key_payload("up", "KeyC"),
            ]
        },
    )
    assert state.apply(batch).status == "applied"
    assert state.snapshot().pressed_codes == frozenset({"MetaLeft"})
    assert [event[:2] for event in adapter.events] == [
        ("MetaLeft", True), ("KeyC", True), ("KeyC", False),
    ]


def test_batch_adapter_failure_releases_batch_and_lease_state():
    adapter = FailingKeyboardAdapter("KeyB")
    state = active_state(adapter)
    batch = envelope(
        "batch",
        seq=1,
        payload={"steps": [key_payload("down", "KeyA"), key_payload("down", "KeyB")]},
    )
    assert state.apply(batch).status == "execution-failed"
    assert state.snapshot().pressed_codes == frozenset()
    assert [event[:2] for event in adapter.events] == [("KeyA", True), ("KeyA", False)]


def test_text_scalar_limit_and_unsupported_code_do_not_use_character_fallback():
    adapter = FailingKeyboardAdapter("ContextMenu", UnsupportedPhysicalCode)
    state = active_state(adapter)
    assert state.apply(key_envelope(seq=1, phase="down", code="ContextMenu")).status == "unsupported-code"
    assert adapter.events == []

    too_long = envelope("text", seq=1, payload={"text": "x" * 4097})
    assert validate_remote_input(too_long).code == "TEXT_TOO_LONG"
    text = envelope("text", seq=1, payload={"text": "A\U0001F600\u4e2d"})
    assert state.apply(text).status == "applied"
    assert adapter.events == [("text", "A\U0001F600\u4e2d")]


def test_caps_lock_reconciles_only_when_explicit():
    adapter = RecordingKeyboardAdapter()
    state = active_state(adapter)
    state.apply(key_envelope(seq=1, phase="down", code="KeyA", caps_lock=None))
    assert adapter.caps_lock is False
    state.apply(key_envelope(seq=2, phase="up", code="KeyA", caps_lock=True))
    assert adapter.caps_lock is True


def test_legacy_adapter_issues_sequences_and_resets_before_new_transport():
    adapter = RecordingKeyboardAdapter()
    state = RemoteKeyboardState(adapter)
    legacy = LegacyInputAdapter(state)
    legacy.bind(connection_generation=1, lease_id=LEASE_ID, lease_epoch=1)

    assert legacy.apply({"type": "keyboard", "action": "keydown", "payload": {"code": "KeyA"}}, transport="socket").status == "applied"
    assert legacy.apply({"type": "keyboard", "action": "keyup", "payload": {"code": "KeyA"}}, transport="datachannel").status == "applied"
    assert [event[:2] for event in adapter.events] == [("KeyA", True), ("KeyA", False)]
    assert state.snapshot().last_applied_seq == 3
