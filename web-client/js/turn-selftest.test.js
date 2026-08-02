const assert = require('node:assert/strict');
const test = require('node:test');

const TurnSelfTest = require('./turn-selftest.js');

test('classify: no turn servers => turn-config-missing', () => {
  const result = TurnSelfTest.classifyConfig({
    turnConfigured: false,
    turnMisconfigured: false,
    turnServers: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'turn-config-missing');
});

test('classify: partial config => turn-config-partial', () => {
  const result = TurnSelfTest.classifyConfig({
    turnConfigured: false,
    turnMisconfigured: true,
    turnServers: [{ urls: ['turn:example.com:3478'], username: 'x' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'turn-config-partial');
});

test('classify: zero relay candidates after gather => turn-allocate-failed', () => {
  const result = TurnSelfTest.classifyAllocate({
    relayCandidateCount: 0,
    timedOut: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'turn-allocate-failed');
});

test('classify: fingerprint mismatch => turn-fingerprint-mismatch', () => {
  const result = TurnSelfTest.classifyFingerprint({
    viewerFingerprint: 'aaa',
    hostFingerprint: 'bbb',
    hostTurnReady: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'turn-fingerprint-mismatch');
});

test('classify: host not ready => turn-host-not-ready', () => {
  const result = TurnSelfTest.classifyFingerprint({
    viewerFingerprint: 'aaa',
    hostFingerprint: '',
    hostTurnReady: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'turn-host-not-ready');
});

test('summarize includes step statuses without secrets', () => {
  const summary = TurnSelfTest.summarize([
    { step: 'config', ok: true, code: 'turn-config-ok', detail: 'ok' },
    { step: 'allocate', ok: false, code: 'turn-allocate-failed', detail: 'none' },
  ]);
  assert.equal(summary.ok, false);
  assert.equal(summary.failedCode, 'turn-allocate-failed');
  assert.match(summary.message, /FAIL turn-allocate-failed/);
  assert.equal(summary.steps.length, 2);
  assert.ok(!JSON.stringify(summary).includes('password'));
  assert.ok(!JSON.stringify(summary).includes('credential'));
});

test('run short-circuits before allocate when config missing', async () => {
  const summary = await TurnSelfTest.run({
    iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
    turnConfigured: false,
    skipAllocate: false,
  });
  assert.equal(summary.ok, false);
  assert.equal(summary.failedCode, 'turn-config-missing');
  assert.equal(summary.steps.some((step) => step.step === 'allocate'), false);
});

test('run reports allocate ok with injectable PC factory', async () => {
  class FakePC {
    constructor() {
      this.listeners = {};
      this.iceGatheringState = 'new';
    }
    createDataChannel() { return {}; }
    async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
    async setLocalDescription() {
      queueMicrotask(() => {
        const handler = this.listeners.icecandidate || [];
        handler.forEach((fn) => fn({
          candidate: { candidate: 'candidate:1 1 UDP 1 1.1.1.1 3478 typ relay raddr 0.0.0.0 rport 0' },
        }));
        handler.forEach((fn) => fn({ candidate: null }));
        this.iceGatheringState = 'complete';
        (this.listeners.icegatheringstatechange || []).forEach((fn) => fn());
      });
    }
    addEventListener(name, fn) {
      this.listeners[name] = this.listeners[name] || [];
      this.listeners[name].push(fn);
    }
    close() {}
  }

  const summary = await TurnSelfTest.run({
    iceServers: [{
      urls: ['turn:relay.example.com:3478'],
      username: 'u',
      credential: 'p',
    }],
    turnConfigured: true,
    turnFingerprint: 'abc',
    hostTurnReady: true,
    hostTurnFingerprint: 'abc',
    RTCPeerConnectionImpl: FakePC,
    timeoutMs: 1000,
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.failedCode, null);
  const allocate = summary.steps.find((step) => step.step === 'allocate');
  assert.equal(allocate.ok, true);
  assert.equal(allocate.relayCandidateCount, 1);
});

test('runServerProbe posts turnServerId when provided', async () => {
  let captured = null;
  const result = await TurnSelfTest.runServerProbe({
    apiBase: 'http://example.test',
    token: 'tok',
    timeoutMs: 1234,
    turnServerId: 'overseas',
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return {
        status: 200,
        async json() {
          return {
            ok: true,
            code: 'turn-allocate-ok',
            reason: 'complete',
            relayCandidateCount: 2,
            durationMs: 11,
            fingerprintMatch: true,
            turnServerId: 'overseas',
          };
        },
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(captured.url, 'http://example.test/api/turn-selftest');
  const body = JSON.parse(captured.options.body);
  assert.equal(body.turnServerId, 'overseas');
  assert.equal(body.timeoutMs, 1234);
});
