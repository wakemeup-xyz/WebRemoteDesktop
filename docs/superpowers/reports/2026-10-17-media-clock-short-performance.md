# Host clock修复后300秒TURN媒体性能（只读，2026-10-17）

Canonical summary结果PASS：请求300s，实际300.138246s，301份观察，missing/late/failed/identity-change均0。最大观察无进展449.998ms，未再出现≥5000ms停帧。本结论仅覆盖这一轮300秒被动连续性；不是三小时验收，也不证明所有负载或墙钟跳变下都已运行验证。activeControl、visibleEffect、physicalDisplay保持NOT_RUN。

## 证据与裁剪

完整读取`/tmp/wrd-public-media-clock-turn-20261017a/samples.jsonl`的301行（ticks0–300），以同目录已持久化summary.json为canonical，辅以lifecycle.json。调用方提供部署source f492357、Host PID42127；本次未探测PID/源码状态。所有301行实际报告build c30530f331a4def5。

采样跨度：Python elapsed0.000049048–300.002575913s；browser performance.now15891.200000048–315894.5ms，差300.003300000s。计数速率统一用该浏览器同钟差。lifecycle锚点仅用于选取日志时间窗，映射约12:35:37.287–12:40:37.291 CST；不作跨时钟减法计算帧延迟。

Host日志从`/tmp/wrd-c5-rollout-private-ilovzfv1/media-clock-short-start.json`记录的inode42866929/offset9,968,017读取，核对inode仍一致，读取约261KB尾部后再严格筛选上述采样时间范围。最终840行，其中54份host_event_loop_lag（12:35:42.970–12:40:35.980）、59份WRD_ENCODER_SAMPLE（12:35:42.019–12:40:33.468）、60份CAPTURE_STATS（12:35:39.970–12:40:36.570）、300份VIEWER_STATS（第一份12:35:37.168早于baseline而被排除）、0份WRD_FRAME_TRACE_SUMMARY。

12:40:38.510的encoder窗口晚于采样终点，已排除，故下文59窗不是先前粗读得到的60窗。日志统计按结束记录落入窗口裁剪，首个聚合窗可能含连接暖机；不能冒充与browser计数完全相同的起止覆盖。当前后续JPEG run未进入任何统计。本次未连接浏览器、发网络请求或修改source/runtime，只写此0600私有报告。

## 输出、回调与新鲜采集

| 口径 | 本轮结果 |
|---|---|
|Decoder|framesDecoded5→5618，+5613 /300.0033s =18.7098帧/s|
|rVFC|callbacks5→5552，+5547 /300.0033s =18.4898次/s|
|相邻300个约1s decoder差分|min8、median19、max22，零进展区间0|
|相邻rVFC差分|min8、median19、max21，零进展区间0|
|成功新captureSeq|82→3043，Host12:35:42.970–12:40:35.980，+2961 /293.010s ≈10.1055次/s|
|60个capture输出窗口|5606输出、2720缓存复用，复用48.5194%，非复用候选2886|
|排除首个暖机capture窗|5547输出、2693复用（48.5488%），非复用候选2854；剩余59窗边界跨度296.600s，约9.6224非复用输出/s|

captureSeq是成功新截图次数，不是内容实际变化次数；latest-slot允许截图被覆盖，不能与非复用输出逐一等同。缓存输出同样有新PTS，decoder/rVFC推进也不能替代新capture证据。没有逐次grab/stage trace，因此不能判断约10.1次/s具体受MSS时长、线程调度、异常重试或其它边界限制。

framesDropped全程0。累计完成回调最大间隔依次在tick0/1/17/40达到83.316/150.1/383.3/449.998ms，此后未再增长。snapshot frameAge范围1.3–323.3ms，median29.6ms。这是回调API证据，不是光学可见内容或物理屏幕证据。

所有样本保持scopeStable=true、Socket/PC connected、PCidentity1、generation1、leaseEpoch5、active/inputAllowed=true；path-1、relay/relay UDP一致，tunnelRelayActive=false。

## 浏览器指标：snapshot last与五秒窗口严格分开

下表median仅是snapshot `last`值的中位数。应用p95是互相重叠的五秒窗口；不能把它称为全程P95。buffer/decode last是各采样区间均值，也不是单帧延迟分布。不同snapshot可能重复先前last值。

| 指标 | 有效snapshot | last min / median / max ms | 五秒p95窗口 min / max ms |
|---|---:|---:|---:|
|Candidate RTT|301/301|27 /29 /171|28 /171|
|Jitter buffer|299/301|1.1 /7.9 /50.5|6.7 /50.5|
|Decode|299/301|0.4783 /0.6764 /4.6653|0.5682 /4.6653|
|rVFC interval /paintIntervalMs|301/301|16.536 /50 /316.7|66.6 /216.7|

buffer/decode前两份null保留。RTT/buffer/decode有效last的年龄585.5–745.2ms，median623ms；rVFC last年龄1.4–322.8ms。采样last最大值不保证捕获所有中间瞬态。RTT不是输入ACK或单向视频延迟。

## Host编码、输出、循环与资源

59个encoder窗口共5547次调用，按调用数加权平均4.9559ms；窗口均值3.923–9.831ms，窗口p95为6.014–23.419ms，单次最大313.099ms（首窗，启动阶段）。明确排除首窗后58窗5448次调用，均值4.9091ms，单次最大193.309ms。聚合窗四舍五入使加权均值是可得近似，不是从每次原始时长重算。

日志匹配VideoToolbox、1152×720、target20fps、3.2Mbps、relay-peak-sliced-v1。运行启动范围仅见一次encoder Opening；59采样窗口累计一枚safety-net IDR，无周期/PLI/forced IDR计数。没有反复重开/IDR风暴证据。

60个CAPTURE_STATS窗口报告FPS11.8–19.7、median19.2；去首窗后15.1–19.7。平均sleep26.6–39.5ms，convert1.9–7.2ms，recv_total43.6–52.2ms。Host clock修复后这些窗口按单调持续时间统计，但它们仍只是各窗口平均值；recv_total含节流，convert非MSS grab，capture_wait=0不能解读为抓图0ms。

54个Host循环摘要：最新lag0.098–122.734ms，median1.336ms；重叠60秒窗口最大值5.816–305.731ms；missedSampleCount均0。多次同一rolling最大值不能计为多次305ms阻塞，也不能把这些窗口p95再拼成整场P95。

有效Host probe区间内processCpuSeconds增加99.361s/293.010s，约0.339个CPU核的时间量级；不是系统CPU占用或编码线程独占值。当前RSS293.51–407.61MiB，median345.69MiB；进程peak RSS最高417.875MiB。资源摘要全部available=true/status=ok，但age931.4–5094.6ms，因此不是实时逐帧资源测量。

系统swap-in3,090,679.85–218,408,295.31B/s（约2.95–208.29MiB/s），snapshot median18,841,012.74B/s（约17.97MiB/s）；swap-out0–255,773,573.46B/s（约243.92MiB/s），median0。systemLoad1范围4.807–16.183，median7.9615；memoryPressure仍unknown。这些为系统采样窗口率，不能归给某一个应用或特定帧。

300份VIEWER_STATS里的lost/dropped计数均0，正向NACK增量总4，PLI/FIR0，freeze增量总23。freeze是receiver统计，不是23次达到5秒的停帧；实际采样最大gap449.998ms。不能从lost0推断整个网络无扰动或得出完整链路丢包率。

Final lifecycle：visible、online、focus true；最大1秒探针main-thread lag25ms，311样本、missed0、hide/show/freeze/resume0，coverage partial。此探针不能排除更短的调度延迟。

## 缺测与结论边界

Host54份probe inputEventCount均0。全部301份浏览器snapshot的inputAckRttMs、inputToPostApplyFrameMs、inputToVisibleEffectMs、hostQueueMs、hostApplyMs、hostAdapterAwaitMs、freshFrameAgeMs、encoderMs、relayFrameAckRttMs都无可用值、last/p95为null。这轮没有主动输入；M2缺测不能补成0，也不等于基础input因果链故障。Host encoder日志不自动填充浏览器encoderMs。

相较前一轮修复前300秒（decoded18.21/rVFC17.91、capture约9.74、reuse49.14%、gap1000ms），本次数字更平稳；运行时间、系统负载等条件不同，不构成受控因果对照。代码已修的wall-clock pacing机制与本次300秒通过是两类证据；此run没有主动注入墙钟回拨，也没有三小时数据，不能据此宣布此前所有5秒停帧原因全部消除。

可下结论：修复加载后的这一300秒TURN被动连续性通过；没有再次≥5秒停帧，约18.71解码fps/18.49回调每秒和约10.11成功capture每秒；约48.52%输出复用仍存在。剩余grab/encoder-executor/send stage未知保持未知，本轮无新实现结论。
