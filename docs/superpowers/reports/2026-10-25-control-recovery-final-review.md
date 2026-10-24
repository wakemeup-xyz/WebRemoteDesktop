# 2026-10-25 控制恢复最终复核

## 复核结论

当前Signal/Viewer `a88f7fecb2dc630ed7658c315acc71e4bed3f03b` / build `79d27719867d5814` 已在main提交并加载；Host Python仍为 `9e352fc8`，启动配置 `2e611d5`，不能将最新HEAD等同所有进程源码。五次原租约短断线、30分钟公网TURN被动连续性、连续两次心跳黑洞的路由功能测试、正常UI诊断保存均通过各自门槛。没有遗留阻断当前已发布恢复修复的必修项；整体性能和真实输入效果未全部通过。

03:17末次服务检查：本地与正式域名health均200/ok，Host在线，Viewer/relay Viewer均0；Terminal bootstrap enabled、会话池空闲。Signal15428、Host64981均Interactive。cloudflared6438的原启动时间未变，safe URL文件仍缺失，未操作tunnel。

## 独立复核发现及处理

1. **私有功能探针误判ring。** 首轮已完成原租约恢复，却将已消费旧事件的环淘汰当未读gap。仅修私有探针：真实cursor gap/capacity失败、truncated终点仍不得PASS。纯fixture三项先红后绿，独立重跑9.448秒恢复/30.023秒稳定。首轮INCOMPLETE及原SHA保留，未修改生产或canonical采样器来放宽门槛。
2. **文档历史状态残留。** 将“最新4826”“代码/配置未变”“即将加载”等限定到各自历史时点，顶层结论更新a88与分组件来源；保留旧自然lease-expiry和单次ACK误触发失败。没有把旧版本PASS搬到当前版本。
3. **capture最大值仍超目标。** 本长测18:52:33Z新增275.659ms慢grab，超过250ms上限；last-grab快照p95 47.252ms不是全帧p95，不能覆盖真实超限。已在诊断、实施记录、CPU归因和计划同步。
4. **覆盖语义纠正。** 五次恢复的continuity故意中断，不能称30分钟PASS；业务/可见效果NOT RUN。UI receipt的coverage.missing仅列可见效果，但legacy droppedFrames仍未知；ringDrop185属于Signal累计观测窗，不是该页面输入或媒体丢失。

复核采用并行只读审查：原始summary/lifecycle/逐秒样本、源文件SHA、Signal/Host关联与版本归属、资源统计、文档一致性及脱敏。新JSON与本机运行配置的非平凡secret精确匹配扫描无命中；原身份只用于内存关联，不输出密码、token、输入内容或坐标。

收尾检查：四份新JSON可解析，运行secret精确扫描0命中，所有变更Markdown本地链接可解析，git diff --check通过。仅同步文档和脱敏证据，不为文档提交重复重启或重跑重型产品回归。长会话快照的median/p95采用nearest-rank，偶数median为较低中间观测；复用窗口字段单位为帧数，非百分比。

## 验证矩阵

| 项目 | 实际状态 | 证据与边界 |
| --- | --- | --- |
| a88离线 | PASS | Viewer相关471/471、Signal完整576/576；HB28/28及真实诊断持久化链1/1。未把相关集称为a88全量Viewer回归 |
| 五次native direct-close | PASS | 每次5分钟/301点基线，原租约恢复3.994–5.000秒，再稳定≥30秒；Host/Server完整；故障刺激使各轮continuity为INCOMPLETE |
| 当前版本30分钟 | PASS：仅被动连续性 | 1,800.170秒/1,801点，missing/late/identity/path change=0，最大无进展666.6ms；600次心跳ACK增量无timeout/reject |
| 两心跳黑洞 | PASS：仅routed功能 | 精确两drop→真实watchdog→原租约正式rebind→30.023秒稳定；不等价native网络中断、业务输入或光学效果 |
| 诊断持久化 | PASS | 正常UI确认保存，81上送/0原文保留/81脱敏/9trace，唯一计数1报告；gap0、ring185单列口径 |
| capture与资源全部目标 | 未全部通过 | 本窗max275.659ms；Host RSS max540.465MiB，有回收但短idle后仍506.621MiB；缺少完整同窗CPU idle/独立swap差分、等负载后端A/B |
| 输入/可见效果 | 未通过或NOT RUN | 每轮两个reset关联的较大ACK405.5–496.3ms，高于200ms目标；真实DC业务输入和内容marker效果未运行 |
| 三小时/OS进程最终退出 | NOT RUN / 未观测 | 不用30分钟或cleanup API成功替代 |

## 证据与剩余执行

- [五次原租约恢复](evidence/2026-10-24-continuing-disconnect/heartbeat-two-miss-five-recoveries.json)
- [当前版本30分钟与资源](evidence/2026-10-24-continuing-disconnect/heartbeat-final-passive-30m.json)
- [心跳黑洞功能两轮](evidence/2026-10-24-continuing-disconnect/heartbeat-watchdog-functional.json)
- [最终UI报告及运行receipt](evidence/2026-10-24-continuing-disconnect/heartbeat-final-production-ui-receipt.json)

源文件保留本机，仓库保存脱敏标量与SHA；不会将历史测试隔离造成的raw删除/日志污染解释为正常保留策略，事故仍在[实施记录](2026-10-24-control-recovery-fix-execution.md)披露。后续按[计划](../plans/2026-10-24-continuing-disconnect-remediation-plan.md)先测公网/DC业务延迟及隔离GUI内容效果，再做等负载capture后端和长时RSS；不绕过输入隔离guard、不延长授权TTL、不擅自改tunnel。
