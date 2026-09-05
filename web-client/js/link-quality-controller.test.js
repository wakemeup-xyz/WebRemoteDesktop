/**
 * LinkQualityController unit tests — Quality Lock / continuity semantics.
 *
 * WebRTC.ensureLinkQualityController passes qualityLock: !adaptiveResolutionEnabled.
 * Default create() uses qualityLock:true. Legacy size-ladder tests in webrtc.test.js
 * pass qualityLock:false explicitly.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { LinkQualityController } = require('./link-quality-controller.js');

test('create defaults qualityLock to true', () => {
  const c = LinkQualityController.create();
  assert.equal(c.qualityLock, true);
  assert.equal(c.snapshot().qualityLock, true);
});

test('lock mode: high jitter with fps>0 does not degrade profile', () => {
  const c = LinkQualityController.create({ path: 'relay', initialProfile: 'high' });
  assert.equal(c.qualityLock, true);
  c.currentProfile = 'high';

  const sample = {
    fps: 15,
    rttMs: 110,
    jitterBufferMs: 2000,
    packetsLost: 0,
    framesDecoded: 15,
    selectedCandidateType: 'relay',
    interval: true,
  };

  let result = c.observe(sample);
  assert.equal(result.action, 'hold');
  assert.equal(result.profile, 'high');
  assert.equal(result.profileConfig, null);
  assert.equal(result.changed || false, false);
  assert.equal(c.currentProfile, 'high');

  result = c.observe({ ...sample, framesDecoded: 30, jitterBufferMs: 1800 });
  assert.equal(result.action, 'hold');
  assert.equal(result.profile, 'high');
  assert.equal(result.profileConfig, null);
  assert.equal(result.reason, 'jitter');
  assert.equal(c.currentProfile, 'high');
  assert.equal(c.degradedCount, 0);
});

test('canonical decoded delta remains progress when the next interval is smaller', () => {
  const c = LinkQualityController.create({ path: 'relay', qualityLock: true });
  c.beginConnection(0);
  const first = c.observe({
    derivedFps: 10,
    decodedDelta: 10,
    receivedDelta: 10,
    packetsLostDelta: 0,
    rttMs: 20,
    jitterBufferMs: 0,
    selectedCandidateType: 'relay',
  });
  const second = c.observe({
    derivedFps: 1,
    decodedDelta: 1,
    receivedDelta: 1,
    packetsLostDelta: 0,
    rttMs: 20,
    jitterBufferMs: 0,
    selectedCandidateType: 'relay',
  });

  assert.equal(first.reason, 'good');
  assert.equal(first.decodedDelta, 10);
  assert.equal(second.reason, 'good');
  assert.equal(second.decodedDelta, 1);
});

test('canonical RTP progress without decoded output requests decoder-stalled recovery', () => {
  const c = LinkQualityController.create({ path: 'relay', qualityLock: true });
  c.beginConnection(0);

  const result = c.observe({
    derivedFps: 0,
    decodedDelta: 0,
    receivedDelta: 19,
    packetsLostDelta: 0,
    rttMs: 40,
    jitterBufferMs: 0,
    selectedCandidateType: 'relay',
  });

  assert.equal(result.action, 'recover');
  assert.equal(result.reason, 'decoder-stalled');
  assert.equal(result.shouldRequestKeyframe, true);
});

test('lock mode: brief zero fps requests recovery not survival size', () => {
  const c = LinkQualityController.create({
    path: 'relay',
    initialProfile: 'high',
    qualityLock: true,
  });
  c.beginConnection(0);

  const stall = {
    fps: 0,
    rttMs: 110,
    jitterBufferMs: 800,
    packetsLost: 0,
    framesDecoded: 100,
    selectedCandidateType: 'relay',
    interval: true,
  };

  // Relay needs 6 sustained stall samples for critical; brief samples must recover.
  for (let i = 0; i < 3; i += 1) {
    const result = c.observe(stall);
    assert.equal(result.action, 'recover');
    assert.equal(result.shouldRequestKeyframe, true);
    assert.equal(result.profile, 'high');
    assert.equal(result.profileConfig, null);
    assert.equal(result.changed || false, false);
    assert.notEqual(result.action, 'degrade');
    assert.equal(c.currentProfile, 'high');
  }
  assert.equal(c.snapshot().currentProfile, 'high');
});

test('lock mode: sustained stall is critical recover without survival profileConfig', () => {
  const c = LinkQualityController.create({
    path: 'relay',
    initialProfile: 'high',
    qualityLock: true,
  });
  c.beginConnection(0);

  const stall = {
    fps: 0,
    rttMs: 400,
    jitterBufferMs: 50,
    packetsLost: 0,
    framesDecoded: 0,
    selectedCandidateType: 'relay',
    interval: true,
  };

  let result;
  for (let i = 0; i < 6; i += 1) {
    result = c.observe(stall);
  }
  assert.equal(result.action, 'critical');
  assert.equal(result.shouldRequestKeyframe, true);
  assert.equal(result.profile, 'high');
  assert.equal(result.profileConfig, null);
  assert.equal(result.changed || false, false);
  assert.equal(c.currentProfile, 'high');
});

test('relay structural rtt 120ms alone does not degrade', () => {
  // Lower highRttMs so 120ms would be "high" under unlock semantics; lock must still hold.
  const c = LinkQualityController.create({
    path: 'relay',
    initialProfile: 'high',
    highRttMs: 80,
    veryHighRttMs: 1200,
    qualityLock: true,
  });

  const sample = {
    fps: 20,
    rttMs: 120,
    jitterBufferMs: 20,
    packetsLost: 0,
    framesDecoded: 20,
    selectedCandidateType: 'relay',
    interval: true,
  };

  let result = c.observe(sample);
  assert.equal(result.action, 'hold');
  assert.equal(result.profile, 'high');
  assert.equal(c.currentProfile, 'high');

  result = c.observe({ ...sample, framesDecoded: 40, rttMs: 125 });
  assert.equal(result.action, 'hold');
  assert.equal(result.profile, 'high');
  assert.equal(result.profileConfig, null);
  assert.equal(c.degradedCount, 0);
  assert.equal(c.currentProfile, 'high');
});

test('lock mode: packet loss can still degrade profile name for rate signaling', () => {
  const c = LinkQualityController.create({
    path: 'relay',
    initialProfile: 'medium',
    qualityLock: true,
  });
  const lossy = {
    fps: 10,
    rttMs: 100,
    jitterBufferMs: 30,
    packetsLost: 40,
    framesDecoded: 10,
    selectedCandidateType: 'relay',
    interval: true,
  };

  assert.equal(c.observe(lossy).action, 'hold');
  const degraded = c.observe(lossy);
  assert.equal(degraded.action, 'degrade');
  assert.equal(degraded.profile, 'low');
  assert.ok(degraded.profileConfig);
  assert.equal(c.currentProfile, 'low');
});

test('unlock mode: repeated zero fps still enters survival critical', () => {
  const c = LinkQualityController.create({ qualityLock: false });
  c.beginConnection(0);

  c.observe({
    fps: 0,
    rttMs: 90,
    jitterBufferMs: 250,
    packetsLost: 10,
    framesDecoded: 199,
    selectedCandidateType: 'prflx',
  });
  const result = c.observe({
    fps: 0,
    rttMs: 95,
    jitterBufferMs: 270,
    packetsLost: 10,
    framesDecoded: 199,
    selectedCandidateType: 'prflx',
  });

  assert.equal(result.action, 'critical');
  assert.equal(result.profile, 'survival');
  assert.equal(result.shouldRestartIce, true);
  assert.ok(result.profileConfig);
});
