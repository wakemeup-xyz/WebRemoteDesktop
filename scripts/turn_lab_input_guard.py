"""Final fail-closed guard before the laboratory delegates to InputHandler."""

from __future__ import annotations

import inspect
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
        self._installed = False
        self._bound_actions: dict[str, dict[str, Any]] = {}

    @property
    def installed(self) -> bool:
        return self._installed

    def install_at_lab_host(self, input_adapter: Any) -> "GuardedLabInputAdapter":
        """Install at the Lab Host's existing InputAdapter boundary.

        The wrapper preserves the original adapter and only intercepts an
        inputId that the Lab Host bound to a controlled scene.  It never creates a
        second input path or emits a desktop event itself.
        """
        self._installed = True
        return GuardedLabInputAdapter(self, input_adapter)

    def bind_controlled_input(self, action: dict[str, Any]) -> None:
        """Bind an already-issued Viewer inputId on the Lab Host side.

        This is deliberately not a Viewer envelope extension: production's
        strict input schema continues to see its original data unchanged.
        """
        self._verify(action)
        input_id = action["inputId"]
        if input_id in self._bound_actions:
            raise InputGuardRejected("controlled inputId is already bound")
        self._bound_actions[input_id] = dict(action)

    def action_for_envelope(self, envelope: Any) -> dict[str, Any] | None:
        ids = envelope.get("inputIds") if isinstance(envelope, dict) else None
        if not isinstance(ids, list) or not all(isinstance(value, str) and value for value in ids):
            return None
        matches = [self._bound_actions[value] for value in ids if value in self._bound_actions]
        if not matches:
            return None
        if len(ids) != 1 or len(matches) != 1:
            raise InputGuardRejected("controlled input envelope must contain one bound inputId")
        return matches[0]

    def is_input_bound(self, input_id: Any) -> bool:
        return isinstance(input_id, str) and input_id in self._bound_actions

    def _verify(self, action: dict[str, Any], *, execution_mode: str = "automatic-isolated") -> None:
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
        return None

    def execute(self, action: dict[str, Any], *, execution_mode: str = "automatic-isolated") -> Any:
        self._verify(action, execution_mode=execution_mode)
        return self._input_handler(action)

    async def execute_async(self, action: dict[str, Any], delegate: Callable[[], Any], *, execution_mode: str = "automatic-isolated") -> Any:
        # Reuse the exact identity/fixture verification immediately before the
        # original adapter executes; the local handler is intentionally not
        # called here because that would inject the same Viewer action twice.
        self._verify(action, execution_mode=execution_mode)
        result = delegate()
        return await result if inspect.isawaitable(result) else result


class GuardedLabInputAdapter:
    """Adapter-shaped boundary used only by ``LabWebRemoteHost``."""

    def __init__(self, guard: LabInputGuard, delegate: Any) -> None:
        self._guard, self._delegate = guard, delegate

    async def apply_keyboard(self, envelope: dict[str, Any], *, transport: Any = None) -> Any:
        action = self._guard.action_for_envelope(envelope)
        if action is None:
            raise InputGuardRejected("unbound inputId rejected by automatic laboratory")
        return await self._guard.execute_async(action, lambda: self._delegate.apply_keyboard(envelope, transport=transport))

    async def handle_input(self, envelope: dict[str, Any]) -> Any:
        action = self._guard.action_for_envelope(envelope)
        if action is None:
            raise InputGuardRejected("unbound inputId rejected by automatic laboratory")
        return await self._guard.execute_async(action, lambda: self._delegate.handle_input(envelope))

    def __getattr__(self, name: str) -> Any:
        return getattr(self._delegate, name)
