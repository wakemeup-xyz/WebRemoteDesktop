const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function makeElement(id) {
  return {
    id,
    value: '',
    textContent: '',
    scrollTop: 0,
    scrollHeight: 100,
    style: {},
    classList: {
      add() {},
      remove() {},
    },
    focus() {},
    setAttribute() {},
    addEventListener(type, handler) {
      this[`on${type}`] = handler;
    },
  };
}

function loadScript(filename, context, exportName) {
  const source = fs.readFileSync(path.join(__dirname, filename), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__exported = ${exportName};`, context);
  return context.__exported;
}

test('diagnostic button opens modal and fills keyboard debug output', () => {
  const elements = new Map();
  const ids = [
    'diagBtn',
    'diagModal',
    'closeDiagBtn',
    'sendDiagBtn',
    'clearDiagBtn',
    'diagLogArea',
    'keyboardDebugArea',
    'remoteVideo',
    'relayImage',
    'keyInputDisplay',
    'keyboardModeBtn',
  ];
  ids.forEach((id) => elements.set(id, makeElement(id)));

  const context = {
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => fn(),
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { platform: 'MacIntel', userAgent: 'node-test' },
    window: {
      addEventListener() {},
      screen: { width: 1440, height: 900 },
      location: { origin: 'http://localhost:8080' },
    },
    document: {
      hidden: false,
      addEventListener(type, handler) {
        if (type === 'DOMContentLoaded') {
          handler();
        }
      },
      querySelectorAll: () => [],
      getElementById(id) {
        return elements.get(id) || null;
      },
    },
    WebRTC: {
      socket: { connected: true, emit() {} },
      sendInput: () => true,
    },
    alert() {},
    setInterval() {},
  };
  context.globalThis = context;
  vm.createContext(context);

  const Input = loadScript('input.js', context, 'Input');
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');
  Input._keyboardDebugEntries = ['entry-1', 'entry-2'];
  Diagnostic.logs = ['log-1'];

  assert.doesNotThrow(() => {
    elements.get('diagBtn').onclick();
  });
  assert.equal(elements.get('diagLogArea').value, 'log-1');
  assert.equal(elements.get('keyboardDebugArea').value, 'entry-1\nentry-2');
});
