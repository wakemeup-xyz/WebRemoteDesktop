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

test('Host transition materialization includes only the pending lease token', () => {
  const lease = makeLease();
  const requested = lease.requestControl({ viewerId: 'viewer-a' });

  assert.equal(Object.hasOwn(requested.transition, 'leaseId'), false);
  assert.deepEqual(lease.transitionForHost({ leaseEpoch: requested.transition.leaseEpoch }), {
    type: 'control-transition',
    viewerId: 'viewer-a',
    leaseId: 'lease-0000000000000001',
    leaseEpoch: requested.transition.leaseEpoch,
  });
  assert.equal(JSON.stringify(lease.snapshot()).includes('lease-'), false);
  lease.confirmTransition({ leaseEpoch: requested.transition.leaseEpoch });
  assert.equal(lease.transitionForHost({ leaseEpoch: requested.transition.leaseEpoch }), null);
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

test('takeover candidate disconnect preserves the reset barrier until host confirmation', () => {
  const lease = makeLease();
  const first = lease.requestControl({ viewerId: 'viewer-a' });
  const activeA = lease.confirmTransition({ leaseEpoch: first.transition.leaseEpoch });
  const takeover = lease.requestControl({ viewerId: 'viewer-b', takeover: true });

  const disconnected = lease.viewerDisconnected('viewer-b');
  assert.equal(disconnected.state, 'REVOKING');
  assert.equal(lease.snapshot().state, 'REVOKING');
  assert.equal(lease.snapshot().controllerViewerId, null);
  assert.equal(lease.snapshot().pendingViewerId, null);
  assert.equal(lease.authorize({ viewerId: 'viewer-a', ...activeA.lease }), false);

  assert.deepEqual(lease.confirmTransition({ leaseEpoch: takeover.transition.leaseEpoch }), {
    state: 'FREE', reason: 'controller-disconnect',
  });

  const leaseForCancel = makeLease();
  const firstForCancel = leaseForCancel.requestControl({ viewerId: 'viewer-a' });
  leaseForCancel.confirmTransition({ leaseEpoch: firstForCancel.transition.leaseEpoch });
  const takeoverForCancel = leaseForCancel.requestControl({ viewerId: 'viewer-b', takeover: true });
  const cancelled = leaseForCancel.beginRelease({ viewerId: 'viewer-b', reason: 'manual' });
  assert.equal(cancelled.state, 'REVOKING');
  assert.equal(leaseForCancel.snapshot().controllerViewerId, null);
  assert.deepEqual(leaseForCancel.confirmTransition({ leaseEpoch: takeoverForCancel.transition.leaseEpoch }), {
    state: 'FREE', reason: 'manual',
  });
});

test('granting candidate disconnect preserves the host reset barrier', () => {
  const lease = makeLease();
  const request = lease.requestControl({ viewerId: 'viewer-a' });

  const disconnected = lease.viewerDisconnected('viewer-a');
  assert.equal(disconnected.state, 'GRANTING');
  assert.equal(disconnected.transition.leaseEpoch, request.transition.leaseEpoch);
  assert.equal(lease.snapshot().state, 'GRANTING');
  assert.equal(lease.snapshot().pendingViewerId, null);
  assert.deepEqual(lease.confirmTransition({ leaseEpoch: request.transition.leaseEpoch }), {
    state: 'FREE', reason: 'controller-disconnect',
  });
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

test('expiry at exactly expiresAfterMs starts a newer reset-only transition', () => {
  const lease = makeLease();
  const request = lease.requestControl({ viewerId: 'viewer-a' });
  const active = lease.confirmTransition({ leaseEpoch: request.transition.leaseEpoch });

  lease.advanceTo(12_000);
  const expired = lease.expire();
  assert.equal(expired.state, 'REVOKING');
  assert.equal(expired.reason, 'lease-expired');
  assert.equal(expired.transition.leaseEpoch > active.lease.leaseEpoch, true);
  assert.equal(Object.hasOwn(expired.transition, 'leaseId'), false);
  assert.equal(lease.authorize({ viewerId: 'viewer-a', ...active.lease }), false);
  assert.deepEqual(lease.confirmTransition({ leaseEpoch: expired.transition.leaseEpoch }), {
    state: 'FREE', reason: 'lease-expired',
  });
});

test('accessors reject an expired lease without starting an unobservable transition', () => {
  for (const accessor of ['heartbeat', 'authorize', 'snapshot', 'requestControl']) {
    const lease = makeLease();
    const request = lease.requestControl({ viewerId: 'viewer-a' });
    const active = lease.confirmTransition({ leaseEpoch: request.transition.leaseEpoch });
    lease.advanceTo(12_000);

    if (accessor === 'heartbeat') {
      assert.equal(lease.heartbeat({ viewerId: 'viewer-a', ...active.lease }).ok, false);
    } else if (accessor === 'authorize') {
      assert.equal(lease.authorize({ viewerId: 'viewer-a', ...active.lease }), false);
    } else if (accessor === 'snapshot') {
      assert.equal(lease.snapshot().state, 'ACTIVE');
    } else {
      assert.deepEqual(lease.requestControl({ viewerId: 'viewer-b' }), {
        state: 'ACTIVE', reason: 'lease-expired',
      });
    }

    const transition = lease.expire().transition;
    assert.deepEqual(transition, {
      type: 'control-transition',
      leaseEpoch: active.lease.leaseEpoch + 1,
      reason: 'lease-expired',
    }, accessor);
    assert.equal(lease.snapshot().state, 'REVOKING');
  }
});

test('reset transition timeout never releases an expired lease to FREE', () => {
  const lease = makeLease();
  const request = lease.requestControl({ viewerId: 'viewer-a' });
  const active = lease.confirmTransition({ leaseEpoch: request.transition.leaseEpoch });
  lease.advanceTo(12_000);
  lease.expire();
  lease.advanceTo(15_000);

  assert.deepEqual(lease.expire(), { state: 'REVOKING', reason: 'transition-timeout' });
  assert.equal(lease.snapshot().state, 'REVOKING');
  assert.equal(lease.requestControl({ viewerId: 'viewer-b' }).reason, 'occupied');
  assert.equal(lease.authorize({ viewerId: 'viewer-a', ...active.lease }), false);
});

test('ACTIVE controller disconnect enters reset-only REVOKING and freezes credentials', () => {
  const lease = makeLease();
  const request = lease.requestControl({ viewerId: 'viewer-a' });
  const active = lease.confirmTransition({ leaseEpoch: request.transition.leaseEpoch });

  const disconnected = lease.viewerDisconnected('viewer-a');
  assert.equal(disconnected.state, 'REVOKING');
  assert.equal(disconnected.reason, 'controller-disconnect');
  assert.equal(disconnected.transition.type, 'control-transition');
  assert.equal(disconnected.transition.reason, 'controller-disconnect');
  assert.equal(Object.hasOwn(disconnected.transition, 'leaseId'), false);
  assert.equal(Object.hasOwn(disconnected.transition, 'viewerId'), false);
  assert.equal(disconnected.transition.leaseEpoch > active.lease.leaseEpoch, true);
  assert.equal(lease.snapshot().state, 'REVOKING');
  assert.equal(lease.snapshot().pendingViewerId, null);
  assert.equal(lease.snapshot().controllerViewerId, null);
  assert.equal(lease.snapshot().leaseEpoch, disconnected.transition.leaseEpoch);
  assert.equal(lease.authorize({ viewerId: 'viewer-a', ...active.lease }), false);
  assert.equal(lease.requestControl({ viewerId: 'viewer-b' }).reason, 'occupied');
});

test('disconnect reset rejection stays on the same epoch and remains fail-closed', () => {
  const lease = makeLease();
  const request = lease.requestControl({ viewerId: 'viewer-a' });
  lease.confirmTransition({ leaseEpoch: request.transition.leaseEpoch });
  const disconnected = lease.viewerDisconnected('viewer-a');
  const epoch = disconnected.transition.leaseEpoch;

  const failed = lease.failTransition({ leaseEpoch: epoch, reason: 'reset-failed' });
  assert.equal(failed.state, 'REVOKING');
  assert.equal(failed.reason, 'reset-failed');
  assert.equal(Object.hasOwn(failed, 'transition'), false);
  assert.equal(lease.snapshot().state, 'REVOKING');
  assert.equal(lease.snapshot().leaseEpoch, epoch);
  assert.equal(lease.snapshot().pendingViewerId, null);
  assert.equal(lease.requestControl({ viewerId: 'viewer-b' }).reason, 'occupied');
});

test('disconnect reset timeout stays reset-blocked behind the same epoch', () => {
  const lease = makeLease();
  const request = lease.requestControl({ viewerId: 'viewer-a' });
  lease.confirmTransition({ leaseEpoch: request.transition.leaseEpoch });
  const disconnected = lease.viewerDisconnected('viewer-a');
  const epoch = disconnected.transition.leaseEpoch;

  lease.advanceTo(3_000);
  const timedOut = lease.expire();
  assert.equal(timedOut.state, 'REVOKING');
  assert.equal(timedOut.reason, 'transition-timeout');
  assert.equal(lease.snapshot().state, 'REVOKING');
  assert.equal(lease.snapshot().leaseEpoch, epoch);
  assert.equal(lease.snapshot().pendingViewerId, null);
  assert.equal(lease.requestControl({ viewerId: 'viewer-b' }).reason, 'occupied');
});

test('late stale ack cannot release an ACTIVE disconnect barrier', () => {
  const lease = makeLease();
  const request = lease.requestControl({ viewerId: 'viewer-a' });
  const active = lease.confirmTransition({ leaseEpoch: request.transition.leaseEpoch });
  const disconnected = lease.viewerDisconnected('viewer-a');

  assert.equal(
    lease.confirmTransition({ leaseEpoch: active.lease.leaseEpoch }).reason,
    'stale-transition',
  );
  assert.equal(lease.snapshot().state, 'REVOKING');
  assert.equal(lease.snapshot().leaseEpoch, disconnected.transition.leaseEpoch);

  assert.deepEqual(lease.confirmTransition({
    leaseEpoch: disconnected.transition.leaseEpoch,
  }), {
    state: 'FREE', reason: 'controller-disconnect',
  });
  assert.equal(lease.snapshot().state, 'FREE');
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

test('pending candidate transition timeout enters reset-only REVOKING and rejects old ack', () => {
  const lease = makeLease();
  const request = lease.requestControl({ viewerId: 'viewer-a' });

  lease.advanceTo(2_999);
  assert.equal(lease.expire().state, 'GRANTING');
  lease.advanceTo(3_000);
  const failed = lease.expire();
  assert.equal(failed.state, 'REVOKING');
  assert.equal(failed.reason, 'transition-timeout');
  assert.equal(failed.transition.type, 'control-transition');
  assert.equal(failed.transition.leaseEpoch > request.transition.leaseEpoch, true);
  assert.equal(Object.hasOwn(failed.transition, 'leaseId'), false);
  assert.equal(lease.snapshot().state, 'REVOKING');
  assert.equal(lease.snapshot().pendingViewerId, null);
  assert.equal(lease.snapshot().leaseEpoch, failed.transition.leaseEpoch);
  assert.equal(lease.snapshot().reason, 'transition-timeout');
  assert.equal(lease.confirmTransition({ leaseEpoch: request.transition.leaseEpoch }).reason, 'stale-transition');
  assert.equal(lease.requestControl({ viewerId: 'viewer-b' }).reason, 'occupied');
});

test('candidate GRANTING rejection discards token, increments epoch, and enters reset-only REVOKING', () => {
  const lease = makeLease();
  const request = lease.requestControl({ viewerId: 'viewer-a' });
  const candidateEpoch = request.transition.leaseEpoch;
  const hostMaterial = lease.transitionForHost({ leaseEpoch: candidateEpoch });
  assert.equal(Boolean(hostMaterial.leaseId), true);

  const failed = lease.failTransition({ leaseEpoch: candidateEpoch, reason: 'reset-failed' });
  assert.equal(failed.state, 'REVOKING');
  assert.equal(failed.reason, 'reset-failed');
  assert.equal(failed.transition.leaseEpoch, candidateEpoch + 1);
  assert.equal(Object.hasOwn(failed.transition, 'leaseId'), false);
  assert.equal(lease.snapshot().state, 'REVOKING');
  assert.equal(lease.snapshot().pendingViewerId, null);
  assert.equal(lease.snapshot().leaseEpoch, candidateEpoch + 1);
  assert.equal(lease.snapshot().reason, 'reset-failed');
  assert.equal(JSON.stringify(lease.snapshot()).includes('lease-'), false);
  assert.equal(lease.authorize({
    viewerId: 'viewer-a',
    leaseId: hostMaterial.leaseId,
    leaseEpoch: candidateEpoch,
  }), false);
  assert.equal(lease.requestControl({ viewerId: 'viewer-b' }).reason, 'occupied');
  assert.equal(lease.confirmTransition({ leaseEpoch: candidateEpoch }).reason, 'stale-transition');
});

test('reset-only REVOKING rejection stays on the same epoch and does not enter FREE', () => {
  const lease = makeLease();
  const request = lease.requestControl({ viewerId: 'viewer-a' });
  lease.confirmTransition({ leaseEpoch: request.transition.leaseEpoch });
  const release = lease.beginRelease({ viewerId: 'viewer-a', reason: 'manual' });
  const epoch = release.transition.leaseEpoch;

  const failed = lease.failTransition({ leaseEpoch: epoch, reason: 'reset-failed' });
  assert.equal(failed.state, 'REVOKING');
  assert.equal(failed.reason, 'reset-failed');
  assert.equal(Object.hasOwn(failed, 'transition'), false);
  assert.equal(lease.snapshot().state, 'REVOKING');
  assert.equal(lease.snapshot().pendingViewerId, null);
  assert.equal(lease.snapshot().leaseEpoch, epoch);
  assert.equal(lease.snapshot().reason, 'reset-failed');
  assert.equal(lease.requestControl({ viewerId: 'viewer-b' }).reason, 'occupied');
});

test('reset-only applied ack is the only ack path into FREE after fail-closed barrier', () => {
  const lease = makeLease();
  const request = lease.requestControl({ viewerId: 'viewer-a' });
  const failed = lease.failTransition({ leaseEpoch: request.transition.leaseEpoch, reason: 'execution-failed' });
  assert.equal(failed.state, 'REVOKING');
  assert.equal(lease.confirmTransition({ leaseEpoch: request.transition.leaseEpoch }).reason, 'stale-transition');
  assert.equal(lease.snapshot().state, 'REVOKING');

  assert.deepEqual(lease.confirmTransition({ leaseEpoch: failed.transition.leaseEpoch }), {
    state: 'FREE', reason: 'execution-failed',
  });
  assert.equal(lease.snapshot().state, 'FREE');
  assert.equal(lease.snapshot().pendingViewerId, null);
});

test('stale failTransition epoch has no state mutation', () => {
  const lease = makeLease();
  const request = lease.requestControl({ viewerId: 'viewer-a' });
  const before = lease.snapshot();
  assert.deepEqual(lease.failTransition({ leaseEpoch: request.transition.leaseEpoch - 1, reason: 'reset-failed' }), {
    state: 'GRANTING', reason: 'stale-transition',
  });
  assert.deepEqual(lease.snapshot(), before);
  assert.equal(lease.snapshot().state, 'GRANTING');
  assert.equal(lease.snapshot().pendingViewerId, 'viewer-a');
});

test('rejectTransition is a thin alias of failTransition', () => {
  const lease = makeLease();
  const request = lease.requestControl({ viewerId: 'viewer-a' });
  const failed = lease.rejectTransition({ leaseEpoch: request.transition.leaseEpoch, reason: 'reset-failed' });
  assert.equal(failed.state, 'REVOKING');
  assert.equal(failed.reason, 'reset-failed');
  assert.equal(lease.snapshot().state, 'REVOKING');
  assert.equal(lease.snapshot().pendingViewerId, null);
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
