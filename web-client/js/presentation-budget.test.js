const assert = require('node:assert/strict');
const test = require('node:test');
const {
  nearestPresentationRung,
  pathCapForMode,
  computeSessionPresentation,
} = require('./presentation-budget.js');

test('pathCap relay is 720p even if last candidate is empty', () => {
  assert.deepEqual(pathCapForMode('relay'), { width: 1280, height: 720, label: '1280x720' });
});

test('pathCap stun/auto/lan is 1080p', () => {
  assert.equal(pathCapForMode('stun').height, 1080);
  assert.equal(pathCapForMode('auto').width, 1920);
  assert.equal(pathCapForMode('lan').width, 1920);
});

test('pathCap treats lastCandidateType=relay as relay cap', () => {
  assert.equal(pathCapForMode('auto', 'relay').height, 720);
});

test('session presentation caps 1080p pref on relay', () => {
  const out = computeSessionPresentation({
    userPreference: { width: 1920, height: 1080 },
    networkMode: 'relay',
  });
  assert.equal(out.width, 1280);
  assert.equal(out.height, 720);
  assert.equal(out.capped, true);
  assert.equal(out.explicitOverride1080, false);
});

test('explicit 1080p override on relay keeps 1080p', () => {
  const out = computeSessionPresentation({
    userPreference: { width: 1920, height: 1080 },
    networkMode: 'relay',
    explicitOverride1080: true,
  });
  assert.equal(out.width, 1920);
  assert.equal(out.height, 1080);
  assert.equal(out.capped, false);
  assert.equal(out.explicitOverride1080, true);
});

test('user 540p on relay is not raised', () => {
  const out = computeSessionPresentation({
    userPreference: { width: 960, height: 540 },
    networkMode: 'relay',
  });
  assert.equal(out.width, 960);
  assert.equal(out.height, 540);
  assert.equal(out.capped, false);
});

test('nearest rung snaps 1728x1080 to 1080p', () => {
  const rung = nearestPresentationRung(1728, 1080);
  assert.equal(rung.width, 1920);
  assert.equal(rung.height, 1080);
});
