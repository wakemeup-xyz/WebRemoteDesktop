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

test('safe quick tunnel script keeps supervising an existing tunnel pid instead of exiting immediately', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /safe quick tunnel already running/);
  assert.doesNotMatch(source, /safe quick tunnel already running[\s\S]*exit 0/);
  assert.match(source, /while true; do/);
  assert.match(source, /while kill -0 "\$PID" 2>\/dev\/null; do/);
  assert.match(source, /wait "\$PID" 2>\/dev\/null \|\| true/);
});

test('safe quick tunnel script exposes poll intervals for supervision without hard-coded long waits', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /URL_POLL_ATTEMPTS="\$\{URL_POLL_ATTEMPTS:-45\}"/);
  assert.match(source, /URL_POLL_INTERVAL_SECONDS="\$\{URL_POLL_INTERVAL_SECONDS:-1\}"/);
  assert.match(source, /WATCH_INTERVAL_SECONDS="\$\{WATCH_INTERVAL_SECONDS:-15\}"/);
  assert.match(source, /RESTART_DELAY_SECONDS="\$\{RESTART_DELAY_SECONDS:-2\}"/);
});

test('safe quick tunnel script restores the safe URL file from an existing live tunnel before failing', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /\[ -s "\$URL_FILE" \]/);
  assert.match(source, /cat "\$URL_FILE"/);
  assert.match(source, /grep -Eo 'https:\/\/\[\^\[:space:\]\]\+\\\.trycloudflare\\\.com'/);
  assert.doesNotMatch(source, /failed to obtain quick tunnel url[\s\S]*exit 1[\s\S]*without checking URL_FILE/);
});

test('safe quick tunnel script persists the current URL to a durable archive file', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /URL_ARCHIVE_FILE="\$\{URL_ARCHIVE_FILE:-\/tmp\/wrd-safe-current-url\.last\.txt\}"/);
  assert.match(source, /printf '%s\\n' "\$URL" > "\$URL_ARCHIVE_FILE"/);
  assert.match(source, /cat "\$URL_ARCHIVE_FILE"/);
});

test('safe quick tunnel script verifies the URL is reachable before publishing it', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /source "\$PROJECT_DIR\/scripts\/lib-safe-wrd\.sh"/);
  assert.match(source, /wrd_safe_url_is_reachable/);
  assert.match(source, /URL_READY_TIMEOUT_SECONDS/);
  assert.ok(
    source.indexOf('wrd_safe_url_is_reachable') < source.indexOf('printf \'%s\\n\' "$URL" > "$URL_FILE"'),
    'URL reachability should be checked before the URL is written to disk',
  );
});

test('safe quick tunnel script restarts when the published URL stays unreachable for too long', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /UNREACHABLE_URL_FAIL_LIMIT/);
  assert.match(source, /url unreachable too long, restarting/);
  assert.match(source, /rm -f "\$URL_FILE"/);
});
