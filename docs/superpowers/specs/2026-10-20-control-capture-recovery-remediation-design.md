# WebRemoteDesktop 控制恢复与采集长尾修复设计

日期：2026-10-20

## 背景

最近两天的日志显示，Signal 断开、租约恢复、Host 采集长尾和诊断缺测同时存在。当前本地服务可用，但活动会话仍会经历控制窗口丢失和画面抖动。

已经确认的时序事实：

- Viewer 客户端 `SIGNAL_RECOVERY_MAX_WAIT_MS = 12000`；
- Signal Server 默认 `viewerDisconnectGraceMs = 8000`；
- Viewer 重绑定等待 Host ACK 只有 1500 ms，并且当前操作只有一次；
- 两天内有 32 次信令断开、19 次宽限期过期、10 次成功重绑定、25 次控制状态闭合失败；
- Host 捕获耗时 p95 约 147.7 ms、最大 501 ms，活动采集速率中位数约 10.1 Hz；
- 故障诊断多次为 `logCount=0`，`inputToVisibleEffectMs` 没有有效样本。

## 根因

### 恢复时钟不一致

服务端在 8 秒后执行 `removeDesktopViewer`，客户端仍可能在 12 秒恢复窗口内重建 Socket。因而部分“客户端最终连回”的连接已经无法复用原控制租约，只能重新进入 FREE/GRANTING/REVOKING 流程。用户看到的是网页重新连上，但控制状态已经冻结或丢失。

### 重绑定确认过短且不可重试

`rebindDisconnectedViewer` 把新 Socket 映射到旧租约后，向 Host 发 `viewer-session-rebind`，只等待 1500 ms。Host 侧有事件循环和采集长尾；ACK 在长尾期间到达就会被当成 timeout/rejected，导致新连接重新释放租约。

### 采集和编码是单线程串行关键路径

`RelayFrameWorker` 只有一个处理线程，`RelayJpegProcessor` 在同一请求中完成 MSS/Quartz grab、缩放、颜色转换和 JPEG 编码。采集执行、编码和主循环反馈由一个 latest-slot 串行化。当前长尾超过一个 20 FPS 周期时，帧率下降是必然结果；relay 反馈没有丢包也不能消除 Host 端抓帧阻塞。

### 诊断不能闭合可见效果

当前日志可以证明输入到 Host 和 Host ACK，但不能稳定记录发送、ACK、apply、下一帧、浏览器 paint、用户可见效果的同一条因果链。故障快照中又经常没有前端日志，导致每次只能看到“连接失败/数据通道卡住”，无法判断是信令、Host 排队、捕获还是绘制延迟。

### 页面隐藏策略缺少用户可见语义

`page-hidden` 会同时暂停 input、sender、capture、relay。策略本身是有意的，但页面没有把它与网络断线明确区分，回到前台后的恢复顺序也缺少完整证据。

## 设计目标

1. 断线恢复窗口必须覆盖客户端恢复上限、Socket.IO 建连、Host 重绑定和一次重试。
2. 恢复期间旧租约保持冻结，不允许旧 Socket 写入，也不允许新 Viewer 抢占。
3. Host 重绑定 ACK 可重试且有代数保护，旧回调不能释放新操作。
4. 活动采集在超过帧预算时主动降级或进入受控背压，不能静默掉到 10 FPS。
5. 诊断只记录有界、脱敏的阶段时间和计数，不记录原始输入、坐标或剪贴板。
6. 页面隐藏、恢复、网络断开和租约失效在 UI 与日志中分开表示。

## 方案

### 恢复时钟和租约

- 将服务端宽限配置化，生产默认 30 秒，上限保持 30 秒；
- 将客户端恢复窗口配置为 24 秒，低于服务端宽限；
- 断线时租约进入冻结态，旧 Socket 标记 inactive；
- 新 Socket 必须使用同一 `viewerSessionId` 和 resume generation；
- 宽限到期后仍使用现有 fail-closed reset barrier，不允许静默恢复旧权限；
- 通过单调的 `connectionAttemptSequence` 和 `leaseEpoch` 关闭旧回调。

### Host 重绑定

- 将 1500 ms 单次 ACK 改为有界重试，例如 1.5、3、6 秒，总等待不超过服务端宽限；
- 每次重试携带同一 leaseEpoch 和 connectionAttemptSequence；
- ACK 应答只接受当前 operation、当前 Host socket、当前媒体尝试；
- 超过预算后保留 fail-closed 行为并记录明确的 `rebind-timeout`，不回退到旧 Socket；
- 增加重绑定阶段计时：sent、ack、reject、timeout、superseded。

### 捕获和媒体

第一阶段保持媒体协议不变，先增加 active capture budget 和降级策略：

- 以 20 FPS 的 50 ms 周期为目标；
- 记录 grab、convert、encode、queue wait、publish 和 ack wait；
- 连续窗口超过预算时降低分辨率/质量或限制在一个 latest frame；
- 背压只保留最新帧，明确记录 dropped/coalesced，不把它伪装成网络丢包；
- 页面隐藏时停止捕获，恢复时发送新 keyframe/first-frame 标记。

第二阶段再把 MSS/Quartz grab 与 JPEG encode 拆成两个有界 latest-slot 阶段，避免编码等待阻塞下一次抓帧。该阶段必须有单独的资源和 RSS 验收，不能直接在线替换。

### 端到端观测

为每个受控输入保存脱敏的短生命周期关联：

`inputSent → signalForward/ack → hostReceived → hostApply → frameProduced → frameDecoded → paint → visibleEffect`

每阶段只保存时间、计数、状态和哈希化 ID；缺测使用 null。失败快照至少保留最近 N 个事件和故障原因，避免 `logCount=0` 覆盖全部上下文。summary receipt gap 和 heartbeat ring drop 需要成为诊断质量告警。

## 验收边界

离线阶段必须覆盖：

- 12 秒客户端恢复、30 秒服务端宽限的时钟模型；
- 1.5/3/6 秒重绑定 ACK 重试；
- 旧回调、新 Socket、Host 替换、leaseEpoch 变化；
- active capture 长尾、页面隐藏恢复、latest-slot 丢弃；
- 缺测指标和诊断容量上限。

线上阶段必须在维护窗口、用户会话释放后进行：

- 真实断网/恢复不超过 20 秒时保持原控制租约；
- 旧 Socket 输入全部拒绝，新 Socket 只有 Host ACK 后恢复；
- 30 分钟连续控制和投屏；
- 输入到可见效果指标有有效样本；
- 本地和公网入口分别验收。

当前用户会话期间不加载、不重启、不重建 tunnel、不做真实输入验收。

