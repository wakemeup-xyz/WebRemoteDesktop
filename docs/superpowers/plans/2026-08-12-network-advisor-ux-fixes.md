# Network Advisor & 控件交互 UX 修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 viewer 页面中网络模式浮窗的4个交互问题，让浮窗能自动折叠、连接前可设置网络模式、控件隐藏时位置合理、折叠动画流畅。

**Architecture:** 纯前端修复，涉及 `webrtc.js` 中的状态机逻辑和 `viewer.css` 中的 CSS 样式调整。无需改动 HTML 结构、后端或信令逻辑。每个 Task 独立可测，互不依赖。

**Tech Stack:** Vanilla JS (ES6)、CSS3、无构建工具（直接编辑源文件）

## Global Constraints

- 不引入新的第三方依赖
- 不修改 HTML 结构（`viewer.html`）
- 修改必须向后兼容：非 bootstrap 路径（`else` 分支，`webrtc.js:4409`）不受影响
- `configureNetworkControls()` 已有幂等保护（`dataset.bound = '1'`），利用此特性安全提前调用
- CSS 只新增规则，不修改已有规则的选择器或属性名（降低回归风险）
- 所有测试为手动浏览器验证（无自动化测试框架）

---

## 文件清单

| 操作 | 文件 | 改动内容 |
|------|------|---------|
| 修改 | `web-client/js/webrtc.js` | Task 1: 修复 `updateNetworkUI` else 分支计时器重置；Task 2: `installCore` 后提前调用 `configureNetworkControls` |
| 修改 | `web-client/css/viewer.css` | Task 3: 新增 `controls-hidden` 时 advisor bottom 规则；Task 4: 新增 handle 宽度 transition 规则 |

---

### Task 1: 修复网络模式浮窗不自动折叠（Timer Reset Bug）

**根因：** `updateNetworkUI`（`webrtc.js:3649`）的 else 分支在每次 stats 回调（每秒一次）中调用 `scheduleNetworkAdvisorCollapse()`，而该函数内部先 `clearNetworkAdvisorCollapseTimer()` 再设新计时器——每秒重置，导致4500ms 计时器永远不触发。

**Files:**
- Modify: `web-client/js/webrtc.js:3649-3651`

**Interfaces:**
- Consumes: `this._networkAdvisorCollapseTimer`（当前计时器句柄，null 表示未在计时）
- Produces: 无新接口；修复后 else 分支在计时器已存在时跳过重置

- [ ] **Step 1: 定位并阅读目标代码**

打开 `web-client/js/webrtc.js`，找到约第 3646 行的 `if (shouldExpand)` 块：

```javascript
if (shouldExpand) {
  this._networkAdvisorPinned = false;
  this.expandNetworkAdvisor({ reschedule: true });
} else if (!advisor.classList.contains('collapsed') && !this._networkAdvisorHover && !this._networkAdvisorPinned) {
  // Content refreshed while expanded — keep idle collapse armed.
  this.scheduleNetworkAdvisorCollapse();
}
```

确认 `scheduleNetworkAdvisorCollapse()` 定义在约第 3559 行，其内部第一步是 `this.clearNetworkAdvisorCollapseTimer()`（无条件清除旧计时器）。

- [ ] **Step 2: 应用修复**

将上述 else 分支改为：只在计时器未运行时才触发调度。

```javascript
if (shouldExpand) {
  this._networkAdvisorPinned = false;
  this.expandNetworkAdvisor({ reschedule: true });
} else if (!advisor.classList.contains('collapsed') && !this._networkAdvisorHover && !this._networkAdvisorPinned) {
  // Content refreshed while expanded — arm idle collapse only if not already running.
  if (!this._networkAdvisorCollapseTimer) {
    this.scheduleNetworkAdvisorCollapse();
  }
}
```

- [ ] **Step 3: 手动验证**

1. 打开 viewer 页面（确保 Host 在线，处于连接中状态）
2. 点击「开始连接」，等待连接建立
3. 触发一次网络 UI 更新（连接建立后会自动调用 `updateNetworkUI`，浮窗展开）
4. 保持鼠标不动（不hover浮窗），等待 **≤ 6 秒**（默认 4500ms + 动画）
5. **预期：** 浮窗自动折叠为右侧44px条状

反例验证：
6. 点击折叠条展开浮窗（pin 后松开鼠标）
7. 等待 4.5 秒不动
8. **预期：** 浮窗再次自动折叠

- [ ] **Step 4: 提交**

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
git add web-client/js/webrtc.js
git commit -m "fix(ui): prevent stats tick from resetting network advisor collapse timer

updateNetworkUI else-branch was calling scheduleNetworkAdvisorCollapse()
every stats tick (1s), which calls clearNetworkAdvisorCollapseTimer() and
resets the 4500ms countdown each time. The panel could never collapse while
stats were running.

Fix: only arm the idle-collapse timer if one is not already running."
```

---

### Task 2: 连接前可设置网络模式

**根因：** Bootstrap 路径中（`webrtc.js:4403` if 分支），`configureNetworkControls()` 只在 `init()` 内（点击「开始连接」后）调用。页面加载完成后按钮虽被 enable，但事件监听未绑定，点击无响应。

**Files:**
- Modify: `web-client/js/webrtc.js:4415-4418` 区域（`installCore` 调用处之后）

**Interfaces:**
- Consumes: `WebRTC.configureNetworkControls()`（已有幂等保护，安全提前调用）；`WebRTC.updateNetworkUI(message)`
- Produces: 无新接口；`networkModeBtn` 在 core 加载后立即绑定点击事件

- [ ] **Step 1: 定位目标代码**

找到 `webrtc.js` 约第 4415 行的 `installCore` 调用块：

```javascript
const startHandler = WebRTC.createStartHandler(ViewerBootstrap);
if (window.__WRD_SHELL__ && typeof window.__WRD_SHELL__.installCore === 'function') {
  window.__WRD_SHELL__.installCore(startHandler);
}
```

确认：正上方 `if (ViewerBootstrap) { ... }` 分支（约4403行）**没有**调用 `configureNetworkControls()`，而 `else` 分支（约4409行）**有**调用。

- [ ] **Step 2: 应用修复**

在 `installCore` 调用之后立即绑定网络控件：

```javascript
const startHandler = WebRTC.createStartHandler(ViewerBootstrap);
if (window.__WRD_SHELL__ && typeof window.__WRD_SHELL__.installCore === 'function') {
  window.__WRD_SHELL__.installCore(startHandler);
}
// Bind network mode controls immediately after core is interactive,
// regardless of bootstrap path. configureNetworkControls is idempotent
// (guarded by dataset.bound), so the init() call later is a no-op.
WebRTC.configureNetworkControls();
WebRTC.updateNetworkUI('请根据访问环境选择网络模式。');
```

- [ ] **Step 3: 手动验证**

1. 刷新 viewer 页面（不点「开始连接」）
2. 等待加载完成（loading 界面显示「开始学习助手」按钮）
3. 点击底部 `网络：自动` 按钮
4. **预期：** 网络模式弹窗正常打开，可选择模式并关闭
5. 选择「本地直连」后点「取消」，再次点击 `网络` 按钮
6. **预期：** 弹窗再次正常打开，未发生双重绑定（选项状态正确）

连接后验证（回归）：
7. 点击「开始连接」建立连接
8. 再次点击 `网络` 按钮
9. **预期：** 弹窗正常，`init()` 中的二次 `configureNetworkControls()` 调用无副作用

- [ ] **Step 4: 提交**

```bash
git add web-client/js/webrtc.js
git commit -m "fix(ui): bind network mode controls before start-button click

In the bootstrap path, configureNetworkControls() was only called inside
init(), which runs after the user clicks Start. The networkModeBtn was
enabled by installCore() but had no click listener, so clicking it was
a no-op before the first connection.

Fix: call configureNetworkControls() immediately after installCore()
in all paths. The function is idempotent (dataset.bound guard), so
the later call from init() is a safe no-op."
```

---

### Task 3: 控件隐藏时网络浮窗位置修正

**根因：** 浮窗固定 `bottom: 148px` 是相对 control-bar（24px）+ action-bar（84px）两层设计的。点击「隐藏控件」后两层消失，浮窗悬在屏幕中部，视觉上脱锚。

**Files:**
- Modify: `web-client/css/viewer.css`（在现有 `body.controls-hidden .network-advisor` 规则块附近新增规则）

**Interfaces:**
- Consumes: 无；纯 CSS 规则追加
- Produces: 无新接口

- [ ] **Step 1: 定位目标 CSS**

打开 `viewer.css`，找到约第 706 行的 `controls-hidden` + `network-advisor` 规则块：

```css
body.controls-hidden .network-advisor.visible:not(.collapsed) .network-advisor__body {
  /* Prefer the edge tab when the operator hid chrome. */
  display: none;
}

body.controls-hidden .network-advisor.visible:not(.collapsed) {
  width: 44px;
  max-width: 44px;
  right: 0;
  border-radius: 12px 0 0 12px;
}
```

- [ ] **Step 2: 新增 bottom 修正规则**

在上述规则块之后追加：

```css
/* When chrome is hidden, anchor the advisor near the bottom edge instead
   of floating at 148px (which assumed the two docks were visible). */
body.controls-hidden .network-advisor.visible {
  bottom: 20px;
}
```

- [ ] **Step 3: 手动验证**

1. 打开 viewer 页面并建立连接（浮窗出现）
2. 点击状态栏「隐藏控件」按钮
3. **预期：** 浮窗折叠条平滑移动到屏幕右下角（bottom: 20px）
4. 再次点击「显示控件」
5. **预期：** 浮窗位置恢复到 bottom: 148px（两层按钮栏上方）

移动端验证（如适用）：
6. 缩小窗口到 ≤640px 宽
7. **预期：** `bottom: 20px` 覆盖媒体查询中的 `bottom: 120px`（controls-hidden 规则优先级更高，因选择器更具体）

- [ ] **Step 4: 提交**

```bash
git add web-client/css/viewer.css
git commit -m "fix(ui): move network advisor to bottom edge when controls are hidden

The advisor was fixed at bottom:148px (anchored relative to the two visible
docks). When the user hides controls the docks disappear, leaving the advisor
floating mid-screen with no visual anchor.

Fix: add a CSS rule that moves advisor to bottom:20px in controls-hidden state."
```

---

### Task 4: 折叠动画 Handle 宽度抖动修复

**根因：** 展开态 handle 的 `flex-basis` 是28px（`.network-advisor:not(.collapsed) .network-advisor__handle` 规则），折叠态恢复默认44px。整体 `width` 从360px 缩至44px 时，handle 反向从28px 膨胀到44px，视觉上"先宽后合"，方向感相反。同时 `writing-mode` 从 `horizontal-tb`切换为 `vertical-rl` 无法被 CSS transition 平滑，文字方向会突然跳变。

修复方式：给 handle 的 `flex-basis` / `width` 添加 transition，与整体 width 动画同步。

**Files:**
- Modify: `web-client/css/viewer.css`（在 `.network-advisor__handle` 规则处新增 transition）

**Interfaces:**
- Consumes: 无；纯 CSS 规则修改
- Produces: 无新接口

- [ ] **Step 1: 定位目标 CSS**

找到约第 1020 行的 `.network-advisor__handle` 规则：

```css
.network-advisor__handle {
  flex: 0 0 44px;
  width: 44px;
  margin: 0;
  padding: 10px 0;
  border: 0;
  border-right: 1px solid rgba(148, 163, 184, 0.12);
  border-radius: 0;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-primary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
```

以及约第 1052 行的展开态 handle 规则（handle 缩窄到28px）：

```css
.network-advisor:not(.collapsed) .network-advisor__handle {
  /* Expanded: compact chevron strip so body keeps most width. */
  flex-basis: 28px;
  width: 28px;
}
```

- [ ] **Step 2: 为 handle 添加 transition**

在 `.network-advisor__handle` 规则内追加 `transition`：

```css
.network-advisor__handle {
  flex: 0 0 44px;
  width: 44px;
  margin: 0;
  padding: 10px 0;
  border: 0;
  border-right: 1px solid rgba(148, 163, 184, 0.12);
  border-radius: 0;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-primary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: flex-basis 0.35s cubic-bezier(0.16, 1, 0.3, 1),
              width 0.35s cubic-bezier(0.16, 1, 0.3, 1),
              background var(--transition-fast);
}
```

（时长与父容器的 `width 0.35s var(--transition-base)` 对齐，确保二者同步收缩/膨胀。）

- [ ] **Step 3: 手动验证**

1. 打开 viewer 页面建立连接
2. 触发浮窗展开（连接建立或刷新后自然展开）
3. 等待浮窗自动折叠（Task 1 修复后会在 4.5s 内折叠）
4. **预期：** 折叠时 handle 与 body 同步收缩，没有"先膨胀"的反向感
5. 点击折叠条展开，再点击 handle 手动折叠
6. **预期：** 展开/折叠动画流畅，无突兀跳变

- [ ] **Step 4: 提交**

```bash
git add web-client/css/viewer.css
git commit -m "fix(ui): synchronize network advisor handle width during collapse animation

The handle transitioned from 28px (expanded) back to 44px (collapsed) while
the parent container shrank from 360px to 44px, creating a jarring expansion
effect in the opposite direction.

Fix: add flex-basis/width transition to the handle, matched to the parent
container's 0.35s timing, so both collapse in sync."
```

---

## Self-Review

### 1. Spec Coverage 检查

| 用户反馈的问题 | 对应 Task |
|------------|---------|
| 网络模式浮窗不会自动折叠 | Task 1 ✅ |
| 折叠后 UI 对齐很奇怪 | Task 3 + Task 4 ✅ |
| 需要点击「开始连接」才能设置网络模式 | Task 2 ✅ |

未覆盖（不在本次范围）：
- 折叠态 handle 无展开方向箭头（`‹`）——视觉提示问题，可作后续独立 task

### 2. Placeholder 扫描

- Task 1 Step 3：提供了具体的"反例验证"步骤 ✅
- Task 2 Step 3：提供了"连接后回归验证"步骤 ✅
- Task 3 Step 3：提供了移动端边界场景 ✅
- 所有代码块包含完整可粘贴代码，无 TODO/TBD ✅

### 3. 类型一致性检查

- `this._networkAdvisorCollapseTimer`：Task 1 引用正确，与 `webrtc.js:145` 的声明名称一致 ✅
- `configureNetworkControls()`：Task 2 引用正确，与 `webrtc.js:3355` 的函数名一致 ✅
- CSS 选择器 `body.controls-hidden .network-advisor.visible`：Task 3 新增规则与现有规则中使用的类名一致 ✅
- `flex-basis` / `width` 属性名：Task 4 与现有 `.network-advisor:not(.collapsed) .network-advisor__handle` 中使用的属性名一致 ✅

### 4. 回归风险评估

| Task | 回归风险 | 说明 |
|------|---------|------|
| Task 1 | 低 | 只在计时器不存在时才新建计时器；已有的 `expandNetworkAdvisor({ reschedule: true })` 路径不受影响 |
| Task 2 | 低 | `configureNetworkControls()` 的 `dataset.bound` 幂等保护，`init()` 中的二次调用安全 |
| Task 3 | 极低 | 纯新增规则，只在 `controls-hidden` 状态生效 |
| Task 4 | 极低 | 只新增 transition 属性，不影响最终布局值 |
