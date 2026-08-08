(function registerTerminalInputGate(globalObject) {
  function createTerminalInputGate(deps = {}) {
    function decide(sessionId) {
      if (!sessionId) return { allowed: false, reason: 'session_missing' };
      if (!deps.isConnected()) return { allowed: false, reason: 'socket_disconnected' };
      if (!deps.isAttached(sessionId)) return { allowed: false, reason: 'session_not_attached' };
      if (deps.processStatus(sessionId) !== 'running') return { allowed: false, reason: 'process_not_running' };
      if (!deps.transportCanSend(sessionId)) return { allowed: false, reason: 'transport_not_ready' };
      return { allowed: true, reason: null };
    }

    return { decide };
  }

  const api = { createTerminalInputGate };

  globalObject.TerminalInputGate = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
