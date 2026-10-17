# 媒体时钟只读审查（2026-10-17）

确定存在可修复的控制路径 bug：`ScreenCaptureTrack.recv()` 用墙钟计算帧节流。墙钟回拨约4.24s，可以把本应约30ms的等待直接放大为约4.27s。aiortc sender串行等待recv结果，因此这段async sleep会停发下一视频帧，同时Host事件循环仍可正常响应。这为第二次5149.8ms停帧提供了直接的源码机制；不必先用profiler才能确认此bug。历史事件中实际请求的sleep没有单独落盘，不能把整段5149.8ms都精确归给该机制或给剩余时间分摊编码/网络耗时。

本次只读primary与worktree源码、安装的aiortc/stdlib源码和现有测试；只执行无native依赖的AST提取公式验证。未import host、实例化MSS、启动线程/编码、运行浏览器、探测网络或修改服务/依赖/源码。仅写本0600报告。primary和worktree的host.py完整SHA256一致。

## 1. 直接影响实际媒体输出的墙钟路径

### WebRTC输出节流：确定bug，当前TURN长跑实际经过的路径

文件：`/Users/macstudio1/AI/Claude/WebRemoteDesktop/python-host/host.py`，worktree对应文件同一行号。

-1295：`self._last_frame_time = 0`，首帧初始化。
-1434：恢复媒体时重置为0。
-1520：`now = time.time()`。
-1521：`elapsed = now - self._last_frame_time`。
-1522–1524：`elapsed < self._frame_interval`时，`sleep_time = self._frame_interval - elapsed`并`await asyncio.sleep(sleep_time)`。
-1530：`self._last_frame_time = time.time()`，每帧再次保存墙钟。该变量在全仓搜索仅有上述赋值和测试fixture，没有混用其它合法时钟来源。

数学上设目标周期I=0.050s，上一帧写入墙钟T，下一次读时真实经过d=0.020s但墙钟回拨B=4.240s：

```
now = T + d - B
elapsed = d - B = -4.220s
sleep = I - elapsed = I - d + B = 4.270s
```

这是代码明确安排的真实异步等待。Python3.11 stdlib `asyncio/tasks.py:637`的sleep通过loop.call_later(delay)安排future；`asyncio/base_events.py:710`将delay加到loop.time；同文件701的loop.time用time.monotonic。因此算错的4.27s不会因为墙钟继续恢复而自动缩短，并且不会表现为4.27s事件循环阻塞。

aiortc安装源码`/Users/macstudio1/.homebrew/lib/python3.11/site-packages/aiortc/rtcrtpsender.py:294–330`：298先`await self.__track.recv()`，318–320再把encoder.encode送到executor。357–407的RTP循环在371等待该结果，377–401逐packet发送完才取下一帧。因此recv的错误sleep直接阻断此sender的视频输出，后续抓图线程或其它Socket任务继续推进并不能绕过它。

触发条件是回拨跨越了两次帧节流时间读数；如果回拨恰好发生在正常sleep期间、其后1530已经保存新墙钟，则该一帧不一定触发长等待。单有墙钟异常不能定位本次具体哪一次recv，仍需保留这一历史归因边界。

### JPEG TunnelRelayStreamer节流：同类确定bug，但不是此次TURN路径

同一host.py：1061用time.time记录本轮开始；1127再次用time.time算elapsed；1159 sleep=max(0.001,frame_interval−elapsed)。如果回拨发生在这两次读数之间，会把回拨量加入本轮sleep。以8fps、工作30ms、回拨4.24s为例，sleep=0.125−(0.030−4.240)=4.335s。

与ScreenCaptureTrack不同，若回拨完全发生于两个relay迭代之间，该迭代自己的开始/结束都在新墙钟下，未必受影响。长跑样本tunnelRelayActive=false且媒体为WebRTC H264 TURN，不能将JPEG relay路径当历史停帧原因。它是同一最小修复范围内的另一个独立边界。

## 2. 墙钟用于统计/协议，而非视频节流

| 位置（host.py，除特别标注） | 用途 | 回拨影响/处理 |
|---|---|---|
|1293初始化last_time；1623五秒trace-summary门槛；1661–1690 CAPTURE_STATS门槛/FPS/清零|统计窗口|回拨延长窗口实际时长，FPS分母偏小，窗口频率/输出吞吐可能失真；应与节流一样改为单调时钟，但这是观测语义修复|
|1350 `_capture_last_log=time.time()`|历史字段|搜索没有后续读/写，当前不控制节流、缓存年龄或超时；不是根因|
|693/896初始化stats_started_at；1128–1151 TunnelRelay统计窗口|统计窗口|回拨延迟统计并扭曲FPS；应改为单调时钟|
|1097 relay-frame.timestamp|外发wall epoch元数据|保留墙钟含义；不能直接把字段替成monotonic并继续声称epoch|
|3591–3592 clock_sync_resp h0/h1|跨端墙钟同步协议字段|保留协议时钟；不用于本Host媒体节流。外部消费者应识别offset跳变，本次不扩大修改范围|
|aiortc rtcrtpsender.py249与449|RTCP sender report关联的RTT估计|回拨可使估算RTT异常/负数，但这段只更新remote-inbound stats；未在RTP循环发现拿该值计算sleep的路径。无需为本次最小修复改依赖|
|aiortc rtcrtpsender.py388–390、403，以及RTCP SR|NTP/abs-send-time协议时间|存在墙钟语义，不能因本地节流bug全部改成monotonic；不把它误作应用节流|

尤其CAPTURE_STATS的`sleep`是1530之前算出的请求等待量平均；日志窗口FPS则用墙钟分母。历史第二事件附近87帧、sleep82.5ms、recv_total95.1ms和回拨相容，但聚合窗口不能反推出某一次准确sleep，且墙钟FPS不能用来否认真实停帧。

## 3. 已正确使用单调时钟、或根本不按年龄节流的路径

-真正MSS capture loop：host.py1384/1390记录monotonic_ns抓图边界，1408用同钟求elapsed，1409–1411补足capture周期。该循环不使用time.time，因此这处墙钟回拨不会直接把抓图sleep放大。
-新截图等待超时：1438–1444以time.monotonic求deadline/remaining；thread Condition仅使用相对timeout。Host恢复/新截图超时不是本次wall sleep机制。
-RTP PTS：1496–1497明确覆盖父类next_timestamp，调用`media_timing.py:30–47`的RtpFrameClock，使用monotonic_ns、90kHz相对PTS、至少+1。代码没有调用super().next_timestamp。安装aiortc `mediastreams.py:121–132`虽确实有time.time节流，但当前ScreenCaptureTrack覆盖了它；不应误修该依赖方法或把本次bug归给父类。
-recv整体持续时间1510/1651用perf_counter；暂停等待1503/1506也用perf_counter；worker构图、排队、selected capture边界等1569/1870–1915用monotonic_ns。
-缓存选择1553–1568、1600–1617按captureSeq、generation和像素存在性，没有time.time年龄淘汰或超时门槛。缓存复用率较高是独立现象；墙钟bug不由缓存年龄策略引入。
-relay ACK/过期：980/1034/1035/1057/1058/1077用monotonic毫秒；1045 asyncio.wait_for使用相对timeout。应保留这些同钟边界。
-encoder：h264_videotoolbox_encoder.py443五秒聚合用monotonic；1026–1062实际encode/packetize时长用monotonic/monotonic_ns；1146日志限频也用monotonic。没有发现encoder自身用time.time排帧。
-Host loop探针5546–5550用monotonic_ns安排deadline，不会因为本次wall sleep产生多秒loop-lag。第二事件正常loop probe与错误async pacing并不矛盾。

在本次采集/输出/sender范围的全量time.time搜索中，未发现其它以墙钟计算缓存年龄、capture超时或RTP发送pace的代码。overlay_window.py的按键提示消隐墙钟不属于媒体路径，本次不归入修复范围。

## 4. 已执行的无native确定性验证

用ast.parse读取当前host.py，抽取recv中原始1520、1521、1522、1526、1530节点（含条件内sleep）构成独立async函数。只注入SimpleNamespace self、fake time.time、记录/推进虚拟时间的fake asyncio.sleep；没有import host、MSS、PyAV或aiortc，没有真实等待。输出：

| 墙钟跳变 | 真实帧间隔 | 原始代码请求sleep |
|---|---:|---:|
|0|20ms|30.000000000018ms|
|−4.24s|20ms|4270.000000000027ms|
|+4.24s|20ms|无sleep|

这直接验证当前代码在受控回拨下安排长等待。它不是对历史5149.8ms事件逐阶段重放，也不是服务/浏览器验收。

## 5. 最小修复建议和测试切口（未实施）

第一优先级：把ScreenCaptureTrack的上一帧时间与当前节流时间全部改为同一个单调时钟（time.monotonic或loop.time），保留初始/恢复0语义；正常20fps只补足剩余周期，若处理超预算则不等待。不能仅把负elapsed夹成0：那会掩盖回拨且仍混合墙钟，不形成正确时钟契约。

同一窄修复中，将TunnelRelayStreamer本轮elapsed节流和两类五秒统计门槛/FPS分母统一改为单调时钟；wall epoch协议timestamp与clock_sync字段保留原义。不要修改aiortc依赖、编码策略、capture隔离架构、码率/FPS或其它应用。

测试建议沿用现有无nativefixture，而不是新建端到端或真实时钟更改：

1.`test_frame_worker.py:24`的bare_track跳过MSS/thread构造；在`test_media_stage_boundaries.py:85`现有async边界测试旁添加真实recv行为测试。wall fake分别回拨4.24s/前跳4.24s，monotonic推进20ms；fake sleep断言请求仍约30ms，且能返回frame。回拨发生在上一帧写入与下一recv读数之间。
2.补充recv处理耗时>50ms时不额外sleep；暂停/恢复后重置时间基线、不会等待旧deadline或追帧爆发。现有`test_media_stage_boundaries.py:201–224`暂停计时测试和`test_media_suspension.py:46–47`恢复0断言应一起校准为新的单钟fixture。
3.relay fakeworker/fakesocket控制一次迭代跨wall回拨，mono仅走30ms，断言8fps的剩余sleep约95ms。ACK超时/有效scope继续沿用现有单调逻辑。
4.统计窗口用monotonic推进5s而wall回拨，仍按真实5s发一份CAPTURE_STATS/trace摘要；FPS分母为真实持续时间；reused snapshot与清零仍一致。现有stage_boundaries107–120用host.time.time控制日志窗口，改后须显式fake统计单钟，不能保留原fixture误测。
5.保留现有RtpFrameClock单调PTS回归，证明没有把父类next_timestamp重新引入或把wall epoch当RTP时钟。

这些离线测试足以验证确定的节流bug。之后运行验收仍需新的授权会话来确认长时连续性；不能把修复/离线通过写成已经修复历史长跑。若修复后仍有停帧，再用真实grab/executor/send单调stage观测或短时owned Host profiler定位剩余问题。

## 历史证据的结论修订

先前“没有具体source bug”的结论限于只看日志、未审节流源码的诊断范围。此次源码与原始AST行为验证已确证墙钟控制路径bug，可作为具体最小修复项。约4.24s墙钟异常与第二次5.15s gap在时间及症状上强相容，但没有实际requested sleep记录，不能宣布历史整段唯一根因；第一事件的2710ms真实loop lag仍需独立解释，不能被这次async sleep机制覆盖。
