const assert = require('node:assert/strict');
const test = require('node:test');
const { TouchInputAdapter } = require('./touch-input-adapter.js');

function makeTouchHarness() {
  const listeners = new Map(); const mouse = []; let now = 0; let timer = null; let frame = null; let lastTap = -Infinity;
  const element = {
    addEventListener(type, fn) { listeners.set(type, fn); },
    dispatch(type, event = {}) { listeners.get(type)?.({...event, type, currentTarget: element}); },
    setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture() { return false; },
  };
  const adapter = TouchInputAdapter.create({
    element, mapPoint: (event) => ({relX: event.clientX / 160, relY: event.clientY / 120}),
    sendMouse: (action, payload) => { mouse.push({action, payload}); return `mouse-${mouse.length}`; },
    isEnabled: () => true, getClickCount: () => { const count = now - lastTap <= 500 ? 2 : 1; lastTap = now; return count; }, clock: () => now,
    setTimer: (fn, ms) => (timer = {fn, at: now + ms}), clearTimer: (id) => { if (timer === id) timer = null; },
  });
  global.requestAnimationFrame = (fn) => { frame = fn; return 1; };
  adapter.bind();
  const pointer = (type, overrides = {}) => element.dispatch(type,
    {pointerType: 'touch', isPrimary: true, preventDefault() {}, ...overrides});
  const advance = (ms) => { now += ms; if (timer && timer.at <= now) { const due = timer; timer = null; due.fn(); } };
  return {
    element, mouse, pointer,
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
  h.element.dispatch('lostpointercapture', {pointerId: 1});
  assert.equal(h.mouse.filter(({action}) => action === 'reset').length, 1);
});
