# host-cadence 短测运行证据独立复核（R1）

该次整体状态保持 **INCOMPLETE**：301 个采样点报告为零缺样、零迟到、零失败、零身份变化，rVFC 最大间隔 983.2 ms；但 browserClose 为 timeout（4,626 ms），managerStop 为 ok（79 ms）。本审计不把画面连续性与 cleanup 状态混为通过，也不把 rVFC 当内容更新率或真实输入响应。实际输入与六项延迟指标均缺测 / NOT_RUN。

## 范围与证据边界

只读 Host 已完成窗口：device 16777220、inode 45148030、字节 [1596206,2072688)，476,482 字节，选中 1,062 个物理行、保守剔除首个边界未知行后纳入 1,061 行，SHA-256 `0b00bd253ffab152d513819e7cd58eb9c8411de45b214ee172e24ad0581a5fc6`。start/end 元数据分别为 2026-10-18 14:35:47.525766 / 14:43:49.401305 CST；JSON 记录两个元数据文件的独立哈希。未读取完整或历史日志、Signal 日志字节或当前进程状态。只额外核对该次 summary/lifecycle/SUP 的固定标量及纯源码中的字段含义。线上 product/runtime TIP / Host 身份沿用 root 提供的 c239482 / e5927c748f25c28546a7bd9d86690d4bac434404 / Host76982；本审计未重验线上文件与进程。build 元数据均为79bf9a5afea0458e。未修改源码、index、参数或运行态。

## R1 首界过滤修正

本修订保留原 `.md` / `.json` 不变。原窗口 SHA 与字节范围完全相同；未读取 startOffset 之前任何字节。现有 start/end 元数据仅记录 offset / inode / size，不能证明 offset 前一字节为换行。因此，即使首个选中行可解析为 JSON，也不把它当具有已证行首归属的完整日志事件；按统一保守方法无条件剔除这一行。

纳入物理行由1,062减至1,061，Host lag 摘要由87减至86（critical仍79，warning由8减至7），pc none / capture unavailable由31减至30；56个connected/cadence快照保持不变。eventLoop窗口P50下界由0.613896变为0.645015ms，窗口P95下界由13.101968变为14.336797ms；其他已汇总字段的快照均值及count随排除样本重算，完整前后数值列入R1 JSON。其余 Host 数值 min/max 不变，collector/resource状态计数改为86。第一条纳入的Host lag时间为2026-10-18T06:35:52.994904+00:00。

逐项重算已验证56个有效cadence快照、61个输出窗、61个编码窗、6条cleanup固定投影及其主要范围/总数均未变化；真实输入、browser timeout、Host cleanup时序与native释放证据限制、整体INCOMPLETE均保持原结论。浏览器summary/lifecycle/SUP为此前已核对上下文，本次不重复读取或重算其原始数据。R1 JSON同时记录原产物哈希、筛选后字节哈希和受影响Host统计的前后值；不能把R1的86条与原87条混用。

## 新 cadence 定位结果

56 个带有效 interval 的快照全部处在 grab phase。它们是相互重叠的 rolling-60s-completion-buckets，不能把窗口计数相加、均值当全程均值或重复最大值当多次事件。interval 到下一次 capture start 才闭合，可能从 completion 窗口起点之前开始；startup 窗口也可能不足 60 秒。

末次有效窗口（14:41:56.080482 CST）：292 个 interval，covered 59089.096892 ms，rate 4.941690013 Hz；interval mean 202.359920863 ms = grab 199.480882312 + postGrab 2.403207404 + pacingActual 0.000000000 + other 0.475831147 ms。其中 publishLockWait mean 0.014188151 ms，publishCritical mean 0.081745144 ms，均为 postGrab 内的子集，不能再加一次。最小目标间隔为50 ms，而该窗 requested/actual pacing 均为0；不存在由此证据支持的固定补睡主导问题。

最大观测 paired interval 1595.024032 ms = 同一 interval 的 grab 1586.577729 + postGrab 7.193346 + pacingActual 0.000000 + other 1.252957 ms。该 pair 的 publishLockWait 0.814231 ms、publishCritical 1.884358 ms包含于 postGrab。源码 `capture_cadence.py:161–173` 保证这组 partition 来自同一闭合 interval；本次全部有效快照的 stage sum 分解最大浮点残差为 0.000000000007 ms。各 stage 的独立 max 不来自同一次 interval，不可相加。

窗口均值和该极值都显示，这次慢周期主要落在 grab 包围区间，而非实际 pacing 或发布锁。track-lifetime 最大 grab wall 1586.578 ms，对应同一次抓屏线程 CPU 36.211 ms、非 CPU 1550.366 ms（各自0.001ms四舍五入，和可能差0.001ms）。非 CPU 是 wall 减线程 CPU 的剩余，不等于某一唯一 OS 原因，也不证明 WindowServer 卡死。源码包围区间含 capture 观测 begin 开销和 `resource.grab` 及 CPU/时钟读取边界；不应把整个 bracket 精确称为无额外开销的纯 native grab。

源码 `host.py:1576–1591` 沿用扣除 grab+post 已耗时间的 pacing；`CaptureCadenceObserver.start()` 的周期聚合发生在当前 grab 后，因此其成本包含在当前 postGrab；finish/phase/下一轮 gate 等边界成本可能落在 other。当前观测足以反对“采集循环固定多睡了整帧”或“发布锁是这次主要瓶颈”的假设，不足以宣布 observer 零开销、某单个外部进程是根因或增加倍频必然改善性能。该次快照计数差估计 capture rate 为 4.184495685/s，只是稀疏端点估计。

## Host 资源、输出与编码

86 个 Host lag 摘要中79为critical、7为warning；eventLoop 窗口 max 最大690.282135 ms，窗口P95范围14.336797–244.974718 ms，missedSampleCount均0。这是窗口统计，不能制造全程P95。systemLoad1为13.275–87.388，swap in/out 有非零速率；memoryPressure始终unknown，因此只可确认这些高负载/交换观测，不能断言内存压力等级或具体竞争进程。

资源状态86次均ok，collector ownerAlive均true、cleanupPending均false；resources.elapsedMs最大10,478.099073 ms是资源样本间隔（`runtime_observability.py:241–259`），不是 collector 单次执行时长。RSS范围148.242188–437.085938 MiB；短时RSS变化不是泄漏证据。inputEventCount、inputWaiters、pendingRelayFrames在这些快照中均0。

61个已完成 CAPTURE_STATS 输出窗累计4043输出、2786复用，比例68.909226%；输出FPS窗口算术均值13.142623，范围2.8–18.6，包含复用内容。61个独立 encoder 窗口累计4078次编码，max1666.208 ms，窗口P95范围24.498–275.011 ms；h264_videotoolbox、1152×720、target20FPS/3.2Mbps不变。输出窗和编码窗切分不同，不以4078与4043的差值判丢帧。未输出的尾部partial窗口不在这些总数内。没有在指定窗口发现已搜索的 frame processing/conversion failure、signal disconnected、已知peer failed行、capture-close-failed行或 traceback；这不是完整错误类型证明。

## 精确 cleanup 与 browser timeout 时间关系

有3个完整 cleanup start/terminal 配对：new-offer（旧对象为空）、control-transition（旧PC/track/sender非空）、viewer-disconnected（重入时对象为空）。没有再依赖“当前 authority 相同才输出”的旧摘要逻辑。

非空 control-transition：14:41:56.143–14:41:56.307 CST，elapsed164.371811 ms，peerClose/trackShutdown均returned，peerConnectionClosed=true，captureThreadAlive=false，captureCloseState=closed，captureShutdownJoin=returned，executorShutdownRequested=true；authorityCurrent=false仍有 terminal，currentPeerPresent=false。重叠的空 viewer-disconnected 于14:41:56.211开始、.215返回，elapsed4.827259 ms，不能冒充前一个旧对象的清理结果。terminal之后20个Host快照均pc=none、task7/thread6，input waiters无积压。

`capture_resource_owner.py:31–45` 的closed仅证明 worker 调用 resource.close() 未抛出并返回；线程false/join returned证明该采集线程在观察时已退出；`host.py:1653–1655` executor.shutdown(wait=False)只证明请求已发出，不证明executor线程终止；senderReleaseConfirmed保持null。不能据此宣称底层native对象/内存释放完成、sender释放或整个进程树退出已获证明。

Python lifecycle 原始单调时钟：browserClose [1458161901,1458166527] ms（4,626ms，timeout），managerStop [1458166527,1458166606] ms（79ms，ok）。failure锚点为monotonic1458166606ms / wall1792305712377ms（14:41:52.377 CST）。在该短区间没有wall clock跳变的条件下，browserClose约14:41:47.672–14:41:52.298，随后managerStop至14:41:52.377。Host非空cleanup启动比failureWall晚3,766ms，因而这次164ms Host清理没有与browserClose超时阶段重叠；不能直接归因browserClose timeout于该Host await，也不能仅凭时序确定唯一browser/manager/OS/传输根因。SUP记录7个registered identities均exit、0signals、没有意外coverage项；full process tree exit仍不是已证明能力。整体INCOMPLETE不能改写成PASS。

## 可支持的后续决定

保留本次INCOMPLETE和性能较差的实测，另做独立、完整退出的资格复测。新cadence可以继续用于区分grab、发布和调度/observer边界；若需要优化抓屏机制，应以同口径fresh capture/content age、真实输入applied后新帧及隔离观测作依据。这些证据尚不支持凭reuse比例提高倍频、改FPS/画质/编码器、跳过缓存续帧或杀/调优其他进程。即使以后连续性通过，也不能替代真实输入到画面验收。
