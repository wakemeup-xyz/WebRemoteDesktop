const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  getTurnFingerprint,
  loadTurnFromJsonFile,
  mergeTurnConfig,
} = require('../lib/turn-config');

function writeTempTurnJson(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-turn-'));
  const filePath = path.join(dir, 'turn.json');
  fs.writeFileSync(filePath, JSON.stringify(payload), 'utf8');
  return filePath;
}

test('loads turn.json shape into urls/username/credential', () => {
  const filePath = writeTempTurnJson({
    turnServer: {
      host: '144.225.130.238',
      port: 3478,
      username: 'turn-user',
      password: 'turn-pass',
      realm: 'dedione.stockhub.wiki',
      transport: 'udp',
    },
  });

  const loaded = loadTurnFromJsonFile(filePath);
  assert.equal(loaded.loaded, true);
  assert.deepEqual(loaded.urls, ['turn:144.225.130.238:3478?transport=udp']);
  assert.equal(loaded.username, 'turn-user');
  assert.equal(loaded.credential, 'turn-pass');
  assert.equal(loaded.realm, 'dedione.stockhub.wiki');
});

test('env overrides json urls and credentials', () => {
  const filePath = writeTempTurnJson({
    turnServer: {
      host: 'json.example.com',
      port: 3478,
      username: 'json-user',
      password: 'json-pass',
      transport: 'udp',
    },
  });

  const merged = mergeTurnConfig({
    env: {
      TURN_URLS: 'turn:env.example.com:3478?transport=tcp',
      TURN_USERNAME: 'env-user',
      TURN_CREDENTIAL: 'env-pass',
      WRD_TURN_JSON: filePath,
    },
    jsonPath: filePath,
  });

  assert.deepEqual(merged.urls, ['turn:env.example.com:3478?transport=tcp']);
  assert.equal(merged.username, 'env-user');
  assert.equal(merged.credential, 'env-pass');
  assert.equal(merged.source, 'env');
});

test('fingerprint ignores password and is stable', () => {
  const urls = ['turn:relay.example.com:3478?transport=udp'];
  const left = getTurnFingerprint({ urls, username: 'user' });
  const right = getTurnFingerprint({ urls, username: 'user' });
  const changedPasswordMaterial = getTurnFingerprint({ urls, username: 'user' });
  const differentUser = getTurnFingerprint({ urls, username: 'other' });

  assert.equal(left, right);
  assert.equal(left, changedPasswordMaterial);
  assert.notEqual(left, differentUser);
  assert.match(left, /^[a-f0-9]{64}$/);

  const missingJson = path.join(os.tmpdir(), 'wrd-turn-missing-fp.json');
  const mergedA = mergeTurnConfig({
    env: {
      TURN_URLS: urls.join(','),
      TURN_USERNAME: 'user',
      TURN_CREDENTIAL: 'secret-a',
      WRD_TURN_JSON: missingJson,
    },
    jsonPath: missingJson,
  });
  const mergedB = mergeTurnConfig({
    env: {
      TURN_URLS: urls.join(','),
      TURN_USERNAME: 'user',
      TURN_CREDENTIAL: 'secret-b',
      WRD_TURN_JSON: missingJson,
    },
    jsonPath: missingJson,
  });
  assert.equal(mergedA.fingerprint, mergedB.fingerprint);
});

test('partial credentials keep urls but are not fully configured', () => {
  const merged = mergeTurnConfig({
    env: {
      TURN_URLS: 'turn:relay.example.com:3478',
      TURN_USERNAME: '',
      TURN_CREDENTIAL: '',
      // Isolate from a real ~/.StockHub/turn.json on the developer machine.
      WRD_TURN_JSON: path.join(os.tmpdir(), 'wrd-turn-missing-partial.json'),
    },
    jsonPath: path.join(os.tmpdir(), 'wrd-turn-missing-partial.json'),
  });

  assert.deepEqual(merged.urls, ['turn:relay.example.com:3478?transport=udp']);
  assert.equal(merged.username, '');
  assert.equal(merged.credential, '');
  assert.equal(merged.source, 'env');
  assert.ok(merged.fingerprint);
});

test('falls back to turn.json when env TURN fields are empty', () => {
  const filePath = writeTempTurnJson({
    turnServer: {
      host: 'json-only.example.com',
      port: 3478,
      username: 'json-user',
      password: 'json-pass',
      transport: 'udp',
    },
  });

  const merged = mergeTurnConfig({
    env: {
      TURN_URLS: '',
      TURN_USERNAME: '',
      TURN_CREDENTIAL: '',
      WRD_TURN_JSON: filePath,
    },
    jsonPath: filePath,
  });

  assert.equal(merged.source, 'json');
  assert.deepEqual(merged.urls, ['turn:json-only.example.com:3478?transport=udp']);
  assert.equal(merged.username, 'json-user');
  assert.equal(merged.credential, 'json-pass');
});

test('normalizes bare turn urls and keeps fingerprint stable with transport query', () => {
  const { normalizeTurnUrl, getTurnFingerprint } = require('../lib/turn-config');
  assert.equal(
    normalizeTurnUrl('turn:relay.example.com:3478'),
    'turn:relay.example.com:3478?transport=udp',
  );
  const bare = getTurnFingerprint({
    urls: ['turn:relay.example.com:3478'],
    username: 'user',
  });
  const withQuery = getTurnFingerprint({
    urls: ['turn:relay.example.com:3478?transport=udp'],
    username: 'user',
  });
  assert.equal(bare, withQuery);
});

test('marks source mixed when urls come from json and credentials from env', () => {
  const filePath = writeTempTurnJson({
    turnServer: {
      host: 'json.example.com',
      port: 3478,
      username: 'json-user',
      password: 'json-pass',
      transport: 'udp',
    },
  });
  const merged = mergeTurnConfig({
    env: {
      TURN_URLS: '',
      TURN_USERNAME: 'env-user',
      TURN_CREDENTIAL: 'env-pass',
      WRD_TURN_JSON: filePath,
    },
    jsonPath: filePath,
  });
  assert.equal(merged.source, 'mixed');
  assert.deepEqual(merged.urls, ['turn:json.example.com:3478?transport=udp']);
  assert.equal(merged.username, 'env-user');
  assert.equal(merged.credential, 'env-pass');
});
