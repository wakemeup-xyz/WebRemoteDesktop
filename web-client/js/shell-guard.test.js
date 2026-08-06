'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createShellFixture(options = {}) {
  const elements = {
    loadingText: { textContent: '' },
    retryButton: { hidden: true },
    coreControl: { disabled: false },
  };
  let deadline = null;
  let clock = Number(options.nowMs || 12.5);
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
    performance: {
      now() { return clock; },
    },
    setTimeout(callback, ms) {
      deadline = { callback, ms };
      return 1;
    },
    clearTimeout() { deadline = null; },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'shell-guard.js'), 'utf8'), context);
  return {
    shell: context.__WRD_SHELL__,
    elements,
    advance(ms) { clock += ms; },
    fireDeadline() { deadline?.callback?.(); },
    deadlineMs() { return deadline?.ms; },
  };
}

test('html-shell is marked immediately at shell parse with performance time', () => {
  const { shell } = createShellFixture({ nowMs: 42.25 });
  const snap = shell.snapshot();
  assert.equal(snap.marks[0].name, 'html-shell');
  assert.equal(snap.marks[0].atMs, 42.25);
});

test('core deadline is five seconds and leaves a visible retryable state', () => {
  const { elements, fireDeadline, deadlineMs } = createShellFixture();
  assert.equal(deadlineMs(), 5000);
  fireDeadline();
  assert.equal(elements.loadingText.textContent, '页面资源加载超时');
  assert.equal(elements.retryButton.hidden, false);
});

test('pre-core Start click is acknowledged and transferred exactly once', () => {
  const { shell, elements, advance } = createShellFixture({ nowMs: 10 });
  advance(5);
  shell.acknowledgeStartClick();
  assert.equal(elements.loadingText.textContent, '正在加载必要资源…');
  assert.equal(shell.snapshot().marks.at(-1).name, 'start-click');
  let calls = 0;
  advance(20);
  shell.installCore(() => { calls += 1; });
  shell.installCore(() => { calls += 100; });
  assert.equal(calls, 1);
  const names = shell.snapshot().marks.map((mark) => mark.name);
  assert.equal(names.join(','), 'html-shell,start-click,core-interactive');
  assert.equal(shell.snapshot().marks.at(-1).atMs, 35);
});

test('marked core controls are disabled before takeover and enabled after installCore', () => {
  const { shell, elements } = createShellFixture();
  assert.equal(elements.coreControl.disabled, true);
  shell.installCore(() => {});
  assert.equal(elements.coreControl.disabled, false);
});
