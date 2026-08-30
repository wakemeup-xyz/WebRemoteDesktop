# Terminal 共享会话 UX 与协议治理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让共享 Terminal 的控制权、生命周期和协议兼容行为对用户与维护者都可见。

**Architecture:** `session-manager` 继续拥有 session truth；Socket 层提供 canonical adapter；`terminal.js` 只消费 normalized snapshot 和 capability，不把 alias 传播到 UI。

**Tech Stack:** Node built-in tests、Socket.IO、xterm.js、现有 Terminal metrics/audit。

**Spec:** `docs/superpowers/specs/2026-08-30-terminal-shared-session-ux-protocol-design.md`

## Global Constraints

- 不改变共享 PTY、admin 二次授权和默认 transport 语义。
- 不删除 legacy alias，直到命中计数连续一个发布周期为零。
- 不挂载 `websocket/input.js`；不记录原始命令、输出或 lease token。

### Task 1: Normalize presenter/process snapshot

**Files:** `signal-server/lib/terminal/session-manager.js`, `signal-server/websocket/terminal.js`, `signal-server/test/terminal-session-manager.test.js`, `signal-server/websocket/terminal.test.js`.

- [ ] 写失败测试，要求 snapshot 同时含 `processStatus`、`presence`、`observerCount`、`activePresenterClientId` 和 caller presenter flag。
- [ ] 实现稳定 snapshot serializer；保持旧字段兼容但不让 UI 读取内部 session。
- [ ] 运行 `node --test signal-server/test/terminal-session-manager.test.js signal-server/websocket/terminal.test.js`。

### Task 2: Render shared-session UX

**Files:** `web-client/js/terminal.js`, `web-client/viewer.html`, `web-client/css/viewer.css`, `web-client/js/terminal.test.js`.

- [ ] 写 presenter/observer、starting/exited、detach/close 文案和 input disabled 测试。
- [ ] 在 session tab/toolbar/status 中显示当前浏览器角色、观察者人数、共享输入和关闭影响；非 running 禁止 composer/input。
- [ ] 运行 `node --test web-client/js/terminal.test.js web-client/js/terminal-session-fsm.test.js web-client/js/terminal-input-gate.test.js`。

### Task 3: Canonical event adapter and alias telemetry

**Files:** `signal-server/websocket/terminal.js`, `web-client/js/terminal.js`, tests, structured logger.

- [ ] 写 alias 去重和 canonical-only internal dispatch 测试。
- [ ] 将 alias 兼容集中到 adapter，增加 bounded alias hit counters 和移除条件日志。
- [ ] 在 `signal-server/server.test.js` 添加启动装配断言证明 `websocket/input.js` 未挂载，并在 `input.js` 顶部标记 deprecated。

### Task 4: Runtime acceptance and docs

**Files:** `docs/需求文档/WebRemoteDesktop-需求文档.md`, `docs/superpowers/reports/2026-08-30-terminal-shared-session-acceptance.md`.

- [ ] 运行本地单浏览器流程；若已有两个独立浏览器上下文，则运行双浏览器流程，分别记录 UI、共享输入、detach、close、断网恢复结果。
- [ ] 未执行的真实项目保持 `NOT RUN`，不得由单测替代。
- [ ] 运行 `cd signal-server && npm test`、`node --test web-client/js/terminal*.test.js` 与 `git diff --check`。
