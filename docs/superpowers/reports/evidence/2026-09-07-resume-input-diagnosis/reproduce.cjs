// Read-only, offline diagnosis: real Viewer modules, simulated DOM/transport/clock.
// No network connections, Quartz calls, source patches, or live Viewer takeover.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repo = path.resolve(__dirname, '../../../../..');
const lease = { leaseId: 'diagnosis-lease-0001', leaseEpoch: 7 };

function fixture({ touchPoints = 0 } = {}) {
  let now = 1000;
  let nextTimer = 0;
  const timers = new Map();
  const sent = [];
  function target(extra = {}) {
    const handlers = new Map();
    const classes = new Set();
    return {
      handlers, style: {}, dataset: {}, isConnected: true,
      classList: {
        add(...xs) { xs.forEach(x => classes.add(x)); },
        remove(...xs) { xs.forEach(x => classes.delete(x)); },
        contains(x) { return classes.has(x); },
      },
      addEventListener(name, fn) {
        if (!handlers.has(name)) handlers.set(name, []);
        handlers.get(name).push(fn);
      },
      dispatch(name, fields = {}) {
        const event = { type: name, target: this, currentTarget: this,
          preventDefault() {}, stopPropagation() {}, ...fields };
        for (const fn of handlers.get(name) || []) fn(event);
      },
      setAttribute() {}, removeAttribute() {}, matches() { return false; },
      closest() { return null; }, getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, width: 800, height: 600 }; },
      hasPointerCapture() { return false; }, setPointerCapture() {},
      ...extra,
    };
  }
  const video = target({ tagName: 'VIDEO', videoWidth: 800, videoHeight: 600 });
  const elements = new Map([['remoteVideo', video]]);
  for (const id of ['mobileTextInput', 'mobileTextInputBtn', 'mobileInputDock', 'mobileInputStatus', 'mobileInputRetryBtn', 'mobileInputDiscardBtn']) {
    elements.set(id, target({ hidden: true, value: '', tagName: id === 'mobileTextInput' ? 'TEXTAREA' : 'DIV' }));
  }
  const document = target({ hidden: false, body: target(), querySelector() { return null; }, querySelectorAll() { return []; },
    getElementById(id) { return elements.get(id) || null; } });
  video.focus = () => { document.activeElement = video; };
  const window = target({ location: { origin: 'http://offline.invalid' } });
  class ClockDate extends Date { static now() { return now; } }
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, Date: ClockDate,
    document, window, navigator: { platform: 'MacIntel', userAgent: 'offline-diagnostic', maxTouchPoints: touchPoints },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    performance: { now: () => now }, getComputedStyle: () => ({ objectFit: 'contain' }),
    requestAnimationFrame: fn => fn(),
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, due: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return ++nextTimer; }, clearInterval() {},
  });
  for (const name of ['input-geometry', 'keyboard-transport', 'remote-keyboard-controller', 'mobile-text-input', 'media-activity-runtime', 'webrtc', 'input']) {
    const source = fs.readFileSync(path.join(repo, 'web-client/js', `${name}.js`), 'utf8');
    vm.runInContext(source + (name === 'webrtc' ? '\nglobalThis.wrtc = WebRTC;' : name === 'input' ? '\nglobalThis.input = Input;' : ''), context);
  }
  const W = context.wrtc;
  const I = context.input;
  W.socket = { connected: true, emit(event, payload) { sent.push({ event, payload }); } };
  W.inputChannel = { readyState: 'open', bufferedAmount: 0, send(json) { sent.push({ event: 'dc', payload: JSON.parse(json) }); } };
  W.controlState = { state: 'ACTIVE', controller: true, lease: { ...lease } };
  W.currentConnectionAttemptId = 'diagnostic-attempt';
  W._mediaReadyConnectionAttemptId = W.currentConnectionAttemptId;
  W.mediaActivityController = { snapshot: () => ({ state: 'active', generation: 2, reasons: [] }) };
  W.mediaActivityRuntime = context.MediaActivityRuntime.create({ setTimeoutFn: context.setTimeout, clearTimeoutFn: context.clearTimeout });
  W.uiPhase = 'connected';
  W.hasPaintedFrame = true;
  I.videoElement = video;
  I.setControlLease(lease);
  I.setupEventListeners();
  W.bindControlLifecycle();
  W.syncDesktopInputGate();
  I.setupTextInput();
  I.updateMobileTextInputButton();
  function ack(message, status = 'applied', appliedSeq = message.seq) {
    const value = { schemaVersion: 2, leaseEpoch: message.leaseEpoch, inputType: message.type, inputIds: message.inputIds, status, appliedSeq };
    return message.type === 'keyboard' ? I.acceptKeyboardAck(value) : I.acceptMouseAck(value);
  }
  function inputs() { return sent.filter(x => x.payload?.type === 'mouse' || x.payload?.type === 'keyboard').map(x => x.payload); }
  function pointer(name) { video.dispatch(name, { pointerType: 'mouse', pointerId: 1, button: 0, buttons: name === 'pointerup' ? 0 : 1, clientX: 400, clientY: 300, timeStamp: now }); }
  function keydown() { document.dispatch('keydown', { target: video, code: 'KeyA', key: 'a', repeat: false, location: 0, getModifierState() { return false; } }); }
  function resume() {
    const attempt = W.currentConnectionAttemptId;
    const runtime = W.mediaActivityRuntime;
    runtime.beginDesired('suspended', { generation: 1, connectionAttemptId: attempt });
    runtime.applyAck({ state: 'suspended', generation: 1, connectionAttemptId: attempt, applied: true });
    W.syncDesktopInputGate();
    runtime.beginDesired('active', { generation: 2, connectionAttemptId: attempt });
    runtime.applyAck({ state: 'active', generation: 2, connectionAttemptId: attempt, applied: true });
    runtime.noteRenderedFrame({ connectionAttemptId: attempt, afterResume: true });
    W.rebindActiveKeyboardLease('visibility-visible');
    W.syncDesktopInputGate();
  }
  function summary() {
    return { mediaPhase: W.getMediaAppliedPhase(), commonGate: W.canEnableDesktopInput(), isActive: I.isActive,
      surfaceState: I.getMobileSurfaceContextSnapshot().state,
      editingAllowed: I._isMobileEditingActionAllowed(), pendingMouseReset: I._pendingMouseReset,
      keyboardState: I.keyboardController.getSnapshot().state, mobileAdapterPresent: Boolean(I.mobileTextInputAdapter),
      hasPendingDraft: I.mobileTextInputAdapter?.getSnapshot().hasPending || false,
      draftDeliveryUncertain: I.mobileTextInputAdapter?.getSnapshot().deliveryUncertain || false,
      mobileDockHidden: elements.get('mobileInputDock').hidden, mobileButtonHidden: elements.get('mobileTextInputBtn').hidden };
  }
  function advance(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); }
  }
  return { W, I, window, document, video, elements, inputs, ack, pointer, keydown, resume, summary, advance };
}

const results = [];
{
  const h = fixture();
  h.pointer('pointerdown');
  h.pointer('pointerup');
  h.inputs().forEach(m => h.ack(m));
  h.window.dispatch('blur');
  h.inputs().filter(m => m.type === 'keyboard').forEach(m => h.ack(m));
  h.resume();
  const before = h.inputs().length;
  h.keydown();
  assert.equal(h.inputs().length, before + 1);
  results.push({ case: 'all-click-acks-before-blur-control', editingAllowed: h.summary().editingAllowed, newKeyDownSent: true });
}
{
  const h = fixture();
  h.window.dispatch('blur');
  h.inputs().forEach(m => h.ack(m));
  h.resume();
  const before = h.inputs().length;
  h.pointer('pointerdown');
  assert.equal(h.inputs().length, before + 1);
  results.push({ case: 'idle-blur-and-resume-control', newMouseDownSent: true });
}
{
  const h = fixture();
  h.pointer('pointerdown');
  h.pointer('pointerup');
  const clickMessages = h.inputs().slice();
  assert.equal(clickMessages.length, 2);
  // All ACKs eventually arrive, but blur happens first; no dropped packets needed.
  h.window.dispatch('blur');
  h.inputs().forEach(m => h.ack(m));
  h.resume();
  const before = h.inputs().length;
  h.pointer('pointerdown');
  h.keydown();
  const after = h.summary();
  assert.equal(after.commonGate, true);
  assert.equal(after.keyboardState, 'READY');
  assert.equal(after.surfaceState, 'uncertain');
  assert.equal(h.inputs().length, before);
  results.push({ case: 'completed-click-blur-before-acks-resume', ...after, newMouseOrKeyboardMessages: h.inputs().length - before });
}
{
  const h = fixture();
  h.pointer('pointerdown');
  h.ack(h.inputs()[0]);
  h.window.dispatch('blur');
  h.inputs().slice(1).forEach(m => h.ack(m));
  h.resume();
  const before = h.inputs().length;
  h.pointer('pointerdown');
  h.keydown();
  assert.equal(h.summary().pendingMouseReset, false);
  assert.equal(h.summary().surfaceState, 'uncertain');
  assert.equal(h.inputs().length, before);
  results.push({ case: 'drag-blur-all-reset-acks-resume', ...h.summary(), newMouseOrKeyboardMessages: h.inputs().length - before });
}
{
  const h = fixture();
  h.pointer('pointerdown');
  h.pointer('pointerup');
  h.advance(3100);
  h.inputs().forEach(m => h.ack(m));
  h.resume();
  assert.equal(h.summary().surfaceState, 'uncertain');
  const before = h.inputs().length;
  h.pointer('pointerdown');
  h.keydown();
  assert.equal(h.inputs().length, before);
  results.push({ case: 'mouse-ack-timeout-and-late-acks', ...h.summary(), newMouseOrKeyboardMessages: h.inputs().length - before });
}
{
  const h = fixture({ touchPoints: 5 });
  h.pointer('pointerdown');
  h.ack(h.inputs()[0]);
  h.document.hidden = true;
  h.document.dispatch('visibilitychange');
  h.inputs().slice(1).forEach(m => h.ack(m));
  h.resume();
  h.document.hidden = false;
  h.document.dispatch('visibilitychange');
  assert.equal(h.summary().editingAllowed, false);
  const blocked = h.summary();
  // Invoke the existing handler to prove a recovery mechanism exists. This is
  // not a real click or an assertion that the hidden control is reachable.
  h.elements.get('mobileInputDiscardBtn').dispatch('click');
  assert.equal(h.summary().editingAllowed, true);
  results.push({ case: 'visibility-cycle-with-touch-capability', ...blocked, explicitDiscardHandlerRecovers: true });
}
console.log(JSON.stringify({ evidence: 'offline-real-modules-simulated-dom-and-transport', results }, null, 2));
