const assert = require('node:assert/strict');
const test = require('node:test');
const { TouchInputAdapter } = require('./touch-input-adapter.js');

function makeTouchHarness() {
  const listeners = new Map(); const mouse = []; let now = 0; let timer = null; let frame = null; let lastTap = -Infinity; let enabled = true;
  const element = {
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
    dispatch(type, event = {}) { listeners.get(type)?.({...event, type, currentTarget: element}); },
    setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture() { return false; },
  };
  const adapter = TouchInputAdapter.create({
    element, mapPoint: (event) => ({relX: event.clientX / 160, relY: event.clientY / 120}),
    sendMouse: (action, payload) => { mouse.push({action, payload}); return `mouse-${mouse.length}`; },
    isEnabled: () => enabled, getClickCount: () => { const count = now - lastTap <= 500 ? 2 : 1; lastTap = now; return count; }, clock: () => now,
    setTimer: (fn, ms) => (timer = {fn, at: now + ms}), clearTimer: (id) => { if (timer === id) timer = null; },
  });
  global.requestAnimationFrame = (fn) => { frame = fn; return 1; };
  adapter.bind();
  const pointer = (type, overrides = {}) => element.dispatch(type,
    {pointerType: 'touch', isPrimary: true, preventDefault() {}, ...overrides});
  const advance = (ms) => { now += ms; if (timer && timer.at <= now) { const due = timer; timer = null; due.fn(); } };
  return {
    adapter, element, mouse, pointer, setEnabled: (value) => { enabled = value; },
    tap: (pointerId, atMs) => { advance(atMs - now); pointer('pointerdown', {pointerId, clientX: 40, clientY: 30, buttons: 1}); pointer('pointerup', {pointerId, clientX: 40, clientY: 30, buttons: 0}); },
    advance,
    flushAnimationFrame: () => { const due = frame; frame = null; due?.(); },
  };
}

test('short touch emits one left click using mapped coordinates', () => {
  const h = makeTouchHarness();
  h.pointer('pointerdown', {pointerId: 1, clientX: 40, clientY: 30, buttons: 1});
  h.pointer('pointerup', {pointerId: 1, clientX: 40, clientY: 30, buttons: 0});
  assert.deepEqual(h.mouse.map(({action, payload}) => [action, payload.button, payload.clickCount]),
    [['down', 'left', 1], ['up', 'left', 1]]);
  assert.deepEqual({relX: h.mouse[0].payload.relX, relY: h.mouse[0].payload.relY},
    {relX: 0.25, relY: 0.25});
});

test('second tap within 500ms emits clickCount 2 without a third click', () => {
  const h = makeTouchHarness();
  h.tap(1, 10); h.tap(1, 200);
  assert.deepEqual(h.mouse.filter((event) => event.action === 'down').map((event) => event.payload.clickCount), [1, 2]);
  assert.equal(h.mouse.length, 4);
});

test('movement beyond 8 CSS px starts one drag and releases it', () => {
  const h = makeTouchHarness();
  h.pointer('pointerdown', {pointerId: 1, clientX: 10, clientY: 10, buttons: 1});
  h.pointer('pointermove', {pointerId: 1, clientX: 19, clientY: 10, buttons: 1});
  h.pointer('pointerup', {pointerId: 1, clientX: 30, clientY: 10, buttons: 0});
  assert.deepEqual(h.mouse.map(({action}) => action), ['down', 'move', 'up']);
});

test('550ms stationary touch emits right down/up', () => {
  const h = makeTouchHarness();
  h.pointer('pointerdown', {pointerId: 1, clientX: 10, clientY: 10, buttons: 1});
  h.advance(550);
  h.pointer('pointerup', {pointerId: 1, clientX: 10, clientY: 10, buttons: 0});
  assert.deepEqual(h.mouse.map(({action, payload}) => [action, payload.button]), [['down', 'right'], ['up', 'right']]);
});

test('second pointer resets a pending drag and emits coalesced wheel', () => {
  const h = makeTouchHarness();
  h.pointer('pointerdown', {pointerId: 1, clientX: 10, clientY: 10, buttons: 1});
  h.pointer('pointermove', {pointerId: 1, clientX: 20, clientY: 10, buttons: 1});
  h.pointer('pointerdown', {pointerId: 2, clientX: 30, clientY: 30, buttons: 1});
  h.pointer('pointermove', {pointerId: 2, clientX: 30, clientY: 42, buttons: 1});
  h.flushAnimationFrame();
  assert.equal(h.mouse.filter(({action}) => action === 'reset').length, 1);
  assert.equal(h.mouse.filter(({action}) => action === 'wheel').length, 1);
});

test('pointercancel and lostpointercapture emit one idempotent reset', () => {
  const h = makeTouchHarness();
  h.pointer('pointerdown', {pointerId: 1, clientX: 10, clientY: 10, buttons: 1});
  h.pointer('pointermove', {pointerId: 1, clientX: 20, clientY: 10, buttons: 1});
  h.pointer('pointercancel', {pointerId: 1});
  h.element.dispatch('lostpointercapture', {pointerType: 'touch', pointerId: 1});
  assert.equal(h.mouse.filter(({action}) => action === 'reset').length, 1);
});

test('lost capture after pointerup, non-touch loss, and one scroll finger release do not reset remaining touch state', () => {
  const h = makeTouchHarness();
  h.pointer('pointerdown', {pointerId: 1, clientX: 10, clientY: 10, buttons: 1});
  h.pointer('pointerdown', {pointerId: 2, clientX: 30, clientY: 30, buttons: 1, isPrimary: false});
  h.pointer('pointerup', {pointerId: 1, clientX: 10, clientY: 10, buttons: 0});
  h.element.dispatch('lostpointercapture', {pointerType: 'touch', pointerId: 1});
  h.element.dispatch('lostpointercapture', {pointerType: 'mouse', pointerId: 9});
  assert.equal(h.adapter.getSnapshot().state, 'SCROLLING');
  assert.equal(h.adapter.getSnapshot().pointerCount, 1);
  assert.equal(h.mouse.filter(({action}) => action === 'reset').length, 0);
});

test('wheel deltas stay queued behind a reset barrier and flush after acknowledgement', () => {
  const h = makeTouchHarness();
  h.pointer('pointerdown', {pointerId: 1, clientX: 10, clientY: 10, buttons: 1});
  h.pointer('pointermove', {pointerId: 1, clientX: 20, clientY: 10, buttons: 1});
  h.pointer('pointerdown', {pointerId: 2, clientX: 30, clientY: 30, buttons: 1, isPrimary: false});
  h.setEnabled(false);
  h.pointer('pointermove', {pointerId: 2, clientX: 30, clientY: 42, buttons: 1});
  h.flushAnimationFrame();
  assert.equal(h.mouse.filter(({action}) => action === 'wheel').length, 0);
  assert.equal(h.adapter.getSnapshot().wheelPending, true);
  h.setEnabled(true);
  h.adapter.flushPending();
  h.flushAnimationFrame();
  assert.equal(h.mouse.filter(({action}) => action === 'wheel').length, 1);
});

test('unbind removes touch event delivery', () => {
  const h = makeTouchHarness();
  h.adapter.unbind();
  h.pointer('pointerdown', {pointerId: 1, clientX: 40, clientY: 30, buttons: 1});
  h.pointer('pointerup', {pointerId: 1, clientX: 40, clientY: 30, buttons: 0});
  assert.deepEqual(h.mouse, []);
});

test('reset is idempotent and clears pending timer, frame, and gesture state', () => {
  const h = makeTouchHarness();
  h.pointer('pointerdown', {pointerId: 1, clientX: 10, clientY: 10, buttons: 1});
  h.pointer('pointermove', {pointerId: 1, clientX: 20, clientY: 10, buttons: 1});
  h.adapter.reset('test-reset');
  h.adapter.reset('test-reset');
  h.advance(550);
  h.flushAnimationFrame();
  assert.deepEqual(h.mouse.map(({action}) => action), ['down', 'reset']);
  const snapshot = h.adapter.getSnapshot();
  assert.equal(snapshot.state, 'IDLE');
  assert.equal(snapshot.bound, true);
  assert.equal(snapshot.pendingReset, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /clientX|clientY|relX|relY|pointerId/);
});

test('explicit right click uses the latest mapped point and a paired action', () => {
  const h = makeTouchHarness();
  h.pointer('pointerdown', {pointerId: 1, clientX: 80, clientY: 60, buttons: 1});
  h.pointer('pointerup', {pointerId: 1, clientX: 80, clientY: 60, buttons: 0});
  h.mouse.length = 0;
  h.adapter.clickButton('right');
  assert.deepEqual(h.mouse.map(({action, payload}) => [action, payload.button, payload.relX, payload.relY]), [
    ['down', 'right', 0.5, 0.5],
    ['up', 'right', 0.5, 0.5],
  ]);
});
