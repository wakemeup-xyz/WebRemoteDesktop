const assert = require('node:assert/strict');
const test = require('node:test');

const { createTerminalSessionManager } = require('../lib/terminal/session-manager');

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

test('session manager creates, attaches, detaches, closes, and snapshots sessions', () => {
  const ptyInstances = [];
  const logger = {
    warnCalls: [],
    warn(message, meta) {
      this.warnCalls.push({ message, meta });
    },
    info() {},
    error() {},
  };
  const manager = createTerminalSessionManager({
    logger,
    now: () => new Date('2026-06-28T00:00:00.000Z'),
    ptyFactory: () => {
      const pty = createFakePty();
      ptyInstances.push(pty);
      return pty;
    },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/Users/macstudio1/AI/Claude/WebRemoteDesktop',
      terminalSoftWarnSessionCount: 1,
      terminalIdleTimeoutMs: 0,
      terminalStartupTimeoutMs: 10000,
      terminalRecordIo: false,
    },
  });

  const created = manager.createSession({ ownerSub: 'admin-1', cols: 120, rows: 32 });
  assert.equal(created.status, 'attached');
  assert.equal(created.ownerSub, 'admin-1');
  assert.equal(created.shell, '/bin/zsh');
  assert.equal(created.cwd, '/Users/macstudio1/AI/Claude/WebRemoteDesktop');
  assert.equal(created.cols, 120);
  assert.equal(created.rows, 32);
  assert.equal(created.sessionId.startsWith('term_'), true);
  assert.equal(ptyInstances.length, 1);

  const reattached = manager.attachSession(created.sessionId, { ownerSub: 'admin-1' });
  assert.equal(reattached.sessionId, created.sessionId);
  assert.equal(reattached.status, 'attached');

  const detached = manager.detachSession(created.sessionId, 'socket-disconnect');
  assert.equal(detached.status, 'detached');
  assert.equal(detached.detachedReason, 'socket-disconnect');

  const second = manager.createSession({ ownerSub: 'admin-1', cols: 100, rows: 30 });
  assert.equal(second.status, 'attached');
  assert.equal(logger.warnCalls.length, 1);
  assert.equal(logger.warnCalls[0].meta.warning, 'session_count_above_soft_threshold');

  const list = manager.listSessions({ ownerSub: 'admin-1' });
  assert.equal(list.length, 2);
  assert.equal(list[0].sessionId, created.sessionId);

  const snapshot = manager.getSnapshot();
  assert.equal(snapshot.sessions.length, 2);
  assert.equal(snapshot.sessions[0].status, 'detached');

  const closed = manager.closeSession(created.sessionId, 'user-close');
  assert.equal(closed.status, 'closed');
  assert.equal(ptyInstances[0].killCalls.length, 1);
});

test('session manager keeps detached sessions available for reattach', () => {
  const manager = createTerminalSessionManager({
    ptyFactory: createFakePty,
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '',
      terminalSoftWarnSessionCount: 4,
      terminalIdleTimeoutMs: 0,
      terminalStartupTimeoutMs: 10000,
      terminalRecordIo: false,
    },
  });

  const created = manager.createSession({ ownerSub: 'browser-1', cols: 80, rows: 24 });
  manager.detachSession(created.sessionId, 'disconnect');
  const snapshot = manager.getSnapshot();
  assert.equal(snapshot.sessions[0].status, 'detached');
  const reattached = manager.attachSession(created.sessionId, { ownerSub: 'browser-1' });
  assert.equal(reattached.status, 'attached');
});
