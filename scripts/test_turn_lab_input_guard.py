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
        desktop_proof=lambda: {"isolated": False, "foreground": True, "fixtureWindow": True},
        input_handler=lambda action: called.append(action),
    )
    with pytest.raises(guard_module.InputGuardRejected, match="isolated"):
        guard.execute({"inputId": "one"})
    assert called == []


def test_guard_rechecks_foreground_and_delegates_to_existing_handler_only_when_valid():
    called = []
    guard = guard_module.LabInputGuard(
        desktop_proof=lambda: {"isolated": True, "foreground": True, "fixtureWindow": True},
        input_handler=lambda action: called.append(action) or {"status": "applied", "inputId": action["inputId"]},
    )
    assert guard.execute({"inputId": "one"}) == {"status": "applied", "inputId": "one"}
    assert called == [{"inputId": "one"}]


def test_guard_rejects_producer_local_and_missing_fixture_without_an_input_bypass():
    called = []
    guard = guard_module.LabInputGuard(
        desktop_proof=lambda: {"isolated": True, "foreground": True, "fixtureWindow": False},
        input_handler=lambda action: called.append(action),
    )
    with pytest.raises(guard_module.InputGuardRejected, match="fixture"):
        guard.execute({"inputId": "one"}, execution_mode="automatic-isolated")
    with pytest.raises(guard_module.InputGuardRejected, match="execution mode"):
        guard.execute({"inputId": "two"}, execution_mode="producer-local")
    assert called == []
