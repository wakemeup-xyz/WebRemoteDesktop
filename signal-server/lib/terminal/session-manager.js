const crypto = require('node:crypto');
const { createTerminalAudit } = require('./audit');
const { loadTerminalConfig } = require('./config');
const { buildTerminalEnvironment, getTerminalShellArgs } = require('./environment');
const { TerminalInputBucket, TerminalOutputDispatcher } = require('./flow-control');
const { TerminalMetrics } = require('./metrics');
const {
  PROCESS_STATUS,
  assertProcessWritable,
  cleanupPtyWithEscalation,
  makeTerminalError,
  planPtyKillSignals,
  transitionProcessState,
} = require('./lifecycle');
const { normalizeTerminalSize, assertTerminalSize } = require('./geometry');
const { removeObservers, hasObserver } = require('./presence');

const MAX_PTY_CLEANUP_ATTEMPTS = 2;
const MAX_AUDIT_KILL_ATTEMPTS = 9999;
const CLEANUP_RETRY_DELAY_MS = 1000;
const MAX_CLEANUP_RETRY_DELAY_MS = 60 * 1000;
// node-pty reports process death asynchronously; leave enough budget for onExit
// before treating a successful kill signal as an unconfirmed cleanup.
const DEFAULT_PTY_KILL_WAIT_MS = 200;

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
  const rawInputRate = rawConfig.inputRate ?? rawConfig.terminalInputRate ?? {};
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
    replayBufferBytes: Number(rawConfig.replayBufferBytes ?? rawConfig.terminalReplayBufferBytes ?? 262144),
    inputRate: {
      bytesPerSecond: Number(
        rawInputRate.bytesPerSecond
        ?? rawConfig.inputBytesPerSecond
        ?? rawConfig.terminalInputBytesPerSecond
        ?? 65536
      ),
      burstBytes: Number(
        rawInputRate.burstBytes
        ?? rawConfig.inputBurstBytes
        ?? rawConfig.terminalInputBurstBytes
        ?? 131072
      ),
    },
    maxObserverQueueBytes: Number(
      rawConfig.maxObserverQueueBytes
      ?? rawConfig.terminalMaxObserverQueueBytes
      ?? 524288
    ),
    maxInFlightChunks: Number(
      rawConfig.maxInFlightChunks
      ?? rawConfig.terminalMaxInFlightChunks
      ?? 32
    ),
    maxInFlightBytes: Number(
      rawConfig.maxInFlightBytes
      ?? rawConfig.terminalMaxInFlightBytes
      ?? 65536
    ),
  };
  const now = options.now || (() => new Date());
  const inputBucketNow = typeof options.inputNow === 'function'
    ? options.inputNow
    : (typeof options.now === 'function' ? () => now().getTime() : null);
  const logger = options.logger || console;
  const audit = options.audit || createTerminalAudit(logger);
  const metrics = options.metrics || new TerminalMetrics();
  const ptyFactory = options.ptyFactory || defaultPtyFactory;
  const scheduleTimeout = options.setTimeout || setTimeout;
  const cancelTimeout = options.clearTimeout || clearTimeout;
  const outputSchedule = options.outputSchedule || setImmediate;
  const ptyKillWaitMs = Math.max(
    0,
    Number(
      options.ptyKillWaitMs
      ?? rawConfig.ptyKillWaitMs
      ?? rawConfig.terminalPtyKillWaitMs
      ?? DEFAULT_PTY_KILL_WAIT_MS,
    ) || 0,
  );
  const runPtyCleanup = options.cleanupPtyWithEscalation || cleanupPtyWithEscalation;
  const sessions = new Map();
  const cleanupQuarantine = new Map();
  const systemCloseCapability = Object.freeze({});
  const pool = {
    poolId: 'default',
    title: 'Shared Terminal Pool',
    defaultSessionId: null,
  };

  function timestamp() {
    return now().toISOString();
  }

  function snapshotSession(session, callerClientId = null) {
    const normalizedCallerClientId = String(callerClientId || '').trim();
    const isPresenter = Boolean(
      normalizedCallerClientId
      && session.activePresenterClientId
      && normalizedCallerClientId === session.activePresenterClientId,
    );
    return {
      poolId: pool.poolId,
      sessionId: session.sessionId,
      title: session.title,
      cwd: session.cwd,
      shell: session.shell,
      cols: session.cols,
      rows: session.rows,
      status: session.status,
      // Keep observer presence separate from PTY process lifecycle.
      presence: session.status,
      processStatus: session.processStatus,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      detachedReason: session.detachedReason || null,
      observerCount: session.observers.size,
      activePresenterClientId: session.activePresenterClientId || null,
      ...(normalizedCallerClientId
        ? { isPresenter, callerIsPresenter: isPresenter }
        : {}),
      creatorClientId: session.creatorClientId || null,
      lastReplaySeq: session.replayBuffer.lastSeq(),
      exitCode: session.exitCode ?? null,
      signal: session.signal ?? null,
    };
  }

  function getPoolSnapshot(options = {}) {
    const callerClientId = typeof options === 'string'
      ? options
      : options?.clientId;
    return {
      poolId: pool.poolId,
      title: pool.title,
      defaultSessionId: pool.defaultSessionId,
      capacity: {
        sessionCount: sessions.size,
        cleanupPendingCount: cleanupQuarantine.size,
        maxSessions: config.maxSessions,
        availableSessions: Math.max(
          0,
          config.maxSessions - sessions.size - cleanupQuarantine.size,
        ),
        replayBufferBytesPerSession: config.replayBufferBytes,
        maxReplayBytes: config.maxSessions * config.replayBufferBytes,
      },
      sessions: Array.from(sessions.values()).map((session) => snapshotSession(session, callerClientId)),
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
      onWarning: typeof input.onWarning === 'function' ? input.onWarning : existing.onWarning || null,
      onPresence: typeof input.onPresence === 'function' ? input.onPresence : existing.onPresence || null,
      inputBucket: existing.inputBucket || new TerminalInputBucket({
        ...config.inputRate,
        ...(inputBucketNow ? { now: inputBucketNow } : {}),
      }),
      attachedAt: existing.attachedAt || timestamp(),
      lastAttachedAt: timestamp(),
    });
    session.outputDispatcher.attach(observerId, {
      onData(data, metadata, acknowledge) {
        const onData = session.observers.get(observerId)?.onData;
        if (typeof onData !== 'function') {
          acknowledge();
          return;
        }
        const autoAcknowledge = onData.length < 3;
        try {
          onData(data, metadata, acknowledge);
        } finally {
          if (autoAcknowledge) acknowledge();
        }
      },
      onWarning(warning) {
        const observer = session.observers.get(observerId);
        if (!observer) return;
        audit.warn('terminal_output_backpressure', {
          sessionId: session.sessionId,
          clientId: observer.clientId || null,
          socketId: observer.socketId || null,
          code: warning.code,
          queuedBytes: warning.stats.queuedBytes,
          droppedChunks: warning.stats.droppedChunks,
        });
        metrics.recordCounter('output_backpressure');
        observer.onWarning?.(warning);
      },
      onDetach(reason) {
        const observer = session.observers.get(observerId);
        if (!observer) return;
        const onPresence = observer.onPresence;
        detachObserver(session.sessionId, { observerId, reason });
        onPresence?.({
          presence: getPresence(session.sessionId),
          pool: getPoolSnapshot(),
        });
      },
    });
    if (!session.activePresenterClientId) {
      session.activePresenterClientId = clientId;
    }
    updatePresence(session);
  }

  function emitOutput(session, data) {
    metrics.recordCounter('output_bytes', Buffer.byteLength(String(data || ''), 'utf8'));
    metrics.recordCounter('output_chunks');
    const replayEntry = session.replayBuffer.push(data);
    const metadata = Object.freeze({
      sessionId: session.sessionId,
      replaySeq: replayEntry.seq,
    });
    for (const observer of session.observers.values()) {
      session.outputDispatcher.enqueue(observer.observerId, replayEntry.data, metadata);
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

  function markExitObserved(session, exitInfo = {}) {
    if (session.exitObserved) {
      return false;
    }
    session.exitObserved = true;
    if (Object.prototype.hasOwnProperty.call(exitInfo, 'exitCode')) {
      session.exitCode = exitInfo.exitCode;
    }
    if (Object.prototype.hasOwnProperty.call(exitInfo, 'signal')) {
      session.signal = exitInfo.signal;
    }
    if (typeof session.resolveExit === 'function') {
      session.resolveExit({
        exitCode: session.exitCode,
        signal: session.signal,
      });
    }
    return true;
  }

  function isPtyAlive(session) {
    if (session.exitObserved || session.killState === 'confirmed') {
      return false;
    }
    if (!session.pty) {
      return false;
    }
    if (typeof session.pty.isAlive === 'function') {
      return Boolean(session.pty.isAlive());
    }
    return true;
  }

  function ensureExitLatch(session) {
    if (session.exitPromise) {
      return session.exitPromise;
    }
    session.exitPromise = new Promise((resolve) => {
      session.resolveExit = resolve;
    });
    if (session.exitObserved && typeof session.resolveExit === 'function') {
      session.resolveExit({
        exitCode: session.exitCode,
        signal: session.signal,
      });
    }
    return session.exitPromise;
  }

  function killPtyOnce(session) {
    if (session.killState === 'confirmed' || session.exitObserved) {
      session.killState = 'confirmed';
      return { attempted: false, killed: true, attemptCount: session.killAttemptCount };
    }
    if (!session.pty || typeof session.pty.kill !== 'function') {
      session.killState = 'confirmed';
      session.exitObserved = true;
      return { attempted: false, killed: true, attemptCount: session.killAttemptCount };
    }

    session.killAttemptCount = Math.min(
      MAX_AUDIT_KILL_ATTEMPTS,
      session.killAttemptCount + 1,
    );
    try {
      // Best-effort single signal for startup-timeout; confirmation still needs onExit.
      session.pty.kill('SIGHUP');
      return { attempted: true, killed: false, attemptCount: session.killAttemptCount };
    } catch {
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

  async function runCleanupPtyEscalation(session) {
    if (session.killState === 'confirmed' || session.exitObserved || !isPtyAlive(session)) {
      session.killState = 'confirmed';
      session.exitObserved = true;
      return {
        attempted: false,
        killed: true,
        attemptCount: session.killAttemptCount,
        operationAttemptCount: 0,
        signalsSent: [],
      };
    }

    ensureExitLatch(session);
    session.killState = 'in_progress';
    const steps = planPtyKillSignals({ waitMs: ptyKillWaitMs });
    const result = await runPtyCleanup(session.pty, {
      steps,
      waitMs: ptyKillWaitMs,
      isAlive: () => isPtyAlive(session),
      // `cleanupPtyWithEscalation` owns signal ordering. The exit budget is
      // implemented here so the real onExit latch, rather than a single
      // microtask, decides whether cleanup is confirmed.
      delay: () => undefined,
      waitForExit: (step = {}) => {
        if (session.exitObserved) {
          return true;
        }
        const waitMs = Math.max(0, Number(step.waitMs ?? ptyKillWaitMs) || 0);
        if (waitMs <= 0) {
          return false;
        }
        const exitPromise = ensureExitLatch(session);
        return new Promise((resolve) => {
          let settled = false;
          let timeout = null;
          const settle = (exited) => {
            if (settled) return;
            settled = true;
            if (timeout !== null) {
              cancelTimeout(timeout);
              timeout = null;
            }
            resolve(Boolean(exited));
          };
          timeout = scheduleTimeout(() => settle(false), waitMs);
          exitPromise.then(
            () => settle(true),
            () => settle(false),
          );
        });
      },
    });

    session.killAttemptCount = Math.min(
      MAX_AUDIT_KILL_ATTEMPTS,
      session.killAttemptCount + (result.signalsSent?.length || (result.attempted ? 1 : 0)),
    );

    if (result.error) {
      session.killState = 'idle';
      audit.error('terminal_pty_kill_failed', {
        sessionId: session.sessionId,
        clientId: session.creatorClientId,
        code: 'pty_kill_failed',
        processStatus: session.processStatus,
        attemptCount: session.killAttemptCount,
      });
      return {
        attempted: true,
        killed: false,
        attemptCount: session.killAttemptCount,
        operationAttemptCount: result.signalsSent?.length || 1,
        signalsSent: result.signalsSent || [],
        error: result.error,
      };
    }

    if (result.killed || result.confirmed || session.exitObserved || !isPtyAlive(session)) {
      session.killState = 'confirmed';
      session.exitObserved = true;
      return {
        attempted: Boolean(result.attempted),
        killed: true,
        attemptCount: session.killAttemptCount,
        operationAttemptCount: result.signalsSent?.length || 0,
        signalsSent: result.signalsSent || [],
        finalSignal: result.finalSignal,
      };
    }

    session.killState = 'idle';
    return {
      attempted: Boolean(result.attempted),
      killed: false,
      attemptCount: session.killAttemptCount,
      operationAttemptCount: result.signalsSent?.length || 0,
      signalsSent: result.signalsSent || [],
    };
  }

  function cleanupPty(session, maxAttempts = MAX_PTY_CLEANUP_ATTEMPTS) {
    if (session.cleanupPromise) {
      return session.cleanupPromise;
    }

    session.cleanupPromise = (async () => {
      let operationAttemptCount = 0;
      let result = {
        attempted: false,
        killed: session.killState === 'confirmed' || session.exitObserved,
        attemptCount: session.killAttemptCount,
        operationAttemptCount: 0,
        signalsSent: [],
      };

      while (!result.killed && operationAttemptCount < maxAttempts) {
        const pass = await runCleanupPtyEscalation(session);
        operationAttemptCount += 1;
        result = {
          ...pass,
          operationAttemptCount,
        };
        if (!pass.attempted && !pass.killed) {
          break;
        }
        if (pass.error) {
          continue;
        }
        if (!pass.killed) {
          break;
        }
      }

      return result;
    })();

    const tracked = session.cleanupPromise;
    tracked.finally(() => {
      if (session.cleanupPromise === tracked) {
        session.cleanupPromise = null;
      }
    });
    return tracked;
  }

  function auditCleanupFailure(session, cleanupResult) {
    audit.error('terminal_pty_cleanup_failed', {
      sessionId: session.sessionId,
      clientId: session.creatorClientId,
      code: 'pty_cleanup_failed',
      attemptCount: cleanupResult.operationAttemptCount,
      totalAttemptCount: session.killAttemptCount,
    });
  }

  async function retryQuarantinedSession(session, options = {}) {
    if (!cleanupQuarantine.has(session.sessionId)) return true;
    if (session.cleanupRetryTimer !== null) {
      const timer = session.cleanupRetryTimer;
      session.cleanupRetryTimer = null;
      if (!options.fromScheduledRetry) {
        cancelTimeout(timer);
      }
    }
    const cleanupResult = await cleanupPty(session);
    if (cleanupResult.killed) {
      cleanupQuarantine.delete(session.sessionId);
      session.cleanupRetryDelayMs = null;
      return true;
    }
    auditCleanupFailure(session, cleanupResult);
    scheduleQuarantineRetry(session);
    return false;
  }

  async function retryCleanupQuarantine() {
    for (const session of Array.from(cleanupQuarantine.values())) {
      await retryQuarantinedSession(session);
    }
  }

  function scheduleQuarantineRetry(session) {
    if (!cleanupQuarantine.has(session.sessionId) || session.cleanupRetryTimer !== null) {
      return;
    }
    const delay = Math.min(
      Math.max(CLEANUP_RETRY_DELAY_MS, Number(session.cleanupRetryDelayMs) || CLEANUP_RETRY_DELAY_MS),
      MAX_CLEANUP_RETRY_DELAY_MS,
    );
    session.cleanupRetryDelayMs = Math.min(delay * 2, MAX_CLEANUP_RETRY_DELAY_MS);
    session.cleanupRetryTimer = scheduleTimeout(() => {
      session.cleanupRetryTimer = null;
      const retry = Promise.resolve(retryQuarantinedSession(session, { fromScheduledRetry: true }));
      retry.catch((error) => {
        audit.error('terminal_pty_cleanup_failed', {
          sessionId: session.sessionId,
          clientId: session.creatorClientId,
          code: error?.code || 'pty_cleanup_failed',
        });
        scheduleQuarantineRetry(session);
      });
      return retry;
    }, delay);
    session.cleanupRetryTimer?.unref?.();
  }

  function quarantineSession(session) {
    if (cleanupQuarantine.size >= config.maxSessions) {
      throw makeTerminalError('terminal_session_limit');
    }
    session.cleanupRetryTimer = null;
    session.cleanupRetryDelayMs = CLEANUP_RETRY_DELAY_MS;
    cleanupQuarantine.set(session.sessionId, session);
    scheduleQuarantineRetry(session);
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
    metrics.recordLatency('pty_ready_ms', startupDurationMs);
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
    metrics.recordCounter('pty_startup_timeout');
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
    // Register onExit before onData so a registration failure still latches process death.
    if (typeof pty.onExit === 'function') {
      pty.onExit(({ exitCode, signal }) => {
        // Always latch process exit first so cleanup can confirm death even when
        // notifications are suppressed (user close / system close).
        markExitObserved(session, { exitCode, signal });
        session.killState = 'confirmed';
        if (session.exitHandled) return;
        session.exitHandled = true;
        clearStartupTimer(session);
        session.processStatus = transitionProcessState(session.processStatus, 'exit');
        session.lastActiveAt = timestamp();
        audit.info('terminal_pty_exited', {
          sessionId: session.sessionId,
          clientId: session.creatorClientId,
          exitCode,
          signal,
          processStatus: session.processStatus,
        });
        metrics.recordCounter('pty_exited');
        emitExit(session, {
          exitCode,
          signal,
          processStatus: session.processStatus,
        });
      });
    }
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
        if (config.recordIoMetadata) {
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
  }

  async function createSession(input = {}) {
    if (!config.enabled) {
      throw Object.assign(new Error('Terminal disabled'), { code: 'terminal_disabled' });
    }
    if (!config.adminPassword) {
      throw Object.assign(new Error('Terminal admin password not configured'), {
        code: 'terminal_admin_password_missing',
      });
    }
    await retryCleanupQuarantine();
    await reapIdleSessions({ retryQuarantine: false });
    if (sessions.size + cleanupQuarantine.size >= config.maxSessions) {
      audit.warn('terminal_session_rejected', {
        code: 'terminal_session_limit',
        sessionCount: sessions.size,
        cleanupPendingCount: cleanupQuarantine.size,
        maxSessions: config.maxSessions,
      });
      throw Object.assign(new Error('Terminal session limit reached'), {
        code: 'terminal_session_limit',
      });
    }
    const sessionId = 'term_' + crypto.randomBytes(8).toString('hex');
    const { cols, rows } = normalizeTerminalSize(input);
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
      metrics.recordCounter('pty_spawn_failed');
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
      outputDispatcher: new TerminalOutputDispatcher({
        maxQueueBytes: config.maxObserverQueueBytes,
        maxInFlightChunks: config.maxInFlightChunks,
        maxInFlightBytes: config.maxInFlightBytes,
        schedule: outputSchedule,
      }),
      activePresenterClientId: null,
      creatorClientId: String(input.clientId || '').trim() || null,
      startedAtMs,
      startupTimer: null,
      exitHandled: false,
      exitObserved: false,
      exitPromise: null,
      resolveExit: null,
      cleanupPromise: null,
      killState: 'idle',
      killAttemptCount: 0,
      exitCode: null,
      signal: null,
      cleanupRetryTimer: null,
      cleanupRetryDelayMs: null,
    };

    ensureExitLatch(session);

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
      metrics.recordCounter('pty_spawn_failed');
      audit.error('terminal_pty_registration_failed', {
        sessionId,
        clientId: session.creatorClientId,
        socketId: String(input.socketId || '').trim() || null,
        code: 'pty_spawn_failed',
      });
      clearStartupTimer(session);
      session.processStatus = transitionProcessState(session.processStatus, 'close');
      session.exitHandled = true;
      const cleanupResult = await cleanupPty(session);
      if (!cleanupResult.killed) {
        auditCleanupFailure(session, cleanupResult);
      }
      session.status = 'detached';
      session.detachedReason = 'registration-failed';
      for (const observerId of session.observers.keys()) {
        session.outputDispatcher.detach(observerId);
      }
      session.observers.clear();
      session.activePresenterClientId = null;
      removeSessionFromPool(sessionId);
      if (!cleanupResult.killed) {
        quarantineSession(session);
      }
      throw makeTerminalError('pty_spawn_failed');
    }
    maybeWarnSessionCount();
    metrics.recordCounter('session_created');
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
      ioRecording: config.recordIoMetadata,
    });
    return snapshotSession(session, input.clientId);
  }

  function attachSession(sessionId, input = {}) {
    const attachStartedAt = Date.now();
    const session = ensureSession(sessionId);
    // Validate geometry before addObserver so a bad size never leaves a partial attach.
    // Treat undefined like omitted (adapters often pass cols: payload.cols).
    const hasCols = Object.hasOwn(input, 'cols') && input.cols !== undefined;
    const hasRows = Object.hasOwn(input, 'rows') && input.rows !== undefined;
    let attachSize = null;
    if (hasCols || hasRows) {
      attachSize = normalizeTerminalSize({
        ...(hasCols ? { cols: input.cols } : {}),
        ...(hasRows ? { rows: input.rows } : {}),
      });
    }
    addObserver(session, input);
    if (
      attachSize
      && session.processStatus === PROCESS_STATUS.RUNNING
      && session.activePresenterClientId === input.clientId
    ) {
      resizeSession(sessionId, {
        clientId: input.clientId,
        socketId: input.socketId,
        cols: attachSize.cols,
        rows: attachSize.rows,
      });
    }
    audit.info('terminal_session_attached', {
      sessionId: session.sessionId,
      poolId: pool.poolId,
      clientId: String(input.clientId || '').trim() || null,
      socketId: String(input.socketId || '').trim() || null,
      observerCount: session.observers.size,
    });
    metrics.recordCounter('session_attach');
    metrics.recordLatency('attach_ms', Math.max(0, Date.now() - attachStartedAt));
    return {
      ...snapshotSession(session, input.clientId),
      replay: session.replayBuffer.snapshot(),
    };
  }

  function detachObserver(sessionId, input = {}) {
    const session = ensureSession(sessionId);
    const observerId = String(input.observerId || '').trim();
    const socketId = String(input.socketId || '').trim();
    const clientId = String(input.clientId || '').trim();
    const { removed, removedCount } = removeObservers(session.observers, {
      observerId,
      socketId,
      clientId,
    });

    for (const observer of removed) {
      session.outputDispatcher.detach(observer.observerId);
    }

    // Recompute presenter once after all removals.
    if (
      session.activePresenterClientId
      && !Array.from(session.observers.values()).some(
        (observer) => observer.clientId === session.activePresenterClientId,
      )
    ) {
      session.activePresenterClientId = session.observers.values().next().value?.clientId || null;
    }

    const removedClientId = removed[0]?.clientId || '';
    updatePresence(session, input.reason || 'detached');
    audit.info('terminal_session_detached', {
      sessionId: session.sessionId,
      poolId: pool.poolId,
      clientId: removedClientId || clientId || null,
      socketId: socketId || null,
      observerCount: session.observers.size,
      reason: input.reason || 'detached',
    });
    if (removedCount > 0) metrics.recordCounter('session_detach');
    return snapshotSession(session, input.clientId);
  }

  function detachSession(sessionId, reason = 'detached') {
    const session = ensureSession(sessionId);
    for (const observerId of session.observers.keys()) {
      session.outputDispatcher.detach(observerId);
    }
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
    return snapshotSession(session, input.clientId);
  }

  function isObserverAttached(sessionId, input = {}) {
    const session = ensureSession(sessionId);
    return Boolean(findObserver(session, input));
  }

  function findObserver(session, input = {}) {
    const clientId = String(input.clientId || '').trim();
    const socketId = String(input.socketId || '').trim();
    if (!clientId && !socketId) {
      return null;
    }
    return Array.from(session.observers.values()).find((observer) => {
      if (socketId) {
        return observer.socketId === socketId;
      }
      return observer.clientId === clientId;
    }) || null;
  }

  function writeInput(sessionId, input = {}) {
    const session = ensureSession(sessionId);
    assertProcessWritable(session.processStatus);
    const observer = findObserver(session, input);
    if (!observer) {
      throw Object.assign(new Error('terminal_session_not_found'), { code: 'terminal_session_not_found' });
    }
    const data = String(input.data || '');
    const bytes = Buffer.byteLength(data, 'utf8');
    const consumption = observer.inputBucket.consume(bytes);
    if (!consumption.accepted) {
      const details = {
        retryAfterMs: consumption.retryAfterMs,
        remainingBytes: consumption.remainingBytes,
        bytes,
      };
      audit.warn('terminal_input_rate_limited', {
        sessionId: session.sessionId,
        clientId: observer.clientId || null,
        socketId: observer.socketId || null,
        code: 'terminal_input_rate_limited',
        ...details,
      });
      metrics.recordCounter('input_rate_limited');
      throw makeTerminalError('terminal_input_rate_limited', details);
    }
    if (session.pty && typeof session.pty.write === 'function') {
      session.pty.write(data);
    }
    session.lastActiveAt = timestamp();
    metrics.recordCounter('input_accepted');
    return snapshotSession(session, input.clientId);
  }

  function resizeSession(sessionId, input = {}) {
    const session = ensureSession(sessionId);
    // Size is validated before lifecycle/auth so adapters can map a stable out-of-range code.
    const { cols, rows } = assertTerminalSize(input.cols, input.rows);
    assertProcessWritable(session.processStatus);
    const clientId = String(input.clientId || '').trim();
    const socketId = String(input.socketId || '').trim();
    if (
      !clientId ||
      !isObserverAttached(sessionId, { clientId, socketId }) ||
      session.activePresenterClientId !== clientId
    ) {
      return snapshotSession(session);
    }
    if (session.pty && typeof session.pty.resize === 'function') {
      session.pty.resize(cols, rows);
    }
    session.cols = cols;
    session.rows = rows;
    session.lastActiveAt = timestamp();
    return snapshotSession(session, input.clientId);
  }

  async function closeSession(sessionId, input = {}) {
    const session = ensureSession(sessionId);
    const isSystemClose = input.systemCapability === systemCloseCapability;
    if (!isSystemClose && !isObserverAttached(sessionId, input)) {
      throw Object.assign(new Error('terminal_session_not_attached'), {
        code: 'terminal_session_not_attached',
      });
    }
    const closeReason = isSystemClose
      ? (input.systemReason === 'system:shutdown' ? 'system:shutdown' : 'system:idle-timeout')
      : 'user-close';
    clearStartupTimer(session);
    if (session.processStatus !== PROCESS_STATUS.CLOSED) {
      session.processStatus = transitionProcessState(session.processStatus, 'close');
    }
    session.exitHandled = true;
    ensureExitLatch(session);
    const cleanupResult = await cleanupPty(session);
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
    session.detachedReason = closeReason;
    session.lastActiveAt = timestamp();
    for (const observerId of session.observers.keys()) {
      session.outputDispatcher.detach(observerId);
    }
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
    metrics.recordCounter('session_closed');
    return snapshotSession(session);
  }

  function closeSessionAsSystem(sessionId, systemReason) {
    return closeSession(sessionId, {
      systemCapability: systemCloseCapability,
      systemReason,
    });
  }

  async function closeAllAsSystem(systemReason = 'system:shutdown') {
    const reason = systemReason === 'system:shutdown' ? 'system:shutdown' : 'system:idle-timeout';
    const snapshot = Array.from(sessions.keys());
    const closedSessionIds = [];
    const failures = [];

    for (const sessionId of snapshot) {
      try {
        await closeSessionAsSystem(sessionId, reason);
        closedSessionIds.push(sessionId);
      } catch (error) {
        failures.push({
          sessionId,
          code: error?.code || 'terminal_close_failed',
          message: error?.message || 'terminal close failed',
        });
        audit.error('terminal_pty_cleanup_failed', {
          sessionId,
          code: error?.code || 'pty_cleanup_failed',
          reason,
        });
      }
    }

    return {
      closedSessionIds,
      failures,
      reason,
    };
  }

  function listSessions() {
    return Array.from(sessions.values()).map(snapshotSession);
  }

  async function reapIdleSessions(options = {}) {
    if (options.retryQuarantine !== false) {
      await retryCleanupQuarantine();
    }
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
        try {
          await closeSessionAsSystem(session.sessionId, 'system:idle-timeout');
          reaped.push(session.sessionId);
        } catch (error) {
          if (error?.code !== 'pty_cleanup_failed') throw error;
        }
      }
    }
    return reaped;
  }

  function getPresence(sessionId) {
    const session = ensureSession(sessionId);
    return {
      poolId: pool.poolId,
      sessionId: session.sessionId,
      // Presence describes attachments; processStatus remains the PTY lifecycle.
      presence: session.status,
      status: session.status,
      processStatus: session.processStatus,
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
      const selector = socketId
        ? { socketId }
        : { clientId };
      if (hasObserver(session.observers, selector)) {
        // One detach per session: presence removes every socketId/clientId match
        // (Socket.IO + webrtc:<socketId> when they share the same socketId).
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
    closeSessionAsSystem,
    closeAllAsSystem,
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
    metrics,
    _getSession: getSession,
    _getCleanupPendingCount: () => cleanupQuarantine.size,
  };
}

module.exports = {
  buildTerminalEnv,
  createReplayBuffer,
  createTerminalSessionManager,
};
