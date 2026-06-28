const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const test = require('node:test');
const express = require('express');
const authRoutes = require('../routes/auth');

process.env.JWT_SECRET = process.env.JWT_SECRET || '12345678';
process.env.VIEWER_ACCESS_PASSWORD = process.env.VIEWER_ACCESS_PASSWORD || 'test-viewer-password';
process.env.HOST_SHARED_SECRET = process.env.HOST_SHARED_SECRET || 'test-host-secret';
process.env.WRD_ENABLE_TERMINAL = '1';
process.env.WRD_TERMINAL_ADMIN_PASSWORD = 'test-terminal-admin-password';

async function withServer(runTest) {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
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
