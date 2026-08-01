const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TerminalInputBucket,
  TerminalOutputDispatcher,
} = require('../lib/terminal/flow-control');

test('TerminalInputBucket starts full, rejects atomically, and refills with elapsed time', () => {
  let nowMs = 0;
  const bucket = new TerminalInputBucket({
    bytesPerSecond: 10,
    burstBytes: 10,
    now: () => nowMs,
  });

  assert.deepEqual(bucket.consume(10), {
    accepted: true,
    retryAfterMs: 0,
    remainingBytes: 0,
  });
  assert.deepEqual(bucket.consume(1), {
    accepted: false,
    retryAfterMs: 100,
    remainingBytes: 0,
  });

  nowMs = 1000;
  assert.deepEqual(bucket.consume(10), {
    accepted: true,
    retryAfterMs: 0,
    remainingBytes: 0,
  });
});

test('TerminalInputBucket charges UTF-8 bytes and exposes numeric-only state', () => {
  const bucket = new TerminalInputBucket({
    bytesPerSecond: 10,
    burstBytes: 10,
    now: () => 0,
  });

  assert.equal(bucket.consume('\u4f60').remainingBytes, 7);
  assert.equal(bucket.consume(2).remainingBytes, 5);
  assert.deepEqual(bucket.snapshot(), {
    bytesPerSecond: 10,
    burstBytes: 10,
    remainingBytes: 5,
  });
  assert.equal(JSON.stringify(bucket.snapshot()).includes('\u4f60'), false);
});

test('TerminalInputBucket rebases a backwards clock so future refill resumes immediately', () => {
  let nowMs = 1000;
  const bucket = new TerminalInputBucket({
    bytesPerSecond: 10,
    burstBytes: 10,
    now: () => nowMs,
  });
  bucket.consume(10);

  nowMs = 500;
  assert.equal(bucket.consume(1).accepted, false);
  nowMs = 600;
  assert.equal(bucket.consume(1).accepted, true);
});

test('flow-control constructors reject non-positive bounds', () => {
  assert.throws(
    () => new TerminalInputBucket({ bytesPerSecond: 0, burstBytes: 1 }),
    /bytesPerSecond/,
  );
  assert.throws(
    () => new TerminalInputBucket({ bytesPerSecond: 1, burstBytes: -1 }),
    /burstBytes/,
  );
  assert.throws(
    () => new TerminalOutputDispatcher({ maxQueueBytes: 0 }),
    /maxQueueBytes/,
  );
});

test('TerminalOutputDispatcher preserves complete UTF-8 chunks and observer order in one drain', () => {
  const scheduled = [];
  const delivered = [];
  const dispatcher = new TerminalOutputDispatcher({
    maxQueueBytes: 32,
    schedule: (drain) => scheduled.push(drain),
  });
  dispatcher.attach('observer-a', {
    onData: (data, metadata) => delivered.push({ data, metadata }),
  });

  assert.equal(dispatcher.enqueue('observer-a', '\u4f60', { replaySeq: 1 }), true);
  assert.equal(dispatcher.enqueue('observer-a', 'ok', { replaySeq: 2 }), true);
  assert.equal(scheduled.length, 1);
  assert.equal(dispatcher.queuedBytes('observer-a'), 5);

  while (scheduled.length > 0) scheduled.shift()();

  assert.deepEqual(delivered, [
    { data: '\u4f60', metadata: { replaySeq: 1 } },
    { data: 'ok', metadata: { replaySeq: 2 } },
  ]);
  assert.equal(dispatcher.queuedBytes('observer-a'), 0);
});

test('TerminalOutputDispatcher warns once and detaches only the overflowing observer', () => {
  const scheduled = [];
  const warnings = [];
  const detached = [];
  const delivered = [];
  const dispatcher = new TerminalOutputDispatcher({
    maxQueueBytes: 5,
    schedule: (drain) => scheduled.push(drain),
  });
  dispatcher.attach('slow', {
    onData: (data) => delivered.push(['slow', data]),
    onWarning: (warning) => warnings.push(warning),
    onDetach: (reason, stats) => detached.push({ reason, stats }),
  });
  dispatcher.attach('fast', {
    onData: (data) => delivered.push(['fast', data]),
  });

  assert.equal(dispatcher.enqueue('slow', '12345'), true);
  assert.equal(dispatcher.enqueue('fast', 'abc'), true);
  assert.equal(dispatcher.enqueue('slow', 'x'), false);
  assert.equal(dispatcher.enqueue('slow', 'secret-output'), false);

  assert.deepEqual(warnings, [{
    code: 'terminal_output_backpressure',
    stats: { queuedBytes: 5, droppedChunks: 1 },
  }]);
  assert.deepEqual(detached, [{
    reason: 'output-backpressure',
    stats: { queuedBytes: 5, droppedChunks: 1 },
  }]);
  assert.equal(JSON.stringify(warnings).includes('secret-output'), false);
  assert.equal(dispatcher.queuedBytes('slow'), 0);

  while (scheduled.length > 0) scheduled.shift()();
  assert.deepEqual(delivered, [['fast', 'abc']]);
});

test('TerminalOutputDispatcher retains in-flight bytes until ack and drains observers independently', () => {
  const scheduled = [];
  const slowAcks = [];
  const delivered = [];
  const warnings = [];
  const dispatcher = new TerminalOutputDispatcher({
    maxQueueBytes: 5,
    // Preserve classic stop-and-wait for this backpressure regression.
    maxInFlightChunks: 1,
    maxInFlightBytes: 1,
    schedule: (drain) => scheduled.push(drain),
  });
  dispatcher.attach('slow', {
    onData(data, metadata, acknowledge) {
      delivered.push(['slow', data]);
      slowAcks.push(acknowledge);
    },
    onWarning: (warning) => warnings.push(warning),
  });
  dispatcher.attach('fast', {
    onData(data, metadata, acknowledge) {
      delivered.push(['fast', data]);
      acknowledge();
    },
  });

  dispatcher.enqueue('slow', '12345');
  dispatcher.enqueue('fast', 'a');
  dispatcher.enqueue('fast', 'b');
  while (scheduled.length > 0) scheduled.shift()();

  assert.deepEqual(delivered, [['slow', '12345'], ['fast', 'a'], ['fast', 'b']]);
  assert.equal(dispatcher.queuedBytes('slow'), 5);
  assert.equal(dispatcher.queuedBytes('fast'), 0);
  assert.equal(dispatcher.enqueue('slow', 'x'), false);
  assert.deepEqual(warnings, [{
    code: 'terminal_output_backpressure',
    stats: { queuedBytes: 5, droppedChunks: 1 },
  }]);

  slowAcks[0]();
  slowAcks[0]();
  assert.equal(dispatcher.queuedBytes('slow'), 0);
});

test('TerminalOutputDispatcher pipelines multiple unacked chunks within the in-flight window', () => {
  const scheduled = [];
  const acks = [];
  const delivered = [];
  const dispatcher = new TerminalOutputDispatcher({
    maxQueueBytes: 64,
    maxInFlightChunks: 3,
    maxInFlightBytes: 64,
    schedule: (drain) => scheduled.push(drain),
  });
  dispatcher.attach('observer', {
    onData(data, metadata, acknowledge) {
      delivered.push(data);
      acks.push(acknowledge);
    },
  });

  assert.equal(dispatcher.enqueue('observer', 'a'), true);
  assert.equal(dispatcher.enqueue('observer', 'b'), true);
  assert.equal(dispatcher.enqueue('observer', 'c'), true);
  assert.equal(dispatcher.enqueue('observer', 'd'), true);
  while (scheduled.length > 0) scheduled.shift()();

  // Window of 3: first three delivered without waiting for ack; fourth stays queued.
  assert.deepEqual(delivered, ['a', 'b', 'c']);
  assert.equal(dispatcher.queuedBytes('observer'), 4);
  assert.equal(acks.length, 3);

  acks[0]();
  while (scheduled.length > 0) scheduled.shift()();
  assert.deepEqual(delivered, ['a', 'b', 'c', 'd']);

  acks[1]();
  acks[2]();
  acks[3]();
  assert.equal(dispatcher.queuedBytes('observer'), 0);
});
