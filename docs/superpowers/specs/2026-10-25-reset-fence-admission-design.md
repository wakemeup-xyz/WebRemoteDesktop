# Reset 序号屏障与外层排队观测设计

日期：2026-10-25（Asia/Shanghai）。承接用户继续优化授权；实施与验收分别记录，不重建或重启 tunnel。

## 新证据与目标

- 规划开始时基线：Signal/Viewer/Host 为 `6312429`，Viewer build `c6915df5ba8c0c6f`；main `1363bcb` 仅追加文档，工作区开始时干净。实施后的分组件加载状态见[运行复核](../reports/2026-10-25-reset-fence-admission-review.md)。
- 上轮健康 reset RTT p95 约276ms，Host/产品处理远小于总等待；不能把剩余时间直接称为单向网络。当前公网出现一次502，cloudflared同分钟记录origin EOF，随后canonical health恢复200。本地/Host始终在线，原因尚未完全定位。
- 纯模型复现：普通写入seq1成功；reset seq3返回sequence-gap；迟到普通seq2成功；rewind后的新reset seq2返回duplicate。这不是reset实际执行成功的证据，可能误开安全屏障。无native、浏览器或服务输入参与该复现。
- 减少缺口恢复所需的额外拒绝/重试往返，并消除将另一操作的重复序号误认为reset完成的情况。健康网络276ms本身不因这项修复保证下降，不更改RTT口径。

## 方案比较

1. **选定：mouse reset采用单调序号屏障，成功后才提交。** 与现有keyboard reset允许跳过未到达序号的语义对齐；普通mouse/command仍必须严格连续。只有当前lease、执行锁内完成native reset且原commit fence有效，才能提交屏障序号；晚到的较小普通序号不执行。
2. **增加请求竞速协议：本轮不实施。** DC/Socket双发需完整cutoff、能力握手、执行去重及旧普通消息隔离；只加reset generation不足以保证安全。保留唯一Socket reset请求及既有ACK镜像。
3. **继续rewind或把duplicate当释放成功：拒绝。** 会保留已复现歧义；延长barrier不减少往返。

## 执行与证明契约

- `ReliableDesktopWriteState.validate(data)`仅对有效mouse reset允许seq大于last+1；不提前推进序号，不改变普通写入及unordered move。
- 新增`commit_reset(data)`，在实际native成功且authority fence通过后调用；重新核对lease/seq，提交reset序号。原`commit(sequence,...)`仍只提交连续普通写入。
- 每个mouse/keyboard状态仅保留一份最后成功reset的有界内存证明：seq及合法有界input ID元组。它不写日志或snapshot，lease/epoch transition清空。
- `seq <= lastApplied`的reset只有与已成功提交的reset证明完全相同，才可返回duplicate；不同ID、与普通操作碰撞、缺失证明均返回已有`resync-required`，不执行native、不镜像正向ACK，不恢复控制。普通写入的既有duplicate语义不变。
- 失败native、stale authority、旧lease不能产生或更新成功证明。keyboard已有跳号reset保留，补相同证明规则；legacy输入路径不扩大授权。
- 独立复核补充：mouse释放失败不能在finally无条件清掉tracking，否则下次重试会误称已经释放；只移除确实成功释放的按钮。keyboard显式reset、生命周期reset及transition若仍有未释放按键，必须返回失败，transition不得安装新lease。测试仅fake native，不操作真实按键。
- InputHandler在同一执行锁内validate，等native返回并通过commit fence后，reset调用commit_reset，其他可靠输入仍commit。失败不消耗屏障序号。
- 兼容适配器的host-owned序号也只随applied且原commit fence有效时推进；失败reset不得使后续普通keyup永久落入sequence-gap。显式reset和transport切换两条路径均须验证。

## 外层计时

- 保留`hostQueueMs`的adapter内部意义，新增仅Host脱敏结构化事件的`hostAdmissionWaitMs`：`InputAdmissionQueue.submit`已存的perf_counter_ns至`_execute_input`入口。
- 从现有`input_queued_ns` ContextVar读取；缺失、非法、负值/倒序为null，不补0。只附到既有低频`host_input_received`摘要，不另建逐消息任务，不记录正文、坐标或原ID。
- 不新增Viewer/Signal协议字段，不改变队列顺序、执行、ACK、旧指标或控制授权。Signal本地bracket本来已包含这段，不能把两段相加。

## 验证与运行

纯模型与AST fake-native测试覆盖跳号reset一次提交、晚到普通输入无native、失败/旧authority不提交、普通gap不放宽、同ID已执行reset可duplicate、不同ID碰撞不能成功、transition清证明，以及排队计时合法0/缺失/倒序/隐私和高频聚合。

按修改范围做Python定向回归和独立review；客户端未改时不重建生产dist、不重复前端全套。main提交后，仅无Viewer维护窗口通过服务helper重启Host，保留Signal/Viewer旧加载版本并分组件记录。做20对正常reset、一次正式短断线及五分钟前置采样；不向生产注入乱序业务输入。公网502/EOF单独如实记录，不因恢复公网而操作tunnel。

业务输入到可见效果、物理显示、三小时连续性与公网200ms SLO仍须独立证据，不以这项恢复往返优化宣布通过。
