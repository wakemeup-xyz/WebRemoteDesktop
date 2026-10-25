from remote_desktop_write_state import ReliableDesktopWriteState


LEASE_ID = "lease-000000000001"


def write(*, action, seq=None, input_id="desktop-1", payload=None):
    data = {
        "schemaVersion": 2,
        "type": "command" if action == "showDock" else "mouse",
        "action": action,
        "leaseId": LEASE_ID,
        "leaseEpoch": 4,
        "inputIds": [input_id],
        "payload": {} if payload is None else payload,
    }
    if seq is not None:
        data["seq"] = seq
    return data


def test_reliable_desktop_writes_are_lease_ordered_and_moves_do_not_consume_sequence():
    state = ReliableDesktopWriteState()
    assert state.transition(lease_id=LEASE_ID, lease_epoch=4).status == "applied"

    move = write(action="move", payload={"relX": 0.2, "relY": 0.3, "buttons": 0})
    assert state.apply(move).status == "unordered"
    assert state.apply(write(action="down", seq=1, input_id="down-1", payload={
        "relX": 0.2, "relY": 0.3, "button": "left", "clickCount": 1, "buttons": 1,
    })).status == "applied"
    assert state.apply(write(action="down", seq=1, input_id="down-duplicate", payload={
        "relX": 0.2, "relY": 0.3, "button": "left", "clickCount": 1, "buttons": 1,
    })).status == "duplicate"
    assert state.apply(write(action="showDock", seq=3, input_id="command-gap")).status == "sequence-gap"
    assert state.apply(write(action="reset", seq=2, input_id="reset-2", payload={"reason": "manual"})).status == "applied"
    assert state.snapshot().last_applied_seq == 2


def test_reset_jumps_only_after_commit_and_fences_late_ordinary_writes():
    state = ReliableDesktopWriteState()
    state.transition(lease_id=LEASE_ID, lease_epoch=4)
    assert state.apply(write(action="showDock", seq=1)).status == "applied"
    reset = write(action="reset", seq=3, input_id="fence-3", payload={"reason": "manual"})
    assert state.validate(reset).status == "applied"
    assert state.snapshot().last_applied_seq == 1
    assert state.commit(3).status == "sequence-gap"
    assert state.commit_reset(reset).status == "applied"
    assert state.snapshot().last_applied_seq == 3
    assert state.validate(write(action="showDock", seq=2)).status == "duplicate"
    assert state.validate(write(action="showDock", seq=5)).status == "sequence-gap"


def test_only_exact_successful_reset_proof_can_duplicate_even_after_later_write():
    state = ReliableDesktopWriteState()
    state.transition(lease_id=LEASE_ID, lease_epoch=4)
    assert state.apply(write(action="showDock", seq=1)).status == "applied"
    collision = write(action="reset", seq=1, payload={"reason": "manual"})
    assert state.validate(collision).status == "resync-required"
    assert state.commit_reset(collision).status == "resync-required"
    reset = write(action="reset", seq=3, input_id="proof", payload={"reason": "manual"})
    assert state.apply(reset).status == "applied"
    assert state.apply(write(action="showDock", seq=4)).status == "applied"
    assert state.validate(reset).status == "duplicate"
    assert state.validate({**reset, "inputIds": ["different"]}).status == "resync-required"
    replacement = write(action="reset", seq=6, input_id="new-proof", payload={"reason": "manual"})
    assert state.apply(replacement).status == "applied"
    assert state.validate(reset).status == "resync-required"
    assert "proof" not in repr(state.snapshot())
    state.transition(lease_id=LEASE_ID, lease_epoch=5)
    assert state.validate(reset).status == "stale-lease"
    assert state.apply(write(action="showDock", seq=1) | {"leaseEpoch": 5}).status == "applied"
    assert state.validate(collision | {"leaseEpoch": 5}).status == "resync-required"


def test_reset_proof_rejects_unbounded_or_invalid_ids_and_rechecks_lease():
    state = ReliableDesktopWriteState()
    state.transition(lease_id=LEASE_ID, lease_epoch=4)
    reset = write(action="reset", seq=3, payload={"reason": "manual"})
    for ids in (["x" * 129], ["x"] * 65, [3], ["bad id"], []):
        assert state.validate(reset | {"inputIds": ids}).status == "invalid-input"
    assert state.validate(reset).status == "applied"
    state.transition(lease_id="lease-000000000002", lease_epoch=5)
    assert state.commit_reset(reset).status == "stale-lease"
    assert state.snapshot().last_applied_seq == 0
