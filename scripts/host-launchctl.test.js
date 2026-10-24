const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const launchdPath = path.join(__dirname, '..', 'launchd', 'com.webremotedesktop.host.plist');
const helperPath = path.join(__dirname, 'lib-host-launchctl.sh');
const runnerPath = path.join(__dirname, 'run-host-launchctl.sh');

function prepareRunnerProject() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-host-launchctl-'));
  const scriptsDir = path.join(projectDir, 'scripts');
  const pythonHostDir = path.join(projectDir, 'python-host');
  const binDir = path.join(projectDir, 'bin');

  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(pythonHostDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(runnerPath, path.join(scriptsDir, 'run-host-launchctl.sh'));
  fs.chmodSync(path.join(scriptsDir, 'run-host-launchctl.sh'), 0o755);
  // run-host-launchctl.sh sources scripts/lib-turn-env.sh; fixture must copy it.
  const turnEnvPath = path.join(__dirname, 'lib-turn-env.sh');
  fs.copyFileSync(turnEnvPath, path.join(scriptsDir, 'lib-turn-env.sh'));

  const fakePythonPath = path.join(projectDir, 'fake-python.sh');
  fs.writeFileSync(
    fakePythonPath,
    '#!/bin/sh\n' +
      'printf "%s\\n" "$@" > "$WRD_TEST_MARKER"\n' +
      'sleep "${WRD_TEST_PYTHON_SLEEP_SECONDS:-5}"\n'
  );
  fs.chmodSync(fakePythonPath, 0o755);

  return {
    projectDir,
    runnerCopyPath: path.join(scriptsDir, 'run-host-launchctl.sh'),
    fakePythonPath,
    pythonMarkerPath: path.join(projectDir, 'fake-python-marker.txt'),
    launchLogPath: path.join(projectDir, 'wrd-host-launch.log'),
    hostLogPath: path.join(projectDir, 'back-debug.log'),
  };
}

function runnerEnv(fixture, overrides = {}, inherited = process.env) {
  return {
    ...inherited,
    ...overrides,
    WRD_HOST_LAUNCH_LOG: fixture.launchLogPath,
    WRD_HOST_LOG_FILE: fixture.hostLogPath,
  };
}

test('host launchagent plist exists and uses the repo host label', () => {
  assert.equal(fs.existsSync(launchdPath), true, 'host launchagent plist should exist');
  const source = fs.readFileSync(launchdPath, 'utf8');

  assert.match(source, /com\.webremotedesktop\.host/);
  assert.match(source, /run-host-launchctl\.sh/);
  assert.match(source, /RunAtLoad/);
  assert.match(source, /KeepAlive/);
  assert.match(source, /wrd-host-launch\.log/);
  assert.doesNotMatch(source, /back-debug\.log/);
});

test('run-host-launchctl preserves only the newest one MiB of wrapper log before appending', (t) => {
  const fixture = prepareRunnerProject();
  const launchLogPath = fixture.launchLogPath;
  t.after(() => fs.rmSync(fixture.projectDir, { recursive: true, force: true }));
  fs.writeFileSync(launchLogPath, `old-prefix-${'x'.repeat(1536 * 1024)}-old-tail`);

  execFileSync('bash', [fixture.runnerCopyPath], {
    cwd: fixture.projectDir,
    env: runnerEnv(fixture, {
      WRD_HOST_HEALTH_URL: 'http://127.0.0.1:65531/health',
      WRD_HOST_WAIT_INTERVAL_SECONDS: '0.01',
      WRD_HOST_WAIT_TIMEOUT_SECONDS: '1',
    }),
  });

  const contents = fs.readFileSync(launchLogPath);
  assert.ok(contents.length <= (1024 * 1024) + 4096);
  assert.equal(contents.includes(Buffer.from('old-prefix')), false);
  assert.equal(contents.includes(Buffer.from('old-tail')), true);
  assert.equal(contents.includes(Buffer.from('Signal server health check failed')), true);
});

test('runner fixture overrides inherited log paths without modifying private canaries', (t) => {
  const fixture = prepareRunnerProject();
  t.after(() => fs.rmSync(fixture.projectDir, { recursive: true, force: true }));
  const inheritedLaunchLog = path.join(fixture.projectDir, 'inherited-launch.log');
  const inheritedHostLog = path.join(fixture.projectDir, 'inherited-host.log');
  const launchCanary = `inherited-prefix-${'x'.repeat(1536 * 1024)}-inherited-tail`;
  const hostCanary = 'inherited host log must remain untouched\n';
  fs.writeFileSync(inheritedLaunchLog, launchCanary);
  fs.writeFileSync(inheritedHostLog, hostCanary);
  fs.utimesSync(inheritedLaunchLog, 1, 1);
  fs.utimesSync(inheritedHostLog, 1, 1);
  const before = [inheritedLaunchLog, inheritedHostLog].map(file => fs.statSync(file).mtimeMs);

  // Resolve health/auth locally, then exercise the runtime log path in a fake
  // Python process. Every command and output remains inside this fixture.
  const binDir = path.join(fixture.projectDir, 'bin');
  const curlPath = path.join(binDir, 'curl');
  fs.writeFileSync(curlPath, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(curlPath, 0o755);
  fs.writeFileSync(fixture.fakePythonPath,
    '#!/bin/sh\nprintf "fixture runtime log\\n" >> "$WRD_HOST_LOG_FILE"\n');
  const inherited = {
    ...process.env,
    WRD_HOST_LAUNCH_LOG: inheritedLaunchLog,
    WRD_HOST_LOG_FILE: inheritedHostLog,
  };
  execFileSync('bash', [fixture.runnerCopyPath], {
    cwd: fixture.projectDir,
    env: runnerEnv(fixture, {
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      PYTHON_BIN: fixture.fakePythonPath,
    }, inherited),
  });

  assert.match(fs.readFileSync(fixture.launchLogPath, 'utf8'), /LaunchAgent starting host/);
  assert.equal(fs.readFileSync(fixture.hostLogPath, 'utf8'), 'fixture runtime log\n');
  assert.equal(fs.readFileSync(inheritedLaunchLog, 'utf8'), launchCanary);
  assert.equal(fs.readFileSync(inheritedHostLog, 'utf8'), hostCanary);
  assert.deepEqual([inheritedLaunchLog, inheritedHostLog].map(file => fs.statSync(file).mtimeMs), before);
});

test('host launchctl helper exists and manages the host launchagent label', () => {
  assert.equal(fs.existsSync(helperPath), true, 'host launchctl helper should exist');
  const source = fs.readFileSync(helperPath, 'utf8');

  assert.match(source, /com\.webremotedesktop\.host/);
  assert.match(source, /launchctl/);
  assert.match(source, /Library\/LaunchAgents/);
});

test('run-host-launchctl waits for signal-server health before starting host.py', async (t) => {
  const fixture = prepareRunnerProject();
  t.after(() => {
    fs.rmSync(fixture.projectDir, { recursive: true, force: true });
  });

  const child = spawn('bash', [fixture.runnerCopyPath], {
    cwd: fixture.projectDir,
    env: runnerEnv(fixture, {
      PYTHON_BIN: fixture.fakePythonPath,
      WRD_TEST_MARKER: fixture.pythonMarkerPath,
      WRD_TEST_PYTHON_SLEEP_SECONDS: '30',
      WRD_HOST_HEALTH_URL: 'http://127.0.0.1:65531/health',
      WRD_HOST_WAIT_INTERVAL_SECONDS: '0.1',
    }),
    stdio: 'ignore',
  });

  t.after(async () => {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  });

  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(fs.existsSync(fixture.pythonMarkerPath), false, 'host.py should not start before health check succeeds');
});

test('run-host-launchctl starts host.py once signal-server health is ready', async (t) => {
  const fixture = prepareRunnerProject();
  t.after(() => {
    fs.rmSync(fixture.projectDir, { recursive: true, force: true });
  });

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    if (req.url === '/api/auth/login/host' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"token":"fake-token","role":"host","expiresIn":"15m"}');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const child = spawn('bash', [fixture.runnerCopyPath], {
    cwd: fixture.projectDir,
    env: runnerEnv(fixture, {
      PYTHON_BIN: fixture.fakePythonPath,
      WRD_TEST_MARKER: fixture.pythonMarkerPath,
      WRD_TEST_PYTHON_SLEEP_SECONDS: '30',
      HOST_SHARED_SECRET: 'ok-secret',
      WRD_HOST_HEALTH_URL: `http://127.0.0.1:${address.port}/health`,
      WRD_HOST_AUTH_URL: `http://127.0.0.1:${address.port}/api/auth/login/host`,
      WRD_HOST_WAIT_INTERVAL_SECONDS: '0.1',
    }),
    stdio: 'ignore',
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  });

  for (let i = 0; i < 50; i += 1) {
    if (fs.existsSync(fixture.pythonMarkerPath)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.equal(fs.existsSync(fixture.pythonMarkerPath), true, 'host.py should start after health check succeeds');
  assert.match(fs.readFileSync(fixture.pythonMarkerPath, 'utf8'), /host\.py/);
});

test('run-host-launchctl does not start host.py until host auth succeeds', async (t) => {
  const fixture = prepareRunnerProject();
  t.after(() => {
    fs.rmSync(fixture.projectDir, { recursive: true, force: true });
  });

  let allowAuth = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    if (req.url === '/api/auth/login/host' && req.method === 'POST') {
      if (!allowAuth) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"Invalid host secret"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"token":"fake-token","role":"host","expiresIn":"15m"}');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const child = spawn('bash', [fixture.runnerCopyPath], {
    cwd: fixture.projectDir,
    env: runnerEnv(fixture, {
      PYTHON_BIN: fixture.fakePythonPath,
      WRD_TEST_MARKER: fixture.pythonMarkerPath,
      WRD_TEST_PYTHON_SLEEP_SECONDS: '30',
      HOST_SHARED_SECRET: 'wrong-at-first',
      SERVER_URL: `http://127.0.0.1:${address.port}`,
      WRD_HOST_WAIT_INTERVAL_SECONDS: '0.1',
    }),
    stdio: 'ignore',
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  });

  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(fs.existsSync(fixture.pythonMarkerPath), false, 'host.py should not start while host auth fails');

  allowAuth = true;

  for (let i = 0; i < 50; i += 1) {
    if (fs.existsSync(fixture.pythonMarkerPath)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.equal(fs.existsSync(fixture.pythonMarkerPath), true, 'host.py should start after host auth succeeds');
});

// All launchctl commands are shell-function calls into this private state
// machine. The real LaunchAgents directory and service manager are never used.
function prepareLaunchctlFixture(t, options = {}) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-host launchctl-mock-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const launchdDir = path.join(projectDir, 'launchd');
  const installedDir = path.join(projectDir, 'installed');
  const temporaryDir = path.join(projectDir, 'temporary');
  for (const dir of [launchdDir, installedDir, temporaryDir]) fs.mkdirSync(dir);
  const label = 'com.webremotedesktop.host.fixture';
  const sourcePath = path.join(launchdDir, `${label}.plist`);
  const installedPath = path.join(installedDir, `${label}.plist`);
  const oldPlist = '<plist><dict><key>ProcessType</key><string>Background</string></dict></plist>\n';
  const newPlist = options.sameConfig ? oldPlist
    : '<plist><dict><key>ProcessType</key><string>Interactive</string></dict></plist>\n';
  fs.writeFileSync(sourcePath, newPlist);
  if (!options.missingInstalled) {
    fs.writeFileSync(installedPath, oldPlist);
    fs.utimesSync(installedPath, 1, 1);
  }
  const statePath = path.join(projectDir, 'state.json');
  const state = {
    loaded: options.loaded !== false, loadedPlist: oldPlist, calls: [],
    failProbe: options.failProbe === true,
    failNewBootstrap: options.failNewBootstrap === true,
    partialNewBootstrap: options.partialNewBootstrap === true,
    failRestoreBootstrap: options.failRestoreBootstrap === true,
    kickstartFailures: options.kickstartFailures || 0,
    newPlist,
  };
  fs.writeFileSync(statePath, JSON.stringify(state));
  const mockPath = path.join(projectDir, 'launchctl-mock.js');
  fs.writeFileSync(mockPath, `
const fs = require('node:fs');
const statePath = process.env.WRD_TEST_LAUNCHCTL_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const [command, ...args] = process.argv.slice(2);
const installedPath = process.env.WRD_TEST_INSTALLED;
const plistPath = args.at(-1);
const probe = command === 'remove' ? plistPath.endsWith('bootstrap-probe')
  : ['bootstrap', 'bootout'].includes(command) && plistPath !== installedPath;
const installed = fs.existsSync(installedPath) ? fs.readFileSync(installedPath, 'utf8') : null;
state.calls.push({ command, probe, installed, loaded: state.loaded, loadedPlist: state.loadedPlist });
let code = 0;
if (command === 'print') code = state.loaded ? 0 : 1;
else if (command === 'bootstrap' && probe) code = state.failProbe ? 5 : 0;
else if (command === 'bootstrap') {
  const config = fs.readFileSync(plistPath, 'utf8');
  if (config === state.newPlist && state.failNewBootstrap) {
    state.failNewBootstrap = false;
    state.loaded = state.partialNewBootstrap;
    if (state.loaded) state.loadedPlist = config;
    code = 5;
  } else if (config !== state.newPlist && state.failRestoreBootstrap) code = 5;
  else if (state.loaded) code = 5;
  else { state.loaded = true; state.loadedPlist = config; }
} else if (['bootout', 'remove'].includes(command) && !probe) state.loaded = false;
else if (command === 'kickstart') {
  if (state.kickstartFailures > 0) { state.kickstartFailures -= 1; code = 5; }
  else if (!state.loaded) code = 5;
}
fs.writeFileSync(statePath, JSON.stringify(state));
if (code) process.stderr.write('mock launchctl failure\\n');
process.exit(code);
`);
  const invocationPath = path.join(projectDir, 'invoke.sh');
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(invocationPath, `#!/bin/bash
set -euo pipefail
source ${shellQuote(helperPath)}
WRD_HOST_PLIST_DST="$WRD_TEST_INSTALLED"
launchctl() { "$WRD_TEST_NODE" "$WRD_TEST_LAUNCHCTL" "$@"; }
mktemp() { command mktemp "$WRD_TEST_TEMPORARY/$2.XXXXXX"; }
mkdir() {
  if [ "$#" = 2 ] && [ "$1" = -p ] && [ "$2" = "$HOME/Library/LaunchAgents" ]; then return 0; fi
  command mkdir "$@"
}
cp() {
  if [ "\${WRD_TEST_FAIL_INSTALL:-0}" = 1 ] && [ "$1" = "$WRD_HOST_PLIST_SRC" ]; then return 1; fi
  if [ "\${WRD_TEST_FAIL_BACKUP:-0}" = 1 ] && [ "$1" = "$WRD_HOST_PLIST_DST" ]; then return 1; fi
  if [ "\${WRD_TEST_FAIL_RESTORE_COPY:-0}" = 1 ] && [ "$1" != "$WRD_HOST_PLIST_SRC" ] && [ "$2" = "$WRD_HOST_PLIST_DST" ]; then return 1; fi
  command cp "$@"
}
wrd_host_launchctl_start
`);
  return { sourcePath, installedPath, oldPlist, newPlist, temporaryDir,
    run() {
      const result = spawnSync('bash', [invocationPath], {
        cwd: projectDir, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, PROJECT_DIR: projectDir, WRD_HOST_LABEL: label,
          WRD_HOST_LAUNCH_LOG: path.join(projectDir, 'wrd-host-launch.log'),
          WRD_HOST_LOG_FILE: path.join(projectDir, 'back-debug.log'),
          TMPDIR: temporaryDir, WRD_TEST_INSTALLED: installedPath,
          WRD_TEST_TEMPORARY: temporaryDir,
          WRD_TEST_NODE: process.execPath, WRD_TEST_LAUNCHCTL: mockPath,
          WRD_TEST_LAUNCHCTL_STATE: statePath,
          WRD_TEST_FAIL_INSTALL: options.failInstall ? '1' : '0',
          WRD_TEST_FAIL_BACKUP: options.failBackup ? '1' : '0',
          WRD_TEST_FAIL_RESTORE_COPY: options.failRestoreCopy ? '1' : '0' },
      });
      assert.ifError(result.error);
      return { ...result, state: JSON.parse(fs.readFileSync(statePath, 'utf8')) };
    } };
}

test('loaded unchanged host plist reuses kickstart without overwriting installed configuration', (t) => {
  const h = prepareLaunchctlFixture(t, { sameConfig: true });
  const before = fs.statSync(h.installedPath).mtimeMs;
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.state.calls.map(row => row.command), ['print', 'enable', 'kickstart']);
  assert.equal(fs.statSync(h.installedPath).mtimeMs, before);
  assert.equal(result.state.loadedPlist, h.oldPlist);
});

test('changed loaded host plist probes before stopping and bootstraps the replacement configuration', (t) => {
  const h = prepareLaunchctlFixture(t);
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state.loaded, true);
  assert.equal(result.state.loadedPlist, h.newPlist);
  const probe = result.state.calls.findIndex(row => row.command === 'bootstrap' && row.probe);
  const stop = result.state.calls.findIndex(row => row.command === 'bootout' && !row.probe);
  const install = result.state.calls.findIndex(row => row.command === 'bootstrap' && !row.probe);
  assert.ok(probe >= 0 && stop > probe && install > stop);
  assert.equal(result.state.calls[probe].installed, h.oldPlist);
  assert.equal(result.state.calls[stop].installed, h.oldPlist);
  assert.equal(result.state.calls[install].installed, h.newPlist);
  assert.equal(result.state.calls.slice(0, probe).some(row => row.command === 'kickstart'), false);
  assert.deepEqual(fs.readdirSync(h.temporaryDir), []);
});

test('failed bootstrap probe preserves the old loaded job and installed plist bytes and timestamp', (t) => {
  const h = prepareLaunchctlFixture(t, { failProbe: true });
  const before = fs.statSync(h.installedPath).mtimeMs;
  const result = h.run();
  assert.notEqual(result.status, 0);
  assert.equal(result.state.loaded, true);
  assert.equal(result.state.loadedPlist, h.oldPlist);
  assert.equal(fs.readFileSync(h.installedPath, 'utf8'), h.oldPlist);
  assert.equal(fs.statSync(h.installedPath).mtimeMs, before);
  assert.deepEqual(result.state.calls.map(row => row.command), ['print', 'bootstrap']);
  assert.match(result.stderr, /left loaded and untouched/);
  assert.deepEqual(fs.readdirSync(h.temporaryDir), []);
});

for (const missingInstalled of [false, true]) {
  test(`unloaded host installs and bootstraps normally (installed absent=${missingInstalled})`, (t) => {
    const h = prepareLaunchctlFixture(t, { loaded: false, missingInstalled });
    const result = h.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.state.loadedPlist, h.newPlist);
    assert.equal(fs.readFileSync(h.installedPath, 'utf8'), h.newPlist);
    assert.equal(result.state.calls.some(row => row.probe), false);
    assert.equal(result.state.calls.some(row => ['bootout', 'remove'].includes(row.command)), false);
  });
}

test('failed kickstart of unchanged host config falls back through the guarded rebootstrap path', (t) => {
  const h = prepareLaunchctlFixture(t, { sameConfig: true, kickstartFailures: 1 });
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state.loaded, true);
  assert.equal(result.state.loadedPlist, h.oldPlist);
  assert.equal(result.state.calls.filter(row => row.command === 'kickstart').length, 2);
  assert.ok(result.state.calls.some(row => row.command === 'bootstrap' && row.probe));
});

for (const partialNewBootstrap of [false, true]) {
  test(`replacement bootstrap failure restores the old file and job (partial registration=${partialNewBootstrap})`, (t) => {
    const h = prepareLaunchctlFixture(t, { failNewBootstrap: true, partialNewBootstrap });
    const result = h.run();
    assert.notEqual(result.status, 0);
    assert.equal(result.state.loaded, true);
    assert.equal(result.state.loadedPlist, h.oldPlist);
    assert.equal(fs.readFileSync(h.installedPath, 'utf8'), h.oldPlist);
    const boots = result.state.calls.filter(row => row.command === 'bootstrap' && !row.probe);
    assert.deepEqual(boots.map(row => row.installed), [h.newPlist, h.oldPlist]);
    assert.match(result.stderr, /previous.*restored/);
    assert.deepEqual(fs.readdirSync(h.temporaryDir), []);
  });
}

test('failed replacement installation restores the previously loaded job', (t) => {
  const h = prepareLaunchctlFixture(t, { failInstall: true });
  const result = h.run();
  assert.notEqual(result.status, 0);
  assert.equal(result.state.loaded, true);
  assert.equal(result.state.loadedPlist, h.oldPlist);
  assert.equal(fs.readFileSync(h.installedPath, 'utf8'), h.oldPlist);
});

test('rollback bootstrap failure is reported without claiming a running old job', (t) => {
  const h = prepareLaunchctlFixture(t, { failNewBootstrap: true, failRestoreBootstrap: true });
  const result = h.run();
  assert.notEqual(result.status, 0);
  assert.equal(result.state.loaded, false);
  assert.equal(fs.readFileSync(h.installedPath, 'utf8'), h.oldPlist);
  assert.match(result.stderr, /failed to restore.*agent/);
  assert.doesNotMatch(result.stderr, /previous.*agent.*restored/);
  const backups = fs.readdirSync(h.temporaryDir);
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(h.temporaryDir, backups[0]), 'utf8'), h.oldPlist);
});

test('failed rollback copy preserves the backup and reports failure without a success claim', (t) => {
  const h = prepareLaunchctlFixture(t, { failNewBootstrap: true, failRestoreCopy: true });
  const result = h.run();
  assert.notEqual(result.status, 0);
  assert.equal(result.state.loaded, false);
  assert.equal(fs.readFileSync(h.installedPath, 'utf8'), h.newPlist);
  assert.match(result.stderr, /failed to restore previous plist/);
  assert.doesNotMatch(result.stderr, /previous.*agent.*restored/);
  const backups = fs.readdirSync(h.temporaryDir);
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(h.temporaryDir, backups[0]), 'utf8'), h.oldPlist);
});

test('backup failure preserves the loaded job and installed configuration', (t) => {
  const h = prepareLaunchctlFixture(t, { failBackup: true });
  const before = fs.statSync(h.installedPath).mtimeMs;
  const result = h.run();
  assert.notEqual(result.status, 0);
  assert.equal(result.state.loaded, true);
  assert.equal(result.state.loadedPlist, h.oldPlist);
  assert.equal(fs.readFileSync(h.installedPath, 'utf8'), h.oldPlist);
  assert.equal(fs.statSync(h.installedPath).mtimeMs, before);
  assert.equal(result.state.calls.some(row => ['bootout', 'remove'].includes(row.command) && !row.probe), false);
  assert.deepEqual(fs.readdirSync(h.temporaryDir), []);
});

test('unloaded bootstrap failure remains failed and never invokes rollback', (t) => {
  const h = prepareLaunchctlFixture(t, { loaded: false, failNewBootstrap: true });
  const result = h.run();
  assert.notEqual(result.status, 0);
  assert.equal(result.state.loaded, false);
  assert.equal(fs.readFileSync(h.installedPath, 'utf8'), h.newPlist);
  assert.equal(result.state.calls.filter(row => row.command === 'bootstrap').length, 1);
  assert.equal(result.state.calls.some(row => ['bootout', 'remove'].includes(row.command)), false);
  assert.deepEqual(fs.readdirSync(h.temporaryDir), []);
});

test('loaded job without an installed rollback plist is left untouched', (t) => {
  const h = prepareLaunchctlFixture(t, { missingInstalled: true });
  const result = h.run();
  assert.notEqual(result.status, 0);
  assert.equal(result.state.loaded, true);
  assert.equal(result.state.loadedPlist, h.oldPlist);
  assert.equal(fs.existsSync(h.installedPath), false);
  assert.equal(result.state.calls.some(row => ['bootout', 'remove', 'kickstart'].includes(row.command)), false);
});

test('missing repo plist cannot stop or replace a loaded host', (t) => {
  const h = prepareLaunchctlFixture(t);
  fs.unlinkSync(h.sourcePath);
  const result = h.run();
  assert.notEqual(result.status, 0);
  assert.equal(result.state.loaded, true);
  assert.equal(fs.readFileSync(h.installedPath, 'utf8'), h.oldPlist);
  assert.equal(result.state.calls.some(row => ['bootout', 'remove', 'kickstart'].includes(row.command)), false);
});
