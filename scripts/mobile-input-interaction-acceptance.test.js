const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const SCRIPT = path.join(__dirname, 'mobile_input_interaction_acceptance.py');

function runCli(...args) {
  const options = typeof args.at(-1) === 'object' ? args.pop() : {};
  return spawnSync('python3', [SCRIPT, ...args], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...(options.env || {}) },
  });
}

test('offline acceptance CLI exposes only the local-source contract', () => {
  const result = runCli('--help');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--out/);
  assert.match(result.stdout, /--browser/);
  assert.doesNotMatch(result.stdout, /base-url|password|dotenv|VIEWER_ACCESS_PASSWORD/i);
});

test('offline acceptance CLI writes safe scenario summaries without secrets or payloads', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-mobile-interaction-'));
  const output = path.join(outDir, 'result.json');
  const result = runCli('--browser', 'chromium', '--out', output);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const artifact = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(artifact.scope, 'offline-synthetic');
  assert.equal(artifact.browser, 'chromium');
  assert.ok(Array.isArray(artifact.scenarios));
  assert.ok(artifact.scenarios.length >= 10);
  for (const scenario of artifact.scenarios) {
    assert.match(scenario.status, /^(PASS|FAIL|NOT RUN)$/);
    assert.equal(typeof scenario.name, 'string');
    const serialized = JSON.stringify(scenario);
    assert.doesNotMatch(serialized, /VIEWER_ACCESS_PASSWORD|WRD_TERMINAL_ADMIN_PASSWORD|password|token|secret/i);
    assert.doesNotMatch(serialized, /hello|world|abc|clipboard|clientX|clientY/i);
    assert.doesNotMatch(serialized, /\bKey[A-Z]\b/);
  }
});

test('missing browser runtime exits 2 and records NOT RUN scenarios', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-mobile-interaction-no-browser-'));
  const output = path.join(outDir, 'missing.json');
  const browserCache = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-mobile-interaction-empty-browsers-'));
  const result = runCli('--browser', 'webkit', '--out', output, {
    env: { PLAYWRIGHT_BROWSERS_PATH: browserCache },
  });
  assert.equal(result.status, 2, result.stderr || result.stdout);
  const artifact = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(artifact.scope, 'offline-synthetic');
  assert.equal(artifact.browser, 'webkit');
  assert.ok(artifact.scenarios.length > 0);
  assert.ok(artifact.scenarios.every((scenario) => scenario.status === 'NOT RUN'));
});

test('post-launch fixture failures exit 1 without being misclassified as NOT RUN', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-mobile-interaction-fail-'));
  const output = path.join(outDir, 'failure.json');
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-mobile-interaction-fake-playwright-'));
  const fakePackage = path.join(fakeRoot, 'playwright');
  fs.mkdirSync(fakePackage, { recursive: true });
  fs.writeFileSync(path.join(fakePackage, '__init__.py'), '');
  fs.writeFileSync(path.join(fakePackage, 'sync_api.py'), `
class _Browser:
    def new_page(self, **kwargs):
        raise RuntimeError('fixture launch failure')
    def close(self):
        raise RuntimeError('cleanup failure')

class _BrowserType:
    def launch(self, **kwargs):
        return _Browser()

class _Playwright:
    chromium = _BrowserType()
    webkit = _BrowserType()

class _Context:
    def start(self):
        return _Playwright()
    def stop(self):
        return None

def sync_playwright():
    return _Context()
`);
  try {
    const result = runCli('--browser', 'chromium', '--out', output, {
      env: { PYTHONPATH: fakeRoot },
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const artifact = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.ok(artifact.scenarios.length >= 10);
    assert.ok(artifact.scenarios.every((scenario) => scenario.status === 'FAIL'));
    assert.ok(artifact.scenarios.every((scenario) => scenario.reason === 'browser-action-failed'));
    assert.ok(artifact.scenarios.some((scenario) => scenario.name === 'runtime-cleanup'));
    const serialized = JSON.stringify(artifact);
    assert.doesNotMatch(serialized, /NOT RUN|Traceback|fixture launch failure|RuntimeError/i);
  } finally {
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  }
});
