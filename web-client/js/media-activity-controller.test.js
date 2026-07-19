const assert = require('node:assert/strict');
const test = require('node:test');

const { MediaActivityController } = require('./media-activity-controller.js');

test('starts active with generation zero and no suspension reasons', () => {
  const controller = new MediaActivityController();

  assert.deepEqual(controller.getSnapshot(), {
    active: true,
    suspended: false,
    reasons: [],
    generation: 0,
  });
});

test('suspends media for recognized reasons in deterministic order', () => {
  const controller = new MediaActivityController();

  controller.suspend('page-hide');
  controller.suspend('manual-pause');
  controller.suspend('terminal-active');
  controller.suspend('page-hidden');

  assert.deepEqual(controller.getSnapshot(), {
    active: false,
    suspended: true,
    reasons: ['manual-pause', 'terminal-active', 'page-hidden', 'page-hide'],
    generation: 4,
  });
});

test('increments generation and calls onChange only for state changes', () => {
  const changes = [];
  const controller = new MediaActivityController({
    onChange(snapshot) {
      changes.push(snapshot);
    },
  });

  controller.suspend('manual-pause');
  controller.suspend('manual-pause');
  controller.resume('manual-pause');
  controller.resume('manual-pause');

  assert.equal(controller.getSnapshot().generation, 2);
  assert.deepEqual(changes, [
    {
      active: false,
      suspended: true,
      reasons: ['manual-pause'],
      generation: 1,
    },
    {
      active: true,
      suspended: false,
      reasons: [],
      generation: 2,
    },
  ]);
});

test('rejects unknown suspension reasons', () => {
  const controller = new MediaActivityController();

  assert.throws(() => controller.suspend('network-lost'), /Unknown media suspension reason: network-lost/);
  assert.throws(() => controller.resume('network-lost'), /Unknown media suspension reason: network-lost/);
});
