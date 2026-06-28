const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { signAccessToken } = require('../lib/auth');
const { setupTerminal } = require('./terminal');

process.env.JWT_SECRET = process.env.JWT_SECRET || '12345678';
process.env.ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || 'test-viewer-password';
process.env.HOST_PASSWORD = process.env.HOST_PASSWORD || 'test-host-password';

const { setupSignaling, connections } = require('./signaling');

class FakeSocket extends EventEmitter {
  constructor(id, role, tokenRole = role === 'relay-viewer' ? 'viewer' : role) {
    super();
    this.id = id;
    this.handshake = {
      auth: { role, token: signAccessToken(tokenRole, `${id}-${tokenRole}`) },
      address: '127.0.0.1',
      headers: {},
    };
    this.sent = [];
    this.volatile = {
      emit: (event, data) => this.sent.push({ event, data, volatile: true }),
    };
  }

  emit(event, data) {
    this.sent.push({ event, data });
    return true;
  }

  trigger(event, data) {
    return super.emit(event, data);
  }

  disconnect() {
    this.trigger('disconnect');
  }
}

function makeIo() {
  return {
    connectionHandler: null,
    middleware: null,
    namespaces: new Map(),
    use(handler) {
      this.middleware = handler;
    },
    on(event, handler) {
      if (event === 'connection') {
        this.connectionHandler = handler;
      }
    },
    of(name) {
      if (!this.namespaces.has(name)) {
        this.namespaces.set(name, {
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
        });
      }
      return this.namespaces.get(name);
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
      this.connectionHandler(socket);
    },
  };
}

function resetConnections() {
  connections.host = null;
  connections.viewers.clear();
  connections.relayViewers.clear();
}

test('relay-viewer disconnect stops host tunnel relay stream', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);

  const host = new FakeSocket('host-1', 'host');
  const relayViewer = new FakeSocket('relay-1', 'relay-viewer');
  io.connect(host);
  io.connect(relayViewer);

  relayViewer.trigger('disconnect');

  assert.equal(connections.relayViewers.has('relay-1'), false);
  assert.deepEqual(
    host.sent.filter((message) => message.event === 'relay-stream-control').at(-1),
    {
      event: 'relay-stream-control',
      data: {
        enabled: false,
        viewerId: 'relay-1',
      },
    },
  );
});

test('terminal namespace wiring does not break viewer and host signaling', () => {
  resetConnections();
  const io = makeIo();
  setupTerminal(io, {
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '',
      terminalSoftWarnSessionCount: 4,
      terminalIdleTimeoutMs: 0,
      terminalStartupTimeoutMs: 10000,
      terminalAuditLog: '',
      terminalRecordIo: false,
    },
    sessionManager: {
      createSession() {
        return {
          sessionId: 'term_1',
          ownerSub: 'admin-1',
          title: 'Terminal 1',
          cwd: '',
          shell: '/bin/zsh',
          cols: 80,
          rows: 24,
          status: 'attached',
          createdAt: '2026-06-28T00:00:00.000Z',
          lastActiveAt: '2026-06-28T00:00:00.000Z',
          detachedReason: null,
        };
      },
      attachSession() {
        return {
          sessionId: 'term_1',
          ownerSub: 'admin-1',
          title: 'Terminal 1',
          cwd: '',
          shell: '/bin/zsh',
          cols: 80,
          rows: 24,
          status: 'attached',
          createdAt: '2026-06-28T00:00:00.000Z',
          lastActiveAt: '2026-06-28T00:00:00.000Z',
          detachedReason: null,
        };
      },
      detachSession() {},
      closeSession() {},
      listSessions() { return []; },
      getSnapshot() { return { sessions: [] }; },
      _getSession() { return null; },
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  setupSignaling(io);

  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  io.connect(host);
  io.connect(viewer);

  assert.equal(connections.host.id, 'host-1');
  assert.equal(connections.viewers.has('viewer-1'), true);
});

test('viewer disconnect reports zero viewers so host can stop active relay stream', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);

  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  io.connect(host);
  io.connect(viewer);

  viewer.trigger('disconnect');

  assert.equal(connections.viewers.has('viewer-1'), false);
  assert.deepEqual(
    host.sent.filter((message) => message.event === 'viewer-status').at(-1),
    {
      event: 'viewer-status',
      data: {
        reason: 'viewer-disconnected',
        onlineCount: 0,
        viewers: [],
        changedViewer: {
          id: 'viewer-1',
          ip: '127.0.0.1',
          userAgent: 'unknown',
        },
      },
    },
  );
});

test('input from disconnected viewer is not relayed to host', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);

  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  io.connect(host);
  io.connect(viewer);

  viewer.trigger('disconnect');
  viewer.trigger('input', {
    type: 'keyboard',
    action: 'keydown',
    payload: { key: 'a', code: 'KeyA' },
  });

  assert.equal(
    host.sent.some((message) => message.event === 'input'),
    false,
  );
});

test('relay control from disconnected viewer is not relayed to host', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);

  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  io.connect(host);
  io.connect(viewer);

  viewer.trigger('disconnect');
  viewer.trigger('relay-stream-control', {
    enabled: true,
    width: 960,
    height: 540,
  });

  assert.equal(
    host.sent.some((message) => message.event === 'relay-stream-control'),
    false,
  );
});

test('offer from disconnected viewer is not relayed to host', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);

  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  io.connect(host);
  io.connect(viewer);

  viewer.trigger('disconnect');
  viewer.trigger('offer', {
    offer: { type: 'offer', sdp: 'v=0' },
    epoch: 2,
  });

  assert.equal(
    host.sent.some((message) => message.event === 'offer'),
    false,
  );
});

test('ice candidate from disconnected viewer is not relayed to host', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);

  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  io.connect(host);
  io.connect(viewer);

  viewer.trigger('disconnect');
  viewer.trigger('ice-candidate', {
    target: 'host',
    candidate: { candidate: 'candidate:1' },
  });

  assert.equal(
    host.sent.some((message) => message.event === 'ice-candidate'),
    false,
  );
});


test('diagnostic relay redacts keyboard metadata by default', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);

  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  io.connect(host);
  io.connect(viewer);

  const fsMod = require('node:fs');
  const originalWrite = fsMod.writeFileSync;
  let captured = null;
  fsMod.writeFileSync = (_file, data) => {
    captured = JSON.parse(data);
  };

  try {
    const payload = {
      logs: ['line-1'],
      keyboardDebug: ['dbg-1'],
      trigger: 'auto-failure',
      reason: 'pc-failed',
      network: {
        networkMode: 'stun',
        turnConfigured: false,
        turnStatus: 'missing',
        candidateSummary: {
          local: { host: 2, srflx: 1 },
          remote: { host: 1, srflx: 1 },
          samples: {
            local: [{ type: 'srflx', address: '203.0.113.1:5000' }],
            remote: [{ type: 'host', address: '192.168.0.2:6000' }],
          },
        },
      },
      keyboardMode: 'windows',
      inputState: {
        keyboardMode: 'windows',
        lastReleaseAllReason: 'window-blur',
        lastKeyboardResetReason: 'window-blur',
        recentInputEvents: [{ type: 'keyboard-reset', reason: 'window-blur' }],
      },
      inputChannelTimeline: [{ kind: 'open', message: '[INPUT-DC] DataChannel open' }],
    };
    viewer.trigger('diagnostic', payload);
  } finally {
    fsMod.writeFileSync = originalWrite;
  }

  assert.equal(captured, null);
  assert.deepEqual(
    host.sent.filter((message) => message.event === 'diagnostic').at(-1),
    { event: 'diagnostic', data: {
      logs: ['line-1'],
      keyboardDebug: [],
      trigger: 'auto-failure',
      reason: 'pc-failed',
      network: {
        networkMode: 'stun',
        turnConfigured: false,
        turnStatus: 'missing',
        candidateSummary: {
          local: { host: 2, srflx: 1 },
          remote: { host: 1, srflx: 1 },
          samples: {
            local: [{ type: 'srflx', address: '203.0.113.1:5000' }],
            remote: [{ type: 'host', address: '192.168.0.2:6000' }],
          },
        },
      },
      keyboardMode: 'windows',
      inputState: {
        keyboardMode: 'windows',
        pendingKeys: 0,
        lastReleaseAllReason: 'window-blur',
        lastKeyboardResetReason: 'window-blur',
        recentInputEvents: [{ type: 'keyboard-reset', reason: 'window-blur' }],
      },
      inputChannelTimeline: [{ kind: 'open', message: '[INPUT-DC] DataChannel open' }],
    } }
  );
});

test('viewer connection cannot claim host role metadata', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);

  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'host', 'viewer');

  io.connect(host);
  io.connect(viewer);

  assert.equal(connections.host.id, 'host-1');
  assert.equal(connections.viewers.has('viewer-1'), true);
});
