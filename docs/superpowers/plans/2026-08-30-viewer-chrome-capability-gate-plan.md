# Viewer Chrome 与 Capability Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Viewer 的移动端几何、连接阶段误操作和关键可访问性缺口。

**Architecture:** 在 `chrome-layout.js` 内建立几何与 capability seam；WebRTC 继续拥有连接/租约真相，UI 只消费快照和 capability。CSS token、Dock 和 dialog 语义独立演进。

**Tech Stack:** Vanilla JS、CSS、Node built-in test runner、现有 Playwright/webtest。

**Spec:** `docs/superpowers/specs/2026-08-30-viewer-chrome-capability-gate-design.md`

**执行结果（2026-08-30）：** 已合入 `f334b1b`、`1651eaf`、`cc66bd8`。Chrome/layout/Terminal 相关测试通过，主分支 web build 与 asset contract 通过；375/768/1440 浏览器几何、公网 tunnel 和真实 Host 未运行。

## Global Constraints

- 不引入 npm 依赖、图标库、SPA 或新字体。
- 不修改网络模式行为、WebRTC/输入协议、Terminal PTY 语义和产品命名。
- 每个任务先写失败测试，再写最小实现。
- 不启动或重建 Cloudflare tunnel。

### Task 1: Geometry contract

**Files:** `web-client/js/chrome-layout.js`, `web-client/css/viewer.css`, `web-client/viewer.html`, `web-client/css/viewer-layout.test.js`, `web-client/js/chrome-layout.test.js`

- [ ] 在 `web-client/js/chrome-layout.test.js` 添加 `syncChromeTop(223)` 写入 `--chrome-top: 223px` 的失败测试；在 `web-client/css/viewer-layout.test.js` 添加 Dock wrapper、`[hidden]`、`100dvh` 和 Terminal DOM 顺序断言。
- [ ] 用 `ResizeObserver` 写入 `--chrome-top`，将 Dock 两栏移入同一固定容器，并加入 `dvh/vh` 回退、safe-area 和 44px touch token。
- [ ] 运行 `node --test web-client/js/chrome-layout.test.js web-client/css/viewer-layout.test.js`；预期所有新增断言 PASS。
- [ ] 在 `signal-server` 运行 `npm run build:web`，再运行 `node --test test/web-asset-build.test.js`，确认构建产物仍只有规定的 stylesheet/script 入口。

### Task 2: Capability gate and honest placeholder

**Files:** `web-client/js/chrome-layout.js`, `web-client/js/webrtc.js`, `web-client/js/ui.js`, `web-client/js/shell-guard.js`, `web-client/js/chrome-layout.test.js`, `web-client/js/shell-guard.test.js`, `web-client/js/webrtc.test.js`

- [ ] 在 `web-client/js/chrome-layout.test.js` 为 `idle/signaling/media-pending/connected/media-stalled/disconnected` 写 capability 表测试，断言每个状态的 `canConnect/canSendDesktopInput/canRefresh/canPause/canDisconnect`。
- [ ] 实现单一 `applyCapabilities(snapshot)`，按 capability 更新 disabled/hidden；保留 WebRTC 的控制租约判断，不复制状态机。
- [ ] 仅在真正开始 signaling 时加 `is-connecting`，未开始时移除 spinner。
- [ ] 运行 `node --test web-client/js/chrome-layout.test.js web-client/js/shell-guard.test.js web-client/js/webrtc.test.js`；预期新增状态断言 PASS。
- [ ] 在 `signal-server` 运行 `npm test`，确认完整 Node 回归通过。

### Task 3: Accessibility and Terminal reveal

**Files:** `web-client/viewer.html`, `web-client/index.html`, `web-client/css/viewer.css`, `web-client/css/login.css`, `web-client/js/terminal.js`, `web-client/css/viewer-layout.test.js`, `web-client/js/terminal.test.js`

- [ ] 在 `web-client/css/viewer-layout.test.js` 断言 tabs/panels/dialog 标题关系；在 `web-client/js/terminal.test.js` 断言动态 tab 的 `role/aria-selected/aria-controls` 和未授权隐藏。
- [ ] 实现焦点保存与恢复、Escape 关闭、未授权 Terminal 隐藏 workspace/composer、全屏内退出按钮。
- [ ] 运行 `node --test web-client/css/viewer-layout.test.js web-client/js/terminal.test.js`，预期新增 ARIA/状态断言 PASS。
- [ ] 在现有本地服务上用 Playwright 检查 375/768/1440、未连接、已连接空闲、Terminal 未授权和全屏；保存几何 JSON 与截图，不重启服务。

### Task 4: Documentation and regression gate

**Files:** `docs/需求文档/WebRemoteDesktop-需求文档.md`, `docs/superpowers/reports/2026-08-30-viewer-chrome-acceptance.md`

- [ ] 更新需求中的顶栏契约、Dock 单列、空闲退避和全屏退出描述。
- [ ] 记录每个视口的截图/几何数据和未覆盖的真实公网验收。
- [ ] 执行 `git diff --check`、`cd signal-server && npm test`、`cd python-host && PYTHONPATH=. python3 -m pytest -q`，记录 warning 与未运行的公网验收。
