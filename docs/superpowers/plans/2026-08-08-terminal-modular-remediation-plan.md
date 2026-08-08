# Terminal 模块化拆分与 P0/P1 契约修复实施计划

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task-by-task. Do not spawn subagents unless the user explicitly authorizes delegation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/superpowers/specs/2026-08-08-terminal-modular-remediation-design.md` 完成 Terminal 深度模块边界拆分，并关闭 P0/P1 契约缺陷；Phase 1 可单独发布。

**Architecture:** 服务端在 `session-manager` 下引入纯 `geometry.js` / `presence.js`，扩展既有 `lifecycle.js` 为可等待 cleanup；前端把现有 `createTerminalState` 迁入唯一 SessionFsm，由 InputGate 经一个传输 seam 选择 SocketTransport 或 TurnTransport，Panel 只做 UI 编排。行为测试先于搬文件；TURN 硬拒绝；pending 按操作关联字段精确释放。

**Tech Stack:** Node.js `node:test`、Socket.IO、node-pty、xterm.js、Playwright（webtest）、现有 Express signal-server。

**Spec:** `docs/superpowers/specs/2026-08-08-terminal-modular-remediation-design.md`  
**Review baseline:** `docs/superpowers/reports/2026-08-08-terminal-systemic-review.md`

**Spec Coverage:** 覆盖 spec v3 的完整 Phase 1 + Phase 2；Task 5 是 Phase 1 发布门，Task 6 是总计划仍需完成的结构收尾。  

**Truth Source:** 服务端 `TerminalSessionManager` 仍是 PTY/session 权威；geometry、observer matching、process lifecycle/config 各有一个后端 owner；浏览器只由一个 SessionFsm 保存服务端状态投影。  

**Compatibility Notes:** 保留所有 `terminal:*` canonical events、legacy aliases、现有 resize error code 与 admin JWT；adapter 只读写兼容字段，内部模块只处理 canonical action。

**Truth sources after change:**
- Geometry: `signal-server/lib/terminal/geometry.js`
- Observers: `signal-server/lib/terminal/presence.js`
- Process states + kill helper: `signal-server/lib/terminal/lifecycle.js`
- Session/PTY orchestration: `signal-server/lib/terminal/session-manager.js`
- Browser session state + correlated pending operations: `web-client/js/terminal-session-fsm.js`（迁移现有 `createTerminalState`，禁止双状态源）
- Browser input allow: `web-client/js/terminal-input-gate.js`（新建）
- Transports: `terminal-socket-transport.js` / `terminal-turn-transport.js`（新建）
- DOM: `web-client/js/terminal.js`（变薄）

**Impact Map:**
- **Truth Source:** `geometry.js`、`presence.js`、`lifecycle.js`、`session-manager.js`、浏览器唯一 SessionFsm。
- **Backend:** `lib/terminal/*`、`websocket/terminal.js`、`lib/config.js`、`server.js`（shutdown owner）。
- **Frontend:** `web-client/js/terminal*.js`、`shell-guard.js`、build graph `signal-server/scripts/web-asset-graph.js`。
- **Runtime Proof:** terminal Node tests、`build:web`、用户管理的本地 8080 服务、ignored webtest artifact 与 runtime probe；不重建 tunnel。
- **Docs/Skills:** spec 状态、系统审查 closure、`signal-server/.env.example`、`docs/需求文档/WebRemoteDesktop-需求文档.md`；不修改 skill 缓存。
- **Commit Boundary:** 按 Task 提交；禁止混入 `*.log`、`.playwright-mcp`、ignored `artifacts/` 与无关 bootstrap 实验。

**Definition of Done:**
- Phase 1：G-01…G-06 自动化全绿，build 成功，现有本地 webtest 主路径与失败恢复路径通过。
- Structural completion：SessionFsm/InputGate/TurnTransport/SocketTransport 均由唯一 owner 取代原内联实现，不存在双状态源或 adapter 互调。
- Phase 2：G-07…G-09 自动化全绿，shutdown 有 await/幂等/失败摘要证据，closure 文档逐项列出证据与 residual。

**Out of scope residual:** Spec §2.3。

---

## File structure (create / modify)

| Path | Role |
|------|------|
| `web-client/js/shell-guard.js` | 已修竞态，Task 0 提交 |
| `web-client/js/shell-guard.test.js` | 已有回归 |
| `signal-server/lib/terminal/geometry.js` | **Create** 尺寸契约 |
| `signal-server/test/terminal-geometry.test.js` | **Create** |
| `signal-server/lib/terminal/presence.js` | **Create** 纯 observer Map 操作，返回 removed descriptors |
| `signal-server/test/terminal-presence.test.js` | **Create** |
| `signal-server/lib/terminal/lifecycle.js` | **Modify** kill/shutdown helpers (Phase 2) |
| `signal-server/lib/terminal/session-manager.js` | **Modify** 接线 geometry/presence/maxInFlight/cleanup |
| `signal-server/lib/config.js` | **Modify** maxInFlight 映射 (Phase 2) |
| `signal-server/lib/terminal/webrtc-gateway.js` | **Modify** 共享 geometry；peer close 精确删 bridge |
| `signal-server/websocket/terminal.js` | **Modify** 校验与 shutdown |
| `signal-server/server.js` | **Modify** shutdown 收割 (Phase 2) |
| `web-client/js/terminal-session-fsm.js` | **Create** |
| `web-client/js/terminal-session-fsm.test.js` | **Create** |
| `web-client/js/terminal-input-gate.js` | **Create** |
| `web-client/js/terminal-input-gate.test.js` | **Create** |
| `web-client/js/terminal-turn-transport.js` | **Create** |
| `web-client/js/terminal-turn-transport.test.js` | **Create** |
| `web-client/js/terminal-socket-transport.js` | **Create** |
| `web-client/js/terminal-socket-transport.test.js` | **Create** |
| `web-client/js/terminal.js` | **Modify** 编排 |
| `web-client/js/terminal.test.js` | **Modify** 失败路径 |
| `signal-server/scripts/web-asset-graph.js` | **Modify** 打包顺序纳入新脚本 |
| `artifacts/terminal-webtest-2026-08-08/terminal_webtest.py` | **Reuse only** runtime 验收；ignored artifact 不提交 |
| `signal-server/.env.example` | **Verify** maxInFlight 变量和值保持与实现一致 |
| `docs/需求文档/WebRemoteDesktop-需求文档.md` | **Modify** 补充 maxInFlight 运维语义 |

---

### Task 0: Commit ShellGuard fix (Phase 1 / G-01)

**Files:**
- Modify: `web-client/js/shell-guard.js`
- Modify: `web-client/js/shell-guard.test.js`

- [ ] **Step 1: Confirm working tree contains the race fix**

`DOMContentLoaded` handler must be:

```js
global.document.addEventListener('DOMContentLoaded', () => {
  if (!state.coreInstalled) setCoreControlsDisabled(true);
}, { once: true });
```

- [ ] **Step 2: Run tests**

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
node --test web-client/js/shell-guard.test.js
```

Expected: PASS (6 tests), including installCore-before-DCL and DCL-without-core.

- [ ] **Step 3: Rebuild web assets so live dist matches source**

```bash
cd signal-server && npm run build:web
```

Expected: exit 0; `web-client/dist/viewer.html` inline shell contains `coreInstalled||` guard (minified form of `!coreInstalled`).

- [ ] **Step 4: Commit only shell-guard sources (and tests)**

```bash
git add web-client/js/shell-guard.js web-client/js/shell-guard.test.js
git commit -m "$(cat <<'EOF'
fix(viewer): keep core controls enabled after deferred installCore

DOMContentLoaded no longer re-disables data-core-control after ShellGuard
installCore, so Terminal and other core controls stay clickable.

EOF
)"
```

Do not commit rotated logs. `web-client/dist/` is ignored by repository policy: rebuild it for runtime proof, never stage it.

---

### Task 1: Terminal geometry module (Phase 1 / B-02)

**Files:**
- Create: `signal-server/lib/terminal/geometry.js`
- Create: `signal-server/test/terminal-geometry.test.js`
- Modify: `signal-server/lib/terminal/session-manager.js`
- Modify: `signal-server/websocket/terminal.js` (compatibility error mapping + correlation fields)
- Modify: `signal-server/lib/terminal/webrtc-gateway.js` (replace local size table with shared geometry)

- [ ] **Step 1: Write failing tests**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTerminalSize, assertTerminalSize, COLS_LIMIT, ROWS_LIMIT } = require('../lib/terminal/geometry');

test('normalizeTerminalSize accepts boundaries', () => {
  assert.deepEqual(normalizeTerminalSize({}), { cols: 80, rows: 24 });
  assert.deepEqual(normalizeTerminalSize({ cols: 10, rows: 5 }), { cols: 10, rows: 5 });
  assert.deepEqual(normalizeTerminalSize({ cols: 300, rows: 100 }), { cols: 300, rows: 100 });
});

test('normalizeTerminalSize rejects out of range for create/attach', () => {
  assert.throws(() => normalizeTerminalSize({ cols: 999999, rows: 24 }), /terminal_invalid_size|cols/);
  assert.throws(() => normalizeTerminalSize({ cols: 80, rows: -5 }), /terminal_invalid_size|rows/);
  assert.throws(() => normalizeTerminalSize({ cols: '', rows: 24 }), /terminal_invalid_size|cols/);
  assert.throws(() => normalizeTerminalSize({ cols: 80 }), /terminal_invalid_size|rows/);
});

test('assertTerminalSize matches resize contract 10-300 / 5-100', () => {
  assert.throws(() => assertTerminalSize(9, 24));
  assert.throws(() => assertTerminalSize(80, 101));
});
```

- [ ] **Step 2: Run tests — expect FAIL (module missing)**

```bash
cd signal-server && node --test test/terminal-geometry.test.js
```

- [ ] **Step 3: Implement `geometry.js`**

```js
'use strict';
const { makeTerminalError } = require('./lifecycle');

const COLS_LIMIT = Object.freeze({ min: 10, max: 300 });
const ROWS_LIMIT = Object.freeze({ min: 5, max: 100 });

function asInt(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

function assertTerminalSize(cols, rows) {
  const c = asInt(cols);
  const r = asInt(rows);
  if (!Number.isInteger(c) || c < COLS_LIMIT.min || c > COLS_LIMIT.max
    || !Number.isInteger(r) || r < ROWS_LIMIT.min || r > ROWS_LIMIT.max) {
    throw makeTerminalError('terminal_invalid_size', 'Invalid terminal size', { cols, rows });
  }
  return { cols: c, rows: r };
}

function normalizeTerminalSize(input = {}, fallback = { cols: 80, rows: 24 }) {
  const hasCols = Object.hasOwn(input, 'cols');
  const hasRows = Object.hasOwn(input, 'rows');
  if (hasCols !== hasRows) {
    throw makeTerminalError('terminal_invalid_size', 'cols and rows must be provided together');
  }
  if (!hasCols) return assertTerminalSize(fallback.cols, fallback.rows);
  const cols = input.cols;
  const rows = input.rows;
  return assertTerminalSize(cols, rows);
}

module.exports = { COLS_LIMIT, ROWS_LIMIT, assertTerminalSize, normalizeTerminalSize };
```

- [ ] **Step 4: Wire `createSession` / `attachSession` / `resizeSession`**

In `session-manager.js` replace raw `Number(input.cols||80)` with `normalizeTerminalSize` / `assertTerminalSize`.

- create: omit both → 80×24; any explicit invalid/empty/partial pair rejects before PTY spawn.
- attach: omit both → no resize; when either is present, validate both **before `addObserver`**. Invalid attach must leave observers, presenter and dispatcher unchanged.
- resize: manager always validates. WebSocket resize adapter maps canonical `terminal_invalid_size` back to existing `terminal_resize_out_of_range` and includes `action:'resize'` + `sessionId`.
- WebRTC resize calls manager; do not duplicate a second independent limit table in the gateway.

- [ ] **Step 5: Integration test — createSession rejects huge cols**

Extend `test/terminal-session-manager.test.js`:

```js
test('createSession rejects out-of-range cols/rows before pty spawn', () => {
  let spawned = 0;
  const manager = createTerminalSessionManager({
    config: { enabled: true, adminPassword: 'test-admin' },
    ptyFactory() { spawned += 1; throw new Error('should not spawn'); },
  });
  assert.throws(() => manager.createSession({ cols: 999999, rows: 24, clientId: 'c', socketId: 's' }));
  assert.equal(spawned, 0);
});
```

- [ ] **Step 6: Run focused tests PASS**

```bash
cd signal-server && node --test test/terminal-geometry.test.js test/terminal-session-manager.test.js
```

- [ ] **Step 7: Commit**

```bash
git add signal-server/lib/terminal/geometry.js signal-server/test/terminal-geometry.test.js \
  signal-server/lib/terminal/session-manager.js signal-server/websocket/terminal.js \
  signal-server/lib/terminal/webrtc-gateway.js signal-server/test/terminal-session-manager.test.js
git commit -m "$(cat <<'EOF'
fix(terminal): validate cols/rows on create attach and resize

Introduce geometry helpers so PTY spawn/resize cannot bypass the
10-300 / 5-100 contract that only explicit resize events enforced.

EOF
)"
```

---

### Task 2: Presence module — detach all matching observers (Phase 1 / B-01)

**Files:**
- Create: `signal-server/lib/terminal/presence.js`
- Create: `signal-server/test/terminal-presence.test.js`
- Modify: `signal-server/lib/terminal/session-manager.js` (`detachObserver`, `handleSocketDisconnect`)
- Modify: `signal-server/lib/terminal/webrtc-gateway.js` (peer close remains exact observer removal; session/socket disconnect remains full removal)

- [ ] **Step 1: Failing test — dual observers one socketId**

```js
test('remove by socketId returns Socket.IO and webrtc observers', () => {
  const session = {
    observers: new Map([
      ['sock-1', { observerId: 'sock-1', socketId: 'sock-1', clientId: 'sock-1' }],
      ['webrtc:sock-1', { observerId: 'webrtc:sock-1', socketId: 'sock-1', clientId: 'sock-1' }],
    ]),
  };
  const { removeObservers } = require('../lib/terminal/presence');
  const result = removeObservers(session.observers, { socketId: 'sock-1' });
  assert.equal(session.observers.size, 0);
  assert.equal(result.removedCount, 2);
  assert.deepEqual(result.removed.map((item) => item.observerId).sort(), ['sock-1', 'webrtc:sock-1'].sort());
});
```

- [ ] **Step 2: Run — FAIL**

```bash
cd signal-server && node --test test/terminal-presence.test.js
```

- [ ] **Step 3: Implement presence**

Implement `removeObservers(observers, { observerId, socketId, clientId })` that:
- if observerId: delete one
- else if socketId: **delete all** with `observer.socketId === socketId` (no break-after-one)
- else if clientId: delete all with matching clientId (consistent policy)
- return `{ removed, removedCount }`; no hooks, audit, metrics, dispatcher or presenter knowledge
- selector precedence is exact `observerId` first, then `socketId`, then `clientId`; exact observer removal never expands to the shared socket

- [ ] **Step 4: session-manager delegates**

Replace loop+break in `detachObserver` (~696–728) with presence helper; manager loops over every `removed` descriptor and calls `session.outputDispatcher.detach(observerId)`. Recompute presenter only after all removals: keep the presenter if that client still has another observer, otherwise choose a remaining client or null. Update presence/audit once per manager operation.

`handleSocketDisconnect` calls detach with `socketId` exactly once per affected session; presence deletes all matches.

- [ ] **Step 5: Manager-level regression**

Simulate attach socket observer + webrtc observerId, `detachObserver({ socketId })`, assert `observers.size===0` and `isObserverAttached` false.

Gateway regression: `closePeer(socketId)` removes only `webrtc:${socketId}` and leaves the Socket.IO observer; subsequent session detach or socket disconnect removes the remainder.

- [ ] **Step 6: Tests PASS + commit**

```bash
cd signal-server && node --test test/terminal-presence.test.js test/terminal-session-manager.test.js lib/terminal/webrtc-gateway.test.js
```

```bash
git commit -m "$(cat <<'EOF'
fix(terminal): detach all observers sharing a socket id

WebRTC output bridges use webrtc:<socketId> with the same socketId as
Socket.IO; presence now removes every match so idle reap and authz stay honest.

EOF
)"
```

---

### Task 3: Frontend InputGate + pending release (Phase 1 / F-03 F-04 F-05 F-10)

**Files:**
- Create: `web-client/js/terminal-input-gate.js`
- Create: `web-client/js/terminal-input-gate.test.js`
- Create: `web-client/js/terminal-session-fsm.js` in Step 6 by migrating the in-place fix and existing `createTerminalState`
- Modify: `web-client/js/terminal.js`
- Modify: `web-client/js/terminal.test.js`
- Modify: `signal-server/websocket/terminal.js` (echo attach/close correlation fields)
- Modify: `signal-server/websocket/terminal.test.js`
- Modify: `signal-server/scripts/web-asset-graph.js` so new files load before `terminal.js`

**Recommended order:** failing tests on current Panel behavior → fix in place → extract pure modules with same tests.

- [ ] **Step 1: Failing tests (gate pure + panel)**

```js
// terminal-input-gate.test.js
test('rejects when not attached or not running', () => {
  const gate = createTerminalInputGate({
    isConnected: () => true,
    isAttached: (id) => id === 's1',
    processStatus: (id) => (id === 's1' ? 'exited' : 'running'),
    transportCanSend: () => true,
  });
  assert.deepEqual(gate.decide('s1'), { allowed: false, reason: 'process_not_running' });
  assert.deepEqual(gate.decide('s2'), { allowed: false, reason: 'session_not_attached' });
});

test('allows only attached running with transport ok', () => {
  const gate = createTerminalInputGate({
    isConnected: () => true,
    isAttached: (id) => id === 's1',
    processStatus: () => 'running',
    transportCanSend: () => true,
  });
  assert.deepEqual(gate.decide('s1'), { allowed: true, reason: null });
});
```

Panel tests to add in `terminal.test.js`:
- attach error clears pendingAttach so second activate emits attach again  
- close error `terminal_session_not_attached` clears pendingClose so second close emits again  
- resize/input error for the same session does **not** clear attach/close pending  
- attach/close response with a stale `operationId` does not clear the current operation  
- exited active session: composer disabled  
- unattached: onData path does not optimistic-echo (mock term)
- synchronous ack during adapter `sendInput` sees an existing pending entry; thrown/false send removes it and emits no echo

- [ ] **Step 2: Run — FAIL**

```bash
node --test web-client/js/terminal-input-gate.test.js web-client/js/terminal.test.js
```

- [ ] **Step 3: Implement gate**

```js
function createTerminalInputGate(deps) {
  function decide(sessionId) {
    if (!sessionId) return { allowed: false, reason: 'session_missing' };
    if (!deps.isConnected()) return { allowed: false, reason: 'socket_disconnected' };
    if (!deps.isAttached(sessionId)) return { allowed: false, reason: 'session_not_attached' };
    if (deps.processStatus(sessionId) !== 'running') return { allowed: false, reason: 'process_not_running' };
    if (!deps.transportCanSend(sessionId)) return { allowed: false, reason: 'transport_not_ready' };
    return { allowed: true, reason: null };
  }
  return { decide };
}
```

- [ ] **Step 4: Wire terminal.js**

- `isComposerReady` consumes the same gate decision (attached + running + connected + selected transport ready).  
- `emitTerminalInput`: if denied, return before pending/echo and expose the gate reason. If allowed, register pending **before** adapter send; on throw/false delete it; optimistic echo only after adapter acceptance.  
- attach/close requests include a generated `operationId` (bounded to 128 chars); server success/error echoes `action + sessionId + operationId` on canonical events and aliases. Broadcast `closed` always updates every client's lifecycle state, while only the matching requester operation clears pending.  
- FSM clears only the matching action/session/operation. Never apply a generic “any non-input error clears pending” rule.

- [ ] **Step 5: PASS + commit**

```bash
git add web-client/js/terminal-input-gate.js web-client/js/terminal-input-gate.test.js \
  web-client/js/terminal.js web-client/js/terminal.test.js \
  signal-server/websocket/terminal.js signal-server/websocket/terminal.test.js
git commit -m "$(cat <<'EOF'
fix(terminal): gate input on attach and process status

Clear sticky pending attach/close on not_attached and attach failures,
and disable composer unless the active session is attached and running.

EOF
)"
```

- [ ] **Step 6 (refactor commit): Extract the session FSM**

Move `createTerminalState` and pending transition logic to `terminal-session-fsm.js` as the single state owner; keep the already-created pure decision in `terminal-input-gate.js`. Delete the old in-file state implementation rather than layering a second store. Update asset graph; tests still PASS; commit as `refactor(terminal): extract session fsm`.

---

### Task 4: TURN transport rebind + hard reject (Phase 1 / F-01 F-02)

**Files:**
- Create: `web-client/js/terminal-turn-transport.js`
- Create: `web-client/js/terminal-turn-transport.test.js`
- Modify: `web-client/js/terminal.js` (or panel wiring)
- Modify: `web-client/js/terminal.test.js`

- [ ] **Step 1: Failing unit tests**

```js
test('shouldSuppressSocketOutput false until bound sid matches active and ready', () => {
  const t = createTurnTransportState();
  t.preferred = 'webrtc-turn';
  t.dcOpen = true;
  t.outputReady = true;
  t.activeSessionId = 'B';
  t.boundSessionId = 'A';
  assert.equal(t.shouldSuppressSocketOutput('B'), false);
  t.boundSessionId = 'B';
  assert.equal(t.shouldSuppressSocketOutput('B'), true);
});

test('canSendInput reflects dc readiness and does not read transport preference', () => {
  const t = createTurnTransportState();
  t.dcOpen = false;
  assert.equal(t.canSendInput(), false);
});
```

Panel/integration:
- preferred turn + dc not open → `emitTerminalInput` does not call `socket.emit`  
- activate other session calls rebind with new sid (mock dc.send JSON parse `t==='bind'`)

- [ ] **Step 2: Implement turn helper + wire**

- On DC onopen: bind active sid (existing).  
- On activate: request attach first. If already attached, rebind immediately; otherwise rebind after matching attach success.  
- Before sending bind, clear `boundSid/outputReady`; restore only after matching server `output_bound`. `shouldPreferWebRtcOutput` uses boundSid===sessionId===active && outputReady.  
- `emitTerminalInput`: if preferred===webrtc-turn: if !canSend → setStatus error, return null; if canSend → dc only; **never** fall through to socket.

- [ ] **Step 3: PASS + commit**

```bash
node --test web-client/js/terminal-turn-transport.test.js web-client/js/terminal.test.js
git add web-client/js/terminal-turn-transport.js web-client/js/terminal-turn-transport.test.js \
  web-client/js/terminal.js web-client/js/terminal.test.js signal-server/scripts/web-asset-graph.js
git commit -m "fix(terminal): rebind turn dc and reject undeliverable input"
```

The TurnTransport module is part of the behavior fix and belongs in this fix commit; do not add a second pass-through wrapper merely to manufacture a refactor commit.

---

### Task 5: Phase 1 verification gate

- [ ] **Step 1: Unit suite**

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
node --test signal-server/test/terminal-*.test.js signal-server/lib/terminal/*.test.js \
  signal-server/websocket/terminal.test.js web-client/js/terminal*.test.js web-client/js/shell-guard.test.js
```

Expected: all PASS.

- [ ] **Step 2: build:web**

```bash
cd signal-server && npm run build:web
```

- [ ] **Step 3: Playwright webtest (local 8080, user-managed server)**

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
python3 artifacts/terminal-webtest-2026-08-08/terminal_webtest.py
```

Expected: exit 0 and `artifacts/terminal-webtest-2026-08-08/results.json` has `ok: true`. Extend the ignored script for this run and retain screenshots/results covering:
- Terminal tab enabled without force  
- admin auth, composer command marker  
- close unattached → error → close again works  
- single session `exit` → composer disabled  

- [ ] **Step 4: Runtime probe when a user-managed local server is already running** (admin token; no tunnel restart). If no server is running, record `NOT RUN` in the closure note; this is not a Phase 1 release blocker because Step 3 is the runtime gate.

- [ ] **Step 5: Phase 1 closure note** in report or commit message list G-01…G-06 evidence.

**Stop here for release if needed.** Task 6 is structural completion; Phase 2 starts at Task 7.

---

### Task 6: Extract socket transport + thin panel (structural completion; not a Phase 1 release gate)

**Files:**
- Create: `web-client/js/terminal-socket-transport.js`
- Create: `web-client/js/terminal-socket-transport.test.js`
- Modify: `web-client/js/terminal.js`
- Modify: `signal-server/scripts/web-asset-graph.js`

- [ ] **Step 1: Move connect/bootstrap/alias dispatch without behavior change**

Keep control-plane events in SocketTransport. Do not move session rules into the adapter and do not let SocketTransport call TurnTransport. Bootstrap success-only cache remains Task 9 unless already covered by a failing test in this commit.

External interface stays small: `start({ token, onEvent, onStatus })`, `stop(reason)`, `sendCommand({ action, ...payload })`, `isReady()`, and `sendInput(frame)`. Alias/event names, bootstrap, ping and metrics remain implementation details.

- [ ] **Step 2: Full frontend terminal tests PASS**

```bash
node --test web-client/js/terminal*.test.js web-client/js/shell-guard.test.js
```

- [ ] **Step 3: Commit refactor only**

```bash
git add web-client/js/terminal-socket-transport.js web-client/js/terminal-socket-transport.test.js \
  web-client/js/terminal.js signal-server/scripts/web-asset-graph.js
git commit -m "$(cat <<'EOF'
refactor(terminal): extract socket transport from panel
EOF
)"
```

---

### Task 7: maxInFlight config plumbing (Phase 2 / B-03)

**Files:**
- Modify: `signal-server/lib/config.js`
- Modify: `signal-server/lib/terminal/session-manager.js` config normalization (~65–102)
- Modify: `signal-server/test/terminal-config.test.js`
- Modify: `signal-server/test/terminal-session-manager.test.js`
- Verify: `signal-server/.env.example` already declares both maxInFlight variables; values remain unchanged
- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md` to add the two variables and describe chunk/byte windows

- [ ] **Step 1: Failing test**

Extend the existing session-manager harness with `config.enabled=true`, a non-empty admin password, `terminalMaxInFlightChunks=7`, and `terminalMaxInFlightBytes=4096`. Create a session whose three-argument `onData` retains acknowledgements, emit 8 one-byte chunks, and assert exactly 7 callbacks fire. Acknowledge one chunk and assert the eighth callback then fires.

Do not add a test-only dispatcher factory: there is one production adapter and existing output behavior is observable through the manager callback interface.

- [ ] **Step 2: Map in loadConfig**

```js
terminalMaxInFlightChunks: terminal.maxInFlightChunks,
terminalMaxInFlightBytes: terminal.maxInFlightBytes,
```

And in session-manager local `config`:

```js
maxInFlightChunks: Number(rawConfig.maxInFlightChunks ?? rawConfig.terminalMaxInFlightChunks ?? 32),
maxInFlightBytes: Number(rawConfig.maxInFlightBytes ?? rawConfig.terminalMaxInFlightBytes ?? 65536),
```

- [ ] **Step 3: PASS + commit** `fix(terminal): plumb max in-flight output config to dispatcher`

---

### Task 8: PTY kill escalation + shutdown harvest (Phase 2 / B-05)

**Files:**
- Modify: `signal-server/lib/terminal/lifecycle.js`
- Modify: `signal-server/lib/terminal/session-manager.js` (`cleanupPty`)
- Modify: `signal-server/websocket/terminal.js` `close()`
- Modify: `signal-server/server.js` shutdown path
- Test: `signal-server/test/terminal-lifecycle.test.js`
- Test: `signal-server/test/terminal-session-manager.test.js`
- Test: `signal-server/websocket/terminal.test.js`

- [ ] **Step 1: Failing mock test for signal order**

```js
test('cleanup escalates SIGHUP to SIGTERM to SIGKILL and waits for confirmed exit', async () => {
  const signals = [];
  const pty = {
    kill(sig) { signals.push(sig); },
    // waitForExit resolves false until SIGKILL, then true
  };
  await cleanupPtyWithEscalation(pty, {
    waitForExit: async () => signals.at(-1) === 'SIGKILL',
    signals: ['SIGHUP', 'SIGTERM', 'SIGKILL'],
    isAlive: () => signals.length < 3,
  });
  assert.deepEqual(signals, ['SIGHUP', 'SIGTERM', 'SIGKILL']);
});
```

- [ ] **Step 2: Implement helper + wire cleanupPty**

`cleanupPtyWithEscalation` returns a Promise. `pty.kill()` returning without throwing is only “signal sent”; confirmed success requires observed exit / `isAlive===false`. Add an `exitObserved/exitPromise` latch that node-pty `onExit` resolves before notification dedupe; do not reuse current `exitHandled` as proof of process exit. Store one `cleanupPromise` per session so concurrent user close, idle reap and shutdown share the same sequence. Keep quarantine behavior for hard failures; do not expand B-06 scope.

Convert `closeSession`, `closeSessionAsSystem`, quarantine retry, idle reap and websocket `handleClose` to await the same Promise. Because current `createSession` runs retry/reap before capacity enforcement, convert it and websocket `handleCreate` to async and await both operations before checking `maxSessions`; do not silently change this to conservative fire-and-forget rejection. The idle/quarantine timers must observe rejections explicitly. Existing create/close tests must await the canonical created/closed/error event before assertions.

- [ ] **Step 3: shutdown**

Implement `async closeAllAsSystem('system:shutdown')` by iterating a stable session snapshot through the existing unforgeable system capability. Return `{ closedSessionIds, failures }`; do not fail-fast.

Make terminal setup expose idempotent `async close()` which stops the reaper, closes WebRTC peers, and **awaits** `closeAllAsSystem`. Add one `server.js` runtime `close()` owner with a bounded total timeout; register SIGINT/SIGTERM handlers only in the executable startup path, not inside `createServerApp()` tests. Do not use optional chaining or fire-and-forget cleanup. Tests must cover repeated `close()` calls, one failing session, and the returned failure summary.

- [ ] **Step 4: PASS + commit** `fix(terminal): escalate pty kill and harvest sessions on shutdown`

---

### Task 9: Bootstrap retry + running resize (Phase 2 / F-08 F-09)

**Files:**
- Modify: `web-client/js/terminal-socket-transport.js`
- Modify: `web-client/js/terminal.js` render/lifecycle hooks
- Modify: `web-client/js/terminal.test.js`
- Modify: `web-client/js/terminal-socket-transport.test.js`

- [ ] **Step 1: Failing tests**

- bootstrap fetch fail → success cache remains null/previous; second ensureBootstrap retries  
- token B arriving while token A bootstrap is in flight does not reuse A's promise/result  
- processStatus starting→running on active session → emits `terminal:resize` once with fit size using the existing fitAddon mock

- [ ] **Step 2: Implement**

- key bootstrap promise and success cache by token; only set successful token after HTTP + parse success  
- failure may apply websocket-only for that attempt but is not cached as success  
- on transition to running (output handler / attached handler): `fitActiveTerminal(); emit resize if attached && running`

- [ ] **Step 3: PASS + commit** `fix(terminal): retry failed bootstrap and resize when pty becomes running`

---

### Task 10: Phase 2 verification + docs

- [ ] **Step 1: Full terminal test suite**

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
node --test signal-server/test/terminal-*.test.js signal-server/lib/terminal/*.test.js \
  signal-server/websocket/terminal.test.js web-client/js/terminal*.test.js web-client/js/shell-guard.test.js
```

Expected: all PASS with no unhandled rejection output.

- [ ] **Step 2: build:web + spot webtest**

- [ ] **Step 3: Update docs**

- Spec status → 已实施（Phase 1/2）  
- Add a closure section to `docs/superpowers/reports/2026-08-08-terminal-systemic-review.md` with per-G evidence and residuals  
- Add `WRD_TERMINAL_MAX_IN_FLIGHT_CHUNKS`（默认 32）和 `WRD_TERMINAL_MAX_IN_FLIGHT_BYTES`（默认 65536）到需求文档配置表；确认 `signal-server/.env.example` 与实现一致  

- [ ] **Step 4: Final commit** `docs(terminal): close modular remediation plan`

---

## Plan self-check / 合理性 Review

### 一致性

| 检查 | 结论 |
|------|------|
| 与 spec v3 对齐 | Phase 1/2、TURN 硬拒绝、精确 pending 关联、geometry reject、presence 全删、async shutdown 一致 |
| 与 2026-07-19 hardening | 不推翻 env allowlist / flow-control / admin JWT；只补洞与拆边界 |
| 事件兼容 | 无删除 alias 的任务 |
| TDD 门闩 | 每 Task 先红后绿；refactor 分 commit |

### 风险

| 风险 | Plan 是否覆盖 | 残留 |
|------|----------------|------|
| 大搬迁回归 | Task 3/4/6 保留 terminal.test.js + 分步 extract | 仍依赖执行时纪律 |
| presence vs dispatcher | Task 2 要求 manager 消费完整 removed[] 并逐项 detach | — |
| 服务端 close 权限被误放宽 | 明确不做 | — |
| kill 进程组 | residual | 不承诺 |
| webtest 依赖 live .env | Task 5 写明 user-managed server | 密码不入库 |

### 是否过度设计

- **合理：** geometry/presence/input-gate/turn 均有可陈述不变量与已复现 bug。  
- **需执行时克制：** Task 6 socket extract 在 Phase 1 release gate 之后；若与 Task 3/4 冲突可延后，但不得把结构抽取冒充 G-01…G-06 关闭证据。  
- **禁止：** 借机重写 desktop WebRTC、重做 composer UX、引入 DI 框架。

### 可执行性

- 文件路径具体；关键代码块可粘贴为起点。  
- 验证命令使用仓库既有 `node --test` 与 `npm run build:web`。  
- Phase 1 结束有硬停点，符合「可单独发布」。

### Review verdict

**PASS WITH EXECUTION GATES**

可以按 Task 0→5 交付 Phase 1；Task 6 是结构收尾，Task 7→10 为 Phase 2。执行时若 extract 导致测试不稳，优先 **fix 行为在原文件** 再 extract，而不是扩大范围。

---

## 实施启动前确认（给用户）

1. 先读 spec + 本 plan。  
2. 用 `superpowers:executing-plans` **按 Task 顺序**执行；未经用户明确授权不派生 subagent。  
3. 每 Task 结束跑该 Task 写明的测试命令。  
4. 不自动重启 tunnel；不提交日志。  
5. Phase 1 完成后可暂停合并，再开 Phase 2。
