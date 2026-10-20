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

随后按 `webremote-service` 流程执行了本地 `restart-local`。重启后 Signal PID 为 `43044`，Host PID 为 `43093`；`/health` 返回 `status=ok`，`/api/status` 返回 `hostOnline=true`、`viewerCount=0`。`/tmp/wrd-safe-current-url.txt` 重启前后均为空，未发生 tunnel URL 变化，也没有停止、重启或重建 `cloudflared`。

## 当前仍需维护窗口验收

本轮已完成本地构建加载和本地服务重启，但没有占用 Viewer 或发送真实输入。以下仍不能宣布完成：真实断网不超过 20 秒的原租约恢复、30 分钟长会话、正式域名连接、页面隐藏/恢复在真实浏览器上的顺序，以及生产环境的实际 `inputToVisibleEffectMs` 样本覆盖。

维护窗口需要再次读取 `/tmp/wrd-safe-current-url.txt`、Signal/Host 当前日志和构建身份，先做本地健康与首帧，再做短断线恢复、控制输入和投屏长会话；失败时保留服务运行态并记录缺测原因。

