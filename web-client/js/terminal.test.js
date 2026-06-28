const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function makeClassList() {
  const classes = new Set();
  return {
    add(...tokens) { tokens.forEach((token) => classes.add(token)); },
    remove(...tokens) { tokens.forEach((token) => classes.delete(token)); },
    contains(token) { return classes.has(token); },
    toggle(token, force) {
      if (force === true) {
        classes.add(token);
        return true;
      }
      if (force === false) {
        classes.delete(token);
        return false;
      }
      if (classes.has(token)) {
        classes.delete(token);
        return false;
      }
      classes.add(token);
      return true;
    },
  };
}

function makeElement(id) {
  const children = [];
  const element = {
    id,
    value: '',
    textContent: '',
    dataset: {},
    className: '',
    classList: makeClassList(),
    appendChild(child) {
      children.push(child);
      child.parentNode = this;
      return child;
    },
    remove() {
      this.removed = true;
    },
    addEventListener(type, handler) {
      this[`on${type}`] = handler;
    },
    querySelectorAll(selector) {
      if (selector === '.terminal-instance') {
        return children.filter((child) => child.className.includes('terminal-instance'));
      }
      return [];
    },
    querySelector(selector) {
      const match = selector.match(/\[data-session-id="([^"]+)"\]/);
      if (match) {
        return children.find((child) => child.dataset.sessionId === match[1]) || null;
      }
      return null;
    },
    get __children() {
      return children;
    },
  };
  return element;
}

function loadTerminal(overrides = {}) {
  const elements = new Map();
  const ids = [
    'terminalPanel',
    'desktopPanel',
    'desktopTabBtn',
    'terminalTabBtn',
    'terminalAuthForm',
    'terminalAdminPassword',
    'terminalAuthBtn',
    'terminalNewBtn',
    'terminalSessionTabs',
    'terminalStatus',
    'terminalWarning',
    'terminalWorkspace',
  ];
  ids.forEach((id) => elements.set(id, makeElement(id)));

  const sessionStorageMap = new Map();
  const socketHandlers = new Map();
  const emitted = [];
  const fakeSocket = {
    connected: false,
    on(event, handler) {
      socketHandlers.set(event, handler);
    },
    emit(event, payload) {
      emitted.push({ event, payload });
    },
    disconnect() {
      this.connected = false;
    },
  };

  const context = {
    console,
    setTimeout,
    clearTimeout,
    window: { addEventListener() {} },
    document: {
      body: makeElement('body'),
      addEventListener(type, handler) {
        if (type === 'DOMContentLoaded') {
          handler();
        }
      },
      createElement: (tagName) => makeElement(tagName),
      getElementById: (id) => elements.get(id) || null,
    },
    sessionStorage: {
      getItem(key) {
        return sessionStorageMap.has(key) ? sessionStorageMap.get(key) : null;
      },
      setItem(key, value) {
        sessionStorageMap.set(key, String(value));
      },
      removeItem(key) {
        sessionStorageMap.delete(key);
      },
    },
    RuntimeConfig: {
      getSocketBase: () => 'http://127.0.0.1:8080',
      url: (pathname) => `http://127.0.0.1:8080${pathname}`,
    },
    io: overrides.io || (() => fakeSocket),
    fetch: overrides.fetch,
  };
  context.globalThis = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, 'terminal.js'), 'utf8');
  vm.runInContext(`${source}
globalThis.__createTerminalState = createTerminalState;
globalThis.__TerminalUI = TerminalUI;
globalThis.__TerminalPanel = TerminalPanel;
globalThis.__TERMINAL_ADMIN_TOKEN_KEY = TERMINAL_ADMIN_TOKEN_KEY;`, context);
  return {
    context,
    elements,
    emitted,
    fakeSocket,
    socketHandlers,
    sessionStorageMap,
    createTerminalState: context.__createTerminalState,
    TerminalUI: context.__TerminalUI,
    TerminalPanel: context.__TerminalPanel,
    tokenKey: context.__TERMINAL_ADMIN_TOKEN_KEY,
  };
}

test('TerminalUI tracks multiple tabs and active attachment', () => {
  const { TerminalUI } = loadTerminal();
  const ui = TerminalUI.create({ softWarnCount: 8 });

  ui.openTab('term_1');
  ui.openTab('term_2');
  ui.attachSession('term_1');

  assert.equal(ui.activeSessionId(), 'term_1');
  assert.equal(ui.sessionCount(), 2);
  assert.equal(ui.getSession('term_1').status, 'attached');
});

test('TerminalUI exposes a soft warning without blocking extra tabs', () => {
  const { TerminalUI } = loadTerminal();
  const ui = TerminalUI.create({ softWarnCount: 1 });

  ui.openTab('term_1');
  ui.openTab('term_2');

  assert.equal(ui.sessionCount(), 2);
  assert.match(ui.getWarning(), /终端会话较多/);
});

test('TerminalPanel requires admin authorization before opening a socket', () => {
  let socketCreated = false;
  const { TerminalPanel, elements } = loadTerminal({
    io: () => {
      socketCreated = true;
      throw new Error('socket should not be created');
    },
  });
  TerminalPanel.cacheElements();

  TerminalPanel.createSession();

  assert.equal(socketCreated, false);
  assert.equal(elements.get('terminalStatus').textContent, '需要 admin 授权');
});

test('TerminalPanel reconnect reattaches existing sessions by original session id', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, emitted, sessionStorageMap, tokenKey } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.ensureSession({ sessionId: 'term_keep', title: 'Build shell' });

  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  assert.deepEqual(
    emitted.filter((item) => item.event === 'terminal:attach').map((item) => item.payload.sessionId),
    ['term_keep']
  );
});
