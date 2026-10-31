'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const { createStructuredLogger } = require('../lib/observability/logger');
const { hashInputIds } = require('../lib/observability/input');
const { createRuntimeContext } = require('./runtime-context');

process.env.JWT_SECRET = process.env.JWT_SECRET || '12345678';
process.env.ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || 'test-viewer-password';
process.env.HOST_PASSWORD = process.env.HOST_PASSWORD || 'test-host-password';

const { setupSignaling } = require('./signaling');
const { FakeSocket, makeIo, grantActiveLease } = require('./signaling-test-fixture');

const OBSERVED_EVENT = 'signal_reset_ack_observed';

// Exercise the production handlers, with no sockets, service, or native input.
function fixture({ throwLogger = false, throwStore = false, bindAttempt = true } = {}) {
  const context = createRuntimeContext();
  const io = makeIo(context);
  const events = [];
  const stored = [];
  const persisted = [];
  let now = 1_000;
  const structured = createStructuredLogger({ write: line => persisted.push(JSON.parse(line)) });
  setupSignaling(io, {
    runtimeContext: context,
    now: () => 1_000,
    resetAckNow: () => now,
    makeLeaseId: () => 'lease-RESET_LEASE_CANARY',
    logger: { log() {}, warn() {} },
    structuredLogger: {
      info(event) {
        if (event.event !== OBSERVED_EVENT) return;
        events.push(event);
        if (throwLogger) throw new Error('observer logger unavailable');
        structured.info(event);
      },
    },
    recentEventStore: {
      append(event) {
        if (event.event !== OBSERVED_EVENT) return;
        stored.push(event);
        if (throwStore) throw new Error('observer store unavailable');
      },
    },
    scheduler: {
      setInterval: () => ({ unref() {} }),
      setTimeout: () => ({ unref() {} }),
      clearTimeout() {},
    },
  });
  const host = new FakeSocket('RESET_HOST_CANARY', 'host');
  const viewer = new FakeSocket('RESET_VIEWER_CANARY', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host);
  io.connect(viewer);
  const grant = grantActiveLease(io, host, viewer);
  const lease = { leaseId: grant.leaseId, leaseEpoch: grant.leaseEpoch };
  if (bindAttempt) {
    viewer.trigger('connection-attempt-bind', {
      ...lease, connectionAttemptId: 'RESET_ATTEMPT_CANARY', connectionAttemptSequence: 1,
    });
  }
  let seq = 0;
  const reset = (inputType = 'keyboard', inputId = 'RESET_INPUT_CANARY', overrides = {}) => {
    const input = { schemaVersion: 2, type: inputType, action: 'reset', ...lease,
      seq: ++seq, inputIds: [inputId],
      ...(bindAttempt ? { connectionAttemptId: 'RESET_ATTEMPT_CANARY' } : {}),
      payload: { reason: 'transport-change' }, ...overrides };
    viewer.trigger('input', input);
    return input;
  };
  const ack = (input, overrides = {}) => host.trigger('input-ack', {
    schemaVersion: 2, viewerId: viewer.id, inputType: input.type, leaseEpoch: lease.leaseEpoch,
    appliedSeq: input.seq, pressedKeyCount: 0, modifierMask: 0,
    status: 'applied', inputIds: input.inputIds, connectionAttemptId: input.connectionAttemptId,
    hostExecuteMs: 1.5, ...overrides,
  });
  return { context, io, host, viewer, events, stored, persisted, lease, reset, ack,
    advance(ms) { now += ms; } };
}

for (const inputType of ['keyboard', 'mouse']) {
  test(`reset ACK observer records ${inputType} forwarding with local elapsed time including Host`, () => {
    const h = fixture();
    const input = h.reset(inputType);
    assert.equal(h.host.sent.filter(row => row.event === 'input').length, 1);
    h.advance(125.5);
    h.ack(input);
    const replies = h.viewer.sent.filter(row => row.event === 'input-ack');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].data.inputType, inputType);
    assert.deepEqual(replies[0].data.inputIds, input.inputIds);
    assert.equal(h.events.length, 1);
    assert.deepEqual(h.events[0], {
      domain: 'input', event: OBSERVED_EVENT,
      message: 'Signal reset request to ACK outcome (includes Host processing)',
      correlation: { attemptHash: crypto.createHash('sha256').update('RESET_ATTEMPT_CANARY').digest('hex').slice(0, 32) },
      meta: {
        inputIdHash: hashInputIds(input.inputIds), inputType, leaseEpoch: h.lease.leaseEpoch,
        status: 'applied', targetAvailable: true, shapeValid: true, forwarded: true,
        ackLeaseMatchesRequest: true, ackTypeMatchesRequest: true,
        signalRequestToAckMs: 125.5, durationScope: 'signal-forward-to-host-ack-including-host',
        correlationMissing: false,
      },
    });
    assert.deepEqual(h.stored, h.events);
    assert.equal(h.persisted[0].meta.inputIdHash, hashInputIds(input.inputIds));
    h.ack(input);
    assert.equal(h.viewer.sent.filter(row => row.event === 'input-ack').length, 2);
    assert.equal(h.events.length, 1, 'duplicate ACK forwarding remains unchanged, observation is one-shot');
  });
}

test('reset ACK observer reports original target missing and never reroutes to a later viewer', () => {
  const h = fixture();
  const input = h.reset();
  h.context.connections.viewers.delete(h.viewer.id);
  const replacement = new FakeSocket('replacement-viewer', 'viewer');
  h.context.connections.viewers.set(replacement.id, replacement);
  h.advance(20);
  h.ack(input);
  assert.equal(h.viewer.sent.some(row => row.event === 'input-ack'), false);
  assert.equal(replacement.sent.some(row => row.event === 'input-ack'), false);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].meta.targetAvailable, false);
  assert.equal(h.events[0].meta.shapeValid, true);
  assert.equal(h.events[0].meta.forwarded, false);
});

for (const [field, value] of [
  ['appliedSeq', undefined], ['leaseEpoch', -1], ['pressedKeyCount', -1],
  ['modifierMask', -1], ['inputType', 'ACK_TYPE_CANARY'], ['status', 'ACK_STATUS_CANARY'],
]) {
  test(`reset ACK observer reports rejected v2 shape (${field}) without relaxing routing`, () => {
    const h = fixture();
    const input = h.reset();
    h.ack(input, { [field]: value });
    assert.equal(h.viewer.sent.some(row => row.event === 'input-ack'), false);
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].meta.inputType, 'keyboard');
    assert.equal(h.events[0].meta.leaseEpoch, h.lease.leaseEpoch);
    assert.equal(h.events[0].meta.targetAvailable, true);
    assert.equal(h.events[0].meta.shapeValid, false);
    assert.equal(h.events[0].meta.forwarded, false);
    assert.equal(h.events[0].meta.ackLeaseMatchesRequest, field !== 'leaseEpoch');
    assert.equal(h.events[0].meta.ackTypeMatchesRequest, field !== 'inputType');
    assert.equal(h.events[0].meta.status, field === 'status' ? 'unknown' : 'applied');
    assert.equal(JSON.stringify(h.events).includes('ACK_STATUS_CANARY'), false);
    assert.equal(JSON.stringify(h.events).includes('ACK_TYPE_CANARY'), false);
    h.ack(input);
    assert.equal(h.viewer.sent.filter(row => row.event === 'input-ack').length, 1);
    assert.equal(h.events.length, 1, 'first matched malformed ACK consumes the observation only');
  });
}

for (const mismatch of ['epoch', 'type']) {
  test(`reset ACK observer distinguishes valid ACK shape from request ${mismatch} match`, () => {
    const h = fixture();
    const input = h.reset();
    h.ack(input, mismatch === 'epoch' ? { leaseEpoch: h.lease.leaseEpoch + 1 } : { inputType: 'mouse' });
    assert.equal(h.viewer.sent.filter(row => row.event === 'input-ack').length, 1);
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].meta.shapeValid, true);
    assert.equal(h.events[0].meta.forwarded, true);
    assert.equal(h.events[0].meta.leaseEpoch, h.lease.leaseEpoch);
    assert.equal(h.events[0].meta.inputType, 'keyboard');
    assert.equal(h.events[0].meta.ackLeaseMatchesRequest, mismatch !== 'epoch');
    assert.equal(h.events[0].meta.ackTypeMatchesRequest, mismatch !== 'type');
    h.ack(input);
    assert.equal(h.events.length, 1);
  });
}

test('reset ACK observer ignores non-current Host and viewer ACKs without consuming a pending reset', () => {
  const h = fixture();
  const input = h.reset();
  h.context.connections.host = new FakeSocket('replacement-host', 'host');
  h.ack(input);
  h.viewer.trigger('input-ack', { viewerId: h.viewer.id, inputIds: input.inputIds });
  assert.equal(h.events.length, 0);
  assert.equal(h.viewer.sent.some(row => row.event === 'input-ack'), false);
  h.context.connections.host = h.host;
  h.ack(input);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].meta.forwarded, true);
});

test('reset ACK observer tracks only validated and actually forwarded reset requests', () => {
  const h = fixture();
  const regularKey = h.reset('keyboard', 'ordinary-key', { action: 'key', payload: {
    phase: 'down', code: 'KeyA', location: 0, repeat: false,
    modifiers: { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }, locks: { capsLock: false },
  } });
  const rejected = h.reset('keyboard', 'invalid-reset', { leaseId: 'lease-unauthorized' });
  h.context.connections.host = null;
  const offline = h.reset('mouse', 'offline-reset');
  h.context.connections.host = h.host;
  for (const input of [regularKey, rejected, offline]) h.ack(input);
  assert.equal(h.host.sent.filter(row => row.event === 'input').length, 1);
  assert.equal(h.events.length, 0);
  assert.equal(h.viewer.sent.filter(row => row.event === 'input-ack').length, 3,
    'observation absence never adds new ACK authorization checks');
});

test('reset ACK observer never records a failed Host emit as a forwarded request', () => {
  const h = fixture();
  const originalEmit = h.host.emit;
  h.host.emit = function emit(event, ...args) {
    if (event === 'input') throw new Error('existing Host emit failure');
    return originalEmit.call(this, event, ...args);
  };
  assert.throws(() => h.reset(), /existing Host emit failure/);
  h.host.emit = originalEmit;
  h.ack({ type: 'keyboard', seq: 1, inputIds: ['RESET_INPUT_CANARY'] });
  assert.equal(h.events.length, 0);
  assert.equal(h.viewer.sent.filter(row => row.event === 'input-ack').length, 1);
});

test('reset ACK observer reports legacy ACK shape without changing its existing compatibility forwarding', () => {
  const h = fixture();
  const input = h.reset();
  h.ack(input, { schemaVersion: 1 });
  const replies = h.viewer.sent.filter(row => row.event === 'input-ack');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].data.schemaVersion, 1);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].meta.shapeValid, false, 'shapeValid describes the v2 shape of the matched reset ACK');
  assert.equal(h.events[0].meta.forwarded, true);
});

test('reset ACK observer matches both original viewer and input ID without changing target lookup', () => {
  const h = fixture();
  const input = h.reset();
  const other = new FakeSocket('other-viewer', 'viewer');
  h.context.connections.viewers.set(other.id, other);
  h.ack(input, { viewerId: other.id });
  assert.equal(h.events.length, 0);
  assert.equal(other.sent.filter(row => row.event === 'input-ack').length, 1);
  h.ack(input);
  assert.equal(h.events.length, 1);
  assert.equal(h.viewer.sent.filter(row => row.event === 'input-ack').length, 1);
});

test('reset ACK observer expires at ten seconds without dropping the existing ACK', () => {
  const h = fixture();
  const expired = h.reset();
  h.advance(10_000);
  h.ack(expired);
  assert.equal(h.events.length, 0);
  assert.equal(h.viewer.sent.filter(row => row.event === 'input-ack').length, 1);
  const current = h.reset('mouse', 'current-reset');
  h.advance(9_999);
  h.ack(current);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].meta.signalRequestToAckMs, 9_999);
});

test('reset ACK observer cap evicts the oldest record while preserving all ACK forwarding', () => {
  const h = fixture();
  const inputs = Array.from({ length: 33 }, (_, index) => h.reset('keyboard', `bounded-reset-${index}`));
  h.ack(inputs[0]);
  assert.equal(h.events.length, 0);
  for (const input of inputs.slice(1)) h.ack(input);
  assert.equal(h.events.length, 32);
  assert.equal(h.viewer.sent.filter(row => row.event === 'input-ack').length, 33);
});

test('reset ACK observer stays isolated between setupSignaling runtime contexts', () => {
  const first = fixture();
  const second = fixture();
  const input = first.reset();
  second.ack(input);
  assert.equal(second.events.length, 0);
  first.ack(input);
  assert.equal(first.events.length, 1);
});

test('reset ACK observer emits only the fixed safe projection through actual structured persistence', () => {
  const h = fixture();
  const input = h.reset();
  h.ack(input, { key: 'RAW_KEY_CANARY', payload: { secret: 'RAW_PAYLOAD_CANARY' },
    leaseId: 'RAW_ACK_LEASE_CANARY', extra: 'RAW_EXTRA_CANARY' });
  assert.equal(h.events.length, 1);
  const serialized = JSON.stringify([h.events, h.stored, h.persisted]);
  for (const canary of ['RESET_INPUT_CANARY', 'RESET_VIEWER_CANARY', 'RESET_HOST_CANARY',
    'RESET_LEASE_CANARY', 'RAW_KEY_CANARY', 'RAW_PAYLOAD_CANARY', 'RAW_ACK_LEASE_CANARY', 'RAW_EXTRA_CANARY']) {
    assert.equal(serialized.includes(canary), false, canary);
  }
  assert.deepEqual(Object.keys(h.events[0].meta).sort(), [
    'ackLeaseMatchesRequest', 'ackTypeMatchesRequest',
    'durationScope', 'forwarded', 'inputIdHash', 'inputType', 'leaseEpoch',
    'shapeValid', 'signalRequestToAckMs', 'status', 'targetAvailable', 'correlationMissing',
  ].sort());
});

test('reset ACK observer marks legacy missing attempt correlation without inventing one', () => {
  const h = fixture({ bindAttempt: false });
  const input = h.reset();
  h.advance(10);
  h.ack(input);
  assert.deepEqual(h.events[0].correlation, {});
  assert.equal(h.events[0].meta.correlationMissing, true);
});

test('reset ACK observer logger and recent-store exceptions cannot block ACK forwarding', () => {
  const h = fixture({ throwLogger: true, throwStore: true });
  const input = h.reset();
  assert.doesNotThrow(() => h.ack(input));
  assert.equal(h.viewer.sent.filter(row => row.event === 'input-ack').length, 1);
  assert.equal(h.events.length, 1);
  assert.equal(h.stored.length, 1, 'each diagnostic sink is isolated independently');
});
