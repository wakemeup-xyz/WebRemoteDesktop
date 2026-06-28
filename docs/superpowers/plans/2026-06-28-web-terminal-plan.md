# Web Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Viewer 页面中加入可切换的多会话 Web Terminal，支持 viewer 入口后的 admin 二次授权、完整 shell、断网自动重连到原会话，以及 `http://localhost:5173/` 的开发映射入口。

**Architecture:** 前端在现有 `viewer.html` 中增加 terminal tab 和独立会话管理模块，终端渲染使用 `@xterm/xterm`。后端在 `signal-server` 中新增 terminal 配置、session manager 和独立 Socket.IO namespace，使用 `node-pty` 直接启动本机 shell。授权基于现有 viewer 登录后的浏览器会话级 admin token，诊断与日志沿用现有信令服务的结构化事件风格，但不把 terminal 流量接入 STUN/TURN/WebRTC。

**Tech Stack:** Vanilla JavaScript, Socket.IO, Node.js test runner, `node-pty`, xterm.js, Express, existing repo shell scripts

---

## 文件结构

| 文件 | 责任 |
|------|------|
| `signal-server/lib/terminal/config.js` | 新建，读取 terminal 开关、shell、cwd、软阈值、超时和审计配置 |
| `signal-server/lib/terminal/session-manager.js` | 新建，管理 PTY 创建、attach/detach、输入、resize、关闭和状态快照 |
| `signal-server/lib/terminal/audit.js` | 新建，统一 terminal 审计日志格式 |
| `signal-server/websocket/terminal.js` | 新建，注册 `/terminal` Socket.IO namespace 和事件协议 |
| `signal-server/lib/config.js` | 修改，加入 terminal 配置读取与默认值 |
| `signal-server/routes/auth.js` | 修改，加入 admin 二次授权登录接口 |
| `signal-server/server.js` | 修改，挂载 terminal namespace，并暴露 terminal 配置给前端需要的 HTTP 接口 |
| `signal-server/package.json` | 修改，加入 `node-pty` 依赖 |
| `signal-server/test/terminal-config.test.js` | 新建，覆盖 terminal 配置解析和默认值 |
| `signal-server/test/terminal-session-manager.test.js` | 新建，覆盖 session 创建、attach/detach、重连和软提示 |
| `signal-server/test/terminal-auth.test.js` | 新建，覆盖 admin 登录和 token 权限 |
| `signal-server/websocket/terminal.test.js` | 新建，覆盖 namespace 事件路由和重连 attach 逻辑 |
| `web-client/js/runtime-config.js` | 新建，统一 API base / Socket.IO base 解析 |
| `web-client/js/terminal.js` | 新建，terminal tab、会话列表、多会话绑定、自动重连和 xterm 生命周期 |
| `web-client/viewer.html` | 修改，加入 terminal tab 与脚本加载顺序 |
| `web-client/css/viewer.css` | 修改，加入 terminal tab / workspace / warning 样式 |
| `web-client/js/auth.js` | 修改，统一使用 runtime API base |
| `web-client/js/webrtc.js` | 修改，继续保持桌面逻辑不变，但不再承担 terminal 相关职责 |
| `web-client/js/terminal.test.js` | 新建，覆盖多 tab、自动重连、软提示和未授权状态 |
| `web-client/js/runtime-config.test.js` | 新建，覆盖 API base 选择逻辑 |
| `README.md` | 修改，补充 terminal 功能、二次授权和开发入口说明 |
| `docs/runbook-safe-startup.md` | 修改，补充 terminal 不影响 safe tunnel 的约束 |
| `docs/需求文档/WebRemoteDesktop-需求文档.md` | 已更新，必要时再修正术语或验收标准 |

---

### Task 1: Terminal 配置、授权和会话模型

**Files:**
- Create: `signal-server/lib/terminal/config.js`
- Create: `signal-server/lib/terminal/session-manager.js`
- Create: `signal-server/lib/terminal/audit.js`
- Modify: `signal-server/lib/config.js`
- Modify: `signal-server/routes/auth.js`
- Modify: `signal-server/package.json`
- Test: `signal-server/test/terminal-config.test.js`
- Test: `signal-server/test/terminal-session-manager.test.js`
- Test: `signal-server/test/terminal-auth.test.js`

- [x] **Step 1: Write failing tests for config, admin auth, and session lifecycle**

Add tests that assert:

```js
const config = loadConfig();
assert.equal(config.enableTerminal, false);
assert.equal(config.terminalSoftWarnSessionCount, 4);
assert.equal(config.terminalIdleTimeoutMs, 0);
assert.equal(config.terminalShell, '/bin/zsh');
```

```js
const sessionManager = createTerminalSessionManager({ ptyFactory: fakePtyFactory });
const created = sessionManager.createSession({ ownerSub: 'admin-1', cols: 120, rows: 32 });
assert.equal(created.status, 'running');
assert.equal(created.sessionId.startsWith('term_'), true);
```

```js
const attach = sessionManager.attachSession(created.sessionId, { ownerSub: 'admin-1' });
assert.equal(attach.sessionId, created.sessionId);
assert.equal(attach.status, 'attached');
```

```js
const auth = await loginAdmin('correct-password');
assert.equal(auth.role, 'admin');
```

Also assert that a soft threshold breach emits a warning rather than rejecting session creation.

- [x] **Step 2: Run the new tests and verify they fail**

Run:

```bash
node --test signal-server/test/terminal-config.test.js signal-server/test/terminal-session-manager.test.js signal-server/test/terminal-auth.test.js
```

Expected: FAIL because `enableTerminal`, admin login, and session manager APIs do not exist yet.

- [x] **Step 3: Implement config, admin auth, and the terminal session manager**

Implement:

```js
// signal-server/lib/terminal/config.js
function loadTerminalConfig() {
  return {
    enabled: process.env.WRD_ENABLE_TERMINAL === '1',
    adminPassword: String(process.env.WRD_TERMINAL_ADMIN_PASSWORD || '').trim(),
    shell: String(process.env.WRD_TERMINAL_SHELL || '/bin/zsh').trim(),
    cwd: String(process.env.WRD_TERMINAL_CWD || process.cwd()).trim(),
    softWarnSessionCount: Number(process.env.WRD_TERMINAL_SOFT_WARN_SESSION_COUNT || 4),
    idleTimeoutMs: Number(process.env.WRD_TERMINAL_IDLE_TIMEOUT_MS || 0),
    startupTimeoutMs: Number(process.env.WRD_TERMINAL_STARTUP_TIMEOUT_MS || 10000),
    auditLog: process.env.WRD_TERMINAL_AUDIT_LOG !== '0',
    recordIo: process.env.WRD_TERMINAL_RECORD_IO === '1',
  };
}
```

```js
// signal-server/lib/terminal/session-manager.js
function createTerminalSessionManager({ ptyFactory, logger, now }) {
  return {
    createSession(input) {},
    attachSession(sessionId, input) {},
    detachSession(sessionId, reason) {},
    closeSession(sessionId, reason) {},
    listSessions(ownerSub) {},
    getSnapshot() {},
  };
}
```

```js
// signal-server/routes/auth.js
router.post('/login/admin', (req, res) => {
  const { adminPassword } = loadTerminalConfig();
  // validate password, signAccessToken('admin', 'terminal-admin-session')
});
```

The session manager should:
- create one PTY per session
- keep detached sessions alive until explicit close or server exit
- support reattach by `sessionId` after socket reconnect
- emit a soft warning when the session count exceeds `softWarnSessionCount`

- [x] **Step 4: Re-run the tests and verify they pass**

Run:

```bash
node --test signal-server/test/terminal-config.test.js signal-server/test/terminal-session-manager.test.js signal-server/test/terminal-auth.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add signal-server/package.json signal-server/lib/config.js signal-server/routes/auth.js signal-server/lib/terminal/config.js signal-server/lib/terminal/session-manager.js signal-server/lib/terminal/audit.js signal-server/test/terminal-config.test.js signal-server/test/terminal-session-manager.test.js signal-server/test/terminal-auth.test.js
git commit -m "feat: add terminal auth and session manager"
```

### Task 2: Terminal Socket.IO namespace and server wiring

**Files:**
- Create: `signal-server/websocket/terminal.js`
- Modify: `signal-server/server.js`
- Test: `signal-server/websocket/terminal.test.js`
- Test: `signal-server/websocket/signaling.test.js`

- [x] **Step 1: Write failing tests for namespace auth, attach, and reconnect**

Add tests that assert:

```js
const socket = terminalNamespaceSocket({ token: adminToken });
socket.emit('terminal:create', { cols: 120, rows: 32 });
socket.emit('terminal:attach', { sessionId: created.sessionId });
assert.equal(socket.received('terminal:created').sessionId, created.sessionId);
assert.equal(socket.received('terminal:warning').warning, 'session_count_above_soft_threshold');
```

Also assert that viewer tokens are rejected by the terminal namespace.

- [x] **Step 2: Run the namespace tests and verify they fail**

Run:

```bash
node --test signal-server/websocket/terminal.test.js signal-server/websocket/signaling.test.js
```

Expected: FAIL because `/terminal` namespace and attach flow do not exist yet.

- [x] **Step 3: Implement the namespace and wire it into server.js**

Add a dedicated `/terminal` namespace that:
- verifies JWT role is `admin`
- calls `sessionManager.createSession()` / `attachSession()` / `detachSession()` / `closeSession()`
- emits `terminal:snapshot`, `terminal:created`, `terminal:output`, `terminal:exit`, `terminal:warning`, and `terminal:error`
- keeps ordinary WebRTC signaling untouched

Update `server.js` to mount the namespace alongside the existing signaling namespace.

- [x] **Step 4: Re-run the namespace tests and verify they pass**

Run:

```bash
node --test signal-server/websocket/terminal.test.js signal-server/websocket/signaling.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add signal-server/websocket/terminal.js signal-server/server.js signal-server/websocket/terminal.test.js signal-server/websocket/signaling.test.js
git commit -m "feat: wire terminal socket namespace"
```

### Task 3: Frontend runtime config, terminal tab, and multi-session UI

**Files:**
- Create: `web-client/js/runtime-config.js`
- Create: `web-client/js/terminal.js`
- Modify: `web-client/viewer.html`
- Modify: `web-client/css/viewer.css`
- Modify: `web-client/js/auth.js`
- Modify: `web-client/js/webrtc.js`
- Test: `web-client/js/runtime-config.test.js`
- Test: `web-client/js/terminal.test.js`

- [x] **Step 1: Write failing tests for API base selection and terminal tab behavior**

Add tests that assert:

```js
RuntimeConfig.getApiBase() === 'http://127.0.0.1:8080'
RuntimeConfig.getSocketBase() === 'http://127.0.0.1:8080'
```

when the page is running from `http://localhost:5173/` and `window.__WRD_API_BASE__` is set.

Add tests that assert terminal UI behavior:

```js
const ui = TerminalUI.create({ maxVisibleTabs: 8 });
ui.openTab('term_1');
ui.openTab('term_2');
ui.attachSession('term_1');
assert.equal(ui.activeSessionId(), 'term_1');
assert.equal(ui.sessionCount(), 2);
```

Also assert that:
- admin authorization is required before creating a socket
- multiple tabs can attach to different sessions
- reconnect reattaches to the original session id
- the UI shows a soft warning when the session count crosses the threshold

- [x] **Step 2: Run the frontend tests and verify they fail**

Run:

```bash
node --test web-client/js/runtime-config.test.js web-client/js/terminal.test.js
```

Expected: FAIL because runtime config and terminal UI modules do not exist yet.

- [x] **Step 3: Implement runtime config and terminal UI**

Add a small runtime config helper and use it everywhere the page talks to the backend:

```js
const RuntimeConfig = {
  getApiBase() {
    return window.__WRD_API_BASE__ || localStorage.getItem('wrdApiBase') || window.location.origin;
  },
  getSocketBase() {
    return this.getApiBase();
  }
};
```

Build `terminal.js` as a self-contained module that:
- renders a terminal tab/workspace in the existing viewer
- uses `@xterm/xterm` and `@xterm/addon-fit`
- keeps a map of `sessionId -> xterm instance`
- reconnects the socket and reattaches all sessions automatically after network loss
- shows terminal warnings without blocking creation
- stores admin auth in `sessionStorage` only

Update `viewer.html` to load the new script before the existing viewer boot logic.

- [x] **Step 4: Re-run the frontend tests and verify they pass**

Run:

```bash
node --test web-client/js/runtime-config.test.js web-client/js/terminal.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web-client/js/runtime-config.js web-client/js/terminal.js web-client/viewer.html web-client/css/viewer.css web-client/js/auth.js web-client/js/webrtc.js web-client/js/runtime-config.test.js web-client/js/terminal.test.js
git commit -m "feat: add web terminal frontend"
```

### Task 4: Docs, verification, and launch/readme alignment

**Files:**
- Modify: `README.md`
- Modify: `docs/runbook-safe-startup.md`
- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md`
- Test: targeted runtime checks

- [ ] **Step 1: Update runtime docs for terminal behavior**

Document:
- viewer is still the main entry point
- terminal requires admin second-factor style authorization
- multiple terminal tabs share the same browser-session authorization
- terminal sessions persist until manual close or server restart
- terminal does not change Cloudflare tunnel behavior or safe quick tunnel URL
- `localhost:5173` can reach the same backend through proxy or runtime API base

- [ ] **Step 2: Run static verification**

Run:

```bash
node --test signal-server/test/terminal-config.test.js signal-server/test/terminal-session-manager.test.js signal-server/test/terminal-auth.test.js signal-server/websocket/terminal.test.js web-client/js/runtime-config.test.js web-client/js/terminal.test.js
```

Expected: PASS

Run:

```bash
bash -n signal-server/server.js signal-server/routes/auth.js
```

Expected: no output, exit 0

- [ ] **Step 3: Run runtime verification**

Run:

```bash
./scripts/status-safe-wrd.sh
curl -s http://127.0.0.1:8080/health
curl -s http://127.0.0.1:8080/api/status
```

Expected:
- existing viewer and host behavior still works
- no tunnel restart is required
- the new terminal code does not alter safe URL state

- [ ] **Step 4: Commit**

```bash
git add README.md docs/runbook-safe-startup.md docs/需求文档/WebRemoteDesktop-需求文档.md
git commit -m "docs: document web terminal workflow"
```

## Self-Review

Coverage check:
- viewer entry + admin second authorization -> Task 1, Task 2, Task 3
- full shell / complete PTY -> Task 1
- multiple terminal tabs -> Task 1, Task 3
- browser-session-level authorization -> Task 1, Task 3
- auto reconnect to original session -> Task 1, Task 2, Task 3
- manual close only destroy -> Task 1
- no hard upper limit, soft warning only -> Task 1, Task 2, Task 3
- localhost:5173 mapping -> Task 3, Task 4
- docs update -> Task 4

Placeholder scan: no TBD/TODO/implement later language used.

Type consistency: the plan consistently uses `sessionId`, `terminal:attach`, `terminal:warning`, `RuntimeConfig.getApiBase()`, and `createTerminalSessionManager()`.
