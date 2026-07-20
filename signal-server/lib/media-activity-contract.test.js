'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  validateMediaActivityRequest,
  summarizeMediaActivity,
} = require('./media-activity-contract');

function valid(overrides = {}) {
  return {
    schemaVersion: 1,
    state: 'suspended',
    reasons: ['manual-pause'],
    generation: 12,
    connectionAttemptId: 'wrd-attempt-1',
    leaseId: 'lease-000000000001',
    leaseEpoch: 42,
    ...overrides,
  };
}

test('accepts versioned media-activity request shape', () => {
  const result = validateMediaActivityRequest(valid());
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, valid());
});

test('rejects unknown schema, invalid state, reasons, and missing fields', () => {
  assert.equal(validateMediaActivityRequest(valid({ schemaVersion: 2 })).code, 'INVALID_SCHEMA_VERSION');
  assert.equal(validateMediaActivityRequest(valid({ state: 'paused' })).code, 'INVALID_STATE');
  assert.equal(validateMediaActivityRequest(valid({ reasons: ['nope'] })).code, 'INVALID_REASONS');
  assert.equal(validateMediaActivityRequest(valid({ reasons: ['page-freeze'] })).code, 'INVALID_REASONS');
  assert.equal(validateMediaActivityRequest(valid({ reasons: ['disconnected'] })).code, 'INVALID_REASONS');
  assert.equal(validateMediaActivityRequest(valid({ generation: 0 })).code, 'INVALID_GENERATION');
  assert.equal(validateMediaActivityRequest(valid({ connectionAttemptId: '' })).code, 'INVALID_CONNECTION_ATTEMPT_ID');
  assert.equal(validateMediaActivityRequest(valid({ leaseId: 'short' })).code, 'INVALID_LEASE_ID');
  assert.equal(validateMediaActivityRequest(valid({ leaseEpoch: 0 })).code, 'INVALID_LEASE_EPOCH');
  assert.equal(validateMediaActivityRequest(valid({ extra: true })).code, 'UNKNOWN_FIELD');
  assert.equal(validateMediaActivityRequest(null).code, 'INVALID_ENVELOPE');
});

test('summary redacts leaseId', () => {
  const summary = summarizeMediaActivity(valid());
  assert.equal(Object.hasOwn(summary, 'leaseId'), false);
  assert.equal(JSON.stringify(summary).includes('lease-'), false);
  assert.equal(summary.generation, 12);
  assert.equal(summary.leaseEpoch, 42);
});
