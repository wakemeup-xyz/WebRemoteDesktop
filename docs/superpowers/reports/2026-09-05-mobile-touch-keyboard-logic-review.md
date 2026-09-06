# 手机 / iPad 触控与软键盘：当前逻辑及复审

审查开始：2026-09-05；最终复核：2026-09-06。代码基线：`main`，`000547ff37dc1a05c3b5b953954af81e9ed7d43a`（最终复核时未变）。

本次是当前实现审查与文档同步，不是新的实施方案；未修改生产代码、提交、推送或重启服务。

## 1. 结论与发现

**架构方向合理，交互实现尚未闭环。** 手机和 iPad 共用 Viewer、控制租约和输入传输，避免了协议分叉；但浏览器焦点、文本编辑基线和键盘避让没有形成一致的生命周期。不能继续把剩余事项仅描述为“缺真机验收”：下列问题已通过当前代码和隔离复现确认。

优先级：P1 直接妨碍核心输入或导致草稿丢失；P2 特定操作/布局下错误。建议先处理 F1/F2/F5，再处理 F3/F4/F6/F7；这是审查建议，并非已批准或已执行的修复计划。

| 编号 | 优先级 | 问题 | 证据 |
|---|---|---|---|
| F1 | P1 | 连续帧抢走软键盘焦点 | Node + Chromium DOM |
| F2 | P1 | 键盘高度重复计算 | CSS 调用链 + Chromium 布局 |
| F5 | P1 | 发送失败后草稿被还原丢失 | Node 事件序列 |
| F3 | P2 | 虚拟导航与文本游标基线不一致 | 真实 Input 装配的隔离复现 |
| F4 | P2 | 拖拽 down 起点偏移 | 真实 Input 装配的隔离复现 |
| F6 | P2 | 宽屏 iPad 键栏缺失 / 底栏不避让 | CSS + Chromium 布局 |
| F7 | P2 | 移动控件不在全屏容器 | 全屏调用代码 + Chromium DOM 包含关系 |

### F1 [P1] 每帧同步门禁抢走软键盘 / IME 焦点

- 位置：`web-client/js/input.js:328-348`；调用链 `web-client/js/webrtc.js` 的 `startVideoFrameTracking → markMediaAttemptReady → syncDesktopInputGate`，relay 的 `ackLoadedFrame` 也调用 `markMediaAttemptReady`。
- `Input.setActive(true)` 无论前后是否均为 active，都会 `videoElement.focus()`。持续出画时，用户刚聚焦 `mobileTextInput`，下一次门禁同步就把焦点移到 `remoteVideo`。
- 隔离 Node 复现与真实 Chromium DOM 均确认 `mobileTextInput → remoteVideo`。这证明抢焦点；系统键盘收起、IME 中断的具体设备表现仍需真机验证。
- 建议：门禁更新保持幂等；用户明确点击画面/进入控制时才按上下文决定聚焦，不抢占 textarea、composition、弹窗或 Terminal 的焦点。回归必须覆盖连续帧与输入框聚焦同时发生。

### F2 [P1] 键盘占高重复计入，窄屏画面与控件被挤出

- 位置：`web-client/css/viewer.css:812-816,1486-1501`；`web-client/js/chrome-layout.js:262-275`。
- 同一个键盘高度先作为 `#mobileKeySurface` 的 bottom padding 进入整个 Dock 实测高度，又用于抬高 `.chrome-docks`，最后与包含该 padding 的 `--mobile-dock-height` 一并从画面高度中扣除。
- 隔离 Chromium 使用当前 HTML/CSS 和 connected/active capability，注入 300px 键盘 inset：关闭动画并等待字体后，375×812 的 Dock 高度从 344px 增至 644px、顶部为 -188px，画面容器仅 32px 高；768×1024 的画面也仅 32px。精确尺寸受文字/字体和控件状态影响，重复计算的路径不依赖这些数值。
- 建议：键盘遮挡只在一处参与布局，Dock 高度测量仅包含控件本身；同时给小屏保留可操作画面空间。布局测试应在浏览器里测量最终矩形，不能只匹配 CSS 字符串。

### F3 [P2] 虚拟导航键与移动文本编辑基线脱节

- 位置：`web-client/js/input.js:659-688`；`web-client/js/mobile-text-input.js:182-214`。
- textarea 自身收到的方向/退格事件走私有 `sendControlKey()`，会更新本地 `remoteCursor`；工具栏按钮直接 `keyboardController.sendChord()`，不会通知文本适配器。远程点击、粘贴、全选等也不刷新该基线。
- 复现：先通过移动输入框提交 `abc`，点工具栏“左”，远端收到 ArrowLeft，本地选区仍在末尾；下一次输入 `X`，发出的事件在模拟远端形成 `abXc`，本地却保存 `abcX`。后续替换/删除继续建立在错误基线上。这里的远端字符串是事件语义推演，不是 Quartz 实测。
- 建议：导航和编辑动作经过同一文本编辑接口；无法跟踪远端光标的操作应安全失效化本地历史。保留未发送草稿，不能用清空全部文本解决。

### F4 [P2] 拖拽的 down 落在移动后的坐标

- 位置：`web-client/js/touch-input-adapter.js:52-63`。
- 超过 8 CSS px 阈值后才发送 down，但 down 使用当前 `point`，而非首次接触位置。缩小显示远程画面时，8px 的手指位移可对应更大的远端位移，拖窄滚动条、图标边缘或选区容易错过原目标。
- 实际 Input 装配的隔离复现：接触点 x=10，移到 x=19 后首次 down 为 relX=0.19，而非 0.10。现有测试只断言 down/move/up 的顺序，没有断言按下位置。
- 建议：保存初始映射坐标，达到阈值后在初始点 down，再发当前位置 move；补充小目标命中和拖拽期间几何变化的测试。

### F5 [P1] 发送拒绝后的草稿会在下一次输入前被清掉

- 位置：`web-client/js/mobile-text-input.js:87-119,133-139`。
- `sendText` 返回 false 后，适配器暂时保留 textarea 草稿，但 `lastValue` 回到已发送前缀；下一次 `beforeinput` 看到 DOM value 与该前缀不一致，便 preventDefault 并 `restoreBuffer()`，未发送内容因此消失。发送失败可以由 transport 阻塞或物理 pressed key 导致。
- 隔离复现：成功发送 `a`，拒绝新增 `b`，继续输入前的 `beforeinput` 把 `ab` 还原为 `a`。当前 DOM 也没有专门的失败草稿状态/重试按钮。
- 建议：区分已接受前缀、未发送草稿和本地编辑选区，显式暴露失败与重试；明确 transport 接受不等于 Host 已 ACK。覆盖“失败后继续输入”和“恢复后重试”，而不只测试失败当刻保留 value。

### F6 [P2] 宽屏 iPad 没有移动键栏，也没有底栏键盘避让

- 位置：`web-client/css/viewer.css:812-816,1486-1508`。
- “移动键盘”按钮按触控能力显示，但专用虚拟键栏、底部工具栏避让、画面预留仅在 `max-width:899px` 生效。1024px 宽且有触控的 iPad 仍落入桌面布局。
- 1024×1366、300px inset 的离线 Chromium 测量：`#mobileKeySurface` 为 `display:none`；底栏 top=1120、bottom=1342，均低于模拟键盘上沿 1066。移动文本框上移了，普通工具栏却留在键盘区域。
- 建议：输入控件的可用性根据触控/键盘状态决定，宽度决定排列方式；覆盖 iPad 横屏、竖屏及分屏跨越 899px 的场景。

### F7 [P2] 全屏容器不包含移动输入控件

- 位置：`web-client/js/ui.js:90-109`；`web-client/viewer.html:44-67,325-327`。
- 全屏目标是 `.viewer-container`；移动按钮位于顶部状态栏，虚拟键栏是容器的兄弟节点，文本 Dock 位于 body 下。离线 DOM 检查确认两类输入 Dock 均不在全屏目标里，代码也没有重挂载路径。
- 在浏览器支持该元素全屏的条件下，移动用户进入全屏后没有同屏的移动键盘入口和虚拟键栏，只能先退出。设备是否支持、如何展示元素全屏仍需实机验证。
- 建议：明确产品全屏模式是“只看画面”还是“可完整操控”；若要求后者，选择包含必要控件的全屏容器并测试焦点/键盘恢复。

## 2. 当前用户操作逻辑

正式访问入口仍为 `https://link.stockhub.wiki`；本次没有访问该域名。手机/Pad 不另设客户端入口。

| 操作 | 当前实现 | 适用边界 |
|---|---|---|
| 单指短点 / 双点 | 抬手时发 left down/up；500ms、6px 内复用 clickCount=2 | 不是本机触屏透传；在远端表现为鼠标 |
| 单指移动 | 超过 8 CSS px 进入左键拖拽；每帧合并 move，抬手 up | 首次 down 位置有 F4 问题；单指不作页面滚动 |
| 长按 / 右键 | 550ms 未超阈值发 right down，抬手 up；显式右键使用最近触点 | 长按后移动是右键拖动；未有触点时显式右键无坐标可用 |
| 双指 | 进入 SCROLLING，已有按键先 reset；取前两指质心位移发 wheel | 留下一指时仍处 SCROLLING；不提供 pinch zoom。第三指会被记录，前两指离开后可进入质心计算，不能写成严格忽略第三指 |
| “移动键盘” | 触控能力存在时显示入口；点击显示底部 textarea 并同步 focus | `isActive` 控制按钮，真正提交还需 controller READY；F1/F2/F6 影响可用性 |
| 软键盘 / IME | composition 中只缓存；compositionend 或非组合 input 按 diff 发送 Unicode | 同值 input 去重；本地缓存不是远端文档镜像；不能任意选择修改历史文本 |
| 删除 / 方向 | 删除 diff 每次最多发 16 个独立 Backspace chord；textarea 控制键更新本地游标 | 超额删除需要后续事件再次 flush；工具栏绕过基线，见 F3 |
| 虚拟 Shift/Ctrl/Alt/Cmd | 点击 latch down，再点 up；保存在 controller pressed map | 文本提交前自动释放虚拟 modifier；软键盘输入字母不会组成 Cmd+C |
| 复制 / 粘贴 / 输入法按钮 | 发送远端组合键 | 粘贴使用 Mac 的剪贴板；不读取手机剪贴板。“输入法”切的是远端输入法，手机输入法由本机系统选择 |
| 普通“文本输入” | 独立 modal textarea，点发送；compositionend 也自动提交并关闭 | 和持续输入的“移动键盘”不同；同样会受到 F1 焦点干扰 |
| iPad 外接鼠标/笔/键盘 | 非 touch pointer 走原鼠标绑定；物理键走 code 映射 | textarea 内过滤物理文本 keydown，交给 DOM 文本路径；外接键盘实际表现仍未验收 |

浏览器 textarea `maxlength=4096` 限制的是 DOM 字符串长度，缓存还有末尾 U+200B 哨兵；Host 单条 text 上限为 4096 Unicode scalar。两者不是“可连续输入 4096 个任意字符”的同一承诺。成功提交后缓存继续保留，长期输入与复杂 grapheme 删除需要单独验收。

## 3. 职责与恢复链路

```text
触控 → TouchInputAdapter → InputGeometry → Input.sendInput(mouse)
软键盘 → MobileTextInput → RemoteKeyboardController.sendText
虚拟/实体键 → RemoteKeyboardController → KeyboardTransport
                    ↓
          共享 ACTIVE 控制租约
                    ↓
可靠 input DataChannel / Socket.IO fallback → Host 校验 → Quartz
高频 mouse move 独立使用 input-move（不进 keyboard pending）
```

- `Input` 拥有鼠标可靠写入 seq、pending/reset；键盘 transport 拥有自己的 seq、pending/reset。它们共享 lease 和 v2 envelope 形状，并非一条混合序号队列。
- 直达 DataChannel 的输入由 Host 校验绑定/lease；Socket.IO fallback 先经过 Signal 身份与 lease 检查，再到 Host。Host 执行成功才提交 applied seq。
- UI connected、有新画面、有效控制权、信令就绪和媒体允许输入共同决定 `Input.isActive`；软键盘发送还受 controller READY/物理 pressed key 约束。
- 窗口 blur/页面 hidden 立即清理指针；DC open 时 keyboard reset，不可用时 park 本地键盘。保留 lease，后台持续 5 分钟才停媒体采集，两者时间语义不同。
- reset/park 隐藏并清空移动输入框和虚拟 latch。控制失效、连接断开进入已有恢复流程。mouse reset ACK 仅按自己的 input id/type 解锁；keyboard ACK 更新 keyboard transport；新 lease 或成功 reset ACK 会 rearm touch latch。
- `MobileTextInput.show/hide` 当前只 focus/blur，并没有保存与恢复先前焦点。`mobileInputMode` 的 capability 字段有默认值，但没有完整联动的 UI 状态机；不能据字段存在宣称已实现 blocked/retry 交互。

合理的职责应继续保留：手势解释在 touch adapter，composition/diff 在 text adapter，修饰键 pressed truth 在 controller，可靠投递/恢复在现有 transport。主要改进点是让焦点、导航引起的基线变化和布局高度各有明确接口；无需新增移动协议或移动 lease。

## 4. 本次验证与限制

| 检查 | 结果 | 能证明的范围 |
|---|---|---|
| 7 个相关 Node 套件 | 151/151 PASS | 既有适配器、controller、transport、输入编排与布局契约 |
| `evidence/mobile-input-review-20260905/reproduce.cjs` | 4 个问题断言成立 | F1/F3/F4/F5 的隔离代码复现；断言通过代表缺陷复现成功 |
| `evidence/mobile-input-review-20260905/layout.py` | Chromium 离线渲染 / DOM 检查完成 | F1/F2/F6/F7；键盘 inset 人工注入，所有网络请求 abort |
| 真实 Android/iPhone/iPad、系统软键盘与物理 Quartz | NOT RUN | 本次没有物理设备或真实桌面输入证据 |
| 真实 Viewer 会话、正式公网、live watcher | NOT RUN | 离线页面未连接 Signal/Host，未操作 tunnel/watcher |

命令（仓库根目录）：

```bash
node --test web-client/js/touch-input-adapter.test.js web-client/js/mobile-text-input.test.js web-client/js/input.test.js web-client/js/remote-keyboard-controller.test.js web-client/js/keyboard-transport.test.js web-client/js/chrome-layout.test.js web-client/css/viewer-layout.test.js
node docs/superpowers/reports/evidence/mobile-input-review-20260905/reproduce.cjs
python3 docs/superpowers/reports/evidence/mobile-input-review-20260905/layout.py
```

浏览器最初在受限沙箱内启动 SIGTRAP，后续授权检查又因授权会话失效中断；2026-09-06 环境权限更新后，最终版离线脚本完整运行并以 exit 0 退出。真实 DOM 检查包含生产 `setupEventListeners()` 设置的 video tabindex；没有省略这个焦点前置条件。该脚本依赖本机已安装的 Python Playwright/Chromium。没有把桌面 Chromium + 人工 inset 算作 iPad/Safari 或系统键盘 PASS。

最终结构化摘要见 [离线复现结果](evidence/mobile-input-review-20260905/results.json)。所有文本与手势数据均为隔离夹具中的人工值，布局 inset 人工注入，不含用户桌面或真实输入内容。

文档复核：需求文档 §3.4、移动设计 §4–§11、历史移动验收报告和 README 均链接/注明本轮结果。历史测试数字保留日期，新发现不回写成旧任务已修复。

## 5. 后续优化方案（2026-09-06）

已编制[整改设计](../specs/2026-09-06-mobile-input-interaction-remediation-design.md)、[7任务实施计划](../plans/2026-09-06-mobile-input-interaction-remediation-plan.md)及[方案审查记录](2026-09-06-mobile-input-interaction-remediation-plan-review.md)。这些是后续实施契约，不代表F1–F7已经修复；本报告与原缺陷复现证据保持历史原义。

后续实施记录（2026-09-06）：上述“尚未修复”是本报告原基线状态。整改分支现已完成Task1–7及主审追加拖拽提示修复，生产提交至`bfc886d`、验收脚本至`f2e694a`；严格离线Chromium集成及主线程最终审查已通过，未合main或部署。以[整改验收报告](2026-09-06-mobile-input-interaction-remediation-acceptance.md)查看最新分层状态，不改写本文及原红态脚本/JSON为旧版本已通过。
