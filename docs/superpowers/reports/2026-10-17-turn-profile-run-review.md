# TURN有界profiling诊断轮次复核

2026-10-17。目录`/tmp/wrd-owned-turn-probe-private/turn-profile-20261017a`。本次只读取已完成工件、对应inode/offset内日志，无浏览器、服务、进程操作；未改源码/index，只写此0600报告。

**原helper结果PASS，仅代表该轮300.157576秒被动连续性；本轮是带旁车观察的诊断，不是三小时验收或综合性能合格。Native sample未触发，未取得停顿栈；14:07那次13.8秒失效原因仍未闭环。**

## 1. 证据覆盖

完整读取session/summary.json、301行samples.jsonl、lifecycle.json、preflight.json及supervisor.json。helper哈希2dfc5ee1…，sampler b47bfa43…；supervisor记录diagnosticPerturbed=true，虽然没有执行sample，旁车轮询仍应视为观察开销，不能说无扰动受控基线。

只从preflight到logsAtEnd读日志，核对当前device及inode和两端一致，没有读结束offset后的追加：

|来源|inode|字节范围[start,end)|读取量|
|---|---:|---|---:|
|Host back-debug.log|43240044|2105083–2349310|244,227B，888行|
|Signal /tmp/signal-server.log|31830923|1854557–1858042|3,485B，71行|

合计247,712B，低于2MiB。浏览器performance.now12391.199999809→312390.899999857ms，差299.999700000s；使用该浏览器timeOrigin标记的采样窗约北京时间14:28:59.196200–14:33:59.195900。只以其标记选择Host日志，不用跨机/墙钟相减计算媒体单向延迟。

按上述采样窗再次筛选Host，831行，其中53份event-loop、59份encoder、59份CAPTURE_STATS及300份VIEWER_STATS。聚合日志用结束时刻落窗，首窗可含暖机，末尾未完成聚合窗未纳入；因此不能把它们当与301个浏览器样本严格相同的逐帧总集合。sampling窗内没有WRD_FRAME_TRACE_SUMMARY、Host signal-disconnect、packet-queue错误或peer关闭记录。

## 2. 连续性、帧和浏览器指标

helper请求300秒，实际300.157575812秒；301样本，missing/late/failed/identity-change均0，最大观察无进展433.316ms。所有样本build a6e8b15122bde656、scopeStable true、Socket与PC connected、同PC/attempt/generation/lease、active/inputAllowed true；relay/relay UDP，tunnelRelayActive false。输入门开放是状态证据，没有执行原生输入。

Decoder6→5733，+5727/299.9997s≈19.0900帧/s；rVFC callback7→5651，+5644≈18.8134次/s。相邻decoder增量11–22，未见零进展采样。frameAge快照min/median/max=1.6/29.2/222.3ms。rVFC和decoder推进不证明每帧都采到新内容或物理屏幕真的呈现。

以下只是snapshot last值范围及中位数，不是全场P95、单帧分布或可相加的端到端阶段。应用5秒滚动P95未汇总成“总体P95”。

|指标|有效snapshot|last min / median / max(ms)|
|---|---:|---|
|Candidate RTT|301|28 /31 /197|
|Jitter buffer区间均值|299|0.8 /8.5 /26.4|
|Decode区间均值|299|0.479 /0.690 /3.263|
|Paint callback interval|301|16.6 /50 /433.316|

前两份buffer/decode缺测保留。全部301份inputAckRttMs、inputToPostApplyFrameMs、inputToVisibleEffectMs、hostQueueMs、hostApplyMs、hostAdapterAwaitMs、freshFrameAgeMs、encoderMs、relayFrameAckRttMs均available=false且last/p95=null。没有输入时延数值，不用RTT、encoder日志或rVFC补位。

## 3. Host编码、采集、调度和资源

59个encoder聚合窗（14:29:04.131–14:33:55.837）共5669次，按count加权平均4.7618ms；窗口均值3.854–8.545ms；窗口P95范围5.821–15.257ms；**任一已报告单次最大329.356ms**。这仍为encoder.encode函数的wall time（含调度及内部处理），不含executor队列/RTP发送await。1次safety keyframe，forced/periodic/PLI均0；VideoToolbox、relay-peak-sliced-v1保持。宽窗中14:28:58.483仅一条Opening，发生在采样baseline之前；未见运行中重开风暴。

59份capture聚合窗共5643输出、2980 reuse，复用52.8088%；FPS窗口14.8–19.7、median19.3，convert均值1.9–5.3ms，recv_total均值43.3–48.5ms，sleep均值30.5–39.1ms。capture_wait=0仍是latest-slot设计占位值，不能称实际MSS grab零耗时；recv_total含节流，不能称纯截图或纯编码。

53个Host probe的首末14:29:04.108–14:33:54.892，captureSeq58→2766，+2708/约290.784s≈9.3128次新截图完成/s。它不是内容变化次数，latest slot可能覆盖未消费capture，不能和非reuse输出逐一配对。约19.09decoder fps不等于19.09新capture fps。

进一步只用既有capture窗口核对：首窗74输出/39复用含暖机，显式排除此窗后58窗5569输出、2941复用、2628个非复用输出候选，复用52.8102%。这58窗从首窗结束14:29:02.523到最后结束14:33:54.404，日志墙钟标签跨度约291.881s，对应约19.0797输出/s和9.0037非复用候选/s；由于没有保留每窗单调起止，只称该近似速率，不把墙钟标签用于传输时延。与Host captureSeq约9.3128/s一致地表明：正常窗约一半输出使用缓存，fresh throughput低于20fps目标。两者起止不同（captureSeq在14:29:04.108–14:33:54.892），latest-slot也允许跳过capture，不能把9.31−9.00直接计算为丢帧率。59个encoder窗口5669次同样不是300秒完整计数，不能简单5669/300充当真正编码fps；浏览器19.09decoder/s的分母才是完整同钟采样跨度。

这是**仍存的新鲜画面吞吐限制**，正常内容改变时可影响细节更新频率；并非证明9fps本身违反所有产品场景，或证明某次输入到画面延迟恰等于1/9秒。无逐次grab时长/完成gap、异常数和首RTP关联，本窗尚不能区分截图速度、线程调度或其他路径；不因已有重复帧就自动调FPS、编码器或Quality Lock。

|Host口径|本窗|
|---|---|
|53份**当前lag**min/median/max|0.077 /1.524 /237.672ms|
|重叠60秒rolling max范围|5.820–237.672ms；不可计为53次独立堵塞|
|missedSampleCount|所有为0|
|进程累计CPU|25.929→125.417s，+99.488s/约290.784s≈0.342核时间量级|
|Python threadCount|5；不是包含VideoToolbox外部服务的系统线程总数|
|asyncio taskCount|14–16|
|RSS快照min/median/max|189.918 /357.328 /374.754MiB|
|累计peak RSS最大|382.398MiB；不是本窗独立分配峰值|
|资源摘要|53/53 available=true；age0.969–5.101s；memoryPressure均unknown|
|systemLoad1 min/median/max|6.304 /8.977 /21.121|
|系统swap-in min/median/max|4.80 /25.38 /396.55百万B/s；最大约378.18MiB/s|
|系统swap-out min/median/max|0 /0 /558.74百万B/s；最大约532.86MiB/s|

系统分页仍显著，未归属到Host或任何其它应用；本轮没有重现13秒停顿说明“有换页”不等于每次必然大停顿。资源采样为约5秒窗口/有年龄，不能据此排除其间短瞬态。

300条VIEWER_STATS所报lost/dropped均0，正向NACK总1、freeze增量总12、PLI/FIR0。它们是接收统计，不是12次≥5秒冻结，不能推出完整网络丢包率或网络绝对无扰动。

## 4. Signal、清理证据与旁车的边界

浏览器lifecycle首次disconnect=null，结束前Socket仍connected，visible/online/focus true；1秒lag探针max28ms、308次、missed0，coverage partial。事件环有763条被淘汰，不能宣称保存了完整Socket逐事件历史。

Signal在14:33:59.577记录viewer transport close，比最后浏览器样本墙钟标记晚约0.381秒；对应正常关闭阶段，不是采样中断。WRD_SIGNAL_HEARTBEAT close证据：engine源、proof=true、coverage partial，ping创建11/flush11/pong11；关闭时Node窗口last0/max63/P95 1ms/missed0，age5.768s、count60。该Node摘要只覆盖关闭时的滚动窗口，不代表整个300秒Node分布。

原helper：browser.close成功、manager.stop成功，但cleanupStatus仍api-finished-exit-unknown、ownedProcessExitEvidence=not-observed。**不修改或升级原helper结论。**

独立supervisor：worker exit0，无deadline/failure/intervention；记录了7个带birth的worker/browser后代身份，allRecordedIdentitiesExited=true，signals=[]。这补充“这7个已记录身份已退出”的证据。completeProcessTreeExitEstablished=false，轮询可能错过快速孤儿；不能把它写为证明所有后代无遗漏退出。sample.status=not-triggered，sampleTrigger=null，没有native栈或sample子进程。supervisor总耗时329.086494s包含启动/等待/清理，不能当媒体稳定持续时间。

## 5. 与14:07失败比较及结论

|边界|14:07故障窗|本轮诊断窗|
|---|---|---|
|媒体连续性|13,849.43ms gap，PC断开/刷新|最大433.316ms，300秒同会话|
|已报encoder单次最大|13,541.114ms|329.356ms|
|Host当前lag最大|12,771.098ms，missed12|237.672ms，missed0|
|capture|约15.773秒只150→151|首末约290.784秒58→2766|
|进程CPU增量|约15.773秒内+0.633s|约290.784秒内+99.488s|
|资源覆盖|故障后age18.739s，available=false|53份available=true，但仍有换页峰值|
|native stack|无|未触发，仍无|

两轮时间、负载、观察方式不同；本轮没有改变编码策略，不能把差异归功于某次修复/调参或据此否定上次真实故障。已证明本次诊断300秒能够稳定推进；没证明14:07根因被修复，没证明三小时连续性、真实输入到可见效果或完整性能目标合格。下一步继续既定有界/一次触发式取证及独立验收，不能用本轮未触发栈样本假称已经排除GIL、native等待或OS调度问题。
