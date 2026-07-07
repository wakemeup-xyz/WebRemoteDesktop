const assert = require('node:assert/strict');
const test = require('node:test');

const path = require('node:path');

const { buildTerminalEnv, createTerminalSessionManager } = require('../lib/terminal/session-manager');

function createFakePty() {
  const handlers = {
    data: [],
    exit: [],
  };
  return {
    handlers,
    writeCalls: [],
    resizeCalls: [],
    killCalls: [],
    onData(handler) {
      handlers.data.push(handler);
    },
    onExit(handler) {
      handlers.exit.push(handler);
    },
    write(data) {
      this.writeCalls.push(data);
    },
    resize(cols, rows) {
      this.resizeCalls.push({ cols, rows });
    },
    kill(signal) {
      this.killCalls.push(signal);
    },
    emitData(data) {
      handlers.data.forEach((handler) => handler(data));
    },
    emitExit(event) {
      handlers.exit.forEach((handler) => handler(event));
    },
  };
}

test('shared session manager stores sessions in the default pool and no longer exposes ownerSub ownership', () => {
  const manager = createTerminalSessionManager({
    ptyFactory: createFakePty,
    logger: { warn() {}, info() {}, error() {} },
    now: () => new Date('2026-07-07T00:00:00.000Z'),
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/Users/macstudio1/AI/Claude/WebRemoteDesktop',
      terminalSoftWarnSessionCount: 4,
      terminalIdleTimeoutMs: 0,
      terminalStartupTimeoutMs: 10000,
      terminalRecordIo: false,
    },
  });

  const created = manager.createSession({
    clientId: 'browser-a',
    cols: 120,
    rows: 32,
    title: 'Shared shell',
  });

  assert.equal(created.poolId, 'default');
  assert.equal(created.observerCount, 1);
  assert.equal('ownerSub' in created, false);
  assert.equal(manager.getPoolSnapshot().poolId, 'default');
  assert.equal(manager.getPoolSnapshot().sessions[0].sessionId, created.sessionId);
});

test('shared session manager broadcasts PTY output to every attached observer and replays recent output on reattach', () => {
  const pty = createFakePty();
  const deliveredA = [];
  const deliveredB = [];
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/tmp',
      terminalSoftWarnSessionCount: 4,
      terminalIdleTimeoutMs: 0,
      terminalStartupTimeoutMs: 10000,
      terminalRecordIo: false,
    },
  });

  const created = manager.createSession({
    clientId: 'browser-a',
    cols: 80,
    rows: 24,
    onData: (chunk) => deliveredA.push(chunk),
  });
  manager.attachSession(created.sessionId, {
    clientId: 'browser-b',
    onData: (chunk) => deliveredB.push(chunk),
  });

  pty.emitData('first line\r\n');
  assert.deepEqual(deliveredA, ['first line\r\n']);
  assert.deepEqual(deliveredB, ['first line\r\n']);

  manager.detachObserver(created.sessionId, { clientId: 'browser-b' });
  const replay = manager.attachSession(created.sessionId, {
    clientId: 'browser-b',
    onData: (chunk) => deliveredB.push(chunk),
  });
  assert.equal(replay.replay.length, 1);
  assert.equal(replay.replay[0].data, 'first line\r\n');
});

test('shared session manager trims replay entries when the bounded buffer is exceeded', () => {
  const pty = createFakePty();
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/tmp',
      terminalSoftWarnSessionCount: 4,
      terminalIdleTimeoutMs: 0,
      terminalStartupTimeoutMs: 10000,
      terminalRecordIo: false,
      terminalReplayBufferBytes: 20,
    },
  });

  const created = manager.createSession({ clientId: 'browser-a', cols: 80, rows: 24 });
  pty.emitData('1234567890');
  pty.emitData('abcdefghij');
  pty.emitData('KLMNOPQRST');

  const attached = manager.attachSession(created.sessionId, { clientId: 'browser-b' });
  assert.deepEqual(attached.replay.map((entry) => entry.data), ['abcdefghij', 'KLMNOPQRST']);
});

test('shared session manager keeps PTY alive after last observer detaches and only kills on explicit close', () => {
  const pty = createFakePty();
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/tmp',
      terminalSoftWarnSessionCount: 4,
      terminalIdleTimeoutMs: 0,
      terminalStartupTimeoutMs: 10000,
      terminalRecordIo: false,
    },
  });

  const created = manager.createSession({ clientId: 'browser-a', cols: 80, rows: 24 });
  manager.detachObserver(created.sessionId, { clientId: 'browser-a', reason: 'page-close' });

  assert.equal(manager.getPoolSnapshot().sessions[0].observerCount, 0);
  assert.equal(pty.killCalls.length, 0);

  manager.closeSession(created.sessionId, { clientId: 'browser-a', reason: 'user-close' });
  assert.equal(pty.killCalls.length, 1);
});

test('only the active presenter may resize the shared PTY', () => {
  const pty = createFakePty();
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/tmp',
      terminalSoftWarnSessionCount: 4,
      terminalIdleTimeoutMs: 0,
      terminalStartupTimeoutMs: 10000,
      terminalRecordIo: false,
    },
  });

  const created = manager.createSession({ clientId: 'browser-a', cols: 80, rows: 24 });
  manager.attachSession(created.sessionId, { clientId: 'browser-b' });
  manager.setActivePresenter(created.sessionId, { clientId: 'browser-a' });
  manager.resizeSession(created.sessionId, { clientId: 'browser-b', cols: 100, rows: 40 });
  manager.resizeSession(created.sessionId, { clientId: 'browser-a', cols: 132, rows: 36 });

  assert.deepEqual(pty.resizeCalls, [{ cols: 132, rows: 36 }]);
});

test('buildTerminalEnv prepends executable and user bin paths while preserving existing PATH entries', () => {
  const env = buildTerminalEnv({
    HOME: '/Users/tester',
    PATH: '/usr/local/bin:/usr/bin:/bin',
  });

  const entries = env.PATH.split(':');
  assert.equal(entries.includes(path.dirname(process.execPath)), true);
  assert.equal(entries.includes('/Users/tester/.bun/bin'), true);
  assert.equal(entries.includes('/Users/tester/.homebrew/bin'), true);
  assert.equal(entries.includes('/Users/tester/.homebrew/sbin'), true);
  assert.equal(entries.includes('/Users/tester/.local/bin'), true);
  assert.equal(entries.includes('/usr/local/bin'), true);
  assert.equal(entries.includes('/usr/bin'), true);
  assert.equal(entries.includes('/bin'), true);
});

test('session manager passes the normalized PATH into the pty factory', () => {
  const spawnCalls = [];
  const manager = createTerminalSessionManager({
    ptyFactory: (shell, args, options) => {
      spawnCalls.push({ shell, args, options });
      return createFakePty();
    },
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/tmp',
      terminalSoftWarnSessionCount: 4,
      terminalIdleTimeoutMs: 0,
      terminalStartupTimeoutMs: 10000,
      terminalRecordIo: false,
    },
  });

  manager.createSession({ clientId: 'browser-a', cols: 80, rows: 24 });

  const envPath = spawnCalls[0].options.env.PATH;
  assert.equal(envPath.includes(path.dirname(process.execPath)), true);
  assert.equal(envPath.includes('/usr/bin'), true);
});
