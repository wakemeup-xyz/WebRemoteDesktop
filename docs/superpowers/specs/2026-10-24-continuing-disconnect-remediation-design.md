# 持续断连与控制中断整改设计

日期：2026-10-24
状态：诊断完成，待实施
关联报告：[2026-10-24 持续断连专项诊断](../reports/2026-10-24-continuing-disconnect-diagnosis.md)

## 问题定义

WebRemoteDesktop 今天可以打开网页、建立 Signal 和 WebRTC 连接，但不能保证持续控制。故障表现包括：

- Viewer Socket transport close 后宽限到期，原会话没有回到可控状态；
- PC 仍为 connected/completed 时，画面长时间为 0 FPS 或周期性停帧；
- 输入 ACK 超时、DataChannel stuck、旧 lease 输入被拒绝，用户感知为按键/鼠标中断；
- 页面隐藏导致的主动媒体暂停没有和网络断线清晰区分；
- 自动诊断报告的 `logCount=0`，无法把 Viewer 状态、Host 执行和可见画面放进一条证据链。

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

- `logCount`、`summaryGapCount`、ring overwrite/drop（注明是诊断环覆盖）；
- Signal RSS/CPU、Host RSS/CPU、event-loop/capture/encode p95/max；
- Viewer decoded FPS、RTP dropped/freezes；
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
| 控制 | ACK p95≤200ms、max≤1,000ms；过期 ACK=0 |
| 可见效果 | marker→rVFC 覆盖率≥95%，缺测保留 `NOT RUN` |
| 资源 | RSS 无持续单调增长；记录全机 swap 差分和 CPU idle，不能以累计 swap 或 Host RSS 代替全机压力；sender/PC 无重复恢复风暴 |
| 诊断 | 自动失败 `logCount>0`、`summaryGapCount=0`；诊断 drop 与 RTP drop 分离 |

## 失败处理

若 capture deadline 连续超限，标记 `media-stalled` 并上送原因；仅在现有资格允许时调整 FPS，不自动更改用户分辨率。若 fresh-offer 预算耗尽，断开旧媒体但保留 Signal/Terminal，要求 Viewer 建立新 attempt；若输入 fallback 也无法 ACK，立即释放按键/鼠标并显示控制不可用。任何失败都保留本地服务运行态，等待下一次受控验收。
