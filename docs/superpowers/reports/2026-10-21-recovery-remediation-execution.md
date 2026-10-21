# 控制恢复、采集背压与输入可见效果整改记录

日期：2026-10-21

## 为什么此前仍未解决

前两天的工作已经补了大量日志、租约代数、帧追踪和离线 fixture，但没有闭合导致控制中断的时序。线上实际仍是客户端信令恢复上限 12 秒、Signal Viewer 宽限 8 秒；客户端可能已经重新连回，服务端却先释放了原租约。重绑定到 Host 又只有一次 1.5 秒 ACK 等待，Host 事件循环或采集长尾超过这个等待时，恢复会被判定失败。因而“网页连上”与“控制租约恢复”不是同一个结果。

媒体侧已有 latest slot 和 ACK 窗口，但 ACK 超时的旧帧会继续占用 in-flight 槽，直到 2 秒 TTL；短暂网络阻塞会被放大成采集等待和低帧率。原有计数还把这类主动丢弃混在 expired 中，报告看不到真正的 coalesced/drop 原因。

输入、Host ACK、帧通知和 paint 观测虽然分别存在，普通生产链路没有把受控 marker 的可见效果接到 `LatencyMonitor`。所以故障快照常出现 `logCount=0` 或 `inputToVisibleEffectMs` 缺测，无法判断输入已经应用但画面是否真正呈现。

## 本轮实现

- Signal 默认 Viewer 宽限改为 30 秒；Viewer 信令恢复窗口改为 24 秒，保留 6 秒余量给服务端重绑定。
- Host `viewer-session-rebind` 使用有界 ACK 等待 `[1500, 3000, 6000]`，同一 operation 携带 attempt/leaseEpoch 保护；旧回调、旧 Host、旧 socket 和租约变化都会被忽略。自定义等待被限制为最多三段且总预算不超过 24 秒，预算耗尽仍 fail-closed。
- relay ACK 超时时立即清理旧 in-flight 帧，只保留最新槽；迟到 ACK 变成 unmatched。主动合并/丢弃计入 `coalescedCount`，不再伪装成按年龄过期。
- 受控输入诊断补齐 send、ACK、Host apply 后帧和 marker→rVFC 可见效果。marker 早于 ACK 时只保存有界标量时间，ACK 被拒绝不会产生可见样本；没有配置受控 marker 的普通会话保持 `null/不可用`。

## 离线验证

以下命令均在隔离 worktree `codex/after-grace-recovery-remediation` 执行，未启动或重启线上 Signal、Host 或 tunnel：

- Signal：`node --test signal-server/websocket/signaling.test.js`，124 passed。
- Viewer、受控输入、帧追踪和信令连续性：`node --test web-client/js/latency-monitor.test.js web-client/js/webrtc.frame-trace.test.js web-client/js/input.test.js web-client/js/input-signaling-continuity.test.js web-client/js/webrtc.test.js`，813 passed。
- 诊断链路：`node --test web-client/js/diagnostic.test.js signal-server/test/diagnostic.test.js`，64 passed。
- Host 捕获、relay、采集观测和输入帧因果：`python3 -m pytest -q python-host/test_relay_frame_worker.py python-host/test_tunnel_relay.py python-host/test_latency_timing.py python-host/test_capture_observation.py python-host/test_media_stage_boundaries.py python-host/test_input_frame_causality.py`，111 passed，19 subtests passed；仅有 mss 弃用警告。
- `node --check signal-server/websocket/signaling.js`、`git diff --check` 通过。

## 合入 main 与本地重启结果

已将整改分支合入 `main`，并补入无媒体 attempt 重绑定边界修复。合入后的 `main` 回归结果为：Signal 125 passed、Viewer/输入/帧追踪 813 passed、诊断 64 passed、Host 111 passed，19 个 Python 子测试通过。

随后按 `webremote-service` 流程执行了本地 `restart-local`。重启后 Signal PID 为 `43044`，Host PID 为 `43093`；`/health` 返回 `status=ok`，`/api/status` 返回 `hostOnline=true`、`viewerCount=0`。正式入口 `https://link.stockhub.wiki/health` 返回 `status=ok`，Viewer 页面返回 HTTP 200。`/tmp/wrd-safe-current-url.txt` 重启前后均为空，未发生 tunnel URL 变化，也没有停止、重启或重建 `cloudflared`。

## 当前仍需维护窗口验收

本轮已完成本地构建加载和本地服务重启，但没有占用 Viewer 或发送真实输入。以下仍不能宣布完成：真实断网不超过 20 秒的原租约恢复、30 分钟长会话、正式域名连接、页面隐藏/恢复在真实浏览器上的顺序，以及生产环境的实际 `inputToVisibleEffectMs` 样本覆盖。

维护窗口需要再次读取 `/tmp/wrd-safe-current-url.txt`、Signal/Host 当前日志和构建身份，先做本地健康与首帧，再做短断线恢复、控制输入和投屏长会话；失败时保留服务运行态并记录缺测原因。

## 2026-10-21 双阶段采集与运行证据增量

本次继续优化已合入 `main`：

- `RelayCaptureEncodeWorker` 将 tunnel relay 的 MSS 抓帧和 JPEG 编码拆到 `relay-capture`、`relay-jpeg` 两个专属线程；每个阶段最多一个运行项和一个 latest pending。Tunnel relay 只保留一个 prefetch future，最多提前准备一帧；generation、暂停、停止和超预算都会 fail-closed，并释放 detached image。
- relay snapshot 现在提供 `captureActive`、`encodeActive`、两阶段 queue wait/耗时、capture/encode p95/max、`droppedCount` 和 `coalescedCount`。MSS 资源只由 capture worker 关闭，跨线程 Future 通过事件循环回调完成。
- Signal runtime evidence 接入 HTTP/WebSocket diagnostics、viewer-heartbeat close 和 `/api/admin/observability/summary`。receipt 明确输出 `logCount`、summary gap、ring drop、RSS/CPU、FPS/丢帧和 `inputToVisibleEffectMs` coverage；缺测进入 `coverage.missing`，不以 ACK 或 decoder 计数冒充可见效果。进程重启后内存窗口重新开始。

离线验证：

- `PYTHONPATH=python-host python3 -m pytest -q python-host`：758 passed，184 subtests，1 个 MSS 弃用警告。
- `NODE_PATH=signal-server/node_modules node --test signal-server/test/*.test.js web-client/js/*.test.js`：1769 passed；其中 web asset build/retention 在并行全量运行时会争用共享 `dist.tmp`，按文件顺序运行通过。该测试隔离问题不影响生产构建。
- 双阶段 worker、tunnel relay、runtime observability、diagnostic store focused tests 均顺序通过；`git diff --check` 通过。

本节代码尚未由当前运行中的 Host/Signal 加载；维护窗口重启后才开始真实运行证据窗口。真实 Viewer 首帧、FPS、RSS/CPU、capture p95/max、丢帧、visible-effect 覆盖率，以及短断线和长会话的实际时长仍须以维护窗口 receipt 和日志为准，未采到的字段保持 `NOT RUN`。

## 2026-10-22 维护窗口实测结果

本次维护窗口使用正式域名 `https://link.stockhub.wiki`，本地服务重启前后 `/tmp/wrd-safe-current-url.txt` 都为空，未操作 tunnel。新代码加载后的服务状态保持 `health=ok`、`hostOnline=true`；实测结束时 `viewerCount=0`。

- 30 分钟 passive STUN 长会话通过：请求 1800 秒，实际 1800.1043 秒，1801/1801 个采样，无缺失、迟到或失败观察。浏览器真实解码 FPS 的每秒增量 p50=19、p95=20、max=20；`framesDropped=0`；`frameAgeMs` p95=50.1ms、max=67.1ms；最大帧间隔 p95/max=166.6ms。没有发送业务输入，因此 visible effect、active control 和 physical display 均为 `NOT_RUN`。启动期 selected ICE pair 从 path-1 收敛到 path-2 一次，已被记录为 `pathConvergenceObservations=1`，没有算作断线或 session identity change。
- within-grace 短断线通过：服务端记录 disconnect grace 30 秒，Viewer 在 5.30 秒后完成 rebind，脚本确认恢复稳定 30.03 秒；总恢复耗时 8.0074 秒，server coverage complete，Host disconnect 未发生。此场景没有发送业务输入，不能证明输入到可见效果。
- Host 日志窗口显示 event-loop p95=4.3278ms、max=21.5438ms；Host current RSS 从约 301.9MiB 升到 392.3MiB，窗口 p95/max 约 452.0MiB，peak RSS 459.7MiB。连接和帧没有失败，但 Viewer 关闭后 RSS 仍高，说明存在后续应处理的内存保留/释放问题；需要单独做 Host 资源归因和重复长会话回收实验。
- Signal admin evidence receipt 的 `summaryGapCount=0`；`ringDropCount=182` 是 heartbeat 环覆盖计数，不是媒体丢帧。该 passive 流程没有上传 diagnostic report，所以 receipt 中 `logCount`、FPS、媒体 droppedFrames 和 `inputToVisibleEffectMs` 保持缺测；浏览器样本文件已单独保存并完成 FPS/丢帧统计。完整脱敏摘要见 [maintenance-window-summary.json](evidence/2026-10-22-maintenance/maintenance-window-summary.json)。

本轮实测因此确认了“长会话投屏连续性”和“短断线重绑定”两个目标，但没有把业务输入或可见效果伪装成已验收；下一项优先优化是 Host RSS 在长会话后的增长，以及将浏览器 FPS/丢帧摘要以有界、脱敏方式接入 admin evidence receipt。

