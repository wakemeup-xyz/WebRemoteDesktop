const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { signAccessToken } = require('../lib/auth');
const { createServerApp } = require('../server');
const { connections } = require('../websocket/signaling');
const { redactDiagnosticPayload, getDiagDir, persistDiagnostic, ingestDiagnosticPayload } = require('../lib/diagnostic');

process.env.JWT_SECRET = process.env.JWT_SECRET || '12345678';
process.env.VIEWER_ACCESS_PASSWORD = process.env.VIEWER_ACCESS_PASSWORD || 'test-viewer-password';
process.env.HOST_SHARED_SECRET = process.env.HOST_SHARED_SECRET || 'test-host-secret';

test('redactDiagnosticPayload trims logs and strips keyboard debug details', () => {
  const payload = {
    logs: Array.from({ length: 140 }, (_, index) => 'log-' + index),
    keyboardDebug: ['debug-1', 'debug-2'],
    network: {
      candidateSummary: {
        local: { host: 2, srflx: 1 },
        remote: { host: 1, srflx: 1 },
        samples: {
          local: [{ type: 'srflx', address: '203.0.113.1:5000' }],
          remote: [{ type: 'host', address: '192.168.0.2:6000' }],
        },
      },
    },
    inputState: {
      keyboardMode: 'windows',
      pendingKeys: ['KeyA', 'KeyB'],
      lastReleaseAllReason: 'window-blur',
      lastKeyboardResetReason: 'window-blur',
      recentInputEvents: Array.from({ length: 30 }, (_, index) => ({ id: index })),
    },
  };
  const redacted = redactDiagnosticPayload(payload);
  assert.equal(redacted.logs.length, 120);
  assert.deepEqual(redacted.keyboardDebug, []);
  assert.equal(redacted.inputState.keyboardMode, 'windows');
  assert.equal(redacted.inputState.pendingKeys, 2);
  assert.equal(redacted.inputState.recentInputEvents.length, 20);
  assert.equal(redacted.network.candidateSummary.local.srflx, 1);
  assert.equal(redacted.network.candidateSummary.samples.local[0].type, 'srflx');
});

test('persistDiagnostic writes into stable /tmp/wrd-diag directory', () => {
  const dir = getDiagDir();
  assert.equal(dir, path.join('/tmp', 'wrd-diag'));
  const filename = 'diag-' + Date.now() + '.json';
  const report = { ok: true };
  persistDiagnostic(filename, report);
  const written = JSON.parse(fs.readFileSync(path.join(dir, filename), 'utf8'));
  assert.deepEqual(written, report);
  fs.unlinkSync(path.join(dir, filename));
});

test('ingestDiagnosticPayload returns a shared redacted diagnostic report shape', () => {
  const result = ingestDiagnosticPayload({
    role: 'viewer',
    viewerId: 'viewer-1',
    userAgent: 'UnitTestAgent/1.0',
    data: {
      type: 'connection-diagnostic',
      schemaVersion: 2,
      browserSessionId: 'browser-1',
      connectionAttemptId: 'attempt-unit-1',
      logs: ['line-1'],
      trigger: 'manual',
      reason: 'ice-failed',
      latency: 123,
      keyboardDebug: ['hidden'],
      keyboardMode: 'windows',
      unexpected: { nested: true },
      traceSummary: { trigger: 'manual', reason: 'ice-failed' },
      recommendation: { nextSuggestedMode: 'tunnel' },
      events: [{ type: 'attempt-failure' }],
      network: {
        networkMode: 'auto',
        candidateSummary: {
          local: { host: 1, srflx: 1 },
          remote: { relay: 1 },
          samples: { local: [], remote: [] },
        },
      },
    },
    config: { enableDiagPersist: false },
    logger: { log() {}, info() {}, warn() {}, error() {} },
  });

  assert.deepEqual({
    accepted: result.accepted,
    connectionAttemptId: result.connectionAttemptId,
  }, {
    accepted: true,
    connectionAttemptId: 'attempt-unit-1',
  });
  assert.equal(result.report.type, 'connection-diagnostic');
  assert.equal(result.report.schemaVersion, 2);
  assert.equal(result.report.connectionAttemptId, 'attempt-unit-1');
  assert.deepEqual(result.report.logs, ['line-1']);
  assert.deepEqual(result.report.keyboardDebug, []);
  assert.equal(result.report.trigger, 'manual');
  assert.equal(result.report.reason, 'ice-failed');
  assert.equal(result.report.latency, 123);
  assert.deepEqual(result.report.traceSummary, { trigger: 'manual', reason: 'ice-failed' });
  assert.deepEqual(result.report.recommendation, { nextSuggestedMode: 'tunnel' });
  assert.deepEqual(result.report.events, [{ type: 'attempt-failure' }]);
  assert.deepEqual(result.report.network, {
    networkMode: 'auto',
    candidateSummary: {
      local: { host: 1, srflx: 1 },
      remote: { relay: 1 },
      samples: { local: [], remote: [] },
    },
  });
  assert.equal(result.report.viewerId, 'viewer-1');
  assert.equal(result.report.userAgent, 'UnitTestAgent/1.0');
  assert.equal(result.report.screen, 'unknown');
  assert.equal(result.report.logCount, 1);
  assert.equal(result.report.inputState, null);
  assert.deepEqual(result.report.probeResults, []);
  assert.deepEqual(result.report.inputChannelTimeline, []);
  assert.equal('keyboardMode' in result.report, false);
  assert.equal('unexpected' in result.report, false);
  assert.match(result.report.receivedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(result.summaryEvent, {
    domain: 'viewer',
    event: 'diagnostic_uploaded',
    message: 'Viewer uploaded diagnostic bundle',
    correlation: {
      browserSessionId: 'browser-1',
      connectionAttemptId: 'attempt-unit-1',
      viewerId: 'viewer-1',
      socketId: null,
    },
    meta: {
      trigger: 'manual',
      reason: 'ice-failed',
      type: 'connection-diagnostic',
      logCount: 1,
      persisted: false,
    },
  });
});

test('POST /api/diagnostics rejects requests without a bearer token', async () => {
  const runtime = createServerApp({
    config: {
      port: 0,
      nodeEnv: 'test',
      jwtSecret: process.env.JWT_SECRET,
      viewerAccessPassword: process.env.VIEWER_ACCESS_PASSWORD,
      hostSharedSecret: process.env.HOST_SHARED_SECRET,
      corsOrigins: [],
      stunUrls: [],
      turnUrls: [],
      turnUsername: '',
      turnCredential: '',
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
    const response = await fetch(baseUrl + '/api/diagnostics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectionAttemptId: 'attempt-http-missing-token' }),
    });

    assert.equal(response.status, 401);
  } finally {
    await new Promise((resolve, reject) => runtime.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('POST /api/diagnostics accepts viewer bearer token and returns the accepted connection attempt id', async () => {
  const runtime = createServerApp({
    config: {
      port: 0,
      nodeEnv: 'test',
      jwtSecret: process.env.JWT_SECRET,
      viewerAccessPassword: process.env.VIEWER_ACCESS_PASSWORD,
      hostSharedSecret: process.env.HOST_SHARED_SECRET,
      corsOrigins: [],
      stunUrls: [],
      turnUrls: [],
      turnUsername: '',
      turnCredential: '',
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
  const hostEvents = [];
  connections.host = {
    emit(event, data) {
      hostEvents.push({ event, data });
    },
  };

  try {
    const response = await fetch(baseUrl + '/api/diagnostics', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${signAccessToken('viewer', 'viewer-http-diagnostic')}`,
      },
      body: JSON.stringify({
        type: 'connection-diagnostic',
        schemaVersion: 2,
        connectionAttemptId: 'attempt-http-1',
        trigger: 'auto-failure',
        reason: 'signaling-unavailable',
        latency: 88,
        recommendation: { nextSuggestedMode: 'relay' },
        events: [{ type: 'attempt-failure', mode: 'auto' }],
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.deepEqual(body, {
      accepted: true,
      connectionAttemptId: 'attempt-http-1',
    });
    assert.equal(hostEvents.length, 1);
    assert.equal(hostEvents[0].event, 'diagnostic');
    assert.equal(hostEvents[0].data.connectionAttemptId, 'attempt-http-1');
    assert.equal(hostEvents[0].data.viewerId, 'http-viewer-http-diagnostic');
    assert.equal(typeof hostEvents[0].data.userAgent, 'string');
    assert.equal(hostEvents[0].data.userAgent.length > 0, true);
    assert.equal(hostEvents[0].data.screen, 'unknown');
    assert.equal(hostEvents[0].data.logCount, 0);
    assert.equal(hostEvents[0].data.type, 'connection-diagnostic');
    assert.equal(hostEvents[0].data.schemaVersion, 2);
    assert.equal(hostEvents[0].data.trigger, 'auto-failure');
    assert.equal(hostEvents[0].data.reason, 'signaling-unavailable');
    assert.equal(hostEvents[0].data.latency, 88);
    assert.deepEqual(hostEvents[0].data.events, [{ type: 'attempt-failure', mode: 'auto' }]);
    assert.deepEqual(hostEvents[0].data.probeResults, []);
    assert.deepEqual(hostEvents[0].data.inputChannelTimeline, []);
    assert.deepEqual(hostEvents[0].data.recommendation, { nextSuggestedMode: 'relay' });
    assert.match(hostEvents[0].data.receivedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    connections.host = null;
    connections.viewers.clear();
    connections.relayViewers.clear();
    await new Promise((resolve, reject) => runtime.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('GET /api/admin/connection-summary returns recent failure buckets and suggestion counts', async () => {
  fs.rmSync(getDiagDir(), { recursive: true, force: true });
  persistDiagnostic('2026-07-08T00-00-00-000Z_summary-1.json', {
    connectionAttemptId: 'attempt-summary-1',
    receivedAt: '2026-07-08T00:00:00.000Z',
    traceSummary: { reason: 'direct-failed-suggest-relay' },
    recommendation: { nextSuggestedMode: 'relay' },
    mode: 'auto',
  });
  persistDiagnostic('2026-07-08T00-00-01-000Z_summary-2.json', {
    connectionAttemptId: 'attempt-summary-2',
    receivedAt: '2026-07-08T00:00:01.000Z',
    traceSummary: { reason: 'relay-failed-suggest-tunnel' },
    recommendation: { nextSuggestedMode: 'tunnel' },
    mode: 'relay',
  });

  const runtime = createServerApp({
    config: {
      port: 0,
      nodeEnv: 'test',
      jwtSecret: process.env.JWT_SECRET,
      viewerAccessPassword: process.env.VIEWER_ACCESS_PASSWORD,
      hostSharedSecret: process.env.HOST_SHARED_SECRET,
      corsOrigins: [],
      stunUrls: [],
      turnUrls: [],
      turnUsername: '',
      turnCredential: '',
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
    const response = await fetch(baseUrl + '/api/admin/connection-summary', {
      headers: {
        Authorization: `Bearer ${signAccessToken('admin', 'diag-admin')}`,
      },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.total, 2);
    assert.equal(body.failures['direct-failed-suggest-relay'], 1);
    assert.equal(body.failures['relay-failed-suggest-tunnel'], 1);
    assert.equal(body.nextSuggestions.relay, 1);
    assert.equal(body.nextSuggestions.tunnel, 1);
    assert.equal(body.latestAttempt.connectionAttemptId, 'attempt-summary-2');
  } finally {
    fs.rmSync(getDiagDir(), { recursive: true, force: true });
    await new Promise((resolve, reject) => runtime.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('GET /api/admin/connection-summary deduplicates repeated reports from the same attempt', async () => {
  fs.rmSync(getDiagDir(), { recursive: true, force: true });
  persistDiagnostic('2026-07-08T00-00-00-000Z_attempt-dup-1.json', {
    connectionAttemptId: 'attempt-dup-1',
    receivedAt: '2026-07-08T00:00:00.000Z',
    traceSummary: { reason: 'direct-failed-suggest-relay' },
    recommendation: { nextSuggestedMode: 'relay' },
    mode: 'auto',
  });
  persistDiagnostic('2026-07-08T00-00-01-000Z_attempt-dup-2.json', {
    connectionAttemptId: 'attempt-dup-1',
    receivedAt: '2026-07-08T00:00:01.000Z',
    traceSummary: { reason: 'direct-failed-suggest-relay' },
    recommendation: { nextSuggestedMode: 'relay' },
    mode: 'auto',
  });

  const runtime = createServerApp({
    config: {
      port: 0,
      nodeEnv: 'test',
      jwtSecret: process.env.JWT_SECRET,
      viewerAccessPassword: process.env.VIEWER_ACCESS_PASSWORD,
      hostSharedSecret: process.env.HOST_SHARED_SECRET,
      corsOrigins: [],
      stunUrls: [],
      turnUrls: [],
      turnUsername: '',
      turnCredential: '',
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
    const response = await fetch(baseUrl + '/api/admin/connection-summary', {
      headers: {
        Authorization: `Bearer ${signAccessToken('admin', 'diag-admin')}`,
      },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.total, 1);
    assert.equal(body.failures['direct-failed-suggest-relay'], 1);
    assert.equal(body.nextSuggestions.relay, 1);
    assert.equal(body.latestAttempt.connectionAttemptId, 'attempt-dup-1');
    assert.equal(body.latestAttempt.receivedAt, '2026-07-08T00:00:01.000Z');
  } finally {
    fs.rmSync(getDiagDir(), { recursive: true, force: true });
    await new Promise((resolve, reject) => runtime.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('GET /api/admin/connection-attempts respects limit and returns newest attempts first', async () => {
  fs.rmSync(getDiagDir(), { recursive: true, force: true });
  persistDiagnostic('2026-07-08T00-00-00-000Z_attempt-1.json', {
    connectionAttemptId: 'attempt-list-1',
    receivedAt: '2026-07-08T00:00:00.000Z',
    traceSummary: { reason: 'direct-failed-suggest-relay' },
  });
  persistDiagnostic('2026-07-08T00-00-01-000Z_attempt-2.json', {
    connectionAttemptId: 'attempt-list-2',
    receivedAt: '2026-07-08T00:00:01.000Z',
    traceSummary: { reason: 'relay-failed-suggest-tunnel' },
  });

  const runtime = createServerApp({
    config: {
      port: 0,
      nodeEnv: 'test',
      jwtSecret: process.env.JWT_SECRET,
      viewerAccessPassword: process.env.VIEWER_ACCESS_PASSWORD,
      hostSharedSecret: process.env.HOST_SHARED_SECRET,
      corsOrigins: [],
      stunUrls: [],
      turnUrls: [],
      turnUsername: '',
      turnCredential: '',
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
    const response = await fetch(baseUrl + '/api/admin/connection-attempts?limit=1', {
      headers: {
        Authorization: `Bearer ${signAccessToken('admin', 'diag-admin')}`,
      },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].connectionAttemptId, 'attempt-list-2');
  } finally {
    fs.rmSync(getDiagDir(), { recursive: true, force: true });
    await new Promise((resolve, reject) => runtime.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('GET /api/admin/connection-attempts ignores malformed diagnostic files', async () => {
  fs.rmSync(getDiagDir(), { recursive: true, force: true });
  fs.mkdirSync(getDiagDir(), { recursive: true });
  fs.writeFileSync(path.join(getDiagDir(), 'broken.json'), '{"connectionAttemptId":', 'utf8');
  persistDiagnostic('2026-07-08T00-00-01-000Z_attempt-ok.json', {
    connectionAttemptId: 'attempt-ok-1',
    receivedAt: '2026-07-08T00:00:01.000Z',
    traceSummary: { reason: 'relay-failed-suggest-tunnel' },
  });

  const runtime = createServerApp({
    config: {
      port: 0,
      nodeEnv: 'test',
      jwtSecret: process.env.JWT_SECRET,
      viewerAccessPassword: process.env.VIEWER_ACCESS_PASSWORD,
      hostSharedSecret: process.env.HOST_SHARED_SECRET,
      corsOrigins: [],
      stunUrls: [],
      turnUrls: [],
      turnUsername: '',
      turnCredential: '',
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
    const response = await fetch(baseUrl + '/api/admin/connection-attempts?limit=5', {
      headers: {
        Authorization: `Bearer ${signAccessToken('admin', 'diag-admin')}`,
      },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].connectionAttemptId, 'attempt-ok-1');
  } finally {
    fs.rmSync(getDiagDir(), { recursive: true, force: true });
    await new Promise((resolve, reject) => runtime.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('admin observability summary and recent endpoints return structured diagnostic events from runtime memory', async () => {
  const runtime = createServerApp({
    config: {
      port: 0,
      nodeEnv: 'test',
      jwtSecret: process.env.JWT_SECRET,
      viewerAccessPassword: process.env.VIEWER_ACCESS_PASSWORD,
      hostSharedSecret: process.env.HOST_SHARED_SECRET,
      corsOrigins: [],
      stunUrls: [],
      turnUrls: [],
      turnUsername: '',
      turnCredential: '',
      publicEntryUrl: 'https://link.stockhub.wiki',
      enableDiagPersist: false,
      logLevel: 'info',
      logFormat: 'jsonl',
      logDir: '',
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
    const uploadResponse = await fetch(baseUrl + '/api/diagnostics', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${signAccessToken('viewer', 'viewer-observability')}`,
      },
      body: JSON.stringify({
        type: 'connection-diagnostic',
        schemaVersion: 2,
        browserSessionId: 'browser-summary-1',
        connectionAttemptId: 'attempt-summary-runtime-1',
        trigger: 'manual',
        reason: 'ice-failed',
        logs: ['line-1'],
      }),
    });
    assert.equal(uploadResponse.status, 202);

    const summaryResponse = await fetch(baseUrl + '/api/admin/observability/summary', {
      headers: {
        Authorization: `Bearer ${signAccessToken('admin', 'diag-admin')}`,
      },
    });
    const summary = await summaryResponse.json();
    assert.equal(summaryResponse.status, 200);
    assert.equal(summary.total, 1);
    assert.equal(summary.byDomain.viewer, 1);
    assert.equal(summary.byEvent['viewer.diagnostic_uploaded'], 1);

    const recentResponse = await fetch(baseUrl + '/api/admin/observability/recent?domain=viewer&limit=5', {
      headers: {
        Authorization: `Bearer ${signAccessToken('admin', 'diag-admin')}`,
      },
    });
    const recent = await recentResponse.json();
    assert.equal(recentResponse.status, 200);
    assert.equal(recent.items.length, 1);
    assert.equal(recent.items[0].domain, 'viewer');
    assert.equal(recent.items[0].event, 'diagnostic_uploaded');
    assert.equal(recent.items[0].correlation.browserSessionId, 'browser-summary-1');
    assert.equal(recent.items[0].correlation.connectionAttemptId, 'attempt-summary-runtime-1');
  } finally {
    await new Promise((resolve, reject) => runtime.server.close((err) => (err ? reject(err) : resolve())));
  }
});
