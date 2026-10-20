const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const { createAuthRouter } = require('../routes/auth');
const { verifyAccessToken } = require('../lib/auth');

async function withAuth(viewerAccessPassword, run) {
  const config = { viewerAccessPassword, jwtSecret: 'synthetic-viewer-regression-secret' };
  const app = express();
  app.use(express.json());
  app.use('/api/auth', createAuthRouter({ config, configMode: 'exact' }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/auth`;
  const login = (password, alias = '/login') => fetch(base + alias, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  try { await run(login, base, config); }
  finally { await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); }
}

test('viewer checks suffix beyond bcrypt 72-byte boundary on both aliases', async () => {
  const expected = 'a'.repeat(72) + 'x';
  await withAuth(expected, async (login) => {
    for (const alias of ['/login', '/login/viewer']) {
      assert.equal((await login('a'.repeat(72) + 'y', alias)).status, 401);
      assert.equal((await login(expected, alias)).status, 200);
    }
  });
});

test('viewer compares full UTF-8 including multibyte characters across 72 bytes', async () => {
  const expected = 'a'.repeat(71) + '界x';
  await withAuth(expected, async (login) => {
    assert.equal((await login('a'.repeat(71) + '界y')).status, 401);
    assert.equal((await login('a'.repeat(71) + '世x')).status, 401);
    assert.equal((await login(expected)).status, 200);
  });
});

test('viewer preserves whitespace and Unicode normalization distinctions', async () => {
  await withAuth(' é ', async (login) => {
    for (const wrong of ['é', ' e\u0301 ', ' É ']) {
      assert.equal((await login(wrong)).status, 401);
    }
    assert.equal((await login(' é ')).status, 200);
  });
});

test('viewer preserves missing-password 400 and truthy String conversion', async () => {
  for (const [expected, value] of [['123', 123], ['true', true], ['[object Object]', {}], ['a,b', ['a', 'b']]]) {
    await withAuth(expected, async (login) => {
      assert.equal((await login(value)).status, 200);
      for (const missing of [undefined, null, false, 0, '']) {
        const response = await login(missing);
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: 'Password required' });
      }
    });
  }
});

test('viewer fails closed with missing, empty, or non-string configured password', async () => {
  for (const configValue of [undefined, null, '', 123, true, {}]) {
    await withAuth(configValue, async (login) => {
      const response = await login(String(configValue) || 'nonempty-attempt');
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'Invalid password' });
    });
  }
});

test('viewer aliases share 20 requests per 15 minutes and successful JWT remains compatible', async () => {
  await withAuth('synthetic-password', async (login, base, config) => {
    const response = await login('synthetic-password', '/login/viewer');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.role, 'viewer');
    assert.equal(body.expiresIn, '24h');
    const decoded = verifyAccessToken(body.token, config);
    assert.equal(decoded.role, 'viewer');
    assert.equal(decoded.sub, 'viewer-password-login');
    assert.equal(decoded.exp - decoded.iat, 24 * 60 * 60);
    const verification = await fetch(base + '/verify', { headers: { authorization: `Bearer ${body.token}` } });
    assert.deepEqual(await verification.json(), { valid: true, role: 'viewer' });
    assert.equal(response.headers.get('ratelimit-policy'), '20;w=900');
    for (let i = 1; i < 20; i++) {
      assert.equal((await login('wrong', i % 2 ? '/login' : '/login/viewer')).status, 401);
    }
    for (const alias of ['/login', '/login/viewer']) {
      const limited = await login('synthetic-password', alias);
      assert.equal(limited.status, 429);
      assert.deepEqual(await limited.json(), { error: 'Too many requests' });
    }
  });
});

test('viewer authentication never calls bcrypt computation', async () => {
  const bcrypt = require('bcryptjs');
  const originals = new Map();
  for (const method of ['hashSync', 'hash', 'compare', 'compareSync']) {
    originals.set(method, bcrypt[method]);
    bcrypt[method] = () => { throw new Error(`Unexpected bcrypt ${method}`); };
  }
  try {
    await withAuth('synthetic-password', async (login) => {
      assert.equal((await login('synthetic-password')).status, 200);
      assert.equal((await login('wrong')).status, 401);
    });
  } finally {
    for (const [method, original] of originals) bcrypt[method] = original;
  }
});
