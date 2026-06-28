const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, 'lib-safe-wrd.sh');

test('safe reachability helper can fall back when local DNS cannot resolve trycloudflare', () => {
  assert.equal(fs.existsSync(scriptPath), true, 'script should exist');
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /wrd_safe_url_is_reachable\(\)/);
  assert.match(source, /wrd_safe_trycloudflare_reachable/);
  assert.match(source, /nslookup .*8\.8\.8\.8|dig .*8\.8\.8\.8|python3 .*socket/s);
  assert.match(source, /curl --resolve/);
});

test('safe reachability helper distinguishes origin reachability from local resolver failure', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /wrd_safe_trycloudflare_ips|resolve_trycloudflare|fallback_dns/i);
  assert.match(source, /return 0/);
  assert.match(source, /return 1/);
});

test('safe reachability helper exposes a tri-state reachability result', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /wrd_safe_url_reachability_state/);
  assert.match(source, /dns-unresolved/);
  assert.match(source, /origin-unreachable/);
  assert.match(source, /reachable/);
});

test('safe reachability helper avoids requiring rg in launchctl PATH', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.doesNotMatch(source, /\brg\b/);
  assert.match(source, /grep -E/);
});
