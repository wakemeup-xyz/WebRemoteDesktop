const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createLatencyMonitor, LATENCY_METRIC_NAMES } = require('./latency-monitor');
const { redactLatency } = require('../../signal-server/lib/diagnostic');
const { createDiagnosticStore } = require('../../signal-server/lib/diagnostic-store');

test('ACK arrival timing uses the shared Signal redactor whitelist and persists in a private store', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-ack-arrival-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 0;
  const scope = { connectionAttemptId: 'PRIVATE_ATTEMPT_CANARY', generation: 1, leaseEpoch: 2 };
  const monitor = createLatencyMonitor({ now: () => now });
  monitor.setScope(scope); monitor.recordInputSend('PRIVATE_INPUT_CANARY'); now = 140;
  monitor.onInputAck({ status: 'applied', inputIds: ['PRIVATE_INPUT_CANARY'] }, { scope, arrivalAtMs: 100 });
  const snapshot = monitor.snapshot();
  snapshot.metrics.privateUnexpectedMetric = { last: 999, count: 1 };
  const redacted = redactLatency(snapshot);
  assert.deepEqual(Object.keys(redacted.metrics), LATENCY_METRIC_NAMES);
  assert.equal(redacted.metrics.inputAckRttMs.last, 140);
  assert.equal(redacted.metrics.inputAckArrivalRttMs.last, 100);
  assert.equal(redacted.metrics.inputAckValidationMs.last, 40);
  assert.equal(Object.hasOwn(redacted.metrics, 'privateUnexpectedMetric'), false);
  const wall = Date.UTC(2026, 9, 25);
  // Explicit private dir avoids every global/default diagnostic persistence API.
  const store = createDiagnosticStore({ dir, now: () => wall });
  const result = store.write({ schemaVersion: 3, diagnosticId: 'a'.repeat(32),
    receivedAt: new Date(wall).toISOString(), viewerId: 'arrival-test-viewer', latency: redacted });
  assert.equal(result.persisted, true);
  const rawFiles = fs.readdirSync(path.join(dir, 'raw')).filter(name => name.endsWith('.json'));
  assert.equal(rawFiles.length, 1);
  const raw = fs.readFileSync(path.join(dir, 'raw', rawFiles[0]), 'utf8');
  const persisted = JSON.parse(raw);
  for (const name of ['inputAckArrivalRttMs', 'inputAckValidationMs']) {
    assert.deepEqual(persisted.latency.metrics[name], redacted.metrics[name]);
    assert.equal(persisted.latency.metrics[name].count, 1);
  }
  assert.equal(raw.includes('PRIVATE_ATTEMPT_CANARY'), false);
  assert.equal(raw.includes('PRIVATE_INPUT_CANARY'), false);
  assert.equal(raw.includes('privateUnexpectedMetric'), false);
  assert.deepEqual(createDiagnosticStore({ dir, now: () => wall }).recent(1)[0].latency, redacted);
});
