# 沉浸全屏 Chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 让 document-level fullscreen 自动隐藏顶部状态栏和底部 Dock，同时以不占布局、按需唤出的 overlay 提供可靠退出路径。

**Current status:** Task 1–3 已实施（Task 1: `a61a787`、`1c23db0`；Task 2: `1b454c8`、viewport 修复 `8682589`；Task 3: `1305d2f`、`060241e`）；Task 4 已提交，完整 SHA 为 `0a5e5caf1d53b3a82d24110c58649220b8982ab6`，并已更新离线 native acceptance、supersession note 与当前验证命令。Task 2 viewport 修复后，1440×900 与 375×812 的 `viewerFillsVisibleViewportWithoutTextDock` 均为 `true`，offline Chromium 12/12 场景通过，Node wrapper 4/4、focused trio 80/80、Viewer JS/CSS 715/715、Signal build/test 339/339 通过。真实设备、WebKit、Quartz、公网与 live watcher 仍 `NOT RUN`；完整安全 artifact 与命令计数见 Task 4 report。

**Architecture:** 保留 document.documentElement 为唯一 fullscreen target，UI 镜像其状态到既有 body.fullscreen-active。ChromeLayout 在该派生状态中把有效顶栏高度归零并暂停自己的 idle timer；HTML/CSS 新增独立 fixed overlay，不能消费或改写 controls-hidden、chrome-idle 的普通 Viewer 语义。

**Tech Stack:** Vanilla JavaScript、CSS、Node node:test、Python Playwright 离线 Chromium、Signal web build。

**Spec:** docs/superpowers/specs/2026-09-06-immersive-fullscreen-chrome-design.md

## Global Constraints

- document.documentElement 继续是唯一 fullscreen target；不实现 iOS 私有 video-only fallback。
- 禁止用 controls-hidden 或 chrome-idle 表示 fullscreen，也禁止全屏进入/退出时快照覆盖这两个 class。
- 不改 WebRTC、媒体、Input/lease wire protocol、Terminal/PTY、网络顾问、tunnel 或服务启动脚本。
- 退出入口在 desktop/Terminal、compact/idle、无 active lease、移动 viewport resize 下都必须可用；按钮命中盒不小于 44px。
- 不记录用户输入、坐标、密码、token 或公网地址；浏览器验收维持离线、阻断外网和服务请求。
- 不运行或宣称真实设备、Quartz、WebKit、正式公网路径和 live watcher；无证据时标为 NOT RUN。
- 当前主工作树存在用户的非本任务脏文件；使用隔离 worktree，禁止 git add .、整体 stash 或覆盖无关文件。

## 文件职责

| 路径 | 职责 |
|---|---|
| web-client/js/chrome-layout.js | fullscreen 有效顶部高度与 idle timer 隔离；不拥有 fullscreen API。 |
| web-client/js/chrome-layout.test.js | 有效几何、timer 与普通 chrome class 保持测试。 |
| web-client/viewer.html | 独立 fullscreen exit overlay DOM；保留普通状态栏反馈。 |
| web-client/css/viewer.css | 沉浸 fullscreen、fixed/safe-area overlay、reduced-motion 规则。 |
| web-client/css/viewer-layout.test.js | DOM/CSS 契约与静态层级测试。 |
| web-client/js/ui.js | fullscreenchange、inert、reveal timer、exit failure 和事件隔离。 |
| web-client/js/ui.test.js | UI 状态、焦点、overlay、失败与重入回归。 |
| scripts/mobile_input_interaction_acceptance.py | 离线 native fullscreen 的真实 DOM/命中/几何验收。 |
| scripts/mobile-input-interaction-acceptance.test.js | 离线验收 CLI 和安全 artifact 契约。 |
| docs/superpowers/specs/2026-09-06-mobile-input-interaction-remediation-design.md | 增加 supersession note，消除旧 status-bar exit 放置说明。 |

---

### Task 1: 把 fullscreen 几何与 idle 生命周期从普通 Dock 状态机分离

**Files:**
- Modify: web-client/js/chrome-layout.js
- Test: web-client/js/chrome-layout.test.js

**Interfaces:**
- Produces ChromeLayout.isFullscreenActive(rootEl): boolean，只读取 body.fullscreen-active。
- Produces ChromeLayout.setFullscreenActive(active, rootEl): void；调用方必须先同步 body class。
- Consumes现有 syncChromeTop、recalculate、computeMobileLayout、bindIdle；不改 controls-hidden/chrome-idle 的公开语义。

- [ ] **Step 1: 写 fullscreen 有效 top 与 idle 保持的失败测试。**

  在既有 fake root/样式夹具中加入 body classes、44px statusBar、非零 chromeDocks、touch desktop panel 和一个可观测 timer。覆盖：fullscreen 后 --chrome-top 是 0px、布局输入的有效 dockContentHeight 是 0、--mobile-viewer-top 是 0px 且 viewerHeight 不留 Dock 空白；退出后恢复 44px 与实测 Dock 高度。另测 mobileInputDock 可见时仅保留 textReserve。fullscreen 调用 enterIdle、timer callback 与 bump 不得改变预先存在的 chrome-idle 或 controls-hidden。

~~~js
test('fullscreen uses zero effective chrome top without rewriting dock state', () => {
  const h = makeLayoutHarness({ chromeTop: 44, streamConnected: true });
  h.body.classList.add('fullscreen-active');
  h.body.classList.add('controls-hidden');
  ChromeLayout.setFullscreenActive(true, h.root);
  assert.equal(h.properties.get('--chrome-top'), '0px');
  assert.equal(h.properties.get('--mobile-viewer-top'), '0px');
  assert.equal(h.layoutInput.dockContentHeight, 0);
  ChromeLayout.enterIdle(h.root);
  assert.equal(h.body.classList.contains('controls-hidden'), true);
  assert.equal(h.body.classList.contains('chrome-idle'), false);
});
~~~

- [ ] **Step 2: 运行测试确认旧实现失败。**

Run: node --test web-client/js/chrome-layout.test.js
Expected: fullscreen test fails because current syncChromeTop rejects 0 and idle methods still mutate normally.

- [ ] **Step 3: 实现单一派生 fullscreen 检查与有效高度。**

  添加 isFullscreenActive(rootEl)，从 root 的 body 读取 class。让 syncChromeTop 接受有限的非负值；新增内部 effectiveChromeTop(measured, root)，fullscreen 返回 0，其余保留 measured || 56。_getLayoutInputs() 在 fullscreen 时传入 dockContentHeight: 0，但不清掉真实 Dock 测量、也不改变 textDockHeight/textVisible。recalculate() 和 _getLayoutInputs() 必须都使用这一个有效值；observeStatusBar() 改为触发 recalculate()，不能先把原始高度直接写回 style。

~~~js
effectiveChromeTop(measured, rootEl) {
  if (this.isFullscreenActive(rootEl)) return 0;
  const value = Number(measured);
  return Number.isFinite(value) && value > 0 ? value : 56;
},
syncChromeTop(px, rootEl) {
  const height = Number(px);
  if (!Number.isFinite(height) || height < 0) return;
  this._writeStyleValue(rootEl || document.documentElement, '--chrome-top', Math.round(height) + 'px');
},
~~~

- [ ] **Step 4: 暂停 fullscreen 期间的 ChromeLayout idle 派生。**

  setFullscreenActive(true) 清理 timer 后重算布局；false 时重算并仅在既有 stream/controls/mobile-input 门禁允许时重新 arm。armIdleTimer、timer callback、enterIdle、bump 和 mutation callback 开头检查 isFullscreenActive(root)；fullscreen 时不添加/移除 chrome-idle、不改 toggle 文案的普通状态语义、也不重启 timer。不要对 classes 做 snapshot/restore，避免覆盖全屏期间其他真实状态变化。

~~~js
setFullscreenActive(active, rootEl) {
  const root = rootEl || document;
  this.clearIdleTimer();
  this.recalculate(root, { schedule: true });
  if (active || this.isFullscreenActive(root)) return;
  const inputs = this.collectIdleInputs(root);
  if (inputs.streamConnected && !inputs.controlsHidden) {
    this._lastActivity = Date.now();
    this.armIdleTimer(root);
  }
},
~~~

- [ ] **Step 5: 运行本任务测试。**

Run: node --test web-client/js/chrome-layout.test.js
Expected: PASS; 覆盖 normal/managed geometry、0 top、effective dock=0、移动文本 reserve 保留、退出恢复、fullscreen timer 无 class 写入、普通 controls-hidden/chrome-idle 行为不回归。

- [ ] **Step 6: 提交本任务。**

~~~bash
git add web-client/js/chrome-layout.js web-client/js/chrome-layout.test.js
git diff --cached --check
git commit -m "fix(viewer): isolate fullscreen chrome geometry"
~~~

### Task 2: 建立独立的非布局退出 overlay 与沉浸 CSS

**Files:**
- Modify: web-client/viewer.html
- Modify: web-client/css/viewer.css
- Test: web-client/css/viewer-layout.test.js

**Interfaces:**
- Produces #fullscreenExitOverlay, #fullscreenExitRevealBtn, #fullscreenExitPanel, #exitFullscreenBtn, #fullscreenExitStatus。
- Keeps existing #fullscreenStatus in #statusBar .status-actions for ordinary requestFullscreen failure.
- Consumes body.fullscreen-active and html:fullscreen；does not target controls-hidden.

- [ ] **Step 1: 改写旧 DOM/CSS 契约的失败测试。**

  把旧的“exit control stays in global status chrome”断言替换为：exit button 不在 #statusBar/#chromeDocks；overlay 是 body 直接子层；normal #fullscreenStatus 保留；fullscreen CSS 隐藏 status/docks 并让 Viewer 使用完整 100dvh；reveal 与 exit button 有 safe-area、fixed、44px、正确 pointer-events。

~~~js
test('fullscreen chrome hides independently while exit overlay stays interactive', () => {
  assert.match(html, /id="fullscreenExitOverlay"/);
  const exitOffset = html.indexOf('id="exitFullscreenBtn"');
  const statusOffset = html.indexOf('id="statusBar"');
  assert.ok(exitOffset > -1 && exitOffset < statusOffset);
  assert.match(css, /html:fullscreen body\.fullscreen-active #statusBar,[\s\S]*#chromeDocks[\s\S]*visibility:\s*hidden/);
  assert.match(css, /html:fullscreen body\.fullscreen-active \.viewer-container[\s\S]*height:\s*100dvh/);
});
~~~

- [ ] **Step 2: 运行测试确认旧实现失败。**

Run: node --test web-client/css/viewer-layout.test.js
Expected: FAIL because the current exit button is a status-actions child and fullscreen still subtracts --chrome-top.

- [ ] **Step 3: 调整 HTML，保留普通错误状态，迁移唯一 exit button。**

  从 .status-actions 移走仅有的 #exitFullscreenBtn，不能复制 ID。紧随 #mobileSafeAreaProbe 添加 spec 中的 overlay；#fullscreenExitPanel 初始 hidden，#fullscreenExitStatus 初始 hidden 且有 role=status、aria-live=polite。不要把 overlay 放入 .viewer-container，以便 Terminal tab 与 desktop panel hidden 时仍然可用。

- [ ] **Step 4: 写 fullscreen 专属 CSS。**

  删除旧 .fullscreen-exit-btn position: static 与全屏直接显示 status-bar child 的规则。添加根 fullscreen + body.fullscreen-active selectors：状态栏/Dock visibility:hidden; pointer-events:none，body padding=0，非 managed 且未显示 mobileInputDock 的 fullscreen viewer 为完整 100vh/100dvh；如既有 mobile-input-visible，唯一保留文本 dock reserve，不能与画面重叠。Overlay 使用 position:fixed; inset:0; z-index:400; pointer-events:none；顶部右侧 handle 和 panel 使用 pointer-events:auto、safe-area top/right、min-width/min-height:var(--touch-min)。

~~~css
.fullscreen-exit-overlay { position: fixed; inset: 0; z-index: 400; pointer-events: none; visibility: hidden; }
html:fullscreen body.fullscreen-active .fullscreen-exit-overlay { visibility: visible; }
.fullscreen-exit-reveal, .fullscreen-exit-panel { pointer-events: auto; }
.fullscreen-exit-panel[hidden] { display: none; }
html:fullscreen body.fullscreen-active #statusBar,
html:fullscreen body.fullscreen-active #chromeDocks { visibility: hidden; pointer-events: none; }
html:fullscreen body.fullscreen-active:not(.mobile-layout-managed):not(.mobile-input-visible) .viewer-container {
  height: 100dvh;
}
html:fullscreen body.fullscreen-active:not(.mobile-layout-managed).mobile-input-visible .viewer-container {
  height: calc(100dvh - var(--mobile-text-dock-reserve, 0px));
}
~~~

  prefers-reduced-motion 下 panel/handle 不使用位移动画。不要新增 controls-hidden fullscreen 规则；原有 Dock、More、mobile managed 和 network advisor CSS 保持。

- [ ] **Step 5: 运行 CSS/DOM 回归。**

Run: node --test web-client/css/viewer-layout.test.js
Expected: PASS; 旧 hidden/flex、mobile safe-area、Dock/More、Terminal layout assertions 继续通过。

- [ ] **Step 6: 提交本任务。**

~~~bash
git add web-client/viewer.html web-client/css/viewer.css web-client/css/viewer-layout.test.js
git diff --cached --check
git commit -m "feat(viewer): add immersive fullscreen exit overlay"
~~~

### Task 3: 连接 fullscreenchange、inert、edge reveal 与错误反馈

**Files:**
- Modify: web-client/js/ui.js
- Test: web-client/js/ui.test.js

**Interfaces:**
- Consumes Task 1 ChromeLayout.setFullscreenActive(active) and Task 2 overlay IDs.
- Produces a closure-local revealFullscreenExit() / hideFullscreenExit() and FULLSCREEN_EXIT_REVEAL_MS = 4000.
- Preserves exitFullscreen(): Promise<boolean> and original #fullscreenStatus behavior.

- [ ] **Step 1: 扩展 UI harness 并写失败测试。**

  让 makeElement 支持 contains、hasAttribute、removeAttribute、toggleAttribute 和多个事件监听；harness 注入可手动 flush 的 fake timer，并让 fake ChromeLayout 记录 setFullscreenActive/recalculate 调用。新增测试：

  1. fullscreenchange 会同步 class、status/Dock inert 和 setFullscreenActive(true)，不改 pre-existing controls-hidden/chrome-idle；
  2. 首次进入显示 panel，timer 后隐藏；reveal handle pointerdown/click 消费事件、重开 panel 且不触碰远程 surface；
  3. Terminal、mobile editor、lease loss 时 reveal 后 exit 保留焦点且可退出；
  4. missing/rejected exit API 保持 fullscreen，显示 #fullscreenExitStatus 并保持 panel；
  5. fullscreenchange 退出（包括 Esc 模拟）清 timer、关闭 panel、只恢复本次设置的 inert。

~~~js
test('fullscreen edge reveal never reuses controls-hidden', () => {
  const h = makeHarness();
  h.context.__UI.setupControlButtons();
  h.document.body.classList.add('controls-hidden');
  h.document.fullscreenElement = h.document.documentElement;
  h.dispatchDocument('fullscreenchange');
  const event = h.pointerDown('fullscreenExitRevealBtn');
  assert.equal(event.prevented, true);
  assert.equal(h.document.body.classList.contains('controls-hidden'), true);
  assert.equal(h.elements.get('fullscreenExitPanel').hidden, false);
});
~~~

- [ ] **Step 2: 运行测试确认旧实现失败。**

Run: node --test web-client/js/ui.test.js
Expected: FAIL because overlay IDs, timer behavior, inert handling and ChromeLayout.setFullscreenActive calls do not exist.

- [ ] **Step 3: 实现一次性 overlay 生命周期。**

  在 setupControlButtons() 获取新 DOM 节点，定义 revealTimer。revealFullscreenExit() 仅当 document-root fullscreen 时执行：清旧 timer、展开 panel、设置 aria-expanded=true，4 秒后仅隐藏 panel/aria state。Reveal handler 的 pointerdown/click 都要阻止冒泡；exit button 继续使用 preserveEditingFocusOnPointerDown，并额外阻止事件进入全局 input handler。

~~~js
const revealFullscreenExit = () => {
  if (!isDocumentFullscreen()) return;
  clearTimeout(revealTimer);
  exitPanel.hidden = false;
  revealButton?.setAttribute('aria-expanded', 'true');
  revealTimer = setTimeout(hideFullscreenExit, 4000);
};
~~~

- [ ] **Step 4: 在 fullscreenchange 中协调 UI 与 ChromeLayout。**

  updateFullscreenState() 必须按以下顺序：计算 root fullscreen → 更新 fullscreenBtn 文案/aria → toggle fullscreen-active → 对 status/Dock 设置/恢复 inert（记录进入前是否已有 inert）→ 进入时 reveal，退出时 hide → 调用 ChromeLayout.setFullscreenActive(isFullscreen)；仅当该接口不存在时 fallback 到 recalculate()。不要改变 controls-hidden、chrome-idle、More 或 lease gate。

  exit API 失败时同时写入普通 fullscreenStatus 与 fullscreenExitStatus；后者只在 fullscreen 中触发 revealFullscreenExit()。request API 的已有失败路径只写普通 status，保持焦点/草稿/普通视图。

- [ ] **Step 5: 运行 UI 单测。**

Run: node --test web-client/js/ui.test.js
Expected: PASS; 包括已有 root target、request failure、Terminal、lease loss 与 re-entry 场景，以及新的 edge/timer/inert/state-isolation 场景。

- [ ] **Step 6: 提交本任务。**

~~~bash
git add web-client/js/ui.js web-client/js/ui.test.js
git diff --cached --check
git commit -m "fix(viewer): preserve fullscreen exit outside chrome"
~~~

### Task 4: 更新离线验收与当前文档，并做全量验证

**Files:**
- Modify: scripts/mobile_input_interaction_acceptance.py
- Modify: scripts/mobile-input-interaction-acceptance.test.js（仅在 scenario names/count/safe artifact assertion 需同步时）
- Modify: docs/superpowers/specs/2026-09-06-mobile-input-interaction-remediation-design.md
- Modify: docs/superpowers/specs/2026-09-06-immersive-fullscreen-chrome-design.md
- Modify: docs/superpowers/plans/2026-09-06-immersive-fullscreen-chrome-plan.md

**Interfaces:**
- Keeps acceptance scope: offline-synthetic and all request routing blocked.
- Replaces only stale fullscreen assertions; does not loosen pre-existing focus/lease/Terminal checks.

- [x] **Step 1: 先让离线 native fullscreen 验收表达新期望。**

  修改 fullscreen_exit_probe() 以分别检测 reveal handle 与已展开的 exit button；在 click exit 前显式点击 handle，不能依赖 Playwright locator 的隐式滚动或自动显示。fullscreen_containment() 移除旧的 status-bar 放置与 viewer-top 关系断言，改为以下 bool：

~~~python
{
  "statusChromeHidden": style_status.visibility == "hidden" and style_status.pointerEvents == "none",
  "dockChromeHidden": style_docks.visibility == "hidden" and style_docks.pointerEvents == "none",
  "viewerStartsAtVisibleTop": abs(viewer.top - visible_top) <= 1,
  "viewerFillsVisibleViewportWithoutTextDock": abs(viewer.bottom - innerHeight) <= 1,
  "revealTarget44": reveal.width >= 44 and reveal.height >= 44,
  "revealHitTarget": reveal_hit === reveal || reveal.contains(reveal_hit),
  "exitTarget44AfterReveal": exit.width >= 44 and exit.height >= 44,
}
~~~

  宽屏与 375×812 均先显式关闭移动文本输入再验证完整可视区；再单独打开 mobileInputDock，断言 fullscreen 仍隐藏 status/Dock、只保留既有 textReserve 且编辑焦点不丢失。Terminal、idle、lease loss 各自点击 handle 后仍得到可点击退出按钮。idle 断言改为“fullscreen 没有新写入 chrome-idle，已有 class 不影响 overlay”，而不是期待旧 exit 位于 status bar。

- [x] **Step 2: 运行跨任务离线验收；Task 2 viewport 修复后通过。**

Run: python3 scripts/mobile_input_interaction_acceptance.py --browser chromium --out /tmp/wrd-immersive-fullscreen-integration.json
Expected: 在 Task 1–3 已完成时，fullscreen-native-containment PASS；其余场景的安全摘要保持无 payload/secret。若失败，保留 artifact 的具体 bool，回到所属的 Task 1/2/3 修复，不得放宽新断言。这个步骤是跨模块验收，不把已完成的单元 TDD 误写成“旧代码 red”。

- [x] **Step 3: 修改实现后运行离线验收与 wrapper。**

Run:

~~~bash
python3 scripts/mobile_input_interaction_acceptance.py --browser chromium --out /tmp/wrd-immersive-fullscreen-chromium.json
node --test scripts/mobile-input-interaction-acceptance.test.js
~~~

Expected: artifact scope remains offline-synthetic; all scenarios PASS or an explicitly supported browser-runtime NOT RUN; no artifact contains passwords, tokens, text payloads or coordinates.

- [x] **Step 4: 同步历史移动设计的 supersession note。**

  在旧移动设计 §8 的全屏段首句添加：

~~~markdown
> 退出入口的 DOM 放置和沉浸 chrome 规则由
> 2026-09-06-immersive-fullscreen-chrome-design.md 取代；本节保留 root target、焦点、fallback 与验收约束。
~~~

  更新新 spec/plan 的状态、实际测试命令和 commit 哈希；不要重写已完成移动整改的 Task 状态或历史证据。

- [x] **Step 5: 跑全量静态、构建和相关测试。**

Run:

~~~bash
node --test web-client/js/chrome-layout.test.js web-client/js/ui.test.js web-client/css/viewer-layout.test.js
node --test web-client/js/*.test.js web-client/css/*.test.js
(cd signal-server && npm run build:web && npm test)
git diff --check
~~~

Expected: all commands exit 0. 若 Chromium/WebKit/真实设备不可用，测试输出必须保留准确的 NOT RUN，不能转写为 PASS。

实际记录：native Chromium 已启动，12/12 场景 PASS；`fullscreen-native-containment` 的 wide/narrow 无文本 Dock viewport、overlay / hidden-chrome / focus / Terminal / idle / lease / re-entry bool 均为 true，计数为 `nativeEnter=2`、`nativeExit=2`、`terminalTransitions=2`。Node wrapper 4/4、focused trio 80/80、Viewer JS/CSS 全量 715/715、Signal build/test 339/339；Signal gate 前仅运行 `npm ci --offline` 使用本地缓存依赖，未发生外部请求。具体 artifact、命令退出码和安全范围见 Task 4 report。

- [x] **Step 6: 做范围与文档自审后提交。**

  逐项核对 spec §1–§7：fullscreen 隐藏 top/Dock、有效 top=0、overlay 44px/安全区/事件隔离、inert、focus/API failure、idle/lease/Terminal、离线证据和 NOT RUN 口径均有测试任务。搜索 plan/spec 中的 TODO|TBD|旧 status-bar 放置断言；TODO/TBD 不得存在，旧断言不得保留为当前验收期望。

~~~bash
git add scripts/mobile_input_interaction_acceptance.py \
  scripts/mobile-input-interaction-acceptance.test.js \
  docs/superpowers/specs/2026-09-06-mobile-input-interaction-remediation-design.md \
  docs/superpowers/specs/2026-09-06-immersive-fullscreen-chrome-design.md \
  docs/superpowers/plans/2026-09-06-immersive-fullscreen-chrome-plan.md
git diff --cached --check
git commit -m "test(viewer): cover immersive fullscreen chrome"
~~~

Task 4 文档/验收提交的 commit subject 为 `test(viewer): cover immersive fullscreen chrome`，完整 SHA 为 `0a5e5caf1d53b3a82d24110c58649220b8982ab6`；该 report 属于被忽略的本地 SDD 证据文件，不进入产品提交。

## Final acceptance gate

- No fullscreen code path writes controls-hidden or chrome-idle; status/Dock remain hidden only by fullscreen selectors and become interactive only after fullscreenchange exits.
- At native fullscreen 1440×900 and touch 375×812, status/Dock are not visible/hittable; without an active text dock Viewer/media span the visible viewport, and with one active only its existing reserve remains. Safe-edge reveal plus exit are 44px/in-viewport/hit-target valid.
- Request/exit failure preserves focus and gives visible feedback in the context where it occurs; Esc/external exit restores normal chrome and no stale overlay timer/inert remains.
- Existing Terminal, mobile editing, idle, More and lease-loss regression evidence stays green.
- Local-only browser evidence is reported as such; device/WebKit/public/live checks remain NOT RUN until actually run.
