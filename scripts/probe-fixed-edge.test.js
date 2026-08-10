'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const probePath = path.join(__dirname, 'probe-fixed-edge.sh');

function runProbe(env) {
  return spawnSync('bash', [probePath], {
    encoding: 'utf8',
    env: { ...process.env, ...env, WRD_PROBE_SKIP_WRITE: '0' },
  });
}

test('probe is read-only and never mutates tunnels', () => {
  const src = fs.readFileSync(probePath, 'utf8');
  assert.doesNotMatch(src, /\b(kill|pkill|launchctl\s+(remove|submit|kickstart)|brew\s+upgrade)\b/);
  assert.doesNotMatch(src, /restart-fixed-domain-tunnel|run-safe-quicktunnel/);
});

test('probe classifies origin-down from fixture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-probe-'));
  const out = path.join(dir, 'out.json');
  const result = runProbe({
    WRD_PROBE_ORIGIN_RESULT: 'fail',
    WRD_PROBE_FORMAL_RESULT: 'ok',
    WRD_PROBE_EDGE_RESULTS: '1,1,1',
    WRD_PROBE_JSON_OUT: out,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /classification:\s*origin-down/);
  const json = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(json.classification, 'origin-down');
});

test('probe classifies formal-down-local-ok when edges open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-probe-'));
  const out = path.join(dir, 'out.json');
  const result = runProbe({
    WRD_PROBE_ORIGIN_RESULT: 'ok',
    WRD_PROBE_FORMAL_RESULT: 'fail',
    WRD_PROBE_EDGE_RESULTS: '1,1,0',
    WRD_PROBE_JSON_OUT: out,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const json = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(json.classification, 'formal-down-local-ok');
});

test('probe classifies edge-blocked when formal down and edges mostly closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-probe-'));
  const out = path.join(dir, 'out.json');
  const result = runProbe({
    WRD_PROBE_ORIGIN_RESULT: 'ok',
    WRD_PROBE_FORMAL_RESULT: 'fail',
    WRD_PROBE_EDGE_RESULTS: '0,0,0',
    WRD_PROBE_JSON_OUT: out,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const json = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(json.classification, 'edge-blocked');
});
