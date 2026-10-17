# TURN长测b：媒体、Host调度与资源复核

2026-10-17。只读分析`/tmp/wrd-owned-turn-probe-private/turn-long-20261017b`。调用方给定运行Host28181/source83c513e、Signal28142/source e996467；preflight提供Host PID/birth，本次不另探测进程。无代码/index/服务/browser/network/native/tests动作，仅写此0600报告。只分析b轮，不把a轮数据混入统计或作为受控对照。

**本轮三小时验收仍INCOMPLETE，131.952546秒结束。失败时Viewer Socket=false、lease1→0，但PC仍connected且画面继续推进；本窗口没有≥5秒媒体停顿或Host native进展停滞证据。不能因此称总体性能合格，也不能证明某段未触发的恢复代码已获运行验收。**

## 1. 范围与失败事实

读取preflight.json、supervisor.json、原session/{summary,lifecycle,samples}，132行samples完整。Host日志只读preflight→logsAtEnd，核对device16777220、inode43240044及两端一致：`back-debug.log [3047457,3184149)`，136,692B/503行，低于2MiB；未读取终点之后追加。Signal/lifecycle首断时间线由独立acceptance_reconnect报告负责，本报告不从媒体日志代替判断其信令根因。

浏览器performance.now同钟采样跨度131.005200秒；用其timeOrigin标记的窗口约15:16:50.047200–15:19:01.052400。该墙钟标签只用于筛选本轮Host日志，不用于跨机时延。筛入24个loop、25个encoder、26个capture、26个DC admission、130个VIEWER_STATS。聚合窗按结束时间落窗，首窗可含暖机，末窗可能未完成，不能当完整逐帧总体集合。

原helper requested10800s、elapsed131.952545773s、132样本、missing/late0、failedObservations1、identityChangeObservations1、maxObservedNoProgress783.3ms。首末PC identity1/generation1/attempt不变、PC connected，mediaPhase active；Socket true→false、leaseEpoch1→0、inputAllowed true→false。rVFC仍增加；最后Host probe15:19:00.478也为PC connected/ICE completed，captureSeq1535，当前loop lag0.42ms。Host精确日志切片没有signal-disconnect、packet-queue-empty、peer关闭事件；因此不支持把本轮故障写成Host已先掉线或原生媒体线程数秒冻结。

summary.startupSummary本身已包含Socket=false等结束态信息，不能据其字段名推断本轮从未连上；fresh normal Start/proof已verified，后续132个样本提供了实际生命周期证据。

## 2. 媒体输出与采集新鲜度

所有样本build a6e8b15122bde656；同path-1 relay/relay UDP，tunnelRelayActive=false。

|观察口径|本轮|
|---|---|
|decoder同钟计数|19→1926，+1907/131.0052s≈14.5567帧/s|
|rVFC同钟计数|19→1890，+1871/131.0052s≈14.2819次/s|
|最大已观察回调无进展|783.3ms，无达到5000ms的停顿|
|frameAge快照min/median/max|7.0/44.6/612.3ms|
|Host成功新captureSeq|71→1535，15:16:52.475–15:19:00.478，+1464/约128.003s≈11.4372次/s|
|26份capture窗口|1890输出、549复用，29.0476%|
|排除首暖机窗后25窗|1840输出、528复用、1312非复用候选；复用28.6957%|

排除首窗后的日志标签分母15:16:51.559→15:18:58.043≈126.484s，对应约14.5473输出/s、10.3729非复用候选/s。此处没有保存各窗单调起止，速率只是标签近似。captureSeq使用另一窗口，latest-slot可以跳过未消费capture；不能把11.44−10.37当丢帧率。非复用候选也不是光学内容变化次数。

当前目标20fps，而真实decoder约14.56/s、新capture约11.44/s。可称尚有吞吐/新鲜度限制；本轮没有受控前后比较，不能把这些数字写成cache epoch修复的收益。缓存复用存在不等于用户每次都看到旧内容，且1/fps不能当输入到画面的延迟。

26份CAPTURE_STATS窗口FPS8.8–19.3、median14.4；convert窗口均值3.3–20.0ms、median6.3；recv_total均值36.6–81.0ms、median47.0；sleep均值8.4–30.7ms。convert是构造阶段，capture_wait=0为latest-slot占位，recv_total包含节流/等待，均不能冒充MSS grab耗时。

## 3. 编码、profile及新cache epoch验收边界

25份encoder窗口15:16:54.077–15:18:55.712，共1865次调用，按count加权均值12.7384ms；窗口平均7.515–28.396ms，已报告单次最大601.355ms；每窗P95范围15.349–152.272ms。没有计算或宣称全帧总体P95。encode计时是函数wall time，含调度和内部转换/复制，排除此前executor排队与后续RTP发送await。

所有窗口为VideoToolbox、relay-peak-sliced-v1，1152×720、target20fps；只有一枚safety keyframe，forced/periodic/PLI均0。完整Host切片仅启动时15:16:48.446开一次1152×720 codec，无media-profile-change、无codec fallback或双尺寸重开记录。

**本轮未触发profile/FPS转换。** 因此可以报告没有观察到重复开codec，不能报告“20→15→20的cache epoch修复线上验收通过”或“所有重复重开已被消除”。离线测试、部署加载、未发生相关分支的真实会话是不同证据。

## 4. Host当前lag、CPU及实际分页

|Host口径|本窗|
|---|---|
|24份**当前一次lag**min/median/max|0.244/2.208/139.052ms|
|重叠60秒rolling max范围|181.684–564.526ms；不能当24次独立阻塞|
|missedSampleCount|全部0|
|累计进程CPU|5.872→68.905s，+63.033s/约128.003s≈0.4924核时间量级|
|captureSeq|+1464；最后25秒仍1318→1535持续增长|
|Python threadCount / asyncio taskCount|5 /13–15；不是VideoToolbox外部服务的全部线程数|
|Host RSS min/median/max|249.516/354.639/415.941MiB|
|累计peak RSS最大|424.453MiB；不等于本窗新增分配峰值|
|资源available/status|24/24有效且ok；age0.941–4.965s，memoryPressure unknown|
|systemLoad1 min/median/max|21.695/36.749/63.226|
|系统swap-in min/median/max|62.693/137.344/306.555百万B/s，约59.8–292.4MiB/s|
|系统swap-out min/median/max|0/124.673/380.142百万B/s，最大约362.5MiB/s|

资源仍有显著分页和负载，不能称环境已无压力。但本次有效窗口与持续capture/CPU/rVFC显示进展，并没有“进程几秒不推进”的证据；这些数据也不能排除更短调度尖峰。系统swap不是Host归属统计，不能据此宣称Host泄漏或其他某进程是唯一根因。

最终几份current lag：15:18:43.617为139.052ms，15:18:49.508为27.656ms，15:18:54.535为57.374ms，15:19:00.478为0.420ms。不能拿旧rolling max564.526替换这些当前状态，也不能把本轮Socket失效直接归给高load数值。

26份DC_DIAGNOSTIC_ADMISSION为累计值：最后frame_timing sent1887/dropped2、capture_stats sent26/dropped0、detail trace0；原因仅unavailable2，congested/invalid_buffer/send_error0，legacyDropped0。没有触达诊断传输准入上限的记录；不把累计计数相加，也不从congested0推出底层零排队。

## 5. 浏览器指标、缺测与下一步

下表为snapshot last min/median/max；不是整个会话单帧分布、总体P95或可相加的端到端耗时：

|指标|有效份数|last min/median/max ms|
|---|---:|---|
|Candidate RTT|132|35/44/558|
|Jitter buffer区间均值|131|5.7/35/85.3|
|Decode区间均值|131|0.698/0.913/3.779|
|Paint callback interval|132|16.6/50/783.3|

130条VIEWER_STATS所报lost/dropped/NACK/PLI/FIR均0，freeze增量总35；不是35次≥5秒冻结，且不构成完整链路丢包率。浏览器1秒lag探针max20ms、143次、missed0；细节仍为partial coverage。

全部132份inputAckRttMs、inputToPostApplyFrameMs、inputToVisibleEffectMs、hostQueueMs、hostApplyMs、hostAdapterAwaitMs、freshFrameAgeMs、encoderMs、relayFrameAckRttMs均available=false且last=null。Host inputEventCount全部0。不能用RTT、decode或rVFC代替真实输入验收。

sampleTriggered=false，未采到任何native stack；supervisor记录diagnosticPerturbed=true，旁车本身仍有开销。原helper关闭API完成但ownedProcessExitEvidence=not-observed；旁车另记录7个身份自然exited、signals=[]，完整进程树退出仍未证明。保留两种证据，不升级原helper结论。

建议把本轮后续聚焦于独立Signal/lifecycle已观察到的首次Socket断连；媒体持续推进使“原先Host秒级native stall再次造成此失败”缺乏本窗支持。保持当前媒体设置，避免通过盲调FPS/编码或重启tunnel掩盖信令原因。cache epoch修复的profile转换runtime资格继续单列未触发，性能目标与三小时连续性继续未达；无需为了让报告好看再把本轮短数据称通过。
