'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { DesktopControlLease } = require('./desktop-control-lease');

function makeLease() {
  let currentTime = 0;
  let id = 0;
  const lease = new DesktopControlLease({
    now: () => currentTime,
    makeLeaseId: () => `lease-${String(++id).padStart(16, '0')}`,
  });
  lease.advanceTo = (value) => { currentTime = value; };
  return lease;
}

test('first acquire stays granting until transition ack and returns a lease', () => {
  const lease = makeLease();
  const requested = lease.requestControl({ viewerId: 'viewer-a' });

  assert.equal(requested.state, 'GRANTING');
  assert.equal(requested.transition.type, 'control-transition');
  assert.equal(requested.transition.leaseEpoch, 1);
  assert.equal(Object.hasOwn(requested.transition, 'leaseId'), false);
  assert.equal(JSON.stringify(requested.transition).includes('lease-'), false);
  assert.equal(lease.snapshot().controllerViewerId, null);

  const granted = lease.confirmTransition({ leaseEpoch: 1 });
  assert.equal(granted.state, 'ACTIVE');
  assert.deepEqual(granted.lease, { leaseId: 'lease-0000000000000001', leaseEpoch: 1 });
  assert.equal(Object.hasOwn(lease.snapshot(), 'leaseId'), false);
  assert.equal(JSON.stringify(lease.snapshot()).includes('lease-'), false);
  assert.equal(lease.authorize({ viewerId: 'viewer-a', ...granted.lease }), true);
});

test('occupied lease denies read-only acquisition', () => {
  const lease = makeLease();
  const first = lease.requestControl({ viewerId: 'viewer-a' });
  lease.confirmTransition({ leaseEpoch: first.transition.leaseEpoch });

  const denied = lease.requestControl({ viewerId: 'viewer-b' });
  assert.equal(denied.state, 'ACTIVE');
  assert.equal(denied.reason, 'occupied');
  assert.equal(denied.controllerViewerId, 'viewer-a');
});

test('takeover freezes old controller until host transition ack grants new lease', () => {
  const lease = makeLease();
  const first = lease.requestControl({ viewerId: 'viewer-a' });
  const activeA = lease.confirmTransition({ leaseEpoch: first.transition.leaseEpoch });
  assert.equal(lease.authorize({ viewerId: 'viewer-a', ...activeA.lease }), true);

  const takeover = lease.requestControl({ viewerId: 'viewer-b', takeover: true });
  assert.equal(takeover.state, 'REVOKING');
  assert.equal(lease.authorize({ viewerId: 'viewer-a', ...activeA.lease }), false);
  assert.equal(lease.snapshot().controllerViewerId, null);

  const activeB = lease.confirmTransition({ leaseEpoch: takeover.transition.leaseEpoch });
  assert.equal(activeB.state, 'ACTIVE');
  assert.equal(lease.authorize({ viewerId: 'viewer-b', ...activeB.lease }), true);
  assert.equal(lease.authorize({ viewerId: 'viewer-a', ...activeA.lease }), false);
});

test('stale transition acknowledgements cannot grant or alter the current transition', () => {
  const lease = makeLease();
  const first = lease.requestControl({ viewerId: 'viewer-a' });
  assert.deepEqual(lease.confirmTransition({ leaseEpoch: first.transition.leaseEpoch - 1 }), {
    state: 'GRANTING', reason: 'stale-transition',
  });
  assert.equal(lease.snapshot().state, 'GRANTING');
  lease.rejectTransition({ leaseEpoch: first.transition.leaseEpoch - 1, reason: 'late' });
  assert.equal(lease.snapshot().state, 'GRANTING');
});

test('heartbeat accepts the active credential and refreshes expiry through 11999ms', () => {
  const lease = makeLease();
  const request = lease.requestControl({ viewerId: 'viewer-a' });
  const active = lease.confirmTransition({ leaseEpoch: request.transition.leaseEpoch });

  lease.advanceTo(11_999);
  assert.deepEqual(lease.heartbeat({ viewerId: 'viewer-a', ...active.lease }), {
    state: 'ACTIVE', ok: true,
  });
  assert.equal(lease.authorize({ viewerId: 'viewer-a', ...active.lease }), true);
});

test('expiry at exactly expiresAfterMs releases the active lease', () => {
  const lease = makeLease();
  const request = lease.requestControl({ viewerId: 'viewer-a' });
  const active = lease.confirmTransition({ leaseEpoch: request.transition.leaseEpoch });

  lease.advanceTo(12_000);
  assert.deepEqual(lease.expire(), { state: 'FREE', reason: 'lease-expired' });
  assert.equal(lease.authorize({ viewerId: 'viewer-a', ...active.lease }), false);
});

test('controller disconnect releases the lease and rejects its old credential', () => {
  const lease = makeLease();
  const request = lease.requestControl({ viewerId: 'viewer-a' });
  const active = lease.confirmTransition({ leaseEpoch: request.transition.leaseEpoch });

  assert.deepEqual(lease.viewerDisconnected('viewer-a'), {
    state: 'FREE', reason: 'controller-disconnect',
  });
  assert.equal(lease.authorize({ viewerId: 'viewer-a', ...active.lease }), false);
});

test('host disconnect releases both active and pending transitions', () => {
  const lease = makeLease();
  const request = lease.requestControl({ viewerId: 'viewer-a' });
  assert.deepEqual(lease.hostDisconnected(), { state: 'FREE', reason: 'host-disconnect' });
  assert.equal(lease.confirmTransition({ leaseEpoch: request.transition.leaseEpoch }).reason, 'stale-transition');

  const second = lease.requestControl({ viewerId: 'viewer-b' });
  const active = lease.confirmTransition({ leaseEpoch: second.transition.leaseEpoch });
  assert.deepEqual(lease.hostDisconnected(), { state: 'FREE', reason: 'host-disconnect' });
  assert.equal(lease.authorize({ viewerId: 'viewer-b', ...active.lease }), false);
});

test('pending transition timeout returns to free and rejects its ack', () => {
  const lease = makeLease();
  const request = lease.requestControl({ viewerId: 'viewer-a' });

  lease.advanceTo(2_999);
  assert.equal(lease.expire().state, 'GRANTING');
  lease.advanceTo(3_000);
  assert.deepEqual(lease.expire(), { state: 'FREE', reason: 'transition-timeout' });
  assert.equal(lease.confirmTransition({ leaseEpoch: request.transition.leaseEpoch }).reason, 'stale-transition');
});

test('release is owner-only, freezes authorization, and waits for host reset confirmation', () => {
  const lease = makeLease();
  const request = lease.requestControl({ viewerId: 'viewer-a' });
  const active = lease.confirmTransition({ leaseEpoch: request.transition.leaseEpoch });

  assert.deepEqual(lease.beginRelease({ viewerId: 'viewer-b', reason: 'manual' }), {
    state: 'ACTIVE', reason: 'not-controller',
  });
  const release = lease.beginRelease({ viewerId: 'viewer-a', reason: 'manual' });
  assert.equal(release.state, 'REVOKING');
  assert.equal(release.transition.type, 'control-transition');
  assert.equal(Object.hasOwn(release.transition, 'leaseId'), false);
  assert.equal(lease.authorize({ viewerId: 'viewer-a', ...active.lease }), false);
  assert.equal(lease.snapshot().controllerViewerId, null);
  assert.deepEqual(lease.confirmTransition({ leaseEpoch: release.transition.leaseEpoch }), {
    state: 'FREE', reason: 'manual',
  });
});

test('old credentials remain rejected after a new lease is granted', () => {
  const lease = makeLease();
  const first = lease.requestControl({ viewerId: 'viewer-a' });
  const activeA = lease.confirmTransition({ leaseEpoch: first.transition.leaseEpoch });
  const release = lease.beginRelease({ viewerId: 'viewer-a', reason: 'manual' });
  lease.confirmTransition({ leaseEpoch: release.transition.leaseEpoch });
  const second = lease.requestControl({ viewerId: 'viewer-b' });
  const activeB = lease.confirmTransition({ leaseEpoch: second.transition.leaseEpoch });

  assert.equal(activeB.lease.leaseEpoch > activeA.lease.leaseEpoch, true);
  assert.equal(lease.authorize({ viewerId: 'viewer-a', ...activeA.lease }), false);
  assert.equal(lease.authorize({ viewerId: 'viewer-b', ...activeB.lease }), true);
});
