(function registerTerminalSessionFsm(globalObject) {
  const PROCESS_STATUSES = new Set(['starting', 'running', 'exited', 'failed', 'closed']);
  const TERMINAL_PENDING_ATTACH_ERROR_CODES = new Set([
    'terminal_attach_failed',
    'terminal_session_not_found',
    'terminal_session_not_attached',
  ]);
  const TERMINAL_PENDING_CLOSE_ERROR_CODES = new Set([
    'terminal_session_not_attached',
    'terminal_session_not_found',
    'pty_cleanup_failed',
    'terminal_close_failed',
  ]);

  function normalizeProcessStatus(value, fallback = 'running') {
    return PROCESS_STATUSES.has(value) ? value : fallback;
  }

  function normalizeTerminalOperationId(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, 128);
  }

  function makeTerminalOperationId(kind = 'op') {
    const prefix = typeof kind === 'string' && kind ? kind : 'op';
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`.slice(0, 128);
  }

  function clearPendingOperation(pendingMap, sessionId, operationId, options = {}) {
    if (!pendingMap || !sessionId || !pendingMap.has(sessionId)) return false;
    const current = pendingMap.get(sessionId);
    const normalized = normalizeTerminalOperationId(operationId);
    if (normalized) {
      if (current !== normalized) return false;
      pendingMap.delete(sessionId);
      return true;
    }
    if (options.allowLegacy === false) return false;
    pendingMap.delete(sessionId);
    return true;
  }

  function createTerminalState(options = {}) {
    const softWarnCount = Number(options.softWarnCount || 4);
    const sessions = new Map();
    let activeSessionId = null;
    let warning = '';

    function normalizeSession(session = {}, fallbackIndex = sessions.size + 1) {
      const previous = sessions.get(session.sessionId) || {};
      return {
        ...previous,
        ...session,
        sessionId: session.sessionId,
        title: session.title || previous.title || `Terminal ${fallbackIndex}`,
        status: session.status || previous.status || 'running',
        processStatus: normalizeProcessStatus(
          session.processStatus,
          normalizeProcessStatus(previous.processStatus, 'running'),
        ),
        warning: session.warning || previous.warning || '',
        observerCount: Number(session.observerCount ?? previous.observerCount ?? 0),
        activePresenterClientId: session.activePresenterClientId ?? previous.activePresenterClientId ?? null,
      };
    }

    function upsertSession(session, options = {}) {
      const normalized = normalizeSession(session);
      sessions.set(normalized.sessionId, normalized);
      if (options.activate || !activeSessionId) {
        activeSessionId = normalized.sessionId;
      }
      if (sessions.size > softWarnCount) {
        warning = '终端会话较多，可能影响性能';
      }
      return normalized;
    }

    function replaceSessions(nextSessions = []) {
      const seen = new Set();
      nextSessions.forEach((session, index) => {
        const normalized = normalizeSession(session, index + 1);
        sessions.set(normalized.sessionId, normalized);
        seen.add(normalized.sessionId);
      });
      Array.from(sessions.keys()).forEach((sessionId) => {
        if (!seen.has(sessionId)) {
          sessions.delete(sessionId);
        }
      });
      if (activeSessionId && !sessions.has(activeSessionId)) {
        activeSessionId = sessions.size ? Array.from(sessions.keys()).at(0) : null;
      }
      if (!activeSessionId && sessions.size) {
        activeSessionId = Array.from(sessions.keys()).at(0);
      }
      warning = sessions.size > softWarnCount ? '终端会话较多，可能影响性能' : '';
    }

    function closeTab(sessionId) {
      sessions.delete(sessionId);
      if (activeSessionId === sessionId) {
        activeSessionId = sessions.size ? Array.from(sessions.keys()).at(-1) : null;
      }
      if (sessions.size <= softWarnCount) {
        warning = '';
      }
    }

    function setActive(sessionId) {
      if (sessions.has(sessionId)) {
        activeSessionId = sessionId;
      }
    }

    function updateSession(sessionId, patch = {}) {
      const session = sessions.get(sessionId);
      if (session) {
        Object.assign(session, patch);
      }
    }

    function updateStatus(sessionId, status) {
      updateSession(sessionId, { status });
    }

    function setWarning(message) {
      warning = String(message || '');
    }

    return {
      upsertSession,
      replaceSessions,
      closeTab,
      setActive,
      updateSession,
      updateStatus,
      setWarning,
      activeSessionId: () => activeSessionId,
      sessionCount: () => sessions.size,
      getWarning: () => warning,
      getSessions: () => Array.from(sessions.values()),
      getSession: (sessionId) => sessions.get(sessionId) || null,
    };
  }

  function createTerminalSessionFsm(options = {}) {
    const state = createTerminalState(options);
    const attachedSessionIds = new Set();
    const pendingAttachSessionIds = new Map();
    const pendingCloseSessionIds = new Map();

    function beginAttach(sessionId) {
      if (!sessionId) return null;
      const operationId = makeTerminalOperationId('attach');
      pendingAttachSessionIds.set(sessionId, operationId);
      return operationId;
    }

    function beginClose(sessionId) {
      if (!sessionId) return null;
      const operationId = makeTerminalOperationId('close');
      pendingCloseSessionIds.set(sessionId, operationId);
      return operationId;
    }

    function releasePendingForTerminalError(payload = {}) {
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
      if (!sessionId) return;
      const code = payload.code;
      const action = typeof payload.action === 'string' ? payload.action : '';
      if (action && action !== 'attach' && action !== 'close') return;

      const clearAttach = action === 'attach'
        || (!action && TERMINAL_PENDING_ATTACH_ERROR_CODES.has(code));
      const clearClose = action === 'close'
        || (!action && TERMINAL_PENDING_CLOSE_ERROR_CODES.has(code));

      if (clearAttach) {
        clearPendingOperation(pendingAttachSessionIds, sessionId, payload.operationId);
      }
      if (clearClose) {
        clearPendingOperation(pendingCloseSessionIds, sessionId, payload.operationId);
      }
    }

    function completeAttach(session = {}) {
      const action = typeof session.action === 'string' ? session.action : '';
      if (!action || action === 'attach') {
        clearPendingOperation(pendingAttachSessionIds, session.sessionId, session.operationId);
      }
      if (session.sessionId) {
        attachedSessionIds.add(session.sessionId);
      }
    }

    function completeClose(session = {}) {
      const action = typeof session.action === 'string' ? session.action : '';
      if (!action || action === 'close') {
        clearPendingOperation(pendingCloseSessionIds, session.sessionId, session.operationId);
      }
      if (session.sessionId) {
        pendingAttachSessionIds.delete(session.sessionId);
        attachedSessionIds.delete(session.sessionId);
      }
    }

    return {
      upsertSession: state.upsertSession,
      replaceSessions: state.replaceSessions,
      closeTab: state.closeTab,
      setActive: state.setActive,
      updateSession: state.updateSession,
      updateStatus: state.updateStatus,
      setWarning: state.setWarning,
      activeSessionId: state.activeSessionId,
      sessionCount: state.sessionCount,
      getWarning: state.getWarning,
      getSessions: state.getSessions,
      getSession: state.getSession,
      attachedSessionIds,
      pendingAttachSessionIds,
      pendingCloseSessionIds,
      beginAttach,
      beginClose,
      releasePendingForTerminalError,
      completeAttach,
      completeClose,
      isAttached: (sessionId) => attachedSessionIds.has(sessionId),
      hasPendingAttach: (sessionId) => pendingAttachSessionIds.has(sessionId),
      hasPendingClose: (sessionId) => pendingCloseSessionIds.has(sessionId),
    };
  }

  const api = {
    PROCESS_STATUSES,
    TERMINAL_PENDING_ATTACH_ERROR_CODES,
    TERMINAL_PENDING_CLOSE_ERROR_CODES,
    normalizeProcessStatus,
    normalizeTerminalOperationId,
    makeTerminalOperationId,
    clearPendingOperation,
    createTerminalState,
    createTerminalSessionFsm,
  };

  globalObject.TerminalSessionFsm = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
