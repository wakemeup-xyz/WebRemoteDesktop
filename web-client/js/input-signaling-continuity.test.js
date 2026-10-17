const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { MediaActivityRuntime } = require('./media-activity-runtime.js');

function fixture({ heartbeat = false } = {}) {
  let now = 1000;
  let nextTimerId = 0;
  const timers = new Map();
  class FixtureDate extends Date { static now() { return now; } }
  const setTimer = (fn, ms) => { const id = ++nextTimerId; timers.set(id, { fn, due: now + ms }); return id; };
  const advance = (ms) => {
    now += ms;
    let due;
    while ((due = [...timers].find(([, t]) => t.due <= now))) {
      timers.delete(due[0]); due[1].fn();
    }
  };
  const intervals = new Map();
  let nextIntervalId = 0;
  const sent = [];
  const emitted = [];
  const elements = new Map();
  const element = () => ({
    style: {}, dataset: {}, hidden: false, value: '', isConnected: true,
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; }, setAttribute() {}, removeAttribute() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
  });
  const context = {
    console, Date: FixtureDate, performance: { now: () => now },
    setTimeout: setTimer, clearTimeout(id) { timers.delete(id); }, updateLoadingText() {},
    setInterval: (fn, ms) => { const id = ++nextIntervalId; intervals.set(id, { fn, ms }); return id; },
    clearInterval(id) { intervals.delete(id); }, requestAnimationFrame: (fn) => fn(),
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { platform: 'MacIntel', userAgent: 'offline-test' },
    window: { addEventListener() {}, location: { origin: 'http://offline.invalid' } },
    document: {
      readyState: 'loading', hidden: false, body: element(), activeElement: null,
      addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  for (const name of ['keyboard-transport', 'remote-keyboard-controller', 'webrtc', 'input']) {
    let source = fs.readFileSync(path.join(__dirname, `${name}.js`), 'utf8');
    if (name === 'webrtc') source += '\nglobalThis.__WebRTC = WebRTC;';
    if (name === 'input') source += '\nglobalThis.__Input = Input;';
    vm.runInContext(source, context);
  }
  const WebRTC = context.__WebRTC;
  const Input = context.__Input;
  const originalCreateOffer = WebRTC.createOffer;
  const originalBindAttempt = WebRTC.bindCurrentConnectionAttempt;
  const originalHeartbeat = WebRTC.startControlHeartbeat;
  const originalMedia = {
    ensureMediaActiveIfVisible: WebRTC.ensureMediaActiveIfVisible,
    replayMediaActivityIntent: WebRTC.replayMediaActivityIntent,
  };
  WebRTC.socket = { connected: true, emit(event, payload) {
    emitted.push({ event, payload });
    if (event === 'input') sent.push({ channel: 'socket', ...payload });
  } };
  WebRTC.inputChannel = { readyState: 'open', send(payload) {
    sent.push({ channel: 'datachannel', ...JSON.parse(payload) });
  } };
  WebRTC.pc = { connectionState: 'connected' };
  WebRTC.currentConnectionAttemptId = 'offline-attempt';
  WebRTC._mediaReadyConnectionAttemptId = 'offline-attempt';
  WebRTC.uiPhase = 'connected';
  WebRTC.hasPaintedFrame = true;
  WebRTC.getMediaActivitySnapshot = () => ({ state: 'active' });
  WebRTC.ensureDesktopSessionState = () => null;
  for (const method of ['updateControlUI', 'renderPortSearchStatus', 'startControlHeartbeat',
    'bindCurrentConnectionAttempt', 'ensureMediaActiveIfVisible', 'replayMediaActivityIntent',
    'createOffer']) {
    WebRTC[method] = () => {};
  }
  if (heartbeat) WebRTC.startControlHeartbeat = originalHeartbeat;
  Input._listenersBound = true;
  const lease = { leaseId: 'offline-lease', leaseEpoch: 7 };
  const grant = (next = lease) => WebRTC.handleControlGrant({ controller: true, ...next });
  grant();
  const acknowledge = (write, status = 'applied') => {
    const ack = { schemaVersion: 2, inputType: write.type, inputIds: write.inputIds,
      leaseEpoch: write.leaseEpoch, appliedSeq: write.seq, status };
    return write.type === 'keyboard' ? Input.acceptKeyboardAck(ack) : Input.acceptMouseAck(ack);
  };
  const disconnect = () => {
    WebRTC.socket.connected = false;
    WebRTC.freezeControl('signal-disconnect');
  };
  return { WebRTC, Input, context, intervals, advance, timers, originalMedia, originalCreateOffer, originalBindAttempt, emitted, sent, lease, grant, acknowledge, disconnect };
}

test('same-session signaling regrant retains both sequences and waits for both reset acknowledgements', () => {
  const h = fixture();
  for (let i = 0; i < 5; i += 1) {
    assert.equal(h.Input.keyboardController.sendText('fixture'), true);
    h.acknowledge(h.sent.at(-1));
    assert.ok(h.Input.sendInput('mouse', 'reset', { reason: 'manual' }));
    h.acknowledge(h.sent.at(-1));
  }
  h.disconnect();
  assert.equal(h.Input.activeControlLease, null);
  assert.equal(h.Input.isActive, false);
  assert.equal(h.Input.keyboardTransport.getSnapshot().lastSent, 5);
  assert.equal(h.Input._desktopWriteSequence, 5);
  assert.equal(h.Input.sendInput('mouse', 'down', {}), null);
  const beforeGrant = h.sent.length;
  h.WebRTC.socket.connected = true;
  h.grant();
  const resets = h.sent.slice(beforeGrant).filter((write) => write.action === 'reset');
  assert.equal(resets.length, 2);
  assert.deepEqual(resets.map((write) => [write.type, write.seq]), [['mouse', 6], ['keyboard', 6]]);
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  h.acknowledge(resets[0]);
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  h.acknowledge(resets[1]);
  assert.equal(h.Input.getEffectiveInputGate().allowed, true);
  assert.equal(h.Input.keyboardController.sendText('fresh'), true);
  assert.equal(h.sent.at(-1).seq, 7);
  assert.ok(h.Input.sendInput('mouse', 'reset', { reason: 'manual' }));
  assert.equal(h.sent.at(-1).seq, 7);
});

test('DataChannel close during signaling suspension defers reset until the socket returns', () => {
  const h = fixture();
  h.Input.keyboardController.sendText('fixture');
  h.acknowledge(h.sent.at(-1));
  h.disconnect();
  h.WebRTC.inputChannel.readyState = 'closed';
  h.Input.setKeyboardDataChannelAvailable(false);
  assert.equal(h.Input.keyboardTransport.getSnapshot().state, 'ready');
  h.WebRTC.socket.connected = true;
  h.grant();
  assert.equal(h.Input._recoveryCycle.state, 'waiting');
  const resets = h.sent.filter((write) => write.action === 'reset');
  assert.equal(resets.every((write) => write.channel === 'socket'), true);
  resets.forEach((write) => h.acknowledge(write));
  assert.equal(h.Input.getEffectiveInputGate().allowed, true);
});

test('same-lease reconnect cannot erase an existing keyboard rejection', () => {
  const h = fixture();
  h.Input.keyboardController.sendText('fixture');
  h.acknowledge(h.sent.at(-1), 'execution-failed');
  assert.equal(h.Input.keyboardTransport.getSnapshot().state, 'reacquire-required');
  h.disconnect();
  h.WebRTC.socket.connected = true;
  h.grant();
  assert.equal(h.Input.keyboardTransport.getSnapshot().state, 'revoked');
  assert.equal(h.emitted.filter(e => e.event === 'control-release').length, 1);
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  h.grant({ leaseId: 'replacement-lease', leaseEpoch: 8 });
  assert.equal(h.Input.keyboardTransport.getSnapshot().state, 'ready');
  assert.equal(h.Input.getEffectiveInputGate().allowed, false, 'fresh lease still needs fresh attempt media');
});

test('blur during signaling suspension does not invalidate the preserved lease', () => {
  const h = fixture();
  h.Input.keyboardController.sendText('fixture');
  h.acknowledge(h.sent.at(-1));
  h.disconnect();
  h.Input.resetKeyboard('window-blur');
  assert.equal(h.Input.keyboardTransport.getSnapshot().state, 'ready');
  h.WebRTC.socket.connected = true;
  h.grant();
  h.sent.filter((write) => write.action === 'reset').forEach((write) => h.acknowledge(write));
  assert.equal(h.Input.getEffectiveInputGate().allowed, true);
});

test('all keyboard controller entry points stay blocked during suspension, including mode changes', () => {
  const h = fixture();
  h.disconnect();
  const before = h.sent.length;
  const controller = h.Input.keyboardController;
  assert.equal(controller.sendText('must remain local'), false);
  assert.equal(controller.sendChord({ code: 'KeyA', modifiers: { meta: true } }), false);
  assert.equal(controller.setVirtualModifier('shift', true), false);
  assert.equal(controller.handleDomEvent({ type: 'keydown', code: 'KeyA', key: 'a' }), false);
  controller.handleDomEvent({ type: 'keyup', code: 'KeyA', key: 'a' });
  controller.setMode('windows');
  assert.equal(h.sent.length, before);
  assert.equal(h.Input.keyboardTransport.getSnapshot().state, 'ready');
  h.WebRTC.socket.connected = true;
  h.grant();
  h.sent.slice(before).filter((write) => write.action === 'reset').forEach((write) => h.acknowledge(write));
  assert.equal(h.Input.getEffectiveInputGate().allowed, true);
  assert.equal(controller.getSnapshot().mode, 'windows');
});

test('real revocation and a different regrant discard suspended identity and start fresh sequences', () => {
  for (const revokeFirst of [false, true]) {
    const h = fixture();
    h.Input.keyboardController.sendText('fixture');
    h.acknowledge(h.sent.at(-1));
    h.Input.sendInput('mouse', 'reset', { reason: 'manual' });
    h.acknowledge(h.sent.at(-1));
    h.disconnect();
    if (revokeFirst) h.WebRTC.freezeControl('control-revoked');
    h.WebRTC.socket.connected = true;
    h.grant({ leaseId: 'different-lease', leaseEpoch: 8 });
    assert.equal(h.Input._suspendedControlLease, null);
    assert.equal(h.Input._signalingInputResumePending, false);
    assert.equal(h.Input.keyboardTransport.getSnapshot().lastSent, 0);
    assert.equal(h.Input._desktopWriteSequence, 0);
    assert.equal(h.Input.keyboardController.sendText('fresh'), true);
    assert.equal(h.sent.at(-1).seq, 1);
  }
});

test('new peer readiness replays a failed hidden-tab resume once and requires its ACK plus a fresh frame', () => {
  const h = fixture();
  const w = h.WebRTC;
  Object.assign(w, h.originalMedia);
  h.context.document.hidden = true;
  for (const name of ['startStats', 'startVideoFrameTracking', 'syncMediaProfile',
    'clearFailureRecommendation', 'updateNetworkUI', 'armStableRecoveryReset']) w[name] = () => {};
  w.hasPaintedFrame = false;
  w._mediaReadyConnectionAttemptId = null;
  w.mediaActivityRuntime = MediaActivityRuntime.create({ setTimeoutFn: () => 1, clearTimeoutFn() {} });
  w._mediaIntent = { state: 'active', reasons: [], generation: 8 };
  w.mediaActivityRuntime.beginDesired('active', {
    generation: 8, connectionAttemptId: w.currentConnectionAttemptId,
  });
  const closedAck = { state: 'suspended', generation: 8,
    connectionAttemptId: w.currentConnectionAttemptId, applied: false, reason: 'closed' };
  w.handleMediaActivityAck(closedAck);
  w.handleMediaActivityAck({ ...closedAck, state: 'active' });
  assert.equal(w._mediaRequestRetryUsed, true);
  h.emitted.length = 0;
  w.onPeerConnected();
  w.onPeerConnected();
  assert.equal(h.emitted.filter((event) => event.event === 'media-activity-change').length, 1);
  assert.equal(w.getMediaAppliedPhase(), 'resuming');
  assert.equal(h.Input.isActive, false);
  w.noteMediaRenderedFrame({ source: 'stats', framesDecoded: 20,
    connectionAttemptId: w.currentConnectionAttemptId, pc: w.pc });
  assert.equal(w.getMediaAppliedPhase(), 'resuming', 'frames alone cannot replace the Host ACK');
  w.handleMediaActivityAck({ ...closedAck, state: 'active', applied: true });
  w.noteMediaRenderedFrame({ source: 'video-callback', frameSeq: 21,
    connectionAttemptId: w.currentConnectionAttemptId, pc: w.pc });
  assert.equal(w.getMediaAppliedPhase(), 'active');
  w.notePaintStats({ decodedDelta: 1, receivedDelta: 1, derivedFps: 20, videoWidth: 800 });
  assert.equal(h.Input.isActive, true);
});

test('peer-ready resume does not override manual pause or Terminal suspension', () => {
  for (const reason of ['manual-pause', 'terminal-active']) {
    const h = fixture();
    const w = h.WebRTC;
    Object.assign(w, h.originalMedia);
    h.context.document.hidden = true;
    for (const name of ['startStats', 'startVideoFrameTracking', 'syncMediaProfile',
      'clearFailureRecommendation', 'updateNetworkUI', 'armStableRecoveryReset']) w[name] = () => {};
    w._mediaIntent = { state: 'suspended', reasons: [reason], generation: 8 };
    w.getMediaActivitySnapshot = () => w._mediaIntent;
    w.mediaActivityRuntime = MediaActivityRuntime.create({ setTimeoutFn: () => 1, clearTimeoutFn() {} });
    w.mediaActivityRuntime.beginDesired('suspended', {
      generation: 8, connectionAttemptId: w.currentConnectionAttemptId,
    });
    h.emitted.length = 0;
    w.onPeerConnected();
    assert.equal(h.emitted.filter((event) => event.event === 'media-activity-change').length, 0);
    assert.deepEqual(w._mediaIntent.reasons, [reason]);
    assert.equal(h.Input.isActive, false);
  }
});

test('grant immediately heartbeats and repeated grants keep only one periodic heartbeat', () => {
  const h = fixture({ heartbeat: true });
  const heartbeats = () => h.emitted.filter(e => e.event === 'control-heartbeat');
  assert.equal(heartbeats().length, 1);
  assert.equal(heartbeats()[0].payload.leaseId, h.lease.leaseId);
  assert.equal(heartbeats()[0].payload.leaseEpoch, h.lease.leaseEpoch);
  h.grant();
  assert.equal(heartbeats().length, 2);
  assert.equal(h.intervals.size, 1);
  const timer = [...h.intervals.values()][0];
  assert.equal(timer.ms, 3000);
  timer.fn(); assert.equal(heartbeats().length, 3);
  h.WebRTC.handleControlState({ state: 'FREE', controller: false });
  assert.equal(h.intervals.size, 0);
  timer.fn(); assert.equal(heartbeats().length, 3);
  h.grant(); assert.equal(heartbeats().length, 4);
  const beforeDisconnect = [...h.intervals.values()][0];
  h.disconnect(); assert.equal(h.intervals.size, 0);
  beforeDisconnect.fn(); assert.equal(heartbeats().length, 4);
  h.WebRTC.startControlHeartbeat(); assert.equal(h.intervals.size, 0);
});

test('different lease grant closes a connected peer and negotiates; same lease keeps it', () => {
  const h = fixture();
  let closes = 0;
  let creates = 0;
  let offers = 0;
  const original = h.WebRTC.pc;
  original._wrdControlLease = { ...h.lease };
  original.close = () => { closes += 1; };
  h.WebRTC.createPeerConnection = () => {
    creates += 1;
    h.WebRTC.pc = { connectionState: 'new', _wrdControlLease: { ...h.WebRTC.controlState.lease } };
  };
  h.WebRTC.createOffer = () => { offers += 1; };
  h.grant();
  assert.equal(h.WebRTC.pc, original);
  assert.equal(creates, 0);
  h.grant({ leaseId: 'different-lease', leaseEpoch: 9 });
  assert.equal(closes, 1);
  assert.equal(creates, 1);
  assert.equal(offers, 1);
  h.WebRTC.pc.connectionState = 'connected';
  h.WebRTC.inputChannel = { readyState: 'open' };
  h.grant({ leaseId: 'different-lease', leaseEpoch: 9 });
  assert.equal(creates, 1);
  assert.equal(offers, 1);
});

test('old async offer cannot use replacement peer or send under its lease', async () => {
  const h = fixture();
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  let oldLocal = 0;
  const oldPeer = h.WebRTC.pc;
  oldPeer.getTransceivers = () => [{ mid: '0' }];
  oldPeer.createOffer = async () => { entered(); return waiting; };
  oldPeer.setLocalDescription = async () => { oldLocal += 1; };
  oldPeer.close = () => {};
  h.WebRTC.createPeerConnection = () => { h.WebRTC.pc = { connectionState: 'new' }; };
  const pending = h.originalCreateOffer.call(h.WebRTC);
  await started;
  h.grant({ leaseId: 'new-peer-lease', leaseEpoch: 9 });
  release({ type: 'offer', sdp: 'old' });
  await pending;
  assert.equal(oldLocal, 0);
  assert.equal(h.emitted.filter((event) => event.event === 'offer').length, 0);
  assert.notEqual(h.WebRTC.pc, oldPeer);
});


function reconnectBridge() {
  process.env.JWT_SECRET ||= '12345678';
  process.env.ACCESS_PASSWORD ||= 'test-viewer-password';
  process.env.HOST_PASSWORD ||= 'test-host-password';
  const { FakeSocket, makeIo, resetConnections, grantActiveLease } = require('../../signal-server/websocket/signaling-test-fixture');
  const { setupSignaling } = require('../../signal-server/websocket/signaling');
  resetConnections();
  const h = fixture();
  const io = makeIo();
  let leaseSequence = 0;
  setupSignaling(io, { makeLeaseId: () => `bridge-lease-${++leaseSequence}`,
    scheduler: { setInterval: () => ({ unref() {} }),
      setTimeout: () => ({ unref() {} }), clearTimeout() {} } });
  const host = new FakeSocket('bridge-host', 'host');
  const first = new FakeSocket('bridge-first', 'viewer');
  host.handshake.auth.inputProtocolVersion = 2;
  first.handshake.auth.inputProtocolVersion = 2;
  first.handshake.auth.viewerSessionId = 'bridge-session-0001';
  io.connect(host); io.connect(first);
  const lease = grantActiveLease(io, host, first);
  h.grant(lease);
  h.disconnect(); first.disconnect();
  const replacement = new FakeSocket('bridge-second', 'viewer');
  replacement.handshake.auth.inputProtocolVersion = 2;
  replacement.handshake.auth.viewerSessionId = 'bridge-session-0001';
  io.connect(replacement);
  const handlers = new Map();
  h.WebRTC.socket = { id: replacement.id, connected: true,
    on(event, fn) { handlers.set(event, fn); },
    emit(event, data) { h.emitted.push({ event, payload: data }); replacement.trigger(event, data); } };
  const viewerHandlers = { 'control-state': 'handleControlState', 'control-grant': 'handleControlGrant',
    'control-acquire-result': 'handleControlAcquireResult' };
  const serverEmit = replacement.emit.bind(replacement);
  replacement.emit = (event, data, ack) => {
    const result = serverEmit(event, data, ack);
    if (viewerHandlers[event]) h.WebRTC[viewerHandlers[event]](data);
    return result;
  };
  h.WebRTC.controlState = { state: 'FREE', controller: false, lease: null, hostOnline: true };
  h.WebRTC.setupSocketListeners();
  handlers.get('connected')({ hostOnline: true });
  const rebind = host.sent.find(e => e.event === 'viewer-session-rebind');
  const transitions = () => host.sent.filter(e => e.event === 'control-transition');
  const apply = () => host.trigger('control-transition-ack', {
    leaseEpoch: transitions().at(-1).data.leaseEpoch, status: 'applied' });
  return { ...h, io, host, first, replacement, rebind, transitions, apply, handlers, FakeSocket };
}

for (const outcome of ['rejected', 'timeout']) {
  test(`real Viewer resumes one acquire after Host rebind ${outcome} and authoritative reset FREE`, () => {
    const h = reconnectBridge();
    assert.equal(h.emitted.filter(e => e.event === 'control-acquire').length, 1);
    h.rebind.ack(outcome === 'timeout' ? new Error('timeout') : null, { status: 'rejected' });
    assert.equal(h.transitions().length, 2);
    assert.equal(h.WebRTC.hasActiveControl(), false);
    h.apply();
    assert.equal(h.transitions().length, 3);
    assert.equal(h.emitted.filter(e => e.event === 'control-acquire').length, 2);
    h.apply();
    assert.equal(h.WebRTC.hasActiveControl(), true);
    assert.equal(h.replacement.sent.filter(e => e.event === 'control-grant').length, 1);
    h.rebind.ack(null, { status: 'applied' });
    assert.equal(h.transitions().length, 3);
  });
}

for (const cancel of ['release', 'host-offline', 'superseded', 'socket-replaced']) {
  test(`rebind recovery is cancelled by ${cancel}`, () => {
    const h = reconnectBridge();
    h.rebind.ack(null, { status: 'rejected' });
    if (cancel === 'release') h.WebRTC.releaseControl('manual');
    if (cancel === 'host-offline') h.WebRTC.handleControlState({ state: 'REVOKING', controller: false, hostOnline: false });
    if (cancel === 'superseded') { h.WebRTC._superseded = true; h.WebRTC.freezeControl('viewer-superseded'); }
    if (cancel === 'socket-replaced') h.WebRTC.socket = { ...h.WebRTC.socket, id: 'other-socket' };
    h.apply();
    assert.equal(h.transitions().length, 2);
    assert.equal(h.emitted.filter(e => e.event === 'control-acquire').length, 1);
    assert.equal(h.WebRTC.hasActiveControl(), false);
  });
}

test('missing reset ACK and duplicate FREE cannot replenish acquire budget', () => {
  const h = reconnectBridge();
  h.rebind.ack(null, { status: 'rejected' });
  h.advance(10000);
  assert.equal(h.transitions().length, 2);
  h.apply();
  assert.equal(h.transitions().length, 3);
  h.WebRTC.handleControlState({ state: 'FREE', controller: false, hostOnline: true });
  h.WebRTC.handleControlState({ state: 'FREE', controller: false, hostOnline: true });
  assert.equal(h.transitions().length, 3);
  assert.equal(h.emitted.filter(e => e.event === 'control-acquire').length, 2);
});

test('expired reset survives four-second signaling outage and same-lease regrant releases once', () => {
  const h = fixture();
  h.WebRTC.controlState.hostOnline = true;
  h.Input._markMobileSurfaceUncertain('test');
  h.Input.requestInputRecovery({ source: 'auto' });
  const oldResets = h.sent.filter(e => e.action === 'reset');
  h.disconnect(); h.advance(4000);
  assert.equal(h.Input.keyboardTransport.getSnapshot().state, 'reacquire-required');
  h.WebRTC.socket.connected = true;
  h.grant();
  assert.equal(h.WebRTC.hasActiveControl(), false);
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  assert.equal(h.emitted.filter(e => e.event === 'control-release').length, 1);
  oldResets.forEach(e => h.acknowledge(e));
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  assert.equal(h.emitted.filter(e => e.event === 'control-acquire').length, 0);
  h.WebRTC.handleControlState({ state: 'FREE', controller: false, hostOnline: true });
  h.WebRTC.handleControlState({ state: 'FREE', controller: false, hostOnline: true });
  assert.equal(h.emitted.filter(e => e.event === 'control-acquire').length, 1);
});

test('new socket claims fresh reset IDs and rejects old socket or cumulative ACK ownership', () => {
  const h = fixture();
  h.Input._markMobileSurfaceUncertain('test');
  h.Input.requestInputRecovery({ source: 'auto' });
  const old = h.sent.filter(e => e.action === 'reset');
  h.disconnect();
  h.WebRTC.socket = { ...h.WebRTC.socket, connected: true, id: 'replacement' };
  h.grant();
  const fresh = h.sent.filter(e => e.action === 'reset').slice(2);
  assert.equal(fresh.length, 2);
  assert.ok(fresh.every(e => !old.some(o => o.inputIds[0] === e.inputIds[0])));
  for (const write of old) h.acknowledge({ ...write, seq: 100 });
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  const keyboard = fresh.find(e => e.type === 'keyboard');
  assert.equal(h.Input.acceptKeyboardAck({ schemaVersion: 2, inputType: 'keyboard',
    leaseEpoch: 7, appliedSeq: keyboard.seq, status: 'applied' }).status, 'stale');
  h.acknowledge(fresh[0]);
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  h.acknowledge(fresh[1]);
  assert.equal(h.Input.getEffectiveInputGate().allowed, true);
});


test('late acquire result and grant cannot restore a manually released intent', () => {
  const h = reconnectBridge();
  const requestId = h.emitted.find(e => e.event === 'control-acquire').payload.requestId;
  h.WebRTC.releaseControl('manual');
  h.WebRTC.handleControlAcquireResult({ requestId, state: 'REVOKING', reason: 'reset-in-progress' });
  h.rebind.ack(null, { status: 'applied' });
  assert.equal(h.WebRTC.hasActiveControl(), false);
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  h.apply();
  assert.equal(h.emitted.filter(e => e.event === 'control-acquire').length, 1);
});

test('old Host callback cannot resume acquire after replacement Host arrived', () => {
  const h = reconnectBridge();
  const nextHost = new h.FakeSocket('replacement-host', 'host');
  nextHost.handshake.auth.inputProtocolVersion = 2;
  h.io.connect(nextHost);
  const before = h.emitted.filter(e => e.event === 'control-acquire').length;
  h.rebind.ack(null, { status: 'applied' });
  h.rebind.ack(null, { status: 'rejected' });
  assert.equal(h.WebRTC.hasActiveControl(), false);
  assert.equal(h.emitted.filter(e => e.event === 'control-acquire').length, before);
});

function mediaScopeFixture() {
  const h = fixture();
  const w = h.WebRTC;
  w.mediaActivityRuntime = MediaActivityRuntime.create({ setTimeoutFn: () => 1, clearTimeoutFn() {} });
  w.setUiPhase = () => {};
  w.ensureFrameTraceCollector = () => ({ resetScope() {} });
  w.ensureMediaResumeFallbackArmed = () => {};
  const desired = (generation) => {
    w._mediaIntent = { state: 'active', reasons: [], generation };
    w.mediaActivityRuntime.beginDesired('active', { generation, connectionAttemptId: w.currentConnectionAttemptId });
    w.captureMediaResumeBaseline(generation);
  };
  const ack = (generation, attempt = w.currentConnectionAttemptId) => w.handleMediaActivityAck({
    state: 'active', applied: true, generation, connectionAttemptId: attempt,
  });
  const frame = (frameSeq, extra = {}) => w.noteMediaRenderedFrame({
    source: 'video-callback', frameSeq, connectionAttemptId: w.currentConnectionAttemptId, pc: w.pc, ...extra,
  });
  return { ...h, desired, ack, frame };
}

// Relay fixtures authenticate an exact M6 origin before exercising real image loads.
function relayMediaScopeFixture() {
  const h = mediaScopeFixture();
  const w = h.WebRTC;
  const fields = (generation, producerId) => ({
    relayFrameSchemaVersion: 1,
    relayScope: {
      producerId, productionGeneration: generation + 1,
      connectionAttemptId: w.currentConnectionAttemptId,
      mediaGeneration: generation, leaseEpoch: w.controlState.lease.leaseEpoch,
    },
  });
  const relayAck = (origin) => w.handleMediaActivityAck({
    ...origin, state: 'active', applied: true,
    generation: origin.relayScope.mediaGeneration,
    connectionAttemptId: origin.relayScope.connectionAttemptId,
  });
  const relayFrame = (origin, frameId) => w.handleRelayFrame({
    ...origin, frameId, data: 'AAAA',
    connectionAttemptId: origin.relayScope.connectionAttemptId,
  });
  const image = h.context.document.getElementById('relayImage');
  return { ...h, fields, relayAck, relayFrame, image };
}

test('new attempt cannot borrow previous active ACK or pending fresh frame', () => {
  const h = mediaScopeFixture();
  const w = h.WebRTC;
  h.desired(8); h.ack(8);
  const oldAttempt = w.currentConnectionAttemptId;
  w.beginConnectionAttempt('test-attempt');
  assert.equal(w._mediaResumeFramePending, false);
  assert.equal(w._mediaResumeBaseline, null);
  h.desired(8);
  h.frame(1);
  assert.notEqual(w.getMediaAppliedPhase(), 'active');
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  h.ack(8, oldAttempt);
  assert.notEqual(w.getMediaAppliedPhase(), 'active');
  h.ack(7);
  assert.notEqual(w.getMediaAppliedPhase(), 'active');
  // A genuine post-baseline frame in B can precede B's ACK and is consumed once.
  h.ack(8);
  assert.equal(w.getMediaAppliedPhase(), 'active');
  assert.equal(h.frame(2), false);
});

test('resume rejects obsolete PC, generation, relay cache and metrics proof', () => {
  const h = mediaScopeFixture();
  const w = h.WebRTC;
  h.desired(8); h.frame(1);
  const oldPc = w.pc;
  w.pc = { connectionState: 'connected' };
  h.ack(8);
  assert.notEqual(w.getMediaAppliedPhase(), 'active');
  assert.equal(h.frame(2, { pc: oldPc }), false);
  h.desired(9);
  w._lastRenderedRelayFrame = { frameSeq: 99, connectionAttemptId: w.currentConnectionAttemptId };
  h.ack(9);
  assert.notEqual(w.getMediaAppliedPhase(), 'active');
  assert.equal(h.frame(3, { generation: 8 }), false);
  assert.equal(h.frame(null, { source: 'stats', framesDecoded: 100 }), false);
  assert.notEqual(w.getMediaAppliedPhase(), 'active');
  h.frame(4);
  assert.equal(w.getMediaAppliedPhase(), 'active');
});

test('same-scope relay frame before active ACK unlocks only after ACK', () => {
  const h = mediaScopeFixture();
  h.WebRTC.networkMode = 'tunnel';
  h.desired(8);
  h.frame(1, { source: 'relay-frame' });
  assert.notEqual(h.WebRTC.getMediaAppliedPhase(), 'active');
  h.ack(8);
  assert.equal(h.WebRTC.getMediaAppliedPhase(), 'active');
});

test('new control lease invalidates old tunnel ACK even after control freeze clears lease', () => {
  const h = mediaScopeFixture();
  const w = h.WebRTC;
  w.networkMode = 'tunnel';
  w.startTunnelRelay = () => {};
  h.desired(8); h.ack(8);
  const oldAttempt = w.currentConnectionAttemptId;
  w.freezeControl('control-revoked', false);
  h.grant({ leaseId: 'next-media-lease', leaseEpoch: 9 });
  assert.notEqual(w.currentConnectionAttemptId, oldAttempt);
  assert.equal(w._mediaResumeFramePending, false);
  h.desired(8); h.frame(1, { source: 'relay-frame' });
  h.ack(8, oldAttempt);
  assert.equal(w.getMediaAppliedPhase(), 'resuming');
  h.ack(8);
  assert.equal(w.getMediaAppliedPhase(), 'active');
});

test('old rVFC callback cannot paint or release a replacement PC', () => {
  const h = mediaScopeFixture();
  const w = h.WebRTC;
  const callbacks = [];
  const video = h.context.document.getElementById('remoteVideo');
  video.requestVideoFrameCallback = fn => { callbacks.push(fn); return callbacks.length; };
  video.cancelVideoFrameCallback = () => {};
  w.startVideoFrameTracking();
  const oldCallback = callbacks[0];
  w.pc = { connectionState: 'connected' };
  w.startVideoFrameTracking();
  h.desired(8); h.ack(8);
  const seq = w._videoFrameSeq;
  oldCallback(100, {});
  assert.equal(w._videoFrameSeq, seq);
  assert.equal(w.getMediaAppliedPhase(), 'resuming');
  h.frame(1);
  assert.equal(w.getMediaAppliedPhase(), 'active');
});

test('relay image load retained across attempt or producer replacement has no authority', () => {
  const h = relayMediaScopeFixture();
  const w = h.WebRTC;
  w.networkMode = 'tunnel'; w.tunnelRelayActive = true;
  h.desired(8);
  const original = h.fields(8, 'original-producer');
  h.relayAck(original);
  h.relayFrame(original, 1);
  const load = h.image.onload;
  assert.equal(typeof load, 'function');
  w.beginConnectionAttempt('test-relay-attempt');
  h.desired(8);
  const replacementAttempt = h.fields(8, 'replacement-attempt-producer');
  h.relayAck(replacementAttempt);
  load();
  assert.equal(w.getMediaAppliedPhase(), 'resuming');
  assert.equal(w._lastRenderedRelayFrame, null);
  h.relayFrame(replacementAttempt, 2);
  const oldProducerLoad = h.image.onload;
  assert.equal(typeof oldProducerLoad, 'function');
  w._mediaRelayRevision = 1;
  h.desired(9);
  const replacementProducer = h.fields(9, 'replacement-producer');
  h.relayAck(replacementProducer);
  oldProducerLoad();
  assert.equal(w.getMediaAppliedPhase(), 'resuming');
  assert.equal(w._lastRenderedRelayFrame, null);
  h.relayFrame(replacementProducer, 3);
  assert.equal(w.getMediaAppliedPhase(), 'resuming', 'arrival alone cannot prove a loaded image');
  assert.equal(typeof h.image.onload, 'function');
  h.image.onload();
  assert.equal(w.getMediaAppliedPhase(), 'active');
});

test('user pause rejects late frames and ACK then needs new resume proof', () => {
  const h = mediaScopeFixture();
  const w = h.WebRTC;
  h.desired(8); h.frame(1);
  w._mediaIntent = { state: 'suspended', reasons: ['manual-pause'], generation: 9 };
  w.mediaActivityRuntime.beginDesired('suspended', { generation: 9, connectionAttemptId: w.currentConnectionAttemptId });
  w.handleMediaActivityAck({ state: 'suspended', generation: 9, connectionAttemptId: w.currentConnectionAttemptId, applied: true });
  h.ack(8); h.frame(2);
  assert.equal(w.getMediaAppliedPhase(), 'suspended');
  assert.equal(w._mediaResumeEarlyFrame, null);
  h.desired(10); h.ack(10);
  assert.equal(w.getMediaAppliedPhase(), 'resuming');
  h.frame(3);
  assert.equal(w.getMediaAppliedPhase(), 'active');
});

test('real tunnel refresh establishes local relay and waits for current ACK plus loaded frame', () => {
  const h = relayMediaScopeFixture();
  const w = h.WebRTC;
  w.replayMediaActivityIntent = h.originalMedia.replayMediaActivityIntent;
  w.networkMode = 'tunnel'; w.tunnelRelayActive = true; w.pc = null;
  w.bindCurrentConnectionAttempt = h.originalBindAttempt;
  w.stopMediaTelemetry = () => {};
  w.captureLastFrameHold = () => false;
  w.updateNetworkUI = () => {};
  h.desired(8);
  const original = h.fields(8, 'before-refresh-producer');
  h.relayAck(original);
  h.relayFrame(original, 1);
  assert.equal(typeof h.image.onload, 'function');
  h.image.onload();
  assert.equal(w.getMediaAppliedPhase(), 'active');
  const oldAttempt = w.currentConnectionAttemptId;
  w.refresh({ reason: 'manual' });
  assert.notEqual(w.currentConnectionAttemptId, oldAttempt);
  assert.equal(w.tunnelRelayActive, true);
  assert.equal(w.getMediaAppliedPhase(), 'resuming');
  const request = h.emitted.filter(e => e.event === 'relay-stream-control' && e.payload.mediaControlSchemaVersion === 1).at(-1).payload;
  assert.equal(request.enabled, true);
  assert.equal(request.connectionAttemptId, w.currentConnectionAttemptId);
  h.relayAck(original);
  h.relayFrame(original, 2);
  assert.equal(h.image.onload, null, 'old-origin frame cannot install a load callback');
  assert.equal(w._relayExpectedScope, null, 'old-origin ACK cannot authenticate the replacement');
  assert.equal(w.getMediaAppliedPhase(), 'resuming');
  const replacement = h.fields(request.generation, 'after-refresh-producer');
  h.relayFrame(replacement, 1);
  assert.equal(h.image.onload, null, 'current frame before authenticated ACK is rejected');
  h.relayAck(replacement);
  assert.equal(w.relayScopeMatches(replacement.relayScope), true);
  assert.equal(w.getMediaAppliedPhase(), 'resuming', 'ACK alone cannot prove a loaded image');
  h.relayFrame(replacement, 1);
  const loaded = h.image.onload;
  assert.equal(typeof loaded, 'function');
  assert.equal(w.getMediaAppliedPhase(), 'resuming', 'arrival alone cannot prove a loaded image');
  loaded();
  assert.equal(w.getMediaAppliedPhase(), 'active');
});

for (const retainedAttempt of [false, true]) {
test(`real failed-PC replacement/replay rejects old ACK and retains early frame (retained attempt=${retainedAttempt})`, async () => {
  const h = mediaScopeFixture();
  const w = h.WebRTC;
  w.replayMediaActivityIntent = h.originalMedia.replayMediaActivityIntent;
  w.networkMode = 'direct';
  w.bindCurrentConnectionAttempt = h.originalBindAttempt;
  w.createOffer = h.originalCreateOffer;
  w.createInputChannel = () => {};
  w.updateNetworkUI = () => {};
  h.context.RTCPeerConnection = class {
    constructor() { this.connectionState = 'new'; }
    close() { this.connectionState = 'closed'; }
    getTransceivers() { return [{ receiver: { track: { kind: 'video' } } }]; }
    async createOffer() { return { type: 'offer', sdp: 'offline-only' }; }
    async setLocalDescription(offer) { this.localDescription = offer; }
  };
  w.pc.close = function () { this.connectionState = 'closed'; };
  w.pc._wrdConnectionAttemptId = w.currentConnectionAttemptId;
  if (retainedAttempt) w.beginConnectionAttempt('retained-peer-attempt');
  h.desired(8);
  w.replayMediaActivityIntent('old-peer-request');
  const oldRequest = h.emitted.filter(e => e.event === 'media-activity-change').at(-1).payload;
  const oldPc = w.pc;
  oldPc.connectionState = 'failed';
  h.grant(); // Actual same-lease grant calls createPeerConnection, createOffer and replay.
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(w.pc, oldPc);
  const request = h.emitted.filter(e => e.event === 'media-activity-change').at(-1).payload;
  assert.notEqual(request.connectionAttemptId, oldRequest.connectionAttemptId);
  assert.equal(h.emitted.filter(e => e.event === 'offer').at(-1).payload.connectionAttemptId, request.connectionAttemptId);
  const bound = h.emitted.findIndex(e => e.event === 'connection-attempt-bind' && e.payload.connectionAttemptId === request.connectionAttemptId);
  const requested = h.emitted.findIndex(e => e.event === 'media-activity-change' && e.payload.connectionAttemptId === request.connectionAttemptId);
  assert.ok(bound >= 0 && bound < requested, 'replacement attempt is bound before its media replay');
  w.handleMediaActivityAck({ ...oldRequest, applied: true });
  h.frame(1);
  assert.equal(w.getMediaAppliedPhase(), 'resuming');
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  w.handleMediaActivityAck({ ...request, applied: true });
  assert.equal(w.getMediaAppliedPhase(), 'active');
});

}


test('stable same-value activation deduplicates keyboard DOM and still runs recovery each time', () => {
  const h = fixture();
  h.sent.filter(write => write.action === 'reset').forEach(write => h.acknowledge(write));
  const writes = [];
  const ids = ['keyInputDisplay', 'mobileTextInputBtn', 'mobileInputStatus',
    'mobileInputRetryBtn', 'mobileInputDiscardBtn', 'inputRecoveryNotice',
    'inputRecoveryNoticeStatus', 'inputRecoveryNoticeText', 'inputRecoveryRetryBtn',
    'inputRecoveryControlBtn', 'inputRecoveryDraftBtn'];
  const instrument = (node) => {
    for (const key of ['textContent', 'hidden', 'disabled']) {
      let value = node[key];
      Object.defineProperty(node, key, { configurable: true,
        get() { return value; }, set(next) { value = next; writes.push([key, next]); } });
    }
    const attrs = new Map();
    node.getAttribute = key => attrs.get(key) ?? null;
    node.setAttribute = (key, value) => { attrs.set(key, value); writes.push([key, value]); };
    const data = node.dataset;
    node.dataset = new Proxy(data, { set(target, key, value) { target[key] = value; writes.push([key, value]); return true; } });
    return node;
  };
  ids.forEach(id => instrument(h.context.document.getElementById(id)));
  const recoveryEpochs = [];
  h.Input._maybeAutoRecover = () => { recoveryEpochs.push(h.Input.activeControlLease.leaseEpoch); };
  h.Input.setActive(true);
  const before = writes.length;
  assert.ok(before > 0);
  for (let i = 0; i < 200; i++) h.Input.setActive(true);
  assert.equal(recoveryEpochs.length, 201);
  assert.equal(writes.length, before);
  const display = h.context.document.getElementById('keyInputDisplay');
  assert.equal(display.dataset.state, 'READY');
  h.Input.activeControlLease = { ...h.Input.activeControlLease, leaseEpoch: 8 };
  h.Input.setActive(true);
  assert.equal(recoveryEpochs.at(-1), 8, 'same active value must still observe a new lease epoch');
  const controllerSnapshot = h.Input.keyboardController.getSnapshot.bind(h.Input.keyboardController);
  h.Input.keyboardController.getSnapshot = () => ({ ...controllerSnapshot(), state: 'RESET_REQUIRED' });
  h.Input.updateKeyboardUI();
  assert.equal(display.dataset.state, 'RESET_REQUIRED');
  h.Input.keyboardController.getSnapshot = controllerSnapshot;
  h.Input._recoveryCycle = { ...h.Input._recoveryCycle, state: 'waiting' };
  h.Input.updateKeyboardUI();
  assert.equal(display.dataset.state, 'BLOCKED');
  assert.ok(writes.length > before);
  const afterRecovery = writes.length;
  h.Input.mobileTextInputAdapter = { getSnapshot: () => ({ status: 'uncertain', hasPending: true, deliveryUncertain: true }) };
  h.Input.updateKeyboardUI();
  assert.equal(h.context.document.getElementById('inputRecoveryDraftBtn').hidden, false);
  assert.ok(writes.length > afterRecovery);
  const replacement = instrument({ dataset: {}, classList: {}, setAttribute() {} });
  const originalLookup = h.context.document.getElementById;
  h.context.document.getElementById = id => id === 'keyInputDisplay' ? replacement : originalLookup(id);
  h.Input.updateKeyboardUI();
  assert.equal(replacement.dataset.state, 'BLOCKED');
});

const { validateRemoteInput } = require('../../signal-server/lib/remote-input-contract.js');

function readyRelayResetFixture() {
  const h = relayMediaScopeFixture();
  h.lease.leaseId = 'offline-valid-lease-id';
  h.grant(h.lease);
  h.WebRTC.networkMode = 'tunnel';
  h.WebRTC.tunnelRelayActive = true;
  h.desired(8);
  h.origin = h.fields(8, 'reset-producer');
  h.relayAck(h.origin);
  h.relayFrame(h.origin, 1);
  h.image.onload();
  h.Input.setActive(true);
  assert.equal(h.Input.isActive, true);
  h.lifecycle = [];
  const record = h.Input._recordInputTrace.bind(h.Input);
  h.Input._recordInputTrace = (stage, meta) => {
    if (stage === 'lifecycle') h.lifecycle.push(meta);
    return record(stage, meta);
  };
  return h;
}

function assertValidRelayReset(h, reason) {
  const write = h.sent.filter(write => write.type === 'keyboard' && write.action === 'reset').at(-1);
  assert.ok(write, 'actual KeyboardTransport emitted reset');
  const { channel, ...wire } = write;
  const validation = validateRemoteInput(wire);
  assert.equal(validation.ok, true, JSON.stringify(validation));
  assert.equal(write.payload.reason, 'deactivated');
  assert.equal(write.leaseId, h.lease.leaseId);
  assert.equal(write.leaseEpoch, 7);
  assert.ok(Number.isInteger(write.seq) && write.seq > 0);
  assert.ok(write.inputIds.length > 0);
  assert.equal(h.Input.lastKeyboardResetReason, 'deactivated');
  assert.ok(h.lifecycle.some(event => event.action === 'inactive' && event.reason === reason));
  return write;
}

for (const frameFirst of [false, true]) {
  test(`relay reset protocol: real stale timer keeps independent media/reset barriers (frame first=${frameFirst})`, () => {
    const h = readyRelayResetFixture();
    const phases = [];
    h.WebRTC.setUiPhase = (phase, meta) => phases.push({ phase, ...meta });
    h.WebRTC.updateNetworkUI = () => {};
    h.advance(5000);
    assert.equal(h.WebRTC._relayFrameStale, true);
    assert.ok(phases.some(p => p.reason === 'relay-frame-stale'));
    const reset = assertValidRelayReset(h, 'relay-frame-stale');
    assert.equal(reset.seq, 1);
    assert.equal(h.Input.getEffectiveInputGate().allowed, false);
    const oldAck = { ...reset, inputIds: ['old-reset'] };
    assert.equal(h.acknowledge(oldAck).status, 'stale');
    assert.equal(h.Input.getEffectiveInputGate().allowed, false);
    assert.equal(h.acknowledge({ ...reset, leaseEpoch: 6 }).status, 'stale');
    assert.equal(h.Input.getEffectiveInputGate().allowed, false);
    const fresh = () => { h.relayFrame(h.origin, 2); h.image.onload(); };
    if (frameFirst) fresh(); else h.acknowledge(reset);
    assert.equal(h.Input.getEffectiveInputGate().allowed, false);
    if (frameFirst) h.acknowledge(reset); else fresh();
    assert.equal(h.Input.getEffectiveInputGate().allowed, true);
  });
}

test('relay reset protocol: actual relay-start invalidation emits accepted reset and preserves local reason', () => {
  const h = readyRelayResetFixture();
  h.WebRTC.pc = null;
  h.WebRTC.stopMediaTelemetry = () => {};
  h.WebRTC.updateNetworkUI = () => {};
  h.WebRTC.startTunnelRelay({ sendRequest: false });
  assertValidRelayReset(h, 'relay-start');
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
});

test('relay reset protocol: inactive pressed keyboard resets but clean inactive keyboard does not', () => {
  const h = readyRelayResetFixture();
  assert.equal(h.Input.keyboardController.handleDomEvent({ type: 'keydown', code: 'KeyA', key: 'a' }), true);
  h.acknowledge(h.sent.at(-1));
  h.Input.setActive(false, { resetKeyboard: false, reason: 'test-inactive' });
  assert.equal(h.Input.keyboardController.getSnapshot().pressedKeyCount, 1);
  h.WebRTC.invalidateRelayInputProof('relay-start');
  const reset = assertValidRelayReset(h, 'relay-start');
  assert.equal(reset.seq, 2);
  assert.equal(h.Input.keyboardController.getSnapshot().state, 'RESET_REQUIRED');
  h.WebRTC.invalidateRelayInputProof('relay-frame-stale');
  const requiredReset = assertValidRelayReset(h, 'relay-frame-stale');
  assert.equal(requiredReset.seq, reset.seq, 'pending reset barrier is coalesced');
  assert.deepEqual(requiredReset.inputIds, reset.inputIds);
  h.acknowledge(requiredReset);
  const before = h.sent.length;
  h.WebRTC.invalidateRelayInputProof('relay-start');
  assert.equal(h.sent.length, before);
});

test('Input reset metadata preserves default and explicit no-reset policy', () => {
  const h = fixture();
  h.Input.setActive(true);
  h.Input.setActive(false, { resetKeyboard: false, reason: 'window-blur', keyboardResetReason: 'deactivated' });
  assert.equal(h.sent.length, 0);
  h.Input.setActive(true);
  h.Input.setActive(false, { resetKeyboard: true, reason: 'window-blur' });
  assert.equal(h.sent.at(-1).payload.reason, 'window-blur');
  h.acknowledge(h.sent.at(-1));
  h.Input.setActive(true);
  const before = h.sent.length;
  h.Input.setActive(false);
  assert.equal(h.sent.length, before, 'default with a control lease does not reset');
});

function readyControlResetFixture() {
  const h = fixture();
  h.lease.leaseId = 'offline-valid-control-lease';
  h.grant(h.lease);
  h.Input.setActive(true);
  h.pointerReasons = [];
  const releasePointer = h.Input.releasePointer.bind(h.Input);
  h.Input.releasePointer = reason => { h.pointerReasons.push(reason); return releasePointer(reason); };
  h.lifecycle = [];
  const record = h.Input._recordInputTrace.bind(h.Input);
  h.Input._recordInputTrace = (stage, meta) => {
    if (stage === 'lifecycle') h.lifecycle.push(meta);
    return record(stage, meta);
  };
  return h;
}

function assertControlReset(h, wireReason, localReason) {
  const resets = h.sent.filter(write => write.type === 'keyboard' && write.action === 'reset');
  assert.equal(resets.length, 1);
  const { channel, ...wire } = resets[0];
  const validation = validateRemoteInput(wire);
  assert.equal(validation.ok, true, JSON.stringify(validation));
  assert.equal(wire.payload.reason, wireReason);
  assert.equal(wire.leaseId, h.lease.leaseId);
  assert.equal(wire.leaseEpoch, h.lease.leaseEpoch);
  assert.equal(wire.seq, 1);
  assert.equal(wire.inputIds.length, 1);
  const emitted = h.emitted.find(e => e.event === 'input' && e.payload.type === 'keyboard');
  assert.deepEqual(emitted.payload.inputIds, wire.inputIds);
  assert.equal(h.Input.lastKeyboardResetReason, wireReason);
  assert.ok(h.lifecycle.some(e => e.action === 'inactive' && e.reason === localReason));
  assert.ok(h.pointerReasons.includes(localReason));
  assert.equal(h.Input.activeControlLease, null);
  assert.equal(h.Input.keyboardTransport.getSnapshot().state, 'revoked');
  assert.equal(h.acknowledge(wire).status, 'stale');
  assert.equal(h.WebRTC.hasActiveControl(), false);
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  return wire;
}

test('control reset protocol: actual recovery control button sends accepted reset before original release', () => {
  const h = readyControlResetFixture();
  h.Input.setupInputRecoveryUi();
  h.context.document.getElementById('inputRecoveryControlBtn').listeners.click({ preventDefault() {}, stopPropagation() {} });
  const wire = assertControlReset(h, 'deactivated', 'input-recovery-user');
  const resetIndex = h.emitted.findIndex(e => e.event === 'input' && e.payload.type === 'keyboard');
  const releaseIndex = h.emitted.findIndex(e => e.event === 'control-release');
  assert.ok(resetIndex >= 0 && releaseIndex > resetIndex);
  assert.equal(h.emitted[releaseIndex].payload.reason, 'input-recovery-user');
  assert.deepEqual(h.emitted[resetIndex].payload.inputIds, wire.inputIds);
});

for (const reason of ['host-offline', 'control-heartbeat-rejected', undefined]) {
  test(`control reset protocol: real freeze preserves diagnostic reason (${reason})`, () => {
    const h = readyControlResetFixture();
    h.WebRTC.freezeControl(reason);
    assertControlReset(h, 'control-revoked', reason || 'control-lost');
    assert.equal(h.emitted.some(e => e.event === 'control-release'), false);
  });
}

test('control reset protocol: suspension and explicit skip policies emit no keyboard reset', () => {
  for (const mode of ['suspend', 'reset-false', 'preserve-intent']) {
    const h = readyControlResetFixture();
    if (mode === 'suspend') h.disconnect();
    else if (mode === 'reset-false') h.WebRTC.freezeControl('host-offline', false);
    else h.WebRTC.releaseControl('input-recovery-timeout', { preserveAcquireIntent: true });
    assert.equal(h.sent.some(e => e.type === 'keyboard' && e.action === 'reset'), false, mode);
    assert.equal(h.Input.activeControlLease, null);
    if (mode === 'suspend') assert.equal(h.Input._suspendedControlLease.leaseId, h.lease.leaseId);
    assert.equal(h.WebRTC.hasActiveControl(), false);
    assert.equal(h.Input.keyboardTransport.getSnapshot().state, mode === 'suspend' ? 'ready' : 'revoked');
  }
});

test('initial answer after 8s and current painted frame enables actual Input with unchanged active lease', async () => {
  const h = fixture();
  const w = h.WebRTC;
  w.hasPaintedFrame = false;
  w._mediaReadyConnectionAttemptId = null;
  w.uiPhase = 'signaling';
  w.syncDesktopInputGate();
  const listeners = {};
  w.socket.on = (event, fn) => { listeners[event] = fn; };
  h.context.RTCSessionDescription = function (value) { return value; };
  w.pc.signalingState = 'have-local-offer';
  w.pc.connectionState = 'connecting';
  w.pc.setRemoteDescription = async function (answer) { this.remoteDescription = answer; this.signalingState = 'stable'; };
  w.beginStartupEpisode?.();
  w.setupSocketListeners();
  const socket = w.socket, peer = w.pc, attempt = w.currentConnectionAttemptId;
  const lease = w.controlState.lease;
  w.beginFirstFrameDeadline(attempt, 8000);
  h.advance(9000);
  await listeners.answer({ answer: { type: 'answer', sdp: 'offline' } });
  assert.equal(peer.remoteDescription.type, 'answer');
  peer.connectionState = 'connected';
  w.setUiPhase('media-pending', { reason: 'pc-connected' });
  let paint;
  const video = h.context.document.getElementById('remoteVideo');
  video.videoWidth = 1280;
  video.requestVideoFrameCallback = (fn) => { paint = fn; return 1; };
  w.startVideoFrameTracking();
  paint(10000, {});
  assert.equal(w.socket, socket);
  assert.equal(w.pc, peer);
  assert.equal(w.controlState.lease, lease);
  assert.equal(w.hasActiveControl(), true);
  assert.equal(w.isCurrentAttemptMediaReady(attempt), true);
  assert.equal(w.hasPaintedFrame, true);
  assert.equal(h.Input.getEffectiveInputGate().allowed, true);
  assert.equal(h.Input.isActive, true);
  assert.equal(w.uiPhase, 'connected');
});

function startupFixture() {
  const h = fixture();
  const w = h.WebRTC;
  w.hasPaintedFrame = false;
  w._mediaReadyConnectionAttemptId = null;
  w.uiPhase = 'signaling';
  w.syncDesktopInputGate();
  w.pc.connectionState = 'connecting';
  w.pc.close = () => { h.closed = (h.closed || 0) + 1; };
  w.socket.disconnect = () => { h.disconnected = (h.disconnected || 0) + 1; };
  w.beginStartupEpisode();
  w.beginFirstFrameDeadline(w.currentConnectionAttemptId);
  h.paint = (width = 1280) => {
    let callback;
    const video = h.context.document.getElementById('remoteVideo');
    video.videoWidth = width;
    video.requestVideoFrameCallback = (fn) => { callback = fn; return 1; };
    w.startVideoFrameTracking();
    callback(h.context.performance.now(), {});
    return callback;
  };
  h.connect = () => {
    w.pc.connectionState = 'connected';
    w.onPeerConnected();
  };
  return h;
}

test('startup supervision: 8s is soft, 72s is terminal exactly once without logout or mode change', () => {
  const h = startupFixture(), w = h.WebRTC;
  const mode = w.networkMode;
  let logout = 0;
  h.context.Auth = { logout() { logout++; } };
  h.advance(8000);
  assert.equal(w._startupEpisode.state, 'slow');
  assert.equal(w.uiPhase, 'signaling');
  assert.equal(h.Input.isActive, false);
  assert.equal(w.recommendationState?.nextSuggestedMode ?? null, null);
  h.advance(63999);
  assert.equal(w._startupEpisode.state, 'slow');
  h.advance(1);
  assert.equal(w._startupEpisode.state, 'failed');
  assert.equal(w._startupEpisode.reason, 'startup-media-timeout');
  assert.equal(w.uiPhase, 'disconnected');
  assert.equal(h.closed, 1);
  assert.equal(h.disconnected, 1);
  w.checkStartupEpisode();
  w.scheduleSignalingRecovery();
  w.createPeerConnection();
  assert.equal(h.closed, 1);
  assert.equal(w.pc, null);
  assert.equal(w.socket, null);
  assert.equal(logout, 0);
  assert.equal(w.networkMode, mode);
});

test('startup supervision: DC open and duplicate connected events cannot cancel or reset 12s paint cap', () => {
  const h = startupFixture(), w = h.WebRTC;
  h.advance(29000);
  h.connect();
  const paint = w._startupEpisode.paint;
  assert.equal(paint.remaining, 12000);
  w.cancelDataChannelWatchdog(false);
  h.advance(11000);
  h.connect();
  assert.equal(w._startupEpisode.paint, paint);
  assert.equal(paint.remaining, 1000);
  h.advance(1000);
  assert.equal(w._startupEpisode.reason, 'startup-paint-timeout');
  assert.equal(w.uiPhase, 'disconnected');
});

test('startup supervision: hidden and intentional pause retain exact active budget over repeated cycles', () => {
  const h = startupFixture(), w = h.WebRTC;
  h.connect();
  h.advance(5000);
  h.context.document.hidden = true;
  w.checkStartupEpisode();
  assert.equal(w._startupEpisode.paint.remaining, 7000);
  h.advance(100000);
  assert.equal(w._startupEpisode.paint.remaining, 7000);
  h.context.document.hidden = false;
  w.checkStartupEpisode();
  h.advance(3000);
  w._mediaIntent = { state: 'suspended' };
  w.checkStartupEpisode();
  h.advance(100000);
  assert.equal(w._startupEpisode.paint.remaining, 4000);
  w._mediaIntent = { state: 'active' };
  w.checkStartupEpisode();
  h.advance(3999);
  assert.equal(w._startupEpisode.state, 'slow');
  h.advance(1);
  assert.equal(w._startupEpisode.reason, 'startup-paint-timeout');
});

test('startup supervision: early timer waits remainder; late frame settles expiration before mutating readiness', () => {
  const h = startupFixture(), w = h.WebRTC;
  const wake = h.timers.get(w._startupEpisode.timer).fn;
  wake();
  assert.equal(w._startupEpisode.feedbackRemaining, 8000);
  assert.equal(w._startupEpisode.remaining, 72000);
  const frame = h.paint(0);
  assert.notEqual(w._startupEpisode.state, 'complete');
  h.context.performance.now = () => 73000;
  h.context.document.getElementById('remoteVideo').videoWidth = 1280;
  frame(73000, {});
  assert.equal(w._startupEpisode.state, 'failed');
  assert.equal(w.hasPaintedFrame, false);
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
});

test('startup supervision: invalid/backwards clocks cannot extend active waiting', () => {
  for (const now of [NaN, -1, 999]) {
    const h = startupFixture(), w = h.WebRTC;
    h.context.performance.now = () => now;
    w.checkStartupEpisode();
    assert.equal(w._startupEpisode.state, 'failed');
    assert.equal(w._startupEpisode.remaining, 0);
  }
});

test('startup supervision: PC/attempt replacement inherits outer remainder, paint is bounded by that remainder', () => {
  const h = startupFixture(), w = h.WebRTC;
  h.advance(65000);
  const episode = w._startupEpisode;
  w.beginConnectionAttempt('automatic-retry');
  w.pc = { connectionState: 'connected', close() {} };
  h.connect();
  assert.equal(w._startupEpisode, episode);
  assert.equal(episode.remaining, 7000);
  assert.equal(episode.paint.remaining, 12000);
  h.advance(7000);
  assert.equal(episode.state, 'failed');
});

test('startup supervision: trusted frame before control grant completes media but leaves actual Input closed', () => {
  const h = startupFixture(), w = h.WebRTC;
  w.freezeControl('control-readonly');
  h.paint();
  assert.equal(w._startupEpisode.state, 'complete');
  assert.equal(w.uiPhase, 'connected');
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  assert.equal(h.Input.isActive, false);
  h.advance(80000);
  assert.equal(w._startupEpisode.state, 'complete');
  assert.equal(w.uiPhase, 'connected');
});

test('startup supervision: terminal frame and queued socket events cannot revive failed owner', async () => {
  const h = startupFixture(), w = h.WebRTC;
  const listeners = {};
  w.socket.on = (event, fn) => { listeners[event] = fn; };
  w.setupSocketListeners();
  const frame = h.paint(0);
  h.advance(72000);
  await listeners.connect();
  listeners['host-status']({ online: true });
  listeners['control-grant']({ controller: true, ...h.lease });
  h.context.document.getElementById('remoteVideo').videoWidth = 1280;
  frame(73000, {});
  assert.equal(w.uiPhase, 'disconnected');
  assert.equal(w.pc, null);
  assert.equal(w.hasPaintedFrame, false);
  assert.equal(h.Input.isActive, false);
});

test('startup supervision: host offline retires old media, online retry retains episode allowance', () => {
  const h = startupFixture(), w = h.WebRTC;
  const listeners = {};
  w.socket.on = (event, fn) => { listeners[event] = fn; };
  w.setupSocketListeners();
  const frame = h.paint(0);
  h.advance(5000);
  listeners['host-status']({ online: false });
  assert.equal(w.pc, null);
  const episode = w._startupEpisode;
  h.context.document.getElementById('remoteVideo').videoWidth = 1280;
  frame(6000, {});
  assert.equal(w.hasPaintedFrame, false);
  w.createPeerConnection = () => { w.beginConnectionAttempt('host-online'); w.pc = { connectionState: 'connecting' }; };
  w.requestControl = () => {};
  h.advance(5000);
  listeners['host-status']({ online: true });
  assert.equal(w._startupEpisode, episode);
  assert.equal(episode.remaining, 62000);
  assert.equal(w.uiPhase, 'signaling');
});

test('startup supervision: explicit replacement fences old frame/timer/socket and restarts media allowance only at init', () => {
  const h = startupFixture(), w = h.WebRTC;
  const listeners = {};
  w.socket.on = (event, fn) => { listeners[event] = fn; };
  w.setupSocketListeners();
  const frame = h.paint(0);
  const timer = h.timers.get(w._startupEpisode.timer).fn;
  h.advance(8000);
  const old = w._startupEpisode;
  const next = w.beginStartupEpisode();
  assert.equal(old.state, 'retired');
  assert.equal(next.started, false);
  h.advance(20000);
  frame(29000, {}); timer(); listeners['host-status']({ online: true });
  assert.equal(next.remaining, 72000);
  assert.equal(w.pc, null);
  assert.equal(w.hasPaintedFrame, false);
  w.beginFirstFrameDeadline(w.currentConnectionAttemptId);
  assert.equal(next.started, true);
  assert.equal(next.remaining, 72000);
});

test('startup supervision: tunnel keeps old deadline and completed sessions keep established recovery', () => {
  const h = startupFixture(), w = h.WebRTC;
  h.paint();
  w.networkMode = 'lan';
  w.scheduleReconnect('pc-failed');
  assert.equal(w._startupEpisode.state, 'complete');
  assert.equal(w.uiPhase, 'disconnected');
  assert.ok(w.reconnectTimer);
  const t = fixture(), tunnel = t.WebRTC;
  tunnel.networkMode = 'tunnel';
  tunnel.hasPaintedFrame = false;
  tunnel._mediaReadyConnectionAttemptId = null;
  tunnel.uiPhase = 'signaling';
  tunnel.pc = null;
  tunnel.beginStartupEpisode();
  tunnel.beginFirstFrameDeadline(tunnel.currentConnectionAttemptId);
  assert.equal(tunnel._startupEpisode.started, false);
  t.advance(8000);
  assert.equal(tunnel.uiPhase, 'disconnected');
});

test('startup supervision: pending answer continuation cannot complete after hard expiry', async () => {
  const h = startupFixture(), w = h.WebRTC;
  const handlers = {};
  w.socket.on = (event, fn) => { handlers[event] = fn; };
  h.context.RTCSessionDescription = function (value) { return value; };
  w.pc.signalingState = 'have-local-offer';
  let resolve;
  w.pc.setRemoteDescription = () => new Promise(done => { resolve = done; });
  let finished = 0;
  w.finishDataChannelNegotiation = () => { finished++; };
  w.setupSocketListeners();
  const answer = handlers.answer({ answer: {} });
  h.advance(72000);
  resolve();
  await answer;
  assert.equal(finished, 0);
  assert.equal(w.uiPhase, 'disconnected');
  assert.equal(w.hasPaintedFrame, false);
});

test('startup supervision: first init starts once before awaited config; late config cannot create a producer', async () => {
  const h = fixture(), w = h.WebRTC;
  h.context.Auth = { getToken: () => 'offline-token' };
  w.hasPaintedFrame = false;
  w._mediaReadyConnectionAttemptId = null;
  w.uiPhase = 'signaling';
  let configReady, producers = 0;
  w.loadServerConfig = () => new Promise(resolve => { configReady = resolve; });
  w.createSignalingSocket = () => { producers++; };
  w.createPeerConnection = () => { producers++; };
  w.beginStartupEpisode();
  const start = w.init();
  h.advance(8000);
  assert.equal(w._startupEpisode.state, 'slow');
  assert.equal(w._startupEpisode.remaining, 64000);
  h.advance(64000);
  configReady();
  await start;
  assert.equal(producers, 0);
  assert.equal(w._startupEpisode.state, 'failed');
});

test('startup supervision: success retires initial budget only after positive width and actual frame', () => {
  const h = startupFixture(), w = h.WebRTC;
  h.paint(0);
  assert.equal(w._startupEpisode.state, 'pending');
  assert.equal(h.Input.isActive, false);
  h.advance(9000);
  h.paint(1280);
  assert.equal(w._startupEpisode.state, 'complete');
  assert.equal(h.Input.isActive, true);
  assert.equal(w._startupEpisode.timer, null);
});

test('startup supervision: hidden pending-paint warnings cannot report first-frame failure', () => {
  const h = startupFixture(), w = h.WebRTC;
  const errors = [];
  h.context.Diagnostic = { autoSendFailure: (reason) => errors.push(reason) };
  h.connect();
  h.context.document.hidden = true;
  w.checkStartupEpisode();
  h.advance(80000);
  assert.deepEqual(errors, []);
  assert.equal(w._startupEpisode.state, 'pending');
});

test('startup supervision: connected while hidden starts paint phase and resumes its full unused remainder', () => {
  const h = startupFixture(), w = h.WebRTC;
  h.context.document.hidden = true;
  w.checkStartupEpisode();
  h.connect();
  h.advance(100000);
  assert.equal(w._startupEpisode.paint.remaining, 12000);
  h.context.document.hidden = false;
  w.checkStartupEpisode();
  h.advance(11999);
  assert.equal(w._startupEpisode.state, 'slow');
  h.advance(1);
  assert.equal(w._startupEpisode.reason, 'startup-paint-timeout');
});

test('startup supervision: pending offer completion after cancellation cannot emit or change UI', async () => {
  const h = startupFixture(), w = h.WebRTC;
  let finish, localDescriptions = 0;
  w.pc.getTransceivers = () => [{ receiver: { track: { kind: 'video' } } }];
  w.pc.createOffer = () => new Promise(resolve => { finish = resolve; });
  w.pc.setLocalDescription = async () => { localDescriptions++; };
  const offer = h.originalCreateOffer.call(w);
  w.retireStartupEpisode('startup-cancelled', { cleanup: true });
  finish({ type: 'offer' });
  await offer;
  assert.equal(localDescriptions, 0);
  assert.equal(h.emitted.filter(item => item.event === 'offer').length, 0);
  assert.equal(w.uiPhase, 'disconnected');
  assert.equal(h.Input.isActive, false);
});

test('startup supervision: successful peer keeps frame callbacks across signaling socket replacement', () => {
  const h = startupFixture(), w = h.WebRTC;
  const frame = h.paint();
  const seq = w._videoFrameSeq;
  w.socket = { connected: true, emit() {} };
  frame(h.context.performance.now(), {});
  assert.equal(w._videoFrameSeq, seq + 1);
  assert.equal(w._startupEpisode.state, 'complete');
  assert.equal(w.uiPhase, 'connected');
});

test('startup supervision: slow retry/cancel controls are operable after blocking presentation is removed', async () => {
  const h = startupFixture(), w = h.WebRTC;
  const doc = h.context.document;
  const original = doc.getElementById.bind(doc);
  let controls;
  doc.getElementById = (id) => id === 'startupWaitControls' ? controls : original(id);
  doc.createElement = () => ({ dataset: {}, listeners: {}, children: [],
    addEventListener(event, callback) { this.listeners[event] = callback; },
    append(...nodes) { this.children.push(...nodes); },
    querySelector() { return this.children.find(child => child.dataset.startupCancel); },
  });
  original('loading').append = (node) => { controls = node; };
  h.advance(8000);
  assert.equal(controls.hidden, false);
  assert.equal(controls.children.length, 2);
  assert.equal(controls.children.every(button => button.className === 'start-btn'), true);
  let starts = 0;
  w.startViewer = async () => { starts++; };
  await controls.children[0].listeners.click();
  assert.equal(starts, 1);
  controls.children[1].listeners.click();
  assert.equal(w._startupEpisode.state, 'retired');
  assert.equal(w.uiPhase, 'disconnected');
  assert.equal(controls.hidden, true);
});

test('startup supervision: explicit tunnel session preserves established host-offline media readiness semantics', () => {
  const h = fixture(), w = h.WebRTC;
  w.networkMode = 'tunnel';
  w.beginStartupEpisode();
  w.beginFirstFrameDeadline(w.currentConnectionAttemptId);
  const listeners = {};
  w.socket.on = (event, callback) => { listeners[event] = callback; };
  w.setupSocketListeners();
  listeners['host-status']({ online: false });
  assert.equal(w.hasPaintedFrame, true);
  assert.equal(w.isCurrentAttemptMediaReady(), true);
  assert.equal(w.uiPhase, 'disconnected');
  assert.equal(w._startupEpisode.started, false);
});

test('startup supervision: current painted frame during intentional pause completes media while Input remains closed', () => {
  const h = startupFixture(), w = h.WebRTC;
  h.advance(5000);
  w.getMediaActivitySnapshot = () => ({ state: 'suspended' });
  w.checkStartupEpisode();
  h.paint();
  assert.equal(w._startupEpisode.state, 'complete');
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  assert.equal(h.Input.isActive, false);
  h.advance(100000);
  assert.equal(w._startupEpisode.state, 'complete');
});

test('startup supervision: queued previous-attempt frame cannot even rearm current budget timer', () => {
  const h = startupFixture(), w = h.WebRTC;
  const frame = h.paint(0);
  const attempt = w.currentConnectionAttemptId;
  w.beginConnectionAttempt('automatic-retry');
  const timer = w._startupEpisode.timer;
  frame(h.context.performance.now(), {});
  w.markMediaAttemptReady(attempt);
  assert.equal(w._startupEpisode.timer, timer);
  assert.equal(w.hasPaintedFrame, false);
  assert.equal(w.isCurrentAttemptMediaReady(), false);
});

test('startup supervision: legacy config await cannot initialize after auth generation changes', async () => {
  const h = fixture(), w = h.WebRTC;
  let token = 'old-token', generation = 1, finish, producers = 0;
  h.context.Auth = { getToken: () => token, getGeneration: () => generation };
  w.loadServerConfig = () => new Promise(resolve => { finish = resolve; });
  w.createSignalingSocket = () => { producers++; };
  w.createPeerConnection = () => { producers++; };
  w.beginStartupEpisode();
  const init = w.init();
  token = 'new-token'; generation++;
  finish();
  await init;
  assert.equal(producers, 0);
  assert.equal(w._startupEpisode.reason, 'auth-changed');
  assert.equal(w.uiPhase, 'disconnected');
});

for (const path of ['direct refresh', 'scheduled reconnect']) {
  test(`review I2: actual ${path} preserves nonblocking slow-start presentation and remaining allowance`, async () => {
  const h = startupFixture(), w = h.WebRTC;
  const loading = h.context.document.getElementById('loading');
  const classes = new Set(['is-connecting']);
  loading.classList = {
    add: (...names) => names.forEach(name => classes.add(name)),
    remove: (...names) => names.forEach(name => classes.delete(name)),
    contains: name => classes.has(name),
  };
  h.context.RTCPeerConnection = class {
    constructor() { this.connectionState = 'new'; this.iceConnectionState = 'new'; }
    createDataChannel() { return { readyState: 'connecting' }; }
    close() { this.connectionState = 'closed'; }
  };
  h.advance(8000);
  const episode = w._startupEpisode;
  assert.equal(episode.state, 'slow');
  assert.equal(classes.has('is-connecting'), false);
  assert.equal(h.context.document.getElementById('startupWaitControls').hidden, false);
  if (path === 'scheduled reconnect') {
    w.scheduleReconnect('negotiation-timeout');
    assert.equal(classes.has('is-connecting'), false);
    assert.match(h.context.document.getElementById('loadingText').textContent, /连接较慢/);
    h.advance(1500);
  } else {
    await w.refresh({ reason: 'reconnect:negotiation-timeout' });
  }
  assert.equal(w._startupEpisode, episode);
  assert.equal(episode.remaining, path === 'scheduled reconnect' ? 62500 : 64000);
  assert.equal(classes.has('is-connecting'), false);
  assert.match(h.context.document.getElementById('loadingText').textContent, /连接较慢/);
  assert.equal(h.context.document.getElementById('startupWaitControls').hidden, false);
  assert.equal(h.Input.isActive, false);
  w.checkStartupEpisode();
  assert.equal(classes.has('is-connecting'), false);
  assert.equal(episode.state, 'slow');
});
}

async function retainedStartupPeerFixture({ suspended = false, channelState = 'open' } = {}) {
  const h = startupFixture(), w = h.WebRTC;
  const samples = [];
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'webrtc-stats.js'), 'utf8')
    + '\nglobalThis.__Stats = WebRtcStats;', h.context);
  const createSampler = h.context.__Stats.createWebRtcStatsSampler;
  h.context.__Stats.createWebRtcStatsSampler = options => {
    samples.push(options);
    return createSampler(options);
  };
  let decoded = 0;
  h.context.RTCPeerConnection = class {
    constructor() { this.connectionState = 'new'; this.iceConnectionState = 'new'; }
    createDataChannel() { return { readyState: channelState, send() {} }; }
    getStats() { return Promise.resolve(new Map([['video', { type: 'inbound-rtp', kind: 'video',
      framesDecoded: decoded, framesReceived: decoded, frameWidth: 1280, frameHeight: 720 }]])); }
    getReceivers() { return []; }
    close() { this.connectionState = 'closed'; }
  };
  w.createPeerConnection();
  const peer = w.pc;
  const video = h.context.document.getElementById('remoteVideo');
  const frames = new Map();
  let frameId = 0;
  video.videoWidth = 1280; video.videoHeight = 720; video.readyState = 0;
  video.play = () => Promise.resolve();
  video.requestVideoFrameCallback = fn => { frames.set(++frameId, fn); return frameId; };
  video.cancelVideoFrameCallback = id => frames.delete(id);
  peer.ontrack({ track: { kind: 'video' }, streams: [{ getTracks: () => [] }] });
  peer.connectionState = 'connected'; peer.iceConnectionState = 'connected';
  peer.onconnectionstatechange();
  await w._statsSampler.sampleNow();
  h.advance(4000);
  h.context.document.hidden = !suspended;
  if (suspended) w._mediaIntent = { state: 'suspended' };
  w.mediaActivityRuntime = { isHealthSuppressed: () => true, canEnableDesktopInput: () => false };
  w.checkStartupEpisode();
  h.advance(13000);
  decoded++;
  await w._statsSampler.sampleNow();
  assert.equal(w._lastInboundFramesDecoded, 1);
  assert.equal(w.hasPaintedFrame, false, 'suppressed decode is not paint');
  const oldSocket = w.socket;
  const oldListeners = {};
  oldSocket.on = (event, fn) => { oldListeners[event] = fn; };
  oldSocket.disconnect = () => { oldSocket.connected = false; };
  w.setupSocketListeners();
  h.context.Auth = { getToken: () => 'offline-token' };
  const sockets = [];
  h.context.io = () => {
    const handlers = {};
    const socket = { connected: true, emit() {}, on(event, fn) { handlers[event] = fn; },
      disconnect() { this.connected = false; }, handlers };
    sockets.push(socket);
    return socket;
  };
  const old = { frame: frames.get(w._videoFrameCallbackId), sample: samples[0].onSample,
    sampleError: samples[0].onError, peer: peer.onconnectionstatechange,
    track: peer.ontrack, metadata: video.onloadedmetadata, playing: video.onplaying,
    ice: peer.onicecandidate, dcOpen: w.inputChannel.onopen, dcClose: w.inputChannel.onclose,
    dcMessage: w.inputChannel.onmessage, socket: oldListeners };
  const recover = async () => {
    w._signalRecoveryPending = true;
    w.createSignalingSocket(true);
    await w.socket.handlers.connect();
  };
  const resume = () => {
    h.context.document.hidden = false;
    w._mediaIntent = { state: 'active' };
    w.mediaActivityRuntime = null;
    w.checkStartupEpisode();
  };
  const paint = () => {
    const id = w._videoFrameCallbackId, fn = frames.get(id);
    frames.delete(id);
    fn(h.context.performance.now(), {});
  };
  return { ...h, samples, peer, video, frames, old, oldSocket, recover, resume, paint };
}

for (const suspended of [false, true]) {
  test(`integration I1: retained pending peer after ${suspended ? 'intentional pause' : 'hidden'} socket recovery accepts current frame only`, async () => {
    const h = await retainedStartupPeerFixture({ suspended }), w = h.WebRTC;
    const episode = w._startupEpisode, paint = episode.paint, attempt = w.currentConnectionAttemptId;
    const channel = w.inputChannel, lease = w.controlState.lease;
    await h.recover();
    assert.equal(w.pc, h.peer);
    assert.notEqual(w.socket, h.oldSocket);
    assert.equal(w.currentConnectionAttemptId, attempt);
    assert.equal(w.inputChannel, channel);
    assert.equal(w.controlState.lease, lease);
    assert.equal(w._startupEpisode, episode);
    assert.equal(episode.paint, paint);
    assert.equal(episode.remaining, 68000);
    assert.equal(paint.remaining, 8000);
    h.resume();
    h.paint();
    assert.equal(w._startupEpisode.state, 'complete');
    assert.equal(w.isCurrentAttemptMediaReady(), true);
    assert.equal(h.Input.getEffectiveInputGate().allowed, true);
    assert.equal(h.Input.isActive, true);
    assert.equal(h.frames.size, 1);
    assert.equal([...h.intervals.values()].filter(t => t.ms === 1000).length, 1);
    const seq = w._videoFrameSeq, timer = episode.timer, stats = w._lastInboundFramesDecoded;
    h.old.frame(0, {}); h.old.sample({ framesDecoded: 99 });
    h.old.peer(); h.old.metadata(); h.old.playing(); h.old.dcOpen(); h.old.dcClose();
    h.old.track({}); h.old.ice({ candidate: 'old' });
    h.old.dcMessage({ data: JSON.stringify({ type: 'capture_stats', fps: 99 }) });
    h.old.socket['host-status']({ online: false });
    h.old.socket['control-grant']({ controller: true, leaseId: 'obsolete', leaseEpoch: 999 });
    assert.equal(w._videoFrameSeq, seq, 'retired frame stays inert even after startup completes');
    assert.equal(w._lastInboundFramesDecoded, stats);
    assert.notEqual(w._hostCaptureFps, 99);
    assert.equal(episode.timer, timer);
    assert.equal(w.pc, h.peer);
    assert.equal(w.controlState.lease, lease);
    assert.equal(h.frames.size, 1);
    assert.equal(h.Input.isActive, true);
  });
}

test('integration I1: repeated retained-owner transfer preserves exact active budgets and rejects old queued work', async () => {
  const h = await retainedStartupPeerFixture(), w = h.WebRTC;
  const episode = w._startupEpisode, paint = episode.paint;
  await h.recover();
  await h.recover();
  h.resume();
  const timer = episode.timer;
  h.old.frame(0, {}); h.old.sample({ framesDecoded: 99 }); h.old.peer();
  assert.equal(episode.timer, timer);
  assert.equal(episode.remaining, 68000);
  assert.equal(paint.remaining, 8000);
  h.advance(4000);
  assert.equal(episode.state, 'slow');
  assert.equal(episode.paint, paint);
  assert.equal(paint.remaining, 4000);
  h.advance(3999);
  assert.notEqual(episode.state, 'failed');
  h.advance(1);
  assert.equal(episode.state, 'failed');
  assert.equal(episode.reason, 'startup-paint-timeout');
  assert.equal(h.Input.isActive, false);
});

test('integration I1: recovered current frame without a current control lease keeps actual Input closed', async () => {
  const h = await retainedStartupPeerFixture(), w = h.WebRTC;
  await h.recover();
  w.freezeControl('control-readonly');
  h.resume(); h.paint();
  assert.equal(w._startupEpisode.state, 'complete');
  assert.equal(w.isCurrentAttemptMediaReady(), true);
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  assert.equal(h.Input.isActive, false);
});

test('integration I1: transferred stats, metadata, track and channel producers remain current without duplicate samplers', async () => {
  const h = await retainedStartupPeerFixture(), w = h.WebRTC;
  let qualityResets = 0;
  w.ensureLinkQualityController = () => ({ beginConnection() { qualityResets++; } });
  await h.recover();
  await w._statsSampler.sampleNow();
  assert.equal(qualityResets, 0, 'retaining a PC must not reset link-quality adaptation');
  assert.equal(h.samples.length, 2);
  assert.equal(h.frames.size, 1);
  assert.equal([...h.intervals.values()].filter(t => t.ms === 1000).length, 1);
  h.samples[1].onSample({ framesDecoded: 2, framesReceived: 2, videoWidth: 1280, videoHeight: 720 });
  assert.equal(w._lastInboundFramesDecoded, 2);
  assert.equal(w.hasPaintedFrame, false);
  assert.equal(h.Input.isActive, false);
  const timer = w._startupEpisode.timer;
  h.old.frame(0, {}); h.old.sample({ framesDecoded: 99 }); h.old.metadata(); h.old.playing();
  const warnings = [];
  h.context.console = { ...console, warn: (...args) => warnings.push(args) };
  h.old.sampleError(new Error('retired sampler'));
  assert.equal(warnings.length, 0);
  assert.equal(w._startupEpisode.timer, timer);
  w.inputChannel.onopen();
  assert.equal([...h.intervals.values()].filter(t => t.ms === 15000).length, 1);
  w.inputChannel.onopen();
  assert.equal([...h.intervals.values()].filter(t => t.ms === 15000).length, 1);
  w.inputChannel.onmessage({ data: JSON.stringify({ type: 'capture_stats', fps: 12 }) });
  assert.equal(w._hostCaptureFps, 12);
  // Current metadata/playing callbacks must also work after transfer. Only a
  // post-resume event may use the existing decoded-frame readiness path.
  h.resume(); h.video.readyState = 2;
  h.video.onloadedmetadata(); h.video.onplaying();
  assert.equal(w._startupEpisode.state, 'complete');
  assert.equal(h.Input.isActive, true);
  const stream = { getTracks: () => [] };
  h.peer.ontrack({ track: { kind: 'video' }, streams: [stream] });
  assert.equal(w.remoteStream, stream);
});

test('integration I1: retained pending channel copies watchdog deadline and fences old watchdog/open callbacks', async () => {
  const h = await retainedStartupPeerFixture({ channelState: 'connecting' }), w = h.WebRTC;
  const previous = w._dataChannelWatchdog, oldWake = h.timers.get(previous.timer).fn;
  const deadline = previous.deadline, phase = previous.phase, extensions = previous.extensions;
  await h.recover();
  const current = w._dataChannelWatchdog, timer = current.timer;
  assert.notEqual(current, previous);
  assert.equal(current.deadline, deadline);
  assert.equal(current.phase, phase);
  assert.equal(current.extensions, extensions);
  oldWake(); h.old.dcOpen();
  assert.equal(w._dataChannelWatchdog, current);
  assert.equal(current.timer, timer);
  w.inputChannel.readyState = 'open';
  w.inputChannel.onopen();
  assert.equal(w._dataChannelWatchdog, null);
  assert.equal(w._startupEpisode.paint.remaining, 8000);
  assert.equal(h.Input.isActive, false, 'current DC open cannot substitute for paint');
  h.resume(); h.paint();
  assert.equal(h.Input.isActive, true);
});

test('integration I1: retained channel error recovery keeps its existing deadline and ignores old timer', async () => {
  const h = await retainedStartupPeerFixture(), w = h.WebRTC;
  const faults = [];
  w.noteDataChannelFault = reason => faults.push(reason);
  w.inputChannel.onerror({ type: 'offline-error-fixture' });
  const oldTimer = w._dcReconnectTimer, oldWake = h.timers.get(oldTimer).fn;
  const deadline = h.timers.get(oldTimer).due;
  h.advance(1000);
  await h.recover();
  const currentTimer = w._dcReconnectTimer;
  assert.notEqual(currentTimer, oldTimer);
  assert.equal(h.timers.get(currentTimer).due, deadline);
  oldWake();
  assert.equal(w._dcReconnectTimer, currentTimer);
  assert.deepEqual(faults, []);
  h.advance(1999);
  assert.deepEqual(faults, []);
  h.advance(1);
  assert.deepEqual(faults, ['dc-error']);
});
