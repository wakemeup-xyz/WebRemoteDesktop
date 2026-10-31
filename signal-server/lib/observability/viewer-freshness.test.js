'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createViewerFreshnessRegistry } = require('./viewer-freshness');

function fixture(staleAfterMs = 30000, activeRecoveryAfterMs = undefined) {
  let now = 0;
  const events = [];
  const snapshots = new Map();
  let releaseCount = 0;
  let recoveryCount = 0;
  const registry = createViewerFreshnessRegistry({
    now: () => now,
    staleAfterMs,
    ...(activeRecoveryAfterMs === undefined ? {} : { activeRecoveryAfterMs }),
    tickMs: 1000,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn() {},
    onEvent: event => events.push(event),
    onSnapshot: (id, snapshot) => snapshots.set(id, snapshot),
    onActiveStall: () => { recoveryCount += 1; return true; },
    onStale: () => { releaseCount += 1; return true; },
  });
  return {
    registry,
    events,
    snapshots,
    get releaseCount() { return releaseCount; },
    get recoveryCount() { return recoveryCount; },
    advance(ms) { now += ms; registry.tick(); },
  };
}

test('page-hidden suspension becomes stalled, stale, and releases the slot once', () => {
  const h = fixture();
  h.registry.register('viewer-a');
  h.registry.observeMedia('viewer-a', { state: 'suspended', reasons: ['page-hidden'], generation: 3 });
  h.advance(29999);
  assert.deepEqual(h.events, []);
  h.advance(1);
  assert.deepEqual(h.events.map(event => event.event), [
    'media_stalled', 'session_stale_detected', 'slot_released',
  ]);
  assert.equal(h.releaseCount, 1);
  h.advance(5000);
  assert.equal(h.events.filter(event => event.event === 'slot_released').length, 1);
});

test('a renewing control heartbeat delays stale release', () => {
  const h = fixture();
  h.registry.register('viewer-a');
  h.registry.observeMedia('viewer-a', { state: 'suspended', reasons: ['page-hidden'] });
  h.advance(29000);
  h.registry.observeHeartbeat('viewer-a');
  h.advance(1000);
  assert.equal(h.events.some(event => event.event === 'session_stale_detected'), false);
  h.advance(28999);
  assert.equal(h.releaseCount, 0);
  h.advance(1000);
  assert.equal(h.releaseCount, 1);
});

test('a recent media activity ACK delays hidden stale release', () => {
  const h = fixture();
  h.registry.register('viewer-a');
  h.registry.observeMedia('viewer-a', { state: 'suspended', reasons: ['page-hidden'] });
  h.advance(29000);
  h.registry.observeMedia('viewer-a', { state: 'suspended', reasons: ['page-hidden'], applied: true });
  h.advance(1000);
  assert.equal(h.events.some(event => event.event === 'session_stale_detected'), false);
  h.advance(28999);
  assert.equal(h.releaseCount, 0);
  h.advance(1000);
  assert.equal(h.releaseCount, 1);
});

test('fresh decoded frames clear an active media stall episode', () => {
  const h = fixture();
  h.registry.register('viewer-a');
  h.registry.observeMedia('viewer-a', { state: 'active', reasons: [], generation: 1 });
  h.advance(1000);
  h.registry.observeStats('viewer-a', { decodedDelta: 1, receivedDelta: 1 });
  h.advance(1000);
  assert.equal(h.events.some(event => event.event === 'media_stalled'), false);
  const snapshot = h.registry.get('viewer-a');
  assert.equal(snapshot.lastFrameAgeMs, 1000);
  assert.equal(snapshot.mediaState, 'active');
});

test('active stall records recovery then releases only after a second bounded window', () => {
  const h = fixture(30000, 60000);
  h.registry.register('viewer-a');
  h.registry.observeMedia('viewer-a', { state: 'active', generation: 1 });
  h.registry.observeStats('viewer-a', { decodedDelta: 1, receivedDelta: 1 });
  h.advance(30000);
  assert.deepEqual(h.events.map(event => event.event), ['media_stalled']);
  h.advance(60000);
  assert.equal(h.events.at(-1).event, 'media_stall_recovery_requested');
  assert.equal(h.recoveryCount, 1);
  assert.equal(h.releaseCount, 0);
  h.advance(29999);
  assert.equal(h.releaseCount, 0);
  h.advance(1);
  assert.deepEqual(h.events.map(event => event.event), [
    'media_stalled', 'media_stall_recovery_requested', 'session_stale_detected', 'slot_released',
  ]);
  assert.equal(h.releaseCount, 1);
});

test('active recovery window starts when a resumed session is first observed stalled', () => {
  const h = fixture(30000, 60000);
  h.registry.register('viewer-a');
  h.registry.observeStats('viewer-a', { decodedDelta: 1, receivedDelta: 1 });
  h.advance(120000);
  h.registry.observeMedia('viewer-a', { state: 'active', generation: 2 });
  h.registry.observeStats('viewer-a', { decodedDelta: 0, receivedDelta: 0 });
  assert.equal(h.events.at(-1).event, 'media_stalled');
  h.advance(59999);
  assert.equal(h.events.some(event => event.event === 'media_stall_recovery_requested'), false);
  h.advance(1);
  assert.equal(h.events.at(-1).event, 'media_stall_recovery_requested');
});

test('rebind preserves freshness state under the new viewer identity', () => {
  const h = fixture();
  h.registry.register('viewer-a');
  h.registry.observeMedia('viewer-a', { state: 'suspended', reasons: ['page-hidden'], generation: 4 });
  h.registry.rebind('viewer-a', 'viewer-b');
  assert.equal(h.registry.get('viewer-a'), null);
  assert.equal(h.registry.get('viewer-b').generation, 4);
});
