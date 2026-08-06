'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { loadTurnCatalog } = require('../lib/turn-config');

const FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'turn', 'catalog-priority.json');

test('turn priority is integer-only and matches shared fixture defaults', () => {
  const catalog = loadTurnCatalog({
    env: {
      WRD_TURN_JSON: FIXTURE,
      TURN_URLS: '',
      TURN_USERNAME: '',
      TURN_CREDENTIAL: '',
    },
    jsonPath: FIXTURE,
  });
  const byId = Object.fromEntries(catalog.servers.map((server) => [server.id, server]));
  assert.equal(byId.low.priority, 1);
  assert.equal(byId.high.priority, 10);
  assert.equal(byId.bad.priority, 0);
  assert.equal(catalog.defaultId, 'high');
  assert.ok(byId.high.fingerprint);
  assert.notEqual(byId.high.fingerprint, byId.low.fingerprint);
});
