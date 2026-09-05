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
      // Confirmed cleanup requires observed exit; default happy-path mock dies immediately.
      this.emitExit({ exitCode: 0, signal });
    },
    emitData(data) {
      handlers.data.forEach((handler) => handler(data));
    },
    emitExit(event) {
      handlers.exit.forEach((handler) => handler(event));
    },
  };
}

function createAsyncExitPty(delayMs = 25) {
  const pty = createFakePty();
  let exitTimer = null;
  pty.kill = function kill(signal) {
    this.killCalls.push(signal);
    if (exitTimer !== null) return;
    exitTimer = setTimeout(() => {
      exitTimer = null;
      this.emitExit({ exitCode: 0, signal });
    }, delayMs);
  };
  pty.cancelExitTimer = () => {
    if (exitTimer !== null) {
      clearTimeout(exitTimer);
      exitTimer = null;
    }
  };
  return pty;
}

test('shared session manager enforces a hard session ceiling and reports bounded capacity', async () => {
  const ptys = [];
  const manager = createTerminalSessionManager({
    ptyFactory: () => {
      const pty = createFakePty();
      ptys.push(pty);
      return pty;
    },
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalMaxSessions: 2,
      terminalReplayBufferBytes: 1024,
    },
  });

  const first = await manager.createSession({ clientId: 'browser-a' });
  await manager.createSession({ clientId: 'browser-a' });
  await assert.rejects(async () => manager.createSession({ clientId: 'browser-a' }),
    (error) => error.code === 'terminal_session_limit',
  );
  assert.equal(ptys.length, 2);
  assert.deepEqual(manager.getPoolSnapshot().capacity, {
    sessionCount: 2,
    cleanupPendingCount: 0,
    maxSessions: 2,
    availableSessions: 0,
    replayBufferBytesPerSession: 1024,
    maxReplayBytes: 2048,
  });

  await manager.closeSession(first.sessionId, { clientId: 'browser-a', reason: 'user-close' });
  await manager.createSession({ clientId: 'browser-a' });
  assert.equal(ptys.length, 3);
});

test('session snapshots separate process lifecycle from presence and expose caller presenter state', async () => {
  const pty = createFakePty();
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    logger: { warn() {}, info() {}, error() {} },
    config: { enabled: true, adminPassword: 'test-admin' },
  });

  const created = await manager.createSession({ clientId: 'presenter-a', socketId: 'socket-a' });
  assert.equal(created.processStatus, 'starting');
  assert.equal(created.presence, 'attached');
  assert.equal(created.observerCount, 1);
  assert.equal(created.activePresenterClientId, 'presenter-a');
  assert.equal(created.isPresenter, true);
  assert.equal(created.callerIsPresenter, true);

  pty.emitData('ready');
  const attached = manager.attachSession(created.sessionId, {
    clientId: 'observer-b',
    socketId: 'socket-b',
  });
  assert.equal(attached.processStatus, 'running');
  assert.equal(attached.presence, 'attached');
  assert.equal(attached.observerCount, 2);
  assert.equal(attached.isPresenter, false);
  assert.equal(attached.callerIsPresenter, false);

  const detached = manager.detachObserver(created.sessionId, {
    clientId: 'observer-b',
    socketId: 'socket-b',
  });
  assert.equal(detached.processStatus, 'running');
  assert.equal(detached.presence, 'attached');
  assert.equal(detached.isPresenter, false);
});

test('idle detached sessions are reaped using the configured timeout', async () => {
  let nowMs = Date.parse('2026-07-18T00:00:00.000Z');
  const pty = createFakePty();
  const events = [];
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    now: () => new Date(nowMs),
    audit: {
      info(event, meta) { events.push({ event, meta }); },
      warn() {},
      error() {},
    },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalMaxSessions: 8,
      terminalIdleTimeoutMs: 1000,
    },
  });
  const created = await manager.createSession({ clientId: 'browser-a' });
  manager.detachSession(created.sessionId, 'test-detach');

  nowMs += 1001;
  assert.deepEqual(await manager.reapIdleSessions(), [created.sessionId]);
  assert.equal(manager.listSessions().length, 0);
  assert.deepEqual(pty.killCalls, ['SIGHUP']);
  assert.equal(
    events.some((entry) => (
      entry.event === 'terminal_session_closed'
      && entry.meta.reason === 'system:idle-timeout'
    )),
    true,
  );
});

test('closeSession rejects a known session when the caller is not an attached observer', async () => {
  const pty = createFakePty();
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
    },
  });
  const created = await manager.createSession({ clientId: 'socket-a', socketId: 'socket-a' });

  await assert.rejects(async () => manager.closeSession(created.sessionId, {
      clientId: 'socket-b',
      socketId: 'socket-b',
      reason: 'system:shutdown',
      system: true,
    }),
    (error) => error.code === 'terminal_session_not_attached',
  );
  assert.notEqual(manager._getSession(created.sessionId), null);
  assert.deepEqual(pty.killCalls, []);
});

test('idle reaping retains failed cleanup sessions and continues with later sessions', async () => {
  let nowMs = Date.parse('2026-07-18T00:00:00.000Z');
  const events = [];
  const failedPty = createFakePty();
  failedPty.kill = function kill(signal) {
    this.killCalls.push(signal);
    throw new Error('idle cleanup SECRET_VALUE');
  };
  const successfulPty = createFakePty();
  const ptys = [failedPty, successfulPty];
  const manager = createTerminalSessionManager({
    ptyFactory: () => ptys.shift(),
    now: () => new Date(nowMs),
    audit: {
      info(event, meta) { events.push({ level: 'info', event, meta }); },
      warn(event, meta) { events.push({ level: 'warn', event, meta }); },
      error(event, meta) { events.push({ level: 'error', event, meta }); },
    },
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalMaxSessions: 3,
      terminalIdleTimeoutMs: 1000,
    },
  });
  const failed = await manager.createSession({ clientId: 'browser-a' });
  const successful = await manager.createSession({ clientId: 'browser-b' });
  manager.detachSession(failed.sessionId, 'test-detach');
  manager.detachSession(successful.sessionId, 'test-detach');

  nowMs += 1001;
  assert.deepEqual(await manager.reapIdleSessions(), [successful.sessionId]);
  assert.deepEqual(manager.listSessions().map((session) => session.sessionId), [failed.sessionId]);
  assert.deepEqual(failedPty.killCalls, ['SIGHUP', 'SIGHUP']);
  assert.deepEqual(successfulPty.killCalls, ['SIGHUP']);
  const cleanupFailure = events.find((entry) => (
    entry.event === 'terminal_pty_cleanup_failed'
    && entry.meta.sessionId === failed.sessionId
  ));
  assert.equal(cleanupFailure.meta.code, 'pty_cleanup_failed');
  assert.equal(JSON.stringify(events).includes('SECRET_VALUE'), false);
});

test('createSession contains idle cleanup failures while successful reaping frees capacity', async () => {
  let nowMs = Date.parse('2026-07-18T00:00:00.000Z');
  const failedPty = createFakePty();
  failedPty.kill = function kill(signal) {
    this.killCalls.push(signal);
    throw new Error('idle cleanup SECRET_VALUE');
  };
  const successfulPty = createFakePty();
  const replacementPty = createFakePty();
  const ptys = [failedPty, successfulPty, replacementPty];
  const manager = createTerminalSessionManager({
    ptyFactory: () => ptys.shift(),
    now: () => new Date(nowMs),
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalMaxSessions: 2,
      terminalIdleTimeoutMs: 1000,
    },
  });
  const failed = await manager.createSession({ clientId: 'browser-a' });
  const successful = await manager.createSession({ clientId: 'browser-b' });
  manager.detachSession(failed.sessionId, 'test-detach');
  manager.detachSession(successful.sessionId, 'test-detach');

  nowMs += 1001;
  const replacement = await manager.createSession({ clientId: 'browser-c' });

  assert.deepEqual(manager.listSessions().map((session) => session.sessionId), [
    failed.sessionId,
    replacement.sessionId,
  ]);
  assert.equal(manager.getPoolSnapshot().capacity.sessionCount, 2);
  assert.equal(manager.getPoolSnapshot().capacity.availableSessions, 0);
  assert.deepEqual(failedPty.killCalls, ['SIGHUP', 'SIGHUP']);
  assert.deepEqual(successfulPty.killCalls, ['SIGHUP']);
});

test('shared session manager stores sessions in the default pool and no longer exposes ownerSub ownership', async () => {
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

  const created = await manager.createSession({
    clientId: 'browser-a',
    cols: 120,
    rows: 32,
    title: 'Shared shell',
  });

  assert.equal(created.poolId, 'default');
  assert.equal(created.observerCount, 1);
  assert.equal(created.creatorClientId, 'browser-a');
  assert.equal('ownerSub' in created, false);
  assert.equal(manager.getPoolSnapshot().poolId, 'default');
  assert.equal(manager.getPoolSnapshot().sessions[0].sessionId, created.sessionId);
  assert.equal(manager.getPoolSnapshot().sessions[0].creatorClientId, 'browser-a');
});

test('shared session manager broadcasts PTY output to every attached observer and replays recent output on reattach', async () => {
  const pty = createFakePty();
  const deliveredA = [];
  const deliveredB = [];
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    outputSchedule: (drain) => drain(),
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

  const created = await manager.createSession({
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

test('shared session manager trims replay entries when the bounded buffer is exceeded', async () => {
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

  const created = await manager.createSession({ clientId: 'browser-a', cols: 80, rows: 24 });
  pty.emitData('1234567890');
  pty.emitData('abcdefghij');
  pty.emitData('KLMNOPQRST');

  const attached = manager.attachSession(created.sessionId, { clientId: 'browser-b' });
  assert.deepEqual(attached.replay.map((entry) => entry.data), ['abcdefghij', 'KLMNOPQRST']);
});

test('shared session manager retains the newest replay chunk even when it alone exceeds the replay byte limit', async () => {
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
      terminalReplayBufferBytes: 5,
    },
  });

  const created = await manager.createSession({ clientId: 'browser-a', cols: 80, rows: 24 });
  pty.emitData('1234567890');

  const attached = manager.attachSession(created.sessionId, { clientId: 'browser-b' });
  assert.deepEqual(attached.replay.map((entry) => entry.data), ['1234567890']);
});

test('shared session manager keeps PTY alive after detach and requires reattach before explicit close', async () => {
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

  const created = await manager.createSession({ clientId: 'browser-a', cols: 80, rows: 24 });
  manager.detachObserver(created.sessionId, { clientId: 'browser-a', reason: 'page-close' });

  assert.equal(manager.getPoolSnapshot().sessions[0].observerCount, 0);
  assert.equal(pty.killCalls.length, 0);

  await assert.rejects(async () => manager.closeSession(created.sessionId, { clientId: 'browser-a', reason: 'user-close' }),
    (error) => error.code === 'terminal_session_not_attached',
  );
  assert.equal(pty.killCalls.length, 0);

  manager.attachSession(created.sessionId, { clientId: 'browser-a' });
  await manager.closeSession(created.sessionId, { clientId: 'browser-a', reason: 'user-close' });
  assert.equal(pty.killCalls.length, 1);
});

test('only the active presenter may resize the shared PTY', async () => {
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

  const created = await manager.createSession({ clientId: 'browser-a', cols: 80, rows: 24 });
  pty.emitData('ready');
  manager.attachSession(created.sessionId, { clientId: 'browser-b' });
  manager.setActivePresenter(created.sessionId, { clientId: 'browser-a' });
  manager.resizeSession(created.sessionId, { clientId: 'browser-b', cols: 100, rows: 40 });
  manager.resizeSession(created.sessionId, { clientId: 'browser-a', cols: 132, rows: 36 });

  assert.deepEqual(pty.resizeCalls, [{ cols: 132, rows: 36 }]);
});

test('session manager exposes public observer, input, presenter, and resize methods without requiring internal session access', async () => {
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

  const created = await manager.createSession({
    clientId: 'browser-a',
    socketId: 'socket-a',
    cols: 80,
    rows: 24,
  });
  pty.emitData('ready');
  manager.attachSession(created.sessionId, {
    clientId: 'browser-b',
    socketId: 'socket-b',
  });

  assert.equal(manager.isObserverAttached(created.sessionId, { clientId: 'browser-a', socketId: 'socket-a' }), true);
  assert.equal(manager.isObserverAttached(created.sessionId, { clientId: 'browser-c', socketId: 'socket-c' }), false);

  manager.writeInput(created.sessionId, { clientId: 'browser-b', socketId: 'socket-b', data: 'pwd\n' });
  manager.resizeSession(created.sessionId, { clientId: 'browser-b', socketId: 'socket-b', cols: 100, rows: 30 });
  assert.deepEqual(pty.resizeCalls, []);

  manager.setActivePresenter(created.sessionId, { clientId: 'browser-b', socketId: 'socket-b' });
  manager.resizeSession(created.sessionId, { clientId: 'browser-b', socketId: 'socket-b', cols: 100, rows: 30 });

  assert.deepEqual(pty.writeCalls, ['pwd\n']);
  assert.deepEqual(pty.resizeCalls, [{ cols: 100, rows: 30 }]);
});

test('synchronous PTY spawn failure is stable, audited without raw secrets, and never pooled', async () => {
  const events = [];
  const manager = createTerminalSessionManager({
    ptyFactory() {
      throw new Error('spawn exploded with SECRET_VALUE');
    },
    audit: {
      info(event, meta) { events.push({ level: 'info', event, meta }); },
      warn(event, meta) { events.push({ level: 'warn', event, meta }); },
      error(event, meta) { events.push({ level: 'error', event, meta }); },
    },
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/tmp',
      terminalStartupTimeoutMs: 10000,
    },
  });

  await assert.rejects(async () => manager.createSession({ clientId: 'browser-a' }),
    (error) => error.code === 'pty_spawn_failed' && !error.message.includes('SECRET_VALUE'),
  );
  assert.equal(manager.listSessions().length, 0);
  assert.equal(events.some((entry) => entry.event === 'terminal_pty_spawn_failed'), true);
  assert.equal(JSON.stringify(events).includes('SECRET_VALUE'), false);
});

test('first PTY output marks a starting session ready exactly once and clears its startup timer', async () => {
  let nowMs = Date.parse('2026-07-19T00:00:00.000Z');
  const timers = [];
  const cleared = [];
  const events = [];
  const pty = createFakePty();
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    now: () => new Date(nowMs),
    setTimeout(handler, delay) {
      const timer = { handler, delay };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { cleared.push(timer); },
    audit: {
      info(event, meta) { events.push({ event, meta }); },
      warn() {},
      error() {},
    },
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/tmp',
      terminalStartupTimeoutMs: 10000,
    },
  });

  const created = await manager.createSession({ clientId: 'browser-a' });
  assert.equal(created.status, 'attached');
  assert.equal(created.processStatus, 'starting');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 10000);

  nowMs += 250;
  pty.emitData('prompt$ ');
  pty.emitData('next');

  assert.equal(manager.getPoolSnapshot().sessions[0].processStatus, 'running');
  assert.equal(cleared.length, 1);
  const readyEvents = events.filter((entry) => entry.event === 'terminal_pty_ready');
  assert.equal(readyEvents.length, 1);
  assert.equal(readyEvents[0].meta.startupDurationMs, 250);
});

test('synchronous PTY data during callback registration clears the timer and reaches the creator', async () => {
  const activeTimers = new Set();
  const delivered = [];
  const pty = createFakePty();
  pty.onData = (handler) => handler('instant prompt');
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    outputSchedule: (drain) => drain(),
    setTimeout(handler, delay) {
      const timer = { handler, delay };
      activeTimers.add(timer);
      return timer;
    },
    clearTimeout(timer) { activeTimers.delete(timer); },
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/tmp',
      terminalStartupTimeoutMs: 10000,
    },
  });

  const created = await manager.createSession({
    clientId: 'browser-a',
    onData: (data, metadata) => delivered.push({ data, metadata }),
  });

  assert.equal(created.processStatus, 'running');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].data, 'instant prompt');
  assert.equal(delivered[0].metadata.sessionId, created.sessionId);
  assert.equal(delivered[0].metadata.replaySeq, 1);
  assert.equal(activeTimers.size, 0);
  assert.equal(manager.listSessions().length, 1);
});

test('synchronous PTY exit during callback registration notifies the creator and leaves failed state without a timer', async () => {
  const activeTimers = new Set();
  const exits = [];
  const pty = createFakePty();
  pty.onExit = (handler) => handler({ exitCode: 2, signal: 0 });
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    setTimeout(handler, delay) {
      const timer = { handler, delay };
      activeTimers.add(timer);
      return timer;
    },
    clearTimeout(timer) { activeTimers.delete(timer); },
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/tmp',
      terminalStartupTimeoutMs: 10000,
    },
  });

  const created = await manager.createSession({
    clientId: 'browser-a',
    onExit: (payload) => exits.push(payload),
  });

  assert.equal(created.processStatus, 'failed');
  assert.equal(created.exitCode, 2);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].sessionId, created.sessionId);
  assert.equal(exits[0].processStatus, 'failed');
  assert.equal(activeTimers.size, 0);
  assert.equal(manager.listSessions().length, 1);
});

test('PTY callback registration failure retries one failed kill before removing the session', async () => {
  const activeTimers = new Set();
  const events = [];
  const pty = createFakePty();
  pty.onData = () => { throw new Error('registration SECRET_VALUE'); };
  let killAttempts = 0;
  pty.kill = function kill(signal) {
    this.killCalls.push(signal);
    killAttempts += 1;
    if (killAttempts === 1) {
      throw new Error('registration kill SECRET_VALUE');
    }
    this.emitExit({ exitCode: 0, signal });
  };
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    setTimeout(handler, delay) {
      const timer = { handler, delay };
      activeTimers.add(timer);
      return timer;
    },
    clearTimeout(timer) { activeTimers.delete(timer); },
    audit: {
      info(event, meta) { events.push({ level: 'info', event, meta }); },
      warn(event, meta) { events.push({ level: 'warn', event, meta }); },
      error(event, meta) { events.push({ level: 'error', event, meta }); },
    },
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/tmp',
      terminalStartupTimeoutMs: 10000,
    },
  });

  await assert.rejects(async () => manager.createSession({ clientId: 'browser-a' }),
    (error) => error.code === 'pty_spawn_failed' && !error.message.includes('SECRET_VALUE'),
  );
  assert.equal(manager.listSessions().length, 0);
  assert.equal(activeTimers.size, 0);
  assert.deepEqual(pty.killCalls, ['SIGHUP', 'SIGHUP']);
  assert.equal(events.some((entry) => entry.event === 'terminal_pty_registration_failed'), true);
  const killFailure = events.find((entry) => entry.event === 'terminal_pty_kill_failed');
  assert.equal(killFailure.meta.attemptCount, 1);
  assert.equal(events.some((entry) => entry.event === 'terminal_pty_cleanup_failed'), false);
  assert.equal(JSON.stringify(events).includes('SECRET_VALUE'), false);
});

test('PTY registration cleanup quarantines when asynchronous onExit exceeds a zero wait budget', async (t) => {
  const pty = createAsyncExitPty();
  t.after(() => pty.cancelExitTimer());
  pty.onData = () => { throw new Error('registration SECRET_VALUE'); };
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    ptyKillWaitMs: 0,
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
    },
  });

  await assert.rejects(async () => manager.createSession({ clientId: 'browser-a' }),
    (error) => error.code === 'pty_spawn_failed');
  assert.deepEqual(pty.killCalls, ['SIGHUP', 'SIGTERM', 'SIGKILL']);
  assert.equal(manager._getCleanupPendingCount(), 1);
});

test('PTY registration cleanup awaits asynchronous onExit within the production default wait budget', async (t) => {
  const pty = createAsyncExitPty();
  t.after(() => pty.cancelExitTimer());
  pty.onData = () => { throw new Error('registration SECRET_VALUE'); };
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
    },
  });

  await assert.rejects(async () => manager.createSession({ clientId: 'browser-a' }),
    (error) => error.code === 'pty_spawn_failed');
  assert.deepEqual(pty.killCalls, ['SIGHUP']);
  assert.equal(manager._getCleanupPendingCount(), 0);
  assert.equal(manager.listSessions().length, 0);
});

test('PTY callback registration cleanup stops after two failed kill attempts and audits bounded failure', async () => {
  const events = [];
  const pty = createFakePty();
  pty.onData = () => { throw new Error('registration SECRET_VALUE'); };
  pty.kill = function kill(signal) {
    this.killCalls.push(signal);
    throw new Error('cleanup SECRET_VALUE');
  };
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    audit: {
      info(event, meta) { events.push({ level: 'info', event, meta }); },
      warn(event, meta) { events.push({ level: 'warn', event, meta }); },
      error(event, meta) { events.push({ level: 'error', event, meta }); },
    },
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/tmp',
      terminalStartupTimeoutMs: 10000,
    },
  });

  await assert.rejects(async () => manager.createSession({ clientId: 'browser-a' }),
    (error) => error.code === 'pty_spawn_failed',
  );
  assert.deepEqual(pty.killCalls, ['SIGHUP', 'SIGHUP']);
  assert.equal(manager.listSessions().length, 0);
  const cleanupFailure = events.find((entry) => entry.event === 'terminal_pty_cleanup_failed');
  assert.equal(cleanupFailure.meta.attemptCount, 2);
  assert.equal(JSON.stringify(events).includes('SECRET_VALUE'), false);
});

test('failed registration cleanup is quarantined and one scheduled retry restores capacity', async () => {
  const timers = [];
  const pty = createFakePty();
  pty.onData = () => { throw new Error('registration SECRET_VALUE'); };
  let cleanupCanSucceed = false;
  pty.kill = function kill(signal) {
    this.killCalls.push(signal);
    if (!cleanupCanSucceed) {
      throw new Error('cleanup SECRET_VALUE');
    }
    this.emitExit({ exitCode: 0, signal });
  };
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    setTimeout(handler, delay) {
      const timer = {
        handler,
        delay,
        cancelled: false,
        unrefCalled: false,
        unref() { this.unrefCalled = true; },
      };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cancelled = true; },
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalMaxSessions: 2,
      terminalStartupTimeoutMs: 10000,
    },
  });

  await assert.rejects(async () => manager.createSession({ clientId: 'browser-a' }),
    (error) => error.code === 'pty_spawn_failed',
  );
  const cleanupTimers = timers.filter((timer) => timer.delay === 1000);
  assert.equal(manager.listSessions().length, 0);
  assert.equal(manager._getCleanupPendingCount(), 1);
  assert.deepEqual(manager.getPoolSnapshot().capacity, {
    sessionCount: 0,
    cleanupPendingCount: 1,
    maxSessions: 2,
    availableSessions: 1,
    replayBufferBytesPerSession: 262144,
    maxReplayBytes: 524288,
  });
  assert.equal(cleanupTimers.length, 1);
  assert.equal(cleanupTimers[0].unrefCalled, true);

  cleanupCanSucceed = true;
  await cleanupTimers[0].handler();

  assert.equal(manager._getCleanupPendingCount(), 0);
  assert.equal(manager.getPoolSnapshot().capacity.availableSessions, 2);
  assert.equal(timers.filter((timer) => timer.delay === 1000).length, 1);
  assert.deepEqual(pty.killCalls, ['SIGHUP', 'SIGHUP', 'SIGHUP']);
});

test('failed scheduled quarantine cleanup retries with bounded backoff until capacity is restored', async () => {
  const timers = [];
  const pty = createFakePty();
  pty.onData = () => { throw new Error('registration SECRET_VALUE'); };
  let cleanupCanSucceed = false;
  let ptyFactoryCalls = 0;
  pty.kill = function kill(signal) {
    this.killCalls.push(signal);
    if (!cleanupCanSucceed) {
      throw new Error('cleanup SECRET_VALUE');
    }
    this.emitExit({ exitCode: 0, signal });
  };
  const manager = createTerminalSessionManager({
    ptyFactory() {
      ptyFactoryCalls += 1;
      return ptyFactoryCalls === 1 ? pty : createFakePty();
    },
    setTimeout(handler, delay) {
      const timer = { handler, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout() {},
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalMaxSessions: 1,
      terminalStartupTimeoutMs: 10000,
    },
  });

  await assert.rejects(async () => manager.createSession({ clientId: 'browser-a' }),
    (error) => error.code === 'pty_spawn_failed',
  );
  const cleanupTimer = timers.find((timer) => timer.delay === 1000);
  await cleanupTimer.handler();

  assert.equal(manager._getCleanupPendingCount(), 1);
  assert.equal(manager.getPoolSnapshot().capacity.availableSessions, 0);
  assert.equal(timers.filter((timer) => timer.delay === 1000).length, 1);
  assert.equal(timers.filter((timer) => timer.delay === 2000).length, 1);
  assert.deepEqual(pty.killCalls, ['SIGHUP', 'SIGHUP', 'SIGHUP', 'SIGHUP']);

  cleanupCanSucceed = true;
  await timers.find((timer) => timer.delay === 2000).handler();

  assert.equal(manager._getCleanupPendingCount(), 0);
  assert.equal(manager.getPoolSnapshot().capacity.availableSessions, 1);
  assert.deepEqual(pty.killCalls, ['SIGHUP', 'SIGHUP', 'SIGHUP', 'SIGHUP', 'SIGHUP']);
  const created = await manager.createSession({ clientId: 'browser-b' });
  assert.ok(created.sessionId);
  assert.equal(manager.listSessions().length, 1);
});

test('PTY startup timeout fails once, kills once, notifies once, and retains replayable session state', async () => {
  let startupHandler;
  const pty = createFakePty();
  const errors = [];
  const exits = [];
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    setTimeout(handler) { startupHandler = handler; return { id: 1 }; },
    clearTimeout() {},
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/tmp',
      terminalStartupTimeoutMs: 1000,
    },
  });

  const created = await manager.createSession({
    clientId: 'browser-a',
    onError: (error) => errors.push(error),
    onExit: (payload) => exits.push(payload),
  });
  startupHandler();
  pty.emitExit({ exitCode: 1, signal: 1 });
  pty.emitExit({ exitCode: 1, signal: 1 });

  const retained = manager.attachSession(created.sessionId, { clientId: 'browser-b' });
  assert.equal(retained.processStatus, 'failed');
  assert.equal(manager.listSessions().length, 1);
  assert.deepEqual(pty.killCalls, ['SIGHUP']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'pty_startup_timeout');
  assert.equal(exits.length, 1);
  await manager.closeSession(created.sessionId, { clientId: 'browser-a', reason: 'user-close' });
  assert.deepEqual(pty.killCalls, ['SIGHUP']);
  await assert.rejects(async () => manager.closeSession(created.sessionId, { reason: 'repeat-close' }),
    (error) => error.code === 'terminal_session_not_found',
  );
  assert.deepEqual(pty.killCalls, ['SIGHUP']);
});

test('PTY startup timeout kill failure is retried successfully by close before pool removal', async () => {
  let startupHandler;
  const events = [];
  const errors = [];
  const exits = [];
  const pty = createFakePty();
  let killAttempts = 0;
  pty.kill = function kill(signal) {
    this.killCalls.push(signal);
    killAttempts += 1;
    if (killAttempts <= 2) {
      throw new Error('kill SECRET_VALUE');
    }
    this.emitExit({ exitCode: 0, signal });
  };
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    setTimeout(handler) { startupHandler = handler; return { id: 1 }; },
    clearTimeout() {},
    audit: {
      info(event, meta) { events.push({ level: 'info', event, meta }); },
      warn(event, meta) { events.push({ level: 'warn', event, meta }); },
      error(event, meta) { events.push({ level: 'error', event, meta }); },
    },
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/tmp',
      terminalStartupTimeoutMs: 1000,
    },
  });
  const created = await manager.createSession({
    clientId: 'browser-a',
    onError: (error) => errors.push(error),
    onExit: (payload) => exits.push(payload),
  });

  assert.doesNotThrow(() => startupHandler());
  assert.equal(manager._getSession(created.sessionId).processStatus, 'failed');
  assert.equal(manager.listSessions().length, 1);
  assert.deepEqual(pty.killCalls, ['SIGHUP']);
  assert.equal(errors.length, 1);
  assert.equal(exits.length, 1);
  assert.equal(events.some((entry) => entry.event === 'terminal_pty_kill_failed'), true);
  assert.equal(JSON.stringify(events).includes('SECRET_VALUE'), false);
  await assert.doesNotReject(async () => manager.closeSession(created.sessionId, { clientId: 'browser-a', reason: 'user-close' }));
  assert.deepEqual(pty.killCalls, ['SIGHUP', 'SIGHUP', 'SIGHUP']);
  assert.equal(manager.listSessions().length, 0);
  assert.equal(errors.length, 1);
  assert.equal(exits.length, 1);
});

for (const terminalState of ['running', 'exited']) {
  test(`explicit close retains ${terminalState} session after two failed kills and a later close retries`, async () => {
    const activeTimers = new Set();
    const events = [];
    const pty = createFakePty();
    let killAttempts = 0;
    pty.kill = function kill(signal) {
      this.killCalls.push(signal);
      killAttempts += 1;
      if (killAttempts <= 2) {
        throw new Error('close kill SECRET_VALUE');
      }
      this.emitExit({ exitCode: 0, signal });
    };
    const manager = createTerminalSessionManager({
      ptyFactory: () => pty,
      setTimeout(handler, delay) {
        const timer = { handler, delay };
        activeTimers.add(timer);
        return timer;
      },
      clearTimeout(timer) { activeTimers.delete(timer); },
      audit: {
        info(event, meta) { events.push({ level: 'info', event, meta }); },
        warn(event, meta) { events.push({ level: 'warn', event, meta }); },
        error(event, meta) { events.push({ level: 'error', event, meta }); },
      },
      logger: { warn() {}, info() {}, error() {} },
      config: {
        enableTerminal: true,
        terminalAdminPassword: 'test-terminal-admin-password',
        terminalShell: '/bin/zsh',
        terminalCwd: '/tmp',
        terminalStartupTimeoutMs: 10000,
      },
    });
    const created = await manager.createSession({ clientId: 'browser-a' });
    const session = manager._getSession(created.sessionId);
    pty.emitData('ready');
    if (terminalState === 'exited') {
      pty.emitExit({ exitCode: 0, signal: 0 });
    }

    if (terminalState === 'exited') {
      // Exit already observed: cleanup confirms without signaling and removes the session.
      await assert.doesNotReject(async () => manager.closeSession(created.sessionId, {
        clientId: 'browser-a',
        reason: 'user-close',
      }));
      assert.equal(session.processStatus, 'closed');
      assert.equal(session.status, 'detached');
      assert.equal(session.observers.size, 0);
      assert.equal(manager.listSessions().length, 0);
      assert.deepEqual(pty.killCalls, []);
      await assert.rejects(async () => manager.closeSession(created.sessionId, { reason: 'repeat-close' }),
        (error) => error.code === 'terminal_session_not_found',
      );
      return;
    }

    await assert.rejects(async () => manager.closeSession(created.sessionId, { clientId: 'browser-a', reason: 'user-close' }),
      (error) => error.code === 'pty_cleanup_failed' && !error.message.includes('SECRET_VALUE'),
    );
    assert.equal(session.processStatus, 'closed');
    assert.equal(session.status, 'attached');
    assert.equal(session.observers.size, 1);
    assert.equal(activeTimers.size, 0);
    assert.equal(manager.listSessions().length, 1);
    assert.deepEqual(pty.killCalls, ['SIGHUP', 'SIGHUP']);
    assert.equal(events.some((entry) => entry.event === 'terminal_pty_kill_failed'), true);
    assert.equal(JSON.stringify(events).includes('SECRET_VALUE'), false);

    await assert.doesNotReject(async () => manager.closeSession(created.sessionId, { clientId: 'browser-a', reason: 'retry-close' }));
    assert.equal(session.status, 'detached');
    assert.equal(session.observers.size, 0);
    assert.equal(manager.listSessions().length, 0);
    assert.deepEqual(pty.killCalls, ['SIGHUP', 'SIGHUP', 'SIGHUP']);
    await assert.rejects(async () => manager.closeSession(created.sessionId, { reason: 'repeat-close' }),
      (error) => error.code === 'terminal_session_not_found',
    );
    assert.deepEqual(pty.killCalls, ['SIGHUP', 'SIGHUP', 'SIGHUP']);
  });
}

test('PTY exit is processed once and exited sessions reject write and resize without touching the PTY', async () => {
  const pty = createFakePty();
  const exits = [];
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/tmp',
      terminalStartupTimeoutMs: 10000,
    },
  });
  const created = await manager.createSession({ clientId: 'browser-a', onExit: (payload) => exits.push(payload) });
  pty.emitData('ready');
  pty.emitExit({ exitCode: 7, signal: 0 });
  pty.emitExit({ exitCode: 9, signal: 1 });

  assert.throws(
    () => manager.writeInput(created.sessionId, { clientId: 'browser-a', data: 'nope' }),
    (error) => error.code === 'pty_exited',
  );
  assert.throws(
    () => manager.resizeSession(created.sessionId, { clientId: 'browser-a', cols: 100, rows: 30 }),
    (error) => error.code === 'pty_exited',
  );
  assert.deepEqual(pty.writeCalls, []);
  assert.deepEqual(pty.resizeCalls, []);
  assert.equal(exits.length, 1);
  assert.equal(manager.getPoolSnapshot().sessions[0].status, 'attached');
  assert.equal(manager.getPoolSnapshot().sessions[0].processStatus, 'exited');
  assert.equal(manager._getSession(created.sessionId).exitCode, 7);
});

test('terminal session manager emits structured create, attach, and detach audit events', async () => {
  const events = [];
  const pty = createFakePty();
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    logger: { warn() {}, info() {}, error() {} },
    audit: {
      info(event, meta = {}) {
        events.push({ level: 'info', event, meta });
      },
      warn(event, meta = {}) {
        events.push({ level: 'warn', event, meta });
      },
      error(event, meta = {}) {
        events.push({ level: 'error', event, meta });
      },
    },
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

  const created = await manager.createSession({
    clientId: 'browser-a',
    socketId: 'socket-a',
    cols: 100,
    rows: 30,
  });
  manager.attachSession(created.sessionId, {
    clientId: 'browser-b',
    socketId: 'socket-b',
  });
  manager.detachObserver(created.sessionId, {
    clientId: 'browser-b',
    socketId: 'socket-b',
    reason: 'manual-detach',
  });

  assert.deepEqual(events.slice(0, 3).map((entry) => entry.event), [
    'terminal_session_created',
    'terminal_session_attached',
    'terminal_session_detached',
  ]);
  assert.equal(events[0].meta.ioRecording, false);
  assert.equal(events[0].meta.clientId, 'browser-a');
  assert.equal(events[1].meta.clientId, 'browser-b');
  assert.equal(events[2].meta.reason, 'manual-detach');
});

test('detachObserver by socketId removes Socket.IO and webrtc observers sharing that socket', async () => {
  const pty = createFakePty();
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/tmp',
      terminalIdleTimeoutMs: 0,
      terminalStartupTimeoutMs: 10000,
      terminalRecordIo: false,
    },
  });

  const created = await manager.createSession({
    clientId: 'browser-a',
    socketId: 'sock-1',
  });
  manager.attachSession(created.sessionId, {
    clientId: 'browser-a',
    socketId: 'sock-1',
    observerId: 'webrtc:sock-1',
  });

  const session = manager._getSession(created.sessionId);
  assert.equal(session.observers.size, 2);
  assert.equal(manager.isObserverAttached(created.sessionId, { socketId: 'sock-1' }), true);

  manager.detachObserver(created.sessionId, {
    socketId: 'sock-1',
    reason: 'socket-disconnect',
  });

  assert.equal(session.observers.size, 0);
  assert.equal(manager.isObserverAttached(created.sessionId, { socketId: 'sock-1' }), false);
  assert.equal(manager.getPoolSnapshot().sessions[0].status, 'detached');
});

test('handleSocketDisconnect by socketId clears both Socket.IO and webrtc observers', async () => {
  const pty = createFakePty();
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/tmp',
      terminalIdleTimeoutMs: 0,
      terminalStartupTimeoutMs: 10000,
      terminalRecordIo: false,
    },
  });

  const created = await manager.createSession({
    clientId: 'browser-a',
    socketId: 'sock-1',
  });
  manager.attachSession(created.sessionId, {
    clientId: 'browser-a',
    socketId: 'sock-1',
    observerId: 'webrtc:sock-1',
  });

  const result = manager.handleSocketDisconnect({
    clientId: 'browser-a',
    socketId: 'sock-1',
    reason: 'socket-disconnect',
  });

  assert.deepEqual(result.affectedSessionIds, [created.sessionId]);
  assert.equal(manager._getSession(created.sessionId).observers.size, 0);
});

test('buildTerminalEnv compatibility export uses the secure environment allowlist', () => {
  const env = buildTerminalEnv({
    HOME: '/Users/tester',
    USER: 'tester',
    LC_CTYPE: 'UTF-8',
    PATH: '/untrusted/bin:/usr/local/bin:/usr/bin:/bin',
    JWT_SECRET: 'jwt-secret',
  });

  const entries = env.PATH.split(':');
  assert.deepEqual(entries, [
    path.dirname(process.execPath),
    '/Users/tester/.homebrew/bin',
    '/Users/tester/.homebrew/sbin',
    '/Users/tester/.homebrew/opt/python@3.11/libexec/bin',
    '/Users/tester/.local/bin',
    '/Users/tester/.bun/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ]);
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.LC_CTYPE, 'UTF-8');
  assert.equal(env.JWT_SECRET, undefined);
});

test('session manager passes isolated environment, shell args, and canonical config into the pty factory', async () => {
  const spawnCalls = [];
  const previousEnv = { ...process.env };
  process.env.HOME = '/Users/tester';
  process.env.PATH = '/untrusted/bin:/usr/local/bin:/usr/bin:/bin';
  process.env.LC_CTYPE = 'UTF-8';
  process.env.JWT_SECRET = 'jwt-secret';
  process.env.WRD_TERMINAL_ADMIN_PASSWORD = 'terminal-password';
  process.env.HTTPS_PROXY = 'http://proxy.test';
  process.env.ANTHROPIC_AUTH_TOKEN = 'anthropic-token';
  try {
    const manager = createTerminalSessionManager({
      ptyFactory: (shell, args, options) => {
        spawnCalls.push({ shell, args, options });
        return createFakePty();
      },
      logger: { warn() {}, info() {}, error() {} },
      config: {
        enabled: true,
        adminPassword: 'test-terminal-admin-password',
        shell: '/bin/zsh',
        cwd: '/tmp',
        pathEntries: ['/opt/wrd-tools'],
        recordIoMetadata: false,
      },
    });

    await manager.createSession({ clientId: 'browser-a', cols: 80, rows: 24 });
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].shell, '/bin/zsh');
  assert.deepEqual(spawnCalls[0].args, ['-f', '-i']);
  assert.equal(spawnCalls[0].options.name, 'xterm-256color');
  assert.equal(spawnCalls[0].options.cwd, '/tmp');
  assert.equal(spawnCalls[0].options.env.TERM, 'xterm-256color');
  assert.equal(spawnCalls[0].options.env.LC_CTYPE, 'UTF-8');
  assert.equal(spawnCalls[0].options.env.JWT_SECRET, undefined);
  assert.equal(spawnCalls[0].options.env.WRD_TERMINAL_ADMIN_PASSWORD, undefined);
  assert.equal(spawnCalls[0].options.env.HTTPS_PROXY, undefined);
  assert.equal(spawnCalls[0].options.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.deepEqual(spawnCalls[0].options.env.PATH.split(path.delimiter), [
    path.dirname(process.execPath),
    '/Users/tester/.homebrew/bin',
    '/Users/tester/.homebrew/sbin',
    '/Users/tester/.homebrew/opt/python@3.11/libexec/bin',
    '/Users/tester/.local/bin',
    '/Users/tester/.bun/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/opt/wrd-tools',
  ]);
});

test('session manager carries the legacy terminalPathEntries alias into the PTY environment', async () => {
  let spawnedEnvironment;
  const manager = createTerminalSessionManager({
    ptyFactory: (shell, args, options) => {
      spawnedEnvironment = options.env;
      return createFakePty();
    },
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/bash',
      terminalPathEntries: ['/opt/legacy-tools'],
      terminalRecordIoMetadata: false,
    },
  });

  await manager.createSession({ clientId: 'browser-a' });

  assert.equal(spawnedEnvironment.PATH.split(path.delimiter).at(-1), '/opt/legacy-tools');
});

test('session manager rate limits each attached observer by UTF-8 bytes and refills without detaching', async () => {
  let nowMs = 0;
  const pty = createFakePty();
  const auditEvents = [];
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    now: () => new Date(nowMs),
    outputSchedule: (drain) => drain(),
    audit: {
      info(event, meta) { auditEvents.push({ level: 'info', event, meta }); },
      warn(event, meta) { auditEvents.push({ level: 'warn', event, meta }); },
      error(event, meta) { auditEvents.push({ level: 'error', event, meta }); },
    },
    config: {
      enabled: true,
      adminPassword: 'test-terminal-admin-password',
      inputRate: { bytesPerSecond: 10, burstBytes: 10 },
    },
  });
  const created = await manager.createSession({ clientId: 'browser-a', socketId: 'socket-a' });
  pty.emitData('ready');

  manager.writeInput(created.sessionId, {
    clientId: 'browser-a',
    socketId: 'socket-a',
    data: '\u4f60\u4f60\u4f60x',
  });
  assert.throws(
    () => manager.writeInput(created.sessionId, {
      clientId: 'browser-a',
      socketId: 'socket-a',
      data: 'SECRET_INPUT',
    }),
    (error) => {
      assert.equal(error.code, 'terminal_input_rate_limited');
      assert.deepEqual(error.details, {
        retryAfterMs: 1200,
        remainingBytes: 0,
        bytes: 12,
      });
      return true;
    },
  );
  assert.deepEqual(pty.writeCalls, ['\u4f60\u4f60\u4f60x']);
  assert.equal(manager.isObserverAttached(created.sessionId, { socketId: 'socket-a' }), true);

  const rateAudit = auditEvents.find((entry) => entry.event === 'terminal_input_rate_limited');
  assert.deepEqual(rateAudit.meta, {
    sessionId: created.sessionId,
    clientId: 'browser-a',
    socketId: 'socket-a',
    code: 'terminal_input_rate_limited',
    retryAfterMs: 1200,
    remainingBytes: 0,
    bytes: 12,
  });
  assert.equal(JSON.stringify(rateAudit).includes('SECRET_INPUT'), false);

  nowMs = 1200;
  manager.writeInput(created.sessionId, {
    clientId: 'browser-a',
    socketId: 'socket-a',
    data: 'accepted',
  });
  assert.deepEqual(pty.writeCalls, ['\u4f60\u4f60\u4f60x', 'accepted']);
});

test('session manager accepts legacy input-rate aliases and retains the bucket while attached', async () => {
  const pty = createFakePty();
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    now: () => new Date(0),
    outputSchedule: (drain) => drain(),
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalInputBytesPerSecond: 2,
      terminalInputBurstBytes: 2,
    },
  });
  const created = await manager.createSession({ clientId: 'browser-a', socketId: 'socket-a' });
  pty.emitData('ready');
  manager.writeInput(created.sessionId, { clientId: 'browser-a', socketId: 'socket-a', data: 'a' });
  manager.attachSession(created.sessionId, { clientId: 'browser-a', socketId: 'socket-a' });
  manager.writeInput(created.sessionId, { clientId: 'browser-a', socketId: 'socket-a', data: 'b' });

  assert.throws(
    () => manager.writeInput(created.sessionId, {
      clientId: 'browser-a', socketId: 'socket-a', data: 'c',
    }),
    (error) => error.code === 'terminal_input_rate_limited',
  );
});

test('session manager pipes terminalMaxInFlight* config into the output dispatcher window', async () => {
  const pty = createFakePty();
  const scheduled = [];
  const delivered = [];
  const acks = [];
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    outputSchedule: (drain) => scheduled.push(drain),
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enabled: true,
      adminPassword: 'test-terminal-admin-password',
      terminalMaxInFlightChunks: 7,
      terminalMaxInFlightBytes: 4096,
    },
  });
  await manager.createSession({
    clientId: 'browser-a',
    socketId: 'socket-a',
    onData(data, _metadata, acknowledge) {
      delivered.push(data);
      acks.push(acknowledge);
    },
  });

  for (let i = 0; i < 8; i += 1) {
    pty.emitData(String(i));
  }
  while (scheduled.length > 0) scheduled.shift()();

  assert.deepEqual(delivered, ['0', '1', '2', '3', '4', '5', '6']);
  assert.equal(acks.length, 7);

  acks[0]();
  while (scheduled.length > 0) scheduled.shift()();
  assert.deepEqual(delivered, ['0', '1', '2', '3', '4', '5', '6', '7']);
  assert.equal(acks.length, 8);
});

test('session manager detaches only an overflowing observer after replaying the full chunk', async () => {
  const pty = createFakePty();
  const scheduled = [];
  const slowWarnings = [];
  const fastOutput = [];
  const auditEvents = [];
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    outputSchedule: (drain) => scheduled.push(drain),
    audit: {
      info(event, meta) { auditEvents.push({ level: 'info', event, meta }); },
      warn(event, meta) { auditEvents.push({ level: 'warn', event, meta }); },
      error(event, meta) { auditEvents.push({ level: 'error', event, meta }); },
    },
    config: {
      enabled: true,
      adminPassword: 'test-terminal-admin-password',
      maxObserverQueueBytes: 5,
      replayBufferBytes: 64,
    },
  });
  const created = await manager.createSession({
    clientId: 'slow-client',
    socketId: 'slow-socket',
    onWarning: (warning) => slowWarnings.push(warning),
  });
  pty.emitData('12345');
  manager.attachSession(created.sessionId, {
    clientId: 'fast-client',
    socketId: 'fast-socket',
    onData: (data) => fastOutput.push(data),
  });

  pty.emitData('x');

  assert.equal(manager.isObserverAttached(created.sessionId, { socketId: 'slow-socket' }), false);
  assert.equal(manager.isObserverAttached(created.sessionId, { socketId: 'fast-socket' }), true);
  assert.deepEqual(pty.killCalls, []);
  assert.deepEqual(slowWarnings, [{
    code: 'terminal_output_backpressure',
    stats: { queuedBytes: 5, droppedChunks: 1 },
  }]);
  const overflowAudit = auditEvents.find((entry) => entry.event === 'terminal_output_backpressure');
  assert.deepEqual(overflowAudit.meta, {
    sessionId: created.sessionId,
    clientId: 'slow-client',
    socketId: 'slow-socket',
    code: 'terminal_output_backpressure',
    queuedBytes: 5,
    droppedChunks: 1,
  });
  assert.equal(JSON.stringify(overflowAudit).includes('12345'), false);
  assert.equal(JSON.stringify(slowWarnings).includes('12345'), false);

  while (scheduled.length > 0) scheduled.shift()();
  assert.deepEqual(fastOutput, ['x']);
  assert.equal(manager.getPresence(created.sessionId).observerCount, 1);

  const reattached = manager.attachSession(created.sessionId, {
    clientId: 'slow-client',
    socketId: 'slow-socket',
  });
  assert.deepEqual(reattached.replay.map((entry) => entry.data), ['12345', 'x']);
  assert.equal(manager.isObserverAttached(created.sessionId, { socketId: 'slow-socket' }), true);
  manager.writeInput(created.sessionId, {
    clientId: 'slow-client',
    socketId: 'slow-socket',
    data: 'fresh',
  });
  assert.deepEqual(pty.writeCalls, ['fresh']);
});

test('createSession rejects out-of-range cols/rows before pty spawn', async () => {
  let spawned = 0;
  const manager = createTerminalSessionManager({
    config: { enabled: true, adminPassword: 'test-admin' },
    ptyFactory() {
      spawned += 1;
      throw new Error('should not spawn');
    },
    logger: { warn() {}, info() {}, error() {} },
  });
  await assert.rejects(async () => manager.createSession({ cols: 999999, rows: 24, clientId: 'c', socketId: 's' }),
    (err) => err.code === 'terminal_invalid_size',
  );
  assert.equal(spawned, 0);
});

test('attachSession rejects invalid size before adding observer', async () => {
  const ptys = [];
  const manager = createTerminalSessionManager({
    config: { enabled: true, adminPassword: 'test-admin' },
    ptyFactory() {
      const pty = createFakePty();
      ptys.push(pty);
      return pty;
    },
    logger: { warn() {}, info() {}, error() {} },
  });
  const created = await manager.createSession({ clientId: 'creator', socketId: 'sock-creator', cols: 80, rows: 24 });
  ptys[0].emitData('ready');
  assert.throws(
    () => manager.attachSession(created.sessionId, {
      clientId: 'other',
      socketId: 'sock-other',
      cols: 99999,
      rows: 1,
    }),
    (err) => err.code === 'terminal_invalid_size',
  );
  assert.equal(manager.isObserverAttached(created.sessionId, { socketId: 'sock-other' }), false);
  assert.equal(manager.getPresence(created.sessionId).observerCount, 1);
});

test('resizeSession rejects out-of-range geometry', async () => {
  const ptys = [];
  const manager = createTerminalSessionManager({
    config: { enabled: true, adminPassword: 'test-admin' },
    ptyFactory() {
      const pty = createFakePty();
      ptys.push(pty);
      return pty;
    },
    logger: { warn() {}, info() {}, error() {} },
  });
  const created = await manager.createSession({ clientId: 'c1', socketId: 's1', cols: 80, rows: 24 });
  ptys[0].emitData('ready');
  assert.throws(
    () => manager.resizeSession(created.sessionId, {
      clientId: 'c1',
      socketId: 's1',
      cols: 99999,
      rows: 24,
    }),
    (err) => err.code === 'terminal_invalid_size',
  );
  assert.deepEqual(ptys[0].resizeCalls, []);
});

test('closeAllAsSystem harvests all sessions and reports empty failures on success', async () => {
  const ptys = [];
  const manager = createTerminalSessionManager({
    ptyFactory: () => {
      const pty = createFakePty();
      ptys.push(pty);
      return pty;
    },
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalMaxSessions: 4,
    },
  });

  const first = await manager.createSession({ clientId: 'browser-a' });
  const second = await manager.createSession({ clientId: 'browser-b' });
  const summary = await manager.closeAllAsSystem('system:shutdown');

  assert.deepEqual(summary.closedSessionIds.sort(), [first.sessionId, second.sessionId].sort());
  assert.deepEqual(summary.failures, []);
  assert.equal(summary.reason, 'system:shutdown');
  assert.equal(manager.listSessions().length, 0);
  assert.deepEqual(ptys[0].killCalls, ['SIGHUP']);
  assert.deepEqual(ptys[1].killCalls, ['SIGHUP']);
});

test('closeAllAsSystem is idempotent and continues after a failed session cleanup', async () => {
  const events = [];
  const failedPty = createFakePty();
  failedPty.kill = function kill(signal) {
    this.killCalls.push(signal);
    throw new Error('shutdown SECRET_VALUE');
  };
  const okPty = createFakePty();
  const ptys = [failedPty, okPty];
  const manager = createTerminalSessionManager({
    ptyFactory: () => ptys.shift(),
    audit: {
      info(event, meta) { events.push({ level: 'info', event, meta }); },
      warn(event, meta) { events.push({ level: 'warn', event, meta }); },
      error(event, meta) { events.push({ level: 'error', event, meta }); },
    },
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalMaxSessions: 4,
    },
  });

  const failed = await manager.createSession({ clientId: 'browser-a' });
  const ok = await manager.createSession({ clientId: 'browser-b' });
  const summary = await manager.closeAllAsSystem('system:shutdown');

  assert.deepEqual(summary.closedSessionIds, [ok.sessionId]);
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.failures[0].sessionId, failed.sessionId);
  assert.equal(summary.failures[0].code, 'pty_cleanup_failed');
  assert.equal(manager.listSessions().map((s) => s.sessionId).join(','), failed.sessionId);
  assert.equal(JSON.stringify(summary).includes('SECRET_VALUE'), false);

  const again = await manager.closeAllAsSystem('system:shutdown');
  assert.deepEqual(again.closedSessionIds, []);
  assert.equal(again.failures.length, 1);
  assert.equal(again.failures[0].sessionId, failed.sessionId);
});

test('cleanup escalates signals through session close when exit is delayed until SIGKILL', async () => {
  const signals = [];
  const pty = createFakePty();
  pty.kill = function kill(signal) {
    signals.push(signal);
    this.killCalls.push(signal);
    if (signal === 'SIGKILL') {
      this.emitExit({ exitCode: 0, signal });
    }
  };
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    ptyKillWaitMs: 0,
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
    },
  });
  const created = await manager.createSession({ clientId: 'browser-a' });
  await manager.closeSession(created.sessionId, { clientId: 'browser-a', reason: 'user-close' });
  assert.deepEqual(signals, ['SIGHUP', 'SIGTERM', 'SIGKILL']);
  assert.equal(manager.listSessions().length, 0);
});
