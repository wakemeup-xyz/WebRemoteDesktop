from media_apply_coordinator import MediaApplyCoordinator, MediaApplyIdentity


def identity(*, attempt="a", generation=1, seq=1, fingerprint="p1"):
    return MediaApplyIdentity(attempt, generation, seq, fingerprint)


def test_same_fixed_policy_is_coalesced_without_reopen():
    coordinator = MediaApplyCoordinator()
    coordinator.bind_attempt("a")

    first = coordinator.admit(identity())
    replay = coordinator.admit(identity(seq=99))

    assert first.decision == "stage"
    assert replay.decision == "no-op"
    assert coordinator.stats == {"apply": 1, "noOp": 1, "stale": 0}


def test_old_generation_cannot_replace_pending_policy():
    coordinator = MediaApplyCoordinator()
    coordinator.bind_attempt("a")
    coordinator.admit(identity(generation=3, fingerprint="new"))

    stale = coordinator.admit(identity(generation=2, fingerprint="old"))

    assert stale.decision == "reject"
    assert stale.reason == "stale-generation"
    assert coordinator.pending.fingerprint == "new"


def test_generation_advances_only_when_marked_applied():
    coordinator = MediaApplyCoordinator()
    coordinator.bind_attempt("a")
    current = identity(generation=1, fingerprint="one")
    assert coordinator.admit(current).decision == "stage"
    assert coordinator.current is None
    assert coordinator.mark_applied(current) is True
    assert coordinator.current == current
