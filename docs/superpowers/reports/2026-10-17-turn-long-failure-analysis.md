# TURN长测失败：首停帧、Host心跳与自适应恢复链

2026-10-17，只读分析。来源`/tmp/wrd-owned-turn-probe-private/turn-long-20261017a`。调用方提供Host PID10658/source e279060、Signal64505；preflight记录Host PID/birth，本审计不另探测进程。无源码/index/服务/浏览器/网络/原生输入动作，仅写此0600脱敏报告。

**三小时验收未通过。原helper请求10800秒，256.071958秒因控制lease身份变化结束INCOMPLETE。首次6.733秒停帧早于profile切换；最终退出是Host信令心跳超时导致lease23→0，不能称Viewer Socket先断或PC刷新。Native sample触发却0字节，未获得任何栈。**

## 证据范围与测量口径

完整读取preflight、supervisor、session/summary/lifecycle及256行samples。日志严格从preflight到logsAtEnd，核对device16777220及inode一致，未读取结束offset以后内容：

|日志|inode|字节[start,end)|读取量|
|---|---:|---|---:|
|Host back-debug.log|43240044|2521891–2775846|253,955B，978行|
|Signal /tmp/signal-server.log|31830923|1859046–1862854|3,808B，85行|

合计257,763B，低于2MiB。浏览器timeOrigin+performance.now仅标记同次窗口约14:49:15.0485–14:53:30.2007；其墙钟标签不用于跨机时延。日志按此窗结束时刻筛选，44份loop、45份encoder、48份capture、48份DC admission、254份VIEWER_STATS。聚合窗边界不同，首窗可含暖机；不生成全帧总体P95，不把rolling max计为独立事件。

helper missing/late均0，failedObservations105、identityChangeObservations1；105包含持续已失败的历史最大gap及末次身份变化，不是105次卡顿。frameAge≥5000ms出现在ticks153/154、201、239/240/241，共6份观察、3个不同lastFrameAt锚点，因此至少观察到3段独立开放的≥5秒无回调区间；1Hz和累计max不足以提供所有精确停顿次数/时长。

## 1. 首次停帧与最终失效是两个边界

|窗口/事件|证据|
|---|---|
|约14:51:42.785最后一次回调后|callbacks停在1787、decoded1811；随后frameAge逐秒增加|
|tick153，约14:51:48.047|frameAge5262.4ms，Socket/PC connected、PC1/generation1、inputAllowed=true|
|tick154|frameAge6312.3ms，仍同会话|
|tick155，约14:51:50.048|回调恢复，累计已完成最大gap6733ms；Socket/PC及控制仍在|
|tick201，约14:52:36|另一lastFrameAt上frameAge5465.5ms；累计max尚未超过6733，并不表示没有第二段停顿|
|ticks239–241，约14:53:14–16|第三段frameAge5318.9→7325.8ms；tick242恢复，累计max8116.308ms|
|Signal14:53:29.656|role=host，reason=ping timeout，是真实Host信令失效|
|Host14:53:29.861|Disconnected from signaling server|
|tick255，约14:53:30.201|PC identity仍1、generation1、attempt不变、Socket仍true；leaseEpoch23→0、inputAllowed=false；frameAge仅270.4ms，画面当时已恢复|
|helper14:53:30.255|failureDetected，reason=session-changed-or-disconnected；该通用文字不能代替实际变化字段|
|Host14:53:30.274|Closing peer reason=signal-disconnect，在helper判失败后但因Host自身断线触发|
|Viewer Signal14:53:31.119|transport close，是helper关闭浏览器后的清理事件，不是首个故障|

startupSummary里hostOnline=false/ui disconnected/FREE不能覆盖之后256份真实采样：在首次baseline已connected/lease23，直至末次才lease清零。原始summary照存，不推测其快照采集时机。

## 2. 首停帧与后停帧都有Host本地进展停顿

以下lag为各条日志**当前一次**lag；rolling max另列，不混用。

|时间|current lag|captureSeq|累计进程CPU|load1|资源样本状态|
|---|---:|---:|---:|---:|---|
|14:51:38.494|73.261ms|1283|56.836s|52.150|available true、status timeout；age7.870s（旧缓存）|
|14:51:46.942|3520.365ms|1293|57.426s|69.846|available false、age16.317s|
|14:51:53.883|3461.687ms|1297|57.651s|87.155|available false、age23.258s|
|14:51:59.902|480.479ms|1325|58.996s|125.939|available false、age29.277s|
|14:52:41.884|1462.002ms|1594|70.490s|182.374|available false、age16.172s|
|14:53:08.454|29.835ms|1816|80.772s|141.795|available true、age2.553s|
|14:53:15.370|5946.126ms|1817|80.871s|121.961|available true但age9.470s，旧缓存|
|14:53:20.424|0.342ms|1858|82.446s|112.835|available false、age14.524s；rolling max仍5946.126ms|

首段约14:51:38.494→53.883，15.389秒CPU仅+0.815秒、capture仅+14；后段14:53:08.454→15.370，6.916秒CPU仅+0.099秒、capture仅+1。CPU是Host进程总ru_utime+ru_stime，不是编码线程独占CPU或VideoToolbox外部服务；时间分母为日志标签近似。证据不支持把整段解释为Host自身纯CPU持续计算。

首段前有效资源缓存报告swap-in265,092,774B/s（约252.8MiB/s）、swap-out239,111,497B/s（约228.0MiB/s）。之后采集超时，失效值必须保留null，不能用前值冒充停顿时实时值。14:52:05恢复的资源采样跨度30.088秒，swap-in约256.5MB/s、out约267.0MB/s，是长区间平均。第二/三段仍有高load和大量分页，但memoryPressure始终unknown。系统压力与进程不推进同窗且早于profile切换；不能据此把特定应用归为泄漏或断定某一次页错误独占整个gap。

前140秒也并非完全健康：25个日志current lag最大401.275ms，rolling max最高1022.328ms说明中间1秒探针曾看到更高lag；encoder窗最大1193.863ms。load11.194–71.521，系统swap-in约20–330MB/s。这是渐进恶化，不是sample启动后才发生。

## 3. capture/encoder、网络与新增DC门禁分别解释

首次停帧窗口：

- 14:51:40.339 CAPTURE_STATS 14输出、2.4fps，convert窗口均值164.6ms、recv_total294.8ms。
- 14:51:46.955 5输出、0.8fps，convert859.2ms、recv_total1212.2ms，reuse0。
- 14:51:49.204 encode窗12次、均值238.689ms、最大2188.932ms，VT仍活动。
- 14:51:53.879 `_process_screenshot` resize一次3766.6ms；其后14:51:54.306仅2输出、0.3fps，recv_total均值2283.8ms。resize和encode均是wall time，包含调度等待，不等于纯C执行CPU。

后8.116秒停顿：14:53:16.614 capture窗3输出、0.4fps、recv_total均值2735ms，但convert均值12.1ms；附近libx264 encode最大341.777ms。**不同于14:07那次13.541秒encode，本次后停顿没有同量级encoder耗时证据。** recv_total涵盖async pacing、worker等待/交付和调度，不能把差额全部归网络或截图。没有本次native stack、完整grab失败计数或sender阶段关联，尚不能唯一选择GIL、native等待、事件循环调度、executor等待或OS页入。

本窗36个VT窗口2033次调用，count加权均值19.253ms、最大2188.932ms；9个libx264窗口372次均值45.653ms、最大795.248ms。两codec分别处于不同时间/负载/档位，不能宣称性能倍数或把它们合为可比全帧总体分位。RTP发送/executor排队仍不包含在encode函数计时内。

浏览器Socket到失败仍connected，1秒lag探针max16ms、267次、missed0，visible/online/focus true。Viewer信令心跳10 ping创建/flush/pong匹配，关闭时Signal Node窗口last6/max262/P95 127ms、missed0、age2.36s；仅代表最后窗口。254条Host VIEWER_STATS所报loss全0、正向NACK总1；无完整网路逐包证据。RTT先241、首停顿恢复时4368/3158/2087ms，既可能含接收/网络扰动，也可能被Host不能及时处理RTCP放大，不能当单向网络耗时。纯外网慢无法独立解释本地capture与loop一起停顿。

48份`DC_DIAGNOSTIC_ADMISSION`为累计计数：最后frame_timing sent2432/dropped1、capture_stats sent48/dropped0、detail trace0；原因仅初期unavailable1，congested/invalid_buffer/send_error均0。不能把48条累计值相加；没有证据表明本次触达新32KiB准入门槛或诊断积压触发停顿，也不能由congested0断言底层永不排队。首停顿期间sent几乎不增长，与生产进展停顿相容。所有主动输入/ACK/输入到可见效果指标保持缺测null/NOT RUN。

## 4. Profile/codec往返：既有自动链与Quality Lock真实边界

本轮没有操作者手动更改profile。日志实际四次变化均`adaptiveResolution=False`，用户presentation1280×720不变：

|Host收到profile|原因|实际codec应用|
|---|---|---|
|14:51:54.494 medium，15fps/1800kbps|high-rtt|14:51:55.985 libx264/on-demand|
|14:52:07.451 high，20fps/2500kbps|sustained-good|14:52:08.013 VideoToolbox/peak，实际固定3200kbps|
|14:52:43.266 medium，15fps/1800kbps|high-rtt|14:52:43.300/43.435两次libx264开codec|
|14:53:28.549 high，20fps/2500kbps|sustained-good|14:53:28.603/28.861两次VT开codec|

代码链（当前worktree）：`web-client/js/webrtc.js:2122–2160` receiver stats→既有LinkQualityController.observe→applyMediaProfile；controller:279–302/349–353，在锁定时fps>0且veryHighRtt仍可积累degraded，后good样本+冷却升级；webrtc:2211–2262维持用户尺寸，码率/FPS守地板后发media-profile-change；Signal signaling.js:1539起校验active viewer/lease及序列；Host host.py:2236注册→4269 on_media_profile_change→4331 provider.refresh_profile→4375 capture apply+encoder apply；h264_encoder_policy.py:205–212峰值资格只接受标准20fps，因此15fps会递归on-demand，:278选择libx264。不是FFmpeg报错fallback，本切片未见VideoToolbox encode failed。

Quality Lock不是“所有自动参数都冻结”。既有2026-08-02 spec §5.1–5.3及§策略表明确允许分辨率不变、质量地板以上码率/FPS微调；720p地板1800kbps/12fps。上述15fps/1800未违背这个已存契约。用户限制agent不得随意换网络/质量，不等于已有运行自适应会自动关闭。新M5 `select_measured_media_policy`门禁只约束新增Host自动选择器；host.py:2147–2148 context/qualification初值None，:4491方法无入站/自动重试，**它的disabled不能解读为旧Viewer控制环已禁用**。

只白名单读取本机Signal `.env`及已安装/repo Host plist：WRD_RELAY_ENCODER_POLICY、WRD_RELAY_PEAK_CODEC、WRD_FRAME_TRACE_DETAIL、WRD_DISABLE_VT_WARMUP、SERVER_URL均未设置。未输出全env，也未读取进程完整env。源码默认policy=relay-peak-sliced-v1、peak codec=VideoToolbox、detail默认off、Host URL由启动脚本默认loopback；本轮encoder日志证实实际peak/on-demand选择，trace日志为零。存储配置不证明进程继承环境绝对没有覆盖，故不把未设置写为完整live env验证。Viewer adaptiveMediaEnabled源码默认true，resolution开关由localStorage决定；实际日志False直接证明本轮profile请求锁尺寸。

**恢复放大候选值得离线复现：** 后两次变化各先开1280×720，约135/258ms后又开1152×720。源码apply_media_profile即使尺寸没变也set_max_resolution+set_target_fps，target_generation递增，recv不再复用旧generation cache；若此刻latest截图为空，_build_video_frame构造max_width×max_height blank（1280×720），下一张1792×1120截图则按比例缩成1152×720，导致尺寸重开。双尺寸重开是日志事实；blank来源是代码推断，还需隔离fixture验证。首次6.733秒停帧发生在所有profile切换之前，不能倒置因果。

## 5. Host ping timeout、sample空文件与清理

Host14:53:16.428 `packet queue is empty, aborting`在5.946秒loop stall刚结束后。安装engineio/async_client.py:627–641实际含义是writer等待发送队列get，超时`max(ping_interval,ping_timeout)+5`后退出；不是“视频包列表空”，也不证明公网断网。reader的572–591另有ping_interval+ping_timeout超时。此run没有Host端逐个ping→enqueue→flush→pong轨迹，所以尚不能证明最后pong具体漏在哪一步。共享进程超过5秒不推进可以使writer宽限和ping/pong处理错过期限；随后13秒左右Signal记录Host ping timeout，构成可验证机制，但没有足够证据把具体定时器竞争视为已重现代码bug。

Sample由tick153超过5000ms触发，supervisor实际startEpoch约14:51:49.506；首停顿早已进行>5秒，首个3.520秒loop事件也更早，所以不能将首次失效归因为采样。sample身份由旁车单独记录，约10.252秒后仅对自己的sample子进程发kill；实际文件0字节、status timeout、exitCode−9。supervisor.finishedEpoch在最终收尾才记录，不能把start→最终记录109秒称sample实际运行109秒。没有栈，不能宣布发现GIL持有者或排除native等待。触发后部分时段可能受采样/系统开销影响，属于diagnosticPerturbed。

helper browser.close/manager.stop成功，原ownedProcessExitEvidence仍not-observed；旁车独立确认7个已记录worker/browser身份exited且无signal。sample另一个身份exited，signal仅该sample的kill。completeProcessTreeExitEstablished=false，轮询遗漏快速孤儿的覆盖局限保留。Host/Signal/tunnel均未由本审计操作。

## 6. 证据支持的下一步

1. **先做离线恢复链复现，避免重复原样长测。** 用已有fake截图/encoder fixture：同用户尺寸的20→15→20 profile、切换时latest为空，验证是否先blank1280再fresh1152引发两次codec reopen；同时验证仅FPS变化导致缓存generation失效的必要性。若确认，先spec/review最小更正再部署，保持输入作用域和真实capture因果，不能用旧frame冒充恢复新帧。
2. **分清旧自适应与新资格门禁。** 当前“高RTT→降低FPS→退出硬编码资格→软件编码→good→硬编码”的往返有真实日志，可能放大共享资源异常；需对既有控制环提出明确方案及离线回归，而不是偷偷设adaptiveMediaEnabled=false、扩展15fps VT资格或调低Quality Lock。门禁缺少资源有效性与旧路径衔接是具体设计问题，不能只重复“新增adapter默认disabled”。
3. **修正取证手段的有效性。** 已知/usr/bin/sample在本机此次10秒内未产出栈；下一次先对已授权且identity核实的Host短时间验证同工具能否成功，并保留其stderr/退出阶段（不提升权限、不无限延长、不对其他进程采样）。若该环境不支持，正式记录不可用，另设计低开销外部/应用内有界阶段证据；不要在每次失败后重复空采样。
4. **对Host本地心跳做精确因果观测或离线定时器复现。** 现有Signal逐ping/pong诊断是Viewer而非Host；补齐Host writer alive/queue wait/最近ping处理与最近pong enqueue的少量单调计数后才能区分本地调度、timer race和传输断裂。不要直接放大timeout掩盖秒级冻结，也不要由此操作tunnel。
5. **把资源可用性列为验收前置证据。** 同机负载52→182、大量换页与资源采集超时在失效窗确实存在；优先由用户释放已知重负载或在有依据的独立资源窗口完成后续验收。不得杀未授权应用，亦不能声称代码修复能保证在这种整机压力下稳定。确认新代码针对已复现机制、观测可工作、资源窗口有记录后再进行下一次长会话。

本轮不是通过的长测，短测通过不能抵销本轮失败；当前已确立“本机进展停顿→媒体间歇冻结，后Host心跳失败→控制lease清零”的时间顺序。尚未取得足够native/调度证据宣布最初系统根因唯一确定，真实输入到可见效果仍NOT RUN。
