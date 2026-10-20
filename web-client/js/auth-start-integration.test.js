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
  readyState = 'loading', dispatchReady = true, search = '',
  admission = () => json(201, { admission: { ticket: 'fixture-ticket' } }), actualSignaling = false } = {}) {
  const nodes = new Map();
  const domReady = [];
  const tokens = new Map([['wrd_token', 'fixture-token']]);
  if (proof) tokens.set('wrdProofAdmission', JSON.stringify({ proof: 'fixture-proof' }));
  const requests = [], failures = [], controllers = [];
  let signals = 0, inits = 0, admissions = 0, time = 0, nextTimer = 0;
  const timers = new Map(), admissionRequests = [], sockets = [];
  function element() {
    const classes = new Set();
    return {
      style: {}, dataset: {}, children: [], listeners: {}, disabled: false,
      classList: { add(...names) { names.forEach((name) => classes.add(name)); }, remove(...names) { names.forEach((name) => classes.delete(name)); }, contains(name) { return classes.has(name); } },
      setAttribute() {},
      appendChild(child) { this.children.push(child); if (child.id) nodes.set(child.id, child); },
      append(...children) { children.forEach((child) => this.appendChild(child)); },
      remove() { nodes.delete(this.id); },
      addEventListener(name, listener) { this.listeners[name] = listener; },
    };
  }
  for (const id of ['startBtn', 'loading', 'loadingText']) nodes.set(id, element());
  const context = {
    AbortController, queueMicrotask, URLSearchParams,
    console: { log() {}, warn() {}, error() {} },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { throw new Error('unexpected live interval'); }, clearInterval() {},
    performance: { now: () => time }, navigator: {},
    addEventListener() {},
    document: {
      readyState, body: element(),
      createElement: element, getElementById(id) { return nodes.get(id) || null; },
      querySelector() { return null; }, querySelectorAll() { return []; },
      addEventListener(name, listener) { if (name === 'DOMContentLoaded') domReady.push(listener); },
    },
    location: { href: 'viewer.html', origin: 'http://fixture', search },
    RuntimeConfig: { getApiBase: () => 'http://fixture', getSocketBase: () => 'http://fixture' },
    sessionStorage: { getItem(key) { return tokens.get(key) || null; }, setItem(key, value) { tokens.set(key, value); }, removeItem(key) { tokens.delete(key); } },
    localStorage: { getItem() { return null; }, removeItem() {}, setItem() {} },
    fetch: async (url, options) => {
      if (url.endsWith('/api/auth/viewer-admission')) {
        admissions++;
        admissionRequests.push({ url, options });
        return admission({ url, options });
      }
      requests.push(url.endsWith('/api/auth/verify') ? 'verify' : 'bootstrap');
      return url.endsWith('/api/auth/verify') ? verify() : bootstrap({ url, options });
    },
    io(_url, options) {
      signals++;
      const listeners = new Map();
      const socket = { auth: options.auth, connected: true, io: {},
        on(event, handler) { listeners.set(event, handler); }, emit() {}, disconnect() {},
        dispatch(event, data) { return listeners.get(event)?.(data); } };
      sockets.push(socket);
      return socket;
    },
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
  if (!actualSignaling) WebRTC.createSignalingSocket = () => { signals++; };
  WebRTC.init = async () => { inits++; };
  const enterBootstrapFailure = WebRTC.enterBootstrapFailure;
  WebRTC.enterBootstrapFailure = (error) => {
    failures.push(error.code);
    if (actualSignaling) return enterBootstrapFailure.call(WebRTC, error);
  };
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
    signals: () => signals, inits: () => inits, admissions: () => admissions, admissionRequests, sockets,
    expireRequest() {
      const entry = [...timers].find(([, timer]) => timer.delay === 5000);
      assert.ok(entry, 'real bounded admission request has a deadline');
      timers.delete(entry[0]); entry[1].callback();
    },
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


function guardedRuntime(options = {}) {
  return runtime({ search: '?wrdAdmission=vacant-only-v1', actualSignaling: true,
    verify: () => json(200, { valid: true }),
    bootstrap: () => json(200, { schemaVersion: 1, webrtc: {} }), ...options });
}

for (const search of ['?wrdAdmission=', '?wrdAdmission=unknown',
  '?wrdAdmission=vacant-only-v1&wrdAdmission=vacant-only-v1',
  '?wrdAdmission=vacant-only-v1&wrdAdmission=unknown']) {
  test(`invalid initial selector rejects real Start before admission or io: ${search}`, async () => {
    const r = guardedRuntime({ search });
    await flush();
    await r.context.__WRD_SHELL__.acknowledgeStartClick();
    assert.deepEqual(r.failures, ['invalid-initial-policy']);
    assert.equal(r.admissions(), 0);
    assert.equal(r.signals(), 0);
    assert.equal(r.inits(), 0);
  });
}

test('unreadable selector location reports the fixed parser error', async () => {
  const r = guardedRuntime();
  await flush();
  Object.defineProperty(r.context.location, 'search', { get() { throw new Error('private-location'); } });
  assert.throws(() => r.WebRTC.readInitialAdmissionPolicy(),
    { code: 'invalid-initial-policy', message: '桌面连接授权暂不可用，请手动重试' });
  assert.equal(r.admissions(), 0);
  assert.equal(r.signals(), 0);
});

for (const proof of ['{malformed', 'null', '{}']) {
  test(`proof marker plus guarded selector rejects before API or io (${proof})`, async () => {
    const r = guardedRuntime();
    r.tokens.set('wrdProofAdmission', proof);
    await flush();
    await r.context.__WRD_SHELL__.acknowledgeStartClick();
    assert.deepEqual(r.failures, ['invalid-initial-policy']);
    assert.equal(r.admissions(), 0);
    assert.equal(r.signals(), 0);
    assert.equal(r.inits(), 0);
  });
}

for (const [search, guarded] of [['', false], ['?unrelated=1', false], ['?wrdAdmission=vacant-only-v1', true]]) {
  test(`real Start sends exactly the ${guarded ? 'guarded' : 'existing human'} admission body: ${search}`, async () => {
    const r = guardedRuntime({ search });
    await flush();
    await r.context.__WRD_SHELL__.acknowledgeStartClick();
    const expected = { viewerSessionId: r.WebRTC.resolveViewerSessionId() };
    if (guarded) expected.initialPolicy = 'vacant-only-v1';
    assert.equal(r.admissions(), 1);
    assert.deepEqual(JSON.parse(r.admissionRequests[0].options.body), expected);
    assert.equal(r.signals(), 1);
    assert.equal(r.inits(), 1);
    assert.equal(r.WebRTC._viewerAdmission.ticket, 'fixture-ticket');
  });
}

test('malformed proof-only marker preserves existing proof socket branch', async () => {
  const r = guardedRuntime({ search: '' });
  r.tokens.set('wrdProofAdmission', '{malformed');
  await flush();
  await r.context.__WRD_SHELL__.acknowledgeStartClick();
  assert.equal(r.admissions(), 0);
  assert.equal(r.signals(), 1);
  assert.equal(r.sockets[0].auth.proofAdmission.invalid, true);
  assert.equal(Object.hasOwn(r.sockets[0].auth, 'viewerAdmission'), false);
});

for (const [name, mutate] of [
  ['selector removed', (r) => { r.context.location.search = ''; }],
  ['selector changed', (r) => { r.context.location.search = '?wrdAdmission=unknown'; }],
  ['selector duplicated', (r) => { r.context.location.search += '&wrdAdmission=vacant-only-v1'; }],
  ['proof appeared', (r) => { r.tokens.set('wrdProofAdmission', '{malformed'); }],
  ['episode cancelled', (r) => { r.WebRTC.retireStartupEpisode('cancelled'); }],
  ['new auth generation with same token', async (r) => { r.Auth.setToken('fixture-token'); await r.Auth.init(); }],
  ['logout and login', async (r) => { r.Auth.logout(); r.Auth.setToken('fixture-token'); await r.Auth.init(); }],
]) {
  test(`late guarded admission cannot publish or connect after ${name}`, async () => {
    let complete;
    const r = guardedRuntime({ admission: () => new Promise((resolve) => { complete = resolve; }) });
    await flush();
    const retained = r.WebRTC._viewerAdmission = { mode: 'resume', generation: 'retained-owner' };
    const start = r.context.__WRD_SHELL__.acknowledgeStartClick();
    await flush();
    assert.equal(r.admissions(), 1);
    await mutate(r);
    complete(json(201, { admission: { ticket: 'late-ticket' } }));
    await start;
    await flush();
    assert.equal(r.WebRTC._viewerAdmission, retained);
    assert.equal(r.signals(), 0);
    assert.equal(r.inits(), 0);
    assert.equal(r.admissions(), 1, 'no fallback or remint after response rejection');
  });
}

test('older request sequence cannot overwrite a newer admission', async () => {
  let complete;
  let calls = 0;
  const r = guardedRuntime({ admission: () => ++calls === 1
    ? new Promise((resolve) => { complete = resolve; })
    : json(201, { admission: { ticket: 'newer-ticket' } }) });
  await flush();
  const episode = r.WebRTC.beginStartupEpisode();
  const older = r.WebRTC.requestExplicitViewerAdmission(episode);
  await flush();
  await r.WebRTC.requestExplicitViewerAdmission(episode);
  const newer = r.WebRTC._viewerAdmission;
  complete(json(201, { admission: { ticket: 'older-ticket' } }));
  await assert.rejects(older, { code: 'superseded' });
  assert.equal(r.WebRTC._viewerAdmission, newer);
  assert.equal(newer.ticket, 'newer-ticket');
  assert.equal(r.signals(), 0);
});

for (const failure of ['HTTP denial', 'timeout']) {
  test(`guarded ${failure} stops without automatic reclaim or unrestricted fallback`, async () => {
    let complete;
    const r = guardedRuntime({ admission: () => failure === 'timeout'
      ? new Promise((resolve) => { complete = resolve; }) : json(409, { error: 'human-owner-retained' }) });
    await flush();
    const retained = r.WebRTC._viewerAdmission = { mode: 'resume', generation: 'retained-owner' };
    const start = r.context.__WRD_SHELL__.acknowledgeStartClick();
    await flush();
    if (failure === 'timeout') r.expireRequest();
    await start;
    if (complete) complete(json(201, { admission: { ticket: 'after-timeout-ticket' } }));
    r.Auth._publishCheck({ state: 'verified', reason: 'ok', httpStatus: 200 });
    await flush();
    assert.equal(r.failures.length, 1);
    if (failure === 'timeout') assert.equal(r.failures[0], 'timeout');
    assert.equal(r.WebRTC._viewerAdmission, retained);
    assert.equal(r.admissions(), 1);
    assert.equal(r.signals(), 0);
    assert.equal(r.inits(), 0);
    assert.equal(JSON.parse(r.admissionRequests[0].options.body).initialPolicy, 'vacant-only-v1');
  });
}

test('duplicate UI Start shares one guarded admission and one socket', async () => {
  let complete;
  const r = guardedRuntime({ admission: () => new Promise((resolve) => { complete = resolve; }) });
  await flush();
  const start = r.context.__WRD_SHELL__.acknowledgeStartClick();
  const duplicate = r.context.__WRD_SHELL__.acknowledgeStartClick();
  await flush();
  assert.equal(r.admissions(), 1);
  complete(json(201, { admission: { ticket: 'one-ticket' } }));
  await Promise.all([start, duplicate]);
  assert.equal(r.admissions(), 1);
  assert.equal(r.signals(), 1);
  assert.equal(r.inits(), 1);
});

test('actual ordinary welcome updates Socket.IO resume auth and reconnect requests no ticket', async () => {
  let completeBootstrap;
  const r = guardedRuntime({ bootstrap: () => new Promise((resolve) => { completeBootstrap = resolve; }) });
  await flush();
  const start = r.context.__WRD_SHELL__.acknowledgeStartClick();
  await flush();
  const socket = r.sockets[0];
  assert.ok(socket);
  assert.equal(socket.auth.viewerAdmission.ticket, 'fixture-ticket');
  socket.dispatch('connected', { hostOnline: false, viewerAdmission: { mode: 'resume', generation: 'ordinary-generation' } });
  assert.deepEqual(JSON.parse(JSON.stringify(socket.auth.viewerAdmission)), { mode: 'resume', generation: 'ordinary-generation' });
  assert.equal(socket.auth.viewerAdmission, r.WebRTC._viewerAdmission);
  await socket.dispatch('connect');
  await socket.dispatch('connect');
  assert.equal(r.admissions(), 1);
  assert.equal(r.signals(), 1);
  completeBootstrap(json(200, { schemaVersion: 1, webrtc: {} }));
  await start;
  assert.equal(r.admissions(), 1);
});


for (const [search, guarded] of [['', false], ['?wrdAdmission=vacant-only-v1', true]]) {
  test(`explicit manual reconnect selects the ${guarded ? 'guarded' : 'human'} policy`, async () => {
    const r = guardedRuntime({ search });
    await flush();
    // Tunnel avoids native PeerConnection effects; admission and reclaim stay real.
    r.WebRTC.networkMode = 'tunnel';
    r.nodes.set('remoteVideo', r.context.document.createElement('video'));
    await r.WebRTC.reclaimDesktopSession();
    const expected = { viewerSessionId: r.WebRTC.resolveViewerSessionId() };
    if (guarded) expected.initialPolicy = 'vacant-only-v1';
    assert.deepEqual(JSON.parse(r.admissionRequests[0].options.body), expected);
    assert.equal(r.admissions(), 1);
    assert.equal(r.signals(), 1);
    assert.equal(r.WebRTC._viewerAdmission.ticket, 'fixture-ticket');
  });
}

test('Socket.IO admission denial disables the current owner without automatic remint', async () => {
  const r = guardedRuntime();
  await flush();
  await r.context.__WRD_SHELL__.acknowledgeStartClick();
  const socket = r.sockets[0];
  socket.dispatch('viewer-admission-rejected', { reason: 'explicit-reconnect-required' });
  await flush();
  assert.equal(r.WebRTC._viewerAdmission, null);
  assert.equal(r.WebRTC._superseded, true);
  assert.equal(r.WebRTC.socket, null);
  assert.equal(r.admissions(), 1);
  assert.equal(r.signals(), 1);
  assert.equal(r.WebRTC.createSignalingSocket(true), null);
  assert.equal(r.admissions(), 1);
  assert.equal(r.signals(), 1);
});
