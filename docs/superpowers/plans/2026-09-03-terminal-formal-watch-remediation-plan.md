# Terminal 与 Formal Watch 修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修好 Terminal bootstrap 死循环、detach 粘滞、PTY wait=0 误杀、formal watch 死锁，并统一 tunnel 文档口径。

**Architecture:** 不替换 Panel 为 FSM。只修连接入口、detach 持久化、lifecycle wait、watch 锁/身份和文档。

**Tech Stack:** Node `node:test`、现有 terminal.js / session-manager / watch-fixed-domain.sh。

**Spec:** `docs/superpowers/specs/2026-09-03-terminal-formal-watch-remediation-design.md`

## Global Constraints

- 不启动、停止、重启或重建 trycloudflare。
- Formal watch 只允许重启命名隧道 helper，不得碰 signal-server / Host。
- 提交前检查 cached 文件名与 `--check`。

---

### Task 1: Bootstrap 失败后仍能 websocket-only 连接

**Files:** `web-client/js/terminal.js`, `web-client/js/terminal.test.js`

- [ ] **Step 1:** 测试：fetch bootstrap 500 时 `io()` 调用 1 次，1s 内 bootstrap fetch ≤ 2。
- [ ] **Step 2:** 确认失败。
- [ ] **Step 3:** catch 里设允许本次 connect 的标志，不要因 `bootstrapAuthToken !== token` 再递归 bootstrap。
- [ ] **Step 4:** 测试通过并提交 `fix(terminal): connect websocket-only after bootstrap failure`。

---

### Task 2: Detach 不再被 snapshot 拉回

**Files:** `web-client/js/terminal.js`, `web-client/js/terminal.test.js`

- [ ] **Step 1:** 测试：`handleDetach` 后 `applyPoolSnapshot` 不 `requestAttachSession` 同一 id。
- [ ] **Step 2:** detach 清 LAST_ACTIVE（若匹配）并记录 userDetached；snapshot 跳过该 id。
- [ ] **Step 3:** 提交 `fix(terminal): do not reattach after explicit detach`。

---

### Task 3: PTY kill 等待真实 onExit

**Files:** `signal-server/lib/terminal/session-manager.js`, `signal-server/test/terminal-session-manager.test.js`, 必要时 `signal-server/lib/terminal/config.js`

- [ ] **Step 1:** 异步 emitExit 的测试在 waitMs=0 时失败、waitMs=200 时成功。
- [ ] **Step 2:** 生产默认 ≥200ms；`waitForExit` await exitPromise+timeout。
- [ ] **Step 3:** 提交 `fix(terminal): wait for pty exit before quarantine`。

---

### Task 4: Watch 死锁与 --token 双进程

**Files:** `scripts/watch-fixed-domain.sh`, `scripts/lib-fixed-domain.sh`, 对应 `*.test.js`

- [ ] **Step 1:** 死 PID 锁仍能 acquire；`--token` 进程拒绝 managed restart。
- [ ] **Step 2:** PID 文件 + 过期抢锁；识别 `--token` 并拒绝再 submit。
- [ ] **Step 3:** 提交 `fix(tunnel): recover stale watch lock and refuse token connectors`。

---

### Task 5: 文档口径

**Files:** `docs/需求文档/WebRemoteDesktop-需求文档.md`, `README.md`, `docs/runbook-safe-startup.md`, `docs/superpowers/specs/2026-08-30-terminal-shared-session-ux-protocol-design.md`

- [x] **Step 1:** trycloudflare 失效 ≠ 自动重建授权；隐藏 5 分钟才停采集；DC 关 park / 开 reset；FSM 标明测试 seam。
- [x] **Step 2:** 提交 `docs: unify tunnel rebuild and terminal lifecycle copy`。

---

## Spec coverage

| Spec | Task |
|---|---|
| 2.1 bootstrap | 1 |
| 2.2 detach | 2 |
| 2.3 pty wait | 3 |
| 2.4 lock/token | 4 |
| 2.5 UX 最小（文档+可选代码） | 5 |
| 2.6 文档 | 5 |
