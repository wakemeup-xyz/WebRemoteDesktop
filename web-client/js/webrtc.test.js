const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

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
    removeAttribute(name) { attrs.delete(name); },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    contains(node) { return node === el; },
  };
  return el;
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
  const source = fs.readFileSync(path.join(__dirname, 'webrtc.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__WebRTC = WebRTC;`, context);
  return { WebRTC: context.__WebRTC, context, elements };
}

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
  assert.deepEqual(Array.from(socketOptions.transports), ['websocket', 'polling']);
  assert.equal(socketOptions.tryAllTransports, true);
  assert.equal(socketOptions.timeout, 5000);
  socketHandlers.get('connected')({ hostOnline: true });
  assert.equal(offers, 0);
  assert.equal(emitted.at(-1)[0], 'control-acquire');

  socketHandlers.get('control-grant')({ controller: true, leaseId: 'lease-000000000001', leaseEpoch: 4 });
  assert.equal(offers, 1);
  socketHandlers.get('input-ack')({ schemaVersion: 2, leaseEpoch: 4, appliedSeq: 1, status: 'applied' });
  assert.deepEqual(order, ['transport', 'latency']);
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

test('dc-error does not schedule full reconnect when inbound video is healthy', () => {
  const { WebRTC } = loadWebRTC();
  WebRTC.manualDisconnect = false;
  WebRTC._refreshing = false;
  WebRTC.reconnectTimer = null;
  WebRTC.pc = { connectionState: 'connected', iceConnectionState: 'connected' };
  WebRTC._lastInboundFramesDecoded = 10;
  WebRTC._lastInboundFramesDecodedAt = Date.now();
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
  WebRTC._lastInboundFramesDecodedAt = 0;
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

test('inbound video health requires recent framesDecoded growth', () => {
  const { WebRTC } = loadWebRTC();
  WebRTC._lastInboundFramesDecoded = 0;
  WebRTC._lastInboundFramesDecodedAt = 0;
  assert.equal(WebRTC.isInboundVideoHealthy(), false);

  WebRTC.processStatsSnapshot({ framesDecoded: 5, framesReceived: 5, fps: 5 });
  assert.equal(WebRTC._lastInboundFramesDecoded, 5);
  assert.ok(WebRTC._lastInboundFramesDecodedAt > 0);
  assert.equal(WebRTC.isInboundVideoHealthy(), true);

  const growthAt = WebRTC._lastInboundFramesDecodedAt;
  WebRTC.processStatsSnapshot({ framesDecoded: 5, framesReceived: 5, fps: 0 });
  assert.equal(WebRTC._lastInboundFramesDecodedAt, growthAt);

  WebRTC._lastInboundFramesDecodedAt = Date.now() - 6000;
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

test('network advisor expands on update then auto-collapses to the right edge tab', () => {
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

  WebRTC.updateNetworkUI('外网中继已连接', '');
  const advisor = context.document.getElementById('networkAdvisor');
  const handleLabel = context.document.getElementById('networkAdvisorHandleLabel');
  assert.equal(advisor.classList.contains('visible'), true);
  assert.equal(advisor.classList.contains('collapsed'), false);
  assert.equal(handleLabel.textContent, '中继');
  assert.equal(advisor.getAttribute('aria-expanded'), 'true');

  const collapseTimers = timers2.filter((t) => !t.cleared && t.ms === WebRTC.NETWORK_ADVISOR_COLLAPSE_MS['']);
  assert.ok(collapseTimers.length >= 1, 'should schedule auto-collapse');
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

test('suspended media prevents tunnel start or restart until the active phase is restored', () => {
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
  assert.equal(WebRTC.tunnelRelayActive, false);
  assert.equal(emitted.some(([event, payload]) => event === 'relay-stream-control' && payload.enabled === true), false);

  WebRTC.handleMediaActivityAck({
    state: 'active', generation: 2, connectionAttemptId: 'wrd-1', applied: true,
  });
  WebRTC.noteMediaRenderedFrame({ source: 'video-callback', frameSeq: 1 });
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
  await new Promise((resolve) => setTimeout(resolve, 50));
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

test('resume stays resuming when framesDecoded does not increase past baseline', () => {
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

  // Fresh decoded frame past baseline unlocks once.
  WebRTC.processStatsSnapshot({
    fps: 15,
    rttMs: 40,
    framesReceived: 101,
    framesDecoded: 101,
    packetsLost: 0,
    bytesReceived: 1100,
    selectedCandidateType: 'srflx',
  });
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
    state: 'active',
    generation: 2,
    connectionAttemptId: 'attempt-tunnel-1',
    applied: true,
  });
  assert.equal(WebRTC.getMediaAppliedPhase(), 'resuming');
  assert.equal(WebRTC.canEnableDesktopInput(), false);

  // Fresh relay frame unlocks.
  WebRTC.tunnelLastFrameId = 10;
  WebRTC.observeFreshResumeFrame({
    source: 'video-callback',
    frameSeq: (WebRTC._videoFrameSeq || 0) + 1,
    connectionAttemptId: 'attempt-tunnel-1',
  });
  assert.equal(WebRTC.getMediaAppliedPhase(), 'active');
});

test('tunnel active ack promotes a relay frame rendered before the ack', () => {
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

  WebRTC.handleRelayFrame({ frameId: 1, timestamp: Date.now(), mime: 'image/jpeg', data: 'AAAA' });
  elements.get('relayImage').onload();
  assert.equal(WebRTC.getMediaAppliedPhase(), 'resuming');

  WebRTC.handleMediaActivityAck({
    state: 'active', generation: 2, connectionAttemptId: 'attempt-tunnel-race', applied: true,
  });
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
    state: 'active',
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

test('starting a new tunnel producer resets the frame-id cursor', () => {
  const emitted = [];
  const { WebRTC } = loadWebRTC();
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
      state: 'active', generation: 5, connectionAttemptId: 'attempt-tunnel-stable', applied: true,
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
  const relayImage = elements.get('relayImage') || context.document.getElementById('relayImage');
  // Fake bounding box independent of intrinsic image size.
  let box = { width: 800, height: 450, left: 0, top: 0 };
  relayImage.getBoundingClientRect = () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height });
  const sizes = [[960, 540], [640, 360], [480, 270]];
  let frameId = 0;
  for (const [width, height] of sizes) {
    frameId += 1;
    WebRTC.handleRelayFrame({
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

test('reclaimDesktopSession clears supersede flags', () => {
  const { WebRTC } = loadWebRTC();
  WebRTC.handleViewerSuperseded({ reason: 'single-desktop-viewer' });
  let started = 0;
  WebRTC.createSignalingSocket = () => { started += 1; };
  WebRTC.createPeerConnection = () => {};
  WebRTC.beginConnectionAttempt = () => {};

  WebRTC.reclaimDesktopSession();

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
    _lastInboundFramesDecodedAt: 0,
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
  const { WebRTC } = loadWebRTC();
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
    _lastInboundFramesDecodedAt: Date.now(),
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
    _lastInboundFramesDecodedAt: 0,
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
