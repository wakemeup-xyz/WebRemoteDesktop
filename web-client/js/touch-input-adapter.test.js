const assert = require('node:assert/strict');
const test = require('node:test');
const { TouchInputAdapter } = require('./touch-input-adapter.js');

function makeTouchHarness(options = {}) {
  const listeners = new Map(); const mouse = []; let now = 0; let timer = null; let frame = null; let lastTap = -Infinity; let enabled = true;
  const captured = new Set();
  const pointerGeometry = {
    get clientX() { return this.__clientX; },
    get clientY() { return this.__clientY; },
  };
  const element = {
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
    dispatch(type, event = {}) {
      const dispatched = Object.create(pointerGeometry);
      for (const [key, value] of Object.entries(event)) {
        if (key !== 'clientX' && key !== 'clientY') dispatched[key] = value;
      }
      Object.defineProperties(dispatched, {
        __clientX: { value: event.clientX, enumerable: false },
        __clientY: { value: event.clientY, enumerable: false },
      });
      dispatched.type = type;
      dispatched.currentTarget = element;
      listeners.get(type)?.(dispatched);
    },
    setPointerCapture(id) { captured.add(id); }, releasePointerCapture(id) { captured.delete(id); options.onReleaseCapture?.(id); }, hasPointerCapture(id) { return captured.has(id); },
  };
  const adapter = TouchInputAdapter.create({
    element, mapPoint: options.mapPoint || ((event) => ({relX: event.clientX / 160, relY: event.clientY / 120})),
    sendMouse: (action, payload) => {
      mouse.push({action, payload});
      return typeof options.sendMouse === 'function' ? options.sendMouse(action, payload) : `mouse-${mouse.length}`;
    },
    isEnabled: () => enabled, getClickCount: () => { const count = now - lastTap <= 500 ? 2 : 1; lastTap = now; return count; }, clock: () => now,
    setTimer: (fn, ms) => (timer = {fn, at: now + ms}), clearTimer: (id) => { if (timer === id) timer = null; },
    beforeGesture: options.beforeGesture,
    commitGesture: options.commitGesture,
    onTraceDomEvent: options.onTraceDomEvent,
    onTraceEventEnd: options.onTraceEventEnd,
    withTraceEvent: options.withTraceEvent,
    validateGeometry: options.validateGeometry,
  });
  global.requestAnimationFrame = (fn) => { frame = fn; return 1; };
  adapter.bind();
  const pointer = (type, overrides = {}) => element.dispatch(type,
    {pointerType: 'touch', isPrimary: true, preventDefault() {}, ...overrides});
  const advance = (ms) => { now += ms; if (timer && timer.at <= now) { const due = timer; timer = null; due.fn(); } };
  return {
    adapter, element, mouse, captured, pointer, setEnabled: (value) => { enabled = value; },
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

test('touch dispatch attributes each physical send without inheriting an unassociated action', () => {
  let nextEventId = 0;
  const calls = [];
  const h = makeTouchHarness({
    onTraceDomEvent(meta) {
      calls.push({ kind: 'dom', meta });
      return ++nextEventId;
    },
    onTraceEventEnd(eventId) { calls.push({ kind: 'end', eventId }); },
    withTraceEvent(eventId, send) {
      calls.push({ kind: 'send', eventId });
      return send();
    },
  });

  h.pointer('pointerdown', {pointerId: 1, clientX: 40, clientY: 30, buttons: 1});
  h.pointer('pointerup', {pointerId: 1, clientX: 40, clientY: 30, buttons: 0});
  h.adapter.clickButton('right');

  assert.deepEqual(calls.filter(({ kind }) => kind === 'dom').map(({ meta }) => meta.phase), [
    'down', 'up',
  ]);
  assert.deepEqual(calls.filter(({ kind }) => kind === 'send').map(({ eventId }) => eventId), [
    1, 2, null, null, null,
  ]);
  assert.equal(calls.filter(({ kind }) => kind === 'end').length, 2);
});

test('a trace hook that throws after touch dispatch does not replay the send', () => {
  let traceCalls = 0;
  const h = makeTouchHarness({
    withTraceEvent(_eventId, send) {
      traceCalls += 1;
      const result = send();
      throw new Error(`trace-after-touch-send:${result}`);
    },
  });

  h.pointer('pointerdown', {pointerId: 1, clientX: 40, clientY: 30, buttons: 1});
  h.pointer('pointerup', {pointerId: 1, clientX: 40, clientY: 30, buttons: 0});

  assert.deepEqual(h.mouse.map(({ action }) => action), ['down', 'up']);
  assert.equal(traceCalls, 2);
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

test('drag presses the initial contact before moving', () => {
  const h = makeTouchHarness();
  h.pointer('pointerdown', {pointerId: 1, clientX: 10, clientY: 10});
  h.pointer('pointermove', {pointerId: 1, clientX: 19, clientY: 10});
  h.pointer('pointerup', {pointerId: 1, clientX: 30, clientY: 10});

  const down = h.mouse.find((event) => event.action === 'down');
  assert.equal(down.payload.relX, 10 / 160);
  assert.deepEqual(h.mouse.map((event) => event.action), ['down', 'move', 'up']);
});

test('beforeGesture rejection consumes the contact without capture or reset', () => {
  const h = makeTouchHarness({beforeGesture: () => false});
  h.pointer('pointerdown', {pointerId: 1, clientX: 10, clientY: 10});
  h.pointer('pointermove', {pointerId: 1, clientX: 30, clientY: 10});
  h.pointer('pointerup', {pointerId: 1, clientX: 30, clientY: 10});

  assert.deepEqual(h.mouse, []);
  assert.equal(h.captured.size, 0);
  assert.equal(h.adapter.getSnapshot().state, 'IDLE');
});

test('commitGesture wraps each real down and can reject without transport reset', () => {
  let commits = 0;
  const h = makeTouchHarness({commitGesture: () => { commits += 1; return false; }});
  h.pointer('pointerdown', {pointerId: 1, clientX: 40, clientY: 30});
  h.pointer('pointerup', {pointerId: 1, clientX: 40, clientY: 30});

  assert.equal(commits, 1);
  assert.deepEqual(h.mouse, []);
  assert.equal(h.captured.size, 0);
});

test('failed down consumes the pointer and only emits one reset', () => {
  let downAttempts = 0;
  const h = makeTouchHarness({
    sendMouse: (action) => action === 'down' && downAttempts++ === 0 ? null : `mouse-${action}`,
  });
  h.pointer('pointerdown', {pointerId: 1, clientX: 10, clientY: 10});
  h.pointer('pointermove', {pointerId: 1, clientX: 20, clientY: 10});
  h.pointer('pointermove', {pointerId: 1, clientX: 30, clientY: 10});
  h.setEnabled(false);
  h.pointer('pointerup', {pointerId: 1, clientX: 30, clientY: 10});
  h.setEnabled(true);
  h.pointer('pointerdown', {pointerId: 2, clientX: 40, clientY: 10});
  h.pointer('pointerup', {pointerId: 2, clientX: 40, clientY: 10});

  assert.deepEqual(h.mouse.map((event) => event.action), ['down', 'reset', 'down', 'up']);
  assert.equal(h.mouse.filter((event) => event.action === 'reset').length, 1);
  assert.equal(h.captured.size, 0);
  assert.equal(h.adapter.getSnapshot().state, 'IDLE');
});

test('geometry invalidation cancels queued move and long press callbacks', () => {
  let geometryValid = true;
  const h = makeTouchHarness({validateGeometry: () => geometryValid});
  h.pointer('pointerdown', {pointerId: 1, clientX: 10, clientY: 10});
  h.pointer('pointermove', {pointerId: 1, clientX: 20, clientY: 10});
  geometryValid = false;
  h.flushAnimationFrame();
  assert.deepEqual(h.mouse.map((event) => event.action), ['down']);
  assert.equal(h.captured.size, 0);

  geometryValid = true;
  h.pointer('pointerdown', {pointerId: 2, clientX: 30, clientY: 10});
  geometryValid = false;
  h.advance(550);
  assert.deepEqual(h.mouse.map((event) => event.action), ['down']);
  assert.equal(h.adapter.getSnapshot().state, 'IDLE');
});

test('reentrant geometry validation or mapping cannot queue stale work', () => {
  let adapter = null;
  let validateReentered = false;
  const h = makeTouchHarness({
    validateGeometry: () => {
      if (!validateReentered) {
        validateReentered = true;
        adapter.reset('validate-reentry');
      }
      return true;
    },
  });
  adapter = h.adapter;
  h.pointer('pointerdown', {pointerId: 1, clientX: 10, clientY: 10});
  h.pointer('pointermove', {pointerId: 1, clientX: 20, clientY: 10});
  assert.deepEqual(h.mouse, []);

  let mapReentered = false;
  const mapped = makeTouchHarness({
    mapPoint: (event) => {
      if (!mapReentered && event.clientX === 20) {
        mapReentered = true;
        mapped.adapter.reset('map-reentry');
      }
      return {relX: event.clientX / 160, relY: event.clientY / 120};
    },
  });
  mapped.pointer('pointerdown', {pointerId: 1, clientX: 10, clientY: 10});
  mapped.pointer('pointermove', {pointerId: 1, clientX: 20, clientY: 10});
  mapped.pointer('pointerup', {pointerId: 1, clientX: 20, clientY: 10});
  assert.deepEqual(mapped.mouse, []);
});

test('reset releases capture even when capture release re-enters reset', () => {
  let harness = null;
  let reentries = 0;
  harness = makeTouchHarness({
    onReleaseCapture: () => {
      reentries += 1;
      harness.adapter.reset('nested-reset');
    },
  });
  harness.pointer('pointerdown', {pointerId: 1, clientX: 10, clientY: 10});
  harness.adapter.reset('outer-reset');
  assert.equal(reentries, 1);
  assert.equal(harness.captured.size, 0);
  assert.equal(harness.adapter.getSnapshot().state, 'IDLE');
});

test('cumulative sub-threshold moves start a drag and cancel long press', () => {
  const h = makeTouchHarness();
  h.pointer('pointerdown', {pointerId: 1, clientX: 10, clientY: 10, buttons: 1});
  h.pointer('pointermove', {pointerId: 1, clientX: 14, clientY: 10, buttons: 1});
  h.pointer('pointermove', {pointerId: 1, clientX: 18, clientY: 10, buttons: 1});
  h.pointer('pointermove', {pointerId: 1, clientX: 22, clientY: 10, buttons: 1});
  h.advance(550);
  h.pointer('pointerup', {pointerId: 1, clientX: 22, clientY: 10, buttons: 0});

  assert.deepEqual(h.mouse.map(({action, payload}) => [action, payload.button]), [
    ['down', 'left'], ['move', undefined], ['up', 'left'],
  ]);
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
  assert.equal(h.captured.size, 0);
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

test('explicit right click commits its real down through the navigation gate', () => {
  let commits = 0;
  const h = makeTouchHarness({commitGesture: (send) => {
    commits += 1;
    return Boolean(send());
  }});
  h.pointer('pointerdown', {pointerId: 1, clientX: 80, clientY: 60, buttons: 1});
  h.pointer('pointerup', {pointerId: 1, clientX: 80, clientY: 60, buttons: 0});
  h.mouse.length = 0;
  h.adapter.clickButton('right');
  assert.equal(commits, 2, 'tap and explicit right click each commit one real down');
  assert.deepEqual(h.mouse.map(({action}) => action), ['down', 'up']);
});
