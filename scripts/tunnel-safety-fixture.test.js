const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const safeLibraryPath = path.join(__dirname, 'lib-safe-wrd.sh');
const startupLibraryPath = path.join(__dirname, 'lib-safe-startup.sh');
const tunnelLibraryPath = path.join(__dirname, 'lib-tunnel-launchctl.sh');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-tunnel-safety-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const launchctlPath = path.join(bin, 'launchctl');
  fs.writeFileSync(
    launchctlPath,
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$WRD_LAUNCHCTL_LOG"',
      'if [ "$1" = "print" ] && [ "${WRD_FAKE_LOADED:-0}" != "1" ]; then exit 1; fi',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return {
    root,
    bin,
    launchctlLog: path.join(root, 'launchctl.log'),
    marker: path.join(root, 'mutation.marker'),
    urlFile: path.join(root, 'current-url.txt'),
  };
}

function runBash(script, fixture, extraEnv = {}, args = []) {
  return execFileSync('bash', ['-c', script, 'fixture', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      HOME: fixture.root,
      PROJECT_DIR: fixture.root,
      WRD_LAUNCHCTL_LOG: fixture.launchctlLog,
      ...extraEnv,
    },
  });
}

function launchctlCalls(fixture) {
  return fs.existsSync(fixture.launchctlLog)
    ? fs.readFileSync(fixture.launchctlLog, 'utf8').trim().split('\n').filter(Boolean)
    : [];
}

test('ordinary startup disables and boots out a loaded legacy quick-tunnel job without starting it', () => {
  const fixture = makeFixture();
  fs.writeFileSync(fixture.urlFile, 'https://preserved.trycloudflare.com\n');
  try {
    runBash(
      `
        source "$1"
        source "$2"
        source "$3"
        wrd_safe_reconcile_pid_file() { return 1; }
        wrd_safe_pid_is_running() { return 1; }
        wrd_safe_url_is_reachable() { return 1; }
        wrd_tunnel_launchctl_migrate_legacy_autostart
        wrd_safe_startup_tunnel "$4" "$5" "$6"
      `,
      fixture,
      {
        WRD_FAKE_LOADED: '1',
      },
      [safeLibraryPath, tunnelLibraryPath, startupLibraryPath, fixture.marker, fixture.urlFile, fixture.root],
    );
    const calls = launchctlCalls(fixture);
    assert.equal(calls.some((call) => call.startsWith('print ')), true);
    assert.equal(calls.some((call) => call.startsWith('disable ')), true);
    assert.equal(calls.some((call) => call.startsWith('bootout ')), true);
    assert.equal(calls.some((call) => /bootstrap|kickstart|remove/.test(call)), false);
    assert.equal(fs.readFileSync(fixture.urlFile, 'utf8'), 'https://preserved.trycloudflare.com\n');
    assert.equal(fs.existsSync(fixture.marker), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('ordinary startup leaves an unloaded legacy job and URL state untouched', () => {
  const fixture = makeFixture();
  fs.writeFileSync(fixture.urlFile, 'https://preserved.trycloudflare.com\n');
  try {
    runBash('source "$1"; wrd_tunnel_launchctl_migrate_legacy_autostart', fixture, {}, [tunnelLibraryPath]);
    const calls = launchctlCalls(fixture);
    assert.deepEqual(calls, [`print gui/${process.getuid()}/com.webremotedesktop.tunnel`]);
    assert.equal(fs.readFileSync(fixture.urlFile, 'utf8'), 'https://preserved.trycloudflare.com\n');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('explicit tunnel restart still enables and kicks the job after migration', () => {
  const fixture = makeFixture();
  const projectDir = path.join(fixture.root, 'project');
  fs.mkdirSync(path.join(projectDir, 'launchd'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'launchd', 'com.webremotedesktop.tunnel.plist'),
    '<plist><dict><key>RunAtLoad</key><false/></dict></plist>\n',
  );
  try {
    runBash(
      `
        source "$1"
        wrd_tunnel_launchctl_restart
      `,
      fixture,
      {
        PROJECT_DIR: projectDir,
      },
      [tunnelLibraryPath],
    );
    const calls = launchctlCalls(fixture);
    assert.equal(calls.some((call) => call.startsWith('bootstrap ')), true);
    assert.equal(calls.some((call) => call.startsWith('enable ')), true);
    assert.equal(calls.some((call) => call.startsWith('kickstart ')), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('run-safe terminal states report diagnostics without kill, URL deletion, or replacement', () => {
  const fixture = makeFixture();
  fs.writeFileSync(fixture.urlFile, 'https://preserved.trycloudflare.com\n');
  try {
    const output = runBash(
      `
        source "$1"
        kill() { printf 'kill\\n' >> "$WRD_MUTATION_MARKER"; }
        rm() { printf 'rm %s\\n' "$*" >> "$WRD_MUTATION_MARKER"; }
        cloudflared() { printf 'replacement\\n' >> "$WRD_MUTATION_MARKER"; }
        for state in unauthorized unreachable connector-exit; do
          wrd_safe_quick_tunnel_observe "$state" "fixture"
        done
      `,
      fixture,
      {
        WRD_ENTRY_HEALTH_SCRIPT: fixture.marker,
        WRD_MUTATION_MARKER: fixture.marker,
      },
      [safeLibraryPath],
    );
    assert.match(output, /diagnos/);
    assert.match(output, /Unauthorized|unreachable|exited/);
    assert.equal(fs.existsSync(fixture.marker), false);
    assert.equal(fs.readFileSync(fixture.urlFile, 'utf8'), 'https://preserved.trycloudflare.com\n');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('ordinary startup tunnel decision is diagnostic-only when the supervisor is missing or unreachable', () => {
  const fixture = makeFixture();
  fs.writeFileSync(fixture.urlFile, 'https://preserved.trycloudflare.com\n');
  try {
    const output = runBash(
      `
        source "$1"
        source "$2"
        source "$3"
        wrd_safe_reconcile_pid_file() { return 1; }
        wrd_safe_pid_is_running() { return 1; }
        wrd_safe_url_is_reachable() { return 1; }
        wrd_tunnel_launchctl_start() { printf 'start\\n' >> "$WRD_MUTATION_MARKER"; }
        wrd_tunnel_launchctl_restart() { printf 'restart\\n' >> "$WRD_MUTATION_MARKER"; }
        wrd_safe_startup_tunnel "$4" "$5" "$6"
      `,
      fixture,
      {
        WRD_FAKE_LOADED: '0',
        WRD_MUTATION_MARKER: fixture.marker,
      },
      [safeLibraryPath, tunnelLibraryPath, startupLibraryPath, fixture.marker, fixture.urlFile, fixture.root],
    );
    assert.match(output, /diagnosing|not running|unreachable/);
    assert.equal(fs.existsSync(fixture.marker), false);
    assert.equal(fs.readFileSync(fixture.urlFile, 'utf8'), 'https://preserved.trycloudflare.com\n');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
