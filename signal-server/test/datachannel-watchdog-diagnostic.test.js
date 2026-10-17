const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRuntimeDiagnosticBuilder, sanitizeDataChannelWatchdog } = require('../../web-client/js/runtime-diagnostic');
const { ingestDiagnosticPayload } = require('../lib/diagnostic');
test('actual runtime persistence preserves watchdog whitelist and matching replay receipt in private temporary files', () => {
  const previous = process.env.WRD_DIAG_DIR; const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-watchdog-private-'));
  process.env.WRD_DIAG_DIR = dir;
  try {
    const watchdog = { phase: 'negotiation', timedOut: true, elapsedMs: 30000, remainingMs: 0, extensions: 0,
      pcState: 'new', iceState: 'new', signalingState: 'have-local-offer', sctpState: 'connecting',
      inputState: 'closed', moveState: 'connecting', socketConnected: true, localDescriptionSet: true, remoteDescriptionSet: false };
    const payload = createRuntimeDiagnosticBuilder({ getStartup: () => ({ dataChannelWatchdog: watchdog }) })({ reason: 'negotiation-timeout' });
    // Bypass the producer to exercise the server boundary independently.
    payload.startup.dataChannelWatchdog.secret = 'PASSWORD_CANARY'; payload.startup.dataChannelWatchdog.url = 'https://URL_CANARY';
    const ingest = () => ingestDiagnosticPayload({ role: 'viewer', viewerId: 'offline-unit', data: payload, config: { enableDiagPersist: true }, logger: {} });
    const first = ingest(); assert.equal(first.persisted, true); assert.equal(first.receipt.accepted, true);
    assert.equal(first.receipt.diagnosticId, payload.diagnosticId); assert.equal(first.report.reason, 'negotiation-timeout');
    assert.deepEqual(first.report.startup.dataChannelWatchdog, sanitizeDataChannelWatchdog(watchdog));
    const reports = fs.readdirSync(path.join(dir, 'raw')).map(name => JSON.parse(fs.readFileSync(path.join(dir, 'raw', name), 'utf8')));
    const report = reports.find(item => item.diagnosticId === payload.diagnosticId);
    assert.deepEqual(report.startup.dataChannelWatchdog, sanitizeDataChannelWatchdog(watchdog));
    assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 128 * 1024); assert.equal(JSON.stringify(reports).includes('CANARY'), false);
    const duplicate = ingest(); assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.receipt, first.receipt);
  } finally { if (previous === undefined) delete process.env.WRD_DIAG_DIR; else process.env.WRD_DIAG_DIR = previous; fs.rmSync(dir, { recursive: true, force: true }); }
});
