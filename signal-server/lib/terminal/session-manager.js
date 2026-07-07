const crypto = require('node:crypto');
const path = require('node:path');
const { createTerminalAudit } = require('./audit');
const { loadTerminalConfig } = require('./config');

function defaultPtyFactory() {
  const pty = require('node-pty');
  return pty.spawn.apply(pty, arguments);
}

function buildTerminalEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  const home = String(env.HOME || '').trim();
  const existingPath = String(env.PATH || '').trim();
  const preferred = [
    path.dirname(process.execPath),
    home ? path.join(home, '.bun', 'bin') : '',
    home ? path.join(home, '.homebrew', 'bin') : '',
    home ? path.join(home, '.homebrew', 'sbin') : '',
    home ? path.join(home, '.local', 'bin') : '',
  ].filter(Boolean);

  const merged = [];
  for (const entry of preferred.concat(existingPath.split(':'))) {
    const normalized = String(entry || '').trim();
    if (!normalized || merged.includes(normalized)) continue;
    merged.push(normalized);
  }

  env.PATH = merged.join(':');
  return env;
}

function createReplayBuffer(limitBytes = 262144) {
  let totalBytes = 0;
  const entries = [];
  let seq = 0;

  return {
    push(data) {
      const normalized = String(data || '');
      const size = Buffer.byteLength(normalized, 'utf8');
      const entry = { seq: ++seq, data: normalized };
      entries.push(entry);
      totalBytes += size;
      while (totalBytes > limitBytes && entries.length > 1) {
        const removed = entries.shift();
        totalBytes -= Buffer.byteLength(String(removed.data || ''), 'utf8');
      }
      return entry;
    },
    snapshot() {
      return entries.slice();
    },
    lastSeq() {
      return seq;
    },
  };
}

function createTerminalSessionManager(options = {}) {
  const rawConfig = options.config || loadTerminalConfig();
  const config = {
    enabled: Boolean(
      rawConfig.enabled ??
      rawConfig.enableTerminal ??
      rawConfig.terminalEnabled ??
      false
    ),
    adminPassword: String(rawConfig.adminPassword ?? rawConfig.terminalAdminPassword ?? ''),
    shell: String(rawConfig.shell ?? rawConfig.terminalShell ?? '/bin/zsh'),
    cwd: String(rawConfig.cwd ?? rawConfig.terminalCwd ?? ''),
    softWarnSessionCount: Number(rawConfig.softWarnSessionCount ?? rawConfig.terminalSoftWarnSessionCount ?? 4),
    idleTimeoutMs: Number(rawConfig.idleTimeoutMs ?? rawConfig.terminalIdleTimeoutMs ?? 0),
    startupTimeoutMs: Number(rawConfig.startupTimeoutMs ?? rawConfig.terminalStartupTimeoutMs ?? 10000),
    auditLog: rawConfig.auditLog ?? rawConfig.terminalAuditLog ?? '',
    recordIo: Boolean(rawConfig.recordIo ?? rawConfig.terminalRecordIo ?? false),
    replayBufferBytes: Number(rawConfig.replayBufferBytes ?? rawConfig.terminalReplayBufferBytes ?? 262144),
  };
  const now = options.now || (() => new Date());
  const logger = options.logger || console;
  const audit = options.audit || createTerminalAudit(logger);
  const ptyFactory = options.ptyFactory || defaultPtyFactory;
  const sessions = new Map();
  const pool = {
    poolId: 'default',
    title: 'Shared Terminal Pool',
    defaultSessionId: null,
  };

  function timestamp() {
    return now().toISOString();
  }

  function snapshotSession(session) {
    return {
      poolId: pool.poolId,
      sessionId: session.sessionId,
      title: session.title,
      cwd: session.cwd,
      shell: session.shell,
      cols: session.cols,
      rows: session.rows,
      status: session.status,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      detachedReason: session.detachedReason || null,
      observerCount: session.observers.size,
      activePresenterClientId: session.activePresenterClientId || null,
      creatorClientId: session.creatorClientId || null,
      lastReplaySeq: session.replayBuffer.lastSeq(),
    };
  }

  function getPoolSnapshot() {
    return {
      poolId: pool.poolId,
      title: pool.title,
      defaultSessionId: pool.defaultSessionId,
      sessions: Array.from(sessions.values()).map(snapshotSession),
    };
  }

  function maybeWarnSessionCount() {
    if (sessions.size > config.softWarnSessionCount) {
      audit.warn('terminal_session_count_above_soft_threshold', {
        warning: 'session_count_above_soft_threshold',
        sessionCount: sessions.size,
        softThreshold: config.softWarnSessionCount,
      });
    }
  }

  function getSession(sessionId) {
    return sessions.get(sessionId) || null;
  }

  function updatePresence(session, reason = null) {
    session.status = session.observers.size > 0 ? 'attached' : 'detached';
    session.detachedReason = session.observers.size > 0 ? null : reason;
    session.lastActiveAt = timestamp();
  }

  function ensureSession(sessionId) {
    const session = getSession(sessionId);
    if (!session) {
      throw Object.assign(new Error('terminal_session_not_found'), { code: 'terminal_session_not_found' });
    }
    return session;
  }

  function addObserver(session, input = {}) {
    const clientId = String(input.clientId || '').trim();
    const socketId = String(input.socketId || '').trim();
    const observerId = String(input.observerId || socketId || clientId).trim();
    if (!clientId) {
      throw Object.assign(new Error('terminal_client_id_required'), { code: 'terminal_client_id_required' });
    }
    if (!observerId) {
      throw Object.assign(new Error('terminal_observer_id_required'), { code: 'terminal_observer_id_required' });
    }
    const existing = session.observers.get(observerId) || {};
    session.observers.set(observerId, {
      observerId,
      clientId,
      socketId,
      onData: typeof input.onData === 'function' ? input.onData : existing.onData || null,
      onExit: typeof input.onExit === 'function' ? input.onExit : existing.onExit || null,
      attachedAt: existing.attachedAt || timestamp(),
      lastAttachedAt: timestamp(),
    });
    if (!session.activePresenterClientId) {
      session.activePresenterClientId = clientId;
    }
    updatePresence(session);
  }

  function emitOutput(session, data) {
    const replayEntry = session.replayBuffer.push(data);
    for (const observer of session.observers.values()) {
      observer.onData?.(replayEntry.data);
    }
  }

  function emitExit(session, payload) {
    for (const observer of session.observers.values()) {
      observer.onExit?.(payload);
    }
  }

  function wirePty(session, pty) {
    if (typeof pty.onData === 'function') {
      pty.onData((data) => {
        session.lastActiveAt = timestamp();
        audit.info('terminal_output', {
          sessionId: session.sessionId,
          ioRecording: config.recordIo,
        });
        emitOutput(session, data);
      });
    }
    if (typeof pty.onExit === 'function') {
      pty.onExit(({ exitCode, signal }) => {
        session.status = 'exited';
        session.exitCode = exitCode;
        session.signal = signal;
        session.lastActiveAt = timestamp();
        emitExit(session, { exitCode, signal });
      });
    }
  }

  function createSession(input = {}) {
    if (!config.enabled) {
      throw Object.assign(new Error('Terminal disabled'), { code: 'terminal_disabled' });
    }
    if (!config.adminPassword) {
      throw Object.assign(new Error('Terminal admin password not configured'), {
        code: 'terminal_admin_password_missing',
      });
    }
    const sessionId = 'term_' + crypto.randomBytes(8).toString('hex');
    const cols = Number(input.cols || 80);
    const rows = Number(input.rows || 24);
    const title = String(input.title || 'Terminal ' + (sessions.size + 1));
    const pty = ptyFactory(config.shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: config.cwd || undefined,
      env: buildTerminalEnv(process.env),
    });
    const session = {
      sessionId,
      title,
      cwd: config.cwd || '',
      shell: config.shell,
      cols,
      rows,
      status: 'detached',
      createdAt: timestamp(),
      lastActiveAt: timestamp(),
      detachedReason: null,
      pty,
      observers: new Map(),
      replayBuffer: createReplayBuffer(config.replayBufferBytes),
      activePresenterClientId: null,
      creatorClientId: String(input.clientId || '').trim() || null,
    };

    wirePty(session, pty);
    addObserver(session, input);
    sessions.set(sessionId, session);
    if (!pool.defaultSessionId) {
      pool.defaultSessionId = sessionId;
    }
    maybeWarnSessionCount();
    audit.info('terminal_session_created', {
      sessionId,
      poolId: pool.poolId,
      shell: session.shell,
      cwd: session.cwd,
      cols,
      rows,
      observerCount: session.observers.size,
    });
    return snapshotSession(session);
  }

  function attachSession(sessionId, input = {}) {
    const session = ensureSession(sessionId);
    addObserver(session, input);
    if (input.cols && input.rows && session.activePresenterClientId === input.clientId) {
      resizeSession(sessionId, {
        clientId: input.clientId,
        cols: input.cols,
        rows: input.rows,
      });
    }
    return {
      ...snapshotSession(session),
      replay: session.replayBuffer.snapshot(),
    };
  }

  function detachObserver(sessionId, input = {}) {
    const session = ensureSession(sessionId);
    const observerId = String(input.observerId || '').trim();
    const socketId = String(input.socketId || '').trim();
    const clientId = String(input.clientId || '').trim();
    let removedClientId = '';

    if (observerId && session.observers.has(observerId)) {
      removedClientId = session.observers.get(observerId)?.clientId || '';
      session.observers.delete(observerId);
    } else if (socketId) {
      for (const [key, observer] of session.observers.entries()) {
        if (observer.socketId === socketId) {
          removedClientId = observer.clientId || '';
          session.observers.delete(key);
          break;
        }
      }
    } else if (clientId) {
      for (const [key, observer] of session.observers.entries()) {
        if (observer.clientId === clientId) {
          removedClientId = observer.clientId || '';
          session.observers.delete(key);
          break;
        }
      }
    }

    if (
      removedClientId &&
      session.activePresenterClientId === removedClientId &&
      !Array.from(session.observers.values()).some((observer) => observer.clientId === removedClientId)
    ) {
      session.activePresenterClientId = session.observers.values().next().value?.clientId || null;
    }
    updatePresence(session, input.reason || 'detached');
    return snapshotSession(session);
  }

  function detachSession(sessionId, reason = 'detached') {
    const session = ensureSession(sessionId);
    session.observers.clear();
    session.activePresenterClientId = null;
    updatePresence(session, reason);
    return snapshotSession(session);
  }

  function setActivePresenter(sessionId, input = {}) {
    const session = ensureSession(sessionId);
    const clientId = String(input.clientId || '').trim();
    const socketId = String(input.socketId || '').trim();
    if (!clientId || !isObserverAttached(sessionId, { clientId, socketId })) {
      throw Object.assign(new Error('terminal_session_not_found'), { code: 'terminal_session_not_found' });
    }
    session.activePresenterClientId = clientId;
    session.lastActiveAt = timestamp();
    return snapshotSession(session);
  }

  function isObserverAttached(sessionId, input = {}) {
    const session = ensureSession(sessionId);
    const clientId = String(input.clientId || '').trim();
    const socketId = String(input.socketId || '').trim();
    if (!clientId && !socketId) {
      return false;
    }
    return Array.from(session.observers.values()).some((observer) => {
      if (socketId) {
        return observer.socketId === socketId;
      }
      return observer.clientId === clientId;
    });
  }

  function writeInput(sessionId, input = {}) {
    const session = ensureSession(sessionId);
    if (!isObserverAttached(sessionId, input)) {
      throw Object.assign(new Error('terminal_session_not_found'), { code: 'terminal_session_not_found' });
    }
    const data = String(input.data || '');
    if (session.pty && typeof session.pty.write === 'function') {
      session.pty.write(data);
    }
    session.lastActiveAt = timestamp();
    return snapshotSession(session);
  }

  function resizeSession(sessionId, input = {}) {
    const session = ensureSession(sessionId);
    const clientId = String(input.clientId || '').trim();
    const socketId = String(input.socketId || '').trim();
    const cols = Number(input.cols || 0);
    const rows = Number(input.rows || 0);
    if (
      !clientId ||
      !isObserverAttached(sessionId, { clientId, socketId }) ||
      session.activePresenterClientId !== clientId ||
      !cols ||
      !rows
    ) {
      return snapshotSession(session);
    }
    if (session.pty && typeof session.pty.resize === 'function') {
      session.pty.resize(cols, rows);
    }
    session.cols = cols;
    session.rows = rows;
    session.lastActiveAt = timestamp();
    return snapshotSession(session);
  }

  function closeSession(sessionId, input = {}) {
    const session = ensureSession(sessionId);
    if (session.pty && typeof session.pty.kill === 'function') {
      session.pty.kill('SIGHUP');
    }
    session.status = 'closed';
    session.detachedReason = input.reason || 'closed';
    session.lastActiveAt = timestamp();
    session.observers.clear();
    session.activePresenterClientId = null;
    sessions.delete(sessionId);
    if (pool.defaultSessionId === sessionId) {
      pool.defaultSessionId = sessions.keys().next().value || null;
    }
    audit.info('terminal_session_closed', {
      sessionId,
      reason: session.detachedReason,
      poolId: pool.poolId,
    });
    return snapshotSession(session);
  }

  function listSessions() {
    return Array.from(sessions.values()).map(snapshotSession);
  }

  function getPresence(sessionId) {
    const session = ensureSession(sessionId);
    return {
      poolId: pool.poolId,
      sessionId: session.sessionId,
      observerCount: session.observers.size,
      activePresenterClientId: session.activePresenterClientId || null,
      observers: Array.from(session.observers.values()).map((observer) => ({
        observerId: observer.observerId,
        clientId: observer.clientId,
        socketId: observer.socketId || null,
        attachedAt: observer.attachedAt,
        lastAttachedAt: observer.lastAttachedAt,
      })),
    };
  }

  function getSnapshot() {
    return {
      sessions: Array.from(sessions.values()).map(snapshotSession),
    };
  }

  function handleSocketDisconnect(input = {}, maybeSocketId = '') {
    const reason = typeof input === 'string'
      ? 'socket-disconnect'
      : (input.reason || 'socket-disconnect');
    const clientId = typeof input === 'string'
      ? String(input || '').trim()
      : String(input.clientId || '').trim();
    const socketId = typeof input === 'string'
      ? String(maybeSocketId || '').trim()
      : String(input.socketId || maybeSocketId || '').trim();
    const affectedSessionIds = [];
    if (!clientId) {
      return {
        pool: getPoolSnapshot(),
        affectedSessionIds,
      };
    }
    for (const session of sessions.values()) {
      const hasMatch = Array.from(session.observers.values()).some((observer) => (
        socketId ? observer.socketId === socketId : observer.clientId === clientId
      ));
      if (hasMatch) {
        detachObserver(session.sessionId, {
          clientId,
          socketId,
          reason,
        });
        affectedSessionIds.push(session.sessionId);
      }
    }
    return {
      pool: getPoolSnapshot(),
      affectedSessionIds,
    };
  }

  return {
    createSession,
    attachSession,
    detachObserver,
    detachSession,
    closeSession,
    isObserverAttached,
    writeInput,
    getPresence,
    getPoolSnapshot,
    getSnapshot,
    listSessions,
    setActivePresenter,
    resizeSession,
    handleSocketDisconnect,
    _getSession: getSession,
  };
}

module.exports = {
  buildTerminalEnv,
  createReplayBuffer,
  createTerminalSessionManager,
};
