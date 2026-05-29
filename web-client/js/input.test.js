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
