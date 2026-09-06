const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const TRACE_STAGE_NAMES = [
  'grab', 'age_at_recv', 'worker_queue', 'prepare', 'build',
  'reformat', 'encode', 'packetize', 'encode_total',
];

function validTrace(overrides = {}) {
  return {
    attemptId: 'a', generation: 1, streamId: 'video', captureSeq: 7,
    encoderTimestamp: 9000, wireTimestamp: 44, ssrc: 7, framePts: 100,
    idrKind: null, idrReason: null, policyDigest: 'relay-legacy-v1',
    stages: Object.fromEntries(TRACE_STAGE_NAMES.map((stage) => [stage, null])),
    ...overrides,
  };
}

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
  collector.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [validTrace({
    attemptId: 'a', generation: 2, wireTimestamp: 44, idrKind: 'idr', idrReason: 'periodic',
  })] });
  const matched = collector.takeMatched();
  assert.equal(matched.length, 1);
  assert.equal(matched[0].captureSeq, 7);
  assert.equal(matched[0].idrKind, 'idr');
  assert.equal(matched[0].roi.roi, 'frame');
  assert.deepEqual(
    Object.keys(matched[0]).sort(),
    ['attemptId', 'captureSeq', 'generation', 'idrKind', 'roi', 'rtpOrigin', 'rtpTimestamp', 'streamId', 'traceStatus', 'viewerClockMs', 'wireTimestamp'].sort(),
  );
  assert.equal(matched[0].rtpTimestamp, 44);
  assert.equal(matched[0].wireTimestamp, 44);
  assert.equal(matched[0].rtpOrigin, 0xFFFFDD04);
  assert.equal(matched[0].traceStatus, 'matched');
  assert.equal(matched[0].viewerClockMs, 100);
});

test('wrong generation and expired or missing diagnostics stay UNALIGNED', () => {
  let now = 0;
  const Collector = loadCollector(() => now);
  const collector = new Collector({ now: () => now });
  collector.observeVideoFrame({ attemptId: 'a', generation: 2, streamId: 'video', rtpTimestamp: 44 }, { roi: 'wrong' });
  collector.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [validTrace({ wireTimestamp: 44 })] });
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
    collector.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [validTrace({ wireTimestamp: timestamp, captureSeq: timestamp })] });
  }
  assert.equal(collector.diagnostics().matchedCount, 2);
  collector.observeVideoFrame({ attemptId: 'a', generation: 1, streamId: 'video', rtpTimestamp: 3 }, { timestamp: 3 });
  collector.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [validTrace({ wireTimestamp: 3, captureSeq: 3 })] });
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
  const trace = validTrace({ attemptId: 'live', generation: 3, wireTimestamp: 77, captureSeq: 4 });

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

test('schema v1 rejects every missing, extra, or incoherent Host row field', () => {
  const Collector = loadCollector();
  const missingRoot = validTrace();
  delete missingRoot.encoderTimestamp;
  const missingStage = validTrace();
  delete missingStage.stages.grab;
  const invalidRows = [
    missingRoot,
    { ...validTrace(), attemptId: '' },
    { ...validTrace(), generation: -1 },
    { ...validTrace(), streamId: '' },
    { ...validTrace(), captureSeq: -1 },
    { ...validTrace(), encoderTimestamp: 0x1_0000_0000 },
    { ...validTrace(), wireTimestamp: -1 },
    { ...validTrace(), ssrc: 1.5 },
    { ...validTrace(), framePts: 1.5 },
    { ...validTrace(), idrKind: 'idr', idrReason: null },
    { ...validTrace(), policyDigest: '' },
    { ...validTrace(), policyDigest: '   ' },
    missingStage,
    { ...validTrace(), stages: { ...validTrace().stages, grab: -1 } },
    { ...validTrace(), stages: { ...validTrace().stages, encode: Infinity } },
    { ...validTrace(), stages: { ...validTrace().stages, extra: null } },
  ];
  for (const row of invalidRows) {
    const collector = new Collector();
    collector.setScope({ attemptId: 'a', generation: 1, streamId: 'video' });
    assert.equal(collector.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [row] }), 0);
    assert.equal(collector.diagnostics().acceptanceState, 'UNALIGNED');
  }
});
