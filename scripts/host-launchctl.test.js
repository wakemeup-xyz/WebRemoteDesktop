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
    HOME: fixture.projectDir,
    WRD_TURN_JSON: path.join(fixture.projectDir, 'no-production-turn.json'),
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

test('run-host-launchctl starts host.py after local health/auth even with an unusable proxy', async (t) => {
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
      HTTP_PROXY: 'http://127.0.0.1:1',
      HTTPS_PROXY: 'http://127.0.0.1:1',
      ALL_PROXY: 'http://127.0.0.1:1',
      http_proxy: 'http://127.0.0.1:1',
      https_proxy: 'http://127.0.0.1:1',
      all_proxy: 'http://127.0.0.1:1',
      NO_PROXY: '',
      no_proxy: '',
      WRD_HOST_AUTH_URL: `http://127.0.0.1:${address.port}/api/auth/login/host`,
      WRD_HOST_WAIT_INTERVAL_SECONDS: '0.1',
    }),
    stdio: 'ignore',
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  });

  // This is process scheduling allowance, not a Viewer startup SLA.
  for (let i = 0; i < 200; i += 1) {
    if (fs.existsSync(fixture.pythonMarkerPath)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.equal(fs.existsSync(fixture.pythonMarkerPath), true,
    `host.py should start after health check succeeds: ${fs.existsSync(fixture.launchLogPath) ? fs.readFileSync(fixture.launchLogPath, 'utf8') : 'no wrapper log'}`);
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

  for (let i = 0; i < 200; i += 1) {
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
    partialProbeBootstrap: options.partialProbeBootstrap === true,
    failProbeBootout: options.failProbeBootout === true || options.failProbeCleanup === true,
    failProbeRemove: options.failProbeCleanup === true,
    probeLoaded: false,
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
const probe = command === 'remove' ? plistPath.startsWith('com.webremotedesktop.host.bootstrap-probe')
  : ['bootstrap', 'bootout'].includes(command) && plistPath !== installedPath;
const installed = fs.existsSync(installedPath) ? fs.readFileSync(installedPath, 'utf8') : null;
const probePlist = probe && command === 'bootstrap' ? fs.readFileSync(plistPath, 'utf8') : '';
const probeLabel = probePlist.match(/<key>Label<\\/key>\\s*<string>([^<]+)<\\/string>/)?.[1];
state.calls.push({ command, probe, installed, loaded: state.loaded, loadedPlist: state.loadedPlist,
  ...(probe && command === 'bootstrap' ? { probeLabel, probePath: plistPath,
    privateDirectoryMode: fs.statSync(require('node:path').dirname(plistPath)).mode & 0o777 } : {}) });
let code = 0;
if (command === 'print') code = state.loaded ? 0 : 1;
else if (command === 'bootstrap' && probe) {
  code = state.failProbe || !plistPath.endsWith('.plist') ? 5 : 0;
  if (!code || state.partialProbeBootstrap) state.probeLoaded = true;
} else if (command === 'bootout' && probe) {
  if (state.failProbeBootout || !state.probeLoaded) code = 5;
  else state.probeLoaded = false;
} else if (command === 'remove' && probe) {
  if (state.failProbeRemove || !state.probeLoaded) code = 5;
  else state.probeLoaded = false;
}
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
mktemp() {
  if [ "$1" = -t ]; then command mktemp "$WRD_TEST_TEMPORARY/$2.XXXXXX";
  else command mktemp "$@"; fi
}
cat() { if [ "\${WRD_TEST_FAIL_PROBE_WRITE:-0}" = 1 ]; then return 1; else command cat "$@"; fi; }
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
if [ "\${WRD_TEST_PROBE_ONLY:-0}" = 1 ]; then
  wrd_host_launchctl_can_bootstrap
  wrd_host_launchctl_can_bootstrap
else
  wrd_host_launchctl_start
fi
`);
  return { sourcePath, installedPath, oldPlist, newPlist, temporaryDir,
    run() {
      const result = spawnSync('bash', [invocationPath], {
        cwd: projectDir, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, PROJECT_DIR: projectDir, WRD_HOST_LABEL: label,
          WRD_HOST_LAUNCH_LOG: path.join(projectDir, 'wrd-host-launch.log'),
          WRD_HOST_LOG_FILE: path.join(projectDir, 'back-debug.log'),
          TMPDIR: temporaryDir, WRD_TEST_INSTALLED: installedPath,
          WRD_TEST_TEMPORARY: temporaryDir,
          WRD_TEST_PROBE_ONLY: options.probeOnly ? '1' : '0',
          WRD_TEST_FAIL_PROBE_WRITE: options.failProbeWrite ? '1' : '0',
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
  assert.deepEqual(result.state.calls.map(row => row.command), ['print', 'bootstrap', 'bootout', 'remove']);
  assert.match(result.stderr, /left loaded and untouched/);
  assert.doesNotMatch(result.stderr, /this shell cannot bootstrap|GUI Terminal/);
  assert.deepEqual(fs.readdirSync(h.temporaryDir), []);
});

test('bootstrap probes use private directories, plist suffixes and unique labels without residue', (t) => {
  const h = prepareLaunchctlFixture(t, { probeOnly: true });
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  const probes = result.state.calls.filter(row => row.command === 'bootstrap');
  assert.equal(probes.length, 2);
  for (const probe of probes) {
    assert.equal(path.basename(probe.probePath), 'probe.plist');
    assert.equal(probe.privateDirectoryMode, 0o700);
    assert.match(probe.probeLabel, /^com\.webremotedesktop\.host\.bootstrap-probe\.[A-Za-z0-9.-]+$/);
    assert.equal(fs.existsSync(path.dirname(probe.probePath)), false);
  }
  assert.notEqual(probes[0].probeLabel, probes[1].probeLabel);
  assert.notEqual(probes[0].probePath, probes[1].probePath);
  assert.equal(result.state.loaded, true);
  assert.equal(result.state.loadedPlist, h.oldPlist);
  assert.equal(result.state.probeLoaded, false);
  assert.deepEqual(fs.readdirSync(h.temporaryDir), []);
});

test('failed probe cleanup blocks reload and leaves the old Host and installed plist untouched', (t) => {
  const h = prepareLaunchctlFixture(t, { failProbeCleanup: true });
  const before = fs.statSync(h.installedPath).mtimeMs;
  const result = h.run();
  assert.notEqual(result.status, 0);
  assert.equal(result.state.loaded, true);
  assert.equal(result.state.loadedPlist, h.oldPlist);
  assert.equal(fs.readFileSync(h.installedPath, 'utf8'), h.oldPlist);
  assert.equal(fs.statSync(h.installedPath).mtimeMs, before);
  assert.equal(result.state.calls.some(row => ['bootout', 'remove', 'kickstart'].includes(row.command) && !row.probe), false);
  assert.match(result.stderr, /probe cleanup/);
  assert.deepEqual(fs.readdirSync(h.temporaryDir), []);
});

test('probe cleanup can fall back to removing only its own unique label', (t) => {
  const h = prepareLaunchctlFixture(t, { failProbeBootout: true });
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state.loadedPlist, h.newPlist);
  assert.equal(result.state.probeLoaded, false);
  assert.ok(result.state.calls.some(row => row.command === 'remove' && row.probe));
  assert.deepEqual(fs.readdirSync(h.temporaryDir), []);
});

test('a partially registered failed probe cleans only itself and does not reload the Host', (t) => {
  const h = prepareLaunchctlFixture(t, { failProbe: true, partialProbeBootstrap: true });
  const result = h.run();
  assert.notEqual(result.status, 0);
  assert.equal(result.state.loaded, true);
  assert.equal(result.state.loadedPlist, h.oldPlist);
  assert.equal(result.state.probeLoaded, false);
  assert.equal(result.state.calls.some(row => ['bootout', 'remove', 'kickstart'].includes(row.command) && !row.probe), false);
  assert.deepEqual(fs.readdirSync(h.temporaryDir), []);
});

test('failed probe plist write is explicit even when caller tests the helper return status', (t) => {
  const h = prepareLaunchctlFixture(t, { failProbeWrite: true });
  const result = h.run();
  assert.notEqual(result.status, 0);
  assert.equal(result.state.loaded, true);
  assert.equal(result.state.loadedPlist, h.oldPlist);
  assert.deepEqual(result.state.calls.map(row => row.command), ['print']);
  assert.match(result.stderr, /could not write bootstrap probe plist/);
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

function prepareRestartHostFixture(t, { helperStatus = 7, livePid = '7001', oldPid = '7001', failPidWrite = false } = {}) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-restart-host-mock-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const scriptsDir = path.join(projectDir, 'scripts');
  fs.mkdirSync(scriptsDir);
  fs.mkdirSync(path.join(projectDir, 'python-host'));
  const pidPath = path.join(projectDir, 'host.pid');
  const safePidPath = path.join(projectDir, 'safe-host.pid');
  const tracePath = path.join(projectDir, 'trace.txt');
  const seenPidPath = path.join(projectDir, 'helper-seen-host.pid');
  const seenSafePidPath = path.join(projectDir, 'helper-seen-safe.pid');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const source = fs.readFileSync(path.join(__dirname, 'restart-host.sh'), 'utf8')
    .replace(/^PID_FILE=.*$/m, `PID_FILE=${quote(pidPath)}`)
    .replace(/^SAFE_PID_FILE=.*$/m, `SAFE_PID_FILE=${quote(safePidPath)}`);
  const restartPath = path.join(scriptsDir, 'restart-host.sh');
  fs.writeFileSync(restartPath, source);
  fs.writeFileSync(pidPath, `${oldPid}\n`);
  fs.writeFileSync(safePidPath, `${oldPid}\n`);
  fs.writeFileSync(path.join(scriptsDir, 'lib-host-launchctl.sh'), `
wrd_host_launchctl_restart() {
  [ ! -f "$PID_FILE" ] || cp "$PID_FILE" "$WRD_TEST_SEEN_PID"
  [ ! -f "$SAFE_PID_FILE" ] || cp "$SAFE_PID_FILE" "$WRD_TEST_SEEN_SAFE_PID"
  if [ "$WRD_TEST_HELPER_STATUS" != 0 ]; then echo 'mock helper reason: bootstrap preflight rejected' >&2; fi
  return "$WRD_TEST_HELPER_STATUS"
}
`);
  // Retain the actual project's locator and cwd filter; replace only process
  // discovery/liveness primitives with deterministic private fixture data.
  fs.writeFileSync(path.join(scriptsDir, 'lib-safe-wrd.sh'),
    fs.readFileSync(path.join(__dirname, 'lib-safe-wrd.sh'), 'utf8') + `
pgrep() {
  printf 'pgrep\\n' >> "$WRD_TEST_TRACE"
  printf '9009\\n'
  [ -z "$WRD_TEST_LIVE_PID" ] || printf '%s\\n' "$WRD_TEST_LIVE_PID"
  return 0
}
lsof() {
  local fixture_pid=''
  while [ "$#" -gt 0 ]; do
    if [ "$1" = -p ]; then fixture_pid="$2"; shift 2; else shift; fi
  done
  if [ "$fixture_pid" = 9009 ]; then printf 'n/foreign-project/python-host\\n'
  elif [ -n "$WRD_TEST_LIVE_PID" ] && [ "$fixture_pid" = "$WRD_TEST_LIVE_PID" ]; then printf 'n%s/python-host\\n' "$PROJECT_DIR"
  else return 1; fi
}
kill() {
  [ "\${1:-}" = -0 ] || return 99
  [ -n "\${2:-}" ] || return 1
  [ "$2" = 9009 ] || { [ -n "$WRD_TEST_LIVE_PID" ] && [ "$2" = "$WRD_TEST_LIVE_PID" ]; }
}
curl() { printf 'health\\n' >> "$WRD_TEST_TRACE"; printf '{"hostOnline":true}'; }
sleep() { return 0; }
if [ "\${WRD_TEST_FAIL_PID_WRITE:-0}" = 1 ]; then
  wrd_safe_write_pid_file() { printf 'write-attempt\\n' >> "$WRD_TEST_TRACE"; return 19; }
fi
`);
  return { pidPath, safePidPath, seenPidPath, seenSafePidPath,
    run() {
      const result = spawnSync('bash', [restartPath], { encoding: 'utf8', timeout: 5_000,
        env: { ...process.env, WRD_TEST_HELPER_STATUS: String(helperStatus),
          WRD_TEST_LIVE_PID: livePid, WRD_TEST_SEEN_PID: seenPidPath,
          WRD_TEST_SEEN_SAFE_PID: seenSafePidPath, WRD_TEST_TRACE: tracePath,
          WRD_TEST_FAIL_PID_WRITE: failPidWrite ? '1' : '0' } });
      assert.ifError(result.error);
      return { ...result, trace: fs.existsSync(tracePath) ? fs.readFileSync(tracePath, 'utf8') : '' };
    } };
}

for (const [name, livePid, oldPid] of [
  ['preflight rejected while the original project Host remains live', '7001', '7001'],
  ['failed replacement rolled back to a new project Host PID', '8002', '7001'],
]) {
  test(`restart-host reconciles both PID files when ${name}`, (t) => {
    const h = prepareRestartHostFixture(t, { livePid, oldPid });
    const result = h.run();
    assert.equal(result.status, 7);
    assert.match(result.stderr, /mock helper reason: bootstrap preflight rejected/);
    assert.equal(fs.existsSync(h.seenPidPath), true, 'old PID file must still exist when helper runs');
    assert.equal(fs.existsSync(h.seenSafePidPath), true);
    assert.equal(fs.readFileSync(h.seenPidPath, 'utf8'), `${oldPid}\n`);
    assert.equal(fs.readFileSync(h.seenSafePidPath, 'utf8'), `${oldPid}\n`);
    assert.equal(fs.readFileSync(h.pidPath, 'utf8'), `${livePid}\n`);
    assert.equal(fs.readFileSync(h.safePidPath, 'utf8'), `${livePid}\n`);
    assert.match(result.trace, /pgrep/);
    assert.doesNotMatch(result.trace, /health/, 'helper failure must not become a successful health result');
  });
}

test('restart-host failure removes stale PID files when no matching project Host remains', (t) => {
  const h = prepareRestartHostFixture(t, { livePid: '', oldPid: '9009' });
  const result = h.run();
  assert.equal(result.status, 7);
  assert.equal(fs.readFileSync(h.seenPidPath, 'utf8'), '9009\n');
  assert.equal(fs.readFileSync(h.seenSafePidPath, 'utf8'), '9009\n');
  assert.equal(fs.existsSync(h.pidPath), false);
  assert.equal(fs.existsSync(h.safePidPath), false);
  assert.match(result.trace, /pgrep/, 'an alive foreign-project PID is not evidence of a Host');
  assert.doesNotMatch(result.trace, /health/);
});

test('restart-host success still refreshes the new project PID and waits for hostOnline', (t) => {
  const h = prepareRestartHostFixture(t, { helperStatus: 0, livePid: '8003' });
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(h.seenPidPath), true, 'PID removal happens only after successful helper completion');
  assert.equal(fs.readFileSync(h.pidPath, 'utf8'), '8003\n');
  assert.equal(fs.readFileSync(h.safePidPath, 'utf8'), '8003\n');
  assert.match(result.trace, /health/);
  assert.match(result.stdout, /Host started with PID: 8003/);
});

test('restart-host keeps the helper failure status when PID refresh also fails', (t) => {
  const h = prepareRestartHostFixture(t, { helperStatus: 7, livePid: '8002', failPidWrite: true });
  const result = h.run();
  assert.equal(result.status, 7);
  assert.match(result.stderr, /mock helper reason: bootstrap preflight rejected/);
  assert.match(result.stderr, /warning: could not refresh/);
  assert.equal(result.trace.split('\n').filter(line => line === 'write-attempt').length, 2);
  assert.doesNotMatch(result.trace, /health/);
});
