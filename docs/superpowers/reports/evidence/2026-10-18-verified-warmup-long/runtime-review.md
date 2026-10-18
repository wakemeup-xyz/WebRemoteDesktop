# Verified warmup 3 小时验收精确日志窗口独立审计

本窗口没有发现运行中的连接重建、Host ERROR/CRITICAL 行或持续增长的线程/任务数量；这为本次稳定会话提供旁证。仍有抓屏复用、编码尾部尖峰和 teardown 完成摘要缺失，不能把 passive continuity 等同于真实输入到画面的性能验收。

- 运行：`verified-warmup-long-20261018a`，source `53ed5d72e331b808245b7d650a6c4ff7b2969c85`，build `79bf9a5afea0458e`。
- 精确元数据窗口 UTC：2026-10-17T20:58:16.951824+00:00 → 2026-10-17T23:58:59.981203+00:00，10843.029 秒（包含启动/清理边界，**不是**采样器 10,800 秒资格结论）。CST 为 10 月 18 日 04:58:16.952 → 07:58:59.981。
- 两端 local health=true、Host online=true、Viewer/relay Viewer 均 0；Signal 45287 / Host 94398 和 build 未变。未读取其他进程或运行配置。
- Host 一次轮转，按 device/inode 链拼接：inode 43654875 从 offset 6029429 到 10485726（当前 `.1`），再接 inode 44252455 的 `[0,5661908)`。共 **10,118,205 字节 / 32,232 行**。未读更早 `.2/.3`，未做历史全扫。两个段均行边界完整；具体 SHA 见 JSON。
- Signal human 同 inode `[2346676,2536692)` 190,016 字节 / 7,835 行；Signal JSONL 同 inode `[1229318,1756859)` 527,541 字节 / 187 事件。两者是重叠视图，不相加。独立 Host JSONL 两端均缺失。

## Bootstrap 与网页请求

- `viewer_bootstrap_served` **1 次**，human 日志同样 1 次：UTC **20:58:27.582**，local `serverProcessMs=0.24`，Host online。单 count 与一次已验证 preload 被复用相容，但**不能单独证明 cache hit 或优化因果**。
- 对应 HTTP bootstrap summary：started/completed 各 1，2xx 1，duration count 1 / sum=max **1 ms**，aborted/closed unfinished/4xx/5xx 均 0。它是本地 route completion；0.24 ms 是本地 handler 处理边界，两者都不是公网传输耗时。
- 180 个 entry window（约 60 秒/窗）reported missed=0，completion coverage=true、clipped=false、clockUnknown=false，collection/logger/store failures 均 0。logged HTTP completion：login 1、auth verify 1、HTML 3、bootstrap 1，均 2xx；其余已分类 route 0。多数长测分钟没有 HTTP 请求，这**不证明每分钟均做过公网网页可达性探测**。
- entry 汇总窗可跨 metadata 字节边界；本审计没有将不同时钟精确相减或计算多次启动 P95。

## Host loop、资源和趋势

- **1,948 个 rolling window**：normal 1,357 / warning 536 / critical 55。源码每 1 秒采样，保留过去 **60 秒**，约每 5–6 秒输出一次，因此这些窗口**重叠**；sample count 求和只是重复窗口成员数，不能当独立样本总数/事件次数/覆盖秒数。首个 rolling window 还可能包括窗口起点前的样本。
- 各窗口 loop P95 范围 **1.792–24.835 ms**，没有已报告窗口 P95 超过 50 ms；最大 window lag **135.785 ms**，当前 lag snapshot 最大 117.532 ms。reported missedSampleCount 均 0。以上均不是全程 pooled P95。
- pc connected / ICE completed 1,942 条，pc none / ICE none 6 条（启动前 3、结束后 3）。未在已报告状态中看到 connecting/failed/disconnected；采样不会保证捕捉所有瞬时状态。
- resource status **ok 1,948/1,948**；collector ownerAlive=true、cleanupPending=false 全部成立，idle 1,539 / busy 409。该 cleanupPending 只描述 resource collector。资源 age **568.849–5007.953 ms**；memory pressure **unknown 1,948/1,948**，不能当作正常/零压力。
- RSS snapshot **304.465–516.941 MiB**；生命周期 peak 最大 521.793 MiB。connected snapshot 的线性拟合斜率约 **+3.684 MiB/小时**，但 RSS 来回波动，半小时均值没有单调增长；这不足以证明 leak，也不足以排除跨会话保留。结束 RSS 432.805 MiB，高于进入前 324.863 MiB，不能声称内存回到原值。
- threadCount 6–9、taskCount 7–15。媒体期间通常 8 线程 / 13 任务，偶有 9/14/15；结束三个报告窗口回到 6 线程 / 7 任务 / 0 input waiters。未建立持续增长，但这只是活动工作基线旁证。
- system load1 **2.760–17.064**；swap-in/out rate snapshot 最大约 26.33/74.82 MiB/s，memory pressure 状态仍 unknown。它们是 collector 的区间速率，不是本审计做的系统进程取样，不能归因到特定应用或证明某个尖峰的原因。

下表每行只汇总该半小时内**日志窗口**；RSS 为 min–max / 窗口快照均值，lag 为 rolling window max 的最大值，不是新的总体分布。

| 相对分钟 | 窗口数 | RSS MiB | load1 | lag max ms |
|---|---:|---:|---:|---:|
| 0–30 | 323 | 304.5–470.7 / 411.8 | 3.87–9.09 | 74.431 |
| 30–60 | 323 | 388.2–502.3 / 473.6 | 4.37–14.12 | 112.286 |
| 60–90 | 323 | 310.5–461.0 / 426.5 | 5.89–17.06 | 135.785 |
| 90–120 | 323 | 373.7–516.9 / 466.6 | 4.61–11.80 | 104.540 |
| 120–150 | 324 | 328.0–494.4 / 439.6 | 2.79–10.49 | 117.532 |
| 150–180 | 324 | 328.8–474.7 / 434.8 | 2.76–9.08 | 49.731 |

## 抓屏、复用与编码

- paired capture **track-lifetime 最大**在 UTC 22:23:28.254 首次被本日志观察到：**310.232 ms wall = 16.225 ms capture thread CPU + 294.007 ms non-CPU**。以后可重复报告该同一最大值，不能逐行计作新事件。non-CPU 仅是同一次 grab wall−thread CPU，尚不能定位为 OS、锁等待、调度或其他具体原因。
- 最后有效 capture 计数 **attempted=88,321 / completed=88,321 / failed=0 / clipped=false**。首末同 track 计数差推导 **8.171 次完成/秒**（10807.711 秒内 completed 增 88,307）；它是 MSS 完成计数吞吐，**不代表内容有变化或输入已可见**。
- 2,151 个 CAPTURE_STATS 输出窗口，FPS **12.7–19.8**，窗口 FPS 均值 19.458，只有 1 窗 <15。reported output **210,340**，reuse **124,232（59.062%）**；不能把约 19.46 FPS 输出当作每秒约 19.46 次新抓屏。非 reuse 输出 86,108 也不等于内容必定改变。reuse 是重要性能限制线索，现有日志没有隔离其 pacing / 调度 / 锁 / MSS 具体原因。
- capture/recv window `pause_wait=0`、`capture_wait=0`，`recv_total` 窗口均值范围 36.3–47.4 ms；capture_wait=0 来自非阻塞 buffer 读取设计，**不能解释成抓屏没有等待**。MSS wall/CPU 由独立 paired 字段观察。
- 2,150 个 5 秒 encoder window，reported encode count 合计 **210,266**，codec 均 `h264_videotoolbox`，1152×720、target 20 FPS、effective bitrate 3,200,000 全程日志一致。本审计未更改配置。
- local encode max **152.690 ms**；window P95 **4.667–58.472 ms**，**9 个窗口 P95 >25 ms**。这表示局部尾部尖峰，不能说总体 P95=58.472，也不能由多窗低值宣布整体编码性能达标。末尾不满 5 秒窗口可能未输出；capture/output 与 encode 计数边界不同。

## 启动、结束与异常

Host 本地时间序列：offer 04:58:33.377 → gathering 33.425 → gathered 33.728 → answer 33.729 → ICE completed 34.574 → WebRTC connected 35.006。仅 Host 同钟的 gathering 段约 **303 ms**；不从中推出浏览器端首帧或公网传输耗时。早到 candidate buffer warning 1 次。

Signal 的唯一 socket disconnect 在 UTC **23:58:35.934**，与采样器结束清理阶段对应；随后 8 秒 grace，23:58:43.937 fail-closed，44.939 retry attempt 1，44.940 reset applied / FREE。这是实际 teardown 的一次重试，不能表述成“完全没有 reset outlier”。本日志未出现其他 connection attempt bound、offer 或运行期 reconnect 事件。

Host human WARNING 共 594 行：591 行是上述 overlapping lag 窗口的 warning-level 输出（536 warning + 55 critical severity），early candidate 1、结束 DataChannel closed 2；未分类 warning 0。Host ERROR/CRITICAL token 行 **0**，Signal structured level 均 info（187）。零 ERROR 不证明无性能问题或所有 close 都成功。

**teardown 可观测性缺口仍存在**：

- 07:58:43.941 nonempty `control-transition` close 开始，随后同毫秒 Viewer status 0；43.942 的 `viewer-disconnected` 摘要却是 **peerClosed=false / senderReleased=false / track=null / tasks=0**。new-offer 前的空资源摘要同样 false/null。
- 与短测的源码审查一致：close 先 detach 本次捕获资源，再 await pc.close / track.shutdown；另一个 close 可见空字段并推进 authority，使第一个完成摘要被 owns-peer 条件抑制。现有时间序列与此相容，没有 invocation correlation，不能宣称完整动态因果已证明。
- 23:58:47.869、53.869、58.870Z 的三条 post 状态均 pc none / capture unavailable / **6 线程、7 任务、0 input waiters**。它们支持没有持续活动工作残留的判断，不能代替被 detach 对象的释放完成证明。
- `peerClosed`/`senderReleased` 原源码只是 captured local object 的 bool，不是对象内部关闭成功测试；resource collector cleanupPending=false 与 peer cleanup 无关。此次没有新建实质资源泄漏的正向证据，空摘要也不能按释放成功算。

## 验收边界

全窗口 inputEventCount 和 inputWaiters 均 0；本审计没有输入动作。**输入 ACK 往返、Host 排队/执行的有操作分布、输入后帧呈现、真实可见效果、物理屏幕均 NOT RUN**。passive continuity / 满 10,800 秒采样由主代理独立判定；该日志审计不替代它，也不替代用户设备和网络条件。

只保存此文和同名 JSON 的有界允许字段；原始日志只在内存解析，未落盘原文。没有运行测试、构建、npm、Host imports、浏览器、网络、服务操作或进程取样，没有读取窗口上界之后字节，没有改 tracked 文件或 index。
