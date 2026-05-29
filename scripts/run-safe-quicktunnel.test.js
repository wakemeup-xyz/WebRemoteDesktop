const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, 'run-safe-quicktunnel.sh');

test('safe quick tunnel script uses isolated files and avoids global pkill', () => {
  assert.equal(fs.existsSync(scriptPath), true, 'script should exist');
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /wrd-safe-quicktunnel\.log/);
  assert.match(source, /wrd-safe-current-url\.txt/);
  assert.match(source, /wrd-safe-quicktunnel\.pid/);
  assert.doesNotMatch(source, /pkill\b/);
  assert.match(source, /127\.0\.0\.1:8080\/health/);
});
