const test = require('node:test');
const assert = require('node:assert/strict');
const { ChromeLayout } = require('./chrome-layout.js');

test('syncChromeTop writes pixel height to --chrome-top', () => {
  const root = { style: { setProperty(name, value) { this[name] = value; } } };
  ChromeLayout.syncChromeTop(223, root);
  assert.equal(root.style['--chrome-top'], '223px');
});

test('syncChromeTop accepts zero and ignores negative or non-finite heights', () => {
  const root = { style: { setProperty(name, value) { this[name] = value; } } };
  ChromeLayout.syncChromeTop(0, root);
  assert.equal(root.style['--chrome-top'], '0px');
  ChromeLayout.syncChromeTop(-1, root);
  assert.equal(root.style['--chrome-top'], '0px');
  ChromeLayout.syncChromeTop(Number.NaN, root);
  assert.equal(root.style['--chrome-top'], '0px');
});

function makeLayoutHarness({
  chromeTop = 44,
  dockHeight = 132,
  textDockHeight = 52,
  textVisible = false,
  streamConnected = true,
  bodyClass = '',
} = {}) {
  ChromeLayout._mobileLayoutCleanup?.();
  ChromeLayout._mobileLayoutRaf = null;
  ChromeLayout._mobileLayoutPending = null;
  ChromeLayout._mobileLayoutLastSupported = null;
  ChromeLayout._mobileViewportSnapshot = null;
  ChromeLayout._idleTimer = null;

  const classes = new Set(String(bodyClass).split(/\s+/).filter(Boolean));
  if (streamConnected) classes.add('stream-connected');
  const properties = new Map();
  const elements = new Map();
  const eventListeners = new Map();
  let activeModal = null;
  const body = {
    classList: {
      contains(name) { return classes.has(name); },
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
    },
  };
  const element = (height, visible = true) => ({
    hidden: !visible,
    classList: { contains(name) { return name === 'hidden' && !visible; } },
    style: {},
    getBoundingClientRect() { return { height }; },
    offsetHeight: height,
  });
  const status = element(chromeTop);
  const docks = element(dockHeight);
  const textDock = element(textDockHeight, textVisible);
  const panel = element(0);
  const desktopTab = { getAttribute(name) { return name === 'aria-selected' ? 'true' : null; } };
  elements.set('statusBar', status);
  elements.set('chromeDocks', docks);
  elements.set('mobileInputDock', textDock);
  elements.set('desktopPanel', panel);
  elements.set('desktopTabBtn', desktopTab);
  const style = {
    setProperty(name, value) { properties.set(name, value); },
    removeProperty(name) { properties.delete(name); },
    getPropertyValue(name) { return properties.get(name) || ''; },
  };
  const documentElement = { clientHeight: 812, style };
  const view = {
    innerHeight: 812,
    visualViewport: { height: 812, offsetTop: 0 },
    navigator: { maxTouchPoints: 1 },
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
    cancelAnimationFrame() {},
  };
  const root = {
    body,
    defaultView: view,
    navigator: view.navigator,
    documentElement,
    getElementById(id) { return elements.get(id) || null; },
    querySelector(selector) {
      if (selector === 'body') return body;
      if (selector === '.modal:not(.hidden)') return activeModal;
      if (selector.startsWith('#')) return elements.get(selector.slice(1)) || null;
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener(type, handler) {
      if (!eventListeners.has(type)) eventListeners.set(type, new Set());
      eventListeners.get(type).add(handler);
    },
    removeEventListener(type, handler) { eventListeners.get(type)?.delete(handler); },
  };
  const originalCompute = ChromeLayout.computeMobileLayout;
  const harness = {
    root,
    body,
    classes,
    properties,
    elements,
    eventListeners,
    layoutInput: null,
    layout: null,
    setActiveModal(modal) { activeModal = modal; },
    restore() {
      ChromeLayout.computeMobileLayout = originalCompute;
      ChromeLayout._mobileLayoutCleanup?.();
      ChromeLayout._mobileLayoutRaf = null;
      ChromeLayout._mobileLayoutPending = null;
      ChromeLayout._mobileLayoutLastSupported = null;
      ChromeLayout._mobileViewportSnapshot = null;
      ChromeLayout._idleTimer = null;
    },
  };
  ChromeLayout.computeMobileLayout = (input) => {
    harness.layoutInput = { ...input };
    harness.layout = originalCompute.call(ChromeLayout, input);
    return harness.layout;
  };
  return harness;
}

test('recalculate writes chrome top to documentElement for a document-shaped root', () => {
  const h = makeLayoutHarness({ chromeTop: 44, dockHeight: 132 });
  try {
    ChromeLayout.recalculate(h.root);
    assert.equal(h.root.style, undefined);
    assert.equal(h.root.documentElement.style.getPropertyValue('--chrome-top'), '44px');

    h.body.classList.add('fullscreen-active');
    ChromeLayout.setFullscreenActive(true, h.root);
    assert.equal(h.root.documentElement.style.getPropertyValue('--chrome-top'), '0px');
  } finally {
    h.restore();
  }
});

test('fullscreen uses zero effective chrome top and dock height without rewriting dock state', () => {
  const h = makeLayoutHarness({ chromeTop: 44, dockHeight: 132, streamConnected: true });
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const previousMutationObserver = global.MutationObserver;
  const timers = [];
  const cleared = [];
  const observers = [];
  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => cleared.push(timer);
  global.MutationObserver = class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() {}
  };

  try {
    ChromeLayout.recalculate(h.root);
    assert.equal(h.properties.get('--chrome-top'), '44px');
    assert.equal(h.layoutInput.chromeTop, 44);
    assert.equal(h.layoutInput.dockContentHeight, 132);
    const normalViewerHeight = h.layout.viewerHeight;

    const unbind = ChromeLayout.bindIdle(h.root);
    assert.equal(timers.length, 1);
    h.body.classList.add('fullscreen-active');
    h.body.classList.add('controls-hidden');
    ChromeLayout.setFullscreenActive(true, h.root);

    assert.equal(ChromeLayout.isFullscreenActive(h.root), true);
    assert.equal(h.properties.get('--chrome-top'), '0px');
    assert.equal(h.properties.get('--mobile-viewer-top'), '0px');
    assert.equal(h.layoutInput.chromeTop, 0);
    assert.equal(h.layoutInput.dockContentHeight, 0);
    assert.equal(h.layout.viewerHeight, normalViewerHeight + 44 + 132);
    assert.equal(cleared.length, 1);

    ChromeLayout.armIdleTimer(h.root);
    observers[0].callback();
    timers[0].callback();
    ChromeLayout.enterIdle(h.root);
    ChromeLayout.bump(h.root);
    assert.equal(h.body.classList.contains('controls-hidden'), true);
    assert.equal(h.body.classList.contains('chrome-idle'), false);
    assert.equal(timers.length, 1);

    h.body.classList.remove('fullscreen-active');
    ChromeLayout.setFullscreenActive(false, h.root);
    assert.equal(ChromeLayout.isFullscreenActive(h.root), false);
    assert.equal(h.properties.get('--chrome-top'), '44px');
    assert.equal(h.properties.get('--mobile-viewer-top'), '44px');
    assert.equal(h.layoutInput.chromeTop, 44);
    assert.equal(h.layoutInput.dockContentHeight, 132);
    assert.equal(h.layout.viewerHeight, normalViewerHeight);
    unbind();
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
    if (previousMutationObserver) global.MutationObserver = previousMutationObserver;
    else delete global.MutationObserver;
    h.restore();
  }
});

test('fullscreen preserves a pre-existing chrome-idle through every idle entry point', () => {
  const h = makeLayoutHarness({ chromeTop: 44, dockHeight: 132, streamConnected: true });
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const previousMutationObserver = global.MutationObserver;
  const timers = [];
  const observers = [];
  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = () => {};
  global.MutationObserver = class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() {}
  };

  try {
    const unbind = ChromeLayout.bindIdle(h.root);
    const preFullscreenTimer = timers[0];
    h.body.classList.add('fullscreen-active');
    h.body.classList.add('chrome-idle');
    ChromeLayout.setFullscreenActive(true, h.root);

    ChromeLayout.armIdleTimer(h.root);
    preFullscreenTimer.callback();
    observers[0].callback();
    ChromeLayout.enterIdle(h.root);
    ChromeLayout.bump(h.root);

    assert.equal(h.body.classList.contains('chrome-idle'), true);
    unbind();
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
    if (previousMutationObserver) global.MutationObserver = previousMutationObserver;
    else delete global.MutationObserver;
    h.restore();
  }
});

test('fullscreen keeps only the visible mobile text dock reserve', () => {
  const h = makeLayoutHarness({
    chromeTop: 44, dockHeight: 132, textDockHeight: 52, textVisible: true,
  });
  try {
    h.body.classList.add('fullscreen-active');
    ChromeLayout.setFullscreenActive(true, h.root);
    assert.equal(h.layoutInput.chromeTop, 0);
    assert.equal(h.layoutInput.dockContentHeight, 0);
    assert.equal(h.layoutInput.textDockHeight, 52);
    assert.equal(h.layoutInput.textVisible, true);
    assert.equal(h.layout.viewerHeight, h.layout.availableHeight - 52 - 8);
    assert.equal(h.layout.viewerHeight, 752);
  } finally {
    h.restore();
  }
});

test('fullscreen exit re-arms idle only when the full idle gate allows it', () => {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const previousInput = global.Input;
  const timers = [];
  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = () => {};

  const cases = [
    {
      name: 'menu open',
      setup(h) {
        h.elements.set('moreActionsBtn', { getAttribute: () => 'true' });
      },
    },
    {
      name: 'modal open',
      setup(h) {
        h.setActiveModal({});
      },
    },
    {
      name: 'mobile input visible',
      setup() {
        global.Input = { mobileTextInputAdapter: { getSnapshot: () => ({ shown: true }) } };
      },
    },
  ];

  try {
    for (const testCase of cases) {
      const h = makeLayoutHarness();
      try {
        testCase.setup(h);
        h.body.classList.add('fullscreen-active');
        ChromeLayout.setFullscreenActive(true, h.root);
        h.body.classList.remove('fullscreen-active');
        timers.length = 0;
        ChromeLayout.setFullscreenActive(false, h.root);
        assert.equal(timers.length, 0, `${testCase.name} must block idle re-arm`);
      } finally {
        h.restore();
        delete global.Input;
      }
    }

    const disabled = makeLayoutHarness();
    try {
      ChromeLayout.autoIdleEnabled = false;
      disabled.body.classList.add('fullscreen-active');
      ChromeLayout.setFullscreenActive(true, disabled.root);
      disabled.body.classList.remove('fullscreen-active');
      timers.length = 0;
      ChromeLayout.setFullscreenActive(false, disabled.root);
      assert.equal(timers.length, 0, 'disabled auto idle must block re-arm');
    } finally {
      ChromeLayout.autoIdleEnabled = true;
      disabled.restore();
    }

    const allowed = makeLayoutHarness();
    try {
      allowed.body.classList.add('fullscreen-active');
      ChromeLayout.setFullscreenActive(true, allowed.root);
      allowed.body.classList.remove('fullscreen-active');
      timers.length = 0;
      ChromeLayout.setFullscreenActive(false, allowed.root);
      assert.equal(timers.length, 1, 'allowed exit must re-arm idle');
    } finally {
      allowed.restore();
    }
  } finally {
    ChromeLayout.autoIdleEnabled = true;
    if (previousInput === undefined) delete global.Input;
    else global.Input = previousInput;
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }
});

test('observeStatusBar falls back to the default chrome height without ResizeObserver', () => {
  const root = { style: {}, ownerDocument: null };
  const status = { offsetHeight: 0 };
  const previous = global.ResizeObserver;
  try {
    delete global.ResizeObserver;
    ChromeLayout.observeStatusBar(status, root);
    assert.equal(root.style['--chrome-top'], '56px');
  } finally {
    if (previous) global.ResizeObserver = previous;
  }
});

test('capability matrix gates actions by connection phase', () => {
  const expected = {
    idle: { canConnect: true, canSendDesktopInput: false, canRefresh: false, canPause: false, canDisconnect: false },
    signaling: { canConnect: false, canSendDesktopInput: false, canRefresh: false, canPause: false, canDisconnect: false },
    'media-pending': { canConnect: false, canSendDesktopInput: false, canRefresh: true, canPause: false, canDisconnect: true },
    connected: { canConnect: false, canSendDesktopInput: false, canRefresh: true, canPause: true, canDisconnect: true },
    'media-stalled': { canConnect: false, canSendDesktopInput: false, canRefresh: true, canPause: true, canDisconnect: true },
    disconnected: { canConnect: true, canSendDesktopInput: false, canRefresh: false, canPause: false, canDisconnect: false },
  };
  for (const [phase, values] of Object.entries(expected)) {
    assert.deepEqual(
      ChromeLayout.getCapabilities({ uiPhase: phase, streamReady: phase === 'connected', activeControl: false }),
      { ...values, canOpenNetwork: phase !== 'idle', canOpenResolution: phase === 'connected' || phase === 'media-stalled', canOpenTerminal: phase !== 'idle' && phase !== 'disconnected' },
    );
  }
});

test('capability matrix requires active control and terminal authorization', () => {
  const caps = ChromeLayout.getCapabilities({
    uiPhase: 'connected', streamReady: true, activeControl: true,
    controlTransition: false, terminalAuthorized: true,
  });
  assert.equal(caps.canSendDesktopInput, true);
  assert.equal(caps.canOpenTerminal, true);
  assert.equal(ChromeLayout.getCapabilities({ uiPhase: 'connected', streamReady: true, activeControl: true, controlTransition: true }).canSendDesktopInput, false);
  assert.equal(ChromeLayout.getCapabilities({ uiPhase: 'media-stalled', streamReady: true, activeControl: true, controlTransition: false }).canSendDesktopInput, false);
});

test('applyCapabilities updates capability-bound controls', () => {
  const make = (id) => ({ id, disabled: false, hidden: false, dataset: {} });
  const elements = new Map(['startBtn', 'requestControlBtn', 'refreshBtn', 'pauseBtn', 'disconnectBtn', 'networkModeBtn', 'resolutionBtn', 'terminalTabBtn'].map((id) => [id, make(id)]));
  const root = { getElementById: (id) => elements.get(id) || null, querySelectorAll: () => [] };
  ChromeLayout.applyCapabilities({ uiPhase: 'idle', streamReady: false, activeControl: false }, root);
  assert.equal(elements.get('startBtn').disabled, false);
  assert.equal(elements.get('refreshBtn').disabled, true);
  assert.equal(elements.get('refreshBtn').hidden, true);
  assert.equal(elements.get('networkModeBtn').hidden, true);
});

test('disconnected state keeps network mode recovery available', () => {
  const network = { disabled: true, hidden: true };
  const root = { getElementById: (id) => id === 'networkModeBtn' ? network : null, querySelectorAll: () => [] };
  ChromeLayout.applyCapabilities({ uiPhase: 'disconnected', streamReady: false }, root);
  assert.equal(network.disabled, false);
  assert.equal(network.hidden, false);
});

test('loading overlay only captures video input while signaling', () => {
  const classes = new Set();
  const loading = {
    style: {},
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
      contains(name) { return classes.has(name); },
    },
  };
  const root = {
    getElementById(id) {
      return id === 'loading' ? loading : null;
    },
    querySelectorAll: () => [],
  };

  ChromeLayout.applyCapabilities({ uiPhase: 'signaling', streamReady: false }, root);
  assert.equal(loading.style.pointerEvents, 'auto');
  assert.equal(loading.classList.contains('is-connecting'), true);

  for (const uiPhase of ['idle', 'media-pending', 'connected', 'media-stalled', 'disconnected']) {
    ChromeLayout.applyCapabilities({ uiPhase, streamReady: false }, root);
    assert.equal(loading.style.pointerEvents, 'none', `${uiPhase} overlay must not eat video input`);
    assert.equal(loading.classList.contains('is-connecting'), false);
  }
});

test('applyCapabilities keeps request control available only when media is ready and lease is free', () => {
  const make = (id) => ({ id, disabled: false, hidden: false, classList: { toggle() {} } });
  const elements = new Map(['startBtn', 'requestControlBtn', 'textInputBtn', 'keyboardModeBtn', 'moreActionsBtn', 'scaleBtn', 'fullscreenBtn'].map((id) => [id, make(id)]));
  const root = { getElementById: (id) => elements.get(id) || null, querySelectorAll: () => [] };
  ChromeLayout.applyCapabilities({ uiPhase: 'connected', streamReady: true, activeControl: false }, root);
  assert.equal(elements.get('requestControlBtn').disabled, false);
  assert.equal(elements.get('requestControlBtn').hidden, false);
  assert.equal(elements.get('textInputBtn').disabled, true);
  assert.equal(elements.get('scaleBtn').disabled, false);
  assert.equal(elements.get('fullscreenBtn').disabled, false);
  ChromeLayout.applyCapabilities({ uiPhase: 'connected', streamReady: true, activeControl: true }, root);
  assert.equal(elements.get('requestControlBtn').hidden, true);
  assert.equal(elements.get('textInputBtn').disabled, false);
});

test('applyCapabilities gates mobile virtual keys through the desktop input capability', () => {
  const mobileKey = { disabled: false, hidden: false };
  const root = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll(selector) { return selector === '[data-mobile-action]' ? [mobileKey] : []; },
  };
  ChromeLayout.applyCapabilities({ uiPhase: 'connected', streamReady: true, activeControl: false }, root);
  assert.equal(mobileKey.disabled, true);
  assert.equal(mobileKey.hidden, true);
  ChromeLayout.applyCapabilities({ uiPhase: 'connected', streamReady: true, activeControl: true, controlTransition: false }, root);
  assert.equal(mobileKey.disabled, false);
  assert.equal(mobileKey.hidden, false);
});

test('capability close keeps a pressed virtual modifier visible and enabled for native release', () => {
  const modifier = {
    disabled: false,
    hidden: false,
    getAttribute(name) { return name === 'aria-pressed' ? 'true' : null; },
  };
  const root = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll(selector) { return selector === '[data-mobile-action]' ? [modifier] : []; },
  };
  ChromeLayout.applyCapabilities({ uiPhase: 'media-pending', streamReady: false, activeControl: false }, root);
  assert.equal(modifier.disabled, false);
  assert.equal(modifier.hidden, false);
});

test('more menu overflow buttons expose menuitem semantics', () => {
  const button = { dataset: {}, setAttribute(name, value) { this[name] = value; }, getAttribute() { return null; } };
  const bar = { querySelectorAll: () => [button] };
  const menu = { appendChild(node) { this.child = node; } };
  ChromeLayout.moveOverflowIntoMenu(bar, menu);
  assert.equal(button.role, 'menuitem');
});

test('more menu keyboard navigation wraps and supports Home/End', () => {
  const focused = [];
  const items = [0, 1, 2].map((index) => ({
    focus() { focused.push(index); },
    getAttribute() { return null; },
  }));
  const menu = {
    querySelectorAll() { return items; },
    hidden: false,
  };
  const root = {
    getElementById(id) { return id === 'moreActionsMenu' ? menu : null; },
    querySelector() { return null; },
    addEventListener() {},
  };
  const unbind = ChromeLayout.bindMoreMenu(root);
  assert.equal(typeof unbind, 'function');
  assert.equal(typeof ChromeLayout.handleMoreMenuKeydown, 'function');
  ChromeLayout.handleMoreMenuKeydown({ key: 'End', target: menu, preventDefault() {} }, root);
  assert.deepEqual(focused, [2]);
});

test('toggleMoreMenu sets hidden and aria-expanded', () => {
  const next = ChromeLayout.nextMoreMenuState(false);
  assert.equal(next.open, true);
  assert.equal(ChromeLayout.nextMoreMenuState(true).open, false);
  assert.equal(typeof ChromeLayout.toggleMoreMenu, 'function');
});

function fakeToggleRoot(bodyClass) {
  const classes = new Set(String(bodyClass || '').split(/\s+/).filter(Boolean));
  const btn = { id: 'toggleControlsBtn', textContent: '隐藏控件' };
  return {
    body: {
      classList: {
        contains: (name) => classes.has(name),
        add: (name) => { classes.add(name); },
        remove: (name) => { classes.delete(name); },
      },
    },
    getElementById: (id) => (id === 'toggleControlsBtn' ? btn : null),
    btn,
    classes,
  };
}

test('toggle label is 显示控件 when docks are hidden or idle', () => {
  const hidden = fakeToggleRoot('controls-hidden');
  ChromeLayout.syncToggleControlsLabel(hidden);
  assert.equal(hidden.btn.textContent, '显示控件');

  const idle = fakeToggleRoot('stream-connected chrome-idle');
  ChromeLayout.syncToggleControlsLabel(idle);
  assert.equal(idle.btn.textContent, '显示控件');

  const shown = fakeToggleRoot('stream-connected');
  ChromeLayout.syncToggleControlsLabel(shown);
  assert.equal(shown.btn.textContent, '隐藏控件');
});

test('revealViewerChrome clears hidden and idle', () => {
  const root = fakeToggleRoot('stream-connected controls-hidden chrome-idle');
  ChromeLayout.revealViewerChrome(root);
  assert.equal(root.classes.has('controls-hidden'), false);
  assert.equal(root.classes.has('chrome-idle'), false);
  assert.equal(root.btn.textContent, '隐藏控件');
});

function createMoreMenuDom() {
  const ids = {};
  const match = (el, selector) => {
    if (selector === '.action-bar') return /\baction-bar\b/.test(el.className);
    if (selector === '.control-bar') return /\bcontrol-bar\b/.test(el.className);
    if (selector === '.control-btn') return /\bcontrol-btn\b/.test(el.className);
    if (selector === '.action-more' || selector === '#moreActionsBtn') {
      return el.id === 'moreActionsBtn' || /\baction-more\b/.test(el.className);
    }
    if (selector === '#moreActionsMenu') return el.id === 'moreActionsMenu';
    if (selector === '.action-btn') return /\baction-btn\b/.test(el.className);
    if (selector === '.action-btn:not(.action-more)') {
      return /\baction-btn\b/.test(el.className) && !/\baction-more\b/.test(el.className);
    }
    if (selector === '.action-btn:not(.action-more):not([data-pin="always"])') {
      return /\baction-btn\b/.test(el.className)
        && !/\baction-more\b/.test(el.className)
        && el.attrs['data-pin'] !== 'always';
    }
    return false;
  };
  const el = (className, attrs = {}, id = '') => {
    const node = {
      id,
      className,
      attrs: { ...attrs },
      hidden: !!attrs.hidden,
      children: [],
      parent: null,
      classList: {
        contains(name) {
          return new Set(node.className.split(/\s+/).filter(Boolean)).has(name);
        },
        toggle(name, on) {
          const set = new Set(node.className.split(/\s+/).filter(Boolean));
          if (on) set.add(name); else set.delete(name);
          node.className = [...set].join(' ');
        },
      },
      setAttribute(name, value) { this.attrs[name] = String(value); },
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
      querySelectorAll(selector) {
        const found = [];
        const walk = (current) => {
          current.children.forEach((child) => {
            if (match(child, selector)) found.push(child);
            walk(child);
          });
        };
        walk(this);
        return found;
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      appendChild(child) {
        if (child.parent) child.parent.children = child.parent.children.filter((item) => item !== child);
        child.parent = this;
        this.children.push(child);
        return child;
      },
      insertBefore(child, ref) {
        if (child.parent) child.parent.children = child.parent.children.filter((item) => item !== child);
        child.parent = this;
        const index = ref ? this.children.indexOf(ref) : -1;
        if (index < 0) this.children.push(child);
        else this.children.splice(index, 0, child);
        return child;
      },
    };
    if (id) ids[id] = node;
    return node;
  };

  const body = el('body');
  const bar = el('action-bar');
  const controlBar = el('control-bar');
  const labels = ['enter', 'up', 'down', 'keyboard', 'copy'];
  const buttons = labels.map((name) => {
    const attrs = name === 'enter' || name === 'keyboard' ? { 'data-pin': 'always' } : {};
    const button = el('action-btn', attrs, name === 'keyboard' ? 'keyboardModeBtn' : '');
    button.name = name;
    bar.appendChild(button);
    return button;
  });
  const more = el('action-btn action-more', { 'aria-expanded': 'false' }, 'moreActionsBtn');
  const menu = el('more-actions-menu', { hidden: true }, 'moreActionsMenu');
  bar.appendChild(more);
  bar.appendChild(menu);
  body.appendChild(bar);
  ['scale', 'fullscreen'].forEach((name, index) => {
    const control = el('control-btn', {}, `${name}Btn`);
    control.name = name;
    controlBar.appendChild(control);
    control.setAttribute('data-control-home-index', String(index));
  });
  body.appendChild(controlBar);
  const root = {
    body,
    getElementById: (id) => ids[id] || null,
    querySelector: (selector) => (match(bar, selector) ? bar : body.querySelector(selector)),
  };
  return { root, bar, controlBar, more, menu, buttons };
}

test('toggleMoreMenu moves overflow nodes and restores original order', () => {
  const { root, bar, more, menu, buttons } = createMoreMenuDom();
  const names = () => bar.children.filter((child) => /\baction-btn\b/.test(child.className)).map((child) => child.name || 'more');

  ChromeLayout.recordOverflowHomeIndexes(bar);
  assert.equal(buttons[1].getAttribute('data-home-index'), '1');
  assert.equal(buttons[2].getAttribute('data-home-index'), '2');
  assert.equal(buttons[4].getAttribute('data-home-index'), '4');
  assert.equal(buttons[0].getAttribute('data-home-index'), null);

  const opened = ChromeLayout.toggleMoreMenu(true, root);
  assert.equal(opened.open, true);
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.equal(menu.hidden, false);
  assert.match(root.body.className, /\bmore-open\b/);
  assert.deepEqual(names(), ['enter', 'keyboard', 'more']);
  assert.deepEqual(menu.children.map((child) => child.name), ['up', 'down', 'copy']);

  const closed = ChromeLayout.toggleMoreMenu(false, root);
  assert.equal(closed.open, false);
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  assert.equal(menu.hidden, true);
  assert.equal(menu.children.length, 0);
  assert.deepEqual(names(), ['enter', 'up', 'down', 'keyboard', 'copy', 'more']);
});

test('compact more overlay temporarily contains ordinary control-bar buttons', () => {
  const { root, bar, controlBar, menu } = createMoreMenuDom();
  root.body.className = 'mobile-layout-managed mobile-layout-compact';
  ChromeLayout.recordOverflowHomeIndexes(bar);
  ChromeLayout.recordControlHomeIndexes(controlBar);

  ChromeLayout.toggleMoreMenu(true, root);
  assert.equal(controlBar.children.length, 0);
  assert.deepEqual(menu.children.filter((child) => child.className === 'control-btn').map((child) => child.name), [
    'scale', 'fullscreen',
  ]);
  assert.deepEqual(menu.children.filter((child) => child.className === 'control-btn')
    .map((child) => child.getAttribute('role')), ['menuitem', 'menuitem']);

  ChromeLayout.toggleMoreMenu(false, root);
  assert.equal(menu.children.length, 0);
  assert.deepEqual(controlBar.children.map((child) => child.name), ['scale', 'fullscreen']);
});

test('shouldIdle only when streaming, chrome visible, idle long enough', () => {
  assert.equal(ChromeLayout.shouldIdle({
    streamConnected: true, controlsHidden: false, menuOpen: false, modalOpen: false, idleMs: 2500,
  }), true);
  assert.equal(ChromeLayout.shouldIdle({
    streamConnected: true, controlsHidden: false, menuOpen: false, modalOpen: false, idleMs: 2499,
  }), false);
  assert.equal(ChromeLayout.shouldIdle({
    streamConnected: false, controlsHidden: false, menuOpen: false, modalOpen: false, idleMs: 5000,
  }), false);
  assert.equal(ChromeLayout.shouldIdle({
    streamConnected: true, controlsHidden: false, menuOpen: true, modalOpen: false, idleMs: 5000,
  }), false);
  assert.equal(ChromeLayout.shouldIdle({
    streamConnected: true, controlsHidden: false, menuOpen: false, modalOpen: true, idleMs: 5000,
  }), false);
  for (const mobileInputMode of ['visible', 'composing', 'pending']) {
    assert.equal(ChromeLayout.shouldIdle({
      streamConnected: true, controlsHidden: false, menuOpen: false, modalOpen: false,
      mobileInputMode, idleMs: 5000,
    }), false, `${mobileInputMode} mobile input must keep the chrome visible`);
  }
});

test('collectIdleInputs reflects the mobile text adapter focus state', () => {
  const previousInput = global.Input;
  const classes = new Set(['stream-connected']);
  const root = {
    body: { classList: { contains: (name) => classes.has(name) } },
    getElementById: () => null,
    querySelector: () => null,
  };
  let snapshot = { shown: true, composing: false };
  try {
    global.Input = { mobileTextInputAdapter: { getSnapshot: () => snapshot } };
    assert.equal(ChromeLayout.collectIdleInputs(root).mobileInputMode, 'visible');
    snapshot = { shown: true, composing: true };
    assert.equal(ChromeLayout.collectIdleInputs(root).mobileInputMode, 'composing');
    snapshot = { shown: false, composing: false, hasPending: true, status: 'pending' };
    assert.equal(ChromeLayout.collectIdleInputs(root).mobileInputMode, 'pending');
    snapshot = { shown: true, composing: false, hasPending: false, status: 'blocked' };
    assert.equal(ChromeLayout.collectIdleInputs(root).mobileInputMode, 'blocked');
    assert.equal(ChromeLayout.shouldIdle({
      streamConnected: true, controlsHidden: false, menuOpen: false, modalOpen: false,
      mobileInputMode: 'blocked', idleMs: 5000,
    }), false);
  } finally {
    if (previousInput === undefined) delete global.Input;
    else global.Input = previousInput;
  }
});

test('auto idle retreats docks after a connected idle period', () => {
  assert.equal(ChromeLayout.autoIdleEnabled, true);
  const classes = new Set(['stream-connected']);
  const root = {
    body: {
      classList: {
        contains: (name) => classes.has(name),
        add: (name) => { classes.add(name); },
        remove: (name) => { classes.delete(name); },
      },
    },
    getElementById: () => null,
  };
  ChromeLayout.enterIdle(root);
  assert.equal(classes.has('chrome-idle'), true);
});

function makeEventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatch(type, event = {}) {
      listeners.get(type)?.forEach((handler) => handler(event));
    },
  };
}

test('mobile capability snapshot detects touch and virtual keyboard support', () => {
  const windowTarget = makeEventTarget();
  windowTarget.innerHeight = 800;
  windowTarget.ontouchstart = null;
  const root = { defaultView: windowTarget, style: {}, documentElement: null };
  const snapshot = ChromeLayout.getMobileCapabilitySnapshot({}, root);
  assert.equal(snapshot.deviceClass, 'touch');
  assert.equal(snapshot.touchSupported, true);
  assert.equal(snapshot.virtualKeyboardSupported, false);
  assert.equal(snapshot.viewportHeight, 800);
  assert.equal(snapshot.keyboardBottom, 0);
  assert.equal(snapshot.keyboardInset, 0);
  assert.equal(Object.isFrozen(snapshot), true);
});

test('mobile capability snapshot calculates and clamps visual viewport keyboard inset', () => {
  const windowTarget = makeEventTarget();
  windowTarget.innerHeight = 800;
  windowTarget.visualViewport = { height: 500, offsetTop: 0, addEventListener() {}, removeEventListener() {} };
  const root = { defaultView: windowTarget, style: {} };
  assert.equal(ChromeLayout.getMobileCapabilitySnapshot({}, root).keyboardBottom, 300);
  windowTarget.visualViewport.height = 1200;
  assert.equal(ChromeLayout.getMobileCapabilitySnapshot({}, root).keyboardBottom, 0);
  windowTarget.visualViewport.height = -10;
  assert.equal(ChromeLayout.getMobileCapabilitySnapshot({}, root).keyboardBottom, 800);
});

test('mobile viewport observer feature-detects APIs, resets on hide, and tears down exact listeners', () => {
  const windowTarget = makeEventTarget();
  windowTarget.innerHeight = 800;
  const visualViewport = makeEventTarget();
  visualViewport.height = 500;
  visualViewport.offsetTop = 0;
  windowTarget.visualViewport = visualViewport;
  const keyboard = makeEventTarget();
  keyboard.boundingRect = { height: 280 };
  const root = { defaultView: windowTarget, navigator: { virtualKeyboard: keyboard }, style: {} };
  const unbind = ChromeLayout.observeMobileViewport(root);
  assert.equal(root.style['--mobile-keyboard-bottom'], '280px');
  keyboard.boundingRect.height = 0;
  keyboard.dispatch('geometrychange');
  assert.equal(root.style['--mobile-keyboard-bottom'], '0px');
  assert.equal(windowTarget.listeners.get('resize').size, 1);
  assert.equal(visualViewport.listeners.get('resize').size, 1);
  assert.equal(visualViewport.listeners.get('scroll').size, 1);
  assert.equal(keyboard.listeners.get('geometrychange').size, 1);
  unbind();
  assert.equal(windowTarget.listeners.get('resize').size, 0);
  assert.equal(visualViewport.listeners.get('resize').size, 0);
  assert.equal(visualViewport.listeners.get('scroll').size, 0);
  assert.equal(keyboard.listeners.get('geometrychange').size, 0);
});

test('mobile Dock measurement reserves the rendered height after controls wrap', () => {
  const previous = global.ResizeObserver;
  const observers = [];
  let dockHeight = 268;
  const docks = {
    getBoundingClientRect() { return { height: dockHeight }; },
  };
  const root = {
    documentElement: { style: { setProperty(name, value) { this[name] = value; } } },
    getElementById(id) { return id === 'chromeDocks' ? docks : null; },
    querySelector() { return null; },
  };
  global.ResizeObserver = class ResizeObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  };

  try {
    const unbind = ChromeLayout.observeMobileDocks(root);
    assert.equal(root.documentElement.style['--mobile-dock-height'], '268px');

    dockHeight = 312;
    observers[0].callback();
    assert.equal(root.documentElement.style['--mobile-dock-height'], '312px');

    unbind();
    assert.equal(observers[0].disconnected, true);
  } finally {
    ChromeLayout._mobileDockCleanup?.();
    if (previous) global.ResizeObserver = previous;
    else delete global.ResizeObserver;
  }
});

test('viewport refresh preserves the frozen WebRTC capability derivative', () => {
  const windowTarget = makeEventTarget();
  windowTarget.innerHeight = 800;
  const visualViewport = makeEventTarget();
  visualViewport.height = 500;
  visualViewport.offsetTop = 0;
  windowTarget.visualViewport = visualViewport;
  const root = {
    defaultView: windowTarget,
    style: {},
    documentElement: { style: { setProperty(name, value) { this[name] = value; } } },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };

  ChromeLayout.applyCapabilities({
    uiPhase: 'connected', streamReady: true, activeControl: true,
    transportReady: true, mobileInputMode: 'armed',
  }, root);
  const before = ChromeLayout._mobileViewportSnapshot;
  visualViewport.height = 620;
  const after = ChromeLayout.recalculate(root);

  assert.equal(Object.isFrozen(after), true);
  assert.equal(after.streamReady, true);
  assert.equal(after.activeControl, true);
  assert.equal(after.transportReady, true);
  assert.equal(after.mobileInputMode, 'armed');
  assert.equal(after.keyboardBottom, 180);
  assert.notEqual(after, before);
});

test('keyboard inset is consumed once for overlay and visualViewport resize routes', () => {
  const base = {
    layoutHeight: 812,
    visualHeight: 512,
    offsetTop: 0,
    keyboardRectHeight: 300,
    keyboardOverlay: true,
    safeBottom: 0,
    chromeTop: 44,
    dockContentHeight: 44,
    textDockHeight: 80,
    textVisible: true,
    touchSupported: true,
  };
  const overlay = ChromeLayout.computeMobileLayout(base);
  const resize = ChromeLayout.computeMobileLayout({ ...base, keyboardOverlay: false });
  assert.equal(overlay.availableHeight, 512);
  assert.equal(resize.availableHeight, 512);
  assert.equal(overlay.viewerHeight, 336);
  assert.deepEqual(overlay, resize);
});

test('mobile layout uses offsetTop as the visible origin, not extra height', () => {
  const result = ChromeLayout.computeMobileLayout({
    layoutHeight: 800,
    visualHeight: 400,
    offsetTop: 100,
    keyboardRectHeight: 0,
    keyboardOverlay: false,
    safeBottom: 12,
    chromeTop: 44,
    dockContentHeight: 44,
    textDockHeight: 60,
    textVisible: true,
    touchSupported: true,
  });
  assert.equal(result.visibleTop, 100);
  assert.equal(result.visibleBottom, 500);
  assert.equal(result.availableHeight, 400);
  assert.equal(result.viewerTop, 144);
  assert.equal(result.bottomInset, 300);
  assert.equal(result.ultraCompact, false);
});

test('mobile layout normalizes non-finite values and derives compact thresholds from available height', () => {
  const ultra = ChromeLayout.computeMobileLayout({
    layoutHeight: 320,
    visualHeight: 320,
    offsetTop: Number.NaN,
    keyboardRectHeight: Number.POSITIVE_INFINITY,
    keyboardOverlay: false,
    safeBottom: 8,
    chromeTop: 44,
    dockContentHeight: 44,
    textDockHeight: 44,
    textVisible: true,
    touchSupported: true,
  });
  assert.equal(ultra.availableHeight, 320);
  assert.equal(ultra.compact, true);
  assert.equal(ultra.ultraCompact, true);
  assert.equal(ultra.unsupportedViewport, false);

  const unsupported = ChromeLayout.computeMobileLayout({
    layoutHeight: 320,
    visualHeight: 120,
    offsetTop: 0,
    keyboardRectHeight: 0,
    keyboardOverlay: false,
    safeBottom: 8,
    chromeTop: 44,
    dockContentHeight: 44,
    textDockHeight: 44,
    textVisible: true,
    touchSupported: true,
  });
  assert.equal(unsupported.availableHeight, 120);
  assert.equal(unsupported.unsupportedViewport, true);
});

test('managed layout applies one coordinate set and clears it outside touch desktop mode', () => {
  const classes = new Set();
  const properties = new Map();
  const body = {
    classList: {
      contains: (name) => classes.has(name),
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    },
  };
  const panel = { hidden: false, classList: { contains: () => false } };
  const tab = { getAttribute: () => 'true' };
  const root = {
    body,
    documentElement: {
      style: {
        setProperty(name, value) { properties.set(name, value); },
        removeProperty(name) { properties.delete(name); },
        getPropertyValue(name) { return properties.get(name) || ''; },
      },
    },
    getElementById(id) {
      return id === 'desktopPanel' ? panel : id === 'desktopTabBtn' ? tab : null;
    },
  };
  const layout = ChromeLayout.computeMobileLayout({
    layoutHeight: 812, visualHeight: 512, offsetTop: 0, keyboardRectHeight: 300,
    keyboardOverlay: true, safeBottom: 12, chromeTop: 44, dockContentHeight: 44,
    textDockHeight: 48, textVisible: true, touchSupported: true,
  });
  const previousInput = global.Input;
  global.Input = { setViewportInputSupported(value) { this.value = value; } };
  try {
    ChromeLayout._mobileLayoutLastSupported = null;
    ChromeLayout._applyMobileLayout(root, layout, 12, true);
    assert.equal(classes.has('mobile-layout-managed'), true);
    assert.equal(properties.get('--mobile-viewer-top'), '44px');
    assert.equal(properties.get('--mobile-text-bottom'), '312px');

    panel.hidden = true;
    ChromeLayout._applyMobileLayout(root, layout, 12, false);
    assert.equal(classes.has('mobile-layout-managed'), false);
    assert.equal(properties.has('--mobile-viewer-top'), false);
    assert.equal(global.Input.value, true);
  } finally {
    if (previousInput === undefined) delete global.Input;
    else global.Input = previousInput;
    ChromeLayout._mobileLayoutLastSupported = null;
  }
});

test('scheduled layout coalesces resize work and skips identical CSS writes', () => {
  const classes = new Set();
  const callbacks = [];
  const properties = new Map();
  let writes = 0;
  const body = {
    classList: {
      contains: (name) => classes.has(name),
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    },
  };
  const element = (height, hidden = false) => ({
    hidden,
    classList: { contains: () => false },
    getBoundingClientRect: () => ({ height }),
  });
  const panel = element(0);
  const tab = { getAttribute: () => 'true' };
  const documentElement = {
    clientHeight: 812,
    style: {
      setProperty(name, value) { writes += 1; properties.set(name, value); },
      removeProperty(name) { properties.delete(name); },
      getPropertyValue(name) { return properties.get(name) || ''; },
    },
  };
  const elements = new Map([
    ['desktopPanel', panel], ['desktopTabBtn', tab], ['statusBar', element(44)],
    ['chromeDocks', element(44)], ['mobileInputDock', element(48)],
  ]);
  const visualViewport = { height: 512, offsetTop: 0 };
  const view = {
    innerHeight: 812,
    visualViewport,
    navigator: { maxTouchPoints: 1, virtualKeyboard: { overlaysContent: true, boundingRect: { height: 300 } } },
    requestAnimationFrame(callback) { callbacks.push(callback); return callbacks.length; },
    cancelAnimationFrame() {},
  };
  const root = {
    body,
    defaultView: view,
    navigator: view.navigator,
    documentElement,
    getElementById(id) { return elements.get(id) || null; },
    querySelector() { return null; },
  };
  const previousInput = global.Input;
  global.Input = { setViewportInputSupported(value) { this.value = value; } };
  try {
    ChromeLayout._mobileLayoutCleanup?.();
    ChromeLayout._mobileLayoutRaf = null;
    ChromeLayout._mobileLayoutPending = null;
    ChromeLayout._mobileLayoutLastSupported = null;
    for (let index = 0; index < 20; index += 1) ChromeLayout.recalculate(root, { schedule: true });
    assert.equal(callbacks.length, 1);
    callbacks.shift()();
    const writesAfterFirstFrame = writes;
    for (let index = 0; index < 20; index += 1) ChromeLayout.recalculate(root, { schedule: true });
    assert.equal(callbacks.length, 1);
    callbacks.shift()();
    assert.equal(writes, writesAfterFirstFrame);
  } finally {
    ChromeLayout._mobileLayoutRaf = null;
    ChromeLayout._mobileLayoutPending = null;
    ChromeLayout._mobileLayoutLastSupported = null;
    if (previousInput === undefined) delete global.Input;
    else global.Input = previousInput;
  }
});
