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
  const attrs = {};
  let internalValue = '';
  const element = {
    id,
    textContent: '',
    dataset: {},
    className: '',
    classList: makeClassList(),
    setAttribute(name, value) { attrs[name] = String(value); this[name] = String(value); },
    getAttribute(name) { return attrs[name] ?? null; },
    focusCalls: 0,
    selectionStart: 0,
    selectionEnd: 0,
    selectionDirection: 'none',
    get value() {
      return internalValue;
    },
    set value(nextValue) {
      internalValue = String(nextValue ?? '');
      this.selectionStart = internalValue.length;
      this.selectionEnd = internalValue.length;
      this.selectionDirection = 'none';
    },
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
    setSelectionRange(start, end, direction = 'none') {
      this.selectionStart = Number(start);
      this.selectionEnd = Number(end);
      this.selectionDirection = direction;
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
      if (selector.startsWith('.')) {
        const cls = selector.slice(1);
        return children.find((child) => String(child.className).split(/\s+/).includes(cls)) || null;
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
    'terminalDetachBtn',
    'terminalCloseBtn',
    'terminalSessionTabs',
    'terminalStatus',
    'terminalSessionInfo',
    'terminalWarning',
    'terminalWorkspace',
    'terminalComposer',
    'terminalComposerSubmit',
    'terminalComposerHint',
    'terminalTransportSelect',
    'terminalTransportStatus',
    'terminalTransportTestBtn',
    'disconnectBtn',
    'pauseBtn',
    'remoteVideo',
    'relayImage',
    'scaleBtn',
    'fullscreenBtn',
    'toggleControlsBtn',
  ];
  ids.forEach((id) => elements.set(id, makeElement(id)));

  const terminalPanel = elements.get('terminalPanel');
  const toolbar = makeElement('terminalToolbar');
  toolbar.className = 'terminal-toolbar';
  const transportRow = makeElement('terminalTransportRow');
  transportRow.className = 'terminal-transport-row';
  const composerWrap = makeElement('terminalComposerWrap');
  composerWrap.className = 'terminal-composer';
  terminalPanel.appendChild(toolbar);
  terminalPanel.appendChild(transportRow);
  terminalPanel.appendChild(elements.get('terminalWorkspace'));
  terminalPanel.appendChild(composerWrap);

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
  const gateSource = fs.readFileSync(path.join(__dirname, 'terminal-input-gate.js'), 'utf8');
  vm.runInContext(gateSource, context);
  const turnSource = fs.readFileSync(path.join(__dirname, 'terminal-turn-transport.js'), 'utf8');
  vm.runInContext(turnSource, context);
  const composerSource = fs.readFileSync(path.join(__dirname, 'terminal-composer.js'), 'utf8');
  vm.runInContext(composerSource, context);
  const sessionFsmSource = fs.readFileSync(path.join(__dirname, 'terminal-session-fsm.js'), 'utf8');
  vm.runInContext(sessionFsmSource, context);
  const source = fs.readFileSync(path.join(__dirname, 'terminal.js'), 'utf8');
  vm.runInContext(`${source}
globalThis.__createTerminalState = createTerminalState;
globalThis.__TerminalUI = TerminalUI;
globalThis.__TerminalPanel = TerminalPanel;
globalThis.__TERMINAL_ADMIN_TOKEN_KEY = TERMINAL_ADMIN_TOKEN_KEY;
globalThis.__classifyTerminalNetworkTier = classifyTerminalNetworkTier;
globalThis.__buildTerminalTransportAdvice = buildTerminalTransportAdvice;`, context);
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

test('TerminalPanel keeps Shift+Enter local but submits a real multiline draft once', () => {
  const { TerminalPanel, elements, emitted } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.socketState = 'connected';
  TerminalPanel.socket = {
    connected: true,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
  };
  TerminalPanel.ensureSession({ sessionId: 'term-a', status: 'attached' }, { activate: true });
  TerminalPanel.attachedSessionIds.add('term-a');
  TerminalPanel.bracketedPasteSessionIds.add('term-a');
  elements.get('terminalComposer').value = 'echo one\necho two';

  const shiftEnter = {
    key: 'Enter',
    shiftKey: true,
    isComposing: false,
    preventDefault() {
      throw new Error('must not prevent');
    },
  };
  TerminalPanel.handleComposerKeydown(shiftEnter);
  assert.equal(emitted.length, 0);

  let prevented = false;
  TerminalPanel.handleComposerKeydown({
    key: 'Enter',
    shiftKey: false,
    isComposing: false,
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  const inputEvent = emitted.at(-1);
  assert.equal(inputEvent.event, 'terminal:input');
  assert.equal(inputEvent.payload.sessionId, 'term-a');
  assert.equal(inputEvent.payload.data, '\x1b[200~echo one\necho two\x1b[201~\r');
  assert.equal(typeof inputEvent.payload.inputId, 'string');
  assert.equal(typeof inputEvent.payload.clientSentAt, 'number');
  assert.equal(elements.get('terminalComposer').value, 'echo one\necho two');
});

test('TerminalPanel does not submit composer input on IME Enter', () => {
  const { TerminalPanel, elements, emitted } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.socketState = 'connected';
  TerminalPanel.socket = {
    connected: true,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
  };
  TerminalPanel.ensureSession({ sessionId: 'term-ime', status: 'attached' }, { activate: true });
  TerminalPanel.attachedSessionIds.add('term-ime');
  elements.get('terminalComposer').value = '输入中';

  let prevented = false;
  TerminalPanel.handleComposerKeydown({
    key: 'Enter',
    shiftKey: false,
    isComposing: true,
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, false);
  assert.equal(emitted.length, 0);
  assert.equal(elements.get('terminalComposer').value, '输入中');
});

test('TerminalPanel keeps Ctrl+Enter local and does not submit composer input', () => {
  const { TerminalPanel, elements, emitted } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.socketState = 'connected';
  TerminalPanel.socket = {
    connected: true,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
  };
  TerminalPanel.ensureSession({ sessionId: 'term-ctrl-enter', status: 'attached' }, { activate: true });
  TerminalPanel.attachedSessionIds.add('term-ctrl-enter');
  elements.get('terminalComposer').value = 'echo ctrl';

  let prevented = false;
  TerminalPanel.handleComposerKeydown({
    key: 'Enter',
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, false);
  assert.equal(emitted.length, 0);
  assert.equal(elements.get('terminalComposer').value, 'echo ctrl');
});

test('TerminalPanel keeps Process and keyCode 229 composer Enter variants local', () => {
  const { TerminalPanel, elements, emitted } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.socketState = 'connected';
  TerminalPanel.socket = {
    connected: true,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
  };
  TerminalPanel.ensureSession({ sessionId: 'term-ime-variants', status: 'attached' }, { activate: true });
  TerminalPanel.attachedSessionIds.add('term-ime-variants');
  elements.get('terminalComposer').value = '候选输入';

  [
    { key: 'Process', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false },
    { key: 'Enter', keyCode: 229, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false },
  ].forEach((eventLike) => {
    let prevented = false;
    TerminalPanel.handleComposerKeydown({
      ...eventLike,
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, false);
  });

  assert.equal(emitted.length, 0);
  assert.equal(elements.get('terminalComposer').value, '候选输入');
});

test('TerminalPanel tracks bracketed paste mode across split output chunks', () => {
  const { TerminalPanel } = loadTerminal();

  TerminalPanel.trackTerminalModes('term-a', '\x1b[?20');
  TerminalPanel.trackTerminalModes('term-a', '04h');
  assert.equal(TerminalPanel.bracketedPasteSessionIds.has('term-a'), true);

  TerminalPanel.trackTerminalModes('term-a', '\x1b[?2004');
  TerminalPanel.trackTerminalModes('term-a', 'l');
  assert.equal(TerminalPanel.bracketedPasteSessionIds.has('term-a'), false);
});

test('TerminalPanel tracks bracketed paste mode in grouped DEC private mode lists', () => {
  const { TerminalPanel } = loadTerminal();

  TerminalPanel.trackTerminalModes('term-grouped', '\x1b[?1;2004h');
  assert.equal(TerminalPanel.bracketedPasteSessionIds.has('term-grouped'), true);

  TerminalPanel.trackTerminalModes('term-grouped', '\x1b[?1;2004l');
  assert.equal(TerminalPanel.bracketedPasteSessionIds.has('term-grouped'), false);
});

test('TerminalPanel tracks long split grouped DEC private mode lists before final h and l', () => {
  const { TerminalPanel } = loadTerminal();

  TerminalPanel.trackTerminalModes('term', '\x1b[?2004;1000;1002;1006;1015');
  TerminalPanel.trackTerminalModes('term', 'h');
  assert.equal(TerminalPanel.bracketedPasteSessionIds.has('term'), true);

  TerminalPanel.trackTerminalModes('term', '\x1b[?2004;1000;1002;1006;1015');
  TerminalPanel.trackTerminalModes('term', 'l');
  assert.equal(TerminalPanel.bracketedPasteSessionIds.has('term'), false);
});

test('TerminalPanel refreshes composer hint immediately when active session output toggles bracketed paste mode', () => {
  const { TerminalPanel, elements, socketHandlers, fakeSocket, sessionStorageMap, tokenKey } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  TerminalPanel.ensureSession({ sessionId: 'term-hint', status: 'attached' }, { activate: true });
  TerminalPanel.attachedSessionIds.add('term-hint');
  TerminalPanel.activateSession('term-hint');

  assert.match(elements.get('terminalComposerHint').textContent, /bracketed paste|原始换行/);

  socketHandlers.get('terminal:output')({
    sessionId: 'term-hint',
    data: '\x1b[?2004h',
  });
  assert.match(elements.get('terminalComposerHint').textContent, /Shift\+Enter/);

  socketHandlers.get('terminal:output')({
    sessionId: 'term-hint',
    data: '\x1b[?2004l',
  });
  assert.match(elements.get('terminalComposerHint').textContent, /bracketed paste|原始换行/);
});

test('TerminalPanel keeps a pending composer draft until ack and suppresses duplicate submits', () => {
  const { TerminalPanel, elements, emitted } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.socketState = 'connected';
  TerminalPanel.socket = {
    connected: true,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
  };
  const largeDraft = 'x'.repeat(1024);
  TerminalPanel.ensureSession({ sessionId: 'term-pending', status: 'attached' }, { activate: true });
  TerminalPanel.attachedSessionIds.add('term-pending');
  TerminalPanel.activateSession('term-pending');
  elements.get('terminalComposer').value = largeDraft;
  TerminalPanel.handleComposerInput();

  const submitted = TerminalPanel.submitComposer();
  assert.equal(submitted, true);
  assert.equal(emitted.filter((entry) => entry.event === 'terminal:input').length, 1);
  assert.equal(elements.get('terminalComposer').value, largeDraft);
  assert.equal(TerminalPanel.composerDrafts.get('term-pending'), largeDraft);
  assert.equal(elements.get('terminalComposerSubmit').disabled, true);

  let prevented = false;
  TerminalPanel.handleComposerKeydown({
    key: 'Enter',
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.equal(emitted.filter((entry) => entry.event === 'terminal:input').length, 1);
  assert.equal(elements.get('terminalComposer').value, largeDraft);
});

test('TerminalPanel clears pending composer submissions across socket disconnect and reconnect', () => {
  const { TerminalPanel, elements, emitted, fakeSocket, socketHandlers, sessionStorageMap, tokenKey } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.ensureSession({ sessionId: 'term-retry-after-disconnect', status: 'attached' }, { activate: true });
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();
  TerminalPanel.attachedSessionIds.add('term-retry-after-disconnect');
  TerminalPanel.refreshComposer();

  const draft = 'retry after disconnect';
  elements.get('terminalComposer').value = draft;
  TerminalPanel.handleComposerInput();
  assert.equal(TerminalPanel.submitComposer(), true);
  assert.equal(TerminalPanel.isComposerSubmissionPending(), true);

  fakeSocket.connected = false;
  socketHandlers.get('disconnect')();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();
  TerminalPanel.attachedSessionIds.add('term-retry-after-disconnect');
  TerminalPanel.refreshComposer();

  assert.equal(TerminalPanel.composerDrafts.get('term-retry-after-disconnect'), draft);
  assert.equal(elements.get('terminalComposer').value, draft);
  assert.equal(elements.get('terminalComposerSubmit').disabled, false);
  assert.equal(TerminalPanel.submitComposer(), true);
  assert.equal(emitted.filter((entry) => entry.event === 'terminal:input').length, 2);
});

test('TerminalPanel preflights serialized composer bytes before emitting and recovers after an oversized attempt', () => {
  const { TerminalPanel, elements, emitted } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.socketState = 'connected';
  TerminalPanel.socket = {
    connected: true,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
  };
  TerminalPanel.ensureSession({ sessionId: 'term-byte-limit', status: 'attached' }, { activate: true });
  TerminalPanel.attachedSessionIds.add('term-byte-limit');
  TerminalPanel.refreshComposer();

  const exactLimitDraft = `${'😀'.repeat(16383)}abc`;
  const oversizedDraft = `${exactLimitDraft}d`;
  elements.get('terminalComposer').value = oversizedDraft;
  TerminalPanel.handleComposerInput();

  assert.equal(TerminalPanel.submitComposer(), false);
  assert.equal(emitted.filter((entry) => entry.event === 'terminal:input').length, 0);
  assert.equal(TerminalPanel.pendingInputAcks.size, 0);
  assert.equal(TerminalPanel.pendingComposerInputIdsBySession.has('term-byte-limit'), false);
  assert.equal(elements.get('terminalComposer').value, oversizedDraft);
  assert.equal(TerminalPanel.composerDrafts.get('term-byte-limit'), oversizedDraft);
  assert.equal(elements.get('terminalComposerSubmit').disabled, false);
  assert.equal(elements.get('terminalStatus').dataset.state, 'error');
  assert.match(elements.get('terminalStatus').textContent, /64\s*(?:KiB|KB)/i);

  elements.get('terminalComposer').value = exactLimitDraft;
  TerminalPanel.handleComposerInput();
  assert.equal(TerminalPanel.submitComposer(), true);

  const inputEvent = emitted.findLast((entry) => entry.event === 'terminal:input');
  assert.equal(new TextEncoder().encode(inputEvent.payload.data).byteLength, 64 * 1024);
  TerminalPanel.handleInputAck({ inputId: inputEvent.payload.inputId, transport: 'websocket' });
  assert.equal(elements.get('terminalComposer').value, '');
  assert.equal(TerminalPanel.composerDrafts.get('term-byte-limit'), '');
});

test('TerminalPanel clears its preflight error after a matching successful composer ack', () => {
  const { TerminalPanel, elements, emitted } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.socketState = 'connected';
  TerminalPanel.socket = {
    connected: true,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
  };
  TerminalPanel.ensureSession({ sessionId: 'term-byte-status', status: 'attached' }, { activate: true });
  TerminalPanel.attachedSessionIds.add('term-byte-status');
  TerminalPanel.setStatus('共享控制台已连接', 'connected');
  TerminalPanel.refreshComposer();

  const exactLimitDraft = `😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀abc`;
  elements.get('terminalComposer').value = `${exactLimitDraft}d`;
  TerminalPanel.handleComposerInput();
  assert.equal(TerminalPanel.submitComposer(), false);
  assert.equal(elements.get('terminalStatus').dataset.state, 'error');
  assert.match(elements.get('terminalStatus').textContent, /64\s*(?:KiB|KB)/i);

  elements.get('terminalComposer').value = exactLimitDraft;
  TerminalPanel.handleComposerInput();
  assert.equal(TerminalPanel.submitComposer(), true);
  const inputEvent = emitted.findLast((entry) => entry.event === 'terminal:input');
  TerminalPanel.handleInputAck({ inputId: inputEvent.payload.inputId, transport: 'websocket' });

  assert.equal(elements.get('terminalStatus').dataset.state, 'connected');
  assert.match(elements.get('terminalStatus').textContent, /共享控制台已连接/);
  assert.doesNotMatch(elements.get('terminalStatus').textContent, /64\s*(?:KiB|KB)/i);
});

test('TerminalPanel clears an unchanged pending composer draft only after matching ack', () => {
  const { TerminalPanel, elements, emitted } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.socketState = 'connected';
  TerminalPanel.socket = {
    connected: true,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
  };
  TerminalPanel.ensureSession({ sessionId: 'term-ack-clear', status: 'attached' }, { activate: true });
  TerminalPanel.attachedSessionIds.add('term-ack-clear');
  TerminalPanel.activateSession('term-ack-clear');
  elements.get('terminalComposer').value = 'echo pending';
  TerminalPanel.handleComposerInput();
  TerminalPanel.submitComposer();
  elements.get('terminalComposer').focus();

  const inputEvent = emitted.at(-1);
  TerminalPanel.handleInputAck({
    inputId: inputEvent.payload.inputId,
    transport: 'websocket',
  });

  assert.equal(elements.get('terminalComposer').value, '');
  assert.equal(TerminalPanel.composerDrafts.get('term-ack-clear'), '');
  assert.equal(elements.get('terminalComposerSubmit').disabled, false);
});

test('TerminalPanel preserves later composer edits when the older submit finally acknowledges', () => {
  const { TerminalPanel, elements, emitted } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.socketState = 'connected';
  TerminalPanel.socket = {
    connected: true,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
  };
  TerminalPanel.ensureSession({ sessionId: 'term-ack-edit', status: 'attached' }, { activate: true });
  TerminalPanel.attachedSessionIds.add('term-ack-edit');
  TerminalPanel.activateSession('term-ack-edit');
  elements.get('terminalComposer').value = 'echo old';
  TerminalPanel.handleComposerInput();
  TerminalPanel.submitComposer();

  elements.get('terminalComposer').value = 'echo new';
  TerminalPanel.handleComposerInput();

  const inputEvent = emitted.at(-1);
  TerminalPanel.handleInputAck({
    inputId: inputEvent.payload.inputId,
    transport: 'websocket',
  });

  assert.equal(elements.get('terminalComposer').value, 'echo new');
  assert.equal(TerminalPanel.composerDrafts.get('term-ack-edit'), 'echo new');
  assert.equal(elements.get('terminalComposerSubmit').disabled, false);
});

test('TerminalPanel unlocks a rejected composer submission only for its matching session and input, then retries with a new input id', () => {
  const { TerminalPanel, elements, emitted } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.socketState = 'connected';
  TerminalPanel.socket = {
    connected: true,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
  };
  TerminalPanel.ensureSession({ sessionId: 'term-retry', status: 'attached' }, { activate: true });
  TerminalPanel.attachedSessionIds.add('term-retry');
  TerminalPanel.activateSession('term-retry');
  elements.get('terminalComposer').value = 'retryable draft';
  TerminalPanel.handleComposerInput();
  assert.equal(TerminalPanel.submitComposer(), true);

  const firstInput = emitted.at(-1).payload;
  TerminalPanel.handleTerminalError({
    sessionId: 'other-session',
    inputId: firstInput.inputId,
    code: 'terminal_session_not_found',
    message: 'Unrelated rejection',
  });
  assert.equal(TerminalPanel.isComposerSubmissionPending('term-retry'), true);
  assert.equal(elements.get('terminalComposerSubmit').disabled, true);
  assert.equal(elements.get('terminalComposer').value, 'retryable draft');

  TerminalPanel.handleTerminalError({
    sessionId: 'term-retry',
    inputId: firstInput.inputId,
    code: 'terminal_session_not_found',
    message: 'Terminal session not found',
  });
  assert.equal(TerminalPanel.isComposerSubmissionPending('term-retry'), false);
  assert.equal(TerminalPanel.pendingInputAcks.has(firstInput.inputId), false);
  assert.equal(elements.get('terminalComposerSubmit').disabled, false);
  assert.equal(elements.get('terminalComposer').value, 'retryable draft');

  assert.equal(TerminalPanel.submitComposer(), true);
  const retryInput = emitted.at(-1).payload;
  assert.notEqual(retryInput.inputId, firstInput.inputId);
  assert.equal(retryInput.data, firstInput.data);
  assert.equal(emitted.filter((entry) => entry.event === 'terminal:input').length, 2);
});

test('TerminalPanel unlocks only the matching TURN-rejected composer submission and preserves its draft for retry', () => {
  const sentFrames = [];
  const { TerminalPanel, elements } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.socketState = 'connected';
  TerminalPanel.socket = { connected: true, emit() {} };
  TerminalPanel.preferredTransport = 'webrtc-turn';
  TerminalPanel.webrtcReady = true;
  TerminalPanel.webrtcDc = {
    readyState: 'open',
    send(frame) { sentFrames.push(JSON.parse(frame)); },
  };
  TerminalPanel.ensureSession({ sessionId: 'term-turn-retry', status: 'attached' }, { activate: true });
  TerminalPanel.attachedSessionIds.add('term-turn-retry');
  TerminalPanel.activateSession('term-turn-retry');
  elements.get('terminalComposer').value = 'retryable TURN draft';
  TerminalPanel.handleComposerInput();
  assert.equal(TerminalPanel.submitComposer(), true);

  const firstInput = sentFrames.at(-1);
  TerminalPanel.pendingInputAcks.set('unrelated-input', {
    sessionId: 'term-unrelated',
    composerSubmission: true,
  });
  TerminalPanel.pendingComposerInputIdsBySession.set('term-unrelated', 'unrelated-input');

  TerminalPanel.handleWebRtcMessage({
    t: 'error',
    sid: 'term-unrelated',
    inputId: firstInput.inputId,
    code: 'terminal_input_rejected',
    message: 'Unrelated rejection',
  });
  assert.equal(TerminalPanel.isComposerSubmissionPending('term-turn-retry'), true);
  assert.equal(TerminalPanel.pendingInputAcks.has(firstInput.inputId), true);
  assert.equal(TerminalPanel.pendingInputAcks.has('unrelated-input'), true);
  assert.equal(elements.get('terminalComposerSubmit').disabled, true);

  TerminalPanel.handleWebRtcMessage({
    t: 'error',
    sid: 'term-turn-retry',
    inputId: firstInput.inputId,
    code: 'terminal_input_rejected',
    message: 'Input rejected',
  });
  assert.equal(TerminalPanel.isComposerSubmissionPending('term-turn-retry'), false);
  assert.equal(TerminalPanel.pendingInputAcks.has(firstInput.inputId), false);
  assert.equal(TerminalPanel.pendingInputAcks.has('unrelated-input'), true);
  assert.equal(TerminalPanel.pendingComposerInputIdsBySession.get('term-unrelated'), 'unrelated-input');
  assert.equal(elements.get('terminalComposerSubmit').disabled, false);
  assert.equal(elements.get('terminalComposer').value, 'retryable TURN draft');

  assert.equal(TerminalPanel.submitComposer(), true);
  const retryInput = sentFrames.at(-1);
  assert.notEqual(retryInput.inputId, firstInput.inputId);
  assert.equal(retryInput.data, firstInput.data);
});

test('TerminalPanel preserves focused composer value and caret during same-session rerenders', () => {
  const { TerminalPanel, elements } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.socketState = 'connected';
  TerminalPanel.socket = { connected: true, emit() {} };
  TerminalPanel.ensureSession({ sessionId: 'term-caret', status: 'attached', observerCount: 1 }, { activate: true });
  TerminalPanel.attachedSessionIds.add('term-caret');
  TerminalPanel.activateSession('term-caret');

  const composer = elements.get('terminalComposer');
  composer.value = 'caret-here';
  TerminalPanel.handleComposerInput();
  composer.focus();
  composer.setSelectionRange(2, 7, 'forward');

  TerminalPanel.render();

  assert.equal(composer.value, 'caret-here');
  assert.equal(composer.selectionStart, 2);
  assert.equal(composer.selectionEnd, 7);
  assert.equal(composer.selectionDirection, 'forward');
});

test('TerminalPanel restores drafts per session and deletes drafts when sessions close', () => {
  const { TerminalPanel, elements } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.ensureSession({ sessionId: 'term-a', status: 'attached' }, { activate: true });
  TerminalPanel.attachedSessionIds.add('term-a');
  TerminalPanel.activateSession('term-a');
  elements.get('terminalComposer').value = 'first line';
  TerminalPanel.handleComposerInput();

  TerminalPanel.ensureSession({ sessionId: 'term-b', status: 'attached' }, { activate: true });
  TerminalPanel.attachedSessionIds.add('term-b');
  TerminalPanel.activateSession('term-b');
  assert.equal(elements.get('terminalComposer').value, '');

  elements.get('terminalComposer').value = 'second line';
  TerminalPanel.handleComposerInput();

  TerminalPanel.activateSession('term-a');
  assert.equal(elements.get('terminalComposer').value, 'first line');
  TerminalPanel.activateSession('term-b');
  assert.equal(elements.get('terminalComposer').value, 'second line');

  TerminalPanel.handleSessionClosed({ sessionId: 'term-a' });
  assert.equal(TerminalPanel.composerDrafts.get('term-a'), '');
});

test('TerminalPanel disables composer when disconnected or active session is unattached', () => {
  const { TerminalPanel, elements } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.render();
  assert.equal(elements.get('terminalComposer').disabled, true);
  assert.equal(elements.get('terminalComposerSubmit').disabled, true);

  TerminalPanel.socketState = 'connected';
  TerminalPanel.socket = { connected: true, emit() {} };
  TerminalPanel.ensureSession({ sessionId: 'term-detached', status: 'running' }, { activate: true });
  TerminalPanel.refreshComposer();
  assert.equal(elements.get('terminalComposer').disabled, true);

  TerminalPanel.attachedSessionIds.add('term-detached');
  TerminalPanel.refreshComposer();
  assert.equal(elements.get('terminalComposer').disabled, false);
  assert.match(elements.get('terminalComposerHint').textContent, /bracketed paste|原始换行/);
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

test('TerminalPanel distinguishes observer role and makes detach non-destructive', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey, emitted, elements } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  TerminalPanel.ensureSession({
    sessionId: 'term-shared',
    title: 'Shared shell',
    status: 'attached',
    presence: 'attached',
    processStatus: 'running',
    observerCount: 2,
    activePresenterClientId: 'other-browser',
    callerIsPresenter: false,
  }, { activate: true });
  TerminalPanel.attachedSessionIds.add('term-shared');
  TerminalPanel.render();

  assert.match(elements.get('terminalSessionInfo').textContent, /观察者/);
  assert.match(elements.get('terminalSessionInfo').textContent, /观察者 2 人/);
  assert.equal(elements.get('terminalCloseBtn').disabled, false);

  assert.equal(TerminalPanel.detachSession('term-shared'), true);
  assert.equal(emitted.at(-1).event, 'terminal:detach_session');
  assert.equal(emitted.at(-1).payload.sessionId, 'term-shared');
  assert.equal(TerminalPanel.attachedSessionIds.has('term-shared'), true);
  socketHandlers.get('terminal:session_detached')({ sessionId: 'term-shared', presence: 'detached' });
  assert.equal(TerminalPanel.attachedSessionIds.has('term-shared'), false);
  assert.equal(TerminalPanel.state.getSession('term-shared').processStatus, 'running');
  assert.equal(TerminalPanel.state.getSession('term-shared').presence, 'detached');
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

test('pause control toggles only the manual media suspension reason from the WebRTC snapshot', () => {
  const { context, elements } = loadTerminal();
  let snapshot = { state: 'active', reasons: [], generation: 0 };
  const changes = [];
  context.WebRTC = {
    getMediaActivitySnapshot() { return snapshot; },
    setMediaActivityReason(reason, enabled) {
      changes.push([reason, enabled]);
    },
  };

  const UI = loadUi(context);
  UI.setupControlButtons();
  const pauseButton = elements.get('pauseBtn');
  pauseButton.onclick();
  snapshot = { state: 'suspended', reasons: ['manual-pause'], generation: 1 };
  pauseButton.onclick();

  assert.deepEqual(changes, [
    ['manual-pause', true],
    ['manual-pause', false],
  ]);
  assert.equal(pauseButton.textContent, '暂停');
});

test('terminal tab sets terminal-active and desktop clears only that reason without closing its socket', () => {
  const { context, TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey } = loadTerminal();
  const changes = [];
  context.WebRTC = {
    setMediaActivityReason(reason, enabled) {
      changes.push([reason, enabled]);
    },
  };
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  TerminalPanel.showTerminal();
  TerminalPanel.showDesktop();

  assert.deepEqual(changes, [
    ['terminal-active', true],
    ['terminal-active', false],
  ]);
  assert.equal(TerminalPanel.socket, fakeSocket);
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

test('TerminalPanel hides transport, workspace, and composer until admin auth', () => {
  const { TerminalPanel, elements, sessionStorageMap, tokenKey } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.render();

  const root = elements.get('terminalPanel');
  const transport = root.querySelector('.terminal-transport-row');
  const composer = root.querySelector('.terminal-composer');
  const workspace = elements.get('terminalWorkspace');

  assert.equal(transport.classList.contains('hidden'), true);
  assert.equal(workspace.classList.contains('hidden'), true);
  assert.equal(composer.classList.contains('hidden'), true);
  assert.equal(elements.get('terminalAuthForm').classList.contains('hidden'), false);
  assert.equal(elements.get('terminalStatus').classList.contains('hidden'), false);

  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.render();

  assert.equal(transport.classList.contains('hidden'), false);
  assert.equal(workspace.classList.contains('hidden'), false);
  assert.equal(composer.classList.contains('hidden'), false);
  assert.equal(elements.get('terminalAuthForm').classList.contains('hidden'), true);
});

test('TerminalPanel renders session tabs with complete tab semantics', () => {
  const { TerminalPanel, elements, sessionStorageMap, tokenKey } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.ensureSession({ sessionId: 'term-aria', title: 'ARIA shell' });
  TerminalPanel.render();
  const tab = elements.get('terminalSessionTabs').__children[0];
  assert.equal(tab.getAttribute('role'), 'tab');
  assert.equal(tab.getAttribute('aria-controls'), 'terminal-session-term-aria');
  assert.equal(tab.getAttribute('aria-selected'), 'true');
  assert.equal(elements.get('terminalWorkspace').__children[0].id, 'terminal-session-term-aria');
  assert.equal(elements.get('terminalWorkspace').__children[0].getAttribute('aria-labelledby'), 'terminal-session-tab-term-aria');
  assert.equal(elements.get('terminalWorkspace').hidden, false);
});

test('TerminalPanel hides workspace and composer with hidden attributes before admin auth', () => {
  const { TerminalPanel, elements } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.render();
  assert.equal(elements.get('terminalWorkspace').hidden, true);
  assert.equal(elements.get('terminalComposer').hidden, true);
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

test('TerminalPanel measures input ack RTT in the browser clock and reports transport metrics separately', () => {
  let now = 1120;
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  const { TerminalPanel, emitted, fakeSocket } = loadTerminal({ Date: FakeDate });
  fakeSocket.connected = true;
  TerminalPanel.socket = fakeSocket;
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
  const inputMetric = emitted.find((entry) => entry.event === 'terminal:client_metrics');
  assert.equal(inputMetric.payload.name, 'input_ack_rtt_ms');
  assert.equal(inputMetric.payload.transport, 'websocket');
  assert.equal(inputMetric.payload.value, 120);

  now = 1130;
});

test('TerminalPanel socket RTT trusts the local pending probe instead of echoed client time', () => {
  class FakeDate extends Date {
    static now() {
      return 1120;
    }
  }
  const { TerminalPanel, emitted, fakeSocket } = loadTerminal({ Date: FakeDate });
  fakeSocket.connected = true;
  TerminalPanel.socket = fakeSocket;
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
  const socketMetric = emitted.find((entry) => entry.event === 'terminal:client_metrics');
  assert.equal(socketMetric.payload.name, 'socket_rtt_ms');
  assert.equal(socketMetric.payload.transport, 'websocket');
  assert.equal(socketMetric.payload.value, 120);
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
  socketHandlers.get('terminal:session_attached')({
    sessionId: 'term_password',
    status: 'attached',
    processStatus: 'running',
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

test('classifyTerminalNetworkTier matches evaluation plan bands', () => {
  const { context } = loadTerminal();
  const classify = context.__classifyTerminalNetworkTier;
  assert.equal(classify(50), 'A');
  assert.equal(classify(200), 'B');
  assert.equal(classify(300), 'C');
  assert.equal(classify(500), 'D');
  assert.equal(classify(null), null);
});

test('buildTerminalTransportAdvice recommends webrtc-turn only when high RTT and available', () => {
  const { context } = loadTerminal();
  const build = context.__buildTerminalTransportAdvice;
  const high = build({
    socketRttP50: 480,
    preferredTransport: 'socketio',
    webrtcAvailable: true,
    webrtcReady: false,
  });
  assert.equal(high.code, 'recommend_webrtc_turn_high_rtt');
  assert.equal(high.recommendWebRtcTurn, true);
  assert.equal(high.networkTier, 'D');
  assert.match(high.message, /TURN DataChannel/);

  const low = build({
    socketRttP50: 40,
    preferredTransport: 'socketio',
    webrtcAvailable: true,
    webrtcReady: false,
  });
  assert.equal(low.recommendWebRtcTurn, false);
  assert.equal(low.code, 'socketio_ok');

  const noTurn = build({
    socketRttP50: 500,
    preferredTransport: 'socketio',
    webrtcAvailable: false,
    webrtcReady: false,
  });
  assert.equal(noTurn.recommendWebRtcTurn, false);
  assert.equal(noTurn.code, 'high_rtt_webrtc_unavailable');
});

test('TerminalPanel surfaces high-RTT TURN advice without auto-switching transport', () => {
  const { TerminalPanel, elements, context } = loadTerminal();
  // Provide a minimal option node for label updates.
  const select = elements.get('terminalTransportSelect');
  const option = makeElement('webrtc-option');
  option.value = 'webrtc-turn';
  option.textContent = 'TURN DataChannel';
  select.querySelector = (selector) => (
    selector === 'option[value="webrtc-turn"]' ? option : null
  );

  TerminalPanel.cacheElements();
  TerminalPanel.socketState = 'connected';
  TerminalPanel.preferredTransport = 'socketio';
  TerminalPanel.webrtcCapability = { available: true, reason: 'ready' };
  TerminalPanel.setTransportName('websocket');
  TerminalPanel.setStatus('共享控制台已连接', 'connected');
  TerminalPanel.terminalSocketLatency.record(520);
  TerminalPanel.terminalSocketLatency.record(540);
  TerminalPanel.refreshStatus();

  const diagnostic = TerminalPanel.getDiagnosticState();
  assert.equal(diagnostic.networkTier, 'D');
  assert.equal(diagnostic.transportAdvice.code, 'recommend_webrtc_turn_high_rtt');
  assert.equal(diagnostic.preferredTransport, 'socketio');
  assert.match(elements.get('terminalTransportStatus').textContent, /可手动切换 TURN/);
  assert.match(option.textContent, /高 RTT 可尝试/);
  assert.equal(TerminalPanel.preferredTransport, 'socketio');
  assert.equal(context.__classifyTerminalNetworkTier(520), 'D');
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

test('TerminalPanel clears sticky pendingAttach on attach failure so second activate re-emits', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey, emitted } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();
  TerminalPanel.ensureSession({ sessionId: 'term_attach_retry', processStatus: 'running' });

  TerminalPanel.activateSession('term_attach_retry');
  assert.equal(
    emitted.filter((entry) => entry.event === 'terminal:attach_session' && entry.payload.sessionId === 'term_attach_retry').length,
    1,
  );
  assert.equal(TerminalPanel.pendingAttachSessionIds.has('term_attach_retry'), true);

  socketHandlers.get('terminal:error')({
    sessionId: 'term_attach_retry',
    code: 'terminal_attach_failed',
    message: 'attach failed',
  });
  assert.equal(TerminalPanel.pendingAttachSessionIds.has('term_attach_retry'), false);

  TerminalPanel.activateSession('term_attach_retry');
  assert.equal(
    emitted.filter((entry) => entry.event === 'terminal:attach_session' && entry.payload.sessionId === 'term_attach_retry').length,
    2,
  );
});

test('TerminalPanel clears sticky pendingClose on terminal_session_not_attached so second close re-emits', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey, emitted } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();
  TerminalPanel.ensureSession({ sessionId: 'term_close_retry', processStatus: 'running' });

  TerminalPanel.closeSession('term_close_retry');
  assert.equal(emitted.filter((entry) => entry.event === 'terminal:close_session').length, 1);
  assert.equal(TerminalPanel.pendingCloseSessionIds.has('term_close_retry'), true);

  socketHandlers.get('terminal:error')({
    sessionId: 'term_close_retry',
    code: 'terminal_session_not_attached',
    message: 'Terminal session is not attached',
  });
  assert.equal(TerminalPanel.pendingCloseSessionIds.has('term_close_retry'), false);

  TerminalPanel.closeSession('term_close_retry');
  assert.equal(emitted.filter((entry) => entry.event === 'terminal:close_session').length, 2);
});

test('TerminalPanel does not clear attach or close pending on input rate-limit errors', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();
  TerminalPanel.ensureSession({ sessionId: 'term_rate', processStatus: 'running' });
  TerminalPanel.pendingAttachSessionIds.set('term_rate', 'attach-rate-op');
  TerminalPanel.pendingCloseSessionIds.set('term_rate', 'close-rate-op');

  socketHandlers.get('terminal:error')({
    sessionId: 'term_rate',
    code: 'terminal_input_rate_limited',
    message: 'too fast',
  });

  assert.equal(TerminalPanel.pendingAttachSessionIds.has('term_rate'), true);
  assert.equal(TerminalPanel.pendingCloseSessionIds.has('term_rate'), true);
});

test('TerminalPanel disables composer for exited active session even when attached', () => {
  const { TerminalPanel, elements } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.socketState = 'connected';
  TerminalPanel.socket = { connected: true, emit() {} };
  TerminalPanel.ensureSession({
    sessionId: 'term_exited_composer',
    status: 'attached',
    processStatus: 'exited',
  }, { activate: true });
  TerminalPanel.attachedSessionIds.add('term_exited_composer');
  TerminalPanel.refreshComposer();

  assert.equal(elements.get('terminalComposer').disabled, true);
  assert.equal(elements.get('terminalComposerSubmit').disabled, true);
  assert.equal(TerminalPanel.isComposerReady(), false);
});

test('TerminalPanel emitTerminalInput returns null without pending ack or echo when unattached', () => {
  function BufferingTerminal() {
    return {
      writes: [],
      open() {},
      focus() {},
      loadAddon() {},
      onData(handler) { this.onDataHandler = handler; },
      onResize(handler) { this.onResizeHandler = handler; },
      write(data) { this.writes.push(String(data)); },
      dispose() {},
    };
  }

  const { TerminalPanel, emitted, createdTerms } = loadTerminal({ Terminal: BufferingTerminal });
  TerminalPanel.cacheElements();
  TerminalPanel.socketState = 'connected';
  TerminalPanel.socket = {
    connected: true,
    emit(event, payload) { emitted.push({ event, payload }); },
  };
  TerminalPanel.ensureSession({ sessionId: 'term_unattached_input', processStatus: 'running' }, { activate: true });
  const term = createdTerms[0] || TerminalPanel.terms.get('term_unattached_input');
  const beforePending = TerminalPanel.pendingInputAcks.size;

  const result = TerminalPanel.emitTerminalInput('term_unattached_input', 'x', { optimisticEcho: true });
  if (term?.onDataHandler) {
    term.onDataHandler('y');
  }

  assert.equal(result, null);
  assert.equal(TerminalPanel.pendingInputAcks.size, beforePending);
  assert.equal(emitted.some((entry) => entry.event === 'terminal:input'), false);
  assert.equal(term.writes.length, 0);
});

test('TerminalPanel emitTerminalInput returns null without side effects when process is not running', () => {
  const { TerminalPanel, emitted } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.socketState = 'connected';
  TerminalPanel.socket = {
    connected: true,
    emit(event, payload) { emitted.push({ event, payload }); },
  };
  TerminalPanel.ensureSession({ sessionId: 'term_exited_input', processStatus: 'exited' }, { activate: true });
  TerminalPanel.attachedSessionIds.add('term_exited_input');
  const beforePending = TerminalPanel.pendingInputAcks.size;

  const result = TerminalPanel.emitTerminalInput('term_exited_input', 'x', { optimisticEcho: true });

  assert.equal(result, null);
  assert.equal(TerminalPanel.pendingInputAcks.size, beforePending);
  assert.equal(emitted.some((entry) => entry.event === 'terminal:input'), false);
});

test('TerminalPanel registers pending input before adapter send and rolls back without echo on throw', () => {
  const seenDuringSend = [];
  const { TerminalPanel } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.socketState = 'connected';
  TerminalPanel.socket = { connected: true, emit() {} };
  TerminalPanel.preferredTransport = 'webrtc-turn';
  TerminalPanel.webrtcReady = true;
  TerminalPanel.webrtcDc = {
    readyState: 'open',
    send() {
      seenDuringSend.push(TerminalPanel.pendingInputAcks.size);
      throw new Error('dc closed');
    },
  };
  TerminalPanel.ensureSession({ sessionId: 'term_dc_fail', processStatus: 'running' }, { activate: true });
  TerminalPanel.attachedSessionIds.add('term_dc_fail');
  const beforePending = TerminalPanel.pendingInputAcks.size;

  const result = TerminalPanel.emitTerminalInput('term_dc_fail', 'a', { optimisticEcho: true });

  assert.equal(result, null);
  assert.deepEqual(seenDuringSend, [beforePending + 1]);
  assert.equal(TerminalPanel.pendingInputAcks.size, beforePending);
});

test('TerminalPanel emitTerminalInput hard-rejects preferred TURN when dc is not open', () => {
  const { TerminalPanel, emitted, elements } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.socketState = 'connected';
  TerminalPanel.socket = {
    connected: true,
    emit(event, payload) { emitted.push({ event, payload }); },
  };
  TerminalPanel.preferredTransport = 'webrtc-turn';
  TerminalPanel.webrtcReady = false;
  TerminalPanel.webrtcDc = { readyState: 'connecting', send() { throw new Error('should not send'); } };
  TerminalPanel.ensureSession({ sessionId: 'term_turn_hard', processStatus: 'running' }, { activate: true });
  TerminalPanel.attachedSessionIds.add('term_turn_hard');
  const beforePending = TerminalPanel.pendingInputAcks.size;

  const result = TerminalPanel.emitTerminalInput('term_turn_hard', 'x', { optimisticEcho: true });

  assert.equal(result, null);
  assert.equal(TerminalPanel.pendingInputAcks.size, beforePending);
  assert.equal(emitted.some((entry) => entry.event === 'terminal:input'), false);
  assert.match(
    elements.get('terminalTransportStatus').textContent,
    /TURN 未就绪|未回退 Socket\.IO/,
  );
  assert.equal(elements.get('terminalTransportStatus').dataset.state, 'error');
});

test('TerminalPanel activateSession rebinds open TURN dc with preferDcOutput and new sid', () => {
  const sentFrames = [];
  const { TerminalPanel } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.socketState = 'connected';
  TerminalPanel.socket = { connected: true, emit() {} };
  TerminalPanel.preferredTransport = 'webrtc-turn';
  TerminalPanel.webrtcReady = true;
  TerminalPanel.webrtcOutputReady = true;
  TerminalPanel.webrtcBoundSessionId = 'term_turn_a';
  TerminalPanel.webrtcDc = {
    readyState: 'open',
    send(frame) { sentFrames.push(JSON.parse(String(frame))); },
  };
  TerminalPanel.ensureSession({ sessionId: 'term_turn_a', processStatus: 'running' }, { activate: true });
  TerminalPanel.ensureSession({ sessionId: 'term_turn_b', processStatus: 'running' });
  TerminalPanel.attachedSessionIds.add('term_turn_a');
  TerminalPanel.attachedSessionIds.add('term_turn_b');

  assert.equal(TerminalPanel.shouldPreferWebRtcOutput('term_turn_a'), true);

  TerminalPanel.activateSession('term_turn_b', { announce: false });

  const bindFrames = sentFrames.filter((frame) => frame.t === 'bind');
  assert.equal(bindFrames.length >= 1, true);
  const lastBind = bindFrames.at(-1);
  assert.equal(lastBind.sid, 'term_turn_b');
  assert.equal(lastBind.preferDcOutput, true);
  // Mute window: suppress cleared until output_bound for the new sid.
  assert.equal(TerminalPanel.webrtcOutputReady, false);
  assert.equal(TerminalPanel.webrtcBoundSessionId, null);
  assert.equal(TerminalPanel.shouldPreferWebRtcOutput('term_turn_b'), false);

  TerminalPanel.handleWebRtcMessage({ t: 'output_bound', sid: 'term_turn_b' });
  assert.equal(TerminalPanel.webrtcBoundSessionId, 'term_turn_b');
  assert.equal(TerminalPanel.webrtcOutputReady, true);
  assert.equal(TerminalPanel.shouldPreferWebRtcOutput('term_turn_b'), true);
  assert.equal(TerminalPanel.shouldPreferWebRtcOutput('term_turn_a'), false);
});

test('TerminalPanel attach/close emit bounded operationId and store pending by operation', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey, emitted } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();
  TerminalPanel.ensureSession({ sessionId: 'term_op_attach', processStatus: 'running' });
  TerminalPanel.ensureSession({ sessionId: 'term_op_close', processStatus: 'running' });

  TerminalPanel.activateSession('term_op_attach');
  const attachEmit = emitted.find((entry) => (
    entry.event === 'terminal:attach_session' && entry.payload.sessionId === 'term_op_attach'
  ));
  assert.ok(attachEmit);
  assert.equal(typeof attachEmit.payload.operationId, 'string');
  assert.ok(attachEmit.payload.operationId.length > 0);
  assert.ok(attachEmit.payload.operationId.length <= 128);
  assert.equal(TerminalPanel.pendingAttachSessionIds.get('term_op_attach'), attachEmit.payload.operationId);

  TerminalPanel.closeSession('term_op_close');
  const closeEmit = emitted.find((entry) => (
    entry.event === 'terminal:close_session' && entry.payload.sessionId === 'term_op_close'
  ));
  assert.ok(closeEmit);
  assert.equal(typeof closeEmit.payload.operationId, 'string');
  assert.ok(closeEmit.payload.operationId.length > 0);
  assert.ok(closeEmit.payload.operationId.length <= 128);
  assert.equal(TerminalPanel.pendingCloseSessionIds.get('term_op_close'), closeEmit.payload.operationId);
});

test('TerminalPanel clears attach pending only for matching action+sessionId+operationId', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey, emitted } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();
  TerminalPanel.ensureSession({ sessionId: 'term_op_match', processStatus: 'running' });

  TerminalPanel.activateSession('term_op_match');
  const operationId = emitted.find((entry) => (
    entry.event === 'terminal:attach_session' && entry.payload.sessionId === 'term_op_match'
  )).payload.operationId;

  socketHandlers.get('terminal:error')({
    action: 'attach',
    sessionId: 'term_op_match',
    operationId: 'stale-operation-id',
    code: 'terminal_attach_failed',
    message: 'stale failure',
  });
  assert.equal(TerminalPanel.pendingAttachSessionIds.get('term_op_match'), operationId);

  socketHandlers.get('terminal:error')({
    action: 'attach',
    sessionId: 'term_op_match',
    operationId,
    code: 'terminal_attach_failed',
    message: 'current failure',
  });
  assert.equal(TerminalPanel.pendingAttachSessionIds.has('term_op_match'), false);

  TerminalPanel.activateSession('term_op_match');
  assert.equal(
    emitted.filter((entry) => entry.event === 'terminal:attach_session' && entry.payload.sessionId === 'term_op_match').length,
    2,
  );
});

test('TerminalPanel attach success with stale operationId does not clear current pendingAttach', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey, emitted } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();
  TerminalPanel.ensureSession({ sessionId: 'term_op_success', processStatus: 'running' });

  TerminalPanel.activateSession('term_op_success');
  const operationId = emitted.find((entry) => (
    entry.event === 'terminal:attach_session' && entry.payload.sessionId === 'term_op_success'
  )).payload.operationId;

  socketHandlers.get('terminal:session_attached')({
    action: 'attach',
    sessionId: 'term_op_success',
    operationId: 'old-attach-op',
    processStatus: 'running',
    status: 'attached',
  });
  assert.equal(TerminalPanel.pendingAttachSessionIds.get('term_op_success'), operationId);
  // Lifecycle may still mark attached from authoritative payload; pending stays until match.
  assert.equal(TerminalPanel.attachedSessionIds.has('term_op_success'), true);

  socketHandlers.get('terminal:session_attached')({
    action: 'attach',
    sessionId: 'term_op_success',
    operationId,
    processStatus: 'running',
    status: 'attached',
  });
  assert.equal(TerminalPanel.pendingAttachSessionIds.has('term_op_success'), false);
});

test('TerminalPanel close error with stale operationId keeps pendingClose; match clears it', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey, emitted } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();
  TerminalPanel.ensureSession({ sessionId: 'term_op_close_match', processStatus: 'running' });
  TerminalPanel.closeSession('term_op_close_match');
  const operationId = emitted.find((entry) => entry.event === 'terminal:close_session').payload.operationId;

  socketHandlers.get('terminal:error')({
    action: 'close',
    sessionId: 'term_op_close_match',
    operationId: 'stale-close-op',
    code: 'terminal_session_not_attached',
    message: 'stale',
  });
  assert.equal(TerminalPanel.pendingCloseSessionIds.get('term_op_close_match'), operationId);

  socketHandlers.get('terminal:error')({
    action: 'close',
    sessionId: 'term_op_close_match',
    operationId,
    code: 'terminal_session_not_attached',
    message: 'current',
  });
  assert.equal(TerminalPanel.pendingCloseSessionIds.has('term_op_close_match'), false);
});

test('TerminalPanel broadcast closed updates lifecycle but only matching operationId clears pendingClose', () => {
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
  TerminalPanel.ensureSession({ sessionId: 'term_op_broadcast', processStatus: 'running' });
  TerminalPanel.closeSession('term_op_broadcast');
  const operationId = emitted.find((entry) => entry.event === 'terminal:close_session').payload.operationId;
  assert.equal(TerminalPanel.pendingCloseSessionIds.get('term_op_broadcast'), operationId);

  socketHandlers.get('terminal:session_closed')({
    action: 'close',
    sessionId: 'term_op_broadcast',
    operationId: 'other-client-close-op',
  });

  assert.equal(TerminalPanel.state.getSession('term_op_broadcast'), null);
  assert.equal(TerminalPanel.terms.has('term_op_broadcast'), false);
  assert.equal(disposeCalls, 1);
  assert.equal(TerminalPanel.pendingCloseSessionIds.get('term_op_broadcast'), operationId);

  // Re-create local tab state and a fresh pending close to prove match still works.
  TerminalPanel.ensureSession({ sessionId: 'term_op_broadcast2', processStatus: 'running' });
  TerminalPanel.closeSession('term_op_broadcast2');
  const op2 = emitted.filter((entry) => entry.event === 'terminal:close_session').at(-1).payload.operationId;
  socketHandlers.get('terminal:session_closed')({
    action: 'close',
    sessionId: 'term_op_broadcast2',
    operationId: op2,
  });
  assert.equal(TerminalPanel.pendingCloseSessionIds.has('term_op_broadcast2'), false);
  assert.equal(TerminalPanel.state.getSession('term_op_broadcast2'), null);
});

test('TerminalPanel action-scoped errors do not clear the other pending operation', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();
  TerminalPanel.ensureSession({ sessionId: 'term_op_scope', processStatus: 'running' });
  TerminalPanel.pendingAttachSessionIds.set('term_op_scope', 'attach-op-1');
  TerminalPanel.pendingCloseSessionIds.set('term_op_scope', 'close-op-1');

  socketHandlers.get('terminal:error')({
    action: 'attach',
    sessionId: 'term_op_scope',
    operationId: 'attach-op-1',
    code: 'terminal_session_not_attached',
    message: 'attach path',
  });
  assert.equal(TerminalPanel.pendingAttachSessionIds.has('term_op_scope'), false);
  assert.equal(TerminalPanel.pendingCloseSessionIds.get('term_op_scope'), 'close-op-1');

  TerminalPanel.pendingAttachSessionIds.set('term_op_scope', 'attach-op-2');
  socketHandlers.get('terminal:error')({
    action: 'close',
    sessionId: 'term_op_scope',
    operationId: 'close-op-1',
    code: 'terminal_session_not_attached',
    message: 'close path',
  });
  assert.equal(TerminalPanel.pendingAttachSessionIds.get('term_op_scope'), 'attach-op-2');
  assert.equal(TerminalPanel.pendingCloseSessionIds.has('term_op_scope'), false);
});

test('TerminalPanel does not cache bootstrapAuthToken on failed bootstrap and retries next ensure', async () => {
  let bootstrapCalls = 0;
  const { TerminalPanel } = loadTerminal({
    fetch: async (url) => {
      if (!String(url).endsWith('/api/terminal/bootstrap')) {
        return { ok: true, json: async () => ({}) };
      }
      bootstrapCalls += 1;
      if (bootstrapCalls === 1) {
        return { ok: false, status: 503, json: async () => ({ error: 'unavailable' }) };
      }
      return { ok: true, json: async () => ({ allowPolling: true }) };
    },
  });

  await TerminalPanel.ensureTerminalBootstrap('tok-a');
  assert.equal(TerminalPanel.bootstrapAuthToken, null);
  assert.equal(TerminalPanel.allowPolling, false);

  await TerminalPanel.ensureTerminalBootstrap('tok-a');
  assert.equal(bootstrapCalls, 2);
  assert.equal(TerminalPanel.bootstrapAuthToken, 'tok-a');
  assert.equal(TerminalPanel.allowPolling, true);
});

test('TerminalPanel deduplicates concurrent websocket-only fallback after bootstrap HTTP 500', async () => {
  let bootstrapCalls = 0;
  const ioCalls = [];
  let markSocketCreated;
  const socketCreated = new Promise((resolve) => {
    markSocketCreated = resolve;
  });
  const { TerminalPanel, sessionStorageMap, tokenKey } = loadTerminal({
    fetch: async (url) => {
      if (!String(url).endsWith('/api/terminal/bootstrap')) {
        return { ok: true, json: async () => ({}) };
      }
      bootstrapCalls += 1;
      if (bootstrapCalls === 1) {
        return { ok: false, status: 500, json: async () => ({ error: 'unavailable' }) };
      }
      return new Promise(() => {});
    },
    io: (url, options) => {
      ioCalls.push({ url, options });
      markSocketCreated();
      return createSocketDouble();
    },
  });
  sessionStorageMap.set(tokenKey, 'admin-token');

  const connectPromises = [
    TerminalPanel.connectSocket(),
    TerminalPanel.connectSocket(),
    TerminalPanel.connectSocket(),
  ];
  await socketCreated;

  assert.ok(bootstrapCalls > 0, 'bootstrap endpoint should be attempted');
  assert.equal(bootstrapCalls, 1);
  assert.equal(ioCalls.length, 1);
  assert.ok(bootstrapCalls <= 2, `expected <=2 bootstrap calls, got ${bootstrapCalls}`);
  assert.equal(connectPromises[0], connectPromises[1]);
  assert.equal(connectPromises[1], connectPromises[2]);
  assert.deepEqual(Array.from(ioCalls[0].options.transports), ['websocket']);
  assert.equal(ioCalls[0].options.auth.token, 'admin-token');
});

test('TerminalPanel does not reuse in-flight bootstrap promise across different tokens', async () => {
  const started = [];
  const gates = new Map();
  const { TerminalPanel } = loadTerminal({
    fetch: async (url, options) => {
      if (!String(url).endsWith('/api/terminal/bootstrap')) {
        return { ok: true, json: async () => ({}) };
      }
      const auth = options?.headers?.Authorization || '';
      const token = auth.replace(/^Bearer\s+/i, '');
      started.push(token);
      await new Promise((resolve) => {
        gates.set(token, resolve);
      });
      return {
        ok: true,
        json: async () => ({ allowPolling: token === 'tok-b' }),
      };
    },
  });

  const pA = TerminalPanel.ensureTerminalBootstrap('tok-a');
  const pB = TerminalPanel.ensureTerminalBootstrap('tok-b');
  assert.equal(started.length, 2);
  assert.notEqual(pA, pB);

  gates.get('tok-a')();
  await pA;
  assert.equal(TerminalPanel.bootstrapAuthToken, 'tok-a');
  assert.equal(TerminalPanel.allowPolling, false);

  gates.get('tok-b')();
  await pB;
  assert.equal(TerminalPanel.bootstrapAuthToken, 'tok-b');
  assert.equal(TerminalPanel.allowPolling, true);
});

test('TerminalPanel fits and emits terminal:resize once when processStatus becomes running', () => {
  let fitCalls = 0;
  function TrackingFitAddon() {
    this.fit = () => { fitCalls += 1; };
  }
  function SizedTerminal() {
    return {
      cols: 101,
      rows: 37,
      open() {},
      focus() {},
      loadAddon() {},
      onData(handler) { this.onDataHandler = handler; },
      onResize(handler) { this.onResizeHandler = handler; },
      write() {},
      dispose() {},
    };
  }
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey, emitted } = loadTerminal({
    Terminal: SizedTerminal,
    FitAddon: { FitAddon: TrackingFitAddon },
  });
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();
  TerminalPanel.ensureSession({ sessionId: 'term_start_run', processStatus: 'starting' }, { activate: true });
  TerminalPanel.attachedSessionIds.add('term_start_run');
  fitCalls = 0;
  const before = emitted.filter((entry) => entry.event === 'terminal:resize').length;

  socketHandlers.get('terminal:output')({
    sessionId: 'term_start_run',
    data: 'ready\r\n',
  });

  assert.equal(TerminalPanel.state.getSession('term_start_run').processStatus, 'running');
  assert.equal(fitCalls >= 1, true);
  const resizes = emitted.filter((entry) => entry.event === 'terminal:resize');
  assert.equal(resizes.length, before + 1);
  assert.equal(resizes.at(-1).payload.sessionId, 'term_start_run');
  assert.equal(resizes.at(-1).payload.cols, 101);
  assert.equal(resizes.at(-1).payload.rows, 37);

  socketHandlers.get('terminal:output')({
    sessionId: 'term_start_run',
    data: 'again\r\n',
  });
  assert.equal(emitted.filter((entry) => entry.event === 'terminal:resize').length, before + 1);
});
