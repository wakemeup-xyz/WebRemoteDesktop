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

function buildTerminalHarness() {
  const io = makeIo();
  const ptyBySessionId = new Map();
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
    logger: { info() {}, warn() {}, error() {} },
  });

  return {
    namespace: io.of('/terminal'),
    sessionManager,
    getPty(sessionId) {
      return ptyBySessionId.get(sessionId);
    },
  };
}

test('terminal namespace accepts admin and rejects viewer tokens', () => {
  const { namespace } = buildTerminalHarness();
  const admin = namespace.connect(new FakeSocket('admin-1', 'admin'));
  assert.equal(admin.sent[0].event, 'terminal:pool_snapshot');

  const viewer = new FakeSocket('viewer-1', 'viewer');
  assert.throws(() => namespace.connect(viewer), /Admin role required/);
});

test('terminal namespace broadcasts shared session output and presence to multiple admin sockets', () => {
  const { namespace, sessionManager, getPty } = buildTerminalHarness();
  const adminA = namespace.connect(new FakeSocket('admin-a', 'admin'));
  const adminB = namespace.connect(new FakeSocket('admin-b', 'admin'));

  adminA.trigger('terminal:create_session', { cols: 120, rows: 32, title: 'Shared shell' });
  const created = adminA.sent.find((message) => message.event === 'terminal:session_created').data;

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
  assert.equal(adminA.sent.some((message) => message.event === 'terminal:session_attached'), true);
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
  assert.equal(sessionManager._getSession(created.sessionId), null);
});

test('shared observers may send input and only valid resize requests mutate the PTY', () => {
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

  sessionManager.setActivePresenter(created.sessionId, { clientId: 'admin-b-client', socketId: 'admin-b' });
  adminB.trigger('terminal:resize', {
    sessionId: created.sessionId,
    cols: 132,
    rows: 36,
  });

  const session = sessionManager._getSession(created.sessionId);
  assert.deepEqual(session.pty.writeCalls, ['ls\n']);
  assert.deepEqual(session.pty.resizeCalls, [{ cols: 132, rows: 36 }]);
  assert.equal(adminB.sent.some((message) => message.data?.code === 'terminal_resize_out_of_range'), true);
});
