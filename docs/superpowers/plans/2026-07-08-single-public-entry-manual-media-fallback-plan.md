# Single Public Entry Manual Media Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `https://link.stockhub.wiki` the only formal public entrypoint, keep manual `auto/stun -> relay -> tunnel` media fallback, and make every failed connection proactively produce structured diagnostics on the server.

**Architecture:** Keep entrypoint truth and media-path truth separate. The backend becomes the canonical source for public entry capability and mode capability, while the frontend keeps the user's chosen media mode and renders recommendation-only fallback guidance. Diagnostics become attempt-centric with one `connectionAttemptId` flowing through frontend traces, Socket.IO/HTTP upload, server persistence, and admin summaries.

**Tech Stack:** Node.js, Express, Socket.IO, vanilla browser JavaScript, localStorage, Cloudflare Tunnel, TURN, Node test runner, shell scripts

**Spec Coverage:** Full approved spec coverage. This plan covers single public entrypoint, manual media fallback chain, structured diagnostics, admin summary APIs, script/doc truth-source updates, and runtime proof.

**Truth Source:** `link.stockhub.wiki` as the only formal public entrypoint; backend `/api/webrtc-config` as the canonical mode-capability contract; `connectionAttemptId`-scoped diagnostics as the canonical connection evidence model.

**Compatibility Notes:** Existing `lan / auto / stun / relay / tunnel` modes remain. quick tunnel remains as a debug-only tool. Existing localStorage keys stay readable; new UI and diagnostics build on top of them without destructive migration.

**Impact Map:**
- **Truth Source:** Formal entrypoint truth moves to fixed-domain config/docs; media capability truth lives in `/api/webrtc-config`; connection evidence truth lives in structured attempt diagnostics.
- **Backend:** `signal-server/lib/config.js`, `signal-server/server.js`, `signal-server/websocket/signaling.js`, `signal-server/lib/diagnostic.js`, new admin/diagnostic HTTP endpoints.
- **Frontend:** `web-client/js/webrtc.js`, `web-client/js/diagnostic.js`, `web-client/js/ui.js`, runtime config, viewer status card and recommendation actions.
- **Runtime Proof:** `curl -I -L https://link.stockhub.wiki`, `/api/webrtc-config` capability payload, `/api/diagnostics` upload fallback, persisted attempt JSON, and mode-specific viewer behavior under direct/relay/tunnel scenarios.
- **Docs/Skills:** README, `docs/runbook-safe-startup.md`, deploy README, demand doc, and safe status script output must all promote `link.stockhub.wiki` over quick tunnel for formal user access.
- **Commit Boundary:** One implementation batch split into focused commits: backend capability contract, frontend mode UX, diagnostics pipeline, ops/docs truth-source cleanup.

**Definition of Done:**
- `link.stockhub.wiki` is the only documented formal public entrypoint, and quick tunnel is explicitly documented as debug-only.
- The viewer keeps manual mode control, shows recommendation-only fallback guidance, and never auto-switches from `auto/stun` to `relay/tunnel`.
- A failed connection attempt in any mode produces a structured server-side diagnostic with `connectionAttemptId`, failure code, mode, and next suggested mode, even when Socket.IO is unavailable.

---

## File Structure

### Canonical truth and responsibility map

- `signal-server/lib/config.js`
  - Canonical backend capability parsing for STUN/TURN and public entry metadata
- `signal-server/server.js`
  - Canonical HTTP contract for runtime config, diagnostics fallback upload, and admin summaries
- `signal-server/websocket/signaling.js`
  - Canonical real-time diagnostic ingestion and viewer/host signaling
- `signal-server/lib/diagnostic.js`
  - Canonical redaction, persistence, summary shaping, and attempt file helpers
- `web-client/js/webrtc.js`
  - Canonical frontend mode state, recommendation state, and media-path status machine
- `web-client/js/diagnostic.js`
  - Canonical frontend attempt payload builder and upload fallback queue
- `web-client/js/ui.js`
  - Canonical viewer UI control bindings that should call into `WebRTC`, not duplicate mode rules
- `README.md`
  - Canonical user/operator narrative for entrypoint policy
- `docs/runbook-safe-startup.md`
  - Canonical operational narrative for local services, fixed domain, and debug-only quick tunnel
- `scripts/status-safe-wrd.sh`
  - Canonical operator status output for local services and debug tunnel state

### Compatibility boundary

- quick tunnel scripts remain as a read-only debug path for operators
- `wrdNetworkMode` localStorage key remains valid
- `tunnel` mode remains user-selectable; it is not removed or renamed

---

### Task 1: Introduce a canonical backend capability contract

**Files:**
- Modify: `signal-server/lib/config.js`
- Modify: `signal-server/server.js`
- Modify: `signal-server/websocket/signaling.js`
- Test: `signal-server/test/config.test.js`
- Test: `signal-server/test/diagnostic.test.js`

- [ ] **Step 1: Write failing tests for capability contract and diagnostic HTTP fallback**

```js
// signal-server/test/config.test.js
test('getPublicEntryConfig returns fixed-domain-first metadata', () => {
  process.env.WRD_PUBLIC_ENTRY_URL = 'https://link.stockhub.wiki';
  const { loadConfig, getPublicEntryConfig } = require('../lib/config');
  const config = loadConfig();
  assert.deepEqual(getPublicEntryConfig(config), {
    formalEntryUrl: 'https://link.stockhub.wiki',
    formalEntryMode: 'fixed-domain',
    quickTunnelRecommended: false,
  });
});

test('getMediaModeCapabilities exposes manual fallback chain', () => {
  const { getMediaModeCapabilities } = require('../lib/config');
  assert.deepEqual(
    getMediaModeCapabilities({
      turnUrls: ['turn:turn.example.com:3478'],
      turnUsername: 'viewer',
      turnCredential: 'secret',
    }),
    {
      directAvailable: true,
      turnConfigured: true,
      tunnelAvailable: true,
      recommendedMode: 'auto',
      manualFallbackChain: ['auto', 'relay', 'tunnel'],
    },
  );
});
```

```js
// signal-server/test/diagnostic.test.js
test('POST /api/diagnostics persists structured connection attempt payload', async () => {
  const payload = {
    type: 'connection-diagnostic',
    connectionAttemptId: 'attempt-http-1',
    traceSummary: { trigger: 'auto-failure', reason: 'ice-check-timeout' },
    events: [{ kind: 'ice-state', value: 'failed' }],
  };
  const { baseUrl, closeServer } = await startServer();
  try {
    const response = await fetch(baseUrl + '/api/diagnostics', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken('viewer', 'diag-viewer')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.accepted, true);
    assert.equal(body.connectionAttemptId, 'attempt-http-1');
  } finally {
    await closeServer();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test signal-server/test/config.test.js signal-server/test/diagnostic.test.js
```

Expected:

```text
FAIL getPublicEntryConfig is not a function
FAIL POST /api/diagnostics returns 404 or app is missing the route
```

- [ ] **Step 3: Add config helpers, introduce a shared ingestion helper, and expose them from `/api/webrtc-config`**

```js
// signal-server/lib/config.js
function getPublicEntryConfig(configLike = {}) {
  const formalEntryUrl = String(configLike.publicEntryUrl || 'https://link.stockhub.wiki').trim();
  return {
    formalEntryUrl,
    formalEntryMode: 'fixed-domain',
    quickTunnelRecommended: false,
  };
}

function getMediaModeCapabilities(configLike = {}) {
  const turnState = getTurnStatus(configLike);
  return {
    directAvailable: true,
    turnConfigured: turnState.turnConfigured,
    tunnelAvailable: true,
    recommendedMode: 'auto',
    manualFallbackChain: ['auto', 'relay', 'tunnel'],
  };
}

// inside loadConfig()
publicEntryUrl: String(process.env.WRD_PUBLIC_ENTRY_URL || 'https://link.stockhub.wiki').trim(),
```

```js
// signal-server/server.js
const { loadConfig, getTurnStatus, getPublicEntryConfig, getMediaModeCapabilities } = require('./lib/config');

app.get('/api/webrtc-config', requireAccessToken, (req, res) => {
  const turnState = getTurnStatus(config);
  const capability = getMediaModeCapabilities(config);
  const publicEntry = getPublicEntryConfig(config);
  const iceServers = [];

  if (config.stunUrls.length) {
    iceServers.push({ urls: config.stunUrls });
  }
  if (turnState.turnConfigured) {
    iceServers.push({
      urls: config.turnUrls,
      username: config.turnUsername,
      credential: config.turnCredential,
    });
  }

  res.json({
    stunUrls: config.stunUrls,
    turnConfigured: turnState.turnConfigured,
    turnMisconfigured: turnState.turnMisconfigured,
    turnStatus: turnState.turnStatus,
    turnUrls: turnState.turnConfigured ? config.turnUrls : [],
    iceServers,
    ...capability,
    publicEntry,
  });
});
```

- [ ] **Step 4: Export a minimal shared ingestion helper and add HTTP diagnostics fallback endpoint**

```js
// signal-server/websocket/signaling.js
function ingestDiagnosticPayload({ role, viewerId, userAgent, data, hostSocket }) {
  if (role !== 'viewer') {
    return { accepted: false, error: 'viewer-only' };
  }

  const redacted = redactDiagnosticPayload(data || {});
  const connectionAttemptId = redacted.connectionAttemptId || `attempt-${Date.now()}`;
  const report = {
    receivedAt: new Date().toISOString(),
    viewerId,
    userAgent,
    connectionAttemptId,
    type: redacted.type || 'diagnostic',
    traceSummary: redacted.traceSummary || null,
    recommendation: redacted.recommendation || null,
    events: redacted.events || [],
    network: redacted.network || null,
    logs: redacted.logs || [],
  };

  persistDiagnostic(`${Date.now()}_${viewerId}.json`, report);
  if (hostSocket) {
    hostSocket.emit('diagnostic', report);
  }
  return { accepted: true, connectionAttemptId };
}

module.exports = {
  setupSignaling,
  connections,
  getConnectionStatus,
  ingestDiagnosticPayload,
};
```

```js
// signal-server/server.js
const { ingestDiagnosticPayload, connections } = require('./websocket/signaling');

app.post('/api/diagnostics', requireAccessToken, (req, res) => {
  const viewerId = `http-${req.user.sub}`;
  const result = ingestDiagnosticPayload({
    role: 'viewer',
    viewerId,
    userAgent: req.headers['user-agent'] || 'unknown',
    data: req.body,
    hostSocket: connections.host,
  });

  if (!result.accepted) {
    return res.status(400).json({ accepted: false, error: result.error });
  }

  return res.status(202).json({
    accepted: true,
    connectionAttemptId: result.connectionAttemptId,
  });
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
node --test signal-server/test/config.test.js signal-server/test/diagnostic.test.js
```

Expected:

```text
# pass  ...
# fail 0
```

- [ ] **Step 6: Commit**

```bash
git add signal-server/lib/config.js signal-server/server.js signal-server/websocket/signaling.js signal-server/test/config.test.js signal-server/test/diagnostic.test.js
git commit -m "feat: add public entry and diagnostics capability contract"
```

---

### Task 2: Make frontend mode UX recommendation-only and fixed-domain aware

**Files:**
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/js/ui.js`
- Modify: `web-client/css/viewer.css`
- Test: `web-client/js/webrtc.test.js`

- [ ] **Step 1: Write failing tests for manual fallback guidance**

```js
// web-client/js/webrtc.test.js
test('auto failure with TURN configured suggests relay without switching mode', () => {
  WebRTC.networkMode = 'auto';
  WebRTC.serverConfig = {
    turnConfigured: true,
    publicEntry: { formalEntryUrl: 'https://link.stockhub.wiki' },
  };
  WebRTC.recommendationState = null;

  WebRTC.handleTerminalFailure('direct-failed-suggest-relay');

  assert.equal(WebRTC.networkMode, 'auto');
  assert.deepEqual(WebRTC.recommendationState, {
    failureCode: 'direct-failed-suggest-relay',
    nextSuggestedMode: 'relay',
  });
});

test('relay without TURN stays relay and shows unavailable guidance instead of forcing tunnel', () => {
  WebRTC.serverConfig = { turnConfigured: false };
  WebRTC.setNetworkMode('relay');

  assert.equal(WebRTC.networkMode, 'relay');
  assert.match(lastNetworkMessage, /TURN.*不可用|建议切换到隧道中继/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test web-client/js/webrtc.test.js
```

Expected:

```text
FAIL handleTerminalFailure is not a function
FAIL relay mode without TURN switches to tunnel mode explicitly
```

- [ ] **Step 3: Add recommendation state and stop forced mode rewrites**

```js
// web-client/js/webrtc.js
recommendationState: null,

handleTerminalFailure(failureCode) {
  const nextSuggestedMode = failureCode === 'direct-failed-suggest-relay'
    ? 'relay'
    : failureCode === 'turn-failed-suggest-tunnel'
      ? 'tunnel'
      : null;

  this.recommendationState = {
    failureCode,
    nextSuggestedMode,
  };

  this.updateNetworkUI(this.getFailureMessage(failureCode), 'danger');
},

enforceSupportedNetworkMode(preferredMode = this.networkMode) {
  this.networkMode = preferredMode;
  localStorage.setItem('wrdNetworkMode', preferredMode);
  if (preferredMode === 'relay' && !this.hasTurnConfigured()) {
    return {
      effectiveMode: preferredMode,
      changed: false,
      reason: '当前未配置 TURN；可先尝试当前模式，或手动切换到最终兜底 tunnel。',
    };
  }
  return { effectiveMode: preferredMode, changed: false, reason: '' };
},
```

- [ ] **Step 4: Render fixed-domain-first status card and recommendation action**

```js
// web-client/js/ui.js
renderConnectionRecommendation(state = {}) {
  const entryEl = document.getElementById('entrypointDisplay');
  const modeEl = document.getElementById('networkModeDisplay');
  const actionBtn = document.getElementById('recommendedModeBtn');

  if (entryEl) {
    entryEl.textContent = WebRTC.serverConfig?.publicEntry?.formalEntryUrl || window.location.origin;
  }
  if (modeEl) {
    modeEl.textContent = WebRTC.networkModes[WebRTC.networkMode]?.label || WebRTC.networkMode;
  }
  if (actionBtn) {
    const suggested = state.nextSuggestedMode;
    actionBtn.hidden = !suggested;
    actionBtn.textContent = suggested ? `切换到 ${WebRTC.networkModes[suggested].label}` : '';
    actionBtn.onclick = () => suggested && WebRTC.setNetworkMode(suggested);
  }
}
```

```css
/* web-client/css/viewer.css */
.connection-status-card {
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(12, 15, 18, 0.74);
}

.connection-status-card[data-severity="danger"] {
  border-color: rgba(255, 96, 96, 0.8);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
node --test web-client/js/webrtc.test.js
```

Expected:

```text
# pass ...
# fail 0
```

- [ ] **Step 6: Commit**

```bash
git add web-client/js/webrtc.js web-client/js/ui.js web-client/css/viewer.css web-client/js/webrtc.test.js
git commit -m "feat: add manual media fallback guidance"
```

---

### Task 3: Make diagnostics attempt-centric and always uploadable

**Files:**
- Modify: `web-client/js/diagnostic.js`
- Modify: `web-client/js/webrtc.js`
- Modify: `signal-server/lib/diagnostic.js`
- Modify: `signal-server/websocket/signaling.js`
- Test: `web-client/js/diagnostic.test.js`
- Test: `signal-server/websocket/signaling.test.js`

- [ ] **Step 1: Write failing tests for attempt-centric diagnostics**

```js
// web-client/js/diagnostic.test.js
test('sendConnectionDiagnostic posts connectionAttemptId and suggested mode when socket is unavailable', async () => {
  global.fetch = async (_url, options) => ({
    ok: true,
    json: async () => ({}),
    options,
  });

  const ok = await Diagnostic.sendConnectionDiagnostic({
    type: 'connection-diagnostic',
    connectionAttemptId: 'attempt-42',
    traceSummary: { reason: 'direct-failed-suggest-relay' },
    recommendation: { nextSuggestedMode: 'relay' },
  });

  assert.equal(ok, true);
  assert.match(lastFetchBody, /"connectionAttemptId":"attempt-42"/);
  assert.match(lastFetchBody, /"nextSuggestedMode":"relay"/);
});
```

```js
// signal-server/websocket/signaling.test.js
test('diagnostic relay persists connectionAttemptId and failure code', () => {
  viewer.trigger('diagnostic', {
    type: 'connection-diagnostic',
    connectionAttemptId: 'attempt-socket-1',
    traceSummary: { reason: 'turn-failed-suggest-tunnel' },
    recommendation: { nextSuggestedMode: 'tunnel' },
    events: [{ kind: 'ice-state', value: 'failed' }],
  });

  const emitted = host.sent.find((entry) => entry.event === 'diagnostic');
  assert.equal(emitted.data.connectionAttemptId, 'attempt-socket-1');
  assert.equal(emitted.data.traceSummary.reason, 'turn-failed-suggest-tunnel');
  assert.equal(emitted.data.recommendation.nextSuggestedMode, 'tunnel');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test web-client/js/diagnostic.test.js signal-server/websocket/signaling.test.js
```

Expected:

```text
FAIL missing recommendation or connectionAttemptId in diagnostic payload
```

- [ ] **Step 3: Introduce a shared ingestion helper on the server**

```js
// signal-server/websocket/signaling.js
// Extend the helper introduced in Task 1 so both Socket.IO and HTTP diagnostics
// produce the same attempt-centric report shape and persistence behavior.
function ingestDiagnosticPayload({ role, viewerId, userAgent, data, hostSocket }) {
  if (role !== 'viewer') {
    return { accepted: false, error: 'viewer-only' };
  }

  const redacted = redactDiagnosticPayload(data || {});
  const connectionAttemptId = redacted.connectionAttemptId || `attempt-${Date.now()}`;
  const report = {
    receivedAt: new Date().toISOString(),
    viewerId,
    userAgent,
    connectionAttemptId,
    type: redacted.type || 'diagnostic',
    mode: redacted.mode || null,
    entrypoint: redacted.entrypoint || null,
    traceSummary: redacted.traceSummary || null,
    recommendation: redacted.recommendation || null,
    events: redacted.events || [],
    probeResults: redacted.probeResults || [],
    adaptiveMedia: redacted.adaptiveMedia || null,
    network: redacted.network || null,
    logs: redacted.logs || [],
  };

  persistDiagnostic(`${Date.now()}_${viewerId}.json`, report);
  if (hostSocket) {
    hostSocket.emit('diagnostic', report);
  }

  return { accepted: true, connectionAttemptId };
}
```

- [ ] **Step 4: Make frontend diagnostics always include recommendation and attempt metadata**

```js
// web-client/js/diagnostic.js
buildConnectionDiagnostic(meta = {}) {
  const recommendation = (typeof WebRTC !== 'undefined' && WebRTC.recommendationState)
    ? { ...WebRTC.recommendationState }
    : null;

  return {
    type: 'connection-diagnostic',
    schemaVersion: 3,
    connectionAttemptId: basePayload.connectionAttemptId || `wrd-${Date.now()}`,
    entrypoint: WebRTC?.serverConfig?.publicEntry?.formalEntryUrl || window.location.origin,
    mode: WebRTC?.networkMode || null,
    recommendation,
    events: redactedEvents,
    probeResults: Array.isArray(basePayload.probeResults) ? basePayload.probeResults.slice() : [],
    traceSummary: {
      ...(basePayload.traceSummary || {}),
      trigger: meta.trigger || 'manual',
      reason: meta.reason || null,
    },
  };
}
```

```js
// web-client/js/webrtc.js
beginConnectionAttempt(trigger = 'viewer-open') {
  this._offerEpoch = 0;
  this.recommendationState = null;
  if (typeof ConnectionTrace !== 'undefined' && typeof ConnectionTrace.start === 'function') {
    ConnectionTrace.start({
      trigger,
      mode: this.networkMode,
      entrypoint: this.serverConfig?.publicEntry?.formalEntryUrl || window.location.origin,
    });
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
node --test web-client/js/diagnostic.test.js signal-server/websocket/signaling.test.js
```

Expected:

```text
# pass ...
# fail 0
```

- [ ] **Step 6: Commit**

```bash
git add web-client/js/diagnostic.js web-client/js/webrtc.js signal-server/lib/diagnostic.js signal-server/websocket/signaling.js web-client/js/diagnostic.test.js signal-server/websocket/signaling.test.js
git commit -m "feat: persist attempt-centric connection diagnostics"
```

---

### Task 4: Add admin summaries for operators

**Files:**
- Modify: `signal-server/lib/diagnostic.js`
- Modify: `signal-server/server.js`
- Test: `signal-server/test/diagnostic.test.js`

- [ ] **Step 1: Write failing tests for summary endpoints**

```js
// signal-server/test/diagnostic.test.js
test('GET /api/admin/connection-summary returns recent failure buckets', async () => {
  fs.rmSync(getDiagDir(), { recursive: true, force: true });
  persistDiagnostic('summary-1.json', {
    connectionAttemptId: 'attempt-summary-1',
    traceSummary: { reason: 'direct-failed-suggest-relay' },
    recommendation: { nextSuggestedMode: 'relay' },
    mode: 'auto',
  });

  const { baseUrl, closeServer } = await startServer();
  try {
    const response = await fetch(baseUrl + '/api/admin/connection-summary', {
      headers: {
        Authorization: `Bearer ${signAccessToken('admin', 'diag-admin')}`,
      },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.failures['direct-failed-suggest-relay'], 1);
  } finally {
    await closeServer();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test signal-server/test/diagnostic.test.js
```

Expected:

```text
FAIL GET /api/admin/connection-summary returns 404
```

- [ ] **Step 3: Add summary readers and admin endpoints**

```js
// signal-server/lib/diagnostic.js
function loadRecentDiagnostics(limit = 50) {
  return fs.readdirSync(getDiagDir())
    .filter((name) => name.endsWith('.json'))
    .sort()
    .slice(-limit)
    .map((name) => JSON.parse(fs.readFileSync(path.join(getDiagDir(), name), 'utf8')));
}

function buildConnectionSummary(items) {
  return items.reduce((acc, item) => {
    const reason = item.traceSummary?.reason || 'unknown';
    acc.failures[reason] = (acc.failures[reason] || 0) + 1;
    return acc;
  }, { failures: {}, total: items.length });
}
```

```js
// signal-server/server.js
const { loadRecentDiagnostics, buildConnectionSummary } = require('./lib/diagnostic');

app.get('/api/admin/connection-summary', requireAccessToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required' });
  }
  const items = loadRecentDiagnostics(50);
  return res.json(buildConnectionSummary(items));
});

app.get('/api/admin/connection-attempts', requireAccessToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required' });
  }
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
  return res.json({ items: loadRecentDiagnostics(limit) });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
node --test signal-server/test/diagnostic.test.js
```

Expected:

```text
# pass ...
# fail 0
```

- [ ] **Step 5: Commit**

```bash
git add signal-server/lib/diagnostic.js signal-server/server.js signal-server/test/diagnostic.test.js
git commit -m "feat: add connection diagnostics summary endpoints"
```

---

### Task 5: Demote quick tunnel to debug-only and promote fixed-domain truth

**Files:**
- Modify: `README.md`
- Modify: `docs/runbook-safe-startup.md`
- Modify: `docs/superpowers/deploy/README.md`
- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md`
- Modify: `scripts/status-safe-wrd.sh`
- Modify: `scripts/start-safe-wrd.sh`
- Test: `scripts/status-safe-wrd.test.js`
- Test: `scripts/start-safe-wrd.test.js`

- [ ] **Step 1: Write failing tests for fixed-domain-first status output**

```js
// scripts/status-safe-wrd.test.js
test('status script labels quick tunnel as debug-only and fixed domain as formal entry', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.match(source, /formal public entry.*link\.stockhub\.wiki/i);
  assert.match(source, /quick tunnel.*debug/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test scripts/status-safe-wrd.test.js scripts/start-safe-wrd.test.js
```

Expected:

```text
FAIL formal public entry text missing
```

- [ ] **Step 3: Update scripts to report fixed-domain truth first**

```bash
# scripts/status-safe-wrd.sh
echo 'formal public entry: https://link.stockhub.wiki'
echo 'quick tunnel: debug-only, do not share as the formal user entrypoint'
```

```bash
# scripts/start-safe-wrd.sh
echo 'formal public entry: https://link.stockhub.wiki'
echo "debug quick tunnel url: $(cat "$SAFE_URL_FILE")"
```

- [ ] **Step 4: Update docs to remove quick tunnel as user-facing default**

```md
<!-- README.md / docs/runbook-safe-startup.md / deploy README -->
- 正式公网入口：`https://link.stockhub.wiki`
- quick tunnel 仅用于调试与临时排障，不再作为长期正式入口
- 用户不应保存或依赖 `trycloudflare` URL
```

```md
<!-- docs/需求文档/WebRemoteDesktop-需求文档.md -->
- 跨网络正式访问统一使用 `link.stockhub.wiki`
- quick tunnel 为调试链路，不作为正式交付地址
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
node --test scripts/status-safe-wrd.test.js scripts/start-safe-wrd.test.js
```

Expected:

```text
# pass ...
# fail 0
```

- [ ] **Step 6: Commit**

```bash
git add README.md docs/runbook-safe-startup.md docs/superpowers/deploy/README.md docs/需求文档/WebRemoteDesktop-需求文档.md scripts/status-safe-wrd.sh scripts/start-safe-wrd.sh scripts/status-safe-wrd.test.js scripts/start-safe-wrd.test.js
git commit -m "docs: promote fixed domain as the formal public entry"
```

---

### Task 6: Runtime proof and final verification

**Files:**
- Modify: `README.md`
- Modify: `docs/runbook-safe-startup.md`
- Test: existing suites only

- [ ] **Step 1: Run focused automated tests**

Run:

```bash
node --test \
  signal-server/test/config.test.js \
  signal-server/test/diagnostic.test.js \
  signal-server/websocket/signaling.test.js \
  web-client/js/webrtc.test.js \
  web-client/js/diagnostic.test.js \
  scripts/status-safe-wrd.test.js \
  scripts/start-safe-wrd.test.js
```

Expected:

```text
# fail 0
```

- [ ] **Step 2: Verify runtime config and public entry contract locally**

Run:

```bash
curl -sS http://127.0.0.1:8080/api/webrtc-config -H "Authorization: Bearer <viewer-token>" | jq
```

Expected excerpt:

```json
{
  "recommendedMode": "auto",
  "manualFallbackChain": ["auto", "relay", "tunnel"],
  "publicEntry": {
    "formalEntryUrl": "https://link.stockhub.wiki",
    "formalEntryMode": "fixed-domain",
    "quickTunnelRecommended": false
  }
}
```

- [ ] **Step 3: Verify diagnostics fallback without Socket.IO**

Run:

```bash
curl -sS -X POST http://127.0.0.1:8080/api/diagnostics \
  -H "Authorization: Bearer <viewer-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "type":"connection-diagnostic",
    "connectionAttemptId":"attempt-runtime-1",
    "mode":"relay",
    "traceSummary":{"trigger":"manual","reason":"turn-failed-suggest-tunnel"},
    "recommendation":{"nextSuggestedMode":"tunnel"},
    "events":[{"kind":"ice-state","value":"failed"}]
  }'
```

Expected:

```json
{
  "accepted": true,
  "connectionAttemptId": "attempt-runtime-1"
}
```

- [ ] **Step 4: Verify persisted diagnostic and admin summary**

Run:

```bash
curl -sS http://127.0.0.1:8080/api/admin/connection-summary -H "Authorization: Bearer <admin-token>" | jq
curl -sS http://127.0.0.1:8080/api/admin/connection-attempts?limit=5 -H "Authorization: Bearer <admin-token>" | jq
```

Expected excerpt:

```json
{
  "failures": {
    "turn-failed-suggest-tunnel": 1
  }
}
```

- [ ] **Step 5: Verify fixed-domain-first operator messaging**

Run:

```bash
./scripts/status-safe-wrd.sh
curl -I -L --max-time 15 https://link.stockhub.wiki
```

Expected excerpt:

```text
formal public entry: https://link.stockhub.wiki
quick tunnel: debug-only
HTTP/2 200
```

- [ ] **Step 6: Commit final doc/runtime proof updates**

```bash
git add README.md docs/runbook-safe-startup.md
git commit -m "docs: finalize runtime proof for single public entry flow"
```

---

## Self-Review

### Spec completion

- Single public entrypoint: covered by Task 1 and Task 5
- Manual media fallback chain: covered by Task 2
- Structured diagnostics and proactive upload: covered by Task 1 and Task 3
- Operator summaries: covered by Task 4
- Runtime proof and doc sync: covered by Task 5 and Task 6

No approved spec section is left without a concrete task.

### Architecture review checklist

- Entry truth is centralized in backend config + docs; quick tunnel is explicitly downgraded to debug-only instead of silently coexisting as a second formal source of truth.
- Media fallback rules stay in `web-client/js/webrtc.js`; `ui.js` only renders state and actions, so the plan avoids duplicating mode rules across UI and network code.
- Diagnostics use one `connectionAttemptId` end-to-end rather than separate ad hoc browser logs and server logs.
- The existing backend/frontend mismatch is fixed directly: frontend already has `POST /api/diagnostics` fallback code, and the plan adds the missing backend endpoint instead of adding a second fallback layer.

### Impact map completeness

Header includes Truth Source, Backend, Frontend, Runtime Proof, Docs/Skills, and Commit Boundary with explicit scopes.

### Definition of Done audit

- Formal entrypoint proof is verifiable via docs and `status-safe-wrd.sh` output.
- Manual mode control is verifiable through frontend tests and runtime behavior.
- Server-side structured diagnostics are verifiable via HTTP upload response, persisted JSON, and summary endpoints.

### Placeholder scan

No `TBD`, `TODO`, or deferred placeholders remain in tasks.

### Type consistency

- Uses `connectionAttemptId`, `recommendedMode`, `manualFallbackChain`, `traceSummary`, and `recommendation.nextSuggestedMode` consistently across frontend and backend tasks.

### Docs and commit boundary

- README, runbook, deploy README, and demand doc are explicitly updated.
- Commit boundaries are split by capability contract, frontend mode UX, diagnostics, and entrypoint docs/scripts rather than one unrelated mega-commit.
