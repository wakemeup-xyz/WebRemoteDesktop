# Viewer Desktop Session State Owner Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除未被外部使用的 Viewer `DesktopSessionCoordinator`，让 `DesktopSessionState` 成为唯一 session snapshot/reducer owner，同时保持现有 WebRTC、输入和媒体行为。

**Architecture:** 保留 `WebRTC` facade 及其协议/DOM 缓存；所有 session 状态只通过 `DesktopSessionState` 的 begin/apply/snapshot API 更新。删除 coordinator 实现、测试和静态资源引用，并以状态行为测试和静态 no-duplicate-writer 契约锁定边界。

**Tech Stack:** Vanilla JavaScript、Node.js `node:test`、Signal server Node build。

**Spec:** `docs/superpowers/specs/2026-08-30-desktop-session-state-owner-convergence-design.md`

## Global Constraints

- 不改变公开 JS 方法、Socket 事件、WebRTC SDP/ICE、网络模式枚举或认证流程。
- 不新增 npm/Python 依赖。
- 不修改 Host、Signal runtime 行为；Signal 只重新构建静态 Viewer asset。
- 旧 attempt 的连接、媒体、控制事件不能改变当前 snapshot。
- `canInput` 只有 `control=active`、`media=live`、`socket=online` 同时成立时为 true。
- 真实浏览器、双 Viewer、物理输入、公网 tunnel 和睡眠唤醒不作为本计划自动步骤，完成报告标记为 `NOT RUN`。

---

### Task 1: Migrate Viewer to the single state owner

**Files:**
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/viewer.html`
- Modify: `signal-server/scripts/web-asset-graph.js`
- Modify: `web-client/js/desktop-session-state.test.js`
- Create: `web-client/js/desktop-session-state-owner.test.js`
- Delete: `web-client/js/desktop-session-coordinator.js`
- Delete: `web-client/js/desktop-session-coordinator.test.js`

**Interfaces:**
- Consumes: existing `createDesktopSessionState`, `beginAttempt`, `applyConnection`, `applyMedia`, `applyControl`, `snapshot` in `web-client/js/desktop-session-state.js`.
- Produces: `WebRTC.getDesktopSessionSnapshot()` backed only by `DesktopSessionState`; the static asset graph loads `js/desktop-session-state.js` before `js/webrtc.js` and has no coordinator entry.

- [ ] **Step 1: Add the owner contract tests and migrate reducer coverage**

  In `web-client/js/desktop-session-state.test.js`, add a test that starts an attempt with an online socket, applies `connected`, `active`, and `fresh-frame`, asserts `canInput === true`, then applies `stalled` and asserts `canInput === false`, then applies a current-attempt fresh frame and asserts `canInput === false` until control is active again. Keep the existing old-attempt isolation assertion unchanged.

  Create `web-client/js/desktop-session-state-owner.test.js` using `node:fs`, `node:path`, `node:assert/strict`, and `node:test`. Read the three files listed below relative to the repository root (`path.resolve(__dirname, '..', '..')`) and assert each forbidden token is absent from production/static files:

  ```js
  const forbidden = [
    'sessionCoordinator',
    'DesktopSessionCoordinator',
    'initializeSessionCoordinator',
    'ControlLeaseView',
    'MediaPaintGate',
    'ConnectionSession',
  ];
  const production = [
    'web-client/js/webrtc.js',
    'web-client/viewer.html',
    'signal-server/scripts/web-asset-graph.js',
  ];
  ```

  Also assert `web-asset-graph.js` contains exactly one `js/desktop-session-state.js` entry and zero `js/desktop-session-coordinator.js` entries. The test must not inspect or fail on the deleted coordinator test file.

- [ ] **Step 2: Run the focused tests to establish the migration guard**

  Run:

  ```bash
  node --test web-client/js/desktop-session-state.test.js web-client/js/desktop-session-state-owner.test.js
  ```

  Expected: the state behavior tests pass; the new owner test fails while the old coordinator references still exist. Record the failure before implementation changes.

- [ ] **Step 3: Remove the duplicate coordinator state and direct all events to `DesktopSessionState`**

  In `web-client/js/webrtc.js`:

  - Remove the `sessionCoordinator` field.
  - Remove `initializeSessionCoordinator()`.
  - In `beginConnectionAttempt`, keep the sequence/current attempt setup and `DesktopSessionState.beginAttempt(...)`; remove coordinator initialization, transition, and `beginMedia` calls.
  - In `setUiPhase`, keep the existing `DesktopSessionState.apply*` mapping and remove the coordinator `setUiPhase` call.
  - Replace every coordinator media call with the equivalent `DesktopSessionState.applyMedia(...)` call. `noteMediaDecoded` has no snapshot field and must be deleted without introducing a decoded-frame counter.
  - Replace every coordinator control lease call with the existing `DesktopSessionState.applyControl(...)` call already present in `handleControlState`, `handleControlGrant`, `freezeControl`, and `updateControlUI`; do not alter `controlState` protocol handling.
  - Preserve the current attempt guards, first-frame gate, stalled-media path, and `canInput` fail-closed logic.

  Remove `js/desktop-session-coordinator.js` from `web-client/viewer.html` and from `signal-server/scripts/web-asset-graph.js`. Keep script order otherwise unchanged.

- [ ] **Step 4: Run focused regression tests and build**

  Run:

  ```bash
  node --test web-client/js/desktop-session-state.test.js web-client/js/desktop-session-state-owner.test.js web-client/js/webrtc.test.js
  cd signal-server && npm run build:web
  ```

  Expected: Node exits 0 with zero failed tests and the web build exits 0. If `webrtc.test.js` leaves known long-lived timers, report the observed assertion count and timer behavior rather than changing unrelated timer code.

- [ ] **Step 5: Run broader affected suites and diff checks**

  Run:

  ```bash
  cd signal-server && npm test
  cd ..
  node --test web-client/js/*.test.js
  git diff --check
  rg -n "DesktopSessionCoordinator|sessionCoordinator|initializeSessionCoordinator|ControlLeaseView|MediaPaintGate|ConnectionSession|desktop-session-coordinator" web-client signal-server --glob '!**/node_modules/**'
  ```

  Expected: Signal tests and Viewer tests have zero assertion failures; `git diff --check` exits 0; the final `rg` returns no production/static references (the deleted files may not exist). Do not run or restart services.

- [ ] **Step 6: Self-review and commit the task**

  Review the diff against the spec checklist: one owner, unchanged public protocol, preserved attempt/media/control invariants, no dependency or Host changes, and no edits to existing untracked runtime artifacts. Commit only the files in this task with:

  ```bash
  git add web-client/js/webrtc.js web-client/viewer.html signal-server/scripts/web-asset-graph.js web-client/js/desktop-session-state.test.js web-client/js/desktop-session-state-owner.test.js
  git rm web-client/js/desktop-session-coordinator.js web-client/js/desktop-session-coordinator.test.js
  git commit -m "refactor(viewer): converge desktop session state owner"
  ```

  The implementation report must include the commit SHA, exact test commands and observed counts, any pre-existing failures, and an explicit `NOT RUN` line for real browser/public-path validation.
