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

test('safe status script warns that 5173 is not the WebRemoteDesktop entrypoint', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /5173/);
  assert.match(source, /不要.*5173|not.*5173|wrong.*entry/i);
});
