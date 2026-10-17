# 本轮实施裁决记录

按原执行 ledger 中 `Ruling:` 的顺序完整归档。尚在执行，后续裁决继续追加；成本描述不表示对应风险已经发生。

## 1

Ruling: latest user explicitly authorizes implementation, real connection acceptance and local Signal/Host service startup, superseding old documentation-only constraint 1 — keep tunnel unchanged — no automatic public URL rotation.

若判断有误的成本及约束：若授权解释有误，会越过原来仅诊断的边界；依据用户最新明确要求开发、验收、启动，且继续禁止 tunnel 操作。

## 2

Ruling: use managed isolated worktree with existing recovery changes imported — avoid source/version skew — original checkout untouched until controlled rollout.

若判断有误的成本及约束：若导入基线不完整，可能漏掉已有修复；保留原工作区并以精确基线、哈希和增量补丁核对。

## 3

Ruling: task-brief script only recognizes numeric Task headings, whereas reviewed plans use C/M/W identifiers — extract exact headings to this plan workspace using a bounded parser — task text remains verbatim with updated authorization block.

若判断有误的成本及约束：若任务提取错误，可能漏执行要求；保留原文及明确授权补充，任务按 C/M/W 身份追踪。

## 4

Ruling: parallel independent file ownership is permitted by developer multi-agent instruction; serialize every shared-file adapter — accelerate disjoint changes without overwriting — any overlap requires root ownership reassignment.

若判断有误的成本及约束：若文件所有权判断错误，可能覆盖并行工作；共享文件与 Git index 串行交接。

## 5

Ruling: no npm test/pretest or production dist rebuild during implementation; run targeted node:test/pytest/unittest and explicit temp build.

若判断有误的成本及约束：若定向覆盖不足，可能漏集成故障；另外进行跨层回归、临时构建和实际部署验收。

## 6

Ruling: latest user request supplies a maintenance/acceptance mandate; before creating real Viewer confirm viewerCount=0 and use controlled producer/input guard; never replay uncertain user input or manipulate other projects.

若判断有误的成本及约束：若维护授权过宽，测试可能打断用户；每次接入仍要求 fresh zero-Viewer 和服务端单次 proof，人工连接优先。

## 7

Ruling: existing end-to-end acceptance runner has a BLOCKED automatic branch; inspect and implement the required guarded native producer fixture rather than bypassing its guard or falsely claiming visual latency measured.

若判断有误的成本及约束：原先计划实现原生 fixture；若把共享桌面当隔离桌面会影响用户输入，因此后续第23项裁决收紧并保留未测。

## 8

Ruling: W1a may add bounded-request script before auth in source viewer.html — necessary loader adapter — no other Viewer markup changes.

若判断有误的成本及约束：若脚本顺序错误，会破坏认证启动；以真实入口加载顺序及鉴权回归验证。

## 9

Ruling: shared-file sibling commits use exact-commit diff packages instead of broad HEAD ranges; preserve unrelated commits and index ownership. M1 metadata/expired relay followups self-reviewed before task review.

若判断有误的成本及约束：若冻结范围错误，review可能漏掉交叉改动；记录精确 commit 与完整差异包。

## 10

Ruling: W2a coordinator will be separated into scripts/wrd_watch_coordinator.py (if needed) rather than growing pure runtime module with OS/lifecycle effects — testable ownership/termination and persistence boundary — extra small module requires scoped review. Root has not invoked watcher/recovery.

若判断有误的成本及约束：新增小模块可能增加维护面；用单一 OS 操作协调层及独立 review 限制扩散。

## 11

Ruling: add I2 passive streaming helper because existing acceptance scripts cannot prove continuous3h behavior — root implements four isolated helper/testfiles while production tasks use agents, then fresh independentreview before invocation — costs a smalladditional acceptance surface, not a productionpolicy change.

若判断有误的成本及约束：新增验收工具可能自身误报；独立复审、反例修订，并保留后续发现的 Start/按钮/proof 工具问题。

## 12

Ruling: synchronize all eight spec/plan authorization banners with latest explicit implementation/local-service mandate, retaining original planning status as history — avoid future agents treating obsolete doc-only text as current permission — actual validation remains in executionreport.

若判断有误的成本及约束：若状态文字超前，会误导后续部署；运行结果以实施报告中实际证据和 NOT RUN 为准。

## 13

Ruling: correct AGENTS copied StockHub architecture/FastAPI/Vite command examples to actual WebRemoteDesktop directories and local-only helper — user asked to update agent guidance and wrong commands could start unrelated services — existing skill-lock rules and all tunnel/credential constraints preserved.

若判断有误的成本及约束：若清理文档涉及未授权领域，会扩大范围；仅纠正本仓库错误架构/命令，保留原技能与 tunnel 约束。

## 14

Ruling: W3a may add exact diagnosticSocket/HTTPreceipt adapters and one bounded durable10k/24h receiptledger —scope-ended removal mustfollowdurableack evenrawretentionevictsfiles —W3b mustreuse itsidempotenceinterface ratherthanindependentdedup.

若判断有误的成本及约束：额外 receipt ledger 增加存储和幂等复杂度；容量、TTL、持久回执及 W3b 复用接口均受测试约束。

## 15

Ruling: W3a may add optional schema3 InputTrace producer using absolute monotonic safe-integer timestamps with legacy defaultschema1 preserved — wrapper alone cannot remove oldrelativeclock/600000msclamp — W3b reusesproducer ratherthansecondcorrection.

若判断有误的成本及约束：新 schema 增加兼容成本；保留旧 schema 默认，版本化 producer 与留存共用同一接口。

## 16

Ruling: I2 helper passive means no business input, clipboard, terminal or desktop mutation actions after guarded ordinary UI connect; normal mandatory control lifecycle reset on admission is permitted — skipping it would bypass control safety — docs must state reset side effect, not claim zero lifecycle messages. Explicit CLI --mode is scoped to disposablebrowser; it grants no app authority bypass.

若判断有误的成本及约束：正常接入 reset 会改变远端按住状态；它属于既有安全生命周期，禁止把测试描述为完全没有控制消息。

## 17

Ruling: W3c carriesoneI1fixturecompatibilitysync forM2newhostCapabilities.inputFrameCorrelationVersion:null — legacyHoststrictdeepEqualcontractchangedintentionally — addexactnullratherthanweakeningassertion; coverfailedcaseandnewobservationcaseswithoutrepeating109suite.

若判断有误的成本及约束：若 fixture 同步错误，可能掩盖旧 Host 兼容问题；只加入明确 null 并覆盖真实失败场景。

## 18

Ruling: M4 convert boundary usesexistingframe_timing.frameConvertMs + internalStageMetrics, keepsstrictframe_trace_batchv1STAGESunchanged — avoidunversionedwireexpansion — missingboundaryremainsunavailable.

若判断有误的成本及约束：未扩 wire 导致部分转换阶段仍缺测；保留 null，不强凑完整延迟或重复计时。

## 19

Ruling: W4a may addpurekeyboardtransport.peekAckMetadata toreadrealpendingwithoutmutation; optionalboundedpayload-freeunorderedobserved-sendindex onlyashint andneverreliableauthority — preservebusinessownershipwhileclassifyingpassivetrace — unknown/evictedmetadataretainsACKratherthansampling.

若判断有误的成本及约束：可选 metadata 只作采样提示，丢失时保留 ACK；若当授权依据会破坏输入安全，因此业务归属保持原状。

## 20

Ruling: M5 may narrowly parameterize existing peak raw validator/probe for fixed joint FPS/PTS/GOP/codec matrix; CLI must have functional configuration/raw-evidence validation rather than permanent placeholder — reuse gates without false qualification — real encoding remains uninvoked.

若判断有误的成本及约束：资格 CLI 参数化增加测试维度；未运行实际硬件矩阵，新增自适应继续禁用，不伪造资格。

## 21

Ruling: start fresh most-capable broadbranch reviewer /root/review_final_branch on frozene5e086d while last two independent scopedfixes run — read-only cross-layer audit is independent of knownleaf fixes and saves walltime — finalverdict must incorporate newfixcommits and maynot treatoldcandidate asdeployable.

若判断有误的成本及约束：并行复审旧候选可能遗漏最后补丁；最终结论必须纳入全部修订及 scoped re-review。

## 22

Ruling: implement C5.1–C5.4 in one coherent fresh-agent task because API, Socket admission and UI intent are inseparable; no parallel code writers — reduces transient incompatible protocol states — cost if wrong is broader task review and rework. C5.5–C5.6 remain root-owned.

若判断有误的成本及约束：合并 C5 多层任务扩大单次 review 范围；交换完整 API/Socket/UI 协议必须作为一致单元验证。

## 23

Ruling: original intent to implement native fixture cannot be satisfied with current shared WindowServer/global HID routing; local SDK/code review confirms virtual display or foreground sampling is not independent input isolation. Keep automatic visible-effect BLOCKED instead of fabricating native proof; dedicated GUI environment/operator collection remains required — cost is no numeric visible-effect certification in this environment, while connection/media acceptance proceeds. Evidence archived in visible-effect-acceptance-boundary report.

若判断有误的成本及约束：无法在当前环境给出数值化真实可见效果认证；保留 BLOCKED/NOT RUN，不能用 ACK、DOM 注入或虚拟显示器冒充独立原生输入。


## 24

Ruling: implement M6.1–M6.3 in one fresh single-writer protocol task with a complete Host/Signal/Viewer review package, keeping M6.4 deployment and live acceptance controller-owned — the three tasks share frame/ACK scope and mutable state, parallel writers would produce incompatible intermediate protocol states — cost if wrong is a larger review and rework surface; no runtime activation before review.

若判断有误的成本及约束：一次跨三层变更较大，独立 review 及返工成本增加；单 writer、测试、完整协议复审通过后才部署。


## 25

Ruling: allow media-null source/test work in parallel with a possible I2 harness fix, while keeping a single index owner — the paths and runtime interfaces are disjoint, and neither agent may deploy or run live acceptance — cost if wrong is paused work and conflict resolution, never overwrite or concurrent commit.

若判断有误的成本及约束：路径冲突时暂停并解决；Git index 始终串行，线上部署和验收仍由主线程执行。两项现均已独立复审通过。


## 26

Ruling: supplement existing remediation with one coherent observer-module/wiring task and root-owned deployment, reusing this plan ledger — exact heartbeat boundary is missing from confirmed first-disconnect evidence, so another identical run alone cannot diagnose it — cost if wrong is diagnostic overhead and rework, bounded by one close log and independent review; no tunnel/auth/timeout changes.

若判断有误的成本及约束：最多增加有界观测开销及返工；独立复审通过后才加载，不把补齐日志称为修复网络。

27. 增补单调时钟节流修复：源码已证明系统回拨会放大真实媒体等待，先修复该确定缺陷再做新的长测；风险是节流/统计回归，使用真实方法的模拟时钟测试和独立 review 约束。不调整系统时钟，不将其冒充全部历史停帧的唯一原因。

28. 将已复现的 Viewer 本页 ACK、移动端 ACK、信令恢复及相邻新鲜度/冷却时钟作为独立窄修复：只迁移私有 duration，不改票据、lease/seq 或 epoch 协议。风险为零时刻/sentinel 或测试混钟回归，以 null 未设置值、真实对象假时钟测试和独立 review 控制。

29. 单独同步两项遗留 M6 集成测试的认证 scope/ACK fixture：独立 review 已确认是旧测试报文，保留真实 ACK/图片加载及旧身份拒绝断言。风险是测试被弱化，因此不改生产校验并独立复审。

30. 保留 M6 本页诊断原因，键盘复位只用既有协议值 deactivated；通过 Input.setActive 的可选本地 metadata 分离两种语义。真实浏览器与 Signal 日志已证明旧原因被拒绝，不扩大跨版本白名单。风险为 reset 顺序或 gate 回归，使用真实 VM transport/validator、两种 ACK/画面顺序和身份拒绝测试及独立复审约束。

31. 在同次前端加载前修正 freezeControl/releaseControl 两个调用处的键盘复位协议值。真实 UI 已复现坏报文，但服务端释放屏障已有兜底，不扩大为已证实的永久失控根因。风险是撤销/暂停租约行为回归；保留原诊断、释放事件及三个跳过分支，用真实方法测试和独立复核控制。

32. 在用户明确说明“不是我在使用，可进入维护验收”后，允许对刚核对的同一Viewer身份/epoch执行一次已审查源码同步及本地Signal维护重启。最初零Viewer检查已无修改地停止；维护脚本仅匹配该次精确授权快照，未绕过自动验收proof或接管。代价是一次授权连接中断；普通客户端随后自动恢复，后续自动验收仍等待零Viewer。
