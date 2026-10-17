# 媒体、输入背压与真实延迟测量设计

> 执行状态更新（2026-10-17）：用户已授权开发、验收、启动并保持本地 Signal/Host 可用。实现与独立复审已完成，公网实测正在反馈修复；实际部署、通过项和剩余验收以[实施记录](../reports/2026-10-17-remediation-execution.md)为准。watcher/tunnel 保持原运行边界，未重启或重建。

日期：2026-10-17。状态：设计已审查并实施，真实验收进行中。默认采用 superpowers brainstorming + writing-plans；用户已授权本轮实现及本地部署，不重复询问规划流程。

上位约束：[整改总设计](2026-10-17-reliability-latency-remediation-design.md) §3、§5–7、§9。实现计划：[媒体与延迟计划](../plans/2026-10-17-media-latency-plan.md)。本文只拥有 M1–M5；C 拥有控制权、reset 和 authority，W 拥有网页诊断消费及系统资源采样。

## 1. 问题与完成定义

已有[耗时诊断](../reports/2026-10-17-transport-input-to-frame-diagnosis.md)确认：ACK被标成输入到画面；编码前 frame_timing 甚至把未应用输入和旧截图关联；键盘执行计时在执行结束后才开始；codec generator 工作被记成 packetize；RTP observer 在实际发送失败前已计成功。普通生产无法据此给出真实可见效果。

[72小时Host证据](../reports/evidence/2026-10-17-three-day-review/host.json)固定窗口为北京时间 `[2026-10-14 02:15, 2026-10-17 02:15)`，实际保留从14日12:36开始，缺前10小时21分。16日02:18:33 wheel total=60871.6ms，其中 lock_wait=60846.1ms、to_thread=20.7ms；排队峰值1173。02:14:27可靠 up/reset 的 adapter-await 约32.06秒。因此 N4 按 P1 优先处理，不能仅调大输入超时。6390条loop告警不是完整采样，不能从其计算总体P95。大的 recv_total 还可能含主动暂停，不能当纯抓屏耗时。

完成须同时满足：控制和可靠顺序不被观测改变；输入/媒体持有队列有界；缺测诚实；正常及乱序/丢失/暂停/换作用域行为有回归；真实路径性能另按维护窗口验收。离线通过不代表生产或光学时延达标。

## 2. 方案比较

| 方案 | 取舍 |
|---|---|
| 只改标签、超时和缓冲大小 | 成本低，但保留假视觉关联及一分钟输入积压；不采用 |
| 保留传输协议，拆出纯测量、帧关联和有界工作队列 | 可独立模拟、保持控制契约、逐项验证；采用 |
| 改用新媒体/输入传输栈 | 增加兼容与部署成本，无法单独解决本机调度和错误计时；超出范围 |

不拆出第二个控制恢复器；新模块只封装计时、关联、队列和策略选择。`host.py`、`webrtc.js`、`input.js`、`signaling.js` 的适配按总计划串行，实施时先读取 C 的最新代码。

## 3. M1：统一测量与快照

### 3.1 对外接口

保留 classic script 全局 `LatencyMonitor`，`web-client/js/latency-monitor.js` 同时 CommonJS 导出 `{LatencyMonitor, LATENCY_METRIC_NAMES, createLatencyMonitor}`。导入只定义对象，不启动定时器、读DOM/localStorage或联网。

```ts
createLatencyMonitor({now: () => number, schedule?, cancel?}): LatencyMonitor;
setScope(scope: {connectionAttemptId:string,generation:number,leaseEpoch:number}|null): void;
recordInputSend(inputId, {scope, domAtMs:number|null, submittedAtMs:number,
  inputType, action, transport}): boolean;
onInputAck(ack, {scope, nowMs:number}): void;
onFrameTiming(notice, {scope, nowMs:number}): void;
recordStage(name, value:number|null, {scope, atMs:number, sampleKey:string}): boolean;
setMediaState(active:boolean, {scope, nowMs:number}): void;
snapshot({nowMs:number, scope}): LatencySnapshot;
takeClosedScopeSummaries({nowMs:number}): {summaries:Array<{endedAtMs:number,snapshot:LatencySnapshot}>,dropped:number};
```

`LatencySnapshot` 逐项遵从总spec §6.3：`schemaVersion:3`、`windowMs:5000`、原样scope、`metrics`及八个outcomes字段，不另创诊断快照。每个MetricSummary保留 `last,p50,p95,count,available,lastSampleAgeMs`。W只调用快照、按redactor处理scope，不重新计算阶段；尚未载入collector时W记录null/collector-unavailable。

冻结白名单 `LATENCY_METRIC_NAMES`：

```js
[
 'frontendDispatchMs','inputAckRttMs','hostAdapterAwaitMs','hostQueueMs','hostApplyMs',
 'signalForwardMs','signalAckForwardMs','inputToFrameNoticeMs',
 'inputToPostApplyFrameMs','inputToVisibleEffectMs','relayFrameAckRttMs',
 'paintIntervalMs','freshFrameAgeMs','candidateRttMs','jitterBufferMs','decodeMs',
 'recvBytes','elapsedMs','captureGrabMs','captureAgeAtRecvMs','capturePrepareMs',
 'frameConvertMs','imgprocQueueMs','imgprocBuildMs','encoderMs','packetizeMs',
 'encodeTotalMs','rtpApiAwaitMs'
]
```

recvBytes是字节，elapsedMs是对应采样时长，不把它们当延迟。rtpApiAwaitMs仅为Host一个RTP包调用发送API到成功返回的同钟区间，不能称整帧发完。freshFrameAgeMs是Viewer同钟自最后确认新captureSeq帧的呈现到当前快照的年龄；它不减Host的时钟。该项为即时gauge：有同scope有效关联时count=1、p50/p95=last仅作共享schema占位，暂停或未知则unavailable；UI/报告只展示当前年龄，禁止把这两个占位值当采样分位分布。其他项为5秒事件样本。M2成功关联时保留原始rVFC Viewer时间，以同scope/video stream的captureSeq高水位去重；暂停清空gauge但保留高水位，恢复后拒绝暂停前/期间已呈现的迟到关联，换scope清空高水位。普通paint、ACK、frame_timing及无身份标量均不能更新该gauge。

### 3.2 统计生命周期与容量

- 使用performance.now/monotonic，不混入Date.now。读快照和写样本均清理过期项；now早于本实例前一次时间时拒绝该次采样，不制造负值。
- 每metric最多256条，总样本最多4096；原始input pending最多512条/10秒；recent tombstone最多1024条/30秒。单ID最多128个ASCII字符。持有的序列化元数据总预算1MiB，不能存事件payload、DOM、VideoFrame或截图。JS对象额外堆开销须由W运行观测报告，不能把序列化预算冒充RSS硬上限。
- 达到观测容量只淘汰最旧诊断项，增加dropped/unmatched；不冻结输入、不撤销lease。每项只完成一次；重复ACK/frame notice不重复增加执行样本。
- outcomes是当前scope自建立起累计的 `sent/acked/rejected/timedOut/late/cancelled/dropped/unmatched`，饱和于Number.MAX_SAFE_INTEGER；不是每份报告可再相加的增量。ACK观测超时10秒独立于C恢复超时。迟到ACK计late，不补成功RTT；scope改变先expire、把旧pending计cancelled，生成旧scope final snapshot后才清空并建立新scope；旧计数不污染新scope。final snapshot进入最多4份/60秒/32KiB的closed-scope队列（不保留input ID或payload）；`takeClosedScopeSummaries({nowMs})`原子取出并清空、返回summaries及自上次取出后被容量/TTL淘汰的dropped数，W保存为有界作用域结束事件。该辅助接口不改变LatencySnapshot字段；没有W消费者时也不能无界增长或静默冒充完整历史。
- 同scope内的失焦/暂停清除paint前值，停止freshness gauge，不伪造几分钟paint interval；不擅自取消尚在处理的业务ACK。最后历史采样年龄可保留单个时间戳，过期窗口last/p50/p95仍为null、count=0、available=false。
- 只接受 `typeof value==='number' && Number.isFinite(value) && value>=0`。null、空串、undefined及无emitted frame均缺测。禁止Number(null)转换。

### 3.3 Host、Signal与relay边界

新增纯 `python-host/input_timing.py` 的 `InputTiming` 记录 queued_ns、started_ns、finished_ns；键盘/桌面输入在真正入队、executor开始及结束分别打点。hostAdapterAwaitMs仍由Host围住adapter调用；hostQueueMs覆盖内部等待至原生调用开始，hostApplyMs覆盖原生调用至返回。失败或缺hook的子段为null。M3外层Host准入队列等待发生在adapter入口之前，不计入这三个阶段；保留既有队列数量/字节/inflight/drop/frozen遥测。业务RTT减adapter总段后的剩余量仍含此准入等待及其他调度，不能称为网络耗时。

ACK v2控制字段不变；新增可选 `timingSchemaVersion:1, hostAdapterAwaitMs, hostQueueMs, hostApplyMs`，各值为有限非负数或null；`hostExecuteMs`作为兼容别名只对应真实adapter-await。Signal `input-ack` 显式允许并转发这些字段，绝不补0。**输入v2 envelope不加字段**，内部时间和authority都走旁路状态。legacy Host只提供旧字段时不声称可拆queue/apply。数据缺失不改变ACK业务校验顺序。

clock sync保留为诊断估计：一次pending最多2秒、成功结果有效60秒、30秒周期可重试；回包必须匹配当前scope和v0，换scope清除。跨机offset不用于任何上述业务/媒体阶段、自动降档或单向网络指标。

relay feedback一律从Host保存的frame提交monotonic值到相同frame ACK的monotonic差得到relayFrameAckRttMs。客户端latencyMs忽略作质量决策；frame不存在、过期、重复或旧generation ACK无样本。发送失败移除pending；成功样本含客户端解码/调度，标签为反馈往返。

## 4. M2：因果帧与可见效果

### 4.1 关联链

`python-host/input_frame_causality.py` 提供 `InputFrameCausality`：

```py
note_applied(input_ids, *, scope, applied_ns, status) -> int
reserve_for_capture(frame_key, *, capture_started_ns, reused, scope) -> tuple[str, ...]
commit_first_packet(frame_key, *, wire_timestamp, ssrc, scope) -> tuple[str, ...]
release_capture(frame_key) -> None
reset_scope(scope) -> None
```

仅status=applied（成功unordered move归一为applied）且原生执行成功的输入加入；duplicate/sequence-gap/resync-required/失败均排除。capture_started_ns必须严格大于applied_ns、同scope且非reuse。候选最多512/10秒/256KiB，待提交capture reservation最多4组；不持截图或业务payload。成功首包返回前只reserve，编码/发送失败release，不消耗候选；过期增加unmatched，禁止阻塞采集。

frame_timing仍只是通知，不能完成业务ACK。它可给inputToFrameNoticeMs，不能给任何visible项。另增加独立能力 `inputFrameCorrelationVersion:1`（Host能力→Signal runtime-context白名单→Viewer），只在本地aiortc ABI经过现有兼容检查时声明。该能力不改变inputProtocolVersion，不改变控制授权。

新增 `input_frame_binding` schemaVersion=1独立消息，含scope、streamId、captureSeq、encoderTimestamp、wireTimestamp、ssrc、`captureFresh:true`、`captureAfterApplied:true`和最多64个inputIds；不含payload或壁钟。仅首包发送API成功返回后产生。未知能力的Viewer忽略，旧Host下新Viewer仍正常控制，post-apply及visible项保持unavailable。现有严格 `frame_trace_batch` v1字段不被偷偷扩展。

基础关联只为存在pending输入的下一张合格帧建立有界记录；不保存所有帧历史。详细stage tracing仍由原flag控制。ABI不兼容或观测异常只关闭此能力，不改变媒体/控制。

### 4.2 RTP与呈现时间

observer把pre-await记录命名submitted，成功返回才计firstPacketAccepted和sourceToWire覆盖；异常时不bind、不record成功事件。第一包成功仍不等于整帧发送成功，rtpFrameSend/endToEnd未建立边界时继续null。RTX、RTCP、错SSRC/错generation不消费本帧绑定。

Viewer按attempt/generation/stream/ssrc/wireTimestamp匹配rVFC；SSRC来自该PeerConnection receiver的已验证映射，不假设rVFC metadata自带SSRC；无法唯一绑定receiver/stream/SSRC或没有RTP timestamp则unmatched，不近似“下一帧”。保存回调发生时的viewerClockMs，晚到元数据只能补join，不能改成now。匹配新捕获证明post-apply frame；任意原生应用是否已画出结果仍未知。

inputToVisibleEffectMs仅在既有受控producer真实输入guard、内容marker和匹配呈现帧三者一致时产生。不能用与原生输入独立的overlay当响应证明。rVFC是浏览器呈现回调，不是光学发光；物理验收单列。

### 4.3 collector长期容量

未启用关联/trace则不创建unmatched索引。等待join最多2秒/256项，seen tombstone最多2048项/30秒，待取matched最多128项/2秒；达到上限进行有界淘汰并增加dropped，不能让正常长流永久failClosed。同key内容冲突只标该观测scope不可信；不影响媒体或C授权。当前scope之外消息丢弃并计stale，不破坏新scope。15分钟、20FPS的18000帧fake-clock测试必须持续可匹配且容量不增长。

## 5. M3：JPEG隔离与输入背压

### 5.1 单专属媒体worker

`python-host/relay_frame_worker.py` 的 `RelayFrameWorker(process, *, max_pending=1)` 拥有一个线程；MSS在该线程创建、使用、关闭。`submit_latest(request)`只保存一个正在处理请求及一个最新待处理请求，`async drain()`等待现有pending/inflight结束且不停止准入，不把像素排进队列。request保存generation、尺寸、quality及采样参数，最大4KiB；generation变化/暂停时清pending并拒绝新提交，旧结果回到loop后先核验generation再emit。

一个输出编码包最多16MiB；不缓存输出历史，ACK窗口沿用现有上限。worker同时最多持一张BGRA捕获源及一张全尺寸RGB转换中间图；显式上限为BGRA源256MiB（最大8192×8192）、RGB中间图192MiB、每张目标64MiB且最多两张、16MiB编码包，应用可计数的缓冲预算≤592MiB。超限明确停止该媒体任务并报告，不自动缩小用户分辨率。原生库内部额外内存不能假装受Python计数精确约束，由W报告实际RSS。默认仍选择现有尺寸，不为了上限提高分辨率。

`async stop()`停止提交、清pending并等待正在运行工作退出；超2秒保持stopping、丢弃结果且禁止启动第二worker，不能声称线程取消。无原生协作取消时不能关闭正在使用的MSS；线程finally关闭后才完成stop。C输入reset不等待JPEG任务，但旧JPEG不能发送至新媒体generation。

### 5.2 编号前与Host准入边界

默认初始策略值（需真实验收调优，并非已测最优值）：Viewer move最多1项、wheel最多1项，在编号前合并，每16ms最多提交一个wheel；单次合并值限制在输入协议允许的有限范围，溢出显式拒收并触发C已有恢复入口，不拆成无限队列。尚未编号的可靠待办最多32项/128KiB，单项≤64KiB；不缓存DOM对象，文本只在短生命期内持有且不写日志。

Host `InputAdmissionQueue` 统一限制该scope的可靠待办64项/256KiB，另最多1个正在执行项≤64KiB；unordered move另留最新1项≤1KiB，不把wheel当可丢move。准入前按序列化字节校验；队列项持有单份规范化payload和固定元数据，不保留多份closure/envelope。上述为保留payload预算，语言/原生对象额外内存由W测量；任何数量/字节上限之一耗尽即拒绝继续分配。

消费C2提供的 `_capture_authority()` / `_authority_matches(snapshot)`，不新造authority。control epoch仅在同一已认证Signal连接生命周期比较；on_disconnect先增revision并冻结/静止/reset，新认证连接安全重开epoch命名空间但revision不回退。M以authority revision取消旧工作，不能把旧Signal的高epoch作为全进程下界。每次dequeue以及原生执行完成后的副作用提交重新校验；媒体同owner内部generation变化不自行淘汰输入。可靠序列只由现有keyboard/desktop sequencer在执行成功后commit。

容量耗尽：对当前拒绝项回现有resync-required（不能伪装applied），冻结该scope新准入及出队，交C控制恢复；已经编号的消息不能静默丢弃或越序执行。拒绝项计rejected；被authority变更终止的旧排队项计cancelled，两者不混为成功。Viewer pending至ACK/恢复完成受同样容量控制，不能只限制DOM临时队列却无限积累已提交消息。

C先冻结授权并递增revision，再调用M `async reset_after_quiescent(old_scope, apply_reset)`：停止旧scope出队，等待已运行的原生输入完成或得到可证明的隔离，然后调用现有keyboard+desktop release/reset。只有apply_reset返回applied且C再次校验新transition仍当前，才可ACK reset applied；超时保持blocked，不释放下一批输入。不得以取消asyncio任务假装原生线程停止。旧epoch队列终结cancelled、释放payload，绝不能在新epoch继续执行。

队列摘要统一 `snapshot() -> {pendingCount,pendingBytes,inFlightCount,droppedCount,frozen}`；W3 `RuntimeObservability.register_queue(name, snapshot)` 的name使用 `inputReliable/inputUnordered/relayFrames`。不传payload给W。

## 6. M4：阶段与reuse真相

| 指标 | 同钟边界 | 重叠/限制 |
|---|---|---|
| captureGrabMs | 后台MSS grab前后 | 不含异步等待 |
| captureAgeAtRecvMs | capture结束→recv选择该图像 | 与处理并行，不能当网络 |
| imgprocQueueMs | worker提交→worker开始 | 包含调度/排队 |
| capturePrepareMs | worker开始→数组整理/缩放结束 | 旧图时是复制；不含MSS |
| frameConvertMs | VideoFrame构造前后 | 不含prepare |
| imgprocBuildMs | prepare开始→VideoFrame构造结束 | 包含前两项，不能再相加 |
| encoderMs | 真正执行codec/NAL生成前后 | 必须消费generator，不能只量创建 |
| packetizeMs | 已生成NAL→RTP payload数组 | 不再含lazy codec执行 |
| encodeTotalMs | encode调用开始→packetize完成 | 包含encode/packetize，不能重复加 |

recv总段保留为诊断总段，主动pause/resume等待单列或从活动窗口排除，不能用于编码门槛。`reformat`无真实hook时null。RTP API耗时在M2定义，不能冒充网络发送完成。

captureSeq只在实际新抓屏成功时递增。重复输出保持旧captureSeq并标reused，PTS可继续合法递增；captureAfterApplied关联只选新图。Host发送capture_stats前先保存本窗口reuse，再清计数，避免当前N13“日志非0、wire总0”。当前源码生产工厂是CaptureExperiment(1.0,1)，本轮不改倍率；历史运行代码身份不能据工作区源码倒推，需求文档修正须标当前实现事实而非历史性能已验收。

## 7. M5：编码联合资格与性能验收

不直接把VideoToolbox资格从20FPS扩展到15/12。对20/15/12FPS、720p/1080p（含现有等高宽高比变体）分别验证codec、bitrate、slice/GOP/VBV与平台。`select_measured_media_policy(current, intent, qualification, *, context)` 返回 frozen `MeasuredPolicyDecision(policy, changed, reason)`。context是Host本地版本/机器/候选policy身份及Quality Lock状态，不能从Viewer或资格文件自报生成。qualification仅来自本地离线校验器产物，不能由Socket/DC上传改变资格。

**适用边界：只约束拟新增的自动自适应选择。** 既有启动、硬件不可用fallback、用户显式分辨率/帧率更改继续走原有resolver及media apply coordinator，不通过这个资格门禁。自动选择先纯计算候选并验证，成功后才请求coordinator原子应用；资格缺失/失败时保留当前intent、捕获尺寸、FPS、policy及generation，不得先改变capture intent再对失败建议ACK applied。它不自动换网络、TURN或分辨率，不破坏Quality Lock；实际应用失败沿用既有rejected与回滚语义。

### 7.1 Qualification v1 契约

实现于 `python-host/h264_encoder_policy.py` 的 frozen `QualificationContext` 与纯校验器；离线 `scripts/media_latency_qualification.py` 复用它，不让Host反向import scripts。JSON字段如下，未知/缺测均不能通过：

| 字段 | 精确含义与门槛 |
|---|---|
| schemaVersion / status | 1 / qualified；offline-only或NOT RUN不能启用策略 |
| identity | codeRevision、codecVersions（aiortc/PyAV/FFmpeg及实际codec/OS版本字符串字典）、machineDigest，逐项等于Host context |
| tuple | path、width、height、requestedBitrateBps、policy；policy为H264SessionPolicy的全部编码配置字段（仅剔除connection_attempt_id/generation），包含policy_id/codec_name/target_fps/preset/profile/码率上下界/VBV/slice/GOP/cooldown/force-IDR；逐项等于纯resolver候选 |
| inputContract | production-screen-bgra-v1、bgra、rgb24、转换成本归属，等于现有peak evaluator冻结契约 |
| scenes | 恰含static-text/health-static/scrolling-text/post-scroll-static/safety-net五场景；每场sampleCount至少65/1201/300/300/1226，validFrameCount=sampleCount，timeoutCount/droppedCount=0；所有汇总从逐帧记录重算，不采信passed:true |
| 每scene质量/成本 | encodeP95Ms有限且≤25ms（720高）/45ms（1080高）；criticalIdrCount>0且criticalIdrMinPsnr≥28dB（on-demand、需要检查的initial、safety-net）；initialSafetyIdrCount>0时initialSafetyMaxChangeMae≤3；periodicIdrCount>0时periodicMaxChangeMae≤3；earlyPeriodicIdrCount=0；contractViolationCount=0 |
| runtime | status=passed、path等于tuple.path、durationMs≥10800000、inputSampleCount≥100、loopSampleCount≥1；loopP95Ms/inputAckP95Ms有限，relay/TURN分别≤50/150ms；resources要求condition=normal、samplerComplete=true、sampleCount≥1、unknownCount=0、pressureWarningCount=0，并保存实际RSS、swap、队列数值 |

25/45ms、28dB、changeMAE≤3、早期周期IDR禁止及逐帧/codec实例/参数一致性，来自现有 `scripts/eval-turn-encoder-quality.py::_evaluate_resolution_gates` 与 `scripts/turn_encoder_peak_headroom_experiments.py::validate_full_matrix` 门禁；不得仅检查上表摘要而跳过逐帧PTS、inputHash、bitstream IDR、codecCreationRecords及options校验。新matrix版本按90kHz/fps推进PTS，早期pulse用0.8–1.5秒定义（20FPS才等于16–30帧），期望IDR和实际GOP按该候选计算，不直接把旧20FPS索引拿去判15/12。上述最小场景样本数沿用现有五场景长度，3小时来自总验收要求；100个业务输入为新增初始最低覆盖策略，须在真实维护验收中调优，不是统计置信度保证。

资源normal必须由W完整采样器依既有健康规则给出，unknown不能冒充normal；swap/CPU等数值仍保存，不以臆造新阈值取代系统压力判断。正常资源资格与压力场景分桶，后者另存失败和恢复证据；不得用压力样本均值洗掉正常桶门槛。除TURN已有数值目标外，direct路径仍要完整记录，不宣称新设未有需求依据的硬阈值。`validate_joint_qualification` 对原始矩阵重算并生成本地摘要，`validate_policy_qualification` 再核对当前身份、tuple与上述门槛；任一失败返回有限reason，选择器不触发重试循环。

### 7.2 代码完成与真实资格分开

先完成纯fixture、选择器和禁用默认行为并独立review/提交；真实资格未取得时本任务代码可以完成，但扩展自适应仍disabled，真实矩阵和3小时连续验收保留NOT RUN。不能把未获本轮授权的真实编码/抓屏/输入验收作为文档或纯代码提交的前置条件。

维护窗口下才运行同内容、同分辨率、同码率预算与资源条件的实际矩阵；不同codec现有日志均值不能当A/B，不以跨钟relay latency降档。原生重开codec走既有coordinator且idempotent。真实inputToVisibleEffect用受控内容，150–200ms只是历史稳态目标。各路径短时通过后至少3小时连续会话，不抢占人工Viewer。buffer上限、采样成本和资源占用必须记录，若观测扰动目标则缩小诊断采样，不牺牲控制正确性。

## 8. 覆盖与交付

| 任务 | 问题 | 依赖与交付 |
|---|---|---|
| M1 | L1/L3/L4/L6/L7/L10 | 总snapshot契约；C的ACK适配先落地后接入；W直接消费 |
| M2 | L2/L5/L8/L11 | M1、C身份；正确时点、旧帧/拒绝输入排除、bounded join |
| M3 | N2/N4(P1) | C2权威与reset接口；有界FIFO、原生quiescence、单JPEG线程 |
| M4 | L12/N13及capture语义 | M2；真实generator阶段、reuse和暂停计数 |
| M5 | N3 | M1–M4、W完整loop/资源采样；资格门禁与真实验收 |

实现按任务保存红绿行为测试、独立 review 和精确提交；未知原生安全退出、协议兼容或真实性能结果不得写成已解决。
