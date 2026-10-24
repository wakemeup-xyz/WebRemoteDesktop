# 2026-10-24 持续断连专项诊断

日期：2026-10-24（Asia/Shanghai）
原始基线截止：19:42 左右；下方历史聚合统计使用该窗口。21–22 点补充源码归因和实施复核，加载及最新运行结果见 [控制恢复修复记录](2026-10-24-control-recovery-fix-execution.md)。
基线阶段为只读。初期恢复/诊断修复仅重启Signal；10月25日调度配置修复后已按脚本重启Host，tunnel始终未重启。不能将基线状态当作当前状态。

## 结论先行

最新实施结论（10月25日）：Signal/Viewer `a88f7fe` / build `79d27719867d5814` 已加载，五次严格原租约短断线恢复3.994–5.000秒，30分钟公网TURN被动连续性通过；Host Python `9e352fc8` / PID64981，两个本地服务均为Interactive，tunnel未操作。实测慢抓帧仍主要含非CPU等待，公网ACK也有独立额外耗时，不能全部归为Host计算忙。真实输入可见效果和全部性能门槛尚未通过，具体证据及版本见[实施记录](2026-10-24-control-recovery-fix-execution.md)。

以下为10月24日截至19:42的原始基线，不能代表修复后的当前故障率。原窗口存在三个故障面：

1. **Host 抓帧长尾与系统资源压力均已观测到，因果需要分开。** 当前 WebRTC 连接可以保持 `connected/completed`，但 MSS 抓帧仍有数百毫秒到数秒的耗时。21:33 的新增反例表明，抓帧暂停时事件循环也会卡顿；不能断言抓帧线程导致了全部 ACK、ICE 或事件循环超时。慢帧的线程 CPU/非 CPU 配对分析见下方复核。
2. **媒体恢复多次遇到关闭 PC/sender，需要复现生命周期缺口。** 今天出现 42 次 `host_media_resume_failed`，全部是 `reason=closed`、`sender=false`；另有 30 次恢复成功。计数和时序提示恢复 churn，但要区分新 offer 正常过渡、用户主动重连和真正的重复恢复缺陷。
3. **Viewer/入口确实有 transport close，但 Signal 进程不是崩溃根因。** 今天 5 次 Viewer Socket 断开，其中 4 次是 `transport close`、1 次是客户端 namespace disconnect；仅 1 次在 30 秒宽限内完成 rebind，4 次宽限到期。心跳快照同时出现“ping/pong 完整后 transport close”和“没有 pong 后 ping close”，不能归结为单一服务器心跳超时。

当前应先区分整机 CPU/换页压力和 native 抓屏等待，同时复核 sender/PC 恢复过程；进程隔离只是待验证候选方案。不能仅凭墙钟长尾就确定 GIL 根因，更不能承诺换进程后抓帧必然变快。

## 运行状态和证据边界

- 本地 `wrd_service.py status`：Signal、Host 均存活，`health_ok=true`、`host_online=true`；当前状态查询时有 1 个 Viewer。
- 本地 `/health` 正常；正式域名首页和 `/health` 在 19:40 左右均返回 HTTP 200，`/health` 返回 `status=ok`。所以本次检查时不存在“网页入口整体不可达”。
- `/tmp/wrd-safe-current-url.txt` 当前不存在，safe quick tunnel 没有可用 URL。这个事实只说明 quick tunnel 入口不在当前运行证据中；没有据此重建 tunnel，也没有把正式域名与 quick tunnel 混为一谈。
- Signal 结构化日志的 entry window 在今天窗口内持续完整（无 missed window、logger/store failure）。Host 日志采用 `back-debug.log.3`、`.2`、`.1` 和当前文件，实际可覆盖约 08:18:38–19:42；00:00–08:18 没有 Host 运行日志，不能推断该段 Host 指标。
- `host.log`、`front-debug.log` 的内容不是今天这条运行链路的完整证据，未用于证明今天的 Host 性能。

## 今天的事件时间线

### Signal、Socket 和控制状态

Signal 结构化日志今天截至 19:42 的计数如下：

| 事件 | 次数 | 解释 |
|---|---:|---|
| `signal_socket_disconnected` | 5 | 4 次 `transport close`，1 次 `client namespace disconnect` |
| `viewer_disconnect_grace_started` | 5 | 每次宽限 30 秒 |
| `viewer_reconnected` / `viewer_rebind_confirmed` | 1 / 1 | 只有一例在宽限内完成迁移 |
| `viewer_disconnect_grace_expired` | 4 | 4 次没有在宽限内恢复 |
| `diagnostic_uploaded` | 17 | 其中多次自动失败快照 |
| `control_transition_failed_closed` | 16 | 大多数为 `released`，另有 `transition-timeout`/`lease-expired` |
| `control_reset_completed` | 15 | 复位最终多为 `FREE/applied`，但过程可能经历多次 retry |
| `connection_attempt_bound` | 120 | 包含同一 attempt 的幂等绑定，不能直接当作 120 次用户断线 |

关键时刻：

- 11:39：`signal-connect-error`，客户端快照已有 4,042 条被淘汰的诊断 trace 和 9 条到期的 ACK 观察记录；这不是 4,042 次键鼠投递丢失。
- 12:03–12:05：`input-ack-timeout`、`negotiation-timeout`，随后 Socket transport close；30 秒宽限到期。
- 13:54：第二次 transport close，约 3 秒后 `viewer_reconnected` + `viewer_rebind_confirmed`，这是今天唯一明确成功的原会话恢复。
- 14:37：transport close，宽限到期；14:46 是客户端 namespace disconnect，随后也到期。
- 18:12：`dc-stuck` 与 `input-reset-ack-expired` 后 transport close，宽限到期。
- 19:34：最新一轮仍在发生 `input-ack-timeout`，客户端诊断 trace 淘汰数=3,034；服务端经历 `transition-timeout` 和两次 retry，最终完成 reset。ACK 超时和恢复失败是真实症状，但 trace 淘汰数不能充当输入丢失数。

心跳关闭快照的 `node.status` 均为 `ok`，但各会话状态不同：有的在关闭前 ping/pong 计数完整、WebSocket buffer 为 0；有的在 20 秒 ping 窗口没有收到 pong；还有一例明确是客户端 namespace 主动断开。因此 Signal 的进程健康和 Viewer 的 transport 稳定性是两个不同指标。

### Host、媒体和输入

今天 Host 日志的完整可用窗口约从 08:18:38 开始，聚合结果为：

| 指标 | 今天观测到的结果 | 含义 |
|---|---:|---|
| `host_event_loop_lag` 窗口 | 7,295 | 采样持续运行，并非偶发单条日志 |
| `maxLagMs` 快照的 p95 / 最大值 | 399.7 ms / 2,803.4 ms | 滚动窗口最大值的分布，不能当作全部逐次 lag 的 p95 |
| `eventLoop.p95` 字段的最大值 | 1,072.2 ms | 不是单个采集线程的孤立慢，而是会影响 asyncio 调度 |
| Host RSS p50 / p95 / 最大值 | 381.5 / 455.3 / 485.7 MiB | 高水位持续存在；peak RSS 525.6 MiB |
| `capture.lastDurationMs` 快照 p95 / 最大值 | 415.2 ms / 2,402.5 ms | 是最后一次操作的采样快照；暂停时会重复旧值，不是逐次抓帧 p95 |
| `capture.maxDurationMs` 快照 p95 / 最大值 | 4,162.7 ms / 4,624.8 ms | track-lifetime 历史高水位被重复采样；能确认极值，不能推导频率 |
| 滚动窗口最大抓帧间隔的快照 p95 / 最大值 | 1,911.9 ms / 4,627.7 ms | 能确认新鲜画面间隔长尾；不是逐帧间隔 p95 |
| Viewer Stats 样本 | 23,457 | 覆盖多个会话/重连 |
| Viewer FPS=0 样本 | 15,362（65.5%） | 其中包含 `page-hidden` 主动暂停，不能全算网络丢帧 |
| 全部 FPS 样本 p95 / 最大值 | 19.1 / 25.0 | 包含暂停期 0 FPS；不是仅非零样本的分布，也不表示新鲜画面速率 |
| Host 输入 `total` 耗时 p50 / p95 / 最大值 | 65.7 / 265.8 / 1,910.3 ms | Host 侧处理耗时，不是 ACK RTT 或输入到可见效果 |
| `host_media_resume_failed` | 42 | 全部 `reason=closed`、`sender=false` |
| `host_media_resumed` | 30 | 多为失败后的反复恢复 |
| `TransactionTimeout` | 3 | TURN/STUN 事务超时 |
| `socket.send() raised exception` | 34 | 发送链在断连/重协商期间持续报错 |
| `WRD_KEYFRAME reason=media-stalled` | 30 | 停帧后的补救频繁触发 |
| `PC not ready, buffering candidate` | 18 | 候选早到，需核对 attempt 和上限；不能单凭该日志认定竞态或无限缓存 |
| stuck mouse release | 29 | 输入中断后依赖清理逻辑释放鼠标按钮 |

现场快照（约 19:42）显示：Viewer FPS 18.9、RTT 47ms、PC `connected`/ICE `completed`，但 Host 最近一次抓帧耗时 184.3ms、滚动抓帧速率约 5.44Hz，RSS 449.2MiB，`inputUnordered.droppedCount=18,637`。解码 FPS 可包含缓存帧复用，不能代替新鲜画面速率；unordered 累计 drop 包含有界队列的主动替换，不等于 18,637 次可靠键鼠操作丢失。这些指标提示体验风险，但没有单独证明可靠输入中断的根因。

Host 今天有 7 次明确的 `media_activity_requested(state=suspended, reasons=[page-hidden])`。这些是浏览器页面隐藏触发的主动媒体暂停；页面恢复后又多次遇到旧 sender 已关闭，形成 `resume_failed → new offer/PC → candidate buffering` 的恢复风暴。UI 当前如果把这类状态简单显示为“断连”，会误导用户和排障。

### 输入与诊断证据的限制

- Signal 的 124 次 `signal_input_relayed` 都表示信令层接受，不等于 Host 已执行或画面已可见；Host 的 `host_input_result/ack` 才是执行证据。
- Host 有 2 次明确 `stale-lease/unbound-channel` 拒绝；这属于旧 DataChannel 输入迟到，说明 fail-closed 生效，但用户体验仍是“按键没反应”。
- 自动诊断快照的旧 `logCount=0` 是 schema 3 原文脱敏策略的结果。`inputTrace.droppedEvents` 从几百到 5,000 级，指有界诊断 ring 淘汰/脱敏丢弃条目，不是键鼠输入未投递。实际 ACK timeout 和恢复状态应看独立事件；当前仍保留有限的结构化状态转移，不能还原全天完整历史。
- `DC_DIAGNOSTIC_ADMISSION` 的 drop 是诊断通道拥塞/不可用（某些会话出现 `congested` 或 `unavailable`），不是媒体 RTP 丢帧；`capture_stats` 的 drop 仍为 0。报告不把两者混为一谈。

## 排查优先级与待验证因果

### P0：抓帧长尾与事件循环等待的因果仍需分离

现有 `ScreenCaptureTrack` 已有后台 MSS 抓帧线程、latest buffer 和独立单线程图像 executor；`recv()` 不直接执行或等待 native grab。生产 factory 已使用 `CaptureExperiment(1.0, 1)`，即 1x 抓帧和 OpenCV 单线程。本机 MSS 10.2.0 走 ctypes/CoreGraphics，CDLL native 调用期间释放 GIL，不能归因为“MSS/PyObjC 一直持有 GIL”。Python 像素复制、GIL 重新获取、WindowServer 等待和全机调度/换页压力均需进一步区分。

21:24 的慢帧为 wall=3,905.411ms、抓帧线程 CPU=39.383ms、非 CPU=3,866.028ms（99.0%）；21:33 抓帧暂停超过 8 分钟时，event-loop 滚动 max 仍为 2,014.977ms。这支持“等待/资源压力与抓帧长尾共存”，不支持“抓帧计算占满 CPU 是唯一原因”。详见 [CPU 归因复核](2026-10-24-capture-cpu-attribution.md)。

### P0：核对关闭 PC/sender 的恢复是否重复

`host_media_resume_failed(reason=closed)` 多次出现，附近有新 offer、候选缓存和 keyframe 请求。现有 fail-closed 和媒体锁已存在；应以同 attempt/generation 的最小反例区分正常替换过渡与重复恢复缺陷，不能仅由这些事件共现认定旧 PC 未被淘汰。

### P1：核对 Viewer transport/公网路径的异常来源

4 次 transport close、3 次 TURN/STUN timeout、34 次 socket send exception 是传输异常线索，尚不能仅凭数量定位到公网路径或 TURN 的某一层；但 Signal 进程健康，且部分会话在 ping/pong 完整时仍被关闭，所以不能把责任全部归给 Signal 心跳，也不能只靠延长 grace。

### P1：页面隐藏被表现成“断连”

7 次 `page-hidden` 暂停会让 FPS 正常变成 0。若浏览器把页面放后台、设备锁屏或切换工作区，Viewer 可能看到黑屏/停帧；这是浏览器生命周期策略，应该显式呈现为“页面隐藏，媒体暂停”，并在重新可见时走一次受控 resume。

### P1：输入诊断计数语义错误与覆盖缺口

22 点源码复核确认：schema 3 主动清空控制台原文后，旧 ingest 用清空后的数组长度生成 `logCount=0`。这只能说明原文未保留，不能证明客户端未采日志。删除事故前检查的 7 份普通 v3 report 各有 256 条结构化 input trace；scope-ended 独立记录不应混算。原 raw 后因旧测试隔离缺陷被删除，已提取摘要及损失范围见上述修复记录。新计数区分上送、保留、脱敏和结构化 trace。ACK RTT、Host 执行与可见效果仍需分开，不得互相代替。

## 解决方案

### 第一阶段：隔离抓帧和控制调度

1. 用每次完成的去重样本和墙钟/线程 CPU 配对，比较活动、主动暂停、低系统负载和高系统负载窗口；补采全机 CPU idle、swap 差分以及 native 抓屏等待。
2. 保留已有 latest buffer 和图像 worker。在隔离实验中比较现状、独立 capture 进程、原生异步抓屏流；只有实测改善控制调度且成本可接受才选择替代方案。进程隔离不保证消除 WindowServer 或全机换页延迟。
3. 保持当前生产 1x 抓帧与 OpenCV 单线程，不重复实施“2x 改 1x”。FPS 自适应、网络和分辨率变更需遵守既有 qualification/quality-lock 契约，不因本报告自动降档。
4. 增加 deadline/stale-frame 状态与窗口内有效抓帧速率；使用抓帧 p95≤100ms、max≤250ms 作为实验目标，达不到时记录真实瓶颈，不能伪造成功或无限重用旧帧。

### 第二阶段：重建关闭 sender/PC，停止恢复风暴

1. 每个 `connectionAttemptId + generation` 只允许一个 resume operation；同一操作的重复 `media_activity` 合并，禁止并发 offer。
2. 发现 `pc/sender=closed|failed` 时立即作废旧 DataChannel、候选缓存和 sender 引用，进入一次有界 fresh-offer；不要在旧对象上继续 retry。
3. 对 TURN/STUN timeout 和 `socket.send` exception 使用一次退避重试；超过预算直接报告 `transport_unrecoverable`，由 Viewer 启动一次新 attempt。候选只接收当前 attempt，旧候选计入 `staleCandidateDropped`。
4. 将 `host_media_resume_failed` 按原因拆成 `closed`、`fresh-capture-timeout`、`ice-timeout`、`sender-rejected`，并让控制层使用明确状态，而不是反复把所有失败折叠成 `released`。

### 第三阶段：输入和可见效果闭环

1. 键盘、鼠标 down/up、reset 走可靠通道；鼠标 move/wheel 继续 latest-only，但对 `droppedCount` 设置告警和采样窗口，避免无限累积。
2. DataChannel 卡住或 ACK 连续超时后，可靠输入立即切到 Socket.IO fallback；恢复后再切回 DataChannel。fallback 期间不重放旧鼠标 move，不阻塞键盘和按钮释放。
3. Viewer 自动诊断分别统计上送/保留/脱敏日志和结构化 trace，同时保留 transport/PC 状态、ACK timeout 和输入 gate；Host receipt 关联 `input_received → input_result → frame_timing → marker/rVFC`。缺测保持 `null/NOT RUN`。
4. 页面隐藏单独显示媒体状态，恢复时只触发一次受控 resume；不把 `page-hidden` 计入网络断线率。

### 第四阶段：验收和上线门槛

- 30 分钟正式域名长会话：event-loop p95≤20ms、max≤100ms；capture p95≤100ms、max≤250ms；活动期 decoded FPS p50≥18、新鲜抓帧 cadence≥15 FPS；暂停期单列，缓存复用不计新鲜帧；RSS 无持续单调增长。接收端视频帧丢弃、RTP丢包及freeze各自单列，不与诊断drop混算。
- 五次不超过 20 秒的短断线：每次在grace内完成原租约rebind、恢复≤10秒；可以创建新媒体attempt，但重新获取新lease不能算strict within-grace通过；不得出现旧 lease 输入执行。
- 真实业务输入/reset验收（不含heartbeat）：ACK p95≤200ms、max≤1,000ms；控制 reset ACK 过期为 0；marker→rVFC 的 `inputToVisibleEffectMs` 覆盖率≥95%。
- 诊断验收：分别报告 `reportedLogCount`、`retainedLogCount`、`redactedLogCount` 与 `inputTraceEventCount`；原文禁止保留时，保留条数为 0 是正常策略。未知上送计数保持 null/缺测，不要求伪造 `logCount>0`。`summaryGapCount=0`，ring drop 单独标注为诊断环覆盖计数。
- 维护窗口结束时保持本地 Signal/Host 可用；不以停止服务或重建 tunnel 作为通过条件。

## 当前建议

本地服务和正式网页入口健康。已完成最小恢复缺陷复现、代码修复及当前版本五次短断线/30分钟被动验收；剩余工作是公网输入延迟、受控采集后端A/B及真实可见效果。不得把snapshot p95当作逐次抓帧p95、unordered drop当作可靠输入丢失，或把所有超时归因CPU。当前仍不能宣布全部性能与业务输入验收完成。

## 22 点复核发现的可复现代码缺口

- 真实 Host validator、Viewer runtime 和虚拟时钟联合反例复现：active 已成功 ACK、尚未收到新鲜帧时 soft replay 同 generation；Host 拒绝 `stale-generation`，Viewer 抹掉原成功 ACK，又清掉 fresh-frame fallback。重复失败被去重后，request/fresh-frame 计时器同时缺失，后续真实新帧也因 `no-active-ack` 被拒，永久停在 resuming。该反例证明代码存在缺口，不证明今天每一例断控都经过该时序。
- 真实 WebRTC/Input 联合反例复现：`channel.send()` 同步抛出 OperationError/InvalidStateError 会越过 Socket fallback。应仅在实际发送处返回 false，让现有安全 fallback 接管，序列化错误仍保持可见。
- schema 3 `logCount` 来源为脱敏后的空数组，属于确定的计数语义错误；7 份普通 report 的结构化 trace 均有 256 条，不能叫作“空诊断”。
- 19:34 Host 对 reset544/reset128 已执行并入队 ACK；故障快照采集时 Viewer 未出现对应 ACK trace。`ackAccepted=true` 仅证明 Host 入队，不能据此认定 Viewer 接收校验错误。复用 reset 继承原 3 秒 deadline 也符合现有安全契约，不延长预算掩盖链路延迟。

实施与实际加载结果见 [控制恢复修复记录](2026-10-24-control-recovery-fix-execution.md)。

## 10月25日追加定位

部署前低负载长会话中，抓帧rolling约25ms，但pacing请求约25ms、实际约100–105ms，原生栈主要在nanosleep。部署前Host和Signal都是launchd默认daemon3、线程priority/max20/20；同LaunchAgent独立Interactive候选为31/63且两轮timer长尾显著更小。现已加载Interactive，实测pacing等待改善，但不同负载窗口不是受控A/B。不能继续简单归因为Host CPU计算满载；全机压力、CoreGraphics等待仍各自存在。probe来源、未完成的逐帧/输入验收及维护加载结果，见[CPU归因复核](2026-10-24-capture-cpu-attribution.md)和[实施记录](2026-10-24-control-recovery-fix-execution.md)。
