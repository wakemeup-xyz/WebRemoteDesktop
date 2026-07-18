const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, 'lib-safe-wrd.sh');
const healthScriptPath = path.join(__dirname, 'wrd_entry_health.py');

test('safe reachability helper can fall back when local DNS cannot resolve trycloudflare', () => {
  assert.equal(fs.existsSync(scriptPath), true, 'script should exist');
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /wrd_safe_url_is_reachable\(\)/);
  assert.match(source, /wrd_entry_health\.py/);
});

test('safe reachability helper distinguishes origin reachability from local resolver failure', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /wrd_safe_url_reachability_state/);
  assert.doesNotMatch(source, /curl -I -L/);
});

test('safe reachability helper exposes canonical delivery states', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  const healthSource = fs.readFileSync(healthScriptPath, 'utf8');

  assert.match(source, /wrd_safe_url_reachability_state/);
  assert.match(source, /deliverable/);
  assert.match(healthSource, /dns-unresolved/);
  assert.match(healthSource, /origin-unreachable/);
  assert.match(healthSource, /http-invalid/);
  assert.match(healthSource, /content-invalid/);
});

test('safe reachability helper avoids requiring rg in launchctl PATH', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.doesNotMatch(source, /\brg\b/);
});
