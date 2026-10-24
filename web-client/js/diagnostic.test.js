const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function makeElement(id) {
  return {
    id,
    value: '',
    textContent: '',
    scrollTop: 0,
    scrollHeight: 100,
    style: {},
    disabled: false,
    dataset: {},
    classList: {
      add() {},
      remove() {},
    },
    focus() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute() { return null; },
    addEventListener(type, handler) {
      this[`on${type}`] = handler;
    },
  };
}

// Socket.IO timeout ACKs are error-first; older fixture emitters expose receipt-only callbacks.
function mockSocketTimeout(socket) {
  if (socket && !socket.timeout) socket.timeout = () => ({ emit(event, payload, callback) {
    return socket.emit(event, payload, receipt => callback(null, receipt));
  } });
  return socket;
}
function receiptResponse(payload, status = 200) {
  let consumed = false;
  return { ok: status >= 200 && status < 300, status, body: { getReader: () => ({
    read: async () => consumed ? { done: true } : (consumed = true, { done: false,
      value: Buffer.from(JSON.stringify({ accepted: true, diagnosticId: payload.diagnosticId, eventIdHashes: [] })) }),
    cancel() {},
  }) } };
}

function loadScript(filename, context, exportName) {
  mockSocketTimeout(context.WebRTC?.socket);
  if (!context.createRuntimeDiagnosticBuilder) vm.runInContext(fs.readFileSync(path.join(__dirname, 'runtime-diagnostic.js'), 'utf8'), context);
  if (filename === 'diagnostic.js' && !context.window.Diagnostic?.buildRuntimeDiagnostic) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'diagnostic-core.js'), 'utf8'), context);
  }
  const source = fs.readFileSync(path.join(__dirname, filename), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__exported = ${exportName};`, context);
  return context.__exported;
}

test('diagnostic core keeps the critical input trace through deferred panel loading', () => {
  const { context } = createDiagnosticContext();
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'input-trace.js'), 'utf8'), context);
  const InputTrace = context.InputTrace;
  context.window.InputTrace = InputTrace;
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'diagnostic-core.js'), 'utf8'), context);
  const Diagnostic = context.window.Diagnostic;
  const firstSnapshot = Diagnostic.getInputTraceSnapshot();
  assert.equal(firstSnapshot.schemaVersion, 3);
  Diagnostic.recordInputTrace('dom-received', {
    inputType: 'keyboard', action: 'key', phase: 'down',
    focusKind: 'desktop', visibility: 'visible',
  });
  const beforeDeferred = Diagnostic.getInputTraceSnapshot();
  assert.equal(beforeDeferred.events.length, 1);
  assert.equal(typeof InputTrace.create, 'function');

  const deferredDiagnostic = loadScript('diagnostic.js', context, 'Diagnostic');
  const afterDeferred = deferredDiagnostic.getInputTraceSnapshot();
  assert.equal(afterDeferred.events.length, 1);
  assert.equal(afterDeferred.events[0].stage, 'dom-received');
});

test('diagnostic core resolves the live Input from a classic script export', () => {
  const { context } = createDiagnosticContext();
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'input-trace.js'), 'utf8'), context);
  context.window.InputTrace = context.InputTrace;
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'diagnostic-core.js'), 'utf8'), context);
  const Input = loadScript('input.js', context, 'Input');
  const Diagnostic = context.window.Diagnostic;
  const sent = [];
  Diagnostic.autoSendFailure = (reason) => sent.push(reason);
  Diagnostic.buildConnectionDiagnostic = () => ({});
  Diagnostic.panelReady = true;
  context.WebRTC.currentConnectionAttemptId = 'attempt-classic';
  context.WebRTC.hasActiveControl = () => true;
  context.window.WebRTC = context.WebRTC;
  Input.isActive = true;
  Input.activeControlLease = { leaseEpoch: 8 };

  assert.equal(context.window.Input, Input);
  assert.equal(Diagnostic._currentInput(), Input);
  Diagnostic._handleInputTraceIncident('input-ack-timeout', {
    connectionAttemptId: 'attempt-classic', leaseEpoch: 8,
  });
  assert.deepEqual(sent, ['input-ack-timeout']);
});

test('diagnostic core drops an input timeout from an old attempt or lease epoch', () => {
  const { context } = createDiagnosticContext();
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'input-trace.js'), 'utf8'), context);
  context.window.InputTrace = context.InputTrace;
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'diagnostic-core.js'), 'utf8'), context);
  const Diagnostic = context.window.Diagnostic;
  const sent = [];
  Diagnostic.autoSendFailure = (reason) => sent.push(reason);
  Diagnostic.buildConnectionDiagnostic = () => ({ connectionAttemptId: 'attempt-new' });
  Diagnostic.panelReady = true;
  context.WebRTC.currentConnectionAttemptId = 'attempt-new';
  context.Input = {
    isActive: true,
    activeControlLease: { leaseEpoch: 8 },
    getEffectiveInputGate: () => ({ allowed: true, blockedReasons: [] }),
  };
  context.window.Input = context.Input;
  context.window.WebRTC = context.WebRTC;
  Diagnostic._handleInputTraceIncident('input-ack-timeout', {
    connectionAttemptId: 'attempt-old', leaseEpoch: 7,
  });
  assert.deepEqual(sent, []);

  Diagnostic._handleInputTraceIncident('input-ack-timeout', {
    connectionAttemptId: 'attempt-new', leaseEpoch: 7,
  });
  assert.deepEqual(sent, []);
  Diagnostic._handleInputTraceIncident('input-ack-timeout', {
    connectionAttemptId: 'attempt-new', leaseEpoch: 8,
  });
  assert.deepEqual(sent, ['input-ack-timeout']);
});

function createDiagnosticContext(overrides = {}) {
  const elements = new Map();
  const ids = [
    'diagBtn',
    'diagModal',
    'closeDiagBtn',
    'sendDiagBtn',
    'clearDiagBtn',
    'diagLogArea',
    'keyboardDebugArea',
    'remoteVideo',
    'relayImage',
    'keyInputDisplay',
    'keyboardModeBtn',
    'barEncode', 'valEncode', 'barCapture', 'valCapture', 'barExecute', 'valExecute',
    'barNetwork', 'valNetwork', 'barPlayout', 'valPlayout', 'barInput', 'valInput',
    'latencySync',
  ];
  ids.forEach((id) => elements.set(id, makeElement(id)));

  const baseStorage = (() => {
    const store = new Map();
    return {
      getItem(key) {
        return store.has(key) ? store.get(key) : null;
      },
      setItem(key, value) {
        store.set(key, String(value));
      },
      removeItem(key) {
        store.delete(key);
      },
      __store: store,
    };
  })();

  const context = {
    console, AbortController, TextDecoder, Uint8Array,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => fn(),
    performance: { now: () => 123.4 },
    sessionStorage: Object.assign(baseStorage, overrides.sessionStorage || {}),
    localStorage: Object.assign(baseStorage, overrides.localStorage || {}),
    navigator: { platform: 'MacIntel', userAgent: 'node-test' },
    window: {
      addEventListener() {},
      screen: { width: 1440, height: 900 },
      location: { origin: 'http://localhost:8080', href: 'http://localhost:8080/viewer' },
    },
    document: {
      hidden: false,
      addEventListener(type, handler) {
        if (type === 'DOMContentLoaded') {
          handler();
        }
      },
      querySelectorAll: () => [],
      getElementById(id) {
        return elements.get(id) || null;
      },
    },
    WebRTC: {
      socket: { connected: true, emit() {} },
      sendInput: () => true,
    },
    alert() {},
    setInterval() {},
    fetch: overrides.fetch,
    io: overrides.io,
    ConnectionTrace: overrides.ConnectionTrace,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'runtime-diagnostic.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'bounded-request.js'), 'utf8'), context);
  context.LATENCY_METRIC_NAMES = require('./latency-monitor').LATENCY_METRIC_NAMES;
  return { context, elements, storage: context.localStorage };
}

test('control heartbeat failure snapshot survives core, deferred, replay and private durable diagnostic ingestion', () => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-heartbeat-diagnostic-'));
  const previousDir = process.env.WRD_DIAG_DIR;
  process.env.WRD_DIAG_DIR = dir;
  try {
    const { context } = createDiagnosticContext();
    const heartbeat = { supported: true, ackBudgetMs: 2500, pending: false, pendingAgeMs: null,
      lastAckAgeMs: 3000, lastAckRttMs: 2400, maxAckRttMs: 2400,
      sent: 4, acknowledged: 3, timeouts: 1, rejected: 0, reason: 'acknowledged' };
    context.WebRTC.getControlHeartbeatSnapshot = () => ({ ...heartbeat, lastFailureAgeMs: 500,
      lastFailure: { ...heartbeat, reason: 'ack-timeout', leaseId: 'HEARTBEAT_PRIVATE_CANARY',
        lastFailure: { reason: 'HEARTBEAT_PRIVATE_CANARY' } }, socket: 'HEARTBEAT_PRIVATE_CANARY' });
    const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');
    const critical = Diagnostic.buildRuntimeDiagnostic({ reason: 'manual' });
    const deferred = Diagnostic.buildConnectionDiagnostic({ reason: 'manual' });
    const replay = context.runtimeDiagnosticForStorage(deferred, context.LATENCY_METRIC_NAMES);
    for (const payload of [critical, deferred, replay]) {
      assert.equal(payload.traceSummary.controlHeartbeat.sent, 4);
      assert.equal(payload.traceSummary.controlHeartbeat.timeouts, 1);
      assert.equal(payload.traceSummary.controlHeartbeat.lastAckRttMs, 2400);
      assert.equal(payload.traceSummary.controlHeartbeat.lastFailure.reason, 'ack-timeout');
      assert.equal(payload.traceSummary.controlHeartbeat.lastFailure.lastFailure, undefined);
      assert.equal(JSON.stringify(payload).includes('HEARTBEAT_PRIVATE_CANARY'), false);
    }
    const { ingestDiagnosticPayload } = require('../../signal-server/lib/diagnostic');
    const result = ingestDiagnosticPayload({ role: 'viewer', viewerId: 'heartbeat-diagnostic-test',
      data: deferred, config: { enableDiagPersist: true }, logger: {} });
    assert.equal(result.persisted, true);
    const rawFile = fs.readdirSync(path.join(dir, 'raw')).find(name => name.startsWith('runtime_'));
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'raw', rawFile), 'utf8'));
    const summaryFile = fs.readdirSync(path.join(dir, 'summary')).find(name => name.endsWith('.ndjson'));
    const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary', summaryFile), 'utf8').trim());
    for (const report of [result.report, raw, summary]) {
      const observed = report.traceSummary.controlHeartbeat;
      assert.equal(observed.supported, true);
      assert.equal(observed.acknowledged, 3);
      assert.equal(observed.lastFailure.reason, 'ack-timeout');
      assert.equal(observed.maxAckRttMs, 2400);
      assert.equal(observed.lastFailureAgeMs, 500);
      assert.equal(JSON.stringify(report).includes('HEARTBEAT_PRIVATE_CANARY'), false);
    }
  } finally {
    if (previousDir === undefined) delete process.env.WRD_DIAG_DIR;
    else process.env.WRD_DIAG_DIR = previousDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function loadRecoveryDiagnosticCoreFixture() {
  const { context } = createDiagnosticContext();
  context.console = { log() {}, info() {}, warn() {}, error() {} };
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'input-trace.js'), 'utf8'), context);
  context.window.InputTrace = context.InputTrace;
  context.window.document = context.document;
  context.window.WebRTC = context.WebRTC;
  context.window.localStorage = context.localStorage;
  context.window.sessionStorage = context.sessionStorage;
  context.window.performance = context.performance;
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'diagnostic-core.js'), 'utf8'), context);
  const Diagnostic = context.window.Diagnostic;
  context.Diagnostic = Diagnostic;
  const Input = loadScript('input.js', context, 'Input');
  const reports = [], recoveries = [];
  const originalUpdateKeyboardUI = Input.updateKeyboardUI;
  Input.updateKeyboardUI = () => {};
  Input.isActive = true;
  Input.activeControlLease = { leaseId: 'LEASE_PRIVATE_CANARY', leaseEpoch: 7 };
  context.WebRTC.currentConnectionAttemptId = 'attempt-recovery-current';
  context.WebRTC.hasActiveControl = () => Boolean(Input.activeControlLease);
  context.WebRTC.requestControlRecovery = generation => recoveries.push(generation);
  context.WebRTC.socket = { connected: true, on() {}, off() {}, timeout() {
    return { emit(event, payload, ack) {
      reports.push(payload);
      ack(null, { accepted: true, diagnosticId: payload.diagnosticId, eventIdHashes: [] });
    } };
  } };
  Input._recoveryCycle = { state: 'waiting', generation: 2, source: 'auto',
    leaseId: Input.activeControlLease.leaseId, leaseEpoch: 7, attemptId: context.WebRTC.currentConnectionAttemptId,
    mouseConfirmed: false, keyboardConfirmed: false, retryAvailable: false };
  return { context, Input, Diagnostic, reports, recoveries, originalUpdateKeyboardUI };
}

function loadExpiringDualResetDiagnosticFixture({ realUi = true } = {}) {
  const f = loadRecoveryDiagnosticCoreFixture();
  let now = 1000, nextTimer = 0;
  const timers = new Map(), releases = [], writes = [];
  f.context.performance.now = () => now;
  f.context.setTimeout = (callback, delay = 0) => {
    const id = ++nextTimer;
    timers.set(id, { callback, due: now + delay });
    return id;
  };
  f.context.clearTimeout = id => timers.delete(id);
  for (const file of ['keyboard-transport.js', 'remote-keyboard-controller.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), f.context);
  }
  f.context.WebRTC.sendInput = () => false;
  f.context.WebRTC.socket.emit = (event, payload) => {
    if (event === 'input') writes.push(payload);
  };
  f.Input.initKeyboardController();
  f.Input.keyboardController.setLease(f.Input.activeControlLease);
  f.Input._resetRecoveryCycle();
  f.Input._mobileSurfaceState = 'uncertain';
  if (realUi) f.Input.updateKeyboardUI = f.originalUpdateKeyboardUI;
  f.context.WebRTC.requestControlRecovery = generation => {
    releases.push({ generation, reportsAtRelease: f.reports.length });
    f.Input.activeControlLease = null;
  };
  assert.equal(f.Input.requestInputRecovery({ source: 'user' }), true);
  assert.equal(writes.filter(row => row.action === 'reset').length, 2);
  return { ...f, releases, advance(ms) {
    now += ms;
    let timer;
    while ((timer = [...timers].find(([, entry]) => entry.due <= now))) {
      timers.delete(timer[0]);
      timer[1].callback();
    }
  } };
}

for (const realUi of [true, false]) {
  test(`real dual-reset timeout captures the owned scope before snapshot reentry releases control (UI=${realUi})`, async () => {
    const f = loadExpiringDualResetDiagnosticFixture({ realUi });
    f.advance(2999);
    assert.equal(f.reports.length, 0);
    assert.equal(f.releases.length, 0);
    f.advance(2);
    assert.equal(f.reports.length, 1);
    assert.equal(f.reports[0].reason, 'recovery-failed');
    assert.equal(f.reports[0].inputState.hasLease, true);
    assert.equal(f.reports[0].inputState.leaseEpoch, 7);
    assert.equal(f.reports[0].inputState.recovery.state, 'failed');
    assert.equal(f.reports[0].inputState.recovery.reason, 'recovery-timeout');
    assert.equal(f.releases.length, 1);
    assert.equal(f.releases[0].reportsAtRelease, 1);
    assert.equal(f.Input._recoveryFailureCaptureCycle, null);
    assert.equal(JSON.stringify(f.reports[0]).includes('LEASE_PRIVATE_CANARY'), false);
    await Promise.resolve();
  });
}

for (const failure of ['builder-throw', 'async-reject']) {
  test(`dual-reset diagnostic ${failure} restores the capture latch and releases control once`, async () => {
    const f = loadExpiringDualResetDiagnosticFixture();
    let calls = 0;
    if (failure === 'builder-throw') {
      f.Diagnostic.buildConnectionDiagnostic = () => {
        calls++;
        f.Input.getDiagnosticState();
        throw Error('PRIVATE_BUILDER_CANARY');
      };
    } else {
      f.Diagnostic.autoSendFailure = () => {
        calls++;
        f.Input.getDiagnosticState();
        return Promise.reject(Error('PRIVATE_ASYNC_CANARY'));
      };
    }
    assert.doesNotThrow(() => f.advance(3001));
    assert.equal(calls, 1);
    assert.equal(f.releases.length, 1);
    assert.equal(f.Input._recoveryCycle.state, 'failed');
    assert.equal(f.Input._recoveryFailureCaptureCycle, null);
    await new Promise(resolve => setImmediate(resolve));
  });
}

test('reset ACK timeout uploads one core diagnostic before control recovery without opening the panel', async () => {
  const f = loadRecoveryDiagnosticCoreFixture();
  const { Input, Diagnostic, context, reports } = f;
  const identity = Input._traceIdentity();
  context.WebRTC.requestControlRecovery = generation => {
    f.recoveries.push(generation);
    assert.equal(reports.length, 1, 'capture must precede lease release');
    Input.activeControlLease = null;
  };
  Input._onReliableAckTimeout({ reset: true, action: 'reset', leaseId: Input.activeControlLease.leaseId,
    leaseEpoch: 7, connectionAttemptId: identity.connectionAttemptId });
  assert.equal(Diagnostic.panelReady, false);
  assert.equal(reports.length, 1); assert.deepEqual(f.recoveries, [2]);
  assert.equal(reports[0].schemaVersion, 3); assert.equal(reports[0].reason, 'recovery-failed');
  assert.equal(reports[0].connectionAttemptId, identity.connectionAttemptId);
  assert.ok(reports[0].inputTrace.events.some(event => event.stage === 'recovery' && event.state === 'failed'));
  assert.equal(JSON.stringify(reports[0]).includes('LEASE_PRIVATE_CANARY'), false);
  assert.equal(Input._markRecoveryFailure('recovery-timeout'), false);
  assert.equal(reports.length, 1);
  await Promise.resolve();
});

test('reset send failures report recovery failure while preserving their specific safe reason', () => {
  for (const inputType of ['mouse', 'keyboard']) {
    const f = loadRecoveryDiagnosticCoreFixture();
    f.Input._recoveryCycle.state = 'idle';
    f.Input._recoveryNeedsReset = () => true;
    f.Input.sendInput = () => 'RESET_PRIVATE_CANARY';
    f.Input._captureMouseReset = () => inputType === 'mouse' ? null
      : { inputId: 'RESET_PRIVATE_CANARY', seq: 1, leaseEpoch: 7, attemptId: f.context.WebRTC.currentConnectionAttemptId };
    f.Input.keyboardController = { reset: () => false, getSnapshot: () => ({ state: 'RESET_REQUIRED' }) };
    assert.equal(f.Input.requestInputRecovery({ source: 'user' }), false);
    assert.equal(f.reports.length, 1);
    const report = f.reports[0], reason = `${inputType}-reset-send-failed`;
    assert.equal(report.reason, 'recovery-failed');
    assert.notEqual(report.reason, 'input-ack-timeout');
    assert.equal(report.inputState.recovery.reason, reason);
    assert.ok(report.inputTrace.events.some(event => event.stage === 'recovery' && event.reason === reason));
    assert.equal(JSON.stringify(report).includes('RESET_PRIVATE_CANARY'), false);
  }
});

test('explicit reset ACK rejection reports recovery failure without fabricating an ACK timeout', () => {
  for (const status of ['stale-lease', 'invalid-input', 'unsupported-code', 'execution-failed']) {
    const f = loadRecoveryDiagnosticCoreFixture();
    const reset = { inputId: 'RESET_PRIVATE_CANARY', seq: 1, leaseEpoch: 7,
      connectionAttemptId: f.context.WebRTC.currentConnectionAttemptId,
      socket: f.context.WebRTC.socket, socketId: null };
    f.Input.keyboardTransport = { getPendingReset: () => reset,
      acceptAck: () => ({ status: 'reacquire-required' }), getSnapshot: () => ({ state: 'reacquire-required' }) };
    f.Input._acceptKeyboardAck({ schemaVersion: 2, inputType: 'keyboard', inputIds: [reset.inputId],
      leaseEpoch: 7, appliedSeq: 0, status });
    assert.equal(f.reports.length, 1);
    const report = f.reports[0], reason = `keyboard-reset-ack-${status}`;
    assert.equal(report.reason, 'recovery-failed');
    assert.notEqual(report.reason, 'input-ack-timeout');
    assert.equal(report.inputState.recovery.reason, reason);
    assert.ok(report.inputTrace.events.some(event => event.stage === 'recovery' && event.reason === reason));
    assert.equal(JSON.stringify(report).includes('RESET_PRIVATE_CANARY'), false);
  }
});

test('recovery diagnostic keeps current scope foreground lease and existing cooldown guards', () => {
  for (const kind of ['old-attempt', 'old-lease', 'hidden', 'inactive', 'no-lease', 'not-controller']) {
    const f = loadRecoveryDiagnosticCoreFixture();
    if (kind === 'old-attempt') f.context.WebRTC.currentConnectionAttemptId = 'attempt-new';
    if (kind === 'old-lease') f.Input.activeControlLease = { leaseId: 'other-lease', leaseEpoch: 7 };
    if (kind === 'hidden') f.context.document.hidden = true;
    if (kind === 'inactive') f.Input.isActive = false;
    if (kind === 'no-lease') f.Input.activeControlLease = null;
    if (kind === 'not-controller') f.context.WebRTC.hasActiveControl = () => false;
    assert.equal(f.Input._markRecoveryFailure('recovery-timeout'), true);
    assert.equal(f.reports.length, 0, kind);
  }
  const f = loadRecoveryDiagnosticCoreFixture();
  f.Input._markRecoveryFailure('recovery-timeout');
  f.Input._recoveryCycle.state = 'waiting';
  f.Input._recoveryCycle.generation++;
  f.Input._markRecoveryFailure('recovery-timeout');
  assert.equal(f.reports.length, 1, 'existing per-attempt cooldown remains in force');
});

test('recovery collector exceptions do not prevent control recovery', () => {
  const f = loadRecoveryDiagnosticCoreFixture(); let calls = 0;
  f.Diagnostic._handleInputTraceIncident = () => { calls++; throw Error('PRIVATE_COLLECTOR_CANARY'); };
  assert.doesNotThrow(() => f.Input._markRecoveryFailure('recovery-timeout'));
  assert.equal(calls, 1); assert.deepEqual(f.recoveries, [2]);
  assert.equal(f.Input._recoveryCycle.state, 'failed');
});

test('diagnostic input incidents consume rejected asynchronous sends', async () => {
  const f = loadRecoveryDiagnosticCoreFixture(); let calls = 0;
  f.Diagnostic.autoSendFailure = () => { calls++; return Promise.reject(Error('PRIVATE_SEND_CANARY')); };
  assert.equal(f.Diagnostic._handleInputTraceIncident('recovery-failed', f.Input._traceIdentity()), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('diagnostic button opens modal without rendering raw keyboard debug output', () => {
  const { context, elements } = createDiagnosticContext();

  const Input = loadScript('input.js', context, 'Input');
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');
  Diagnostic.logs = ['log-1'];

  assert.doesNotThrow(() => {
    elements.get('diagBtn').onclick();
  });
  assert.equal(elements.get('diagLogArea').value, 'log-1');
});

test('latency panel distinguishes unavailable values from a measured zero', () => {
  const { context, elements } = createDiagnosticContext();
  context.LatencyMonitor = {
    getStats: () => ({
      capture: { p50: 0, available: true },
      encode: { p50: null, available: false },
      executeTime: { p50: null, available: false },
      network: { p50: null, available: false },
      playout: { p50: null, available: false },
      inputRtt: { p50: null, available: false },
      sync: { state: 'idle', rtt: 0, offset: 0 },
    }),
  };
  const updateLatencyPanel = loadScript('diagnostic.js', context, 'updateLatencyPanel');
  updateLatencyPanel();
  assert.equal(elements.get('valCapture').textContent, '0ms');
  assert.equal(elements.get('valEncode').textContent, '未测量');
  assert.equal(elements.get('barEncode').style.width, '0%');
});


test('sendLogs includes keyboard mode, input state, and channel timeline', () => {
  const { context, elements } = createDiagnosticContext();
  const emitted = [];
  context.WebRTC.socket = { connected: true, emit(event, payload) { emitted.push({ event, payload }); } };

  const Input = loadScript('input.js', context, 'Input');
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');

  Input.keyboardMode = 'windows';
  Input.lastKeyboardResetReason = 'window-blur';
  Diagnostic.logs = [
    '[10:00:00] [LOG] [INPUT-DC] DataChannel open',
    '[10:00:01] [WRN] [INPUT-DC] DataChannel error: {"isTrusted":true}',
    '[10:00:02] [LOG] [INPUT-DC] DataChannel closed, sctp=connected pc=connected ice=completed'
  ];

  Diagnostic.sendLogs();

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'diagnostic');
  assert.equal(emitted[0].payload.keyboardMode, 'windows');
  assert.equal(emitted[0].payload.inputState.keyboard.pressedCount, 0);
  assert.equal(emitted[0].payload.inputState.keyboard.lastResetReason, 'window-blur');
  assert.equal(emitted[0].payload.inputChannelTimeline.length, 3);
  assert.equal(emitted[0].payload.inputChannelTimeline[0].kind, 'open');
});

test('manual and automatic diagnostics share the complete safe input snapshot and trace', () => {
  const { context } = createDiagnosticContext();
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');
  const safeInputState = {
    keyboardMode: 'mac',
    isActive: true,
    hasLease: true,
    effectiveGate: {
      allowed: false,
      blockedReasons: ['surface-uncertain'],
      recovery: { state: 'waiting', generation: 2, retryAvailable: false },
    },
    surface: { state: 'uncertain', generation: 3 },
    draft: { composing: false, hasPending: false, deliveryUncertain: true, status: 'uncertain' },
    viewport: { inputSupported: true },
    recovery: { state: 'waiting', generation: 2, retryAvailable: false },
    pendingMouseReset: true,
    desktopWriteRecovery: { state: 'reacquire-required', status: 'execution-failed' },
  };
  const inputTrace = {
    schemaVersion: 1,
    events: [{ stage: 'ack', inputType: 'keyboard', status: 'execution-failed', inputIdHash: '3e9fd6a21afbb55b' }],
    counters: { droppedEvents: 4, pendingAckCount: 1 },
  };
  context.Input = { getDiagnosticState: () => safeInputState };
  Diagnostic.getInputTraceSnapshot = () => inputTrace;

  const manual = Diagnostic.buildConnectionDiagnostic({ trigger: 'manual', reason: 'manual' });
  const automatic = Diagnostic.buildConnectionDiagnostic({ trigger: 'auto-failure', reason: 'pc-failed' });

  assert.deepEqual(JSON.parse(JSON.stringify(manual.inputState)), safeInputState);
  assert.deepEqual(JSON.parse(JSON.stringify(manual.inputTrace)), inputTrace);
  assert.deepEqual(JSON.parse(JSON.stringify(automatic.inputState)), safeInputState);
  assert.deepEqual(JSON.parse(JSON.stringify(automatic.inputTrace)), inputTrace);
});

test('sendLogs waits for the shared sender, uses authenticated HTTP when disconnected, and reports failure', async () => {
  const requests = [];
  const alerts = [];
  let ioCalls = 0;
  const { context, storage } = createDiagnosticContext({
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: false, status: 503 };
    },
    io: () => {
      ioCalls += 1;
      throw new Error('temporary viewer socket must not be created');
    },
  });
  context.alert = (message) => alerts.push(message);
  context.Auth = { getToken: () => 'viewer-token' };
  context.WebRTC.socket = { connected: false, emit() { throw new Error('socket must not be used'); } };
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');

  const result = await Diagnostic.sendLogs({ trigger: 'manual', reason: 'manual-disconnect' });

  assert.equal(result, false);
  assert.equal(ioCalls, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer viewer-token');
  assert.equal(alerts.at(-1), '未获服务端保存确认，请稍后重试');
  assert.equal(alerts.some((message) => String(message).includes('已发送')), false);
  const queued = JSON.parse(storage.getItem('wrdPendingDiagnostics'));
  assert.equal(queued.length, 1);
});

test('sendLogs includes paint continuity fields from the live WebRTC session', () => {
  const { context } = createDiagnosticContext();
  const emitted = [];
  context.WebRTC.socket = { connected: true, emit(event, payload) { emitted.push({ event, payload }); } };
  context.WebRTC.networkMode = 'relay';
  context.WebRTC.uiPhase = 'connected';
  context.WebRTC.hasPaintedFrame = true;
  context.WebRTC.getSessionPresentation = () => ({
    width: 1280, height: 720, label: '1280x720',
    capped: false,
    pathCap: { width: 1280, height: 720 },
    userPreference: { width: 1280, height: 720 },
    explicitOverride1080: false,
  });
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');
  Diagnostic.logs = ['log-1'];
  Diagnostic.sendLogs();
  assert.equal(emitted[0].payload.schemaVersion, 3);
  assert.equal(emitted[0].payload.mode, 'relay');
  assert.equal(emitted[0].payload.traceSummary.uiPhase, 'connected');
  assert.equal(emitted[0].payload.traceSummary.sessionPresentation.width, 1280);
  assert.equal(emitted[0].payload.traceSummary.hasPaintedFrame, true);
  assert.equal(emitted[0].payload.logs.length, 1);
});

test('connection diagnostics include only the aggregated paint observation', () => {
  const { context } = createDiagnosticContext();
  context.WebRTC._lastPaintObservation = {
    intervalMs: { p50: 16, p95: 34, max: 40 },
    maxGapMs: 40,
    presentedFramesDelta: 5,
    video: { width: 1280, height: 720 },
    geometry: { x: 0, y: 0, width: 960, height: 540, changes: 0 },
  };
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');
  const payload = Diagnostic.buildConnectionDiagnostic({ trigger: 'manual' });

  assert.deepEqual(JSON.parse(JSON.stringify(payload.traceSummary.paintObservation)), context.WebRTC._lastPaintObservation);
  assert.equal(JSON.stringify(payload).includes('presentedFrames: 1'), false);
});

test('connection diagnostics exports bounded frame-trace state without per-frame rows', () => {
  const { context } = createDiagnosticContext();
  context.WebRTC.getFrameTraceDiagnostics = () => ({
    acceptanceState: 'UNALIGNED', pendingFrames: 2, pendingTraces: 1,
    matchedCount: 2048, droppedTraceCount: 3,
  });
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');
  const payload = Diagnostic.buildConnectionDiagnostic({ trigger: 'manual' });

  assert.deepEqual(JSON.parse(JSON.stringify(payload.traceSummary.frameTrace)), {
    acceptanceState: 'UNALIGNED', pendingFrames: 2, pendingTraces: 1,
    matchedCount: 2048, droppedTraceCount: 3,
  });
  assert.equal(JSON.stringify(payload.traceSummary.frameTrace).includes('captureSeq'), false);
});

test('keyboard diagnostics expose lease metadata only and never raw key labels', () => {
  const { context } = createDiagnosticContext();
  const Input = loadScript('input.js', context, 'Input');
  Input.keyboardController = { getSnapshot: () => ({ state: 'READY', mode: 'mac', pressedKeyCount: 1 }) };
  Input.keyboardTransport = { getSnapshot: () => ({ state: 'ready', epoch: 8, lastSent: 12, lastApplied: 11, pendingCount: 1, adapter: 'socket' }) };
  Input.lastKeyboardResetReason = 'window-blur';
  Input.modifierMask = 0x100000;
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');

  Diagnostic.sendLogs();

  const payload = context.WebRTC.socket.emit.mock?.calls?.[0]?.[1];
  const state = Input.getDiagnosticState();
  assert.deepEqual(JSON.parse(JSON.stringify(state.keyboard)), {
    leaseState: 'READY', epoch: 8, lastSent: 12, lastApplied: 11, pendingCount: 1,
    pressedCount: 1, modifierMask: 1048576, adapter: 'socket', lastResetReason: 'window-blur',
  });
  assert.equal(JSON.stringify(state).match(/keyInputDisplay|PrivateCode|raw=/), null);
  assert.equal(payload, undefined);
});

test('buildConnectionDiagnostic includes browserSessionId and terminal diagnostic state', () => {
  const sessionStore = new Map([['wrd_browser_session_id', 'browser-session-1']]);
  const { context } = createDiagnosticContext({
    sessionStorage: {
      getItem(key) {
        return sessionStore.has(key) ? sessionStore.get(key) : null;
      },
      setItem(key, value) {
        sessionStore.set(key, String(value));
      },
    },
  });
  context.TerminalPanel = {
    getDiagnosticState() {
      return { activeSessionId: 'term-1', socketState: 'connected' };
    },
  };
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');

  const payload = Diagnostic.buildConnectionDiagnostic({ trigger: 'manual' });

  assert.equal(payload.browserSessionId, 'browser-session-1');
  assert.equal(payload.terminal.activeSessionId, 'term-1');
  assert.equal(payload.terminal.socketState, 'connected');
});

test('console interception stores structured log entries instead of bare strings', () => {
  const { context } = createDiagnosticContext();
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');

  Diagnostic.logs = [];
  context.console.error('[INPUT-DC] DataChannel error');

  assert.equal(Diagnostic.logs.length, 1);
  assert.equal(typeof Diagnostic.logs[0].message, 'string');
  assert.equal(Diagnostic.logs[0].level, 'ERR');
  assert.equal(Diagnostic.logs[0].channel, 'console');
  assert.equal(typeof Diagnostic.logs[0].at, 'string');
});

test('buildConnectionDiagnostic returns redacted schema v3 payload from current trace data', () => {
  const { context } = createDiagnosticContext();
  const traceSnapshot = {
    connectionAttemptId: 'wrd-20260627-abc123',
    events: [
      { event: 'session-start', data: { url: 'https://example.com/viewer?token=secret' } },
      { event: 'terminal-failure', data: { reason: 'candidate-check-failed' } },
    ],
    probeResults: [{ url: 'stun:stun.l.google.com:19302', status: 'srflx' }],
    traceSummary: { pcState: 'failed' },
    redaction: { sdp: 'omitted', tokens: 'omitted' },
  };
  const currentTrace = {
    buildPayload(extra) {
      return { ...traceSnapshot, ...extra };
    },
    snapshot() {
      return traceSnapshot;
    },
  };
  context.ConnectionTrace = {
    current: currentTrace,
    buildPayload(extra) {
      return currentTrace.buildPayload(extra);
    },
    snapshot() {
      return currentTrace.snapshot();
    },
  };
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');

  const payload = Diagnostic.buildConnectionDiagnostic({ trigger: 'auto-failure', reason: 'candidate-check-failed' });

  assert.equal(payload.type, 'connection-diagnostic');
  assert.equal(payload.schemaVersion, 3);
  assert.equal(Array.isArray(payload.events), true);
  assert.equal(Array.isArray(payload.probeResults), true);
  assert.equal(payload.redaction.sdp, 'omitted');
  assert.equal(payload.redaction.tokens, 'omitted');
  assert.equal(payload.traceSummary.trigger, 'auto-failure');
  assert.equal(payload.traceSummary.reason, 'candidate-check-failed');
  assert.equal(payload.events[0].data.url, '[redacted-url]');
});

test('buildConnectionDiagnostic includes adaptive media summary from WebRTC', () => {
  const { context } = createDiagnosticContext();
  context.WebRTC.networkMode = 'auto';
  context.WebRTC.serverConfig = {
    publicEntry: { formalEntryUrl: 'https://link.stockhub.wiki' },
  };
  context.WebRTC.recommendationState = {
    failureCode: 'direct-failed-suggest-relay',
    nextSuggestedMode: 'relay',
    severity: 'warning',
  };
  context.WebRTC.linkQualityController = {
    snapshot() {
      return {
        enabled: true,
        currentProfile: 'survival',
        profileChanges: [{ from: 'high', to: 'medium', reason: 'packet-loss' }],
        iceRestart: { proactiveAttempted: true, attempts: 1, reason: 'critical-media-quality' },
      };
    },
  };
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');

  const payload = Diagnostic.buildConnectionDiagnostic({ trigger: 'auto-failure', reason: 'strict-stun-exhausted' });

  assert.equal(payload.adaptiveMedia.enabled, true);
  assert.equal(payload.adaptiveMedia.currentProfile, 'survival');
  assert.equal(payload.adaptiveMedia.profileChanges.length, 1);
  assert.equal(payload.adaptiveMedia.iceRestart.attempts, 1);
  assert.equal(payload.schemaVersion, 3);
  assert.equal(payload.mode, 'auto');
  assert.equal(payload.entrypoint, 'https://link.stockhub.wiki');
  assert.deepEqual(JSON.parse(JSON.stringify(payload.recommendation)), {
    failureCode: 'direct-failed-suggest-relay',
    nextSuggestedMode: 'relay',
    severity: 'warning',
  });
});

test('buildConnectionDiagnostic includes paint continuity fields', () => {
  const { context, elements } = createDiagnosticContext();
  const video = elements.get('remoteVideo');
  video.videoWidth = 1280;
  video.videoHeight = 720;
  video.readyState = 2;
  context.WebRTC.getSessionPresentation = () => ({
    width: 1280, height: 720, label: '1280x720',
    capped: true,
    pathCap: { width: 1280, height: 720 },
    userPreference: { width: 1920, height: 1080 },
    explicitOverride1080: false,
  });
  context.WebRTC.uiPhase = 'media-stalled';
  context.WebRTC.hasPaintedFrame = true;
  context.WebRTC._lastInboundFramesDecoded = 0;
  context.WebRTC._lastPaintStats = {
    receivedDelta: 19,
    decodedDelta: 0,
    derivedFps: 0,
    jitterBufferMs: 40,
    bytesDelta: 1234,
    videoWidth: 1280,
    videoHeight: 720,
    framesDroppedDelta: 3,
    packetsReceivedDelta: 40,
    nackCountDelta: 2,
    pliCountDelta: 1,
    firCountDelta: 0,
    freezeDelta: 1,
  };
  context.WebRTC._lastKeyframeRequestAt = 1;
  context.WebRTC._keyframeEmitted = false;
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');
  const payload = Diagnostic.buildConnectionDiagnostic({ trigger: 'auto-failure', reason: 'media-stalled' });
  assert.equal(payload.schemaVersion, 3);
  assert.equal(payload.traceSummary.uiPhase, 'media-stalled');
  assert.equal(payload.traceSummary.sessionPresentation.width, 1280);
  assert.equal(payload.traceSummary.pathCap.height, 720);
  assert.equal(payload.traceSummary.hasPaintedFrame, true);
  assert.deepEqual(payload.traceSummary.userPreference, { width: 1920, height: 1080 });
  assert.equal(payload.traceSummary.explicitOverride1080, false);
  assert.equal(payload.traceSummary.videoWidth, 1280);
  assert.equal(payload.traceSummary.videoHeight, 720);
  assert.equal(payload.traceSummary.readyState, 2);
  assert.equal(payload.traceSummary.receivedDelta, 19);
  assert.equal(payload.traceSummary.decodedDelta, 0);
  assert.equal(payload.traceSummary.derivedFps, 0);
  assert.equal(payload.traceSummary.jitterBufferMs, 40);
  assert.equal(payload.traceSummary.bytesDelta, 1234);
  assert.equal(payload.traceSummary.framesDroppedDelta, 3);
  assert.equal(payload.traceSummary.packetsReceivedDelta, 40);
  assert.equal(payload.traceSummary.nackCountDelta, 2);
  assert.equal(payload.traceSummary.pliCountDelta, 1);
  assert.equal(payload.traceSummary.firCountDelta, 0);
  assert.equal(payload.traceSummary.freezeDelta, 1);
  assert.equal(payload.traceSummary.framesReceived, 19);
  assert.equal(payload.traceSummary.framesDecoded, 0);
  assert.equal(payload.traceSummary.fps, 0);
  assert.equal(payload.traceSummary.keyframeRequested, true);
  assert.equal(payload.traceSummary.keyframeEmitted, false);
});

test('diagnostic interval evidence comes from the current WebRTC owner rather than inferred paint zeros', () => {
  const { context } = createDiagnosticContext();
  const interval = { schemaVersion: 1, kind: 'webrtc-inbound-interval', elapsedMs: 1000,
    sampleAgeMs: 100, fpsObserved: true, droppedFramesObserved: true };
  context.WebRTC.getDiagnosticMediaInterval = () => interval;
  context.WebRTC._lastPaintStats = { derivedFps: 18, decodedDelta: 18, framesDroppedDelta: 0 };
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');
  assert.deepEqual(Diagnostic.buildConnectionDiagnostic().traceSummary.mediaInterval, interval);
  context.WebRTC.getDiagnosticMediaInterval = () => null;
  context.WebRTC.hasPaintedFrame = true;
  assert.equal(Diagnostic.buildConnectionDiagnostic().traceSummary.mediaInterval, null);
});

test('sendConnectionDiagnostic queues payload when socket and fetch fail', async () => {
  const { context, storage } = createDiagnosticContext({
    fetch: async () => ({ ok: false, status: 500 }),
    io: () => ({ on() {}, emit() { throw new Error('socket failed'); }, disconnect() {} }),
  });
  context.WebRTC.socket = { connected: true, emit() { throw new Error('socket emit failed'); } };
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');
  const payload = { type: 'connection-diagnostic', schemaVersion: 2, connectionAttemptId: 'wrd-test', events: [], probeResults: [], redaction: { sdp: 'omitted', tokens: 'omitted' } };

  const result = await Diagnostic.sendConnectionDiagnostic(payload);

  assert.equal(result, false);
  const queued = JSON.parse(storage.getItem('wrdPendingDiagnostics'));
  assert.equal(Array.isArray(queued), true);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].connectionAttemptId, 'wrd-test');
});

test('replayPendingDiagnostics replays at most two queued diagnostics and removes only confirmed IDs', async () => {
  const { context } = createDiagnosticContext();
  const emitted = [];
  context.WebRTC.socket = { connected: true, emit(event, payload, ack) {
    emitted.push({ event, payload }); ack({ accepted: true, diagnosticId: payload.diagnosticId, eventIdHashes: [] });
  } };
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');
  const reports = ['wrd-1', 'wrd-2', 'wrd-3'].map(connectionAttemptId => ({ ...Diagnostic.buildConnectionDiagnostic(), connectionAttemptId }));
  reports.forEach(payload => Diagnostic.enqueuePendingDiagnostic(payload));
  const replayed = await Diagnostic.replayPendingDiagnostics(context.WebRTC.socket);
  assert.equal(replayed, 2); assert.equal(emitted.length, 2);
  assert.equal(emitted[0].payload.connectionAttemptId, 'wrd-1');
  assert.equal(emitted[1].payload.connectionAttemptId, 'wrd-2');
  assert.deepEqual(Array.from(Diagnostic.getPendingDiagnostics(), p => p.diagnosticId), [reports[2].diagnosticId]);
});

test('enqueuePendingDiagnostic preserves the first capture per connectionAttemptId', () => {
  const { context, storage } = createDiagnosticContext();
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');
  Diagnostic.enqueuePendingDiagnostic({ connectionAttemptId: 'a1', reason: 'first' });
  Diagnostic.enqueuePendingDiagnostic({ connectionAttemptId: 'a1', reason: 'second' });
  Diagnostic.enqueuePendingDiagnostic({ connectionAttemptId: 'a2', reason: 'other' });
  const queued = JSON.parse(storage.getItem('wrdPendingDiagnostics'));
  assert.equal(queued.length, 2);
  const a1 = queued.find((item) => item.connectionAttemptId === 'a1');
  assert.equal(a1.reason, 'first');
});

test('autoSendFailure and replayPendingDiagnostics share unified per-attempt cooldown', async () => {
  const { context, storage } = createDiagnosticContext();
  const emitted = [];
  context.WebRTC.socket = {
    connected: true,
    emit(event, payload) { emitted.push({ event, payload }); },
  };
  context.WebRTC.currentConnectionAttemptId = 'attempt-cool';
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');
  Diagnostic.autoSendCooldownMs = 60_000;
  Diagnostic.autoSendFailure('pc-failed');
  assert.equal(emitted.length, 1);
  Diagnostic.autoSendFailure('pc-failed-again');
  // Second call cools down but still refreshes pending for the attempt.
  assert.equal(emitted.length, 1);
  const pending = JSON.parse(storage.getItem('wrdPendingDiagnostics') || '[]');
  assert.equal(pending.length, 1);
  assert.match(pending[0].connectionAttemptId, /^[a-f0-9]{32}$/);
  assert.equal(Diagnostic.getPendingDiagnostics()[0].connectionAttemptId, 'attempt-cool');
  const replayed = await Diagnostic.replayPendingDiagnostics(context.WebRTC.socket);
  assert.equal(replayed, 0);
  assert.equal(emitted.length, 1);
});

test('autoSendFailure is scoped per connection attempt instead of one global cooldown', () => {
  const { context } = createDiagnosticContext();
  const emitted = [];
  context.WebRTC.socket = {
    connected: true,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
  };
  context.WebRTC.networkMode = 'auto';
  context.WebRTC.currentConnectionAttemptId = 'attempt-1';
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');

  Diagnostic.autoSendFailure('pc-failed');
  context.WebRTC.currentConnectionAttemptId = 'attempt-2';
  Diagnostic.autoSendFailure('relay-failed');

  assert.equal(emitted.length, 2);
  assert.equal(emitted[0].payload.connectionAttemptId, 'attempt-1');
  assert.equal(emitted[1].payload.connectionAttemptId, 'attempt-2');
});

test('sendConnectionDiagnostic falls back to fetch when socket is unavailable', async () => {
  const requests = [];
  const { context, storage } = createDiagnosticContext({
    fetch: async (url, options) => {
      requests.push({ url, options });
      return receiptResponse(JSON.parse(options.body));
    },
  });
  context.WebRTC.socket = { connected: false, emit() { throw new Error('should not be used'); } };
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');

  const ok = await Diagnostic.sendConnectionDiagnostic({ diagnosticId: 'a'.repeat(32), trigger: 'policy-violation', reason: 'relay-not-allowed' });

  assert.equal(ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://localhost:8080/api/diagnostics');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(storage.getItem('wrdPendingDiagnostics')), []);
});

test('sendConnectionDiagnostic uses runtime API base and bearer auth when socket is unavailable', async () => {
  const requests = [];
  const { context } = createDiagnosticContext({
    fetch: async (url, options) => {
      requests.push({ url, options });
      return receiptResponse(JSON.parse(options.body));
    },
  });
  context.WebRTC.socket = { connected: false, emit() { throw new Error('should not be used'); } };
  context.Auth = {
    getToken: () => 'viewer-token-123',
  };
  context.RuntimeConfig = {
    getApiBase: () => 'https://link.stockhub.wiki',
  };
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');

  const ok = await Diagnostic.sendConnectionDiagnostic({
    diagnosticId: 'b'.repeat(32), type: 'connection-diagnostic',
    connectionAttemptId: 'attempt-42',
    recommendation: { nextSuggestedMode: 'relay' },
  });

  assert.equal(ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://link.stockhub.wiki/api/diagnostics');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer viewer-token-123');
  assert.match(requests[0].options.body, /"connectionAttemptId":"attempt-42"/);
  assert.match(requests[0].options.body, /"nextSuggestedMode":"relay"/);
});

test('autoSendFailure emits connection diagnostics instead of generic log payload', () => {
  const { context } = createDiagnosticContext();
  const emitted = [];
  context.WebRTC.socket = {
    connected: true,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
  };
  context.WebRTC.networkMode = 'auto';
  context.WebRTC.serverConfig = {
    publicEntry: { formalEntryUrl: 'https://link.stockhub.wiki' },
  };
  context.WebRTC.recommendationState = {
    failureCode: 'direct-failed-suggest-relay',
    nextSuggestedMode: 'relay',
    severity: 'warning',
  };
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');

  Diagnostic.autoSendFailure('pc-failed');

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'diagnostic');
  assert.equal(emitted[0].payload.type, 'connection-diagnostic');
  assert.equal(emitted[0].payload.traceSummary.reason, 'pc-failed');
  assert.equal(emitted[0].payload.recommendation.nextSuggestedMode, 'relay');
});

test('autoSendFailure includes the current network snapshot for candidate diagnostics', () => {
  const { context } = createDiagnosticContext();
  const emitted = [];
  context.WebRTC.socket = {
    connected: true,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
  };
  context.WebRTC.networkMode = 'stun';
  context.WebRTC.collectNetworkSnapshot = () => ({
    networkMode: 'stun',
    turnConfigured: false,
    turnStatus: 'missing',
    selectedCandidatePair: {
      localType: 'srflx',
      remoteType: 'host',
      protocol: 'udp',
      localAddress: 'redacted-local-address',
      remoteAddress: 'redacted-remote-address',
      localAddressFamily: 'ipv4',
      remoteAddressFamily: 'ipv6',
      rttMs: 88,
    },
    candidateSummary: {
      local: { host: 2, srflx: 1, relay: 0, prflx: 0, other: 0 },
      remote: { host: 1, srflx: 1, relay: 0, prflx: 0, other: 0 },
      samples: {
        local: [{ type: 'srflx', address: '203.0.113.1:5000', protocol: 'udp' }],
        remote: [{ type: 'host', address: '192.168.0.2:6000', protocol: 'udp' }],
      },
    },
    pc: {
      connectionState: 'failed',
      iceConnectionState: 'failed',
      iceGatheringState: 'complete',
      signalingState: 'stable',
    },
  });
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');

  Diagnostic.autoSendFailure('pc-failed');

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.network.selectedCandidatePair.protocol, 'udp');
  assert.equal(emitted[0].payload.network.selectedCandidatePair.remoteAddressFamily, 'ipv6');
  assert.equal(emitted[0].payload.network.candidateSummary.local.srflx, 1);
  assert.equal(emitted[0].payload.network.candidateSummary.remote.host, 1);
});

test('sendLogs includes network snapshot and failure reason metadata', () => {
  const elements = new Map();
  const ids = [
    'diagBtn', 'diagModal', 'closeDiagBtn', 'sendDiagBtn', 'clearDiagBtn',
    'diagLogArea', 'keyboardDebugArea', 'remoteVideo', 'relayImage', 'keyInputDisplay', 'keyboardModeBtn'
  ];
  ids.forEach((id) => elements.set(id, makeElement(id)));

  const emitted = [];
  const context = {
    console, AbortController, TextDecoder, Uint8Array,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => fn(),
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: {
      platform: 'MacIntel',
      userAgent: 'node-test',
      language: 'zh-CN',
      onLine: true,
      connection: {
        effectiveType: '4g',
        type: 'wifi',
        downlink: 42,
        rtt: 18,
      },
    },
    window: {
      addEventListener() {},
      screen: { width: 1440, height: 900 },
      location: { origin: 'http://localhost:8080' },
    },
    document: {
      hidden: false,
      addEventListener(type, handler) {
        if (type === 'DOMContentLoaded') {
          handler();
        }
      },
      querySelectorAll: () => [],
      getElementById(id) {
        return elements.get(id) || null;
      },
    },
    WebRTC: {
      socket: { connected: true, emit(event, payload) { emitted.push({ event, payload }); } },
      collectNetworkSnapshot() {
        return {
          networkMode: 'stun',
          useRelayFallback: false,
          tunnelRelayActive: false,
          autoFailCount: 1,
          noMediaTicks: 3,
          lastCandidateType: 'srflx',
          turnConfigured: false,
          turnStatus: 'missing',
          selectedCandidatePair: {
            localType: 'srflx',
            remoteType: 'host',
            protocol: 'udp',
            localAddress: 'redacted-local-address',
            remoteAddress: 'redacted-remote-address',
            localAddressFamily: 'ipv4',
            remoteAddressFamily: 'ipv6',
            rttMs: 88,
          },
          candidateSummary: {
            local: { host: 2, srflx: 1, relay: 0, prflx: 0, other: 0 },
            remote: { host: 1, srflx: 1, relay: 0, prflx: 0, other: 0 },
            samples: {
              local: [{ type: 'srflx', address: '203.0.113.1:5000', protocol: 'udp' }],
              remote: [{ type: 'host', address: '192.168.0.2:6000', protocol: 'udp' }],
            },
          },
          pc: {
            connectionState: 'failed',
            iceConnectionState: 'failed',
            iceGatheringState: 'complete',
            signalingState: 'stable',
          },
        };
      },
    },
    alert() {},
    setInterval() {},
  };
  context.globalThis = context;
  vm.createContext(context);

  const Input = loadScript('input.js', context, 'Input');
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');

  Input._keyboardDebugEntries = [];
  Diagnostic.logs = ['[10:00:00] [WRN] [RECOVERY] Scheduling WebRTC reconnect after pc-failed'];
  Diagnostic.sendLogs({ trigger: 'auto-failure', reason: 'pc-failed' });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.trigger, 'auto-failure');
  assert.equal(emitted[0].payload.reason, 'pc-failed');
  assert.equal(emitted[0].payload.network.networkMode, 'stun');
  assert.equal(emitted[0].payload.network.turnConfigured, false);
  assert.equal(emitted[0].payload.network.turnStatus, 'missing');
  assert.equal(emitted[0].payload.network.selectedCandidatePair.protocol, 'udp');
  assert.equal(emitted[0].payload.network.selectedCandidatePair.localAddressFamily, 'ipv4');
  assert.equal(emitted[0].payload.network.selectedCandidatePair.remoteAddressFamily, 'ipv6');
  assert.equal(emitted[0].payload.network.candidateHealth, 'stun-no-turn-no-relay');
  assert.equal(emitted[0].payload.network.pc.connectionState, 'failed');
  assert.equal(emitted[0].payload.network.navigator.type, 'wifi');
});

test('deferred Diagnostic init owns one interval and listener setup; dispose blocks late DOM init', () => {
  const { context } = createDiagnosticContext();
  const intervals = new Map();
  let serial = 0, listeners = 0, domReady;
  context.setInterval = (fn) => { const id = ++serial; intervals.set(id, fn); return id; };
  context.clearInterval = (id) => intervals.delete(id);
  context.document.readyState = 'loading';
  context.document.addEventListener = (type, handler) => { if (type === 'DOMContentLoaded') domReady = handler; };
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');
  const setup = Diagnostic.setupUI;
  Diagnostic.setupUI = function () { listeners++; return setup.call(this); };
  assert.equal(intervals.size, 0, 'no timer before initialization');
  Diagnostic.init();
  Diagnostic.init();
  assert.equal(listeners, 1);
  assert.equal(intervals.size, 1);
  Diagnostic.dispose();
  assert.equal(intervals.size, 0);
  domReady();
  Diagnostic.init();
  assert.equal(intervals.size, 0);
  assert.equal(listeners, 1);
});

test('managed late deferred script cannot mark itself ready or start its interval', () => {
  const { context } = createDiagnosticContext();
  context.window.__WRD_DEFERRED_MANAGED__ = true;
  let intervals = 0;
  context.setInterval = () => ++intervals;
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');
  assert.equal(intervals, 0);
  assert.notEqual(Diagnostic._panelInitialized, true);
  Diagnostic.init();
  assert.equal(intervals, 1);
});

test('core auto failure captures M1 without loading deferred scripts and manual uses the same builder', async () => {
  const { context } = createDiagnosticContext();
  const sample = { schemaVersion: 3, scope: null, windowMs: 5000,
    metrics: { inputAckRttMs: { last: 42, p50: 41, p95: 90, count: 3, available: true, lastSampleAgeMs: 7 } },
    outcomes: { sent: 4, acked: 3, rejected: 0, timedOut: 1, late: 0, cancelled: 0, dropped: 0, unmatched: 0 } };
  context.WebRTC.getDataChannelWatchdogSnapshot = () => ({ phase: 'negotiation', timedOut: true, elapsedMs: 30000, remainingMs: 0, extensions: 0, pcState: 'new', secret: 'WATCHDOG_SECRET_CANARY' });
  context.__WRD_STARTUP_SNAPSHOT__ = () => ({ marks: [{ name: 'core-interactive', atMs: 3 }] });
  context.LatencyMonitor = { snapshot: () => sample }; context.window.LatencyMonitor = context.LatencyMonitor;
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'diagnostic-core.js'), 'utf8'), context);
  const Diagnostic = context.window.Diagnostic; const sent = [];
  Diagnostic.sendConnectionDiagnostic = payload => { sent.push(payload); return true; };
  Diagnostic.autoSendFailure('input-ack-timeout');
  assert.equal(sent.length, 1); assert.equal(Diagnostic.panelReady, false);
  loadScript('diagnostic.js', context, 'Diagnostic');
  await Diagnostic.sendLogs();
  for (const payload of sent) {
    assert.equal(payload.schemaVersion, 3); assert.equal(payload.latency.metrics.inputAckRttMs.last, 42);
    assert.equal(payload.latency.outcomes.timedOut, 1); assert.ok(payload.diagnosticId); assert.ok(payload.captured.bootIdHash);
    assert.equal(payload.startup.dataChannelWatchdog.phase, 'negotiation');
    assert.equal(payload.startup.dataChannelWatchdog.timedOut, true);
    assert.equal(Object.keys(payload.startup.dataChannelWatchdog).length, 14);
    assert.equal(JSON.stringify(payload.startup).includes('WATCHDOG_SECRET_CANARY'), false);
    assert.equal(payload.startup.marks.length, 1);
    assert.ok(payload.build); assert.ok(payload.scopeEnded); assert.ok(payload.startup);
  }
  assert.equal(sent.length, 2);
});

test('actual auto failure retries captured ID/time/latency and drains M1 only once through server receipt', async () => {
  const os = require('node:os'); const { ingestDiagnosticPayload, loadRecentDiagnostics } = require('../../signal-server/lib/diagnostic');
  const previousDir = process.env.WRD_DIAG_DIR; const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3a-retry-'));
  process.env.WRD_DIAG_DIR = dir;
  try {
    const { context } = createDiagnosticContext({ fetch: async () => ({ ok: false }) });
    let drains = 0; let snapshotCalls = 0;
    const snapshot = { schemaVersion: 3, scope: { connectionAttemptId: 'old-scope', generation: 1, leaseEpoch: 1 }, windowMs: 5000,
      metrics: { inputAckRttMs: { last: 42, p50: 41, p95: 90, count: 3, available: true, lastSampleAgeMs: 7 } },
      outcomes: { sent: 2, acked: 0, rejected: 0, timedOut: 0, late: 0, cancelled: 2, dropped: 0, unmatched: 0 } };
    context.LatencyMonitor = { snapshot: () => { snapshotCalls++; return { ...snapshot, outcomes: { ...snapshot.outcomes, sent: 0, cancelled: 0 } }; },
      takeClosedScopeSummaries: () => { drains++; return { summaries: [{ endedAtMs: 120, snapshot }, { endedAtMs: 121, snapshot }], dropped: 0 }; } };
    context.WebRTC.socket = { connected: false };
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'diagnostic-core.js'), 'utf8'), context);
    const Diagnostic = context.window.Diagnostic;
    assert.equal(await Diagnostic.autoSendFailure('pc-failed'), false);
    const failure = Diagnostic.getPendingDiagnostics()[0]; assert.equal(drains, 1); assert.equal(failure.scopeEnded.events.length, 2);
    const sent = []; const receipts = [];
    const socket = { connected: true, emit(event, payload, ack) {
      sent.push(JSON.parse(JSON.stringify(payload)));
      const result = ingestDiagnosticPayload({ role: 'viewer', viewerId: 'viewer-test', data: payload, config: { enableDiagPersist: true }, logger: {} });
      receipts.push(result.receipt); ack(result.receipt);
    } };
    Diagnostic.autoSendByAttempt = {};
    assert.equal(await Diagnostic.replayPendingDiagnostics(mockSocketTimeout(socket)), 1);
    assert.equal(drains, 1); assert.equal(snapshotCalls, 1);
    assert.equal(sent[0].diagnosticId, failure.diagnosticId); assert.deepEqual(sent[0].captured, JSON.parse(JSON.stringify(failure.captured)));
    assert.equal(sent[0].latency.metrics.inputAckRttMs.last, 42); assert.equal(sent[0].latency.outcomes.sent, 0);
    assert.equal(Diagnostic.getPendingDiagnostics().length, 0);
    const again = ingestDiagnosticPayload({ role: 'viewer', viewerId: 'viewer-test', data: failure, config: { enableDiagPersist: true }, logger: {} });
    assert.equal(again.duplicate, true); assert.equal(again.summaryEvent, null);
    const durableEvents = loadRecentDiagnostics().filter(report => report.type === 'scope-ended');
    assert.equal(durableEvents.length, 2);
    assert.deepEqual(durableEvents.map(report => report.eventIdHash).sort(), [...receipts[0].eventIdHashes].sort());
    assert.equal(receipts[0].eventIdHashes.length, 2);
  } finally { if (previousDir === undefined) delete process.env.WRD_DIAG_DIR; else process.env.WRD_DIAG_DIR = previousDir; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('core without M1 reports unavailable immediately and never injects a script', () => {
  const { context } = createDiagnosticContext(); let scriptRequests = 0;
  context.document.createElement = () => { scriptRequests++; throw Error('unexpected lazy request'); };
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'diagnostic-core.js'), 'utf8'), context);
  const Diagnostic = context.window.Diagnostic; const sent = [];
  Diagnostic.sendConnectionDiagnostic = payload => sent.push(payload);
  Diagnostic.autoSendFailure('pc-failed');
  assert.equal(sent.length, 1); assert.equal(scriptRequests, 0); assert.equal(sent[0].latency, null);
  assert.equal(sent[0].latencyStatus, 'collector-unavailable');
});

test('latency panel uses input ACK metric and fresh age last, never the gauge placeholder quantiles', () => {
  const { context, elements } = createDiagnosticContext();
  for (const id of ['valFresh', 'barFresh', 'valVisible', 'barVisible']) elements.set(id, makeElement(id));
  context.LatencyMonitor = { getStats: () => ({ sync: { state: 'idle' } }), snapshot: () => ({ metrics: {
    inputAckRttMs: { p50: 42, available: true }, freshFrameAgeMs: { last: 8, p50: 999, p95: 1000, available: true },
    inputToVisibleEffectMs: { p50: 123, available: false },
  } }) };
  loadScript('diagnostic.js', context, 'updateLatencyPanel')();
  assert.equal(elements.get('valInput').textContent, '42ms'); assert.equal(elements.get('valFresh').textContent, '8ms');
  assert.equal(elements.get('valVisible').textContent, '未测量');
});

test('runtime localStorage retains failure metrics and hashes scope while removing raw UI content and URLs', async () => {
  const { context, storage } = createDiagnosticContext({ fetch: async () => ({ ok: false }) });
  context.WebRTC.socket = { connected: false }; context.WebRTC.currentConnectionAttemptId = 'PRIVATE_SCOPE_CANARY';
  context.LatencyMonitor = { snapshot: () => ({ schemaVersion: 3, windowMs: 5000,
    scope: { connectionAttemptId: 'PRIVATE_SCOPE_CANARY', generation: 1, leaseEpoch: 2 },
    metrics: { inputAckRttMs: { last: 42, p50: 41, p95: 90, count: 3, available: true, lastSampleAgeMs: 7 },
      SECRET_METRIC_CANARY: { payload: 'PRIVATE_PAYLOAD_CANARY' } }, outcomes: { sent: 4, acked: 3 } }) };
  context.Input = { getDiagnosticState: () => ({ text: 'PRIVATE_PAYLOAD_CANARY' }) };
  context.__WRD_STARTUP_SNAPSHOT__ = () => ({ resources: [{ path: 'https://private.test/?PRIVATE_URL_CANARY' }] });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'diagnostic-core.js'), 'utf8'), context);
  const Diagnostic = context.window.Diagnostic;
  await Diagnostic.autoSendFailure('pc-failed');
  const encoded = storage.getItem('wrdPendingDiagnostics');
  for (const canary of ['PRIVATE_SCOPE_CANARY', 'PRIVATE_PAYLOAD_CANARY', 'PRIVATE_URL_CANARY', 'SECRET_METRIC_CANARY']) assert.equal(encoded.includes(canary), false, canary);
  const saved = JSON.parse(encoded)[0]; assert.equal(saved.latency.metrics.inputAckRttMs.last, 42); assert.ok(saved.latency.scope.attemptHash);
  assert.equal(Diagnostic.getPendingDiagnostics()[0].latency.scope.connectionAttemptId, 'PRIVATE_SCOPE_CANARY');
});

test('same-attempt automatic and manual failures each retain the transmitted ID and capture for retry', async () => {
  const requests = [];
  const { context } = createDiagnosticContext({ fetch: async (_url, request) => {
    requests.push(JSON.parse(request.body)); return { ok: false };
  } });
  context.WebRTC.currentConnectionAttemptId = 'same-attempt'; context.WebRTC.socket = { connected: false };
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');
  Diagnostic.autoSendCooldownMs = 0;
  await Diagnostic.autoSendFailure('pc-failed');
  await Diagnostic.autoSendFailure('dc-error');
  await Diagnostic.sendLogs();
  assert.equal(requests.length, 3); assert.equal(new Set(requests.map(payload => payload.diagnosticId)).size, 3);
  assert.deepEqual(Array.from(Diagnostic.getPendingDiagnostics(), payload => payload.diagnosticId), requests.map(payload => payload.diagnosticId));
  const retried = []; const socket = { connected: true, emit(_event, payload, acknowledge) {
    retried.push(JSON.parse(JSON.stringify(payload)));
    acknowledge({ accepted: true, diagnosticId: payload.diagnosticId, eventIdHashes: [] });
  } };
  assert.equal(await Diagnostic.replayPendingDiagnostics(mockSocketTimeout(socket)), 2);
  assert.equal(await Diagnostic.replayPendingDiagnostics(mockSocketTimeout(socket)), 1);
  assert.equal(Diagnostic.getPendingDiagnostics().length, 0);
  for (let i = 0; i < requests.length; i++) {
    assert.equal(retried[i].diagnosticId, requests[i].diagnosticId); assert.deepEqual(retried[i].captured, requests[i].captured);
    assert.deepEqual(retried[i].latency, requests[i].latency);
  }
});

test('confirming a report preserves another pending report sharing its scope event without a false gap', async () => {
  const { context } = createDiagnosticContext(); let drained = false;
  context.WebRTC.currentConnectionAttemptId = 'shared-scope';
  context.LatencyMonitor = { snapshot: () => null, takeClosedScopeSummaries: () => {
    const summaries = drained ? [] : [{ endedAtMs: 120, snapshot: { schemaVersion: 3, scope: null, windowMs: 5000, metrics: {}, outcomes: {} } }];
    drained = true; return { summaries, dropped: 0 };
  } };
  const transmissions = [];
  context.WebRTC.socket = { connected: true, emit(_event, payload, acknowledge) { transmissions.push({ payload, acknowledge }); } };
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic'); Diagnostic.autoSendCooldownMs = 0;
  const firstSend = Diagnostic.autoSendFailure('pc-failed'); const secondSend = Diagnostic.autoSendFailure('dc-error');
  const [first, second] = transmissions;
  first.acknowledge({ accepted: true, diagnosticId: first.payload.diagnosticId,
    eventIdHashes: [first.payload.scopeEnded.events[0].eventIdHash] });
  await firstSend;
  second.acknowledge({ accepted: false, diagnosticId: second.payload.diagnosticId, eventIdHashes: [] }); await secondSend;
  const remaining = Diagnostic.getPendingDiagnostics();
  assert.equal(remaining.length, 1); assert.equal(remaining[0].diagnosticId, second.payload.diagnosticId);
  assert.equal(remaining[0].scopeEnded.events.length, 0); assert.equal(remaining[0].scopeEnded.dropped, 0);
});

test('multiple captures for one attempt remain within the pending count and byte budgets', () => {
  const { context } = createDiagnosticContext(); const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');
  context.WebRTC.currentConnectionAttemptId = 'bounded-attempt';
  const reports = Array.from({ length: 12 }, () => Diagnostic.buildConnectionDiagnostic({ reason: 'pc-failed' }));
  for (const report of reports) Diagnostic.enqueuePendingDiagnostic(report);
  Diagnostic.enqueuePendingDiagnostic(reports.at(-1)); // Same-ID retries do not consume another slot.
  const pending = Diagnostic.getPendingDiagnostics(); assert.equal(pending.length, 10);
  assert.equal(pending[0].diagnosticId, reports[2].diagnosticId); assert.equal(pending.at(-1).diagnosticId, reports.at(-1).diagnosticId);
  assert.ok(pending.every(payload => Buffer.byteLength(JSON.stringify(payload)) <= 128 * 1024));
  assert.ok(Buffer.byteLength(JSON.stringify(pending)) <= 10 * 128 * 1024);
});

test('connection diagnostic keeps nullable buffer separate from measured zero and M1 snapshot', () => {
  const unknowns = [null, undefined, '', '0', true, false, {}, NaN, Infinity, -Infinity, -1];
  for (const value of [...unknowns, 0, 0.1, 725.1]) {
    const { context } = createDiagnosticContext();
    context.WebRTC._lastPaintStats = { jitterBufferMs: value, decodedDelta: 19, receivedDelta: 20, derivedFps: 19 };
    const scope = { connectionAttemptId: 'nullable', generation: 1, leaseEpoch: 1 };
    const monitor = require('./latency-monitor').createLatencyMonitor({ now: () => 0 });
    monitor.setScope(scope);
    monitor.recordStage('inputAckRttMs', 42, { scope, atMs: 0, sampleKey: 'ack' });
    context.LatencyMonitor = monitor;
    context.WebRTC.latencyScope = () => scope;
    const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');
    const report = Diagnostic.buildConnectionDiagnostic({ trigger: 'manual' });
    assert.equal(report.traceSummary.jitterBufferMs, typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
    assert.equal(report.traceSummary.decodedDelta, 19);
    assert.equal(report.traceSummary.receivedDelta, 20);
    assert.equal(report.latency.windowMs, 5000);
    assert.equal(report.latency.metrics.inputAckRttMs.last, 42);
    assert.equal(report.latency.metrics.inputAckRttMs.count, 1);
    assert.equal(report.latency.metrics.jitterBufferMs.last, null);
    assert.equal(report.latency.metrics.jitterBufferMs.count, 0);
  }
});

test('actual core and deferred full reports project the same signaling whitelist and cache it without marks/resources', () => {
  const { context } = createDiagnosticContext();
  const failure = { scope: 'last-connect-error', failureClass: 'timeout', transport: 'websocket', engineState: 'opening',
    managerState: 'closed', socketConnected: false, socketActive: true, fallbackSelected: true, connectBudgetMs: 5000, ageMs: 7 };
  context.WebRTC.getSignalingFailureSnapshot = () => ({ ...failure, message: 'CANARY', token: 'CANARY' });
  context.WebRTC.getDataChannelWatchdogSnapshot = () => ({ phase: 'negotiation', timedOut: true });
  context.window.__WRD_STARTUP_SNAPSHOT__ = () => ({ marks: [{ name: 'start-click', atMs: 1 }],
    resources: [{ path: 'assets/core.12345678.js', durationMs: 2 }] });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'diagnostic-core.js'), 'utf8'), context);
  const core = context.window.Diagnostic.buildConnectionDiagnostic({ reason: 'signal-connect-error' });
  const fullApi = loadScript('diagnostic.js', context, 'Diagnostic');
  const full = fullApi.buildConnectionDiagnostic({ reason: 'signal-connect-error' });
  for (const report of [core, full]) {
    assert.equal(report.schemaVersion, 3); assert.equal(report.reason, 'signal-connect-error');
    assert.deepEqual(JSON.parse(JSON.stringify(report.startup.signalingFailure)), failure);
    assert.equal(Object.keys(report.startup.signalingFailure).length, 10);
    assert.equal(report.startup.marks[0].name, 'start-click'); assert.equal(report.startup.resources.length, 1);
    assert.equal(report.startup.dataChannelWatchdog.timedOut, true);
    const cached = context.runtimeDiagnosticForStorage(report);
    assert.deepEqual(JSON.parse(JSON.stringify(cached.startup.signalingFailure)), failure);
    assert.equal(cached.startup.marks, undefined); assert.equal(cached.startup.resources, undefined);
    assert.equal(JSON.stringify(report.startup).includes('CANARY'), false);
  }
});
