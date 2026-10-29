# 控制恢复、信令回退与入口监测修复设计

日期：2026-10-30（Asia/Shanghai）。承接[最近日志复核](../reports/2026-10-30-recent-log-review.md)。本设计针对日志中已证实的恢复放大器和入口监测误判，不改变控制租约的 fail-closed 语义，也不在本轮操作 tunnel。

## 问题边界

最近窗口同时出现：

- formal health 经环境代理 TLS 失败、origin health 正常时，watch coordinator 触发 `restart-fixed-domain-tunnel.sh`，造成约6–7分钟公网中断；SIGTERM 发送者和底层 TLS 根因仍未知。
- 一次 WebSocket opening timeout 会把整个 signaling session 变成 polling-first，后续连接长期沿用该回退。
- 同一 connection attempt 被重复 bind 3–9次，可能放大 Host rebind/media activity 竞态。
- `keyboard-reset-send-failed` 可在媒体已绘制、PC/ICE/SCTP/DC 已打开时阻塞输入恢复。

本轮不把这些现象合并成一个网络根因；每个修复必须保留原始 scope、lease、attempt 和安全屏障校验。

## 设计决策

### 1. Entry watcher 采用多证据、分路径判据

- `formal-health` 的 environment-proxy TLS failure 只记为 `formal-route-unknown`，不能单独把 `formal=false` 送入 connector restart。
- `origin=true + formal=false` 只有在 direct formal probe 明确失败，且连续窗口满足时间阈值时，才进入候选恢复；单一路径代理失败保持观察状态。
- `formal HTTP 530/5xx` 与 TLS/proxy、DNS、连接失败分开计数；恢复决策记录有界 `decisionId`、`actor=watch-coordinator`、证据路径摘要和连续失败窗口。
- 现有恢复预算、锁、子进程退出证明、tunnel 不触碰约束保持。修复代码不直接杀进程，也不扩大 watcher 权限。

### 2. Signaling fallback 仅短期有效

- WebSocket opening timeout 可为当前 reconnect episode 设置 polling fallback，但带有短 TTL 和 attempt 标记。
- 成功 WebSocket 连接后清除 fallback；polling 连接成功也要在后续探测窗口重新尝试 WebSocket-first。
- 不自动禁用 polling，不改变 token、viewer admission 或业务输入路径；保留 transport、fallback 选择和清除原因的脱敏计数。

### 3. Connection-attempt bind 幂等

- Viewer 在同一 socket、attemptId、attemptSequence、lease epoch、network mode 下只发送一次 bind；允许明确的 socket/attempt/lease 变化重新发送。
- Host late-offer 或显式媒体重绑仍可发送，但必须使用不同的 reason/attempt scope，不能把同一 scope 的重复 bind 当新恢复。
- Server 继续校验 authority；本修复不放宽旧 attempt、旧 lease 或旧 socket 的接受条件。

### 4. Keyboard reset 失败可恢复但不自动抢占

- 将 send failure、ACK timeout、旧 lease、reacquire-required、transport unavailable 分开建模。
- 失败继续保持 input gate blocked；在当前 socket/lease 可验证时允许一次有界安全 retry，超过预算显示显式重新请求控制入口。
- 不重放未知结果的业务输入，不自动向新 viewer 抢控制权；reset 成功仍需原有 lease/attempt/seq 校验。
- 记录 `resetAttempted/resetSent/resetAcked/resetFailed` 的脱敏计数，区分媒体 healthy 与 control healthy。

## 非目标

- 本轮不调整 Cloudflare 配置，不重建或重启 tunnel，不把 proxy TLS failure 当作 tunnel 根因。
- 不把 Host capture 的非 thread-CPU 残余直接命名为纯阻塞或 CPU 卡顿；capture/encode 长尾继续作为独立后续任务。
- 不用自动探针、reset-only 或 Socket reconnect 代替真实业务输入、物理可见效果或三小时连续性验收。

## 验收契约

- watcher：environment formal TLS failure 不触发 restart；direct formal 连续失败、origin 正常、证据满足阈值时才产生候选 restart decision；每次 decision 可在 metadata-only 日志中关联。
- signaling：一次 timeout 后下一次成功 WebSocket 回到 websocket-first；TTL 到期后恢复默认顺序；既有 polling fallback 测试仍通过。
- bind：同 scope 重复调用只产生一次 wire bind；scope 变化仍产生一次新 bind；旧 lease/attempt 仍被拒绝。
- keyboard：媒体 healthy + reset send failure 保持 blocked，但安全 retry 或明确 re-request 可达；失败不会丢失 tracking、推进错误序号或发送业务重放。
- 所有测试使用纯模型、fake transport 或 AST/fixture，不连接公网、不发送真实业务输入、不操作 tunnel。
