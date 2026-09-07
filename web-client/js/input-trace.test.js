const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const test = require('node:test');

let InputTrace = null;
try {
  ({ InputTrace } = require('./input-trace.js'));
} catch (_error) {
  // RED phase: the production collector is intentionally absent until the
  // first implementation step. The tests below must fail by assertion, not
  // by a module-loading error.
}

async function hashInputIds(ids) {
  const bytes = new TextEncoder().encode(ids.join('\x1f'));
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(digest).toString('hex').slice(0, 16);
}

function requireCollector() {
  assert.equal(typeof InputTrace?.create, 'function', 'InputTrace.create must be available');
  return InputTrace;
}

async function settleHashes(trace, limit = 100) {
  for (let turn = 0; turn < limit && trace.snapshot().counters.pendingHashCount; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('correlates input IDs without retaining secret payload fields', async () => {
  const trace = requireCollector().create({ now: () => 10, hashInputIds });
  trace.record('dom-received', {
    inputType: 'keyboard', action: 'key', phase: 'down',
    focusKind: 'desktop', visibility: 'visible',
    key: 'KEY_CANARY', payload: { text: 'TEXT_CANARY' }, leaseId: 'LEASE_CANARY',
  });
  trace.record('transport-send', {
    inputType: 'keyboard', action: 'key', accepted: true,
    inputIds: ['kbd_fixture_1'], seq: 1, leaseEpoch: 7,
    key: 'KEY_CANARY', payload: { text: 'TEXT_CANARY' }, leaseId: 'LEASE_CANARY',
  });
  await settleHashes(trace);
  const snapshot = trace.snapshot();
  const transport = snapshot.events.find((event) => event.stage === 'transport-send');
  assert.equal(transport.inputIdHash, '3e9fd6a21afbb55b');
  const json = JSON.stringify(snapshot);
  for (const secret of ['kbd_fixture_1', 'KEY_CANARY', 'TEXT_CANARY', 'LEASE_CANARY']) {
    assert.equal(json.includes(secret), false, `snapshot leaked ${secret}`);
  }
});

test('records hash unavailability and failed digests without blocking input tracing', async () => {
  const unavailable = requireCollector().create({
    now: () => 10,
    hashInputIds: null,
  });
  unavailable.record('transport-send', {
    inputType: 'keyboard', action: 'key', accepted: true,
    inputIds: ['missing-crypto'], seq: 1,
  });
  await settleHashes(unavailable);
  assert.equal(unavailable.snapshot().events[0].inputIdHash, null);
  assert.equal(unavailable.snapshot().counters.hashUnavailable, 1);

  const failed = requireCollector().create({
    now: () => 10,
    hashInputIds: async () => { throw new Error('digest failed'); },
  });
  assert.doesNotThrow(() => failed.record('transport-send', {
    inputType: 'keyboard', action: 'key', accepted: true,
    inputIds: ['digest-failure'], seq: 1,
  }));
  await settleHashes(failed);
  assert.equal(failed.snapshot().events[0].inputIdHash, null);
  assert.equal(failed.snapshot().counters.hashUnavailable, 1);
});

test('bounds asynchronous hash work at 64 and reports dropped hash jobs', async () => {
  const resolvers = [];
  const trace = requireCollector().create({
    now: () => 10,
    hashInputIds: () => new Promise((resolve) => resolvers.push(resolve)),
  });
  for (let index = 0; index < 65; index += 1) {
    trace.record('transport-send', {
      inputType: 'keyboard', action: 'key', accepted: true,
      inputIds: [`bounded-${index}`], seq: index + 1,
    });
  }
  let snapshot = trace.snapshot();
  assert.equal(snapshot.counters.pendingHashCount, 64);
  assert.equal(snapshot.counters.droppedHashCount, 1);
  resolvers.splice(0).forEach((resolve) => resolve('abcdef0123456789'));
  await settleHashes(trace);
  snapshot = trace.snapshot();
  assert.equal(snapshot.counters.pendingHashCount, 0);
  assert.equal(snapshot.counters.hashUnavailable, 0);
});

test('ring eviction does not release unresolved hash slots', async () => {
  const resolvers = [];
  let hashCalls = 0;
  const trace = requireCollector().create({
    now: () => 10,
    hashInputIds: (ids) => {
      hashCalls += 1;
      return new Promise((resolve) => resolvers.push({ ids, resolve }));
    },
    setTimeoutFn: () => null,
  });

  for (let index = 0; index < 64; index += 1) {
    trace.record('transport-send', {
      inputType: 'keyboard', action: 'key', accepted: true, reliable: false,
      inputIds: [`stalled-${index}`], seq: index,
    });
  }
  assert.equal(hashCalls, 64);
  assert.equal(trace.snapshot().counters.pendingHashCount, 64);

  // Evict every original event while all digest promises remain unresolved.
  for (let index = 0; index < 256; index += 1) {
    trace.record('lifecycle', {
      action: 'visibility', state: 'visible', reason: 'visibility-visible',
    });
  }
  assert.equal(trace.snapshot().counters.pendingHashCount, 64);

  for (let index = 0; index < 64; index += 1) {
    trace.record('transport-send', {
      inputType: 'keyboard', action: 'key', accepted: true, reliable: false,
      inputIds: [`blocked-${index}`], seq: index,
    });
  }
  assert.equal(hashCalls, 64, 'evicted events must not free unresolved hash capacity');
  assert.equal(trace.snapshot().counters.droppedHashCount, 64);

  resolvers.splice(0).forEach(({ resolve }) => resolve('abcdef0123456789'));
  await settleHashes(trace);
  assert.equal(trace.snapshot().counters.pendingHashCount, 0);

  trace.record('transport-send', {
    inputType: 'keyboard', action: 'key', accepted: true, reliable: false,
    inputIds: ['after-stall'], seq: 99,
  });
  assert.equal(hashCalls, 65);
});

test('keeps the trace ring at 256 entries and the serialized snapshot under 64 KiB', () => {
  const trace = requireCollector().create({ now: () => 1000 });
  for (let index = 0; index < 300; index += 1) {
    trace.record('lifecycle', {
      action: index % 2 ? 'visibility' : 'focus',
      state: index % 2 ? 'hidden' : 'visible',
      reason: index % 2 ? 'visibility-hidden' : 'window-focus',
      connectionAttemptId: `attempt-${index}`,
      leaseEpoch: index,
    });
  }
  const snapshot = trace.snapshot();
  assert.equal(snapshot.events.length, 256);
  assert.ok(snapshot.counters.droppedEvents >= 44);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= 64 * 1024);
});

test('limits reliable ACK waiters and preserves late classification beside receiver outcome', () => {
  let now = 1000;
  let nextTimerId = 0;
  const timers = new Map();
  const incidents = [];
  const trace = requireCollector().create({
    now: () => now,
    hashInputIds: async () => null,
    setTimeoutFn(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeoutFn(id) { timers.delete(id); },
    onIncident(reason, identity) { incidents.push({ reason, identity }); },
  });
  for (let index = 0; index < 260; index += 1) {
    trace.record('transport-send', {
      inputType: 'keyboard', action: 'key', accepted: true,
      inputIds: [`ack-${index}`], seq: index + 1, leaseEpoch: 7,
      connectionAttemptId: 'attempt-1',
    });
  }
  let snapshot = trace.snapshot();
  assert.equal(snapshot.counters.pendingAckCount, 256);
  assert.equal(snapshot.counters.evictedPendingAcks, 4);
  assert.ok(timers.size <= 1);

  now = 4001;
  const deadline = [...timers.values()][0];
  assert.ok(deadline, 'a single ACK deadline timer should be installed');
  deadline.callback();
  snapshot = trace.snapshot();
  assert.ok(snapshot.events.some((event) => event.stage === 'ack-timeout'));
  assert.equal(incidents.length, 256);
  assert.equal(incidents[0].reason, 'input-ack-timeout');
  assert.deepEqual(incidents[0].identity, {
    connectionAttemptId: 'attempt-1', leaseEpoch: 7,
  });

  now = 4100;
  trace.record('ack', {
    inputType: 'keyboard', inputIds: ['ack-259'], status: 'applied',
    appliedSeq: 260, leaseEpoch: 7, connectionAttemptId: 'attempt-1',
  });
  snapshot = trace.snapshot();
  const late = snapshot.events.find((event) => event.stage === 'ack' && event.reason === 'late-ack');
  assert.ok(late, 'a late ACK must remain distinguishable from an on-time success');
  assert.equal(late.accepted, true, 'late classification must not erase an applied receiver outcome');
  assert.equal(late.status, 'applied');
});

test('preserves receiver ACK outcome and does not clear on stale identity', () => {
  let now = 1000;
  let nextTimerId = 0;
  const timers = new Map();
  const incidents = [];
  const trace = requireCollector().create({
    now: () => now,
    hashInputIds: null,
    setTimeoutFn(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeoutFn(id) { timers.delete(id); },
    onIncident(reason, identity) { incidents.push({ reason, identity }); },
  });
  trace.record('transport-send', {
    inputType: 'keyboard', action: 'key', accepted: true, inputIds: ['same-id'],
    seq: 1, leaseEpoch: 8, connectionAttemptId: 'attempt-current',
  });

  trace.record('ack', {
    inputType: 'keyboard', inputIds: ['same-id'], accepted: false, status: 'applied',
    appliedSeq: 1, leaseEpoch: 7, connectionAttemptId: 'attempt-old',
  });
  let snapshot = trace.snapshot();
  const staleAck = snapshot.events.find((event) => event.stage === 'ack');
  assert.equal(staleAck.accepted, false);
  assert.equal(staleAck.status, 'applied');
  assert.equal(staleAck.reason, undefined);
  assert.equal(snapshot.counters.pendingAckCount, 1);

  now = 4001;
  [...timers.values()][0].callback();
  snapshot = trace.snapshot();
  assert.equal(snapshot.counters.ackTimeoutCount, 1);
  assert.equal(incidents.length, 1);
  assert.ok(snapshot.events.some((event) => event.stage === 'ack-timeout'));

  now = 4100;
  trace.record('ack', {
    inputType: 'keyboard', inputIds: ['same-id'], accepted: false, status: 'applied',
    appliedSeq: 1, leaseEpoch: 8, connectionAttemptId: 'attempt-current',
  });
  snapshot = trace.snapshot();
  const lateAck = snapshot.events.filter((event) => event.stage === 'ack').at(-1);
  assert.equal(lateAck.accepted, false, 'late classification must not replace receiver acceptance');
  assert.equal(lateAck.status, 'applied');
  assert.equal(lateAck.reason, 'late-ack');
  assert.equal(snapshot.counters.pendingAckCount, 0);
});

test('aggregates high-frequency move and wheel input without per-event traces or hashing', () => {
  let hashCalls = 0;
  const trace = requireCollector().create({
    hashInputIds: async () => { hashCalls += 1; return 'never-used'; },
  });
  for (let index = 0; index < 1000; index += 1) {
    trace.record('dom-received', {
      inputType: 'pointer', action: 'move', phase: 'move', focusKind: 'desktop',
      inputIds: [`move-${index}`],
    });
    trace.record('transport-send', {
      inputType: 'mouse', action: index % 2 ? 'wheel' : 'move', accepted: true,
      inputIds: [`move-${index}`],
    });
  }
  const snapshot = trace.snapshot();
  assert.equal(snapshot.events.length, 0);
  assert.equal(hashCalls, 0);
  assert.equal(snapshot.counters.sampledEvents, 2000);
  assert.equal(snapshot.counters.mouseMoveCount, 1500);
  assert.equal(snapshot.counters.wheelCount, 500);
});
