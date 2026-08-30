# Viewer Chrome 与 Capability Gate 优化设计

**状态：** 已实施；真实浏览器/公网验收待执行
**范围：** Viewer 的布局、控件门禁、可访问性和连接占位
**明确排除：** 网络模式产品抽象、WebRTC/输入协议、Terminal PTY 语义、产品命名

## 1. 价值与合理性审查

这是最高价值、最低协议风险的改进。`375x812` 已实测顶栏约 257px、底部 Dock 约 372px 并遮挡画面；未开始连接时多个远程动作仍可点击。问题直接影响首次使用和移动端核心场景，修复后不会改变媒体或输入协议。合理方案是建立布局和 capability 的内部 seam，不进行整页重设计。

## 2. 现状证据

- `web-client/css/viewer.css` 的顶栏允许折行，但内容区仍按固定 56px 偏移；Dock 原先按独立固定位置计算。
- `web-client/js/shell-guard.js` 只表示 critical script 已加载，随后统一解除 `[data-core-control]` disabled。
- `web-client/js/webrtc.js` 已有 media phase 和 control lease 判断，但多个 UI writer 直接更新 DOM。
- Tab、dialog、动态 Terminal tab 的 ARIA 语义不完整。

## 3. 目标与非目标

目标：顶栏实际高度驱动画面起点；移动端 Dock 单列且不重叠；未连接/连接中/媒体待出画/已连接/已断开按 capability 禁用动作；空闲退避不依赖 hover；dialog/tab 有完整焦点和 ARIA；未连接占位不显示误导性 spinner。

非目标：不改变网络模式名称和行为，不自动连接，不改变控制租约，不引入依赖或图标库，不修改 Host overlay。

## 4. 设计

### 4.1 状态输入与 capability

定义内部只读 snapshot：

```js
{
  uiPhase: 'idle'|'signaling'|'media-pending'|'connected'|'media-stalled'|'disconnected',
  streamReady: boolean,
  activeControl: boolean,
  controlTransition: boolean,
  terminalAuthorized: boolean,
  modalOpen: boolean
}
```

`ChromeCoordinator` 根据 snapshot 返回 `canConnect`, `canSendDesktopInput`, `canRefresh`, `canPause`, `canDisconnect`, `canOpenNetwork`, `canOpenResolution`, `canOpenTerminal`。UI 只消费 capability；WebRTC 仍是状态真相，协调器不复制租约状态机。

### 4.2 几何契约

`chrome-layout.js` 用 `ResizeObserver` 将 `statusBar.offsetHeight` 写入 `--chrome-top`。`body`、桌面画面和 Terminal panel 使用同一变量。`chromeDocks` 是一个固定容器，内部 action/control 两栏静态垂直排列。触控最小尺寸为 44px，`[hidden], .hidden` 强制 `display:none !important`。

### 4.3 空闲与占位

仅在 `streamReady` 且无菜单/弹窗时，2.5 秒无底部活动才进入 `chrome-idle`；触屏不以点击画面唤出 Dock，底部边缘或显式按钮可以唤出。未点击开始时只显示 CTA；真正进入 signaling 才显示 spinner。

### 4.4 可访问性

Tab panel 补 `role=tabpanel`、`aria-labelledby` 和选中状态；dialog 补标题关联、打开时焦点、Escape 关闭和关闭后焦点恢复；更多菜单使用 `menuitem` 和方向键/Home/End。所有改动保留现有可见文案。

## 5. 错误、回滚与兼容

任何 capability 计算失败按不可操作处理并保留 CTA；ResizeObserver 不可用时回退 56px 和 CSS `100vh`。旧浏览器不支持 `dvh` 时使用 `vh`。回滚只需移除协调器绑定，外部 WebRTC/Terminal 协议不受影响。

## 6. 验收

- 375/768/1440 视口的顶栏、画面起点和 Dock bounding box 自动断言无重叠。
- 未开始连接时远程动作均 disabled/hidden，仅开始按钮可用。
- `activeControl=true` 时请求控制按钮不可见且不可点。
- 全屏退出按钮位于全屏元素内部；Terminal 未授权时不显示工作区和 composer。
- 键盘焦点、Escape、减少动画偏好均有浏览器验收。
- 不改变缩放、分辨率、暂停、断开、刷新、诊断现有行为。
