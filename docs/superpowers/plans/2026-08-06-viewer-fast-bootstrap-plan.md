# Viewer Fast Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task with review checkpoints. Do not delegate unless the user later explicitly authorizes subagents.

**Goal:** Make the formal Viewer entry interactive within a bounded few seconds, eliminate inert controls and duplicated unbounded bootstrap work, and produce truthful local/public startup evidence.

**Architecture:** Build the existing classic Viewer sources into one content-hashed desktop bundle and one lazy Terminal bundle, then serve them through a manifest-owned cache policy. A single `ViewerBootstrap` module consumes one authenticated backend snapshot with deadlines and mode-specific degradation before handing a resolved snapshot to existing WebRTC logic. A tiny inline ShellGuard covers the pre-core interval; formal tunnel changes remain a separately authorized operational phase.

**Tech Stack:** Node.js 24, Express 4, Socket.IO 4, Vanilla JavaScript, esbuild, xterm 6, Python 3.11, Playwright, Bash, Cloudflare named tunnel.

**Spec Coverage:** This plan covers the full design in `docs/superpowers/specs/2026-08-06-viewer-fast-bootstrap-design.md`, including build, delivery, frontend/backend bootstrap, lazy Terminal, observability, formal-tunnel preflight, documentation, and runtime acceptance.

**Truth Source:** `signal-server/scripts/web-asset-graph.js` owns build membership/order; generated `asset-manifest.json` owns emitted filenames; `signal-server/lib/web-assets.js` owns static cache policy; `web-client/js/bootstrap-controller.js` owns Viewer bootstrap state; existing connection-attempt IDs remain authoritative for signaling/media/input readiness.

**Compatibility Notes:** `/api/webrtc-config` remains a compatibility endpoint backed by the same snapshot builder. Classic source files remain testable, but production Viewer HTML references only generated assets. No automatic network-mode switch, tunnel restart, token migration, or quick-tunnel mutation is allowed.

**Impact Map:**
- **Truth Source:** Asset graph, manifest, cache classifier, Viewer bootstrap state, existing connection-attempt state, fixed-tunnel preflight result.
- **Backend:** Add build/delivery modules and authenticated `/api/viewer-bootstrap`; retain existing Socket.IO and WebRTC signaling contracts.
- **Frontend:** Add ShellGuard, bounded bootstrap coordinator, lazy Terminal loader, startup telemetry, and resolved-snapshot WebRTC initialization.
- **Runtime Proof:** Deterministic build tests, header tests, frontend state tests, local/public 20-run Playwright acceptance, immutable JSON evidence with SHA-256.
- **Docs/Skills:** Update README, safe-startup runbook, active requirement document, and reference this spec/plan; do not edit generated `.agents/skills/` cache.
- **Commit Boundary:** Application source, focused tests, build metadata/lockfile, active docs, spec, and plan. Existing `.playwright-mcp/` and rotated logs remain untouched.

**Definition of Done:**
- Formal-entry cold core-interactive P95 is at most 5 seconds, click-to-signal P95 at most 3 seconds, and click-to-stable-non-black-frame P95 at most 8 seconds over at least 20 fresh contexts.
- No visible control is inert: pre-core Start clicks are acknowledged, core-required controls are truthfully disabled, and every startup wait exits to success, degradation, or retryable failure within its budget.
- Critical Viewer HTML loads no runtime CDN assets and references no more than one critical JS and one critical CSS asset; Terminal/xterm load only on demand.
- HTML revalidates while manifest-listed hashed assets are immutable; authenticated bootstrap/config responses are never publicly cached.
- Warmup and Start share one bootstrap request, mode-specific fallback preserves auth/TURN policy, and duplicate clicks create one current attempt.
- Formal-tunnel ownership/transport risks are detectable read-only; no tunnel process is changed without explicit user authorization.
- Focused and full regression suites pass, active docs match behavior, and runtime evidence is archived immutably.

---

## File Map

| File | Responsibility |
|---|---|
| `.gitignore` | Keep generated `dist/` ignored while explicitly tracking `signal-server/package-lock.json` |
| `signal-server/package.json` | Build dependencies and explicit `build:web` command |
| `signal-server/package-lock.json` | Exact build/runtime dependency resolution |
| `signal-server/scripts/web-asset-graph.js` | Canonical desktop/Terminal source ordering |
| `signal-server/scripts/build-web-client.js` | Deterministic hashed build and atomic manifest publication |
| `signal-server/test/web-asset-build.test.js` | Build graph, determinism, CDN removal, split, and failure tests |
| `signal-server/lib/web-assets.js` | Manifest validation, safe path resolution, cache policy, static middleware |
| `signal-server/test/web-assets.test.js` | Delivery/cache/traversal tests |
| `signal-server/lib/viewer-bootstrap.js` | Canonical backend Viewer/WebRTC snapshot builder |
| `signal-server/test/viewer-bootstrap.test.js` | Snapshot and authenticated endpoint tests |
| `signal-server/server.js` | Mount generated static delivery and `/api/viewer-bootstrap` |
| `web-client/viewer.html` | Build markers, ShellGuard source hook, truthful initial control state |
| `web-client/js/shell-guard.js` | Dependency-free pre-core click acknowledgement and timeout |
| `web-client/js/shell-guard.test.js` | Pre-core/takeover/timeout tests |
| `web-client/js/bootstrap-controller.js` | Single-flight bounded Viewer bootstrap state machine |
| `web-client/js/bootstrap-controller.test.js` | Timeout, fallback, auth, stale generation, retry tests |
| `web-client/js/webrtc.js` | Consume resolved bootstrap snapshot; remove init-time duplicate fetch; first-frame budget |
| `web-client/js/webrtc.test.js` | One-attempt, resolved config, timeout, and stale-attempt tests |
| `web-client/js/terminal-loader.js` | Optional Terminal asset loading and isolated retry state |
| `web-client/js/terminal-loader.test.js` | Lazy-load and Desktop-isolation tests |
| `web-client/js/terminal.js` | Idempotent explicit initialization after lazy load |
| `web-client/js/terminal.test.js` | Explicit/idempotent initialization coverage |
| `web-client/js/startup-telemetry.js` | Bounded monotonic startup marks and resource summaries |
| `web-client/js/startup-telemetry.test.js` | Timing/redaction/bounds tests |
| `web-client/js/diagnostic.js` | Include startup snapshot in existing diagnostic contract |
| `web-client/js/diagnostic.test.js` | Diagnostic startup evidence tests |
| `scripts/viewer_bootstrap_acceptance.py` | Local/public cold/warm/media/fault-injection runtime acceptance |
| `scripts/test_viewer_bootstrap_acceptance.py` | Percentile, report, and redaction unit tests |
| `scripts/fixed-tunnel-preflight.sh` | Read-only formal connector ownership/transport/health check |
| `scripts/fixed-tunnel-preflight.test.js` | Non-mutation, secret-redaction, and classification tests |
| `scripts/start-fixed-domain.sh` | Repository-managed named-tunnel protocol default only |
| `scripts/start-fixed-domain.test.js` | HTTP/2 default and override tests |
| `README.md` | Build/start/cache and performance behavior |
| `docs/runbook-safe-startup.md` | Preflight, explicit tunnel authorization, acceptance commands |
| `docs/需求文档/WebRemoteDesktop-需求文档.md` | Product-visible bounded startup requirements |

---

### Task 1: Lock Dependencies and Define the Canonical Asset Graph

**Files:**
- Modify: `.gitignore`
- Modify: `signal-server/package.json`
- Create and track: `signal-server/package-lock.json`
- Create: `signal-server/scripts/web-asset-graph.js`
- Create: `signal-server/test/web-asset-build.test.js`
- Modify: `web-client/viewer.html`

- [ ] **Step 1: Write the failing asset-graph test**

```javascript
// signal-server/test/web-asset-build.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

test('asset graph keeps desktop critical and Terminal optional sources separate', () => {
  const graph = require('../scripts/web-asset-graph');
  assert.ok(graph.desktopScripts.includes('js/webrtc.js'));
  assert.ok(!graph.desktopScripts.includes('js/terminal.js'));
  assert.deepEqual(graph.terminalScripts, [
    'js/terminal-echo-controller.js',
    'js/terminal-composer.js',
    'js/terminal.js',
  ]);
  assert.equal(new Set(graph.desktopScripts).size, graph.desktopScripts.length);
  assert.equal(new Set(graph.terminalScripts).size, graph.terminalScripts.length);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cd signal-server
node --test test/web-asset-build.test.js
```

Expected: FAIL with `Cannot find module '../scripts/web-asset-graph'`.

- [ ] **Step 3: Install and lock build dependencies**

Run:

```bash
cd signal-server
npm install --save-exact esbuild@0.25.8 @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0
```

Then change `.gitignore` narrowly:

```gitignore
package-lock.json
!signal-server/package-lock.json
```

Expected: `signal-server/package.json` contains exact versions and `signal-server/package-lock.json` is no longer ignored.

- [ ] **Step 4: Add the canonical graph**

```javascript
// signal-server/scripts/web-asset-graph.js
'use strict';

module.exports = Object.freeze({
  desktopScripts: Object.freeze([
    'js/runtime-config.js',
    'js/auth.js',
    'js/webrtc-stats.js',
    'js/link-quality-controller.js',
    'js/media-activity-controller.js',
    'js/media-activity-lifecycle.js',
    'js/media-activity-runtime.js',
    'js/startup-telemetry.js',
    'js/bootstrap-controller.js',
    'js/terminal-loader.js',
    'js/diagnostic-core.js',
    'js/webrtc.js',
    'js/input-geometry.js',
    'js/keyboard-transport.js',
    'js/remote-keyboard-controller.js',
    'js/input.js',
    'js/ui.js',
  ]),
  desktopDeferredScripts: Object.freeze([
    'js/stun-port-search-controller.js',
    'js/turn-selftest.js',
    'js/latency-monitor.js',
    'js/diagnostic.js',
  ]),
  terminalScripts: Object.freeze([
    'js/terminal-echo-controller.js',
    'js/terminal-composer.js',
    'js/terminal.js',
  ]),
});
```

Notes after closure review:
- Keep **diagnostic-core** (log capture + button shell) on the critical path so failure diagnosis remains possible and the diag button is never enabled-and-inert.
- Heavy diagnostic panel / latency / STUN-TURN tools load as `desktop-deferred` after core-interactive; before ready the diag button stays disabled; on load failure it becomes an explicit **诊断重试** control.
- Desktop signaling is **WebSocket-first + polling fallback** with connect timeout ≤5s (not websocket-only).
- Acceptance `clickToStableNonBlackMs` uses first canvas ratio > 0.05 from Start click (`stable-non-black`), not the `active` mark; 8s deadline starts at Start click.

- [ ] **Step 5: Add non-behavioral build markers to Viewer HTML**

Wrap the existing critical head tags and bottom script list without changing the source fallback:

```html
<!-- WRD_BUILD_HEAD_START -->
<link rel="stylesheet" href="css/viewer.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.css">
<script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.11.0/lib/addon-fit.js"></script>
<!-- WRD_BUILD_HEAD_END -->
```

```html
<!-- WRD_BUILD_SCRIPTS_START -->
<!-- keep the existing ordered source script tags here for source-mode tests -->
<!-- WRD_BUILD_SCRIPTS_END -->
```

- [ ] **Step 6: Run the graph test and existing layout test**

Run:

```bash
cd signal-server
node --test test/web-asset-build.test.js ../web-client/css/viewer-layout.test.js
```

Expected: PASS, with no change to source-mode Viewer behavior.

- [ ] **Step 7: Commit the dependency/graph slice**

```bash
git add .gitignore signal-server/package.json signal-server/package-lock.json \
  signal-server/scripts/web-asset-graph.js signal-server/test/web-asset-build.test.js \
  web-client/viewer.html
git commit -m "build(viewer): lock frontend asset graph"
```

---

### Task 2: Build Deterministic Hashed Desktop and Terminal Assets

**Files:**
- Create: `signal-server/scripts/build-web-client.js`
- Modify: `signal-server/package.json`
- Modify: `signal-server/test/web-asset-build.test.js`

- [ ] **Step 1: Add failing deterministic-build and critical-graph tests**

```javascript
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildWebClient } = require('../scripts/build-web-client');

test('build emits deterministic first-party critical assets and lazy Terminal assets', async () => {
  const outA = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-build-a-'));
  const outB = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-build-b-'));
  const sourceDir = path.join(__dirname, '..', '..', 'web-client');
  const a = await buildWebClient({ sourceDir, outDir: outA });
  const b = await buildWebClient({ sourceDir, outDir: outB });

  assert.deepEqual(a, b);
  const html = fs.readFileSync(path.join(outA, 'viewer.html'), 'utf8');
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net|cdn\.socket\.io/);
  assert.equal((html.match(/<script[^>]+src=/g) || []).length, 1);
  assert.equal((html.match(/<link[^>]+stylesheet/g) || []).length, 1);
  assert.match(html, new RegExp(a.assets.desktopJs.replaceAll('.', '\\.')));
  assert.doesNotMatch(
    html,
    new RegExp(`<script[^>]+src="[^"]*${a.assets.terminalJs.replaceAll('.', '\\.')}"`),
  );
  assert.doesNotMatch(
    html,
    new RegExp(`<link[^>]+href="[^"]*${a.assets.terminalCss.replaceAll('.', '\\.')}"`),
  );
  for (const relative of Object.values(a.assets)) {
    assert.equal(fs.existsSync(path.join(outA, relative)), true, relative);
  }
});

test('build does not publish a manifest when an input is missing', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-build-fail-'));
  await assert.rejects(
    buildWebClient({ sourceDir: '/missing/web-client', outDir }),
    /missing|ENOENT/i,
  );
  assert.equal(fs.existsSync(path.join(outDir, 'asset-manifest.json')), false);
});
```

- [ ] **Step 2: Run the build tests and verify RED**

Run:

```bash
cd signal-server
node --test test/web-asset-build.test.js
```

Expected: FAIL because `build-web-client.js` does not exist.

- [ ] **Step 3: Implement hashing, atomic output, and HTML generation**

```javascript
// signal-server/scripts/build-web-client.js
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const graph = require('./web-asset-graph');

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

function readJoined(sourceDir, files) {
  return files.map((file) => fs.readFileSync(path.join(sourceDir, file), 'utf8')).join('\n;\n');
}

async function compileClassic(source, sourcefile) {
  const result = await esbuild.transform(source, {
    loader: 'js',
    minify: true,
    target: 'es2020',
    legalComments: 'inline',
    sourcefile,
  });
  return result.code;
}

function writeHashed(assetDir, stem, extension, bytes) {
  const name = `${stem}.${digest(bytes)}.${extension}`;
  fs.writeFileSync(path.join(assetDir, name), bytes);
  return `assets/${name}`;
}

function replaceBlock(html, start, end, replacement) {
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!pattern.test(html)) throw new Error(`missing build markers: ${start}`);
  return html.replace(pattern, replacement);
}

async function buildWebClient({ sourceDir, outDir }) {
  const staging = `${outDir}.tmp-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.join(staging, 'assets'), { recursive: true });

  try {
    const socketRoot = path.dirname(require.resolve('socket.io/package.json'));
    const xtermEntry = require.resolve('@xterm/xterm');
    const xtermRoot = path.resolve(path.dirname(xtermEntry), '..');
    const fitEntry = require.resolve('@xterm/addon-fit');
    const fitRoot = path.resolve(path.dirname(fitEntry), '..');
    const socketClient = fs.readFileSync(path.join(socketRoot, 'client-dist/socket.io.min.js'), 'utf8');
    const xtermJs = fs.readFileSync(xtermEntry, 'utf8');
    const fitJs = fs.readFileSync(fitEntry, 'utf8');
    const xtermCss = fs.readFileSync(path.join(xtermRoot, 'css/xterm.css'), 'utf8');

    const desktopSource = `${socketClient}\n${readJoined(sourceDir, graph.desktopScripts)}`;
    const terminalSource = `${xtermJs}\n${fitJs}\n${readJoined(sourceDir, graph.terminalScripts)}`;
    const desktopJs = await compileClassic(desktopSource, 'desktop-core.js');
    const terminalJs = await compileClassic(terminalSource, 'terminal.js');
    const viewerCss = fs.readFileSync(path.join(sourceDir, 'css/viewer.css'), 'utf8');

    const assets = {
      desktopJs: writeHashed(path.join(staging, 'assets'), 'desktop-core', 'js', desktopJs),
      viewerCss: writeHashed(path.join(staging, 'assets'), 'viewer', 'css', viewerCss),
      terminalJs: writeHashed(path.join(staging, 'assets'), 'terminal', 'js', terminalJs),
      terminalCss: writeHashed(path.join(staging, 'assets'), 'terminal', 'css', xtermCss),
    };

    let viewerHtml = fs.readFileSync(path.join(sourceDir, 'viewer.html'), 'utf8');
    viewerHtml = replaceBlock(
      viewerHtml,
      '<!-- WRD_BUILD_HEAD_START -->',
      '<!-- WRD_BUILD_HEAD_END -->',
      `<link rel="stylesheet" href="/${assets.viewerCss}">`,
    );
    viewerHtml = replaceBlock(
      viewerHtml,
      '<!-- WRD_BUILD_SCRIPTS_START -->',
      '<!-- WRD_BUILD_SCRIPTS_END -->',
      `<script>window.__WRD_ASSETS__=${JSON.stringify({ terminalJs: `/${assets.terminalJs}`, terminalCss: `/${assets.terminalCss}` })}</script>\n<script src="/${assets.desktopJs}" defer></script>`,
    );
    fs.writeFileSync(path.join(staging, 'viewer.html'), viewerHtml);
    fs.copyFileSync(path.join(sourceDir, 'index.html'), path.join(staging, 'index.html'));
    fs.mkdirSync(path.join(staging, 'css'));
    fs.copyFileSync(path.join(sourceDir, 'css/login.css'), path.join(staging, 'css/login.css'));
    const licenses = [
      ['socket.io', path.join(socketRoot, 'LICENSE')],
      ['@xterm/xterm', path.join(xtermRoot, 'LICENSE')],
      ['@xterm/addon-fit', path.join(fitRoot, 'LICENSE')],
    ].map(([name, licensePath]) => `===== ${name} =====\n${fs.readFileSync(licensePath, 'utf8').trim()}\n`);
    fs.writeFileSync(path.join(staging, 'THIRD_PARTY_LICENSES.txt'), `${licenses.join('\n')}\n`);

    const manifest = { schemaVersion: 1, assets };
    fs.writeFileSync(path.join(staging, 'asset-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.renameSync(staging, outDir);
    return manifest;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

if (require.main === module) {
  const projectRoot = path.join(__dirname, '..', '..');
  buildWebClient({
    sourceDir: path.join(projectRoot, 'web-client'),
    outDir: path.join(projectRoot, 'web-client', 'dist'),
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildWebClient, digest, replaceBlock };
```

- [ ] **Step 4: Add build scripts**

```json
{
  "scripts": {
    "build:web": "node scripts/build-web-client.js",
    "pretest": "npm run build:web",
    "start": "node server.js",
    "test": "node --test",
    "audit:deps": "npm audit --audit-level=moderate"
  }
}
```

- [ ] **Step 5: Run build twice and verify GREEN/determinism**

Run:

```bash
cd signal-server
npm run build:web
cp ../web-client/dist/asset-manifest.json /tmp/wrd-manifest-a.json
npm run build:web
cmp /tmp/wrd-manifest-a.json ../web-client/dist/asset-manifest.json
node --test test/web-asset-build.test.js
```

Expected: `cmp` exits 0; tests PASS; generated HTML has zero external CDN references.

- [ ] **Step 6: Commit the builder slice**

```bash
git add signal-server/scripts/build-web-client.js signal-server/package.json \
  signal-server/test/web-asset-build.test.js
git commit -m "build(viewer): emit deterministic hashed assets"
```

---

### Task 3: Serve Generated Assets with One Cache-Policy Truth

**Files:**
- Create: `signal-server/lib/web-assets.js`
- Create: `signal-server/test/web-assets.test.js`

- [ ] **Step 1: Write failing manifest and cache-policy tests**

```javascript
// signal-server/test/web-assets.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  loadWebAssetManifest,
  cachePolicyForAsset,
  createWebAssetMiddleware,
} = require('../lib/web-assets');

function fixture() {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-assets-'));
  fs.mkdirSync(path.join(distDir, 'assets'));
  fs.writeFileSync(path.join(distDir, 'assets/app.0123456789abcdef.js'), 'ok');
  fs.writeFileSync(path.join(distDir, 'viewer.html'), '<!doctype html>');
  fs.writeFileSync(path.join(distDir, 'asset-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    assets: { desktopJs: 'assets/app.0123456789abcdef.js' },
  }));
  return distDir;
}

test('manifest-listed hashed assets are immutable while HTML revalidates', () => {
  const distDir = fixture();
  const manifest = loadWebAssetManifest({ distDir });
  assert.equal(
    cachePolicyForAsset('/assets/app.0123456789abcdef.js', manifest),
    'public, max-age=31536000, immutable',
  );
  assert.equal(
    cachePolicyForAsset('/viewer.html', manifest),
    'no-cache, max-age=0, must-revalidate',
  );
  assert.equal(cachePolicyForAsset('/assets/unknown.js', manifest), 'no-cache');
});

test('manifest rejects traversal and missing files', () => {
  const distDir = fixture();
  fs.writeFileSync(path.join(distDir, 'asset-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    assets: { desktopJs: '../secret.js' },
  }));
  assert.throws(() => loadWebAssetManifest({ distDir }), /unsafe asset path/);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `cd signal-server && node --test test/web-assets.test.js`

Expected: FAIL because `lib/web-assets.js` does not exist.

- [ ] **Step 3: Implement manifest validation and cache classification**

```javascript
// signal-server/lib/web-assets.js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HTML_POLICY = 'no-cache, max-age=0, must-revalidate';
const IMMUTABLE_POLICY = 'public, max-age=31536000, immutable';

function normalizeAssetPath(value) {
  const normalized = String(value || '').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) {
    throw new Error(`unsafe asset path: ${value}`);
  }
  return normalized;
}

function loadWebAssetManifest({ distDir }) {
  const manifestPath = path.join(distDir, 'asset-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || !manifest.assets) throw new Error('invalid asset manifest');
  const immutablePaths = new Set();
  for (const value of Object.values(manifest.assets)) {
    const relative = normalizeAssetPath(value);
    const absolute = path.resolve(distDir, relative);
    if (!absolute.startsWith(`${path.resolve(distDir)}${path.sep}`) || !fs.statSync(absolute).isFile()) {
      throw new Error(`missing manifest asset: ${relative}`);
    }
    immutablePaths.add(`/${relative}`);
  }
  return Object.freeze({ ...manifest, immutablePaths });
}

function cachePolicyForAsset(pathname, manifest) {
  if (manifest.immutablePaths.has(pathname)) return IMMUTABLE_POLICY;
  if (pathname === '/' || pathname.endsWith('.html') || pathname === '/asset-manifest.json') {
    return HTML_POLICY;
  }
  return 'no-cache';
}

function createWebAssetMiddleware({ express, distDir, manifest }) {
  return express.static(distDir, {
    index: 'index.html',
    setHeaders(res, filePath) {
      const relative = `/${path.relative(distDir, filePath).split(path.sep).join('/')}`;
      res.setHeader('Cache-Control', cachePolicyForAsset(relative, manifest));
    },
  });
}

module.exports = {
  loadWebAssetManifest,
  cachePolicyForAsset,
  createWebAssetMiddleware,
};
```

- [ ] **Step 4: Add an HTTP header integration assertion without switching production yet**

```javascript
test('generated HTML revalidates and hashed assets are immutable', async () => {
  const express = require('express');
  const http = require('node:http');
  const fixtureDir = fixture();
  const manifest = loadWebAssetManifest({ distDir: fixtureDir });
  const app = express();
  app.use(createWebAssetMiddleware({ express, distDir: fixtureDir, manifest }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const html = await fetch(`${origin}/viewer.html`);
  const asset = await fetch(`${origin}/assets/app.0123456789abcdef.js`);
  assert.equal(html.headers.get('cache-control'), 'no-cache, max-age=0, must-revalidate');
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  await new Promise((resolve) => server.close(resolve));
});

```

Keep `signal-server/server.js` on the current source static root in this task. Production switches only after ShellGuard, bootstrap, TerminalLoader, and telemetry are all present in the generated bundle.

- [ ] **Step 5: Run focused delivery/build tests**

Run:

```bash
cd signal-server
npm run build:web
node --test test/web-assets.test.js test/web-asset-build.test.js
```

Expected: PASS; no API test observes immutable static headers.

- [ ] **Step 6: Commit the delivery module slice**

```bash
git add signal-server/lib/web-assets.js signal-server/test/web-assets.test.js
git commit -m "perf(viewer): serve hashed assets with immutable caching"
```

---

### Task 4: Add One Canonical Authenticated Viewer Bootstrap Snapshot

**Files:**
- Create: `signal-server/lib/viewer-bootstrap.js`
- Create: `signal-server/test/viewer-bootstrap.test.js`
- Modify: `signal-server/server.js`
- Modify: `signal-server/test/config.test.js`

- [ ] **Step 1: Write failing pure snapshot tests**

```javascript
// signal-server/test/viewer-bootstrap.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const { buildViewerBootstrapSnapshot } = require('../lib/viewer-bootstrap');

test('snapshot combines Host truth and selected WebRTC config without probing externally', () => {
  const snapshot = buildViewerBootstrapSnapshot({
    config: {
      stunUrls: ['stun:example.test:3478'],
      turnUrls: [],
      turnUsername: '',
      turnCredential: '',
      turnSource: 'none',
      turnServers: [],
      publicEntryUrl: 'https://link.stockhub.wiki',
    },
    hostCapabilities: { turnReady: false, supportsSessionTurn: true },
    hostOnline: true,
    turnServerId: '',
    now: () => '2026-08-06T00:00:00.000Z',
  });
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.generatedAt, '2026-08-06T00:00:00.000Z');
  assert.equal(snapshot.host.online, true);
  assert.equal(snapshot.webrtc.turnConfigured, false);
  assert.deepEqual(snapshot.webrtc.iceServers, [{ urls: ['stun:example.test:3478'] }]);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `cd signal-server && node --test test/viewer-bootstrap.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Extract the existing config mapping into the builder**

```javascript
// signal-server/lib/viewer-bootstrap.js
'use strict';

const {
  getTurnStatus,
  getPublicEntryConfig,
  getMediaModeCapabilities,
  listPublicTurnServers,
} = require('./config');

function buildViewerBootstrapSnapshot({
  config,
  hostCapabilities = {},
  hostOnline = false,
  turnServerId = '',
  now = () => new Date().toISOString(),
}) {
  const turnState = getTurnStatus(config, { turnServerId });
  const selectedTurnServerId = turnState.selectedTurnServerId
    || config.selectedTurnServerId
    || config.defaultTurnServerId
    || '';
  const iceServers = [];
  if (config.stunUrls.length) iceServers.push({ urls: config.stunUrls });
  if (turnState.turnConfigured) {
    iceServers.push({
      urls: turnState.turnUrls,
      username: turnState.turnUsername,
      credential: turnState.turnCredential,
    });
  }
  return {
    schemaVersion: 1,
    generatedAt: now(),
    host: { online: Boolean(hostOnline), capabilities: { ...hostCapabilities } },
    webrtc: {
      stunUrls: config.stunUrls,
      turnConfigured: turnState.turnConfigured,
      turnMisconfigured: turnState.turnMisconfigured,
      turnStatus: turnState.turnStatus,
      turnSource: turnState.turnSource || config.turnSource || 'none',
      turnFingerprint: turnState.turnConfigured ? turnState.turnFingerprint : '',
      turnUrls: turnState.turnConfigured ? turnState.turnUrls : [],
      turnServers: listPublicTurnServers(config, selectedTurnServerId),
      selectedTurnServerId,
      defaultTurnServerId: turnState.defaultTurnServerId || config.defaultTurnServerId || '',
      iceServers,
      ...getMediaModeCapabilities({ ...config, ...turnState }),
      publicEntry: getPublicEntryConfig(config),
    },
  };
}

function projectLegacyWebrtcConfig(snapshot) {
  const host = snapshot.host || { capabilities: {} };
  const capabilities = host.capabilities || {};
  return {
    ...snapshot.webrtc,
    hostTurnReady: Boolean(capabilities.turnReady),
    hostTurnFingerprint: capabilities.turnFingerprint || '',
    hostTurnServerId: capabilities.turnServerId || capabilities.defaultTurnServerId || '',
    hostSupportsSessionTurn: Boolean(capabilities.supportsSessionTurn),
    hostSupportsMultiTurn: Boolean(capabilities.supportsMultiTurn),
    hostTurnServerIds: Array.isArray(capabilities.turnServerIds) ? capabilities.turnServerIds : [],
  };
}

module.exports = { buildViewerBootstrapSnapshot, projectLegacyWebrtcConfig };
```

Replace the current hand-built `/api/webrtc-config` response with `projectLegacyWebrtcConfig(buildSnapshotForRequest(req))`; no TURN, capability, or ICE field may remain assembled separately in the route.

- [ ] **Step 4: Add authenticated endpoint test before route implementation**

Extend the existing `/api/webrtc-config` integration test in `signal-server/test/config.test.js`, reusing its fully populated `runtime` and `baseUrl` fixture inside the existing `try` block:

```javascript
const unauthenticated = await fetch(`${baseUrl}/api/viewer-bootstrap`);
assert.equal(unauthenticated.status, 401);

const bootstrapResponse = await fetch(`${baseUrl}/api/viewer-bootstrap`, {
  headers: {
    Authorization: `Bearer ${signAccessToken('viewer', 'viewer-bootstrap-test')}`,
  },
});
const bootstrapBody = await bootstrapResponse.json();
assert.equal(bootstrapResponse.status, 200);
assert.match(bootstrapResponse.headers.get('cache-control') || '', /no-store/);
assert.equal(bootstrapBody.schemaVersion, 1);
assert.equal(bootstrapBody.host.online, false);
assert.equal(bootstrapBody.webrtc.turnConfigured, true);
assert.deepEqual(bootstrapBody.webrtc.iceServers, body.iceServers);
```

- [ ] **Step 5: Implement `/api/viewer-bootstrap` and no-store response**

```javascript
const {
  buildViewerBootstrapSnapshot,
  projectLegacyWebrtcConfig,
} = require('./lib/viewer-bootstrap');

function buildSnapshotForRequest(req) {
  const requestedTurnServerId = String(req.query.turnServerId || '').trim();
  const connectionStatus = getConnectionStatus();
  return buildViewerBootstrapSnapshot({
    config,
    hostCapabilities: getHostCapabilities(),
    hostOnline: Boolean(connectionStatus.hostOnline),
    turnServerId: requestedTurnServerId,
  });
}

app.get('/api/webrtc-config', requireAccessToken, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(projectLegacyWebrtcConfig(buildSnapshotForRequest(req)));
});

app.get('/api/viewer-bootstrap', requireAccessToken, (req, res) => {
  const startedAt = performance.now();
  const snapshot = buildSnapshotForRequest(req);
  res.setHeader('Cache-Control', 'no-store');
  structuredLogger.info({
    domain: 'viewer-bootstrap',
    event: 'viewer_bootstrap_served',
    meta: {
      serverProcessMs: Math.round((performance.now() - startedAt) * 100) / 100,
      hostOnline: snapshot.host.online,
      turnServerId: snapshot.webrtc.selectedTurnServerId,
    },
  });
  res.json(snapshot);
});
```

Use the repository structured-event helper shape rather than introducing an incompatible logger schema.

- [ ] **Step 6: Run endpoint and config suites**

Run:

```bash
cd signal-server
node --test test/viewer-bootstrap.test.js test/config.test.js test/auth.test.js test/observability-logger.test.js
```

Expected: PASS; logs contain no token, TURN credential, or password.

- [ ] **Step 7: Commit the backend bootstrap slice**

```bash
git add signal-server/lib/viewer-bootstrap.js signal-server/test/viewer-bootstrap.test.js \
  signal-server/server.js signal-server/test/config.test.js
git commit -m "feat(viewer): expose canonical bootstrap snapshot"
```

---

### Task 5: Implement the Bounded ViewerBootstrap Module

**Files:**
- Create: `web-client/js/bootstrap-controller.js`
- Create: `web-client/js/bootstrap-controller.test.js`
- Modify: `signal-server/scripts/web-asset-graph.js`

- [ ] **Step 1: Write failing single-flight, timeout, and auth tests**

```javascript
// web-client/js/bootstrap-controller.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadController() {
  const context = {
    globalThis: null,
    AbortController,
    Promise,
    Error,
    setTimeout,
    clearTimeout,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    `${fs.readFileSync(path.join(__dirname, 'bootstrap-controller.js'), 'utf8')}\n` +
    'globalThis.__createViewerBootstrap = createViewerBootstrap;',
    context,
  );
  return context.__createViewerBootstrap;
}

test('warmup and Start share one in-flight bootstrap request', async () => {
  const createViewerBootstrap = loadController();
  let calls = 0;
  let resolveFetch;
  const fetchSnapshot = () => {
    calls += 1;
    return new Promise((resolve) => { resolveFetch = resolve; });
  };
  const controller = createViewerBootstrap({ fetchSnapshot, timeoutMs: 3000 });
  const warmup = controller.load({ mode: 'auto' });
  const click = controller.load({ mode: 'auto' });
  assert.equal(calls, 1);
  resolveFetch({ schemaVersion: 1, webrtc: {} });
  assert.deepEqual(await warmup, await click);
});

test('timeout degrades auto but never invents relay config', async () => {
  const createViewerBootstrap = loadController();
  const timeoutError = Object.assign(new Error('timeout'), { code: 'bootstrap-timeout' });
  const fetchSnapshot = async () => { throw timeoutError; };
  const fallbackFactory = () => ({ schemaVersion: 1, degraded: true, webrtc: { iceServers: [] } });

  const auto = createViewerBootstrap({ fetchSnapshot, fallbackFactory });
  assert.equal((await auto.load({ mode: 'auto' })).degraded, true);

  const relay = createViewerBootstrap({ fetchSnapshot, fallbackFactory });
  await assert.rejects(relay.load({ mode: 'relay' }), /timeout/);
  assert.equal(relay.getSnapshot().state, 'failed');
});

test('401 becomes auth-required and never falls back', async () => {
  const createViewerBootstrap = loadController();
  const error = Object.assign(new Error('unauthorized'), { status: 401 });
  const controller = createViewerBootstrap({
    fetchSnapshot: async () => { throw error; },
    fallbackFactory: () => ({ degraded: true }),
  });
  await assert.rejects(controller.load({ mode: 'auto' }), /unauthorized/);
  assert.equal(controller.getSnapshot().state, 'auth-required');
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test web-client/js/bootstrap-controller.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the deep module with injected adapters**

```javascript
// web-client/js/bootstrap-controller.js
function createViewerBootstrap(options = {}) {
  const fetchSnapshot = options.fetchSnapshot;
  const fallbackFactory = options.fallbackFactory || (() => null);
  const timeoutMs = Number(options.timeoutMs || 3000);
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const AbortControllerCtor = options.AbortController || globalThis.AbortController;
  let generation = 0;
  let inflight = null;
  let snapshot = { state: 'idle', generation: 0, value: null, error: null };
  const listeners = new Set();

  function publish(next) {
    snapshot = Object.freeze({ ...next });
    listeners.forEach((listener) => listener(snapshot));
    return snapshot;
  }

  async function execute({ mode, turnServerId }, currentGeneration, controller) {
    publish({ state: 'loading', generation: currentGeneration, value: null, error: null });
    let timer;
    try {
      const value = await Promise.race([
        fetchSnapshot({
          mode,
          turnServerId,
          generation: currentGeneration,
          signal: controller?.signal,
        }),
        new Promise((_, reject) => {
          timer = setTimer(() => {
            controller?.abort();
            reject(Object.assign(new Error('Viewer bootstrap timed out'), { code: 'bootstrap-timeout' }));
          }, timeoutMs);
        }),
      ]);
      if (currentGeneration !== generation) return snapshot.value;
      publish({ state: 'ready', generation: currentGeneration, value, error: null });
      return value;
    } catch (error) {
      if (currentGeneration !== generation) throw error;
      if (error.status === 401 || error.status === 403) {
        publish({ state: 'auth-required', generation: currentGeneration, value: null, error });
        throw error;
      }
      if (mode !== 'relay') {
        const value = fallbackFactory({ mode, error, generation: currentGeneration });
        publish({ state: 'degraded', generation: currentGeneration, value, error });
        return value;
      }
      publish({ state: 'failed', generation: currentGeneration, value: null, error });
      throw error;
    } finally {
      if (timer) clearTimer(timer);
      if (inflight?.generation === currentGeneration) inflight = null;
    }
  }

  function load(options = {}) {
    const request = {
      mode: options.mode || 'auto',
      turnServerId: options.turnServerId || '',
      force: options.force === true,
    };
    if (inflight && !request.force && inflight.key === `${request.mode}:${request.turnServerId}`) {
      return inflight.promise;
    }
    inflight?.controller?.abort();
    const currentGeneration = ++generation;
    const controller = AbortControllerCtor ? new AbortControllerCtor() : null;
    const promise = execute(request, currentGeneration, controller);
    inflight = {
      key: `${request.mode}:${request.turnServerId}`,
      generation: currentGeneration,
      controller,
      promise,
    };
    return promise;
  }

  return {
    load,
    retry(options = {}) { return load({ ...options, force: true }); },
    getSnapshot() { return snapshot; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    cancel() {
      generation += 1;
      inflight?.controller?.abort();
      inflight = null;
    },
  };
}

if (typeof globalThis !== 'undefined') globalThis.createViewerBootstrap = createViewerBootstrap;
if (typeof module !== 'undefined') module.exports = { createViewerBootstrap };
```

- [ ] **Step 4: Add tests for stale generation, explicit retry, and subscriber states**

```javascript
test('late result from an older forced load cannot overwrite the retry', async () => {
  const resolvers = [];
  const controller = loadController()({
    fetchSnapshot: () => new Promise((resolve) => resolvers.push(resolve)),
  });
  const oldLoad = controller.load({ mode: 'auto' });
  const retry = controller.retry({ mode: 'auto' });
  resolvers[1]({ id: 'new' });
  assert.equal((await retry).id, 'new');
  resolvers[0]({ id: 'old' });
  await oldLoad;
  assert.equal(controller.getSnapshot().value.id, 'new');
});

test('deadline aborts the underlying bootstrap fetch', async () => {
  let timeoutCallback;
  let observedSignal;
  const controller = loadController()({
    timeoutMs: 3000,
    setTimer(callback) { timeoutCallback = callback; return 1; },
    clearTimer() {},
    fetchSnapshot: ({ signal }) => {
      observedSignal = signal;
      return new Promise(() => {});
    },
    fallbackFactory: () => ({ degraded: true }),
  });
  const load = controller.load({ mode: 'auto' });
  timeoutCallback();
  assert.equal((await load).degraded, true);
  assert.equal(observedSignal.aborted, true);
});
```

Add `js/bootstrap-controller.js` immediately before `js/webrtc.js` in `desktopScripts`:

```javascript
    'js/turn-selftest.js',
    'js/bootstrap-controller.js',
    'js/webrtc.js',
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --test web-client/js/bootstrap-controller.test.js web-client/js/runtime-config.test.js
cd signal-server && npm run build:web
```

Expected: PASS; build graph includes `bootstrap-controller.js` exactly once.

- [ ] **Step 6: Commit the frontend bootstrap module**

```bash
git add web-client/js/bootstrap-controller.js web-client/js/bootstrap-controller.test.js \
  signal-server/scripts/web-asset-graph.js
git commit -m "feat(viewer): add bounded bootstrap coordinator"
```

---

### Task 6: Add ShellGuard and Integrate One Start Attempt into WebRTC

**Files:**
- Create: `web-client/js/shell-guard.js`
- Create: `web-client/js/shell-guard.test.js`
- Modify: `signal-server/scripts/build-web-client.js`
- Modify: `signal-server/test/web-asset-build.test.js`
- Modify: `web-client/viewer.html`
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/js/webrtc.test.js`
- Modify: `web-client/js/auth.js`
- Create: `web-client/js/auth.test.js`

- [ ] **Step 1: Write failing pre-core and takeover tests**

```javascript
// web-client/js/shell-guard.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createShellFixture() {
  const elements = {
    loadingText: { textContent: '' },
    retryButton: { hidden: true },
    coreControl: { disabled: false },
  };
  let deadline = null;
  const context = {
    window: null,
    document: {
      readyState: 'complete',
      addEventListener() {},
      getElementById(id) {
        if (id === 'loadingText') return elements.loadingText;
        if (id === 'coreRetryBtn') return elements.retryButton;
        return null;
      },
      querySelectorAll(selector) {
        return selector === '[data-core-control]' ? [elements.coreControl] : [];
      },
    },
    performance: { now: () => 1 },
    setTimeout(callback) { deadline = callback; return 1; },
    clearTimeout() { deadline = null; },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'shell-guard.js'), 'utf8'), context);
  return {
    shell: context.__WRD_SHELL__,
    elements,
    fireDeadline() { deadline?.(); },
  };
}

test('pre-core Start click is acknowledged and transferred exactly once', () => {
  const { shell, elements } = createShellFixture();
  shell.acknowledgeStartClick();
  assert.equal(elements.loadingText.textContent, '正在加载必要资源…');
  let calls = 0;
  shell.installCore(() => { calls += 1; });
  shell.installCore(() => { calls += 100; });
  assert.equal(calls, 1);
});

test('core deadline leaves a visible retryable state', () => {
  const { elements, fireDeadline } = createShellFixture();
  fireDeadline();
  assert.equal(elements.loadingText.textContent, '页面资源加载超时');
  assert.equal(elements.retryButton.hidden, false);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test web-client/js/shell-guard.test.js`

Expected: FAIL because ShellGuard does not exist.

- [ ] **Step 3: Implement dependency-free ShellGuard**

```javascript
// web-client/js/shell-guard.js
(function installShellGuard(global) {
  const state = {
    coreInstalled: false,
    queuedStart: false,
    startHandler: null,
    marks: [],
  };
  const deadline = global.setTimeout(() => {
    if (!state.coreInstalled) failCore('页面资源加载超时');
  }, 5000);

  function setCoreControlsDisabled(disabled) {
    global.document.querySelectorAll('[data-core-control]').forEach((control) => {
      control.disabled = disabled;
    });
  }
  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', () => setCoreControlsDisabled(true), { once: true });
  } else {
    setCoreControlsDisabled(true);
  }

  function element(id) { return global.document.getElementById(id); }
  function mark(name, detail = null) {
    state.marks.push({ name, at: global.performance?.now?.() || 0, detail });
  }
  function setText(text) {
    const target = element('loadingText');
    if (target) target.textContent = text;
  }
  function acknowledgeStartClick() {
    mark('start-click');
    if (state.startHandler) return state.startHandler();
    state.queuedStart = true;
    setText('正在加载必要资源…');
    return undefined;
  }
  function installCore(startHandler) {
    if (state.coreInstalled) return false;
    state.coreInstalled = true;
    state.startHandler = startHandler;
    global.clearTimeout(deadline);
    mark('core-interactive');
    setCoreControlsDisabled(false);
    if (state.queuedStart) startHandler();
    return true;
  }
  function failCore(reason) {
    mark('core-failed', reason);
    setText(reason || '页面资源加载失败');
    const retry = element('coreRetryBtn');
    if (retry) retry.hidden = false;
  }
  global.__WRD_SHELL__ = {
    mark,
    acknowledgeStartClick,
    installCore,
    failCore,
    snapshot: () => ({ ...state, marks: state.marks.slice() }),
  };
})(window);
```

- [ ] **Step 4: Inline the minified guard and make initial controls truthful**

Update the builder to transform `shell-guard.js` separately and inject it before the deferred desktop script:

```javascript
const shellGuard = await compileClassic(
  fs.readFileSync(path.join(sourceDir, 'js/shell-guard.js'), 'utf8'),
  'shell-guard.js',
);

const generatedScripts = [
  `<script>${shellGuard}</script>`,
  `<script>window.__WRD_ASSETS__=${JSON.stringify(lazyAssets)}</script>`,
  `<script src="/${assets.desktopJs}" defer></script>`,
].join('\n');
```

In the source fallback head block, add ShellGuard after Viewer CSS. The production build replaces this block and inlines the same source at the bottom, so source mode and generated mode keep the same interface:

```html
<script src="js/shell-guard.js"></script>
```

In `viewer.html`, mark core-owned controls without hard-coding `disabled`; ShellGuard owns the temporary disabled state:

```html
<button id="startBtn" class="start-btn" type="button"
        onclick="window.__WRD_SHELL__?.acknowledgeStartClick()">
  开始学习助手
</button>
<button id="terminalTabBtn" class="view-tab-btn" type="button" data-core-control>Terminal</button>
<button id="refreshBtn" class="control-btn" data-core-control>刷新画面</button>
<button id="diagBtn" class="control-btn status-action-secondary" data-core-control>诊断日志</button>
<button id="coreRetryBtn" class="start-btn" type="button" hidden onclick="location.reload()">重新加载</button>
```

Mark every shell control that has no truthful pre-core behavior with `data-core-control`, including the Terminal tab, status actions, desktop control bar, action buttons, network settings, and modal triggers. Do not mark or disable the Start or core-retry buttons. Extend `shell-guard.test.js` to assert all marked controls are disabled before takeover and enabled after `installCore()`.

- [ ] **Step 5: Write failing WebRTC integration tests**

```javascript
test('Start warmup and click use one bootstrap and one signaling attempt', async () => {
  const signalingSockets = [];
  let bootstrapCalls = 0;
  const { WebRTC } = loadWebRTC({
    io: () => {
      const socket = { on() {}, emit() {}, disconnect() {}, connected: true };
      signalingSockets.push(socket);
      return socket;
    },
  });
  const controller = {
    load: async () => {
      bootstrapCalls += 1;
      return { schemaVersion: 1, host: { online: true }, webrtc: { iceServers: [] } };
    },
  };
  const start = WebRTC.createStartHandler(controller);
  await Promise.all([start(), start()]);
  assert.equal(bootstrapCalls, 1);
  assert.equal(signalingSockets.length, 1);
  assert.ok(WebRTC.currentConnectionAttemptId);
});

test('WebRTC.init consumes supplied snapshot and does not fetch config', async () => {
  const signalingSockets = [];
  const { WebRTC } = loadWebRTC({
    io: () => {
      const socket = { on() {}, emit() {}, disconnect() {}, connected: true };
      signalingSockets.push(socket);
      return socket;
    },
  });
  WebRTC.loadServerConfig = () => { throw new Error('must not fetch'); };
  await WebRTC.init({
    bootstrapSnapshot: { host: { online: true }, webrtc: { iceServers: [] } },
    trigger: 'test',
  });
  assert.equal(WebRTC.serverConfig.iceServers.length, 0);
  assert.equal(signalingSockets.length, 1);
});
```

- [ ] **Step 6: Integrate the bootstrap adapter and remove duplicate init fetch**

```javascript
const ViewerBootstrap = createViewerBootstrap({
  timeoutMs: 3000,
  async fetchSnapshot({ turnServerId, signal }) {
    const query = turnServerId ? `?turnServerId=${encodeURIComponent(turnServerId)}` : '';
    const response = await fetch(`${RuntimeConfig.getApiBase()}/api/viewer-bootstrap${query}`, {
      cache: 'no-store',
      signal,
      headers: { Authorization: `Bearer ${Auth.getToken()}` },
    });
    if (!response.ok) {
      const error = new Error(`Viewer bootstrap HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  },
  fallbackFactory({ mode, error }) {
    return {
      schemaVersion: 1,
      degraded: true,
      degradedReason: error.code || 'bootstrap-unavailable',
      host: { online: null, capabilities: {} },
      webrtc: {
        stunUrls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
        iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
        turnConfigured: false,
        turnStatus: 'unavailable',
        selectedTurnServerId: '',
      },
      mode,
    };
  },
});

async function startViewer(controller = ViewerBootstrap) {
  try {
    const bootstrapSnapshot = await controller.load({
      mode: WebRTC.networkMode,
      turnServerId: WebRTC.selectedTurnServerId,
    });
    await WebRTC.init({ bootstrapSnapshot, trigger: 'start-button' });
  } catch (error) {
    if (controller.getSnapshot().state === 'auth-required') return Auth.logout();
    WebRTC.enterBootstrapFailure(error);
  }
}

WebRTC.createStartHandler = function createStartHandler(controller = ViewerBootstrap) {
  let inflightStart = null;
  return function startOnce() {
    if (inflightStart) return inflightStart;
    inflightStart = startViewer(controller).finally(() => { inflightStart = null; });
    return inflightStart;
  };
};

document.addEventListener('DOMContentLoaded', () => {
  ViewerBootstrap.load({ mode: WebRTC.networkMode }).catch(() => {});
  window.__WRD_SHELL__?.installCore(WebRTC.createStartHandler(ViewerBootstrap));
});
```

Delete the existing `startBtn.addEventListener('click', ...)` block from `webrtc.js`. The inline ShellGuard acknowledgement is the only DOM click entry, and after takeover it forwards to the one handler installed by `installCore`; keeping both listeners would create duplicate connection attempts.

Change `WebRTC.init`:

```javascript
async init({ bootstrapSnapshot, trigger = 'viewer-open' } = {}) {
  const token = Auth.getToken();
  if (!token) return Auth.logout();
  this.manualDisconnect = false;
  this.applyBootstrapSnapshot(bootstrapSnapshot);
  this.clearFailureRecommendation();
  const modeState = this.enforceSupportedNetworkMode(this.networkMode);
  this.beginConnectionAttempt(trigger);
  this.configureNetworkControls();
  this.createSignalingSocket(true);
  this.bindControlLifecycle();
  if (this.networkMode !== 'tunnel') this.createPeerConnection();
}
```

`applyBootstrapSnapshot` maps `snapshot.webrtc` into `serverConfig` and applies `snapshot.host.capabilities`; no HTTP call is allowed in this method.

- [ ] **Step 7: Add and test the first-frame budget**

```javascript
beginFirstFrameDeadline(attemptId, timeoutMs = 8000) {
  this.clearFirstFrameDeadline();
  this._firstFrameTimer = setTimeout(() => {
    if (attemptId !== this.currentConnectionAttemptId || this.isCurrentAttemptMediaReady()) return;
    this.endConnectingWithFailure('first-frame-timeout');
  }, timeoutMs);
}
```

Test:

```javascript
test('first-frame timeout exits connecting without reviving a stale attempt', () => {
  let timerCallback = null;
  const { WebRTC, elements } = loadWebRTC({
    setTimeout(callback) { timerCallback = callback; return 1; },
    clearTimeout() {},
  });
  WebRTC.currentConnectionAttemptId = 'attempt-1';
  WebRTC.beginFirstFrameDeadline('attempt-1', 8000);
  timerCallback();
  assert.match(elements.get('loadingText').textContent, /超时|重试/);
  WebRTC.currentConnectionAttemptId = 'attempt-2';
  timerCallback();
  assert.equal(WebRTC.currentConnectionAttemptId, 'attempt-2');
});
```

- [ ] **Step 8: Run Viewer integration tests and rebuild**

Run:

```bash
node --test web-client/js/shell-guard.test.js web-client/js/bootstrap-controller.test.js \
  web-client/js/webrtc.test.js web-client/js/auth.test.js
cd signal-server && npm run build:web && node --test test/web-asset-build.test.js
```

Expected: PASS; generated Start click is immediately acknowledged; init performs no duplicate config fetch.

- [ ] **Step 9: Commit the shell/bootstrap integration**

```bash
git add web-client/js/shell-guard.js web-client/js/shell-guard.test.js web-client/viewer.html \
  web-client/js/webrtc.js web-client/js/webrtc.test.js web-client/js/auth.js \
  web-client/js/auth.test.js signal-server/scripts/build-web-client.js \
  signal-server/test/web-asset-build.test.js
git commit -m "fix(viewer): bound startup and acknowledge every start click"
```

---

### Task 7: Lazy-Load Terminal and xterm Without Blocking Desktop

**Files:**
- Create: `web-client/js/terminal-loader.js`
- Create: `web-client/js/terminal-loader.test.js`
- Modify: `web-client/js/terminal.js`
- Modify: `web-client/js/terminal.test.js`
- Modify: `web-client/viewer.html`
- Modify: `signal-server/scripts/web-asset-graph.js`
- Modify: `signal-server/test/web-asset-build.test.js`

- [ ] **Step 1: Write failing lazy-load tests**

```javascript
// web-client/js/terminal-loader.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadFactory() {
  const context = { globalThis: null, Promise, setTimeout, clearTimeout };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    `${fs.readFileSync(path.join(__dirname, 'terminal-loader.js'), 'utf8')}\n` +
    'globalThis.__factory = createTerminalLoader;',
    context,
  );
  return { factory: context.__factory, context };
}

test('concurrent Terminal clicks load assets and initialize once', async () => {
  const { factory, context } = loadFactory();
  let scriptCalls = 0;
  let styleCalls = 0;
  let initCalls = 0;
  context.TerminalPanel = { init() { initCalls += 1; } };
  const loader = factory({
    assets: { terminalCss: '/terminal.css', terminalJs: '/terminal.js' },
    document: {},
    loadStyle: async () => { styleCalls += 1; },
    loadScript: async () => { scriptCalls += 1; },
    getTerminalPanel: () => context.TerminalPanel,
  });
  const first = loader.load();
  const second = loader.load();
  assert.equal(first, second);
  await first;
  assert.equal(scriptCalls, 1);
  assert.equal(styleCalls, 1);
  assert.equal(initCalls, 1);
  assert.equal(loader.getState().state, 'ready');
});

test('Terminal load failure does not change Desktop state and can retry', async () => {
  const { factory, context } = loadFactory();
  let fail = true;
  const desktop = { state: 'active' };
  context.TerminalPanel = { init() {} };
  const loader = factory({
    assets: { terminalCss: '/terminal.css', terminalJs: '/terminal.js' },
    document: {},
    loadStyle: async () => {},
    loadScript: async () => { if (fail) throw new Error('asset failed'); },
    getTerminalPanel: () => context.TerminalPanel,
  });
  await assert.rejects(loader.load(), /asset failed/);
  assert.equal(desktop.state, 'active');
  assert.equal(loader.getState().state, 'failed');
  fail = false;
  await loader.retry();
  assert.equal(loader.getState().state, 'ready');
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test web-client/js/terminal-loader.test.js`

Expected: FAIL because the loader does not exist.

- [ ] **Step 3: Implement one lazy-load interface**

```javascript
// web-client/js/terminal-loader.js
function createTerminalLoader({
  assets,
  document,
  timeoutMs = 5000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  loadStyle,
  loadScript,
  getTerminalPanel = () => globalThis.TerminalPanel,
}) {
  let state = Object.freeze({ state: 'idle', error: null });
  let inflight = null;

  function appendStyle(href) {
    return new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.onload = resolve;
      link.onerror = () => reject(new Error('Terminal stylesheet failed'));
      document.head.appendChild(link);
    });
  }

  function appendScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Terminal script failed'));
      document.body.appendChild(script);
    });
  }

  const loadCss = loadStyle || appendStyle;
  const loadJs = loadScript || appendScript;

  function load({ force = false } = {}) {
    if (state.state === 'ready') return Promise.resolve(getTerminalPanel());
    if (inflight && !force) return inflight;
    state = Object.freeze({ state: 'loading', error: null });
    let timer;
    inflight = Promise.race([
      Promise.all([loadCss(assets.terminalCss), loadJs(assets.terminalJs)]),
      new Promise((_, reject) => {
        timer = setTimer(() => reject(new Error('Terminal assets timed out')), timeoutMs);
      }),
    ]).then(() => {
      const panel = getTerminalPanel();
      if (!panel?.init) throw new Error('Terminal module did not register');
      panel.init();
      state = Object.freeze({ state: 'ready', error: null });
      return panel;
    }).catch((error) => {
      state = Object.freeze({ state: 'failed', error });
      throw error;
    }).finally(() => {
      if (timer) clearTimer(timer);
      inflight = null;
    });
    return inflight;
  }

  return {
    load,
    retry() { return load({ force: true }); },
    getState() { return state; },
  };
}

globalThis.createTerminalLoader = createTerminalLoader;
```

- [ ] **Step 4: Make Terminal initialization explicit and idempotent**

```javascript
// inside TerminalPanel
_initialized: false,
init() {
  if (this._initialized) return false;
  this.cacheElements();
  if (!this.elements.root) return false;
  this._initialized = true;
  this.bindEvents();
  this.elements.transportSelect.value = this.preferredTransport === 'webrtc-turn'
    ? 'webrtc-turn'
    : 'socketio';
  this.render();
  return true;
},
```

Replace the unconditional `DOMContentLoaded` initializer with:

```javascript
globalThis.TerminalPanel = TerminalPanel;
```

The loader owns when initialization occurs.

- [ ] **Step 5: Bind the shell Terminal tab to the loader**

Add `js/terminal-loader.js` after bootstrap and before WebRTC in the desktop asset graph:

```javascript
    'js/bootstrap-controller.js',
    'js/terminal-loader.js',
    'js/webrtc.js',
```

```javascript
const TerminalLoader = createTerminalLoader({
  assets: window.__WRD_ASSETS__,
  document,
  timeoutMs: 5000,
});

function setTerminalLoadFailure(error) {
  const warning = document.getElementById('terminalWarning');
  const retry = document.getElementById('terminalLoadRetryBtn');
  if (warning) {
    warning.textContent = error?.message || 'Terminal 资源加载失败';
    warning.classList.remove('hidden');
  }
  if (retry) retry.hidden = false;
}

async function openTerminal({ retry = false } = {}) {
  try {
    const panel = retry ? await TerminalLoader.retry() : await TerminalLoader.load();
    document.getElementById('terminalWarning')?.classList.add('hidden');
    const retryButton = document.getElementById('terminalLoadRetryBtn');
    if (retryButton) retryButton.hidden = true;
    panel.showTerminal();
  } catch (error) {
    setTerminalLoadFailure(error);
  }
}

document.getElementById('terminalTabBtn')?.addEventListener('click', () => openTerminal());
document.getElementById('terminalLoadRetryBtn')?.addEventListener('click', () => openTerminal({ retry: true }));
```

Add `<button id="terminalLoadRetryBtn" type="button" hidden>重试加载 Terminal</button>` beside `terminalWarning`. Desktop tab behavior must remain available in core without waiting for Terminal. Do not call an undeclared UI helper; `openTerminal()` owns this isolated failure surface.

- [ ] **Step 6: Extend build assertions**

```javascript
assert.doesNotMatch(
  generatedHtml,
  /<(?:script[^>]+src|link[^>]+href)="[^"]*(?:xterm|addon-fit|terminal\.[a-f0-9]+\.(?:js|css))/i,
);
assert.ok(manifest.assets.terminalJs);
assert.ok(manifest.assets.terminalCss);
assert.ok(bundleText.desktop.includes('createTerminalLoader'));
assert.ok(!bundleText.desktop.includes('const TerminalPanel'));
```

- [ ] **Step 7: Run focused Terminal/build tests**

Run:

```bash
node --test web-client/js/terminal-loader.test.js web-client/js/terminal.test.js
cd signal-server && npm run build:web && node --test test/web-asset-build.test.js
```

Expected: PASS; generated critical HTML contains no Terminal/xterm request.

- [ ] **Step 8: Commit the lazy Terminal slice**

```bash
git add web-client/js/terminal-loader.js web-client/js/terminal-loader.test.js \
  web-client/js/terminal.js web-client/js/terminal.test.js web-client/viewer.html \
  signal-server/scripts/web-asset-graph.js signal-server/test/web-asset-build.test.js
git commit -m "perf(terminal): load xterm outside Viewer critical path"
```

---

### Task 8: Add Startup Telemetry and Immutable Browser Acceptance

**Files:**
- Create: `web-client/js/startup-telemetry.js`
- Create: `web-client/js/startup-telemetry.test.js`
- Modify: `web-client/js/diagnostic.js`
- Modify: `web-client/js/diagnostic.test.js`
- Modify: `web-client/js/webrtc.js`
- Modify: `signal-server/scripts/web-asset-graph.js`
- Modify: `signal-server/server.js`
- Modify: `signal-server/test/web-assets.test.js`
- Create: `scripts/viewer_bootstrap_acceptance.py`
- Create: `scripts/test_viewer_bootstrap_acceptance.py`

- [ ] **Step 1: Write failing timing/redaction tests**

```javascript
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadTelemetry() {
  const context = {
    globalThis: null,
    URL,
    location: { origin: 'https://link.stockhub.wiki' },
    performance: { now: () => 0 },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    `${fs.readFileSync(path.join(__dirname, 'startup-telemetry.js'), 'utf8')}\n` +
    'globalThis.__factory = createStartupTelemetry;',
    context,
  );
  return context.__factory;
}

test('startup telemetry keeps bounded monotonic marks and redacted resource paths', () => {
  const values = [0, 10, 30, 80];
  const telemetry = loadTelemetry()({
    now: () => values.shift() ?? 80,
    origin: 'https://link.stockhub.wiki',
  });
  telemetry.mark('core-interactive');
  telemetry.mark('bootstrap-ready');
  telemetry.recordResources([
    { name: 'https://link.stockhub.wiki/js/app.js?token=secret', duration: 50 },
    { name: 'https://cdn.example/x.js?key=secret', duration: 90 },
  ]);
  const snapshot = telemetry.snapshot();
  assert.deepEqual(snapshot.marks.map((mark) => mark.name), ['core-interactive', 'bootstrap-ready']);
  assert.equal(snapshot.resources[0].path, '/js/app.js');
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|cdn\.example/);
  assert.ok(snapshot.resources.length <= 10);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test web-client/js/startup-telemetry.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the bounded telemetry module**

```javascript
function createStartupTelemetry({ now = () => performance.now(), origin = location.origin } = {}) {
  const marks = [];
  let resources = [];
  return {
    mark(name, detail = null) {
      if (marks.length >= 64) return false;
      marks.push({ name: String(name).slice(0, 64), atMs: Math.round(now() * 100) / 100, detail });
      return true;
    },
    recordResources(entries = []) {
      resources = entries.flatMap((entry) => {
        try {
          const url = new URL(entry.name, origin);
          if (url.origin !== origin) return [];
          return [{ path: url.pathname, durationMs: Math.round(Number(entry.duration) * 100) / 100 }];
        } catch (_error) { return []; }
      }).sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
    },
    snapshot() {
      return { schemaVersion: 1, marks: marks.slice(), resources: resources.slice() };
    },
  };
}

globalThis.StartupTelemetry = createStartupTelemetry();
globalThis.__WRD_STARTUP_SNAPSHOT__ = () => globalThis.StartupTelemetry.snapshot();
```

Merge ShellGuard marks once during core takeover; do not make ShellGuard a continuing truth source.

- [ ] **Step 4: Add startup evidence to diagnostics**

```javascript
// Add this field to the existing object returned by buildConnectionDiagnostic():
startup: typeof globalThis.__WRD_STARTUP_SNAPSHOT__ === 'function'
  ? globalThis.__WRD_STARTUP_SNAPSHOT__()
  : null,
```

Add exact marks from WebRTC socket connect, offer, PC connect, first rendered frame, active, and Terminal loader. Do not derive `active` from an intermediate `resuming` state.

- [ ] **Step 5: Add telemetry to the graph and switch production static delivery only now**

Add telemetry before bootstrap in `desktopScripts`:

```javascript
    'js/turn-selftest.js',
    'js/startup-telemetry.js',
    'js/bootstrap-controller.js',
    'js/terminal-loader.js',
    'js/webrtc.js',
```

Replace the blanket source static middleware in `signal-server/server.js`:

```javascript
const {
  loadWebAssetManifest,
  createWebAssetMiddleware,
} = require('./lib/web-assets');
const { buildWebClient } = require('./scripts/build-web-client');

const webClientDistPath = options.webClientDistPath
  || path.join(__dirname, '..', 'web-client', 'dist');
const webAssetManifest = options.webAssetManifest
  || loadWebAssetManifest({ distDir: webClientDistPath });
app.use(createWebAssetMiddleware({
  express,
  distDir: webClientDistPath,
  manifest: webAssetManifest,
}));
```

Make every executable `node server.js` path build before listening:

```javascript
async function startServerFromSource(options = {}) {
  const projectRoot = path.join(__dirname, '..');
  const build = options.buildWebClient || buildWebClient;
  const start = options.startServer || startServer;
  await build({
    sourceDir: path.join(projectRoot, 'web-client'),
    outDir: path.join(projectRoot, 'web-client', 'dist'),
  });
  return start(options.serverOptions || {});
}

if (require.main === module) {
  startServerFromSource().catch((error) => {
    console.error('[web-assets] build failed:', error.message);
    process.exitCode = 1;
  });
}
```

Export `startServerFromSource` and add to `signal-server/test/web-assets.test.js`:

```javascript
test('executable startup builds assets before creating the listening server', async () => {
  const calls = [];
  await startServerFromSource({
    buildWebClient: async () => { calls.push('build'); },
    startServer: () => { calls.push('listen'); return {}; },
  });
  assert.deepEqual(calls, ['build', 'listen']);
});
```

The test file imports `startServerFromSource` from `../server`. Existing `createServerApp` tests inject `webClientDistPath` and a fixture manifest; they do not invoke a real build.

- [ ] **Step 6: Write failing percentile/report tests for acceptance tooling**

```python
import json

from viewer_bootstrap_acceptance import (
    build_report,
    nearest_rank,
    write_immutable_report,
)

def test_nearest_rank_p95_and_report_redaction(tmp_path):
    samples = list(range(1, 21))
    assert nearest_rank(samples, 0.95) == 19
    report = build_report(
        origin="https://link.stockhub.wiki",
        samples=[{"coreInteractiveMs": 1000, "token": "must-not-appear"}],
    )
    text = json.dumps(report)
    assert "must-not-appear" not in text
    path, digest = write_immutable_report(report, tmp_path)
    assert path.exists()
    assert len(digest) == 64
```

- [ ] **Step 7: Implement the Playwright acceptance CLI**

```python
# scripts/viewer_bootstrap_acceptance.py
import hashlib
import json
import math
import argparse
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

SENSITIVE_KEYS = {"token", "password", "credential", "authorization", "cookie"}

def nearest_rank(values, percentile):
    ordered = sorted(float(value) for value in values)
    if not ordered:
        return None
    index = max(0, math.ceil(percentile * len(ordered)) - 1)
    return ordered[index]

def redact_value(value):
    if isinstance(value, dict):
        return {
            key: redact_value(item)
            for key, item in value.items()
            if key.lower() not in SENSITIVE_KEYS
        }
    if isinstance(value, list):
        return [redact_value(item) for item in value]
    return value

def build_report(origin, samples):
    clean_samples = redact_value(samples)
    metric_names = ("coreInteractiveMs", "clickToSignalMs", "clickToActiveMs")
    summaries = {}
    for metric in metric_names:
        values = [sample[metric] for sample in clean_samples if sample.get(metric) is not None]
        summaries[f"{metric.removesuffix('Ms')}P50Ms"] = nearest_rank(values, 0.50)
        summaries[f"{metric.removesuffix('Ms')}P95Ms"] = nearest_rank(values, 0.95)
    return {
        "schemaVersion": 1,
        "origin": origin,
        "sampleCount": len(clean_samples),
        "summary": summaries,
        "samples": clean_samples,
    }

def write_immutable_report(report, output_dir):
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    path = output_dir / f"viewer-bootstrap-{stamp}.json"
    payload = (json.dumps(report, ensure_ascii=True, indent=2, sort_keys=True) + "\n").encode()
    path.write_bytes(payload)
    digest = hashlib.sha256(payload).hexdigest()
    (output_dir / "latest.json").write_bytes(payload)
    (output_dir / "latest.sha256").write_text(f"{digest}  {path.name}\n", encoding="ascii")
    return path, digest

def collect_startup_sample(page, origin, viewer_password):
    page.goto(origin, wait_until="domcontentloaded", timeout=15_000)
    if page.locator("#loginForm").count():
        page.fill("#password", viewer_password)
        page.click("button[type=submit]")
        page.wait_for_url("**/viewer.html", timeout=10_000)
    page.click("#startBtn")
    page.wait_for_function(
        "() => window.__WRD_STARTUP_SNAPSHOT__?.().marks.some(m => m.name === 'active')",
        timeout=8_500,
    )
    snapshot = page.evaluate("window.__WRD_STARTUP_SNAPSHOT__()")
    non_black = page.evaluate("""
      () => {
        const video = document.getElementById('remoteVideo');
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 36;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let visible = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] + data[i + 1] + data[i + 2] > 24) visible += 1;
        }
        return visible / (data.length / 4);
      }
    """)
    assert non_black > 0.05
    marks = {mark["name"]: mark["atMs"] for mark in snapshot["marks"]}
    def elapsed(start, end):
        if start not in marks or end not in marks:
            return None
        return round(marks[end] - marks[start], 2)
    sample = {
        "coreInteractiveMs": elapsed("html-shell", "core-interactive"),
        "clickToSignalMs": elapsed("start-click", "signal-connected"),
        "clickToActiveMs": elapsed("start-click", "active"),
        "nonBlackRatio": non_black,
        "finalState": "active",
        "startup": snapshot,
    }
    assert sample["coreInteractiveMs"] is not None
    assert sample["clickToSignalMs"] is not None
    assert sample["clickToActiveMs"] is not None
    return sample

def install_fault(page, fault):
    if fault == "cdn-block":
        page.route("**/*", lambda route: route.abort()
                   if "cdn.jsdelivr.net" in route.request.url or "cdn.socket.io" in route.request.url
                   else route.continue_())
    elif fault == "bootstrap-delay":
        def delay_bootstrap(route):
            time.sleep(10)
            route.continue_()
        page.route("**/api/viewer-bootstrap*", delay_bootstrap)
    elif fault == "terminal-abort":
        page.route("**/assets/terminal.*", lambda route: route.abort())

def verify_fault(page, fault, sample):
    if fault == "bootstrap-delay":
        marks = {mark["name"]: mark["atMs"] for mark in sample["startup"]["marks"]}
        degraded = marks.get("bootstrap-degraded")
        started = marks.get("bootstrap-start")
        assert degraded is not None and started is not None
        assert degraded - started <= 5000
    elif fault == "terminal-abort":
        page.click("#terminalTabBtn")
        page.wait_for_selector("#terminalLoadRetryBtn:not([hidden])", timeout=5500)
        assert sample["finalState"] == "active"

def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--origin", required=True)
    parser.add_argument("--runs", type=int, default=20)
    parser.add_argument("--mode", choices=("cold", "warm", "both"), default="both")
    parser.add_argument("--fault", choices=("bootstrap-delay", "terminal-abort", "cdn-block", "none"), default="none")
    parser.add_argument("--output-dir", default="artifacts/viewer-bootstrap")
    return parser.parse_args()

def main():
    args = parse_args()
    password = os.environ.get("VIEWER_ACCESS_PASSWORD", "")
    if not password:
        raise SystemExit("VIEWER_ACCESS_PASSWORD is required")
    samples = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        if args.mode in ("cold", "both"):
            for _ in range(args.runs):
                context = browser.new_context()
                page = context.new_page()
                install_fault(page, args.fault)
                sample = {"cacheMode": "cold", **collect_startup_sample(page, args.origin, password)}
                verify_fault(page, args.fault, sample)
                samples.append(sample)
                context.close()
        if args.mode in ("warm", "both"):
            context = browser.new_context()
            page = context.new_page()
            install_fault(page, args.fault)
            collect_startup_sample(page, args.origin, password)  # populate browser cache
            for _ in range(args.runs):
                sample = {"cacheMode": "warm", **collect_startup_sample(page, args.origin, password)}
                verify_fault(page, args.fault, sample)
                samples.append(sample)
            context.close()
        browser.close()
    report = build_report(args.origin, samples)
    path, digest = write_immutable_report(report, args.output_dir)
    print(json.dumps({"report": str(path), "sha256": digest, "summary": report["summary"]}, ensure_ascii=True))

if __name__ == "__main__":
    main()
```

The CLI supports:

```text
--origin
--runs 20
--mode cold|warm|both
--output-dir artifacts/viewer-bootstrap
--fault bootstrap-delay|terminal-abort|cdn-block|none
```

Read `VIEWER_ACCESS_PASSWORD` from the environment only; never accept or print it as a positional CLI argument. Write timestamped JSON, `latest.json`, and SHA-256.

- [ ] **Step 8: Run unit and focused diagnostic tests**

Run:

```bash
(cd signal-server && npm run build:web && node --test test/web-assets.test.js test/config.test.js)
node --test web-client/js/startup-telemetry.test.js web-client/js/diagnostic.test.js \
  web-client/js/webrtc.test.js web-client/js/terminal-loader.test.js
python3 -m pytest scripts/test_viewer_bootstrap_acceptance.py -q
```

Expected: PASS; serialized fixtures contain no secret values or query strings.

- [ ] **Step 9: Commit observability, production switch, and acceptance tooling**

```bash
git add web-client/js/startup-telemetry.js web-client/js/startup-telemetry.test.js \
  web-client/js/diagnostic.js web-client/js/diagnostic.test.js web-client/js/webrtc.js \
  signal-server/scripts/web-asset-graph.js signal-server/server.js \
  signal-server/test/web-assets.test.js scripts/viewer_bootstrap_acceptance.py \
  scripts/test_viewer_bootstrap_acceptance.py
git commit -m "test(viewer): capture bounded startup acceptance evidence"
```

---

### Task 9: Add Read-Only Formal Tunnel Preflight and Managed HTTP/2 Default

**Files:**
- Create: `scripts/fixed-tunnel-preflight.sh`
- Create: `scripts/fixed-tunnel-preflight.test.js`
- Modify: `scripts/start-fixed-domain.sh`
- Modify: `scripts/start-fixed-domain.test.js`
- Modify: `scripts/tunnel-launchctl.test.js`

- [ ] **Step 1: Write failing non-mutation and classification tests**

```javascript
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const preflightPath = path.join(__dirname, 'fixed-tunnel-preflight.sh');
const startFixedPath = path.join(__dirname, 'start-fixed-domain.sh');

test('fixed tunnel preflight reports token/multiple owners without mutation or secret output', () => {
  const source = fs.readFileSync(preflightPath, 'utf8');
  assert.doesNotMatch(source, /\b(kill|pkill|launchctl\s+remove|start-fixed-domain|cloudflared\s+tunnel\s+run)\b/);
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-fixed-preflight-'));
  const fixturePath = path.join(fixtureDir, 'processes.txt');
  const configPath = path.join(fixtureDir, 'config.yml');
  fs.writeFileSync(configPath, 'tunnel: fixture\ncredentials-file: /tmp/fixture.json\n');
  fs.writeFileSync(fixturePath, [
    '101 cloudflared tunnel --config /tmp/config.yml run wrd-tunnel',
    '102 cloudflared tunnel --config /tmp/config.yml run wrd-tunnel',
    '103 cloudflared tunnel run --token SUPER-SECRET-TOKEN',
  ].join('\n'));
  const result = spawnSync('bash', [preflightPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      WRD_PREFLIGHT_PROCESS_FIXTURE: fixturePath,
      WRD_PREFLIGHT_SKIP_NETWORK: '1',
      WRD_PREFLIGHT_SKIP_LOCAL: '1',
      CLOUDFLARED_CONFIG: configPath,
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /token-argv|multiple-formal-owners/);
  assert.doesNotMatch(result.stdout + result.stderr, /SUPER-SECRET-TOKEN/);
});

test('fixed-domain managed command defaults to http2 and permits explicit quic override', () => {
  const source = fs.readFileSync(startFixedPath, 'utf8');
  assert.match(source, /WRD_FIXED_TUNNEL_PROTOCOL="\$\{WRD_FIXED_TUNNEL_PROTOCOL:-http2\}"/);
  assert.match(source, /--protocol "\$WRD_FIXED_TUNNEL_PROTOCOL"/);
  assert.match(source, /http2\|quic/);
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
node --test scripts/fixed-tunnel-preflight.test.js scripts/start-fixed-domain.test.js scripts/tunnel-launchctl.test.js
```

Expected: FAIL because preflight and protocol contract do not exist.

- [ ] **Step 3: Implement read-only preflight**

```bash
#!/bin/bash
set -euo pipefail

ORIGIN="${ORIGIN:-http://127.0.0.1:8080}"
FORMAL_URL="${FORMAL_URL:-https://link.stockhub.wiki}"
CONFIG="${CLOUDFLARED_CONFIG:-$HOME/.cloudflared/config.yml}"
PROCESS_FIXTURE="${WRD_PREFLIGHT_PROCESS_FIXTURE:-}"

process_lines() {
  if [ -n "$PROCESS_FIXTURE" ]; then
    sed -n '1,200p' "$PROCESS_FIXTURE"
  else
    ps -axo pid=,command= | awk '/[c]loudflared/ && /tunnel/ {print}'
  fi
}

status=0
if [ "${WRD_PREFLIGHT_SKIP_LOCAL:-0}" != "1" ]; then
  curl -fsS --max-time 2 "$ORIGIN/health" >/dev/null || { echo 'local-health: failed'; status=1; }
fi
grep -Eq '^[[:space:]]*credentials-file[[:space:]]*:' "$CONFIG" 2>/dev/null \
  || { echo 'credentials-file: missing'; status=1; }

formal_count="$(process_lines | awk '/--config/ && /run/ {count++} END {print count+0}')"
token_count="$(process_lines | awk '/(^|[[:space:]])--token([=[:space:]]|$)/ {count++} END {print count+0}')"
[ "$formal_count" -le 1 ] || { echo "multiple-formal-owners: $formal_count"; status=1; }
[ "$token_count" -eq 0 ] || { echo 'token-argv: present'; status=1; }

if [ "${WRD_PREFLIGHT_SKIP_NETWORK:-0}" != "1" ]; then
  curl -fsS --max-time 5 -o /dev/null \
    -w 'formal-health: code=%{http_code} total=%{time_total}\n' "$FORMAL_URL/health" \
    || status=1
fi
exit "$status"
```

Keep the implementation self-contained and read-only. It may read process/config/log text, but it must print only counts and classifications; it must never echo command arguments, credential-file contents, environment values, or token substrings.

- [ ] **Step 4: Add managed protocol validation without executing it**

```bash
WRD_FIXED_TUNNEL_PROTOCOL="${WRD_FIXED_TUNNEL_PROTOCOL:-http2}"
case "$WRD_FIXED_TUNNEL_PROTOCOL" in
  http2|quic) ;;
  *) echo "WRD_FIXED_TUNNEL_PROTOCOL must be http2 or quic"; exit 1 ;;
esac
```

Change only the repository-managed launch command:

```bash
launchctl submit -l "$TUNNEL_LABEL" -- /bin/zsh -lc \
  "unset TUNNEL_TOKEN; exec \"$CLOUDFLARED\" tunnel --config \"$CLOUDFLARED_CONFIG\" --protocol \"$WRD_FIXED_TUNNEL_PROTOCOL\" run \"$TUNNEL_NAME\" >> /tmp/wrd-fixed-domain.log 2>&1"
```

Do not run `start-fixed-domain.sh` in this task.

- [ ] **Step 5: Run shell/source tests only**

Run:

```bash
bash -n scripts/fixed-tunnel-preflight.sh scripts/start-fixed-domain.sh
node --test scripts/fixed-tunnel-preflight.test.js scripts/start-fixed-domain.test.js \
  scripts/tunnel-launchctl.test.js scripts/status-safe-wrd.test.js
```

Expected: PASS; no live process or URL file changes.

- [ ] **Step 6: Commit tunnel preparation**

```bash
git add scripts/fixed-tunnel-preflight.sh scripts/fixed-tunnel-preflight.test.js \
  scripts/start-fixed-domain.sh scripts/start-fixed-domain.test.js scripts/tunnel-launchctl.test.js
git commit -m "ops(tunnel): add read-only formal connector preflight"
```

---

### Task 10: Synchronize Active Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/runbook-safe-startup.md`
- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md`
- Verify: `docs/superpowers/specs/2026-08-06-viewer-fast-bootstrap-design.md`
- Verify: `docs/superpowers/plans/2026-08-06-viewer-fast-bootstrap-plan.md`

- [ ] **Step 1: Add exact product requirements**

Add to the active requirement document:

```markdown
### Viewer 启动性能与可恢复性

- 正式公网入口冷启动 Core Interactive P95 <= 5 秒，热加载 P95 <= 2 秒。
- 点击「开始学习助手」必须立即反馈；到 Signal connected P95 <= 3 秒。
- 点击到首个稳定非黑画面 P95 <= 8 秒；超时必须退出连接中状态并允许重试。
- 任一 bootstrap 依赖不得静默阻塞超过 5 秒。
- Terminal/xterm 按需加载，加载失败不得影响 Desktop。
- 以上公网指标至少使用 20 个新浏览器上下文，以 immutable JSON + SHA-256 验收。
```

- [ ] **Step 2: Update README build and cache behavior**

Document:

```markdown
- `node server.js`（包括 `npm start` 和仓库 LaunchAgent/启动脚本）会先构建 `web-client/dist/`，构建失败时不监听 8080。
- Viewer HTML 每次 revalidate；带内容哈希的 JS/CSS 使用一年 immutable cache。
- Viewer 运行时不依赖 jsDelivr/cdn.socket.io；Terminal/xterm 首次打开时加载本地构建资产。
- `dist/` 是可重建产物，不纳入 Git；`signal-server/package-lock.json` 必须纳入 Git。
```

- [ ] **Step 3: Update safe-startup runbook without broadening authorization**

Add exact commands and boundaries:

```markdown
# Read-only formal connector check
./scripts/fixed-tunnel-preflight.sh

# Build verification; does not restart any service or tunnel
cd signal-server && npm ci && npm run build:web

# Runtime acceptance after the user manually restarts local services
VIEWER_ACCESS_PASSWORD=... python3 scripts/viewer_bootstrap_acceptance.py \
  --origin http://127.0.0.1:8080 --runs 20 --mode both
```

State that fixing token/multiple-owner findings or changing the running formal connector requires explicit user authorization; local restart and quick-tunnel preservation rules remain unchanged.

- [ ] **Step 4: Run doc consistency checks**

Run:

```bash
rg -n "cdn\.jsdelivr|cdn\.socket\.io|no-store.*static|Viewer 启动性能|fixed-tunnel-preflight|package-lock" \
  README.md docs/runbook-safe-startup.md docs/需求文档/WebRemoteDesktop-需求文档.md \
  docs/superpowers/specs/2026-08-06-viewer-fast-bootstrap-design.md
git diff --check
```

Expected: Runtime CDN/static-no-store wording is removed from active docs; tunnel authorization language remains explicit.

- [ ] **Step 5: Commit active docs**

```bash
git add README.md docs/runbook-safe-startup.md docs/需求文档/WebRemoteDesktop-需求文档.md \
  docs/superpowers/specs/2026-08-06-viewer-fast-bootstrap-design.md \
  docs/superpowers/plans/2026-08-06-viewer-fast-bootstrap-plan.md
git commit -m "docs(viewer): specify bounded fast bootstrap"
```

---

### Task 11: Run Full Automated Closure Before Any Runtime Restart

**Files:**
- Verify all implementation and test files from Tasks 1-10
- Do not modify tunnel or service state

- [ ] **Step 1: Verify clean generated build from locked dependencies**

Run:

```bash
cd signal-server
npm ci
npm run build:web
npm run build:web
```

Expected: both builds succeed and produce the same manifest; generated HTML has no external CDN references.

- [ ] **Step 2: Run Signal Server tests**

Run:

```bash
cd signal-server
npm test
```

Expected: all Signal Server tests PASS.

- [ ] **Step 3: Run Viewer and script tests**

Run:

```bash
node --test web-client/js/*.test.js web-client/css/*.test.js scripts/*.test.js
```

Expected: all Viewer/CSS/operational tests PASS.

- [ ] **Step 4: Run Python tests relevant to acceptance and service safety**

Run:

```bash
python3 -m pytest scripts/test_viewer_bootstrap_acceptance.py scripts/test_wrd_entry_health.py \
  skills/webremote-service/scripts/wrd_service_test.py -q
```

Expected: PASS for all three exact test targets.

- [ ] **Step 5: Run dependency/security and diff checks**

Run:

```bash
cd signal-server && npm audit --audit-level=moderate
cd ..
git diff --check
git status --short
git diff --stat
```

Expected: no moderate-or-higher unresolved dependency finding; only the intended implementation/docs plus pre-existing unrelated untracked files are present.

- [ ] **Step 6: Review the complete diff against the spec**

Check each Definition of Done item in the spec and record one of:

```text
AUTOMATED PASS
RUNTIME PENDING
BLOCKED WITH EVIDENCE
```

No public SLO may be marked PASS before browser/tunnel runtime acceptance.

---

### Task 12: Perform Local and Formal Runtime Acceptance Under Existing Authorization Boundaries

**Files:**
- Generate ignored evidence: `artifacts/viewer-bootstrap/*.json`
- Optionally create a tracked report only after results exist: `docs/superpowers/reports/2026-08-06-viewer-fast-bootstrap-acceptance.md`

- [ ] **Step 1: Stop and ask the user to restart local services manually**

Provide:

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop/signal-server
npm start 2>&1 | tee ../front-debug.log
```

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
./scripts/restart-host.sh
```

Do not run these commands automatically. Do not restart or rebuild quick tunnel.

- [ ] **Step 2: Verify local services after the user confirms restart**

Run:

```bash
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8080/api/status
python skills/webremote-service/scripts/wrd_service.py status
```

Expected: local health OK and Host online. Report Viewer and Terminal admin passwords from runtime config only because a restart occurred; do not write them into docs.

- [ ] **Step 3: Run local cold/warm and fault-injection acceptance**

Run:

```bash
VIEWER_ACCESS_PASSWORD="$VIEWER_ACCESS_PASSWORD" \
python3 scripts/viewer_bootstrap_acceptance.py \
  --origin http://127.0.0.1:8080 --runs 20 --mode both \
  --output-dir artifacts/viewer-bootstrap

VIEWER_ACCESS_PASSWORD="$VIEWER_ACCESS_PASSWORD" \
python3 scripts/viewer_bootstrap_acceptance.py \
  --origin http://127.0.0.1:8080 --runs 1 --fault bootstrap-delay \
  --output-dir artifacts/viewer-bootstrap

VIEWER_ACCESS_PASSWORD="$VIEWER_ACCESS_PASSWORD" \
python3 scripts/viewer_bootstrap_acceptance.py \
  --origin http://127.0.0.1:8080 --runs 1 --fault terminal-abort \
  --output-dir artifacts/viewer-bootstrap
```

Expected: local SLOs pass; delayed bootstrap exits by 5 seconds; Terminal failure leaves Desktop active.

- [ ] **Step 4: Run formal-entry acceptance without changing tunnel state**

Run:

```bash
./scripts/fixed-tunnel-preflight.sh
VIEWER_ACCESS_PASSWORD="$VIEWER_ACCESS_PASSWORD" \
python3 scripts/viewer_bootstrap_acceptance.py \
  --origin https://link.stockhub.wiki --runs 20 --mode both \
  --output-dir artifacts/viewer-bootstrap
```

Expected: if preflight is deliverable, collect full public SLO evidence. If preflight reports token/multiple-owner risk, record formal acceptance as blocked/pending; do not mutate the connector.

- [ ] **Step 5: Request separate authorization before formal connector migration**

Only after explicit approval may the operator:

1. stop the legacy token-based formal connector;
2. ensure one credentials-file named-tunnel owner;
3. start the repository-managed connector with HTTP/2;
4. rerun preflight and the 20-run formal matrix.

Never call `scripts/stop-safe-wrd.sh`; never rotate or restart the quick tunnel as part of this migration.

- [ ] **Step 6: Archive and review runtime results**

The acceptance report must include:

```markdown
- exact commit SHA and asset-manifest hashes;
- cold/warm sample counts and nearest-rank P50/P95;
- click-to-signal and click-to-active P50/P95;
- non-black ratio and final state for every media run;
- fault-injection outcomes;
- cache headers and critical request count;
- formal preflight classification;
- safe URL hash before/after proving no quick-tunnel mutation;
- explicit PASS/PARTIAL/FAIL judgment.
```

Do not report code-complete as public-runtime-complete.

---

## Plan Self-Review

### Spec completion

Every spec area has a concrete task:

| Spec area | Plan task |
|---|---|
| Build graph, hashes, local dependencies, lockfile | Tasks 1-2 |
| Manifest validation and cache policy | Task 3 |
| Canonical backend bootstrap snapshot | Task 4 |
| Frontend single-flight/deadline/degraded modes | Task 5 |
| ShellGuard, Start behavior, WebRTC handoff, first-frame budget | Task 6 |
| Lazy Terminal/xterm isolation | Task 7 |
| Startup timing and immutable evidence | Task 8 |
| Formal connector preflight and HTTP/2 managed default | Task 9 |
| Active documentation | Task 10 |
| Full automated closure | Task 11 |
| Local/public/fault/tunnel runtime proof | Task 12 |

No part of the requested complete solution is deferred to an unnamed follow-up.

### Architecture review

- Asset ordering appears once in `web-asset-graph.js`; production callers consume the manifest, not source lists.
- Cache policy appears once in `web-assets.js`; route code does not duplicate extension/hash rules.
- Backend TURN/Host mapping appears once in `buildViewerBootstrapSnapshot`; `/api/webrtc-config` is a compatibility projection.
- Frontend startup state appears once in `ViewerBootstrap`; ShellGuard only covers pre-core time and transfers ownership once.
- TerminalLoader is an optional adapter and cannot alter Desktop connection state.
- Existing connection-attempt IDs remain the media/input authority; new timers are attempt-scoped.
- Formal connector checks remain read-only until explicit operational authorization.

### Review corrections applied

- Tasks 1-2 build only files that already exist; bootstrap, TerminalLoader, and telemetry join the graph in Tasks 5, 7, and 8 respectively.
- Production static delivery remains on the source tree until Task 8, after every generated-bundle dependency exists and passes focused tests.
- Viewer bootstrap deadlines abort the underlying fetch, and the fetch adapter forwards the `AbortSignal`.
- Lazy Terminal filenames may appear in the inline asset map, so build tests prohibit critical `<script src>` / `<link href>` requests rather than incorrectly banning the filename text.
- The legacy Start listener is removed when ShellGuard installs the canonical handler, preventing one click from entering two connection paths.
- Terminal load failure uses an explicitly defined retry surface and never calls an undeclared UI helper.
- Direct `node server.js` startup builds before listening; correctness does not depend on npm lifecycle hooks.

### Impact and DoD audit

The header names truth, backend, frontend, runtime proof, docs, compatibility, and commit scope. Every DoD item is verified by a focused unit/integration test, a concrete browser acceptance sample, a header/process check, or active-doc diff review.

### Placeholder and type scan

The plan contains no `TBD`, `TODO`, “similar to”, or unbounded “add tests” steps. Public names used across tasks are stable:

```text
buildWebClient
loadWebAssetManifest
cachePolicyForAsset
buildViewerBootstrapSnapshot
createViewerBootstrap
createTerminalLoader
createStartupTelemetry
window.__WRD_SHELL__
window.__WRD_STARTUP_SNAPSHOT__
```

### Execution boundary

Tasks 1-11 are code/docs/test work and do not require service or tunnel mutation. Task 12 explicitly stops for user-managed local restart and separately authorized formal connector migration. Quick tunnel preservation is required throughout.
