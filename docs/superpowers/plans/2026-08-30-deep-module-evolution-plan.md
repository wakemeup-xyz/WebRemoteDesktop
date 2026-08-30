# WebRTC、Host 与 Signal 深模块演进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变外部协议和运行语义的前提下，为三个浅大 module 建立可测试、可回滚的内部 seam。

**Architecture:** 保留 `WebRTC`、`WebRemoteHost` 和 Socket handler facade；先引入只读 snapshot/reducer，再引入真实 adapter。每个阶段只有一个 state owner，legacy 兼容留在 adapter。

**Tech Stack:** Vanilla JS、Python asyncio/aiortc、Node.js/Socket.IO、Node/Python tests。

**Spec:** `docs/superpowers/specs/2026-08-30-deep-module-evolution-design.md`

## Global Constraints

- 不改变公开事件、认证、租约、媒体或网络模式语义。
- 不做一次性大重构；每个任务必须可独立回滚和测试。
- 不因“文件变小”而增加无真实 adapter 的抽象。
- 运行验收证据不得用 synthetic frame/ack 替代。

### Task 1: Freeze state owners and dependency graph

**Files:** Create `docs/superpowers/reports/2026-08-30-module-state-owners.md`; create `scripts/check-module-state-owners.js`; test `scripts/check-module-state-owners.test.js`.

- [ ] 运行 `node scripts/check-module-state-owners.js --write docs/superpowers/reports/2026-08-30-module-state-owners.md`，列出字段 owner、读者、写者和事件顺序。
- [ ] 在 `scripts/check-module-state-owners.test.js` 为 facade 公开事件和方法建立 contract snapshot，先不改实现。
- [ ] 运行 `cd signal-server && npm test`、`cd python-host && PYTHONPATH=. python3 -m pytest -q` 和 `node --test web-client/js/*.test.js`，保存基线计数。

### Task 2: Viewer internal seam

**Files:** Create `web-client/js/desktop-session-coordinator.js`, `web-client/js/desktop-session-coordinator.test.js`; modify `web-client/js/webrtc.js`, `web-client/js/ui.js`, `web-client/js/webrtc.test.js`, `signal-server/scripts/web-asset-graph.js`.

- [ ] 先写 facade 行为不变和 snapshot reducer 失败测试。
- [ ] 抽出 `ConnectionSession`、`MediaPaintGate`、`ControlLeaseView` 的只读 interface；旧 `WebRTC` 方法委托给 coordinator。
- [ ] 运行 `node --test web-client/js/desktop-session-coordinator.test.js web-client/js/webrtc.test.js` 和 `cd signal-server && npm run build:web`；任何媒体/输入行为差异停止迁移。

### Task 3: Signal explicit runtime context

**Files:** Create `signal-server/websocket/runtime-context.js`, `signal-server/websocket/runtime-context.test.js`; modify `signal-server/websocket/signaling.js`, `signal-server/server.js`, `signal-server/websocket/signaling.test.js`.

- [ ] 写双 context 隔离测试：连接 registry、host capability 和 lease 不得跨实例泄漏。
- [ ] 将模块级 `connections`/`hostCapabilities` 放入显式 context；保留旧 `setupSignaling(io, options)` 入口。
- [ ] 运行 `cd signal-server && node --test websocket/runtime-context.test.js websocket/signaling.test.js`，再运行 `npm test`，并检查生产 server 只创建一个 context。

### Task 4: Host adapters

**Files:** Create `python-host/adapters/capture.py`, `python-host/adapters/media_sender.py`, `python-host/adapters/input.py`, `python-host/adapters/lifecycle.py`; modify `python-host/host.py`, `python-host/test_input_handler.py`, `python-host/test_aiortc_media_sender.py`.

- [ ] 在 `python-host/test_adapter_contracts.py` 为 capture、input、shutdown 的现有行为写 adapter contract tests。
- [ ] 让 `WebRemoteHost` 只编排 adapters；保留 aiortc、Quartz、relay 的现有实现作为第一 adapters。
- [ ] 运行 `cd python-host && PYTHONPATH=. python3 -m pytest -q`；只读检查 Host/overlay 进程路径，不重启服务作为本计划自动步骤。

### Task 5: Remove proven dead paths

**Files:** `signal-server/websocket/input.js`, legacy references, tests, docs.

- [ ] 运行 `rg -n "setupInputRelay|terminal:(created|attached|closed|snapshot)" signal-server web-client` 并检查结构化日志，证明旧 `/input` 未挂载、alias 使用已归零或仍需保留。
- [ ] 仅在停止条件满足时删除 dead path；否则加 deprecated 注释和移除日期条件。
- [ ] 运行 `cd signal-server && npm test`、`cd python-host && PYTHONPATH=. python3 -m pytest -q`、`git diff --check`，并更新架构报告。
