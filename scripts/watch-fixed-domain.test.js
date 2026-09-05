'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const watchPath = path.join(__dirname, 'watch-fixed-domain.sh');
const restartPath = path.join(__dirname, 'restart-fixed-domain-tunnel.sh');

function sourceWatch(code, env = {}) {
  return spawnSync('bash', ['-c', 'source "$WATCH_PATH"; ' + code], {
    encoding: 'utf8',
    env: {
      ...process.env,
      WATCH_PATH: watchPath,
      WRD_FIXED_WATCH_SOURCE_ONLY: '1',
      ...env,
    },
  });
}

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

test('watch reclaims a lock directory whose recorded pid is dead', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-watch-lock-stale-'));
  const lockPath = path.join(dir, 'watch.lock');
  const stale = spawn('sleep', ['30']);
  stale.kill('SIGTERM');
  await new Promise((resolve) => stale.once('exit', resolve));
  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, 'pid'), `${stale.pid}\n`);

  const result = sourceWatch(
    'if wrd_fixed_watch_acquire_lock; then printf "acquired pid=%s\\n" "$(cat "$WRD_FIXED_WATCH_PID_FILE")"; else exit 1; fi',
    {
      WRD_FIXED_WATCH_LOCK: lockPath,
      WRD_FIXED_WATCH_PID_FILE: path.join(lockPath, 'pid'),
      WRD_FIXED_WATCH_LOG: path.join(dir, 'watch.log'),
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /acquired pid=\d+/);
  assert.equal(fs.existsSync(lockPath), false, 'EXIT cleanup should remove the acquired lock');
});

test('watch preserves an initializing lock directory with no pid file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-watch-lock-no-pid-'));
  const lockPath = path.join(dir, 'watch.lock');
  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, 'initializing'), 'owner is still publishing metadata\n');

  const result = sourceWatch(
    'if wrd_fixed_watch_acquire_lock; then exit 0; else exit 1; fi',
    {
      WRD_FIXED_WATCH_LOCK: lockPath,
      WRD_FIXED_WATCH_PID_FILE: path.join(lockPath, 'pid'),
      WRD_FIXED_WATCH_LOG: path.join(dir, 'watch.log'),
    },
  );

  assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.existsSync(lockPath), true, 'initializing owner must not be reclaimed');
  assert.equal(fs.existsSync(path.join(lockPath, 'initializing')), true);
});

test('watch reclaims a malformed initialization marker after its grace period', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-watch-lock-init-expired-'));
  const lockPath = path.join(dir, 'watch.lock');
  const markerPath = path.join(lockPath, 'initializing');
  fs.mkdirSync(lockPath);
  fs.writeFileSync(markerPath, 'owner is still publishing metadata\n');
  const expired = new Date(Date.now() - 60_000);
  fs.utimesSync(markerPath, expired, expired);

  const result = sourceWatch(
    'if wrd_fixed_watch_acquire_lock; then printf "acquired\\n"; else exit 1; fi',
    {
      WRD_FIXED_WATCH_LOCK: lockPath,
      WRD_FIXED_WATCH_PID_FILE: path.join(lockPath, 'pid'),
      WRD_FIXED_WATCH_START_FILE: path.join(lockPath, 'start'),
      WRD_FIXED_WATCH_SIGNATURE_FILE: path.join(lockPath, 'signature'),
      WRD_FIXED_WATCH_INIT_MARKER: markerPath,
      WRD_FIXED_WATCH_INIT_MAX_SEC: '30',
      WRD_FIXED_WATCH_LOG: path.join(dir, 'watch.log'),
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /acquired/);
  assert.equal(fs.existsSync(lockPath), false, 'expired incomplete lock should be reclaimed');
});

test('watch never reclaims an empty lock while an owner is initializing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-watch-lock-empty-'));
  const lockPath = path.join(dir, 'watch.lock');
  fs.mkdirSync(lockPath);
  const holder = spawn('sleep', ['30']);
  fs.writeFileSync(path.join(lockPath, 'initializing'), `${holder.pid}\ninitializing\n`);

  try {
    const result = sourceWatch(
      'if wrd_fixed_watch_acquire_lock; then exit 0; else exit 1; fi',
      {
        WRD_FIXED_WATCH_LOCK: lockPath,
        WRD_FIXED_WATCH_PID_FILE: path.join(lockPath, 'pid'),
        WRD_FIXED_WATCH_START_FILE: path.join(lockPath, 'start'),
        WRD_FIXED_WATCH_SIGNATURE_FILE: path.join(lockPath, 'signature'),
        WRD_FIXED_WATCH_INIT_MARKER: path.join(lockPath, 'initializing'),
        WRD_FIXED_WATCH_LOG: path.join(dir, 'watch.log'),
      },
    );

    assert.equal(result.status, 1, result.stderr);
    assert.equal(fs.existsSync(lockPath), true, 'active initializer must retain the lock');
  } finally {
    holder.kill('SIGTERM');
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
});

test('watch reclaims a lock abandoned immediately after mkdir before pid publication', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-watch-lock-mkdir-crash-'));
  const lockPath = path.join(dir, 'watch.lock');
  fs.mkdirSync(lockPath);

  const result = sourceWatch(
    'if wrd_fixed_watch_acquire_lock; then printf "acquired\\n"; else exit 1; fi',
    {
      WRD_FIXED_WATCH_LOCK: lockPath,
      WRD_FIXED_WATCH_PID_FILE: path.join(lockPath, 'pid'),
      WRD_FIXED_WATCH_START_FILE: path.join(lockPath, 'start'),
      WRD_FIXED_WATCH_SIGNATURE_FILE: path.join(lockPath, 'signature'),
      WRD_FIXED_WATCH_INIT_MARKER: path.join(lockPath, 'initializing'),
      WRD_FIXED_WATCH_LOG: path.join(dir, 'watch.log'),
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /acquired/);
  assert.equal(fs.existsSync(lockPath), false, 'reclaimed lock should be released by EXIT trap');
});

test('watch treats kill -0 EPERM as unknown and preserves the existing lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-watch-lock-eperm-'));
  const lockPath = path.join(dir, 'watch.lock');
  const bashEnv = path.join(dir, 'bash-env.sh');
  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, 'pid'), '999\n');
  fs.writeFileSync(
    bashEnv,
    `kill() {\n  if [ "\${1:-}" = "-0" ] && [ "\${2:-}" = "999" ]; then\n    echo 'kill: Operation not permitted' >&2\n    return 1\n  fi\n  command kill "$@"\n}\n`,
  );

  const result = sourceWatch(
    'if wrd_fixed_watch_acquire_lock; then exit 0; else exit 1; fi',
    {
      BASH_ENV: bashEnv,
      WRD_FIXED_WATCH_LOCK: lockPath,
      WRD_FIXED_WATCH_PID_FILE: path.join(lockPath, 'pid'),
      WRD_FIXED_WATCH_START_FILE: path.join(lockPath, 'start'),
      WRD_FIXED_WATCH_SIGNATURE_FILE: path.join(lockPath, 'signature'),
      WRD_FIXED_WATCH_INIT_MARKER: path.join(lockPath, 'initializing'),
      WRD_FIXED_WATCH_LOG: path.join(dir, 'watch.log'),
    },
  );

  assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.existsSync(lockPath), true, 'EPERM must never reclaim the lock');
  assert.equal(fs.readFileSync(path.join(lockPath, 'pid'), 'utf8'), '999\n');
  assert.match(result.stderr, /unknown|permission|holds/i);
});

test('watch records process start and signature metadata with the pid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-watch-lock-identity-'));
  const lockPath = path.join(dir, 'watch.lock');

  const result = sourceWatch(
    'if wrd_fixed_watch_acquire_lock; then printf "pid=%s\\nstart=%s\\nsignature=%s\\n" "$(cat "$WRD_FIXED_WATCH_PID_FILE")" "$(cat "$WRD_FIXED_WATCH_START_FILE")" "$(cat "$WRD_FIXED_WATCH_SIGNATURE_FILE")"; else exit 1; fi',
    {
      WRD_FIXED_WATCH_LOCK: lockPath,
      WRD_FIXED_WATCH_PID_FILE: path.join(lockPath, 'pid'),
      WRD_FIXED_WATCH_START_FILE: path.join(lockPath, 'start'),
      WRD_FIXED_WATCH_SIGNATURE_FILE: path.join(lockPath, 'signature'),
      WRD_FIXED_WATCH_INIT_MARKER: path.join(lockPath, 'initializing'),
      WRD_FIXED_WATCH_LOG: path.join(dir, 'watch.log'),
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pid=\d+/);
  assert.match(result.stdout, /start=.+/);
  assert.match(result.stdout, /signature=.+/);
});

test('watch preserves a live foreign lock and does not kill its pid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-watch-lock-live-'));
  const lockPath = path.join(dir, 'watch.lock');
  fs.mkdirSync(lockPath);
  const holder = spawn('sleep', ['30']);
  try {
    fs.writeFileSync(path.join(lockPath, 'pid'), `${holder.pid}\n`);
    fs.writeFileSync(path.join(lockPath, 'start'), 'a different process start\n');
    fs.writeFileSync(path.join(lockPath, 'signature'), 'a different process signature\n');
    const result = sourceWatch(
      'wrd_fixed_watch_acquire_lock && exit 0 || exit 1',
      {
        WRD_FIXED_WATCH_LOCK: lockPath,
        WRD_FIXED_WATCH_PID_FILE: path.join(lockPath, 'pid'),
        WRD_FIXED_WATCH_LOG: path.join(dir, 'watch.log'),
      },
    );

    assert.equal(result.status, 1, result.stderr);
    assert.equal(fs.existsSync(lockPath), true);
    assert.doesNotThrow(() => process.kill(holder.pid, 0));
  } finally {
    holder.kill('SIGTERM');
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
});

test('watch skips its own restart branch when token inspection finds a connector', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-watch-token-branch-'));
  const statePath = path.join(dir, 'state.json');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    statePath,
    JSON.stringify({ failStartedAt: 100, lastRestartAt: null, restarts: [] }),
  );
  fs.writeFileSync(
    path.join(bin, 'ps'),
    '#!/bin/sh\nprintf "%s\\n" "101 cloudflared tunnel run --token SUPER-SECRET-TOKEN"\n',
  );
  fs.chmodSync(path.join(bin, 'ps'), 0o755);

  const result = spawnSync(
    'bash',
    [
      '-c',
      'source "$WATCH_PATH"; wrd_fixed_origin_health_ok(){ return 0; }; wrd_fixed_formal_health_ok(){ return 1; }; NOW_EPOCH=400 wrd_fixed_watch_tick 0',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        WATCH_PATH: watchPath,
        WRD_FIXED_WATCH_SOURCE_ONLY: '1',
        PATH: `${bin}:${process.env.PATH}`,
        WRD_FIXED_WATCH_STATE: statePath,
        WRD_FIXED_WATCH_LOG: path.join(dir, 'watch.log'),
      },
    },
  );
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(state.lastAction, 'skip');
  assert.equal(state.lastStatus, 'formal-down');
  assert.doesNotMatch(result.stdout + result.stderr, /SUPER-SECRET-TOKEN/);
});

test('watch skips its own restart branch when token inspection fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-watch-ps-failure-branch-'));
  const statePath = path.join(dir, 'state.json');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    statePath,
    JSON.stringify({ failStartedAt: 100, lastRestartAt: null, restarts: [] }),
  );
  fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\nexit 1\n');
  fs.chmodSync(path.join(bin, 'ps'), 0o755);

  const result = spawnSync(
    'bash',
    [
      '-c',
      'source "$WATCH_PATH"; wrd_fixed_origin_health_ok(){ return 0; }; wrd_fixed_formal_health_ok(){ return 1; }; NOW_EPOCH=400 wrd_fixed_watch_tick 0',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        WATCH_PATH: watchPath,
        WRD_FIXED_WATCH_SOURCE_ONLY: '1',
        PATH: `${bin}:${process.env.PATH}`,
        WRD_FIXED_WATCH_STATE: statePath,
        WRD_FIXED_WATCH_LOG: path.join(dir, 'watch.log'),
      },
    },
  );
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(state.lastAction, 'skip');
  assert.equal(state.lastStatus, 'formal-down');
  assert.match(result.stderr, /token-inspection-failed/);
});

test('watch ps failure returns before restart script or launchctl submit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-watch-ps-failure-guard-'));
  const statePath = path.join(dir, 'state.json');
  const bin = path.join(dir, 'bin');
  const restartMarker = path.join(dir, 'restart-invoked');
  const launchctlMarker = path.join(dir, 'launchctl-invoked');
  const restartSentinel = path.join(bin, 'restart-sentinel');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    statePath,
    JSON.stringify({ failStartedAt: 100, lastRestartAt: null, restarts: [] }),
  );
  fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\nexit 1\n');
  fs.writeFileSync(
    restartSentinel,
    '#!/bin/sh\nprintf invoked > "$RESTART_MARKER"\nexit 99\n',
  );
  fs.writeFileSync(
    path.join(bin, 'launchctl'),
    '#!/bin/sh\nprintf invoked > "$LAUNCHCTL_MARKER"\nexit 99\n',
  );
  fs.chmodSync(path.join(bin, 'ps'), 0o755);
  fs.chmodSync(restartSentinel, 0o755);
  fs.chmodSync(path.join(bin, 'launchctl'), 0o755);

  const result = spawnSync(
    'bash',
    [
      '-c',
      'source "$WATCH_PATH"; RESTART_SCRIPT="$RESTART_SENTINEL"; wrd_fixed_origin_health_ok(){ return 0; }; wrd_fixed_formal_health_ok(){ return 1; }; NOW_EPOCH=400 wrd_fixed_watch_tick 0',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        WATCH_PATH: watchPath,
        RESTART_SENTINEL: restartSentinel,
        RESTART_MARKER: restartMarker,
        LAUNCHCTL_MARKER: launchctlMarker,
        WRD_FIXED_WATCH_SOURCE_ONLY: '1',
        PATH: `${bin}:${process.env.PATH}`,
        WRD_FIXED_WATCH_STATE: statePath,
        WRD_FIXED_WATCH_LOG: path.join(dir, 'watch.log'),
      },
    },
  );
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(state.lastAction, 'skip');
  assert.equal(state.lastStatus, 'formal-down');
  assert.match(result.stderr, /token-inspection-failed/);
  assert.equal(fs.existsSync(restartMarker), false);
  assert.equal(fs.existsSync(launchctlMarker), false);
});

test('watch formal-owner ps failure returns before restart script or launchctl submit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-watch-formal-owner-ps-failure-'));
  const statePath = path.join(dir, 'state.json');
  const bin = path.join(dir, 'bin');
  const callCount = path.join(dir, 'ps-count');
  const restartMarker = path.join(dir, 'restart-invoked');
  const launchctlMarker = path.join(dir, 'launchctl-invoked');
  const restartSentinel = path.join(bin, 'restart-sentinel');
  fs.mkdirSync(bin);
  fs.writeFileSync(statePath, JSON.stringify({ failStartedAt: 100, lastRestartAt: null, restarts: [] }));
  fs.writeFileSync(
    path.join(bin, 'ps'),
    `#!/bin/sh\ncount=0\n[ -f '${callCount}' ] && count=$(cat '${callCount}')\ncount=$((count + 1))\nprintf '%s' "$count" > '${callCount}'\nif [ "$count" -eq 1 ]; then exit 0; fi\nexit 1\n`,
  );
  fs.writeFileSync(restartSentinel, '#!/bin/sh\nprintf invoked > "$RESTART_MARKER"\nexit 99\n');
  fs.writeFileSync(path.join(bin, 'launchctl'), '#!/bin/sh\nprintf invoked > "$LAUNCHCTL_MARKER"\nexit 99\n');
  for (const name of ['ps', 'restart-sentinel', 'launchctl']) fs.chmodSync(path.join(bin, name), 0o755);

  const result = spawnSync(
    'bash',
    [
      '-c',
      'source "$WATCH_PATH"; RESTART_SCRIPT="$RESTART_SENTINEL"; wrd_fixed_origin_health_ok(){ return 0; }; wrd_fixed_formal_health_ok(){ return 1; }; NOW_EPOCH=400 wrd_fixed_watch_tick 0',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        WATCH_PATH: watchPath,
        RESTART_SENTINEL: restartSentinel,
        RESTART_MARKER: restartMarker,
        LAUNCHCTL_MARKER: launchctlMarker,
        WRD_FIXED_WATCH_SOURCE_ONLY: '1',
        PATH: `${bin}:${process.env.PATH}`,
        WRD_FIXED_WATCH_STATE: statePath,
        WRD_FIXED_WATCH_LOG: path.join(dir, 'watch.log'),
      },
    },
  );
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(state.lastAction, 'skip');
  assert.equal(state.lastStatus, 'formal-down');
  assert.match(result.stderr, /formal-owner-inspection-failed/);
  assert.equal(fs.existsSync(restartMarker), false);
  assert.equal(fs.existsSync(launchctlMarker), false);
});

test('watch releases its lock on SIGTERM', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-watch-lock-term-'));
  const lockPath = path.join(dir, 'watch.lock');
  const child = spawn('bash', ['-c', 'source "$WATCH_PATH"; wrd_fixed_watch_acquire_lock; printf ready; while :; do sleep 1; done'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WATCH_PATH: watchPath,
      WRD_FIXED_WATCH_SOURCE_ONLY: '1',
      WRD_FIXED_WATCH_LOCK: lockPath,
      WRD_FIXED_WATCH_PID_FILE: path.join(lockPath, 'pid'),
      WRD_FIXED_WATCH_LOG: path.join(dir, 'watch.log'),
    },
  });
  try {
    const ready = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('watch holder did not acquire lock')), 2000);
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('ready')) {
          clearTimeout(timer);
          resolve(output);
        }
      });
      child.on('error', reject);
    });
    assert.match(ready, /ready/);
    assert.equal(fs.existsSync(lockPath), true);
    child.kill('SIGTERM');
    const exit = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(exit, 143);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    if (!child.killed) child.kill('SIGKILL');
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
});

test('watch SIGTERM cleanup cannot remove a lock whose owner metadata changed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-watch-lock-owner-change-'));
  const lockPath = path.join(dir, 'watch.lock');
  const holder = spawn('bash', ['-c', 'source "$WATCH_PATH"; wrd_fixed_watch_acquire_lock; printf ready; while :; do sleep 1; done'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WATCH_PATH: watchPath,
      WRD_FIXED_WATCH_SOURCE_ONLY: '1',
      WRD_FIXED_WATCH_LOCK: lockPath,
      WRD_FIXED_WATCH_PID_FILE: path.join(lockPath, 'pid'),
      WRD_FIXED_WATCH_START_FILE: path.join(lockPath, 'start'),
      WRD_FIXED_WATCH_SIGNATURE_FILE: path.join(lockPath, 'signature'),
      WRD_FIXED_WATCH_INIT_MARKER: path.join(lockPath, 'initializing'),
      WRD_FIXED_WATCH_LOG: path.join(dir, 'watch.log'),
    },
  });
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('watch holder did not acquire lock')), 2000);
      holder.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('ready')) {
          clearTimeout(timer);
          resolve();
        }
      });
      holder.on('error', reject);
    });

    fs.rmSync(path.join(lockPath, 'start'));
    fs.rmSync(path.join(lockPath, 'signature'));
    holder.kill('SIGTERM');
    const exit = await new Promise((resolve) => holder.once('exit', resolve));
    assert.equal(exit, 143);
    assert.equal(fs.existsSync(lockPath), true, 'cleanup must not remove a changed-owner lock');
  } finally {
    if (!holder.killed) holder.kill('SIGKILL');
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
});

test('managed formal restart refuses an existing token connector before submit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-watch-token-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const launchctlLog = path.join(dir, 'launchctl.log');
  const cloudflaredLog = path.join(dir, 'cloudflared.log');
  fs.writeFileSync(path.join(dir, 'config.yml'), 'tunnel: fixture\ncredentials-file: /tmp/fixture.json\n');
  fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\nprintf "%s\\n" "101 cloudflared tunnel run --token SUPER-SECRET-TOKEN"\n');
  fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/sh\nprintf '%s\\n' launchctl >> '${launchctlLog}'\n`);
  fs.writeFileSync(path.join(bin, 'cloudflared'), `#!/bin/sh\nprintf '%s\\n' cloudflared >> '${cloudflaredLog}'\n`);
  for (const name of ['ps', 'launchctl', 'cloudflared']) fs.chmodSync(path.join(bin, name), 0o755);

  const result = spawnSync('bash', [restartPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CLOUDFLARED: path.join(bin, 'cloudflared'),
      CLOUDFLARED_CONFIG: path.join(dir, 'config.yml'),
      WRD_FIXED_DOMAIN_LOG: path.join(dir, 'fixed.log'),
    },
  });

  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /refusing restart[\s\S]*token/i);
  assert.equal(fs.existsSync(launchctlLog), false, 'managed restart must not submit a second connector');
  assert.equal(fs.existsSync(cloudflaredLog), false, 'managed restart must not invoke cloudflared');
  assert.doesNotMatch(result.stdout + result.stderr, /SUPER-SECRET-TOKEN/);
});

test('managed formal restart refuses closed inspection before submit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-watch-ps-failure-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const launchctlLog = path.join(dir, 'launchctl.log');
  fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\nexit 1\n');
  fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/sh\nprintf '%s\\n' launchctl >> '${launchctlLog}'\n`);
  for (const name of ['ps', 'launchctl']) fs.chmodSync(path.join(bin, name), 0o755);

  const result = spawnSync('bash', [restartPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /refusing restart[\s\S]*(inspect|process)/i);
  assert.equal(fs.existsSync(launchctlLog), false, 'inspection failure must not submit a connector');
});

test('managed formal restart propagates formal-owner ps failure before submit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-formal-owner-ps-failure-'));
  const bin = path.join(dir, 'bin');
  const callCount = path.join(dir, 'ps-count');
  const launchctlLog = path.join(dir, 'launchctl.log');
  const configPath = path.join(dir, 'config.yml');
  fs.mkdirSync(bin);
  fs.writeFileSync(configPath, 'tunnel: fixture\ncredentials-file: /tmp/fixture.json\n');
  fs.writeFileSync(
    path.join(bin, 'ps'),
    `#!/bin/sh\ncount=0\n[ -f '${callCount}' ] && count=$(cat '${callCount}')\ncount=$((count + 1))\nprintf '%s' "$count" > '${callCount}'\nif [ "$count" -eq 1 ]; then exit 0; fi\nexit 1\n`,
  );
  fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/sh\nprintf invoked > '${launchctlLog}'\nexit 99\n`);
  fs.chmodSync(path.join(bin, 'ps'), 0o755);
  fs.chmodSync(path.join(bin, 'launchctl'), 0o755);

  const result = spawnSync('bash', [restartPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      CLOUDFLARED_CONFIG: configPath,
    },
  });

  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /refusing restart[\s\S]*(formal|inspect|process)/i);
  assert.equal(fs.existsSync(launchctlLog), false, 'formal inspection failure must not submit a connector');
});
