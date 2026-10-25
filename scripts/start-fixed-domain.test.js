const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const scriptPath = path.join(__dirname, 'start-fixed-domain.sh');

test('start-fixed-domain preflights formal before delegating 8080 local recovery', () => {
  const syntax = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.match(source, /LOCAL_PORT="\$\{LOCAL_PORT:-8080\}"/);
  assert.match(source, /wrd_service\.py" restart-local/);
  assert.ok(source.indexOf('wrd_fixed_preflight_connector') < source.indexOf('wrd_service.py" restart-local'));
  assert.match(source, /restart-fixed-domain-tunnel\.sh/);
  assert.doesNotMatch(source, /\bpkill\b|\bnohup\b|launchctl submit|zsh -lc/);
  assert.doesNotMatch(source, /5173\/health|curl[^\n]*\$DEV_LOCAL_ORIGIN/);
});

test('start-fixed-domain prints optional dev-domain guidance', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.match(source, /DEV_DOMAIN="\$\{DEV_DOMAIN:-dev\.link\.stockhub\.wiki\}"/);
  assert.match(source, /DEV_LOCAL_ORIGIN="\$\{DEV_LOCAL_ORIGIN:-http:\/\/127\.0\.0\.1:5173\}"/);
  assert.match(source, /ENABLE_DEV_SUBDOMAIN="\$\{ENABLE_DEV_SUBDOMAIN:-0\}"/);
  assert.match(source, /echo "Dev origin is optional and not startup-blocking"/);
});

function runFixture(stage, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-fixed-start-'));
  try {
    const scripts = path.join(dir, 'scripts');
    const bin = path.join(dir, 'bin');
    const home = path.join(dir, 'home');
    fs.mkdirSync(scripts); fs.mkdirSync(bin); fs.mkdirSync(home);
    fs.copyFileSync(scriptPath, path.join(scripts, 'start-fixed-domain.sh'));
    fs.copyFileSync(path.join(__dirname, 'lib-fixed-domain.sh'), path.join(scripts, 'lib-fixed-domain.sh'));
    const calls = path.join(dir, 'calls');
    const canary = path.join(home, 'quick-canary');
    fs.writeFileSync(canary, 'unchanged quick fixture\n');
    fs.writeFileSync(path.join(bin, 'python3'), `#!/bin/sh
case "$1" in
  */wrd_fixed_launchagent.py) action="$2" ;;
  */wrd_service.py) action=local ;;
  *) exit 91 ;;
esac
printf '%s\\n' "$action" >> "$FIXTURE_CALLS"
[ "$action" = preflight ] && printf '%s|%s' "$WRD_FIXED_TUNNEL_NAME" "$WRD_FIXED_LABEL" > "$FIXTURE_CALLS.preflight"
[ "$FIXTURE_FAIL" = "$action" ] && exit 7
exit 0
`, { mode: 0o755 });
    fs.writeFileSync(path.join(scripts, 'restart-fixed-domain-tunnel.sh'), '#!/bin/sh\nprintf "formal\\n" >> "$FIXTURE_CALLS"\nprintf "%s|%s" "$WRD_FIXED_TUNNEL_NAME" "$WRD_FIXED_LABEL" > "$FIXTURE_CALLS.formal"\n[ "$FIXTURE_FAIL" = formal ] && exit 8\nexit 0\n');
    const result = spawnSync('bash', [path.join(scripts, 'start-fixed-domain.sh')], {
      encoding: 'utf8', timeout: 30000,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, FIXTURE_CALLS: calls,
        FIXTURE_FAIL: stage, ENABLE_DEV_SUBDOMAIN: '1', ...extraEnv },
    });
    assert.equal(fs.readFileSync(canary, 'utf8'), 'unchanged quick fixture\n');
    return { result, calls: fs.readFileSync(calls, 'utf8').trim().split('\n'),
      preflightEnvironment: fs.readFileSync(`${calls}.preflight`, 'utf8'),
      formalEnvironment: fs.existsSync(`${calls}.formal`) ? fs.readFileSync(`${calls}.formal`, 'utf8') : null };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('formal preflight failure leaves local and connector untouched', () => {
  const { result, calls } = runFixture('preflight');
  assert.notEqual(result.status, 0);
  assert.deepEqual(calls, ['preflight']);
});

test('local failure never dispatches connector replacement', () => {
  const { result, calls } = runFixture('local');
  assert.notEqual(result.status, 0);
  assert.deepEqual(calls, ['preflight', 'local']);
  assert.match(result.stderr, /formal connector was left untouched/);
});

test('formal failure reports partial recovery without undoing local services', () => {
  const { result, calls } = runFixture('formal');
  assert.notEqual(result.status, 0);
  assert.deepEqual(calls, ['preflight', 'local', 'formal']);
  assert.match(result.stderr, /partial failure: local services recovered/);
  assert.doesNotMatch(result.stdout, /=== ready ===/);
});

test('successful wide start preserves order and optional dev output', () => {
  const { result, calls } = runFixture('');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, ['preflight', 'local', 'formal']);
  assert.match(result.stdout, /Dev origin is optional and not startup-blocking/);
});

test('legacy aliases identify the same formal job in preflight and restart', () => {
  const { result, preflightEnvironment, formalEnvironment } = runFixture('', {
    TUNNEL_NAME: 'fixture-tunnel', TUNNEL_LABEL: 'com.webremotedesktop.fixed-domain.fixture',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(preflightEnvironment, 'fixture-tunnel|com.webremotedesktop.fixed-domain.fixture');
  assert.equal(formalEnvironment, preflightEnvironment);
});
