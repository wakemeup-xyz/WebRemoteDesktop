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
  const relayListeners = new Map();
  const relayImage = { addEventListener: (name, listener) => relayListeners.set(name, listener),
    removeEventListener: (name, listener) => { if (relayListeners.get(name) === listener) relayListeners.delete(name); } };
  const pc = { connectionState: 'connected', getStats };
  const context = { performance: { now: () => 500 }, setTimeout, clearTimeout, Promise,
    document: { getElementById: id => id === 'remoteVideo' ? video : id === 'relayImage' ? relayImage : null },
    WebRTC: { pc, socket: { connected: true }, latencyScope: () => ({ connectionAttemptId:'private-attempt', generation:1, leaseEpoch:2 }), getMediaAppliedPhase: () => 'active' },
    Input: { getEffectiveInputGate: () => ({ allowed:true }) },
    window: { __WRD_BUILD__: { id:'release-a', builtAt:1 } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'passive_session_sampler.js'), 'utf8'), context);
  return { context, sampler:context.window.__wrdPassiveSampler, callbacks, relayListeners };
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

function selectedStats(pairId = 'private-pair', localId = 'private-local', remoteId = 'private-remote') {
  return new Map([
    ['t', { type:'transport', selectedCandidatePairId:pairId }],
    [pairId, { localCandidateId:localId, remoteCandidateId:remoteId }],
    [localId, { candidateType:'relay', protocol:'udp', relayProtocol:'udp', address:'10.0.0.1', url:'turn:private.invalid' }],
    [remoteId, { candidateType:'host', protocol:'udp', address:'10.0.0.2' }],
  ]);
}

test('selected pair and candidate churn changes opaque run-local path identity', async () => {
  let stats = selectedStats();
  const { sampler } = fixture(async () => stats);
  const first = await sampler.sample();
  assert.match(first.transport.pathIdentity, /^path-\d+$/);
  assert.equal((await sampler.sample()).transport.pathIdentity, first.transport.pathIdentity);
  stats = selectedStats('different-private-pair');
  const second = await sampler.sample();
  assert.notEqual(second.transport.pathIdentity, first.transport.pathIdentity);
  stats = selectedStats('different-private-pair', 'different-private-local');
  const third = await sampler.sample();
  assert.notEqual(third.transport.pathIdentity, second.transport.pathIdentity);
  assert.doesNotMatch(JSON.stringify(third), /private-pair|private-local|private-remote|10\.0\.0\.|turn:/);
  sampler.stop();
});

test('missing selected candidate identity remains unavailable', async () => {
  const stats = selectedStats();
  stats.get('private-pair').remoteCandidateId = null;
  const { sampler } = fixture(async () => stats);
  assert.equal((await sampler.sample()).transport.pathIdentity, null);
  sampler.stop();
});

for (const field of ['connectionAttemptId', 'generation', 'leaseEpoch']) {
  test(`${field} changed across stats await invalidates captured scope`, async () => {
    let finish;
    const { sampler, context } = fixture(() => new Promise(resolve => { finish = resolve; }));
    const scope = { connectionAttemptId:'private-attempt', generation:1, leaseEpoch:2 };
    context.WebRTC.latencyScope = () => scope;
    const pending = sampler.sample();
    await Promise.resolve();
    scope[field] = field === 'connectionAttemptId' ? 'other-attempt' : 3;
    finish(selectedStats());
    const sample = await pending;
    assert.equal(sample.scopeStable, false);
    assert.equal(sample.transport.status, 'scope-changed');
    sampler.stop();
  });
}


test('actual rVFC times retain a long gap even when frame age is fresh', async () => {
  const { sampler, context, callbacks } = fixture(async () => selectedStats());
  let now = 100;
  context.performance.now = () => now;
  await sampler.sample();
  const fire = at => {
    now = at;
    const [id, cb] = callbacks.entries().next().value;
    callbacks.delete(id); cb(at);
  };
  fire(100); fire(5900);
  now = 5910;
  const sample = await sampler.sample();
  assert.equal(sample.callbacks, 2);
  assert.equal(sample.lastFrameAtMs, 5900);
  assert.equal(sample.frameAgeMs, 10);
  assert.equal(sample.maxFrameGapMs, 5800);
  sampler.stop();
});

test('relay load timestamps measure load events and retain gaps without claiming optical presentation', async () => {
  const { sampler, context, relayListeners } = fixture(async () => selectedStats());
  let now = 100;
  context.performance.now = () => now;
  assert.equal((await sampler.sample()).relayLoadAgeMs, null);
  relayListeners.get('load')();
  now = 5900; relayListeners.get('load')();
  now = 5910;
  const sample = await sampler.sample();
  assert.equal(sample.relayLoadCallbacks, 2);
  assert.equal(sample.lastRelayLoadAtMs, 5900);
  assert.equal(sample.relayLoadAgeMs, 10);
  assert.equal(sample.maxRelayLoadGapMs, 5800);
  assert.equal(sample.relayEvidenceKind, 'image-load-event-not-optical-presentation');
  sampler.stop();
  assert.equal(relayListeners.size, 0);
});
