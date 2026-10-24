'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { hashInputIds } = require('../lib/observability/input');
const { createResetAckObserver } = require('../lib/observability/reset-ack-observer');

function fixture(options = {}) {
  let at = 100;
  const observations = [];
  const observer = createResetAckObserver({
    now: () => at,
    onObservation: (meta) => observations.push(meta),
    ...options,
  });
  const request = (overrides = {}) => ({
    schemaVersion: 2, type: 'keyboard', action: 'reset', leaseEpoch: 5,
    inputIds: ['reset-fixture'], viewerId: 'viewer-fixture', ...overrides,
  });
  const ack = (overrides = {}) => ({
    schemaVersion: 2, inputType: 'keyboard', leaseEpoch: 5, status: 'applied',
    inputIds: ['reset-fixture'], viewerId: 'viewer-fixture', ...overrides,
  });
  return { observer, observations, request, ack, advance(ms) { at += ms; } };
}

test('reset ACK observation uses the exact fixed metadata and measures Signal round trip', () => {
  const h = fixture();
  h.observer.noteForwarded(h.request());
  h.advance(25.5);
  h.observer.observeAck(h.ack(), { targetAvailable: true, shapeValid: true, forwarded: true });
  assert.deepEqual(h.observations, [{
    inputIdHash: hashInputIds(['reset-fixture']), inputType: 'keyboard', leaseEpoch: 5,
    status: 'applied', targetAvailable: true, shapeValid: true, forwarded: true,
    ackLeaseMatchesRequest: true, ackTypeMatchesRequest: true,
    signalRequestToAckMs: 25.5,
    durationScope: 'signal-forward-to-host-ack-including-host',
  }]);
  assert.equal(h.observer.pendingCount(), 0);
});

test('only valid v2 mouse and keyboard reset requests create pending observations', () => {
  const h = fixture();
  for (const patch of [
    { schemaVersion: 1 }, { type: 'command' }, { type: 'mouse', action: 'move' },
    { action: 'key' }, { leaseEpoch: 0 }, { leaseEpoch: -1 }, { leaseEpoch: true },
    { leaseEpoch: Number.MAX_SAFE_INTEGER + 1 }, { inputIds: [] },
    { inputIds: ['bad id'] }, { inputIds: ['x'.repeat(129)] },
    { inputIds: Array.from({ length: 65 }, (_, i) => `id-${i}`) },
    { viewerId: '' }, { viewerId: 'x'.repeat(129) }, { viewerId: {} },
  ]) h.observer.noteForwarded(h.request(patch));
  for (const malformed of [null, undefined, [], 'reset']) h.observer.noteForwarded(malformed);
  assert.equal(h.observer.pendingCount(), 0);
  h.observer.noteForwarded(h.request({ type: 'mouse', viewerId: '_socket-fixture' }));
  h.observer.observeAck(h.ack({ viewerId: '_socket-fixture', inputType: 'mouse' }), {});
  assert.equal(h.observations.length, 1);
  assert.equal(h.observations[0].inputType, 'mouse');
});

test('matching requires the exact viewer and input ID and consumes each first ACK once', () => {
  const h = fixture();
  h.observer.noteForwarded(h.request({ inputIds: ['one', 'two'] }));
  h.observer.noteForwarded(h.request({ viewerId: 'other-viewer', inputIds: ['one'] }));
  for (const data of [h.ack({ viewerId: 'unknown' }), h.ack({ inputIds: ['unknown'] }), null, []]) {
    h.observer.observeAck(data, {});
  }
  assert.equal(h.observer.pendingCount(), 3);
  h.observer.observeAck(h.ack({ inputIds: ['one', 'one', 'two'] }), {});
  h.observer.observeAck(h.ack({ inputIds: ['one', 'two'] }), {});
  assert.deepEqual(h.observations.map((item) => item.inputIdHash), [hashInputIds(['one']), hashInputIds(['two'])]);
  assert.equal(h.observer.pendingCount(), 1);
  h.observer.observeAck(h.ack({ viewerId: 'other-viewer', inputIds: ['one'] }), {});
  assert.equal(h.observations.length, 3);
});

test('a matched malformed ACK is observed using request identity and fixed unknown status', () => {
  const h = fixture();
  h.observer.noteForwarded(h.request());
  h.observer.observeAck(h.ack({ leaseEpoch: 'ACK_EPOCH_CANARY', inputType: 'ACK_TYPE_CANARY', status: 'STATUS_CANARY' }),
    { targetAvailable: false, shapeValid: false, forwarded: false });
  assert.equal(h.observations.length, 1);
  assert.deepEqual({ ...h.observations[0], signalRequestToAckMs: 0 }, {
    inputIdHash: hashInputIds(['reset-fixture']), inputType: 'keyboard', leaseEpoch: 5,
    status: 'unknown', targetAvailable: false, shapeValid: false, forwarded: false,
    ackLeaseMatchesRequest: false, ackTypeMatchesRequest: false,
    signalRequestToAckMs: 0, durationScope: 'signal-forward-to-host-ack-including-host',
  });
});

test('same input ID across epochs retains the first request and reports only matching booleans', () => {
  const h = fixture();
  h.observer.noteForwarded(h.request());
  h.advance(10);
  h.observer.noteForwarded(h.request({ leaseEpoch: 6, type: 'mouse' }));
  h.observer.observeAck(h.ack({ leaseEpoch: 6, inputType: 'mouse' }),
    { targetAvailable: true, shapeValid: true, forwarded: true });
  assert.equal(h.observations.length, 1);
  assert.equal(h.observations[0].leaseEpoch, 5);
  assert.equal(h.observations[0].inputType, 'keyboard');
  assert.equal(h.observations[0].ackLeaseMatchesRequest, false);
  assert.equal(h.observations[0].ackTypeMatchesRequest, false);
  h.observer.observeAck(h.ack(), {});
  assert.equal(h.observations.length, 1, 'first matched ACK consumes even a mismatched epoch/type');
});

test('all ACK protocol statuses are retained while other values become unknown', () => {
  const h = fixture();
  const statuses = ['applied', 'duplicate', 'stale-lease', 'sequence-gap', 'resync-required',
    'invalid-input', 'unsupported-code', 'execution-failed'];
  for (const status of [...statuses, 'accepted', 'unordered', null, {}, true]) {
    h.observer.noteForwarded(h.request());
    h.observer.observeAck(h.ack({ status }), { targetAvailable: 1, shapeValid: 'yes', forwarded: {} });
  }
  assert.deepEqual(h.observations.map((item) => item.status), [...statuses, ...Array(5).fill('unknown')]);
  assert.ok(h.observations.every((item) => item.targetAvailable === false && item.shapeValid === false && item.forwarded === false));
});

test('TTL expires at the boundary and repeated pending forwards do not extend the original deadline', () => {
  const h = fixture({ ttlMs: 10 });
  h.observer.noteForwarded(h.request());
  h.advance(6);
  h.observer.noteForwarded(h.request());
  h.advance(4);
  h.observer.observeAck(h.ack(), {});
  assert.deepEqual(h.observations, []);
  assert.equal(h.observer.pendingCount(), 0);
  h.observer.noteForwarded(h.request());
  h.advance(9);
  h.observer.observeAck(h.ack(), {});
  assert.equal(h.observations[0].signalRequestToAckMs, 9);
});

test('capacity evicts oldest pending entries and production cap and TTL cannot be enlarged', () => {
  const h = fixture({ maxEntries: 2 });
  for (const id of ['old', 'middle', 'new']) h.observer.noteForwarded(h.request({ inputIds: [id] }));
  assert.equal(h.observer.pendingCount(), 2);
  h.observer.observeAck(h.ack({ inputIds: ['old', 'middle', 'new'] }), {});
  assert.deepEqual(h.observations.map((item) => item.inputIdHash), [hashInputIds(['middle']), hashInputIds(['new'])]);
  const bounded = fixture({ maxEntries: 1000, ttlMs: 1000000 });
  for (let i = 0; i < 40; i += 1) bounded.observer.noteForwarded(bounded.request({ inputIds: [`id-${i}`] }));
  assert.equal(bounded.observer.pendingCount(), 32);
  bounded.advance(10000);
  assert.equal(bounded.observer.pendingCount(), 0);
});

test('observation does not read or retain payload, lease tokens, raw IDs, viewers or arbitrary ACK fields', () => {
  const h = fixture();
  const request = h.request({ inputIds: ['RAW_INPUT_CANARY'], viewerId: 'VIEWER_CANARY' });
  Object.defineProperties(request, {
    payload: { get() { throw new Error('PAYLOAD_CANARY'); } },
    leaseId: { get() { throw new Error('LEASE_CANARY'); } },
  });
  h.observer.noteForwarded(request);
  request.inputIds[0] = 'MUTATED_INPUT_CANARY'; request.viewerId = 'MUTATED_VIEWER_CANARY';
  const ack = h.ack({ inputIds: ['RAW_INPUT_CANARY'], viewerId: 'VIEWER_CANARY' });
  Object.defineProperty(ack, 'reason', { get() { throw new Error('ACK_REASON_CANARY'); } });
  h.observer.observeAck(ack, { targetAvailable: true, shapeValid: true, forwarded: true, secret: 'OUTCOME_CANARY' });
  assert.equal(h.observations.length, 1);
  assert.equal(h.observations[0].inputIdHash, hashInputIds(['RAW_INPUT_CANARY']));
  assert.doesNotMatch(JSON.stringify(h.observations), /CANARY/);
});

test('clock failures and backwards clocks cannot throw or fabricate durations', () => {
  let at = 100, fail = false;
  const h = fixture({ now: () => { if (fail) throw new Error('CLOCK_CANARY'); return at; } });
  h.observer.noteForwarded(h.request());
  fail = true;
  assert.doesNotThrow(() => h.observer.observeAck(h.ack(), {}));
  assert.doesNotThrow(() => h.observer.noteForwarded(h.request()));
  assert.doesNotThrow(() => h.observer.pendingCount());
  fail = false;
  assert.equal(h.observer.pendingCount(), 0);
  for (const value of [NaN, Infinity, -1, '100']) {
    at = value;
    assert.doesNotThrow(() => h.observer.noteForwarded(h.request()));
  }
  at = 100; h.observer.noteForwarded(h.request()); at = 99;
  assert.doesNotThrow(() => h.observer.observeAck(h.ack(), {}));
  assert.equal(h.observer.pendingCount(), 0);
  assert.deepEqual(h.observations, []);
});

test('a throwing observer consumes matches once without blocking other observations or contexts', () => {
  let calls = 0;
  const h = fixture({ onObservation() { calls += 1; throw new Error('LOGGER_CANARY'); } });
  const independent = fixture();
  h.observer.noteForwarded(h.request({ inputIds: ['one', 'two'] }));
  independent.observer.noteForwarded(independent.request());
  assert.doesNotThrow(() => h.observer.observeAck(h.ack({ inputIds: ['one', 'two'] }), {}));
  assert.equal(calls, 2);
  h.observer.observeAck(h.ack({ inputIds: ['one', 'two'] }), {});
  assert.equal(calls, 2);
  assert.equal(h.observer.pendingCount(), 0);
  assert.equal(independent.observer.pendingCount(), 1);
  independent.observer.observeAck(independent.ack(), {});
  assert.equal(independent.observations.length, 1);
});

test('default observer has a monotonic clock and needs no callback or timers', () => {
  const observer = createResetAckObserver();
  const h = fixture();
  assert.doesNotThrow(() => observer.noteForwarded(h.request()));
  assert.equal(observer.pendingCount(), 1);
  assert.doesNotThrow(() => observer.observeAck(h.ack(), {}));
  assert.equal(observer.pendingCount(), 0);
});
