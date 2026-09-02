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
