(function registerTerminalTurnTransport(globalObject) {
  function createTurnTransportState(initial = {}) {
    const state = {
      preferred: initial.preferred === 'webrtc-turn' ? 'webrtc-turn' : (initial.preferred || 'socketio'),
      ready: Boolean(initial.ready),
      dcOpen: Boolean(initial.dcOpen),
      outputReady: Boolean(initial.outputReady),
      activeSessionId: initial.activeSessionId || null,
      boundSessionId: initial.boundSessionId || null,
      pendingBindSessionId: initial.pendingBindSessionId || null,
    };

    function canSendInput() {
      // Adapter readiness only — does not read preferred transport.
      return Boolean(state.ready && state.dcOpen);
    }

    function shouldSuppressSocketOutput(sessionId) {
      if (state.preferred !== 'webrtc-turn') return false;
      if (!state.dcOpen || !state.outputReady) return false;
      if (!sessionId || !state.boundSessionId || !state.activeSessionId) return false;
      return state.boundSessionId === sessionId && sessionId === state.activeSessionId;
    }

    function buildBindFrame(sessionId, options = {}) {
      const frame = {
        t: 'bind',
        sid: sessionId || '',
        preferDcOutput: true,
      };
      if (typeof options.clientId === 'string' && options.clientId) {
        frame.clientId = options.clientId;
      }
      return frame;
    }

    function beginRebind(sessionId, options = {}) {
      // Clear suppression window before bind so Socket.IO keeps flowing until output_bound.
      state.boundSessionId = null;
      state.outputReady = false;
      state.pendingBindSessionId = sessionId || null;
      return buildBindFrame(sessionId, options);
    }

    function markOutputBound(sessionId) {
      const sid = sessionId || state.pendingBindSessionId || null;
      state.boundSessionId = sid;
      state.outputReady = Boolean(sid);
      state.pendingBindSessionId = null;
    }

    function markDcOpen(open) {
      state.dcOpen = Boolean(open);
      if (!state.dcOpen) {
        state.ready = false;
        state.outputReady = false;
        state.boundSessionId = null;
        state.pendingBindSessionId = null;
      }
    }

    return {
      get preferred() { return state.preferred; },
      set preferred(value) {
        state.preferred = value === 'webrtc-turn' ? 'webrtc-turn' : 'socketio';
      },
      get ready() { return state.ready; },
      set ready(value) { state.ready = Boolean(value); },
      get dcOpen() { return state.dcOpen; },
      set dcOpen(value) { state.dcOpen = Boolean(value); },
      get outputReady() { return state.outputReady; },
      set outputReady(value) { state.outputReady = Boolean(value); },
      get activeSessionId() { return state.activeSessionId; },
      set activeSessionId(value) { state.activeSessionId = value || null; },
      get boundSessionId() { return state.boundSessionId; },
      set boundSessionId(value) { state.boundSessionId = value || null; },
      get pendingBindSessionId() { return state.pendingBindSessionId; },
      set pendingBindSessionId(value) { state.pendingBindSessionId = value || null; },
      canSendInput,
      shouldSuppressSocketOutput,
      buildBindFrame,
      beginRebind,
      markOutputBound,
      markDcOpen,
    };
  }

  const api = {
    createTurnTransportState,
    createTerminalTurnTransport: createTurnTransportState,
  };

  globalObject.TerminalTurnTransport = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
