const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function makeElement() {
  const classes = new Set();
  const listeners = new Map();
  return {
    textContent: '',
    style: {},
    src: '',
    dataset: {},
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
    removeAttribute() {},
    setAttribute() {},
  };
}

function loadWebRTC(overrides = {}) {
  const elements = new Map();
  const context = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    performance: { now: () => 0 },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
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
  if (overrides.document) {
    context.document = overrides.document;
  }
  if (overrides.window) {
    context.window = overrides.window;
  }
  context.globalThis = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, 'webrtc.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__WebRTC = WebRTC;`, context);
  return { WebRTC: context.__WebRTC, context, elements };
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

test('WebRTC routes independent DataChannel and Socket.IO input acks to LatencyMonitor', () => {
  const acks = [];
  const channels = new Map();
  const socketHandlers = new Map();
  const { WebRTC } = loadWebRTC({
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

  channels.get('input').onmessage({ data: JSON.stringify({ type: 'input_ack', inputIds: ['dc-1'] }) });
  socketHandlers.get('input-ack')({ type: 'input_ack', inputIds: ['socket-1'] });

  assert.deepEqual(acks.map((payload) => payload.inputIds[0]), ['dc-1', 'socket-1']);
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
      setControlLease() {},
      acceptKeyboardAck() { order.push('transport'); },
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
  socketHandlers.get('connected')({ hostOnline: true });
  assert.equal(offers, 0);
  assert.equal(emitted.at(-1)[0], 'control-acquire');

  socketHandlers.get('control-grant')({ controller: true, leaseId: 'lease-000000000001', leaseEpoch: 4 });
  assert.equal(offers, 1);
  socketHandlers.get('input-ack')({ schemaVersion: 2, leaseEpoch: 4, appliedSeq: 1, status: 'applied' });
  assert.deepEqual(order, ['transport', 'latency']);
  WebRTC.stopControlHeartbeat();
});

test('tunnel relay uses the authenticated viewer socket instead of a second relay socket', () => {
  const emitted = [];
  const { WebRTC } = loadWebRTC();
  WebRTC.socket = { connected: true, emit(...args) { emitted.push(args); } };
  WebRTC.controlState = { state: 'ACTIVE', controller: true, hostOnline: true, lease: { leaseId: 'lease-000000000001', leaseEpoch: 6 } };
  WebRTC.tunnelRelayActive = true;

  WebRTC.emitRelayStreamControl();

  assert.equal(emitted[0][0], 'relay-stream-control');
  assert.equal(Object.prototype.hasOwnProperty.call(WebRTC, 'relaySocket'), false);
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
    WebRTC.handleControlState({ state, controller: false });
    assert.equal(elements.get('controlStatus').textContent, '正在切换');
    assert.equal(elements.get('requestControlBtn').hidden, true);
    assert.equal(elements.get('requestControlBtn').disabled, true);
  }
});

test('relay control and frame acknowledgements require and carry the active v2 lease', () => {
  const emitted = [];
  const { WebRTC, elements } = loadWebRTC();
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
  WebRTC.handleRelayFrame({ data: 'ZmFrZQ==', frameId: 3, timestamp: Date.now() });
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
  const controller = LinkQualityController.create();

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
  const controller = LinkQualityController.create();

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
  const controller = LinkQualityController.create({ initialProfile: 'survival', now: () => now });
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
  const controller = LinkQualityController.create();
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
  const controller = LinkQualityController.create();
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

test('WebRTC syncs the adaptive profile when a new media connection becomes active', () => {
  const { LinkQualityController } = loadLinkQualityController();
  const { WebRTC } = loadWebRTC({ LinkQualityController });
  const emitted = [];
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
  assert.deepEqual(emitted.map(({ event }) => event), ['media-profile-change', 'resolution-change']);
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

test('WebRTC owns one stats sampler and stops it during telemetry teardown', () => {
  let createCalls = 0;
  let startCalls = 0;
  let stopCalls = 0;
  const sampler = {
    start() { startCalls += 1; },
    stop() { stopCalls += 1; },
    snapshot() { return null; },
  };
  const { WebRTC } = loadWebRTC({
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

test('auto fallback handles relay frames while tunnel relay is active', () => {
  const { WebRTC, elements } = loadWebRTC();
  const relayImage = elements.get('relayImage') || makeElement();
  relayImage.classList.add('hidden');
  elements.set('relayImage', relayImage);

  WebRTC.networkMode = 'auto';
  WebRTC.tunnelRelayActive = true;

  WebRTC.handleRelayFrame({
    data: 'ZmFrZS1mcmFtZQ==',
    mime: 'image/jpeg',
    frameId: 1,
    width: 960,
    height: 540,
    timestamp: Date.now(),
  });

  assert.equal(relayImage.classList.contains('hidden'), false);
  assert.equal(elements.get('connectionStatus').textContent, '已连接');
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

  WebRTC.handleRelayFrame({
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
  assert.equal(typeof emitted[0].payload.latencyMs, 'number');
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

  WebRTC.updateNetworkUI('网络模式已就绪');

  const advisorText = context.document.getElementById('networkAdvisorText').textContent;
  const turnStatus = context.document.getElementById('networkTurnStatus').textContent;

  assert.equal(advisorText.includes('自动切换到隧道中继'), false);
  assert.equal(advisorText.includes('自动改走中继'), false);
  assert.match(advisorText, /手动改用|建议/);
  assert.match(turnStatus, /固定入口.*link\.stockhub\.wiki/);
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
    localAddress: '203.0.113.1:5000',
    remoteAddress: '192.168.0.2:6000',
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
  assert.equal(profileEvent.payload.videoBitrateKbps, 1400);
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
