# Guarded ordinary recovery：运行执行与当前诊断

2026-10-18，时区 Asia/Shanghai。本报告按 root 已保存的执行账、两次实际 baseline 结果及独立诊断更新事实；本次文档整理没有新增测试、浏览器、网络、进程或服务观察。最新运行边界采用 root 约21:07的已有本地状态记录；以下为新Viewer发布前的固定检查点。

本检查点的[证据索引](evidence/2026-10-18-ordinary-continuation/evidence-index.json)、[实际短会话性能复核](evidence/2026-10-18-ordinary-continuation/second-baseline-performance.md)、[首帧状态独立诊断](evidence/2026-10-18-ordinary-continuation/first-frame-gate-assessment.md)和[进程覆盖复核](evidence/2026-10-18-ordinary-continuation/process-coverage-assessment.md)已纳入版本管理。源码修复与 review、后续实际加载和运行结果分别记录。

**组合产品已于约19:23 CST实际加载；普通恢复和新三小时会话仍未验收。** 已部署产品为 `dfb15434e79da90b803b763c533836e16c080c71`，Signal **36845**、Host **36877**，Viewer build **de4ac13287760f3b**。首次实际 baseline 在 Start 前被工具schema拒绝；工具修正及fixture修正已到 **59bca14**，离线producer/consumer实际通过并完成tool-only推广，未重载产品服务。第二次实际 baseline已验证UI Start并持续采样47.306秒，但38条input-ready startup行的首帧timer投影均为null，不能转入合格baseline，仍为0合格秒/0合格样本。timer产品修正已在 **cdea282** 完成并通过任务及最终独立review：4项回归、348项相关测试通过；**尚未部署**。上下文诊断模块 **2ccb4ce** 经review发现并修复重入容量边界，**35c6f97** 的29项纯测试及任务/最终独立review通过；真实原版Registry对照和新build仍未执行，不能提前宣称运行验收通过。

此前[guarded 源码与回归记录](2026-10-18-guarded-ordinary-recovery-review.md)、[reset-ACK 实施记录](2026-10-18-reset-ack-ordering-execution.md)中的“尚未部署”描述属于各自源码阶段。本报告只用19:23实际加载事实更新其部署状态，不改写其测试范围、历史失败或未验收结论。14:32旧 Host、新旧短测与旧三小时 PASS 也不能代替当前组合版本的验收。

## 已修复和已加载的范围

| 范围 | 已建立的证据 | 当前限制 |
|---|---|---|
| Host 重置 ACK 竞争 | `58fd7af` 复用原 transition 锁，重复零 Viewer 清理等待同 scope 重置；保留完整 authority、binding、资源缺失和 ACK-after-cleanup 条件。有效行为 RED、相关纯测试和独立 review 已保留 | 修复的是断线后清理/恢复延迟，不解释更早的首次 WS1006 |
| Viewer 普通恢复意图 | `3046fdd` 在自动 ACTIVE/noncontroller 拒绝时保留 waiting 意图，让后续权威 FREE 使用既有一次 retry；不抢占、不预开输入 | 真实 within-grace、after-grace 恢复尚未通过 |
| Viewer signaling watchdog | 退休旧 timer 时保留原 startedAt/pending 预算；旧回调只能退休自己的句柄，不能阻塞当前 socket 的 rearm 或清掉新 timer | 源码回归覆盖不同旧回调顺序；实际网络模式切换不在本轮运行验收结论内 |
| Guarded 普通首次准入 | issue/consume 同时检查 vacancy、epoch、Host 和人类意图；保留人类 owner/待用票优先、现有普通 resume 和 strict proof 非恢复语义；第二次baseline已验证一次真实guarded UI入场 | 一次入场成功不等于300秒baseline或真实恢复通过 |
| 启动、日志和有界观测 | 前序已部署修正包括 verified-Auth warmup、受限 ready 缓存复用、Host 日志 I/O 隔离、资源采集边界、抓屏发布代次与清理 invocation 观测；本次增加普通会话启动/日志关联和保守资格化工具 | 不把日志可读、readiness 或媒体推进提升为业务输入、内容因果或物理显示证据 |

Host/Viewer 修复的细节与有效 RED/GREEN 见[reset-ACK 证据](evidence/2026-10-18-reset-ack-ordering/final-source-review.md)；guarded 范围见[设计](../specs/2026-10-18-guarded-ordinary-recovery-design.md)及[源码证据索引](evidence/2026-10-18-guarded-ordinary-recovery/source-evidence-index.json)。前序运行记录分别保留[日志隔离](2026-10-18-slow-start-idle-io-rollout.md)、[资源采集隔离](2026-10-18-resource-isolation-execution.md)、[verified warmup](2026-10-18-verified-warmup-execution.md)和[抓屏/清理](2026-10-18-host-cadence-cleanup-execution.md)的原始版本、窗口与限制；这里不重新宣布其全部历史验收完成。

## 本次实际加载、入口与健康

root 记录精确组合候选及14项 Viewer 资源图，私有构建和实际启动构建一致，build 为 `de4ac13287760f3b`。本地 apply、reload、readiness 返回0；两次新观察给出 `runtime-ready-observed`，实际 Viewer 构建时间在受控窗口内。Signal birth 为 `1792322598.169719`、Host birth 为 `1792322600.528357`。本次只重载本地 Signal/Host，**tunnel 和 watcher 保持**；没有重建公网入口。两种运行密码已在加载后从本机配置读取并单独回报，不写入本报告。

加载前实际纯 producer/consumer 集成已完成：离线 fake 结果2128行、accepted 1、rejected 6，exit0。它补齐旧源码阶段 `NOT_EXECUTED/PENDING` 的工具连接记录，仍不是生产连接或输入验收。此前 Node 初次608项的584通过/24失败与修正后307项、Python160项、root loopback8项的分次事实继续保留，不能改写成一次新的608/608 PASS。

公网正式入口有两项已测差异，均保留其范围：

- 相同 health/status 路径，Python 默认 UA 返回403/Cloudflare1010；只切换为 Mozilla UA 后，在默认代理和 direct 两种路径均得到200。这建立的是**客户端差异**，不证明浏览器连接的失败原因，也不解释旧 WS1006 的第一跳。
- 公网 HTML 含已识别的单处 Cloudflare footer 增量；root 只读入口 attestation 在精确核对所有应用字节、当前 build/core 和本地/公网 Host 一致性的前提下识别该有界增量。此前严格整页字节比较的失败均保留，未因此改产品、网络、tunnel 或安全配置。该核对不证明边缘脚本行为、输入或画面性能。

工具修正源码完成后，另一次正式 health 读取为 `ok`、exit0，范围明确为 `single-formal-health-read-not-connection-acceptance`。root约21:07已有本地核对记录仍为Signal36845、Host36877存活，health=true、Host在线，产品/build仍为dfb1543/de4ac13287760f3b。**这些瞬时状态不证明持久 WebSocket、控制权恢复、真实输入或长会话通过。**

## 首次 baseline：工具启动拒绝，尚未测试产品恢复

原 R6 运行及其已消费 one-use marker 保持不可变，不清标记、不重放、不用新结果覆盖：

| 事实 | 结果及含义 |
|---|---|
| 首个失败 | `startup/schema-rejected`，发生在创建唯一 UI Start action 之前 |
| 合格 baseline | qualified duration **0**、qualified samples **0**；没有完成300秒 baseline |
| 保留行 | 两条 terminal wrapper，均 `sample:null`；无普通会话/socket/admission 关联 hash，无选中 server event |
| 普通恢复 | scenario 未请求，**NOT_RUN**；没有 after-Start admission/恢复失败证据 |
| 退出 | worker exit1，supervisor exit2；未超时；browser close和manager stop API成功，但导出/cleanup总体不完整 |
| Host | 保留的不可用/不完整覆盖可由拒绝页面样本后保守污染覆盖的路径产生；未观察到 Host disconnect，不能据此称 Host 故障 |

源码已直接建立 producer/consumer 不兼容：新页面的 `currentConnectionAttemptId` 初值是空字符串，`latencyScope()` 和未改动的 native sampler 原样返回；ordinary runner 原先对每个非 null attempt 执行非空 ID 校验，首个 tick 因而可在 Start 前拒绝这一合法“尚无尝试”状态。现有 fake 初始状态却已带有效 attempt，漏掉了真实启动状态。

这足以解释观察到的失败类型，并已形成针对性行为 RED；**旧失败未保留被拒绝的 raw sample，因此不能宣称空字符串是该次运行已直接捕获、排他成立的字段级根因。** 没有 PC 的 unavailable transport、空 session/socket/admission、generation/lease0等初值本身不构成产品断线；它们也不能开始合格计时。

### 清理覆盖必须单独保留

supervisor 的七个**已登记** owned identities 最终全部记录 `exited`，signal attempts为0。与此同时，扫描保留 `observation-unavailable`，完整进程树退出仍为 **UNKNOWN**。这既不证明遗留进程，也不证明所有 descendant 都曾被看到并退出。

该旧记录把 NoSuchProcess、AccessDenied 和 OSError 合并为同一标签，没有调用点、阶段、计数或时间，无法事后确定是退出竞态、访问拒绝还是其他 OS 错误。原最终验证先因 worker incomplete 失败，后续 coverage、finalRuntimeIntegrity 和 postCloseOccupancy 检查没有执行；后两项保持 null，不能由当时健康/Viewer0/relay0替代，也不能声称 coverage gate已实际跑完并通过。下一次更干净的退出同样不能追认这次完整清理。

## 工具修正：59bca14已推广，产品未重载

[startup sentinel spec](../specs/2026-10-18-ordinary-startup-sentinel-design.md)及[plan](../plans/2026-10-18-ordinary-startup-sentinel-plan.md)限定四路径修正。工具 revision **800ae47** 仅在 ordinary runner 边界复制样本并把已知空字符串 sentinel 变为 null；未改 shared sampler、strict helper、supervisor、产品服务、权威/媒体/输入门禁或 deadline。非空 ID 的严格校验仍在，空值不能变成假身份。

保留的有效 RED 是真实形状的 pre-Start 样本被旧代码拒绝；当时GREEN证明该初始观测仍被保存、只触发一次 fake UI Start、未就绪时间不计入300秒，后续/最终导出缺失 attempt仍不能保住 PASS。四项聚焦 GREEN 与109项 scoped suite通过（30.663秒、exit0），任务及最终review在各自时点 **Approved、无findings**。这些是 `pure-injected-only`，`liveAcceptance:false`；后续发现不能抹去历史通过，也不能由历史通过豁免新的集成阻塞。

后续R3外部 producer/consumer checker 的静态准备发现：正向fixture在故意保留的post-Start未就绪startup行里设置 `inputAllowed=False`，却保留 `inputGate.allowed=True`。未改动的R6 consumer要求每一行这两个字段一致，包括startup行，因此会拒绝这一实际持久化形状。源码自身结构validator没有覆盖该跨字段关系，109项GREEN不能证明R6兼容。精确出现次数仍依赖调度；这是已建立的静态fixture矛盾，不是实际执行结果，也不否定空attempt规范化或证明新的真实连接失败。

原runner owner随后在 **59bca14209eed299b0e94da58decb8b85e5ce70c** 完成仅测试fixture修正，四项覆盖测试通过（5.009秒、exit0），限定review为 **ADDRESSED / Approved**。runner空attempt规范化、已部署产品及R6 consumer均保持不变。R3 checker继续保留为 **prepared / NOT_EXECUTED**，没有其自身运行结果；不能给历史R3补写计数。

重新绑定59bca14的R4 checker经独立review后实际执行：**4 methods、2 accepted、10 rejected、1262行，exit0，5.169秒**，未超时、未发送信号、直接child已reaped。范围是 `fake-only-native-shaped-producer-consumer-not-runtime`，不与早先R2的2128行/1接受/6拒绝拼成新的独立覆盖总数，更不充作真实连接验收。

root随后使用单独review的R2 continuation包完成 **tool-only推广**，分别pin产品dfb1543与工具59bca14；没有Signal/Host重载或tunnel操作，并在新的one-use记录下执行第二次实际baseline。首次失败和旧marker保留不可变。空attempt兼容问题及fixture阻塞已在各自范围关闭；第二次运行暴露的是下述真实产品timer状态契约问题，不得用再次放宽工具门禁掩盖。

## 第二次 baseline：实际入场成功，timer状态阻止资格化

第二次实际运行绑定产品dfb1543、工具59bca14和build de4ac13287760f3b。UI startup记录为 **verified**：fresh page、auth verified，Start前0个mark、后1个mark，且恰好一次guarded API请求。它已实际进入connected、持续H.264/relay UDP画面并出现 `inputAllowed=true`，不是又一次pre-Start schema拒绝。

| 本次记录 | 结果与解释 |
|---|---|
| 观测范围 | 51行：50条startup加1条terminal，elapsed0.017288–47.306001秒；**47.306秒不是首帧时间或通过会话时长** |
| 首个input-ready行 | elapsed10.267321秒；从此到47.286140的38条startup行，其余startup资格predicate全部满足；37对回调计数均推进，最大采样间隔1.005011秒 |
| 唯一剩余startup门禁 | `firstFrameTimerHandlePresent=null`，而严格门禁要求已知False；terminal也保持input-ready和相同null投影 |
| 画面/身份 | 最后rVFC731、decoded733；39个有画面行含terminal，PC/generation/lease不变；Host observation51行stable/complete |
| 断线观察 | 此窗口未观察Host disconnect，诊断未记录firstDisconnect；诊断partial、dropped13，不能升级为所有阶段/跳点完整覆盖 |
| 资格结果 | `startup/baseline-incomplete`、worker exit1、未超时；**INCOMPLETE，0合格秒/0合格样本**，没有300秒baseline或恢复PASS |

早期无帧、控制未就绪或media-pending行仍有多个门禁未满足；“唯一timer阻塞”只适用于上述38条真实input-ready startup行，不能套用于整个启动过程。此时业务输入未被发送，因此也不能把实际inputAllowed=true称为用户输入成功或控制中断复现。

独立源码/证据复核建立了具体产品状态缺口：WebRTC singleton未声明own `_firstFrameTimer`；普通非tunnel启动使用 `_startupEpisode.timer`预算并提前返回，legacy `_firstFrameTimer`可能从未分配；清理方法仅在其truthy时写null。因此真实paint和input readiness已完成，legacy timer仍是缺失own property。未改的sampler正确把“缺失属性”投影为null/unknown，不能替它推断False。

最小修复是从真实产品构造起明确 `_firstFrameTimer:null`，让不存在handle成为已知状态；保留sampler的unknown区别、严格timer门禁和8/72/12秒预算。不得在观察安装器/fixture中补字段、删除门禁、延长45秒观察期限或强行分配第二个deadline。规格/计划 **edc25ae** 后，产品修正 **cdea282** 仅新增真实对象own null初值；实际WebRTC/Input→未改sampler的4项回归已取得有效RED/GREEN，348项相关测试通过，任务及最终review Approved。测试覆盖初值、真实启动预算分支、legacy arm/clear和缺失属性unknown，不把Input blocked改成ready。**新资源尚未构建/加载**；需新资源字节核对，再受控重载Signal并核对原Host重连，无须因Viewer状态声明重启Host。

### 第二次清理覆盖仍未关闭

七个已登记owned identities最终 `exited`，0signals，但仍有 `observation-unavailable`，完整进程树退出 **UNKNOWN**。新增诊断池的32条保留事件全部是同一已退出登记身份的resolve/NoSuchProcess，之后 **291条被丢弃**。正常liveness检查和真正scan异常共用池，且缺少Registry调用点上下文，重复正常退出解析可耗尽容量；这些事件不能精确指认导致coverage标记的异常。

因此不能把该次扫描缺口宣称为已证明的普通child退出竞态、某个AccessDenied或特定OS错误，也不能证明有泄漏。实际validation-stage记录为rows passed、worker failed，coverage/signals/diagnostics及后续integrity/terminal检查均not-evaluated；unexpected coverage仍会独立否决资格，但不能说该gate已运行。`finalRuntimeIntegrity`、`postCloseOccupancy`仍null，next-run admission未建立，服务健康不能替代这些字段。两次已完成失败都保留；新的诊断设计只能解释未来运行。

## 可靠性与延迟：已知问题和未知部分

历史新 Host longA约36秒即发生 native WS1006/transport-close，媒体仍推进而 socket/lease/input gate关闭，严格连续性 **INCOMPLETE**。首个异常关闭先于测试清理；服务端后续 transport-close时间不能确定首次发起方，当时也不是已证明的 ping timeout。随后约8秒出现的 ACK 清理竞争是独立、已修复的恢复问题，不能倒推成最初断线原因。普通恢复修正已部署，但尚无本版本实际恢复结果证明其效果。

最近72小时证据仍采用已固定半开窗口 **2026-10-15 17:14:25.468476 ≤ t < 2026-10-18 17:14:25.468476 CST**，没有因本次部署擅自滚动或补采。详见[rolling72h](evidence/2026-10-18-guarded-ordinary-recovery/rolling72h.md)及[summary](evidence/2026-10-18-guarded-ordinary-recovery/rolling72h-summary.json)：

- Host原始前缀缺 **43h48m41.583s**；114条结构化 close为86 Viewer/28 Host，混合版本、维护、探针及未知归属，不能称114次用户事故或完整72小时事故率。
- 已保留历史 direct loop lag最大 **40126.976ms**；旧 input worker-await **8646.9ms**，与structured adapter-await **1791.2ms**来自不同测量边界和人群。它们是实际历史异常，不是当前产品P95，也不唯一指向编码CPU、OS、GIL或网络。
- 357条 upload summary缺少可用去重身份，不能称357份独立报告；保留64条receipt，窗口尾部 **19h04m58.464s**没有receipt细节。缺失不等于无用户、无报告或健康。
- 16:20:22–27的connector记录支持一次低层边缘连接恢复；16:23 formal探针失败后16:24恢复，不证明whole-tunnel重启，也不能解释15:01第一次WS关闭。

当前组合加载后的有界 idle context为 **19:40:49.520815–19:51:14.533308 CST**：114条Host loop记录，direct lag最大 **135.606ms**，最后direct **4.352ms**、最后rolling max **5.619ms**；最后输入计数0、PC为none。这是空闲上下文，不是有输入/媒体负载的性能验收或完整延迟分布。

抓屏和内容新鲜度仍有已证实的历史性能限制：旧shortA成对抓屏间隔1595.024ms，其中grab1586.578ms；同次CPU36.211ms、非CPU差值1550.366ms。B/long也保留698.717/407.989ms grab和约5.98–10.35Hz的active滚动抓屏速率。更早三小时虽然约19.5 output FPS，约59.1%输出复用了旧内容；rVFC持续不能证明同速率的新桌面内容。不能把这些历史非CPU差值直接归因某个系统组件。阈值日志、重叠rolling max、window P95均不能拼成全会话P95。

### 第二次baseline的active性能：真实新抓屏明显低于输出FPS

新性能复核使用同一次51行样本，并把Host日志严格限定为 **20:38:10–20:39:12 CST**，没有用idle数据代替active。一次Start到first-frame的同浏览器时钟mark差为 **8601.6ms**，阶段为bootstrap905.5ms、bootstrap-ready→signal-connected3646.8ms、signal-connected→first-frame4048.9ms。它是一项超过8秒目标的偏慢观察，不能称首帧总体P95，也不证明非黑或原生可见效果合格。首个有帧input-ready采样elapsed10.267秒与8.6016秒mark采用不同零点，不能互换。

| 本次边界 | 有限实测 | 结论和限制 |
|---|---|---|
| 新抓屏节奏 | 242个闭合开始间隔覆盖37.267448秒，**6.4936Hz**；平均间隔153.998ms，目标最小间隔50ms | 只覆盖本轨道的闭合前缀，不是全长会话；新内容更新明显慢于20fps意图 |
| pacing | 平均请求22.391ms、实际125.838ms、超额103.447ms；最慢同周期pacing426.605ms、请求23.456ms、超额403.149ms | 已证明sleep括号返回迟到；尚不能区分调度、唤醒/计时器合并、GIL或其他宿主原因 |
| grab/发布 | grab平均27.710ms、最大109.404ms；publish lock平均0.00382ms；最慢整体453.249ms周期的grab仅25.248ms | 此次主要可见缺口在pacing；不能把另一次max grab/CPU配对套到最慢pacing周期 |
| 输出与复用 | 7个已完成CAPTURE_STATS窗输出649、reuse438，**67.49%复用**；稳定窗约19.1–19.7FPS，呈现约19.56FPS | 约19.6FPS持续视频不能称约19.6Hz新桌面；缓存复用可能增加等待下张新屏幕的时间，实际输入到可见值仍未测 |
| 传输/解码 | RTT40快照35–271ms，启动271ms、后段约35–39ms；decode37个区间均值约0.531–0.676ms | 不把RTT除2，也不与异源capture/encode分位数相加 |
| 编码 | VideoToolbox7个完整窗；首窗最大 **394.014ms**，其后6窗最大≤10.479ms | 保留启动长尾；缺少逐帧序号，尚不能证明它就是首帧慢的唯一原因；window p95不是全会话p95 |
| loop/资源 | 7条active direct lag0.253–3.439ms，最后rolling max6.550ms；active Host约28.15%单逻辑CPU，RSS短期增长后约298–313MiB | 小窗口未重现几十秒loop停顿，不能关闭历史问题；没有浏览器/Signal CPU或长期内存平台证据 |

source-pixel `freshFrameAgeMs`仍count0/null；rVFC frameAge4.3–47.9ms只表示最近浏览器回调年龄。inputReliable/inputUnordered/relayFrames queue字段为null，不能写成队列0；本次实际inputEventCount/inputWaiters为0。新active数据建立抓屏节奏和启动长尾的优化方向，不建立真实输入延迟。

### 输入到画面的证据边界

| 指标边界 | 当前组合有效样本 / 状态 | 可证明的范围 |
|---|---|---|
| `inputAckRttMs` | **0；last/P50/P95=null；NOT_RUN** | Viewer发送到匹配应用ACK的往返；不是纯单向网络时间 |
| `hostQueueMs` | **0；last/P50/P95=null；NOT_RUN** | Host接收/入队到开始处理；不能由event-loop或worker-await代替 |
| `hostApplyMs` | **0；last/P50/P95=null；NOT_RUN** | 实际应用阶段；不能由租约ACTIVE、gate open或ACK存在代替 |
| `hostAdapterAwaitMs` | **0；last/P50/P95=null；NOT_RUN** | adapter await括号可能含queue；与queue/apply不重复相加 |
| `inputToPostApplyFrameMs` | **0；last/P50/P95=null；NOT_RUN** | 匹配applied input之后的新帧；回调推进本身不证明内容因果 |
| `inputToVisibleEffectMs` | **0；last/P50/P95=null；NOT_RUN** | 与动作相匹配的受控内容变化；不能用任意新帧或DOM事件替代 |
| Physical display | **NOT_RUN** | 需真实物理显示证据；浏览器解码/呈现不是光学测量 |

第二次实际运行全部51行的上述六项输入指标仍为 **count0、last/p95=null**；它们没有被本次被动媒体运行测量。本轮没有业务原生输入。独立评估仍未建立可证明的隔离HID目标，并识别实际同Viewer时钟send/ACK收集与严格数值evaluator接线尚有缺口；不能靠入口/媒体资格化解决这些缺测。继续处理环境和采集条件，不以要求用户手工试用作为前提。candidate RTT、jitter、decode、frameAge、capture/encode窗口与上述六项属于不同人群/边界，不能相加、将RTT除2或据媒体推进推算真实输入到画面。

## 下一步与实际验收状态

按现有授权继续工作，不以要求用户人工试用作为前置条件。以下是尚待实际完成的门禁，**不是已发生的结果**：

| 优先级 | 方案与成功标准 | 当前实际状态 |
|---|---|---|
| 1 | 完成真实产品timer初值修正；真实WebRTC/Input→未改sampler的测试不能预seed字段或伪造gate，实际原生产对象的初值/启动分支/legacy清理均投影False，真实出画仍需新运行验证，null/true仍被资格门禁拒绝；保留8/72/12秒预算，完成限定回归、独立review及新build字节核对后受控加载 | **cdea282源码及独立review完成，4/348测试通过，尚未部署**；新build/实际运行仍NOT_RUN |
| 2 | 改善进程诊断的上下文和容量：正常state/NoSuchProcess单独聚合，为真正scan/ownership/unknown/signal异常保留容量，精确关联本次scan到coverage note；纯call-trace等价、同异常对象/权限/信号/门禁不变，overflow仍可见且不能通过 | **35c6f97纯模块29项测试及两轮独立review通过，真实Registry对照及运行NOT_RUN**；两次旧observation-unavailable保持，full tree UNKNOWN |
| 3 | 新产品/工具精确pin、新鲜健康及vacancy/人类优先核对后，执行新one-use 300秒baseline；成功必须有≥300合格秒、持续正确身份/门禁/帧推进及完整终态验证，不能由47秒观察或新健康替代 | **timer修正后新baseline NOT_RUN**；两次既有baseline均0合格秒/样本 |
| 4 | baseline合格并处理清理门禁后，分别执行native-direct within-grace、playwright-routed after-grace；成功需一次fault后的真实既有协议恢复及30秒稳定。再用全新无fault route场次完成10800秒连续性；中断/人工到达/证据不全按原合同终止 | **两恢复及新三小时均NOT_RUN**；routed不提升native after-grace，旧longA INCOMPLETE保留 |
| 5 | 同配置优先归因目标50ms而实际约154ms的抓屏周期：有界记录请求/实际sleep、线程CPU与新内容更新；确认具体等待边界后选择调度/捕获修复。成功须在保持20fps意图、分辨率/质量/码率下提高真实新抓取率、减少pacing excess/复用，并保留完整窗口及环境上下文；另补齐3.647秒信令和4.049秒首帧阶段证据 | **active性能问题已测，原因及修复效果未证实**；首帧8.602秒、编码394ms保留，不能只看稳定期 |
| 6 | 建立隔离原生目标并接通同Viewer时钟发送/匹配ACK及严格数值评估；取得Host queue/apply、匹配应用后新帧、受控内容因果和物理证据。成功须按各边界独立有效样本和覆盖报告，不能用DOM、lease/reset或媒体统计凑数 | **业务/native/visible/physical NOT_RUN**；六项仍count0/null；无需用户手工试用才能继续独立工作 |

进程诊断后续优先采用不改变acceptance outcome的上下文增量，原immutable Registry保持。已发生的32+291诊断容量问题不构成重分类旧coverage的根据；若另设计可证明owned-child-exit的语义分类，必须作为独立spec/实现/review，逐项证明同scan已知身份/出生、具体失败调用及完整sibling/parent观察，无法证明即继续失败，完整树仍UNKNOWN。不得直接把所有NoSuchProcess或observation-unavailable移入可接受集合，不得增加探测/信号权限、清除旧原因或把not-evaluated填为PASS。

**当前已部署产品仍为dfb1543/build de4ac13287760f3b；工具59bca14已推广。第二次实际入场和媒体推进已建立，timer状态契约阻止合格baseline，cdea282修正源码已review通过但未部署。抓屏约6.49Hz与高复用是本次active性能缺口，业务输入到可见效果仍未测。** 普通恢复、新三小时、首次历史WS关闭跳点及完整进程树覆盖继续保持未验收或明确未知。
