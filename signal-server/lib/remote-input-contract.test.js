'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  validateRemoteInput,
  summarizeRemoteInput,
  MAX_BATCH_STEPS,
  MAX_TEXT_SCALARS,
} = require('./remote-input-contract');

const fixtures = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../../shared/remote-input-v2-fixtures.json'),
  'utf8',
));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function keyStep(code = 'KeyA') {
  return {
    phase: 'down',
    code,
    location: 0,
    repeat: false,
    modifiers: { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false },
    locks: { capsLock: false },
  };
}

test('valid v2 fixtures validate and preserve protocol envelope values', () => {
  for (const fixture of fixtures.valid) {
    const result = validateRemoteInput(fixture.input);
    assert.equal(result.ok, true, fixture.name);
    assert.equal(result.value.schemaVersion, fixture.input.schemaVersion, fixture.name);
    assert.equal(result.value.leaseEpoch, fixture.input.leaseEpoch, fixture.name);
    assert.equal(result.value.seq, fixture.input.seq, fixture.name);
  }
});

test('invalid v2 fixtures return their declared error code', () => {
  for (const fixture of fixtures.invalid) {
    const input = clone(fixture.input);
    if (fixture.batchSteps) input.payload.steps = Array.from({ length: fixture.batchSteps }, () => keyStep());
    const result = validateRemoteInput(input);
    assert.deepEqual(result, { ok: false, code: fixture.expectedCode }, fixture.name);
  }
});

test('unicode text summary is JSON safe and never discloses text or lease id', () => {
  const unicode = fixtures.valid.find((fixture) => fixture.name === 'unicode text').input;
  const summary = summarizeRemoteInput(unicode);
  assert.doesNotThrow(() => JSON.stringify(summary));
  assert.equal(JSON.stringify(summary).includes(unicode.payload.text), false);
  assert.equal(JSON.stringify(summary).includes(unicode.leaseId), false);
  assert.deepEqual(Object.keys(summary), ['action', 'leaseEpoch', 'payloadBytes', 'schemaVersion', 'seq', 'type']);
});

test('rejects unknown envelope and payload fields', () => {
  const input = clone(fixtures.valid[0].input);
  input.extra = true;
  assert.deepEqual(validateRemoteInput(input), { ok: false, code: 'UNKNOWN_FIELD' });
  delete input.extra;
  input.payload.extra = true;
  assert.deepEqual(validateRemoteInput(input), { ok: false, code: 'UNKNOWN_FIELD' });
});

test('enforces key location and boolean modifier and lock fields', () => {
  const input = clone(fixtures.valid[0].input);
  input.payload.location = 4;
  assert.deepEqual(validateRemoteInput(input), { ok: false, code: 'INVALID_LOCATION' });
  input.payload.location = 0;
  input.payload.modifiers.altKey = 'false';
  assert.deepEqual(validateRemoteInput(input), { ok: false, code: 'INVALID_MODIFIERS' });
  input.payload.modifiers.altKey = false;
  input.payload.locks.capsLock = 0;
  assert.deepEqual(validateRemoteInput(input), { ok: false, code: 'INVALID_LOCKS' });
});

test('accepts ContextMenu, Convert, and NonConvert physical code shapes', () => {
  for (const code of ['ContextMenu', 'Convert', 'NonConvert']) {
    const input = clone(fixtures.valid[0].input);
    input.payload.code = code;
    assert.equal(validateRemoteInput(input).ok, true, code);
  }
});

test('exports the protocol limits', () => {
  assert.equal(MAX_TEXT_SCALARS, 4096);
  assert.equal(MAX_BATCH_STEPS, 16);
});
