'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createAssetLoader, createManifestVersionCheck } = require('./asset-loader');

function fixture() {
  const nodes = [], timers = new Map();
  let serial = 0;
  const document = { createElement: (tag) => ({ tag }), head: { appendChild: (node) => nodes.push(node) } };
  return { nodes, timers, document,
    setTimer(fn) { const id = ++serial; timers.set(id, fn); return id; },
    clearTimer(id) { timers.delete(id); },
    tick() { const active = [...timers.values()]; timers.clear(); active.forEach((fn) => fn()); },
  };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

test('deadline bounds each waiter while one unknown classic script stays pending', async () => {
  const f = fixture();
  const loader = createAssetLoader(f);
  assert.equal(loader.status('/tools.js'), 'idle');
  const first = loader.load({ url: '/tools.js', kind: 'script' });
  const rejected = assert.rejects(first, /timed out/);
  await flush();
  assert.equal(f.nodes.length, 1);
  f.tick();
  await rejected;
  assert.equal(loader.status('/tools.js'), 'loading');
  const second = loader.load({ url: '/tools.js', kind: 'script' });
  await flush();
  assert.equal(f.nodes.length, 1);
  f.nodes[0].onload();
  await second;
  assert.equal(loader.status('/tools.js'), 'loaded');
  await loader.load({ url: '/tools.js', kind: 'script' });
  assert.equal(f.nodes.length, 1);
  assert.equal(f.timers.size, 0);
});

test('confirmed CSS error retries just that resource and caches success', async () => {
  const f = fixture();
  const loader = createAssetLoader(f);
  const first = loader.load({ url: '/tools.css', kind: 'style' });
  const rejected = assert.rejects(first, /network error/);
  await flush();
  f.nodes[0].onerror();
  await rejected;
  assert.equal(loader.status('/tools.css'), 'error');
  const retry = loader.load({ url: '/tools.css', kind: 'style' });
  await flush();
  assert.equal(f.nodes.length, 2);
  f.nodes[1].onload();
  await retry;
  assert.equal(loader.status('/tools.css'), 'loaded');
});

test('a short waiter cannot expire another caller or settle the resource as error', async () => {
  const f = fixture();
  const loader = createAssetLoader(f);
  const first = loader.load({ url: '/shared.js', kind: 'script', timeoutMs: 1 });
  const rejected = assert.rejects(first, /timed out/);
  const second = loader.load({ url: '/shared.js', kind: 'script', timeoutMs: 5000 });
  await flush();
  [...f.timers.values()][0]();
  await rejected;
  f.nodes[0].onload();
  await second;
  assert.equal(f.nodes.length, 1);
});

function deferredFixture({ versionCheck } = {}) {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const f = fixture();
  let init = 0, reloads = 0, confirmations = 0;
  const button = {};
  f.document.getElementById = () => button;
  const context = { document: f.document, Promise, console: { warn() {} }, WebRTC: { renderPortSearchStatus() {} },
    window: { __WRD_ASSETS__: { desktopDeferredJs: '/tools.js' },
      confirm() { confirmations++; return true; }, location: { reload() { reloads++; } } },
    createAssetLoader: (options) => createAssetLoader({ ...options, versionCheck, setTimer: f.setTimer, clearTimer: f.clearTimer }),
    Diagnostic: { markDeferredLoading() { this.panelState = 'loading'; },
      markDeferredFailed(retry) { this.panelState = 'failed'; this.retry = retry; } },
  };
  const source = fs.readFileSync(path.join(__dirname, 'webrtc.js'), 'utf8');
  const start = source.indexOf('  // Non-critical operator tools:');
  const end = source.indexOf('  const TerminalLoader =', start);
  vm.runInNewContext(source.slice(start, end), context);
  return { ...f, context, button,
    register() {
      Object.assign(context.Diagnostic, { openPanel() {}, init() { init++; this.panelState = 'ready'; } });
      context.LatencyMonitor = {}; context.TurnSelfTest = {}; context.StunPortSearchController = {};
    },
    get initCalls() { return init; }, get reloads() { return reloads; }, get confirmations() { return confirmations; },
  };
}

test('production deferred adapter deadline isolates late load then explicit retry initializes once', async () => {
  const f = deferredFixture();
  await flush();
  f.tick();
  await flush();
  assert.equal(f.context.WebRTC._operatorToolsState, 'failed');
  f.register();
  f.nodes[0].onload();
  await flush();
  assert.equal(f.initCalls, 0);
  assert.equal(f.context.WebRTC._operatorToolsState, 'failed');
  f.context.WebRTC._retryOperatorTools();
  await flush();
  assert.equal(f.initCalls, 1);
  assert.equal(f.context.WebRTC._operatorToolsState, 'ready');
  assert.equal(f.nodes.length, 1);
});

test('deferred adapter retry shares still pending script and confirmed error permits a replacement', async () => {
  const f = deferredFixture();
  await flush();
  f.tick();
  await flush();
  f.context.WebRTC._retryOperatorTools();
  await flush();
  assert.equal(f.nodes.length, 1);
  f.nodes[0].onerror();
  await flush();
  f.context.WebRTC._retryOperatorTools();
  await flush();
  assert.equal(f.nodes.length, 2);
  f.register();
  f.nodes[1].onload();
  await flush();
  assert.equal(f.initCalls, 1);
});

test('incompletely registered deferred module exposes user refresh without another classic execution', async () => {
  const f = deferredFixture();
  await flush();
  f.nodes[0].onload();
  await flush();
  assert.equal(f.context.WebRTC._operatorToolsState, 'failed');
  assert.equal(f.reloads, 0);
  assert.match(f.button.textContent, /刷新/);
  f.context.WebRTC._retryOperatorTools();
  assert.equal(f.confirmations, 1);
  assert.equal(f.reloads, 1);
  assert.equal(f.nodes.length, 1);
});

function release(buildId) {
  return { buildId, builtAt: 1000, assets: { terminalJs: 'assets/terminal.0123456789abcdef.js' } };
}
const OLD_BUILD = { id: 'aaaaaaaaaaaaaaaa', builtAt: 1 };

test('one manifest query distinguishes current/retained/retired builds without changing core', async () => {
  for (const [current, history, retired] of [
    [OLD_BUILD.id, [], false], ['bbbbbbbbbbbbbbbb', [release(OLD_BUILD.id)], false],
    ['bbbbbbbbbbbbbbbb', [], true],
  ]) {
    let calls = 0;
    const check = createManifestVersionCheck({ build: OLD_BUILD, fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, '/asset-manifest.json');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.credentials, 'same-origin');
      return { ok: true, status: 200, json: async () => ({ schemaVersion: 2, ...release(current), retainedReleases: history }) };
    } });
    const first = check();
    assert.equal(check(), first);
    assert.equal(await first, retired);
    assert.equal(await check(), retired);
    assert.equal(calls, 1);
  }
});

test('manifest check has an at-most-8000ms body deadline and ignores late success', async () => {
  const f = fixture();
  let finish, calls = 0, duration, aborted = false;
  const check = createManifestVersionCheck({ build: OLD_BUILD, timeoutMs: 90000,
    setTimer(fn, delay) { duration = delay; return f.setTimer(fn); }, clearTimer: f.clearTimer,
    fetchImpl: async (_url, { signal }) => {
      calls++; signal.addEventListener('abort', () => { aborted = true; });
      return { ok: true, status: 200, json: () => new Promise((resolve) => { finish = resolve; }) };
    },
  });
  const first = check();
  await flush();
  assert.equal(duration, 8000);
  f.tick();
  assert.equal(await first, false);
  assert.equal(aborted, true);
  finish({ schemaVersion: 2, ...release('bbbbbbbbbbbbbbbb'), retainedReleases: [] });
  await flush();
  assert.equal(await check(), false);
  assert.equal(calls, 1);
  assert.equal(f.timers.size, 0);
});

test('unknown or malformed manifest never asserts eviction', async () => {
  for (const response of [
    { ok: false, status: 403, json: async () => ({}) },
    { ok: true, status: 200, json: async () => { throw Error('proxy HTML'); } },
    { ok: true, status: 200, json: async () => ({ schemaVersion: 1, assets: {} }) },
    { ok: true, status: 200, json: async () => ({ schemaVersion: 2, ...release('bbbbbbbbbbbbbbbb'), retainedReleases: [release('../bad')] }) },
    { ok: true, status: 200, json: async () => ({ schemaVersion: 2, ...release('bbbbbbbbbbbbbbbb'), assets: { terminalJs: '../escape.js' }, retainedReleases: [] }) },
  ]) {
    const check = createManifestVersionCheck({ build: OLD_BUILD, fetchImpl: async () => response });
    assert.equal(await check(), false);
  }
});

test('retirement result exposes explicit refresh and prevents repeated failed hash requests', async () => {
  const f = fixture();
  let report = null, finish;
  const check = createManifestVersionCheck({ build: OLD_BUILD, fetchImpl: () => new Promise((resolve) => { finish = resolve; }) });
  const loader = createAssetLoader({ ...f, versionCheck: check, onRefreshRequired(error) { report = error; } });
  const failure = assert.rejects(loader.load({ url: '/tools.js', kind: 'script' }), /network error/);
  await flush();
  f.nodes[0].onerror();
  await failure;
  assert.equal(report, null);
  finish({ ok: true, status: 200, json: async () => ({ schemaVersion: 2, ...release('bbbbbbbbbbbbbbbb'), retainedReleases: [] }) });
  await flush();
  assert.equal(report.code, 'refresh-required');
  await assert.rejects(loader.load({ url: '/tools.js', kind: 'script' }), { code: 'refresh-required' });
  assert.equal(f.nodes.length, 1);
});

test('production deferred adapter offers refresh on retired build only after explicit user action', async () => {
  let finish;
  const check = new Promise((resolve) => { finish = resolve; });
  const f = deferredFixture({ versionCheck: () => check });
  await flush();
  f.nodes[0].onerror();
  await flush();
  assert.equal(f.context.WebRTC._operatorToolsState, 'failed');
  finish(true);
  await flush();
  assert.match(f.button.textContent, /刷新/);
  assert.equal(f.reloads, 0);
  assert.equal(f.confirmations, 0);
  f.context.WebRTC._retryOperatorTools();
  assert.equal(f.reloads, 1);
  assert.equal(f.confirmations, 1);
  assert.equal(f.nodes.length, 1);
});

test('default version query is shared by independent page loaders', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const f = fixture();
  let calls = 0;
  const context = { ...f, setTimeout: f.setTimer, clearTimeout: f.clearTimer, AbortController,
    __WRD_BUILD__: OLD_BUILD,
    fetch: async () => { calls++; return { ok: true, status: 200, json: async () => ({ schemaVersion: 2, ...release('bbbbbbbbbbbbbbbb'), retainedReleases: [] }) }; },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'bounded-request.js'), 'utf8') + '\n'
    + fs.readFileSync(path.join(__dirname, 'asset-loader.js'), 'utf8') + '\n'
    + 'globalThis.first = createAssetLoader({document}); globalThis.second = createAssetLoader({document});', context);
  const a = assert.rejects(context.first.load({ url: '/a.js', kind: 'script' }));
  const b = assert.rejects(context.second.load({ url: '/b.js', kind: 'script' }));
  await flush();
  f.nodes.forEach((node) => node.onerror());
  await Promise.all([a, b]);
  await flush();
  assert.equal(calls, 1);
  assert.equal(context.first.getRefreshError().code, 'refresh-required');
  assert.equal(context.second.getRefreshError().code, 'refresh-required');
});
