const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync, spawn } = require('node:child_process');

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
  };
}

test('host launchagent plist exists and uses the repo host label', () => {
  assert.equal(fs.existsSync(launchdPath), true, 'host launchagent plist should exist');
  const source = fs.readFileSync(launchdPath, 'utf8');

  assert.match(source, /com\.webremotedesktop\.host/);
  assert.match(source, /run-host-launchctl\.sh/);
  assert.match(source, /RunAtLoad/);
  assert.match(source, /KeepAlive/);
  assert.match(source, /back-debug\.log/);
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
    env: {
      ...process.env,
      PYTHON_BIN: fixture.fakePythonPath,
      WRD_TEST_MARKER: fixture.pythonMarkerPath,
      WRD_TEST_PYTHON_SLEEP_SECONDS: '30',
      WRD_HOST_HEALTH_URL: 'http://127.0.0.1:65531/health',
      WRD_HOST_WAIT_INTERVAL_SECONDS: '0.1',
    },
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
    env: {
      ...process.env,
      PYTHON_BIN: fixture.fakePythonPath,
      WRD_TEST_MARKER: fixture.pythonMarkerPath,
      WRD_TEST_PYTHON_SLEEP_SECONDS: '30',
      HOST_SHARED_SECRET: 'ok-secret',
      WRD_HOST_HEALTH_URL: `http://127.0.0.1:${address.port}/health`,
      WRD_HOST_AUTH_URL: `http://127.0.0.1:${address.port}/api/auth/login/host`,
      WRD_HOST_WAIT_INTERVAL_SECONDS: '0.1',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  });

  for (let i = 0; i < 20; i += 1) {
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
    env: {
      ...process.env,
      PYTHON_BIN: fixture.fakePythonPath,
      WRD_TEST_MARKER: fixture.pythonMarkerPath,
      WRD_TEST_PYTHON_SLEEP_SECONDS: '30',
      HOST_SHARED_SECRET: 'wrong-at-first',
      SERVER_URL: `http://127.0.0.1:${address.port}`,
      WRD_HOST_WAIT_INTERVAL_SECONDS: '0.1',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  });

  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(fs.existsSync(fixture.pythonMarkerPath), false, 'host.py should not start while host auth fails');

  allowAuth = true;

  for (let i = 0; i < 20; i += 1) {
    if (fs.existsSync(fixture.pythonMarkerPath)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.equal(fs.existsSync(fixture.pythonMarkerPath), true, 'host.py should start after host auth succeeds');
});
