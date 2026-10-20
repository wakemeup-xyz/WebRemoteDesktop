'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createEntryObserver, bindEntryObserver, addBoundedCount, ROUTE_CLASSES } = require('../lib/observability/entry');
const { createStructuredLogger } = require('../lib/observability/logger');
const { createRecentEventStore } = require('../lib/observability/store');

function fixture(options = {}) {
  let time = 0; let tick; let timers = 0; let unrefs = 0; let clears = 0;
  const lines = []; const store = createRecentEventStore();
  const observer = createEntryObserver({ now: () => time, wallNow: () => 1792200000000 + (Number.isFinite(time) ? time : 0),
    setTimer(cb, ms) { assert.equal(ms, 60000); timers++; tick = cb; return { unref() { unrefs++; } }; },
    clearTimer() { clears++; }, structuredLogger: createStructuredLogger({ write: line => lines.push(line), now: () => new Date(1792200000000) }),
    recentEventStore: store, ...options });
  return { observer, store, lines, at(v) { time = v; }, tick() { tick(); },
    counts: () => ({ timers, unrefs, clears }), data: (i = -1) => JSON.parse(lines.at(i)).meta };
}
function request(f, method = 'GET', url = '/') {
  const req = new EventEmitter(); Object.assign(req, { method, url });
  const res = new EventEmitter(); res.statusCode = 200;
  f.observer.observeHttp(req, res);
  return { req, res, finish(status = 200) { res.statusCode = status; res.emit('finish'); } };
}

test('exact six route classes accept only fixed method/path and ignore private query and request fields', () => {
  const f = fixture(); f.observer.start();
  const allowed = [['POST', '/api/auth/login', 'viewer_login'], ['POST', '/api/auth/login/viewer', 'viewer_login'],
    ['GET', '/api/auth/verify', 'auth_verify'], ['POST', '/api/auth/viewer-admission', 'viewer_admission'],
    ['POST', '/api/diagnostics', 'diagnostics'], ['GET', '/', 'viewer_html'], ['HEAD', '/', 'viewer_html'],
    ['GET', '/index.html', 'viewer_html'], ['HEAD', '/index.html', 'viewer_html'],
    ['GET', '/viewer.html', 'viewer_html'], ['HEAD', '/viewer.html', 'viewer_html'], ['GET', '/api/viewer-bootstrap', 'viewer_bootstrap']];
  for (const [method, url] of allowed) {
    const req = new EventEmitter(); Object.assign(req, { method, url: url + '?private-canary=secret' });
    for (const key of ['headers', 'body', 'ip', 'socket', 'originalUrl', 'path']) Object.defineProperty(req, key, { get() { throw Error('private-canary'); } });
    const res = new EventEmitter(); res.statusCode = 200; f.observer.observeHttp(req, res); res.emit('finish');
  }
  for (const [method, url] of [['OPTIONS', '/'], ['POST', '/'], ['GET', '/health'], ['GET', '/api/status'],
    ['GET', '/api/terminal/bootstrap'], ['POST', '/api/auth/login/'], ['GET', '/API/auth/verify'],
    ['GET', '/%69ndex.html'], ['GET', '//'], ['GET', 'https://canary/index.html'], ['HEAD', '/api/viewer-bootstrap']]) {
    const r = request(f, method, url); assert.equal(r.res.listenerCount('finish'), 0);
  }
  f.at(60000); f.tick(); const d = f.data();
  assert.deepEqual(Object.keys(d.http), ROUTE_CLASSES);
  for (const category of ROUTE_CLASSES) assert.equal(d.http[category].completed, allowed.filter(a => a[2] === category).length);
  assert.ok(!f.lines[0].includes('canary')); assert.equal(d.vantage, 'origin'); assert.equal(d.window.empty, false);
  f.observer.stop();
});

test('finish/close/aborted races finalize once, remove owned listeners and preserve product handlers', () => {
  const f = fixture(); f.observer.start(); let calls = 0;
  for (const first of ['finish', 'close', 'aborted']) {
    const r = request(f); const product = () => calls++; r.res.on('close', product);
    f.at(10); (first === 'aborted' ? r.req : r.res).emit(first);
    r.res.emit('finish'); r.res.emit('close'); r.req.emit('aborted');
    assert.deepEqual(r.res.listeners('close'), [product]); assert.equal(r.res.listenerCount('finish'), 0); assert.equal(r.req.listenerCount('aborted'), 0);
  }
  f.at(60000); f.tick(); const row = f.data().http.viewer_html;
  assert.equal(row.started, 3); assert.equal(row.completed, 1); assert.equal(row.closedUnfinished, 1); assert.equal(row.aborted, 1);
  assert.equal(row.inflight, 0); assert.equal(row.duration.count, 3); assert.equal(calls, 4); f.observer.stop();
});

test('completion crosses windows; status families/subsets and exact latency bins stay fixed', () => {
  const f = fixture(); f.observer.start(); f.at(59990); const r = request(f); f.at(60000); f.tick();
  assert.equal(f.data().http.viewer_html.started, 1); assert.equal(f.data().http.viewer_html.inflight, 1);
  f.at(60001); r.finish(429); f.at(120000); f.tick();
  const row = f.data().http.viewer_html; assert.equal(row.started, 0); assert.equal(row.completed, 1); assert.equal(row.status['4xx'], 1); assert.equal(row.status.s429, 1);
  assert.equal(row.duration.le50, 1); assert.equal(row.duration.sumMs, 11);
  const statuses = [101, 200, 302, 401, 403, 429, 503, 0, '200'];
  const durations = [10, 50, 100, 500, 1000, 5000, 15000, 15001, 0];
  for (let i = 0; i < statuses.length; i++) { const start = 120000 + i * 20000; f.at(start); const q = request(f); f.at(start + durations[i]); q.finish(statuses[i]); }
  f.at(320000); f.tick(); const a = f.data().http.viewer_html;
  assert.deepEqual(a.status, { '1xx': 1, '2xx': 1, '3xx': 1, '4xx': 3, '5xx': 1, other: 2, s401: 1, s403: 1, s429: 1 });
  assert.deepEqual([a.duration.le10, a.duration.le50, a.duration.le100, a.duration.le500, a.duration.le1000, a.duration.le5000, a.duration.le15000, a.duration.gt15000], [2, 1, 1, 1, 1, 1, 1, 1]);
  f.observer.stop();
});

test('256 tracker cap, overflow coverage, age sweep and stop release all listeners without cancelling requests', () => {
  const f = fixture(); f.observer.start(); const pending = [];
  for (let i = 0; i < 260; i++) pending.push(request(f));
  assert.equal(pending.filter(q => q.res.listenerCount('finish')).length, 256);
  const snap = f.observer.snapshot(); assert.equal(snap.http.viewer_html.untracked, 4); assert.equal(snap.http.viewer_html.inflight, 256); assert.equal(snap.coverage.completionCoverage, false);
  f.at(59999); f.tick(); assert.equal(f.data().http.viewer_html.expiredUnfinished, 0);
  f.at(119999); f.tick(); assert.equal(f.data().http.viewer_html.expiredUnfinished, 256); assert.equal(f.data().http.viewer_html.inflight, 0);
  for (const q of pending) { assert.equal(q.req.eventNames().length, 0); assert.equal(q.res.eventNames().length, 0); q.finish(); }
  const r = request(f); f.observer.stop(); f.observer.stop(); f.tick(); r.finish();
  assert.equal(f.data().http.viewer_html.stoppedInflight, 1); assert.equal(f.data().window.final, true); assert.equal(f.counts().clears, 1);
});

test('single unref timer starts on listening, idle/delayed windows emit once and stop removes only owned listeners', () => {
  const f = fixture(); const server = new EventEmitter(); const engine = new EventEmitter(); let product = 0;
  const existing = () => product++; engine.on('connection_error', existing); server.on('error', existing);
  bindEntryObserver(server, engine, f.observer); assert.equal(f.counts().timers, 0);
  server.emit('listening'); server.emit('listening'); assert.deepEqual(f.counts(), { timers: 1, unrefs: 1, clears: 0 });
  f.at(180500); f.tick(); const d = f.data(); assert.equal(f.lines.length, 1); assert.equal(d.window.elapsedMs, 180500); assert.equal(d.window.missedWindows, 2); assert.equal(d.window.empty, true);
  assert.deepEqual(f.counts(), { timers: 2, unrefs: 2, clears: 0 });
  engine.emit('connection_error', { code: 1 }); server.emit('close'); server.emit('error', Error('private-canary')); f.observer.stop(); f.tick();
  assert.equal(f.lines.length, 2); assert.deepEqual(engine.listeners('connection_error'), [existing]);
  assert.equal(server.listenerCount('listening'), 0); assert.equal(server.listenerCount('close'), 0); assert.equal(server.listenerCount('error'), 1); assert.equal(product, 2);
  assert.equal(f.data().coverage.endedAt, f.data().window.end); assert.equal(f.data().engine['1'], 1);
});

test('namespace only counts enums; Engine errors read only numeric code with hostile getters and no coercion', () => {
  const f = fixture(); f.observer.start();
  for (const outcome of ['accepted', 'missing_auth', 'invalid_auth', 'private-canary', { toString() { throw Error(); } }]) f.observer.observeNamespaceOutcome(outcome);
  for (const code of [0, 1, 2, 3, 4, 5, 6, -1, '1', null, { valueOf() { throw Error(); } }]) {
    const error = { code }; for (const key of ['message', 'req', 'context', 'url']) Object.defineProperty(error, key, { get() { throw Error('private-canary'); } });
    f.observer.observeEngineError(error);
  }
  f.observer.observeEngineError({ get code() { throw Error('private-canary'); } });
  f.at(60000); f.tick(); const d = f.data(); assert.deepEqual(d.namespace, { accepted: 1, missing_auth: 1, invalid_auth: 1 });
  assert.deepEqual(d.engine, { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, other: 6 });
  assert.equal(d.coverage.collectionFailures, 1); assert.ok(!f.lines[0].includes('canary')); f.observer.stop();
});

test('backward/invalid/throwing monotonic clocks mark unknown; invalid starts cannot manufacture zero duration', () => {
  const f = fixture(); f.observer.start(); f.at(100); const r = request(f); f.at(90); r.finish();
  f.at(NaN); const q = request(f); f.at(60000); q.finish(); f.tick();
  let d = f.data(); assert.equal(d.http.viewer_html.duration.unknown, 2); assert.equal(d.http.viewer_html.duration.count, 0); assert.equal(d.window.elapsedMs, null); assert.equal(d.coverage.clockUnknown, true);
  f.at(120000); f.tick(); assert.equal(f.data().window.elapsedMs, 60000); f.observer.stop();
  const g = fixture({ now() { throw Error('clock-canary'); }, wallNow: () => Infinity }); g.observer.start(); request(g).finish(); g.tick(); d = g.data();
  assert.equal(d.http.viewer_html.duration.unknown, 1); assert.equal(d.window.start, null); assert.equal(d.window.elapsedMs, null); assert.ok(d.coverage.collectionFailures > 0); g.observer.stop();
});

test('counter primitive and durations saturate; worst-case real normalized envelope stays below 16KiB', () => {
  const coverage = { clipped: false }; assert.equal(addBoundedCount(999999998, 1, coverage), 999999999); assert.equal(coverage.clipped, false);
  assert.equal(addBoundedCount(999999999, 1, coverage), 999999999); assert.equal(coverage.clipped, true);
  const f = fixture(); f.observer.start(); const r = request(f); f.at(3600001); r.finish(); f.tick();
  const d = f.data(); assert.equal(d.http.viewer_html.duration.maxMs, 3600000); assert.equal(d.coverage.clipped, true);
  function widen(obj) { if (typeof obj === 'number') return 999999999; if (!obj || typeof obj !== 'object') return obj; return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, widen(v)])); }
  const lines = []; const logger = createStructuredLogger({ write: line => lines.push(line) }); logger.info({ domain: 'entry', event: 'entry_window', meta: widen(d) });
  assert.ok(Buffer.byteLength(lines[0]) < 16384); f.observer.stop();
});

test('real logger serialized sink and recent store share complete envelope; snapshots do not retain request references or mutate counters', () => {
  const f = fixture(); f.observer.start(); for (const [method, url] of [['POST', '/api/auth/login'], ['GET', '/api/auth/verify'], ['POST', '/api/auth/viewer-admission'], ['POST', '/api/diagnostics'], ['GET', '/'], ['GET', '/api/viewer-bootstrap']]) request(f, method, url).finish();
  const snapshot = f.observer.snapshot(); snapshot.http.viewer_html.completed = 500; assert.equal(f.observer.snapshot().http.viewer_html.completed, 1);
  assert.equal(f.lines.length, 0); f.at(60000); f.tick(); const event = JSON.parse(f.lines[0]); assert.deepEqual(f.store.recent()[0], event);
  for (const category of ROUTE_CLASSES) { assert.equal(event.meta.http[category].started, 1); assert.equal(event.meta.http[category].duration.count, 1); }
  assert.equal(event.meta.coverage.completionCoverage, true); assert.equal(event.meta.window.elapsedMs, 60000); assert.ok(Buffer.byteLength(f.lines[0]) < 16384);
  assert.ok(!JSON.stringify(snapshot).includes('listener')); f.observer.stop();
});

test('logger/store failures are isolated, reported next window without recursive writes; collection failure does not install partial listeners', () => {
  let logs = 0; let stores = 0; const outputs = [];
  const f = fixture({ structuredLogger: { info(event) { logs++; if (logs === 1) throw Error('sink-canary'); outputs.push(event); } }, recentEventStore: { append() { stores++; if (stores === 1) throw Error('store-canary'); } } });
  f.observer.start(); const req = new EventEmitter(); req.method = 'GET'; req.url = '/'; const res = new EventEmitter();
  res.on = () => { throw Error('listener-canary'); }; f.observer.observeHttp(req, res); assert.equal(req.listenerCount('aborted'), 0);
  f.at(60000); f.tick(); assert.equal(logs, 1); assert.equal(stores, 1); f.at(120000); f.tick();
  assert.equal(outputs[0].meta.coverage.loggerFailures, 1); assert.equal(outputs[0].meta.coverage.storeFailures, 1); assert.equal(outputs[0].meta.coverage.completionCoverage, false);
  f.observer.stop(); assert.equal(logs, 3); assert.equal(stores, 3);
});

test('bounded per-event work does not serialize/write, tracker flood retains at most 256, sum saturates in real rows', t => {
  const f = fixture(); f.observer.start();
  const stringify = JSON.stringify;
  t.mock.method(JSON, 'stringify', () => { throw Error('per-event serialization forbidden'); });
  // The path comparator must not scan arbitrary URL length for separators.
  t.mock.method(String.prototype, 'indexOf', () => { throw Error('unbounded URL scan forbidden'); });
  const hugeUrl = '/' + 'z'.repeat(1000000); request(f, 'GET', hugeUrl);
  for (let i = 0; i < 2000; i++) {
    f.observer.observeNamespaceOutcome('accepted');
    f.observer.observeEngineError({ code: 2 });
    const r = request(f); r.finish();
  }
  assert.equal(f.lines.length, 0); assert.equal(f.store.recent().length, 0); assert.equal(f.counts().timers, 1);
  assert.equal(f.observer.snapshot().http.viewer_html.completed, 2000);
  t.mock.restoreAll(); assert.equal(JSON.stringify, stringify);
  let time = 0;
  const g = fixture({ now: () => time }); g.observer.start();
  for (let i = 0; i < 300; i++) { const r = request(g); time += 3600000; r.finish(); }
  const d = g.observer.snapshot(); assert.equal(d.http.viewer_html.duration.sumMs, 999999999);
  assert.equal(d.http.viewer_html.duration.count, 300); assert.equal(d.coverage.clipped, true);
  f.observer.stop(); g.observer.stop();
});

test('expiry/stop ages are censored, expiry within 60–120 seconds leaves business emitters open and clock failures keep memory bounded', () => {
  const f = fixture(); f.observer.start(); f.at(1); const r = request(f);
  r.req.destroy = r.res.destroy = () => { throw Error('business request cancellation forbidden'); };
  f.at(60000); f.tick(); assert.equal(f.data().http.viewer_html.inflight, 1);
  f.at(120000); f.tick(); const d = f.data();
  assert.equal(d.http.viewer_html.expiredUnfinished, 1); assert.equal(d.http.viewer_html.duration.count, 0); assert.equal(d.http.viewer_html.duration.unknown, 0);
  r.finish(); f.observer.stop();
  const g = fixture({ now: () => NaN }); g.observer.start(); const records = Array.from({ length: 300 }, () => request(g)); g.tick();
  assert.equal(g.observer.snapshot().http.viewer_html.inflight, 256); assert.equal(g.observer.snapshot().http.viewer_html.untracked, 0); // reset in emitted window
  assert.equal(g.data().http.viewer_html.untracked, 44); g.observer.stop();
  assert.equal(records.filter(record => record.req.eventNames().length || record.res.eventNames().length).length, 0);
});

test('pre-start snapshot has fixed keys, copied finalized callbacks are inert and coverage end is stable after stop', () => {
  const f = fixture(); const before = f.observer.snapshot();
  assert.equal(before.window.start, null); assert.equal(before.coverage.startedAt, null); assert.equal(before.coverage.endedAt, null);
  f.observer.start(); f.at(100); const r = request(f); const copied = r.res.listeners('finish')[0]; r.finish();
  f.at(90); copied(); f.at(60000); f.tick(); assert.equal(f.data().coverage.clockUnknown, false); assert.equal(f.data().http.viewer_html.completed, 1);
  f.observer.stop(); const endedAt = f.data().coverage.endedAt; f.at(120000);
  assert.equal(f.observer.snapshot().coverage.endedAt, endedAt); assert.equal(f.lines.length, 2);
});

test('hostile HTTP getters and injected Engine observer failure are isolated without raw error projection', () => {
  const f = fixture(); const server = new EventEmitter(); const engine = new EventEmitter(); bindEntryObserver(server, engine, f.observer);
  server.emit('listening'); const req = new EventEmitter(); Object.defineProperty(req, 'method', { get() { throw Error('private-method-canary'); } });
  f.observer.observeHttp(req, new EventEmitter()); const r = request(f);
  Object.defineProperty(r.res, 'statusCode', { get() { throw Error('private-status-canary'); } }); r.res.emit('finish');
  const product = () => {}; engine.on('connection_error', product); f.observer.observeEngineError = () => { throw Error('private-observer-canary'); };
  assert.doesNotThrow(() => engine.emit('connection_error', {})); f.at(60000); f.tick();
  assert.equal(f.data().coverage.collectionFailures, 2); assert.equal(f.data().http.viewer_html.status.other, 1); assert.ok(!f.lines[0].includes('canary'));
  server.emit('close'); assert.deepEqual(engine.listeners('connection_error'), [product]);
});
