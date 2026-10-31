# 日志系统与 Goal 完成度审查

日期：2026-10-31（Asia/Shanghai）

本报告是对当前主分支、最近运行日志和仓库内 spec/plan 的只读复核。没有重启 Signal/Host，没有操作 tunnel，也没有发送真实业务输入。

## 结论

当前日志系统处于“能发现主要症状，但还不能闭环定位和自动判定可用”的状态。

它已经能识别：Socket/PeerConnection 表面保持 connected、Host event loop 没有持续卡死，但媒体采集已经 suspended、没有新帧，Viewer 的实际解码帧为 0；也能看到 ping timeout、transport close、reset ACK、rebind 和输入丢弃等现象。它还不能把这些现象关联成一次完整的会话故障，也不能区分诊断日志为空、没有被采集、在传输中丢失或被接收端裁剪。

因此“发现问题”能力部分足够，“证明原因已定位、判断服务可用、证明优化达标”仍不足。当前健康状态存在误报：`health_ok=true`、`hostOnline=true`、`viewerCount=1`，但该 Viewer 长时间 `fps=0`、`codec=unknown`、`decoded=0`，Host capture 为 suspended，relay 未运行。

## 当前运行证据

### Host 与 Viewer

- `back-debug.log` 当前窗口为 2026-10-31 00:08 至 02:11（本地时间），共有 7,380 条 Viewer 统计和 1,327 条结构化 `host_event_loop_lag` 记录。
- 7,380 条 Viewer 统计都显示 `codec=unknown`、`fps=0.0`、`decoded=0`、`received=0`、`candidate=relay`，说明 Viewer 仍占用连接槽位，但没有可见媒体流。
- 1,327 条 Host 结构化采样都显示 `pcState=connected`、`iceState=completed`、`capture.state=suspended`、`relayRunning=false`、`captureSeq=3`；采集计数固定为 attempted/completed=4，published=0。
- `lastInputAgeMs` 从约 1.6e7 ms 持续增长到约 2.3e7 ms，`inputUnordered.droppedCount=7222` 固定不变。当前状态更符合失效或残留会话占槽，而不是 Host event loop 持续被 CPU 卡死。
- event loop 的 p95 约 1–2 ms，窗口最大值约 46.8 ms；current RSS 约 41 MiB，peak RSS 约 968 MiB。`lastCompletionAgeMs=3600000` 是被上限裁剪的值，不能当作真实的抓帧年龄。
- Signal 侧最后一次对应会话事件是 `media_activity_requested`，状态为 `suspended`，原因是 `page-hidden`；之后没有新的该会话业务事件，但 PeerConnection 仍保持 connected。这把当前残留会话更明确地指向“页面隐藏后的媒体停用没有完成会话清理/占槽释放”，而不是 CPU 长尾直接导致的断连。

### Signal 与诊断包

`/tmp/signal-server.log` 当前可见的结构化运行范围约为 2026-10-27 17:47Z 至 2026-10-30 18:25Z，能统计到：

- 89 次 `signal_socket_disconnected`；其中底层文本包含 58 次 ping timeout、21 次 transport close、3 次 transport error。
- 207 次 control heartbeat、288 次 reset ACK、34 次 viewer rebind、278 次 disconnect grace 相关事件、4360 个入口窗口摘要。
- 38 个诊断摘要，其中 31 次明确记录“Received 0 lines from viewer”。

`/tmp/wrd-diag/summary/2026-10-28..30.ndjson` 共 38 条摘要。绝大多数条目是 `logContentPolicy=metadata-only`、`reportedLogCount=null`、`retainedLogCount=0`、`inputTraceEventCount=256`。这意味着当前接收端无法证明 Viewer 的日志到底是“没有产生”“没有采集”“没有传到服务端”还是“被裁剪后只剩摘要”。代码中已有 `summaryGapCount`、`ringDropCount` 和 coverage 字段，但这些生产摘要没有形成可用的运行证据。

接收端的 `.summary-state` 另有 `receipt-horizon` gap 41，虽然 `droppedSummaryCount=0`，但 gap 没有进入每份 summary 的可见字段，读取单条报告时很容易误以为窗口完整。

原始 runtime 报告其实带有 `droppedEvents`、`ackTimeoutCount`、`expiredPendingAcks` 等输入环计数，但日摘要只留下 `inputTraceEventCount=256`，没有把这些计数带入 evidence。也就是说，最有价值的丢失证据存在于 raw 文件，却没有进入常用的汇总查询路径；而 receipt horizon 过期后，连逐条收据也会消失。

其中最新的 `input-ack-timeout` 样本出现 input ACK p95 约 1547 ms，但 `hostQueue` p95 约 2.85 ms、`hostApply` p95 约 0.93 ms；`signalForward`、ACK arrival、`inputToFrameNotice` 和 `inputToVisibleEffect` 都是 null。这个分布说明 Host 原生执行不是主要瓶颈，回程、帧关联和呈现段缺测，当前日志只能定位到“Host 已快、端到端仍不完整”，不能给出完整输入到画面耗时。

### Watcher 与入口

- watcher 最近约 4,362 个 tick 中，约 3,866 个为 `entry-healthy`，310 个 `budget-exhausted`，80 个 `cooldown`，64 个 `unknown`，42 个 `formal-down`。
- direct formal probe、`decisionId`、`restartActor`、`operationState` 已经生效；当前 state 显示 origin/formal healthy、action=none，环境代理的 passive probe 仍是 unknown。
- 资产探测当前使用 `/login.html` 和 `/desktop.html`，而产品实际入口是 `/`、`/index.html`、`/viewer.html`。日志反复出现资产探测 404，但健康判据只看 origin/formal，因此资产失败不会升级为入口 degraded，也不会进入统一告警。
- passive-runtime 在当前 watcher 日志中持续 unavailable，不能把 watcher 证据与 Signal/Host 会话状态对应起来。历史 tunnel SIGTERM 的最终发送者也仍无法由现有日志闭环证明。
- 全历史 `media_activity_requested` 中约 169 条有 100 条进入 suspended，其中 99 条明确原因为 `page-hidden`。这不是偶发噪声，应作为一等媒体停流分类，而不是只写成“连接仍在”。

## 日志系统的主要缺口

### P0：会影响故障判定

1. **健康状态没有媒体可用性门禁。** `viewerCount` 和 `hostOnline` 只能证明对象存在，不能证明最近有新帧、Viewer 有解码或输入链路仍然活跃。失效 Viewer 会长期占槽，后续用户只能得到“服务健康但无法进入”的结果。
2. **诊断包没有完整的接收证据。** `reportedLogCount`、`retainedLogCount` 和 `redactedLogCount` 的语义不完整，缺少 collector 状态、上报起止游标、传输接收数、裁剪数、summary gap 和 ring drop 的分类型计数。
3. **没有统一的会话和帧关联。** 当前无法用同一组脱敏 scope 把 `input send → Signal forward → Host apply → capture → encode → RTP first packet → Viewer decode → paint/visible effect` 串起来，因而 ACK 延迟和输入到画面延迟仍不能从生产数据闭环计算。
4. **残留会话没有明确生命周期事件。** 日志没有 `session_stale_detected`、`media_stalled`、`slot_released` 及其原因/阈值/结果，人工只能从每秒重复的 0 FPS 记录推断。

### P1：会降低诊断效率或造成误读

1. **watcher 资产路径不正确，passive-runtime 没有实际数据源。** 这会让入口检测出现“日志有 404、状态仍 healthy”的分裂结果。
2. **采集年龄使用裁剪值。** `3600000` 没有 accompanying `ageStatus=clipped`，容易被误读成刚好一小时。
3. **日志信息密度偏低。** Host 每秒输出完整 Viewer 统计、每 5 秒重复完整资源结构，长期窗口体积大，但缺少按会话/按异常聚合的 bounded summary 和告警。
4. **关联值仍有原始 socket/viewer 标识。** 当前运行日志中的 Viewer ID 和部分 Signal correlation 仍未统一 hash，和 metadata-only 的设计边界不一致。
5. **入口健康和应用业务健康没有统一 correlation。** watcher、Signal、Host 各自有时间戳，却无法直接判断某次公网失败是否对应应用断开、媒体停滞或 watcher decision。

## Goal 完成度

本报告早期版本曾把线程 Goal 误记为 `blocked`。当前系统 Goal 实际状态为 `active`；目标仍未完成，不能按“已完成”处理。仓库中最近几个计划的状态如下：

| 范围 | 已完成 | 未完成或证据不足 |
|---|---|---|
| 2026-10-30 控制恢复与入口监测 | watcher 代理误判防护、signaling fallback TTL、bind 幂等、keyboard reset 失败分类、离线测试、前端构建和加载 | 真实业务键鼠、物理可见效果、3 小时连续性、tunnel SIGTERM 最终归因、生产 logCount/gap/ring-drop 证据、stale Viewer 清理、完整帧关联 |
| 2026-10-20 控制恢复与采集长尾 | 恢复时钟、重绑定重试、双阶段 bounded worker、离线 observability 和回归 | RSS/CPU/FPS/capture p95/max 的真实维护窗口样本；已有 active 样本曾出现 capture p95 约 157 ms、max 约 371 ms、cadence p50 约 17.6 Hz、encode window max 约 725 ms，仍未达到目标；visible effect/active control/physical display；重启后短断线和长会话的新版本实测 |
| 2026-10-25 reset ACK | ACK 顺序、reset fence、失败分类和测试 | 200 ms 目标仍未证明达标，仍有约 405–496 ms 长尾；真实输入到可见效果仍未验收 |
| 2026-10-24 continuing disconnect | 大量恢复和采集代码已落地 | 受控采集后端 A/B、同负载/电源状态 pacing A/B、原生 buffer/IOSurface 实证、默认 backend 改动依据、3 小时真实连续性 |

离线测试通过、代码提交和 manifest 加载只能证明实现被构建并加载，不能替代真实连接、输入、可见效果和持续性验收。

## 建议的解决顺序

1. 先补“会话可用性”闭环：基于最近帧、解码、输入 heartbeat、PC/ICE 和 capture state 计算 `viewerMediaFresh`；超过有界阈值后产生 `session_stale_detected`。只有经过明确的 owner/维护策略或安全超时，才释放槽位，并记录完整的 `slot_release` 证据。
2. 再补诊断接收契约：明确 `collectorState`（未启动、空、有效、裁剪、失败），`reportedLogCount=0` 与 unknown 分开；增加 `summaryCursor/start/end/gapCount`、ring drop 分类和服务端 receipt，确保一份报告能证明“收到多少、丢了多少、缺了哪些窗口”。
3. 建立统一的脱敏 scope/frame correlation，至少让输入 ACK、Host apply、capture/encode、RTP 首包、Viewer decode 和 paint 各阶段可判定 available/unavailable，禁止用 ACK RTT 代替 visible effect。
4. 修正 watcher 的实际页面路径，给资产失败独立的 degraded 状态；接入真实的 passive runtime 数据源，并把 watcher decision 与 Signal/Host lifecycle 事件通过同一 correlation 关联。
5. 将重复的秒级明细改为短窗口聚合，异常时保留少量事件环；同时把 clipped/unknown/未采样明确写入字段，避免把缺测当成零值。
6. 完成维护窗口验收：短断线、输入恢复、首帧、可见效果、RSS/CPU/FPS/丢帧和至少 3 小时长会话，逐项记录通过或 NOT RUN。

## 结论边界

当前可以确认“日志系统已经能发现残留 Viewer 和媒体停滞”，不能确认“远程服务已经稳定可用”，也不能确认“频繁断连和输入中断已经彻底解决”。在会话可用性、诊断接收证据和端到端帧关联补齐并完成真实验收前，Goal 应保持 active/未完成。

## 追补复核与本轮落地（2026-10-31 13:20 后）

上一版审查发现的两个运行态问题已经分别补强：

- `4a3e92e` 为 watcher 增加 `watcherSchemaVersion=2` 和源码 fingerprint。随后按 runbook 重载 watcher，当前 PID 51489 已在 `/tmp/wrd-fixed-watch-state.json` 和最新 tick 记录 `watcherSchemaVersion=2`、fingerprint `33ddf5011fe34f827b8e9918`；`/index.html`、`/viewer.html`、core asset 和 loopback `/api/status` 均返回成功。
- `c983575` 将输入事件和 reset ACK 的关联改为 `viewerHash`、`attemptHash`、`inputIdHash`、lease/generation 等有界脱敏字段；诊断 raw、daily summary 和 runtime evidence 现在保留 `summaryGapCount`、`ringDropCount`、`coverageStatus` 与 input trace loss。原始 viewer、attempt、输入文本和坐标不进入这些关联字段。

本轮定向验证结果：watcher/runtime 19/19、entry probe 17/17、Signal signaling 131/131、诊断/runtime evidence/store/reset ACK 107/107、Host observability/admission 46/46；一次 Host rotating writer 测试首跑出现已有时序抖动，单测重跑和完整 Python 定向集均通过。未重启 Signal/Host、未操作 tunnel。

当前三小时 passive 会话仍在运行，约 68 分钟、4090 个采样，持续 connected/active，约 20 FPS，丢帧为 0；它仍不包含真实业务输入、visible effect 或物理显示证据。因此 Goal 仍保持 `active`，阶段 5 的短断线、真实输入、可见效果、物理显示和 3 小时长会话仍未闭环。

长会话继续暴露出抓屏语义缺口：`CAPTURE_STATS` 输出约 18–19.5 FPS，但每 5 秒复用缓存帧约 17–56 个；Host cadence 实际约 9–13 Hz。当前 lifetime 最大抓帧约 1296 ms，其中非 CPU 约 1263 ms、线程 CPU 约 33 ms，不能把它归因成 Python CPU 卡顿。`c4a6888` 已增加 `freshCaptureCount`、`reuseRatio`、`lastFreshCaptureAgeMs` 和连续复用计数；Host 尚未重载，因此这些字段待维护窗口结束后验证。

## 实时复核（2026-10-31 14:00 左右）

本节只记录本轮复核时已存在的运行证据，不把仍在进行的长会话提前算作通过：

- Signal PID `31381`、Host PID `31415`、watcher PID `51489` 和 cloudflared PID `26104` 均仍在运行；`/api/status` 返回 `health_ok/hostOnline=true`，当前 passive Viewer 的 `mediaFresh=true`、`mediaState=active`、`lastFrameAgeMs=0`。这证明当前被动会话有媒体进展，不能替代真实业务输入和可见效果验收。
- 三小时 passive 会话的 `samples.jsonl` 已记录约 `6308` 秒、`6308` 个采样；`pcState=connected`、`mediaPhase=active`、累计 `framesDropped=0`，但 `summary.json` 仍是启动时的 `INCOMPLETE` 占位，最终连续性结论必须等进程退出后再读取。
- 当前 `back-debug.log`（05:14–06:03 UTC，528 条 Host 事件循环窗口）显示 fresh capture cadence 约 9–13 Hz；输出统计约 11.5–19.6 FPS，每 5 秒复用缓存帧约 14–56 个。抓帧 lifetime 最大耗时 1296 ms，其中非 CPU 1263 ms、线程 CPU 33 ms；RSS 约 492–559 MiB，系统 load1 约 4.3–19.4，事件循环 p95 约 4.5–25 ms。Viewer 解码 FPS 的 p50/p95 约 19/20，丢帧和丢包为 0，因此不能用 decoded FPS 代替 fresh capture 健康度，也不能把长尾简单归因成 Python CPU。
- 当前 Host 日志仍没有 `freshCaptureCount`、`reusedOutputCount` 或 `lastFreshCaptureAgeMs`；这与 `c4a6888` 已提交但 Host 尚未重载的事实一致。新的 freshness 生产证据要等三小时会话结束后的受控本地重启。
- `/tmp/wrd-diag/summary` 的 40 条（10 月 28–30 日）摘要仍全部为 `reportedLogCount=null`、`retainedLogCount=0`、`redactedLogCount=null`，`summaryGapCount`、`ringDropCount`、`coverageStatus`、`logReceipt`、`inputTraceLoss` 和 `frameTrace` 均未形成可用运行证据；`.summary-state` 仍记录 `receipt-horizon` gap（当前为 52）。这说明代码契约已有，但生产汇总尚不能区分“未采集、未传输、被裁剪、写入失败”四类原因。
- Signal 当前能看到 `diagnostic_uploaded`、`signal_input_relayed`、`reset_ack`、`rebind` 和 disconnect-grace 等事件，但历史 `session_stale_detected`、`media_stalled`、`slot_released` 仍为 0；门禁的离线测试通过，生产触发证据尚不存在。watcher 最新 tick 的实际入口、core asset 和 loopback passive-runtime 均为 200/ok，当前 fingerprint `33ddf5011fe34f827b8e9918` 已被加载；tunnel SIGTERM 的历史因果仍未闭环。

这次实时证据把“日志系统是否足够”定为：**症状发现足够，自动归因和可用性判定不足**。缺口不在字段名称，而在生产链路尚未加载全部新代码、真实诊断包没有把 receipt/loss 字段带入常用摘要，以及没有一次真实输入到可见画面的闭环样本。

## 最终维护窗口复核（2026-10-31 15:20 后）

- 三小时 passive continuity 最终为 `PASS`：`elapsedSeconds=10800.5577`、`samples=10801`、`missingSamples=0`、`lateSamples=0`、`failedObservations=0`、`identityChangeObservations=0`、`pathChangeObservations=0`，`maxObservedNoProgressMs=1133.3`，`threeHourContinuityMet=true`。这只证明被动连接和帧回调连续，不证明业务输入、可见效果或物理显示。
- lifecycle 证据显示 `coverage.status=partial`、`missingReferences=1`、`droppedEvents=34459`、`rx=4036`、`tx=14840`、`ep=432`、`eo=432`、`ef=14840`。这些是诊断事件环和关联覆盖的真实丢失证据，尚未自动进入常用 daily summary 查询。
- supervisor 已按授权只重启本地 Signal/Host：新 PID 为 Signal `73182`、Host `73217`，cloudflared PID `26104` 未变化；验收结束后 `/api/status` 为 `viewerCount=0`、`mediaFresh=null`、`mediaState=unknown`，槽位已释放。
- 新 Host 版本在短 passive 会话中实际输出 freshness 字段：`reuseRatio` 约 0.14–0.26，`lastFreshCaptureAgeMs` 约 3–103 ms；窗口内抓帧最大约 311 ms、非 CPU最大约 264 ms、线程 CPU最大约 47 ms，RSS 约 424–453 MiB。
- 同一短会话的诊断 admission 出现 `frame_timing` dropped 最高 113、`capture_stats` dropped 2，原因包含 `congested`。这不会直接等同于视频丢帧，但会削弱输入到帧关联的观测覆盖。
- 自动验收结果：暂停恢复 20/20，p95=800 ms、max=800 ms；15 秒媒体停止、浏览器协议键盘、鼠标、tunnel 媒体恢复（p95=493 ms）通过。双 Viewer 语义为 FAIL；物理键盘、OS reserved、reset fault injection 未运行，正式入口在该协议运行中为 BLOCKED。

因此 Goal 仍保持 `active`：三小时连续性和 freshness 生产字段已有证据，但诊断 receipt/loss 常用汇总、真实输入到 visible effect、物理显示、reset fault injection、capture backend A/B、诊断通道拥塞处理和 tunnel 根因仍未闭环。

## 诊断 receipt 生产路径补证（2026-10-31 15:37）

受控手动诊断上报已成功写入当天 summary：`logReceipt.state=valid`、`reported=46`、`retained=0`、`redacted=46`、`dropped=0`，`inputTraceEventCount=9`，`inputTraceLoss` 的 dropped/hash/evicted/expired/timeout 全部为 0，`frameTrace.acceptanceState=PENDING` 且各丢失计数为 0。该证据确认当前版本的 receipt 和 input trace loss 字段已能进入生产 daily summary；gap/ring 在无丢失时保持 `null`，非零丢失仍需从 lifecycle/Host admission 证据关联进入常用告警。

## 诊断通道降频优化复核（2026-10-31 15:49）

`32cfc92` 已加载到 Host：无待关联输入时 `frame_timing` 每 5 帧采样一次；存在待关联输入时仍逐帧发送。重载后 30 秒 passive 会话中，`frame_timing` 为 sent=140/dropped=9，`capture_stats` 为 sent=8/dropped=0；相比上一版本的 frame_timing dropped=113，诊断拥塞明显下降，但尚未归零。

同一窗口暴露出独立的抓帧长尾：active capture rate 约 4.9 Hz、`reuseRatio` 约 0.73、`maxDurationMs=833`、`maxDurationNonCpuMs=792`，system load1 约 9–11。说明降频只改善了诊断通道占用，不能替代 MSS/CoreGraphics 后端 A/B；当前 Goal 仍不能宣称抓帧性能达标。

## 当前日志系统复核（2026-10-31 16:35）

本次复核覆盖最近两天可见的 Signal 结构化事件、Host 轮转日志、当天诊断 summary、watcher state 和当前本地健康状态；没有重启服务，也没有操作 tunnel。

### 已经足够发现的问题

- Signal 最近两天记录了 `signal_socket_disconnected=100`、`viewer_disconnect_grace_expired=32`、`signal_input_relayed=181`、`signal_reset_ack_observed=181`、`control_transition_failed_closed=89` 和 `diagnostic_uploaded=26`。断连、重连、输入转发、reset ACK 和控制状态失败都能被发现。
- Host 最近日志能同时看到抓帧、非 CPU 时间、线程 CPU、事件循环、RSS、Viewer 解码 FPS/丢包，以及诊断通道准入计数。当前受控会话中曾出现 `frame_timing` `sent=48,dropped=10`、`capture_stats` `sent=2,dropped=1`，原因均为 `congested`；这类“诊断覆盖丢失”已经可见，不会再被误认为业务视频丢帧。
- 当前本地状态为 `health_ok=true`、`hostOnline=true`、`viewerCount=0`；watcher 最新状态为 `entry-healthy`，实际 `/index.html`、`/viewer.html`、core asset 和 loopback `/api/status` 均成功，源码 fingerprint 仍为 `33ddf5011fe34f827b8e9918`。
- 当天最新手动诊断已写入 summary：`logReceipt.state=valid`、`reported=48`、`retained=0`、`redacted=48`、`dropped=0`，`inputTraceLoss` 各项为 0，且 `traceSummary.diagnosticAdmission` 已包含 `frame_timing`/`capture_stats` 计数。这证明 receipt 和 Host admission 的生产传递路径已经加载并生效。

### 仍不足以自动判定或完整归因的问题

- `summaryGapCount`、`ringDropCount`、`coverageStatus` 在当前无对应上报时仍为 `null`。这在语义上代表 unknown，但 daily summary 查询没有单独的“未采集/未观察”状态；全局 `.summary-state` 仍有 receipt-horizon gap（最近一次管理员摘要观测为 80），不能把 null 当成 0。
- lifecycle 长会话已经有 `coverage=partial`、`missingReferences=1`、`droppedEvents=34459` 的证据，但这些非零丢失还没有自动汇总到同一份按会话查询的 daily alert 中；Host admission 的拥塞也只在 Host 日志和下一次诊断快照中出现。
- `input ACK → Host apply → capture → encode → RTP → decode → paint/visible effect` 的字段契约存在，但最近两天没有真实业务输入到可见效果的完整样本。当前只能证明 Host apply 很快、Viewer 统计可用，不能给出端到端输入到画面的 p95/max，也不能证明用户确实看到变化。
- `media_stalled`、`session_stale_detected`、`slot_released` 的离线测试通过，但最近两天生产日志没有触发样本。因此 stale Viewer 门禁“代码存在”已确认，“真实残留会话能自动释放并留证”仍未完成实测。另一个边界是 active stalled 目前只记录 `media_stalled`，不直接释放仍有心跳的槽位，后续需要单独的安全恢复策略；当前 hidden-suspended 清理主要依据 control heartbeat，尚未把 media ACK、最近 received/decode/frame 进展全部纳入释放判据，需要补充安全边界测试。
- Host 日志仍有部分原始 `viewer`/socket 标识和高频逐秒明细；Signal lifecycle/recent event 也仍可能记录原始 `viewerId`、`previousViewerId`、`connectionAttemptId` 或 `browserSessionId`。输入/reset ACK 关联已脱敏，但不能把这个结论泛化到所有 lifecycle 日志；这不阻断故障发现，却不符合统一脱敏 hash、异常窗口聚合的目标。

### 最近两天性能信号

- Host 抓帧长尾仍主要是非 CPU：轮转日志中 `maxDurationMs` 最大约 1296 ms、`maxDurationNonCpuMs` 最大约 1263 ms，而 `maxDurationThreadCpuMs` 最大约 47 ms；不能归因成 Python 线程 CPU 卡顿。`activeIntervalRateHz` 的中位数约 13.2，部分窗口约 4.9 Hz，缓存复用最高约 74%。
- 事件循环大多数窗口 p95 在毫秒级，但历史窗口最高约 676 ms；RSS 在长会话中最高约 674 MiB。日志已经能发现压力和抓帧长尾，但还没有按维护窗口自动形成阈值告警或把“可见视频 FPS”和“新鲜抓帧率”分开作为健康门禁。
- reset ACK 的协议顺序和失败分类已有证据，但此前 405–496 ms 长尾的根因仍未被新的端到端样本闭环，200 ms 目标不能宣称达标。

## Goal 当前完成度（本轮复核后）

| Goal | 状态 | 证据与未完成项 |
|---|---|---|
| 媒体 freshness、page-hidden stale 门禁和释放事件 | **实现完成，生产验收未闭环** | 状态字段、阈值、幂等释放和离线测试已完成；最近两天没有真实 `session_stale_detected → slot_released` 生产样本。 |
| receipt 状态与 gap/ring/input loss 汇总 | **大部分完成** | `empty/unknown/valid/truncated/failed`、input trace loss 和 Host admission 已进入代码与生产 summary；全局 summary gap 未进入单条 daily alert，gap/ring 的 unknown 状态仍需显式展示。 |
| 输入到呈现的统一脱敏关联 | **契约完成，真实闭环未完成** | ACK、Host apply、capture、encode、RTP、decode、paint 字段均有边界和缺测语义；没有真实输入到 visible effect/physical display 的可验收样本。 |
| watcher 实际路由与 passive runtime | **代码和当前运行态完成** | 当前 watcher 使用真实入口、manifest 和 loopback runtime，状态为 entry-healthy；历史 tunnel SIGTERM 的最终发送者仍无法由日志证明。 |
| 维护窗口短断线、输入、首帧、资源、丢帧和 3 小时会话 | **部分完成** | 被动 3 小时 continuity PASS，短断线/媒体恢复和浏览器协议键鼠 PASS；双 Viewer FAIL，真实业务输入到可见效果、物理键盘、reset fault injection、capture backend A/B 仍 NOT RUN 或未达标。 |

## 判断

当前日志系统已经足够发现“网页/信令断开、媒体停滞、Host 抓帧长尾、诊断通道拥塞、输入 ACK/重置失败和资源压力”等主要症状；还不足以单凭生产摘要完成自动根因归类或宣布远程控制稳定可用。Goal 继续保持 `active`，不能标记完成。

下一步优先级仍是：把全局 summary/lifecycle gap 和 ring drop 统一成可查询的 `observed/unknown/nonzero` 状态；为诊断通道拥塞建立窗口级告警；为 active-stall 设计可审计的安全恢复策略；完成一次真实输入到可见效果的脱敏闭环；再决定是否需要独立抓屏后端 A/B。当前服务保持在线，未执行重启或 tunnel 操作。

## 本轮补强结果（2026-10-31 17:00）

- `39e566f` 将 active-stall 从“只记录 `media_stalled`”补为二阶段安全恢复：首次无新帧记录 `media_stalled`，超过恢复窗口记录 `media_stall_recovery_requested`，再经过一个 `staleAfterMs` 且 `progressAgeMs` 仍无进展才进入 `session_stale_detected`/`slot_released`，释放原因为 `active-media-stale`。
- hidden-suspended stale 判定不再只看 control heartbeat，而是综合最近 media request、applied media ACK、received/decoded frame 和 heartbeat；snapshot/Signal meta 同时暴露 `progressAgeMs`、`lastMediaAckAgeMs`、`activeStallAgeMs` 和恢复状态。
- `dd5a1ec` 将全局 summary coverage 的 `gapTotalCount` 和 `coverageSignals` 接入管理员 observability evidence，明确 `observed`、`nonzero`、`unknown` 三种状态，保留兼容的旧 count 字段。
- freshness/signaling 定向回归 138/138 通过；diagnostic-store/runtime-evidence 定向回归 37/37 通过。当前服务保持 `hostOnline=true`、`viewerCount=0`，本轮未重启服务、未操作 tunnel。

这两项补强解决了日志和 freshness 的已知 P1 缺口，但不改变 Goal 的最终边界：真实输入到 visible effect/physical display、reset fault injection、capture backend A/B、诊断拥塞长会话和 tunnel SIGTERM 根因仍未完成或缺少强证据。
