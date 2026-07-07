const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const scriptPath = path.join(__dirname, 'setup-cloudflare.sh');

function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function makeFixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-cloudflare-'));
  const homeDir = path.join(rootDir, 'home');
  const binDir = path.join(rootDir, 'bin');
  const logFile = path.join(rootDir, 'cloudflared.log');
  const listFile = path.join(rootDir, 'tunnel-list.txt');

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(listFile, 'test-tunnel-id wrd-tunnel\n', 'utf8');

  writeExecutable(
    path.join(binDir, 'cloudflared'),
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$TEST_LOG_FILE"
if [ "$1" = "tunnel" ] && [ "$2" = "list" ]; then
  cat "$TEST_LIST_FILE"
fi
`
  );

  return { rootDir, homeDir, binDir, logFile, listFile };
}

function runScript(extraEnv = {}) {
  const fixture = makeFixture();
  const env = {
    ...process.env,
    HOME: fixture.homeDir,
    PATH: `${fixture.binDir}:${process.env.PATH}`,
    TEST_LOG_FILE: fixture.logFile,
    TEST_LIST_FILE: fixture.listFile,
    ...extraEnv,
  };

  const result = spawnSync('bash', [scriptPath], {
    cwd: path.join(__dirname, '..'),
    env,
    encoding: 'utf8',
  });

  return { fixture, result };
}

test('setup-cloudflare script defines optional dev subdomain env contract and operator output', () => {
  assert.equal(fs.existsSync(scriptPath), true, 'script should exist');
  const syntaxCheck = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
  assert.equal(syntaxCheck.status, 0, `bash -n failed: ${syntaxCheck.stderr}`);
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /DEV_DOMAIN="\$\{DEV_DOMAIN:-dev\.link\.stockhub\.wiki\}"/);
  assert.match(source, /DEV_LOCAL_ORIGIN="\$\{DEV_LOCAL_ORIGIN:-http:\/\/127\.0\.0\.1:5173\}"/);
  assert.match(source, /ENABLE_DEV_SUBDOMAIN="\$\{ENABLE_DEV_SUBDOMAIN:-0\}"/);
  assert.match(source, /echo "Primary domain: https:\/\/\$DOMAIN"/);
  assert.match(source, /echo "Primary origin: \$LOCAL_ORIGIN"/);
  assert.match(source, /echo "Dev domain: https:\/\/\$DEV_DOMAIN"/);
  assert.match(source, /echo "Dev origin: \$DEV_LOCAL_ORIGIN"/);
});

test('setup-cloudflare script keeps only the primary ingress and route by default', () => {
  const { fixture, result } = runScript();

  assert.equal(result.status, 0, `script exited with ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /Domain: link\.stockhub\.wiki/);
  assert.match(result.stdout, /Local origin: http:\/\/127\.0\.0\.1:8080/);
  assert.match(result.stdout, /Dev subdomain: disabled/);

  const configPath = path.join(fixture.homeDir, '.cloudflared', 'config.yml');
  const config = fs.readFileSync(configPath, 'utf8');
  assert.match(config, /hostname: link\.stockhub\.wiki/);
  assert.match(config, /service: http:\/\/127\.0\.0\.1:8080/);
  assert.match(config, /service: http_status:404/);
  assert.doesNotMatch(config, /dev\.link\.stockhub\.wiki/);
  assert.doesNotMatch(config, /127\.0\.0\.1:5173/);
  assert.match(config, /hostname: link\.stockhub\.wiki[\s\S]*service: http:\/\/127\.0\.0\.1:8080[\s\S]*service: http_status:404/);

  const routeLog = fs.readFileSync(fixture.logFile, 'utf8');
  assert.match(routeLog, /tunnel route dns wrd-tunnel link\.stockhub\.wiki/);
  assert.doesNotMatch(routeLog, /tunnel route dns wrd-tunnel dev\.link\.stockhub\.wiki/);
});

test('setup-cloudflare script adds the dev ingress and dns route only when enabled', () => {
  const { fixture, result } = runScript({
    ENABLE_DEV_SUBDOMAIN: '1',
    DEV_DOMAIN: 'dev.example.com',
    DEV_LOCAL_ORIGIN: 'http://127.0.0.1:55173',
  });

  assert.equal(result.status, 0, `script exited with ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /Dev domain: https:\/\/dev\.example\.com/);
  assert.match(result.stdout, /Dev origin: http:\/\/127\.0\.0\.1:55173/);

  const configPath = path.join(fixture.homeDir, '.cloudflared', 'config.yml');
  const config = fs.readFileSync(configPath, 'utf8');
  assert.match(config, /hostname: link\.stockhub\.wiki/);
  assert.match(config, /service: http:\/\/127\.0\.0\.1:8080/);
  assert.match(config, /hostname: dev\.example\.com/);
  assert.match(config, /service: http:\/\/127\.0\.0\.1:55173/);
  assert.match(config, /service: http_status:404/);
  assert.match(
    config,
    /hostname: link\.stockhub\.wiki[\s\S]*service: http:\/\/127\.0\.0\.1:8080[\s\S]*hostname: dev\.example\.com[\s\S]*service: http:\/\/127\.0\.0\.1:55173[\s\S]*service: http_status:404/
  );

  const routeLog = fs.readFileSync(fixture.logFile, 'utf8');
  assert.match(routeLog, /tunnel route dns wrd-tunnel link\.stockhub\.wiki/);
  assert.match(routeLog, /tunnel route dns wrd-tunnel dev\.example\.com/);
});
