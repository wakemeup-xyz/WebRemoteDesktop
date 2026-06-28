const assert = require('node:assert/strict');
const test = require('node:test');

const { getTurnStatus } = require('../lib/config');

test('getTurnStatus reports missing when no TURN env is configured', () => {
  const status = getTurnStatus({
    turnUrls: [],
    turnUsername: '',
    turnCredential: '',
  });

  assert.deepEqual(status, {
    turnConfigured: false,
    turnMisconfigured: false,
    turnStatus: 'missing',
  });
});

test('getTurnStatus reports misconfigured when TURN urls are missing credentials', () => {
  const status = getTurnStatus({
    turnUrls: ['turn:relay.example.com:3478'],
    turnUsername: '',
    turnCredential: '',
  });

  assert.deepEqual(status, {
    turnConfigured: false,
    turnMisconfigured: true,
    turnStatus: 'misconfigured',
  });
});

test('getTurnStatus reports configured only when TURN urls and credentials are complete', () => {
  const status = getTurnStatus({
    turnUrls: ['turn:relay.example.com:3478'],
    turnUsername: 'user',
    turnCredential: 'secret',
  });

  assert.deepEqual(status, {
    turnConfigured: true,
    turnMisconfigured: false,
    turnStatus: 'configured',
  });
});
