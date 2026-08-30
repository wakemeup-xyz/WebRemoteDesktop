# Desktop Session State 与运行验收 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用统一只读 session snapshot 让连接、媒体、控制 UI 诚实，并建立不可伪造的运行验收矩阵。

**Architecture:** 新增轻量 `desktop-session-state.js` 聚合当前 attempt 的连接、媒体和控制事实；不接管 WebRTC 状态机。UI presenter 和诊断只读取 snapshot。

**Tech Stack:** Vanilla JS、Node test runner、现有 Host/Signal tests、Playwright。

**Spec:** `docs/superpowers/specs/2026-08-30-desktop-session-state-acceptance-design.md`

## Global Constraints

- 不改变网络模式策略、WebRTC/Socket 协议或控制租约算法。
- 不合成 frame、ack 或公网 PASS 证据。
- 每个 attempt 必须带单调 `attemptId`，旧事件 fail-closed。
- 不操作 tunnel；真实验收只在现有运行态下进行。

### Task 1: Snapshot reducer

**Files:** Create `web-client/js/desktop-session-state.js`, `web-client/js/desktop-session-state.test.js`; modify `signal-server/scripts/web-asset-graph.js`.

- [ ] 写 reducer 的失败测试：初始 idle、PC connected 仍 media pending、fresh frame 才 live、旧 attempt 事件被忽略。
- [ ] 实现 `createDesktopSessionState()`，导出 `beginAttempt`, `applyConnection`, `applyMedia`, `applyControl`, `snapshot`。
- [ ] 运行 `node --test web-client/js/desktop-session-state.test.js`，再在 `signal-server` 运行 `npm run build:web`。

### Task 2: Wire presenters without changing owners

**Files:** `web-client/js/webrtc.js`, `web-client/js/webrtc-stats.js`, `web-client/js/ui.js`, `web-client/js/shell-guard.js`, `web-client/js/desktop-session-state.test.js`, `web-client/js/webrtc.test.js`.

- [ ] 在现有事件点发布 reducer 输入：attempt bind、PC state、fresh frame、media stall、lease transition、disconnect。
- [ ] 将 connectionStatus、loading、controlStatus 和 input gate 改为读取 snapshot；删除重复的 UI 推断，不删除原状态源。
- [ ] 添加断开清理和旧 attempt 事件测试。
- [ ] 运行 `node --test web-client/js/desktop-session-state.test.js web-client/js/webrtc.test.js web-client/js/shell-guard.test.js`，确认旧 attempt 事件不会改变 UI。

### Task 3: Acceptance harness and artifacts

**Files:** Create `scripts/desktop-session-acceptance.sh`, `scripts/desktop-session-acceptance.test.js`, update reliability report.

- [ ] 在 `scripts/desktop-session-acceptance.sh` 只采集 timestamp、attemptId、phase、media、candidate summary、frame counters、input ack metadata，不注入 synthetic frame。
- [ ] 为 live frame、stall、resume、disconnect、dual-viewer、tunnel and physical-input rows 输出 `PASS/PARTIAL/NOT RUN/BLOCKED`。
- [ ] 运行 `bash scripts/desktop-session-acceptance.sh --local-only` 做 health preflight；公网、硬件或双浏览器缺证据时输出 `NOT RUN` 和原因，不返回 PASS。

### Task 4: Documentation and regression

**Files:** `docs/需求文档/WebRemoteDesktop-需求文档.md`, `docs/superpowers/reports/2026-08-30-desktop-session-acceptance.md`.

- [ ] 同步状态语义和验收边界。
- [ ] 执行 Signal、Host、Viewer tests、build、`git diff --check`。
