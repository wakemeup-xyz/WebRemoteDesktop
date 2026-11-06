# 2026-11-07 断连与丢控制整改执行记录

## 结论

本轮故障窗口的直接表现是 WebRTC 数据通道和媒体推进停顿，不是 Socket.IO 信令连接整体掉线。Viewer 在 01:47:13（Asia/Shanghai）报告 `input-ack-timeout`，随后出现 `dc-stuck`；Signal 没有同期 `signal_socket_disconnected` 或租约过期。Host 在同一窗口出现 4.59–5.59 的调度负载比、约 810–1032ms 的抓帧长尾和媒体恢复失败，说明共享机器调度/捕获压力足以让控制 ACK 与媒体恢复错过时限。

这轮整改已部署到本地 Signal/Host，并保留正式固定域名。它降低高负载时诊断流对控制通道的争用，并限制 Relay 停帧时的编码器档位抖动；它不承诺消除共享机器在极端负载下的所有卡顿。

## 代码改动

- `python-host/dc_diagnostic_admission.py` 和 `python-host/host.py`：事件循环监控根据当前调度、抓帧和间隔样本启用有界压力门。压力时只丢弃 `frame_timing`、`frame_trace_batch`、`loss_lab_host_trace_batch`，保留 `capture_stats`、可靠输入 ACK、复位和媒体。低负载样本恢复后自动清除压力状态，并记录 `host_diagnostic_pressure`。
- `web-client/js/link-quality-controller.js`：Relay 连续停帧且质量锁仍为高档时最多执行一次 `high → medium` 码率/帧率降档，保持用户分辨率；后续只请求关键帧恢复，避免反复重开编码器。
- `web-client/js/runtime-diagnostic.js` 与 `signal-server/lib/observability/runtime-evidence.js`：保留 `pressure` 丢弃原因和 `pressureActive`，让压力证据能从 Host 到 Viewer/Signal 汇总链路完整可见。

## 验证

- Signal：682/682 通过。
- Host 诊断、连接恢复和观测测试：117 passed、19 个子测试通过；媒体边界 13/13 通过。
- Viewer 质量控制 15/15 通过；WebRTC 目标测试 428/428 通过；运行时诊断 14/14、Signal runtime-evidence 19/19 通过。
- `py_compile`、Node 语法检查和 `git diff --check` 通过。
- 本地 `health` 返回 `status=ok`，`api/status` 返回 `hostOnline=true`。
- 正式入口 `https://link.stockhub.wiki` 的 health、认证和 Viewer 页面登录冒烟均通过；固定边缘探针为 `origin-ok=1`、`formal-ok=1`、`edge-open=4/4`。
- 重载后 Host 最新事件循环样本为 normal，最近窗口最大 lag 约 2.3ms，未触发压力门。当前没有活动 Viewer，因此未把空闲期样本当作真实长会话通过证据。

## 运行边界

本轮只重启了本仓库的 Signal/Host，没有停止或重建 Cloudflare tunnel，也没有停止其它项目进程。Signal/Host 重载会短暂中断当前 WebRemoteDesktop Viewer，并结束内存中的共享 Terminal 会话；本次重载时 `viewerCount=0`。真实用户的长时间 Relay、主动控制和可见效果仍需在代表性负载下单独验收。
