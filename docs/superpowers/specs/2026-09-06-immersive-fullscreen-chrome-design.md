# 沉浸全屏 Chrome 设计

日期：2026-09-06
状态：Task 1–3 已实施；Task 4 已同步离线验收与当前文档，并在 Task 2 的 viewport 修复提交 `8682589` 后通过 12/12 场景的 offline Chromium、Node wrapper、Viewer 全量与 Signal build/test。真实设备、WebKit、Quartz、公网与 live watcher 仍为 NOT RUN；详见 Task 4 report。
关联：docs/superpowers/specs/2026-09-06-mobile-input-interaction-remediation-design.md §8（其中退出按钮位于状态栏的放置方案由本文取代；document-root、焦点与失败处理约束保留）

## 1. 问题与目标

当前 Viewer 进入 document.documentElement 全屏后，只会写入 body.fullscreen-active。固定顶部 #statusBar 和底部 #chromeDocks 仍可见，且 --chrome-top 仍保留状态栏高度，画面无法真正吃满可视区。现有 #exitFullscreenBtn 位于 #statusBar .status-actions，所以直接隐藏顶部栏会连同唯一退出入口一起隐藏。

目标是在 document-level fullscreen 中：

- 自动隐藏顶部 #statusBar 与底部 #chromeDocks，不保留顶部高度或底部交互层；
- 保留一个不占正常/全屏布局、可可靠唤出的退出入口；首次进入时短暂显示，之后可从顶部安全边缘唤出；
- 不把 fullscreen 复用为 controls-hidden，不改变后者、chrome-idle、More、控制租约、Terminal 或输入状态机的语义；
- 保留 Esc 原生退出、失败提示、编辑焦点、Terminal tab 和失去控制租约时的退出能力。

非目标：不改 WebRTC/媒体、Input/lease 协议、Terminal/PTY、网络顾问、云端 tunnel、iOS video-only fullscreen fallback 或服务生命周期。

## 2. 方案选择

| 方案 | 做法 | 结论 |
|---|---|---|
| A | 全屏时加 controls-hidden | 拒绝。它只隐藏 Dock、会改 toggle/idle/顾问行为，也不会消除顶栏的几何占用。 |
| B | 用现有 fullscreen-active 派生沉浸样式，另建固定退出 overlay | 采用。全屏事实不重复，普通 Dock 状态机不受污染，出口不依赖被隐藏的 chrome。 |
| C | 仅让视频元素进入 fullscreen | 拒绝。会破坏 document-root containment、Terminal 生命周期和已验证的移动输入/焦点契约。 |

## 3. 状态与几何契约

### 3.1 单一全屏事实源

document.fullscreenElement === document.documentElement 是唯一全屏事实源。UI 在 fullscreenchange 中同步 body.fullscreen-active；CSS、布局和 exit overlay 只消费这个同步后的派生类，不重新猜测或请求 fullscreen。

ChromeLayout 新增以下接口：

~~~js
ChromeLayout.setFullscreenActive(active, rootEl)
ChromeLayout.isFullscreenActive(rootEl) // 只读取 body.fullscreen-active
~~~

UI 先更新 body.fullscreen-active，再调用 setFullscreenActive(active)。该方法不保存第二个真假状态：进入时清掉 ChromeLayout 自己的 idle timer、重新计算几何；退出时重新测量状态栏并在满足原有门禁时重新 arm timer。

### 3.2 全屏不占布局

全屏时，ChromeLayout 的有效 chromeTop 是 0；非全屏仍是 #statusBar 的实测高度（无测量时 56px）。syncChromeTop 必须接受 0px，而不是把它丢弃为非法值。

同一轮布局输入中，#chromeDocks 的有效 dockContentHeight 也必须为 0；真实 Dock 高度仍可继续测量，以便退出 fullscreen 后立即恢复普通布局。#mobileInputDock 不属于 chromeDocks：若用户已经显式打开移动文本输入，它保持既有可编辑/焦点语义，Viewer 仅保留它的 textReserve，不得用沉浸全屏把草稿或软键盘交互覆盖掉。

这同时覆盖：

- 普通流布局：body 不再有顶部 padding，fullscreen .viewer-container 高度为 100dvh；
- mobile-layout-managed：computeMobileLayout() 接收 chromeTop: 0 且 dockContentHeight: 0，得到 viewerTop === visibleTop，画面不再扣顶部栏或 Dock；如果移动文本输入已显示，仍只扣既有 textReserve；
- 状态栏/Dock 仍可保留在 DOM 供退出后测量，但 fullscreen CSS 必须让它们 visibility: hidden、pointer-events: none，而不是借由 display:none 误触发普通 Dock 规则。

进入 fullscreen 后，#statusBar 与 #chromeDocks 还要加 inert；退出时只移除本次进入前原本不存在的 inert。这样隐藏的全屏入口不会留在键盘 Tab 顺序或屏幕阅读器交互路径中。

### 3.3 Dock 状态机隔离

controls-hidden 和 chrome-idle 是普通 Viewer chrome 的独立状态：前者还影响网络顾问，后者由底边触控/指针活动/idle timer 控制。Fullscreen 不写入、删除、快照或恢复这两个 class。

全屏期间仅暂停 ChromeLayout 自己的 idle 派生行为：

- armIdleTimer()、timer callback、enterIdle() 和 bump() 在 fullscreen-active 时不得写入 chrome-idle；
- bindIdle() 的 mutation 回调在 fullscreen 时只清理 timer，不启动新的 timer；
- 退出 fullscreen 后，根据当时真实的 stream/controls-hidden/mobile-input 状态重新计算是否应 arm timer；不覆盖任何外部在全屏期间作出的真实状态改变。

因此，fullscreen 前已经 idle 的 Dock 退出后仍 idle；fullscreen 前可见的 Dock 不会因为全屏期间计时而悄悄变成 idle；如果其他正常逻辑确实改变了 controls-hidden，退出后仍尊重该真实结果。

## 4. 退出 overlay

### 4.1 DOM 与可访问性

新增唯一的固定覆盖层，作为 body 的直接子节点，不能放在 #statusBar、#chromeDocks、.viewer-container、Terminal 面板或 More 菜单内：

~~~html
<div id="fullscreenExitOverlay" class="fullscreen-exit-overlay" aria-label="全屏控制">
  <button id="fullscreenExitRevealBtn" class="fullscreen-exit-reveal" type="button"
    aria-label="显示退出全屏入口" aria-controls="fullscreenExitPanel" aria-expanded="false">退出</button>
  <div id="fullscreenExitPanel" class="fullscreen-exit-panel" hidden>
    <button id="exitFullscreenBtn" class="fullscreen-exit-btn" type="button">退出全屏</button>
    <span id="fullscreenExitStatus" class="fullscreen-exit-status" role="status" aria-live="polite" hidden></span>
  </div>
</div>
~~~

原有 #fullscreenStatus 仍留在 #statusBar .status-actions，只用于普通视图中 requestFullscreen 不支持/拒绝的可见反馈；新的 #fullscreenExitStatus 专供顶部栏被隐藏后的退出失败反馈。#exitFullscreenBtn 从 status actions 移入新 panel，ID 保持不变。

Overlay 本身固定定位、inset: 0、pointer-events: none、高于 modal/superseded overlay；只有 reveal button 和打开的 panel 为 pointer-events: auto。它不参与 flex/grid/Viewer 高度计算。

### 4.2 触控与鼠标交互

- 进入 fullscreen 时显示退出 panel 4 秒（FULLSCREEN_EXIT_REVEAL_MS = 4000），让用户知道出口存在；超时后 panel 隐藏，但顶部安全边缘的 reveal handle 保持可用。
- Reveal handle 固定在右上安全区，命中盒至少 44px × 44px，保留可见的窄边缘提示；它不是透明的大面积热区，避免吞掉普通远程画面点击。
- 点击/轻触 handle 时，pointerdown 和 click 均 preventDefault()、stopPropagation()，只显示 panel 并重置 4 秒倒计时。它不进入远程画面 input handler。
- exit button 的 pointerdown 复用现有编辑焦点保护；点击调用已有 document-level exitFullscreen()。Esc 仍由浏览器原生处理，不新增拦截器。
- handle 聚焦、exit 失败或再次点击 handle 都会让 panel 保持可见 4 秒。panel 显示时 aria-expanded=true；隐藏时恢复 false 与 hidden。

### 4.3 异常行为

- document.exitFullscreen 缺失或 reject：保持当前 fullscreen、编辑焦点和草稿；写入原有 #fullscreenStatus 以及新 #fullscreenExitStatus，并保持 panel 展开。不得伪造成功或静默隐藏入口。
- requestFullscreen 缺失/reject：继续只使用原有 #fullscreenStatus，普通页面布局、焦点、草稿和 aria-pressed 保持原约定。
- fullscreenchange（含 Esc、浏览器 UI 或外部退出）统一清掉 reveal timer、隐藏 panel、恢复原有 inert、调用 ChromeLayout.setFullscreenActive(false)；不依赖 exit button click 才清理。
- 入口不依赖 desktop active lease、fullscreenBtn 可见性、Dock 位置、More 菜单、Terminal tab 或 mobile compact 状态。

## 5. CSS 选择器与层级

核心全屏规则使用 document-root + 派生 class，而非 controls-hidden：

~~~css
html:fullscreen body.fullscreen-active {
  padding-top: 0;
}

html:fullscreen body.fullscreen-active #statusBar,
html:fullscreen body.fullscreen-active #chromeDocks {
  visibility: hidden;
  pointer-events: none;
}

html:fullscreen body.fullscreen-active:not(.mobile-layout-managed):not(.mobile-input-visible) .viewer-container {
  height: 100vh;
  height: 100dvh;
  padding: 0;
}

html:fullscreen body.fullscreen-active:not(.mobile-layout-managed).mobile-input-visible .viewer-container {
  height: calc(100dvh - var(--mobile-text-dock-reserve, 0px));
}
~~~

mobile-layout-managed 保持通过 --mobile-viewer-top 和 --mobile-viewer-height 定位；由 ChromeLayout 的有效 top=0、effective dock=0 驱动。未 managed 的窄屏 fallback 在 mobile-input-visible 时只保留现有文本输入 reserve，其余 fullscreen viewer 为完整可视高度。不得增加另一套 fullscreen 绝对定位公式，也不得以 display:none 改变 Dock/More 尺寸观测。

Overlay 样式须满足：fixed、safe-area top/right、z-index 高于 300、button 最小 44px、prefers-reduced-motion: reduce 不使用动画、panel 未展开时不可命中/不可聚焦。非 fullscreen 时整层不可见且不可交互。

## 6. 测试与验收

| 层级 | 必须证明 |
|---|---|
| ui.test.js | root fullscreen 同步、status/Dock inert、overlay 初显/超时/edge reveal、编辑焦点、Terminal、lease loss、API failure、Esc/外部 fullscreenchange 清理。 |
| chrome-layout.test.js | fullscreen 有效 top=0、effective dock=0、managed geometry 从 visibleTop 开始且不留 Dock 空白、移动文本输入的既有 reserve 保留、退出恢复实测尺寸、idle timer 在 fullscreen 不改变 chrome-idle，不写 controls-hidden。 |
| viewer-layout.test.js | exit overlay 独立于 status/Dock，normal fullscreenStatus 保留，fullscreen CSS 隐藏 chrome、画面不再减 --chrome-top、44px/safe-area/pointer-event/inert 选择器存在。 |
| mobile_input_interaction_acceptance.py | 离线 Chromium 在宽屏与 375×812 native fullscreen 中，status/Dock 不可见不可点；未打开文本输入时 Viewer/媒体完整吃满可视区，打开时仅保留文本 dock reserve；handle 与展开 exit button 均 44px、在视口内、hit target 正确；Terminal、idle、lease loss 与两次 re-entry 均可退出。 |
| 构建与回归 | Viewer Node/CSS 全套、Signal build/test、离线验收 CLI 与其 Node wrapper 通过。 |

真实 iPhone/iPad/Android、系统软键盘、WebKit、Quartz、正式公网路径和 live watcher 没有实际设备/运行证据时仍标记 NOT RUN；离线 Playwright 不能替代这些结论。

## 7. 文档同步

实施时在 2026-09-06-mobile-input-interaction-remediation-design.md §8 增加一个简短 supersession note，指向本文。历史整改计划不回写为未完成；其已完成证据保持不变。本文和对应实施计划是后续 fullscreen chrome 的当前契约。

## 8. 当前实施与验证记录

- Task 1：fullscreen 有效几何与 idle 隔离已实施，提交 `a61a787`、`1c23db0`。
- Task 2：独立退出 overlay 与沉浸 CSS 已实施，提交 `1b454c8`；跨任务验收发现的无文本 Dock viewport 修复提交为 `8682589`。
- Task 3：fullscreenchange、inert、edge reveal 与失败反馈已实施，提交 `1305d2f`、`060241e`。
- Task 4：离线验收已改为分别测量 reveal handle / expanded exit、隐藏 chrome、visible-top、text reserve 与显式 handle→exit 路径；Task 2 viewport 修复后 1440×900 与 375×812 的 `viewerFillsVisibleViewportWithoutTextDock` 均为 `true`，native containment 与全部 12 个 offline Chromium 场景通过。保留完整安全 artifact bool，不以放宽断言换取 PASS。

Task 4 使用的命令为：

```bash
python3 scripts/mobile_input_interaction_acceptance.py --browser chromium --out /tmp/wrd-immersive-fullscreen-integration.json
python3 scripts/mobile_input_interaction_acceptance.py --browser chromium --out /tmp/wrd-immersive-fullscreen-chromium.json
node --test scripts/mobile-input-interaction-acceptance.test.js
node --test web-client/js/chrome-layout.test.js web-client/js/ui.test.js web-client/css/viewer-layout.test.js
node --test web-client/js/*.test.js web-client/css/*.test.js
(cd signal-server && npm run build:web && npm test)
git diff --check
```

Signal build/test 前仅使用 `npm ci --offline` 补齐该 worktree 缺失的本地缓存依赖；未发生外部请求。

Task 4 的提交 subject 为 `test(viewer): cover immersive fullscreen chrome`；最终 SHA 与每条命令的实际计数记录在被 `.superpowers/sdd` 忽略的 `task-4-report.md` 中。该报告只保留离线安全摘要，不记录 payload、文本、坐标、密码、token 或 URL。
