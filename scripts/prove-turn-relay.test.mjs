import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { assertNoActiveViewer, parseProofArgs, redactSelectedPair, selectedPairIsRelay } from './prove-turn-relay.mjs';

test('proof parameters accept bounded duration and an output path', () => {
  assert.deepEqual(parseProofArgs(['--duration-seconds', '12', '--output', '/tmp/proof.json']), {
    durationSeconds: 12,
    output: '/tmp/proof.json',
    help: false,
  });
  assert.throws(() => parseProofArgs(['--duration-seconds', '0']), /duration-seconds/);
});

test('proof requires a selected local relay candidate and redacts candidate endpoints', () => {
  assert.equal(selectedPairIsRelay({ localType: 'relay', protocol: 'udp', rttMs: 42 }), true);
  assert.equal(selectedPairIsRelay({ localType: 'host', protocol: 'udp', rttMs: 42 }), false);
  assert.throws(() => assertNoActiveViewer({ viewerCount: 1 }), /refusing headless proof/);
  assert.deepEqual(redactSelectedPair({
    localType: 'relay', protocol: 'udp', rttMs: 42,
    localAddress: '10.0.0.1', localPort: 50000, remoteAddress: '203.0.113.10', remotePort: 3478,
  }), { type: 'relay', protocol: 'udp', rttMs: 42 });
});

test('proof help exits without requiring credentials or making a network request', () => {
  const output = execFileSync(process.execPath, ['scripts/prove-turn-relay.mjs', '--help'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  });
  assert.match(output, /--duration-seconds/);
  assert.match(output, /--output/);
});
