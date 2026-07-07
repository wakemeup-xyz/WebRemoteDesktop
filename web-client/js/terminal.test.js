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
    focusCalls: 0,
    appendChild(child) {
      children.push(child);
      child.parentNode = this;
      child.ownerDocument = this.ownerDocument || child.ownerDocument || null;
      return child;
    },
    remove() {
      this.removed = true;
    },
    focus() {
      this.focusCalls += 1;
      if (this.ownerDocument) {
        this.ownerDocument.activeElement = this;
      }
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
      if (selector === '.xterm-helper-textarea') {
        return children.find((child) => child.className.includes('xterm-helper-textarea')) || null;
      }
      return null;
    },
    contains(target) {
      if (this === target) return true;
      return children.some((child) => {
        if (child === target) return true;
        if (typeof child.contains === 'function') {
          return child.contains(target);
        }
        return false;
      });
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
    'disconnectBtn',
    'remoteVideo',
    'relayImage',
    'scaleBtn',
    'fullscreenBtn',
    'toggleControlsBtn',
  ];
  ids.forEach((id) => elements.set(id, makeElement(id)));

  const sessionStorageMap = new Map();
  const localStorageMap = new Map();
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

  const createdTerms = [];
  function FakeTerminal() {
    const term = {
      focusCalls: 0,
      open(container) {
        this.container = container;
        const textarea = makeElement('textarea');
        textarea.className = 'xterm-helper-textarea';
        container.appendChild(textarea);
      },
      focus() {
        this.focusCalls += 1;
      },
      loadAddon() {},
      onData(handler) {
        this.onDataHandler = handler;
      },
      onResize(handler) {
        this.onResizeHandler = handler;
      },
      write() {},
      dispose() {},
    };
    createdTerms.push(term);
    return term;
  }

  function FakeFitAddon() {
    this.fit = () => {};
  }

  const context = {
    console,
    setTimeout,
    clearTimeout,
    window: { addEventListener() {} },
    document: {
      activeElement: null,
      body: makeElement('body'),
      addEventListener(type, handler) {
        if (type === 'DOMContentLoaded') {
          handler();
        }
      },
      createElement(tagName) {
        const element = makeElement(tagName);
        element.ownerDocument = this;
        return element;
      },
      querySelector(selector) {
        if (selector === '.viewer-container') {
          const element = makeElement('viewer-container');
          element.ownerDocument = this;
          return element;
        }
        return null;
      },
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
    localStorage: {
      getItem(key) {
        return localStorageMap.has(key) ? localStorageMap.get(key) : null;
      },
      setItem(key, value) {
        localStorageMap.set(key, String(value));
      },
      removeItem(key) {
        localStorageMap.delete(key);
      },
    },
    RuntimeConfig: {
      getSocketBase: () => 'http://127.0.0.1:8080',
      url: (pathname) => `http://127.0.0.1:8080${pathname}`,
    },
    Terminal: overrides.Terminal || FakeTerminal,
    FitAddon: overrides.FitAddon || { FitAddon: FakeFitAddon },
    io: overrides.io || (() => fakeSocket),
    fetch: overrides.fetch,
    confirm: overrides.confirm || (() => true),
  };
  context.document.body.ownerDocument = context.document;
  elements.forEach((element) => {
    element.ownerDocument = context.document;
  });
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
    localStorageMap,
    createdTerms,
    createTerminalState: context.__createTerminalState,
    TerminalUI: context.__TerminalUI,
    TerminalPanel: context.__TerminalPanel,
    tokenKey: context.__TERMINAL_ADMIN_TOKEN_KEY,
  };
}

function loadUi(context) {
  const source = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');
  vm.runInContext(`${source}
globalThis.__UI = UI;`, context);
  return context.__UI;
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
    emitted.filter((item) => item.event === 'terminal:attach_session').map((item) => item.payload.sessionId),
    ['term_keep']
  );
});

test('TerminalPanel focuses the active terminal after create and attach', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey, elements } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.ensureSession({ sessionId: 'term_keep', title: 'Build shell' });

  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  const session = { sessionId: 'term_keep', title: 'Build shell', status: 'attached' };
  socketHandlers.get('terminal:created')(session);

  const node = elements.get('terminalWorkspace').__children.find((child) => child.dataset.sessionId === 'term_keep');
  const textarea = node.querySelector('.xterm-helper-textarea');
  assert.equal(textarea.focusCalls > 0, true);
});

test('TerminalPanel focuses an existing terminal when the terminal tab is shown', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey, elements } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.ensureSession({ sessionId: 'term_keep', title: 'Build shell' });

  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  TerminalPanel.showTerminal();

  const node = elements.get('terminalWorkspace').__children.find((child) => child.dataset.sessionId === 'term_keep');
  const textarea = node.querySelector('.xterm-helper-textarea');
  assert.equal(textarea.focusCalls > 0, true);
});

test('TerminalPanel retries focus when xterm helper is attached after a delay', async () => {
  function DelayedTerminal() {
    return {
      focusCalls: 0,
      open(container) {
        this.container = container;
        setTimeout(() => {
          const textarea = makeElement('textarea');
          textarea.className = 'xterm-helper-textarea';
          container.appendChild(textarea);
        }, 120);
      },
      focus() {
        this.focusCalls += 1;
      },
      loadAddon() {},
      onData(handler) {
        this.onDataHandler = handler;
      },
      onResize(handler) {
        this.onResizeHandler = handler;
      },
      write() {},
      dispose() {},
    };
  }

  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey, elements } = loadTerminal({
    Terminal: DelayedTerminal,
  });
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.isVisible = true;
  TerminalPanel.ensureSession({ sessionId: 'term_keep', title: 'Build shell' });

  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  const session = { sessionId: 'term_keep', title: 'Build shell', status: 'attached' };
  socketHandlers.get('terminal:created')(session);

  await new Promise((resolve) => setTimeout(resolve, 260));

  const node = elements.get('terminalWorkspace').__children.find((child) => child.dataset.sessionId === 'term_keep');
  const textarea = node.querySelector('.xterm-helper-textarea');
  assert.ok(textarea, 'delayed helper textarea should exist');
  assert.equal(textarea.focusCalls > 0, true);
});

test('TerminalPanel keeps retrying until terminal helper becomes the active element', async () => {
  let helperFocusAttempts = 0;

  function StickyFocusTerminal() {
    return {
      focusCalls: 0,
      open(container) {
        this.container = container;
        const textarea = makeElement('textarea');
        textarea.className = 'xterm-helper-textarea';
        textarea.focus = function focusHelper() {
          this.focusCalls += 1;
          helperFocusAttempts += 1;
          if (helperFocusAttempts >= 2 && this.ownerDocument) {
            this.ownerDocument.activeElement = this;
          }
        };
        container.appendChild(textarea);
      },
      focus() {
        this.focusCalls += 1;
      },
      loadAddon() {},
      onData(handler) {
        this.onDataHandler = handler;
      },
      onResize(handler) {
        this.onResizeHandler = handler;
      },
      write() {},
      dispose() {},
    };
  }

  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey, elements, context } = loadTerminal({
    Terminal: StickyFocusTerminal,
  });
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.isVisible = true;
  TerminalPanel.ensureSession({ sessionId: 'term_keep', title: 'Build shell' });

  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  const session = { sessionId: 'term_keep', title: 'Build shell', status: 'attached' };
  socketHandlers.get('terminal:created')(session);

  await new Promise((resolve) => setTimeout(resolve, 160));

  const node = elements.get('terminalWorkspace').__children.find((child) => child.dataset.sessionId === 'term_keep');
  const textarea = node.querySelector('.xterm-helper-textarea');
  assert.ok(textarea, 'helper textarea should exist');
  assert.equal(helperFocusAttempts >= 2, true);
  assert.equal(context.document.activeElement, textarea);
});

test('TerminalPanel blurs the new-session button so terminal focus can take over', async () => {
  function ButtonBlockedFocusTerminal() {
    return {
      focusCalls: 0,
      open(container) {
        const textarea = makeElement('textarea');
        textarea.className = 'xterm-helper-textarea';
        textarea.focus = function focusHelper() {
          this.focusCalls += 1;
          if (this.ownerDocument?.activeElement?.id !== 'terminalNewBtn') {
            this.ownerDocument.activeElement = this;
          }
        };
        container.appendChild(textarea);
      },
      focus() {
        this.focusCalls += 1;
      },
      loadAddon() {},
      onData(handler) {
        this.onDataHandler = handler;
      },
      onResize(handler) {
        this.onResizeHandler = handler;
      },
      write() {},
      dispose() {},
    };
  }

  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey, elements, context } = loadTerminal({
    Terminal: ButtonBlockedFocusTerminal,
  });
  const newButton = elements.get('terminalNewBtn');
  newButton.blur = function blurNewButton() {
    this.blurCalls = (this.blurCalls || 0) + 1;
    if (this.ownerDocument?.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
  };

  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.isVisible = true;
  TerminalPanel.ensureSession({ sessionId: 'term_keep', title: 'Build shell' });

  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  context.document.activeElement = newButton;
  const session = { sessionId: 'term_keep', title: 'Build shell', status: 'attached' };
  socketHandlers.get('terminal:created')(session);

  await new Promise((resolve) => setTimeout(resolve, 120));

  const node = elements.get('terminalWorkspace').__children.find((child) => child.dataset.sessionId === 'term_keep');
  const textarea = node.querySelector('.xterm-helper-textarea');
  assert.ok(textarea, 'helper textarea should exist');
  assert.equal(newButton.blurCalls > 0, true);
  assert.equal(context.document.activeElement, textarea);
});

test('TerminalPanel retries fit after terminal creation while layout settles', async () => {
  const fitCalls = [];

  function TrackingFitAddon() {
    this.fit = () => {
      fitCalls.push(Date.now());
    };
  }

  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey } = loadTerminal({
    FitAddon: { FitAddon: TrackingFitAddon },
  });
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.isVisible = true;
  TerminalPanel.ensureSession({ sessionId: 'term_keep', title: 'Build shell' });

  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  const session = { sessionId: 'term_keep', title: 'Build shell', status: 'attached' };
  socketHandlers.get('terminal:created')(session);

  await new Promise((resolve) => setTimeout(resolve, 260));

  assert.equal(fitCalls.length >= 2, true);
});

test('TerminalPanel keeps the new-session button disabled until the terminal socket is connected', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey, elements } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();

  TerminalPanel.render();
  assert.equal(elements.get('terminalNewBtn').disabled, true);

  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  assert.equal(elements.get('terminalNewBtn').disabled, false);
});

test('TerminalPanel keeps the terminal socket alive when the user switches back to the desktop tab', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  TerminalPanel.showDesktop();

  assert.equal(TerminalPanel.socket, fakeSocket);
  assert.equal(fakeSocket.connected, true);
});

test('TerminalPanel restores replayed output after reattach using the last active shared session id', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  socketHandlers.get('terminal:session_created')({ sessionId: 'term_keep', title: 'Shared shell', observerCount: 1 });
  socketHandlers.get('terminal:replay')({
    sessionId: 'term_keep',
    replay: [{ seq: 1, data: 'npm test\r\n' }],
  });

  const term = TerminalPanel.terms.get('term_keep');
  assert.ok(term, 'shared terminal instance should exist');
  assert.equal(TerminalPanel.state.getSession('term_keep').status, 'attached');
});

test('desktop disconnect only calls WebRTC.disconnect and never disconnects the terminal socket', () => {
  let disconnectCalls = 0;
  const { context, TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey } = loadTerminal();
  context.WebRTC = { disconnect() { disconnectCalls += 1; } };
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  const UI = loadUi(context);
  UI.setupControlButtons();
  context.document.getElementById('disconnectBtn').onclick?.({ preventDefault() {} });

  assert.equal(disconnectCalls, 1);
  assert.equal(fakeSocket.connected, true);
});

test('TerminalPanel persists the last active shared session id and reattaches on reconnect', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, localStorageMap, tokenKey, emitted } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.ensureSession({ sessionId: 'term_keep', title: 'Shared shell' });
  TerminalPanel.activateSession('term_keep');

  assert.equal(localStorageMap.get('wrd_terminal_last_active_session_id'), 'term_keep');

  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  assert.equal(emitted.some((entry) => entry.event === 'terminal:attach_session' && entry.payload.sessionId === 'term_keep'), true);
});
