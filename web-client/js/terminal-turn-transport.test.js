'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createTurnTransportState } = require('./terminal-turn-transport');

test('shouldSuppressSocketOutput false when bound sid !== active', () => {
  const t = createTurnTransportState();
  t.preferred = 'webrtc-turn';
  t.dcOpen = true;
  t.outputReady = true;
  t.activeSessionId = 'B';
  t.boundSessionId = 'A';
  assert.equal(t.shouldSuppressSocketOutput('B'), false);
  assert.equal(t.shouldSuppressSocketOutput('A'), false);
});

test('shouldSuppressSocketOutput true when bound===active===session and ready', () => {
  const t = createTurnTransportState();
  t.preferred = 'webrtc-turn';
  t.dcOpen = true;
  t.outputReady = true;
  t.activeSessionId = 'B';
  t.boundSessionId = 'B';
  assert.equal(t.shouldSuppressSocketOutput('B'), true);
});

test('shouldSuppressSocketOutput false until outputReady even if bound matches', () => {
  const t = createTurnTransportState();
  t.preferred = 'webrtc-turn';
  t.dcOpen = true;
  t.outputReady = false;
  t.activeSessionId = 'B';
  t.boundSessionId = 'B';
  assert.equal(t.shouldSuppressSocketOutput('B'), false);
});

test('shouldSuppressSocketOutput false when preferred is not webrtc-turn', () => {
  const t = createTurnTransportState();
  t.preferred = 'socketio';
  t.dcOpen = true;
  t.outputReady = true;
  t.activeSessionId = 'B';
  t.boundSessionId = 'B';
  assert.equal(t.shouldSuppressSocketOutput('B'), false);
});

test('canSendInput requires ready and open dc, not preferred alone', () => {
  const t = createTurnTransportState();
  t.preferred = 'webrtc-turn';
  t.dcOpen = false;
  t.ready = false;
  assert.equal(t.canSendInput(), false);

  t.dcOpen = true;
  t.ready = false;
  assert.equal(t.canSendInput(), false);

  t.ready = true;
  assert.equal(t.canSendInput(), true);

  // Pure adapter readiness: does not require preferred=webrtc-turn.
  t.preferred = 'socketio';
  assert.equal(t.canSendInput(), true);
});

test('beginRebind clears bound/outputReady and builds preferDcOutput bind frame', () => {
  const t = createTurnTransportState();
  t.preferred = 'webrtc-turn';
  t.dcOpen = true;
  t.ready = true;
  t.outputReady = true;
  t.activeSessionId = 'B';
  t.boundSessionId = 'A';

  const frame = t.beginRebind('B', { clientId: 'browser_1' });
  assert.equal(t.boundSessionId, null);
  assert.equal(t.outputReady, false);
  assert.equal(t.shouldSuppressSocketOutput('B'), false);
  assert.deepEqual(frame, {
    t: 'bind',
    sid: 'B',
    preferDcOutput: true,
    clientId: 'browser_1',
  });
});

test('markOutputBound restores suppression only for matching active bound sid', () => {
  const t = createTurnTransportState();
  t.preferred = 'webrtc-turn';
  t.dcOpen = true;
  t.ready = true;
  t.activeSessionId = 'B';
  t.beginRebind('B');
  assert.equal(t.shouldSuppressSocketOutput('B'), false);

  t.markOutputBound('B');
  assert.equal(t.boundSessionId, 'B');
  assert.equal(t.outputReady, true);
  assert.equal(t.shouldSuppressSocketOutput('B'), true);
});
