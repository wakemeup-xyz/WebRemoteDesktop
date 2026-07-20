'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { MediaActivityRuntime } = require('./media-activity-runtime.js');

function makeRuntime() {
  let now = 0;
  const timers = new Map();
  let nextId = 1;
  const phases = [];
  const runtime = MediaActivityRuntime.create({
    requestTimeoutMs: 100,
    setTimeoutFn: (fn, delay) => {
      const id = nextId++;
      timers.set(id, { fn, due: now + delay });
      return id;
    },
    clearTimeoutFn: (id) => { timers.delete(id); },
    onPhaseChange: (snap) => phases.push(snap.phase),
  });
  return {
    runtime,
    phases,
    advance(ms) {
      const target = now + ms;
      while (timers.size) {
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
    },
    liveTimers: () => timers.size,
  };
}

test('desired suspend and matching ack move through suspending to suspended', () => {
  const { runtime } = makeRuntime();
  const started = runtime.beginDesired('suspended', {
    generation: 1,
    connectionAttemptId: 'a1',
  });
  assert.equal(started.accepted, true);
  assert.equal(runtime.phase, 'suspending');
  assert.equal(runtime.isHealthSuppressed(), true);
  assert.equal(runtime.canEnableDesktopInput(), false);

  const ack = runtime.applyAck({
    state: 'suspended', generation: 1, connectionAttemptId: 'a1', applied: true,
  });
  assert.equal(ack.accepted, true);
  assert.equal(runtime.phase, 'suspended');
});

test('resume requires matching ack and fresh rendered frame before active', () => {
  const { runtime } = makeRuntime();
  runtime.beginDesired('suspended', { generation: 1, connectionAttemptId: 'a1' });
  runtime.applyAck({ state: 'suspended', generation: 1, connectionAttemptId: 'a1', applied: true });
  runtime.beginDesired('active', { generation: 2, connectionAttemptId: 'a1' });
  assert.equal(runtime.phase, 'resuming');
  assert.equal(runtime.canEnableDesktopInput(), false);

  assert.equal(runtime.noteRenderedFrame({ connectionAttemptId: 'a1' }).accepted, false);
  runtime.applyAck({ state: 'active', generation: 2, connectionAttemptId: 'a1', applied: true });
  assert.equal(runtime.phase, 'resuming');
  assert.equal(runtime.noteRenderedFrame({ connectionAttemptId: 'a1' }).accepted, true);
  assert.equal(runtime.phase, 'active');
  assert.equal(runtime.canEnableDesktopInput(), true);
});

test('stale ack and wrong attempt are ignored', () => {
  const { runtime } = makeRuntime();
  runtime.beginDesired('suspended', { generation: 3, connectionAttemptId: 'a2' });
  assert.equal(runtime.applyAck({
    state: 'suspended', generation: 2, connectionAttemptId: 'a2', applied: true,
  }).accepted, false);
  assert.equal(runtime.applyAck({
    state: 'suspended', generation: 3, connectionAttemptId: 'other', applied: true,
  }).accepted, false);
  assert.equal(runtime.phase, 'suspending');
});

test('ack without an attempt id cannot advance a request bound to an attempt', () => {
  const { runtime } = makeRuntime();
  runtime.beginDesired('suspended', { generation: 1, connectionAttemptId: 'a1' });

  const ack = runtime.applyAck({
    state: 'suspended', generation: 1, applied: true,
  });

  assert.equal(ack.accepted, false);
  assert.equal(ack.reason, 'wrong-attempt');
  assert.equal(runtime.phase, 'suspending');
});

test('late suspended ack cannot override newer resuming request', () => {
  const { runtime } = makeRuntime();
  runtime.beginDesired('suspended', { generation: 1, connectionAttemptId: 'a1' });
  runtime.beginDesired('active', { generation: 2, connectionAttemptId: 'a1' });
  assert.equal(runtime.phase, 'resuming');
  assert.equal(runtime.applyAck({
    state: 'suspended', generation: 1, connectionAttemptId: 'a1', applied: true,
  }).accepted, false);
  assert.equal(runtime.phase, 'resuming');
});

test('same in-flight desired state binds a replacement connection attempt', () => {
  const { runtime } = makeRuntime();
  runtime.beginDesired('active', { generation: 2, connectionAttemptId: 'attempt-a' });

  const rebound = runtime.beginDesired('active', {
    generation: 2,
    connectionAttemptId: 'attempt-b',
  });

  assert.equal(rebound.accepted, true);
  assert.equal(rebound.connectionAttemptId, 'attempt-b');
  assert.equal(runtime.phase, 'resuming');
});

test('reset clears phase and health suppression', () => {
  const { runtime } = makeRuntime();
  runtime.beginDesired('suspended', { generation: 1, connectionAttemptId: 'a1' });
  runtime.reset('disconnect');
  assert.equal(runtime.phase, 'active');
  assert.equal(runtime.isHealthSuppressed(), false);
});
