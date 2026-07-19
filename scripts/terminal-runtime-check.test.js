const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, 'terminal-runtime-check.sh');

test('Terminal runtime checker is read-only and validates health, Python, secrets, and metrics', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.match(source, /BASE_URL=.*127\.0\.0\.1:8080/);
  assert.match(source, /\$BASE_URL\/health/);
  assert.match(source, /api\/status/);
  assert.match(source, /command -v python3|python@3\\\.11\/libexec\/bin/);
  assert.match(source, /\/usr\/bin\/env python3|python@3\\\.11\/libexec\/bin/);
  assert.match(source, /api\/admin\/terminal\/metrics/);
  assert.match(source, /processStatus|pty_exited|exited|environment/);
  assert.match(source, /wrd-safe-current-url\.txt/);
  assert.doesNotMatch(source, /stop-safe-wrd|restart-safe-tunnel|run-safe-quicktunnel|launchctl remove|cloudflared.*restart/);
});

test('Terminal runtime checker never prints supplied secrets or URL values', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.doesNotMatch(source, /echo "\$METRICS_TOKEN"/);
  assert.doesNotMatch(source, /echo "\$safe_url"/);
  assert.match(source, /value withheld/);
});
