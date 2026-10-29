const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// This is the distribution copied by build-web-client.js, not a transport policy model.
const bundlePath = path.join(__dirname, '../../signal-server/node_modules/socket.io/client-dist/socket.io.js');
function fixture({ allowPolling = true, diagnostic = () => {} } = {}) {
  let now = 0; let timerId = 0;
  const timers = new Map(); const websockets = []; const requests = []; const recoveries = []; const warnings = [];
  const setTimeout = (callback, delay = 0) => { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; };
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback();
    }
    now = end;
  }
  class WebSocket {
    constructor() { this.readyState = 0; this.sent = []; websockets.push(this); }
    close() { this.readyState = 3; this.onclose?.({}); }
    send(data) { this.sent.push(data); }
  }
  class XMLHttpRequest {
    constructor() { this.withCredentials = false; this.readyState = 0; }
    open(method) { this.method = method; }
    setRequestHeader() {}
    send(body) { this.body = body; requests.push(this); }
    abort() { this.aborted = true; }
    respond(data) { this.status = 200; this.responseText = data; this.readyState = 4; this.onreadystatechange?.(); }
    getResponseHeader() { return 'text/plain'; }
  }
  const context = {
    console: { log() {}, error() {}, warn(...args) { warnings.push(args); } },
    setTimeout, clearTimeout: id => timers.delete(id), setInterval: setTimeout, clearInterval: id => timers.delete(id),
    WebSocket, XMLHttpRequest, performance: { now: () => now },
    location: { protocol: 'https:', hostname: 'offline.invalid', port: '', host: 'offline.invalid', origin: 'https://offline.invalid' },
    navigator: { userAgent: 'offline' }, document: { readyState: 'loading', addEventListener() {}, getElementById() { return null; } },
    Auth: { getToken: () => 'fixture-auth' }, Diagnostic: { autoSendFailure: diagnostic },
    localStorage: { getItem() { return null; }, setItem() {} }, sessionStorage: { getItem() { return null; }, setItem() {} },
  };
  context.window = context; context.self = context;
  vm.createContext(context);
  for (const filename of [bundlePath, path.join(__dirname, 'runtime-diagnostic.js'), path.join(__dirname, 'webrtc.js')]) {
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
  const rtc = context.WebRTC;
  rtc.scheduleSignalingRecovery = reason => recoveries.push(reason);
  rtc.resolveViewerSessionId = () => 'fixture-session';
  const options = rtc.buildSignalingSocketOptions({ token: 'fixture-auth', allowPolling });
  // Deterministic existing Manager backoff; never add a product retry timer.
  const socket = context.io('https://offline.invalid', { ...options, autoConnect: false, randomizationFactor: 0, reconnectionDelay: 1000 });
  const handlers = new Map(); const on = socket.on;
  socket.on = function(event, callback) { if (!handlers.has(event)) handlers.set(event, callback); return on.call(this, event, callback); };
  rtc.socket = socket; rtc.setupSocketListeners();
  const observations = [];
  socket.on('connect_error', () => observations.push({ at: now, manager: socket.io._readyState,
    engine: socket.io.engine.readyState, transport: socket.io.engine.transport.name, active: socket.active }));
  socket.connect();
  return { rtc, socket, context, handlers, advance, websockets, requests, recoveries, observations, warnings,
    now: value => { now = value; }, dispose: () => socket.disconnect() };
}

test('actual browser Socket.IO 4.8.3 stalled WS timeout changes the existing next retry to polling', () => {
  assert.match(fs.readFileSync(bundlePath, 'utf8'), /Socket.IO v4\.8\.3/);
  const f = fixture(); const manager = f.socket.io; const oldEngine = manager.engine;
  const auth = JSON.stringify(f.socket.auth); const originalOrder = manager.opts.transports;
  assert.equal(typeof originalOrder[0], 'function');
  assert.equal(originalOrder[1].prototype.name, 'polling');
  f.advance(4999); assert.equal(f.websockets.length, 1); assert.equal(f.requests.length, 0);
  f.advance(1);
  assert.deepEqual(f.observations[0], { at: 5000, manager: 'closed', engine: 'opening', transport: 'websocket', active: true });
  assert.equal(oldEngine.readyState, 'closed'); assert.equal(f.websockets[0].readyState, 3);
  assert.notEqual(manager.opts.transports, originalOrder);
  assert.deepEqual(Array.from(manager.opts.transports), ['polling', 'websocket']);
  assert.deepEqual(Array.from(f.rtc.buildSignalingSocketOptions({ allowPolling: false }).transports), ['websocket']);
  f.advance(1000);
  assert.equal(f.socket.io, manager); assert.notEqual(manager.engine, oldEngine);
  assert.equal(manager.engine.transport.name, 'polling'); assert.equal(f.requests.length, 1);
  assert.equal(f.websockets.length, 1); assert.equal(manager._timeout, 5000);
  assert.equal(JSON.stringify(f.socket.auth), auth); assert.equal(f.websockets[0].sent.length, 0);
  f.advance(4999); assert.equal(f.observations.length, 1);
  f.advance(1); assert.equal(f.observations.length, 2); assert.equal(manager.engine.readyState, 'closed');
  f.dispose();
});

test('polling fallback expires and restores websocket-first for later retries', () => {
  const f = fixture();
  f.advance(5000);
  assert.equal(f.rtc._signalingSession.preferPolling, true);
  assert.deepEqual(Array.from(f.rtc.resolveSignalingTransports()), ['polling', 'websocket']);
  f.advance(f.rtc.signalingPollingFallbackTtlMs - 1);
  assert.equal(f.rtc._signalingSession.preferPolling, true);
  f.advance(1);
  assert.equal(f.rtc._signalingSession.preferPolling, false);
  assert.deepEqual(Array.from(f.rtc.resolveSignalingTransports()), ['websocket', 'polling']);
  assert.deepEqual(Array.from(f.socket.io.opts.transports), ['websocket', 'polling']);
  f.dispose();
});

test('a successful websocket connection clears the temporary polling preference', () => {
  const f = fixture();
  f.advance(5000);
  assert.equal(f.rtc._signalingSession.preferPolling, true);
  f.socket.io.engine.transport.name = 'websocket';
  assert.equal(f.rtc.noteSignalingTransportConnected(f.socket), true);
  assert.equal(f.rtc._signalingSession.preferPolling, false);
  assert.deepEqual(Array.from(f.socket.io.opts.transports), ['websocket', 'polling']);
  f.dispose();
});

test('an Engine.IO polling-to-websocket upgrade clears the temporary preference', () => {
  const f = fixture();
  f.advance(5000);
  let upgrade = null; let removed = false;
  const engine = { transport: { name: 'polling' }, on(event, callback) { if (event === 'upgrade') upgrade = callback; },
    off(event, callback) { removed = event === 'upgrade' && callback === upgrade; } };
  const manager = { engine, opts: { transports: ['polling', 'websocket'] } };
  const socket = { io: manager };
  f.rtc.socket = socket;
  assert.equal(f.rtc.noteSignalingTransportConnected(socket), true);
  assert.equal(f.rtc._signalingSession.preferPolling, true);
  engine.transport.name = 'websocket';
  upgrade();
  assert.equal(f.rtc._signalingSession.preferPolling, false);
  assert.deepEqual(Array.from(manager.opts.transports), ['websocket', 'polling']);
  assert.equal(removed, true);
  f.dispose();
});

test('resetting the signaling session retires a stale Engine upgrade listener', () => {
  const f = fixture();
  f.advance(5000);
  let upgrade = null; let removed = false;
  const engine = { transport: { name: 'polling' }, on(event, callback) { if (event === 'upgrade') upgrade = callback; },
    off(event, callback) { removed = event === 'upgrade' && callback === upgrade; } };
  const manager = { engine, opts: { transports: ['polling', 'websocket'] } };
  const socket = { io: manager };
  f.rtc.socket = socket;
  f.rtc.noteSignalingTransportConnected(socket);
  const oldSession = f.rtc._signalingSession;
  f.rtc.resetSignalingSession();
  assert.equal(removed, true);
  engine.transport.name = 'websocket';
  upgrade();
  assert.equal(oldSession.preferPolling, true);
  assert.equal(f.rtc._signalingSession.preferPolling, false);
  f.dispose();
});

test('actual hard WS error falls through to polling within the original Engine and budget', () => {
  const f = fixture(); const engine = f.socket.io.engine;
  f.advance(200); f.websockets[0].onerror({ message: 'CANARY_PRIVATE' });
  assert.equal(f.socket.io.engine, engine); assert.equal(engine.transport.name, 'polling');
  assert.equal(f.requests.length, 1); assert.equal(f.rtc._signalingSession.preferPolling, false);
  f.advance(4799); assert.equal(f.observations.length, 0);
  f.advance(1); assert.equal(f.observations.length, 1);
  assert.equal(f.rtc.getSignalingFailureSnapshot().fallbackSelected, false);
  assert.equal(f.rtc.getSignalingFailureSnapshot().transport, 'polling'); f.dispose();
});

test('actual WS-only Manager retries remain WS-only after a stall', () => {
  const f = fixture({ allowPolling: false }); f.advance(6000);
  assert.equal(f.websockets.length, 2); assert.equal(f.requests.length, 0);
  assert.equal(f.socket.io.engine.transport.name, 'websocket');
  assert.equal(f.rtc.getSignalingFailureSnapshot().fallbackSelected, false);
  assert.deepEqual(Array.from(f.rtc.resolveSignalingTransports({ allowPolling: false })), ['websocket']); f.dispose();
});

const handshake = '0{"sid":"offline-engine","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}';
test('next existing retry completes real polling handshake with one unchanged namespace admission', async () => {
  const f = fixture(); const originalSocket = f.socket; const manager = f.socket.io;
  f.rtc._deferPeerUntilConfig = true;
  for (const method of ['renderPortSearchStatus', 'bindCurrentConnectionAttempt', 'replayMediaActivityIntent', 'handleSignalingRecoveryConnected']) f.rtc[method] = () => {};
  f.rtc.ensureDesktopSessionState = () => null;
  f.advance(6000); f.requests[0].respond(handshake);
  await Promise.resolve(); f.advance(0);
  const posts = f.requests.filter(request => request.method === 'POST');
  assert.equal(posts.length, 1); assert.ok(posts[0].body.startsWith('40'));
  assert.deepEqual(JSON.parse(posts[0].body.slice(2)), JSON.parse(JSON.stringify(originalSocket.auth)));
  const poll = f.requests.filter(request => request.method === 'GET').at(-1);
  poll.respond('40{"sid":"offline-namespace"}');
  await Promise.resolve(); f.advance(0);
  assert.equal(originalSocket.connected, true); assert.equal(originalSocket.io, manager);
  assert.equal(f.websockets.length, 1); assert.equal(f.rtc._signalingSession.preferPolling, true);
  assert.equal(f.rtc.getSignalingFailureSnapshot().scope, 'last-connect-error'); f.dispose();
});

test('actual open Engine auth rejection is classified safely and never selects fallback', async () => {
  for (const [message, classification] of [['Authentication required', 'auth-required'], ['Invalid token', 'auth-invalid'], ['CANARY_PRIVATE', 'unknown']]) {
    const f = fixture(); const ws = f.websockets[0];
    ws.onopen(); ws.onmessage({ data: handshake }); await Promise.resolve(); f.advance(0);
    assert.equal(f.socket.io.engine.readyState, 'open');
    ws.onmessage({ data: '44' + JSON.stringify({ message, data: { url: 'CANARY_URL' } }) });
    await Promise.resolve(); f.advance(0);
    const failure = f.rtc.getSignalingFailureSnapshot();
    assert.equal(failure.failureClass, classification); assert.equal(failure.engineState, 'closed');
    assert.equal(failure.fallbackSelected, false); assert.equal(f.rtc._signalingSession.preferPolling, false);
    assert.equal(JSON.stringify(failure).includes('CANARY'), false); f.dispose();
  }
});

test('owned timeout eligibility is exact, safe for option getters, and idempotent', () => {
  const negatives = [
    socket => { socket.connected = true; }, socket => { socket.subs = undefined; },
    socket => { socket.io.engine.readyState = 'open'; }, socket => { Object.defineProperty(socket.io.engine.transport, 'name', { value: 'unknown' }); },
    socket => { socket.io.opts.transports = ['websocket']; }, socket => { socket.io.opts.transports = ['polling', 'unknown']; },
    socket => { Object.defineProperty(socket.io.opts, 'transports', { get() { throw Error('CANARY'); } }); },
    socket => { socket.io.opts.transports = [function Unknown() {}]; },
    socket => { Object.freeze(socket.io.opts); },
    socket => { socket.io.opts.transports = [Object.defineProperty(function Hostile() {}, 'prototype', { value: Object.defineProperty({}, 'name', { get() { throw Error('CANARY'); } }) })]; },
    socket => { Object.defineProperty(socket, 'active', { value: null }); },
  ];
  for (const mutate of negatives) {
    const f = fixture(); mutate(f.socket);
    assert.doesNotThrow(() => f.handlers.get('connect_error')({ message: 'timeout' }));
    assert.equal(f.rtc._signalingSession.preferPolling, false); assert.equal(f.recoveries.length, 1); f.dispose();
  }
  const f = fixture(); const handler = f.handlers.get('connect_error');
  for (const error of [{ message: 'Timeout' }, { type: 'TransportError', message: 'CANARY' }, { get message() { throw Error('CANARY'); } }]) {
    handler(error); assert.equal(f.rtc._signalingSession.preferPolling, false);
  }
  handler({ message: 'timeout' }); handler({ message: 'timeout' });
  assert.equal(f.rtc._signalingSession.preferPolling, true); assert.equal(f.rtc.getSignalingFailureSnapshot().fallbackSelected, true);
  f.dispose();
});

test('session and Manager ownership reject stale callbacks, recreation inherits preference, age uses monotonic bounds', () => {
  const f = fixture(); f.advance(5000);
  const session = f.rtc._signalingSession; const handler = f.handlers.get('connect_error');
  const first = f.rtc.getSignalingFailureSnapshot();
  assert.equal(Object.isFrozen(first), true); assert.equal(Object.isFrozen(session.failure), true);
  f.now(7000); assert.equal(f.rtc.getSignalingFailureSnapshot().ageMs, 2000);
  for (const invalid of [4999, NaN, Infinity, 3605001]) { f.now(invalid); assert.equal(f.rtc.getSignalingFailureSnapshot().ageMs, null); }
  f.now(8000); assert.equal(f.rtc.getSignalingFailureSnapshot().ageMs, 3000);
  f.rtc.connectionAttemptSequence++; assert.equal(f.rtc._signalingSession, session);
  const savedFailure = session.failure;
  const replacement = f.rtc.createSignalingSocket(true);
  assert.notEqual(replacement, f.socket); assert.equal(replacement.io.engine.transport.name, 'polling');
  assert.equal(f.rtc._signalingSession, session); handler({ message: 'timeout' });
  assert.equal(session.failure, savedFailure); assert.equal(first.ageMs, 0);
  const replacementManager = replacement.io; replacement.io = {};
  f.rtc.recordSignalingFailure({ message: 'timeout' }, replacement, replacementManager, session);
  assert.equal(session.failure, savedFailure); replacement.io = replacementManager;
  const last = f.rtc.getSignalingFailureSnapshot(); f.rtc.resetSignalingSession(); handler({ message: 'timeout' });
  assert.equal(f.rtc.getSignalingFailureSnapshot(), null); assert.equal(last.failureClass, 'timeout');
  assert.deepEqual(Array.from(f.rtc.resolveSignalingTransports()), ['websocket', 'polling']);
  replacement.disconnect(); f.dispose();
});

test('diagnostic synchronous and asynchronous failures cannot interrupt recovery or leak raw errors', async () => {
  for (const diagnostic of [() => { throw Error('CANARY'); }, () => Promise.reject(Error('CANARY')), () => undefined]) {
    const f = fixture({ diagnostic }); f.advance(5000); await Promise.resolve(); await Promise.resolve();
    assert.equal(f.recoveries.length, 1); assert.equal(f.rtc.getSignalingFailureSnapshot().failureClass, 'timeout');
    assert.deepEqual(f.warnings, [['[RECOVERY] Signaling connect error:', 'timeout']]); f.dispose();
  }
});

test('real core shared cooldown suppresses recapture while latest safe failure remains readable', async () => {
  const f = fixture(); const captured = [];
  delete f.context.Diagnostic;
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'diagnostic-core.js'), 'utf8'), f.context);
  f.context.Diagnostic.sendConnectionDiagnostic = payload => { captured.push(payload); return Promise.resolve(false); };
  f.context.Diagnostic.autoSendFailure('pc-failed');
  assert.equal(captured.length, 1);
  f.advance(5000); await Promise.resolve();
  assert.equal(captured.length, 1); assert.equal(f.recoveries.length, 1);
  assert.equal(f.rtc.getSignalingFailureSnapshot().failureClass, 'timeout');
  const manual = f.context.Diagnostic.buildConnectionDiagnostic({ reason: 'manual' });
  assert.equal(manual.startup.signalingFailure.failureClass, 'timeout');
  assert.equal(captured[0].startup.signalingFailure, null, 'earlier capture stays immutable'); f.dispose();
});

test('unavailable capture clock remains unknown without losing safe evidence', () => {
  const f = fixture(); f.context.performance.now = () => { throw Error('CANARY'); };
  f.advance(5000); assert.equal(f.rtc.getSignalingFailureSnapshot().ageMs, null);
  f.context.performance.now = () => 7000;
  assert.equal(f.rtc.getSignalingFailureSnapshot().ageMs, null);
  assert.equal(f.rtc.getSignalingFailureSnapshot().failureClass, 'timeout'); f.dispose();
});

test('safe snapshot and next retry selection precede cooldown diagnostic and existing recovery', () => {
  const events = []; let f;
  f = fixture({ diagnostic: reason => {
    events.push(['diagnostic', reason]);
    assert.equal(f.rtc.getSignalingFailureSnapshot().fallbackSelected, true);
    assert.deepEqual(Array.from(f.socket.io.opts.transports), ['polling', 'websocket']);
  } });
  f.rtc.scheduleSignalingRecovery = reason => events.push(['recovery', reason]);
  f.advance(5000);
  assert.deepEqual(events, [['diagnostic', 'signal-connect-error'], ['recovery', 'signal-connect-error']]); f.dispose();
});

test('same Socket retained across a new session or changed Manager rejects the retired listener owner', () => {
  const f = fixture(); const handler = f.handlers.get('connect_error');
  const originalManager = f.socket.io; const originalSession = f.rtc._signalingSession;
  f.socket.io = {};
  handler({ message: 'timeout' });
  assert.equal(originalSession.failure, null); assert.equal(f.recoveries.length, 0);
  f.socket.io = originalManager;
  f.rtc.resetSignalingSession(); handler({ message: 'timeout' });
  assert.equal(f.rtc._signalingSession.preferPolling, false); assert.equal(f.rtc.getSignalingFailureSnapshot(), null);
  assert.equal(f.recoveries.length, 0); f.dispose();
});
