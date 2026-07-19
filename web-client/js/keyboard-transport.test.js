const assert = require('node:assert/strict');
const test = require('node:test');

const KeyboardTransport = require('./keyboard-transport.js');
const { validateRemoteInput } = require('../../signal-server/lib/remote-input-contract.js');

function createHarness(options = {}) {
  let time = 1000;
  let nextId = 0;
  const dataChannel = [];
  const socket = [];
  const transport = KeyboardTransport.create({
    sendDataChannel(payload) {
      dataChannel.push(payload);
      return options.dataChannelResult;
    },
    sendSocket(payload) {
      socket.push(payload);
      return options.socketResult;
    },
    now: () => time,
    makeInputId: () => `input-${++nextId}`,
    ackTimeoutMs: options.ackTimeoutMs || 3000,
  });
  transport.setLease({ leaseId: 'lease-for-test-0001', leaseEpoch: 7 });
  return {
    transport,
    dataChannel,
    socket,
    advance(ms) { time += ms; },
  };
}

test('late DataChannel key is invalidated by a higher Socket reset after DataChannel becomes unavailable', () => {
  const h = createHarness();
  const keyId = h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } });
  assert.equal(h.dataChannel.length, 1);
  assert.equal(h.dataChannel[0].seq, 1);

  h.transport.markAdapterUnavailable('dataChannel');
  assert.equal(h.socket.length, 1);
  assert.equal(h.socket[0].action, 'reset');
  assert.equal(h.socket[0].seq, 2);
  assert.deepEqual(h.socket[0].payload, { reason: 'transport-change' });
  assert.equal(validateRemoteInput(h.socket[0]).ok, true);
  assert.equal(h.transport.canSendNewInput(), false);

  h.transport.acceptAck({ schemaVersion: 2, leaseEpoch: 7, appliedSeq: 2, status: 'applied' });
  assert.equal(h.transport.canSendNewInput(), true);
  assert.equal(h.transport.acceptAck({ schemaVersion: 2, leaseEpoch: 7, appliedSeq: 1, status: 'duplicate' }).status, 'stale');
  assert.equal(keyId, 'input-1');
});

test('a DataChannel adapter can be re-enabled after an initial unavailable state', () => {
  const h = createHarness();
  h.transport.markAdapterUnavailable('dataChannel');
  h.transport.acceptAck({ schemaVersion: 2, leaseEpoch: 7, appliedSeq: 1, status: 'applied' });

  h.transport.markAdapterAvailable('dataChannel');
  h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyD' } });

  assert.equal(h.dataChannel.length, 1);
  assert.equal(h.dataChannel[0].payload.code, 'KeyD');
  assert.equal(h.socket.length, 1);
});

test('reset barrier blocks new input until its applied or duplicate acknowledgement', () => {
  const h = createHarness();
  const resetId = h.transport.resetBarrier('focus-lost');
  assert.equal(h.socket.length, 1);
  assert.equal(h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyB' } }), null);
  assert.equal(h.transport.acceptAck({ schemaVersion: 2, leaseEpoch: 7, appliedSeq: 1, status: 'applied' }).status, 'applied');
  assert.equal(h.transport.canSendNewInput(), true);

  const secondReset = h.transport.resetBarrier('focus-lost-again');
  assert.equal(h.transport.acceptAck({ schemaVersion: 2, leaseEpoch: 7, appliedSeq: 2, status: 'duplicate' }).status, 'duplicate');
  assert.equal(h.transport.canSendNewInput(), true);
  assert.equal(resetId, 'input-1');
  assert.equal(secondReset, 'input-2');
});

test('keyboard transport pins its adapter until every physical key is released', () => {
  const h = createHarness();
  h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } });
  h.transport.markAdapterUnavailable('socket');
  h.transport.send({ type: 'keyboard', action: 'keyup', payload: { code: 'KeyA' } });

  assert.equal(h.dataChannel.length, 2);
  assert.equal(h.dataChannel[1].action, 'key');
  assert.equal(h.dataChannel[1].payload.phase, 'up');
  assert.equal(h.transport.getSnapshot().adapter, null);
});

test('spec acknowledgement envelope advances the cumulative ledger and duplicate acknowledgements are harmless', () => {
  const h = createHarness();
  const one = h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } });
  const two = h.transport.send({ type: 'keyboard', action: 'keyup', payload: { code: 'KeyA' } });

  assert.equal(h.transport.acceptAck({ schemaVersion: 2, leaseEpoch: 7, appliedSeq: 2, status: 'applied' }).status, 'applied');
  assert.equal(h.transport.getSnapshot().lastApplied, 2);
  assert.equal(h.transport.acceptAck({ schemaVersion: 2, leaseEpoch: 7, appliedSeq: 2, status: 'duplicate' }).status, 'duplicate');
  assert.equal(one, 'input-1');
  assert.equal(two, 'input-2');
});

test('resync-required and sequence gaps preserve one Socket reset barrier', () => {
  const h = createHarness();
  h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } });
  const result = h.transport.acceptAck({ schemaVersion: 2, leaseEpoch: 7, appliedSeq: 0, status: 'resync-required' });

  assert.equal(result.status, 'resync-required');
  assert.equal(h.socket.length, 1);
  assert.equal(h.socket[0].action, 'reset');
  assert.equal(h.socket[0].seq, 2);
  assert.deepEqual(h.socket[0].payload, { reason: 'transport-change' });
  assert.equal(validateRemoteInput(h.socket[0]).ok, true);
  assert.equal(h.transport.canSendNewInput(), false);
  assert.equal(h.transport.acceptAck({ schemaVersion: 2, leaseEpoch: 7, appliedSeq: 3, status: 'applied' }).status, 'resync-required');
  assert.equal(h.socket.length, 1);
  assert.equal(h.transport.canSendNewInput(), false);
});

test('sequence gaps emit a validator-valid transport-change reset', () => {
  const h = createHarness();
  h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } });

  assert.equal(h.transport.acceptAck({ schemaVersion: 2, leaseEpoch: 7, appliedSeq: 3, status: 'applied' }).status, 'resync-required');
  assert.deepEqual(h.socket[0].payload, { reason: 'transport-change' });
  assert.equal(validateRemoteInput(h.socket[0]).ok, true);
});

test('a sequence-gap acknowledgement enters one reset barrier before accepting new input', () => {
  const h = createHarness();
  h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } });

  assert.equal(h.transport.acceptAck({
    schemaVersion: 2, leaseEpoch: 7, appliedSeq: 0, status: 'sequence-gap',
  }).status, 'resync-required');
  assert.equal(h.socket.length, 1);
  assert.equal(h.socket[0].action, 'reset');
  assert.equal(h.transport.getSnapshot().state, 'blocked');
  assert.equal(h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyB' } }), null);
});

test('terminal v2 acknowledgement errors revoke the local lease without advancing pending input', () => {
  const terminalStatuses = ['stale-lease', 'invalid-input', 'unsupported-code', 'execution-failed'];

  for (const status of terminalStatuses) {
    const h = createHarness();
    h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } });

    assert.equal(h.transport.acceptAck({
      schemaVersion: 2, leaseEpoch: 7, appliedSeq: 0, status,
    }).status, 'reacquire-required');
    assert.equal(h.transport.getSnapshot().state, 'reacquire-required');
    assert.equal(h.transport.getSnapshot().lastApplied, 0);
    assert.equal(h.transport.getSnapshot().pendingCount, 1);
    assert.equal(h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyB' } }), null);
  }
});

test('expired reset barrier requires lease reacquisition before accepting new input', () => {
  const h = createHarness({ ackTimeoutMs: 50 });
  h.transport.resetBarrier('test-timeout');
  assert.equal(h.transport.canSendNewInput(), false);
  h.advance(51);
  assert.equal(h.transport.canSendNewInput(), false);
  const expired = h.transport.getSnapshot();
  assert.equal(expired.state, 'reacquire-required');
  assert.equal(expired.pendingCount, 0);
  assert.equal(JSON.stringify(expired).includes('lease-for-test'), false);

  h.transport.setLease({ leaseId: 'renewed-lease', leaseEpoch: 8 });
  assert.equal(h.transport.canSendNewInput(), true);
  assert.equal(h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyR' } }), 'input-2');
});

test('pending ledger is bounded at 256 and adapter rejections do not reject input', () => {
  const h = createHarness({ dataChannelResult: false });
  for (let index = 0; index < 300; index += 1) {
    const id = h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: `Key${index}` } });
    assert.equal(id, `input-${index + 1}`);
  }
  assert.equal(h.transport.getSnapshot().pendingCount, 256);
  assert.equal(h.dataChannel.length, 300);
});

test('lease revocation disables sends and snapshots never expose the lease token', () => {
  const h = createHarness();
  h.transport.setLease(null);
  assert.equal(h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyZ' } }), null);
  const snapshot = h.transport.getSnapshot();
  assert.equal(snapshot.state, 'revoked');
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'lease'), false);
  assert.equal(JSON.stringify(snapshot).includes('lease-for-test'), false);
});

test('all outgoing inputs carry the RemoteInput v2 envelope', () => {
  const h = createHarness();
  h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyQ' } });
  assert.deepEqual(h.dataChannel[0], {
    type: 'keyboard',
    action: 'key',
    schemaVersion: 2,
    leaseId: 'lease-for-test-0001',
    leaseEpoch: 7,
    seq: 1,
    inputIds: ['input-1'],
    payload: {
      phase: 'down',
      code: 'KeyQ',
      location: 0,
      repeat: false,
      modifiers: { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false },
      locks: { capsLock: false },
    },
  });
});

test('non-spec lease and acknowledgement aliases do not authorize input or advance state', () => {
  const h = createHarness();
  h.transport.setLease('legacy-lease');
  assert.equal(h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyW' } }), null);

  h.transport.setLease({ leaseId: 'lease-for-test-0001', leaseEpoch: 7 });
  h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyW' } });
  assert.equal(h.transport.acceptAck({ epoch: 7, seq: 1, inputIds: ['input-1'] }).status, 'stale');
  assert.equal(h.transport.getSnapshot().lastApplied, 0);
});

test('legacy controller keydown and keyup normalize to valid RemoteInput v2 key envelopes', () => {
  const h = createHarness();
  h.transport.send({
    type: 'keyboard',
    action: 'keydown',
    payload: { code: 'KeyA', modifiers: { ctrl: 1, shift: 0 }, locks: { capsLock: 1 } },
  });
  h.transport.send({ type: 'keyboard', action: 'keyup', payload: { code: 'KeyA' } });

  assert.deepEqual(h.dataChannel.map((payload) => [payload.action, payload.payload.phase]), [
    ['key', 'down'],
    ['key', 'up'],
  ]);
  assert.deepEqual(h.dataChannel[0].payload.modifiers, {
    altKey: false,
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
  });
  assert.deepEqual(h.dataChannel[0].payload.locks, { capsLock: true });
  h.dataChannel.forEach((payload) => assert.equal(validateRemoteInput(payload).ok, true));
  assert.equal(h.transport.getSnapshot().adapter, null);
});

test('text, batch, and reset payloads remain v2 actions and validate unchanged', () => {
  const h = createHarness();
  h.transport.send({ type: 'keyboard', action: 'text', payload: { text: 'hello' } });
  h.transport.send({
    type: 'keyboard',
    action: 'batch',
    payload: {
      steps: [{
        phase: 'down',
        code: 'KeyB',
        location: 0,
        repeat: false,
        modifiers: { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false },
        locks: { capsLock: false },
      }],
    },
  });
  h.transport.resetBarrier('manual');

  assert.deepEqual(h.dataChannel.slice(0, 2).map((payload) => payload.action), ['text', 'batch']);
  assert.deepEqual(h.socket[0].payload, { reason: 'manual' });
  [...h.dataChannel, ...h.socket].forEach((payload) => assert.equal(validateRemoteInput(payload).ok, true));
});

test('no-argument reset barrier uses the valid unspecified reason', () => {
  const h = createHarness();
  h.transport.resetBarrier();

  assert.deepEqual(h.socket[0].payload, { reason: 'unspecified' });
  assert.equal(validateRemoteInput(h.socket[0]).ok, true);
});
