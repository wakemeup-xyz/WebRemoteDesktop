const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture() {
  let now = 0; let next = 0;
  const timers = new Map(); const store = new Map();
  const context = { console, AbortController, TextDecoder, Uint8Array,
    performance: { now: () => now },
    setTimeout(fn, ms) { const id = ++next; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    localStorage: { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value) },
    WebRTC: { socket: { connected: false } },
    location: { origin: 'http://fixture' }, screen: { width: 1440, height: 900 },
  };
  context.sessionStorage = context.localStorage;
  context.window = context; context.globalThis = context;
  vm.createContext(context);
  for (const name of ['runtime-diagnostic.js', 'bounded-request.js', 'diagnostic-core.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, name), 'utf8'), context);
  }
  const d = context.Diagnostic;
  const advance = async ms => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.fn();
    await flush();
  };
  return { context, d, timers, advance, elapse: ms => { now += ms; }, now: () => now };
}
function socketMock(f, handler) {
  const pending = new Map(); const listeners = new Set(); const emissions = [];
  const socket = { connected: true,
    on(event, fn) { if (event === 'disconnect') listeners.add(fn); },
    off(event, fn) { listeners.delete(fn); },
    disconnect() { socket.connected = false; for (const fn of [...listeners]) fn(); },
    timeout(ms) { assert.ok(ms <= 2000); return { emit(event, payload, callback) {
      let timer;
      const ack = (...args) => { f.context.clearTimeout(timer); pending.delete(ack); callback(...args); };
      timer = f.context.setTimeout(() => ack(new Error('timeout')), ms);
      pending.set(ack, timer); emissions.push({ event, payload, ack });
      handler?.(payload, ack, socket);
    } }; },
  };
  return Object.assign(socket, { pending, listeners, emissions });
}
const receipt = payload => ({ accepted: true, diagnosticId: payload.diagnosticId, eventIdHashes: [] });
function response(data, status = 200) {
  const chunk = Buffer.from(JSON.stringify(data)); let read = false;
  return { ok: status >= 200 && status < 300, status, body: { getReader: () => ({
    read: async () => read ? { done: true } : (read = true, { done: false, value: chunk }), cancel() {},
  }) } };
}

test('synchronous error-first receipt coalesces same ID and confirms actual producer 32hex scope hashes', async () => {
  const f = fixture(); let drained = false;
  f.context.LatencyMonitor = { takeClosedScopeSummaries: () => ({ summaries: drained ? [] : (drained = true, [{ endedAtMs: 0, snapshot: null }]) }) };
  const payload = f.d.buildConnectionDiagnostic();
  assert.match(payload.scopeEnded.events[0].eventIdHash, /^[a-f0-9]{32}$/);
  const socket = socketMock(f, (p, ack) => ack(null, { ...receipt(p), eventIdHashes: p.scopeEnded.events.map(e => e.eventIdHash) }));
  f.context.WebRTC.socket = socket;
  const first = f.d.sendConnectionDiagnostic(payload); const second = f.d.sendConnectionDiagnostic(payload);
  assert.equal(first, second); assert.equal(await first, true);
  assert.equal(socket.emissions.length, 1); assert.equal(socket.pending.size, 0);
  assert.equal(f.d.getPendingDiagnostics().length, 0); assert.equal(f.timers.size, 0);
});

test('reject, mismatched/empty IDs and malformed receipt hashes retain pending and fall back exactly once', async () => {
  const invalid = [null, { accepted: false }, { accepted: true, diagnosticId: '' },
    { accepted: true, diagnosticId: 'other' },
    { accepted: true, eventIdHashes: null }, { accepted: true, eventIdHashes: ['Z'.repeat(32)] },
    { accepted: true, eventIdHashes: ['a'.repeat(15)] }, { accepted: true, eventIdHashes: ['a'.repeat(65)] },
    { accepted: true, eventIdHashes: Array(5).fill('a'.repeat(32)) }];
  for (const value of invalid) {
    const f = fixture(); let calls = 0;
    f.context.fetch = async () => { calls++; return response({ accepted: false }, 202); };
    f.context.WebRTC.socket = socketMock(f, (p, ack) => ack(null,
      value && { diagnosticId: p.diagnosticId, eventIdHashes: [], ...value }));
    assert.equal(await f.d.sendConnectionDiagnostic(f.d.buildConnectionDiagnostic()), false);
    assert.equal(calls, 1); assert.equal(f.d.getPendingDiagnostics().length, 1);
    assert.equal(f.timers.size, 0);
  }
});

test('fallback freezes one prepared body and never recaptures or acknowledges foreign scope hashes', async () => {
  const f = fixture(); let socketPayload; let calls = 0; let acked;
  const prepare = f.d._runtimeBuilder.prepareReplay;
  f.d._runtimeBuilder.prepareReplay = p => { calls++; return prepare(p); };
  f.d._runtimeBuilder.acknowledge = ids => { acked = [...ids]; };
  f.context.WebRTC.socket = socketMock(f, (p, ack) => { socketPayload = p; ack(new Error('rejected')); });
  f.context.fetch = async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body), JSON.parse(JSON.stringify(socketPayload)));
    assert.equal(Object.isFrozen(socketPayload), true);
    return response({ ...receipt(socketPayload), eventIdHashes: ['b'.repeat(32)] });
  };
  const payload = f.d.buildConnectionDiagnostic();
  assert.equal(await f.d.sendConnectionDiagnostic(payload), true);
  // No second preparation occurs during fallback.
  assert.equal(calls, 1); assert.deepEqual(acked, []);
});

test('HTTP 202 confirms only matching durable receipts; rejection, non2xx and absent reader fail', async () => {
  for (const mode of ['202', 'rejected202', '500', 'missing', 'mismatch', 'ok']) {
    const f = fixture();
    f.context.fetch = async (_url, init) => {
      const p = JSON.parse(init.body);
      if (mode === 'missing') return { ok: true, status: 200, json: async () => receipt(p) };
      return response(mode === 'mismatch' ? { ...receipt(p), diagnosticId: 'other' }
        : mode === 'rejected202' ? { ...receipt(p), accepted: false } : receipt(p),
      mode === '202' || mode === 'rejected202' ? 202 : mode === '500' ? 500 : 200);
    };
    assert.equal(await f.d.sendConnectionDiagnostic(f.d.buildConnectionDiagnostic()), mode === 'ok' || mode === '202', mode);
    assert.equal(f.d.getPendingDiagnostics().length, mode === 'ok' || mode === '202' ? 0 : 1);
  }
});

test('Socket timeout releases ACK entry, late ACK cannot confirm, total body deadline is 8000ms', async () => {
  const f = fixture(); let calls = 0; let signal; let cancelled = 0;
  const socket = socketMock(f); f.context.WebRTC.socket = socket;
  f.context.fetch = async (_url, init) => { calls++; signal = init.signal; return { ok: true, status: 200,
    body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: () => { cancelled++; } }) } }; };
  const promise = f.d.sendConnectionDiagnostic(f.d.buildConnectionDiagnostic());
  await f.advance(2000);
  assert.equal(socket.pending.size, 0); assert.equal(calls, 1);
  socket.emissions[0].ack(null, receipt(socket.emissions[0].payload));
  await f.advance(6000);
  assert.equal(await promise, false); assert.equal(signal.aborted, true); assert.ok(cancelled > 0);
  assert.equal(f.d.getPendingDiagnostics().length, 1); assert.equal(f.timers.size, 0);
  assert.equal(f.d._diagnosticInFlight.size, 0);
});

for (const elapsedMs of [1999, 2000, 2500]) {
  test(`Socket ACK at ${elapsedMs}ms obeys monotonic stage deadline before any timer callback runs`, async () => {
    const f = fixture(); f.elapse(100); // A stage deadline is relative to this operation, not page boot.
    let calls = 0; let finishHttp; const acknowledged = [];
    const acknowledge = f.d._runtimeBuilder.acknowledge;
    f.d._runtimeBuilder.acknowledge = ids => { acknowledged.push([...ids]); acknowledge(ids); };
    f.context.LatencyMonitor = { takeClosedScopeSummaries: () => ({ summaries: [{ endedAtMs: 100, snapshot: null }] }) };
    const payload = f.d.buildConnectionDiagnostic();
    const socket = socketMock(f); f.context.WebRTC.socket = socket;
    f.context.fetch = async (_url, init) => {
      calls++;
      assert.deepEqual(JSON.parse(init.body), JSON.parse(JSON.stringify(socket.emissions[0].payload)));
      return new Promise(resolve => { finishHttp = resolve; });
    };
    const promise = f.d.sendConnectionDiagnostic(payload);
    f.elapse(elapsedMs); // Deliberately defer both watchdog and Socket.IO timeout callbacks.
    const emission = socket.emissions[0];
    const validReceipt = { ...receipt(emission.payload), eventIdHashes: emission.payload.scopeEnded.events.map(e => e.eventIdHash) };
    emission.ack(null, validReceipt); await flush();
    if (elapsedMs < 2000) {
      assert.equal(await promise, true); assert.equal(calls, 0);
      assert.deepEqual(acknowledged, [Array.from(validReceipt.eventIdHashes)]);
      assert.equal(f.d.getPendingDiagnostics().length, 0);
    } else {
      assert.equal(calls, 1); assert.deepEqual(acknowledged, []);
      assert.deepEqual(Array.from(f.d.getPendingDiagnostics(), p => p.diagnosticId), [payload.diagnosticId]);
      emission.ack(null, validReceipt); await f.advance(0);
      assert.equal(calls, 1); assert.deepEqual(acknowledged, []);
      finishHttp(response({ accepted: false, diagnosticId: null, eventIdHashes: [] }, 202));
      assert.equal(await promise, false);
      assert.equal(f.d.getPendingDiagnostics().length, 1); assert.deepEqual(acknowledged, []);
    }
    assert.equal(f.d._diagnosticInFlight.size, 0); assert.equal(f.timers.size, 0);
  });
}

test('disconnect and thrown emit each fall back once', async () => {
  for (const mode of ['disconnect', 'throw']) {
    const f = fixture(); let calls = 0;
    f.context.fetch = async (_url, init) => { calls++; return response(receipt(JSON.parse(init.body))); };
    f.context.WebRTC.socket = socketMock(f, (_p, _ack, socket) => { if (mode === 'throw') throw Error('fixture'); else socket.disconnect(); });
    assert.equal(await f.d.sendConnectionDiagnostic(f.d.buildConnectionDiagnostic()), true); assert.equal(calls, 1);
    // Library timeout owns its ACK cleanup even after disconnect/throw fallback.
    await f.advance(2000); assert.equal(f.context.WebRTC.socket.pending.size, 0); assert.equal(f.timers.size, 0);
  }
});

test('at most ten distinct in-flight operations, capacity failure is false, slots release', async () => {
  const f = fixture(); const socket = socketMock(f); f.context.WebRTC.socket = socket;
  const promises = Array.from({ length: 10 }, () => f.d.sendConnectionDiagnostic(f.d.buildConnectionDiagnostic()));
  assert.equal(await f.d.sendConnectionDiagnostic(f.d.buildConnectionDiagnostic()), false);
  assert.equal(socket.emissions.length, 10); assert.equal(f.d.getPendingDiagnostics().length, 10);
  for (const e of socket.emissions) e.ack(null, receipt(e.payload));
  assert.deepEqual(await Promise.all(promises), Array(10).fill(true));
  socketMock(f); assert.equal(f.timers.size, 0);
  const last = f.d.sendConnectionDiagnostic(f.d.buildConnectionDiagnostic());
  const e = socket.emissions.at(-1); e.ack(null, receipt(e.payload)); assert.equal(await last, true);
});

test('replay uses explicit socket, max two and preserves concurrent enqueue with synchronous ACK', async () => {
  const f = fixture(); f.d.autoSendCooldownMs = 0;
  const original = Array.from({ length: 3 }, () => f.d.buildConnectionDiagnostic());
  original.forEach(p => f.d.enqueuePendingDiagnostic(p));
  const added = f.d.buildConnectionDiagnostic(); let n = 0;
  const socket = socketMock(f, (p, ack) => { if (!n++) f.d.enqueuePendingDiagnostic(added); ack(null, receipt(p)); });
  assert.equal(await f.d.replayPendingDiagnostics(socket), 2);
  assert.deepEqual(Array.from(f.d.getPendingDiagnostics(), p => p.diagnosticId), [original[2].diagnosticId, added.diagnosticId]);
});

test('manual wording never claims local durability on storage failure and autosends stay silent', async () => {
  const f = fixture(); f.d.browserSessionId = 'fixture'; const alerts = []; f.context.alert = value => alerts.push(value);
  f.context.localStorage.setItem = () => { throw Error('disabled'); };
  f.context.document = { addEventListener() {}, getElementById() { return null; } };
  f.context.navigator = {}; f.context.setInterval = () => {};
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'diagnostic.js'), 'utf8'), f.context);
  await f.d.sendLogs(); assert.equal(alerts.at(-1), '未获服务端保存确认，请稍后重试');
  f.context.WebRTC.socket = socketMock(f, (p, ack) => ack(null, receipt(p)));
  await f.d.sendLogs(); assert.equal(alerts.at(-1), '服务端已确认保存诊断（按保留策略清理）');
  const count = alerts.length; await f.d.autoSendFailure('pc-failed'); assert.equal(alerts.length, count);
});


test('expired HTTP receipt cannot confirm or consume pending events, and malformed payloads return false', async () => {
  const f = fixture(); let finishRead;
  const payload = f.d.buildConnectionDiagnostic();
  f.context.fetch = async () => ({ ok: true, status: 200, body: { getReader: () => ({
    read: () => new Promise(resolve => { finishRead = resolve; }), cancel() {},
  }) } });
  const promise = f.d.sendConnectionDiagnostic(payload); await flush(); await f.advance(8000);
  assert.equal(await promise, false);
  finishRead({ done: false, value: Buffer.from(JSON.stringify(receipt(payload))) }); await flush();
  assert.equal(f.d.getPendingDiagnostics().length, 1); assert.equal(f.d._diagnosticInFlight.size, 0);
  for (const invalid of [null, [], { diagnosticId: '' }, { diagnosticId: '   ' }]) {
    assert.equal(await f.d.sendConnectionDiagnostic(invalid), false);
  }
});
