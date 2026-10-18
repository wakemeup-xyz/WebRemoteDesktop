# 重置 ACK 与普通 Viewer 恢复：实施记录

当前仅源码实施；运行仍为Hostc239482/e5927c7（76982）、Signal45287/build79，未加载本轮修复、未操作服务或tunnel。旧longA在36秒异常WS关闭的INCOMPLETE保留，首次网络关闭原因未知。

Host修复58fd7af已提交：复用原控制transition锁，让重复零Viewer清理等待同scope重置完成；仅在pending→applied且Signal/fullauthority、binding/Viewer与八项资源精确缺失条件满足时合并，否则保留有fence的普通清理。只修改on_viewer_status；真实supersession、ACK-after-cleanup和取消语义保持。

旧代码实际行为RED：旧PC/track已完成，首次应答仍为[]，预期applied；修复后聚焦34项/受影响118项纯测试通过（最终17.331s、exit0）。计数重叠不相加。独立Astra任务review PASS，完整事实见[实施与审查证据](evidence/2026-10-18-reset-ack-ordering/task-1-review.md)。两个测试fixture/路径错误不计RED；可能短暂并行的纯测试进程已披露，没有并发生产probe，不因此重复套件。

Viewer修复3046fdd已提交并独立审查PASS：只改requestControl、quiesceDisconnectedSocket、scheduleSignalingRecovery（12行增加/2行删除）。自动ACTIVE/noncontroller拒绝时保留waiting意图，仍不抢占；随后权威FREE花掉既有一次retry。切模式时退休旧timer且保留原startedAt/pending，旧回调只退休自身句柄，不能清新timer或更换新socket。未改1500/12000ms预算、控制权限或输入/媒体屏障。

两个真实决策RED均复现：普通current-owner在grace/reset完成后的实际connected→FREE序列发出0次acquire（应1次）；四种旧timer顺序在原12000ms期限没有重建当前socket。新case保留实际freeze结果，不沿用旧fixture强设FREE；普通代次来自真实内存server welcome，未伪造权限。最终18项聚焦和392项相关VM/内存handler测试通过（25.424700s、exit0，均reaped）；既有config500/DC/supersession故障fixture日志如实保留，没有Node Warning或未处理错误。具体setup失误与有效RED分别列出，不相加重叠运行计数。[Viewer实施与独立review](evidence/2026-10-18-reset-ack-ordering/task-2-review.md)。

本轮Task1/2源码任务及独立review已完成，最终整个38bfd..e393699基线增量Astra review已PASS（15条路径、canonical包154470B，SHAe4aa008f0ba809769913ca55e38c631401572871d190790ea3a285dea6e33601）；当前服务仍运行旧源码，不能宣称这些修复已经改善生产。后续独立guarded ordinary规格实现更严格的首次测试入场，随后一次组合加载Host/Signal/Viewer并验证真实普通恢复。保持原长测失败、原维护failed-or-indeterminate及完整进程树UNKNOWN。

业务原生输入、应用后帧、可见/物理效果仍NOT_RUN；不将源码测试、媒体推进或瞬时健康当用户全流程验收。两项Viewer源码缺陷可能解释普通用户持久输入中断/重连失效，但不能唯一解释longA最初WS1006。日志和测试范围独立记录；服务、tunnel与原有修改均未因本轮源码任务改变。

最终[整体源码review](evidence/2026-10-18-reset-ack-ordering/final-source-review.md)已归档；本计划仅源码交付完成，运行没有加载。交接给独立guarded普通准入/恢复计划，保留全部未验收状态。
