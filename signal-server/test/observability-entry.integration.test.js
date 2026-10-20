'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createEntryObserver } = require('../lib/observability/entry');
const { createStructuredLogger } = require('../lib/observability/logger');
const { createRecentEventStore } = require('../lib/observability/store');
const { setupSignaling, createRuntimeContext } = require('../websocket/signaling');
const { makeIo } = require('../websocket/signaling-test-fixture');

const config = { jwtSecret: 'offline-entry-fixture-secret', viewerAccessPassword: 'offline-entry-fixture-viewer',
  hostSharedSecret: 'offline-entry-fixture-host', corsOrigins: ['https://allowed.example.test'], nodeEnv: 'test', logDir: '',
  terminalAuditLog: '', enableTerminal: false, enableDiagPersist: false };
function observers() {
  const lines = []; const store = createRecentEventStore(); let time = 0; let callback; let clears = 0;
  const logger = createStructuredLogger({ write: line => lines.push(line) });
  const entry = createEntryObserver({ structuredLogger: logger, recentEventStore: store,
    now: () => time, wallNow: () => 1792200000000 + time,
    setTimer(cb) { callback = cb; return { unref() {} }; }, clearTimer() { clears++; } });
  return { entry, store, logger, lines, tick() { time += 60000; callback(); }, clears: () => clears };
}

test('namespace authentication records exactly one safe outcome and preserves next/errors/token role even if observer throws', () => {
  for (const throws of [false, true]) {
    const io = makeIo(createRuntimeContext()); const outcomes = [];
    setupSignaling(io, { runtimeContext: createRuntimeContext(), logger: { info() {}, warn() {} }, config,
      verifyAccessToken: value => value === 'host-good' ? { role: 'host', sub: 'offline-host' } : value === 'viewer-good' ? { role: 'viewer', sub: 'offline-viewer' } : null,
      observeNamespaceOutcome(outcome) { outcomes.push(outcome); if (throws) throw Error('private-observer-canary'); } });
    const cases = [
      [{}, 'missing_auth', 'Authentication required'], [{ token: 'bad' }, 'invalid_auth', 'Invalid token'],
      [{ token: 'host-good', role: 'viewer', inputProtocolVersion: '2' }, 'accepted', undefined],
      [{ token: 'viewer-good', role: 'relay-viewer' }, 'accepted', undefined],
    ];
    for (const [auth, expected, message] of cases) {
      const socket = { handshake: { auth } }; const next = [];
      io.middleware(socket, error => next.push(error));
      assert.equal(next.length, 1); assert.equal(next[0]?.message, message); assert.equal(outcomes.at(-1), expected);
      if (auth.token === 'host-good') { assert.equal(socket.userRole, 'host'); assert.equal(socket.inputProtocolVersion, 2); }
      if (auth.token === 'viewer-good') assert.equal(socket.userRole, 'relay-viewer');
      if (message) assert.equal(socket.user, undefined);
    }
    assert.deepEqual(outcomes, ['missing_auth', 'invalid_auth', 'accepted', 'accepted']);
  }
});

async function appFixture(t, f) {
  const setup = require('../lib/terminal/node-pty-setup');
  t.mock.method(setup, 'ensureNodePtySpawnHelperExecutable', () => 'offline-stub');
  const childProcess = require('node:child_process');
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) t.mock.method(childProcess, key, () => { throw Error('child process forbidden'); });
  const { createServerApp } = require('../server');
  const runtime = createServerApp({ config, entryObserver: f.entry, structuredLogger: f.logger, recentEventStore: f.store,
    signalingRuntimeContext: createRuntimeContext(), allowSourceFallback: true,
    runtimeObserver: { start() {}, stop() {}, snapshot() { return {}; } },
    logger: { log() {}, info() {}, warn() {}, error() {} }, terminal: { sessionManager: {}, webrtcGateway: {} } });
  return runtime;
}

test('actual app middleware sees malformed JSON/CORS/auth/rate limiting and preserves static response', async t => {
  const f = observers(); const runtime = await appFixture(t, f);
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  runtime.app.set('env', 'test');
  t.after(async () => { await runtime.close(); await new Promise(resolve => runtime.io.close(resolve)); });
  const post = (route, body, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const invalidJson = await post('/api/auth/login?password=private-query-canary', '{');
  assert.equal(invalidJson.status, 400); await invalidJson.text();
  const deniedCors = await post('/api/auth/login', '{}', { origin: 'https://denied.example.test' });
  assert.equal(deniedCors.status, 500); await deniedCors.text();
  for (let i = 0; i < 20; i++) { const r = await post('/api/auth/login', '{"password":"private-body-canary"}'); assert.equal(r.status, 401); await r.text(); }
  const limited = await post('/api/auth/login/viewer', '{"password":"private-body-canary"}'); assert.equal(limited.status, 429); assert.deepEqual(await limited.json(), { error: 'Too many requests' });
  const verify = await fetch(base + '/api/auth/verify'); assert.equal(verify.status, 401); await verify.text();
  const admission = await post('/api/auth/viewer-admission', '{}'); assert.equal(admission.status, 401); await admission.text();
  const diag = await post('/api/diagnostics', '{}'); assert.equal(diag.status, 401); await diag.text();
  const html = await fetch(base + '/'); assert.equal(html.status, 200); assert.match(await html.text(), /<!doctype html>/i);
  assert.match(html.headers.get('cache-control'), /no-cache/); assert.ok(html.headers.get('x-content-type-options'));
  const head = await fetch(base + '/viewer.html', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  const bootstrap = await fetch(base + '/api/viewer-bootstrap'); assert.equal(bootstrap.status, 401); await bootstrap.text();
  for (const route of ['/health', '/api/status']) { const r = await fetch(base + route); assert.equal(r.status, 200); await r.text(); }
  const options = await fetch(base + '/api/auth/login', { method: 'OPTIONS' }); assert.equal(options.status, 204); await options.text();
  f.tick(); const entry = JSON.parse(f.lines.find(line => JSON.parse(line).event === 'entry_window'));
  assert.deepEqual(entry, f.store.recent({ domain: 'entry' })[0]);
  assert.equal(entry.meta.http.viewer_login.started, 23); assert.equal(entry.meta.http.viewer_login.completed, 23);
  assert.equal(entry.meta.http.viewer_login.status.s401, 20); assert.equal(entry.meta.http.viewer_login.status.s429, 1);
  assert.equal(entry.meta.http.viewer_login.status['5xx'], 1); assert.equal(entry.meta.http.viewer_login.status['4xx'], 22);
  for (const category of ['auth_verify', 'viewer_admission', 'diagnostics', 'viewer_bootstrap']) assert.equal(entry.meta.http[category].completed, 1);
  assert.equal(entry.meta.http.viewer_html.completed, 2); assert.equal(entry.meta.coverage.completionCoverage, true);
  assert.ok(!JSON.stringify(entry).includes('canary')); assert.ok(Buffer.byteLength(JSON.stringify(entry)) < 16384);
});

test('actual app isolates injected HTTP observer error and runtime close/server close/error finalizes once without listening or probes', async t => {
  for (const mode of ['runtime', 'close', 'error']) {
    const f = observers(); const runtime = await appFixture(t, f);
    assert.equal(runtime.server.listening, false); assert.equal(f.lines.length, 0);
    runtime.server.emit('listening'); const req = new EventEmitter(); Object.assign(req, { method: 'GET', url: '/' });
    const res = new EventEmitter(); f.entry.observeHttp(req, res);
    runtime.io.engine.emit('connection_error', { code: 3 });
    if (mode === 'runtime') await runtime.close(); else runtime.server.emit(mode, ...(mode === 'error' ? [Error('private-error-canary')] : []));
    await runtime.close(); assert.equal(f.lines.length, 1); assert.equal(f.clears(), 1);
    const data = JSON.parse(f.lines[0]).meta; assert.equal(data.window.final, true); assert.equal(data.http.viewer_html.stoppedInflight, 1);
    assert.equal(data.http.viewer_html.duration.count, 0); assert.equal(data.engine['3'], 1);
    assert.equal(req.eventNames().length, 0); assert.equal(res.eventNames().length, 0); assert.equal(runtime.io.engine.listenerCount('connection_error'), 0);
  }
  const f = observers(); const runtime = await appFixture(t, f);
  f.entry.observeHttp = () => { throw Error('observer-canary'); };
  // Invoke the real first app middleware directly; product next exceptions propagate once.
  const middleware = runtime.app._router.stack.find(layer => layer.handle.length === 3 && layer.name === '<anonymous>').handle;
  let nextCalls = 0; const sentinel = Error('product-next');
  assert.throws(() => middleware({}, {}, () => { nextCalls++; throw sentinel; }), error => error === sentinel);
  assert.equal(nextCalls, 1); await runtime.close();
});
