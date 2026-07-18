const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const test = require('node:test');
const express = require('express');
const authModule = require('../routes/auth');
const authRoutes = authModule;
const { createAuthRouter } = authModule;

process.env.JWT_SECRET = process.env.JWT_SECRET || '12345678';
process.env.VIEWER_ACCESS_PASSWORD = process.env.VIEWER_ACCESS_PASSWORD || 'test-viewer-password';
process.env.HOST_SHARED_SECRET = process.env.HOST_SHARED_SECRET || 'test-host-secret';
process.env.WRD_ENABLE_TERMINAL = '1';
process.env.WRD_TERMINAL_ADMIN_PASSWORD = 'test-terminal-admin-password';

async function withServer(runTest, options = {}) {
  const app = express();
  app.use(express.json());
  const router = options.router
    || (typeof createAuthRouter === 'function'
      ? createAuthRouter(options)
      : authRoutes);
  app.use('/api/auth', router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await runTest('http://127.0.0.1:' + port);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

test('/api/auth/login/admin returns an admin token for the configured password', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + '/api/auth/login/admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-terminal-admin-password' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.role, 'admin');
    assert.equal(typeof body.token, 'string');
    const decoded = jwt.decode(body.token);
    assert.equal(decoded.exp - decoded.iat, 7200);
  });
});

test('/api/auth/login/admin rejects the wrong password', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + '/api/auth/login/admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    assert.equal(response.status, 401);
  });
});

test('/api/auth/login/admin emits audit events for success and rejection outcomes', async () => {
  const events = [];
  const terminalAudit = {
    info(event, meta = {}) {
      events.push({ level: 'info', event, meta });
    },
    warn(event, meta = {}) {
      events.push({ level: 'warn', event, meta });
    },
    error(event, meta = {}) {
      events.push({ level: 'error', event, meta });
    },
  };

  await withServer(async (baseUrl) => {
    const success = await fetch(baseUrl + '/api/auth/login/admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-terminal-admin-password' }),
    });
    assert.equal(success.status, 200);

    const rejected = await fetch(baseUrl + '/api/auth/login/admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    assert.equal(rejected.status, 401);
  }, {
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
    },
    terminalAudit,
  });

  assert.equal(events.some((entry) => entry.event === 'terminal_admin_authorized'), true);
  assert.equal(events.some((entry) => entry.event === 'terminal_admin_auth_failed'), true);
});

test('/api/auth/login/admin emits audit events when terminal login is disabled or misconfigured', async () => {
  const disabledEvents = [];
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + '/api/auth/login/admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'anything' }),
    });
    assert.equal(response.status, 403);
  }, {
    config: {
      enableTerminal: false,
      terminalAdminPassword: 'test-terminal-admin-password',
    },
    terminalAudit: {
      info(event, meta = {}) {
        disabledEvents.push({ event, meta });
      },
      warn(event, meta = {}) {
        disabledEvents.push({ event, meta });
      },
      error(event, meta = {}) {
        disabledEvents.push({ event, meta });
      },
    },
  });
  assert.equal(disabledEvents.some((entry) => entry.event === 'terminal_admin_auth_disabled'), true);

  const misconfiguredEvents = [];
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + '/api/auth/login/admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'anything' }),
    });
    assert.equal(response.status, 500);
  }, {
    config: {
      enableTerminal: true,
      terminalAdminPassword: '',
    },
    terminalAudit: {
      info(event, meta = {}) {
        misconfiguredEvents.push({ event, meta });
      },
      warn(event, meta = {}) {
        misconfiguredEvents.push({ event, meta });
      },
      error(event, meta = {}) {
        misconfiguredEvents.push({ event, meta });
      },
    },
  });
  assert.equal(misconfiguredEvents.some((entry) => entry.event === 'terminal_admin_auth_misconfigured'), true);
});
