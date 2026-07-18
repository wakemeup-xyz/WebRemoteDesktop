const { loadConfig } = require('../config');

function loadTerminalConfig() {
  const config = loadConfig();
  return {
    enabled: config.enableTerminal,
    adminPassword: config.terminalAdminPassword,
    shell: config.terminalShell,
    cwd: config.terminalCwd,
    softWarnSessionCount: config.terminalSoftWarnSessionCount,
    maxSessions: config.terminalMaxSessions,
    replayBufferBytes: config.terminalReplayBufferBytes,
    idleTimeoutMs: config.terminalIdleTimeoutMs,
    startupTimeoutMs: config.terminalStartupTimeoutMs,
    auditLog: config.terminalAuditLog,
    recordIo: config.terminalRecordIo,
  };
}

module.exports = {
  loadTerminalConfig,
};
