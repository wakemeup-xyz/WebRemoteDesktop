const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function makeElement() {
  return {
    textContent: '',
    style: {},
    focus() {},
    addEventListener() {},
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
  };
  context.globalThis = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, 'input.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__Input = Input;`, context);
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
  };
  context.globalThis = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, 'input.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__Input = Input;`, context);
  return { Input: context.__Input, documentListeners, windowListeners, elements };
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
