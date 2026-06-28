const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, 'status-safe-wrd.sh');

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

test('safe status script resolves stale pid files against live repo processes before reporting stale', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /source "\$PROJECT_DIR\/scripts\/lib-safe-wrd\.sh"/);
  assert.match(source, /wrd_safe_reconcile_pid_file/);
  assert.match(source, /safe signal-server'.*signal/s);
  assert.match(source, /safe host'.*host/s);
  assert.match(source, /safe tunnel supervisor'.*tunnel-supervisor/s);
  assert.match(source, /safe quick tunnel'.*quick-tunnel/s);
});

test('safe status script reconciles tunnel supervisor even when the pid file is missing', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.doesNotMatch(source, /if \[ ! -f "\$pid_file" \]; then[\s\S]*pid file missing[\s\S]*return 0/);
  assert.match(source, /recorded_pid=\$\(wrd_safe_read_pid_file "\$pid_file"\)/);
  assert.match(source, /recorded_pid=\$\(wrd_safe_reconcile_pid_file "\$pid_file" "\$kind" "\$PROJECT_DIR" \|\| true\)/);
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

test('safe status script attempts to recover a missing safe URL file from the quick tunnel log', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /wrd-safe-quicktunnel\.log/);
  assert.match(source, /grep -Eo 'https:\/\/\[\^\[:space:\]\]\+\\\.trycloudflare\\\.com'/);
  assert.match(source, /printf '%s\\n' "\$recovered_url" > "\$SAFE_URL_FILE"/);
});

test('safe status script prefers recovering the safe URL from a durable archive before logs', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /SAFE_URL_ARCHIVE_FILE="\/tmp\/wrd-safe-current-url\.last\.txt"/);
  assert.match(source, /\[ -f "\$SAFE_URL_ARCHIVE_FILE" \]/);
  assert.match(source, /cat "\$SAFE_URL_ARCHIVE_FILE"/);
});

test('safe status script only restores a recovered URL when it is reachable', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /wrd_safe_url_is_reachable "\$recovered_url"/);
});

test('safe status script reports when the current safe URL is not reachable from this machine', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /wrd_safe_url_is_reachable/);
  assert.match(source, /safe url reachability: ok/);
  assert.match(source, /safe url reachability: unreachable/);
});

test('safe status script distinguishes dns failure from origin failure in reachability output', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /wrd_safe_url_reachability_state/);
  assert.match(source, /safe url reachability: dns-unresolved/);
  assert.match(source, /safe url reachability: origin-unreachable/);
});
