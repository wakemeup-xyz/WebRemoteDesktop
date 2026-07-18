const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

process.env.JWT_SECRET = process.env.JWT_SECRET || '12345678';
process.env.VIEWER_ACCESS_PASSWORD = process.env.VIEWER_ACCESS_PASSWORD || 'test-viewer-password';
process.env.HOST_SHARED_SECRET = process.env.HOST_SHARED_SECRET || 'test-host-secret';

const { signAccessToken } = require('../lib/auth');
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
    this.conn = {
      transport: { name: 'websocket' },
      on() {},
    };
  }

  emit(event, data) {
    this.sent.push({ event, data });
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

function buildTerminalHarness(configOverrides = {}) {
  const io = makeIo();
  const ptyBySessionId = new Map();
  const auditEvents = [];
  const ptyFactory = () => {
    const pty = createFakePty();
    return pty;
  };
  const sessionManager = createTerminalSessionManager({
    ptyFactory: (...args) => ptyFactory(...args),
    logger: { info() {}, warn() {}, error() {} },
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
    audit: {
      info(event, meta = {}) {
        auditEvents.push({ level: 'info', event, meta });
      },
      warn(event, meta = {}) {
        auditEvents.push({ level: 'warn', event, meta });
      },
      error(event, meta = {}) {
        auditEvents.push({ level: 'error', event, meta });
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  return {
    namespace: io.of('/terminal'),
    sessionManager,
    auditEvents,
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

  assert.equal(created.creatorClientId, 'admin-a-client');
  adminB.trigger('terminal:attach_session', { sessionId: created.sessionId });
  getPty(created.sessionId).emitData('pwd\r\n');

  assert.equal(adminA.sent.some((message) => message.event === 'terminal:output' && message.data.data === 'pwd\r\n'), true);
  assert.equal(adminB.sent.some((message) => message.event === 'terminal:output' && message.data.data === 'pwd\r\n'), true);
  assert.equal(adminA.sent.some((message) => message.event === 'terminal:presence' && message.data.observerCount === 2), true);
  assert.equal(adminB.sent.some((message) => message.event === 'terminal:presence' && message.data.observerCount === 2), true);
  assert.equal(sessionManager._getSession(created.sessionId).observers.size, 2);
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
  const { namespace, sessionManager } = buildTerminalHarness();
  const adminA = namespace.connect(new FakeSocket('admin-a', 'admin'));
  const adminB = namespace.connect(new FakeSocket('admin-b', 'admin'));

  adminA.trigger('terminal:create_session', { cols: 120, rows: 32, title: 'Shared shell' });
  const created = adminA.sent.find((message) => message.event === 'terminal:session_created').data;
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
  assert.equal(adminB.sent.some((message) => message.event === 'terminal:presence' && message.data.activePresenterClientId === 'admin-b-client'), true);
});

test('terminal namespace responds to terminal:ping and terminal:input with latency metadata', () => {
  const { namespace } = buildTerminalHarness();
  const admin = namespace.connect(new FakeSocket('admin-a', 'admin'));

  admin.trigger('terminal:create_session', { cols: 120, rows: 32, title: 'Shared shell' });
  const created = admin.sent.find((message) => message.event === 'terminal:session_created').data;

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
