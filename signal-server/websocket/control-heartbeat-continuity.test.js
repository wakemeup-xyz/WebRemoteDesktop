const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const previousDiagDir = process.env.WRD_DIAG_DIR;
const diagnosticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-heartbeat-tests-'));
process.env.WRD_DIAG_DIR = diagnosticDir;
process.env.JWT_SECRET ||= 'heartbeat-test-secret';
process.env.VIEWER_ACCESS_PASSWORD ||= 'heartbeat-test-password';
process.env.HOST_SHARED_SECRET ||= 'heartbeat-test-host-secret';
test.after(() => {
  if (previousDiagDir === undefined) delete process.env.WRD_DIAG_DIR;
  else process.env.WRD_DIAG_DIR = previousDiagDir;
  fs.rmSync(diagnosticDir, { recursive: true, force: true });
});
const { setupSignaling, createRuntimeContext } = require('./signaling');
const { DesktopControlLease } = require('../lib/desktop-control-lease');
const { FakeSocket, makeIo } = require('./signaling-test-fixture');

function fixture({ capability = true, dropHeartbeat = false, ackDelay = 0,
  bufferedEngine = false, summaryThrows = false, ackTransform = value => value } = {}) {
  let now = 0, nextTimer = 0, nextAck = 0;
  const timers = new Map(), ackTable = new Map(), callbacks = [], emitted = [], events = [];
  const setTimer = (fn, ms, repeat = 0) => {
    const id = ++nextTimer; timers.set(id, { fn, due: now + ms, repeat }); return id;
  };
  const scheduler = {
    setTimeout: (fn, ms) => setTimer(fn, ms), clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => setTimer(fn, ms, ms), clearInterval: id => timers.delete(id),
  };
  const advance = ms => {
    const target = now + ms;
    for (;;) {
      const entry = [...timers].filter(([, value]) => value.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
      if (!entry) break;
      const [id, timer] = entry; now = timer.due;
      if (timer.repeat) timer.due += timer.repeat; else timers.delete(id);
      timer.fn();
    }
    now = target;
  };
  const runtime = createRuntimeContext();
  const lease = new DesktopControlLease({ now: () => now, makeLeaseId: () => 'PRIVATE_LEASE_CANARY' });
  const io = makeIo(runtime);
  setupSignaling(io, { runtimeContext: runtime, desktopControlLease: lease, now: () => now,
    controlHeartbeatNow: () => now, scheduler,
    logger: {}, structuredLogger: { info: value => {
      if (summaryThrows && value.event === 'control_heartbeat_observed') throw new Error('summary-sink-failure');
      events.push(value);
    } } });
  const host = new FakeSocket('heartbeat-host', 'host');
  host.handshake.auth.inputProtocolVersion = 2;
  io.connect(host);
  const handlers = new Map(), documentHandlers = new Map();
  let serverViewer, engineCloses = 0;
  const deliver = (event, payload) => (handlers.get(event) || []).forEach(handler => handler(payload));
  const route = (event, payload, ack) => {
    emitted.push({ event, payload });
    if (event === 'control-heartbeat' && dropHeartbeat) return;
    serverViewer.listeners(event).forEach(handler => handler(payload, ack));
  };
  const client = {
    id: 'heartbeat-viewer-1', connected: true, auth: {},
    on(event, handler) { const values = handlers.get(event) || []; values.push(handler); handlers.set(event, values); },
    emit: route,
    timeout(ms) { return { emit(event, payload, callback) {
      const id = ++nextAck;
      const timer = setTimer(() => { ackTable.delete(id); callback(new Error('ack-timeout')); }, ms);
      ackTable.set(id, timer); callbacks.push(callback);
      route(event, payload, data => setTimer(() => {
        if (!ackTable.has(id)) return;
        timers.delete(timer); ackTable.delete(id); callback(null, ackTransform(data));
      }, ackDelay));
    } }; },
    io: { engine: { close() {
      engineCloses += 1; client.connected = false;
      for (const timer of ackTable.values()) timers.delete(timer);
      ackTable.clear(); serverViewer.disconnect(); deliver('disconnect', 'transport close');
    } } },
  };
  if (bufferedEngine) {
    const { SocketWithoutUpgrade, Transport } = require('engine.io-client');
    const finishClose = client.io.engine.close;
    const engine = Object.create(SocketWithoutUpgrade.prototype);
    const transport = Object.create(Transport.prototype);
    Object.assign(transport, { readyState: 'open', writable: false, doClose() {} });
    Object.assign(engine, { readyState: 'open', writeBuffer: [{ type: 'message' }], upgrading: false,
      transport, _onClose() {
        if (engine.readyState === 'closed') return;
        engine.readyState = 'closed'; finishClose();
      } });
    transport.on('close', () => engine._onClose('transport close'));
    client.io.engine = engine;
  }
  const element = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, setAttribute() {} });
  const input = { activeControlLease: null, isActive: true, init() {}, resetKeyboard() {}, releasePointer() {},
    setControlLease(value) { this.activeControlLease = value; return true; },
    suspendControlLease() { if (!this.activeControlLease) return false; this.activeControlLease = null; return true; },
    setActive(value) { this.isActive = value; } };
  class ClockDate extends Date { static now() { return now; } }
  const context = { console: { log() {}, warn() {}, error() {} }, Date: ClockDate, performance: { now: () => now },
    ...scheduler, setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout,
    setInterval: scheduler.setInterval, clearInterval: scheduler.clearInterval,
    Input: input, localStorage: { getItem: () => null, setItem() {} },
    navigator: { userAgent: 'offline-heartbeat-test' }, updateLoadingText() {},
    window: { location: { origin: 'http://offline.invalid' }, addEventListener() {} },
    document: { hidden: false, body: element(), readyState: 'loading',
      getElementById: () => element(), addEventListener: (name, fn) => documentHandlers.set(name, fn) } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../web-client/js/webrtc.js'), 'utf8')
    + '\nglobalThis.testWebRTC = WebRTC;', context);
  const viewer = context.testWebRTC;
  Object.assign(viewer, { socket: client, currentConnectionAttemptId: 'heartbeat-attempt', connectionAttemptSequence: 1,
    pc: { connectionState: 'connected', close() {} }, hasPaintedFrame: true, uiPhase: 'connected' });
  for (const name of ['updateControlUI', 'renderPortSearchStatus', 'applyHostCapabilities', 'requestControl',
    'ensureMediaActiveIfVisible', 'replayMediaActivityIntent', 'reconcileConfiguredControlMedia']) viewer[name] = () => {};
  viewer.ensureDesktopSessionState = () => null;
  viewer.syncDesktopInputGate = () => { input.isActive = viewer.hasActiveControl() && client.connected; };
  viewer.setUiPhase = value => { viewer.uiPhase = value; };
  viewer.isInboundVideoHealthy = () => true;
  viewer.setupSocketListeners();
  function connectServer(id, resume = false) {
    const socket = new FakeSocket(id, 'viewer');
    socket.handshake.auth.inputProtocolVersion = 2;
    socket.handshake.auth.viewerSessionId = 'heartbeat-browser-session';
    if (resume) socket.handshake.auth.viewerAdmission = viewer._viewerAdmission;
    const emit = socket.emit.bind(socket);
    socket.emit = (event, data, ack) => {
      emit(event, data, ack);
      if (event === 'connected' && capability !== true) {
        data = { ...data, controlHeartbeatAckVersion: capability };
        if (capability === false) delete data.controlHeartbeatAckVersion;
      }
      deliver(event, data); return true;
    };
    serverViewer = socket; client.id = id; client.connected = true;
    if (resume) deliver('connect');
    io.connect(socket);
    return socket;
  }
  connectServer(client.id);
  serverViewer.trigger('control-acquire', { requestId: 'heartbeat-grant' });
  const transition = host.sent.find(value => value.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const grant = serverViewer.sent.find(value => value.event === 'control-grant').data;
  return { viewer, client, input, context, lease, emitted, events, callbacks, timers, ackTable, grant, deliver,
    advance, now: () => now, engineCloses: () => engineCloses, serverViewer: () => serverViewer,
    reconnect() {
      connectServer('heartbeat-viewer-2', true);
      const rebind = host.sent.filter(value => value.event === 'viewer-session-rebind').at(-1);
      assert.ok(rebind, 'normal reconnect must wait for formal Host rebind');
      assert.equal(viewer.hasActiveControl(), false);
      rebind.ack(null, { status: 'applied' });
    },
  };
}

test('confirmed heartbeat capability repairs an open but stalled uplink before lease expiry through formal rebind', () => {
  const h = fixture({ dropHeartbeat: true });
  assert.equal(h.viewer.hasActiveControl(), true);
  h.advance(2499); assert.equal(h.engineCloses(), 0);
  h.advance(1); assert.equal(h.engineCloses(), 1);
  assert.equal(h.lease.snapshot().state, 'ACTIVE', 'recovery must start before the unchanged 12s TTL');
  assert.equal(h.input.isActive, false);
  assert.equal(h.viewer._signalRecoveryPending, true);
  h.advance(100); h.reconnect();
  assert.equal(h.viewer.controlState.lease.leaseEpoch, h.grant.leaseEpoch);
  assert.equal(h.viewer.controlState.lease.leaseId, h.grant.leaseId);
});

test('non-draining Engine.IO write buffer cannot trap heartbeat recovery in graceful closing', () => {
  const h = fixture({ dropHeartbeat: true, bufferedEngine: true });
  h.advance(2500);
  assert.equal(h.client.io.engine.readyState, 'closed');
  assert.equal(h.engineCloses(), 1);
  assert.equal(h.viewer._signalRecoveryPending, true);
  assert.equal(h.lease.snapshot().state, 'ACTIVE');
});

test('legacy capability fallback keeps old behavior and reproduces the 12s loss without a new reconnect', () => {
  const h = fixture({ capability: false, dropHeartbeat: true });
  h.advance(11999); assert.equal(h.lease.snapshot().state, 'ACTIVE');
  h.advance(1); assert.equal(h.lease.snapshot().state, 'REVOKING');
  assert.equal(h.engineCloses(), 0);
  assert.equal(h.viewer.hasActiveControl(), false);
});

test('valid heartbeat ACK at 2400ms keeps one pending request and never reconnects', () => {
  const h = fixture({ ackDelay: 2400 });
  for (let index = 0; index < 10; index++) {
    h.advance(2400); assert.equal(h.engineCloses(), 0); assert.ok(h.ackTable.size <= 1);
    h.advance(600); assert.ok(h.ackTable.size <= 1);
  }
  assert.equal(h.lease.snapshot().state, 'ACTIVE');
  assert.equal(h.viewer.getControlHeartbeatSnapshot().timeouts, 0);
});

test('deadline and late ACK can close the engine only once and cannot revive retired scope', () => {
  const h = fixture({ ackDelay: 2600 });
  const callback = h.callbacks[0];
  h.advance(2500); assert.equal(h.engineCloses(), 1); assert.equal(h.ackTable.size, 0);
  callback(null, { schemaVersion: 1, status: 'accepted', heartbeatSeq: 1, leaseEpoch: h.grant.leaseEpoch,
    connectionAttemptId: 'heartbeat-attempt', connectionAttemptSequence: 1 });
  h.advance(3000);
  assert.equal(h.engineCloses(), 1); assert.equal(h.viewer.hasActiveControl(), false);
});

for (const change of ['socket-id', 'socket-object', 'attempt', 'attempt-sequence', 'lease-object']) {
  test(`heartbeat callback from an old ${change} cannot repair or reconnect the current scope`, () => {
    const h = fixture({ ackDelay: 2400 });
    if (change === 'socket-id') h.client.id = 'retired-socket-id';
    if (change === 'socket-object') h.viewer.socket = { ...h.client };
    if (change === 'attempt') h.viewer.currentConnectionAttemptId = 'new-attempt';
    if (change === 'attempt-sequence') h.viewer.connectionAttemptSequence++;
    if (change === 'lease-object') h.viewer.controlState.lease = { ...h.viewer.controlState.lease };
    h.advance(3000);
    assert.equal(h.engineCloses(), 0);
    assert.equal(h.viewer.getControlHeartbeatSnapshot().acknowledged, 0);
  });
}

test('mismatched ACK does not cancel the original deadline or extend its 2500ms budget', () => {
  const h = fixture({ ackDelay: 100, ackTransform: ack => ({ ...ack, heartbeatSeq: ack.heartbeatSeq + 1 }) });
  h.advance(2499); assert.equal(h.engineCloses(), 0);
  h.advance(1); assert.equal(h.engineCloses(), 1);
});

test('explicit rejection preserves fail-closed control behavior without automatic reconnect', () => {
  const h = fixture({ ackDelay: 2000 });
  h.client.emit('control-heartbeat', { leaseId: 'wrong-lease', leaseEpoch: h.grant.leaseEpoch });
  assert.equal(h.viewer.hasActiveControl(), false);
  h.advance(3000); assert.equal(h.engineCloses(), 0);
});

for (const inactive of ['hidden', 'manual-disconnect', 'superseded', 'pagehide']) {
  test(`${inactive} cannot trigger an automatic heartbeat reconnect`, () => {
    const h = fixture({ dropHeartbeat: true });
    if (inactive === 'hidden') h.context.document.hidden = true;
    if (inactive === 'manual-disconnect') h.viewer.manualDisconnect = true;
    if (inactive === 'superseded') h.viewer._superseded = true;
    if (inactive === 'pagehide') h.viewer._pageLifecycleHidden = true;
    h.advance(9000); assert.equal(h.engineCloses(), 0); assert.ok(h.ackTable.size <= 1);
  });
}

test('repeated grants retain one heartbeat interval and ACK request, and summaries contain no lease token', () => {
  const h = fixture({ ackDelay: 2400 });
  for (let index = 0; index < 100; index++) h.viewer.handleControlGrant(h.grant);
  assert.equal(h.ackTable.size, 1);
  assert.equal(h.timers.size, 4, 'two intervals, one Socket.IO deadline and one simulated network delivery');
  h.advance(2400);
  const snapshot = h.viewer.getControlHeartbeatSnapshot();
  assert.equal(snapshot.acknowledged, 1);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE_LEASE_CANARY'), false);
  assert.equal(JSON.stringify(h.events).includes('PRIVATE_LEASE_CANARY'), false);
});

test('late capability welcome on active control binds the attempt before its first confirmed heartbeat', () => {
  const h = fixture({ capability: false });
  h.deliver('connected', { hostOnline: true, controlHeartbeatAckVersion: 1 });
  h.advance(0);
  assert.equal(h.viewer.getControlHeartbeatSnapshot().acknowledged, 1);
  assert.equal(h.engineCloses(), 0);
  const events = h.emitted.map(row => row.event);
  assert.equal(events.at(-2), 'connection-attempt-bind');
  assert.equal(events.at(-1), 'control-heartbeat');
});

for (const capability of ['1', 2, null]) {
  test(`capability ${JSON.stringify(capability)} does not enable the new ACK watchdog`, () => {
    const h = fixture({ capability });
    h.advance(15000);
    assert.equal(h.engineCloses(), 0);
    assert.equal(h.ackTable.size, 0);
    assert.equal(h.lease.snapshot().state, 'ACTIVE');
  });
}

test('server withholds positive ACK for wrong attempt metadata and ignores malformed heartbeat bodies', () => {
  const h = fixture();
  h.advance(0);
  const handler = h.serverViewer().listeners('control-heartbeat')[0];
  const observation = h.serverViewer()._wrdControlHeartbeatObservation;
  const received = observation.received;
  for (const value of [null, [], 'invalid']) assert.doesNotThrow(() => handler(value, () => assert.fail('malformed ACK')));
  assert.equal(observation.received, received);
  let acknowledgements = 0;
  handler({ ...h.grant, heartbeatAckVersion: 1, heartbeatSeq: 2,
    connectionAttemptId: 'retired-attempt', connectionAttemptSequence: 1 }, () => acknowledgements++);
  assert.equal(acknowledgements, 0);
});

test('duplicate malformed callbacks retain one remainder timer and the original deadline', () => {
  const h = fixture({ ackDelay: 100, ackTransform: ack => ({ ...ack, leaseEpoch: ack.leaseEpoch + 1 }) });
  h.advance(100);
  const count = h.timers.size;
  for (let index = 0; index < 100; index++) h.callbacks[0](null, { status: 'invalid' });
  assert.equal(h.timers.size, count);
  h.advance(2400); assert.equal(h.engineCloses(), 1);
  const snapshot = h.viewer.getControlHeartbeatSnapshot();
  assert.equal(snapshot.lastFailure.reason, 'ack-timeout');
  assert.equal(snapshot.lastFailure.timeouts, 1);
  assert.equal(snapshot.lastFailureAgeMs, 0);
});

test('control heartbeat summary sink errors cannot interrupt lease expiry or normal cleanup', () => {
  const h = fixture({ capability: false, dropHeartbeat: true, summaryThrows: true });
  assert.doesNotThrow(() => h.advance(12000));
  assert.equal(h.lease.snapshot().state, 'REVOKING');
  assert.equal(h.viewer.hasActiveControl(), false);
  assert.doesNotThrow(() => h.serverViewer().disconnect());
});
