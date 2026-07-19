const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { MediaActivityLifecycle } = require('./media-activity-lifecycle.js');

function createEventTarget() {
  const listeners = new Map();

  return {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) {
        listeners.delete(type);
      }
    },
    dispatch(type) {
      listeners.get(type)?.();
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

function createTimers() {
  let nextId = 1;
  const pending = new Map();

  return {
    setTimeout(callback, delay) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    runOnly() {
      assert.equal(pending.size, 1);
      const [[id, task]] = pending.entries();
      pending.delete(id);
      task.callback();
      return task.delay;
    },
    count() {
      return pending.size;
    },
  };
}

function createLifecycle(options = {}) {
  const documentLike = createEventTarget();
  const windowLike = createEventTarget();
  const timers = createTimers();
  const reasons = [];
  const lifecycle = MediaActivityLifecycle.create({
    documentLike,
    windowLike,
    setReason(reason, enabled) {
      reasons.push([reason, enabled]);
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    ...options,
  });

  return { documentLike, windowLike, timers, reasons, lifecycle };
}

test('debounces a hidden page and cancels the pending suspension when visible', () => {
  const { documentLike, timers, reasons, lifecycle } = createLifecycle();
  documentLike.hidden = true;
  lifecycle.start();

  documentLike.dispatch('visibilitychange');
  assert.equal(timers.count(), 1);
  assert.deepEqual(reasons, []);
  assert.equal(timers.runOnly(), 750);
  assert.deepEqual(reasons, [['page-hidden', true]]);

  documentLike.hidden = false;
  documentLike.dispatch('visibilitychange');
  assert.deepEqual(reasons, [['page-hidden', true], ['page-hidden', false]]);

  documentLike.hidden = true;
  documentLike.dispatch('visibilitychange');
  assert.equal(timers.count(), 1);
  documentLike.hidden = false;
  documentLike.dispatch('visibilitychange');
  assert.equal(timers.count(), 0);
  assert.deepEqual(reasons, [
    ['page-hidden', true],
    ['page-hidden', false],
    ['page-hidden', false],
  ]);
});

test('uses a configured hidden delay instead of the 750 ms default', () => {
  const { documentLike, timers, reasons, lifecycle } = createLifecycle({ hiddenDelayMs: 125 });
  documentLike.hidden = true;
  lifecycle.start();

  documentLike.dispatch('visibilitychange');
  assert.equal(timers.runOnly(), 125);
  assert.deepEqual(reasons, [['page-hidden', true]]);
});

test('maps pagehide and pageshow directly to the page-hide reason', () => {
  const { windowLike, reasons, lifecycle } = createLifecycle();
  lifecycle.start();

  windowLike.dispatch('pagehide');
  windowLike.dispatch('pageshow');

  assert.deepEqual(reasons, [['page-hide', true], ['page-hide', false]]);
});

test('stops idempotently by clearing pending work and removing listeners', () => {
  const { documentLike, windowLike, timers, reasons, lifecycle } = createLifecycle();
  lifecycle.start();
  lifecycle.start();
  assert.equal(documentLike.listenerCount(), 1);
  assert.equal(windowLike.listenerCount(), 2);

  documentLike.hidden = true;
  documentLike.dispatch('visibilitychange');
  assert.equal(timers.count(), 1);
  lifecycle.stop();
  lifecycle.stop();
  assert.equal(timers.count(), 0);
  assert.equal(documentLike.listenerCount(), 0);
  assert.equal(windowLike.listenerCount(), 0);

  documentLike.dispatch('visibilitychange');
  windowLike.dispatch('pagehide');
  assert.deepEqual(reasons, []);
});

test('exposes the lifecycle object directly on the browser global', () => {
  const browserGlobal = {};
  const source = fs.readFileSync(path.join(__dirname, 'media-activity-lifecycle.js'), 'utf8');

  vm.runInNewContext(source, { window: browserGlobal, globalThis: browserGlobal });

  assert.equal(typeof browserGlobal.MediaActivityLifecycle.create, 'function');
});
