'use strict';

/**
 * Applied media phase adapter. Owns only transport/application phase.
 * Desired reasons live solely in MediaActivityController.
 */
(function registerMediaActivityRuntime(globalObject) {
  const PHASES = new Set(['active', 'suspending', 'suspended', 'resuming']);

  function createMediaActivityRuntime(options = {}) {
    const setTimeoutFn = options.setTimeoutFn || setTimeout;
    const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
    const onPhaseChange = typeof options.onPhaseChange === 'function' ? options.onPhaseChange : null;
    const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) ? options.requestTimeoutMs : 2500;

    let phase = 'active';
    let desiredState = 'active';
    let desiredGeneration = 0;
    let attemptId = null;
    let lastAck = null;
    let timer = null;
    let generation = 0;

    function snapshot() {
      return {
        phase,
        desiredState,
        desiredGeneration,
        connectionAttemptId: attemptId,
        lastAck,
        generation,
      };
    }

    function clearTimer() {
      if (timer !== null) {
        clearTimeoutFn(timer);
        timer = null;
      }
    }

    function setPhase(next, meta = {}) {
      if (!PHASES.has(next) || next === phase) {
        phase = next;
        return snapshot();
      }
      phase = next;
      onPhaseChange?.(snapshot(), meta);
      return snapshot();
    }

    function beginDesired(desired, {
      generation: nextGeneration,
      connectionAttemptId,
    } = {}) {
      if (desired !== 'active' && desired !== 'suspended') {
        return { accepted: false, reason: 'invalid-desired', ...snapshot() };
      }
      if (!Number.isSafeInteger(nextGeneration) || nextGeneration < 1) {
        return { accepted: false, reason: 'invalid-generation', ...snapshot() };
      }
      if (nextGeneration < desiredGeneration) {
        return { accepted: false, reason: 'stale-desired', ...snapshot() };
      }
      if (nextGeneration === desiredGeneration && desired === desiredState && phase !== 'active' && phase !== 'suspended') {
        // Same in-flight desired: ignore.
        return { accepted: false, reason: 'duplicate-desired', ...snapshot() };
      }

      clearTimer();
      desiredState = desired;
      desiredGeneration = nextGeneration;
      attemptId = connectionAttemptId || attemptId;
      generation += 1;

      if (desired === 'suspended') {
        setPhase('suspending', { reason: 'desired-suspended' });
      } else {
        setPhase('resuming', { reason: 'desired-active' });
      }

      const localGeneration = generation;
      timer = setTimeoutFn(() => {
        if (localGeneration !== generation) return;
        timer = null;
        onPhaseChange?.(snapshot(), { reason: 'request-timeout' });
      }, requestTimeoutMs);

      return { accepted: true, ...snapshot() };
    }

    function applyAck(ack = {}) {
      const ackGeneration = ack.generation;
      const ackAttempt = ack.connectionAttemptId;
      if (!Number.isSafeInteger(ackGeneration)) {
        return { accepted: false, reason: 'invalid-ack', ...snapshot() };
      }
      if (ackGeneration !== desiredGeneration) {
        return { accepted: false, reason: 'stale-ack', ...snapshot() };
      }
      if (attemptId && ackAttempt && ackAttempt !== attemptId) {
        return { accepted: false, reason: 'wrong-attempt', ...snapshot() };
      }
      if (ack.applied !== true) {
        lastAck = { ...ack, accepted: false };
        return { accepted: false, reason: 'not-applied', ...snapshot() };
      }

      clearTimer();
      lastAck = {
        state: ack.state === 'active' ? 'active' : 'suspended',
        generation: ackGeneration,
        connectionAttemptId: ackAttempt || attemptId,
        applied: true,
        keyframeRequested: ack.keyframeRequested === true,
      };

      if (desiredState === 'suspended' && lastAck.state === 'suspended') {
        setPhase('suspended', { reason: 'ack-suspended' });
      } else if (desiredState === 'active' && lastAck.state === 'active') {
        // Stay in resuming until first fresh rendered frame.
        if (phase !== 'active') setPhase('resuming', { reason: 'ack-active' });
      }
      return { accepted: true, ...snapshot() };
    }

    function noteRenderedFrame({ connectionAttemptId, afterResume = false } = {}) {
      if (phase !== 'resuming') {
        return { accepted: false, reason: 'not-resuming', ...snapshot() };
      }
      if (desiredState !== 'active') {
        return { accepted: false, reason: 'desired-not-active', ...snapshot() };
      }
      if (attemptId && connectionAttemptId && connectionAttemptId !== attemptId) {
        return { accepted: false, reason: 'wrong-attempt', ...snapshot() };
      }
      if (!afterResume && lastAck?.state !== 'active') {
        return { accepted: false, reason: 'no-active-ack', ...snapshot() };
      }
      clearTimer();
      setPhase('active', { reason: 'rendered-frame' });
      return { accepted: true, ...snapshot() };
    }

    function reset(reason = 'reset') {
      clearTimer();
      phase = 'active';
      desiredState = 'active';
      desiredGeneration = 0;
      attemptId = null;
      lastAck = null;
      generation += 1;
      onPhaseChange?.(snapshot(), { reason });
      return snapshot();
    }

    function isHealthSuppressed() {
      return phase === 'suspending' || phase === 'suspended' || phase === 'resuming';
    }

    function canEnableDesktopInput() {
      return phase === 'active' && desiredState === 'active';
    }

    return {
      snapshot,
      beginDesired,
      applyAck,
      noteRenderedFrame,
      reset,
      isHealthSuppressed,
      canEnableDesktopInput,
      get phase() { return phase; },
    };
  }

  const api = {
    MediaActivityRuntime: { create: createMediaActivityRuntime },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (globalObject) {
    globalObject.MediaActivityRuntime = api.MediaActivityRuntime;
  }
}(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : undefined));
