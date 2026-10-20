const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');


function loadLatencyMonitor(overrides = {}) {
  const context = {
    console,
    Date,
    WebRTC: null,
    ...overrides,
  };
  context.globalThis = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, 'latency-monitor.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__LatencyMonitor = LatencyMonitor;`, context);
  return context.__LatencyMonitor;
}


test('video frame paint tracking never calls RTCPeerConnection.getStats', () => {
  let getStatsCalls = 0;
  const monitor = loadLatencyMonitor({
    WebRTC: { pc: { getStats() { getStatsCalls += 1; return new Map(); } } },
  });

  monitor.onVideoFrame(1000, {});
  monitor.onVideoFrame(1050, {});

  assert.equal(getStatsCalls, 0);
});


test('v2 frame timing records measured fields and leaves encoder/network unavailable', () => {
  const monitor = loadLatencyMonitor();

  monitor.onFrameTiming({
    schemaVersion: 2,
    timings: {
      capturePrepareMs: 3.5,
      frameConvertMs: 1.25,
      encoderMs: null,
      rtpSendMs: null,
      endToEndVideoMs: null,
    },
  });
  const result = monitor.getStats();

  assert.equal(result.capture.last, 3.5);
  assert.equal(result.scale.last, 1.25);
  assert.equal(result.encode.available, false);
  assert.equal(result.network.available, false);
});


test('shared media snapshot supplies interval playout without another stats query', () => {
  const monitor = loadLatencyMonitor();
  monitor.onMediaStats({ jitterBufferMs: 18.5 });

  assert.equal(monitor.getStats().playout.last, 18.5);
});

test('v2 zero duration is measured while invalid durations stay unavailable', () => {
  const monitor = loadLatencyMonitor();
  monitor.onFrameTiming({ schemaVersion: 2, timings: {
    capturePrepareMs: 0, frameConvertMs: -1, encoderMs: NaN, rtpSendMs: 0,
  } });
  const stats = monitor.getStats();
  assert.equal(stats.capture.last, 0);
  assert.equal(stats.capture.available, true);
  assert.equal(stats.scale.available, false);
  assert.equal(stats.encode.available, false);
  assert.equal(stats.network.available, false);
});

test('measured media stages retain enclosing totals without synthesizing freshness or pipeline sums', () => {
  let now = 1000;
  const m = createLatencyMonitor({ now: () => now });
  m.setScope(testScope);
  m.onFrameTiming({ schemaVersion: 2, timings: {
    captureGrabMs: 2, captureAgeAtRecvMs: 9, imgprocQueueMs: 10,
    capturePrepareMs: 5, frameConvertMs: 2, imgprocBuildMs: 7,
    encoderMs: 40, packetizeMs: 3, encodeTotalMs: 43,
    freshFrameAgeMs: 0, rtpSendMs: 1, endToEndVideoMs: 1,
  } });
  m.onVideoFrame(now);
  now = 1050;
  m.onVideoFrame(now);
  const snapshot = m.snapshot();
  assert.equal(snapshot.metrics.imgprocBuildMs.last, 7);
  assert.equal(snapshot.metrics.capturePrepareMs.last, 5);
  assert.equal(snapshot.metrics.frameConvertMs.last, 2);
  assert.equal(snapshot.metrics.encoderMs.last, 40);
  assert.equal(snapshot.metrics.packetizeMs.last, 3);
  assert.equal(snapshot.metrics.encodeTotalMs.last, 43);
  assert.equal(snapshot.metrics.paintIntervalMs.last, 50);
  // Receipt and paint do not prove a new capture. A separate Viewer-clock
  // association is required; a Host field cannot provide that evidence.
  assert.equal(snapshot.metrics.freshFrameAgeMs.available, false);
  assert.equal(snapshot.metrics.inputToVisibleEffectMs.available, false);
  assert.equal('pipelineTotalMs' in snapshot.metrics, false);
  assert.equal(m.getStats().network.available, false);
});

test('legacy out-of-order timestamps are discarded without synthetic network latency', () => {
  const monitor = loadLatencyMonitor();
  monitor.onFrameTiming({ schemaVersion: 1, timings: {
    captureStart: 2, captureEnd: 1, scaleEnd: 3, encodeEnd: 4, packetSend: 5,
  } });
  const stats = monitor.getStats();
  assert.equal(stats.capture.available, false);
  assert.equal(stats.encode.available, false);
  assert.equal(stats.network.available, false);
});

test('legacy frame inputs cannot substitute for adapter await timing', () => {
  const monitor = loadLatencyMonitor();
  monitor.onFrameTiming({ schemaVersion: 2, timings: {}, inputs: [
    { receiveTime: 10, executeTime: 9 },
    { receiveTime: NaN, executeTime: 1 },
    { receiveTime: 2, executeTime: 2.005 },
  ] });
  const stats = monitor.getStats();
  assert.equal(stats.executeTime.count, 0);
  assert.equal(stats.executeTime.last, null);
});


test('independent input ack measures browser RTT while frame timing measures notification', () => {
  let now = 1000;
  class FakeDate extends Date {
    static now() { return now; }
  }
  const monitor = loadLatencyMonitor({ Date: FakeDate, performance: { now: () => now } });
  monitor.recordInputSend('input-1');

  now = 1120;
  monitor.onInputAck({
    type: 'input_ack',
    inputIds: ['input-1'],
    hostExecuteMs: 7,
  });
  let stats = monitor.getStats();
  assert.equal(stats.inputRtt.last, 120);
  assert.equal(stats.executeTime.last, 7);
  assert.equal(stats.visualFeedback.available, false);

  now = 1180;
  monitor.onFrameTiming({
    schemaVersion: 2,
    timings: { capturePrepareMs: 1, frameConvertMs: 1 },
    inputIds: ['input-1'],
  });
  stats = monitor.getStats();
  assert.equal(stats.inputRtt.count, 1);
  assert.equal(stats.visualFeedback.last, 180);
});

const { createLatencyMonitor, LATENCY_METRIC_NAMES } = require('./latency-monitor.js');
test('frame notice is not ACK; snapshot expires without another input', () => {
  let now = 1000;
  const scope = { connectionAttemptId: 'test-a', generation: 1, leaseEpoch: 7 };
  const m = createLatencyMonitor({ now: () => now });
  m.setScope(scope);
  m.recordInputSend('test-input', { scope, domAtMs: 990, submittedAtMs: now,
    inputType: 'mouse', action: 'down', transport: 'socket' });
  now = 1040;
  m.onFrameTiming({ inputIds: ['test-input'] }, { scope, nowMs: now });
  assert.equal(m.snapshot({ nowMs: now, scope }).metrics.inputAckRttMs.count, 0);
  assert.equal(m.snapshot({ nowMs: now, scope }).metrics.inputToVisibleEffectMs.available, false);
  now = 1120;
  const ack = { inputIds: ['test-input'], status: 'applied', hostAdapterAwaitMs: null };
  m.onInputAck(ack, { scope, nowMs: now });
  m.onInputAck(ack, { scope, nowMs: now });
  const s = m.snapshot({ nowMs: now, scope });
  assert.equal(s.metrics.inputAckRttMs.last, 120);
  assert.equal(s.metrics.inputAckRttMs.count, 1);
  assert.equal(s.metrics.hostAdapterAwaitMs.available, false);
  assert.equal(s.outcomes.acked, 1);
  assert.ok(LATENCY_METRIC_NAMES.includes('inputToFrameNoticeMs'));
  now = 120000;
  assert.equal(m.snapshot({ nowMs: now, scope }).metrics.inputAckRttMs.available, false);
  assert.equal(m.snapshot({ nowMs: now, scope }).metrics.inputAckRttMs.count, 0);
});

const testScope = { connectionAttemptId: 'scope-a', generation: 1, leaseEpoch: 2 };
function fixture() {
  let t = 1000;
  const timers = new Map(); let timerId = 0;
  const m = createLatencyMonitor({ now: () => t,
    schedule(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: t + ms }); return id; },
    cancel(id) { timers.delete(id); },
  });
  m.setScope(testScope);
  return { m, timers, set(t2) { t = t2; }, run() {
    for (const [id, timer] of [...timers]) if (timer.at <= t) { timers.delete(id); timer.fn(); }
  }, snapshot: () => m.snapshot({ nowMs: t, scope: testScope }) };
}

test('timeout and late ACK do not manufacture a successful RTT', () => {
  const f = fixture(); f.m.recordInputSend('one', { scope: testScope });
  f.set(11000); assert.equal(f.snapshot().outcomes.timedOut, 1);
  f.set(12000); f.m.onInputAck({ inputIds: ['one'], status: 'applied', hostAdapterAwaitMs: 7 });
  f.m.onInputAck({ inputIds: ['one'], status: 'applied', hostAdapterAwaitMs: 7 });
  assert.equal(f.snapshot().outcomes.late, 1);
  assert.equal(f.snapshot().metrics.inputAckRttMs.count, 0);
  assert.equal(f.snapshot().metrics.hostAdapterAwaitMs.count, 0);
});

test('scope close settles cancelled inputs and atomically drains bounded final summaries', () => {
  const f = fixture(); f.m.recordInputSend('one', { scope: testScope });
  const next = { ...testScope, generation: 2 };
  f.m.setScope(next);
  f.m.onInputAck({ inputIds: ['one'], status: 'applied' }, { scope: testScope });
  const s = f.m.snapshot({ scope: next });
  assert.equal(s.metrics.inputAckRttMs.count, 0); assert.equal(s.outcomes.cancelled, 0);
  const final = f.m.takeClosedScopeSummaries({ nowMs: 1000 });
  assert.equal(final.summaries[0].snapshot.outcomes.cancelled, 1);
  assert.deepEqual(f.m.takeClosedScopeSummaries({ nowMs: 1000 }), { summaries: [], dropped: 0 });
  for (let generation = 3; generation < 10; generation++) f.m.setScope({ ...next, generation });
  const bounded = f.m.takeClosedScopeSummaries({ nowMs: 1000 });
  assert.equal(bounded.summaries.length, 4); assert.equal(bounded.dropped, 3);
  f.m.setScope({ ...next, generation: 10 }); f.set(61001);
  assert.deepEqual(f.m.takeClosedScopeSummaries({ nowMs: 61001 }), { summaries: [], dropped: 1 });
});

test('pause clears paint baseline and freshness while leaving pending ACK observation alive', () => {
  const f = fixture(); f.m.onVideoFrame(1000); f.set(1050); f.m.onVideoFrame(1050);
  f.m.recordInputSend('fresh', { scope: testScope });
  f.m.onPostApplyFrame({ scope: testScope, traceStatus: 'matched', viewerClockMs: 1050,
    streamId: 'video', captureSeq: 1, captureFresh: true, captureAfterApplied: true, inputIds: ['fresh'] }, { scope: testScope });
  assert.equal(f.snapshot().metrics.freshFrameAgeMs.last, 0);
  f.m.recordInputSend('pending', { scope: testScope });
  f.m.setMediaState(false, { nowMs: 1050, scope: testScope });
  assert.equal(f.snapshot().metrics.freshFrameAgeMs.available, false);
  assert.equal(f.snapshot().outcomes.cancelled, 0);
  f.set(301050); f.m.setMediaState(true, { nowMs: 301050, scope: testScope });
  f.m.onVideoFrame(301050);
  assert.equal(f.snapshot().metrics.paintIntervalMs.count, 0);
});

test('all numeric entries reject missing coerced nonfinite and negative values', () => {
  for (const value of [null, undefined, '', NaN, Infinity, -1]) {
    const f = fixture();
    for (const name of LATENCY_METRIC_NAMES) f.m.recordStage(name, value, { scope: testScope, atMs: 1000, sampleKey: 'value' });
    f.m.onMediaStats({ jitterBufferMs: value, rttMs: value });
    for (const metric of Object.values(f.snapshot().metrics)) assert.equal(metric.available, false);
  }
});

test('duplicate ACK and notices yield at most one RTT and adapter sample', () => {
  const f = fixture(); f.m.recordInputSend('one'); f.set(1100);
  const ack = { inputIds: ['one'], status: 'applied', hostAdapterAwaitMs: 20, hostQueueMs: 5, hostApplyMs: 10 };
  f.m.onInputAck(ack); f.m.onInputAck(ack);
  f.m.onFrameTiming({ inputIds: ['one'], timings: { inputToVisibleEffectMs: 123 }, schemaVersion: 2 });
  f.m.onFrameTiming({ inputIds: ['one'] });
  const s = f.snapshot();
  for (const name of ['inputAckRttMs', 'hostAdapterAwaitMs', 'inputToFrameNoticeMs']) assert.equal(s.metrics[name].count, 1);
  assert.equal(s.metrics.inputToVisibleEffectMs.count, 0);
});

test('matched controlled marker frame records visible effect only after current ACK', () => {
  const f = fixture();
  f.m.recordInputSend('visible', { scope: testScope, inputType: 'mouse', action: 'down' });
  f.set(1100);
  f.m.onInputAck({ inputIds: ['visible'], inputType: 'mouse', status: 'applied', leaseEpoch: testScope.leaseEpoch },
    { scope: testScope, nowMs: 1100 });
  f.set(1250);
  const row = { scope: testScope, traceStatus: 'matched', streamId: 'video', captureFresh: true,
    captureAfterApplied: true, viewerClockMs: 1250, inputIds: ['visible'], marker: { sceneId: 1 } };
  assert.equal(f.m.onVisibleEffect(row, { scope: testScope, nowMs: 1250 }), true);
  assert.equal(f.snapshot().metrics.inputToVisibleEffectMs.last, 250);
  assert.equal(f.m.onVisibleEffect(row, { scope: testScope, nowMs: 1250 }), false);

  f.m.recordInputSend('unacked', { scope: testScope, inputType: 'mouse', action: 'down' });
  assert.equal(f.m.onVisibleEffect({ ...row, inputIds: ['unacked'], viewerClockMs: 1260 },
    { scope: testScope, nowMs: 1260 }), true);
  assert.equal(f.snapshot().metrics.inputToVisibleEffectMs.count, 1);
});

test('marker before ACK is retained as a bounded scalar candidate and settled at ACK', () => {
  const f = fixture();
  f.m.recordInputSend('early-marker', { scope: testScope, inputType: 'mouse', action: 'down' });
  f.set(1080);
  const row = { scope: testScope, traceStatus: 'matched', streamId: 'video', captureFresh: true,
    captureAfterApplied: true, viewerClockMs: 1080, inputIds: ['early-marker'], marker: { sceneId: 2 } };
  assert.equal(f.m.onVisibleEffect(row, { scope: testScope, nowMs: 1080 }), true);
  assert.equal(f.snapshot().metrics.inputToVisibleEffectMs.available, false);
  f.set(1120);
  f.m.onInputAck({ inputIds: ['early-marker'], inputType: 'mouse', status: 'applied', leaseEpoch: testScope.leaseEpoch },
    { scope: testScope, nowMs: 1120 });
  assert.equal(f.snapshot().metrics.inputToVisibleEffectMs.last, 80);

  f.m.recordInputSend('early-reject', { scope: testScope, inputType: 'mouse', action: 'down' });
  f.set(1180);
  assert.equal(f.m.onVisibleEffect({ ...row, inputIds: ['early-reject'], viewerClockMs: 1180 },
    { scope: testScope, nowMs: 1180 }), true);
  f.set(1210);
  f.m.onInputAck({ inputIds: ['early-reject'], inputType: 'mouse', status: 'execution-failed', leaseEpoch: testScope.leaseEpoch },
    { scope: testScope, nowMs: 1210 });
  assert.equal(f.snapshot().metrics.inputToVisibleEffectMs.count, 1);
});

test('clock sync times out retries rejects stale v0 and expires successful estimates', () => {
  const f = fixture(); const messages = [];
  assert.equal(f.m.requestClockSync(message => messages.push(message)), true);
  assert.equal(messages.length, 1); f.set(3000); f.run();
  assert.equal(f.m.requestClockSync(message => messages.push(message)), true);
  f.set(3010);
  assert.equal(f.m.handleClockSyncResponse({ v0: 1000, h0: 1, h1: 1 }), false);
  assert.equal(f.m.handleClockSyncResponse({ v0: 3000, h0: 1, h1: 1 }), true);
  assert.equal(f.m.getStats().sync.state, 'synced');
  f.set(33000); f.run(); assert.equal(messages.length, 3);
  f.set(63010); f.snapshot(); assert.notEqual(f.m.getStats().sync.state, 'synced');
});

test('pending and metric capacity evict observations without changing control state', () => {
  const f = fixture();
  for (let i = 0; i < 513; i++) assert.equal(f.m.recordInputSend(`pending-${i}`), true);
  assert.equal(f.snapshot().outcomes.sent, 513); assert.equal(f.snapshot().outcomes.dropped, 1);
  for (let i = 0; i < 4097; i++) f.m.recordStage(LATENCY_METRIC_NAMES[i % LATENCY_METRIC_NAMES.length === 12 ? 0 : i % LATENCY_METRIC_NAMES.length], 1, { atMs: 1000, sampleKey: `sample-${i}` });
  let s = f.snapshot();
  assert.ok(Object.values(s.metrics).reduce((total, item) => total + item.count, 0) <= 4096);
  assert.ok(Object.values(s.metrics).every(item => item.count <= 256));
  assert.ok(s.outcomes.dropped >= 2);
  f.m.recordInputSend('still-accepted'); assert.equal(f.snapshot().outcomes.sent, 514);
});

test('backwards monotonic time and invalid scope cannot manufacture samples', () => {
  const f = fixture(); f.m.recordInputSend('one'); f.set(999);
  f.m.onInputAck({ inputIds: ['one'] });
  assert.equal(f.snapshot().metrics.inputAckRttMs.count, 0);
  f.set(1100); f.m.setScope({ ...testScope, connectionAttemptId: 'x'.repeat(129) });
  f.m.onInputAck({ inputIds: ['one'] }); assert.equal(f.snapshot().metrics.inputAckRttMs.last, 100);
});

test('escaped ASCII identifiers share the total serialized metadata budget with samples', () => {
  const f = fixture();
  const id = i => '\\"'.repeat(60) + String(i).padStart(8, '0');
  for (let i = 0; i < 1024; i++) {
    f.m.recordInputSend(id(i));
    f.m.onInputAck({ inputIds: [id(i)], status: 'applied' });
  }
  for (let i = 1024; i < 1536; i++) assert.equal(f.m.recordInputSend(id(i)), true);
  // Small numeric values make the escaping of retained metadata the dominant
  // bound; discarded metrics must not reject subsequent control submissions.
  const stages = LATENCY_METRIC_NAMES.filter(name => name !== 'freshFrameAgeMs');
  for (let i = 0; i < 4096; i++) f.m.recordStage(stages[i % stages.length], 1, { atMs: 1000, sampleKey: `stage-${'x'.repeat(48)}-${i}` });
  assert.ok(Object.values(f.snapshot().metrics).reduce((sum, metric) => sum + metric.count, 0) < 3500);
  assert.ok(f.snapshot().outcomes.dropped > 0);
  assert.equal(f.m.recordInputSend('still-delivered'), true);
  assert.equal(f.snapshot().outcomes.sent, 1537);
});

test('clock sync retries survive send failure and temporarily missing DataChannel', () => {
  const f = fixture(); let attempts = 0;
  const send = () => { attempts += 1; if (attempts === 2) throw new Error('temporarily closed'); };
  f.m.requestClockSync(send);
  f.set(31000); f.run(); assert.equal(attempts, 2);
  f.set(61000); f.run(); assert.equal(attempts, 3);
  f.m.setScope(null); assert.equal(f.timers.size, 0);

  let now = 1000; const callbacks = new Map(); let id = 0; const sent = [];
  const webRTC = { inputChannel: null };
  const monitor = loadLatencyMonitor({ performance: { now: () => now },
    setTimeout(fn, ms) { const key = ++id; callbacks.set(key, { fn, at: now + ms }); return key; },
    clearTimeout(key) { callbacks.delete(key); }, WebRTC: webRTC });
  monitor.setScope(testScope); assert.equal(monitor.requestClockSync(), false);
  assert.equal(callbacks.size, 1);
  webRTC.inputChannel = { readyState: 'open', send(message) { sent.push(JSON.parse(message)); } };
  now = 31000;
  for (const [key, timer] of [...callbacks]) if (timer.at <= now) { callbacks.delete(key); timer.fn(); }
  assert.equal(sent.length, 1);
  monitor.setScope(null); assert.equal(callbacks.size, 0);
});

test('warmup normalization never creates measured byte or elapsed interval zeros', () => {
  const { WebRtcStats } = require('./webrtc-stats.js');
  const f = fixture();
  const warmup = WebRtcStats.normalizeStats(new Map(), null, 1000);
  f.m.onMediaStats(warmup);
  assert.equal(f.snapshot().metrics.recvBytes.available, false);
  assert.equal(f.snapshot().metrics.elapsedMs.available, false);
  const first = WebRtcStats.normalizeStats(new Map([['video', { id: 'video', type: 'inbound-rtp', kind: 'video', bytesReceived: 50 }]]), null, 1000);
  const second = WebRtcStats.normalizeStats(new Map([['video', { id: 'video', type: 'inbound-rtp', kind: 'video', bytesReceived: 50 }]]), first.totals, 2000);
  f.set(2000); f.m.onMediaStats(second);
  assert.equal(f.snapshot().metrics.recvBytes.last, 0);
  assert.equal(f.snapshot().metrics.elapsedMs.last, 1000);
});

test('unordered ACK bypass cannot consume reliable submission or old-generation observations', () => {
  const f = fixture();
  const ack = { schemaVersion: 2, inputType: 'mouse', status: 'applied', leaseEpoch: testScope.leaseEpoch, inputIds: ['reliable'] };
  f.m.recordInputSend('reliable', { inputType: 'mouse', action: 'down', transport: 'socket' });
  f.set(1100);
  assert.equal(f.m.onUnorderedInputAck(ack, { scope: testScope, transport: 'socket' }), false);
  assert.equal(f.snapshot().outcomes.acked, 0);
  f.m.recordInputSend('move', { inputType: 'mouse', action: 'move', transport: 'socket' });
  assert.equal(f.m.onUnorderedInputAck({ ...ack, inputIds: ['move'] }, { scope: { ...testScope, generation: 2 }, transport: 'socket' }), false);
  assert.equal(f.snapshot().outcomes.acked, 0);
});

test('matched negative unordered ACK settles rejection once while late failures remain late', () => {
  for (const status of ['execution-failed', 'stale-lease', 'sequence-gap', 'resync-required', 'invalid-input', 'unsupported-code']) {
    const f = fixture();
    f.m.recordInputSend('move', { inputType: 'mouse', action: 'move', transport: 'socket' });
    const ack = { schemaVersion: 2, inputType: 'mouse', status, leaseEpoch: testScope.leaseEpoch, inputIds: ['move'] };
    f.set(1100);
    assert.equal(f.m.onUnorderedInputAck({ ...ack, status: 'unknown' }, { scope: testScope, transport: 'socket' }), false);
    assert.equal(f.m.onUnorderedInputAck(ack, { scope: testScope, transport: 'datachannel' }), false);
    assert.equal(f.m.onUnorderedInputAck({ ...ack, leaseEpoch: 999 }, { scope: testScope, transport: 'socket' }), false);
    assert.equal(f.m.onUnorderedInputAck(ack, { scope: { ...testScope, generation: 999 }, transport: 'socket' }), false);
    assert.equal(f.snapshot().outcomes.rejected, 0);
    assert.equal(f.m.onUnorderedInputAck(ack, { scope: testScope, transport: 'socket' }), true);
    f.m.onUnorderedInputAck(ack, { scope: testScope, transport: 'socket' });
    f.set(12000);
    const s = f.snapshot();
    assert.equal(s.outcomes.rejected, 1); assert.equal(s.outcomes.timedOut, 0);
    assert.equal(s.outcomes.acked, 0); assert.equal(s.metrics.inputAckRttMs.count, 0);
  }
  const f = fixture();
  f.m.recordInputSend('late-move', { inputType: 'mouse', action: 'move', transport: 'socket' });
  f.set(11000); f.snapshot(); f.set(12000);
  const ack = { schemaVersion: 2, inputType: 'mouse', status: 'execution-failed', leaseEpoch: testScope.leaseEpoch, inputIds: ['late-move'] };
  assert.equal(f.m.onUnorderedInputAck(ack, { scope: testScope, transport: 'socket' }), true);
  const s = f.snapshot();
  assert.equal(s.outcomes.late, 1); assert.equal(s.outcomes.timedOut, 1);
  assert.equal(s.outcomes.rejected, 0); assert.equal(s.metrics.inputAckRttMs.count, 0);
});

test('late post-apply evidence uses saved presentation time and never settles ACK or visible effect', () => {
  let now = 100;
  const scope = { connectionAttemptId: 'a', generation: 1, leaseEpoch: 7 };
  const monitor = createLatencyMonitor({ now: () => now });
  monitor.setScope(scope); monitor.recordInputSend('one', { scope });
  now = 800;
  assert.equal(monitor.hasPendingFrameInputs(), true);
  assert.equal(monitor.onPostApplyFrame({ scope, traceStatus: 'matched', viewerClockMs: 200, inputIds: ['one'] }, { scope }), true);
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.metrics.inputToPostApplyFrameMs.last, 100);
  assert.equal(snapshot.metrics.inputToVisibleEffectMs.available, false);
  assert.equal(snapshot.metrics.inputAckRttMs.available, false);
  assert.equal(snapshot.outcomes.acked, 0);
  assert.equal(monitor.hasPendingFrameInputs(), false);
  now = 900;
  monitor.onInputAck({ status: 'applied', inputIds: ['one'] }, { scope });
  assert.equal(monitor.snapshot().metrics.inputAckRttMs.last, 800);
});

test('relay origin keys preserve earlier samples in the current collector scope and expire independently', () => {
  let now = 1000;
  const monitor = createLatencyMonitor({ now: () => now });
  monitor.setScope(testScope);
  const keyA = `relay:${'a'.repeat(64)}:1`, keyB = `relay:${'b'.repeat(64)}:1`;
  assert.equal(monitor.recordStage('relayFrameAckRttMs', 100, { scope: testScope, atMs: now, sampleKey: keyA }), true);
  assert.equal(monitor.recordStage('inputAckRttMs', 10, { scope: testScope, atMs: now, sampleKey: 'independent' }), true);
  now = 1100;
  assert.equal(monitor.recordStage('relayFrameAckRttMs', 200, { scope: testScope, atMs: now, sampleKey: keyB }), true);
  assert.equal(monitor.recordStage('relayFrameAckRttMs', 999, { scope: testScope, atMs: now, sampleKey: keyB }), false);
  for (const value of [null, undefined, '', false, NaN, Infinity, -1]) {
    assert.equal(monitor.recordStage('relayFrameAckRttMs', value, { scope: testScope, atMs: now, sampleKey: 'invalid' }), false);
  }
  assert.equal(monitor.snapshot().metrics.relayFrameAckRttMs.count, 2);
  assert.equal(monitor.snapshot().metrics.relayFrameAckRttMs.last, 200);
  assert.equal(monitor.snapshot().metrics.inputAckRttMs.count, 1);
  assert.equal(monitor.recordStage('relayFrameAckRttMs', 300, { scope: testScope, atMs: 1099, sampleKey: 'late-clock' }), false);
  now = 6000;
  assert.equal(monitor.snapshot().metrics.relayFrameAckRttMs.count, 1);
  assert.equal(monitor.snapshot().metrics.inputAckRttMs.available, false);
  now = 6100;
  const absent = monitor.snapshot().metrics.relayFrameAckRttMs;
  assert.equal(absent.available, false); assert.equal(absent.last, null); assert.equal(absent.count, 0);
});

test('native latency: stores event clocks independently of processing high-water', () => {
  let now = 100;
  const m = createLatencyMonitor({ now: () => now, schedule: () => null, cancel() {} });
  const scope = { connectionAttemptId: 'attempt', generation: 2, leaseEpoch: 4 };
  const source = {}, pc = {};
  const live = { pc,
    datachannel: { selectedMoveSendSource: source, selectedReliableSendSource: source,
      reliableAckSource: source },
    socket: { selectedSendSource: null, reliableAckSource: null, object: null, id: null } };
  const current = { scope, leaseId: 'lease', streamId: 'video', pc, live };
  m.setScope(scope);
  assert.equal(m.beginControlledInputEvidence({ inputId: 'lab_inp_1',
    leaseId: 'lease', scope, streamId: 'video', inputType: 'mouse', action: 'down' }), true);
  assert.equal(m.observeControlledSend({ inputId: 'lab_inp_1', leaseId: 'lease',
    leaseEpoch: 4, inputType: 'mouse', action: 'down', seq: 1 }, {
    scope, streamId: 'video', transport: 'datachannel', sendSource: source,
    ackSource: source, socketId: null, pc, live, viewerClockMs: 100 }), true);
  now = 150;
  m.recordInputSend('unrelated', { scope, submittedAtMs: 150 });
  now = 300;
  m.snapshot();
  assert.equal(m.observeControlledAck({ schemaVersion: 2, inputType: 'mouse',
    inputIds: ['lab_inp_1'], leaseEpoch: 4, appliedSeq: 1, status: 'applied' }, {
    ...current, transport: 'datachannel', source, socketId: null,
    viewerClockMs: 200, verdict: 'reliable-applied' }), true);
  const row = m.readControlledInputEvidence('lab_inp_1', current);
  assert.equal(row.send.viewerClockMs, 100);
  assert.equal(row.ack.viewerClockMs, 200);
  assert.equal(row.hostTiming.hostApplyMs, null);
  assert.equal(JSON.stringify(row).includes('ackSource'), false);
  m.clearControlledInputEvidence('lab_inp_1');
  assert.equal(m.readControlledInputEvidence('lab_inp_1', current), null);
});

function controlledFixture({ at = 100, action = 'down', inputType = 'mouse', transport = 'datachannel', inputId = 'lab_1', createMonitor = createLatencyMonitor } = {}) {
  let now = at, timers = 0;
  const m = createMonitor({ now: () => now, schedule() { timers++; return 1; }, cancel() {} });
  const scope = { connectionAttemptId: 'attempt', generation: 2, leaseEpoch: 4 };
  const pc = {}, move = {}, reliable = {}, socket = {};
  const live = { pc, datachannel: { selectedMoveSendSource: move, selectedReliableSendSource: reliable, reliableAckSource: reliable },
    socket: { selectedSendSource: socket, reliableAckSource: socket, object: socket, id: 'socket-1' } };
  const reservation = { inputId, leaseId: 'lease', scope, streamId: 'video', inputType, action };
  const current = { scope, leaseId: 'lease', streamId: 'video', pc, live };
  const source = transport === 'socket' ? socket : action === 'move' ? move : reliable;
  const ackSource = transport === 'socket' ? socket : reliable;
  const meta = { inputId, leaseId: 'lease', leaseEpoch: 4, inputType, action, seq: action === 'move' ? null : 1 };
  const sendContext = { ...current, transport, sendSource: source, ackSource,
    socketId: transport === 'socket' ? 'socket-1' : null, viewerClockMs: at };
  const ack = { schemaVersion: 2, inputIds: [inputId], inputType, leaseEpoch: 4, status: 'applied', appliedSeq: 1 };
  const ackContext = { ...current, transport, source: ackSource, socketId: sendContext.socketId,
    viewerClockMs: at + 20, verdict: action === 'move' ? 'unordered-applied' : 'reliable-applied' };
  const frame = { scope, streamId: 'video', inputIds: [inputId], viewerClockMs: at + 30,
    traceStatus: 'matched', captureSeq: 1, rtpTimestamp: 90, wireTimestamp: 80, rtpOrigin: 10,
    captureFresh: true, captureAfterApplied: true };
  m.setScope(scope);
  return { m, reservation, current, scope, live, meta, sendContext, ack, ackContext, frame,
    setNow(t) { now = t; }, timers: () => timers,
    begin() { return m.beginControlledInputEvidence(reservation); },
    send() { return m.observeControlledSend(meta, sendContext); },
    acknowledge() { now = at + 40; return m.observeControlledAck(ack, ackContext); },
    present() { now = at + 40; return m.onPostApplyFrame(frame, { scope }); },
    read(options) { return m.readControlledInputEvidence(inputId, current, options); },
    complete() { this.begin(); this.send(); this.acknowledge(); this.present(); },
  };
}

test('native latency: zero clock, independent late ACK and exact bounded projection', () => {
  const f = controlledFixture({ at: 0 });
  f.begin(); f.send(); f.present(); // video can arrive before ACK
  assert.equal(f.acknowledge(), true);
  const row = f.read({ finalize: true });
  assert.equal(row.state, 'COMPLETE'); assert.equal(row.reason, 'none');
  assert.equal(row.finalized, true); assert.equal(row.send.viewerClockMs, 0);
  assert.equal(row.ack.viewerClockMs, 20); assert.equal(row.postApply.viewerClockMs, 30);
  assert.equal(row.beganAtMs, 0); assert.equal(row.deadlineAtMs, 10000);
  assert.deepEqual(row.observationCounters, { duplicateAcks: 0, invalidObservations: 0 });
  assert.deepEqual(Object.keys(row).sort(), ['schemaVersion', 'state', 'reason', 'inputId', 'leaseId', 'scope', 'streamId',
    'beganAtMs', 'deadlineAtMs', 'remainingMs', 'finalized', 'expired', 'send', 'ack', 'postApply', 'hostTiming', 'observationCounters'].sort());
  assert.equal(f.timers(), 0);
  row.scope.generation = 900; row.send.viewerClockMs = 900;
  assert.equal(f.read().scope.generation, 2); assert.equal(f.read().send.viewerClockMs, 0);
});

test('native latency: refused second begin and wrong IDs leave the slot and deadline untouched', () => {
  const f = controlledFixture(); assert.equal(f.begin(), true);
  assert.equal(f.m.beginControlledInputEvidence({ ...f.reservation, inputId: 'other' }), false);
  assert.equal(f.m.observeControlledSend({ ...f.meta, inputId: 'other' }, f.sendContext), false);
  assert.equal(f.m.observeControlledAck({ ...f.ack, inputIds: ['other'] }, f.ackContext), false);
  f.setNow(9999);
  assert.equal(f.m.readControlledInputEvidence('other', null, { finalize: true }), null);
  f.m.clearControlledInputEvidence('other');
  const row = f.read(); assert.equal(row.beganAtMs, 100); assert.equal(row.deadlineAtMs, 10100);
  assert.equal(row.finalized, false); assert.equal(row.reason, 'not-sent');
  assert.deepEqual(row.observationCounters, { duplicateAcks: 0, invalidObservations: 0 });
});

for (const [name, patch] of [
  ['long ID', { inputId: 'x'.repeat(129) }], ['8KiB ID', { inputId: 'x'.repeat(8193) }],
  ['bad ID', { inputId: 'non\nprintable' }], ['bad lease', { leaseId: '' }],
  ['stream', { streamId: 'track' }], ['type', { inputType: 'command' }],
  ...['reset', 'click', 'dblclick', 'key', 'batch', 'keydown', 'keyup', 'arbitrary'].map(action => [action, { action }]),
  ['generation', { scope: { connectionAttemptId: 'attempt', generation: -1, leaseEpoch: 4 } }],
  ['unsafe epoch', { scope: { connectionAttemptId: 'attempt', generation: 2, leaseEpoch: Number.MAX_SAFE_INTEGER + 1 } }],
]) test(`native latency: reservation rejects ${name} before occupying slot`, () => {
  const f = controlledFixture();
  assert.equal(f.m.beginControlledInputEvidence({ ...f.reservation, ...patch }), false);
  assert.equal(f.read(), null); assert.equal(f.begin(), true);
});

for (const [name, metaPatch, contextPatch, reason] of [
  ['type', { inputType: 'keyboard' }, {}, 'conflicting-observation'],
  ['action', { action: 'move' }, {}, 'conflicting-observation'],
  ['lease', { leaseId: 'other' }, {}, 'lease-changed'],
  ['epoch', { leaseEpoch: 5 }, {}, 'scope-changed'],
  ['generation', {}, { scope: { connectionAttemptId: 'attempt', generation: 3, leaseEpoch: 4 } }, 'scope-changed'],
  ['stream', {}, { streamId: 'track' }, 'scope-changed'],
  ['PC', {}, { pc: {} }, 'source-changed'],
  ['source', {}, { sendSource: {} }, 'source-changed'],
  ['ACK source', {}, { ackSource: {} }, 'source-changed'],
  ['sequence', { seq: 0 }, {}, null],
]) test(`native latency: accepted send rejects wrong ${name}`, () => {
  const f = controlledFixture(); f.begin();
  assert.equal(f.m.observeControlledSend({ ...f.meta, ...metaPatch }, { ...f.sendContext, ...contextPatch }), false);
  assert.equal(f.read().send, null); assert.equal(f.read().observationCounters.invalidObservations, 1);
  if (reason) assert.equal(f.read().reason, reason);
});

for (const value of [NaN, Infinity, -1, 101, undefined]) {
  test(`native latency: invalid send event clock ${value}`, () => {
    const f = controlledFixture(); f.begin();
    assert.equal(f.m.observeControlledSend(f.meta, { ...f.sendContext, viewerClockMs: value }), false);
    assert.equal(f.read().reason, 'clock-invalid');
  });
}
for (const stage of ['send', 'ack', 'frame', 'read']) test(`native latency: processing clock throw is isolated in ${stage}`, () => {
  let t = 100, throws = false;
  const m = createLatencyMonitor({ now() { if (throws) throw new Error('private secret'); return t; } });
  const f = controlledFixture(); m.setScope(f.scope); m.beginControlledInputEvidence(f.reservation);
  m.observeControlledSend(f.meta, f.sendContext); throws = true;
  assert.doesNotThrow(() => {
    if (stage === 'send') m.observeControlledSend(f.meta, f.sendContext);
    if (stage === 'ack') m.observeControlledAck(f.ack, f.ackContext);
    if (stage === 'frame') {
      // The diagnostic observer is isolated; M1 still receives its own explicit valid processing clock.
      m.onPostApplyFrame(f.frame, { scope: f.scope, nowMs: 140 });
    }
    if (stage === 'read') m.readControlledInputEvidence('lab_1', f.current);
  });
  throws = false; t = 140;
  const row = m.readControlledInputEvidence('lab_1', f.current);
  assert.equal(row.reason, 'observation-error'); assert.equal(JSON.stringify(row).includes('secret'), false);
});

test('native latency: ACK before send cannot acquire evidence and send twice is a conflict', () => {
  const f = controlledFixture(); f.begin(); f.setNow(140);
  assert.equal(f.m.observeControlledAck(f.ack, f.ackContext), false);
  assert.equal(f.read().ack, null); assert.equal(f.send(), true);
  assert.equal(f.send(), false); assert.equal(f.read().reason, 'conflicting-observation');
});

for (const [name, ackPatch, contextPatch] of [
  ['rejected', { status: 'execution-failed' }, {}], ['wire duplicate', { status: 'duplicate' }, {}],
  ['future seq', { appliedSeq: 2 }, {}], ['wrong type', { inputType: 'keyboard' }, {}],
  ['wrong epoch', { leaseEpoch: 3 }, {}], ['multi ID', { inputIds: ['lab_1', 'other'] }, {}],
  ['version', { schemaVersion: 1 }, {}], ['verdict', {}, { verdict: 'unordered-applied' }],
]) test(`native latency: ${name} ACK does not create a sample`, () => {
  const f = controlledFixture(); f.begin(); f.send(); f.setNow(140);
  assert.equal(f.m.observeControlledAck({ ...f.ack, ...ackPatch }, { ...f.ackContext, ...contextPatch }), false);
  assert.equal(f.read().ack, null); assert.equal(f.read().observationCounters.invalidObservations, 1);
});

for (const [stage, event] of [['ACK', 99], ['ACK', 150], ['frame', 99], ['frame', NaN]]) test(`native latency: ${stage} clock ${event} cannot qualify`, () => {
  const f = controlledFixture(); f.begin(); f.send(); f.setNow(140);
  if (stage === 'ACK') f.m.observeControlledAck(f.ack, { ...f.ackContext, viewerClockMs: event });
  else f.m.onPostApplyFrame({ ...f.frame, viewerClockMs: event }, { scope: f.scope });
  assert.equal(f.read().reason, 'clock-invalid');
});

test('native latency: exact duplicate ACK counts once and conflicting duplicate is sticky', () => {
  const f = controlledFixture(); f.begin(); f.send(); f.acknowledge();
  f.ackContext.viewerClockMs = 130;
  assert.equal(f.m.observeControlledAck(f.ack, f.ackContext), false);
  assert.equal(f.read().ack.viewerClockMs, 120); assert.equal(f.read().observationCounters.duplicateAcks, 1);
  assert.equal(f.m.observeControlledAck({ ...f.ack, hostApplyMs: 3 }, f.ackContext), false);
  assert.equal(f.read().reason, 'conflicting-observation');
  assert.equal(f.read().observationCounters.invalidObservations, 1);
});

for (const [field, value] of [['captureFresh', undefined], ['captureAfterApplied', false], ['traceStatus', 'unmatched'],
  ['captureSeq', -1], ['rtpTimestamp', 0x100000000], ['wireTimestamp', undefined], ['rtpOrigin', -1]]) {
  test(`native latency: M2 requires ${field}`, () => {
    const f = controlledFixture(); f.begin(); f.send(); f.acknowledge();
    f.m.onPostApplyFrame({ ...f.frame, [field]: value }, { scope: f.scope });
    assert.equal(f.read().postApply, null); assert.equal(f.read().observationCounters.invalidObservations, 1);
  });
}

for (const transport of ['datachannel', 'socket']) for (const action of ['down', 'move']) {
  const rotations = transport === 'socket' ? ['object', 'id', 'selectedSendSource', 'reliableAckSource']
    : [action === 'move' ? 'selectedMoveSendSource' : 'selectedReliableSendSource', 'reliableAckSource', 'pc'];
  for (const rotation of rotations) test(`native latency: completed ${transport}/${action} rotates ${rotation}`, () => {
    const f = controlledFixture({ transport, action }); f.complete();
    if (rotation === 'pc') { f.current.pc = {}; f.live.pc = f.current.pc; }
    else f.live[transport][rotation] = rotation === 'id' ? 'new-id' : {};
    const row = f.read({ finalize: true });
    assert.equal(row.state, 'INCOMPLETE'); assert.equal(row.reason, 'source-changed'); assert.equal(row.finalized, true);
  });
}

test('native latency: unordered ACK from former reliable channel cannot qualify', () => {
  const f = controlledFixture({ action: 'move' }); f.begin(); f.send(); f.setNow(140);
  f.live.datachannel.reliableAckSource = {};
  assert.equal(f.m.observeControlledAck(f.ack, f.ackContext), false);
  assert.equal(f.read().reason, 'source-changed'); assert.equal(f.read().ack, null);
});

test('native latency: unused source candidates may rotate and finalized complete is rechecked', () => {
  const f = controlledFixture(); f.complete();
  f.live.datachannel.selectedMoveSendSource = {}; f.live.socket.object = {};
  assert.equal(f.read({ finalize: true }).state, 'COMPLETE');
  f.live.datachannel.reliableAckSource = {};
  assert.equal(f.read().reason, 'source-changed'); assert.equal(f.read().state, 'INCOMPLETE');
});

test('native latency: socket ID must be nonempty and identical at accepted send', () => {
  for (const socketId of [null, '', 'wrong']) {
    const f = controlledFixture({ transport: 'socket' }); f.begin();
    assert.equal(f.m.observeControlledSend(f.meta, { ...f.sendContext, socketId }), false);
    assert.equal(f.read().reason, 'source-changed');
  }
});

test('native latency: immutable 10s deadline handles polling, late M2 and missing-stage precedence', () => {
  const f = controlledFixture(); f.begin(); f.send(); f.acknowledge();
  for (const t of [200, 1000, 10099]) {
    f.setNow(t); const row = f.read();
    assert.equal(row.beganAtMs, 100); assert.equal(row.deadlineAtMs, 10100);
    assert.equal(row.remainingMs, 10100 - t); assert.equal(row.finalized, false);
  }
  f.setNow(10100); const row = f.read({ finalize: true });
  assert.equal(row.reason, 'post-apply-missing'); assert.equal(row.expired, true); assert.equal(row.finalized, true);
  f.frame.viewerClockMs = 10100; f.m.onPostApplyFrame(f.frame, { scope: f.scope });
  assert.equal(f.read().postApply, null);
  const late = controlledFixture(); late.begin(); late.send(); late.acknowledge(); late.setNow(10099);
  late.frame.viewerClockMs = 10090; late.m.onPostApplyFrame(late.frame, { scope: late.scope });
  assert.equal(late.read({ finalize: true }).state, 'COMPLETE');
});

for (const mode of ['not-sent', 'ack-missing', 'all']) test(`native latency: expired ${mode} terminal precedence`, () => {
  const f = controlledFixture(); f.begin();
  if (mode !== 'not-sent') f.send();
  if (mode === 'all') { f.acknowledge(); f.present(); }
  f.setNow(10100); const row = f.read({ finalize: true });
  assert.equal(row.reason, mode === 'all' ? 'expired' : mode); assert.equal(row.state, 'INCOMPLETE');
});

for (const terminalReason of ['dispatch-refused', 'observation-error', 'cancelled']) test(`native latency: explicit ${terminalReason} wins missing stage but loses sticky identity error`, () => {
  const f = controlledFixture(); f.begin();
  assert.equal(f.read({ finalize: true, terminalReason }).reason, terminalReason);
  const g = controlledFixture(); g.begin(); g.current.leaseId = 'other';
  assert.equal(g.read({ finalize: true, terminalReason }).reason, 'lease-changed');
});

test('native latency: scope replacement cancels evidence, explicit clear releases it', () => {
  const f = controlledFixture(); f.complete();
  f.m.setScope({ ...f.scope, generation: 3 }); assert.equal(f.read().reason, 'scope-changed');
  f.m.clearControlledInputEvidence('lab_1'); assert.equal(f.read(), null);
  f.m.setScope(f.scope); assert.equal(f.begin(), true);
  f.m.setScope(null); assert.equal(f.read().reason, 'scope-changed');
});

test('native latency: maximum legal ASCII metadata stays bounded, projections omit private payload and references', () => {
  const f = controlledFixture({ inputId: '\\'.repeat(128) });
  f.reservation.leaseId = f.meta.leaseId = f.current.leaseId = f.ackContext.leaseId = '"'.repeat(128);
  f.scope.connectionAttemptId = '\\'.repeat(128); f.m.setScope(f.scope);
  f.reservation.payload = { private: 'x'.repeat(9000) }; f.meta.payload = f.reservation.payload;
  f.complete(); const row = f.read({ finalize: true });
  assert.equal(row.state, 'COMPLETE'); assert.ok(Buffer.byteLength(JSON.stringify(row)) <= 8192);
  for (const key of ['private', 'payload', 'sendSource', 'ackSource', 'socketId', 'live', 'pc']) assert.equal(JSON.stringify(row).includes(`"${key}"`), false);
});

test('native latency: controlled APIs leave product ledgers, samples and timers unchanged', () => {
  const f = controlledFixture(); f.m.recordInputSend('business', { scope: f.scope });
  const before = f.m.snapshot(); f.complete();
  f.m.observeControlledAck(f.ack, f.ackContext); f.read({ finalize: true });
  const after = f.m.snapshot();
  assert.deepEqual(after.outcomes, before.outcomes);
  assert.deepEqual(Object.fromEntries(Object.entries(after.metrics).map(([k, v]) => [k, v.count])),
    Object.fromEntries(Object.entries(before.metrics).map(([k, v]) => [k, v.count])));
  assert.equal(f.m.hasPendingFrameInputs(), true); assert.equal(f.timers(), 0);
});

for (const stage of ['ack', 'read']) for (const field of ['scope', 'leaseId', 'streamId', 'pc']) {
  test(`native latency: ${stage} freshly fences ${field}`, () => {
    const f = controlledFixture(); f.begin(); f.send(); f.setNow(140);
    const context = { ...f.current, [field]: field === 'scope' ? { ...f.scope, generation: 9 }
      : field === 'pc' ? {} : 'other' };
    if (stage === 'ack') assert.equal(f.m.observeControlledAck(f.ack, { ...f.ackContext, ...context }), false);
    const row = f.m.readControlledInputEvidence('lab_1', stage === 'read' ? context : f.current, { finalize: true });
    assert.equal(row.reason, field === 'leaseId' ? 'lease-changed' : field === 'pc' ? 'source-changed' : 'scope-changed');
  });
}

test('native latency: ACK requires incoming saved source and socket ID', () => {
  for (const transport of ['datachannel', 'socket']) {
    const f = controlledFixture({ transport }); f.begin(); f.send(); f.setNow(140);
    assert.equal(f.m.observeControlledAck(f.ack, { ...f.ackContext, source: {} }), false);
    assert.equal(f.read().reason, 'source-changed');
  }
  const g = controlledFixture({ transport: 'socket' }); g.begin(); g.send(); g.setNow(140);
  assert.equal(g.m.observeControlledAck(g.ack, { ...g.ackContext, socketId: 'other' }), false);
  assert.equal(g.read().reason, 'source-changed');
});

for (const value of [NaN, Infinity, -1, undefined]) test(`native latency: invalid processing clock ${value} isolates evidence`, () => {
  const f = controlledFixture(); f.begin(); f.send(); f.setNow(value);
  assert.equal(f.m.observeControlledAck(f.ack, f.ackContext), false);
  f.setNow(140); assert.equal(f.read().reason, 'clock-invalid');
});

test('native latency: overflow begin clock cannot occupy a slot; backwards processing cannot repair evidence', () => {
  const f = controlledFixture(); f.setNow(Number.MAX_VALUE);
  assert.equal(f.begin(), false); assert.equal(f.read(), null);
  f.setNow(100); assert.equal(f.begin(), true); f.send(); f.setNow(99);
  assert.equal(f.m.observeControlledAck(f.ack, f.ackContext), false);
  f.setNow(140); assert.equal(f.read().reason, 'clock-invalid');
});

test('native latency: explicit terminal reason retains precedence at the expiry boundary', () => {
  const f = controlledFixture(); f.begin(); f.setNow(10100);
  const row = f.read({ finalize: true, terminalReason: 'dispatch-refused' });
  assert.equal(row.reason, 'dispatch-refused'); assert.equal(row.expired, true);
});

test('native latency: counters saturate safely without retaining repeated ACK rows', () => {
  // Seed the otherwise private counters at the numeric boundary; no public mutation hook.
  const source = fs.readFileSync(path.join(__dirname, 'latency-monitor.js'), 'utf8')
    .replace('counters: { duplicateAcks: 0, invalidObservations: 0 }',
      'counters: { duplicateAcks: Number.MAX_SAFE_INTEGER - 1, invalidObservations: Number.MAX_SAFE_INTEGER - 1 }');
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(source, sandbox);
  const f = controlledFixture({ createMonitor: sandbox.module.exports.createLatencyMonitor });
  f.begin(); f.send(); f.setNow(140);
  for (let i = 0; i < 3; i++) f.m.observeControlledAck({ ...f.ack, status: 'duplicate' }, f.ackContext);
  f.acknowledge();
  for (let i = 0; i < 3; i++) f.m.observeControlledAck(f.ack, f.ackContext);
  assert.equal(f.read().observationCounters.duplicateAcks, Number.MAX_SAFE_INTEGER);
  f.m.observeControlledAck({ ...f.ack, hostApplyMs: 1 }, f.ackContext);
  f.current.leaseId = 'other';
  assert.equal(f.read().observationCounters.invalidObservations, Number.MAX_SAFE_INTEGER);
  assert.equal(Object.keys(f.read().observationCounters).length, 2);
});

test('native latency: keyboard text and every declared mouse action remain supported', () => {
  for (const [inputType, action] of [['mouse', 'wheel'], ['mouse', 'down'], ['mouse', 'move'], ['mouse', 'up'], ['keyboard', 'text']]) {
    const f = controlledFixture({ inputType, action }); f.complete();
    assert.equal(f.read({ finalize: true }).state, 'COMPLETE');
  }
});

test('native latency: later observations cannot change finalized rows or terminal reason', () => {
  const f = controlledFixture(); f.begin();
  const first = f.read({ finalize: true, terminalReason: 'cancelled' });
  f.send(); f.acknowledge(); f.present();
  assert.deepEqual(f.read(), { ...first, remainingMs: 9960 });
});

test('native latency: frame without an accepted send cannot populate the slot', () => {
  const f = controlledFixture(); f.begin(); f.setNow(140);
  f.m.onPostApplyFrame(f.frame, { scope: f.scope });
  assert.equal(f.read().postApply, null); assert.equal(f.read().observationCounters.invalidObservations, 1);
  f.send(); f.acknowledge(); f.present();
  assert.equal(f.read({ finalize: true }).state, 'COMPLETE');
});

for (const transport of ['datachannel', 'socket']) {
  for (const [inputType, action] of [['mouse', 'down'], ['mouse', 'up'], ['mouse', 'wheel'], ['keyboard', 'text']]) {
    test(`native latency: saved reliable ${inputType}/${action}/${transport} replay via unordered path preserves late M2`, () => {
      const f = controlledFixture({ transport, inputType, action });
      f.ack.hostAdapterAwaitMs = 0; f.ack.hostQueueMs = 2; f.ack.hostApplyMs = 3;
      f.begin(); f.send(); f.acknowledge();
      const first = f.read();
      const replay = { ...f.ackContext, verdict: 'unordered-applied', viewerClockMs: 130 };
      assert.equal(f.m.observeControlledAck(f.ack, replay), false);
      const pending = f.read();
      assert.equal(pending.state, 'PENDING'); assert.equal(pending.reason, 'post-apply-missing');
      assert.equal(pending.finalized, false); assert.equal(pending.postApply, null);
      assert.deepEqual(pending.ack, first.ack); assert.deepEqual(pending.hostTiming, first.hostTiming);
      assert.equal(pending.beganAtMs, first.beganAtMs); assert.equal(pending.deadlineAtMs, first.deadlineAtMs);
      assert.deepEqual(pending.observationCounters, { duplicateAcks: 1, invalidObservations: 0 });
      f.present();
      const final = f.read({ finalize: true });
      assert.equal(final.state, 'COMPLETE'); assert.equal(final.finalized, true);
      assert.equal(final.ack.viewerClockMs, 120); assert.equal(final.postApply.viewerClockMs, 130);
      assert.deepEqual(final.hostTiming, { hostAdapterAwaitMs: 0, hostQueueMs: 2, hostApplyMs: 3 });
    });
  }
}

for (const transport of ['datachannel', 'socket']) {
  for (const [name, ackPatch, contextPatch, reason] of [
    ['unknown verdict', {}, { verdict: 'unknown' }, 'conflicting-observation'],
    ['missing verdict', {}, { verdict: undefined }, 'conflicting-observation'],
    ['future sequence', { appliedSeq: 2 }, {}, 'conflicting-observation'],
    ['wrong type', { inputType: 'keyboard' }, {}, 'conflicting-observation'],
    ['wrong epoch', { leaseEpoch: 3 }, {}, 'conflicting-observation'],
    ['wrong schema', { schemaVersion: 1 }, {}, 'conflicting-observation'],
    ['wire duplicate status', { status: 'duplicate' }, {}, 'conflicting-observation'],
    ['multiple IDs', { inputIds: ['lab_1', 'other'] }, {}, 'conflicting-observation'],
    ['conflicting timing', { hostApplyMs: 9 }, {}, 'conflicting-observation'],
    ['wrong source', {}, { source: {} }, 'source-changed'],
    ['wrong lease', {}, { leaseId: 'other' }, 'lease-changed'],
    ['wrong scope', {}, { scope: { connectionAttemptId: 'attempt', generation: 3, leaseEpoch: 4 } }, 'scope-changed'],
    ['wrong stream', {}, { streamId: 'other' }, 'scope-changed'],
    ['wrong PC', {}, { pc: {} }, 'source-changed'],
    ['future clock', {}, { viewerClockMs: 150 }, 'clock-invalid'],
    ['clock before send', {}, { viewerClockMs: 99 }, 'clock-invalid'],
  ]) test(`native latency: saved ${transport} replay cannot bypass ${name}`, () => {
    const f = controlledFixture({ transport }); f.begin(); f.send(); f.acknowledge();
    const first = f.read();
    assert.equal(f.m.observeControlledAck({ ...f.ack, ...ackPatch },
      { ...f.ackContext, verdict: 'unordered-applied', viewerClockMs: 130, ...contextPatch }), false);
    const row = f.read();
    assert.equal(row.reason, reason); assert.equal(row.state, 'INCOMPLETE');
    assert.equal(row.observationCounters.duplicateAcks, 0);
    assert.deepEqual(row.ack, first.ack); assert.deepEqual(row.hostTiming, first.hostTiming);
  });
}

for (const transport of ['datachannel', 'socket']) test(`native latency: saved ${transport} replay rechecks fresh selected source`, () => {
  const f = controlledFixture({ transport }); f.begin(); f.send(); f.acknowledge();
  if (transport === 'socket') f.live.socket.id = 'new-socket-id';
  else f.live.datachannel.selectedReliableSendSource = {};
  assert.equal(f.m.observeControlledAck(f.ack, { ...f.ackContext, verdict: 'unordered-applied', viewerClockMs: 130 }), false);
  assert.equal(f.read().reason, 'source-changed');
  assert.equal(f.read().observationCounters.duplicateAcks, 0);
});

test('native latency: saved socket replay must retain incoming socket ID', () => {
  const f = controlledFixture({ transport: 'socket' }); f.begin(); f.send(); f.acknowledge();
  assert.equal(f.m.observeControlledAck(f.ack, { ...f.ackContext, verdict: 'unordered-applied', socketId: 'other' }), false);
  assert.equal(f.read().reason, 'source-changed'); assert.equal(f.read().observationCounters.duplicateAcks, 0);
});

test('native latency: unrelated replay ID cannot alter saved ACK or acquire duplicate qualification', () => {
  const f = controlledFixture(); f.begin(); f.send(); f.acknowledge();
  const before = f.read();
  assert.equal(f.m.observeControlledAck({ ...f.ack, inputIds: ['other'] }, { ...f.ackContext, verdict: 'unordered-applied' }), false);
  assert.deepEqual(f.read(), before);
});

for (const transport of ['datachannel', 'socket']) {
  for (const [inputType, action, verdict] of [['mouse', 'down', 'unordered-applied'], ['keyboard', 'text', 'unordered-applied'], ['mouse', 'move', 'reliable-applied']]) {
    test(`native latency: first ${inputType}/${action}/${transport} ACK still requires original action authority`, () => {
      const f = controlledFixture({ transport, inputType, action }); f.begin(); f.send(); f.setNow(140);
      assert.equal(f.m.observeControlledAck(f.ack, { ...f.ackContext, verdict }), false);
      const row = f.read();
      assert.equal(row.ack, null); assert.equal(row.state, 'PENDING'); assert.equal(row.finalized, false);
      assert.deepEqual(row.observationCounters, { duplicateAcks: 0, invalidObservations: 1 });
      assert.equal(f.acknowledge(), true);
    });
  }
}
