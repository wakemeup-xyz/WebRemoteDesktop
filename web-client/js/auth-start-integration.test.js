'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const json = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const proxy403 = () => ({ status: 403, ok: false, json: async () => { throw new SyntaxError('proxy HTML'); } });
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

function runtime({ verify = () => proxy403(), bootstrap = () => proxy403(), proof = false,
  readyState = 'loading', dispatchReady = true } = {}) {
  const nodes = new Map();
  const domReady = [];
  const tokens = new Map([['wrd_token', 'fixture-token']]);
  if (proof) tokens.set('wrdProofAdmission', JSON.stringify({ proof: 'fixture-proof' }));
  const requests = [], failures = [], controllers = [];
  let signals = 0, inits = 0, admissions = 0, time = 0;
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
    AbortController, queueMicrotask,
    console: { log() {}, warn() {}, error() {} },
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { throw new Error('unexpected live interval'); }, clearInterval() {},
    performance: { now: () => time }, navigator: {},
    addEventListener() {},
    document: {
      readyState, body: element(),
      createElement: element, getElementById(id) { return nodes.get(id) || null; },
      querySelector() { return null; }, querySelectorAll() { return []; },
      addEventListener(name, listener) { if (name === 'DOMContentLoaded') domReady.push(listener); },
    },
    location: { href: 'viewer.html', origin: 'http://fixture' },
    RuntimeConfig: { getApiBase: () => 'http://fixture' },
    sessionStorage: { getItem(key) { return tokens.get(key) || null; }, setItem(key, value) { tokens.set(key, value); }, removeItem(key) { tokens.delete(key); } },
    localStorage: { getItem() { return null; }, removeItem() {}, setItem() {} },
    fetch: async (url, options) => {
      if (url.endsWith('/api/auth/viewer-admission')) {
        admissions++;
        return json(201, { admission: { ticket: 'fixture-ticket' } });
      }
      requests.push(url.endsWith('/api/auth/verify') ? 'verify' : 'bootstrap');
      return url.endsWith('/api/auth/verify') ? verify() : bootstrap({ url, options });
    },
    io() { throw new Error('integration fixture must not open a real Viewer'); },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'shell-guard.js'), 'utf8'), context);
  // Join the real dependencies in production desktop-core declaration order.
  // In interactive/defer mode WebRTC must wait for the later ChromeLayout declaration.
  const { desktopScripts } = require('../../signal-server/scripts/web-asset-graph.js');
  const included = new Set(['bounded-request.js', 'auth.js', 'bootstrap-controller.js', 'webrtc.js', 'chrome-layout.js']);
  if (readyState === 'interactive') context.__WRD_ASSETS__ = {};
  vm.runInContext(desktopScripts.filter((file) => included.has(path.basename(file)))
    .map((file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')).join('\n;\n'), context);
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
  let readyDispatched = false;
  function dispatchDOMContentLoaded() {
    if (readyDispatched) throw new Error('DOMContentLoaded already dispatched');
    readyDispatched = true;
    context.document.readyState = 'interactive';
    domReady.forEach((listener) => listener());
  }
  if (dispatchReady) dispatchDOMContentLoaded();
  return { Auth, WebRTC, context, nodes, tokens, requests, failures, controllers,
    signals: () => signals, inits: () => inits, admissions: () => admissions,
    dispatchDOMContentLoaded,
    setTime(value) { time = value; } };
}

for (const proof of [false, true]) {
  test(`completed warmup is reused by verified Start with ${proof ? 'proof' : 'fresh explicit'} admission`, async () => {
    const ready = { schemaVersion: 1, webrtc: { iceServers: [] } };
    const r = runtime({ proof, verify: () => json(200, { valid: true }),
      bootstrap: () => json(200, ready) });
    await flush();
    assert.equal(r.controllers[0].getSnapshot().state, 'ready');
    assert.equal(r.requests.filter((item) => item === 'bootstrap').length, 1);
    r.setTime(200);
    await r.context.__WRD_SHELL__.acknowledgeStartClick();
    assert.equal(r.requests.filter((item) => item === 'bootstrap').length, 1);
    assert.equal(r.admissions(), proof ? 0 : 1);
    assert.equal(r.inits(), 1);
    assert.equal(r.signals(), 1);
  });
}


for (const proof of [false, true]) {
  test(`production defer boot waits for verified warmup, then reuses it with ${proof ? 'proof' : 'fresh explicit'} admission`, async () => {
    let resolveVerify;
    let warmupGeneration;
    let warmupUrl;
    const r = runtime({ proof, readyState: 'interactive', dispatchReady: false,
      verify: () => new Promise((resolve) => { resolveVerify = resolve; }),
      bootstrap: ({ url }) => {
        warmupUrl = url;
        warmupGeneration = r.Auth.getGeneration();
        return json(200, { schemaVersion: 1, webrtc: { iceServers: [] } });
      } });
    // The deferred bundle's boot microtask runs BEFORE DOMContentLoaded.
    await flush();
    assert.equal(r.context.__WRD_SHELL__.snapshot().coreInstalled, true);
    assert.equal(r.Auth.getGeneration(), 0);
    assert.equal(r.Auth.isVerified(), false);
    assert.equal(r.requests.filter((item) => item === 'bootstrap').length, 0,
      'unverified production boot must not request bootstrap');
    assert.equal(r.signals(), 0);
    assert.equal(r.inits(), 0);
    assert.equal(r.admissions(), 0);
    r.dispatchDOMContentLoaded();
    await flush();
    assert.equal(r.Auth.getGeneration(), 1);
    assert.deepEqual(r.requests, ['verify']);
    assert.equal(r.nodes.get('startBtn').disabled, true);
    assert.equal(r.context.__WRD_SHELL__.acknowledgeStartClick(), false);
    // Select settings while verification is pending: warmup must read them now.
    r.WebRTC.networkMode = 'auto';
    r.WebRTC.selectedTurnServerId = 'current-turn';
    resolveVerify(json(200, { valid: true }));
    await flush();
    assert.equal(warmupGeneration, 1);
    assert.equal(warmupUrl, 'http://fixture/api/viewer-bootstrap?turnServerId=current-turn');
    assert.equal(r.controllers[0].getSnapshot().state, 'ready');
    assert.deepEqual(r.requests, ['verify', 'bootstrap']);
    assert.equal(r.signals(), 0, 'verification and warmup must not start a Viewer');
    assert.equal(r.admissions(), 0);
    r.setTime(200);
    await r.context.__WRD_SHELL__.acknowledgeStartClick();
    assert.deepEqual(r.requests, ['verify', 'bootstrap']);
    assert.equal(r.admissions(), proof ? 0 : 1);
    assert.equal(r.signals(), 1);
    assert.equal(r.inits(), 1);
  });
}

test('production Start shares the pending verified warmup without an automatic connection', async () => {
  let resolveWarmup;
  const r = runtime({ readyState: 'interactive', dispatchReady: false,
    verify: () => json(200, { valid: true }),
    bootstrap: () => new Promise((resolve) => { resolveWarmup = resolve; }) });
  await flush();
  assert.deepEqual(r.requests, []);
  r.dispatchDOMContentLoaded();
  await flush();
  assert.equal(r.controllers[0].getSnapshot().state, 'loading');
  r.Auth._publishCheck({ state: 'verified', reason: 'ok', httpStatus: 200 });
  assert.deepEqual(r.requests, ['verify', 'bootstrap']);
  assert.equal(r.signals(), 0);
  assert.equal(r.admissions(), 0);
  const start = r.context.__WRD_SHELL__.acknowledgeStartClick();
  await flush();
  assert.deepEqual(r.requests, ['verify', 'bootstrap']);
  assert.equal(r.admissions(), 1);
  assert.equal(r.signals(), 1);
  assert.equal(r.inits(), 0);
  resolveWarmup(json(200, { schemaVersion: 1, webrtc: { iceServers: [] } }));
  await start;
  assert.deepEqual(r.requests, ['verify', 'bootstrap']);
  assert.equal(r.inits(), 1);
});

test('unavailable verify gates shell and direct Start; explicit verify retry enables only a new click, and proxy bootstrap403 preserves token', async () => {
  let verified = false;
  const r = runtime({ verify: () => verified ? json(200, { valid: true }) : proxy403() });
  await flush();
  assert.equal(r.tokens.get('wrd_token'), 'fixture-token');
  assert.equal(r.nodes.get('startBtn').disabled, true);
  assert.deepEqual(r.requests, ['verify'], 'unavailable verification must not preload');
  r.context.__WRD_SHELL__.acknowledgeStartClick();
  await r.WebRTC.startViewer(r.controllers[0]);
  assert.equal(r.signals(), 0, 'unavailable auth cannot open signaling');
  assert.equal(r.inits(), 0);
  assert.equal(r.tokens.get('wrd_token'), 'fixture-token');
  verified = true;
  await r.nodes.get('auth-retry').children[0].listeners.click();
  assert.equal(r.nodes.get('startBtn').disabled, false);
  assert.equal(r.signals(), 0, 'verification retry must not replay Start');
  assert.deepEqual(r.requests, ['verify', 'verify', 'bootstrap']);
  assert.equal(r.admissions(), 0);
  assert.equal(r.inits(), 0);
  await r.context.__WRD_SHELL__.acknowledgeStartClick();
  assert.equal(r.signals(), 1);
  assert.equal(r.controllers[0].getSnapshot().state, 'failed');
  assert.equal(r.tokens.get('wrd_token'), 'fixture-token');
  assert.equal(r.context.location.href, 'viewer.html');
  assert.equal(r.inits(), 0);
});

test('already-verified boot warms once despite synchronous subscription and repeated verified publication', async () => {
  const r = runtime({ dispatchReady: false, verify: () => json(200, { valid: true }),
    bootstrap: () => json(200, { schemaVersion: 1, webrtc: {} }) });
  await r.Auth.init();
  assert.deepEqual(r.requests, ['verify']);
  // Auth.subscribe immediately invokes its listener with the current verified check.
  r.context.bootViewerShell();
  await flush();
  assert.equal(r.context.__WRD_SHELL__.snapshot().coreInstalled, true);
  assert.equal(r.controllers[0].getSnapshot().state, 'ready');
  r.Auth._publishCheck({ state: 'verified', reason: 'ok', httpStatus: 200 });
  r.Auth._publishCheck({ state: 'verified', reason: 'ok', httpStatus: 200 });
  await flush();
  assert.deepEqual(r.requests, ['verify', 'bootstrap']);
  r.Auth.setToken('replacement-token');
  await r.Auth.init();
  await flush();
  assert.deepEqual(r.requests, ['verify', 'bootstrap', 'verify'],
    'later generations do not create another automatic warmup');
  assert.equal(r.admissions(), 0);
  assert.equal(r.signals(), 0);
  assert.equal(r.inits(), 0);
});

test('unauthorized production verification does not preload or start and preserves logout effects', async () => {
  const r = runtime({ readyState: 'interactive', dispatchReady: false,
    verify: () => json(401, { valid: false, error: 'Invalid token' }) });
  await flush();
  r.dispatchDOMContentLoaded();
  await flush();
  assert.deepEqual(r.requests, ['verify']);
  assert.equal(r.Auth.getCheck().state, 'unauthorized');
  assert.equal(r.tokens.has('wrd_token'), false);
  assert.equal(r.context.location.href, 'index.html');
  assert.equal(r.nodes.get('startBtn').disabled, true);
  assert.equal(r.context.__WRD_SHELL__.acknowledgeStartClick(), false);
  assert.equal(r.admissions(), 0);
  assert.equal(r.signals(), 0);
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
  r.setTime(3000);
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
  r.setTime(3000);
  const start = r.context.__WRD_SHELL__.acknowledgeStartClick();
  await flush();
  r.Auth.setToken('new-token');
  resolveOld(json(200, { schemaVersion: 1, webrtc: {} }));
  await start;
  assert.equal(r.inits(), 0);
  assert.equal(r.nodes.get('startBtn').disabled, true);
  assert.equal(r.tokens.get('wrd_token'), 'new-token');
});

test('a successful bootstrap response from an old auth generation is fenced before ready publication', async () => {
  let resolveOld;
  let calls = 0;
  const r = runtime({ verify: () => json(200, { valid: true }), bootstrap: () => ++calls === 1
    ? new Promise((resolve) => { resolveOld = resolve; })
    : json(200, { schemaVersion: 1, webrtc: {} }) });
  await flush();
  r.Auth.setToken('new-token');
  resolveOld(json(200, { schemaVersion: 1, webrtc: { selectedTurnServerId: 'old' } }));
  await flush();
  assert.notEqual(r.controllers[0].getSnapshot().state, 'ready');
  assert.equal((await r.controllers[0].load({ mode: 'relay' })).webrtc.selectedTurnServerId, undefined);
  assert.equal(calls, 2);
});
