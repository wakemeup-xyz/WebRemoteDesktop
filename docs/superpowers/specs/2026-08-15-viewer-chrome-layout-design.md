# Viewer Chrome 与布局修复设计

**日期**：2026-08-15  
**状态**：已实施；窄屏几何真机 NOT RUN
**关联审查**：2026-08-15 前端 UI/布局系统性排查（会话审查，未单独落盘 report）  
**明确排除**：中英混杂 / 语气统一（用户指定不修）

---

## 1. 背景与问题陈述

CodeHarness 学习助手的 Viewer 是远程桌面控制台，主内容是远程画面。当前 chrome（顶栏、底部双 Dock、右下网络建议卡）在宽屏尚可凑合，窄屏会坏：

| 视口 | 实测 |
|------|------|
| 1440×900 | 顶栏 56px，画面起点 56px；动作栏已折成 2 行（76px） |
| 768×1024 | 控制栏只露出「断开连接」，其余按钮被动作栏挡住 |
| 375×812 | 顶栏 **223px**，画面起点仍是 **56px**；两 Dock 各约 208px 且重叠；顾问卡高度量到 435px |

根因不是「按钮丑」，是几何契约缺失：

1. `body` 写死 `padding-top: 56px`，顶栏却 `min-height: 56px; flex-wrap: wrap`
2. `.action-bar { bottom: 84px }` 假定控制栏永远一行
3. 已连接后 Dock 靠 `opacity: 0.22` + `body:hover` 显隐，触屏无效
4. `.control-btn { display: flex }` 压过 `[hidden]`，「请求控制」在已控制后仍可见
5. Terminal 面板 `grid-row: 5` 把状态条挤到工作区下方

登录页和 Viewer 不是同一套 token；登录错误回 `Invalid password`；占位符对比约 2.61:1。

---

## 2. 目标与非目标

### 目标

远程画面是第一公民。控件让位、窄屏不重叠、触控可点、焦点可见、连接/控制/全屏状态诚实。

用户体感：

- 手机上能看见完整桌面，顶栏不再盖住画面
- 底部只有一列工具，互不重叠
- 已连接后工具条会自己退下，需要时从底部唤出，不靠悬停猜
- 没点「开始」时不转圈
- 已控制时不再看到「请求控制」
- 全屏里有「退出全屏」
- Terminal 未授权时只看到授权，不铺一整台空操作台

### 非目标

- 不统一中英文案、不改产品名、不改「开始学习助手」措辞（用户排除 + 启动契约保留）
- 不引入图标库、SPA、新字体文件、新依赖
- 不改 WebRTC / 输入协议 / 控制权状态机 / 网络模式策略 / Terminal PTY 语义
- 不自动连接媒体
- 不重做 Host 本机 overlay
- 不做登录页视觉品牌重设计，只把 token 和表单反馈对齐 Viewer
- 不把诊断/网络弹层重做成全新设置页

### 成功标准

| 场景 | 必须 |
|------|------|
| 375×812 桌面页 | 顶栏实际高度 = `--chrome-top` = 画面/Terminal 起点；画面不被顶栏遮挡 |
| 375 / 768 底部 | `.chrome-docks` 内两栏垂直排列且 bounding box 不重叠 |
| 1440 已连接空闲 3s | Dock 不挡住画面主体；从视口底部 80px 可唤出 |
| 触屏 / 无 hover | 不依赖 `:hover` 才能看到或点到主控件 |
| 未点开始 | 无 spinner；有主 CTA |
| `hasActiveControl() === true` | `#requestControlBtn` 不可见且不可点 |
| 全屏 | `.viewer-container` 内有退出按钮 |
| Terminal 未授权 | 只显示授权表单 + 一句状态；传输/工作区/composer 隐藏 |
| 登录错误密码 | 中文错误出现在字段下方；提交期间按钮 disabled |
| 键盘 | 可见 `:focus-visible`；`prefers-reduced-motion: reduce` 关掉装饰动画 |
| 回归 | 缩放 / 分辨率 / 网络模式 / 暂停 / 断开 / 刷新 / 端口搜索 / 文本输入 / 诊断 行为不变 |

---

## 3. 方案选择

| 方案 | 做法 | 取舍 |
|------|------|------|
| A. 只改 CSS 数字 | 加大 `padding-top`、改 `bottom` | 修不了折行后的动态高度 |
| B. Chrome 几何契约 + 密度收敛 | 顶栏高度回写、Dock 合成一列、窄屏溢出、idle 退避、状态诚实 | 动 HTML/CSS/少量 JS，不碰媒体栈 |
| C. 整页重设计 | 新视觉、图标系统、设置抽屉 | 超出本次审查，风险大 |

**采用 B。**

---

## 4. 设计

改动集中在 `web-client/`。新增一个小模块 `web-client/js/chrome-layout.js`，专管顶栏高度、Dock 空闲退避、更多菜单。不把这些逻辑塞进 `webrtc.js`。

### 4.1 设计 token

从 `viewer.css` 抽出 `:root` 到 `web-client/css/tokens.css`。登录页直接链这份文件。Viewer **构建产物只能有 1 条 stylesheet**（`build-web-client.js` 硬约束），因此 hashed `viewer.css` = `tokens.css` + `viewer.css` 拼接。源码 `viewer.html` 的 `WRD_BUILD_HEAD` 里可以同时链两条，构建时整个 block 被替换成一条。

新增：

```css
:root {
  --text-secondary: #cbd5e1;
  --chrome-top: 56px;
  --focus-ring: 0 0 0 3px rgba(59, 130, 246, 0.45);
  --touch-min: 44px;
}
```

- `--text-secondary` 填上现有空引用（控制权、传输行、TURN 结果、诊断格子）
- 等宽栈改为 `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`，删掉未加载的 `JetBrains Mono`
- 高度用 `100dvh`，并加 `env(safe-area-inset-*)`
- `prefers-reduced-motion: reduce` 下动画/过渡 ≤ 0.01ms
- 交互元素补 `:focus-visible { box-shadow: var(--focus-ring); outline: none; }`
- 全局：`[hidden], .hidden { display: none !important; }`，避免 `.control-btn { display: flex }` 把 `[hidden]` 打穿

登录页改为引用 `tokens.css` + `login.css`。登录背景改走 Viewer 的 `--bg-gradient-*`，输入/按钮用同一套 accent。不做新插画、不加品牌标。

### 4.2 顶栏高度契约

`#statusBar` 继续 `position: fixed; top: 0; flex-wrap: wrap`。

`chrome-layout.js` 用 `ResizeObserver` 把 `statusBar.offsetHeight` 写到 `--chrome-top`。

```
body { padding-top: var(--chrome-top); }
.viewer-container { height: calc(100dvh - var(--chrome-top)); }
.terminal-panel { inset: var(--chrome-top) 0 0; }
```

首帧 CSS 仍用 `--chrome-top: 56px`，避免 FOUC。

### 4.3 底部 Dock：一列，不再各算各的

`viewer.html` 用一个包装层：

```html
<div id="chromeDocks" class="chrome-docks">
  <div class="action-bar">…</div>
  <div class="control-bar">…</div>
</div>
```

`.chrome-docks`：`position: fixed; left: 50%; bottom: calc(24px + env(safe-area-inset-bottom)); transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 8px; z-index: 100; max-width: calc(100vw - 32px)`。

`.action-bar` / `.control-bar` 取消自己的 `position: fixed` / `bottom` / `left` / `transform`，改为静态块。折行只在列内部长高，把整列往上推，两栏不会互相穿过。

`body.controls-hidden .chrome-docks { display: none; }` 替代分别隐藏两栏。

### 4.4 快捷键密度

宽屏（`min-width: 900px`）保留现有全部快捷按钮，允许动作栏折行。

`< 900px`：动作栏只留「回车」「键盘模式」和「更多」。其余 `.action-btn` 放进 `#moreActionsMenu`（绝对定位在「更多」上方的菜单，点外部或 Esc 关闭）。控制栏整行保留（缩放 / 分辨率 / 全屏 / 网络 / 搜索端口 / 暂停 / 断开）——单列包装后折行只会把整列顶高，不必再拆运维按钮。

所有 `.control-btn` / `.action-btn` / `.view-tab-btn` / `.modal-btn`：`min-height: var(--touch-min)`；图标或单字按钮 `min-width: var(--touch-min)`。

不引入 SVG 图标库。

### 4.5 空闲退避（取代 hover + 0.22）

删除：

```css
body.stream-connected:not(.controls-hidden) .control-bar,
body.stream-connected:not(.controls-hidden) .action-bar { opacity: 0.22; }
body:hover .control-bar …
```

新状态 `body.chrome-idle`，仅在 `body.stream-connected` 且未 `controls-hidden` 时由 `chrome-layout.js` 加上：

- 指针进入 `.chrome-docks`、打开更多菜单、或指针进入视口底部 80px：去掉 `chrome-idle`
- 之后 2500ms 无上述活动：加上 `chrome-idle`
- `chrome-idle` 下 `.chrome-docks` 使用 `transform: translate(-50%, calc(100% + 20px))`（包装层已有 translateX，JS/CSS 用自定义属性 `--docks-shift` 避免打架）
- 触屏：点画面不唤出 Dock（避免和远程点击冲突）；从底部 80px 上滑/点按，或点顶栏「显示控件」
- 明确「隐藏控件」仍是 `controls-hidden`，优先级高于 idle

空闲时网络顾问强制视觉折叠（沿用现有 `.collapsed`），不新造第三种形态。

`prefers-reduced-motion: reduce` 时 idle 切到瞬间 `visibility`，不位移。

### 4.6 网络顾问窄屏

- `max-width: 768px`：默认 `.collapsed`；仅 `warning` / `danger` 才自动展开
- 展开态 `max-height: min(240px, 40vh)`，正文 `overflow-y: auto`
- `align-items: flex-start`，折叠条不得被 stretch 成半个屏幕
- 折叠条 `max-height: 120px`
- Terminal 页顾问仍可出现，但不得盖住授权输入或 composer；Terminal 激活时把 `bottom` 收到 `chrome-docks` 之上或保持折叠

不改顾问文案生成逻辑。

### 4.7 连接占位

`#loading.stream-placeholder`：

- 默认：无 spinner，文案 + `#startBtn`
- `startViewer()` / 真正进入连接：加 `.is-connecting`，显示 spinner，隐藏开始按钮
- 首帧或失败：去掉 `.is-connecting`；失败时按钮回来

禁止用 spinner 表示「基础控制已就绪」。

### 4.8 请求控制按钮

`webrtc.js` 已有 `button.hidden = this.hasActiveControl() || transitioning || resetBlocked`。本次只修 CSS 让 `[hidden]` 生效，不改控制权状态机。

补一条静态/单元断言：带 `hidden` 的 `.control-btn` computed display 为 `none`。CSS 测试测选择器；如需运行时，用 jsdom 或文档约定即可。最低限度：`viewer-layout.test.js` 断言存在 `[hidden], .hidden { display: none !important }`。

### 4.9 全屏退出

`#exitFullscreenBtn` 放在 `.viewer-container` 内（全屏元素里面）：

```css
.fullscreen-exit-btn { display: none; }
.viewer-container:fullscreen .fullscreen-exit-btn { display: inline-flex; /* 左上，44px */ }
```

点击调用 `document.exitFullscreen()`。Esc 仍走浏览器原生。控制栏「全屏 / 退出全屏」文案逻辑保留，供非全屏使用。

### 4.10 登录表单

`index.html`：

- `autocomplete="current-password"`
- `#error`：`role="alert"` `aria-live="polite"`
- 提交中按钮 `disabled`，文案「连接中…」
- 客户端映射：`Invalid password` → `密码错误`；`Password required` → `请输入访问密码`；其余未知错误保持原文（服务端 API 字符串不改，避免牵动 Host 登录）
- 输入 `aria-invalid` 随错误有无切换
- 占位符颜色提到至少 4.5:1（相对输入底，用 `rgba(255,255,255,0.62)` 或 token）
- 焦点用 `--focus-ring`，禁止裸 `outline: none`

### 4.11 Tab 与对话框

桌面 / Terminal 按钮：`role="tab"`、`aria-selected`、`aria-controls` 指向 `#desktopPanel` / `#terminalPanel`。`terminal.js` 的 `showDesktop` / `showTerminal` 同步这些属性。

`#resolutionModal` `#networkModal` `#diagModal` 补 `role="dialog"` `aria-modal="true"`。已有的文本输入、顶替层不改语义。打开时把焦点移到标题或关闭钮；Esc 关闭（与现有关闭按钮同一条路径）。

诊断弹层去掉 `min-width: 600px`，改 `width: min(720px, calc(100vw - 24px))`。

### 4.12 Terminal 布局与未授权披露

重做 `.terminal-panel` 为命名网格，不再 `grid-row: 5`：

```
auth
toolbar
note
transport
status
warning
retry
workspace   /* 1fr */
composer
```

`#terminalStatus` 必须在 `#terminalWorkspace` **之上**。

`render()` 在 `!authorized` 时额外隐藏：

- `.terminal-toolbar`（无会话可列）
- `.terminal-transport-row`
- `#terminalWorkspace`
- `.terminal-composer`

保留：授权表单、一句状态（需要 admin 二次授权）、可选的一行 pool note。

更新 `viewer-layout.test.js`：删掉「workspace = row 5」这条过时断言，改为断言命名区域或 DOM 顺序 + 未授权隐藏类。

### 4.13 Inline style 收敛

把 `viewer.html` 里诊断面板、TURN 下拉、自适应分辨率说明的大段 style 收进 `viewer.css` 类。不追求清零每一个 `style=`，只清会影响布局/主题的那几块。

---

## 5. 文件边界

| 文件 | 职责 |
|------|------|
| `web-client/css/tokens.css` | 新建。颜色、半径、阴影、`--chrome-top`、焦点、触控最小值 |
| `web-client/css/viewer.css` | 几何、Dock 列、idle、顾问、全屏退出、Terminal 网格、`[hidden]`、reduced-motion |
| `web-client/css/login.css` | 只留登录卡片排版，颜色引用 token |
| `web-client/css/viewer-layout.test.js` | 静态契约测试 |
| `web-client/index.html` | 引入 tokens、表单 a11y、错误映射 |
| `web-client/viewer.html` | Dock 包装、更多菜单、退出全屏、tab/dialog 属性、去 inline |
| `web-client/js/chrome-layout.js` | 新建。顶栏高度、idle、更多菜单 |
| `web-client/js/chrome-layout.test.js` | 新建。高度写入、idle 计时、菜单开关 |
| `web-client/js/ui.js` | 全屏退出钮绑定；idle 与 `controls-hidden` 协调 |
| `web-client/js/terminal.js` | tab ARIA；未授权隐藏 |
| `web-client/js/webrtc.js` | 仅：占位 `.is-connecting`；窄屏顾问不因 info 展开。**不改** requestControl 状态机 |
| `docs/需求文档/WebRemoteDesktop-需求文档.md` | 3.4 控制栏：隐藏控件 / 全屏退出 / 空闲退避 |
| `signal-server/scripts/web-asset-graph.js` | `desktopScripts` 在 `ui.js` 前加入 `chrome-layout.js` |
| `signal-server/scripts/build-web-client.js` | 拼接 `tokens.css`+`viewer.css`；把 `tokens.css` 拷到 `dist/css/` 给登录页 |

---

## 6. 测试策略

1. **静态**：扩展 `viewer-layout.test.js`（token 引用、`--chrome-top`、`[hidden]`、Dock 包装、Terminal 顺序、dialog/tab 属性）。
2. **单元**：`chrome-layout.test.js` 用 jsdom 或直接导出纯函数测 `syncChromeTop(height)`、`shouldIdle({streamConnected, hidden, idleMs})`、菜单 toggle。现有 web-client 测试是 `node --test` + 多数不靠 jsdom；优先把可测逻辑写成纯函数，避免新依赖。
3. **构建**：`npm test`（`signal-server`，含 `build:web`）必须把新 CSS/JS 打进 `dist/`。
4. **手动**：1440 / 768 / 375 各看登录、未连接、已连接空闲、Terminal 未授权、分辨率/网络弹层、全屏。

---

## 7. 需求文档同步

`docs/需求文档/WebRemoteDesktop-需求文档.md` §3.4：

- 「显示/隐藏控件」改为：显式按钮 + 已连接空闲自动退避；退避不依赖 hover
- 「全屏控制」补：全屏元素内提供退出按钮，Esc 仍可用
- 增补：顶栏高度与内容区起点绑定；底部工具条单列堆叠

不改键盘/视频/认证协议章节。不把「中英统一」写进需求。

---

## 8. 风险

| 风险 | 缓解 |
|------|------|
| 改 Dock `position` 影响坐标映射 | 输入坐标只看 `#remoteVideo` / `#relayImage`，不看 Dock；回归点一次桌面点击 |
| idle 退避误伤正在调分辨率的人 | 弹层打开期间不进入 idle（`document.querySelector('.modal:not(.hidden)')`） |
| `100dvh` 旧浏览器 | 回退 `100vh`：`height: calc(100vh - var(--chrome-top)); height: calc(100dvh - var(--chrome-top));` |
| 构建漏打包新文件 | 先改 build 清单测试再改运行时 |
| 触控 44px 让 Dock 更高 | 列包装会一起上移，这正是 4.3 要解决的 |

---

## 9. 实施顺序

1. token + `[hidden]` + focus + reduced-motion + dvh（无行为变化的地基）
2. `--chrome-top` 回写 + Dock 列包装（P0 几何）
3. 更多菜单 + 44px + idle + 顾问窄屏（密度）
4. 占位 / 全屏退出 / 登录表单
5. Terminal 网格与未授权披露
6. Tab/dialog + inline 清理 + 需求文档
