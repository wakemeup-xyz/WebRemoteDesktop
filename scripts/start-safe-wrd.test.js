const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, 'start-safe-wrd.sh');

test('safe startup script stays repo-scoped and avoids global cleanup', () => {
  assert.equal(fs.existsSync(scriptPath), true, 'script should exist');
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /signal-server\/server\.js/);
  assert.match(source, /python-host\/host\.py/);
  assert.match(source, /run-safe-quicktunnel\.sh/);
  assert.match(source, /wrd-safe-current-url\.txt/);
  assert.doesNotMatch(source, /pkill\b/);
  assert.match(source, /127\.0\.0\.1:8080\/health/);
});
