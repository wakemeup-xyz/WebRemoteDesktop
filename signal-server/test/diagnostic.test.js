const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { redactDiagnosticPayload, getDiagDir, persistDiagnostic } = require('../lib/diagnostic');

test('redactDiagnosticPayload trims logs and strips keyboard debug details', () => {
  const payload = {
    logs: Array.from({ length: 140 }, (_, index) => 'log-' + index),
    keyboardDebug: ['debug-1', 'debug-2'],
    network: {
      candidateSummary: {
        local: { host: 2, srflx: 1 },
        remote: { host: 1, srflx: 1 },
        samples: {
          local: [{ type: 'srflx', address: '203.0.113.1:5000' }],
          remote: [{ type: 'host', address: '192.168.0.2:6000' }],
        },
      },
    },
    inputState: {
      keyboardMode: 'windows',
      pendingKeys: ['KeyA', 'KeyB'],
      lastReleaseAllReason: 'window-blur',
      lastKeyboardResetReason: 'window-blur',
      recentInputEvents: Array.from({ length: 30 }, (_, index) => ({ id: index })),
    },
  };
  const redacted = redactDiagnosticPayload(payload);
  assert.equal(redacted.logs.length, 120);
  assert.deepEqual(redacted.keyboardDebug, []);
  assert.equal(redacted.inputState.keyboardMode, 'windows');
  assert.equal(redacted.inputState.pendingKeys, 2);
  assert.equal(redacted.inputState.recentInputEvents.length, 20);
  assert.equal(redacted.network.candidateSummary.local.srflx, 1);
  assert.equal(redacted.network.candidateSummary.samples.local[0].type, 'srflx');
});

test('persistDiagnostic writes into temp wrd-diag directory', () => {
  const dir = getDiagDir();
  assert.equal(dir, path.join(os.tmpdir(), 'wrd-diag'));
  const filename = 'diag-' + Date.now() + '.json';
  const report = { ok: true };
  persistDiagnostic(filename, report);
  const written = JSON.parse(fs.readFileSync(path.join(dir, filename), 'utf8'));
  assert.deepEqual(written, report);
  fs.unlinkSync(path.join(dir, filename));
});
