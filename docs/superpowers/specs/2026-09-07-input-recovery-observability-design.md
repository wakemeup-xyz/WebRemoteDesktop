# 暂停恢复后的输入连续性与脱敏链路诊断

日期：2026-09-07。状态：设计已自审，按用户授权进入开发；尚未部署。

## 1. 目标与证据

修复普通鼠标/实体键盘在失焦、隐藏、媒体暂停再恢复后，被移动输入 surface 不确定性永久锁住的问题；为再次发生的现场故障留下足以区分本地拦截、发送失败、Host 拒绝及 ACK 丢失的证据。

依据：[本轮诊断报告](../reports/2026-09-07-overall-completion-and-resume-input-diagnosis.md)。基线 `39fa1ea` 的 Viewer 离线套件通过，但跨模块探针存在四个反例：所有 ACK 都能到达，仍可出现 `isActive=true / keyboard=READY / surface=uncertain / hasPending=false`，新点击和按键均未发送。证明的是充分原因，不是每次现场故障的排他归因。

约束继续以当前需求文档和代码为准：媒体恢复仍要求当前 attempt 的恢复确认与新帧；Terminal、手动暂停、只读控制不被本次修复绕过。

## 2. 设计取舍

采用“当前会话安全复位 + 独立草稿保护 + 有界脱敏轨迹”。不采用恢复画面时直接清空所有 uncertain，也不把清草稿当作自动恢复手段。Input 继续拥有输入与恢复状态；采样、脱敏、哈希、队列限制集中在独立 `InputTrace` module，避免每条传输路径自行实现诊断规则。

两个状态必须分开：

| 状态 | 解除所需证据 | 不能做什么 |
|---|---|---|
| 原桌面手势结果不确定 / 按钮可能未释放 | 当前 lease/attempt 下，本轮拥有的 mouse reset 与 keyboard reset 均得到正向确认 | 新帧、READY、迟到旧手势 ACK、同 lease 重绑都不能直接清除 |
| 本地草稿或 IME 上下文不确定 | 保留内容，用户核对远端后明确放弃；保持现有安全重试条件 | 不自动重发、不伪造原手势已应用、不把 reset 当作文本已执行 |

无草稿时，安全复位成功后允许用户发起**新的**鼠标/键盘操作。存在草稿/组合输入时，保留编辑门禁及明确提示；安全复位只解决 Host 按住状态，不证明旧文本的目标焦点。

## 3. 输入恢复契约

### 3.1 所有者与身份

Input 新增 `getEffectiveInputGate()`、`requestInputRecovery({ source })`。前者返回只读 `{ allowed, blockedReasons, recovery }`，后者仅受理 `source: 'auto' | 'user'`，返回 boolean，绝不重放旧按键、文字、点击、滚轮。

恢复内部身份包含递增 generation、leaseId、leaseEpoch、`WebRTC.currentConnectionAttemptId`，以及本轮 mouse/keyboard reset 的 inputId 和 seq。raw leaseId/reset inputId 仅存在内存，不进入诊断快照。恢复状态为 `idle | waiting | recovered | failed`；诊断只导出 state、generation、reason、mouseConfirmed、keyboardConfirmed、retryAvailable。

reset 的确认必须同时满足：当前身份未改变、对应 reset inputId、正确 inputType/schema/epoch、`applied | duplicate`、appliedSeq 不小于本轮 reset seq，且真实传输 ACK 接收结果成功。拒绝 ACK 不得修改成功标记；同 epoch 但错误 ID、旧 generation、跨 attempt ACK 均不能解除门禁。

`KeyboardTransport.getPendingReset()` 是内部查询 seam，返回当前 reset 的 `{ inputId, seq, leaseEpoch }` 或 null，不放进公共诊断；可以认领同一当前 attempt 下仍在途的 barrier，避免重复 keyboard reset。复位 ID 必须来自实际接受发送的报文，不能猜测 seq 或依赖仅 READY 的快照。

### 3.2 生命周期与预算

普通 idle 失焦不额外创建 mouse reset。仅当 surface 不确定、mouse reset 未确认或已触发恢复时，启动双复位。触发点覆盖可见/聚焦恢复、Input 从 inactive 到 active、当前控制会话的 DC 可用性变化；只有媒体门禁已允许、页面可见且持有当前控制权时自动开始。正常指针/按键安全释放仍可跨媒体门禁发送。

一代故障最多一次自动恢复周期；周期 deadline 为 3000ms，重复 focus/visible/ready 回调不刷预算。mouse reset 若收到当前 ID 的 `sequence-gap` 且有可验证 appliedSeq，可使用现有 reconcile 结果仅重试一次**新的 reset**；不能重发旧普通写入。超时/拒绝/发送失败停止自动重试并显示失败原因。用户点击可再发起一个有界周期，不能并发；lease/attempt 改变撤销旧周期和计时器。

没有可用 DC 时，复位可经已连接 Socket 发送。两种通道都不可用时不宣称成功。keyboard transport 已 `reacquire-required` 时不得靠同 lease setLease 清序号伪造恢复；保留该失效身份，直到获得不同 lease/epoch。失败 UI 指引使用已有控制操作释放后重获控制；本功能不自动释放/夺取控制权或重建 PeerConnection。

`MobileTextInput.invalidateContext(reason)` 取消 drain、推进 generation、保留本地内容和 pending 状态，标记不确定；不能自动调用发送。`confirmEmptyContextRecovery()` 仅在没有 pending 和 composing 时清空旧 accepted history 并建立新的空上下文，返回是否成功。有草稿或组合输入时保持不确定，必须经已有显式 retry/discard 语义处理。lease 真正改变仍沿用现有跨租约清理策略，本任务不改变控制权撤销的数据隔离契约。

### 3.3 可达 UI 与实际门禁

新增 `inputRecoveryNotice`（`role=status / aria-live=polite`）、`inputRecoveryRetryBtn`、`inputRecoveryDraftBtn`。作为 body 下独立 fixed overlay，不放进 `statusBar`、`chromeDocks`、隐藏 mobileDock；不占布局、不触发全屏 controls-hidden，不遮挡全屏退出入口。

只在异常恢复等待/失败或草稿阻塞时出现，正常 READY 时隐藏。展示真实拒绝原因，“键盘就绪”不能覆盖下游 surface/draft/viewport/recovery 否决。恢复按钮不抢走 Terminal/本地编辑框焦点，不把操作按键穿透给远端。草稿按钮只显式打开现有本地输入框供核对/放弃，不自动 discard。无触控设备亦可访问该草稿入口。

effective gate 汇总 lease、媒体/active、keyboard transport、viewport、surface、pending mouse reset、desktopWriteRecovery、draft/composing、恢复周期。新输入继续服从原入口规则；tracked keyup、mouse up/reset 不得被新门禁误伤。仅 hover move 可能仍可发送，不把它的状态等同可靠点击可用。

## 4. 有界脱敏诊断

### 4.1 路径与阶段

```text
DOM → Viewer gate → Viewer transport enqueue ─ DataChannel ─→ Host ingress → result → ACK
                                      └──── Socket → Signal ─────┘                 ↓
                                      Viewer ACK accept / reject / timeout ←─────┘
```

DataChannel 不经过 Signal；因此 Signal 无记录不能单独证明丢包。输入 enqueue 只表示本地接受排队；Host `applied` 表示 native adapter 返回成功，不冒充人眼看到系统效果。

InputTrace 在 critical bundle 中加载，早于 Input；Diagnostic core 持有同一 collector，deferred diagnostic 加载不能清除历史。接口：`InputTrace.create({ now, hashInputIds, setTimeoutFn, clearTimeoutFn, onIncident }) -> { record(stage, meta), snapshot() }`。所有参数可省略，时钟/计时器默认使用当前环境、onIncident默认为noop。record 不等待哈希或网络，不影响输入结果；DOM阶段返回新分配的eventId，其他阶段返回关联eventId或null。snapshot为 `{ schemaVersion: 1, events, counters }`。计时器最多一个，处理最近ACK deadline；onIncident只回传有限reason，Diagnostic core决定是否满足自动上报条件，回调异常不得影响输入。

stage 白名单：`dom-received, gate, transport-send, ack, ack-timeout, lifecycle, recovery`。DOM 记录分配递增 eventId，仅描述 keyboard/pointer/text/control 的类别和 phase；Input 将同步发送的 existing inputIds 映射到该 eventId，IME 延后发送使用单独事件关联，不虚构一一对应。

允许字段：eventId、stage、inputType、action、phase、transport、accepted、reason、status、seq、appliedSeq、leaseEpoch、connectionAttemptId、inputIdHash、inputIdCount、clientRttMs，以及本设计的有限状态字段。DOM额外记录 `focusKind: desktop | mobile-text | local-editor | terminal | other` 与 `visibility: visible | hidden`，不能把本地编辑/Terminal事件混算为远端输入尝试。类型/动作/原因/状态用枚举白名单，数值须 finite/有界，ID 格式/长度受限。禁止 key/code/keyCode、输入正文、payload、坐标、DOM label/value、完整 URL、token、password、raw leaseId、raw inputIds；不要只按字段名删几个词再任意扩展对象。

关联哈希保持 Host 现有算法：UTF-8 的 `inputIds.join('\x1f')` 做 SHA-256，取小写 hex 前16位。浏览器用 Web Crypto 异步计算；无 crypto 或摘要失败时填 null 并增加 unavailable 计数，不记录明文、不退回弱哈希。异步结果只回填仍在本 ring 中的原记录。最多64个待摘要工作，超过明确计数丢弃，不阻塞实际输入。

ring 最多256条且序列化 trace snapshot 不超过64 KiB；可靠输入 ACK 关联等待最多256个、最多10秒，独立时钟记录 RTT。高频 mouse move/wheel 只累加计数，不逐条创建记录/计算哈希。输出 `droppedEvents, sampledEvents, hashUnavailable, pendingHashCount, evictedPendingAcks` 等计数，不能把采样缺口推断为丢包。

可靠输入超过3000ms尚未确认时记录 ACK timeout；迟到 ACK 仍记录 late/stale 的实际接收结果，不把 timeout 当作一定没执行。Host 执行时间只用 Host 同一时钟区间，clientRttMs 只用 Viewer 时钟，不计算跨机器单向延迟。

### 4.2 故障快照与传输

`Input.getDiagnosticState()` 增加 effectiveGate、surface、draft（只有 composing/hasPending/deliveryUncertain/status）、viewport、recovery，保留 pendingMouseReset/desktopWriteRecovery/keyboard 的安全计数。自动和手动 `buildConnectionDiagnostic()` 使用同一 inputState 和 inputTrace；禁止只有手动发送才有输入快照。

失焦、隐藏、暂停、恢复、reset 发出/确认/失败留生命周期轨迹。页面可见、当前媒体允许且持有控制权，却因 surface/recovery 不确定拒绝用户新输入，或发生可靠输入 ACK deadline 时，调用已有 `Diagnostic.autoSendFailure()`；有草稿、只读、Terminal、手动暂停、正常 ACK 在途不是自动故障。继续复用每 attempt 15000ms cooldown 和现有有界离线队列，不添加轮询服务。

手动 `sendLogs()` 改用现有 `sendConnectionDiagnostic()`：复用已连接 Socket，否则带现有认证的 HTTP POST `/api/diagnostics`，失败入队。禁止创建临时 role=viewer Socket，避免 strict-single-viewer 踢掉原页面。成功提示须以实际发送结果为准。

Signal 对 inputState/inputTrace 做同一严格白名单和上限裁剪；既用于 Socket diagnostic，也用于 HTTP ingestion。默认事件摘要保留安全的最终 gate/recovery 和计数，不能只留 logCount 使故障窗口又丢失；沿用已有持久化开关/保留策略，不自动启用服务器持久化。

### 4.3 Signal / Host

Signal Socket input relay 增加安全的 hash/seq/epoch/transport 及 accepted/rejected reason；记录验证/控制授权拒绝，绝不改变授权或 ACK 协议。Host 在绑定/类型/校验拒绝处记录 `host_input_rejected`，在接受处记录 `host_input_received`；处理返回记录 `host_input_result` 并包含真实 status/appliedSeq/localExecuteMs，不继续用不含结果的 executed 事件代表一切成功。ACK 发送记录 accepted/transport；无绑定拒绝在 DC wrapper 留证据，但 keepalive 不记成人工输入。高频 move/wheel 保持聚合或采样。

这次不改变 v2 输入/ACK wire schema、不添加 traceId 到业务报文，不自动回 ACK 给未授权输入，不改变 Host Quartz 写入/lease 控制规则。

## 5. 验收与边界

- 原六个跨模块探针转为正式修复回归：两个正常对照保持；四个缺陷路径在本轮 reset 正确认后实际发送新的 down/up、keydown/keyup。
- ACK 顺序互换、迟到旧 ACK、错误 reset ID/epoch/attempt、失败/超时、重复生命周期、断 DC Socket 复位、双通道断、同/新 lease、草稿/组合输入、tracked keyup、Terminal/暂停/全屏均有负向断言。
- collector 的隐私金丝雀、ring字节/条目/哈希/等待上限、无 crypto、异常 callback、晚加载、cooldown/队列、固定 hash 跨 JS/Python 匹配均验证；无敏感明文进入 snapshot/日志。
- 真实模块离线集成、Viewer全量、Signal全量、Python输入/诊断回归、构建与离线Chromium点击/键盘/overlay验收。测试不能只是源码字符串匹配或内部状态=READY。
- 真机手机/iPad、系统 IME、Quartz实际效果、正式公网故障重现与 live watcher 本次不冒充已跑；不建立连接现有服务的新 Viewer、不操作现场控制、不启动/重启服务或 tunnel。
- 本次只交付隔离分支代码、测试、设计/计划/报告。main 合并、push、部署后现场复验是后续授权步骤。TURN、Terminal/watch 的其他缺口不混入。
