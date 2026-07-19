const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const test = require('node:test');
const express = require('express');
const proxyaddr = require('proxy-addr');
const authModule = require('../routes/auth');
const { TerminalMetrics } = require('../lib/terminal/metrics');
const { createServerApp } = require('../server');
const authRoutes = authModule;
const { createAuthRouter } = authModule;

process.env.JWT_SECRET = process.env.JWT_SECRET || '12345678';
process.env.VIEWER_ACCESS_PASSWORD = process.env.VIEWER_ACCESS_PASSWORD || 'test-viewer-password';
process.env.HOST_SHARED_SECRET = process.env.HOST_SHARED_SECRET || 'test-host-secret';
process.env.WRD_ENABLE_TERMINAL = '1';
process.env.WRD_TERMINAL_ADMIN_PASSWORD = 'test-terminal-admin-password';

async function withServer(runTest, options = {}) {
  const app = express();
  if (options.trustProxy !== undefined) app.set('trust proxy', options.trustProxy);
  if (options.remoteAddress) {
    app.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', {
        configurable: true,
        value: options.remoteAddress,
      });
      next();
    });
  }
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

const trustLoopbackProxy = proxyaddr.compile('loopback');

async function requestJson(baseUrl, route, body, headers = {}) {
  return fetch(baseUrl + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
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

test('route-specific auth limiters enforce viewer, host, and verify ceilings independently', async () => {
  await withServer(async (baseUrl) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      assert.equal((await requestJson(baseUrl, '/api/auth/login/viewer', {})).status, 400);
    }
    const limited = await requestJson(baseUrl, '/api/auth/login/viewer', {});
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: 'Too many requests' });
  });

  await withServer(async (baseUrl) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      assert.equal((await requestJson(baseUrl, '/api/auth/login/host', {})).status, 400);
    }
    assert.equal((await requestJson(baseUrl, '/api/auth/login/host', {})).status, 429);
  });

  await withServer(async (baseUrl) => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      assert.equal((await fetch(baseUrl + '/api/auth/verify')).status, 401);
    }
    assert.equal((await fetch(baseUrl + '/api/auth/verify')).status, 429);
  });
});

test('viewer attempts do not consume the five-request admin bucket', async () => {
  await withServer(async (baseUrl) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      assert.equal((await requestJson(baseUrl, '/api/auth/login/viewer', {})).status, 400);
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await requestJson(baseUrl, '/api/auth/login/admin', {
        password: 'wrong-password',
      })).status, 401);
    }
    const limited = await requestJson(baseUrl, '/api/auth/login/admin', {
      password: 'wrong-password',
    });
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: 'Too many requests' });
  });
});

test('production server trusts forwarded client IP only from loopback proxies', () => {
  const runtime = createServerApp({
    logger: { log() {}, info() {}, warn() {}, error() {} },
  });
  try {
    const trustProxy = runtime.app.get('trust proxy fn');
    assert.equal(trustProxy('127.0.0.1'), true);
    assert.equal(trustProxy('::1'), true);
    assert.equal(trustProxy('198.51.100.10'), false);
    assert.equal(trustProxy('10.0.0.10'), false);
  } finally {
    runtime.io.close();
  }
});

test('untrusted direct clients cannot choose an auth bucket with forwarded headers', async () => {
  await withServer(async (baseUrl) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await requestJson(baseUrl, '/api/auth/login/viewer', {}, {
        'x-forwarded-for': `203.0.113.${attempt + 1}`,
      });
      assert.equal(response.status, 400);
    }
    assert.equal((await requestJson(baseUrl, '/api/auth/login/viewer', {}, {
      'x-forwarded-for': '203.0.113.250',
    })).status, 429);
  }, {
    trustProxy: trustLoopbackProxy,
    remoteAddress: '198.51.100.10',
  });
});

test('trusted loopback proxies separate public clients while sharing one client bucket', async () => {
  await withServer(async (baseUrl) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      assert.equal((await requestJson(baseUrl, '/api/auth/login/viewer', {}, {
        'x-forwarded-for': '198.51.100.20',
      })).status, 400);
    }
    assert.equal((await requestJson(baseUrl, '/api/auth/login/viewer', {}, {
      'x-forwarded-for': '198.51.100.21',
    })).status, 400);
    assert.equal((await requestJson(baseUrl, '/api/auth/login/viewer', {}, {
      'x-forwarded-for': '198.51.100.20',
    })).status, 429);
  }, { trustProxy: trustLoopbackProxy });
});

test('admin login has a process-wide one-hundred-request ceiling across IPs', async () => {
  const terminalMetrics = new TerminalMetrics();
  await withServer(async (baseUrl) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await requestJson(
        baseUrl,
        '/api/auth/login/admin',
        { password: 'wrong-password' },
        { 'x-forwarded-for': `198.51.100.${Math.floor(attempt / 250) + 1}, 203.0.113.${(attempt % 250) + 1}` },
      );
      assert.equal(response.status, 401);
    }
    const limited = await requestJson(
      baseUrl,
      '/api/auth/login/admin',
      { password: 'wrong-password' },
      { 'x-forwarded-for': '192.0.2.250' },
    );
    assert.equal(limited.status, 429);
  }, { trustProxy: trustLoopbackProxy, terminalMetrics });

  assert.equal(terminalMetrics.snapshot().counters.auth_rejected, 101);
});

test('admin rate limiting records one bounded rejection metric per limited request', async () => {
  const terminalMetrics = new TerminalMetrics();
  await withServer(async (baseUrl) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await requestJson(baseUrl, '/api/auth/login/admin', {
        password: 'wrong-password-SECRET_VALUE',
      })).status, 401);
    }
    assert.equal((await requestJson(baseUrl, '/api/auth/login/admin', {
      password: 'wrong-password-SECRET_VALUE',
    })).status, 429);
  }, { terminalMetrics });

  const snapshot = terminalMetrics.snapshot();
  assert.equal(snapshot.counters.auth_rejected, 6);
  assert.equal(JSON.stringify(snapshot).includes('SECRET_VALUE'), false);
});

test('admin authentication records bounded success and rejection counters without secrets', async () => {
  const terminalMetrics = new TerminalMetrics();
  await withServer(async (baseUrl) => {
    assert.equal((await requestJson(baseUrl, '/api/auth/login/admin', {
      password: 'wrong-password-SECRET_VALUE',
    })).status, 401);
    assert.equal((await requestJson(baseUrl, '/api/auth/login/admin', {
      password: 'test-terminal-admin-password',
    })).status, 200);
  }, { terminalMetrics });

  const snapshot = terminalMetrics.snapshot();
  assert.equal(snapshot.counters.auth_rejected, 1);
  assert.equal(snapshot.counters.auth_success, 1);
  assert.equal(JSON.stringify(snapshot).includes('SECRET_VALUE'), false);
});
