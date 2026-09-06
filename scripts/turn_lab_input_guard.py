"""Final fail-closed guard before the laboratory delegates to InputHandler."""

from __future__ import annotations

from typing import Any, Callable


class InputGuardRejected(RuntimeError):
    pass


class LabInputGuard:
    """Check the disposable desktop at the injection boundary, then delegate.

    This class deliberately does not emit Quartz events.  The supplied handler
    is the existing InputAdapter/InputHandler path owned by the Lab Host.
    """

    def __init__(self, *, desktop_proof: Callable[[], dict[str, Any]], input_handler: Callable[[dict[str, Any]], Any],
                 expected_lease_id: str | None = None, expected_proof_token: str | None = None,
                 expected_fixture_id: str | None = None) -> None:
        if not all(isinstance(value, str) and value for value in (expected_lease_id, expected_proof_token, expected_fixture_id)):
            raise ValueError("expected lab lease, proof and fixture identities are required")
        self._desktop_proof = desktop_proof
        self._input_handler = input_handler
        self._expected_lease_id = expected_lease_id
        self._expected_proof_token = expected_proof_token
        self._expected_fixture_id = expected_fixture_id

    def execute(self, action: dict[str, Any], *, execution_mode: str = "automatic-isolated") -> Any:
        if execution_mode != "automatic-isolated":
            raise InputGuardRejected("execution mode is not automatic-isolated")
        if not isinstance(action, dict) or not isinstance(action.get("inputId"), str) or not action["inputId"]:
            raise InputGuardRejected("a non-empty inputId is required")
        if (action.get("leaseId") != self._expected_lease_id or action.get("proofToken") != self._expected_proof_token
                or action.get("fixtureId") != self._expected_fixture_id):
            raise InputGuardRejected("action lease/proof/fixture identity mismatch")
        proof = self._desktop_proof()
        if not isinstance(proof, dict):
            raise InputGuardRejected("fixture identity probe is invalid")
        if proof.get("leaseId") != self._expected_lease_id:
            raise InputGuardRejected("lease identity changed")
        if proof.get("proofToken") != self._expected_proof_token:
            raise InputGuardRejected("proof identity changed")
        if proof.get("fixtureId") != self._expected_fixture_id:
            raise InputGuardRejected("fixture identity changed")
        if proof.get("isolated") is not True:
            raise InputGuardRejected("isolated laboratory desktop required")
        if proof.get("foreground") is not True:
            raise InputGuardRejected("fixture window is not foreground")
        if proof.get("fixtureWindow") is not True:
            raise InputGuardRejected("fixture window identity required")
        return self._input_handler(action)
