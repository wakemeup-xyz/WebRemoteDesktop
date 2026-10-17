# M6：JPEG relay 槽位恢复与帧来源补充设计

日期：2026-10-17。状态：`5e6c26c` + `966890b` 已实现，独立 review/R1 通过；在 build `f5c2a9203e47f9e5` 完成公网 JPEG 85.034 秒、TURN 86.272 秒生命周期短测，均通过；后续 nullable 修复已部署为 `c30530f331a4def5`。另一场 TURN 连续性测试 93.094 秒即因信令 ping timeout 中断，长会话未通过；详见[真实验收](../reports/2026-10-17-live-acceptance.md)。本补充使用 brainstorming + writing-plans，继承用户已确认的连续规划流程，不重复索要分段批准。

上位约束：[媒体设计](2026-10-17-media-latency-design.md)、[控制恢复设计](2026-10-17-control-recovery-design.md)、[整改总设计](2026-10-17-reliability-latency-remediation-design.md)。对应[执行计划](../plans/2026-10-17-jpeg-relay-recovery-plan.md)。M6 补足真实验收发现的媒体活性、来源证明和观测缺口，不另建控制恢复器。

## 1. 已知事实与证据边界

生产身份由总任务记录为代码 `8e375fa`、网页 build `b73325b8166441a6`；文档核对时工作区 HEAD `e2275a5` 的差异为验收 helper。精确运行身份仍由部署记录核验。

- 公网 TURN 生命周期短测：93.816 秒、85 样本，暂停/恢复及随后 60 秒连续性通过。另一场 TURN 三小时尝试在 45 秒首次媒体未 ready，零有效样本，为 INCOMPLETE，不能合并为长会话通过。
- 公网 JPEG `/tmp/wrd-public-c5-media-tunnel-20261017a/{summary.json,samples.jsonl}`：48 观察、51.923625 秒；暂停/恢复 generation 2 成功，此后图像 load 序号停在 97，最终同 Viewer 时钟年龄 5434.5 ms，Socket connected、ACTIVE lease、inputAllowed=true，判定 FAIL。97 是 Viewer load 计数，不保证等于 Host frameId。
- Host 09:18:38.941–42.945 出现重复 pre-capture-backpressure，pending=2；09:18:44.842 收到 RTT 6876/6677 ms 的 ACK，晚于 collector 失败。不能说这次永久丢包，不能定位最初延迟发生在哪个 hop。loop 样本没有证明连续数秒阻塞；捕获/编码平均值也不是逐阶段完整分布。
- 实际 `_run` 离线反例：四次超时、零次新 capture、pending 不变；ACK 99 后 ACK 98 遗留 98；11 秒 ACK 移除自身槽位但不 wake/推进 watermark。它们证明独立活性缺陷，不证明本次网络触发原因。

原始诊断私有报告为 `/tmp/wrd-jpeg-stall-diagnosis.md`；版本化记录只保留有界脱敏摘要，不提交原始日志、凭据、屏幕、输入内容、地址或 leaseId。

## 2. 当前集成位置与方案比较

`python-host/host.py::TunnelRelayStreamer` 在占槽达到上限时等待 ACK，超时仅降 profile，不清槽；Signal `websocket/signaling.js` 使用 volatile 发帧；Viewer `webrtc.js::handleRelayFrame` 会替换未加载完成的图像。这意味着无 ACK 是正常可能事件，必须释放媒体槽位。

当前 Host 在 `start()` 重置 frameId，新 streamer 也重置 productionGeneration；仅检查本地 map 的 generation 不能隔离迟到 ACK。帧缺 attempt/media intent 来源，Viewer 只有可选 attempt 检查，然后用当前本地 scope 标记收到的帧，不能识别恢复后才到达的旧帧。

| 方案 | 结论 |
|---|---|
| 加大等待时间或改可靠 Socket 帧投递 | 会隐藏延迟或积累旧图，仍有 ACK 乱序及重启身份问题；不选 |
| 单个 ACK 精确释放 + 有界 TTL + 完整媒体来源 | 改动限于现有帧链路，可证明无 ACK 时继续生产；采用 |
| 累计 ACK 退休全部较早帧 | 可更快清理被替代帧，但增加累计语义；本轮不需要，TTL 足以处理无 ACK |

保留 volatile delivery，不保留/重发旧 JPEG，不重放不确定业务输入。无新依赖；不修改网络模式、TURN、URL、codec、用户分辨率策略或既有 Quality Lock。既有 JPEG profile downshift 是历史行为，不构成本轮新增降质授权；槽位超时修复不得新增降档触发，TTL 退休本身不调用 `step_down_profile`。

## 3. 槽位与 ACK 契约

固定 `RELAY_FRAME_SLOT_TTL_MS = 2000`，使用 Host monotonic。它是缺失媒体反馈的资源持有期限，不是网络 RTT SLA、可见时延或自动降质门槛。当前 profile 的一/二槽上限保持；退休释放的是元数据，不排队历史 JPEG。ACK 等待仍沿用当前 0.35–1.5 秒的等待上限，每次等待超时和每次准入前调用退休，不能只在有新帧后清理。

`expire_inflight(now_ms) -> int` 删除 `now_ms - sent_at_ms >= 2000` 的当前槽，增加累计 expired，释放即 set ack_event。有效 matched ACK 无论顺序，先精确 pop 对应槽并 wake，再 `last_acked_frame_id = max(old, frameId)`。高水位只作进度统计，不决定槽是否可释放。ACK 处理前先退休过期项，因此 >= TTL 的 ACK 不进入 RTT/质量样本。过期、重复、未知、错误 scope 的 ACK 无业务副作用，不恢复旧槽、不提升 ready、不更新有效 RTT。无需无限 tombstone；统一计 unmatched，不能假装能区分所有过期与重复原因。

发送失败立即移除该槽并 wake。pause/stop/scope 变更清空槽并使在途 worker 结果失效。`_run` 的等待、capture 前后及 emit 前均核验当前 scope，单 worker/一个执行+一个最新请求及 M3 缓冲上限不变。测试假时钟下零反馈仍可连续生产新的不同帧且 map 不超过现有 cap；任务取消不能冒充原生 worker 已终止。

## 4. 媒体来源身份

新增媒体协议字段 `relayFrameSchemaVersion: 1` 和 `relayScope`，不占用既有控制 lease envelope 的 `schemaVersion`。scope 固定字段如下：

```js
{
  producerId: 'opaque-random-nonce', // 每次成功 start 重新生成 UUID；不复用实例计数
  productionGeneration: 1,         // start / suspend / resume 的本地 generation
  connectionAttemptId: 'attempt',  // 已认证且绑定的实际 authority
  mediaGeneration: 2,             // 已验证媒体binding；首次ordinary start合法值为0
  leaseEpoch: 3                    // 当前 authority epoch；不发送 leaseId
}
```

字符串为非空有界 ASCII（producerId 最多64，attempt沿用既有限制最多128）；mediaGeneration为非负安全整数（允许首次0），productionGeneration和leaseEpoch为正安全整数，bool/NaN/Infinity/空值拒绝。nonce 仅用于不碰撞的媒体身份，不新增认证机制。scope 在捕获提交时固定，不能在回包/转发时补成最新值。

**首次及普通start握手是独立必达路径。** 当前 `startTunnelRelay→emitRelayStreamControl` 的ordinary start不带mediaControl，首次controller generation为0；`replayMediaActivityIntent`拒绝0，Host `on_connection_attempt_bind`却合法建立active generation 0。保留该约定，不强迫controller伪造一次pause/resume。strict ordinary start新增 `relayFrameSchemaVersion:1, relayStartRequestId, connectionAttemptId, relayMediaGeneration`；relayStartRequestId为每次真实start创建的非空随机ASCII nonce（≤64），relayMediaGeneration取当前真实媒体generation（可为0）。不添加 `state/generation/mediaControlSchemaVersion` 使它误入正generation媒体控制分支。

Viewer仍先 `bindCurrentConnectionAttempt`，随后发送ordinary start，并保存 `{socket,leaseEpoch,attempt,relayMediaGeneration,relayStartRequestId}` 当前pending start。Signal保留ordinary路径的既有lease授权、验证已绑定attempt和字段边界、原样转发；它不从客户端请求生成authority。Host ordinary `on_relay_stream_control` 在既有媒体锁下核对当前authority、active `_media_activity_binding` 的viewer/attempt/generation与请求相等，再为start绑定该实际scope，await后复核authority/owns_relay及当前请求；失败不ACK applied。`relay-stream-control-ack` 增加 `relayControlKind:'start', relayStartRequestId, relayFrameSchemaVersion:1, relayScope`，沿用state active、generation=实际mediaGeneration、connectionAttemptId、applied字段。Signal现有白名单及双route均保留新增字段，不调用媒体generation递增来伪装首次request。

**pending-start立即关实际门禁。** 当前 `startTunnelRelay→setUiPhase('signaling')` 本身不调用sync gate，同attempt restart/fallback可能仍持旧hasPaintedFrame、attempt-ready及Input.active。建立pending start时必须先清旧painted/ready、已接受relay origin及load证明，并同步关闭实际effective business gate；不能仅改UI文案或等待首帧timeout。沿用§5现有Input释放/reset屏障处理按住状态，不另建controller、不重放输入。start ACK仅确认producer scope，不能恢复旧ready：pending、ACK前、ACK已接受但新scope合格onload尚未发生三个阶段都不得发送业务输入。新onload只恢复媒体条件，仍须满足当前C3 keyboard/mouse reset屏障。

Viewer在 `handleMediaActivityAck` 最前面识别 `relayControlKind:'start'`：仅与当前pending start的socket、lease、attempt、generation及requestId全匹配且applied=true时接受scope，消费pending并保存已接受requestId使双route幂等；不调用要求正generation的runtime.applyAck，也不直接mark ready。第一次同scope合格onload才走现有markMediaAttemptReady/fresh-frame/input gate。旧start ACK、scope缺失或错误、被替代start、suspend后旧ACK都不能采纳；换socket/attempt/lease、暂停或stop清pending。普通start进入tunnel fallback、同attempt重新start也走此握手；只有generation与Host当前active binding一致才可成功，不能把旧gen0复活到已经暂停/更新的generation。generation≥1的显式media control继续下面既有runtime ACK路径。首帧期限仍沿用现有有界失败/恢复入口，不新增无限请求重试。

Host `_apply_tunnel_media_control` 在已验证 authority 下把 attempt/mediaGeneration/leaseEpoch 绑定 producer；pause/resume 与 start 的身份更新在提交 worker 前完成，保留现有 authority/owns_relay 二次校验。成功 `relay-stream-control-ack` 附带当前 scope；Signal 现有 ACK 白名单和双路转发都保留该字段。Viewer `handleMediaActivityAck` 对显式media control只有在既有 runtime 接受对应当前 request ACK 后才记住期望 scope；ordinary start使用上面的独立匹配规则。同一个成功 ACK 双路到达必须幂等。suspended、attempt/socket/lease变化与停止清掉期望 scope、watermark、图像回调和 freshness timer。

严格路径 frame 必须与已接受 ACK 的完整 scope 相等；先校验再更新 frameId watermark/创建 object URL。ACK 前到达的帧直接丢弃，不把它缓存为恢复证明；Host TTL 会允许下一帧。`onload` 再次核验完整 scope、图像请求 token 和当前 Socket，再更新 ready/freshness 并发送 ACK。图像请求 token 防止同 scope 旧 onload 在新图替代后误报成功。ACK 原样 echo frameId、relayFrameSchemaVersion、relayScope，同时保留现有当前 lease envelope；删除 renderedAt/latencyMs 的跨钟计时依赖。

Host `on_relay_frame_ack` 不只检查 viewerId：沿用 authority/lease 的校验，核验 scope 与当前 producer 完全一致后才调用 `ack`。Signal 发帧、反馈与 ACK 均保留实际来源，按现有主 Viewer/companion 所有权路由，绝不通过转发补 current scope。新增严格字段只在严格路径强制；现有 legacy companion 的旧 frame/ACK 仍走有界 TTL 和精确释放，不能被现代 strict Viewer 用作 resume/ready 证明。新 Viewer 遇到不支持来源身份的旧 Host，保持媒体未验证/输入关闭并显示刷新升级提示，不能静默降级 strict 证明；现有 legacy admission 约束不放宽。

## 5. 稳态 JPEG 新鲜度与输入门禁

现有 `canEnableDesktopInput` 检查控制权、manualDisconnect、媒体 phase 和 attempt-ready；`syncDesktopInputGate` 还检查 uiPhase connected、hasPaintedFrame、Socket。WebRTC `notePaintStats`/`processStatsSnapshot` 有 stall 逻辑，但 tunnel 当前只按收帧累计平均 FPS，缺稳态图像 load age 检查。resume timer 仅覆盖 resuming，无法发现成功恢复后二十秒才停帧。

在现有 Viewer adapter 增加一个每个当前 scope 至多一个的 freshness timeout；已验证 `onload` 用 performance.now 记录本机时间，定时器在最后 load 后 5000 ms 检查同 scope。desired active、非健康抑制且 age >=5000 时设置既有 `media-stalled`，关闭输入；保留 lease，不回放业务输入，不新增 controller，不自动 refresh/换模式/改质量。scope、suspend、disconnect、stop清 timer；重复 stall不反复 reset。下一张同 scope 合格 onload恢复 connected并重走既有门禁，不能仅因收到 frame/ACK/统计回包开输入。

**按住状态必须安全释放。** 源码 `Input.setActive(false)` 在有 activeControlLease 时默认只 `releasePointer`、不 `resetKeyboard`，因此单独 `syncDesktopInputGate()` 不足。首次 stale 转换先 `Input.setActive(false, {resetKeyboard:true, reason:'relay-frame-stale'})`，再同步门禁；其 `releasePointer` 走现有 `_sendMobileSurfaceReset`/`_pendingMouseReset`，键盘走现有 `keyboardController.reset` 和 C3 reset ACK 屏障。如果 Input 已 inactive 但键盘仍有 pressed/RESET_REQUIRED，则显式调用已有 `resetKeyboard` 一次，不能依赖 active→inactive 分支。新图只恢复媒体允许条件，不清 keyboard/mouse pending reset，不伪造 applied ACK；失败/超时继续遵循现有 blocked/uncertain，不允许下一批业务输入。测试须覆盖 fresh frame 先于 reset ACK 到达时仍不能输入、匹配 ACK 后恢复，防止丢弃 keyup 留下原生按键卡住。fresh-frame `setActive(true)`可能触发现有 `_maybeAutoRecover` 并更新C3 reset身份；回归必须断言effective business gate及实际发送结果，匹配当前 `_recoveryCycle` / `_captureKeyboardReset()` 和mouse pending IDs，旧reset ACK不解锁；不能假定首次reset ID始终有效。已inactive、reset失败及timeout均需保持现有屏障，不能靠直接清barrier让测试通过。

5秒只用于 JPEG 稳态门禁，与本轮实际 collector 的阈值一致；first-frame和resume继续使用现有有界恢复计时。timer受浏览器调度延迟影响，诊断报告实际执行时间与超限年龄，不能宣称浏览器被冻结时仍精确五秒关闭。指标称“JPEG 图像加载年龄”，不冒充 optical presentation 或 M2 captureSeq 因果 freshness。FPS按合格 load 的短窗口统计，不能把arrival/lifetime平均当持续播放证明。

## 6. 同钟 RTT 与有界观测

保留 Host `relay_ack_duration_ms(sent_at_ms, now_ms)`；只有未过期、同完整 scope、首次 matched ACK 可成为 `relayFrameAckRttMs`。样本先被2000ms槽TTL右截断（实际有效值严格<2000ms），再被每反馈间隔只保留最新样本筛选。此 RTT 包含媒体转发、浏览器解码/调度及 ACK 回程，不称单向网络或输入可见延迟；p50/p95仅描述这两次筛选后收到的样本，不能表示全路径总体延迟，也不能证明没有多秒stall。

新增 Host→Signal→Viewer `relay-frame-feedback`，Host 每 scope 最多每秒一次，携带 `relayFrameSchemaVersion:1, relayScope, viewerId, feedbackSequence` 及最近一个尚未发送的有效样本 `{sampleSequence, relayFrameAckRttMs}` 或 null；同秒多个样本合并为最后一个。反馈明确白名单字段：pendingCount、oldestPendingAgeMs、expiredCount、unmatchedAckCount、timeoutCount、coalescedCount、lastSentAgeMs、lastAckAgeMs。coalescedCount在一个尚未发出的合格样本被更新合格样本替换时+1，null心跳不增加；其他计数分别统计槽退休、无法匹配的ACK、等待超时，全部为完整relayScope建立后的累计值，scope变化归零，安全整数饱和，不跨scope相加伪装完整会话。feedbackSequence与sampleSequence同样每完整scope从1递增，seq即将超过安全整数时停止该观测并报告不可用，不能重复使用。年龄全部在 Host 同钟计算；未发生为 null。feedback tick 接入 `_run` 循环准入/等待后共同路径，使背压时也发，不能放在只 capture 成功才运行的分支；不额外创建逐帧 task。

Signal 仅当前 Host 可发、只给当前 owner且白名单转发；Viewer只有当前 socket和已确认scope可收，feedbackSequence与sampleSequence分别高水位去重。使用现有 LatencyMonitor.recordStage，以 Viewer 收到时作为本地采样时间、完整现有 collector scope调用。collector generation来自connectionAttemptSequence，可能在媒体resume/producer重建时不变，因此sampleKey必须包含完整relay来源及sampleSequence，不能只用seq或截断字符串：规范数组 `[producerId,productionGeneration,connectionAttemptId,mediaGeneration,leaseEpoch]` 的JSON以Web Crypto SHA-256得到64位hex摘要，key为 `relay:<digest>:<sampleSequence>`，最长87个ASCII字符，符合collector的128字符上限。每次采纳origin只计算一次摘要；异步完成后重新验证socket/origin仍当前；不可用则只此metric保持unavailable，不能降级为碰撞key。

同collector scope内已经合法记录的旧producer样本保留到原5秒窗口到期，不重置全collector或丢弃其他输入指标；当前producer UI的last值只来自当前origin的新反馈，接受新scope时清该UI缓存为未测量，不能直接展示collector中旧producer的last。新旧origin的sampleSequence=1均须能被真实collector接纳；同origin重复及晚到foreign origin不得进入。5秒年龄表示距Viewer收到反馈的时间，不证明当前图像fresh；图像门禁独立使用onload时间。报告同时附expired/unmatched/coalesced计数及其scope，明确TTL右截断和最新合并人口；null、不匹配、重复、过期样本不能写0。stall摘要反馈不包含截图、坐标、payload、leaseId或长期frame ID列表。

移除 `Date.now() - data.timestamp` 的 UI、ACK质量输入及“延迟约”文案。使用已有指标展示入口显示“JPEG反馈往返”，缺测显示未测量；若共享顶栏只能显示数值，关联label/title/状态说明仍明确 RTT 边界。Host wall timestamp 可兼容保留为日志时间，但不参与延迟。对跨机时钟偏移 ±1天的测试，RTT展示和质量决策必须不变。

## 7. 验证与完成标准

离线必须调用实际 `_run`、Host控制/ACK handlers、Viewer `handleRelayFrame`/`handleMediaActivityAck` 和 Signal真实注册的事件handler；只测纯helper或静态字符串不能完成M6。测试包含无ACK、volatile丢帧、乱序、替代onload、过期ACK、失败emit、暂停/恢复、重建producer编号重用、旧socket/旧attempt/旧lease、ACK先后顺序、背压期间反馈、计数/内存/定时器上限、Quality Lock与用户选择不变。

上线必须按既有服务技能读 README/runbook，只重启已授权本地 Signal/Host，绝不重建 tunnel；证明部署代码/build相同，回报密码仅来自运行配置。重跑同公网JPEG暂停/恢复+完整60秒后续，0次>5秒load gap、scope证明有效、无自动换模式/降分辨率新行为。失败、首帧未ready或提前退出不能通过。随后按上位计划分别完成长会话；TURN、JPEG及物理输入/光学因果独立记录。短测通过不关闭三小时或物理输入 NOT RUN 项，原FAIL保留。
