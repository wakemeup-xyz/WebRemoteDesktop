'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createShellFixture() {
  const elements = {
    loadingText: { textContent: '' },
    retryButton: { hidden: true },
    coreControl: { disabled: false },
  };
  let deadline = null;
  const context = {
    window: null,
    document: {
      readyState: 'complete',
      addEventListener() {},
      getElementById(id) {
        if (id === 'loadingText') return elements.loadingText;
        if (id === 'coreRetryBtn') return elements.retryButton;
        return null;
      },
      querySelectorAll(selector) {
        return selector === '[data-core-control]' ? [elements.coreControl] : [];
      },
    },
    performance: { now: () => 1 },
    setTimeout(callback) { deadline = callback; return 1; },
    clearTimeout() { deadline = null; },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'shell-guard.js'), 'utf8'), context);
  return {
    shell: context.__WRD_SHELL__,
    elements,
    fireDeadline() { deadline?.(); },
  };
}

test('pre-core Start click is acknowledged and transferred exactly once', () => {
  const { shell, elements } = createShellFixture();
  shell.acknowledgeStartClick();
  assert.equal(elements.loadingText.textContent, '正在加载必要资源…');
  let calls = 0;
  shell.installCore(() => { calls += 1; });
  shell.installCore(() => { calls += 100; });
  assert.equal(calls, 1);
});

test('core deadline leaves a visible retryable state', () => {
  const { elements, fireDeadline } = createShellFixture();
  fireDeadline();
  assert.equal(elements.loadingText.textContent, '页面资源加载超时');
  assert.equal(elements.retryButton.hidden, false);
});

test('marked core controls are disabled before takeover and enabled after installCore', () => {
  const { shell, elements } = createShellFixture();
  assert.equal(elements.coreControl.disabled, true);
  shell.installCore(() => {});
  assert.equal(elements.coreControl.disabled, false);
});
