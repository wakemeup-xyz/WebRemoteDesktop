const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function makeElement() {
  const listeners = new Map();
  const captured = new Set();
  return {
    textContent: '',
    style: {},
    focus() {},
    videoWidth: 100,
    videoHeight: 100,
    listeners,
    captured,
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 100 };
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    setPointerCapture(pointerId) {
      captured.add(pointerId);
    },
    releasePointerCapture(pointerId) {
      captured.delete(pointerId);
    },
    hasPointerCapture(pointerId) {
      return captured.has(pointerId);
    },
    setAttribute() {},
  };
}

function loadInput() {
  const elements = new Map();
  const context = {
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => fn(),
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    navigator: {
      platform: 'MacIntel',
      userAgent: 'node-test',
    },
    window: {
      addEventListener() {},
    },
    getComputedStyle: (element) => ({ objectFit: element.style.objectFit || 'contain' }),
    document: {
      hidden: false,
      addEventListener() {},
      querySelectorAll: () => [],
      getElementById(id) {
        if (!elements.has(id)) {
          elements.set(id, makeElement());
        }
        return elements.get(id);
      },
    },
    WebRTC: {
      socket: { connected: true },
      sendInput: () => true,
    },
    LatencyMonitor: { recordInputSend() {} },
  };
  context.globalThis = context;
  vm.createContext(context);
  const geometrySource = fs.readFileSync(path.join(__dirname, 'input-geometry.js'), 'utf8');
  vm.runInContext(geometrySource, context);
  const source = fs.readFileSync(path.join(__dirname, 'input.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__Input = Input;`, context);
  Object.defineProperty(context.__Input, '__testContext', { value: context });
  return context.__Input;
}

function loadInputWithListeners() {
  const elements = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const context = {
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => fn(),
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    navigator: {
      platform: 'MacIntel',
      userAgent: 'node-test',
    },
    window: {
      addEventListener(type, handler) {
        windowListeners.set(type, handler);
      },
    },
    getComputedStyle: (element) => ({ objectFit: element.style.objectFit || 'contain' }),
    document: {
      hidden: false,
      addEventListener(type, handler) {
        documentListeners.set(type, handler);
      },
      querySelectorAll: () => [],
      getElementById(id) {
        if (!elements.has(id)) {
          elements.set(id, makeElement());
        }
        return elements.get(id);
      },
    },
    WebRTC: {
      socket: { connected: true },
      sendInput: () => true,
    },
    LatencyMonitor: { recordInputSend() {} },
  };
  context.globalThis = context;
  vm.createContext(context);
  const geometrySource = fs.readFileSync(path.join(__dirname, 'input-geometry.js'), 'utf8');
  vm.runInContext(geometrySource, context);
  const source = fs.readFileSync(path.join(__dirname, 'input.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__Input = Input;`, context);
  return { Input: context.__Input, documentListeners, windowListeners, elements, context };
}

function makeKeyboardEvent(overrides = {}) {
  return {
    key: 'a',
    code: 'KeyA',
    keyCode: 65,
    which: 65,
    repeat: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    preventDefault() {},
    target: {
      tagName: 'DIV',
      isContentEditable: false,
      closest() {
        return null;
      },
    },
    ...overrides,
  };
}

test('deactivating input sends keyboard reset even when no local keys are tracked', () => {
  const Input = loadInput();
  const sent = [];

  Input.videoElement = makeElement();
  Input.isActive = true;
  Input._pressedKeys.clear();
  Input.sendInput = (type, action, payload) => {
    sent.push({ type, action, payload });
    return 'test-input-id';
  };

  Input.setActive(false);

  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
    {
      type: 'keyboard',
      action: 'reset',
      payload: {
        reason: 'deactivated',
        modifiers: { ctrl: 0, shift: 0, alt: 0, meta: 0 },
      },
    },
  ]);
});


test('action buttons bind even before WebRTC init when video element exists', () => {
  const listeners = [];
  function button(action) {
    return {
      dataset: { action },
      addEventListener(type, handler) {
        listeners.push({ action, type, handler });
      },
    };
  }

  const buttons = [button('enter'), button('copy')];
  const elements = new Map();
  const context = {
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => fn(),
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { platform: 'MacIntel', userAgent: 'node-test' },
    window: { addEventListener() {} },
    document: {
      hidden: false,
      addEventListener() {},
      querySelectorAll: (sel) => sel === '.action-btn' ? buttons : [],
      getElementById(id) {
        if (!elements.has(id)) {
          elements.set(id, makeElement());
        }
        return elements.get(id);
      },
    },
    WebRTC: { socket: { connected: false }, sendInput: () => true },
  };
  context.globalThis = context;
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, 'input.js'), 'utf8');
  vm.runInContext(`${source}
globalThis.__Input = Input;`, context);
  const Input = context.__Input;
  Input.videoElement = makeElement();
  Input.setupActionButtons();
  assert.equal(listeners.length, 2);
});


test('diagnostic snapshot reports keyboard mode and last release reason', () => {
  const Input = loadInput();
  Input.videoElement = makeElement();
  Input.keyboardMode = 'windows';
  Input._pressedKeys.clear();
  Input.sendInput = () => 'test-input-id';

  Input.releaseAllKeys('visibility-hidden', true);

  const snapshot = JSON.parse(JSON.stringify(Input.getDiagnosticState()));
  assert.equal(snapshot.keyboardMode, 'windows');
  assert.equal(snapshot.lastReleaseAllReason, 'visibility-hidden');
  assert.equal(snapshot.lastKeyboardResetReason, 'visibility-hidden');
  assert.equal(Array.isArray(snapshot.recentInputEvents), true);
  assert.equal(snapshot.recentInputEvents.at(-1).reason, 'visibility-hidden');
});

test('repeated keydown forwards held non-modifier key without duplicating tracked state', () => {
  const { Input, documentListeners } = loadInputWithListeners();
  const sent = [];

  Input.videoElement = makeElement();
  Input.socket = { connected: true };
  Input.isActive = true;
  Input.sendInput = (type, action, payload) => {
    sent.push({ type, action, payload });
    return `test-input-${sent.length}`;
  };

  Input.setupEventListeners();
  const keydown = documentListeners.get('keydown');
  assert.ok(keydown);

  keydown(makeKeyboardEvent());
  keydown(makeKeyboardEvent({ repeat: true }));

  assert.equal(Input._pressedKeys.size, 1);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(({ action, payload }) => ({ action, key: payload.key, code: payload.code })), [
    { action: 'keydown', key: 'a', code: 'KeyA' },
    { action: 'keydown', key: 'a', code: 'KeyA' },
  ]);
});

test('repeated keydown still ignores held modifier keys', () => {
  const { Input, documentListeners } = loadInputWithListeners();
  const sent = [];

  Input.videoElement = makeElement();
  Input.socket = { connected: true };
  Input.isActive = true;
  Input.sendInput = (type, action, payload) => {
    sent.push({ type, action, payload });
    return `test-input-${sent.length}`;
  };

  Input.setupEventListeners();
  const keydown = documentListeners.get('keydown');
  assert.ok(keydown);

  keydown(makeKeyboardEvent({ key: 'Shift', code: 'ShiftLeft', keyCode: 16, which: 16 }));
  keydown(makeKeyboardEvent({ key: 'Shift', code: 'ShiftLeft', keyCode: 16, which: 16, repeat: true, shiftKey: true }));

  assert.equal(Input._pressedKeys.size, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'keydown');
  assert.equal(sent[0].payload.key, 'Shift');
});

test('duplicate keyboard resets with same reason are suppressed briefly', () => {
  const Input = loadInput();
  const sent = [];

  Input.sendInput = (type, action, payload) => {
    sent.push({ type, action, payload });
    return `test-input-${sent.length}`;
  };

  Input.sendKeyboardReset('activated');
  Input.sendKeyboardReset('activated');
  Input.sendKeyboardReset('deactivated');

  assert.deepEqual(sent.map(({ action, payload }) => ({ action, reason: payload.reason })), [
    { action: 'reset', reason: 'activated' },
    { action: 'reset', reason: 'deactivated' },
  ]);
});

test('pointer double-click sends exactly two down/up pairs with click counts', () => {
  const Input = loadInput();
  const element = makeElement();
  const sent = [];
  Input.isActive = true;
  Input.sendInput = (type, action, payload) => {
    sent.push({ type, action, payload });
    return `input-${sent.length}`;
  };
  Input.bindMouseEvents(element);

  const event = (detail) => ({
    pointerId: 7,
    button: 0,
    detail,
    clientX: 50,
    clientY: 50,
    currentTarget: element,
    preventDefault() {},
  });
  element.listeners.get('pointerdown')(event(1));
  element.listeners.get('pointerup')(event(1));
  element.listeners.get('pointerdown')(event(2));
  element.listeners.get('pointerup')(event(2));

  assert.deepEqual(sent.map(({ action, payload }) => `${action}:${payload.clickCount}`), [
    'down:1', 'up:1', 'down:2', 'up:2',
  ]);
  assert.equal(sent.some(({ action }) => action === 'dblclick'), false);
});

test('pointer cancel releases capture and sends one idempotent mouse reset', () => {
  const Input = loadInput();
  const element = makeElement();
  const sent = [];
  Input.isActive = true;
  Input.sendInput = (type, action, payload) => {
    sent.push({ type, action, payload });
    return `input-${sent.length}`;
  };
  Input.bindMouseEvents(element);
  const down = {
    pointerId: 9,
    button: 0,
    detail: 1,
    clientX: 20,
    clientY: 20,
    currentTarget: element,
    preventDefault() {},
  };

  element.listeners.get('pointerdown')(down);
  assert.equal(element.captured.has(9), true);
  element.listeners.get('pointercancel')({ ...down, type: 'pointercancel' });
  Input.releasePointer('second-release');

  assert.equal(element.captured.has(9), false);
  assert.equal(sent.filter(({ action }) => action === 'reset').length, 1);
});

test('window blur converges on the same pointer reset path', () => {
  const { Input, windowListeners, context } = loadInputWithListeners();
  const sent = [];
  Input.videoElement = context.document.getElementById('remoteVideo');
  Input.isActive = true;
  Input.sendInput = (type, action, payload) => {
    sent.push({ type, action, payload });
    return `input-${sent.length}`;
  };
  Input.setupEventListeners();
  const video = context.document.getElementById('remoteVideo');
  const pointer = {
    pointerId: 11,
    button: 0,
    detail: 1,
    clientX: 50,
    clientY: 50,
    currentTarget: video,
    preventDefault() {},
  };

  video.listeners.get('pointerdown')(pointer);
  windowListeners.get('blur')();

  assert.equal(sent.filter(({ type, action }) => type === 'mouse' && action === 'reset').length, 1);
  assert.equal(Input.getDiagnosticState().pressedMouseButtonCount, 0);
});

test('sendInput returns null and skips latency tracking when no transport accepts input', () => {
  const Input = loadInput();
  const latencyIds = [];
  Input.socket = { connected: false };
  Input.__testContext.WebRTC.sendInput = () => false;
  Input.__testContext.WebRTC.inputChannel = null;
  Input.__testContext.LatencyMonitor.recordInputSend = (inputId) => latencyIds.push(inputId);

  const result = Input.sendInput('mouse', 'down', { relX: 0.5, relY: 0.5 });

  assert.equal(result, null);
  assert.deepEqual(latencyIds, []);
  assert.equal(Input.getDiagnosticState().recentInputEvents.at(-1).type, 'input-not-sent');
});

test('sendInput logs transport metadata without raw keyboard payload values', () => {
  const Input = loadInput();
  const logCalls = [];
  Input.__testContext.console = {
    log: (...args) => logCalls.push(args),
    warn() {},
  };

  Input.sendInput('keyboard', 'keydown', {
    key: 'private-value',
    code: 'PrivateCode',
    text: 'private-value',
  });

  Input.__testContext.WebRTC.sendInput = () => false;
  Input.socket = { connected: true, emit() {} };
  Input.sendInput('keyboard', 'keyup', {
    key: 'private-value',
    code: 'PrivateCode',
    text: 'private-value',
  });

  const serializedLogs = JSON.stringify(logCalls);
  assert.equal(logCalls.length, 2);
  assert.match(serializedLogs, /keyboard/);
  assert.match(serializedLogs, /dc/);
  assert.match(serializedLogs, /socket/);
  assert.doesNotMatch(serializedLogs, /private-value|PrivateCode/);
});

test('keyboard event and watchdog logs never include key or code values', () => {
  const { Input, documentListeners, context } = loadInputWithListeners();
  const logCalls = [];
  context.console = {
    log: (...args) => logCalls.push(args),
    warn: (...args) => logCalls.push(args),
  };
  Input.videoElement = context.document.getElementById('remoteVideo');
  Input.socket = { connected: true };
  Input.setupEventListeners();

  const event = makeKeyboardEvent({ key: 'private-value', code: 'PrivateCode' });
  documentListeners.get('keydown')(event);

  Input.isActive = true;
  documentListeners.get('keydown')(event);
  documentListeners.get('keyup')(event);

  const serializedLogs = JSON.stringify(logCalls);
  assert.match(serializedLogs, /KEYBOARD/);
  assert.doesNotMatch(serializedLogs, /private-value|PrivateCode/);
  assert.doesNotMatch(Input.scheduleKeyWatchdog.toString(), /stuckKeys\.map/);
});
