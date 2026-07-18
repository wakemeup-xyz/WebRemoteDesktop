const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const scriptPath = path.join(__dirname, 'status-safe-wrd.sh');
const helperPath = path.join(__dirname, 'lib-safe-wrd.sh');

test('safe status script inspects safe pid files and local api status without global cleanup', () => {
  assert.equal(fs.existsSync(scriptPath), true, 'script should exist');
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /wrd-safe-signal\.pid/);
  assert.match(source, /wrd-safe-host\.pid/);
  assert.match(source, /wrd-safe-tunnel-supervisor\.pid/);
  assert.match(source, /wrd-safe-quicktunnel\.pid/);
  assert.match(source, /wrd-safe-current-url\.txt/);
  assert.match(source, /127\.0\.0\.1:8080\/health/);
  assert.match(source, /127\.0\.0\.1:8080\/api\/status/);
  assert.doesNotMatch(source, /pkill\b/);
});

test('safe status script inspects stale pid files against live repo processes without reconciling files', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /source "\$PROJECT_DIR\/scripts\/lib-safe-wrd\.sh"/);
  assert.doesNotMatch(source, /wrd_safe_reconcile_pid_file/);
  assert.match(source, /wrd_safe_find_pid_by_kind/);
  assert.match(source, /safe signal-server'.*signal/s);
  assert.match(source, /safe host'.*host/s);
  assert.match(source, /safe tunnel supervisor'.*tunnel-supervisor/s);
  assert.match(source, /safe quick tunnel'.*quick-tunnel/s);
});

test('safe status script discovers a live tunnel supervisor without writing a missing pid file', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /recorded_pid=\$\(wrd_safe_read_pid_file "\$pid_file"\)/);
  assert.match(source, /live_pid=\$\(wrd_safe_find_pid_by_kind "\$kind" "\$PROJECT_DIR"/);
  assert.doesNotMatch(source, /wrd_safe_write_pid_file/);
});

test('safe status script warns that 5173 is not the WebRemoteDesktop entrypoint', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /5173/);
  assert.match(source, /不要.*5173|not.*5173|wrong.*entry/i);
});

test('safe status script surfaces hostOnline from api status for launchctl-managed host checks', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /api status:/);
  assert.match(source, /hostOnline/);
  assert.match(source, /127\.0\.0\.1:8080\/api\/status/);
});

test('safe status script reminds operators to treat the safe URL file as the source of truth after tunnel changes', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /wrd-safe-current-url\.txt/);
  assert.match(source, /source of truth|事实来源|current effective url/i);
  assert.match(source, /trycloudflare|tunnel/i);
});

test('safe status script never recovers or writes a missing safe URL file', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.doesNotMatch(source, /recover_safe_url_file/);
  assert.doesNotMatch(source, />\s*"\$SAFE_URL_FILE"/);
  assert.match(source, /safe url file: missing/);
});

test('safe status script reports when the current safe URL is not reachable from this machine', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /wrd_safe_url_reachability_state/);
  assert.match(source, /safe url reachability: ok/);
  assert.match(source, /safe url reachability: unreachable/);
});

test('safe status script distinguishes dns failure from origin failure in reachability output', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /wrd_safe_url_reachability_state/);
  assert.match(source, /safe url reachability: dns-unresolved/);
  assert.match(source, /safe url reachability: origin-unreachable/);
});

test('safe status script labels fixed domain as formal public entry and quick tunnel as debug-only', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /formal public entry: https:\/\/link\.stockhub\.wiki/i);
  assert.match(source, /quick tunnel: debug-only|debug quick tunnel/i);
});

test('safe status emits a read-only warning for cloudflared token argv without printing the token', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.match(source, /wrd_safe_cloudflared_token_in_argv/);
  assert.match(source, /security warning: cloudflared token found in process arguments/);
  assert.doesNotMatch(source, /kill[^\n]*cloudflared|launchctl\s+remove/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-token-argv-'));
  const argsPath = path.join(dir, 'args.txt');
  fs.writeFileSync(argsPath, '/usr/bin/cloudflared tunnel run --token SUPER-SECRET-TOKEN\n');
  const output = execFileSync('bash', [
    '-c',
    'source "$1"; if wrd_safe_cloudflared_token_in_argv "$2"; then echo "security warning: cloudflared token found in process arguments"; fi',
    'bash',
    helperPath,
    argsPath,
  ], { encoding: 'utf8' });

  assert.match(output, /security warning: cloudflared token found in process arguments/);
  assert.doesNotMatch(output, /SUPER-SECRET-TOKEN/);
});
