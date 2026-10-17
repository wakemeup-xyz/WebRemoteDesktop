'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadController() {
  const context = {
    globalThis: null,
    AbortController,
    Promise,
    Error,
    setTimeout,
    clearTimeout,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    `${fs.readFileSync(path.join(__dirname, 'bootstrap-controller.js'), 'utf8')}\n` +
    'globalThis.__createViewerBootstrap = createViewerBootstrap;',
    context,
  );
  return context.__createViewerBootstrap;
}

test('warmup and Start share one in-flight bootstrap request', async () => {
  const createViewerBootstrap = loadController();
  let calls = 0;
  let resolveFetch;
  const fetchSnapshot = () => {
    calls += 1;
    return new Promise((resolve) => { resolveFetch = resolve; });
  };
  const controller = createViewerBootstrap({ fetchSnapshot, timeoutMs: 3000 });
  const warmup = controller.load({ mode: 'auto' });
  const click = controller.load({ mode: 'auto' });
  assert.equal(calls, 1);
  resolveFetch({ schemaVersion: 1, webrtc: {} });
  assert.deepEqual(await warmup, await click);
});

test('a completed ready preload is reused by the same Start within the fixed window', async () => {
  let currentTime = 100;
  let calls = 0;
  const ready = { schemaVersion: 1, webrtc: { iceServers: [] } };
  const controller = loadController()({
    now: () => currentTime,
    getScope: () => 7,
    fetchSnapshot: async () => { calls++; return ready; },
  });
  assert.strictEqual(await controller.load({ mode: 'relay', turnServerId: 'turn-a' }), ready);
  currentTime = 200;
  assert.strictEqual(await controller.load({ mode: 'relay', turnServerId: 'turn-a' }), ready);
  assert.equal(calls, 1);
});

test('the ready window expires at 3000ms and a hit does not renew it', async () => {
  let time = 100;
  let calls = 0;
  const controller = loadController()({ now: () => time, fetchSnapshot: async () => ({ call: ++calls }) });
  await controller.load({ mode: 'auto' });
  time = 3099;
  assert.equal((await controller.load({ mode: 'auto' })).call, 1);
  time = 3100;
  assert.equal((await controller.load({ mode: 'auto' })).call, 2);
  assert.equal(calls, 2);
});

test('zero cache age disables reuse and invalid or rolling-back clocks miss', async () => {
  let calls = 0;
  const disabled = loadController()({ cacheMaxAgeMs: 0, now: () => 10,
    fetchSnapshot: async () => ({ call: ++calls }) });
  await disabled.load();
  await disabled.load();
  assert.equal(calls, 2);

  let time = 100;
  const controller = loadController()({ now: () => time,
    fetchSnapshot: async () => ({ call: ++calls }) });
  await controller.load();
  time = NaN;
  await controller.load();
  time = 200;
  await controller.load();
  time = 199;
  await controller.load();
  assert.equal(calls, 6);
  assert.throws(() => loadController()({ cacheMaxAgeMs: 3001 }), /cacheMaxAgeMs/);
});

test('mode, TURN, and auth scope each require a fresh load', async () => {
  let scope = 1;
  let calls = 0;
  const controller = loadController()({ now: () => 100, getScope: () => scope,
    fetchSnapshot: async () => ({ call: ++calls }) });
  await controller.load({ mode: 'auto', turnServerId: 'turn-a' });
  await controller.load({ mode: 'relay', turnServerId: 'turn-a' });
  await controller.load({ mode: 'relay', turnServerId: 'turn-b' });
  scope = 2;
  await controller.load({ mode: 'relay', turnServerId: 'turn-b' });
  await controller.load({ mode: 'relay', turnServerId: 'turn-b' });
  assert.equal(calls, 4);
});

test('forced retry and cancel each invalidate a completed ready load', async () => {
  let calls = 0;
  const controller = loadController()({ now: () => 100,
    fetchSnapshot: async () => ({ call: ++calls }) });
  await controller.load();
  assert.equal((await controller.retry()).call, 2);
  assert.equal((await controller.load()).call, 2);
  controller.cancel();
  assert.equal((await controller.load()).call, 3);
});

test('failed, auth-required, and degraded loads never become reusable', async () => {
  for (const code of ['bootstrap-unavailable', 'auth-invalid']) {
    let calls = 0;
    const controller = loadController()({ now: () => 100,
      fetchSnapshot: async () => {
        calls++;
        throw Object.assign(new Error(code), { code, status: 401 });
      },
      fallbackFactory: () => ({ degraded: true }),
    });
    for (let i = 0; i < 2; i++) {
      if (code === 'auth-invalid') await assert.rejects(controller.load({ mode: 'auto' }), /auth-invalid/);
      else assert.equal((await controller.load({ mode: 'auto' })).degraded, true);
    }
    assert.equal(calls, 2);
  }
  let calls = 0;
  const failed = loadController()({ now: () => 100,
    fetchSnapshot: async () => { calls++; throw new Error('offline'); } });
  await assert.rejects(failed.load({ mode: 'relay' }), /offline/);
  await assert.rejects(failed.load({ mode: 'relay' }), /offline/);
  assert.equal(calls, 2);
});

test('an old auth scope cannot publish a late completed result', async () => {
  let scope = 1;
  let calls = 0;
  let resolveOld;
  const controller = loadController()({ now: () => 100, getScope: () => scope,
    fetchSnapshot: () => ++calls === 1
      ? new Promise((resolve) => { resolveOld = resolve; })
      : Promise.resolve({ id: 'new' }),
  });
  const old = controller.load();
  scope = 2;
  resolveOld({ id: 'old' });
  await assert.rejects(old, /superseded/);
  assert.equal(controller.getSnapshot().state, 'loading');
  assert.equal((await controller.load()).id, 'new');
  assert.equal((await controller.load()).id, 'new');
  assert.equal(calls, 2);
});

test('timeout degrades auto but never invents relay config', async () => {
  const createViewerBootstrap = loadController();
  const timeoutError = Object.assign(new Error('timeout'), { code: 'bootstrap-timeout' });
  const fetchSnapshot = async () => { throw timeoutError; };
  const fallbackFactory = () => ({ schemaVersion: 1, degraded: true, webrtc: { iceServers: [] } });

  const auto = createViewerBootstrap({ fetchSnapshot, fallbackFactory });
  assert.equal((await auto.load({ mode: 'auto' })).degraded, true);

  const relay = createViewerBootstrap({ fetchSnapshot, fallbackFactory });
  await assert.rejects(relay.load({ mode: 'relay' }), /timeout/);
  assert.equal(relay.getSnapshot().state, 'failed');
});

test('typed application auth-invalid becomes auth-required and never falls back', async () => {
  const createViewerBootstrap = loadController();
  const error = Object.assign(new Error('unauthorized'), { status: 401, code: 'auth-invalid' });
  const controller = createViewerBootstrap({
    fetchSnapshot: async () => { throw error; },
    fallbackFactory: () => ({ degraded: true }),
  });
  await assert.rejects(controller.load({ mode: 'auto' }), /unauthorized/);
  assert.equal(controller.getSnapshot().state, 'auth-required');
});

test('late result from an older forced load cannot overwrite the retry', async () => {
  const resolvers = [];
  const controller = loadController()({
    fetchSnapshot: () => new Promise((resolve) => resolvers.push(resolve)),
  });
  const oldLoad = controller.load({ mode: 'auto' });
  const retry = controller.retry({ mode: 'auto' });
  resolvers[1]({ id: 'new' });
  assert.equal((await retry).id, 'new');
  resolvers[0]({ id: 'old' });
  await oldLoad;
  assert.equal(controller.getSnapshot().value.id, 'new');
});

test('deadline aborts the underlying bootstrap fetch', async () => {
  let timeoutCallback;
  let observedSignal;
  const controller = loadController()({
    timeoutMs: 3000,
    setTimer(callback) { timeoutCallback = callback; return 1; },
    clearTimer() {},
    fetchSnapshot: ({ signal }) => {
      observedSignal = signal;
      return new Promise(() => {});
    },
    fallbackFactory: () => ({ degraded: true }),
  });
  const load = controller.load({ mode: 'auto' });
  timeoutCallback();
  assert.equal((await load).degraded, true);
  assert.equal(observedSignal.aborted, true);
});

test('an untyped proxy 403 never becomes auth-required', async () => {
  const controller = loadController()({
    fetchSnapshot: async () => { throw Object.assign(new Error('proxy unavailable'), { status: 403 }); },
    fallbackFactory: () => ({ degraded: true }),
  });
  assert.equal((await controller.load({ mode: 'auto' })).degraded, true);
  assert.equal(controller.getSnapshot().state, 'degraded');
});
