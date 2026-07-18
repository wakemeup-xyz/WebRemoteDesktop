# Terminal Direct WSS Fast Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Terminal off the high-latency Cloudflare Tunnel primary path by introducing a direct WSS fast path, while keeping the page entry on Cloudflare and preserving an explicit fallback path when direct connectivity is unavailable.

**Architecture:** Keep `link.stockhub.wiki` as the Cloudflare-protected page/API entry, but let Terminal consume a server-declared connection policy from `/api/terminal/bootstrap`: preferred direct socket base, fallback socket base, and whether fallback is allowed. Replace long-lived admin socket auth with a short-lived terminal socket token, and document a locked-down reverse proxy for `term.link.stockhub.wiki` that exposes only terminal socket paths plus minimal health.

**Tech Stack:** Node.js, Express, Socket.IO, JWT, xterm.js, Bash, Nginx, Markdown docs, Node test runner

**Spec Coverage:** Full approved spec coverage. This plan covers direct terminal socket policy, short-lived socket tokens, frontend direct/fallback behavior, reverse proxy security contract, deployment docs, and verification. It does not change shared terminal semantics and does not move the main page off Cloudflare Tunnel.

**Truth Source:** `signal-server/lib/config.js` defines direct-terminal policy flags and bases; `/api/terminal/bootstrap` becomes the canonical source of terminal connection policy; `signal-server/lib/auth.js` defines terminal socket token issuance and verification; `web-client/js/terminal.js` reflects the chosen transport mode in UI state; `docs/superpowers/deploy/nginx-terminal-direct.conf` becomes the canonical reverse-proxy contract for the terminal direct subdomain.

**Compatibility Notes:** The page entry remains `link.stockhub.wiki`. Shared terminal events and `/api/terminal/bootstrap` stay in place but gain connection-policy fields. Terminal fallback to the current tunnel path remains available when configured, and the UI must state when fallback is active. This plan intentionally stops using long-lived admin tokens directly on the terminal socket.

**Impact Map:**
- **Truth Source:** Terminal connection policy moves to bootstrap; terminal socket auth moves to short-lived dedicated tokens; transport mode becomes explicit frontend state.
- **Backend:** `signal-server/lib/config.js`, `signal-server/lib/auth.js`, `signal-server/server.js`, `signal-server/websocket/terminal.js`, and auth/bootstrap tests.
- **Frontend:** `web-client/js/terminal.js`, `web-client/js/runtime-config.js`, and terminal tests for direct/fallback mode.
- **Runtime Proof:** Admin bootstrap shows preferred/fallback socket bases; direct WSS connects with short-lived terminal token; fallback state is visible when direct fails; reverse proxy only exposes terminal paths.
- **Docs/Skills:** `README.md`, `docs/runbook-safe-startup.md`, `docs/superpowers/deploy/README.md`, `docs/superpowers/deploy/nginx-terminal-direct.conf`.
- **Commit Boundary:** One focused batch for terminal direct path, token model, proxy contract, and docs. No desktop media transport or tunnel lifecycle refactors belong in this batch.

**Definition of Done:**
- Terminal bootstrap returns a concrete direct/fallback connection policy, and frontend tests prove Terminal uses it.
- Terminal sockets authenticate with short-lived dedicated socket tokens instead of long-lived admin tokens.
- The repo contains an explicit terminal direct reverse-proxy contract and operator docs that keep the page on Cloudflare while exposing only terminal socket paths on `term.link.stockhub.wiki`.

---

## File Structure

### Canonical truth and responsibility map

- `signal-server/lib/config.js`
  - Canonical source of terminal direct-path feature flags and socket bases
- `signal-server/lib/auth.js`
  - Canonical issuer and verifier for terminal socket tokens
- `signal-server/server.js`
  - Canonical HTTP surface for bootstrap policy, token minting, and terminal health
- `signal-server/websocket/terminal.js`
  - Canonical terminal socket authentication and session behavior
- `signal-server/test/terminal-bootstrap.test.js`
  - Canonical regression tests for bootstrap policy and terminal token minting
- `signal-server/test/auth.test.js`
  - Canonical regression tests for token audience separation
- `signal-server/websocket/terminal.test.js`
  - Canonical regression tests for terminal socket auth behavior
- `web-client/js/terminal.js`
  - Canonical direct/fallback terminal connection flow and UI transport-mode state
- `web-client/js/terminal.test.js`
  - Canonical direct/fallback frontend behavior tests
- `web-client/js/runtime-config.js`
  - Canonical local override helper for terminal socket bases during development/debugging
- `web-client/js/runtime-config.test.js`
  - Canonical regression tests for terminal override lookup
- `docs/superpowers/deploy/nginx-terminal-direct.conf`
  - Canonical reverse-proxy example for `term.link.stockhub.wiki`
- `docs/superpowers/deploy/README.md`
  - Canonical deployment guide for direct terminal path
- `README.md`
  - Canonical operator summary
- `docs/runbook-safe-startup.md`
  - Canonical startup and diagnosis truth

### Compatibility boundary

- Main page and normal API stay on Cloudflare Tunnel
- Terminal direct path is opt-in and policy-driven
- Shared-session semantics remain intact
- Cloudflare tunnel remains a visible fallback path, not a silent default once direct mode is enabled

---

### Task 1: Add terminal direct-path policy and short-lived socket token support on the backend

**Files:**
- Modify: `signal-server/lib/config.js`
- Modify: `signal-server/lib/auth.js`
- Modify: `signal-server/server.js`
- Modify: `signal-server/test/terminal-bootstrap.test.js`
- Modify: `signal-server/test/auth.test.js`

- [ ] **Step 1: Write the failing backend tests for terminal bootstrap policy and socket token issuance**

```js
// signal-server/test/terminal-bootstrap.test.js
test('/api/terminal/bootstrap returns direct-terminal connection policy for admin tokens', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(baseUrl + '/api/terminal/bootstrap', {
      headers: { Authorization: `Bearer ${signAccessToken('admin', 'bootstrap-policy-test')}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.connection.preferredSocketBase, 'string');
    assert.equal(typeof body.connection.fallbackSocketBase, 'string');
    assert.equal(typeof body.connection.fallbackAllowed, 'boolean');
  });
});

test('/api/terminal/socket-token mints a short-lived terminal token for admin callers', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(baseUrl + '/api/terminal/socket-token', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken('admin', 'socket-token-test')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ browserSessionId: 'browser-1' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.token, 'string');
    assert.equal(body.expiresIn, '120s');
  });
});
```

```js
// signal-server/test/auth.test.js
test('terminal socket tokens use a dedicated audience and cannot be verified as normal access tokens', () => {
  const terminalToken = signTerminalSocketToken({
    subject: 'admin-user',
    browserSessionId: 'browser-1',
  });

  assert.throws(() => verifyAccessToken(terminalToken));
  const decoded = verifyTerminalSocketToken(terminalToken);
  assert.equal(decoded.scope, 'terminal:socket');
  assert.equal(decoded.browserSessionId, 'browser-1');
});
```

- [ ] **Step 2: Run the focused backend tests and verify they fail before the new policy exists**

Run:

```bash
node --test signal-server/test/terminal-bootstrap.test.js
node --test signal-server/test/auth.test.js
```

Expected:

```text
not ok - /api/terminal/bootstrap returns direct-terminal connection policy for admin tokens
not ok - /api/terminal/socket-token mints a short-lived terminal token for admin callers
not ok - terminal socket tokens use a dedicated audience and cannot be verified as normal access tokens
```

- [ ] **Step 3: Add config fields and dedicated terminal socket token helpers**

```js
// signal-server/lib/config.js
return {
  // existing fields...
  terminalDirectEnabled: process.env.WRD_TERMINAL_DIRECT_ENABLED === '1',
  terminalDirectSocketBase: String(process.env.WRD_TERMINAL_DIRECT_SOCKET_BASE || '').trim(),
  terminalFallbackEnabled: process.env.WRD_TERMINAL_FALLBACK_ENABLED !== '0',
  terminalFallbackSocketBase: String(process.env.WRD_TERMINAL_FALLBACK_SOCKET_BASE || '').trim(),
  terminalSocketTokenTtlSec: Number(process.env.WRD_TERMINAL_SOCKET_TOKEN_TTL_SEC || 120),
};
```

```js
// signal-server/lib/auth.js
function signTerminalSocketToken({ subject, browserSessionId }) {
  const config = loadConfig();
  return jwt.sign(
    {
      role: 'admin',
      scope: 'terminal:socket',
      aud: 'web-remote-desktop-terminal',
      sub: subject,
      browserSessionId,
    },
    config.jwtSecret,
    { expiresIn: `${config.terminalSocketTokenTtlSec}s` },
  );
}

function verifyTerminalSocketToken(token) {
  const config = loadConfig();
  return jwt.verify(token, config.jwtSecret, { audience: 'web-remote-desktop-terminal' });
}
```

- [ ] **Step 4: Extend bootstrap and add terminal socket-token mint endpoint**

```js
// signal-server/server.js
const { signTerminalSocketToken } = require('./lib/auth');

app.get('/api/terminal/bootstrap', requireAccessToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required' });
  }

  const fallbackSocketBase = config.terminalFallbackSocketBase || config.publicEntryUrl;
  return res.json({
    enabled: config.enableTerminal,
    softWarnSessionCount: config.terminalSoftWarnSessionCount,
    pool: terminal.sessionManager.getPoolSnapshot(),
    connection: {
      preferredTransportMode: config.terminalDirectEnabled ? 'direct-wss' : 'cloudflare-fallback',
      preferredSocketBase: config.terminalDirectEnabled ? config.terminalDirectSocketBase : fallbackSocketBase,
      fallbackSocketBase,
      fallbackAllowed: Boolean(config.terminalFallbackEnabled),
    },
  });
});

app.post('/api/terminal/socket-token', requireAccessToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required' });
  }
  const browserSessionId = String(req.body?.browserSessionId || '').trim();
  if (!browserSessionId) {
    return res.status(400).json({ error: 'browserSessionId required' });
  }
  return res.json({
    token: signTerminalSocketToken({
      subject: req.user.sub,
      browserSessionId,
    }),
    expiresIn: `${config.terminalSocketTokenTtlSec}s`,
  });
});

app.get('/terminal-health', (_req, res) => {
  res.json({ status: 'ok', terminal: true, timestamp: new Date().toISOString() });
});
```

- [ ] **Step 5: Re-run the focused backend tests and verify they pass**

Run:

```bash
node --test signal-server/test/terminal-bootstrap.test.js
node --test signal-server/test/auth.test.js
```

Expected:

```text
ok - /api/terminal/bootstrap returns direct-terminal connection policy for admin tokens
ok - /api/terminal/socket-token mints a short-lived terminal token for admin callers
ok - terminal socket tokens use a dedicated audience and cannot be verified as normal access tokens
```

- [ ] **Step 6: Commit**

```bash
git add signal-server/lib/config.js signal-server/lib/auth.js signal-server/server.js signal-server/test/terminal-bootstrap.test.js signal-server/test/auth.test.js
git commit -m "feat: add direct terminal bootstrap policy and socket tokens"
```

---

### Task 2: Make terminal socket auth require dedicated terminal tokens

**Files:**
- Modify: `signal-server/websocket/terminal.js`
- Modify: `signal-server/websocket/terminal.test.js`

- [ ] **Step 1: Write the failing websocket tests for terminal-socket token auth**

```js
// signal-server/websocket/terminal.test.js
test('terminal namespace accepts dedicated terminal socket tokens', () => {
  const { namespace } = buildTerminalHarness();
  const socket = new FakeSocket('admin-1', 'admin');
  socket.handshake.auth.token = signTerminalSocketToken({
    subject: 'admin-subject',
    browserSessionId: 'browser-1',
  });

  const connected = namespace.connect(socket);
  assert.equal(connected.sent[0].event, 'terminal:pool_snapshot');
});

test('terminal namespace rejects generic admin access tokens once socket tokens are required', () => {
  const { namespace } = buildTerminalHarness();
  const socket = new FakeSocket('legacy-admin', 'admin');
  assert.throws(() => namespace.connect(socket), /terminal token|audience/i);
});
```

- [ ] **Step 2: Run the websocket test and verify it fails before terminal token verification is wired**

Run:

```bash
node --test signal-server/websocket/terminal.test.js
```

Expected:

```text
not ok - terminal namespace accepts dedicated terminal socket tokens
not ok - terminal namespace rejects generic admin access tokens once socket tokens are required
```

- [ ] **Step 3: Switch terminal namespace auth to the dedicated token verifier**

```js
// signal-server/websocket/terminal.js
const { verifyTerminalSocketToken } = require('../lib/auth');

function authenticate(socket) {
  const token = getToken(socket);
  if (!token) {
    throw Object.assign(new Error('Authentication required'), { code: 'auth_required' });
  }
  const decoded = verifyTerminalSocketToken(token);
  if (decoded.role !== 'admin' || decoded.scope !== 'terminal:socket') {
    throw Object.assign(new Error('Admin terminal token required'), { code: 'admin_required' });
  }
  socket.user = decoded;
  return decoded;
}
```

- [ ] **Step 4: Re-run the websocket test and verify terminal namespace only accepts dedicated socket tokens**

Run:

```bash
node --test signal-server/websocket/terminal.test.js
```

Expected:

```text
ok - terminal namespace accepts dedicated terminal socket tokens
ok - terminal namespace rejects generic admin access tokens once socket tokens are required
```

- [ ] **Step 5: Commit**

```bash
git add signal-server/websocket/terminal.js signal-server/websocket/terminal.test.js
git commit -m "feat: require dedicated terminal socket tokens"
```

---

### Task 3: Teach the frontend to consume bootstrap policy, mint socket tokens, and expose direct/fallback mode

**Files:**
- Modify: `web-client/js/runtime-config.js`
- Modify: `web-client/js/runtime-config.test.js`
- Modify: `web-client/js/terminal.js`
- Modify: `web-client/js/terminal.test.js`

- [ ] **Step 1: Write the failing frontend tests for direct/fallback terminal behavior**

```js
// web-client/js/terminal.test.js
test('TerminalPanel fetches bootstrap policy and connects to the preferred direct socket base', async () => {
  function makeSocket() {
    const handlers = new Map();
    return {
      connected: false,
      io: { engine: { transport: { name: 'websocket' }, on() {} } },
      on(event, handler) { handlers.set(event, handler); },
      emit() {},
      disconnect() { this.connected = false; },
      handlers,
    };
  }

  const ioCalls = [];
  const fetchCalls = [];
  const { TerminalPanel, sessionStorageMap, tokenKey } = loadTerminal({
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      if (String(url).endsWith('/api/terminal/bootstrap')) {
        return {
          ok: true,
          json: async () => ({
            enabled: true,
            connection: {
              preferredTransportMode: 'direct-wss',
              preferredSocketBase: 'https://term.link.stockhub.wiki',
              fallbackSocketBase: 'https://link.stockhub.wiki',
              fallbackAllowed: true,
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ token: 'terminal-socket-token', expiresIn: '120s' }),
      };
    },
    io: (url, options) => {
      ioCalls.push({ url, options });
      return makeSocket();
    },
  });

  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  await TerminalPanel.connectSocket();

  assert.equal(ioCalls[0].url, 'https://term.link.stockhub.wiki/terminal');
  assert.equal(ioCalls[0].options.auth.token, 'terminal-socket-token');
});

test('TerminalPanel falls back to the Cloudflare socket base and marks the mode when direct connect fails', async () => {
  function makeSocket() {
    const handlers = new Map();
    return {
      connected: false,
      io: { engine: { transport: { name: 'websocket' }, on() {} } },
      on(event, handler) { handlers.set(event, handler); },
      emit() {},
      disconnect() { this.connected = false; },
      handlers,
    };
  }

  const ioCalls = [];
  const sockets = [];
  const { TerminalPanel, sessionStorageMap, tokenKey } = loadTerminal({
    io: (url, options) => {
      const socket = makeSocket();
      ioCalls.push({ url, options, socket });
      sockets.push(socket);
      return socket;
    },
  });

  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  await TerminalPanel.connectSocket();

  sockets[0].handlers.get('connect_error')({ message: 'direct failed' });
  assert.equal(ioCalls[1].url, 'https://link.stockhub.wiki/terminal');
  assert.equal(TerminalPanel.transportMode, 'cloudflare-fallback');
});
```

- [ ] **Step 2: Run the focused frontend tests and verify they fail before bootstrap-driven connection policy exists**

Run:

```bash
node --test web-client/js/runtime-config.test.js
node --test web-client/js/terminal.test.js
```

Expected:

```text
not ok - TerminalPanel fetches bootstrap policy and connects to the preferred direct socket base
not ok - TerminalPanel falls back to the Cloudflare socket base and marks the mode when direct connect fails
```

- [ ] **Step 3: Add terminal override helpers and bootstrap-driven socket connection flow**

```js
// web-client/js/runtime-config.js
getTerminalSocketOverride() {
  return this.normalizeBase(localStorage.getItem('wrdTerminalSocketBase'));
},

getTerminalFallbackSocketOverride() {
  return this.normalizeBase(localStorage.getItem('wrdTerminalFallbackSocketBase'));
},
```

```js
// web-client/js/terminal.js
async ensureConnectionPolicy() {
  if (this.connectionPolicy) return this.connectionPolicy;
  const response = await fetch(RuntimeConfig.url('/api/terminal/bootstrap'), {
    headers: { authorization: `Bearer ${this.getAdminToken()}` },
  });
  if (!response.ok) {
    throw new Error('Failed to load terminal bootstrap');
  }
  const body = await response.json();
  const localPreferred = RuntimeConfig.getTerminalSocketOverride?.();
  const localFallback = RuntimeConfig.getTerminalFallbackSocketOverride?.();
  this.connectionPolicy = {
    ...body.connection,
    preferredSocketBase: localPreferred || body.connection.preferredSocketBase,
    fallbackSocketBase: localFallback || body.connection.fallbackSocketBase,
  };
  return this.connectionPolicy;
}

async mintTerminalSocketToken() {
  const response = await fetch(RuntimeConfig.url('/api/terminal/socket-token'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${this.getAdminToken()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ browserSessionId: this.getBrowserSessionId() }),
  });
  if (!response.ok) {
    throw new Error('Failed to mint terminal socket token');
  }
  return response.json();
}
```

- [ ] **Step 4: Implement explicit direct-first, fallback-second socket creation and visible mode state**

```js
// web-client/js/terminal.js
async connectSocket() {
  const adminToken = this.getAdminToken();
  if (!adminToken || typeof io === 'undefined') return;

  const [policy, socketAuth] = await Promise.all([
    this.ensureConnectionPolicy(),
    this.mintTerminalSocketToken(),
  ]);

  const attempt = async (base, mode, allowFallback) => {
    this.transportMode = mode;
    this.socket = io(`${base}/terminal`, {
      auth: {
        token: socketAuth.token,
        clientId: this.getBrowserSessionId(),
      },
      transports: ['websocket', 'polling'],
      rememberUpgrade: true,
    });
    this.socket.on('connect_error', async (err) => {
      if (mode === 'direct-wss' && allowFallback) {
        this.setStatus(`直连失败，回退中：${err.message}`, 'warning');
        this.destroySocket();
        await attempt(policy.fallbackSocketBase, 'cloudflare-fallback', false);
        return;
      }
      this.socketState = 'error';
      this.setStatus(`连接失败：${err.message}`, 'error');
    });
    this.socket.on('connect', () => {
      this.socketState = 'connected';
      this.setStatus(
        mode === 'direct-wss' ? '共享控制台已直连' : '共享控制台已连接（Cloudflare fallback）',
        'connected',
      );
      this.startLatencyProbeLoop();
    });
  };

  await attempt(
    policy.preferredSocketBase,
    policy.preferredTransportMode,
    Boolean(policy.fallbackAllowed),
  );
}
```

- [ ] **Step 5: Re-run the focused frontend tests and verify direct/fallback behavior passes**

Run:

```bash
node --test web-client/js/runtime-config.test.js
node --test web-client/js/terminal.test.js
```

Expected:

```text
ok - TerminalPanel fetches bootstrap policy and connects to the preferred direct socket base
ok - TerminalPanel falls back to the Cloudflare socket base and marks the mode when direct connect fails
```

- [ ] **Step 6: Commit**

```bash
git add web-client/js/runtime-config.js web-client/js/runtime-config.test.js web-client/js/terminal.js web-client/js/terminal.test.js
git commit -m "feat: add terminal direct socket policy and fallback UI"
```

---

### Task 4: Add the direct-terminal reverse proxy contract and update operator docs

**Files:**
- Create: `docs/superpowers/deploy/nginx-terminal-direct.conf`
- Modify: `docs/superpowers/deploy/README.md`
- Modify: `README.md`
- Modify: `docs/runbook-safe-startup.md`

- [ ] **Step 1: Write the failing documentation-source tests by asserting the new deploy artifact paths exist**

```bash
test -f docs/superpowers/deploy/nginx-terminal-direct.conf
rg -n "term.link.stockhub.wiki|terminal direct|socket-token|cloudflare fallback" README.md docs/runbook-safe-startup.md docs/superpowers/deploy/README.md
```

Expected:

```text
missing docs/superpowers/deploy/nginx-terminal-direct.conf
missing direct-terminal deployment and fallback guidance in docs
```

- [ ] **Step 2: Add a locked-down Nginx example for `term.link.stockhub.wiki`**

```nginx
# docs/superpowers/deploy/nginx-terminal-direct.conf
server {
    listen 443 ssl http2;
    server_name term.link.stockhub.wiki;

    ssl_certificate /opt/nginx/ssl/cloudflare-origin.pem;
    ssl_certificate_key /opt/nginx/ssl/cloudflare-origin.key;

    location = /terminal-health {
        proxy_pass http://127.0.0.1:8080/terminal-health;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:8080/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }

    location / {
        return 404;
    }
}
```

- [ ] **Step 3: Update operator docs with the new page/direct/fallback split**

```md
<!-- docs/superpowers/deploy/README.md -->
- 页面入口：`https://link.stockhub.wiki`，继续走 Cloudflare Tunnel
- Terminal 直连入口：`https://term.link.stockhub.wiki`
- Terminal 必须先从主页面获取 admin token，再换取短时 `socket-token`
- `term` 子域只暴露 `/socket.io/` 与 `/terminal-health`，其余路径默认 404
```

```md
<!-- README.md / docs/runbook-safe-startup.md -->
- 主页面正常不代表 Terminal 已走低延迟直连
- 若 Terminal 状态显示 `cloudflare-fallback`，说明 direct WSS 失败或未启用
- direct WSS 只有在公网入站、TLS、反代、origin allowlist 都配置完成后才应启用
```

- [ ] **Step 4: Re-run the doc/source checks and verify the deploy contract is present**

Run:

```bash
test -f docs/superpowers/deploy/nginx-terminal-direct.conf
rg -n "term.link.stockhub.wiki|cloudflare-fallback|socket-token" README.md docs/runbook-safe-startup.md docs/superpowers/deploy/README.md docs/superpowers/deploy/nginx-terminal-direct.conf
```

Expected:

```text
docs/superpowers/deploy/nginx-terminal-direct.conf
matching lines found in all updated docs
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/deploy/nginx-terminal-direct.conf docs/superpowers/deploy/README.md README.md docs/runbook-safe-startup.md
git commit -m "docs: define direct terminal reverse proxy and fallback ops"
```

---

### Task 5: Run the targeted verification and prove the transport split works

**Files:**
- Modify: `docs/superpowers/specs/2026-07-11-terminal-direct-wss-design.md`
- Modify: `docs/superpowers/plans/2026-07-11-terminal-direct-wss-plan.md`

- [ ] **Step 1: Re-run the targeted tests before any success claim**

Run:

```bash
node --test signal-server/test/terminal-bootstrap.test.js
node --test signal-server/test/auth.test.js
node --test signal-server/websocket/terminal.test.js
node --test web-client/js/runtime-config.test.js
node --test web-client/js/terminal.test.js
```

Expected:

```text
all targeted terminal direct-path tests pass
```

- [ ] **Step 2: Run local runtime proof on the bootstrap and token endpoints**

Run:

```bash
curl -s http://127.0.0.1:8080/api/status
curl -s -H "Authorization: Bearer <admin-token>" http://127.0.0.1:8080/api/terminal/bootstrap
curl -s -X POST -H "Authorization: Bearer <admin-token>" -H "content-type: application/json" \
  -d '{"browserSessionId":"proof-browser"}' \
  http://127.0.0.1:8080/api/terminal/socket-token
curl -s http://127.0.0.1:8080/terminal-health
```

Expected:

```text
/api/terminal/bootstrap -> includes preferredTransportMode, preferredSocketBase, fallbackSocketBase, fallbackAllowed
/api/terminal/socket-token -> returns short-lived token and expiresIn
/terminal-health -> {"status":"ok","terminal":true,...}
```

- [ ] **Step 3: Run browser/runtime proof for direct vs fallback visibility**

Run:

```text
1. Open https://link.stockhub.wiki/viewer.html
2. Login and open Terminal
3. Confirm status shows either "共享控制台已直连" or "Cloudflare fallback"
4. In DevTools, verify the terminal socket target is the bootstrap-declared base
5. If direct path is intentionally disabled, confirm fallback mode is explicitly shown
```

Expected:

```text
UI and network panel agree on direct-wss vs cloudflare-fallback mode
```

- [ ] **Step 4: Commit any final spec/plan wording sync if the implementation changed the contract**

```bash
git add docs/superpowers/specs/2026-07-11-terminal-direct-wss-design.md docs/superpowers/plans/2026-07-11-terminal-direct-wss-plan.md
git commit -m "docs: sync terminal direct-path spec and implementation plan"
```

---

## Self-Review

### Spec completion

- Direct socket architecture: Task 1 and Task 3
- Short-lived terminal token: Task 1 and Task 2
- Direct/fallback explicit mode: Task 3
- Reverse proxy security contract: Task 4
- Runtime proof: Task 5

### Architecture review checklist

- Single truth source for terminal connection policy is explicit: `/api/terminal/bootstrap`
- Dedicated token audience avoids reusing generic admin access tokens on a public socket
- Reverse proxy contract defaults to `404` for non-terminal paths, preventing accidental full-app exposure
- Page and Terminal public paths are explicitly separated without changing shared session internals

### Impact map completeness

- `Truth Source`, `Backend`, `Frontend`, `Runtime Proof`, `Docs/Skills`, and `Commit Boundary` are all explicitly filled in the header

### Definition of Done audit

- Each DoD item is verifiable through targeted tests, runtime endpoint checks, or browser proof

### Placeholder scan

- No `TODO`, `TBD`, or “write tests later” placeholders remain

### Type consistency

- `preferredSocketBase`, `fallbackSocketBase`, `fallbackAllowed`, `preferredTransportMode`, `socket-token`, and `terminal-health` are named consistently across tasks

### Docs and commit boundary

- Docs updates are isolated to deployment and operator-facing files
- Commit boundary excludes unrelated media transport or Cloudflare tunnel lifecycle work
