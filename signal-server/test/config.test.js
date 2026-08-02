const assert = require('node:assert/strict');
const test = require('node:test');

const { signAccessToken } = require('../lib/auth');
const { createServerApp } = require('../server');
const { getTurnStatus, getPublicEntryConfig, getMediaModeCapabilities, loadConfig } = require('../lib/config');

process.env.JWT_SECRET = process.env.JWT_SECRET || '12345678';
process.env.VIEWER_ACCESS_PASSWORD = process.env.VIEWER_ACCESS_PASSWORD || 'test-viewer-password';
process.env.HOST_SHARED_SECRET = process.env.HOST_SHARED_SECRET || 'test-host-secret';

test('getTurnStatus reports missing when no TURN env is configured', () => {
  const status = getTurnStatus({
    turnUrls: [],
    turnUsername: '',
    turnCredential: '',
  });

  assert.equal(status.turnConfigured, false);
  assert.equal(status.turnMisconfigured, false);
  assert.equal(status.turnStatus, 'missing');
  assert.equal(status.turnSource, 'none');
  assert.equal(status.turnFingerprint, '');
});

test('getTurnStatus reports misconfigured when TURN urls are missing credentials', () => {
  const status = getTurnStatus({
    turnUrls: ['turn:relay.example.com:3478'],
    turnUsername: '',
    turnCredential: '',
    turnSource: 'env',
    turnFingerprint: 'abc',
  });

  assert.equal(status.turnConfigured, false);
  assert.equal(status.turnMisconfigured, true);
  assert.equal(status.turnStatus, 'misconfigured');
  assert.equal(status.turnSource, 'env');
  assert.equal(status.turnFingerprint, 'abc');
});

test('getTurnStatus reports configured only when TURN urls and credentials are complete', () => {
  const status = getTurnStatus({
    turnUrls: ['turn:relay.example.com:3478'],
    turnUsername: 'user',
    turnCredential: 'secret',
    turnSource: 'json',
    turnFingerprint: 'deadbeef',
  });

  assert.equal(status.turnConfigured, true);
  assert.equal(status.turnMisconfigured, false);
  assert.equal(status.turnStatus, 'configured');
  assert.equal(status.turnSource, 'json');
  assert.equal(status.turnFingerprint, 'deadbeef');
});

test('getPublicEntryConfig returns the formal fixed-domain entry metadata', () => {
  const publicEntry = getPublicEntryConfig({
    publicEntryUrl: ' https://remote.example.com/viewer ',
  });

  assert.deepEqual(publicEntry, {
    formalEntryUrl: 'https://remote.example.com/viewer',
    formalEntryMode: 'fixed-domain',
    quickTunnelRecommended: false,
  });
});

test('getMediaModeCapabilities returns the supported manual fallback contract', () => {
  const capabilities = getMediaModeCapabilities({
    turnUrls: ['turn:relay.example.com:3478'],
    turnUsername: 'viewer',
    turnCredential: 'secret',
  });

  assert.deepEqual(capabilities, {
    directAvailable: true,
    turnConfigured: true,
    tunnelAvailable: true,
    recommendedMode: 'auto',
    manualFallbackChain: ['auto', 'relay', 'tunnel'],
  });
});

test('getMediaModeCapabilities omits relay from the manual fallback contract when TURN is unavailable', () => {
  const capabilities = getMediaModeCapabilities({
    turnUrls: [],
    turnUsername: '',
    turnCredential: '',
  });

  assert.deepEqual(capabilities, {
    directAvailable: true,
    turnConfigured: false,
    tunnelAvailable: true,
    recommendedMode: 'auto',
    manualFallbackChain: ['auto', 'tunnel'],
  });
});

test('loadConfig keeps diag persistence separate from runtime log settings', () => {
  const previousEnv = { ...process.env };

  process.env.JWT_SECRET = '12345678';
  process.env.VIEWER_ACCESS_PASSWORD = 'test-viewer-password';
  process.env.HOST_SHARED_SECRET = 'test-host-secret';
  process.env.WRD_ENABLE_DIAG_PERSIST = '0';
  process.env.WRD_LOG_LEVEL = 'debug';
  process.env.WRD_LOG_FORMAT = 'jsonl';
  process.env.WRD_LOG_DIR = '/tmp/wrd-logs';
  process.env.WRD_LOG_MAX_BYTES = '2048';
  process.env.WRD_LOG_BACKUP_COUNT = '5';
  process.env.WRD_HOST_VERBOSE_DIAGNOSTICS = '1';
  process.env.WRD_TERMINAL_AUDIT_LOG = '/tmp/wrd-terminal-audit.jsonl';

  try {
    const config = loadConfig();
    assert.equal(config.enableDiagPersist, false);
    assert.equal(config.logLevel, 'debug');
    assert.equal(config.logFormat, 'jsonl');
    assert.equal(config.logDir, '/tmp/wrd-logs');
    assert.equal(config.logMaxBytes, 2048);
    assert.equal(config.logBackupCount, 5);
    assert.equal(config.hostVerboseDiagnostics, true);
    assert.equal(config.terminalAuditLog, '/tmp/wrd-terminal-audit.jsonl');
  } finally {
    process.env = previousEnv;
  }
});

test('loadConfig defaults file rotation to ten MiB and three backups', () => {
  const previousEnv = { ...process.env };
  delete process.env.WRD_LOG_MAX_BYTES;
  delete process.env.WRD_LOG_BACKUP_COUNT;

  try {
    const config = loadConfig();
    assert.equal(config.logMaxBytes, 10 * 1024 * 1024);
    assert.equal(config.logBackupCount, 3);
  } finally {
    process.env = previousEnv;
  }
});

test('loadConfig applies canonical terminal validation through its public adapter', () => {
  const previousEnv = { ...process.env };
  process.env.WRD_TERMINAL_MAX_SESSIONS = 'NaN';

  try {
    assert.throws(() => loadConfig(), /WRD_TERMINAL_MAX_SESSIONS/);
  } finally {
    process.env = previousEnv;
  }
});

test('/api/webrtc-config returns ICE settings plus capability and public entry metadata', async () => {
  const runtime = createServerApp({
    config: {
      port: 0,
      nodeEnv: 'test',
      jwtSecret: process.env.JWT_SECRET,
      viewerAccessPassword: process.env.VIEWER_ACCESS_PASSWORD,
      hostSharedSecret: process.env.HOST_SHARED_SECRET,
      corsOrigins: [],
      stunUrls: ['stun:stun1.example.com:3478'],
      turnUrls: ['turn:relay.example.com:3478'],
      turnUsername: 'viewer-user',
      turnCredential: 'turn-secret',
      turnSource: 'env',
      turnFingerprint: 'fp-test',
      publicEntryUrl: 'https://link.stockhub.wiki',
      enableDiagPersist: false,
      enableTerminal: false,
      terminalAdminPassword: '',
      terminalShell: '/bin/zsh',
      terminalCwd: '',
      terminalSoftWarnSessionCount: 4,
      terminalIdleTimeoutMs: 0,
      terminalStartupTimeoutMs: 10000,
      terminalAuditLog: '',
      terminalRecordIo: false,
    },
    logger: { log() {}, info() {}, warn() {}, error() {} },
  });
  await new Promise((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  const { port } = runtime.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const response = await fetch(baseUrl + '/api/webrtc-config', {
      headers: {
        Authorization: `Bearer ${signAccessToken('viewer', 'viewer-config-test')}`,
      },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.stunUrls[0], 'stun:stun1.example.com:3478');
    assert.equal(body.turnConfigured, true);
    assert.equal(body.turnMisconfigured, false);
    assert.equal(body.turnStatus, 'configured');
    assert.equal(body.turnSource, 'env');
    assert.equal(body.turnFingerprint, 'fp-test');
    assert.deepEqual(body.turnUrls, ['turn:relay.example.com:3478']);
    assert.equal(body.hostTurnReady, false);
    assert.equal(body.hostTurnFingerprint, '');
    assert.equal(body.hostSupportsSessionTurn, false);
    assert.deepEqual(body.iceServers, [
      { urls: ['stun:stun1.example.com:3478'] },
      {
        urls: ['turn:relay.example.com:3478'],
        username: 'viewer-user',
        credential: 'turn-secret',
      },
    ]);
    assert.equal(body.directAvailable, true);
    assert.equal(body.tunnelAvailable, true);
    assert.equal(body.recommendedMode, 'auto');
    assert.deepEqual(body.manualFallbackChain, ['auto', 'relay', 'tunnel']);
    assert.deepEqual(body.publicEntry, {
      formalEntryUrl: 'https://link.stockhub.wiki',
      formalEntryMode: 'fixed-domain',
      quickTunnelRecommended: false,
    });
  } finally {
    await new Promise((resolve, reject) => runtime.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('/api/webrtc-config lists multi turn servers and selects by query id', async () => {
  const catalog = {
    defaultId: 'aliyun',
    source: 'json',
    servers: [
      {
        id: 'aliyun',
        label: '阿里云节点',
        host: '8.1.1.1',
        port: 3478,
        transport: 'udp',
        realm: 'aliyun.example',
        priority: 0,
        preferred: true,
        configured: true,
        fingerprint: 'fp-aliyun',
        urls: ['turn:8.1.1.1:3478?transport=udp'],
        username: 'u1',
        credential: 'p1',
        source: 'json',
      },
      {
        id: 'overseas',
        label: '海外节点',
        host: '9.2.2.2',
        port: 3478,
        transport: 'udp',
        realm: 'overseas.example',
        priority: 0,
        preferred: false,
        configured: true,
        fingerprint: 'fp-overseas',
        urls: ['turn:9.2.2.2:3478?transport=udp'],
        username: 'u2',
        credential: 'p2',
        source: 'json',
      },
    ],
  };

  const runtime = createServerApp({
    config: {
      port: 0,
      nodeEnv: 'test',
      jwtSecret: process.env.JWT_SECRET,
      viewerAccessPassword: process.env.VIEWER_ACCESS_PASSWORD,
      hostSharedSecret: process.env.HOST_SHARED_SECRET,
      corsOrigins: [],
      stunUrls: ['stun:stun1.example.com:3478'],
      turnUrls: catalog.servers[0].urls,
      turnUsername: 'u1',
      turnCredential: 'p1',
      turnSource: 'json',
      turnFingerprint: 'fp-aliyun',
      turnCatalog: catalog,
      selectedTurnServerId: 'aliyun',
      defaultTurnServerId: 'aliyun',
      publicEntryUrl: 'https://link.stockhub.wiki',
      enableDiagPersist: false,
      enableTerminal: false,
      terminalAdminPassword: '',
      terminalShell: '/bin/zsh',
      terminalCwd: '',
      terminalSoftWarnSessionCount: 4,
      terminalIdleTimeoutMs: 0,
      terminalStartupTimeoutMs: 10000,
      terminalAuditLog: '',
      terminalRecordIo: false,
    },
    logger: { log() {}, info() {}, warn() {}, error() {} },
  });
  await new Promise((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  const { port } = runtime.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const auth = {
    Authorization: `Bearer ${signAccessToken('viewer', 'viewer-multi-turn')}`,
  };

  try {
    const defaultResp = await fetch(`${baseUrl}/api/webrtc-config`, { headers: auth });
    const defaultBody = await defaultResp.json();
    assert.equal(defaultResp.status, 200);
    assert.equal(defaultBody.turnServers.length, 2);
    assert.equal(defaultBody.selectedTurnServerId, 'aliyun');
    assert.equal(defaultBody.defaultTurnServerId, 'aliyun');
    assert.deepEqual(defaultBody.turnUrls, ['turn:8.1.1.1:3478?transport=udp']);
    assert.ok(defaultBody.turnServers.every((server) => !('password' in server) && !('credential' in server)));

    const overseasResp = await fetch(`${baseUrl}/api/webrtc-config?turnServerId=overseas`, { headers: auth });
    const overseasBody = await overseasResp.json();
    assert.equal(overseasResp.status, 200);
    assert.equal(overseasBody.selectedTurnServerId, 'overseas');
    assert.equal(overseasBody.turnFingerprint, 'fp-overseas');
    assert.deepEqual(overseasBody.turnUrls, ['turn:9.2.2.2:3478?transport=udp']);
    assert.equal(overseasBody.iceServers.at(-1).username, 'u2');
  } finally {
    await new Promise((resolve, reject) => runtime.server.close((err) => (err ? reject(err) : resolve())));
  }
});
