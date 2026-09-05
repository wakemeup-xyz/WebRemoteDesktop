import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertNoActiveViewer, buildFailedProofResult, parseProofArgs, proofSnapshotPasses,
  redactSelectedPair, selectedPairIsRelay, writeResultAtomically,
} from './prove-turn-relay.mjs';

test('proof parameters accept bounded duration and an output path', () => {
  assert.deepEqual(parseProofArgs(['--duration-seconds', '12', '--output', '/tmp/proof.json']), {
    durationSeconds: 12,
    output: '/tmp/proof.json',
    help: false,
  });
  assert.throws(() => parseProofArgs(['--duration-seconds', '0']), /duration-seconds/);
});

test('pre-browser argument failures atomically write an incomplete result and exit non-zero', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-proof-cli-'));
  const output = path.join(directory, 'proof.json');
  const child = spawnSync(process.execPath, ['scripts/prove-turn-relay.mjs', '--output', output, '--duration-seconds', '0'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  });
  assert.notEqual(child.status, 0);
  const result = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(result.ok, false);
  assert.equal(result.proofComplete, false);
  fs.rmSync(directory, { recursive: true, force: true });
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

test('proof rejects stale DOM, disconnected PC, and relay mode without selected relay', () => {
  const base = { fps: 20, socketConnected: true, pcConnectionState: 'connected', selectedPair: { type: 'relay' }, dom: { connectionStatus: '已连接' } };
  assert.equal(proofSnapshotPasses(base), true);
  assert.equal(proofSnapshotPasses({ ...base, dom: { connectionStatus: '正在出画' } }), false);
  assert.equal(proofSnapshotPasses({ ...base, pcConnectionState: 'disconnected' }), false);
  assert.equal(proofSnapshotPasses({ ...base, selectedPair: { type: 'host' }, networkMode: 'relay' }), false);
});

test('proof failure result is incomplete and atomic output never leaves a partial success', () => {
  const result = buildFailedProofResult({ baseUrl: 'http://127.0.0.1:8080' }, new Error('playwright unavailable'));
  assert.equal(result.ok, false);
  assert.equal(result.proofComplete, false);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-proof-'));
  const output = path.join(directory, 'proof.json');
  writeResultAtomically(result, output);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), result);
  assert.throws(() => writeResultAtomically({ ok: true }, output, {
    ...fs,
    writeFileSync() { throw new Error('write failed'); },
  }), /write failed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), result);
  assert.throws(() => writeResultAtomically({ ok: true }, output, {
    ...fs,
    renameSync() { throw new Error('rename failed'); },
  }), /rename failed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), result);
  fs.rmSync(directory, { recursive: true, force: true });
});
