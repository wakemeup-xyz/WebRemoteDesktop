const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { TerminalEchoController } = require('./terminal-echo-controller');

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
    setInterval,
    clearInterval,
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
    Date: overrides.Date || Date,
    TerminalEchoController,
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

function createSocketDouble() {
  const handlers = new Map();
  return {
    connected: false,
    handlers,
    emitted: [],
    on(event, handler) {
      handlers.set(event, handler);
    },
    emit(event, payload) {
      this.emitted.push({ event, payload });
    },
    disconnectCalls: 0,
    disconnect() {
      this.disconnectCalls += 1;
      this.connected = false;
    },
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
  assert.equal(ui.getSession('term_1').processStatus, 'running');
});

test('TerminalUI normalizes explicit PTY process state without changing observer presence', () => {
  const { TerminalUI } = loadTerminal();
  const ui = TerminalUI.create();

  ui.openTab({ sessionId: 'term-exit', status: 'detached', processStatus: 'exited' });

  assert.equal(ui.getSession('term-exit').status, 'detached');
  assert.equal(ui.getSession('term-exit').processStatus, 'exited');
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

test('TerminalPanel reconnect waits for a fresh pool snapshot before attaching a live preferred session', () => {
  const {
    TerminalPanel,
    fakeSocket,
    socketHandlers,
    emitted,
    sessionStorageMap,
    localStorageMap,
    tokenKey,
  } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.ensureSession({ sessionId: 'term_stale', title: 'Stale shell' });
  localStorageMap.set('wrd_terminal_last_active_session_id', 'term_stale');

  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  assert.equal(emitted.filter((item) => item.event === 'terminal:list').length, 1);
  assert.equal(emitted.filter((item) => item.event === 'terminal:attach_session').length, 0);

  socketHandlers.get('terminal:pool_snapshot')({ sessions: [], defaultSessionId: null });
  assert.equal(TerminalPanel.state.getSession('term_stale'), null);
  assert.equal(emitted.filter((item) => item.event === 'terminal:attach_session').length, 0);

  localStorageMap.set('wrd_terminal_last_active_session_id', 'term_live');
  const liveSnapshot = {
    sessions: [{ sessionId: 'term_live', title: 'Live shell' }],
    defaultSessionId: 'term_live',
  };
  socketHandlers.get('terminal:pool_snapshot')(liveSnapshot);
  socketHandlers.get('terminal:snapshot')(liveSnapshot);

  assert.deepEqual(
    emitted.filter((item) => item.event === 'terminal:attach_session').map((item) => item.payload.sessionId),
    ['term_live'],
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
  socketHandlers.get('terminal:attached')(session);

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
  socketHandlers.get('terminal:attached')(session);

  const deadline = Date.now() + 1000;
  let textarea = null;
  while (Date.now() < deadline) {
    const node = elements.get('terminalWorkspace').__children.find((child) => child.dataset.sessionId === 'term_keep');
    textarea = node?.querySelector('.xterm-helper-textarea') || null;
    if (textarea?.focusCalls > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

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
  socketHandlers.get('terminal:attached')(session);

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
  socketHandlers.get('terminal:attached')(session);

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
  socketHandlers.get('terminal:attached')(session);

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

test('TerminalPanel disables new session creation when pool capacity is exhausted', () => {
  const { TerminalPanel, elements } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.socketState = 'connected';
  TerminalPanel.socket = { connected: true, emit() {} };
  TerminalPanel.applyPoolSnapshot({
    capacity: { sessionCount: 2, maxSessions: 2, availableSessions: 0 },
    sessions: [
      { sessionId: 'term-1', title: 'one' },
      { sessionId: 'term-2', title: 'two' },
    ],
  });
  TerminalPanel.render();

  assert.equal(elements.get('terminalNewBtn').disabled, true);
  assert.match(elements.get('terminalWarning').textContent, /上限|limit/i);
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
  function BufferingTerminal() {
    return {
      buffer: '',
      open() {},
      focus() {},
      loadAddon() {},
      onData(handler) {
        this.onDataHandler = handler;
      },
      onResize(handler) {
        this.onResizeHandler = handler;
      },
      write(data) {
        this.buffer += String(data);
      },
      reset() {
        this.buffer = '';
      },
      dispose() {},
    };
  }

  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey } = loadTerminal({
    Terminal: BufferingTerminal,
  });
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
  assert.equal(term.buffer, 'npm test\r\n');
  assert.equal(TerminalPanel.state.getSession('term_keep').status, 'attached');
});

test('TerminalPanel keeps exited and failed sessions replayable and closable while disabling xterm input and resize', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey, emitted, elements } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  socketHandlers.get('terminal:session_created')({
    sessionId: 'term_exit',
    title: 'Finished shell',
    status: 'attached',
    processStatus: 'running',
    creatorClientId: TerminalPanel.getBrowserSessionId(),
  });
  socketHandlers.get('terminal:exit')({ sessionId: 'term_exit', exitCode: 0, signal: 0 });
  socketHandlers.get('terminal:replay')({
    sessionId: 'term_exit',
    replay: [{ seq: 1, data: 'finished\r\n' }],
  });

  const term = TerminalPanel.terms.get('term_exit');
  const before = emitted.length;
  term.onDataHandler('x');
  term.onResizeHandler({ cols: 100, rows: 30 });

  assert.equal(TerminalPanel.state.getSession('term_exit').status, 'attached');
  assert.equal(TerminalPanel.state.getSession('term_exit').processStatus, 'exited');
  assert.equal(emitted.slice(before).some((entry) => entry.event === 'terminal:input'), false);
  assert.equal(emitted.slice(before).some((entry) => entry.event === 'terminal:resize'), false);
  const node = elements.get('terminalWorkspace').__children.find((child) => child.dataset.sessionId === 'term_exit');
  assert.equal(node.querySelector('.xterm-helper-textarea').disabled, true);
  const tab = elements.get('terminalSessionTabs').__children.at(-1);
  assert.match(tab.textContent, /已退出/);
  assert.equal(tab.__children.some((child) => child.className === 'terminal-session-close'), true);

  socketHandlers.get('terminal:session_created')({
    sessionId: 'term_failed',
    title: 'Failed shell',
    status: 'attached',
    processStatus: 'failed',
  });
  const failedTerm = TerminalPanel.terms.get('term_failed');
  const failedBefore = emitted.length;
  failedTerm.onDataHandler('x');
  failedTerm.onResizeHandler({ cols: 100, rows: 30 });
  assert.equal(emitted.slice(failedBefore).some((entry) => entry.event === 'terminal:input'), false);
  assert.equal(emitted.slice(failedBefore).some((entry) => entry.event === 'terminal:resize'), false);
  assert.equal(TerminalPanel.state.getSession('term_failed').processStatus, 'failed');
  const failedTabs = elements.get('terminalSessionTabs').__children;
  assert.match(failedTabs.at(-1).textContent, /启动失败/);
  assert.equal(
    failedTabs.at(-1).__children.some((child) => child.className === 'terminal-session-close'),
    true,
  );
});

test('TerminalPanel maps stable PTY errors to concise Chinese status', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey, elements } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  socketHandlers.get('terminal:error')({ code: 'pty_startup_timeout' });
  assert.match(elements.get('terminalStatus').textContent, /启动超时/);
  socketHandlers.get('terminal:error')({ code: 'pty_spawn_failed' });
  assert.match(elements.get('terminalStatus').textContent, /启动失败/);
  socketHandlers.get('terminal:error')({ code: 'pty_starting' });
  assert.match(elements.get('terminalStatus').textContent, /正在启动/);
  socketHandlers.get('terminal:error')({ code: 'pty_exited' });
  assert.match(elements.get('terminalStatus').textContent, /已退出/);
});

test('TerminalPanel auto-attaches the default shared session from a fresh pool snapshot', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey, emitted } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  socketHandlers.get('terminal:pool_snapshot')({
    defaultSessionId: 'term_shared',
    sessions: [{ sessionId: 'term_shared', title: 'Shared shell', observerCount: 0 }],
  });

  assert.equal(
    emitted.some((entry) => entry.event === 'terminal:attach_session' && entry.payload.sessionId === 'term_shared'),
    true,
  );
});

test('TerminalPanel falls back to the live default session when the persisted active session is stale', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, localStorageMap, tokenKey, emitted } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  localStorageMap.set('wrd_terminal_last_active_session_id', 'term_stale');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  assert.equal(
    emitted.some((entry) => entry.event === 'terminal:attach_session' && entry.payload.sessionId === 'term_stale'),
    false,
  );

  socketHandlers.get('terminal:pool_snapshot')({
    defaultSessionId: 'term_live',
    sessions: [{ sessionId: 'term_live', title: 'Shared shell', observerCount: 0 }],
  });

  assert.equal(
    emitted.some((entry) => entry.event === 'terminal:attach_session' && entry.payload.sessionId === 'term_live'),
    true,
  );
  assert.equal(localStorageMap.get('wrd_terminal_last_active_session_id'), 'term_live');
});

test('TerminalPanel falls back to the live default session even when it is not the first snapshot item', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, localStorageMap, tokenKey, emitted } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  localStorageMap.set('wrd_terminal_last_active_session_id', 'term_stale');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  socketHandlers.get('terminal:pool_snapshot')({
    defaultSessionId: 'term_2',
    sessions: [
      { sessionId: 'term_1', title: 'Shared shell 1', observerCount: 0 },
      { sessionId: 'term_2', title: 'Shared shell 2', observerCount: 0 },
    ],
  });

  assert.equal(
    emitted.some((entry) => entry.event === 'terminal:attach_session' && entry.payload.sessionId === 'term_stale'),
    false,
  );
  assert.equal(
    emitted.some((entry) => entry.event === 'terminal:attach_session' && entry.payload.sessionId === 'term_2'),
    true,
  );
  assert.equal(TerminalPanel.state.activeSessionId(), 'term_2');
  assert.equal(localStorageMap.get('wrd_terminal_last_active_session_id'), 'term_2');
});

test('TerminalPanel activating an unattached shared session requests attach', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey, emitted } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  socketHandlers.get('terminal:pool_snapshot')({
    defaultSessionId: 'term_1',
    sessions: [
      { sessionId: 'term_1', title: 'Shared shell 1', observerCount: 0 },
      { sessionId: 'term_2', title: 'Shared shell 2', observerCount: 0 },
    ],
  });

  TerminalPanel.activateSession('term_2');

  assert.equal(
    emitted.some((entry) => entry.event === 'terminal:attach_session' && entry.payload.sessionId === 'term_2'),
    true,
  );
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

  assert.equal(emitted.some((entry) => entry.event === 'terminal:attach_session'), false);
  socketHandlers.get('terminal:pool_snapshot')({
    sessions: [{ sessionId: 'term_keep', title: 'Shared shell' }],
    defaultSessionId: 'term_keep',
  });

  assert.equal(emitted.some((entry) => entry.event === 'terminal:attach_session' && entry.payload.sessionId === 'term_keep'), true);
});

test('TerminalPanel persists the replacement active session when the active shared session is closed', () => {
  const { TerminalPanel, localStorageMap } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.ensureSession({ sessionId: 'term_1', title: 'Shared shell 1' });
  TerminalPanel.ensureSession({ sessionId: 'term_2', title: 'Shared shell 2' });
  TerminalPanel.activateSession('term_2', { announce: false });

  TerminalPanel.handleSessionClosed({ sessionId: 'term_2' });

  assert.equal(TerminalPanel.state.activeSessionId(), 'term_1');
  assert.equal(localStorageMap.get('wrd_terminal_last_active_session_id'), 'term_1');
});

test('TerminalPanel keeps a requested close tab and terminal until server confirmation', () => {
  let disposeCalls = 0;
  function TrackingTerminal() {
    return {
      open() {},
      focus() {},
      loadAddon() {},
      onData(handler) { this.onDataHandler = handler; },
      onResize(handler) { this.onResizeHandler = handler; },
      write() {},
      dispose() { disposeCalls += 1; },
    };
  }
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey, emitted } = loadTerminal({
    Terminal: TrackingTerminal,
  });
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();
  TerminalPanel.ensureSession({ sessionId: 'term_close', processStatus: 'running' });

  TerminalPanel.closeSession('term_close');
  TerminalPanel.closeSession('term_close');

  assert.equal(emitted.filter((entry) => entry.event === 'terminal:close_session').length, 1);
  assert.notEqual(TerminalPanel.state.getSession('term_close'), null);
  assert.equal(TerminalPanel.terms.has('term_close'), true);
  assert.equal(disposeCalls, 0);
  assert.equal(TerminalPanel.pendingCloseSessionIds.has('term_close'), true);

  socketHandlers.get('terminal:session_closed')({ sessionId: 'term_close' });
  socketHandlers.get('terminal:closed')({ sessionId: 'term_close' });

  assert.equal(TerminalPanel.state.getSession('term_close'), null);
  assert.equal(TerminalPanel.terms.has('term_close'), false);
  assert.equal(TerminalPanel.pendingCloseSessionIds.has('term_close'), false);
  assert.equal(disposeCalls, 1);
});

test('TerminalPanel cleanup failure retains closed tab and allows a second close request', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey, emitted, elements } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();
  TerminalPanel.ensureSession({ sessionId: 'term_retry', title: 'Retry shell', processStatus: 'running' });
  TerminalPanel.closeSession('term_retry');

  socketHandlers.get('terminal:error')({
    sessionId: 'term_retry',
    code: 'pty_cleanup_failed',
    message: 'Unable to clean up terminal process',
  });
  socketHandlers.get('terminal:pool_snapshot')({
    defaultSessionId: 'term_retry',
    sessions: [{
      sessionId: 'term_retry',
      title: 'Retry shell',
      status: 'attached',
      processStatus: 'closed',
      observerCount: 1,
    }],
  });

  assert.equal(TerminalPanel.pendingCloseSessionIds.has('term_retry'), false);
  assert.equal(TerminalPanel.state.getSession('term_retry').processStatus, 'closed');
  assert.equal(TerminalPanel.terms.has('term_retry'), true);
  assert.match(elements.get('terminalStatus').textContent, /清理失败.*重试/);
  const retryTab = elements.get('terminalSessionTabs').__children.at(-1);
  assert.equal(retryTab.__children.some((child) => child.className === 'terminal-session-close'), true);

  TerminalPanel.closeSession('term_retry');

  assert.equal(emitted.filter((entry) => entry.event === 'terminal:close_session').length, 2);
});

test('TerminalPanel persists the replacement active session when a pool snapshot removes the active shared session', () => {
  const { TerminalPanel, localStorageMap } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.ensureSession({ sessionId: 'term_1', title: 'Shared shell 1' });
  TerminalPanel.ensureSession({ sessionId: 'term_2', title: 'Shared shell 2' });
  TerminalPanel.activateSession('term_2', { announce: false });

  TerminalPanel.applyPoolSnapshot({
    sessions: [{ sessionId: 'term_1', title: 'Shared shell 1' }],
  });

  assert.equal(TerminalPanel.state.activeSessionId(), 'term_1');
  assert.equal(localStorageMap.get('wrd_terminal_last_active_session_id'), 'term_1');
});

test('TerminalPanel replay restore replaces existing rendered output on same-page reconnect', () => {
  function BufferingTerminal() {
    return {
      buffer: '',
      resetCalls: 0,
      open(container) {
        this.container = container;
      },
      focus() {},
      loadAddon() {},
      onData(handler) {
        this.onDataHandler = handler;
      },
      onResize(handler) {
        this.onResizeHandler = handler;
      },
      write(data) {
        this.buffer += String(data);
      },
      reset() {
        this.resetCalls += 1;
        this.buffer = '';
      },
      dispose() {},
    };
  }

  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey } = loadTerminal({
    Terminal: BufferingTerminal,
  });
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.ensureSession({ sessionId: 'term_keep', title: 'Shared shell' });

  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  socketHandlers.get('terminal:replay')({
    sessionId: 'term_keep',
    replay: [{ seq: 1, data: 'npm test\r\n' }],
  });
  const term = TerminalPanel.terms.get('term_keep');
  assert.equal(term.buffer, 'npm test\r\n');

  fakeSocket.connected = false;
  socketHandlers.get('disconnect')();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();
  socketHandlers.get('terminal:replay')({
    sessionId: 'term_keep',
    replay: [{ seq: 1, data: 'npm test\r\n' }],
  });

  assert.equal(term.buffer, 'npm test\r\n');
});

test('create request correlation activates only the local response and handles aliases idempotently', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, localStorageMap, tokenKey, emitted } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.ensureSession({ sessionId: 'term_existing', title: 'Existing shared shell' });
  TerminalPanel.activateSession('term_existing', { announce: false });

  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  TerminalPanel.createSession();

  const createMessage = emitted.find((entry) => entry.event === 'terminal:create_session');
  assert.equal(typeof createMessage.payload.requestId, 'string');
  assert.equal(createMessage.payload.requestId.length <= 128, true);

  socketHandlers.get('terminal:session_created')({
    sessionId: 'term_foreign',
    title: 'Foreign shared shell',
    requestId: 'another-browser-request',
  });
  assert.equal(TerminalPanel.state.activeSessionId(), 'term_existing');
  assert.equal(localStorageMap.get('wrd_terminal_last_active_session_id'), 'term_existing');

  socketHandlers.get('terminal:created')({
    sessionId: 'term_without_request',
    title: 'Uncorrelated shared shell',
  });
  assert.equal(TerminalPanel.state.activeSessionId(), 'term_existing');

  const localCreated = {
    sessionId: 'term_local',
    title: 'Local shared shell',
    requestId: createMessage.payload.requestId,
  };
  socketHandlers.get('terminal:session_created')(localCreated);
  const sessionCountAfterCanonical = TerminalPanel.state.sessionCount();
  const termCountAfterCanonical = TerminalPanel.terms.size;
  socketHandlers.get('terminal:created')({
    ...localCreated,
    title: 'Duplicate alias must be ignored',
  });

  assert.equal(TerminalPanel.state.activeSessionId(), 'term_local');
  assert.equal(localStorageMap.get('wrd_terminal_last_active_session_id'), 'term_local');
  assert.equal(TerminalPanel.pendingCreateRequestId, null);
  assert.equal(TerminalPanel.state.getSession('term_local').title, 'Local shared shell');
  assert.equal(TerminalPanel.state.sessionCount(), sessionCountAfterCanonical);
  assert.equal(TerminalPanel.terms.size, termCountAfterCanonical);
});

test('stale token connect_error then reauthorize recreates the terminal socket with the new token', async () => {
  const sockets = [];
  const ioCalls = [];
  const fetchCalls = [];
  const { TerminalPanel, sessionStorageMap, tokenKey, elements } = loadTerminal({
    io: (url, options) => {
      ioCalls.push({ url, options });
      const socket = createSocketDouble();
      sockets.push(socket);
      return socket;
    },
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        json: async () => (
          url.endsWith('/api/terminal/bootstrap')
            ? { allowPolling: false }
            : { token: 'fresh-token' }
        ),
      };
    },
  });
  sessionStorageMap.set(tokenKey, 'stale-token');
  TerminalPanel.cacheElements();
  await TerminalPanel.connectSocket();

  assert.equal(ioCalls.length, 1);
  assert.equal(ioCalls[0].options.auth.token, 'stale-token');

  sockets[0].handlers.get('connect_error')({ message: 'Unauthorized' });
  elements.get('terminalAdminPassword').value = 'new-password';

  await TerminalPanel.authorize();

  assert.equal(fetchCalls.filter((entry) => entry.options?.method === 'POST').length, 1);
  assert.equal(fetchCalls.filter((entry) => entry.url.endsWith('/api/terminal/bootstrap')).length, 2);
  assert.equal(sessionStorageMap.get(tokenKey), 'fresh-token');
  assert.equal(ioCalls.length, 2);
  assert.equal(sockets[0].disconnectCalls, 1);
  assert.equal(ioCalls[1].options.auth.token, 'fresh-token');
});

test('expired terminal admin token is cleared on connect_error so the auth form becomes visible again', () => {
  const sockets = [];
  const { TerminalPanel, sessionStorageMap, tokenKey, elements } = loadTerminal({
    io: (_url, _options) => {
      const socket = createSocketDouble();
      sockets.push(socket);
      return socket;
    },
  });

  sessionStorageMap.set(tokenKey, 'expired-admin-token');
  TerminalPanel.init();
  TerminalPanel.showTerminal();

  assert.equal(TerminalPanel.hasAdminToken(), true);
  assert.equal(elements.get('terminalAuthForm').classList.contains('hidden'), true);

  sockets[0].handlers.get('connect_error')({ message: 'jwt expired' });

  assert.equal(TerminalPanel.hasAdminToken(), false);
  assert.equal(sessionStorageMap.has(tokenKey), false);
  assert.equal(elements.get('terminalAuthForm').classList.contains('hidden'), false);
  assert.match(elements.get('terminalStatus').textContent, /重新授权|重新登录|过期/i);
});

test('TerminalPanel records terminal latency state and suppresses duplicated remote echo after optimistic local echo', () => {
  const writes = [];
  let now = 1000;
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  function TrackingTerminal() {
    return {
      open() {},
      focus() {},
      loadAddon() {},
      onData(handler) {
        this.onDataHandler = handler;
      },
      onResize(handler) {
        this.onResizeHandler = handler;
      },
      write(data) {
        writes.push(String(data));
      },
      dispose() {},
    };
  }

  const {
    TerminalPanel,
    fakeSocket,
    socketHandlers,
    sessionStorageMap,
    tokenKey,
    emitted,
  } = loadTerminal({ Terminal: TrackingTerminal, Date: FakeDate });

  sessionStorageMap.set(tokenKey, 'terminal-admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();
  socketHandlers.get('terminal:session_created')({
    sessionId: 'term_echo',
    title: 'Shared shell',
    status: 'attached',
    creatorClientId: TerminalPanel.getBrowserSessionId(),
  });
  socketHandlers.get('terminal:session_attached')({
    sessionId: 'term_echo',
    status: 'attached',
    observerCount: 1,
    activePresenterClientId: TerminalPanel.getBrowserSessionId(),
  });

  const term = TerminalPanel.terms.get('term_echo');
  term.onDataHandler('l');

  const probeEvent = emitted.findLast((entry) => entry.event === 'terminal:input');
  assert.equal(probeEvent.payload.sessionId, 'term_echo');
  assert.equal(probeEvent.payload.data, 'l');
  assert.deepEqual(writes, []);
  socketHandlers.get('terminal:output')({
    sessionId: 'term_echo',
    data: 'l',
  });

  term.onDataHandler('s');
  const inputEvent = emitted.findLast((entry) => entry.event === 'terminal:input');
  assert.equal(inputEvent.payload.sessionId, 'term_echo');
  assert.equal(inputEvent.payload.data, 's');
  assert.equal(typeof inputEvent.payload.inputId, 'string');
  assert.equal(typeof inputEvent.payload.clientSentAt, 'number');
  assert.deepEqual(writes, ['l', 's']);

  now = 1120;
  socketHandlers.get('terminal:input_ack')({
    sessionId: 'term_echo',
    inputId: inputEvent.payload.inputId,
    clientSentAt: inputEvent.payload.clientSentAt,
    serverReceivedAt: 9_000_000,
    serverSentAt: 9_000_001,
    transport: 'websocket',
  });
  socketHandlers.get('terminal:output')({
    sessionId: 'term_echo',
    data: 's',
  });
  socketHandlers.get('terminal:output')({
    sessionId: 'term_echo',
    data: '\r\nprompt$ ',
  });

  assert.deepEqual(writes, ['l', 's', '\r\nprompt$ ']);

  const diagnostic = TerminalPanel.getDiagnosticState();
  assert.equal(diagnostic.transport, 'websocket');
  assert.equal(diagnostic.socketState, 'connected');
  assert.equal(diagnostic.inputAck.last, 120);
  assert.equal(diagnostic.inputAck.p50, 120);
  assert.equal(diagnostic.serverProcess.last, 1);
  assert.equal(diagnostic.echoConfident, true);
  assert.equal(diagnostic.pendingLocalEchoBytes, 0);
});

test('TerminalPanel measures input ack RTT in the browser clock and server processing separately', () => {
  let now = 1120;
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  const { TerminalPanel } = loadTerminal({ Date: FakeDate });
  TerminalPanel.setTransportName('websocket');
  TerminalPanel.pendingInputAcks.set('input-skew', {
    sessionId: 'term-skew',
    clientSentAt: 1000,
  });

  TerminalPanel.handleInputAck({
    inputId: 'input-skew',
    clientSentAt: 8_999_000,
    serverReceivedAt: 9_000_000,
    serverSentAt: 9_000_007,
    transport: 'websocket',
  });

  const diagnostic = TerminalPanel.getDiagnosticState();
  assert.equal(diagnostic.inputAck.last, 120);
  assert.equal(diagnostic.serverProcess.last, 7);
  assert.equal(TerminalPanel.pendingInputAcks.has('input-skew'), false);

  now = 1130;
});

test('TerminalPanel socket RTT trusts the local pending probe instead of echoed client time', () => {
  class FakeDate extends Date {
    static now() {
      return 1120;
    }
  }
  const { TerminalPanel } = loadTerminal({ Date: FakeDate });
  TerminalPanel.setTransportName('websocket');
  TerminalPanel.pendingLatencyProbes.set('ping-skew', 1000);

  TerminalPanel.handleLatencyPong({
    nonce: 'ping-skew',
    clientSentAt: 9_000_000,
    serverReceivedAt: 9_000_010,
    serverSentAt: 9_000_011,
    transport: 'websocket',
  });

  assert.equal(TerminalPanel.getDiagnosticState().socketRtt.last, 120);
});

test('TerminalPanel suppresses echoed input even when remote output starts with a control sequence', () => {
  const writes = [];
  function TrackingTerminal() {
    return {
      open() {},
      focus() {},
      loadAddon() {},
      onData(handler) {
        this.onDataHandler = handler;
      },
      onResize(handler) {
        this.onResizeHandler = handler;
      },
      write(data) {
        writes.push(String(data));
      },
      dispose() {},
    };
  }

  const {
    TerminalPanel,
    fakeSocket,
    socketHandlers,
    sessionStorageMap,
    tokenKey,
  } = loadTerminal({ Terminal: TrackingTerminal });

  sessionStorageMap.set(tokenKey, 'terminal-admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();
  socketHandlers.get('terminal:session_created')({
    sessionId: 'term_control_seq',
    title: 'Shared shell',
    status: 'attached',
    creatorClientId: TerminalPanel.getBrowserSessionId(),
  });
  socketHandlers.get('terminal:session_attached')({
    sessionId: 'term_control_seq',
    status: 'attached',
    observerCount: 1,
    activePresenterClientId: TerminalPanel.getBrowserSessionId(),
  });

  const term = TerminalPanel.terms.get('term_control_seq');
  term.onDataHandler('a');

  socketHandlers.get('terminal:output')({
    sessionId: 'term_control_seq',
    data: '\u001b[?2004ha',
  });
  term.onDataHandler('b');
  socketHandlers.get('terminal:output')({
    sessionId: 'term_control_seq',
    data: '\u001b[32mb',
  });
  socketHandlers.get('terminal:output')({
    sessionId: 'term_control_seq',
    data: '\r\nprompt$ ',
  });

  assert.deepEqual(writes, ['\u001b[?2004ha', 'b', '\u001b[32m', '\r\nprompt$ ']);
  assert.equal(TerminalPanel.getDiagnosticState().pendingLocalEchoBytes, 0);
});

test('TerminalPanel never writes an unconfirmed password probe to xterm', () => {
  const writes = [];
  function TrackingTerminal() {
    return {
      open() {},
      focus() {},
      loadAddon() {},
      onData(handler) { this.onDataHandler = handler; },
      onResize() {},
      write(data) { writes.push(String(data)); },
      dispose() {},
    };
  }
  const {
    TerminalPanel,
    fakeSocket,
    socketHandlers,
    sessionStorageMap,
    tokenKey,
  } = loadTerminal({ Terminal: TrackingTerminal });
  sessionStorageMap.set(tokenKey, 'terminal-admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();
  socketHandlers.get('terminal:session_created')({
    sessionId: 'term_password',
    status: 'attached',
    creatorClientId: TerminalPanel.getBrowserSessionId(),
  });

  TerminalPanel.terms.get('term_password').onDataHandler('Secret123');

  assert.deepEqual(writes, []);
  assert.equal(TerminalPanel.getDiagnosticState().echoConfident, false);
  assert.equal(TerminalPanel.getDiagnosticState().echoAwaitingProbe, true);
  assert.equal(TerminalPanel.getDiagnosticState().pendingLocalEchoBytes, 0);
});

test('TerminalPanel disables optimistic local echo while the terminal is in the alternate screen', () => {
  const writes = [];
  function TrackingTerminal() {
    return {
      open() {},
      focus() {},
      loadAddon() {},
      onData(handler) {
        this.onDataHandler = handler;
      },
      onResize(handler) {
        this.onResizeHandler = handler;
      },
      write(data) {
        writes.push(String(data));
      },
      dispose() {},
    };
  }

  const {
    TerminalPanel,
    fakeSocket,
    socketHandlers,
    sessionStorageMap,
    tokenKey,
  } = loadTerminal({ Terminal: TrackingTerminal });

  sessionStorageMap.set(tokenKey, 'terminal-admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();
  socketHandlers.get('terminal:session_created')({
    sessionId: 'term_alt',
    title: 'Shared shell',
    status: 'attached',
    creatorClientId: TerminalPanel.getBrowserSessionId(),
  });
  socketHandlers.get('terminal:session_attached')({
    sessionId: 'term_alt',
    status: 'attached',
    observerCount: 1,
    activePresenterClientId: TerminalPanel.getBrowserSessionId(),
  });
  socketHandlers.get('terminal:output')({
    sessionId: 'term_alt',
    data: '\u001b[?1049h',
  });

  const term = TerminalPanel.terms.get('term_alt');
  term.onDataHandler('j');

  assert.deepEqual(writes, ['\u001b[?1049h']);
});

test('TerminalPanel acknowledges terminal output once after processing, including failures', () => {
  const {
    TerminalPanel,
    fakeSocket,
    socketHandlers,
    sessionStorageMap,
    tokenKey,
  } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'terminal-admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();
  socketHandlers.get('terminal:session_created')({
    sessionId: 'term_ack',
    title: 'Ack shell',
    status: 'attached',
    processStatus: 'running',
    creatorClientId: TerminalPanel.getBrowserSessionId(),
  });

  let acknowledgements = 0;
  socketHandlers.get('terminal:output')({
    sessionId: 'term_ack',
    data: 'ok',
  }, () => { acknowledgements += 1; });
  assert.equal(acknowledgements, 1);

  TerminalPanel.writeOutput = () => { throw new Error('render failed'); };
  assert.throws(
    () => socketHandlers.get('terminal:output')({
      sessionId: 'term_ack',
      data: 'still-ack',
    }, () => { acknowledgements += 1; }),
    /render failed/,
  );
  assert.equal(acknowledgements, 2);
});

test('TerminalPanel requests websocket only by default and polling only after bootstrap opt-in', () => {
  const ioCalls = [];
  const { TerminalPanel, sessionStorageMap, tokenKey } = loadTerminal({
    io: (url, options) => {
      ioCalls.push({ url, options });
      return createSocketDouble();
    },
  });
  sessionStorageMap.set(tokenKey, 'admin-token');

  TerminalPanel.connectSocket();
  assert.deepEqual(Array.from(ioCalls[0].options.transports), ['websocket']);
  assert.equal(ioCalls[0].options.rememberUpgrade, true);
  assert.equal(typeof ioCalls[0].options.auth.clientId, 'string');

  TerminalPanel.destroySocket();
  TerminalPanel.applyBootstrap({ allowPolling: true });
  TerminalPanel.connectSocket();
  assert.deepEqual(Array.from(ioCalls[1].options.transports), ['websocket', 'polling']);
});

test('TerminalPanel loads canonical polling policy from terminal bootstrap before connecting', async () => {
  const ioCalls = [];
  const fetchCalls = [];
  const { TerminalPanel, sessionStorageMap, tokenKey } = loadTerminal({
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ allowPolling: true }),
      };
    },
    io: (url, options) => {
      ioCalls.push({ url, options });
      return createSocketDouble();
    },
  });
  sessionStorageMap.set(tokenKey, 'admin-token');

  await TerminalPanel.connectSocket();

  assert.equal(fetchCalls[0].url.endsWith('/api/terminal/bootstrap'), true);
  assert.equal(fetchCalls[0].options.headers.Authorization, 'Bearer admin-token');
  assert.deepEqual(Array.from(ioCalls[0].options.transports), ['websocket', 'polling']);
});

test('TerminalPanel keeps websocket and polling latency samples separate', () => {
  let now = 1120;
  class FakeDate extends Date {
    static now() { return now; }
  }
  const { TerminalPanel } = loadTerminal({ Date: FakeDate });

  TerminalPanel.setTransportName('websocket');
  TerminalPanel.pendingInputAcks.set('ws-input', { clientSentAt: 1000 });
  TerminalPanel.handleInputAck({
    inputId: 'ws-input',
    serverReceivedAt: 2000,
    serverSentAt: 2007,
    transport: 'websocket',
  });
  now = 2020;
  TerminalPanel.setTransportName('polling');
  TerminalPanel.pendingInputAcks.set('poll-input', { clientSentAt: 2000 });
  TerminalPanel.handleInputAck({
    inputId: 'poll-input',
    serverReceivedAt: 3000,
    serverSentAt: 3003,
    transport: 'polling',
  });

  let diagnostic = TerminalPanel.getDiagnosticState();
  assert.equal(diagnostic.transport, 'polling');
  assert.equal(diagnostic.inputAck.last, 20);
  assert.equal(diagnostic.inputAck.sampleCount, 1);
  assert.equal(diagnostic.serverProcess.last, 3);

  TerminalPanel.setTransportName('websocket');
  diagnostic = TerminalPanel.getDiagnosticState();
  assert.equal(diagnostic.inputAck.last, 120);
  assert.equal(diagnostic.inputAck.sampleCount, 1);
  assert.equal(diagnostic.serverProcess.last, 7);
});

test('TerminalPanel keeps tabs for rate and backpressure warnings and marks pty_exited non-writable', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey, emitted, elements } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();
  socketHandlers.get('terminal:session_created')({
    sessionId: 'term_flow',
    title: 'Flow shell',
    processStatus: 'running',
  });
  socketHandlers.get('terminal:session_attached')({
    sessionId: 'term_flow',
    status: 'attached',
    processStatus: 'running',
  });

  socketHandlers.get('terminal:error')({
    sessionId: 'term_flow',
    code: 'pty_exited',
  });
  const before = emitted.length;
  TerminalPanel.terms.get('term_flow').onDataHandler('x');
  assert.equal(TerminalPanel.state.getSession('term_flow').processStatus, 'exited');
  assert.equal(emitted.slice(before).some((entry) => entry.event === 'terminal:input'), false);

  socketHandlers.get('terminal:error')({
    sessionId: 'term_flow',
    code: 'terminal_input_rate_limited',
  });
  assert.notEqual(TerminalPanel.state.getSession('term_flow'), null);
  assert.match(elements.get('terminalStatus').textContent, /输入过快/);
  socketHandlers.get('terminal:warning')({
    sessionId: 'term_flow',
    code: 'terminal_output_backpressure',
  });
  assert.notEqual(TerminalPanel.state.getSession('term_flow'), null);
  assert.match(elements.get('terminalWarning').textContent, /输出拥塞/);
  assert.equal(TerminalPanel.attachedSessionIds.has('term_flow'), false);
  assert.equal(TerminalPanel.pendingAttachSessionIds.has('term_flow'), false);
  assert.equal(TerminalPanel.state.getSession('term_flow').status, 'detached');

  const attachCountBefore = emitted.filter((entry) => entry.event === 'terminal:attach_session').length;
  const liveSnapshot = {
    defaultSessionId: 'term_flow',
    sessions: [{
      sessionId: 'term_flow',
      status: 'attached',
      processStatus: 'exited',
    }],
  };
  socketHandlers.get('terminal:pool_snapshot')(liveSnapshot);
  socketHandlers.get('terminal:snapshot')(liveSnapshot);
  assert.equal(
    emitted.filter((entry) => entry.event === 'terminal:attach_session').length,
    attachCountBefore + 1,
  );
  assert.notEqual(TerminalPanel.state.getSession('term_flow'), null);
});

test('late polling latency responses do not replace the current websocket transport', () => {
  let now = 1120;
  class FakeDate extends Date {
    static now() { return now; }
  }
  const { TerminalPanel, elements } = loadTerminal({ Date: FakeDate });
  TerminalPanel.cacheElements();
  TerminalPanel.socketState = 'connected';
  TerminalPanel.setTransportName('websocket');
  TerminalPanel.setStatus('共享控制台已连接', 'connected');

  TerminalPanel.pendingLatencyProbes.set('poll-ping', 1000);
  TerminalPanel.handleLatencyPong({
    nonce: 'poll-ping',
    transport: 'polling',
  });
  now = 1140;
  TerminalPanel.pendingInputAcks.set('poll-input-late', { clientSentAt: 1120 });
  TerminalPanel.handleInputAck({
    inputId: 'poll-input-late',
    transport: 'polling',
    serverReceivedAt: 2000,
    serverSentAt: 2004,
  });

  assert.equal(TerminalPanel.getDiagnosticState().transport, 'websocket');
  assert.match(elements.get('terminalStatus').textContent, /websocket/);
  assert.equal(TerminalPanel.getTransportLatency('polling').socket.snapshot().last, 120);
  assert.equal(TerminalPanel.getTransportLatency('polling').input.snapshot().last, 20);
  assert.equal(TerminalPanel.getTransportLatency('polling').server.snapshot().last, 4);
  assert.equal(TerminalPanel.getTransportLatency('websocket').socket.snapshot().sampleCount, 0);
});

test('TerminalPanel applies canonical and legacy session aliases once', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  const calls = { snapshot: 0, attach: 0, close: 0 };
  const applySnapshot = TerminalPanel.applyPoolSnapshot.bind(TerminalPanel);
  const attach = TerminalPanel.attachSessionState.bind(TerminalPanel);
  const close = TerminalPanel.handleSessionClosed.bind(TerminalPanel);
  TerminalPanel.applyPoolSnapshot = (payload) => { calls.snapshot += 1; applySnapshot(payload); };
  TerminalPanel.attachSessionState = (payload) => { calls.attach += 1; attach(payload); };
  TerminalPanel.handleSessionClosed = (payload) => { calls.close += 1; close(payload); };
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;

  const snapshot = { sessions: [], defaultSessionId: null };
  socketHandlers.get('terminal:pool_snapshot')(snapshot);
  socketHandlers.get('terminal:snapshot')(snapshot);
  const session = { sessionId: 'term_alias', title: 'Alias shell', processStatus: 'running' };
  TerminalPanel.ensureSession(session);
  socketHandlers.get('terminal:session_attached')(session);
  socketHandlers.get('terminal:attached')(session);
  socketHandlers.get('terminal:session_closed')(session);
  socketHandlers.get('terminal:closed')(session);

  assert.deepEqual(calls, { snapshot: 1, attach: 1, close: 1 });
});
