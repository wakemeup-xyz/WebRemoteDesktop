# 2026-10-18 运行续查：R5 Viewer 上线与验收工具清理缺陷

此报告记录2026-10-19 00:02 CST检查点；验收仍在继续，不能作为全部验收通过结论。此前实施记录为历史检查点。当前普通连接、异常恢复、三小时长会话、原生输入和真实可见效果分项记录，不能相互代替。

## 已修复并实际加载的 Viewer 问题

最新修复补齐鼠标移动的可靠通道兜底：可靠 DataChannel 已因 ACK 超时被隔离，移动专用通道又缺失或关闭时，移动输入原先仍可能被送到那条已隔离通道。代码现会拒绝所选隔离通道，让既有 Socket.IO 兜底处理；健康的独立移动通道、替换通道及4KiB主动丢弃语义保留。没有重放未确认输入，也未放宽租约、reset、质量、网络或超时门槛。静态缺陷不能单独证明每次历史失控都由它触发。

设计/计划为2026-10-18-move-quarantine-fallback-*；实现c802a68362459b46b84593c7e8921575e0783394。聚焦22/22、受影响553/553离线测试通过，task及最终增量review Approved。初始RED包含夹具错误，最终RED为9通过/13真实行为失败；细节见归档报告。首帧timer缺失字段修复及有界process-observation诊断已一起交付。

R5实际Signal-only重载在23:09 CST完成：Viewer build bb581651b422e400，builtAt1792336142126，core SHA6910769b4fc68e56f0520c329c6e7a725f363e004e16e5a6eed8c349d9570ed9。Signal33747/birth1792336141.182036；Host36877/birth1792322600.528357保持。Signal/Host代码来源仍为dfb15434e79da90b803b763c533836e16c080c71，不能声称Host加载Viewer提交。公开入口实际资源及Host对应关系已核验。

两次私有构建、实际资源review、精确30路径发布、实际重载与独立readiness均留下有界记录。实际primary knownregular1016，HEAD和index保持原值。保留旧Viewer构建de4ac13287760f3b及79bf9a5afea0458e。没有停止、重启或重建tunnel/watch；W2四文件仍未部署。重载后密码仅回报聊天，未写入版本文档。

## 最新真实5分钟记录：未通过验收

R5 sequence93750d2ec1ca42f35e838a96e58c6708，attempt ba047879c33f00f14b603780026ba53a。result SHA5ef3358f1a1ee0bb5ef72e816952c5874d0826c8795c67616ba0a85ff73a42b9，classification=failed-or-indeterminate，workerExit1，firstFailedStage=worker。314行含13启动及301基线观测，summary elapsed300.2765秒；无缺样、迟样、失败观测、身份变化，最大帧无进展183.3ms。整个基线scope稳定、socket/PC connected、inputAllowed=true。它只说明被动媒体与门禁观察，未执行业务键鼠输入。

最终导出成功、browserClose42ms成功、managerStop13ms成功，但其后1ms记录cleanup-incomplete。独立源码/library复查确认真实工具缺陷：runner在Playwright停止后移除会发送协议取消订阅消息的admission监听器。原始异常类未被保存，精确运行异常仍属未知；源码顺序与现象强烈支持该解释。ownedProcessExitEvidence=not-observed原本就是API清理契约，不是其本身导致失败。

父级记录7个已知进程均退出、0次signals，无额外诊断缺口；完整进程树退出仍UNKNOWN。worker阶段失败后后续正式校验未执行，不能用这些原始值把结果改为通过。历史currentReadiness.health的RuntimeError也可能来自严格闲置要求，不能直接认定服务离线。23:25 CST独立service helper观察Signal及Host活着、health正常、Host在线；这不抹除失败记录。

原attempt与nonce不重放，不推进同sequence下一场景。新的工具修正设计/计划：2026-10-18-ordinary-admission-teardown-*。只将detach纳入原8秒清理协调器，安排在最终导出后、关闭浏览器前；失败继续拒绝验收。工具实现380e4e4已完成，针对性8/8与相关166/166测试通过，独立task spec及quality review Approved。初次最终review发现一项首错归因P2，经2822441一次修正及组合反例验证后，定向最终review Approved。新代码针对性8/8、相关166/166（168.873秒、一次）通过。精确工具发布仍未完成，需要新工具身份和全新基线；服务未因此重启。

## 性能：画面流畅不等于截图新鲜

同一浏览器时钟的单次Start→Signal4577.8ms、Signal→首帧3303.0ms、Start→首帧7880.8ms。仅一个样本，不能当P95或稳定非黑画面/物理显示证明；Signal连接用时超过3秒目标，首帧接近8秒目标，仍有优化空间。

301基线样本callback增量对应19.393Hz；RTT范围30–153ms、采样均值36.196ms；jitterBuffer last样本3–15.6ms，decode last样本0.464–1.008ms/frame；decoded dropped为0。五秒窗口统计有重叠，未据其重建全程P95。frameAge1.2–118.9ms只是距最近callback，不是源像素年龄。

Host固定日志窗口为23:18:00–23:24:01 CST，实际选中953行；前缀快照上限6493640字节、SHA d82565cc60747b768f4b134e9ed03078339574738e301f4b97afb233987c1208。新抓屏滚动频率6.03–7.66Hz；分离的已完成输出报告窗口5871帧、复用4019帧，复用比例68.46%。最后滚动窗口367个闭合周期/59.698秒，周期平均162.665ms，其中grab28.207、postGrab0.365、实际pacing133.941、other0.153ms；请求pacing21.742ms，平均超出112.198ms。发布锁等待平均0.00378ms。

因此主要测得延迟落在捕获循环的等待/调度阶段；不能唯一归因为GIL、内核、QoS或省电策略。编码加权均值3.905ms/frame；进程CPU约一个核心29.43%，也不能证明没有线程争用。下一项是独立有界pacing诊断，必须先有新的成功且未采样基线，当前失败记录不满足前提。

六项输入耗时inputAckRttMs、hostQueueMs、hostApplyMs、hostAdapterAwaitMs、inputToPostApplyFrameMs、inputToVisibleEffectMs均无可用样本，保持null/NOT_RUN。RTT不能除二当单向传输；门禁开放不能替代实际输入成功；真实可见效果仍需要独立Mac/macOS桌面的受控验收。

## 失败历史与下一步

旧两次实际基线失败分别为启动schema/首帧timer缺测，均保留。R3未执行部署。R4两次私有构建通过，但实际离线整合checker因参数遮蔽失败，未复制源码、未重载；已过期窗口不延长。R5新checker修正经过独立review，实际纯离线整合4方法/2接受/10拒绝/1262行通过，再用全新窗口和实际资源review完成部署。R4失败不被后来的成功替换。

下一步依次是工具清理修复及独立review、精确工具发布且不重启服务、新鲜闲置下从零基线、8秒grace内外恢复、三小时连续性；pacing诊断和原生输入延迟分别有独立证据范围。没有人工测试结果就不宣布真实远程控制已彻底验收。原生输入采集器spec/plan仍是私有待复审草稿，未实现/部署；独立桌面资源问题尚无答复，不绕过guard。

全部归档摘要/review及SHA见evidence/2026-10-18-runtime-continuation-r5/evidence-index.json。原始运行记录、日志与一次性操作目录保留在本机私有目录，不包含在文档正文。

补充：原生输入耗时采集器v3的spec/plan现已归档到仓库，并通过限定草稿/离线接线范围的独立复审，尚未实现或部署，独立桌面资源仍未提供。23:47截止的晚间72h初稿独立review发现Signal多行分帧方法错误，已标记无效草稿并保留原件；修订v2正在进行，其计数不得当成已完成的最新诊断。此前17:14截止的历史滚动审计保持原时间窗。
