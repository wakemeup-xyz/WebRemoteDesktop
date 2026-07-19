const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { StunPortSearchController } = require('./stun-port-search-controller.js');

test('exposes the controller object directly on the browser global', () => {
  const browserGlobal = {};
  const source = fs.readFileSync(path.join(__dirname, 'stun-port-search-controller.js'), 'utf8');

  vm.runInNewContext(source, { window: browserGlobal, globalThis: browserGlobal });

  assert.equal(typeof browserGlobal.StunPortSearchController.create, 'function');
});

test('starts at zero and caps attempts at 500', () => {
  const search = StunPortSearchController.create({ limit: 500 });
  assert.equal(search.start().status, 'searching');
  assert.equal(search.beginAttempt('manual').attempt, 1);
  for (let index = 1; index < 500; index += 1) search.beginAttempt('retry');
  assert.equal(search.snapshot().attempt, 500);
  assert.equal(search.beginAttempt('overflow').accepted, false);
  assert.equal(search.snapshot().status, 'exhausted');
});

test('deduplicates valid viewer and host ports while retaining side-specific current ports', () => {
  const search = StunPortSearchController.create();
  search.start();
  search.beginAttempt('manual');
  assert.equal(search.recordPort('viewer', 53114), true);
  assert.equal(search.recordPort('viewer', 53114), false);
  assert.equal(search.recordPort('host', 49702), true);
  assert.equal(search.recordPort('viewer', 0), false);
  assert.equal(search.recordPort('host', 70000), false);
  assert.deepEqual(search.snapshot().current.viewerPorts, [53114]);
  assert.deepEqual(search.snapshot().current.hostPorts, [49702]);
  assert.equal(search.snapshot().uniquePortCount, 2);
});

test('requires three consecutive selected-pair video samples and resets on a gap', () => {
  const search = StunPortSearchController.create();
  search.start();
  search.beginAttempt('manual');
  const good = { selectedCandidateType: 'srflx', framesDecoded: 12, fps: 12 };
  assert.equal(search.observeMedia(good).status, 'searching');
  assert.equal(search.observeMedia({ ...good, framesDecoded: 0, fps: 0 }).stableMediaSamples, 0);
  assert.equal(search.observeMedia(good).stableMediaSamples, 1);
  assert.equal(search.observeMedia(good).stableMediaSamples, 2);
  assert.equal(search.observeMedia(good).status, 'succeeded');
});

test('stop prevents later failures or samples from advancing the search', () => {
  const search = StunPortSearchController.create();
  search.start();
  search.beginAttempt('manual');
  search.stop('user');
  assert.equal(search.failAttempt('ice-failed').accepted, false);
  assert.equal(search.observeMedia({ selectedCandidateType: 'srflx', framesDecoded: 30, fps: 30 }).status, 'stopped');
});
