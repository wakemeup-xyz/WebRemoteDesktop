# WebRemoteDesktop 最近两天日志复核（2026-10-20）

## 范围和证据

本次只读复核覆盖：

- `/tmp/signal-server.log`
- `back-debug.log.3`、`back-debug.log.2`、`back-debug.log.1`、`back-debug.log`
- `/tmp/wrd-diag/summary/2026-10-18.ndjson`、`2026-10-19.ndjson`、`2026-10-20.ndjson`
- `/tmp/wrd-diag/raw/runtime_*.json`

按结构化时间戳得到的窗口约为 **2026-10-18 20:42–2026-10-20 20:43（Asia/Shanghai）**。Signal 日志按内部 `ts` 过滤，Host 日志按行首时间过滤；没有把无时间戳的历史启动行当作本窗口证据。

复核期间没有重启、加载新版、接管 Viewer、发送输入或操作 tunnel。当前只读状态为：本地 `/api/status` 返回 200，Host 在线，Viewer 1、relay Viewer 0；这个 Viewer 是用户当前会话。

## 结论

问题仍未彻底解决，且现在可以分成三个相互叠加的故障面：

1. **信令连接确实反复断开，恢复链会丢失控制窗口。**
2. **活动会话的 Host 捕获和处理有明显长尾，导致画面帧率和输入反馈抖动。**
3. **诊断数据在故障时经常为空或缺关键时间戳，所以目前仍无法闭合“输入到可见画面”的完整因果链。**

当前实时视频统计显示 relay 路径可以正常传输，因此不能把所有问题归因于公网带宽或 WebRTC 丢包。

## 1. 信令、重连和控制租约

两天内 Signal 结构化事件统计：

| 事件 | 次数 | 说明 |
| --- | ---: | --- |
| `signal_socket_disconnected` | 32 | 其中 ping timeout 11、transport close 19、namespace disconnect 2 |
| `viewer_disconnect_grace_started` | 30 | 进入断线宽限窗口 |
| `viewer_disconnect_grace_expired` | 19 | 宽限期结束仍未完成恢复 |
| `viewer_reconnected` / `viewer_rebind_confirmed` | 10 / 10 | 只有部分断线完成重绑定 |
| `control_transition_failed_closed` | 25 | lease-expired 12、controller-disconnect 8、released 5 |
| `control_reset_completed` | 25 | 服务端记录为 applied/FREE |
| `signal_input_relayed` | 91 | 全部走 Socket fallback，均为 accepted |
| `signal_input_rejected` | 1 | unauthorized 的 keyboard reset |
| `diagnostic_uploaded` | 20 | signal-connect-error 7、dc-stuck 6、negotiation-timeout 1，另有 6 条未带明确 reason |

这说明“连接断了以后自动恢复”目前只能在一部分会话上闭合；19 次宽限期过期和 25 次控制状态闭合失败，足以解释用户看到的控制输入中断。Socket fallback 让部分 reset 能到达 Host，但它不能证明原 DataChannel 已恢复，也不能证明用户每次按键都没有丢失。

客户端故障证据还包括：

- `signal-connect-error` 记录中出现 5 秒 WebSocket connect timeout；
- 另一条记录显示 polling 路径 `auth-invalid`，PC failed、ICE disconnected、SCTP closed；
- 还有一次连接停在 negotiation，尚未设置本地/远端 SDP；
- 故障快照中出现 `deliveryUncertain=true`、`hasLease=false` 或 `effectiveGate.allowed=false`。

Signal 的 Node 心跳观测在本窗口没有 missed sample，Node 单次观测最大约 185 ms、p95 约 140 ms；因此当前证据更像是传输/连接状态和恢复协议问题，不能先归咎于 Signal 进程被 CPU 完全卡死。心跳 ring 累计丢弃 10,804 条、单次最高 2,593 条，说明故障上下文本身也会被丢掉。

## 2. Host 捕获、投屏和资源长尾

Host 两天内产生 10,483 个 `host_event_loop_lag` 样本：

- event-loop lag p50 **7.95 ms**、p95 **8.27 ms**、最大 **134.11 ms**；
- 85 个样本超过 10 ms，33 个超过 20 ms；
- 捕获耗时 p50 **39.7 ms**、p95 **147.7 ms**、最大 **501.0 ms**；
- 280 个捕获耗时超过 100 ms，11 个超过 200 ms；
- 活动采集速率范围 **5.9–18.1 Hz**，中位数约 **10.1 Hz**，低于目标 20 FPS；
- Host 的无序输入丢弃计数从 1,534 增长到 2,308，增加 774。

当前活动段的尾部日志更直接：

- 20 FPS 目标下，最近 60 秒捕获平均间隔约 62.6 ms，实际约 16 Hz；
- grab 平均约 61.9 ms，单次约 125.5 ms；
- 当前进程 RSS 约 488.6 MiB，峰值约 496.3 MiB，system load1 约 5.54；
- encoder 最近样本平均约 7.9 ms，p95 约 11.8 ms，说明现阶段主要长尾在 capture/grab 和调度，不是编码器平均耗时；
- 当前 Viewer 统计为 18–20 FPS、RTT 22–24 ms、jitter buffer 约 32–36 ms，lost/dropped/nack/freeze 均为 0。

因此，当前活动会话的画面“看起来还能动”并不等于低延迟：网络包没有丢，但 Host 采集周期已经把 20 FPS 预算吃掉，遇到 100–500 ms 的抓帧长尾时，输入后的下一帧会明显变慢。

另一个需要区分的现象是 `host_media_suspended`。两天内有 7 次，原因均为 `page-hidden`，并且会同时关闭 input、sender、capture、relay。这些时段的 `capture unavailable/suspended` 是页面可见性策略的结果，不能直接当成服务器宕机；但如果用户只是切到后台或浏览器锁屏，页面需要明确提示“投屏已暂停，回到前台恢复”，否则体验上仍会被认为是断线。

## 3. 输入执行和输入到画面

Host 日志中有 591 组完整的 received → result → ack：

- 三个阶段均为 accepted/applied；
- received 到 result：p50 **2 ms**、p95 **16 ms**、最大 **101 ms**；
- Host `localExecuteMs`：p50 **1.56 ms**、p95 **15.54 ms**、最大 **98.92 ms**；
- 50 次超过 10 ms，20 次超过 20 ms；
- 560 次走 DataChannel，31 次是 keyboard reset 的 Socket fallback；
- 高频 mouse move/wheel 有 119 次聚合记录，其中 78 次标成 unordered。

这表明“输入已到 Host”通常不是最慢的一段；真正没有测出来的是：

`输入发送 → ACK → Host 执行 → 下一帧产生 → 浏览器收到 → 浏览器绘制 → 用户可见`

最近 9 个 runtime diagnostic raw 文件中：

- 所有文件的 `logCount` 都是 0；
- 多数失败快照的接收帧数、FPS、绘制帧数和延迟指标都是 0 或不可用；
- 正常连接快照只提供 paint interval、candidate RTT、jitter、decode、capture prepare/convert 等部分指标；
- `inputToFrameNoticeMs`、`inputToPostApplyFrameMs`、`inputToVisibleEffectMs` 在这些快照中没有有效样本；
- 部分失败快照有 ackTimeoutCount 2–3，旧 build 的 dc-stuck 快照曾达到 29；
- `.summary-state` 仍记录 receipt-horizon gap，count 23。

所以目前不能用 ACK RTT 或 Host localExecuteMs 冒充“用户看到画面的耗时”。真实可见延迟仍是缺测项。

## 4. 网页入口和公网路径

本窗口内本地入口当前可用，`/api/status` 和 `/health` 均返回 200，Host 在线。Signal entry window 记录完整，没有看到本地 Signal 进程异常退出的直接证据。

但本轮没有验证公网 tunnel，因为当前安全 URL 文件不存在，且用户会话正在使用。因而只能得出：

- 本地网页和 Signal 当前可响应；
- 曾经发生过 WebSocket/polling connect timeout、ping timeout 和 transport close；
- 不能从本地 200 推出公网入口连续可用；
- 不能在不触碰用户会话的情况下判定公网 DNS、边缘连接和浏览器实际加载链路已经稳定。

## 需要优先处理的问题

1. **恢复协议和租约状态机**：给每次 disconnect、grace、reset、rebind 使用同一 connectionAttemptId/leaseEpoch，检查为什么 19 次宽限期过期没有闭合重绑定；区分 ping timeout、transport close、auth-invalid、negotiation timeout，避免都落入同一个 reset 分支。
2. **活动采集长尾**：围绕 MSS/Quartz grab、capture 线程调度、队列堆积和页面可见性切换做 profile；目标先把 active capture p95 压到 50 ms 内、最大值控制在一个帧周期附近，再讨论编码器微调。
3. **输入可靠性**：保留 keyboard/mouse reset 的可靠通道；对 DataChannel 卡住时的 fallback 增加明确的切换、恢复和去重证据，避免只看到 Socket reset accepted 就误判控制已恢复。
4. **补齐可见效果指标**：在不记录原始输入、坐标或剪贴板的前提下，持久化有界的发送时间、ACK、Host apply、frame correlation、paint/visible-effect 时间；失败时也要保留最小诊断上下文，不能所有故障都变成 `logCount=0`。
5. **页面隐藏反馈**：把 page-hidden 的 capture suspension 显式显示给用户，并在回到前台后验证 sender、capture、keyframe 和 input gate 的恢复顺序。
6. **公网验收单独进行**：待用户会话允许维护后，分别验证本地、正式域名、WebSocket、WebRTC、首帧、输入 ACK 和可见画面；不要把本地健康或既有离线回归当成公网长会话验收。

## 当前边界

这次复核没有加载之前的 Viewer 修复，也没有改变生产代码。它确认了新的日志证据和未覆盖的性能问题，但不能宣布频繁控制丢失已解决。输入到真实可见画面的端到端指标仍未完成，公网连续性也没有在本轮验收。

