'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { createViewerHeartbeatRegistry } = require('./viewer-heartbeat');

function fixture() {
  const lines = [];
  const snapshots = [];
  const timers = [];
  const cleared = [];
  const owner = new EventEmitter();
  owner._wrdProofViewer = false;
  owner.conn = new EventEmitter();
  const registry = createViewerHeartbeatRegistry({
    logger: { log: line => lines.push(JSON.parse(line.slice('WRD_SIGNAL_HEARTBEAT '.length))) },
    onSnapshot: data => snapshots.push(data),
    setIntervalFn: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; },
    clearIntervalFn: timer => cleared.push(timer),
    now: (() => { let value = 0; return () => (value += 1); })(),
    wallNow: () => 1000,
  });
  registry.attach(owner, () => true);
  return { owner, registry, lines, snapshots, timers, cleared };
}

test('heartbeat emits bounded live snapshot on first diagnostic ring eviction and periodically', () => {
  const h = fixture();
  assert.equal(h.timers.length, 1);
  for (let i = 0; i < 33; i += 1) h.owner.conn.emit('packet', { type: 'pong' });
  assert.equal(h.lines.filter(row => row.event === 'viewer-heartbeat-snapshot').length, 1);
  const snapshot = h.lines.find(row => row.event === 'viewer-heartbeat-snapshot');
  assert.equal(snapshot.ringDropped, 1);
  assert.equal(snapshot.coverage.state, 'partial');
  h.timers[0].fn();
  assert.equal(h.lines.filter(row => row.event === 'viewer-heartbeat-snapshot').length, 2);
  assert.equal(h.snapshots.length, 2);
  h.owner.emit('disconnect', 'transport close');
  return Promise.resolve().then(() => {
    assert.equal(h.lines.at(-1).event, 'viewer-heartbeat-close');
    assert.deepEqual(h.cleared, [h.timers[0]]);
  });
});

