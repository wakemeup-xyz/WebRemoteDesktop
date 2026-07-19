const assert = require('node:assert/strict');
const test = require('node:test');

const { MediaActivityController } = require('./media-activity-controller.js');

test('starts active with generation zero and no suspension reasons', () => {
  const controller = MediaActivityController.create();

  assert.deepEqual(controller.snapshot(), {
    state: 'active',
    reasons: [],
    generation: 0,
  });
});

test('suspends media for recognized reasons in deterministic order', () => {
  const controller = MediaActivityController.create();

  controller.setReason('page-hide', true);
  controller.setReason('manual-pause', true);
  controller.setReason('terminal-active', true);
  controller.setReason('page-hidden', true);

  assert.equal(controller.hasReason('terminal-active'), true);
  assert.deepEqual(controller.snapshot(), {
    state: 'suspended',
    reasons: ['manual-pause', 'terminal-active', 'page-hidden', 'page-hide'],
    generation: 4,
  });
});

test('increments generation and calls onChange only for state changes', () => {
  const changes = [];
  const controller = MediaActivityController.create({
    onChange(snapshot) {
      changes.push(snapshot);
    },
  });

  controller.setReason('manual-pause', true);
  controller.setReason('manual-pause', true);
  controller.setReason('manual-pause', false);
  controller.setReason('manual-pause', false);

  assert.equal(controller.snapshot().generation, 2);
  assert.deepEqual(changes, [
    {
      state: 'suspended',
      reasons: ['manual-pause'],
      generation: 1,
    },
    {
      state: 'active',
      reasons: [],
      generation: 2,
    },
  ]);
});

test('rejects unknown reasons without mutating an already-suspended controller', () => {
  const controller = MediaActivityController.create();
  controller.setReason('page-hidden', true);
  const before = controller.snapshot();

  assert.throws(() => controller.setReason('network-lost', true), /Unknown media suspension reason: network-lost/);
  assert.throws(() => controller.hasReason('network-lost'), /Unknown media suspension reason: network-lost/);
  assert.deepEqual(controller.snapshot(), before);
});
