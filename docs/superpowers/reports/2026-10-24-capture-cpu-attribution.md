# 抓帧长尾是否由 CPU 卡顿引起：复核

日期：2026-10-24，Asia/Shanghai。只读分析日志、依赖源码和系统采样；未修改业务代码、未重启服务、未调整其它业务进程或 tunnel。

以上描述初始只读阶段。10月25日后续已修复并加载本地服务调度、控制恢复和观测代码，tunnel未操作；最新实测见文末及[实施记录](2026-10-24-control-recovery-fix-execution.md)。

## 结论

**部分窗口观测到 CPU/系统资源压力，慢帧主要不是抓帧线程自身持续计算；资源压力的因果贡献仍待受控对比。** 线程 CPU 很低而抓帧墙钟很长，表示时间主要没有计入抓帧线程 CPU；可能是 CoreGraphics/WindowServer 工作或等待、调度、换页、锁或 GIL 重新获取。现有数据不能在这些原因中唯一归因。

也不能把所有事件循环卡顿归为抓帧：21:33 抓帧已暂停约 8 分钟，事件循环仍有约 2 秒的延迟。反过来，13:34 一次约 1.1 秒的抓帧发生时，事件循环滚动最大延迟仅 33.8ms。因此两类长尾有共同出现，也有独立出现，必须分别修复和验收。

## 数据方法与覆盖

- 此次可保留 Host 轮转日志范围是 12:26:21.736–21:35:29.763；与前一份 19:42 截止的报告分开。日志轮转已覆盖更早数据，不能假装重新读取了全天原始日志。
- 解析 5,905 条 `host_event_loop_lag`；按计数回退/不可用过渡推断 track，再以 `track + completed` 去重。track 身份是推断值，不能代替真实 generation ID。
- 活动状态限于 `grabbing/idle`；得到 1,500 个不同的末次完成抓帧样本。它们是约 5 秒遥测看到的最后一帧，不是全部抓帧总体。
- 3,380 条 suspended 记录只对应 15 个 track/completed 键，主要是重复冻结的 last/max；不混入活动分布。
- `threadCpuMs` 来自同一抓帧 bracket 的 `time.thread_time_ns()` 差分；`nonCpuMs = wallMs - threadCpuMs`。非 CPU 时间不是“全机空闲时间”，也不能排除其它线程/WindowServer 正在计算。
- Host CPU 使用相邻事件的 `processCpuSeconds` 差分除以墙钟，100% 表示一个逻辑核；不是整机占用率，也不是精确落在某一次抓帧内的 CPU。

完整脱敏标量摘要见 [capture-cpu-attribution.json](evidence/2026-10-24-continuing-disconnect/capture-cpu-attribution.json)。

## 慢帧的 CPU 配对

| 观测时间 | 抓帧墙钟 | 抓帧线程 CPU | 未计入该线程 CPU | 相邻窗口 Host CPU | system load1 / loop 滚动 max |
|---|---:|---:|---:|---:|---:|
| 14:03:42.607–48.681 历史最大值更新 | 4,624.806ms | 33.124ms | 4,591.682ms，99.28% | 17.70% 单核 | 56.43 / 1,307.95ms |
| 21:24:28.405 末次完成样本 | 3,905.411ms | 39.383ms | 3,866.028ms，98.99% | 5.81% 单核 | 37.36 / 3,222.26ms |
| 13:34:18.685 末次完成样本 | 1,124.770ms | 18.549ms | 1,106.221ms，98.35% | 60.81% 单核 | 5.71 / 33.76ms |

活动样本中有 49 个墙钟≥500ms，所有样本的非 CPU 占比都≥91.96%，中位为 94.94%；抓帧线程 CPU 在 17.45–41.87ms。这个结论足以否定“这些帧只是抓帧线程忙算了几秒”。49 只代表遥测看见的慢样本数，不能换算全天慢帧率。

4,624.806ms 是在相邻快照间出现的新 lifetime maximum；知道它发生在 6.073 秒的检测区间内，不知道那一帧的精确完成时间。不能把同一 lifetime max 重复计成多次慢帧。

## 抓帧暂停时仍卡顿的反例

21:33:25.696 的同一 Host 快照：

- capture=`suspended`，上次完成距今 488,073ms（约 8.13 分钟）；
- event-loop p95=491.47ms、max=2,014.98ms，missed sample=2；
- system load1=63.48；
- resource collector=`timeout`，资源样本已老化约 8.75 秒，不能把里面的 RSS/swap 当作该时刻的实时值。

21:34:55 对 Host 做了 2 秒、10ms 间隔的只读 native stack sample：主线程主要在 kqueue wait，未捕获到 CoreGraphics 抓屏调用。该采样恰好发生在暂停期，只证明这两秒没采到抓屏，不能用来解释活动期某个慢帧。

## 全机资源压力

21:33 的 `top` 第二份区间采样：12 逻辑核、load1≈77.94，CPU user≈34.4%、system≈45.2%、idle≈20.4%；内存压缩约 9GiB。其它业务、数据库、WindowServer 和 Codex 分析工具同时有负载。load 不是 CPU 使用率，不能用 load/核数直接换算百分比；CPU 尚有 idle 也不排除线程调度和内存等待。

相邻 `top` 输出存在 swap in/out 增量；独立 21:34:17–22 的 5.14 秒 `vm_stat` 差分显示 swap-in≈0.53MiB/s、swap-out=0、解压≈5.46MiB/s。交换活动随时间变化，不能把上一份报告某些窗口的 `swap=0` 推广为今天无内存压力，也不能用开机累计 swap 倒推本次故障。

当前分析本身也产生短时负载，因此此次全机采样用于证明**采样当时**资源争用存在，不能倒推为中午所有断连的原因。未停止其它业务进程、未提高 Host 优先级，也未启动额外 Viewer/抓屏压力实验。

## 代码复核对原方案的修正

1. `host.py:_create_screen_track()` 已传 `CaptureExperiment(1.0, 1)`，即生产 1x 抓帧、OpenCV 单线程；兼容入口才保留 2x。原方案“生产 2x 改 1x”已删除。
2. 当前已有后台 capture thread、latest screenshot buffer、单线程图像 executor；`recv()` 不等待 native `grab()`。不存在已被证明的 event-loop 同步抓帧缺陷。
3. 本机 MSS 10.2.0 经 `ctypes.CDLL` 调用 CoreGraphics `CGWindowListCreateImage`、`CGDataProviderCopyData`，不是 PyObjC 抓屏；CDLL native 调用期间释放 GIL。返回后的复制、裁剪和 GIL 重新获取仍可能有成本，尚未隔离。
4. `capture.lastDurationMs/maxDurationMs` 是最后操作/track 历史极值，暂停期间会重复；原报告的快照 p95 不能标成逐次抓帧 p95。FPS 也必须区分解码/缓存复用和新鲜抓帧。
5. 进程隔离是候选：可隔离生命周期和部分 Python 竞争，但不会隔离全机 CPU、WindowServer 或换页，不能承诺它会把 native grab 降到 250ms 内。

## 后续解决顺序

1. **先补归因与可重复实验。** 同时记录全机 CPU idle、swap 差分、native capture bracket、线程 CPU、fresh-frame cadence、Host loop 和可靠输入 ACK；暂停与活动窗口分开。
2. **独立复现恢复问题。** 对 closed sender/PC、重复 resume、旧 candidate 和可靠输入 fallback 做最小反例；不等抓帧优化完成才处理控制恢复。
3. **在维护窗口做等负载 A/B。** 保留当前 1x/单线程配置，对比现线程实现、capture 独立进程和原生异步抓屏流。只有测到具体改善才切生产；其它业务资源调整需另行授权。
4. **验收新鲜画面与控制。** decoded FPS 正常而 fresh capture 低仍不能通过；分别报告 Host 执行、ACK RTT 和 marker→rVFC，不互相替代。

截至本节初始只读归因时点，诊断、spec和plan已同步修正，业务代码与服务运行配置尚未改变；后续实际实施及维护验收见文末，不以初始诊断替代修复。

## 10月25日追加：launchd上下文可复现timer长尾

后续quiet会话中，grab rolling约25ms，但pacing请求约25ms、实际约100–105ms；原生采样主要在nanosleep，sleep恢复GIL仅1/441。普通shell的20ms短进程探针未复现该幅度，不能据此排除Host启动上下文。只读核对Host与Signal均spawn daemon(3)，线程priority/maxpriority20/20；shell短进程为31/63。

独立唯一LaunchAgent默认/Interactive对照（主线程各20次20ms）：默认excess p50/p95/max=17.634/134.308/155.981ms，Interactive=2.038/7.395/9.768ms，进程CPU约1.37/1.26ms。两个临时label均已bootout且不存在；后续thread阶段未在35秒预算完成，不纳入结果。该反例证明默认启动上下文可产生明显timer长尾，支持Interactive作为候选；不能单凭探针宣称真实capture或ACK已改善。

这也解释为何此前只看Host CPU利用率或普通shell timer阴性仍未定位：进程服务类型不同，且高压力时另有CoreGraphics IPC、调度和内存压力。当前调度候选仅作用于本地Host/Signal，不改nice/全局电源/LegacyTimers，不采用忙等；部署后仍需核实实际spawn/priority与真实会话fresh cadence、loop、资源、短断线和可见输入。对应证据：`evidence/2026-10-24-continuing-disconnect/launchagent-timer-context-ab.json`。

## 当前版本实测：不能简单叫作CPU算不过来

Host64981及Signal15428已实际加载launchd Interactive。旧quiet窗口请求约25ms的pacing实际100–105ms，加载后首轮实际约27ms，新截图完成率约7.8→18.3Hz；不同负载与进程年龄不能作为严格等负载A/B收益。这个结果支持服务调度上下文是一个可修复因素，不证明CoreGraphics/WindowServer等待全部消失。

当前build79d27719867d5814的30分钟正式域名TURN会话中，Host单核等效平均CPU58.26%，新截图rolling rate median18.722Hz，event-loop观测max28.387ms；capture最后操作快照median32.969/p95 47.252ms，仍不是全帧分布。本窗口18:52:33Z新增的capture max275.659ms中，抓帧线程只使用21.742ms CPU，nonCPU253.917ms，约92.1%没有计入该线程CPU。其余线程、WindowServer、调度/换页/锁/GIL恢复各占多少尚未隔离，因此不能把它解释为“Host抓帧计算占满CPU”。RSS峰值540.465MiB、有明显回收；既不能据此确认泄漏，也不能宣称内存优化完成。

公网控制路径也存在独立延迟：同旧加载版本顺序短测公网ACK median505.75ms、loopback median0.9ms；新30分钟心跳ACK median588.6/p95 716.9ms。它们包含调度及传输，不是纯网络时延，更不是输入效果。五次恢复中reset ACK的两样本较大值405.5–496.3ms仍高于200ms目标，不能通过继续优化Host抓帧就假设这部分必然消失。

目前已分别完成控制恢复代码修复、五次原租约短断线及30分钟被动连续性，尚未完成全帧capture性能、同负载后端A/B及业务输入可见效果。原生异步后端保留为受控候选，先验证fresh cadence、端到端输入、CPU/RSS与资源回收，再决定替换；不因为同步grab指标消失就判优化成功。详细覆盖及源文件SHA见[当前长会话证据](evidence/2026-10-24-continuing-disconnect/heartbeat-final-passive-30m.json)。
