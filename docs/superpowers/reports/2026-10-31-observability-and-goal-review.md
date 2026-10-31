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
- active-stall 的恢复事件现在会在当前 Viewer 仍持有 ACTIVE lease、attempt/generation 完整匹配时，向 Host 发一次带完整身份的 `request-keyframe`；无 lease、旧 attempt 或失效 generation 会 fail-closed，不会触发 Host 恢复动作。
- freshness/signaling 定向回归 138/138 通过；diagnostic-store/runtime-evidence 定向回归 37/37 通过。当前服务保持 `hostOnline=true`、`viewerCount=0`，本轮未重启服务、未操作 tunnel。

这两项补强解决了日志和 freshness 的已知 P1 缺口，但不改变 Goal 的最终边界：真实输入到 visible effect/physical display、reset fault injection、capture backend A/B、诊断拥塞长会话和 tunnel SIGTERM 根因仍未完成或缺少强证据。

## 重载后生产核对（2026-10-31 17:10）

- 按 runbook 仅重载本地 Signal/Host：Signal PID `1993`、Host PID `2021`；cloudflared PID `26104` 保持不变，临时 URL 文件仍为空。
- `/health` 和 `/api/status` 均为 `ok`，Host 在线、Viewer 槽位为 0；手动诊断结束后的 Viewer 已在宽限期后释放。
- 管理员 observability summary 已返回 `coverageSignals.summaryGap={state:nonzero,count:80}`、`ringDrop={state:unknown,count:null}`、`source=observed`，验证全局 receipt-horizon gap 已可查询。
- 重载后手动诊断 summary 新增 `logReceipt=valid`、reported=45、retained=0、redacted=45、dropped=0，input trace loss 全 0；`summaryGapCount/ringDropCount` 在 Viewer 报告未提供全局覆盖时仍保持 null，符合 unknown 语义。
- 当前 Viewer build `6a137d3286eb3eb3` 与 manifest 的 `desktop-core.7cc6a5c79eafe8af.js` 一致。Goal 继续保持 `active`。

追加复测显示：短 5 秒诊断窗口可能早于首个 `capture_stats` 到达，因此单条 summary 不一定带 `diagnosticAdmission`；这属于采集窗口竞态，不能解读为 Host 没有准入计数。把诊断发送延后到 12 秒后，summary 稳定出现 `frame_timing sent=36 dropped=1`、`capture_stats sent=1 dropped=0`，并记录 `unavailable=1`。该结果同时证明诊断 admission 的非零丢失原因可以落盘；长会话告警仍需继续补齐。

## 关联与日志隐私追补（2026-11-01）

- Signal/Host 的结构化 lifecycle correlation 已改为 `viewerHash`、`previousViewerHash`、`attemptHash`、`browserSessionHash`；业务 Socket payload 不变，日志不会再直接保存这些原始身份。当前修改覆盖结构化事件，Host 的部分高频纯文本 `VIEWER_STATS`/连接失败日志仍需后续单独降频和脱敏。
- FrameTraceCollector 现在保留固定阶段的有界 `stageCoverage`（grab、prepare、encode、packetize、encode_total 等）并进入 diagnostic/runtime evidence。它能证明阶段观测覆盖率，不能把缺少同一 input scope 的数据误判成完整因果链；`correlation.complete` 仍只有真实 ACK→Host apply→capture→encode→RTP→decode→present 全部可用才成立。
- `5b8478f` 继续把同一 `stageCoverage` 投影到 durable daily summary 的 `frameTrace`，避免出现 raw/runtime evidence 有数据而常用 summary 丢字段的分裂。
- 本轮定向验证：Node signaling/admission 164/164、Node diagnostic/runtime/frame 262/262、Python observability 15/15；这些仍是离线和结构化日志证据，不能替代真实 visible effect。

`87a42e3` 已构建并重载到本地：Signal PID `8638`、Host PID `8667`，cloudflared PID `26104` 未变化；`/health`、`/api/status` 均正常，Viewer 槽位为 0。结构化日志现在只保留 lifecycle hash，业务 Socket payload 未改变；Host 高频纯文本标识仍作为后续 P1 清理范围。

`5b8478f` 重载后再次做 12 秒诊断窗口，最新 daily summary 同时保留了 `frameTrace.stageCoverage`（`sampleCount=0`、各阶段 observed=0）和 Host `diagnosticAdmission`（frame_timing sent=39、capture_stats sent=1、dropped=0）。这证明 raw、runtime evidence 与 durable summary 三层字段已经一致；sampleCount 为 0 仍诚实表示本次没有 frame-trace batch，不代表媒体链路没有视频帧。

## 当前运行窗口复核（2026-10-31 17:59 Asia/Shanghai）

本节以本轮实际读取到的文件为准，修正早先报告中已经滞后的部署版本和统计数字；本轮没有重启 Signal/Host，也没有操作 tunnel。

- 结构化 Signal 日志 `/tmp/wrd-structured/signal-server.jsonl` 的可解析覆盖为 `2026-10-30T02:41:35Z` 至 `2026-10-31T09:55:56Z`，共 2,997 行、无坏行。窗口内有 `signal_socket_disconnected=87`、`control_reset_completed=75`、`control_reset_retry=5`、`signal_input_rejected=5`、`viewer_disconnect_grace_expired=26`、`viewer_rebind_confirmed=9`、`diagnostic_uploaded=24`。这些数字足以确认控制/信令异常仍在发生，但不能由事件总数直接推出每次断连的同一根因。
- 把轮转 Signal 日志合并后看最近约三天，断连为 134 次，其中 `ping timeout=51`、`transport close=44`、`server namespace disconnect=37`、`transport error=2`；宽限期开始/到期为 92/59，重连/重绑定为 15/14，控制关闭失败 117 次（`lease-expired=65`、`controller-disconnect=45`），输入 relay/ACK 为 188/187，另有 7 次输入拒绝且全部是 unauthorized。由此可以确认断连不是偶发单点，ping timeout 是最大单一分类，但仍缺少按同一 session 的网络、媒体和输入关联。
- reset ACK 的已有运行样本为 p50 13.69 ms、p95 47.21 ms、p99 96.08 ms、max 361.22 ms；此前 405–496 ms 长尾不再是普遍水平，但仍未证明 200 ms 目标在真实长会话中满足，也没有完成 ACK→可见效果的因果样本。
- 最新手动诊断的 `logReceipt` 均为 `valid`，报告数约 45–63，`retained=0`、`redacted=reported`、`dropped=0`，input trace loss 各项为 0；但 `summaryGapCount` 和 `ringDropCount` 仍为 `null`（语义是未观测，不是零），`frameTrace.acceptanceState=PENDING`、`matchedCount=0`，最新 `stageCoverage.sampleCount=0`。全局 `/tmp/wrd-diag/.summary-state` 仍有 `receipt-horizon` gap=80。也就是说，收据写入链路可用，常用摘要仍不能证明“没有 gap/ring 丢失”或“已完成帧关联”。
- 同一批最新诊断可以证明媒体本身曾经正常：首帧约 823–987 ms、解码约 19–20 FPS、decode p95 约 0.68–0.72 ms、jitter 约 6–9.7 ms、candidate RTT 约 1–2 ms、`framesDropped=0`、`hasPaintedFrame=true`。但所有输入相关指标（`inputAck`、`hostQueue`、`hostApply`、`inputToFrameNotice`、`inputToVisibleEffect`）都是 `count=0/available=false`，所以不能从“有画面”推导“控制输入已生效”。
- 日志隐私处于迁移态：当前新事件已有 hash correlation，但窗口内仍有 578 条历史结构化事件包含原始 viewer/session/attempt 字段，只有 7 条使用新的 hash 字段；这解释了为什么不能把“当前新代码已脱敏”扩展成“最近两天日志全量已脱敏”。`/tmp/signal-server.log` 仍是混合文本和结构化输出，不应作为机器解析或 guarded recovery 的事实源；受控读取应使用结构化 JSONL 并固定 inode。
- Host 07:22–09:59Z 的聚合日志仍显示抓帧长尾以非 CPU 为主：单窗最大抓帧约 311、455、833 ms，对应非 CPU 最大约 93、422、792 ms，线程 CPU 最大约 41 ms；部分窗口 fresh rate 约 2.1–4.9 Hz，后续较好窗口约 16.7–18 Hz。事件循环大部分窗口 p95 约 2.3 ms，但曾有约 106–222 ms 的窗口峰值。现有日志能发现“采集等待/阻塞”和 event-loop 压力，仍没有 per-frame encode/RTP/decode/present 的生产时序。
- 合并最近轮转 Host 日志的约 7,202 个 event-loop 窗口，lag p50/p95/max 约 1.43/7.73/676.24 ms；capture duration p50/p95/max 约 26.94/147.41/1296.03 ms，线程 CPU 最大约 46.995 ms、非 CPU 最大约 1263.041 ms；RSS p95/max 约 619/673.8 MiB，system load p95/max 约 17.27/80.75。采样状态中 `suspended=3179`、`unavailable=2044`、`grabbing=1806`、`idle=173`。这进一步支持抓帧长尾主要是等待/阻塞，而不是 Python 线程 CPU 饱和；但 Host 日志是“前缀文本+JSON”混合格式，且没有 process CPU% 和自动阈值告警，机器聚合仍不稳。
- 当前本地 `/health`、`/api/status` 返回成功，`hostOnline=true`、`viewerCount=0`、`mediaState=unknown`；watcher 的 origin/formal/passive-runtime 均为 `ok`，`entry-healthy`。当前实际 Viewer build 是 `25e0b46651956c6c`；报告中更早的 `6a137d3286eb3eb3` 只代表旧部署证据，不能用于当前状态判断。

### 本轮判断

日志系统对“发现症状”已经够用，对“自动归因和可用性门禁”仍不够用。当前最关键的三个缺口是：

1. **会话健康缺少媒体进展门禁**：`health_ok`、`hostOnline` 和 `viewerCount` 仍可能同时为真，而 Viewer 实际没有解码帧或 Host 没有新鲜抓帧；需要把最近 received/decode/present 与 capture freshness 纳入按会话的可用性状态。
2. **覆盖丢失没有统一告警路径**：单次诊断能记录 receipt，管理员接口能看到全局 gap 状态，但 lifecycle `droppedEvents`、summary gap、ring drop、Host admission congestion 尚未聚合到同一个会话告警和 daily summary。
3. **端到端时序尚未有真实生产样本**：输入 ACK、Host apply、capture、encode、RTP、decode、paint 字段存在，但当前 frame trace 没有有效样本，不能计算输入到画面 p95/max，也不能证明用户可见效果。

因此 Goal 继续保持 `active`。本轮没有新增通过项：代码/离线测试和 3 小时 passive continuity 可算完成，真实业务输入、visible effect/physical display、reset fault injection、capture backend A/B、双 Viewer 语义、完整 receipt/gap/ring 生产证据和 tunnel SIGTERM 根因仍未完成或没有足够证据。

## 脱敏修复与受控恢复复测（2026-10-31 18:35–18:56 Asia/Shanghai）

- `8bb42f9` 已把 `diagnostic_uploaded`、诊断 raw/legacy 持久化、嵌套 input/scope 和 Host structured meta 统一收敛到 `viewerHash`、`attemptHash`、`browserSessionHash` 等字段；原始身份只保留在业务握手/Socket payload，不再进入诊断存储和结构化日志。`a88f5a5` 让 guarded recovery runner 严格拒绝 raw correlation，同时匹配生产无盐 SHA-256/32 与旧测试的私有 salted/16 投影。Signal diagnostic/store 65/65、Host observability 16/16、runner 95/95、capture benchmark 6/6 通过。
- 本轮按 runbook 仅重启本地 Signal/Host：Signal PID `23232`、Host PID `23272`，`/health` 和 `/api/status` 均正常，`hostOnline=true`、`viewerCount=0`；cloudflared PID `26104` 未变化，`/tmp/wrd-safe-current-url.txt` 仍为空。新进程写入的 lifecycle 日志已使用 hash correlation，历史轮转文件中的 raw 身份仍属于旧部署证据，不能倒推为当前新代码行为。
- 重载后结构化 Signal 日志从 10:35Z 起新增 66 行，其中 lifecycle correlation 含 raw identity 的为 0 行，使用 hash correlation 的为 15 行；这证明新脱敏出口已在生产进程生效。此前报告中的 raw 统计仍应保留为历史迁移窗口证据，不能与当前窗口混算。
- 新建 root-attested manifest 后，`within-grace` 正式入口 relay 实测 **PASS**：300.24 秒采样、301 个样本、无缺测/迟到/Host 断开；native-direct fault 触发 1 次，约 3.00 秒恢复，稳定 30.02 秒，server coverage complete。该验收仍是无业务输入的恢复证据，`businessInput/visibleEffect/physical=NOT_RUN`。
- `after-grace` 受控路由实测 **INCOMPLETE**：fault capability available、触发 1 次、拦截 2 个 WebSocket 请求，startup verified，但 60 秒恢复窗口内未恢复。日志显示 10:52:47Z 断开、10:52:57Z lease expired/reset completed、10:53:07Z 新 connection attempt；随后没有 `viewer_reconnected` 或 `viewer_rebind_confirmed`，因此新连接没有重新获得控制租约，最终为 `recovery-deadline`。这说明长于 grace 的恢复需要显式的重新控制/重新 admission 验收，当前 passive runner 不能把新连接当成已恢复控制。

本轮把“统一脱敏”和“within-grace 短断线”推进到可复核证据，但没有把 after-grace、实际业务输入、可见效果或物理显示误报为通过。Goal 仍保持 `active`。

`1d4d591` 进一步把 `coverageSignals` 写入每份 durable summary 和 `diagnostic_uploaded` 摘要事件。当前新进程已再次重载为 Signal PID `30530`、Host PID `30565`，本地健康和 Host 在线正常，cloudflared PID `26104` 与 URL 文件保持不变；该改动尚需下一次真实诊断上传后再核对生产 summary 中的三个状态字段。

随后完成了一个不含业务输入的本地生产诊断上传：`/tmp/wrd-diag/summary/2026-10-31.ndjson` 最新行和 Signal `diagnostic_uploaded` 同时出现 `coverageSignals`，其中 `inputTrace={state:observed,count:0}`、`summaryGap={state:unknown,count:null}`、`ringDrop={state:unknown,count:null}`，`logReceipt.state=empty`，摘要 correlation 全为 hash。此证据证明字段已经进入生产接收、结构化事件和 durable daily summary；它仍不等价于真实业务输入或帧关联覆盖。

对实际输入/visible effect 自动验收的最终只读复核确认：当前 `turn_controlled_scene_runtime` 和 `turn_lab_input_guard` 会在 Host-private native probe 没有同时证明 dedicated macOS desktop、专用 fixture window、MSS/捕获目标和连续 proof epoch 时 fail-closed；现有 `turn_lab_host` probe 固定返回 `isolated=false/foreground=false/fixtureWindow=false`。因此不能用浏览器协议输入、CLI flag 或 ACK 冒充物理可见效果，真实输入、visible effect 和 physical display 继续保持 `NOT_RUN`。要解除该边界，需要在隔离 macOS desktop/fixture 进程中新增原子绑定和连续复核 API，不能在共享用户桌面生产 Host 上临时打开。

追加 after-grace 验收 runner 后，新的 root-attested 正式入口实测 **PASS**：故障注入触发 1 次、拦截 2 个 WebSocket 请求；页面在 lease 释放后只通过现有 `#requestControlBtn` 发起一次显式控制请求，约 20.01 秒恢复，稳定 30.03 秒，300.28 秒连续采样无缺测，server coverage complete。该结果证明“断线超过 grace 后，用户重新请求控制可以恢复”，不代表系统自动 takeover，也不包含桌面业务输入/物理显示。

为收尾剩余真实输入验收，本轮新增 [隔离 Lab visible-effect spec](../specs/2026-10-31-isolated-visible-effect-acceptance-design.md) 和 [执行计划](../plans/2026-10-31-isolated-visible-effect-acceptance-plan.md)。它把 native desktop/window/capture 原子 probe、proofEpoch、Host claim、RTP/rVFC marker 和负例门禁写成可执行任务；在该隔离环境建立前，生产共享桌面相关指标继续保持 `NOT_RUN`。

隔离 Lab guard 测试路径也已自包含化（`f53a678`），不再依赖外部 `PYTHONPATH`；Lab/scene/runtime/guard 集合当前 **124/124** 通过，且仍保持自动输入在 native probe 缺失时 `BLOCKED`。

## 本轮日志系统与 Goal 复核（2026-10-31 21:28 Asia/Shanghai）

本轮只读复核使用当前运行进程、`/tmp/wrd-structured/signal-server.jsonl`、轮转后的 `back-debug.log*`、`/tmp/wrd-diag/summary` 和 watcher state；没有修改代码、没有重启服务、没有操作 tunnel。

### 当前运行边界

- `/health` 返回 `ok`，`/api/status` 为 `hostOnline=true`、`viewerCount=0`、`mediaState=unknown`；这表示本地 Signal/Host 在线，但当前没有 Viewer，不能用本窗口证明视频、输入或呈现可用。
- `cloudflared` 进程未变化，`/tmp/wrd-safe-current-url.txt` 为空；当前没有可用的 safe quick tunnel URL 证据，不能把本地健康扩展成公网可达结论。
- watcher 当前为 `entry-healthy`，origin/formal/passive-runtime/assets 均为 `ok`，但最近一次 formal probe 的 `elapsedMs` 约 5945 ms。近两天 formal-health p50/p95/p99/max 约 1305/3676/7732/12529 ms，login/viewer/core asset 的 p95 约 3201/3262/3892 ms；现有 watcher 只保存单次耗时和状态，没有 p95/p99、分段 TTFB 或连续慢请求告警，网页“偶发打不开/很慢”仍可能被单次 200 掩盖。

### 最近两天已经能发现的故障

以单行结构化 JSONL 为机器事实源（覆盖 2026-10-30 02:41Z 至 2026-10-31 13:25Z）统计：

- `signal_socket_disconnected` 98 次：`transport close` 49、`server namespace disconnect` 33、`ping timeout` 14、`transport error` 2。
- `viewer_disconnect_grace_started` 57 次、`viewer_disconnect_grace_expired` 30 次；`control_transition_failed_closed` 83 次，其中 `controller-disconnect` 41、`lease-expired` 39、`transition-timeout` 1；`control_reset_completed` 82 次。
- `viewer_reconnected`/`viewer_rebind_confirmed` 各 10 次，`signal_input_rejected` 5 次且均为 unauthorized；说明断连后的控制租约失效和重置是真实运行问题，不是单纯前端提示。
- `diagnostic_uploaded` 28 次，其中 `signal-connect-error` 16 次；这证明连接故障路径确实会触发诊断上报。

合并原始轮转文本日志后计数会更高，因为该文件是多行 `console.inspect`，包含重复/跨轮转边界，不能作为机器关联事实源。它仍然说明当前 `/tmp/signal-server.log` 的格式本身是诊断缺口：7 MB 混合文本无法稳定按事件、会话和时间窗口查询。

Host 轮转日志在最近窗口有 7190 个可解析事件循环样本：`lagMs` p50/p95/max 约 1.21/7.97/676.24 ms，RSS p95/max 约 619/673.8 MiB；抓帧 `lastDurationMs` p95/max 约 178.9/1296.0 ms，`maxDurationNonCpuMs` 最大约 1263.0 ms，而 `maxDurationThreadCpuMs` 最大约 47.0 ms。该证据仍支持“抓帧长尾主要是等待/阻塞，不是 Python 线程 CPU 饱和”，但当前没有在线 Viewer 时，capture `unavailable` 不能证明媒体健康。

### 日志系统仍不足以闭环的部分

1. **Heartbeat 证据丢失只能在 close 时看到。** `ringDropped` 和 `coverage=partial/proof=false` 由 heartbeat close snapshot 输出，在线会话期间没有周期性 bounded snapshot 或立即告警。因此诊断环溢出可以发生，但直到断线后才进入日志；这里的 `ringDropped` 是本地诊断事件环 eviction，不是 WebSocket/WebRTC 数据包丢失，也不是视频 `framesDropped`。最近的 heartbeat close 已出现非零 ring drop，不能宣称诊断环时序完整。
2. **诊断收据仍有缺测。** 2026-10-31 summary 中手动窗口可以得到 `logReceipt=valid`（reported 约 45–63、retained=0、redacted=reported、dropped=0），但连接失败窗口多为 `unknown` 或 `empty`；`summaryGap`、`ringDrop` 多为 `unknown`，不是零。它们没有统一带上 collector 状态、起止游标、传输接收数和丢失原因，因此仍不能区分未采集、未传输、被裁剪和写入失败。
3. **帧关联仍无真实生产样本。** 最新 summary 的 `frameTrace.acceptanceState=PENDING`、`matchedCount=0`、`stageCoverage.sampleCount=0`；因此可以看到 ACK、Host apply 或媒体统计的局部数据，却不能计算 `input → Host apply → capture → encode → RTP → decode → paint` 的 p95/max。
4. **健康门禁仍可误报。** `hostOnline` 和 `viewerCount` 只能证明进程与连接对象存在；没有把最近 fresh capture、received/decode/present、输入 heartbeat 和 active stall 统一纳入可用性状态。`session_stale_detected`、`media_stalled`、`slot_released` 在最近两天生产日志仍没有真实触发样本。
5. **ACK 与重连尝试的关联仍不完整。** 最近生产 `signal_reset_ack_observed` 事件虽然有 `inputIdHash`、`leaseEpoch` 和耗时字段，但多数缺少 `attemptHash`；`signal_input_relayed` 也常只有 viewer 级关联。ACK 长尾因此无法稳定归因到具体连接尝试或重绑定周期，缺失时应显式记录 `correlationMissing`，不能把它当作完整链路。
6. **日志隐私和格式仍处于迁移态。** 新结构化 lifecycle 事件使用 hash correlation，但历史轮转日志仍含 raw viewer/socket/attempt 字段；Host 高频纯文本统计也未完全统一脱敏和降频。新的结构化 JSONL 与旧的 `/tmp/signal-server.log` 不能混合作为同一事实源。

### Goal 当前未完成项

线程 Goal 元数据当前仍是 `blocked`（这是此前缺少隔离原生 Lab 的阻塞状态），本轮复核没有把它误判为完成。按目标逐项判断：

| Goal | 当前结论 |
|---|---|
| freshness、`page-hidden` stale 门禁 | 代码、离线测试和部分 freshness 运行字段已完成；最近两天没有真实 `session_stale_detected → slot_released` 生产样本，仍未完成生产验收。 |
| receipt、summary gap、ring drop、input trace loss | receipt 状态和 input loss 已能进入新 summary；heartbeat ring 仍 close-only，全局 gap 没有统一进入单会话告警，`unknown` 仍很多，部分完成。 |
| 输入 ACK 到呈现的统一脱敏关联 | 字段契约和缺测语义已完成；没有真实业务输入到 visible effect/physical display 的完整样本，未完成。 |
| watcher 实际路由与 passive runtime | 当前运行态各探测层为 `ok`，代码已完成；入口延迟没有分位数门禁，历史 tunnel SIGTERM 最终发送者仍不可证，部分完成。 |
| 维护窗口验收 | 3 小时 passive continuity、within-grace、after-grace 显式重新请求控制、媒体恢复和浏览器协议键鼠已有通过证据；双 Viewer 失败，真实业务输入、可见效果、物理键盘、OS reserved、reset fault injection、capture backend A/B 仍 NOT RUN 或未达标。 |

另外，reset ACK 真实长会话的 200 ms 目标仍未证明；历史 405–496 ms 长尾虽不再是当前样本的普遍水平，但尚无端到端输入到可见效果证据。抓帧 A/B、诊断通道拥塞长会话和 tunnel SIGTERM 因果也没有完成。

### 结论与优先级

当前日志系统对“发现主要症状”已经足够，对“自动归因、会话可用性判定和性能验收”仍不够。最优先的补强顺序是：

1. 把 Signal 输出统一为单行 JSONL，固定轮转边界和查询索引；保留原始文本只作人工旁证。
2. 将 heartbeat ring/summary gap 改成周期 bounded snapshot，并在首次非零时立即产生会话级告警。
3. 强制每份诊断报告带 collector 状态、游标、reported/received/retained/redacted/dropped 和 gap/ring 原因，避免 `null` 被误读成零。
4. 在真实维护窗口采集一条完整 frame trace，并把 `inputToVisibleEffect` 与业务输入/可见 marker 绑定；没有这条证据就不能宣布控制稳定。
5. 给 watcher 增加入口分段延迟和 p95/p99 门禁，同时把慢入口与 viewer attempt 关联。
6. 完成隔离 macOS Lab 的真实输入、可见效果、物理显示、reset fault injection 和 capture backend A/B，再更新 Goal 状态。

因此，本轮没有新增 Goal 通过项；当前服务进程在线，但目标仍未完成。

## 核心 Goal 实施进展（2026-10-31 23:40 Asia/Shanghai）

本轮开始按“核心服务可用性”继续实施，仍未把隔离 Lab 作为前置条件。代码尚未重载 Signal/Host；watcher 已单独重载，固定域名 connector 未触碰。

### 已落地的实现

- Viewer v2 输入 envelope、Socket fallback、DataChannel 和 KeyboardTransport 现在都携带当前 `connectionAttemptId`；Signal 只接受当前权威 attempt，并把缺失的旧客户端输入补上当前 Host binding。旧 attempt 会以 `stale-attempt`/`wrong-attempt` 失败关闭。
- Host 在入队前校验并补齐 attempt，ACK 和 reset ACK mirror 回传该 attempt；Signal 的 `signal_input_relayed`、`signal_reset_ack_observed` 现在可以生成 `attemptHash`，缺失时明确写 `correlationMissing=true`，不再把空 correlation 当成完整关联。
- heartbeat 增加 60 秒 bounded online snapshot，并在诊断 ring 第一次 eviction 时立即上报；`ringDropped` 仍明确表示诊断环 eviction，不表示网络或视频丢包。关闭时会清理周期计时器。
- watcher schema 升为 3，按层保存最多 120 个延迟样本，输出 p50/p95/p99/max 和预算超限的 `slowLayers`；慢入口只产生 `entry-slow`/通知，不触发 tunnel 重启。
- 新增 `scripts/benchmark-capture-backends.py`，只测本机 MSS/CoreGraphics 原生抓屏调用，不改变生产默认后端，也不启动 Host、浏览器或 tunnel。

### 当前实测证据

- watcher 已加载新 fingerprint `446a539ad1b361ce204a971a` 和 schema 3。一次生产入口只读窗口记录 `formal-health` p95 约 3310.5 ms、p99 约 3310.5 ms、预算 3000 ms，`slowLayers=[formal-health]`；该窗口因 viewer-html/core-asset deadline 仍是 `entry-unknown`，action 为 `none`。固定域名 connector PID 保持不变。
- MSS/CoreGraphics 本机 A/B（每种后端 20 次、空闲和 1 个受控 CPU worker）均成功返回 1792×1120。空闲时 MSS wall p95/max 约 26.7/26.8 ms、thread CPU p95 约 9.1 ms；CoreGraphics wall p95/max 约 17.5/18.2 ms、thread CPU p95 约 0.55 ms。一个 CPU worker 下 MSS wall p95/max 约 40.1/46.0 ms，CoreGraphics 约 33.7/35.5 ms；两者非 CPU 等待仍占主要部分。该结果支持后续在相同负载下继续评估 CoreGraphics，但还不足以切换生产默认后端，因为 resize、编码、RTP 和 Viewer 可见帧尚未纳入同一窗口。

### 本轮验证

- Node signaling/remote input/reset ACK/heartbeat 定向集：166/166 通过。
- Web input/keyboard transport 定向集：269/269 通过；Python Host input/ACK/causality 定向集：45 passed、34 subtests passed。
- watcher/runtime/entry 定向集：21/21 通过；Python/Node 语法检查通过。

### 仍需完成

- 需要在 Signal/Host 维护窗口重载新代码，确认真实 `signal_input_relayed`、Host input observation、`signal_reset_ack_observed` 全部带同一 `attemptHash`；当前还没有新的真实用户输入到画面样本。
- 需要用真实 Viewer 验证 `page-hidden`、active media stall 的 `session_stale_detected → slot_released` 生产事件，以及槽位释放后新 Viewer 能进入。
- 需要补全 `summaryGap`、diagnostic ring eviction、lifecycle dropped events 到单会话 daily alert 的汇总，并区分“未观测”和“确认零”。
- 需要在实际会话里测 Viewer→Signal、Signal→Host、Host apply、ACK 回程、capture/encode/RTP/decode/present 的端到端 p95/max；当前 Signal→Host 局部 ACK 已有数据，但完整输入到画面仍缺测。
- 需要在相同用户会话负载下将 MSS/CoreGraphics 与 Viewer FPS、fresh capture rate、RSS、CPU、framesDropped 和可见效果一起对比，再决定是否修改默认 backend。
- 需要完成一次实际短断线、重连、持续控制和资源稳定性验收；当前服务仍在线，但尚未因本轮代码变更重载。

## 本轮重载结果（2026-10-31 23:36 Asia/Shanghai）

- 按 runbook 只重启本地 Signal/Host：Signal PID `2631`、Host PID `2664`；`/health` 和 `/api/status` 均为 `ok`，`hostOnline=true`、`viewerCount=0`、`mediaState=unknown`。
- cloudflared PID `26104` 保持不变，固定域名 connector 未重启；`/tmp/wrd-safe-current-url.txt` 仍为空。
- watcher 已加载 schema 3 和 fingerprint `446a539ad1b361ce204a971a`；固定域名页面的 HTML 请求已记录，但本轮浏览器自动化未完成登录，因此没有把页面加载证据当作 Viewer/首帧/输入验收。
- 重启后的 Viewer 网页密码和 Terminal admin 密码已按 runbook 从本机配置核对；密码不写入版本化日志和诊断摘要。

本轮服务已保持在线，核心代码已加载；Goal 仍未完成，下一步需要真实 Viewer 会话才能补齐 attemptHash、输入 ACK、媒体 freshness、首帧和端到端输入到画面证据。

## 新版本被动真实会话复测（2026-10-31 23:45 Asia/Shanghai）

- 使用固定域名执行 30 秒 relay 被动会话，`status=PASS`，31 个采样，`missing=0`、`late=0`、`failedObservations=0`、`identityChange=0`、`pathChange=0`，`maxObservedNoProgressMs=83.4`。
- Viewer/Host 实际状态为 `pcState=connected`、`mediaPhase=active`、`hasPaintedFrame=true`、H.264、relay/UDP，`framesDecoded` 从 18 增长到 608，`framesDropped=0`；`first-frame` mark 约 7902.7 ms，`signal-connected` mark 约 6191.6 ms。
- Signal 新日志出现 `connection_attempt_bound`，correlation 同时包含 `viewerHash` 和 `attemptHash`；说明新 attempt 关联已经进入生产进程。该会话没有发送业务键鼠/文本，因此 `signal_input_relayed`、Host apply、ACK 和 `inputToVisibleEffect` 仍保持缺测。
- 会话结束后观察到 `transport close → viewer_disconnect_grace_started → lease-expired → control_reset_completed → viewer_disconnect_grace_expired`，随后 `/api/status` 为 `viewerCount=0`。这证明正常被动断线后的租约清理和槽位释放在新版本中实际生效；它仍不是 `page-hidden` 或 active-media-stale 的生产触发样本。

这次复测把“新版本能建立稳定媒体、带 attemptHash、结束后释放槽位”推进到生产证据，但核心 Goal 的真实业务输入、输入 ACK、输入到画面、active-stall stale 释放和短断线后持续控制仍未闭环。

## 最新 Goal 审查与扩展验收（2026-10-31 23:58 Asia/Shanghai）

### 当前 Goal 是否需要修改

当前线程 Goal 仍保持 `active`，目标范围不需要替换：它仍然准确覆盖 stale Viewer、输入链路关联、诊断完整性、入口慢请求、抓帧长尾和真实会话验收。之前报告中“Goal 元数据仍是 `blocked`”属于更早一轮的历史状态；当前 Goal 元数据已经恢复为 `active`，本节结论以当前元数据和最新证据为准。

不把 Goal 提前标记完成的原因是仍有四个可验证缺口：

1. 没有真实 `page-hidden` 或 active-media-stale 触发的 `session_stale_detected → slot_released` 生产样本。
2. 没有业务输入与应用后帧/可见效果绑定的端到端 p95/max；当前 ACK 证据只覆盖协议和 Host apply。
3. 没有真实用户短断线后持续控制、RSS/CPU/FPS/framesDropped/可见效果联合验收。
4. capture A/B 仍是本机原生抓帧调用级结果，尚未在同一 relay/编码/浏览器会话中比较。

因此无需新建或替换 Goal；应继续沿用当前 Goal，并把上述四项作为完成门槛。`update_goal` 只能改变状态，当前证据不足以改为 `complete`，也不存在连续三轮同一外部阻塞来改为 `blocked` 的条件。

### 扩展验收结果

修复了 `scripts/runtime_reliability_acceptance_ext.py` 在 `/tmp/wrd-safe-current-url.txt` 不存在时的汇总崩溃，并重新执行扩展验收。结果写入 `/tmp/wrd-acceptance/task9-extended-report.json`：

- `9B_suspend_15s_no_media_growth`、`9B_resume_latency`、`9C_keyboard_browser_protocol_matrix`、`9B_mouse_double_click_drag`、`9C_terminal_open_and_pause_coexistence`、`9D_formal_entry_media_smoke` 均 **PASS**。
- `9D_trycloudflare_safe_url` 为 **BLOCKED**，原因是当前 safe URL 文件为空；遵守 runbook 未重建 tunnel。
- 物理键盘、OS reserved、reset fault injection、20 次 resume P95 仍为 **NOT RUN**，不能用浏览器合成事件替代。

扩展验收期间没有留下 Viewer；当前 `/health` 为 `ok`，`/api/status` 为 `hostOnline=true`、`viewerCount=0`。Signal PID `2631`、Host PID `2664` 在线，cloudflared PID `26104` 未变。

### 当前运行时信号与优化空间

watcher 已运行 schema 3，并持续保存分位数。当前状态为 `entry-slow`，唯一超预算层是 `formal-health`：31 个样本的 p50/p95/p99/max 约为 2135/4216/4429/4429 ms，预算 3000 ms；origin-health p95 约 24 ms，passive-runtime 无延迟。这个信号说明固定域名入口仍存在网络或 tunnel 路径长尾，但不会触发 tunnel 重启，也不能归因成 Signal/Host 内部故障。后续应把入口分段 TTFB、connector 日志和浏览器首帧按同一时间窗口对齐，再决定是否需要优化入口或仅调整告警预算。

### 下一步排序

1. 在用户可用的维护窗口做一次短断线、重连、持续控制和资源联合采样，优先得到真实 input-to-visible-effect 缺测的第一条生产证据。
2. 对 `formal-health` 长尾按入口 DNS/TCP/TLS/首字节/完整响应拆分，并与 cloudflared 保持只读关联；没有明确因果前不改 tunnel。
3. 增加单会话 summary 的 `summaryGap`、ring eviction、collector cursor 和 received/retained/dropped 的统一聚合，减少 `unknown`。
4. 在同一 relay/浏览器会话中复测 MSS/CoreGraphics 的 capture、encode、RTP、decode、paint、RSS、CPU、FPS 和 framesDropped，再决定生产后端切换。

当前服务保持可用态，Goal 继续 `active`；完成上述证据后再重新审查是否可以更新为 `complete`。

## 重置关联修复与直连生产复测（2026-11-01 00:31 Asia/Shanghai）

### 新发现与修复

复核 2026-10-31 16:00 UTC 之后的结构化日志时发现，`signal_reset_ack_observed` 已带 `attemptHash`，但 `control_reset_completed` 仍是空 correlation。根因是 Viewer 断开或租约过期后，`DesktopControlLease` 只保留 reset epoch，原 Viewer 的 attempt 绑定在进入 reset barrier 前就被清理，完成 ACK 没有可用上下文。

提交 `48382ed` 增加了有界的 `resetCorrelationByEpoch` 内存映射：断线、主动释放、租约过期和重绑失败在进入 reset-only barrier 时保存 `viewerId + connectionAttemptId`；Host 应用 ACK 后消费并清理该映射。没有 attempt 的旧/异常路径仍输出 `viewerHash`，同时显式 `meta.correlationMissing=true`，不会伪造 attempt。Signal 定向集合现为 **167/167** 通过。

### 重载后的固定域名会话证据

- 只重启本地 Signal/Host：Signal PID `17918`、Host PID `17953`；cloudflared PID `26104` 未变。
- 直连固定域名的 20 秒 passive 会话 **PASS**：21 个采样，`missing=0`、`late=0`、身份/路径变化均为 0，`pcState=connected`、`hasPaintedFrame=true`、`progressAfterBaseline=true`，首帧约 8.59 秒；结束后 `/api/status` 回到 `viewerCount=0`。
- 该会话的生产日志出现同一 attempt 的 `connection_attempt_bound → viewer_disconnect_grace_started → control_reset_completed`，`control_reset_completed.meta.correlationMissing=false`。
- 直连扩展验收重新执行，协议暂停/恢复、键盘矩阵、鼠标双击/拖拽、终端共存和正式入口烟测均 **PASS**；safe quick tunnel 仍 `BLOCKED`，没有按策略重建 tunnel。

### 输入与 reset ACK 局部耗时

扩展验收期间的新 Host 日志有 36 条 `host_input_received/result/ack_sent`，全部带同一 `attemptHash`，没有缺失关联。Host 入队等待 `hostAdmissionWaitMs` p50 约 0.24 ms、最大约 3.17 ms；本地执行 `localExecuteMs` p50 约 0.74 ms、p95 约 9.76 ms、最大约 13.00 ms。Signal reset ACK 有 1 条新样本，`signalRequestToAckMs` 约 4.04 ms，`correlationMissing=false`。这确认当前常规输入/Signal→Host→ACK 段不再解释历史 405–496 ms 长尾；完整 `input → visible effect` 仍缺少画面 marker，因此不能把这些局部数字当作端到端延迟。

### 入口代理误报边界

重载后第一次 passive runner 使用本机 `HTTPS_PROXY=127.0.0.1:7897`，在 TLS 阶段失败且 0 个采样；同一时刻 `curl --noproxy '*' https://link.stockhub.wiki/health` 返回 `status=ok`，清除代理后再次运行成功。因而当前 watcher 的 `formal-health` 长尾必须拆成“本机代理路径”和“真实公网路径”两类，不能据代理失败重启本地服务或 tunnel。正式入口直连证据已通过，但仍需要从真实用户网络采集公网路径 p95/p99。

### Goal 状态

本次修复完成了 reset completion 的关联缺口，但 Goal 仍保持 `active`。尚缺：真实 `page-hidden`/active-media-stale 生产触发、真实业务输入到画面的 p95/max、用户短断线后的持续控制与资源联合采样，以及同一 relay 会话中的 MSS/CoreGraphics 全链路 A/B。当前没有足够证据调用 `update_goal(complete)`。

## watcher 延迟窗口与 Viewer 槽位释放复测（2026-11-01 00:46 Asia/Shanghai）

- 提交 `3924158` 让 watcher 的延迟历史按 `proxyMode` 隔离；从 environment proxy 切到 direct 时清空旧 p95/p99 窗口，并增加 `latencyMode` 状态字段。watcher 重载后 source fingerprint 为 `fe9cb07adfb4804749e05b7c`，定向 watcher 集 **22/22** 通过。
- 新 direct 窗口中 formal-health 曾回落到 p95 约 1.2 秒；随后出现一次约 3.16 秒样本，当前 `entry-slow` 只表示 direct formal 入口偶发慢，origin-health p95 约 24 ms、passive-runtime 为 0 ms。它不授权重启 tunnel，后续仍需按 DNS/TCP/TLS/TTFB 分段定位。
- 两次真实 headless Viewer 进程退出后，Signal 短暂保留 Viewer 连接并最终自动清理：`viewer_disconnect_grace_started → control_reset_completed → viewer_disconnect_grace_expired`，`viewerCount` 最终为 0，reset completion 均带原 attemptHash 且 `correlationMissing=false`。这证明正常传输断开后的 grace/槽位释放闭环可用。
- headless Playwright 无法把 `document.hidden`/`visibilityState` 变为真实后台页；本轮没有把伪造属性当成 `page-hidden` 生产触发。`page-hidden`、active-media-stale 的代码和离线测试仍通过，但真实生产事件仍为缺测。

本轮新增 watcher 模式隔离、reset completion 生产关联和正常断开槽位释放证据；Goal 继续 `active`，不修改目标范围，也不调用 `complete`。

### 当前诊断摘要的权威读数

本地 admin observability summary 在本轮读取到：`summaryGapCount=81`，原因聚合为 `receipt-horizon`；`ringDropCount=0` 且 `coverageSignals.ringDrop.state=observed`，说明当前 ring 没有确认丢弃；诊断摘要窗口当时没有新的 diagnostic report，因此 `logCount`、FPS、丢帧和 `inputToVisibleEffectMs` 仍按缺测处理。这比把 `unknown` 当成零更安全，也证明日志系统现在能够区分“已观察为 0”“确认非零”和“本窗口没有诊断样本”。

### page-hidden 应用路径复测

通过真实 Viewer 的 `WebRTC.setMediaActivityReason('page-hidden', true)` 触发生产协议后，Signal 日志出现同一 attempt 的 `media_activity_requested(state=suspended,reasons=[page-hidden])`，约 0.6 秒后页面可见性守护自动发送 `media_activity_requested(state=active,reasons=[])`，说明短暂隐藏会恢复媒体，不会误释放正常会话。headless 浏览器无法保持真实后台页状态，因此没有形成 120 秒 `session_stale_detected → slot_released` 样本；这项仍保持未验收。该会话随后被中断，仍按 grace/reset 路径完成带 attemptHash 的槽位释放。
