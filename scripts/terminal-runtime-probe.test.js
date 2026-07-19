const assert = require('node:assert/strict');
const test = require('node:test');

const { signAccessToken } = require('../signal-server/lib/auth');
const { createTerminalSessionManager } = require('../signal-server/lib/terminal/session-manager');
const { createServerApp } = require('../signal-server/server');

process.env.JWT_SECRET = process.env.JWT_SECRET || '12345678';
process.env.VIEWER_ACCESS_PASSWORD = process.env.VIEWER_ACCESS_PASSWORD || 'viewer-password';
process.env.HOST_SHARED_SECRET = process.env.HOST_SHARED_SECRET || 'host-secret';

function createProbePty() {
  const dataHandlers = [];
  const exitHandlers = [];
  return {
    onData(handler) {
      dataHandlers.push(handler);
      const timer = setTimeout(() => handler('ready'), 20);
      timer.unref?.();
    },
    onExit(handler) {
      exitHandlers.push(handler);
    },
    write() {
      dataHandlers.forEach((handler) => handler(
        '__WRD_SHELL__/bin/zsh\n'
        + '__WRD_COMMAND_V__/Users/tester/.homebrew/opt/python@3.11/libexec/bin/python3\n'
        + '__WRD_ENV_PY__/Users/tester/.homebrew/opt/python@3.11/bin/python3.11\n'
        + '__WRD_ENV_KEYS__HOME,PATH,SHELL,TERM,USER,\n',
      ));
      exitHandlers.forEach((handler) => handler({ exitCode: 0, signal: 0 }));
    },
    resize() {},
    kill() {},
  };
}

test('runtime Terminal probe performs Python, environment, and exited-input checks', async () => {
  const { runTerminalProbe } = require('./terminal-runtime-probe');
  const manager = createTerminalSessionManager({
    ptyFactory: () => createProbePty(),
    audit: { info() {}, warn() {}, error() {} },
    logger: { info() {}, warn() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/tmp',
      terminalMaxSessions: 8,
      terminalStartupTimeoutMs: 10000,
    },
  });
  const runtime = createServerApp({
    config: {
      port: 0,
      nodeEnv: 'test',
      jwtSecret: process.env.JWT_SECRET,
      viewerAccessPassword: 'viewer-password',
      hostSharedSecret: 'host-secret',
      corsOrigins: [],
      stunUrls: [],
      turnUrls: [],
      turnUsername: '',
      turnCredential: '',
      enableTerminal: true,
      terminalAdminPassword: 'terminal-admin-password',
      terminalSoftWarnSessionCount: 4,
      terminalAllowPolling: false,
    },
    terminal: { sessionManager: manager },
  });
  await new Promise((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  const port = runtime.server.address().port;
  try {
    const result = await runTerminalProbe({
      baseUrl: `http://127.0.0.1:${port}`,
      token: signAccessToken('admin', 'runtime-probe-test'),
      expectedPythonPathFragment: '/.homebrew/opt/python@3.11/',
    });
    assert.equal(result.shell, '/bin/zsh');
    assert.match(result.commandPython, /python@3\.11/);
    assert.match(result.envPython, /python@3\.11/);
    assert.deepEqual(result.forbiddenEnvNames, []);
    assert.equal(result.exited, true);
    assert.equal(result.inputRejectedAfterExit, true);
    assert.equal(result.inputAckAfterExit, false);
  } finally {
    runtime.terminal.close();
    await new Promise((resolve) => runtime.server.close(resolve));
  }
});
