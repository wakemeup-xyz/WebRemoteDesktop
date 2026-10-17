# TURN 媒体性能只读诊断（2026-10-17）

结论：当前证据确认了接收/呈现抖动和 Host 大量复用旧采集图像；尚不能确定 TURN 网络哪一段、浏览器调度或截图阻塞的根因。不能把约 19.39 解码帧/秒当作新鲜画面频率，也不能把约 11.18 次 rVFC 回调/秒直接换算为“视觉丢失 42%”。没有发现本次 725.1ms 缓冲峰由累计平均公式算错的证据。存在可直接证明的观测语义缺陷：产品 UI/上送把缺测缓冲 null 变为 0；本 artifact 的 LatencyMonitor 原始摘要绕过了该转换，故不能据此否认这次正值峰。

## 范围与证据

- 只读主运行目录 `/Users/macstudio1/AI/Claude/WebRemoteDesktop`，调用方给定代码版本 8e375fa；174 行 artifact 均记录 buildId b73325b8166441a6。本次未调用 Git、生产接口、浏览器、原生 UI、服务管理或重启；未读取凭据、屏幕/输入正文。只写本报告 `/tmp` 文件，0600。
- Artifact：`/tmp/wrd-public-proof-timing-turn-20261017a/samples.jsonl` 行 1–174；`summary.json`。tick 0–172 是首个连接身份稳定区间的173份快照；tick173 是终止观察，虽然 JSON 行 status 仍为 observed，已不属于健康连续身份区间。总结为 INCOMPLETE，requested300s、elapsed173.093752861s；本报告不诊断首次 Socket 断连原因。
- 健康区间 Python monotonic elapsed：0.000057447–172.001575060s，差172.001517613s；浏览器 performance.now：26698–198700.099999905ms，差172002.099999905ms。外部一秒采样与内部一秒媒体统计分别运行，分母差异约0.6ms不解释吞吐差。
- Host 日志严格筛选本地时间 Asia/Shanghai `2026-10-17 09:46:00`（含）至09:50:00（不含）：`back-debug.log` 行20451–21016，566行。176条 VIEWER_STATS（09:46:06.366–09:49:01.382），37条 CAPTURE_STATS（09:46:07.530–09:49:08.310），36条 WRD_ENCODER_SAMPLE（09:46:11.150–09:49:07.131），42条 host_event_loop_lag（09:46:03.684–09:49:57.685）。这不是任意时长整体分布，日志后的健康/空闲样本不能充当会话样本。
- Artifact 未保存 UTC/wall-clock 锚点。相同725.1ms/RTT31ms媒体统计在 Host09:48:46.231收到；以此可把tick157关联到该接收时间附近，不能把接收时间当浏览器采样或抓图时间。存在两个 VIEWER_STATS 同时接收的排队现象（09:48:46.230/.231）。下面相关性均受这个边界约束。
- 已读取 README、`docs/runbook-safe-startup.md` 和 `/Users/macstudio1/.codex/skills/webremote-service/SKILL.md` 服务约束；仅使用日志文件，无状态脚本或网络探测。

## 三个频率与时间口径

1. 解码：172个相邻健康快照差分，共 `framesDecoded +3335`，基线24、末3359，约19.3894/秒。差分范围1–37、中位19。`framesDropped` 基线/末均0。它描述收到并解码的输出帧，包括 Host 复用缓存后再次编码的帧。
2. rVFC：同一172间隔 `callbacks +1923`，基线9、末1932，约11.1801/秒；每秒差分2–20、中位12，没有0。最大完整回调间隔1899.9ms；首次到达最大值tick166，前一新高tick157为1483.4ms。`maxFrameGapMs` 是本次观察累积最大相邻回调时距，不是当前缓冲、单帧端到端耗时或光学呈现时距。至少每个一秒采样间隔有回调不排除接近两秒的跨边界空窗。
3. 新采集/新输出：Host初始37个捕获输出窗口3512帧，其中1921缓存复用。去掉启动第一窗后36窗3482输出、1908复用（54.80%），因此只有1574个非复用输出候选（约180.78s聚合窗口内约8.71/秒；非光学内容变化率）。输出FPS17.8–19.6，中位19.5；Host captureSeq从09:46:14.680的124到09:49:04.693的1626，1502/170.013s约8.835次成功新采集/秒。captureSeq和新输出并非一一对应，latest槽允许覆盖，不能等同。

rVFC证据是回调数。`scripts/passive_session_sampler.js:39–44` 完全丢弃metadata，因此没有 `presentedFrames` 差分、presentationTime/expectedDisplayTime、mediaTime、processingDuration等信息；缺少这些就无法区分回调漏观察、呈现合并/丢弃及解码后的排队。产品本身在 `web-client/js/webrtc.js:5683–5706` 有 presentedFramesDelta 五秒摘要，但该artifact未导出。也未获得物理显示/可见内容变化证据；不能归因headless，因为没有同浏览器、同链路、同负载的有头对照。

## 指标公式和统计语义核对

- `web-client/js/webrtc-stats.js:44–85,100–165`：buffer = `1000 * ΔjitterBufferDelay / ΔjitterBufferEmittedCount`，四舍五入0.1ms；decode = `1000 * ΔtotalDecodeTime / ΔframesDecoded`；FPS=`1000 * ΔframesDecoded / ΔsampledAt`。前两者为区间每个emitted单位/解码帧的均值，不是同一帧可相加的端到端分段。首样本warmup返回null；计数下降/缺测返回null（FPS部分用JS算术可退成0）。未见把累积总量误除本轮帧数的错误。
- 产品sampler用 getStats Promise完成时的 `performance.now()` 存sampledAt（同文件180–195），没有使用 inbound report的timestamp，也没有记录inbound identity来复位基线。独立artifact的stats读数不保存report timestamp/identity。因而无法核实缓存/异步getStats时间偏差，或判定实际某个差分来自何时；本次PC/path稳定不等于原始inbound ID已经验证稳定。未取得Chromium内部实现源码，不能据本地aiortc SDK声称验证了浏览器计数的底层实现。
- `web-client/js/latency-monitor.js:74–95,217–233` 保存过去5000ms的样本，p95使用排序索引floor(n*.95)，max256；rVFC由callback的now计间隔，统计由处理完成时刻记入。artifact每秒snapshot导出last/p95/count/lastSampleAgeMs，窗口重叠；不能对174个p95再算“全程P95”。buffer/decode通常每窗约5个区间均值，p95往往等于最大均值。不是按所有视频帧加权的P95。
- 健康快照buffer/decode最新样本年龄149–1185.1ms（中位约183.8/183.9ms）；RTT年龄149–210.8ms。某些一秒snapshot可能重复旧last，也可能错过中间样本。下面分段统计只是这些snapshot的last值分布。
- RTT来自selected candidate pair currentRoundTripTime，`webrtc-stats.js:142–143`转为ms；它不等于视频单向、输入ACK或输入到可见效果。本次input/visible/fresh-frame等缺测为null，不能补算。
- 直接确认的观测缺陷：`web-client/js/webrtc.js:5759–5760,5922–5937` 将null RTT/buffer转0，再上送；`LatencyMonitor.onMediaStats(stats)` 在5907–5908使用原始值，会跳过null而保留上一个有效last。Host日志里stall时的buffer0不能证明缓冲为零，artifact last也可能滞留。该缺陷不凭空制造725.1ms正峰；修复未在此任务实施。

## 启动、持续与瞬态

| 健康tick区间 | snapshot数 | buffer last min/median/max ms | decode last min/max ms |
|---|---:|---|---|
| 0–9 | 10 | 24.5 / 178.0 / 742.0 | 0.5666 / 1.3902 |
| 10–59 | 50 | 7.5 / 40.6 / 493.9 | 0.5444 / 2.2186 |
| 60–119 | 60 | 6.0 / 23.0 / 281.3 | 0.5832 / 0.8488 |
| 120–172 | 53 | 0.0 / 27.1 / 725.1 | 0.5531 / 0.8963 |

buffer last≥250ms共10份健康snapshot，tick和值：0/742、1/476.1、26/331.2、41/493.9、42/286.5、109/281.3、148/391.6、154/267、157/725.1、167/473.3。终止tick173另有263.8ms，不混入健康统计。RTT健康last29–131ms，725.1ms峰旁31ms。启动前两份高缓冲可以包含首帧恢复；109/148/157/167s的峰明确处于后段，不能全归暖机。大部分snapshot last较低且峰后回落，因此证据是反复瞬态抖动，不是全程持续700ms。

## Host相关证据及已知机制

- 编码36窗共3489次调用，调用数加权均值4.5086ms；各窗平均3.668–5.870ms，窗p95为5.604–10.932ms，单次最大165.753ms。这些是encoder.encode整个调用（含packetize）的本地计时（`h264_videotoolbox_encoder.py:1022–1067`），不是纯硬件编码耗时或RTP发送。实际VideoToolbox、1152×720、target20、3.2Mbps。仅一条Opening日志（09:46:05.933）；36窗没有重开风暴。启动首窗6个IDR（5 safety、1RTCP），其后到09:48:52.030各窗无IDR；09:48:57.073和09:49:02.102各一强制恢复IDR，不支持周期IDR反复引起全段抖动的说法。
- 事件循环42份为重叠60秒分布（`runtime_observability.py:14,42–49`），不是42个互斥5秒窗。前6份critical161.35ms、后9份warning50.986ms可重复涵盖同一个早期事件；09:47:26.683起27份normal，最大7.662–10.185ms，missedSampleCount均0。这些一秒探针不排除短于探针间隔的阻塞，也不是抓图线程或编码线程耗时。不能用早期60秒窗口的critical重叠重复数解释后段峰。
- 09:48:46.231收到的buffer725.1ms同时有decoded9、received9、lostDelta14、nackDelta23、freezeDelta1；下一次09:48:47.296收到decoded41、FPS40.5、buffer122.5ms，是积压后追帧的相容证据。09:48:55.471 decoded0/received0、lost16/NACK34，09:48:56.287 decoded54、FPS54.8、buffer473.3ms；09:49:01.382 decoded0但received8、lost15/NACK10。这些是receiver报告的区间计数（`webrtc.js:5897–5938`及`host.py:3713–3733`），支持接收丢包/重传与stall同时存在，不证明全部丢包永久丢失、不能计算链路丢包率或归因某个TURN节点。176条日志的正向lostDelta之和1084、NACK之和1229，不作为唯一包数量/完整窗口loss率；packetsLost本身可回落，而nonNegativeDelta对负增量丢弃。
- 后段Host编码/输出仍约20fps、loop正常，不能证明媒体网络正常；RTT31ms同样无法否认重排/丢包/缓冲。
- 源码确认的新鲜度机制：生产`host.py:1974–1984`显式`CaptureExperiment(1.0,1)`，`capture_experiment.py:27–32`使target20对应20次/秒上限，最小50ms；不是README历史2x描述。`host.py:1218–1257`抓图后再sleep余量（抓图已超50ms则无sleep），成功才加captureSeq；异常sleep5ms再试。不能从20次目标推出实际20次。
- `host.py:1378–1459`的latest槽被recv读取后清空，fresh条件是非空且seq未消费；无新shot时缓存复用；`1452–1454`将reuse计数。此触发机制和54.80%复用由源码+日志确认。尚无逐次MSS耗时/调度空窗/捕获异常计数，不能判断8–10次/秒是MSS截图慢、线程未及时调度、失败重试还是其它因素，更不能断言1x pacing是根因。
- 复用输出仍在`host.py:1475–1477`赋新PTS；`media_timing.py:30–47`基于本机monotonic_ns生成90kHz时钟，至少+1，PTS表示此次输出时钟，不是原始抓图时刻。因而解码推进和rVFC都不保证新源图像。CAPTURE_STATS的capture_wait写死0（host.py:1391），不能读成截图耗时0；convert是worker构图均值，recv_total含输出pacing sleep，不含真实MSS grab（1495–1528）。
- 已安装SDK `/Users/macstudio1/.homebrew/lib/python3.11/site-packages/aiortc/rtcrtpsender.py:294–330,357–407`确认：等待track.recv，在线程池编码，随后逐RTP包await发送，才拉下一帧。编码5ms不包含executor等待或RTP发送await；本段无WRD_FRAME_TRACE_SUMMARY（0条），artifact encoderMs也null，无sender边界证据，不能把余下延迟算给“网络”。SDK的stats.py:7–13只有通用timestamp定义，不证明Chromium receiver语义。

## 最小后续观测（本次不执行、不调参）

1. 同一个有界采样中保留rVFC presentedFrames/mediaTime/expectedDisplayTime/presentationTime差分、回调now与实际观察差；仍标为呈现API证据，光学可见保持NOT_RUN。
2. 接收统计附同一inbound report的不透明identity、原始stats timestamp、采样开始/结束时钟，以及framesReceived/Decoded/Dropped、jitterBufferDelay/emittedCount、packetsReceived/Lost、NACK、freeze的原始计数或安全差分；保留null与负差分，避免把缺测0化。这样才能重算帧加权均值、发现缓存/计数重置，并正确对齐loss与buffer。
3. Host仅聚合真实MSS grab duration/相邻完成gap、成功captureSeq差分、grab异常数、fresh/reused output数；分开output PTS与source capture bounds。需要发送端细分时再使用现有stage计时边界，不能拿CAPTURE_STATS capture_wait=0当抓图耗时。

这些观测足以缩小下一步诊断，不需要先调TURN、encoder policy、分辨率或FPS。首次Socket断连根因、真实输入到可见效果、物理显示及长会话稳定性不在本报告结论中。
