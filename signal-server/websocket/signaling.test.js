const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { signAccessToken } = require('../lib/auth');
const { setupTerminal } = require('./terminal');

process.env.JWT_SECRET = process.env.JWT_SECRET || '12345678';
process.env.ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || 'test-viewer-password';
process.env.HOST_PASSWORD = process.env.HOST_PASSWORD || 'test-host-password';

const {
  setupSignaling,
  connections,
  clearHostCapabilities,
  getHostCapabilities,
} = require('./signaling');

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
  clearHostCapabilities();
}

test('standalone relay-viewer cannot stop host tunnel relay stream', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);

  const host = new FakeSocket('host-1', 'host');
  const relayViewer = new FakeSocket('relay-1', 'relay-viewer');
  io.connect(host);
  io.connect(relayViewer);

  relayViewer.trigger('disconnect');

  assert.equal(connections.relayViewers.has('relay-1'), false);
  assert.equal(host.sent.some((message) => message.event === 'relay-stream-control'), false);
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

test('v2 viewers cannot forward unleased media writes and active media writes are bounded', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-v2', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host);
  io.connect(viewer);

  viewer.trigger('media-profile-change', { profile: 'high', width: 99999, height: 99999 });
  viewer.trigger('resolution-change', { width: 99999, height: 99999 });
  assert.equal(host.sent.some((entry) => entry.event === 'media-profile-change' || entry.event === 'resolution-change'), false);

  viewer.trigger('control-acquire', { requestId: 'media-control' });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const grant = viewer.sent.find((entry) => entry.event === 'control-grant').data;
  const lease = { schemaVersion: 2, leaseId: grant.leaseId, leaseEpoch: grant.leaseEpoch };
  viewer.trigger('media-profile-change', { ...lease, profile: 'high', width: 99999, height: 99999, targetFps: 99, videoBitrateKbps: 99999 });
  viewer.trigger('resolution-change', { ...lease, width: 99999, height: 99999 });

  const profile = host.sent.filter((entry) => entry.event === 'media-profile-change').at(-1).data;
  const resolution = host.sent.filter((entry) => entry.event === 'resolution-change').at(-1).data;
  assert.deepEqual([profile.width, profile.height, profile.targetFps, profile.videoBitrateKbps], [1920, 1080, 30, 5000]);
  assert.deepEqual([resolution.width, resolution.height], [1920, 1080]);
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

test('v2 host acknowledgement forwards every documented error status without raw input data', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  io.connect(host);
  io.connect(viewer);
  const statuses = ['stale-lease', 'sequence-gap', 'resync-required', 'invalid-input', 'unsupported-code', 'execution-failed'];

  for (const [index, status] of statuses.entries()) {
    host.trigger('input-ack', {
      viewerId: 'viewer-1',
      schemaVersion: 2,
      leaseEpoch: 12,
      appliedSeq: index,
      status,
      pressedKeyCount: 0,
      modifierMask: 0,
      inputIds: [`input-${index}`],
      payload: { key: 'SecretKey' },
    });
  }

  const acks = viewer.sent.filter((message) => message.event === 'input-ack').map((message) => message.data);
  assert.deepEqual(acks.map((ack) => ack.status), statuses);
  acks.forEach((ack) => {
    assert.equal('payload' in ack, false);
    assert.equal('key' in ack, false);
  });
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
  host.handshake.auth.inputProtocolVersion = 2;
  owner.handshake.auth.inputProtocolVersion = 2;
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
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
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

test('fresh v2 tunnel input matches the Host transition lease without leaking it to viewers or logs', () => {
  resetConnections();
  const io = makeIo();
  const lines = [];
  setupSignaling(io, {
    logger: { log: (...values) => lines.push(values.join(' ')), warn: () => {}, info: () => {}, error: () => {} },
    makeLeaseId: () => 'lease-000000000001',
  });
  const host = new FakeSocket('host-tunnel-v2', 'host');
  const viewer = new FakeSocket('viewer-tunnel-v2', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host); io.connect(viewer);

  viewer.trigger('control-acquire', { requestId: 'tunnel-v2' });
  const hostTransition = host.sent.find((entry) => entry.event === 'control-transition').data;
  assert.equal(hostTransition.leaseId, 'lease-000000000001');
  host.trigger('control-transition-ack', { leaseEpoch: hostTransition.leaseEpoch, status: 'applied' });
  const grant = viewer.sent.find((entry) => entry.event === 'control-grant').data;
  assert.equal(grant.leaseId, hostTransition.leaseId);

  viewer.trigger('input', v2Key({
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  }));
  const input = host.sent.filter((entry) => entry.event === 'input').at(-1).data;
  assert.equal(input.leaseId, hostTransition.leaseId);
  assert.equal(input.leaseEpoch, hostTransition.leaseEpoch);
  assert.equal(JSON.stringify(viewer.sent.filter((entry) => entry.event === 'control-state')).includes(grant.leaseId), false);
  assert.equal(lines.join('\n').includes(grant.leaseId), false);
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

test('legacy direct offer and tunnel input share one lazy lease', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('legacy-main', 'viewer');
  io.connect(host); io.connect(viewer);

  viewer.trigger('offer', { offer: { type: 'offer', sdp: 'v=0' }, epoch: 1 });
  viewer.trigger('input', { type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } });
  assert.equal(host.sent.filter((entry) => entry.event === 'control-transition').length, 1);
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });

  assert.equal(host.sent.filter((entry) => entry.event === 'offer').length, 1);
  assert.equal(host.sent.filter((entry) => entry.event === 'input').length, 1);
  assert.equal(host.sent.filter((entry) => entry.event === 'offer').at(-1).data.leaseEpoch, transition.leaseEpoch);
});

test('legacy relay-viewer is a media companion and cannot acquire a second controller', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const mainViewer = new FakeSocket('legacy-main', 'viewer');
  const relayViewer = new FakeSocket('legacy-relay', 'relay-viewer');
  io.connect(host); io.connect(mainViewer); io.connect(relayViewer);

  relayViewer.trigger('input', { type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } });
  assert.equal(host.sent.some((entry) => entry.event === 'control-transition'), false);
  mainViewer.trigger('input', { type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } });
  assert.equal(host.sent.filter((entry) => entry.event === 'control-transition').length, 1);
});

test('legacy relay companion binds after its only main viewer receives a lazy lease', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const mainViewer = new FakeSocket('legacy-main', 'viewer');
  const relayViewer = new FakeSocket('legacy-relay', 'relay-viewer');
  io.connect(host); io.connect(mainViewer); io.connect(relayViewer);

  relayViewer.trigger('relay-stream-control', { enabled: true, width: 960, height: 540 });
  assert.equal(host.sent.some((entry) => entry.event === 'relay-stream-control'), false);

  mainViewer.trigger('input', { type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  relayViewer.trigger('relay-stream-control', { enabled: true, width: 960, height: 540 });

  assert.deepEqual(host.sent.filter((entry) => entry.event === 'relay-stream-control').at(-1).data, {
    enabled: true,
    width: 960,
    height: 540,
    viewerId: 'legacy-main',
  });
  host.trigger('relay-frame', { viewerId: 'legacy-main', frameId: 1, data: 'frame' });
  assert.equal(relayViewer.sent.filter((entry) => entry.event === 'relay-frame').length, 1);
  relayViewer.trigger('relay-frame-ack', { frameId: 1 });
  assert.deepEqual(host.sent.filter((entry) => entry.event === 'relay-frame-ack').at(-1).data, {
    frameId: 1,
    viewerId: 'legacy-main',
  });
});

test('legacy relay-viewer remains unbound when more than one main viewer is online', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const mainViewer = new FakeSocket('legacy-main', 'viewer');
  const observer = new FakeSocket('legacy-observer', 'viewer');
  const relayViewer = new FakeSocket('legacy-relay', 'relay-viewer');
  io.connect(host); io.connect(mainViewer); io.connect(observer); io.connect(relayViewer);

  mainViewer.trigger('input', { type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  relayViewer.trigger('relay-stream-control', { enabled: true });

  assert.equal(host.sent.some((entry) => entry.event === 'relay-stream-control'), false);
});

test('legacy relay companion ambiguity stops the host relay and rejects later frames', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const mainViewer = new FakeSocket('legacy-main', 'viewer');
  const relayViewer = new FakeSocket('legacy-relay', 'relay-viewer');
  io.connect(host); io.connect(mainViewer); io.connect(relayViewer);

  mainViewer.trigger('input', { type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  relayViewer.trigger('relay-stream-control', { enabled: true });
  const relayedFramesBefore = relayViewer.sent.filter((entry) => entry.event === 'relay-frame').length;
  const mainFramesBefore = mainViewer.sent.filter((entry) => entry.event === 'relay-frame').length;

  io.connect(new FakeSocket('legacy-observer', 'viewer'));
  assert.deepEqual(host.sent.filter((entry) => entry.event === 'relay-stream-control').at(-1).data, {
    enabled: false,
    viewerId: 'legacy-main',
  });
  host.trigger('relay-frame', { viewerId: 'legacy-main', frameId: 2, data: 'stale' });
  assert.equal(relayViewer.sent.filter((entry) => entry.event === 'relay-frame').length, relayedFramesBefore);
  assert.equal(mainViewer.sent.filter((entry) => entry.event === 'relay-frame').length, mainFramesBefore);
});

test('legacy controller disconnect stops its bound relay companion and rejects later frames', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const mainViewer = new FakeSocket('legacy-main', 'viewer');
  const relayViewer = new FakeSocket('legacy-relay', 'relay-viewer');
  io.connect(host); io.connect(mainViewer); io.connect(relayViewer);

  mainViewer.trigger('input', { type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  relayViewer.trigger('relay-stream-control', { enabled: true });
  const relayedFramesBefore = relayViewer.sent.filter((entry) => entry.event === 'relay-frame').length;

  mainViewer.trigger('disconnect');
  assert.deepEqual(host.sent.filter((entry) => entry.event === 'relay-stream-control').at(-1).data, {
    enabled: false,
    viewerId: 'legacy-main',
  });
  host.trigger('relay-frame', { viewerId: 'legacy-main', frameId: 2, data: 'stale' });
  assert.equal(relayViewer.sent.filter((entry) => entry.event === 'relay-frame').length, relayedFramesBefore);
});

test('v2 main viewer relay control remains strictly lease-authorized', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-v2', 'host');
  const viewer = new FakeSocket('viewer-v2', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host); io.connect(viewer);

  viewer.trigger('relay-stream-control', { schemaVersion: 2, enabled: true });
  assert.equal(host.sent.some((entry) => entry.event === 'relay-stream-control'), false);
  viewer.trigger('control-acquire', { requestId: 'relay-v2' });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const grant = viewer.sent.find((entry) => entry.event === 'control-grant').data;
  viewer.trigger('relay-stream-control', {
    schemaVersion: 2, enabled: true, leaseId: grant.leaseId, leaseEpoch: grant.leaseEpoch,
  });

  assert.deepEqual(host.sent.filter((entry) => entry.event === 'relay-stream-control').at(-1).data, {
    schemaVersion: 2, enabled: true, leaseId: grant.leaseId, leaseEpoch: grant.leaseEpoch,
    viewerId: 'viewer-v2',
  });
  host.trigger('relay-frame', { viewerId: 'viewer-v2', frameId: 1, data: 'v2-frame' });
  assert.equal(viewer.sent.filter((entry) => entry.event === 'relay-frame').length, 1);
});

test('legacy relay companion stops forwarding while a v2 takeover reset is pending', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: (() => { let n = 0; return () => `lease-${String(++n).padStart(16, '0')}`; })() });
  const host = new FakeSocket('host-v2', 'host');
  host.handshake.auth.inputProtocolVersion = 2;
  const mainViewer = new FakeSocket('legacy-main', 'viewer');
  const relayViewer = new FakeSocket('legacy-relay', 'relay-viewer');
  io.connect(host); io.connect(mainViewer); io.connect(relayViewer);

  mainViewer.trigger('input', { type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } });
  let transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  relayViewer.trigger('relay-stream-control', { enabled: true });
  assert.equal(host.sent.filter((entry) => entry.event === 'relay-stream-control').length, 1);

  const v2Viewer = new FakeSocket('viewer-v2', 'viewer');
  v2Viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(v2Viewer);
  v2Viewer.trigger('control-acquire', { requestId: 'take-legacy', takeover: true });
  transition = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
  assert.equal(transition.reason, 'legacy-takeover');
  assert.deepEqual(host.sent.filter((entry) => entry.event === 'relay-stream-control').at(-1).data, {
    enabled: false,
    viewerId: 'legacy-main',
  });
  relayViewer.trigger('relay-stream-control', { enabled: true });

  assert.equal(host.sent.filter((entry) => entry.event === 'relay-stream-control').length, 2);
});

test('legacy controller disconnect sends a reset-only transition for its active lease', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('legacy-main', 'viewer');
  io.connect(host); io.connect(viewer);

  viewer.trigger('input', { type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } });
  const grantTransition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: grantTransition.leaseEpoch, status: 'applied' });
  viewer.trigger('disconnect');

  const resetTransition = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
  assert.equal(resetTransition.type, 'control-transition');
  assert.equal(resetTransition.reason, 'controller-disconnect');
  assert.equal(resetTransition.leaseEpoch > grantTransition.leaseEpoch, true);
  assert.equal(Object.hasOwn(resetTransition, 'leaseId'), false);
  assert.equal(Object.hasOwn(resetTransition, 'viewerId'), false);
});

test('ACTIVE controller disconnect stays REVOKING until matching applied ack', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, {
    makeLeaseId: (() => {
      let n = 0;
      return () => `lease-${String(++n).padStart(16, '0')}`;
    })(),
  });
  const host = new FakeSocket('host-1', 'host');
  const viewerA = new FakeSocket('viewer-a', 'viewer');
  const viewerB = new FakeSocket('viewer-b', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewerA.handshake.auth.inputProtocolVersion = 2;
  viewerB.handshake.auth.inputProtocolVersion = 2;
  io.connect(host); io.connect(viewerA); io.connect(viewerB);

  viewerA.trigger('control-acquire', { requestId: 'a' });
  let transition = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const grantA = viewerA.sent.find((entry) => entry.event === 'control-grant').data;

  viewerA.trigger('disconnect');
  const resetTransition = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
  assert.equal(resetTransition.reason, 'controller-disconnect');
  assert.equal(resetTransition.leaseEpoch > grantA.leaseEpoch, true);
  assert.equal(Object.hasOwn(resetTransition, 'leaseId'), false);

  const stateAfterDisconnect = viewerB.sent.filter((entry) => entry.event === 'control-state').at(-1).data;
  assert.equal(stateAfterDisconnect.state, 'REVOKING');
  assert.equal(stateAfterDisconnect.pendingViewerId, null);
  assert.equal(stateAfterDisconnect.controllerViewerId, null);

  // New acquire blocked before reset ack.
  viewerB.trigger('control-acquire', { requestId: 'blocked' });
  const blocked = viewerB.sent.filter((entry) => entry.event === 'control-acquire-result').at(-1).data;
  assert.equal(blocked.state, 'REVOKING');
  assert.equal(blocked.reason, 'occupied');

  // Old credential writes fail after disconnect.
  viewerA.trigger('input', v2Key({
    leaseId: grantA.leaseId,
    leaseEpoch: grantA.leaseEpoch,
  }));
  assert.equal(host.sent.filter((entry) => entry.event === 'input').length, 0);

  // Late same-epoch applied cannot free the barrier.
  host.trigger('control-transition-ack', {
    leaseEpoch: grantA.leaseEpoch,
    status: 'applied',
  });
  assert.equal(
    viewerB.sent.filter((entry) => entry.event === 'control-state').at(-1).data.state,
    'REVOKING',
  );

  // Matching applied ack releases to FREE.
  host.trigger('control-transition-ack', {
    leaseEpoch: resetTransition.leaseEpoch,
    status: 'applied',
  });
  assert.equal(
    viewerB.sent.filter((entry) => entry.event === 'control-state').at(-1).data.state,
    'FREE',
  );
  viewerB.trigger('control-acquire', { requestId: 'after-reset' });
  transition = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
  assert.equal(transition.viewerId, 'viewer-b');
});

test('ACTIVE controller disconnect rejected reset retries same epoch and stays blocked after timeout path', () => {
  resetConnections();
  const io = makeIo();
  const timers = new Map();
  let nextTimerId = 1;
  let now = 0;
  const setTimeoutFn = (fn, delay) => {
    const id = nextTimerId++;
    timers.set(id, { fn, due: now + delay });
    return id;
  };
  const clearTimeoutFn = (id) => { timers.delete(id); };
  const advance = (ms) => {
    const target = now + ms;
    while (timers.size > 0) {
      let nextDue = Infinity;
      for (const t of timers.values()) nextDue = Math.min(nextDue, t.due);
      if (nextDue > target) break;
      now = nextDue;
      for (const [id, t] of [...timers.entries()].filter(([, t]) => t.due <= now)) {
        timers.delete(id);
        t.fn();
      }
    }
    now = target;
  };
  setupSignaling(io, {
    makeLeaseId: () => 'lease-000000000001',
    scheduler: {
      setInterval: () => ({ unref() {} }),
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
    },
  });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-a', 'viewer');
  const viewerB = new FakeSocket('viewer-b', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  viewerB.handshake.auth.inputProtocolVersion = 2;
  io.connect(host); io.connect(viewer); io.connect(viewerB);

  viewer.trigger('control-acquire', { requestId: 'a' });
  const grantTransition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', {
    leaseEpoch: grantTransition.leaseEpoch,
    status: 'applied',
  });
  viewer.trigger('disconnect');
  const resetTransition = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
  const epoch = resetTransition.leaseEpoch;

  host.trigger('control-transition-ack', {
    leaseEpoch: epoch,
    status: 'rejected',
    reason: 'reset-failed',
  });
  assert.equal(
    viewerB.sent.filter((entry) => entry.event === 'control-state').at(-1).data.state,
    'REVOKING',
  );

  const transitionsBefore = host.sent.filter((entry) => entry.event === 'control-transition').length;
  advance(1000);
  advance(2000);
  advance(4000);
  const retries = host.sent
    .filter((entry) => entry.event === 'control-transition')
    .slice(transitionsBefore);
  assert.equal(retries.length, 3);
  assert.equal(retries.every((entry) => entry.data.leaseEpoch === epoch), true);
  assert.equal(retries.every((entry) => entry.data.leaseId === undefined), true);
  assert.equal(retries.every((entry) => entry.data.viewerId === undefined), true);

  viewerB.trigger('control-acquire', { requestId: 'still-blocked' });
  const blocked = viewerB.sent.filter((entry) => entry.event === 'control-acquire-result').at(-1).data;
  assert.equal(blocked.state, 'REVOKING');
  assert.equal(blocked.reason, 'occupied');
});

test('v2 activation advertises capabilities and refuses an older host', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-v1', 'host');
  const viewer = new FakeSocket('viewer-v2', 'viewer');
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host);
  io.connect(viewer);

  assert.deepEqual(host.sent.find((entry) => entry.event === 'connected').data, {
    role: 'host', status: 'ok', inputProtocolVersion: 1,
  });
  assert.deepEqual(viewer.sent.find((entry) => entry.event === 'connected').data, {
    role: 'viewer', status: 'ok', hostOnline: true,
    inputProtocolVersion: 2, hostInputProtocolVersion: 1,
    hostCapabilities: {
      turnReady: false,
      turnFingerprint: '',
      supportsSessionTurn: false,
      updatedAt: null,
    },
  });

  viewer.trigger('control-acquire', { requestId: 'v2-on-v1' });
  assert.deepEqual(viewer.sent.filter((entry) => entry.event === 'control-acquire-result').at(-1).data, {
    state: 'FREE', reason: 'host-protocol-too-old', requestId: 'v2-on-v1',
  });
  assert.equal(host.sent.some((entry) => entry.event === 'control-transition'), false);
});

test('host-capabilities are cached and forwarded to viewers; offer includes networkMode', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-turn', 'host');
  host.handshake.auth.inputProtocolVersion = 2;
  const viewer = new FakeSocket('viewer-turn', 'viewer');
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host);
  io.connect(viewer);

  host.trigger('host-capabilities', {
    turnReady: true,
    turnFingerprint: 'abc123',
    supportsSessionTurn: true,
  });

  const caps = getHostCapabilities();
  assert.equal(caps.turnReady, true);
  assert.equal(caps.turnFingerprint, 'abc123');
  assert.equal(caps.supportsSessionTurn, true);
  assert.ok(caps.updatedAt);

  const fanout = viewer.sent.filter((entry) => entry.event === 'host-capabilities').at(-1);
  assert.deepEqual(fanout.data.turnReady, true);
  assert.equal(fanout.data.turnFingerprint, 'abc123');

  // grant control so v2 offer can pass authorizeViewer
  viewer.trigger('control-acquire', { requestId: 'turn-offer' });
  const transition = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const grant = viewer.sent.filter((entry) => entry.event === 'control-grant').at(-1).data;

  viewer.trigger('offer', {
    offer: { type: 'offer', sdp: 'v=0' },
    epoch: 1,
    schemaVersion: 2,
    networkMode: 'relay',
    iceMode: 'relay',
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });

  const forwarded = host.sent.filter((entry) => entry.event === 'offer').at(-1);
  assert.ok(forwarded);
  assert.equal(forwarded.data.networkMode, 'relay');
  assert.equal(forwarded.data.iceMode, 'relay');
  assert.equal(forwarded.data.viewerId, viewer.id);
});

test('legacy controller is single-writer and a v2 takeover resets it before grant', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: (() => { let n = 0; return () => `lease-${String(++n).padStart(16, '0')}`; })() });
  const host = new FakeSocket('host-v2', 'host');
  host.handshake.auth.inputProtocolVersion = 2;
  const legacyViewer = new FakeSocket('legacy-viewer', 'viewer');
  const secondLegacyViewer = new FakeSocket('legacy-readonly', 'viewer');
  const v2Viewer = new FakeSocket('v2-viewer', 'viewer');
  v2Viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host); io.connect(legacyViewer); io.connect(secondLegacyViewer); io.connect(v2Viewer);

  const legacyInput = { type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } };
  legacyViewer.trigger('input', legacyInput);
  let transition = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  assert.equal(host.sent.filter((entry) => entry.event === 'input').length, 1);

  secondLegacyViewer.trigger('input', legacyInput);
  assert.equal(host.sent.filter((entry) => entry.event === 'input').length, 1);
  assert.equal(secondLegacyViewer.sent.some((entry) => entry.event === 'control-grant'), false);

  v2Viewer.trigger('control-acquire', { requestId: 'take-legacy', takeover: true });
  transition = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
  assert.equal(transition.reason, 'legacy-takeover');
  assert.equal(v2Viewer.sent.some((entry) => entry.event === 'control-grant'), false);
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  assert.equal(v2Viewer.sent.some((entry) => entry.event === 'control-grant'), true);
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

test('rejected transition stays fail-closed in REVOKING and cannot replay on late ack', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  const viewerB = new FakeSocket('viewer-2', 'viewer');
  io.connect(host);
  io.connect(viewer);
  io.connect(viewerB);
  viewer.trigger('input', { type: 'keyboard', action: 'keydown', payload: { key: 'stale', code: 'KeyA' } });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'rejected', reason: 'reset-failed' });
  const state = viewer.sent.filter((entry) => entry.event === 'control-state').at(-1).data;
  assert.equal(state.state, 'REVOKING');
  assert.equal(state.reason, 'reset-failed');
  assert.equal(state.pendingViewerId, null);
  assert.equal(viewer.sent.some((entry) => entry.event === 'control-grant'), false);
  assert.equal(host.sent.some((entry) => entry.event === 'input'), false);

  // Late applied on the discarded candidate epoch must not free or grant.
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  assert.equal(viewer.sent.filter((entry) => entry.event === 'control-state').at(-1).data.state, 'REVOKING');
  assert.equal(viewer.sent.some((entry) => entry.event === 'control-grant'), false);
  assert.equal(host.sent.some((entry) => entry.event === 'input'), false);

  // New acquire stays blocked while the reset-only barrier is unresolved.
  viewerB.trigger('control-acquire', { requestId: 'blocked-while-reset' });
  const acquire = viewerB.sent.filter((entry) => entry.event === 'control-acquire-result').at(-1).data;
  assert.equal(acquire.state, 'REVOKING');
  assert.equal(acquire.reason, 'occupied');
});

test('takeover freezes controller A until host ack and grants B', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: (() => { let n = 0; return () => `lease-${String(++n).padStart(16, '0')}`; })() });
  const host = new FakeSocket('host-1', 'host');
  const viewerA = new FakeSocket('viewer-a', 'viewer');
  const viewerB = new FakeSocket('viewer-b', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewerA.handshake.auth.inputProtocolVersion = 2;
  viewerB.handshake.auth.inputProtocolVersion = 2;
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

test('lease expiry sends a newer reset-only transition before releasing host state', () => {
  resetConnections();
  let currentTime = 0;
  let tick = null;
  const io = makeIo();
  setupSignaling(io, {
    now: () => currentTime,
    makeLeaseId: () => 'lease-000000000001',
    scheduler: {
      setInterval(callback) {
        tick = callback;
        return { unref() {} };
      },
    },
  });
  const host = new FakeSocket('host-expiry', 'host');
  const viewer = new FakeSocket('viewer-expiry', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host); io.connect(viewer);

  viewer.trigger('control-acquire', { requestId: 'expiry' });
  const grantTransition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: grantTransition.leaseEpoch, status: 'applied' });
  const grant = viewer.sent.find((entry) => entry.event === 'control-grant').data;
  viewer.trigger('input', v2Key({ leaseId: grant.leaseId, leaseEpoch: grant.leaseEpoch }));
  assert.equal(host.sent.filter((entry) => entry.event === 'input').length, 1);

  currentTime = 12_000;
  tick();
  const resetTransition = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
  assert.deepEqual(resetTransition, {
    type: 'control-transition',
    leaseEpoch: grant.leaseEpoch + 1,
    reason: 'lease-expired',
  });
  assert.equal(JSON.stringify(resetTransition).includes(grant.leaseId), false);

  viewer.trigger('input', v2Key({ leaseId: grant.leaseId, leaseEpoch: grant.leaseEpoch, seq: 2 }));
  assert.equal(host.sent.filter((entry) => entry.event === 'input').length, 1);
  host.trigger('control-transition-ack', { leaseEpoch: resetTransition.leaseEpoch, status: 'applied' });
  const state = viewer.sent.filter((entry) => entry.event === 'control-state').at(-1).data;
  assert.equal(state.state, 'FREE');
  assert.equal(JSON.stringify(state).includes(grant.leaseId), false);
});

test('heartbeat expiry is dispatched once before a later scheduler tick and keeps the reset barrier', () => {
  resetConnections();
  let currentTime = 0;
  let tick = null;
  const io = makeIo();
  setupSignaling(io, {
    now: () => currentTime,
    makeLeaseId: (() => { let n = 0; return () => `lease-${String(++n).padStart(16, '0')}`; })(),
    scheduler: {
      setInterval(callback) {
        tick = callback;
        return { unref() {} };
      },
    },
  });
  const host = new FakeSocket('host-expiry-race', 'host');
  const viewerA = new FakeSocket('viewer-expiry-a', 'viewer');
  const viewerB = new FakeSocket('viewer-expiry-b', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewerA.handshake.auth.inputProtocolVersion = 2;
  viewerB.handshake.auth.inputProtocolVersion = 2;
  io.connect(host); io.connect(viewerA); io.connect(viewerB);

  viewerA.trigger('control-acquire', { requestId: 'a' });
  const grantTransition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: grantTransition.leaseEpoch, status: 'applied' });
  const grantA = viewerA.sent.find((entry) => entry.event === 'control-grant').data;

  currentTime = 12_000;
  viewerA.trigger('control-heartbeat', { leaseId: grantA.leaseId, leaseEpoch: grantA.leaseEpoch });
  tick();
  const resetTransitions = host.sent.filter((entry) => entry.event === 'control-transition')
    .filter((entry) => entry.data.reason === 'lease-expired');
  assert.equal(resetTransitions.length, 1);
  assert.deepEqual(resetTransitions[0].data, {
    type: 'control-transition',
    leaseEpoch: grantA.leaseEpoch + 1,
    reason: 'lease-expired',
  });
  assert.equal(JSON.stringify(resetTransitions[0].data).includes(grantA.leaseId), false);

  viewerA.trigger('input', v2Key({ leaseId: grantA.leaseId, leaseEpoch: grantA.leaseEpoch }));
  assert.equal(host.sent.some((entry) => entry.event === 'input'), false);
  viewerB.trigger('control-acquire', { requestId: 'b' });
  assert.equal(viewerB.sent.filter((entry) => entry.event === 'control-acquire-result').at(-1).data.state, 'REVOKING');

  currentTime = 15_000;
  tick();
  viewerB.trigger('control-acquire', { requestId: 'b-after-timeout' });
  assert.equal(viewerB.sent.filter((entry) => entry.event === 'control-acquire-result').at(-1).data.state, 'REVOKING');

  host.trigger('control-transition-ack', { leaseEpoch: resetTransitions[0].data.leaseEpoch, status: 'applied' });
  assert.equal(viewerA.sent.filter((entry) => entry.event === 'control-state').at(-1).data.state, 'FREE');
});

test('control logs redact lease token and text payload', () => {
  resetConnections();
  const io = makeIo();
  const lines = [];
  setupSignaling(io, { logger: { log: (...values) => lines.push(values.join(' ')), warn() {}, info() {}, error() {} }, makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
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


test('blocked reset cannot grant a new controller and retries are same-epoch bounded', () => {
  resetConnections();
  const io = makeIo();
  const timers = new Map();
  let nextTimerId = 1;
  let now = 0;
  const setTimeoutFn = (fn, delay) => {
    const id = nextTimerId++;
    timers.set(id, { fn, due: now + delay });
    return id;
  };
  const clearTimeoutFn = (id) => { timers.delete(id); };
  const advance = (ms) => {
    const target = now + ms;
    while (timers.size > 0) {
      let nextDue = Infinity;
      for (const t of timers.values()) nextDue = Math.min(nextDue, t.due);
      if (nextDue > target) break;
      now = nextDue;
      for (const [id, t] of [...timers.entries()].filter(([, t]) => t.due <= now)) {
        timers.delete(id);
        t.fn();
      }
    }
    now = target;
  };
  const events = [];
  setupSignaling(io, {
    makeLeaseId: () => 'lease-000000000001',
    scheduler: { setInterval: () => ({ unref() {} }), setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn },
    structuredLogger: { info: (payload) => events.push(payload) },
  });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  const viewerB = new FakeSocket('viewer-2', 'viewer');
  io.connect(host);
  io.connect(viewer);
  io.connect(viewerB);

  viewer.trigger('control-acquire', { requestId: 'a1' });
  const first = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', {
    leaseEpoch: first.leaseEpoch, status: 'rejected', reason: 'reset-failed',
  });
  const blockedState = viewer.sent.filter((entry) => entry.event === 'control-state').at(-1).data;
  assert.equal(blockedState.state, 'REVOKING');
  assert.equal(blockedState.pendingViewerId, null);
  const barrierEpoch = blockedState.leaseEpoch;
  assert.equal(Number.isSafeInteger(barrierEpoch), true);

  const transitionsBefore = host.sent.filter((entry) => entry.event === 'control-transition').length;
  advance(1000);
  advance(2000);
  advance(4000);
  const retries = host.sent.filter((entry) => entry.event === 'control-transition').slice(transitionsBefore);
  assert.equal(retries.length, 3);
  assert.equal(retries.every((entry) => entry.data.leaseEpoch === barrierEpoch), true);
  assert.equal(retries.every((entry) => entry.data.leaseId === undefined), true);
  assert.equal(events.some((e) => e.type === 'control_reset_blocked'), true);

  const afterBlocked = viewer.sent.filter((entry) => entry.event === 'control-state').at(-1).data;
  assert.equal(afterBlocked.state, 'REVOKING');
  assert.equal(afterBlocked.reason, 'reset-blocked');

  viewerB.trigger('control-acquire', { requestId: 'should-block' });
  const acquire = viewerB.sent.filter((entry) => entry.event === 'control-acquire-result').at(-1).data;
  assert.equal(acquire.state, 'REVOKING');
  assert.equal(acquire.reason, 'occupied');

  // No timer storm after blocked.
  const timerCount = timers.size;
  advance(60_000);
  assert.equal(timers.size, timerCount);
});

test('applied reset-only ack cancels retries and frees the barrier', () => {
  resetConnections();
  const io = makeIo();
  const timers = new Map();
  let nextTimerId = 1;
  let now = 0;
  const setTimeoutFn = (fn, delay) => {
    const id = nextTimerId++;
    timers.set(id, { fn, due: now + delay });
    return id;
  };
  const clearTimeoutFn = (id) => { timers.delete(id); };
  setupSignaling(io, {
    makeLeaseId: () => 'lease-000000000001',
    scheduler: { setInterval: () => ({ unref() {} }), setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn },
  });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  io.connect(host);
  io.connect(viewer);
  viewer.trigger('control-acquire', { requestId: 'a1' });
  const first = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', {
    leaseEpoch: first.leaseEpoch, status: 'rejected', reason: 'reset-failed',
  });
  const epoch = viewer.sent.filter((entry) => entry.event === 'control-state').at(-1).data.leaseEpoch;
  assert.equal(timers.size > 0, true);
  host.trigger('control-transition-ack', { leaseEpoch: epoch, status: 'applied' });
  assert.equal(viewer.sent.filter((entry) => entry.event === 'control-state').at(-1).data.state, 'FREE');
  assert.equal(timers.size, 0);
});


test('media-activity-change requires active lease and monotonic generation', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  const viewerB = new FakeSocket('viewer-2', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  viewerB.handshake.auth.inputProtocolVersion = 2;
  io.connect(host);
  io.connect(viewer);
  io.connect(viewerB);

  const base = {
    schemaVersion: 1,
    state: 'suspended',
    reasons: ['manual-pause'],
    generation: 1,
    connectionAttemptId: 'wrd-1',
    leaseId: 'lease-000000000001',
    leaseEpoch: 1,
  };

  // No lease yet.
  viewer.trigger('media-activity-change', base);
  assert.equal(host.sent.some((e) => e.event === 'media-activity-change'), false);
  assert.equal(viewer.sent.some((e) => e.event === 'media-activity-rejected'), true);

  viewer.trigger('control-acquire', { requestId: 'm1' });
  const transition = host.sent.find((e) => e.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const grant = viewer.sent.find((e) => e.event === 'control-grant').data;

  const ok = {
    ...base,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  };
  viewer.trigger('media-activity-change', ok);
  const forwarded = host.sent.filter((e) => e.event === 'media-activity-change').at(-1);
  assert.equal(Boolean(forwarded), true);
  assert.equal(forwarded.data.viewerId, 'viewer-1');
  assert.equal(forwarded.data.generation, 1);
  assert.equal(forwarded.data.leaseId, grant.leaseId);

  // Stale generation rejected.
  viewer.trigger('media-activity-change', { ...ok, generation: 1, state: 'active' });
  assert.equal(
    viewer.sent.filter((e) => e.event === 'media-activity-rejected').at(-1).data.reason,
    'stale-generation',
  );

  // Read-only viewer cannot write.
  viewerB.trigger('media-activity-change', {
    ...ok,
    generation: 2,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });
  assert.equal(
    host.sent.filter((e) => e.event === 'media-activity-change' && e.data.viewerId === 'viewer-2').length,
    0,
  );

  // Host ack is routed without echoing secrets beyond lease-free fields.
  host.trigger('media-activity-ack', {
    schemaVersion: 1,
    state: 'suspended',
    generation: 1,
    connectionAttemptId: 'wrd-1',
    applied: true,
    viewerId: 'viewer-1',
    leaseId: grant.leaseId,
  });
  const ack = viewer.sent.filter((e) => e.event === 'media-activity-ack').at(-1).data;
  assert.equal(ack.applied, true);
  assert.equal(ack.generation, 1);
  assert.equal(Object.hasOwn(ack, 'leaseId'), false);
});
