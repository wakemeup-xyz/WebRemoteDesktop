# 重置 ACK 与普通 Viewer 恢复：实施记录

当前仅源码实施；运行仍为Hostc239482/e5927c7（76982）、Signal45287/build79，未加载本轮修复、未操作服务或tunnel。旧longA在36秒异常WS关闭的INCOMPLETE保留，首次网络关闭原因未知。

Host修复58fd7af已提交：复用原控制transition锁，让重复零Viewer清理等待同scope重置完成；仅在pending→applied且Signal/fullauthority、binding/Viewer与八项资源精确缺失条件满足时合并，否则保留有fence的普通清理。只修改on_viewer_status；真实supersession、ACK-after-cleanup和取消语义保持。

旧代码实际行为RED：旧PC/track已完成，首次应答仍为[]，预期applied；修复后聚焦34项/受影响118项纯测试通过（最终17.331s、exit0）。计数重叠不相加。独立Astra任务review PASS，完整事实见[实施与审查证据](evidence/2026-10-18-reset-ack-ordering/task-1-review.md)。两个测试fixture/路径错误不计RED；可能短暂并行的纯测试进程已披露，没有并发生产probe，不因此重复套件。

另两个独立确认的Viewer缺陷已明确加入spec/plan、待Task2实现：普通恢复在grace/reset完成后被本地旧ACTIVE状态挡住，未登记等待FREE的控制意图；以及断线切模式后旧watchdog句柄未退休，阻止新socket恢复计时。前者不通过开启takeover解决，后者不重置原elapsed budget。现有输入/权限/重置/媒体fence保持。

本轮源码最终整体review尚未完成。后续单独guarded ordinary规格负责安全首次入场和真实普通恢复资格，最终只做一次经审查的Host/Signal/Viewer组合加载。业务原生输入、应用后帧、可见/物理效果NOT_RUN；不将源码测试、媒体推进或瞬时健康当用户全部验收。
