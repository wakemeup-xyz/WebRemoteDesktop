const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

process.env.JWT_SECRET = process.env.JWT_SECRET || '12345678';
process.env.VIEWER_ACCESS_PASSWORD = process.env.VIEWER_ACCESS_PASSWORD || 'test-viewer-password';
process.env.HOST_SHARED_SECRET = process.env.HOST_SHARED_SECRET || 'test-host-secret';

const { signAccessToken } = require('../lib/auth');
const { TerminalMetrics } = require('../lib/terminal/metrics');
const { createTerminalSessionManager } = require('../lib/terminal/session-manager');
const { setupTerminal } = require('./terminal');

class FakeSocket extends EventEmitter {
  constructor(id, tokenRole = 'admin', role = tokenRole, clientId = `${id}-client`) {
    super();
    this.id = id;
    this.handshake = {
      auth: {
        token: signAccessToken(tokenRole, `${id}-${tokenRole}`),
        role,
        clientId,
      },
      address: '127.0.0.1',
      headers: { 'user-agent': 'test-agent' },
    };
    this.sent = [];
    this.autoAcknowledgeOutput = true;
    this.conn = {
      transport: { name: 'websocket' },
      on() {},
    };
  }

  emit(event, data, acknowledge) {
    this.sent.push({ event, data, acknowledge });
    if (
      event === 'terminal:output'
      && this.autoAcknowledgeOutput
      && typeof acknowledge === 'function'
    ) {
      acknowledge();
    }
    return true;
  }

  trigger(event, data) {
    return super.emit(event, data);
  }
}

function createFakePty() {
  const handlers = { data: [], exit: [] };
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
    emitExit(payload) {
      handlers.exit.forEach((handler) => handler(payload));
    },
  };
}

function makeIo() {
  const namespaces = new Map();
  return {
    of(name) {
      if (!namespaces.has(name)) {
        const connectedSockets = [];
        const namespace = {
          middleware: null,
          connectionHandler: null,
          use(handler) {
            this.middleware = handler;
          },
          on(event, handler) {
            if (event === 'connection') {
              this.connectionHandler = handler;
            }
          },
          emit(event, data) {
            connectedSockets.forEach((socket) => socket.emit(event, data));
            return true;
          },
          connect(socket) {
            if (this.middleware) {
              let middlewareError = null;
              this.middleware(socket, (err) => {
                middlewareError = err || null;
              });
              if (middlewareError) {
                throw middlewareError;
              }
            }
            connectedSockets.push(socket);
            socket.broadcast = {
              emit(event, data) {
                connectedSockets
                  .filter((connectedSocket) => connectedSocket !== socket)
                  .forEach((connectedSocket) => connectedSocket.emit(event, data));
                return true;
              },
            };
            if (this.connectionHandler) {
              this.connectionHandler(socket);
            }
            return socket;
          },
        };
        namespaces.set(name, namespace);
      }
      return namespaces.get(name);
    },
  };
}

function buildTerminalHarness(configOverrides = {}, harnessOptions = {}) {
  const io = makeIo();
  const ptyBySessionId = new Map();
  const auditEvents = [];
  const audit = {
    info(event, meta = {}) {
      auditEvents.push({ level: 'info', event, meta });
    },
    warn(event, meta = {}) {
      auditEvents.push({ level: 'warn', event, meta });
    },
    error(event, meta = {}) {
      auditEvents.push({ level: 'error', event, meta });
    },
  };
  const ptyFactory = harnessOptions.ptyFactory || (() => {
    const pty = createFakePty();
    return pty;
  });
  const sessionManager = createTerminalSessionManager({
    metrics: harnessOptions.metrics,
    ptyFactory: (...args) => ptyFactory(...args),
    logger: { info() {}, warn() {}, error() {} },
    audit,
    now: harnessOptions.now,
    outputSchedule: harnessOptions.outputSchedule || ((drain) => drain()),
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/tmp',
      terminalSoftWarnSessionCount: 1,
      terminalIdleTimeoutMs: 0,
      terminalStartupTimeoutMs: 10000,
      terminalRecordIo: false,
      terminalReplayBufferBytes: 64,
      terminalMaxSessions: 8,
      ...configOverrides,
    },
  });
  const originalCreateSession = sessionManager.createSession;
  sessionManager.createSession = (input) => {
    const created = originalCreateSession(input);
    ptyBySessionId.set(created.sessionId, sessionManager._getSession(created.sessionId).pty);
    return created;
  };

  setupTerminal(io, {
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalSoftWarnSessionCount: 1,
    },
    sessionManager,
    metrics: harnessOptions.metrics,
    audit,
    logger: { info() {}, warn() {}, error() {} },
  });

  return {
    namespace: io.of('/terminal'),
    sessionManager,
    auditEvents,
    metrics: harnessOptions.metrics,
    getPty(sessionId) {
      return ptyBySessionId.get(sessionId);
    },
  };
}

test('terminal namespace accepts admin and rejects viewer tokens', () => {
  const { namespace } = buildTerminalHarness();
  const admin = namespace.connect(new FakeSocket('admin-1', 'admin'));
  assert.equal(admin.sent[0].event, 'terminal:pool_snapshot');
  assert.equal(admin.sent.some((message) => message.event === 'terminal:snapshot'), true);

  const viewer = new FakeSocket('viewer-1', 'viewer');
  assert.throws(() => namespace.connect(viewer), /Admin role required/);
});

test('terminal namespace broadcasts shared session output and presence to multiple admin sockets', () => {
  const { namespace, sessionManager, getPty } = buildTerminalHarness();
  const adminA = namespace.connect(new FakeSocket('admin-a', 'admin'));
  const adminB = namespace.connect(new FakeSocket('admin-b', 'admin'));

  adminA.trigger('terminal:create_session', { cols: 120, rows: 32, title: 'Shared shell' });
  const created = adminA.sent.find((message) => message.event === 'terminal:session_created').data;

  assert.equal(created.creatorClientId, 'admin-a');
  adminB.trigger('terminal:attach_session', { sessionId: created.sessionId });
  getPty(created.sessionId).emitData('pwd\r\n');

  assert.equal(adminA.sent.some((message) => message.event === 'terminal:output' && message.data.data === 'pwd\r\n'), true);
  assert.equal(adminB.sent.some((message) => message.event === 'terminal:output' && message.data.data === 'pwd\r\n'), true);
  assert.equal(adminA.sent.some((message) => message.event === 'terminal:presence' && message.data.observerCount === 2), true);
  assert.equal(adminB.sent.some((message) => message.event === 'terminal:presence' && message.data.observerCount === 2), true);
  assert.equal(sessionManager._getSession(created.sessionId).observers.size, 2);
});

test('socket identity prevents equal browser labels from merging observers or granting session actions', () => {
  const { namespace, sessionManager, getPty, auditEvents } = buildTerminalHarness();
  const longSharedLabel = 'shared-browser-label-'.repeat(20);
  const adminA = namespace.connect(new FakeSocket('admin-a', 'admin', 'admin', longSharedLabel));
  const adminB = namespace.connect(new FakeSocket('admin-b', 'admin', 'admin', longSharedLabel));

  adminA.trigger('terminal:create_session', { title: 'Identity-bound shell' });
  const created = adminA.sent.find((message) => message.event === 'terminal:session_created').data;
  const pty = getPty(created.sessionId);

  assert.equal(created.creatorClientId, 'admin-a');
  assert.equal(sessionManager._getSession(created.sessionId).observers.size, 1);
  assert.equal(auditEvents.find((entry) => entry.event === 'terminal_socket_connected').meta.clientLabel.length, 128);

  adminB.trigger('terminal:input', { sessionId: created.sessionId, data: 'forged\n' });
  adminB.trigger('terminal:set_active_presenter', { sessionId: created.sessionId });
  adminB.trigger('terminal:close_session', { sessionId: created.sessionId });

  assert.deepEqual(pty.writeCalls, []);
  assert.equal(sessionManager._getSession(created.sessionId).activePresenterClientId, 'admin-a');
  assert.equal(sessionManager._getSession(created.sessionId).observers.size, 1);
  assert.equal(
    adminB.sent.some((message) => (
      message.event === 'terminal:error'
      && message.data.code === 'terminal_session_not_attached'
    )),
    true,
  );
  assert.notEqual(sessionManager._getSession(created.sessionId), null);
});

test('unattached close attempts emit a redacted socket-owned audit warning', () => {
  const { namespace, sessionManager, auditEvents } = buildTerminalHarness();
  const creator = namespace.connect(new FakeSocket('admin-a', 'admin'));
  const attacker = namespace.connect(new FakeSocket(
    'admin-b',
    'admin',
    'admin',
    'spoofed-client-label-SECRET_LABEL',
  ));
  creator.trigger('terminal:create_session', { title: 'Protected shell' });
  const created = creator.sent.find((message) => message.event === 'terminal:session_created').data;

  attacker.trigger('terminal:close_session', {
    sessionId: created.sessionId,
    reason: 'system:shutdown-SECRET_REASON',
    raw: 'SECRET_RAW_PAYLOAD',
  });

  const rejection = auditEvents.find((entry) => entry.event === 'terminal_close_rejected');
  assert.ok(rejection);
  assert.equal(rejection.level, 'warn');
  assert.deepEqual(rejection.meta, {
    sessionId: created.sessionId,
    clientId: 'admin-b',
    socketId: 'admin-b',
    code: 'terminal_session_not_attached',
    reason: 'observer_not_attached',
  });
  assert.equal(JSON.stringify(rejection).includes('SECRET_'), false);
  assert.notEqual(sessionManager._getSession(created.sessionId), null);
});

test('create requestId is bounded and returned only to the creator on both aliases', () => {
  const { namespace } = buildTerminalHarness();
  const creator = namespace.connect(new FakeSocket('admin-a', 'admin'));
  const observer = namespace.connect(new FakeSocket('admin-b', 'admin'));
  creator.sent.length = 0;
  observer.sent.length = 0;
  const requestId = 'request-'.repeat(30);

  creator.trigger('terminal:create_session', { title: 'Correlated shell', requestId });

  for (const event of ['terminal:session_created', 'terminal:created']) {
    const creatorMessages = creator.sent.filter((message) => message.event === event);
    const observerMessages = observer.sent.filter((message) => message.event === event);
    assert.equal(creatorMessages.length, 1);
    assert.equal(creatorMessages[0].data.requestId, requestId.slice(0, 128));
    assert.equal(observerMessages.length, 1);
    assert.equal(Object.hasOwn(observerMessages[0].data, 'requestId'), false);
  }
  for (const socket of [creator, observer]) {
    const snapshot = socket.sent.findLast((message) => message.event === 'terminal:pool_snapshot').data;
    assert.equal(snapshot.sessions.some((session) => Object.hasOwn(session, 'requestId')), false);
  }
});

test('browser close reasons cannot spoof system authority', () => {
  const { namespace } = buildTerminalHarness();
  const admin = namespace.connect(new FakeSocket('admin-a', 'admin'));
  admin.trigger('terminal:create_session', { title: 'User shell' });
  const created = admin.sent.find((message) => message.event === 'terminal:session_created').data;

  admin.trigger('terminal:close_session', {
    sessionId: created.sessionId,
    reason: 'system:shutdown',
    system: true,
  });

  const closed = admin.sent.find((message) => message.event === 'terminal:session_closed');
  assert.equal(closed.data.detachedReason, 'user-close');
});

test('synchronous PTY output is emitted once after session creation with the authoritative session id', () => {
  const pty = createFakePty();
  pty.onData = (handler) => handler('instant prompt');
  const { namespace } = buildTerminalHarness({}, { ptyFactory: () => pty });
  const admin = namespace.connect(new FakeSocket('admin-a', 'admin'));

  admin.trigger('terminal:create_session', { title: 'Instant shell' });

  const createdIndex = admin.sent.findIndex((message) => message.event === 'terminal:session_created');
  const outputIndexes = admin.sent
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.event === 'terminal:output');
  const created = admin.sent[createdIndex].data;
  assert.equal(outputIndexes.length, 1);
  assert.equal(createdIndex < outputIndexes[0].index, true);
  assert.equal(outputIndexes[0].message.data.sessionId, created.sessionId);
  assert.notEqual(outputIndexes[0].message.data.sessionId, null);
  assert.equal(outputIndexes[0].message.data.data, 'instant prompt');
});

test('synchronous create-time output overflow preserves creation event ordering and detached state', () => {
  const pty = createFakePty();
  pty.onData = (handler) => handler('123456');
  const { namespace } = buildTerminalHarness({
    terminalMaxObserverQueueBytes: 5,
  }, {
    ptyFactory: () => pty,
  });
  const admin = namespace.connect(new FakeSocket('admin-a', 'admin'));
  admin.sent.length = 0;

  admin.trigger('terminal:create_session', { title: 'Immediate overflow shell' });

  const created = admin.sent.find((message) => message.event === 'terminal:session_created');
  assert.ok(created);
  const sessionId = created.data.sessionId;
  const eventsAboutSession = admin.sent.filter((message) => (
    message.data?.sessionId === sessionId
    || message.data?.sessions?.some((session) => session.sessionId === sessionId)
  ));
  assert.equal(eventsAboutSession[0].event, 'terminal:session_created');
  assert.deepEqual(eventsAboutSession.slice(0, 2).map((message) => message.event), [
    'terminal:session_created',
    'terminal:created',
  ]);
  const creationAliasesEnd = admin.sent.findLastIndex((message) => message.event === 'terminal:created');
  for (const event of ['terminal:presence', 'terminal:pool_snapshot', 'terminal:snapshot', 'terminal:warning']) {
    const index = admin.sent.findIndex((message) => message.event === event);
    assert.equal(index > creationAliasesEnd, true, `${event} must follow creation aliases`);
  }
  const finalSnapshot = admin.sent.findLast((message) => message.event === 'terminal:pool_snapshot');
  const finalSession = finalSnapshot.data.sessions.find((session) => session.sessionId === sessionId);
  assert.equal(finalSession.status, 'detached');
  assert.equal(finalSession.observerCount, 0);
});

test('synchronous PTY exit is emitted once after session creation with the authoritative session id', () => {
  const pty = createFakePty();
  pty.onExit = (handler) => handler({ exitCode: 2, signal: 0 });
  const { namespace } = buildTerminalHarness({}, { ptyFactory: () => pty });
  const admin = namespace.connect(new FakeSocket('admin-a', 'admin'));

  admin.trigger('terminal:create_session', { title: 'Immediate exit shell' });

  const createdIndex = admin.sent.findIndex((message) => message.event === 'terminal:session_created');
  const exitIndexes = admin.sent
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.event === 'terminal:exit');
  const created = admin.sent[createdIndex].data;
  assert.equal(exitIndexes.length, 1);
  assert.equal(createdIndex < exitIndexes[0].index, true);
  assert.equal(exitIndexes[0].message.data.sessionId, created.sessionId);
  assert.notEqual(exitIndexes[0].message.data.sessionId, null);
  assert.equal(exitIndexes[0].message.data.processStatus, 'failed');
});

test('socket disconnect detaches only the disconnected socket observer without closing the shared PTY', () => {
  const { namespace, sessionManager } = buildTerminalHarness();
  const adminA = namespace.connect(new FakeSocket('admin-a', 'admin', 'admin', 'shared-browser'));
  const adminB = namespace.connect(new FakeSocket('admin-b', 'admin', 'admin', 'shared-browser'));

  adminA.trigger('terminal:create_session', { cols: 120, rows: 32, title: 'Shared shell' });
  const created = adminA.sent.find((message) => message.event === 'terminal:session_created').data;
  adminB.trigger('terminal:attach_session', { sessionId: created.sessionId });

  adminA.trigger('disconnect');

  const session = sessionManager._getSession(created.sessionId);
  assert.equal(session.observers.size, 1);
  assert.equal(session.pty.killCalls.length, 0);
});

test('legacy terminal:create and terminal:attach aliases still map into shared session semantics', () => {
  const { namespace } = buildTerminalHarness();
  const adminA = namespace.connect(new FakeSocket('admin-a', 'admin'));
  adminA.trigger('terminal:create', { cols: 120, rows: 32, title: 'Compat shell' });
  const created = adminA.sent.find((message) => message.event === 'terminal:session_created').data;

  adminA.trigger('terminal:attach', { sessionId: created.sessionId });

  assert.equal(adminA.sent.some((message) => message.event === 'terminal:session_created'), true);
  assert.equal(adminA.sent.some((message) => message.event === 'terminal:created'), true);
  assert.equal(adminA.sent.some((message) => message.event === 'terminal:session_attached'), true);
  assert.equal(adminA.sent.some((message) => message.event === 'terminal:attached'), true);
});

test('terminal:detach_session detaches only the calling observer and terminal:close_session removes the shared session', () => {
  const { namespace, sessionManager } = buildTerminalHarness();
  const adminA = namespace.connect(new FakeSocket('admin-a', 'admin'));
  const adminB = namespace.connect(new FakeSocket('admin-b', 'admin'));

  adminA.trigger('terminal:create_session', { cols: 120, rows: 32, title: 'Shared shell' });
  const created = adminA.sent.find((message) => message.event === 'terminal:session_created').data;
  adminB.trigger('terminal:attach_session', { sessionId: created.sessionId });

  adminB.trigger('terminal:detach_session', { sessionId: created.sessionId });
  assert.equal(adminB.sent.some((message) => message.event === 'terminal:session_detached'), true);
  assert.equal(sessionManager._getSession(created.sessionId).observers.size, 1);

  adminA.trigger('terminal:close_session', { sessionId: created.sessionId });
  assert.equal(adminA.sent.some((message) => message.event === 'terminal:session_closed' && message.data.sessionId === created.sessionId), true);
  assert.equal(sessionManager._getSession(created.sessionId), null);
});

test('terminal close cleanup failure retains the session snapshot and retry success broadcasts closed', () => {
  const pty = createFakePty();
  let killAttempts = 0;
  pty.kill = function kill(signal) {
    this.killCalls.push(signal);
    killAttempts += 1;
    if (killAttempts <= 2) {
      throw new Error('cleanup SECRET_VALUE');
    }
  };
  const { namespace, sessionManager } = buildTerminalHarness({}, { ptyFactory: () => pty });
  const admin = namespace.connect(new FakeSocket('admin-a', 'admin'));
  admin.trigger('terminal:create_session', { title: 'Retry close shell' });
  const created = admin.sent.find((message) => message.event === 'terminal:session_created').data;
  pty.emitData('ready');
  const closedBefore = admin.sent.filter((message) => message.event === 'terminal:session_closed').length;

  admin.trigger('terminal:close_session', { sessionId: created.sessionId });

  const cleanupError = admin.sent.findLast((message) => (
    message.event === 'terminal:error' && message.data.code === 'pty_cleanup_failed'
  ));
  assert.equal(cleanupError.data.sessionId, created.sessionId);
  assert.equal(cleanupError.data.message.includes('SECRET_VALUE'), false);
  assert.equal(
    admin.sent.filter((message) => message.event === 'terminal:session_closed').length,
    closedBefore,
  );
  const retainedSnapshot = admin.sent
    .filter((message) => message.event === 'terminal:pool_snapshot')
    .at(-1).data;
  assert.equal(retainedSnapshot.sessions[0].sessionId, created.sessionId);
  assert.equal(retainedSnapshot.sessions[0].processStatus, 'closed');
  assert.notEqual(sessionManager._getSession(created.sessionId), null);

  admin.trigger('terminal:close_session', { sessionId: created.sessionId });

  assert.equal(
    admin.sent.filter((message) => message.event === 'terminal:session_closed').length,
    closedBefore + 1,
  );
  assert.equal(sessionManager._getSession(created.sessionId), null);
  assert.deepEqual(pty.killCalls, ['SIGHUP', 'SIGHUP', 'SIGHUP']);
});

test('late Terminal events after session close return stable errors without escaping the handlers', () => {
  const { namespace, auditEvents } = buildTerminalHarness();
  const admin = namespace.connect(new FakeSocket('admin-a', 'admin'));

  admin.trigger('terminal:create_session', { cols: 120, rows: 32, title: 'Closing shell' });
  const created = admin.sent.find((message) => message.event === 'terminal:session_created').data;
  admin.trigger('terminal:close_session', { sessionId: created.sessionId });

  assert.doesNotThrow(() => {
    admin.trigger('terminal:input', {
      sessionId: created.sessionId,
      data: 'late-sensitive-input',
      inputId: 'late-input',
    });
  });
  assert.doesNotThrow(() => {
    admin.trigger('terminal:resize', {
      sessionId: created.sessionId,
      cols: 120,
      rows: 32,
    });
  });

  const sessionErrors = admin.sent.filter((message) => (
    message.event === 'terminal:error' && message.data.code === 'terminal_session_not_found'
  ));
  assert.equal(sessionErrors.length, 2);
  assert.equal(auditEvents.some((entry) => entry.event === 'terminal_input_rejected'), true);
  assert.equal(auditEvents.some((entry) => entry.event === 'terminal_resize_rejected'), true);
  assert.equal(JSON.stringify(auditEvents).includes('late-sensitive-input'), false);
});

test('legacy terminal:detach and terminal:close aliases still map into shared session semantics', () => {
  const { namespace, sessionManager } = buildTerminalHarness();
  const adminA = namespace.connect(new FakeSocket('admin-a', 'admin'));
  const adminB = namespace.connect(new FakeSocket('admin-b', 'admin'));

  adminA.trigger('terminal:create', { cols: 120, rows: 32, title: 'Compat shell' });
  const created = adminA.sent.find((message) => message.event === 'terminal:session_created').data;
  adminB.trigger('terminal:attach', { sessionId: created.sessionId });

  adminB.trigger('terminal:detach', { sessionId: created.sessionId });
  assert.equal(adminB.sent.some((message) => message.event === 'terminal:session_detached'), true);
  assert.equal(sessionManager._getSession(created.sessionId).observers.size, 1);

  adminA.trigger('terminal:close', { sessionId: created.sessionId });
  assert.equal(adminA.sent.some((message) => message.event === 'terminal:session_closed' && message.data.sessionId === created.sessionId), true);
  assert.equal(adminA.sent.some((message) => message.event === 'terminal:closed' && message.data.sessionId === created.sessionId), true);
  assert.equal(sessionManager._getSession(created.sessionId), null);
});

test('shared observers may send input and must use the websocket active-presenter flow before resize mutates the PTY', () => {
  const { namespace, sessionManager, getPty } = buildTerminalHarness();
  const adminA = namespace.connect(new FakeSocket('admin-a', 'admin'));
  const adminB = namespace.connect(new FakeSocket('admin-b', 'admin'));

  adminA.trigger('terminal:create_session', { cols: 120, rows: 32, title: 'Shared shell' });
  const created = adminA.sent.find((message) => message.event === 'terminal:session_created').data;
  getPty(created.sessionId).emitData('ready');
  adminB.trigger('terminal:attach_session', { sessionId: created.sessionId, cols: 120, rows: 32 });

  adminB.trigger('terminal:input', {
    sessionId: created.sessionId,
    data: 'ls\n',
  });
  adminB.trigger('terminal:resize', {
    sessionId: created.sessionId,
    cols: 5,
    rows: 200,
  });
  adminB.trigger('terminal:resize', {
    sessionId: created.sessionId,
    cols: 132,
    rows: 36,
  });

  adminB.trigger('terminal:set_active_presenter', {
    sessionId: created.sessionId,
  });
  adminB.trigger('terminal:resize', {
    sessionId: created.sessionId,
    cols: 144,
    rows: 40,
  });

  const session = sessionManager._getSession(created.sessionId);
  assert.deepEqual(session.pty.writeCalls, ['ls\n']);
  assert.deepEqual(session.pty.resizeCalls, [{ cols: 144, rows: 40 }]);
  assert.equal(adminB.sent.some((message) => message.data?.code === 'terminal_resize_out_of_range'), true);
  assert.equal(adminB.sent.some((message) => message.event === 'terminal:presence' && message.data.activePresenterClientId === 'admin-b'), true);
});

test('terminal namespace responds to terminal:ping and terminal:input with latency metadata', () => {
  const { namespace, getPty } = buildTerminalHarness();
  const admin = namespace.connect(new FakeSocket('admin-a', 'admin'));

  admin.trigger('terminal:create_session', { cols: 120, rows: 32, title: 'Shared shell' });
  const created = admin.sent.find((message) => message.event === 'terminal:session_created').data;
  getPty(created.sessionId).emitData('ready');

  admin.trigger('terminal:ping', {
    nonce: 'ping-1',
    clientSentAt: 1234,
  });
  admin.trigger('terminal:input', {
    sessionId: created.sessionId,
    data: 'pwd\n',
    inputId: 'input-1',
    clientSentAt: 2345,
  });

  const pong = admin.sent.find((message) => message.event === 'terminal:pong');
  assert.equal(pong.data.nonce, 'ping-1');
  assert.equal(pong.data.clientSentAt, 1234);
  assert.equal(pong.data.transport, 'websocket');
  assert.equal(typeof pong.data.serverReceivedAt, 'number');
  assert.equal(typeof pong.data.serverSentAt, 'number');

  const ack = admin.sent.find((message) => message.event === 'terminal:input_ack');
  assert.equal(ack.data.sessionId, created.sessionId);
  assert.equal(ack.data.inputId, 'input-1');
  assert.equal(ack.data.clientSentAt, 2345);
  assert.equal(ack.data.transport, 'websocket');
  assert.equal(ack.data.bytes, Buffer.byteLength('pwd\n', 'utf8'));
  assert.equal(typeof ack.data.serverReceivedAt, 'number');
  assert.equal(typeof ack.data.serverSentAt, 'number');
});

test('terminal websocket sends lifecycle errors without acknowledging rejected input', () => {
  const { namespace, getPty } = buildTerminalHarness();
  const admin = namespace.connect(new FakeSocket('admin-a', 'admin'));

  admin.trigger('terminal:create_session', { title: 'Exited shell' });
  const created = admin.sent.find((message) => message.event === 'terminal:session_created').data;
  const pty = getPty(created.sessionId);
  pty.emitData('ready');
  pty.emitExit({ exitCode: 0, signal: 0 });
  const ackCountBefore = admin.sent.filter((message) => message.event === 'terminal:input_ack').length;

  admin.trigger('terminal:input', {
    sessionId: created.sessionId,
    data: 'must-not-write',
    inputId: 'rejected-input',
  });

  assert.equal(pty.writeCalls.length, 0);
  assert.equal(admin.sent.filter((message) => message.event === 'terminal:input_ack').length, ackCountBefore);
  assert.equal(
    admin.sent.some((message) => message.event === 'terminal:error' && message.data.code === 'pty_exited'),
    true,
  );
});

test('terminal:set_active_presenter rejects callers that are not attached observers', () => {
  const { namespace } = buildTerminalHarness();
  const adminA = namespace.connect(new FakeSocket('admin-a', 'admin'));
  const adminB = namespace.connect(new FakeSocket('admin-b', 'admin'));

  adminA.trigger('terminal:create_session', { cols: 120, rows: 32, title: 'Shared shell' });
  const created = adminA.sent.find((message) => message.event === 'terminal:session_created').data;

  const successEventsBefore = adminB.sent.filter((message) => (
    message.event === 'terminal:session_attached' || message.event === 'terminal:attached'
  )).length;

  adminB.trigger('terminal:set_active_presenter', {
    sessionId: created.sessionId,
  });

  const successEventsAfter = adminB.sent.filter((message) => (
    message.event === 'terminal:session_attached' || message.event === 'terminal:attached'
  )).length;

  assert.equal(adminB.sent.some((message) => message.event === 'terminal:error' && message.data.code === 'terminal_session_not_found'), true);
  assert.equal(successEventsAfter, successEventsBefore);
});

test('terminal websocket emits audit events for rejected resize and oversized input', () => {
  const { namespace, auditEvents } = buildTerminalHarness();
  const admin = namespace.connect(new FakeSocket('admin-a', 'admin'));

  admin.trigger('terminal:create_session', { cols: 120, rows: 32, title: 'Shared shell' });
  const created = admin.sent.find((message) => message.event === 'terminal:session_created').data;

  admin.trigger('terminal:resize', {
    sessionId: created.sessionId,
    cols: 5,
    rows: 999,
  });
  admin.trigger('terminal:input', {
    sessionId: created.sessionId,
    data: 'x'.repeat(70 * 1024),
  });

  assert.equal(auditEvents.some((entry) => entry.event === 'terminal_resize_rejected'), true);
  assert.equal(auditEvents.some((entry) => entry.event === 'terminal_input_rejected'), true);
});

test('terminal websocket returns a stable error when the hard session limit is reached', () => {
  const { namespace } = buildTerminalHarness({ terminalMaxSessions: 1 });
  const admin = namespace.connect(new FakeSocket('admin-a', 'admin'));

  admin.trigger('terminal:create_session', { title: 'one' });
  admin.trigger('terminal:create_session', { title: 'two' });

  assert.equal(
    admin.sent.some((message) => message.event === 'terminal:error' && message.data.code === 'terminal_session_limit'),
    true,
  );
});

test('terminal websocket reports input rate limits without ack or raw input and accepts after refill', () => {
  let nowMs = 0;
  const { namespace, getPty, auditEvents } = buildTerminalHarness({
    terminalInputBytesPerSecond: 10,
    terminalInputBurstBytes: 10,
  }, {
    now: () => new Date(nowMs),
  });
  const admin = namespace.connect(new FakeSocket('admin-a', 'admin'));
  admin.trigger('terminal:create_session', { title: 'Rate limited shell' });
  const created = admin.sent.find((message) => message.event === 'terminal:session_created').data;
  const pty = getPty(created.sessionId);
  pty.emitData('ready');

  admin.trigger('terminal:input', {
    sessionId: created.sessionId,
    data: '1234567890',
    inputId: 'accepted-first',
  });
  const ackCount = admin.sent.filter((message) => message.event === 'terminal:input_ack').length;
  admin.trigger('terminal:input', {
    sessionId: created.sessionId,
    data: 'SECRET_INPUT',
    inputId: 'rejected',
  });

  const error = admin.sent.findLast((message) => (
    message.event === 'terminal:error'
    && message.data.code === 'terminal_input_rate_limited'
  ));
  assert.deepEqual(error.data.details, {
    retryAfterMs: 1200,
    remainingBytes: 0,
    bytes: 12,
  });
  assert.equal(admin.sent.filter((message) => message.event === 'terminal:input_ack').length, ackCount);
  assert.deepEqual(pty.writeCalls, ['1234567890']);
  assert.equal(JSON.stringify(error).includes('SECRET_INPUT'), false);
  assert.equal(JSON.stringify(auditEvents).includes('SECRET_INPUT'), false);
  assert.equal(
    auditEvents.filter((entry) => entry.event === 'terminal_input_rate_limited').length,
    1,
  );

  nowMs = 1200;
  admin.trigger('terminal:input', {
    sessionId: created.sessionId,
    data: 'accepted',
    inputId: 'accepted-after-refill',
  });
  assert.deepEqual(pty.writeCalls, ['1234567890', 'accepted']);
  assert.equal(admin.sent.some((message) => (
    message.event === 'terminal:input_ack'
    && message.data.inputId === 'accepted-after-refill'
  )), true);
});

test('terminal websocket records socket and input metrics once on the shared instance', () => {
  let nowMs = 0;
  const metrics = new TerminalMetrics();
  const { namespace, getPty } = buildTerminalHarness({
    terminalInputBytesPerSecond: 1,
    terminalInputBurstBytes: 1,
  }, {
    metrics,
    now: () => new Date(nowMs),
  });
  const admin = namespace.connect(new FakeSocket('admin-metrics', 'admin'));
  admin.trigger('terminal:create_session', { title: 'Metrics shell' });
  const created = admin.sent.find((message) => message.event === 'terminal:session_created').data;
  getPty(created.sessionId).emitData('ready');

  admin.trigger('terminal:input', { sessionId: created.sessionId, data: 'x' });
  admin.trigger('terminal:input', { sessionId: created.sessionId, data: 'SECRET_INPUT' });
  admin.trigger('terminal:input', {
    sessionId: created.sessionId,
    data: 'x'.repeat(65 * 1024),
  });
  nowMs = 3;
  admin.trigger('disconnect');

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.socket_connected, 1);
  assert.equal(snapshot.counters.socket_disconnected, 1);
  assert.equal(snapshot.counters.input_accepted, 1);
  assert.equal(snapshot.counters.input_rate_limited, 1);
  assert.equal(snapshot.counters.input_rejected, 1);
  assert.equal(snapshot.latencies.server_input_process_ms.sampleCount, 2);
  assert.equal(JSON.stringify(snapshot).includes('SECRET_INPUT'), false);
});

test('terminal websocket warns and detaches only a slow observer while replay retains overflow output', () => {
  const { namespace, sessionManager, getPty, auditEvents } = buildTerminalHarness({
    terminalMaxObserverQueueBytes: 5,
  });
  const slow = namespace.connect(new FakeSocket('admin-slow', 'admin'));
  const fast = namespace.connect(new FakeSocket('admin-fast', 'admin'));
  slow.autoAcknowledgeOutput = false;
  slow.trigger('terminal:create_session', { title: 'Backpressure shell' });
  const created = slow.sent.find((message) => message.event === 'terminal:session_created').data;
  const pty = getPty(created.sessionId);

  pty.emitData('12345');
  fast.trigger('terminal:attach_session', { sessionId: created.sessionId });
  pty.emitData('x');

  const warning = slow.sent.find((message) => (
    message.event === 'terminal:warning'
    && message.data.code === 'terminal_output_backpressure'
  ));
  assert.deepEqual(warning.data, {
    sessionId: created.sessionId,
    code: 'terminal_output_backpressure',
    stats: { queuedBytes: 5, droppedChunks: 1 },
  });
  assert.equal(fast.sent.some((message) => message.event === 'terminal:warning'), false);
  assert.equal(sessionManager.isObserverAttached(created.sessionId, { socketId: 'admin-slow' }), false);
  assert.equal(sessionManager.isObserverAttached(created.sessionId, { socketId: 'admin-fast' }), true);
  assert.deepEqual(pty.killCalls, []);

  assert.equal(fast.sent.some((message) => (
    message.event === 'terminal:output' && message.data.data === 'x'
  )), true);
  const slowOutput = slow.sent.find((message) => message.event === 'terminal:output');
  assert.equal(typeof slowOutput.acknowledge, 'function');
  assert.equal(slow.sent.some((message) => (
    message.event === 'terminal:presence' && message.data.observerCount === 1
  )), true);
  assert.equal(JSON.stringify(warning).includes('12345'), false);
  assert.equal(JSON.stringify(auditEvents).includes('12345'), false);

  slowOutput.acknowledge();
  slowOutput.acknowledge();
  assert.equal(sessionManager.isObserverAttached(created.sessionId, { socketId: 'admin-slow' }), false);

  slow.trigger('terminal:attach_session', { sessionId: created.sessionId });
  const replay = slow.sent.findLast((message) => message.event === 'terminal:replay').data.replay;
  assert.deepEqual(replay.map((entry) => entry.data), ['12345', 'x']);
});
