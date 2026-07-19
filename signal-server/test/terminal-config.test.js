const assert = require('node:assert/strict');
const test = require('node:test');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.VIEWER_ACCESS_PASSWORD = process.env.VIEWER_ACCESS_PASSWORD || 'test-viewer-password';
process.env.HOST_SHARED_SECRET = process.env.HOST_SHARED_SECRET || 'test-host-secret';

const { loadConfig } = require('../lib/config');
const { parseTerminalConfig } = require('../lib/terminal/config');

const TERMINAL_ENV_KEYS = [
  'WRD_ENABLE_TERMINAL',
  'WRD_TERMINAL_ADMIN_PASSWORD',
  'WRD_TERMINAL_SHELL',
  'WRD_TERMINAL_CWD',
  'WRD_TERMINAL_PATH_EXTRA',
  'WRD_TERMINAL_SOFT_WARN_SESSION_COUNT',
  'WRD_TERMINAL_MAX_SESSIONS',
  'WRD_TERMINAL_REPLAY_BUFFER_BYTES',
  'WRD_TERMINAL_IDLE_TIMEOUT_MS',
  'WRD_TERMINAL_STARTUP_TIMEOUT_MS',
  'WRD_TERMINAL_INPUT_BYTES_PER_SECOND',
  'WRD_TERMINAL_INPUT_BURST_BYTES',
  'WRD_TERMINAL_MAX_OBSERVER_QUEUE_BYTES',
  'WRD_TERMINAL_ALLOW_POLLING',
  'WRD_TERMINAL_AUDIT_LOG',
  'WRD_TERMINAL_RECORD_IO',
];

function terminalEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of TERMINAL_ENV_KEYS) {
    delete env[key];
  }
  return { ...env, ...overrides };
}

test('loadConfig exposes terminal defaults', () => {
  delete process.env.WRD_ENABLE_TERMINAL;
  delete process.env.WRD_TERMINAL_ADMIN_PASSWORD;
  delete process.env.WRD_TERMINAL_SHELL;
  delete process.env.WRD_TERMINAL_CWD;
  delete process.env.WRD_TERMINAL_SOFT_WARN_SESSION_COUNT;
  delete process.env.WRD_TERMINAL_MAX_SESSIONS;
  delete process.env.WRD_TERMINAL_REPLAY_BUFFER_BYTES;
  delete process.env.WRD_TERMINAL_IDLE_TIMEOUT_MS;
  delete process.env.WRD_TERMINAL_STARTUP_TIMEOUT_MS;
  delete process.env.WRD_TERMINAL_AUDIT_LOG;
  delete process.env.WRD_TERMINAL_RECORD_IO;

  const config = loadConfig();

  assert.equal(config.enableTerminal, false);
  assert.equal(config.terminalAdminPassword, '');
  assert.equal(config.terminalShell, '/bin/zsh');
  assert.equal(config.terminalCwd, '');
  assert.equal(config.terminalSoftWarnSessionCount, 4);
  assert.equal(config.terminalMaxSessions, 8);
  assert.equal(config.terminalReplayBufferBytes, 256 * 1024);
  assert.equal(config.terminalIdleTimeoutMs, 0);
  assert.equal(config.terminalStartupTimeoutMs, 10000);
  assert.equal(config.terminalAuditLog, '');
  assert.equal(config.terminalRecordIo, false);
});

test('loadConfig parses terminal overrides', () => {
  process.env.WRD_ENABLE_TERMINAL = '1';
  process.env.WRD_TERMINAL_ADMIN_PASSWORD = 'terminal-admin-password';
  process.env.WRD_TERMINAL_SHELL = '/bin/bash';
  process.env.WRD_TERMINAL_CWD = '/tmp';
  process.env.WRD_TERMINAL_SOFT_WARN_SESSION_COUNT = '7';
  process.env.WRD_TERMINAL_MAX_SESSIONS = '12';
  process.env.WRD_TERMINAL_REPLAY_BUFFER_BYTES = '131072';
  process.env.WRD_TERMINAL_IDLE_TIMEOUT_MS = '2500';
  process.env.WRD_TERMINAL_STARTUP_TIMEOUT_MS = '15000';
  process.env.WRD_TERMINAL_AUDIT_LOG = '/var/log/terminal.log';
  process.env.WRD_TERMINAL_RECORD_IO = '1';

  const config = loadConfig();

  assert.equal(config.enableTerminal, true);
  assert.equal(config.terminalAdminPassword, 'terminal-admin-password');
  assert.equal(config.terminalShell, '/bin/bash');
  assert.equal(config.terminalCwd, '/tmp');
  assert.equal(config.terminalSoftWarnSessionCount, 7);
  assert.equal(config.terminalMaxSessions, 12);
  assert.equal(config.terminalReplayBufferBytes, 131072);
  assert.equal(config.terminalIdleTimeoutMs, 2500);
  assert.equal(config.terminalStartupTimeoutMs, 15000);
  assert.equal(config.terminalAuditLog, '/var/log/terminal.log');
  assert.equal(config.terminalRecordIo, true);
});

test('parseTerminalConfig exposes normalized defaults', () => {
  const config = parseTerminalConfig(terminalEnv());

  assert.deepEqual(config, {
    enabled: false,
    adminPassword: '',
    shell: '/bin/zsh',
    cwd: '',
    pathEntries: [],
    maxSessions: 8,
    softWarnSessionCount: 4,
    replayBufferBytes: 262144,
    idleTimeoutMs: 0,
    startupTimeoutMs: 10000,
    inputRate: {
      bytesPerSecond: 65536,
      burstBytes: 131072,
    },
    maxObserverQueueBytes: 524288,
    allowPolling: false,
    auditLog: '',
    recordIoMetadata: false,
  });
});

test('parseTerminalConfig normalizes overrides and deduplicates path entries', () => {
  const config = parseTerminalConfig(terminalEnv({
    WRD_ENABLE_TERMINAL: '1',
    WRD_TERMINAL_ADMIN_PASSWORD: ' terminal-admin-password ',
    WRD_TERMINAL_SHELL: '/bin/bash',
    WRD_TERMINAL_CWD: '/tmp',
    WRD_TERMINAL_PATH_EXTRA: '/tmp:/private/tmp:/tmp',
    WRD_TERMINAL_MAX_SESSIONS: '12',
    WRD_TERMINAL_SOFT_WARN_SESSION_COUNT: '7',
    WRD_TERMINAL_REPLAY_BUFFER_BYTES: '131072',
    WRD_TERMINAL_IDLE_TIMEOUT_MS: '2500',
    WRD_TERMINAL_STARTUP_TIMEOUT_MS: '15000',
    WRD_TERMINAL_INPUT_BYTES_PER_SECOND: '32768',
    WRD_TERMINAL_INPUT_BURST_BYTES: '65536',
    WRD_TERMINAL_MAX_OBSERVER_QUEUE_BYTES: '262144',
    WRD_TERMINAL_ALLOW_POLLING: '1',
    WRD_TERMINAL_AUDIT_LOG: ' /var/log/terminal.log ',
    WRD_TERMINAL_RECORD_IO: '1',
  }));

  assert.deepEqual(config, {
    enabled: true,
    adminPassword: 'terminal-admin-password',
    shell: '/bin/bash',
    cwd: '/tmp',
    pathEntries: ['/tmp', '/private/tmp'],
    maxSessions: 12,
    softWarnSessionCount: 7,
    replayBufferBytes: 131072,
    idleTimeoutMs: 2500,
    startupTimeoutMs: 15000,
    inputRate: {
      bytesPerSecond: 32768,
      burstBytes: 65536,
    },
    maxObserverQueueBytes: 262144,
    allowPolling: true,
    auditLog: '/var/log/terminal.log',
    recordIoMetadata: true,
  });
});

for (const { key, value } of [
  { key: 'WRD_TERMINAL_MAX_SESSIONS', value: 'NaN' },
  { key: 'WRD_TERMINAL_MAX_SESSIONS', value: '1.5' },
  { key: 'WRD_TERMINAL_SOFT_WARN_SESSION_COUNT', value: '33' },
  { key: 'WRD_TERMINAL_REPLAY_BUFFER_BYTES', value: String(8 * 1024 * 1024 + 1) },
  { key: 'WRD_TERMINAL_IDLE_TIMEOUT_MS', value: '-1' },
  { key: 'WRD_TERMINAL_STARTUP_TIMEOUT_MS', value: '999' },
  { key: 'WRD_TERMINAL_INPUT_BYTES_PER_SECOND', value: '1023' },
  { key: 'WRD_TERMINAL_INPUT_BURST_BYTES', value: String(2 * 1024 * 1024 + 1) },
  { key: 'WRD_TERMINAL_MAX_OBSERVER_QUEUE_BYTES', value: String(64 * 1024 - 1) },
  { key: 'WRD_TERMINAL_SHELL', value: '/bin/sh' },
  { key: 'WRD_TERMINAL_CWD', value: 'relative/path' },
  { key: 'WRD_TERMINAL_CWD', value: '/definitely/not/wrd-terminal' },
  { key: 'WRD_TERMINAL_CWD', value: '/dev/null' },
  { key: 'WRD_TERMINAL_PATH_EXTRA', value: 'relative/path' },
  { key: 'WRD_TERMINAL_PATH_EXTRA', value: '/definitely/not/wrd-terminal' },
]) {
  test(`parseTerminalConfig rejects invalid ${key}=${value}`, () => {
    assert.throws(
      () => parseTerminalConfig(terminalEnv({ [key]: value })),
      new RegExp(key),
    );
  });
}
