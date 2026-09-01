const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function makeElement() {
  const listeners = new Map();
  const captured = new Set();
  return {
    value: '', textContent: '', style: {}, dataset: {}, listeners, captured,
    videoWidth: 100, videoHeight: 100,
    classList: { add() {}, remove() {} },
    focus() {}, setAttribute() {}, removeAttribute() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
    addEventListener(type, handler) { listeners.set(type, handler); },
    setPointerCapture(id) { captured.add(id); },
    releasePointerCapture(id) { captured.delete(id); },
    hasPointerCapture(id) { return captured.has(id); },
  };
}

function loadInput() {
  const elements = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const socketEvents = [];
  const context = {
    console, setTimeout, clearTimeout, requestAnimationFrame: (fn) => fn(),
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { platform: 'MacIntel', userAgent: 'node-test' },
    window: { addEventListener(type, handler) { windowListeners.set(type, handler); } },
    getComputedStyle: (element) => ({ objectFit: element.style.objectFit || 'contain' }),
    document: {
      hidden: false,
      addEventListener(type, handler) { documentListeners.set(type, handler); },
      querySelectorAll: () => [],
      getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); },
    },
    WebRTC: {
      socket: { connected: true, emit(event, payload) { socketEvents.push({ event, payload }); } },
      sendInput: () => false,
      inputChannel: null,
    },
    LatencyMonitor: { recordInputSend() {} },
  };
  context.globalThis = context;
  vm.createContext(context);
  for (const filename of ['input-geometry.js', 'keyboard-transport.js', 'remote-keyboard-controller.js', 'mobile-text-input.js', 'input.js']) {
    const source = fs.readFileSync(path.join(__dirname, filename), 'utf8');
    vm.runInContext(filename === 'input.js' ? `${source}\nglobalThis.__Input = Input;` : source, context);
  }
  return { Input: context.__Input, context, elements, documentListeners, windowListeners, socketEvents };
}

function keyboard(type, overrides = {}) {
  return {
    type, code: 'KeyA', key: 'a', location: 0, repeat: false,
    ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, isComposing: false,
    target: { tagName: 'VIDEO', isContentEditable: false, closest: () => null },
    getModifierState: () => false, preventDefault() {}, ...overrides,
  };
}

function activate(Input, context) {
  Input.videoElement = context.document.getElementById('remoteVideo');
  Input.initKeyboardController();
  Input.setControlLease({ leaseId: 'lease-000000000001', leaseEpoch: 3 });
  Input.setActive(true);
}

test('tracked keyup from a text modal releases the controller key state', () => {
  const { Input, context, documentListeners, socketEvents } = loadInput();
  activate(Input, context);
  Input.setupEventListeners();
  documentListeners.get('keydown')(keyboard('keydown', { code: 'ShiftLeft', key: 'Shift', shiftKey: true }));
  documentListeners.get('keyup')(keyboard('keyup', {
    code: 'ShiftLeft', key: 'Shift', target: { tagName: 'TEXTAREA', isContentEditable: false, closest: (selector) => selector === '.modal' ? {} : null },
  }));

  assert.equal(Input.keyboardController.getSnapshot().pressedKeyCount, 0);
  assert.deepEqual(socketEvents.map(({ payload }) => [payload.action, payload.payload.phase]), [['key', 'down'], ['key', 'up']]);
});

test('composition submit sends one text, cancel sends none, and actions use one batch', () => {
  const { Input, context, elements, socketEvents } = loadInput();
  activate(Input, context);
  const actionButton = makeElement();
  actionButton.dataset.action = 'copy';
  context.document.querySelectorAll = () => [actionButton];
  Input.setupTextInput();
  Input.setupActionButtons();
  elements.get('remoteTextInput').value = 'hello';
  elements.get('remoteTextInput').listeners.get('compositionend')();
  elements.get('remoteTextInput').value = 'do-not-send';
  elements.get('textInputCancelBtn').listeners.get('click')({ preventDefault() {} });
  actionButton.listeners.get('click')({ preventDefault() {} });

  const keyboardPayloads = socketEvents.filter(({ event }) => event === 'input').map(({ payload }) => payload);
  assert.deepEqual(keyboardPayloads.map(({ action }) => action), ['text', 'batch']);
  assert.equal(keyboardPayloads[0].payload.text, 'hello');
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, 'input.js'), 'utf8'), /setTimeout\([^)]*,\s*30\)/);
});

test('mobile text adapter routes text and control keys through the keyboard controller', () => {
  const { Input, context, elements, socketEvents } = loadInput();
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const input = elements.get('mobileTextInput');
  input.value = '\u4e2d\u6587';
  input.listeners.get('input')({ target: input });
  input.listeners.get('keydown')({ key: 'Enter', target: input, preventDefault() {} });

  const keyboardPayloads = socketEvents.filter(({ event }) => event === 'input').map(({ payload }) => payload);
  assert.equal(Input.mobileTextInputAdapter.getSnapshot().attached, true);
  assert.deepEqual(keyboardPayloads.map(({ action }) => action), ['text', 'batch']);
  assert.equal(keyboardPayloads[0].payload.text, '\u4e2d\u6587');
  assert.equal(keyboardPayloads[1].payload.steps.map(({ code }) => code).join(','), 'Enter,Enter');
});

test('mobile textarea stops control and hardware text events before document keyboard handling', () => {
  const { Input, context, elements, documentListeners, socketEvents } = loadInput();
  activate(Input, context);
  Input.setupEventListeners();
  const globalKeydown = documentListeners.get('keydown');
  const globalKeyup = documentListeners.get('keyup');
  Input.setupTextInput();
  const input = elements.get('mobileTextInput');
  const bubble = (type, overrides = {}) => {
    const event = keyboard(type, {
      target: input,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...overrides,
    });
    input.listeners.get(type)?.(event);
    if (!event.propagationStopped) (type === 'keydown' ? globalKeydown : globalKeyup)(event);
  };

  bubble('keydown', { code: 'Enter', key: 'Enter' });
  bubble('keyup', { code: 'Enter', key: 'Enter' });
  bubble('keydown', { code: 'KeyA', key: 'a' });
  bubble('keyup', { code: 'KeyA', key: 'a' });
  input.value = 'a';
  input.listeners.get('input')({ target: input });

  const actions = socketEvents.filter(({ event }) => event === 'input').map(({ payload }) => payload.action);
  assert.deepEqual(actions, ['batch', 'text']);
});

test('only one keyboard transport and controller are created for an input instance', () => {
  const { Input, context } = loadInput();
  const first = Input.initKeyboardController();
  const second = Input.initKeyboardController();
  assert.equal(first, second);
  assert.equal(Input.keyboardTransport.getSnapshot().state, 'revoked');
  activate(Input, context);
  assert.equal(Input.keyboardController, first);
});

test('keyboard initialization before DataChannel open uses Socket.IO then restores DataChannel delivery', () => {
  const { Input, context, socketEvents } = loadInput();
  const dataChannelPayloads = [];
  context.WebRTC.inputChannel = { readyState: 'connecting' };
  context.WebRTC.sendInput = (payload) => {
    dataChannelPayloads.push(payload);
    return true;
  };
  activate(Input, context);

  Input.keyboardTransport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyS' } });
  assert.equal(socketEvents.at(-1).payload.payload.code, 'KeyS');

  context.WebRTC.inputChannel.readyState = 'open';
  Input.setKeyboardDataChannelAvailable(true);
  Input.keyboardTransport.send({ type: 'keyboard', action: 'keyup', payload: { code: 'KeyS' } });
  Input.keyboardTransport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyD' } });

  assert.equal(dataChannelPayloads.length, 1);
  assert.equal(dataChannelPayloads[0].payload.code, 'KeyD');
});

test('DataChannel loss with a held key uses a Socket.IO reset barrier before further input', () => {
  const { Input, context, socketEvents } = loadInput();
  context.WebRTC.inputChannel = { readyState: 'open' };
  context.WebRTC.sendInput = () => true;
  activate(Input, context);

  Input.keyboardTransport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyC' } });
  Input.setKeyboardDataChannelAvailable(false);

  assert.equal(socketEvents.at(-1).payload.action, 'reset');
  assert.equal(socketEvents.at(-1).payload.payload.reason, 'transport-change');
  assert.equal(Input.keyboardTransport.canSendNewInput(), false);
  assert.equal(Input.keyboardTransport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyV' } }), null);
});

test('Socket.IO keyboard envelopes remain within the strict v2 protocol shape', () => {
  const { Input, context, socketEvents } = loadInput();
  context.WebRTC.inputChannel = { readyState: 'connecting' };
  activate(Input, context);

  Input.keyboardTransport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyS' } });

  assert.equal(Object.hasOwn(socketEvents.at(-1).payload, 'transport'), false);
});

test('blur resets keyboard state but leaves control ownership to WebRTC', () => {
  const { Input, context, windowListeners, socketEvents } = loadInput();
  activate(Input, context);
  Input.setupEventListeners();
  windowListeners.get('blur')();
  assert.equal(socketEvents.at(-1).payload.action, 'reset');
  assert.equal(Input.getDiagnosticState().keyboard.lastResetReason, 'window-blur');
});

test('mouse pointer cancel releases capture and sends one reset', () => {
  const { Input, context, socketEvents } = loadInput();
  activate(Input, context);
  const element = makeElement();
  Input.bindMouseEvents(element);
  const event = { pointerId: 8, button: 0, detail: 1, timeStamp: 1, clientX: 50, clientY: 50, currentTarget: element, preventDefault() {} };
  element.listeners.get('pointerdown')(event);
  element.listeners.get('pointercancel')(event);
  assert.equal(element.captured.has(8), false);
  assert.equal(socketEvents.filter(({ payload }) => payload.action === 'reset').length, 1);
});

test('desktop mouse binding ignores complete touch sequences on video and relay image', () => {
  const { Input, context, socketEvents, elements } = loadInput();
  activate(Input, context);
  Input.setupEventListeners();
  const touch = (element, type, overrides = {}) => element.listeners.get(type)({
    pointerType: 'touch', pointerId: 1, button: 0, detail: 1, timeStamp: 1,
    clientX: 50, clientY: 50, currentTarget: element, preventDefault() {}, ...overrides,
  });
  for (const element of [elements.get('remoteVideo'), elements.get('relayImage')]) {
    touch(element, 'pointerdown', {buttons: 1});
    touch(element, 'pointermove', {clientX: 60, buttons: 1});
    touch(element, 'pointerup', {clientX: 60, buttons: 0});
    touch(element, 'pointerdown', {pointerId: 2, buttons: 1});
    touch(element, 'pointercancel', {pointerId: 2, buttons: 0});
    touch(element, 'lostpointercapture', {pointerId: 2, buttons: 0});
    touch(element, 'wheel', {
      pointerType: undefined, deltaX: 0, deltaY: 24,
      sourceCapabilities: { firesTouchEvents: true },
    });
  }
  assert.equal(socketEvents.length, 0);
});

test('keyboard diagnostics contain only state metadata', () => {
  const { Input, context } = loadInput();
  activate(Input, context);
  Input.modifierMask = 0x100000;
  Input.resetKeyboard('window-blur');
  const state = JSON.parse(JSON.stringify(Input.getDiagnosticState()));
  assert.deepEqual(Object.keys(state.keyboard).sort(), ['adapter', 'epoch', 'lastApplied', 'lastResetReason', 'lastSent', 'leaseState', 'modifierMask', 'pendingCount', 'pressedCount']);
  assert.doesNotMatch(JSON.stringify(state), /raw=|KeyA|keyCode/);
});

test('desktop mouse and command input require the active lease and carry the v2 envelope', () => {
  const { Input, context, socketEvents } = loadInput();
  Input.socket = context.WebRTC.socket;
  assert.equal(Input.sendInput('mouse', 'down', { relX: 0.5, relY: 0.5 }), null);
  assert.equal(Input.sendInput('command', 'showDock', {}), null);
  assert.equal(socketEvents.length, 0);

  activate(Input, context);
  Input.sendInput('mouse', 'down', { relX: 0.5, relY: 0.5 });
  Input.sendInput('command', 'showDock', {});
  assert.equal(socketEvents.length, 2);
  for (const { payload } of socketEvents) {
    assert.equal(payload.schemaVersion, 2);
    assert.equal(payload.leaseId, 'lease-000000000001');
    assert.equal(payload.leaseEpoch, 3);
  }
});

test('toolbar command can send with lease even when media gate is inactive', () => {
  const { Input, context, socketEvents } = loadInput();
  Input.socket = context.WebRTC.socket;
  Input.activeControlLease = { leaseId: 'lease-000000000001', leaseEpoch: 3 };
  Input.isActive = false;
  assert.equal(Input.sendInput('mouse', 'down', { relX: 0.5, relY: 0.5 }), null);
  assert.equal(socketEvents.length, 0);
  const id = Input.sendInput('command', 'showDock', {});
  assert.ok(id);
  assert.equal(socketEvents.length, 1);
  assert.equal(socketEvents[0].payload.type, 'command');
  assert.equal(socketEvents[0].payload.action, 'showDock');
});

test('mouse up and reset still send when media gate is inactive', () => {
  const { Input, context, socketEvents } = loadInput();
  Input.socket = context.WebRTC.socket;
  Input.activeControlLease = { leaseId: 'lease-000000000001', leaseEpoch: 3 };
  Input.isActive = false;
  assert.equal(Input.sendInput('mouse', 'down', { relX: 0.5, relY: 0.5 }), null);
  const upId = Input.sendInput('mouse', 'up', { relX: 0.5, relY: 0.5, button: 'left' });
  const resetId = Input.sendInput('mouse', 'reset', { reason: 'pointer-up-failed' });
  assert.ok(upId);
  assert.ok(resetId);
  assert.equal(socketEvents.length, 2);
  assert.equal(socketEvents[0].payload.action, 'up');
  assert.equal(socketEvents[1].payload.action, 'reset');
});

test('desktop pointerup cannot clear a pending mouse reset without a matching applied acknowledgement', () => {
  const { Input, context, socketEvents } = loadInput();
  activate(Input, context);
  const element = makeElement();
  Input.bindMouseEvents(element);
  Input._pendingMouseReset = true;
  Input._pendingMouseResetId = 'reset-1';
  element.listeners.get('pointerup')({ pointerId: 1, button: 0, buttons: 0, clientX: 50, clientY: 50, currentTarget: element, preventDefault() {} });
  assert.equal(Input._pendingMouseReset, true);
  assert.equal(Input.acceptMouseAck({ status: 'applied', inputIds: ['other-reset'] }).status, 'stale');
  assert.equal(Input._pendingMouseReset, true);
  assert.equal(Input.acceptMouseAck({ status: 'duplicate', inputIds: ['reset-1'] }).status, 'duplicate');
  assert.equal(Input._pendingMouseReset, false);
  assert.equal(socketEvents.length, 1, 'safety up may send but must not clear the barrier');
});

test('touch lifecycle reset sends one mouse reset through Input ownership', () => {
  const { Input, context, socketEvents } = loadInput();
  activate(Input, context);
  let resetCalls = 0;
  Input._touchAdapters.set({}, { reset() { resetCalls += 1; Input._pendingMouseReset = true; Input._pendingMouseResetId = 'adapter-reset'; return 'adapter-reset'; } });
  Input._pressedMouseButtons.add('left');
  Input.releasePointer('window-blur');
  assert.equal(resetCalls, 1);
  assert.equal(socketEvents.filter(({ payload }) => payload.action === 'reset').length, 0);
  assert.equal(Input._pendingMouseResetId, 'adapter-reset');
});

test('pending touch reset survives lifecycle release until its first matching acknowledgement', () => {
  const { Input, context, socketEvents } = loadInput();
  activate(Input, context);
  Input._pendingMouseReset = true;
  Input._pendingMouseResetId = 'touch-reset-1';
  Input._touchAdapters.set({}, { reset() { return null; } });
  Input._pressedMouseButtons.add('left');

  Input.releasePointer('window-blur');

  assert.equal(socketEvents.filter(({ payload }) => payload.action === 'reset').length, 0);
  assert.equal(Input._pendingMouseResetId, 'touch-reset-1');
  assert.equal(Input.acceptMouseAck({ status: 'applied', inputIds: ['touch-reset-1'] }).status, 'applied');
  assert.equal(Input._pendingMouseReset, false);
});

test('matching mouse reset acknowledgement flushes deferred touch work', () => {
  const { Input } = loadInput();
  let flushes = 0;
  Input._touchAdapters.set({}, { flushPending() { flushes += 1; } });
  Input._pendingMouseReset = true;
  Input._pendingMouseResetId = 'mouse-reset-2';
  assert.equal(Input.acceptMouseAck({ status: 'applied', inputIds: ['mouse-reset-2'] }).status, 'applied');
  assert.equal(flushes, 1);
});

test('pointer move with buttons 0 clears local pressed set via reset', () => {
  const { Input, context, socketEvents, elements } = loadInput();
  activate(Input, context);
  Input.socket = context.WebRTC.socket;
  Input.setupEventListeners();
  const video = elements.get('remoteVideo');
  // Simulate a held button that lost its up.
  Input._pressedMouseButtons.add('left');
  Input.isActive = true;
  video.listeners.get('pointermove')({
    clientX: 50,
    clientY: 50,
    buttons: 0,
    pointerId: 1,
    currentTarget: video,
    preventDefault() {},
  });
  // rAF flushes the queued move
  return new Promise((resolve) => {
    setImmediate(() => {
      assert.equal(Input._pressedMouseButtons.size, 0);
      assert.ok(socketEvents.some(({ payload }) => payload.type === 'mouse' && payload.action === 'reset'));
      resolve();
    });
  });
});


test('media-gate deactivation keeps keyboard lease without erecting a reset barrier', () => {
  const { Input, context, socketEvents } = loadInput();
  activate(Input, context);
  Input.isActive = true;
  // Simulate a real key down via controller so pressed state exists.
  Input.keyboardController.handleDomEvent({
    type: 'keydown', code: 'KeyA', key: 'a', location: 0, repeat: false,
    ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, isComposing: false,
    target: { tagName: 'VIDEO', isContentEditable: false, closest: () => null },
    getModifierState: () => false, preventDefault() {},
  });
  const before = socketEvents.length;
  // Media gate closes but lease remains — must not keyboard-reset.
  context.WebRTC.canEnableDesktopInput = () => false;
  Input.setActive(false);
  assert.equal(Input.isActive, false);
  assert.equal(Input.activeControlLease.leaseId, 'lease-000000000001');
  const resets = socketEvents.slice(before).filter(({ payload }) => payload.action === 'reset');
  assert.equal(resets.length, 0, 'media-gate close must not send keyboard reset while lease is live');
});

test('wheel events are coalesced into one input per animation frame', async () => {
  const { Input, context, socketEvents, elements } = loadInput();
  activate(Input, context);
  Input.socket = context.WebRTC.socket;
  Input.setupEventListeners();
  const video = elements.get('remoteVideo');
  const wheel = video.listeners.get('wheel');
  wheel({ clientX: 40, clientY: 40, deltaX: 0, deltaY: 100, preventDefault() {}, currentTarget: video });
  wheel({ clientX: 42, clientY: 42, deltaX: 10, deltaY: 50, preventDefault() {}, currentTarget: video });
  await new Promise((resolve) => setImmediate(resolve));
  const wheels = socketEvents.filter(({ payload }) => payload.type === 'mouse' && payload.action === 'wheel');
  assert.equal(wheels.length, 1);
  assert.equal(wheels[0].payload.payload.deltaY, 150);
  assert.equal(wheels[0].payload.payload.deltaX, 10);
});

test('video pause does not permanently disable input while media gate is active', () => {
  const { Input, context, elements } = loadInput();
  activate(Input, context);
  Input.setupEventListeners();
  const video = elements.get('remoteVideo');
  context.WebRTC.canEnableDesktopInput = () => true;
  context.WebRTC.syncDesktopInputGate = () => {
    Input.setActive(context.WebRTC.canEnableDesktopInput());
  };
  Input.setActive(true);
  assert.equal(Input.isActive, true);
  video.listeners.get('pause')();
  assert.equal(Input.isActive, true, 'pause must re-sync through media gate, not force off');
  context.WebRTC.canEnableDesktopInput = () => false;
  video.listeners.get('pause')();
  assert.equal(Input.isActive, false);
});
