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
  vm.runInContext(`${source}\nglobalThis.__WebRTC = WebRTC; globalThis.__Collector = FrameTraceCollector; globalThis.__DecodeControlledMarker = decodeControlledMarkerRgba;`, context);
  context.__Collector.decodeControlledMarker = context.__DecodeControlledMarker;
  context.__Collector.runtime = context;
  return context.__Collector;
}

function controlledMarkerPixels() {
  const producerSource = fs.readFileSync(path.join(__dirname, '../../scripts/turn-runtime-controlled-producer.html'), 'utf8');
  const script = producerSource.match(/<script>([\s\S]*)<\/script>/)?.[1];
  const context = { window: {}, BigInt, Uint8Array, ArrayBuffer, DataView, TextEncoder };
  vm.createContext(context); vm.runInContext(script, context);
  const grid = context.window.WRDTurnControlledProducer.markerGrid({ runNonce: 0x0102030405060708n, sceneId: 7, tick: 3, actionId: 9 });
  const pixels = new Uint8ClampedArray(256 * 128 * 4);
  for (let gy = 0; gy < 16; gy += 1) for (let gx = 0; gx < 32; gx += 1) {
    const value = grid[gy][gx] ? 224 : 32;
    for (let y = gy * 8; y < gy * 8 + 8; y += 1) for (let x = gx * 8; x < gx * 8 + 8; x += 1) {
      const offset = (y * 256 + x) * 4; pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = value; pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

test('actual 256x128 canvas pixels decode the dual-CRC marker before T3 visual evidence is emitted', () => {
  const Collector = loadCollector();
  const marker = Collector.decodeControlledMarker(controlledMarkerPixels(), 256, 128);
  assert.deepEqual(JSON.parse(JSON.stringify(marker)), { runNonce: '72623859790382856', sceneId: 7, tick: 3, actionId: 9 });
  const collector = new Collector();
  collector.observeVideoFrame({ attemptId: 'a', generation: 1, streamId: 'video', ssrc: 7, rtpTimestamp: 44 }, { marker }, Collector.runtime.performance.now());
  collector.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [validTrace({ attemptId: 'a', generation: 1, wireTimestamp: 44 })] });
  const visual = collector.takeControlledVisualEvidence();
  assert.equal(visual.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(visual[0].marker)), JSON.parse(JSON.stringify(marker)));
  assert.equal(visual[0].traceStatus, 'matched');
});

test('late diagnostic joins the matching rVFC wire timestamp within two seconds', () => {
  let now = 100;
  const Collector = loadCollector(() => now);
  const collector = new Collector({ now: () => now });
  collector.observeVideoFrame({ attemptId: 'a', generation: 2, streamId: 'video', ssrc: 7, rtpTimestamp: 44 }, { roi: 'frame' }, Collector.runtime.performance.now());
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
  collector.observeVideoFrame({ attemptId: 'a', generation: 2, streamId: 'video', ssrc: 7, rtpTimestamp: 44 }, { roi: 'wrong' }, Collector.runtime.performance.now());
  collector.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [validTrace({ wireTimestamp: 44 })] });
  now = 2001;
  collector.expire();
  assert.equal(collector.acceptanceState(), 'UNALIGNED');
  assert.equal(collector.takeMatched().length, 0);
});

test('matched rows evict without closing the live stream and expire after two seconds', () => {
  let now = 0;
  const Collector = loadCollector(() => now);
  const collector = new Collector({ now: () => now, capacity: 2, lateWaitMs: 2000 });
  for (const timestamp of [1, 2]) {
    collector.observeVideoFrame({ attemptId: 'a', generation: 1, streamId: 'video', ssrc: 7, rtpTimestamp: timestamp }, { timestamp }, Collector.runtime.performance.now());
    collector.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [validTrace({ wireTimestamp: timestamp, captureSeq: timestamp })] });
  }
  assert.equal(collector.diagnostics().matchedCount, 2);
  collector.observeVideoFrame({ attemptId: 'a', generation: 1, streamId: 'video', ssrc: 7, rtpTimestamp: 3 }, { timestamp: 3 }, Collector.runtime.performance.now());
  collector.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [validTrace({ wireTimestamp: 3, captureSeq: 3 })] });
  assert.equal(collector.diagnostics().matchedCount, 2);
  assert.equal(collector.terminalUnaligned, false);
  now = 2001;
  collector.expire();
  assert.equal(collector.diagnostics().matchedCount, 0);
  now = 120001;
  collector.expire();
  assert.equal(collector.takeMatched().length, 0);
});

test('a missing counterpart is removed after two seconds', () => {
  let now = 0;
  const Collector = loadCollector(() => now);
  const collector = new Collector({ now: () => now, capacity: 2, lateWaitMs: 2000 });
  collector.observeVideoFrame({ attemptId: 'a', generation: 1, streamId: 'video', ssrc: 7, rtpTimestamp: 1 }, { roi: 'missing' }, Collector.runtime.performance.now());
  now = 2001;
  assert.equal(collector.diagnostics().acceptanceState, 'UNALIGNED');
  assert.equal(collector.diagnostics().pendingFrames, 0);
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
  assert.equal(collector.observeVideoFrame({ attemptId: 'live', generation: 3, streamId: 'video', ssrc: 7, rtpTimestamp: 77 }, { roi: 'current' }, Collector.runtime.performance.now()), false);
  assert.equal(collector.takeMatched().length, 0);
  assert.equal(collector.diagnostics().pendingTraces, 0);
  assert.equal(collector.diagnostics().acceptanceState, 'UNALIGNED');

  const duplicate = new Collector();
  duplicate.setScope({ attemptId: 'live', generation: 3, streamId: 'video' });
  assert.equal(duplicate.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [trace] }), 0);
  assert.equal(duplicate.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [{ ...trace }] }), 0);
  assert.equal(duplicate.observeVideoFrame({ attemptId: 'live', generation: 3, streamId: 'video', ssrc: 7, rtpTimestamp: 77 }, { roi: 'duplicate' }, Collector.runtime.performance.now()), false);
  assert.equal(duplicate.takeMatched().length, 0);
  assert.equal(duplicate.diagnostics().acceptanceState, 'UNALIGNED');

  const malformed = new Collector();
  malformed.setScope({ attemptId: 'live', generation: 3, streamId: 'video' });
  assert.equal(malformed.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, droppedTraceCount: '1', traces: [{ ...trace, generation: '3' }] }), 0);
  assert.equal(malformed.diagnostics().invalidBatchCount, 1);
  assert.equal(malformed.observeVideoFrame({ attemptId: 'live', generation: 3, streamId: 'video', ssrc: 7, rtpTimestamp: 77 }, { roi: 'malformed' }, Collector.runtime.performance.now()), false);
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

 test('late trace keeps original presentation time', () => {
  let now = 100;
  const Collector = loadCollector(() => now), c = new Collector({ now: () => now });
  c.setScope({ attemptId: 'a', generation: 1, streamId: 'video' });
  c.observeVideoFrame({ attemptId: 'a', generation: 1, streamId: 'video', ssrc: 7, rtpTimestamp: 44 }, {}, Collector.runtime.performance.now());
  now = 800;
  c.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [validTrace()] });
  assert.equal(c.takeMatched()[0].viewerClockMs, 100);
});

 test('fifteen minute trace remains bounded and matches every current frame', () => {
  let now = 0;
  const Collector = loadCollector(() => now), c = new Collector({ now: () => now });
  c.setScope({ attemptId: 'a', generation: 1, streamId: 'video' });
  let matched = 0;
  for (let i = 0; i < 18000; i += 1) {
    now = i * 50;
    const wireTimestamp = (0xfffff000 + i * 4500) >>> 0;
    c.observeVideoFrame({ attemptId: 'a', generation: 1, streamId: 'video', ssrc: 7, rtpTimestamp: wireTimestamp }, {}, Collector.runtime.performance.now());
    c.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1,
      traces: [validTrace({ captureSeq: i, wireTimestamp, encoderTimestamp: (wireTimestamp - 12345) >>> 0 })] });
    matched += c.takeMatched().length;
    assert.ok(c.seen.size <= 2048);
    assert.ok(c.frames.size <= 256 && c.traces.size <= 256);
  }
  assert.equal(matched, 18000);
});

 test('stale scope and absent SSRC cannot poison current joins or create marker evidence', () => {
  const Collector = loadCollector(), c = new Collector();
  c.setScope({ attemptId: 'a', generation: 1, streamId: 'video' });
  c.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [validTrace({ attemptId: 'old' })] });
  assert.equal(c.terminalUnaligned, false);
  assert.equal(c.observeVideoFrame({ attemptId: 'a', generation: 1, streamId: 'video', rtpTimestamp: 44 }, {}, Collector.runtime.performance.now()), false);
  assert.equal(c.frames.size, 0);
  c.observeVideoFrame({ attemptId: 'a', generation: 1, streamId: 'video', ssrc: 7, rtpTimestamp: 44 }, {}, Collector.runtime.performance.now());
  c.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [validTrace()] });
  assert.equal(c.takeControlledVisualEvidence().length, 0);
});

 test('binding is separate strict v1 with scope, SSRC and preserved presentation time', () => {
  let now = 100;
  const Collector = loadCollector(() => now), c = new Collector({ now: () => now });
  const scope = { connectionAttemptId: 'a', generation: 1, leaseEpoch: 7 };
  const binding = { type: 'input_frame_binding', schemaVersion: 1, scope, streamId: 'video', captureSeq: 1,
    encoderTimestamp: 10, wireTimestamp: 44, ssrc: 7, captureFresh: true, captureAfterApplied: true, inputIds: ['one'] };
  c.observeVideoFrame({ attemptId: 'a', generation: 1, streamId: 'video', ssrc: 7, rtpTimestamp: 44 }, {}, Collector.runtime.performance.now());
  now = 800;
  assert.equal(c.acceptBinding({ ...binding, schemaVersion: 2 }, scope), 0);
  assert.equal(c.acceptBinding({ ...binding, scope: { ...scope, leaseEpoch: 8 } }, scope), 0);
  assert.equal(c.acceptBinding(binding, scope), 1);
  assert.equal(c.takeMatched()[0].viewerClockMs, 100);
  const expired = new Collector({ now: () => now });
  expired.observeVideoFrame({ attemptId: 'a', generation: 1, streamId: 'video', ssrc: 7, rtpTimestamp: 44 }, {}, Collector.runtime.performance.now());
  now += 2001;
  assert.equal(expired.acceptBinding(binding, scope), 0);
  assert.equal(expired.takeMatched().length, 0);
});

 test('receiver SSRC mapping is unique current-PC video mapping and disabled capability retains no join', () => {
  const Collector = loadCollector(), w = Collector.runtime.__WebRTC;
  let pending = true;
  Collector.runtime.LatencyMonitor = { hasPendingFrameInputs: () => pending };
  w.currentConnectionAttemptId = 'a'; w.connectionAttemptSequence = 1;
  const receiver = { track: { kind: 'video', id: 'v' }, getSynchronizationSources: () => [{ source: 7 }] };
  const pc = { getReceivers: () => [receiver] }; w.pc = pc;
  const video = { srcObject: { getVideoTracks: () => [{ id: 'v' }] } };
  assert.equal(w.verifiedVideoFrameIdentity(pc, video, { rtpTimestamp: 44 }).ssrc, 7);
  assert.equal(w.verifiedVideoFrameIdentity({}, video, { rtpTimestamp: 44 }), null);
  receiver.getSynchronizationSources = () => [{ source: 7 }, { source: 8 }];
  assert.equal(w.verifiedVideoFrameIdentity(pc, video, { rtpTimestamp: 44 }), null);
  w.serverConfig = {}; assert.equal(w.ensureInputFrameCollector(), null);
  w.serverConfig.inputFrameCorrelationVersion = 1;
  assert.ok(w.ensureInputFrameCollector());
  pending = false; assert.equal(w.ensureInputFrameCollector(), null);
  assert.equal(w.inputFrameCollector, null);
});

for (const traceFirst of [true, false]) {
  test(`production callback preserves original clock through receiver and marker work (${traceFirst ? 'trace-first' : 'frame-first'})`, () => {
    let clock = 100, callback;
    const Collector = loadCollector(() => clock), runtime = Collector.runtime, w = runtime.__WebRTC;
    const scope = { connectionAttemptId: 'a', generation: 1, leaseEpoch: 0 };
    const marker = { runNonce: '72623859790382856', sceneId: 7, tick: 3, actionId: 9 };
    const binding = { type: 'input_frame_binding', schemaVersion: 1, scope, streamId: 'video', captureSeq: 7,
      encoderTimestamp: 9000, wireTimestamp: 44, ssrc: 7, captureFresh: true, captureAfterApplied: true, inputIds: ['one'] };
    const postApply = [];
    runtime.LatencyMonitor = { hasPendingFrameInputs: () => true, onVideoFrame() {},
      onPostApplyFrame: row => postApply.push(row) };
    const video = { videoWidth: 256, srcObject: { getVideoTracks: () => [{ id: 'v' }] },
      requestVideoFrameCallback(fn) { callback = fn; return 1; } };
    runtime.document.getElementById = () => video;
    w.currentConnectionAttemptId = 'a'; w.connectionAttemptSequence = 1;
    w.serverConfig = { inputFrameCorrelationVersion: 1 }; w._frameTraceEnabled = true;
    w.pc = { getReceivers() { clock += 10; return [{ track: { kind: 'video', id: 'v' },
      getSynchronizationSources: () => [{ source: 7 }] }]; } };
    w.decodeControlledMarkerFromVideo = () => { clock += 20; return marker; };
    w.stopVideoFrameTracking = () => {};
    w.markMediaAttemptReady = () => true;
    w.ensureDesktopSessionState = () => ({ applyMedia() {} });
    w.recordLossLabRvfc = w.observePaintFrame = w.observeFreshResumeFrame = () => {};
    const detailed = w.ensureFrameTraceCollector(), sparse = w.ensureInputFrameCollector();
    const accept = () => {
      detailed.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [validTrace()] });
      sparse.acceptBinding(binding, scope);
    };
    if (traceFirst) accept();
    w.startVideoFrameTracking();
    callback(100, { rtpTimestamp: 44 });
    assert.equal(clock, 130);
    if (!traceFirst) { clock = 800; accept(); w.consumeInputFrameMatches(); }
    const visual = detailed.takeControlledVisualEvidence();
    assert.equal(visual.length, 1);
    assert.equal(visual[0].viewerClockMs, 100);
    assert.equal(postApply.length, 1);
    assert.equal(postApply[0].viewerClockMs, 100);
  });
}

 test('callback clock must be explicit finite and nonnegative for either arrival order', () => {
  const Collector = loadCollector(() => 100);
  const identity = { attemptId: 'a', generation: 1, streamId: 'video', ssrc: 7, rtpTimestamp: 44 };
  for (const at of [undefined, null, '', '100', NaN, Infinity, -1]) {
    for (const traceFirst of [true, false]) {
      const c = new Collector();
      if (traceFirst) c.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [validTrace()] });
      assert.equal(c.observeVideoFrame(identity, {}, at), false);
      assert.equal(c.frames.size, 0);
      assert.equal(c.takeMatched().length, 0);
    }
  }
});

function freshnessFixture() {
  let now = 0;
  const Collector = loadCollector(() => now), runtime = Collector.runtime, w = runtime.__WebRTC;
  const { createLatencyMonitor } = require('./latency-monitor');
  const monitor = runtime.LatencyMonitor = createLatencyMonitor({ now: () => now });
  w.currentConnectionAttemptId = 'a'; w.connectionAttemptSequence = 1;
  w.serverConfig = { inputFrameCorrelationVersion: 1 };
  const scope = w.latencyScope(); monitor.setScope(scope);
  const set = value => { now = value; };
  const send = id => monitor.recordInputSend(id, { scope: w.latencyScope() });
  const paint = (wire, at, collector = w.ensureInputFrameCollector()) => {
    collector.observeVideoFrame({ ...w.currentFrameTraceIdentity(), ssrc: 7, rtpTimestamp: wire }, {}, at);
    return collector;
  };
  const bind = (collector, wire, capture, id, overrides = {}) => {
    collector.acceptBinding({ type: 'input_frame_binding', schemaVersion: 1, scope: w.latencyScope(),
      streamId: 'video', captureSeq: capture, encoderTimestamp: wire, wireTimestamp: wire,
      ssrc: 7, captureFresh: true, captureAfterApplied: true, inputIds: [id], ...overrides }, w.latencyScope());
    w.consumeInputFrameMatches();
  };
  return { w, monitor, scope, set, send, paint, bind, gauge: () => monitor.snapshot().metrics.freshFrameAgeMs };
}

for (const traceFirst of [true, false]) {
  test(`native latency: actual send and callback retain video-before-ACK clock (${traceFirst ? 'trace-first' : 'frame-first'})`, () => {
    let now = 100, callback;
    const Collector = loadCollector(() => now), runtime = Collector.runtime, w = runtime.__WebRTC;
    for (const name of ['input-geometry.js', 'keyboard-transport.js', 'remote-keyboard-controller.js', 'input.js']) {
      const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
      vm.runInContext(name === 'input.js' ? `${source}\nglobalThis.__Input = Input;` : source, runtime);
    }
    const input = runtime.__Input;
    const monitor = runtime.LatencyMonitor = require('./latency-monitor.js').createLatencyMonitor({ now: () => now });
    w.currentConnectionAttemptId = 'a'; w.connectionAttemptSequence = 1;
    input.activeControlLease = { leaseId: 'lease', leaseEpoch: 4 }; input.isActive = true;
    w.inputChannel = { readyState: 'open', bufferedAmount: 0, send() { now = 110; } };
    w.socket = { connected: false };
    const video = { videoWidth: 256, srcObject: { getVideoTracks: () => [{ id: 'v' }] },
      requestVideoFrameCallback(fn) { callback = fn; return 1; } };
    runtime.document.getElementById = () => video;
    w.pc = { getReceivers() { now += 10; return [{ track: { kind: 'video', id: 'v' },
      getSynchronizationSources: () => [{ source: 7 }] }]; } };
    w.serverConfig = { inputFrameCorrelationVersion: 1 };
    // Media UI is outside this fake-platform callback's concern; the callback/join stay real.
    w.stopVideoFrameTracking = () => {};
    w.markMediaAttemptReady = () => true;
    w.ensureDesktopSessionState = () => ({ applyMedia() {} });
    w.recordLossLabRvfc = w.observePaintFrame = w.observeFreshResumeFrame = () => {};
    const reservation = input.prepareLabInput('mouse', 'down', { relX: .5, relY: .5 });
    const scope = w.latencyScope(); monitor.setScope(scope);
    monitor.beginControlledInputEvidence({ inputId: reservation.inputId, leaseId: 'lease', scope,
      streamId: 'video', inputType: 'mouse', action: 'down' });
    assert.equal(input.dispatchPreparedLabInput(reservation), reservation.inputId);
    const seq = input._desktopWritePending.get(reservation.inputId).seq;
    const sparse = w.ensureInputFrameCollector();
    const bind = () => sparse.acceptBinding({ type: 'input_frame_binding', schemaVersion: 1, scope,
      streamId: 'video', captureSeq: 7, encoderTimestamp: 9000, wireTimestamp: 44, ssrc: 7,
      captureFresh: true, captureAfterApplied: true, inputIds: [reservation.inputId] }, scope);
    if (traceFirst) bind();
    w.startVideoFrameTracking(); now = 150; callback(150, { rtpTimestamp: 44 });
    if (!traceFirst) { now = 180; bind(); w.consumeInputFrameMatches(); }
    const current = () => ({ scope: w.latencyScope(), leaseId: 'lease', streamId: 'video', pc: w.pc,
      live: w.captureControlledTransportSnapshot() });
    assert.equal(monitor.readControlledInputEvidence(reservation.inputId, current()).postApply.viewerClockMs, 150);
    now = 210;
    w.acceptObservedInputAck({ schemaVersion: 2, inputType: 'mouse', status: 'applied', leaseEpoch: 4,
      inputIds: [reservation.inputId], appliedSeq: seq }, { transport: 'datachannel', dataChannel: w.inputChannel });
    const row = monitor.readControlledInputEvidence(reservation.inputId, current(), { finalize: true });
    assert.equal(row.state, 'COMPLETE'); assert.equal(row.send.viewerClockMs, 110);
    assert.equal(row.postApply.viewerClockMs, 150); assert.equal(row.ack.viewerClockMs, 210);
    assert.equal(monitor.snapshot().metrics.inputToPostApplyFrameMs.last, 40);
    input._clearDesktopWriteTimer();
  });
}

test('verified sparse join publishes original rVFC age and does not grant control or ACK', () => {
  const f = freshnessFixture(); f.set(10); f.send('one');
  f.set(100); const collector = f.paint(44, 100);
  f.set(800); f.bind(collector, 44, 7, 'one');
  assert.equal(f.gauge().last, 700);
  assert.equal(f.gauge().count, 1);
  const snapshot = f.monitor.snapshot();
  assert.equal(snapshot.metrics.inputToPostApplyFrameMs.last, 90);
  assert.equal(snapshot.metrics.inputToVisibleEffectMs.available, false);
  assert.equal(snapshot.metrics.inputAckRttMs.available, false);
  assert.equal(snapshot.outcomes.acked, 0);
});

test('older or repeated captures cannot refresh freshness even with a new RTP identity', () => {
  const f = freshnessFixture(); f.set(10); f.send('one');
  f.set(100); let c = f.paint(44, 100); f.bind(c, 44, 7, 'one');
  for (const [wire, capture] of [[45, 6], [46, 7]]) {
    f.set(200 + wire); f.send(`input-${wire}`); c = f.paint(wire, 200 + wire);
    f.bind(c, wire, capture, `input-${wire}`);
    assert.equal(f.gauge().last, 100 + wire);
  }
  f.set(300); f.send('fresh'); c = f.paint(47, 300); f.bind(c, 47, 8, 'fresh');
  assert.equal(f.gauge().last, 0);
});

test('pause, resume and scope boundaries reject previously presented late joins', () => {
  const f = freshnessFixture(); f.set(10); f.send('one');
  f.set(100); const c = f.paint(44, 100);
  f.set(150); f.monitor.setMediaState(false, { scope: f.scope });
  f.set(200); f.bind(c, 44, 7, 'one'); assert.equal(f.gauge().available, false);
  f.set(250); f.send('paused'); f.paint(45, 250, c);
  f.set(300); f.monitor.setMediaState(true, { scope: f.scope });
  f.bind(c, 45, 8, 'paused'); assert.equal(f.gauge().available, false);
  f.set(350); f.send('old'); f.paint(46, 350, c);
  f.set(400); f.w.currentConnectionAttemptId = 'b'; f.monitor.setScope(f.w.latencyScope());
  f.bind(c, 46, 9, 'old', { scope: f.scope }); assert.equal(f.gauge().available, false);
  f.send('pre-scope'); const current = f.paint(47, 399);
  f.bind(current, 47, 10, 'pre-scope'); assert.equal(f.gauge().available, false);
  f.set(450); f.send('new'); const fresh = f.paint(48, 450);
  f.bind(fresh, 48, 1, 'new'); assert.equal(f.gauge().last, 0);
});

test('unassociated paint, ACK, timing, unknown and reused bindings never publish freshness', () => {
  const f = freshnessFixture(); f.set(10); f.send('one');
  f.set(100); const c = f.paint(44, 100); f.monitor.onVideoFrame(100);
  f.monitor.onInputAck({ inputIds: ['one'], status: 'applied' }, { scope: f.scope });
  f.monitor.onFrameTiming({ inputIds: ['one'], schemaVersion: 2, timings: {} }, { scope: f.scope });
  f.bind(c, 44, 1, 'one', { captureFresh: false });
  assert.equal(f.gauge().available, false);
  f.bind(c, 44, 1, 'unknown'); assert.equal(f.gauge().available, false);
});

test('pause clears an established gauge but retains capture high-water until scope changes', () => {
  const f = freshnessFixture(); f.set(10); f.send('one');
  f.set(100); let c = f.paint(44, 100); f.bind(c, 44, 7, 'one');
  assert.equal(f.gauge().last, 0);
  f.set(200); f.monitor.setMediaState(false, { scope: f.scope });
  assert.equal(f.gauge().available, false);
  f.set(300); f.monitor.setMediaState(true, { scope: f.scope });
  f.set(400); f.send('reused'); c = f.paint(45, 400); f.bind(c, 45, 7, 'reused');
  assert.equal(f.gauge().available, false);
  f.set(500); f.send('fresh'); c = f.paint(46, 500); f.bind(c, 46, 8, 'fresh');
  assert.equal(f.gauge().last, 0);
  f.set(600); f.w.currentConnectionAttemptId = 'b'; f.monitor.setScope(f.w.latencyScope());
  assert.equal(f.gauge().available, false);
});

test('unverified scalar, wrong stream and expired join cannot publish freshness', () => {
  const f = freshnessFixture(); f.set(10); f.send('one');
  assert.equal(f.monitor.recordStage('freshFrameAgeMs', 0, { scope: f.scope, sampleKey: 'guess' }), false);
  f.set(100); const c = f.paint(44, 100);
  f.bind(c, 44, 1, 'one', { streamId: 'other' });
  assert.equal(f.gauge().available, false);
  f.set(2100); f.bind(c, 44, 1, 'one');
  assert.equal(f.gauge().available, false);
});
