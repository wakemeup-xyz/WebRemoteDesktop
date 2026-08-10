'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const watchPath = path.join(__dirname, 'watch-fixed-domain.sh');

function decide(env, state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-watch-'));
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(state));
  const result = spawnSync('bash', [watchPath, '--decide-only'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      WRD_FIXED_WATCH_STATE: statePath,
      WRD_FIXED_WATCH_LOG: path.join(dir, 'watch.log'),
      WRD_FIXED_WATCH_FAIL_SEC: '180',
      WRD_FIXED_WATCH_COOLDOWN_SEC: '300',
      WRD_FIXED_WATCH_MAX_RESTARTS: '2',
      WRD_FIXED_WATCH_WINDOW_SEC: '3600',
      ...env,
    },
  });
  const out = JSON.parse(result.stdout.trim().split('\n').filter(Boolean).at(-1));
  return { result, out, statePath };
}

test('watch never references quick tunnel or local app killers', () => {
  const src = fs.readFileSync(watchPath, 'utf8');
  assert.doesNotMatch(src, /run-safe-quicktunnel|pkill\s+-f\s+'?node server\.js|restart-host\.sh/);
  assert.match(src, /restart-fixed-domain-tunnel\.sh/);
});

test('origin-down does not restart', () => {
  const { result, out } = decide(
    { NOW_EPOCH: '1000', ORIGIN_OK: '0', FORMAL_OK: '0' },
    { failStartedAt: 1, restarts: [], lastRestartAt: null },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(out.action, 'none');
  assert.equal(out.status, 'origin-down');
});

test('formal-down below threshold does not restart', () => {
  const { out } = decide(
    { NOW_EPOCH: '200', ORIGIN_OK: '1', FORMAL_OK: '0' },
    { failStartedAt: 100, restarts: [], lastRestartAt: null },
  );
  assert.equal(out.action, 'none');
  assert.equal(out.status, 'formal-down');
});

test('formal-down past threshold restarts when budget remains', () => {
  const { out } = decide(
    { NOW_EPOCH: '400', ORIGIN_OK: '1', FORMAL_OK: '0' },
    { failStartedAt: 100, restarts: [], lastRestartAt: null },
  );
  assert.equal(out.action, 'restart');
});

test('budget exhausted only notifies', () => {
  // lastRestartAt far enough that cooldown is clear; budget uses rolling restarts[]
  const { out } = decide(
    { NOW_EPOCH: '5000', ORIGIN_OK: '1', FORMAL_OK: '0' },
    {
      failStartedAt: 1000,
      lastRestartAt: 1000,
      restarts: [2000, 3000],
    },
  );
  assert.ok(out.action === 'notify' || out.status === 'budget-exhausted');
  assert.notEqual(out.action, 'restart');
});
