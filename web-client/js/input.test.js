const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function makeElement(onFocus = () => {}) {
  const listeners = new Map();
  const captured = new Set();
  return {
    value: '', textContent: '', style: {}, dataset: {}, listeners, captured,
    hidden: false, disabled: false, isConnected: true,
    videoWidth: 100, videoHeight: 100,
    classList: { add() {}, remove() {}, contains() { return false; } },
    focus() { onFocus(this); },
    blur() { onFocus(null, this); },
    setAttribute() {}, removeAttribute() {},
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
  const bodyClasses = new Set();
  const context = {
    console, setTimeout, clearTimeout, requestAnimationFrame: (fn) => fn(),
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { platform: 'MacIntel', userAgent: 'node-test' },
    window: { addEventListener(type, handler) { windowListeners.set(type, handler); } },
    getComputedStyle: (element) => ({ objectFit: element.style.objectFit || 'contain' }),
    document: {
      hidden: false,
      body: {
        classList: {
          add(name) { bodyClasses.add(name); },
          remove(name) { bodyClasses.delete(name); },
          contains(name) { return bodyClasses.has(name); },
          toggle(name, force) {
            const next = force === undefined ? !bodyClasses.has(name) : Boolean(force);
            if (next) bodyClasses.add(name);
            else bodyClasses.delete(name);
            return next;
          },
        },
      },
      activeElement: null,
      fullscreenElement: null,
      addEventListener(type, handler) { documentListeners.set(type, handler); },
      querySelectorAll: () => [],
      querySelector(selector) {
        if (selector !== '.viewer-container') return null;
        if (!elements.has('__viewerContainer')) elements.set('__viewerContainer', makeElement());
        return elements.get('__viewerContainer');
      },
      getElementById(id) {
        if (!elements.has(id)) {
          elements.set(id, makeElement((element, blurred) => {
            if (element) context.document.activeElement = element;
            else if (context.document.activeElement === blurred) context.document.activeElement = null;
          }));
          if (id === 'terminalPanel') elements.get(id).hidden = true;
        }
        return elements.get(id);
      },
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

function loadUi(context) {
  const source = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__UI = UI;`, context);
  return context.__UI;
}

function loadTouchAdapter(context) {
  const source = fs.readFileSync(path.join(__dirname, 'touch-input-adapter.js'), 'utf8');
  vm.runInContext(source, context);
}

function keyboard(type, overrides = {}) {
  return {
    type, code: 'KeyA', key: 'a', location: 0, repeat: false,
    ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, isComposing: false,
    target: { tagName: 'VIDEO', isContentEditable: false, closest: () => null },
    getModifierState: () => false, preventDefault() {}, ...overrides,
  };
}

function hiddenPointer(clientX, clientY) {
  const event = { currentTarget: null, pointerType: 'touch', pointerId: 1, preventDefault() {} };
  Object.defineProperty(event, 'clientX', { value: clientX, enumerable: false });
  Object.defineProperty(event, 'clientY', { value: clientY, enumerable: false });
  return event;
}

function activate(Input, context) {
  Input.videoElement = context.document.getElementById('remoteVideo');
  Input.initKeyboardController();
  Input.setControlLease({ leaseId: 'lease-000000000001', leaseEpoch: 3 });
  Input.setActive(true);
}

test('repeated active gate preserves the mobile textarea focus', () => {
  const { Input, context, elements } = loadInput();
  activate(Input, context);
  Input.setupTextInput();
  const video = elements.get('remoteVideo');
  const field = elements.get('mobileTextInput');
  video.focus = () => { context.document.activeElement = video; };
  field.focus = () => { context.document.activeElement = field; };
  Input.mobileTextInputAdapter.show();
  for (let i = 0; i < 120; i += 1) Input.setActive(true);
  assert.equal(context.document.activeElement, field);
});

test('playing callback does not steal focus from the mobile textarea', () => {
  const { Input, context, elements } = loadInput();
  activate(Input, context);
  Input.setupEventListeners();
  Input.setupTextInput();
  const video = elements.get('remoteVideo');
  const field = elements.get('mobileTextInput');
  video.focus = () => { context.document.activeElement = video; };
  field.focus = () => { context.document.activeElement = field; };
  Input.mobileTextInputAdapter.show();
  video.listeners.get('playing')?.();
  assert.equal(context.document.activeElement, field);
});

test('surface interactions dispatch focus through the guarded helper', () => {
  const { Input, context, elements } = loadInput();
  activate(Input, context);
  Input.setupEventListeners();
  const video = elements.get('remoteVideo');
  const calls = [];
  Input.focusDesktopSurface = (element, reason) => {
    calls.push([element, reason]);
    return true;
  };
  video.listeners.get('click')({});
  video.listeners.get('pointerdown')({
    pointerType: 'mouse', pointerId: 1, clientX: 40, clientY: 40, button: 0, buttons: 1,
    currentTarget: video, preventDefault() {},
  });
  assert.deepEqual(calls, [[video, 'surface-user'], [video, 'surface-user']]);
});

test('fullscreenchange preserves mobile text focus while updating fullscreen state', () => {
  const { Input, context, elements, documentListeners } = loadInput();
  activate(Input, context);
  Input.setupEventListeners();
  Input.setupTextInput();
  const video = elements.get('remoteVideo');
  const field = elements.get('mobileTextInput');
  video.focus = () => { context.document.activeElement = video; };
  field.focus = () => { context.document.activeElement = field; };
  Input.mobileTextInputAdapter.show();
  field.focus();

  const UI = loadUi(context);
  UI.setupControlButtons();
  const viewerContainer = context.document.querySelector('.viewer-container');
  context.document.fullscreenElement = viewerContainer;
  documentListeners.get('fullscreenchange')();

  assert.equal(context.document.activeElement, field);
  assert.equal(context.document.body.classList.contains('fullscreen-active'), true);
});

test('initial-ready focus does not steal modal or visible terminal focus', () => {
  const { Input, context, elements } = loadInput();
  activate(Input, context);
  Input.setupTextInput();
  const video = elements.get('remoteVideo');
  let focusCalls = 0;
  video.focus = () => {
    focusCalls += 1;
    context.document.activeElement = video;
  };

  const modalInput = context.document.getElementById('remoteTextInput');
  modalInput.closest = (selector) => selector === '.modal' ? {} : null;
  context.document.activeElement = modalInput;
  assert.equal(Input.focusDesktopSurface(video, 'initial-ready'), false);
  assert.equal(focusCalls, 0);

  const terminalPanel = elements.get('terminalPanel');
  terminalPanel.hidden = false;
  const terminalInput = elements.get('terminalComposer');
  context.document.activeElement = terminalInput;
  assert.equal(Input.focusDesktopSurface(video, 'initial-ready'), false);
  assert.equal(focusCalls, 0);

  assert.equal(Input.focusDesktopSurface(video, 'surface-user'), true);
  assert.equal(focusCalls, 1);
  video.isConnected = false;
  assert.equal(Input.focusDesktopSurface(video, 'surface-user'), false);
});

test('mobile input restores its opener only on an ordinary close', () => {
  const { Input, context, elements } = loadInput();
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const opener = elements.get('remoteVideo');
  const mobileButton = elements.get('mobileTextInputBtn');
  const mobileInput = elements.get('mobileTextInput');
  let openerFocuses = 0;
  opener.focus = () => {
    openerFocuses += 1;
    context.document.activeElement = opener;
  };
  mobileInput.focus = () => { context.document.activeElement = mobileInput; };
  context.document.activeElement = opener;
  mobileButton.listeners.get('click')({ preventDefault() {} });
  assert.equal(context.document.activeElement, mobileInput);
  mobileButton.listeners.get('click')({ preventDefault() {} });
  assert.equal(openerFocuses, 1);
  assert.equal(context.document.activeElement, opener);

  context.document.activeElement = opener;
  mobileButton.listeners.get('click')({ preventDefault() {} });
  Input.resetKeyboard('reset');
  assert.equal(openerFocuses, 1, 'reset must not restore the mobile opener');
});

test('mobile input does not restore a disconnected or newly focused opener', () => {
  const { Input, context, elements } = loadInput();
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const opener = elements.get('remoteVideo');
  const mobileButton = elements.get('mobileTextInputBtn');
  const mobileInput = elements.get('mobileTextInput');
  let openerFocuses = 0;
  opener.focus = () => {
    openerFocuses += 1;
    context.document.activeElement = opener;
  };
  mobileInput.focus = () => { context.document.activeElement = mobileInput; };
  context.document.activeElement = opener;
  mobileButton.listeners.get('click')({ preventDefault() {} });
  opener.isConnected = false;
  mobileButton.listeners.get('click')({ preventDefault() {} });
  assert.equal(openerFocuses, 0);

  opener.isConnected = true;
  context.document.activeElement = opener;
  mobileButton.listeners.get('click')({ preventDefault() {} });
  const anotherTarget = elements.get('textInputBtn');
  context.document.activeElement = anotherTarget;
  mobileButton.listeners.get('click')({ preventDefault() {} });
  assert.equal(openerFocuses, 0, 'a new user focus must not be overridden');
});

test('ordinary text modal does not restore an opener hidden by an ancestor', () => {
  const { Input, context, elements } = loadInput();
  activate(Input, context);
  Input.setupTextInput();
  const opener = context.document.getElementById('desktopOpener');
  const hiddenPanel = context.document.getElementById('desktopPanel');
  hiddenPanel.hidden = true;
  hiddenPanel.classList = { add() {}, remove() {}, contains: (name) => name === 'hidden' };
  opener.parentElement = hiddenPanel;
  let openerFocuses = 0;
  opener.focus = () => {
    openerFocuses += 1;
    context.document.activeElement = opener;
  };

  context.document.activeElement = opener;
  elements.get('textInputBtn').listeners.get('click')({ preventDefault() {} });
  elements.get('textInputCancelBtn').listeners.get('click')({ preventDefault() {} });
  assert.equal(openerFocuses, 0);

  hiddenPanel.hidden = false;
  hiddenPanel.classList.contains = () => false;
  context.document.activeElement = opener;
  elements.get('textInputBtn').listeners.get('click')({ preventDefault() {} });
  elements.get('textInputCancelBtn').listeners.get('click')({ preventDefault() {} });
  assert.equal(openerFocuses, 1, 'visible opener remains eligible for ordinary modal restore');
});

test('mobile viewer acceptance CLI exposes the required operator-supplied arguments without reading a password', () => {
  const result = childProcess.spawnSync('python3', [
    path.join(__dirname, '../../scripts/mobile_viewer_acceptance.py'), '--help',
  ], { encoding: 'utf8', env: {} });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--base-url/);
  assert.match(result.stdout, /--password-env/);
  assert.match(result.stdout, /--out/);
});

test('touch click, touch wheel, and mobile text retain the active v2 lease envelope', () => {
  const { Input, context, elements, socketEvents } = loadInput();
  loadTouchAdapter(context);
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupEventListeners();
  Input.setupTextInput();
  const video = elements.get('remoteVideo');
  const touch = (type, pointerId, clientX, clientY) => video.listeners.get(type)({
    pointerType: 'touch', pointerId, isPrimary: pointerId === 1,
    clientX, clientY, buttons: type === 'pointerup' ? 0 : 1,
    currentTarget: video, preventDefault() {}, timeStamp: 10,
  });

  touch('pointerdown', 1, 40, 40);
  touch('pointerup', 1, 40, 40);
  touch('pointerdown', 1, 40, 40);
  touch('pointerdown', 2, 60, 40);
  touch('pointermove', 2, 60, 60);
  touch('pointerup', 2, 60, 60);
  touch('pointerup', 1, 40, 40);
  assert.equal(Input.keyboardTransport.getSnapshot().pendingCount, 0, 'mouse input must not enter keyboard pending');

  const mobileInput = elements.get('mobileTextInput');
  mobileInput.value = 'm';
  mobileInput.listeners.get('input')({ target: mobileInput });

  const inputs = socketEvents.filter(({ event }) => event === 'input').map(({ payload }) => payload);
  assert.deepEqual(inputs.map(({ type, action }) => [type, action]), [
    ['mouse', 'down'], ['mouse', 'up'], ['mouse', 'wheel'], ['keyboard', 'text'],
  ]);
  for (const payload of inputs) {
    assert.equal(payload.schemaVersion, 2);
    assert.equal(payload.leaseId, 'lease-000000000001');
    assert.equal(payload.leaseEpoch, 3);
    assert.equal(Number.isSafeInteger(payload.seq), true);
  }
});

test('touch mapPoint keeps PointerEvent prototype geometry', () => {
  const { Input, context, socketEvents } = loadInput();
  loadTouchAdapter(context);
  activate(Input, context);
  const video = context.document.getElementById('remoteVideo');
  video.videoWidth = 200;
  video.videoHeight = 100;
  Input.refreshGeometry = () => ({ left: 0, top: 0, width: 200, height: 100 });
  const adapter = Input.bindTouchAdapter(video);
  const down = Object.assign(hiddenPointer(40, 25), {
    currentTarget: video, isPrimary: true, buttons: 1, timeStamp: 10,
  });
  const up = Object.assign(hiddenPointer(40, 25), {
    currentTarget: video, isPrimary: true, buttons: 0, timeStamp: 20,
  });
  video.listeners.get('pointerdown')(down);
  video.listeners.get('pointerup')(up);
  const inputs = socketEvents.filter(({ event }) => event === 'input').map(({ payload }) => payload);
  assert.equal(adapter.getSnapshot().state, 'IDLE');
  assert.deepEqual(inputs.map(({ action }) => action), ['down', 'up']);
  assert.equal(Number.isFinite(inputs[0].payload.relX), true);
  assert.equal(Number.isFinite(inputs[0].payload.relY), true);
});

test('touch geometry change releases a drag before stale coordinates are sent', () => {
  const { Input, context, socketEvents } = loadInput();
  loadTouchAdapter(context);
  activate(Input, context);
  const video = context.document.getElementById('remoteVideo');
  let rect = { left: 0, top: 0, width: 100, height: 100 };
  video.getBoundingClientRect = () => ({ ...rect });
  video.videoWidth = 100;
  video.videoHeight = 100;
  context.requestAnimationFrame = () => 1;
  const adapter = Input.bindTouchAdapter(video);
  const touch = (type, overrides = {}) => video.listeners.get(type)({
    pointerType: 'touch', pointerId: 1, isPrimary: true,
    clientX: 20, clientY: 20, buttons: type === 'pointerup' ? 0 : 1,
    currentTarget: video, preventDefault() {}, timeStamp: 10, ...overrides,
  });

  touch('pointerdown');
  touch('pointermove', { clientX: 40 });
  rect = { ...rect, width: 120 };
  touch('pointermove', { clientX: 60 });
  touch('pointerup', { clientX: 60 });

  const actions = socketEvents.filter(({ event }) => event === 'input').map(({ payload }) => payload.action);
  assert.deepEqual(actions, ['down', 'reset']);
  assert.equal(adapter.getSnapshot().state, 'IDLE');
  assert.equal(Input._pendingMouseReset, true);
});

test('touch geometry signature aborts contain-to-cover and source-size changes', () => {
  const run = (mutate) => {
    const { Input, context, socketEvents } = loadInput();
    loadTouchAdapter(context);
    activate(Input, context);
    const video = context.document.getElementById('remoteVideo');
    let rect = { left: 0, top: 0, width: 100, height: 100 };
    video.getBoundingClientRect = () => ({ ...rect });
    video.videoWidth = 100;
    video.videoHeight = 100;
    video.style.objectFit = 'contain';
    context.requestAnimationFrame = () => 1;
    const adapter = Input.bindTouchAdapter(video);
    const touch = (type, overrides = {}) => video.listeners.get(type)({
      pointerType: 'touch', pointerId: 1, isPrimary: true,
      clientX: 20, clientY: 20, buttons: type === 'pointerup' ? 0 : 1,
      currentTarget: video, preventDefault() {}, timeStamp: 10, ...overrides,
    });
    touch('pointerdown');
    touch('pointermove', { clientX: 40 });
    mutate({ video, setRect: (next) => { rect = { ...rect, ...next }; } });
    touch('pointerup', { clientX: 40 });
    return {
      actions: socketEvents.filter(({ event }) => event === 'input').map(({ payload }) => payload.action),
      state: adapter.getSnapshot().state,
    };
  };

  assert.deepEqual(run(({ video }) => { video.style.objectFit = 'cover'; }), { actions: ['down', 'reset'], state: 'IDLE' });
  assert.deepEqual(run(({ video }) => { video.videoWidth = 120; }), { actions: ['down', 'reset'], state: 'IDLE' });
});

test('touch wheel queued past the final pointerup is cancelled by a geometry change', async () => {
  const { Input, context, elements, socketEvents } = loadInput();
  loadTouchAdapter(context);
  activate(Input, context);
  const video = elements.get('remoteVideo');
  let rect = { left: 0, top: 0, width: 100, height: 100 };
  let frame = null;
  video.getBoundingClientRect = () => ({ ...rect });
  video.videoWidth = 100;
  video.videoHeight = 100;
  context.requestAnimationFrame = (callback) => { frame = callback; return 1; };
  Input.setupEventListeners();
  const touch = (type, pointerId, clientX, clientY, overrides = {}) => video.listeners.get(type)({
    pointerType: 'touch', pointerId, isPrimary: pointerId === 1,
    clientX, clientY, buttons: type === 'pointerup' ? 0 : 1,
    currentTarget: video, preventDefault() {}, timeStamp: 10, ...overrides,
  });

  touch('pointerdown', 1, 20, 20);
  touch('pointerdown', 2, 40, 40, { isPrimary: false });
  touch('pointermove', 2, 40, 60, { isPrimary: false });
  touch('pointerup', 1, 20, 20);
  touch('pointerup', 2, 40, 60, { isPrimary: false });
  assert.equal(Input._lastTouchAdapter.getSnapshot().wheelPending, true);
  assert.equal(typeof frame, 'function');
  rect = { ...rect, width: 120 };
  frame?.();
  await Promise.resolve();

  const wheels = socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'wheel');
  assert.equal(wheels.length, 0);
  assert.equal(Input._lastTouchAdapter.getSnapshot().wheelPending, false);
});

test('mouse geometry changes abort before mapping the next point', () => {
  const { Input, context, socketEvents } = loadInput();
  activate(Input, context);
  const element = makeElement();
  let rect = { left: 0, top: 0, width: 100, height: 100 };
  element.getBoundingClientRect = () => ({ ...rect });
  element.videoWidth = 100;
  element.videoHeight = 100;
  context.requestAnimationFrame = () => 1;
  Input.bindMouseEvents(element);

  const pointer = (type, overrides = {}) => element.listeners.get(type)({
    pointerType: 'mouse', pointerId: 8, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    clientX: 20, clientY: 20, currentTarget: element, preventDefault() {}, ...overrides,
  });
  pointer('pointerdown');
  rect = { ...rect, height: 120 };
  pointer('pointermove', { clientX: 40 });
  pointer('pointerup', { clientX: 40, buttons: 0 });

  const actions = socketEvents.filter(({ event }) => event === 'input').map(({ payload }) => payload.action);
  assert.deepEqual(actions, ['down', 'reset']);
});

test('queued mouse and pen moves revalidate source geometry before rAF', () => {
  const run = ({ pointerType = 'mouse', resize = false, press = false } = {}) => {
    const { Input, context, socketEvents } = loadInput();
    activate(Input, context);
    const element = makeElement();
    let rect = { left: 0, top: 0, width: 100, height: 100 };
    let frame = null;
    element.getBoundingClientRect = () => ({ ...rect });
    element.videoWidth = 100;
    element.videoHeight = 100;
    context.requestAnimationFrame = (callback) => { frame = callback; return 1; };
    Input.bindMouseEvents(element);

    const pointer = (type, overrides = {}) => element.listeners.get(type)({
      pointerType, pointerId: 8, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      clientX: 20, clientY: 20, currentTarget: element, preventDefault() {}, ...overrides,
    });
    if (press) pointer('pointerdown');
    pointer('pointermove', { clientX: 40, buttons: press ? 1 : 0 });
    if (resize) rect = { ...rect, width: 120 };
    frame?.();
    return socketEvents.filter(({ event }) => event === 'input').map(({ payload }) => payload.action);
  };

  assert.deepEqual(run({ press: true }), ['down', 'move']);
  assert.deepEqual(run({ press: true, resize: true }), ['down', 'reset']);
  assert.deepEqual(run({ pointerType: 'pen', resize: true }), []);
});

test('failed touch reset is rearmed by a new lease and allows a real touch click', () => {
  const { Input, context, elements, socketEvents } = loadInput();
  loadTouchAdapter(context);
  activate(Input, context);
  Input.setupEventListeners();
  const video = elements.get('remoteVideo');
  const touch = (type, overrides = {}) => video.listeners.get(type)({
    pointerType: 'touch', pointerId: 1, isPrimary: true,
    clientX: 40, clientY: 40, buttons: type === 'pointerup' ? 0 : 1,
    currentTarget: video, preventDefault() {}, timeStamp: 10, ...overrides,
  });

  touch('pointerdown');
  touch('pointermove', { clientX: 60 });
  assert.equal(Input._lastTouchAdapter.getSnapshot().state, 'DRAGGING');
  context.WebRTC.socket.connected = false;
  touch('pointercancel');
  assert.equal(Input._pendingMouseReset, true);
  assert.equal(Input._pendingMouseResetId, null);
  assert.equal(Input._lastTouchAdapter.getSnapshot().pendingReset, true);

  Input.setControlLease({ leaseId: 'lease-000000000099', leaseEpoch: 9 });
  context.WebRTC.socket.connected = true;
  touch('pointerdown', { pointerId: 2, clientX: 40, clientY: 40 });
  touch('pointerup', { pointerId: 2, clientX: 40, clientY: 40 });

  const actions = socketEvents.filter(({ event }) => event === 'input').map(({ payload }) => payload.action);
  assert.deepEqual(actions, ['down', 'move', 'down', 'up']);
  assert.equal(Input._lastTouchAdapter.getSnapshot().pendingReset, false);
});

test('v2 mouse and command writes have a monotonic sequence that resets with a new lease', () => {
  const { Input, context, socketEvents } = loadInput();
  activate(Input, context);

  Input.sendInput('mouse', 'move', { relX: 0.2, relY: 0.2, buttons: 0 });
  Input.sendInput('mouse', 'down', { button: 'left' });
  Input.sendInput('mouse', 'up', { button: 'left' });
  Input.sendInput('mouse', 'wheel', { deltaY: 1 });
  Input.sendInput('mouse', 'reset', { reason: 'test-reset' });
  Input.sendInput('command', 'showDock', {});

  const beforeLeaseChange = socketEvents.filter(({ event }) => event === 'input').map(({ payload }) => payload);
  assert.deepEqual(beforeLeaseChange.map(({ seq }) => seq), [undefined, 1, 2, 3, 4, 5]);
  assert.equal(beforeLeaseChange.every(({ schemaVersion, seq, action }) => schemaVersion === 2
    && (action === 'move' ? seq === undefined : Number.isSafeInteger(seq))), true);

  Input.setControlLease({ leaseId: 'lease-000000000002', leaseEpoch: 4 });
  Input.sendInput('mouse', 'reset', { reason: 'lease-transition' });
  assert.equal(socketEvents.filter(({ event }) => event === 'input').at(-1).payload.seq, 1);
});

test('failed reliable mouse write does not consume desktop seq', () => {
  const { Input, context } = loadInput();
  activate(Input, context);
  Input.socket = { connected: false, emit() {} };
  context.WebRTC.socket.connected = false;
  context.WebRTC.sendInput = () => false;
  assert.equal(Input.sendInput('mouse', 'down', {
    relX: 0.2, relY: 0.3, button: 'left', clickCount: 1, buttons: 1,
  }), null);
  assert.equal(Input._desktopWriteSequence, 0);
  context.WebRTC.socket.connected = true;
  Input.socket = context.WebRTC.socket;
  const id = Input.sendInput('mouse', 'down', {
    relX: 0.2, relY: 0.3, button: 'left', clickCount: 1, buttons: 1,
  });
  assert.ok(id);
  assert.equal(Input._desktopWriteSequence, 1);
});

test('failed desktop execution ACK reconciles the next mouse and command sequence', () => {
  for (const [failedType, nextType] of [['mouse', 'command'], ['command', 'mouse']]) {
    const { Input, context, socketEvents } = loadInput();
    activate(Input, context);
    const failedId = failedType === 'mouse'
      ? Input.sendInput('mouse', 'down', {
        relX: 0.2, relY: 0.3, button: 'left', clickCount: 1, buttons: 1,
      })
      : Input.sendInput('command', 'showDock', {});
    assert.ok(failedId);
    const failed = socketEvents.at(-1).payload;
    assert.equal(failed.seq, 1);

    const ack = Input.acceptMouseAck({
      inputType: failedType,
      schemaVersion: 2,
      leaseEpoch: 3,
      status: 'execution-failed',
      appliedSeq: 0,
      inputIds: [failedId],
    });
    assert.equal(ack.status, 'execution-failed');
    assert.equal(ack.recovery, 'reconciled');

    const nextId = nextType === 'mouse'
      ? Input.sendInput('mouse', 'up', {
        relX: 0.2, relY: 0.3, button: 'left', clickCount: 1, buttons: 0,
      })
      : Input.sendInput('command', 'showDock', {});
    assert.ok(nextId);
    assert.equal(socketEvents.at(-1).payload.seq, 1);
  }
});

test('keyboard acknowledgement does not clear pending mouse reset', () => {
  const { Input } = loadInput();
  Input._pendingMouseReset = true;
  Input._pendingMouseResetId = 'inp_reset';
  assert.equal(Input.acceptMouseAck({
    inputType: 'keyboard', status: 'applied', inputIds: ['inp_reset'],
  }).status, 'stale');
  assert.equal(Input._pendingMouseReset, true);
});

test('explicit falsy inputType cannot clear a mouse reset barrier', () => {
  for (const inputType of ['', false, 0]) {
    const { Input } = loadInput();
    Input._pendingMouseReset = true;
    Input._pendingMouseResetId = 'reset-falsy-type';
    assert.equal(Input.acceptMouseAck({
      inputType, status: 'applied', inputIds: ['reset-falsy-type'],
    }).status, 'stale');
    assert.equal(Input._pendingMouseReset, true);
  }
});

test('new active lease clears a failed mouse reset barrier', () => {
  const { Input, context } = loadInput();
  activate(Input, context);
  Input._pendingMouseReset = true;
  Input._pendingMouseResetId = null;
  Input.setControlLease({ leaseId: 'lease-000000000099', leaseEpoch: 9 });
  assert.equal(Input._pendingMouseReset, false);
});

test('reset, park, lease revocation, and disconnect clear virtual modifier latches', () => {
  const lifecycleCases = [
    ['reset', (Input) => Input.resetKeyboard('acceptance-reset')],
    ['park', (Input) => Input.parkKeyboard('visibility-hidden')],
    ['lease-revocation', (Input) => Input.setControlLease(null)],
    ['disconnect', (Input) => Input.setActive(false, { resetKeyboard: true, reason: 'disconnect' })],
  ];

  for (const [name, applyLifecycle] of lifecycleCases) {
    const { Input, context } = loadInput();
    activate(Input, context);
    assert.equal(Input.keyboardController.setVirtualModifier('shift', true), true, name);
    assert.equal(Array.from(Input.keyboardController.getSnapshot().virtualModifiers).join(','), 'shift', name);
    applyLifecycle(Input);
    assert.equal(Input.keyboardController.getSnapshot().pressedKeyCount, 0, name);
    assert.equal(Array.from(Input.keyboardController.getSnapshot().virtualModifiers).length, 0, name);
  }
});

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

test('mobile modifier toggles one controller key down and up without a direct WebRTC button send', () => {
  const { Input, context, socketEvents } = loadInput();
  const modifierButton = makeElement();
  modifierButton.dataset.mobileAction = 'shift';
  const attributes = new Map([['aria-pressed', 'false']]);
  modifierButton.setAttribute = (name, value) => attributes.set(name, String(value));
  modifierButton.getAttribute = (name) => attributes.get(name) || null;
  context.document.querySelectorAll = (selector) => selector === '.action-btn, [data-mobile-action]'
    ? [modifierButton]
    : [];
  let directWebRtcSends = 0;
  context.WebRTC.sendInput = () => { directWebRtcSends += 1; return true; };
  activate(Input, context);
  Input.setupActionButtons();

  const click = modifierButton.listeners.get('click');
  assert.equal(typeof click, 'function');
  click({ preventDefault() {} });
  click({ preventDefault() {} });

  const keyActions = socketEvents
    .filter(({ event, payload }) => event === 'input' && payload.action === 'key')
    .map(({ payload }) => [payload.payload.phase, payload.payload.code]);
  assert.deepEqual(keyActions, [['down', 'ShiftLeft'], ['up', 'ShiftLeft']]);
  assert.equal(modifierButton.getAttribute('aria-pressed'), 'false');
  assert.equal(directWebRtcSends, 0);
});

test('mobile right click uses the most recently mapped touch adapter', () => {
  const { Input, context } = loadInput();
  const rightClickButton = makeElement();
  rightClickButton.dataset.mobileAction = 'rightClick';
  context.document.querySelectorAll = (selector) => selector === '.action-btn, [data-mobile-action]'
    ? [rightClickButton]
    : [];
  activate(Input, context);
  const calls = [];
  const videoAdapter = { clickButton: (button) => calls.push(['video', button]) };
  const relayAdapter = { clickButton: (button) => calls.push(['relay', button]) };
  Input._touchAdapters.set(Input.videoElement, videoAdapter);
  Input._touchAdapters.set(context.document.getElementById('relayImage'), relayAdapter);
  Input._lastTouchAdapter = relayAdapter;
  Input.setupActionButtons();

  rightClickButton.listeners.get('click')({ preventDefault() {} });

  assert.deepEqual(calls, [['relay', 'right']]);
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

test('mobile draft retry waits for the keyboard ACK and only resends unsent text', () => {
  const { Input, context, elements, socketEvents } = loadInput();
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const mobileInput = elements.get('mobileTextInput');

  mobileInput.value = 'a';
  mobileInput.listeners.get('input')({ target: mobileInput });
  const first = socketEvents.filter(({ event }) => event === 'input').at(-1).payload;
  assert.equal(first.action, 'text');
  assert.equal(Input.keyboardTransport.getSnapshot().pendingCount, 1);

  // With the socket adapter unavailable, the next edit is retained locally;
  // the adapter must not turn a transport rejection into an automatic retry.
  Input.keyboardTransport.markAdapterUnavailable('socket');
  mobileInput.value = 'ab';
  mobileInput.listeners.get('input')({ target: mobileInput });
  let snapshot = Input.mobileTextInputAdapter.getSnapshot();
  assert.equal(snapshot.hasPending, true);
  assert.equal(snapshot.retryable, false);
  assert.equal(socketEvents.filter(({ event }) => event === 'input').length, 1);

  Input.acceptKeyboardAck({
    schemaVersion: 2,
    leaseEpoch: 3,
    status: 'applied',
    appliedSeq: first.seq,
    inputIds: first.inputIds,
  });
  snapshot = Input.mobileTextInputAdapter.getSnapshot();
  assert.equal(snapshot.hasPending, true);
  assert.equal(snapshot.retryable, true, 'ACK settles delivery and unlocks explicit retry');
  assert.equal(Input.mobileTextInputAdapter.retryPending(), false);

  Input.keyboardTransport.markAdapterAvailable('socket');
  assert.equal(Input.mobileTextInputAdapter.retryPending(), true);
  const textPayloads = socketEvents
    .filter(({ event, payload }) => event === 'input' && payload.action === 'text')
    .map(({ payload }) => payload.payload.text);
  assert.deepEqual(textPayloads, ['a', 'b']);
});

test('mobile transport state bridge is single-owner and lifecycle lease changes clear drafts', () => {
  const { Input, context, elements } = loadInput();
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const mobileInput = elements.get('mobileTextInput');
  const adapter = Input.mobileTextInputAdapter;
  const firstUnsubscribe = Input._mobileTextTransportUnsubscribe;
  Input.initKeyboardController();
  assert.equal(Input._mobileTextTransportUnsubscribe, firstUnsubscribe);

  adapter.onTransportState('blocked');
  assert.equal(adapter.getSnapshot().status, 'blocked');
  adapter.onTransportState('reacquire-required');
  assert.equal(adapter.getSnapshot().deliveryUncertain, true);
  assert.equal(adapter.getSnapshot().retryable, false);

  mobileInput.value = 'draft';
  mobileInput.listeners.get('input')({ target: mobileInput });
  assert.equal(adapter.getSnapshot().hasPending, true);
  Input.setControlLease({ leaseId: 'lease-000000000009', leaseEpoch: 9 });
  assert.equal(mobileInput.value, '\u200b');
  assert.equal(adapter.getSnapshot().hasPending, false);
  assert.equal(adapter.getSnapshot().shown, false);

  // Same identity is idempotent and must not clear a new local draft.
  Input.setupTextInput();
  adapter.onTransportState('blocked');
  mobileInput.value = 'new';
  mobileInput.listeners.get('input')({ target: mobileInput });
  Input.setControlLease({ leaseId: 'lease-000000000009', leaseEpoch: 9 });
  assert.equal(adapter.getSnapshot().hasPending, true);
  Input.setControlLease(null);
  assert.equal(adapter.getSnapshot().hasPending, false);
  assert.equal(adapter.getSnapshot().status, 'uncertain');
});

test('mobile draft status and retry/discard controls stay metadata-only and bounded', () => {
  const { Input, context, elements } = loadInput();
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const mobileInput = elements.get('mobileTextInput');
  const status = elements.get('mobileInputStatus');
  const retry = elements.get('mobileInputRetryBtn');
  const discard = elements.get('mobileInputDiscardBtn');
  Input.mobileTextInputAdapter.onTransportState('blocked');
  mobileInput.value = 'draft';
  mobileInput.listeners.get('input')({ target: mobileInput });

  assert.equal(status.hidden, false);
  assert.equal(status.textContent, '暂不可输入');
  assert.equal(retry.hidden, false);
  assert.equal(retry.disabled, true);
  assert.equal(discard.hidden, false);
  discard.listeners.get('click')({ preventDefault() {} });
  assert.equal(Input.mobileTextInputAdapter.getSnapshot().hasPending, false);
  assert.equal(status.hidden, true);
  assert.equal(retry.hidden, true);
  assert.equal(discard.hidden, true);
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
  assert.equal(socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'reset').length, 0);
  assert.equal(Input.getDiagnosticState().keyboard.lastResetReason, 'window-blur');
  assert.equal(Input.keyboardController.getSnapshot().state, 'READY');
});

test('mobile input reset clears the reserved Dock state', () => {
  const { Input, context } = loadInput();
  context.document.body.classList.add('mobile-input-visible');

  Input.resetKeyboard('control-lost');

  assert.equal(context.document.body.classList.contains('mobile-input-visible'), false);
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

test('mobile text and mouse input never place content or coordinates in diagnostics', () => {
  const { Input, context } = loadInput();
  activate(Input, context);
  Input.sendInput('mouse', 'down', { relX: 0.25, relY: 0.75, button: 'left', buttons: 1 });
  Input.keyboardController.sendText('private-mobile-text');

  const diagnostic = JSON.stringify(Input.getDiagnosticState());
  assert.doesNotMatch(diagnostic, /private-mobile-text|relX|relY|button|text/);
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

test('mouse input with no open transport returns null and records no latency pending entry', () => {
  const { Input, context } = loadInput();
  activate(Input, context);
  Input.socket = { connected: false, emit() {} };
  context.WebRTC.socket.connected = false;
  Input.inputChannel = null;
  let recordCalls = 0;
  Input.recordLatency = () => { recordCalls += 1; };
  const id = Input.sendInput('mouse', 'move', { relX: 0.25, relY: 0.5, buttons: 0 });
  assert.equal(id, null);
  assert.equal(recordCalls, 0);
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
