# 控制租约与断线恢复设计

> 执行状态更新（2026-10-17）：用户已要求完成开发、验收并保持本地服务可用，已进入实施阶段。下文“本轮仅文档／未来授权／全部 NOT RUN”等初稿状态描述保留为规划历史，不再限制本次已授权工作；实际完成、复核、部署与未运行项以[实施记录](../reports/2026-10-17-remediation-execution.md)为准。tunnel 禁止重建的限制继续有效。

日期：2026-10-17。状态：设计与执行计划交付，未实施、未测试、未部署。用户已选择 superpowers brainstorming + writing-plans 并授权直接完成文档与复审；本文件不授权生产操作。

本设计从属于[整改总设计](2026-10-17-reliability-latency-remediation-design.md)，以其 §3 全局约束和 §5 控制身份契约为准。实施入口是[控制恢复计划](../plans/2026-10-17-control-recovery-plan.md)。需求依据为[项目需求](../../需求文档/WebRemoteDesktop-需求文档.md)中的严格单桌面 Viewer、v2 输入、同页重连、双 reset 和当前媒体恢复门禁。

## 1. 问题、证据与范围

目标是让短暂信令中断、可靠 DataChannel 失联和 Host 异步完成都自动收敛到明确的可用或阻断状态，避免用户反复手工重新连接，也避免恢复过程中执行旧会话输入。

[综合诊断](../reports/2026-10-17-web-entry-screen-control-diagnosis.md)给出 R1–R11 的源码位置与离线复现。[72 小时证据](../reports/evidence/2026-10-17-three-day-review/signal-entry.json)固定覆盖北京时间 2026-10-14 02:15 至 10-17 02:15：可识别的 84 次 grace、5 次 rebind 尝试中 4 次 confirmed、1 次 rejected，以及 53 个 lease-expired epoch。早期结构化日志缺字段，不能把未识别事件当作没有故障。这些计数不是独立用户故障数，也不能说明全部由同一个缺陷造成。

R1 有直接时序佐证：10 月 16 日 19:44:33.584 rebind confirmed 后 2.644 秒即 lease-expired，早于 Viewer 原定 3 秒后的首个 heartbeat。R2、R5、R9 等竞态以离线可控 await/ACK 排序复现证明，不能冒充每次生产断线的已匹配原因。

| 任务 | 修复范围 | 必须改变的结果 |
|---|---|---|
| C1 / R1、R5 | rebind 续期、transition epoch | 已确认迁移获得完整续期；旧 grant ACK 不能确认新 reset |
| C2 / R2、R8、R9 | Host await 后提交、peer owner、attempt | 旧异步完成不覆盖新授权；新 grant 不静默复用旧 owner 的 PC |
| C3 / R3、R4、R6、R7 | 可靠 ACK 失联、失败 reset、自动 acquire | 不依赖 DC close 才发现失联；失败迁移等待 reset 后自动重新申请；不重放输入 |
| C4 / R10、R11 | 媒体恢复和 legacy companion | 新 attempt 的画面不能借旧 ACK 解锁；迁移未确认时 legacy relay 也没有写权限 |

不改变网络模式、TURN、公网地址、Quality Lock 或分辨率。网页入口、捕获/编码线程与真实可见延迟由 W/M 子项目处理。诊断字段不得成为控制授权输入。

## 2. 方案比较

| 方案 | 优点 | 问题与决定 |
|---|---|---|
| 延长 lease、grace、ACK timeout，连接失败后刷新整页 | 改动小 | 旧 ACK 与旧异步写回仍成立，失联更晚发现；不采用 |
| 一律断开旧 PC、清空所有序号、重新申请 | 流程表面简单 | 同租约清序号破坏幂等；每次短断都影响画面，可能重放不确定输入；不采用 |
| 在现有 lease/recovery/media 状态机上补身份校验与有界恢复 | 保留已有协议和同页连续性，回归可分阶段落地 | 需共同定义操作身份及异步提交；采用 |

采用第三种：同页、同租约且确认成功时保留 peer 与已确认序号；无法证明连续性时，走现有 reset → FREE → 新 grant → 当前媒体确认。不新增第二个恢复控制器。

## 3. 权威来源与不变量

Signal 的 `DesktopControlLease` 是控制权权威；Host 是输入 reset 是否真实完成的权威；Viewer 的 `Input._recoveryCycle` 是本页双 reset 的汇合点，`WebRTC.controlState` 和 `MediaActivityRuntime` 分别决定授权与媒体可用。UI 只消费这些状态，不自行置为 ready。

1. 每个新的 grant/revoke/reset-only 操作拥有新的、单调递增的 leaseEpoch。同一 reset 的重试沿用该 epoch。grant 变 reset 是新操作，必须新 epoch。
2. REVOKING 未获当前 reset 的 applied/幂等成功确认时不能变 FREE；超时、异常和旧 ACK 都不是成功。
3. rebind 必须匹配认证 session、当前 socket 对象、旧/新 owner、当前未过期 lease 和现有 attempt；Host applied 回调到达时再次检查。只有此刻可续期并发送 grant。
4. Host 控制操作先冻结旧输入，再 await；每次 await 后提交必须仍拥有原 authority revision 和作用域。过期完成不能清理新 PC、清空新 binding 或发送 applied ACK。
5. peer owner、active input、media/relay owner 不得在新 grant 下分别保留两个 Viewer。不同 lease 的新 grant 默认关闭旧 peer，重新 offer；正式同租约 rebind 是保留 peer 的唯一迁移入口。
6. reliable ACK 超时只证明投递结果未知。冻结新可靠输入、隔离实际发送的通道并 reset，不重发旧点击、文本、滚轮或命令。旧鼠标 up/reset 等安全释放仍按既有授权检查处理，不能成为普通写入旁路。
7. failed reset 不因 same-lease setLease 变成 ready。旧 pending ACK 不能确认新恢复屏障；无法确认归属时换新 lease，保留草稿但不发送。
8. 输入恢复须同时满足当前控制授权、当前双 reset（需要恢复时）、当前媒体 active ACK 与新帧、在线信令；缺任一证据保持阻断。

## 4. C1：迁移确认、续期与操作 epoch

保持现有 12 秒 lease、8 秒 disconnect grace、1500ms Host rebind ACK、3 秒 heartbeat。grace 只保留同页迁移机会，不延长已过期控制权。

Signal 可先把连接索引移动到新 socket，但必须把迁移 pending 作为所有写路径的共同门禁。将当前布尔 pending 配套为单个内部操作记录，至少保存新 socket 对象、Host socket 对象、lease identity 与现有 attempt、settled；不添加 wire 字段。替代 Viewer、Host 更换、socket 再断线、过期或 timeout 都使旧操作不可提交。

Host applied 后：先验证仍为当前操作且 lease 未过期，再用现有 `heartbeat({viewerId, leaseId, leaseEpoch})` 完成续期，最后清 pending 并 grant。`rebindViewer` 本身不续期；不得在收到重连或发出 Host 请求时提前续期。过期边界的 applied 回调走既有 reset，不能复活旧 lease。Viewer grant 后立即发送一次 heartbeat，再保留原 3 秒周期；多次 grant 不叠加 timer。

`beginRelease` 和 `viewerDisconnected` 遇到未完成的 candidate grant 时均调用新 reset transition，不把原 pending 原地改成 reset。重试器仅对当前 reset 操作重发，不增加 epoch。Host 以现有 payload 是否带 viewer/lease 区分 grant 和 reset；同 epoch、不同操作类型不再互相确认。

## 5. C2：Host 异步提交与 peer 所有权

### 5.1 内部 authority 接口

在 `WebRemoteHost` 内增加单调 `_authority_revision` 和当前控制操作的最高 epoch/类型/结果元数据。这是现有 authority 的版本戳与幂等记录，不是新的恢复状态机。提供：

```python
_capture_authority() -> AuthoritySnapshot
_authority_matches(snapshot: AuthoritySnapshot) -> bool
```

快照不可变，包含 revision、viewerId、leaseId/leaseEpoch、connectionAttemptId/Sequence、connectionGeneration；只存在内存，不输出原始身份。接受新控制 transition、正式 rebind、peer owner 或 connection attempt 变化时同步递增 revision。相同 owner 下的媒体需求 generation 单独校验，不因普通 media generation 更新无故取消有效输入。

最高 control epoch 只在同一已认证 Signal 连接生命周期内比较，不能永久跨 Signal 重启保留。Host disconnect 先递增 revision 并冻结旧工作；新认证连接在旧工作静止/reset 后开始新的 epoch 命名空间，revision 本身不回退。这样 Signal 进程重新从低 epoch 开始时不会永久被拒绝，旧连接遗留的 coroutine 仍无法提交。此边界用现有连接生命周期和内部对象身份表达，不新增 wire server ID。

控制/offer/media 的 await 前捕获 authority、目标 generation 与具体资源对象。await 后的无 await 提交段检查 revision、相关 identity 和 generation；单 event loop 下此段是原子提交，不在所有 native await 外套一把大锁。现有局部锁仍负责各自队列顺序，但不能替代跨 handler 的校验。

### 5.2 资源与 side effect

`on_offer` 在检查旧 lease 和 attempt 后才能处理 SDP。等待旧 peer close、keyboard transition、desktop transition、SDP 等每个阶段后都重新校验。旧任务只关闭自己捕获/创建的 PC、track、sender，不能调用会再次读取 `self.pc` 并关闭新对象的通用清理。不能只在最终赋值前 CAS：已经启动的输入 adapter 绑定和 producer 也必须有 scope fence，或在确认静止后才允许新 grant。

媒体 resume 的 fresh capture 返回后必须仍匹配原 attempt、sequence、media generation 与 authority。过期返回不更新 `_media_activity_binding`、sender、capture 状态，也不发送 applied 成功。

新 grant 与现存 PC lease/owner 不同时，先冻结并安全关闭旧 peer，再完成当前 grant。Viewer 为 PC 保留其建立时 lease identity 的内部元数据；不同 lease grant 到达时沿现有 PC teardown/createOffer 路径重新协商，不能因 `connectionState=connected` 而跳过。正式 same-lease rebind 保留原 PC、attempt 与序号。两端 metadata 只附属于现有 PC，不形成第三套会话状态。

### 5.3 与媒体/背压子项目的边界

M3 的输入队列在 dequeue 和完成后的业务提交时调用 `_authority_matches`；队列不能自行建立 lease。容量冻结走已有恢复路径。控制 reset 先递增 revision、冻结旧授权，再调用 M 的 `reset_after_quiescent(old_scope, apply_reset)`；`apply_reset` 包装现有 `_reset_keyboard_lifecycle(reason)` 及桌面释放。只有旧 in-flight 已完成或被可证明安全隔离，reset 才可返回 applied；不能把 timeout 当隔离完成。返回沿用 `{status: 'applied' | 'rejected'}` 语义，C 再核对当前操作才 ACK。M 未实施时，C 仍须通过已有 adapter 队列/序列屏障证明同样的静止条件，不依赖未来模块才能成立。

## 6. C3：可靠输入失联与自动收敛

### 6.1 检测与通道隔离

沿用 `KeyboardTransport.pending` 与 `Input._desktopWritePending`，分别保留一个最早未确认可靠写入的 deadline timer，默认使用现有 3000ms ACK 预算。pending 记录发送时 scope、实际 adapter/DC 对象、提交时间；ACK 累计推进只删除同 scope 的已确认项并重排 timer。键盘 key/text/batch、可靠桌面 wheel/command 与 down/up 都覆盖；不把 unordered move 纳入可靠 ACK 门槛。

过期后通过现有 recovery 入口通知一次，冻结该 scope 的新可靠写入。只有实际承载该 write 的当前 DC 才被 quarantine；Socket 超时不隔离未承载写入的 DC，旧 DC 超时不隔离新 DC。利用已连接 Socket 发送当前身份的双 reset，保留现有 sequence-gap 的一次受限 reset 重建机制。超时或双链路不可用时进入已有失败 UI；恢复 budget 不由 latency monitor 的统计窗口驱动。

普通可靠写入失联可启动一次现有自动双 reset；reset 自身失败则升级为一次 release/reacquire，不在同 scope 无限发 reset。scope 改变、成功 ACK、释放、dispose 都取消 timer；挂起页面 timer 迟到仍必须先验证 scope。

### 6.2 失败迁移后的唯一 acquire 发起者

自动 acquire 由 Viewer 的现有 `requestControl` 路径发起；Signal 不另建自动申请器。在 `_controlAcquireRequestId` 周围保留一个有界 intent（当前 socket、故障/恢复代次、最后观察 reset epoch、已用预算）。同页 reconnect 自动申请若遇 GRANTING/REVOKING 或 rebind pending，保留 intent；Signal 为认证当前 Viewer 的 pending acquire 返回现有 acquire-result 字段 `state/reason=reset-in-progress`，不静默丢弃，也不放宽输入授权。

只有当前 socket 收到权威 `control-state: FREE`、Host 在线、页面未 superseded/主动 release、reset 未 blocked 时，消费 intent 调用一次 `requestControl({allowTakeover:false})`。同一故障代次至多一次自动 dual-reset 和一次 release/reacquire；重复 FREE、active/visible 回调、迟到 result 不补充预算。新 grant 成功才终结本次 intent；socket 再断、用户释放、Host 更换或 superseded 取消它，后续新连接重新建立一次 intent。没有 FREE 时保持阻断，不用本地 timeout 假造 FREE。

### 6.3 same-lease 与 ACK 归属

成功 rebind 可以继续已确认 seq，但仅在没有失败屏障且旧 pending 的确认路径仍明确时复用。每个 pending/reset 记录发送 socket/attempt/lease 与通道。跨 socket 的旧 Socket ACK 不重定向；归属无法确认的旧 reset 废弃，当前恢复用新 reset；如键盘 transport 已为 reacquire-required，不能清零同租约序号，直接走 release → 当前 reset ACK → FREE → 新 lease。

旧 ACK 即使携带更大 appliedSeq，也不能完成新 reset；双 reset 各自的 inputIds、seq、epoch、attempt 和恢复 generation 必须匹配。草稿、用户确认式重试及既有手工释放/重新申请入口保留。

## 7. C4：媒体与 legacy 旁路

`beginConnectionAttempt`、控制身份更换及媒体请求 generation 切换时，清除旧 `_mediaResumeFramePending`、baseline、relay frame 缓存中用于恢复的证明和 fallback timer。恢复证明记录当前 active ACK 的 attempt/generation/lease epoch 与 PC/relay 身份；`observeFreshResumeFrame` 只有在该证明匹配当前 MediaActivityRuntime 且帧晚于同一 baseline 时才能解锁。允许同 scope 下新帧先到、ACK 后到的已有合法排序，不跨 attempt 复用。

Signal 的 legacy companion 必须与主 Viewer 共用 `isActiveViewerSocket` 的迁移门禁，覆盖 companion 绑定、stream start/control、frame 和 ACK 路由。pending 时不能启动 producer 或转发其帧。reset/rebind failure 清理要针对实际已启动 producer 的旧 owner，而不是只查已经搬到新 socket 的索引；只通过可信 Signal reset/cleanup 通知停止旧 producer，不授予 companion 输入权限。

Host 的权威 reset 路径负责停止捕获的旧 relay producer，并以 C2 的 revision/对象身份保护 stop 后提交；不能让旧 companion 自发 stop 绕过 owner 检查，也不能让旧 stop completion 清理新 producer。

## 8. 兼容、回退与可观测性

默认没有新 wire 字段，继续使用现有 lease/epoch、attempt/sequence、generation、seq 和状态。新逻辑要保留 v1 adapter 的严格单 controller 与 reset；旧 Host 不支持 rebind ACK 时仍在 1500ms 后退回正式 reset/new grant。不能因为兼容而接受同 epoch grant/reset 混用或无身份输入。涉及这一语义的 Signal/Host/Viewer 作为同一发布单元验收；混合版本只能维持 fail-closed，不能承诺完整自动恢复。

生产加载必须等用户授权维护窗口，沿 runbook 操作本地服务，不能碰 tunnel。回退选择已验证、三端匹配的版本组合；已知坏版本不能通过关闭门禁恢复可写。运行中 reset-blocked 时保持阻断，等待手工恢复或受控部署，不自动重启。

保留/补齐有界事件：rebind requested/confirmed/rejected/timeout、transition kind/epoch/outcome、authority stale-completion、reliable ACK timeout、recovery budget exhausted、auto-acquire resumed/cancelled。日志只保留关联摘要、epoch、类别、有限 reason 与本地耗时；不落 session/socket/lease/input 原始 ID 或输入 payload。计数须区分尝试与独立恢复事件，监控失败不能改变控制状态。

## 9. 验收与交付边界

计划中的 fake clock、受控 asyncio Event 和真实模块桥接测试必须覆盖 R1–R11；尤其不能手工补一条生产中不会自动发出的 acquire 来掩盖 R4。R2/R9 必须真的暂停 await 后交错新 authority，而不是只测辅助比较函数。重复/乱序/丢 ACK、旧 socket 再断、被新 Viewer 顶替和 Host 替换全部 fail-closed。

未来离线通过后，再在维护窗口按 direct、TURN、显式 tunnel 分别验收，保持原网络/画质选择；每条路径记录短断、半开 DC、reset失败恢复、长会话不少于 3 小时。业务 ACK 延迟与真实可见效果分别报告，具体性能门槛服从总设计。

当前只交付设计及计划：源码修改、定向测试、构建、真实 Viewer、设备输入、公网和长时间验收均 **NOT RUN**。
