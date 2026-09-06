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
