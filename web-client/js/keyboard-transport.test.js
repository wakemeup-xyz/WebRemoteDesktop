const assert = require('node:assert/strict');
const test = require('node:test');

const KeyboardTransport = require('./keyboard-transport.js');

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
  transport.setLease('lease-for-test');
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
  assert.equal(h.transport.canSendNewInput(), false);

  h.transport.acceptAck({ inputIds: [h.socket[0].inputIds[0]], epoch: 1, seq: 2 });
  assert.equal(h.transport.canSendNewInput(), true);
  assert.equal(h.transport.acceptAck({ inputIds: [keyId], epoch: 1, seq: 1 }).status, 'stale');
});

test('reset barrier blocks new input until its applied or duplicate acknowledgement', () => {
  const h = createHarness();
  const resetId = h.transport.resetBarrier('focus-lost');
  assert.equal(h.socket.length, 1);
  assert.equal(h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyB' } }), null);
  assert.equal(h.transport.acceptAck({ inputIds: [resetId], epoch: 1, seq: 1 }).status, 'applied');
  assert.equal(h.transport.canSendNewInput(), true);

  const secondReset = h.transport.resetBarrier('focus-lost-again');
  assert.equal(h.transport.acceptAck({ inputIds: ['already-applied'], epoch: 1, seq: 2 }).status, 'duplicate');
  assert.equal(h.transport.canSendNewInput(), true);
  assert.equal(secondReset, h.socket[1].inputIds[0]);
});

test('keyboard transport pins its adapter until every physical key is released', () => {
  const h = createHarness();
  h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } });
  h.transport.markAdapterUnavailable('socket');
  h.transport.send({ type: 'keyboard', action: 'keyup', payload: { code: 'KeyA' } });

  assert.equal(h.dataChannel.length, 2);
  assert.equal(h.dataChannel[1].action, 'keyup');
  assert.equal(h.transport.getSnapshot().adapter, null);
});

test('normal acknowledgement ledger advances in order and duplicate acknowledgements are harmless', () => {
  const h = createHarness();
  const one = h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } });
  const two = h.transport.send({ type: 'keyboard', action: 'keyup', payload: { code: 'KeyA' } });

  assert.equal(h.transport.acceptAck({ inputIds: [two], epoch: 1, seq: 2 }).status, 'pending-gap');
  assert.equal(h.transport.getSnapshot().lastApplied, 0);
  assert.equal(h.transport.acceptAck({ inputIds: [one], epoch: 1, seq: 1 }).status, 'applied');
  assert.equal(h.transport.getSnapshot().lastApplied, 2);
  assert.equal(h.transport.acceptAck({ inputIds: [one], epoch: 1, seq: 1 }).status, 'duplicate');
});

test('sequence gaps install a Socket resync barrier and prevent subsequent keyboard input', () => {
  const h = createHarness();
  h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyA' } });
  const result = h.transport.acceptAck({ inputIds: ['unknown'], epoch: 1, seq: 3 });

  assert.equal(result.status, 'gap');
  assert.equal(h.socket.length, 1);
  assert.equal(h.socket[0].action, 'reset');
  assert.equal(h.socket[0].seq, 2);
  assert.equal(h.transport.canSendNewInput(), false);
});

test('expired reset barrier permits a fresh input attempt', () => {
  const h = createHarness({ ackTimeoutMs: 50 });
  h.transport.resetBarrier('test-timeout');
  assert.equal(h.transport.canSendNewInput(), false);
  h.advance(51);
  assert.equal(h.transport.canSendNewInput(), true);
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

test('all outgoing inputs carry the v2 lease, epoch, sequence, and input ID schema', () => {
  const h = createHarness();
  h.transport.send({ type: 'keyboard', action: 'keydown', payload: { code: 'KeyQ' } });
  assert.deepEqual(h.dataChannel[0], {
    type: 'keyboard',
    action: 'keydown',
    payload: { code: 'KeyQ' },
    schemaVersion: 2,
    lease: 'lease-for-test',
    epoch: 1,
    seq: 1,
    inputIds: ['input-1'],
  });
});
