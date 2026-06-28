const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

process.env.JWT_SECRET = process.env.JWT_SECRET || '12345678';
process.env.VIEWER_ACCESS_PASSWORD = process.env.VIEWER_ACCESS_PASSWORD || 'test-viewer-password';
process.env.HOST_SHARED_SECRET = process.env.HOST_SHARED_SECRET || 'test-host-secret';

const { signAccessToken } = require('../lib/auth');
const { setupTerminal } = require('./terminal');

class FakeSocket extends EventEmitter {
  constructor(id, tokenRole = 'admin', role = tokenRole) {
    super();
    this.id = id;
    this.handshake = {
      auth: {
        token: signAccessToken(tokenRole, `${id}-${tokenRole}`),
        role,
        clientId: `${id}-client`,
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
    written: [],
    resized: [],
    killed: [],
    onData(handler) {
      handlers.data.push(handler);
    },
    onExit(handler) {
      handlers.exit.push(handler);
    },
    write(data) {
      this.written.push(data);
    },
    resize(cols, rows) {
      this.resized.push({ cols, rows });
    },
    kill(signal) {
      this.killed.push(signal);
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
    namespaces,
    defaultUse: null,
    defaultConnection: null,
    use(handler) {
      this.defaultUse = handler;
    },
    on(event, handler) {
      if (event === 'connection') {
        this.defaultConnection = handler;
      }
    },
    of(name) {
      if (!namespaces.has(name)) {
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
            if (this.connectionHandler) {
              this.connectionHandler(socket);
            }
          },
        };
        namespaces.set(name, namespace);
      }
      return namespaces.get(name);
    },
    connect(socket) {
      if (this.defaultUse) {
        let middlewareError = null;
        this.defaultUse(socket, (err) => {
          middlewareError = err || null;
        });
        if (middlewareError) {
          throw middlewareError;
        }
      }
      if (this.defaultConnection) {
        this.defaultConnection(socket);
      }
    },
  };
}

test('terminal namespace accepts admin and rejects viewer tokens', () => {
  const io = makeIo();
  const pty = createFakePty();
  const sessionManager = {
    sessions: new Map(),
    createSession(input) {
      const sessionId = 'term_abc123';
      const session = {
        sessionId,
        ownerSub: input.ownerSub,
        title: input.title || 'Terminal 1',
        cwd: '/Users/macstudio1/AI/Claude/WebRemoteDesktop',
        shell: '/bin/zsh',
        cols: input.cols,
        rows: input.rows,
        status: 'attached',
        createdAt: '2026-06-28T00:00:00.000Z',
        lastActiveAt: '2026-06-28T00:00:00.000Z',
        detachedReason: null,
        pty,
      };
      this.sessions.set(sessionId, session);
      return {
        sessionId,
        ownerSub: session.ownerSub,
        title: session.title,
        cwd: session.cwd,
        shell: session.shell,
        cols: session.cols,
        rows: session.rows,
        status: session.status,
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
        detachedReason: session.detachedReason,
      };
    },
    attachSession(sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        const err = new Error('terminal_session_not_found');
        err.code = 'terminal_session_not_found';
        throw err;
      }
      session.status = 'attached';
      return {
        sessionId,
        ownerSub: session.ownerSub,
        title: session.title,
        cwd: session.cwd,
        shell: session.shell,
        cols: session.cols,
        rows: session.rows,
        status: session.status,
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
        detachedReason: null,
      };
    },
    detachSession(sessionId) {
      const session = this.sessions.get(sessionId);
      session.status = 'detached';
      return {
        sessionId,
        ownerSub: session.ownerSub,
        title: session.title,
        cwd: session.cwd,
        shell: session.shell,
        cols: session.cols,
        rows: session.rows,
        status: session.status,
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
        detachedReason: 'disconnect',
      };
    },
    closeSession() {
      return { status: 'closed' };
    },
    listSessions() {
      return Array.from(this.sessions.values()).map((session) => ({
        sessionId: session.sessionId,
        ownerSub: session.ownerSub,
        title: session.title,
        cwd: session.cwd,
        shell: session.shell,
        cols: session.cols,
        rows: session.rows,
        status: session.status,
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
        detachedReason: session.detachedReason,
      }));
    },
    getSnapshot() {
      return { sessions: this.listSessions() };
    },
    _getSession(sessionId) {
      return this.sessions.get(sessionId);
    },
  };

  const config = {
    enableTerminal: true,
    terminalAdminPassword: 'test-terminal-admin-password',
    terminalShell: '/bin/zsh',
    terminalCwd: '/Users/macstudio1/AI/Claude/WebRemoteDesktop',
    terminalSoftWarnSessionCount: 0,
    terminalIdleTimeoutMs: 0,
    terminalStartupTimeoutMs: 10000,
    terminalAuditLog: '',
    terminalRecordIo: false,
  };

  setupTerminal(io, {
    config,
    sessionManager,
    logger: { info() {}, warn() {}, error() {} },
  });

  const namespace = io.of('/terminal');
  const admin = new FakeSocket('admin-1', 'admin');
  namespace.connect(admin);
  assert.equal(admin.sent[0].event, 'terminal:snapshot');

  admin.trigger('terminal:create', { cols: 120, rows: 32 });
  const created = admin.sent.find((message) => message.event === 'terminal:created');
  assert.equal(created.data.sessionId, 'term_abc123');
  assert.equal(admin.sent.some((message) => message.event === 'terminal:warning'), true);

  admin.trigger('terminal:attach', { sessionId: 'term_abc123' });
  assert.equal(admin.sent.some((message) => message.event === 'terminal:attached'), true);

  const viewer = new FakeSocket('viewer-1', 'viewer');
  assert.throws(() => namespace.connect(viewer), /Admin role required/);
});

test('terminal namespace rejects admin tokens when terminal is disabled or misconfigured', () => {
  const disabledIo = makeIo();
  setupTerminal(disabledIo, {
    config: {
      enableTerminal: false,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalSoftWarnSessionCount: 4,
    },
    sessionManager: { getSnapshot: () => ({ sessions: [] }) },
    logger: { info() {}, warn() {}, error() {} },
  });
  assert.throws(() => disabledIo.of('/terminal').connect(new FakeSocket('admin-disabled', 'admin')), /Terminal disabled/);

  const misconfiguredIo = makeIo();
  setupTerminal(misconfiguredIo, {
    config: {
      enableTerminal: true,
      terminalAdminPassword: '',
      terminalSoftWarnSessionCount: 4,
    },
    sessionManager: { getSnapshot: () => ({ sessions: [] }) },
    logger: { info() {}, warn() {}, error() {} },
  });
  assert.throws(() => misconfiguredIo.of('/terminal').connect(new FakeSocket('admin-misconfigured', 'admin')), /Terminal admin password not configured/);
});

test('terminal namespace rejects oversized input and invalid resize values', () => {
  const io = makeIo();
  const pty = createFakePty();
  const session = {
    sessionId: 'term_limits',
    ownerSub: 'admin-limits-admin',
    pty,
    cols: 120,
    rows: 32,
  };
  const sessionManager = {
    getSnapshot: () => ({ sessions: [] }),
    _getSession: (sessionId) => sessionId === session.sessionId ? session : null,
  };
  setupTerminal(io, {
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalSoftWarnSessionCount: 4,
    },
    sessionManager,
    logger: { info() {}, warn() {}, error() {} },
  });

  const namespace = io.of('/terminal');
  const admin = new FakeSocket('admin-limits', 'admin');
  namespace.connect(admin);
  admin.trigger('terminal:input', {
    sessionId: session.sessionId,
    data: 'x'.repeat(65537),
  });
  admin.trigger('terminal:resize', {
    sessionId: session.sessionId,
    cols: 5,
    rows: 200,
  });

  assert.equal(pty.written.length, 0);
  assert.equal(pty.resized.length, 0);
  assert.equal(admin.sent.some((message) => message.data?.code === 'terminal_input_too_large'), true);
  assert.equal(admin.sent.some((message) => message.data?.code === 'terminal_resize_out_of_range'), true);
});
