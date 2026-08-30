(function installDesktopSessionState(global) {
  'use strict';

  const PHASES = new Set(['idle', 'signaling', 'media-pending', 'connected', 'media-stalled', 'disconnected']);
  const MEDIA = new Set(['none', 'pending', 'live', 'stalled']);
  const CONTROL = new Set(['free', 'granting', 'active', 'revoking', 'blocked']);
  const SOCKET = new Set(['offline', 'connecting', 'online']);

  function now(clock) {
    const value = Number(typeof clock === 'function' ? clock() : Date.now());
    return Number.isFinite(value) ? value : Date.now();
  }

  function normalizeAttempt(value) {
    if (value === null || value === undefined || value === '') return null;
    return String(value);
  }

  function createDesktopSessionState(options = {}) {
    const clock = options.clock || Date.now;
    let sequence = 0;
    let currentAttemptId = null;
    let media = 'none';
    let phase = 'idle';
    let control = 'free';
    let socket = 'offline';
    let lastTransitionAt = now(clock);

    function update(changes = {}) {
      let changed = false;
      for (const [key, value] of Object.entries(changes)) {
        if (key === 'phase' && PHASES.has(value) && value !== phase) { phase = value; changed = true; }
        if (key === 'media' && MEDIA.has(value) && value !== media) { media = value; changed = true; }
        if (key === 'control' && CONTROL.has(value) && value !== control) { control = value; changed = true; }
        if (key === 'socket' && SOCKET.has(value) && value !== socket) { socket = value; changed = true; }
      }
      if (changed) lastTransitionAt = now(clock);
    }

    function accepts(event = {}) {
      const eventAttempt = normalizeAttempt(event.attemptId ?? event.connectionAttemptId);
      return currentAttemptId === null || eventAttempt === null || eventAttempt === currentAttemptId;
    }

    function recomputePhase() {
      if (media === 'stalled') phase = 'media-stalled';
      else if (media === 'live') phase = 'connected';
      else if (phase === 'connected' || phase === 'media-stalled') phase = socket === 'offline' ? 'disconnected' : 'media-pending';
      else if (phase === 'signaling' && socket === 'online' && media === 'none') phase = 'signaling';
      if (media === 'pending' && phase !== 'disconnected') phase = 'media-pending';
    }

    function beginAttempt(attemptId = null, meta = {}) {
      if (attemptId && typeof attemptId === 'object') {
        meta = attemptId;
        attemptId = meta.attemptId ?? meta.connectionAttemptId ?? null;
      }
      sequence += 1;
      const supplied = normalizeAttempt(attemptId);
      currentAttemptId = supplied || `attempt-${sequence}`;
      media = 'none';
      phase = 'signaling';
      control = 'free';
      lastTransitionAt = now(clock);
      if (meta.socket && SOCKET.has(meta.socket)) socket = meta.socket;
      return snapshot();
    }

    function applyConnection(event = {}) {
      if (!accepts(event)) return snapshot();
      const state = String(event.state || event.connectionState || event.phase || '').toLowerCase();
      const socketState = String(event.socket || event.socketState || '').toLowerCase();
      if (SOCKET.has(socketState)) update({ socket: socketState });
      if (state === 'online' || state === 'connect' || state === 'connected-socket') update({ socket: 'online' });
      else if (state === 'connecting' || state === 'reconnecting') update({ socket: 'connecting' });
      else if (state === 'offline' || state === 'disconnect' || state === 'disconnected-socket') update({ socket: 'offline' });
      if (state === 'connected' || state === 'completed' || state === 'pc-connected') {
        update({ phase: media === 'live' ? 'connected' : 'media-pending', media: media === 'none' ? 'pending' : media });
      } else if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        update({ phase: 'disconnected', media: 'none' });
      } else if (state === 'signaling' || state === 'checking' || state === 'connecting') {
        update({ phase: 'signaling' });
      }
      recomputePhase();
      return snapshot();
    }

    function applyMedia(event = {}) {
      if (!accepts(event)) return snapshot();
      const kind = String(event.event || event.state || event.media || event.phase || '').toLowerCase();
      const fresh = event.fresh === true || event.freshFrame === true || kind === 'fresh-frame' || kind === 'frame' || kind === 'live';
      if (kind === 'stalled' || kind === 'media-stalled' || event.stalled === true) update({ media: 'stalled', phase: 'media-stalled' });
      else if (fresh) update({ media: 'live', phase: 'connected' });
      else if (kind === 'pending' || kind === 'media-pending' || kind === 'resuming') update({ media: 'pending', phase: 'media-pending' });
      else if (kind === 'none' || kind === 'disconnected') update({ media: 'none', phase: 'disconnected' });
      recomputePhase();
      return snapshot();
    }

    function applyControl(event = {}) {
      if (!accepts(event)) return snapshot();
      const raw = String(event.state || event.control || event.phase || '').toLowerCase();
      const value = raw === 'free' || raw === 'readonly' ? 'free'
        : raw === 'granting' ? 'granting'
          : raw === 'active' || raw === 'controlled' ? 'active'
            : raw === 'revoking' ? 'revoking'
              : raw === 'blocked' || event.blocked === true || event.resetBlocked === true ? 'blocked' : null;
      if (value) update({ control: value });
      return snapshot();
    }

    function snapshot() {
      return Object.freeze({
        attemptId: currentAttemptId,
        phase,
        media,
        control,
        socket,
        canInput: control === 'active' && media === 'live' && socket === 'online',
        lastTransitionAt,
      });
    }

    return Object.freeze({ beginAttempt, applyConnection, applyMedia, applyControl, snapshot });
  }

  global.createDesktopSessionState = createDesktopSessionState;
  global.DesktopSessionState = global.DesktopSessionState || createDesktopSessionState();
  if (typeof module !== 'undefined' && module.exports) module.exports = { createDesktopSessionState };
})(typeof globalThis !== 'undefined' ? globalThis : this);
