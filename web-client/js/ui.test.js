const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function makeElement(id, onFocus = () => {}) {
  const listeners = new Map();
  const classes = new Set();
  return {
    id,
    tagName: id === 'mobileTextInput' || id === 'terminalComposer' ? 'TEXTAREA' : 'BUTTON',
    isContentEditable: false,
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
    focus() { onFocus(this); },
    blur() { onFocus(null, this); },
    addEventListener(type, handler) { listeners.set(type, handler); },
    setAttribute(name, value) { this[name] = String(value); },
    getAttribute(name) { return this[name] || null; },
  };
}

function makeHarness({ requestFullscreen, exitFullscreen } = {}) {
  const elements = new Map();
  const documentListeners = new Map();
  const bodyClasses = new Set();
  let requestedTarget = null;
  let requestCount = 0;
  let exitCount = 0;
  let videoFocusCount = 0;

  const body = makeElement('body');
  body.classList = {
    add(name) { bodyClasses.add(name); },
    remove(name) { bodyClasses.delete(name); },
    toggle(name, force) {
      const next = force === undefined ? !bodyClasses.has(name) : Boolean(force);
      if (next) bodyClasses.add(name);
      else bodyClasses.delete(name);
      return next;
    },
    contains(name) { return bodyClasses.has(name); },
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
    addEventListener(type, handler) { documentListeners.set(type, handler); },
    getElementById(id) {
      if (!elements.has(id)) {
        const focusTarget = makeElement(id, (element, blurred) => {
          if (element) document.activeElement = element;
          else if (document.activeElement === blurred) document.activeElement = null;
        });
        elements.set(id, focusTarget);
      }
      return elements.get(id);
    },
    querySelector(selector) {
      if (selector === '.viewer-container') {
        if (!elements.has('viewerContainer')) elements.set('viewerContainer', makeElement('viewerContainer'));
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
    ChromeLayout: {},
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

  const fullscreenButton = document.getElementById('fullscreenBtn');
  const exitButton = document.getElementById('exitFullscreenBtn');
  const fullscreenStatus = document.getElementById('fullscreenStatus');
  fullscreenStatus.hidden = true;
  const video = document.getElementById('remoteVideo');
  document.getElementById('mobileTextInput');
  document.getElementById('terminalComposer');
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
    click(id) {
      const element = elements.get(id) || document.getElementById(id);
      const handler = element.listeners.get('click');
      assert.equal(typeof handler, 'function', `${id} should have a click listener`);
      return handler({ preventDefault() {} });
    },
    dispatchDocument(type) {
      const handler = documentListeners.get(type);
      assert.equal(typeof handler, 'function', `${type} should have a document listener`);
      return handler();
    },
    resize(width, height) {
      this.context.window.innerWidth = width;
      this.context.window.innerHeight = height;
    },
  };
}

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
