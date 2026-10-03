# WebRemoteDesktop 上下文连续性与性能复核（2026-10-04）

## 结论

偶发“丢失上下文、需要手动重联”由两个问题叠加：

1. Signal Socket.IO 短暂断开时，Viewer 只给隧道模式安排恢复；Relay 和 STUN/直连会停留在断开状态。页面从后台、休眠或网络切换回来时，旧 socket 也可能保持在失效状态。
2. 2026-10-01 日志记录到约 7700 个 wheel 事件的快速滚动，同时 Host 为每个事件写入输入和 timing 日志；同一窗口出现 TURN `TransactionTimeout`、event-loop lag 和 ICE candidate pair failed。日志 I/O 与高频输入共同放大了恢复窗口。

历史 Host 日志共记录 1981 次 event-loop lag，其中 506 次达到 critical；p95 约 204ms，最大约 1081ms。该统计包含高系统负载时段，不能把全部延迟归因于单一编码器，但高频 wheel 日志属于应用可以直接消除的竞争源。

## 已实施

- Viewer 对 `connect`、`disconnect`、`connect_error` 建立统一 signaling recovery supervisor，覆盖 Relay、STUN/直连和 Tunnel。
- Socket 断开后先等待 Socket.IO 自动恢复；超过 12 秒才重建 signaling socket。媒体链路健康时复用现有 PeerConnection，媒体不健康时才刷新 offer，减少黑屏和上下文重建。
- `pagehide`、`pageshow`、`online` 统一处理，优先复用现有 socket，恢复后重放 media intent、重新绑定控制租约并检查 DataChannel。
- 手动断开和 viewer 被 supersede 时继续保持 fail-closed，不会被自动恢复误触发。
- Host 对 wheel 事件停止逐条 INFO 日志，只保留已有聚合观测、可靠输入日志和超过 50ms 的异常 timing；输入行为不变。

## 验证

- `node --test web-client/js/webrtc.test.js`：219 passed。
- `node --check web-client/js/webrtc.js web-client/js/webrtc.test.js`：通过。
- 输入与诊断专项：由子代理完成 59 passed，覆盖 wheel 日志抑制和输入聚合。
- `git diff --check`：通过。

## 后续观察

发布后应重点观察 `signal-disconnect`、`connect_error`、`reconnect`、`pc-disconnected`、`ice-disconnected`、`host_event_loop_lag` 和 `signal_input_aggregate`。如果重连次数下降但仍频繁丢控制权，再增加带短暂 grace 的 Viewer 会话身份重绑定；当前先通过前端自动恢复和 Host 日志降噪降低风险，避免扩大租约状态机改动面。
