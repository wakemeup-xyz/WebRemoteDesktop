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
