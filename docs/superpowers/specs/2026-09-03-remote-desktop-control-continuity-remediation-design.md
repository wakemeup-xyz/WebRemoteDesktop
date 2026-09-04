# 远程桌面控制连续性修复设计

**状态：** 已实施（自动化范围内）；真机/公网验收 NOT RUN
**日期：** 2026-09-03
**范围：** 已提交历史审查（`2863560..7645862`，2026-08-08～2026-09-03）确认的控制面与出画门闩缺陷：真机触控、虚拟键命中、可靠桌面写入、lease 安全释放、断连网络恢复、loading 遮挡、媒体暂停键盘屏障、session 真相源、刷新后 paint 基线、冷启动 SPS refresh、过期设计文档。
**审查来源：** `docs/archive/worklogs/review-anchors.md`

## 1. 问题与目标

最近两段提交把移动端遥控和稳定性补丁合入了生产路径，但真机主路径和控制契约仍有可复现缺口：

1. 触控 `mapPoint` 展开真实 `PointerEvent` 后丢掉 `clientX/clientY`，单指 tap/drag/long-press 被静默丢弃。
2. `#mobileKeySurface` 继承 `.chrome-docks { pointer-events: none }`，虚拟键点不中并点穿画面。
3. Viewer 可靠 mouse/command 在 transport 失败前占用 `seq`；Host `ReliableDesktopWriteState` 先占号再执行 Quartz；lease 失配的 `up/reset` 被 `stale-lease` 短路。
4. `on_offer` 只 `transition_keyboard`，不重置 desktop write-state。
5. `_pendingMouseReset` 在 reset 发送失败或 ACK 串扰后无法被 lease 重获清掉；`acceptMouseAck` 不看 `inputType`。
6. `disconnected` 能打开网络面板，但 Socket 已断时 `setNetworkMode` 不 `refresh()` 也不重建信令。
7. `#loading` 只切 `is-connecting`，非 `.hidden` 仍全幅拦截点击。
8. 媒体暂停注释写“不要开键盘 reset barrier”，紧接着调用 `Input.resetKeyboard('media-suspended')`。
9. `DesktopSessionState` 与 `WebRTC.uiPhase` 双写；`setUiPhase('connected')` 用 `event: 'fresh-frame'` 即使 `fresh:false` 也会因 kind 名把 media 置 `live`。
10. 「刷新画面」把 `_paintDecodedBaseline` 设成旧 PC 累计 `framesDecoded`，新 PC 从 0 计，`framesDecoded > baseline` 永假，出画了也不进「已连接」。
11. Host stall SPS refresh 默认 `armed=True` 且 `_stall_decoder_refresh_at=0`，冷启动 `fps=0 && framesReceived>0` 会在首帧前拆编码器。
12. `onPeerConnected` 的 2s DC wait `setTimeout` 不保存、`markRefreshSettled` 不清，旧 timer 会把新一轮 `_refreshing` 提前打成 false。
13. 非强制 `refresh()` 只看 3s 冷却，不看 `_refreshing`；进行中的重建仍可被第二条路径 `pc.close()`。
14. v2 `RemoteKeyboardState._apply_key` 只用已按下 code 算 mask，丢弃 `payload.modifiers`；`6610705` 的 reconcile 只在未被生产调用的 `_handle_keyboard`。Ctrl/Cmd keyup 丢失后后续字母仍带 phantom chord。
15. DataChannel `on_close` 捕获开通道时的 lease 快照；grant 不重建 PC 时 snapshot ≠ 当前 binding，跳过 reset，或用旧 epoch 得到 `stale-lease` 不放键。
16. 多份 active 设计/计划仍写「待实施」，需求文档第 5 节与 3.4/README 的正式入口口径冲突；relay jitter 终态 0ms 与 8/11 设计 80ms、README「≥1s 卡顿」与 2s/3s SLA 不一致。

目标：让手机触控和虚拟键走同一条已有 v2 lease 路径真正可用；可靠桌面写入与键盘一样“发送成功才占号、执行成功才提交、lease 失配仍释放按钮”；断连后能切模式重连；文档状态与代码一致。

非目标：不新造第二套移动协议或 lease；不重建 Cloudflare tunnel；不重开 8/29 定时 SPS 或 80ms↔0ms jitter 试验链（终态保持 pin 0ms + same-size refresh + 12s cooldown，只修冷启动误触发和文档）；不承诺真机/公网物理验收 PASS；不抽取 Terminal SocketTransport。

## 2. 方案

采用“主路径契约修复 + 假绿测试替换”，按依赖顺序修，不并行改协议。

### 2.1 触控坐标与虚拟键命中

`Input.bindTouchAdapter` 的 `mapPoint` 必须把真实 PointerEvent 的几何交给 `getRelativeCoords`，禁止 `{ ...event }`。允许的接法只有：

- 传入原 event，并保证 `currentTarget` 为绑定元素；或
- 显式拷贝可枚举+原型几何：`clientX`、`clientY`、`pointerId`、`timeStamp`、`button`、`buttons`、`pointerType`。

双指 centroid 已自造 `{clientX,clientY}`，保持不变。

`#mobileKeySurface` 及其 `.mobile-key-btn` 必须 `pointer-events: auto`，与 `.action-bar`/`.control-bar` 同级恢复命中。不得让点击落到后面的 `#remoteVideo`。

测试必须用 `new PointerEvent(...)` 或带不可枚举 getter 的假事件，禁止再用普通 `{clientX,clientY}` 对象冒充主路径。

### 2.2 可靠桌面写入

Viewer `Input.sendInput`：

- `move` 继续无 `seq`。
- 其它 mouse/command：仅在 DataChannel 或 Socket 真正接受后才 `++_desktopWriteSequence` 并把该 seq 写入 envelope。
- 发送失败返回 `null`，不得留下空洞。
- 无 transport 的可靠写入不得进入 `LatencyMonitor` pending map。

Host `ReliableDesktopWriteState` / `InputHandler.handle_input`：

- `down/up/wheel/reset/command` 必须在 Quartz/`_handle_command` **成功返回后** 才提交 `last_applied_seq`。
- `move` 仍 `unordered`，不占号。
- `monitor is None` 的 mouse 不得 ACK `applied`。
- `host.py` 在 lease 失配时对 mouse `up/reset` 必须绕过 write-state 直接 `release_all_mouse_buttons` 或等价 Quartz 释放，不能再进 `apply()` 被 `stale-lease` 丢掉。
- `on_offer` 在 `transition_keyboard` 成功后必须 `transition_desktop_writes`；失败则拒绝该 offer binding。

`sequence-gap` / `stale-lease` ACK：Viewer 对 mouse 不得把 gap 当成功；应保持或重建 pending reset，并在 lease 重获时清屏障、seq 归零。

### 2.3 Mouse reset 屏障与 ACK 隔离

- `acceptMouseAck` 只处理 `inputType === 'mouse'`（缺省且带匹配 reset id 的旧 Host 可兼容为 mouse）。
- 键盘 ACK 不得清除 `_pendingMouseReset`。
- reset 发送失败：`_pendingMouseReset=true` 且 `_pendingMouseResetId=null` 时，**下一次成功的 ACTIVE lease**（`setControlLease` 换到新的有效 lease）必须清屏障。
- 发送成功的 reset 仍等 `applied/duplicate` ACK；`stale-lease/sequence-gap/execution-failed` 保持屏障。
- 删除或改写 `webrtc.test.js` 里“keyboard ACK 清 mouse reset”的假绿断言。

### 2.4 断连网络恢复与 loading 遮挡

- `setNetworkMode`：Socket 已连接则走现有 `refresh({ reason: 'manual-mode-switch' })`；Socket 断开则必须走标准信令重连（现有 `init`/connect 路径），不得只 `beginConnectionAttempt` 后停在 `signaling` 且 Start 被关掉。
- `canConnect` 在 `disconnected` 保持 true，避免切模式后用户无法点开始。
- `#loading`：仅 `uiPhase === 'signaling'` 可拦截视频层；`disconnected`/`media-pending`/`connected`/`media-stalled`/`idle` 不得让未 hidden 的 overlay 吃 pointer。`streamReady === false` 时输入仍 fail-closed。

### 2.5 媒体暂停与 session 真相

- `applyMediaActivity` 暂停路径只 `setActive(false, { resetKeyboard: false })` + `releasePointer`；禁止再调 `resetKeyboard('media-suspended')`。需要清本地 pressed 且 DC 已死时用 `parkKeyboard`。
- `setUiPhase('connected')` 不得用 `event: 'fresh-frame'` 冒充 fresh。只有 `hasPaintedFrame === true` 才 `applyMedia({ event: 'fresh-frame', fresh: true })`；否则 `state: 'pending'`。
- `WebRTC.uiPhase` 继续作 DOM facade 缓存。`Input.setActive` 必须与 Chrome `canSendDesktopInput` 使用同一出画门槛：`uiPhase === 'connected'`（relay 0-FPS 需达到 `paintStallThresholdMs`，默认 2s）才保持桌面输入；`media-stalled` / `disconnected` / `media-pending` 立即 fail-closed。不得在每一次瞬时 `session.media=stalled` 采样上切断输入（≤2s 追帧是 TURN SLA）。`snapshot().canInput` 的 `media==='live'` 条件只用于「从未出画」；出画后的短卡顿以 `uiPhase` 为准。

### 2.6 刷新后 paint 基线与冷启动 SPS

`beginConnectionAttempt` 在新 PeerConnection 开始时必须把出画计数与旧 PC 切断：

- `hasPaintedFrame = false`
- `_paintDecodedBaseline = 0`
- `_lastInboundFramesDecoded = 0`（或与 baseline 同时清零）

新 attempt 的 `framesDecoded > baseline` 只与**本 PC** 的 inbound stats 比较。`requestVideoFrameCallback` 在 `videoWidth>0` 时必须能把 `hasPaintedFrame` 置 true，不能只 `markMediaAttemptReady`。

Host `_refresh_decoder_on_stall`：

- 初始 `_stall_decoder_refresh_armed = False`
- 只有出现过 `8 <= fps <= 25` 的健康样本后才武装
- `_stall_decoder_refresh_at == 0` 不得跳过 12s cooldown 去拆尚未出过稳态帧的编码器
- 冷启动 `fps=0 && received>0` 不得 `codec=None`

jitter 保持 HEAD 终态 `relay=0ms` / 非 relay `1ms`。8/11 设计改为记录该废止决定，不把 jitter 改回 80ms。

### 2.7 刷新互斥与 DC wait timer

`onPeerConnected` 在 `_refreshing && inputChannel` 未 open 时挂的 2s wait 必须赋给实例字段（例如 `_refreshDcWaitTimer`）。`markRefreshSettled`、下一次 `refresh()`、`disconnect` 都必须 `clearTimeout` 该字段。不得留下匿名 timer 去清下一轮 `_refreshing`。

`canBeginRefresh(reason)`：非强制 reason（不是 `manual` / `manual-mode-switch` / `manual-turn-switch`）在 `_refreshing === true` 时必须返回 false。强制刷新仍立即执行，但必须先清掉上一轮 DC wait / settle timer。任意 3000ms 窗口内恢复类 refresh ≤ 1，且 `_refreshing` 期间不得第二条 `pc.close()`。

### 2.8 v2 修饰键与 DataChannel close

`RemoteKeyboardState._apply_key` 必须把 `payload.modifiers` 当作浏览器权威状态：

- 计算 `desired_mask`（ctrl/shift/alt/meta）。
- down 非修饰键且当前 pressed 修饰码集合对应的 mask 有 desired 没有的 bit：先对该 family 发 Quartz keyup 并从 `_pressed_codes` 去掉，再 post 当前键。
- IME 导航键（Arrow*/Escape）不得带 phantom 修饰；与 legacy `_ime_nav_keys` 同一集合。
- 不得再依赖只被单测调用的 `_handle_keyboard` 作为生产路径。

`host.py` DataChannel close：

- `on_close` 必须用**当前** `_active_input_binding`（或 channel 仍是 `_input_datachannel` 时的 live binding），禁止闭包捕获开通道瞬间的副本作为唯一匹配源。
- reset 的 `lease_epoch` 必须是当前 active epoch；旧 snapshot 对不上时，只要该 channel 仍是 active input channel，仍要 `reset_keyboard` + `release_all_mouse_buttons`。

### 2.9 文档同步（本任务内必须做）

把下列 active 文档状态改成与 HEAD 行为一致，不得留「待实施」却已合入：

| 文档 | 目标状态 |
|---|---|
| `2026-08-30-mobile-remote-control-design.md` | 已实施；真机验收 NOT RUN |
| `2026-09-03-remote-desktop-input-diagnostics-stability-design.md` | 部分实施；本 spec 接管未完成项 |
| `2026-08-30-desktop-session-state-owner-convergence-design.md` | 已实施；双写残留由本 spec 收敛 |
| `2026-08-14-tab-resume-reconnect-loop-design.md` | 已实施；真机 tab-resume NOT RUN |
| `2026-08-15-viewer-chrome-layout-design.md` | 已实施；窄屏几何真机 NOT RUN |
| `2026-08-11-relay-input-stability-design.md` | 已实施；B1 终态为 pin 0ms（废止 80ms），并指向 8/29 SLA |
| `docs/需求文档/WebRemoteDesktop-需求文档.md` §5 | 正式入口 `https://link.stockhub.wiki`；`/tmp/wrd-safe-current-url.txt` 仅排障 |
| README / runbook 出画 SLA | relay：≤2s 追帧可接受，UI ≥2s 才「画面卡顿」，失败线 ≥3s；Host SPS 12s cooldown |
| 对应 plan checkbox | 已完成的步骤勾选；未跑的真机步骤保持未勾选并标明 NOT RUN |

本设计实施完成后，本文件状态改为「已实施」。

## 3. 错误处理与回滚

- 坐标映射失败：该 pointer 不发送，不得用 `(0,0)` 猜测。
- 可靠写入发送失败：不占 seq，调用方走既有 reset 路径。
- Host 执行失败：不提交 seq，ACK `execution-failed`，不把 Quartz 半状态当成 applied。
- 回滚只撤本 spec 触及的 Viewer/Host/CSS/测试/文档 hunks，不碰 tunnel、TURN、SPS refresh、Terminal PTY。

## 4. 测试

必须新增或改写、且必须失败后再修：

1. 不可枚举 `clientX/clientY` 的 PointerEvent 展开后仍能 tap 出 v2 mouse down/up。
2. `#mobileKeySurface` 在 docks `pointer-events:none` 下按钮 `elementFromPoint` 命中自身。
3. 无 transport 的 mouse down 不增加 `_desktopWriteSequence`；随后成功的 down 仍是 seq=1。
4. Host：lease 失配的 v2 mouse reset 仍 `release_all_mouse_buttons`；offer 路径调用 `transition_desktop_writes`。
5. 键盘 `inputType:'keyboard'` ACK 不能清 `_pendingMouseReset`；lease 重获能清发送失败的屏障。
6. `setNetworkMode` 在 `socket.connected===false` 且 `uiPhase==='disconnected'` 时发起信令重连。
7. `applyCapabilities` 在非 signaling 阶段使 `#loading` 不拦截（hidden 或 `pointer-events:none`）。
8. 媒体暂停不调用 `resetKeyboard`。
9. `setUiPhase('connected')` 在 `hasPaintedFrame===false` 时 session media 不是 `live`。
10. `beginConnectionAttempt('refresh')` 之后，新 PC `framesDecoded` 从 0 增长即可 `hasPaintedFrame=true`。
11. Host：从未有过 8–25 FPS 健康样本时，`fps=0 && received>0` 不调用 `request_decoder_refresh`。
12. 未入账的 DC wait timer 在第二次 `refresh()` 后不得把新 `_refreshing` 清掉。
13. `_refreshing===true` 时非强制 `refresh()` 直接 return。
14. v2 KeyA down 在 Host 仍按下 ControlLeft、但 payload.ctrlKey=false 时，先释放 Control 再发 a。
15. grant 后不重建 PC，随后 DC close，仍发出 keyboard reset 且放掉鼠标键。

现有全量 `node --test`（web-client + signal-server）和 `pytest python-host` 必须保持通过。真机/公网标 NOT RUN。

## 5. 运行约束

不启动、停止、重启或重建 Cloudflare tunnel。需要本地验证时只动 signal-server/Host，并按 `docs/runbook-safe-startup.md` 报告运行时密码。提交只包含本任务文件与对应实现 hunks。
