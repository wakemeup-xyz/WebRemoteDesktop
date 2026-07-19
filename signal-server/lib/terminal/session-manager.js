const crypto = require('node:crypto');
const { createTerminalAudit } = require('./audit');
const { loadTerminalConfig } = require('./config');
const { buildTerminalEnvironment, getTerminalShellArgs } = require('./environment');
const {
  PROCESS_STATUS,
  assertProcessWritable,
  makeTerminalError,
  transitionProcessState,
} = require('./lifecycle');

const MAX_PTY_CLEANUP_ATTEMPTS = 2;
const MAX_AUDIT_KILL_ATTEMPTS = 9999;

function defaultPtyFactory() {
  const pty = require('node-pty');
  return pty.spawn.apply(pty, arguments);
}

function buildTerminalEnv(baseEnv = process.env) {
  return buildTerminalEnvironment(baseEnv);
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
  const recordIoMetadata = Boolean(
    rawConfig.recordIoMetadata ??
    rawConfig.recordIo ??
    rawConfig.terminalRecordIoMetadata ??
    rawConfig.terminalRecordIo ??
    false
  );
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
    maxSessions: Math.max(1, Number(rawConfig.maxSessions ?? rawConfig.terminalMaxSessions ?? 8)),
    idleTimeoutMs: Number(rawConfig.idleTimeoutMs ?? rawConfig.terminalIdleTimeoutMs ?? 0),
    startupTimeoutMs: Number(rawConfig.startupTimeoutMs ?? rawConfig.terminalStartupTimeoutMs ?? 10000),
    auditLog: rawConfig.auditLog ?? rawConfig.terminalAuditLog ?? '',
    pathEntries: rawConfig.pathEntries ?? rawConfig.terminalPathEntries ?? [],
    recordIoMetadata,
    recordIo: recordIoMetadata,
    replayBufferBytes: Number(rawConfig.replayBufferBytes ?? rawConfig.terminalReplayBufferBytes ?? 262144),
  };
  const now = options.now || (() => new Date());
  const logger = options.logger || console;
  const audit = options.audit || createTerminalAudit(logger);
  const ptyFactory = options.ptyFactory || defaultPtyFactory;
  const scheduleTimeout = options.setTimeout || setTimeout;
  const cancelTimeout = options.clearTimeout || clearTimeout;
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
      processStatus: session.processStatus,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      detachedReason: session.detachedReason || null,
      observerCount: session.observers.size,
      activePresenterClientId: session.activePresenterClientId || null,
      creatorClientId: session.creatorClientId || null,
      lastReplaySeq: session.replayBuffer.lastSeq(),
      exitCode: session.exitCode ?? null,
      signal: session.signal ?? null,
    };
  }

  function getPoolSnapshot() {
    return {
      poolId: pool.poolId,
      title: pool.title,
      defaultSessionId: pool.defaultSessionId,
      capacity: {
        sessionCount: sessions.size,
        maxSessions: config.maxSessions,
        availableSessions: Math.max(0, config.maxSessions - sessions.size),
        replayBufferBytesPerSession: config.replayBufferBytes,
        maxReplayBytes: config.maxSessions * config.replayBufferBytes,
      },
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
      onError: typeof input.onError === 'function' ? input.onError : existing.onError || null,
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
    const metadata = Object.freeze({
      sessionId: session.sessionId,
      replaySeq: replayEntry.seq,
    });
    for (const observer of session.observers.values()) {
      observer.onData?.(replayEntry.data, metadata);
    }
  }

  function emitExit(session, payload) {
    const correlatedPayload = {
      ...payload,
      sessionId: session.sessionId,
    };
    for (const observer of session.observers.values()) {
      observer.onExit?.(correlatedPayload);
    }
  }

  function emitError(session, error) {
    const metadata = Object.freeze({ sessionId: session.sessionId });
    for (const observer of session.observers.values()) {
      observer.onError?.(error, metadata);
    }
  }

  function clearStartupTimer(session) {
    if (session.startupTimer === null) return false;
    const timer = session.startupTimer;
    session.startupTimer = null;
    cancelTimeout(timer);
    return true;
  }

  function killPtyOnce(session) {
    if (session.killState === 'confirmed') {
      return { attempted: false, killed: true, attemptCount: session.killAttemptCount };
    }
    if (
      session.killState === 'in_progress'
    ) {
      return { attempted: false, killed: false, attemptCount: session.killAttemptCount };
    }
    if (!session.pty || typeof session.pty.kill !== 'function') {
      session.killState = 'confirmed';
      return { attempted: false, killed: true, attemptCount: session.killAttemptCount };
    }

    session.killState = 'in_progress';
    session.killAttemptCount = Math.min(
      MAX_AUDIT_KILL_ATTEMPTS,
      session.killAttemptCount + 1,
    );
    try {
      session.pty.kill('SIGHUP');
      session.killState = 'confirmed';
      return { attempted: true, killed: true, attemptCount: session.killAttemptCount };
    } catch {
      session.killState = 'idle';
      audit.error('terminal_pty_kill_failed', {
        sessionId: session.sessionId,
        clientId: session.creatorClientId,
        code: 'pty_kill_failed',
        processStatus: session.processStatus,
        attemptCount: session.killAttemptCount,
      });
      return { attempted: true, killed: false, attemptCount: session.killAttemptCount };
    }
  }

  function cleanupPty(session, maxAttempts = MAX_PTY_CLEANUP_ATTEMPTS) {
    let operationAttemptCount = 0;
    let result = {
      attempted: false,
      killed: session.killState === 'confirmed',
      attemptCount: session.killAttemptCount,
    };
    while (!result.killed && operationAttemptCount < maxAttempts) {
      result = killPtyOnce(session);
      if (!result.attempted) break;
      operationAttemptCount += 1;
    }
    return {
      ...result,
      operationAttemptCount,
    };
  }

  function removeSessionFromPool(sessionId) {
    sessions.delete(sessionId);
    if (pool.defaultSessionId === sessionId) {
      pool.defaultSessionId = sessions.keys().next().value || null;
    }
  }

  function markPtyReady(session) {
    if (session.processStatus !== PROCESS_STATUS.STARTING) return false;
    session.processStatus = transitionProcessState(session.processStatus, 'ready');
    clearStartupTimer(session);
    const duration = Math.round(now().getTime() - session.startedAtMs);
    const startupDurationMs = Math.min(
      config.startupTimeoutMs,
      Math.max(0, Number.isFinite(duration) ? duration : 0),
    );
    audit.info('terminal_pty_ready', {
      sessionId: session.sessionId,
      clientId: session.creatorClientId,
      startupDurationMs,
    });
    return true;
  }

  function handleStartupTimeout(session) {
    if (session.processStatus !== PROCESS_STATUS.STARTING || session.exitHandled) return;
    clearStartupTimer(session);
    session.processStatus = transitionProcessState(session.processStatus, 'timeout');
    session.exitHandled = true;
    session.exitCode = null;
    session.signal = null;
    session.lastActiveAt = timestamp();
    const error = makeTerminalError('pty_startup_timeout', {
      sessionId: session.sessionId,
    });
    audit.error('terminal_pty_startup_timeout', {
      sessionId: session.sessionId,
      clientId: session.creatorClientId,
      code: error.code,
      startupTimeoutMs: config.startupTimeoutMs,
    });
    killPtyOnce(session);
    emitError(session, error);
    emitExit(session, {
      exitCode: null,
      signal: null,
      errorCode: error.code,
      processStatus: session.processStatus,
    });
  }

  function wirePty(session, pty) {
    if (typeof pty.onData === 'function') {
      pty.onData((data) => {
        if (
          session.processStatus === PROCESS_STATUS.EXITED
          || session.processStatus === PROCESS_STATUS.FAILED
          || session.processStatus === PROCESS_STATUS.CLOSED
        ) {
          return;
        }
        markPtyReady(session);
        session.lastActiveAt = timestamp();
        if (config.recordIo) {
          audit.info('terminal_output_observed', {
            sessionId: session.sessionId,
            clientId: session.activePresenterClientId,
            bytes: Buffer.byteLength(String(data || ''), 'utf8'),
            ioRecording: true,
          });
        }
        emitOutput(session, data);
      });
    }
    if (typeof pty.onExit === 'function') {
      pty.onExit(({ exitCode, signal }) => {
        if (session.exitHandled) return;
        session.exitHandled = true;
        clearStartupTimer(session);
        session.processStatus = transitionProcessState(session.processStatus, 'exit');
        session.exitCode = exitCode;
        session.signal = signal;
        session.lastActiveAt = timestamp();
        audit.info('terminal_pty_exited', {
          sessionId: session.sessionId,
          clientId: session.creatorClientId,
          exitCode,
          signal,
          processStatus: session.processStatus,
        });
        emitExit(session, {
          exitCode,
          signal,
          processStatus: session.processStatus,
        });
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
    reapIdleSessions();
    if (sessions.size >= config.maxSessions) {
      audit.warn('terminal_session_rejected', {
        code: 'terminal_session_limit',
        sessionCount: sessions.size,
        maxSessions: config.maxSessions,
      });
      throw Object.assign(new Error('Terminal session limit reached'), {
        code: 'terminal_session_limit',
      });
    }
    const sessionId = 'term_' + crypto.randomBytes(8).toString('hex');
    const cols = Number(input.cols || 80);
    const rows = Number(input.rows || 24);
    const title = String(input.title || 'Terminal ' + (sessions.size + 1));
    let pty;
    try {
      pty = ptyFactory(config.shell, getTerminalShellArgs(config.shell), {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: config.cwd || undefined,
        env: buildTerminalEnvironment(process.env, {
          pathEntries: config.pathEntries,
          shell: config.shell,
        }),
      });
    } catch {
      audit.error('terminal_pty_spawn_failed', {
        clientId: String(input.clientId || '').trim() || null,
        socketId: String(input.socketId || '').trim() || null,
        code: 'pty_spawn_failed',
        shell: config.shell,
        cwd: config.cwd || null,
      });
      throw makeTerminalError('pty_spawn_failed');
    }
    const startedAtMs = now().getTime();
    const session = {
      sessionId,
      title,
      cwd: config.cwd || '',
      shell: config.shell,
      cols,
      rows,
      status: 'detached',
      processStatus: PROCESS_STATUS.STARTING,
      createdAt: timestamp(),
      lastActiveAt: timestamp(),
      detachedReason: null,
      pty,
      observers: new Map(),
      replayBuffer: createReplayBuffer(config.replayBufferBytes),
      activePresenterClientId: null,
      creatorClientId: String(input.clientId || '').trim() || null,
      startedAtMs,
      startupTimer: null,
      exitHandled: false,
      killState: 'idle',
      killAttemptCount: 0,
      exitCode: null,
      signal: null,
    };

    addObserver(session, input);
    sessions.set(sessionId, session);
    if (!pool.defaultSessionId) {
      pool.defaultSessionId = sessionId;
    }
    session.startupTimer = scheduleTimeout(
      () => handleStartupTimeout(session),
      config.startupTimeoutMs,
    );
    session.startupTimer?.unref?.();
    try {
      wirePty(session, pty);
    } catch {
      audit.error('terminal_pty_registration_failed', {
        sessionId,
        clientId: session.creatorClientId,
        socketId: String(input.socketId || '').trim() || null,
        code: 'pty_spawn_failed',
      });
      clearStartupTimer(session);
      session.processStatus = transitionProcessState(session.processStatus, 'close');
      session.exitHandled = true;
      const cleanupResult = cleanupPty(session);
      if (!cleanupResult.killed) {
        audit.error('terminal_pty_cleanup_failed', {
          sessionId,
          clientId: session.creatorClientId,
          code: 'pty_cleanup_failed',
          attemptCount: cleanupResult.operationAttemptCount,
          totalAttemptCount: session.killAttemptCount,
        });
      }
      session.status = 'detached';
      session.detachedReason = 'registration-failed';
      session.observers.clear();
      session.activePresenterClientId = null;
      removeSessionFromPool(sessionId);
      throw makeTerminalError('pty_spawn_failed');
    }
    maybeWarnSessionCount();
    audit.info('terminal_session_created', {
      sessionId,
      poolId: pool.poolId,
      clientId: session.creatorClientId,
      socketId: String(input.socketId || '').trim() || null,
      shell: session.shell,
      cwd: session.cwd,
      cols,
      rows,
      observerCount: session.observers.size,
      ioRecording: config.recordIo,
    });
    return snapshotSession(session);
  }

  function attachSession(sessionId, input = {}) {
    const session = ensureSession(sessionId);
    addObserver(session, input);
    if (
      session.processStatus === PROCESS_STATUS.RUNNING
      && input.cols
      && input.rows
      && session.activePresenterClientId === input.clientId
    ) {
      resizeSession(sessionId, {
        clientId: input.clientId,
        cols: input.cols,
        rows: input.rows,
      });
    }
    audit.info('terminal_session_attached', {
      sessionId: session.sessionId,
      poolId: pool.poolId,
      clientId: String(input.clientId || '').trim() || null,
      socketId: String(input.socketId || '').trim() || null,
      observerCount: session.observers.size,
    });
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
    audit.info('terminal_session_detached', {
      sessionId: session.sessionId,
      poolId: pool.poolId,
      clientId: removedClientId || clientId || null,
      socketId: socketId || null,
      observerCount: session.observers.size,
      reason: input.reason || 'detached',
    });
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
    assertProcessWritable(session.processStatus);
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
    assertProcessWritable(session.processStatus);
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
    clearStartupTimer(session);
    session.processStatus = transitionProcessState(session.processStatus, 'close');
    session.exitHandled = true;
    const cleanupResult = cleanupPty(session);
    if (!cleanupResult.killed) {
      session.lastActiveAt = timestamp();
      audit.error('terminal_pty_cleanup_failed', {
        sessionId,
        clientId: String(input.clientId || '').trim() || session.creatorClientId,
        socketId: String(input.socketId || '').trim() || null,
        code: 'pty_cleanup_failed',
        attemptCount: cleanupResult.operationAttemptCount,
        totalAttemptCount: session.killAttemptCount,
      });
      throw makeTerminalError('pty_cleanup_failed', { sessionId });
    }
    session.status = 'detached';
    session.detachedReason = input.reason || 'closed';
    session.lastActiveAt = timestamp();
    session.observers.clear();
    session.activePresenterClientId = null;
    removeSessionFromPool(sessionId);
    audit.info('terminal_session_closed', {
      sessionId,
      clientId: String(input.clientId || '').trim() || null,
      socketId: String(input.socketId || '').trim() || null,
      reason: session.detachedReason,
      poolId: pool.poolId,
    });
    return snapshotSession(session);
  }

  function listSessions() {
    return Array.from(sessions.values()).map(snapshotSession);
  }

  function reapIdleSessions() {
    if (!Number.isFinite(config.idleTimeoutMs) || config.idleTimeoutMs <= 0) {
      return [];
    }
    const currentTime = now().getTime();
    const reaped = [];
    for (const session of Array.from(sessions.values())) {
      const lastActiveTime = Date.parse(session.lastActiveAt);
      if (
        session.observers.size === 0
        && Number.isFinite(lastActiveTime)
        && currentTime - lastActiveTime > config.idleTimeoutMs
      ) {
        closeSession(session.sessionId, { reason: 'idle-timeout' });
        reaped.push(session.sessionId);
      }
    }
    return reaped;
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
    reapIdleSessions,
    handleSocketDisconnect,
    _getSession: getSession,
  };
}

module.exports = {
  buildTerminalEnv,
  createReplayBuffer,
  createTerminalSessionManager,
};
