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
