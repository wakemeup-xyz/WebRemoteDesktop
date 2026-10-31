const assert = require('node:assert/strict');
const test = require('node:test');

const KeyboardTransport = require('./keyboard-transport.js');
const { validateRemoteInput } = require('../../signal-server/lib/remote-input-contract.js');

function createHarness(options = {}) {
  let time = 1000;
  let nextId = 0;
  let connectionAttemptId = options.connectionAttemptId || 'attempt-1';
  let timerId = 0;
  const timers = new Map();
  const timeouts = [];
  const dataChannel = [];
  const socket = [];
  const transport = KeyboardTransport.create({
    sendDataChannel(payload) {
      dataChannel.push(payload);
      return typeof options.dataChannelResult === 'function'
        ? options.dataChannelResult(payload)
        : options.dataChannelResult ?? true;
    },
    sendSocket(payload) {
      socket.push(payload);
      return typeof options.socketResult === 'function'
        ? options.socketResult(payload)
        : options.socketResult ?? true;
    },
    now: () => time,
    setTimeoutFn(fn, ms) { const id = ++timerId; timers.set(id, { fn, due: time + ms }); return id; },
    clearTimeoutFn(id) { timers.delete(id); },
    onReliableAckTimeout(record) { timeouts.push(record); },
    makeInputId: () => `input-${++nextId}`,
    getConnectionAttemptId: () => connectionAttemptId,
    getSocket: options.getSocket,
    getDataChannel: options.getDataChannel,
    getResetAckDataChannel: options.getResetAckDataChannel,
    ackTimeoutMs: options.ackTimeoutMs || 3000,
  });
  transport.setLease({ leaseId: 'lease-for-test-0001', leaseEpoch: 7 });
  return {
    transport,
    dataChannel,
    socket,
    timeouts, timers,
    advance(ms) { time += ms; for (const [id, t] of [...timers]) { if (t.due <= time) { timers.delete(id); t.fn(); } } },
    setConnectionAttempt(id) { connectionAttemptId = id; },
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

  h.transport.acceptAck({ schemaVersion: 2, inputIds: h.socket.at(-1).inputIds, leaseEpoch: 7, appliedSeq: 2, status: 'applied' });
  assert.equal(h.transport.canSendNewInput(), true);
  assert.equal(h.transport.acceptAck({ schemaVersion: 2, leaseEpoch: 7, appliedSeq: 1, status: 'duplicate' }).status, 'stale');
  assert.equal(keyId, 'input-1');
});

function resetMirrorHarness() {
  let socket = { id: 'reset-mirror-socket' };
  let currentChannel = { readyState: 'open' };
  let getterFails = false;
  const h = createHarness({ getSocket: () => socket,
    getDataChannel: () => currentChannel,
    getResetAckDataChannel: () => {
      if (getterFails) throw new Error('optional channel observation failed');
      return currentChannel?.readyState === 'open' ? currentChannel : null;
    } });
  return { ...h, socketOwner: socket, channel: currentChannel,
    replaceSocket(value) { socket = value; },
    replaceChannel(value) { currentChannel = value; },
    failGetter() { getterFails = true; } };
}

function resetMirrorAck(payload, overrides = {}) {
  return { type: 'input_ack', schemaVersion: 2, resetAckMirrorVersion: 1,
    inputType: 'keyboard', inputIds: payload.inputIds, leaseEpoch: payload.leaseEpoch,
    appliedSeq: payload.seq, status: 'applied', transport: 'socket', ...overrides };
}

test('reset ACK mirror predicate requires the exact marker, successful type and single matching ID', () => {
  const valid = resetMirrorAck({ inputIds: ['mirror-reset'], leaseEpoch: 7, seq: 1 });
  assert.equal(KeyboardTransport.isResetAckMirror(valid, 'keyboard', 'mirror-reset'), true);
  assert.equal(KeyboardTransport.isResetAckMirror({ ...valid, inputType: 'mouse' }, 'mouse', 'mirror-reset'), true);
  for (const patch of [{ resetAckMirrorVersion: undefined }, { resetAckMirrorVersion: '1' },
    { schemaVersion: 1 }, { status: 'execution-failed' }, { inputType: 'mouse' },
    { inputIds: [] }, { inputIds: ['other'] }, { inputIds: ['mirror-reset', 'other'] }]) {
    assert.equal(KeyboardTransport.isResetAckMirror({ ...valid, ...patch }, 'keyboard', 'mirror-reset'), false);
  }
  assert.equal(KeyboardTransport.isResetAckMirror(valid, 'command', 'mirror-reset'), false);
});

test('Socket keyboard reset accepts one captured current DC mirror without another request or renewed deadline', () => {
  const h = resetMirrorHarness();
  const id = h.transport.resetBarrier('manual');
  const sent = h.socket[0], ack = resetMirrorAck(sent);
  const source = { transport: 'datachannel', dataChannel: h.channel };
  const deadline = [...h.timers.values()][0].due;
  assert.equal(h.transport.ownsAckSource(ack, source), true);
  assert.equal([...h.timers.values()][0].due, deadline);
  assert.equal(h.transport.acceptAck(ack).status, 'applied');
  assert.equal(h.transport.getSnapshot().state, 'ready');
  assert.equal(h.transport.getSnapshot().lastApplied, sent.seq);
  const after = h.transport.getSnapshot();
  assert.equal(h.transport.ownsAckSource(ack, source), false);
  assert.equal(h.transport.ownsAckSource(ack, { transport: 'socket', socket: h.socketOwner }), false);
  assert.deepEqual(h.transport.getSnapshot(), after);
  assert.equal(h.socket.length, 1);
  assert.equal(h.dataChannel.length, 0);
  assert.equal(h.transport.peekAckMetadata({ inputIds: [id] }), null);
});

const keyboardMirrorVetoes = {
  'missing marker': (_h, ack) => { delete ack.resetAckMirrorVersion; },
  'negative status': (_h, ack) => { ack.status = 'execution-failed'; },
  'wrong ID': (_h, ack) => { ack.inputIds = ['not-the-reset']; },
  'multiple IDs': (_h, ack) => { ack.inputIds.push('not-the-reset'); },
  'wrong type': (_h, ack) => { ack.inputType = 'mouse'; },
  'wrong epoch': (_h, ack) => { ack.leaseEpoch += 1; },
  'older seq': (_h, ack) => { ack.appliedSeq -= 1; },
  'future seq': (_h, ack) => { ack.appliedSeq += 1; },
  'old attempt': (h) => h.setConnectionAttempt('replacement-attempt'),
  'same Socket with new id': (h) => { h.socketOwner.id = 'replacement-id'; },
  'replacement Socket': (h) => h.replaceSocket({ id: h.socketOwner.id }),
  'replacement DC': (h) => h.replaceChannel({ readyState: 'open' }),
  'closed DC': (h) => { h.channel.readyState = 'closed'; },
  'throwing current getter': (h) => h.failGetter(),
};
for (const [reason, mutate] of Object.entries(keyboardMirrorVetoes)) {
  test(`Socket keyboard reset mirror rejects ${reason} without consuming or extending pending`, () => {
    const h = resetMirrorHarness();
    h.transport.resetBarrier('manual');
    const ack = resetMirrorAck(h.socket[0]);
    mutate(h, ack);
    const before = h.transport.getSnapshot(), timers = [...h.timers.entries()];
    assert.equal(h.transport.ownsAckSource(ack, { transport: 'datachannel', dataChannel: h.channel }), false);
    assert.deepEqual(h.transport.getSnapshot(), before);
    assert.deepEqual([...h.timers.entries()], timers);
    assert.equal(h.socket.length, 1);
  });
}

test('throwing optional DC getter at reset send preserves the original Socket ACK fallback', () => {
  const h = resetMirrorHarness(); h.failGetter();
  h.transport.resetBarrier('manual');
  const ack = resetMirrorAck(h.socket[0]);
  assert.equal(h.transport.ownsAckSource(ack, { transport: 'datachannel', dataChannel: h.channel }), false);
  assert.equal(h.transport.ownsAckSource(ack, { transport: 'socket', socket: h.socketOwner }), true);
  assert.equal(h.transport.acceptAck(ack).status, 'applied');
  assert.equal(h.socket.length, 1);
});

test('Socket keyboard reset mirror cannot use an unobserved Socket owner at send', () => {
  const h = resetMirrorHarness(); h.replaceSocket(null);
  h.transport.resetBarrier('manual');
  assert.equal(h.transport.ownsAckSource(resetMirrorAck(h.socket[0]),
    { transport: 'datachannel', dataChannel: h.channel }), false);
  assert.equal(h.transport.getSnapshot().pendingCount, 1);
});

test('ordinary Socket keyboard write cannot borrow reset mirror source even with a valid marker', () => {
  const h = resetMirrorHarness(); h.transport.markAdapterUnavailable('dataChannel');
  const reset = h.socket[0]; h.transport.acceptAck(resetMirrorAck(reset));
  h.transport.send({ type: 'keyboard', action: 'text', payload: { text: 'fixture' } });
  const write = h.socket.at(-1), before = h.transport.getSnapshot();
  assert.equal(write.action, 'text');
  assert.equal(h.transport.ownsAckSource(resetMirrorAck(write),
    { transport: 'datachannel', dataChannel: h.channel }), false);
  assert.deepEqual(h.transport.getSnapshot(), before);
});

test('a DataChannel adapter can be re-enabled after an initial unavailable state', () => {
  const h = createHarness();
  h.transport.markAdapterUnavailable('dataChannel');
  h.transport.acceptAck({ schemaVersion: 2, inputIds: h.socket.at(-1).inputIds, leaseEpoch: 7, appliedSeq: 1, status: 'applied' });

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
  assert.equal(h.transport.acceptAck({ schemaVersion: 2, inputIds: [resetId], leaseEpoch: 7, appliedSeq: 1, status: 'applied' }).status, 'applied');
  assert.equal(h.transport.canSendNewInput(), true);

  const secondReset = h.transport.resetBarrier('focus-lost-again');
  assert.equal(h.transport.acceptAck({ schemaVersion: 2, inputIds: [secondReset], leaseEpoch: 7, appliedSeq: 2, status: 'duplicate' }).status, 'duplicate');
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
  assert.equal(h.transport.acceptAck({ schemaVersion: 2, inputIds: h.socket.at(-1).inputIds, leaseEpoch: 7, appliedSeq: 3, status: 'applied' }).status, 'resync-required');
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
    assert.equal(h.transport.getSnapshot().pendingCount, 0);
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

  h.transport.setLease({ leaseId: 'lease-for-test-0001', leaseEpoch: 7 });
  assert.equal(h.transport.getSnapshot().state, 'reacquire-required');
  assert.equal(h.transport.canSendNewInput(), false);
  h.transport.setLease({ leaseId: 'renewed-lease', leaseEpoch: 8 });
  assert.equal(h.transport.canSendNewInput(), true);
  assert.equal(h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyR' } }), 'input-2');
});

test('pending capacity freezes before numbering and does not invent applied progress', () => {
  const h = createHarness();
  for (let index = 0; index < 32; index += 1) {
    assert.equal(h.transport.send({ action: 'keydown', payload: { code: `Key${index}` } }), `input-${index + 1}`);
  }
  assert.equal(h.transport.send({ action: 'keydown', payload: { code: 'Overflow' } }), null);
  assert.equal(h.transport.getSnapshot().pendingCount, 32);
  assert.equal(h.transport.getSnapshot().lastSent, 32);
  assert.equal(h.transport.getSnapshot().lastApplied, 0);
  assert.equal(h.timeouts.length, 1);
  assert.equal(h.dataChannel.length, 32);
});

test('a rejected DataChannel keyup fails closed through one Socket reset barrier', () => {
  for (const rejectRelease of [
    () => false,
    () => { throw new Error('DataChannel rejected release'); },
  ]) {
    const h = createHarness({
      dataChannelResult(payload) {
        return payload.seq === 2 ? rejectRelease() : true;
      },
    });
    assert.equal(h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } }), 'input-1');

    assert.equal(h.transport.send({ type: 'keyboard', action: 'keyup', payload: { code: 'KeyA' } }), null);
    assert.equal(h.dataChannel.length, 2);
    assert.equal(h.socket.length, 1);
    assert.equal(h.socket[0].action, 'reset');
    assert.equal(h.socket[0].seq, 3);
    assert.deepEqual(h.socket[0].payload, { reason: 'transport-change' });
    assert.equal(h.transport.canSendNewInput(), false);
    assert.equal(h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyB' } }), null);

    h.transport.acceptAck({ schemaVersion: 2, inputIds: h.socket.at(-1).inputIds, leaseEpoch: 7, appliedSeq: 3, status: 'applied' });
    assert.equal(h.transport.canSendNewInput(), true);
  }
});

test('a rejected Socket reset requires lease reacquisition', () => {
  const h = createHarness({
    dataChannelResult(payload) { return payload.seq === 1; },
    socketResult: false,
  });
  h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } });

  assert.equal(h.transport.send({ type: 'keyboard', action: 'keyup', payload: { code: 'KeyA' } }), null);
  assert.equal(h.socket.length, 1);
  assert.equal(h.socket[0].action, 'reset');
  assert.equal(h.transport.getSnapshot().state, 'reacquire-required');
  assert.equal(h.transport.canSendNewInput(), false);
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
    connectionAttemptId: 'attempt-1',
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

test('pending reset returns memory-only scope while public snapshot omits socket identity', () => {
  const h = createHarness();
  const resetId = h.transport.resetBarrier('attempt-boundary');
  assert.deepEqual(h.transport.getPendingReset(), {
    inputId: resetId,
    seq: 1,
    leaseEpoch: 7,
    connectionAttemptId: 'attempt-1',
    socket: null, socketId: null,
  });
  assert.equal(h.transport.getPendingReset().connectionAttemptId, 'attempt-1');
});

test('a reset barrier from an old attempt is replaced instead of being relabeled', () => {
  const h = createHarness();
  const oldId = h.transport.resetBarrier('old-attempt');
  h.setConnectionAttempt('attempt-2');

  const newId = h.transport.resetBarrier('new-attempt');
  assert.notEqual(newId, oldId);
  assert.equal(h.socket.length, 2);
  assert.equal(h.socket[0].seq, 1);
  assert.equal(h.socket[1].seq, 2);
  assert.equal(h.transport.getPendingReset().connectionAttemptId, 'attempt-2');
  assert.equal(h.transport.acceptAck({
    schemaVersion: 2,
    inputType: 'keyboard',
    inputIds: [oldId],
    leaseEpoch: 7,
    appliedSeq: 1,
    status: 'applied',
  }).status, 'stale');
  assert.equal(h.transport.getPendingReset().inputId, newId);
  assert.equal(h.transport.acceptAck({
    schemaVersion: 2,
    inputType: 'keyboard',
    inputIds: [newId],
    leaseEpoch: 7,
    appliedSeq: 2,
    status: 'applied',
  }).status, 'applied');
  assert.equal(h.transport.canSendNewInput(), true);
});


test('ordinary pending keyboard owns a real earliest deadline without polling snapshots', () => {
  const h = createHarness();
  h.transport.send({ action: 'keydown', payload: { code: 'KeyA' } });
  h.advance(1000);
  h.transport.send({ action: 'keyup', payload: { code: 'KeyA' } });
  assert.equal(h.timers.size, 1);
  h.transport.acceptAck({ schemaVersion: 2, leaseEpoch: 7, appliedSeq: 1, status: 'applied' });
  h.advance(2001);
  assert.equal(h.timeouts.length, 0);
  h.advance(1000);
  assert.equal(h.timeouts.length, 1);
  assert.equal(h.timeouts[0].seq, 2);
  assert.equal(h.transport.canSendNewInput(), false);
  h.advance(10000);
  assert.equal(h.timeouts.length, 1);
});

test('changing lease cancels ordinary pending deadline', () => {
  const h = createHarness();
  h.transport.send({ action: 'keydown', payload: { code: 'KeyA' } });
  h.transport.setLease({ leaseId: 'new-lease', leaseEpoch: 8 });
  h.advance(4000);
  assert.equal(h.timeouts.length, 0);
  assert.equal(h.timers.size, 0);
});


test('attempt invalidation cancels timer without resetting sequence or claiming progress', () => {
  const h = createHarness();
  h.transport.send({ action: 'keydown', payload: { code: 'KeyA' } });
  h.setConnectionAttempt('attempt-2');
  h.transport.connectionScopeChanged();
  assert.equal(h.timers.size, 0);
  h.advance(5000);
  assert.equal(h.timeouts.length, 0);
  assert.equal(h.transport.getSnapshot().lastSent, 1);
  assert.equal(h.transport.getSnapshot().lastApplied, 0);
  assert.equal(h.transport.canSendNewInput(), false);
});


test('peekAckMetadata is payload free, detached and does not expire or mutate pending resets', () => {
  let now = 1000;
  const sent = [];
  const transport = KeyboardTransport.create({ now: () => now, makeInputId: () => 'peek-id',
    getConnectionAttemptId: () => 'peek-attempt', setTimeoutFn: () => 1, clearTimeoutFn() {},
    sendSocket(payload) { sent.push(payload); return true; } });
  transport.setLease({ leaseId: 'lease-for-test-0001', leaseEpoch: 7 });
  const id = transport.resetBarrier('focus-lost');
  const before = transport.getSnapshot();
  now = 30000;
  const meta = transport.peekAckMetadata({ inputIds: [id] });
  assert.deepEqual(meta, { action: 'reset', reliable: true, matchedReliablePending: true,
    connectionAttemptId: 'peek-attempt' });
  meta.action = 'modified';
  assert.equal(transport.peekAckMetadata({ inputIds: [id] }).action, 'reset');
  // getSnapshot itself expires barriers, so restore the clock before asking it.
  now = 1000;
  assert.deepEqual(transport.getSnapshot(), before);
  assert.equal(sent.length, 1);
  assert.equal(transport.peekAckMetadata({ inputIds: ['unknown'] }), null);
});
