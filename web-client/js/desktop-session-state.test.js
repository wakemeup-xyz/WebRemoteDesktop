'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDesktopSessionState } = require('./desktop-session-state');

test('initial snapshot is idle and fail-closed for input', () => {
  const state = createDesktopSessionState({ clock: () => 100 });
  assert.deepEqual(state.snapshot(), {
    attemptId: null,
    phase: 'idle',
    media: 'none',
    control: 'free',
    socket: 'offline',
    canInput: false,
    lastTransitionAt: 100,
  });
});

test('peer connected remains media-pending until a fresh frame', () => {
  const state = createDesktopSessionState({ clock: (() => { let n = 100; return () => ++n; })() });
  const attempt = state.beginAttempt('attempt-a');
  state.applyConnection({ attemptId: attempt.attemptId, state: 'connecting', socket: 'online' });
  state.applyConnection({ attemptId: attempt.attemptId, state: 'connected' });
  assert.equal(state.snapshot().phase, 'media-pending');
  assert.equal(state.snapshot().media, 'pending');
  state.applyMedia({ attemptId: attempt.attemptId, event: 'fresh-frame', fresh: true });
  assert.equal(state.snapshot().phase, 'connected');
  assert.equal(state.snapshot().media, 'live');
});

test('old attempt events cannot mutate the current snapshot', () => {
  const state = createDesktopSessionState();
  const first = state.beginAttempt('attempt-a');
  state.applyConnection({ attemptId: first.attemptId, state: 'connected', socket: 'online' });
  const second = state.beginAttempt('attempt-b');
  const before = state.snapshot();
  state.applyMedia({ attemptId: first.attemptId, event: 'fresh-frame', fresh: true });
  state.applyControl({ attemptId: first.attemptId, state: 'active' });
  state.applyConnection({ attemptId: first.attemptId, state: 'disconnected', socket: 'offline' });
  assert.deepEqual(state.snapshot(), before);
  assert.equal(second.attemptId, 'attempt-b');
});

test('input requires live media, online socket, and active control', () => {
  const state = createDesktopSessionState();
  const attempt = state.beginAttempt('attempt-a', { socket: 'online' });
  state.applyConnection({ attemptId: attempt.attemptId, state: 'connected' });
  state.applyControl({ attemptId: attempt.attemptId, state: 'active' });
  assert.equal(state.snapshot().canInput, false);
  state.applyMedia({ attemptId: attempt.attemptId, event: 'fresh-frame' });
  assert.equal(state.snapshot().canInput, true);
  state.applyMedia({ attemptId: attempt.attemptId, state: 'stalled' });
  assert.equal(state.snapshot().canInput, false);
});

test('stale fallback cannot grant input before the state module is available', () => {
  const session = createDesktopSessionState({ clock: () => 1 });
  assert.equal(session.snapshot().canInput, false);
});
