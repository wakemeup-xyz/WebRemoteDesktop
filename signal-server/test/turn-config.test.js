const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  getTurnFingerprint,
  loadTurnCatalog,
  loadTurnFromJsonFile,
  mergeTurnConfig,
  resolveTurnServer,
  toPublicTurnServer,
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

test('loads turnServers array and prefers aliyun as default', () => {
  const filePath = writeTempTurnJson({
    turnServers: [
      {
        host: '8.1.1.1',
        port: 3478,
        username: 'u1',
        password: 'p1',
        realm: 'aliyun.example',
        transport: 'udp',
        remark: '阿里云节点',
      },
      {
        host: '9.2.2.2',
        port: 3478,
        username: 'u2',
        password: 'p2',
        realm: 'overseas.example',
        transport: 'udp',
        remark: '海外节点',
      },
    ],
  });

  const catalog = loadTurnCatalog({
    env: {
      TURN_URLS: '',
      TURN_USERNAME: '',
      TURN_CREDENTIAL: '',
      WRD_TURN_JSON: filePath,
    },
    jsonPath: filePath,
  });

  assert.equal(catalog.servers.length, 2);
  assert.equal(catalog.defaultId, 'aliyun');
  assert.ok(catalog.servers.every((server) => server.configured));
  const publicServers = catalog.servers.map((server) => toPublicTurnServer(server, {
    selectedId: catalog.defaultId,
    defaultId: catalog.defaultId,
  }));
  assert.ok(publicServers.every((server) => !Object.prototype.hasOwnProperty.call(server, 'password')));
  assert.ok(publicServers.every((server) => !Object.prototype.hasOwnProperty.call(server, 'credential')));
  assert.equal(publicServers.find((server) => server.id === 'aliyun')?.preferred, true);

  const merged = mergeTurnConfig({
    env: {
      TURN_URLS: '',
      TURN_USERNAME: '',
      TURN_CREDENTIAL: '',
      WRD_TURN_JSON: filePath,
    },
    jsonPath: filePath,
  });
  assert.equal(merged.selectedTurnServerId, 'aliyun');
  assert.deepEqual(merged.urls, ['turn:8.1.1.1:3478?transport=udp']);
  assert.equal(merged.username, 'u1');
});

test('legacy turnServer still yields one-server catalog', () => {
  const filePath = writeTempTurnJson({
    turnServer: {
      host: '1.1.1.1',
      port: 3478,
      username: 'u',
      password: 'p',
      transport: 'udp',
      remark: 'legacy',
    },
  });
  const catalog = loadTurnCatalog({
    env: { WRD_TURN_JSON: filePath },
    jsonPath: filePath,
  });
  assert.equal(catalog.servers.length, 1);
  assert.equal(catalog.servers[0].configured, true);
  assert.ok(catalog.defaultId);
});

test('resolveTurnServer unknown id falls back to default', () => {
  const filePath = writeTempTurnJson({
    turnServers: [
      {
        host: '8.1.1.1', port: 3478, username: 'u1', password: 'p1',
        realm: 'aliyun.example', transport: 'udp', remark: '阿里云节点',
      },
      {
        host: '9.2.2.2', port: 3478, username: 'u2', password: 'p2',
        realm: 'overseas.example', transport: 'udp', remark: '海外节点',
      },
    ],
  });
  const catalog = loadTurnCatalog({
    env: { WRD_TURN_JSON: filePath },
    jsonPath: filePath,
  });
  const resolved = resolveTurnServer(catalog, 'does-not-exist');
  assert.equal(resolved.id, catalog.defaultId);
  assert.equal(resolved.id, 'aliyun');
  const overseas = resolveTurnServer(catalog, 'overseas');
  assert.equal(overseas.id, 'overseas');
  assert.deepEqual(overseas.urls, ['turn:9.2.2.2:3478?transport=udp']);
});

test('explicit defaultTurnServerId and WRD_TURN_SERVER_ID win over aliyun heuristic', () => {
  const filePath = writeTempTurnJson({
    defaultTurnServerId: 'overseas',
    turnServers: [
      {
        host: '8.1.1.1', port: 3478, username: 'u1', password: 'p1',
        transport: 'udp', remark: '阿里云节点',
      },
      {
        id: 'overseas',
        host: '9.2.2.2', port: 3478, username: 'u2', password: 'p2',
        transport: 'udp', remark: '海外节点',
      },
    ],
  });
  const byFile = loadTurnCatalog({
    env: { WRD_TURN_JSON: filePath },
    jsonPath: filePath,
  });
  assert.equal(byFile.defaultId, 'overseas');

  const byEnv = loadTurnCatalog({
    env: {
      WRD_TURN_JSON: filePath,
      WRD_TURN_SERVER_ID: 'aliyun',
    },
    jsonPath: filePath,
  });
  assert.equal(byEnv.defaultId, 'aliyun');
});

test('full TURN_URLS env injects env server and selects it by default', () => {
  const filePath = writeTempTurnJson({
    turnServers: [
      {
        host: '8.1.1.1', port: 3478, username: 'u1', password: 'p1',
        transport: 'udp', remark: '阿里云节点',
      },
    ],
  });
  const catalog = loadTurnCatalog({
    env: {
      TURN_URLS: 'turn:env.example.com:3478?transport=tcp',
      TURN_USERNAME: 'env-user',
      TURN_CREDENTIAL: 'env-pass',
      WRD_TURN_JSON: filePath,
    },
    jsonPath: filePath,
  });
  assert.ok(catalog.servers.some((server) => server.id === 'env'));
  assert.equal(catalog.defaultId, 'env');
  const merged = mergeTurnConfig({
    env: {
      TURN_URLS: 'turn:env.example.com:3478?transport=tcp',
      TURN_USERNAME: 'env-user',
      TURN_CREDENTIAL: 'env-pass',
      WRD_TURN_JSON: filePath,
    },
    jsonPath: filePath,
  });
  assert.equal(merged.source, 'env');
  assert.deepEqual(merged.urls, ['turn:env.example.com:3478?transport=tcp']);
  assert.equal(merged.selectedTurnServerId, 'env');
});
