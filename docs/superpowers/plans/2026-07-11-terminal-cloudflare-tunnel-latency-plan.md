# Terminal Cloudflare Tunnel Latency and Reachability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make terminal-over-Cloudflare-Tunnel latency and availability diagnosable end to end without changing the public transport boundary, while removing auth and quick-tunnel false positives that currently pollute user perception.

**Architecture:** Keep Terminal on the existing Socket.IO-over-Cloudflare-Tunnel path, but tighten the truth sources around it. Frontend latency metrics must use one clock domain at a time, signal-server must expose an admin-only summary that fuses terminal state with sanitized cloudflared edge metrics, and safe tunnel scripts must validate deliverable WRD entrypoints instead of treating any HTTP response as success.

**Tech Stack:** Node.js, Express, Socket.IO, xterm.js, Bash, Cloudflare Tunnel metrics, Node test runner, Markdown docs

**Spec Coverage:** Full approved spec coverage. This plan covers terminal latency semantics, admin tunnel summary, auth limiter isolation, quick tunnel reachability correctness, cloudflared experiment procedure, runtime proof, and doc updates. It does not move Terminal off Cloudflare Tunnel and does not change the shared terminal authorization model.

**Truth Source:** `web-client/js/terminal.js` defines browser-side RTT semantics; `signal-server/websocket/terminal.js` defines server-timestamp payload semantics; `signal-server/lib/cloudflared-metrics.js` becomes the canonical parser for sanitized tunnel-edge truth; `scripts/lib-safe-wrd.sh` becomes the canonical quick-tunnel reachability judge.

**Compatibility Notes:** Existing shared-session terminal events (`terminal:replay`, `terminal:presence`, `terminal:pool_snapshot`, bootstrap) remain intact. Existing `terminal:pong` and `terminal:input_ack` payload fields remain backward-compatible, but the frontend stops treating cross-clock subtraction as RTT truth. New admin summary endpoints are additive. Quick tunnel policy still forbids automatic tunnel rebuild without explicit user instruction.

**Impact Map:**
- **Truth Source:** Browser-local RTT, server-local processing time, cloudflared local metrics summary, and WRD-specific tunnel reachability checks become authoritative.
- **Backend:** `signal-server/server.js`, terminal websocket handlers, new cloudflared metrics parser, and auth limiter wiring.
- **Frontend:** `web-client/js/terminal.js` diagnostic state and status wording; optional admin diagnostic consumer if present.
- **Runtime Proof:** Targeted unit tests, local/public terminal samples, `/api/admin/terminal-summary`, `/api/auth/verify` sustained access without accidental `429`, and quick-tunnel status showing `entry-invalid` instead of false `ok`.
- **Docs/Skills:** `README.md`, `docs/runbook-safe-startup.md`, and `docs/superpowers/reports/2026-07-11-terminal-performance-analysis.md`.
- **Commit Boundary:** One focused batch for terminal latency truth, tunnel observability, auth limiter isolation, and safe-tunnel reachability. No media-path, shared-session semantics, or tunnel lifecycle-policy changes belong in this batch.

**Definition of Done:**
- Terminal RTT and input-ack metrics are measured without mixing browser and server wall clocks, and tests prove the new semantics.
- Admins can retrieve sanitized terminal/tunnel summaries, including edge location and smoothed RTT, without exposing raw cloudflared metrics to viewers.
- `/api/auth/verify` no longer shares the same limiter budget as password login, and quick tunnel URLs that only return `404` or a non-WRD page no longer appear as `ok`.

---

## File Structure

### Canonical truth and responsibility map

- `web-client/js/terminal.js`
  - Canonical browser-side terminal RTT and diagnostic-state computation
- `web-client/js/terminal.test.js`
  - Canonical regression tests for terminal UI metric semantics
- `signal-server/websocket/terminal.js`
  - Canonical terminal socket event payload definitions
- `signal-server/websocket/terminal.test.js`
  - Canonical regression tests for ping/input-ack payload behavior
- `signal-server/lib/cloudflared-metrics.js`
  - Canonical parser and summarizer for local cloudflared metrics endpoints
- `signal-server/test/cloudflared-metrics.test.js`
  - Canonical regression tests for sanitized tunnel metrics summary
- `signal-server/server.js`
  - Canonical HTTP wiring for auth limiters and admin summary endpoints
- `signal-server/lib/auth-rate-limit.js`
  - Canonical source for per-route auth limiter policy
- `signal-server/routes/auth.js`
  - Canonical route-level application of the split auth limiter buckets
- `signal-server/test/auth.test.js`
  - Canonical functional tests for auth routes and limiter isolation
- `scripts/lib-safe-wrd.sh`
  - Canonical application-specific quick-tunnel reachability logic
- `scripts/run-safe-quicktunnel.sh`
  - Canonical safe-URL publish path that must enforce WRD deliverability
- `scripts/status-safe-wrd.sh`
  - Canonical operator-facing status output for quick-tunnel health
- `scripts/lib-safe-wrd.test.js`
  - Canonical reachability-state regression tests
- `README.md`
  - Canonical operator summary for terminal/public-entry behavior
- `docs/runbook-safe-startup.md`
  - Canonical safe-start and diagnosis truth
- `docs/superpowers/reports/2026-07-11-terminal-performance-analysis.md`
  - Canonical evidence report updated with accepted metric semantics and experiment outcomes

### Compatibility boundary

- Terminal stays on Cloudflare Tunnel for public access
- Shared session semantics are preserved
- `/api/auth/verify` stays authenticated and rate-limited, but with its own policy bucket
- Safe tunnel scripts keep the “report only, do not auto-rebuild” lifecycle rule

---

### Task 1: Fix terminal latency semantics in the browser and websocket contract

**Files:**
- Modify: `web-client/js/terminal.js`
- Modify: `web-client/js/terminal.test.js`
- Modify: `signal-server/websocket/terminal.js`
- Modify: `signal-server/websocket/terminal.test.js`

- [ ] **Step 1: Write the failing frontend tests for single-clock RTT semantics**

```js
// web-client/js/terminal.test.js
test('TerminalPanel records input ack latency from browser send to browser receive', () => {
  const {
    TerminalPanel,
    fakeSocket,
    socketHandlers,
    sessionStorageMap,
    tokenKey,
    emitted,
  } = loadTerminal();

  sessionStorageMap.set(tokenKey, 'terminal-admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;

  try {
    TerminalPanel.pendingInputAcks.set('ack-1', { clientSentAt: 1_000 });
    now = 1_155;
    socketHandlers.get('terminal:input_ack')({
      sessionId: 'term-1',
      inputId: 'ack-1',
      clientSentAt: 1_000,
      serverReceivedAt: 1_120,
      serverSentAt: 1_121,
      transport: 'websocket',
    });

    const diagnostic = TerminalPanel.getDiagnosticState();
    assert.equal(diagnostic.inputAck.last, 155);
    assert.equal(diagnostic.serverAckProcessing.last, 1);
  } finally {
    Date.now = originalNow;
  }
});

test('TerminalPanel records socket pong RTT from browser send to browser receive', () => {
  const { TerminalPanel } = loadTerminal();

  TerminalPanel.pendingLatencyProbes.set('ping-1', 2_000);
  const originalNow = Date.now;
  Date.now = () => 2_240;

  try {
    TerminalPanel.handleLatencyPong({
      nonce: 'ping-1',
      clientSentAt: 2_000,
      serverReceivedAt: 2_180,
      serverSentAt: 2_181,
      transport: 'websocket',
    });

    const diagnostic = TerminalPanel.getDiagnosticState();
    assert.equal(diagnostic.socketRtt.last, 240);
  } finally {
    Date.now = originalNow;
  }
});
```

- [ ] **Step 2: Run the focused frontend test and verify it fails under the old mixed-clock behavior**

Run:

```bash
node --test web-client/js/terminal.test.js
```

Expected:

```text
not ok - TerminalPanel records input ack latency from browser send to browser receive
Expected diagnostic.inputAck.last to equal browser RTT, got serverReceivedAt - clientSentAt
```

- [ ] **Step 3: Implement separate browser RTT and server processing metrics**

```js
// web-client/js/terminal.js
handleLatencyPong(payload = {}) {
  const nonce = typeof payload.nonce === 'string' ? payload.nonce : '';
  const sentAt = this.pendingLatencyProbes.get(nonce);
  if (nonce) this.pendingLatencyProbes.delete(nonce);
  if (!Number.isFinite(sentAt)) return;

  const receivedAt = Date.now();
  this.transportName = String(payload.transport || this.getTransportName());
  this.terminalSocketLatency.record(receivedAt - sentAt);

  const serverReceivedAt = Number(payload.serverReceivedAt);
  const serverSentAt = Number(payload.serverSentAt);
  if (Number.isFinite(serverReceivedAt) && Number.isFinite(serverSentAt)) {
    this.terminalServerPingProcessing.record(Math.max(0, serverSentAt - serverReceivedAt));
  }
  this.refreshStatus();
}

handleInputAck(payload = {}) {
  const inputId = typeof payload.inputId === 'string' ? payload.inputId : '';
  const pending = inputId ? this.pendingInputAcks.get(inputId) : null;
  if (inputId) this.pendingInputAcks.delete(inputId);
  if (!Number.isFinite(pending?.clientSentAt)) return;

  const receivedAt = Date.now();
  this.transportName = String(payload.transport || this.getTransportName());
  this.terminalInputAckLatency.record(receivedAt - pending.clientSentAt);

  const serverReceivedAt = Number(payload.serverReceivedAt);
  const serverSentAt = Number(payload.serverSentAt);
  if (Number.isFinite(serverReceivedAt) && Number.isFinite(serverSentAt)) {
    this.terminalServerAckProcessing.record(Math.max(0, serverSentAt - serverReceivedAt));
  }
  this.refreshStatus();
}

getDiagnosticState() {
  return {
    transport: this.getTransportName(),
    socketState: this.socketState,
    socketRtt: this.terminalSocketLatency.snapshot(),
    inputAck: this.terminalInputAckLatency.snapshot(),
    serverAckProcessing: this.terminalServerAckProcessing.snapshot(),
  };
}
```

- [ ] **Step 4: Lock the websocket payload test around backward-compatible timestamps**

```js
// signal-server/websocket/terminal.test.js
test('terminal ping and input ack payloads preserve server timestamps for processing summaries', () => {
  const { adminA } = createHarness();

  adminA.trigger('terminal:ping', { nonce: 'p1', clientSentAt: 10 });
  const pong = adminA.sent.find((message) => message.event === 'terminal:pong');
  assert.equal(typeof pong.data.serverReceivedAt, 'number');
  assert.equal(typeof pong.data.serverSentAt, 'number');

  adminA.trigger('terminal:input', {
    sessionId: 'missing',
    inputId: 'i1',
    clientSentAt: 20,
    data: 'pwd',
  });
  const terminalError = adminA.sent.find((message) => message.event === 'terminal:error');
  assert.equal(terminalError.data.code, 'terminal_session_not_found');
});
```

- [ ] **Step 5: Re-run the focused frontend and websocket tests and verify they pass**

Run:

```bash
node --test web-client/js/terminal.test.js
node --test signal-server/websocket/terminal.test.js
```

Expected:

```text
ok - TerminalPanel records input ack latency from browser send to browser receive
ok - TerminalPanel records socket pong RTT from browser send to browser receive
ok - terminal ping and input ack payloads preserve server timestamps for processing summaries
```

- [ ] **Step 6: Commit**

```bash
git add web-client/js/terminal.js web-client/js/terminal.test.js signal-server/websocket/terminal.js signal-server/websocket/terminal.test.js
git commit -m "fix: correct terminal latency metric semantics"
```

---

### Task 2: Add a sanitized admin terminal summary with cloudflared edge metrics

**Files:**
- Create: `signal-server/lib/cloudflared-metrics.js`
- Create: `signal-server/test/cloudflared-metrics.test.js`
- Modify: `signal-server/lib/config.js`
- Modify: `signal-server/server.js`
- Modify: `signal-server/test/terminal-bootstrap.test.js`

- [ ] **Step 1: Write the failing parser tests for local cloudflared metrics summarization**

```js
// signal-server/test/cloudflared-metrics.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const { summarizeCloudflaredMetrics } = require('../lib/cloudflared-metrics');

test('summarizeCloudflaredMetrics extracts edge locations and smoothed RTTs', () => {
  const summary = summarizeCloudflaredMetrics(`
cloudflared_tunnel_ha_connections 4
cloudflared_tunnel_server_locations{connection_id="0",edge_location="lax01"} 1
cloudflared_tunnel_server_locations{connection_id="1",edge_location="lax09"} 1
quic_client_smoothed_rtt{conn_index="0"} 183
quic_client_smoothed_rtt{conn_index="1"} 196
`);

  assert.deepEqual(summary.edgeLocations, ['lax01', 'lax09']);
  assert.deepEqual(summary.smoothedRttsMs, [183, 196]);
  assert.equal(summary.haConnections, 4);
});

test('summarizeCloudflaredMetrics never exposes raw metric text', () => {
  const summary = summarizeCloudflaredMetrics('cloudflared_tunnel_server_locations{edge_location="lax01"} 1');
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'raw'), false);
});
```

- [ ] **Step 2: Run the parser test and verify it fails before the helper exists**

Run:

```bash
node --test signal-server/test/cloudflared-metrics.test.js
```

Expected:

```text
not ok - summarizeCloudflaredMetrics extracts edge locations and smoothed RTTs
Cannot find module '../lib/cloudflared-metrics'
```

- [ ] **Step 3: Implement the local parser and config wiring**

```js
// signal-server/lib/cloudflared-metrics.js
function summarizeCloudflaredMetrics(source = '') {
  const text = String(source || '');
  const edgeLocations = [...text.matchAll(/edge_location="([^"]+)"/g)].map((match) => match[1]);
  const smoothedRttsMs = [...text.matchAll(/quic_client_smoothed_rtt\{[^}]*\}\s+(\d+(?:\.\d+)?)/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  const haMatch = text.match(/cloudflared_tunnel_ha_connections\s+(\d+(?:\.\d+)?)/);

  return {
    haConnections: haMatch ? Number(haMatch[1]) : 0,
    edgeLocations: [...new Set(edgeLocations)],
    smoothedRttsMs,
    smoothedRttP50Ms: smoothedRttsMs.sort((a, b) => a - b)[Math.floor(smoothedRttsMs.length / 2)] ?? null,
  };
}

async function fetchCloudflaredSummary(urls = {}, { fetchImpl = fetch } = {}) {
  const readOne = async (url) => {
    try {
      const response = await fetchImpl(url);
      if (!response.ok) {
        return { reachable: false, error: 'http_' + response.status };
      }
      return {
        reachable: true,
        ...summarizeCloudflaredMetrics(await response.text()),
      };
    } catch (error) {
      return {
        reachable: false,
        error: error?.message || 'fetch_failed',
      };
    }
  };

  return {
    named: await readOne(urls.namedUrl),
    quick: await readOne(urls.quickUrl),
    sampledAt: new Date().toISOString(),
  };
}

module.exports = { summarizeCloudflaredMetrics, fetchCloudflaredSummary };
```

```js
// signal-server/lib/config.js
cloudflaredMetrics: {
  namedUrl: process.env.WRD_NAMED_TUNNEL_METRICS_URL || 'http://127.0.0.1:20244/metrics',
  quickUrl: process.env.WRD_QUICK_TUNNEL_METRICS_URL || 'http://127.0.0.1:20242/metrics',
},
```

- [ ] **Step 4: Add an admin-only terminal summary endpoint that returns sanitized tunnel data**

```js
// signal-server/server.js
const { fetchCloudflaredSummary } = require('./lib/cloudflared-metrics');

app.get('/api/admin/terminal-summary', requireAccessToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required' });
  }

  const tunnel = await fetchCloudflaredSummary(config.cloudflaredMetrics, { fetchImpl: fetch });
  return res.json({
    enabled: config.enableTerminal,
    pool: terminal.sessionManager.getPoolSnapshot(),
    tunnel,
  });
});
```

- [ ] **Step 5: Extend the bootstrap/admin test surface and verify the new endpoint**

```js
// signal-server/test/terminal-bootstrap.test.js
test('/api/admin/terminal-summary rejects viewer tokens and returns sanitized tunnel summary for admins', async () => {
  await withServer(async ({ baseUrl }) => {
    const viewer = await fetch(baseUrl + '/api/admin/terminal-summary', {
      headers: { Authorization: `Bearer ${signAccessToken('viewer', 'viewer-summary-test')}` },
    });
    assert.equal(viewer.status, 403);

    const admin = await fetch(baseUrl + '/api/admin/terminal-summary', {
      headers: { Authorization: `Bearer ${signAccessToken('admin', 'admin-summary-test')}` },
    });
    assert.equal(admin.status, 200);
    const body = await admin.json();
    assert.equal(body.enabled, true);
    assert.equal(Array.isArray(body.tunnel.named.edgeLocations), true);
  });
});
```

- [ ] **Step 6: Re-run the parser and terminal admin tests and verify they pass**

Run:

```bash
node --test signal-server/test/cloudflared-metrics.test.js
node --test signal-server/test/terminal-bootstrap.test.js
```

Expected:

```text
ok - summarizeCloudflaredMetrics extracts edge locations and smoothed RTTs
ok - /api/admin/terminal-summary rejects viewer tokens and returns sanitized tunnel summary for admins
```

- [ ] **Step 7: Commit**

```bash
git add signal-server/lib/cloudflared-metrics.js signal-server/test/cloudflared-metrics.test.js signal-server/lib/config.js signal-server/server.js signal-server/test/terminal-bootstrap.test.js
git commit -m "feat: expose sanitized tunnel metrics in terminal admin summary"
```

---

### Task 3: Split auth rate limiting so `/verify` cannot consume the password-login budget

**Files:**
- Create: `signal-server/lib/auth-rate-limit.js`
- Modify: `signal-server/routes/auth.js`
- Modify: `signal-server/server.js`
- Modify: `signal-server/test/auth.test.js`

- [ ] **Step 1: Write the failing auth test that isolates `/verify` from password-login throttling**

```js
// signal-server/test/auth.test.js
test('/api/auth/verify remains available after repeated verify calls while login still enforces rate limits', async () => {
  await withServer(async (baseUrl) => {
    const login = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-viewer-password' }),
    });
    const { token } = await login.json();

    for (let index = 0; index < 25; index += 1) {
      const verify = await fetch(baseUrl + '/api/auth/verify', {
        headers: { authorization: 'Bearer ' + token },
      });
      assert.equal(verify.status, 200);
    }
  });
});
```

- [ ] **Step 2: Run the auth test and verify it fails under the shared `/api/auth` limiter**

Run:

```bash
node --test signal-server/test/auth.test.js
```

Expected:

```text
not ok - /api/auth/verify remains available after repeated verify calls while login still enforces rate limits
Expected 200, received 429 from shared /api/auth limiter
```

- [ ] **Step 3: Move limiter policy into a dedicated helper with separate buckets**

```js
// signal-server/lib/auth-rate-limit.js
const rateLimit = require('express-rate-limit');

function buildAuthRateLimiters() {
  return {
    viewerLogin: rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }),
    hostLogin: rateLimit({ windowMs: 5 * 60 * 1000, max: 60 }),
    verify: rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }),
  };
}

module.exports = { buildAuthRateLimiters };
```

```js
// signal-server/routes/auth.js
const passthrough = (_req, _res, next) => next();

function loginHost(req, res) {
  const { hostSharedSecret } = loadConfig();
  const secret = String(req.body?.secret || '');
  if (!secret) return res.status(400).json({ error: 'Host secret required' });
  if (secret !== hostSharedSecret) return res.status(401).json({ error: 'Invalid host secret' });
  return res.json({ token: signAccessToken('host', 'host-daemon'), role: 'host', expiresIn: '15m' });
}

function loginAdmin(req, res) {
  const { enableTerminal, terminalAdminPassword } = loadConfig();
  const password = String(req.body?.password || '');
  if (!enableTerminal) return res.status(403).json({ error: 'Terminal disabled' });
  if (!terminalAdminPassword) return res.status(500).json({ error: 'Terminal admin password not configured' });
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (password !== terminalAdminPassword) return res.status(401).json({ error: 'Invalid password' });
  return res.json({ token: signAccessToken('admin', 'terminal-admin-login'), role: 'admin', expiresIn: '2h' });
}

function verifyToken(req, res) {
  try {
    const token = readBearerToken(req.headers.authorization);
    if (!token) return res.status(401).json({ valid: false, error: 'No token provided' });
    const decoded = verifyAccessToken(token);
    return res.json({ valid: true, role: decoded.role });
  } catch (_err) {
    return res.status(401).json({ valid: false, error: 'Invalid token' });
  }
}

function createAuthRouter(limiters = {}) {
  const router = express.Router();

  router.post('/login', limiters.viewerLogin || passthrough, loginViewer);
  router.post('/login/viewer', limiters.viewerLogin || passthrough, loginViewer);
  router.post('/login/host', limiters.hostLogin || passthrough, loginHost);
  router.post('/login/admin', limiters.viewerLogin || passthrough, loginAdmin);
  router.get('/verify', limiters.verify || passthrough, verifyToken);

  return router;
}

module.exports = { createAuthRouter };
```

```js
// signal-server/test/auth.test.js
const { buildAuthRateLimiters } = require('../lib/auth-rate-limit');
const { createAuthRouter } = require('../routes/auth');

async function withServer(runTest) {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', createAuthRouter(buildAuthRateLimiters()));
  // keep the rest of the helper unchanged
}
```

```js
// signal-server/server.js
const { buildAuthRateLimiters } = require('./lib/auth-rate-limit');
const { createAuthRouter } = require('./routes/auth');

const authLimiters = buildAuthRateLimiters();
app.use('/api/auth', createAuthRouter(authLimiters));
```

- [ ] **Step 4: Re-run the auth test and verify `/verify` no longer trips the password-login bucket**

Run:

```bash
node --test signal-server/test/auth.test.js
```

Expected:

```text
ok - /api/auth/verify remains available after repeated verify calls while login still enforces rate limits
```

- [ ] **Step 5: Commit**

```bash
git add signal-server/lib/auth-rate-limit.js signal-server/routes/auth.js signal-server/server.js signal-server/test/auth.test.js
git commit -m "fix: isolate auth verify rate limiting from login"
```

---

### Task 4: Tighten quick-tunnel reachability so only deliverable WRD entrypoints publish as healthy

**Files:**
- Modify: `scripts/lib-safe-wrd.sh`
- Modify: `scripts/run-safe-quicktunnel.sh`
- Modify: `scripts/status-safe-wrd.sh`
- Modify: `scripts/lib-safe-wrd.test.js`
- Modify: `scripts/run-safe-quicktunnel.test.js`
- Modify: `scripts/status-safe-wrd.test.js`

- [ ] **Step 1: Write the failing shell-source tests for WRD-specific reachability states**

```js
// scripts/lib-safe-wrd.test.js
test('safe reachability helper distinguishes entry-invalid from origin-unreachable', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /health-failed/);
  assert.match(source, /entry-invalid/);
  assert.match(source, /wrd_safe_url_health_state/);
  assert.match(source, /wrd_safe_url_entry_state/);
});

// scripts/run-safe-quicktunnel.test.js
test('safe quick tunnel publish path validates both health endpoint and WRD entry page before writing URL', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /wrd_safe_url_health_state/);
  assert.match(source, /wrd_safe_url_entry_state/);
  assert.match(source, /do not publish quick tunnel URL when WRD entry validation fails/i);
});
```

- [ ] **Step 2: Run the script tests and verify they fail before the helper is expanded**

Run:

```bash
node --test scripts/lib-safe-wrd.test.js
node --test scripts/run-safe-quicktunnel.test.js
node --test scripts/status-safe-wrd.test.js
```

Expected:

```text
not ok - safe reachability helper distinguishes entry-invalid from origin-unreachable
not ok - safe quick tunnel publish path validates both health endpoint and WRD entry page before writing URL
```

- [ ] **Step 3: Add WRD-specific health and entry validators in the shared shell library**

```bash
# scripts/lib-safe-wrd.sh
wrd_safe_url_health_state() {
  local url="$1"
  curl -fsSL --max-time 10 "${url%/}/health" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'
}

wrd_safe_url_entry_state() {
  local url="$1"
  curl -fsSL --max-time 10 "$url" | grep -q 'terminalAuthForm\|remoteVideo\|viewer-container'
}

wrd_safe_url_reachability_state() {
  local url="$1"
  # keep existing DNS/origin classification first
  # then promote only WRD-deliverable states to reachable
  if ! wrd_safe_base_transport_state "$url"; then
    printf '%s\n' unreachable
    return 1
  fi
  if ! wrd_safe_url_health_state "$url"; then
    printf '%s\n' health-failed
    return 1
  fi
  if ! wrd_safe_url_entry_state "$url"; then
    printf '%s\n' entry-invalid
    return 1
  fi
  printf '%s\n' reachable
}
```

- [ ] **Step 4: Make publish/status scripts enforce the richer reachability result**

```bash
# scripts/run-safe-quicktunnel.sh
state=$(wrd_safe_url_reachability_state "$PUBLIC_URL" || true)
if [ "$state" != "reachable" ]; then
  echo "do not publish quick tunnel URL when WRD entry validation fails: $state" >&2
  exit 1
fi
```

```bash
# scripts/status-safe-wrd.sh
case "$SAFE_URL_STATE" in
  reachable) echo 'safe url reachability: ok' ;;
  dns-unresolved) echo 'safe url reachability: dns-unresolved' ;;
  origin-unreachable) echo 'safe url reachability: origin-unreachable' ;;
  health-failed) echo 'safe url reachability: health-failed' ;;
  entry-invalid) echo 'safe url reachability: entry-invalid' ;;
  *) echo 'safe url reachability: unreachable' ;;
esac
```

- [ ] **Step 5: Re-run the script tests and verify they pass**

Run:

```bash
node --test scripts/lib-safe-wrd.test.js
node --test scripts/run-safe-quicktunnel.test.js
node --test scripts/status-safe-wrd.test.js
```

Expected:

```text
ok - safe reachability helper distinguishes entry-invalid from origin-unreachable
ok - safe quick tunnel publish path validates both health endpoint and WRD entry page before writing URL
ok - safe status output includes health-failed and entry-invalid states
```

- [ ] **Step 6: Commit**

```bash
git add scripts/lib-safe-wrd.sh scripts/run-safe-quicktunnel.sh scripts/status-safe-wrd.sh scripts/lib-safe-wrd.test.js scripts/run-safe-quicktunnel.test.js scripts/status-safe-wrd.test.js
git commit -m "fix: validate quick tunnel against WRD entrypoints"
```

---

### Task 5: Update docs and run the controlled tunnel experiment verification

**Files:**
- Modify: `README.md`
- Modify: `docs/runbook-safe-startup.md`
- Modify: `docs/superpowers/reports/2026-07-11-terminal-performance-analysis.md`

- [ ] **Step 1: Update the operator docs with the new truth-source vocabulary**

```md
<!-- README.md / docs/runbook-safe-startup.md -->
- `公网 RTT` = browser send -> browser receive for terminal socket probes
- `输入往返` = browser send -> browser receive for `terminal:input_ack`
- `服务端处理` = `serverSentAt - serverReceivedAt` inside the terminal server clock domain
- quick tunnel `ok` now requires both WRD health success and WRD entry-page validation
- `/api/auth/verify` uses a separate limiter bucket from password login
```

- [ ] **Step 2: Add the controlled experiment procedure to the report**

```md
<!-- docs/superpowers/reports/2026-07-11-terminal-performance-analysis.md -->
## 受控实验记录模板

每轮记录：

- cloudflared version
- named tunnel protocol
- quick tunnel protocol
- edge locations
- quic_client_smoothed_rtt
- local terminal `socketRttMs` P50/P95
- public terminal `socketRttMs` P50/P95
- public terminal `inputAckRttMs` P50/P95

只有当 edge 分布或 tunnel smoothed RTT 改善时，才允许把公网 terminal 体验改善归因给 tunnel 优化。
```

- [ ] **Step 3: Re-run the targeted tests before claiming completion**

Run:

```bash
node --test web-client/js/terminal.test.js
node --test signal-server/test/cloudflared-metrics.test.js
node --test signal-server/test/auth.test.js
node --test signal-server/test/terminal-bootstrap.test.js
node --test scripts/lib-safe-wrd.test.js
node --test scripts/run-safe-quicktunnel.test.js
node --test scripts/status-safe-wrd.test.js
```

Expected:

```text
all targeted terminal/tunnel/auth/safe-script tests pass
```

- [ ] **Step 4: Run runtime proof on local and public paths**

Run:

```bash
curl -s http://127.0.0.1:8080/health
curl -s http://127.0.0.1:8080/api/status
curl -s -H "Authorization: Bearer <admin-token>" http://127.0.0.1:8080/api/admin/terminal-summary
./scripts/status-safe-wrd.sh
curl -I -L "$(cat /tmp/wrd-safe-current-url.txt)"
curl -s http://127.0.0.1:20244/metrics | rg "edge_location|quic_client_smoothed_rtt"
curl -s http://127.0.0.1:20242/metrics | rg "edge_location|quic_client_smoothed_rtt"
```

Expected:

```text
/health -> {"status":"ok",...}
/api/status -> {"hostOnline":true,...}
/api/admin/terminal-summary -> admin-only JSON with tunnel.edgeLocations and smoothedRttsMs
status-safe-wrd -> no false "ok" for 404/non-WRD entrypoints
metrics output -> concrete edge_location and smoothed RTT evidence
```

- [ ] **Step 5: Commit**

```bash
git add README.md docs/runbook-safe-startup.md docs/superpowers/reports/2026-07-11-terminal-performance-analysis.md
git commit -m "docs: document terminal tunnel diagnostics and verification"
```

---

## Self-Review

### Spec completion

- Terminal latency semantics: covered in Task 1
- Admin terminal/tunnel summary: covered in Task 2
- `/verify` limiter isolation: covered in Task 3
- Quick tunnel deliverability check: covered in Task 4
- Controlled experiment path and runtime proof: covered in Task 5

### Architecture review checklist

- Single truth source per metric domain is explicit:
  - browser RTT in `web-client/js/terminal.js`
  - server processing time in terminal websocket payload timestamps
  - tunnel edge truth in `signal-server/lib/cloudflared-metrics.js`
  - public reachability truth in `scripts/lib-safe-wrd.sh`
- Compatibility layers are additive only:
  - new admin summary endpoint
  - existing terminal events remain intact
- No duplicated route-level limiter policy remains in scattered inline middleware once Task 3 lands

### Impact map completeness

- `Truth Source`, `Backend`, `Frontend`, `Runtime Proof`, `Docs/Skills`, and `Commit Boundary` are all explicitly filled in the header

### Definition of Done audit

- Each DoD item is testable by targeted tests, runtime endpoint checks, or safe-script status verification

### Placeholder scan

- No `TODO`, `TBD`, or implied “write tests later” placeholders remain

### Type consistency

- Metric names are consistent across tasks:
  - `socketRtt`
  - `inputAck`
  - `serverAckProcessing`
  - `edgeLocations`
  - `smoothedRttsMs`

### Docs and commit boundary

- Task 5 names the required docs explicitly
- Commit boundaries stay limited to terminal/tunnel/auth/safe-status truth and do not leak into media transport or shared-session redesign
