const test = require('node:test');
const assert = require('node:assert/strict');
const { ChromeLayout } = require('./chrome-layout.js');

test('syncChromeTop writes pixel height to --chrome-top', () => {
  const root = { style: { setProperty(name, value) { this[name] = value; } } };
  ChromeLayout.syncChromeTop(223, root);
  assert.equal(root.style['--chrome-top'], '223px');
});

test('syncChromeTop ignores non-positive heights', () => {
  const root = { style: { setProperty(name, value) { this[name] = value; } } };
  ChromeLayout.syncChromeTop(0, root);
  assert.equal(root.style['--chrome-top'], undefined);
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
      { ...values, canOpenNetwork: phase !== 'idle' && phase !== 'disconnected', canOpenResolution: phase === 'connected' || phase === 'media-stalled', canOpenTerminal: phase !== 'idle' && phase !== 'disconnected' },
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
  const root = {
    body,
    getElementById: (id) => ids[id] || null,
    querySelector: (selector) => (match(bar, selector) ? bar : body.querySelector(selector)),
  };
  return { root, bar, more, menu, buttons };
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
