'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ControlTransitionRetry } = require('./control-transition-retry');

function makeClock() {
  let now = 0;
  const timers = new Map();
  let nextId = 1;

  function setTimeoutFn(fn, delay) {
    const id = nextId++;
    timers.set(id, { fn, due: now + delay });
    return id;
  }

  function clearTimeoutFn(id) {
    timers.delete(id);
  }

  function advance(ms) {
    const target = now + ms;
    while (timers.size > 0) {
      let nextDue = Infinity;
      for (const t of timers.values()) nextDue = Math.min(nextDue, t.due);
      if (nextDue > target) break;
      now = nextDue;
      const due = [...timers.entries()]
        .filter(([, t]) => t.due <= now)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0]);
      for (const [id, t] of due) {
        if (!timers.has(id)) continue;
        timers.delete(id);
        t.fn();
      }
    }
    now = target;
  }

  return {
    now: () => now,
    setTimeoutFn,
    clearTimeoutFn,
    advance,
    liveTimers: () => timers.size,
  };
}

test('retries fire at 1s/2s/4s with same-epoch payload and single live timer', () => {
  const clock = makeClock();
  const retries = [];
  const blocked = [];
  const retry = new ControlTransitionRetry({
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  retry.start({
    leaseEpoch: 7,
    onRetry: (info) => retries.push(info),
    onBlocked: (info) => blocked.push(info),
  });

  assert.equal(clock.liveTimers(), 1);
  clock.advance(999);
  assert.equal(retries.length, 0);
  clock.advance(1);
  assert.equal(retries.length, 1);
  assert.deepEqual(retries[0], {
    leaseEpoch: 7, attempt: 1, generation: 1, delayMs: 1000,
  });
  assert.equal(clock.liveTimers(), 1);

  clock.advance(2000);
  assert.equal(retries.length, 2);
  assert.equal(retries[1].delayMs, 2000);
  assert.equal(retries[1].leaseEpoch, 7);

  clock.advance(4000);
  assert.equal(retries.length, 3);
  assert.equal(retries[2].delayMs, 4000);
  assert.equal(retries[2].attempt, 3);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].leaseEpoch, 7);
  assert.equal(blocked[0].attempt, 3);
  assert.equal(retry.active, false);
  assert.equal(clock.liveTimers(), 0);
});

test('cancel after applied ack stops further retries and onBlocked', () => {
  const clock = makeClock();
  const retries = [];
  const blocked = [];
  const retry = new ControlTransitionRetry({
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  retry.start({
    leaseEpoch: 3,
    onRetry: (info) => retries.push(info),
    onBlocked: (info) => blocked.push(info),
  });
  clock.advance(1000);
  assert.equal(retries.length, 1);
  retry.cancel();
  clock.advance(10_000);
  assert.equal(retries.length, 1);
  assert.equal(blocked.length, 0);
  assert.equal(clock.liveTimers(), 0);
});

test('stale generation callbacks are suppressed after restart', () => {
  const clock = makeClock();
  const retries = [];
  const blocked = [];
  const retry = new ControlTransitionRetry({
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  retry.start({
    leaseEpoch: 1,
    onRetry: (info) => retries.push({ gen: info.generation, epoch: info.leaseEpoch }),
    onBlocked: (info) => blocked.push(info),
  });
  clock.advance(500);
  retry.start({
    leaseEpoch: 2,
    onRetry: (info) => retries.push({ gen: info.generation, epoch: info.leaseEpoch }),
    onBlocked: (info) => blocked.push(info),
  });
  assert.equal(clock.liveTimers(), 1);
  clock.advance(1000);
  assert.deepEqual(retries, [{ gen: 2, epoch: 2 }]);
  clock.advance(6000);
  assert.equal(retries.every((r) => r.epoch === 2), true);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].leaseEpoch, 2);
});

test('exactly one onBlocked after the third retry', () => {
  const clock = makeClock();
  const blocked = [];
  const retry = new ControlTransitionRetry({
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  retry.start({
    leaseEpoch: 9,
    onRetry: () => {},
    onBlocked: (info) => blocked.push(info),
  });
  clock.advance(1000 + 2000 + 4000);
  assert.equal(blocked.length, 1);
  clock.advance(60_000);
  assert.equal(blocked.length, 1);
  assert.equal(clock.liveTimers(), 0);
});

test('host-style cancel leaves no timer storm across repeated failures', () => {
  const clock = makeClock();
  const retry = new ControlTransitionRetry({
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  for (let i = 0; i < 5; i += 1) {
    retry.start({
      leaseEpoch: 10 + i,
      onRetry: () => {},
      onBlocked: () => {},
    });
    assert.equal(clock.liveTimers(), 1);
  }
  retry.cancel();
  assert.equal(clock.liveTimers(), 0);
  clock.advance(60_000);
  assert.equal(clock.liveTimers(), 0);
});
