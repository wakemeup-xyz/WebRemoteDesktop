const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadCollector(now = () => 0) {
  const context = {
    performance: { now }, console,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      readyState: 'loading',
      addEventListener() {}, querySelector: () => null,
      getElementById: () => ({ classList: { add() {}, remove() {} }, style: {} }),
    },
    window: { location: { origin: 'http://127.0.0.1:8080' } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    io: () => ({ on() {}, emit() {}, disconnect() {}, connected: true }),
  };
  context.globalThis = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, 'webrtc.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__Collector = FrameTraceCollector;`, context);
  return context.__Collector;
}

test('late diagnostic joins the matching rVFC wire timestamp within two seconds', () => {
  let now = 100;
  const Collector = loadCollector(() => now);
  const collector = new Collector({ now: () => now });
  collector.observeVideoFrame({ attemptId: 'a', generation: 2, streamId: 'video', rtpTimestamp: 44 }, { roi: 'frame' });
  collector.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [{
    attemptId: 'a', generation: 2, streamId: 'video', wireTimestamp: 44, captureSeq: 7, idrKind: 'idr',
  }] });
  const matched = collector.takeMatched();
  assert.equal(matched.length, 1);
  assert.equal(matched[0].captureSeq, 7);
  assert.equal(matched[0].idrKind, 'idr');
  assert.equal(matched[0].roi.roi, 'frame');
});

test('wrong generation and expired or missing diagnostics stay UNALIGNED', () => {
  let now = 0;
  const Collector = loadCollector(() => now);
  const collector = new Collector({ now: () => now });
  collector.observeVideoFrame({ attemptId: 'a', generation: 2, streamId: 'video', rtpTimestamp: 44 }, { roi: 'wrong' });
  collector.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [{
    attemptId: 'a', generation: 1, streamId: 'video', wireTimestamp: 44, captureSeq: 7,
  }] });
  now = 2001;
  collector.expire();
  assert.equal(collector.acceptanceState(), 'UNALIGNED');
  assert.equal(collector.takeMatched().length, 0);
});

test('matched rows are bounded for diagnostics and expire at the 120 second index TTL', () => {
  let now = 0;
  const Collector = loadCollector(() => now);
  const collector = new Collector({ now: () => now, capacity: 2, lateWaitMs: 2000 });
  for (const timestamp of [1, 2]) {
    collector.observeVideoFrame({ attemptId: 'a', generation: 1, streamId: 'video', rtpTimestamp: timestamp }, { timestamp });
    collector.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [{
      attemptId: 'a', generation: 1, streamId: 'video', wireTimestamp: timestamp, captureSeq: timestamp,
    }] });
  }
  assert.equal(collector.diagnostics().matchedCount, 2);
  collector.observeVideoFrame({ attemptId: 'a', generation: 1, streamId: 'video', rtpTimestamp: 3 }, { timestamp: 3 });
  collector.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [{
    attemptId: 'a', generation: 1, streamId: 'video', wireTimestamp: 3, captureSeq: 3,
  }] });
  assert.equal(collector.diagnostics().matchedCount, 0);
  assert.equal(collector.acceptanceState(), 'UNALIGNED');
  now = 2001;
  collector.expire();
  assert.equal(collector.diagnostics().matchedCount, 0);
  now = 120001;
  collector.expire();
  assert.equal(collector.takeMatched().length, 0);
});

test('a missing counterpart becomes UNALIGNED after two seconds but the index expires at 120 seconds', () => {
  let now = 0;
  const Collector = loadCollector(() => now);
  const collector = new Collector({ now: () => now, capacity: 2, lateWaitMs: 2000 });
  collector.observeVideoFrame({ attemptId: 'a', generation: 1, streamId: 'video', rtpTimestamp: 1 }, { roi: 'missing' });
  now = 2001;
  assert.equal(collector.diagnostics().acceptanceState, 'UNALIGNED');
  assert.equal(collector.diagnostics().pendingFrames, 1);
  now = 120001;
  assert.equal(collector.diagnostics().pendingFrames, 0);
});

test('incomplete, duplicate, conflicting, and stale trace batches never enter the current index', () => {
  const Collector = loadCollector();
  const collector = new Collector();
  collector.setScope({ attemptId: 'live', generation: 3, streamId: 'video' });
  const trace = {
    attemptId: 'live', generation: 3, streamId: 'video', wireTimestamp: 77, captureSeq: 4,
  };

  assert.equal(collector.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [{ ...trace, captureSeq: undefined }] }), 0);
  assert.equal(collector.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [trace, { ...trace }] }), 0);
  assert.equal(collector.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [trace, { ...trace, captureSeq: 5 }] }), 0);
  assert.equal(collector.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [{ ...trace, attemptId: 'old' }] }), 0);
  assert.equal(collector.observeVideoFrame({ attemptId: 'live', generation: 3, streamId: 'video', rtpTimestamp: 77 }, { roi: 'current' }), false);
  assert.equal(collector.takeMatched().length, 0);
  assert.equal(collector.diagnostics().pendingTraces, 0);
  assert.equal(collector.diagnostics().acceptanceState, 'UNALIGNED');

  const duplicate = new Collector();
  duplicate.setScope({ attemptId: 'live', generation: 3, streamId: 'video' });
  assert.equal(duplicate.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [trace] }), 0);
  assert.equal(duplicate.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [{ ...trace }] }), 0);
  assert.equal(duplicate.observeVideoFrame({ attemptId: 'live', generation: 3, streamId: 'video', rtpTimestamp: 77 }, { roi: 'duplicate' }), false);
  assert.equal(duplicate.takeMatched().length, 0);
  assert.equal(duplicate.diagnostics().acceptanceState, 'UNALIGNED');

  const malformed = new Collector();
  malformed.setScope({ attemptId: 'live', generation: 3, streamId: 'video' });
  assert.equal(malformed.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, droppedTraceCount: '1', traces: [{ ...trace, generation: '3' }] }), 0);
  assert.equal(malformed.diagnostics().invalidBatchCount, 1);
  assert.equal(malformed.observeVideoFrame({ attemptId: 'live', generation: 3, streamId: 'video', rtpTimestamp: 77 }, { roi: 'malformed' }), false);
});
