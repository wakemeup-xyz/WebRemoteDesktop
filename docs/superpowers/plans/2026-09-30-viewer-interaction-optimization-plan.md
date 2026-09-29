# Viewer 交互优化执行计划

> **Spec：** [2026-09-30-viewer-interaction-optimization-design.md](../specs/2026-09-30-viewer-interaction-optimization-design.md)
> **状态：** Implemented（2026-09-30）
> **日期：** 2026-09-30
> **目标：** 按连接阶段收敛 Viewer Chrome，简化全屏退出，重排操作栏，消除初始误报，并完成桌面/窄屏离线验收。

## 1. 执行约束

- 只改 Viewer 交互层和对应测试/验收脚本。
- 不改 WebRTC、Socket.IO、输入协议、control lease、Terminal/PTY、Host、Signal Server、tunnel 或服务启动脚本。
- 使用现有 `uiPhase`、`streamReady`、control lease 和 ChromeLayout 几何事实源。
- 不新增第三方依赖，不新增图标库；图标使用现有 CSS/内联 SVG。
- 当前工作树有用户的非本任务修改和未跟踪文件；实施时必须使用隔离 worktree，禁止 `git add .`、整体 stash 或覆盖无关文件。
- 不启动或重启服务；真实公网/设备验收由操作者另行运行。
- 每个任务完成后运行对应窄测试，全部任务完成后运行全套 Viewer 测试和离线浏览器验收。

## 2. 文件职责

| 路径 | 责任 |
|---|---|
| `web-client/js/chrome-layout.js` | 阶段 capability policy、可见性、主/次控件分组、idle 与 fullscreen 的边界 |
| `web-client/js/chrome-layout.test.js` | 阶段控件矩阵、隐藏/禁用、更多菜单回归 |
| `web-client/viewer.html` | 操作分组、fullscreen 直接退出 overlay、统一文案、ARIA |
| `web-client/css/viewer.css` | 主 Dock 单行/响应式菜单、按钮层级、safe-area、网络顾问和 fullscreen 样式 |
| `web-client/css/viewer-layout.test.js` | DOM 层级、CSS 静态契约、命中区和不重叠规则 |
| `web-client/js/ui.js` | fullscreenchange、一步退出、文案、焦点保护 |
| `web-client/js/ui.test.js` | fullscreen 失败/退出、Esc、焦点和按钮状态 |
| `web-client/js/input.js` | idle/recovery gate，阻止初始误报 |
| `web-client/js/input-recovery.test.js` | 初始 hidden、draft/recovery 正常显示 |
| `web-client/js/webrtc.js` | network advisor 的 phase/meaningful-change 可见性和默认文案 |
| `web-client/js/webrtc.test.js` | advisor 启动隐藏、warning/connected 展开和定时折叠 |
| `scripts/mobile_input_interaction_acceptance.py` | 离线真实浏览器状态、fullscreen 一步退出、窄屏命中和布局 |
| `scripts/mobile-input-interaction-acceptance.test.js` | acceptance CLI 和安全 artifact 契约 |
| `docs/需求文档/WebRemoteDesktop-需求文档.md` | 同步新的连接前控件和全屏出口说明 |
| `docs/superpowers/specs/2026-09-06-immersive-fullscreen-chrome-design.md` | 增加 supersession note，保留历史实现证据 |
| `docs/superpowers/reports/2026-08-30-viewer-chrome-acceptance.md` | 不回写历史结论；新增实施报告引用新验收 |

## 3. 任务分解

### Task 0：基线和评审夹具

**目的：** 在改动前固定当前契约，避免把历史脏文件或服务状态混入实现。

- [x] 读取根 `AGENTS.md`、Viewer 需求、现有 Chrome capability/fullscreen spec。
- [x] 在隔离 worktree 中记录当前 commit、`git status --short`、已有测试计数。
- [x] 在测试夹具中定义统一的 phase snapshot：idle、signaling、media-pending、connected、media-stalled、disconnected、terminal-active。
- [x] 为每个 phase 写出预期 visible IDs 和 primary IDs；先让旧实现至少在 idle/connected 两组断言失败，确认测试真正锁定问题。

验证：

```bash
node --test web-client/js/chrome-layout.test.js web-client/css/viewer-layout.test.js
```

### Task 1：收敛阶段 Capability Gate

**文件：** `chrome-layout.js`、`chrome-layout.test.js`、必要时 `viewer.html`

- [x] 扩展现有 `CAPABILITY_IDS`，纳入 `toggleControlsBtn`、`diagBtn`、`moreActionsBtn`、`portSearchBtn` 和 Terminal tab。
- [x] 让 idle/signaling/media-pending 直接隐藏无关动作；不留下 disabled 占位。
- [x] 让 disconnected 只显示重试 CTA，网络和诊断通过次级入口恢复。
- [x] 让 Terminal tab 在未连接阶段隐藏；Terminal active 时关闭桌面 Dock 和不相关 modal。
- [x] 把 `toggleControlsBtn` 从主 Dock 移到状态栏设置区，保持 controls-hidden 语义不变。
- [x] 让 capability writer 同时负责 `hidden`、`disabled`、`aria-disabled` 和解释性 tooltip，消除多个模块直接写同一节点。
- [x] 更新矩阵测试，断言 idle 的可见交互控件只有 `startBtn`，connected 的主操作集合不超过六个。

验证：

```bash
node --test web-client/js/chrome-layout.test.js
node --test web-client/css/viewer-layout.test.js
```

### Task 2：修复初始 Input Recovery 误报

**文件：** `input.js`、`input-recovery.test.js`、必要时 `mobile-text-input.js`

- [x] 在 `updateInputRecoveryUI()` 中增加会话相关门禁：idle 且无 draft、recovery、surface uncertainty 时强制 hidden。
- [x] 保留真实连接后的 waiting/failed、draft blocked、lease reacquire 提示。
- [x] 首次 hidden 时同步 `aria-hidden=true`，隐藏动作不进入 Tab 顺序。
- [x] 测试初始化 transport revoked/uncertain 不再直接显示 notice；模拟真实 draft/recovery 仍显示正确按钮和文案。

验证：

```bash
node --test web-client/js/input-recovery.test.js web-client/js/mobile-text-input.test.js
```

### Task 3：改成全屏单按钮退出

**文件：** `viewer.html`、`viewer.css`、`ui.js`、`ui.test.js`、`viewer-layout.test.js`

- [x] 删除 `fullscreenExitRevealBtn`、`fullscreenExitPanel` 和 reveal timer；保留 `fullscreenExitOverlay`、唯一 `exitFullscreenBtn`、`fullscreenExitStatus`。
- [x] 让 overlay 直接固定在 document fullscreen 右上 safe-area，按钮文字为「退出全屏」，最小命中区 44px。
- [x] 保留 documentElement fullscreen target、`fullscreen-active`、status/Dock inert、ChromeLayout 几何和普通 `fullscreenStatus`。
- [x] `exitFullscreen()` 失败时不隐藏按钮、不伪造成功，保留焦点/草稿并显示错误。
- [x] 更新 UI 测试：进入全屏显示唯一出口；点击一次完成退出；Esc/外部 fullscreenchange 清理；Terminal、无 lease、移动文本输入均可退出。
- [x] 更新 CSS 静态测试和离线 acceptance，移除对 reveal/panel/timer 的依赖。

验证：

```bash
node --test web-client/js/ui.test.js web-client/css/viewer-layout.test.js
```

### Task 4：重排 Dock 和 More 菜单

**文件：** `viewer.html`、`viewer.css`、`chrome-layout.js`、必要时动作绑定所在文件及测试

- [x] 标记六个 primary actions，其余动作移入 `moreActionsMenu`，按输入/显示/网络/诊断分组。
- [x] 取消主操作栏的多行自动堆叠；桌面保持一行，窄屏用水平紧凑主栏 + 可滚动菜单/底部 sheet。
- [x] 为按钮增加一致的 icon+label 结构和 ARIA 名称，不引入图标依赖。
- [x] 保持现有 data-action、虚拟按键、输入协议和 keyboard mapping 不变。
- [x] 让菜单关闭、Esc、点击外部和焦点恢复继续符合现有 More 菜单测试。
- [x] 更新文案：网络、终端、管理员密码、全屏/退出全屏、暂停/恢复。

验证：

```bash
node --test web-client/js/chrome-layout.test.js web-client/js/ui.test.js web-client/css/viewer-layout.test.js
```

### Task 5：收敛 Network Advisor 和初始指标

**文件：** `webrtc.js`、`webrtc.test.js`、`viewer.css`、`viewer.html`

- [x] boot、idle、signaling、media-pending 时强制 advisor hidden。
- [x] connected 默认显示紧凑 chip；只有 meaningful change、warning/danger 或用户点击时展开。
- [x] 从默认主文案移除本地 URL、候选 IP 和内部 transport 名称；详细内容保留在 network modal/diagnostic snapshot。
- [x] 修正 advisor 在 controls-hidden、fullscreen、mobile text dock 下的 safe-area 和层级。
- [x] idle 隐藏或改写 0 FPS/RTT/链路指标为「未开始」；connected/stalled 才显示数值。
- [x] 测试 advisor 不会与主 Dock、全屏出口和移动输入面板重叠。

验证：

```bash
node --test web-client/js/webrtc.test.js web-client/css/viewer-layout.test.js
```

### Task 6：离线浏览器验收和文档同步

**文件：** `scripts/mobile_input_interaction_acceptance.py`、`scripts/mobile-input-interaction-acceptance.test.js`、需求文档、旧 fullscreen spec、验收报告

- [x] 在现有离线脚本中加入 idle/connected/stalled/disconnected 的 visible-ID、advisor、recovery 检查。
- [x] 在 1440×900、768×1024、390×844、375×812 覆盖 Dock 无两层挤压、无遮挡、44px hit target。
- [x] 将 fullscreen 场景改成唯一按钮一次退出，并验证 Esc、lease loss、Terminal、移动文本输入下均可退出。
- [x] 所有验收 artifact 持续禁止记录文本、按键、剪贴板、坐标、密码、token、完整 URL。
- [x] 在需求文档中同步“连接前仅 CTA”和“全屏直接退出”契约；旧设计文档增加 supersession note。
- [x] 记录真实设备、公网、WebKit、Quartz 为 NOT RUN，除非操作者提供既有 origin 并实际运行。

验证：

```bash
python3 scripts/mobile_input_interaction_acceptance.py --browser chromium --out /tmp/wrd-viewer-interaction-acceptance.json
node --test scripts/mobile-input-interaction-acceptance.test.js
node --test web-client/js/*.test.js web-client/css/*.test.js
git diff --check
```

## 4. 依赖关系与建议提交

依赖顺序：

```
Task 0 -> Task 1 -> Task 2
                  \-> Task 3 -> Task 4 -> Task 5 -> Task 6
```

建议按逻辑提交，避免把协议或服务改动混入：

1. `test(viewer): lock phase chrome capability matrix`
2. `fix(viewer): hide inactive chrome actions`
3. `fix(viewer): gate input recovery notice by session`
4. `fix(viewer): simplify fullscreen exit`
5. `refactor(viewer): group primary and secondary actions`
6. `fix(viewer): defer network advisor and normalize status`
7. `test(viewer): add interaction acceptance matrix`
8. `docs(viewer): record interaction optimization contract`

## 5. 计划自审

- **范围是否过大？** 分成七个小提交；协议、服务和媒体链路明确排除，可独立回滚。
- **是否违反现有需求？** 保留“连接前仅 CTA”、documentElement fullscreen、Esc、inert、control lease 和网络模式语义；只修正文档与代码目前不一致的可见性和退出路径。
- **是否覆盖用户反馈？** 全屏退出改为一步；底部按钮重新分层；连接前误报和无关按钮消失。
- **是否覆盖窄屏？** 明确 390/375 viewport、safe-area、44px hit target 和不换成两层 Dock。
- **是否容易误测？** 离线测试和真实设备分开；没有真实 origin 时不把 Playwright 结果标为公网/真机通过。
- **是否容易回滚？** 每个任务只涉及 Viewer 与测试/文档，未改变 wire contract、持久化或服务生命周期。
- **已知缺口：** 视觉图标和最终文案需要在实现后由产品/操作者确认；没有真实 iOS Safari、Android Chrome、WebKit、Quartz 和公网证据时仍是 NOT RUN。

## 6. 实施结果

- Viewer JS/CSS 全套测试：812/812 通过。
- 离线 Chromium 验收：23/23 场景通过；网络请求 0，敏感载荷 0。
- 验收 CLI 契约测试：4/4 通过。
- Web 资源构建与资源测试：5/5 通过。
- `git diff --check`：通过。
- 真实 iOS Safari、Android Chrome、WebKit、Quartz、公网入口和 TURN：NOT RUN，需在既有 origin 与真实设备上补验。
