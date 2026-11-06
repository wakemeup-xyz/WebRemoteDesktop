const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntimeDiagnosticBuilder } = require('./runtime-diagnostic');
const sample = { schemaVersion: 3, scope: null, windowMs: 5000,
  metrics: { inputAckRttMs: { last: 42, p50: 41, p95: 90, count: 3, available: true, lastSampleAgeMs: 7 } },
  outcomes: { sent: 4, acked: 3, rejected: 0, timedOut: 1, late: 0, cancelled: 0, dropped: 0, unmatched: 0 } };
function fixture(extra = {}) { return createRuntimeDiagnosticBuilder({ nowMs: () => 100, wallNow: () => '2026-10-17T00:00:00Z',
  getScope: () => null, getBuild: () => ({ id: '0123456789abcdef', builtAt: null }),
  getInput: () => ({ inputState: {}, inputTrace: {} }), getStartup: () => ({}), getResources: () => null,
  getLatency: () => sample, ...extra }); }
test('runtime builder preserves the M1 snapshot without recalculation and captures a stable boot', () => {
  const build = fixture(); const auto = build({ reason: 'input-ack-timeout' }); const manual = build({ reason: null });
  assert.deepEqual(auto.latency.metrics, sample.metrics); assert.deepEqual(auto.latency.outcomes, sample.outcomes);
  assert.equal(auto.schemaVersion, 3); assert.equal(auto.latencyStatus, 'available');
  assert.equal(auto.captured.bootIdHash, manual.captured.bootIdHash); assert.notEqual(auto.diagnosticId, manual.diagnosticId);
  sample.metrics.inputAckRttMs.last = 999; assert.equal(auto.latency.metrics.inputAckRttMs.last, 42); sample.metrics.inputAckRttMs.last = 42;
});
test('missing collector is explicit and getter failures cannot break diagnostics', () => {
  const payload = fixture({ getLatency: undefined, getStartup() { throw Error('unavailable'); } })({});
  assert.equal(payload.latency, null); assert.equal(payload.latencyStatus, 'collector-unavailable'); assert.deepEqual(payload.startup.dataChannelWatchdog, require('./runtime-diagnostic').sanitizeDataChannelWatchdog(null));
});

test('diagnostic admission sanitizer keeps only bounded delivery counters', () => {
  const { sanitizeDiagnosticAdmission } = require('./runtime-diagnostic');
  const clean = sanitizeDiagnosticAdmission({
    types: { frame_timing: { sent: 4, dropped: 2 }, capture_stats: { sent: 1, dropped: 0 } },
    reasons: { congested: 2, pressure: 3, send_error: 1 }, legacyDropped: { ids: 3, metadata: 4 },
    pressureActive: true,
    privatePayload: 'CANARY',
  });
  assert.equal(clean.types.frame_timing.sent, 4);
  assert.equal(clean.types.frame_timing.dropped, 2);
  assert.equal(clean.reasons.congested, 2);
  assert.equal(clean.reasons.pressure, 3);
  assert.equal(clean.pressureActive, true);
  assert.deepEqual(clean.legacyDropped, { ids: 3, metadata: 4 });
  assert.equal(JSON.stringify(clean).includes('CANARY'), false);
  assert.equal(sanitizeDiagnosticAdmission({ types: { frame_timing: { sent: -1 } } }).types.frame_timing.sent, null);
});

test('closed scopes drain once into a bounded queue; failure replay retains IDs and cancelled outcomes', () => {
  let drains = 0; let now = 100;
  const old = [ { endedAtMs: 90, snapshot: { ...sample, outcomes: { ...sample.outcomes, cancelled: 2 } } },
    { endedAtMs: 95, snapshot: { ...sample, outcomes: { ...sample.outcomes, sent: 10 } } } ];
  const build = fixture({ nowMs: () => now, takeClosedScopeSummaries: () => { drains++; return { summaries: drains === 1 ? old : [], dropped: 1 }; } });
  const failure = build({ reason: 'pc-failed' });
  const replay = JSON.parse(JSON.stringify(failure)); // Wire retry never calls producer.
  assert.equal(drains, 1); assert.deepEqual(replay, failure);
  assert.equal(failure.scopeEnded.events[0].snapshot.outcomes.cancelled, 2);
  assert.equal(failure.latency.outcomes.sent, 4); // old scope outcomes do not pollute current.
  build.acknowledge([failure.scopeEnded.events[0].eventIdHash]);
  now = 110; const next = build({});
  assert.equal(next.scopeEnded.events.length, 1); assert.equal(next.scopeEnded.events[0].eventIdHash, failure.scopeEnded.events[1].eventIdHash);
  now = 60100; assert.equal(build({}).scopeEnded.events.length, 0);
});
test('scope queue enforces 4 events, 60s and 32KiB and exposes loss', () => {
  let closed = Array.from({ length: 6 }, (_, i) => ({ endedAtMs: 99 - i, snapshot: sample }));
  const build = fixture({ takeClosedScopeSummaries: () => { const summaries = closed; closed = []; return { summaries, dropped: summaries.length === 6 ? 3 : 0 }; } });
  const result = build({}); assert.equal(result.scopeEnded.events.length, 4); assert.equal(result.scopeEnded.dropped, 5);
  closed = [{ endedAtMs: 0, snapshot: { ...sample, extra: 'x'.repeat(33 * 1024) } }];
  const large = build({}); assert.equal(large.scopeEnded.events.length, 0); assert.equal(large.scopeEnded.dropped, 10);
});
test('report clipping preserves required schema/capture/build and the M1 metrics', () => {
  const build = fixture({ getInput: () => ({ inputTrace: { events: Array.from({ length: 300 }, () => ({ at: 99, extra: 'x'.repeat(1000) })) } }),
    getStartup: () => ({ extra: 'x'.repeat(200 * 1024) }) });
  const payload = build({ reason: 'pc-failed' });
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 128 * 1024); assert.ok(payload.truncation.dropped > 0);
  assert.equal(payload.schemaVersion, 3); assert.equal(payload.reason, 'pc-failed'); assert.ok(payload.captured.bootIdHash);
  assert.equal(payload.build.id, '0123456789abcdef'); assert.deepEqual(payload.latency.metrics, sample.metrics);
  assert.ok((payload.inputTrace.events || []).length <= 256);
});

test('confirming a shared closed scope removes it from other captures without claiming loss', () => {
  let drained = false;
  const build = fixture({ takeClosedScopeSummaries: () => {
    const summaries = drained ? [] : [{ endedAtMs: 90, snapshot: sample }]; drained = true;
    return { summaries, dropped: 0 };
  } });
  const first = build({ reason: 'pc-failed' }); const second = build({ reason: 'dc-error' });
  assert.equal(first.scopeEnded.events[0].eventIdHash, second.scopeEnded.events[0].eventIdHash);
  build.acknowledge([first.scopeEnded.events[0].eventIdHash]);
  const retry = build.prepareReplay(second);
  assert.equal(retry.scopeEnded.events.length, 0); assert.equal(retry.scopeEnded.dropped, 0);
  assert.equal(retry.diagnosticId, second.diagnosticId); assert.deepEqual(retry.captured, second.captured);
  assert.deepEqual(retry.latency, second.latency);
});

test('expired and unknown closed scopes still report genuine loss during replay', () => {
  let now = 100; let drained = false;
  const build = fixture({ nowMs: () => now, takeClosedScopeSummaries: () => {
    const summaries = drained ? [] : [{ endedAtMs: 90, snapshot: sample }]; drained = true; return { summaries, dropped: 0 };
  } });
  const captured = build({}); now = 60100;
  const expired = build.prepareReplay(captured);
  assert.equal(expired.scopeEnded.events.length, 0); assert.equal(expired.scopeEnded.dropped, 1);
  const unknown = fixture().prepareReplay(captured);
  assert.equal(unknown.scopeEnded.events.length, 0); assert.equal(unknown.scopeEnded.dropped, 1);
});

test('watchdog shared sanitizer, builder and storage retain only fourteen bounded fields', () => {
  const { sanitizeDataChannelWatchdog, runtimeDiagnosticForStorage } = require('./runtime-diagnostic');
  const hostile = { phase: 'negotiation', timedOut: true, elapsedMs: 30000, remainingMs: 0, extensions: 2,
    pcState: 'new', iceState: 'checking', signalingState: 'have-local-offer', sctpState: 'connecting',
    inputState: 'connecting', moveState: 'open', socketConnected: true, localDescriptionSet: true, remoteDescriptionSet: false,
    secret: 'PASSWORD_CANARY', url: 'https://SECRET_CANARY', sdp: 'SDP_CANARY' };
  const clean = sanitizeDataChannelWatchdog(hostile); assert.equal(Object.keys(clean).length, 14);
  assert.ok(Buffer.byteLength(JSON.stringify(clean)) < 1024);
  const payload = fixture({ getStartup: () => ({ marks: [{ name: 'core-interactive', atMs: 3 }], dataChannelWatchdog: hostile }) })({ reason: 'negotiation-timeout' });
  assert.deepEqual(payload.startup.dataChannelWatchdog, clean); assert.equal(payload.startup.marks.length, 1);
  const stored = runtimeDiagnosticForStorage(payload); assert.deepEqual(stored.startup.dataChannelWatchdog, clean);
  assert.equal(JSON.stringify(stored).includes('CANARY'), false);
  const bad = sanitizeDataChannelWatchdog({ ...hostile, phase: 'SECRET_CANARY', pcState: 'SECRET_CANARY',
    elapsedMs: Infinity, remainingMs: 30001, extensions: 3, remoteDescriptionSet: 'PASSWORD_CANARY' });
  assert.equal(bad.phase, 'inactive'); assert.equal(bad.pcState, null); assert.equal(bad.elapsedMs, null);
  assert.equal(bad.remainingMs, null); assert.equal(bad.extensions, 0); assert.equal(bad.remoteDescriptionSet, null);
  const throwing = new Proxy({}, { get() { throw Error('SECRET_CANARY'); } });
  assert.deepEqual(sanitizeDataChannelWatchdog(throwing), sanitizeDataChannelWatchdog(null));
});

const { sanitizeSignalingFailure, runtimeDiagnosticForStorage } = require('./runtime-diagnostic');
const signalingFailure = { scope: 'last-connect-error', failureClass: 'timeout', transport: 'websocket',
  engineState: 'opening', managerState: 'closed', socketConnected: false, socketActive: true,
  fallbackSelected: true, connectBudgetMs: 5000, ageMs: 12 };
test('shared signaling whitelist has exactly ten bounded safe fields and tolerates hostile getters', () => {
  assert.equal(sanitizeSignalingFailure(null), null);
  const clean = sanitizeSignalingFailure({ ...signalingFailure, message: 'CANARY', token: 'CANARY' });
  assert.deepEqual(clean, signalingFailure); assert.equal(Object.keys(clean).length, 10);
  assert.ok(Buffer.byteLength(JSON.stringify(clean)) < 1024);
  const hostile = Object.fromEntries(Object.keys(signalingFailure).map(key => [key, 'CANARY']));
  for (const key of Object.keys(hostile)) Object.defineProperty(hostile, key, { get() { throw Error('CANARY'); } });
  const safe = sanitizeSignalingFailure(hostile);
  assert.deepEqual(safe, { scope: 'last-connect-error', failureClass: 'unknown', transport: 'unknown',
    engineState: 'unknown', managerState: 'unknown', socketConnected: null, socketActive: null,
    fallbackSelected: null, connectBudgetMs: null, ageMs: null });
  for (const ageMs of [-1, NaN, Infinity, '12', 3600001]) assert.equal(sanitizeSignalingFailure({ ...clean, ageMs }).ageMs, null);
  for (const connectBudgetMs of [-1, NaN, Infinity, '5000', 30001]) assert.equal(sanitizeSignalingFailure({ ...clean, connectBudgetMs }).connectBudgetMs, null);
  assert.equal(sanitizeSignalingFailure({ ...clean, ageMs: 3600000, connectBudgetMs: 30000 }).ageMs, 3600000);
});

test('runtime, cache and oversized clipping retain signaling evidence alongside watchdog under existing startup policy', () => {
  const marks = [{ name: 'start-click', atMs: 1 }]; const resources = [{ path: 'assets/core.12345678.js', durationMs: 2 }];
  const startup = { signalingFailure: { ...signalingFailure, message: 'CANARY' }, marks, resources,
    dataChannelWatchdog: { phase: 'negotiation', timedOut: true } };
  const build = fixture({ getStartup: () => startup });
  const report = build({ reason: 'signal-connect-error' });
  assert.equal(report.reason, 'signal-connect-error'); assert.deepEqual(report.startup.signalingFailure, signalingFailure);
  assert.deepEqual(report.startup.marks, marks); assert.deepEqual(report.startup.resources, resources);
  const cached = runtimeDiagnosticForStorage(report);
  assert.deepEqual(cached.startup.signalingFailure, signalingFailure); assert.equal(cached.startup.dataChannelWatchdog.timedOut, true);
  assert.equal(cached.startup.marks, undefined); assert.equal(cached.startup.resources, undefined);
  startup.extra = 'x'.repeat(150 * 1024);
  const clipped = build({ reason: 'signal-connect-error' });
  assert.deepEqual(clipped.startup.signalingFailure, signalingFailure); assert.equal(clipped.startup.dataChannelWatchdog.timedOut, true);
  assert.equal(clipped.startup.marks, undefined); assert.equal(clipped.startup.resources, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(clipped)) <= 128 * 1024);
  assert.equal(JSON.stringify([report, cached, clipped]).includes('CANARY'), false);
  assert.equal(fixture()({}).startup.signalingFailure, null);
});

test('pending diagnostic storage preserves bounded log receipt state without log content', () => {
  const { runtimeDiagnosticForStorage } = require('./runtime-diagnostic');
  const report = fixture()({ reason: 'input-ack-timeout' });
  report.logReceipt = { state: 'valid', reported: 12, retained: 0, redacted: 12, dropped: 0 };
  report.logs = ['PRIVATE_LOG_CANARY'];
  const cached = runtimeDiagnosticForStorage(report);
  assert.deepEqual(cached.logReceipt, report.logReceipt);
  assert.equal('logs' in cached, false);
  assert.equal(JSON.stringify(cached).includes('PRIVATE_LOG_CANARY'), false);
});

test('pending diagnostic storage preserves bounded frame correlation counters', () => {
  const { runtimeDiagnosticForStorage } = require('./runtime-diagnostic');
  const report = fixture()({ reason: 'input-ack-timeout' });
  report.traceSummary = { frameTrace: { acceptanceState: 'UNALIGNED', matchedCount: 4, droppedTraceCount: 2 } };
  const cached = runtimeDiagnosticForStorage(report);
  assert.deepEqual(cached.traceSummary.frameTrace, {
    acceptanceState: 'UNALIGNED', pendingFrames: null, pendingTraces: null,
    seenIdentities: null, matchedCount: 4, droppedTraceCount: 2,
    invalidBatchCount: null, staleTraceCount: null, conflictingTraceCount: null,
  });
});

test('runtime clipping upgrades a log receipt to truncated', () => {
  const { boundRuntimeDiagnostic } = require('./runtime-diagnostic');
  const clipped = boundRuntimeDiagnostic({ schemaVersion: 3, diagnosticId: 'a'.repeat(32), logs: ['x'],
    logReceipt: { state: 'valid', reported: 1, retained: 0, redacted: 1, dropped: 0 },
    truncation: { dropped: 2 } });
  assert.deepEqual(clipped.logReceipt, { state: 'truncated', reported: 1, retained: 0, redacted: 1, dropped: 2 });
});
