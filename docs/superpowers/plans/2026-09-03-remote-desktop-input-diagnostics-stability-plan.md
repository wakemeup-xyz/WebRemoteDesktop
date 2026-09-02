# 远程桌面输入、诊断与界面稳定性实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复生产触控/鼠标输入、断连后的网络模式恢复、延迟诊断语义和每秒状态栏抖动，并用生产构建与浏览器证据闭环。

**Architecture:** 保留现有 Input v2 envelope、ACTIVE lease、ACK/reset barrier 和 WebRTC 状态机。改动集中在 asset graph、ChromeLayout capability、LatencyMonitor/Diagnostic 展示和 viewer CSS；适配器只通过既有 Input seam 工作，所有四项共享同一套 Node 与 Playwright 验收矩阵。

**Tech Stack:** Vanilla JavaScript、CSS、Node `node:test`、Python `pytest`、Playwright acceptance harness、现有 signal-server build pipeline。

**Spec:** `docs/superpowers/specs/2026-09-03-remote-desktop-input-diagnostics-stability-design.md`

## Global Constraints

- 不新增网络模式、信令协议、依赖或 DesktopControlLease；继续使用 v2 envelope、ACK、序列和 reset barrier。
- `desktopScripts` 中 `touch-input-adapter.js`、`mobile-text-input.js` 必须在 `input.js` 前加载；Terminal 仍按需加载。
- Host timing 仅统计有限且非负实测值；null/非法/不完整字段保持 `available:false`，不得伪造 network/encode 耗时。
- Viewer input RTT 和 paint 使用同一 `performance.now()` 基准；Host `hostExecuteMs` 作为独立本机耗时。
- 不启动、停止、重启或重建 Cloudflare tunnel；真实设备和公网物理路径无证据时标记 `NOT RUN`。
- 保留工作树中的用户改动；提交前检查 staged 文件名与 `git diff --cached --check`。

## 文件责任表

| 文件 | 责任 |
|---|---|
| `signal-server/scripts/web-asset-graph.js` | 生产 desktop 脚本顺序 |
| `signal-server/test/web-asset-build.test.js` | 构建图和 bundle 资源契约 |
| `web-client/js/input.js` | 触控适配器装配、loading 交互兼容 |
| `web-client/js/touch-input-adapter.js` / `mobile-text-input.js` | 既有适配器实现（仅在当前代码缺失/未装配时接入） |
| `web-client/js/chrome-layout.js` / `chrome-layout.test.js` | disconnected 网络 capability |
| `web-client/js/latency-monitor.js` / `latency-monitor.test.js` | 时钟、schema 和 unavailable 统计 |
| `web-client/js/diagnostic.js` / `diagnostic.test.js` | 未测量/0ms 显示语义 |
| `web-client/js/webrtc.js` / `webrtc.test.js` | 动态状态字段渲染，不改变采样周期 |
| `web-client/css/viewer.css` / `web-client/css/viewer-layout.test.js` | 固定指标槽位和布局契约 |
| `docs/需求文档/WebRemoteDesktop-需求文档.md` | 实施后同步功能状态/剩余验收 |

### Task 1: Lock the production asset and input contracts

**Files:**
- Modify: `signal-server/scripts/web-asset-graph.js`
- Test: `signal-server/test/web-asset-build.test.js`
- Test/Modify: `web-client/js/input.test.js`, `web-client/js/touch-input-adapter.test.js`, `web-client/css/viewer-layout.test.js`

**Interfaces:**
- Consumes: existing `Input.init()`, `TouchInputAdapter.create()`, `MobileTextInput.create()`, `buildWebClient()`.
- Produces: deterministic desktop bundle containing both adapters before `input.js`; touch and desktop pointer tests that assert v2 mouse actions and no pending entry without transport.

- [ ] **Step 1: Add failing asset-order assertions**

```js
const graph = require('../scripts/web-asset-graph');
assert.ok(graph.desktopScripts.includes('js/touch-input-adapter.js'));
assert.ok(graph.desktopScripts.includes('js/mobile-text-input.js'));
assert.ok(graph.desktopScripts.indexOf('js/touch-input-adapter.js') < graph.desktopScripts.indexOf('js/input.js'));
assert.ok(graph.desktopScripts.indexOf('js/mobile-text-input.js') < graph.desktopScripts.indexOf('js/input.js'));
```

- [ ] **Step 2: Run the focused asset test and confirm the current failure**

Run: `node --test signal-server/test/web-asset-build.test.js`

Expected: FAIL because the two adapter paths are absent from `desktopScripts`.

- [ ] **Step 3: Add the two scripts in dependency order and assert bundle symbols**

Insert both paths immediately before `js/input.js`. Extend the build test to read the emitted desktop bundle and assert `TouchInputAdapter` and `MobileTextInput` (or the exact current adapter global) are present.

- [ ] **Step 4: Add/adjust input regression tests**

Assert a touch tap reaches `sendInput('mouse','down/up')` through the adapter, a desktop pointer click remains unchanged, and `sendInput` returns `null` without an open transport without adding to `LatencyMonitor` pending maps. Reuse existing test harnesses; do not introduce a second envelope fixture.

- [ ] **Step 5: Run the focused suite**

Run: `node --test signal-server/test/web-asset-build.test.js web-client/js/input.test.js web-client/js/touch-input-adapter.test.js`

Expected: PASS.

- [ ] **Step 6: Commit only task hunks**

```bash
git add signal-server/scripts/web-asset-graph.js signal-server/test/web-asset-build.test.js web-client/js/input.test.js web-client/js/touch-input-adapter.test.js
git diff --cached --check
git commit -m "fix: ship touch input adapters in desktop bundle"
```

### Task 2: Keep network recovery available after disconnect

**Files:**
- Modify: `web-client/js/chrome-layout.js`
- Test: `web-client/js/chrome-layout.test.js`
- Test/Modify: `web-client/js/webrtc.test.js`

**Interfaces:**
- Consumes: `ChromeLayout.getCapabilities/applyCapabilities`, existing `WebRTC.setNetworkMode()` and reconnect attempt lifecycle.
- Produces: `canOpenNetwork === true` for `disconnected`; selecting a mode clears the failed attempt and invokes the standard reconnect path with the selected mode.

- [ ] **Step 1: Add failing disconnected capability test**

```js
const caps = ChromeLayout.getCapabilities({ uiPhase: 'disconnected', streamReady: false });
assert.equal(caps.canOpenNetwork, true);
```

Add an `applyCapabilities` fixture asserting `networkModeBtn.hidden === false` and `disabled === false` in disconnected state.

- [ ] **Step 2: Run the focused test to verify failure**

Run: `node --test web-client/js/chrome-layout.test.js`

Expected: FAIL with the current gate returning false/hidden.

- [ ] **Step 3: Implement the capability correction**

Change only the network capability predicate; keep `idle` hidden and keep terminal/resolution/media controls fail-closed. Verify no caller assumes network button implies media readiness.

- [ ] **Step 4: Add reconnect-mode regression coverage**

In the existing WebRTC harness, simulate an automatic failure, invoke the mode selection callback with `relay`, and assert the stored `networkMode` is `relay`, the previous attempt/search is canceled, and exactly one normal reconnect is scheduled. Assert automatic failure itself does not mutate mode.

- [ ] **Step 5: Run tests and commit**

Run: `node --test web-client/js/chrome-layout.test.js web-client/js/webrtc.test.js`

```bash
git add web-client/js/chrome-layout.js web-client/js/chrome-layout.test.js web-client/js/webrtc.test.js
git diff --cached --check
git commit -m "fix: keep network mode recovery available after disconnect"
```

### Task 3: Make latency measurements truthful and explicit

**Files:**
- Modify: `web-client/js/latency-monitor.js`
- Test: `web-client/js/latency-monitor.test.js`
- Modify: `web-client/js/diagnostic.js`
- Test: `web-client/js/diagnostic.test.js`

**Interfaces:**
- Consumes: Host v2 `timings`, legacy timestamp frames, `performance.now()`, `input_ack.hostExecuteMs`.
- Produces: `LatencyMonitor.getStats()` with `available` semantics; `Diagnostic` panel text `未测量` for unavailable and `0ms` for valid zero.

- [ ] **Step 1: Add failing schema and clock tests**

Cover: v2 null fields leave `encode/network` unavailable; v2 `0` is counted; NaN/negative values are ignored; legacy partial or out-of-order timestamps add no samples; valid legacy timestamps still calculate capture/scale/encode only from one host-time basis; input RTT and paint use mocked `performance.now()`.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node --test web-client/js/latency-monitor.test.js web-client/js/diagnostic.test.js`

Expected: FAIL on unavailable text and/or invalid legacy sample acceptance.

- [ ] **Step 3: Implement finite non-negative validators and monotonic local timing**

Add a private `readDuration(value)` helper returning `null` unless finite and `>= 0`. Gate legacy computation on all required timestamps and monotonic order. Remove the fallback that derives network as `Date.now() - packetSend`; leave network empty when no viewer-side receive timestamp exists. Replace local `Date.now()` deltas used for input/paint with `performance.now()` while retaining wall-clock timestamps only for sliding-window expiry.

- [ ] **Step 4: Update diagnostic rendering**

Change `setBar` to inspect `stats.<phase>.available`; render `未测量` with no warning class when false, otherwise render rounded milliseconds including `0ms`.

- [ ] **Step 5: Run focused and existing latency suites**

Run: `node --test web-client/js/latency-monitor.test.js web-client/js/diagnostic.test.js web-client/js/webrtc-stats.test.js`

Expected: PASS with all unavailable phases excluded from p50/p95 counts.

- [ ] **Step 6: Commit**

```bash
git add web-client/js/latency-monitor.js web-client/js/latency-monitor.test.js web-client/js/diagnostic.js web-client/js/diagnostic.test.js
git diff --cached --check
git commit -m "fix: distinguish unavailable latency measurements"
```

### Task 4: Stabilize dynamic status-bar geometry

**Files:**
- Modify: `web-client/css/viewer.css`
- Modify: `web-client/js/webrtc.js`
- Test: `web-client/css/viewer-layout.test.js`
- Test/Modify: `web-client/js/webrtc.test.js`

**Interfaces:**
- Consumes: existing 1-second `WebRtcStats` sampler and `processStatsSnapshot()` text updates.
- Produces: fixed-size FPS, latency, candidate display slots; dynamic values cannot shift neighboring controls.

- [ ] **Step 1: Add failing CSS/static and browser geometry assertions**

Assert the three status elements have `display:inline-block`, fixed/minimum inline size, `white-space:nowrap`, and `font-variant-numeric:tabular-nums`. In the browser harness sample `5 ms` then `10 ms` and assert the next control's `getBoundingClientRect().x` changes by at most 1px.

- [ ] **Step 2: Run focused layout test to verify failure**

Run: `node --test web-client/css/viewer-layout.test.js web-client/js/webrtc.test.js`

Expected: FAIL before the slot declarations/geometry assertion exist.

- [ ] **Step 3: Implement fixed metric slots**

Add a shared metric-slot class or targeted selectors for `#fpsDisplay`, `#latencyDisplay`, and `#candidateDisplay`; reserve width for the longest supported label, prevent wrapping, and use tabular numerals. Keep text content and sampler interval unchanged.

- [ ] **Step 4: Verify no overlap at supported viewports**

Run the Playwright harness at 375x812, 768x1024, and 1440x900. Assert status bar, video, and dock rectangles do not overlap and that 5 seconds of samples keep adjacent x positions within 1px.

- [ ] **Step 5: Commit**

```bash
git add web-client/css/viewer.css web-client/js/webrtc.js web-client/css/viewer-layout.test.js web-client/js/webrtc.test.js
git diff --cached --check
git commit -m "fix: reserve stable status metric layout"
```

### Task 5: Full regression, production and runtime evidence

**Files:**
- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md`
- Create: `docs/superpowers/reports/2026-09-03-remote-desktop-input-diagnostics-stability-acceptance.md`

**Interfaces:**
- Consumes: Tasks 1-4 outputs, existing service URL and operator-run acceptance harness.
- Produces: immutable evidence separating PASS, NOT RUN and remaining runtime risks; requirements document synchronized with actual implementation.

- [ ] **Step 1: Run all JavaScript and Python/Signal tests**

```bash
node --test web-client/js/*.test.js web-client/css/*.test.js signal-server/test/*.test.js
pytest -q python-host/test_latency_timing.py python-host/test_connection_diagnostics.py python-host/test_input_handler.py
```

Record exact command, counts and failures; do not overwrite prior artifacts.

- [ ] **Step 2: Build and smoke-test production assets**

Run the existing build command used by `signal-server/test/web-asset-build.test.js`; serve the emitted directory with the existing local harness and request `/js/touch-input-adapter.js` and `/js/mobile-text-input.js`. Record HTTP 200 and bundle hash without recording passwords/tokens.

- [ ] **Step 3: Run browser acceptance against the already-running origin**

Use the formal `https://link.stockhub.wiki` when available, otherwise the operator-provided local origin. Exercise desktop click, touch tap/drag/wheel, automatic failure to disconnected, manual relay/tunnel selection, diagnostic null/zero rendering, and 5-second geometry stability. Never rebuild the quick tunnel.

- [ ] **Step 4: Record evidence and synchronize requirements**

Write PASS/FAIL/NOT RUN per matrix row, including viewport, browser, origin class, artifact path and reason. Mark real Android/iOS/iPad, Quartz and physical public-path checks `NOT RUN` unless operator evidence exists. Update only the affected checklist lines in `docs/需求文档/WebRemoteDesktop-需求文档.md`.

- [ ] **Step 5: Final scope review**

```bash
git diff --check
git status --short
rg -n "TBD|TODO|Similar to Task|implement later|appropriate error handling" docs/superpowers/specs/2026-09-03-remote-desktop-input-diagnostics-stability-design.md
```

Expected: no placeholder matches; unrelated dirty files remain untouched. Commit docs and evidence separately from implementation hunks.
