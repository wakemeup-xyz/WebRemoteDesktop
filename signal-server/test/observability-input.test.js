const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  hashInputIds,
  summarizeHighFrequencyInput,
  summarizeInputEvent,
} = require('../lib/observability/input');


test('high-frequency input summary never hashes or copies input correlation fields', () => {
  const originalCreateHash = crypto.createHash;
  let hashCalls = 0;
  crypto.createHash = () => {
    hashCalls += 1;
    throw new Error('HASH_CANARY');
  };

  try {
    const summary = summarizeHighFrequencyInput({
      type: 'mouse',
      action: 'move',
      transport: 'socket',
      inputIds: ['mouse-fixture'],
      seq: 17,
      payload: { relX: 0.5, relY: 0.5, text: 'PAYLOAD_CANARY' },
    }, { status: 'accepted' });

    assert.deepEqual(summary, {
      inputType: 'mouse',
      action: 'move',
      transport: 'socket',
      status: 'accepted',
    });
    assert.equal(hashCalls, 0);
  } finally {
    crypto.createHash = originalCreateHash;
  }
});


test('reliable input summary keeps the bounded correlation hash', () => {
  assert.equal(hashInputIds(['kbd_fixture_1']), '3e9fd6a21afbb55b');
  const summary = summarizeInputEvent({
    type: 'keyboard',
    action: 'key',
    transport: 'socket',
    inputIds: ['kbd_fixture_1'],
    seq: 1,
    leaseEpoch: 2,
    payload: {},
  }, { status: 'applied' });
  assert.equal(summary.inputIdHash, '3e9fd6a21afbb55b');
  assert.equal(summary.seq, 1);
  assert.equal(summary.leaseEpoch, 2);
});
