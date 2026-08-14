# Viewer Chrome 与布局修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Viewer 在 375/768/1440 下都不遮挡远程画面：顶栏高度回写、底部 Dock 单列、空闲退避、状态诚实、登录/Terminal 表单可用。

**Architecture:** 纯前端。几何与 idle 抽到 `chrome-layout.js`（可单测的纯函数 + 薄 DOM 绑定）。token 放进 `tokens.css`，构建时拼进唯一的 hashed `viewer.css`；登录页单独引用 `tokens.css`。不改 WebRTC/输入/控制权状态机。

**Tech Stack:** Vanilla JS、CSS、`node --test`、现有 `signal-server` `build:web`

**Spec:** `docs/superpowers/specs/2026-08-15-viewer-chrome-layout-design.md`

## Global Constraints

- 不引入新的 npm 依赖、图标库、字体文件、SPA
- 不统一中英文案，不改「开始学习助手」按钮文案
- 不改 WebRTC / 输入协议 / 控制权状态机 / 网络模式策略 / Terminal PTY
- 不自动连接媒体
- 正式 Viewer 构建产物必须仍是 **恰好 1 个** stylesheet、**恰好 1 个** script src（`build-web-client.js` 硬约束）
- `tokens.css` 必须在构建时拼进 hashed viewer CSS，不能给 `viewer.html` 再加一条 `<link>`
- 每个 task 先写失败测试再改实现
- 提交信息用 conventional commits，正文用英文（与仓库近期 commit 一致）

---

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `web-client/css/tokens.css` | 色板、`--chrome-top`、焦点、触控最小值 |
| 新建 | `web-client/js/chrome-layout.js` | 顶栏高度、idle、更多菜单 |
| 新建 | `web-client/js/chrome-layout.test.js` | 上述纯函数测试 |
| 修改 | `web-client/css/viewer.css` | 引用契约、Dock 列、idle、顾问、Terminal 网格、`[hidden]` |
| 修改 | `web-client/css/login.css` | 使用 token；焦点与占位符对比 |
| 修改 | `web-client/css/viewer-layout.test.js` | 静态 HTML/CSS 契约 |
| 修改 | `web-client/index.html` | tokens 链接、表单 a11y、错误映射 |
| 修改 | `web-client/viewer.html` | Dock 包装、更多菜单、退出全屏、tab/dialog |
| 修改 | `web-client/js/ui.js` | 绑定退出全屏；与 `controls-hidden` 协调 |
| 修改 | `web-client/js/terminal.js` | tab ARIA；未授权隐藏 |
| 修改 | `web-client/js/webrtc.js` | `.is-connecting`；窄屏 info 不展开顾问 |
| 修改 | `signal-server/scripts/web-asset-graph.js` | `desktopScripts` 加入 `chrome-layout.js` |
| 修改 | `signal-server/scripts/build-web-client.js` | 拼接 `tokens.css` + `viewer.css`；拷贝 `tokens.css` 给登录页 |
| 修改 | `signal-server/test/web-asset-build.test.js` | 图中含 `chrome-layout.js`；产物 CSS 含 `--chrome-top` |
| 修改 | `docs/需求文档/WebRemoteDesktop-需求文档.md` | §3.4 控制栏 |

---

### Task 1: Token 文件、构建拼接、`[hidden]` 与 a11y 地基

**Files:**
- Create: `web-client/css/tokens.css`
- Modify: `web-client/css/viewer.css`
- Modify: `web-client/css/viewer-layout.test.js`
- Modify: `signal-server/scripts/build-web-client.js`
- Modify: `signal-server/test/web-asset-build.test.js`

**Interfaces:**
- Consumes: 现有 `viewer.css` `:root` 变量名
- Produces: `tokens.css` 导出 `--text-secondary: #cbd5e1`、`--chrome-top: 56px`、`--focus-ring`、`--touch-min: 44px`；构建后的唯一 viewer CSS 文本以 token 块开头

- [ ] **Step 1: 写失败的静态测试**

在 `viewer-layout.test.js` 增加：

```javascript
test('tokens define chrome geometry and secondary text', () => {
  const tokens = fs.readFileSync(path.join(__dirname, 'tokens.css'), 'utf8');
  assert.match(tokens, /--chrome-top\s*:\s*56px/);
  assert.match(tokens, /--text-secondary\s*:\s*#cbd5e1/i);
  assert.match(tokens, /--touch-min\s*:\s*44px/);
  assert.match(tokens, /--focus-ring/);
});

test('hidden attribute cannot be overridden by flex buttons', () => {
  assert.match(css, /\[hidden\]\s*,\s*\.hidden\s*\{[^}]*display\s*:\s*none\s*!important/);
});

test('viewer css no longer redefines the :root token block', () => {
  assert.doesNotMatch(css, /:root\s*\{[^}]*--bg-primary/);
});
```

在 `signal-server/test/web-asset-build.test.js` 的构建测试末尾追加：

```javascript
  const viewerCss = fs.readFileSync(path.join(outA, a.assets.viewerCss), 'utf8');
  assert.match(viewerCss, /--chrome-top/);
  assert.match(viewerCss, /--text-secondary/);
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
node --test web-client/css/viewer-layout.test.js
```

Expected: FAIL，缺 `tokens.css` 或选择器。

- [ ] **Step 3: 实现 tokens 与拼接**

`tokens.css` 放入当前 `viewer.css` 的整个 `:root` 块，并补：

```css
:root {
  /* 既有变量原样搬迁 */
  --text-secondary: #cbd5e1;
  --chrome-top: 56px;
  --focus-ring: 0 0 0 3px rgba(59, 130, 246, 0.45);
  --touch-min: 44px;
}
```

`viewer.css` 删除 `:root` 块。在文件顶部加注释：`/* tokens.css is prepended at build time; keep this file token-free at :root */`。

在 `viewer.css` 末尾加：

```css
[hidden],
.hidden {
  display: none !important;
}
```

注意：已有 `.hidden { display: none !important; }`，改成与 `[hidden]` 合并，避免重复。

`build-web-client.js` 把：

```javascript
const viewerCss = fs.readFileSync(path.join(sourceDir, 'css/viewer.css'), 'utf8');
```

改成：

```javascript
const tokenCss = fs.readFileSync(path.join(sourceDir, 'css/tokens.css'), 'utf8');
const viewerCss = `${tokenCss}\n${fs.readFileSync(path.join(sourceDir, 'css/viewer.css'), 'utf8')}`;
```

并在拷贝 login.css 旁增加：

```javascript
fs.copyFileSync(path.join(sourceDir, 'css/tokens.css'), path.join(staging, 'css/tokens.css'));
```

源码 `viewer.html` 开发时仍只链 `css/viewer.css`。为让本地无构建预览也有 token，在 `viewer.css` **不要** `@import`（构建后会变成两份或相对路径失效）。本地直接打开 `viewer.html` 会缺 token——可接受，因为日常走 `8080` 的构建产物。若开发脚本有时直接 serve `web-client/`，则在 `viewer.html` 开发 head 里同时链 `tokens.css` + `viewer.css`；**构建替换 HEAD 后仍只剩 1 条 stylesheet**。推荐后者：

```html
<!-- WRD_BUILD_HEAD_START -->
<link rel="stylesheet" href="css/tokens.css">
<link rel="stylesheet" href="css/viewer.css">
```

构建替换整个 block，测试「恰好 1 个 stylesheet」仍然成立。

补 focus 与 reduced-motion（可放 `viewer.css` 末尾）：

```css
:focus-visible {
  box-shadow: var(--focus-ring);
  outline: none;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

等宽字体栈全局替换 `'JetBrains Mono'` → `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`。

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test web-client/css/viewer-layout.test.js
cd signal-server && npm test -- --test-name-pattern "build emits deterministic"
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web-client/css/tokens.css web-client/css/viewer.css web-client/css/viewer-layout.test.js \
  web-client/viewer.html signal-server/scripts/build-web-client.js signal-server/test/web-asset-build.test.js
git commit -m "$(cat <<'EOF'
fix(ui): extract design tokens and honor hidden attribute

Prepend tokens.css into the single hashed viewer stylesheet so
--text-secondary and --chrome-top exist, and keep [hidden] from
being overridden by display:flex buttons.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 顶栏高度回写

**Files:**
- Create: `web-client/js/chrome-layout.js`
- Create: `web-client/js/chrome-layout.test.js`
- Modify: `signal-server/scripts/web-asset-graph.js`
- Modify: `web-client/css/viewer.css`
- Modify: `web-client/viewer.html`（开发脚本顺序；构建走 graph）
- Modify: `web-client/css/viewer-layout.test.js`

**Interfaces:**
- Consumes: `#statusBar` 的 `offsetHeight`
- Produces: `ChromeLayout.init()`（后续 task 往里加 idle/菜单）；`ChromeLayout.syncChromeTop(px, rootEl)` 把 `--chrome-top` 写成 `${px}px`；`ChromeLayout.observeStatusBar(statusEl, rootEl)`

- [ ] **Step 1: 写失败的单元测试**

`chrome-layout.test.js`：

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const { ChromeLayout } = require('./chrome-layout.js');

test('syncChromeTop writes pixel height to --chrome-top', () => {
  const root = { style: { setProperty(name, value) { this[name] = value; } } };
  ChromeLayout.syncChromeTop(223, root);
  assert.equal(root.style['--chrome-top'], '223px');
});

test('syncChromeTop ignores non-positive heights', () => {
  const root = { style: { setProperty(name, value) { this[name] = value; } } };
  ChromeLayout.syncChromeTop(0, root);
  assert.equal(root.style['--chrome-top'], undefined);
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --test web-client/js/chrome-layout.test.js
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现模块与 CSS 契约**

`chrome-layout.js` 最小实现：

```javascript
const ChromeLayout = {
  syncChromeTop(px, rootEl) {
    const height = Number(px);
    if (!Number.isFinite(height) || height <= 0) return;
    const root = rootEl || (typeof document !== 'undefined' ? document.documentElement : null);
    root?.style?.setProperty('--chrome-top', `${Math.round(height)}px`);
  },
  observeStatusBar(statusEl, rootEl) {
    if (!statusEl || typeof ResizeObserver === 'undefined') return () => {};
    const apply = () => this.syncChromeTop(statusEl.offsetHeight, rootEl);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(statusEl);
    return () => ro.disconnect();
  },
};

if (typeof globalThis !== 'undefined') globalThis.ChromeLayout = ChromeLayout;
if (typeof module !== 'undefined' && module.exports) module.exports = { ChromeLayout };
```

`viewer.css`：

```css
body {
  padding-top: var(--chrome-top);
  min-height: 100vh;
  min-height: 100dvh;
}
.viewer-container {
  height: calc(100vh - var(--chrome-top));
  height: calc(100dvh - var(--chrome-top));
}
.terminal-panel {
  inset: var(--chrome-top) 0 0;
}
```

删掉写死的 `padding-top: 56px` 和 `height: calc(100vh - 56px)`。

`web-asset-graph.js` 的 `desktopScripts` 在 `js/ui.js` **之前**插入 `'js/chrome-layout.js'`。

`viewer.html` 的 `WRD_BUILD_SCRIPTS` 列表同样在 `ui.js` 前加 `<script src="js/chrome-layout.js"></script>`。

`chrome-layout.js` 增加 `init()`：内部调用 `observeStatusBar`。`ui.js` 的 `init()` 开头：`if (typeof ChromeLayout !== 'undefined') ChromeLayout.init();`。后续 task 只往 `ChromeLayout.init` 里加逻辑，不再让 `ui.js` 认识 idle/菜单细节。

静态测试：

```javascript
test('viewer layout uses --chrome-top instead of a hardcoded 56px body pad', () => {
  assert.match(css, /padding-top\s*:\s*var\(--chrome-top\)/);
  assert.doesNotMatch(css, /body\s*\{[^}]*padding-top\s*:\s*56px/);
});
```

- [ ] **Step 4: 跑测试**

```bash
node --test web-client/js/chrome-layout.test.js web-client/css/viewer-layout.test.js
cd signal-server && node --test test/web-asset-build.test.js
```

Expected: PASS。构建测试需断言 `graph.desktopScripts.includes('js/chrome-layout.js')`。

- [ ] **Step 5: Commit**

```bash
git add web-client/js/chrome-layout.js web-client/js/chrome-layout.test.js \
  web-client/js/ui.js web-client/css/viewer.css web-client/css/viewer-layout.test.js \
  web-client/viewer.html signal-server/scripts/web-asset-graph.js signal-server/test/web-asset-build.test.js
git commit -m "$(cat <<'EOF'
fix(ui): bind viewer content offset to live status bar height

A wrapping status bar is 223px on a 375px viewport while the
desktop still started at 56px. Write --chrome-top from ResizeObserver.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Dock 单列包装，消除重叠

**Files:**
- Modify: `web-client/viewer.html`
- Modify: `web-client/css/viewer.css`
- Modify: `web-client/css/viewer-layout.test.js`

**Interfaces:**
- Consumes: 现有 `.action-bar` / `.control-bar` 子节点，顺序不变
- Produces: `#chromeDocks.chrome-docks` 为唯一 `position: fixed` 底部容器

- [ ] **Step 1: 写失败的静态测试**

```javascript
test('docks share one fixed column wrapper', () => {
  assert.match(html, /id="chromeDocks"[\s\S]*class="action-bar"[\s\S]*class="control-bar"/);
  const docks = getBlock('.chrome-docks');
  assert.match(docks, /position\s*:\s*fixed/);
  assert.match(docks, /flex-direction\s*:\s*column/);
  const action = getBlock('.action-bar');
  assert.doesNotMatch(action, /position\s*:\s*fixed/);
  const control = getBlock('.control-bar');
  assert.doesNotMatch(control, /position\s*:\s*fixed/);
});
```

`getBlock` 对多层括号可能不够用。若失败，改成对整份 CSS 做更宽松的 `assert.match(css, /\.action-bar\s*\{[^}]*display\s*:\s*flex/)` 并 `assert.doesNotMatch(css, /\.action-bar\s*\{[^}]*position\s*:\s*fixed/)`。

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --test web-client/css/viewer-layout.test.js
```

Expected: FAIL，无 `#chromeDocks`。

- [ ] **Step 3: 改 HTML/CSS**

把 `.action-bar` 与 `.control-bar` 包进：

```html
<div id="chromeDocks" class="chrome-docks" aria-label="桌面控件">
  <!-- 原 action-bar 整块 -->
  <!-- 原 control-bar 整块 -->
</div>
```

CSS：

```css
.chrome-docks {
  position: fixed;
  left: 50%;
  bottom: calc(24px + env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  z-index: 100;
  max-width: calc(100vw - 32px);
  pointer-events: none;
}
.chrome-docks .action-bar,
.chrome-docks .control-bar {
  position: static;
  left: auto;
  bottom: auto;
  transform: none;
  pointer-events: auto;
  max-width: 100%;
}
body.controls-hidden .chrome-docks {
  display: none !important;
}
```

删除 `body.controls-hidden .control-bar, body.controls-hidden .action-bar`。保留两栏自己的背景/圆角/折行。

- [ ] **Step 4: 跑测试**

```bash
node --test web-client/css/viewer-layout.test.js
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web-client/viewer.html web-client/css/viewer.css web-client/css/viewer-layout.test.js
git commit -m "$(cat <<'EOF'
fix(ui): stack viewer docks in one column so they cannot overlap

Action and control bars used independent bottom offsets and both
wrapped. A shared flex column grows upward as one unit.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 窄屏「更多」菜单与 44px 触控

**Files:**
- Modify: `web-client/viewer.html`
- Modify: `web-client/css/viewer.css`
- Modify: `web-client/js/chrome-layout.js`
- Modify: `web-client/js/chrome-layout.test.js`
- Modify: `web-client/css/viewer-layout.test.js`

**Interfaces:**
- Consumes: `.action-bar .action-btn`（不含控制栏、不含 `#portSearchBtn`）
- Produces: `ChromeLayout.nextMoreMenuState(isOpen)`、`ChromeLayout.toggleMoreMenu(open)`；`#moreActionsBtn` / `#moreActionsMenu`

- [ ] **Step 1: 写失败测试**

```javascript
test('narrow overflow menu exists', () => {
  assert.match(html, /id="moreActionsBtn"/);
  assert.match(html, /id="moreActionsMenu"/);
  assert.match(css, /min-height\s*:\s*var\(--touch-min\)/);
});
```

```javascript
test('toggleMoreMenu sets hidden and aria-expanded', () => {
  const btn = { setAttribute() {}, getAttribute() { return this.expanded; } };
  const menu = { hidden: true };
  // 用纯函数：
  const next = ChromeLayout.nextMoreMenuState(false);
  assert.equal(next.open, true);
  assert.equal(ChromeLayout.nextMoreMenuState(true).open, false);
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --test web-client/js/chrome-layout.test.js web-client/css/viewer-layout.test.js
```

- [ ] **Step 3: 实现**

HTML：在 `.action-bar` 末尾加：

```html
<button id="moreActionsBtn" class="action-btn action-more" type="button" aria-expanded="false" aria-controls="moreActionsMenu">更多</button>
<div id="moreActionsMenu" class="more-actions-menu" hidden role="menu"></div>
```

**不要**复制按钮，**不要**动 `#portSearchBtn`（留在控制栏）。`chrome-layout.js` 在 `init()` 里给 `.action-bar .action-btn:not(.action-more):not([data-pin="always"])` 记 `data-home-index`。打开菜单时把这些节点 **move** 进 `#moreActionsMenu`（关时按 index 插回 `.action-bar`）。克隆会丢 listener。

`#moreActionsMenu .action-btn { display: flex; }` —— 节点离开 `.action-bar` 后，窄屏「隐藏非 pin」选择器不再匹配，菜单里必须显式恢复显示。

纯函数：

```javascript
nextMoreMenuState(isOpen) { return { open: !isOpen }; }
```

CSS：

```css
.control-btn, .action-btn, .view-tab-btn, .modal-btn, .start-btn {
  min-height: var(--touch-min);
}
.action-btn[data-action="up"],
.action-btn[data-action="down"],
.action-btn[data-action="left"],
.action-btn[data-action="right"] {
  min-width: var(--touch-min);
}
@media (max-width: 899px) {
  .action-bar .action-btn:not(.action-more):not([data-pin="always"]) { display: none; }
  body.more-open .action-bar .action-btn:not(.action-more):not([data-pin="always"]) { display: none; }
}
```

给「回车」「键盘模式」加 `data-pin="always"`。

菜单打开时：`body.more-open`，`#moreActionsMenu` 取消 hidden，并把非 pin 按钮 append 进去（`display` 恢复）。关闭时按原顺序插回 `.action-bar`（先记录 `data-home-index`）。

Esc / 点击 docks 外部关闭。

- [ ] **Step 4: 跑测试**

```bash
node --test web-client/js/chrome-layout.test.js web-client/css/viewer-layout.test.js
```

- [ ] **Step 5: Commit**

```bash
git add web-client/viewer.html web-client/css/viewer.css web-client/js/chrome-layout.js \
  web-client/js/chrome-layout.test.js web-client/css/viewer-layout.test.js
git commit -m "$(cat <<'EOF'
fix(ui): overflow secondary desktop actions on narrow viewports

Keep Enter and keyboard-mode pinned. Move the rest into a More
menu so 32px direction keys are not the only tap targets.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 用 idle 退避替换 hover + 0.22 透明度

**Files:**
- Modify: `web-client/js/chrome-layout.js`
- Modify: `web-client/js/chrome-layout.test.js`
- Modify: `web-client/css/viewer.css`
- Modify: `web-client/css/viewer-layout.test.js`

**Interfaces:**
- Consumes: `body.stream-connected`、`body.controls-hidden`、模态是否打开
- Produces: `ChromeLayout.shouldIdle({ streamConnected, controlsHidden, menuOpen, modalOpen, idleMs })`；`IDLE_MS = 2500`

- [ ] **Step 1: 写失败测试**

```javascript
test('shouldIdle only when streaming, chrome visible, idle long enough', () => {
  assert.equal(ChromeLayout.shouldIdle({
    streamConnected: true, controlsHidden: false, menuOpen: false, modalOpen: false, idleMs: 2500,
  }), true);
  assert.equal(ChromeLayout.shouldIdle({
    streamConnected: true, controlsHidden: false, menuOpen: false, modalOpen: false, idleMs: 2499,
  }), false);
  assert.equal(ChromeLayout.shouldIdle({
    streamConnected: false, controlsHidden: false, menuOpen: false, modalOpen: false, idleMs: 5000,
  }), false);
  assert.equal(ChromeLayout.shouldIdle({
    streamConnected: true, controlsHidden: false, menuOpen: true, modalOpen: false, idleMs: 5000,
  }), false);
  assert.equal(ChromeLayout.shouldIdle({
    streamConnected: true, controlsHidden: false, menuOpen: false, modalOpen: true, idleMs: 5000,
  }), false);
});
```

```javascript
test('connected docks no longer use hover-only 0.22 opacity', () => {
  assert.doesNotMatch(css, /body\.stream-connected[^{]*\{[^}]*opacity\s*:\s*0\.22/);
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --test web-client/js/chrome-layout.test.js web-client/css/viewer-layout.test.js
```

- [ ] **Step 3: 实现**

删除 `viewer.css` 里 `body.stream-connected … opacity: 0.22` 及对应 `body:hover` / `:hover` 拉回规则。

```css
.chrome-docks {
  --docks-shift: 0px;
  transform: translateX(-50%) translateY(var(--docks-shift));
  transition: transform 200ms var(--transition-base);
}
body.chrome-idle .chrome-docks {
  --docks-shift: calc(100% + 20px);
}
```

`chrome-layout.js`：

- `IDLE_MS = 2500`
- 指针进入 `#chromeDocks` 或 `clientY > innerHeight - 80`：`bump()`
- 触屏：`pointerdown` 仅当 `clientY > innerHeight - 80` 时 `bump()`（点画面不 bump）
- `bump()` 去掉 `chrome-idle`，重置计时器
- 计时器到点且 `shouldIdle(...)` 为真则加 `chrome-idle`
- 打开更多菜单或 `.modal:not(.hidden)` 存在时不 idle
- 同时给可见的 `#networkAdvisor` 加 `.collapsed`（idle 时），bump 不自动展开（用户点把手才展开）

- [ ] **Step 4: 跑测试**

```bash
node --test web-client/js/chrome-layout.test.js web-client/css/viewer-layout.test.js
```

- [ ] **Step 5: Commit**

```bash
git add web-client/js/chrome-layout.js web-client/js/chrome-layout.test.js \
  web-client/css/viewer.css web-client/css/viewer-layout.test.js
git commit -m "$(cat <<'EOF'
fix(ui): idle-hide desktop docks instead of hover opacity

0.22 opacity plus body:hover hid controls on touch and still
covered the remote desktop. Slide the dock column away after 2.5s.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 网络顾问窄屏收成边条

**Files:**
- Modify: `web-client/css/viewer.css`
- Modify: `web-client/js/webrtc.js`（只动 `updateNetworkUI` 是否 expand 的条件）
- Modify: `web-client/css/viewer-layout.test.js`

**Interfaces:**
- Consumes: 现有 `.network-advisor.collapsed` / `expandNetworkAdvisor`
- Produces: 窄屏 info 级别不再 `shouldExpand`

- [ ] **Step 1: 写失败测试**

```javascript
test('narrow advisor cannot stretch to half the viewport', () => {
  assert.match(css, /max-height\s*:\s*min\(\s*240px,\s*40vh\s*\)/);
  assert.match(css, /align-items\s*:\s*flex-start/);
});
```

`webrtc.js` 约 3751 行，现有：

```javascript
const shouldExpand = firstShow
  || severityUp
  || (meaningfulChange && (effectiveSeverity === 'warning' || effectiveSeverity === 'danger'
    || genericMessage || !message
    || /失败|不可用|切换|重连|建议|耗尽|超时|中断/.test(String(baseMessage || ''))));
```

改成在原表达式上加窄屏 info 门闩（`firstShow` 在手机上也不再撑开 info 卡）：

```javascript
const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 768px)').matches;
const shouldExpand = (firstShow
  || severityUp
  || (meaningfulChange && (effectiveSeverity === 'warning' || effectiveSeverity === 'danger'
    || genericMessage || !message
    || /失败|不可用|切换|重连|建议|耗尽|超时|中断/.test(String(baseMessage || '')))))
  && !(narrow && effectiveSeverity === 'info');
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --test web-client/css/viewer-layout.test.js
```

- [ ] **Step 3: 改 CSS + 一处 JS**

```css
.network-advisor {
  align-items: flex-start;
}
.network-advisor.visible:not(.collapsed) {
  max-height: min(240px, 40vh);
}
.network-advisor.visible:not(.collapsed) .network-advisor__body {
  overflow-y: auto;
}
.network-advisor.visible.collapsed {
  max-height: 120px;
}
body.terminal-active .network-advisor.visible:not(.collapsed) {
  bottom: 88px;
}
```

- [ ] **Step 4: 跑测试**

```bash
node --test web-client/css/viewer-layout.test.js
```

相关 `webrtc` 单测若覆盖 `updateNetworkUI`，一并跑：

```bash
node --test web-client/js/webrtc.test.js
```

- [ ] **Step 5: Commit**

```bash
git add web-client/css/viewer.css web-client/js/webrtc.js web-client/css/viewer-layout.test.js
git commit -m "$(cat <<'EOF'
fix(ui): cap network advisor height on narrow viewports

The edge tab was stretching to hundreds of pixels. Keep info-level
advice collapsed under 768px and cap the expanded card at 40vh.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 连接占位、请求控制可见性、全屏退出

**Files:**
- Modify: `web-client/viewer.html`
- Modify: `web-client/css/viewer.css`
- Modify: `web-client/js/webrtc.js`（`startViewer` / `endConnectingWithFailure` / 首帧隐藏 loading）
- Modify: `web-client/js/ui.js`
- Modify: `web-client/css/viewer-layout.test.js`

**Interfaces:**
- Consumes: 现有 `#loading`、`#startBtn`、`#requestControlBtn.hidden`、`viewerContainer.requestFullscreen`
- Produces: `.stream-placeholder.is-connecting`；`#exitFullscreenBtn`

- [ ] **Step 1: 写失败测试**

```javascript
test('placeholder spinner is opt-in via is-connecting', () => {
  assert.match(css, /\.stream-placeholder:not\(\.is-connecting\)\s+\.spinner/);
  assert.match(html, /id="exitFullscreenBtn"/);
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --test web-client/css/viewer-layout.test.js
```

- [ ] **Step 3: 实现**

CSS：

```css
.stream-placeholder:not(.is-connecting) .spinner {
  display: none;
}
.fullscreen-exit-btn {
  display: none;
  position: absolute;
  top: 16px;
  left: 16px;
  z-index: 30;
  min-height: var(--touch-min);
  min-width: var(--touch-min);
  padding: 0 12px;
}
.viewer-container:fullscreen .fullscreen-exit-btn {
  display: inline-flex;
  align-items: center;
}
```

`startViewer` 开头：`document.getElementById('loading')?.classList.add('is-connecting')`  
失败/断开：`classList.remove('is-connecting')`  
首帧隐藏 `#loading` 的现有路径一并 remove。

`viewer.html` 在 `.viewer-container` 内、video 之后插入：

```html
<button id="exitFullscreenBtn" class="fullscreen-exit-btn" type="button">退出全屏</button>
```

`ui.js` 绑定它到 `document.exitFullscreen()`。

请求控制：Task 1 已修 `[hidden]`。本 task 打开 viewer 用 DevTools 确认即可，不改 `webrtc.js` 的 `button.hidden = …`。

- [ ] **Step 4: 跑测试**

```bash
node --test web-client/css/viewer-layout.test.js web-client/js/webrtc.test.js
```

- [ ] **Step 5: Commit**

```bash
git add web-client/viewer.html web-client/css/viewer.css web-client/js/webrtc.js \
  web-client/js/ui.js web-client/css/viewer-layout.test.js
git commit -m "$(cat <<'EOF'
fix(ui): honest start spinner and in-fullscreen exit control

The idle placeholder spun before connect, and fullscreen removed
the only exit button with the outer docks.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: 登录页 token、焦点、提交反馈

**Files:**
- Modify: `web-client/index.html`
- Modify: `web-client/css/login.css`
- Modify: `web-client/css/viewer-layout.test.js`（或新建 `web-client/css/login.test.js`，更清晰）

**Interfaces:**
- Consumes: `/api/auth/login` 现有 `{ error: 'Invalid password' | 'Password required' }`
- Produces: 客户端映射表，**不改** `signal-server/routes/auth.js`

- [ ] **Step 1: 写失败测试**

新建 `web-client/css/login.test.js`：

```javascript
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'login.css'), 'utf8');

test('login form is labeled and announces errors', () => {
  assert.match(html, /autocomplete="current-password"/);
  assert.match(html, /id="error"[^>]*role="alert"/);
  assert.match(html, /css\/tokens\.css/);
  assert.match(html, /密码错误/);
});

test('login css uses shared tokens and a visible focus ring', () => {
  assert.match(css, /var\(--accent-primary\)|--focus-ring|--bg-gradient-start/);
  assert.doesNotMatch(css, /outline:\s*none;\s*\n\s*border-color:/);
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --test web-client/css/login.test.js
```

- [ ] **Step 3: 实现**

`index.html` `<head>`：

```html
<link rel="stylesheet" href="css/tokens.css">
<link rel="stylesheet" href="css/login.css">
```

密码框：`autocomplete="current-password"`。  
`#error`：`role="alert" aria-live="polite"`。

提交逻辑：

```javascript
const ERRORS = {
  'Invalid password': '密码错误',
  'Password required': '请输入访问密码',
};
button.disabled = true;
button.textContent = '连接中…';
try {
  // 现有 fetch
  if (!response.ok) {
    input.setAttribute('aria-invalid', 'true');
    errorDiv.textContent = ERRORS[data.error] || data.error || '登录失败';
  }
} finally {
  button.disabled = false;
  button.textContent = '连接';
}
```

`login.css`：背景改 `linear-gradient(180deg, var(--bg-gradient-start), var(--bg-gradient-end))`；按钮用 `var(--accent-primary)`；focus 用 `box-shadow: var(--focus-ring)`；`::placeholder { color: rgba(241, 245, 249, 0.62); }`；删除裸 `outline: none` 而不补环的规则。

- [ ] **Step 4: 跑测试**

```bash
node --test web-client/css/login.test.js
```

- [ ] **Step 5: Commit**

```bash
git add web-client/index.html web-client/css/login.css web-client/css/login.test.js
git commit -m "$(cat <<'EOF'
fix(ui): align login page with viewer tokens and form feedback

Map known auth errors on the client, keep the API strings, and
give the password field a real focus ring and autocomplete.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Terminal 网格顺序与未授权披露

**Files:**
- Modify: `web-client/css/viewer.css`
- Modify: `web-client/js/terminal.js`
- Modify: `web-client/css/viewer-layout.test.js`
- Modify: `web-client/js/terminal.test.js`（若已覆盖 `render`）

**Interfaces:**
- Consumes: `TerminalPanel.hasAdminToken()`、现有 `render()`
- Produces: `render()` 在 `!authorized` 时隐藏 toolbar / transport / workspace / composer

- [ ] **Step 1: 改掉过时测试并写新失败测试**

删除：

```javascript
test('terminal workspace is pinned to the final grid row', … grid-row: 5 …);
```

改为：

```javascript
test('terminal status sits in a named row above the workspace', () => {
  assert.match(css, /grid-template-areas/);
  assert.match(css, /terminal-workspace/);
  const htmlOrder = html.indexOf('id="terminalStatus"');
  const ws = html.indexOf('id="terminalWorkspace"');
  assert.ok(htmlOrder > -1 && ws > htmlOrder);
});
```

若 `terminal.test.js` 有 `render` 用例，补：未授权时 `transport`/`workspace`/`composer` 带 `hidden`。

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --test web-client/css/viewer-layout.test.js web-client/js/terminal.test.js
```

- [ ] **Step 3: 实现**

`.terminal-panel`：

```css
.terminal-panel {
  display: grid;
  grid-template-areas:
    "auth"
    "toolbar"
    "note"
    "transport"
    "status"
    "warning"
    "retry"
    "workspace"
    "composer";
  grid-template-rows: auto auto auto auto auto auto auto minmax(0, 1fr) auto;
}
.terminal-auth-form { grid-area: auth; }
.terminal-toolbar { grid-area: toolbar; }
.terminal-pool-note { grid-area: note; }
.terminal-transport-row { grid-area: transport; }
#terminalStatus { grid-area: status; }
#terminalWarning { grid-area: warning; }
#terminalLoadRetryBtn { grid-area: retry; }
.terminal-workspace { grid-area: workspace; }
.terminal-composer { grid-area: composer; }
```

删除 `.terminal-workspace { grid-row: 5; }`。

`render()`：

```javascript
const chrome = [
  this.elements.root?.querySelector('.terminal-toolbar'),
  this.elements.root?.querySelector('.terminal-transport-row'),
  this.elements.workspace,
  this.elements.root?.querySelector('.terminal-composer'),
];
chrome.forEach((el) => el?.classList.toggle('hidden', !authorized));
```

`cacheElements` 也可以直接缓存这些节点，避免 querySelector。未授权仍显示 auth + status + 可选 pool note。

- [ ] **Step 4: 跑测试**

```bash
node --test web-client/css/viewer-layout.test.js web-client/js/terminal.test.js
```

- [ ] **Step 5: Commit**

```bash
git add web-client/css/viewer.css web-client/js/terminal.js \
  web-client/css/viewer-layout.test.js web-client/js/terminal.test.js
git commit -m "$(cat <<'EOF'
fix(ui): put terminal status above the workspace and hide chrome until admin auth

Named grid areas replace the stale grid-row:5 pin that rendered
the warning under the empty xterm.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Tab/对话框语义、inline 样式、需求文档

**Files:**
- Modify: `web-client/viewer.html`
- Modify: `web-client/js/terminal.js`
- Modify: `web-client/css/viewer.css`
- Modify: `web-client/css/viewer-layout.test.js`
- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md`

**Interfaces:**
- Consumes: 现有 `showDesktop` / `showTerminal`、各 modal 开关
- Produces: `aria-selected` / `aria-controls`；三个设置弹层 `role="dialog"`

- [ ] **Step 1: 写失败测试**

```javascript
test('workspace tabs expose tab semantics', () => {
  assert.match(html, /id="desktopTabBtn"[^>]*role="tab"[^>]*aria-controls="desktopPanel"/);
  assert.match(html, /id="terminalTabBtn"[^>]*role="tab"[^>]*aria-controls="terminalPanel"/);
  assert.match(html, /id="resolutionModal"[^>]*role="dialog"/);
  assert.match(html, /id="networkModal"[^>]*role="dialog"/);
  assert.match(html, /id="diagModal"[^>]*role="dialog"/);
  assert.doesNotMatch(html, /min-width:\s*600px/);
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --test web-client/css/viewer-layout.test.js
```

- [ ] **Step 3: 实现**

- Tab 按钮补 `role="tab"` `aria-controls` `aria-selected`；`showDesktop`/`showTerminal` 同步 `aria-selected`
- 三个 modal 根节点补 `role="dialog" aria-modal="true"`
- 现有 close 处理上加 `keydown` Escape（若尚未监听）
- 诊断/TURN/自适应说明的大段 `style=` 改成 class（`.diag-modal`、`.latency-panel`、`.network-turn-select`）
- 需求文档 §3.4 按 spec §7 改三句话：空闲退避、全屏内退出、顶栏高度绑定

- [ ] **Step 4: 跑完整前端相关测试**

```bash
node --test web-client/js/chrome-layout.test.js web-client/css/viewer-layout.test.js \
  web-client/css/login.test.js web-client/js/terminal.test.js web-client/js/webrtc.test.js
cd signal-server && npm test
```

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add web-client/viewer.html web-client/js/terminal.js web-client/css/viewer.css \
  web-client/css/viewer-layout.test.js docs/需求文档/WebRemoteDesktop-需求文档.md
git commit -m "$(cat <<'EOF'
fix(ui): add dialog/tab semantics and sync chrome layout requirements

Move diagnostic inline styles into CSS and document idle docks,
in-fullscreen exit, and status-bar height binding.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## 手动验收清单（全部 task 完成后）

在 `http://127.0.0.1:8080`（走构建产物，不要直接 file://）：

1. **375×812 登录**：卡片居中；错误密码显示「密码错误」；焦点环可见
2. **375 Viewer 未连接**：顶栏多行，画面从顶栏下沿开始；无 spinner；主按钮可点
3. **375 / 768 已连接**：两 Dock 同列不重叠；3s 后滑出画面；从底部 80px 唤回
4. **375 更多**：方向键等进菜单，菜单项 ≥ 44px
5. **已控制**：无「请求控制」按钮
6. **全屏**：左上角「退出全屏」存在且可用
7. **Terminal 未授权**：只有密码 + 状态，无空白 xterm / 传输行
8. **1440**：快捷键仍全部可见，不强制进更多
9. **点远程桌面**：坐标仍准（回归一次点击）

---

## 执行交接

Plan 完成后不要自动开工。问用户选：

1. **Subagent-Driven**（推荐）— 每 task 一个子代理，task 间审查
2. **Inline Execution** — 本会话按 executing-plans 推进
