const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { signAccessToken } = require('../lib/auth');

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
  const child = spawn(process.execPath, ['signal-server/server.js'], {
    cwd: process.cwd(),
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
  await waitForHealthy(baseUrl);

  return {
    baseUrl,
    async closeServer() {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    },
    output,
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
    assert.equal(body.pool.poolId, 'default');
    assert.deepEqual(body.pool.sessions, []);
  } finally {
    await closeServer();
  }
});
