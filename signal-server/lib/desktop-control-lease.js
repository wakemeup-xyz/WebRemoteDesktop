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
  }

  requestControl({ viewerId, takeover = false }) {
    this._expire();
    if (!viewerId) return { state: this._state, reason: 'invalid-viewer' };

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
    this._expire();
    if (!this._pending || this._pending.leaseEpoch !== leaseEpoch) {
      return { state: this._state, reason: 'stale-transition' };
    }
    const pending = this._pending;
    this._pending = null;
    this._transitionDeadline = null;
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

  rejectTransition({ leaseEpoch, reason }) {
    this._expire();
    if (!this._pending || this._pending.leaseEpoch !== leaseEpoch) {
      return { state: this._state, reason: 'stale-transition' };
    }
    if (this._pending.viewerId === null) {
      const releaseReason = this._pending.reason || reason || 'released';
      this._pending = null;
      this._transitionDeadline = null;
      this._state = 'FREE';
      this._active = null;
      this._activeDeadline = null;
      return { state: 'FREE', reason: releaseReason };
    }
    this._pending = null;
    this._transitionDeadline = null;
    this._state = 'FREE';
    this._active = null;
    this._activeDeadline = null;
    return { state: 'FREE', reason: reason || 'transition-rejected' };
  }

  heartbeat({ viewerId, leaseId, leaseEpoch }) {
    this._expire();
    if (!this.authorize({ viewerId, leaseId, leaseEpoch })) {
      return { state: this._state, ok: false, reason: 'unauthorized' };
    }
    this._activeDeadline = this._now() + this._expiresAfterMs;
    return { state: 'ACTIVE', ok: true };
  }

  beginRelease({ viewerId, reason }) {
    this._expire();
    if (this._state === 'ACTIVE' && this._active && this._active.viewerId === viewerId) {
      this._active = null;
      this._activeDeadline = null;
      this._state = 'REVOKING';
      const leaseEpoch = ++this._epoch;
      this._pending = { viewerId: null, leaseEpoch, reason: reason || 'released' };
      this._transitionDeadline = this._now() + this._transitionTimeoutMs;
      return {
        state: 'REVOKING',
        transition: { type: 'control-transition', leaseEpoch, reason: reason || 'released' },
      };
    }
    if (this._pending && this._pending.viewerId === viewerId) {
      return this._free(reason || 'released');
    }
    return { state: this._state, reason: 'not-controller' };
  }

  viewerDisconnected(viewerId) {
    this._expire();
    if ((this._active && this._active.viewerId === viewerId)
      || (this._pending && this._pending.viewerId === viewerId)) {
      return this._free('controller-disconnect');
    }
    return { state: this._state, reason: 'not-controller' };
  }

  hostDisconnected() {
    this._active = null;
    this._pending = null;
    this._activeDeadline = null;
    this._transitionDeadline = null;
    this._state = 'FREE';
    return { state: 'FREE', reason: 'host-disconnect' };
  }

  expire() {
    const expired = this._expire();
    return expired || { state: this._state };
  }

  authorize({ viewerId, leaseId, leaseEpoch }) {
    this._expire();
    return this._state === 'ACTIVE'
      && this._active !== null
      && this._active.viewerId === viewerId
      && this._active.leaseId === leaseId
      && this._active.leaseEpoch === leaseEpoch;
  }

  snapshot() {
    this._expire();
    return {
      state: STATES.has(this._state) ? this._state : 'FREE',
      controllerViewerId: this._state === 'ACTIVE' && this._active ? this._active.viewerId : null,
      pendingViewerId: this._pending ? this._pending.viewerId : null,
      leaseEpoch: this._state === 'ACTIVE' && this._active ? this._active.leaseEpoch : null,
      heartbeatIntervalMs: this._heartbeatIntervalMs,
      expiresAfterMs: this._expiresAfterMs,
    };
  }

  _expire() {
    const now = this._now();
    if (this._pending && this._transitionDeadline !== null && now >= this._transitionDeadline) {
      this._pending = null;
      this._transitionDeadline = null;
      this._active = null;
      this._activeDeadline = null;
      this._state = 'FREE';
      return { state: 'FREE', reason: 'transition-timeout' };
    }
    if (this._state === 'ACTIVE' && this._activeDeadline !== null && now >= this._activeDeadline) {
      return this._free('lease-expired');
    }
    return null;
  }

  _free(reason) {
    this._state = 'FREE';
    this._active = null;
    this._pending = null;
    this._activeDeadline = null;
    this._transitionDeadline = null;
    return { state: 'FREE', reason };
  }
}

module.exports = { DesktopControlLease };
