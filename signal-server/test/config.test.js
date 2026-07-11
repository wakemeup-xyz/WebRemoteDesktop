const assert = require('node:assert/strict');
const test = require('node:test');

const { signAccessToken } = require('../lib/auth');
const { createServerApp } = require('../server');
const { getTurnStatus, getPublicEntryConfig, getMediaModeCapabilities } = require('../lib/config');

process.env.JWT_SECRET = process.env.JWT_SECRET || '12345678';
process.env.VIEWER_ACCESS_PASSWORD = process.env.VIEWER_ACCESS_PASSWORD || 'test-viewer-password';
process.env.HOST_SHARED_SECRET = process.env.HOST_SHARED_SECRET || 'test-host-secret';

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
    assert.deepEqual(body, {
      stunUrls: ['stun:stun1.example.com:3478'],
      turnConfigured: true,
      turnMisconfigured: false,
      turnStatus: 'configured',
      turnUrls: ['turn:relay.example.com:3478'],
      iceServers: [
        { urls: ['stun:stun1.example.com:3478'] },
        {
          urls: ['turn:relay.example.com:3478'],
          username: 'viewer-user',
          credential: 'turn-secret',
        },
      ],
      directAvailable: true,
      tunnelAvailable: true,
      recommendedMode: 'auto',
      manualFallbackChain: ['auto', 'relay', 'tunnel'],
      publicEntry: {
        formalEntryUrl: 'https://link.stockhub.wiki',
        formalEntryMode: 'fixed-domain',
        quickTunnelRecommended: false,
      },
    });
  } finally {
    await new Promise((resolve, reject) => runtime.server.close((err) => (err ? reject(err) : resolve())));
  }
});
