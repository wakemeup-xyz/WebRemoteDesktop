'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildReport, main } = require('./check-module-state-owners');

test('state-owner report identifies all three facade modules', () => {
  const report = buildReport();
  assert.match(report, /web-client\/js\/webrtc\.js/);
  assert.match(report, /python-host\/host\.py/);
  assert.match(report, /signal-server\/websocket\/signaling\.js/);
  assert.match(report, /public event names remain compatibility boundaries/);
});

test('state-owner report can be written to an explicit file', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-owner-report-'));
  const output = path.join(temp, 'report.md');
  main(['--write', output]);
  assert.ok(fs.statSync(output).size > 100);
  assert.match(fs.readFileSync(output, 'utf8'), /Module State Owners/);
});

test('facade contract keeps legacy WebRTC and signaling entry points', () => {
  const webRtc = fs.readFileSync(path.join(__dirname, '..', 'web-client/js/webrtc.js'), 'utf8');
  const signaling = fs.readFileSync(path.join(__dirname, '..', 'signal-server/websocket/signaling.js'), 'utf8');
  for (const method of ['disconnect', 'refresh', 'requestControl', 'sendInput', 'createSignalingSocket']) {
    assert.match(webRtc, new RegExp(`\\b${method}\\s*\\(`));
  }
  for (const event of ['control-state', 'control-grant', 'offer', 'answer', 'input', 'disconnect']) {
    assert.match(signaling, new RegExp(`['"]${event}['"]`));
  }
});
