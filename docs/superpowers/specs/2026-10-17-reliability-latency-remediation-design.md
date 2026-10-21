# 网页、控制与端到端延迟整改总设计

> 执行状态更新（2026-10-17）：用户已授权开发、验收、启动并保持本地 Signal/Host 可用。实现与独立复审已完成，公网实测正在反馈修复；实际部署、通过项和剩余验收以[实施记录](../reports/2026-10-17-remediation-execution.md)为准。watcher/tunnel 保持原运行边界，未重启或重建。

日期：2026-10-17。状态：设计已审查并实施，真实验收进行中。默认采用 superpowers brainstorming + writing-plans；用户已授权本轮实现及本地部署，不重复询问规划流程。

## 1. 目标与证据

目标是消除短断后反复丢控制、网页恢复失败、媒体阻塞控制和误导性延迟指标，建立可以区分网页入口、输入确认、新鲜画面与实际可见效果的验收依据。

依据：

- [综合诊断](../reports/2026-10-17-web-entry-screen-control-diagnosis.md)：R1–R11、N1–N13、D1–D6。
- [耗时诊断](../reports/2026-10-17-transport-input-to-frame-diagnosis.md)：L1–L12。
- [最近72小时复查与方案review](../reports/2026-10-17-three-day-review-and-solution.md)：固定窗口为北京时间2026-10-14 02:15至2026-10-17 02:15，报告声明实际日志覆盖，不能把留存缺口算作健康运行。

当前“输入→画面”标签绑定ACK RTT，frame_timing又在编码前发送，不能作端到端指标。修正指标和控制正确性先于性能调参；生产资源压力必须作为独立变量记录。

## 2. 方案比较与选择

| 方案 | 收益 | 风险与取舍 |
|---|---|---|
| 零散调整超时、增大缓冲、重启恢复 | 改动少，可能暂时降低报错 | 无法修复过期ACK、旧状态回写和错误计时；增大缓冲可能增加输入延迟，不采用 |
| 保留传输架构，在现有状态机和处理边界分批整改 | 可以保留现有功能、逐项复现及回归，并独立验收 | 涉及多端契约，需共同定义身份、计时和兼容；采用 |
| 更换传输协议或部署新的公网基础设施 | 可能改变网络路径 | 无法直接解决本机阻塞与计时错误，新增部署/兼容风险，超出本轮范围 |

采用第二种。沿用 WebRTC、Socket.IO、H.264、现有控制租约和媒体恢复状态机，不新建第二套恢复控制器。三个子项目分开交付，各自有spec/plan；本文件规定共同边界和集成验收。

## 3. Global Constraints

以下内容须逐字复制到各执行计划的 Global Constraints：

1. 用户后续已明确授权本轮开发、验收、启动本地 Signal/Host 并保持可用；不得停止、重启或重建 tunnel。生产 Viewer 仍须避开正在使用的会话。
2. 后续实施沿用严格单桌面 Viewer、控制租约和 fail-closed reset 屏障；不重放投递结果不确定的点击、文本或命令。
3. 不自动切换网络模式、TURN 节点或公网地址；保留 Quality Lock，不自动降低用户选择的分辨率。
4. 生产 Viewer 验收必须有明确维护窗口；普通检查不得创建会抢占用户控制的 Viewer。
5. 默认不增加运行依赖；纯函数、fake-clock 和模拟适配器测试不得启动真实抓屏、输入或公网连接。
6. 缺测使用 null/unavailable；不以 RTT/2、跨机 wall clock、frame_timing 到达或ACK冒充实际单向传输或可见效果。
7. 日志不保存键码、文本、剪贴板、坐标、token、完整URL或原始输入ID；仅保存有界关联摘要、状态和阶段耗时。
8. 不运行会重建生产dist的 npm test/pretest；定向使用 node --test、unittest 或已有独立临时构建入口。
9. 未做的真实公网、设备、光学或长时间验收必须标为 NOT RUN，不以单元测试通过替代。
10. 每个任务只提交该任务的文件或明确选择的改动，不夹带任务开始前的无关修改。

用户后续已授权实施和本地部署，原仅诊断约束已解除；tunnel 操作仍须直接授权。

## 4. 子项目与所有权

| 子项目 | Spec | 主要责任 | 任务前缀 |
|---|---|---|---|
| 控制恢复 | [控制恢复设计](2026-10-17-control-recovery-design.md) | 租约续期、transition唯一性、Host并发提交、输入ACK失联、reset与媒体身份 | C |
| 媒体与延迟 | [媒体与延迟设计](2026-10-17-media-latency-design.md) | 同钟测量、因果帧关联、媒体线程隔离、输入背压、编码与捕获策略 | M |
| 网页与入口 | [网页与入口设计](2026-10-17-web-entry-observability-design.md) | 登录/资源恢复、巡检截止与冷却、自动诊断、前端热路径和资源观测 | W |

共享文件不并行合并：`host.py`、`webrtc.js`、`input.js`、`signaling.js` 由先完成的前置任务落地后，后续任务重新读取并基于最新状态修改。逻辑测试可并行；同一文件的生产适配在集成顺序中串行。

## 5. 控制身份与迁移契约

保留现有 wire 的 leaseId/leaseEpoch、connectionAttemptId、generation、seq；不向严格校验的输入v2 envelope直接添加字段。

- 每一次**新的**grant、revoke或reset-only transition都获得新的单调leaseEpoch；重试同一个reset操作沿用该操作epoch，维持幂等。grant变reset不得复用旧grant的epoch，迟到ACK只能命中原操作。
- Signal只在认证会话匹配、当前租约未过期、Host迁移成功且仍为当前待处理操作时确认rebind。确认时刷新租约期限；Viewer在重新获授权时立即心跳，再按原3秒周期发送。12秒租约、8秒grace、1500ms rebind ACK等待仍使用现有默认值，不通过单纯加长超时掩盖问题。
- Host的控制/offer/media操作使用共同的内部authority revision。await之前捕获权威快照及待清理对象，await之后以相同revision/epoch/attempt/generation校验再提交；过期完成只清理其自身资源，不覆盖新控制、新PC或新媒体状态。
- control epoch的单调比较限于同一认证Signal连接生命周期；Signal重启后的低epoch只能在旧工作冻结并完成静止/reset后接纳。内部authority revision不回退，旧连接的异步完成仍失效；不能缓存进程级最高epoch导致新Signal永久无法授权。相同owner下媒体generation单独验证，不以其变化无故淘汰控制输入。
- 新grant若与现存PC owner不一致，默认要求关闭旧peer并重新协商，不能仅更新active input后继续静默复用旧peer。任何可安全复用的同页迁移只能走正式rebind提交路径。
- 同租约重连可保留已确认序号，但不得保留已失败的reset作为可用屏障。Host拒绝/超时后，必须等权威reset确认，再有界自动重新申请；失败保持阻断并提供既有释放/重新申请入口。
- ACK回传不无条件重定向旧输入给新Viewer。先按发送时作用域和当前迁移状态判断；无法确认归属时废弃旧pending并完成新的reset/reacquire，不把旧ACK当新屏障证据。
- 媒体active ACK和新帧必须来自同一attempt/generation；切换时清空旧帧等待标记。legacy relay companion遵守同一rebind pending门禁。

这些规则由C子项目决定控制是否可用；M/W的诊断丢失、trace过期、指标缺测不得改变控制授权。

## 6. 耗时契约与证据等级

所有阶段使用产生它们的同一单调时钟。相减前必须具有相同scope和明确边界；统计不能相加不同阶段P95，也不能把总项和子项重复相加。

### 6.1 共同作用域

本地观测对象 `scope = {connectionAttemptId, generation, leaseEpoch}`；媒体另带 `streamId` 和必要的流重建标识。wire已有inputIds仅用于内存关联，落盘改为有界摘要。改变scope时取消旧pending、计入取消数，不能让迟到样本进入新窗口。

### 6.2 统一指标命名

| 字段 | 起止点与语义 | 证据等级 |
|---|---|---|
| frontendDispatchMs | Viewer DOM接收→实际传输提交 | 本地阶段 |
| inputAckRttMs | Viewer传输提交→匹配业务ACK处理 | 往返业务耗时，含各端调度及执行 |
| hostAdapterAwaitMs | Host进入输入adapter→adapter返回 | Host同钟总段，含内部排队 |
| hostQueueMs / hostApplyMs | adapter内部入队→获执行权／执行→完成 | Host同钟子段，无真实hook则null |
| signalForwardMs / signalAckForwardMs | Signal对应handler进入→发送接口提交 | Signal本地阶段，不是远端收到 |
| inputToFrameNoticeMs | Viewer发送→匹配frame_timing通知 | 通知指标，不能显示为可见效果 |
| inputToPostApplyFrameMs | Viewer发送→匹配“成功应用后新捕获”的呈现帧 | 只证明后续新鲜帧，不证明任意应用已经响应 |
| inputToVisibleEffectMs | Viewer输入起点→受控内容确认响应的匹配帧呈现 | 受控可见效果；普通生产无内容证据则unavailable |
| relayFrameAckRttMs | Host JPEG提交→相同frame ACK回到Host | 同钟反馈往返，含Viewer处理，非纯网络 |
| paintIntervalMs / freshFrameAgeMs | 连续呈现回调间隔／最后新捕获帧年龄 | 不与渲染执行成本混用 |

candidateRttMs、jitterBufferMs、decodeMs和recvBytes/elapsedMs分别展示。缺少校准与精确发送/接收边界时，单向网络耗时保持unavailable；RTT扣去配对的本地阶段后仅标“未分解剩余”，不能改名网络。

### 6.3 有界快照接口

M子项目提供 `LatencyMonitor.snapshot({nowMs, scope})`；W只调用该接口，不在诊断持久化重新计算阶段。返回：

```ts
type MetricSummary = {
  last: number | null; p50: number | null; p95: number | null;
  count: number; available: boolean; lastSampleAgeMs: number | null;
};
type LatencySnapshot = {
  schemaVersion: 3;
  scope: { connectionAttemptId: string; generation: number; leaseEpoch: number } | null;
  windowMs: 5000;
  metrics: Record<string, MetricSummary>;
  outcomes: { sent: number; acked: number; rejected: number; timedOut: number;
    late: number; cancelled: number; dropped: number; unmatched: number };
};
```

类型中的scope是运行时内部关联信息；W落盘必须沿既有redactor处理身份，不落原始敏感ID。metrics仅接受上表及明确列出的同钟媒体阶段；不接受任意键。pending、recent tombstone和samples必须有数量及时间上限，读快照时也清理。详细容量与超时分类由M spec定义，C的控制恢复超时不能依赖统计窗口。

outcomes是当前scope累计值，重复报告不能相加。scope关闭前先计入取消并保存终结快照；M提供`takeClosedScopeSummaries({nowMs})`，从最多4份/60秒/32KiB的辅助队列取出`summaries`及淘汰`dropped`，W清洗后记录为作用域结束事件，不能让取消数随scope切换静默消失。主LatencySnapshot字段不变。freshFrameAgeMs为即时gauge，count=1时p50/p95只是共享schema占位；UI与报告仅展示当前年龄，不把占位值解释为统计分位。

W提供 `buildRuntimeDiagnostic({reason})`，统一用于手动与自动路径；它消费上述快照、既有控制摘要、build身份和有限资源指标。持久化仅保留允许字段；不复用未清洗的原始对象。

## 7. 帧关联与媒体处理边界

- `_send_frame_timing`仅为通知，不能完成业务ACK pending。独立ACK能力按现有协议能力判定；不对现代Host执行legacy兜底。
- 仅成功应用的输入可进入帧关联候选；候选需保存Host appliedAt，捕获开始时间必须在其后。复用旧图像不能消耗候选，也不能伪造新的captureSeq。
- captureSeq→encoder timestamp→实际wire RTP timestamp→rVFC身份关联必须同attempt/generation/stream。元数据晚到保留已观察的Viewer帧时间，不能用join完成时间替换。
- 任意原生应用是否已经产生视觉效果不能由adapter返回推断。真实inputToVisibleEffect采用既有受控producer/marker和真实输入guard，禁止用独立本地overlay模拟输入成功；光学时延另行记录。
- JPEG捕获、数组转换和编码移出Host控制event loop。Tunnel relay 使用双阶段 bounded worker：MSS抓帧和JPEG编码分别由专属线程执行，每个阶段最多一个运行项和一个可替换的最新待处理项；编码当前帧时最多预取一个下一帧。帧完成返回前检查generation/suspend，过期结果释放并丢弃；capture/encode queue wait、耗时、p95/max、drop 和 coalesced 计数都进入有界快照。不无限提交to_thread；关闭时先停止提交并等待受控退出，MSS只由capture线程关闭，无法取消的原生工作不能在新会话继续输出。
- 可靠输入不能事后丢弃已编号down/up/text/reset。高频move/wheel的合并发生在编号/传输提交之前；队列满或无法维持顺序时冻结新输入并走既有reset/reacquire路径，不改写已应用序号。
- 不直接扩大硬编码资格范围。针对20/15/12 FPS及720p/1080p同条件验证codec、码率、质量和CPU/调度成本；不合格组合保留显式失败/建议，不因错误跨钟反馈降档。

## 8. 网页与入口恢复边界

401/403必须是应用认证明确失效才清理凭据；代理/网络/5xx/超时保留当前登录，给出有界重试。所有登录/verify/deferred请求有应用层截止和迟到响应隔离。脚本与CSS分别记录完成状态。

发布保留当前及至少上一版本哈希资产，并设置保留时限/空间上限；旧页面请求已淘汰版本时有安全刷新入口，不无限重复同一404。HTML缓存策略保持原有要求。

巡检的总等待使用真实单调截止；每个HTTP/子命令都有剩余预算，冷却从恢复动作确认结束时计。超时必须证明本次恢复helper/变更子命令已结束，否则保持in-flight/unknown并禁止下一次恢复；丢弃迟到结果不能阻止旧进程继续产生副作用。恢复期间独立采样，不把缺测记healthy。保留HTTP状态、失败阶段、探针代理路径和耗时，区分origin、正式入口、页面资源与业务状态；本轮不操作现有watcher或tunnel。

环境观测只针对本仓库和系统汇总：实际RSS、内存压力、swap-in/out差分、event-loop、线程/任务/队列数。不要将ru_maxrss当当前RSS，不按单次进程快照终止其他项目进程。

## 9. 验收与完成条件

### 9.1 正确性硬门槛

所有历史复现R1–R11、L1–L12必须各有可运行回归用例；同一因果链可共用fixture，但覆盖矩阵必须逐项映射。必须覆盖乱序、重复、丢失ACK、接近过期的rebind、旧异步完成、失败reset、暂停、重连、缺测、15分钟详细trace和元数据晚到。测试不能用实现字符串搜索替代行为断言。

### 9.2 性能目标与环境声明

历史目标保留：公网冷启动core interactive P95≤5秒、点击到信令P95≤3秒、点击到稳定非黑画面P95≤8秒；规定TURN验收场景Host event-loop P95≤50ms、业务输入ACK P95≤150ms；720p/1080p编码P95分别≤25/45ms。它们是验收目标，不是当前已达成或所有公网路径SLA。

性能运行先记录版本、路径、scope、分辨率/FPS、codec/bitrate、机器压力、采样间隔和输入类别。至少分正常资源、可控慢worker和现场资源压力；缺少真实样本时不得对外承诺端到端P95。正常资源720p/20FPS受控场景，以实际inputToVisibleEffect分布检验历史150–200ms稳态愿景，同时完整报告超时/丢失，未达标就保持未验收。

短时验证通过后安排至少3小时受控连续会话；按路径分别运行，不能把多个不同条件混成一个P95。长会话不得侵入当前人工Viewer。trace自身应先通过15分钟fake-clock流式容量测试，不应在102秒失效。

### 9.3 当前交付与后续实施区分

AGENTS 默认流程、72 小时审计、总/子 spec 与 plan 已落库；代码、构建和本地部署已推进至实施报告所列版本，公网验收继续逐项登记。只有完成对应行为回归、资源约束检查和真实验收的子项，才能把需求文档中的整改状态改为已完成。

本轮维护窗口已完成 30 分钟 passive 投屏连续性和 within-grace 短断线重绑定实测；业务输入到可见效果、物理显示和 Host 长会话 RSS 回收仍保持未完成状态。

### 9.4 运行证据收口

Signal 的 `/api/admin/observability/summary` 返回一个有界 evidence receipt。它只消费已清洗的诊断、heartbeat close 和持久化 summary coverage：`logCount` 统计诊断日志条数，`summaryGapCount/gaps` 反映摘要留存缺口，`ringDropCount` 反映 heartbeat 环覆盖，RSS/CPU/FPS/丢帧以及 `inputToVisibleEffectMs` coverage 缺测时保持 `null` 并列入 `coverage.missing`。ACK 或 decoder 计数不能替代可见效果样本；Signal 进程重启后内存窗口重新开始，持久化的摘要只作为留存覆盖证据。
