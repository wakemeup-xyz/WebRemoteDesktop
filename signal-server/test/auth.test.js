const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const authRoutes = require('../routes/auth');

process.env.JWT_SECRET = process.env.JWT_SECRET || '12345678';
process.env.VIEWER_ACCESS_PASSWORD = process.env.VIEWER_ACCESS_PASSWORD || 'test-viewer-password';
process.env.HOST_SHARED_SECRET = process.env.HOST_SHARED_SECRET || 'test-host-secret';

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

test('viewer login succeeds with configured password', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-viewer-password' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.role, 'viewer');
    assert.equal(typeof body.token, 'string');
  });
});

test('viewer login rejects wrong password', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + '/api/auth/login/viewer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    assert.equal(response.status, 401);
  });
});

test('host login requires matching shared secret', async () => {
  await withServer(async (baseUrl) => {
    const ok = await fetch(baseUrl + '/api/auth/login/host', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'test-host-secret' }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.role, 'host');

    const bad = await fetch(baseUrl + '/api/auth/login/host', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'bad-secret' }),
    });
    assert.equal(bad.status, 401);
  });
});

test('verify endpoint rejects missing token and accepts viewer token', async () => {
  await withServer(async (baseUrl) => {
    const login = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-viewer-password' }),
    });
    const body = await login.json();

    const missing = await fetch(baseUrl + '/api/auth/verify');
    assert.equal(missing.status, 401);

    const verify = await fetch(baseUrl + '/api/auth/verify', {
      headers: { authorization: 'Bearer ' + body.token },
    });
    assert.equal(verify.status, 200);
    const verified = await verify.json();
    assert.equal(verified.valid, true);
    assert.equal(verified.role, 'viewer');
  });
});
