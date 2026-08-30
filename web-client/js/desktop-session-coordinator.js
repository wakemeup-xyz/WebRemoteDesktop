'use strict';

/* Small, dependency-free state seams used by the WebRTC facade. */
(function registerDesktopSessionCoordinator(globalObject) {
  const CONNECTION_STATES = new Set(['idle', 'signaling', 'connecting', 'connected', 'disconnected', 'failed']);
  const UI_PHASES = new Set(['signaling', 'media-pending', 'connected', 'media-stalled', 'disconnected']);

  function clone(value) {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(clone);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }

  function createConnectionSession(initial = {}) {
    let state = {
      status: 'idle',
      attemptId: null,
      attemptSequence: 0,
      reason: null,
      ...clone(initial),
    };
    function snapshot() { return Object.freeze(clone(state)); }
    function transition(event = {}) {
      const type = String(event.type || event.status || '').toLowerCase();
      const nextStatus = type === 'start' || type === 'signaling' ? 'signaling'
        : type === 'offer' || type === 'connecting' ? 'connecting'
          : type === 'connected' ? 'connected'
            : type === 'failed' ? 'failed'
              : type === 'disconnect' || type === 'disconnected' ? 'disconnected' : null;
      if (nextStatus) state.status = nextStatus;
      if (event.attemptId !== undefined) state.attemptId = event.attemptId || null;
      if (Number.isSafeInteger(event.attemptSequence)) state.attemptSequence = event.attemptSequence;
      if (event.reason !== undefined) state.reason = event.reason || null;
      return snapshot();
    }
    return { snapshot, transition };
  }

  function createMediaPaintGate(initial = {}) {
    let state = {
      phase: 'media-pending',
      attemptId: null,
      decodedFrames: 0,
      paintedFrames: 0,
      hasPaintedFrame: false,
      failClosed: true,
      reason: 'awaiting-first-frame',
      ...clone(initial),
    };
    function snapshot() { return Object.freeze(clone(state)); }
    function begin(attemptId) {
      state = { ...state, attemptId: attemptId || null, decodedFrames: 0, paintedFrames: 0, hasPaintedFrame: false, phase: 'media-pending', failClosed: true, reason: 'awaiting-first-frame' };
      return snapshot();
    }
    function noteDecoded(count = 1) {
      const increment = Number.isFinite(count) ? Math.max(0, Number(count)) : 0;
      state.decodedFrames += increment;
      return snapshot();
    }
    function notePainted(meta = {}) {
      if (meta.attemptId && state.attemptId && meta.attemptId !== state.attemptId) return snapshot();
      state.paintedFrames += 1;
      state.hasPaintedFrame = true;
      state.phase = 'connected';
      state.failClosed = false;
      state.reason = meta.reason || 'first-frame';
      return snapshot();
    }
    function markStalled(reason = 'zero-fps') {
      state.phase = 'media-stalled';
      state.failClosed = true;
      state.reason = reason;
      return snapshot();
    }
    function reset(reason = 'reset') {
      state.phase = 'media-pending';
      state.failClosed = true;
      state.reason = reason;
      return snapshot();
    }
    return { snapshot, begin, noteDecoded, notePainted, markStalled, reset };
  }

  function createControlLeaseView(initial = {}) {
    let state = { state: 'FREE', controller: false, lease: null, hostOnline: false, ...clone(initial) };
    function snapshot() { return Object.freeze(clone(state)); }
    function apply(next = {}) {
      const lease = next.controller === false ? null : next.lease === undefined ? state.lease : next.lease;
      state = { ...state, ...clone(next), lease };
      return snapshot();
    }
    function clear(reason = 'cleared') {
      state = { ...state, state: 'FREE', controller: false, lease: null, reason };
      return snapshot();
    }
    return { snapshot, apply, clear };
  }

  function createDesktopSessionCoordinator(options = {}) {
    const connection = options.connection || createConnectionSession();
    const media = options.media || createMediaPaintGate();
    const lease = options.lease || createControlLeaseView();
    let uiPhase = options.uiPhase || 'signaling';
    const subscribers = new Set();
    function snapshot() {
      return Object.freeze({ connection: connection.snapshot(), media: media.snapshot(), lease: lease.snapshot(), uiPhase });
    }
    function notify() { const current = snapshot(); subscribers.forEach((fn) => fn(current)); return current; }
    function setUiPhase(phase) {
      if (UI_PHASES.has(phase)) uiPhase = phase;
      return notify();
    }
    return {
      connection,
      media,
      lease,
      snapshot,
      subscribe(fn) { if (typeof fn !== 'function') return () => {}; subscribers.add(fn); return () => subscribers.delete(fn); },
      transitionConnection(event) { connection.transition(event); return notify(); },
      beginMedia(attemptId) { media.begin(attemptId); return notify(); },
      noteMediaDecoded(count) { media.noteDecoded(count); return notify(); },
      noteMediaPainted(meta) { media.notePainted(meta); uiPhase = 'connected'; return notify(); },
      markMediaStalled(reason) { media.markStalled(reason); uiPhase = 'media-stalled'; return notify(); },
      applyControlLease(next) { lease.apply(next); return notify(); },
      clearControlLease(reason) { lease.clear(reason); return notify(); },
      setUiPhase,
    };
  }

  const api = { ConnectionSession: createConnectionSession, MediaPaintGate: createMediaPaintGate, ControlLeaseView: createControlLeaseView, DesktopSessionCoordinator: createDesktopSessionCoordinator };
  Object.assign(globalObject, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
