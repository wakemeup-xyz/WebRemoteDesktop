# 控制恢复与入口监测优化实施记录

日期：2026-10-30（Asia/Shanghai）。承接[最近日志复核](2026-10-30-recent-log-review.md)和设计/计划文档。本轮完成代码与离线 review。Signal/Host 未重启，tunnel 没有操作；前端 dist 已通过原子构建更新，当前 Viewer 不会被强制断开，刷新后会加载新代码。

## 已实现

- **Watcher 误判防护**：生产 watcher 默认使用 direct formal probe；环境代理下 formal 的 TLS、DNS、连接、超时和 HTTP 失败统一为 unknown，不能单独授权 connector restart。direct formal 连续失败仍沿用原有恢复预算和安全 worker。watcher 日志新增 `restartActor`、`decisionId`、`operationState`，便于将 decision 与实际 worker 关联。
- **Signaling fallback 生命周期**：WebSocket opening timeout 触发的 polling-first 只保留30秒；成功 WebSocket connect 或 Engine.IO polling→WebSocket upgrade 会清理回退并恢复 websocket-first。旧 session 的 timer/listener 会在 reset 时移除，避免旧 socket 污染新 session。
- **Connection bind 幂等**：同一 socket、attempt、sequence、lease epoch、network mode scope 下重复 bind 被抑制；scope变化会重新发送。`wrong-attempt`/`applied-false` 的一次有界恢复使用 force bind，保留 late-offer/recovery 语义。
- **Keyboard reset 失败分类**：`keyboard-reset-send-failed`、reset ACK stale-lease、invalid-input、execution-failed 等原因继续沿用原有 fail-closed 释放和受控重新请求流程，但不再统一记录为 `input-recovery-timeout`。没有放宽 lease、seq、reset barrier，也没有自动抢控制权。

## 验证

- watcher/entry Python：36 tests、9 subtests passed。
- watcher shell/LaunchAgent fixture：26 tests passed。
- 前端 `webrtc.test.js`：426 tests passed。
- signaling fallback + input continuity + diagnostic：156 tests passed；新增 reason 与 polling upgrade 测试均通过。
- 私有前端构建通过后已原子更新生产 dist：buildId `2ead120ba885641c`；本地和正式域名 `asset-manifest.json` 均返回该 buildId，desktopJs 为 `assets/desktop-core.f40085d1a3f90619.js`。Signal/Host 未重启，现有页面需刷新加载新资源。

## 加载状态与剩余边界

只重载了 `com.webremotedesktop.fixed-watch` watcher；重载后 state 显示 `proxyMode=direct`、origin/formal均 healthy、action=none、无 in-flight recovery。Signal PID1263、Host PID1251 未重启，cloudflared 未操作。当前服务本地 health/Host 在线，但仍有一个未确认归属的 Viewer，占用 slot；因此没有执行会断开它的 Signal/Host 重启。

本轮没有做真实业务键鼠输入、物理显示、3小时连续性或 tunnel 实际重启验收。Watcher 修复可以阻止后续环境代理 false positive 触发 connector recovery，但不能从历史日志反推 SIGTERM 的最终发送者；该根因仍需只读检查 watcher/launchd/worker 的完整 decision 链。
