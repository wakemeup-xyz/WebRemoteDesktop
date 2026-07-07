const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const scriptPath = path.join(__dirname, 'start-fixed-domain.sh');

test('start-fixed-domain keeps 8080 health as the only startup-blocking gate', () => {
  assert.equal(fs.existsSync(scriptPath), true, 'script should exist');
  const syntaxCheck = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
  assert.equal(syntaxCheck.status, 0, `bash -n failed: ${syntaxCheck.stderr}`);
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /LOCAL_PORT="\$\{LOCAL_PORT:-8080\}"/);
  assert.match(source, /HEALTH_URL="\$\{HEALTH_URL:-\$\{LOCAL_ORIGIN\}\/health\}"/);
  assert.match(source, /curl -s "\$HEALTH_URL" >/);
  assert.doesNotMatch(source, /5173\/health/i);
  assert.doesNotMatch(source, /curl[^\n]*\$DEV_LOCAL_ORIGIN/);
});

test('start-fixed-domain prints optional dev-domain guidance without making it mandatory', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /DEV_DOMAIN="\$\{DEV_DOMAIN:-dev\.link\.stockhub\.wiki\}"/);
  assert.match(source, /DEV_LOCAL_ORIGIN="\$\{DEV_LOCAL_ORIGIN:-http:\/\/127\.0\.0\.1:5173\}"/);
  assert.match(source, /ENABLE_DEV_SUBDOMAIN="\$\{ENABLE_DEV_SUBDOMAIN:-0\}"/);
  assert.match(source, /if \[ "\$ENABLE_DEV_SUBDOMAIN" = "1" \]; then/);
  assert.match(source, /echo "Dev domain: https:\/\/\$DEV_DOMAIN"/);
  assert.match(source, /echo "Dev origin: \$DEV_LOCAL_ORIGIN"/);
  assert.match(source, /echo "Dev origin is optional and not startup-blocking"/);
});
