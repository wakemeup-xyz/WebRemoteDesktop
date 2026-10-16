const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { MediaActivityRuntime } = require('./media-activity-runtime.js');

function fixture() {
  const sent = [];
  const emitted = [];
  const elements = new Map();
  const element = () => ({
    style: {}, dataset: {}, hidden: false, value: '', isConnected: true,
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    addEventListener() {}, setAttribute() {}, removeAttribute() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
  });
  const context = {
    console, Date, setTimeout: () => 1, clearTimeout() {}, updateLoadingText() {},
    setInterval: () => 1, clearInterval() {}, requestAnimationFrame: (fn) => fn(),
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
  return { WebRTC, Input, context, originalMedia, emitted, sent, lease, grant, acknowledge, disconnect };
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
  assert.equal(h.Input.keyboardTransport.getSnapshot().state, 'reacquire-required');
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  h.grant({ leaseId: 'replacement-lease', leaseEpoch: 8 });
  assert.equal(h.Input.keyboardTransport.getSnapshot().state, 'ready');
  assert.equal(h.Input.getEffectiveInputGate().allowed, true);
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
  w.noteMediaRenderedFrame({ source: 'stats', framesDecoded: 21,
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
