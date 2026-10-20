# Host 可丢诊断 DataChannel 字节准入设计

## 问题与选择

真实 `_send_frame_timing` 配合已安装aiortc、仅内存模拟outbound busy时，200次调用产生200 queued/45,890B。输入同步队列的容量不能限制Host→Viewer诊断输出。该风险独立于14:07的13.8s停帧；缺少当时DC队列证据，不将其当作该次首因。

采用同步4096B字节准入，仅覆盖frame_timing、capture_stats、frame_trace_batch、loss_lab_host_trace_batch。对比16384B，本方案牺牲detail覆盖以减少输入通道中的诊断积压；对比另加5–10Hz限频，本轮不改变正常采样密度。4096B是工程预算，不是测得网络最优值或ACK时延上限。

## 契约

- 每次诊断使用同一份完整JSON字符串计算UTF-8字节长度并send。固定4096B，不增加配置项；单包超限直接整包丢弃，不截断/拆批/重试/缓存/等待/创建task/Socketfallback。
- send前当前候选DC必须仍等于host.get_input_datachannel()，readyState为open，send可调用，bufferedAmount必须为非bool、非负整数。任何缺失、异常、NaN/Inf/float/string/负数都fail closed；bufferedAmount+payloadBytes==4096允许，超过拒绝。最终检查到send同步无await，同事件循环调用。
- helper allowlist严格限定四类诊断；input_ack、input_frame_binding、clock_sync_resp、lab selected-pair/flush ACK完全保留原可靠路径。不能把它们静默丢弃、换路或重放。Quality Lock、媒体档位、输入协议和JPEG路径不改。
- bufferedAmount不覆盖SCTP已提交outbound/sent/retransmission数据及其它channel，可靠消息可使总buffer超过预算。本改动只限制可丢诊断本次准入，不承诺完整内存界、ACK优先队列或时延SLA。
- 固定类型/固定原因标量计数、饱和整数，不存payload/输入/身份/坐标；约5秒复用现有capture统计日志时机输出一份本地聚合摘要。无逐帧日志、无新增线程/定时任务。日志字段只含发送/丢弃数、原因数、legacy丢失个数；从未接受的指标不补零延迟。
- 每次frame_timing尝试都在原锁下取出并清空legacy pending IDs/data，即使Host/DC不可用、拥塞、oversize、send error；丢失仅计数量，不挂后续帧。frameId按尝试递增允许缺号；成功时现有wire字段/null含义保持。
- 两类trace各自send/各自计失败，第一份成功不能因第二份失败被误计丢弃。frame trace仅增加本批实际丢条数，既有累计droppedTraceCount不重复加。
- loss batch取出会清零已有droppedEventCount；丢批须归还len(events)+原droppedEventCount，下一成功只报告一次。先核对Viewer消费契约；若空events+dropcount可接受则发送计数批，否则归还计数等待后续事件，不扩消费协议。lab begin/flush/sourceWatermark/epoch不变。
- Viewer5秒新鲜度缺测继续available=false/数值null；capture_stats无独立TTL的现状明确保留，不声称由本增量修复。没有真实业务输入测量时input→visible仍NOT RUN。

## 验证与部署

定向回归验证实际方法+真实aiortc欠排空200次不会继续线性增长，字节边界、替换/关闭/异常DC、legacy清空、trace/loss丢失记账及可靠协议未受gate。无网络/原生输入/截图。独立task及跨层review后才同步本地Host并按服务helper重载；tunnel四文件不触及。正在运行诊断不加载新代码，避免污染证据。

## 已确认的测试契约补充

旧Python→Node trace集成fixture同时缺当前receiver/展示track/SSRC映射及frame-first前detail启用。独立四组合验证与完整原断言已确认只补两项fixture即可通过，不是本gate生产回归。Task3只同步该fixture、保持所有原断言/到达顺序，作为Task2部署前检查，不扩大生产改动。
