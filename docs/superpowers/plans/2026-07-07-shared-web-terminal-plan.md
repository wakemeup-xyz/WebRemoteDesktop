# Shared Web Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework WebRemoteDesktop terminal into a shared PTY session pool that survives page close, supports concurrent multi-computer attach/input, replays recent output on reconnect, and remains independent from desktop WebRTC/network-mode lifecycle.

**Architecture:** The backend becomes the single source of truth for shared terminal state through a pool/session/observer model inside `signal-server/lib/terminal/session-manager.js`. The `/terminal` namespace and a new `/api/terminal/bootstrap` endpoint expose shared-pool snapshots, replay, attach/detach, presence, and explicit close semantics, while the frontend turns `TerminalPanel` into a page-level controller whose socket lifecycle is independent from tab visibility and desktop disconnect behavior.

**Tech Stack:** Vanilla JavaScript, Socket.IO, Express, Node.js built-in test runner, `node-pty`, xterm.js, existing shell startup scripts

**Spec Coverage:** Full coverage of the approved spec in `docs/superpowers/specs/2026-07-07-shared-web-terminal-design.md`, including shared pool truth model, concurrent input, replay/reconnect, desktop-terminal lifecycle separation, docs updates, runtime proof, and service restart verification.

**Truth Source:** `signal-server/lib/terminal/session-manager.js` owns the canonical shared terminal pool, shared session metadata, observer registry, replay buffer, and active-presenter resize arbitration. `signal-server/websocket/terminal.js` is a transport adapter over that truth source. `web-client/js/terminal.js` is a consumer only.

**Compatibility Notes:** Existing `/api/auth/login/admin` stays unchanged as the admin auth entrypoint. Existing terminal event names (`terminal:create`, `terminal:attach`, `terminal:close`) may be accepted temporarily as read/write compatibility shims inside `signal-server/websocket/terminal.js`, but all new shared semantics and frontend state must use the new pool/session terminology. No compatibility shim is allowed to reintroduce `ownerSub` as a write path.

**Impact Map:**
- **Truth Source:** Replace `ownerSub`-scoped session ownership with a shared `pool -> session -> observer` model in `signal-server/lib/terminal/session-manager.js`.
- **Backend:** `signal-server/server.js`, `signal-server/routes/auth.js`, `signal-server/websocket/terminal.js`, and terminal tests gain shared pool snapshot, replay, presence, and detach-vs-close semantics.
- **Frontend:** `web-client/js/terminal.js`, `web-client/js/terminal.test.js`, `web-client/viewer.html`, and `web-client/css/viewer.css` switch from tab-local terminal behavior to a persistent shared-session controller and pool UI.
- **Runtime Proof:** Fresh `node --test ...` runs, browser/HTTP/socket checks through local `127.0.0.1:8080`, `./scripts/restart-host.sh`, `./scripts/status-safe-wrd.sh`, and a manual verification that desktop disconnect / network-mode switching do not kill terminal sessions.
- **Docs/Skills:** Update `README.md`, `docs/runbook-safe-startup.md`, and `docs/需求文档/WebRemoteDesktop-需求文档.md` to describe the shared terminal pool, page-close persistence, and restart verification expectations.
- **Commit Boundary:** Only shared-terminal implementation, tests, docs, and verification artifacts required by this approved spec. Do not mix unrelated safe-tunnel or desktop-media changes.

**Definition of Done:**
- A shared terminal session created from one browser remains alive after that browser closes, and another browser can attach later and continue from replayed recent output without recreating the PTY.
- Two browsers attached to the same session both receive the same terminal output and can both send input to the same shared shell in arrival order.
- Desktop-only lifecycle actions (`network mode` changes and `disconnect` button) no longer tear down the terminal controller or the backend shared session pool, and docs plus runtime proof reflect that behavior.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `signal-server/lib/terminal/session-manager.js` | Canonical shared terminal truth source: pool registry, session registry, observer registry, replay buffer, resize arbitration, detach/close rules |
| `signal-server/websocket/terminal.js` | Socket.IO adapter for shared pool events, presence broadcast, replay delivery, and compatibility event aliases |
| `signal-server/server.js` | HTTP bootstrap endpoint wiring and terminal namespace setup |
| `signal-server/routes/auth.js` | Admin auth entrypoint retained; no ownership semantics allowed here |
| `signal-server/test/terminal-session-manager.test.js` | Shared pool/session/observer/replay/resize unit tests |
| `signal-server/test/terminal-bootstrap.test.js` | `/api/terminal/bootstrap` contract tests |
| `signal-server/websocket/terminal.test.js` | Shared namespace auth, attach/detach/close/presence/replay compatibility tests |
| `web-client/js/terminal.js` | Persistent terminal controller, shared pool UI state, replay/reattach flow, desktop-terminal lifecycle separation |
| `web-client/js/terminal.test.js` | Shared frontend behavior tests for persistent socket, pool snapshots, desktop disconnect isolation, and reconnect replay |
| `web-client/viewer.html` | Shared terminal workspace markup and warning copy |
| `web-client/css/viewer.css` | Shared terminal workspace/pool layout, warnings, and disabled states |
| `README.md` | Product-level terminal behavior and startup/restart expectations |
| `docs/runbook-safe-startup.md` | Service restart / status / password reporting flow including shared terminal invariants |
| `docs/需求文档/WebRemoteDesktop-需求文档.md` | Product requirement truth synced to shared pool semantics |

### Task 1: Shared Terminal Truth Source in `session-manager`

**Files:**
- Modify: `signal-server/lib/terminal/session-manager.js`
- Modify: `signal-server/test/terminal-session-manager.test.js`

- [ ] **Step 1: Write failing tests for shared pool, shared observers, replay buffer, and active-presenter resize**

Add or replace tests in `signal-server/test/terminal-session-manager.test.js` with these behaviors:

```js
test('shared session manager stores sessions in the default pool and no longer exposes ownerSub ownership', () => {
  const manager = createTerminalSessionManager({
    ptyFactory: createFakePty,
    logger: { warn() {}, info() {}, error() {} },
    now: () => new Date('2026-07-07T00:00:00.000Z'),
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/Users/macstudio1/AI/Claude/WebRemoteDesktop',
      terminalSoftWarnSessionCount: 4,
      terminalIdleTimeoutMs: 0,
      terminalStartupTimeoutMs: 10000,
      terminalRecordIo: false,
    },
  });

  const created = manager.createSession({
    clientId: 'browser-a',
    cols: 120,
    rows: 32,
    title: 'Shared shell',
  });

  assert.equal(created.poolId, 'default');
  assert.equal(created.observerCount, 1);
  assert.equal('ownerSub' in created, false);
  assert.equal(manager.getPoolSnapshot().poolId, 'default');
  assert.equal(manager.getPoolSnapshot().sessions[0].sessionId, created.sessionId);
});
```

```js
test('shared session manager broadcasts PTY output to every attached observer and replays recent output on reattach', () => {
  const pty = createFakePty();
  const deliveredA = [];
  const deliveredB = [];
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/tmp',
      terminalSoftWarnSessionCount: 4,
      terminalIdleTimeoutMs: 0,
      terminalStartupTimeoutMs: 10000,
      terminalRecordIo: false,
    },
  });

  const created = manager.createSession({ clientId: 'browser-a', cols: 80, rows: 24, onData: (chunk) => deliveredA.push(chunk) });
  manager.attachSession(created.sessionId, { clientId: 'browser-b', onData: (chunk) => deliveredB.push(chunk) });

  pty.emitData('first line\\r\\n');
  assert.deepEqual(deliveredA, ['first line\\r\\n']);
  assert.deepEqual(deliveredB, ['first line\\r\\n']);

  manager.detachObserver(created.sessionId, { clientId: 'browser-b' });
  const replay = manager.attachSession(created.sessionId, { clientId: 'browser-b', onData: (chunk) => deliveredB.push(chunk) });
  assert.equal(replay.replay.length, 1);
  assert.equal(replay.replay[0].data, 'first line\\r\\n');
});
```

```js
test('shared session manager keeps PTY alive after last observer detaches and only kills on explicit close', () => {
  const pty = createFakePty();
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/tmp',
      terminalSoftWarnSessionCount: 4,
      terminalIdleTimeoutMs: 0,
      terminalStartupTimeoutMs: 10000,
      terminalRecordIo: false,
    },
  });

  const created = manager.createSession({ clientId: 'browser-a', cols: 80, rows: 24 });
  manager.detachObserver(created.sessionId, { clientId: 'browser-a', reason: 'page-close' });

  assert.equal(manager.getPoolSnapshot().sessions[0].observerCount, 0);
  assert.equal(pty.killCalls.length, 0);

  manager.closeSession(created.sessionId, { clientId: 'browser-a', reason: 'user-close' });
  assert.equal(pty.killCalls.length, 1);
});
```

```js
test('only the active presenter may resize the shared PTY', () => {
  const pty = createFakePty();
  const manager = createTerminalSessionManager({
    ptyFactory: () => pty,
    logger: { warn() {}, info() {}, error() {} },
    config: {
      enableTerminal: true,
      terminalAdminPassword: 'test-terminal-admin-password',
      terminalShell: '/bin/zsh',
      terminalCwd: '/tmp',
      terminalSoftWarnSessionCount: 4,
      terminalIdleTimeoutMs: 0,
      terminalStartupTimeoutMs: 10000,
      terminalRecordIo: false,
    },
  });

  const created = manager.createSession({ clientId: 'browser-a', cols: 80, rows: 24 });
  manager.attachSession(created.sessionId, { clientId: 'browser-b' });
  manager.setActivePresenter(created.sessionId, { clientId: 'browser-a' });
  manager.resizeSession(created.sessionId, { clientId: 'browser-b', cols: 100, rows: 40 });
  manager.resizeSession(created.sessionId, { clientId: 'browser-a', cols: 132, rows: 36 });

  assert.deepEqual(pty.resizeCalls, [{ cols: 132, rows: 36 }]);
});
```

- [ ] **Step 2: Run the session-manager test file and confirm it fails for the right reasons**

Run:

```bash
node --test signal-server/test/terminal-session-manager.test.js
```

Expected: FAIL with missing shared-pool APIs such as `getPoolSnapshot`, `detachObserver`, `setActivePresenter`, replay data, or the presence of obsolete `ownerSub` fields.

- [ ] **Step 3: Implement the shared pool/session/observer truth source in `signal-server/lib/terminal/session-manager.js`**

Reshape the module around a single `defaultPool` plus shared-session metadata:

```js
function createReplayBuffer(limitBytes = 262144) {
  let totalBytes = 0;
  const entries = [];
  let seq = 0;

  return {
    push(data) {
      const normalized = String(data || '');
      const size = Buffer.byteLength(normalized, 'utf8');
      const entry = { seq: ++seq, data: normalized };
      entries.push(entry);
      totalBytes += size;
      while (totalBytes > limitBytes && entries.length) {
        const removed = entries.shift();
        totalBytes -= Buffer.byteLength(String(removed.data || ''), 'utf8');
      }
      return entry;
    },
    snapshot() {
      return entries.slice();
    },
    lastSeq() {
      return seq;
    },
  };
}
```

```js
function createTerminalSessionManager(options = {}) {
  const sessions = new Map();
  const pool = {
    poolId: 'default',
    title: 'Shared Terminal Pool',
    defaultSessionId: null,
  };

  function createSession(input = {}) {
    // spawn PTY, create replay buffer, attach creator as observer
  }

  function attachSession(sessionId, input = {}) {
    // register observer, return session snapshot + replay buffer snapshot
  }

  function detachObserver(sessionId, input = {}) {
    // remove one observer only; keep PTY alive
  }

  function closeSession(sessionId, input = {}) {
    // explicit kill only here
  }

  function emitOutput(session, data) {
    const replayEntry = session.replayBuffer.push(data);
    for (const observer of session.observers.values()) {
      observer.onData?.(replayEntry.data);
    }
  }

  return {
    createSession,
    attachSession,
    detachObserver,
    closeSession,
    getPoolSnapshot,
    setActivePresenter,
    resizeSession,
    handleSocketDisconnect,
  };
}
```

Requirements for the implementation:

- No `ownerSub`-based ownership checks anywhere.
- PTY output fan-outs to all observers.
- Replay buffer is bounded and returned during attach.
- Observer count stays accurate at `0+` without killing PTY.
- Only `closeSession` kills the PTY.
- Resize writes go through `setActivePresenter` and `resizeSession`.

- [ ] **Step 4: Re-run the session-manager tests and confirm they pass**

Run:

```bash
node --test signal-server/test/terminal-session-manager.test.js
```

Expected: PASS with shared-pool, replay, and active-presenter behaviors verified.

- [ ] **Step 5: Commit the shared truth-source slice**

```bash
git add signal-server/lib/terminal/session-manager.js signal-server/test/terminal-session-manager.test.js
git commit -m "feat: add shared terminal session truth source"
```

### Task 2: HTTP Bootstrap and Shared `/terminal` Namespace Protocol

**Files:**
- Modify: `signal-server/server.js`
- Modify: `signal-server/websocket/terminal.js`
- Modify: `signal-server/routes/auth.js`
- Create: `signal-server/test/terminal-bootstrap.test.js`
- Modify: `signal-server/websocket/terminal.test.js`

- [ ] **Step 1: Write failing tests for bootstrap, shared attach/detach, replay delivery, and desktop-safe disconnect semantics**

Add `signal-server/test/terminal-bootstrap.test.js`:

```js
test('/api/terminal/bootstrap returns terminal pool metadata for admin tokens', async () => {
  const { baseUrl, closeServer, signAccessToken, sessionManager } = await startServer();
  try {
    const created = sessionManager.createSession({ clientId: 'browser-a', cols: 80, rows: 24, title: 'Shared shell' });
    const response = await fetch(baseUrl + '/api/terminal/bootstrap', {
      headers: { Authorization: `Bearer ${signAccessToken('admin', 'terminal-admin-login')}` },
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.pool.poolId, 'default');
    assert.equal(body.pool.sessions[0].sessionId, created.sessionId);
  } finally {
    await closeServer();
  }
});
```

Expand `signal-server/websocket/terminal.test.js` with:

```js
test('terminal namespace broadcasts shared session output and presence to multiple admin sockets', () => {
  const { io, namespace, sessionManager } = buildTerminalHarness();
  const adminA = namespace.connect(new FakeSocket('admin-a', 'admin'));
  const adminB = namespace.connect(new FakeSocket('admin-b', 'admin'));

  adminA.trigger('terminal:create_session', { cols: 120, rows: 32, title: 'Shared shell' });
  const created = adminA.sent.find((message) => message.event === 'terminal:session_created').data;

  adminB.trigger('terminal:attach_session', { sessionId: created.sessionId });
  sessionManager._getSession(created.sessionId).pty.emitData('pwd\\r\\n');

  assert.equal(adminA.sent.some((message) => message.event === 'terminal:output' && message.data.data === 'pwd\\r\\n'), true);
  assert.equal(adminB.sent.some((message) => message.event === 'terminal:output' && message.data.data === 'pwd\\r\\n'), true);
  assert.equal(adminA.sent.some((message) => message.event === 'terminal:presence'), true);
  assert.equal(adminB.sent.some((message) => message.event === 'terminal:presence'), true);
});
```

```js
test('socket disconnect detaches observers without closing the shared PTY', () => {
  const { namespace, sessionManager } = buildTerminalHarness();
  const adminA = namespace.connect(new FakeSocket('admin-a', 'admin'));

  adminA.trigger('terminal:create_session', { cols: 120, rows: 32, title: 'Shared shell' });
  const created = adminA.sent.find((message) => message.event === 'terminal:session_created').data;

  adminA.trigger('disconnect');

  const session = sessionManager._getSession(created.sessionId);
  assert.equal(session.observers.size, 0);
  assert.equal(session.pty.killCalls.length, 0);
});
```

```js
test('legacy terminal:create and terminal:attach aliases still map into shared session semantics', () => {
  const { namespace } = buildTerminalHarness();
  const adminA = namespace.connect(new FakeSocket('admin-a', 'admin'));
  adminA.trigger('terminal:create', { cols: 120, rows: 32, title: 'Compat shell' });
  assert.equal(adminA.sent.some((message) => message.event === 'terminal:session_created'), true);
});
```

- [ ] **Step 2: Run the backend bootstrap/socket tests and confirm they fail first**

Run:

```bash
node --test signal-server/test/terminal-bootstrap.test.js signal-server/websocket/terminal.test.js signal-server/test/terminal-auth.test.js
```

Expected: FAIL with missing `/api/terminal/bootstrap`, missing shared event names, missing replay/presence handling, or old detach/close semantics.

- [ ] **Step 3: Implement bootstrap and shared namespace protocol**

Add admin-only bootstrap in `signal-server/server.js`:

```js
app.get('/api/terminal/bootstrap', requireAccessToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required' });
  }
  return res.json({
    enabled: config.enableTerminal,
    softWarnSessionCount: config.terminalSoftWarnSessionCount,
    pool: terminal.sessionManager.getPoolSnapshot(),
  });
});
```

Reshape `signal-server/websocket/terminal.js` around shared events:

```js
socket.on('terminal:create_session', (payload = {}) => {
  const created = sessionManager.createSession({
    clientId,
    title: payload.title,
    cols: payload.cols,
    rows: payload.rows,
    onData: (data) => socket.emit('terminal:output', { sessionId: created.sessionId, data }),
  });
  terminalNamespace.emit('terminal:session_created', created);
  terminalNamespace.emit('terminal:pool_snapshot', sessionManager.getPoolSnapshot());
});

socket.on('terminal:attach_session', (payload = {}) => {
  const attached = sessionManager.attachSession(payload.sessionId, {
    clientId,
    cols: payload.cols,
    rows: payload.rows,
    onData: (data) => socket.emit('terminal:output', { sessionId: attached.sessionId, data }),
  });
  socket.emit('terminal:replay', {
    sessionId: attached.sessionId,
    replay: attached.replay,
  });
  socket.emit('terminal:session_attached', attached);
  terminalNamespace.emit('terminal:presence', sessionManager.getPresence(payload.sessionId));
});
```

Also implement:

- `terminal:detach_session`
- `terminal:close_session`
- `terminal:resize`
- `disconnect` -> `handleSocketDisconnect(clientId, socket.id)`
- compatibility aliases from `terminal:create`, `terminal:attach`, `terminal:detach`, `terminal:close` to the new shared handlers

Keep `/api/auth/login/admin` behavior stable; do not move ownership checks there.

- [ ] **Step 4: Re-run the backend bootstrap/socket/auth tests and confirm they pass**

Run:

```bash
node --test signal-server/test/terminal-bootstrap.test.js signal-server/websocket/terminal.test.js signal-server/test/terminal-auth.test.js
```

Expected: PASS with bootstrap, shared attach/detach, replay, and compatibility aliases covered.

- [ ] **Step 5: Commit the backend transport slice**

```bash
git add signal-server/server.js signal-server/websocket/terminal.js signal-server/routes/auth.js signal-server/test/terminal-bootstrap.test.js signal-server/websocket/terminal.test.js signal-server/test/terminal-auth.test.js
git commit -m "feat: expose shared terminal pool protocol"
```

### Task 3: Frontend Persistent Controller, Shared Pool UI, and Desktop Isolation

**Files:**
- Modify: `web-client/js/terminal.js`
- Modify: `web-client/js/terminal.test.js`
- Modify: `web-client/viewer.html`
- Modify: `web-client/css/viewer.css`
- Modify: `web-client/js/ui.js`

- [ ] **Step 1: Write failing frontend tests for persistent socket lifecycle, replay restore, and desktop disconnect isolation**

Extend `web-client/js/terminal.test.js` with:

```js
test('TerminalPanel keeps the terminal socket alive when the user switches back to the desktop tab', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  TerminalPanel.showDesktop();

  assert.equal(TerminalPanel.socket, fakeSocket);
  assert.equal(fakeSocket.connected, true);
});
```

```js
test('TerminalPanel restores replayed output after reattach using the last active shared session id', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  socketHandlers.get('terminal:session_created')({ sessionId: 'term_keep', title: 'Shared shell', observerCount: 1 });
  socketHandlers.get('terminal:replay')({
    sessionId: 'term_keep',
    replay: [{ seq: 1, data: 'npm test\\r\\n' }],
  });

  const term = TerminalPanel.terms.get('term_keep');
  assert.ok(term, 'shared terminal instance should exist');
  assert.equal(TerminalPanel.state.getSession('term_keep').status, 'attached');
});
```

```js
test('desktop disconnect only calls WebRTC.disconnect and never disconnects the terminal socket', () => {
  let disconnectCalls = 0;
  const { context, TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey } = loadTerminal();
  context.WebRTC = { disconnect() { disconnectCalls += 1; } };
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  context.UI.setupControlButtons();
  context.document.getElementById('disconnectBtn').onclick?.({ preventDefault() {} });

  assert.equal(disconnectCalls, 1);
  assert.equal(fakeSocket.connected, true);
});
```

```js
test('TerminalPanel persists the last active shared session id and reattaches on reconnect', () => {
  const { TerminalPanel, fakeSocket, socketHandlers, sessionStorageMap, tokenKey, emitted } = loadTerminal();
  sessionStorageMap.set(tokenKey, 'admin-token');
  TerminalPanel.cacheElements();
  TerminalPanel.ensureSession({ sessionId: 'term_keep', title: 'Shared shell' });
  TerminalPanel.activateSession('term_keep');

  TerminalPanel.connectSocket();
  fakeSocket.connected = true;
  socketHandlers.get('connect')();

  assert.equal(emitted.some((entry) => entry.event === 'terminal:attach_session' && entry.payload.sessionId === 'term_keep'), true);
});
```

- [ ] **Step 2: Run the frontend terminal tests and confirm they fail before implementation**

Run:

```bash
node --test web-client/js/terminal.test.js
```

Expected: FAIL because current `TerminalPanel` still couples socket lifecycle to tab visibility, lacks replay handling, and still uses pre-shared-pool event/state names.

- [ ] **Step 3: Implement the persistent shared-pool frontend controller**

In `web-client/js/terminal.js`, move to a page-level controller:

```js
const LAST_ACTIVE_SESSION_KEY = 'wrd_terminal_last_active_session_id';

showDesktop() {
  this.isVisible = false;
  document.body.classList.remove('terminal-active');
  this.elements.desktopPanel?.classList.remove('hidden');
  this.elements.terminalPanel?.classList.add('hidden');
  this.elements.desktopTab?.classList.add('active');
  this.elements.terminalTab?.classList.remove('active');
  // no socket disconnect here
}

connectSocket() {
  if (this.socket) return;
  this.socket = io(`${RuntimeConfig.getSocketBase()}/terminal`, {
    auth: { token: this.getAdminToken(), clientId: this.getBrowserSessionId() },
    transports: ['websocket', 'polling'],
  });
  this.socket.on('terminal:pool_snapshot', (payload) => this.applyPoolSnapshot(payload));
  this.socket.on('terminal:session_created', (session) => this.ensureSession(session));
  this.socket.on('terminal:session_attached', (session) => this.attachSessionState(session));
  this.socket.on('terminal:replay', (payload) => this.writeReplay(payload.sessionId, payload.replay));
  this.socket.on('terminal:presence', (payload) => this.updatePresence(payload));
}
```

Add state persistence and replay helpers:

```js
activateSession(sessionId) {
  this.state.setActive(sessionId);
  localStorage.setItem(LAST_ACTIVE_SESSION_KEY, sessionId);
  this.render();
  this.fitActiveTerminal();
  this.scheduleFitActiveTerminal();
}

reattachSessions() {
  const lastActive = localStorage.getItem(LAST_ACTIVE_SESSION_KEY);
  if (lastActive) {
    this.socket.emit('terminal:attach_session', { sessionId: lastActive, cols: 120, rows: 32 });
    return;
  }
  this.state.getSessions().forEach((session) => {
    this.socket.emit('terminal:attach_session', { sessionId: session.sessionId, cols: 120, rows: 32 });
  });
}

writeReplay(sessionId, replay = []) {
  replay.forEach((entry) => this.writeOutput(sessionId, entry.data));
}
```

Update the HTML/CSS/UI copy to reflect shared semantics:

- add a visible “共享控制台” warning line
- show observer counts in session tabs/list
- keep “新建” disabled until terminal socket is connected
- ensure desktop disconnect button remains desktop-only

- [ ] **Step 4: Re-run the frontend terminal tests and confirm they pass**

Run:

```bash
node --test web-client/js/terminal.test.js
```

Expected: PASS with persistent socket lifecycle, replay restore, and desktop disconnect isolation covered.

- [ ] **Step 5: Commit the frontend shared-controller slice**

```bash
git add web-client/js/terminal.js web-client/js/terminal.test.js web-client/viewer.html web-client/css/viewer.css web-client/js/ui.js
git commit -m "feat: add shared terminal frontend controller"
```

### Task 4: Documentation Sync and Runtime Verification Flow

**Files:**
- Modify: `README.md`
- Modify: `docs/runbook-safe-startup.md`
- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md`

- [ ] **Step 1: Write doc assertions into targeted checks before editing**

Record these exact statements to enforce in docs:

```md
- Terminal is a shared shell session pool for all admin-authorized users.
- Closing the terminal tab or Viewer page detaches the browser but does not kill the PTY.
- Desktop disconnect and network-mode changes do not terminate the shared terminal pool.
- Service restart still terminates in-memory shared terminal sessions.
- After local service restart, report both VIEWER_ACCESS_PASSWORD and WRD_TERMINAL_ADMIN_PASSWORD from runtime config.
```

Add or update these doc sections:

- `README.md` “Web Terminal”
- `docs/runbook-safe-startup.md` startup/restart/status expectations
- `docs/需求文档/WebRemoteDesktop-需求文档.md` terminal requirements and deployment semantics

- [ ] **Step 2: Edit the docs to match the shared-pool implementation**

Use wording like:

```md
### Web Terminal

- Terminal is a shared shell session pool for all users who complete terminal admin authorization.
- Multiple browsers may attach to the same shared session at the same time; input is shared and immediately affects the same shell.
- Closing the current Viewer page only detaches that browser. The PTY remains alive until explicit session close or service restart.
- The desktop `断开连接` button only disconnects the remote desktop path. It does not close terminal sessions.
- `scripts/restart-host.sh` and signal-server restart preserve the current tunnel address when applicable, but shared terminal sessions are in-memory and therefore end on service restart.
```

- [ ] **Step 3: Run a targeted doc search to verify the new semantics are present and the old private-session wording is gone**

Run:

```bash
rg -n "shared shell session pool|共享 shell|关闭.*Viewer.*不.*kill|disconnect.*not.*close terminal|ownerSub|浏览器会话级授权" README.md docs/runbook-safe-startup.md docs/需求文档/WebRemoteDesktop-需求文档.md
```

Expected:

- Hits for shared-pool wording and desktop-terminal separation
- No remaining doc claim that terminal sessions are private to a browser session

- [ ] **Step 4: Commit the doc-sync slice**

```bash
git add README.md docs/runbook-safe-startup.md docs/需求文档/WebRemoteDesktop-需求文档.md
git commit -m "docs: describe shared terminal pool behavior"
```

### Task 5: End-to-End Verification, Review, and Service Restart

**Files:**
- Verify: `signal-server/test/terminal-session-manager.test.js`
- Verify: `signal-server/test/terminal-bootstrap.test.js`
- Verify: `signal-server/websocket/terminal.test.js`
- Verify: `web-client/js/terminal.test.js`
- Verify: `README.md`
- Verify: `docs/runbook-safe-startup.md`
- Verify: `docs/需求文档/WebRemoteDesktop-需求文档.md`

- [ ] **Step 1: Run the complete automated verification suite for the shared-terminal slice**

Run:

```bash
node --test signal-server/test/terminal-session-manager.test.js signal-server/test/terminal-bootstrap.test.js signal-server/test/terminal-auth.test.js signal-server/websocket/terminal.test.js web-client/js/terminal.test.js
```

Expected: PASS with `0` failures.

- [ ] **Step 2: Restart local services using repo-approved commands only**

Run:

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
./scripts/restart-host.sh
./scripts/status-safe-wrd.sh
```

Expected:

- host restarts through LaunchAgent-backed flow
- status output reflects local service truth without restarting tunnel

If the local signal server is not already running, start it in a separate user terminal first or state that runtime proof is blocked by missing local service startup.

- [ ] **Step 3: Verify the local HTTP/runtime endpoints and capture the two required passwords from runtime config**

Run:

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/api/status
node -e 'require("dotenv").config({ path: "signal-server/.env" }); console.log("VIEWER_ACCESS_PASSWORD=" + (process.env.VIEWER_ACCESS_PASSWORD || process.env.ACCESS_PASSWORD || "")); console.log("WRD_TERMINAL_ADMIN_PASSWORD=" + (process.env.WRD_TERMINAL_ADMIN_PASSWORD || ""));'
```

Expected:

- `/health` returns `{"status":"ok",...}`
- `/api/status` returns `hostOnline: true`
- password output contains both Viewer and Terminal admin values from runtime config

- [ ] **Step 4: Perform manual runtime proof for terminal independence**

Manual verification checklist:

1. Open `http://127.0.0.1:8080`.
2. Complete Viewer login and terminal admin auth.
3. Create a shared session from browser A.
4. Open a second browser/session and attach to the same shared session.
5. Confirm both sessions show the same output after a command such as `pwd`.
6. Confirm input from both browsers affects the same shell.
7. Close browser A and reopen it.
8. Confirm it can reattach and sees replayed recent output.
9. Change desktop network mode and use desktop `断开连接`.
10. Confirm browser B’s shared terminal remains alive throughout.

Record the result in the work log or final report with explicit pass/fail per item.

- [ ] **Step 5: Run a final code review pass before closing the work**

Run:

```bash
git diff --stat HEAD~4..HEAD
git diff --check
```

Expected:

- only the shared-terminal slice and required docs changed
- no whitespace or patch-format issues

- [ ] **Step 6: Commit the verification or report the exact blocker**

If verification required final fixes, commit them:

```bash
git add signal-server web-client README.md docs/runbook-safe-startup.md docs/需求文档/WebRemoteDesktop-需求文档.md
git commit -m "test: verify shared terminal pool behavior"
```

If runtime proof is blocked by missing local service state, do not fake completion; report the exact missing condition and keep the code verified by automated tests only.
