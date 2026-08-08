'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('remove by socketId returns Socket.IO and webrtc observers', () => {
  const session = {
    observers: new Map([
      ['sock-1', { observerId: 'sock-1', socketId: 'sock-1', clientId: 'sock-1' }],
      ['webrtc:sock-1', { observerId: 'webrtc:sock-1', socketId: 'sock-1', clientId: 'sock-1' }],
    ]),
  };
  const { removeObservers } = require('../lib/terminal/presence');
  const result = removeObservers(session.observers, { socketId: 'sock-1' });
  assert.equal(session.observers.size, 0);
  assert.equal(result.removedCount, 2);
  assert.deepEqual(
    result.removed.map((item) => item.observerId).sort(),
    ['sock-1', 'webrtc:sock-1'].sort(),
  );
});

test('remove by exact observerId deletes only that entry', () => {
  const observers = new Map([
    ['sock-1', { observerId: 'sock-1', socketId: 'sock-1', clientId: 'c1' }],
    ['webrtc:sock-1', { observerId: 'webrtc:sock-1', socketId: 'sock-1', clientId: 'c1' }],
  ]);
  const { removeObservers } = require('../lib/terminal/presence');
  const result = removeObservers(observers, {
    observerId: 'webrtc:sock-1',
    socketId: 'sock-1',
    clientId: 'c1',
  });
  assert.equal(result.removedCount, 1);
  assert.equal(result.removed[0].observerId, 'webrtc:sock-1');
  assert.equal(observers.size, 1);
  assert.equal(observers.has('sock-1'), true);
  assert.equal(observers.has('webrtc:sock-1'), false);
});

test('exact observerId that is missing does not expand to socketId matches', () => {
  const observers = new Map([
    ['sock-1', { observerId: 'sock-1', socketId: 'sock-1', clientId: 'c1' }],
  ]);
  const { removeObservers } = require('../lib/terminal/presence');
  const result = removeObservers(observers, {
    observerId: 'webrtc:sock-1',
    socketId: 'sock-1',
  });
  assert.equal(result.removedCount, 0);
  assert.equal(observers.size, 1);
  assert.equal(observers.has('sock-1'), true);
});

test('remove by clientId deletes all matching observers', () => {
  const observers = new Map([
    ['sock-a', { observerId: 'sock-a', socketId: 'sock-a', clientId: 'browser-a' }],
    ['webrtc:sock-a', { observerId: 'webrtc:sock-a', socketId: 'sock-a', clientId: 'browser-a' }],
    ['sock-b', { observerId: 'sock-b', socketId: 'sock-b', clientId: 'browser-b' }],
  ]);
  const { removeObservers } = require('../lib/terminal/presence');
  const result = removeObservers(observers, { clientId: 'browser-a' });
  assert.equal(result.removedCount, 2);
  assert.equal(observers.size, 1);
  assert.equal(observers.has('sock-b'), true);
});

test('hasObserver reports presence by observerId, socketId, or clientId', () => {
  const observers = new Map([
    ['sock-1', { observerId: 'sock-1', socketId: 'sock-1', clientId: 'c1' }],
    ['webrtc:sock-1', { observerId: 'webrtc:sock-1', socketId: 'sock-1', clientId: 'c1' }],
  ]);
  const { hasObserver } = require('../lib/terminal/presence');
  assert.equal(hasObserver(observers, { observerId: 'webrtc:sock-1' }), true);
  assert.equal(hasObserver(observers, { observerId: 'missing' }), false);
  assert.equal(hasObserver(observers, { socketId: 'sock-1' }), true);
  assert.equal(hasObserver(observers, { socketId: 'other' }), false);
  assert.equal(hasObserver(observers, { clientId: 'c1' }), true);
  assert.equal(hasObserver(observers, { clientId: 'c2' }), false);
});
