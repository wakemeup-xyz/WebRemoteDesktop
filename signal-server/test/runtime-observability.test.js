const assert = require('node:assert/strict');
const test = require('node:test');
const { createRuntimeObserver, normalizeDisconnectReason } = require('../lib/observability/runtime');

test('complete sampled loop window includes zero and current RSS differs from peak', () => {
  let time = 0;
  let callback;
  let cleared = 0;
  const observer = createRuntimeObserver({ now: () => time, sampleRss: () => 100,
    setTimer: (cb) => { callback = cb; return { unref() {} }; }, clearTimer: () => cleared++ });
  observer.start();
  for (const [scheduled, lag] of [[1000, 0], [2000, 5], [3000, 30], [4000, 100]]) {
    time = scheduled + lag; callback();
  }
  const result = observer.snapshot();
  assert.equal(result.eventLoop.count, 4);
  assert.equal(result.eventLoop.last, 100);
  assert.equal(result.currentRssMiB, 100);
  assert.equal(result.peakRssMiB, null);
  assert.equal(result.eventLoop.p50, 5);
  observer.stop();
  assert.equal(cleared, 1);
  time += 61000;
  assert.equal(observer.snapshot().eventLoop.count, 0);
});

test('missed deadlines have no synthetic zeros; snapshot does not sample and cache expires', () => {
  let time = 0;
  let callback;
  let reads = 0;
  const observer = createRuntimeObserver({ now: () => time, sampleRss: () => { reads++; return 15; },
    setTimer: (cb) => { callback = cb; return 1; }, clearTimer() {} });
  observer.start();
  time = 4500; callback();
  const result = observer.snapshot();
  assert.equal(result.eventLoop.count, 1);
  assert.equal(result.eventLoop.missedSampleCount, 3);
  assert.equal(reads, 1);
  observer.snapshot(); observer.snapshot();
  assert.equal(reads, 1);
  time = 16000;
  assert.equal(observer.snapshot().available, false);
  assert.equal(observer.snapshot().currentRssMiB, null);
  observer.stop();
});

test('runtime observer derives bounded process CPU percentage only between fresh samples', () => {
  let time = 0;
  let callback;
  let cpu = 1;
  const observer = createRuntimeObserver({ now: () => time, sampleRss: () => 15,
    sampleCpuSeconds: () => cpu,
    setTimer: cb => { callback = cb; return { unref() {} }; }, clearTimer() {} });
  observer.start();
  time = 1000; callback();
  assert.equal(observer.snapshot().processCpuPercent, null);
  cpu = 1.25; time = 6000; callback();
  assert.equal(observer.snapshot().processCpuSeconds, 1.25);
  assert.equal(observer.snapshot().processCpuPercent, 5);
  observer.stop();
});

test('disconnect reasons accept only known protocol enums and never stringify objects', () => {
  for (const reason of ['ping timeout', 'transport close', 'transport error', 'server namespace disconnect',
    'client namespace disconnect', 'server shutting down', 'parse error', 'forced close', 'forced server close']) {
    assert.equal(normalizeDisconnectReason(reason), reason);
  }
  assert.equal(normalizeDisconnectReason({ toString() { throw Error('canary'); } }), 'other');
  assert.equal(normalizeDisconnectReason('token=secret'), 'other');
});

test('server listening owns start and close/error own cancellation with no real server', () => {
  const { EventEmitter } = require('node:events');
  const { bindRuntimeObserver } = require('../lib/observability/runtime');
  const server = new EventEmitter();
  let time = 0;
  let callback;
  let reads = 0;
  let timerCount = 0;
  let cleared = 0;
  const observer = createRuntimeObserver({ now: () => time, sampleRss: () => { reads++; return 15; },
    setTimer: (cb) => { callback = cb; return ++timerCount; }, clearTimer: () => cleared++ });
  bindRuntimeObserver(server, observer);
  assert.equal(timerCount, 0);
  server.emit('listening'); server.emit('listening');
  assert.equal(timerCount, 1);
  time = 1000; callback();
  assert.equal(reads, 1);
  server.emit('close');
  assert.equal(cleared, 1);
  callback();
  assert.equal(reads, 1);
  server.emit('listening');
  server.emit('error', new Error('offline fixture'));
  assert.equal(cleared, 2);
});
