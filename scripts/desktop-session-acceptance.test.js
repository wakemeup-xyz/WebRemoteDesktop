'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const script = path.join(__dirname, 'desktop-session-acceptance.sh');

test('local-only acceptance is read-only and fails closed for unavailable runtime', () => {
  const result = childProcess.spawnSync('bash', [script, '--local-only'], {
    encoding: 'utf8',
    env: { ...process.env, WRD_LOCAL_ORIGIN: 'http://127.0.0.1:1' },
  });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.localOnly, true);
  assert.equal(report.acceptance['live-frame'].status, 'NOT RUN');
  assert.equal(report.acceptance['tunnel-frame'].status, 'NOT RUN');
  assert.equal(report.evidence.attemptId, null);
});

test('acceptance harness does not inject synthetic frame or ack evidence', () => {
  const source = fs.readFileSync(script, 'utf8');
  assert.doesNotMatch(source, /emit\s+.*frame|socket\.emit|input-ack/);
  assert.match(source, /candidateSummary/);
  assert.match(source, /frameCounters/);
  assert.match(source, /dual-viewer/);
  assert.match(source, /physical-input/);
});
