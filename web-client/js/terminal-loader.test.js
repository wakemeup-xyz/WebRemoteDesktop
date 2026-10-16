'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadFactory() {
  const context = { globalThis: null, Promise, setTimeout, clearTimeout };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    `${fs.readFileSync(path.join(__dirname, 'asset-loader.js'), 'utf8')}\n` +
    `${fs.readFileSync(path.join(__dirname, 'terminal-loader.js'), 'utf8')}\n` +
    'globalThis.__factory = createTerminalLoader;',
    context,
  );
  return { factory: context.__factory, context };
}

test('concurrent Terminal clicks load assets and initialize once', async () => {
  const { factory, context } = loadFactory();
  let scriptCalls = 0;
  let styleCalls = 0;
  let initCalls = 0;
  context.TerminalPanel = { init() { initCalls += 1; } };
  const loader = factory({
    assets: { terminalCss: '/terminal.css', terminalJs: '/terminal.js' },
    document: {},
    loadStyle: async () => { styleCalls += 1; },
    loadScript: async () => { scriptCalls += 1; },
    getTerminalPanel: () => context.TerminalPanel,
  });
  // Force asset path by starting without a registered panel, then register on script load.
  const delayed = factory({
    assets: { terminalCss: '/terminal.css', terminalJs: '/terminal.js' },
    document: {},
    loadStyle: async () => { styleCalls += 1; },
    loadScript: async () => {
      scriptCalls += 1;
      context.TerminalPanel = { init() { initCalls += 1; } };
    },
    getTerminalPanel: () => context.TerminalPanel,
  });
  context.TerminalPanel = null;
  const first = delayed.load();
  const second = delayed.load();
  assert.equal(first, second);
  await first;
  assert.equal(scriptCalls, 1);
  assert.equal(styleCalls, 1);
  assert.equal(initCalls, 1);
  assert.equal(delayed.getState().state, 'ready');
});

test('Terminal load failure does not change Desktop state and can retry', async () => {
  const { factory, context } = loadFactory();
  let fail = true;
  const desktop = { state: 'active' };
  context.TerminalPanel = null;
  const loader = factory({
    assets: { terminalCss: '/terminal.css', terminalJs: '/terminal.js' },
    document: {},
    loadStyle: async () => {},
    loadScript: async () => {
      if (fail) throw new Error('asset failed');
      context.TerminalPanel = { init() {} };
    },
    getTerminalPanel: () => context.TerminalPanel,
  });
  await assert.rejects(loader.load(), /asset failed/);
  assert.equal(desktop.state, 'active');
  assert.equal(loader.getState().state, 'failed');
  fail = false;
  await loader.retry();
  assert.equal(loader.getState().state, 'ready');
});

test('retry repairs CSS without executing the JS bundle twice', async () => {
  const { factory } = loadFactory();
  let panel = null, css = 0, js = 0, init = 0;
  const loader = factory({
    assets: { terminalCss: '/fixture.css', terminalJs: '/fixture.js' },
    document: {}, getTerminalPanel: () => panel,
    loadStyle: async () => { if (++css === 1) throw Error('fixture CSS failure'); },
    loadScript: async () => { js++; panel = { init() { init++; } }; }
  });
  await assert.rejects(loader.load());
  await loader.retry();
  assert.equal(css, 2);
  assert.equal(js, 1);
  assert.equal(init, 1);
  assert.equal(loader.getState().state, 'ready');
});

function terminalFixture() {
  const { factory } = loadFactory();
  const nodes = [], timers = new Map();
  let serial = 0, panel = null, initCalls = 0;
  const loader = factory({
    assets: { terminalCss: '/fixture.css', terminalJs: '/fixture.js' },
    document: { createElement: (tag) => ({ tag }), head: { appendChild: (node) => nodes.push(node) } },
    setTimer(fn) { const id = ++serial; timers.set(id, fn); return id; },
    clearTimer(id) { timers.delete(id); },
    getTerminalPanel: () => panel,
  });
  return { loader, nodes, timers, register() { panel = { init() { initCalls++; } }; },
    get initCalls() { return initCalls; },
    tick() { const active = [...timers.values()]; timers.clear(); active.forEach((fn) => fn()); },
  };
}
async function flushTerminal() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

test('timed out operation cannot initialize; retry waits on one script and becomes ready', async () => {
  const f = terminalFixture();
  const first = f.loader.load();
  const rejected = assert.rejects(first, /timed out/);
  await flushTerminal();
  f.nodes.find((node) => node.tag === 'link').onload();
  f.tick();
  await rejected;
  const retry = f.loader.retry();
  await flushTerminal();
  f.register();
  f.nodes.find((node) => node.tag === 'script').onload();
  await retry;
  assert.equal(f.nodes.filter((node) => node.tag === 'script').length, 1);
  assert.equal(f.initCalls, 1);
  assert.equal(f.loader.getState().state, 'ready');
});

test('late script after deadline only caches assets until explicit retry', async () => {
  const f = terminalFixture();
  const rejected = assert.rejects(f.loader.load(), /timed out/);
  await flushTerminal();
  f.tick();
  await rejected;
  f.register();
  f.nodes.forEach((node) => node.onload());
  await flushTerminal();
  assert.equal(f.initCalls, 0);
  assert.equal(f.loader.getState().state, 'failed');
  await f.loader.retry();
  assert.equal(f.initCalls, 1);
  assert.equal(f.nodes.length, 2);
});

test('loaded script without registration requires refresh and never reexecutes', async () => {
  const f = terminalFixture();
  const rejected = assert.rejects(f.loader.load(), /刷新页面/);
  await flushTerminal();
  f.nodes.forEach((node) => node.onload());
  await rejected;
  assert.equal(f.loader.getState().refreshRequired, true);
  await assert.rejects(f.loader.retry(), /刷新页面/);
  assert.equal(f.nodes.length, 2);
});

test('dispose isolates late asset completion from initialization and UI', async () => {
  const f = terminalFixture();
  const rejected = assert.rejects(f.loader.load(), /superseded/);
  await flushTerminal();
  f.loader.dispose();
  f.register();
  f.nodes.forEach((node) => node.onload());
  await rejected;
  assert.equal(f.initCalls, 0);
  assert.equal(f.loader.getState().state, 'disposed');
  await assert.rejects(f.loader.retry(), /disposed/);
});

test('an async init is awaited once across a timed out wait and retry', async () => {
  const { factory } = loadFactory();
  let finish, calls = 0;
  const timers = new Map();
  let serial = 0;
  const panel = { init() { calls++; return new Promise((resolve) => { finish = resolve; }); } };
  const loader = factory({ document: {}, getTerminalPanel: () => panel,
    setTimer(fn) { const id = ++serial; timers.set(id, fn); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  const rejected = assert.rejects(loader.load(), /timed out/);
  await flushTerminal();
  [...timers.values()][0]();
  await rejected;
  const retry = loader.retry();
  await flushTerminal();
  assert.equal(calls, 1);
  finish();
  await retry;
  assert.equal(loader.getState().state, 'ready');
});

test('force retry supersedes a still waiting operation without letting its catch fail the current UI', async () => {
  const f = terminalFixture();
  const rejected = assert.rejects(f.loader.load(), /superseded/);
  await flushTerminal();
  const retry = f.loader.retry();
  await flushTerminal();
  f.register();
  f.nodes.forEach((node) => node.onload());
  await rejected;
  await retry;
  assert.equal(f.loader.getState().state, 'ready');
  assert.equal(f.initCalls, 1);
  assert.equal(f.nodes.length, 2);
});

test('one overridden resource adapter preserves the other default DOM request', async () => {
  const { createTerminalLoader } = require('./terminal-loader');
  const nodes = [];
  let panel = null;
  const loader = createTerminalLoader({
    assets: { terminalCss: '/one.css', terminalJs: '/one.js' },
    document: { createElement: (tag) => ({ tag }), body: { appendChild: (node) => nodes.push(node) } },
    loadStyle: async () => {}, getTerminalPanel: () => panel,
  });
  const loading = loader.load();
  await flushTerminal();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].tag, 'script');
  panel = { init() {} };
  nodes[0].onload();
  await loading;
  assert.equal(loader.getState().state, 'ready');
});
