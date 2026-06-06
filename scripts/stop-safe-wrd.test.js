const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, 'stop-safe-wrd.sh');

test('safe stop script only targets repo-owned pid files', () => {
  assert.equal(fs.existsSync(scriptPath), true, 'script should exist');
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /wrd-safe-signal\.pid/);
  assert.match(source, /wrd-safe-host\.pid/);
  assert.match(source, /wrd-safe-tunnel-supervisor\.pid/);
  assert.match(source, /wrd-safe-quicktunnel\.pid/);
  assert.match(source, /wrd-safe-current-url\.txt/);
  assert.doesNotMatch(source, /pkill\b/);
  assert.match(source, /lib-safe-wrd\.sh/);
  assert.match(source, /wrd_safe_pid_is_running/);
});
