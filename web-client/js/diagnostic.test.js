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
    classList: {
      add() {},
      remove() {},
    },
    focus() {},
    setAttribute() {},
    addEventListener(type, handler) {
      this[`on${type}`] = handler;
    },
  };
}

function loadScript(filename, context, exportName) {
  const source = fs.readFileSync(path.join(__dirname, filename), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__exported = ${exportName};`, context);
  return context.__exported;
}

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
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => fn(),
    performance: { now: () => 123.4 },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
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
  return { context, elements, storage: context.localStorage };
}

test('diagnostic button opens modal and fills keyboard debug output', () => {
  const { context, elements } = createDiagnosticContext();

  const Input = loadScript('input.js', context, 'Input');
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');
  Input._keyboardDebugEntries = ['entry-1', 'entry-2'];
  Diagnostic.logs = ['log-1'];

  assert.doesNotThrow(() => {
    elements.get('diagBtn').onclick();
  });
  assert.equal(elements.get('diagLogArea').value, 'log-1');
  assert.equal(elements.get('keyboardDebugArea').value, 'entry-1\nentry-2');
});


test('sendLogs includes keyboard mode, input state, and channel timeline', () => {
  const { context, elements } = createDiagnosticContext();
  const emitted = [];
  context.WebRTC.socket = { connected: true, emit(event, payload) { emitted.push({ event, payload }); } };

  const Input = loadScript('input.js', context, 'Input');
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');

  Input.keyboardMode = 'windows';
  Input._keyboardDebugEntries = ['kbd-1'];
  Input.releaseAllKeys('window-blur', true);
  Diagnostic.logs = [
    '[10:00:00] [LOG] [INPUT-DC] DataChannel open',
    '[10:00:01] [WRN] [INPUT-DC] DataChannel error: {"isTrusted":true}',
    '[10:00:02] [LOG] [INPUT-DC] DataChannel closed, sctp=connected pc=connected ice=completed'
  ];

  Diagnostic.sendLogs();

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'diagnostic');
  assert.equal(emitted[0].payload.keyboardMode, 'windows');
  assert.equal(Array.isArray(emitted[0].payload.keyboardDebug), true);
  assert.equal(emitted[0].payload.keyboardDebug.length, 0);
  assert.equal(emitted[0].payload.inputState.pendingKeys, 0);
  assert.equal(emitted[0].payload.inputState.lastReleaseAllReason, 'window-blur');
  assert.equal(emitted[0].payload.inputChannelTimeline.length, 3);
  assert.equal(emitted[0].payload.inputChannelTimeline[0].kind, 'open');
  assert.equal(emitted[0].payload.inputChannelTimeline[1].kind, 'error');
  assert.equal(emitted[0].payload.inputChannelTimeline[2].kind, 'close');
});

test('buildConnectionDiagnostic returns redacted schema v2 payload from current trace data', () => {
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
  assert.equal(payload.schemaVersion, 2);
  assert.equal(Array.isArray(payload.events), true);
  assert.equal(Array.isArray(payload.probeResults), true);
  assert.equal(payload.redaction.sdp, 'omitted');
  assert.equal(payload.redaction.tokens, 'omitted');
  assert.equal(payload.traceSummary.trigger, 'auto-failure');
  assert.equal(payload.traceSummary.reason, 'candidate-check-failed');
  assert.equal(payload.events[0].data.url, '[redacted-url]');
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

test('replayPendingDiagnostics replays at most two queued diagnostics and removes them', async () => {
  const { context, storage } = createDiagnosticContext();
  const emitted = [];
  context.WebRTC.socket = { connected: true, emit(event, payload) { emitted.push({ event, payload }); } };
  storage.setItem('wrdPendingDiagnostics', JSON.stringify([
    { connectionAttemptId: 'wrd-1' },
    { connectionAttemptId: 'wrd-2' },
    { connectionAttemptId: 'wrd-3' },
  ]));
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');

  const replayed = await Diagnostic.replayPendingDiagnostics(context.WebRTC.socket);

  assert.equal(replayed, 2);
  assert.equal(emitted.length, 2);
  assert.equal(emitted[0].payload.connectionAttemptId, 'wrd-1');
  assert.equal(emitted[1].payload.connectionAttemptId, 'wrd-2');
  assert.deepEqual(JSON.parse(storage.getItem('wrdPendingDiagnostics')), [{ connectionAttemptId: 'wrd-3' }]);
});

test('sendConnectionDiagnostic falls back to fetch when socket is unavailable', async () => {
  const requests = [];
  const { context, storage } = createDiagnosticContext({
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 204 };
    },
  });
  context.WebRTC.socket = { connected: false, emit() { throw new Error('should not be used'); } };
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');

  const ok = await Diagnostic.sendConnectionDiagnostic({ trigger: 'policy-violation', reason: 'relay-not-allowed' });

  assert.equal(ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/diagnostics');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers['Content-Type'], 'application/json');
  assert.equal(storage.getItem('wrdPendingDiagnostics'), null);
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
    console,
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
            localAddress: '203.0.113.1:5000',
            remoteAddress: '2001:db8::1:6000',
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
