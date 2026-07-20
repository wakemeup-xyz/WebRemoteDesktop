'use strict';

const STATES = new Set(['FREE', 'GRANTING', 'ACTIVE', 'REVOKING']);

class DesktopControlLease {
  constructor({
    now,
    makeLeaseId,
    heartbeatIntervalMs = 3000,
    expiresAfterMs = 12000,
    transitionTimeoutMs = 3000,
  }) {
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (typeof makeLeaseId !== 'function') throw new TypeError('makeLeaseId must be a function');
    this._now = now;
    this._makeLeaseId = makeLeaseId;
    this._heartbeatIntervalMs = heartbeatIntervalMs;
    this._expiresAfterMs = expiresAfterMs;
    this._transitionTimeoutMs = transitionTimeoutMs;
    this._state = 'FREE';
    this._epoch = 0;
    this._active = null;
    this._pending = null;
    this._activeDeadline = null;
    this._transitionDeadline = null;
    this._barrierReason = null;
  }

  requestControl({ viewerId, takeover = false }) {
    if (!viewerId) return { state: this._state, reason: 'invalid-viewer' };
    if (this._isActiveExpired()) return { state: this._state, reason: 'lease-expired' };

    if (this._state !== 'FREE') {
      if (!takeover || this._state !== 'ACTIVE') {
        return {
          state: this._state,
          reason: 'occupied',
          controllerViewerId: this._state === 'ACTIVE' && this._active ? this._active.viewerId : null,
        };
      }
      this._active = null;
      this._activeDeadline = null;
      this._state = 'REVOKING';
    } else {
      this._state = 'GRANTING';
    }

    const leaseEpoch = ++this._epoch;
    this._pending = { viewerId, leaseId: this._makeLeaseId(), leaseEpoch };
    this._transitionDeadline = this._now() + this._transitionTimeoutMs;
    const transition = {
      type: 'control-transition',
      viewerId,
      leaseEpoch,
    };
    return { state: this._state, transition };
  }

  confirmTransition({ leaseEpoch }) {
    if (!this._pending || this._pending.leaseEpoch !== leaseEpoch) {
      return { state: this._state, reason: 'stale-transition' };
    }
    const pending = this._pending;
    this._pending = null;
    this._transitionDeadline = null;
    this._barrierReason = null;
    if (pending.viewerId === null) {
      this._state = 'FREE';
      this._active = null;
      this._activeDeadline = null;
      return { state: 'FREE', reason: pending.reason || 'released' };
    }
    this._active = pending;
    this._activeDeadline = this._now() + this._expiresAfterMs;
    this._state = 'ACTIVE';
    return {
      state: 'ACTIVE',
      lease: { leaseId: pending.leaseId, leaseEpoch: pending.leaseEpoch },
    };
  }

  failTransition({ leaseEpoch, reason = 'transition-failed' }) {
    if (!this._pending || this._pending.leaseEpoch !== leaseEpoch) {
      return { state: this._state, reason: 'stale-transition' };
    }

    const failureReason = reason || 'transition-failed';

    // Reset-only barrier: Host outcome is unknown/failed. Stay fail-closed on
    // the same epoch; never manufacture FREE/ACTIVE. Clear the deadline so
    // expire() does not re-fire until a retry adapter schedules work.
    if (this._pending.viewerId === null) {
      this._state = 'REVOKING';
      this._active = null;
      this._activeDeadline = null;
      this._transitionDeadline = null;
      this._pending.reason = failureReason;
      this._barrierReason = failureReason;
      return { state: 'REVOKING', reason: failureReason };
    }

    // Candidate GRANTING/REVOKING with a viewer: discard the candidate token,
    // bump epoch once, and open a reset-only REVOKING barrier.
    this._active = null;
    this._activeDeadline = null;
    this._state = 'REVOKING';
    const nextEpoch = ++this._epoch;
    this._pending = { viewerId: null, leaseEpoch: nextEpoch, reason: failureReason };
    this._transitionDeadline = this._now() + this._transitionTimeoutMs;
    this._barrierReason = failureReason;
    return {
      state: 'REVOKING',
      reason: failureReason,
      transition: {
        type: 'control-transition',
        leaseEpoch: nextEpoch,
        reason: failureReason,
      },
    };
  }

  // Compatibility alias: all rejection/timeout paths use fail-closed semantics.
  rejectTransition({ leaseEpoch, reason }) {
    return this.failTransition({ leaseEpoch, reason });
  }

  heartbeat({ viewerId, leaseId, leaseEpoch }) {
    if (!this.authorize({ viewerId, leaseId, leaseEpoch })) {
      return { state: this._state, ok: false, reason: 'unauthorized' };
    }
    this._activeDeadline = this._now() + this._expiresAfterMs;
    return { state: 'ACTIVE', ok: true };
  }

  beginRelease({ viewerId, reason }) {
    if (this._state === 'ACTIVE' && this._active && this._active.viewerId === viewerId) {
      return this._beginResetTransition(reason || 'released');
    }
    if ((this._state === 'GRANTING' || this._state === 'REVOKING')
      && this._pending && this._pending.viewerId === viewerId) {
      this._pending = {
        viewerId: null,
        leaseEpoch: this._pending.leaseEpoch,
        reason: reason || 'released',
      };
      return {
        state: this._state,
        reason: reason || 'released',
        transition: {
          type: 'control-transition',
          leaseEpoch: this._pending.leaseEpoch,
          reason: reason || 'released',
        },
      };
    }
    if (this._pending && this._pending.viewerId === viewerId) {
      return this._free(reason || 'released');
    }
    return { state: this._state, reason: 'not-controller' };
  }

  viewerDisconnected(viewerId) {
    if ((this._state === 'GRANTING' || this._state === 'REVOKING')
      && this._pending && this._pending.viewerId === viewerId) {
      this._pending = {
        viewerId: null,
        leaseEpoch: this._pending.leaseEpoch,
        reason: 'controller-disconnect',
      };
      return {
        state: this._state,
        reason: 'controller-disconnect',
        transition: {
          type: 'control-transition',
          leaseEpoch: this._pending.leaseEpoch,
          reason: 'controller-disconnect',
        },
      };
    }
    // ACTIVE controller disconnect must open a formal reset-only barrier.
    // Freeing immediately would let a new Viewer acquire before Host reset ack.
    if (this._state === 'ACTIVE' && this._active && this._active.viewerId === viewerId) {
      return this._beginResetTransition('controller-disconnect');
    }
    if (this._pending && this._pending.viewerId === viewerId) {
      return this._beginResetTransition('controller-disconnect');
    }
    return { state: this._state, reason: 'not-controller' };
  }

  hostDisconnected() {
    this._active = null;
    this._pending = null;
    this._activeDeadline = null;
    this._transitionDeadline = null;
    this._barrierReason = null;
    this._state = 'FREE';
    return { state: 'FREE', reason: 'host-disconnect' };
  }

  expire() {
    const expired = this._expire();
    return expired || { state: this._state };
  }

  authorize({ viewerId, leaseId, leaseEpoch }) {
    return this._state === 'ACTIVE'
      && this._active !== null
      && !this._isActiveExpired()
      && this._active.viewerId === viewerId
      && this._active.leaseId === leaseId
      && this._active.leaseEpoch === leaseEpoch;
  }

  snapshot() {
    let leaseEpoch = null;
    if (this._state === 'ACTIVE' && this._active) {
      leaseEpoch = this._active.leaseEpoch;
    } else if (this._pending) {
      leaseEpoch = this._pending.leaseEpoch;
    }
    const snapshot = {
      state: STATES.has(this._state) ? this._state : 'FREE',
      controllerViewerId: this._state === 'ACTIVE' && this._active ? this._active.viewerId : null,
      pendingViewerId: this._pending ? this._pending.viewerId : null,
      leaseEpoch,
      heartbeatIntervalMs: this._heartbeatIntervalMs,
      expiresAfterMs: this._expiresAfterMs,
    };
    if (this._barrierReason) snapshot.reason = this._barrierReason;
    return snapshot;
  }

  transitionForHost({ leaseEpoch }) {
    if (!Number.isSafeInteger(leaseEpoch)
      || !this._pending
      || this._pending.leaseEpoch !== leaseEpoch) return null;
    const transition = {
      type: 'control-transition',
      leaseEpoch: this._pending.leaseEpoch,
    };
    if (this._pending.viewerId !== null) {
      transition.viewerId = this._pending.viewerId;
      transition.leaseId = this._pending.leaseId;
    }
    if (this._pending.reason) transition.reason = this._pending.reason;
    return transition;
  }

  _expire() {
    const now = this._now();
    if (this._pending && this._transitionDeadline !== null && now >= this._transitionDeadline) {
      // Candidate and reset-only timeouts both converge through failTransition:
      // unknown Host outcome never opens FREE.
      return this.failTransition({
        leaseEpoch: this._pending.leaseEpoch,
        reason: 'transition-timeout',
      });
    }
    if (this._state === 'ACTIVE' && this._activeDeadline !== null && now >= this._activeDeadline) {
      return this._beginResetTransition('lease-expired');
    }
    return null;
  }

  _free(reason) {
    this._state = 'FREE';
    this._active = null;
    this._pending = null;
    this._activeDeadline = null;
    this._transitionDeadline = null;
    this._barrierReason = null;
    return { state: 'FREE', reason };
  }

  _beginResetTransition(reason) {
    this._active = null;
    this._activeDeadline = null;
    this._state = 'REVOKING';
    const leaseEpoch = ++this._epoch;
    this._pending = { viewerId: null, leaseEpoch, reason };
    this._transitionDeadline = this._now() + this._transitionTimeoutMs;
    this._barrierReason = null;
    return {
      state: 'REVOKING',
      reason,
      transition: { type: 'control-transition', leaseEpoch, reason },
    };
  }

  _isActiveExpired() {
    return this._state === 'ACTIVE'
      && this._activeDeadline !== null
      && this._now() >= this._activeDeadline;
  }
}

module.exports = { DesktopControlLease };
