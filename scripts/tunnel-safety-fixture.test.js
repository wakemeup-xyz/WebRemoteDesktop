const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const startSafePath = path.join(__dirname, 'start-safe-wrd.sh');
const runSafePath = path.join(__dirname, 'run-safe-quicktunnel.sh');
const restartSafePath = path.join(__dirname, 'restart-safe-tunnel.sh');

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-tunnel-boundary-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);

  writeExecutable(
    path.join(bin, 'launchctl'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$WRD_LAUNCHCTL_LOG"
if [ "$1" = "print" ] && [ "\${WRD_FAKE_LAUNCHCTL_PRINT:-}" != "loaded" ]; then
  exit 1
fi
exit 0
`,
  );
  writeExecutable(
    path.join(bin, 'curl'),
    `#!/bin/sh
case "$*" in
  */api/status*) printf '%s\\n' '{"hostOnline":true}' ;;
  */health*) printf '%s\\n' '{"status":"ok"}' ;;
esac
exit 0
`,
  );
  writeExecutable(
    path.join(bin, 'python3'),
    `#!/bin/sh
state="\${WRD_FIXTURE_HEALTH_STATE:-deliverable}"
if [ "$state" = "deliverable" ]; then deliverable=true; else deliverable=false; fi
printf '{"state":"%s","deliverable":%s}\\n' "$state" "$deliverable"
`,
  );
  writeExecutable(path.join(bin, 'pgrep'), '#!/bin/sh\nexit 1\n');
  writeExecutable(path.join(bin, 'lsof'), '#!/bin/sh\nexit 1\n');
  writeExecutable(
    path.join(bin, 'pkill'),
    `#!/bin/sh
printf 'pkill %s\\n' "$*" >> "$WRD_PROCESS_LOG"
exit 0
`,
  );
  writeExecutable(
    path.join(bin, 'node'),
    `#!/bin/sh
printf 'node\\n' >> "$WRD_SPAWN_LOG"
exit 1
`,
  );
  writeExecutable(path.join(bin, 'nohup'), '#!/bin/sh\nexec "$@"\n');

  const fixture = {
    root,
    bin,
    bashEnv: path.join(root, 'bash-env.sh'),
    launchctlLog: path.join(root, 'launchctl.log'),
    mutationLog: path.join(root, 'mutation.log'),
    processLog: path.join(root, 'process.log'),
    spawnLog: path.join(root, 'spawn.log'),
    urlFile: path.join(root, 'current-url.txt'),
    archiveFile: path.join(root, 'last-url.txt'),
    safeTunnelPidFile: path.join(root, 'safe-tunnel.pid'),
    signalPidFile: path.join(root, 'signal.pid'),
    hostPidFile: path.join(root, 'host.pid'),
  };
  fs.writeFileSync(
    fixture.bashEnv,
    `kill() {
  if [ "\${1:-}" = "-0" ]; then
    if [ "\${2:-}" = "\${WRD_EXISTING_PID:-}" ]; then return 0; fi
    if [ "\${WRD_FAKE_KILL_ZERO:-}" = "ready-then-dead" ]; then
      if [ -n "\${WRD_KILL_READY_FILE:-}" ] && [ -e "\${WRD_KILL_READY_FILE}" ]; then return 1; fi
      if [ -n "\${WRD_KILL_STATE_FILE:-}" ] && [ ! -e "\${WRD_KILL_STATE_FILE}" ]; then
        : > "\${WRD_KILL_STATE_FILE}"
      fi
      return 0
    fi
    if [ "\${WRD_FAKE_KILL_ZERO:-}" = "false" ]; then return 1; fi
    command kill "$@"
    return $?
  fi
  printf 'kill %s\\n' "$*" >> "$WRD_MUTATION_LOG"
  return 0
}
rm() {
  printf 'rm %s\\n' "$*" >> "$WRD_MUTATION_LOG"
  return 0
}
`,
  );
  return fixture;
}

function runExecutable(scriptPath, fixture, extraEnv = {}) {
  return spawnSync('/bin/bash', [scriptPath], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH || ''}`,
      HOME: fixture.root,
      BASH_ENV: fixture.bashEnv,
      WRD_LAUNCHCTL_LOG: fixture.launchctlLog,
      WRD_MUTATION_LOG: fixture.mutationLog,
      WRD_PROCESS_LOG: fixture.processLog,
      WRD_SPAWN_LOG: fixture.spawnLog,
      WRD_EXISTING_PID: 'existing',
      ...extraEnv,
    },
  });
}

function combinedOutput(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
}

function installTunnelPlist(fixture, runAtLoad, keepAlive) {
  const plistPath = path.join(
    fixture.root,
    'Library',
    'LaunchAgents',
    'com.webremotedesktop.tunnel.plist',
  );
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.webremotedesktop.tunnel</string>
  <key>RunAtLoad</key><${runAtLoad ? 'true' : 'false'}/>
  <key>KeepAlive</key><${keepAlive ? 'true' : 'false'}/>
</dict></plist>
`,
  );
  return plistPath;
}

function prepareExistingLocalState(fixture) {
  for (const filePath of [
    fixture.safeTunnelPidFile,
    fixture.signalPidFile,
    fixture.hostPidFile,
  ]) {
    fs.writeFileSync(filePath, 'existing\n');
  }
  fs.writeFileSync(fixture.urlFile, 'https://preserved.trycloudflare.com\n');
}

function startSafeEnv(fixture) {
  return {
    WRD_FAKE_LAUNCHCTL_PRINT: 'loaded',
    SAFE_URL_FILE: fixture.urlFile,
    SAFE_TUNNEL_SUPERVISOR_PID: fixture.safeTunnelPidFile,
    SIGNAL_PID_FILE: fixture.signalPidFile,
    HOST_PID_FILE: fixture.hostPidFile,
    WRD_FIXTURE_HEALTH_STATE: 'deliverable',
  };
}

test('executable safe startup preserves a loaded current false/false job', () => {
  const fixture = makeFixture();
  prepareExistingLocalState(fixture);
  installTunnelPlist(fixture, false, false);
  try {
    const result = runExecutable(startSafePath, fixture, startSafeEnv(fixture));
    assert.equal(result.status, 0, combinedOutput(result));
    assert.deepEqual(readLines(fixture.launchctlLog), [
      `print gui/${process.getuid()}/com.webremotedesktop.tunnel`,
    ]);
    assert.equal(fs.readFileSync(fixture.urlFile, 'utf8'), 'https://preserved.trycloudflare.com\n');
    assert.deepEqual(readLines(fixture.mutationLog), []);
    assert.deepEqual(readLines(fixture.spawnLog), []);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('executable safe startup disables and boots out a loaded legacy true/true job', () => {
  const fixture = makeFixture();
  prepareExistingLocalState(fixture);
  const plistPath = installTunnelPlist(fixture, true, true);
  try {
    const result = runExecutable(startSafePath, fixture, startSafeEnv(fixture));
    assert.equal(result.status, 0, combinedOutput(result));
    assert.deepEqual(readLines(fixture.launchctlLog), [
      `print gui/${process.getuid()}/com.webremotedesktop.tunnel`,
      `disable gui/${process.getuid()}/com.webremotedesktop.tunnel`,
      `bootout gui/${process.getuid()} ${plistPath}`,
    ]);
    assert.equal(readLines(fixture.launchctlLog).some((line) => /bootstrap|kickstart|remove/.test(line)), false);
    assert.equal(fs.readFileSync(fixture.urlFile, 'utf8'), 'https://preserved.trycloudflare.com\n');
    assert.deepEqual(readLines(fixture.mutationLog), []);
    assert.deepEqual(readLines(fixture.spawnLog), []);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('executable safe startup preserves a loaded job when plist inspection fails', () => {
  const fixture = makeFixture();
  prepareExistingLocalState(fixture);
  installTunnelPlist(fixture, true, true);
  writeExecutable(path.join(fixture.bin, 'plutil'), '#!/bin/sh\nexit 1\n');
  try {
    const result = runExecutable(startSafePath, fixture, startSafeEnv(fixture));
    assert.equal(result.status, 0, combinedOutput(result));
    assert.deepEqual(readLines(fixture.launchctlLog), [
      `print gui/${process.getuid()}/com.webremotedesktop.tunnel`,
    ]);
    assert.match(combinedOutput(result), /plist state=unknown/);
    assert.equal(fs.readFileSync(fixture.urlFile, 'utf8'), 'https://preserved.trycloudflare.com\n');
    assert.deepEqual(readLines(fixture.mutationLog), []);
    assert.deepEqual(readLines(fixture.spawnLog), []);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('executable run-safe states diagnose without kill, URL deletion, or replacement', () => {
  for (const state of ['unauthorized', 'unreachable', 'connector-exit']) {
    const fixture = makeFixture();
    const originalUrl = 'https://preserved.trycloudflare.com\n';
    fs.writeFileSync(fixture.urlFile, originalUrl);
    fs.writeFileSync(fixture.archiveFile, originalUrl);
    const cloudflaredPath = path.join(fixture.bin, 'cloudflared-fixture');
    const cloudflaredBody = {
      unauthorized: "printf '2026 fixture Unauthorized: Tunnel not found\\n'\n",
      unreachable: "printf 'https://fixture.trycloudflare.com\\n'\n",
      'connector-exit': "printf 'fixture connector exited\\n'\n",
    }[state];
    writeExecutable(
      cloudflaredPath,
      `#!/bin/sh
printf 'cloudflared ${state}\\n' >> "$WRD_SPAWN_LOG"
if [ -n "$WRD_KILL_READY_FILE" ]; then : > "$WRD_KILL_READY_FILE"; fi
${cloudflaredBody}
exit 1
`,
    );
    try {
      const result = runExecutable(runSafePath, fixture, {
        CLOUDFLARED: cloudflaredPath,
        LOG_FILE: path.join(fixture.root, `${state}.log`),
        URL_FILE: fixture.urlFile,
        URL_ARCHIVE_FILE: fixture.archiveFile,
        PID_FILE: path.join(fixture.root, `${state}.pid`),
        URL_POLL_ATTEMPTS: '10',
        URL_POLL_INTERVAL_SECONDS: '0.2',
        URL_READY_TIMEOUT_SECONDS: '0',
        WRD_FIXTURE_HEALTH_STATE: state === 'unreachable' ? 'origin-unreachable' : 'deliverable',
        WRD_FAKE_KILL_ZERO: 'ready-then-dead',
        WRD_KILL_STATE_FILE: path.join(fixture.root, `${state}.kill-state`),
        WRD_KILL_READY_FILE: path.join(fixture.root, `${state}.ready`),
      });
      const output = combinedOutput(result);
      assert.equal(result.status, 1, `${state}: ${output}`);
      assert.match(output, /diagnos/);
      if (state === 'unauthorized') assert.match(output, /Unauthorized: Tunnel not found/);
      if (state === 'unreachable') assert.match(output, /URL is unreachable/);
      if (state === 'connector-exit') assert.match(output, /tunnel exited/);
      assert.deepEqual(readLines(fixture.mutationLog), []);
      assert.deepEqual(readLines(fixture.spawnLog), [`cloudflared ${state}`]);
      assert.deepEqual(readLines(fixture.launchctlLog), []);
      assert.equal(fs.readFileSync(fixture.urlFile, 'utf8'), originalUrl);
      assert.equal(fs.readFileSync(fixture.archiveFile, 'utf8'), originalUrl);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('executable explicit restart retains the authorized launchctl lifecycle', () => {
  const fixture = makeFixture();
  try {
    const result = runExecutable(restartSafePath, fixture, {
      SAFE_URL_FILE: path.join(fixture.root, 'new-url.txt'),
      SAFE_TUNNEL_SUPERVISOR_LOG: path.join(fixture.root, 'supervisor.log'),
      SAFE_QUICK_TUNNEL_LOG: path.join(fixture.root, 'quicktunnel.log'),
      RESTART_URL_POLL_ATTEMPTS: '1',
      RESTART_URL_POLL_INTERVAL_SECONDS: '0',
    });
    assert.equal(result.status, 1, combinedOutput(result));
    const launchctl = readLines(fixture.launchctlLog);
    assert.equal(launchctl.some((line) => line.startsWith('bootstrap ')), true);
    assert.equal(launchctl.some((line) => line.startsWith('enable ')), true);
    assert.equal(launchctl.some((line) => line.startsWith('kickstart ')), true);
    assert.equal(readLines(fixture.processLog).filter((line) => line.startsWith('pkill ')).length, 2);
    assert.deepEqual(readLines(fixture.spawnLog), []);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
