'use strict';

/**
 * Transport-independent bounded retry for reset-only control transitions.
 * Owns only timers and generation safety. Never mutates lease state.
 */
class ControlTransitionRetry {
  constructor({
    delaysMs = [1000, 2000, 4000],
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}) {
    if (!Array.isArray(delaysMs) || delaysMs.length === 0) {
      throw new TypeError('delaysMs must be a non-empty array');
    }
    this._delaysMs = delaysMs.slice();
    this._setTimeout = setTimeoutFn;
    this._clearTimeout = clearTimeoutFn;
    this._timer = null;
    this._generation = 0;
    this._leaseEpoch = null;
    this._attempt = 0;
    this._active = false;
    this._onRetry = null;
    this._onBlocked = null;
  }

  get active() {
    return this._active;
  }

  get leaseEpoch() {
    return this._leaseEpoch;
  }

  get attempt() {
    return this._attempt;
  }

  get generation() {
    return this._generation;
  }

  /**
   * Begin (or restart) retries for a reset-only barrier epoch.
   * Cancels any previous schedule first.
   */
  start({ leaseEpoch, onRetry, onBlocked }) {
    if (!Number.isSafeInteger(leaseEpoch)) {
      throw new TypeError('leaseEpoch must be a safe integer');
    }
    if (typeof onRetry !== 'function') throw new TypeError('onRetry must be a function');
    if (typeof onBlocked !== 'function') throw new TypeError('onBlocked must be a function');

    this.cancel();
    this._generation += 1;
    this._leaseEpoch = leaseEpoch;
    this._attempt = 0;
    this._active = true;
    this._onRetry = onRetry;
    this._onBlocked = onBlocked;
    this._scheduleNext();
    return { generation: this._generation, leaseEpoch };
  }

  /**
   * Cancel any live timer and mark inactive. Safe to call repeatedly.
   */
  cancel() {
    if (this._timer !== null) {
      this._clearTimeout(this._timer);
      this._timer = null;
    }
    this._active = false;
    this._onRetry = null;
    this._onBlocked = null;
    // Keep generation and last leaseEpoch for stale-callback diagnostics;
    // attempt is left as-is for observability of how far it got.
  }

  _scheduleNext() {
    if (!this._active) return;
    if (this._attempt >= this._delaysMs.length) {
      const payload = {
        leaseEpoch: this._leaseEpoch,
        attempt: this._attempt,
        generation: this._generation,
      };
      const onBlocked = this._onBlocked;
      this.cancel();
      onBlocked?.(payload);
      return;
    }

    const delay = this._delaysMs[this._attempt];
    const generation = this._generation;
    const leaseEpoch = this._leaseEpoch;
    const nextAttempt = this._attempt + 1;

    this._timer = this._setTimeout(() => {
      this._timer = null;
      if (!this._active || generation !== this._generation || leaseEpoch !== this._leaseEpoch) {
        return;
      }
      this._attempt = nextAttempt;
      const onRetry = this._onRetry;
      onRetry?.({
        leaseEpoch,
        attempt: this._attempt,
        generation,
        delayMs: delay,
      });
      if (!this._active || generation !== this._generation) return;
      if (this._attempt >= this._delaysMs.length) {
        const onBlocked = this._onBlocked;
        this.cancel();
        onBlocked?.({
          leaseEpoch,
          attempt: nextAttempt,
          generation,
        });
        return;
      }
      this._scheduleNext();
    }, delay);
  }
}

module.exports = { ControlTransitionRetry };
