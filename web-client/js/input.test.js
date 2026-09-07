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
  const addDocumentListener = (type, handler) => {
    let dispatcher = documentListeners.get(type);
    if (!dispatcher) {
      dispatcher = (event) => {
        for (const listener of [...dispatcher.listeners]) listener(event);
      };
      dispatcher.listeners = [];
      documentListeners.set(type, dispatcher);
    }
    dispatcher.listeners.push(handler);
  };
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
      documentElement: {},
      fullscreenElement: null,
      addEventListener: addDocumentListener,
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
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'input-trace.js'), 'utf8'), context);
  context.__InputTrace = context.InputTrace.create({
    hashInputIds: null,
    setTimeoutFn: () => null,
  });
  context.Diagnostic = {
    recordInputTrace(stage, meta) { return context.__InputTrace.record(stage, meta); },
    getInputTraceSnapshot() { return context.__InputTrace.snapshot(); },
  };
  for (const filename of ['input-geometry.js', 'keyboard-transport.js', 'remote-keyboard-controller.js', 'mobile-text-input.js', 'input.js']) {
    const source = fs.readFileSync(path.join(__dirname, filename), 'utf8');
    vm.runInContext(filename === 'input.js' ? `${source}\nglobalThis.__Input = Input;` : source, context);
  }
  return {
    Input: context.__Input, context, elements, documentListeners, windowListeners, socketEvents,
    trace: context.__InputTrace,
  };
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

function createRemoteTextModel() {
  let value = '';
  let cursor = 0;
  const modifiers = new Set();
  const insert = (text) => {
    const points = Array.from(String(text || ''));
    value = `${Array.from(value).slice(0, cursor).join('')}${points.join('')}${Array.from(value).slice(cursor).join('')}`;
    cursor += points.length;
  };
  const applyStep = (step) => {
    if (!step || step.phase !== 'down') return;
    if (/^(Control|Shift|Alt|Meta)(Left|Right)$/.test(step.code || '')) {
      modifiers.add(step.code);
      return;
    }
    if (step.code === 'ArrowLeft') {
      cursor = Math.max(0, cursor - 1);
      return;
    }
    if (step.code === 'ArrowRight') {
      cursor = Math.min(Array.from(value).length, cursor + 1);
      return;
    }
    if (/^Key[A-Z]$/.test(step.code || '')
      && !step.modifiers?.ctrlKey && !step.modifiers?.metaKey && !step.modifiers?.altKey) {
      const letter = step.code.slice(-1);
      insert(step.modifiers?.shiftKey ? letter : letter.toLowerCase());
    }
  };
  return {
    apply(payload) {
      if (payload?.action === 'text') insert(payload.payload?.text);
      if (payload?.action === 'key') applyStep(payload.payload);
      if (payload?.action === 'batch') payload.payload?.steps?.forEach(applyStep);
      if (payload?.action === 'key' && payload.payload?.phase === 'up') {
        modifiers.delete(payload.payload.code);
      }
    },
    snapshot() { return { value, cursor, modifiers: [...modifiers].sort() }; },
  };
}

function settleKeyboardWrites(Input, socketEvents, model, from = 0) {
  const entries = socketEvents.slice(from).filter(({ event, payload }) => event === 'input'
    && payload?.type === 'keyboard');
  for (const { payload } of entries) {
    model.apply(payload);
    Input.acceptKeyboardAck({
      schemaVersion: 2,
      leaseEpoch: payload.leaseEpoch,
      status: 'applied',
      appliedSeq: payload.seq,
      inputIds: payload.inputIds,
    });
  }
  return socketEvents.length;
}

function toggleMobileInput(Input, elements, shown) {
  const button = elements.get('mobileTextInputBtn');
  button.focus();
  button.listeners.get('click')({ preventDefault() {} });
  return elements.get('mobileTextInput');
}

function setupCrossModeHarness() {
  const loaded = loadInput();
  const { Input, context, elements, documentListeners, socketEvents } = loaded;
  const model = createRemoteTextModel();
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupEventListeners();
  Input.setupTextInput();
  const mobileInput = toggleMobileInput(Input, elements, false);
  mobileInput.value = 'abc';
  mobileInput.listeners.get('input')({ target: mobileInput });
  let eventIndex = settleKeyboardWrites(Input, socketEvents, model);
  toggleMobileInput(Input, elements, true);
  return {
    Input,
    context,
    elements,
    documentListeners,
    socketEvents,
    model,
    mobileInput,
    get eventIndex() { return eventIndex; },
    settle() { eventIndex = settleKeyboardWrites(Input, socketEvents, model, eventIndex); },
  };
}

function appendMobileText(harness, text) {
  const input = harness.mobileInput;
  const sentinel = '\u200b';
  const raw = String(input.value || '').endsWith(sentinel)
    ? String(input.value).slice(0, -sentinel.length) : String(input.value || '');
  const start = Number.isInteger(input.selectionStart) ? input.selectionStart : raw.length;
  const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : start;
  input.value = `${raw.slice(0, start)}${text}${raw.slice(end)}${sentinel}`;
  input.selectionStart = start + text.length;
  input.selectionEnd = start + text.length;
  input.listeners.get('input')({ target: input });
  harness.settle();
}

function withFakeTimers(run) {
  const nativeSetTimeout = global.setTimeout;
  const nativeClearTimeout = global.clearTimeout;
  const callbacks = [];
  global.setTimeout = (callback) => {
    callbacks.push(callback);
    return callbacks.length;
  };
  global.clearTimeout = (id) => { callbacks[id - 1] = null; };
  try {
    return run(callbacks);
  } finally {
    global.setTimeout = nativeSetTimeout;
    global.clearTimeout = nativeClearTimeout;
  }
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
  context.document.fullscreenElement = context.document.documentElement;
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

test('viewport support is a derived gate for new writes while safe releases and local drafts remain available', () => {
  const { Input, context, elements, socketEvents, documentListeners } = loadInput();
  loadTouchAdapter(context);
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupEventListeners();
  Input.setupTextInput();
  documentListeners.get('keydown')(keyboard('keydown', {
    code: 'ShiftLeft', key: 'Shift', shiftKey: true,
  }));
  assert.equal(Input.keyboardController.getSnapshot().pressedKeyCount, 1);
  Input.setViewportInputSupported(false);
  const keyboardCountBeforeDraft = socketEvents.filter(({ event, payload }) => event === 'input' && payload.type === 'keyboard').length;

  const mobileInput = elements.get('mobileTextInput');
  mobileInput.value = 'draft';
  mobileInput.listeners.get('input')({ target: mobileInput });
  assert.equal(Input.mobileTextInputAdapter.getSnapshot().hasPending, true);
  assert.equal(socketEvents.filter(({ event, payload }) => event === 'input' && payload.type === 'keyboard').length, keyboardCountBeforeDraft);

  const keydown = keyboard('keydown', { code: 'KeyA', key: 'a' });
  documentListeners.get('keydown')(keydown);
  assert.equal(socketEvents.filter(({ event, payload }) => event === 'input' && payload.type === 'keyboard').length, keyboardCountBeforeDraft);

  const release = keyboard('keyup', { code: 'ShiftLeft', key: 'Shift' });
  documentListeners.get('keyup')(release);
  assert.equal(Input.keyboardController.getSnapshot().pressedKeyCount, 0);
});

test('unsupported viewport announces a recoverable hint without replacing pending or uncertain status', () => {
  const { Input, context, elements } = loadInput();
  const status = context.document.getElementById('mobileInputStatus');

  Input.setViewportInputSupported(false);
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /收起.*键盘|旋转/);

  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const mobileInput = elements.get('mobileTextInput');
  mobileInput.value = 'draft';
  mobileInput.listeners.get('input')({ target: mobileInput });
  assert.equal(Input.mobileTextInputAdapter.getSnapshot().hasPending, true);
  assert.match(status.textContent, /未发送/);
  assert.match(status.textContent, /收起.*键盘|旋转/);

  Input.setViewportInputSupported(true);
  assert.match(status.textContent, /未发送/);
  assert.doesNotMatch(status.textContent, /收起.*键盘|旋转/);

  Input.mobileTextInputAdapter.onTransportState('reacquire-required');
  Input.setViewportInputSupported(false);
  assert.match(status.textContent, /连接|位置/);
  assert.match(status.textContent, /收起.*键盘|旋转/);
  Input.setViewportInputSupported(true);
  assert.match(status.textContent, /连接|位置/);
  assert.doesNotMatch(status.textContent, /收起.*键盘|旋转/);
  assert.equal(Input.mobileTextInputAdapter.getSnapshot().hasPending, true);
});

test('unsupported viewport preserves accepted touch and mouse moves until release or geometry reset', () => {
  const touchCase = loadInput();
  loadTouchAdapter(touchCase.context);
  touchCase.context.requestAnimationFrame = (callback) => {
    callback();
    return null;
  };
  touchCase.context.navigator.maxTouchPoints = 1;
  activate(touchCase.Input, touchCase.context);
  touchCase.Input.setupEventListeners();
  const touchSurface = touchCase.elements.get('remoteVideo');
  const touch = (type, clientX, overrides = {}) => touchSurface.listeners.get(type)({
    pointerType: 'touch', pointerId: 1, isPrimary: true,
    clientX, clientY: 40, buttons: type === 'pointerup' ? 0 : 1,
    currentTarget: touchSurface, timeStamp: 10, preventDefault() {}, ...overrides,
  });

  touch('pointerdown', 20);
  touch('pointermove', 40);
  assert.equal(touchCase.Input.getMobileSurfaceContextSnapshot().state, 'pending');
  touchCase.Input.setViewportInputSupported(false);
  const touchWritesBeforeMove = touchCase.socketEvents.filter(({ event, payload }) => event === 'input'
    && payload.type === 'mouse').length;
  assert.equal(touchCase.Input.sendInput('mouse', 'move', { relX: 0.7, relY: 0.4, buttons: 0 }), null);
  touch('pointermove', 56);
  const touchWritesAfterMove = touchCase.socketEvents.filter(({ event, payload }) => event === 'input'
    && payload.type === 'mouse');
  assert.equal(touchWritesAfterMove.length, touchWritesBeforeMove + 1);
  assert.equal(touchWritesAfterMove.at(-1).payload.action, 'move');
  touch('pointerup', 56);
  const touchWritesAfterUp = touchCase.socketEvents.filter(({ event, payload }) => event === 'input'
    && payload.type === 'mouse');
  assert.equal(touchWritesAfterUp.at(-1).payload.action, 'up');
  assert.equal(touchWritesAfterUp.filter(({ payload }) => payload.action === 'up').length, 1);
  assert.equal(touchCase.Input.sendInput('mouse', 'move', { relX: 0.7, relY: 0.4, buttons: 0 }), null);

  const mouseCase = loadInput();
  activate(mouseCase.Input, mouseCase.context);
  mouseCase.Input.setupEventListeners();
  const mouseSurface = mouseCase.elements.get('remoteVideo');
  const mouse = (type, clientX, overrides = {}) => mouseSurface.listeners.get(type)({
    pointerType: 'mouse', pointerId: 8, button: 0, detail: 1,
    clientX, clientY: 40, buttons: type === 'pointerup' ? 0 : 1,
    currentTarget: mouseSurface, timeStamp: 10, preventDefault() {}, ...overrides,
  });

  mouse('pointerdown', 20);
  assert.ok(mouseCase.Input._mobileSurfaceGesture);
  mouseCase.Input.setViewportInputSupported(false);
  const mouseWritesBeforeMove = mouseCase.socketEvents.filter(({ event, payload }) => event === 'input'
    && payload.type === 'mouse').length;
  mouse('pointermove', 44);
  const mouseWritesAfterMove = mouseCase.socketEvents.filter(({ event, payload }) => event === 'input'
    && payload.type === 'mouse');
  assert.equal(mouseWritesAfterMove.length, mouseWritesBeforeMove + 1);
  assert.equal(mouseWritesAfterMove.at(-1).payload.action, 'move');
  mouseSurface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 80, height: 100 });
  const writesBeforeGeometry = mouseCase.socketEvents.filter(({ event, payload }) => event === 'input'
    && payload.type === 'mouse').length;
  mouse('pointermove', 50);
  const writesAfterGeometry = mouseCase.socketEvents.filter(({ event, payload }) => event === 'input'
    && payload.type === 'mouse');
  assert.equal(writesAfterGeometry.length, writesBeforeGeometry + 1);
  assert.deepEqual(writesAfterGeometry.slice(writesBeforeGeometry).map(({ payload }) => payload.action), ['reset']);
});

test('unsupported viewport rejects new touch/context actions while up and reset remain safety releases', () => {
  const { Input, context, elements, socketEvents } = loadInput();
  loadTouchAdapter(context);
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupEventListeners();
  Input.setupTextInput();
  const surface = elements.get('remoteVideo');
  const adapter = Input.bindTouchAdapter(surface);
  Input._lastTouchAdapter = adapter;
  Input.setViewportInputSupported(false);

  assert.equal(adapter.clickButton('left', { relX: 0.4, relY: 0.4 }), null);
  assert.equal(Input.sendInput('mouse', 'down', { relX: 0.4, relY: 0.4, button: 'left' }), null);
  assert.equal(Input.sendInput('mouse', 'move', { relX: 0.4, relY: 0.4, buttons: 0 }), null);
  assert.equal(Input.sendInput('mouse', 'wheel', { relX: 0.4, relY: 0.4, deltaY: 1 }), null);

  const rightClick = makeElement();
  rightClick.dataset.mobileAction = 'rightClick';
  const navigation = makeElement();
  navigation.dataset.action = 'left';
  const showDock = makeElement();
  showDock.dataset.mobileAction = 'showDock';
  context.document.querySelectorAll = (selector) => selector === '.action-btn, [data-mobile-action]'
    ? [rightClick, navigation, showDock] : [];
  Input.setupActionButtons();
  rightClick.listeners.get('click')({ preventDefault() {} });
  navigation.listeners.get('click')({ preventDefault() {} });
  showDock.listeners.get('click')({ preventDefault() {} });
  assert.equal(socketEvents.length, 0);

  const upId = Input.sendInput('mouse', 'up', { relX: 0.4, relY: 0.4, button: 'left' });
  const resetId = Input.sendInput('mouse', 'reset', { reason: 'unsupported-viewport' });
  assert.ok(upId);
  assert.ok(resetId);
  assert.deepEqual(socketEvents.map(({ payload }) => payload.action), ['up', 'reset']);
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
  for (const { payload } of socketEvents.filter(({ event, payload }) => event === 'input' && payload.type === 'mouse')) {
    Input.acceptMouseAck({
      inputType: 'mouse', schemaVersion: 2, leaseEpoch: 3, status: 'applied',
      appliedSeq: payload.seq, inputIds: payload.inputIds,
    });
  }
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

test('screen-tracked modifier is safely released by mobile textarea keyup', () => {
  const { Input, context, elements, documentListeners, socketEvents } = loadInput();
  activate(Input, context);
  Input.setupTextInput();
  Input.setupEventListeners();
  documentListeners.get('keydown')(keyboard('keydown', { code: 'ShiftLeft', key: 'Shift', shiftKey: true }));
  assert.equal(Input.keyboardController.getSnapshot().pressedKeyCount, 1);
  const mobileInput = elements.get('mobileTextInput');
  mobileInput.listeners.get('keyup')({ type: 'keyup', target: mobileInput, code: 'ShiftLeft', key: 'Shift', stopPropagation() {} });
  assert.equal(Input.keyboardController.getSnapshot().pressedKeyCount, 0);
  assert.deepEqual(socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'key')
    .map(({ payload }) => payload.payload.phase), ['down', 'up']);
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

test('mobile toolbar navigation shares the textarea cursor and accepts duplicate insertions', () => {
  const { Input, context, elements, socketEvents } = loadInput();
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const leftButton = makeElement();
  leftButton.dataset.action = 'left';
  context.document.querySelectorAll = () => [leftButton];
  Input.setupActionButtons();
  const mobileInput = elements.get('mobileTextInput');
  mobileInput.value = 'abc';
  mobileInput.listeners.get('input')({ target: mobileInput });
  leftButton.listeners.get('click')({ preventDefault() {} });
  leftButton.listeners.get('click')({ preventDefault() {} });
  mobileInput.value = 'abbc\u200b';
  mobileInput.selectionStart = 2;
  mobileInput.selectionEnd = 2;
  mobileInput.listeners.get('input')({ target: mobileInput });

  assert.equal(mobileInput.value, 'abbc\u200b');
  const payloads = socketEvents.filter(({ event }) => event === 'input').map(({ payload }) => payload);
  assert.deepEqual(payloads.map(({ action }) => action), ['text', 'batch', 'batch', 'text']);
  assert.deepEqual(payloads.slice(1, 3).map(({ payload }) => payload.steps[1].code), ['ArrowLeft', 'ArrowLeft']);
  assert.equal(payloads.at(-1).payload.text, 'b');
});

test('mobile toolbar modifier navigation uses a context-change chord and preserves virtual modifier truth', () => {
  const { Input, context, elements, socketEvents } = loadInput();
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const shiftButton = makeElement();
  shiftButton.dataset.mobileAction = 'shift';
  const leftButton = makeElement();
  leftButton.dataset.action = 'left';
  const attrs = new Map([['aria-pressed', 'false']]);
  shiftButton.setAttribute = (name, value) => attrs.set(name, String(value));
  shiftButton.getAttribute = (name) => attrs.get(name) || null;
  context.document.querySelectorAll = () => [shiftButton, leftButton];
  Input.setupActionButtons();
  const mobileInput = elements.get('mobileTextInput');
  mobileInput.value = 'abc';
  mobileInput.listeners.get('input')({ target: mobileInput });
  shiftButton.listeners.get('click')({ preventDefault() {} });
  leftButton.listeners.get('click')({ preventDefault() {} });

  const batch = socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'batch').at(-1).payload;
  assert.equal(batch.payload.steps[0].code, 'ArrowLeft');
  assert.equal(batch.payload.steps.at(-1).code, 'ArrowLeft');
  assert.equal(batch.payload.steps[0].modifiers.shiftKey, true);
  assert.equal(Array.from(Input.keyboardController.getSnapshot().virtualModifiers).join(','), 'shift');
  assert.equal(Input.mobileTextInputAdapter.getSnapshot().status, 'idle');
});

test('mobile textarea Shift plus ArrowLeft sends one balanced chord without a second keyup', () => {
  const { Input, context, elements, socketEvents } = loadInput();
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const mobileInput = elements.get('mobileTextInput');
  mobileInput.value = 'abc';
  mobileInput.listeners.get('input')({ target: mobileInput });
  mobileInput.listeners.get('keydown')({
    type: 'keydown', target: mobileInput, key: 'ArrowLeft', code: 'ArrowLeft',
    shiftKey: true, ctrlKey: false, altKey: false, metaKey: false,
    preventDefault() {}, stopPropagation() {},
  });
  mobileInput.listeners.get('keyup')({
    type: 'keyup', target: mobileInput, key: 'ArrowLeft', code: 'ArrowLeft',
    shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    stopPropagation() {},
  });
  const batches = socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'batch');
  assert.equal(batches.length, 1);
  assert.equal(JSON.stringify(batches[0].payload.payload.steps.map(({ code, phase }) => [code, phase])), JSON.stringify([
    ['ShiftLeft', 'down'], ['ArrowLeft', 'down'], ['ArrowLeft', 'up'], ['ShiftLeft', 'up'],
  ]));
  assert.equal(Input.keyboardController.getSnapshot().pressedKeyCount, 0);
});

test('accepted physical navigation resets the hidden mobile cursor before reopen', () => {
  const h = setupCrossModeHarness();
  assert.equal(h.context.document.activeElement, h.Input.videoElement);

  h.documentListeners.get('keydown')(keyboard('keydown', { code: 'ArrowLeft', key: 'ArrowLeft' }));
  h.settle();
  h.documentListeners.get('keyup')(keyboard('keyup', { code: 'ArrowLeft', key: 'ArrowLeft' }));
  h.settle();

  assert.deepEqual(h.model.snapshot(), { value: 'abc', cursor: 2, modifiers: [] });
  assert.equal(h.mobileInput.value, '\u200b');
  toggleMobileInput(h.Input, h.elements, false);
  appendMobileText(h, 'X');

  assert.deepEqual(h.model.snapshot(), { value: 'abXc', cursor: 3, modifiers: [] });
  assert.equal(h.mobileInput.value, 'X\u200b');
  const writes = h.socketEvents.filter(({ event, payload }) => event === 'input' && payload?.type === 'keyboard')
    .map(({ payload }) => payload);
  assert.deepEqual(writes.map(({ action }) => action), ['text', 'key', 'key', 'text']);
  assert.deepEqual(writes.slice(1, 3).map(({ payload }) => [payload.phase, payload.code]), [
    ['down', 'ArrowLeft'], ['up', 'ArrowLeft'],
  ]);
});

test('accepted physical printable input resets the hidden mobile baseline before reopen', () => {
  const h = setupCrossModeHarness();

  h.documentListeners.get('keydown')(keyboard('keydown', { code: 'KeyB', key: 'b' }));
  h.settle();
  h.documentListeners.get('keyup')(keyboard('keyup', { code: 'KeyB', key: 'b' }));
  h.settle();

  assert.deepEqual(h.model.snapshot(), { value: 'abcb', cursor: 4, modifiers: [] });
  assert.equal(h.mobileInput.value, '\u200b');
  toggleMobileInput(h.Input, h.elements, false);
  appendMobileText(h, 'X');

  assert.deepEqual(h.model.snapshot(), { value: 'abcbX', cursor: 5, modifiers: [] });
  assert.equal(h.mobileInput.value, 'X\u200b');
  const writes = h.socketEvents.filter(({ event, payload }) => event === 'input' && payload?.type === 'keyboard')
    .map(({ payload }) => payload);
  assert.deepEqual(writes.map(({ action }) => action), ['text', 'key', 'key', 'text']);
  assert.equal(writes[1].payload.code, 'KeyB');
});

test('accepted physical chord resets mobile history once while modifier keyup still releases', () => {
  const h = setupCrossModeHarness();

  h.documentListeners.get('keydown')(keyboard('keydown', {
    code: 'ShiftLeft', key: 'Shift', shiftKey: true,
  }));
  h.settle();
  assert.equal(h.mobileInput.value, 'abc\u200b');
  h.documentListeners.get('keydown')(keyboard('keydown', {
    code: 'ArrowLeft', key: 'ArrowLeft', shiftKey: true,
  }));
  h.settle();
  h.documentListeners.get('keyup')(keyboard('keyup', {
    code: 'ArrowLeft', key: 'ArrowLeft', shiftKey: true,
  }));
  h.settle();
  h.documentListeners.get('keyup')(keyboard('keyup', {
    code: 'ShiftLeft', key: 'Shift', shiftKey: false,
  }));
  h.settle();

  assert.deepEqual(h.model.snapshot(), { value: 'abc', cursor: 2, modifiers: [] });
  assert.equal(h.Input.keyboardController.getSnapshot().pressedKeyCount, 0);
  assert.equal(h.mobileInput.value, '\u200b');
  toggleMobileInput(h.Input, h.elements, false);
  appendMobileText(h, 'X');

  assert.deepEqual(h.model.snapshot(), { value: 'abXc', cursor: 3, modifiers: [] });
  assert.equal(h.mobileInput.value, 'X\u200b');
  const writes = h.socketEvents.filter(({ event, payload }) => event === 'input' && payload?.type === 'keyboard')
    .map(({ payload }) => payload);
  assert.deepEqual(writes.map(({ action }) => action), ['text', 'key', 'key', 'key', 'key', 'text']);
  assert.deepEqual(writes.slice(1, 5).map(({ payload }) => [payload.phase, payload.code]), [
    ['down', 'ShiftLeft'], ['down', 'ArrowLeft'], ['up', 'ArrowLeft'], ['up', 'ShiftLeft'],
  ]);
});

test('ignored physical input on a local modal preserves the mobile baseline', () => {
  const h = setupCrossModeHarness();
  const modal = h.elements.get('textInputModal');
  const localInput = h.elements.get('remoteTextInput');
  localInput.tagName = 'INPUT';
  localInput.closest = () => modal;
  const before = h.socketEvents.length;

  h.documentListeners.get('keydown')(keyboard('keydown', {
    code: 'ArrowLeft', key: 'ArrowLeft', target: localInput,
  }));
  h.settle();

  assert.equal(h.socketEvents.length, before);
  assert.deepEqual(h.model.snapshot(), { value: 'abc', cursor: 3, modifiers: [] });
  assert.equal(h.mobileInput.value, 'abc\u200b');
  toggleMobileInput(h.Input, h.elements, false);
  appendMobileText(h, 'X');
  assert.deepEqual(h.model.snapshot(), { value: 'abcX', cursor: 4, modifiers: [] });
  assert.equal(h.mobileInput.value, 'abcX\u200b');
});

test('rejected physical input preserves the mobile baseline and sends no duplicate', () => {
  const h = setupCrossModeHarness();
  h.context.WebRTC.socket.connected = false;
  const before = h.socketEvents.length;

  h.documentListeners.get('keydown')(keyboard('keydown', { code: 'ArrowLeft', key: 'ArrowLeft' }));
  h.settle();

  assert.equal(h.socketEvents.length, before);
  assert.deepEqual(h.model.snapshot(), { value: 'abc', cursor: 3, modifiers: [] });
  assert.equal(h.mobileInput.value, 'abc\u200b');
  h.context.WebRTC.socket.connected = true;
  h.Input.keyboardTransport.markAdapterAvailable('socket');
  toggleMobileInput(h.Input, h.elements, false);
  appendMobileText(h, 'X');
  assert.deepEqual(h.model.snapshot(), { value: 'abcX', cursor: 4, modifiers: [] });
  assert.equal(h.mobileInput.value, 'abcX\u200b');
});

test('modifier-only physical input preserves mobile history and document keyup releases it', () => {
  const h = setupCrossModeHarness();

  h.documentListeners.get('keydown')(keyboard('keydown', {
    code: 'ShiftLeft', key: 'Shift', shiftKey: true,
  }));
  h.settle();
  assert.equal(h.Input.keyboardController.getSnapshot().pressedKeyCount, 1);
  assert.equal(h.mobileInput.value, 'abc\u200b');
  h.documentListeners.get('keyup')(keyboard('keyup', {
    code: 'ShiftLeft', key: 'Shift', shiftKey: false,
  }));
  h.settle();

  assert.equal(h.Input.keyboardController.getSnapshot().pressedKeyCount, 0);
  assert.deepEqual(h.model.snapshot(), { value: 'abc', cursor: 3, modifiers: [] });
  toggleMobileInput(h.Input, h.elements, false);
  appendMobileText(h, 'X');
  assert.deepEqual(h.model.snapshot(), { value: 'abcX', cursor: 4, modifiers: [] });
  assert.equal(h.mobileInput.value, 'abcX\u200b');
  const writes = h.socketEvents.filter(({ event, payload }) => event === 'input' && payload?.type === 'keyboard')
    .map(({ payload }) => payload);
  assert.deepEqual(writes.map(({ action }) => action), ['text', 'key', 'key', 'text']);
  assert.deepEqual(writes.slice(1, 3).map(({ payload }) => [payload.phase, payload.code]), [
    ['down', 'ShiftLeft'], ['up', 'ShiftLeft'],
  ]);
});

test('mobile editing action gates ordinary modal open and commits through one external-action path', () => {
  const { Input, context, elements, socketEvents } = loadInput();
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const mobileInput = elements.get('mobileTextInput');
  mobileInput.value = 'abc';
  mobileInput.listeners.get('input')({ target: mobileInput });
  const modalButton = elements.get('textInputBtn');
  const modalInput = elements.get('remoteTextInput');
  modalButton.listeners.get('click')({ preventDefault() {} });
  modalInput.value = 'X';
  elements.get('textInputSubmitBtn').listeners.get('click')({ preventDefault() {} });
  assert.equal(elements.get('textInputModal').hidden, true);

  mobileInput.value = 'Y';
  mobileInput.listeners.get('input')({ target: mobileInput });
  const textPayloads = socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'text')
    .map(({ payload }) => payload.payload.text);
  assert.deepEqual(textPayloads, ['abc', 'X', 'Y']);
});

test('mobile modal submit failure keeps it open and does not clear mobile history', () => {
  const { Input, context, elements } = loadInput();
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const mobileInput = elements.get('mobileTextInput');
  mobileInput.value = 'abc';
  mobileInput.listeners.get('input')({ target: mobileInput });
  const modalButton = elements.get('textInputBtn');
  const modalInput = elements.get('remoteTextInput');
  modalButton.listeners.get('click')({ preventDefault() {} });
  Input.keyboardController.sendText = () => false;
  modalInput.value = 'X';
  elements.get('textInputSubmitBtn').listeners.get('click')({ preventDefault() {} });
  assert.equal(elements.get('textInputModal').hidden, false);
  assert.equal(mobileInput.value, 'abc\u200b');
});

test('ordinary text modal does not open while a mobile draft needs recovery', () => {
  const { Input, context, elements } = loadInput();
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  elements.get('textInputModal').hidden = true;
  Input.mobileTextInputAdapter.onTransportState('blocked');
  const mobileInput = elements.get('mobileTextInput');
  mobileInput.value = 'draft';
  mobileInput.listeners.get('input')({ target: mobileInput });
  elements.get('textInputBtn').listeners.get('click')({ preventDefault() {} });
  assert.equal(elements.get('textInputModal').hidden, true);
});

test('repeated mobile setup does not duplicate modal or action listeners', () => {
  const { Input, context, elements } = loadInput();
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  context.document.getElementById('textInputBtn');
  const modalButton = elements.get('textInputBtn');
  const actionButton = makeElement();
  actionButton.dataset.action = 'copy';
  let modalClicks = 0;
  let actionClicks = 0;
  const modalAdd = modalButton.addEventListener.bind(modalButton);
  modalButton.addEventListener = (type, handler, options) => {
    if (type === 'click') modalClicks += 1;
    modalAdd(type, handler, options);
  };
  const actionAdd = actionButton.addEventListener.bind(actionButton);
  actionButton.addEventListener = (type, handler, options) => {
    if (type === 'click') actionClicks += 1;
    actionAdd(type, handler, options);
  };
  context.document.querySelectorAll = () => [actionButton];
  Input.setupTextInput();
  Input.setupTextInput();
  Input.setupActionButtons();
  Input.setupActionButtons();
  assert.equal(modalClicks, 1);
  assert.equal(actionClicks, 1);
});

test('surface confirmation stays pending until the ended gesture has matching down and up ACKs', () => {
  const { Input, context, elements, socketEvents } = loadInput();
  loadTouchAdapter(context);
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const surface = elements.get('remoteVideo');
  const adapter = Input.bindTouchAdapter(surface);
  Input._lastTouchAdapter = adapter;
  const down = adapter.clickButton;
  surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
  Input._lastPointerCoords = { relX: 0.4, relY: 0.4 };
  const id = down.call(adapter, 'left', { relX: 0.4, relY: 0.4 });
  assert.ok(id);
  assert.equal(Input.getMobileSurfaceContextSnapshot().state, 'pending');
  const writes = socketEvents.filter(({ event, payload }) => event === 'input' && payload.type === 'mouse');
  const downPayload = writes.find(({ payload }) => payload.action === 'down').payload;
  const upPayload = writes.find(({ payload }) => payload.action === 'up').payload;
  Input.acceptMouseAck({ inputType: 'mouse', schemaVersion: 2, leaseEpoch: 3, status: 'applied', appliedSeq: downPayload.seq, inputIds: downPayload.inputIds });
  assert.equal(Input.getMobileSurfaceContextSnapshot().state, 'pending');
  Input.acceptMouseAck({ inputType: 'mouse', schemaVersion: 2, leaseEpoch: 3, status: 'applied', appliedSeq: upPayload.seq, inputIds: upPayload.inputIds });
  assert.equal(Input.getMobileSurfaceContextSnapshot().state, 'settled');
});

test('surface pending without draft does not render an unsent-text status', () => {
  const { Input, context, elements } = loadInput();
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const status = elements.get('mobileInputStatus');
  const adapter = Input.mobileTextInputAdapter;

  Input._mobileSurfaceState = 'pending';
  adapter.refreshDeliveryState();
  const emptyPending = adapter.getSnapshot();
  assert.equal(emptyPending.status, 'pending');
  assert.equal(emptyPending.hasPending, false);
  assert.equal(emptyPending.composing, false);
  assert.equal(emptyPending.deliveryUncertain, false);
  assert.equal(status.hidden, true);

  const mobileInput = elements.get('mobileTextInput');
  mobileInput.value = 'draft';
  mobileInput.listeners.get('input')({ target: mobileInput });
  assert.equal(adapter.getSnapshot().hasPending, true);
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, '有未发送内容');
});

test('surface confirmation correlates a late down ACK after cumulative up cleanup', () => {
  const { Input, context, elements, socketEvents } = loadInput();
  loadTouchAdapter(context);
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const adapter = Input.bindTouchAdapter(elements.get('remoteVideo'));
  const id = adapter.clickButton('left', { relX: 0.4, relY: 0.4 });
  assert.ok(id);
  const writes = socketEvents.filter(({ event, payload }) => event === 'input' && payload.type === 'mouse');
  const down = writes.find(({ payload }) => payload.action === 'down').payload;
  const up = writes.find(({ payload }) => payload.action === 'up').payload;

  Input.acceptMouseAck({
    inputType: 'mouse', schemaVersion: 2, leaseEpoch: 3, status: 'applied',
    appliedSeq: up.seq, inputIds: up.inputIds,
  });
  assert.equal(Input.getMobileSurfaceContextSnapshot().state, 'pending');
  Input.acceptMouseAck({
    inputType: 'mouse', schemaVersion: 2, leaseEpoch: 3, status: 'applied',
    appliedSeq: up.seq, inputIds: down.inputIds,
  });

  assert.equal(Input.getMobileSurfaceContextSnapshot().state, 'settled');
});

test('surface confirmation ignores stale generation and lease acknowledgements', () => {
  const { Input, context, elements, socketEvents } = loadInput();
  loadTouchAdapter(context);
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const adapter = Input.bindTouchAdapter(elements.get('remoteVideo'));
  assert.ok(adapter.clickButton('left', { relX: 0.4, relY: 0.4 }));
  const firstWrites = socketEvents.filter(({ event, payload }) => event === 'input'
    && payload.type === 'mouse');
  const oldDown = firstWrites.find(({ payload }) => payload.action === 'down').payload;
  const oldUp = firstWrites.find(({ payload }) => payload.action === 'up').payload;
  Input._resetMobileSurfaceContext();
  assert.ok(adapter.clickButton('left', { relX: 0.5, relY: 0.5 }));
  const currentWrites = socketEvents.filter(({ event, payload }) => event === 'input'
    && payload.type === 'mouse');
  const currentDown = currentWrites.at(-2).payload;
  const currentUp = currentWrites.at(-1).payload;

  Input.acceptMouseAck({
    inputType: 'mouse', schemaVersion: 2, leaseEpoch: 2, status: 'applied',
    appliedSeq: oldUp.seq, inputIds: oldUp.inputIds,
  });
  Input.acceptMouseAck({
    inputType: 'mouse', schemaVersion: 2, leaseEpoch: 3, status: 'applied',
    appliedSeq: oldUp.seq, inputIds: oldDown.inputIds,
  });
  assert.equal(Input.getMobileSurfaceContextSnapshot().state, 'pending');

  Input.acceptMouseAck({
    inputType: 'mouse', schemaVersion: 2, leaseEpoch: 3, status: 'applied',
    appliedSeq: currentDown.seq, inputIds: currentDown.inputIds,
  });
  Input.acceptMouseAck({
    inputType: 'mouse', schemaVersion: 2, leaseEpoch: 3, status: 'applied',
    appliedSeq: currentUp.seq, inputIds: currentUp.inputIds,
  });
  assert.equal(Input.getMobileSurfaceContextSnapshot().state, 'settled');
});

test('document physical keydown uses the pending mobile surface gate', () => {
  const { Input, context, elements, documentListeners, socketEvents } = loadInput();
  loadTouchAdapter(context);
  activate(Input, context);
  Input.setupEventListeners();
  Input.setupTextInput();
  const adapter = Input.bindTouchAdapter(elements.get('remoteVideo'));
  assert.ok(adapter.clickButton('left', { relX: 0.4, relY: 0.4 }));
  const before = socketEvents.length;

  documentListeners.get('keydown')(keyboard('keydown', {
    code: 'KeyA', key: 'a',
    target: { tagName: 'VIDEO', isContentEditable: false, closest: () => null },
  }));

  assert.equal(socketEvents.slice(before).some(({ event, payload }) => event === 'input'
    && (payload.action === 'key' || payload.action === 'batch')), false);
  assert.equal(Input.keyboardController.getSnapshot().pressedKeyCount, 0);
});

test('document tracked keyup remains a safety release while the surface is pending', () => {
  const { Input, context, elements, documentListeners, socketEvents } = loadInput();
  loadTouchAdapter(context);
  activate(Input, context);
  Input.setupEventListeners();
  Input.setupTextInput();
  const video = elements.get('remoteVideo');
  documentListeners.get('keydown')(keyboard('keydown', {
    code: 'ShiftLeft', key: 'Shift', shiftKey: true,
    target: { tagName: 'VIDEO', isContentEditable: false, closest: () => null },
  }));
  assert.equal(Input.keyboardController.getSnapshot().pressedKeyCount, 1);
  assert.ok(Input.bindTouchAdapter(video).clickButton('left', { relX: 0.4, relY: 0.4 }));

  documentListeners.get('keyup')(keyboard('keyup', {
    code: 'ShiftLeft', key: 'Shift',
    target: { tagName: 'VIDEO', isContentEditable: false, closest: () => null },
  }));

  assert.equal(Input.keyboardController.getSnapshot().pressedKeyCount, 0);
  assert.deepEqual(socketEvents.filter(({ event, payload }) => event === 'input'
    && payload.type === 'keyboard' && payload.action === 'key')
    .map(({ payload }) => payload.payload.phase), ['down', 'up']);
});

test('surface-user focus preflight preserves composing mobile text and prevents click default', () => {
  const { Input, context, elements } = loadInput();
  activate(Input, context);
  Input.setupEventListeners();
  Input.setupTextInput();
  const surface = elements.get('remoteVideo');
  const mobileInput = elements.get('mobileTextInput');
  surface.focus = () => { context.document.activeElement = surface; };
  mobileInput.focus = () => { context.document.activeElement = mobileInput; };
  Input.mobileTextInputAdapter.show();
  mobileInput.listeners.get('compositionstart')({ target: mobileInput });

  let clickPrevented = false;
  surface.listeners.get('click')({ preventDefault() { clickPrevented = true; } });
  assert.equal(clickPrevented, true);
  assert.equal(context.document.activeElement, mobileInput);

  let pointerPrevented = false;
  surface.listeners.get('pointerdown')({
    pointerType: 'mouse', pointerId: 1, clientX: 40, clientY: 40, button: 0, buttons: 1,
    currentTarget: surface, preventDefault() { pointerPrevented = true; },
  });
  assert.equal(pointerPrevented, true);
  assert.equal(context.document.activeElement, mobileInput);
});

test('touch surface preflight prevents default before a composing gesture is consumed', () => {
  const { Input, context, elements } = loadInput();
  loadTouchAdapter(context);
  activate(Input, context);
  Input.setupEventListeners();
  Input.setupTextInput();
  const surface = elements.get('remoteVideo');
  const mobileInput = elements.get('mobileTextInput');
  Input.mobileTextInputAdapter.show();
  mobileInput.listeners.get('compositionstart')({ target: mobileInput });

  let prevented = false;
  surface.listeners.get('pointerdown')({
    pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: 40, clientY: 40,
    buttons: 1, preventDefault() { prevented = true; },
  });

  assert.equal(prevented, true);
  assert.equal(context.document.activeElement, mobileInput);
});

test('virtual modifier off uses controller truth through pending and disabled gates', () => {
  for (const gate of ['pending', 'composing', 'uncertain']) {
    const { Input, context, elements, socketEvents } = loadInput();
    context.navigator.maxTouchPoints = 1;
    activate(Input, context);
    Input.setupTextInput();
    const button = makeElement();
    button.dataset.mobileAction = 'shift';
    button.disabled = true;
    const aria = new Map([['aria-pressed', 'false']]);
    button.setAttribute = (name, value) => aria.set(name, String(value));
    button.getAttribute = (name) => aria.get(name) || null;
    context.document.querySelectorAll = () => [button];
    Input.setupActionButtons();
    assert.equal(Input.keyboardController.setVirtualModifier('shift', true), true, gate);
    if (gate === 'pending') Input._mobileSurfaceState = 'pending';
    if (gate === 'composing') elements.get('mobileTextInput').listeners.get('compositionstart')({
      target: elements.get('mobileTextInput'),
    });
    if (gate === 'uncertain') Input.mobileTextInputAdapter.onTransportState('reacquire-required');

    button.listeners.get('click')({ preventDefault() {} });

    assert.equal(Input.keyboardController.getSnapshot().virtualModifiers.length, 0, gate);
    assert.equal(socketEvents.filter(({ event, payload }) => event === 'input'
      && payload.type === 'keyboard' && payload.action === 'key'
      && payload.payload.phase === 'up').length, 1, gate);
  }
});

test('new virtual modifier remains denied while the surface is pending', () => {
  const { Input, context, elements, socketEvents } = loadInput();
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const button = makeElement();
  button.dataset.mobileAction = 'shift';
  context.document.querySelectorAll = () => [button];
  Input.setupActionButtons();
  Input._mobileSurfaceState = 'pending';
  button.listeners.get('click')({ preventDefault() {} });

  assert.equal(Input.keyboardController.getSnapshot().virtualModifiers.length, 0);
  assert.equal(socketEvents.some(({ event, payload }) => event === 'input'
    && payload.type === 'keyboard'), false);
});

test('new virtual modifier remains denied when the desktop capability is inactive', () => {
  const { Input, context, socketEvents } = loadInput();
  activate(Input, context);
  const button = makeElement();
  button.dataset.mobileAction = 'shift';
  context.document.querySelectorAll = () => [button];
  Input.setupActionButtons();
  Input.setActive(false, { resetKeyboard: false });
  button.listeners.get('click')({ preventDefault() {} });

  assert.equal(Input.keyboardController.getSnapshot().virtualModifiers.length, 0);
  assert.equal(socketEvents.some(({ event, payload }) => event === 'input'
    && payload.type === 'keyboard'), false);
});

test('surface failure blocks text and keeps a keyboard reset ACK from clearing the veto', () => {
  const { Input, context, elements, socketEvents } = loadInput();
  loadTouchAdapter(context);
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const adapter = Input.bindTouchAdapter(elements.get('remoteVideo'));
  const id = adapter.clickButton('right', { relX: 0.4, relY: 0.4 });
  assert.ok(id);
  const down = socketEvents.filter(({ event, payload }) => event === 'input' && payload.type === 'mouse' && payload.action === 'down').at(-1).payload;
  const surfaceAck = Input.acceptMouseAck({
    inputType: 'mouse', schemaVersion: 2, leaseEpoch: 3, status: 'execution-failed', appliedSeq: 0,
    inputIds: down.inputIds,
  });
  assert.equal(surfaceAck.status, 'execution-failed');
  assert.equal(Input.getMobileSurfaceContextSnapshot().state, 'uncertain');

  const mobileInput = elements.get('mobileTextInput');
  mobileInput.value = 'draft';
  mobileInput.listeners.get('input')({ target: mobileInput });
  assert.equal(socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'text').length, 0);

  Input.resetKeyboard('cross-ack');
  const reset = socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'reset').at(-1).payload;
  Input.acceptKeyboardAck({
    schemaVersion: 2, leaseEpoch: 3, status: 'applied', appliedSeq: reset.seq, inputIds: reset.inputIds,
  });
  assert.equal(Input.getMobileSurfaceContextSnapshot().state, 'uncertain');
  assert.equal(Input.mobileTextInputAdapter.getSnapshot().deliveryUncertain, true);
  assert.equal(Input.mobileTextInputAdapter.retryPending(), false);
});

test('surface ACK timeout remains uncertain after a late matching ACK', () => {
  withFakeTimers((callbacks) => {
    const { Input, context, elements, socketEvents } = loadInput();
    loadTouchAdapter(context);
    context.navigator.maxTouchPoints = 1;
    activate(Input, context);
    Input.setupTextInput();
    const adapter = Input.bindTouchAdapter(elements.get('remoteVideo'));
    const id = adapter.clickButton('left', { relX: 0.4, relY: 0.4 });
    assert.ok(id);
    const writes = socketEvents.filter(({ event, payload }) => event === 'input' && payload.type === 'mouse');
    const down = writes.find(({ payload }) => payload.action === 'down').payload;
    const up = writes.find(({ payload }) => payload.action === 'up').payload;
    callbacks.at(-1)?.();
    assert.equal(Input.getMobileSurfaceContextSnapshot().state, 'uncertain');
    Input.acceptMouseAck({ inputType: 'mouse', schemaVersion: 2, leaseEpoch: 3, status: 'applied', appliedSeq: down.seq, inputIds: down.inputIds });
    Input.acceptMouseAck({ inputType: 'mouse', schemaVersion: 2, leaseEpoch: 3, status: 'applied', appliedSeq: up.seq, inputIds: up.inputIds });
    assert.equal(Input.getMobileSurfaceContextSnapshot().state, 'uncertain');
  });
});

test('surface confirmation does not timeout a long drag after down ACK', () => {
  withFakeTimers((callbacks) => {
    const { Input, context, elements, socketEvents } = loadInput();
    activate(Input, context);
    Input.setupTextInput();
    const surface = elements.get('remoteVideo');
    Input.bindMouseEvents(surface);
    surface.listeners.get('pointerdown')({
      pointerType: 'mouse', pointerId: 9, clientX: 40, clientY: 40, button: 0, buttons: 1,
      currentTarget: surface, preventDefault() {}, timeStamp: 1,
    });
    const down = socketEvents.filter(({ event, payload }) => event === 'input'
      && payload.type === 'mouse' && payload.action === 'down').at(-1).payload;
    Input.acceptMouseAck({
      inputType: 'mouse', schemaVersion: 2, leaseEpoch: 3, status: 'applied',
      appliedSeq: down.seq, inputIds: down.inputIds,
    });

    callbacks[0]?.();
    assert.equal(Input.getMobileSurfaceContextSnapshot().state, 'pending');
  });
});

test('surface confirmation starts a fresh up timeout after down ACK', () => {
  withFakeTimers((callbacks) => {
    const { Input, context, elements, socketEvents } = loadInput();
    loadTouchAdapter(context);
    context.navigator.maxTouchPoints = 1;
    activate(Input, context);
    Input.setupTextInput();
    const adapter = Input.bindTouchAdapter(elements.get('remoteVideo'));
    assert.ok(adapter.clickButton('left', { relX: 0.4, relY: 0.4 }));
    const writes = socketEvents.filter(({ event, payload }) => event === 'input' && payload.type === 'mouse');
    const down = writes.find(({ payload }) => payload.action === 'down').payload;

    Input.acceptMouseAck({
      inputType: 'mouse', schemaVersion: 2, leaseEpoch: 3, status: 'applied',
      appliedSeq: down.seq, inputIds: down.inputIds,
    });
    assert.equal(callbacks[0], null);
    assert.equal(callbacks[1], null);
    assert.equal(typeof callbacks.at(-1), 'function');
    assert.equal(Input.getMobileSurfaceContextSnapshot().state, 'pending');
    callbacks.at(-1)?.();
    assert.equal(Input.getMobileSurfaceContextSnapshot().state, 'uncertain');
  });
});

test('mouse reset during surface confirmation cancels the generation without rearming draft', () => {
  withFakeTimers((callbacks) => {
    const { Input, context, elements, socketEvents } = loadInput();
    activate(Input, context);
    Input.setupTextInput();
    const surface = elements.get('remoteVideo');
    Input.bindMouseEvents(surface);
    surface.listeners.get('pointerdown')({
      pointerType: 'mouse', pointerId: 9, clientX: 40, clientY: 40, button: 0, buttons: 1,
      currentTarget: surface, preventDefault() {}, timeStamp: 1,
    });
    assert.equal(Input.getMobileSurfaceContextSnapshot().state, 'pending');
    const mobileInput = elements.get('mobileTextInput');
    mobileInput.value = 'draft';
    mobileInput.listeners.get('input')({ target: mobileInput });
    const generation = Input.getMobileSurfaceContextSnapshot().generation;

    Input.releasePointer('reset-while-pending');

    const surfaceSnapshot = Input.getMobileSurfaceContextSnapshot();
    assert.equal(surfaceSnapshot.state, 'uncertain');
    assert.notEqual(surfaceSnapshot.generation, generation);
    assert.equal(Input.mobileTextInputAdapter.getSnapshot().deliveryUncertain, true);
    assert.equal(Input.mobileTextInputAdapter.retryPending(), false);
    callbacks.at(-1)?.();
    assert.equal(Input.getMobileSurfaceContextSnapshot().state, 'uncertain');
    assert.equal(socketEvents.filter(({ payload }) => payload.action === 'text').length, 0);
  });
});

test('text entered during surface confirmation waits for explicit retry after settlement', () => {
  const { Input, context, elements, socketEvents } = loadInput();
  loadTouchAdapter(context);
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const adapter = Input.bindTouchAdapter(elements.get('remoteVideo'));
  const id = adapter.clickButton('left', { relX: 0.4, relY: 0.4 });
  assert.ok(id);
  const mobileInput = elements.get('mobileTextInput');
  mobileInput.value = 'draft';
  mobileInput.listeners.get('input')({ target: mobileInput });
  assert.equal(socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'text').length, 0);
  const writes = socketEvents.filter(({ event, payload }) => event === 'input' && payload.type === 'mouse');
  for (const { payload } of writes) {
    Input.acceptMouseAck({ inputType: 'mouse', schemaVersion: 2, leaseEpoch: 3, status: 'applied', appliedSeq: payload.seq, inputIds: payload.inputIds });
  }
  assert.equal(Input.getMobileSurfaceContextSnapshot().state, 'settled');
  assert.equal(Input.mobileTextInputAdapter.retryPending(), true);
  assert.equal(socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'text').at(-1).payload.payload.text, 'draft');
});

test('mouse and pen surface downs use the same pending ACK gate', () => {
  for (const pointerType of ['mouse', 'pen']) {
    const { Input, context, elements, socketEvents } = loadInput();
    activate(Input, context);
    const surface = elements.get('remoteVideo');
    Input.bindMouseEvents(surface);
    const pointer = (type, buttons) => surface.listeners.get(type)({
      pointerType, pointerId: 7, clientX: 40, clientY: 40, button: 0, buttons,
      currentTarget: surface, preventDefault() {}, timeStamp: 1,
    });
    pointer('pointerdown', 1);
    assert.equal(Input.getMobileSurfaceContextSnapshot().state, 'pending', pointerType);
    pointer('pointerup', 0);
    const writes = socketEvents.filter(({ event, payload }) => event === 'input' && payload.type === 'mouse');
    for (const { payload } of writes) {
      Input.acceptMouseAck({ inputType: 'mouse', schemaVersion: 2, leaseEpoch: 3, status: 'applied', appliedSeq: payload.seq, inputIds: payload.inputIds });
    }
    assert.equal(Input.getMobileSurfaceContextSnapshot().state, 'settled', pointerType);
  }
});

test('ordinary ACK-pending typing remains continuous instead of serializing each character', () => {
  const { Input, context, elements, socketEvents } = loadInput();
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const mobileInput = elements.get('mobileTextInput');
  mobileInput.value = 'a';
  mobileInput.listeners.get('input')({ target: mobileInput });
  mobileInput.value = 'ab';
  mobileInput.listeners.get('input')({ target: mobileInput });
  const textPayloads = socketEvents
    .filter(({ event, payload }) => event === 'input' && payload.action === 'text')
    .map(({ payload }) => payload.payload.text);
  assert.deepEqual(textPayloads, ['a', 'b']);
  assert.equal(Input.keyboardTransport.getSnapshot().pendingCount, 2);
  assert.equal(Input.mobileTextInputAdapter.getSnapshot().hasPending, false);
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

test('lease replacement clears the mobile dock DOM before controller lease mutation', () => {
  const { Input, context, elements } = loadInput();
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const mobileInput = elements.get('mobileTextInput');
  const mobileDock = elements.get('mobileInputDock');
  const mobileButton = elements.get('mobileTextInputBtn');
  const aria = new Map();
  mobileButton.setAttribute = (name, value) => aria.set(name, String(value));
  mobileButton.getAttribute = (name) => aria.get(name) || null;
  mobileInput.value = 'draft';
  mobileInput.listeners.get('input')({ target: mobileInput });
  mobileDock.hidden = false;
  context.document.body.classList.add('mobile-input-visible');
  mobileButton.setAttribute('aria-pressed', 'true');
  Input._mobileTextReturnFocus = elements.get('remoteVideo');

  Input.setControlLease({ leaseId: 'lease-000000000009', leaseEpoch: 9 });
  assert.equal(mobileDock.hidden, true);
  assert.equal(context.document.body.classList.contains('mobile-input-visible'), false);
  assert.equal(mobileButton.getAttribute('aria-pressed'), 'false');
  assert.equal(Input._mobileTextReturnFocus, null);
  assert.equal(mobileInput.value, '\u200b');
});

test('lease epoch change and revoke/regrant cannot resume an old scheduled draft drain', () => {
  withFakeTimers((callbacks) => {
    const { Input, context, elements, socketEvents } = loadInput();
    context.navigator.maxTouchPoints = 1;
    activate(Input, context);
    Input.setupTextInput();
    const mobileInput = elements.get('mobileTextInput');
    const mobileDock = elements.get('mobileInputDock');
    const mobileButton = elements.get('mobileTextInputBtn');
    const aria = new Map();
    mobileButton.setAttribute = (name, value) => aria.set(name, String(value));
    mobileButton.getAttribute = (name) => aria.get(name) || null;
    mobileInput.value = 'abcdefghijklmnopqr';
    mobileInput.listeners.get('input')({ target: mobileInput });
    mobileDock.hidden = false;
    context.document.body.classList.add('mobile-input-visible');
    mobileButton.setAttribute('aria-pressed', 'true');
    mobileInput.value = '\u200b';
    mobileInput.listeners.get('input')({ target: mobileInput });
    const oldCallback = callbacks[0];
    assert.equal(typeof oldCallback, 'function');
    const sentBeforeLeaseChange = socketEvents.length;

    Input.setControlLease({ leaseId: 'lease-000000000001', leaseEpoch: 4 });
    assert.equal(mobileDock.hidden, true);
    assert.equal(context.document.body.classList.contains('mobile-input-visible'), false);
    assert.equal(mobileButton.getAttribute('aria-pressed'), 'false');
    oldCallback?.();
    assert.equal(socketEvents.length, sentBeforeLeaseChange);

    Input.setControlLease(null);
    Input.setControlLease({ leaseId: 'lease-000000000001', leaseEpoch: 5 });
    oldCallback?.();
    assert.equal(socketEvents.length, sentBeforeLeaseChange);
    assert.equal(Input.mobileTextInputAdapter.getSnapshot().hasPending, false);
  });
});

test('context uncertainty cancels retries, blocks reacquire sends, and exposes discard recovery UI', () => {
  const { Input, context, elements, socketEvents } = loadInput();
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const mobileInput = elements.get('mobileTextInput');
  const status = elements.get('mobileInputStatus');
  const retry = elements.get('mobileInputRetryBtn');
  const discard = elements.get('mobileInputDiscardBtn');

  mobileInput.value = 'a';
  mobileInput.listeners.get('input')({ target: mobileInput });
  const first = socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'text').at(-1).payload;
  Input.acceptKeyboardAck({ schemaVersion: 2, leaseEpoch: 3, status: 'applied', appliedSeq: first.seq, inputIds: first.inputIds });
  const beforeBlocked = socketEvents.length;
  Input.mobileTextInputAdapter.onTransportState('blocked');
  mobileInput.value = 'ab';
  mobileInput.listeners.get('input')({ target: mobileInput });
  assert.equal(socketEvents.length, beforeBlocked, 'blocked context retains the local draft');
  let snapshot = Input.mobileTextInputAdapter.getSnapshot();
  assert.equal(snapshot.hasPending, true);
  assert.equal(snapshot.deliveryUncertain, true);

  Input.mobileTextInputAdapter.onTransportState('ready');
  assert.equal(socketEvents.length, beforeBlocked, 'ready does not implicitly retry a rejected draft');
  assert.equal(Input.mobileTextInputAdapter.retryPending(), false);
  assert.equal(socketEvents.length, beforeBlocked, 'ready does not restore a blocked context');

  discard.listeners.get('click')({ preventDefault() {} });
  snapshot = Input.mobileTextInputAdapter.getSnapshot();
  assert.equal(snapshot.hasPending, false);
  assert.equal(snapshot.deliveryUncertain, false);
  mobileInput.value = 'fresh';
  mobileInput.listeners.get('input')({ target: mobileInput });
  assert.equal(socketEvents.length, beforeBlocked + 1, 'discard permits a new explicit input');

  const second = socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'text').at(-1).payload;
  Input.acceptKeyboardAck({ schemaVersion: 2, leaseEpoch: 3, status: 'applied', appliedSeq: second.seq, inputIds: second.inputIds });
  const beforeUncertain = socketEvents.length;
  Input.mobileTextInputAdapter.onTransportState('reacquire-required');
  Input.mobileTextInputAdapter.onTransportState('ready');
  snapshot = Input.mobileTextInputAdapter.getSnapshot();
  assert.equal(snapshot.hasPending, false);
  assert.equal(snapshot.deliveryUncertain, true);
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /连接/);
  assert.equal(retry.hidden, true);
  assert.equal(discard.hidden, false);
  mobileInput.value = 'abc';
  mobileInput.listeners.get('input')({ target: mobileInput });
  assert.equal(socketEvents.length, beforeUncertain);
  snapshot = Input.mobileTextInputAdapter.getSnapshot();
  assert.equal(snapshot.deliveryUncertain, true);
  assert.equal(snapshot.hasPending, true);
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /连接/);
  assert.equal(retry.hidden, false);
  assert.equal(retry.disabled, true);
  assert.equal(discard.hidden, false);

  discard.listeners.get('click')({ preventDefault() {} });
  snapshot = Input.mobileTextInputAdapter.getSnapshot();
  assert.equal(snapshot.deliveryUncertain, false);
  assert.equal(snapshot.hasPending, false);
  assert.equal(status.hidden, true);
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

test('owned keyboard reset ACK preserves lifecycle content until empty context is confirmed', () => {
  const { Input, context, elements, socketEvents } = loadInput();
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const mobileInput = elements.get('mobileTextInput');
  const mobileButton = elements.get('mobileTextInputBtn');
  mobileInput.value = 'old';
  mobileInput.listeners.get('input')({ target: mobileInput });
  Input.resetKeyboard('owned-reset');

  const reset = socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'reset').at(-1).payload;
  assert.ok(reset);
  assert.equal(mobileInput.value, 'old\u200b');
  assert.equal(Input.mobileTextInputAdapter.getSnapshot().deliveryUncertain, true);
  assert.deepEqual(socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'text')
    .map(({ payload }) => payload.payload.text), ['old']);

  const ackResult = Input.acceptKeyboardAck({
    schemaVersion: 2,
    leaseEpoch: 3,
    status: 'applied',
    appliedSeq: reset.seq,
    inputIds: reset.inputIds,
  });
  assert.equal(ackResult.status, 'applied');
  assert.equal(Input.mobileTextInputAdapter.getSnapshot().deliveryUncertain, false);
  mobileButton.listeners.get('click')({ preventDefault() {} });
  mobileInput.value = 'fresh';
  mobileInput.listeners.get('input')({ target: mobileInput });
  assert.deepEqual(socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'text')
    .map(({ payload }) => payload.payload.text), ['old', 'fresh']);
});

test('owned reset ACK preserves a new draft until the mouse reset also confirms', () => {
  const { Input, context, elements, socketEvents } = loadInput();
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const mobileInput = elements.get('mobileTextInput');
  mobileInput.value = 'old';
  mobileInput.listeners.get('input')({ target: mobileInput });
  Input.resetKeyboard('owned-reset-with-draft');
  const reset = socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'reset').at(-1).payload;

  mobileInput.value = 'during-reset';
  mobileInput.listeners.get('input')({ target: mobileInput });
  const textBeforeAck = socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'text')
    .map(({ payload }) => payload.payload.text);
  assert.deepEqual(textBeforeAck, ['old']);
  assert.equal(Input.mobileTextInputAdapter.getSnapshot().hasPending, true);

  Input.acceptKeyboardAck({
    schemaVersion: 2,
    leaseEpoch: 3,
    status: 'applied',
    appliedSeq: reset.seq,
    inputIds: reset.inputIds,
  });
  assert.equal(mobileInput.value, 'during-reset');
  assert.equal(Input.mobileTextInputAdapter.getSnapshot().deliveryUncertain, true);
  assert.equal(socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'text').length, 1);
  assert.equal(Input.mobileTextInputAdapter.retryPending(), false);
  assert.deepEqual(socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'text')
    .map(({ payload }) => payload.payload.text), ['old']);
});

test('failed or stale owned reset ACKs keep mobile input fail-closed', () => {
  for (const status of ['stale', 'execution-failed']) {
    const { Input, context, elements, socketEvents } = loadInput();
    context.navigator.maxTouchPoints = 1;
    activate(Input, context);
    Input.setupTextInput();
    const mobileInput = elements.get('mobileTextInput');
    mobileInput.value = 'old';
    mobileInput.listeners.get('input')({ target: mobileInput });
    Input.resetKeyboard(`owned-reset-${status}`);
    const reset = socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'reset').at(-1).payload;
    const ack = {
      schemaVersion: 2,
      leaseEpoch: status === 'stale' ? 999 : 3,
      status,
      appliedSeq: reset.seq,
      inputIds: reset.inputIds,
    };
    const result = Input.acceptKeyboardAck(ack);
    assert.equal(result.status, status === 'stale' ? 'stale' : 'reacquire-required', status);
    Input.mobileTextInputAdapter.onTransportState('ready');
    mobileInput.value = 'after-failure';
    mobileInput.listeners.get('input')({ target: mobileInput });
    assert.equal(socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'text').length, 1, status);
    assert.equal(Input.mobileTextInputAdapter.getSnapshot().deliveryUncertain, true, status);
    assert.equal(Input.mobileTextInputAdapter.retryPending(), false, status);
  }
});

test('park preserves mobile draft without a reset barrier until explicit discard', () => {
  const { Input, context, elements, socketEvents } = loadInput();
  context.navigator.maxTouchPoints = 1;
  activate(Input, context);
  Input.setupTextInput();
  const mobileInput = elements.get('mobileTextInput');
  const mobileButton = elements.get('mobileTextInputBtn');
  mobileInput.value = 'old';
  mobileInput.listeners.get('input')({ target: mobileInput });
  const eventsBeforePark = socketEvents.length;
  Input.parkKeyboard('visibility-hidden');
  assert.equal(socketEvents.length, eventsBeforePark);
  assert.equal(socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'reset').length, 0);
  assert.equal(mobileInput.value, 'old\u200b');

  mobileButton.listeners.get('click')({ preventDefault() {} });
  mobileInput.value = 'fresh';
  mobileInput.listeners.get('input')({ target: mobileInput });
  assert.deepEqual(socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'text')
    .map(({ payload }) => payload.payload.text), ['old']);
  elements.get('mobileInputDiscardBtn').listeners.get('click')({ preventDefault() {} });
  mobileInput.value = 'fresh';
  mobileInput.listeners.get('input')({ target: mobileInput });
  assert.deepEqual(socketEvents.filter(({ event, payload }) => event === 'input' && payload.action === 'text')
    .map(({ payload }) => payload.payload.text), ['old', 'fresh']);
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

test('diagnostic input state uses bounded enums and never copies arbitrary source fields', () => {
  const { Input, context } = loadInput();
  Input.keyboardController = {
    getSnapshot: () => ({
      mode: 'MODE_CANARY', state: 'STATE_CANARY', pressedKeyCount: Number.MAX_SAFE_INTEGER,
    }),
  };
  Input.keyboardTransport = {
    getSnapshot: () => ({
      adapter: 'ADAPTER_CANARY', epoch: -1, lastSent: Number.MAX_SAFE_INTEGER,
      lastApplied: 'not-a-number', pendingCount: 9999,
    }),
  };
  Input.lastKeyboardResetReason = 'RESET_REASON_CANARY';
  Input._mobileSurfaceState = 'SURFACE_STATE_CANARY';
  Input._mobileSurfaceGeneration = Number.MAX_SAFE_INTEGER;
  Input._recoveryCycle = {
    ...Input._recoveryCycle,
    state: 'RECOVERY_STATE_CANARY', reason: 'RECOVERY_REASON_CANARY', generation: Number.MAX_SAFE_INTEGER,
  };
  Input._desktopWriteRecovery = {
    state: 'WRITE_STATE_CANARY', status: 'WRITE_STATUS_CANARY', appliedSeq: Number.MAX_SAFE_INTEGER,
  };
  context.WebRTC.getDesktopInputGateSnapshot = () => ({
    enabled: true, hasActiveControl: true, manualDisconnect: false,
    mediaState: 'MEDIA_STATE_CANARY', runtimePhase: 'RUNTIME_PHASE_CANARY', inputIsActive: true,
    blockedReasons: ['BLOCKED_REASON_CANARY'],
  });

  const state = Input.getDiagnosticState();
  const json = JSON.stringify(state);
  for (const canary of [
    'MODE_CANARY', 'STATE_CANARY', 'ADAPTER_CANARY', 'RESET_REASON_CANARY',
    'SURFACE_STATE_CANARY', 'RECOVERY_STATE_CANARY', 'RECOVERY_REASON_CANARY',
    'WRITE_STATE_CANARY', 'WRITE_STATUS_CANARY', 'MEDIA_STATE_CANARY',
    'RUNTIME_PHASE_CANARY', 'BLOCKED_REASON_CANARY',
  ]) {
    assert.equal(json.includes(canary), false, canary);
  }
  assert.equal(state.keyboard.epoch, 0);
  assert.equal(state.keyboard.lastSent, 0x7fffffff);
  assert.equal(state.keyboard.pendingCount, 256);
  assert.equal(state.surface.state, 'settled');
  assert.equal(state.recovery.state, 'idle');
  assert.equal(state.gate.mediaState, null);
  assert.deepEqual(JSON.parse(JSON.stringify(state.effectiveGate.blockedReasons)), ['no-active-control']);
});

test('diagnostic reason prefixes require an exact bounded value', () => {
  const { Input, context } = loadInput();
  context.WebRTC.getDesktopInputGateSnapshot = () => ({
    enabled: false,
    hasActiveControl: true,
    manualDisconnect: false,
    mediaState: 'active',
    runtimePhase: 'active',
    inputIsActive: true,
    blockedReasons: [
      'runtime-phase:active',
      'runtime-phase:active:PASSWORD_CANARY',
      'media-state:active',
      'media-state:active:TEXT_CANARY',
      `runtime-phase:active:${'SUFFIX_CANARY'.repeat(100)}`,
    ],
  });

  const state = Input.getDiagnosticState();
  assert.deepEqual(JSON.parse(JSON.stringify(state.gate.blockedReasons)), [
    'runtime-phase:active', 'media-state:active',
  ]);
  const json = JSON.stringify(state);
  for (const canary of ['PASSWORD_CANARY', 'TEXT_CANARY', 'SUFFIX_CANARY']) {
    assert.equal(json.includes(canary), false, canary);
  }
});

test('real keyboard gate rejection traces DOM and gate only', () => {
  const { Input, context, elements, documentListeners, trace } = loadInput();
  Input.videoElement = context.document.getElementById('remoteVideo');
  Input.initKeyboardController();
  Input.setControlLease({ leaseId: 'lease-trace-1', leaseEpoch: 3 });
  Input.setActive(true);
  Input._mobileSurfaceState = 'uncertain';
  Input.setupEventListeners();

  const event = keyboard('keydown', {
    target: elements.get('remoteVideo'),
    key: 'TRACE_KEY_CANARY', code: 'TRACE_CODE_CANARY',
  });
  documentListeners.get('keydown')(event);

  const snapshot = trace.snapshot();
  const gateEvents = snapshot.events.filter(({ stage }) => stage === 'dom-received' || stage === 'gate');
  assert.equal(JSON.stringify(gateEvents.map(({ stage }) => stage)), JSON.stringify(['dom-received', 'gate']));
  assert.equal(gateEvents[0].eventId, gateEvents[1].eventId);
  assert.equal(gateEvents[1].accepted, false);
  assert.equal(gateEvents[1].reason, 'surface-uncertain');
  assert.equal(snapshot.events.some(({ stage }) => stage === 'transport-send'), false);
  const json = JSON.stringify(snapshot);
  assert.doesNotMatch(json, /TRACE_KEY_CANARY|TRACE_CODE_CANARY/);
});

test('real Input sends record DataChannel result, Socket fallback, and receiver ACK status', () => {
  const { Input, context, elements, trace } = loadInput();
  Input.videoElement = context.document.getElementById('remoteVideo');
  Input.initKeyboardController();
  Input.setControlLease({ leaseId: 'lease-trace-2', leaseEpoch: 3 });
  Input.setActive(true);
  context.WebRTC.currentConnectionAttemptId = 'attempt-trace';

  context.WebRTC.sendInput = () => true;
  const dataChannelId = Input.sendInput('mouse', 'down', {
    relX: 0.2, relY: 0.3, button: 'left', buttons: 1,
  });
  context.WebRTC.sendInput = () => false;
  const socketId = Input.sendInput('mouse', 'up', {
    relX: 0.2, relY: 0.3, button: 'left', buttons: 0,
  });
  const transport = trace.snapshot().events.filter(({ stage }) => stage === 'transport-send');
  assert.equal(dataChannelId !== null, true);
  assert.equal(socketId !== null, true);
  assert.equal(JSON.stringify(transport.map(({ transport: path, accepted }) => [path, accepted])), JSON.stringify([
    ['datachannel', true], ['datachannel', false], ['socket', true],
  ]));

  const ack = Input.acceptMouseAck({
    schemaVersion: 2, inputType: 'mouse', leaseEpoch: 3, status: 'applied',
    accepted: false, appliedSeq: 1, inputIds: [dataChannelId],
  });
  assert.equal(ack.status, 'applied');
  const ackEvent = trace.snapshot().events.find(({ stage }) => stage === 'ack');
  assert.equal(ackEvent.status, 'applied');
  assert.equal(ackEvent.accepted, false);
});

test('accepted mobile text records its gate before the real keyboard transport send', () => {
  const { Input, context, elements, trace } = loadInput();
  context.WebRTC.inputChannel = { readyState: 'open' };
  context.WebRTC.sendInput = () => true;
  activate(Input, context);
  Input.setupTextInput();

  const mobileInput = elements.get('mobileTextInput');
  mobileInput.value = 'mobile-gate-canary';
  mobileInput.listeners.get('input')({ type: 'input', target: mobileInput });

  const events = trace.snapshot().events.filter(({ stage }) => (
    stage === 'dom-received' || stage === 'gate' || stage === 'transport-send'
  ));
  assert.deepEqual(JSON.parse(JSON.stringify(events.map(({ stage }) => stage))), [
    'dom-received', 'gate', 'transport-send',
  ]);
  assert.equal(events[1].accepted, true);
  assert.equal(events[1].eventId, events[0].eventId);
  assert.equal(events[2].eventId, events[0].eventId);
  assert.doesNotMatch(JSON.stringify(events), /mobile-gate-canary/);
});

test('physical DOM sends retain nested mobile scope through real ACK correlation', () => {
  const { Input, context, elements, documentListeners, trace } = loadInput();
  const writes = [];
  context.WebRTC.inputChannel = { readyState: 'open' };
  context.WebRTC.sendInput = (payload) => { writes.push(payload); return true; };
  activate(Input, context);
  Input.setupTextInput();
  Input.setupEventListeners();

  const surface = elements.get('remoteVideo');
  const pointer = (type) => surface.listeners.get(type)({
    pointerType: 'mouse', pointerId: 1, button: 0,
    detail: 1, clientX: 40, clientY: 40,
    buttons: type === 'pointerup' ? 0 : 1,
    currentTarget: surface, timeStamp: 10, preventDefault() {},
  });
  pointer('pointerdown');
  pointer('pointerup');
  for (const payload of writes.filter(({ type }) => type === 'mouse')) {
    Input.acceptMouseAck({
      schemaVersion: 2, inputType: 'mouse', leaseEpoch: 3,
      status: 'applied', appliedSeq: payload.seq, inputIds: payload.inputIds,
    });
  }
  documentListeners.get('keydown')(keyboard('keydown', { target: surface }));
  documentListeners.get('keyup')(keyboard('keyup', { target: surface }));

  const sends = trace.snapshot().events.filter(({ stage, accepted, action }) => (
    stage === 'transport-send' && accepted === true && action !== 'reset'
  ));
  assert.equal(sends.length, 4);
  assert.ok(sends.every(({ eventId }) => Number.isSafeInteger(eventId)));

  for (const payload of writes.filter(({ type }) => type === 'keyboard')) {
    Input.acceptKeyboardAck({
      schemaVersion: 2, inputType: 'keyboard', leaseEpoch: 3,
      status: 'applied', appliedSeq: payload.seq, inputIds: payload.inputIds,
    });
  }
  const acks = trace.snapshot().events.filter(({ stage, accepted }) => stage === 'ack' && accepted === true);
  assert.equal(acks.length, 4);
  assert.ok(sends.every((send) => acks.some((ack) => ack.eventId === send.eventId)));
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
