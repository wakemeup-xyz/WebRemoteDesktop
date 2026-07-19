# Shared Terminal 安全、生命周期与可观测性加固实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 `2026-07-19-terminal-hardening-design.md` 定义的 Terminal 环境隔离、PTY 生命周期、流控、权限和运维可观测性加固。

**Architecture:** 保留现有 Socket.IO shared Terminal 对外协议，在 Signal Server 内建立 `TerminalEnvironment`、`TerminalLifecycle`、`TerminalFlowControl` 和 `TerminalMetrics` 四个深模块。`session-manager.js` 只组合这些模块，Socket handler 负责认证和协议适配，前端只消费稳定 snapshot/error/metrics contract。

**Tech Stack:** Node.js built-in test runner、Express、Socket.IO、`node-pty`、xterm.js、现有 structured logger 和 audit sink。

**Spec Coverage:** 覆盖完整 spec；不包含独立直连 WSS、Cloudflare 路由优化或媒体链路变更。

**Truth Source:** `signal-server/lib/terminal/config.js` 是配置真相；新增 `environment.js`、`lifecycle.js`、`flow-control.js`、`metrics.js` 分别是真实运行边界；`session-manager.js` 是 session/observer/presenter 真相；`web-client/js/terminal.js` 是浏览器 UI/reconnect 真相。

**Compatibility Notes:** 保留现有 `terminal:*` 事件和 legacy alias 作为 Socket adapter 兼容层；内部只处理 canonical event 一次。保留 `WRD_TERMINAL_RECORD_IO` 名称，但语义改为 metadata-only。默认关闭 polling；显式开启时保留 fallback。

**Impact Map:**
- **Truth Source:** Terminal config、PTY lifecycle、observer identity、flow-control 和 bounded metrics。
- **Backend:** `signal-server/lib/terminal/*`、`session-manager.js`、`websocket/terminal.js`、`routes/auth.js`、`server.js`。
- **Frontend:** `web-client/js/terminal.js` 和 focused tests，处理 exited/failed/error、requestId、transport 和 metrics。
- **Runtime Proof:** 本地 Terminal env、exited input rejection、rate limit、admin metrics、fixed-domain URL unchanged。
- **Docs/Skills:** 更新 Terminal 需求文档、README/runbook 和相关性能报告；不改 skill 缓存。
- **Commit Boundary:** 每个任务形成一个可独立测试的 commit；不包含当前 worktree 的无关 `.agents`、日志和多行 composer 文件。

**Definition of Done:**
- PTY 不再继承服务密钥，`python3` 和 `/usr/bin/env python3` 都解析到配置的 Homebrew 3.11。
- spawn error、startup timeout、exited input、close permission、rate limit 和 backpressure 都有稳定错误/审计/测试。
- admin metrics endpoint 能返回 bounded counters 和 latency summaries，且不包含 raw command/output。
- Signal Server 和 Terminal focused tests 全部通过，运行时验收不改变现有 tunnel。

---

### Task 1: Normalize Terminal configuration

**Files:**
- Modify: `signal-server/lib/config.js`
- Modify: `signal-server/lib/terminal/config.js`
- Test: `signal-server/test/config.test.js`
- Test: `signal-server/test/terminal-config.test.js`

- [ ] **Step 1: Add failing tests for finite bounded config**

Add table-driven tests for `WRD_TERMINAL_MAX_SESSIONS=NaN`, negative idle timeout, oversized replay buffer, and `WRD_TERMINAL_SHELL=/bin/sh`. Each case must assert the exact configuration key in the thrown message.

- [ ] **Step 2: Run the focused config tests**

```bash
cd signal-server
node --test test/config.test.js test/terminal-config.test.js
```

Expected: FAIL because current parsing accepts `NaN`, negative values, oversized buffers, and arbitrary shell paths.

- [ ] **Step 3: Implement one normalized Terminal config**

Add these helpers and limits in `signal-server/lib/terminal/config.js`:

```js
const ALLOWED_SHELLS = new Set(['/bin/zsh', '/bin/bash']);
const LIMITS = {
  maxSessions: [1, 32],
  softWarnSessionCount: [0, 32],
  replayBufferBytes: [1024, 8 * 1024 * 1024],
  idleTimeoutMs: [0, 24 * 60 * 60 * 1000],
  startupTimeoutMs: [1000, 120000],
  inputBytesPerSecond: [1024, 1024 * 1024],
  inputBurstBytes: [1024, 2 * 1024 * 1024],
  maxObserverQueueBytes: [64 * 1024, 8 * 1024 * 1024],
};

function boundedInt(name, raw, [min, max], fallback) {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`[config] ${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
```

`parseTerminalConfig(env)` must return enabled/adminPassword/shell/cwd, an absolute-directory-only `WRD_TERMINAL_PATH_EXTRA` list, bounded session/replay/idle/startup values, input rate, observer queue limit, `allowPolling`, audit path, and `recordIoMetadata`. Require cwd to be absolute and an existing directory when non-empty. Make `loadConfig()` consume this result instead of parsing Terminal fields again.

- [ ] **Step 4: Run tests and verify compatibility defaults**

```bash
cd signal-server
node --test test/config.test.js test/terminal-config.test.js
```

Expected: PASS; default shell remains `/bin/zsh` and max sessions remains `8`.

- [ ] **Step 5: Commit the config boundary**

```bash
git add signal-server/lib/config.js signal-server/lib/terminal/config.js signal-server/test/config.test.js signal-server/test/terminal-config.test.js
git commit -m "fix(terminal): validate normalized runtime configuration"
```

### Task 2: Isolate PTY environment and deterministic PATH

**Files:**
- Create: `signal-server/lib/terminal/environment.js`
- Modify: `signal-server/lib/terminal/session-manager.js`
- Test: `signal-server/test/terminal-environment.test.js`
- Modify: `signal-server/test/terminal-session-manager.test.js`

- [ ] **Step 1: Write the failing environment test**

```js
const env = buildTerminalEnvironment({
  HOME: '/Users/tester',
  USER: 'tester',
  SHELL: '/bin/zsh',
  PATH: '/usr/bin:/bin',
  JWT_SECRET: 'secret',
  WRD_TERMINAL_ADMIN_PASSWORD: 'password',
  HTTPS_PROXY: 'http://secret-proxy',
  ANTHROPIC_AUTH_TOKEN: 'token',
});

assert.equal(env.JWT_SECRET, undefined);
assert.equal(env.WRD_TERMINAL_ADMIN_PASSWORD, undefined);
assert.equal(env.HTTPS_PROXY, undefined);
assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
assert.equal(env.PATH.includes('/Users/tester/.homebrew/opt/python@3.11/libexec/bin'), true);
assert.deepEqual(getTerminalShellArgs('/bin/zsh'), ['-f', '-i']);
assert.deepEqual(getTerminalShellArgs('/bin/bash'), ['--noprofile', '--norc', '-i']);
```

- [ ] **Step 2: Run the failing test**

Run `node --test signal-server/test/terminal-environment.test.js`.

Expected: FAIL because the module does not exist and current code copies secrets.

- [ ] **Step 3: Implement the allowlist environment module**

Create `buildTerminalEnvironment(baseEnv, options)` that copies only `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `COLORTERM`, `LANG`, and `LC_*`. Construct PATH from `path.dirname(process.execPath)`, `${HOME}/.homebrew/bin`, `${HOME}/.homebrew/sbin`, `${HOME}/.homebrew/opt/python@3.11/libexec/bin`, `${HOME}/.local/bin`, `${HOME}/.bun/bin`, and absolute system PATH entries. Reject empty and relative entries. Export `getTerminalShellArgs()` so zsh always uses `['-f', '-i']` and bash uses `['--noprofile', '--norc', '-i']`; personal shell rc files must not be sourced.

- [ ] **Step 4: Wire the new environment into node-pty**

Replace the current `ptyFactory(config.shell, [], options)` call with:

```js
const shellArgs = getTerminalShellArgs(config.shell);
const pty = ptyFactory(config.shell, shellArgs, {
  name: 'xterm-256color',
  cols,
  rows,
  cwd: config.cwd || undefined,
  env: buildTerminalEnvironment(process.env, {
    pathEntries: config.pathEntries,
  }),
});
```

Keep `buildTerminalEnv` as a compatibility export delegating to `buildTerminalEnvironment` until existing imports migrate.

- [ ] **Step 5: Run environment and session tests**

```bash
node --test signal-server/test/terminal-environment.test.js signal-server/test/terminal-session-manager.test.js
```

Expected: PASS; secret absence and Homebrew Python path order are asserted.

- [ ] **Step 6: Commit the environment boundary**

```bash
git add signal-server/lib/terminal/environment.js signal-server/lib/terminal/session-manager.js signal-server/test/terminal-environment.test.js signal-server/test/terminal-session-manager.test.js
git commit -m "fix(terminal): isolate pty environment and python path"
```

### Task 3: Add explicit PTY lifecycle state machine

**Files:**
- Create: `signal-server/lib/terminal/lifecycle.js`
- Modify: `signal-server/lib/terminal/session-manager.js`
- Modify: `signal-server/websocket/terminal.js`
- Test: `signal-server/test/terminal-lifecycle.test.js`
- Modify: `signal-server/websocket/terminal.test.js`
- Modify: `signal-server/test/terminal-session-manager.test.js`
- Modify: `web-client/js/terminal.js`
- Modify: `web-client/js/terminal.test.js`

- [ ] **Step 1: Add lifecycle transition tests**

```js
assert.equal(transitionProcessState('starting', 'ready'), 'running');
assert.equal(transitionProcessState('running', 'exit'), 'exited');
assert.equal(makeWriteError('starting').code, 'pty_starting');
assert.equal(makeWriteError('exited').code, 'pty_exited');
assert.throws(() => transitionProcessState('closed', 'ready'), /invalid terminal lifecycle transition/);
```

- [ ] **Step 2: Run lifecycle tests to verify failure**

Run `node --test signal-server/test/terminal-lifecycle.test.js`.

Expected: FAIL until the module exists.

- [ ] **Step 3: Implement process state and stable errors**

Create constants for `starting`, `running`, `exited`, `failed`, and `closed`. Export `transitionProcessState`, `assertProcessWritable`, and `makeTerminalError`. Add `processStatus` to session snapshots while retaining `status` for observer presence.

```js
const PROCESS_STATUS = Object.freeze({
  STARTING: 'starting',
  RUNNING: 'running',
  EXITED: 'exited',
  FAILED: 'failed',
  CLOSED: 'closed',
});
const TERMINAL_ERROR = Object.freeze({
  SPAWN_FAILED: 'pty_spawn_failed',
  STARTING: 'pty_starting',
  STARTUP_TIMEOUT: 'pty_startup_timeout',
  EXITED: 'pty_exited',
});
```

- [ ] **Step 4: Integrate spawn, first-output readiness, timeout, and one-shot exit**

In `createSession()`:

1. validate shell/cwd;
2. catch `ptyFactory` and throw `pty_spawn_failed` without adding a session;
3. create `processStatus: 'starting'` and one startup timer;
4. transition on first `onData`, clear timer, record ready duration;
5. on timeout kill once, mark failed, emit timeout error/exit;
6. on exit process exactly once and mark failed or exited according to prior state.

- [ ] **Step 5: Reject writes and resize for non-running PTYs**

`writeInput()` must call `assertProcessWritable()` before `pty.write()`. The Socket handler sends `terminal:input_ack` only after a successful write. Starting/exited/failed sessions return `terminal:error` and zero ack.

- [ ] **Step 6: Add frontend process state handling**

Store `processStatus` in normalized frontend session state. Preserve replay and close controls for failed/exited sessions, disable input, and render stable status messages.

- [ ] **Step 7: Run lifecycle integration tests**

```bash
node --test signal-server/test/terminal-lifecycle.test.js signal-server/test/terminal-session-manager.test.js signal-server/websocket/terminal.test.js
node --test web-client/js/terminal.test.js
```

Expected: PASS; a fake exited PTY receives no write and the client receives no ack.

- [ ] **Step 8: Commit lifecycle behavior**

```bash
git add signal-server/lib/terminal/lifecycle.js signal-server/lib/terminal/session-manager.js signal-server/websocket/terminal.js signal-server/test/terminal-lifecycle.test.js signal-server/test/terminal-session-manager.test.js signal-server/websocket/terminal.test.js web-client/js/terminal.js web-client/js/terminal.test.js
git commit -m "fix(terminal): enforce pty lifecycle states"
```

### Task 4: Enforce session identity and close permissions

**Files:**
- Modify: `signal-server/websocket/terminal.js`
- Modify: `signal-server/lib/terminal/session-manager.js`
- Test: `signal-server/websocket/terminal.test.js`
- Modify: `web-client/js/terminal.js`
- Modify: `web-client/js/terminal.test.js`

- [ ] **Step 1: Add failing identity and close tests**

Assert that an authenticated but unattached socket receives `terminal_session_not_attached` when closing a known session. Assert that changing the browser client label does not change server-owned observer identity. Assert that create `requestId` is returned only to its creator.

- [ ] **Step 2: Implement server-owned socket identity**

Use `socket.id` for authorization and presence. Keep the handshake client id as a length-limited `clientLabel` used only for diagnostics. Remove client label from `isObserverAttached`, presenter, close, and creator decisions.

```js
const clientId = socket.id;
const clientLabel = String(socket.handshake?.auth?.clientId || '').slice(0, 128);
```

- [ ] **Step 3: Add requestId-based create correlation**

The browser sends `{ requestId, title, cols, rows }`. Echo requestId only in the creator socket response; omit it from broadcast snapshots. Replace `pendingCreateClientId` with `pendingCreateRequestId` in the frontend.

```js
const requestId = typeof payload.requestId === 'string'
  ? payload.requestId.slice(0, 128)
  : null;
socket.emit('terminal:session_created', { ...created, requestId });
terminalNamespace.except(socket.id).emit('terminal:session_created', created);
```

- [ ] **Step 4: Enforce close authorization**

Require an attached observer for close. Allow only internal `system:idle-timeout` and `system:shutdown` reasons to bypass observer checks. Emit a redacted rejection audit event.

- [ ] **Step 5: Run identity tests**

Run `node --test signal-server/websocket/terminal.test.js web-client/js/terminal.test.js`.

Expected: PASS with unauthorized close and forged label cases covered.

- [ ] **Step 6: Commit identity boundary**

```bash
git add signal-server/websocket/terminal.js signal-server/lib/terminal/session-manager.js signal-server/websocket/terminal.test.js web-client/js/terminal.js web-client/js/terminal.test.js
git commit -m "fix(terminal): bind session actions to socket identity"
```

### Task 5: Add input limits and observer output backpressure

**Files:**
- Create: `signal-server/lib/terminal/flow-control.js`
- Modify: `signal-server/lib/terminal/session-manager.js`
- Modify: `signal-server/websocket/terminal.js`
- Test: `signal-server/test/terminal-flow-control.test.js`
- Modify: `signal-server/websocket/terminal.test.js`

- [ ] **Step 1: Write token bucket and queue failure tests**

Use an injected clock. A bucket with 10 bytes/second and 10 burst bytes must accept 10 bytes, reject the next byte, and accept it after advancing 1000ms. A queue above 512 KiB must warn once and detach only that observer.

- [ ] **Step 2: Run focused flow-control tests**

Run `node --test signal-server/test/terminal-flow-control.test.js`.

Expected: FAIL until the module exists.

- [ ] **Step 3: Implement `TerminalInputBucket`**

Expose `consume(bytes, nowMs)` and `snapshot()`. Charge UTF-8 byte length and return `{ accepted, retryAfterMs, remainingBytes }`. Never store input data.

```js
class TerminalInputBucket {
  constructor({ bytesPerSecond, burstBytes, now = () => Date.now() }) {}
  consume(bytes) {
    // Refill from elapsed milliseconds, then atomically accept or reject.
  }
  snapshot() {}
}
```

- [ ] **Step 4: Implement `TerminalOutputDispatcher`**

Each observer owns a byte-bounded queue and one drain loop. Put the complete output chunk into session replay before dispatch. On overflow, emit one warning, audit bounded stats, detach only the slow observer, and preserve the PTY and other observers.

```js
class TerminalOutputDispatcher {
  constructor({ maxQueueBytes, schedule = setImmediate }) {}
  attach(observerId, callbacks) {}
  enqueue(observerId, data) {}
  detach(observerId, reason) {}
  queuedBytes(observerId) {}
}
```

- [ ] **Step 5: Wire input and output paths**

Charge input before `writeInput()` and return `terminal_input_rate_limited` on rejection. Keep the separate 64 KiB single-message guard. Route all PTY output through the dispatcher without changing per-observer ordering.

- [ ] **Step 6: Run flow-control and full Signal tests**

```bash
node --test signal-server/test/terminal-flow-control.test.js signal-server/websocket/terminal.test.js
cd signal-server
node --test
```

Expected: PASS; existing shared-output and replay tests remain green.

- [ ] **Step 7: Commit flow control**

```bash
git add signal-server/lib/terminal/flow-control.js signal-server/lib/terminal/session-manager.js signal-server/websocket/terminal.js signal-server/test/terminal-flow-control.test.js signal-server/websocket/terminal.test.js
git commit -m "fix(terminal): bound input and observer output flow"
```

### Task 6: Add bounded Terminal metrics and route-specific auth limits

**Files:**
- Create: `signal-server/lib/terminal/metrics.js`
- Modify: `signal-server/server.js`
- Modify: `signal-server/routes/auth.js`
- Modify: `signal-server/websocket/terminal.js`
- Test: `signal-server/test/terminal-metrics.test.js`
- Modify: `signal-server/test/terminal-auth.test.js`
- Modify: `signal-server/test/terminal-bootstrap.test.js`

- [ ] **Step 1: Add metrics contract tests**

Assert that `TerminalMetrics.snapshot()` contains only counters and `{ sampleCount, p50, p95, last }`, limits each sample series to 100, and never contains data/key/text/password/token values.

- [ ] **Step 2: Implement bounded metrics**

Create `recordCounter(name, delta)`, `recordLatency(name, value)`, and `snapshot()`. Keep names in a fixed allowlist and discard oldest latency samples above 100.

```js
const COUNTERS = new Set([
  'auth_success', 'auth_rejected', 'socket_connected', 'socket_disconnected',
  'session_created', 'session_attach', 'session_detach', 'session_closed',
  'pty_spawn_failed', 'pty_startup_timeout', 'pty_exited',
  'input_accepted', 'input_rate_limited', 'input_rejected',
  'output_bytes', 'output_chunks', 'output_backpressure',
]);
const LATENCIES = new Set(['attach_ms', 'pty_ready_ms', 'server_input_process_ms']);
```

- [ ] **Step 3: Instrument Terminal paths**

Record auth, socket, session, lifecycle, input, output, backpressure, attach latency, PTY ready latency, and server processing duration. Store only numeric values, bounded IDs, status, and transport.

- [ ] **Step 4: Add the admin metrics endpoint**

Add `GET /api/admin/terminal/metrics` returning `{ metrics, pool }`. Require admin bearer token and reuse the bounded pool snapshot. Extend `/api/terminal/bootstrap` with `allowPolling` so frontend transport policy comes from the same normalized config.

- [ ] **Step 5: Split auth limiters**

Use independent middleware stores: viewer login 20/15min/IP, host login 60/15min/IP, admin login 5/15min/IP plus process-wide 100/15min, verify 120/15min/IP. Tests must prove viewer attempts do not consume the admin bucket.

```js
const authLimiters = {
  viewer: rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }),
  host: rateLimit({ windowMs: 15 * 60 * 1000, max: 60 }),
  admin: rateLimit({ windowMs: 15 * 60 * 1000, max: 5 }),
  verify: rateLimit({ windowMs: 15 * 60 * 1000, max: 120 }),
};
```

- [ ] **Step 6: Clarify record IO semantics**

Rename the internal property to `recordIoMetadata`; preserve the environment variable as a compatibility alias. Audit metadata can include byte/chunk counts but never raw PTY contents.

- [ ] **Step 7: Run metrics and auth tests**

```bash
node --test signal-server/test/terminal-metrics.test.js signal-server/test/terminal-auth.test.js signal-server/test/terminal-bootstrap.test.js
cd signal-server
node --test
```

Expected: PASS; metrics endpoint rejects viewer tokens and route limiters remain independent.

- [ ] **Step 8: Commit metrics and auth**

```bash
git add signal-server/lib/terminal/metrics.js signal-server/server.js signal-server/routes/auth.js signal-server/websocket/terminal.js signal-server/test/terminal-metrics.test.js signal-server/test/terminal-auth.test.js signal-server/test/terminal-bootstrap.test.js
git commit -m "feat(terminal): add bounded metrics and auth limits"
```

### Task 7: Make frontend transport and lifecycle states explicit

**Files:**
- Modify: `web-client/js/terminal.js`
- Modify: `web-client/js/terminal.test.js`
- Modify: `web-client/js/runtime-config.js` if transport policy is exposed through bootstrap

- [ ] **Step 1: Add failing UI tests**

Cover: `pty_exited` disables active input; rate limiting shows warning without destroying the tab; requestId selects only local create; polling is not requested by default; websocket and polling metrics are separated.

- [ ] **Step 2: Implement explicit transport selection**

```js
const transports = this.allowPolling ? ['websocket', 'polling'] : ['websocket'];
this.socket = io(`${RuntimeConfig.getSocketBase()}/terminal`, {
  auth: { token, clientId: this.getBrowserSessionId() },
  transports,
  rememberUpgrade: true,
});
```

The supplied client id is only a diagnostic label; socket identity remains authoritative.

- [ ] **Step 3: Implement lifecycle and error rendering**

Store `processStatus` in normalized sessions. Disable xterm/composer input unless it is `running`. Map stable error codes to concise text, while keeping replay and close for exited/failed sessions.

- [ ] **Step 4: Replace create matching with requestId**

Generate requestId before `terminal:create_session`, match only the creator response, and continue treating the fresh pool snapshot as the authority before reattach. Normalize canonical and legacy aliases into one idempotent handler so a state transition is applied once per session/event sequence.

- [ ] **Step 5: Run frontend tests**

Run `node --test web-client/js/terminal.test.js web-client/js/terminal-echo-controller.test.js`.

Expected: PASS with previous reconnect and safe-echo behavior intact.

- [ ] **Step 6: Commit frontend contract**

```bash
git add web-client/js/terminal.js web-client/js/terminal.test.js web-client/js/runtime-config.js
git commit -m "fix(terminal): expose explicit lifecycle and transport states"
```

### Task 8: Synchronize docs and add runtime acceptance checks

**Files:**
- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md`
- Modify: `README.md`
- Modify: `docs/runbook-safe-startup.md`
- Modify: `docs/superpowers/reports/2026-07-11-terminal-performance-analysis.md`
- Modify: `signal-server/.env.example`
- Create: `scripts/terminal-runtime-check.sh`
- Test: `scripts/terminal-runtime-check.test.js`
- Create: `scripts/terminal-runtime-probe.js`
- Test: `scripts/terminal-runtime-probe.test.js`

- [ ] **Step 1: Add the runtime-check failing test**

Inspect the script source for: no tunnel restart command, explicit `command -v python3`, `/usr/bin/env python3`, secret-name checks, `/api/admin/terminal/metrics`, and exited-session guidance.

- [ ] **Step 2: Implement a read-only runtime checker**

The script must query local health/status, read but never modify the current URL file, run environment-key/Python probes through a new Terminal when credentials are supplied, query admin metrics when a runtime token is supplied, and fail on secret-name leakage, wrong Python path, unhealthy service, or invalid metrics. It may print environment variable names but must never print values. It must never call stop/restart tunnel commands or `launchctl remove`.

- [ ] **Step 3: Update docs**

Document allowlisted PTY environment, no-rc shell behavior, Homebrew Python path, `WRD_TERMINAL_PATH_EXTRA`, lifecycle errors, flow limits, auth limits, metadata-only IO flag, polling default, metrics endpoint, and external RTT constraint. Distinguish same-process network reconnect from service-restart session loss.

- [ ] **Step 4: Run documentation and runtime-check tests**

```bash
bash -n scripts/terminal-runtime-check.sh
node --test scripts/terminal-runtime-check.test.js scripts/terminal-runtime-probe.test.js
git diff --check
```

Expected: PASS; URL file and tunnel process remain unchanged.

- [ ] **Step 5: Commit docs and checker**

```bash
git add docs/需求文档/WebRemoteDesktop-需求文档.md README.md docs/runbook-safe-startup.md docs/superpowers/reports/2026-07-11-terminal-performance-analysis.md signal-server/.env.example scripts/terminal-runtime-check.sh scripts/terminal-runtime-check.test.js
git commit -m "docs(terminal): document hardening and runtime checks"
```

### Task 9: Final verification and review closure

**Files:**
- Inspect every file changed by Tasks 1-8.
- Update: `docs/superpowers/reports/2026-07-19-terminal-hardening-review.md`

- [ ] **Step 1: Run the complete Signal Server suite**

Run `cd signal-server && node --test`.

Expected: all tests pass with no unhandled rejection or leaked timer.

- [ ] **Step 2: Run focused frontend and shell suites**

```bash
node --test web-client/js/terminal.test.js web-client/js/terminal-echo-controller.test.js
node --test scripts/terminal-runtime-check.test.js scripts/terminal-runtime-probe.test.js
bash -n scripts/terminal-runtime-check.sh scripts/run-signal.sh scripts/start-safe-wrd.sh scripts/run-host-launchctl.sh
git diff --check
```

- [ ] **Step 3: Execute local runtime acceptance**

With user-managed services running, capture health/status, secret-free PTY env, Homebrew Python for both command forms, exited input rejection, bounded metrics JSON, and the unchanged `/tmp/wrd-safe-current-url.txt` value.

- [ ] **Step 4: Perform final review**

Verify no raw command/output enters logs, no new script restarts tunnel, no legacy alias triggers duplicate state transitions, and all Terminal config fields have one canonical parser.

- [ ] **Step 5: Commit the closure record**

```bash
git add docs/superpowers/reports/2026-07-19-terminal-hardening-review.md
git commit -m "docs(terminal): close hardening review"
```
