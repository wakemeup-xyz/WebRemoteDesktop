# 持续断连整改执行计划

日期：2026-10-24
关联设计：[持续断连与控制中断整改设计](../specs/2026-10-24-continuing-disconnect-remediation-design.md)
关联诊断：[2026-10-24 持续断连专项诊断](../reports/2026-10-24-continuing-disconnect-diagnosis.md)

## 执行边界

本计划基于 2026-10-24 日志，当前只完成诊断和计划落盘。本轮没有修改代码、没有重启本地 Signal/Host、没有重建或重启 tunnel。实施时沿用 `webremote-service` 规则：先读启动文档，重启只允许本地 Signal/Host，结束前必须核对 health、Host online、Viewer 范围和当前密码。

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
2. Host/Signal 为每个受控 marker 输出 bounded scalar trace：send、relay、received、result、ack、frame、rVFC；客户端诊断保留最近有限条日志，使 `logCount` 不再稳定为 0。
3. UI 明确区分 `page-hidden`、`transport-lost`、`negotiating`、`media-stalled`，并在 page visibility 恢复时只提交一个 generation 新的 resume。
4. `/api/admin/observability/summary` 显示 Host receipt 的缺测原因，不把 heartbeat ring drop 当成 RTP drop。

通过门槛：真实 marker 会话 ACK p95≤200ms、max≤1,000ms；expired ACK=0；`inputToVisibleEffectMs` 覆盖率≥95%；自动诊断 `logCount>0`、summary gap=0。

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
- 阶段 1–4：未实施，不能把当前“本地 health 正常、偶尔可见 19 FPS”宣布为持续可用。
