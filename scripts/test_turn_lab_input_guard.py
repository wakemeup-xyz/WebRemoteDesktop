import importlib.util
from pathlib import Path

import pytest


SCRIPT = Path(__file__).with_name("turn_lab_input_guard.py")
SPEC = importlib.util.spec_from_file_location("turn_lab_input_guard", SCRIPT)
guard_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard_module)


def test_guard_refuses_shared_desktop_before_reaching_input_handler():
    called = []
    guard = guard_module.LabInputGuard(
        expected_lease_id="lease", expected_proof_token="proof", expected_fixture_id="fixture",
        desktop_proof=lambda: {"leaseId": "lease", "proofToken": "proof", "fixtureId": "fixture", "isolated": False, "foreground": True, "fixtureWindow": True},
        input_handler=lambda action: called.append(action),
    )
    with pytest.raises(guard_module.InputGuardRejected, match="isolated"):
        guard.execute({"inputId": "one", "leaseId": "lease", "proofToken": "proof", "fixtureId": "fixture"})
    assert called == []


def test_guard_rechecks_foreground_and_delegates_to_existing_handler_only_when_valid():
    called = []
    guard = guard_module.LabInputGuard(
        expected_lease_id="lease", expected_proof_token="proof", expected_fixture_id="fixture",
        desktop_proof=lambda: {"leaseId": "lease", "proofToken": "proof", "fixtureId": "fixture", "isolated": True, "foreground": True, "fixtureWindow": True},
        input_handler=lambda action: called.append(action) or {"status": "applied", "inputId": action["inputId"]},
    )
    action = {"inputId": "one", "leaseId": "lease", "proofToken": "proof", "fixtureId": "fixture"}
    assert guard.execute(action) == {"status": "applied", "inputId": "one"}
    assert called == [action]


def test_guard_rejects_producer_local_and_missing_fixture_without_an_input_bypass():
    called = []
    guard = guard_module.LabInputGuard(
        expected_lease_id="lease", expected_proof_token="proof", expected_fixture_id="fixture",
        desktop_proof=lambda: {"leaseId": "lease", "proofToken": "proof", "fixtureId": "fixture", "isolated": True, "foreground": True, "fixtureWindow": False},
        input_handler=lambda action: called.append(action),
    )
    with pytest.raises(guard_module.InputGuardRejected, match="fixture"):
        guard.execute({"inputId": "one", "leaseId": "lease", "proofToken": "proof", "fixtureId": "fixture"}, execution_mode="automatic-isolated")
    with pytest.raises(guard_module.InputGuardRejected, match="execution mode"):
        guard.execute({"inputId": "two", "leaseId": "lease", "proofToken": "proof", "fixtureId": "fixture"}, execution_mode="producer-local")
    assert called == []


def test_guard_requires_exact_lease_proof_fixture_and_action_identity_at_injection_time():
    called = []
    guard = guard_module.LabInputGuard(
        expected_lease_id="lease-1", expected_proof_token="proof-1", expected_fixture_id="fixture-1",
        desktop_proof=lambda: {"leaseId": "lease-1", "proofToken": "proof-1", "fixtureId": "fixture-1", "isolated": True, "foreground": True, "fixtureWindow": True},
        input_handler=lambda action: called.append(action) or {"status": "applied"},
    )
    action = {"inputId": "input-1", "leaseId": "lease-1", "proofToken": "proof-1", "fixtureId": "fixture-1"}
    assert guard.execute(action) == {"status": "applied"}
    for field, bad in (("leaseId", "old"), ("proofToken", "bad"), ("fixtureId", "other"), ("inputId", "")):
        invalid = dict(action); invalid[field] = bad
        with pytest.raises(guard_module.InputGuardRejected):
            guard.execute(invalid)
    assert called == [action]


def test_guard_rejects_forged_generic_boolean_desktop_claims_without_bound_identity():
    guard = guard_module.LabInputGuard(
        expected_lease_id="lease-1", expected_proof_token="proof-1", expected_fixture_id="fixture-1",
        desktop_proof=lambda: {"isolated": True, "foreground": True, "fixtureWindow": True},
        input_handler=lambda _action: None,
    )
    with pytest.raises(guard_module.InputGuardRejected, match="lease"):
        guard.execute({"inputId": "input-1", "leaseId": "lease-1", "proofToken": "proof-1", "fixtureId": "fixture-1"})
