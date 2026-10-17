# 慢启动与 Host 日志隔离：实现复审与部署前核对

2026-10-18。对应 [spec](../specs/2026-10-18-slow-start-idle-io-resilience-design.md) 和 [plan](../plans/2026-10-18-slow-start-idle-io-resilience-plan.md)。本记录描述代码审查与离线证据；上线、连续性和真实输入资格须以实际部署后的独立记录为准。

| 范围 | 实现与证据 | 独立审查结果 |
|---|---|---|
| 初始媒体 Start 所有权 | 968b3da + c5b18b1；实际 Viewer 与实际 Input 的 >8s 延迟反例 RED/GREEN；相关379项、最终修订覆盖97项通过，存在重叠不求和 | 初审发现旧 reclaim 拒绝误终止新 Start、自动 refresh 恢复阻挡层；原实现者修复，定向复审通过 |
| Host 离线分类与 reset 完成 | 24a6ace；12项定向、199项相关纯离线检查通过，存在重叠不求和 | 通过；真实 reset-only applied→FREE 才写完成事件，不改租约、ACK 和重放语义 |
| Host 文件 I/O writer | ba198af + 8e9fc0f；真实 root logger 阻塞 sink 反例及纯 Python 回归 | 初审发现较新 flush 请求覆盖旧前缀，修复为完成前缀先 flush/publish，再取后续写入；修订定向复审通过，初版31项纯回归与修订16项相关覆盖均通过（重叠不求和） |
| 部署执行保护 | 私有 local-only wrapper，只用于本轮已授权操作 | 初审发现完整输入漂移、仅信任PID文件、helper无总截止三处缺口；修订后定向复审通过 |

## 跨层约束

初始媒体成功仍以当前可信新帧为准，完整 Input 门禁不放宽。8秒属于慢连接反馈；72秒为同一 Start 的有限主动媒体等待总预算，当前 PC 首次可信 connected 后12秒 paint预算受总余额限制。自动重试不重置总预算，隐藏/主动暂停只暂停剩余主动等待计时；既有成功会话恢复及 tunnel/JPEG 启动不改。终态、旧 owner、旧异步拒绝不得复活或终止新的 Start。

Signal 先区分真正旧 Viewer，再区分 Host 缺席与真正旧 Host；不产生合成ACK、待重放输入或新的授权。旧 fail-closed 日志是安全进入事件，不代表 reset 最终失败。过去 cleanup UNKNOWN 不能用新增日志补写为成功。

Host producer 只格式化并准入完整有界文本；64 queued + 1 in-flight，每行最多65536 UTF-8字节。一个 daemon writer 独占文件打开/写入/轮转/flush/close，生产线程和状态锁不执行文件 I/O。溢出/超限/失败/关闭/放弃使用固定饱和计数；flush与stop有界，阻塞中的 writer 可以仍存活并明确报告，禁止并行替换。保留日志路径、格式、结构化脱敏与10MiB+3默认策略；不新增 Host JSONL 路径。

标准库 logging.shutdown 对内部 handler 的隐式 acquire/flush/close 已纳入纯回归，未操作私有 logging 注册表。Host terminal finally 在生命周期和fatal日志之后显式收尾；测试只用AST，不导入Host或原生模块。ResourceSampler完整spawn隔离未混入本次变更，仍需后续同配置运行证据决定。

## 上线与验收门槛

最终整体审查 尚未执行，上线前必须通过。上线前冻结确切提交、备份并保留主仓HEAD/index、已有修改、四个未部署watcher文件、tunnel/watcher进程和quick URL状态。先在临时目录验证冻结 Viewer 的完整构建；Signal正常启动还会从同一源码重新生成资产，不改变其启动契约。仅重载本地Signal/Host，读取并回报当前两种密码，核对实际新进程、build、源码和在线状态。

再运行全新一次Start的正式300秒被动测试及独立长会话；不得合并短场次、复用proof或以旧版本通过替代新版本。实际用户连接优先。当前共享GUI不能安全隔离全局HID，真实input→visible仍需独立环境/用户设备的真实证据，不能伪造隔离标志、把ACK或下一帧称为真实可见效果。此次文件隔离只消除一个已确认的同步I/O边界，不证明所有历史停顿来自日志。
