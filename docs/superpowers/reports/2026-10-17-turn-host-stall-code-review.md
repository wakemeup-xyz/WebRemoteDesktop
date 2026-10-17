# TURN 13.8秒停帧：Host调用边界及积压复核

2026-10-17，只读审计。代码目录为 `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`；读取时HEAD已到8e7d916，核心Host为d5ecb23。只读取现有验收、日志、源码、已安装依赖，另执行无网络/无截图/无原生输入的200条诊断消息内存模型；没有修改源码/index、启动浏览器、采样/停止任何服务或进程。此报告0600。

## 1. 新证据比“网络断开”更具体，但还不能唯一归因

来源：`/tmp/wrd-jpeg-gate-turn-failure-review.md`，`/tmp/wrd-public-jpeg-gate-turn-20261017a/`，最新run起始inode/offset记录，以及当前Host日志14:07:33–14:08:05的匹配行。日志行号是本次读取的当前文件位置。已复核三天报告的历史窗口与缺失、此前TURN300s及JPEG新gate短测，未重新统计三天原始全日志。

- 当前Host日志5747行，14:08:03.446，`WRD_ENCODER_SAMPLE`：54次encode，均值275.986ms，窗口P95 155.331ms，**单次最大13,541.114ms**。该窗VideoToolbox、1152×720、20fps、3.2Mbps，无keyframe事件。不能把窗口均值/P95当整场分布。
- 5749行，14:08:03.605：**当前一次loop lag12,771.098ms**，missedSampleCount12；不是仅rolling历史最大。前一点14:07:47.832的captureSeq150，后一点151，期间几乎没有新截图完成；relayRunning=false。
- 两点进程累计CPU11.148→11.781秒，仅+0.633秒；日志墙钟标签跨度约15.773秒。CPU是整个Host进程ru_utime+ru_stime，不是某条线程，也不含外部硬件服务。该证据不支持“Python纯CPU忙等占满13秒”的解释；不排除页入、被调度延后、原生等待或持GIL等待。墙钟标签只用于窗口定位，不作跨机时延计算。
- 故障前Host资源样本已显示系统swap-in约95MiB/s、swap-out约170MiB/s，随后资源样本age18.739s失效，值为null；不能填成零，也不能把失效本身证明成swap唯一原因。load1约14.28→31.94。
- Viewer最后正常进展约14:07:49.93；Socket.IO保持connected。PC到约14:07:58才disconnected，14:08:04换PC/attempt/generation。浏览器1秒探针最大lag10ms。它不像Viewer主线程整体卡住；单纯TURN丢包也不足以解释Host本地12.77秒调度延迟和几乎静止的captureSeq。
- 后来的Host `packet queue is empty`、new-offer和signal-disconnect不是首个停帧原因的证据。REMB的11秒RTT也晚于停顿，包含Host不能及时处理反馈的可能性，不能直接称TURN网络耗时。

**判定：已确认Host进程一段真实“无法及时推进”的窗口，与编码调用wall-time膨胀、视频停顿/PC刷新同窗。尚不能确定是谁首先阻塞、系统资源还是原生代码/GIL、及独立网络扰动是否并存。**

## 2. 13.541秒精确测量边界

`python-host/h264_videotoolbox_encoder.py:1022–1068`在encode函数已经进入后取time.monotonic，到调用_record_encoder_sample之前取差。它覆盖timestamp处理、可选trace查找、`list(_encode_frame(...))`、PyAV内部格式转换/codec.encode、NAL字节复制/分割、packetize及统计准备；不覆盖此前executor排队、不覆盖后续RTP发送await、不覆盖这一条聚合日志的实际输出。

实际安装`aiortc/rtcrtpsender.py:294–330`先await track.recv，再在318–320 `await loop.run_in_executor(None, encoder.encode, ...)`；357–407逐包await发送完才取下一帧。Host的111–119包装仍委托这个原函数，未把encode搬回asyncio主线程。因此不能说13.5秒是“主循环同步直接调用encode”，也不能称它全是纯硬件编码计算时间。默认计时只知道整个函数的单调wall time。

已安装PyAV源码（`/Users/macstudio1/.homebrew/lib/python3.11/site-packages/av/`）具体反证：

- codec/context.pyx:324–325和382–383的avcodec_send_frame/receive_packet在`with nogil`；video/reformatter.pyx:210的sws_scale也释放GIL。
- video/codeccontext.pyx:63–83说明BGRA输入不匹配YUV420P时内部reformat确实属于encode调用。
- `codec/context.pyx:220`首次avcodec_open2及224–230析构路径没有相同nogil块，是启动/重开/释放阶段的潜在原生阻塞边界；但此次首次停顿前后没有同窗重开证据，不能用它解释本次13.541秒。
- 转换/复制仍有共享GIL段，见下一节。源码不能代替停顿瞬间native栈或证明安装二进制每一个指令；没有进行依赖重编译或修改。

## 3. WebRTC与JPEG处理、队列和内存

WebRTC (`host.py`):

- 1427–1466：MSS grab在专用capture线程；只保留一个最新截图，capture_bounds字典限制2048个小标量记录。
- 1563–1653：主循环只短暂取latest slot，await单线程imgproc executor；1919–1989将resize和VideoFrame.from_ndarray放在worker。正常单sender一次只有一个recv/构建/encode链；executor底层虽未设maxsize，不构成此路径每帧无界提交。RTP历史是依赖固定大小槽；未发现正常帧路径无界像素队列。
- 2183–2193生产factory明确`CaptureExperiment(1.0,1)`，20fps对应20次/秒抓图上限、OpenCV一线程。默认兼容方法的2倍分支不能当生产事实。
- MSS darwin.py:232–246调用CG截图/CFData复制，并`bytearray(raw.contents)`复制像素；CoreGraphics是ctypes.cdll库（167），不可称所有native调用都持GIL。但Python bytearray分配/复制仍可能持GIL并遇页入。
- PyAV video/frame.py:172–174先array.tobytes，再133–168逐行plane复制；1135–1138由from_ndarray调用。源码此复制路径没有nogil块。当前1792×1120 BGRA每张约7.66MiB；20次上限仅一份raw复制约153MiB/s，另有CFData、resize、1152×720 BGRA/tobytes/plane、YUV缓冲。这里是内存流量/分配压力，不是等额常驻或已证明泄漏；实际成功capture不足目标20，不能当已测带宽。
- Capture循环吞掉grab异常后5ms重试（1458–1460），没有常态grab失败/持续时间计数；当前默认日志无法区分长grab、调度延后、异常重试。

JPEG (`host.py:600–637,1070–1128`、relay_frame_worker.py:38–116)：专用线程把MSS+转换+JPEG一起处理，最多一个运行和一个latest pending；pending请求4096B、输出16MiB预算，回送未执行前不拉下一份工作；前置Engine.IO queue.join gate减少传输未完了仍采集。新增阶段能分queue/processor/delivery，但仍不是进程隔离，MSS的内存/GIL路径依然共享。最新JPEG短测worker lastProcessor最大109.127ms、delivery最大0.1165ms，Host当前lag最大37.424ms；与TURN是不同时间/负载，不能推出JPEG“免疫”或TURN gate回归（TURN未运行JPEG gate）。

三天历史报告原有2718份lag快照无PC且relay=false，说明历史系统长停顿并非只有视频工作能触发；不能靠本次有encode长时就把三天全归编码。

## 4. 独立潜在问题：同输入DC诊断发送没有传输背压

这是可复现的长会话资源/ACK延迟风险，**不是本次13.8秒停顿的已证原因**。本次没有相应bufferedAmount/queue length历史；30秒和当时少量编码输出不足以证明其实际积累。

|发送处|频率/现有界限|传输背压/优先级|
|---|---|---|
|host.py:1747–1761 capture_stats|每约5秒|无bufferedAmount检查|
|1773–1810 frame_timing|每次recv输出一份，即目标20/s|无检查/无发送速率上限；与input ACK共用输入DC|
|1812–1839 frame_trace_batch / loss_lab_host_trace_batch|detail启用时最多每100ms，每批64条；当前detail关闭|条数/registry有界，DC入队仍无bufferedAmount检查|
|3008–3018 input_frame_binding|只在新鲜帧首个RTP包、实际输入相关时|因果库最多512 pending、4 reservations、10秒TTL；入DC无背压|
|3644–3655 clock_sync_resp|收到请求即答；正常Viewer每30秒发同步|无传输准入；请求来源频率不是硬上限|
|3657–3673 lab selected-pair / flush ACK|实验开关/请求路径|无传输准入；flush ACK有协议语义不可静默当普通统计丢弃|
|2640–2729 input_ack|输入结果ACK；本次无主动输入|同DC直接send；并无优先队列，也不能随便丢弃/换路重发|

已安装aiortc rtcdatachannel.py:176–189的send只校验open后转交SCTP；rtcsctptransport.py:676使用无maxlen deque，1808–1822增加bufferedAmount、append后调度flush；1654–1666在已有outbound_queue未清时不取下一项。每帧调用send成功仅代表入队。输入队列的M3容量不会限制这份Host→Viewer诊断输出。

**纯内存复现已执行：** AST提取当前真实ScreenCaptureTrack._send_frame_timing（不import Host）；使用已安装RTCSctpTransport._data_channel_send和_data_channel_flush，仅模拟ESTABLISHED且outbound_queue保持busy、open假Channel，每组100调用后让flush任务执行；100条→100 queued/22,890 bytes；200条→200 queued/45,890 bytes。无网络、截图、原生输入、服务或浏览器。证明欠排空时诊断持续线性增长；不证明线上卡顿时队列确已增长。

最小后续设计（尚未实现）：

1. 仅对可丢诊断加同步准入helper：要求当前channel身份/readyState、finite bufferedAmount、发送后预算不超显式小字节上限；按type设置有界发送节奏，拥塞立即drop，不重试、不建待发队列/任务、不退到Socket.IO。预留ACK容量只能减少诊断占用，不能宣称获得完整输入ACK出站总容量保证。若要连ACK本身也硬封顶，需要另行定义失败/冻结协议，不能混在诊断限流里。
2. frame_timing每帧都发没有必要；可用有限频率当前最新统计，维持每种一个latest/no backlog。已编号业务输入和input_ack、lab flush ACK不走随意丢弃策略。不要修改现有输入可靠性或原生操作。
3. frame_timing旧pending_input_ids/data当前生产仅初始化/清空，没有生产写入（测试仍有注入）。不能依赖它完成M2；真实M2使用InputFrameCausality和input_frame_binding。drop时旧列表也应有界清理并记录丢失，不能无限保留等待通道恢复、或转挂后面错误帧。
4. input_frame_binding在commit_first_packet时已消耗pending/reservation。若拥塞丢观察，必须标记观察drop/unmatched，不能把同一输入重新关联后续帧，更不能重放业务输入。是否纳入本轮最小helper需单独审查因果/计数契约。
5. detail trace批次已从registry取走时若drop需调用已有note_dropped_trace/note_dropped_loss_lab_events；不可绕过lab flush屏障。clock_sync丢响应自然等2秒超时，不能捏造0ms RTT。
6. Viewer latency-monitor.js:74–85已让5秒无新数据后统计available=false、last/p50/p95=null；限流/丢诊断应沿用这个缺测语义，不补0、不拿ACK/RTT代替input→visible。frame_timing接收时间被当样本时间（171–179），禁止排空后补发旧统计假装最新。capture_stats当前_hostCaptureFps无独立TTL（webrtc.js:4534），若显示该值则需要明确陈旧/缺测，不能让限流后旧FPS冒充现在；当前状态栏不用它覆盖playback FPS。

## 5. 下一步优先使用有界native栈，不先扩源码

现有默认日志已经足以否定“只有外网慢”和“该13.541秒属于executor排队”，但不能分解encode内部、抓图/GIL或OS调度。当前WRD_FRAME_TRACE_DETAIL默认关闭；开启detail也只能提供完成后阶段wall time，没有停顿时native栈，且首offer挂载问题此前仍有未验收项。此刻不应仅为未知原因扩诊断源码或改编码器/模式/分辨率。

建议root在下一次已有授权且ownership清晰的短验收中，先核对PID87412及14:02:13启动身份仍相符，再由外部观察器一次性执行`/usr/bin/sample 87412 3 10 -file <0600私有文件>`。含义3秒、10ms间隔；不是持续高频采样，不重启Host，不向进程注入业务输入。需在已有Viewer观察到约1秒无新帧且Host日志也停更的当刻取样，保留外部单调开始/结束、退出码及采样造成的开销标注。事后idle样本不能回答已经结束的历史13秒。

可判别方向：main线程反复take_gil/cond wait而capture/imgproc在memcpy/bytearray/分配；encoder线程在VTCompressionSession/FFmpeg/IPC原生等待而main正常selector；main本身在日志I/O/锁；多线程栈都停于等待且进程CPU很低（再结合同时vm_stat/资源、不能仅凭stack宣称OS饥饿）。sample是统计栈，可能缺符号、也不直接量GIL拥有者或page-fault时长；任何一类都需与同次monotonic视频gap、CPU增量、分页变化和默认Host阶段日志交叉核对。

若刚好miss掉停顿，不重复无条件循环采样；保留NOT OBSERVED，可做下一次有界、每run最多一次的探针。现阶段没有足够证据支持更换TURN节点、改Quality Lock、扩大线程池、关闭nogil或重启tunnel。
