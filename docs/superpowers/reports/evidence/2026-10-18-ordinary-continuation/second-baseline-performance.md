# 第二次实际 baseline 的有限性能复核（2026-10-18）

## 结论与验收边界

本次实际公网 guarded Start 成功进入 connected，得到持续 H.264 画面和 `inputAllowed=true`，但验收以 `startup/baseline-incomplete` 结束：**47.306001 秒是采样阶段累计时间，不是首帧耗时，更不是通过的连续会话时长**。实际首个有帧且允许输入的采样行在 elapsed=10.267321 秒；同一浏览器时钟的 Start→first-frame 标记差为 **8.6016 秒**。连续资格结果仍为 INCOMPLETE，合格计时与样本都是 0；5 分钟、3 小时、普通恢复均未取得资格。本报告没有修改代码、运行项目导入、查询进程、调用网络、打开浏览器、启动或停止服务，也没有注入原生输入。

此次后段呈现节奏相对稳定，但新桌面抓取仅约 6.49 Hz，编码/呈现约 19.6 FPS，主要依赖重复旧抓屏。这是需要继续处理的性能问题：它可能增加等待下一张真实新屏幕的时间；当前证据不能给出实际输入到可见画面的数值。首帧超过 8 秒目标的单次观察、启动 RTT 短暂升高、编码初始化窗的 394 ms 长尾也应保留，不能用稳定期均值掩盖。

## 数据范围、筛选与可复核性

- 读取本次 `qualification-started.json` 中的 outputDirectory 指针，分析其 `session/summary.json`、`lifecycle.json`、`samples.jsonl`，以及本次 qualification-result。输出路径中的私有会话、attempt 和进程身份不抄录至本文。
- 会话样本 51 行：50 startup + 1 terminal，elapsed 0.017288–47.306001 秒；39 行有实际画面、inputAllowed 和非空 decoded 统计，覆盖 elapsed 10.267321–47.306001 秒，约 37.039 秒。最后 terminal 行紧邻上一行，不当作独立一秒。
- Host `back-debug.log` 严格限定 wall epoch **1792327090 ≤ t < 1792327152**，即北京时间 **20:38:10–20:39:12**。匹配带时间戳行共 160 行，当前文件行号 619–778，实际首末事件为 20:38:12.432–20:39:11.134。共 11 条 loop 摘要，其中 7 条 PC=connected；7 个编码统计窗；38 个 Viewer stats 记录；7 个 CAPTURE_STATS 记录。未用窗口之外的 idle 数据冒充 active 数据。
- 采用纯标准库离线解析时间戳和数值；不拼接不同机器 wall clock 计算单向延迟，不对重叠的五秒 p95 再取 p95，不把阈值日志当成完整分布。
- `summary.json` SHA256：`7b0f67cc806a9af743314baa8d0b76d6e723b667071c981d91ca30ecb5827b27`。
- `lifecycle.json` SHA256：`868ee97b8d8e1e7c2a651039fb481730449309681fe360d2552ece0070a0c3fd`。
- `samples.jsonl` SHA256：`87e153a2c5cc45ed2531018d8d8b5b0d65e726fc9472cb9bd17f671d7a282ff2`。
- 160 条 Host 筛选行按原顺序、LF 拼接并加末尾 LF 的 SHA256：`86fc3824716c15c6736221e1d0e499684c6b5c52b6d589a578ccf18d216329bb`。原始日志持续追加，不以整文件哈希替代固定窗口证据。

## 建连和首帧

以下差值来自**同一浏览器 performance 时钟**，是一次实际连接的观测，不能作为 P95：

| 阶段 | 本次观测 |
|---|---:|
| Start→bootstrap-start | 0.4 ms |
| bootstrap-start→bootstrap-ready | 905.5 ms |
| bootstrap-ready→signal-connected | 3646.8 ms |
| signal-connected→first-frame | 4048.9 ms |
| Start→first-frame/active | 8601.6 ms |
| 首个 socketConnected 样本 | elapsed 6.266825 s |
| 首个 callbacks>0 且 inputAllowed 样本 | elapsed 10.267321 s |

需求文档的首个稳定非黑画面目标为点击后 P95 ≤8 秒；本次 first-frame 标记差 8.6016 秒是需优化的一次偏慢观察，既不能判定总体 P95，也不证明画面非黑或原生可见效果已验收。采样开始、UI Start 和浏览器页面时钟的零点不同，不能把 elapsed 10.267 秒与标记差 8.6016 秒互相替代。

最后采样仍为 connected、media active、inputAllowed=true、viewport 1152×720；PC/generation/lease 在允许输入的 39 行内不变，Host observation 51 行 stable/complete，未观察到 Host disconnect。所有 inputGate 的 firstFrameTimerHandlePresent 均为 null；这与本次资格未建立有关，具体契约/源码诊断由独立 gate 复核给出。本次不能归类为已捕获“用户控制中断”。

## 传输、解码与呈现

| 边界 | 真实可用证据 | 限制 |
|---|---|---|
| 实际媒体路径 | selected local relay + remote relay，UDP；H.264；单一已观察路径 | TURN 路径，不是 tunnel/JPEG image-load 路径；不是物理设备路线矩阵 |
| selected-candidate RTT | 40 个有值快照，35–271 ms；启动时曾 271 ms，随后 136 ms；后段约 35–39 ms，最终 37 ms | 往返，不可直接除二声称单向传输；快照复用约每秒更新的 stats |
| jitter buffer | 37 个可用快照，区间平均值 2.7–46.6 ms；最终 6.3 ms | 由 jitterBufferDelay / emittedCount 的区间增量得到，不是逐帧完整分布 |
| decode | 37 个可用快照，区间平均值 0.53065–0.67640 ms/decoded frame；最终 0.59853 ms | totalDecodeTime 增量 / decodedDelta，不是逐帧最大值或真实输入延迟 |
| callbacks | 最后 731 个 rVFC callbacks；decoded=733，累计 dropped=0 | rVFC 表示浏览器帧提交观察，不是光学呈现；decoded/callback 不要求一一相等 |
| 呈现间隔 | 37 个约一秒的有帧增量区间约 16.00–21.00 FPS，均值约 19.56 FPS；lifetime 最大 rVFC gap=183.3 ms | 初始无帧和最后重复 terminal 不混入该 FPS；短观察没有覆盖长会话尾部 |
| paintIntervalMs | 39 个可用快照，最近值 49.9–66.7 ms；重叠五秒窗口 p95 范围 66.6–116.7 ms | 不是整个运行 p95；最终窗口 count=98，p95=66.7 ms |
| frameAgeMs | 39 行有值，4.3–47.9 ms；terminal=16.4 ms | 只表示距离最近 rVFC 的时间，**不是源桌面像素年龄，也不是网络端到端耗时** |
| freshFrameAgeMs | 全部缺测，count=0、last/p95=null | 不能用 frameAgeMs 替代来源新鲜度 |

Host 回传的 38 个 Viewer stats 中，2 个启动记录 FPS=0；36 个非零区间 FPS=17.0–21.0、均值 19.583。已记录窗口的 lost/dropped/NACK/PLI/FIR/freeze 均为 0。浏览器诊断 attribution 未记录 firstDisconnect；诊断覆盖为 partial 且最终 droppedEvents=13，因此仍不能证明所有阶段/第一跳事件完整。

## Host 抓屏与复用：目前最明显的性能缺口

最终 active loop 摘要（20:39:09.431）抓取 attempted=completed=243、failed=0。cadence 是 rolling-60s-completion-buckets；因为本轨道不足 60 秒且无 discontinuous/invalid/clipped，最后快照含 **242 个已闭合抓取开始间隔**，覆盖 **37,267.448 ms**，实际新抓取率 **6.4936 Hz**。该闭合前缀不包含仍未闭合的最后一个周期及之后约两秒，不能冒充全部会话。

| 242 个闭合间隔的阶段 | 平均 | 最大 |
|---|---:|---:|
| 新抓取间隔 | 153.998 ms | 453.249 ms |
| grab wall time | 27.710 ms | 109.404 ms |
| postGrab | 0.326 ms | 17.849 ms |
| pacing 实际耗时 | 125.838 ms | 426.605 ms |
| pacing 请求耗时 | 22.391 ms | 27.539 ms |
| pacing 超额 | 103.447 ms | 403.149 ms |
| publish lock 等待 | 0.00382 ms | 0.03061 ms |
| publish critical | 0.06644 ms | 1.27422 ms |

目标最小间隔记录为 50 ms（20 FPS），并非要求 150–200 ms 的配置。最慢 453.249 ms 的**同一配对周期**由 grab 25.248 + postGrab 1.296 + pacing 426.605 + other 0.100 ms 构成；其中 pacingRequested=23.456 ms、pacingExcess=403.149 ms。最大 grab=109.404 ms 是另一个边界：该抓屏配对 thread CPU=13.967 ms、非 CPU=95.437 ms，不能拿这组值解释最慢 pacing 周期。

7 个 CAPTURE_STATS 已完成统计窗共输出 649 帧，其中 reuse=438，**约67.49%为缓存复用**。初始窗输出约11.5 FPS，后6窗约19.1–19.7 FPS；抓取自身约6.5 Hz。这与源码一致：独立 capture thread 发布最新 shot；recv 在没有新 shot 时复用缓存像素并继续输出视频。因而 20 FPS 编码/回调和 0 dropped 不等于桌面内容以 20 Hz 更新。

源码对 pacing 的边界是在 `time.sleep(sleep_time)` 前后读单调钟，超额值证明 sleep 区间实际返回比请求慢。它**没有**进一步区分内核调度、唤醒/计时器合并、GIL 重新取得或其他宿主影响，不能据此写成唯一根因。锁等待极小、loop 滞后不大，也不能排除不同线程的调度问题。应优先为这个可重复的“目标50 ms、实际约154 ms”缺口建立有限的线程调度/等待归因证据，再选择修复，不能直接降 FPS/分辨率掩盖它。

## 编码、事件循环和资源

- 编码为 VideoToolbox，7 个完整约5秒统计窗共 **692 次编码**。各窗均值3.408–7.305 ms，p95=4.735–7.082 ms；首窗最大 **394.014 ms**，其后6窗最大≤10.479 ms。按已四舍五入的窗口均值加权估算约4.297 ms，仅作摘要；不可从7个p95还原整体p95。末尾未满窗没有被计入，首个长尾的确切序号/是否首帧没有原始逐帧证据。可以怀疑冷启动相关，但尚未证明因果。
- 11 条 loop 摘要中的4条 PC=none；7条 PC=connected。active 记录的直接 lag=0.253–3.439 ms；60秒滚动最大最终 **6.549985 ms**，滚动p95=4.412–4.792 ms、missedSampleCount均0。窗口重叠，不能相加得出总样本量或整体分位数。此小窗口没有重现此前几十秒级 loop 阻塞，不代表历史问题已关闭。
- active 摘要的 process CPUSeconds 从17.061到26.632，实际墙钟34.002秒，约 **28.15% 的一个逻辑 CPU**。没有采集浏览器/Signal CPU，不据此声称整条链路资源充足。
- active RSS 从36.75升至313.004 MiB，最后数条约298–313 MiB，peak最终320.648 MiB。这是短期增长，不能证明泄漏或稳定长期平台。需长会话观察回落/平台与帧缓存/codec生命周期。
- active systemLoad1=3.763–4.169；有少量系统 swap-in、swap-out记录为0，memoryPressure=unknown。系统交换量不归因于本Host，低load也不等于捕获线程一定及时得到调度。
- inputEventCount=0、inputWaiters=0、pendingRelayFrames=0。inputReliable/inputUnordered/relayFrames queue字段为null，即未测，不写成队列为0；TURN媒体也不使用JPEG发送队列证明。

## 输入耗时状态与下一步

本次所有51行的六项输入指标 `inputAckRttMs`、`inputToPostApplyFrameMs`、`inputToVisibleEffectMs`、`hostQueueMs`、`hostApplyMs`、`hostAdapterAwaitMs` 都是 **count=0，last/p95=null，NOT_RUN**。businessInput、visibleEffect、physical 均 NOT_RUN。原生输入、匹配业务 ACK、应用后因果帧、物理可见效果没有被这次被动运行测量；租约/reset 生命周期消息不充作用户输入样本。candidate RTT、jitter、decode、rVFC不能拼接估算实际输入到画面延迟。

按证据优先级继续：

1. 先修复有依据的真实 startup/gate 状态初始化问题并保持现有严格门槛；本次结果保留failed，新的版本重新建立独立基线，不能把47秒记录改判PASS。
2. 完成实际5分钟连续基线、一次普通恢复和3小时长会话；第一阶段已发现的首帧8.60秒、首次编码长尾和捕获节奏缺口必须继续记录，不能只保留稳定期。
3. 对捕获线程建立有界调度归因：保持20 FPS/同分辨率/同策略，比较请求与实际sleep、线程CPU和抓取新鲜度，记录真实等待区间及环境条件；确认原因后再选择原生捕获或调度修复。增加源帧新鲜度可用性，避免FPS误导。
4. 对 bootstrap-ready→signal-connected 的3.647秒、signal→first-frame的4.049秒分别补齐阶段证据。没有边界证据前不把全部首帧时间归因Cloudflare/TURN/编码。
5. 在独立原生桌面验收目标具备后，运行匹配Viewer发送/ACK、Host排队/执行、因果新抓屏与原生可见变化的受控输入试验；缺少环境时继续保持null/NOT_RUN，不向共享桌面注入来凑验收数据。

## 源码边界参考（只读）

- `/Users/macstudio1/AI/Claude/WebRemoteDesktop/python-host/host.py`：1454–1594 capture loop与sleep bracket；1745–1828最新抓屏选择/缓存复用；1875–1915输出FPS与reuse统计；2330附近生产capture strategy。
- `/Users/macstudio1/AI/Claude/WebRemoteDesktop/python-host/capture_cadence.py`：155–183闭合周期配对，234–278 rolling快照与rate。
- `/Users/macstudio1/AI/Claude/WebRemoteDesktop/web-client/js/webrtc-stats.js`：52–78区间jitter/decode/FPS语义。
- `/Users/macstudio1/AI/Claude/WebRemoteDesktop/scripts/passive_session_sampler.js`：inputGate与rVFC/指标投影；缺测保持null。
- `/Users/macstudio1/AI/Claude/WebRemoteDesktop/docs/需求文档/WebRemoteDesktop-需求文档.md`：17–18首帧8秒目标与软硬预算；75抓屏入口；133输入时间边界；508验收边界。
