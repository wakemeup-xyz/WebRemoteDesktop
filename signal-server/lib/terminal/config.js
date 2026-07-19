const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_SHELLS = new Set(['/bin/zsh', '/bin/bash']);
const LIMITS = Object.freeze({
  maxSessions: [1, 32],
  softWarnSessionCount: [0, 32],
  replayBufferBytes: [1024, 8 * 1024 * 1024],
  idleTimeoutMs: [0, 24 * 60 * 60 * 1000],
  startupTimeoutMs: [1000, 120000],
  inputBytesPerSecond: [1024, 1024 * 1024],
  inputBurstBytes: [1024, 2 * 1024 * 1024],
  maxObserverQueueBytes: [64 * 1024, 8 * 1024 * 1024],
});

function boundedInt(name, raw, [min, max], fallback) {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`[config] ${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function existingAbsoluteDirectory(name, raw) {
  const value = String(raw || '').trim();
  if (!value) return '';

  const normalized = path.normalize(value);
  let isDirectory = false;
  if (path.isAbsolute(normalized)) {
    try {
      isDirectory = fs.statSync(normalized).isDirectory();
    } catch {
      isDirectory = false;
    }
  }

  if (!isDirectory) {
    throw new Error(`[config] ${name} must be an existing absolute directory`);
  }
  return normalized;
}

function parsePathEntries(raw) {
  const entries = String(raw || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  return [...new Set(entries.map((entry) => (
    existingAbsoluteDirectory('WRD_TERMINAL_PATH_EXTRA', entry)
  )))];
}

function parseTerminalConfig(env = process.env) {
  const shell = String(env.WRD_TERMINAL_SHELL || '/bin/zsh').trim() || '/bin/zsh';
  if (!ALLOWED_SHELLS.has(shell)) {
    throw new Error('[config] WRD_TERMINAL_SHELL must be one of /bin/zsh, /bin/bash');
  }

  return {
    enabled: env.WRD_ENABLE_TERMINAL === '1',
    adminPassword: String(env.WRD_TERMINAL_ADMIN_PASSWORD || '').trim(),
    shell,
    cwd: existingAbsoluteDirectory('WRD_TERMINAL_CWD', env.WRD_TERMINAL_CWD),
    pathEntries: parsePathEntries(env.WRD_TERMINAL_PATH_EXTRA),
    maxSessions: boundedInt(
      'WRD_TERMINAL_MAX_SESSIONS',
      env.WRD_TERMINAL_MAX_SESSIONS,
      LIMITS.maxSessions,
      8,
    ),
    softWarnSessionCount: boundedInt(
      'WRD_TERMINAL_SOFT_WARN_SESSION_COUNT',
      env.WRD_TERMINAL_SOFT_WARN_SESSION_COUNT,
      LIMITS.softWarnSessionCount,
      4,
    ),
    replayBufferBytes: boundedInt(
      'WRD_TERMINAL_REPLAY_BUFFER_BYTES',
      env.WRD_TERMINAL_REPLAY_BUFFER_BYTES,
      LIMITS.replayBufferBytes,
      262144,
    ),
    idleTimeoutMs: boundedInt(
      'WRD_TERMINAL_IDLE_TIMEOUT_MS',
      env.WRD_TERMINAL_IDLE_TIMEOUT_MS,
      LIMITS.idleTimeoutMs,
      0,
    ),
    startupTimeoutMs: boundedInt(
      'WRD_TERMINAL_STARTUP_TIMEOUT_MS',
      env.WRD_TERMINAL_STARTUP_TIMEOUT_MS,
      LIMITS.startupTimeoutMs,
      10000,
    ),
    inputRate: {
      bytesPerSecond: boundedInt(
        'WRD_TERMINAL_INPUT_BYTES_PER_SECOND',
        env.WRD_TERMINAL_INPUT_BYTES_PER_SECOND,
        LIMITS.inputBytesPerSecond,
        65536,
      ),
      burstBytes: boundedInt(
        'WRD_TERMINAL_INPUT_BURST_BYTES',
        env.WRD_TERMINAL_INPUT_BURST_BYTES,
        LIMITS.inputBurstBytes,
        131072,
      ),
    },
    maxObserverQueueBytes: boundedInt(
      'WRD_TERMINAL_MAX_OBSERVER_QUEUE_BYTES',
      env.WRD_TERMINAL_MAX_OBSERVER_QUEUE_BYTES,
      LIMITS.maxObserverQueueBytes,
      524288,
    ),
    allowPolling: env.WRD_TERMINAL_ALLOW_POLLING === '1',
    auditLog: String(env.WRD_TERMINAL_AUDIT_LOG || '').trim(),
    recordIoMetadata: env.WRD_TERMINAL_RECORD_IO === '1',
  };
}

function loadTerminalConfig() {
  return parseTerminalConfig(process.env);
}

module.exports = {
  loadTerminalConfig,
  parseTerminalConfig,
};
