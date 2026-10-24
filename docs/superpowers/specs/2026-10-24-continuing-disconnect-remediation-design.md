# 持续断连与控制中断整改设计

日期：2026-10-24
状态：确定的恢复/诊断缺口已实施并加载；当前版本五次原租约短断线及30分钟被动连续性通过，整体性能与真实输入效果未全部验收
关联报告：[2026-10-24 持续断连专项诊断](../reports/2026-10-24-continuing-disconnect-diagnosis.md)

## 问题定义

WebRemoteDesktop 今天可以打开网页、建立 Signal 和 WebRTC 连接，但不能保证持续控制。故障表现包括：

- Viewer Socket transport close 后宽限到期，原会话没有回到可控状态；
- PC 仍为 connected/completed 时，画面长时间为 0 FPS 或周期性停帧；
- 输入 ACK 超时、DataChannel stuck、旧 lease 输入被拒绝，用户感知为按键/鼠标中断；
- 页面隐藏导致的主动媒体暂停没有和网络断线清晰区分；
- 自动诊断报告旧 `logCount=0` 混淆了原文脱敏与未采集；有限结构化 trace、Host 执行和可见画面仍需分别对齐。

今天已观测到抓帧长尾、全机资源压力、关闭 sender/PC 上的恢复重试和 transport 故障。21:33 的反例显示抓帧暂停时事件循环也会卡顿，故不能把全部失控归因抓帧 CPU/GIL。设计先做资源归因，再决定隔离架构；参见 [CPU 归因复核](../reports/2026-10-24-capture-cpu-attribution.md)。

## 目标和非目标

### 目标

1. 区分全机 CPU/换页、native 抓屏等待和 Python 处理成本，保护 ACK、ICE 和发送调度；不把未验证的 GIL 推断作为选型依据。
2. 每个连接 attempt 只保留一个媒体恢复操作；旧 PC、sender、DataChannel 和候选在关闭后立即失效并被回收。
3. 可靠输入在 DataChannel 卡住时自动走有界 Socket.IO fallback，恢复后无旧输入重放。
4. 诊断 receipt 同时提供 Signal transport、Host input ACK、capture/encode、后帧和 marker→rVFC 可见效果；缺测明确为 `null/NOT RUN`。
5. 把 `page-hidden` 显示为媒体暂停状态，不把它计入网络断线。

### 非目标

- 不在本设计中重建或更换 Cloudflare tunnel；
- 不把诊断通道 drop 计为 RTP 媒体丢帧；
- 不记录原始键盘、鼠标、剪贴板、坐标、密码、token 或帧像素；
- 不通过延长 grace、无限重试或保留旧 lease 来掩盖故障。

## 设计

### 1. WebRTC bounded capture pipeline

当前生产已有后台抓帧线程、latest buffer、独立单线程图像 executor 和 generation 失效保护。先在隔离实验比较现状与下面的候选模型，不把已有能力重复当作新修复：

```text
native capture process/thread
  └─ latest capture slot (1 running + 1 pending)
       └─ convert/prepare worker (1 running + 1 pending)
            └─ asyncio recv: 只取最新结果，不等待 native grab
```

本机 MSS 使用 ctypes/CoreGraphics，CDLL native 调用期间释放 GIL。比较三种方案：保留线程/latest-slot、独立进程/shared-memory、原生异步抓屏流。独立进程可以提供生命周期隔离，但仍共享 CPU、WindowServer 和系统内存，不能承诺它会降低 native grab 耗时。替代实现必须经等负载、等分辨率、同目标 FPS 的 A/B 证据支持，并满足：

- stage queue 有界，过期帧计入 `coalescedCount`，并释放 native/image 资源；
- capture deadline 超过预算只允许最新帧或上一帧复用，不把等待传回 event loop；
- generation/stop/suspend 会使跨阶段结果失效；
- 日志只有标量耗时、队列和资源状态，不含图像。

生产 factory 已是 `CaptureExperiment(1.0, 1)`，保持 1x target FPS 和 OpenCV 单线程。任何新 FPS 自适应需通过现有 qualification；不自动降低用户分辨率。抓帧分位数来自去重操作或 bounded completion buckets，不使用暂停期间重复的 last/max 快照充当逐次分布。

### 2. Sender/PC 生命周期和一次性恢复

`connectionAttemptId + generation` 是媒体操作的幂等键：

- 同一键只允许一个 `resume`/offer；重复请求合并为一次；
- `pc` 或 sender 为 `closed/failed` 时，旧 sender、DataChannel、候选缓存和媒体引用立即标记 stale；
- 每个 attempt 只允许一次 fresh-offer，候选只接受当前 attempt；
- TURN/STUN timeout 只进行一次退避重试，预算耗尽交给 Viewer 发起新 attempt；
- 所有失败都输出结构化原因，并把 `closed` 与 `ice-timeout` 分开。

控制租约仍然 fail-closed。安全边界不变：旧 lease 的输入不能执行，鼠标按钮和键盘在 reset 时释放；变化只是让恢复从“在旧对象上多次尝试”改为“作废旧对象后一次性重建”。

### 3. 输入 fallback 和可见效果

- keyboard、mouse down/up、reset 保持可靠顺序；move/wheel 使用 latest-only bounded slot；
- DataChannel `readyState` 非 open 或连续 ACK 超时达到阈值时，可靠输入切到 Socket.IO；Socket fallback 有固定 TTL，避免旧输入堆积；
- 新 DataChannel 绑定确认后再切回；切换过程中不重放过期 move，不丢失按钮释放；
- 每个受控 marker 记录 `send → signal relay → host received → host result/ack → frame timing → marker/rVFC`，只持久化耗时和计数。

### 4. Page visibility 状态

Viewer 将媒体状态拆为 `active`、`page-hidden`、`negotiating`、`transport-lost`、`media-stalled`。`page-hidden` 时显示明确的“页面隐藏，媒体暂停”状态；页面恢复只发一个 generation 递增的 resume。服务端和验收脚本在计算断线率时排除主动隐藏窗口。

### 5. Evidence receipt

Signal admin receipt 和 Host diagnostic summary 统一输出：

- 上送、保留、脱敏日志数及结构化 trace 条数，`summaryGapCount`、ring overwrite/drop（注明是诊断环覆盖）；
- Signal RSS/CPU、Host RSS/CPU、event-loop/capture/encode p95/max；
- Viewer decoded FPS、接收端视频帧丢弃区间增量（framesDroppedDelta）、RTP丢包（packetsLostDelta）和freeze，分别记录；
- input ACK expired/dropped/stale-lease；
- `inputToVisibleEffectMs` coverage 和 `NOT RUN` 原因。

任何字段没有真实样本都必须是 `null` 或 `coverage.missing`，不能用 Socket accepted、Host ACK 或 decoder count 代替可见效果。

## 验收契约

| 类别 | 门槛 |
|---|---|
| Host 调度 | 30 分钟会话 event-loop p95≤20ms、max≤100ms |
| 抓帧 | capture p95≤100ms、max≤250ms；有效 cadence≥15 FPS |
| 画面 | 活动期 decoded FPS p50≥18、新鲜采集 cadence≥15 FPS；暂停窗口单列，缓存复用不得计为新鲜帧 |
| 短断线 | 5 次≤20 秒断线；每次≤10 秒恢复，旧 lease 输入=0 |
| 控制（业务输入/reset，不含heartbeat） | ACK p95≤200ms、max≤1,000ms；过期 ACK=0 |
| 可见效果 | marker→rVFC 覆盖率≥95%，缺测保留 `NOT RUN` |
| 资源 | RSS 无持续单调增长；记录全机 swap 差分和 CPU idle，不能以累计 swap 或 Host RSS 代替全机压力；sender/PC 无重复恢复风暴 |
| 诊断 | 日志计数区分 reported/retained/redacted，trace 独立统计，未知为 null；`summaryGapCount=0`，诊断 drop 与 RTP drop 分离 |

本轮200ms为恢复阶段的业务输入/reset观测门槛；总稳定性设计中的TURN 150ms目标仍保留，满足200ms不等于通过150ms目标。heartbeat RTT独立报告，不用于业务输入或可见效果验收。

## 失败处理

若 capture deadline 连续超限，标记 `media-stalled` 并上送原因；仅在现有资格允许时调整 FPS，不自动更改用户分辨率。若 fresh-offer 预算耗尽，断开旧媒体但保留 Signal/Terminal，要求 Viewer 建立新 attempt；若输入 fallback 也无法 ACK，立即释放按键/鼠标并显示控制不可用。任何失败都保留本地服务运行态，等待下一次受控验收。

## 22 点实施收敛：先修复三个确定缺口

1. active 请求已成功 ACK、仍等待新鲜帧时，同 scope 的 soft replay 保留原证明和硬恢复时限。只有此前已成功 ACK、PC/socket/lease/attempt/generation 均匹配的 `stale-generation` 回复可以被忽略；未确认、旧身份或其它失败仍 fail-closed。成功 ACK 的重复回复也不能无限延长等待期限。完成、换身份或断开时释放 scope 引用。
2. 实际 DataChannel `send()` 同步失败返回 false，由现有 Socket fallback 处理。序列化保持在 try 之外；不重放被 DC 接受的输入、不新增 reset、不放宽 lease。
3. v3 控制台原文继续丢弃，仅增加实测条数：reported/retained/redacted/inputTrace。未知计数保持 null，并贯通 raw、结构化摘要、日汇总与 runtime receipt。v3 缺必需身份/capture 不允许退回旧原文路径。

这三个缺口均先用离线反例验证；capture 进程隔离和全机资源调优不纳入本次最小修复。

### 原生采样后的 capture 方案约束

22:43 原生采样把主要等待定位到 CoreGraphics 图像数据 IPC，另有 bytearray 复制与 GIL 等待。实验需要同时比较原生异步 source 和进程隔离，不能只把同一 MSS 调用搬入进程后宣布抓帧已优化。

现机 Quartz/PyObjC 暴露 `CGDisplayStreamCreate/Start/Stop/GetRunLoopSource` 及 IOSurface→CVPixelBuffer 的 CoreVideo 入口，可评估专用 CFRunLoop 线程的 `DisplayStreamCaptureSource`。ScreenCaptureKit framework 虽存在，Python bridge/完整 metadata 未安装；不得据 framework 存在宣称已可用。最初仅为接口预检；后续独立子进程已验证权限 preflight、73 次 complete/1 次 stopped、start/stop 返回0及 IOSurface→CVPixelBuffer 元数据桥接。没有读取像素或接入生产，完整像素归属、静态恢复、资源回收及性能 A/B 尚未验证。

异步 source 的 callback 只校验状态和 generation、记录时钟、替换 latest native 引用，不执行全屏复制/resize/日志 I/O，不等待 asyncio。最多保留 latest 和处理中各一个 buffer。FrameSnapshot 显式携带 stride、pixel format、owner/release 与 generation；不能沿用 `.raw.reshape(height,width,4)` 的紧密排列假设。转换 worker 负责按 bytesPerRow 读取和必要的独立副本。idle 不计新鲜帧，静态恢复须等待真实 complete 帧；停止先封 publication，再 native stop，并等 runloop callbacks 排空后释放 owner。资源未回收时保持 pending，不能用 stop 请求代替回收证据。

上线以 source→publish/paint age、fresh cadence、输入效果、资源回收改善为门槛；异步模式不再有同步 grab wall 指标，不能以指标消失冒充性能改善。另记录整机运行队列和 CPU idle，避免将不同系统压力下的样本误当同负载 A/B。

Signal 的 media/relay 拒绝回复必须携带验证后的请求 state/generation/attempt；不得回显 lease。Viewer 只处理当前请求的 scoped rejection。Host 的失败 ACK reason 仅允许固定业务枚举，禁止自由文本透传。必须通过真实注册的 Signal handler 验证重复 generation 在到达 Host 前被拒绝的路径，不能仅用直接调用 Viewer ACK 的 fixture 代替。

诊断回归在模块导入前配置唯一临时目录，所有清理须验证目录归属；默认生产目录只能做纯路径推导断言。通过继承模拟生产目录的子进程 canary 证明测试无生产文件副作用。历史证据被删除必须报告来源和缺失，不能重建摘要后称原件已恢复。

### 维护验收发现的恢复诊断缺口

生命周期 reset 失败没有 DOM incident，必须在同 recovery identity 终态失败、控制释放之前捕获 `recovery-failed` 诊断。保留现有前台/active/lease/身份/15秒节流门禁，采集同步或异步失败都不得影响控制恢复。发送失败和明确 ACK 拒绝不得伪报为 ACK timeout；具体原因只进入既有白名单状态/trace。日汇总保留固定 recovery-failed reason。

Signal 仅对已验证且向 Host 转发的 v2 mouse/keyboard reset 关联后续 ACK，最多32项、TTL10秒，使用本机单调时钟。只记录 inputId 哈希、固定输入类别/状态、租约epoch、目标存在/校验通过/ACK租约及类别匹配/是否转发和 request→ACK 本地耗时；这个耗时包括 Host 和本地传输，不能叫纯网络耗时。无对应 reset、旧 Host 或普通键入不增加逐条日志，观测异常不影响原授权/转发。每项只记录首个匹配 ACK，即使其 shape 无效也消费记录，后续同ID仍按原协议转发而不再逐条记录。它不能证明 Viewer 已收到 ACK。

采集失败快照时，UI/真实diagnostic builder读取keyboard snapshot可能同步触发另一条reset超时。为防止快照完成前嵌套释放，使用仅覆盖同cycle同步采集调用栈的门闩；finally清除并执行一次既有控制恢复。不得跨await持有、不得延长期限、不得忽略正常ACK。测试必须用真实双reset定时器及真实builder，直接手工调用失败函数不能替代这条反例。

验收脚本的 status-reader 失败另记有界 stage/errorCategory/elapsed 的私有 sidecar，保留原 summary/lifecycle schema 与所有期限。无 sidecar 只能是来源未知，不能倒推为浏览器或 Host 故障。

### 低负载 pacing 的独立约束

23:41 低负载窗口中 grab rolling 约25ms，但请求约25ms的 pacing sleep 实际约100–105ms；原生栈主要在 nanosleep，不能继续以 GIL 或 CoreGraphics IPC 统称这一路径。独立短进程的 timer 原语轮换和进程活动声明均未复现 Host 超睡或证明改善，因此不直接替换 Host timer、不引入忙等，也不把 App Nap 当作已确认根因。下一步须在 Host 等进程年龄、负载及电源上下文下区分 sleep、唤醒调度和 GIL 恢复，再比较候选；异步 source 同样必须通过 fresh cadence、真实输入效果和资源门槛。

### 10月25日 launchd 调度候选及加载契约

部署前快照中Host及Signal的launchd spawn type均为daemon、线程priority/maxpriority均20；普通shell短进程为31/63。仅独立LaunchAgent的首轮20次20ms timer对照，默认excess p95约134.31ms，Interactive约7.40ms，CPU耗时仅约1.3ms。这支持启动上下文可导致额外等待，但不是Host抓帧/ACK性能A/B。

候选为两个本地实时交互服务显式ProcessType=Interactive，不设置全局电源、nice、实时优先级、LegacyTimers或忙等。Host继续使用现有plist及restart-host脚本；必须先比较已安装与源配置，再决定kickstart复用或预检后re-bootstrap，预检失败不能覆盖旧配置或停止健康job。Signal helper将submit改为参数数组和plistlib生成的私有plist，经唯一label预检gui bootstrap后再停旧服务；真实bootstrap失败须尝试恢复原submit路径并明确失败，不能宣称Interactive已加载。不得操作任何tunnel label或进程。

上线前审查配置加载/回滚与纯临时mock测试；无Viewer维护窗口只重启本地服务。核实实际spawn type/线程priority及本地、公网健康，再重复strict短断线和真实会话capture/CPU/RSS/fresh cadence。仅timer探针改善不能勾选整体验收。

### 生产重送后的唯一计数契约

同一已持久化v3 diagnosticId经Socket/HTTP回退重复送达时，继续返回原持久化ACK，原store去重与Host单次转发保持；runtime evidence只观察首次非duplicate报告。legacy无ID无法证明同一报告，仍按独立上传计数。运行统计sink异常不得把已成功保存的HTTP/Socket报告ACK变为失败。测试必须用真实注册HTTP+Socket入口、两种顺序及私有diagnostic目录，验证raw/summary/Host转发/计数均不重复，不能只调用recorder模拟。

### 单向控制心跳的确认与恢复

自然baseline已复现Socket/PC短时仍connected而lease12秒过期。缺少逐次成功接收历史，不能唯一归因某跳；确定缺口是Viewer无法确认续租是否成功。新增显式controlHeartbeatAckV1能力协商，未支持的旧Server/Viewer保持原行为。新请求和ACK用seq/epoch/attempt及attemptSequence关联，内存进一步绑定当前socket对象/id、lease对象和连接scope；ACK只证明既有authorize+heartbeat成功，不授予控制。

每3秒心跳最多一个pending，ACK预算2500ms，使用Socket.IO timeout释放ACK表。有效ACK清除pending；旧scope/乱序/晚ACK无效；明确拒绝保持原freeze，不自动争抢。能力确认、可见、仍持有当前控制且非手动断开、同scope连续2次超时，单次关闭当前engine，走现有自动重连和正式resume/rebind。Engine.IO的close会等待writeBuffer排空；若捕获的同一engine仍closing，关闭该engine自己的transport，避免polling挂起POST使恢复永久停在closing。不得再读取successor engine或关闭后来连接。不得调用manual disconnect取消用户intent，不延长12秒TTL、不重放输入、不把其它消息当续租。2500ms预算不是网络SLO保证；公共链路慢ACK可能触发恢复，必须测量误触发及原租约恢复结果。初始grant先完成当前attempt绑定，再启动带scope心跳；保留legacy兼容。已有legacy scope不能阻止晚到的ACK capability升级，复用只允许同一已启ACK的scope。

观测只记录固定原因、seq/epoch、计数和单调age的有界摘要，禁止leaseId/token/输入内容。测试需覆盖正常2400ms确认不恢复、2500ms后晚ACK无效、明确拒绝、隐藏/手动关闭、旧能力、并发/重复定时器和当前owner边界。

### v3 媒体区间的真实覆盖证明

v3 事件正文按设计丢弃，runtime receipt 因只读取 events 而缺失实际已采集的 FPS/drop。不能直接把 canonical 默认零填入 receipt。producer 在 canonical 归一化前证明区间已观测、非 warmup、elapsed 正且有限、请求前/完成时/上一请求的 PC、attempt、stream 和 track owner 一致；所选 inbound 的 trackIdentifier 必须匹配当前 track，id/SSRC/trackIdentifier 在两端均已知且稳定。未支持这些字段或来源有歧义保持 unknown，不改变媒体健康选择策略。

原始 owner、track/id/SSRC 仅在有界内存中保留；诊断只输出 schema1 interval kind、elapsed/sampleAge 和 FPS/drop 已观测布尔值。同 performance 时钟下 sampleAge 必须在0–5000ms。Signal 白名单继续验证边界后，v3 receipt 才提取 FPS 和独立的 droppedFramesIntervalDelta（webrtc-inbound-interval）；legacy 事件counter（累计/区间口径未知）独立保留，不能混称累计丢帧或唯一去重的长会话总数。多个诊断可能覆盖重叠区间，不能将这些 delta 相加当整段掉帧。

统计 last 取实际输入顺序中的最后有效值，max/分位数使用排序副本；runtime 和 diagnostic 的资源样本共享有界 FIFO，不能先按来源分组再拼接而改变最后值。

### 公网单次慢ACK后的触发修正

0a0bc6d首次strict在无fault baseline约66秒触发单次ACK watchdog，原结果保留失败。Signal检测disconnect前247ms刚成功续租，最大HB接收gap6.4秒；这不是浏览器发起close前247ms，两端关闭观测有网络传播时间，且旧版未保留请求seq，不能唯一认定上/下行哪段。普通UI短测同版本公网8ACK为429–1134ms、median505.75ms；随后loopback7ACK为0.8–12.5ms、median0.9ms。不同顺序负载不作严格A/B，但显示公网信令往返存在明显额外耗时，不应继续全归Host CPU。

比较方案：只延长每次ACK期限会使单pending跳过更多续租周期；改走DC续租需要新的Host授权协议与独立验收。因此本轮保留2500ms单次deadline、3秒发送与单pending，第1次timeout仅保留计数/最后失败快照，只有同current scope连续2次timeout才关闭transport。有效且deadline内的当前ACK清零streak；旧/晚ACK、重复grant不能替新scope清零或回避失效。hidden/manual/superseded保持守卫，隐藏窗口失败不带入前台累计。

连续blackhole理想情况下从首次未确认send至close约5.5秒，从上次成功send后故障至close可约8.5秒；12秒TTL不会延长，剩余时间不保证任意慢rebind保留原lease。增加当前scope安全整数seq和Server最后accepted/ACK-enqueued seq摘要以关联后续现场，不输出身份/token或逐HB日志。strict baseline仍在自然disconnect后停止，不能用其清理行为判断自动recovery是否完成；需另行观察完整恢复。
