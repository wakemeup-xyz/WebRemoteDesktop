const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const keeperPath = path.join(root, 'scripts/run-awake-keeper.sh');
const checkPath = path.join(root, 'scripts/check-host-lock-policy.sh');

function caffeinateInvocation(source) {
  const match = source.match(/^\s*exec\s+(\/usr\/bin\/caffeinate\s+[^\n#]+)/m);
  return match ? match[1].trim() : null;
}

test('run-awake-keeper uses caffeinate -ims without display-sleep lock (-d)', () => {
  const source = fs.readFileSync(keeperPath, 'utf8');
  const inv = caffeinateInvocation(source);
  assert.ok(inv, 'exec caffeinate line required');
  assert.match(inv, /caffeinate\s+-ims\b/);
  // Reject -d as its own flag or inside a short-option cluster (e.g. -dims).
  assert.doesNotMatch(inv, /caffeinate\s+-[a-zA-Z]*d/);
});

test('check-host-lock-policy.sh exists and documents exit codes 0/1/2', () => {
  const source = fs.readFileSync(checkPath, 'utf8');
  assert.match(source, /EXIT_OK=0|exit 0|exit_code=0|hard_fail/);
  assert.match(source, /EXIT_HARD=1|exit 1|hard_fail/);
  assert.match(source, /EXIT_WARN=2|exit 2|warn/);
  assert.match(source, /com\.webremotedesktop\.awake/);
  assert.match(source, /manual_verify|需要密码/);
});
