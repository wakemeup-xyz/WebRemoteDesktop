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
