const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, 'start-safe-wrd.sh');

test('safe startup script stays repo-scoped and avoids global cleanup', () => {
  assert.equal(fs.existsSync(scriptPath), true, 'script should exist');
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /cd \"\$PROJECT_DIR\/signal-server\"/);
  assert.match(source, /nohup \"\$NODE_BIN\" server\.js/);
  assert.match(source, /wrd-safe-current-url\.txt/);
  assert.doesNotMatch(source, /pkill\b/);
  assert.match(source, /127\.0\.0\.1:8080\/health/);
});

test('safe startup script uses shared pid resolution helpers instead of fragile absolute-path pgrep checks', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /source "\$PROJECT_DIR\/scripts\/lib-safe-wrd\.sh"/);
  assert.match(source, /wrd_safe_reconcile_pid_file/);
  assert.match(source, /lib-host-launchctl\.sh/);
  assert.match(source, /wrd_host_launchctl_start/);
  assert.doesNotMatch(source, /pgrep -f "\$PROJECT_DIR\/signal-server\/server\.js"/);
  assert.doesNotMatch(source, /pgrep -f "\$PROJECT_DIR\/python-host\/host\.py"/);
  assert.doesNotMatch(source, /nohup \"\$PYTHON_BIN\" host\.py/);
});


test('safe startup script prints explicit 8080 entrypoint guidance', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /8080/);
  assert.match(source, /5173/);
  assert.match(source, /do not open 5173|不要打开.*5173/i);
  assert.match(source, /safe url:/);
});

test('safe startup script validates the current safe URL without restarting an inaccessible tunnel', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /wrd_safe_url_is_reachable/);
  assert.match(source, /lib-safe-startup\.sh/);
  assert.match(source, /wrd_safe_startup_tunnel/);
  assert.match(source, /wrd_tunnel_launchctl_migrate_legacy_autostart/);
  assert.doesNotMatch(source, /restart-safe-tunnel\.sh/);
  assert.doesNotMatch(source, /wrd_tunnel_launchctl_start/);
  assert.match(source, /not restarting.*automatically/i);
});

test('safe startup script reports a missing tunnel without starting a replacement', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /lib-safe-startup\.sh/);
  assert.match(source, /wrd_safe_startup_tunnel/);
  assert.doesNotMatch(source, /wrd_tunnel_launchctl_start/);
});

test('safe startup script prints formal entry first and marks quick tunnel as debug-only', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /formal public entry: https:\/\/link\.stockhub\.wiki/i);
  assert.match(source, /debug quick tunnel url:/i);
  assert.match(source, /quick tunnel.*debug-only|debug-only.*quick tunnel/i);
});
