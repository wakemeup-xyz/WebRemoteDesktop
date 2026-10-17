const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { signAccessToken } = require('../lib/auth');
const { setupTerminal } = require('./terminal');
const { createRuntimeContext } = require('./runtime-context');
const { createStructuredLogger } = require('../lib/observability/logger');

process.env.JWT_SECRET = process.env.JWT_SECRET || '12345678';
process.env.ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || 'test-viewer-password';
process.env.HOST_PASSWORD = process.env.HOST_PASSWORD || 'test-host-password';

const {
  setupSignaling,
  connections,
  clearHostCapabilities,
  getHostCapabilities,
  issueProofAdmission,
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

const { FakeSocket, makeIo, resetConnections, grantActiveLease } = require('./signaling-test-fixture');

test('proof admissions expire, enforce capacity, and cannot be replayed', () => {
  let now = 1000;
  const context = createRuntimeContext({
    now: () => now,
    proofAdmissionTtlMs: 1000,
    maxProofAdmissions: 1,
  });
  const first = context.issueProofAdmission();
  assert.ok(first?.token);
  assert.equal(context.issueProofAdmission(), null);
  now += 1001;
  assert.equal(context.admitProofViewer(first), false);
  const fresh = context.issueProofAdmission();
  assert.ok(fresh?.token);
  assert.equal(context.admitProofViewer(fresh), true);
  assert.equal(context.admitProofViewer(fresh), false);
});

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

test('human viewer arriving after proof admission issuance rejects proof without eviction', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);
  const admission = issueProofAdmission();
  const human = new FakeSocket('human-viewer', 'viewer');
  io.connect(human);
  const proof = new FakeSocket('proof-viewer', 'viewer');
  proof.handshake.auth.proofAdmission = admission;
  io.connect(proof);

  assert.equal(connections.viewers.get('human-viewer'), human);
  assert.equal(human.disconnected, false);
  assert.equal(proof.disconnected, true);
  assert.equal(proof.sent.some((entry) => entry.event === 'proof-admission-rejected'), true);
});

test('websocket proof admission requires its exact production realm', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);
  const admission = issueProofAdmission();
  const swapped = new FakeSocket('swapped-proof', 'viewer');
  swapped.handshake.auth.proofAdmission = { ...admission, realm: 'lab-test' };
  io.connect(swapped);
  assert.equal(swapped.disconnected, true);

  const valid = new FakeSocket('valid-proof', 'viewer');
  valid.handshake.auth.proofAdmission = admission;
  io.connect(valid);
  assert.equal(valid.disconnected, false);
  assert.equal(connections.viewers.get('valid-proof'), valid);
});

test('strict Lab signaling rejects proofless and relay viewers without consuming a valid proof', () => {
  const context = createRuntimeContext({ realm: 'lab-test', requireViewerProof: true });
  const io = makeIo();
  setupSignaling(io, { runtimeContext: context });
  const admission = context.issueProofAdmission();

  const proofless = new FakeSocket('proofless', 'viewer');
  io.connect(proofless);
  assert.equal(proofless.disconnected, true);
  assert.equal(context.hasProofAdmission(admission), true);
  assert.equal(context.viewerEpoch(), 0);

  const relay = new FakeSocket('relay', 'relay-viewer');
  io.connect(relay);
  assert.equal(relay.disconnected, true);
  assert.equal(context.hasProofAdmission(admission), true);

  const valid = new FakeSocket('valid', 'viewer');
  valid.handshake.auth.proofAdmission = admission;
  io.connect(valid);
  assert.equal(valid.disconnected, false);
  assert.equal(context.connections.viewers.get(valid.id), valid);
});

test('default production signaling retains proofless human and relay companion behavior', () => {
  const context = createRuntimeContext();
  const io = makeIo();
  setupSignaling(io, { runtimeContext: context });
  const human = new FakeSocket('human', 'viewer');
  const relay = new FakeSocket('relay', 'relay-viewer');
  io.connect(human);
  io.connect(relay);
  assert.equal(human.disconnected, false);
  assert.equal(relay.disconnected, false);
  assert.equal(context.connections.viewers.get(human.id), human);
  assert.equal(context.connections.relayViewers.get(relay.id), relay);
});

test('human viewer supersedes an admitted proof viewer under the existing user-priority rule', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);
  const proof = new FakeSocket('proof-viewer', 'viewer');
  proof.handshake.auth.proofAdmission = issueProofAdmission();
  io.connect(proof);
  const human = new FakeSocket('human-viewer', 'viewer');
  io.connectManual(human);

  assert.equal(proof.disconnected, true);
  assert.equal(connections.viewers.get('human-viewer'), human);
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

test('viewer media-profile-change is sanitized and forwarded with a Signal-bound attempt', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);

  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  io.connect(host);
  io.connect(viewer);

  viewer.trigger('input', { type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const grant = viewer.sent.find((entry) => entry.event === 'control-grant').data;
  viewer.trigger('connection-attempt-bind', {
    schemaVersion: 1,
    connectionAttemptId: 'attempt-sanitized',
    connectionAttemptSequence: 1,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });

  // A legacy wire payload has no attempt or profile sequence. Signal must
  // derive both from the authoritative binding before it reaches Host.
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
  assert.equal(message.data.adaptiveResolution, false);
  assert.equal(message.data.continuityAction, 'none');
  assert.equal(message.data.extra, undefined);
  assert.deepEqual(
    [message.data.connectionAttemptId, message.data.generation, message.data.profileSequence],
    ['attempt-sanitized', 1, 1],
  );

  viewer.trigger('media-profile-change', {
    profile: 'low',
    width: 854,
    height: 480,
    targetFps: 12,
    videoBitrateKbps: 900,
    reason: 'keyframe-recovery',
    adaptiveResolution: true,
    continuityAction: 'keyframe',
  });
  const locked = host.sent.filter((entry) => entry.event === 'media-profile-change').at(-1).data;
  assert.equal(locked.adaptiveResolution, true);
  assert.equal(locked.continuityAction, 'keyframe');
  assert.equal(locked.profileSequence, 2);
});

test('media profile without an authoritative attempt binding is rejected', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);
  const host = new FakeSocket('host-no-attempt', 'host');
  const viewer = new FakeSocket('viewer-no-attempt', 'viewer');
  io.connect(host);
  io.connect(viewer);

  viewer.trigger('media-profile-change', { profile: 'high' });

  assert.equal(host.sent.some((entry) => entry.event === 'media-profile-change'), false);
  assert.equal(
    viewer.sent.filter((entry) => entry.event === 'media-profile-rejected').at(-1).data.reason,
    'no-active-attempt',
  );
});

test('media profile rejects a derived sequence beyond Number.MAX_SAFE_INTEGER', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-profile-overflow', 'host');
  const viewer = new FakeSocket('viewer-profile-overflow', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host);
  io.connect(viewer);
  viewer.trigger('control-acquire', { requestId: 'profile-overflow' });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const grant = viewer.sent.find((entry) => entry.event === 'control-grant').data;
  const lease = { schemaVersion: 2, leaseId: grant.leaseId, leaseEpoch: grant.leaseEpoch };
  viewer.trigger('connection-attempt-bind', {
    ...lease, connectionAttemptId: 'attempt-overflow', connectionAttemptSequence: 1,
  });
  viewer.trigger('media-profile-change', {
    ...lease, connectionAttemptId: 'attempt-overflow',
    profileSequence: Number.MAX_SAFE_INTEGER, profile: 'high',
  });
  const forwarded = host.sent.filter((entry) => entry.event === 'media-profile-change').length;

  // A legacy-shaped follow-up would derive MAX_SAFE_INTEGER + 1 and must fail.
  viewer.trigger('media-profile-change', { ...lease, profile: 'low' });

  assert.equal(host.sent.filter((entry) => entry.event === 'media-profile-change').length, forwarded);
  assert.equal(
    viewer.sent.filter((entry) => entry.event === 'media-profile-rejected').at(-1).data.reason,
    'profile-sequence-exhausted',
  );
});

test('profile writes derive bound attempt identity and reject stale sequence or old attempt', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-profile', 'host');
  const viewer = new FakeSocket('viewer-profile', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host);
  io.connect(viewer);

  viewer.trigger('control-acquire', { requestId: 'profile-control' });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const grant = viewer.sent.find((entry) => entry.event === 'control-grant').data;
  const lease = { schemaVersion: 2, leaseId: grant.leaseId, leaseEpoch: grant.leaseEpoch };

  viewer.trigger('connection-attempt-bind', {
    ...lease,
    connectionAttemptId: 'attempt-current',
    connectionAttemptSequence: 1,
  });
  viewer.trigger('media-profile-change', {
    ...lease,
    connectionAttemptId: 'attempt-current',
    profileSequence: 1,
    profile: 'high',
    width: 1280,
    height: 720,
    targetFps: 20,
    videoBitrateKbps: 2500,
  });
  const current = host.sent.filter((entry) => entry.event === 'media-profile-change').at(-1).data;
  assert.deepEqual(
    [current.connectionAttemptId, current.generation, current.profileSequence],
    ['attempt-current', 1, 1],
  );

  const countAfterCurrent = host.sent.filter((entry) => entry.event === 'media-profile-change').length;
  viewer.trigger('media-profile-change', {
    ...lease,
    connectionAttemptId: 'attempt-current',
    profileSequence: 0,
    profile: 'low',
  });
  assert.equal(host.sent.filter((entry) => entry.event === 'media-profile-change').length, countAfterCurrent);

  viewer.trigger('connection-attempt-bind', {
    ...lease,
    connectionAttemptId: 'attempt-new',
    connectionAttemptSequence: 2,
  });
  viewer.trigger('media-profile-change', {
    ...lease,
    connectionAttemptId: 'attempt-current',
    profileSequence: 99,
    profile: 'low',
  });
  assert.equal(host.sent.filter((entry) => entry.event === 'media-profile-change').length, countAfterCurrent);
  assert.equal(
    viewer.sent.filter((entry) => entry.event === 'media-profile-rejected').at(-1).data.reason,
    'wrong-attempt',
  );
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
  viewer.trigger('connection-attempt-bind', {
    ...lease,
    connectionAttemptId: 'attempt-v2-media',
    connectionAttemptSequence: 1,
  });
  viewer.trigger('media-profile-change', { ...lease, profile: 'high', width: 99999, height: 99999, targetFps: 99, videoBitrateKbps: 99999 });
  // Cached Viewer builds still send this legacy event. Signal must translate
  // it through the same authoritative profile sequence, never send a raw
  // size mutation to Host.
  viewer.trigger('resolution-change', { ...lease, width: 99999, height: 99999 });

  const profile = host.sent.filter((entry) => entry.event === 'media-profile-change').at(-1).data;
  assert.deepEqual([profile.width, profile.height, profile.targetFps, profile.videoBitrateKbps], [1920, 1080, 30, 5000]);
  assert.equal(profile.profileSequence, 2);
  assert.equal(host.sent.some((entry) => entry.event === 'resolution-change'), false);
});

test('cached resolution-change is admitted as a bounded profile write', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-legacy-resolution', 'host');
  const viewer = new FakeSocket('viewer-legacy-resolution', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host);
  io.connect(viewer);

  viewer.trigger('control-acquire', { requestId: 'legacy-resolution' });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const grant = viewer.sent.find((entry) => entry.event === 'control-grant').data;
  const lease = { schemaVersion: 2, leaseId: grant.leaseId, leaseEpoch: grant.leaseEpoch };
  viewer.trigger('connection-attempt-bind', {
    ...lease,
    connectionAttemptId: 'attempt-legacy-resolution',
    connectionAttemptSequence: 1,
  });

  viewer.trigger('resolution-change', { ...lease, width: 1920, height: 1080 });

  const forwarded = host.sent.filter((entry) => entry.event === 'media-profile-change').at(-1).data;
  assert.deepEqual({
    connectionAttemptId: forwarded.connectionAttemptId,
    generation: forwarded.generation,
    profileSequence: forwarded.profileSequence,
    profile: forwarded.profile,
    width: forwarded.width,
    height: forwarded.height,
    targetFps: forwarded.targetFps,
    videoBitrateKbps: forwarded.videoBitrateKbps,
  }, {
    connectionAttemptId: 'attempt-legacy-resolution',
    generation: 1,
    profileSequence: 1,
    profile: 'high',
    width: 1920,
    height: 1080,
    targetFps: 20,
    videoBitrateKbps: 2500,
  });
  assert.equal(host.sent.some((entry) => entry.event === 'resolution-change'), false);
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

test('viewer request-keyframe derives the active recovery identity before forwarding', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });

  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host);
  io.connect(viewer);
  const grant = grantActiveLease(io, host, viewer, 'keyframe-binding');
  viewer.trigger('connection-attempt-bind', {
    schemaVersion: 1,
    connectionAttemptId: 'attempt-keyframe',
    connectionAttemptSequence: 4,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });

  viewer.trigger('request-keyframe', {
    schemaVersion: 2,
    reason: 'media-stalled',
    secret: 'drop-me',
    connectionAttemptId: 'attempt-keyframe',
    connectionAttemptSequence: 4,
    generation: 4,
    requestSequence: 9,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });

  const message = host.sent.filter((entry) => entry.event === 'request-keyframe').at(-1);
  assert.equal(Boolean(message), true);
  assert.equal(message.data.viewerId, 'viewer-1');
  assert.equal(message.data.reason, 'media-stalled');
  assert.equal(message.data.connectionAttemptId, 'attempt-keyframe');
  assert.equal(message.data.connectionAttemptSequence, 4);
  assert.equal(message.data.generation, 4);
  assert.equal(message.data.requestSequence, 9);
  assert.equal(message.data.secret, undefined);
});

test('only current fully correlated recovery envelopes cross an A to B rebind', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host);
  io.connect(viewer);
  const grant = grantActiveLease(io, host, viewer, 'keyframe-rebind');
  for (const [connectionAttemptId, connectionAttemptSequence] of [['attempt-A', 1], ['attempt-B', 2]]) {
    viewer.trigger('connection-attempt-bind', {
      schemaVersion: 1,
      connectionAttemptId,
      connectionAttemptSequence,
      leaseId: grant.leaseId,
      leaseEpoch: grant.leaseEpoch,
    });
  }
  const keyframesBefore = host.sent.filter((entry) => entry.event === 'request-keyframe').length;
  const statsBefore = host.sent.filter((entry) => entry.event === 'viewer-stats').length;
  const oldIdentity = {
    schemaVersion: 2,
    connectionAttemptId: 'attempt-A',
    connectionAttemptSequence: 1,
    generation: 1,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  };
  // A late legacy Viewer has no current recovery key. Signal must not assign
  // B's key merely because this socket is now bound to B.
  viewer.trigger('request-keyframe', {
    schemaVersion: 2,
    requestSequence: 1,
    reason: 'decoder-stalled',
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });
  viewer.trigger('viewer-stats', { decodedDelta: 0, receivedDelta: 19, derivedFps: 0 });
  viewer.trigger('request-keyframe', { ...oldIdentity, requestSequence: 1, reason: 'decoder-stalled' });
  viewer.trigger('viewer-stats', { ...oldIdentity, decodedDelta: 0, receivedDelta: 19, derivedFps: 0 });
  assert.equal(host.sent.filter((entry) => entry.event === 'request-keyframe').length, keyframesBefore);
  assert.equal(host.sent.filter((entry) => entry.event === 'viewer-stats').length, statsBefore);

  const currentIdentity = {
    ...oldIdentity,
    connectionAttemptId: 'attempt-B',
    connectionAttemptSequence: 2,
    generation: 2,
  };
  viewer.trigger('request-keyframe', { ...currentIdentity, requestSequence: 2, reason: 'decoder-stalled' });
  viewer.trigger('viewer-stats', { ...currentIdentity, decodedDelta: 0, receivedDelta: 19, derivedFps: 0 });
  assert.equal(host.sent.filter((entry) => entry.event === 'request-keyframe').length, keyframesBefore + 1);
  assert.equal(host.sent.filter((entry) => entry.event === 'viewer-stats').length, statsBefore + 1);
});

test('non-viewer request-keyframe is ignored', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);

  const host = new FakeSocket('host-1', 'host');
  io.connect(host);
  host.trigger('request-keyframe', { reason: 'media-stalled' });
  assert.equal(host.sent.some((entry) => entry.event === 'request-keyframe'), false);
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

test('authenticated viewer reconnect rebinds the lease during the short disconnect grace window', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });

  const host = new FakeSocket('host-grace', 'host');
  const first = new FakeSocket('viewer-grace-a', 'viewer');
  const sessionId = 'browser-session-grace-1';
  host.handshake.auth.inputProtocolVersion = 2;
  first.handshake.auth.inputProtocolVersion = 2;
  first.handshake.auth.viewerSessionId = sessionId;
  io.connect(host);
  io.connect(first);
  const grant = grantActiveLease(io, host, first, 'grace-rebind');
  first.trigger('connection-attempt-bind', {
    leaseId: grant.leaseId, leaseEpoch: grant.leaseEpoch,
    connectionAttemptId: 'attempt-grace', connectionAttemptSequence: 1,
  });
  const transitionsBeforeDisconnect = host.sent.filter((entry) => entry.event === 'control-transition').length;

  first.trigger('disconnect');
  assert.equal(connections.viewers.get(first.id), first);
  assert.equal(host.sent.filter((entry) => entry.event === 'control-transition').length, transitionsBeforeDisconnect);

  // The disconnected socket is retained only as a lease placeholder; delayed
  // packets must still be rejected while the replacement is being established.
  first.trigger('control-heartbeat', { leaseId: grant.leaseId, leaseEpoch: grant.leaseEpoch });
  assert.equal(first.sent.some((entry) => entry.event === 'control-heartbeat-rejected'), false);

  const replacement = new FakeSocket('viewer-grace-b', 'viewer');
  replacement.handshake.auth.inputProtocolVersion = 2;
  replacement.handshake.auth.viewerSessionId = sessionId;
  const order = [];
  for (const candidate of [host, replacement]) {
    const emit = candidate.emit.bind(candidate);
    candidate.emit = (event, data, ack) => {
      order.push([candidate.id, event]);
      return emit(event, data, ack);
    };
  }
  io.connect(replacement);
  assert.equal(connections.viewers.get(replacement.id), replacement);
  assert.equal(connections.viewers.has(first.id), false);
  assert.equal(host.sent.filter((entry) => entry.event === 'control-transition').length, 1);
  const rebind = host.sent.find((entry) => entry.event === 'viewer-session-rebind');
  assert.equal(replacement.sent.some((entry) => entry.event === 'control-grant'), false);
  const priorInputCount = host.sent.filter((entry) => entry.event === 'input').length;
  replacement.trigger('input', v2Key({ leaseId: grant.leaseId, leaseEpoch: grant.leaseEpoch }));
  assert.equal(host.sent.filter((entry) => entry.event === 'input').length, priorInputCount);
  assert.equal(rebind.timeoutMs, 1500);
  replacement.trigger('control-acquire', { requestId: 'pending-rebind-acquire' });
  const pendingAcquire = replacement.sent.filter(e => e.event === 'control-acquire-result').at(-1);
  assert.equal(pendingAcquire.data.reason, 'reset-in-progress');
  assert.equal(pendingAcquire.data.requestId, 'pending-rebind-acquire');
  assert.equal(replacement.sent.some(e => e.event === 'control-grant'), false);
  rebind.ack(null, { status: 'applied' });
  const reboundGrant = replacement.sent.find((entry) => entry.event === 'control-grant');
  assert.deepEqual(reboundGrant?.data, {
    controller: true,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });
  assert.deepEqual(host.sent.find((entry) => entry.event === 'viewer-session-rebind')?.data, {
    previousViewerId: first.id,
    viewerId: replacement.id,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
    connectionAttemptId: 'attempt-grace',
    connectionAttemptSequence: 1,
  });
  assert.ok(order.findIndex((entry) => entry[1] === 'viewer-session-rebind')
    < order.findIndex((entry) => entry[1] === 'control-grant'));
  assert.equal(replacement.sent.some((entry) => entry.event === 'viewer-session-rebind'), false);

  replacement.trigger('control-heartbeat', { leaseId: grant.leaseId, leaseEpoch: grant.leaseEpoch });
  assert.equal(replacement.sent.some((entry) => entry.event === 'control-heartbeat-rejected'), false);
  assert.equal(replacement.sent.at(-1)?.event, 'control-state');
});

test('another viewer session cannot rebind the disconnected controller at Host', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-cross-session', 'host');
  const first = new FakeSocket('viewer-cross-a', 'viewer');
  first.handshake.auth.viewerSessionId = 'viewer-session-a';
  io.connect(host);
  io.connect(first);
  grantActiveLease(io, host, first, 'cross-session');
  first.disconnect();
  const second = new FakeSocket('viewer-cross-b', 'viewer');
  second.handshake.auth.viewerSessionId = 'viewer-session-b';
  io.connectManual(second);
  second.trigger('viewer-session-rebind', { previousViewerId: first.id, viewerId: second.id });
  assert.equal(host.sent.some((entry) => entry.event === 'viewer-session-rebind'), false);
  assert.equal(second.sent.some((entry) => entry.event === 'control-grant'), false);
  assert.equal(host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data.reason,
    'controller-disconnect');
});

test('same-session reconnect during a pending grant retains the Host reset barrier', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-pending-rebind', 'host');
  const first = new FakeSocket('viewer-pending-a', 'viewer');
  first.handshake.auth.viewerSessionId = 'viewer-session-pending';
  io.connect(host);
  io.connect(first);
  first.trigger('control-acquire', { requestId: 'pending-rebind' });
  first.disconnect();
  const second = new FakeSocket('viewer-pending-b', 'viewer');
  second.handshake.auth.viewerSessionId = 'viewer-session-pending';
  io.connect(second);
  assert.equal(host.sent.some((entry) => entry.event === 'viewer-session-rebind'), false);
  assert.equal(second.sent.some((entry) => entry.event === 'control-grant'), false);
  const reset = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
  assert.equal(reset.reason, 'controller-disconnect');
  assert.equal(reset.viewerId, undefined);
  assert.equal(reset.leaseId, undefined);
});

for (const outcome of ['rejected', 'timeout', 'disconnected', 'superseded']) {
  test(`Host rebind ${outcome} cannot grant from a late acknowledgement`, () => {
    resetConnections();
    const io = makeIo();
    const timers = [];
    setupSignaling(io, {
      makeLeaseId: () => 'lease-000000000001',
      scheduler: {
        setInterval: () => ({ unref() {} }),
        setTimeout(fn, ms) {
          const timer = { fn, ms, cancelled: false, unref() {} };
          timers.push(timer);
          return timer;
        },
        clearTimeout(timer) { timer.cancelled = true; },
      },
    });
    const host = new FakeSocket(`host-rebind-${outcome}`, 'host');
    const first = new FakeSocket(`viewer-rebind-${outcome}-a`, 'viewer');
    first.handshake.auth.viewerSessionId = 'session-rebind-failure';
    io.connect(host);
    io.connect(first);
    grantActiveLease(io, host, first, 'initial-grant');
    first.disconnect();
    const replacement = new FakeSocket(`viewer-rebind-${outcome}-b`, 'viewer');
    replacement.handshake.auth.viewerSessionId = 'session-rebind-failure';
    io.connect(replacement);
    const rebind = host.sent.find((entry) => entry.event === 'viewer-session-rebind');
    assert.ok(rebind);
    if (outcome === 'rejected') rebind.ack(null, { status: 'rejected', reason: 'viewer-mismatch' });
    if (outcome === 'timeout') {
      assert.equal(rebind.timeoutMs, 1500);
      rebind.ack(new Error('operation has timed out'));
    }
    if (outcome === 'disconnected') replacement.disconnect();
    if (outcome === 'superseded') {
      const other = new FakeSocket('viewer-rebind-unrelated', 'viewer');
      other.handshake.auth.viewerSessionId = 'session-unrelated';
      io.connectManual(other);
    }
    const transitionsBeforeLateAck = host.sent.filter((entry) => entry.event === 'control-transition').length;
    rebind.ack(null, { status: 'applied' });
    assert.equal(replacement.sent.some((entry) => entry.event === 'control-grant'), false);
    assert.equal(host.sent.filter((entry) => entry.event === 'control-transition').length,
      transitionsBeforeLateAck);
    if (outcome === 'rejected' || outcome === 'timeout') {
      const reset = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
      assert.equal(reset.reason, outcome === 'timeout' ? 'rebind-timeout' : 'rebind-rejected');
      assert.equal(reset.viewerId, undefined);
      assert.equal(reset.leaseId, undefined);
      host.trigger('control-transition-ack', { leaseEpoch: reset.leaseEpoch, status: 'applied' });
      replacement.trigger('control-acquire', { requestId: 'rebind-fallback-acquire' });
      const fresh = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
      assert.ok(fresh.leaseEpoch > reset.leaseEpoch);
      host.trigger('control-transition-ack', { leaseEpoch: fresh.leaseEpoch, status: 'applied' });
      assert.equal(replacement.sent.filter((entry) => entry.event === 'control-grant').length, 1);
    }
  });
}

test('viewer grace expiry falls back to the formal reset barrier', () => {
  resetConnections();
  const timers = [];
  const scheduler = {
    setInterval() { return { unref() {} }; },
    setTimeout(fn, ms) {
      const timer = { fn, ms, cancelled: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
  };
  const io = makeIo();
  setupSignaling(io, { scheduler, viewerDisconnectGraceMs: 8000 });
  const host = new FakeSocket('host-grace-expiry', 'host');
  const viewer = new FakeSocket('viewer-grace-expiry', 'viewer');
  viewer.handshake.auth.viewerSessionId = 'browser-session-grace-2';
  io.connect(host);
  io.connect(viewer);
  viewer.trigger('control-acquire', { requestId: 'grace-expiry' });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const beforeDisconnect = host.sent.filter((entry) => entry.event === 'control-transition').length;

  viewer.trigger('disconnect');
  const graceTimer = timers.find((timer) => timer.ms === 8000 && !timer.cancelled);
  assert.ok(graceTimer);
  graceTimer.fn();
  assert.equal(connections.viewers.has(viewer.id), false);
  assert.equal(host.sent.filter((entry) => entry.event === 'control-transition').length, beforeDisconnect + 1);
  assert.equal(host.sent.filter((entry) => entry.event === 'control-transition').at(-1)?.data?.reason, 'controller-disconnect');
  const late = new FakeSocket('viewer-grace-too-late', 'viewer');
  late.handshake.auth.viewerSessionId = 'browser-session-grace-2';
  io.connect(late);
  assert.equal(host.sent.some((entry) => entry.event === 'viewer-session-rebind'), false);
  assert.equal(late.sent.some((entry) => entry.event === 'control-grant'), false);
});

test('control lifecycle survives the production logger with correlation and no credentials or input', () => {
  resetConnections();
  const io = makeIo();
  const lines = [];
  const leaseId = 'lease-private-logging-fixture';
  setupSignaling(io, {
    makeLeaseId: () => leaseId,
    scheduler: {
      setInterval: () => ({ unref() {} }),
      setTimeout: () => ({ unref() {} }),
      clearTimeout() {},
    },
    structuredLogger: createStructuredLogger({ write: (line) => lines.push(line) }),
  });
  const host = new FakeSocket('host-log', 'host');
  const first = new FakeSocket('viewer-log-a', 'viewer');
  first.handshake.auth.viewerSessionId = 'viewer-session-log';
  io.connect(host);
  io.connect(first);
  const grant = grantActiveLease(io, host, first, 'logging-grant');
  first.disconnect();
  const replacement = new FakeSocket('viewer-log-b', 'viewer');
  replacement.handshake.auth.viewerSessionId = 'viewer-session-log';
  io.connect(replacement);
  host.sent.find((entry) => entry.event === 'viewer-session-rebind').ack(null, { status: 'applied' });
  replacement.trigger('control-release', { reason: 'released' });
  const reset = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
  host.trigger('control-transition-ack', {
    leaseEpoch: reset.leaseEpoch,
    status: 'rejected',
    reason: 'reset-failed',
    leaseId: grant.leaseId,
    token: 'private-token-fixture',
    payload: { text: 'private-input-fixture' },
  });

  const events = lines.map((line) => JSON.parse(line));
  const grace = events.find((event) => event.event === 'viewer_disconnect_grace_started');
  assert.equal(grace.domain, 'control');
  assert.equal(grace.meta.graceMs, 8000);
  assert.deepEqual(grace.correlation, {
    viewerId: first.id, browserSessionId: 'viewer-session-log',
  });
  const reconnected = events.find((event) => event.event === 'viewer_reconnected');
  assert.deepEqual(reconnected.correlation, {
    viewerId: replacement.id, previousViewerId: first.id, browserSessionId: 'viewer-session-log',
  });
  const failed = events.find((event) => event.event === 'control_transition_failed_closed'
    && event.meta.reason === 'reset-failed');
  assert.equal(failed.meta.leaseEpoch, reset.leaseEpoch);
  assert.equal(events.some((event) => event.event === 'unknown'), false);
  for (const secret of [leaseId, host.handshake.auth.token, first.handshake.auth.token,
    'private-token-fixture', 'private-input-fixture']) {
    assert.equal(lines.join('\n').includes(secret), false);
  }
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
  // single-desktop-viewer policy: only one desktop viewer online at a time;
  // verify ack routes by viewerId and does not deliver to a later sole viewer.
  resetConnections();
  const io = makeIo();
  setupSignaling(io);
  const host = new FakeSocket('host-1', 'host');
  const viewerA = new FakeSocket('viewer-a', 'viewer');
  io.connect(host);
  io.connect(viewerA);

  host.trigger('input-ack', {
    viewerId: 'viewer-a',
    type: 'input_ack',
    inputIds: ['input-1'],
    hostExecuteMs: 8,
    transport: 'socket',
  });
  assert.equal(viewerA.sent.some((message) => message.event === 'input-ack' && message.data.inputIds[0] === 'input-1'), true);

  const viewerB = new FakeSocket('viewer-b', 'viewer');
  io.connectManual(viewerB);
  assert.equal(connections.viewers.size, 1);
  assert.equal(connections.viewers.has('viewer-b'), true);

  host.trigger('input-ack', {
    viewerId: 'viewer-a',
    type: 'input_ack',
    inputIds: ['input-stale'],
    hostExecuteMs: 8,
    transport: 'socket',
  });
  assert.equal(viewerB.sent.some((message) => message.event === 'input-ack'), false);

  host.trigger('input-ack', {
    viewerId: 'viewer-b',
    type: 'input_ack',
    inputIds: ['input-2'],
    hostExecuteMs: 4,
    transport: 'socket',
  });
  assert.equal(viewerB.sent.some((message) => message.event === 'input-ack' && message.data.inputIds[0] === 'input-2'), true);
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
    inputType: 'keyboard',
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
    inputType: 'keyboard',
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

test('v2 mouse input ack forwards without keyboard sequence or state fields', () => {
  resetConnections(); const io = makeIo(); setupSignaling(io);
  const host = new FakeSocket('host-mouse-ack', 'host'); const viewer = new FakeSocket('viewer-mouse-ack', 'viewer'); io.connect(host); io.connect(viewer);
  host.trigger('input-ack', { viewerId: 'viewer-mouse-ack', type: 'input_ack', schemaVersion: 2, inputType: 'mouse', leaseEpoch: 4, status: 'applied', inputIds: ['mouse-reset-1'], hostExecuteMs: 2 });
  const ack = viewer.sent.find((message) => message.event === 'input-ack').data;
  assert.equal(ack.inputType, 'mouse'); assert.equal(ack.inputIds[0], 'mouse-reset-1'); assert.equal('appliedSeq' in ack, false); assert.equal('pressedKeyCount' in ack, false);
});

test('v2 reliable mouse acknowledgement preserves its applied sequence without keyboard state', () => {
  resetConnections(); const io = makeIo(); setupSignaling(io);
  const host = new FakeSocket('host-mouse-seq-ack', 'host'); const viewer = new FakeSocket('viewer-mouse-seq-ack', 'viewer'); io.connect(host); io.connect(viewer);
  host.trigger('input-ack', {
    viewerId: 'viewer-mouse-seq-ack', type: 'input_ack', schemaVersion: 2, inputType: 'mouse',
    leaseEpoch: 4, appliedSeq: 8, status: 'duplicate', inputIds: ['mouse-reset-8'], hostExecuteMs: 2,
  });
  const ack = viewer.sent.find((message) => message.event === 'input-ack').data;
  assert.equal(ack.appliedSeq, 8);
  assert.equal('pressedKeyCount' in ack, false);
  assert.equal('modifierMask' in ack, false);
});

test('v2 command acknowledgement preserves its non-keyboard correlation type', () => {
  resetConnections(); const io = makeIo(); setupSignaling(io);
  const host = new FakeSocket('host-command-ack', 'host'); const viewer = new FakeSocket('viewer-command-ack', 'viewer'); io.connect(host); io.connect(viewer);
  host.trigger('input-ack', {
    viewerId: 'viewer-command-ack', type: 'input_ack', schemaVersion: 2, inputType: 'command',
    leaseEpoch: 4, appliedSeq: 7, status: 'applied', pressedKeyCount: 0, modifierMask: 0,
    inputIds: ['command-1'], hostExecuteMs: 2,
  });
  const ack = viewer.sent.find((message) => message.event === 'input-ack').data;
  assert.equal(ack.inputType, 'command');
  assert.equal(ack.appliedSeq, 7);
  assert.equal(ack.inputIds[0], 'command-1');
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
      inputType: 'keyboard',
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
  // single-desktop-viewer policy: sole desktop viewer; lease must not echo back
  // on control-state, and offer is host-only (no second desktop observer).
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const owner = new FakeSocket('viewer-owner', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  owner.handshake.auth.inputProtocolVersion = 2;
  io.connect(host);
  io.connect(owner);

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
    connectionAttemptId: 'attempt-owner-1',
    connectionAttemptSequence: 1,
  });

  const forwarded = host.sent.filter((entry) => entry.event === 'offer').at(-1).data;
  assert.deepEqual(forwarded, {
    offer: { type: 'offer', sdp: 'v=0' },
    viewerId: 'viewer-owner',
    epoch: 3,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
    connectionAttemptId: 'attempt-owner-1',
    connectionAttemptSequence: 1,
  });
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
    isActive: null,
    hasLease: null,
    leaseEpoch: 0,
    gate: null,
    pendingKeys: 0,
    lastReleaseAllReason: 'window-blur',
    lastKeyboardResetReason: 'window-blur',
    keyboard: null,
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

test('v2 mouse and command socket inputs relay after lease grant through the desktop-write contract', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-mouse-v2', 'host');
  const viewer = new FakeSocket('viewer-mouse-v2', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host);
  io.connect(viewer);

  viewer.trigger('control-acquire', { requestId: 'mouse-1' });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const granted = viewer.sent.find((entry) => entry.event === 'control-grant').data;

  viewer.trigger('input', {
    schemaVersion: 2,
    type: 'mouse',
    action: 'down',
    leaseId: granted.leaseId,
    leaseEpoch: granted.leaseEpoch,
    seq: 1,
    inputIds: ['mouse-1'],
    payload: { relX: 0.5, relY: 0.4, button: 'left', clickCount: 1, buttons: 1 },
  });
  viewer.trigger('input', {
    schemaVersion: 2,
    type: 'command',
    action: 'showDock',
    leaseId: granted.leaseId,
    leaseEpoch: granted.leaseEpoch,
    seq: 2,
    inputIds: ['cmd-1'],
    payload: {},
  });
  // Keyboard contract still rejects unknown keyboard fields.
  viewer.trigger('input', {
    schemaVersion: 2,
    type: 'keyboard',
    action: 'key',
    leaseId: granted.leaseId,
    leaseEpoch: granted.leaseEpoch,
    seq: 1,
    inputIds: ['kbd-bad'],
    transport: 'socket',
    payload: { phase: 'down', code: 'KeyA', location: 0, repeat: false,
      modifiers: { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false },
      locks: { capsLock: false } },
  });

  const relayed = host.sent.filter((entry) => entry.event === 'input');
  assert.equal(relayed.length, 2);
  assert.equal(relayed[0].data.type, 'mouse');
  assert.equal(relayed[0].data.action, 'down');
  assert.equal(relayed[0].data.seq, 1);
  assert.equal(relayed[0].data.viewerId, 'viewer-mouse-v2');
  assert.equal(relayed[1].data.type, 'command');
  assert.equal(relayed[1].data.action, 'showDock');
  assert.equal(relayed[1].data.seq, 2);
  assert.equal(relayed.every((entry) => entry.data.transport === 'socket'), true);
});

test('v2 Signal input rejects malformed reliable writes but accepts unordered mouse move', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-desktop-v2', 'host');
  const viewer = new FakeSocket('viewer-desktop-v2', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host); io.connect(viewer);
  viewer.trigger('control-acquire', { requestId: 'desktop-1' });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const grant = viewer.sent.find((entry) => entry.event === 'control-grant').data;
  const base = { schemaVersion: 2, type: 'mouse', leaseId: grant.leaseId, leaseEpoch: grant.leaseEpoch, inputIds: ['desktop-1'] };

  viewer.trigger('input', { ...base, action: 'reset', payload: { reason: 'manual' } });
  viewer.trigger('input', { ...base, action: 'move', seq: 1, payload: { relX: 0.5, relY: 0.5, buttons: 0 } });
  viewer.trigger('input', { ...base, action: 'move', payload: { relX: 0.5, relY: 0.5, buttons: 0 } });

  const relayed = host.sent.filter((entry) => entry.event === 'input');
  assert.equal(relayed.length, 1);
  assert.deepEqual([relayed[0].data.type, relayed[0].data.action, relayed[0].data.seq], ['mouse', 'move', undefined]);
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
  // single-desktop-viewer policy: sole desktop viewer; second writer covered by
  // sequential supersede (later sole viewer cannot use the prior controller's path).
  resetConnections();
  const io = makeIo();
  setupSignaling(io, {
    makeLeaseId: () => 'lease-000000000001',
  });
  const host = new FakeSocket('host-1', 'host');
  const viewerA = new FakeSocket('viewer-a', 'viewer');
  io.connect(host);
  io.connect(viewerA);

  const legacyInput = {
    type: 'keyboard',
    action: 'keydown',
    payload: { key: 'a', code: 'KeyA' },
  };
  viewerA.trigger('input', legacyInput);
  // Extra inputs while GRANTING stay queued/dropped per single-writer rules.
  viewerA.trigger('input', legacyInput);
  assert.equal(host.sent.some((entry) => entry.event === 'input'), false);
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });

  assert.equal(host.sent.filter((entry) => entry.event === 'input').length, 1);
  assert.equal(host.sent.filter((entry) => entry.event === 'input').at(-1).data.viewerId, 'viewer-a');

  const viewerB = new FakeSocket('viewer-b', 'viewer');
  io.connectManual(viewerB);
  assert.equal(connections.viewers.has('viewer-a'), false);
  viewerB.trigger('input', legacyInput);
  // Supersede removed the ACTIVE controller → REVOKING barrier; B cannot write yet.
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

test('legacy relay companion stops when a second desktop viewer supersedes the owner', () => {
  // single-desktop-viewer policy: two main viewers cannot stay online; the second
  // desktop viewer supersedes the owner and stops the bound companion (replaces
  // the former "unbound while >1 main viewer" multi-viewer ambiguity case).
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
  assert.equal(host.sent.filter((entry) => entry.event === 'relay-stream-control').length, 1);

  const superseder = new FakeSocket('legacy-observer', 'viewer');
  io.connectManual(superseder);
  assert.equal(connections.viewers.size, 1);
  assert.equal(connections.viewers.has('legacy-observer'), true);
  assert.equal(mainViewer.disconnected, true);
  assert.deepEqual(host.sent.filter((entry) => entry.event === 'relay-stream-control').at(-1).data, {
    enabled: false,
    viewerId: 'legacy-main',
  });
  relayViewer.trigger('relay-stream-control', { enabled: true });
  assert.equal(host.sent.filter((entry) => entry.event === 'relay-stream-control' && entry.data.enabled === true).length, 1);
});

test('legacy relay companion stops on second desktop viewer supersede and rejects later frames', () => {
  // single-desktop-viewer policy: second desktop viewer supersedes the owner
  // (replaces multi-viewer ambiguity); companion is stopped and later frames drop.
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

  io.connectManual(new FakeSocket('legacy-observer', 'viewer'));
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

test('legacy relay companion stops when a second desktop viewer supersedes during active relay', () => {
  // single-desktop-viewer policy: cannot keep legacy main + v2 desktop viewer online
  // for takeover; supersede removes the owner and stops the companion (same stop
  // outcome as the former dual-viewer legacy-takeover path).
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
  io.connectManual(v2Viewer);
  assert.equal(connections.viewers.size, 1);
  assert.equal(connections.viewers.has('viewer-v2'), true);
  assert.equal(mainViewer.disconnected, true);
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
  // single-desktop-viewer policy: sequential A disconnect then B connect (not both online).
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
  host.handshake.auth.inputProtocolVersion = 2;
  viewerA.handshake.auth.inputProtocolVersion = 2;
  io.connect(host); io.connect(viewerA);

  viewerA.trigger('control-acquire', { requestId: 'a' });
  let transition = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const grantA = viewerA.sent.find((entry) => entry.event === 'control-grant').data;

  viewerA.trigger('disconnect');
  const resetTransition = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
  assert.equal(resetTransition.reason, 'controller-disconnect');
  assert.equal(resetTransition.leaseEpoch > grantA.leaseEpoch, true);
  assert.equal(Object.hasOwn(resetTransition, 'leaseId'), false);

  const viewerB = new FakeSocket('viewer-b', 'viewer');
  viewerB.handshake.auth.inputProtocolVersion = 2;
  io.connectManual(viewerB);
  const stateAfterConnect = viewerB.sent.filter((entry) => entry.event === 'control-state').at(-1).data;
  assert.equal(stateAfterConnect.state, 'REVOKING');
  assert.equal(stateAfterConnect.pendingViewerId, null);
  assert.equal(stateAfterConnect.controllerViewerId, null);

  // New acquire blocked before reset ack.
  viewerB.trigger('control-acquire', { requestId: 'blocked' });
  const blocked = viewerB.sent.filter((entry) => entry.event === 'control-acquire-result').at(-1).data;
  assert.equal(blocked.state, 'REVOKING');
  assert.equal(blocked.reason, 'reset-in-progress');

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
  // single-desktop-viewer policy: sequential A disconnect then B connect.
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
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host); io.connect(viewer);

  viewer.trigger('control-acquire', { requestId: 'a' });
  const grantTransition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', {
    leaseEpoch: grantTransition.leaseEpoch,
    status: 'applied',
  });
  viewer.trigger('disconnect');
  const resetTransition = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
  const epoch = resetTransition.leaseEpoch;

  const viewerB = new FakeSocket('viewer-b', 'viewer');
  viewerB.handshake.auth.inputProtocolVersion = 2;
  io.connectManual(viewerB);

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
  assert.equal(blocked.reason, 'reset-failed');
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
    viewerAdmission: viewer.sent.find(e => e.event === 'connected').data.viewerAdmission,
    role: 'viewer', status: 'ok', hostOnline: true,
    inputProtocolVersion: 2, hostInputProtocolVersion: 1,
    hostCapabilities: {
      inputFrameCorrelationVersion: null,
      turnReady: false,
      turnFingerprint: '',
      supportsSessionTurn: false,
      supportsMultiTurn: false,
      turnServerId: '',
      labTurnAppliedDigest: '',
      defaultTurnServerId: '',
      turnServerIds: [],
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
    supportsMultiTurn: true,
    turnServerId: 'aliyun',
    defaultTurnServerId: 'aliyun',
    turnServerIds: ['aliyun', 'overseas'],
  });

  const caps = getHostCapabilities();
  assert.equal(caps.turnReady, true);
  assert.equal(caps.turnFingerprint, 'abc123');
  assert.equal(caps.supportsSessionTurn, true);
  assert.equal(caps.supportsMultiTurn, true);
  assert.equal(caps.turnServerId, 'aliyun');
  assert.deepEqual(caps.turnServerIds, ['aliyun', 'overseas']);
  assert.ok(caps.updatedAt);

  const fanout = viewer.sent.filter((entry) => entry.event === 'host-capabilities').at(-1);
  assert.deepEqual(fanout.data.turnReady, true);
  assert.equal(fanout.data.turnFingerprint, 'abc123');
  assert.equal(fanout.data.supportsMultiTurn, true);

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
    turnServerId: 'overseas',
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
    connectionAttemptId: 'attempt-turn-1',
  });

  const forwarded = host.sent.filter((entry) => entry.event === 'offer').at(-1);
  assert.ok(forwarded);
  assert.equal(forwarded.data.networkMode, 'relay');
  assert.equal(forwarded.data.iceMode, 'relay');
  assert.equal(forwarded.data.turnServerId, 'overseas');
  assert.equal(forwarded.data.viewerId, viewer.id);
  assert.equal(forwarded.data.connectionAttemptId, 'attempt-turn-1');
});

test('offer forwards session width and height to host', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-offer-size', 'host');
  host.handshake.auth.inputProtocolVersion = 2;
  const viewer = new FakeSocket('viewer-offer-size', 'viewer');
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host);
  io.connect(viewer);

  viewer.trigger('control-acquire', { requestId: 'offer-size' });
  const transition = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const grant = viewer.sent.filter((entry) => entry.event === 'control-grant').at(-1).data;

  viewer.trigger('offer', {
    offer: { type: 'offer', sdp: 'v=0' },
    epoch: 1,
    schemaVersion: 2,
    networkMode: 'relay',
    iceMode: 'relay',
    width: 1280,
    height: 720,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
    connectionAttemptId: 'attempt-size-1',
  });

  const forwarded = host.sent.filter((entry) => entry.event === 'offer').at(-1);
  assert.ok(forwarded);
  assert.equal(forwarded.data.width, 1280);
  assert.equal(forwarded.data.height, 720);
});

test('legacy controller is single-writer and a later v2 viewer acquires only after reset', () => {
  // single-desktop-viewer policy: cannot keep legacy + second legacy + v2 online;
  // sole legacy writer, then supersede by v2, then acquire after FREE (not dual online takeover).
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: (() => { let n = 0; return () => `lease-${String(++n).padStart(16, '0')}`; })() });
  const host = new FakeSocket('host-v2', 'host');
  host.handshake.auth.inputProtocolVersion = 2;
  const legacyViewer = new FakeSocket('legacy-viewer', 'viewer');
  io.connect(host); io.connect(legacyViewer);

  const legacyInput = { type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } };
  legacyViewer.trigger('input', legacyInput);
  let transition = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  assert.equal(host.sent.filter((entry) => entry.event === 'input').length, 1);

  // Extra legacy inputs from the same sole controller still go through once ACTIVE.
  legacyViewer.trigger('input', legacyInput);
  assert.equal(host.sent.filter((entry) => entry.event === 'input').length, 2);

  const v2Viewer = new FakeSocket('v2-viewer', 'viewer');
  v2Viewer.handshake.auth.inputProtocolVersion = 2;
  io.connectManual(v2Viewer);
  assert.equal(connections.viewers.size, 1);
  assert.equal(legacyViewer.disconnected, true);
  transition = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
  assert.equal(transition.reason, 'controller-disconnect');
  v2Viewer.trigger('control-acquire', { requestId: 'after-supersede' });
  assert.equal(v2Viewer.sent.filter((entry) => entry.event === 'control-acquire-result').at(-1).data.state, 'REVOKING');
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  v2Viewer.trigger('control-acquire', { requestId: 'after-reset' });
  transition = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
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
  // single-desktop-viewer policy: sequential sole viewer then later B for blocked acquire.
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

  // New sole viewer still blocked while the reset-only barrier is unresolved.
  viewer.disconnect();
  const viewerB = new FakeSocket('viewer-2', 'viewer');
  io.connectManual(viewerB);
  viewerB.trigger('control-acquire', { requestId: 'blocked-while-reset' });
  const acquire = viewerB.sent.filter((entry) => entry.event === 'control-acquire-result').at(-1).data;
  assert.equal(acquire.state, 'REVOKING');
  assert.equal(acquire.reason, 'reset-failed');
});

test('controller disconnect freezes old lease until host ack then grants later sole viewer', () => {
  // single-desktop-viewer policy: dual online takeover is impossible; sequential
  // A disconnect → REVOKING freeze → B connect + acquire after FREE.
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: (() => { let n = 0; return () => `lease-${String(++n).padStart(16, '0')}`; })() });
  const host = new FakeSocket('host-1', 'host');
  const viewerA = new FakeSocket('viewer-a', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewerA.handshake.auth.inputProtocolVersion = 2;
  io.connect(host); io.connect(viewerA);
  viewerA.trigger('control-acquire', { requestId: 'a' });
  let transition = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const grantA = viewerA.sent.find((entry) => entry.event === 'control-grant').data;
  viewerA.trigger('disconnect');
  transition = host.sent.filter((entry) => entry.event === 'control-transition').at(-1).data;
  assert.equal(transition.reason, 'controller-disconnect');
  viewerA.trigger('input', v2Key({ leaseId: grantA.leaseId, leaseEpoch: grantA.leaseEpoch }));
  assert.equal(host.sent.filter((entry) => entry.event === 'input').length, 0);

  const viewerB = new FakeSocket('viewer-b', 'viewer');
  viewerB.handshake.auth.inputProtocolVersion = 2;
  io.connectManual(viewerB);
  viewerB.trigger('control-acquire', { requestId: 'b' });
  assert.equal(viewerB.sent.filter((entry) => entry.event === 'control-acquire-result').at(-1).data.state, 'REVOKING');
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  viewerB.trigger('control-acquire', { requestId: 'b-after-free' });
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
  // single-desktop-viewer policy: sequential sole controller then later B for blocked acquire.
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
  host.handshake.auth.inputProtocolVersion = 2;
  viewerA.handshake.auth.inputProtocolVersion = 2;
  io.connect(host); io.connect(viewerA);

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

  viewerA.disconnect();
  const viewerB = new FakeSocket('viewer-expiry-b', 'viewer');
  viewerB.handshake.auth.inputProtocolVersion = 2;
  io.connectManual(viewerB);
  viewerB.trigger('control-acquire', { requestId: 'b' });
  assert.equal(viewerB.sent.filter((entry) => entry.event === 'control-acquire-result').at(-1).data.state, 'REVOKING');

  currentTime = 15_000;
  tick();
  viewerB.trigger('control-acquire', { requestId: 'b-after-timeout' });
  assert.equal(viewerB.sent.filter((entry) => entry.event === 'control-acquire-result').at(-1).data.state, 'REVOKING');

  host.trigger('control-transition-ack', { leaseEpoch: resetTransitions[0].data.leaseEpoch, status: 'applied' });
  assert.equal(viewerB.sent.filter((entry) => entry.event === 'control-state').at(-1).data.state, 'FREE');
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

test('v2 input validation and authorization emit safe correlation events while relaying valid input', () => {
  resetConnections();
  const io = makeIo();
  const events = [];
  setupSignaling(io, {
    makeLeaseId: () => 'lease-000000000001',
    structuredLogger: { info: (event) => events.push(event) },
    logger: { log() {}, warn() {}, info() {}, error() {} },
  });
  const host = new FakeSocket('host-input-events', 'host');
  const viewer = new FakeSocket('viewer-input-events', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host);
  io.connect(viewer);

  viewer.trigger('control-acquire', { requestId: 'input-events' });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const grant = viewer.sent.find((entry) => entry.event === 'control-grant').data;

  const valid = v2Key({
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
    inputIds: ['kbd_fixture_1'],
  });
  viewer.trigger('input', valid);
  assert.equal(host.sent.filter((entry) => entry.event === 'input').length, 1);

  viewer.trigger('input', v2Key({
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
    inputIds: ['kbd_fixture_1'],
    transport: 'datachannel',
    payload: { ...valid.payload, text: 'TEXT_CANARY' },
  }));
  viewer.trigger('input', v2Key({
    leaseId: 'lease-stale-canary',
    leaseEpoch: grant.leaseEpoch,
    inputIds: ['kbd_fixture_1'],
  }));

  const relay = events.find((event) => event.event === 'signal_input_relayed');
  const rejected = events.filter((event) => event.event === 'signal_input_rejected');
  assert.ok(relay);
  assert.equal(relay.domain, 'input');
  assert.equal(relay.meta.inputIdHash, '3e9fd6a21afbb55b');
  assert.equal(relay.meta.inputIdCount, 1);
  assert.equal(relay.meta.transport, 'socket');
  assert.equal(relay.meta.seq, 1);
  assert.equal(relay.meta.leaseEpoch, grant.leaseEpoch);
  assert.equal(rejected.length, 2);
  assert.equal(rejected.every((event) => event.meta.status === 'rejected'), true);
  assert.equal(rejected.some((event) => event.meta.reason === 'UNKNOWN_FIELD'), true);
  assert.equal(rejected.some((event) => event.meta.reason === 'unauthorized'), true);
  assert.equal(rejected.every((event) => event.meta.transport === 'socket'), true);
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes('TEXT_CANARY'), false);
  assert.equal(serialized.includes('kbd_fixture_1'), false);
  assert.equal(serialized.includes('lease-stale-canary'), false);
});

test('Signal aggregates high-frequency mouse outcomes with normalized status keys', () => {
  resetConnections();
  const io = makeIo();
  const events = [];
  setupSignaling(io, {
    makeLeaseId: () => 'lease-000000000001',
    structuredLogger: { info: (event) => events.push(event) },
    logger: { log() {}, warn() {}, info() {}, error() {} },
  });
  const host = new FakeSocket('host-input-aggregate', 'host');
  const viewer = new FakeSocket('viewer-input-aggregate', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host);
  io.connect(viewer);
  viewer.trigger('control-acquire', { requestId: 'input-aggregate' });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const grant = viewer.sent.find((entry) => entry.event === 'control-grant').data;

  const originalCreateHash = crypto.createHash;
  let hashCalls = 0;
  crypto.createHash = () => {
    hashCalls += 1;
    throw new Error('HASH_CANARY');
  };
  try {
    for (const action of ['move', 'wheel']) {
      for (let index = 0; index < 100; index += 1) {
        viewer.trigger('input', {
          schemaVersion: 2,
          type: 'mouse',
          action,
          leaseId: grant.leaseId,
          leaseEpoch: grant.leaseEpoch,
          inputIds: ['mouse_fixture'],
          ...(action === 'wheel' ? { seq: index + 1 } : {}),
          payload: action === 'move'
            ? { relX: 0.5, relY: 0.5, buttons: 0 }
            : { relX: 0.5, relY: 0.5, deltaX: 0, deltaY: 120 },
        });
      }
    }
  } finally {
    crypto.createHash = originalCreateHash;
  }

  const aggregates = events.filter((event) => event.event === 'signal_input_aggregate');
  assert.equal(hashCalls, 0);
  assert.equal(aggregates.length, 2);
  assert.deepEqual(new Set(aggregates.map((event) => event.meta.action)), new Set(['move', 'wheel']));
  assert.ok(aggregates.every((event) => event.meta.count === 100));
  assert.ok(aggregates.every((event) => event.meta.status === 'accepted'));
  assert.ok(aggregates.every((event) => !('inputIdHash' in event.meta)));
  assert.ok(aggregates.every((event) => !('inputIdCount' in event.meta)));
  assert.ok(aggregates.every((event) => !('seq' in event.meta)));
  assert.ok(aggregates.every((event) => !('payloadBytes' in event.meta)));
  assert.equal(JSON.stringify(aggregates).includes('mouse_fixture'), false);
});


test('blocked reset cannot grant a new controller and retries are same-epoch bounded', () => {
  // single-desktop-viewer policy: sequential sole viewer then later B for blocked acquire.
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
  io.connect(host);
  io.connect(viewer);

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
  assert.equal(events.some((e) => e.event === 'control_reset_blocked'), true);

  const afterBlocked = viewer.sent.filter((entry) => entry.event === 'control-state').at(-1).data;
  assert.equal(afterBlocked.state, 'REVOKING');
  assert.equal(afterBlocked.reason, 'reset-blocked');

  viewer.disconnect();
  const viewerB = new FakeSocket('viewer-2', 'viewer');
  io.connectManual(viewerB);
  viewerB.trigger('control-acquire', { requestId: 'should-block' });
  const acquire = viewerB.sent.filter((entry) => entry.event === 'control-acquire-result').at(-1).data;
  assert.equal(acquire.state, 'REVOKING');
  assert.equal(acquire.reason, 'reset-failed');

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
  // single-desktop-viewer policy: sole desktop viewer; unauthorized write is the
  // no-lease path (no concurrent read-only second desktop viewer).
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host);
  io.connect(viewer);

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
  // Explicit attempt bind (offer or connection-attempt-bind) is required before media.
  viewer.trigger('connection-attempt-bind', {
    schemaVersion: 1,
    connectionAttemptId: 'wrd-1',
    connectionAttemptSequence: 1,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });
  viewer.trigger('media-activity-change', ok);
  const forwarded = host.sent.filter((e) => e.event === 'media-activity-change').at(-1);
  assert.equal(Boolean(forwarded), true);
  assert.equal(forwarded.data.viewerId, 'viewer-1');
  assert.equal(forwarded.data.generation, 1);
  assert.equal(forwarded.data.leaseId, grant.leaseId);

  // A Host apply failure releases this generation for the Viewer's one bounded replay.
  host.trigger('media-activity-ack', {
    schemaVersion: 1,
    state: 'suspended',
    generation: 1,
    connectionAttemptId: 'wrd-1',
    applied: false,
    viewerId: 'viewer-1',
  });
  viewer.trigger('media-activity-change', ok);
  assert.equal(host.sent.filter((e) => e.event === 'media-activity-change').length, 2);

  // Stale generation rejected.
  viewer.trigger('media-activity-change', { ...ok, generation: 1, state: 'active' });
  assert.equal(
    viewer.sent.filter((e) => e.event === 'media-activity-rejected').at(-1).data.reason,
    'stale-generation',
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

test('v2 offer forwards connectionAttemptId and binds media activity to that attempt', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host);
  io.connect(viewer);

  viewer.trigger('control-acquire', { requestId: 'attempt-bind' });
  const transition = host.sent.find((e) => e.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const grant = viewer.sent.find((e) => e.event === 'control-grant').data;

  // Missing attempt id is rejected and not forwarded.
  viewer.trigger('offer', {
    schemaVersion: 2,
    offer: { type: 'offer', sdp: 'v=0' },
    epoch: 1,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });
  assert.equal(host.sent.filter((e) => e.event === 'offer').length, 0);

  viewer.trigger('offer', {
    schemaVersion: 2,
    offer: { type: 'offer', sdp: 'v=0' },
    epoch: 1,
    networkMode: 'stun',
    iceMode: 'stun',
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
    connectionAttemptId: 'attempt-A',
  });
  const forwarded = host.sent.filter((e) => e.event === 'offer').at(-1).data;
  assert.equal(forwarded.connectionAttemptId, 'attempt-A');
  assert.equal(forwarded.viewerId, 'viewer-1');
  assert.equal(forwarded.leaseId, grant.leaseId);

  // Media for a different attempt is rejected even with a higher generation.
  viewer.trigger('media-activity-change', {
    schemaVersion: 1,
    state: 'suspended',
    reasons: ['manual-pause'],
    generation: 9,
    connectionAttemptId: 'attempt-OLD',
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });
  assert.equal(
    viewer.sent.filter((e) => e.event === 'media-activity-rejected').at(-1).data.reason,
    'wrong-attempt',
  );
  assert.equal(host.sent.filter((e) => e.event === 'media-activity-change').length, 0);

  // Matching current attempt is accepted and generation is tracked per attempt.
  viewer.trigger('media-activity-change', {
    schemaVersion: 1,
    state: 'suspended',
    reasons: ['manual-pause'],
    generation: 1,
    connectionAttemptId: 'attempt-A',
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });
  assert.equal(host.sent.filter((e) => e.event === 'media-activity-change').length, 1);

  // New offer rebinds attempt; old attempt cannot suspend/resume the new session.
  viewer.trigger('offer', {
    schemaVersion: 2,
    offer: { type: 'offer', sdp: 'v=1' },
    epoch: 2,
    networkMode: 'stun',
    iceMode: 'stun',
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
    connectionAttemptId: 'attempt-B',
  });
  assert.equal(
    host.sent.filter((e) => e.event === 'offer').at(-1).data.connectionAttemptId,
    'attempt-B',
  );

  viewer.trigger('media-activity-change', {
    schemaVersion: 1,
    state: 'suspended',
    reasons: ['manual-pause'],
    generation: 1,
    connectionAttemptId: 'attempt-A',
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });
  assert.equal(
    viewer.sent.filter((e) => e.event === 'media-activity-rejected').at(-1).data.reason,
    'wrong-attempt',
  );

  // Attempt B can restart generation from a small value without pollution from A.
  viewer.trigger('media-activity-change', {
    schemaVersion: 1,
    state: 'suspended',
    reasons: ['manual-pause'],
    generation: 1,
    connectionAttemptId: 'attempt-B',
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });
  assert.equal(
    host.sent.filter((e) => e.event === 'media-activity-change').at(-1).data.connectionAttemptId,
    'attempt-B',
  );
  assert.equal(
    host.sent.filter((e) => e.event === 'media-activity-change').at(-1).data.generation,
    1,
  );
});

test('tunnel media control requires ACTIVE lease and current attempt then routes Host ack', () => {
  // single-desktop-viewer policy: sole desktop viewer; no concurrent read-only peer.
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host); io.connect(viewer);

  viewer.trigger('control-acquire', { requestId: 't1' });
  const transition = host.sent.find((e) => e.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const grant = viewer.sent.find((e) => e.event === 'control-grant').data;

  // Bind attempt via offer.
  viewer.trigger('offer', {
    schemaVersion: 2,
    offer: { type: 'offer', sdp: 'v=0' },
    epoch: 1,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
    connectionAttemptId: 'attempt-tunnel',
  });

  const mediaControl = {
    schemaVersion: 2,
    mediaControlSchemaVersion: 1,
    enabled: false,
    state: 'suspended',
    generation: 1,
    connectionAttemptId: 'attempt-tunnel',
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
    width: 960,
    height: 540,
    fps: 6,
  };
  viewer.trigger('relay-stream-control', mediaControl);
  const forwarded = host.sent.filter((e) => e.event === 'relay-stream-control').at(-1).data;
  assert.equal(forwarded.viewerId, 'viewer-1');
  assert.equal(forwarded.connectionAttemptId, 'attempt-tunnel');
  assert.equal(forwarded.generation, 1);
  assert.equal(forwarded.state, 'suspended');

  host.trigger('relay-stream-control-ack', {
    schemaVersion: 1,
    state: 'suspended',
    generation: 1,
    connectionAttemptId: 'attempt-tunnel',
    applied: false,
    viewerId: 'viewer-1',
  });
  viewer.trigger('relay-stream-control', mediaControl);
  assert.equal(host.sent.filter((e) => e.event === 'relay-stream-control').length, 2);

  // Wrong attempt rejected.
  viewer.trigger('relay-stream-control', {
    ...mediaControl,
    connectionAttemptId: 'attempt-old',
    generation: 2,
  });
  assert.equal(
    viewer.sent.filter((e) => e.event === 'media-activity-rejected').at(-1)?.data.reason
      || viewer.sent.filter((e) => e.event === 'relay-stream-control-rejected').at(-1)?.data.reason,
    'wrong-attempt',
  );

  // Host ack routes without leaseId.
  host.trigger('relay-stream-control-ack', {
    schemaVersion: 1,
    state: 'suspended',
    generation: 1,
    connectionAttemptId: 'attempt-tunnel',
    applied: true,
    viewerId: 'viewer-1',
    leaseId: grant.leaseId,
  });
  const ack = viewer.sent.filter((e) => e.event === 'relay-stream-control-ack').at(-1)
    || viewer.sent.filter((e) => e.event === 'media-activity-ack').at(-1);
  assert.ok(ack);
  assert.equal(ack.data.applied, true);
  assert.equal(ack.data.generation, 1);
  assert.equal(Object.hasOwn(ack.data, 'leaseId'), false);
});

test('tunnel connection attempt bind does not require a synthetic offer', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host);
  io.connect(viewer);

  const grant = grantActiveLease(io, host, viewer, 'tunnel-bind-first');
  viewer.trigger('connection-attempt-bind', {
    schemaVersion: 1,
    connectionAttemptId: 'attempt-tunnel-A',
    connectionAttemptSequence: 1,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });
  const bound = viewer.sent.filter((e) => e.event === 'connection-attempt-bound').at(-1);
  assert.equal(bound?.data?.connectionAttemptId, 'attempt-tunnel-A');
  assert.equal(bound?.data?.connectionAttemptSequence, 1);

  viewer.trigger('relay-stream-control', {
    schemaVersion: 2,
    mediaControlSchemaVersion: 1,
    enabled: true,
    state: 'active',
    generation: 1,
    connectionAttemptId: 'attempt-tunnel-A',
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });
  assert.equal(host.sent.filter((e) => e.event === 'relay-stream-control').length, 1);
  assert.equal(
    host.sent.filter((e) => e.event === 'relay-stream-control').at(-1).data.connectionAttemptId,
    'attempt-tunnel-A',
  );
});

test('tunnel attempt rebind advances sequence and permanently rejects the old attempt', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host);
  io.connect(viewer);

  const grant = grantActiveLease(io, host, viewer, 'tunnel-rebind');
  viewer.trigger('connection-attempt-bind', {
    schemaVersion: 1,
    connectionAttemptId: 'attempt-A',
    connectionAttemptSequence: 1,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });
  viewer.trigger('relay-stream-control', {
    schemaVersion: 2,
    mediaControlSchemaVersion: 1,
    enabled: false,
    state: 'suspended',
    generation: 1,
    connectionAttemptId: 'attempt-A',
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });
  assert.equal(host.sent.filter((e) => e.event === 'relay-stream-control').length, 1);

  // Refresh / mode switch: sequence 2 binds B.
  viewer.trigger('connection-attempt-bind', {
    schemaVersion: 1,
    connectionAttemptId: 'attempt-B',
    connectionAttemptSequence: 2,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });
  assert.equal(
    viewer.sent.filter((e) => e.event === 'connection-attempt-bound').at(-1).data.connectionAttemptId,
    'attempt-B',
  );

  // Old attempt permanently rejected, even with a higher generation.
  viewer.trigger('relay-stream-control', {
    schemaVersion: 2,
    mediaControlSchemaVersion: 1,
    enabled: false,
    state: 'suspended',
    generation: 9,
    connectionAttemptId: 'attempt-A',
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });
  assert.equal(
    viewer.sent.filter((e) => e.event === 'relay-stream-control-rejected').at(-1).data.reason,
    'wrong-attempt',
  );

  // B starts media generation from 1 (binding resets generation to 0).
  viewer.trigger('relay-stream-control', {
    schemaVersion: 2,
    mediaControlSchemaVersion: 1,
    enabled: true,
    state: 'active',
    generation: 1,
    connectionAttemptId: 'attempt-B',
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });
  assert.equal(
    host.sent.filter((e) => e.event === 'relay-stream-control').at(-1).data.connectionAttemptId,
    'attempt-B',
  );
  assert.equal(
    host.sent.filter((e) => e.event === 'relay-stream-control').at(-1).data.generation,
    1,
  );
});

test('applied:false releases one generation replay without clearing attempt binding', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host);
  io.connect(viewer);

  const grant = grantActiveLease(io, host, viewer, 'replay-bind');
  viewer.trigger('connection-attempt-bind', {
    schemaVersion: 1,
    connectionAttemptId: 'attempt-B',
    connectionAttemptSequence: 1,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });

  const mediaControl = {
    schemaVersion: 2,
    mediaControlSchemaVersion: 1,
    enabled: true,
    state: 'active',
    generation: 1,
    connectionAttemptId: 'attempt-B',
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  };
  viewer.trigger('relay-stream-control', mediaControl);
  assert.equal(host.sent.filter((e) => e.event === 'relay-stream-control').length, 1);

  host.trigger('relay-stream-control-ack', {
    schemaVersion: 1,
    state: 'suspended',
    generation: 1,
    connectionAttemptId: 'attempt-B',
    applied: false,
    viewerId: 'viewer-1',
  });

  // Same generation may replay once; binding remains B.
  viewer.trigger('relay-stream-control', mediaControl);
  assert.equal(host.sent.filter((e) => e.event === 'relay-stream-control').length, 2);

  // Without another applied:false, a second identical generation is stale.
  viewer.trigger('relay-stream-control', mediaControl);
  assert.equal(
    viewer.sent.filter((e) => e.event === 'relay-stream-control-rejected').at(-1).data.reason,
    'stale-generation',
  );

  // Late applied:false for old attempt A cannot clear B or open A.
  host.trigger('relay-stream-control-ack', {
    schemaVersion: 1,
    state: 'suspended',
    generation: 1,
    connectionAttemptId: 'attempt-A',
    applied: false,
    viewerId: 'viewer-1',
  });
  viewer.trigger('relay-stream-control', {
    ...mediaControl,
    connectionAttemptId: 'attempt-A',
    generation: 2,
  });
  assert.equal(
    viewer.sent.filter((e) => e.event === 'relay-stream-control-rejected').at(-1).data.reason,
    'wrong-attempt',
  );
  viewer.trigger('relay-stream-control', {
    ...mediaControl,
    generation: 2,
  });
  assert.equal(
    host.sent.filter((e) => e.event === 'relay-stream-control').at(-1).data.connectionAttemptId,
    'attempt-B',
  );
  assert.equal(
    host.sent.filter((e) => e.event === 'relay-stream-control').at(-1).data.generation,
    2,
  );
});

test('attempt bind rejects stale sequence, non-active lease, and old sockets', () => {
  // single-desktop-viewer policy: no concurrent second desktop viewer; unauthorized
  // covered by wrong-lease / disconnected socket paths.
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host);
  io.connect(viewer);

  const grant = grantActiveLease(io, host, viewer, 'bind-auth');
  viewer.trigger('connection-attempt-bind', {
    schemaVersion: 1,
    connectionAttemptId: 'attempt-A',
    connectionAttemptSequence: 2,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });

  // Same sequence + same attempt is idempotent.
  viewer.trigger('connection-attempt-bind', {
    schemaVersion: 1,
    connectionAttemptId: 'attempt-A',
    connectionAttemptSequence: 2,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });
  assert.equal(
    viewer.sent.filter((e) => e.event === 'connection-attempt-bound').at(-1).data.connectionAttemptSequence,
    2,
  );

  // Same sequence + different attempt rejected.
  viewer.trigger('connection-attempt-bind', {
    schemaVersion: 1,
    connectionAttemptId: 'attempt-Z',
    connectionAttemptSequence: 2,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });
  assert.equal(
    viewer.sent.filter((e) => e.event === 'connection-attempt-bind-rejected').at(-1).data.reason,
    'stale-sequence',
  );

  // Older sequence rejected.
  viewer.trigger('connection-attempt-bind', {
    schemaVersion: 1,
    connectionAttemptId: 'attempt-old',
    connectionAttemptSequence: 1,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });
  assert.equal(
    viewer.sent.filter((e) => e.event === 'connection-attempt-bind-rejected').at(-1).data.reason,
    'stale-sequence',
  );

  // Wrong lease credentials rejected while still ACTIVE on this socket.
  viewer.trigger('connection-attempt-bind', {
    schemaVersion: 1,
    connectionAttemptId: 'attempt-B',
    connectionAttemptSequence: 3,
    leaseId: 'lease-not-mine',
    leaseEpoch: grant.leaseEpoch,
  });
  assert.equal(
    viewer.sent.filter((e) => e.event === 'connection-attempt-bind-rejected').at(-1).data.reason,
    'unauthorized',
  );

  // Offer bind and tunnel bind share one authority: offer advances sequence to 3.
  viewer.trigger('offer', {
    schemaVersion: 2,
    offer: { type: 'offer', sdp: 'v=0' },
    epoch: 1,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
    connectionAttemptId: 'attempt-offer-C',
    connectionAttemptSequence: 3,
  });
  assert.equal(
    host.sent.filter((e) => e.event === 'offer').at(-1).data.connectionAttemptId,
    'attempt-offer-C',
  );
  viewer.trigger('connection-attempt-bind', {
    schemaVersion: 1,
    connectionAttemptId: 'attempt-A',
    connectionAttemptSequence: 2,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });
  assert.equal(
    viewer.sent.filter((e) => e.event === 'connection-attempt-bind-rejected').at(-1).data.reason,
    'stale-sequence',
  );

  // Disconnect clears the binding for this socket.
  viewer.disconnect();
  // Old disconnected socket is not in connections; its bind is ignored/no-op.
  viewer.trigger('connection-attempt-bind', {
    schemaVersion: 1,
    connectionAttemptId: 'attempt-ghost',
    connectionAttemptSequence: 99,
    leaseId: grant.leaseId,
    leaseEpoch: grant.leaseEpoch,
  });
  assert.equal(
    host.sent.filter((e) => e.event === 'relay-stream-control' && e.data?.connectionAttemptId === 'attempt-ghost').length,
    0,
  );
});

test('second desktop viewer supersedes the first', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);
  const a = new FakeSocket('viewer-a', 'viewer');
  const b = new FakeSocket('viewer-b', 'viewer');
  io.connect(a);
  assert.equal(connections.viewers.size, 1);
  assert.equal(connections.viewers.has('viewer-a'), true);
  assert.equal(a.sent.some((entry) => entry.event === 'connected'), true);

  io.connectManual(b);
  assert.equal(connections.viewers.size, 1);
  assert.equal(connections.viewers.has('viewer-b'), true);
  assert.equal(connections.viewers.has('viewer-a'), false);
  assert.ok(a.sent.some((entry) => entry.event === 'viewer-superseded'
    && entry.data?.reason === 'single-desktop-viewer'
    && entry.data?.bySocketId === 'viewer-b'));
  assert.equal(a.disconnected, true);
  assert.equal(b.sent.some((entry) => entry.event === 'connected'), true);
  assert.equal(b.sent.some((entry) => entry.event === 'control-state'), true);
  // Hard order: supersede completes before welcome; A must already be gone when B is connected.
  assert.equal(connections.viewers.get('viewer-b'), b);
});

test('removeDesktopViewer is idempotent under disconnect after supersede', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);
  const host = new FakeSocket('host-1', 'host');
  const a = new FakeSocket('viewer-a', 'viewer');
  const b = new FakeSocket('viewer-b', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  a.handshake.auth.inputProtocolVersion = 2;
  b.handshake.auth.inputProtocolVersion = 2;
  io.connect(host);
  io.connect(a);
  a.trigger('control-acquire', { requestId: 'a' });
  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });

  const transitionsBefore = host.sent.filter((entry) => entry.event === 'control-transition').length;
  io.connectManual(b);
  assert.equal(connections.viewers.size, 1);
  assert.equal(a.disconnected, true);
  const transitionsAfterSupersede = host.sent.filter((entry) => entry.event === 'control-transition').length;
  // ACTIVE controller supersede produces one reset-only transition.
  assert.equal(transitionsAfterSupersede, transitionsBefore + 1);

  // Disconnect already ran via supersede; a second disconnect must be a no-op.
  a.disconnect();
  a.trigger('disconnect');
  assert.equal(connections.viewers.size, 1);
  assert.equal(connections.viewers.has('viewer-b'), true);
  assert.equal(
    host.sent.filter((entry) => entry.event === 'control-transition').length,
    transitionsAfterSupersede,
  );
});

test('host and relay-viewer survive desktop supersede', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);
  const host = new FakeSocket('host-1', 'host');
  const relay = new FakeSocket('relay-1', 'relay-viewer');
  const viewerA = new FakeSocket('viewer-a', 'viewer');
  const viewerB = new FakeSocket('viewer-b', 'viewer');
  io.connect(host);
  io.connect(relay);
  io.connect(viewerA);
  io.connectManual(viewerB);

  assert.equal(connections.host, host);
  assert.equal(connections.relayViewers.has('relay-1'), true);
  assert.equal(connections.viewers.size, 1);
  assert.equal(connections.viewers.has('viewer-b'), true);
  assert.equal(connections.viewers.has('viewer-a'), false);
  assert.equal(viewerA.disconnected, true);
  assert.equal(host.disconnected, false);
  assert.equal(relay.disconnected, false);
  assert.equal(viewerB.disconnected, false);
});

function makeRebindRenewalFixture() {
  resetConnections();
  let now = 0;
  const { DesktopControlLease } = require('../lib/desktop-control-lease');
  const lease = new DesktopControlLease({ now: () => now, makeLeaseId: () => 'lease-000000000001' });
  const timers = [];
  const scheduler = {
    setInterval: () => ({ unref() {} }),
    setTimeout(fn, ms) { const timer = { fn, ms, cancelled: false, unref() {} }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
  };
  const io = makeIo();
  setupSignaling(io, { desktopControlLease: lease, now: () => now, scheduler });
  const host = new FakeSocket('host-renew', 'host');
  const a = new FakeSocket('viewer-renew-a', 'viewer');
  a.handshake.auth.viewerSessionId = 'fixture-same-session';
  io.connect(host); io.connect(a);
  const granted = grantActiveLease(io, host, a);
  now = 2900; a.disconnect();
  now = 10800;
  const b = new FakeSocket('viewer-renew-b', 'viewer');
  b.handshake.auth.viewerSessionId = 'fixture-same-session';
  io.connect(b);
  const rebind = host.sent.find(e => e.event === 'viewer-session-rebind');
  assert.equal(rebind.timeoutMs, 1500);
  assert.equal(b.sent.some(e => e.event === 'control-grant'), false);
  return { lease, host, b, io, rebind, granted, timers, advanceTo: value => { now = value; } };
}

test('confirmed rebind renews only after current Host applied ACK', () => {
  const h = makeRebindRenewalFixture();
  h.advanceTo(11000); h.rebind.ack(null, { status: 'applied' });
  h.advanceTo(13000);
  assert.deepEqual(h.lease.getActiveLease(h.b.id), {
    leaseId: h.granted.leaseId, leaseEpoch: h.granted.leaseEpoch,
  });
  assert.equal(h.b.sent.filter(e => e.event === 'control-grant').length, 1);
  h.advanceTo(22999); assert.ok(h.lease.getActiveLease(h.b.id));
  h.advanceTo(23000); assert.equal(h.lease.getActiveLease(h.b.id), null);
});

for (const outcome of ['deadline', 'timeout', 'host-replaced', 'same-id-host-replaced', 'disconnected', 'superseded']) {
  test(`pending rebind ${outcome} cannot renew, grant, or recreate cancelled work`, () => {
    const h = makeRebindRenewalFixture();
    h.advanceTo(11000);
    if (outcome === 'deadline') h.advanceTo(12000);
    if (outcome === 'timeout') {
      h.advanceTo(12300); h.rebind.ack(new Error('operation has timed out'));
    }
    if (outcome.includes('host-replaced')) h.io.connect(new FakeSocket(
      outcome === 'same-id-host-replaced' ? h.host.id : 'host-renew-next', 'host'));
    if (outcome === 'disconnected') h.b.disconnect();
    if (outcome === 'superseded') {
      const other = new FakeSocket('viewer-renew-unrelated', 'viewer');
      other.handshake.auth.viewerSessionId = 'fixture-other-session'; h.io.connectManual(other);
    }
    const before = h.host.sent.filter(e => e.event === 'control-transition').length;
    h.rebind.ack(null, { status: 'applied' });
    assert.equal(h.b.sent.filter(e => e.event === 'control-grant').length, 0);
    const after = h.host.sent.filter(e => e.event === 'control-transition').length;
    assert.equal(after, before + (outcome === 'deadline' ? 1 : 0));
    h.advanceTo(13000); assert.equal(h.lease.getActiveLease(h.b.id), null);
    h.rebind.ack(null, { status: 'applied' });
    assert.equal(h.host.sent.filter(e => e.event === 'control-transition').length, after);
  });
}

for (const status of ['applied', 'rejected']) {
  test(`same-ID replacement Host cancels rebind ${status} behind a fresh reset barrier`, () => {
    const h = makeRebindRenewalFixture();
    h.advanceTo(11000);
    const currentHost = new FakeSocket(h.host.id, 'host');
    h.io.connect(currentHost);
    h.rebind.ack(null, { status });
    h.b.trigger('control-heartbeat', h.granted);
    h.b.trigger('input', { type: 'mouse', action: 'move', x: 1, y: 1, ...h.granted });
    assert.equal(h.lease.snapshot().state, 'REVOKING');
    assert.equal(h.lease.getActiveLease(h.b.id), null);
    assert.equal(currentHost.sent.some(e => e.event === 'input'), false);
    assert.equal(h.b.sent.some(e => e.event === 'control-grant'), false);
    const reset = currentHost.sent.filter(e => e.event === 'control-transition').at(-1)?.data;
    assert.ok(reset);
    assert.ok(reset.leaseEpoch > h.granted.leaseEpoch);
    assert.equal(reset.viewerId, undefined);
    assert.equal(reset.leaseId, undefined);
    h.host.trigger('control-transition-ack', { leaseEpoch: reset.leaseEpoch, status: 'applied' });
    assert.equal(h.lease.snapshot().state, 'REVOKING');
    h.advanceTo(13000);
    assert.equal(h.lease.getActiveLease(h.b.id), null);
    const transitionCount = currentHost.sent.filter(e => e.event === 'control-transition').length;
    h.rebind.ack(null, { status: 'applied' });
    assert.equal(currentHost.sent.filter(e => e.event === 'control-transition').length, transitionCount);
    currentHost.trigger('control-transition-ack', { leaseEpoch: reset.leaseEpoch, status: 'applied' });
    assert.equal(h.lease.snapshot().state, 'FREE');
    h.b.trigger('control-acquire', { requestId: 'after-current-host-reset' });
    const fresh = currentHost.sent.filter(e => e.event === 'control-transition').at(-1).data;
    assert.ok(fresh.leaseEpoch > reset.leaseEpoch);
    currentHost.trigger('control-transition-ack', { leaseEpoch: fresh.leaseEpoch, status: 'applied' });
    assert.equal(h.b.sent.filter(e => e.event === 'control-grant').length, 1);
  });
}

test('old rebind callback cannot clear a newer same-session rebind operation', () => {
  const h = makeRebindRenewalFixture();
  h.advanceTo(10900); h.b.disconnect();
  const c = new FakeSocket('viewer-renew-c', 'viewer');
  c.handshake.auth.viewerSessionId = 'fixture-same-session'; h.io.connect(c);
  const current = h.host.sent.filter(e => e.event === 'viewer-session-rebind').at(-1);
  assert.notEqual(current, h.rebind);
  h.rebind.ack(null, { status: 'applied' });
  assert.equal(c._wrdRebindPending, true);
  assert.equal(c.sent.some(e => e.event === 'control-grant'), false);
  h.advanceTo(11000); current.ack(null, { status: 'applied' });
  assert.equal(c._wrdRebindPending, false);
  assert.equal(c.sent.filter(e => e.event === 'control-grant').length, 1);
  h.advanceTo(13000); assert.ok(h.lease.getActiveLease(c.id));
});

test('expired rebind clears only its pending gate so reset FREE can accept a fresh acquire', () => {
  const h = makeRebindRenewalFixture();
  h.advanceTo(12000); h.rebind.ack(null, { status: 'applied' });
  assert.equal(h.b._wrdRebindPending, false);
  assert.equal(h.lease.snapshot().state, 'REVOKING');
  const reset = h.host.sent.filter(e => e.event === 'control-transition').at(-1).data;
  assert.ok(reset.leaseEpoch > h.granted.leaseEpoch);
  h.host.trigger('control-transition-ack', { leaseEpoch: reset.leaseEpoch, status: 'applied' });
  assert.equal(h.lease.snapshot().state, 'FREE');
  h.b.trigger('control-acquire', { requestId: 'after-expired-rebind' });
  const fresh = h.host.sent.filter(e => e.event === 'control-transition').at(-1).data;
  assert.ok(fresh.leaseEpoch > reset.leaseEpoch);
  assert.equal(fresh.viewerId, h.b.id);
});

test('old grant ACK cannot clear reset rejection or cancel same-epoch retries', () => {
  resetConnections();
  const timers = [];
  const io = makeIo();
  setupSignaling(io, { scheduler: {
    setInterval: () => ({ unref() {} }),
    setTimeout(fn, ms) { const timer = { fn, ms, cancelled: false, unref() {} }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
  } });
  const host = new FakeSocket('host-old-grant', 'host');
  const viewer = new FakeSocket('viewer-old-grant', 'viewer');
  io.connect(host); io.connect(viewer);
  viewer.trigger('control-acquire', { requestId: 'candidate' });
  const grant = host.sent.filter(e => e.event === 'control-transition').at(-1).data;
  viewer.trigger('control-release', {});
  const reset = host.sent.filter(e => e.event === 'control-transition').at(-1).data;
  assert.ok(reset.leaseEpoch > grant.leaseEpoch);
  host.trigger('control-transition-ack', { leaseEpoch: grant.leaseEpoch, status: 'applied' });
  host.trigger('control-transition-ack', { leaseEpoch: reset.leaseEpoch, status: 'rejected' });
  host.trigger('control-transition-ack', { leaseEpoch: grant.leaseEpoch, status: 'applied' });
  const retry = timers.find(t => t.ms === 1000 && !t.cancelled);
  assert.ok(retry);
  retry.fn();
  const retried = host.sent.filter(e => e.event === 'control-transition').at(-1).data;
  assert.equal(retried.leaseEpoch, reset.leaseEpoch);
  assert.equal(retried.viewerId, undefined);
  assert.equal(viewer.sent.some(e => e.event === 'control-grant'), false);
  viewer.trigger('control-acquire', { requestId: 'still-blocked' });
  assert.equal(viewer.sent.filter(e => e.event === 'control-state').at(-1).data.state, 'REVOKING');
});

test('input ack nullable timing preserves missing values without coercing zero', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);
  const host = new FakeSocket('host-timing', 'host');
  const viewer = new FakeSocket('viewer-timing', 'viewer');
  io.connect(host); io.connect(viewer);
  for (const value of [null, undefined, '', NaN, Infinity, -1, 0, 12.5]) {
    host.trigger('input-ack', { viewerId: viewer.id, inputIds: ['sample'], timingSchemaVersion: 1,
      hostExecuteMs: value, hostAdapterAwaitMs: value, hostQueueMs: value, hostApplyMs: value });
    const ack = viewer.sent.filter(row => row.event === 'input-ack').at(-1).data;
    const expected = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    assert.equal(ack.hostExecuteMs, expected);
    for (const name of ['hostAdapterAwaitMs', 'hostQueueMs', 'hostApplyMs']) assert.equal(ack[name], expected);
  }
});

for (const outcome of ['applied', 'rejected', 'timeout', 'superseded', 'disconnected', 'companion-disconnected']) {
  test(`legacy companion shares pending rebind gate and producer cleanup (${outcome})`, () => {
    resetConnections();
    const io = makeIo();
    setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
    const host = new FakeSocket('legacy-host', 'host');
    const a = new FakeSocket('legacy-a', 'viewer');
    a.handshake.auth.viewerSessionId = 'legacy-session';
    const companion = new FakeSocket('legacy-companion', 'relay-viewer');
    io.connect(host); io.connect(a); io.connect(companion);
    a.trigger('input', { type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } });
    const transition = host.sent.find(e => e.event === 'control-transition').data;
    host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
    companion.trigger('relay-stream-control', { enabled: true });
    assert.equal(host.sent.filter(e => e.event === 'relay-stream-control').at(-1).data.viewerId, a.id);
    a.disconnect();
    const b = new FakeSocket('legacy-b', 'viewer');
    b.handshake.auth.viewerSessionId = 'legacy-session';
    io.connect(b);
    const rebind = host.sent.find(e => e.event === 'viewer-session-rebind');
    assert.ok(rebind);
    const hostBefore = host.sent.length;
    const companionBefore = companion.sent.length;
    const bBefore = b.sent.length;
    const competingCompanion = new FakeSocket('legacy-competing-companion', 'relay-viewer');
    io.connect(competingCompanion);
    competingCompanion.trigger('relay-stream-control', { enabled: true });
    companion.trigger('relay-stream-control', { enabled: true });
    companion.trigger('relay-stream-control', { enabled: false });
    companion.trigger('relay-frame-ack', { frameId: 1 });
    companion.trigger('input', { type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } });
    host.trigger('relay-frame', { viewerId: a.id, frameId: 1, data: 'old' });
    host.trigger('relay-frame', { viewerId: b.id, frameId: 2, data: 'pending' });
    host.trigger('relay-stream-control-ack', { viewerId: b.id, state: 'active', applied: true });
    host.trigger('media-activity-ack', { viewerId: b.id, state: 'active', applied: true });
    assert.equal(host.sent.slice(hostBefore).filter(e => ['relay-stream-control', 'relay-frame-ack', 'input'].includes(e.event)).length, 0);
    assert.equal(companion.sent.slice(companionBefore).filter(e => e.event === 'relay-frame').length, 0);
    assert.equal(b.sent.slice(bBefore).filter(e => ['relay-frame', 'relay-stream-control-ack', 'media-activity-ack'].includes(e.event)).length, 0);
    if (outcome === 'superseded') io.connectManual(new FakeSocket('legacy-superseder', 'viewer'));
    if (outcome === 'disconnected') b.disconnect();
    if (outcome === 'companion-disconnected') companion.disconnect();
    rebind.ack(outcome === 'timeout' ? new Error('timeout') : null,
      { status: ['superseded', 'disconnected'].includes(outcome) ? 'applied' : outcome });
    if (outcome === 'applied') {
      companion.trigger('relay-stream-control', { enabled: true });
      assert.equal(host.sent.filter(e => e.event === 'relay-stream-control').at(-1).data.viewerId, b.id);
      host.trigger('relay-frame', { viewerId: b.id, frameId: 3, data: 'current' });
      assert.equal(companion.sent.filter(e => e.event === 'relay-frame').length, 1);
    } else {
      assert.ok(host.sent.slice(hostBefore).some(e => e.event === 'relay-stream-control' && e.data.enabled === false && e.data.viewerId === a.id));
      companion.trigger('relay-stream-control', { enabled: true });
      assert.equal(host.sent.slice(hostBefore).filter(e => e.event === 'relay-stream-control' && e.data.enabled === true).length, 0);
    }
  });
}

test('disconnect telemetry whitelists protocol reasons without altering host cleanup', () => {
  const events = [];
  const context = createRuntimeContext();
  const io = makeIo();
  setupSignaling(io, {
    runtimeContext: context,
    structuredLogger: { info(event) { events.push(event); } },
  });
  const host = new FakeSocket('runtime-host', 'host');
  io.connect(host);
  host.trigger('disconnect', { payload: 'disconnect-secret-canary' });
  const event = events.find((item) => item.event === 'signal_socket_disconnected');
  assert.equal(event.meta.reason, 'other');
  assert.equal(JSON.stringify(events).includes('disconnect-secret-canary'), false);
  assert.equal(context.connections.host, null);
});

test('disconnect telemetry sink failure cannot prevent existing relay cleanup', () => {
  const context = createRuntimeContext();
  const io = makeIo();
  setupSignaling(io, {
    runtimeContext: context,
    structuredLogger: { info() { throw new Error('sink unavailable'); } },
    recentEventStore: { append() { throw new Error('store unavailable'); } },
  });
  const relay = new FakeSocket('runtime-relay', 'relay-viewer');
  io.connect(relay);
  assert.doesNotThrow(() => relay.trigger('disconnect', 'transport close'));
  assert.equal(context.connections.relayViewers.has(relay.id), false);
});

function strictRelayFixture() {
  resetConnections();
  const io = makeIo(); setupSignaling(io);
  const host = new FakeSocket('m6-host', 'host'), viewer = new FakeSocket('m6-viewer', 'viewer');
  viewer.handshake.auth.inputProtocolVersion = 2;
  host.handshake.auth.inputProtocolVersion = 2;
  io.connect(host); io.connect(viewer);
  const grant = grantActiveLease(io, host, viewer);
  const lease = { schemaVersion: 2, leaseId: grant.leaseId, leaseEpoch: grant.leaseEpoch };
  viewer.trigger('connection-attempt-bind', { ...lease, schemaVersion: 1,
    connectionAttemptId: 'm6-attempt', connectionAttemptSequence: 1 });
  const relayScope = { producerId: 'm6-producer', productionGeneration: 1,
    connectionAttemptId: 'm6-attempt', mediaGeneration: 0, leaseEpoch: grant.leaseEpoch };
  return { io, host, viewer, lease, relayScope };
}

test('strict ordinary generation-zero relay start preserves authenticated binding and dual ACK source', () => {
  const { host, viewer, lease, relayScope } = strictRelayFixture();
  const request = { ...lease, enabled: true, relayFrameSchemaVersion: 1,
    relayStartRequestId: 'm6-start', relayMediaGeneration: 0, connectionAttemptId: 'm6-attempt' };
  viewer.trigger('relay-stream-control', request);
  const forwarded = host.sent.filter(e => e.event === 'relay-stream-control').at(-1).data;
  assert.deepEqual(forwarded, { ...request, viewerId: viewer.id });
  assert.equal('generation' in forwarded, false);
  assert.equal('mediaControlSchemaVersion' in forwarded, false);
  const ack = { viewerId: viewer.id, schemaVersion: 1, state: 'active', generation: 0,
    connectionAttemptId: 'm6-attempt', applied: true, relayControlKind: 'start',
    relayStartRequestId: 'm6-start', relayFrameSchemaVersion: 1, relayScope };
  host.trigger('relay-stream-control-ack', ack);
  const routes = viewer.sent.filter(e => ['relay-stream-control-ack', 'media-activity-ack'].includes(e.event));
  assert.equal(routes.length, 2); assert.deepEqual(routes[0].data, routes[1].data);
  assert.deepEqual(routes[0].data.relayScope, relayScope);
  assert.equal(routes[0].data.relayStartRequestId, 'm6-start');
  assert.equal(routes[0].data.relayControlKind, 'start');
  assert.equal('leaseId' in routes[0].data, false);
  const count = host.sent.filter(e => e.event === 'relay-stream-control').length;
  for (const patch of [{ relayMediaGeneration: true }, { relayMediaGeneration: -1 },
    { relayMediaGeneration: Number.MAX_SAFE_INTEGER + 1 }, { relayStartRequestId: 'a'.repeat(65) },
    { relayFrameSchemaVersion: true }, { connectionAttemptId: 'foreign' }, { leaseEpoch: lease.leaseEpoch + 1 }]) {
    viewer.trigger('relay-stream-control', { ...request, ...patch });
  }
  assert.equal(host.sent.filter(e => e.event === 'relay-stream-control').length, count);
});

test('registered relay frame, ACK and feedback handlers preserve exact source and reject old owners', () => {
  const { io, host, viewer, lease, relayScope } = strictRelayFixture();
  const fields = { relayFrameSchemaVersion: 1, relayScope };
  const frame = { ...fields, viewerId: viewer.id, frameId: 1, data: 'AAAA' };
  host.trigger('relay-frame', frame);
  assert.deepEqual(viewer.sent.filter(e => e.event === 'relay-frame').at(-1).data, frame);
  assert.equal(viewer.sent.filter(e => e.event === 'relay-frame').at(-1).volatile, true);
  viewer.trigger('relay-frame-ack', { ...lease, ...fields, frameId: 1 });
  assert.deepEqual(host.sent.filter(e => e.event === 'relay-frame-ack').at(-1).data,
    { ...lease, ...fields, frameId: 1, viewerId: viewer.id });
  const feedback = { ...fields, viewerId: viewer.id, feedbackSequence: 1,
    sample: { sampleSequence: 1, relayFrameAckRttMs: 1999, privateValue: 'discard' },
    pendingCount: 1, oldestPendingAgeMs: 500, expiredCount: 2, unmatchedAckCount: 3,
    timeoutCount: 4, coalescedCount: 5, lastSentAgeMs: 100, lastAckAgeMs: 0,
    leaseId: 'must-not-be-forwarded', payload: 'must-not-be-forwarded' };
  host.trigger('relay-frame-feedback', feedback);
  const received = viewer.sent.filter(e => e.event === 'relay-frame-feedback').at(-1).data;
  assert.equal(received.coalescedCount, 5);
  assert.deepEqual(received.relayScope, relayScope);
  assert.deepEqual(received.sample, { sampleSequence: 1, relayFrameAckRttMs: 1999 });
  assert.equal('leaseId' in received, false); assert.equal('payload' in received, false);
  const count = viewer.sent.filter(e => e.event === 'relay-frame-feedback').length;
  for (const patch of [{ relayScope: { ...relayScope, mediaGeneration: true } },
    { relayScope: { ...relayScope, producerId: 'a'.repeat(65) } },
    { relayScope: { ...relayScope, connectionAttemptId: 'foreign' } },
    { relayScope: { ...relayScope, leaseEpoch: relayScope.leaseEpoch + 1 } },
    { sample: { sampleSequence: 1, relayFrameAckRttMs: null } },
    { sample: { sampleSequence: 1, relayFrameAckRttMs: 2000 } }, { coalescedCount: true }]) {
    host.trigger('relay-frame-feedback', { ...feedback, ...patch });
  }
  assert.equal(viewer.sent.filter(e => e.event === 'relay-frame-feedback').length, count);
  viewer.trigger('relay-frame-feedback', feedback);
  assert.equal(viewer.sent.filter(e => e.event === 'relay-frame-feedback').length, count);
  const replacementHost = new FakeSocket('m6-new-host', 'host'); io.connect(replacementHost);
  host.trigger('relay-frame', frame); host.trigger('relay-frame-feedback', feedback);
  assert.equal(viewer.sent.filter(e => e.event === 'relay-frame-feedback').length, count);
  assert.equal(viewer.sent.filter(e => e.event === 'relay-frame').length, 1);
});

test('viewer-stats normalizes only nullable latency after current viewer identity admission', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2; viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host); io.connect(viewer);
  const grant = grantActiveLease(io, host, viewer, 'nullable-latency');
  const identity = { schemaVersion: 2, connectionAttemptId: 'nullable-current', connectionAttemptSequence: 2,
    generation: 2, leaseId: grant.leaseId, leaseEpoch: grant.leaseEpoch };
  viewer.trigger('connection-attempt-bind', { ...identity, schemaVersion: 1 });
  const unknowns = [null, undefined, '', '0', '725.1', true, false, {}, NaN, Infinity, -Infinity, -1];
  const reports = () => host.sent.filter(entry => entry.event === 'viewer-stats');
  for (const value of [...unknowns, 0, 0.1, 725.1]) {
    const before = reports().length;
    const payload = { ...identity, viewerId: 'forged', derivedFps: 19, decodedDelta: 19,
      framesDecoded: 19, customLegacyAlias: 17, rttMs: value, jitterBufferMs: value };
    if (value === undefined) { delete payload.rttMs; delete payload.jitterBufferMs; }
    viewer.trigger('viewer-stats', payload);
    assert.equal(reports().length, before + 1);
    const forwarded = reports().at(-1).data;
    const expected = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    assert.equal(forwarded.rttMs, expected); assert.equal(forwarded.jitterBufferMs, expected);
    assert.equal(forwarded.viewerId, viewer.id);
    for (const [key, val] of Object.entries(identity)) assert.equal(forwarded[key], val);
    assert.equal(forwarded.customLegacyAlias, 17); assert.equal(forwarded.framesDecoded, 19);
  }
  const before = reports().length;
  host.trigger('viewer-stats', { ...identity, rttMs: null });
  viewer.trigger('viewer-stats', { ...identity, connectionAttemptId: 'old', connectionAttemptSequence: 1, generation: 1 });
  assert.equal(reports().length, before);
  viewer.trigger('disconnect');
  viewer.trigger('viewer-stats', { ...identity, rttMs: null });
  assert.equal(reports().length, before);
});
