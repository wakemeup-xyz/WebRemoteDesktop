# Viewer 交互优化设计

**状态：** Implemented（2026-09-30；离线 Chromium 验收通过，真实设备/公网链路仍为 NOT RUN）
**日期：** 2026-09-30
**范围：** Viewer 的连接阶段、控件门禁、全屏退出、底部操作栏、网络提示、输入恢复提示、文案和可访问性
**不改动：** WebRTC/Socket.IO/输入协议、控制租约、Terminal/PTY、网络模式语义、Host、Signal Server、tunnel 和服务启动脚本

> 本文是一次产品交互重审。它保留 `2026-09-06-immersive-fullscreen-chrome-design.md` 已验证的 document-level fullscreen 几何、inert 和焦点安全实现，但替换“顶部边缘唤出面板再退出”的交互契约。实现时应在旧设计文档中增加 supersession note，历史验收记录不回写。

## 1. 审查结论

当前 Viewer 的主要问题是状态和控件层级，而不是媒体链路：

1. 未连接时仍出现隐藏控件、诊断日志、Terminal、更多、搜索端口和网络顾问。产品需求已经规定连接前只保留「开始学习助手」CTA，但当前 `chrome-layout.js` 对 Terminal、More 和端口搜索保留了可见占位。
2. 初次进入页面就显示「输入上下文未确认，已保持安全状态」，这是输入传输被初始化为 revoked/uncertain 后触发的 UI 误报。用户没有开始会话时不应看到恢复入口。
3. 全屏退出需要先点击右上角「退出」显示面板，再点击「退出全屏」。两个按钮语义相近，第一步只是在寻找第二步，且顶部栏隐藏后出口不够直观。
4. 已连接时底部 Dock 同时承载导航键、快捷键、缩放、分辨率、全屏、网络、端口、暂停和断开，文字按钮很多，窄屏会换行成两层，主次关系不清。
5. 网络顾问在连接前就显示，默认文本包含本地 URL；它把调试信息放进了主工作区，也会和移动端 Dock 争夺空间。
6. 初始指标用 `0 FPS / RTT - / 链路 -` 表示“未开始”，用户容易把它理解成“连接失败”。
7. 中文界面中混用 `Terminal`、`Admin password`、`Terminal transport` 等英文，操作名称还混合了动作、状态和实现名。

当前 Node/CSS 自动化套件为 813 项通过；这只能说明既有逻辑未回归，不能证明浏览器布局和真实全屏体验。已有验收记录也明确 375、768、1440 浏览器矩阵和真实设备仍未运行。

## 2. 外部产品借鉴

| 产品 | 可借鉴模式 | 对本项目的结论 |
|---|---|---|
| TeamViewer Remote | 会话工具栏集中提供全屏、折叠/展开和会话操作 | 保留一个稳定工具栏入口；全屏退出必须是明确的一步操作 |
| AnyDesk | 全屏时可从屏幕边缘访问工具栏，并提供明确的 Exit fullscreen；显示模式和全屏模式分开 | 可以自动隐藏普通 Chrome，但必须保留可见、可理解的退出动作 |
| Microsoft Remote Desktop Web Client | 远程桌面自动适应浏览器，任务栏提供 fullscreen 图标，资源工具栏有固定快捷键 | 指标和高级设置应从主操作区降级；主区域优先保持远程画面 |
| Chrome Remote Desktop | Web 入口保持简单，用户依靠浏览器全屏和明确的退出方式 | 初始状态应简单，连接前不应暴露调试和网络细节 |

参考来源：

- [TeamViewer Remote session toolbar](https://www.teamviewer.com/en-cis/global/support/knowledge-base/teamviewer-remote/remote-control/remote-session-toolbar/)
- [AnyDesk Display and fullscreen mode](https://support.anydesk.com/docs/display)
- [Microsoft Remote Desktop Web client features](https://learn.microsoft.com/en-us/previous-versions/remote-desktop-client/client-features-web-cloud)
- [Chrome Remote Desktop](https://support.google.com/chrome/answer/1649523?hl=en)

## 3. 目标与原则

### 3.1 目标

- 用户打开 Viewer 后能立即知道下一步是什么。
- 每个连接阶段只显示该阶段有意义的动作。
- 全屏状态始终可以一键退出，Esc 和浏览器原生退出继续有效。
- 已连接时把高频动作和低频设置分开，桌面与触摸屏都保持 44px 以上命中区。
- 输入恢复、网络顾问和诊断只在有真实会话上下文时出现。
- 不改变既有媒体、输入、租约和 Terminal 协议。

### 3.2 原则

- **状态优先于功能数量：** 隐藏无关动作，而不是把它们全部禁用后留在页面上。
- **一个事实源：** `uiPhase`、`streamReady` 和 control lease 继续由现有 WebRTC snapshot 提供；Chrome 只消费 capability policy。
- **动作与状态分离：** 「全屏」/「退出全屏」、「暂停」/「恢复」、「隐藏控件」/「显示控件」保持成对且稳定。
- **失败可恢复：** 失败页给出一个主恢复动作，网络、端口和诊断放进次级入口。
- **不把调试信息当产品信息：** 本地 URL、候选 IP、内部 transport 名称只在网络/诊断面板中出现。

## 4. 连接阶段与 Capability Policy

Viewer 使用现有阶段，不新增 WebRTC 状态：

| 阶段 | 主画面 | 顶部状态 | 底部 Dock | 网络顾问 | 输入恢复 |
|---|---|---|---|---|---|
| `idle` | 中央「开始学习助手」 | 只显示「未开始」 | 隐藏 | 隐藏 | 隐藏 |
| `signaling` | 连接中提示和 spinner | 显示连接阶段 | 隐藏 | 隐藏 | 隐藏 |
| `media-pending` | 「正在等待第一帧」 | 显示媒体等待 | 隐藏 | 隐藏 | 隐藏 |
| `connected` | 远程桌面 | 显示状态和简要指标 | 显示主操作 | 默认收起为小状态条 | 仅在真实阻塞时显示 |
| `media-stalled` | 保留最后画面/恢复提示 | 显示卡顿原因 | 保留恢复和主操作 | 显示警告摘要 | 仅在真实阻塞时显示 |
| `disconnected` | 重试 CTA | 显示断开原因 | 隐藏；网络/诊断进次级入口 | 连接尝试后才可见 | 隐藏 |
| `terminal-active` | Terminal 工作区 | 显示 Terminal 状态 | 桌面 Dock 隐藏 | 只保留紧凑状态 | 隐藏 |

“连接前仅保留 CTA”解释为：未连接阶段只保留一个可操作主入口；非交互的「未开始」状态文本可以存在。Terminal、网络、端口、诊断和桌面输入动作不能以禁用按钮形式占用页面。

### 4.1 Capability 映射

| 控件 | 可见阶段 | 额外门禁 |
|---|---|---|
| `startBtn` | idle、disconnected | signaling 后隐藏 |
| `requestControlBtn` | connected、media-stalled | 没有 ACTIVE lease 或正在切换时禁用 |
| `textInputBtn`、移动文本输入 | connected、media-stalled | 需要可用桌面输入 |
| `refreshBtn` | media-pending、connected、media-stalled、disconnected | 只在有当前会话或可重试会话时显示 |
| `pauseBtn` | connected、media-stalled | Terminal active 时隐藏 |
| `disconnectBtn` | signaling、media-pending、connected、media-stalled | idle 不显示 |
| `scaleBtn`、`resolutionBtn`、`fullscreenBtn` | connected、media-stalled | 需要可见媒体画面 |
| `networkModeBtn` | disconnected、media-stalled、connected 的“更多” | idle 不显示；详细 URL 只在面板显示 |
| `portSearchBtn` | media-stalled、disconnected 的“网络”面板 | ACTIVE desktop-control lease、非暂停、非切换 |
| `diagBtn` | connected、media-stalled、disconnected 的“更多” | 诊断组件未就绪时隐藏，不留 disabled 占位 |
| `toggleControlsBtn` | connected、media-stalled | 移入顶栏设置区，不占主 Dock |
| `moreActionsBtn` | connected、media-stalled | 菜单为空时隐藏 |
| `terminalTabBtn` | connected、media-stalled | 未连接阶段隐藏，而非显示 disabled |

## 5. 控件层级与布局

### 5.1 主操作

已连接时只在第一层显示：

1. 请求控制 / 已控制
2. 文本输入
3. 刷新画面
4. 暂停 / 恢复
5. 全屏
6. 断开连接

缩放、分辨率、网络、端口搜索、诊断、键盘快捷键和控件显示策略进入「更多」菜单，按“输入、显示、网络、诊断”分组。菜单使用现有 `moreActionsMenu`，不引入第三方菜单依赖。

### 5.2 Dock 约束

- 桌面宽度下主操作保持一行；禁止把所有动作依靠 `flex-wrap` 自动挤成两层。
- 390px 左右的窄屏只显示 4–5 个主操作，其他动作进入底部菜单或全屏面板。
- 每个触摸目标至少 44px × 44px。
- 主操作使用一致的“图标 + 短标签”结构；图标使用内联 SVG 或现有字符，不新增图标库。
- 禁用按钮只用于“当前可见但暂时不能操作”的动作，并提供 `title` 或 `aria-describedby` 解释；不相关动作直接隐藏。
- 「隐藏控件」只控制普通 Viewer Chrome，不得改变 fullscreen、Terminal、输入恢复或网络协议语义。

### 5.3 全屏退出

保留 `document.documentElement` 作为唯一 fullscreen target，以及已有 `body.fullscreen-active`、ChromeLayout 几何和 inert 逻辑。替换当前两步 overlay：

- `fullscreenExitOverlay` 直接包含唯一的 `exitFullscreenBtn` 和错误状态文本。
- 不再使用 `fullscreenExitRevealBtn`、`fullscreenExitPanel` 或 4 秒 reveal timer。
- 进入全屏后，右上安全区始终保留一个明确的「退出全屏」按钮；按钮文字和 `aria-label` 都使用「退出全屏」。
- 按钮命中区至少 44px，使用 safe-area inset，pointer events 不穿透到远程画面。
- `document.exitFullscreen()` 缺失或拒绝时保留按钮、保留编辑焦点和草稿，并显示失败原因。
- Esc、浏览器 UI 和外部 `fullscreenchange` 仍由现有生命周期统一清理。
- 普通视图中的 `fullscreenBtn` 继续显示「全屏」，不依赖桌面 control lease。

这一改动只改变出口的发现路径，不改变全屏几何、媒体、Terminal 或输入状态机。

### 5.4 网络顾问

- idle、signaling、media-pending 时不显示。
- connected 时默认收起为紧凑状态 chip；只有链路警告、0 FPS 恢复或用户点击时展开。
- 不在主浮窗里显示 `127.0.0.1`、候选 IP 或内部实现名；这些内容放入网络面板/诊断摘要。
- 控件隐藏或 fullscreen 时，顾问不得覆盖退出按钮、移动文本输入或安全区。
- 状态文本采用用户可理解的“当前链路、建议动作、原因”三段式；模式名仍由网络模式设置面板提供。

### 5.5 输入恢复提示

`inputRecoveryNotice` 只在以下任一条件成立时显示：

- 已有真实连接阶段（`uiPhase !== idle`）且 recovery state 为 waiting/failed；
- 已存在保留草稿，且移动输入 surface 或 transport 确认状态确实 blocked/uncertain；
- control lease 已被释放并且当前会话明确要求重新获取控制。

初始 `idle`、没有草稿、没有连接尝试时必须保持 hidden 和 `aria-hidden=true`。

## 6. 文案和可访问性

统一词汇：

| 旧/混合表达 | 统一表达 |
|---|---|
| 全屏 / 退出 / 退出全屏 | 全屏 / 退出全屏 |
| 暂停（状态变化后仍显示暂停） | 暂停 / 恢复 |
| 隐藏控件 / 显示控件 | 保持这对动词，并由同一个状态 writer 更新 |
| 网络：自动 | 网络 |
| Terminal | 终端（技术 transport 名称只在设置面板保留） |
| Admin password | 管理员密码 |
| Terminal transport | 终端传输 |

所有动态按钮必须同步：

- `aria-pressed`：全屏、移动键盘、修饰键；
- `aria-expanded`：更多菜单、网络顾问、网络面板；
- `aria-label`：图标化按钮必须有可读名称；
- `role=status`：连接、恢复和网络提示；
- 隐藏状态不得留在 Tab 顺序、屏幕阅读器或 pointer hit-test 中。

## 7. 实现边界

- `ChromeLayout` 继续作为 Chrome 几何和 capability 的单一 writer；新增/调整 capability 只在该层汇总，不让 `ui.js`、`webrtc.js` 和 `input.js` 互相覆盖可见性。
- `ui.js` 只负责全屏生命周期、焦点保护和按钮文案，不拥有 WebRTC phase。
- `WebRTC` 继续提供连接 snapshot、network advisor 内容和媒体状态，不直接决定 idle 页面是否渲染全部控件。
- `Input.updateInputRecoveryUI()` 只根据会话上下文和恢复状态展示提示。
- 不新增轮询；不修改 WebRTC/Socket.IO payload；不修改服务启动方式；不启动或重建 tunnel 来制造验收证据。
- 旧 fullscreen CSS/DOM 的静态测试和离线脚本必须同步改为“一步退出”契约，不能通过放宽断言保持旧行为。

## 8. 验收标准

### 自动化

- Viewer JS/CSS 全套测试通过。
- capability 测试逐阶段断言可见控件集合；idle 可见交互控件只有 `startBtn`。
- input recovery 测试断言首次 idle 不显示 notice，真实 draft/recovery 仍显示。
- fullscreen 测试断言任何 fullscreen 状态下点击唯一 `exitFullscreenBtn` 一次即可退出；reveal/panel/timer 不再存在。
- network advisor 测试断言 boot 时 hidden，connected/stalled 的 meaningful update 才可见。
- 静态布局测试断言 44px hit target、safe-area、无两层自动换行。

### 离线浏览器

在 1440×900、768×1024、390×844、375×812 上覆盖 idle、connecting、connected、media-stalled、disconnected、Terminal、fullscreen：

- idle 不显示远程动作、网络顾问或输入恢复；
- 390/375 宽度不出现按钮重叠、Dock 两层挤压或顾问遮挡；
- fullscreen 一步退出、Esc 退出、退出后布局恢复；
- 任何隐藏控件没有 pointer hit-test 或 Tab 焦点；
- 触摸目标均达到 44px。

### 真实运行边界

真实 Host/Quartz、iPhone Safari、iPad Safari、Android Chrome、WebKit、公网入口、TURN 和 tunnel 仍需由操作者在既有 origin 上执行；没有证据时必须标记 `NOT RUN`，不能由离线 Playwright 或服务健康代替。

## 9. 风险与回滚

- **风险：** capability visibility 变化可能隐藏已有快捷入口；通过分阶段测试和“更多”菜单回归解决。
- **风险：** 移除 fullscreen reveal 可能增加常驻按钮视觉占用；按钮采用低干扰样式，但保持可见和可访问。
- **风险：** 旧离线验收脚本依赖 reveal/panel ID；实现时同步脚本和测试，不保留死 DOM。
- **回滚：** 先回滚 Viewer HTML/CSS/JS 和测试提交即可；不涉及协议或服务数据迁移。
