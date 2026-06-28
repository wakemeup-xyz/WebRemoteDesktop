const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, 'restart-host.sh');

test('restart-host uses launchctl-backed host lifecycle instead of direct nohup host startup', () => {
  assert.equal(fs.existsSync(scriptPath), true, 'script should exist');
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /lib-host-launchctl\.sh/);
  assert.match(source, /wrd_host_launchctl_restart/);
  assert.doesNotMatch(source, /nohup .*host\.py/);
});

test('restart-host waits for signal-server hostOnline and refreshes the safe host pid file', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /SAFE_PID_FILE="\/tmp\/wrd-safe-host\.pid"/);
  assert.match(source, /127\.0\.0\.1:8080\/api\/status/);
  assert.match(source, /"hostOnline":true/);
  assert.match(source, /wrd_safe_write_pid_file "\$SAFE_PID_FILE" "\$NEW_PID"/);
});
