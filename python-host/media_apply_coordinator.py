"""Bounded, generation-aware media policy application.

The viewer may emit several quality samples while a PeerConnection is being
rebuilt.  This small coordinator keeps those samples from becoming repeated
codec reopen requests.  It has no access to aiortc and is therefore usable in
offline tests and in the Host's event loop without introducing another worker.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MediaApplyIdentity:
    attempt_id: str
    generation: int
    profile_sequence: int
    fingerprint: str


@dataclass(frozen=True)
class MediaApplyDecision:
    decision: str
    reason: str
    identity: MediaApplyIdentity


class MediaApplyCoordinator:
    """Admit one current policy and coalesce equivalent pending updates."""

    def __init__(self) -> None:
        self._attempt_id: str | None = None
        self._current: MediaApplyIdentity | None = None
        self._pending: MediaApplyIdentity | None = None
        self._apply_count = 0
        self._noop_count = 0
        self._stale_count = 0

    @property
    def current(self) -> MediaApplyIdentity | None:
        return self._current

    @property
    def pending(self) -> MediaApplyIdentity | None:
        return self._pending

    @property
    def stats(self) -> dict[str, int]:
        return {
            "apply": self._apply_count,
            "noOp": self._noop_count,
            "stale": self._stale_count,
        }

    def bind_attempt(self, attempt_id: str) -> None:
        value = str(attempt_id or "")
        if not value:
            raise ValueError("attempt_id is required")
        self._attempt_id = value
        self._current = None
        self._pending = None

    def admit(self, identity: MediaApplyIdentity) -> MediaApplyDecision:
        if not isinstance(identity, MediaApplyIdentity):
            raise TypeError("identity must be a MediaApplyIdentity")
        if not self._attempt_id:
            self._stale_count += 1
            return MediaApplyDecision("reject", "no-active-attempt", identity)
        if identity.attempt_id != self._attempt_id:
            self._stale_count += 1
            return MediaApplyDecision("reject", "stale-attempt", identity)
        for existing in (self._pending, self._current):
            if existing is None:
                continue
            if (
                existing.generation == identity.generation
                and existing.fingerprint == identity.fingerprint
            ):
                self._noop_count += 1
                return MediaApplyDecision("no-op", "same-fingerprint", identity)
            if identity.generation < existing.generation:
                self._stale_count += 1
                return MediaApplyDecision("reject", "stale-generation", identity)
            if (
                identity.generation == existing.generation
                and identity.profile_sequence < existing.profile_sequence
            ):
                self._stale_count += 1
                return MediaApplyDecision("reject", "stale-profile-sequence", identity)
        self._pending = identity
        self._apply_count += 1
        return MediaApplyDecision("stage", "new-fingerprint", identity)

    def mark_applied(self, identity: MediaApplyIdentity) -> bool:
        """Advance the generation only after the encoder used the policy."""
        if self._pending != identity and self._current != identity:
            return False
        self._current = identity
        if self._pending == identity:
            self._pending = None
        return True

    def cancel_pending(self) -> None:
        self._pending = None
