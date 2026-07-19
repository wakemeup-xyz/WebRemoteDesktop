const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
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
  assert.match(source, /terminal-runtime-probe\.js/);
  assert.match(source, /safe_url_before/);
  assert.match(source, /safe_url_after/);
  assert.doesNotMatch(source, /stop-safe-wrd|restart-safe-tunnel|run-safe-quicktunnel|launchctl remove|cloudflared.*restart/);
});

test('Terminal runtime checker never prints supplied secrets or URL values', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.doesNotMatch(source, /echo "\$METRICS_TOKEN"/);
  assert.doesNotMatch(source, /echo "\$safe_url"/);
  assert.match(source, /value withheld/);
});

test('Terminal runtime checker accepts bounded output metrics without treating names as raw IO', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-terminal-runtime-check-'));
  const curlPath = path.join(tempDir, 'curl');
  const urlFile = path.join(tempDir, 'safe-url.txt');
  fs.writeFileSync(urlFile, 'https://example.invalid\n');
  fs.writeFileSync(curlPath, `#!/bin/sh
url=""
for arg in "$@"; do url="$arg"; done
case "$url" in
  */health) printf '%s' '{"status":"ok"}' ;;
  */api/status) printf '%s' '{"status":"ok","hostOnline":true}' ;;
  */api/admin/terminal/metrics) printf '%s' '{"metrics":{"counters":{"output_bytes":12,"output_chunks":1,"output_backpressure":0},"latencies":{},"transports":{"websocket":{"latencies":{"socket_rtt_ms":{"sampleCount":1,"p50":5,"p95":5,"last":5}}}}},"pool":{"capacity":{"sessionCount":0}}}' ;;
  *) exit 22 ;;
esac
`);
  fs.chmodSync(curlPath, 0o755);

  try {
    const output = execFileSync('bash', [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${tempDir}${path.delimiter}${process.env.PATH}`,
        WRD_SAFE_URL_FILE: urlFile,
        WRD_TERMINAL_METRICS_TOKEN: 'test-token-value',
      },
    });
    assert.match(output, /terminal-runtime-check: ok/);
    assert.doesNotMatch(output, /test-token-value|example\.invalid/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
