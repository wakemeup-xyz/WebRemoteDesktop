# Clock修复后JPEG暂停/恢复失败：媒体侧只读证据

Canonical结果FAIL，elapsed69.744991s，失败阶段post-recovery、reason=post-recovery-not-healthy。开始、baseline、真实暂停、新generation suspend ACK、真实恢复、新generation active ACK及新帧恢复均已通过，恢复耗时4.010156s；随后60秒稳定随访未完成。最终是当前JPEG origin保持有效、Socket仍连接的情况下，新image load停止超过5秒，媒体门控按stale关闭。不能归因为“恢复按钮未生效”、首帧从未恢复或仅错误计算旧completed gap。

最强的本地证据是JPEG worker处理明显变慢：最后一个Host窗口avg_encode_ms1050.5、只sent5/acked5；失败前Host probe显示relay worker inFlightCount=1、pendingRelayFrames=0。与此同时资源采样出现大量系统swap/RSS回落，最后一份资源状态timeout、样本年龄9.246s。当前证据支持定位到worker/本地资源及发送链边界继续核对，不足以确定MSS、JPEG处理、OS调度或emit/网络的唯一原因。没有证据重用已修复的墙钟节流bug解释本次FAIL。

## 时间与读取边界

完整读取`/tmp/wrd-public-media-clock-jpeg-20261017a/{summary.json,samples.jsonl}`。该目录只有这两文件，没有lifecycle墙钟锚点。summary最后落盘mtime12:42:09.422770 CST，samples最后mtime12:42:09.167785；mtime只是文件事实，不是严格浏览器wall anchor。调用方提供source f492357、Host42127；本次未验证进程/源码。

没有JPEG专门start offset，因此只读当前Host日志inode42866929的最后120KB，再以该Viewer自身Tunnel relay stream started12:41:08.915与summary终点限制至12:42:09.423。此会话有10份TUNNEL_RELAY_STATS、同Viewer的profile记录、11份会话内host_event_loop_lag；另只读了一份12:41:07.981启动前参考probe，不纳入会话资源范围。前一轮TURN的WRD_ENCODER_SAMPLE/CAPTURE_STATS未用于任何JPEG结论。

早期loop的rolling60秒窗口可能仍覆盖前一会话，不能把其历史max认定为JPEG新阻塞。本报告优先使用当次latest lag、当前worker queue与资源age/status。没有用Host时间减browserNow推算传输延迟。12:42:09.423后的Host统计/超时（例如12:42:16的超时）不纳入失败前归因，避免把浏览器关闭后现象当先行原因。

本次没有读取source、修改runtime/config、连接浏览器、执行network/native/service操作；仅写此0600报告。未输出凭据、输入正文或原始图像。

## 失败前实际JPEG进展

Artifact包含69份分阶段观察：start-ui1、readiness7、baseline6、pause4、resume5、post-recovery46。tick每阶段重新从0开始，因此本报告使用stage+tick定位。

恢复阶段tick2（browserNow18219ms）已经有恢复后的新load；恢复tick4/随访起点约20225ms时load总数38、current origin为relay-origin-2。随访tick40在browserNow60224.2ms总load96，最后load=60025.6ms，age198.6ms。之后load96一直不变：

| post-recovery tick | browserNow ms | last load age ms | feedback seq / age ms |
|---:|---:|---:|---:|
|40|60224.2|198.6|35 /200.8|
|41|61239.3|1213.7|35 /1215.9|
|42|62229.3|2203.7|35 /2205.8|
|43|63244.5|3218.9|35 /3221.0|
|44|64224.9|4199.3|35 /4201.4|
|45|65226.0|5200.4|35 /5202.7|

这是一段未完成的新停顿。之前completed maxRelayLoadGap4970.5ms来自pause/resume跨越的回调间隔（resume tick2首次增大），其中包含有意暂停，不能把它当本次失败时的当前gap或独立的第二个故障。最终当前age已5200.4ms，足以使新鲜度失败，即使completed max仍4970.5。

随访38→96共+58次load/45.0008s≈1.2889次/s。它是image load事件，不是新抓图频率或光学呈现FPS。没有WebRTC PC/rVFC/decoder计数，transport unavailable是JPEG模式的正常口径，不能用TURN媒体指标补齐。

最终Socket connected、同socket-1、scope stable、leaseEpoch7、expectedCurrent/currentAttempt/currentLease/currentDesiredGeneration/currentContext/renderedOriginMatches均true；desired/media generation2、productionGeneration4保持。tick45 frameStale=true、UI media-stalled、effective input gate关闭。此前tick44 inputAllowed仍true；不能在最终状态仍声称输入门控开放。

## Host仍有产帧，但吞吐与处理显著退化

下表为单个Host摘要窗口的报告值；均非全程P95、非逐帧stage trace。

| Host窗口结束 | profile | FPS | sent /acked | avg_encode_ms | avg_ack_ms |
|---|---|---:|---:|---:|---:|
|12:41:14.124|medium|4.0|21 /19|54.8|446.8|
|12:41:21.619|medium|1.7|13 /13|90.6|417.9|
|12:41:26.874|medium|2.9|15 /14|140.9|513.8|
|12:41:31.882|medium|2.6|13 /13|172.0|555.2|
|12:41:38.760|low|1.0|7 /8|453.0|610.7|
|12:41:44.135|survival|0.9|5 /5|245.0|815.6|
|12:41:50.383|survival|1.0|6 /6|199.7|825.5|
|12:41:55.433|survival|1.2|6 /6|80.4|746.0|
|12:42:00.716|survival|1.3|7 /7|113.8|636.0|
|12:42:09.079|survival|0.6|5 /5|1050.5|618.9|

10窗累计sent98、acked96；窗口边界可跨越先前inflight，单窗acked>sent（low7/8）不是计数矛盾，也不能逐一对齐Browser load96。这些sent代表Host路径统计的完成发送，不证明Signal/Viewer已收到；最后一个8.363s宽的窗口还在输出，排除“Host relay任务在最后load后永久停止”的简单解释，但缺少逐帧时间戳，无法确定最后5.2秒内部到底哪一刻完成了几个emit。

avg_encode_ms按日志字段保留；没有单独MSS grab、resize、JPEG codec、worker等待/完成回调与emit await分段，不能将1050.5ms称为纯JPEG硬件编码时间或每一帧都1050.5ms，更不能把5次平均之和直接定位为最后同一5.2秒。

## ACK、降档、inflight与worker

12:41:32.607因ack-latency-1301ms由medium降low；12:41:42.103因pre-capture-backpressure进入survival，42.603另记录ack-latency-1546ms。medium原目标6fps、max_in_flight2，low4fps/1，survival2fps/1。这说明既有ACK背压/降档逻辑有活动，不是完全没收到ACK或从未处理超时。

故障前10个Host窗口总报告timeout1（12:41:44.135）；最后12:42:09.079窗口timeouts0、acked5。Artifact在最后feedback seq35时timeoutCount1、expiredCount0、unmatchedAckCount0、coalescedCount29、pendingCount1、oldestPendingAge493.186ms、lastAckAge552.570ms。随后这些数值冻结而feedback age增至5202.7ms，所以pending1/expired0不是最终实时Host状态，不能据此声称inflight expiry在最后5.2秒完全没执行。

更接近最后瞬间的Host probe：12:42:03.055 relayRunning=true、pendingRelayFrames1、worker inFlightCount0；12:42:08.354 relayRunning=true、pendingRelayFrames0、worker inFlightCount1，pendingCount0/pendingBytes0/frozen=false，累计droppedCount1。该drop在有意pause时12:41:18.981已出现，未在后段增长，不能归给最终失败。

这表明失败前有一个worker工作项处于处理或结果回送未完成状态，而不是单纯卡在满ACK窗口、堆积很多待执行JPEG请求。它没有细分worker当时在MSS、resize/JPEG、原生等待或未获CPU。emit也没有逐帧await开始/完成记录；不能排除另一段发送/Signal/Viewer排队，但也不能忽略本地worker慢的直接证据。

最后load与Host反馈同时不再更新，对“仅图片解码失败、其它新媒体反馈持续到达”的解释不利；Socket仍connected只代表连接状态，不证明每个relay-frame/feedback消息按时交付。尚无足够证据将资源、worker、emit或某个网络节点定为唯一根因。

## 循环与资源：保留新鲜/陈旧区分

11个会话内probe的latest lag最高333.028ms（12:42:08.354），missedSampleCount均0；最后rolling60秒max333.028ms，此时窗口已覆盖JPEG会话。没有本次多秒event-loop堵塞的直接probe证据；一秒探针不能排除短阻塞或worker线程/native调用停顿。

资源变化明显：

-12:41:24.081 successful sample swap-in111,573,742B/s、swap-out106,724,950B/s、RSS355.35MiB、age5061.94ms。
-12:41:30.030 successful sample swap-in121,462,953B/s、swap-out89,198,853B/s、RSS154.78MiB、age975.78ms。
-12:41:41.055 successful sample swap-in351,575,125B/s（约335.29MiB/s）、swap-out224,621,473B/s、RSS83.02MiB、age1954.39ms。
-12:42:03.055 successful sample swap-in253,421,165B/s、swap-out475,281,664B/s（约453.26MiB/s）、RSS125.74MiB、age3985.99ms。
-12:42:08.354保留同一资源样本，status=timeout、age9246.20ms，即使available仍true，也不是新的一次253/475MB/s测量。最终瞬时swap/RSS unknown；不能重复统计它为新资源峰。

会话内当前RSS83.02–355.35MiB，systemLoad1为24.133–64.542。memoryPressure均unknown。系统swap和Host RSS回落与worker时长上升同时出现，但没有证明由哪个应用触发，不能擅自停止其它应用，也不能把RSS变小称为内存正常或资源改善。

## 结论与剩余证据

本次真实恢复动作成功，随后JPEG加载连续性失败；最后5.2秒新load和反馈都停，Host仍运行且窗口内仍有完成发送，末探针有worker in-flight、无待ACK帧，worker平均处理时长明显增加。当前最窄可定位边界是JPEG worker完成/继续发送这一侧，而非“整个Host进程无响应”或“反复耗尽ACK窗口”已被证明。

未获得：逐次worker提交/开始/完成、MSS grab/resize/JPEG子阶段、emit await开始/完成、Signal接收/转发边界、Viewer到达/解码/load逐帧时间。没有这些就不能准确分摊最后5.2秒。现有WebRTC详细stage trace也不能替代JPEG专属边界。进一步观测应针对这一已有worker→emit→反馈路径，而不是重复调整已修单调时钟、改TURN/码率/FPS或重新设计多进程。

业务输入、剪贴板、Terminal、native commands、visibleEffect、physicalDisplay、Socket重连/网络注入均NOT_RUN。本报告保留FAIL，不把本轮JPEG结果混写为前300秒TURN的PASS，也不把connectedSocket视为媒体健康。


## 追加：按调用方新授权核实当前JPEG代码计时边界

本追加只读host.py与relay_frame_worker.py两处相关源码；前文“未读source”描述原始日志分析阶段，本追加为后续窄范围源码核对，未执行native或修改任何源码。

`RelayJpegProcessor.__call__`（host.py599–637）的真实计时：614 monotonic开始→615 MSS grab→617 ndarray view→619–625降采样选择/切片→628 Image.fromarray→630buffer构造→631 image.save JPEG→634 buffer.getvalue→635取elapsed。MSS对象初始化/monitor选择606–608在计时开始前。故avg_encode_ms实际含MSS抓图、BGRA/RGB数组构图、降采样、Pillow/JPEG及buffer提取，不是纯codec耗时；也不包含调用前排队、线程未被调度、初始化和之后emit await。

`RelayFrameWorker`不是默认ThreadPoolExecutor。24–25启动一条专用relay-jpeg线程。submit_latest27–42在短Condition临界区创建future、放入唯一pending，再返回future；真正_process在worker85执行，已释放Condition。host1067 await该future，完成后1091 await sio.emit，1108–1110才增加sent/stats_encode_ms。因此sent增加是emit await返回之后的本地完成证据，仍不是远端送达证明；只有成功完成到这一处的输出进入avg_encode_ms，挂起/取消的慢任务尚未计入当前均值。

重要计数限制：worker snapshot129–130的inFlightCount为`_inflight is not None OR _delivery_pending`。worker91–94先清_inflight，再置_delivery_pending并call_soon_threadsafe(_complete)；只有loop执行_complete59–69才清delivery并完成future。故12:42:08.354的inFlightCount1，既可表示MSS/图像/JPEG处理中，也可表示处理已结束但回送callback尚未执行。它不能单独区分processor卡住、结果回送调度延迟或等待了多久；原始日志没有这两个子状态的独立计数/时间戳。

同一probe pendingCount0意味着没有另一个未取出的latest request；不能当作“无任何等待”。Condition锁不包围_process，但submit临界区本身没有时长记录，不能从计数推出submit绝无阻塞。producer串行await submit-result再await emit，对采样瞬间而言worker/回送未完成更支持停在emit之前；但不能把这一瞬间推广成完整5.2秒都未进入emit，现有日志也没有emit await时长。

最小确定诊断因此是：本次JPEG image-load连续性失败；已有统计证明JPEG capture+prepare+encode的局部耗时明显增长，末probe停在worker处理或结果回送边界；ACK反馈曾延迟并触发正常降档，但最后无满ACK窗口/持续timeout的直接证据。系统swap/负载与此同现，末resource为陈旧timeout，不能指定哪一个应用或源码调用是根因。

当前没有新增已证实的source错误。不要以增加FPS、加深队列、延长超时或重复改clock来猜修。下一步只需区分这条已有worker的process开始/结束与loop回送完成，再区分MSS/构图/JPEG、必要时emit await；这些当前缺失的边界不能由avg_encode_ms或合并inFlightCount代替。本次不新增设计、代码或探测。
