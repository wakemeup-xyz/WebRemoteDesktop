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
  assert.equal(payload.latency, null); assert.equal(payload.latencyStatus, 'collector-unavailable'); assert.deepEqual(payload.startup, {});
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
