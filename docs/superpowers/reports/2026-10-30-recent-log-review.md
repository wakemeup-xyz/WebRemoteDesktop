# 最近几天日志复核：连接、媒体与控制恢复

日期：2026-10-30（Asia/Shanghai）。本轮只读分析，没有重启 Signal/Host，没有清理 Viewer，没有操作或重建 tunnel。证据快照写入[summary.json](evidence/2026-10-30-recent-log-review/summary.json)。日志仍会追加，本文数字只代表该快照，不能当作永久实时计数。

## 结论

当前问题不是一个单一的 Host CPU 故障，而是四条链路叠加：

1. **Tunnel 存在真实的生命周期中断。** 快照中多次出现 `SIGTERM` graceful shutdown，再过约六分钟重新启动并重新注册四条 HTTP/2 边缘连接。这足以解释 tunnel 进程不可用窗口，并支持公网不可达假设；没有逐时 edge 全断的独立证据，不能把每个窗口都宣布为完整公网 outage。SIGTERM 来源也未确定，当前证据不足以归因应用代码或排除 supervisor。本轮没有按约束重启或重建 tunnel。
2. **控制租约经常先失去应用层心跳，再出现 Engine.IO ping timeout。** Signal 记录59次 Viewer socket断开，其中43次 ping timeout（34次 WebSocket、9次 polling），Node heartbeat采样没有 missed，p95 通常不超过2ms。心跳最大接收间隔50.595秒，说明服务端持续忙死不是主因；浏览器后台冻结、客户端调度、代理/边缘路径和 Engine.IO transport 仍需在客户端侧分开验证。
3. **Host 媒体存在长尾，但长尾主要落在非 thread-CPU 残余时间。** 活跃抓帧 `lastDurationMs` p95约157ms、最大370.5ms；对应 thread CPU p95约24.9ms、最大38.3ms，非 thread-CPU 残余最大345.4ms。活动抓帧 CPU 在758个窗口中p95约94%单核等效，说明高负载确实会降低接近20Hz的稳定性，但不能用 CPU 解释全部370ms尾部。编码窗口最大725ms，需继续分离 native capture、调度/阻塞残余、队列等待和编码 backlog。
4. **“媒体采样健康但控制恢复失败”已经被直接记录。** 2026-10-28 的 `recovery-failed / keyboard-reset-send-failed` 样本中，PC/ICE/SCTP/input DataChannel 均 open、已有绘制帧且 decoded 增量38、推导约19fps、丢帧0，但输入 gate 仍 blocked，keyboard/mouse reset pending。它不是物理显示证明，但足以证明控制恢复问题不能继续只按媒体、网络或 CPU 归因。

## P0：Tunnel 生命周期与连接占位

`/tmp/wrd-fixed-domain.log` 的实际快照为2026-10-27T17:46Z至2026-10-29T16:08Z。期间有10次 tunnel 启动、9次 graceful shutdown、47次边缘连接注册和43次 unregister/lost/retry相关事件。明确的 shutdown→restart 间隔包括：

- 2026-10-28T05:30:39Z shutdown，05:36:38Z重新启动；
- 2026-10-28T15:07:37Z shutdown，15:14:36Z重新启动；
- 2026-10-29T00:07:40Z shutdown，00:13:34Z重新启动。

这些窗口是 tunnel 进程生命周期中断的强证据，支持对应时间段公网不可达的假设，但没有逐时 edge 全断证据，不能用它替代逐请求 outage 证明。另有 2026-10-29T11:34:23Z 的 edge connection loss 与 Signal ping timeout、随后 `signal-connect-error` 对齐；16:08:47Z 的 origin request context canceled 与 `negotiation-timeout`、16:08:50Z ping timeout 对齐。其余 ping timeout 没有对应 edge 事件，所以 tunnel 不是所有断连的唯一根因。

9次 shutdown 中有8次呈现约60–61分钟的周期性，shutdown 后四条连接几乎同时终止，下一条四连接组在352–421秒（约5.9–7.0分钟）后才重新注册。这比单条 edge closed 更能支持公网入口在这些窗口整体不可用，但只能证明 `cloudflared` 收到 SIGTERM；发送者和根因仍未知。下一步应只读检查 launchd/cron/守护脚本及父进程退出原因，不能把它归因 Signal/Host，也不能自行重启或重建 tunnel。

当前 `cloudflared` 进程观察到 PID 26104；本轮没有操作它。`/tmp/wrd-safe-current-url.txt` 不存在，不能把它当作临时公网地址来源。

## P0：应用层心跳、租约与恢复竞态

Signal 结构化日志覆盖2026-10-27T17:47:28Z至2026-10-29T16:24Z，实际不足完整72小时。统计为：socket disconnect 59、grace start 56、grace expired 43、failed-closed transition 54（lease-expired39、released11、controller-disconnect3、rebind-rejected1），reset completed 54且均 applied，viewer reconnected 10、rebind confirmed 9、rebind failed 1。

43个 ping timeout 中有27个没有有效 pong，16个 pong 晚于预期；典型记录为 ping 约20秒后仍等不到正常 pong，最终在约45秒时关闭。9个 polling timeout 的 transport writable=false、flush未观察到 ping、writeBuffer约1–11；但34个 WebSocket timeout 也存在，因此不能把问题简化成 polling 单一故障。

同一应用层心跳窗口中，`maxReceiveGapMs` 的 p50/p95/max 为3.452/9.647/50.595秒，`lastReceivedAgeMs` p50/p95/max为12.608/42.111/44.466秒。多次在应用心跳已经停止后才出现 Engine.IO ping timeout，优先怀疑浏览器后台冻结、页面生命周期或客户端调度；服务端 Node event loop 不是主要解释。

客户端故障摘要进一步显示 ACK 尾部不在 Signal 本地处理：2026-10-29 的几个窗口中，control-heartbeat sent/ack/timeouts 分别出现 3204/3194/9、5436/5424/11、5574/5546/22、5813/5771/36；对应 `maxAckRttMs` 为2400、2431.5、2431.5、2486.2ms，最后一段 `lastAckAgeMs` 已超过60秒。Signal 本地 request→ACK 最大约129ms、通常低于30ms，所以应用 ACK 的长尾在浏览器、隧道、回程或调度区间之外；当前没有单向网络测量，不能把它命名为纯网络延迟。后续应按会话持久化 heartbeat p50/p95/max、timeout ratio、transport fallback、visibility 和 DC 状态。

源码复核还发现两个恢复放大器：

- 59个 connection attempt 中只有5个只绑定一次；37个绑定3次，7个绑定4次，另有最高9次。同一 attempt 的 bind 会从多个恢复/媒体路径重复发送，Signal 也会把每次都通知 Host。它们可能制造重复 rebind/media 请求和竞态，不能简单删掉所有重复 bind，但需要按 attempt/sequence 做短窗幂等并区分首次 bind 与必要的 late-offer rebind。
- `recordSignalingFailure()` 在一次 WebSocket opening timeout 后把当前 signaling session 的 `preferPolling` 设为永久有效，后续 transport 顺序改成 polling-first，直到整个 session 被重置。快照中11次 polling heartbeat close与该行为相符。fallback 应有短 TTL，并在 polling 成功后重新探测 WebSocket-first；不能直接禁用 polling，因为代理环境仍需要兜底。

当前可见代码在 `control-heartbeat-rejected` 时直接冻结控制；页面重新可见时主要恢复媒体和键盘绑定，没有明确验证“Socket仍 connected 但 lease 已过期”的重新授权路径。这可以解释“连接看似还在、画面恢复、输入仍被锁住”的现象，需要增加显式 lease 状态和手动/安全恢复入口，不能自动抢占他人控制权。

## P1：Host 抓帧、编码与媒体门禁

Host 轮转日志实际覆盖2026-10-28T21:57:43Z至2026-10-29T16:24:09Z，共11911个 event-loop窗口。整体 `lagMs` p50/p95/max为0.925/2.763/146.768ms；窗口 `maxLagMs` p95/max为15.145/334.391ms。活跃 grabbing 样本的 cadence p50/p95/max约17.57/19.25/19.43Hz，目标20Hz没有稳定达到。

活动抓帧的 p50/p95/max：`lastDurationMs` 50.31/157.09/370.527ms，thread CPU 12.48/24.85/38.32ms，非 thread-CPU 残余37.36/134.11/345.408ms。活动窗口 RSS约529.23/540.29/542.95MiB；历史 `peakRssMiB=968.43` 与当前RSS不能混为一谈。结论是：活动抓帧时 Host 进程确实可能接近单核饱和，但最大长尾主要落在非 thread-CPU 残余，优先检查 MSS/Quartz/native capture、系统调度、锁和 worker 队列，不要只调 Python CPU。

编码样本1059条，`encodeMs` p50/p95/max为6.06/16.731/29.011ms；窗口最大编码耗时 p50/p95/p99/max为20.369/76.568/129.259/725.347ms，最差窗口在2026-10-29T09:13:04Z附近。抓帧 maxDuration 与编码 max window 在部分高负载窗口相邻，但当前日志仍不足以证明一个唯一根因。

当前日志中的媒体统计混入了 page-hidden、无PC和失败探针：15583条 Viewer stats 中11448条 fps=0，codec unknown 2760条；正常活动会话仍常见19–20fps、RTT约31–53ms。候选 relay、Socket connected 或 ICE connected 都不能作为“用户看到首帧”的成功条件。应把 `visibility/phase/PC state/codec/decoded bytes/first-frame` 作为同一 scope 的门禁，单独统计 active、suspended、unavailable。

当前快照尾部还显示：Viewer slot为1、relayViewer为0，但 Host 最新窗口 `pcState=none`、capture=unavailable、输入队列 frozen，Viewer stats为fps=0/codec unknown。这是一个“连接占位但媒体已失活”的残留会话候选，可能阻塞后续用户接入；当前无法从日志确认它是否是用户本人，所以本轮没有清理。

## P1：控制恢复与 reset 路径

Host 343组 reliable input result 全部 accepted/applied；其中67个 reset走 Socket，另外276组业务/键鼠事件走 DataChannel。Signal结构化 input 记录183条全部是 reset，180条观察到 applied ACK，2次 keyboard reset 因 unauthorized 被拒绝（2026-10-28T16:15Z、2026-10-29T16:12Z），另有1条在当前窗口没有对应 ACK 分类。两次 unauthorized 是 authority/旧 lease 不匹配证据，不是网络丢包证据；应与对应 reconnect/rebind 时间线关联。

上轮受控20对 reset 中的 DC-first ACK 优化没有在真实失败会话中复现：生产 reset 仍全部是 Socket 请求，当前没有一条生产 Host reset result 证明 DC mirror 首先完成。说明真实失败会话里 input DC 常常不可用或处于 page-hidden/恢复阶段，受控探针结果不能代表用户路径。

`keyboard-reset-send-failed` 的媒体采样健康样本是当前最高优先级的代码整改对象。需要按 reset transport 记录“未尝试、发送失败、ACK过期、旧 lease、reacquire-required”各自计数，并保证失败后能安全重试或明确给出重新请求控制的入口；不能用“PC/DC open”宣布控制可用。

## P1：诊断信息不足

23次 auto-failure diagnostic 中，`signal-connect-error`16、`dc-stuck`3、`recovery-failed`2、`negotiation-timeout`2；全部 `logCount=0`、`retainedLogCount=0`、metadata-only。这个结果不等于原始日志一定丢失，但故障包没有可检索正文和完整计数。

`inputTrace` 在重试过程中出现 1574–11198 的 droppedEvents，最近窗口为1574–1793，expired pending ACK从1到8，并多次带 `input-trace-truncated`。这些是 ring 淘汰和 ACK 过期观测，不是网络丢包数量。需要持久化有界的 summary gap、ring drop、last phase、transport、lease/attempt hash 和失败阶段，明确区分诊断环淘汰与业务输入丢失。

entry sampler 本身有2784个一分钟窗口，2688个为空，missed/logger/store failure均为0；空窗口表示没有入口流量，不是日志采集缺失。另一个缺口是当前 Signal 结构化业务输入记录几乎只有 reset，不能用它证明真实 down/up/move/text 的用户控制稳定性。

本窗口混有自动诊断、维护和 page-hidden 会话：同一类短连接反复出现，不能把59次断连直接换算成真实用户断连率。后续报告必须用 probe/session scope 分隔自动探针与真实前台会话，并把“Socket reconnect”“lease rebind confirmed”“media first-frame”“input gate allowed”分别计数；其中任何一个单独成功都不等于用户可控制。

## 处理优先级

1. **先处理 tunnel 生命周期和当前残留 Viewer。** 先确认当前 Viewer 是否是用户会话；未经确认不踢出。对 tunnel 的 SIGTERM 来源和 launch agent 生命周期单独追查，不能用应用改动掩盖公网入口中断。
2. **给心跳和恢复加可关联证据并修复 sticky polling/rebind 重复。** 每个 close 记录 attempt scope、visibility/page lifecycle、last app heartbeat send/ack、Engine ping/pong、transport writable/buffer、PC/SCTP/DC 状态；对 attempt bind 做安全幂等。fallback 只短期有效，恢复后回到 WebSocket-first。
3. **单独修复 keyboard reset send failure。** 在媒体采样健康的故障样本上复现，明确 reset 发送失败的边界和重试策略，增加业务输入 action 分类的脱敏计数。
4. **继续拆分 capture→queue→encode→RTP→Viewer decode→visible effect。** 对 native capture 增加 call age/timeout/stale-drop，记录 worker backlog 与非 thread-CPU 残余/阻塞调度候选；不要把 `maxDurationMs` 这种窗口历史最大值当作每帧耗时。
5. **补齐诊断摘要。** 保留有限、脱敏的 gap/ring/ACK-expiry/phase 证据，并给每条统计加 probe/real-session scope；当前日志不足以给真实用户输入 SLA 或三小时连续性结论。

本轮没有宣布服务完全可用，也没有把当前残留 Viewer 清掉。当前本地 health/Host 在线，但 `viewerCount=1` 且媒体尾部为不可用状态；如果该 Viewer 不是你的会话，下一步应在你确认后做定向清理并复测，而不是直接重启整条链路。
