const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function makeElement(id, onFocus = () => {}) {
  const listeners = new Map();
  const classes = new Set();
  const attributes = new Map();
  return {
    id,
    parentNode: null,
    tagName: id === 'mobileTextInput' || id === 'terminalComposer' ? 'TEXTAREA' : 'BUTTON',
    isContentEditable: false,
    inert: false,
    value: '',
    textContent: '',
    hidden: false,
    disabled: false,
    isConnected: true,
    dataset: {},
    listeners,
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      toggle(name, force) {
        const next = force === undefined ? !classes.has(name) : Boolean(force);
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      },
      contains(name) { return classes.has(name); },
    },
    contains(node) { return node === this; },
    focus() {
      onFocus(this);
      this.dispatchEvent('focus', makeEvent(this));
    },
    blur() { onFocus(null, this); },
    addEventListener(type, handler) {
      let dispatcher = listeners.get(type);
      if (!dispatcher) {
        dispatcher = (event = {}) => {
          let result;
          for (const listener of [...dispatcher.handlers]) {
            result = listener(event);
            if (event.immediateStopped) break;
          }
          return result;
        };
        dispatcher.handlers = [];
        listeners.set(type, dispatcher);
      }
      dispatcher.handlers.push(handler);
    },
    removeEventListener(type, handler) {
      const dispatcher = listeners.get(type);
      if (!dispatcher) return;
      dispatcher.handlers = dispatcher.handlers.filter((listener) => listener !== handler);
    },
    dispatchEvent(type, event = {}) {
      const dispatcher = listeners.get(type);
      return dispatcher ? dispatcher(event) : undefined;
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
      this[name] = String(value);
      if (name === 'inert') this.inert = true;
    },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    hasAttribute(name) { return attributes.has(name); },
    removeAttribute(name) {
      attributes.delete(name);
      delete this[name];
      if (name === 'inert') this.inert = false;
    },
    toggleAttribute(name, force) {
      const next = force === undefined ? !attributes.has(name) : Boolean(force);
      if (next) this.setAttribute(name, '');
      else this.removeAttribute(name);
      return next;
    },
  };
}

function makeHarness({ requestFullscreen, exitFullscreen } = {}) {
  const elements = new Map();
  const documentListeners = new Map();
  const bodyClasses = new Set();
  const chromeLayoutCalls = {
    setFullscreenActive: [],
    recalculate: [],
  };
  const timers = new Map();
  const remoteInputEvents = [];
  let nextTimerId = 1;
  let requestedTarget = null;
  let requestCount = 0;
  let exitCount = 0;
  let videoFocusCount = 0;

  const body = makeElement('body');
  body.classList = {
    add(...names) { names.forEach((name) => bodyClasses.add(name)); },
    remove(...names) { names.forEach((name) => bodyClasses.delete(name)); },
    toggle(name, force) {
      const next = force === undefined ? !bodyClasses.has(name) : Boolean(force);
      if (next) bodyClasses.add(name);
      else bodyClasses.delete(name);
      return next;
    },
    contains(name) { return bodyClasses.has(name); },
  };

  const addDocumentListener = (type, handler) => {
    let dispatcher = documentListeners.get(type);
    if (!dispatcher) {
      dispatcher = (event = {}) => {
        let result;
        for (const listener of [...dispatcher.handlers]) result = listener(event);
        return result;
      };
      dispatcher.handlers = [];
      documentListeners.set(type, dispatcher);
    }
    dispatcher.handlers.push(handler);
  };

  const documentElement = {
    requestFullscreen: requestFullscreen || (() => {
      requestedTarget = documentElement;
      requestCount += 1;
      return Promise.resolve();
    }),
  };
  const document = {
    body,
    documentElement,
    fullscreenElement: null,
    activeElement: null,
    addEventListener: addDocumentListener,
    removeEventListener(type, handler) {
      const dispatcher = documentListeners.get(type);
      if (!dispatcher) return;
      dispatcher.handlers = dispatcher.handlers.filter((listener) => listener !== handler);
    },
    getElementById(id) {
      if (!elements.has(id)) {
        const focusTarget = makeElement(id, (element, blurred) => {
          if (element) document.activeElement = element;
          else if (document.activeElement === blurred) document.activeElement = null;
        });
        focusTarget.parentNode = body;
        elements.set(id, focusTarget);
      }
      return elements.get(id);
    },
    querySelector(selector) {
      if (selector === '.viewer-container') {
        if (!elements.has('viewerContainer')) {
          const viewer = makeElement('viewerContainer');
          viewer.parentNode = body;
          elements.set('viewerContainer', viewer);
        }
        return elements.get('viewerContainer');
      }
      return null;
    },
    exitFullscreen() {
      exitCount += 1;
      if (typeof exitFullscreen === 'function') return exitFullscreen(document);
      document.fullscreenElement = null;
      return Promise.resolve();
    },
  };
  body.parentNode = document;
  documentElement.requestFullscreen = function requestFullscreenOnRoot() {
    requestedTarget = documentElement;
    requestCount += 1;
    if (requestFullscreen) return requestFullscreen(document);
    return Promise.resolve();
  };

  const context = {
    console,
    document,
    WebRTC: {},
    ChromeLayout: {
      setFullscreenActive(active, root) {
        chromeLayoutCalls.setFullscreenActive.push({ active, root });
      },
      recalculate(root) {
        chromeLayoutCalls.recalculate.push(root);
      },
    },
    setTimeout(handler, delay) {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, { handler, delay });
      return timerId;
    },
    clearTimeout(timerId) {
      timers.delete(timerId);
    },
    window: {
      innerWidth: 1440,
      innerHeight: 900,
      addEventListener() {},
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__UI = UI;`, context);

  const dispatchBubbling = (element, type) => {
    const event = makeEvent(element);
    let current = element;
    while (current) {
      const dispatcher = current === document
        ? documentListeners.get(type)
        : current.listeners?.get(type);
      const result = dispatcher?.(event);
      if (result && typeof result.then === 'function') event.result = result;
      if (event.stopped || event.immediateStopped) break;
      current = current.parentNode || null;
    }
    return event;
  };

  const fullscreenButton = document.getElementById('fullscreenBtn');
  const exitButton = document.getElementById('exitFullscreenBtn');
  const fullscreenStatus = document.getElementById('fullscreenStatus');
  fullscreenStatus.hidden = true;
  const video = document.getElementById('remoteVideo');
  document.getElementById('mobileTextInput');
  document.getElementById('terminalComposer');
  document.getElementById('statusBar');
  document.getElementById('chromeDocks');
  document.getElementById('terminalPanel');
  document.getElementById('fullscreenExitOverlay');
  document.getElementById('fullscreenExitPanel');
  document.getElementById('fullscreenExitRevealBtn');
  document.getElementById('fullscreenExitStatus');
  video.focus = () => {
    videoFocusCount += 1;
    document.activeElement = video;
  };
  document.getElementById('connectionStatus').textContent = '已连接';

  return {
    context,
    document,
    documentElement,
    elements,
    fullscreenButton,
    exitButton,
    video,
    get requestedTarget() { return requestedTarget; },
    get requestCount() { return requestCount; },
    get exitCount() { return exitCount; },
    get videoFocusCount() { return videoFocusCount; },
    chromeLayoutCalls,
    get pendingTimerCount() { return timers.size; },
    get timerDelays() { return [...timers.values()].map(({ delay }) => delay); },
    remoteInputEvents,
    installGlobalRemoteInputListener(type) {
      document.addEventListener(type, (event) => {
        remoteInputEvents.push({ type, target: event.target });
      });
    },
    dispatchRaw(id, type) {
      const element = elements.get(id) || document.getElementById(id);
      return dispatchBubbling(element, type);
    },
    async click(id) {
      const element = elements.get(id) || document.getElementById(id);
      const handler = element.listeners.get('click');
      assert.equal(typeof handler, 'function', `${id} should have a click listener`);
      const event = dispatchBubbling(element, 'click');
      if (event.result && typeof event.result.then === 'function') await event.result;
      return event;
    },
    pointerDown(id) {
      const element = elements.get(id) || document.getElementById(id);
      const handler = element.listeners.get('pointerdown');
      assert.equal(typeof handler, 'function', `${id} should have a pointerdown listener`);
      return dispatchBubbling(element, 'pointerdown');
    },
    flushTimers() {
      const pending = [...timers.values()];
      timers.clear();
      for (const { handler } of pending) handler();
    },
    dispatchDocument(type) {
      const handler = documentListeners.get(type);
      assert.equal(typeof handler, 'function', `${type} should have a document listener`);
      return dispatchBubbling(document, type);
    },
    resize(width, height) {
      this.context.window.innerWidth = width;
      this.context.window.innerHeight = height;
    },
  };
}

function makeEvent(target) {
  return {
    target,
    prevented: false,
    stopped: false,
    immediateStopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
    stopImmediatePropagation() {
      this.immediateStopped = true;
      this.stopped = true;
    },
  };
}

test('fullscreenchange synchronizes immersive chrome without reusing chrome state', () => {
  const h = makeHarness();
  h.context.__UI.setupControlButtons();
  h.chromeLayoutCalls.setFullscreenActive.length = 0;
  h.chromeLayoutCalls.recalculate.length = 0;
  h.document.body.classList.add('controls-hidden', 'chrome-idle', 'more-open');

  h.document.fullscreenElement = h.document.documentElement;
  h.dispatchDocument('fullscreenchange');

  assert.equal(h.document.body.classList.contains('fullscreen-active'), true);
  assert.equal(h.document.body.classList.contains('controls-hidden'), true);
  assert.equal(h.document.body.classList.contains('chrome-idle'), true);
  assert.equal(h.document.body.classList.contains('more-open'), true);
  assert.equal(h.elements.get('statusBar').inert, true);
  assert.equal(h.elements.get('chromeDocks').inert, true);
  assert.deepEqual(h.chromeLayoutCalls.setFullscreenActive.map(({ active }) => active), [true]);
  assert.deepEqual(h.chromeLayoutCalls.recalculate, []);
});

test('fullscreen edge reveal uses an isolated four second panel lifecycle', async () => {
  const h = makeHarness();
  h.context.__UI.setupControlButtons();
  h.chromeLayoutCalls.setFullscreenActive.length = 0;
  h.chromeLayoutCalls.recalculate.length = 0;
  h.document.fullscreenElement = h.document.documentElement;
  h.dispatchDocument('fullscreenchange');

  const panel = h.elements.get('fullscreenExitPanel');
  const revealButton = h.elements.get('fullscreenExitRevealBtn');
  assert.equal(panel.hidden, false);
  assert.equal(revealButton.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(h.timerDelays, [4000]);

  h.flushTimers();
  assert.equal(panel.hidden, true);
  assert.equal(revealButton.getAttribute('aria-expanded'), 'false');

  const pointerDown = h.pointerDown('fullscreenExitRevealBtn');
  assert.equal(pointerDown.prevented, true);
  assert.equal(pointerDown.stopped, true);
  assert.equal(panel.hidden, false);
  assert.equal(h.videoFocusCount, 0);

  const click = await h.click('fullscreenExitRevealBtn');
  assert.equal(click.prevented, true);
  assert.equal(click.stopped, true);
  assert.equal(panel.hidden, false);
  assert.equal(h.videoFocusCount, 0);
});

test('fullscreen reveal handle focus reopens the hidden exit panel', () => {
  const h = makeHarness();
  h.context.__UI.setupControlButtons();
  h.document.fullscreenElement = h.document.documentElement;
  h.dispatchDocument('fullscreenchange');
  h.flushTimers();

  const panel = h.elements.get('fullscreenExitPanel');
  const revealButton = h.elements.get('fullscreenExitRevealBtn');
  revealButton.focus();

  assert.equal(h.document.activeElement, revealButton);
  assert.equal(panel.hidden, false);
  assert.equal(revealButton.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(h.timerDelays, [4000]);
});

test('fullscreen reveal exit preserves Terminal, mobile editor, and lease-loss focus', async () => {
  const scenarios = [
    {
      name: 'mobile editor',
      prepare(h) {
        h.elements.get('mobileTextInput').focus();
        return h.elements.get('mobileTextInput');
      },
    },
    {
      name: 'Terminal composer',
      prepare(h) {
        h.context.document.body.classList.add('terminal-active');
        h.elements.get('terminalPanel').hidden = false;
        h.elements.get('terminalComposer').focus();
        return h.elements.get('terminalComposer');
      },
    },
    {
      name: 'lease loss editor',
      prepare(h) {
        h.context.WebRTC.getDesktopSessionSnapshot = () => ({ canInput: false });
        h.fullscreenButton.disabled = true;
        h.elements.get('mobileTextInput').focus();
        return h.elements.get('mobileTextInput');
      },
    },
  ];

  for (const scenario of scenarios) {
    const h = makeHarness();
    h.context.__UI.setupControlButtons();
    h.document.fullscreenElement = h.document.documentElement;
    h.dispatchDocument('fullscreenchange');
    const focused = scenario.prepare(h);

    h.pointerDown('fullscreenExitRevealBtn');
    const exitEvent = await h.click('exitFullscreenBtn');

    assert.equal(exitEvent.stopped, true, `${scenario.name} exit must stay out of global input handling`);
    assert.equal(h.exitCount, 1, `${scenario.name} should call the exit API`);
    assert.equal(h.document.fullscreenElement, null, `${scenario.name} should exit fullscreen`);
    assert.equal(h.document.activeElement, focused, `${scenario.name} focus should survive exit`);
  }
});

test('fullscreen exit API failures announce in both status surfaces and keep the panel open', async () => {
  const cases = [
    {
      label: 'missing',
      make: () => {
        const h = makeHarness();
        delete h.document.exitFullscreen;
        return h;
      },
    },
    {
      label: 'rejected',
      make: () => makeHarness({ exitFullscreen: () => Promise.reject(new Error('not allowed')) }),
    },
  ];

  for (const { label, make } of cases) {
    const h = make();
    h.context.__UI.setupControlButtons();
    h.document.fullscreenElement = h.document.documentElement;
    h.dispatchDocument('fullscreenchange');
    await h.click('exitFullscreenBtn');
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(h.document.fullscreenElement, h.document.documentElement, `${label} API must retain fullscreen`);
    assert.equal(h.elements.get('fullscreenStatus').hidden, false);
    assert.match(h.elements.get('fullscreenStatus').textContent, /不支持全屏，可继续操作/);
    assert.equal(h.elements.get('fullscreenExitStatus').hidden, false);
    assert.match(h.elements.get('fullscreenExitStatus').textContent, /不支持全屏，可继续操作/);
    assert.equal(h.elements.get('fullscreenExitPanel').hidden, false, `${label} API must keep panel visible`);
  }
});

test('fullscreenchange exit clears reveal timer and restores only UI-owned inert state', () => {
  const h = makeHarness();
  h.context.__UI.setupControlButtons();
  h.chromeLayoutCalls.setFullscreenActive.length = 0;
  h.chromeLayoutCalls.recalculate.length = 0;
  const statusBar = h.elements.get('statusBar');
  const chromeDocks = h.elements.get('chromeDocks');
  statusBar.setAttribute('inert', '');
  h.document.body.classList.add('controls-hidden', 'chrome-idle');

  h.document.fullscreenElement = h.document.documentElement;
  h.dispatchDocument('fullscreenchange');
  assert.equal(statusBar.inert, true);
  assert.equal(chromeDocks.inert, true);
  assert.equal(h.pendingTimerCount, 1);

  h.document.fullscreenElement = null;
  h.dispatchDocument('fullscreenchange');

  assert.equal(h.document.body.classList.contains('fullscreen-active'), false);
  assert.equal(h.document.body.classList.contains('controls-hidden'), true);
  assert.equal(h.document.body.classList.contains('chrome-idle'), true);
  assert.equal(h.elements.get('fullscreenExitPanel').hidden, true);
  assert.equal(h.elements.get('fullscreenExitRevealBtn').getAttribute('aria-expanded'), 'false');
  assert.equal(h.pendingTimerCount, 0);
  assert.equal(statusBar.inert, true);
  assert.equal(statusBar.hasAttribute('inert'), true);
  assert.equal(chromeDocks.inert, false);
  assert.equal(chromeDocks.hasAttribute('inert'), false);
  assert.deepEqual(h.chromeLayoutCalls.setFullscreenActive.map(({ active }) => active), [true, false]);
  assert.deepEqual(h.chromeLayoutCalls.recalculate, []);

  h.flushTimers();
  assert.equal(h.elements.get('fullscreenExitPanel').hidden, true);
});

test('fullscreen uses documentElement and fullscreenchange preserves mobile focus', async () => {
  const h = makeHarness();
  h.context.__UI.setupControlButtons();
  const field = h.elements.get('mobileTextInput');
  field.value = 'draft\u200b';
  field.focus();

  await h.click('fullscreenBtn');

  assert.equal(h.requestedTarget, h.document.documentElement);
  assert.equal(h.requestCount, 1);
  h.document.fullscreenElement = h.document.documentElement;
  h.dispatchDocument('fullscreenchange');
  assert.equal(h.videoFocusCount, 0);
  assert.equal(h.document.activeElement, field);
  assert.equal(h.fullscreenButton.textContent, '退出全屏');
  assert.equal(h.context.document.body.classList.contains('fullscreen-active'), true);
});

test('non-root fullscreen never activates immersive chrome when the root target is unavailable', () => {
  const h = makeHarness();
  h.document.documentElement = null;
  h.context.__UI.setupControlButtons();

  h.document.fullscreenElement = h.elements.get('remoteVideo');
  h.dispatchDocument('fullscreenchange');

  assert.equal(h.document.body.classList.contains('fullscreen-active'), false);
  assert.equal(h.fullscreenButton.textContent, '全屏');
  assert.equal(h.elements.get('statusBar').inert, false);
  assert.equal(h.elements.get('chromeDocks').inert, false);
  assert.equal(h.elements.get('fullscreenExitPanel').hidden, true);
});

test('fullscreen overlay events do not reach the modeled global remote-input listener', async () => {
  const h = makeHarness();
  h.context.__UI.setupControlButtons();
  h.installGlobalRemoteInputListener('pointerdown');
  h.installGlobalRemoteInputListener('click');
  h.dispatchRaw('remoteVideo', 'click');
  assert.equal(h.remoteInputEvents.length, 1, 'the modeled global listener must observe an unhandled bubble');
  h.remoteInputEvents.length = 0;
  h.document.fullscreenElement = h.document.documentElement;
  h.dispatchDocument('fullscreenchange');
  h.flushTimers();

  h.pointerDown('fullscreenExitRevealBtn');
  await h.click('fullscreenExitRevealBtn');
  await h.click('exitFullscreenBtn');

  assert.deepEqual(h.remoteInputEvents, []);
});

test('fullscreen rejection keeps ordinary view, focus, and draft and announces recovery', async () => {
  const h = makeHarness({
    requestFullscreen: () => Promise.reject(new Error('not allowed')),
  });
  h.context.__UI.setupControlButtons();
  const field = h.elements.get('mobileTextInput');
  field.value = 'draft\u200b';
  field.focus();

  await h.click('fullscreenBtn');

  const status = h.elements.get('connectionStatus');
  const fullscreenStatus = h.elements.get('fullscreenStatus');
  assert.equal(h.document.fullscreenElement, null);
  assert.equal(h.document.activeElement, field);
  assert.equal(field.value, 'draft\u200b');
  assert.match(fullscreenStatus.textContent, /不支持全屏，可继续操作/);
  assert.equal(fullscreenStatus.hidden, false);
  assert.equal(status.textContent, '已连接');
  assert.equal(h.fullscreenButton.textContent, '全屏');
  assert.equal(h.context.document.body.classList.contains('fullscreen-active'), false);
});

test('fullscreen controls prevent pointerdown from stealing mobile text focus', () => {
  const h = makeHarness();
  h.context.__UI.setupControlButtons();
  const field = h.elements.get('mobileTextInput');
  field.focus();
  let prevented = false;

  h.fullscreenButton.listeners.get('pointerdown')({
    preventDefault() { prevented = true; },
  });

  assert.equal(prevented, true);
  assert.equal(h.document.activeElement, field);
  assert.equal(h.videoFocusCount, 0);
});

test('fullscreen controls preserve focused Terminal composer text', () => {
  const h = makeHarness();
  h.context.__UI.setupControlButtons();
  const composer = h.elements.get('terminalComposer');
  composer.focus();
  let prevented = false;

  h.exitButton.listeners.get('pointerdown')({
    preventDefault() { prevented = true; },
  });

  assert.equal(prevented, true);
  assert.equal(h.document.activeElement, composer);
});

test('missing fullscreen API keeps the ordinary view and shows an actionable status', async () => {
  const h = makeHarness();
  h.context.__UI.setupControlButtons();
  h.documentElement.requestFullscreen = undefined;

  await h.click('fullscreenBtn');

  assert.equal(h.document.fullscreenElement, null);
  assert.equal(h.elements.get('fullscreenStatus').hidden, false);
  assert.match(h.elements.get('fullscreenStatus').textContent, /不支持全屏，可继续操作/);
});

test('exit fullscreen rejection is handled without changing fullscreen state', async () => {
  const h = makeHarness({
    exitFullscreen: () => Promise.reject(new Error('not allowed')),
  });
  h.context.__UI.setupControlButtons();
  h.document.fullscreenElement = h.document.documentElement;
  h.dispatchDocument('fullscreenchange');

  await h.click('exitFullscreenBtn');
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(h.document.fullscreenElement, h.document.documentElement);
  assert.equal(h.elements.get('fullscreenStatus').hidden, false);
  assert.match(h.elements.get('fullscreenStatus').textContent, /不支持全屏，可继续操作/);
});

test('missing exit fullscreen API keeps fullscreen state and preserves mobile editor focus', async () => {
  const h = makeHarness();
  h.context.__UI.setupControlButtons();
  h.document.fullscreenElement = h.document.documentElement;
  h.dispatchDocument('fullscreenchange');
  delete h.document.exitFullscreen;

  const field = h.elements.get('mobileTextInput');
  field.focus();
  let prevented = false;
  h.exitButton.listeners.get('pointerdown')({
    preventDefault() { prevented = true; },
  });
  await h.click('exitFullscreenBtn');

  assert.equal(prevented, true);
  assert.equal(h.exitCount, 0);
  assert.equal(h.document.fullscreenElement, h.document.documentElement);
  assert.equal(h.document.activeElement, field);
  assert.equal(h.elements.get('fullscreenStatus').hidden, false);
  assert.match(h.elements.get('fullscreenStatus').textContent, /不支持全屏，可继续操作/);
});

test('global fullscreen exit remains callable after mobile resize and preserves editor focus', async () => {
  const h = makeHarness();
  h.context.__UI.setupControlButtons();
  h.document.fullscreenElement = h.document.documentElement;
  h.dispatchDocument('fullscreenchange');

  const field = h.elements.get('mobileTextInput');
  field.focus();
  h.resize(375, 812);
  assert.equal(h.context.window.innerWidth, 375);
  assert.equal(h.context.window.innerHeight, 812);
  let prevented = false;
  h.exitButton.listeners.get('pointerdown')({
    preventDefault() { prevented = true; },
  });
  await h.click('exitFullscreenBtn');

  assert.equal(prevented, true);
  assert.equal(h.exitCount, 1);
  assert.equal(h.document.fullscreenElement, null);
  assert.equal(h.document.activeElement, field);
});

test('global fullscreen exit remains callable from the Terminal tab and preserves composer focus', async () => {
  const h = makeHarness();
  h.context.__UI.setupControlButtons();
  h.context.document.body.classList.add('terminal-active');
  h.document.getElementById('terminalPanel').hidden = false;
  h.document.getElementById('desktopPanel').hidden = true;
  h.document.fullscreenElement = h.document.documentElement;
  h.dispatchDocument('fullscreenchange');

  const composer = h.elements.get('terminalComposer');
  composer.focus();
  let prevented = false;
  h.exitButton.listeners.get('pointerdown')({
    preventDefault() { prevented = true; },
  });
  await h.click('exitFullscreenBtn');

  assert.equal(prevented, true);
  assert.equal(h.exitCount, 1);
  assert.equal(h.document.fullscreenElement, null);
  assert.equal(h.document.activeElement, composer);
});

test('global fullscreen exit remains callable after control lease loss and preserves editor focus', async () => {
  const h = makeHarness();
  h.context.__UI.setupControlButtons();
  h.context.WebRTC.getDesktopSessionSnapshot = () => ({ canInput: false });
  h.context.document.body.classList.add('controls-hidden');
  h.fullscreenButton.disabled = true;
  h.exitButton.disabled = false;
  h.document.fullscreenElement = h.document.documentElement;
  h.dispatchDocument('fullscreenchange');

  const field = h.elements.get('mobileTextInput');
  field.focus();
  let prevented = false;
  h.exitButton.listeners.get('pointerdown')({
    preventDefault() { prevented = true; },
  });
  await h.click('exitFullscreenBtn');

  assert.equal(prevented, true);
  assert.equal(h.exitCount, 1);
  assert.equal(h.document.fullscreenElement, null);
  assert.equal(h.document.activeElement, field);
});

test('fullscreen exit and re-entry use the same root target', async () => {
  const h = makeHarness();
  h.context.__UI.setupControlButtons();

  await h.click('fullscreenBtn');
  h.document.fullscreenElement = h.document.documentElement;
  h.dispatchDocument('fullscreenchange');
  await h.click('exitFullscreenBtn');
  assert.equal(h.document.fullscreenElement, null);
  h.dispatchDocument('fullscreenchange');
  await h.click('fullscreenBtn');

  assert.equal(h.requestedTarget, h.document.documentElement);
  assert.equal(h.requestCount, 2);
});
