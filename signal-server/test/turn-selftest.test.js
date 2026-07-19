const assert = require('node:assert/strict');
const test = require('node:test');

const { createTurnSelfTestRunner } = require('../lib/turn-selftest');

test('runFromConfig reports missing when TURN incomplete', async () => {
  const runner = createTurnSelfTestRunner({
    loadNodeDataChannel: () => null,
  });
  const result = await runner.runFromConfig({
    turnUrls: [],
    turnUsername: '',
    turnCredential: '',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'turn-config-missing');
  assert.ok(!('credential' in result));
});

test('runAllocate returns missing-runtime without PeerConnection', async () => {
  const runner = createTurnSelfTestRunner({
    loadNodeDataChannel: () => null,
  });
  const result = await runner.runAllocate({
    urls: ['turn:relay.example.com:3478?transport=udp'],
    username: 'u',
    credential: 'p',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'node-datachannel-missing');
});

test('runAllocate counts relay candidates with fake PC', async () => {
  class FakePC {
    constructor() {
      this.handlers = {};
    }
    onLocalCandidate(fn) { this.handlers.candidate = fn; }
    onGatheringStateChange(fn) { this.handlers.gathering = fn; }
    onStateChange(fn) { this.handlers.state = fn; }
    createDataChannel() {
      queueMicrotask(() => {
        this.handlers.candidate?.('candidate:1 1 UDP 1 1.1.1.1 9 typ relay raddr 0.0.0.0 rport 0');
        this.handlers.gathering?.('complete');
      });
      return {};
    }
    close() {}
  }

  const runner = createTurnSelfTestRunner({
    loadNodeDataChannel: () => ({ PeerConnection: FakePC }),
  });
  const result = await runner.runFromConfig({
    turnUrls: ['turn:relay.example.com:3478?transport=udp'],
    turnUsername: 'u',
    turnCredential: 'p',
    turnSource: 'env',
    turnFingerprint: 'abc',
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'turn-allocate-ok');
  assert.equal(result.relayCandidateCount, 1);
  assert.equal(result.turnFingerprint, 'abc');
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'credential'));
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'password'));
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'turnCredential'));
});
