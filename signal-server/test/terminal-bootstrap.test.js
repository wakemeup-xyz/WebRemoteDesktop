const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { signAccessToken } = require('../lib/auth');
const { createTerminalSessionManager } = require('../lib/terminal/session-manager');
const { TerminalMetrics } = require('../lib/terminal/metrics');
const { createServerApp } = require('../server');

process.env.JWT_SECRET = process.env.JWT_SECRET || '12345678';
process.env.VIEWER_ACCESS_PASSWORD = process.env.VIEWER_ACCESS_PASSWORD || 'test-viewer-password';
process.env.HOST_SHARED_SECRET = process.env.HOST_SHARED_SECRET || 'test-host-secret';

async function getFreePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

async function waitForHealthy(baseUrl, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(baseUrl + '/health');
      if (response.ok) {
        return;
      }
    } catch (_err) {
      // Keep polling until the child server is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server_failed_to_start');
}

async function startServer() {
  const port = await getFreePort();
  const env = {
    ...process.env,
    PORT: String(port),
    JWT_SECRET: process.env.JWT_SECRET || '12345678',
    VIEWER_ACCESS_PASSWORD: process.env.VIEWER_ACCESS_PASSWORD || 'test-viewer-password',
    HOST_SHARED_SECRET: process.env.HOST_SHARED_SECRET || 'test-host-secret',
    WRD_ENABLE_TERMINAL: '1',
    WRD_TERMINAL_ADMIN_PASSWORD: 'test-terminal-admin-password',
    WRD_TERMINAL_SOFT_WARN_SESSION_COUNT: '3',
  };
  const serverPath = path.join(__dirname, '..', 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const childExit = new Promise((_, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(`server_exited_before_health code=${code} signal=${signal || ''}`));
    });
  });
  try {
    await Promise.race([waitForHealthy(baseUrl), childExit]);
  } catch (error) {
    if (child.exitCode == null && child.signalCode == null) {
      child.kill('SIGTERM');
    }
    throw new Error(`${error.message}\n${output}`);
  }

  return {
    baseUrl,
    async closeServer() {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    },
    output,
  };
}

function createFakePty() {
  let dataHandler = null;
  return {
    onData(handler) {
      dataHandler = handler;
    },
    onExit() {},
    write() {},
    resize() {},
    kill() {},
    emitData(data) {
      dataHandler?.(data);
    },
  };
}

test('/api/terminal/bootstrap rejects viewer tokens', async () => {
  const { baseUrl, closeServer } = await startServer();
  try {
    const response = await fetch(baseUrl + '/api/terminal/bootstrap', {
      headers: {
        Authorization: `Bearer ${signAccessToken('viewer', 'viewer-bootstrap-test')}`,
      },
    });
    assert.equal(response.status, 403);
  } finally {
    await closeServer();
  }
});

test('/api/terminal/bootstrap returns terminal pool metadata for admin tokens', async () => {
  const { baseUrl, closeServer } = await startServer();
  try {
    const loginResponse = await fetch(baseUrl + '/api/auth/login/admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-terminal-admin-password' }),
    });
    assert.equal(loginResponse.status, 200);
    const loginBody = await loginResponse.json();

    const response = await fetch(baseUrl + '/api/terminal/bootstrap', {
      headers: { Authorization: `Bearer ${loginBody.token}` },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.enabled, true);
    assert.equal(body.softWarnSessionCount, 3);
    assert.equal(body.allowPolling, false);
    assert.equal(body.pool.poolId, 'default');
    assert.deepEqual(body.pool.sessions, []);
  } finally {
    await closeServer();
  }
});

test('/api/terminal/bootstrap returns the live shared pool snapshot after a session exists', async () => {
  const pty = createFakePty();
  const sessionManager = createTerminalSessionManager({
    ptyFactory: () => pty,
    logger: { log() {}, info() {}, warn() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/tmp',
      terminalSoftWarnSessionCount: 3,
      terminalIdleTimeoutMs: 0,
      terminalStartupTimeoutMs: 10000,
      terminalAuditLog: '',
      terminalRecordIo: false,
    },
  });
  const config = {
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
      enableDiagPersist: false,
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/tmp',
      terminalSoftWarnSessionCount: 3,
      terminalIdleTimeoutMs: 0,
      terminalStartupTimeoutMs: 10000,
      terminalAuditLog: '',
      terminalRecordIo: false,
      terminalAllowPolling: true,
  };
  assert.throws(() => {
    const conflictingRuntime = createServerApp({
      config,
      terminal: { sessionManager },
      terminalMetrics: new TerminalMetrics(),
      logger: { log() {}, info() {}, warn() {}, error() {} },
    });
    conflictingRuntime.io.close();
  }, /metrics instance/i);

  const runtime = createServerApp({
    config,
    terminal: {
      sessionManager,
    },
    logger: { log() {}, info() {}, warn() {}, error() {} },
  });
  assert.equal(runtime.terminalMetrics, sessionManager.metrics);
  assert.equal(runtime.terminal.metrics, sessionManager.metrics);
  await new Promise((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  const { port } = runtime.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const created = runtime.terminal.sessionManager.createSession({
      clientId: 'bootstrap-browser',
      cols: 80,
      rows: 24,
      title: 'Shared shell',
    });
    pty.emitData('ready');

    const response = await fetch(baseUrl + '/api/terminal/bootstrap', {
      headers: { Authorization: `Bearer ${signAccessToken('admin', 'bootstrap-live-snapshot')}` },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.pool.sessions.length, 1);
    assert.equal(body.pool.sessions[0].sessionId, created.sessionId);
    assert.equal(body.pool.sessions[0].title, 'Shared shell');
    assert.equal(body.allowPolling, true);

    const viewerMetricsResponse = await fetch(baseUrl + '/api/admin/terminal/metrics', {
      headers: { Authorization: `Bearer ${signAccessToken('viewer', 'metrics-viewer')}` },
    });
    assert.equal(viewerMetricsResponse.status, 403);

    const metricsResponse = await fetch(baseUrl + '/api/admin/terminal/metrics', {
      headers: { Authorization: `Bearer ${signAccessToken('admin', 'metrics-admin')}` },
    });
    const metricsBody = await metricsResponse.json();
    assert.equal(metricsResponse.status, 200);
    assert.equal(metricsBody.metrics.counters.session_created, 1);
    assert.equal(metricsBody.pool.sessions[0].sessionId, created.sessionId);
    runtime.terminal.sessionManager.closeSession(created.sessionId, {
      clientId: 'bootstrap-browser',
    });
  } finally {
    await new Promise((resolve, reject) => runtime.server.close((err) => (err ? reject(err) : resolve())));
  }
});
