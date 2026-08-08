const assert = require('node:assert/strict');
const test = require('node:test');

const { createTerminalSessionManager } = require('../lib/terminal/session-manager');
const { TerminalMetrics } = require('../lib/terminal/metrics');

const COUNTER_NAMES = [
  'auth_success',
  'auth_rejected',
  'socket_connected',
  'socket_disconnected',
  'session_created',
  'session_attach',
  'session_detach',
  'session_closed',
  'pty_spawn_failed',
  'pty_startup_timeout',
  'pty_exited',
  'input_accepted',
  'input_rate_limited',
  'input_rejected',
  'output_bytes',
  'output_chunks',
  'output_backpressure',
];

const LATENCY_NAMES = ['attach_ms', 'pty_ready_ms', 'server_input_process_ms'];
const TRANSPORT_NAMES = ['websocket', 'polling'];
const TRANSPORT_LATENCY_NAMES = ['socket_rtt_ms', 'input_ack_rtt_ms'];

function emptyLatency() {
  return {
    sampleCount: 0,
    p50: null,
    p95: null,
    last: null,
  };
}

function createFakePty() {
  const dataHandlers = [];
  const exitHandlers = [];
  return {
    writes: [],
    onData(handler) {
      dataHandlers.push(handler);
    },
    onExit(handler) {
      exitHandlers.push(handler);
    },
    write(data) {
      this.writes.push(data);
    },
    resize() {},
    kill() {},
    emitData(data) {
      dataHandlers.forEach((handler) => handler(data));
    },
    emitExit(payload) {
      exitHandlers.forEach((handler) => handler(payload));
    },
  };
}

function managerConfig(overrides = {}) {
  return {
    enableTerminal: true,
    terminalAdminPassword: 'terminal-admin-password',
    terminalShell: '/bin/zsh',
    terminalCwd: '/tmp',
    terminalMaxSessions: 8,
    terminalReplayBufferBytes: 262144,
    terminalIdleTimeoutMs: 0,
    terminalStartupTimeoutMs: 10000,
    terminalInputBytesPerSecond: 1,
    terminalInputBurstBytes: 1,
    terminalMaxObserverQueueBytes: 524288,
    terminalRecordIoMetadata: true,
    ...overrides,
  };
}

test('TerminalMetrics exposes only fixed counters and bounded latency summaries', () => {
  const metrics = new TerminalMetrics();

  assert.deepEqual(metrics.snapshot(), {
    counters: Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0])),
    latencies: Object.fromEntries(LATENCY_NAMES.map((name) => [name, {
      ...emptyLatency(),
    }])),
    transports: Object.fromEntries(TRANSPORT_NAMES.map((transport) => [transport, {
      latencies: Object.fromEntries(TRANSPORT_LATENCY_NAMES.map((name) => [name, emptyLatency()])),
    }])),
  });
});

test('TerminalMetrics ignores unknown names and invalid numeric values consistently', () => {
  const metrics = new TerminalMetrics();

  assert.equal(metrics.recordCounter('output_bytes', 12), true);
  assert.equal(metrics.recordLatency('attach_ms', 8), true);
  assert.equal(metrics.recordTransportLatency('socket_rtt_ms', 'websocket', 12), true);
  assert.equal(metrics.recordCounter('password', 1), false);
  assert.equal(metrics.recordLatency('token', 1), false);
  assert.equal(metrics.recordTransportLatency('socket_rtt_ms', 'polling', 15), true);
  assert.equal(metrics.recordTransportLatency('socket_rtt_ms', 'quic', 15), false);
  assert.equal(metrics.recordCounter('output_bytes', -1), false);
  assert.equal(metrics.recordCounter('output_bytes', Number.POSITIVE_INFINITY), false);
  assert.equal(metrics.recordLatency('attach_ms', Number.NaN), false);
  assert.equal(metrics.recordLatency('attach_ms', -1), false);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.output_bytes, 12);
  assert.deepEqual(snapshot.latencies.attach_ms, {
    sampleCount: 1,
    p50: 8,
    p95: 8,
    last: 8,
  });
  assert.equal(snapshot.transports.websocket.latencies.socket_rtt_ms.last, 12);
  assert.equal(snapshot.transports.polling.latencies.socket_rtt_ms.last, 15);
  assert.equal(JSON.stringify(snapshot).includes('password'), false);
  assert.equal(JSON.stringify(snapshot).includes('token'), false);
});

test('TerminalMetrics retains the latest 100 samples with deterministic nearest-rank percentiles', () => {
  const metrics = new TerminalMetrics();

  for (let value = 1; value <= 101; value += 1) {
    assert.equal(metrics.recordLatency('pty_ready_ms', value), true);
  }

  assert.deepEqual(metrics.snapshot().latencies.pty_ready_ms, {
    sampleCount: 100,
    p50: 51,
    p95: 96,
    last: 101,
  });
});

test('TerminalMetrics never stores raw metadata arguments', () => {
  const metrics = new TerminalMetrics();
  const secret = {
    data: 'SECRET_DATA',
    key: 'SECRET_KEY',
    text: 'SECRET_TEXT',
    password: 'SECRET_PASSWORD',
    token: 'SECRET_TOKEN',
  };

  metrics.recordCounter('input_accepted', 1, secret);
  metrics.recordLatency('server_input_process_ms', 2, secret);

  assert.equal(JSON.stringify(metrics.snapshot()).includes('SECRET_'), false);
});

test('session manager records lifecycle, IO, and attach metrics exactly once', async () => {
  let nowMs = 0;
  const metrics = new TerminalMetrics();
  const pty = createFakePty();
  const manager = createTerminalSessionManager({
    metrics,
    now: () => new Date(nowMs),
    outputSchedule: (drain) => drain(),
    ptyFactory: () => pty,
    audit: { info() {}, warn() {}, error() {} },
    config: managerConfig(),
  });
  const created = await manager.createSession({
    clientId: 'creator',
    socketId: 'socket-a',
    onData() {},
  });
  nowMs = 5;
  pty.emitData('ok');
  manager.attachSession(created.sessionId, {
    clientId: 'observer',
    socketId: 'socket-b',
    onData() {},
  });
  manager.writeInput(created.sessionId, {
    clientId: 'creator',
    socketId: 'socket-a',
    data: 'x',
  });
  assert.throws(() => manager.writeInput(created.sessionId, {
    clientId: 'creator',
    socketId: 'socket-a',
    data: 'SECRET_INPUT',
  }), { code: 'terminal_input_rate_limited' });
  manager.detachObserver(created.sessionId, {
    clientId: 'observer',
    socketId: 'socket-b',
  });
  pty.emitExit({ exitCode: 0, signal: 0 });
  await manager.closeSession(created.sessionId, {
    clientId: 'creator',
    socketId: 'socket-a',
  });

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.session_created, 1);
  assert.equal(snapshot.counters.session_attach, 1);
  assert.equal(snapshot.counters.session_detach, 1);
  assert.equal(snapshot.counters.session_closed, 1);
  assert.equal(snapshot.counters.pty_exited, 1);
  assert.equal(snapshot.counters.input_accepted, 1);
  assert.equal(snapshot.counters.input_rate_limited, 1);
  assert.equal(snapshot.counters.output_bytes, 2);
  assert.equal(snapshot.counters.output_chunks, 1);
  assert.equal(snapshot.latencies.pty_ready_ms.last, 5);
  assert.equal(snapshot.latencies.attach_ms.sampleCount, 1);
  assert.equal(JSON.stringify(snapshot).includes('SECRET_INPUT'), false);
});

test('session manager records spawn failure and startup timeout once', async () => {
  const metrics = new TerminalMetrics();
  const spawnFailureManager = createTerminalSessionManager({
    metrics,
    ptyFactory() {
      throw new Error('spawn SECRET_VALUE');
    },
    audit: { info() {}, warn() {}, error() {} },
    config: managerConfig(),
  });
  await assert.rejects(
    () => spawnFailureManager.createSession({ clientId: 'creator' }),
    { code: 'pty_spawn_failed' },
  );

  let startupCallback = null;
  const timeoutManager = createTerminalSessionManager({
    metrics,
    ptyFactory: () => createFakePty(),
    setTimeout(callback) {
      startupCallback = callback;
      return { unref() {} };
    },
    clearTimeout() {},
    audit: { info() {}, warn() {}, error() {} },
    config: managerConfig(),
  });
  await timeoutManager.createSession({ clientId: 'creator' });
  await startupCallback();

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.pty_spawn_failed, 1);
  assert.equal(snapshot.counters.pty_startup_timeout, 1);
  assert.equal(JSON.stringify(snapshot).includes('SECRET_VALUE'), false);
});

test('session manager records output backpressure once without raw output', async () => {
  const metrics = new TerminalMetrics();
  const pty = createFakePty();
  const manager = createTerminalSessionManager({
    metrics,
    ptyFactory: () => pty,
    outputSchedule: (drain) => drain(),
    audit: { info() {}, warn() {}, error() {} },
    config: managerConfig({ terminalMaxObserverQueueBytes: 1 }),
  });
  await manager.createSession({
    clientId: 'slow',
    socketId: 'slow-socket',
    onData(_data, _metadata, _acknowledge) {},
    onWarning() {},
  });
  pty.emitData('x');
  pty.emitData('SECRET_OUTPUT');

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.output_bytes, Buffer.byteLength('xSECRET_OUTPUT', 'utf8'));
  assert.equal(snapshot.counters.output_chunks, 2);
  assert.equal(snapshot.counters.output_backpressure, 1);
  assert.equal(snapshot.counters.session_detach, 1);
  assert.equal(JSON.stringify(snapshot).includes('SECRET_OUTPUT'), false);
});
