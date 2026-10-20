# Host 可丢 DC 诊断准入：只读设计审查

2026-10-17。审查目录 `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`；参考 `/tmp/wrd-turn-host-stall-code-review.md` 第 4 节，核对当前 host.py、media_stage_metrics.py 和本机安装 aiortc 源码。没有修改源码/index，没有运行服务、浏览器、网络或运行测试。本文只是设计建议，不声称线上停顿根因或运行验收完成。

## 结论和方案比较

最小可实施方案是在 ScreenCaptureTrack 的四类常态诊断发送处统一使用同步、无等待、无重试的字节准入 helper。仅允许 `frame_timing`、`capture_stats`、`frame_trace_batch`、`loss_lab_host_trace_batch`；所有其他类型拒绝进入该 helper。`input_ack`、`input_frame_binding`、clock sync、lab selected-pair/flush ACK 保持原路径。业务输入、重放、Socket fallback、Quality Lock 均不改。

|方案|结果与代价|建议|
|---|---|---|
|A. 仅字节准入，固定 4096 B|直接阻断已复现的诊断线性入队；代码最小；详细 trace 大批次会完整丢弃并计数|推荐本轮，保护输入通道优先；明确 detail 可能缺测|
|B. 同样准入，固定 16384 B|比 A 多容纳约 4 倍诊断 backlog，可容纳更多中等 trace 批次；仍不能保证所有 64 行批次可发送|若团队更重视 detail 可用性可选，但不以“64 条”推断其足够|
|C. A/B 加 frame_timing 5–10 Hz 限频|降低正常序列化/发送开销，改变采样密度并需额外时钟测试|非修复无界队列所必需，暂不扩大范围；本轮不做 latest 队列|

4096/16384 都是工程上的诊断入队预算，不是经验测出的网络最优点。按现有复现约 229 B/条算，分别约 17/71 条 frame_timing，即 20 fps 下约 0.85/3.55 秒的消息生成量；这不是网络排空耗时或 ACK 时延上界。增加上限只是在诊断覆盖和潜在 FIFO 干扰间折中。推荐 4096 是保守输入体验取向；不应宣称完整 ACK 队列因此有 4096 B 硬界。

每份完整 JSON 的 UTF-8 字节数必须在发送前计算；如果单条已超过上限，立即丢整条、记录 oversized。无截断 JSON、无拆批、无后台待发、无扩大阈值、无重试。64 条 trace 的条数界不是字节界：FrameTrace.as_wire_row 有身份和 9 个阶段字段，合法 64 行批次可以超过 16384 B。低流量正常 100 ms 批次常较小，但没有线上分布支持保证。此轮接受明确缺测，后续确有实验需求再单独设计按字节切批。

## aiortc 边界和原子性

已安装 rtcdatachannel.py send 同步检查 open，调用 RTCSctpTransport._data_channel_send。后者 UTF-8 编码、同步加 bufferedAmount、append 无 maxlen 的 _data_channel_queue，随后调度 flush。flush 在 SCTP established 且 _outbound_queue 空时取下一项，await _send 后减 bufferedAmount；_send 分片进入 _outbound_queue，_transmit 进入 _sent_queue。

因此 bufferedAmount 是该 channel 尚未完成向 SCTP 提交的数据字节；不包括所有已提交 outbound/sent/retransmission 数据及其开销，也不是整个 association 跨 channel 的预算。传输 drain 能让 bufferedAmount 归零，但仍有 SCTP 在途数据。helper 不读取或修改 aiortc 私有队列。仅保证“本次常态诊断 send 被接纳时，当前 channel 的 reported bufferedAmount + 此 JSON bytes <= cap”；其他可靠消息可以把总量抬到 cap 以上。不得称其 ACK 优先队列、端到端硬容量、内存总界或 ACK SLA。

四处调用均在 track.recv 的 asyncio 线程同步执行，helper 从最终身份/状态/字节检查到 dc.send 不含 await、不新建 task、不调用 executor。aiortc send 同步增加值，第二份 batch 会看到第一份的新增量；不需要线程锁。若未来跨线程调用，应先重新设计线程归属，不能把线程锁视为对 aiortc 的线程安全保证。

## 最小 helper 契约

- 输入 host、候选 dc、已构造 payload，返回 sent/drop reason；也可封装在 track 方法。固定 allowlist，固定 cap，不增加配置矩阵。
- 先尝试序列化一次；捕获序列化异常，不能中断 recv。`len(serialized.encode('utf-8'))` 与实际 send 的同一 serialized 对应；不得用字符长度或对象估算。
- 在 send 前验证 `dc is host.get_input_datachannel()`、`readyState == 'open'`、send 可调用；None、旧对象或关闭通道立即丢。生产 getter 只返回 `_input_datachannel`，本身不验证 open；不能依赖 getter 自动做检查。
- bufferedAmount 必须是非 bool、非负整数（实际 aiortc property 为 int）。缺失、None、字符串、负数、float、NaN、Inf 或 getter 异常全部 fail closed。拒绝全部 float 比容忍 0.0 更简单，与生产类型一致；测试 fake 必须模拟真实 API。
- 当前 bytes 大于 cap 或 current > cap - bytes 则 drop，等于允许。send 异常记 send_error，绝不改道发送。
- channel identity check 只解决候选对象失效，不自动证明旧 track generation。若当前调用还需保护旧 track，应沿用既有 track scope 校验而非在此改协议；helper 不缓存 channel，不在新 channel 补发旧消息。
- 固定原因枚举和固定类型键的标量计数，不保存 payload、ID、原始输入或逐条错误日志。计数可用饱和整数以保持严格状态大小有界。当前没有通用 frame_timing/capture_stats drop 指标，需补一份本地聚合摘要（沿用约 5 秒摘要时机），不能通过该 DC 每 drop 发一条日志消息。

## pending legacy inputs 与 trace 计数

当前 `_pending_input_ids` / `_pending_input_data` 仅初始化、清空；生产路径无写入，测试仍注入。真实 M2 是 InputFrameCausality / input_frame_binding，不通过这些字段完成。每次 frame_timing 尝试应在原锁下取走并清空 legacy 两容器，即使 host/DC 缺失、拥塞、oversize 或 send 异常；不能积累等通道恢复，也不能挂到下一个 frameId。成功发送保留现有 wire 字段兼容；drop 时仅记录丢失 ID 数/metadata 条数，无原始值。frameId 可按每次 timing 尝试递增，允许缺号；不重编号缺测成连续成功。无需因此修改 input_frame_binding 或因果库。

现有 trace registry 已提供 `note_dropped_trace(count)`、`note_dropped_loss_lab_events(count)`。两种批次必须各自发送/各自记失败：第一份成功、第二份失败时不能把第一份再记为丢失，当前合并 try/except 的计数方式应顺带收紧。

特别注意：`take_loss_lab_trace_batch` 会取出并清零 `_lab_loss_dropped`。该 batch 丢弃时须归还 `len(events) + batch['droppedEventCount']`，否则已有丢失证据被吞掉；下次成功只报告一次。如果 events 空但 droppedEventCount > 0，不得静默 return，应允许发送仅含 drop 指标的合法 batch，或把计数归还等待后续事件。后者最小但可能没有后续事件，所以建议发送空 events 的计数批次并保持现有 schema。必须核对 Viewer 接收器允许空 events；若不允许，先归还而不是改消费者协议。trace 累计 droppedTraceCount 不应重复归还旧值，只为当前实际丢弃 traces 加计数。

保持 loss_lab_trace_begin / begin_loss_lab_trace 的 epoch 和 sourceWatermark / flush ACK 原有语义；helper 不包 flush ACK、不重放旧 epoch batch。drop 指标造成 lab 验收失败/缺测是正确行为，不能归零来让验收通过。

## 关键 red/green 测试

1. 复用真实 `_send_frame_timing` + 安装 aiortc _data_channel_send/_data_channel_flush 的纯内存 fixture，SCTP established、outbound 保持 busy；至少 200 次调用。red 为既有 200 queued/45890 B；green 为诊断 bufferedAmount 不超过 cap，后续调用持续 drop，不随调用次数增长；无新等待队列/重试 task。计入 aiortc 本身为接纳的消息创建 flush task，但拒绝消息不得调用 send。
2. 精确边界：current + UTF-8 bytes == cap 成功，+1 拒绝；单包 oversize 在 empty channel 也拒绝；连续两批检查第二批看到第一批同步增长。用非 ASCII 明确字节/字符差异。
3. None、替换 channel、非 open、missing/invalid bufferedAmount、send 抛异常均不外泄异常、不 fallback。换新 channel 后只发当前新统计，不排空缓存。
4. frame_timing 三种 drop（无 DC/拥塞/oversize）均清空注入的 legacy pending，计数准确，下帧无旧 input 字段。成功行为及 timings null 字段不变。
5. 两种 trace 各自失败计数，尤其第一种成功第二种失败；loss batch 已带 droppedEventCount 后再次 drop，再成功时累计恰好保留一次；空 events + drop count 处理不丢计数。原 lab begin/flush epoch 测试仍通过。
6. 隔离契约：把输入 DC 填到诊断 cap 后，现有 input_ack、input_frame_binding、clock_sync、flush ACK 原路径仍会尝试发送，且不会被 helper 随意丢弃；断言可靠路径可能超过 cap，防止错误“完整队列硬界”测试。无 Socket fallback、新输入重放或 Quality Lock 改动。
7. Viewer 现有 5 秒无新 timing 时 available=false、延迟值 null 的缺测测试保留；本轮不制造 0，不宣称 capture_stats 自带 TTL。离线 green 只证明准入与兼容性，不代替长会话或停顿根因验收。
