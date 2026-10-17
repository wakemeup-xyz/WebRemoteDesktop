# JPEG 工作线程分段诊断设计

状态：设计确认，待实施。用户已要求持续开发、验收及维护服务；沿已选 brainstorming + writing-plans 流程直接执行，不再询问规划路径。只在隔离工作树实施，经独立 review 后受控加载。

## 证据与目标

最近一次 JPEG 验收在恢复后出现约 5.2 秒 image load/feedback 同时停止。最后可用 worker 快照只有 inFlightCount=1，不能区分 MSS/转换/JPEG 仍在工作，还是结果已完成但 Host 事件循环尚未接收。feedback 与 producer 共用协程，二者同时停顿不能直接证明网络故障。现有 encodeMs 覆盖捕获、转换、编码，不是纯编码时间。

为现有每 5 秒 host_event_loop_lag 的 runtime.queues.relayFrames 增加固定大小、单调时钟的阶段摘要。该任务只补齐能够直接区分上述两个边界的观测，不改变调度、线程、准入、profile、ACK、身份或停止行为。

## 方案比较

1. 采用 worker 既有 Condition 内维护少量时间戳，沿既有非阻塞 snapshot 及白名单输出。无新增采样任务、历史数组或逐帧日志，直接覆盖当前缺证据边界。
2. 全链路逐帧 trace 会扩大 Host/Signal/Viewer 协议与证据量，且现有 WebRTC trace 不覆盖 JPEG；本任务不采用。
3. 只读 queue.qsize 无法看见 writer 已取走的 batch，也不能区分 worker 两阶段；不作为本问题的替代方案。独立的传输积压缺口见传输审查，另行设计准入修复。

## 固定输出契约

只为 relayFrames 增加以下字段；inputReliable/inputUnordered 的格式保持不变。

| 字段 | 含义 |
|---|---|
| processorActive | 工作线程正执行 processor；布尔值 |
| deliveryPending | processor 已返回或抛错，完成回调尚未在 loop 执行；布尔值 |
| pendingAgeMs | 当前 latest pending 请求自提交以来年龄，无请求为 null |
| processorAgeMs | 当前 processor 自开始以来年龄，无 processor 为 null |
| deliveryAgeMs | 当前完成结果自 processor 结束以来等待 loop 的年龄，无结果为 null |
| lastQueueWaitMs | 最近一个实际开始请求从提交至 processor 开始的耗时，未开始过为 null |
| lastProcessorMs | 最近一个 processor 完成（含错误）的耗时，未完成过为 null |
| lastDeliveryWaitMs | 最近一次 loop 完成回调距 processor 结束的耗时，未回送过为 null |

所有时间使用同一可注入 monotonic_ns 时钟。合法 0 保留；缺失/非法/负值在输出白名单变为 null。持续阶段在 snapshot 时计算年龄，时间戳不输出。旧 generation 的正在执行/等待回送阶段仍占真实资源，invalidate 不得抹去它；这些是 worker 生命周期观测，不是当前作用域媒体成功证明。last* 不自动过期，不表示当前帧的耗时。

submit/latest 替换时更新 pending 的提交时刻；出队时计算 queue wait、转为 processor；processor 结束时记时长、转为 delivery；_complete 时记 delivery wait 并结束该阶段。丢弃、异常、invalidate 和 stop 必须保持真实阶段，不能伪造完成。所有字段固定数量，无图像、请求内容、坐标、token、原始身份及历史保留。

## 并发与生命周期

沿现有 Condition 锁保护；Host 读取继续使用 snapshot_relay_queue 的非阻塞锁适配，锁忙返回 unavailable。不得加入任何等待 processor 的诊断路径。worker 保持一个 running、一个 latest pending、16 MiB 单 JPEG 上限及 stop 2 秒的退休 worker 防护。所有已有 future、错误、generation 丢弃及 MSS 单线程语义不变。

## 验证及边界

离线实际 worker + fake processor/clock；手动延迟 loop 完成回调以证明 processorActive 与 deliveryPending 分离，测试 0、pending 替换、错误、旧 generation、stop、白名单及锁忙。不得导入/启动原生 Host 抓屏来代替该测试。

通过离线测试及独立审查后才加载；运行记录必须区分源码实现、加载、实际观测、连续性验收。该补充不证明此前停顿的唯一原因，不把处理/回送耗时称作传输或输入到可见效果耗时，也不解决 Engine.IO 队列字节积压。
