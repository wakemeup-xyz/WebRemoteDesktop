'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ConnectionSession, MediaPaintGate, ControlLeaseView, DesktopSessionCoordinator } = require('./desktop-session-coordinator');

test('connection session is a reducer with monotonic attempt metadata', () => {
  const session = ConnectionSession();
  assert.equal(session.snapshot().status, 'idle');
  session.transition({ type: 'signaling', attemptId: 'a1', attemptSequence: 1 });
  assert.deepEqual(session.snapshot(), { status: 'signaling', attemptId: 'a1', attemptSequence: 1, reason: null });
  session.transition({ type: 'connected' });
  assert.equal(session.snapshot().status, 'connected');
});

test('media paint gate remains fail-closed until a current-attempt frame paints', () => {
  const gate = MediaPaintGate();
  gate.begin('a1');
  gate.noteDecoded(4);
  assert.equal(gate.snapshot().failClosed, true);
  gate.notePainted({ attemptId: 'old' });
  assert.equal(gate.snapshot().hasPaintedFrame, false);
  gate.notePainted({ attemptId: 'a1' });
  assert.equal(gate.snapshot().failClosed, false);
  assert.equal(gate.snapshot().phase, 'connected');
});

test('lease view returns copies and clears lease on revoke', () => {
  const lease = ControlLeaseView();
  const value = lease.apply({ state: 'ACTIVE', controller: true, lease: { leaseId: 'l1', leaseEpoch: 2 } });
  value.lease.leaseId = 'mutated';
  assert.equal(lease.snapshot().lease.leaseId, 'l1');
  assert.equal(lease.clear('revoked').controller, false);
});

test('coordinator composes independent seams and publishes snapshots', () => {
  const coordinator = DesktopSessionCoordinator();
  const seen = [];
  coordinator.subscribe((snapshot) => seen.push(snapshot));
  coordinator.transitionConnection({ type: 'connected', attemptId: 'a1' });
  coordinator.beginMedia('a1');
  coordinator.noteMediaPainted({ attemptId: 'a1' });
  coordinator.applyControlLease({ controller: true, state: 'ACTIVE', lease: { leaseId: 'l1', leaseEpoch: 1 } });
  assert.equal(coordinator.snapshot().uiPhase, 'connected');
  assert.equal(seen.length, 4);
  assert.equal(coordinator.snapshot().lease.lease.leaseId, 'l1');
});
