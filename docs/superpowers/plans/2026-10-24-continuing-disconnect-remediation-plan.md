# 持续断连整改执行计划

日期：2026-10-24
关联设计：[持续断连与控制中断整改设计](../specs/2026-10-24-continuing-disconnect-remediation-design.md)
关联诊断：[2026-10-24 持续断连专项诊断](../reports/2026-10-24-continuing-disconnect-diagnosis.md)

## 执行边界

本计划基于 2026-10-24 日志。初版只完成诊断；后续已在 main 提交三个确定恢复缺口及诊断增强，并在维护授权下仅重启本地 Signal 加载。初期Host原进程未重启；10月25日调度修复后Host也已按脚本重启，tunnel始终未重启。实施继续沿用 `webremote-service` 规则：先读启动文档，重启只允许本地 Signal/Host，结束前必须核对 health、Host online、Viewer 范围和当前密码。

## 阶段 0：建立可重复基线

1. 固定一个维护窗口和唯一 Viewer；保存 Signal JSONL、所有当前/轮转 Host 日志的起止时间、进程 PID、构建身份和正式入口 health。
2. 在不发送业务输入的 passive 会话中记录 event-loop、capture/encode、RSS、FPS、RTP dropped/freezes 和 page visibility；不能把页面隐藏窗口混进网络断线率。
3. 在单独的 controlled marker 会话中记录输入 ACK、Host result、后帧和 marker→rVFC；没有 marker 的会话只报告 `NOT RUN`。

完成条件：同一会话的 Signal、Host、Viewer 证据可以按 `connectionAttemptId + generation` 对齐；任何时间段缺日志都标为 gap。

### 0a：先验证 CPU/等待归因（2026-10-24 复核新增）

- [x] 核实生产已使用 1x 抓帧、OpenCV 单线程；本机 MSS 是 ctypes/CoreGraphics，native CDLL 调用释放 GIL。
- [x] 配对抓帧墙钟、线程 CPU 和非 CPU 时间，分开活动与暂停窗口，去重 completed；保留“稀疏观测，不是全部抓帧分布”的限制。
- [x] 采集全机 CPU idle、内存压缩和 swap 差分；确认暂停抓帧时事件循环仍可出现秒级延迟。
- [ ] 在维护窗口控制其他负载，比较低/高系统压力下抓帧和 ACK；再做线程、独立进程、原生异步抓屏的等条件 A/B。未验证前不确定进程隔离是首选修复。

后续实施不得通过终止其它项目进程、变更全机优先级或重启服务来制造“低负载通过”。其他业务负载调整需有独立授权；当前只记录影响。

## 阶段 1：把 WebRTC 抓帧从事件循环隔离

### 代码任务

1. 抽取 `ScreenCaptureTrack` 的 capture adapter，提供 `capture() / release() / close()` 和有界 latest-slot 协议。
2. 阶段 0a 完成后，依据 A/B 选择当前线程 adapter、独立进程/shared-memory 或原生异步抓屏；不以 GIL 假设直接替换生产。加入 deadline 和 generation 检查。
3. 保留现有单线程 convert/prepare executor 和异步 `recv()`；只在复现并发积压后增加 replaceable pending，不能声称现状在事件循环内执行 native grab。
4. 保持已存在的生产 1x capture multiplier 和 OpenCV 单线程。FPS 自适应另走 qualification，不自动降低用户分辨率。
5. 增加 `captureQueueWaitMs`、`captureMs`、`prepareMs`、`coalescedCount`、`reusedCount`、`deadlineExceeded` 的结构化摘要，禁止写入帧数据。

### 测试任务

- 扩展 `python-host/test_capture_observation.py`、`test_media_stage_boundaries.py`、`test_capture_shutdown_contract.py`，覆盖 process/thread adapter、suspend/resume、stop、generation invalidation、native resource release。
- 增加一个 synthetic slow-capture fixture：capture 500ms 时 event loop 不得被阻塞，队列最多 1 running + 1 pending，旧帧必须释放。
- 运行 Host focused tests，再运行完整 Python/Node 测试；所有测试必须顺序执行，避免共享 `dist.tmp` 争用。

### 通过门槛

在隔离 Host 运行 10 分钟：capture p95≤100ms、max≤250ms，event-loop p95≤20ms、max≤100ms，有效 cadence≥15 FPS；否则不发布新的 capture adapter。该门槛不阻塞阶段 2 的独立恢复修复，恢复修复可以在现有 capture adapter 上复现和验收。

## 阶段 2：关闭 sender/PC 后只做一次 fresh recovery

### 代码任务

1. 复核已有 `_media_activity_lock` 与 offer 生命周期的协作；若最小反例证明跨 handler 并发缺口，再补 `connectionAttemptId + generation` 的幂等合并，不能重复增加已有锁。
2. 检测 `pc/sender` closed/failed 时，原子作废旧 sender、DataChannel、候选缓存和媒体绑定；不得在旧对象上调用 resume。
3. 每个 attempt 限制为一次 fresh-offer 和一次 TURN/STUN 退避重试；超时后输出 `transport_unrecoverable`，交给 Viewer 新建 attempt。
4. 先复核候选缓存已有 attempt 绑定与上限；`PC not ready` 本身可能是正常早到候选，不能据此认定无限缓冲。只对可复现的旧 candidate 漏洞补边界和 `staleCandidateDropped` 证据。
5. 把 `host_media_resume_failed` 原因与 `control_reset_completed` 关联到同一 operation，避免一次恢复产生多次看似独立的 failure。

### 测试任务

- 扩展 `python-host/test_media_suspension.py`、WebRTC signaling tests，覆盖 closed sender、旧 candidate、并发 resume、fresh-offer 预算。
- 构造 TURN/STUN timeout fixture，确认只退避一次且旧 PC 被关闭；确认旧 lease 输入始终被拒绝。

### 通过门槛

五次短断线（每次≤20 秒）中，恢复≤10 秒；每个 attempt 最多一个 fresh-offer；`host_media_resume_failed(reason=closed)` 不再在同一 generation 形成 retry storm；stale-lease input=0（除专门的负向测试）。

## 阶段 3：输入 fallback 和可见效果

1. 复核现有可靠输入 ACK timeout/DC quarantine/Socket fallback，先复现今天仍失败的路径，只修实际缺口；Socket fallback 只保留可靠控制，不重放旧 move。
2. Host/Signal 为每个受控 marker 输出 bounded scalar trace：send、relay、received、result、ack、frame、rVFC；客户端保留有界结构化 trace，日志计数区分上送/保留/脱敏。诊断 ring 淘汰不解释为键鼠投递丢失。
3. UI 明确区分 `page-hidden`、`transport-lost`、`negotiating`、`media-stalled`，并在 page visibility 恢复时只提交一个 generation 新的 resume。
4. `/api/admin/observability/summary` 显示 Host receipt 的缺测原因，不把 heartbeat ring drop 当成 RTP drop。

通过门槛：真实marker会话业务输入/reset ACK（不含heartbeat）p95≤200ms、max≤1,000ms；expired ACK=0；`inputToVisibleEffectMs` 覆盖率≥95%；reported/retained/redacted/trace 计数各自准确，未知保持 null，summary gap=0。

## 阶段 4：维护窗口发布和验收

1. 先运行本地 focused tests、构建和 `git diff --check`，提交独立逻辑变更。
2. 合入 `main` 后按 runbook 仅重启本地 Signal/Host；不操作 tunnel。记录密码只在运行回报中提供，不写入文档。
3. 本地 health、Host online 和正式域名 `/health` 通过后，启动唯一 Viewer；若用户会话存在，自动测试不得抢占。
4. 依次执行：10 分钟采集隔离基线、五次短断线、10 分钟真实输入 marker、30 分钟长会话。每阶段失败都保留服务运行并记录 evidence，不宣布全量通过。
5. 通过后更新本计划“实际结果”段，保存脱敏 JSON receipt、日志覆盖窗口、summary gap、ring drop 语义和 `NOT RUN` 字段。

## 回滚和停止条件

- 新 capture adapter 造成首帧、RSS 或 FPS 回退时，切回旧 adapter，但保留诊断字段和进程内开关；不得删除日志证据。
- 新恢复逻辑出现旧 lease 执行、跨 attempt 输入、无限 candidate 缓存或资源泄漏，立即停止该阶段并保持服务可用，回滚本地 Signal/Host 代码后重新验收。
- 任何计划外 tunnel URL 变化、服务进程退出或用户 Viewer 会话被抢占都视为维护窗口失败，先记录再处理。

## 当前状态

- 阶段 0：已完成今天日志基线和诊断文档；Host 00:00–08:18 的证据缺失已标注。CPU 归因复核已纠正 GIL/2x/分位数口径；全机压力与 native 等待的受控 A/B 仍未运行。
- 阶段 1：未实施受控采集隔离A/B。阶段 2–3：确定的恢复、心跳与诊断缺口已完成代码、离线验证及加载；广泛整改仍按证据决定。阶段 4：a88f7fe/build79d27719867d5814已通过五次strict原租约短断线和30分钟公网TURN被动连续性；真实业务输入可见效果及全部性能门槛尚未通过。

## 本次最小修复清单（22 点补充）

- [x] 用真实 Host validator + Viewer runtime + fake timers 复现同 generation soft replay 后永久 resuming；用真实 Input/WebRTC 复现同步 DC send 异常未进入 Socket fallback。
- [x] 用 v3 持久化反例证明旧 logCount 统计的是清空后数组，并确认普通 report 仍有结构化 input trace。
- [x] 修复 media ACK 幂等/证明保留/有界时限，验证旧 PC、socket、lease、attempt/generation 和主动暂停不能被激活；覆盖真实 Signal 拒绝/Host reason 转发，而非仅前端模拟。
- [x] 修复同步 DC send 失败的 Socket fallback，验证成功 DC 不双发、Socket 离线 fail-closed、序列化错误不被吞掉。
- [x] 贯通 reported/retained/redacted/trace 计数，验证原文不落盘、raw 淘汰后日汇总仍保留计数、历史未知不伪装为 0。
- [x] 运行初次最小修复的 Signal/Viewer 回归和隔离前端构建；review 实现及文档，提交到 main（09d5c24）。
- [x] 初期按现有维护授权在无Viewer时加载09d5c24及随后4826f72，彼时均只重启Signal、Host/tunnel未变。后续Host调度及a88加载另列，验收结果分别记录，不以加载替代通过。
- [x] 分别记录离线通过、生产已加载、passive/短断线和真实可见效果状态；真实业务输入及可见效果仍为NOT RUN，前两次短断线保留INCOMPLETE。

初次最小修复离线结果：Viewer 1,507/1,507，Signal 432/432；独立媒体审查未发现必修问题；隔离构建 buildId `544814d637669668`。本轮回归触发旧诊断测试清理生产目录的隔离缺陷，历史 raw 丢失；现已修复并新增生产 canary 回归。事故及证据边界见 `../reports/2026-10-24-control-recovery-fix-execution.md`。

### 原生等待与压力的下一步实验

- [x] 原生采样核对 CoreGraphics data-provider IPC、bytearray 复制及主线程 GIL 等待，记录采样比例的适用范围。
- [x] 只读预检现机 Quartz 的 CGDisplayStream/CoreVideo 接口和现有 capture 生命周期，不把符号存在当作 backend 已验证。
- [ ] 在独立实验中验证 IOSurface→CVPixelBuffer/stride、屏幕权限、静态首帧及 complete/idle/stopped；不接生产默认、不同时改 relay JPEG 路径。
- [ ] 实现有界 native-buffer source 与 CFRunLoop owner，覆盖 generation fencing、暂停/恢复、resize、晚 callback、stop 排空和 owner 回收；callback 不做全屏 copy/resize。
- [ ] 同分辨率/20 FPS/编码器/OpenCV 单线程下，对 MSS、独立进程、异步 source 运行同负载轮换；记录系统 load/running/CPU idle，单列 source delivery age、fresh paint 与输入效果。系统压力差异过大的轮次不得相互宣称性能提升。
- [ ] 通过真实可见效果和 30 分钟资源/帧连续性门槛后，才评估修改默认 backend。本轮接口预检和短测不能勾选此项。

原生接口实验补充：独立子进程收到73次complete/1次stopped，元数据桥接为1152×720/BGRA/stride4608，start/stop返回0；未读取像素。只完成接口和metadata验证，idle、静态恢复、像素归属、资源反复回收及性能A/B仍未运行。

### 维护验收后的日志补充

- [x] status-reader按固定stage/error类别保留失败侧文件，所有期限不变；91项主套及取消/清理focused通过。
- [x] reset恢复失败在原scope释放前进入既有诊断，使用recovery-failed避免把发送失败/ACK拒绝误报为超时；补齐真实双reset定时器重入，Viewer最终全套1,517项通过。
- [x] Signal仅针对已转发reset关联ACK目标、校验、租约/类型匹配、转发及本地耗时，保持32项/10秒上限，验证失败日志不改变控制结果。扩展后的全部Signal目录回归537/537通过。
- [x] 23:54:27加载新日志补丁4826f72/build3fb4a1fd0774bdcc，第三轮在baseline观察缺口停止、未注入故障；三轮结果保留INCOMPLETE，不通过放宽原lease/期限要求来改判。
- [x] 正常UI真实上报后核对生产reported/retained/redacted/trace receipt；发现并修复duplicate双计数，75ac794加载后为1报告/40log/0保留/40脱敏/9trace，gap0/ring0。

### 低负载 pacing 追加实验

23:41 的低负载长会话中，抓帧rolling均值约25ms，pacing requested约25ms、actual约100–105ms、excess约76–80ms，fresh cadence仅约8Hz；原生栈主要处于nanosleep，GIL等待占比很小。必须将这一路径与此前高压力下的CoreGraphics IPC等待分开。

- [x] 独立进程轮换测试sleep/Event.wait/Mach deadline各90次；未复现Host约75–80ms超睡，没有证明换原语有收益。
- [x] 独立子进程原始→进程活动声明→恢复原始，各80次20ms等待；没有明显改善，token已释放，生产/全局策略未变。
- [ ] 在Host等进程年龄、同pacing目标/负载/电源状态下做受控A/B，记录kernel sleep、唤醒、GIL恢复和系统performance limits，证明候选后再改默认；不能从独立短进程推断Host已经修复，也不能直接认定App Nap。

### 长会话与资源状态补充

旧已加载09d5c24/build544814d637669668的30分钟TURN passive连续性通过：1800.215秒、1801样本、missing/failed/身份变化/路径变化均0，最大观测无画面进展1266.6ms。Host覆盖23:23:06–23:53:02，fresh均值9.33Hz、输出19.56fps、复用53.11%，因此尚未达到fresh≥15Hz门槛。RSS有回收且该窗口未持续单调增长，不能外推长期无泄漏。另有晚20分钟OS级CPU/RSS采样，不能混成全30分钟相同覆盖。真实业务输入、marker可见效果及三小时连续性未验收。详见执行报告和各自JSON。

### 10月25日确定的调度配置与验收记时修复

- [x] 同LaunchAgent上下文复现默认daemon的timer超睡，并与Interactive独立候选比较；生产未改时明确来源。
- [x] 修复验收Host状态记时（94/94回归）：采用status分支实际完成的单调时间，不用慢页面完成时刻；真实gap仍失败，失败后保留同owner且schema有效的最终诊断。
- [x] 修复Host helper先覆盖配置再比较的加载缺口；22/22测试覆盖私有日志canary、预检、安装、部分注册及回滚失败。
- [x] Host plist显式Interactive；Signal helper使用私有参数数组plist和预检/失败恢复，18/18测试通过；实际启动路径无效时在停旧服务前拒绝。
- [x] 调度候选focused回归/独立review、main提交后已在无Viewer维护窗口加载；实际Interactive及本地/公网健康已核实，tunnel未操作。
- [x] 调度候选已重跑两次strict原租约短断线和活动capture/资源观察；fresh/pacing改善已有运行证据。第三次自然lease expiry保留旧版本失败；后续a88心跳修复及30分钟新配置验收结果见下方，不回改旧结果。

### Host加载阻断的实测修正

- [x] 独立4个probe确认临时文件缺.plist后缀导致bootstrap5；改唯一私有目录/probe.plist及唯一label，清理未确认时拒绝reload。
- [x] restart-host失败保留/刷新真实项目PID；无Host才清理；helper先输出子脚本诊断再返回失败。34项Host相关回归及19项service helper通过，7个核心反例RED→GREEN。
- [x] Signal已加载Interactive并核实31/63与本地/公网/Terminal admin bootstrap；Host已在2e611d5提交后通过修复预检重启64981，实际interactive4/max63。当前版本短断线和30分钟被动验收结果见下方。

### 真实上报后发现的计数重复

- [x] 正常UI手动报告唯一raw为40log/9trace，Socket/HTTP重送使旧receipt错误计80/18，已保存生产反例。
- [x] 两入口只对非duplicate更新runtime recorder，HTTP sink异常不再破坏保存ACK；真实注册入口两种顺序、legacy及sink失败5项反例通过。
- [x] 第二轮结束加载计数修复，正常UI重试后唯一raw/runtime receipt一致；旧错误窗口不回改。

### 自然租约过期后的心跳闭环

- [x] 保留第三次无fault的真实baseline-failed及完整时间线；前两PASS不能外推长期稳定。
- [x] 实现协商式heartbeat ACK、当前scope单pending/2500ms预算、固定摘要；正常engine重连接入现有正式rebind，TTL/授权不变。
- [x] 真实Signal+Viewer反例红绿、旧能力/晚ACK/隐藏/手动/拒绝/定时器有界复核；补真实Engine.IO non-draining transport和晚capability反例，24/24通过，独立复审无遗留必修。
- [x] 与v3 interval观测修复一起回归/隔离build并在无Viewer时提交加载。0a单次ACK误触发保留失败；最终a88版本重复断线和长会话结果独立记录。

### 媒体区间观测闭环

- [x] 复现 v3 原文清空后 receipt FPS/drop 缺失，保持无 provenance/default-zero/旧报告 unknown。
- [x] request/current/prior owner、所选 inbound 的实际 track 及稳定 counters 归属、5秒单调freshness、白名单及独立 interval delta scope 已实现；不改原媒体健康 selector。
- [x] 修复 sampleStats.last 排序取最大值及跨资源来源顺序错误；使用统一有界 FIFO，max 与 last 分离。
- [x] focused 32项通过并完成独立只读复审；三条复审反例均补齐。
- [x] 与心跳闭环统一完整回归、隔离build、main提交后加载；0a和a88均完成正常UI真实receipt核对。旧报告不补造为新协议覆盖。

只读附记：现有tunnel进程6438的线程base/max仍为20/20。这只是调度上下文线索，尚无该进程的阶段耗时或控制失效因果证据；本轮未操作tunnel，不将Host/Signal的收益外推到tunnel。

### 单次ACK误触发后的追加闭环

- [x] 0a0bc6d/build6fd0加载与正常UI v3生产闭环已验证：raw/receipt81log/9trace、19.9FPS、真实interval drop0、gap0/ring0；可见效果仍缺测。
- [x] 首次新strict无fault baseline约66秒失败，保留forced-close证据；测试随即cleanup，不把它误称自动rebind失败。
- [x] 顺序正常UI对比同版本公网与loopback ACK，保留原样本和顺序/负载限制，不把差值叫纯网络。
- [x] 连续2个current-scope ACK miss触发恢复，deadline/TTL/reset期限不变；28项HB及1项真实诊断链通过，有效ACK清零、旧晚ACK、隐藏、重复grant、真实non-drain、新epoch seq清空均覆盖。
- [x] a88定向回归：Viewer相关471/471、Signal完整576/576、HB28/28及诊断持久化1/1，独立复审/隔离build完成；main提交后无Viewer维护窗口仅重启Signal，build79d27719867d5814已核实。
- [x] 五次strict原租约恢复均≤10秒，Host/Server coverage完整，每次恢复后稳定≥30秒；完整脱敏证据为heartbeat-two-miss-five-recoveries.json。
- [x] 当前版本30分钟公网TURN被动连续性PASS，1801样本无缺测，心跳timeout/reject为0；实际CPU/RSS/FPS/抓帧/编码及诊断环边界单列记录，不能把连续性PASS称作全部性能门槛通过。
- [x] 连续两个心跳黑洞的自动恢复功能验收：首轮私有探针ring误判的INCOMPLETE保留；修复探针后独立重跑PASS，9.448秒原租约恢复、稳定30.023秒，证据heartbeat-watchdog-functional.json。仅为routed功能验证，不代替native outage/strict或业务输入验收。
- [ ] 输入ACK仍高于200ms目标；真实业务输入/marker可见效果、三小时连续性及受控采集后端A/B待独立验收，不伪造覆盖。

### 剩余性能工作顺序（最终实测后更新）

1. 在同设备/同网络受控窗口分别测DC业务ACK与Socket reset ACK，利用已有reset哈希、Signal本地request→Host ACK及Viewer同钟RTT分段；未知跨时钟不直接相减为单向网络。当前两条reset的405.5–496.3ms只证明该样本超过目标，不能外推全部DC业务输入。
2. 准备满足既有隔离GUI边界的marker目标，才执行真实业务输入与内容效果验收；未满足时保留NOT RUN，不绕过guard或向任意桌面窗口发送业务输入。
3. 进行原生异步capture/独立进程/当前线程的等负载A/B，比较实际source→paint age、新鲜cadence、控制响应、RSS/CPU与停止后的资源回收；当前max275.659ms已在本长测内新增，不能用last快照p95代替达标。
4. 补齐同窗整机CPU idle、独立swap差分和更长RSS平台/回收证据，再做三小时连续性；不调整其它业务进程、不操作tunnel来制造低负载通过。
