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
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
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


test('sendLogs includes keyboard mode, input state, and channel timeline', () => {
  const elements = new Map();
  const ids = [
    'diagBtn', 'diagModal', 'closeDiagBtn', 'sendDiagBtn', 'clearDiagBtn',
    'diagLogArea', 'keyboardDebugArea', 'remoteVideo', 'relayImage', 'keyInputDisplay', 'keyboardModeBtn'
  ];
  ids.forEach((id) => elements.set(id, makeElement(id)));

  const emitted = [];
  const context = {
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => fn(),
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { platform: 'Win32', userAgent: 'node-test' },
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
      socket: { connected: true, emit(event, payload) { emitted.push({ event, payload }); } },
      sendInput: () => true,
    },
    alert() {},
    setInterval() {},
  };
  context.globalThis = context;
  vm.createContext(context);

  const Input = loadScript('input.js', context, 'Input');
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');

  Input.keyboardMode = 'windows';
  Input._keyboardDebugEntries = ['kbd-1'];
  Input.releaseAllKeys('window-blur', true);
  Diagnostic.logs = [
    '[10:00:00] [LOG] [INPUT-DC] DataChannel open',
    '[10:00:01] [WRN] [INPUT-DC] DataChannel error: {"isTrusted":true}',
    '[10:00:02] [LOG] [INPUT-DC] DataChannel closed, sctp=connected pc=connected ice=completed'
  ];

  Diagnostic.sendLogs();

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'diagnostic');
  assert.equal(emitted[0].payload.keyboardMode, 'windows');
  assert.equal(Array.isArray(emitted[0].payload.keyboardDebug), true);
  assert.equal(emitted[0].payload.keyboardDebug.length, 0);
  assert.equal(emitted[0].payload.inputState.pendingKeys, 0);
  assert.equal(emitted[0].payload.inputState.lastReleaseAllReason, 'window-blur');
  assert.equal(emitted[0].payload.inputChannelTimeline.length, 3);
  assert.equal(emitted[0].payload.inputChannelTimeline[0].kind, 'open');
  assert.equal(emitted[0].payload.inputChannelTimeline[1].kind, 'error');
  assert.equal(emitted[0].payload.inputChannelTimeline[2].kind, 'close');
});
