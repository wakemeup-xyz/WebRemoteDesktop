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

    def __init__(self, *, desktop_proof: Callable[[], dict[str, Any]], input_handler: Callable[[dict[str, Any]], Any]) -> None:
        self._desktop_proof = desktop_proof
        self._input_handler = input_handler

    def execute(self, action: dict[str, Any], *, execution_mode: str = "automatic-isolated") -> Any:
        if execution_mode != "automatic-isolated":
            raise InputGuardRejected("execution mode is not automatic-isolated")
        proof = self._desktop_proof()
        if proof.get("isolated") is not True:
            raise InputGuardRejected("isolated laboratory desktop required")
        if proof.get("foreground") is not True:
            raise InputGuardRejected("fixture window is not foreground")
        if proof.get("fixtureWindow") is not True:
            raise InputGuardRejected("fixture window identity required")
        return self._input_handler(action)
