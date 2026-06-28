const assert = require('node:assert/strict');
const test = require('node:test');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.VIEWER_ACCESS_PASSWORD = process.env.VIEWER_ACCESS_PASSWORD || 'test-viewer-password';
process.env.HOST_SHARED_SECRET = process.env.HOST_SHARED_SECRET || 'test-host-secret';

const { loadConfig } = require('../lib/config');

test('loadConfig exposes terminal defaults', () => {
  delete process.env.WRD_ENABLE_TERMINAL;
  delete process.env.WRD_TERMINAL_ADMIN_PASSWORD;
  delete process.env.WRD_TERMINAL_SHELL;
  delete process.env.WRD_TERMINAL_CWD;
  delete process.env.WRD_TERMINAL_SOFT_WARN_SESSION_COUNT;
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
  assert.equal(config.terminalIdleTimeoutMs, 2500);
  assert.equal(config.terminalStartupTimeoutMs, 15000);
  assert.equal(config.terminalAuditLog, '/var/log/terminal.log');
  assert.equal(config.terminalRecordIo, true);
});
