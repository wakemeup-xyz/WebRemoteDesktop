const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { signAccessToken } = require('../lib/auth');
const { setupTerminal } = require('./terminal');

process.env.JWT_SECRET = process.env.JWT_SECRET || '12345678';
process.env.ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || 'test-viewer-password';
process.env.HOST_PASSWORD = process.env.HOST_PASSWORD || 'test-host-password';

const { setupSignaling, connections } = require('./signaling');

function v2Key(overrides = {}) {
  return {
    schemaVersion: 2,
    type: 'keyboard',
    action: 'key',
    leaseId: 'lease-000000000001',
    leaseEpoch: 1,
    seq: 1,
    inputIds: ['input-1'],
    payload: {
      phase: 'down',
      code: 'KeyA',
      location: 0,
      repeat: false,
      modifiers: { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false },
      locks: { capsLock: false },
    },
    ...overrides,
  };
}

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

test('viewer media-profile-change is sanitized and forwarded to host', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);

  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  io.connect(host);
  io.connect(viewer);

  viewer.trigger('media-profile-change', {
    profile: 'medium',
    width: 960,
    height: 540,
    targetFps: 15,
    videoBitrateKbps: 1400,
    reason: 'packet-loss',
    extra: 'drop-me',
  });

  const message = host.sent.find((entry) => entry.event === 'media-profile-change');
  assert.equal(Boolean(message), true);
  assert.equal(message.data.viewerId, 'viewer-1');
  assert.equal(message.data.profile, 'medium');
  assert.equal(message.data.width, 960);
  assert.equal(message.data.height, 540);
  assert.equal(message.data.targetFps, 15);
  assert.equal(message.data.videoBitrateKbps, 1400);
  assert.equal(message.data.reason, 'packet-loss');
  assert.equal(message.data.extra, undefined);
});

test('non-viewer media-profile-change is ignored', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);

  const host = new FakeSocket('host-1', 'host');
  io.connect(host);

  host.trigger('media-profile-change', { profile: 'survival' });

  assert.equal(host.sent.some((entry) => entry.event === 'media-profile-change'), false);
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

test('host input ack is routed only to its original viewer', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);
  const host = new FakeSocket('host-1', 'host');
  const viewerA = new FakeSocket('viewer-a', 'viewer');
  const viewerB = new FakeSocket('viewer-b', 'viewer');
  io.connect(host);
  io.connect(viewerA);
  io.connect(viewerB);

  host.trigger('input-ack', {
    viewerId: 'viewer-a',
    type: 'input_ack',
    inputIds: ['input-1'],
    hostExecuteMs: 8,
    transport: 'socket',
  });

  assert.equal(viewerA.sent.some((message) => message.event === 'input-ack' && message.data.inputIds[0] === 'input-1'), true);
  assert.equal(viewerB.sent.some((message) => message.event === 'input-ack'), false);
});

test('v2 host input ack preserves keyboard state fields and redacts raw input data', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  io.connect(host);
  io.connect(viewer);

  host.trigger('input-ack', {
    viewerId: 'viewer-1',
    type: 'input_ack',
    schemaVersion: 2,
    leaseEpoch: 12,
    appliedSeq: 7,
    status: 'applied',
    pressedKeyCount: 1,
    modifierMask: 0x100000,
    inputIds: ['input-1'],
    hostExecuteMs: 9,
    key: 'SecretKey',
    payload: { key: 'SecretKey' },
  });

  const ack = viewer.sent.find((message) => message.event === 'input-ack').data;
  assert.deepEqual(ack, {
    type: 'input_ack',
    schemaVersion: 2,
    leaseEpoch: 12,
    appliedSeq: 7,
    status: 'applied',
    pressedKeyCount: 1,
    modifierMask: 0x100000,
    inputIds: ['input-1'],
    hostExecuteMs: 9,
    transport: 'socket',
  });
  assert.equal('key' in ack, false);
  assert.equal('payload' in ack, false);
});

test('signal input relay logs metadata without raw input payload values', () => {
  resetConnections();
  const io = makeIo();
  const lines = [];
  setupSignaling(io, { logger: { log(...values) { lines.push(values.join(' ')); }, warn() {}, info() {}, error() {} } });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  io.connect(host);
  io.connect(viewer);

  viewer.trigger('control-acquire', { requestId: 'input-log' });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });

  const originalLog = console.log;
  console.log = (...values) => lines.push(values.join(' '));
  try {
    viewer.trigger('input', {
      type: 'keyboard',
      action: 'keydown',
      transport: 'socket',
      inputIds: ['input-Secret123'],
      payload: { key: 'Secret123', code: 'KeyA', x: 987.654 },
    });
  } finally {
    console.log = originalLog;
  }

  const text = lines.join('\n');
  assert.equal(text.includes('Secret123'), false);
  assert.equal(text.includes('KeyA'), false);
  assert.equal(text.includes('987.654'), false);
  assert.match(text, /type=keyboard/);
  assert.match(text, /action=keydown/);
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

test('active v2 offer forwards its authorized lease only to the host', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const owner = new FakeSocket('viewer-owner', 'viewer');
  const observer = new FakeSocket('viewer-observer', 'viewer');
  io.connect(host);
  io.connect(owner);
  io.connect(observer);

  owner.trigger('control-acquire', { requestId: 'owner-control' });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const grant = owner.sent.find((entry) => entry.event === 'control-grant').data;

  owner.trigger('offer', {
    schemaVersion: 2,
    offer: { type: 'offer', sdp: 'v=0' },
    epoch: 3,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });

  const forwarded = host.sent.filter((entry) => entry.event === 'offer').at(-1).data;
  assert.deepEqual(forwarded, {
    offer: { type: 'offer', sdp: 'v=0' },
    viewerId: 'viewer-owner',
    epoch: 3,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });
  assert.equal(observer.sent.some((entry) => entry.event === 'offer'), false);
  assert.equal(JSON.stringify(observer.sent).includes(grant.leaseId), false);
  assert.equal(JSON.stringify(owner.sent.filter((entry) => entry.event === 'control-state')).includes(grant.leaseId), false);
});

test('legacy offer does not receive a synthetic lease token when forwarded', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-legacy', 'viewer');
  io.connect(host);
  io.connect(viewer);

  viewer.trigger('offer', { offer: { type: 'offer', sdp: 'v=0' }, epoch: 2 });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });

  const forwarded = host.sent.filter((entry) => entry.event === 'offer').at(-1).data;
  assert.equal(Object.hasOwn(forwarded, 'leaseId'), false);
  assert.equal(forwarded.leaseEpoch, transition.leaseEpoch);
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
      latency: 42,
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
  const diagnostic = host.sent.filter((message) => message.event === 'diagnostic').at(-1);
  assert.equal(diagnostic.event, 'diagnostic');
  assert.equal(diagnostic.data.type, 'diagnostic');
  assert.equal(diagnostic.data.viewerId, 'viewer-1');
  assert.equal(diagnostic.data.userAgent, 'unknown');
  assert.equal(diagnostic.data.screen, 'unknown');
  assert.equal(diagnostic.data.logCount, 1);
  assert.deepEqual(diagnostic.data.logs, ['line-1']);
  assert.deepEqual(diagnostic.data.keyboardDebug, []);
  assert.equal(diagnostic.data.trigger, 'auto-failure');
  assert.equal(diagnostic.data.reason, 'pc-failed');
  assert.equal(diagnostic.data.latency, 42);
  assert.deepEqual(diagnostic.data.traceSummary, {
    trigger: 'auto-failure',
    reason: 'pc-failed',
  });
  assert.deepEqual(diagnostic.data.network, {
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
  });
  assert.deepEqual(diagnostic.data.inputState, {
    keyboardMode: 'windows',
    pendingKeys: 0,
    lastReleaseAllReason: 'window-blur',
    lastKeyboardResetReason: 'window-blur',
    recentInputEvents: [{ type: 'keyboard-reset', reason: 'window-blur' }],
  });
  assert.deepEqual(diagnostic.data.inputChannelTimeline, [{ kind: 'open', message: '[INPUT-DC] DataChannel open' }]);
  assert.deepEqual(diagnostic.data.probeResults, []);
  assert.equal('keyboardMode' in diagnostic.data, false);
  assert.match(diagnostic.data.connectionAttemptId, /^attempt-/);
  assert.match(diagnostic.data.receivedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('diagnostic relay preserves attempt metadata and recommendation context', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);

  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  io.connect(host);
  io.connect(viewer);

  viewer.trigger('diagnostic', {
    type: 'connection-diagnostic',
    schemaVersion: 3,
    connectionAttemptId: 'attempt-socket-1',
    mode: 'auto',
    entrypoint: 'https://link.stockhub.wiki',
    traceSummary: { trigger: 'auto-failure', reason: 'direct-failed-suggest-relay' },
    recommendation: { nextSuggestedMode: 'relay', severity: 'warning' },
    events: [{ kind: 'ice-state', value: 'failed' }],
  });

  const diagnostic = host.sent.filter((message) => message.event === 'diagnostic').at(-1);

  assert.equal(diagnostic.data.type, 'connection-diagnostic');
  assert.equal(diagnostic.data.schemaVersion, 3);
  assert.equal(diagnostic.data.connectionAttemptId, 'attempt-socket-1');
  assert.equal(diagnostic.data.mode, 'auto');
  assert.equal(diagnostic.data.entrypoint, 'https://link.stockhub.wiki');
  assert.equal(diagnostic.data.traceSummary.reason, 'direct-failed-suggest-relay');
  assert.equal(diagnostic.data.recommendation.nextSuggestedMode, 'relay');
  assert.deepEqual(diagnostic.data.events, [{ kind: 'ice-state', value: 'failed' }]);
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

test('input is not relayed before control transition ack, then valid v2 input relays once', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  io.connect(host);
  io.connect(viewer);

  viewer.trigger('control-acquire', { requestId: 'req-1' });
  viewer.trigger('input', v2Key());
  assert.equal(host.sent.some((entry) => entry.event === 'input'), false);

  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const granted = viewer.sent.find((entry) => entry.event === 'control-grant').data;
  viewer.trigger('input', v2Key({ leaseId: granted.leaseId, leaseEpoch: granted.leaseEpoch }));
  assert.equal(host.sent.filter((entry) => entry.event === 'input').length, 1);
});

test('legacy input lazily acquires control and stays blocked until host ack', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, {
    makeLeaseId: () => 'lease-000000000001',
  });
  const host = new FakeSocket('host-1', 'host');
  const viewerA = new FakeSocket('viewer-a', 'viewer');
  const viewerB = new FakeSocket('viewer-b', 'viewer');
  io.connect(host);
  io.connect(viewerA);
  io.connect(viewerB);

  const legacyInput = {
    type: 'keyboard',
    action: 'keydown',
    payload: { key: 'a', code: 'KeyA' },
  };
  viewerA.trigger('input', legacyInput);
  viewerB.trigger('input', legacyInput);
  assert.equal(host.sent.some((entry) => entry.event === 'input'), false);
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });

  assert.equal(host.sent.filter((entry) => entry.event === 'input').length, 1);
  assert.equal(host.sent.filter((entry) => entry.event === 'input').at(-1).data.viewerId, 'viewer-a');
  viewerB.trigger('input', legacyInput);
  assert.equal(host.sent.filter((entry) => entry.event === 'input').length, 1);
});

test('pending legacy input queue retains only the first input during granting', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  io.connect(host);
  io.connect(viewer);

  viewer.trigger('input', { type: 'keyboard', action: 'keydown', payload: { key: 'first', code: 'KeyA' } });
  viewer.trigger('input', { type: 'keyboard', action: 'keyup', payload: { key: 'second', code: 'KeyA' } });
  viewer.trigger('input', { type: 'keyboard', action: 'keydown', payload: { key: 'third', code: 'KeyA' } });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });

  const relayed = host.sent.filter((entry) => entry.event === 'input');
  assert.equal(relayed.length, 1);
  assert.equal(relayed[0].data.payload.key, 'first');
});

test('disconnect clears pending legacy input before transition ack', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  io.connect(host);
  io.connect(viewer);
  viewer.trigger('input', { type: 'keyboard', action: 'keydown', payload: { key: 'stale', code: 'KeyA' } });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  viewer.trigger('disconnect');
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  assert.equal(host.sent.some((entry) => entry.event === 'input'), false);
});

test('rejected transition clears pending legacy input and cannot replay on late ack', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  io.connect(host);
  io.connect(viewer);
  viewer.trigger('input', { type: 'keyboard', action: 'keydown', payload: { key: 'stale', code: 'KeyA' } });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'rejected', reason: 'reset-failed' });
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  assert.equal(host.sent.some((entry) => entry.event === 'input'), false);
});

test('takeover freezes controller A until host ack and grants B', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: (() => { let n = 0; return () => `lease-${String(++n).padStart(16, '0')}`; })() });
  const host = new FakeSocket('host-1', 'host');
  const viewerA = new FakeSocket('viewer-a', 'viewer');
  const viewerB = new FakeSocket('viewer-b', 'viewer');
  io.connect(host); io.connect(viewerA); io.connect(viewerB);
  viewerA.trigger('control-acquire', { requestId: 'a' });
  let transition = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const grantA = viewerA.sent.find((entry) => entry.event === 'control-grant').data;
  viewerB.trigger('control-acquire', { requestId: 'b', takeover: true });
  viewerA.trigger('input', v2Key({ leaseId: grantA.leaseId, leaseEpoch: grantA.leaseEpoch }));
  assert.equal(host.sent.filter((entry) => entry.event === 'input').length, 0);
  transition = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const grantB = viewerB.sent.find((entry) => entry.event === 'control-grant').data;
  viewerB.trigger('input', v2Key({ leaseId: grantB.leaseId, leaseEpoch: grantB.leaseEpoch }));
  assert.equal(host.sent.filter((entry) => entry.event === 'input').length, 1);
});

test('control logs redact lease token and text payload', () => {
  resetConnections();
  const io = makeIo();
  const lines = [];
  setupSignaling(io, { logger: { log: (...values) => lines.push(values.join(' ')), warn() {}, info() {}, error() {} }, makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  io.connect(host); io.connect(viewer);
  viewer.trigger('control-acquire', { requestId: 'req' });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const grant = viewer.sent.find((entry) => entry.event === 'control-grant').data;
  viewer.trigger('input', v2Key({ leaseId: grant.leaseId, leaseEpoch: grant.leaseEpoch, action: 'text', payload: { text: 'SecretText' } }));
  const text = lines.join('\n');
  assert.equal(text.includes(grant.leaseId), false);
  assert.equal(text.includes('SecretText'), false);
});
