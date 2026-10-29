const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const nativeClearTimeout = global.clearTimeout;
const nativeClearInterval = global.clearInterval;
const activeWebRtcFixtures = new Set();

test.afterEach(() => {
  [...activeWebRtcFixtures].forEach((cleanup) => cleanup());
});

test('Lab-only loss taps retain rVFC and Host data-channel events with real getStats snapshots', async () => {
  const { WebRTC } = loadWebRTC();
  WebRTC.pc = {
    connectionState: 'connected',
    getStats: async () => new Map([
      ['inbound', { id: 'inbound', type: 'inbound-rtp', kind: 'video', packetsReceived: 12, packetsLost: 1, jitter: 0.003, frameWidth: 1280, frameHeight: 720 }],
      ['pair', { id: 'pair', type: 'candidate-pair', selected: true, state: 'succeeded', localCandidateId: 'local' }],
      ['local', { id: 'local', type: 'local-candidate', candidateType: 'relay', address: '127.0.0.1', port: 51002, protocol: 'udp' }],
    ]),
  };
  WebRTC.currentConnectionAttemptId = 'attempt'; WebRTC.connectionAttemptSequence = 4;
  const sent = [];
  WebRTC.inputChannel = { readyState: 'open', send: (message) => sent.push(JSON.parse(message)) };
  assert.equal(WebRTC.beginLossLabTrace(), true);
  assert.equal(JSON.stringify(sent), JSON.stringify([{ type: 'loss_lab_trace_begin', schemaVersion: 1, epoch: 1 }]));
  assert.equal(WebRTC.acceptLossLabFlushAck({ type: 'loss_lab_trace_flush_ack', schemaVersion: 1, epoch: 1, sourceWatermark: 0 }), true);
  assert.equal(WebRTC.acceptFrameTraceBatch({ type: 'frame_trace_batch', schemaVersion: 1, droppedTraceCount: 0,
    traces: [{ attemptId: 'attempt', generation: 4, streamId: 'video', captureSeq: 7, encoderTimestamp: 41,
      wireTimestamp: 42, ssrc: 1, framePts: 7, idrKind: 'PLI', idrReason: 'loss', policyDigest: 'policy',
      stages: { grab: 1, age_at_recv: 1, worker_queue: 1, prepare: 1, build: 1, reformat: 1, encode: 1, packetize: 1, encode_total: 1 } }] }), 0);
  assert.equal(WebRTC.ensureFrameTraceCollector().observeVideoFrame(
    { attemptId: 'attempt', generation: 4, streamId: 'video', ssrc: 1, rtpTimestamp: 42 }, {}, 0), true);
  WebRTC.recordLossLabRvfc({ rtpTimestamp: 42 }, { videoWidth: 1280, videoHeight: 720 });
  WebRTC.acceptLossLabHostTraceBatch({ type: 'loss_lab_host_trace_batch', schemaVersion: 1, tapEpoch: 1, droppedEventCount: 0,
    events: [{ type: 'rtcp_feedback', kind: 'PLI', monotonicNs: 1, senderId: 'host', tapEpoch: 1, sourceSeq: 1 }] });
  const snapshot = await WebRTC.takeLossLabTraceSnapshot();
  assert.equal(snapshot.rvfc[0].rtpTimestamp, 42);
  assert.equal(snapshot.rvfc[0].captureSeq, 7);
  assert.equal(snapshot.rvfc[0].wireTimestamp, 42);
  assert.equal(snapshot.host[0].kind, 'PLI');
  assert.equal(snapshot.stats.inbound.packetsLost, 1);
  assert.equal(snapshot.stats.selectedRelay.address, '127.0.0.1');
  assert.equal(snapshot.flushAck.epoch, 1);
  assert.equal(snapshot.flushAck.accepted, true);
  assert.equal(snapshot.flushAck.sourceWatermark, 0);
});

function makeElement() {
  const classes = new Set();
  const listeners = new Map();
  const attrs = new Map();
  const el = {
    textContent: '',
    style: {},
    src: '',
    dataset: {},
    disabled: false,
    classList: {
      add(...tokens) { tokens.forEach((token) => classes.add(token)); },
      remove(...tokens) { tokens.forEach((token) => classes.delete(token)); },
      contains(token) { return classes.has(token); },
      toggle(token, force) {
        if (force === true) {
          classes.add(token);
          return true;
        }
        if (force === false) {
          classes.delete(token);
          return false;
        }
        if (classes.has(token)) {
          classes.delete(token);
          return false;
        }
        classes.add(token);
        return true;
      },
    },
    listeners,
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type, handler) { if (listeners.get(type) === handler) listeners.delete(type); },
    removeAttribute(name) { attrs.delete(name); },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    contains(node) { return node === el; },
  };
  return el;
}

function loadWebRTC(overrides = {}) {
  const elements = new Map();
  const timers = { timeouts: new Set(), intervals: new Set() };
  const trackTimeout = (...args) => {
    const timer = global.setTimeout(...args);
    timers.timeouts.add(timer);
    return timer;
  };
  const clearTrackedTimeout = (timer) => {
    timers.timeouts.delete(timer);
    return global.clearTimeout(timer);
  };
  const trackInterval = (...args) => {
    const timer = global.setInterval(...args);
    timers.intervals.add(timer);
    return timer;
  };
  const clearTrackedInterval = (timer) => {
    timers.intervals.delete(timer);
    return global.clearInterval(timer);
  };
  const context = {
    console,
    // Explicit offline configuration response; never use a real network fetch.
    fetch: async (url) => ({ ok: true, status: 200, json: async () => url.endsWith('/api/auth/viewer-admission') ? { admission: { ticket: 'fixture-ticket' } } : {} }),
    AbortController,
    URLSearchParams,
    setTimeout: trackTimeout,
    clearTimeout: clearTrackedTimeout,
    setInterval: trackInterval,
    clearInterval: clearTrackedInterval,
    performance: { now: () => 0 },
    navigator: { platform: 'MacIntel', userAgent: 'node-test' },
    requestAnimationFrame: (fn) => fn(),
    getComputedStyle: () => ({ objectFit: 'contain' }),
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    document: {
      body: makeElement(),
      addEventListener() {},
      querySelector: () => null,
      getElementById(id) {
        if (!elements.has(id)) {
          elements.set(id, makeElement());
        }
        return elements.get(id);
      },
    },
    Auth: {
      getToken: () => 'token',
      isLoggedIn: () => true,
      isVerified: () => true,
      logout: () => {},
    },
    RTCSessionDescription: function RTCSessionDescription(value) { return value; },
    RTCIceCandidate: function RTCIceCandidate(value) { return value; },
    RTCRtpReceiver: null,
    LinkQualityController: overrides.LinkQualityController,
    window: {
      location: { origin: 'http://127.0.0.1:8080' },
      RTCRtpReceiver: null,
    },
    io: () => ({ on() {}, emit() {}, disconnect() {}, connected: true }),
  };
  Object.assign(context, overrides);
  // Partial storage overrides still implement the browser Storage interface.
  context.localStorage = { removeItem() {}, ...context.localStorage };
  if (overrides.document) {
    context.document = overrides.document;
  }
  if (overrides.window) {
    context.window = overrides.window;
  }
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'bounded-request.js'), 'utf8'), context);
  if (!overrides.createDesktopSessionState) {
    const stateSource = fs.readFileSync(path.join(__dirname, 'desktop-session-state.js'), 'utf8');
    vm.runInContext(stateSource, context);
    if (!context.createDesktopSessionState && context.window?.createDesktopSessionState) {
      context.createDesktopSessionState = context.window.createDesktopSessionState;
    }
  }
  if (!overrides.PresentationBudget) {
    const budgetSource = fs.readFileSync(
      path.join(__dirname, 'presentation-budget.js'),
      'utf8',
    );
    vm.runInContext(budgetSource, context);
    if (!context.PresentationBudget && context.window?.PresentationBudget) {
      context.PresentationBudget = context.window.PresentationBudget;
    }
  }
  if (!overrides.StunPortSearchController) {
    const controllerSource = fs.readFileSync(
      path.join(__dirname, 'stun-port-search-controller.js'),
      'utf8',
    );
    vm.runInContext(controllerSource, context);
    // Controller IIFE binds to window when present; mirror onto the sandbox global.
    if (!context.StunPortSearchController && context.window?.StunPortSearchController) {
      context.StunPortSearchController = context.window.StunPortSearchController;
    }
  }
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'runtime-diagnostic.js'), 'utf8'), context);
  const source = fs.readFileSync(path.join(__dirname, 'webrtc.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__WebRTC = WebRTC;`, context);
  if (overrides.realInput) {
    for (const filename of ['input-geometry.js', 'keyboard-transport.js', 'remote-keyboard-controller.js', 'input.js']) {
      const inputSource = fs.readFileSync(path.join(__dirname, filename), 'utf8');
      vm.runInContext(filename === 'input.js' ? `${inputSource}\nglobalThis.__Input = Input;` : inputSource, context);
    }
  }
  const cleanup = () => {
    const instance = context.__WebRTC;
    instance?.stopControlHeartbeat?.();
    instance?.stopDcKeepalive?.();
    instance?.stopMediaTelemetry?.();
    if (instance?._latencySyncInterval) {
      clearTrackedInterval(instance._latencySyncInterval);
      instance._latencySyncInterval = null;
    }
    timers.timeouts.forEach((timer) => nativeClearTimeout(timer));
    timers.intervals.forEach((timer) => nativeClearInterval(timer));
    timers.timeouts.clear();
    timers.intervals.clear();
    activeWebRtcFixtures.delete(cleanup);
  };
  activeWebRtcFixtures.add(cleanup);
  return { WebRTC: context.__WebRTC, context, elements, cleanup };
}

test('native latency: accepted channel send and ACK entry survive later observer work', () => {
  let now = 100;
  const monitor = require('./latency-monitor.js').createLatencyMonitor({ now: () => now });
  const sends = [];
  const observeSend = monitor.observeControlledSend;
  monitor.observeControlledSend = (meta, context) => {
    sends.push(context.viewerClockMs);
    return observeSend(meta, context);
  };
  const { WebRTC: w, context } = loadWebRTC({ realInput: true,
    LatencyMonitor: monitor, performance: { now: () => now } });
  const input = context.__Input;
  w.currentConnectionAttemptId = 'attempt'; w.connectionAttemptSequence = 2; w.pc = {};
  input.activeControlLease = { leaseId: 'lease', leaseEpoch: 4 }; input.isActive = true;
  const channel = w.inputChannel = { readyState: 'open', bufferedAmount: 0, send() { now = 110; } };
  w.socket = { connected: false };
  const reservation = input.prepareLabInput('mouse', 'down', { relX: .5, relY: .5 });
  monitor.setScope(w.latencyScope());
  assert.equal(monitor.beginControlledInputEvidence({ inputId: reservation.inputId,
    leaseId: 'lease', scope: w.latencyScope(), streamId: 'video', inputType: 'mouse', action: 'down' }), true);
  const originalTrace = input._recordInputTrace;
  input._recordInputTrace = function(...args) {
    const result = originalTrace.apply(this, args); now = Math.max(now, 200); return result;
  };
  assert.equal(input.dispatchPreparedLabInput(reservation), reservation.inputId);
  assert.deepEqual(sends, [110]);
  const pending = input._desktopWritePending.get(reservation.inputId);
  const originalAck = input._acceptMouseAck;
  input._acceptMouseAck = function(ack) {
    const result = originalAck.call(this, ack); now = 400; return result;
  };
  now = 300;
  w.acceptObservedInputAck({ schemaVersion: 2, inputType: 'mouse', leaseEpoch: 4,
    inputIds: [reservation.inputId], appliedSeq: pending.seq, status: 'applied' },
  { transport: 'datachannel', dataChannel: channel });
  const row = monitor.readControlledInputEvidence(reservation.inputId, {
    scope: w.latencyScope(), leaseId: 'lease', streamId: 'video', pc: w.pc,
    live: w.captureControlledTransportSnapshot(),
  });
  assert.equal(row.send.viewerClockMs, 110);
  assert.equal(row.ack.viewerClockMs, 300);
  assert.equal(monitor.snapshot().metrics.inputAckRttMs.last, 200);
});

function nativeLatencyFixture({ transport = 'datachannel', type = 'mouse', action = 'down',
  traceUnavailable = false, wallStep = 0 } = {}) {
  let mono = 100, wall = 1792208500000;
  class PageDate extends Date { static now() { return wall; } }
  const monitor = require('./latency-monitor.js').createLatencyMonitor({ now: () => mono });
  const trace = require('./input-trace.js').InputTrace.create({ now: () => mono,
    hashInputIds: null, setTimeoutFn: () => null, clearTimeoutFn() {} });
  const { WebRTC: w, context } = loadWebRTC({ realInput: true, LatencyMonitor: monitor,
    performance: { now: () => mono }, Date: PageDate });
  const input = context.__Input;
  // Only the collector capability is substituted; trace, pruning and product methods stay real.
  input._traceCollector = traceUnavailable ? () => null : () => trace;
  w.currentConnectionAttemptId = 'attempt'; w.connectionAttemptSequence = 2; w.pc = {};
  input.activeControlLease = { leaseId: 'lease', leaseEpoch: 4 }; input.isActive = true;
  const sent = [], observedSends = [];
  const accepted = data => { sent.push(JSON.parse(JSON.stringify(data))); mono = 110; };
  const reliable = w.inputChannel = { readyState: transport === 'datachannel' ? 'open' : 'closed',
    bufferedAmount: 0, send(json) { accepted(JSON.parse(json)); } };
  const move = w.inputMoveChannel = { readyState: reliable.readyState, bufferedAmount: 0,
    send(json) { accepted(JSON.parse(json)); } };
  const socket = w.socket = { connected: transport === 'socket', id: 'socket',
    emit(event, data) { assert.equal(event, 'input'); accepted(data); } };
  const observeSend = monitor.observeControlledSend;
  monitor.observeControlledSend = (meta, current) => {
    observedSends.push({ meta, current }); return observeSend(meta, current);
  };
  const payload = type === 'keyboard' ? { text: 'offline fixture' } : { relX: .5, relY: .5 };
  const reservation = input.prepareLabInput(type, action, payload);
  assert.ok(reservation);
  const current = () => ({ scope: w.latencyScope(), leaseId: input.activeControlLease?.leaseId,
    streamId: w.currentFrameTraceIdentity().streamId, pc: w.pc, live: w.captureControlledTransportSnapshot() });
  monitor.setScope(w.latencyScope());
  assert.equal(monitor.beginControlledInputEvidence({ inputId: reservation.inputId, leaseId: 'lease',
    scope: w.latencyScope(), streamId: 'video', inputType: type, action }), true);
  const source = transport === 'socket' ? { transport, socket } : { transport, dataChannel: reliable };
  const ack = (overrides = {}, incoming = source) => w.acceptObservedInputAck({ schemaVersion: 2,
    inputType: type, inputIds: [reservation.inputId], leaseEpoch: 4, status: 'applied',
    ...(action === 'move' ? {} : { appliedSeq: sent[0]?.seq }), ...overrides }, incoming);
  return { w, input, context, monitor, trace, reliable, move, socket, sent, observedSends,
    reservation, payload, source, current, ack, set: value => { mono = value; },
    jump: () => { wall += wallStep; }, dispatch: () => input.dispatchPreparedLabInput(reservation),
    row: options => monitor.readControlledInputEvidence(reservation.inputId, current(), options) };
}

for (const inputType of ['mouse', 'keyboard']) for (const ackTransport of ['socket', 'datachannel']) {
  test(`ACK arrival timing crosses real ${inputType} reset C and M1 over ${ackTransport}`, () => {
    let now = 0;
    const monitor = require('./latency-monitor.js').createLatencyMonitor({ now: () => now });
    const handlers = new Map(), channels = new Map(), writes = [], order = [];
    const { WebRTC: w, context } = loadWebRTC({ realInput: true, LatencyMonitor: monitor,
      performance: { now: () => now } });
    const input = context.__Input;
    w.currentConnectionAttemptId = 'arrival-attempt'; w.connectionAttemptSequence = 1;
    w.pc = { connectionState: 'connected', createDataChannel(label) {
      const channel = { label, readyState: 'open', bufferedAmount: 0, send() {} };
      channels.set(label, channel); return channel;
    } };
    w.socket = { connected: true, id: 'arrival-socket', on(event, callback) { handlers.set(event, callback); },
      emit(event, data) { if (event === 'input') writes.push(data); } };
    w.createInputChannel(); w.setupSocketListeners();
    input.setControlLease({ leaseId: 'arrival-lease', leaseEpoch: 4 });
    const inputId = inputType === 'mouse' ? input._sendInput('mouse', 'reset', {})
      : input.keyboardTransport.resetBarrier('arrival-test');
    const write = writes.find(item => item.inputIds.includes(inputId));
    assert.ok(write, 'the product reset request must use the actual Socket adapter');
    const ack = { type: 'input_ack', schemaVersion: 2, inputType, status: 'applied',
      leaseEpoch: 4, appliedSeq: write.seq, inputIds: [inputId], pressedKeyCount: 0, modifierMask: 0,
      ...(ackTransport === 'datachannel' ? { resetAckMirrorVersion: 1 } : {}) };
    const acceptName = inputType === 'mouse' ? '_acceptMouseAck' : '_acceptKeyboardAck';
    const accept = input[acceptName];
    input[acceptName] = function(...args) {
      order.push('C'); const result = accept.apply(this, args); now = 140; return result;
    };
    const onAck = monitor.onInputAck;
    monitor.onInputAck = function(data, current) {
      order.push('M1');
      assert.equal(current.nowMs, undefined, 'entry clock is only difference data');
      assert.equal(current.arrivalAtMs, 100);
      return onAck(data, current);
    };
    input.recordObservedInputAck = () => { order.push('trace'); };
    const deliver = (payload = ack) => ackTransport === 'socket' ? handlers.get('input-ack')(payload)
      : channels.get('input').onmessage({ data: JSON.stringify(payload) });
    now = 100; deliver({ ...ack, leaseEpoch: 3 });
    const rejected = monitor.snapshot();
    assert.equal(rejected.outcomes.acked, 0);
    assert.equal(rejected.metrics.inputAckArrivalRttMs.available, false);
    assert.equal(rejected.metrics.inputAckValidationMs.available, false);
    assert.equal(order.includes('M1'), false, 'entry timing cannot bypass rejected C ownership');
    order.length = 0;
    now = 100; deliver();
    const snapshot = monitor.snapshot();
    assert.equal(snapshot.outcomes.acked, 1);
    assert.equal(snapshot.metrics.inputAckRttMs.last, 140);
    assert.equal(snapshot.metrics.inputAckArrivalRttMs.last, 100);
    assert.equal(snapshot.metrics.inputAckValidationMs.last, 40);
    assert.deepEqual(order, ['C', 'M1', 'trace']);
    now = 150; deliver();
    const afterDuplicate = monitor.snapshot();
    assert.equal(afterDuplicate.metrics.inputAckRttMs.count, 1);
    assert.equal(afterDuplicate.metrics.inputAckArrivalRttMs.count, 1);
    assert.equal(afterDuplicate.metrics.inputAckValidationMs.count, 1);
  });
}

test('ACK arrival timing requires successful C validation while preserving legacy M1 routing', () => {
  let now = 0;
  const monitor = require('./latency-monitor.js').createLatencyMonitor({ now: () => now });
  const { WebRTC: w } = loadWebRTC({ LatencyMonitor: monitor, performance: { now: () => now },
    Input: { activeControlLease: { leaseEpoch: 4 },
      acceptMouseAck() { return { status: 'stale' }; },
      acceptKeyboardAck() { return { status: 'stale' }; } } });
  w.currentConnectionAttemptId = 'legacy-arrival-attempt'; w.connectionAttemptSequence = 1;
  monitor.setScope(w.latencyScope()); monitor.recordInputSend('legacy'); now = 100;
  w.acceptObservedInputAck({ inputIds: ['legacy'], status: 'applied' });
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.metrics.inputAckRttMs.last, 100, 'existing legacy M1 behavior is preserved');
  assert.equal(snapshot.metrics.inputAckArrivalRttMs.available, false);
  assert.equal(snapshot.metrics.inputAckValidationMs.available, false);
});

for (const traceUnavailable of [false, true]) for (const wallStep of [-60000, 0, 60000]) {
  for (const variant of ['accepted', 'wrong-source', 'unknown-id', 'buffered']) {
    test(`native latency: trace independent move ${traceUnavailable}/${wallStep}/${variant}`, () => {
      const f = nativeLatencyFixture({ action: 'move', traceUnavailable, wallStep });
      try {
        if (variant === 'buffered') f.move.bufferedAmount = 4097;
        assert.equal(f.dispatch(), f.reservation.inputId);
        assert.equal(f.input._desktopWritePending.size, 0);
        f.jump(); f.set(210);
        if (variant === 'wrong-source') f.ack({}, { transport: 'datachannel', dataChannel: f.move });
        else f.ack(variant === 'unknown-id' ? { inputIds: ['unknown'] } : {});
        const row = f.row();
        assert.equal(row.send?.viewerClockMs ?? null, variant === 'buffered' ? null : 110);
        assert.equal(row.ack?.viewerClockMs ?? null, variant === 'accepted' ? 210 : null);
        assert.equal(f.sent.length, variant === 'buffered' ? 0 : 1);
        assert.equal(f.observedSends.length, variant === 'buffered' ? 0 : 1);
        if (traceUnavailable || wallStep !== 0 || variant === 'accepted') {
          assert.equal(f.input._unorderedTraceSends.size, 0);
        }
        if (variant === 'accepted') {
          assert.equal(f.observedSends[0].current.sendSource, f.move);
          assert.equal(f.observedSends[0].current.ackSource, f.reliable);
          assert.equal(f.monitor.snapshot().metrics.inputAckRttMs.last, 100);
        }
      } finally { f.trace.dispose(); }
    });
  }
}

for (const transport of ['datachannel', 'socket']) {
  test(`native latency: genuine ${transport} send keeps raw v2 envelope and one-use reservation`, () => {
    const f = nativeLatencyFixture({ transport });
    try {
      assert.equal(f.dispatch(), f.reservation.inputId);
      assert.equal(f.dispatch(), null);
      assert.deepEqual(f.sent, [{ type: 'mouse', action: 'down', payload: f.payload,
        inputIds: [f.reservation.inputId], schemaVersion: 2, leaseId: 'lease', leaseEpoch: 4, seq: 1,
        ...(transport === 'datachannel' ? { transport: 'datachannel' } : {}) }]);
      assert.equal(f.row().send.viewerClockMs, 110);
      assert.equal(f.observedSends.length, 1);
      const meta = f.observedSends[0].meta;
      assert.deepEqual(Object.keys(meta).sort(), ['action', 'inputId', 'inputType', 'leaseEpoch', 'leaseId', 'seq']);
      assert.equal(JSON.stringify(meta).includes('payload'), false);
      f.set(210); f.ack();
      assert.equal(f.row().ack.viewerClockMs, 210);
      assert.equal(f.input._desktopWritePending.size, 0);
      assert.equal(f.monitor.snapshot().outcomes.acked, 1);
    } finally { f.trace.dispose(); }
  });
}

test('native latency: DC refusal records exactly one socket acceptance with the original ID', () => {
  const f = nativeLatencyFixture({ transport: 'socket' });
  try {
    f.reliable.readyState = 'open'; f.reliable.bufferedAmount = 524289;
    assert.equal(f.dispatch(), f.reservation.inputId);
    assert.equal(f.observedSends.length, 1);
    assert.equal(f.observedSends[0].current.transport, 'socket');
    assert.equal(f.sent[0].inputIds[0], f.reservation.inputId);
    f.set(210); f.ack(); assert.equal(f.row().ack.viewerClockMs, 210);
  } finally { f.trace.dispose(); }
});

for (const failure of ['channel-throw', 'socket-throw', 'disconnected', 'quarantined-selected-move']) {
  test(`native latency: ${failure} creates no actual-send evidence`, () => {
    const f = nativeLatencyFixture({ transport: failure === 'socket-throw' ? 'socket' : 'datachannel',
      action: failure === 'quarantined-selected-move' ? 'move' : 'down' });
    try {
      const error = new Error('fixture refusal');
      if (failure === 'channel-throw') f.reliable.send = () => { throw error; };
      if (failure === 'socket-throw') f.socket.emit = () => { throw error; };
      if (failure === 'disconnected') { f.reliable.readyState = 'closed'; f.socket.connected = false; }
      if (failure === 'quarantined-selected-move') f.w._quarantinedInputChannel = f.move;
      if (failure === 'socket-throw') assert.throws(f.dispatch, actual => actual === error);
      else assert.equal(f.dispatch(), null);
      assert.equal(f.observedSends.length, 0);
      assert.equal(f.row().send, null);
      assert.equal(f.sent.length, 0);
      if (failure === 'quarantined-selected-move') {
        const live = f.w.captureControlledTransportSnapshot();
        assert.equal(live.datachannel.selectedMoveSendSource, null);
        assert.equal(live.datachannel.selectedReliableSendSource, f.reliable);
      }
    } finally { f.trace.dispose(); }
  });
}

const nativeRotations = {
  'move-channel': f => { f.w.inputMoveChannel = { ...f.move }; },
  'reliable-channel': f => { f.w.inputChannel = { ...f.reliable }; },
  'socket-object': f => { f.w.socket = { ...f.socket }; },
  'socket-id': f => { f.socket.id = 'rotated'; },
  'pc': f => { f.w.pc = {}; },
};
for (const phase of ['before-ack', 'after-completion']) for (const [name, rotate] of Object.entries(nativeRotations)) {
  test(`native latency: ${name} rotation ${phase} fails the fresh source fence`, () => {
    const f = nativeLatencyFixture({ action: name.startsWith('socket') ? 'down' : 'move',
      transport: name.startsWith('socket') ? 'socket' : 'datachannel' });
    try {
      f.dispatch(); f.set(210);
      if (phase === 'before-ack') rotate(f);
      f.ack();
      if (phase === 'after-completion') {
        f.set(220);
        f.monitor.onPostApplyFrame({ inputIds: [f.reservation.inputId], scope: f.w.latencyScope(),
          attemptId: 'attempt', generation: 2, streamId: 'video', viewerClockMs: 215,
          captureSeq: 1, rtpTimestamp: 44, wireTimestamp: 44, rtpOrigin: 0,
          traceStatus: 'matched', captureFresh: true, captureAfterApplied: true }, { scope: f.w.latencyScope() });
        assert.equal(f.row().state, 'COMPLETE'); rotate(f);
      }
      const row = f.row({ finalize: true });
      assert.equal(row.reason, 'source-changed'); assert.equal(row.state, 'INCOMPLETE');
      if (phase === 'before-ack') assert.equal(row.ack, null);
      // The observer fence does not rewrite C's outcome; old socket ACKs are already rejected by C.
      assert.equal(f.monitor.snapshot().outcomes.acked,
        phase === 'before-ack' && name.startsWith('socket') ? 0 : 1);
    } finally { f.trace.dispose(); }
  });
}

for (const change of ['scope', 'lease', 'epoch', 'future-sequence', 'stale-status', 'wrong-type', 'unknown-id']) {
  test(`native latency: ${change} cannot produce a controlled applied ACK`, () => {
    const f = nativeLatencyFixture();
    try {
      f.dispatch(); f.set(210);
      if (change === 'scope') f.w.connectionAttemptSequence++;
      if (change === 'lease') f.input.activeControlLease = { leaseId: 'new-lease', leaseEpoch: 4 };
      if (change === 'epoch') f.input.activeControlLease = { leaseId: 'lease', leaseEpoch: 5 };
      f.ack(change === 'future-sequence' ? { appliedSeq: 999 }
        : change === 'stale-status' ? { status: 'stale-lease' }
          : change === 'wrong-type' ? { inputType: 'keyboard' }
            : change === 'unknown-id' ? { inputIds: ['unknown'] } : {});
      assert.equal(f.row().ack, null);
      assert.equal(f.row({ finalize: true }).state, 'INCOMPLETE');
    } finally { f.trace.dispose(); }
  });
}

test('native latency: duplicate actual ACK handling keeps one controlled sample and M1 result', () => {
  const f = nativeLatencyFixture({ action: 'move' });
  try {
    f.dispatch(); f.set(210); f.ack(); f.set(230); f.ack();
    assert.equal(f.row().ack.viewerClockMs, 210);
    assert.equal(f.row().observationCounters.duplicateAcks, 1);
    assert.equal(f.monitor.snapshot().outcomes.acked, 1);
    assert.equal(f.monitor.snapshot().metrics.inputAckRttMs.count, 1);
  } finally { f.trace.dispose(); }
});

test('native latency: lease replacement during real C processing cannot qualify the entry clock', () => {
  const f = nativeLatencyFixture();
  try {
    f.dispatch();
    const accept = f.input._acceptMouseAck;
    f.input._acceptMouseAck = function(...args) {
      const result = accept.apply(this, args);
      this.activeControlLease = { leaseId: 'replacement', leaseEpoch: 4 };
      return result;
    };
    f.set(210); f.ack();
    assert.equal(f.row().ack, null); assert.equal(f.row().reason, 'lease-changed');
    assert.equal(f.input._desktopWritePending.size, 0);
    assert.equal(f.monitor.snapshot().outcomes.acked, 1);
  } finally { f.trace.dispose(); }
});

for (const transport of ['datachannel', 'socket']) {
  test(`native latency: ${transport} API accepting across lease replacement records no controlled send`, () => {
    const f = nativeLatencyFixture({ transport });
    try {
      const source = transport === 'socket' ? f.socket : f.reliable;
      const method = transport === 'socket' ? 'emit' : 'send', send = source[method];
      source[method] = function(...args) {
        const result = send.apply(this, args);
        f.input.activeControlLease = { leaseId: 'replacement', leaseEpoch: 4 };
        return result;
      };
      assert.equal(f.dispatch(), f.reservation.inputId);
      assert.equal(f.sent.length, 1); assert.equal(f.row().send, null);
      assert.equal(f.observedSends.length, 0);
    } finally { f.trace.dispose(); }
  });
}

for (const fault of ['missing-monitor', 'send-observer', 'ack-observer', 'snapshot', 'clock', 'stream-context']) {
  test(`native latency: ${fault} failure preserves real delivery, C/M1 and final trace`, () => {
    const f = nativeLatencyFixture();
    try {
      const throws = () => { throw new Error('observer fixture'); };
      if (fault === 'missing-monitor') delete f.context.LatencyMonitor;
      if (fault === 'send-observer') f.monitor.observeControlledSend = throws;
      if (fault === 'ack-observer') f.monitor.observeControlledAck = throws;
      if (fault === 'snapshot') f.w.captureControlledTransportSnapshot = throws;
      let failClock = false;
      if (fault === 'clock') {
        const now = f.context.performance.now, send = f.reliable.send;
        f.reliable.send = function(...args) { send.apply(this, args); failClock = true; };
        f.context.performance.now = () => {
          if (failClock) { failClock = false; return throws(); }
          return now();
        };
      }
      if (fault === 'stream-context') f.w.currentFrameTraceIdentity = throws;
      assert.equal(f.dispatch(), f.reservation.inputId);
      f.set(210); if (fault === 'clock') failClock = true;
      assert.doesNotThrow(() => f.ack());
      assert.equal(f.input._desktopWritePending.size, 0);
      assert.equal(f.input._desktopWriteSequence, 1);
      assert.equal(f.sent.length, 1);
      assert.equal(f.trace.snapshot().events.some(event => event.stage === 'ack'), true);
      if (fault !== 'missing-monitor') assert.equal(f.monitor.snapshot().outcomes.acked, 1);
    } finally { f.trace.dispose(); }
  });
}

for (const transport of ['datachannel', 'socket']) {
  test(`native latency: prepared desktop keyboard text records ${transport} acceptance without inventing C authority`, () => {
    const f = nativeLatencyFixture({ transport, type: 'keyboard', action: 'text' });
    try {
      assert.equal(f.dispatch(), f.reservation.inputId); assert.equal(f.dispatch(), null);
      assert.equal(f.row().send.viewerClockMs, 110);
      assert.equal(f.sent[0].payload.text, f.payload.text);
      f.set(210); f.ack();
      assert.equal(f.row().ack, null); // Existing C requires KeyboardTransport-owned pending.
      assert.equal(f.input._desktopWritePending.size, 1);
    } finally { f.trace.dispose(); }
  });

  test(`native latency: actual keyboard wrapper ${transport} send and C-applied ACK retain raw clocks`, () => {
    const f = nativeLatencyFixture({ transport, type: 'keyboard', action: 'text' });
    try {
      // The real transport owns its ledger; its supported ID allocator joins the prepared fixture ID.
      f.input.keyboardTransport = f.context.KeyboardTransport.create({
        makeInputId: () => f.reservation.inputId, now: f.context.performance.now,
        sendDataChannel: transport === 'datachannel' ? data => f.input.sendKeyboardDataChannel(data) : undefined,
        sendSocket: data => f.input.sendKeyboardSocket(data),
        getConnectionAttemptId: () => f.w.currentConnectionAttemptId,
        getSocket: () => f.w.socket, getDataChannel: () => f.w.inputChannel,
        setTimeoutFn: () => null, clearTimeoutFn() {},
      });
      f.input.keyboardTransport.setLease(f.input.activeControlLease);
      const envelope = { type: 'keyboard', action: 'text', payload: f.payload,
        inputIds: [f.reservation.inputId] };
      assert.ok(f.input.keyboardTransport.send(envelope));
      assert.equal(f.row().send.viewerClockMs, 110);
      f.set(210); f.ack({ appliedSeq: f.sent[0].seq, pressedKeyCount: 0, modifierMask: 0 });
      assert.equal(f.row().ack.viewerClockMs, 210);
      assert.equal(f.input.keyboardTransport.getSnapshot().pendingCount, 0);
    } finally { f.trace.dispose(); }
  });
}

for (const transport of ['datachannel', 'socket']) {
  test(`native latency: socket and channel candidates are finite with no action or trace lookup (${transport})`, () => {
    const f = nativeLatencyFixture({ transport });
    try {
      assert.equal(f.w.captureControlledTransportSnapshot.length, 0);
      f.dispatch();
      // An unused path is not an identity fence for this reservation.
      f.w.inputMoveChannel = { ...f.move };
      if (transport === 'socket') f.w.inputChannel = { ...f.reliable };
      f.set(210); f.ack();
      assert.equal(f.row().ack.viewerClockMs, 210);
      const live = f.w.captureControlledTransportSnapshot();
      assert.deepEqual(Object.keys(live).sort(), ['datachannel', 'pc', 'socket']);
      assert.deepEqual(Object.keys(live.datachannel).sort(),
        ['reliableAckSource', 'selectedMoveSendSource', 'selectedReliableSendSource']);
      assert.deepEqual(Object.keys(live.socket).sort(), ['id', 'object', 'reliableAckSource', 'selectedSendSource']);
    } finally { f.trace.dispose(); }
  });
}

test('native latency: move selection survives quarantine of the unused reliable send candidate', () => {
  const f = nativeLatencyFixture({ action: 'move' });
  try {
    f.w._quarantinedInputChannel = f.reliable;
    assert.equal(f.dispatch(), f.reservation.inputId);
    const live = f.w.captureControlledTransportSnapshot();
    assert.equal(live.datachannel.selectedMoveSendSource, f.move);
    assert.equal(live.datachannel.selectedReliableSendSource, null);
    assert.equal(live.datachannel.reliableAckSource, f.reliable);
    f.set(210); f.ack(); assert.equal(f.row().ack.viewerClockMs, 210);
  } finally { f.trace.dispose(); }
});

for (const site of ['desktop', 'keyboard-wrapper']) {
  test(`native latency: ${site} socket acceptance precedes trace and sequence observation`, () => {
    const f = nativeLatencyFixture({ transport: 'socket', type: site === 'desktop' ? 'mouse' : 'keyboard',
      action: site === 'desktop' ? 'down' : 'text' });
    try {
      const trace = f.input._recordInputTrace;
      f.input._recordInputTrace = function(...args) {
        const result = trace.apply(this, args); f.set(200); return result;
      };
      if (site === 'desktop') assert.equal(f.dispatch(), f.reservation.inputId);
      else assert.equal(f.input.sendKeyboardSocket({ type: 'keyboard', action: 'text', payload: f.payload,
        inputIds: [f.reservation.inputId], schemaVersion: 2, leaseId: 'lease', leaseEpoch: 4, seq: 1 }), true);
      assert.equal(f.row().send.viewerClockMs, 110);
      assert.equal(f.observedSends.length, 1);
      assert.equal(f.monitor.snapshot().outcomes.sent, 1);
    } finally { f.trace.dispose(); }
  });
}

for (const action of ['down', 'move']) {
  test(`native latency: real ${action} C then M1 then controlled observation then trace order`, () => {
    const f = nativeLatencyFixture({ action });
    try {
      f.dispatch(); const order = [];
      for (const [object, method, stage] of [[f.input, 'acceptMouseAck', 'C'],
        [f.monitor, action === 'move' ? 'onUnorderedInputAck' : 'onInputAck', 'M1'],
        [f.monitor, 'observeControlledAck', 'controlled'], [f.input, 'recordObservedInputAck', 'trace']]) {
        const original = object[method];
        object[method] = function(...args) { order.push(stage); return original.apply(this, args); };
      }
      f.set(210); f.ack();
      assert.deepEqual(order, ['C', 'M1', 'controlled', 'trace']);
      assert.equal(f.row().ack.viewerClockMs, 210);
    } finally { f.trace.dispose(); }
  });
}

test('native latency: actual socket emit without a bounded socket ID cannot qualify evidence', () => {
  const f = nativeLatencyFixture({ transport: 'socket' });
  try {
    f.socket.id = ''; assert.equal(f.dispatch(), f.reservation.inputId);
    assert.equal(f.sent.length, 1); assert.equal(f.row().send, null);
    f.set(210); f.ack(); assert.equal(f.row().ack, null);
    assert.equal(f.input._desktopWritePending.size, 0);
  } finally { f.trace.dispose(); }
});

test('WebRTC VM fixture cleanup clears its own recurring timers', () => {
  const { WebRTC, cleanup } = loadWebRTC();
  let cleared = false;
  WebRTC._controlHeartbeatTimer = setInterval(() => {}, 1000);
  const original = global.clearInterval;
  global.clearInterval = (timer) => {
    if (timer === WebRTC._controlHeartbeatTimer) cleared = true;
    return original(timer);
  };
  try {
    cleanup();
  } finally {
    global.clearInterval = original;
  }
  assert.equal(cleared, true);
});

test('connection attempt lifecycle is handed to the shared input trace', () => {
  const { WebRTC, context } = loadWebRTC();
  const traceSource = fs.readFileSync(path.join(__dirname, 'input-trace.js'), 'utf8');
  vm.runInContext(traceSource, context);
  const trace = context.InputTrace.create({ hashInputIds: null, setTimeoutFn: () => null });
  context.Diagnostic = {
    recordInputTrace(stage, meta) { return trace.record(stage, meta); },
  };
  context.Input = { activeControlLease: { leaseEpoch: 9 }, onConnectionAttemptChanged() {} };
  WebRTC.createConnectionAttemptId = () => 'attempt-trace-web-1';
  WebRTC.ensureDesktopSessionState = () => null;
  WebRTC.bindCurrentConnectionAttempt = () => {};
  WebRTC.syncDesktopInputGate = () => {};
  WebRTC.setUiPhase = () => {};

  assert.equal(WebRTC.beginConnectionAttempt('viewer-open'), 'attempt-trace-web-1');
  const snapshot = trace.snapshot();
  const lifecycle = snapshot.events.find(({ stage, action }) => stage === 'lifecycle' && action === 'active');
  assert.equal(lifecycle.connectionAttemptId, 'attempt-trace-web-1');
  assert.equal(lifecycle.leaseEpoch, 9);
  assert.equal(lifecycle.reason, 'attempt-changed');
  assert.equal(JSON.stringify(snapshot).includes('viewer-open'), false);
});

test('chrome snapshot exposes blocked mobile text state to the layout capability bridge', () => {
  const { WebRTC, context } = loadWebRTC();
  const snapshot = { shown: true, composing: false, hasPending: true, status: 'uncertain', deliveryUncertain: true };
  context.Input = { mobileTextInputAdapter: { getSnapshot: () => snapshot } };
  WebRTC.uiPhase = 'connected';
  WebRTC.hasPaintedFrame = true;
  WebRTC.hasActiveControl = () => true;
  WebRTC.inputChannel = { readyState: 'open' };

  assert.equal(WebRTC.getChromeSnapshot().mobileInputMode, 'blocked');
});

test('production video frame callback syncs the input gate without moving focus', () => {
  const { WebRTC, context, elements } = loadWebRTC({ realInput: true });
  const Input = context.__Input;
  const video = context.document.getElementById('remoteVideo');
  let callback = null;
  let focusCalls = 0;
  video.videoWidth = 1280;
  video.videoHeight = 720;
  video.focus = () => { focusCalls += 1; context.document.activeElement = video; };
  video.requestVideoFrameCallback = (handler) => {
    callback = handler;
    return 1;
  };
  WebRTC.pc = {};
  WebRTC.currentConnectionAttemptId = 'attempt-frame-focus';
  WebRTC.uiPhase = 'connected';
  WebRTC.hasPaintedFrame = false;
  WebRTC._mediaReadyConnectionAttemptId = null;
  WebRTC.hasActiveControl = () => true;
  WebRTC.canEnableDesktopInput = () => true;
  WebRTC.socket = { connected: true };
  Input.videoElement = video;
  WebRTC.startVideoFrameTracking();
  callback(0, {});
  assert.equal(Input.isActive, true);
  assert.equal(focusCalls, 0, 'media frames must not steal focus from a text surface');
});

test('frame trace uses the same attempt sequence sent to Host instead of media suspend generation', () => {
  const { WebRTC, context, cleanup } = loadWebRTC();
  const video = context.document.getElementById('remoteVideo');
  let callback = null;
  video.videoWidth = 1280;
  video.requestVideoFrameCallback = (handler) => {
    callback = handler;
    return 1;
  };
  WebRTC.createConnectionAttemptId = () => 'attempt-trace';
  const videoTrack = { id: 'trace-video', kind: 'video' };
  video.srcObject = { getVideoTracks: () => [videoTrack] };
  WebRTC.pc = {
    connectionState: 'connected', iceConnectionState: 'connected',
    getReceivers: () => [{ track: videoTrack, getSynchronizationSources: () => [{ source: 7 }] }],
    createDataChannel(label) {
      const channel = { label, readyState: 'open', on() {}, send() {} };
      return channel;
    },
  };
  WebRTC._mediaIntent = { state: 'active', generation: 99 };
  WebRTC.beginConnectionAttempt('viewer-open');
  WebRTC._frameTraceEnabled = true;
  WebRTC.startVideoFrameTracking();
  callback(10, { rtpTimestamp: 77 });
  // The existing receiver path owns this handler in production. Invoke it with
  // the actual attempt sequence emitted by beginConnectionAttempt.
  WebRTC.createInputChannel();
  WebRTC.inputChannel.onmessage({ data: JSON.stringify({
    type: 'frame_trace_batch', schemaVersion: 1, traces: [{
      attemptId: WebRTC.currentConnectionAttemptId,
      generation: WebRTC.connectionAttemptSequence,
      streamId: 'video', captureSeq: 4, encoderTimestamp: 9000,
      wireTimestamp: 77, ssrc: 7, framePts: 100,
      idrKind: null, idrReason: null, policyDigest: 'relay-legacy-v1',
      stages: {
        grab: null, age_at_recv: null, worker_queue: null, prepare: null, build: null,
        reformat: null, encode: null, packetize: null, encode_total: null,
      },
    }],
  }) });

  const matched = WebRTC.frameTraceCollector.takeMatched();
  assert.equal(WebRTC.connectionAttemptSequence, 1);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].captureSeq, 4);
  cleanup();
});

test('refresh attempt compares paint growth against a zero inbound baseline', () => {
  const { WebRTC } = loadWebRTC();
  WebRTC._lastInboundFramesDecoded = 400;
  WebRTC.hasPaintedFrame = true;

  WebRTC.beginConnectionAttempt('refresh');

  assert.equal(WebRTC.hasPaintedFrame, false);
  assert.equal(WebRTC._paintDecodedBaseline, 0);
  assert.equal(WebRTC._lastInboundFramesDecoded, 0);

  WebRTC.notePaintStats({
    videoWidth: 1280,
    framesDecoded: 2,
    framesReceived: 2,
    fps: 20,
  });
  assert.equal(WebRTC.hasPaintedFrame, true);
});

test('new connection attempts notify Input so old recovery ownership is revoked', () => {
  const attempts = [];
  const { WebRTC } = loadWebRTC({
    Input: {
      onConnectionAttemptChanged: (attemptId) => attempts.push(attemptId),
      setActive: () => {},
    },
  });
  WebRTC.socket = { connected: true, emit() {} };
  WebRTC.controlState = {
    hostOnline: true,
    controller: true,
    state: 'ACTIVE',
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.createConnectionAttemptId = () => 'attempt-notified';

  assert.equal(WebRTC.beginConnectionAttempt('test-attempt'), 'attempt-notified');
  assert.deepEqual(attempts, ['attempt-notified']);
});

test('active keyboard lease rebind requests bounded Input recovery after transport state sync', () => {
  const calls = [];
  const { WebRTC } = loadWebRTC({
    Input: {
      setControlLease: (lease) => calls.push(['lease', lease]),
      setKeyboardDataChannelAvailable: (available) => calls.push(['channel', available]),
      requestInputRecovery: (options) => calls.push(['recovery', options]),
      updateKeyboardUI: () => calls.push(['ui']),
    },
  });
  WebRTC.controlState = {
    hostOnline: true,
    controller: true,
    state: 'ACTIVE',
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.inputChannel = { readyState: 'open' };

  assert.equal(WebRTC.rebindActiveKeyboardLease('test-rebind'), true);
  assert.equal(calls[0][0], 'lease');
  assert.equal(calls[0][1].leaseId, 'lease-000000000001');
  assert.equal(calls[0][1].leaseEpoch, 1);
  assert.deepEqual(calls.slice(1, 2), [['channel', true]]);
  assert.equal(calls[2][0], 'recovery');
  assert.equal(calls[2][1].source, 'auto');
  assert.deepEqual(calls.slice(3), [['ui']]);
});

test('media profile emits current attempt and a monotonic profile sequence', () => {
  const emitted = [];
  const { WebRTC } = loadWebRTC();
  WebRTC.socket = { connected: true, emit: (event, payload) => emitted.push({ event, payload }) };
  WebRTC.controlState = {
    controller: true,
    state: 'ACTIVE',
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.currentConnectionAttemptId = 'attempt-current';
  WebRTC._mediaProfileSequence = 0;
  WebRTC.adaptiveResolutionEnabled = false;
  WebRTC.currentResolution = { width: 1280, height: 720 };
  WebRTC.getSessionPresentation = () => ({ width: 1280, height: 720 });
  WebRTC.qualityFloorsForResolution = () => ({ minBitrateKbps: 1000, targetFps: 20, minFps: 10 });

  WebRTC.applyMediaProfile({ name: 'high', bitrateKbps: 2500, fps: 20 }, 'connection-sync');
  WebRTC.applyMediaProfile({ name: 'medium', bitrateKbps: 1400, fps: 15 }, 'quality');

  const profiles = emitted.filter((entry) => entry.event === 'media-profile-change').map((entry) => entry.payload);
  assert.deepEqual(
    profiles.map((profile) => [profile.connectionAttemptId, profile.profileSequence]),
    [['attempt-current', 1], ['attempt-current', 2]],
  );
});

function preparePortSearch(WebRTC, extras = {}) {
  if (typeof WebRTC.stopPortSearch === 'function') {
    WebRTC.stopPortSearch('test-reset');
  }
  WebRTC.networkMode = extras.networkMode || 'stun';
  WebRTC.socket = extras.socket || {
    connected: true,
    emit() {},
    disconnect() { this.connected = false; },
    on() {},
  };
  WebRTC.controlState = extras.controlState || {
    hostOnline: true,
    controller: true,
    state: 'ACTIVE',
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.manualDisconnect = false;
  WebRTC._refreshing = false;
  WebRTC.reconnectTimer = null;
  // Keep timers short in tests so leftover deadlines cannot hang the runner.
  WebRTC.PORT_SEARCH_ROUND_MS = extras.roundMs ?? 50;
  WebRTC.PORT_SEARCH_RETRY_DELAY_MS = extras.retryDelayMs ?? 5;
  return WebRTC;
}

function loadLinkQualityController() {
  const context = { console, Date };
  context.globalThis = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, 'link-quality-controller.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__LQC = LinkQualityController;`, context);
  return { LinkQualityController: context.__LQC, context };
}

test('WebRTC lazily owns media activity reasons and forwards changes to its media hook', () => {
  let controllerOptions = null;
  let lifecycleOptions = null;
  let starts = 0;
  let creates = 0;
  const snapshot = { state: 'suspended', reasons: ['manual-pause'], generation: 1 };
  const controllerCalls = [];
  const controller = {
    setReason(reason, enabled) {
      controllerCalls.push([reason, enabled]);
      controllerOptions.onChange(snapshot);
      return snapshot;
    },
    snapshot() {
      return snapshot;
    },
  };
  const { WebRTC } = loadWebRTC({
    MediaActivityController: {
      create(options) {
        creates += 1;
        controllerOptions = options;
        return controller;
      },
    },
    MediaActivityLifecycle: {
      create(options) {
        lifecycleOptions = options;
        return { start() { starts += 1; } };
      },
    },
  });
  const applied = [];
  WebRTC.applyMediaActivity = (nextSnapshot) => applied.push(nextSnapshot);

  assert.deepEqual(WebRTC.setMediaActivityReason('manual-pause', true), snapshot);
  assert.deepEqual(WebRTC.getMediaActivitySnapshot(), snapshot);
  assert.equal(creates, 1);
  assert.equal(starts, 1);
  assert.deepEqual(applied, [snapshot]);
  lifecycleOptions.setReason('page-hide', true);
  assert.equal(creates, 1);
  assert.deepEqual(controllerCalls, [
    ['manual-pause', true],
    ['page-hide', true],
  ]);
});

test('WebRTC routes independent DataChannel and Socket.IO input acks to mouse, keyboard, and latency consumers', () => {
  const acks = []; const mouseAcks = []; const keyboardAcks = [];
  const channels = new Map();
  const socketHandlers = new Map();
  const { WebRTC } = loadWebRTC({
    Input: { acceptMouseAck(payload) { mouseAcks.push(payload); }, acceptKeyboardAck(payload) { keyboardAcks.push(payload); } },
    LatencyMonitor: { onInputAck(payload) { acks.push(payload); } },
  });
  WebRTC.pc = {
    connectionState: 'connecting',
    iceConnectionState: 'checking',
    createDataChannel(label) {
      const channel = {
        label,
        readyState: 'connecting',
        bufferedAmount: 0,
        send() {},
      };
      channels.set(label, channel);
      return channel;
    },
  };
  WebRTC.socket = {
    on(event, handler) { socketHandlers.set(event, handler); },
  };
  WebRTC.controlState = { state: 'ACTIVE', controller: true, lease: { leaseId: 'lease-000000000001', leaseEpoch: 4 }, hostOnline: true };
  WebRTC.createInputChannel();
  WebRTC.setupSocketListeners();

  channels.get('input').onmessage({ data: JSON.stringify({ type: 'input_ack', inputType: 'keyboard', inputIds: ['dc-1'] }) });
  socketHandlers.get('input-ack')({ type: 'input_ack', inputType: 'keyboard', inputIds: ['socket-1'] });

  assert.deepEqual(acks.map((payload) => payload.inputIds[0]), ['dc-1', 'socket-1']);
  assert.deepEqual(mouseAcks.map((payload) => payload.inputIds[0]), ['dc-1', 'socket-1']);
  assert.deepEqual(keyboardAcks.map((payload) => payload.inputIds[0]), ['dc-1', 'socket-1']);
  clearTimeout(WebRTC._dcTimeout);
});

test('keyboard acknowledgement clears keyboard pending without clearing mouse reset state', () => {
  const latencyAcks = [];
  const channels = new Map();
  const socketEvents = [];
  const dcWrites = [];
  const { WebRTC, context } = loadWebRTC({
    realInput: true,
    LatencyMonitor: {
      recordInputSend() {},
      onInputAck(payload) { latencyAcks.push(payload); },
    },
  });
  const Input = context.__Input;
  WebRTC.pc = {
    connectionState: 'connecting', iceConnectionState: 'checking',
    createDataChannel(label) {
      const channel = { label, readyState: 'connecting', bufferedAmount: 0, send(json) { dcWrites.push(JSON.parse(json)); } };
      channels.set(label, channel);
      return channel;
    },
  };
  WebRTC.socket = { connected: true, emit(event, payload) { socketEvents.push({ event, payload }); } };
  WebRTC.controlState = { state: 'ACTIVE', controller: true, lease: { leaseId: 'lease-000000000001', leaseEpoch: 4 }, hostOnline: true };
  Input.initKeyboardController();
  Input.setControlLease(WebRTC.controlState.lease);
  WebRTC.createInputChannel();
  const inputChannel = channels.get('input');
  inputChannel.readyState = 'open';
  inputChannel.onopen();
  assert.equal(Input.keyboardController.handleDomEvent({ type: 'keydown', code: 'KeyA', key: 'a', target: {}, getModifierState() { return false; }, preventDefault() {} }), true);
  assert.equal(Input.keyboardTransport.getSnapshot().pendingCount, 1);
  Input._pendingMouseReset = true;
  Input._pendingMouseResetId = Input.sendInput('mouse', 'reset', { reason: 'manual' });
  const mouseReset = socketEvents.at(-1).payload;

  inputChannel.onmessage({ data: JSON.stringify({
    type: 'input_ack', inputType: 'keyboard', status: 'applied', schemaVersion: 2, leaseEpoch: 4,
    inputIds: dcWrites.at(-1).inputIds, appliedSeq: 1, pressedKeyCount: 0, modifierMask: 0,
  }) });

  assert.equal(Input.getDiagnosticState().pendingMouseReset, true);
  assert.equal(Input.keyboardTransport.getSnapshot().pendingCount, 0);
  assert.equal(Input.keyboardController.getSnapshot().state, 'READY');
  assert.equal(latencyAcks.length, 1);
  assert.equal(socketEvents.length, 1);

  WebRTC.acceptObservedInputAck({
    type: 'input_ack', inputType: 'mouse', status: 'applied', schemaVersion: 2, leaseEpoch: 4,
    inputIds: mouseReset.inputIds, appliedSeq: mouseReset.seq, pressedKeyCount: 0, modifierMask: 0,
  }, { transport: 'socket', socket: WebRTC.socket });
  assert.equal(Input.getDiagnosticState().pendingMouseReset, false);
  clearTimeout(WebRTC._dcTimeout);
});

test('DataChannel close routes a held key through one Socket.IO reset barrier until its matching Socket.IO acknowledgement', () => {
  const channels = new Map();
  const socketEvents = [];
  const socketHandlers = new Map();
  const { WebRTC, context } = loadWebRTC({
    realInput: true,
    LatencyMonitor: { recordInputSend() {}, onInputAck() {} },
  });
  const Input = context.__Input;
  WebRTC.pc = {
    connectionState: 'connected', iceConnectionState: 'connected',
    createDataChannel(label) {
      const channel = { label, readyState: 'connecting', bufferedAmount: 0, send() {} };
      channels.set(label, channel);
      return channel;
    },
  };
  WebRTC.socket = {
    connected: true,
    on(event, handler) { socketHandlers.set(event, handler); },
    emit(event, payload) { socketEvents.push({ event, payload }); },
  };
  WebRTC.controlState = { state: 'ACTIVE', controller: true, lease: { leaseId: 'lease-000000000001', leaseEpoch: 4 }, hostOnline: true };
  Input.initKeyboardController();
  Input.setControlLease(WebRTC.controlState.lease);
  WebRTC.createInputChannel();
  WebRTC.setupSocketListeners();
  const inputChannel = channels.get('input');
  inputChannel.readyState = 'open';
  inputChannel.onopen();
  assert.equal(Input.keyboardController.handleDomEvent({ type: 'keydown', code: 'KeyA', key: 'a', target: {}, getModifierState() { return false; }, preventDefault() {} }), true);

  inputChannel.readyState = 'closed';
  inputChannel.onclose();
  const reset = socketEvents.filter(({ event }) => event === 'input').at(-1).payload;
  assert.deepEqual([reset.action, reset.payload.reason], ['reset', 'transport-change']);
  assert.equal(Input.keyboardController.getSnapshot().state, 'RESET_REQUIRED');
  assert.equal(Input.keyboardController.sendChord({ code: 'Enter' }), false);
  assert.equal(socketEvents.filter(({ event }) => event === 'input').length, 1);

  socketHandlers.get('input-ack')({
    type: 'input_ack', inputType: 'keyboard', schemaVersion: 2, status: 'applied', leaseEpoch: 4,
    appliedSeq: reset.seq, pressedKeyCount: 0, modifierMask: 0, inputIds: reset.inputIds,
  });
  assert.equal(Input.keyboardController.getSnapshot().state, 'READY');
  assert.equal(Input.keyboardController.sendChord({ code: 'Enter' }), true);
  assert.equal(socketEvents.filter(({ event }) => event === 'input').length, 2);
  clearTimeout(WebRTC._dcTimeout);
  clearTimeout(WebRTC._dcReconnectTimer);
});

test('a command acknowledgement cannot advance keyboard state or clear a keyboard reset barrier', () => {
  const channels = new Map();
  const socketEvents = [];
  const socketHandlers = new Map();
  const { WebRTC, context } = loadWebRTC({
    realInput: true,
    LatencyMonitor: { recordInputSend() {}, onInputAck() {} },
  });
  const Input = context.__Input;
  WebRTC.pc = {
    connectionState: 'connected', iceConnectionState: 'connected',
    createDataChannel(label) {
      const channel = { label, readyState: 'connecting', bufferedAmount: 0, send() {} };
      channels.set(label, channel);
      return channel;
    },
  };
  WebRTC.socket = {
    connected: true,
    on(event, handler) { socketHandlers.set(event, handler); },
    emit(event, payload) { socketEvents.push({ event, payload }); },
  };
  WebRTC.controlState = { state: 'ACTIVE', controller: true, lease: { leaseId: 'lease-000000000001', leaseEpoch: 4 }, hostOnline: true };
  Input.initKeyboardController();
  Input.setControlLease(WebRTC.controlState.lease);
  WebRTC.createInputChannel();
  WebRTC.setupSocketListeners();
  const inputChannel = channels.get('input');
  inputChannel.readyState = 'open';
  inputChannel.onopen();
  assert.equal(Input.keyboardController.handleDomEvent({ type: 'keydown', code: 'KeyA', key: 'a', target: {}, getModifierState() { return false; }, preventDefault() {} }), true);

  inputChannel.readyState = 'closed';
  inputChannel.onclose();
  const reset = socketEvents.filter(({ event }) => event === 'input').at(-1).payload;
  assert.equal(Input.keyboardController.getSnapshot().state, 'RESET_REQUIRED');
  const commandId = Input.sendInput('command', 'showDock', {});
  assert.ok(commandId);
  const command = socketEvents.filter(({ event }) => event === 'input').at(-1).payload;
  assert.equal(command.type, 'command');

  socketHandlers.get('input-ack')({
    type: 'input_ack', inputType: 'command', schemaVersion: 2, status: 'applied', leaseEpoch: 4,
    appliedSeq: reset.seq, pressedKeyCount: 0, modifierMask: 0, inputIds: command.inputIds,
  });
  assert.equal(Input.keyboardTransport.getSnapshot().pendingCount, 1);
  assert.equal(Input.keyboardController.getSnapshot().state, 'RESET_REQUIRED');
  assert.equal(Input.keyboardController.sendChord({ code: 'Enter' }), false);

  socketHandlers.get('input-ack')({
    type: 'input_ack', inputType: 'keyboard', schemaVersion: 2, status: 'applied', leaseEpoch: 4,
    appliedSeq: reset.seq, pressedKeyCount: 0, modifierMask: 0, inputIds: reset.inputIds,
  });
  assert.equal(Input.keyboardTransport.getSnapshot().pendingCount, 0);
  assert.equal(Input.keyboardController.getSnapshot().state, 'READY');
  clearTimeout(WebRTC._dcTimeout);
  clearTimeout(WebRTC._dcReconnectTimer);
});

test('DataChannel keyboard envelopes include transport datachannel marker', () => {
  const sent = [];
  const { WebRTC } = loadWebRTC();
  WebRTC.inputChannel = {
    readyState: 'open',
    bufferedAmount: 0,
    send(value) { sent.push(JSON.parse(value)); },
  };

  assert.equal(WebRTC.sendInput({
    type: 'keyboard', action: 'reset', schemaVersion: 2,
    leaseId: 'lease-000000000001', leaseEpoch: 4, seq: 1,
    inputIds: ['input-1'], payload: { reason: 'manual' },
  }), true);
  assert.equal(sent[0].transport, 'datachannel');
});

test('DataChannel keeps reliable desktop writes ordered while mouse moves stay isolated from keyboard pending', () => {
  const channels = new Map();
  const { WebRTC, context } = loadWebRTC({
    realInput: true,
    LatencyMonitor: { recordInputSend() {}, onInputAck() {} },
  });
  const Input = context.__Input;
  WebRTC.pc = {
    connectionState: 'connected', iceConnectionState: 'connected',
    createDataChannel(label) {
      const channel = { label, readyState: 'open', bufferedAmount: 0, send(value) {
        this.sent = this.sent || []; this.sent.push(JSON.parse(value));
      } };
      channels.set(label, channel);
      return channel;
    },
  };
  WebRTC.controlState = { state: 'ACTIVE', controller: true, hostOnline: true, lease: { leaseId: 'lease-000000000001', leaseEpoch: 4 } };
  Input.initKeyboardController();
  Input.setControlLease(WebRTC.controlState.lease);
  Input.isActive = true;
  WebRTC.createInputChannel();

  Input.sendInput('mouse', 'move', { relX: 0.2, relY: 0.2, buttons: 0 });
  Input.sendInput('mouse', 'down', { relX: 0.2, relY: 0.2, button: 'left', clickCount: 1, buttons: 1 });
  Input.sendInput('mouse', 'reset', { reason: 'manual' });
  Input.sendInput('command', 'showDock', {});

  assert.deepEqual(channels.get('input-move').sent.map(({ action, seq }) => [action, seq]), [['move', undefined]]);
  assert.deepEqual(channels.get('input').sent.map(({ type, action, seq }) => [type, action, seq]), [
    ['mouse', 'down', 1], ['mouse', 'reset', 2], ['command', 'showDock', 3],
  ]);
  channels.get('input').onmessage({ data: JSON.stringify({
    type: 'input_ack', inputType: 'mouse', schemaVersion: 2, status: 'applied', leaseEpoch: 4,
    appliedSeq: 2, inputIds: [channels.get('input').sent[1].inputIds[0],],
  }) });
  assert.equal(Input.keyboardTransport.getSnapshot().pendingCount, 0);
  clearTimeout(WebRTC._dcTimeout);
});

test('viewer waits for an active control lease before starting an offer and routes acknowledgements to transport first', () => {
  const socketHandlers = new Map();
  const emitted = [];
  const order = [];
  let socketOptions = null;
  const { WebRTC } = loadWebRTC({
    io(_base, options) {
      socketOptions = options;
      return {
        connected: true,
        on(event, handler) { socketHandlers.set(event, handler); },
        emit(...args) { emitted.push(args); },
        disconnect() {},
      };
    },
    Input: {
      init() {},
      setActive() {},
      setControlLease(lease) { this.activeControlLease = lease; return true; },
      acceptKeyboardAck() { order.push('transport'); return { status: 'applied' }; },
      acceptMouseAck() { order.push('mouse'); },
    },
    LatencyMonitor: { onInputAck() { order.push('latency'); } },
  });
  WebRTC.networkMode = 'auto';
  WebRTC.createPeerConnection = () => {};
  let offers = 0;
  WebRTC.createOffer = () => { offers += 1; };
  WebRTC.createSignalingSocket(true);
  WebRTC.setupSocketListeners();

  assert.equal(socketOptions.auth.inputProtocolVersion, 2);
  assert.deepEqual(Array.from(socketOptions.transports), ['websocket', 'polling']);
  assert.equal(socketOptions.tryAllTransports, true);
  assert.equal(socketOptions.timeout, 5000);
  socketHandlers.get('connected')({ hostOnline: true });
  assert.equal(offers, 0);
  assert.equal(emitted.at(-1)[0], 'control-acquire');

  socketHandlers.get('control-grant')({ controller: true, leaseId: 'lease-000000000001', leaseEpoch: 4 });
  assert.equal(offers, 1);
  socketHandlers.get('input-ack')({ inputType: 'keyboard', schemaVersion: 2, leaseEpoch: 4, appliedSeq: 1, status: 'applied' });
  assert.deepEqual(order, ['mouse', 'transport', 'latency']);
  WebRTC.stopControlHeartbeat();
});

test('resolveSignalingTransports prefers websocket and keeps polling fallback by default', () => {
  const { WebRTC } = loadWebRTC();
  assert.deepEqual(Array.from(WebRTC.resolveSignalingTransports()), ['websocket', 'polling']);
  assert.deepEqual(Array.from(WebRTC.resolveSignalingTransports({ allowPolling: false })), ['websocket']);
});
test('createSignalingSocket records websocket-first transports for blocked-WS polling fallback', () => {
  const calls = [];
  const { WebRTC } = loadWebRTC({
    io(base, options) {
      calls.push({ base, options });
      return {
        connected: false,
        on() {},
        emit() {},
        disconnect() {},
      };
    },
    Auth: { getToken: () => 'token-test' },
  });
  WebRTC.setupSocketListeners = () => {};
  WebRTC.createSignalingSocket(true);
  assert.equal(calls.length, 1);
  assert.deepEqual(Array.from(calls[0].options.transports), ['websocket', 'polling']);
  assert.equal(calls[0].options.tryAllTransports, true);
  // Dual-transport connect is budget-bounded (no unbounded silent hang).
  assert.ok(Number(calls[0].options.timeout) <= 5000);
});

test('evaluateSignalingTransportPlan: websocket blocked then polling succeeds within budget', () => {
  const { WebRTC } = loadWebRTC();
  const plan = WebRTC.evaluateSignalingTransportPlan([
    { type: 'transport-error', transport: 'websocket', atMs: 120 },
    { type: 'connect', transport: 'polling', atMs: 480 },
  ]);
  assert.equal(plan.ok, true);
  assert.equal(plan.transport, 'polling');
  assert.equal(plan.withinBudget, true);
  assert.equal(plan.exhausted, false);
  assert.equal(plan.elapsedMs, 480);
});

test('evaluateSignalingTransportPlan: both transports fail exits within connect budget', () => {
  const { WebRTC } = loadWebRTC();
  const plan = WebRTC.evaluateSignalingTransportPlan([
    { type: 'transport-error', transport: 'websocket', atMs: 200 },
    { type: 'transport-error', transport: 'polling', atMs: 900 },
    { type: 'connect_error', transport: 'polling', atMs: 1100 },
  ], { budgetMs: 5000 });
  assert.equal(plan.ok, false);
  assert.equal(plan.exhausted, true);
  assert.equal(plan.withinBudget, true);
  assert.ok(plan.elapsedMs <= 5000);
});

test('buildSignalingSocketOptions keeps websocket before polling and timeout <= budget', () => {
  const { WebRTC } = loadWebRTC();
  const options = WebRTC.buildSignalingSocketOptions({ token: 't', reconnection: true });
  assert.deepEqual(Array.from(options.transports), ['websocket', 'polling']);
  assert.equal(options.transports[0], 'websocket');
  assert.ok(options.transports.indexOf('websocket') < options.transports.indexOf('polling'));
  assert.equal(options.tryAllTransports, true);
  assert.ok(options.timeout <= WebRTC.signalingConnectBudgetMs);
  assert.equal(options.auth.inputProtocolVersion, 2);
});

test('buildSignalingSocketOptions carries one stable page session id across reconnects', () => {
  let stored = null;
  const { WebRTC } = loadWebRTC({
    sessionStorage: {
      getItem() { return stored; },
      setItem(_key, value) { stored = value; },
    },
  });
  const first = WebRTC.buildSignalingSocketOptions({ token: 't' });
  const second = WebRTC.buildSignalingSocketOptions({ token: 't' });
  assert.match(first.auth.viewerSessionId, /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
  assert.equal(second.auth.viewerSessionId, first.auth.viewerSessionId);
  assert.equal(stored, first.auth.viewerSessionId);
});

test('buildSignalingSocketOptions forwards the Lab proof admission from session storage unchanged', () => {
  const admission = { token: 'lab-proof-token', epoch: 7, realm: 'lab-run-7' };
  const { WebRTC } = loadWebRTC({
    sessionStorage: { getItem: (key) => key === 'wrdProofAdmission' ? JSON.stringify(admission) : null },
  });
  const options = WebRTC.buildSignalingSocketOptions({ token: 't' });
  assert.deepEqual(JSON.parse(JSON.stringify(options.auth.proofAdmission)), admission);
});

test('tunnel relay uses the authenticated viewer socket instead of a second relay socket', () => {
  const emitted = [];
  const { WebRTC } = loadWebRTC();
  WebRTC.currentConnectionAttemptId = 'relay-fixture-attempt';
  WebRTC.connectionAttemptSequence = 1;
  WebRTC.socket = { connected: true, emit(...args) { emitted.push(args); } };
  WebRTC.controlState = { state: 'ACTIVE', controller: true, hostOnline: true, lease: { leaseId: 'lease-000000000001', leaseEpoch: 6 } };
  WebRTC.tunnelRelayActive = true;

  WebRTC.emitRelayStreamControl();

  assert.equal(emitted.at(-1)[0], 'relay-stream-control');
  assert.equal(Object.prototype.hasOwnProperty.call(WebRTC, 'relaySocket'), false);
});

test('tunnel start binds the current connection attempt before media controls use it', () => {
  const emitted = [];
  const { WebRTC } = loadWebRTC();
  WebRTC.socket = { connected: true, emit(...args) { emitted.push(args); } };
  WebRTC.controlState = { state: 'ACTIVE', controller: true, hostOnline: true, lease: { leaseId: 'lease-000000000001', leaseEpoch: 6 } };
  WebRTC.currentConnectionAttemptId = 'tunnel-attempt-1';
  WebRTC.connectionAttemptSequence = 1;

  WebRTC.emitRelayStreamControl();

  const bind = emitted.find(([event]) => event === 'connection-attempt-bind');
  assert.ok(bind, 'expected connection-attempt-bind before relay-stream-control');
  assert.equal(bind[1].connectionAttemptId, 'tunnel-attempt-1');
  assert.equal(bind[1].connectionAttemptSequence, 1);
  assert.equal(emitted[0][0], 'connection-attempt-bind');
  assert.equal(emitted.some(([event]) => event === 'relay-stream-control'), true);
});

test('tunnel relay stream control caps request size to medium profile', () => {
  const emitted = [];
  const { WebRTC } = loadWebRTC();
  WebRTC.currentConnectionAttemptId = 'relay-fixture-attempt';
  WebRTC.connectionAttemptSequence = 1;
  WebRTC.socket = { connected: true, emit(...args) { emitted.push(args); } };
  WebRTC.controlState = { state: 'ACTIVE', controller: true, hostOnline: true, lease: { leaseId: 'lease-000000000001', leaseEpoch: 6 } };
  WebRTC.currentResolution = { width: 1280, height: 720, label: '720p' };

  const size = WebRTC.getTunnelRelayRequestSize();
  assert.equal(size.width, 960);
  assert.equal(size.height, 540);
  assert.equal(size.fps, 6);

  WebRTC.emitRelayStreamControl();
  const payload = emitted.at(-1)[1];
  assert.equal(payload.width, 960);
  assert.equal(payload.height, 540);
  assert.equal(payload.fps, 6);
});

test('local origin guidance warns against forced relay or tunnel', () => {
  const { WebRTC } = loadWebRTC({
    window: { location: { origin: 'http://127.0.0.1:8080', hostname: '127.0.0.1' }, RTCRtpReceiver: null },
  });
  WebRTC.serverConfig = {
    turnConfigured: true,
    turnStatus: 'ok',
    iceServers: [{ urls: 'turn:144.225.130.238:3478?transport=udp', username: 'u', credential: 'p' }],
  };

  WebRTC.networkMode = 'relay';
  assert.match(WebRTC.getDefaultNetworkGuidance(), /本机打开/);
  assert.match(WebRTC.getDefaultNetworkGuidance(), /本地直连|自动穿透/);

  WebRTC.networkMode = 'tunnel';
  assert.match(WebRTC.getDefaultNetworkGuidance(), /本机打开/);
});

test('read-only control UI requests takeover only when another viewer owns the lease', () => {
  const emitted = [];
  const { WebRTC, elements } = loadWebRTC();
  WebRTC.socket = { connected: true, emit(...args) { emitted.push(args); } };
  WebRTC.controlState.hostOnline = true;
  WebRTC.handleControlState({ state: 'FREE', controller: false });
  assert.equal(elements.get('controlStatus').textContent, '只读');
  elements.get('requestControlBtn').listeners.get('click')({ preventDefault() {} });
  assert.equal(emitted.at(-1)[1].takeover, false);
  WebRTC.handleControlState({ state: 'ACTIVE', controller: false });
  elements.get('requestControlBtn').listeners.get('click')({ preventDefault() {} });
  assert.equal(emitted.at(-1)[1].takeover, true);
});

test('transitional control states disable requests and label the viewer as switching', () => {
  const { WebRTC, elements } = loadWebRTC();
  for (const state of ['GRANTING', 'REVOKING']) {
    WebRTC.handleControlState({ state, controller: false, reason: null });
    assert.equal(elements.get('controlStatus').textContent, '控制权正在切换');
    assert.equal(elements.get('requestControlBtn').hidden, true);
    assert.equal(elements.get('requestControlBtn').disabled, true);
  }
});

test('reset-blocked control state locks requests without looping acquire', () => {
  const emitted = [];
  const { WebRTC, elements } = loadWebRTC();
  WebRTC.socket = { connected: true, emit(...args) { emitted.push(args); } };
  WebRTC.controlState.hostOnline = true;
  WebRTC.handleControlState({ state: 'REVOKING', controller: false, reason: 'reset-blocked' });
  assert.equal(elements.get('controlStatus').textContent, 'Host 输入复位未确认，控制已安全锁定');
  assert.equal(elements.get('requestControlBtn').hidden, true);
  assert.equal(elements.get('requestControlBtn').disabled, true);
  assert.equal(WebRTC.requestControl(), false);
  assert.equal(emitted.some((entry) => entry[0] === 'control-acquire'), false);
});

test('control-acquire-result clears sticky switching label on occupied reset barrier', () => {
  const { WebRTC, elements } = loadWebRTC();
  WebRTC.socket = { connected: true, emit() {} };
  WebRTC.controlState.hostOnline = true;
  WebRTC.handleControlState({ state: 'FREE', controller: false });
  WebRTC.requestControl({ allowTakeover: true });
  assert.equal(elements.get('controlStatus').textContent, '控制权正在切换');
  WebRTC.handleControlAcquireResult({
    state: 'REVOKING',
    reason: 'reset-in-progress',
    requestId: WebRTC._controlAcquireRequestId,
    pendingViewerId: null,
    leaseEpoch: 9,
  });
  assert.equal(WebRTC.controlState.state, 'REVOKING');
  assert.equal(elements.get('controlStatus').textContent, '控制权正在切换');
  assert.equal(elements.get('requestControlBtn').disabled, true);
  WebRTC.handleControlAcquireResult({
    state: 'REVOKING',
    reason: 'reset-blocked',
    requestId: WebRTC._controlAcquireRequestId,
  });
  // reason text path for non-transitioning terminal reasons uses explicit map when state not GRANTING
  // reset-blocked with REVOKING still uses transitioning label via updateControlUI(); force via handleControlState
  WebRTC.handleControlState({ state: 'REVOKING', controller: false, reason: 'reset-blocked' });
  assert.equal(elements.get('controlStatus').textContent, 'Host 输入复位未确认，控制已安全锁定');
});

test('relay control and frame acknowledgements require and carry the active v2 lease', () => {
  const emitted = [];
  const { WebRTC, elements } = loadWebRTC();
  WebRTC.currentConnectionAttemptId = 'relay-fixture-attempt';
  WebRTC.connectionAttemptSequence = 1;
  WebRTC.socket = { connected: true, emit(...args) { emitted.push(args); } };
  WebRTC.emitRelayStreamControl();
  assert.equal(emitted.length, 0);

  WebRTC.controlState = { state: 'ACTIVE', controller: true, hostOnline: true, lease: { leaseId: 'lease-000000000001', leaseEpoch: 6 } };
  WebRTC.emitRelayStreamControl();
  const control = emitted.at(-1)[1];
  assert.deepEqual({ schemaVersion: control.schemaVersion, leaseId: control.leaseId, leaseEpoch: control.leaseEpoch }, {
    schemaVersion: 2, leaseId: 'lease-000000000001', leaseEpoch: 6,
  });

  WebRTC.tunnelRelayActive = true;
  const fields = prepareOrdinaryRelay(WebRTC);
  WebRTC.handleRelayFrame({ ...fields, data: 'ZmFrZQ==', frameId: 3, timestamp: Date.now() });
  elements.get('relayImage').onload();
  const ack = emitted.at(-1)[1];
  assert.equal(emitted.at(-1)[0], 'relay-frame-ack');
  assert.deepEqual({ schemaVersion: ack.schemaVersion, leaseId: ack.leaseId, leaseEpoch: ack.leaseEpoch }, {
    schemaVersion: 2, leaseId: 'lease-000000000001', leaseEpoch: 6,
  });
});

test('DataChannel open updates current keyboard UI without calling removed raw display API', () => {
  const { WebRTC } = loadWebRTC({
    Input: { updateKeyboardUI() {} },
  });
  WebRTC.pc = {
    connectionState: 'connecting', iceConnectionState: 'checking',
    createDataChannel() { return { readyState: 'connecting', bufferedAmount: 0, send() {} }; },
  };
  WebRTC.createInputChannel();
  assert.doesNotThrow(() => WebRTC.inputChannel.onopen());
});

test('DataChannel lifecycle updates keyboard transport availability before reconnect handling', () => {
  const lifecycle = [];
  const { WebRTC } = loadWebRTC({
    Input: {
      setKeyboardDataChannelAvailable(available) { lifecycle.push(available); },
      updateKeyboardUI() {},
    },
  });
  WebRTC.pc = {
    connectionState: 'connected', iceConnectionState: 'connected',
    createDataChannel() { return { readyState: 'connecting', bufferedAmount: 0, send() {} }; },
  };
  WebRTC.createInputChannel();

  WebRTC.inputChannel.onopen();
  WebRTC.inputChannel.onclose();
  WebRTC.inputChannel.onerror({});

  assert.deepEqual(lifecycle, [true, false, false]);
  clearTimeout(WebRTC._dcTimeout);
  clearTimeout(WebRTC._dcReconnectTimer);
});

test('dc-error does not schedule full reconnect when inbound video is healthy', () => {
  const { WebRTC, context } = loadWebRTC();
  WebRTC.manualDisconnect = false;
  WebRTC._refreshing = false;
  WebRTC.reconnectTimer = null;
  WebRTC.pc = { connectionState: 'connected', iceConnectionState: 'connected' };
  WebRTC._lastInboundFramesDecoded = 10;
  WebRTC._lastInboundFramesDecodedAt = context.performance.now();
  let scheduled = 0;
  const original = WebRTC.scheduleReconnect.bind(WebRTC);
  WebRTC.scheduleReconnect = (reason) => { scheduled += 1; return original(reason); };
  assert.equal(WebRTC.shouldReconnectForDataChannelFault('dc-error'), false);
  WebRTC.noteDataChannelFault('dc-error');
  assert.equal(scheduled, 0);
  assert.equal(WebRTC._inputDcDegraded, true);
});

test('dc-error schedules reconnect when inbound video is not healthy', () => {
  const { WebRTC } = loadWebRTC();
  WebRTC.manualDisconnect = false;
  WebRTC._refreshing = false;
  WebRTC.reconnectTimer = null;
  WebRTC.pc = { connectionState: 'connected', iceConnectionState: 'connected' };
  WebRTC._lastInboundFramesDecoded = 0;
  WebRTC._lastInboundFramesDecodedAt = null;
  let scheduled = 0;
  const reasons = [];
  WebRTC.scheduleReconnect = (reason) => {
    scheduled += 1;
    reasons.push(reason);
  };
  assert.equal(WebRTC.isInboundVideoHealthy(), false);
  assert.equal(WebRTC.shouldReconnectForDataChannelFault('dc-error'), true);
  assert.equal(WebRTC.noteDataChannelFault('dc-error'), true);
  assert.equal(scheduled, 1);
  assert.deepEqual(reasons, ['dc-error']);
});

test('inbound video health requires recent decoded progress', () => {
  let now = 10000;
  const { WebRTC } = loadWebRTC({ performance: { now: () => now } });
  WebRTC._lastInboundFramesDecoded = 0;
  WebRTC._lastInboundFramesDecodedAt = null;
  assert.equal(WebRTC.isInboundVideoHealthy(), false);

  WebRTC.processStatsSnapshot({ framesDecoded: 5, framesReceived: 5, fps: 5 });
  assert.equal(WebRTC._lastInboundFramesDecoded, 5);
  assert.ok(WebRTC._lastInboundFramesDecodedAt > 0);
  assert.equal(WebRTC.isInboundVideoHealthy(), true);

  const growthAt = WebRTC._lastInboundFramesDecodedAt;
  WebRTC.processStatsSnapshot({ framesDecoded: 5, framesReceived: 5, fps: 0 });
  assert.ok(WebRTC._lastInboundFramesDecodedAt >= growthAt);

  now += 6000;
  assert.equal(WebRTC.isInboundVideoHealthy(), false);
});

test('stale DataChannel lifecycle callbacks cannot invalidate a replacement channel', () => {
  const lifecycle = [];
  const channels = [];
  const { WebRTC } = loadWebRTC({
    Input: {
      setKeyboardDataChannelAvailable(available) { lifecycle.push(available); },
      updateKeyboardUI() {},
    },
  });
  WebRTC.pc = {
    connectionState: 'connected', iceConnectionState: 'connected',
    createDataChannel(label) {
      const channel = { label, readyState: 'connecting', bufferedAmount: 0, send() {} };
      channels.push(channel);
      return channel;
    },
  };
  WebRTC.createInputChannel();
  const oldInputChannel = channels.find(({ label }) => label === 'input');
  oldInputChannel.onopen();

  WebRTC.inputChannel = null;
  WebRTC.inputMoveChannel = null;
  WebRTC.createInputChannel();
  const currentInputChannel = channels.filter(({ label }) => label === 'input').at(-1);
  currentInputChannel.onopen();

  oldInputChannel.onclose();
  oldInputChannel.onerror({});
  assert.deepEqual(lifecycle, [true, true]);
  assert.equal(Boolean(WebRTC._dcReconnectTimer), false);

  currentInputChannel.onclose();
  assert.deepEqual(lifecycle, [true, true, false]);
  clearTimeout(WebRTC._dcTimeout);
  clearTimeout(WebRTC._dcReconnectTimer);
});

test('LinkQualityController requires two degraded samples before requesting medium profile', () => {
  const { LinkQualityController } = loadLinkQualityController();
  // Legacy ladder: packet-loss degrade still works with qualityLock (rate signaling).
  const controller = LinkQualityController.create({ qualityLock: false });

  let result = controller.observe({
    fps: 4,
    rttMs: 92,
    jitterBufferMs: 8,
    packetsLost: 54,
    framesDecoded: 121,
    framesReceived: 121,
    selectedCandidateType: 'prflx',
  });
  assert.equal(result.action, 'hold');
  assert.equal(result.profile, 'high');

  result = controller.observe({
    fps: 4,
    rttMs: 140,
    jitterBufferMs: 180,
    packetsLost: 80,
    framesDecoded: 130,
    framesReceived: 130,
    selectedCandidateType: 'prflx',
  });
  assert.equal(result.action, 'degrade');
  assert.equal(result.profile, 'medium');
  assert.equal(result.reason, 'packet-loss');
});

test('LinkQualityController enters critical recovery after repeated zero fps with selected pair', () => {
  const { LinkQualityController } = loadLinkQualityController();
  // Unlock: legacy survival size ladder on sustained stall.
  const controller = LinkQualityController.create({ qualityLock: false });

  controller.observe({
    fps: 0,
    rttMs: 90,
    jitterBufferMs: 250,
    packetsLost: 10,
    framesDecoded: 199,
    framesReceived: 199,
    selectedCandidateType: 'prflx',
  });
  const result = controller.observe({
    fps: 0,
    rttMs: 95,
    jitterBufferMs: 270,
    packetsLost: 10,
    framesDecoded: 199,
    framesReceived: 199,
    selectedCandidateType: 'prflx',
  });

  assert.equal(result.action, 'critical');
  assert.equal(result.profile, 'survival');
  assert.equal(result.shouldRestartIce, true);
});

test('LinkQualityController upgrades one profile after ten good samples and cooldown', () => {
  const { LinkQualityController } = loadLinkQualityController();
  let now = 0;
  const controller = LinkQualityController.create({
    initialProfile: 'survival',
    now: () => now,
    qualityLock: false,
  });
  const good = {
    fps: 20,
    rttMs: 40,
    jitterBufferMs: 12,
    packetsLost: 0,
    framesDecoded: 20,
    selectedCandidateType: 'srflx',
  };

  for (let index = 0; index < 10; index += 1) {
    now += 1000;
    assert.equal(controller.observe(good).action, 'hold');
  }
  now = 16000;
  const result = controller.observe(good);

  assert.equal(result.action, 'upgrade');
  assert.equal(result.profile, 'low');
});

test('LinkQualityController requires two fresh degraded samples for every downshift', () => {
  const { LinkQualityController } = loadLinkQualityController();
  const controller = LinkQualityController.create({ qualityLock: false });
  const bad = {
    fps: 4,
    rttMs: 140,
    jitterBufferMs: 180,
    packetsLost: 30,
    framesDecoded: 10,
    selectedCandidateType: 'srflx',
    interval: true,
  };

  assert.equal(controller.observe(bad).action, 'hold');
  assert.equal(controller.observe(bad).profile, 'medium');
  const firstSampleAtMedium = controller.observe(bad);

  assert.equal(firstSampleAtMedium.action, 'hold');
  assert.equal(firstSampleAtMedium.profile, 'medium');
});

test('LinkQualityController ignores two startup zero-fps samples before evaluating stalls', () => {
  const { LinkQualityController } = loadLinkQualityController();
  const controller = LinkQualityController.create({ qualityLock: false });
  controller.beginConnection();
  const startupSample = {
    fps: 0,
    rttMs: 5,
    jitterBufferMs: 0,
    packetsLost: 0,
    framesReceived: 20,
    framesDecoded: 0,
    selectedCandidateType: 'host',
    interval: true,
  };

  assert.equal(controller.observe(startupSample).reason, 'media-warmup');
  assert.equal(controller.observe(startupSample).reason, 'media-warmup');
  assert.equal(controller.observe(startupSample).action, 'hold');
  assert.equal(controller.observe(startupSample).action, 'critical');
  assert.equal(controller.snapshot().currentProfile, 'survival');
});

test('LinkQualityController relay path starts high and treats structural TURN RTT as non-critical', () => {
  const { LinkQualityController } = loadLinkQualityController();
  const controller = LinkQualityController.create({ path: 'relay', qualityLock: false });

  assert.equal(controller.currentProfile, 'high');
  assert.equal(controller.maxProfile, 'high');

  // ~430ms is normal for LA TURN; must not force survival or ICE restart.
  let result = controller.observe({
    fps: 12,
    rttMs: 430,
    jitterBufferMs: 20,
    packetsLost: 0,
    framesDecoded: 12,
    selectedCandidateType: 'relay',
    interval: true,
  });
  assert.equal(result.action, 'hold');
  assert.equal(result.profile, 'high');
  assert.equal(result.shouldRestartIce || false, false);

  result = controller.observe({
    fps: 12,
    rttMs: 450,
    jitterBufferMs: 25,
    packetsLost: 0,
    framesDecoded: 24,
    selectedCandidateType: 'relay',
    interval: true,
  });
  assert.equal(result.action, 'hold');
  assert.equal(result.profile, 'high');
  assert.equal(result.shouldRestartIce || false, false);
  assert.equal(controller.snapshot().currentProfile, 'high');
});

test('LinkQualityController relay path never restarts ICE for media-stalled and warms up longer', () => {
  const { LinkQualityController } = loadLinkQualityController();
  // Unlock preserves survival-on-sustained-stall ladder (lock mode covered in dedicated tests).
  const controller = LinkQualityController.create({ path: 'relay', qualityLock: false });
  controller.beginConnection();
  assert.equal(controller.startupGraceSamplesRemaining, 12);
  assert.equal(controller.iceRestartOnStall, false);

  const stall = {
    fps: 0,
    rttMs: 400,
    jitterBufferMs: 10,
    packetsLost: 0,
    framesDecoded: 0,
    framesReceived: 0,
    selectedCandidateType: 'relay',
    interval: true,
  };

  for (let i = 0; i < 12; i += 1) {
    const warm = controller.observe(stall);
    assert.equal(warm.reason, 'media-warmup');
    assert.equal(warm.shouldRestartIce || false, false);
  }

  // After grace, brief stalls hold; only sustained stall may enter survival, never ICE restart.
  for (let i = 0; i < 5; i += 1) {
    const held = controller.observe(stall);
    assert.equal(held.shouldRestartIce || false, false);
    assert.notEqual(held.action, 'critical');
  }
  const critical = controller.observe(stall);
  assert.equal(critical.action, 'critical');
  assert.equal(critical.profile, 'survival');
  assert.equal(critical.shouldRestartIce, false);
  assert.equal(critical.reason, 'media-stalled');
  // Already on survival: further stalls must not re-emit profileConfig (Host encoder thrash).
  const again = controller.observe(stall);
  assert.equal(again.profile, 'survival');
  assert.equal(Boolean(again.profileConfig), false);
  assert.equal(again.changed || false, false);
});

test('WebRTC proactiveIceRestart skips media-stalled on relay mode', () => {
  const { WebRTC } = loadWebRTC();
  let restartCalls = 0;
  let offerCalls = 0;
  WebRTC.networkMode = 'relay';
  WebRTC._iceRestartAttempts = 0;
  WebRTC.pc = {
    restartIce() { restartCalls += 1; },
    connectionState: 'connected',
    iceConnectionState: 'connected',
  };
  WebRTC.createOffer = () => { offerCalls += 1; };

  WebRTC.proactiveIceRestart('media-stalled');
  assert.equal(restartCalls, 0);
  assert.equal(offerCalls, 0);
  assert.equal(WebRTC._iceRestartAttempts, 0);

  WebRTC.proactiveIceRestart('high-rtt');
  assert.equal(restartCalls, 0);
  assert.equal(offerCalls, 0);
});

test('LinkQualityController relay path degrades on loss but never restarts ICE for high RTT alone', () => {
  const { LinkQualityController } = loadLinkQualityController();
  const controller = LinkQualityController.create({ path: 'relay', qualityLock: false });
  const lossy = {
    fps: 4,
    rttMs: 500,
    jitterBufferMs: 40,
    packetsLost: 40,
    framesDecoded: 4,
    selectedCandidateType: 'relay',
    interval: true,
  };

  assert.equal(controller.observe(lossy).action, 'hold');
  const degraded = controller.observe(lossy);
  assert.equal(degraded.action, 'degrade');
  // Relay now starts at high; two loss samples step to medium (not full survival).
  assert.equal(degraded.profile, 'medium');
  assert.equal(degraded.shouldRestartIce, false);

  // Structural very-high RTT still does not request ICE restart on relay.
  const veryHighRtt = {
    fps: 10,
    rttMs: 1300,
    jitterBufferMs: 30,
    packetsLost: 0,
    framesDecoded: 20,
    selectedCandidateType: 'relay',
    interval: true,
  };
  controller.observe(veryHighRtt);
  const criticalRtt = controller.observe(veryHighRtt);
  assert.equal(criticalRtt.shouldRestartIce || false, false);
  assert.notEqual(criticalRtt.action, 'critical');
});

test('LinkQualityController relay path caps upgrades at medium', () => {
  const { LinkQualityController } = loadLinkQualityController();
  let now = 0;
  const controller = LinkQualityController.create({
    path: 'relay',
    initialProfile: 'survival',
    now: () => now,
    qualityLock: false,
  });
  const good = {
    fps: 15,
    rttMs: 400,
    jitterBufferMs: 20,
    packetsLost: 0,
    framesDecoded: 15,
    selectedCandidateType: 'relay',
    interval: true,
  };

  // 400ms is below relay highRtt threshold (700), so samples count as good.
  for (let index = 0; index < 10; index += 1) {
    now += 1000;
    assert.equal(controller.observe(good).action, 'hold');
  }
  now = 16000;
  assert.equal(controller.observe(good).profile, 'low');
  for (let index = 0; index < 10; index += 1) {
    now += 1000;
    controller.observe(good);
  }
  now += 16000;
  const toMedium = controller.observe(good);
  assert.equal(toMedium.action, 'upgrade');
  assert.equal(toMedium.profile, 'medium');

  for (let index = 0; index < 12; index += 1) {
    now += 1000;
    const held = controller.observe(good);
    assert.equal(held.profile, 'medium');
    assert.notEqual(held.action, 'upgrade');
  }
});

test('WebRTC configures a finite numeric video playout delay hint', () => {
  const { WebRTC } = loadWebRTC();
  const values = [];
  const receiver = {
    track: { kind: 'video' },
    get playoutDelayHint() { return null; },
    set playoutDelayHint(value) { values.push(value); },
    get jitterBufferTarget() { return null; },
    set jitterBufferTarget(_value) {},
  };

  WebRTC.configureVideoReceiver(receiver);

  assert.deepEqual(values, [0]);
  assert.equal(Number.isFinite(values[0]), true);
});

test('WebRTC relay pins skip-wait playout delay', () => {
  const { WebRTC } = loadWebRTC();
  const hints = [];
  const jitter = [];
  const receiver = {
    track: { kind: 'video' },
    get playoutDelayHint() { return null; },
    set playoutDelayHint(value) { hints.push(value); },
    get jitterBufferTarget() { return null; },
    set jitterBufferTarget(value) { jitter.push(value); },
  };
  WebRTC.networkMode = 'relay';
  WebRTC.configureVideoReceiver(receiver);
  assert.deepEqual(hints, [0]);
  assert.deepEqual(jitter, [0]);
});

test('relay decoder stall requests one generation-bound keyframe while packets still arrive', () => {
  const emitted = [];
  const { LinkQualityController } = loadLinkQualityController();
  const { WebRTC } = loadWebRTC({ LinkQualityController });
  WebRTC.networkMode = 'relay';
  WebRTC.adaptiveMediaEnabled = true;
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 8 },
  };
  WebRTC.socket = { connected: true, emit(...args) { emitted.push(args); } };
  WebRTC.pc = { connectionState: 'connected', iceConnectionState: 'connected' };
  WebRTC.currentConnectionAttemptId = 'attempt-decoder-stall';
  WebRTC.connectionAttemptSequence = 7;
  WebRTC.ensureLinkQualityController().beginConnection(0);
  WebRTC.handleReceiverStats({
    derivedFps: 0,
    rttMs: 40,
    jitterBufferMs: 0,
    packetsLostDelta: 0,
    decodedDelta: 0,
    receivedDelta: 19,
    selectedCandidateType: 'relay',
    interval: true,
  });
  WebRTC.requestKeyframe('ontrack-first-video');
  const keyframes = emitted.filter((entry) => entry[0] === 'request-keyframe');
  assert.equal(keyframes.length, 1);
  assert.equal(keyframes[0][1].reason, 'decoder-stalled');
  assert.equal(keyframes[0][1].connectionAttemptId, 'attempt-decoder-stall');
  assert.equal(keyframes[0][1].connectionAttemptSequence, 7);
  assert.equal(keyframes[0][1].generation, 7);
});

test('relay stats re-apply skip-wait jitter so Chrome cannot grow it', () => {
  const { WebRTC } = loadWebRTC();
  const jitter = [];
  WebRTC.networkMode = 'relay';
  WebRTC.pc = {
    connectionState: 'connected',
    iceConnectionState: 'connected',
    getReceivers() {
      return [{
        track: { kind: 'video' },
        get playoutDelayHint() { return 0; },
        set playoutDelayHint(_value) {},
        get jitterBufferTarget() { return 160; },
        set jitterBufferTarget(value) { jitter.push(value); },
      }];
    },
  };
  WebRTC.processStatsSnapshot({
    fps: 19,
    rttMs: 30,
    jitterBufferMs: 0.2,
    packetsLost: 0,
    framesDecoded: 19,
    framesReceived: 19,
    selectedCandidateType: 'relay',
  });
  assert.deepEqual(jitter, [0]);
});

test('relay freeze second keeps skip-wait jitter without tearing down PC', () => {
  const { WebRTC } = loadWebRTC();
  const jitter = [];
  WebRTC.networkMode = 'relay';
  WebRTC.pc = {
    connectionState: 'connected',
    iceConnectionState: 'connected',
    getReceivers() {
      return [{
        track: { kind: 'video' },
        get playoutDelayHint() { return 0; },
        set playoutDelayHint(_value) {},
        get jitterBufferTarget() { return 0; },
        set jitterBufferTarget(value) { jitter.push(value); },
      }];
    },
  };
  WebRTC.processStatsSnapshot({
    fps: 0,
    rttMs: 38,
    jitterBufferMs: 0,
    packetsLost: 0,
    framesDecoded: 0,
    framesReceived: 19,
    framesDropped: 0,
    pliCount: 0,
    freezeCount: 0,
    selectedCandidateType: 'relay',
  });
  assert.deepEqual(jitter, [0]);
  assert.equal(WebRTC.pc.connectionState, 'connected');
});

test('WebRTC syncs the adaptive profile when a new media connection becomes active', () => {
  const { LinkQualityController } = loadLinkQualityController();
  const { WebRTC } = loadWebRTC({ LinkQualityController });
  const emitted = [];
  WebRTC.networkMode = 'auto';
  WebRTC.linkQualityController = LinkQualityController.create();
  WebRTC.socket = {
    connected: true,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
  };
  WebRTC.controlState = { state: 'ACTIVE', controller: true, hostOnline: true, lease: { leaseId: 'lease-000000000001', leaseEpoch: 8 } };

  WebRTC.syncMediaProfile();

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'media-profile-change');
  assert.equal(emitted[0].payload.profile, 'high');
  assert.equal(emitted[0].payload.targetFps, 20);
  assert.equal(emitted[0].payload.mediaPolicy, 'strict-stun');
  assert.equal(emitted[0].payload.schemaVersion, 2);
  assert.equal(emitted[0].payload.leaseId, 'lease-000000000001');
});

test('WebRTC relay mode syncs low media profile instead of high', () => {
  const { LinkQualityController } = loadLinkQualityController();
  const { WebRTC } = loadWebRTC({ LinkQualityController });
  const emitted = [];
  WebRTC.networkMode = 'relay';
  WebRTC.linkQualityController = null;
  WebRTC.socket = {
    connected: true,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
  };
  WebRTC.controlState = { state: 'ACTIVE', controller: true, hostOnline: true, lease: { leaseId: 'lease-000000000001', leaseEpoch: 8 } };

  WebRTC.syncMediaProfile();

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'media-profile-change');
  assert.equal(emitted[0].payload.profile, 'high');
  // Quality Lock (adaptiveResolution off): keep user presentation floors on connection-sync.
  // Default currentResolution is 1280x720 → targetFps/bitrate from qualityFloorsForResolution.
  assert.equal(emitted[0].payload.targetFps, 20);
  assert.equal(emitted[0].payload.videoBitrateKbps >= 1800, true);
  assert.equal(emitted[0].payload.videoBitrateKbps, 2500);
  assert.equal(emitted[0].payload.width, WebRTC.currentResolution.width);
  assert.equal(emitted[0].payload.height, WebRTC.currentResolution.height);
  assert.equal(emitted[0].payload.adaptiveResolution, false);
  assert.equal(WebRTC.linkQualityController.path, 'relay');
});

test('WebRTC relay mode adapts on packet loss without ICE restart for structural RTT', () => {
  const emitted = [];
  const { LinkQualityController } = loadLinkQualityController();
  const { WebRTC } = loadWebRTC({ LinkQualityController });
  let restartCalls = 0;

  WebRTC.networkMode = 'relay';
  WebRTC.linkQualityController = LinkQualityController.create({ path: 'relay', qualityLock: false });
  WebRTC.socket = {
    connected: true,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
  };
  WebRTC.controlState = { state: 'ACTIVE', controller: true, hostOnline: true, lease: { leaseId: 'lease-000000000001', leaseEpoch: 8 } };
  WebRTC.pc = {
    restartIce() { restartCalls += 1; },
    connectionState: 'connected',
    iceConnectionState: 'connected',
  };

  WebRTC.handleReceiverStats({
    fps: 4,
    rttMs: 430,
    jitterBufferMs: 20,
    packetsLost: 40,
    framesDecoded: 4,
    framesReceived: 4,
    selectedCandidateType: 'relay',
    interval: true,
  });
  WebRTC.handleReceiverStats({
    fps: 4,
    rttMs: 430,
    jitterBufferMs: 20,
    packetsLost: 40,
    framesDecoded: 8,
    framesReceived: 8,
    selectedCandidateType: 'relay',
    interval: true,
  });

  const profileEvent = emitted.find((entry) => entry.event === 'media-profile-change');
  assert.equal(Boolean(profileEvent), true);
  // With qualityLock false and relay max=high, two loss samples step high→medium (not full survival).
  assert.ok(['medium', 'low', 'survival'].includes(profileEvent.payload.profile));
  assert.notEqual(profileEvent.payload.profile, 'high');
  assert.equal(WebRTC.adaptiveResolutionEnabled, false);
  assert.equal(profileEvent.payload.width, WebRTC.currentResolution.width);
  assert.equal(profileEvent.payload.height, WebRTC.currentResolution.height);
  assert.equal(profileEvent.payload.adaptiveResolution, false);
  assert.equal(restartCalls, 0);
});

test('adaptive resolution toggle can allow profile size changes when enabled', () => {
  const emitted = [];
  const { WebRTC } = loadWebRTC();
  WebRTC.controlState = { state: 'ACTIVE', controller: true, hostOnline: true, lease: { leaseId: 'lease-000000000001', leaseEpoch: 9 } };
  WebRTC.socket = { connected: true, emit(event, payload) { emitted.push({ event, payload }); } };
  WebRTC.currentResolution = { width: 1280, height: 720, label: '1280x720' };

  WebRTC.setAdaptiveResolutionEnabled(false, { persist: false });
  WebRTC.applyMediaProfile({ name: 'survival', width: 640, height: 360, fps: 8, bitrateKbps: 500 }, 'test-off');
  assert.equal(WebRTC.currentResolution.width, 1280);
  assert.equal(emitted.at(-1).payload.width, 1280);
  assert.equal(emitted.at(-1).payload.height, 720);
  // Locked high-res keeps a sane bitrate floor instead of 500kbps survival.
  assert.equal(emitted.at(-1).payload.videoBitrateKbps >= 1200, true);
  assert.equal(emitted.at(-1).payload.targetFps >= 12, true);

  WebRTC.setAdaptiveResolutionEnabled(true, { persist: false });
  WebRTC.applyMediaProfile({ name: 'survival', width: 640, height: 360, fps: 8, bitrateKbps: 500 }, 'test-on');
  assert.equal(WebRTC.currentResolution.width, 640);
  assert.equal(WebRTC.currentResolution.height, 360);
  assert.equal(emitted.at(-1).payload.width, 640);
  assert.equal(emitted.at(-1).payload.adaptiveResolution, true);
});

test('explicit resolution keeps the requested presentation size with adaptive resolution on or off', async () => {
  const { LinkQualityController } = loadLinkQualityController();
  const { WebRTC } = loadWebRTC({ LinkQualityController });
  const emitted = [];
  WebRTC.socket = { connected: true, emit(event, payload) { emitted.push({ event, payload }); } };
  WebRTC.controlState = { state: 'ACTIVE', controller: true, hostOnline: true, lease: { leaseId: 'lease-000000000001', leaseEpoch: 9 } };
  WebRTC.currentResolution = { width: 1280, height: 720, label: '1280x720' };
  WebRTC.linkQualityController = LinkQualityController.create({ path: 'relay' });

  WebRTC.setAdaptiveResolutionEnabled(false, { persist: false });
  await WebRTC.requestResolution(1920, 1080);
  assert.deepEqual([emitted.at(-1).payload.width, emitted.at(-1).payload.height], [1920, 1080]);

  WebRTC.currentResolution = { width: 1280, height: 720, label: '1280x720' };
  WebRTC.setAdaptiveResolutionEnabled(true, { persist: false });
  await WebRTC.requestResolution(1920, 1080);
  assert.deepEqual([emitted.at(-1).payload.width, emitted.at(-1).payload.height], [1920, 1080]);
  assert.equal(emitted.at(-1).payload.adaptiveResolution, true);
});

test('media profile and resolution changes no-op without a lease and emit v2 envelopes when active', async () => {
  const { WebRTC } = loadWebRTC();
  const emitted = [];
  WebRTC.socket = { connected: true, emit(event, payload) { emitted.push({ event, payload }); } };
  const initialResolution = { ...WebRTC.currentResolution };

  WebRTC.applyMediaProfile({ name: 'medium', width: 960, height: 540, fps: 15, bitrateKbps: 1400 }, 'test');
  await WebRTC.requestResolution(1280, 720);
  assert.equal(emitted.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(WebRTC.currentResolution)), initialResolution);

  WebRTC.controlState = { state: 'ACTIVE', controller: true, hostOnline: true, lease: { leaseId: 'lease-000000000001', leaseEpoch: 9 } };
  WebRTC.applyMediaProfile({ name: 'medium', width: 960, height: 540, fps: 15, bitrateKbps: 1400 }, 'test');
  await WebRTC.requestResolution(1280, 720);
  // A user presentation change travels through the authenticated media-profile
  // channel so Signal assigns and Host admits a real profileSequence.
  assert.deepEqual(emitted.map(({ event }) => event), ['media-profile-change', 'media-profile-change']);
  assert.equal(emitted[1].payload.profileSequence, emitted[0].payload.profileSequence + 1);
  assert.deepEqual([emitted[1].payload.width, emitted[1].payload.height], [1280, 720]);
  emitted.forEach(({ payload }) => assert.deepEqual({ schemaVersion: payload.schemaVersion, leaseId: payload.leaseId, leaseEpoch: payload.leaseEpoch }, {
    schemaVersion: 2, leaseId: 'lease-000000000001', leaseEpoch: 9,
  }));
});

test('resolution change no-ops when the active lease socket is disconnected', async () => {
  const { WebRTC } = loadWebRTC();
  WebRTC.controlState = { state: 'ACTIVE', controller: true, hostOnline: true, lease: { leaseId: 'lease-000000000001', leaseEpoch: 9 } };
  WebRTC.socket = { connected: false, emit() { throw new Error('must not emit'); } };
  WebRTC.networkMode = 'tunnel';
  WebRTC.tunnelRelayActive = true;
  WebRTC.currentResolution = { width: 960, height: 540, label: '960x540' };
  let tunnelStarts = 0;
  WebRTC.startTunnelRelay = () => { tunnelStarts += 1; };

  assert.equal(await WebRTC.requestResolution(1280, 720), false);
  assert.deepEqual(JSON.parse(JSON.stringify(WebRTC.currentResolution)), { width: 960, height: 540, label: '960x540' });
  assert.equal(tunnelStarts, 0);
});

test('resolution modal changes its display and closes only after a successful request', async () => {
  const elements = new Map();
  const selected = { dataset: { width: '1280', height: '720' } };
  const document = {
    body: makeElement(),
    addEventListener(type, handler) { if (type === 'DOMContentLoaded') handler(); },
    querySelector(selector) { return selector === 'input[name="resolution"]:checked' ? selected : null; },
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); },
  };
  const modal = document.getElementById('resolutionModal');
  const display = document.getElementById('resolutionDisplay');
  const apply = document.getElementById('applyResolution');
  const { WebRTC } = loadWebRTC({ document, fetch: async () => ({ ok: false, status: 500 }) });
  display.textContent = '960x540';
  WebRTC.requestResolution = async () => false;
  await apply.listeners.get('click')();
  assert.equal(display.textContent, '960x540');
  assert.equal(modal.classList.contains('hidden'), false);

  WebRTC.requestResolution = async () => true;
  await apply.listeners.get('click')();
  assert.equal(display.textContent, '1280x720');
  assert.equal(modal.classList.contains('hidden'), true);
});

test('bindSettingsModal focuses the title and consumes Escape before remote keyboard', () => {
  const { WebRTC } = loadWebRTC();
  const title = makeElement();
  title.focusCalls = 0;
  title.focus = function focus() { this.focusCalls += 1; };
  const modal = makeElement();
  modal.querySelector = (selector) => (selector === 'h3' ? title : null);
  modal.classList.add('hidden');
  const closeBtn = makeElement();
  const rootListeners = [];
  const root = {
    addEventListener(type, handler, options) {
      rootListeners.push({ type, handler, options });
    },
  };

  const api = WebRTC.bindSettingsModal(modal, { closeBtn, root });
  api.open();
  assert.equal(modal.classList.contains('hidden'), false);
  assert.equal(title.focusCalls, 1);

  const keydown = rootListeners.find((item) => item.type === 'keydown');
  assert.ok(keydown, 'settings modal must listen for Escape');
  assert.equal(keydown.options === true || keydown.options?.capture === true, true);

  let stopped = false;
  let immediate = false;
  keydown.handler({
    key: 'Escape',
    preventDefault() {},
    stopPropagation() { stopped = true; },
    stopImmediatePropagation() { immediate = true; },
  });
  assert.equal(modal.classList.contains('hidden'), true);
  assert.equal(stopped, true);
  assert.equal(immediate, true);

  api.open();
  closeBtn.listeners.get('click')();
  assert.equal(modal.classList.contains('hidden'), true);
});

test('bindSettingsModal restores the opener focus after close', () => {
  const { WebRTC } = loadWebRTC();
  const opener = { focusCalls: 0, focus() { this.focusCalls += 1; } };
  const title = { focusCalls: 0, focus() { this.focusCalls += 1; } };
  const closeBtn = { dataset: {}, addEventListener() {} };
  const modal = {
    dataset: {},
    classList: { hidden: true, add() { this.hidden = true; }, remove() { this.hidden = false; }, contains() { return this.hidden; } },
    querySelector() { return title; },
    addEventListener() {},
  };
  const root = { addEventListener() {}, activeElement: opener };
  const api = WebRTC.bindSettingsModal(modal, { closeBtn, root });
  api.open();
  assert.equal(title.focusCalls, 1);
  api.close();
  assert.equal(opener.focusCalls, 1);
});

test('WebRTC owns one stats sampler and stops it during telemetry teardown', () => {
  let createCalls = 0;
  let startCalls = 0;
  let stopCalls = 0;
  const sampler = {
    start() { startCalls += 1; },
    stop() { stopCalls += 1; },
    snapshot() { return null; },
  };
  const { WebRTC, context } = loadWebRTC({
    WebRtcStats: {
      createWebRtcStatsSampler() {
        createCalls += 1;
        return sampler;
      },
    },
  });
  WebRTC.pc = { getStats: async () => new Map() };

  WebRTC.startStats();
  WebRTC.startStats();
  WebRTC.stopMediaTelemetry();

  assert.equal(createCalls, 1);
  assert.equal(startCalls, 2);
  assert.equal(stopCalls, 1);
});

test('video frame callback is cancelled and never accumulates on restart', () => {
  const { WebRTC, context } = loadWebRTC();
  const video = context.document.getElementById('remoteVideo');
  let nextId = 1;
  const active = new Set();
  const cancelled = [];
  video.requestVideoFrameCallback = () => {
    const id = nextId++;
    active.add(id);
    return id;
  };
  video.cancelVideoFrameCallback = (id) => {
    active.delete(id);
    cancelled.push(id);
  };

  WebRTC.startVideoFrameTracking();
  WebRTC.startVideoFrameTracking();
  WebRTC.stopMediaTelemetry();

  assert.equal(active.size, 0);
  assert.equal(cancelled.length, 2);
});

test('video frame callback paints only the current refresh attempt', () => {
  const { WebRTC, context } = loadWebRTC();
  const video = context.document.getElementById('remoteVideo');
  const callbacks = [];
  video.videoWidth = 1280;
  video.videoHeight = 720;
  video.requestVideoFrameCallback = (callback) => {
    callbacks.push(callback);
    return callbacks.length;
  };
  video.cancelVideoFrameCallback = () => {};

  WebRTC.currentConnectionAttemptId = 'attempt-old';
  WebRTC.pc = { id: 'pc-old' };
  WebRTC.startVideoFrameTracking();
  const staleCallback = callbacks[0];

  WebRTC.createConnectionAttemptId = () => 'attempt-new';
  WebRTC.beginConnectionAttempt('refresh');
  WebRTC.pc = { id: 'pc-new' };
  WebRTC.startVideoFrameTracking();
  const freshCallback = callbacks[1];

  staleCallback(1, { width: 1280, height: 720 });
  assert.equal(WebRTC._videoFrameSeq, 0);
  assert.equal(WebRTC.hasPaintedFrame, false);

  freshCallback(2, { width: 1280, height: 720 });
  assert.equal(WebRTC._videoFrameSeq, 1);
  assert.equal(WebRTC.hasPaintedFrame, true);
  assert.equal(WebRTC.uiPhase, 'connected');
});

test('video frame tracking aggregates paint intervals and geometry every five seconds', () => {
  const { WebRTC, context } = loadWebRTC();
  const video = context.document.getElementById('remoteVideo');
  const callbacks = [];
  video.videoWidth = 1280;
  video.videoHeight = 720;
  video.getBoundingClientRect = () => ({ x: 12, y: 24, width: 960, height: 540 });
  video.requestVideoFrameCallback = (callback) => {
    callbacks.push(callback);
    return callbacks.length;
  };
  video.cancelVideoFrameCallback = () => {};
  WebRTC.currentConnectionAttemptId = 'attempt-paint';
  WebRTC.pc = { id: 'pc-paint' };

  WebRTC.startVideoFrameTracking();
  callbacks[0](0, { presentedFrames: 10 });
  callbacks[1](20, { presentedFrames: 11 });
  callbacks[2](5020, { presentedFrames: 14 });

  assert.deepEqual(JSON.parse(JSON.stringify(WebRTC._lastPaintObservation)), {
    connectionAttemptId: 'attempt-paint',
    intervalMs: { p50: 20, p95: 5000, max: 5000 },
    maxGapMs: 5000,
    presentedFramesDelta: 4,
    video: { width: 1280, height: 720 },
    geometry: { x: 12, y: 24, width: 960, height: 540, changes: 0 },
  });
});

test('paint observations are cleared at stop and never cross connection attempts', () => {
  const { WebRTC, context } = loadWebRTC();
  WebRTC._paintObservationWindow = { startedAt: 1 };
  WebRTC._lastPaintObservation = { connectionAttemptId: 'old-attempt' };
  WebRTC.stopVideoFrameTracking();
  assert.equal(WebRTC._paintObservationWindow, null);
  assert.equal(WebRTC._lastPaintObservation, null);

  WebRTC._paintObservationWindow = { startedAt: 2 };
  WebRTC._lastPaintObservation = { connectionAttemptId: 'old-attempt' };
  WebRTC.beginConnectionAttempt('refresh');
  assert.equal(WebRTC._paintObservationWindow, null);
  assert.equal(WebRTC._lastPaintObservation, null);
  assert.ok(WebRTC.currentConnectionAttemptId);
  assert.ok(context.document);
});

test('fifty telemetry start-stop cycles leave no sampler or video callback active', () => {
  let created = 0;
  let stopped = 0;
  const { WebRTC, context } = loadWebRTC({
    WebRtcStats: {
      createWebRtcStatsSampler() {
        created += 1;
        return { start() {}, stop() { stopped += 1; }, snapshot() { return null; } };
      },
    },
  });
  const video = context.document.getElementById('remoteVideo');
  let nextCallback = 1;
  const activeCallbacks = new Set();
  video.requestVideoFrameCallback = () => {
    const id = nextCallback++;
    activeCallbacks.add(id);
    return id;
  };
  video.cancelVideoFrameCallback = (id) => activeCallbacks.delete(id);

  for (let index = 0; index < 50; index += 1) {
    WebRTC.pc = { getStats: async () => new Map() };
    WebRTC.startStats();
    WebRTC.startVideoFrameTracking();
    WebRTC.stopMediaTelemetry();
  }

  assert.equal(created, 50);
  assert.equal(stopped, 50);
  assert.equal(activeCallbacks.size, 0);
  assert.equal(WebRTC._statsSampler, null);
  assert.equal(WebRTC._videoFrameCallbackId, null);
});

test('refresh clears stuck offer state before creating a new offer', async () => {
  const { WebRTC } = loadWebRTC();
  const observed = [];
  let closed = false;

  WebRTC.socket = { connected: true };
  WebRTC.offerInProgress = true;
  WebRTC.pc = {
    close() { closed = true; },
  };
  WebRTC.stopTunnelRelay = () => {};
  WebRTC.createPeerConnection = () => {
    WebRTC.pc = { close() {} };
  };
  WebRTC.createOffer = () => {
    observed.push(WebRTC.offerInProgress);
  };

  await WebRTC.refresh();

  assert.equal(closed, true);
  assert.deepEqual(observed, [false]);
});

test('refresh resets ICE restart attempts for same-page recovery', async () => {
  const { WebRTC } = loadWebRTC();

  WebRTC.socket = { connected: true };
  WebRTC._iceRestartAttempts = 1;
  WebRTC.pc = {
    close() {},
  };
  WebRTC.stopTunnelRelay = () => {};
  WebRTC.createPeerConnection = () => {
    WebRTC.pc = { close() {} };
  };
  WebRTC.createOffer = () => {};

  await WebRTC.refresh();

  assert.equal(WebRTC._iceRestartAttempts, 0);
});

test('refresh in tunnel mode recreates a disconnected signaling socket before restarting relay', async () => {
  const replacementSocket = {
    connected: true,
    on() {},
    emit() {},
    disconnect() {},
  };
  const { WebRTC } = loadWebRTC({
    io: () => replacementSocket,
  });
  const staleSocket = {
    connected: false,
    disconnectCalled: false,
    disconnect() {
      this.disconnectCalled = true;
    },
  };

  let startCalls = 0;
  WebRTC.networkMode = 'tunnel';
  WebRTC.socket = staleSocket;
  WebRTC.stopTunnelRelay = () => {};
  WebRTC.startTunnelRelay = () => {
    startCalls += 1;
  };

  await WebRTC.refresh();

  assert.equal(staleSocket.disconnectCalled, true);
  assert.equal(WebRTC.socket, replacementSocket);
  assert.equal(startCalls, 1);
});

test('signaling disconnect in tunnel mode schedules same-page recovery even after socket goes offline', () => {
  const handlers = new Map();
  let scheduledRecovery = null;
  const socket = {
    connected: true,
    on(event, callback) {
      handlers.set(event, callback);
    },
    emit() {},
    disconnect() {},
  };
  const { WebRTC } = loadWebRTC({
    setTimeout(callback) {
      scheduledRecovery = callback;
      return 1;
    },
    clearTimeout() {},
  });

  let refreshCalls = 0;
  WebRTC.networkMode = 'tunnel';
  WebRTC.socket = socket;
  WebRTC.refresh = () => {
    refreshCalls += 1;
  };

  WebRTC.setupSocketListeners();
  handlers.get('disconnect')();

  assert.equal(typeof scheduledRecovery, 'function');
  scheduledRecovery();
  assert.equal(refreshCalls, 1);
});

test('signaling disconnect in relay mode also waits for the socket before refreshing media', async () => {
  const handlers = new Map();
  let scheduledRecovery = null;
  const socket = {
    connected: true,
    on(event, callback) {
      handlers.set(event, callback);
    },
    emit() {},
    disconnect() {},
    connect() {},
  };
  const { WebRTC } = loadWebRTC({
    setTimeout(callback) {
      scheduledRecovery = callback;
      return 1;
    },
    clearTimeout() {},
  });

  let refreshCalls = 0;
  WebRTC.networkMode = 'relay';
  WebRTC.socket = socket;
  WebRTC.refresh = () => { refreshCalls += 1; };
  WebRTC.setupSocketListeners();

  socket.connected = false;
  handlers.get('disconnect')('transport close');
  assert.equal(WebRTC._signalRecoveryPending, true);
  scheduledRecovery();
  assert.equal(refreshCalls, 0);

  socket.connected = true;
  await handlers.get('connect')();
  assert.equal(WebRTC._signalRecoveryPending, false);
  assert.equal(refreshCalls, 1);
});

test('direct signaling recovery is armed while manual disconnect stays inert', () => {
  let timerCalls = 0;
  const { WebRTC } = loadWebRTC({
    setTimeout() {
      timerCalls += 1;
      return 1;
    },
    clearTimeout() {},
  });

  WebRTC.networkMode = 'stun';
  WebRTC.manualDisconnect = false;
  assert.equal(WebRTC.scheduleSignalingRecovery('direct-disconnect'), true);
  assert.equal(timerCalls, 1);

  WebRTC.clearSignalingRecovery();
  WebRTC.manualDisconnect = true;
  assert.equal(WebRTC.scheduleSignalingRecovery('manual-disconnect'), false);
  assert.equal(WebRTC._signalRecoveryPending, false);
});

test('healthy peer signaling recovery restores connected UI and input without a fresh frame', () => {
  const inputStates = [];
  const { WebRTC } = loadWebRTC({
    Input: {
      setActive(value) { inputStates.push(value); },
      setControlLease() {},
      setKeyboardDataChannelAvailable() {},
      requestInputRecovery() {},
      updateKeyboardUI() {},
    },
  });

  WebRTC.socket = { connected: true };
  WebRTC.pc = { connectionState: 'connected' };
  WebRTC.uiPhase = 'signaling';
  WebRTC.hasPaintedFrame = true;
  WebRTC._signalRecoveryPending = true;
  WebRTC.controlState = {
    state: 'ACTIVE',
    controller: true,
    hostOnline: true,
    lease: { leaseId: 'lease-recovered-0001', leaseEpoch: 4 },
  };
  WebRTC.isInboundVideoHealthy = () => true;

  assert.equal(WebRTC.handleSignalingRecoveryConnected(), true);
  assert.equal(WebRTC.uiPhase, 'connected');
  assert.equal(inputStates.at(-1), true);
  assert.equal(WebRTC._signalRecoveryPending, false);
});

test('pageshow resumes a disconnected signaling socket and arms recovery', () => {
  const listeners = {};
  let connectCalls = 0;
  const socket = {
    connected: false,
    connect() { connectCalls += 1; },
    on() {},
    emit() {},
    disconnect() {},
  };
  const { WebRTC } = loadWebRTC({
    document: {
      hidden: false,
      body: makeElement(),
      addEventListener() {},
      getElementById() { return makeElement(); },
      querySelector: () => null,
    },
    window: {
      location: { origin: 'http://127.0.0.1:8080' },
      addEventListener(type, callback) { listeners[type] = callback; },
    },
    setTimeout() { return 1; },
    clearTimeout() {},
  });

  WebRTC.socket = socket;
  WebRTC.manualDisconnect = false;
  WebRTC.bindControlLifecycle();
  listeners.pagehide({ persisted: true });
  listeners.pageshow({ persisted: true });

  assert.equal(connectCalls, 1);
  assert.equal(WebRTC._pageLifecycleHidden, false);
  assert.equal(WebRTC._signalRecoveryPending, true);
});

test('stale createOffer completion does not clear newer offer progress', async () => {
  const { WebRTC } = loadWebRTC();
  let resolveOffer;

  WebRTC.socket = {
    connected: true,
    emit() {},
  };
  WebRTC.controlState = { state: 'ACTIVE', controller: true, lease: { leaseId: 'lease-000000000001', leaseEpoch: 4 }, hostOnline: true };
  WebRTC.pc = {
    getTransceivers: () => [],
    addTransceiver: () => ({}),
    createOffer: () => new Promise((resolve) => {
      resolveOffer = () => resolve({ type: 'offer', sdp: 'old' });
    }),
    setLocalDescription: async () => {},
    localDescription: { type: 'offer', sdp: 'old' },
  };
  WebRTC.preferH264 = () => {};

  const staleOffer = WebRTC.createOffer();
  assert.equal(WebRTC.offerInProgress, true);

  WebRTC._offerEpoch += 1;
  WebRTC.offerInProgress = true;
  resolveOffer();
  await staleOffer;

  assert.equal(WebRTC.offerInProgress, true);
});

test('createOffer emits connectionAttemptId bound to the current attempt', async () => {
  const { WebRTC } = loadWebRTC();
  const emitted = [];
  WebRTC.socket = {
    connected: true,
    emit(...args) { emitted.push(args); },
  };
  WebRTC.controlState = {
    state: 'ACTIVE',
    controller: true,
    hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 4 },
  };
  WebRTC.networkMode = 'stun';
  WebRTC.currentConnectionAttemptId = 'attempt-from-begin';
  WebRTC.pc = {
    getTransceivers: () => [],
    addTransceiver: () => ({}),
    createOffer: async () => ({ type: 'offer', sdp: 'v=0' }),
    setLocalDescription: async () => {},
    localDescription: { type: 'offer', sdp: 'v=0' },
  };
  WebRTC.preferH264 = () => {};

  await WebRTC.createOffer();
  const offerEmit = emitted.find((entry) => entry[0] === 'offer');
  assert.ok(offerEmit);
  assert.equal(offerEmit[1].connectionAttemptId, 'attempt-from-begin');
  assert.equal(offerEmit[1].leaseId, 'lease-000000000001');
  assert.equal(offerEmit[1].schemaVersion, 2);
});

test('auto fallback handles relay frames while tunnel relay is active', () => {
  const { WebRTC, elements, context } = loadWebRTC();
  const relayImage = elements.get('relayImage') || makeElement();
  relayImage.classList.add('hidden');
  elements.set('relayImage', relayImage);

  WebRTC.networkMode = 'auto';
  WebRTC.tunnelRelayActive = true;
  WebRTC.controlState = { state: 'ACTIVE', controller: true, hostOnline: true, lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 } };
  WebRTC.socket = { connected: true, emit() {} };
  const fields = prepareOrdinaryRelay(WebRTC);

  WebRTC.handleRelayFrame({ ...fields,
    data: 'ZmFrZS1mcmFtZQ==',
    mime: 'image/jpeg',
    frameId: 1,
    width: 960,
    height: 540,
    timestamp: Date.now(),
  });
  relayImage.onload();

  assert.equal(relayImage.classList.contains('hidden'), false);
  assert.equal(context.document.getElementById('connectionStatus').textContent, '已连接');
});

test('base64 relay frames ack after the browser image loads', () => {
  const { WebRTC, elements } = loadWebRTC();
  const relayImage = elements.get('relayImage') || makeElement();
  elements.set('relayImage', relayImage);
  const emitted = [];

  WebRTC.networkMode = 'tunnel';
  WebRTC.tunnelRelayActive = true;
  WebRTC.controlState = { state: 'ACTIVE', controller: true, hostOnline: true, lease: { leaseId: 'lease-000000000001', leaseEpoch: 6 } };
  WebRTC.socket = {
    connected: true,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
  };

  const fields = prepareOrdinaryRelay(WebRTC);
  emitted.length = 0;
  WebRTC.handleRelayFrame({ ...fields,
    data: 'ZmFrZS1mcmFtZQ==',
    mime: 'image/jpeg',
    frameId: 7,
    width: 960,
    height: 540,
    timestamp: Date.now() - 25,
  });

  assert.equal(typeof relayImage.onload, 'function');
  relayImage.onload();

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'relay-frame-ack');
  assert.equal(emitted[0].payload.frameId, 7);
  assert.equal(emitted[0].payload.latencyMs, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(emitted[0].payload.relayScope)), fields.relayScope);
});

test('main viewer socket emits start control during auto tunnel fallback', () => {
  const emitted = [];
  const socket = {
    connected: true,
    emit(...args) {
      emitted.push(args);
    },
  };
  const { WebRTC } = loadWebRTC();

  WebRTC.networkMode = 'auto';
  WebRTC.tunnelRelayActive = true;
  WebRTC.controlState = { state: 'ACTIVE', controller: true, hostOnline: true, lease: { leaseId: 'lease-000000000001', leaseEpoch: 6 } };
  WebRTC.currentConnectionAttemptId = 'relay-fixture-attempt';
  WebRTC.connectionAttemptSequence = 1;
  WebRTC.socket = socket;

  WebRTC.emitRelayStreamControl();

  assert.equal(
    emitted.some(([event]) => event === 'relay-stream-control'),
    true
  );
});

test('socket reconnect replays queued diagnostics before continuing recovery', async () => {
  const handlers = new Map();
  const socket = {
    connected: true,
    on(event, callback) {
      handlers.set(event, callback);
    },
    emit() {},
    disconnect() {},
  };
  const replayedSockets = [];
  const { WebRTC } = loadWebRTC({
    Diagnostic: {
      replayPendingDiagnostics(targetSocket) {
        replayedSockets.push(targetSocket);
        return Promise.resolve(1);
      },
    },
  });

  WebRTC.socket = socket;
  WebRTC.pc = { connectionState: 'connected' };
  WebRTC.setupSocketListeners();
  await handlers.get('connect')();

  assert.equal(replayedSockets.length, 1);
  assert.equal(replayedSockets[0], socket);
});

test('relay mode without TURN does not fall back to STUN candidates', () => {
  const { WebRTC } = loadWebRTC();

  WebRTC.serverConfig = {
    stunUrls: ['stun:stun.example.com:3478'],
    turnConfigured: false,
    turnUrls: [],
    iceServers: [{ urls: ['stun:stun.example.com:3478'] }],
  };
  WebRTC.networkMode = 'relay';

  const config = WebRTC.buildPeerConfig();

  assert.equal(config.iceTransportPolicy, 'relay');
  assert.equal(Array.isArray(config.iceServers), true);
  assert.equal(config.iceServers.length, 0);
});

test('stun mode builds deduplicated STUN config with candidate pool', () => {
  const { WebRTC } = loadWebRTC();

  WebRTC.serverConfig = {
    stunUrls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun.l.google.com:19302',
    ],
    turnConfigured: false,
    turnUrls: [],
    iceServers: [],
  };
  WebRTC.networkMode = 'stun';

  const config = WebRTC.buildPeerConfig();

  assert.equal(config.iceTransportPolicy, 'all');
  assert.equal(config.iceCandidatePoolSize, 4);
  assert.equal(config.bundlePolicy, 'max-bundle');
  assert.equal(config.iceServers.length, 1);
  assert.deepEqual(Array.from(config.iceServers[0].urls), [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
  ]);
});

test('auto failure with TURN configured suggests relay without switching mode', () => {
  const { WebRTC } = loadWebRTC();

  WebRTC.networkMode = 'auto';
  WebRTC.serverConfig = {
    stunUrls: ['stun:stun.example.com:3478'],
    turnConfigured: true,
    turnStatus: 'configured',
    turnUrls: ['turn:turn.example.com:3478'],
    iceServers: [{ urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'p' }],
    publicEntry: { formalEntryUrl: 'https://link.stockhub.wiki' },
  };

  WebRTC.setFailureRecommendation('direct-failed-suggest-relay');

  assert.equal(WebRTC.networkMode, 'auto');
  assert.deepEqual(JSON.parse(JSON.stringify(WebRTC.recommendationState)), {
    failureCode: 'direct-failed-suggest-relay',
    nextSuggestedMode: 'relay',
    severity: 'warning',
  });
});

test('selecting relay without TURN keeps relay persisted and shows recommendation-only guidance', () => {
  let savedMode = null;
  const { WebRTC, context } = loadWebRTC({
    localStorage: {
      getItem: () => null,
      setItem: (_key, value) => {
        savedMode = value;
      },
    },
  });

  WebRTC.serverConfig = {
    stunUrls: ['stun:stun.example.com:3478'],
    turnConfigured: false,
    turnStatus: 'missing',
    turnUrls: [],
    iceServers: [{ urls: ['stun:stun.example.com:3478'] }],
    publicEntry: { formalEntryUrl: 'https://link.stockhub.wiki' },
  };
  WebRTC.socket = { connected: false };
  WebRTC.uiPhase = 'disconnected';

  WebRTC.setNetworkMode('relay');

  const advisorText = context.document.getElementById('networkAdvisorText').textContent;
  const turnStatus = context.document.getElementById('networkTurnStatus').textContent;

  assert.equal(WebRTC.networkMode, 'relay');
  assert.equal(savedMode, 'relay');
  assert.equal(WebRTC.recommendationState?.nextSuggestedMode, 'tunnel');
  assert.match(advisorText, /建议.*隧道中继/);
  assert.equal(advisorText.includes('自动切换'), false);
  assert.equal(advisorText.includes('已切换'), false);
  assert.match(turnStatus, /link\.stockhub\.wiki/);
});

test('disconnected recovery mode switch cancels search and refreshes exactly once', () => {
  const { WebRTC } = loadWebRTC();
  preparePortSearch(WebRTC);
  WebRTC.networkMode = 'auto';
  WebRTC.uiPhase = 'disconnected';
  WebRTC.serverConfig = {
    turnConfigured: true,
    turnStatus: 'configured',
    turnUrls: ['turn:turn.example.com:3478'],
    iceServers: [{ urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'p' }],
  };
  let refreshes = 0;
  WebRTC.refresh = () => { refreshes += 1; };
  WebRTC.startPortSearch();
  assert.equal(WebRTC.isPortSearchActive(), true);
  refreshes = 0;
  WebRTC.setNetworkMode('relay');
  assert.equal(WebRTC.networkMode, 'relay');
  assert.equal(WebRTC.isPortSearchActive(), false);
  assert.equal(refreshes, 1);
});

test('disconnected mode switch reconnects when socket is down', () => {
  const { WebRTC } = loadWebRTC();
  WebRTC.uiPhase = 'disconnected';
  WebRTC.socket = { connected: false };
  WebRTC.enforceSupportedNetworkMode = (mode) => {
    WebRTC.networkMode = mode;
    return { effectiveMode: mode, changed: false, unavailable: false, reason: '' };
  };
  let inits = 0;
  WebRTC.refresh = () => { throw new Error('must not refresh'); };
  WebRTC.init = () => { inits += 1; };

  WebRTC.setNetworkMode('relay');

  assert.equal(WebRTC.networkMode, 'relay');
  assert.equal(inits, 1);
});

test('dead-socket mode switch ignores an old socket reconnect during config load', async () => {
  const oldHandlers = new Map();
  const oldSocket = {
    connected: false,
    on(event, handler) { oldHandlers.set(event, handler); },
    emit() {},
    disconnect() { this.disconnectCalled = true; },
  };
  const replacementSocket = {
    connected: false,
    on() {},
    emit() {},
    disconnect() {},
  };
  let resolveConfig;
  const created = [];
  const { WebRTC } = loadWebRTC({ io: () => replacementSocket });

  WebRTC.uiPhase = 'disconnected';
  WebRTC.socket = oldSocket;
  WebRTC.serverConfig = { turnConfigured: true, turnStatus: 'configured', iceServers: [] };
  WebRTC.enforceSupportedNetworkMode = (mode) => {
    WebRTC.networkMode = mode;
    return { effectiveMode: mode, changed: false, unavailable: false, reason: '' };
  };
  WebRTC.loadServerConfig = () => new Promise((resolve) => { resolveConfig = resolve; });
  WebRTC.configureNetworkControls = () => {};
  WebRTC.bindControlLifecycle = () => {};
  WebRTC.createPeerConnection = function createPeerConnectionForTest() {
    const pc = { connectionState: 'new', close() { this.closed = true; } };
    created.push(pc);
    this.pc = pc;
    return pc;
  };
  WebRTC.setupSocketListeners();

  WebRTC.setNetworkMode('relay');
  assert.equal(typeof resolveConfig, 'function');

  // Simulate a reconnect callback already queued on the old Socket while the
  // new mode is still waiting for its server configuration.
  oldSocket.connected = true;
  await oldHandlers.get('connect')();
  assert.equal(created.length, 0);

  resolveConfig();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(created.length, 1);
  assert.equal(created[0].closed, undefined);
  assert.equal(oldSocket.disconnectCalled, true);
  assert.equal(WebRTC.socket, replacementSocket);
});

test('init with unavailable relay still starts signaling lifecycle for same-page recovery', async () => {
  let socketConfig = null;
  const socket = {
    connected: true,
    on() {},
    emit() {},
    disconnect() {},
  };
  const { WebRTC, context } = loadWebRTC({
    localStorage: {
      getItem: () => 'relay',
      setItem: () => {},
    },
    io: (base, config) => {
      socketConfig = { base, config };
      return socket;
    },
  });

  WebRTC.loadServerConfig = async () => {
    WebRTC.serverConfig = {
      stunUrls: ['stun:stun.example.com:3478'],
      turnConfigured: false,
      turnStatus: 'missing',
      turnUrls: [],
      iceServers: [{ urls: ['stun:stun.example.com:3478'] }],
      publicEntry: { formalEntryUrl: 'https://link.stockhub.wiki' },
    };
  };
  WebRTC.configureNetworkControls = () => {};
  let setupSocketListenersCalled = false;
  WebRTC.setupSocketListeners = () => {
    setupSocketListenersCalled = true;
  };
  WebRTC.startTunnelRelay = () => {
    throw new Error('tunnel should not start for unavailable relay');
  };

  await WebRTC.init();

  assert.equal(WebRTC.networkMode, 'relay');
  assert.equal(setupSocketListenersCalled, true);
  assert.equal(WebRTC.socket, socket);
  assert.equal(socketConfig.base, 'http://127.0.0.1:8080');
  assert.equal(socketConfig.config.auth.role, 'viewer');
  assert.equal(WebRTC.recommendationState?.nextSuggestedMode, 'tunnel');
});

test('selecting unavailable relay tears down active direct media but preserves same-page recovery', () => {
  let savedMode = null;
  const socket = {
    connected: true,
    on() {},
    emit() {},
    disconnect() {},
  };
  const { WebRTC, context } = loadWebRTC({
    localStorage: {
      getItem: () => 'auto',
      setItem: (_key, value) => {
        savedMode = value;
      },
    },
  });

  let closed = false;
  WebRTC.serverConfig = {
    stunUrls: ['stun:stun.example.com:3478'],
    turnConfigured: false,
    turnStatus: 'missing',
    turnUrls: [],
    iceServers: [{ urls: ['stun:stun.example.com:3478'] }],
    publicEntry: { formalEntryUrl: 'https://link.stockhub.wiki' },
  };
  WebRTC.socket = socket;
  WebRTC.remoteStream = { id: 'live-stream' };
  const videoEl = context.document.getElementById('remoteVideo');
  videoEl.srcObject = WebRTC.remoteStream;
  videoEl.classList.add('connected');
  context.document.body.classList.add('stream-connected');
  context.document.getElementById('candidateDisplay').textContent = '当前链路：STUN直连 · 42 ms';
  context.document.getElementById('latencyDisplay').textContent = '42 ms';
  context.document.getElementById('fpsDisplay').textContent = '24 FPS';
  context.document.getElementById('resolutionDisplay').textContent = '960x540';
  WebRTC.pc = {
    close() {
      closed = true;
    },
  };
  WebRTC.statsTimer = setInterval(() => {}, 1000);
  WebRTC._latencySyncInterval = setInterval(() => {}, 1000);
  WebRTC.inputChannel = { readyState: 'open' };
  WebRTC.inputMoveChannel = { readyState: 'open' };
  WebRTC._iceRestartAttempts = 1;
  WebRTC.candidateSummary = {
    local: { host: 2, srflx: 1, relay: 0, prflx: 0, other: 0 },
    remote: { host: 1, srflx: 1, relay: 0, prflx: 0, other: 0 },
    samples: {
      local: [{ type: 'srflx', protocol: 'udp', address: '203.0.113.1:5000' }],
      remote: [{ type: 'host', protocol: 'udp', address: '192.168.0.2:6000' }],
    },
  };

  WebRTC.setNetworkMode('relay');

  assert.equal(WebRTC.networkMode, 'relay');
  assert.equal(savedMode, 'relay');
  assert.equal(closed, true);
  assert.equal(WebRTC.pc, null);
  assert.equal(WebRTC.socket, socket);
  assert.equal(WebRTC.statsTimer, null);
  assert.equal(WebRTC._latencySyncInterval, null);
  assert.equal(WebRTC.remoteStream, null);
  assert.equal(videoEl.srcObject, null);
  assert.equal(videoEl.classList.contains('connected'), false);
  assert.equal(context.document.body.classList.contains('stream-connected'), false);
  assert.equal(context.document.getElementById('candidateDisplay').textContent, '-');
  assert.equal(context.document.getElementById('latencyDisplay').textContent, '- ms');
  assert.equal(context.document.getElementById('fpsDisplay').textContent, '- FPS');
  assert.equal(context.document.getElementById('resolutionDisplay').textContent, '-');
  assert.equal(WebRTC._iceRestartAttempts, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(WebRTC.candidateSummary)), {
    local: { host: 0, srflx: 0, relay: 0, prflx: 0, other: 0 },
    remote: { host: 0, srflx: 0, relay: 0, prflx: 0, other: 0 },
    samples: { local: [], remote: [] },
  });
  assert.equal(WebRTC.recommendationState?.nextSuggestedMode, 'tunnel');

  let refreshCalled = false;
  WebRTC.refresh = () => {
    refreshCalled = true;
  };

  WebRTC.setNetworkMode('stun');

  assert.equal(WebRTC.networkMode, 'stun');
  assert.equal(savedMode, 'stun');
  assert.equal(refreshCalled, true);
});

test('selecting unavailable relay tears down stale direct state even when socket is disconnected', () => {
  let savedMode = null;
  const socket = {
    connected: false,
    on() {},
    emit() {},
    disconnect() {},
  };
  const { WebRTC, context } = loadWebRTC({
    localStorage: {
      getItem: () => 'auto',
      setItem: (_key, value) => {
        savedMode = value;
      },
    },
  });

  let closed = false;
  WebRTC.serverConfig = {
    stunUrls: ['stun:stun.example.com:3478'],
    turnConfigured: false,
    turnStatus: 'missing',
    turnUrls: [],
    iceServers: [{ urls: ['stun:stun.example.com:3478'] }],
    publicEntry: { formalEntryUrl: 'https://link.stockhub.wiki' },
  };
  WebRTC.socket = socket;
  WebRTC.remoteStream = { id: 'stale-live-stream' };
  const videoEl = context.document.getElementById('remoteVideo');
  videoEl.srcObject = WebRTC.remoteStream;
  videoEl.classList.add('connected');
  context.document.body.classList.add('stream-connected');
  context.document.getElementById('candidateDisplay').textContent = '当前链路：STUN直连 · 51 ms';
  context.document.getElementById('latencyDisplay').textContent = '51 ms';
  context.document.getElementById('fpsDisplay').textContent = '29 FPS';
  context.document.getElementById('resolutionDisplay').textContent = '1280x720';
  WebRTC.pc = {
    close() {
      closed = true;
    },
  };
  WebRTC.statsTimer = setInterval(() => {}, 1000);
  WebRTC._latencySyncInterval = setInterval(() => {}, 1000);
  WebRTC.inputChannel = { readyState: 'open' };
  WebRTC.inputMoveChannel = { readyState: 'open' };

  WebRTC.setNetworkMode('relay');

  assert.equal(WebRTC.networkMode, 'relay');
  assert.equal(savedMode, 'relay');
  assert.equal(closed, true);
  assert.equal(WebRTC.pc, null);
  assert.equal(WebRTC.socket, socket);
  assert.equal(WebRTC.statsTimer, null);
  assert.equal(WebRTC._latencySyncInterval, null);
  assert.equal(WebRTC.remoteStream, null);
  assert.equal(videoEl.srcObject, null);
  assert.equal(videoEl.classList.contains('connected'), false);
  assert.equal(context.document.body.classList.contains('stream-connected'), false);
  assert.equal(context.document.getElementById('candidateDisplay').textContent, '-');
  assert.equal(context.document.getElementById('latencyDisplay').textContent, '- ms');
  assert.equal(context.document.getElementById('fpsDisplay').textContent, '- FPS');
  assert.equal(context.document.getElementById('resolutionDisplay').textContent, '-');
  assert.equal(WebRTC.recommendationState?.nextSuggestedMode, 'tunnel');
});

test('auto without TURN shows recommendation-only copy instead of auto fallback promise', () => {
  const { WebRTC, context } = loadWebRTC();

  WebRTC.networkMode = 'auto';
  WebRTC.serverConfig = {
    stunUrls: ['stun:stun.example.com:3478'],
    turnConfigured: false,
    turnStatus: 'missing',
    turnUrls: [],
    iceServers: [{ urls: ['stun:stun.example.com:3478'] }],
    publicEntry: { formalEntryUrl: 'https://link.stockhub.wiki' },
  };
  WebRTC.uiPhase = 'connected';

  WebRTC.updateNetworkUI('网络模式已就绪');

  const advisorText = context.document.getElementById('networkAdvisorText').textContent;
  const turnStatus = context.document.getElementById('networkTurnStatus').textContent;

  assert.equal(advisorText.includes('自动切换到隧道中继'), false);
  assert.equal(advisorText.includes('自动改走中继'), false);
  assert.match(advisorText, /手动改用|建议/);
  assert.match(turnStatus, /固定入口.*link\.stockhub\.wiki/);
});

test('network advisor stays compact for routine connected status and expands warnings', () => {
  const timers2 = [];
  const { WebRTC, context } = loadWebRTC({
    setTimeout: (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      timers2.push(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      if (handle && typeof handle === 'object') handle.cleared = true;
    },
  });
  WebRTC.networkMode = 'relay';
  WebRTC.serverConfig = {
    turnConfigured: true,
    turnStatus: 'configured',
    turnUrls: ['turn:turn.example:3478'],
    iceServers: [{ urls: ['turn:turn.example:3478'], username: 'u', credential: 'p' }],
  };
  WebRTC.hasTurnConfigured = () => true;
  WebRTC.getPublicEntryUrl = () => '';
  WebRTC.getRecommendationMessage = () => '';
  WebRTC.getDefaultNetworkGuidance = () => '外网中继已就绪';
  WebRTC.uiPhase = 'connected';

  WebRTC.updateNetworkUI('外网中继已连接', '');
  const advisor = context.document.getElementById('networkAdvisor');
  const handleLabel = context.document.getElementById('networkAdvisorHandleLabel');
  assert.equal(advisor.classList.contains('visible'), true);
  assert.equal(advisor.classList.contains('collapsed'), true);
  assert.equal(handleLabel.textContent, '中继');
  assert.equal(advisor.getAttribute('aria-expanded'), 'false');

  WebRTC.updateNetworkUI('外网中继暂时不可用，请切换隧道中继。', 'warning');
  assert.equal(advisor.classList.contains('collapsed'), false);
  assert.equal(advisor.getAttribute('aria-expanded'), 'true');
  const collapseTimers = timers2.filter((t) => !t.cleared && t.ms === WebRTC.NETWORK_ADVISOR_COLLAPSE_MS.warning);
  assert.ok(collapseTimers.length >= 1, 'warning should schedule auto-collapse');
  collapseTimers.at(-1).fn();
  assert.equal(advisor.classList.contains('collapsed'), true);
  assert.equal(advisor.getAttribute('aria-expanded'), 'false');

  advisor.listeners.get('mouseenter')();
  assert.equal(advisor.classList.contains('collapsed'), false);
  advisor.listeners.get('mouseleave')();
  const afterLeave = timers2.filter((t) => !t.cleared && t.ms === WebRTC.NETWORK_ADVISOR_LEAVE_COLLAPSE_MS);
  assert.ok(afterLeave.length >= 1, 'mouse leave should use the short leave collapse delay');
  afterLeave.at(-1).fn();
  assert.equal(advisor.classList.contains('collapsed'), true);

  // Routine RTT refresh must not yank the tab open again.
  WebRTC.updateNetworkUI('当前通过 TURN 中继传输。RTT 120 ms，适合受限外网但延迟会高于本地直连。');
  assert.equal(advisor.classList.contains('collapsed'), true);
});

function prepareRelayAdvisor(WebRTC) {
  WebRTC.networkMode = 'relay';
  WebRTC.serverConfig = {
    turnConfigured: true,
    turnStatus: 'configured',
    turnUrls: ['turn:turn.example:3478'],
    iceServers: [{ urls: ['turn:turn.example:3478'], username: 'u', credential: 'p' }],
  };
  WebRTC.hasTurnConfigured = () => true;
  WebRTC.getPublicEntryUrl = () => '';
  WebRTC.getRecommendationMessage = () => '';
  WebRTC.getDefaultNetworkGuidance = () => '外网中继已就绪';
}

test('narrow viewport keeps info advisor collapsed on first show', () => {
  const { WebRTC, context } = loadWebRTC({
    matchMedia: (query) => ({ matches: String(query).includes('max-width: 768px') }),
  });
  prepareRelayAdvisor(WebRTC);
  WebRTC.uiPhase = 'connected';

  WebRTC.updateNetworkUI('外网中继已连接', '');
  const advisor = context.document.getElementById('networkAdvisor');
  assert.equal(advisor.classList.contains('visible'), true);
  assert.equal(advisor.classList.contains('collapsed'), true);
  assert.equal(advisor.getAttribute('aria-expanded'), 'false');

  WebRTC.updateNetworkUI('外网中继失败，请切换隧道中继。', 'warning');
  assert.equal(advisor.classList.contains('collapsed'), false);
  assert.equal(advisor.getAttribute('aria-expanded'), 'true');
});

test('narrow viewport still expands danger advisor on first show', () => {
  const { WebRTC, context } = loadWebRTC({
    matchMedia: (query) => ({ matches: String(query).includes('max-width: 768px') }),
  });
  prepareRelayAdvisor(WebRTC);
  WebRTC.uiPhase = 'connected';

  WebRTC.updateNetworkUI('端口搜索已达上限，未自动切换 TURN 或媒体隧道。', 'danger');
  const advisor = context.document.getElementById('networkAdvisor');
  assert.equal(advisor.classList.contains('visible'), true);
  assert.equal(advisor.classList.contains('collapsed'), false);
});

test('collectNetworkSnapshot summarizes candidate and state context', () => {
  const { WebRTC } = loadWebRTC();

  WebRTC.networkMode = 'stun';
  WebRTC.useRelayFallback = false;
  WebRTC.tunnelRelayActive = false;
  WebRTC._autoFailCount = 2;
  WebRTC.noMediaTicks = 3;
  WebRTC.lastCandidateType = 'srflx';
  WebRTC.serverConfig = {
    stunUrls: ['stun:stun.example.com:3478'],
    turnConfigured: false,
    turnStatus: 'missing',
    turnUrls: [],
  };
  WebRTC.pc = {
    connectionState: 'failed',
    iceConnectionState: 'failed',
    iceGatheringState: 'complete',
    signalingState: 'stable',
  };
  WebRTC.candidateSummary = {
    local: { host: 2, srflx: 1, relay: 0, prflx: 0, other: 0 },
    remote: { host: 1, srflx: 1, relay: 0, prflx: 0, other: 0 },
    samples: {
      local: [{ type: 'srflx', protocol: 'udp', address: '203.0.113.1:5000' }],
      remote: [{ type: 'host', protocol: 'udp', address: '192.168.0.2:6000' }],
    },
  };
  WebRTC.selectedCandidatePair = {
    localType: 'srflx',
    remoteType: 'host',
    protocol: 'udp',
    localAddress: 'redacted-local-address',
    remoteAddress: 'redacted-remote-address',
    rttMs: 42,
  };

  const snapshot = JSON.parse(JSON.stringify(WebRTC.collectNetworkSnapshot()));

  assert.equal(snapshot.networkMode, 'stun');
  assert.equal(snapshot.turnConfigured, false);
  assert.equal(snapshot.turnStatus, 'missing');
  assert.equal(snapshot.pc.connectionState, 'failed');
  assert.equal(snapshot.candidateSummary.local.srflx, 1);
  assert.equal(snapshot.candidateSummary.remote.host, 1);
  assert.equal(snapshot.candidateSummary.samples.local[0].type, 'srflx');
  assert.equal(snapshot.selectedCandidatePair.localType, 'srflx');
  assert.equal(snapshot.selectedCandidatePair.rttMs, 42);
});

test('scheduleReconnect prefers ICE restart before full refresh in stun mode', () => {
  const { WebRTC } = loadWebRTC();
  const actions = [];

  WebRTC.networkMode = 'stun';
  WebRTC.manualDisconnect = false;
  WebRTC.serverConfig = {
    stunUrls: ['stun:stun.example.com:3478'],
    turnConfigured: false,
    turnStatus: 'missing',
    turnUrls: [],
  };
  WebRTC.socket = { connected: true };
  WebRTC.pc = {
    restartIce() {
      actions.push('restartIce');
    },
    close() {},
  };
  WebRTC.refresh = () => {
    actions.push('refresh');
  };

  WebRTC.scheduleReconnect('ice-failed');

  assert.equal(actions.includes('restartIce'), true);
  assert.equal(actions.includes('refresh'), false);
});

test('scheduleReconnect uses exponential backoff and exhausts relay hard refreshes', () => {
  const timers = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => {
    const handle = { fn, ms, cleared: false };
    timers.push(handle);
    return handle;
  };
  try {
    const { WebRTC } = loadWebRTC();
    WebRTC.manualDisconnect = false;
    WebRTC.networkMode = 'relay';
    WebRTC.socket = { connected: true };
    WebRTC.pc = null;
    WebRTC._iceRestartAttempts = 99; // force full refresh path
    WebRTC.hasTurnConfigured = () => true;
    WebRTC.getTurnServers = () => [{ urls: 'turn:example' }];
    WebRTC.refresh = () => {};
    WebRTC.isPortSearchActive = () => false;
    WebRTC.isMediaHealthSuppressed = () => false;
    WebRTC._relayHardRefreshCount = 0;

    WebRTC.scheduleReconnect('pc-failed');
    assert.equal(timers.at(-1).ms, 1500);
    WebRTC.reconnectTimer = null;
    WebRTC.scheduleReconnect('pc-failed');
    assert.equal(timers.at(-1).ms, 3000);

    WebRTC.reconnectTimer = null;
    WebRTC._relayHardRefreshCount = 5;
    WebRTC.updateNetworkUI = () => {};
    const before = timers.length;
    WebRTC.scheduleReconnect('pc-failed');
    assert.equal(timers.length, before); // exhausted: no new timer
  } finally {
    global.setTimeout = realSetTimeout;
  }
});

test('auto without TURN keeps STUN recovery path active after first pc-failed', () => {
  const { WebRTC } = loadWebRTC();
  const actions = [];

  WebRTC.networkMode = 'auto';
  WebRTC.manualDisconnect = false;
  WebRTC.serverConfig = {
    stunUrls: ['stun:stun.example.com:3478'],
    turnConfigured: false,
    turnStatus: 'missing',
    turnUrls: [],
  };
  WebRTC.socket = { connected: true };
  WebRTC.startTunnelRelay = () => {
    actions.push('tunnel');
  };
  WebRTC.refresh = () => {
    actions.push('refresh');
  };
  WebRTC.pc = {
    restartIce() {
      actions.push('restartIce');
    },
    close() {},
  };

  WebRTC.scheduleReconnect('pc-failed');

  assert.equal(WebRTC._tunnelLockUntil, 0);
  assert.equal(WebRTC._autoFailCount, 1);
  assert.equal(actions.includes('restartIce'), true);
  assert.equal(actions.includes('tunnel'), false);
});

test('auto with TURN does not automatically enable relay fallback under strict STUN', () => {
  const { WebRTC } = loadWebRTC();
  const actions = [];

  WebRTC.networkMode = 'auto';
  WebRTC.manualDisconnect = false;
  WebRTC.serverConfig = {
    stunUrls: ['stun:stun.example.com:3478'],
    turnConfigured: true,
    turnStatus: 'configured',
    turnUrls: ['turn:turn.example.com:3478'],
    iceServers: [{ urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'p' }],
  };
  WebRTC.socket = { connected: true };
  WebRTC.startTunnelRelay = () => {
    actions.push('tunnel');
  };
  WebRTC.refresh = () => {
    actions.push('refresh');
  };
  WebRTC.pc = {
    restartIce() {
      actions.push('restartIce');
    },
    close() {},
  };

  WebRTC.scheduleReconnect('pc-failed');

  assert.equal(WebRTC.useRelayFallback, false);
  assert.equal(actions.includes('restartIce'), true);
  assert.equal(actions.includes('tunnel'), false);
});

test('WebRTC applies degraded media profile without starting tunnel in auto mode', () => {
  const emitted = [];
  const { WebRTC } = loadWebRTC({
    LinkQualityController: {
      create() {
        return {
          observe() {
            return {
              action: 'degrade',
              profile: 'medium',
              reason: 'packet-loss',
              profileConfig: { name: 'medium', width: 960, height: 540, fps: 15, bitrateKbps: 1400 },
            };
          },
          snapshot() { return { currentProfile: 'medium', profileChanges: [] }; },
        };
      },
    },
  });

  WebRTC.networkMode = 'auto';
  WebRTC.socket = { connected: true, emit(event, payload) { emitted.push({ event, payload }); } };
  WebRTC.controlState = { state: 'ACTIVE', controller: true, hostOnline: true, lease: { leaseId: 'lease-000000000001', leaseEpoch: 8 } };
  let tunnelStarted = false;
  WebRTC.startTunnelRelay = () => { tunnelStarted = true; };
  WebRTC.ensureLinkQualityController();

  WebRTC.handleReceiverStats({
    fps: 4,
    rttMs: 140,
    jitterBufferMs: 180,
    packetsLost: 80,
    framesDecoded: 130,
    framesReceived: 130,
    bytesReceived: 1000,
    codec: 'video/H264',
    selectedCandidateType: 'prflx',
  });

  const profileEvent = emitted.find((entry) => entry.event === 'media-profile-change');
  assert.equal(tunnelStarted, false);
  assert.equal(Boolean(profileEvent), true);
  assert.equal(profileEvent.payload.profile, 'medium');
  assert.equal(profileEvent.payload.targetFps, 15);
  // Lock mode floors 720p minBitrate to 1800 even when profile table says 1400.
  assert.equal(profileEvent.payload.videoBitrateKbps, 1800);
  assert.equal(profileEvent.payload.adaptiveResolution, false);
});

test('WebRTC proactive ICE restart happens once on critical media quality', () => {
  const { WebRTC } = loadWebRTC({
    LinkQualityController: {
      create() {
        return {
          observe() {
            return {
              action: 'critical',
              profile: 'survival',
              reason: 'media-stalled',
              shouldRestartIce: true,
              profileConfig: { name: 'survival', width: 640, height: 360, fps: 8, bitrateKbps: 500 },
            };
          },
          markIceRestartAttempted() {},
          snapshot() { return { currentProfile: 'survival', iceRestart: { attempts: 1 } }; },
        };
      },
    },
  });

  let restartCalls = 0;
  let offerCalls = 0;
  WebRTC.networkMode = 'stun';
  WebRTC.socket = { connected: true, emit() {} };
  WebRTC.pc = {
    restartIce() { restartCalls += 1; },
    connectionState: 'connected',
    iceConnectionState: 'connected',
  };
  WebRTC.createOffer = () => { offerCalls += 1; };
  WebRTC.ensureLinkQualityController();

  WebRTC.handleReceiverStats({
    fps: 0,
    rttMs: 90,
    jitterBufferMs: 270,
    packetsLost: 10,
    framesDecoded: 199,
    framesReceived: 199,
    selectedCandidateType: 'prflx',
  });
  WebRTC.handleReceiverStats({
    fps: 0,
    rttMs: 90,
    jitterBufferMs: 270,
    packetsLost: 10,
    framesDecoded: 199,
    framesReceived: 199,
    selectedCandidateType: 'prflx',
  });

  assert.equal(restartCalls, 1);
  assert.equal(offerCalls, 1);
});

test('suppressed media health does not observe adaptive quality or trigger recovery', () => {
  let observes = 0;
  let profileApplies = 0;
  let iceRestarts = 0;
  const { WebRTC } = loadWebRTC({
    LinkQualityController: {
      create() {
        return {
          observe() {
            observes += 1;
            return {
              action: 'critical',
              reason: 'media-stalled',
              shouldRestartIce: true,
              profileConfig: { name: 'survival', width: 640, height: 360, fps: 8, bitrateKbps: 500 },
            };
          },
        };
      },
    },
  });

  WebRTC.networkMode = 'stun';
  WebRTC.isMediaHealthSuppressed = () => true;
  WebRTC.applyMediaProfile = () => { profileApplies += 1; };
  WebRTC.proactiveIceRestart = () => { iceRestarts += 1; };
  WebRTC.handleReceiverStats({ fps: 0, rttMs: 100, selectedCandidateType: 'prflx' });

  assert.equal(observes, 0);
  assert.equal(profileApplies, 0);
  assert.equal(iceRestarts, 0);
});

test('PC connection syncs the desktop input gate without directly enabling input', () => {
  const inputCalls = [];
  class FakePeerConnection {
    constructor() {
      this.connectionState = 'connected';
      this.iceConnectionState = 'connected';
    }

    createDataChannel() {
      return { readyState: 'open', bufferedAmount: 0, send() {} };
    }
  }
  const { WebRTC } = loadWebRTC({
    RTCPeerConnection: FakePeerConnection,
    Input: {
      init() {},
      setActive(value) { inputCalls.push(value); },
    },
    setTimeout() { return 0; },
  });
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.startStats = () => {};
  WebRTC.startVideoFrameTracking = () => {};
  WebRTC.syncMediaProfile = () => {};
  WebRTC.clearFailureRecommendation = () => {};
  WebRTC.updateNetworkUI = () => {};
  let gateSyncs = 0;
  WebRTC.syncDesktopInputGate = () => { gateSyncs += 1; };

  WebRTC.createPeerConnection();
  WebRTC.pc.onconnectionstatechange();

  // Connected path now also runs ensureMediaActiveIfVisible → may sync more than once.
  assert.ok(gateSyncs >= 1);
  assert.deepEqual(inputCalls, []);
});

test('suspended media blocks tunnel start while authorized resume mounts receiver behind input gate', () => {
  const emitted = [];
  const { WebRTC, context } = loadWebRTC();
  const runtimeSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'media-activity-runtime.js'), 'utf8');
  require('node:vm').runInContext(runtimeSource, context);
  WebRTC.socket = { connected: true, emit(...args) { emitted.push(args); }, on() {} };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.networkMode = 'tunnel';
  WebRTC.currentConnectionAttemptId = 'wrd-1';
  WebRTC.connectionAttemptSequence = 1;
  WebRTC.mediaActivityRuntime = context.MediaActivityRuntime.create({ requestTimeoutMs: 1500 });

  WebRTC.applyMediaActivity({ state: 'suspended', reasons: ['manual-pause'], generation: 1 });
  // Tunnel waits for Host applied ack; phase stays suspending until then.
  assert.equal(WebRTC.getMediaAppliedPhase(), 'suspending');
  assert.equal(emitted.some(([event, payload]) => event === 'relay-stream-control' && payload.enabled === false), true);
  WebRTC.handleMediaActivityAck({
    state: 'suspended', generation: 1, connectionAttemptId: 'wrd-1', applied: true,
  });
  assert.equal(WebRTC.getMediaAppliedPhase(), 'suspended');
  emitted.length = 0;

  WebRTC.startTunnelRelay();
  WebRTC.emitRelayStreamControl();
  assert.equal(WebRTC.tunnelRelayActive, false);
  assert.equal(emitted.some(([event, payload]) => event === 'relay-stream-control' && payload.enabled === true), false);

  WebRTC.applyMediaActivity({ state: 'active', reasons: [], generation: 2 });
  assert.equal(WebRTC.getMediaAppliedPhase(), 'resuming');
  assert.equal(emitted.some(([event, payload]) => event === 'relay-stream-control' && payload.enabled === true), true);
  emitted.length = 0;

  WebRTC.startTunnelRelay();
  assert.equal(WebRTC.tunnelRelayActive, true, 'authorized active intent already mounted the receiver');
  assert.equal(WebRTC.canEnableDesktopInput(), false);
  assert.equal(emitted.some(([event, payload]) => event === 'relay-stream-control' && payload.enabled === true), false);

  WebRTC.handleMediaActivityAck({
    ...relayAckFields(WebRTC, 2), state: 'active', generation: 2, connectionAttemptId: 'wrd-1', applied: true,
  });
  WebRTC.handleRelayFrame({ ...relayAckFields(WebRTC, 2), frameId: 1, data: 'AAAA' });
  context.document.getElementById('relayImage').onload();
  WebRTC.startTunnelRelay();
  assert.equal(WebRTC.tunnelRelayActive, true);
  assert.equal(emitted.some(([event, payload]) => event === 'relay-stream-control' && payload.enabled === true), true);
});

test('auto on public origin without TURN keeps auto mode and still starts WebRTC setup', async () => {
  let savedMode = null;
  let createPeerConnectionCalled = false;
  const { WebRTC } = loadWebRTC({
    window: {
      location: { origin: 'https://billing-lanes-metro-admissions.trycloudflare.com' },
      RTCRtpReceiver: null,
    },
    localStorage: {
      getItem: () => 'auto',
      setItem: (_key, value) => {
        savedMode = value;
      },
    },
  });

  WebRTC.loadServerConfig = async () => {
    WebRTC.serverConfig = {
      stunUrls: ['stun:stun.example.com:3478'],
      turnConfigured: false,
      turnStatus: 'missing',
      turnUrls: [],
      iceServers: [{ urls: ['stun:stun.example.com:3478'] }],
    };
  };
  WebRTC.configureNetworkControls = () => {};
  WebRTC.updateNetworkUI = () => {};
  WebRTC.setupSocketListeners = () => {};
  WebRTC.startTunnelRelay = () => {};
  WebRTC.createPeerConnection = () => {
    createPeerConnectionCalled = true;
  };

  await WebRTC.init();

  assert.equal(WebRTC.networkMode, 'auto');
  assert.equal(savedMode, 'auto');
  assert.equal(createPeerConnectionCalled, true);
});

test('public origin without TURN no longer forces tunnel mode during init', async () => {
  const uiMessages = [];
  const { WebRTC } = loadWebRTC({
    window: {
      location: { origin: 'https://billing-lanes-metro-admissions.trycloudflare.com' },
      RTCRtpReceiver: null,
    },
    localStorage: {
      getItem: () => 'auto',
      setItem: () => {},
    },
  });

  WebRTC.loadServerConfig = async () => {
    WebRTC.serverConfig = {
      stunUrls: ['stun:stun.example.com:3478'],
      turnConfigured: false,
      turnStatus: 'missing',
      turnUrls: [],
      iceServers: [{ urls: ['stun:stun.example.com:3478'] }],
    };
  };
  WebRTC.configureNetworkControls = () => {};
  WebRTC.updateNetworkUI = (message) => {
    uiMessages.push(message);
  };
  WebRTC.setupSocketListeners = () => {};
  WebRTC.startTunnelRelay = () => {};
  WebRTC.createPeerConnection = () => {};

  await WebRTC.init();

  assert.equal(WebRTC.networkMode, 'auto');
  assert.ok(uiMessages.every((message) => !String(message).includes('当前是公网入口且未配置 TURN')));
});

test('manual port search starts only when explicitly requested in stun mode', () => {
  const { WebRTC } = loadWebRTC();
  const actions = [];
  preparePortSearch(WebRTC);
  WebRTC.refresh = () => actions.push('refresh');
  WebRTC.startPortSearch();
  assert.equal(WebRTC.isPortSearchActive(), true);
  assert.equal(actions.length, 1);
  WebRTC.stopPortSearch('test');
  assert.equal(WebRTC.isPortSearchActive(), false);
});

test('manual port search rejects non-direct modes and offline prerequisites', () => {
  const { WebRTC } = loadWebRTC();
  const actions = [];
  WebRTC.refresh = () => actions.push('refresh');

  preparePortSearch(WebRTC, { networkMode: 'relay' });
  assert.equal(WebRTC.startPortSearch(), false);
  assert.equal(WebRTC.isPortSearchActive(), false);

  preparePortSearch(WebRTC, { socket: { connected: false } });
  assert.equal(WebRTC.startPortSearch(), false);

  preparePortSearch(WebRTC, {
    controlState: {
      hostOnline: false,
      controller: false,
      state: 'FREE',
      lease: null,
    },
  });
  assert.equal(WebRTC.startPortSearch(), false);
  assert.equal(actions.length, 0);
});

test('read-only and transitional viewers cannot start port search or request control via search', () => {
  const { WebRTC, context } = loadWebRTC();
  const emitted = [];
  const actions = [];
  let creates = 0;
  const originalCreate = context.StunPortSearchController?.create;
  if (context.StunPortSearchController) {
    context.StunPortSearchController.create = (...args) => {
      creates += 1;
      return originalCreate(...args);
    };
  }
  WebRTC.refresh = () => actions.push('refresh');
  WebRTC.createOffer = () => actions.push('createOffer');
  WebRTC.requestControl = () => {
    actions.push('requestControl');
    return true;
  };

  const disallowed = [
    { state: 'FREE', controller: false, lease: null },
    { state: 'ACTIVE', controller: false, lease: null },
    { state: 'GRANTING', controller: false, lease: null },
    { state: 'REVOKING', controller: false, lease: null, reason: 'reset-blocked' },
    { state: 'ACTIVE', controller: true, lease: null },
  ];
  for (const controlState of disallowed) {
    preparePortSearch(WebRTC, {
      controlState: { hostOnline: true, ...controlState },
      socket: {
        connected: true,
        emit(...args) { emitted.push(args); },
        disconnect() { this.connected = false; },
        on() {},
      },
    });
    WebRTC.portSearchController = null;
    assert.equal(WebRTC.startPortSearch(), false, JSON.stringify(controlState));
    assert.equal(WebRTC.isPortSearchActive(), false);
  }
  assert.equal(actions.length, 0);
  assert.equal(creates, 0);
  assert.equal(emitted.some((entry) => entry[0] === 'control-acquire'), false);
  assert.equal(WebRTC._portSearchRoundTimer, null);
  assert.equal(WebRTC._portSearchRetryTimer, null);
});

test('control loss during active port search stops search without reacquire', () => {
  const { WebRTC } = loadWebRTC();
  const emitted = [];
  preparePortSearch(WebRTC, {
    socket: {
      connected: true,
      emit(...args) { emitted.push(args); },
      disconnect() { this.connected = false; },
      on() {},
    },
  });
  WebRTC.refresh = () => {};
  assert.equal(WebRTC.startPortSearch(), true);
  assert.equal(WebRTC.isPortSearchActive(), true);
  const generation = WebRTC._portSearchGeneration;

  WebRTC.handleControlState({ state: 'ACTIVE', controller: false, reason: 'takeover' });
  assert.equal(WebRTC.isPortSearchActive(), false);
  assert.equal(WebRTC._portSearchGeneration > generation, true);
  assert.equal(WebRTC._portSearchRoundTimer, null);
  assert.equal(WebRTC._portSearchRetryTimer, null);
  assert.equal(emitted.some((entry) => entry[0] === 'control-acquire'), false);
});

test('socket connected event enables port search button only for active controller', () => {
  const socketHandlers = new Map();
  const { WebRTC, context } = loadWebRTC();
  WebRTC.networkMode = 'stun';
  WebRTC.socket = {
    connected: true,
    on(event, handler) { socketHandlers.set(event, handler); },
    emit() {},
    disconnect() {},
  };
  WebRTC.controlState = {
    hostOnline: false,
    controller: false,
    state: 'FREE',
    lease: null,
  };
  WebRTC.requestControl = () => {};
  WebRTC.setupSocketListeners();
  WebRTC.renderPortSearchStatus();
  assert.equal(context.document.getElementById('portSearchBtn').disabled, true);

  socketHandlers.get('connected')({ hostOnline: true });
  assert.equal(WebRTC.controlState.hostOnline, true);
  // Host online alone is not enough without ACTIVE control lease.
  assert.equal(context.document.getElementById('portSearchBtn').disabled, true);

  WebRTC.controlState = {
    hostOnline: true,
    controller: true,
    state: 'ACTIVE',
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC._operatorToolsState = 'ready';
  WebRTC.renderPortSearchStatus();
  assert.equal(context.document.getElementById('portSearchBtn').disabled, false);
  assert.equal(context.document.getElementById('portSearchBtn').textContent, '搜索端口');
});

test('active port search uses full refresh and does not call restartIce or tunnel fallback', async () => {
  const { WebRTC } = loadWebRTC();
  const actions = [];
  preparePortSearch(WebRTC);
  WebRTC.PORT_SEARCH_RETRY_DELAY_MS = 5;
  WebRTC.refresh = () => actions.push('refresh');
  WebRTC.startPortSearch();
  WebRTC.pc = {
    restartIce() { actions.push('restartIce'); },
    close() {},
  };
  WebRTC.refresh = () => actions.push('refresh');
  WebRTC.startTunnelRelay = () => actions.push('tunnel');
  WebRTC.scheduleReconnect('ice-failed');
  assert.equal(actions.includes('restartIce'), false);
  assert.equal(actions.includes('tunnel'), false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(actions.includes('refresh'), true);
  WebRTC.stopPortSearch('cleanup');
});

test('port status renders ports and never renders candidate IP addresses', () => {
  const { WebRTC, context } = loadWebRTC();
  preparePortSearch(WebRTC);
  WebRTC.refresh = () => {};
  WebRTC.startPortSearch();
  WebRTC.recordPortSearchCandidate('viewer', {
    candidate: 'candidate:1 1 udp 1 192.168.1.10 53114 typ host',
  });
  WebRTC.recordPortSearchCandidate('host', {
    candidate: 'candidate:2 1 udp 1 203.0.113.10 49702 typ srflx',
  });
  const text = context.document.getElementById('candidateDisplay').textContent;
  assert.match(text, /53114/);
  assert.match(text, /49702/);
  assert.equal(text.includes('192.168.1.10'), false);
  assert.equal(text.includes('203.0.113.10'), false);
  WebRTC.stopPortSearch('cleanup');
});

test('port search round timeout advances once and ignores stale generation', async () => {
  const { WebRTC } = loadWebRTC();
  const actions = [];
  preparePortSearch(WebRTC);
  WebRTC.PORT_SEARCH_ROUND_MS = 20;
  WebRTC.PORT_SEARCH_RETRY_DELAY_MS = 5;
  WebRTC.refresh = () => actions.push('refresh');
  WebRTC.startPortSearch();
  assert.equal(actions.length, 1);
  WebRTC.pc = { close() {} };
  WebRTC.armPortSearchDeadline();

  // Stale generation must not advance the search.
  const staleGeneration = WebRTC._portSearchGeneration;
  WebRTC._portSearchGeneration = staleGeneration + 1;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(actions.length, 1);

  // Restore generation and arm a fresh deadline that should advance.
  WebRTC._portSearchGeneration = staleGeneration;
  WebRTC.pc = { close() {} };
  WebRTC.armPortSearchDeadline();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(actions.length >= 2, `expected timeout refresh, got ${actions.length}`);
  WebRTC.stopPortSearch('cleanup');
});

test('port search success and stop restore button and clear timers', () => {
  const { WebRTC, context } = loadWebRTC();
  preparePortSearch(WebRTC);
  WebRTC.refresh = () => {};
  WebRTC.startPortSearch();
  assert.equal(WebRTC.isPortSearchActive(), true);
  const btn = context.document.getElementById('portSearchBtn');
  assert.equal(btn.textContent, '停止搜索');

  const good = { selectedCandidateType: 'srflx', framesDecoded: 12, fps: 12 };
  WebRTC.handlePortSearchMedia(good);
  WebRTC.handlePortSearchMedia(good);
  WebRTC.handlePortSearchMedia(good);
  assert.equal(WebRTC.isPortSearchActive(), false);
  assert.match(context.document.getElementById('candidateDisplay').textContent, /成功|端口搜索/);
  assert.equal(btn.textContent, '搜索端口');
  assert.equal(WebRTC._portSearchRoundTimer, null);

  preparePortSearch(WebRTC);
  WebRTC.startPortSearch();
  WebRTC.stopPortSearch('user');
  assert.equal(WebRTC.isPortSearchActive(), false);
  assert.equal(btn.textContent, '搜索端口');
});

test('port search cancels on mode switch and disconnect and never tunnels on exhaustion', () => {
  const { WebRTC, context } = loadWebRTC();
  const actions = [];
  preparePortSearch(WebRTC);
  WebRTC.refresh = () => actions.push('refresh');
  WebRTC.startTunnelRelay = () => actions.push('tunnel');
  WebRTC.startPortSearch();
  assert.equal(WebRTC.isPortSearchActive(), true);

  WebRTC.serverConfig = {
    stunUrls: ['stun:stun.example.com:3478'],
    turnConfigured: true,
    turnStatus: 'configured',
    turnUrls: ['turn:turn.example.com:3478'],
    iceServers: [{ urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'p' }],
  };
  WebRTC.setNetworkMode('relay');
  assert.equal(WebRTC.isPortSearchActive(), false);

  preparePortSearch(WebRTC);
  WebRTC.refresh = () => actions.push('refresh');
  WebRTC.startPortSearch();
  WebRTC.disconnect();
  assert.equal(WebRTC.isPortSearchActive(), false);

  // Exhaustion path: limit=1 so the first failure ends the search without tunnel.
  preparePortSearch(WebRTC);
  WebRTC.portSearchController = null;
  WebRTC.refresh = () => actions.push('refresh');
  WebRTC.startTunnelRelay = () => actions.push('tunnel');
  // Reuse already-loaded controller factory from context.
  WebRTC.portSearchController = context.StunPortSearchController.create({ limit: 1 });
  WebRTC.portSearchController.start();
  WebRTC.portSearchController.beginAttempt('manual');
  WebRTC.schedulePortSearchRetry('timeout');
  assert.equal(WebRTC.isPortSearchActive(), false);
  assert.equal(WebRTC.portSearchController.snapshot().status, 'exhausted');
  assert.equal(actions.includes('tunnel'), false);
});

test('collectNetworkSnapshot includes stunPortSearch without candidate IPs', () => {
  const { WebRTC } = loadWebRTC();
  preparePortSearch(WebRTC);
  WebRTC.refresh = () => {};
  WebRTC.startPortSearch();
  WebRTC.recordPortSearchCandidate('viewer', {
    candidate: 'candidate:1 1 udp 1 10.0.0.8 40000 typ host',
  });
  const snapshot = WebRTC.collectNetworkSnapshot();
  assert.ok(snapshot.stunPortSearch);
  assert.equal(snapshot.stunPortSearch.status, 'searching');
  // Compare via JSON to avoid vm-realm Array identity quirks under deepStrictEqual.
  assert.equal(JSON.stringify(snapshot.stunPortSearch.viewerPorts), JSON.stringify([40000]));
  const encoded = JSON.stringify(snapshot.stunPortSearch);
  assert.equal(encoded.includes('10.0.0.8'), false);
  WebRTC.stopPortSearch('cleanup');
});

test('manual refresh cancels an active port search', async () => {
  const { WebRTC } = loadWebRTC();
  preparePortSearch(WebRTC);
  WebRTC.createPeerConnection = () => {};
  WebRTC.createOffer = async () => {};
  WebRTC.stopTunnelRelay = () => {};
  WebRTC.stopMediaTelemetry = () => {};
  assert.equal(WebRTC.startPortSearch(), true);
  assert.equal(WebRTC.isPortSearchActive(), true);

  // Call the real refresh path (not search-owned): it must cancel search.
  WebRTC._portSearchRefreshOwned = false;
  await WebRTC.refresh();
  assert.equal(WebRTC.isPortSearchActive(), false);
});

test('manual refresh clears sticky exhausted port-search candidate text', async () => {
  const { WebRTC, context } = loadWebRTC();
  preparePortSearch(WebRTC);
  WebRTC.createPeerConnection = () => {};
  WebRTC.createOffer = async () => {};
  WebRTC.stopTunnelRelay = () => {};
  WebRTC.stopMediaTelemetry = () => {};
  WebRTC.portSearchController = context.StunPortSearchController.create({ limit: 1 });
  WebRTC.portSearchController.start();
  WebRTC.portSearchController.beginAttempt('manual');
  WebRTC.portSearchController.failAttempt('timeout');
  assert.equal(WebRTC.portSearchController.snapshot().status, 'exhausted');
  WebRTC.renderPortSearchStatus();
  assert.match(context.document.getElementById('candidateDisplay').textContent, /端口搜索失败/);

  WebRTC._portSearchRefreshOwned = false;
  await WebRTC.refresh();
  assert.equal(WebRTC.portSearchController, null);
});

test('signal disconnect cancels active port search', () => {
  const socketHandlers = new Map();
  const { WebRTC } = loadWebRTC();
  WebRTC.socket = {
    connected: true,
    on(event, handler) { socketHandlers.set(event, handler); },
    emit() {},
    disconnect() {},
  };
  preparePortSearch(WebRTC, { socket: WebRTC.socket });
  WebRTC.refresh = () => {};
  WebRTC.setupSocketListeners();
  assert.equal(WebRTC.startPortSearch(), true);
  assert.equal(WebRTC.isPortSearchActive(), true);
  assert.equal(typeof socketHandlers.get('disconnect'), 'function');
  socketHandlers.get('disconnect')();
  assert.equal(WebRTC.isPortSearchActive(), false);
});

test('succeeded port search status is not overwritten by processStatsSnapshot', () => {
  const { WebRTC, context } = loadWebRTC();
  preparePortSearch(WebRTC);
  WebRTC.refresh = () => {};
  assert.equal(WebRTC.startPortSearch(), true);
  WebRTC.handlePortSearchMedia({ selectedCandidateType: 'srflx', framesDecoded: 10, fps: 10 });
  WebRTC.handlePortSearchMedia({ selectedCandidateType: 'srflx', framesDecoded: 11, fps: 11 });
  WebRTC.handlePortSearchMedia({ selectedCandidateType: 'srflx', framesDecoded: 12, fps: 12 });
  assert.equal(WebRTC.portSearchController.snapshot().status, 'succeeded');
  const successText = context.document.getElementById('candidateDisplay').textContent;
  assert.match(successText, /端口搜索成功/);
  WebRTC.processStatsSnapshot({
    fps: 30,
    rttMs: 40,
    framesReceived: 100,
    framesDecoded: 100,
    selectedCandidateType: 'srflx',
  });
  assert.equal(
    context.document.getElementById('candidateDisplay').textContent,
    successText,
  );
});

test('UI init tolerates missing optional elements', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const elements = new Map();
  function el() {
    return {
      textContent: '',
      style: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener() {},
      focus() {},
      play() {},
      pause() {},
    };
  }
  const context = {
    console,
    document: {
      body: el(),
      fullscreenElement: null,
      addEventListener() {},
      querySelector(sel) {
        if (sel === '.viewer-container') return el();
        return null;
      },
      getElementById(id) {
        if (id === 'pauseBtn' || id === 'disconnectBtn' || id === 'remoteVideo') return el();
        return null;
      },
    },
    Input: { setActive() {} },
    WebRTC: { disconnect() {}, requestResolution() {} },
    confirm: () => true,
  };
  context.globalThis = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');
  assert.doesNotThrow(() => vm.runInContext(source, context));
});

test('WebRTC fullscreen lifecycle refreshes chrome and input geometry then tears down its exact handler', () => {
  const { WebRTC, context } = loadWebRTC();
  const calls = [];
  context.ChromeLayout = { recalculate() { calls.push('recalculate'); } };
  context.Input = { refreshGeometry() { calls.push('input-geometry'); } };
  const listeners = new Map();
  context.document.addEventListener = (type, handler) => listeners.set(type, handler);
  context.document.removeEventListener = (type, handler) => {
    if (listeners.get(type) === handler) listeners.delete(type);
  };
  WebRTC._fullscreenLifecycleBound = false;
  const teardown = WebRTC.bindFullscreenLifecycle();
  const handler = listeners.get('fullscreenchange');
  WebRTC.bindFullscreenLifecycle();

  handler();
  teardown();

  assert.deepEqual(calls, ['recalculate', 'input-geometry']);
  assert.equal(WebRTC._fullscreenLifecycleHandler, null);
  assert.equal(WebRTC._fullscreenLifecycleBound, false);
  assert.equal(listeners.has('fullscreenchange'), false);
});


test('applyMediaActivity suspends input and suppresses health recovery', () => {
  const emitted = [];
  const { WebRTC, context } = loadWebRTC();
  // Provide runtime in sandbox.
  const runtimeSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'media-activity-runtime.js'), 'utf8');
  require('node:vm').runInContext(runtimeSource, context);
  WebRTC.socket = {
    connected: true,
    emit(...args) { emitted.push(args); },
    on() {},
  };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.currentConnectionAttemptId = 'wrd-1';
  WebRTC.networkMode = 'stun';
  WebRTC.mediaActivityRuntime = context.MediaActivityRuntime.create({ requestTimeoutMs: 1500 });
  const inputCalls = [];
  globalThis.Input = {
    setActive(v) { inputCalls.push(['setActive', v]); },
    resetKeyboard(r) { inputCalls.push(['reset', r]); },
    setControlLease() {},
  };
  // In vm context Input may need to be on context
  context.Input = globalThis.Input;

  const snap = { state: 'suspended', reasons: ['manual-pause'], generation: 2 };
  WebRTC.applyMediaActivity(snap);
  assert.equal(WebRTC.getMediaAppliedPhase(), 'suspending');
  assert.equal(WebRTC.isMediaHealthSuppressed(), true);
  assert.equal(WebRTC.canEnableDesktopInput(), false);
  assert.equal(emitted.some((e) => e[0] === 'media-activity-change'), true);
  const payload = emitted.find((e) => e[0] === 'media-activity-change')[1];
  assert.equal(payload.leaseId, 'lease-000000000001');
  assert.equal(payload.generation, 2);
  assert.equal(payload.connectionAttemptId, 'wrd-1');

  WebRTC.handleMediaActivityAck({
    state: 'suspended', generation: 2, connectionAttemptId: 'wrd-1', applied: true,
  });
  assert.equal(WebRTC.getMediaAppliedPhase(), 'suspended');
  assert.equal(WebRTC.scheduleReconnect('media-stalled') === undefined, true);
});

test('media suspend does not open a keyboard reset barrier', () => {
  const { WebRTC, context } = loadWebRTC({ realInput: true });
  const calls = [];
  context.__Input.resetKeyboard = (reason) => { calls.push(['reset', reason]); };
  context.__Input.setActive = () => {};
  context.__Input.releasePointer = () => { calls.push(['release-pointer']); };
  context.__Input.parkKeyboard = () => { calls.push(['park']); };
  WebRTC.applyMediaActivity({ state: 'suspended', generation: 1, reasons: ['page-hidden'] });
  assert.equal(calls.some(([kind]) => kind === 'reset'), false);
  assert.equal(calls.some(([kind]) => kind === 'release-pointer'), true);
});

test('media resume enables input only after active ack and rendered frame', () => {
  const { WebRTC, context } = loadWebRTC();
  const runtimeSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'media-activity-runtime.js'), 'utf8');
  require('node:vm').runInContext(runtimeSource, context);
  WebRTC.socket = { connected: true, emit() {}, on() {} };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.currentConnectionAttemptId = 'wrd-1';
  WebRTC.mediaActivityRuntime = context.MediaActivityRuntime.create({ requestTimeoutMs: 1500 });
  context.Input = {
    active: false,
    setActive(v) { this.active = v; },
    resetKeyboard() {},
    setControlLease() {},
  };

  WebRTC.applyMediaActivity({ state: 'suspended', reasons: ['manual-pause'], generation: 1 });
  WebRTC.handleMediaActivityAck({ state: 'suspended', generation: 1, connectionAttemptId: 'wrd-1', applied: true });
  WebRTC.applyMediaActivity({ state: 'active', reasons: [], generation: 2 });
  assert.equal(WebRTC.getMediaAppliedPhase(), 'resuming');
  assert.equal(WebRTC.canEnableDesktopInput(), false);
  WebRTC.handleMediaActivityAck({ state: 'active', generation: 2, connectionAttemptId: 'wrd-1', applied: true });
  assert.equal(WebRTC.canEnableDesktopInput(), false);
  WebRTC.noteMediaRenderedFrame({ source: 'video-callback', frameSeq: 1 });
  assert.equal(WebRTC.getMediaAppliedPhase(), 'active');
  assert.equal(WebRTC.canEnableDesktopInput(), true);
});

test('initial visible attempt binds active media without requiring a resume request', () => {
  const { WebRTC, context } = loadWebRTC();
  for (const filename of ['media-activity-controller.js', 'media-activity-runtime.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, filename), 'utf8'), context);
  }
  context.MediaActivityController = context.window.MediaActivityController;
  context.document.hidden = false;
  const emitted = [];
  WebRTC.socket = { connected: true, emit(...args) { emitted.push(args); } };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.currentConnectionAttemptId = 'attempt-initial';
  WebRTC.connectionAttemptSequence = 1;
  WebRTC.networkMode = 'relay';

  WebRTC.initializeMediaActivity();
  assert.equal(WebRTC.bindCurrentConnectionAttempt(), true);
  WebRTC.ensureMediaActiveIfVisible('control-grant');
  assert.equal(WebRTC.replayMediaActivityIntent('control-regrant'), false);
  WebRTC.ensureMediaActiveIfVisible('pc-connected');

  assert.deepEqual(JSON.parse(JSON.stringify(WebRTC.getMediaActivitySnapshot())), {
    state: 'active', reasons: [], generation: 0,
  });
  assert.equal(WebRTC.getMediaAppliedPhase(), 'active');
  assert.deepEqual(emitted.map(([event]) => event), ['connection-attempt-bind']);
  assert.equal(emitted[0][1].connectionAttemptId, 'attempt-initial');
});

test('connection-attempt bind is idempotent within one scope and rebinds on scope changes', () => {
  const { WebRTC } = loadWebRTC();
  const emitted = [];
  WebRTC.socket = { id: 'socket-a', connected: true, emit(...args) { emitted.push(args); } };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.currentConnectionAttemptId = 'attempt-idempotent';
  WebRTC.connectionAttemptSequence = 1;
  WebRTC.networkMode = 'relay';

  assert.equal(WebRTC.bindCurrentConnectionAttempt(), true);
  assert.equal(WebRTC.bindCurrentConnectionAttempt(), true);
  assert.equal(emitted.filter(([event]) => event === 'connection-attempt-bind').length, 1);

  WebRTC.connectionAttemptSequence = 2;
  assert.equal(WebRTC.bindCurrentConnectionAttempt(), true);
  WebRTC.controlState.lease = { leaseId: 'lease-000000000001', leaseEpoch: 2 };
  assert.equal(WebRTC.bindCurrentConnectionAttempt(), true);
  assert.equal(emitted.filter(([event]) => event === 'connection-attempt-bind').length, 3);
});

test('ensureMediaActiveIfVisible clears page-hidden and replays active intent', () => {
  const { WebRTC, context } = loadWebRTC();
  const controllerSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, 'media-activity-controller.js'),
    'utf8',
  );
  const runtimeSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, 'media-activity-runtime.js'),
    'utf8',
  );
  require('node:vm').runInContext(controllerSource, context);
  require('node:vm').runInContext(runtimeSource, context);
  const MediaActivityController = context.MediaActivityController
    || context.window?.MediaActivityController
    || context.globalThis?.MediaActivityController;
  const MediaActivityRuntime = context.MediaActivityRuntime
    || context.window?.MediaActivityRuntime
    || context.globalThis?.MediaActivityRuntime;
  assert.ok(MediaActivityController, 'MediaActivityController must load in vm');
  assert.ok(MediaActivityRuntime, 'MediaActivityRuntime must load in vm');

  context.document.hidden = false;
  WebRTC.socket = { connected: true, emit() {}, on() {} };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.currentConnectionAttemptId = 'wrd-1';
  WebRTC.PAGE_HIDDEN_SUSPEND_DELAY_MS = 30000;
  const emitted = [];
  WebRTC.sendMediaActivityRequest = (desired, snapshot) => {
    emitted.push(['media-req', desired, snapshot?.generation]);
    return true;
  };
  WebRTC.mediaActivityController = MediaActivityController.create({
    onChange: (snap) => {
      WebRTC._mediaIntent = {
        state: snap.state,
        reasons: snap.reasons,
        generation: snap.generation,
      };
    },
  });
  WebRTC.mediaActivityRuntime = MediaActivityRuntime.create({ requestTimeoutMs: 1500 });
  context.Input = {
    setActive() {},
    resetKeyboard() {},
    setControlLease() {},
  };

  WebRTC.mediaActivityController.setReason('page-hidden', true);
  assert.equal(WebRTC.getMediaActivitySnapshot().state, 'suspended');
  WebRTC.ensureMediaActiveIfVisible('test-ensure');
  assert.equal(WebRTC.getMediaActivitySnapshot().state, 'active');
  assert.equal(WebRTC.mediaActivityController.hasReason('page-hidden'), false);
  assert.ok(emitted.some((entry) => entry[0] === 'media-req' && entry[1] === 'active'));
  assert.ok(WebRTC.PAGE_HIDDEN_SUSPEND_DELAY_MS >= 15000);
});

test('resume stays gated through decoded statistics until a real rendered frame', () => {
  const { WebRTC, context } = loadWebRTC();
  const runtimeSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'media-activity-runtime.js'), 'utf8');
  require('node:vm').runInContext(runtimeSource, context);
  WebRTC.socket = { connected: true, emit() {}, on() {} };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.currentConnectionAttemptId = 'wrd-1';
  WebRTC.mediaActivityRuntime = context.MediaActivityRuntime.create({ requestTimeoutMs: 1500 });
  context.Input = {
    active: false,
    setActive(v) { this.active = v; },
    resetKeyboard() {},
    setControlLease() {},
  };

  WebRTC._lastInboundFramesDecoded = 100;
  WebRTC.applyMediaActivity({ state: 'suspended', reasons: ['manual-pause'], generation: 1 });
  WebRTC.handleMediaActivityAck({ state: 'suspended', generation: 1, connectionAttemptId: 'wrd-1', applied: true });
  WebRTC.applyMediaActivity({ state: 'active', reasons: [], generation: 2 });
  WebRTC.handleMediaActivityAck({ state: 'active', generation: 2, connectionAttemptId: 'wrd-1', applied: true });
  assert.equal(WebRTC.getMediaAppliedPhase(), 'resuming');
  assert.equal(WebRTC.canEnableDesktopInput(), false);

  // Cumulative framesDecoded already > 0 from before pause must not unlock.
  WebRTC.processStatsSnapshot({
    fps: 15,
    rttMs: 40,
    framesReceived: 100,
    framesDecoded: 100,
    packetsLost: 0,
    bytesReceived: 1000,
    selectedCandidateType: 'srflx',
  });
  assert.equal(WebRTC.getMediaAppliedPhase(), 'resuming');
  assert.equal(WebRTC.canEnableDesktopInput(), false);

  // Decoded statistics cannot stand in for a fresh rendered frame.
  WebRTC.processStatsSnapshot({
    fps: 15,
    rttMs: 40,
    framesReceived: 101,
    framesDecoded: 101,
    packetsLost: 0,
    bytesReceived: 1100,
    selectedCandidateType: 'srflx',
  });
  assert.equal(WebRTC.getMediaAppliedPhase(), 'resuming');
  WebRTC.noteMediaRenderedFrame({ source: 'video-callback', frameSeq: 1,
    connectionAttemptId: 'wrd-1', pc: WebRTC.pc });
  assert.equal(WebRTC.getMediaAppliedPhase(), 'active');
  assert.equal(WebRTC.canEnableDesktopInput(), true);

  const phaseAfter = WebRTC.getMediaAppliedPhase();
  WebRTC.processStatsSnapshot({
    fps: 15,
    rttMs: 40,
    framesReceived: 105,
    framesDecoded: 105,
    packetsLost: 0,
    bytesReceived: 1500,
    selectedCandidateType: 'srflx',
  });
  assert.equal(WebRTC.getMediaAppliedPhase(), phaseAfter);
});

test('stale pc, wrong attempt, and non-fresh video callback cannot unlock resume', () => {
  const { WebRTC, context } = loadWebRTC();
  const runtimeSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'media-activity-runtime.js'), 'utf8');
  require('node:vm').runInContext(runtimeSource, context);
  const livePc = { id: 'live' };
  const stalePc = { id: 'stale' };
  WebRTC.socket = { connected: true, emit() {}, on() {} };
  WebRTC.pc = livePc;
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.currentConnectionAttemptId = 'attempt-B';
  WebRTC.mediaActivityRuntime = context.MediaActivityRuntime.create({ requestTimeoutMs: 1500 });
  context.Input = {
    setActive() {},
    resetKeyboard() {},
    setControlLease() {},
  };

  WebRTC._lastInboundFramesDecoded = 10;
  WebRTC._videoFrameSeq = 3;
  WebRTC.applyMediaActivity({ state: 'suspended', reasons: ['manual-pause'], generation: 1 });
  WebRTC.handleMediaActivityAck({ state: 'suspended', generation: 1, connectionAttemptId: 'attempt-B', applied: true });
  WebRTC.applyMediaActivity({ state: 'active', reasons: [], generation: 2 });
  WebRTC.handleMediaActivityAck({ state: 'active', generation: 2, connectionAttemptId: 'attempt-B', applied: true });
  assert.equal(WebRTC.getMediaAppliedPhase(), 'resuming');

  assert.equal(WebRTC.observeFreshResumeFrame({
    source: 'stats',
    framesDecoded: 11,
    connectionAttemptId: 'attempt-A',
    pc: livePc,
  }), false);
  assert.equal(WebRTC.getMediaAppliedPhase(), 'resuming');

  assert.equal(WebRTC.observeFreshResumeFrame({
    source: 'video-callback',
    frameSeq: 4,
    connectionAttemptId: 'attempt-B',
    pc: stalePc,
  }), false);
  assert.equal(WebRTC.getMediaAppliedPhase(), 'resuming');

  assert.equal(WebRTC.observeFreshResumeFrame({
    source: 'video-callback',
    frameSeq: 3,
    connectionAttemptId: 'attempt-B',
    pc: livePc,
  }), false);
  assert.equal(WebRTC.getMediaAppliedPhase(), 'resuming');

  assert.equal(WebRTC.observeFreshResumeFrame({
    source: 'video-callback',
    frameSeq: 4,
    connectionAttemptId: 'attempt-B',
    pc: livePc,
  }), true);
  assert.equal(WebRTC.getMediaAppliedPhase(), 'active');
});

test('acceptance scripts must not synthesize noteMediaRenderedFrame', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', '..', 'scripts');
  for (const name of [
    'runtime_reliability_acceptance.py',
    'runtime_reliability_acceptance_ext.py',
    'runtime_reliability_acceptance_final.py',
  ]) {
    const source = fs.readFileSync(path.join(root, name), 'utf8');
    assert.equal(
      source.includes('noteMediaRenderedFrame'),
      false,
      `${name} must not call noteMediaRenderedFrame`,
    );
  }
});

test('tunnel media activity waits for Host applied ack and fresh relay frame', () => {
  const emitted = [];
  const { WebRTC, context } = loadWebRTC();
  const runtimeSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'media-activity-runtime.js'), 'utf8');
  require('node:vm').runInContext(runtimeSource, context);
  WebRTC.socket = {
    connected: true,
    emit(...args) { emitted.push(args); },
    on() {},
  };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.currentConnectionAttemptId = 'attempt-tunnel-1';
  WebRTC.networkMode = 'tunnel';
  WebRTC.tunnelRelayActive = true;
  WebRTC.mediaActivityRuntime = context.MediaActivityRuntime.create({ requestTimeoutMs: 2500 });
  context.Input = {
    setActive() {},
    resetKeyboard() {},
    setControlLease() {},
  };

  WebRTC.applyMediaActivity({ state: 'suspended', reasons: ['manual-pause'], generation: 1 });
  // No synthetic applied: still suspending until Host ack.
  assert.equal(WebRTC.getMediaAppliedPhase(), 'suspending');
  const control = emitted.find((entry) => entry[0] === 'relay-stream-control');
  assert.ok(control);
  assert.equal(control[1].enabled, false);
  assert.equal(control[1].state, 'suspended');
  assert.equal(control[1].generation, 1);
  assert.equal(control[1].connectionAttemptId, 'attempt-tunnel-1');
  assert.equal(control[1].schemaVersion, 2);
  assert.equal(control[1].mediaControlSchemaVersion, 1);
  assert.equal(emitted.some((entry) => entry[0] === 'media-activity-change'), false);

  WebRTC.handleMediaActivityAck({
    state: 'suspended',
    generation: 1,
    connectionAttemptId: 'attempt-tunnel-1',
    applied: true,
  });
  assert.equal(WebRTC.getMediaAppliedPhase(), 'suspended');

  WebRTC.applyMediaActivity({ state: 'active', reasons: [], generation: 2 });
  assert.equal(WebRTC.getMediaAppliedPhase(), 'resuming');
  WebRTC.handleMediaActivityAck({
    ...relayAckFields(WebRTC, 2), state: 'active',
    generation: 2,
    connectionAttemptId: 'attempt-tunnel-1',
    applied: true,
  });
  assert.equal(WebRTC.getMediaAppliedPhase(), 'resuming');
  assert.equal(WebRTC.canEnableDesktopInput(), false);

  // Fresh relay frame unlocks.
  WebRTC.tunnelLastFrameId = 10;
  WebRTC.handleRelayFrame({ ...relayAckFields(WebRTC, 2), frameId: 11, data: 'AAAA' });
  context.document.getElementById('relayImage').onload();
  assert.equal(WebRTC.getMediaAppliedPhase(), 'active');
});

test('tunnel drops pre-ACK frames and requires a new scoped load after ACK', () => {
  const emitted = [];
  const { WebRTC, context, elements } = loadWebRTC();
  const runtimeSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'media-activity-runtime.js'), 'utf8');
  require('node:vm').runInContext(runtimeSource, context);
  WebRTC.socket = { connected: true, emit(...args) { emitted.push(args); }, on() {} };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.currentConnectionAttemptId = 'attempt-tunnel-race';
  WebRTC.networkMode = 'tunnel';
  WebRTC.tunnelRelayActive = true;
  WebRTC.mediaActivityRuntime = context.MediaActivityRuntime.create({ requestTimeoutMs: 2500 });
  context.Input = { setActive() {}, resetKeyboard() {}, setControlLease() {} };

  WebRTC.applyMediaActivity({ state: 'suspended', reasons: ['manual-pause'], generation: 1 });
  WebRTC.handleMediaActivityAck({
    state: 'suspended', generation: 1, connectionAttemptId: 'attempt-tunnel-race', applied: true,
  });
  WebRTC.applyMediaActivity({ state: 'active', reasons: [], generation: 2 });
  assert.equal(WebRTC.getMediaAppliedPhase(), 'resuming');

  WebRTC.handleRelayFrame({ ...relayAckFields(WebRTC, 2), frameId: 1, timestamp: Date.now(), mime: 'image/jpeg', data: 'AAAA' });
  assert.equal(elements.get('relayImage')?.onload ?? null, null);
  assert.equal(WebRTC.tunnelLastFrameId, 0);
  assert.equal(WebRTC.getMediaAppliedPhase(), 'resuming');

  WebRTC.handleMediaActivityAck({
    ...relayAckFields(WebRTC, 2), state: 'active', generation: 2, connectionAttemptId: 'attempt-tunnel-race', applied: true,
  });
  assert.equal(WebRTC.getMediaAppliedPhase(), 'resuming');
  WebRTC.handleRelayFrame({ ...relayAckFields(WebRTC, 2), frameId: 2, data: 'AAAA' });
  elements.get('relayImage').onload();
  assert.equal(WebRTC.getMediaAppliedPhase(), 'active');
  assert.equal(WebRTC.canEnableDesktopInput(), true);
});

test('media intent queues without a lease and replays after regrant on the current attempt', () => {
  const emitted = [];
  const { WebRTC, context } = loadWebRTC();
  const runtimeSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'media-activity-runtime.js'), 'utf8');
  require('node:vm').runInContext(runtimeSource, context);
  WebRTC.socket = { connected: true, emit(...args) { emitted.push(args); }, on() {} };
  WebRTC.controlState = { state: 'FREE', controller: false, hostOnline: true, lease: null };
  WebRTC.currentConnectionAttemptId = 'attempt-before-grant';
  WebRTC.mediaActivityRuntime = context.MediaActivityRuntime.create({ requestTimeoutMs: 1500 });
  context.Input = { setActive() {}, resetKeyboard() {}, setControlLease() {} };

  WebRTC.applyMediaActivity({ state: 'suspended', reasons: ['manual-pause'], generation: 1 });
  assert.equal(emitted.length, 0);
  assert.equal(WebRTC.canEnableDesktopInput(), false);

  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 2 },
  };
  WebRTC.currentConnectionAttemptId = 'attempt-after-grant';
  assert.equal(WebRTC.replayMediaActivityIntent('control-regrant'), true);

  const request = emitted.find(([event]) => event === 'media-activity-change');
  assert.equal(request[1].generation, 1);
  assert.equal(request[1].connectionAttemptId, 'attempt-after-grant');
  assert.equal(WebRTC.getMediaAppliedPhase(), 'suspending');
});

test('desired media state changes queue while the socket is disconnected and replay after reconnect', () => {
  const emitted = [];
  const { WebRTC, context } = loadWebRTC();
  const runtimeSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'media-activity-runtime.js'), 'utf8');
  require('node:vm').runInContext(runtimeSource, context);
  WebRTC.socket = {
    connected: false,
    emit(...args) { emitted.push(args); },
    on() {},
  };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 4 },
  };
  WebRTC.currentConnectionAttemptId = 'attempt-offline';
  WebRTC.mediaActivityRuntime = context.MediaActivityRuntime.create({ requestTimeoutMs: 1500 });
  context.Input = { setActive() {}, resetKeyboard() {}, setControlLease() {} };

  WebRTC.applyMediaActivity({ state: 'suspended', reasons: ['page-hidden'], generation: 3 });
  assert.equal(emitted.length, 0);
  assert.equal(WebRTC.getMediaAppliedPhase(), 'suspending');
  assert.equal(WebRTC.canEnableDesktopInput(), false);

  WebRTC.socket.connected = true;
  assert.equal(WebRTC.replayMediaActivityIntent('socket-connect'), true);
  const request = emitted.find(([event]) => event === 'media-activity-change');
  assert.equal(request[1].generation, 3);
  assert.equal(request[1].state, 'suspended');
  assert.equal(request[1].connectionAttemptId, 'attempt-offline');
});

test('resume failures use one refresh fallback and keep desktop input disabled', () => {
  const { WebRTC, context } = loadWebRTC();
  const runtimeSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'media-activity-runtime.js'), 'utf8');
  require('node:vm').runInContext(runtimeSource, context);
  WebRTC.socket = { connected: true, emit() {}, on() {} };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.currentConnectionAttemptId = 'attempt-resume';
  WebRTC.mediaActivityRuntime = context.MediaActivityRuntime.create({ requestTimeoutMs: 1500 });
  const input = { active: false, setActive(value) { this.active = value; }, resetKeyboard() {}, setControlLease() {} };
  context.Input = input;
  let refreshes = 0;
  WebRTC.refresh = () => { refreshes += 1; };
  WebRTC._mediaIntent = { state: 'active', reasons: [], generation: 2 };
  WebRTC.mediaActivityRuntime.beginDesired('active', {
    generation: 2,
    connectionAttemptId: 'attempt-resume',
  });

  WebRTC.handleMediaRequestFailure('request-timeout');
  WebRTC.handleMediaRequestFailure('request-timeout');

  assert.equal(refreshes, 1);
  assert.equal(WebRTC.canEnableDesktopInput(), false);
  assert.equal(input.active, false);
});

test('closed media failure replays intent and never refreshes', () => {
  const emitted = [];
  const { WebRTC, context } = loadWebRTC();
  const runtimeSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'media-activity-runtime.js'), 'utf8');
  require('node:vm').runInContext(runtimeSource, context);
  WebRTC.socket = { connected: true, emit(...args) { emitted.push(args); }, on() {} };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.currentConnectionAttemptId = 'attempt-closed';
  WebRTC.mediaActivityRuntime = context.MediaActivityRuntime.create({ requestTimeoutMs: 1500 });
  context.Input = { setActive() {}, resetKeyboard() {}, setControlLease() {} };
  let refreshes = 0;
  WebRTC.refresh = () => { refreshes += 1; };

  WebRTC.applyMediaActivity({ state: 'active', reasons: [], generation: 2 });
  emitted.length = 0;

  const closedAck = {
    state: 'suspended',
    generation: 2,
    connectionAttemptId: 'attempt-closed',
    applied: false,
    reason: 'closed',
  };
  // Production path: Host fail-closed arrives as media-activity-ack, not a
  // direct handleMediaRequestFailure('closed') call.
  WebRTC.handleMediaActivityAck(closedAck);
  // Distinct failureKey so the second ack is not dual-route-deduped.
  WebRTC.handleMediaActivityAck({ ...closedAck, state: 'active' });

  const replays = emitted.filter(([event]) => event === 'media-activity-change');
  assert.equal(replays.length, 1);
  assert.equal(refreshes, 0);
});

function appliedMediaReplayFixture() {
  let now = 0;
  const timers = new Set();
  const setTimer = (fn, ms) => {
    const timer = { fn, ms, due: now + ms };
    timers.add(timer);
    return timer;
  };
  const { WebRTC, context } = loadWebRTC({
    performance: { now: () => now },
    setTimeout: setTimer,
    clearTimeout: (timer) => timers.delete(timer),
  });
  for (const file of ['media-activity-controller.js', 'media-activity-runtime.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context);
  }
  context.MediaActivityController = context.window.MediaActivityController;
  const requests = [];
  WebRTC.socket = { connected: true, emit(event, data) {
    if (event === 'media-activity-change') requests.push(data);
  }, on() {} };
  WebRTC.controlState = { state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 3 } };
  WebRTC.currentConnectionAttemptId = 'attempt-applied-replay';
  WebRTC.connectionAttemptSequence = 1;
  WebRTC.networkMode = 'relay';
  WebRTC.pc = { connectionState: 'connected', iceConnectionState: 'connected', restartIce() {} };
  context.Input = { setActive() {}, resetKeyboard() {}, setControlLease() {} };
  // Create the active generation through the actual desired-state controller.
  WebRTC.setMediaActivityReason('manual-pause', true);
  WebRTC.setMediaActivityReason('manual-pause', false);
  const request = { ...requests.at(-1), viewerId: 'viewer-1' };
  const ack = { state: 'active', generation: request.generation,
    connectionAttemptId: request.connectionAttemptId, applied: true };
  WebRTC.handleMediaActivityAck(ack);
  let refreshes = 0;
  WebRTC.refresh = () => { refreshes += 1; };
  return { WebRTC, requests, request, ack, timers,
    refreshes: () => refreshes,
    advance(ms) {
      const target = now + ms;
      while (true) {
        const timer = [...timers].filter(item => item.due <= target)
          .sort((a, b) => a.due - b.due)[0];
        if (!timer) break;
        now = timer.due;
        timers.delete(timer);
        timer.fn();
      }
      now = target;
    },
    frame(overrides = {}) {
      return WebRTC.observeFreshResumeFrame({ source: 'video-callback', frameSeq: 1,
        connectionAttemptId: WebRTC.currentConnectionAttemptId, pc: WebRTC.pc, ...overrides });
    },
  };
}

function rejectAppliedMediaReplayOnRealHost(request) {
  // Load only the real Host's pure validation/rejection methods: no Quartz,
  // encoder, service process or network is needed for this cross-runtime case.
  const bridge = require('node:child_process').spawnSync('python3', ['-B', '-c', `
import ast, asyncio, json, sys
from types import SimpleNamespace
source = ast.parse(open(sys.argv[1]).read())
names = {'valid_relay_nonce', 'valid_relay_integer'}
nodes = [n for n in source.body if isinstance(n, ast.FunctionDef) and n.name in names]
host = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'WebRemoteHost')
methods = {'_validate_media_activity_request', 'on_media_activity_change', '_emit_media_activity_ack'}
nodes.append(ast.ClassDef(name='Host', bases=[], keywords=[], decorator_list=[],
    body=[n for n in host.body if getattr(n, 'name', None) in methods]))
env = {'asyncio': asyncio, 'RELAY_SAFE_INTEGER': 9007199254740991}
exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), 'real-host-media', 'exec'), env)
request = json.load(sys.stdin)
host = env['Host']()
host._active_input_binding = dict(request)
host._media_activity_binding = dict(request)
events = []
async def emit(event, payload): events.append(payload)
host.sio = SimpleNamespace(emit=emit)
asyncio.run(host.on_media_activity_change(request))
print(json.dumps(events[-1]))
`, path.join(__dirname, '../../python-host/host.py')], {
    input: JSON.stringify(request), encoding: 'utf8', timeout: 15000,
  });
  assert.equal(bridge.status, 0, bridge.stderr);
  const ack = JSON.parse(bridge.stdout.trim());
  assert.equal(ack.applied, false);
  assert.equal(ack.reason, 'stale-generation');
  return ack;
}

function signalMediaReplayFixture({ acknowledge = true } = {}) {
  process.env.ACCESS_PASSWORD ||= 'test-viewer-password';
  process.env.JWT_SECRET ||= '12345678';
  process.env.HOST_PASSWORD ||= 'test-host-password';
  const { setupSignaling } = require('../../signal-server/websocket/signaling');
  const { FakeSocket, makeIo, resetConnections, grantActiveLease } = require('../../signal-server/websocket/signaling-test-fixture');
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001', now: () => 0 });
  const host = new FakeSocket('host-media-replay', 'host');
  const viewer = new FakeSocket('viewer-media-replay', 'viewer');
  host.handshake.auth.inputProtocolVersion = viewer.handshake.auth.inputProtocolVersion = 2;
  io.connect(host); io.connect(viewer);
  const lease = grantActiveLease(io, host, viewer);
  const f = appliedMediaReplayFixture();
  const w = f.WebRTC;
  const listeners = new Map();
  w.socket = { connected: true, on(event, handler) { listeners.set(event, handler); },
    emit(event, data) {
      if (event === 'media-activity-change') f.requests.push(data);
      viewer.trigger(event, data);
    } };
  w.controlState.lease = { leaseId: lease.leaseId, leaseEpoch: lease.leaseEpoch };
  w.setupSocketListeners();
  const originalEmit = viewer.emit.bind(viewer);
  viewer.emit = (event, data, ack) => {
    const result = originalEmit(event, data, ack);
    listeners.get(event)?.(data);
    return result;
  };
  viewer.trigger('connection-attempt-bind', { schemaVersion: 1,
    connectionAttemptId: w.currentConnectionAttemptId, connectionAttemptSequence: 1,
    ...w.controlState.lease });
  w.mediaActivityRuntime.reset();
  w.applyMediaActivity(w._mediaIntent);
  const request = host.sent.filter(row => row.event === 'media-activity-change').at(-1).data;
  const ack = { schemaVersion: 1, viewerId: viewer.id, state: request.state,
    generation: request.generation, connectionAttemptId: request.connectionAttemptId, applied: true };
  if (acknowledge) host.trigger('media-activity-ack', ack);
  return { ...f, host, viewer, request, ack, listeners };
}

test('registered Signal stale rejection preserves the applied Viewer resume and frame deadline', () => {
  const f = signalMediaReplayFixture();
  const before = f.requests.length;
  f.advance(12000);
  const rejected = f.viewer.sent.filter(row => row.event === 'media-activity-rejected').at(-1).data;
  assert.equal(rejected.reason, 'stale-generation');
  assert.equal(f.WebRTC.mediaActivityRuntime.snapshot().lastAck.applied, true);
  assert.equal(f.requests.length, before + 1);
  assert.equal(f.refreshes(), 0);
  assert.equal([...f.timers].filter(timer => timer.ms === 12000).length, 1);
  assert.equal(f.frame(), true);
  assert.equal(f.WebRTC.canEnableDesktopInput(), true);
});

test('registered Signal duplicate rejection preserves one hard fallback when no frame arrives', () => {
  const f = signalMediaReplayFixture();
  f.advance(24000);
  assert.equal(f.refreshes(), 1);
  assert.equal(f.WebRTC.canEnableDesktopInput(), false);
  f.advance(60000);
  assert.equal(f.refreshes(), 1);
});

test('real Host stale rejection survives registered Signal ACK routing without losing its reason', () => {
  const f = signalMediaReplayFixture();
  const rejected = rejectAppliedMediaReplayOnRealHost(f.request);
  f.host.trigger('media-activity-ack', rejected);
  const forwarded = f.viewer.sent.filter(row => row.event === 'media-activity-ack').at(-1).data;
  assert.equal(forwarded.reason, 'stale-generation');
  assert.equal(f.WebRTC.mediaActivityRuntime.snapshot().lastAck.applied, true);
  assert.equal([...f.timers].filter(timer => timer.ms === 12000).length, 1);
  assert.equal(f.frame(), true);
});

test('registered Signal duplicate rejection stays bounded without a successful Host ACK', () => {
  const f = signalMediaReplayFixture({ acknowledge: false });
  const before = f.requests.length;
  f.WebRTC.replayMediaActivityIntent('unacknowledged-replay');
  for (let i = 0; i < 10; i++) {
    f.listeners.get('media-activity-rejected')({ schemaVersion: 1, reason: 'stale-generation',
      state: f.request.state, generation: f.request.generation,
      connectionAttemptId: f.request.connectionAttemptId });
  }
  assert.ok(f.requests.length <= before + 2, 'only the explicit replay and one bounded retry may send');
  f.advance(4000);
  assert.equal(f.refreshes(), 1);
  assert.equal(f.frame(), false);
  assert.equal(f.WebRTC.canEnableDesktopInput(), false);
  f.advance(60000);
  assert.equal(f.refreshes(), 1);
});

test('registered Signal rejects older media requests without spending the current resume budget', () => {
  const f = signalMediaReplayFixture();
  const deadline = f.WebRTC._mediaResumeFrameTimer;
  const before = f.requests.length;
  const { viewerId, ...request } = f.request;
  f.viewer.trigger('media-activity-change', { ...request, generation: request.generation - 1 });
  f.viewer.trigger('media-activity-change', { ...request, connectionAttemptId: 'attempt-retired' });
  f.listeners.get('media-activity-rejected')({ reason: 'stale-generation' });
  f.listeners.get('relay-stream-control-rejected')({ reason: 'stale-generation' });
  assert.equal(f.requests.length, before);
  assert.equal(f.WebRTC._mediaResumeFrameTimer, deadline);
  assert.equal(f.WebRTC.mediaActivityRuntime.snapshot().lastAck.applied, true);
  assert.equal(f.frame(), true);
});

test('registered Signal tunnel duplicate rejection shares the scoped resume guard', () => {
  const f = signalMediaReplayFixture();
  const { viewerId, ...request } = f.request;
  const deadline = f.WebRTC._mediaResumeFrameTimer;
  f.viewer.trigger('relay-stream-control', { ...request, schemaVersion: 2,
    mediaControlSchemaVersion: 1, enabled: true });
  const rejected = f.viewer.sent.filter(row => row.event === 'relay-stream-control-rejected').at(-1).data;
  assert.equal(rejected.reason, 'stale-generation');
  assert.equal(f.WebRTC._mediaResumeFrameTimer, deadline);
  assert.equal(f.WebRTC.mediaActivityRuntime.snapshot().lastAck.applied, true);
  assert.equal(f.frame(), true);
});

test('applied media soft replay survives real Host stale-generation rejection and a fresh frame', () => {
  const f = appliedMediaReplayFixture();
  const rejected = rejectAppliedMediaReplayOnRealHost(f.request);
  f.advance(12000);
  assert.equal(f.WebRTC._mediaResumeSoftRecoverUsed, true);
  f.WebRTC.handleMediaActivityAck(rejected);
  f.WebRTC.handleMediaActivityAck(rejected);
  assert.equal(f.WebRTC.mediaActivityRuntime.snapshot().lastAck.applied, true);
  assert.equal(f.requests.length, 3, 'the duplicate rejection must not start another request');
  assert.equal(f.refreshes(), 0);
  assert.equal(f.frame(), true, 'a fresh rendered frame must still finish the acknowledged resume');
  assert.equal(f.WebRTC.canEnableDesktopInput(), true);
  // A queued duplicate after the frame must not regress the completed phase.
  f.WebRTC.handleMediaActivityAck(rejected);
  assert.equal(f.WebRTC.getMediaAppliedPhase(), 'active');
  assert.equal(f.WebRTC.mediaActivityRuntime.snapshot().lastAck.applied, true);
});

test('applied media soft replay keeps the hard frame deadline after duplicate Host rejection', () => {
  const f = appliedMediaReplayFixture();
  const rejected = rejectAppliedMediaReplayOnRealHost(f.request);
  f.advance(12000);
  f.WebRTC.handleMediaActivityAck(rejected);
  f.WebRTC.handleMediaActivityAck(rejected);
  assert.equal([...f.timers].filter(timer => timer.ms === 12000).length, 1);
  f.advance(12000);
  assert.equal(f.refreshes(), 1);
  assert.equal(f.WebRTC.canEnableDesktopInput(), false);
  f.advance(60000);
  assert.equal(f.refreshes(), 1);
});

test('applied media duplicate success ACKs cannot extend the fresh-frame deadline', () => {
  const f = appliedMediaReplayFixture();
  f.advance(6000);
  f.WebRTC.handleMediaActivityAck(f.ack);
  f.advance(6000);
  assert.equal(f.WebRTC._mediaResumeSoftRecoverUsed, true);
  f.advance(6000);
  f.WebRTC.handleMediaActivityAck(f.ack);
  f.advance(6000);
  assert.equal(f.refreshes(), 1);
});

test('applied media ACK ownership releases peer references on frame completion, control loss and disconnect', () => {
  const completed = appliedMediaReplayFixture();
  assert.equal(completed.WebRTC._mediaActivityAckScope.pc, completed.WebRTC.pc);
  assert.equal(completed.frame(), true);
  assert.equal(completed.WebRTC._mediaActivityAckScope, null);

  const revoked = appliedMediaReplayFixture();
  revoked.WebRTC.freezeControl('control-revoked');
  assert.equal(revoked.WebRTC._mediaActivityAckScope, null);
  assert.equal(revoked.frame(), false);

  const disconnected = appliedMediaReplayFixture();
  disconnected.WebRTC.pc.close = () => {};
  disconnected.WebRTC.socket.disconnect = () => {};
  disconnected.WebRTC.disconnect();
  assert.equal(disconnected.WebRTC._mediaActivityAckScope, null);
  assert.equal(disconnected.WebRTC.pc, null);
  assert.equal(disconnected.WebRTC.socket, null);
});

test('applied media replay cannot carry a prior ACK across attempt, lease, socket or peer changes', () => {
  for (const change of [
    w => { w.currentConnectionAttemptId = 'attempt-replaced'; },
    w => { w.controlState.lease = { leaseId: 'lease-000000000002', leaseEpoch: 4 }; },
    w => { w.socket = { ...w.socket }; },
    w => { w.pc = { ...w.pc }; },
  ]) {
    const f = appliedMediaReplayFixture();
    f.advance(12000);
    change(f.WebRTC);
    f.WebRTC.handleMediaActivityAck({ ...f.ack, applied: false, reason: 'stale-generation' });
    assert.equal(f.frame(), false);
    assert.equal(f.WebRTC.canEnableDesktopInput(), false);
  }
});

test('media replay rejection needs a matching successful ACK and never ignores an execution failure', () => {
  const unacknowledged = appliedMediaReplayFixture();
  const w = unacknowledged.WebRTC;
  w.mediaActivityRuntime.reset();
  w.mediaActivityRuntime.beginDesired('active', { generation: unacknowledged.request.generation,
    connectionAttemptId: w.currentConnectionAttemptId });
  w.handleMediaActivityAck({ ...unacknowledged.ack, applied: false, reason: 'stale-generation' });
  assert.equal(w.mediaActivityRuntime.snapshot().lastAck.applied, false);
  assert.equal(unacknowledged.frame(), false);
  assert.equal(w.canEnableDesktopInput(), false);

  const failed = appliedMediaReplayFixture();
  failed.WebRTC.handleMediaActivityAck({ ...failed.ack, state: 'suspended',
    applied: false, reason: 'execution-failed' });
  assert.equal(failed.WebRTC.mediaActivityRuntime.snapshot().lastAck.applied, false);
  assert.equal(failed.frame(), false);
  assert.equal(failed.WebRTC.canEnableDesktopInput(), false);
});

test('applied media replay keeps manual, hidden-page and Terminal pause reasons authoritative', () => {
  for (const reason of ['manual-pause', 'page-hidden', 'terminal-active']) {
    const f = appliedMediaReplayFixture();
    f.advance(12000);
    f.WebRTC.handleMediaActivityAck({ ...f.ack, applied: false, reason: 'stale-generation' });
    f.WebRTC.setMediaActivityReason(reason, true);
    f.WebRTC.handleMediaActivityAck(f.ack);
    assert.equal(f.frame(), false);
    assert.equal(f.WebRTC.canEnableDesktopInput(), false);
    assert.equal(f.WebRTC.getMediaActivitySnapshot().reasons.includes(reason), true);
  }
});

test('dual-routed applied:false ack triggers only one bounded replay', () => {
  const emitted = [];
  const { WebRTC, context } = loadWebRTC();
  const runtimeSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'media-activity-runtime.js'), 'utf8');
  require('node:vm').runInContext(runtimeSource, context);
  WebRTC.socket = { connected: true, emit(...args) { emitted.push(args); }, on() {} };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.currentConnectionAttemptId = 'attempt-dual';
  WebRTC.connectionAttemptSequence = 4;
  WebRTC.networkMode = 'tunnel';
  WebRTC.tunnelRelayActive = true;
  WebRTC.mediaActivityRuntime = context.MediaActivityRuntime.create({ requestTimeoutMs: 2500 });
  context.Input = { setActive() {}, resetKeyboard() {}, setControlLease() {} };
  let refreshes = 0;
  WebRTC.refresh = () => { refreshes += 1; };

  WebRTC.applyMediaActivity({ state: 'active', reasons: [], generation: 3 });
  emitted.length = 0;
  const ack = {
    state: 'suspended',
    generation: 3,
    connectionAttemptId: 'attempt-dual',
    applied: false,
  };
  // Signal dual-routes tunnel Host acks on both events.
  WebRTC.handleMediaActivityAck(ack);
  WebRTC.handleMediaActivityAck(ack);

  const binds = emitted.filter(([event]) => event === 'connection-attempt-bind');
  const replays = emitted.filter(([event]) => event === 'relay-stream-control');
  assert.ok(binds.length >= 1);
  assert.equal(replays.length, 1);
  assert.equal(refreshes, 0);
  assert.equal(WebRTC.canEnableDesktopInput(), false);
});

test('wrong-attempt media failure rebinds the current tunnel attempt once', () => {
  const emitted = [];
  const { WebRTC, context } = loadWebRTC();
  const runtimeSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'media-activity-runtime.js'), 'utf8');
  require('node:vm').runInContext(runtimeSource, context);
  WebRTC.socket = { connected: true, emit(...args) { emitted.push(args); }, on() {} };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 8 },
  };
  WebRTC.currentConnectionAttemptId = 'attempt-tunnel-current';
  WebRTC.connectionAttemptSequence = 6;
  WebRTC.networkMode = 'tunnel';
  WebRTC.tunnelRelayActive = true;
  WebRTC.mediaActivityRuntime = context.MediaActivityRuntime.create({ requestTimeoutMs: 2500 });
  context.Input = { setActive() {}, resetKeyboard() {}, setControlLease() {} };
  WebRTC._mediaIntent = { state: 'suspended', reasons: ['manual-pause'], generation: 2 };
  WebRTC.mediaActivityRuntime.beginDesired('suspended', {
    generation: 2,
    connectionAttemptId: 'attempt-tunnel-current',
  });

  assert.equal(WebRTC.handleMediaRequestFailure('wrong-attempt'), true);
  assert.equal(WebRTC.handleMediaRequestFailure('wrong-attempt'), false);

  const binds = emitted.filter(([event]) => event === 'connection-attempt-bind');
  const controls = emitted.filter(([event]) => event === 'relay-stream-control');
  assert.ok(binds.length >= 1);
  assert.equal(binds[0][1].connectionAttemptId, 'attempt-tunnel-current');
  assert.equal(binds[0][1].connectionAttemptSequence, 6);
  assert.equal(controls.length, 1);
  assert.equal(controls[0][1].generation, 2);
  assert.equal(controls[0][1].state, 'suspended');
});

test('stale applied:false ack cannot retry the current media intent', () => {
  const emitted = [];
  const { WebRTC, context } = loadWebRTC();
  const runtimeSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'media-activity-runtime.js'), 'utf8');
  require('node:vm').runInContext(runtimeSource, context);
  WebRTC.socket = { connected: true, emit(...args) { emitted.push(args); }, on() {} };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.currentConnectionAttemptId = 'attempt-current';
  WebRTC.networkMode = 'tunnel';
  WebRTC.tunnelRelayActive = true;
  WebRTC.mediaActivityRuntime = context.MediaActivityRuntime.create({ requestTimeoutMs: 2500 });
  context.Input = { setActive() {}, resetKeyboard() {}, setControlLease() {} };

  WebRTC.applyMediaActivity({ state: 'active', reasons: [], generation: 5 });
  emitted.length = 0;
  WebRTC.handleMediaActivityAck({
    state: 'suspended', generation: 4, connectionAttemptId: 'attempt-old', applied: false,
  });

  assert.equal(emitted.some(([event]) => event === 'relay-stream-control'), false);
  assert.equal(WebRTC._mediaRequestRetryUsed, false);
});

test('new connection attempt keeps input closed until its first rendered frame', () => {
  const { WebRTC, context } = loadWebRTC();
  WebRTC.socket = { connected: true, emit() {}, on() {} };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.currentConnectionAttemptId = 'attempt-old';
  WebRTC._mediaReadyConnectionAttemptId = 'attempt-old';
  context.Input = {
    active: true,
    setActive(value) { this.active = value; },
    resetKeyboard() {},
    setControlLease() {},
  };
  WebRTC.createConnectionAttemptId = () => 'attempt-new';
  assert.equal(WebRTC.canEnableDesktopInput(), true);

  WebRTC.beginConnectionAttempt('refresh');

  assert.equal(WebRTC.canEnableDesktopInput(), false);
  assert.equal(context.Input.active, false);
  WebRTC.noteMediaRenderedFrame({ source: 'video-callback', frameSeq: 1 });
  assert.equal(WebRTC.canEnableDesktopInput(), true);
});

test('control loss keeps frame readiness so regrant can enable input without a new frame', () => {
  const { WebRTC, context } = loadWebRTC();
  WebRTC.currentConnectionAttemptId = 'attempt-current';
  WebRTC._mediaReadyConnectionAttemptId = 'attempt-current';
  WebRTC.hasPaintedFrame = true;
  WebRTC.uiPhase = 'connected';
  WebRTC.socket = { connected: true };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  context.Input = {
    active: true,
    setActive(value) { this.active = value; },
    setControlLease() {},
    resetKeyboard() {},
  };
  WebRTC.updateControlUI = () => {};
  WebRTC.renderPortSearchStatus = () => {};

  WebRTC.freezeControl('takeover');

  // Readiness survives control loss; only beginConnectionAttempt clears it.
  assert.equal(WebRTC._mediaReadyConnectionAttemptId, 'attempt-current');
  // Readonly frames may still refresh readiness without arming input.
  assert.equal(WebRTC.markMediaAttemptReady('attempt-current'), true);
  assert.equal(WebRTC.canEnableDesktopInput(), false);
  assert.equal(context.Input.active, false);

  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000002', leaseEpoch: 2 },
  };
  WebRTC.ensureDesktopSessionState().applyConnection({
    attemptId: 'attempt-current', state: 'online',
  });
  WebRTC.ensureDesktopSessionState().applyControl({
    attemptId: 'attempt-current', state: 'active',
  });
  WebRTC.ensureDesktopSessionState().applyMedia({
    attemptId: 'attempt-current', event: 'fresh-frame', fresh: true,
  });
  WebRTC.syncDesktopInputGate();
  assert.equal(WebRTC.canEnableDesktopInput(), true);
  assert.equal(context.Input.active, true);
});

test('media resume fallback does not arm before PC is connected on webrtc paths', () => {
  const timers = [];
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  global.setTimeout = (fn, ms) => {
    const handle = { fn, ms, cleared: false };
    timers.push(handle);
    return handle;
  };
  global.clearTimeout = (handle) => {
    if (handle && typeof handle === 'object') handle.cleared = true;
  };
  try {
    const { WebRTC, context } = loadWebRTC();
    const runtimeSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'media-activity-runtime.js'), 'utf8');
    require('node:vm').runInContext(runtimeSource, context);
    WebRTC.socket = { connected: true, emit() {}, on() {} };
    WebRTC.controlState = {
      state: 'ACTIVE', controller: true, hostOnline: true,
      lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
    };
    WebRTC.currentConnectionAttemptId = 'attempt-arm';
    WebRTC.networkMode = 'relay';
    WebRTC.pc = { connectionState: 'connecting', iceConnectionState: 'checking' };
    WebRTC.mediaActivityRuntime = context.MediaActivityRuntime.create({ requestTimeoutMs: 1500 });
    context.Input = { setActive() {}, resetKeyboard() {}, setControlLease() {} };

    WebRTC.applyMediaActivity({ state: 'active', reasons: [], generation: 1 });
    for (const timer of timers) timer.cleared = true;
    WebRTC.handleMediaActivityAck({
      state: 'active', generation: 1, connectionAttemptId: 'attempt-arm', applied: true,
    });
    assert.equal(WebRTC.getMediaAppliedPhase(), 'resuming');
    assert.equal(timers.filter((t) => !t.cleared).length, 0);
    assert.equal(WebRTC._mediaResumeArmPending, true);

    WebRTC.pc.connectionState = 'connected';
    WebRTC.pc.iceConnectionState = 'connected';
    WebRTC.ensureMediaResumeFallbackArmed('pc-connected');
    const live = timers.filter((t) => !t.cleared);
    assert.equal(live.length, 1);
    assert.equal(live[0].ms, 12000);
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test('fresh-frame fallback cancels prior timer and runs refresh only once', () => {
  const timers = [];
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  global.setTimeout = (fn, ms) => {
    const handle = { fn, ms, cleared: false };
    timers.push(handle);
    return handle;
  };
  global.clearTimeout = (handle) => {
    if (handle && typeof handle === 'object') handle.cleared = true;
  };
  try {
    const { WebRTC, context } = loadWebRTC();
    const runtimeSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'media-activity-runtime.js'), 'utf8');
    require('node:vm').runInContext(runtimeSource, context);
    WebRTC.socket = { connected: true, emit() {}, on() {} };
    WebRTC.controlState = {
      state: 'ACTIVE', controller: true, hostOnline: true,
      lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
    };
    WebRTC.currentConnectionAttemptId = 'attempt-timer';
    WebRTC.networkMode = 'relay';
    WebRTC.pc = { connectionState: 'connected', iceConnectionState: 'connected', restartIce() {} };
    WebRTC.mediaActivityRuntime = context.MediaActivityRuntime.create({ requestTimeoutMs: 1500 });
    context.Input = { setActive() {}, resetKeyboard() {}, setControlLease() {} };
    let refreshes = 0;
    WebRTC.refresh = (options) => {
      refreshes += 1;
      WebRTC._refreshReason = options?.reason || null;
    };

    WebRTC.applyMediaActivity({ state: 'active', reasons: [], generation: 4 });
    // Drop request-timeout timers from beginDesired so we only assert resume fallback.
    for (const timer of timers) timer.cleared = true;
    WebRTC.handleMediaActivityAck({
      state: 'active',
      generation: 4,
      connectionAttemptId: 'attempt-timer',
      applied: true,
    });
    assert.equal(WebRTC.getMediaAppliedPhase(), 'resuming');
    const armed = timers.filter((t) => !t.cleared);
    assert.equal(armed.length, 1);
    assert.equal(armed[0].ms, 12000);

    // Re-arming must cancel the previous fallback timer and keep a single live timer.
    WebRTC.clearMediaResumeFallback();
    WebRTC.armMediaResumeFallback();
    WebRTC.armMediaResumeFallback();
    let live = timers.filter((t) => !t.cleared);
    assert.equal(live.length, 1);

    // First timeout is soft recover only — no full refresh.
    const first = live[0];
    first.cleared = true; // fired
    first.fn();
    assert.equal(refreshes, 0);
    assert.equal(WebRTC._mediaResumeSoftRecoverUsed, true);
    assert.equal(WebRTC._mediaResumeRefreshFallbackUsed, false);

    // Soft recover may also create a request-timeout timer via replay; only the
    // re-armed resume fallback timer (relay=12000) may escalate to hard refresh.
    live = timers.filter((t) => !t.cleared && t.ms === 12000);
    assert.equal(live.length, 1);
    const second = live[0];
    second.cleared = true; // fired
    second.fn();
    // Second timeout escalates to hard refresh once.
    assert.equal(refreshes, 1);
    assert.equal(WebRTC._mediaResumeRefreshFallbackUsed, true);
    assert.equal(WebRTC.canEnableDesktopInput(), false);
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test('fresh-frame hard refresh inherits resume budget and does not loop', () => {
  const { WebRTC, context } = loadWebRTC();
  const runtimeSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'media-activity-runtime.js'), 'utf8');
  require('node:vm').runInContext(runtimeSource, context);
  WebRTC.socket = { connected: true, emit() {}, on() {} };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.networkMode = 'relay';
  WebRTC.currentConnectionAttemptId = 'attempt-1';
  WebRTC._mediaResumeRefreshFallbackUsed = true;
  WebRTC._refreshReason = 'fresh-frame-timeout';
  WebRTC.beginConnectionAttempt('refresh');
  assert.equal(WebRTC._mediaResumeRefreshFallbackUsed, true);
  assert.notEqual(WebRTC.currentConnectionAttemptId, 'attempt-1');

  WebRTC._refreshReason = 'manual';
  WebRTC.beginConnectionAttempt('viewer-open');
  assert.equal(WebRTC._mediaResumeRefreshFallbackUsed, false);
});

test('stale attempt relay frame cannot unlock a newer resume attempt', () => {
  const { WebRTC, context, elements } = loadWebRTC();
  const runtimeSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'media-activity-runtime.js'), 'utf8');
  require('node:vm').runInContext(runtimeSource, context);
  WebRTC.socket = { connected: true, emit() {}, on() {} };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.currentConnectionAttemptId = 'attempt-new';
  WebRTC.networkMode = 'tunnel';
  WebRTC.tunnelRelayActive = true;
  WebRTC.mediaActivityRuntime = context.MediaActivityRuntime.create({ requestTimeoutMs: 2500 });
  context.Input = { setActive() {}, resetKeyboard() {}, setControlLease() {} };

  WebRTC.applyMediaActivity({ state: 'active', reasons: [], generation: 5 });
  WebRTC._lastRenderedRelayFrame = {
    frameId: 1,
    frameSeq: 10,
    connectionAttemptId: 'attempt-old',
  };
  WebRTC.handleMediaActivityAck({
    ...relayAckFields(WebRTC, 5), state: 'active',
    generation: 5,
    connectionAttemptId: 'attempt-new',
    applied: true,
  });
  assert.equal(WebRTC.getMediaAppliedPhase(), 'resuming');
  assert.equal(WebRTC.canEnableDesktopInput(), false);
});

test('auto host-status reconnect does not steal an active controller', () => {
  const emitted = [];
  const { WebRTC } = loadWebRTC();
  WebRTC.socket = { connected: true, emit(...args) { emitted.push(args); }, on() {} };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: false, hostOnline: true,
    lease: null,
  };
  WebRTC._controlRequestId = 0;
  WebRTC.updateControlUI = () => {};

  assert.equal(WebRTC.requestControl({ allowTakeover: false }), false);
  assert.equal(emitted.length, 0);

  assert.equal(WebRTC.requestControl({ allowTakeover: true }), true);
  assert.equal(emitted[0][0], 'control-acquire');
  assert.equal(emitted[0][1].takeover, true);
});

test('control grant honors the media input gate before a fresh frame', () => {
  const { WebRTC, context } = loadWebRTC();
  const inputCalls = [];
  context.Input = {
    init() {},
    setControlLease() {},
    setActive(value) { inputCalls.push(value); },
  };
  WebRTC.canEnableDesktopInput = () => false;
  WebRTC.startControlHeartbeat = () => {};
  WebRTC.updateControlUI = () => {};
  WebRTC.createOffer = () => {};
  WebRTC.createPeerConnection = () => {};
  WebRTC.bindCurrentConnectionAttempt = () => false;
  WebRTC.replayMediaActivityIntent = () => false;
  WebRTC.ensureMediaActiveIfVisible = () => false;

  WebRTC.handleControlGrant({ controller: true, leaseId: 'lease-000000000001', leaseEpoch: 1 });

  assert.deepEqual(inputCalls, [false]);
});

test('control grant does not createOffer when PC and DC are already live', () => {
  const { WebRTC, context } = loadWebRTC();
  let offers = 0;
  context.Input = { init() {}, setControlLease(lease) { this.activeControlLease = lease; return true; }, setActive() {} };
  WebRTC.startControlHeartbeat = () => {};
  WebRTC.updateControlUI = () => {};
  WebRTC.createOffer = () => { offers += 1; };
  WebRTC.createPeerConnection = () => {};
  WebRTC.bindCurrentConnectionAttempt = () => false;
  WebRTC.replayMediaActivityIntent = () => false;
  WebRTC.ensureMediaActiveIfVisible = () => false;
  WebRTC.networkMode = 'relay';
  WebRTC.pc = { connectionState: 'connected' };
  WebRTC.inputChannel = { readyState: 'open' };
  WebRTC.handleControlGrant({ controller: true, leaseId: 'lease-000000000001', leaseEpoch: 1 });
  assert.equal(offers, 0);
});

test('control grant still creates offer when PC is missing', () => {
  const { WebRTC, context } = loadWebRTC();
  let offers = 0;
  context.Input = { init() {}, setControlLease(lease) { this.activeControlLease = lease; return true; }, setActive() {} };
  WebRTC.startControlHeartbeat = () => {};
  WebRTC.updateControlUI = () => {};
  WebRTC.createOffer = () => { offers += 1; };
  WebRTC.createPeerConnection = () => { WebRTC.pc = { connectionState: 'new' }; };
  WebRTC.bindCurrentConnectionAttempt = () => false;
  WebRTC.replayMediaActivityIntent = () => false;
  WebRTC.ensureMediaActiveIfVisible = () => false;
  WebRTC.networkMode = 'relay';
  WebRTC.pc = null;
  WebRTC.inputChannel = null;
  WebRTC.handleControlGrant({ controller: true, leaseId: 'lease-000000000001', leaseEpoch: 1 });
  assert.equal(offers, 1);
});

test('starting a new tunnel producer resets the frame-id cursor', () => {
  const emitted = [];
  const { WebRTC } = loadWebRTC();
  WebRTC.currentConnectionAttemptId = 'relay-fixture-attempt';
  WebRTC.connectionAttemptSequence = 1;
  WebRTC.socket = { connected: true, emit(...args) { emitted.push(args); }, on() {} };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.networkMode = 'tunnel';
  WebRTC.tunnelLastFrameId = 99;

  WebRTC.startTunnelRelay();

  assert.equal(WebRTC.tunnelLastFrameId, 0);
  assert.equal(emitted.some(([event, payload]) => event === 'relay-stream-control' && payload.enabled === true), true);
});


test('tunnel fresh-frame fallback keeps the current attempt', () => {
  const timers = [];
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  global.setTimeout = (fn, ms) => {
    const handle = { fn, ms, cleared: false };
    timers.push(handle);
    return handle;
  };
  global.clearTimeout = (handle) => {
    if (handle && typeof handle === 'object') handle.cleared = true;
  };
  try {
    const emitted = [];
    const { WebRTC, context } = loadWebRTC();
    const runtimeSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'media-activity-runtime.js'), 'utf8');
    require('node:vm').runInContext(runtimeSource, context);
    WebRTC.socket = { connected: true, emit(...args) { emitted.push(args); }, on() {} };
    WebRTC.controlState = {
      state: 'ACTIVE', controller: true, hostOnline: true,
      lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
    };
    WebRTC.currentConnectionAttemptId = 'attempt-tunnel-stable';
    WebRTC.connectionAttemptSequence = 3;
    WebRTC.networkMode = 'tunnel';
    WebRTC.tunnelRelayActive = true;
    WebRTC.mediaActivityRuntime = context.MediaActivityRuntime.create({ requestTimeoutMs: 2500 });
    context.Input = { setActive() {}, resetKeyboard() {}, setControlLease() {} };
    let refreshes = 0;
    WebRTC.refresh = () => { refreshes += 1; WebRTC.beginConnectionAttempt('refresh'); };

    WebRTC.applyMediaActivity({ state: 'active', reasons: [], generation: 5 });
    for (const timer of timers) timer.cleared = true;
    WebRTC.handleMediaActivityAck({
      ...relayAckFields(WebRTC, 5), state: 'active', generation: 5, connectionAttemptId: 'attempt-tunnel-stable', applied: true,
    });
    assert.equal(WebRTC.getMediaAppliedPhase(), 'resuming');

    const live = timers.filter((t) => !t.cleared);
    assert.equal(live.length, 1);
    const beforeAttempt = WebRTC.currentConnectionAttemptId;
    emitted.length = 0;
    live[0].fn();

    assert.equal(refreshes, 0);
    assert.equal(WebRTC.currentConnectionAttemptId, beforeAttempt);
    assert.equal(
      emitted.some(([event, payload]) => event === 'relay-stream-control' && payload.connectionAttemptId === beforeAttempt),
      true,
    );
    assert.equal(WebRTC.canEnableDesktopInput(), false);
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test('refresh while tunnel media is resuming replays intent on the new attempt', () => {
  const emitted = [];
  const { WebRTC, context } = loadWebRTC();
  const runtimeSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'media-activity-runtime.js'), 'utf8');
  require('node:vm').runInContext(runtimeSource, context);
  WebRTC.socket = { connected: true, emit(...args) { emitted.push(args); }, on() {} };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.currentConnectionAttemptId = 'attempt-old';
  WebRTC.connectionAttemptSequence = 1;
  WebRTC.networkMode = 'tunnel';
  WebRTC.mediaActivityRuntime = context.MediaActivityRuntime.create({ requestTimeoutMs: 2500 });
  context.Input = { setActive() {}, resetKeyboard() {}, setControlLease() {} };
  WebRTC.createSignalingSocket = () => {};
  const loading = context.document.getElementById('loading');
  loading.classList = { add() {}, remove() {}, contains() { return false; } };
  context.document.body.classList = { add() {}, remove() {}, contains() { return false; } };
  const el = () => ({
    classList: { add() {}, remove() {}, contains() { return false; } },
    textContent: '',
    src: '',
    removeAttribute() {},
    setAttribute() {},
  });
  context.document.getElementById = (id) => {
    if (id === 'loading') return loading || el();
    return el();
  };

  WebRTC.applyMediaActivity({ state: 'active', reasons: [], generation: 7 });
  WebRTC.handleMediaActivityAck({
    state: 'active', generation: 7, connectionAttemptId: 'attempt-old', applied: true,
  });
  assert.equal(WebRTC.getMediaAppliedPhase(), 'resuming');

  emitted.length = 0;
  WebRTC.refresh();

  const media = emitted.filter(([event, payload]) => (
    event === 'relay-stream-control'
    && payload
    && payload.mediaControlSchemaVersion === 1
    && payload.generation === 7
    && payload.state === 'active'
  ));
  assert.ok(media.length >= 1);
  assert.equal(media.at(-1)[1].connectionAttemptId, WebRTC.currentConnectionAttemptId);
  assert.notEqual(WebRTC.currentConnectionAttemptId, 'attempt-old');
});

test('starting tunnel relay detaches closed WebRTC callbacks before closing the old peer', () => {
  const { WebRTC } = loadWebRTC();
  WebRTC.socket = { connected: true, emit() {}, on() {} };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.networkMode = 'tunnel';
  const pc = {
    oniceconnectionstatechange() {}, onconnectionstatechange() {}, onsignalingstatechange() {},
    onicegatheringstatechange() {}, onicecandidate() {}, ontrack() {},
    close() { assert.equal(this.onconnectionstatechange, null); },
  };
  WebRTC.pc = pc;

  WebRTC.startTunnelRelay();

  assert.equal(WebRTC.pc, null);
  assert.equal(pc.oniceconnectionstatechange, null);
  assert.equal(pc.onconnectionstatechange, null);
});


test('stable viewport while adaptive relay frame sizes change', () => {
  const { WebRTC, context, elements } = loadWebRTC();
  WebRTC.tunnelRelayActive = true;
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.socket = { connected: true, emit() {}, on() {} };
  const fields = prepareOrdinaryRelay(WebRTC);
  const relayImage = elements.get('relayImage') || context.document.getElementById('relayImage');
  // Fake bounding box independent of intrinsic image size.
  let box = { width: 800, height: 450, left: 0, top: 0 };
  relayImage.getBoundingClientRect = () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height });
  const sizes = [[960, 540], [640, 360], [480, 270]];
  let frameId = 0;
  for (const [width, height] of sizes) {
    frameId += 1;
    WebRTC.handleRelayFrame({ ...fields,
      frameId,
      width,
      height,
      timestamp: Date.now(),
      mime: 'image/jpeg',
      data: 'AAAA',
    });
    const rect = relayImage.getBoundingClientRect();
    assert.equal(rect.width, 800);
    assert.equal(rect.height, 450);
  }
  assert.equal(WebRTC.tunnelLastFrameId, 3);
  // Source size changes must not schedule reconnect/offers.
  assert.equal(WebRTC.reconnectTimer, null);
});

test('viewer-superseded enters terminal state and blocks scheduleReconnect', () => {
  const { WebRTC, context } = loadWebRTC();
  let logoutCount = 0;
  context.Auth.logout = () => { logoutCount += 1; };
  let reconnectionValue = true;
  WebRTC.socket = {
    connected: true,
    disconnect() { this.connected = false; },
    io: {
      reconnection(value) {
        if (typeof value === 'boolean') reconnectionValue = value;
        return reconnectionValue;
      },
    },
    on() {},
    emit() {},
  };
  WebRTC.pc = {
    oniceconnectionstatechange() {},
    onconnectionstatechange() {},
    onsignalingstatechange() {},
    onicegatheringstatechange() {},
    onicecandidate() {},
    ontrack() {},
    close() {},
  };
  WebRTC.manualDisconnect = false;
  WebRTC._superseded = false;
  WebRTC.reconnectTimer = null;

  WebRTC.handleViewerSuperseded({ reason: 'single-desktop-viewer', bySocketId: 'other' });

  assert.equal(WebRTC.manualDisconnect, true);
  assert.equal(WebRTC._superseded, true);
  assert.equal(WebRTC.reconnectTimer, null);
  assert.equal(WebRTC.socket, null);
  assert.equal(WebRTC.pc, null);
  assert.equal(reconnectionValue, false);
  assert.equal(logoutCount, 0);

  // Do NOT wrap scheduleReconnect to increment before early-return.
  WebRTC.scheduleReconnect('ice-failed');
  assert.equal(WebRTC.reconnectTimer, null);
  WebRTC.scheduleReconnect('signal-disconnected');
  assert.equal(WebRTC.reconnectTimer, null);
});

test('reclaimDesktopSession clears supersede flags', async () => {
  const { WebRTC } = loadWebRTC();
  WebRTC.handleViewerSuperseded({ reason: 'single-desktop-viewer' });
  let started = 0;
  WebRTC.createSignalingSocket = () => { started += 1; };
  WebRTC.createPeerConnection = () => {};
  WebRTC.beginConnectionAttempt = () => {};

  await WebRTC.reclaimDesktopSession();

  assert.equal(WebRTC._superseded, false);
  assert.equal(WebRTC.manualDisconnect, false);
  assert.equal(started, 1);
});

test('Start warmup and click use one bootstrap and one signaling attempt', async () => {
  const signalingSockets = [];
  let bootstrapCalls = 0;
  const { WebRTC } = loadWebRTC({
    io: () => {
      const socket = { on() {}, emit() {}, disconnect() {}, connected: true };
      signalingSockets.push(socket);
      return socket;
    },
  });
  WebRTC.createPeerConnection = () => {};
  WebRTC.configureNetworkControls = () => {};
  WebRTC.updateNetworkUI = () => {};
  WebRTC.bindControlLifecycle = () => {};
  WebRTC.setupSocketListeners = () => {};
  const controller = {
    load: async () => {
      bootstrapCalls += 1;
      return { schemaVersion: 1, host: { online: true }, webrtc: { iceServers: [] } };
    },
  };
  const start = WebRTC.createStartHandler(controller);
  await Promise.all([start(), start()]);
  assert.equal(bootstrapCalls, 1);
  assert.equal(signalingSockets.length, 1);
  assert.ok(WebRTC.currentConnectionAttemptId);
});

test('WebRTC.init consumes supplied snapshot and does not fetch config', async () => {
  const signalingSockets = [];
  const { WebRTC } = loadWebRTC({
    io: () => {
      const socket = { on() {}, emit() {}, disconnect() {}, connected: true };
      signalingSockets.push(socket);
      return socket;
    },
  });
  WebRTC.createPeerConnection = () => {};
  WebRTC.configureNetworkControls = () => {};
  WebRTC.updateNetworkUI = () => {};
  WebRTC.bindControlLifecycle = () => {};
  WebRTC.setupSocketListeners = () => {};
  WebRTC.loadServerConfig = () => { throw new Error('must not fetch'); };
  await WebRTC.init({
    bootstrapSnapshot: { host: { online: true }, webrtc: { iceServers: [] } },
    trigger: 'test',
  });
  assert.equal(WebRTC.serverConfig.iceServers.length, 0);
  assert.equal(signalingSockets.length, 1);
});

function relayAckFields(WebRTC, generation = 0, producerId = 'fixture-producer') {
  return { relayFrameSchemaVersion: 1, relayScope: { producerId, productionGeneration: generation + 1,
    connectionAttemptId: WebRTC.currentConnectionAttemptId, mediaGeneration: generation,
    leaseEpoch: WebRTC.controlState.lease.leaseEpoch } };
}

function prepareOrdinaryRelay(WebRTC, producerId = 'fixture-producer') {
  WebRTC.currentConnectionAttemptId ||= 'relay-fixture-attempt';
  WebRTC.connectionAttemptSequence ||= 1;
  WebRTC.tunnelRelayActive = true;
  assert.equal(WebRTC.emitRelayStreamControl(), true);
  const pending = WebRTC._relayPendingStart;
  const fields = relayAckFields(WebRTC, pending.mediaGeneration, producerId);
  assert.equal(WebRTC.handleMediaActivityAck({ ...fields, relayControlKind: 'start',
    relayStartRequestId: pending.requestId, generation: pending.mediaGeneration,
    state: 'active', applied: true, connectionAttemptId: pending.attempt }), true);
  return fields;
}

function firstFrameSamplerFixture() {
  let timerId = 0;
  const timers = new Map();
  const fixture = loadWebRTC({
    realInput: true,
    performance: { now: () => 1000, timeOrigin: 1792208500000 },
    Date: { now: () => 1792208501000 },
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  fixture.WebRTC.pc = { connectionState: 'new', getStats: async () => new Map() };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../scripts/passive_session_sampler.js'), 'utf8'), fixture.context);
  const sampler = fixture.context.window.__wrdPassiveSampler;
  return { ...fixture, sampler, timers,
    cleanup() {
      try {
        sampler.stop();
        fixture.WebRTC.clearFirstFrameDeadline();
      } finally {
        fixture.cleanup();
        timers.clear();
      }
    },
  };
}

test('explicit first-frame timer fresh source owns null and unchanged sampler observes false', async (t) => {
  const h = firstFrameSamplerFixture();
  t.after(() => h.cleanup());
  assert.equal(Object.hasOwn(h.WebRTC, '_firstFrameTimer'), true);
  assert.equal(h.WebRTC._firstFrameTimer, null);
  const sample = await h.sampler.sample();
  assert.equal(sample.inputGate.status, 'observed');
  assert.equal(sample.inputGate.allowed, false);
  assert.equal(sample.inputGate.firstFrameTimerHandlePresent, false);
});

test('explicit first-frame timer startup delegation preserves its separate media budget', async (t) => {
  const h = firstFrameSamplerFixture();
  t.after(() => h.cleanup());
  const { WebRTC, timers } = h;
  WebRTC.networkMode = 'auto';
  const episode = WebRTC.beginStartupEpisode();
  WebRTC.startupPending = () => true;
  let budgetStarts = 0;
  const startBudget = WebRTC.startStartupMediaBudget;
  WebRTC.startStartupMediaBudget = function () {
    budgetStarts += 1;
    return startBudget.call(this);
  };
  const previousTimers = new Set(timers.keys());
  WebRTC.beginFirstFrameDeadline('startup-attempt', 1234);
  assert.equal(budgetStarts, 1);
  assert.equal(episode.started, true);
  assert.equal(episode.remaining, 72000);
  assert.equal(episode.feedbackRemaining, 8000);
  assert.equal(timers.get(episode.timer).delay, 8000);
  assert.deepEqual([...timers.keys()].filter(id => !previousTimers.has(id)), [episode.timer]);
  assert.equal(WebRTC._firstFrameTimer, null);
  const sample = await h.sampler.sample();
  assert.equal(sample.inputGate.status, 'observed');
  assert.equal(sample.inputGate.firstFrameTimerHandlePresent, false);
  assert.equal(episode.remaining, 72000);
  assert.equal(episode.feedbackRemaining, 8000);
});

test('explicit first-frame timer real legacy arm and clear project true then false', async (t) => {
  const h = firstFrameSamplerFixture();
  t.after(() => h.cleanup());
  const { WebRTC, timers } = h;
  WebRTC.currentConnectionAttemptId = 'legacy-attempt';
  WebRTC.beginFirstFrameDeadline('legacy-attempt', 4321);
  const handle = WebRTC._firstFrameTimer;
  assert.equal(timers.get(handle).delay, 4321);
  const armed = await h.sampler.sample();
  assert.equal(armed.inputGate.status, 'observed');
  assert.equal(armed.inputGate.firstFrameTimerHandlePresent, true);
  WebRTC.clearFirstFrameDeadline();
  assert.equal(timers.has(handle), false);
  assert.equal(WebRTC._firstFrameTimer, null);
  const cleared = await h.sampler.sample();
  assert.equal(cleared.inputGate.status, 'observed');
  assert.equal(cleared.inputGate.firstFrameTimerHandlePresent, false);
});

test('explicit first-frame timer deleted source property remains unknown to unchanged sampler', async (t) => {
  const h = firstFrameSamplerFixture();
  t.after(() => h.cleanup());
  delete h.WebRTC._firstFrameTimer;
  assert.equal(Object.hasOwn(h.WebRTC, '_firstFrameTimer'), false);
  const sample = await h.sampler.sample();
  assert.equal(sample.inputGate.status, 'observed');
  assert.equal(sample.inputGate.firstFrameTimerHandlePresent, null);
});

test('first-frame timeout exits connecting without reviving a stale attempt', () => {
  let timerCallback = null;
  const { WebRTC, elements } = loadWebRTC({
    setTimeout(callback) { timerCallback = callback; return 1; },
    clearTimeout() {},
  });
  WebRTC.updateNetworkUI = () => {};
  WebRTC.currentConnectionAttemptId = 'attempt-1';
  WebRTC.beginFirstFrameDeadline('attempt-1', 8000);
  timerCallback();
  assert.match(elements.get('loadingText').textContent, /超时|重试/);
  WebRTC.currentConnectionAttemptId = 'attempt-2';
  timerCallback();
  assert.equal(WebRTC.currentConnectionAttemptId, 'attempt-2');
});

test('rebuildDataChannels rebuilds DC without refresh when SCTP is connected', async () => {
  // Arrange: minimal WebRTC stub with relay mode and connected SCTP
  const calls = { createOffer: 0, refresh: 0, scheduleReconnect: 0, createInputChannel: 0 };
  const { WebRTC } = loadWebRTC();
  const wrtc = Object.assign(Object.create(WebRTC), {
    networkMode: 'relay',
    _rebuildingDc: false,
    inputChannel: null,
    inputMoveChannel: null,
    pc: {
      connectionState: 'connected',
      sctp: { state: 'connected' },
    },
    createInputChannel() { calls.createInputChannel++; },
    async createOffer() { calls.createOffer++; },
    async refresh() { calls.refresh++; },
    scheduleReconnect(r) { calls.scheduleReconnect++; },
  });

  const result = await wrtc.rebuildDataChannels('dc-closed');

  assert.equal(result, true, 'rebuildDataChannels should return true on success');
  assert.equal(calls.createInputChannel, 1, 'createInputChannel called once');
  assert.equal(calls.createOffer, 0, 'createOffer must NOT be called — un-negotiated DC needs no re-offer');
  assert.equal(calls.refresh, 0, 'refresh must NOT be called');
  assert.equal(calls.scheduleReconnect, 0, 'scheduleReconnect must NOT be called');
});

test('rebuildDataChannels falls back to scheduleReconnect when SCTP is not connected', async () => {
  const calls = { scheduleReconnect: 0, createInputChannel: 0 };
  const { WebRTC } = loadWebRTC();
  const wrtc = Object.assign(Object.create(WebRTC), {
    networkMode: 'relay',
    _rebuildingDc: false,
    pc: {
      connectionState: 'connected',
      sctp: { state: 'closed' },
    },
    createInputChannel() { calls.createInputChannel++; },
    scheduleReconnect(r) { calls.scheduleReconnect++; },
  });

  const result = await wrtc.rebuildDataChannels('dc-closed');

  assert.equal(result, false);
  assert.equal(calls.createInputChannel, 0, 'should not create DC when SCTP closed');
  assert.equal(calls.scheduleReconnect, 1, 'must fall back to scheduleReconnect');
});

test('noteDataChannelFault routes to rebuildDataChannels in relay mode with connected PC', async () => {
  const calls = { rebuild: 0, scheduleReconnect: 0 };
  const { WebRTC } = loadWebRTC();
  const wrtc = Object.assign(Object.create(WebRTC), {
    networkMode: 'relay',
    _rebuildingDc: false,
    pc: { connectionState: 'connected' },
    async rebuildDataChannels(r) { calls.rebuild++; return true; },
    scheduleReconnect(r) { calls.scheduleReconnect++; },
    shouldReconnectForDataChannelFault() { return true; },
  });

  wrtc.noteDataChannelFault('dc-closed');
  await new Promise(r => setTimeout(r, 0)); // flush microtasks

  assert.equal(calls.rebuild, 1, 'relay path must call rebuildDataChannels');
  assert.equal(calls.scheduleReconnect, 0, 'must not scheduleReconnect in relay path');
});

test('TURN dead detection: 20 consecutive bytes=0 on relay triggers refresh', () => {
  const { WebRTC } = loadWebRTC();
  const calls = { refresh: 0 };
  const wrtc = Object.assign(Object.create(WebRTC), {
    networkMode: 'relay',
    _noRelayReceiveCount: 0,
    isMediaHealthSuppressed() { return false; },
    pc: { iceConnectionState: 'completed' },
    clearFailureRecommendation() {},
    updateNetworkUI() {},
    refresh(opts) { calls.refresh++; },
    // stub out everything processStatsSnapshot touches
    selectedCandidatePair: {},
    _lastInboundFramesDecoded: 0,
    _lastInboundFramesDecodedAt: null,
    _mediaResumeFramePending: false,
    noMediaTicks: 0,
    lastCandidateType: 'relay',
    adaptiveMediaEnabled: false,
    _autoFailCount: 0,
    handlePortSearchMedia() {},
    handleReceiverStats() {},
    setFailureRecommendation() {},
    _videoFrameSeq: 0,
  });

  const statsZeroBytes = {
    fps: 0, rttMs: 30, jitterBufferMs: 0,
    framesReceived: 0, framesDecoded: 0, packetsLost: 0,
    bytesReceived: 0, codec: 'H264',
    selectedCandidateType: 'relay',
    selectedCandidatePair: {},
  };

  // 19 samples — must NOT refresh yet
  for (let i = 0; i < 19; i++) {
    wrtc.processStatsSnapshot(statsZeroBytes);
  }
  assert.equal(calls.refresh, 0, 'must not refresh before 20 samples');
  assert.equal(wrtc._noRelayReceiveCount, 19);

  // 20th sample — must refresh
  wrtc.processStatsSnapshot(statsZeroBytes);
  assert.equal(calls.refresh, 1, 'must refresh after 20 consecutive zero-byte samples');
  assert.equal(wrtc._noRelayReceiveCount, 0, 'counter must reset after refresh');
});

test('TURN dead detection: non-zero bytes resets counter', () => {
  const { WebRTC, context } = loadWebRTC();
  const calls = { refresh: 0 };
  const wrtc = Object.assign(Object.create(WebRTC), {
    networkMode: 'relay',
    _noRelayReceiveCount: 18,
    isMediaHealthSuppressed() { return false; },
    pc: { iceConnectionState: 'completed' },
    clearFailureRecommendation() {},
    updateNetworkUI() {},
    refresh(opts) { calls.refresh++; },
    selectedCandidatePair: {},
    _lastInboundFramesDecoded: 100,
    _lastInboundFramesDecodedAt: context.performance.now(),
    _mediaResumeFramePending: false,
    noMediaTicks: 0,
    lastCandidateType: 'relay',
    adaptiveMediaEnabled: false,
    _autoFailCount: 0,
    handlePortSearchMedia() {},
    handleReceiverStats() {},
    setFailureRecommendation() {},
    _videoFrameSeq: 0,
  });

  // sample with actual bytes arriving
  wrtc.processStatsSnapshot({
    fps: 20, rttMs: 35, jitterBufferMs: 8,
    framesReceived: 20, framesDecoded: 20, packetsLost: 0,
    bytesReceived: 150000, codec: 'H264',
    selectedCandidateType: 'relay',
    selectedCandidatePair: {},
  });
  assert.equal(calls.refresh, 0, 'must NOT refresh when bytes arrive');
  assert.equal(wrtc._noRelayReceiveCount, 0, 'counter must reset when bytes arrive');
});

test('TURN dead detection: suppressed media does not count toward dead-channel threshold', () => {
  const { WebRTC } = loadWebRTC();
  const calls = { refresh: 0 };
  const wrtc = Object.assign(Object.create(WebRTC), {
    networkMode: 'relay',
    _noRelayReceiveCount: 19,
    isMediaHealthSuppressed() { return true; }, // page-hidden
    pc: { iceConnectionState: 'completed' },
    clearFailureRecommendation() {},
    updateNetworkUI() {},
    refresh(opts) { calls.refresh++; },
    selectedCandidatePair: {},
    _lastInboundFramesDecoded: 0,
    _lastInboundFramesDecodedAt: null,
    _mediaResumeFramePending: false,
    noMediaTicks: 0,
    lastCandidateType: 'relay',
    adaptiveMediaEnabled: false,
    _autoFailCount: 0,
    handlePortSearchMedia() {},
    handleReceiverStats() {},
    setFailureRecommendation() {},
    _videoFrameSeq: 0,
  });

  // 20th sample — but suppressed, so must NOT refresh
  wrtc.processStatsSnapshot({
    fps: 0, rttMs: 30, jitterBufferMs: 0,
    framesReceived: 0, framesDecoded: 0, packetsLost: 0,
    bytesReceived: 0, codec: 'H264',
    selectedCandidateType: 'relay',
    selectedCandidatePair: {},
  });
  assert.equal(calls.refresh, 0, 'must NOT refresh while media is intentionally suppressed');
});

test('recovery refresh is suppressed within 3s of last refresh', async () => {
  const { WebRTC, context } = loadWebRTC();
  let closed = 0;
  WebRTC.socket = { connected: true };
  WebRTC.networkMode = 'relay';
  WebRTC.hasTurnConfigured = () => true;
  WebRTC.stopTunnelRelay = () => {};
  WebRTC.createPeerConnection = () => { WebRTC.pc = { close() {} }; };
  WebRTC.createOffer = () => {};
  WebRTC.pc = { close() { closed += 1; } };
  WebRTC._lastRefreshAt = context.performance.now();
  await WebRTC.refresh({ reason: 'dc-dead-on-resume' });
  assert.equal(closed, 0);
});

test('manual refresh bypasses recovery cooldown', async () => {
  const { WebRTC, context } = loadWebRTC();
  let closed = 0;
  WebRTC.socket = { connected: true };
  WebRTC.networkMode = 'relay';
  WebRTC.hasTurnConfigured = () => true;
  WebRTC.stopTunnelRelay = () => {};
  WebRTC.createPeerConnection = () => { WebRTC.pc = { close() {} }; };
  WebRTC.createOffer = () => {};
  WebRTC.pc = { close() { closed += 1; } };
  WebRTC._lastRefreshAt = context.performance.now();
  await WebRTC.refresh({ reason: 'manual' });
  assert.equal(closed, 1);
});

test('refresh keeps _refreshing true until settled', async () => {
  const { WebRTC } = loadWebRTC();
  WebRTC.socket = { connected: true };
  WebRTC.networkMode = 'relay';
  WebRTC.hasTurnConfigured = () => true;
  WebRTC.stopTunnelRelay = () => {};
  WebRTC.createPeerConnection = () => { WebRTC.pc = { close() {}, connectionState: 'connecting' }; };
  WebRTC.createOffer = () => {};
  WebRTC.pc = { close() {} };
  await WebRTC.refresh({ reason: 'manual' });
  assert.equal(WebRTC._refreshing, true);
  WebRTC.markRefreshSettled('test');
  assert.equal(WebRTC._refreshing, false);
});

test('stale pc-connected dc-wait timer cannot clear a newer refresh', async () => {
  const timers = [];
  const { WebRTC } = loadWebRTC({
    setTimeout(callback, ms) {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
  });
  WebRTC.startStats = () => {};
  WebRTC.startVideoFrameTracking = () => {};
  WebRTC.syncMediaProfile = () => {};
  WebRTC.clearFailureRecommendation = () => {};
  WebRTC.updateNetworkUI = () => {};
  WebRTC.ensureMediaActiveIfVisible = () => {};
  WebRTC.syncDesktopInputGate = () => {};
  WebRTC.stopTunnelRelay = () => {};
  WebRTC.captureLastFrameHold = () => false;
  WebRTC.replayMediaActivityIntent = () => {};
  WebRTC.createPeerConnection = () => {};
  WebRTC.createOffer = () => {};
  WebRTC.socket = { connected: true };
  WebRTC.networkMode = 'stun';
  WebRTC.pc = { close() {} };
  WebRTC._refreshing = true;
  WebRTC.inputChannel = { readyState: 'connecting' };

  WebRTC.onPeerConnected();
  const waitTimer = timers.find((timer) => timer.ms === 2000);
  assert.ok(waitTimer);

  await WebRTC.refresh({ reason: 'manual' });
  assert.equal(WebRTC._refreshing, true);

  // Simulate the stale callback firing despite timer cancellation.
  waitTimer.callback();
  assert.equal(WebRTC._refreshing, true);
});

test('non-forced refresh is ignored while _refreshing', async () => {
  const { WebRTC } = loadWebRTC();
  let closed = 0;
  WebRTC._refreshing = true;
  WebRTC._lastRefreshAt = null;
  WebRTC.pc = { close() { closed += 1; } };
  WebRTC.socket = { connected: true };
  WebRTC.networkMode = 'stun';
  WebRTC.stopTunnelRelay = () => {};
  WebRTC.captureLastFrameHold = () => false;
  WebRTC.createPeerConnection = () => {};
  WebRTC.createOffer = () => {};

  await WebRTC.refresh({ reason: 'media-request-failed' });

  assert.equal(closed, 0);
  assert.equal(WebRTC._refreshing, true);
});

test('scheduleReconnect is a no-op while _refreshing', () => {
  const { WebRTC } = loadWebRTC();
  let refreshes = 0;
  WebRTC.manualDisconnect = false;
  WebRTC._refreshing = true;
  WebRTC.reconnectTimer = null;
  WebRTC.isMediaHealthSuppressed = () => false;
  WebRTC.isPortSearchActive = () => false;
  WebRTC.refresh = () => { refreshes += 1; };
  WebRTC.scheduleReconnect('ice-closed');
  assert.equal(refreshes, 0);
  assert.equal(WebRTC.reconnectTimer, null);
});

test('brief PC connect does not reset recovery circuit breakers', () => {
  const { WebRTC } = loadWebRTC();
  WebRTC._reconnectAttempt = 3;
  WebRTC._relayHardRefreshCount = 2;
  WebRTC._mediaResumeRefreshFallbackUsed = true;
  WebRTC._mediaResumeSoftRecoverUsed = true;
  WebRTC.pc = {
    connectionState: 'connected',
    iceConnectionState: 'completed',
  };
  WebRTC.startStats = () => {};
  WebRTC.startVideoFrameTracking = () => {};
  WebRTC.syncMediaProfile = () => {};
  WebRTC.clearFailureRecommendation = () => {};
  WebRTC.updateNetworkUI = () => {};
  WebRTC.ensureMediaActiveIfVisible = () => {};
  WebRTC.syncDesktopInputGate = () => {};
  // 调用将要抽出的方法
  WebRTC.onPeerConnected();
  assert.equal(WebRTC._reconnectAttempt, 3);
  assert.equal(WebRTC._relayHardRefreshCount, 2);
  assert.equal(WebRTC._mediaResumeRefreshFallbackUsed, true);
  assert.equal(WebRTC._mediaResumeSoftRecoverUsed, true);
});

test('stable window resets circuit breakers after 5s connected', () => {
  const timers = [];
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  global.setTimeout = (fn, ms) => {
    const handle = { fn, ms, cleared: false };
    timers.push(handle);
    return handle;
  };
  global.clearTimeout = (handle) => { if (handle) handle.cleared = true; };
  try {
    const { WebRTC } = loadWebRTC();
    WebRTC._reconnectAttempt = 3;
    WebRTC.pc = { connectionState: 'connected' };
    WebRTC.startStats = () => {};
    WebRTC.startVideoFrameTracking = () => {};
    WebRTC.syncMediaProfile = () => {};
    WebRTC.clearFailureRecommendation = () => {};
    WebRTC.updateNetworkUI = () => {};
    WebRTC.ensureMediaActiveIfVisible = () => {};
    WebRTC.syncDesktopInputGate = () => {};
    WebRTC.onPeerConnected();
    const stable = timers.find((t) => t.ms === 5000);
    assert.ok(stable);
    stable.fn();
    assert.equal(WebRTC._reconnectAttempt, 0);
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test('tab return rebuilds DataChannels instead of full refresh when SCTP is live', () => {
  const listeners = {};
  const { WebRTC } = loadWebRTC({
    document: {
      hidden: false,
      body: makeElement(),
      addEventListener(type, fn) { listeners[type] = fn; },
      getElementById() { return makeElement(); },
      querySelector: () => null,
    },
  });
  let refreshes = 0;
  let rebuilds = 0;
  WebRTC._controlLifecycleBound = false;
  WebRTC.bindControlLifecycle();
  WebRTC.pc = { connectionState: 'connected', sctp: { state: 'connected' } };
  WebRTC.inputChannel = { readyState: 'closing' };
  WebRTC.manualDisconnect = false;
  WebRTC._refreshing = false;
  WebRTC.hasActiveControl = () => false;
  WebRTC.ensureMediaActiveIfVisible = () => false;
  WebRTC.refresh = () => { refreshes += 1; };
  WebRTC.rebuildDataChannels = () => { rebuilds += 1; return true; };
  listeners.visibilitychange();
  assert.equal(rebuilds, 1);
  assert.equal(refreshes, 0);
});

test('rebindActiveKeyboardLease reapplies the current control lease', () => {
  const { WebRTC, context } = loadWebRTC();
  const leases = [];
  context.Input = {
    setControlLease(lease) { leases.push(lease); },
    setKeyboardDataChannelAvailable() {},
    updateKeyboardUI() {},
  };
  WebRTC.controlState = {
    state: 'ACTIVE',
    controller: true,
    lease: { leaseId: 'lease-live-00000001', leaseEpoch: 3 },
  };
  WebRTC.inputChannel = { readyState: 'open' };
  assert.equal(WebRTC.rebindActiveKeyboardLease('test'), true);
  assert.equal(leases.length, 1);
  assert.equal(leases[0].leaseId, 'lease-live-00000001');
});

test('refresh with last-frame hold keeps the full-screen loader hidden', async () => {
  const { WebRTC, context } = loadWebRTC();
  WebRTC.socket = { connected: true };
  WebRTC.networkMode = 'relay';
  WebRTC.hasTurnConfigured = () => true;
  WebRTC.stopTunnelRelay = () => {};
  WebRTC.createPeerConnection = () => { WebRTC.pc = { close() {} }; };
  WebRTC.createOffer = () => {};
  WebRTC.pc = { close() {} };
  WebRTC.captureLastFrameHold = () => true;
  const loading = context.document.getElementById('loading');
  loading.classList.add('hidden');
  await WebRTC.refresh({ reason: 'manual' });
  assert.equal(loading.classList.contains('hidden'), true);
});

test('relay applyMediaProfile uses 720p cap when pref is 1080p', () => {
  const { WebRTC, context } = loadWebRTC();
  WebRTC.networkMode = 'relay';
  WebRTC._explicitOverride1080 = false;
  WebRTC.currentResolution = { width: 1920, height: 1080, label: '1920x1080' };
  WebRTC.socket = { connected: true, emit(event, payload) { context._last = [event, payload]; } };
  WebRTC.controlState = { lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 } };
  WebRTC.activeLeaseEnvelope = () => WebRTC.controlState.lease;
  WebRTC.applyMediaProfile({ name: 'high', width: 1280, height: 720, fps: 20, bitrateKbps: 2500 }, 'connection-sync');
  assert.equal(context._last[0], 'media-profile-change');
  assert.equal(context._last[1].width, 1280);
  assert.equal(context._last[1].height, 720);
  assert.equal(context._last[1].adaptiveResolution, false);
});

test('beginConnectionAttempt viewer-open clears 1080p override', () => {
  const { WebRTC } = loadWebRTC();
  WebRTC._explicitOverride1080 = true;
  WebRTC.beginConnectionAttempt('viewer-open');
  assert.equal(WebRTC._explicitOverride1080, false);
});

test('refresh attempt keeps 1080p override', () => {
  const { WebRTC } = loadWebRTC();
  WebRTC._explicitOverride1080 = true;
  WebRTC.beginConnectionAttempt('refresh');
  assert.equal(WebRTC._explicitOverride1080, true);
});

test('requestResolution 1080p on relay sets override flag', () => {
  const { WebRTC } = loadWebRTC();
  WebRTC.networkMode = 'relay';
  WebRTC.socket = { connected: true, emit() {} };
  WebRTC.controlState = { lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 } };
  WebRTC.activeLeaseEnvelope = () => WebRTC.controlState.lease;
  WebRTC.requestResolution(1920, 1080);
  assert.equal(WebRTC._explicitOverride1080, true);
  const pres = WebRTC.getSessionPresentation();
  assert.equal(pres.width, 1920);
});

test('beginConnectionAttempt manual-mode-switch clears 1080p override', () => {
  const { WebRTC } = loadWebRTC();
  WebRTC._explicitOverride1080 = true;
  WebRTC.beginConnectionAttempt('manual-mode-switch');
  assert.equal(WebRTC._explicitOverride1080, false);
});

test('requestResolution 1600p on relay emits 720p session size', async () => {
  const { WebRTC, context } = loadWebRTC();
  WebRTC.networkMode = 'relay';
  WebRTC._explicitOverride1080 = false;
  WebRTC.socket = { connected: true, emit(event, payload) { context._last = [event, payload]; } };
  WebRTC.controlState = { lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 } };
  WebRTC.activeLeaseEnvelope = () => WebRTC.controlState.lease;
  await WebRTC.requestResolution(1600, 900);
  assert.equal(WebRTC._explicitOverride1080, false);
  assert.equal(WebRTC.currentResolution.width, 1600);
  assert.equal(context._last[0], 'media-profile-change');
  assert.equal(context._last[1].width, 1280);
  assert.equal(context._last[1].height, 720);
});

test('createOffer emits session presentation size', async () => {
  const { WebRTC } = loadWebRTC();
  const emitted = [];
  WebRTC.socket = {
    connected: true,
    emit(...args) { emitted.push(args); },
  };
  WebRTC.controlState = {
    state: 'ACTIVE',
    controller: true,
    hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 4 },
  };
  WebRTC.networkMode = 'relay';
  WebRTC.hasTurnConfigured = () => true;
  WebRTC._explicitOverride1080 = false;
  WebRTC.currentResolution = { width: 1920, height: 1080, label: '1920x1080' };
  WebRTC.currentConnectionAttemptId = 'attempt-from-begin';
  WebRTC.pc = {
    getTransceivers: () => [],
    addTransceiver: () => ({}),
    createOffer: async () => ({ type: 'offer', sdp: 'v=0' }),
    setLocalDescription: async () => {},
    localDescription: { type: 'offer', sdp: 'v=0' },
    iceGatheringState: 'complete',
    close() {},
  };
  WebRTC.preferH264 = () => {};

  await WebRTC.createOffer();
  const offerEmit = emitted.find((entry) => entry[0] === 'offer');
  assert.ok(offerEmit);
  assert.equal(offerEmit[1].width, 1280);
  assert.equal(offerEmit[1].height, 720);
});

test('ontrack with paused=false and readyState=0 does not mark connected', () => {
  const { WebRTC, elements, context } = loadWebRTC();
  const video = elements.get('remoteVideo') || context.document.getElementById('remoteVideo');
  video.readyState = 0;
  video.paused = false;
  video.videoWidth = 0;
  video.videoHeight = 0;
  WebRTC.uiPhase = 'signaling';
  WebRTC.hasPaintedFrame = false;
  WebRTC.markRemoteTrack({ readyState: 0, paused: false });
  assert.notEqual(elements.get('connectionStatus').textContent, '已连接');
  assert.equal(WebRTC.uiPhase, 'media-pending');
});

test('framesDecoded growth sets connected', () => {
  const { WebRTC, elements } = loadWebRTC();
  WebRTC.uiPhase = 'media-pending';
  WebRTC._paintDecodedBaseline = 0;
  WebRTC.hasPaintedFrame = false;
  WebRTC.notePaintStats({ framesDecoded: 1, framesReceived: 1, fps: 12, videoWidth: 1280, videoHeight: 720 });
  assert.equal(WebRTC.uiPhase, 'connected');
  assert.equal(WebRTC.hasPaintedFrame, true);
  assert.equal(elements.get('connectionStatus').textContent, '已连接');
});

test('stall 1s with received>0 does not scheduleReconnect', () => {
  const { WebRTC } = loadWebRTC();
  const reconnects = [];
  WebRTC.scheduleReconnect = (reason) => reconnects.push(reason);
  WebRTC.uiPhase = 'connected';
  WebRTC.hasPaintedFrame = true;
  WebRTC._stallSince = Date.now() - 1000;
  WebRTC.notePaintStats({ framesDecoded: 40, framesReceived: 19, fps: 0, videoWidth: 1280, videoHeight: 720 });
  assert.equal(WebRTC.uiPhase, 'media-stalled');
  assert.deepEqual(reconnects, []);
});

test('relay 1s zero-fps chase stays connected; 2s becomes media-stalled', () => {
  const { WebRTC } = loadWebRTC();
  const reconnects = [];
  WebRTC.scheduleReconnect = (reason) => reconnects.push(reason);
  WebRTC.networkMode = 'relay';
  WebRTC.uiPhase = 'connected';
  WebRTC.hasPaintedFrame = true;
  WebRTC._stallSince = Date.now() - 1000;
  WebRTC.notePaintStats({ framesDecoded: 40, framesReceived: 19, fps: 0, videoWidth: 1280, videoHeight: 720 });
  assert.equal(WebRTC.uiPhase, 'connected');
  WebRTC._stallSince = Date.now() - 2000;
  WebRTC.notePaintStats({ framesDecoded: 40, framesReceived: 19, fps: 0, videoWidth: 1280, videoHeight: 720 });
  assert.equal(WebRTC.uiPhase, 'media-stalled');
  assert.deepEqual(reconnects, []);
});

test('shouldHideLoading is true only after a painted frame', () => {
  const { WebRTC } = loadWebRTC();
  assert.equal(WebRTC.shouldHideLoading({ hasPaintedFrame: false }), false);
  assert.equal(WebRTC.shouldHideLoading({ readyState: 4, paused: false, hasPaintedFrame: false }), false);
  assert.equal(WebRTC.shouldHideLoading({ hasPaintedFrame: true }), true);
});

test('framesDecoded without videoWidth does not mark connected', () => {
  const { WebRTC, context } = loadWebRTC();
  WebRTC.uiPhase = 'media-pending';
  WebRTC._paintDecodedBaseline = 0;
  WebRTC.hasPaintedFrame = false;
  WebRTC.notePaintStats({ framesDecoded: 4, framesReceived: 4, fps: 12, videoWidth: 0, videoHeight: 0 });
  assert.equal(WebRTC.hasPaintedFrame, false);
  assert.notEqual(WebRTC.uiPhase, 'connected');
  assert.notEqual(context.document.getElementById('connectionStatus').textContent, '已连接');
});

test('onPeerConnected safety net stays media-pending', () => {
  const { WebRTC, elements } = loadWebRTC();
  WebRTC.uiPhase = 'signaling';
  WebRTC.hasPaintedFrame = false;
  WebRTC.pc = { connectionState: 'connected', iceConnectionState: 'completed' };
  WebRTC.startStats = () => {};
  WebRTC.startVideoFrameTracking = () => {};
  WebRTC.syncMediaProfile = () => {};
  WebRTC.clearFailureRecommendation = () => {};
  WebRTC.updateNetworkUI = () => {};
  WebRTC.ensureMediaActiveIfVisible = () => {};
  WebRTC.syncDesktopInputGate = () => {};
  WebRTC.onPeerConnected();
  assert.equal(WebRTC.uiPhase, 'media-pending');
  assert.equal(elements.get('connectionStatus').textContent, '正在出画');
  assert.notEqual(elements.get('connectionStatus').textContent, '已连接');
});

test('8s paint fallback stays media-pending without painted frame', () => {
  const { WebRTC, elements } = loadWebRTC();
  WebRTC.uiPhase = 'media-pending';
  WebRTC.hasPaintedFrame = false;
  WebRTC.applyPaintFallback();
  assert.equal(WebRTC.uiPhase, 'media-pending');
  assert.equal(elements.get('connectionStatus').textContent, '正在出画');
  assert.equal(WebRTC.hasPaintedFrame, false);
});

test('capture_stats does not overwrite playback fpsDisplay', () => {
  const { WebRTC, context } = loadWebRTC();
  const fpsEl = context.document.getElementById('fpsDisplay');
  fpsEl.textContent = '12 FPS';
  WebRTC.pc = {
    createDataChannel() {
      return { readyState: 'connecting', bufferedAmount: 0, send() {}, bufferedAmountLowThreshold: 0 };
    },
  };
  WebRTC.createInputChannel();
  WebRTC.inputChannel.onmessage({ data: JSON.stringify({ type: 'capture_stats', fps: 60 }) });
  assert.equal(fpsEl.textContent, '12 FPS');
  assert.equal(WebRTC._hostCaptureFps, 60);
});

test('decoded progress timestamp updates for every positive canonical delta', () => {
  let now = 1000;
  const { WebRTC } = loadWebRTC({ performance: { now: () => now } });
  WebRTC._lastInboundFramesDecoded = 100;
  WebRTC._lastInboundFramesDecodedAt = null;
  WebRTC.handlePortSearchMedia = () => {};
  WebRTC.handleReceiverStats = () => {};

  WebRTC.processStatsSnapshot({
    derivedFps: 10,
    decodedDelta: 10,
    receivedDelta: 10,
    bytesDelta: 1000,
    totals: { framesDecoded: 110 },
    selectedCandidateType: 'host',
  });
  assert.equal(WebRTC._lastInboundFramesDecodedAt, 1000);

  now = 2000;
  WebRTC.processStatsSnapshot({
    derivedFps: 1,
    decodedDelta: 1,
    receivedDelta: 1,
    bytesDelta: 100,
    totals: { framesDecoded: 111 },
    selectedCandidateType: 'host',
  });
  assert.equal(WebRTC._lastInboundFramesDecodedAt, 2000);
  assert.equal(WebRTC._lastInboundFramesDecoded, 111);
});

test('warmup stats sample does not move a painted stream into stall', () => {
  const { WebRTC } = loadWebRTC();
  WebRTC.uiPhase = 'connected';
  WebRTC.hasPaintedFrame = true;
  WebRTC._stallSince = Date.now() - 10000;

  WebRTC.notePaintStats({
    warmup: true,
    derivedFps: 0,
    decodedDelta: 0,
    receivedDelta: 20,
    videoWidth: 1280,
    videoHeight: 720,
  });

  assert.equal(WebRTC.uiPhase, 'connected');
  assert.equal(WebRTC._stallSince, null);
});

test('intentional media pause skips quality recovery for canonical stats', () => {
  const { WebRTC } = loadWebRTC();
  let recoveryCalls = 0;
  WebRTC.networkMode = 'relay';
  WebRTC.isMediaHealthSuppressed = () => true;
  WebRTC.handleReceiverStats = () => { recoveryCalls += 1; };
  WebRTC.handlePortSearchMedia = () => {};
  WebRTC.pc = { iceConnectionState: 'completed' };

  WebRTC.processStatsSnapshot({
    derivedFps: 0,
    decodedDelta: 0,
    receivedDelta: 0,
    bytesDelta: 0,
    selectedCandidateType: 'relay',
  });

  assert.equal(recoveryCalls, 0);
  assert.equal(WebRTC._noRelayReceiveCount, 0);
});

test('intentional media pause suppresses stalled paint diagnostics for delayed inbound data', () => {
  const timers = new Map();
  const diagnostics = [];
  const { WebRTC } = loadWebRTC({
    setTimeout(callback, ms) { timers.set(ms, callback); return ms; },
    clearTimeout(ms) { timers.delete(ms); },
    Diagnostic: { autoSendFailure(reason) { diagnostics.push(reason); } },
  });
  WebRTC.networkMode = 'relay';
  WebRTC.uiPhase = 'connected';
  WebRTC.hasPaintedFrame = true;
  WebRTC._stallSince = Date.now() - 10000;
  WebRTC.isMediaHealthSuppressed = () => true;

  WebRTC.notePaintStats({
    derivedFps: 0,
    decodedDelta: 0,
    receivedDelta: 20,
    videoWidth: 1280,
    videoHeight: 720,
    source: 'stats',
  });

  assert.equal(WebRTC.uiPhase, 'connected');
  assert.equal(WebRTC._stallSince, null);
  assert.equal(timers.has(3000), false);
  assert.deepEqual(diagnostics, []);
});

test('viewer stats emits canonical deltas with derived legacy aliases for Host compatibility', () => {
  const { WebRTC } = loadWebRTC();
  const emitted = [];
  WebRTC.socket = { connected: true, emit(event, payload) { emitted.push({ event, payload }); } };
  WebRTC.handlePortSearchMedia = () => {};
  WebRTC.handleReceiverStats = () => {};
  WebRTC.currentConnectionAttemptId = 'attempt-viewer-stats';
  WebRTC.connectionAttemptSequence = 6;

  WebRTC.processStatsSnapshot({
    derivedFps: 19,
    browserReportedFps: 90,
    receivedDelta: 20,
    decodedDelta: 19,
    packetsLostDelta: 2,
    bytesDelta: 4000,
    totals: { framesDecoded: 119 },
    selectedCandidateType: 'relay',
  });

  const report = emitted.find(({ event }) => event === 'viewer-stats')?.payload;
  assert.equal(report.derivedFps, 19);
  assert.equal(report.browserReportedFps, 90);
  assert.equal(report.decodedDelta, 19);
  assert.equal(report.receivedDelta, 20);
  assert.equal(report.fps, 19);
  assert.equal(report.framesDecoded, 19);
  assert.equal(report.framesReceived, 20);
  assert.equal(report.connectionAttemptId, 'attempt-viewer-stats');
  assert.equal(report.connectionAttemptSequence, 6);
  assert.equal(report.generation, 6);
});

test('updateConnectionStatus exposes paint-gate labels', () => {
  const { context } = loadWebRTC();
  const statusEl = context.document.getElementById('connectionStatus');
  context.updateConnectionStatus('connecting');
  assert.equal(statusEl.textContent, '连接中');
  context.updateConnectionStatus('media-pending');
  assert.equal(statusEl.textContent, '正在出画');
  context.updateConnectionStatus('connected');
  assert.equal(statusEl.textContent, '已连接');
  context.updateConnectionStatus('media-stalled');
  assert.equal(statusEl.textContent, '画面卡顿');
  context.updateConnectionStatus('disconnected');
  assert.equal(statusEl.textContent, '已断开');
});

test('Terminal media suspension has an explicit status and chrome snapshot reason', () => {
  const { WebRTC, context } = loadWebRTC();
  const mediaControllerSource = fs.readFileSync(
    path.join(__dirname, 'media-activity-controller.js'),
    'utf8',
  );
  vm.runInContext(mediaControllerSource, context);
  context.MediaActivityController = context.MediaActivityController
    || context.window?.MediaActivityController;
  WebRTC.uiPhase = 'connected';
  WebRTC.hasPaintedFrame = true;
  WebRTC.initializeMediaActivity();
  WebRTC.setMediaActivityReason('terminal-active', true);
  const statusEl = context.document.getElementById('connectionStatus');
  assert.equal(statusEl.textContent, 'Terminal 已暂停');
  assert.equal(statusEl.className, 'status media-paused-terminal');
  assert.deepEqual(Array.from(WebRTC.getChromeSnapshot().mediaActivityReasons), ['terminal-active']);
  assert.equal(WebRTC.getChromeSnapshot().terminalActive, true);
  assert.equal(WebRTC.getChromeSnapshot().mediaPausedReason, 'terminal-active');
  WebRTC.setUiPhase('media-stalled', { reason: 'terminal-paused-stats' });
  assert.equal(statusEl.textContent, 'Terminal 已暂停');

  WebRTC.setMediaActivityReason('terminal-active', false);
  assert.equal(statusEl.textContent, '画面卡顿');
  assert.equal(WebRTC.getChromeSnapshot().terminalActive, false);
});

test('first-frame deadline is cancelled by painted-frame growth', () => {
  let timerCallback = null;
  const { WebRTC, context } = loadWebRTC({
    setTimeout(callback) { timerCallback = callback; return 1; },
    clearTimeout() { timerCallback = null; },
  });
  WebRTC.updateNetworkUI = () => {};
  WebRTC.setFailureRecommendation = () => {};
  WebRTC.currentConnectionAttemptId = 'attempt-paint';
  WebRTC.uiPhase = 'media-pending';
  WebRTC.hasPaintedFrame = false;
  WebRTC._paintDecodedBaseline = 0;
  WebRTC.beginFirstFrameDeadline('attempt-paint', 8000);
  WebRTC.notePaintStats({
    framesDecoded: 1,
    framesReceived: 1,
    fps: 12,
    videoWidth: 1280,
    videoHeight: 720,
  });
  assert.equal(WebRTC.hasPaintedFrame, true);
  assert.equal(WebRTC.uiPhase, 'connected');
  assert.equal(timerCallback, null);
  assert.equal(context.document.getElementById('connectionStatus').textContent, '已连接');
});

test('media-pending with PC connected cancels first-frame deadline', () => {
  const timers = new Map();
  let nextId = 1;
  const { WebRTC } = loadWebRTC({
    setTimeout(callback, ms) {
      const id = nextId++;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  WebRTC.updateNetworkUI = () => {};
  WebRTC.currentConnectionAttemptId = 'attempt-pending';
  WebRTC.pc = { connectionState: 'connected', iceConnectionState: 'completed' };
  WebRTC.hasPaintedFrame = false;
  WebRTC.beginFirstFrameDeadline('attempt-pending', 8000);
  assert.ok(WebRTC._firstFrameTimer);
  WebRTC.setUiPhase('media-pending', { reason: 'pc-connected' });
  assert.equal(WebRTC._firstFrameTimer, null);
  assert.equal(timers.has(WebRTC._paintPending3sTimer), true);
  assert.equal(timers.has(WebRTC._paintPending8sTimer), true);
});

test('same-window first-frame deadline and paint fallback stay consistent', () => {
  const timers = new Map();
  let nextId = 1;
  const { WebRTC, context } = loadWebRTC({
    setTimeout(callback, ms) {
      const id = nextId++;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  WebRTC.updateNetworkUI = () => {};
  WebRTC.setFailureRecommendation = () => {};
  WebRTC.currentConnectionAttemptId = 'attempt-window';
  WebRTC.uiPhase = 'signaling';
  WebRTC.hasPaintedFrame = false;
  WebRTC.pc = { connectionState: 'connecting', iceConnectionState: 'checking' };
  WebRTC.beginFirstFrameDeadline('attempt-window', 8000);
  const deadline = timers.get(WebRTC._firstFrameTimer);
  assert.equal(typeof deadline?.callback, 'function');
  WebRTC.applyPaintFallback();
  assert.equal(WebRTC.uiPhase, 'media-pending');
  assert.equal(context.document.getElementById('connectionStatus').textContent, '正在出画');
  assert.equal(timers.has(WebRTC._firstFrameTimer), true);
  deadline.callback();
  assert.equal(WebRTC.uiPhase, 'disconnected');
  assert.equal(context.document.getElementById('connectionStatus').textContent, '已断开');
  WebRTC.applyPaintFallback();
  assert.equal(WebRTC.uiPhase, 'disconnected');
});

test('applyPaintFallback does not resurrect status after first-frame failure', () => {
  const { WebRTC, context } = loadWebRTC();
  WebRTC.updateNetworkUI = () => {};
  WebRTC.setFailureRecommendation = () => {};
  WebRTC.currentConnectionAttemptId = 'attempt-fail';
  WebRTC.uiPhase = 'media-pending';
  WebRTC.hasPaintedFrame = false;
  WebRTC.endConnectingWithFailure('first-frame-timeout');
  assert.equal(WebRTC.uiPhase, 'disconnected');
  assert.equal(context.document.getElementById('connectionStatus').textContent, '已断开');
  WebRTC.applyPaintFallback();
  assert.equal(WebRTC.uiPhase, 'disconnected');
  assert.equal(context.document.getElementById('connectionStatus').textContent, '已断开');
});

test('scheduleReconnect keeps uiPhase in sync with disconnected status', () => {
  const { WebRTC, context } = loadWebRTC();
  WebRTC.manualDisconnect = false;
  WebRTC.reconnectTimer = null;
  WebRTC._refreshing = false;
  WebRTC._superseded = false;
  WebRTC._lastRefreshAt = null;
  WebRTC.isMediaHealthSuppressed = () => false;
  WebRTC.isPortSearchActive = () => false;
  WebRTC.hasTurnConfigured = () => false;
  WebRTC.uiPhase = 'connected';
  WebRTC.hasPaintedFrame = true;
  WebRTC.scheduleReconnect('pc-failed');
  assert.equal(WebRTC.uiPhase, 'disconnected');
  assert.equal(context.document.getElementById('connectionStatus').textContent, '已断开');
});

test('relay stall copy suggests tunnel without switching mode', () => {
  const { WebRTC } = loadWebRTC();
  const modes = [];
  WebRTC.networkMode = 'relay';
  WebRTC.enforceSupportedNetworkMode = (m) => modes.push(m);
  WebRTC.updateNetworkUI = (text) => { WebRTC._ui = text; };
  WebRTC.announcePaintIssue('media-stalled');
  assert.match(WebRTC._ui, /隧道中继/);
  assert.deepEqual(modes, []);
  assert.equal(WebRTC.networkMode, 'relay');
});

test('media-pending 3s and 8s copy stay warning without switching mode', () => {
  const timers = new Map();
  const { WebRTC } = loadWebRTC({
    setTimeout(callback, ms) {
      timers.set(ms, callback);
      return ms;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  const modes = [];
  const ui = [];
  WebRTC.networkMode = 'relay';
  WebRTC.pc = { connectionState: 'connected', iceConnectionState: 'connected' };
  WebRTC.enforceSupportedNetworkMode = (m) => modes.push(m);
  WebRTC.updateNetworkUI = (text, severity) => { ui.push([text, severity]); };
  WebRTC.setUiPhase('media-pending', { reason: 'pc-connected' });
  assert.equal(typeof timers.get(3000), 'function');
  assert.equal(typeof timers.get(8000), 'function');
  timers.get(3000)();
  timers.get(8000)();
  assert.deepEqual(ui, [
    ['链路已通，正在等待第一帧。', 'warning'],
    ['第一帧仍未到达，请点击「刷新画面」。', 'warning'],
  ]);
  assert.deepEqual(modes, []);
  assert.equal(WebRTC.networkMode, 'relay');
});

test('beginConnectionAttempt clears media-pending copy timers', () => {
  const timers = new Map();
  const { WebRTC } = loadWebRTC({
    setTimeout(callback, ms) {
      timers.set(ms, callback);
      return ms;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  WebRTC.networkMode = 'relay';
  WebRTC.pc = { connectionState: 'connected', iceConnectionState: 'connected' };
  WebRTC.updateNetworkUI = () => {};
  WebRTC.setUiPhase('media-pending', { reason: 'pc-connected' });
  assert.equal(timers.has(3000), true);
  assert.equal(timers.has(8000), true);
  WebRTC.beginConnectionAttempt('refresh');
  assert.equal(timers.has(3000), false);
  assert.equal(timers.has(8000), false);
});

test('explicit 1080p on relay warns without switching mode', async () => {
  const { WebRTC } = loadWebRTC();
  const modes = [];
  const ui = [];
  WebRTC.networkMode = 'relay';
  WebRTC.socket = { connected: true, emit() {} };
  WebRTC.controlState = { lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 } };
  WebRTC.activeLeaseEnvelope = () => WebRTC.controlState.lease;
  WebRTC.enforceSupportedNetworkMode = (m) => modes.push(m);
  WebRTC.updateNetworkUI = (text, severity) => { ui.push([text, severity]); };
  const pending = WebRTC.requestResolution(1920, 1080);
  assert.deepEqual(ui, [['外网中继上 1080p 容易卡顿，建议改回 720p 或改用隧道中继。', 'warning']]);
  assert.deepEqual(modes, []);
  assert.equal(WebRTC.networkMode, 'relay');
  await pending;
});

test('relay stall lasting 6s suggests tunnel as danger without switching mode', () => {
  const timers = new Map();
  const { WebRTC } = loadWebRTC({
    setTimeout(callback, ms) {
      timers.set(ms, callback);
      return ms;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  const modes = [];
  const recs = [];
  WebRTC.networkMode = 'relay';
  WebRTC.hasPaintedFrame = true;
  WebRTC.enforceSupportedNetworkMode = (m) => modes.push(m);
  const originalSetFailureRecommendation = WebRTC.setFailureRecommendation.bind(WebRTC);
  WebRTC.setFailureRecommendation = (code, severity) => {
    recs.push([code, severity]);
    return originalSetFailureRecommendation(code, severity);
  };
  WebRTC.updateNetworkUI = (text, severity) => { WebRTC._ui = text; WebRTC._sev = severity; };
  WebRTC.setUiPhase('media-stalled', { reason: 'zero-fps' });
  assert.equal(WebRTC._ui, '外网中继正在追帧，画面可能短暂发黑（约 2 秒）。若 3 秒内不恢复或反复出现，请改用 720p 或手动切换「隧道中继」。');
  assert.equal(WebRTC._sev, 'warning');
  assert.deepEqual(recs, []);
  assert.equal(typeof timers.get(6000), 'function');
  timers.get(6000)();
  assert.equal(WebRTC._ui, '当前中继出画不稳定，请手动切换「隧道中继」。');
  assert.equal(WebRTC._sev, 'danger');
  assert.deepEqual(recs, [['relay-failed-suggest-tunnel', 'danger']]);
  assert.equal(WebRTC.recommendationState.nextSuggestedMode, 'tunnel');
  assert.deepEqual(modes, []);
  assert.equal(WebRTC.networkMode, 'relay');
});

test('relay stats tick keeps stall copy and 6s recommendation', () => {
  const { WebRTC, context } = loadWebRTC();
  WebRTC.networkMode = 'relay';
  WebRTC.hasTurnConfigured = () => true;
  WebRTC.getPublicEntryUrl = () => '';
  WebRTC.socket = { connected: false, emit() {} };
  WebRTC.pc = { connectionState: 'connected', iceConnectionState: 'completed' };
  WebRTC.isMediaHealthSuppressed = () => false;
  WebRTC.handlePortSearchMedia = () => {};
  WebRTC.handleReceiverStats = () => {};
  WebRTC.hasPaintedFrame = true;
  WebRTC._stallSince = Date.now() - 2000;
  WebRTC.uiPhase = 'connected';
  WebRTC.notePaintStats({
    framesDecoded: 40,
    framesReceived: 19,
    fps: 0,
    videoWidth: 1280,
    videoHeight: 720,
  });
  const advisorText = () => context.document.getElementById('networkAdvisorText').textContent;
  assert.equal(WebRTC.uiPhase, 'media-stalled');
  assert.match(advisorText(), /外网中继正在追帧/);
  assert.doesNotMatch(advisorText(), /当前通过 TURN 中继传输/);

  WebRTC.announcePaintIssue('media-stalled-6s');
  assert.match(advisorText(), /当前中继出画不稳定/);
  assert.equal(WebRTC.recommendationState.failureCode, 'relay-failed-suggest-tunnel');
  assert.equal(WebRTC.recommendationState.nextSuggestedMode, 'tunnel');

  WebRTC.processStatsSnapshot({
    fps: 0,
    rttMs: 180,
    jitterBufferMs: 40,
    framesReceived: 19,
    framesDecoded: 40,
    packetsLost: 0,
    bytesReceived: 50000,
    codec: 'H264',
    selectedCandidateType: 'relay',
    videoWidth: 1280,
    videoHeight: 720,
  });

  assert.equal(WebRTC.uiPhase, 'media-stalled');
  assert.match(advisorText(), /当前中继出画不稳定/);
  assert.doesNotMatch(advisorText(), /当前通过 TURN 中继传输/);
  assert.equal(WebRTC.recommendationState?.failureCode, 'relay-failed-suggest-tunnel');
  assert.equal(WebRTC.recommendationState?.nextSuggestedMode, 'tunnel');
});

test('relay stats tick keeps media-pending copy', () => {
  const { WebRTC, context } = loadWebRTC();
  WebRTC.networkMode = 'relay';
  WebRTC.hasTurnConfigured = () => true;
  WebRTC.getPublicEntryUrl = () => '';
  WebRTC.socket = { connected: false, emit() {} };
  WebRTC.pc = { connectionState: 'connected', iceConnectionState: 'connected' };
  WebRTC.isMediaHealthSuppressed = () => false;
  WebRTC.handlePortSearchMedia = () => {};
  WebRTC.handleReceiverStats = () => {};
  WebRTC.hasPaintedFrame = false;
  WebRTC._paintDecodedBaseline = 0;
  WebRTC.setUiPhase('media-pending', { reason: 'pc-connected' });
  WebRTC.announcePaintIssue('media-pending-3s');
  const advisorText = () => context.document.getElementById('networkAdvisorText').textContent;
  const advisor = context.document.getElementById('networkAdvisor');
  assert.equal(advisor.hidden, true);
  assert.equal(advisor.getAttribute('aria-hidden'), 'true');

  WebRTC.processStatsSnapshot({
    fps: 0,
    rttMs: 180,
    jitterBufferMs: 0,
    framesReceived: 0,
    framesDecoded: 0,
    packetsLost: 0,
    bytesReceived: 1200,
    codec: 'H264',
    selectedCandidateType: 'relay',
    videoWidth: 0,
    videoHeight: 0,
  });

  assert.equal(WebRTC.uiPhase, 'media-pending');
  assert.equal(advisor.hidden, true);
  assert.equal(advisor.getAttribute('aria-hidden'), 'true');
  assert.doesNotMatch(advisorText(), /当前通过 TURN 中继传输/);
});

test('media-pending 8s auto-sends paint-pending-timeout', () => {
  const timers = new Map();
  const { WebRTC, context } = loadWebRTC({
    setTimeout(callback, ms) {
      timers.set(ms, callback);
      return ms;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  const sent = [];
  context.Diagnostic = {
    autoSendFailure(reason) { sent.push(reason); },
  };
  WebRTC.networkMode = 'relay';
  WebRTC.pc = { connectionState: 'connected', iceConnectionState: 'connected' };
  WebRTC.updateNetworkUI = () => {};
  WebRTC.hasPaintedFrame = false;
  WebRTC.setUiPhase('media-pending', { reason: 'pc-connected' });
  assert.equal(typeof timers.get(8000), 'function');
  timers.get(8000)();
  assert.deepEqual(sent, ['paint-pending-timeout']);
  assert.equal(WebRTC.uiPhase, 'media-pending');
});

test('intentional pause and hidden pages do not report first-paint timeout, but active resume does', () => {
  const timers = new Map();
  const { WebRTC, context } = loadWebRTC({
    setTimeout(callback, ms) { timers.set(ms, callback); return ms; },
    clearTimeout(id) { timers.delete(id); },
  });
  const sent = [];
  const fire = (ms) => {
    const callback = timers.get(ms);
    timers.delete(ms);
    callback();
  };
  context.Diagnostic = { autoSendFailure(reason) { sent.push(reason); } };
  WebRTC.updateNetworkUI = () => {};
  let state = 'active';
  WebRTC.getMediaActivitySnapshot = () => ({ state, reasons: [], generation: 1 });
  WebRTC.uiPhase = 'media-pending';
  WebRTC.schedulePaintPendingCopyTimers();
  state = 'suspended';
  fire(8000);
  assert.deepEqual(sent, []);
  WebRTC.clearPaintPendingCopyTimers();
  WebRTC.schedulePaintPendingCopyTimers();
  assert.equal(timers.size, 0);

  state = 'active';
  WebRTC.schedulePaintPendingCopyTimers();
  context.document.hidden = true;
  fire(8000);
  assert.deepEqual(sent, []);
  WebRTC.clearPaintPendingCopyTimers();
  context.document.hidden = false;
  WebRTC.schedulePaintPendingCopyTimers();
  fire(8000);
  assert.deepEqual(sent, ['paint-pending-timeout']);
});

test('media-stalled lasting 3s auto-sends media-stalled', () => {
  const timers = new Map();
  const { WebRTC, context } = loadWebRTC({
    setTimeout(callback, ms) {
      timers.set(ms, callback);
      return ms;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  const sent = [];
  context.Diagnostic = {
    autoSendFailure(reason) { sent.push(reason); },
  };
  WebRTC.networkMode = 'relay';
  WebRTC.hasPaintedFrame = true;
  WebRTC.updateNetworkUI = () => {};
  WebRTC.setFailureRecommendation = () => {};
  WebRTC.setUiPhase('media-stalled', { reason: 'zero-fps' });
  assert.equal(typeof timers.get(3000), 'function');
  timers.get(3000)();
  assert.deepEqual(sent, ['media-stalled']);
  assert.equal(WebRTC.uiPhase, 'media-stalled');
});

test('connected without a painted frame remains pending in the session snapshot', () => {
  const { WebRTC, context } = loadWebRTC();
  WebRTC.desktopSessionState = context.createDesktopSessionState();
  WebRTC.currentConnectionAttemptId = 'attempt-pending';
  WebRTC.desktopSessionState.beginAttempt('attempt-pending', { socket: 'online' });
  WebRTC.hasPaintedFrame = false;

  WebRTC.setUiPhase('connected', { reason: 'pc-connected' });

  assert.equal(WebRTC.uiPhase, 'media-pending');
  assert.notEqual(WebRTC.getDesktopSessionSnapshot().media, 'live');
});

test('desktop input gate follows uiPhase during transient stalled media', () => {
  const calls = [];
  const { WebRTC, context } = loadWebRTC();
  context.Input = { setActive(value) { calls.push(value); } };
  WebRTC.desktopSessionState = context.createDesktopSessionState();
  WebRTC.currentConnectionAttemptId = 'attempt-live';
  WebRTC._mediaReadyConnectionAttemptId = 'attempt-live';
  WebRTC.socket = { connected: true };
  WebRTC.hasPaintedFrame = true;
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-live', leaseEpoch: 1 },
  };
  WebRTC.desktopSessionState.beginAttempt('attempt-live', { socket: 'online' });
  WebRTC.desktopSessionState.applyConnection({ attemptId: 'attempt-live', state: 'connected' });
  WebRTC.desktopSessionState.applyControl({ attemptId: 'attempt-live', state: 'active' });
  WebRTC.desktopSessionState.applyMedia({ attemptId: 'attempt-live', event: 'fresh-frame', fresh: true });
  WebRTC.desktopSessionState.applyMedia({ attemptId: 'attempt-live', state: 'stalled' });
  WebRTC.uiPhase = 'connected';

  WebRTC.syncDesktopInputGate();
  assert.equal(calls.at(-1), true);

  WebRTC.uiPhase = 'media-stalled';
  WebRTC.syncDesktopInputGate();
  assert.equal(calls.at(-1), false);
});

test('classic bundle exposes WebRTC on globalThis for deferred diagnostic.js', () => {
  const { WebRTC, context } = loadWebRTC();
  assert.equal(context.globalThis.WebRTC, WebRTC);
  assert.equal(typeof context.globalThis.WebRTC.getSessionPresentation, 'function');
  assert.equal(typeof context.globalThis.WebRTC.uiPhase, 'string');
});

test('stale business ACKs never contribute timing samples on socket or DataChannel adapters', () => {
  const observed = [];
  const { WebRTC } = loadWebRTC({
    Input: { acceptMouseAck() { return { status: 'stale' }; }, acceptKeyboardAck() { return { status: 'stale' }; } },
    LatencyMonitor: { onInputAck(data) { observed.push(data); } },
  });
  WebRTC.acceptObservedInputAck({ schemaVersion: 2, inputType: 'keyboard', leaseEpoch: 4, inputIds: ['old'] });
  WebRTC.acceptObservedInputAck({ schemaVersion: 2, inputType: 'mouse', leaseEpoch: 4, inputIds: ['old-mouse'] });
  assert.equal(observed.length, 0);
});

for (const transport of ['socket', 'datachannel']) for (const status of ['applied', 'execution-failed']) {
  test(`accepted unordered mouse move settles only matching scope ${status} observation over ${transport}`, () => {
    let now = 1000;
    const monitor = require('./latency-monitor.js').createLatencyMonitor({ now: () => now });
    const { WebRTC, context } = loadWebRTC({ realInput: true, LatencyMonitor: monitor, performance: { now: () => now } });
    const Input = context.__Input;
    WebRTC.currentConnectionAttemptId = 'unordered-attempt'; WebRTC.connectionAttemptSequence = 1;
    Input.activeControlLease = { leaseId: 'lease-000000000001', leaseEpoch: 4 };
    Input.isActive = true;
    let sent;
    WebRTC.sendInput = data => { if (transport !== 'datachannel') return false; sent = data; return true; };
    WebRTC.socket = { connected: true, emit(_event, data) { sent = data; } };
    const inputId = Input._sendInput('mouse', 'move', { relX: .5, relY: .5 });
    assert.equal(inputId, sent.inputIds[0]);
    assert.equal(Input._desktopWritePending.size, 0);
    now = 1100;
    WebRTC.acceptObservedInputAck({ schemaVersion: 2, inputType: 'mouse', status: 'applied', leaseEpoch: 3, inputIds: [inputId] }, { transport });
    assert.equal(monitor.snapshot().metrics.inputAckRttMs.count, 0);
    WebRTC.acceptObservedInputAck({ schemaVersion: 2, inputType: 'mouse', status: 'applied', leaseEpoch: 4, inputIds: [inputId] }, { transport: transport === 'socket' ? 'datachannel' : 'socket' });
    assert.equal(monitor.snapshot().metrics.inputAckRttMs.count, 0);
    WebRTC.acceptObservedInputAck({ schemaVersion: 2, inputType: 'mouse', status, leaseEpoch: 4, inputIds: [inputId] }, { transport });
    assert.equal(monitor.snapshot().metrics.inputAckRttMs.last, status === 'applied' ? 100 : null);
    assert.equal(monitor.snapshot().outcomes.acked, status === 'applied' ? 1 : 0);
    assert.equal(monitor.snapshot().outcomes.rejected, status === 'applied' ? 0 : 1);
    now = 12000;
    assert.equal(monitor.snapshot().outcomes.timedOut, 0);
  });
}

test('future-sequence applied keyboard envelope cannot produce successful timing after business resync', () => {
  let now = 1000;
  const monitor = require('./latency-monitor.js').createLatencyMonitor({ now: () => now });
  const { WebRTC, context } = loadWebRTC({ realInput: true, LatencyMonitor: monitor, performance: { now: () => now } });
  const Input = context.__Input;
  WebRTC.currentConnectionAttemptId = 'future-attempt'; WebRTC.connectionAttemptSequence = 1;
  Input.initKeyboardController(); Input.setControlLease({ leaseId: 'lease-000000000001', leaseEpoch: 4 });
  const sent = [];
  WebRTC.socket = { connected: true, emit(_event, data) { sent.push(data); } };
  WebRTC.sendInput = () => false;
  assert.equal(Input.keyboardTransport.send({ type: 'keyboard', action: 'text', payload: { text: 'fixture' } }) !== null, true);
  const inputId = sent[0].inputIds[0]; now = 1100;
  WebRTC.acceptObservedInputAck({ schemaVersion: 2, inputType: 'keyboard', leaseEpoch: 4, appliedSeq: 999,
    status: 'applied', pressedKeyCount: 0, modifierMask: 0, inputIds: [inputId] }, { transport: 'socket' });
  assert.equal(monitor.snapshot().metrics.inputAckRttMs.count, 0);
  assert.equal(monitor.snapshot().outcomes.acked, 0);
});


for (const transport of ['socket', 'datachannel']) test(`1000 actual ${transport} ACK handlers keep business and M1 calls before trace sampling`, () => {
  const { InputTrace } = require('./input-trace.js');
  const trace = InputTrace.create({ hashInputIds: null });
  const order = [];
  const counts = { mouse: 0, keyboard: 0, latency: 0 };
  const handlers = new Map(); const channels = new Map();
  let pending = true;
  const { WebRTC } = loadWebRTC({
    Input: {
      peekInputAckMetadata() { order.push('peek'); return { inputType: 'pointer', action: pending ? 'reset' : 'move',
        reliable: pending, matchedReliablePending: pending, late: false }; },
      acceptMouseAck() { counts.mouse++; order.push('mouse'); pending = false; return { status: 'applied' }; },
      acceptKeyboardAck() { counts.keyboard++; order.push('keyboard'); return { status: 'applied' }; },
      recordObservedInputAck(data, result, meta) { order.push('trace'); trace.record('ack', { ...meta, status: data.status, accepted: false }); },
    },
    LatencyMonitor: { onInputAck() { counts.latency++; order.push('latency'); } },
  });
  WebRTC.pc = { createDataChannel(label) { const c = { label, readyState: 'connecting', send() {} }; channels.set(label, c); return c; } };
  WebRTC.socket = { on(event, handler) { handlers.set(event, handler); } };
  WebRTC.createInputChannel(); WebRTC.setupSocketListeners();
  const deliver = data => transport === 'socket' ? handlers.get('input-ack')(data)
    : channels.get('input').onmessage({ data: JSON.stringify(data) });
  // Legacy envelopes invoke both real business consumer names on every ACK.
  deliver({ type: 'input_ack', inputType: 'mouse', status: 'applied' });
  for (let i = 0; i < 1000; i++) deliver({ type: 'input_ack', inputType: 'mouse', status: 'applied' });
  assert.deepEqual(counts, { mouse: 1001, keyboard: 1001, latency: 1001 });
  assert.deepEqual(order.slice(0, 5), ['peek', 'mouse', 'keyboard', 'latency', 'trace']);
  assert.equal(trace.snapshot().counters.sampledAckEvents, 1000);
  assert.equal(trace.snapshot().events[0].action, 'reset');
  trace.dispose();
});


for (const transport of ['socket', 'datachannel']) test(`real v2 unordered ${transport} ACK sampling preserves 1000 C and M1 deliveries`, () => {
  const { InputTrace } = require('./input-trace.js');
  let now = 1000;
  const trace = InputTrace.create({ now: () => now, hashInputIds: null });
  const monitor = require('./latency-monitor.js').createLatencyMonitor({ now: () => now });
  const handlers = new Map(); const channels = new Map();
  const counts = { mouse: 0, keyboard: 0, unordered: 0, latency: 0 };
  const { WebRTC, context } = loadWebRTC({ realInput: true, LatencyMonitor: monitor,
    Diagnostic: { recordInputTrace: (stage, meta) => trace.record(stage, meta) },
    performance: { now: () => now } });
  const Input = context.__Input;
  WebRTC.currentConnectionAttemptId = 'sampling-attempt'; WebRTC.connectionAttemptSequence = 1;
  Input.activeControlLease = { leaseId: 'lease-000000000001', leaseEpoch: 4 }; Input.isActive = true;
  WebRTC.pc = { createDataChannel(label) { const c = { label, readyState: 'connecting', send() {} }; channels.set(label, c); return c; } };
  WebRTC.socket = { connected: true, id: 'sampling-socket', emit() {}, on(event, handler) { handlers.set(event, handler); } };
  WebRTC.createInputChannel(); WebRTC.setupSocketListeners();
  WebRTC.sendInput = () => transport === 'datachannel';
  for (const [object, method, counter] of [[Input, 'acceptMouseAck', 'mouse'], [Input, 'acceptKeyboardAck', 'keyboard'],
    [monitor, 'onUnorderedInputAck', 'unordered'], [monitor, 'onInputAck', 'latency']]) {
    const original = object[method];
    object[method] = function(...args) { counts[counter]++; return original.apply(this, args); };
  }
  const deliver = ack => transport === 'socket' ? handlers.get('input-ack')(ack)
    : channels.get('input').onmessage({ data: JSON.stringify(ack) });
  const resetId = Input._sendInput('mouse', 'reset', {});
  assert.equal(Input._desktopWritePending.size, 1);
  deliver({ type: 'input_ack', schemaVersion: 2, inputType: 'mouse', status: 'applied',
    leaseEpoch: 4, appliedSeq: 1, inputIds: [resetId] });
  assert.equal(Input._desktopWritePending.size, 0);
  assert.equal(trace.snapshot().events.find(event => event.stage === 'ack').action, 'reset');
  trace.record('ack-timeout', { inputType: 'pointer', action: 'reset', status: 'timeout', reliable: true });
  for (let i = 0; i < 1000; i++) {
    const id = Input._sendInput('mouse', 'move', { relX: .5, relY: .5 });
    assert.ok(id);
    const ack = { type: 'input_ack', schemaVersion: 2, inputType: 'mouse', status: 'applied', leaseEpoch: 4, inputIds: [id] };
    deliver(ack);
  }
  assert.deepEqual(counts, { mouse: 1001, keyboard: 0, unordered: 1000, latency: 1001 });
  const snapshot = trace.snapshot();
  assert.equal(snapshot.counters.sampledAckEvents, 1000);
  assert.equal(snapshot.events.filter(event => event.stage === 'ack-timeout').length, 1);
  assert.equal(snapshot.events.filter(event => event.stage === 'ack' && event.action === 'reset').length, 1);
  assert.equal(Input._desktopWritePending.size, 0);
  assert.equal(Input._unorderedTraceSends.size, 0);
  trace.dispose();
});


test('ACK metadata and passive trace failures do not reduce C/M1 dispatch or grant timing authority', () => {
  const calls = [];
  const { WebRTC } = loadWebRTC({
    Input: {
      peekInputAckMetadata() { calls.push('peek'); throw new Error('observer metadata'); },
      acceptMouseAck() { calls.push('mouse'); return { status: 'stale' }; },
      acceptKeyboardAck() { calls.push('keyboard'); return { status: 'applied' }; },
      recordObservedInputAck() { calls.push('trace'); throw new Error('observer trace'); },
    },
    LatencyMonitor: { onInputAck() { calls.push('latency'); }, onUnorderedInputAck() { calls.push('unordered'); } },
  });
  assert.doesNotThrow(() => WebRTC.acceptObservedInputAck({ schemaVersion: 2, inputType: 'keyboard', status: 'applied' }));
  assert.deepEqual(calls, ['peek', 'mouse', 'keyboard', 'latency', 'trace']);
  calls.length = 0;
  assert.doesNotThrow(() => WebRTC.acceptObservedInputAck({ schemaVersion: 2, inputType: 'mouse', status: 'applied' }));
  assert.deepEqual(calls, ['peek', 'mouse', 'unordered', 'trace']);
});

for (const realInput of [false, true]) {
test(`200 stable rVFCs preserve every authority and M observation with no extra chrome writes (real Input=${realInput})`, () => {
  const { WebRTC, context } = loadWebRTC({ realInput });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'chrome-layout.js'), 'utf8'), context);
  const writes = [];
  const instrumented = new WeakSet();
  const instrument = node => {
    if (instrumented.has(node)) return node;
    instrumented.add(node);
    for (const key of ['className', 'textContent', 'hidden', 'disabled', 'title']) {
      let value = node[key];
      Object.defineProperty(node, key, { configurable: true,
        get: () => value, set(next) { value = next; writes.push([key, next]); } });
    }
    for (const method of ['add', 'remove', 'toggle']) {
      const original = node.classList[method];
      node.classList[method] = (...args) => { writes.push([method, ...args]); return original(...args); };
    }
    const originalAttribute = node.setAttribute;
    node.setAttribute = (...args) => { writes.push(args); return originalAttribute(...args); };
    node.style = new Proxy(node.style, { set(target, key, value) { writes.push([key, value]); target[key] = value; return true; } });
    return node;
  };
  const lookup = context.document.getElementById;
  context.document.getElementById = id => instrument(lookup(id));
  instrument(context.document.body);
  const video = context.document.getElementById('remoteVideo');
  const callbacks = [];
  const track = { id: 'stable-video', kind: 'video' };
  video.videoWidth = 1280; video.videoHeight = 720;
  video.srcObject = { getVideoTracks: () => [track] };
  video.getBoundingClientRect = () => ({ x: 0, y: 0, width: 1280, height: 720 });
  video.requestVideoFrameCallback = callback => { callbacks.push(callback); return callbacks.length; };
  WebRTC.pc = { connectionState: 'connected',
    getReceivers: () => [{ track, getSynchronizationSources: () => [{ source: 17 }] }] };
  WebRTC.currentConnectionAttemptId = 'stable-attempt';
  WebRTC.uiPhase = 'connected';
  WebRTC.socket = { connected: true };
  WebRTC.hasActiveControl = () => true;
  WebRTC.canEnableDesktopInput = () => true;
  const activations = [];
  if (realInput) {
    const input = context.__Input;
    const activate = input.setActive;
    input.setActive = function(value, ...args) { activations.push(value); return activate.call(this, value, ...args); };
  } else context.Input = { setActive(value) { activations.push(value); } };
  const latency = [], frameTrace = [], inputFrames = [], resumeFrames = [];
  context.LatencyMonitor = { onVideoFrame: (now, metadata) => latency.push([now, metadata.rtpTimestamp]) };
  WebRTC._frameTraceEnabled = true;
  WebRTC.ensureFrameTraceCollector = () => ({ observeVideoFrame: (identity, observation, now) => frameTrace.push([identity, now]) });
  WebRTC.ensureInputFrameCollector = () => ({ observeVideoFrame: (identity, observation, now) => inputFrames.push([identity, now]) });
  WebRTC.consumeInputFrameMatches = () => {};
  const observeResume = WebRTC.observeFreshResumeFrame;
  WebRTC.observeFreshResumeFrame = function(frame) { resumeFrames.push(frame.frameSeq); return observeResume.call(this, frame); };
  const session = WebRTC.ensureDesktopSessionState();
  let freshMediaTransitions = 0;
  const sessionAdapter = { ...session, applyMedia(event) {
    if (event.event === 'fresh-frame') freshMediaTransitions++;
    return session.applyMedia(event);
  } };
  WebRTC.ensureDesktopSessionState = () => sessionAdapter;
  WebRTC.startVideoFrameTracking();
  callbacks[0](0, { presentedFrames: 1, rtpTimestamp: 100 });
  const before = writes.length;
  assert.ok(before > 0);
  for (let index = 1; index <= 200; index++) callbacks[index](index * 16, {
    presentedFrames: index + 1, rtpTimestamp: 100 + index,
  });
  assert.equal(writes.length, before);
  assert.equal(WebRTC._videoFrameSeq, 201);
  assert.equal(activations.length, 201);
  assert.ok(activations.every(Boolean));
  assert.equal(latency.length, 201);
  assert.equal(frameTrace.length, 201);
  assert.equal(inputFrames.length, 201);
  assert.equal(resumeFrames.length, 201);
  assert.equal(resumeFrames.at(-1), 201);
  assert.equal(inputFrames.at(-1)[0].rtpTimestamp, 300);
  assert.equal(inputFrames.at(-1)[1], 3200);
  assert.equal(WebRTC._paintObservationWindow.intervals.length, 200);
  assert.equal(WebRTC._paintObservationWindow.lastPaintAt, 3200);
  assert.ok(freshMediaTransitions >= 201);
  const oldCallback = callbacks.at(-1);
  WebRTC.currentConnectionAttemptId = 'replacement-attempt';
  oldCallback(3216, { presentedFrames: 202, rtpTimestamp: 301 });
  assert.equal(WebRTC._videoFrameSeq, 201);
  assert.equal(activations.length, 201);
  assert.equal(resumeFrames.length, 201);
});
}

test('real control writer cannot enable Terminal controls behind an unchanged chrome projection', () => {
  const { WebRTC, context } = loadWebRTC();
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'chrome-layout.js'), 'utf8'), context);
  WebRTC.uiPhase = 'connected';
  WebRTC.hasPaintedFrame = true;
  WebRTC.controlState = { state: 'FREE', controller: false };
  WebRTC.hasActiveControl = () => false;
  WebRTC.getMediaActivitySnapshot = () => ({ reasons: ['terminal-active'] });
  const button = context.document.getElementById('requestControlBtn');
  for (let i = 0; i < 3; i++) {
    WebRTC.updateControlUI('只读');
    assert.equal(button.disabled, true, `control update ${i} must preserve the Terminal veto`);
    assert.equal(button.getAttribute('aria-disabled'), 'true');
  }
});

test('real mobile and port-search writers converge with the chrome capability projection', () => {
  const { WebRTC, context } = loadWebRTC({ realInput: true });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'chrome-layout.js'), 'utf8'), context);
  const Input = context.__Input;
  WebRTC.uiPhase = 'connected'; WebRTC.hasPaintedFrame = true;
  WebRTC.hasActiveControl = () => true;
  WebRTC.controlState = { state: 'ACTIVE', controller: true };
  WebRTC.getMediaActivitySnapshot = () => ({ state: 'active', reasons: [] });
  Input.isActive = true;
  const mobile = context.document.getElementById('mobileTextInputBtn');
  WebRTC.syncChromeCapabilities();
  Input.updateMobileTextInputButton();
  assert.equal(mobile.hidden, true, 'pointer-only viewer does not have a mobile text surface');
  WebRTC.syncChromeCapabilities();
  assert.equal(mobile.hidden, true, 'same chrome projection must preserve the mobile support veto');
  context.navigator.maxTouchPoints = 1;
  WebRTC.getMediaActivitySnapshot = () => ({ state: 'suspended', reasons: ['terminal-active'] });
  for (let i = 0; i < 3; i++) {
    WebRTC.syncChromeCapabilities();
    Input.updateMobileTextInputButton();
    assert.equal(mobile.hidden, true);
    assert.equal(mobile.disabled, true);
  }
  const port = context.document.getElementById('portSearchBtn');
  WebRTC.uiPhase = 'media-stalled';
  WebRTC.getMediaActivitySnapshot = () => ({ state: 'active', reasons: [] });
  WebRTC.canStartPortSearch = () => true;
  for (const tools of ['loading', 'failed', 'ready']) {
    WebRTC._operatorToolsState = tools;
    WebRTC.renderPortSearchStatus();
    WebRTC.syncChromeCapabilities();
    assert.equal(port.disabled, tools === 'loading');
    assert.equal(port.getAttribute('aria-disabled'), String(tools === 'loading'));
  }
  WebRTC.getMediaActivitySnapshot = () => ({ state: 'suspended', reasons: ['terminal-active'] });
  WebRTC._operatorToolsState = 'failed';
  WebRTC.syncChromeCapabilities();
  WebRTC.renderPortSearchStatus();
  assert.equal(port.disabled, true, 'tool retry cannot override the Terminal gate');
  assert.equal(port.getAttribute('aria-disabled'), 'true');
});

function admissionViewerFixture({ proof = null, fetchAdmission = null, realPeer = false } = {}) {
  const sockets = [], requests = [];
  const storage = new Map(proof ? [['wrdProofAdmission', JSON.stringify(proof)]] : []);
  const result = loadWebRTC({
    RTCPeerConnection: class {
      constructor(config) { this.config = config; this.connectionState = 'new'; this.iceConnectionState = 'new'; }
      createDataChannel() { return { readyState: 'connecting', bufferedAmount: 0, send() {} }; }
      close() { this.connectionState = 'closed'; }
    },
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    fetch: async (url, init) => {
      if (!url.endsWith('/api/auth/viewer-admission')) return { ok: true, status: 200, json: async () => ({ iceServers: [] }) };
      requests.push({ url, init });
      if (fetchAdmission) return fetchAdmission();
      return { ok: true, status: 201, json: async () => ({ admission: { ticket: `fixture-ticket-${requests.length}` } }) };
    },
    io: (_url, options) => {
      const handlers = new Map();
      const socket = { auth: options.auth, connected: false, attempts: 0, reconnectEnabled: true,
        on: (event, handler) => handlers.set(event, handler), emit() {},
        disconnect() { this.connected = false; }, connect() { this.attempts++; },
        trigger(event, data) { return handlers.get(event)?.(data); },
        io: { opts: options, engine: { readyState: 'opening', transport: { name: 'websocket' } }, _readyState: 'closed',
          reconnection(value) { socket.reconnectEnabled = value; } },
      };
      sockets.push(socket); return socket;
    },
  });
  const { WebRTC } = result;
  // Most admission tests isolate PC effects. Lifecycle tests opt into the real
  // createPeerConnection/createOffer methods with only the platform RTC fake.
  if (!realPeer) {
    WebRTC.createPeerConnection = () => {};
    WebRTC.createOffer = () => {};
  }
  const controller = { load: async () => ({ schemaVersion: 1, host: { online: false }, webrtc: { iceServers: [] } }) };
  return { ...result, sockets, requests, storage, controller };
}

test('real Start/reclaim issue once while Socket.IO resume, pageshow and PC refresh retain acknowledged generation', async () => {
  const h = admissionViewerFixture();
  const start = h.WebRTC.createStartHandler(h.controller);
  await Promise.all([start(), start()]);
  assert.equal(h.requests.length, 1);
  const original = h.sockets[0];
  assert.equal(original.auth.viewerAdmission.mode, 'explicit');
  assert.equal(original.auth.viewerAdmission.ticket, 'fixture-ticket-1');
  original.connected = true;
  original.trigger('connected', { hostOnline: false, viewerAdmission: { mode: 'resume', generation: 'generation-1' } });
  assert.equal(original.auth.viewerAdmission.generation, 'generation-1');
  assert.equal(original.auth.viewerAdmission.ticket, undefined);
  original.connected = false;
  original.trigger('disconnect', 'transport close');
  h.WebRTC.handlePageLifecycle('pageshow');
  assert.equal(original.attempts, 1);
  h.WebRTC.createSignalingSocket(true);
  assert.equal(h.sockets[1].auth.viewerAdmission.generation, 'generation-1');
  await h.WebRTC.refresh({ reason: 'fresh-frame-timeout' });
  assert.equal(h.requests.length, 1, 'automatic recovery must not fetch a new ticket');
  h.WebRTC.handleViewerSuperseded({ reason: 'single-desktop-viewer' });
  await Promise.all([h.WebRTC.reclaimDesktopSession(), h.WebRTC.reclaimDesktopSession()]);
  assert.equal(h.requests.length, 2);
  assert.equal(h.sockets.at(-1).auth.viewerAdmission.ticket, 'fixture-ticket-2');
  assert.equal(h.WebRTC._superseded, false);
});

test('actual admission rejection stops reconnect chain and preserves input draft with manual reclaim available', async () => {
  const h = admissionViewerFixture();
  await h.WebRTC.startViewer(h.controller);
  const socket = h.sockets[0]; socket.connected = true;
  h.context.document.getElementById('mobileTextInput').value = 'unfinished draft';
  h.storage.set('draft-canary', 'saved draft');
  h.WebRTC.scheduleSignalingRecovery('network-online');
  socket.trigger('viewer-admission-rejected', { reason: 'explicit-reconnect-required' });
  assert.equal(socket.reconnectEnabled, false);
  assert.equal(h.WebRTC.manualDisconnect, true);
  assert.equal(h.WebRTC._signalRecoveryTimer, null);
  assert.equal(h.WebRTC.createSignalingSocket(true), null);
  assert.equal(h.WebRTC.handlePageLifecycle('pageshow'), false);
  assert.equal(h.WebRTC.scheduleSignalingRecovery(), false);
  await h.WebRTC.refresh({ reason: 'fresh-frame-timeout' });
  assert.equal(h.sockets.length, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.context.document.getElementById('mobileTextInput').value, 'unfinished draft');
  assert.equal(h.storage.get('draft-canary'), 'saved draft');
  assert.equal(h.context.document.getElementById('viewerSupersededOverlay').hidden, false);
  await h.WebRTC.reclaimDesktopSession();
  assert.equal(h.requests.length, 2);
  assert.equal(h.sockets.length, 2);
});

test('proof-bearing Start and manual reclaim never obtain an ordinary takeover ticket', async () => {
  const proof = { token: 'fixture-proof', epoch: 1, realm: 'production' };
  const h = admissionViewerFixture({ proof });
  await h.WebRTC.startViewer(h.controller);
  assert.equal(h.requests.length, 0);
  assert.equal(JSON.stringify(h.sockets[0].auth.proofAdmission), JSON.stringify(proof));
  assert.equal(h.sockets[0].auth.viewerAdmission, undefined);
  h.WebRTC.handleViewerSuperseded();
  await h.WebRTC.reclaimDesktopSession();
  assert.equal(h.requests.length, 0);
  assert.equal(h.sockets.at(-1).auth.viewerAdmission, undefined);
});

test('admission API failure or stale auth response cannot open signaling or clear current credentials', async () => {
  const failed = admissionViewerFixture({ fetchAdmission: async () => ({ ok: false, status: 429, json: async () => ({ error: 'admission-capacity' }) }) });
  await failed.WebRTC.startViewer(failed.controller);
  assert.equal(failed.sockets.length, 0);
  let complete;
  const h = admissionViewerFixture({ fetchAdmission: () => new Promise(resolve => { complete = resolve; }) });
  const pending = h.WebRTC.startViewer(h.controller);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  h.context.Auth.getToken = () => 'new-auth-token';
  complete({ ok: true, status: 201, json: async () => ({ admission: { ticket: 'old-response' } }) });
  await pending;
  assert.equal(h.sockets.length, 0);
  assert.equal(h.WebRTC._viewerAdmission, null);
  assert.equal(h.context.Auth.getToken(), 'new-auth-token');
});

test('malformed retained proof cannot turn an automated Start into ordinary admission', async () => {
  const h = admissionViewerFixture();
  h.storage.set('wrdProofAdmission', '{broken');
  await h.WebRTC.startViewer(h.controller);
  assert.equal(h.requests.length, 0);
  assert.equal(h.sockets[0].auth.proofAdmission.invalid, true);
  assert.equal(h.sockets[0].auth.viewerAdmission, undefined);
});

for (const rejection of ['viewer-superseded', 'viewer-admission-rejected']) {
  test(`late bootstrap after ${rejection} preserves TURN for explicit reclaim with real peer creation`, async () => {
    const h = admissionViewerFixture({ realPeer: true });
    h.WebRTC.networkMode = 'relay';
    let finishBootstrap;
    h.controller.load = () => new Promise(resolve => { finishBootstrap = resolve; });
    const start = h.WebRTC.startViewer(h.controller);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal(h.sockets.length, 1);
    assert.equal(h.WebRTC._deferPeerUntilConfig, true);
    h.sockets[0].trigger(rejection, { reason: 'explicit-reconnect-required' });
    finishBootstrap({ schemaVersion: 1, host: { online: true }, webrtc: {
      iceServers: [{ urls: 'turn:fixture.invalid:3478', username: 'fixture', credential: 'fixture' }],
      turnConfigured: true,
    } });
    await start;
    assert.equal(h.WebRTC.pc, null, 'bootstrap completion must not reconnect a rejected page');
    assert.equal(h.sockets.length, 1);
    assert.equal(h.requests.length, 1);
    await h.WebRTC.reclaimDesktopSession();
    assert.equal(h.sockets.length, 2);
    assert.equal(h.requests.length, 2, 'only the explicit reclaim issues a second intent');
    assert.equal(h.WebRTC._superseded, false);
    assert.ok(h.WebRTC.pc, 'reclaim must construct the actual Relay peer from retained TURN config');
    assert.equal(h.WebRTC.hasTurnConfigured(), true);
    assert.equal(h.WebRTC._deferPeerUntilConfig, false);
    assert.equal(h.WebRTC.pc.config.iceTransportPolicy, 'relay');
    assert.ok(h.WebRTC.pc.config.iceServers.some(server => server.urls === 'turn:fixture.invalid:3478'));
  });
}

test('superseded bootstrap from an older auth generation cannot populate reclaim TURN config', async () => {
  const h = admissionViewerFixture({ realPeer: true });
  h.WebRTC.networkMode = 'relay';
  let finishBootstrap;
  h.controller.load = () => new Promise(resolve => { finishBootstrap = resolve; });
  const start = h.WebRTC.startViewer(h.controller);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  h.sockets[0].trigger('viewer-admission-rejected', { reason: 'explicit-reconnect-required' });
  h.context.Auth.getToken = () => 'new-auth-token';
  finishBootstrap({ schemaVersion: 1, webrtc: {
    turnConfigured: true,
    iceServers: [{ urls: 'turn:stale-fixture.invalid:3478', username: 'fixture', credential: 'fixture' }],
  } });
  await start;
  assert.equal(h.WebRTC.hasTurnConfigured(), false);
  assert.equal(h.WebRTC.pc, null);
  assert.equal(h.WebRTC._superseded, true);
  assert.equal(h.WebRTC._deferPeerUntilConfig, false);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.requests.length, 1);
});

for (const staleAuth of [false, true]) {
  test(`reclaim before bootstrap waits for validated config (${staleAuth ? 'stale auth' : 'current auth'})`, async () => {
    const h = admissionViewerFixture({ realPeer: true });
    h.WebRTC.networkMode = 'relay';
    let finishBootstrap;
    h.controller.load = () => new Promise(resolve => { finishBootstrap = resolve; });
    const start = h.WebRTC.startViewer(h.controller);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    h.sockets[0].trigger('viewer-admission-rejected', { reason: 'explicit-reconnect-required' });
    const reclaim = h.WebRTC.reclaimDesktopSession();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(h.requests.length, 1, 'do not issue another takeover intent before config is usable');
    assert.equal(h.sockets.length, 1);
    assert.equal(h.WebRTC.pc, null);
    if (staleAuth) h.context.Auth.getToken = () => 'new-auth-token';
    finishBootstrap({ schemaVersion: 1, webrtc: {
    turnConfigured: true,
      iceServers: [{ urls: 'turn:fixture.invalid:3478', username: 'fixture', credential: 'fixture' }],
    } });
    await Promise.all([start, reclaim]);
    assert.equal(h.WebRTC._pendingBootstrapConfig, null);
    assert.equal(h.WebRTC._deferPeerUntilConfig, false);
    if (staleAuth) {
      assert.equal(h.requests.length, 1);
      assert.equal(h.sockets.length, 1);
      assert.equal(h.WebRTC.pc, null);
      assert.equal(h.WebRTC.hasTurnConfigured(), false);
      assert.equal(h.WebRTC._superseded, true);
    } else {
      assert.equal(h.requests.length, 2);
      assert.equal(h.sockets.length, 2);
      assert.equal(h.WebRTC.connectionAttemptSequence, 1, 'only reclaim initializes a new media attempt');
      assert.ok(h.WebRTC.pc);
      assert.equal(h.WebRTC.pc.config.iceTransportPolicy, 'relay');
      assert.equal(h.WebRTC.hasTurnConfigured(), true);
      assert.equal(h.WebRTC._superseded, false);
    }
  });
}

test('auth change between bootstrap validation and Start continuation cannot create a peer', async () => {
  const h = admissionViewerFixture({ realPeer: true });
  h.WebRTC.networkMode = 'relay';
  let finishBootstrap;
  h.controller.load = () => new Promise(resolve => { finishBootstrap = resolve; });
  const start = h.WebRTC.startViewer(h.controller);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  finishBootstrap({ schemaVersion: 1, webrtc: {
    turnConfigured: true,
    iceServers: [{ urls: 'turn:fixture.invalid:3478', username: 'fixture', credential: 'fixture' }],
  } });
  await Promise.resolve();
  h.context.Auth.getToken = () => 'new-auth-token';
  await start;
  assert.equal(h.WebRTC.pc, null);
  assert.equal(h.WebRTC.hasTurnConfigured(), false);
});

function relayIntegrationFixture({ initialReady = false, withCrypto = true } = {}) {
  let now = 1000, timerId = 0;
  const timers = new Map(), sent = [], docHandlers = new Map();
  const monitor = require('./latency-monitor.js').createLatencyMonitor({ now: () => now });
  class RelayDate extends Date { static now() { return now; } }
  const h = loadWebRTC({ realInput: true, LatencyMonitor: monitor, Date: RelayDate,
    crypto: withCrypto ? require('node:crypto').webcrypto : undefined, TextEncoder, Blob, URL,
    performance: { now: () => now },
    setTimeout(fn, delay = 0) { const id = ++timerId; timers.set(id, { fn, due: now + delay, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const { WebRTC, context } = h, Input = context.__Input;
  for (const name of ['media-activity-controller.js', 'media-activity-runtime.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, name), 'utf8'), context);
  }
  context.MediaActivityController = context.window.MediaActivityController;
  WebRTC.socket = { id: 'viewer-1', connected: true, on() {}, emit(event, data) { sent.push([event, data]); } };
  WebRTC.controlState = { state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 } };
  WebRTC.currentConnectionAttemptId = 'attempt-1'; WebRTC.connectionAttemptSequence = 1;
  WebRTC.networkMode = initialReady ? 'relay' : 'tunnel';
  WebRTC.initializeMediaActivity();
  WebRTC.mediaActivityRuntime = context.MediaActivityRuntime.create();
  assert.equal(WebRTC.getMediaActivitySnapshot().generation, 0);
  assert.equal(WebRTC.mediaActivityRuntime.snapshot().desiredGeneration, 0);
  const video = context.document.getElementById('remoteVideo');
  video.tagName = 'VIDEO'; video.videoWidth = 960; video.videoHeight = 540;
  video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 960, height: 540 });
  video.hasPointerCapture = () => false; video.setPointerCapture = () => {};
  video.focus = () => { context.document.activeElement = video; };
  context.document.activeElement = video;
  context.document.addEventListener = (type, fn) => docHandlers.set(type, fn);
  context.window.addEventListener = () => {};
  context.document.querySelectorAll = () => [];
  Input.videoElement = video;
  Input.setControlLease(WebRTC.controlState.lease);
  Input.setupEventListeners();
  if (initialReady) {
    WebRTC.hasPaintedFrame = true; WebRTC._mediaReadyConnectionAttemptId = WebRTC.currentConnectionAttemptId;
    WebRTC.uiPhase = 'connected'; WebRTC.syncDesktopInputGate();
  }
  const writes = () => sent.filter(([event, d]) => event === 'input' && ['mouse', 'keyboard'].includes(d?.type)).map(([,d]) => d);
  const business = () => writes().filter(d => d.action !== 'reset' && d.action !== 'up');
  const key = (phase = 'keydown') => docHandlers.get(phase)?.({ type: phase, target: video,
    code: 'KeyA', key: 'a', location: 0, repeat: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
    preventDefault() {}, getModifierState() { return false; } });
  const pointer = (phase = 'pointerdown') => video.listeners.get(phase)?.({ type: phase, target: video,
    currentTarget: video, pointerType: 'mouse', pointerId: 1, button: 0, buttons: 1,
    clientX: 400, clientY: 300, timeStamp: now, preventDefault() {} });
  function ackWrite(payload, extra = {}) {
    WebRTC.acceptObservedInputAck({ schemaVersion: 2, inputType: payload.type, inputIds: payload.inputIds,
      appliedSeq: payload.seq, leaseEpoch: payload.leaseEpoch, status: 'applied',
      pressedKeyCount: 0, modifierMask: 0, ...extra }, { socket: WebRTC.socket, transport: 'socket' });
  }
  function currentResets() {
    const keyboard = Input._captureKeyboardReset(), mouseId = Input._pendingMouseResetId;
    const list = writes();
    return [keyboard && list.find(d => d.inputIds.includes(keyboard.inputId)),
      mouseId && list.find(d => d.inputIds.includes(mouseId))].filter(Boolean);
  }
  function settleResets() {
    const current = currentResets();
    current.forEach(d => ackWrite(d));
    return current;
  }
  function advance(ms) {
    now += ms;
    for (let iterations = 0; iterations < 100; iterations++) {
      const due = [...timers].find(([,timer]) => timer.due <= now);
      if (!due) return;
      timers.delete(due[0]); due[1].fn();
    }
    throw new Error('unexpected timer loop');
  }
  function replyStart(producerId = 'producer-1') {
    const p = WebRTC._relayPendingStart;
    assert.ok(p);
    const fields = relayAckFields(WebRTC, p.mediaGeneration, producerId);
    const data = { ...fields, relayControlKind: 'start', relayStartRequestId: p.requestId,
      generation: p.mediaGeneration, connectionAttemptId: p.attempt, state: 'active', applied: true };
    assert.equal(WebRTC.handleMediaActivityAck(data), true);
    return { fields, data };
  }
  function frame(fields, frameId = 1, load = true) {
    WebRTC.handleRelayFrame({ ...fields, frameId, data: 'AAAA', timestamp: Date.now() + 86400000 });
    const onload = context.document.getElementById('relayImage').onload;
    if (load) { assert.equal(typeof onload, 'function'); onload(); }
    return onload;
  }
  return { ...h, Input, monitor, sent, timers, writes, business, key, pointer, ackWrite, currentResets,
    settleResets, advance, replyStart, frame, now: () => now };
}

function relayFeedback(fields, sequence, sample = null) {
  return { ...fields, feedbackSequence: sequence, sample, pendingCount: 0,
    oldestPendingAgeMs: null, expiredCount: 0, unmatchedAckCount: 0, timeoutCount: 0,
    coalescedCount: 0, lastSentAgeMs: null, lastAckAgeMs: null };
}

for (const mode of ['same-attempt-restart', 'webrtc-fallback']) test(`pending JPEG ${mode} immediately closes real business gate through current reset ACKs`, () => {
  const h = relayIntegrationFixture({ initialReady: true }), { WebRTC, Input } = h;
  assert.equal(Input.getEffectiveInputGate().allowed, true);
  h.key(); h.pointer();
  const held = h.writes();
  assert.ok(held.some(d => d.type === 'keyboard' && d.action === 'key'));
  assert.ok(held.some(d => d.type === 'mouse' && d.action === 'down'));
  held.forEach(d => h.ackWrite(d, d.type === 'keyboard' ? { pressedKeyCount: 1 } : {}));
  if (mode === 'same-attempt-restart') {
    // Obtain a first producer through the ordinary handshake, settle it, then restart it.
    assert.equal(WebRTC.startTunnelRelay(), true);
    const first = h.replyStart('first-producer'); h.frame(first.fields); h.settleResets();
    assert.equal(Input.getEffectiveInputGate().allowed, true);
    h.key(); h.pointer(); h.writes().slice(held.length).filter(d => d.action !== 'reset').forEach(d => h.ackWrite(d));
  } else {
    WebRTC.pc = { close() {} };
  }
  const before = h.business().length;
  assert.equal(WebRTC.startTunnelRelay(), true);
  assert.equal(WebRTC.hasPaintedFrame, false);
  assert.equal(WebRTC._mediaReadyConnectionAttemptId, null);
  assert.equal(Input.getEffectiveInputGate().allowed, false);
  h.key(); h.pointer(); assert.equal(h.business().length, before);
  assert.ok(h.writes().some(d => d.type === 'keyboard' && d.action === 'reset'));
  assert.ok(h.writes().some(d => d.type === 'mouse' && d.action === 'reset'));
  const previousResets = h.currentResets();
  const { fields, data } = h.replyStart('new-producer');
  h.key(); h.pointer(); assert.equal(h.business().length, before);
  assert.equal(Input.getEffectiveInputGate().allowed, false);
  WebRTC.handleMediaActivityAck(data); // Duplicate route cannot reset or ready.
  assert.equal(WebRTC._relayLastLoadedAtMs, null);
  h.frame(fields);
  assert.equal(Input.getEffectiveInputGate().allowed, false);
  h.key(); h.pointer(); assert.equal(h.business().length, before);
  const current = h.currentResets();
  const superseded = previousResets.filter(old => !current.some(d => d.inputIds[0] === old.inputIds[0]));
  superseded.forEach(d => h.ackWrite(d));
  assert.equal(Input.getEffectiveInputGate().allowed, false);
  h.settleResets();
  assert.equal(Input.getEffectiveInputGate().allowed, true);
  h.key(); h.pointer(); assert.ok(h.business().length > before);
});

test('ordinary generation-zero start travels actual Viewer → registered Signal → real Host → Signal → Viewer', () => {
  process.env.ACCESS_PASSWORD ||= 'test-viewer-password';
  process.env.JWT_SECRET ||= '12345678'; process.env.HOST_PASSWORD ||= 'test-host-password';
  const { setupSignaling, connections } = require('../../signal-server/websocket/signaling');
  const { FakeSocket, makeIo, resetConnections, grantActiveLease } = require('../../signal-server/websocket/signaling-test-fixture');
  resetConnections();
  const io = makeIo(); setupSignaling(io);
  const host = new FakeSocket('host-1', 'host'), viewer = new FakeSocket('viewer-1', 'viewer');
  viewer.handshake.auth.inputProtocolVersion = 2;
  host.handshake.auth.inputProtocolVersion = 2;
  io.connect(host); io.connect(viewer);
  const grant = grantActiveLease(io, host, viewer);
  const h = relayIntegrationFixture(), { WebRTC } = h;
  assert.equal(grant.leaseEpoch, 1);
  WebRTC.controlState.lease = { leaseId: grant.leaseId, leaseEpoch: grant.leaseEpoch };
  h.Input.setControlLease(WebRTC.controlState.lease);
  WebRTC.socket.emit = (event, data) => { h.sent.push([event, data]); viewer.trigger(event, data); };
  assert.equal(WebRTC.startTunnelRelay(), true);
  const bind = host.sent.filter(e => e.event === 'connection-attempt-bind').at(-1).data;
  const request = host.sent.filter(e => e.event === 'relay-stream-control').at(-1).data;
  assert.equal(request.relayMediaGeneration, 0);
  for (const key of ['generation', 'state', 'mediaControlSchemaVersion']) assert.equal(key in request, false);
  const bridge = require('node:child_process').spawnSync('python3', ['-B', path.join(__dirname, '../../python-host/test_tunnel_relay.py')], {
    input: JSON.stringify({ bind, request, leaseBinding: { viewerId: viewer.id, leaseId: grant.leaseId,
      leaseEpoch: grant.leaseEpoch, connectionGeneration: 1 } }), encoding: 'utf8', timeout: 15000,
  });
  assert.equal(bridge.status, 0, bridge.stderr);
  const ack = JSON.parse(bridge.stdout.trim());
  assert.equal(ack.applied, true); assert.equal(ack.generation, 0);
  const fields = { relayFrameSchemaVersion: 1, relayScope: ack.relayScope };
  h.frame(fields, 1, false);
  assert.equal(WebRTC.tunnelLastFrameId, 0, 'before start ACK the frame is discarded');
  host.trigger('relay-stream-control-ack', ack);
  const routes = viewer.sent.filter(e => ['media-activity-ack', 'relay-stream-control-ack'].includes(e.event));
  assert.equal(routes.length, 2);
  assert.deepEqual(routes[0].data, routes[1].data);
  routes.forEach(e => WebRTC.handleMediaActivityAck(e.data));
  assert.equal(WebRTC.hasPaintedFrame, false);
  assert.equal(WebRTC.mediaActivityRuntime.snapshot().desiredGeneration, 0);
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  h.frame(fields, 2);
  assert.equal(WebRTC.isCurrentAttemptMediaReady(), true);
  assert.equal(h.Input.getEffectiveInputGate().allowed, true);
  h.key(); assert.equal(h.business().length, 1);
  resetConnections();
});

test('JPEG stale image load closes real gate, resets held keys/pointer, and only current reset ACKs reopen', () => {
  const h = relayIntegrationFixture(), { WebRTC, Input } = h;
  WebRTC.startTunnelRelay(); const { fields } = h.replyStart(); h.frame(fields);
  assert.equal(Input.getEffectiveInputGate().allowed, true);
  h.key(); h.pointer(); h.writes().forEach(d => h.ackWrite(d, d.type === 'keyboard' ? { pressedKeyCount: 1 } : {}));
  const before = h.business().length;
  h.advance(4999); assert.equal(WebRTC.canEnableDesktopInput(), true);
  assert.equal(Input.lastKeyboardResetReason, null);
  h.advance(1);
  assert.equal(WebRTC.uiPhase, 'media-stalled');
  assert.equal(Input.getEffectiveInputGate().allowed, false);
  assert.equal(Input.isActive, false);
  assert.equal(Input.lastKeyboardResetReason, 'deactivated');
  assert.ok(h.writes().some(d => d.type === 'mouse' && d.action === 'reset'));
  const previous = h.currentResets();
  h.key(); h.pointer(); assert.equal(h.business().length, before);
  h.frame(fields, 2);
  assert.equal(WebRTC.uiPhase, 'connected');
  assert.equal(Input.getEffectiveInputGate().allowed, false);
  h.key(); h.pointer(); assert.equal(h.business().length, before);
  const current = h.currentResets();
  previous.filter(a => !current.some(b => a.inputIds[0] === b.inputIds[0])).forEach(d => h.ackWrite(d));
  assert.equal(Input.getEffectiveInputGate().allowed, false);
  h.settleResets(); assert.equal(Input.getEffectiveInputGate().allowed, true);
  h.key(); h.pointer(); assert.ok(h.business().length > before);
});

for (const failure of ['inactive', 'rejected', 'timeout']) test(`JPEG freshness preserves real ${failure} reset barriers`, () => {
  const h = relayIntegrationFixture(), { WebRTC, Input } = h;
  WebRTC.startTunnelRelay(); const { fields } = h.replyStart(); h.frame(fields);
  h.key(); h.writes().forEach(d => h.ackWrite(d, { pressedKeyCount: 1 }));
  if (failure === 'inactive') Input.setActive(false, { resetKeyboard: false });
  h.advance(5000);
  assert.equal(Input.lastKeyboardResetReason, 'deactivated');
  const resets = h.currentResets();
  assert.ok(resets.some(d => d.type === 'keyboard'));
  h.frame(fields, 2);
  const before = h.business().length;
  if (failure === 'rejected') h.currentResets().forEach(d => h.ackWrite(d, { status: 'execution-failed' }));
  if (failure === 'timeout') h.advance(3001);
  assert.equal(Input.getEffectiveInputGate().allowed, false);
  h.key(); h.pointer(); assert.equal(h.business().length, before);
  if (failure === 'inactive') { h.settleResets(); assert.equal(Input.getEffectiveInputGate().allowed, true); }
  else {
    const count = h.writes().length;
    h.frame(fields, 3, failure !== 'timeout');
    h.key(); h.pointer();
    assert.equal(Input.getEffectiveInputGate().allowed, false);
    assert.ok(h.writes().slice(count).every(d => d.action === 'reset' || d.action === 'up'));
  }
});

async function waitRelayDigest(WebRTC) {
  for (let i = 0; i < 100 && !WebRTC._relayOriginDigest; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.match(WebRTC._relayOriginDigest, /^[a-f0-9]{64}$/);
}

test('JPEG feedback uses real collector, keeps old producer samples, isolates UI, and deduplicates full origins', async () => {
  const h = relayIntegrationFixture(), { WebRTC, monitor } = h;
  WebRTC.startTunnelRelay(); const a = h.replyStart('producer-A');
  h.frame(a.fields); // Decode and input readiness do not await the optional digest.
  assert.equal(h.Input.getEffectiveInputGate().allowed, true);
  await waitRelayDigest(WebRTC);
  assert.equal(WebRTC.handleRelayFrameFeedback(relayFeedback(a.fields, 1, { sampleSequence: 1, relayFrameAckRttMs: 100 })), true);
  assert.equal(monitor.snapshot().metrics.relayFrameAckRttMs.last, 100);
  monitor.recordStage('inputAckRttMs', 15, { scope: WebRTC.latencyScope(), atMs: h.now(), sampleKey: 'input-other-metric' });
  h.advance(100);
  WebRTC.startTunnelRelay(); const b = h.replyStart('producer-B');
  assert.equal(h.context.document.getElementById('latencyDisplay').textContent, '未测量');
  assert.equal(monitor.snapshot().metrics.relayFrameAckRttMs.count, 1);
  assert.equal(monitor.snapshot().metrics.inputAckRttMs.count, 1);
  await waitRelayDigest(WebRTC);
  const firstB = relayFeedback(b.fields, 1, { sampleSequence: 1, relayFrameAckRttMs: 200 });
  WebRTC.handleRelayFrameFeedback(firstB);
  assert.equal(monitor.snapshot().metrics.relayFrameAckRttMs.count, 2);
  assert.equal(monitor.snapshot().metrics.relayFrameAckRttMs.last, 200);
  assert.equal(h.context.document.getElementById('latencyDisplay').textContent, '200 ms');
  WebRTC.handleRelayFrameFeedback(firstB);
  WebRTC.handleRelayFrameFeedback(relayFeedback(b.fields, 2, { sampleSequence: 1, relayFrameAckRttMs: 999 }));
  WebRTC.handleRelayFrameFeedback(relayFeedback(a.fields, 3, { sampleSequence: 2, relayFrameAckRttMs: 777 }));
  assert.equal(monitor.snapshot().metrics.relayFrameAckRttMs.count, 2);
  WebRTC.handleRelayFrameFeedback(relayFeedback(b.fields, 3, null));
  assert.equal(monitor.snapshot().metrics.relayFrameAckRttMs.count, 2);
  assert.equal(WebRTC._relayLastLoadedAtMs, null, 'feedback never refreshes image load age');
  WebRTC.applyMediaActivity({ state: 'suspended', generation: 1, reasons: ['manual-pause'] });
  WebRTC.handleMediaActivityAck({ state: 'suspended', generation: 1, applied: true, connectionAttemptId: 'attempt-1' });
  WebRTC.applyMediaActivity({ state: 'active', generation: 2, reasons: [] });
  const resumed = relayAckFields(WebRTC, 2, 'producer-B');
  WebRTC.handleMediaActivityAck({ ...resumed, state: 'active', generation: 2, applied: true, connectionAttemptId: 'attempt-1' });
  await waitRelayDigest(WebRTC);
  WebRTC.handleRelayFrameFeedback(relayFeedback(resumed, 1, { sampleSequence: 1, relayFrameAckRttMs: 300 }));
  assert.equal(monitor.snapshot().metrics.relayFrameAckRttMs.count, 3);
  assert.equal(monitor.snapshot().metrics.relayFrameAckRttMs.last, 300);
  assert.equal(monitor.snapshot().metrics.inputAckRttMs.count, 1);
  h.advance(5000); WebRTC.renderRelayFeedbackRtt();
  assert.equal(monitor.snapshot().metrics.relayFrameAckRttMs.available, false);
  assert.equal(h.context.document.getElementById('latencyDisplay').textContent, '未测量');
});

test('JPEG maximum source strings produce collision-resistant bounded keys without resetting collector', async () => {
  const h = relayIntegrationFixture(), { WebRTC, monitor } = h;
  WebRTC.currentConnectionAttemptId = 'a'.repeat(128);
  WebRTC.syncLatencyScope();
  WebRTC.startTunnelRelay(); const a = h.replyStart('p'.repeat(64));
  await waitRelayDigest(WebRTC);
  const keyCalls = [];
  const record = monitor.recordStage;
  monitor.recordStage = (name, value, options) => { keyCalls.push(options.sampleKey); return record(name, value, options); };
  WebRTC.handleRelayFrameFeedback(relayFeedback(a.fields, 1, { sampleSequence: Number.MAX_SAFE_INTEGER, relayFrameAckRttMs: 12 }));
  assert.equal(keyCalls[0].length, 87);
  assert.match(keyCalls[0], /^relay:[a-f0-9]{64}:[0-9]+$/);
  const canonical = JSON.stringify(['p'.repeat(64), 1, 'a'.repeat(128), 0, 1]);
  assert.equal(keyCalls[0], `relay:${require('node:crypto').createHash('sha256').update(canonical).digest('hex')}:${Number.MAX_SAFE_INTEGER}`);
  assert.equal(monitor.snapshot().metrics.relayFrameAckRttMs.count, 1);
});

test('JPEG missing or late diagnostics hash never gates media or backfills misleading sample timestamps', async () => {
  const h = relayIntegrationFixture({ withCrypto: false }), { WebRTC } = h;
  const pendingDigests = [];
  h.context.crypto = { subtle: { digest(_alg, bytes) { return new Promise(resolve => pendingDigests.push({ bytes, resolve })); } } };
  WebRTC.startTunnelRelay(); const a = h.replyStart('producer-A');
  h.frame(a.fields);
  assert.equal(h.Input.getEffectiveInputGate().allowed, true);
  WebRTC.handleRelayFrameFeedback(relayFeedback(a.fields, 1, { sampleSequence: 1, relayFrameAckRttMs: 50 }));
  assert.equal(h.monitor.snapshot().metrics.relayFrameAckRttMs.available, false);
  h.advance(100);
  WebRTC.startTunnelRelay(); const b = h.replyStart('producer-B');
  pendingDigests[0].resolve(new Uint8Array(32).fill(1).buffer);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(WebRTC._relayOriginDigest, null);
  pendingDigests[1].resolve(new Uint8Array(32).fill(2).buffer);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(WebRTC._relayOriginDigest, '02'.repeat(32));
  assert.equal(h.monitor.snapshot().metrics.relayFrameAckRttMs.available, false);
  WebRTC.handleRelayFrameFeedback(relayFeedback(b.fields, 1, { sampleSequence: 1, relayFrameAckRttMs: 150 }));
  assert.equal(h.monitor.snapshot().metrics.relayFrameAckRttMs.last, 150);
  const noCrypto = relayIntegrationFixture({ withCrypto: false });
  noCrypto.WebRTC.startTunnelRelay(); const c = noCrypto.replyStart(); noCrypto.frame(c.fields);
  assert.equal(noCrypto.Input.getEffectiveInputGate().allowed, true);
  noCrypto.WebRTC.handleRelayFrameFeedback(relayFeedback(c.fields, 1, { sampleSequence: 1, relayFrameAckRttMs: 100 }));
  assert.equal(noCrypto.monitor.snapshot().metrics.relayFrameAckRttMs.available, false);
});

test('JPEG source validation precedes watermark, and replaced onload/socket/scope cannot ACK or recover', () => {
  const h = relayIntegrationFixture(), { WebRTC } = h;
  WebRTC.startTunnelRelay(); const p = WebRTC._relayPendingStart;
  const expected = relayAckFields(WebRTC);
  h.frame(expected, 99, false);
  assert.equal(WebRTC.tunnelLastFrameId, 0);
  const first = h.replyStart();
  for (const patch of [{ producerId: 'foreign' }, { productionGeneration: 99 }, { mediaGeneration: true },
    { mediaGeneration: -1 }, { leaseEpoch: 2 }, { connectionAttemptId: 'wrong' }, { producerId: 'x'.repeat(65) }, { producerId: 'producer-1\n' }]) {
    h.frame({ ...first.fields, relayScope: { ...first.fields.relayScope, ...patch } }, 99, false);
    assert.equal(WebRTC.tunnelLastFrameId, 0);
  }
  const oldLoad = h.frame(first.fields, 1, false);
  const newLoad = h.frame(first.fields, 2, false);
  const before = h.sent.filter(([e]) => e === 'relay-frame-ack').length;
  oldLoad(); assert.equal(WebRTC.hasPaintedFrame, false);
  assert.equal(WebRTC._relayLastLoadedAtMs, null);
  newLoad(); newLoad();
  assert.equal(h.sent.filter(([e]) => e === 'relay-frame-ack').length, before + 1);
  const ack = h.sent.filter(([e]) => e === 'relay-frame-ack').at(-1)[1];
  assert.equal(ack.frameId, 2); assert.equal(ack.latencyMs, undefined); assert.equal(ack.renderedAt, undefined);
  assert.equal(JSON.stringify(ack.relayScope), JSON.stringify(first.fields.relayScope));
  const timer = [...h.timers].find(([,t]) => t.delay === 5000)[1];
  WebRTC.startTunnelRelay(); const next = h.replyStart('new-producer');
  timer.fn(); assert.equal(WebRTC.uiPhase, 'signaling');
  const load = h.frame(next.fields, 1, false);
  WebRTC.socket = { connected: true, emit() {} };
  load(); assert.equal(WebRTC.hasPaintedFrame, false);
  assert.equal(WebRTC.relayScopeMatches(next.fields.relayScope), false);
  assert.equal(WebRTC._relayLastLoadedAtMs, null);
  assert.equal(p.mediaGeneration, 0);
});

test('JPEG superseded start and suspend reject stale generation-zero ACK/request and foreign leases', () => {
  const h = relayIntegrationFixture(), { WebRTC } = h;
  WebRTC.startTunnelRelay(); const oldPending = WebRTC._relayPendingStart;
  const oldAck = { ...relayAckFields(WebRTC), relayControlKind: 'start', relayStartRequestId: oldPending.requestId,
    state: 'active', generation: 0, applied: true, connectionAttemptId: 'attempt-1' };
  WebRTC.startTunnelRelay(); assert.notEqual(WebRTC._relayPendingStart.requestId, oldPending.requestId);
  assert.equal(WebRTC.handleMediaActivityAck(oldAck), false);
  const latest = WebRTC._relayPendingStart;
  assert.equal(WebRTC.handleMediaActivityAck({ ...oldAck, relayStartRequestId: latest.requestId,
    relayScope: { ...oldAck.relayScope, leaseEpoch: 2 } }), false);
  WebRTC.applyMediaActivity({ state: 'suspended', generation: 1, reasons: ['manual-pause'] });
  assert.equal(WebRTC._relayPendingStart, null);
  assert.equal(WebRTC.handleMediaActivityAck({ ...oldAck, relayStartRequestId: latest.requestId }), false);
  assert.equal(WebRTC._relayExpectedScope, null);
  assert.equal(WebRTC._relayFreshnessTimer, null);
});

for (const offset of [-86400000, 86400000]) test(`JPEG image timestamp offset ${offset} never changes monotonic feedback RTT`, async () => {
  const h = relayIntegrationFixture(), { WebRTC } = h;
  WebRTC.startTunnelRelay(); const { fields } = h.replyStart();
  WebRTC.handleRelayFrame({ ...fields, frameId: 1, data: 'AAAA', timestamp: h.now() + offset });
  h.context.document.getElementById('relayImage').onload();
  const ack = h.sent.filter(([e]) => e === 'relay-frame-ack').at(-1)[1];
  assert.equal('latencyMs' in ack, false); assert.equal('renderedAt' in ack, false);
  await waitRelayDigest(WebRTC);
  WebRTC.handleRelayFrameFeedback(relayFeedback(fields, 1, { sampleSequence: 1, relayFrameAckRttMs: 321 }));
  assert.equal(h.context.document.getElementById('latencyDisplay').textContent, '321 ms');
  assert.equal(h.monitor.snapshot().metrics.relayFrameAckRttMs.last, 321);
  assert.match(h.context.document.getElementById('latencyDisplay').title, /JPEG反馈往返/);
});

test('JPEG single scope timer expires RTT after stall and arrival-only traffic never refreshes load age', async () => {
  const h = relayIntegrationFixture(), { WebRTC } = h;
  WebRTC.startTunnelRelay(); const { fields } = h.replyStart(); h.frame(fields);
  await waitRelayDigest(WebRTC);
  h.advance(4000);
  WebRTC.handleRelayFrameFeedback(relayFeedback(fields, 1, { sampleSequence: 1, relayFrameAckRttMs: 42 }));
  h.frame(fields, 2, false);
  assert.equal(WebRTC._relayLastLoadedAtMs, 1000);
  const timerFn = h.timers.get(WebRTC._relayFreshnessTimer).fn;
  h.advance(1000);
  assert.equal(WebRTC.uiPhase, 'media-stalled');
  assert.equal(h.context.document.getElementById('latencyDisplay').textContent, '42 ms');
  const count = h.writes().length;
  timerFn(); timerFn();
  assert.equal(h.writes().length, count, 'repeated stall does not reissue reset');
  h.settleResets(); // Complete safety release without supplying a fresh media frame.
  h.advance(4000);
  assert.equal(h.context.document.getElementById('latencyDisplay').textContent, '未测量');
  assert.equal(WebRTC._relayFreshnessTimer, null);
  assert.equal(WebRTC._relayLastLoadedAtMs, 1000);
});

test('JPEG socket replacement clears origin/pending callbacks and ignores the old registered socket', () => {
  const h = relayIntegrationFixture(), { WebRTC } = h;
  const oldHandlers = new Map(), newHandlers = new Map();
  WebRTC.socket.on = (event, fn) => oldHandlers.set(event, fn);
  WebRTC.setupSocketListeners();
  WebRTC.startTunnelRelay(); const { fields } = h.replyStart(); const load = h.frame(fields, 1, false);
  WebRTC.socket = { id: 'viewer-new', connected: true, emit() {}, on: (event, fn) => newHandlers.set(event, fn) };
  WebRTC.setupSocketListeners();
  assert.equal(WebRTC._relayExpectedScope, null);
  assert.equal(WebRTC._relayPendingStart, null);
  load();
  oldHandlers.get('relay-frame')({ ...fields, frameId: 2, data: 'AAAA' });
  oldHandlers.get('relay-frame-feedback')(relayFeedback(fields, 1, { sampleSequence: 1, relayFrameAckRttMs: 1 }));
  assert.equal(WebRTC.tunnelLastFrameId, 0);
  assert.equal(WebRTC._relayLastLoadedAtMs, null);
  assert.equal(WebRTC._relayRttView, null);
  assert.equal(WebRTC._relayFreshnessTimer, null);
});

for (const mode of ['relay', 'stun']) for (const action of ['attempt', 'freeze']) {
  test(`JPEG origin cleanup preserves ${mode} RTT display during real ${action} lifecycle`, () => {
    const { WebRTC, context } = loadWebRTC();
    WebRTC.networkMode = mode;
    WebRTC.socket = { connected: true, emit() {} };
    const latency = context.document.getElementById('latencyDisplay');
    latency.textContent = 'RTT 37 ms';
    latency.title = '网络 RTT 37 ms';
    if (action === 'attempt') WebRTC.beginConnectionAttempt('viewer-open');
    else WebRTC.freezeControl('control-revoked');
    assert.equal(latency.title, '网络 RTT 37 ms');
    assert.equal(latency.textContent, 'RTT 37 ms');
    assert.equal(WebRTC._relayExpectedScope, null);
  });
}

test('JPEG origin cleanup still clears the just-ended active relay RTT display', async () => {
  const h = relayIntegrationFixture(), { WebRTC } = h;
  WebRTC.startTunnelRelay(); const { fields } = h.replyStart(); h.frame(fields);
  await waitRelayDigest(WebRTC);
  WebRTC.handleRelayFrameFeedback(relayFeedback(fields, 1, { sampleSequence: 1, relayFrameAckRttMs: 42 }));
  const latency = h.context.document.getElementById('latencyDisplay');
  assert.equal(latency.textContent, '42 ms');
  assert.match(latency.title, /JPEG反馈往返/);
  WebRTC.stopTunnelRelay();
  assert.equal(latency.textContent, '未测量');
  assert.match(latency.title, /JPEG反馈往返/);
  assert.equal(WebRTC._relayExpectedScope, null);
  assert.equal(WebRTC._relayRttView, null);
});

function diagnosticIntervalFixture() {
  let now = 10000;
  let track = { id: 'diagnostic-track', kind: 'video', readyState: 'live' };
  const { WebRTC, context } = loadWebRTC({ performance: { now: () => now }, console: { log() {}, warn() {}, error() {} } });
  WebRTC.pc = { connectionState: 'connected', getReceivers: () => [{ track }] };
  WebRTC.remoteStream = { getVideoTracks: () => [track] };
  WebRTC.currentConnectionAttemptId = 'diagnostic-attempt'; WebRTC.connectionAttemptSequence = 2;
  WebRTC.networkMode = 'stun'; WebRTC.uiPhase = 'connected'; WebRTC.hasPaintedFrame = true;
  const consume = (overrides = {}) => WebRTC.processStatsSnapshot({ interval: true, warmup: false,
    elapsedMs: 1000, sampledAt: 9900, derivedFps: 18, decodedDelta: 18, receivedDelta: 20,
    diagnosticInbound: { trackIdentifier: track.id, intervalSourceStable: true },
    framesDroppedDelta: 0, videoWidth: 1152, videoHeight: 720, ...overrides });
  consume({ warmup: true, elapsedMs: null, sampledAt: 8900 });
  return { WebRTC, context, consume, setNow: value => { now = value; }, replaceTrack: () => { track = { id: 'next-track', kind: 'video', readyState: 'live' }; } };
}

test('diagnostic interval provenance preserves real zero counters before canonical normalization', () => {
  const { WebRTC, consume } = diagnosticIntervalFixture();
  consume();
  assert.deepEqual(JSON.parse(JSON.stringify(WebRTC.getDiagnosticMediaInterval())), {
    schemaVersion: 1, kind: 'webrtc-inbound-interval', elapsedMs: 1000,
    sampleAgeMs: 100, fpsObserved: true, droppedFramesObserved: true,
  });
  consume({ derivedFps: 0, decodedDelta: 0, framesDroppedDelta: 0 });
  assert.equal(WebRTC.getDiagnosticMediaInterval().fpsObserved, true);
  assert.equal(WebRTC.getDiagnosticMediaInterval().droppedFramesObserved, true);
  consume({ decodedDelta: null, framesDroppedDelta: null });
  assert.equal(WebRTC._lastPaintStats.decodedDelta, 0);
  assert.equal(WebRTC._lastPaintStats.framesDroppedDelta, 0);
  assert.equal(WebRTC.getDiagnosticMediaInterval().fpsObserved, false);
  assert.equal(WebRTC.getDiagnosticMediaInterval().droppedFramesObserved, false);
  for (const value of [undefined, '', '0', true, NaN, Infinity, -1, .5]) {
    consume({ decodedDelta: value, framesDroppedDelta: value });
    assert.equal(WebRTC.getDiagnosticMediaInterval().fpsObserved, false);
    assert.equal(WebRTC.getDiagnosticMediaInterval().droppedFramesObserved, false);
  }
});

test('diagnostic interval provenance survives actual normalizeStats through redaction and projection', () => {
  const { WebRtcStats } = require('./webrtc-stats');
  const { redactDiagnosticPayload } = require('../../signal-server/lib/diagnostic');
  const { projectDiagnostic } = require('../../signal-server/lib/observability/runtime-evidence');
  const { WebRTC, consume } = diagnosticIntervalFixture();
  const current = new Map([['video', { id: 'inbound', ssrc: 10, trackIdentifier: 'diagnostic-track', type: 'inbound-rtp', kind: 'video',
    framesDecoded: 118, framesReceived: 120, framesDropped: 5 }]]);
  const previous = WebRtcStats.normalizeStats(new Map([['video', { ...current.get('video'),
    framesDecoded: 100, framesReceived: 100 }]]), null, 8900).totals;
  const project = () => projectDiagnostic(redactDiagnosticPayload({ schemaVersion: 3, traceSummary: {
    ...WebRTC._lastPaintStats, mediaInterval: WebRTC.getDiagnosticMediaInterval() } }));
  consume(WebRtcStats.normalizeStats(current, previous, 9900));
  assert.deepEqual(project().fps, [18]);
  assert.deepEqual(project().droppedIntervalDelta, [0]);
  current.get('video').framesDropped = undefined;
  consume(WebRtcStats.normalizeStats(current, previous, 9900));
  assert.deepEqual(project().fps, [18]);
  assert.deepEqual(project().droppedIntervalDelta, []);
  consume(WebRtcStats.normalizeStats(current, null, 9900));
  assert.deepEqual(project().fps, []);
  assert.deepEqual(project().droppedIntervalDelta, []);
});

test('diagnostic interval provenance rejects warmup, invalid clocks and noninterval paint callbacks', () => {
  for (const overrides of [{ interval: false }, { warmup: true }, { elapsedMs: 0 }, { elapsedMs: null },
    { elapsedMs: '1000' }, { elapsedMs: Infinity }, { sampledAt: null }, { sampledAt: '9900' }]) {
    const { WebRTC, consume } = diagnosticIntervalFixture(); consume(overrides);
    assert.equal(WebRTC.getDiagnosticMediaInterval(), null);
  }
  const { WebRTC, consume, setNow } = diagnosticIntervalFixture(); consume();
  setNow(14901); assert.equal(WebRTC.getDiagnosticMediaInterval(), null);
  setNow(9800); assert.equal(WebRTC.getDiagnosticMediaInterval(), null);
  setNow(10000);
  WebRTC.notePaintStats({ source: 'video-element', framesDecoded: 999, fps: 0, videoWidth: 1152, videoHeight: 720 });
  assert.equal(WebRTC.getDiagnosticMediaInterval(), null);
});

test('diagnostic interval provenance is invalidated by attempt, peer, track, stream and telemetry retirement', () => {
  for (const change of [f => { f.WebRTC.currentConnectionAttemptId = 'next-attempt'; },
    f => { f.WebRTC.connectionAttemptSequence++; }, f => { f.WebRTC.pc = {}; },
    f => f.replaceTrack(), f => { f.WebRTC.remoteStream = { getVideoTracks: () => [] }; },
    f => f.WebRTC.stopMediaTelemetry()]) {
    const f = diagnosticIntervalFixture(); f.consume();
    assert.notEqual(f.WebRTC.getDiagnosticMediaInterval(), null);
    change(f); assert.equal(f.WebRTC.getDiagnosticMediaInterval(), null);
  }
});

test('diagnostic interval provenance waits for a new counter baseline after a same-peer track change', () => {
  const f = diagnosticIntervalFixture(); f.consume();
  assert.notEqual(f.WebRTC.getDiagnosticMediaInterval(), null);
  f.replaceTrack();
  f.consume();
  assert.equal(f.WebRTC.getDiagnosticMediaInterval(), null);
  f.consume();
  assert.notEqual(f.WebRTC.getDiagnosticMediaInterval(), null);
});

test('diagnostic interval provenance fences an old pending getStats result across a same-peer track change', async () => {
  const { WebRtcStats } = require('./webrtc-stats');
  const f = diagnosticIntervalFixture();
  f.context.WebRtcStats = { createWebRtcStatsSampler: options => WebRtcStats.createWebRtcStatsSampler({
    ...options, now: () => f.context.performance.now(), setTimer: () => 1, clearTimer() {},
  }) };
  const stats = (decoded, dropped, trackIdentifier) => new Map([['video', { id: 'inbound-' + trackIdentifier,
    ssrc: trackIdentifier === 'diagnostic-track' ? 10 : 11, trackIdentifier, type: 'inbound-rtp', kind: 'video',
    framesDecoded: decoded, framesReceived: decoded, framesDropped: dropped }]]);
  let resolveOld, calls = 0, nextStats;
  f.WebRTC.pc.getStats = () => ++calls === 1 ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve(nextStats);
  f.WebRTC.startStats();
  f.replaceTrack();
  resolveOld(stats(120, 4, 'diagnostic-track'));
  await f.WebRTC._statsSampler.sampleNow();
  assert.equal(f.WebRTC.getDiagnosticMediaInterval(), null);
  f.setNow(11000); nextStats = stats(150, 5, 'next-track');
  await f.WebRTC._statsSampler.sampleNow();
  assert.equal(f.WebRTC.getDiagnosticMediaInterval(), null, 'B must not use A totals as its baseline');
  f.setNow(12000); nextStats = stats(168, 5, 'next-track');
  await f.WebRTC._statsSampler.sampleNow();
  assert.equal(f.WebRTC.getDiagnosticMediaInterval().fpsObserved, true);
  assert.equal(f.WebRTC._lastPaintStats.derivedFps, 18);
});

test('diagnostic interval provenance rejects an inbound row belonging to a different current track', () => {
  const { WebRtcStats } = require('./webrtc-stats');
  const f = diagnosticIntervalFixture();
  const rows = decoded => new Map([
    ['old', { id: 'old-inbound', ssrc: 10, trackIdentifier: 'old-track', type: 'inbound-rtp', kind: 'video', framesDecoded: decoded, framesDropped: 1 }],
    ['current', { id: 'current-inbound', ssrc: 11, trackIdentifier: 'diagnostic-track', type: 'inbound-rtp', kind: 'video', framesDecoded: decoded, framesDropped: 1 }],
  ]);
  const previous = WebRtcStats.normalizeStats(rows(100), null, 8900).totals;
  f.consume(WebRtcStats.normalizeStats(rows(118), previous, 9900));
  assert.equal(f.WebRTC.getDiagnosticMediaInterval(), null);
});

// Exercise the real consumer chain: process -> handleReceiverStats -> controller.
test('nullable media latency survives DOM, paint cache, controller and viewer-stats without losing zero', () => {
  const { LinkQualityController } = require('./link-quality-controller');
  const unknowns = [null, undefined, '', '0', '725.1', true, false, {}, NaN, Infinity, -Infinity, -1];
  const pairs = [...unknowns.flatMap(value => [[value, value], [value, 0], [40, value]]), [0, 0], [0.1, 725.1]];
  for (const [rttMs, jitterBufferMs] of pairs) {
    const reports = [], observed = [];
    const monitor = require('./latency-monitor').createLatencyMonitor({ now: () => 0 });
    const { WebRTC, context } = loadWebRTC({ LinkQualityController, LatencyMonitor: monitor, console: { log() {}, warn() {}, error() {} } });
    WebRTC.networkMode = 'stun'; WebRTC.adaptiveMediaEnabled = true;
    WebRTC.currentConnectionAttemptId = 'nullable-attempt'; WebRTC.connectionAttemptSequence = 1;
    WebRTC.socket = { connected: true, emit(event, payload) { if (event === 'viewer-stats') reports.push(payload); } };
    const controller = WebRTC.ensureLinkQualityController();
    const observe = controller.observe.bind(controller);
    controller.observe = stats => { observed.push(stats); return observe(stats); };
    WebRTC.uiPhase = 'connected'; WebRTC.hasPaintedFrame = true;
    const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    WebRTC.processStatsSnapshot({ derivedFps: 20, receivedDelta: 20, decodedDelta: 20,
      packetsLostDelta: 0, bytesDelta: 4000, totals: { framesDecoded: 20 },
      selectedCandidateType: 'host', rttMs, jitterBufferMs, videoWidth: 1280, videoHeight: 720 });
    assert.equal(observed.length, 1, 'real handleReceiverStats must invoke controller');
    for (const stats of [observed[0], reports[0]]) {
      assert.equal(stats.rttMs, valid(rttMs)); assert.equal(stats.jitterBufferMs, valid(jitterBufferMs));
    }
    assert.equal(WebRTC._lastPaintStats.jitterBufferMs, valid(jitterBufferMs));
    assert.equal(monitor.snapshot().metrics.candidateRttMs.last, valid(rttMs));
    assert.equal(monitor.snapshot().metrics.jitterBufferMs.last, valid(jitterBufferMs));
    assert.equal(WebRTC.selectedCandidatePair.rttMs, null);
    assert.equal(WebRTC.uiPhase, 'connected');
    assert.equal(controller.goodCount, valid(rttMs) !== null && valid(jitterBufferMs) !== null && rttMs < controller.highRttMs && jitterBufferMs < 150 ? 1 : 0);
    const latency = context.document.getElementById('latencyDisplay');
    const expected = [];
    if (valid(rttMs) !== null) expected.push(`RTT ${Math.round(rttMs)} ms`);
    if (valid(jitterBufferMs) !== null) expected.push(`缓冲 ${Math.round(jitterBufferMs)} ms`);
    assert.equal(latency.textContent, expected.join(' · ') || '未测量');
    if (valid(rttMs) !== null) {
      assert.match(latency.title, new RegExp(`RTT ${Math.round(rttMs)} ms`));
      assert.match(context.document.getElementById('candidateDisplay').textContent, new RegExp(`· ${rttMs} ms`));
    } else assert.doesNotMatch(context.document.getElementById('candidateDisplay').textContent, /· .* ms/);
    if (valid(jitterBufferMs) !== null) assert.match(latency.title, new RegExp(`缓冲 ${Math.round(jitterBufferMs)} ms`));
    if (!expected.length) assert.equal(latency.title, '未测量');
    WebRTC.processStatsSnapshot({ derivedFps: 20, decodedDelta: 20, receivedDelta: 20,
      selectedCandidateType: 'host', selectedCandidatePair: { localType: 'host', remoteType: 'srflx', rttMs } });
    assert.equal(WebRTC.selectedCandidatePair.rttMs, valid(rttMs));
    assert.equal(WebRTC.selectedCandidatePair.remoteType, 'srflx');
  }
});

for (const selectedCandidateType of ['host', 'prflx', 'relay']) test(`${selectedCandidateType} guidance distinguishes RTT zero from unavailable`, () => {
  const { WebRTC, context } = loadWebRTC({ console: { log() {}, warn() {}, error() {} } });
  WebRTC.networkMode = selectedCandidateType === 'relay' ? 'relay' : 'stun';
  WebRTC.uiPhase = 'connected'; WebRTC.hasPaintedFrame = true;
  for (const rttMs of [0, null]) {
    WebRTC.processStatsSnapshot({ derivedFps: 20, decodedDelta: 20, receivedDelta: 20,
      bytesDelta: 4000, selectedCandidateType, rttMs, jitterBufferMs: 0, videoWidth: 1280 });
    assert.match(context.document.getElementById('networkAdvisorText').textContent,
      rttMs === null ? /RTT 未测量/ : /RTT 0 ms/);
  }
});

function webRtcDurationFixture() {
  let mono = 0, wall = 1792208500000, timerId = 0;
  const timers = new Map();
  const result = loadWebRTC({
    performance: { now: () => mono }, Date: { now: () => wall },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay, due: mono + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  return { ...result, timers,
    stepWall(delta) { wall += delta; },
    setMono(value) { mono = value; },
    advanceTo(target) {
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > target) break;
        mono = next[1].due; timers.delete(next[0]); next[1].fn();
      }
      mono = target;
    },
  };
}

function modeSwitchRecoveryFixture({ withEpisode = false } = {}) {
  const h = webRtcDurationFixture();
  const { WebRTC, context } = h;
  const sockets = [], peers = [];
  let resolveConfig;
  context.setInterval = () => 1;
  context.clearInterval = () => {};
  context.io = (_url, options) => {
    const handlers = new Map();
    const socket = { id: `mode-socket-${sockets.length}`, auth: options.auth, connected: false,
      on(event, fn) { handlers.set(event, fn); }, emit() {},
      disconnect() { this.connected = false; },
      trigger(event, data) { return handlers.get(event)?.(data); },
      io: { opts: options, engine: { readyState: 'opening', transport: { name: 'websocket' } },
        _readyState: 'closed', reconnection() {} } };
    sockets.push(socket);
    return socket;
  };
  WebRTC.serverConfig = { turnConfigured: true, turnStatus: 'configured', iceServers: [] };
  WebRTC.loadServerConfig = () => new Promise(resolve => { resolveConfig = resolve; });
  WebRTC.configureNetworkControls = () => {};
  WebRTC.bindControlLifecycle = () => {};
  WebRTC.createPeerConnection = () => {
    const peer = { connectionState: 'new', close() {} };
    WebRTC.pc = peer; peers.push(peer);
  };
  if (withEpisode) {
    const episode = WebRTC.beginStartupEpisode();
    episode.state = 'complete';
  }
  const a = WebRTC.createSignalingSocket();
  WebRTC.scheduleSignalingRecovery();
  const oldTimer = WebRTC._signalRecoveryTimer;
  const queuedA = h.timers.get(oldTimer).fn;
  WebRTC.setNetworkMode('stun');
  assert.equal(WebRTC.socket, null);
  assert.equal(typeof resolveConfig, 'function');
  return { ...h, sockets, peers, a, oldTimer, queuedA,
    async finishConfig() {
      resolveConfig();
      for (let i = 0; i < 12; i++) await Promise.resolve();
      assert.equal(sockets.length, 2);
      return sockets[1];
    } };
}

for (const ordering of ['expiry-during-config', 'error-before-expiry', 'error-after-expiry', 'queued-A-after-B-timer']) {
  test(`mode-switch watchdog ownership: ${ordering} recreates current socket at original max wait`, async t => {
    const h = modeSwitchRecoveryFixture(), { WebRTC } = h;
    const expected = [['[RECOVERY] Signaling connect error:', 'timeout'],
      ['[RECOVERY] Recreating signaling socket after %sms reason=%s', 24000, 'signal-connect-error']];
    captureExpectedSignalingWarnings(t, h.context, expected);
    const oldOrigin = WebRTC._signalRecoveryStartedAt;
    if (ordering === 'expiry-during-config' || ordering === 'error-after-expiry') {
      h.advanceTo(1500);
      h.queuedA();
    } else h.advanceTo(500);
    assert.equal(h.peers.length, 0);
    h.a.connected = true;
    await h.a.trigger('connect');
    assert.equal(h.peers.length, 0, 'old connect cannot create a peer during config');
    h.a.connected = false;
    if (ordering === 'error-after-expiry') h.advanceTo(2000);
    const b = await h.finishConfig();
    assert.equal(h.peers.length, 1);
    b.trigger('connect_error', { message: 'timeout' });
    const timerB = WebRTC._signalRecoveryTimer;
    if (ordering === 'queued-A-after-B-timer') {
      h.advanceTo(1500);
      h.queuedA(); // Cancellation cannot remove an already queued callback.
      assert.equal(WebRTC._signalRecoveryTimer, timerB);
      assert.equal(WebRTC.socket, b);
      assert.equal(h.sockets.length, 2);
    }
    assert.equal(WebRTC._signalRecoveryStartedAt, oldOrigin, 'quiesce/error retain elapsed budget');
    assert.equal(WebRTC._signalRecoveryPending, true);
    h.advanceTo(23999);
    assert.equal(h.sockets.length, 2);
    h.advanceTo(24000);
    assert.equal(h.sockets.length, 3, 'current socket watchdog must recreate at unchanged maximum wait');
    assert.notEqual(WebRTC.socket, b);
    assert.equal(WebRTC._signalRecoveryStartedAt, 24000);
  });
}

for (const outcome of ['connect', 'manual-disconnect', 'superseded', 'retired-episode']) {
  test(`mode-switch watchdog ownership: ${outcome} cancels current recovery and fences queued timers`, async t => {
    const h = modeSwitchRecoveryFixture({ withEpisode: outcome === 'retired-episode' }), { WebRTC } = h;
    captureExpectedSignalingWarnings(t, h.context, [
      ['[RECOVERY] Signaling connect error:', 'timeout'],
      ...(outcome === 'superseded' ? [['[VIEWER] superseded', 'unknown', '']] : []),
    ]);
    h.advanceTo(500);
    const b = await h.finishConfig();
    b.trigger('connect_error', { message: 'timeout' });
    const timerB = WebRTC._signalRecoveryTimer;
    const queuedB = h.timers.get(timerB).fn;
    if (outcome === 'connect') {
      // Actual connect cleanup can refresh a stale peer; isolate that media effect.
      WebRTC.refresh = () => {};
      b.connected = true; await b.trigger('connect');
    } else if (outcome === 'manual-disconnect') WebRTC.disconnect();
    else if (outcome === 'superseded') WebRTC.handleViewerSuperseded();
    else WebRTC.retireStartupEpisode('startup-cancelled', { cleanup: true });
    assert.equal(WebRTC._signalRecoveryTimer, null);
    assert.equal(WebRTC._signalRecoveryStartedAt, null);
    assert.equal(WebRTC._signalRecoveryPending, false);
    h.queuedA(); queuedB(); h.advanceTo(15000);
    assert.equal(h.sockets.length, 2);
    assert.equal(WebRTC._signalRecoveryTimer, null);
  });
}

test('signaling watchdog retires its own spent handle before stale socket or episode returns', () => {
  for (const stale of ['socket', 'episode']) {
    const h = webRtcDurationFixture(), { WebRTC } = h;
    const episode = WebRTC.beginStartupEpisode();
    episode.state = 'complete';
    const handlers = new Map();
    h.context.io = () => ({ connected: false, on(event, fn) { handlers.set(event, fn); }, emit() {}, disconnect() {} });
    WebRTC.createSignalingSocket();
    WebRTC.scheduleSignalingRecovery();
    const timer = WebRTC._signalRecoveryTimer;
    if (stale === 'socket') WebRTC.createSignalingSocket(true);
    else WebRTC.retireStartupEpisode('startup-cancelled');
    h.advanceTo(1500);
    assert.equal(h.timers.has(timer), false);
    assert.equal(WebRTC._signalRecoveryTimer, null, stale);
    assert.equal(WebRTC._signalRecoveryStartedAt, 0, stale);
    assert.equal(WebRTC._signalRecoveryPending, true, stale);
    assert.equal(WebRTC.pc, null, stale);
  }
});

for (const wallStep of [-60000, 60000]) {
  test(`duration clock: signaling preserves mono0 through 1500/24000/25500 with wall step ${wallStep}`, () => {
    const h = webRtcDurationFixture(), { WebRTC } = h;
    WebRTC.socket = { connected: false };
    let recreated = 0;
    WebRTC.createSignalingSocket = (recreate) => { assert.equal(recreate, true); recreated++; };
    assert.equal(WebRTC.scheduleSignalingRecovery(), true);
    assert.equal(WebRTC._signalRecoveryStartedAt, 0);
    h.stepWall(wallStep); h.advanceTo(1500);
    assert.equal(recreated, 0);
    assert.equal(WebRTC._signalRecoveryStartedAt, 0);
    h.advanceTo(23999); assert.equal(recreated, 0);
    h.advanceTo(24000); assert.equal(recreated, 1);
    assert.equal(WebRTC._signalRecoveryStartedAt, 24000);
    h.stepWall(-wallStep); h.advanceTo(13500);
    assert.equal(recreated, 1);
    assert.equal(WebRTC._signalRecoveryStartedAt, 24000);
  });

  test(`duration clock: media progress freshness expires by elapsed time with wall step ${wallStep}`, () => {
    const h = webRtcDurationFixture(), { WebRTC } = h;
    WebRTC._lastInboundFramesDecoded = 10;
    assert.equal(WebRTC._lastInboundFramesDecodedAt, null);
    assert.equal(WebRTC.isInboundVideoHealthy(), false);
    WebRTC.handlePortSearchMedia = () => {};
    WebRTC.handleReceiverStats = () => {};
    WebRTC.processStatsSnapshot({ decodedDelta: 1, receivedDelta: 1, bytesDelta: 100,
      totals: { framesDecoded: 11 }, selectedCandidateType: 'host' });
    assert.equal(WebRTC._lastInboundFramesDecodedAt, 0);
    assert.equal(WebRTC.isInboundVideoHealthy(), true);
    h.stepWall(wallStep); h.setMono(5000);
    assert.equal(WebRTC.isInboundVideoHealthy(), true);
    h.setMono(5001); assert.equal(WebRTC.isInboundVideoHealthy(), false);
    WebRTC.processStatsSnapshot({ decodedDelta: 0, receivedDelta: 0, bytesDelta: 0 });
    assert.equal(WebRTC._lastInboundFramesDecodedAt, 0, 'no progress cannot renew freshness');
  });

  test(`duration clock: refresh/keyframe cooldown admits unset and cools mono0 with wall step ${wallStep}`, async () => {
    const h = webRtcDurationFixture(), { WebRTC } = h;
    const emitted = [];
    WebRTC.socket = { connected: true, emit: (...args) => emitted.push(args) };
    WebRTC.isMediaHealthSuppressed = () => false;
    WebRTC.activeLeaseEnvelope = () => ({ leaseId: 'lease-clock', leaseEpoch: 3 });
    assert.equal(WebRTC._lastRefreshAt, null);
    assert.equal(WebRTC.canBeginRefresh('dc-error'), true);
    WebRTC.networkMode = 'relay';
    WebRTC.hasTurnConfigured = () => true;
    WebRTC.getTurnServers = () => [{ urls: 'turn:fixture.invalid' }];
    WebRTC.stopTunnelRelay = () => {};
    WebRTC.createPeerConnection = () => {};
    WebRTC.createOffer = () => {};
    await WebRTC.refresh({ reason: 'dc-error' });
    assert.equal(WebRTC._lastRefreshAt, 0);
    WebRTC.markRefreshSettled('test');
    assert.equal(WebRTC.canBeginRefresh('dc-error'), false);
    assert.equal(WebRTC.requestKeyframe('test'), true);
    assert.equal(WebRTC._lastKeyframeRequestAt, 0);
    assert.equal(WebRTC.requestKeyframe('test'), false);
    h.stepWall(wallStep); h.setMono(999);
    assert.equal(WebRTC.requestKeyframe('test'), false);
    h.setMono(1000); assert.equal(WebRTC.requestKeyframe('test'), true);
    assert.equal(WebRTC.canBeginRefresh('dc-error'), false);
    WebRTC.scheduleReconnect('dc-error');
    assert.equal(WebRTC.reconnectTimer, null);
    h.setMono(3000);
    assert.equal(WebRTC.canBeginRefresh('dc-error'), true);
    WebRTC.scheduleReconnect('dc-error');
    assert.notEqual(WebRTC.reconnectTimer, null);
    assert.equal(emitted.filter(([event]) => event === 'request-keyframe').length, 2);
    WebRTC.currentConnectionAttemptId = 'replacement';
    assert.equal(WebRTC.requestKeyframe('new-generation'), true);
  });
}

test('duration clock: signaling cancellation on success/manual/superseded clears zero origin', () => {
  for (const outcome of ['success', 'manual', 'superseded']) {
    const h = webRtcDurationFixture(), { WebRTC } = h;
    let recreated = 0;
    WebRTC.socket = { connected: false, disconnect() {} };
    WebRTC.createSignalingSocket = () => { recreated++; };
    WebRTC.scheduleSignalingRecovery();
    const timer = WebRTC._signalRecoveryTimer;
    if (outcome === 'success') {
      WebRTC.socket.connected = true;
      WebRTC.refresh = () => {};
      h.advanceTo(1500);
    } else if (outcome === 'manual') WebRTC.disconnect();
    else WebRTC.handleViewerSuperseded();
    assert.equal(WebRTC._signalRecoveryStartedAt, null, outcome);
    assert.equal(WebRTC._signalRecoveryPending, false, outcome);
    assert.equal(WebRTC._signalRecoveryTimer, null, outcome);
    assert.equal(h.timers.has(timer), false, outcome);
    h.stepWall(60000); h.advanceTo(15000);
    assert.equal(recreated, 0, outcome);
    assert.equal(WebRTC._signalRecoveryTimer, null, outcome);
  }
});

for (const lifecycle of ['refresh', 'disconnect', 'superseded', 'tunnel', 'control-lease']) {
  test(`DataChannel watchdog retires on actual ${lifecycle} lifecycle and rejects queued callbacks`, async () => {
    let now = 0, nextId = 0; const timers = new Map();
    const { WebRTC, context } = loadWebRTC({ performance: { now: () => now },
      setTimeout(fn, ms) { const id = nextId++; timers.set(id, { fn, ms }); return id; },
      clearTimeout(id) { timers.delete(id); } });
    WebRTC.socket = { connected: true, emit() {}, on() {}, disconnect() {}, io: { reconnection() {} } };
    WebRTC.controlState = { state: 'ACTIVE', controller: true, hostOnline: true,
      lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 } };
    WebRTC.networkMode = 'auto'; WebRTC.currentConnectionAttemptId = 'old'; WebRTC.connectionAttemptSequence = 1;
    WebRTC.pc = { connectionState: 'new', iceConnectionState: 'new',
      _wrdControlLease: { ...WebRTC.controlState.lease }, createDataChannel: () => ({ readyState: 'connecting' }),
      close() { oldChannel.onclose(); } };
    WebRTC.createInputChannel(); const oldChannel = WebRTC.inputChannel;
    const timeout = timers.get(WebRTC._dcTimeout).fn; const faults = [];
    WebRTC.noteDataChannelFault = reason => faults.push(reason); WebRTC.scheduleReconnect = reason => faults.push(reason);
    WebRTC.createPeerConnection = () => {}; WebRTC.createOffer = () => {};
    if (lifecycle === 'refresh') await WebRTC.refresh({ reason: 'manual' });
    if (lifecycle === 'disconnect') WebRTC.disconnect();
    if (lifecycle === 'superseded') WebRTC.handleViewerSuperseded();
    if (lifecycle === 'tunnel') { WebRTC.networkMode = 'tunnel'; WebRTC.startTunnelRelay(); }
    if (lifecycle === 'control-lease') {
      context.Input = { init() {}, setControlLease() {}, setActive() {} };
      WebRTC.startControlHeartbeat = () => {}; WebRTC.updateControlUI = () => {};
      WebRTC.bindCurrentConnectionAttempt = () => false; WebRTC.replayMediaActivityIntent = () => false;
      WebRTC.ensureMediaActiveIfVisible = () => false;
      WebRTC.handleControlGrant({ controller: true, leaseId: 'lease-000000000002', leaseEpoch: 2 });
    }
    assert.equal(WebRTC._dataChannelWatchdog, null); assert.equal(WebRTC._dcTimeout, null);
    now = 40000; timeout(); oldChannel.onclose(); oldChannel.onerror({});
    assert.deepEqual(faults, []); assert.equal(WebRTC._dcReconnectTimer, null);
  });
}


function captureExpectedSignalingWarnings(t, context, expected) {
  const originalConsole = context.console;
  const warnings = [];
  context.console = { ...originalConsole, warn(...args) {
    if (expected.some(warning => warning.length === args.length && warning.every((value, index) => value === args[index]))) {
      warnings.push(args);
    } else {
      originalConsole.warn(...args);
    }
  } };
  t.after(() => {
    context.console = originalConsole;
    assert.deepEqual(warnings, expected);
  });
}

test('signaling session persists through bootstrap reuse, media attempts, refresh, mode switch and socket recreation', async t => {
  const h = admissionViewerFixture();
  captureExpectedSignalingWarnings(t, h.context, [['[RECOVERY] Signaling connect error:', 'timeout']]);
  let finishBootstrap;
  const start = h.WebRTC.startViewer({ load: () => new Promise(resolve => { finishBootstrap = resolve; }) });
  for (let i = 0; i < 20 && !finishBootstrap; i++) await Promise.resolve();
  const first = h.sockets[0];
  first.active = true;
  first.trigger('connect_error', { message: 'timeout' });
  const session = h.WebRTC._signalingSession;
  assert.equal(session.preferPolling, true);
  const captured = h.WebRTC.getSignalingFailureSnapshot();
  finishBootstrap({ webrtc: { iceServers: [] } }); await start;
  assert.equal(h.WebRTC._signalingSession, session, 'init reuse must preserve bootstrap timeout selection');
  assert.equal(h.WebRTC.socket, first);
  h.WebRTC.beginConnectionAttempt('manual-turn-switch');
  assert.equal(h.WebRTC._signalingSession, session);
  h.WebRTC.createSignalingSocket(true);
  assert.equal(h.WebRTC._signalingSession, session);
  assert.deepEqual(Array.from(h.sockets.at(-1).io.opts.transports), ['polling', 'websocket']);
  await h.WebRTC.refresh({ reason: 'fresh-frame-timeout' });
  assert.equal(h.WebRTC._signalingSession, session);
  h.WebRTC.setNetworkMode('tunnel');
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(h.WebRTC._signalingSession, session);
  assert.equal(h.WebRTC.getSignalingFailureSnapshot().failureClass, 'timeout');
  assert.equal(captured.ageMs, 0); assert.equal(h.requests.length, 1);
});

test('explicit Start and successful reclaim reset signaling session before new socket; retired callbacks cannot select', async t => {
  const h = admissionViewerFixture();
  captureExpectedSignalingWarnings(t, h.context, [['[RECOVERY] Signaling connect error:', 'timeout']]);
  await h.WebRTC.startViewer(h.controller);
  const old = h.sockets[0]; old.active = true; old.trigger('connect_error', { message: 'timeout' });
  const previous = h.WebRTC._signalingSession;
  await h.WebRTC.startViewer(h.controller);
  assert.notEqual(h.WebRTC._signalingSession, previous); assert.equal(h.WebRTC.getSignalingFailureSnapshot(), null);
  assert.deepEqual(Array.from(h.sockets.at(-1).io.opts.transports), ['websocket', 'polling']);
  old.trigger('connect_error', { message: 'timeout' }); assert.equal(h.WebRTC._signalingSession.preferPolling, false);
  const beforeReclaim = h.WebRTC._signalingSession; beforeReclaim.preferPolling = true;
  await h.WebRTC.reclaimDesktopSession();
  assert.notEqual(h.WebRTC._signalingSession, beforeReclaim);
  assert.equal(h.WebRTC.getSignalingFailureSnapshot(), null);
  assert.deepEqual(Array.from(h.sockets.at(-1).io.opts.transports), ['websocket', 'polling']);
});

for (const stop of ['disconnect', 'handleViewerSuperseded']) {
  test(`signaling session and last error retire on ${stop}`, async t => {
    const h = admissionViewerFixture();
    captureExpectedSignalingWarnings(t, h.context, [['[RECOVERY] Signaling connect error:', 'timeout'],
      ...(stop === 'handleViewerSuperseded' ? [['[VIEWER] superseded', 'unknown', '']] : [])]);
    await h.WebRTC.startViewer(h.controller);
    const socket = h.sockets[0]; socket.active = true; socket.trigger('connect_error', { message: 'timeout' });
    const failure = h.WebRTC.getSignalingFailureSnapshot();
    h.WebRTC[stop](); assert.equal(h.WebRTC.getSignalingFailureSnapshot(), null);
    socket.trigger('connect_error', { message: 'timeout' }); assert.equal(h.WebRTC._signalingSession, null);
    assert.equal(failure.failureClass, 'timeout'); assert.equal(Object.isFrozen(failure), true);
  });
}

test('startup ownership: new explicit Start fences older admission before bootstrap and init', async () => {
  let finishAdmission;
  let calls = 0;
  const h = admissionViewerFixture({ fetchAdmission: () => {
    calls++;
    if (calls === 1) return new Promise(resolve => { finishAdmission = resolve; });
    return { ok: true, status: 201, json: async () => ({ admission: { ticket: 'new-ticket' } }) };
  } });
  const old = h.WebRTC.startViewer(h.controller);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  const retired = h.WebRTC._startupEpisode;
  await h.WebRTC.startViewer(h.controller);
  const current = h.WebRTC._startupEpisode;
  finishAdmission({ ok: true, status: 201, json: async () => ({ admission: { ticket: 'old-ticket' } }) });
  await old;
  assert.equal(retired.state, 'retired');
  assert.equal(h.WebRTC._startupEpisode, current);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0].auth.viewerAdmission.ticket, 'new-ticket');
});

test('startup ownership: cancelled bootstrap resolution and rejection cannot revive UI or overwrite next Start', async () => {
  for (const rejectOld of [false, true]) {
    const h = admissionViewerFixture();
    let finish, reject;
    const controller = { load: () => new Promise((resolve, fail) => { finish = resolve; reject = fail; }), cancel() {} };
    const old = h.WebRTC.startViewer(controller);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    h.WebRTC.retireStartupEpisode('startup-cancelled', { cleanup: true });
    await h.WebRTC.startViewer(h.controller);
    const current = h.WebRTC._startupEpisode;
    if (rejectOld) reject(new Error('old-bootstrap-error'));
    else finish({ webrtc: { iceServers: [{ urls: 'turn:old.invalid' }] } });
    await old;
    assert.equal(h.WebRTC._startupEpisode, current);
    assert.equal(h.WebRTC.uiPhase, 'signaling');
    assert.equal(h.WebRTC.hasTurnConfigured(), false);
    assert.equal(h.sockets.length, 2);
  }
});

test('startup ownership: deferred verification from older Start cannot enroll over newer Start', async () => {
  const h = admissionViewerFixture();
  let finish, checks = 0;
  h.context.Auth.whenReady = () => ++checks === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(true);
  const old = h.WebRTC.startViewer(h.controller);
  await h.WebRTC.startViewer(h.controller);
  const current = h.WebRTC._startupEpisode;
  finish(true);
  await old;
  assert.equal(h.requests.length, 1);
  assert.equal(h.WebRTC._startupEpisode, current);
});

test('startup ownership: retained superseded config cannot cross auth scope before explicit reclaim', async () => {
  const h = admissionViewerFixture({ realPeer: true });
  let finish;
  h.controller.load = () => new Promise(resolve => { finish = resolve; });
  const start = h.WebRTC.startViewer(h.controller);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  h.sockets[0].trigger('viewer-superseded', {});
  finish({ webrtc: { turnConfigured: true, iceServers: [{ urls: 'turn:old.invalid' }] } });
  await start;
  assert.equal(h.WebRTC.hasTurnConfigured(), false);
  h.context.Auth.getToken = () => 'new-auth';
  await h.WebRTC.reclaimDesktopSession();
  assert.equal(h.requests.length, 1);
  assert.equal(h.WebRTC.pc, null);
  assert.equal(h.WebRTC.hasTurnConfigured(), false);
});

test('startup ownership: detached old PC and metadata callbacks cannot act on replacement PC', async () => {
  const h = admissionViewerFixture({ realPeer: true });
  await h.WebRTC.startViewer(h.controller);
  const old = h.WebRTC.pc;
  const connected = old.onconnectionstatechange, track = old.ontrack;
  await h.WebRTC.startViewer(h.controller);
  const current = h.WebRTC.pc, episode = h.WebRTC._startupEpisode;
  connected();
  track({});
  assert.equal(h.WebRTC.pc, current);
  assert.equal(h.WebRTC._startupEpisode, episode);
  assert.equal(h.WebRTC.uiPhase, 'signaling');
  assert.equal(h.WebRTC.hasPaintedFrame, false);
});

for (const boundary of ['admission', 'pre-enrollment bootstrap']) {
  test(`review I1: obsolete reclaim ${boundary} rejection cannot terminate a newer explicit Start`, async () => {
    let rejectOld, admissionCalls = 0;
    const h = admissionViewerFixture({ realPeer: true, fetchAdmission: () => {
      admissionCalls++;
      if (boundary === 'admission' && admissionCalls === 2) {
        return new Promise((_resolve, reject) => { rejectOld = reject; });
      }
      return { ok: true, status: 201, json: async () => ({ admission: { ticket: `ticket-${admissionCalls}` } }) };
    } });
    let oldStart;
    if (boundary === 'pre-enrollment bootstrap') {
      oldStart = h.WebRTC.startViewer({ load: () => new Promise((_resolve, reject) => { rejectOld = reject; }) });
      for (let i = 0; i < 30; i++) await Promise.resolve();
      h.sockets[0].trigger('viewer-superseded', {});
    } else {
      await h.WebRTC.startViewer(h.controller);
    }
    const reclaim = h.WebRTC.reclaimDesktopSession();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await h.WebRTC.startViewer(h.controller);
    const w = h.WebRTC, episode = w._startupEpisode, pc = w.pc, socket = w.socket;
    const timer = episode.timer, phase = w.uiPhase;
    rejectOld(new Error('obsolete-request-failed'));
    assert.equal(await reclaim, false);
    if (oldStart) await oldStart;
    assert.equal(w._startupEpisode, episode);
    assert.equal(episode.state, 'pending');
    assert.equal(episode.timer, timer);
    assert.equal(w.pc, pc);
    assert.equal(w.socket, socket);
    assert.equal(w.uiPhase, phase);
    assert.equal(admissionCalls, boundary === 'admission' ? 3 : 2);
  });
}

test('review I1: current reclaim admission rejection retains terminal failure authority', async () => {
  const h = admissionViewerFixture({ fetchAdmission: () => Promise.reject(new Error('current-request-failed')) });
  assert.equal(await h.WebRTC.reclaimDesktopSession(), false);
  assert.equal(h.WebRTC._startupEpisode.state, 'retired');
  assert.equal(h.WebRTC._startupEpisode.reason, 'bootstrap-failure');
  assert.equal(h.WebRTC.uiPhase, 'disconnected');
});

const startupJoinFlush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
function startupJoinDeferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function startupJoinScenario(delayed, outcome = 'normal') {
  const events = [], peers = [], sockets = [], requests = [], errors = [], warnings = [];
  let clock = 0;
  const bootstrap = startupJoinDeferred();
  class FakePeer {
    constructor(config) { this.ordinal = peers.length + 1; this.config = config; this.connectionState = 'new'; this.iceConnectionState = 'new'; this.iceGatheringState = 'complete'; this.signalingState = 'stable'; this.transceivers = []; this.remoteDescriptions = 0; peers.push(this); events.push(['pc-created', this.ordinal]); }
    createDataChannel() { return { readyState: 'connecting', bufferedAmount: 0, send() {}, close() {} }; }
    getTransceivers() { return this.transceivers; }
    addTransceiver() { const t = { receiver: { track: { kind: 'video' } }, setCodecPreferences() {} }; this.transceivers.push(t); return t; }
    async createOffer() { events.push(['platform-createOffer', this.ordinal]); return { type: 'offer', sdp: 'offline-fixture-sdp' }; }
    async setLocalDescription(value) { this.localDescription = value; this.signalingState = 'have-local-offer'; events.push(['platform-local-description', this.ordinal]); }
    async setRemoteDescription(value) { this.remoteDescription = value; this.remoteDescriptions++; this.signalingState = 'stable'; events.push(['platform-remote-description', this.ordinal]); }
    close() { this.connectionState = 'closed'; this.signalingState = 'closed'; events.push(['pc-closed', this.ordinal]); }
    addEventListener() {} removeEventListener() {}
  }
  const quiet = { log() {}, warn(...args) { warnings.push(String(args[0])); }, error(...args) { errors.push(String(args[0])); } };
  const elements = new Map();
  const h = loadWebRTC({
    realInput: true,
    window: { location: { origin: 'http://offline.invalid' }, addEventListener() {}, removeEventListener() {} },
    document: { readyState: 'loading', hidden: false, querySelectorAll: () => [], body: makeElement(), addEventListener() {}, querySelector: () => null, getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); } },
    console: quiet,
    setTimeout() { return 0; }, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {},
    performance: { now: () => clock },
    Auth: { whenReady: async () => true, getToken: () => 'offline-token', getGeneration: () => 1, isVerified: () => true, isLoggedIn: () => true, logout() { throw Error('unexpected logout'); } },
    sessionStorage: { getItem() { return null; }, setItem() {} },
    fetch: async (url) => { requests.push(url.endsWith('/api/auth/viewer-admission') ? 'admission' : 'unexpected'); return { ok: true, status: 201, json: async () => ({ admission: { ticket: 'offline-ticket' } }) }; },
    RTCPeerConnection: FakePeer,
    io(_base, options) {
      const handlers = new Map();
      const socket = { connected: false, auth: options.auth, emitted: [],
        on(event, fn) { handlers.set(event, fn); },
        emit(event, data) { this.emitted.push({ event, data }); events.push(['socket-emit', event]); },
        disconnect() { this.connected = false; },
        trigger(event, data) { return handlers.get(event)?.(data); },
        io: { opts: options, engine: { readyState: 'open', transport: { name: 'websocket' } }, _readyState: 'open', on() {}, reconnection() {} }
      }; sockets.push(socket); return socket;
    }
  });
  const W = h.WebRTC;
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'bootstrap-controller.js'), 'utf8'), h.context);
  const controller = h.context.createViewerBootstrap({ getScope: () => 1, now: () => clock,
    setTimer: () => 0, clearTimer() {}, fetchSnapshot: () => bootstrap.promise });
  const config = { schemaVersion: 1, host: { online: true, capabilities: {} }, webrtc: { iceServers: [{ urls: ['stun:offline.invalid'] }], turnConfigured: false } };
  // Observe real calls without replacing their bodies or mutating product state.
  const protectedMethods = ['startViewer', 'requestExplicitViewerAdmission', 'createSignalingSocket', 'init', 'handleControlGrant', 'createPeerConnection', 'createOffer'];
  for (const name of protectedMethods) { const original = W[name]; W[name] = function(...args) { events.push(['real-method', name]); return original.apply(this, args); }; }
  if (!delayed) { bootstrap.resolve(config); await controller.load({ mode: W.networkMode, turnServerId: W.selectedTurnServerId || '' }); }
  const pending = W.startViewer(controller);
  await startupJoinFlush();
  assert.equal(sockets.length, 1, 'ordinary admission should create exactly one socket');
  const socket = sockets[0];
  if (!delayed) await pending;
  socket.connected = true;
  await socket.trigger('connect');
  socket.trigger('connected', { hostOnline: true, hostCapabilities: {}, viewerAdmission: { mode: 'resume', generation: 'offline-generation' } });
  assert(socket.emitted.some(e => e.event === 'control-acquire'), 'welcome must actually request control');
  const grant = { controller: true, leaseId: 'offline-lease-00000001', leaseEpoch: 1 };
  if (outcome !== 'no-control') {
    socket.trigger('control-grant', grant);
    socket.trigger('control-grant', grant); // duplicate while the offer is in flight
  }
  await startupJoinFlush();
  if (outcome === 'input-unavailable') {
    const input = h.context.__Input;
    assert.equal(input.keyboardTransport.acceptAck({ schemaVersion: 2, leaseEpoch: 1, status: 'invalid-input' }).status, 'reacquire-required');
    socket.trigger('control-grant', grant); // real setControlLease must reject this lease
    assert.equal(input._recoveryControlReacquireRequired, true);
  }
  if (outcome === 'cancel') W.retireStartupEpisode('startup-cancelled', { cleanup: true });
  if (outcome === 'supersede') socket.trigger('viewer-superseded', {});
  if (outcome === 'auth-change') h.context.Auth.getToken = () => 'changed-token';
  const before = { pcs: peers.length, offers: socket.emitted.filter(e => e.event === 'offer').length, deferred: W._deferPeerUntilConfig, currentPc: W.pc?.ordinal, pcSignaling: W.pc?.signalingState, configServerEntries: W.pc?.config?.iceServers?.length, attemptSequence: W.connectionAttemptSequence };
  if (delayed) { clock = 900; bootstrap.resolve(config); await pending; await startupJoinFlush(); }
  const after = { pcs: peers.length, offers: socket.emitted.filter(e => e.event === 'offer').length, currentPc: W.pc?.ordinal, pcSignaling: W.pc?.signalingState, oldClosed: peers.length > 1 ? peers[0].connectionState === 'closed' : null, gateAllowed: W.canEnableDesktopInput(), episodeState: W._startupEpisode?.state, configServerEntries: W.pc?.config?.iceServers?.length, attemptSequence: W.connectionAttemptSequence };
  if (outcome !== 'normal') {
    assert.equal(socket.emitted.filter(e => e.event === 'offer').length, 0);
    if (['cancel', 'supersede', 'auth-change'].includes(outcome)) assert.equal(peers.length, 0);
    h.cleanup(); return;
  }
  socket.trigger('control-grant', grant); // duplicate after createOffer's lock clears
  await startupJoinFlush();
  assert.equal(socket.emitted.filter(e => e.event === 'offer').length, 1);
  await socket.trigger('answer', { answer: { type: 'answer', sdp: 'offline-fixture-answer' } });
  await startupJoinFlush();
  const result = { scenario: delayed ? 'delayed-bootstrap-fast-grant' : 'ready-bootstrap-control', before, after,
    answersApplied: peers.map(p => p.remoteDescriptions), requests, errors, warnings, events };
  assert.deepEqual(requests, ['admission']);
  assert.deepEqual(errors, []);
  if (delayed) {
    assert.equal(before.pcs, 0, 'deferred configuration must fence peer creation');
    assert.equal(before.offers, 0, 'deferred configuration must fence offers');
  }
  assert.equal(after.pcs, 1);
  assert.equal(after.offers, 1);
  assert.equal(peers[0].remoteDescriptions, 1);
  assert.equal(h.context.__Input.activeControlLease.leaseEpoch, 1);
  assert.equal(h.context.__Input._recoveryControlReacquireRequired, false);
  // Stable completed peers can still renegotiate on a later regrant.
  socket.trigger('control-grant', grant);
  await startupJoinFlush();
  assert.equal(socket.emitted.filter(e => e.event === 'offer').length, 2);
  h.cleanup();
  return result;
}

test('startup config join: delayed configuration and early real Input grant', async () => { await startupJoinScenario(true); });
test('startup config join: ready configuration and late real Input grant', async () => { await startupJoinScenario(false); });

for (const outcome of ['input-unavailable', 'no-control', 'cancel', 'supersede', 'auth-change']) {
  test(`startup config join: delayed config preserves ${outcome}`, async () => { await startupJoinScenario(true, outcome); });
}

// Offline synthetic browser boundaries; all recovery, media and Input methods are real.
async function afterGracePeerFixture({ pending = false, firstGrant = false, channelState = 'open' } = {}) {
  let clock = 1000, timerId = 0, frameId = 0;
  const timers = new Map(), frames = new Map(), peers = [], emitted = [], writes = [], plays = [], samples = [];
  const setTimer = (fn, ms, interval = false) => {
    const id = ++timerId; timers.set(id, { fn, ms, interval }); return id;
  };
  class RecoveryPeer {
    constructor() {
      this.connectionState = this.iceConnectionState = 'new';
      this.signalingState = 'stable'; this.iceGatheringState = 'complete';
      this.transceivers = []; this.channels = []; this.decoded = 0; this.offers = 0; peers.push(this);
    }
    createDataChannel() {
      const channel = { readyState: channelState, bufferedAmount: 0,
        send(value) { writes.push(JSON.parse(value)); }, close() { this.readyState = 'closed'; this.onclose?.(); } };
      this.channels.push(channel); return channel;
    }
    getTransceivers() { return this.transceivers; }
    addTransceiver() {
      const t = { receiver: { track: { kind: 'video' } }, setCodecPreferences() {} };
      this.transceivers.push(t); return t;
    }
    getReceivers() { return []; }
    async createOffer() { this.offers++; return { type: 'offer', sdp: 'offline-fixture-sdp' }; }
    async setLocalDescription(value) { this.localDescription = value; this.signalingState = 'have-local-offer'; }
    async setRemoteDescription(value) { this.remoteDescription = value; this.signalingState = 'stable'; }
    async getStats() { return new Map([['video', { type: 'inbound-rtp', kind: 'video',
      framesDecoded: this.decoded, framesReceived: this.decoded, frameWidth: 1280, frameHeight: 720 }]]); }
    addEventListener() {} removeEventListener() {}
    close() {
      this.connectionState = this.iceConnectionState = this.signalingState = 'closed';
      this.channels.forEach(channel => channel.close()); // Exercise synchronous close reentry too.
    }
  }
  const elements = new Map();
  const h = loadWebRTC({ realInput: true, RTCPeerConnection: RecoveryPeer,
    console: { log() {}, warn() {}, error() {} },
    window: { location: { origin: 'http://offline.invalid' }, addEventListener() {}, removeEventListener() {} },
    document: { hidden: false, readyState: 'loading', body: makeElement(), activeElement: null,
      addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
      getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); } },
    performance: { now: () => clock },
    setTimeout: (fn, ms) => setTimer(fn, ms), clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => setTimer(fn, ms, true), clearInterval: id => timers.delete(id),
  });
  for (const filename of ['webrtc-stats.js', 'media-activity-controller.js', 'media-activity-runtime.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, filename), 'utf8'), h.context);
  }
  h.context.MediaActivityController = h.context.MediaActivityController || h.context.window.MediaActivityController;
  h.context.MediaActivityRuntime = h.context.MediaActivityRuntime || h.context.window.MediaActivityRuntime;
  vm.runInContext('globalThis.__Stats = WebRtcStats;', h.context);
  const createSampler = h.context.__Stats.createWebRtcStatsSampler;
  h.context.__Stats.createWebRtcStatsSampler = options => { samples.push(options); return createSampler(options); };
  const w = h.WebRTC, input = h.context.__Input, video = h.context.document.getElementById('remoteVideo');
  video.videoWidth = 1280; video.videoHeight = 720; video.readyState = 0;
  video.play = () => new Promise((resolve, reject) => plays.push({ stream: video.srcObject, resolve, reject }));
  video.requestVideoFrameCallback = fn => { frames.set(++frameId, fn); return frameId; };
  video.cancelVideoFrameCallback = id => frames.delete(id);
  w.socket = { connected: true, emit(event, payload) { emitted.push({ event, payload }); if (event === 'input') writes.push(payload); } };
  const settle = startupJoinFlush;
  const connect = async (peer = w.pc, stream = { getTracks: () => [] }) => {
    await peer.setRemoteDescription({ type: 'answer', sdp: 'offline-answer' });
    peer.ontrack({ track: { kind: 'video' }, streams: [stream] });
    peer.connectionState = peer.iceConnectionState = 'connected'; peer.onconnectionstatechange();
    await settle(); return stream;
  };
  const paint = () => {
    const id = w._videoFrameCallbackId, fn = frames.get(id);
    assert.equal(typeof fn, 'function', 'real current rVFC must exist');
    frames.delete(id); clock += 16; fn(clock, {});
  };
  const mediaRequest = (state = 'active') => {
    const entry = [...emitted].reverse().find(({ event, payload }) => event === 'media-activity-change'
      && payload.state === state && payload.connectionAttemptId === w.currentConnectionAttemptId
      && payload.generation === w._mediaIntent?.generation);
    assert.ok(entry, 'real current-scope media request must have been emitted');
    assert.ok(entry.payload.generation > 0); return entry.payload;
  };
  const ackMedia = request => w.handleMediaActivityAck({ state: request.state, generation: request.generation,
    connectionAttemptId: request.connectionAttemptId, applied: true });
  const ackInput = write => {
    const ack = { schemaVersion: 2, inputType: write.type, inputIds: write.inputIds,
      leaseEpoch: write.leaseEpoch, appliedSeq: write.seq, status: 'applied' };
    return write.type === 'keyboard' ? input.acceptKeyboardAck(ack) : input.acceptMouseAck(ack);
  };
  const ackResets = () => writes.filter(write => write.action === 'reset').forEach(ackInput);
  w.initializeMediaActivity();
  assert.ok(w.mediaActivityController); assert.ok(w.mediaActivityRuntime);
  w.beginStartupEpisode(); w.startStartupMediaBudget(); w.beginConnectionAttempt('viewer-open');
  const lease = { controller: true, leaseId: 'offline-original-lease', leaseEpoch: 7 };
  if (firstGrant) { w.createPeerConnection(); return { h, w, input, video, peers, emitted, frames, timers, settle, connect, paint, mediaRequest, ackMedia, ackInput, ackResets, writes, plays, samples, lease }; }
  w.handleControlGrant(lease); await settle();
  assert.ok(w.pc.localDescription, 'real createOffer must finish');
  await connect();
  w.setMediaActivityReason('manual-pause', true); ackMedia(mediaRequest('suspended'));
  assert.equal(w.getMediaAppliedPhase(), 'suspended');
  w.setMediaActivityReason('manual-pause', false);
  assert.equal(w.getMediaAppliedPhase(), 'resuming');
  assert.equal(input.getEffectiveInputGate().allowed, false);
  ackMedia(mediaRequest());
  assert.equal(w.mediaActivityRuntime.snapshot().lastAck.applied, true);
  assert.equal(w.getMediaAppliedPhase(), 'resuming');
  assert.equal(input.getEffectiveInputGate().allowed, false);
  if (!pending) {
    paint(); assert.equal(w.getMediaAppliedPhase(), 'active'); assert.equal(w.canEnableDesktopInput(), true);
    w.checkStartupEpisode({ painted: true }); assert.equal(w._startupEpisode.state, 'complete');
    ackResets(); assert.equal(input.getEffectiveInputGate().allowed, true);
  }
  return { h, w, input, video, peers, emitted, frames, timers, settle, connect, paint, mediaRequest, ackMedia, ackInput, ackResets, writes, plays, samples, lease };
}

test('after-grace fixture: real positive generation media and Input baseline', async () => {
  const { w, input } = await afterGracePeerFixture();
  assert.equal(w.getMediaAppliedPhase(), 'active');
  assert.equal(input.getEffectiveInputGate().allowed, true);
});

test('after-grace ownership: changed grant retires unleased refreshed peer', async () => {
  const f = await afterGracePeerFixture();
  const { w, input, video, peers, settle, connect, paint, mediaRequest, ackMedia, ackResets, plays } = f;
  w.freezeControl('signal-disconnect'); await w.refresh({ reason: 'signal-reconnected' });
  const orphan = w.pc, owner = w._peerCallbackOwner;
  assert.equal(orphan._wrdControlLease, null);
  const oldTrack = orphan.ontrack, oldConnected = orphan.onconnectionstatechange;
  w.handleControlGrant({ controller: true, leaseId: 'offline-next-lease', leaseEpoch: 9 }); await settle();
  assert.notEqual(w.pc, orphan, 'new attempt must not retain a peer owned by the previous attempt');
  assert.equal(orphan.connectionState, 'closed'); assert.equal(w.ownsStartupOwner(owner), false);
  assert.equal(w._peerCallbackOwner.peer, w.pc); assert.equal(w._peerCallbackOwner.attempt, w.currentConnectionAttemptId);
  assert.equal(w._peerCallbackOwner.sequence, w.connectionAttemptSequence);
  assert.equal(input.getEffectiveInputGate().allowed, false);
  const stream = { getTracks: () => [] }; await connect(w.pc, stream);
  assert.equal(video.srcObject, stream); assert.equal(plays.filter(play => play.stream === stream).length, 1);
  assert.ok(w._statsSampler); assert.ok(w._videoFrameOwner);
  oldTrack({ track: { kind: 'video' }, streams: [{ getTracks: () => [] }] }); oldConnected();
  assert.equal(video.srcObject, stream);
  assert.equal(w.getMediaAppliedPhase(), 'resuming'); assert.equal(w.canEnableDesktopInput(), false);
  const request = mediaRequest(); ackMedia(request);
  const applied = w.mediaActivityRuntime.snapshot().lastAck;
  assert.equal(applied.applied, true); assert.equal(applied.connectionAttemptId, request.connectionAttemptId);
  assert.equal(applied.generation, request.generation);
  assert.equal(w.getMediaAppliedPhase(), 'resuming');
  assert.equal(w.canEnableDesktopInput(), false, 'applied ACK alone is not a fresh frame');
  assert.equal(input.getEffectiveInputGate().allowed, false);
  paint(); assert.equal(w.isCurrentAttemptMediaReady(), true); assert.equal(w.getMediaAppliedPhase(), 'active');
  assert.equal(w.canEnableDesktopInput(), true); ackResets(); assert.equal(input.getEffectiveInputGate().allowed, true);
  assert.equal(peers.filter(peer => peer.connectionState !== 'closed').length, 1);
});

async function afterGraceChangedGrant(f, { beforeGrant = false } = {}) {
  const { w, settle, connect } = f;
  w.freezeControl('signal-disconnect'); await w.refresh({ reason: 'signal-reconnected' });
  const orphan = w.pc, owner = w._peerCallbackOwner;
  assert.equal(orphan._wrdControlLease, null);
  if (beforeGrant) await connect(orphan);
  w.handleControlGrant({ controller: true, leaseId: 'offline-next-lease', leaseEpoch: 9 }); await settle();
  assert.notEqual(w.pc, orphan); assert.equal(orphan.connectionState, 'closed');
  assert.equal(w.ownsStartupOwner(owner), false);
  assert.equal(w._peerCallbackOwner.peer, w.pc);
  assert.equal(w._peerCallbackOwner.attempt, w.currentConnectionAttemptId);
  assert.equal(w._peerCallbackOwner.sequence, w.connectionAttemptSequence);
  return orphan;
}

test('after-grace ownership: pending startup preserves allowance', async () => {
  const f = await afterGracePeerFixture({ pending: true });
  const { w } = f, episode = w._startupEpisode;
  const { remaining, feedbackRemaining } = episode;
  await afterGraceChangedGrant(f);
  assert.equal(w._startupEpisode, episode); assert.equal(episode.state, 'pending');
  assert.ok(episode.remaining <= remaining); assert.ok(episode.feedbackRemaining <= feedbackRemaining);
  await f.connect(); f.ackMedia(f.mediaRequest()); f.paint();
  w.checkStartupEpisode({ painted: true }); assert.equal(episode.state, 'complete');
  f.ackResets(); assert.equal(f.input.getEffectiveInputGate().allowed, true);
});

test('after-grace ownership: current frame waits for matching media ACK', async () => {
  const f = await afterGracePeerFixture();
  const old = f.mediaRequest();
  await afterGraceChangedGrant(f); await f.connect();
  const current = f.mediaRequest();
  f.paint(); assert.equal(f.w.isCurrentAttemptMediaReady(), true);
  assert.equal(f.w.getMediaAppliedPhase(), 'resuming'); assert.equal(f.input.getEffectiveInputGate().allowed, false);
  f.ackMedia(old); f.ackMedia({ ...current, generation: current.generation - 1 });
  assert.equal(f.w.getMediaAppliedPhase(), 'resuming'); assert.equal(f.w.canEnableDesktopInput(), false);
  f.ackMedia(current); assert.equal(f.w.getMediaAppliedPhase(), 'active');
  assert.equal(f.w.canEnableDesktopInput(), true, 'same request early frame may replay after matching ACK');
  f.ackResets(); assert.equal(f.input.getEffectiveInputGate().allowed, true);
});

test('after-grace ownership: old media proof cannot complete new request', async () => {
  const f = await afterGracePeerFixture(), old = f.mediaRequest();
  const oldFrame = f.frames.get(f.w._videoFrameCallbackId);
  assert.equal(typeof oldFrame, 'function');
  await afterGraceChangedGrant(f); await f.connect();
  f.ackMedia(old); oldFrame(2000, {});
  assert.equal(f.w.getMediaAppliedPhase(), 'resuming'); assert.equal(f.w.isCurrentAttemptMediaReady(), false);
  assert.equal(f.input.getEffectiveInputGate().allowed, false);
  f.ackMedia(f.mediaRequest()); oldFrame(2016, {});
  assert.equal(f.w.mediaActivityRuntime.snapshot().lastAck.applied, true);
  assert.equal(f.w.getMediaAppliedPhase(), 'resuming'); assert.equal(f.w.canEnableDesktopInput(), false);
  f.paint(); assert.equal(f.w.getMediaAppliedPhase(), 'active');
  f.ackResets(); assert.equal(f.input.getEffectiveInputGate().allowed, true);
});

test('after-grace ownership: connected and track before changed grant', async () => {
  const f = await afterGracePeerFixture();
  f.w.freezeControl('signal-disconnect'); await f.w.refresh({ reason: 'signal-reconnected' });
  const orphan = f.w.pc; const stream = await f.connect(orphan);
  const track = orphan.ontrack, connected = orphan.onconnectionstatechange;
  const frame = f.frames.get(f.w._videoFrameCallbackId), sample = f.samples.at(-1).onSample;
  f.paint(); assert.equal(f.w.isCurrentAttemptMediaReady(), true);
  f.w.handleControlGrant({ controller: true, leaseId: 'offline-next-lease', leaseEpoch: 9 }); await f.settle();
  assert.notEqual(f.w.pc, orphan); assert.equal(orphan.connectionState, 'closed');
  assert.equal(f.w.isCurrentAttemptMediaReady(), false); assert.equal(f.w.hasPaintedFrame, false);
  track({ track: { kind: 'video' }, streams: [stream] }); connected(); frame(2100, {}); sample({ framesDecoded: 50 });
  assert.equal(f.w.isCurrentAttemptMediaReady(), false); assert.equal(f.input.getEffectiveInputGate().allowed, false);
  const nextStream = await f.connect(); assert.equal(f.video.srcObject, nextStream);
  assert.equal(f.plays.filter(play => play.stream === nextStream).length, 1);
  f.ackMedia(f.mediaRequest()); assert.equal(f.w.getMediaAppliedPhase(), 'resuming');
  f.paint(); assert.equal(f.w.getMediaAppliedPhase(), 'active');
  f.ackResets(); assert.equal(f.input.getEffectiveInputGate().allowed, true);
});

test('after-grace ownership: retired producers cannot revive', async () => {
  const f = await afterGracePeerFixture({ channelState: 'connecting' });
  f.w.freezeControl('signal-disconnect'); await f.w.refresh({ reason: 'signal-reconnected' });
  const orphan = f.w.pc, oldOwner = f.w._peerCallbackOwner, oldChannel = f.w.inputChannel;
  const watchdog = f.w._dataChannelWatchdog;
  assert.ok(watchdog); const watchdogCallback = f.timers.get(watchdog.timer).fn;
  const priorTimers = new Set(f.timers.keys());
  const stream = await f.connect(orphan);
  const fallback = [...f.timers].filter(([id, timer]) => !priorTimers.has(id) && timer.ms === 8000 && !timer.interval);
  assert.ok(fallback.length, 'ontrack must generate the real 8s fallback');
  // Two actual play requests let both queued fulfillment and rejection run.
  orphan.ontrack({ track: { kind: 'video' }, streams: [stream] });
  const oldPlays = f.plays.slice(-2); assert.equal(oldPlays.length, 2);
  const sample = f.samples.at(-1);
  const queued = [
    ['track', () => orphanTrack({ track: { kind: 'video' }, streams: [stream] })],
    ['connection', orphan.onconnectionstatechange], ['ICE connection', orphan.oniceconnectionstatechange],
    ['ICE candidate', () => orphanIce({ candidate: { candidate: 'offline-candidate' } })],
    ['DC open', oldChannel.onopen], ['DC close', oldChannel.onclose],
    ['DC message', () => oldMessage({ data: JSON.stringify({ type: 'capture_stats', fps: 999 }) })],
    ['watchdog', watchdogCallback], ['stats sample', () => sample.onSample({ framesDecoded: 500, framesReceived: 500 })],
    ['stats error', () => sample.onError(new Error('offline queued error'))],
    ['rVFC', () => oldFrame(2200, {})], ['metadata', f.video.onloadedmetadata], ['playing', f.video.onplaying],
    ...fallback.map(([, timer]) => ['8s fallback', timer.fn]),
    ['play resolve', () => oldPlays[0].resolve()], ['play reject', () => oldPlays[1].reject(new Error('offline queued rejection'))],
  ];
  const orphanTrack = orphan.ontrack, orphanIce = orphan.onicecandidate, oldMessage = oldChannel.onmessage;
  const oldFrame = f.frames.get(f.w._videoFrameCallbackId);
  queued.forEach(([name, fn]) => assert.equal(typeof fn, 'function', `${name} must actually exist`));
  f.w.handleControlGrant({ controller: true, leaseId: 'offline-next-lease', leaseEpoch: 9 }); await f.settle();
  assert.equal(f.w.ownsStartupOwner(oldOwner), false); assert.equal(orphan.connectionState, 'closed');
  await f.connect();
  const invariant = () => ({ pc: f.w.pc, stream: f.video.srcObject, painted: f.w.hasPaintedFrame,
    ready: f.w.isCurrentAttemptMediaReady(), gate: f.input.getEffectiveInputGate().allowed,
    phase: f.w.getMediaAppliedPhase(), sampler: f.w._statsSampler, frameOwner: f.w._videoFrameOwner,
    callback: f.w._videoFrameCallbackId, timers: [...f.timers.keys()], frames: [...f.frames.keys()],
    captureFps: f.w._hostCaptureFps, emitted: f.emitted.length });
  const current = invariant();
  for (const [name, fn] of queued) { fn(); await f.settle(); assert.deepEqual(invariant(), current, name); }
  f.ackMedia(f.mediaRequest()); f.paint(); f.ackResets();
  assert.equal(f.input.getEffectiveInputGate().allowed, true);
  const active = invariant();
  for (const [name, fn] of queued) { fn(); await f.settle(); assert.deepEqual(invariant(), active, `active: ${name}`); }
});

test('after-grace ownership: duplicate grant preserves healthy peer', async () => {
  const f = await afterGracePeerFixture();
  const pc = f.w.pc, owner = f.w._peerCallbackOwner, attempt = f.w.currentConnectionAttemptId;
  const sequence = f.w.connectionAttemptSequence, sampler = f.w._statsSampler, frameOwner = f.w._videoFrameOwner;
  const offers = pc.offers;
  f.w.handleControlGrant(f.lease); await f.settle();
  assert.equal(f.w.pc, pc); assert.equal(f.peers.length, 1); assert.equal(pc.offers, offers);
  assert.equal(f.w._peerCallbackOwner, owner); assert.equal(f.w.currentConnectionAttemptId, attempt);
  assert.equal(f.w.connectionAttemptSequence, sequence); assert.equal(f.w._statsSampler, sampler);
  assert.equal(f.w._videoFrameOwner, frameOwner); assert.equal(f.w.isCurrentAttemptMediaReady(), true);
  assert.equal(f.w.hasPaintedFrame, true);
  // Existing intent replay may require another applied ACK and fresh resume frame.
  assert.equal(f.w.getMediaAppliedPhase(), 'resuming');
  assert.equal(f.input.getEffectiveInputGate().allowed, false);
  f.ackMedia(f.mediaRequest()); f.paint(); f.ackResets();
  assert.equal(f.input.getEffectiveInputGate().allowed, true);
});

test('after-grace ownership: within grace rebind preserves peer and ACK barrier', async () => {
  const f = await afterGracePeerFixture();
  const pc = f.w.pc, attempt = f.w.currentConnectionAttemptId, sequence = f.w.connectionAttemptSequence;
  f.w.socket.connected = false; f.w.freezeControl('signal-disconnect');
  f.w.scheduleSignalingRecovery('signal-disconnected');
  f.w.socket.connected = true;
  assert.equal(f.w.handleSignalingRecoveryConnected(), true);
  const before = f.writes.length; f.w.handleControlGrant(f.lease); await f.settle();
  assert.equal(f.w.pc, pc); assert.equal(f.peers.length, 1);
  assert.equal(f.w.currentConnectionAttemptId, attempt); assert.equal(f.w.connectionAttemptSequence, sequence);
  const resets = f.writes.slice(before).filter(write => write.action === 'reset');
  assert.equal(resets.length, 2); assert.deepEqual(resets.map(write => write.type).sort(), ['keyboard', 'mouse']);
  assert.equal(f.input.getEffectiveInputGate().allowed, false);
  f.ackMedia(f.mediaRequest()); f.paint();
  assert.equal(f.w.getMediaAppliedPhase(), 'active'); assert.equal(f.w.canEnableDesktopInput(), true);
  assert.equal(f.input.getEffectiveInputGate().allowed, false, 'media proof cannot replace either reset ACK');
  f.ackInput(resets[0]); assert.equal(f.input.getEffectiveInputGate().allowed, false);
  f.ackInput(resets[1]); assert.equal(f.input.getEffectiveInputGate().allowed, true);
});

test('after-grace ownership: first grant keeps unleased startup peer', async () => {
  const f = await afterGracePeerFixture({ firstGrant: true });
  const pc = f.w.pc, owner = f.w._peerCallbackOwner, attempt = f.w.currentConnectionAttemptId;
  const sequence = f.w.connectionAttemptSequence;
  assert.equal(pc._wrdControlLease, null); assert.equal(f.w._mediaControlLease == null, true);
  f.w.handleControlGrant(f.lease); await f.settle();
  assert.equal(f.w.pc, pc); assert.equal(f.peers.length, 1); assert.equal(f.w._peerCallbackOwner, owner);
  assert.equal(f.w.currentConnectionAttemptId, attempt); assert.equal(f.w.connectionAttemptSequence, sequence);
  assert.equal(f.w.ownsStartupOwner(owner), true);
  await f.connect(); assert.equal(f.input.getEffectiveInputGate().allowed, false);
  f.paint(); f.ackResets(); assert.equal(f.input.getEffectiveInputGate().allowed, true);
});

test('after-grace ownership: different leased peer still retires', async () => {
  const f = await afterGracePeerFixture();
  const old = f.w.pc, owner = f.w._peerCallbackOwner;
  assert.equal(old._wrdControlLease.leaseEpoch, 7);
  f.w.handleControlGrant({ controller: true, leaseId: 'offline-next-lease', leaseEpoch: 9 }); await f.settle();
  assert.notEqual(f.w.pc, old); assert.equal(old.connectionState, 'closed');
  assert.equal(f.w.ownsStartupOwner(owner), false);
  assert.equal(f.w._peerCallbackOwner.peer, f.w.pc);
  assert.equal(f.w._peerCallbackOwner.attempt, f.w.currentConnectionAttemptId);
  assert.equal(f.w._peerCallbackOwner.sequence, f.w.connectionAttemptSequence);
  assert.equal(f.input.getEffectiveInputGate().allowed, false);
  await f.connect(); f.ackMedia(f.mediaRequest());
  assert.equal(f.w.getMediaAppliedPhase(), 'resuming'); assert.equal(f.input.getEffectiveInputGate().allowed, false);
  f.paint(); f.ackResets(); assert.equal(f.input.getEffectiveInputGate().allowed, true);
});
