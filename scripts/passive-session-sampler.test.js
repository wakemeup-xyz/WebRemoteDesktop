const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(getStats) {
  const callbacks = new Map();
  let seq = 0;
  const video = { videoWidth: 1280, videoHeight: 720,
    requestVideoFrameCallback: cb => { callbacks.set(++seq, cb); return seq; },
    cancelVideoFrameCallback: id => callbacks.delete(id) };
  const pc = { connectionState: 'connected', getStats };
  const context = { performance: { now: () => 500 }, setTimeout, clearTimeout, Promise,
    document: { getElementById: () => video },
    WebRTC: { pc, socket: { connected: true }, latencyScope: () => ({ connectionAttemptId:'private-attempt', generation:1, leaseEpoch:2 }), getMediaAppliedPhase: () => 'active' },
    Input: { getEffectiveInputGate: () => ({ allowed:true }) },
    window: { __WRD_BUILD__: { id:'release-a', builtAt:1 } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'passive_session_sampler.js'), 'utf8'), context);
  return { context, sampler:context.window.__wrdPassiveSampler, callbacks };
}

test('reads actual build and selected candidate without addresses or payload', async () => {
  const stats = new Map([
    ['t', { type:'transport', selectedCandidatePairId:'pair' }],
    ['pair', { localCandidateId:'local', remoteCandidateId:'remote', currentRoundTripTime:.02 }],
    ['local', { candidateType:'relay', protocol:'udp', address:'private-address' }],
    ['remote', { candidateType:'host', address:'other-private-address' }],
    ['in', { type:'inbound-rtp', kind:'video', framesDecoded:100, bytesReceived:1234, codecId:'codec' }],
    ['codec', { mimeType:'video/H264' }],
  ]);
  const { sampler, callbacks } = fixture(async () => stats);
  const sample = await sampler.sample();
  assert.equal(sample.buildId, 'release-a');
  assert.equal(sample.transport.localType, 'relay');
  assert.equal(sample.transport.rttMs, 20);
  assert.equal(sample.transport.codec, 'video/h264');
  assert.doesNotMatch(JSON.stringify(sample), /private-address/);
  assert.equal(callbacks.size, 1);
  sampler.stop();
  assert.equal(callbacks.size, 0);
});

test('an overlapping sample does not launch another hung getStats', async () => {
  let calls = 0, finish;
  const { sampler } = fixture(() => { calls += 1; return new Promise(resolve => { finish = resolve; }); });
  const first = sampler.sample();
  await Promise.resolve();
  const second = await sampler.sample();
  assert.equal(calls, 1);
  assert.equal(second.transport.status, 'pending');
  finish(new Map());
  await first;
  sampler.stop();
});

test('PC changed across stats await cannot publish old transport evidence', async () => {
  let finish;
  const { sampler, context } = fixture(() => new Promise(resolve => { finish = resolve; }));
  const pending = sampler.sample();
  await Promise.resolve();
  context.WebRTC.pc = {};
  finish(new Map());
  assert.equal((await pending).transport.status, 'scope-changed');
  sampler.stop();
});
