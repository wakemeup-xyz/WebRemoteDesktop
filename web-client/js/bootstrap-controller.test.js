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

test('401 becomes auth-required and never falls back', async () => {
  const createViewerBootstrap = loadController();
  const error = Object.assign(new Error('unauthorized'), { status: 401 });
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
