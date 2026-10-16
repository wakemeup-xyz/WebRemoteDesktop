'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createAssetLoader } = require('./asset-loader');

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

function deferredFixture() {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const f = fixture();
  let init = 0, reloads = 0, confirmations = 0;
  const button = {};
  f.document.getElementById = () => button;
  const context = { document: f.document, Promise, console: { warn() {} }, WebRTC: { renderPortSearchStatus() {} },
    window: { __WRD_ASSETS__: { desktopDeferredJs: '/tools.js' },
      confirm() { confirmations++; return true; }, location: { reload() { reloads++; } } },
    createAssetLoader: (options) => createAssetLoader({ ...options, setTimer: f.setTimer, clearTimer: f.clearTimer }),
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
