# 传输耗时与输入到画面延迟专项诊断

> **14:13 状态更新：仍未完成稳定性验收。** 新 Host 的 JPEG 暂停/恢复及恢复后60秒短测 PASS（111.236s/97样本），但随后 TURN 计划300s的测试在31.003s结束，出现13.849s画面间隔并重建PC。首个异常是画面停滞，Socket.IO当时仍在线；Host同窗当前loop lag12.771s。18条失败观察不是18次独立故障。现时health正常、Host在线、Viewer0；历史失败全部保留。详见[JPEG短测](2026-10-17-jpeg-gate-short-performance-review.md)、[TURN失败复查](2026-10-17-jpeg-gate-turn-failure-review.md)。旧浏览器清理API超时，当前未发现同期残留进程，但缺少历史PID证据，退出状态仍unknown。


> **14:04 历史部署记录：** 冻结候选5912f43已同步；Host-only重载12.438s，新PID87412（14:02:13），Signal64505和tunnel/watcher身份保持。JPEG gate d5ecb23与worker阶段00d1a81已加载；原前端a6e8b15122bde656不变。health/status已恢复、Host在线、Viewer0，源码/资源/HEAD/index/未触及文件检查通过。当时guarded JPEG短测已开始、尚无结果；此前FAIL与原生可见效果NOT RUN全部保留。共享负载虽回落，不能据此宣布稳定性问题解决。


> **13:45 历史补充：仍未完成可用性验收。** 原普通Viewer已在13:32心跳超时离线；Host13:33:51断开后13:33:56自行恢复。同机出现load约642、持续大量换页、Host/Node约40–41秒调度延迟。新build的guarded短JPEG尝试在登录阶段FAIL，0媒体采样；独立登录分段探针确认认证请求超时且按钮恢复可重试，没有Start/proof/Viewer。此前“等待普通Viewer退出”为13:12历史状态，当前主要障碍是严重共享资源压力和未完成的JPEG稳定性修复。详见[登录与资源补充](2026-10-17-login-stage-resource-followup.md)。worker阶段观测00d1a81已离线/独立审查通过但未加载，传输gate d5ecb23已通过116项定向测试和独立审查但未加载；不得把它们写成已解决线上停顿。


> 后续实测见[当前实施记录](2026-10-17-remediation-execution.md)、[新TURN300s分段数据](2026-10-17-media-clock-short-performance.md)、[JPEG处理退化与5.2s停帧](2026-10-17-media-clock-jpeg-failure-media.md)及[复位协议失败](2026-10-17-media-clock-jpeg-failure-signal.md)。原始历史窗口不扩展，以下源码/标签描述属于初次诊断基线。ACK/RTT、同钟阶段与真实可见效果继续分开，缺测不填零；当前仍没有原生输入到真实可见效果的生产样本。

日期：2026-10-17；所有正文时间为北京时间。主要生产证据窗截至约01:15，后续独立复核采样延至01:22:44；审查已有日志、诊断和当前源码，补充[网页、投屏与控制综合报告](2026-10-17-web-entry-screen-control-diagnosis.md)。初次诊断阶段未修改业务代码、配置或运行服务、未打开生产Viewer；后续开发与受控验收见文首记录。

## 1. 结论

**目前页面显示的“输入→画面”不是实际输入到可见画面的耗时；现有指标还有多处低估、高估和错误归因。必须先纠正测量，再用相同条件验证性能改善。**

已能确认两种真实的慢：一组约 4.1 秒的输入往返，主要耗在 Host 排队和处理；另一组约 9.4–9.8 秒的输入往返，大部分尚未分解，不能直接叫网络延迟。真正“用户输入导致的远端变化被浏览器显示”的完整生产测量链仍未建立，不能从当前 `inputRtt`、`visualFeedback` 或 candidate RTT 推导出可信的总耗时。

新增问题包括：UI 标签绑定错误、frame timing 抢先计 ACK、旧帧错误关联新输入、键盘 Host 耗时近零、隧道跨机时钟相减、详细 trace 错记呈现时间与编码阶段、长会话统计/容量问题，以及自动故障报告缺少延迟快照。证据由前端、Host、传输三个专项独立核对；详见[固定时间窗与源码摘要](evidence/2026-10-17-latency-review/summary.json)、[前端证据](evidence/2026-10-17-latency-review/frontend.json)、[Host 证据](evidence/2026-10-17-latency-review/host.json)、[传输证据](evidence/2026-10-17-latency-review/transport.json)。

## 2. 传输路径不能混算

| 流量 | 路径 | 主要区别 |
|---|---|---|
| 普通键盘、点击 | 优先可靠有序 input DataChannel，走直连或 TURN | 输入 ACK 还包含 Host 处理与双方调度，不能等同候选对 RTT |
| 鼠标移动 | 优先无序、零重传 input-move DC | ACK 返回可靠 input DC，收发队列语义不对称 |
| 键盘／鼠标 reset | Socket 可用时优先 Socket.IO | Viewer→公网入口→Signal→Host；可以与视频使用不同路径 |
| Socket 输入 ACK | Host→Signal→Viewer | 隧道模式下与 JPEG 共用发往 Viewer 的 Socket/TCP 输出路径 |
| WebRTC 视频 | RTP 媒体，走选中的 ICE 路径 | 与 DC 共享底层资源，但不是同一个有序 SCTP 消息队列 |
| frame_timing | 可靠 input DC | 与输入 ACK、clock sync、部分诊断共用通道；Socket 输入的 ACK 与 timing 无先后保证 |
| JPEG 隧道视频 | Host→Signal→Viewer，图片 onload 后 ACK | onload 不等于显示器实际扫描出像素；反馈 RTT 还包含客户端处理 |

源码入口：`webrtc.js:4058/4207`、`keyboard-transport.js:207`、`host.py:1439/2256`。访问网页的域名不能决定视频一定走 Cloudflare；必须记录实际媒体路径、输入发送路径和 ACK 返回路径。

## 3. 可归因的真实耗时

下面四条由同一输入的脱敏 ID 摘要关联，使用 Viewer 业务 ACK 轨迹和 Host 结构化 `localExecuteMs`；没有使用失真的 wire `hostExecuteMs`。诊断会重复包含历史事件，已按输入去重，本轮共匹配 179 条独立 ACK。四条是说明问题的样本，不是总体分位数。

| Host 处理时刻 | 输入路径／动作 | Viewer 业务 RTT | Host adapter-await | 剩余未分解部分 |
|---|---|---:|---:|---:|
| 10-16 19:49:29 | DC / down | 4108.200ms | 3688.380ms | 419.820ms |
| 10-16 19:49:29 | DC / up | 4149.000ms | 3793.948ms | 355.052ms |
| 10-16 19:51:43 | Socket / mouse reset | 9412.800ms | 1.616ms | 9411.184ms |
| 10-17 01:05:54 | DC / down | 9761.800ms | 240.513ms | 9521.287ms |

前两条分别见 `back-debug.log:9410/9417`；输入锁日志也记录 down/up 排队约 3682/3627ms。因此这组约 4 秒延迟主要来自 Host。第三条见 `back-debug.log:10030/10032` 和 `/tmp/signal-server.log:35250`；Signal enqueue 与 Host ingress 的日志时刻差约 47ms，只是同机日志观测点之间的间隔，不是纯传输时间。第四条见 `back-debug.log:28382`。

剩余部分还包含浏览器事件循环、发送/返回路径、Socket/SCTP 队列、Signal 处理、Host handler 进入前的调度及未计入的本机工作。**RTT 减去 Host 处理，不会自动变成纯网络 RTT；RTT/2 也不是实测单向延迟。** 上传时的 candidate RTT 不能与包中较早的 ACK 强行配对。

前报告的 10-15 22:30:42 Socket reset 0.705ms 已再次核实：来自 `back-debug.log.2:34577` 的 `host_input_result.localExecuteMs`，范围为真实 Host adapter-await，不是有缺陷的 wire 字段，也不表示完整远程往返或可见效果。

01:07:19 接收的手动诊断还报告 inputRtt.last=2801.5ms、visualFeedback.last=16752.1ms、paint.last=17242.4ms。后两项受到下列测量缺陷影响，不能解释成“视频网络耗时 16–17 秒”。01:04–01:14 最近十份报告中九份自动故障报告没有 latency 字段，只有手动报告包含。

## 4. 新增测量问题

### L1 · P2 · “输入→画面”标签实际显示 ACK RTT

`web-client/viewer.html:332` 的标签对应 `diagnostic.js:632` 的 `inputRtt`，不是呈现帧。即使没有任何视频，只要 ACK 回来就能显示正常数值。应立即区分“输入确认往返”和“可见效果”；后者没有证据时显示未测量，不能换一个近似指标填上。

### L2 · P2 · frame timing 不证明新画面，还能抢先覆盖业务 ACK RTT

`host.py:1430` 在 `ScreenCaptureTrack.recv()` 返回之前发 timing，编码、RTP 发送在其后；`latency-monitor.js:121–134` 收到 timing 就结算 visualFeedback，并对尚未 ACK 的输入执行旧协议兼容分支、删除 RTT pending。

轻量离线复现：send=1000ms、timing=1040ms、没有 rVFC，已得到 visualFeedback=40ms、inputRtt=40ms；真实 ACK=1120ms 后仍为40ms，真实120ms被覆盖。纯 DC 输入通常受同一有序通道的发送顺序保护；Socket 输入 ACK 与 DC timing 分路时，现代 Host 也会触发，不需要旧协议客户端。

Host 的输入与画面关联还有独立的因果错误：`host.py:1288` 先选截图，`:1315` 等待 worker，`:1447` 临近返回时才取所有 pending input IDs。离线用 2×2 模拟像素证实，选中旧截图后才执行的新输入，仍被附到该旧帧；没有新截图而复用 `_last_img` 时，也会附新输入并清空 pending。`frame_timing.frameId` 亦未提供与当前 RTP 呈现帧的完整关联。

`host.py:2172` 还未检查执行结果就把 inputIds 加入待关联集合；`input_handler.py:265` 的 sequence-gap 拒绝仍带 inputIds。离线没有执行任何原生命令，仍得到 pendingVisualIds=1、pendingInputTimingRows=1。因此根本未应用的输入也可被记为 visualFeedback，不能只修“旧帧”而不检查执行状态。

因此即使把停止计时移到“下一次 rVFC”仍不够：必须关联当前 attempt 的正确帧、证明捕获新鲜度；对于任意应用，adapter 返回之后捕获到一帧也不保证应用已经响应输入。真正可见效果需要受控内容标记或其他明确的内容因果证据。

### L3 · P2 · 键盘 ACK 的 Host 耗时趋近零，掩盖真实秒级等待

`input_handler.py:198–199` 在键盘 worker 已完成后才连续记录 receiveTime/executeTime；`host.py:1941–1948` 优先用两者几乎为零的差值，覆盖真实 adapter-await fallback。

纯模拟 worker 等待约40ms，实际 await=42.865ms，wireHostExecuteMs 仅0.000588ms，ACK 四舍五入成0.000。生产 00:07:50 的 `back-debug.log:12530/12533/12535/12537` 中，键盘结构化 localExecuteMs 为1119.562/1200.027/1207.482/1212.758ms。不能用该 wire 值把键盘 Host 等待排除，再把剩余时间都归为网络。

真实结构化 adapter-await 仍可用，但它包含排队和执行，需要在同一时钟域再拆；不得直接把它命名为 Quartz 纯执行耗时。

### L4 · P2 · JPEG 隧道跨机器时钟相减，并把偏差用于降档

`webrtc.js:4442/4472` 使用浏览器 Date.now 减 Host timestamp。`host.py:783–787` 优先使用客户端 latencyMs，只有缺失才使用 Host monotonic 往返。

真实代码离线验证：Host 同钟往返200ms，客户端传5100则反馈5100，传0则反馈0。时钟偏移会误报“延迟”，也能改变质量反馈。现有 avg_ack_ms 不能直接称为网络 RTT；图片 onload 本身也不是光学呈现。

修复方向是使用 Host 自己的 frame-send→ACK-receive 同钟时间作为帧反馈 RTT，并独立记录 Viewer 接收/解码/提交显示的同钟阶段。不要再用跨机 wall clock 作为降级依据。

### L5 · P2 · trace 晚到会把关联完成时刻当成画面时刻

`webrtc.js:194/257` 用 this.now 而没有使用已保存的 frame.at。rVFC 在100ms，trace 在800ms才到，输出 viewerClockMs=800，凭空多算700ms。`scripts/turn_controlled_scene.py:523` 使用该字段计算 sendToVisualMs，因此已有受控验收链也会被污染。

需保存帧实际观察时刻，迟到元数据只补关联，不改时刻。rVFC 证明浏览器的帧呈现回调，不等于显示器实际发光；对物理端到端指标仍需光学测量。

### L6 · P2 · 五秒窗口、超时和暂停/重连边界不成立

`latency-monitor.js:193/215` 只在插入同类新样本时清理，读取时不按当前时间清理。停更约120秒，旧样本仍 available=true、count=1、last=40ms。

pending 仅每十次新发送清理一次；单次发送后等60秒再 ACK 仍计60000ms，没有单独的超时、迟到或未确认分母。`:177` 的 `_lastPaintAt` 不随暂停/会话变化重置，主动暂停五分钟后首帧产生300000ms paint gap。

此外，计时从本地发送接受后开始，未覆盖 DOM 处理和发送前等待；记录只有 input ID，未按动作、transport、attempt 分桶。聚合 P95 无法说明是哪类输入、哪条路径慢。应区分 DOM→发送、发送→ACK、历史最后值与当前窗口，明确过期、会话与主动暂停状态。

### L7 · P2 · 缺测被转换成0ms，执行耗时又重复计数

`latency-monitor.js:113/169/185` 的 Number(null) 将缺测变为有效零值；`webrtc-stats.js:76` 在没有 emitted frame 时也返回零，空 RTP Map 最后可显示“实测缓冲0ms”。

离线同一 ACK 两次再加一次 frame timing，inputRtt.count=1，但 executeTime.count=3。需严格验证有限数值、保留 null/unavailable，并按作用域、输入身份和来源去重；不应用重复 ACK 或多个重复来源增加成功样本权重。

### L8 · P2 · 连续帧诊断约102秒就耗尽默认容量

`FrameTraceCollector`（`webrtc.js:46/247/270`）capacity=2048、TTL=120000ms，takeMatched 不释放 seen。20 FPS、每帧正确关联且及时取走结果，仍在第2049帧/102450ms failClosed，变成 UNALIGNED，同作用域之后不再接收。

Host 详细 trace 仅在 `WRD_FRAME_TRACE_DETAIL=1` 启用；这是持续验收和诊断能力缺口，**不是生产视频被停止**。普通页面没有 Host trace 时，只要浏览器持续提供有效、唯一的 rtpTimestamp、同一作用域保持约20 FPS，前端也会积累 unmatched frame 到容量上限；低于约17 FPS时TTL淘汰可能避免满额，不能泛化为所有浏览器/帧率都在102秒失败。需只在启用观测时收集，按采样率、关联等待窗口和TTL确定容量，并把正常有界淘汰与坏协议数据区分；不能靠无限增加容量处理。

### L9 · P2 · 自动故障报告没有延迟快照

`diagnostic.js:257` 手动 sendLogs 添加 latency，`:577` 自动故障调用的 buildConnectionDiagnostic 不添加。01:04–01:14 最近十份既有报告中，九份自动报告全部缺失。

上述固定样本窗保存在 summary.json；前端独立复核时另外采到截至01:22:44的最近十份报告，仍是九份自动报告缺失、一份手动报告有数据。两次采样不是同一份时间窗。

应复用有界且脱敏的自动/手动快照，带采样时间、年龄、attempt、构建身份和丢失计数。诊断缺失恰发生在最需要解释延迟的时刻；不能用随后的手动快照填补故障瞬间的真实阶段耗时。

### L10 · P3 · 时钟同步丢一次回复后不再重试

`latency-monitor.js:43` 在 syncing 时直接返回，无超时或 session reset。首次丢回复，30秒、60秒重试以及替换DC后仍 sends=1、state=syncing；响应也未校验v0，状态无有效期。

当前 offset 没有用于 network 序列，不应把本项说成远程控制中断的直接原因。后续若保留同步，只能用于带不确定度的估计，并加请求身份、超时和生命周期；本地 RTT 和本地阶段耗时不依赖跨机同步。

### L11 · P2 · RTP trace 在发送失败前已经声称 wire/send 已观察

`rtp_frame_observer.py:218–220` 先 observe/bind/record，再 await 真正的 `_send_rtp`；仅第一包触发对应观察。离线真实 aiortc transport 处于 NEW，实际发送在加密前抛 ConnectionError，仍得到 markedWire=1、sourceToWireCoverage=1.0、recordedSendEvents=1。

该路径仅在详细 trace 启用时工作，不是当前生产卡顿原因。当前所谓 wire/send 只能证明进入发送 API 的提交点；不能证明成功发送、整帧发送完成或收到。需明确 submitted/accepted/completed/received 各边界，失败不得计成功覆盖；`rtpSendMs` 保持 null 比填错误值正确。

### L12 · P2 · 详细 trace 把真正编码耗时记到了 packetize

`h264_videotoolbox_encoder.py:1041` 调 `_encode_frame` 时只创建 generator（`:907` 有 yield）；`:1042` 就结束 encode 计时。真正 codec.encode 在 `_packetize` 消费 generator 时发生，所以 packetize 包含编码。

真实 encode 方法配40ms模拟 codec，得到 encode=0.004ms、packetize=40.336ms、encode_total=40.455ms。总体 wall time 仍有意义，详细阶段归因错误，不能据此去优化 RTP 分包。还需防止把整体 encode_total 与其子阶段重复相加。

## 5. 当前各阶段能测什么

| 阶段/指标 | 当前可信边界 | 必须保留的限制 |
|---|---|---|
| DOM→发送 | 尚未独立进入现有 latency 聚合 | 当前 inputRtt 未包含完整前端输入准备时间 |
| input ACK RTT | 独立业务 ACK 的同一 Viewer 时钟差；需修正 L2/L6 | 包含调度、排队、执行和返回，不是纯网络 |
| Host adapter-await | 结构化 localExecuteMs，Host 同钟 | 包含内部排队；键盘 wire 字段受 L3 影响 |
| Host输入队列 | 已有 lock_wait 日志；上轮证实3.6–4.9秒 | 不能代表进入 handler 前的操作系统调度等待 |
| capture/convert | capturePrepare 是 worker 中的新截图数组整理/缩放，或旧帧复制/空帧创建 | 不含MSS grab、帧年龄、worker排队和VideoFrame构造；不能当完整抓屏耗时 |
| 编码 | WRD_ENCODER_SAMPLE 总体 wall time | 含调用期间调度等待，不含进入编码executor之前的排队；详细 encode/packetize 受 L12 影响 |
| RTP发送 | 当前 trace 提交点，成功边界不完整 | L11；无法算成整帧真正发出时刻 |
| candidate RTT | WebRTC candidate pair currentRoundTripTime | 不是业务输入/Socket RTT，不保证两方向对称 |
| jitter buffer | 有 emitted 样本时的区间累计延迟差分均值 | 不是网络单向耗时，不含全部解码/呈现成本；无样本应缺测 |
| paint gap | 两次 rVFC 间隔 | 不是单帧渲染耗时，不证明内容新鲜；需排除主动暂停 |
| 真实 input→visible effect | 需要输入与内容标记、捕获、RTP和呈现关联 | 普通生产尚未建立；受控验证还需修正L5/L8/L11/L12 |

Signal `signaling.js:1313` 的输入日志发生在 emit 后，没有配对的 ingress→egress 同钟阶段，也没有 ACK 入站/出站阶段。当前仅能发现发送接口提交，不能证明客户端已收到。

bytesDelta 是采样区间字节量，不是带宽容量。Viewer 有 elapsedMs，但发给 Host 的 stats 未保留它；Host 的 bytes 日志实际为区间增量。事件循环停顿时不能默认每个区间恰为一秒，也不能把某次多字节增量当吞吐上升。

阶段之间还存在包含关系：imgprocBuildMs 已包含 prepare 与 frameConvert；recv_total 包含 pacing、worker排队、构造及恢复调度；encode_total包含编码和分包等子阶段。总项与子项不能重复加总，不同样本或不同阶段的P95也不能直接相加当作端到端P95。完整阶段相加必须使用同一事件、无重叠且边界齐全的样本。

## 6. 性能结论与解决方向

本专项没有推翻上轮已证实的实际性能瓶颈：整机换页、Host事件循环阻塞、输入锁积压、降档转软件编码、前端每帧冗余UI更新和诊断热路径成本依然成立。新增结果说明，现有测量会同时把某些慢隐藏、把另一些慢错归因。

完整解决需要同时覆盖以下方向，后续 spec/plan 应把它们与前报告 R1–R11、N1–N13、D1–D6 对应起来：

1. **先恢复指标语义与因果关联。** ACK只在匹配的ACK到达时结算；区分输入确认、帧通知、输入后新鲜帧、受控可见效果。保留未知值和时钟域，修正键盘、JPEG、编码、RTP及晚到trace的计时错误。
2. **消除实际阻塞和可靠性缺口。** 隔离隧道同步捕获编码，保持可靠输入和reset顺序，给生产者做有界背压；修复租约和异步状态竞态。高负载治理与代码修复分别验证，不能以重启替代。
3. **在质量约束内联动优化。** 按同条件的阶段耗时选择编码器/FPS/码率；保留用户分辨率和网络模式选择，不把未经验证的硬编码资格扩展或降画质当默认修复。
4. **补齐可解释的运行诊断。** 自动失败也保存带年龄、路径、作用域和构建身份的延迟快照；Signal、Host、Viewer分别记录同钟阶段；记录未确认、超时、迟到与丢样本数量，避免只看成功样本的P95。
5. **最后做分层真实验收。** 先离线验证时钟和乱序、失败、暂停、长会话；再在授权窗口使用受控内容和真实输入验证实际可见效果，并按路径/负载分别报告。不能用fixture通过代替公网或物理设备，也不能以rVFC替代光学时延。

当前源码的正常生产入口已核实为1倍目标FPS：`host.py:1822–1832` 工厂使用 `CaptureExperiment(1.0,1)`，`:3069` 的生产 offer 调用该工厂。本专项没有另行核验运行进程加载的源码身份。需求文档原写2倍，后续文档同步已纠正；2倍仍见于默认/兼容/实验入口，但不能将当前卡顿归因为“正常生产代码必然40FPS抓屏供20FPS发送”。历史实验记录仍保留。

历史阈值需要按原场景使用：09-05设计中的输入ACK p95≤150ms、event-loop p95≤50ms针对指定验收条件，不能直接当所有公网路径SLA；05-11旧设计中的RTT/2、DC timing推单向视频网络等表述已不适合作为测量真相。旧“稳态150–200ms”的愿景也不是已经达到的事实。

## 7. 验证与未完成边界

- 已做源码、现有日志、脱敏逐输入关联和轻量VM/fake-worker/fake-clock验证；未进行真实输入或占用生产Viewer。
- 报告经三个专项再次交叉复核，已补齐被拒绝输入的假关联、trace容量触发条件、两次诊断采样窗口、运行源码身份边界及阶段重叠规则。
- 本次保留原有非文档修改，没有构建生产dist、改服务、启动或重启任何进程。
- 离线数值证明代码路径和计时错误，不是生产延迟分布。生产日志的采样、轮转和选择性告警也不能直接提供完整p95/p99。
- 当前尚无可以诚实报告的“真实输入到可见效果整体P95”。网络单向时延、客户端入站调度、OS应用处理/合成和实际显示器呈现仍有缺口。
- 用户已指定brainstorming + writing-plans作为默认流程。已补齐[三天复查](2026-10-17-three-day-review-and-solution.md)、[总spec](../specs/2026-10-17-reliability-latency-remediation-design.md)和[总plan](../plans/2026-10-17-reliability-latency-remediation-plan.md)及子文档；方案形成不代表已实施或通过运行验收。三天新增wheel队列60.8秒、up/reset约32秒，需按新报告提升输入背压优先级。

## 14:07 TURN停顿的Host阶段证据补充

同窗encoder统计54次调用，单次最大13,541.114ms；该函数单调wall time包含PyAV转换/编码/复制/packetize，排除executor排队、RTP发送和该条聚合日志输出。Host当前loop lag12,771.098ms、captureSeq150→151；15.773s标签窗口进程CPU只增加0.633s。主要PyAV codec/reformat原生调用释放GIL，因此不能称主循环同步硬编码占满CPU；换页、调度、复制期间GIL与外部编码服务等待仍待采样。此窗口不能算纯网络传输耗时。

另已独立复现每帧frame_timing在输入DC欠排空时无界入队：200条诊断产生200条队列项/45,890B。它是独立性能风险，未取得该故障时队列证据，不能列为本次13.8s停帧根因。详见[调用边界复核](2026-10-17-turn-host-stall-code-review.md)。后续先按[受控采样设计](../specs/2026-10-17-turn-stall-profile-design.md)获取同窗线程栈，再决定主因修复；诊断不会计入性能合格。
