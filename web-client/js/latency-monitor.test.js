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
  f.m.recordStage('freshFrameAgeMs', 0, { atMs: 1050, scope: testScope, sampleKey: 'fresh' });
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
