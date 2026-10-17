'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const json = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const proxy403 = () => ({ status: 403, ok: false, json: async () => { throw new SyntaxError('proxy HTML'); } });
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

function runtime({ verify = () => proxy403(), bootstrap = () => proxy403() } = {}) {
  const nodes = new Map();
  const domReady = [];
  const tokens = new Map([['wrd_token', 'fixture-token']]);
  const requests = [], failures = [], controllers = [];
  let signals = 0, inits = 0;
  function element() {
    const classes = new Set();
    return {
      style: {}, dataset: {}, children: [], listeners: {}, disabled: false,
      classList: { add(...names) { names.forEach((name) => classes.add(name)); }, remove(...names) { names.forEach((name) => classes.delete(name)); }, contains(name) { return classes.has(name); } },
      setAttribute() {},
      appendChild(child) { this.children.push(child); if (child.id) nodes.set(child.id, child); },
      remove() { nodes.delete(this.id); },
      addEventListener(name, listener) { this.listeners[name] = listener; },
    };
  }
  for (const id of ['startBtn', 'loading', 'loadingText']) nodes.set(id, element());
  const context = {
    AbortController,
    console: { log() {}, warn() {}, error() {} },
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { throw new Error('unexpected live interval'); }, clearInterval() {},
    performance: { now: () => 0 }, navigator: {},
    addEventListener() {},
    document: {
      readyState: 'loading', body: element(),
      createElement: element, getElementById(id) { return nodes.get(id) || null; },
      querySelector() { return null; }, querySelectorAll() { return []; },
      addEventListener(name, listener) { if (name === 'DOMContentLoaded') domReady.push(listener); },
    },
    location: { href: 'viewer.html', origin: 'http://fixture' },
    RuntimeConfig: { getApiBase: () => 'http://fixture' },
    sessionStorage: { getItem(key) { return tokens.get(key) || null; }, setItem(key, value) { tokens.set(key, value); }, removeItem(key) { tokens.delete(key); } },
    localStorage: { getItem() { return null; }, removeItem() {}, setItem() {} },
    fetch: async (url) => {
      if (url.endsWith('/api/auth/viewer-admission')) return json(201, { admission: { ticket: 'fixture-ticket' } });
      requests.push(url.endsWith('/api/auth/verify') ? 'verify' : 'bootstrap');
      return url.endsWith('/api/auth/verify') ? verify() : bootstrap();
    },
    io() { throw new Error('integration fixture must not open a real Viewer'); },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ['shell-guard.js', 'bounded-request.js', 'auth.js', 'bootstrap-controller.js', 'chrome-layout.js', 'webrtc.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context);
  }
  vm.runInContext('globalThis.__Auth=Auth;globalThis.__WebRTC=WebRTC;', context);
  const Auth = context.__Auth, WebRTC = context.__WebRTC;
  const create = context.createViewerBootstrap;
  context.createViewerBootstrap = (options) => { const controller = create(options); controllers.push(controller); return controller; };
  // Only platform/media/layout effects are replaced. Auth, shell, boot adapter,
  // Start handler, bootstrap controller, and capability computation remain real.
  WebRTC.initializeMediaActivity = () => {};
  WebRTC.bindFullscreenLifecycle = () => {};
  WebRTC.configureNetworkControls = () => {};
  WebRTC.updateNetworkUI = () => {};
  WebRTC.renderPortSearchStatus = () => {};
  WebRTC.createSignalingSocket = () => { signals++; };
  WebRTC.init = async () => { inits++; };
  WebRTC.enterBootstrapFailure = (error) => { failures.push(error.code); };
  context.ChromeLayout.applyCapabilities = (snapshot) => {
    const capabilities = context.ChromeLayout.getCapabilities(snapshot);
    nodes.get('startBtn').disabled = !capabilities.canConnect;
    return capabilities;
  };
  WebRTC.networkMode = 'relay';
  domReady.forEach((listener) => listener());
  return { Auth, WebRTC, context, nodes, tokens, requests, failures, controllers,
    signals: () => signals, inits: () => inits };
}

test('unavailable verify gates shell and direct Start; explicit verify retry enables only a new click, and proxy bootstrap403 preserves token', async () => {
  let verified = false;
  const r = runtime({ verify: () => verified ? json(200, { valid: true }) : proxy403() });
  await flush();
  assert.equal(r.tokens.get('wrd_token'), 'fixture-token');
  assert.equal(r.nodes.get('startBtn').disabled, true);
  r.context.__WRD_SHELL__.acknowledgeStartClick();
  await r.WebRTC.startViewer(r.controllers[0]);
  assert.equal(r.signals(), 0, 'unavailable auth cannot open signaling');
  assert.equal(r.inits(), 0);
  assert.equal(r.tokens.get('wrd_token'), 'fixture-token');
  verified = true;
  await r.nodes.get('auth-retry').children[0].listeners.click();
  assert.equal(r.nodes.get('startBtn').disabled, false);
  assert.equal(r.signals(), 0, 'verification retry must not replay Start');
  await r.context.__WRD_SHELL__.acknowledgeStartClick();
  assert.equal(r.signals(), 1);
  assert.equal(r.controllers[0].getSnapshot().state, 'failed');
  assert.equal(r.tokens.get('wrd_token'), 'fixture-token');
  assert.equal(r.context.location.href, 'viewer.html');
  assert.equal(r.inits(), 0);
});

test('the actual bootstrap application Invalid token JSON still clears credentials', async () => {
  const r = runtime({ verify: () => json(200, { valid: true }), bootstrap: () => json(401, { error: 'Invalid token' }) });
  await flush();
  await r.context.__WRD_SHELL__.acknowledgeStartClick();
  assert.equal(r.controllers[0].getSnapshot().state, 'auth-required');
  assert.equal(r.tokens.has('wrd_token'), false);
  assert.equal(r.context.location.href, 'index.html');
  assert.equal(r.inits(), 0);
});

test('a late bootstrap application401 from a previous auth generation cannot clear a newer token', async () => {
  let resolveOld;
  let calls = 0;
  const r = runtime({ verify: () => json(200, { valid: true }), bootstrap: () => ++calls === 1
    ? json(200, { schemaVersion: 1, webrtc: {} })
    : new Promise((resolve) => { resolveOld = resolve; }) });
  await flush();
  const start = r.context.__WRD_SHELL__.acknowledgeStartClick();
  await flush();
  r.Auth.setToken('new-token');
  resolveOld(json(401, { error: 'Invalid token' }));
  await start;
  assert.equal(r.tokens.get('wrd_token'), 'new-token');
  assert.equal(r.context.location.href, 'viewer.html');
});

test('successful old bootstrap cannot initialize a newer unverified auth generation', async () => {
  let resolveOld;
  let calls = 0;
  const r = runtime({ verify: () => json(200, { valid: true }), bootstrap: () => ++calls === 1
    ? json(200, { schemaVersion: 1, webrtc: {} })
    : new Promise((resolve) => { resolveOld = resolve; }) });
  await flush();
  const start = r.context.__WRD_SHELL__.acknowledgeStartClick();
  await flush();
  r.Auth.setToken('new-token');
  resolveOld(json(200, { schemaVersion: 1, webrtc: {} }));
  await start;
  assert.equal(r.inits(), 0);
  assert.equal(r.nodes.get('startBtn').disabled, true);
  assert.equal(r.tokens.get('wrd_token'), 'new-token');
});
