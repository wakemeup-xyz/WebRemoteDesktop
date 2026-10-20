const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRuntimeDiagnosticBuilder, sanitizeSignalingFailure } = require('../../web-client/js/runtime-diagnostic');
const { ingestDiagnosticPayload } = require('../lib/diagnostic');

test('server persisted runtime signaling failure has exact whitelist, fixed reason, startup marks/watchdog and durable replay receipt', () => {
  const previous = process.env.WRD_DIAG_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-signaling-private-'));
  process.env.WRD_DIAG_DIR = dir;
  try {
    const failure = { scope: 'last-connect-error', failureClass: 'timeout', transport: 'websocket', engineState: 'opening',
      managerState: 'closed', socketConnected: false, socketActive: true, fallbackSelected: true, connectBudgetMs: 5000, ageMs: 0 };
    const payload = createRuntimeDiagnosticBuilder({ getStartup: () => ({ signalingFailure: failure,
      dataChannelWatchdog: { phase: 'negotiation', timedOut: true }, marks: [{ name: 'start-click', atMs: 2 }],
      resources: [{ path: 'assets/core.12345678.js', durationMs: 3 }] }) })({ reason: 'signal-connect-error' });
    Object.assign(payload.startup.signalingFailure, { message: 'CANARY', url: 'CANARY', token: 'CANARY', context: 'CANARY' });
    const ingest = () => ingestDiagnosticPayload({ role: 'viewer', viewerId: 'offline-unit', data: payload,
      config: { enableDiagPersist: true }, logger: {} });
    const result = ingest(); assert.equal(result.persisted, true); assert.equal(result.receipt.accepted, true);
    assert.equal(result.report.reason, 'signal-connect-error'); assert.equal(result.receipt.diagnosticId, payload.diagnosticId);
    const reports = fs.readdirSync(path.join(dir, 'raw')).map(name => JSON.parse(fs.readFileSync(path.join(dir, 'raw', name), 'utf8')));
    const report = reports.find(item => item.diagnosticId === payload.diagnosticId);
    assert.deepEqual(report.startup.signalingFailure, sanitizeSignalingFailure(failure));
    assert.equal(Object.keys(report.startup.signalingFailure).length, 10);
    assert.equal(report.startup.dataChannelWatchdog.timedOut, true);
    assert.deepEqual(report.startup.marks, [{ name: 'start-click', atMs: 2 }]);
    assert.deepEqual(report.startup.resources, [{ path: 'assets/core.12345678.js', durationMs: 3 }]);
    assert.equal(JSON.stringify(reports).includes('CANARY'), false); assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 128 * 1024);
    const replay = ingest(); assert.equal(replay.duplicate, true); assert.deepEqual(replay.receipt, result.receipt);
  } finally {
    if (previous === undefined) delete process.env.WRD_DIAG_DIR; else process.env.WRD_DIAG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
