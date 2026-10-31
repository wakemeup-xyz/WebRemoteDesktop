'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { createViewerHeartbeatRegistry } = require('../lib/observability/viewer-heartbeat');
const prefix = 'WRD_SIGNAL_HEARTBEAT ';
function fixture(options = {}) {
  let time = 0;
  const lines = [];
  const engine = new EventEmitter();
  Object.assign(engine, { readyState: 'open', writeBuffer: [], transport: { name: 'websocket', writable: true } });
  const socket = new EventEmitter(); socket.conn = engine;
  const registry = createViewerHeartbeatRegistry({ now: () => time, wallNow: () => 1792200000000,
    logger: { log: line => lines.push(line) }, ...options });
  return { engine, socket, registry, lines, at: value => { time = value; }, data: () => JSON.parse(lines[0].slice(prefix.length)) };
}
test('actual registry observes heartbeat ages, owns exact callbacks and closes once', async () => {
  const f = fixture(); let productCalls = 0;
  const product = () => productCalls++;
  f.engine.on('packet', product);
  f.registry.attach(f.socket, () => true); f.registry.attach(f.socket, () => true);
  assert.equal(f.engine.listenerCount('packet'), 2);
  f.at(10); f.engine.emit('packetCreate', { type: 'ping', data: 'private-canary' });
  f.at(11); f.engine.emit('flush', [{ type: 'ping', data: 'private-canary' }]);
  f.at(20); f.engine.emit('packet', { type: 'pong', data: 'private-canary' });
  f.at(30); f.engine.emit('close', 'transport close', 'private-canary');
  await Promise.resolve(); f.engine.emit('close', 'ping timeout'); f.registry.stop();
  assert.equal(f.lines.length, 1);
  assert.deepEqual(f.data().ages, { pingCreatedMs: 20, pingInFlushMs: 19, pongReceivedMs: 10 });
  assert.deepEqual(f.data().counts, { pingCreated: 1, pingInFlush: 1, pongReceived: 1, messageIn: 0, messageCreated: 0, flush: 1 });
  assert.equal(productCalls, 1);
  assert.deepEqual(f.engine.listeners('packet'), [product]);
  for (const event of ['packetCreate', 'flush', 'close']) assert.equal(f.engine.listenerCount(event), 0);
  assert.equal(f.socket.listenerCount('disconnect'), 0);
  assert.ok(!f.lines[0].includes('private-canary'));
  assert.ok(Buffer.byteLength(f.lines[0]) <= 4120);
});

test('installed Engine sendPacket/flush/onPacket semantics without constructor, timers or network', async () => {
  const { Socket } = require('engine.io');
  const engine = Object.create(Socket.prototype); EventEmitter.call(engine);
  const order = []; let refreshes = 0;
  Object.assign(engine, { readyState: 'open', writeBuffer: [], packetsFn: [], sentCallbackFn: [],
    server: new EventEmitter(), pingTimeoutTimer: null,
    pingIntervalTimer: { refresh() { refreshes++; } },
    transport: { protocol: 4, name: 'websocket', writable: false,
      send(batch) { order.push('send'); assert.equal(batch[0].data, 'library-canary'); } } });
  engine.on('packetCreate', () => { order.push('create'); assert.equal(engine.writeBuffer.length, 0); });
  engine.on('flush', () => { order.push('flush'); assert.equal(engine.writeBuffer.length, 1); });
  const f = fixture(); f.socket.conn = engine; f.registry.attach(f.socket, () => true);
  engine.sendPacket('ping', 'library-canary');
  assert.deepEqual(order, ['create']); assert.equal(refreshes, 0);
  engine.transport.writable = true; engine.flush();
  assert.deepEqual(order, ['create', 'flush', 'send']);
  const timer = engine.pingIntervalTimer;
  engine.onPacket({ type: 'pong', data: 'library-canary' });
  assert.equal(refreshes, 1); assert.equal(engine.pingIntervalTimer, timer);
  engine.emit('close', 'ping timeout'); await Promise.resolve();
  assert.equal(refreshes, 1); assert.equal(f.data().counts.pongReceived, 1);
  assert.equal(f.data().counts.pingInFlush, 1); assert.ok(!f.lines[0].includes('library-canary'));
});

test('namespace first capture preserves immediate buffer and engine reason, replaced scope stays false', async () => {
  const f = fixture(); let current = f.socket;
  const replacement = new EventEmitter(); replacement.conn = new EventEmitter();
  f.socket.on('disconnect', () => { current = replacement; f.registry.attach(replacement, () => current === replacement); });
  f.engine.writeBuffer = [{ data: 'buffer-canary' }];
  f.registry.attach(f.socket, () => current === f.socket);
  const copied = f.engine.listeners('packetCreate')[0];
  f.at(10); f.socket.emit('disconnect', 'transport error');
  f.engine.writeBuffer = []; f.engine.emit('close', 'ping timeout');
  await Promise.resolve();
  assert.equal(f.data().transport.bufferLength, 1); assert.equal(f.data().source, 'engine');
  assert.equal(f.data().reason, 'ping'); assert.equal(f.data().current, false);
  copied({ type: 'ping' }); f.registry.stop(); await Promise.resolve();
  assert.equal(f.lines.length, 2);
  assert.equal(JSON.parse(f.lines[1].slice(prefix.length)).current, true);
  assert.equal(f.data().counts.pingCreated, 0);
});

test('terminal order, shutdown and already copied callbacks are close once', async () => {
  for (const order of ['engine-first', 'namespace-only', 'shutdown-queued', 'shutdown']) {
    const f = fixture(); f.registry.attach(f.socket);
    const copied = f.engine.listeners('close')[0];
    if (order === 'engine-first') { f.engine.emit('close', 'transport close'); f.socket.emit('disconnect', 'client namespace disconnect'); }
    if (order === 'namespace-only') f.socket.emit('disconnect', 'client namespace disconnect');
    if (order === 'shutdown-queued') f.socket.emit('disconnect', 'transport error');
    if (order.startsWith('shutdown')) f.registry.stop();
    await Promise.resolve(); f.registry.stop(); copied('ping timeout');
    assert.equal(f.lines.length, 1);
    assert.equal(f.data().current, null);
    assert.equal(f.engine.eventNames().length, 0);
    assert.equal(f.socket.eventNames().length, 0);
  }
});

test('capacity bounds retained recorders and message flood does not grow heartbeat ring', async () => {
  const f = fixture(); const sockets = [];
  for (let i = 0; i < 30; i++) {
    const s = new EventEmitter(); s.conn = new EventEmitter(); sockets.push(s);
    f.registry.attach(s, () => true);
  }
  assert.equal(f.lines.length, 22);
  assert.equal(sockets.filter(s => s.listenerCount('disconnect')).length, 8);
  assert.equal(f.data().coverage.state, 'capacity'); assert.equal(f.data().current, false);
  f.registry.stop();
  for (const s of sockets) { assert.equal(s.eventNames().length, 0); assert.equal(s.conn.eventNames().length, 0); }
  const flood = fixture(); flood.registry.attach(flood.socket, () => false);
  for (let i = 0; i < 1000000; i++) flood.engine.emit('packet', { type: 'message' });
  for (let i = 0; i < 100; i++) { flood.at(i); flood.engine.emit('packetCreate', { type: 'ping' }); }
  flood.registry.stop();
  const floodRows = flood.lines.map(line => JSON.parse(line.slice(prefix.length)));
  const floodClose = floodRows.at(-1);
  assert.equal(floodClose.event, 'viewer-heartbeat-close');
  assert.equal(floodClose.counts.messageIn, 1000000);
  assert.equal(floodClose.ring.length, 32); assert.equal(floodClose.ringDropped, 68);
  assert.equal(floodClose.ring[0].n, 69);
  assert.equal(floodRows.filter(row => row.event === 'viewer-heartbeat-snapshot').length, 1);
  assert.equal(floodRows.length, 2);
});

test('privacy canaries and invalid getters never escape safe projection; incomplete flush is explicit', async () => {
  const f = fixture({ runtimeSnapshot: () => ({ status: 'ok', ageMs: Infinity,
    eventLoop: { count: 121, last: NaN, max: 9999999999, p95: 'invalid', missedSampleCount: -1 }, secret: 'canary' }) });
  const forbidden = () => { throw Error('privacy-canary'); };
  for (const object of [f.socket, f.engine]) for (const key of ['id', 'request', 'handshake', 'auth', 'url']) {
    Object.defineProperty(object, key, { get: forbidden });
  }
  const packet = { type: 'ping' };
  for (const key of ['data', 'options']) Object.defineProperty(packet, key, { get: forbidden });
  f.registry.attach(f.socket, () => true); f.engine.emit('packetCreate', packet);
  const oversized = Array(65).fill({ type: 'message' });
  Object.defineProperty(oversized, '64', { get: forbidden });
  f.engine.emit('flush', oversized);
  f.engine.emit('flush', [{ get type() { throw Error('privacy-canary'); } }]);
  f.engine.emit('flush', 'privacy-canary');
  f.engine.transport.writable = 'privacy-canary'; f.engine.writeBuffer = Array(1000001);
  Object.defineProperty(f.engine.transport, 'name', { get: forbidden });
  f.at(9999999999); f.engine.emit('close', 'privacy-canary', { get message() { forbidden(); } });
  await Promise.resolve();
  const d = f.data(); assert.equal(d.reason, 'unknown'); assert.equal(d.coverage.valueInvalid, true);
  assert.equal(d.coverage.flushScanLimited, true); assert.equal(d.ages.pingCreatedMs, null);
  assert.equal(d.transport.writable, null); assert.equal(d.transport.bufferLength, null);
  assert.equal(d.transport.name, 'unknown'); assert.equal(d.node.count, null);
  assert.ok(!f.lines[0].includes('canary')); assert.deepEqual(Object.keys(d.ring[0]), ['t', 'n', 'k']);
});

test('invalid clocks, missing engine, failing logger and failing runtime snapshot clean up synchronously', async () => {
  let calls = 0;
  const f = fixture({ now: () => NaN, wallNow: () => Infinity,
    runtimeSnapshot() { throw Error('snapshot-canary'); }, logger: { log() { calls++; throw Error('logger-canary'); } } });
  delete f.socket.conn; f.registry.attach(f.socket); f.socket.emit('disconnect', {});
  f.registry.stop(); await Promise.resolve(); f.registry.stop();
  assert.equal(calls, 1); assert.equal(f.socket.listenerCount('disconnect'), 0);
  const missing = fixture(); delete missing.socket.conn; missing.registry.attach(missing.socket);
  missing.registry.stop(); assert.equal(missing.data().coverage.state, 'unavailable');
});

test('real runtime observer supplies only whitelisted lag projection and creates no observer-owned timer', () => {
  const { createRuntimeObserver } = require('../lib/observability/runtime');
  let time = 0; let callback; let timers = 0; let stopped = 0;
  const runtime = createRuntimeObserver({ now: () => time, sampleRss: () => 100,
    setTimer(cb) { timers++; callback = cb; return 1; }, clearTimer() { stopped++; } });
  runtime.start(); time = 4500; callback();
  const f = fixture({ runtimeSnapshot: runtime.snapshot }); f.registry.attach(f.socket);
  f.registry.stop(); assert.equal(timers, 2); assert.equal(stopped, 0);
  assert.deepEqual(f.data().node, { status: 'ok', ageMs: 0, count: 1, lastMs: 3500, maxMs: 3500, p95Ms: 3500, missed: 3 });
  assert.ok(!f.lines[0].includes('Rss')); runtime.stop();
});

test('actual server runtime.close and HTTP close/error stop heartbeat before runtime sampler, without listening', async t => {
  const setup = require('../lib/terminal/node-pty-setup');
  t.mock.method(setup, 'ensureNodePtySpawnHelperExecutable', () => 'offline-stub');
  // Avoid constructor probes and native WebRTC loading by injecting both terminal owners.
  const childProcess = require('node:child_process');
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
    t.mock.method(childProcess, key, () => { throw Error('child process forbidden'); });
  }
  const { createServerApp } = require('../server');
  const { createRuntimeContext } = require('../websocket/runtime-context');
  const { FakeSocket } = require('../websocket/signaling-test-fixture');
  const config = { jwtSecret: 'offline-fixture-secret', viewerAccessPassword: 'offline-fixture-viewer',
    hostSharedSecret: 'offline-fixture-host', corsOrigins: [], nodeEnv: 'test', logDir: '',
    terminalAuditLog: '', enableTerminal: false, enableDiagPersist: false };
  for (const mode of ['runtime', 'close', 'error']) {
    const order = []; const lines = [];
    const observer = { start() { throw Error('listener forbidden'); },
      stop() { order.push('runtime-stop'); }, snapshot() {
        assert.equal(order.includes('runtime-stop'), false); order.push('snapshot');
        return { status: 'ok', ageMs: 0.9, eventLoop: { count: 1, last: 3.9, max: 4.9, p95: 3.9, missedSampleCount: 0 } };
      } };
    const runtime = createServerApp({ config, runtimeObserver: observer, signalingRuntimeContext: createRuntimeContext(),
      allowSourceFallback: true, logger: { info() {}, warn() {}, log(line) {
        if (typeof line === 'string' && line.startsWith(prefix)) { order.push('heartbeat'); lines.push(line); }
      } }, terminal: { sessionManager: {}, webrtcGateway: {} } });
    assert.equal(runtime.server.listening, false);
    const viewer = Object.create(FakeSocket.prototype); EventEmitter.call(viewer);
    Object.assign(viewer, { id: 'wiring-viewer', userRole: 'viewer', user: { sub: 'fixture-viewer' },
      handshake: { auth: { role: 'viewer' }, headers: {} }, sent: [], conn: new EventEmitter() });
    // Invoke the handlers registered on the actual Socket.IO namespace; no client or listener.
    for (const connection of runtime.io.of('/').listeners('connection')) connection(viewer);
    assert.equal(viewer.conn.listenerCount('packet'), 1);
    if (mode === 'runtime') await runtime.close();
    else runtime.server.emit(mode, ...(mode === 'error' ? [new Error('offline-canary')] : []));
    assert.deepEqual(order, ['snapshot', 'heartbeat', 'runtime-stop']);
    assert.equal(viewer.conn.eventNames().length, 0);
    assert.equal(viewer.listeners('disconnect').length, 1); // Product handler is preserved.
    assert.equal(lines.length, 1); assert.equal(JSON.parse(lines[0].slice(prefix.length)).node.lastMs, 3);
    await runtime.close(); assert.equal(lines.length, 1); await Promise.resolve();
  }
});

test('actual diagnostic envelope budget enumerates fixed enums/null/booleans and maximum integer widths', () => {
  const max = 999999999;
  // Exercise serialization of the exact key set emitted by the module, expanding every
  // numeric leaf to its schema maximum. Enum/null/boolean alternatives are exhaustive.
  const f = fixture(); f.registry.attach(f.socket); f.registry.stop(); const actual = f.data();
  const base = { ...actual, wallMs: 9999999999999, durationMs: max,
    coverage: { ...actual.coverage, engine: false, flushScanLimited: false, valueInvalid: false, counterClipped: false },
    ages: Object.fromEntries(Object.keys(actual.ages).map(k => [k, max])),
    counts: Object.fromEntries(Object.keys(actual.counts).map(k => [k, max])),
    transport: { name: 'webtransport', writable: false, bufferLength: 1000000, state: 'opening' },
    node: { status: 'unavailable', ageMs: max, count: 120, lastMs: max, maxMs: max, p95Ms: max, missed: max },
    ringDropped: max, ring: Array.from({ length: 32 }, () => ({ t: max, n: max, k: 'pc' })) };
  let worst = 0;
  for (const source of ['engine', 'namespace', 'shutdown'])
    for (const reason of ['ping', 'transport-close', 'transport-error', 'server-disconnect', 'client-disconnect', 'server-shutdown', 'parse', 'forced', 'unknown'])
      for (const state of ['partial', 'unavailable', 'capacity'])
        for (const current of [true, false, null])
          for (const proof of [true, false]) {
            const data = { ...base, source, reason, current, proof, coverage: { ...base.coverage, state } };
            const bytes = Buffer.byteLength(JSON.stringify(data)); worst = Math.max(worst, bytes);
            assert.ok(bytes <= 4096); assert.ok(bytes + prefix.length <= 4120);
          }
  for (const choices of [
    { object: base.transport, key: 'name', values: ['websocket', 'polling', 'webtransport', 'unknown'] },
    { object: base.transport, key: 'state', values: ['opening', 'open', 'closing', 'closed', 'unknown'] },
    { object: base.node, key: 'status', values: ['ok', 'unavailable', 'error'] },
    { object: base.transport, key: 'writable', values: [true, false, null] },
  ]) for (const value of choices.values) {
    choices.object[choices.key] = value; assert.ok(Buffer.byteLength(JSON.stringify(base)) <= 4096);
  }
  for (const section of ['ages', 'counts', 'node', 'transport']) {
    for (const key of Object.keys(base[section])) if (typeof base[section][key] === 'number') {
      const value = base[section][key]; base[section][key] = null;
      assert.ok(Buffer.byteLength(JSON.stringify(base)) <= 4096); base[section][key] = value;
    }
  }
  assert.ok(worst < 2200);
  for (const kind of ['pc', 'pf', 'pr']) assert.ok(Buffer.byteLength(JSON.stringify({ t: max, n: max, k: kind })) <= 48);
});

test('observer callback before product callback still rechecks replaced map at finalization', async () => {
  const f = fixture(); let active = true;
  f.registry.attach(f.socket, () => active);
  f.socket.on('disconnect', () => { active = false; });
  f.socket.emit('disconnect', 'server namespace disconnect');
  await Promise.resolve(); assert.equal(f.data().current, false); assert.equal(f.data().source, 'namespace');
});

test('serialization failure emits fixed metadata once and released callbacks stay harmless', t => {
  const f = fixture(); f.registry.attach(f.socket);
  const callback = f.engine.listeners('packet')[0];
  t.mock.method(JSON, 'stringify', () => { throw Error('projection-canary'); });
  f.registry.stop(); callback({ type: 'pong' }); f.registry.stop();
  assert.equal(f.lines.length, 1); assert.equal(f.engine.eventNames().length, 0);
  assert.equal(f.lines[0], prefix + '{"v":1,"event":"viewer-heartbeat-close","coverage":{"state":"capacity"}}');
});

test('shutdown supersedes a queued engine close, duplicate Engine owners never enroll twice, no timer/send mutates', async t => {
  for (const key of ['setTimeout', 'setInterval']) t.mock.method(global, key, () => { throw Error('observer timer forbidden'); });
  const f = fixture();
  for (const key of ['sendPacket', 'flush', 'close', 'connect']) f.engine[key] = () => { throw Error('observer mutation forbidden'); };
  const transport = f.engine.transport; transport.send = () => { throw Error('observer send forbidden'); };
  const methods = ['sendPacket', 'flush', 'close', 'connect'].map(key => f.engine[key]);
  f.registry.attach(f.socket, () => true);
  const other = new EventEmitter(); other.conn = f.engine; f.registry.attach(other);
  assert.equal(f.engine.listenerCount('close'), 1);
  f.engine.emit('close', 'ping timeout'); f.registry.stop(); await Promise.resolve();
  assert.equal(f.lines.length, 1); assert.equal(f.data().source, 'shutdown'); assert.equal(f.data().reason, 'server-shutdown');
  assert.equal(f.engine.transport, transport);
  assert.deepEqual(['sendPacket', 'flush', 'close', 'connect'].map(key => f.engine[key]), methods);
});

test('shared production counter primitive saturates at the exact boundary without wrapping', () => {
  const { incrementBoundedCount } = require('../lib/observability/viewer-heartbeat');
  const coverage = { counterClipped: false };
  assert.equal(incrementBoundedCount(0, coverage), 1);
  assert.equal(incrementBoundedCount(999999998, coverage), 999999999);
  assert.equal(coverage.counterClipped, false);
  assert.equal(incrementBoundedCount(999999999, coverage), 999999999);
  assert.equal(coverage.counterClipped, true);
  assert.equal(incrementBoundedCount(999999999, coverage), 999999999);
});
