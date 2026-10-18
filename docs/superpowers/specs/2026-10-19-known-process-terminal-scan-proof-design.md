# 已注册进程终态扫描证明与 R5 continuation 设计

日期：2026-10-19。状态：设计待独立 review；实现、纯 fixture 测试、实际运行均为 **NOT_RUN**。本文件只授权边界设计，不作为运行 receipt。设计和 plan 必须先经 root review、纳入 Git，才进入实现。

## 问题与证据

R4-fix1 第四次 baseline 的 worker exit=0，passive summary 报告 300.40683215111494 秒、301 continuity samples、missing/late/failed/identity-change 均为 0、max callback gap 533.312 ms；supervisor 共消费 312 rows，两种计数不可混用。sampleTriggered=false，七个登记身份最终 exited、无 signals。总体仍为 `failed-or-indeterminate`：coverage 阶段失败，后续验收未执行，不能以 worker 或 passive summary 成功替代。

唯一诊断是 worker / worker-loop / scan457 / event1 / children / PID36482 / NoSuchProcess，event.birth=null；原 gap 为 observation-unavailable。登记 birth=1792348652.844396、parent=36476/1792348650.059264。缺少即时后验身份观测，所以本次 FAIL、原 sequence `ff601377b608c2c4b1b51e55123e2f20`、attempt `f6e5f8e72e4195767164f168bcbe3550` 均不可改判、继续或复用。pacing 为 **NOT_ELIGIBLE**，旧 FAIL 不可补造证明。

输入为以下有界、不可变证据；本设计未查询当前运行状态：

| 输入 | SHA256 |
| --- | --- |
| `/tmp/wrd-r4f1-baseline-terminal-scan-race-assessment-20261019.md` | `018bc56ccb7c734248b9f678fcc88431dd23fe484d2cf9e18938418e8fffde24` |
| `/tmp/wrd-baseline-known-process-scan-exit-assessment-20261019.md` | `ab40c003d1f034b804b42fd26626b627fbfbca043b5b3a236f70c88b3ae32090` |
| `/tmp/wrd-owned-turn-probe-private/supervisor.py` | `d03cc2025f41d26c0079d3f820fdb2cd5479ae14448fb1c6f91c4589d6bd5c7b` |
| R4 `process_observation_diagnostics.py`（module35） | `00bd2366d770b9e65b272acadf54027c77cde48050b12106a2fd79338059f82b` |
| R4 `ordinary-continuation-supervisor.py` | `b485f982befac8e284861af24e6684b006850b67c43847219a5503ec234308df` |
| R4 `continuation_common.py` | `d0fe02e028f6c5ba3b27f67628639f99d7c4d835f8eaeaf7ed569bf36870c897` |
| 第四次 `qualification-result.json` | `5ebf46ff9919847f0be320f7f55df255928b6e4b8c9b22c0f9059364909f0dfd` |

这里及下文 R4 指固定目录 `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm`；第四次结果在其 `sequence-ff601377b608c2c4b1b51e55123e2f20/attempts/f6e5f8e72e4195767164f168bcbe3550/qualification-result.json`。实施时读取既有 manifest，验证其固定 dependency closure，不把本表误当完整 closure。

Task 1 portable fixture 优先读取已版本化 `docs/superpowers/reports/evidence/2026-10-19-runtime-startup/immutable-registry-supervisor.py`，先校验完整字节的 SUP SHA `d03cc2025f41d26c0079d3f820fdb2cd5479ae14448fb1c6f91c4589d6bd5c7b`，再仅编译 Registry AST，绝不执行其 main。原 `/tmp` 路径仍是运行不可变源引用，不作为跨机器 pure 测试必需文件。

原 `Registry.scan()` 先执行 `state(pid)`；alive 后才另行调用 `process(pid).children(recursive=False)`。catch 同时覆盖 children、child.create_time、child.ppid、后续 state/_add；按异常类别整体放行会误接纳其他故障。module35 已提供 role/scanId/eventId 和 direct-scan-error gap，但不赋予接受权；gap 没有独立 gapId。原 `result()` 要求每个 status 严格等于 exited，persistent reused 仍失败。

## 方案选择与声明边界

| 方案 | 决定 | 原因 |
| --- | --- | --- |
| 忽略 NoSuchProcess、把 observation-unavailable 加入 INHERENT、用最终 all-exited 清 gap | 拒绝 | 丢失故障操作与事件对应，未注册子进程错误也会被掩盖 |
| 原条件机械重试 baseline | 不作为修复 | 不消除 alive→children 的分类竞态，旧 sequence 也不可复用 |
| 即时、精确的旧身份终态证明 + 独立严格 consumer | 选择 | 保留所有原始观测，只前瞻接纳有完整证明的局部终态竞态 |

选择的策略是新的窄接受政策，**不是原代码 acceptance 的字面等价**。即使旧父进程终态被证明，也无法恢复丢失的 children 列表，无法证明退出前未产生未发现的 orphan。`polling-may-miss-fast-orphan` 保留，`completeProcessTreeExitEstablished=false`、`fullProcessTreeExit='unknown'` 永久保留。不得据证明获得注册新进程、查替代进程 children、发信号或宣称完整进程树退出的权限。

## Task 1：证据 producer 与独立 consumer

仅新增 `scripts/terminal_scan_proof.py` 与 `scripts/test_terminal_scan_proof.py`。生产接口固定为：

```python
instrument_terminal_registry(registry_type, diagnostic, *, wall, monotonic)
# 返回 Registry 实例；保留原 state/scan/signal/result/cleanup 决定。
registry.terminal_proof_snapshot()  # detached JSON-safe，无进程读取
validate_terminal_coverage(ownership, diagnostic_snapshot, proof_snapshot)
# 返回 coverageAssessment；失败抛出 TerminalCoverageError(RuntimeError)。
```

构造和 import 不进行进程、文件、网络、时钟读取。producer 只适用于 role=worker；sample 使用原 instrument_registry。使用实际不变 Registry 定义与 module35 的上下文/记录行为，不复制改写扫描算法，不吞异常、不返回伪造空 children、不删除或改写 raw gap，不改 SUP 或 module35 文件/对象中的决策逻辑。

### 精确时序

1. 在同一 scan 中捕获原 `state(pid)` 实际执行的 resolve/create_time/status 读取，记录该登记 birth 被确认 alive 的新鲜 before 观测；不能使用 lastObservedEpoch 或缓存 alive。原调用各执行一次，不额外做 before 进程观测。token 必须是本轮、该 PID 的紧邻 state→children 路径，遇到嵌套、其他操作或归属不明即失效。未进入直接 children 异常候选时，before token 缺失/失效本身不新增 veto；原 state=unknown 的 skip 行为不变。
2. 在实际直接 `children(recursive=False)` 入口，保存完整已登记 PID/birth、parent PID/birth（root 可 null）、登记 provenance，以及 entry 对象/身份不变的内部 token。此步骤不查新 PID、不增加所有权。PID 必须为正整数且非 bool，birth 为有限正数，parent 字段须有效。
3. 仅捕获该调用本身抛出的注入 psutil.NoSuchProcess 类实例，且安全读取的 error.pid 与请求 PID 严格一致。原 module35 必须照常记录 children event。resolve、create_time、status、ppid、_add、未知/未登记 child、AccessDenied/OSError/其他异常不适用。缺少 error.pid 不推断。
4. 立即对**同一个数字 PID**做一次有限的逻辑 identity observation。首次 raw factory resolve 的同 PID NoSuchProcess 仍可证明 absent，此分支只调用一次 factory。present 分支由第一个 fresh handle 读取 birth 和 status，然后必须再调用同 PID raw factory 创建**第二个独立 fresh handle**，从第二个 handle 读取 birthAgain。psutil.Process.create_time 会缓存，同一 handle 的第二次 create_time 不构成新鲜复核；禁止复用该 handle、调用私有 `_proc` 绕过或清缓存。只有两个 fresh handle 的有限正 birth 相等且等于旧 birth、status=zombie 才证明 same-birth terminal；两者 birth 相等且不同于旧 birth 才记录 stable reused。第二次 resolve 或读取中的任何 NoSuchProcess/AccessDenied/OSError、unknown、birth 不稳定或其他失败均不产有效证明，不能降级为 absent；第一 handle 的 birth/status 读取失败也拒绝。没有循环、sleep 或重试，不查询其他 PID、不额外 children。登记 entry 变化、归属或时钟不明继续 sticky fail closed。
5. 以原异常对象立即重新抛出，让不变 Registry 和 module35 生成原 gap。额外 observation 不进入原 diagnostic 记录流，不改变其 pending event；新 producer 自行记录其成败。若 observation 自身异常，也必须保留原异常和原 gap，同时 sticky 标记 proof 失败。
6. gap 完成后才形成可消费 proof，验证 event 和 gap 的精确对应。before、error、after、gap 的 monotonic/wall 均须有限且非负、依序不倒退；从 before 开始至 gap 完成的 monotonic 总跨度 **≤1.000 秒**。任何超时/调度越界只拒绝，不延长原 deadline。有限调用次数不是 OS 调用硬实时保证。

正常路径不得新增 process resolve、create_time/status、children、ppid 或 signal 调用；异常路径只新增上述一次 exact-PID **逻辑** observation，不能解释成 present 分支只准一次 factory。其显式调用上限为 present 最多 2 resolves + 2 birth reads + 1 status，initial absent 为 1 resolve；psutil 构造 fresh handle 时隐含的 OS 读取计入观测语义与原1秒总窗口，不能声称这些显式计数等于全部 kernel reads。第二 handle 不带来重试或其他 PID 权限。原 state、signal、cleanup、result 逻辑仍生效。尤其原 `state()` 的 AccessDenied/OSError 可能仅返回 unknown 并跳过该次扫描；module35 记录支持的 state event，failed 未必为 true。不得把这类没有 gap 的既有行为改成全局 veto，也不宣称所有上下文观测错误都被原实现拒绝。新增 after observation 的 unknown/AccessDenied/OSError 则不能形成有效 proof，原 children gap 仍使 consumer 拒绝。entry token 不把 Python object id 当跨进程身份，序列化的是已登记身份与 provenance；consumer 以最终 ownership 对应记录复核。

两个 factory 调用本身不足以证明 handle 独立：第二次返回与第一 handle 相同的对象时，Task 1 proof 和 Task 2 known observation 均保守拒绝，不重试。实例独立检查只用于内部 fresh-handle 确认，不把 object id 序列化成 OS 身份；实际身份/终态仍由两次 birth 和第一 handle 的 status 条件决定。cache-faithful fixture 必须覆盖 factory 两次返回同一 cached 对象的拒绝反例，不增加观察或 API。

### 证据格式、限制与消费

snapshot 为 version=1、scope=`known-process-terminal-scan-proof`、role=`worker`，含 proofs、failed、overflow、limits。limits 固定 `proofs=32`、`bytes=32768`、`maxIntervalSeconds=1.0`。字节限制覆盖**整个** UTF-8 compact JSON snapshot；超限不得裁剪成成功。32 条后再有候选，或 snapshot 不可序列化、时钟/schema/关联读取失败，均 sticky failed/overflow。失败状态也必须有界可输出；不存命令行、环境、原始错误消息、输入内容或发现列表。

每条 proof 含唯一递增 proofId、role/stage/scanId/eventId、gapIndex、operation=`children`、recursive=false、PID/birth/parent/provenance、before 的实际 birth/status 和 clocks、error class/error.pid 与 clocks、after 的 operation/outcome/birth/status/birthAgain 与 clocks、gap clocks、entryUnchanged。本次 fresh-handle 修订不改 schema：birth/status 来源为第一 fresh handle，birthAgain 来源为第二独立 fresh handle。gapIndex 是**不变 snapshot.gaps 的零起始索引**；它和 role/scanId/eventId/direct-scan-error/原 gap 内容一起标识 gap，不给 module35 追加 gapId。event.birth=null 可以保留：新 proof 自己承担已登记身份关联，不能修改旧 event 补 birth。

consumer 独立校验全部结构与实际数值，不能信任 producer 的 disposition/resolved/entryUnchanged 单个标志。要求：

- 原 coverage 仅含三个既有 INHERENT，或这三项加 observation-unavailable；其他 unexpected 原样拒绝。raw coverage、raw diagnostics、`observedUnexpectedCoverage` 不删、不重写、不标为 clean。
- diagnostics schema=2、role=worker、failed=false、dropped=gapsDropped=0、所有 overflow=false；事件/gap/proof 数量、类型和边界有效。
- 每个 observation-unavailable gap 恰好对应一个真实 children/NoSuchProcess event 和一个 proof；每个 proof 恰好被一个 gap 使用，无重复、孤立、额外证明、错误 role/stage/scan、相同 event 多 gap 或未证明的 gap 所关联 event。直接 scan/children 候选若缺 gap 关联则拒绝；无 gap 的既有 state AccessDenied/OSError event 保持原规则，不要求为它生成 proof、不新增统一拒绝。无 gap 时 proofs 必须为空；coverage 的 observation-unavailable 存在性与 gaps 一致。
- before 必须同登记 birth alive；after 只能 absent / same-birth zombie / stable reused；exact error PID、entry/provenance、clocks、≤1s 和一对一关系全满足。最终 ownership 中该旧 PID/birth/parent 仍匹配；不以最后退出状态反推 before/after。
- 原 allRecordedIdentitiesExited 必须 true，且逐条最终 status=exited；completeProcessTreeExitEstablished 必须 false，signals 必须为空。reused proof 是独立证据，**persistent final reused 仍失败**，不归一化、不删身份。无 timeout、注册/cleanup/worker/源/runtime 等其他门槛也继续由原 supervisor 检查。

成功返回独立 `coverageAssessment`，注明 `policy='prospective-terminal-race-v1'`、checked proof/event/gap 关联、rawUnexpectedCoverage 和 `fullProcessTreeExit='unknown'`。它不表示整个 qualification 成功。历史记录没有本版本运行时产生的 proof，必须拒绝，不能离线重演补证。

“未关联异常 event 拒绝”严格限定新增 scan/children 证明域：原 module35 支持且原 Registry.state 只返回 unknown/skip 的无 gap state AccessDenied/OSError event 可以原样保留，但绝不取得 proof 资格。所有原 observation-unavailable gap 仍必须一一对应 children/NoSuchProcess proof，其他操作/错误产生的 gap 一律拒绝；原 diagnostic.failed/dropped/overflow、coverage、signals 和最终 status 规则照旧。这不修改或放松原 state 逻辑，也不把它扩成新的全局 veto。

## Task 2：保留 R4 lineage 的版本化 R5 集成

新增 `scripts/guarded_terminal_scan_continuation.py` 与 `scripts/test_guarded_terminal_scan_continuation.py`。当前 planning branch 为 `codex/terminal-scan-exit-observation`；root 可从已提交文档 base 创建独立 execution branch，其实际分支/commit 记入 ledger，不能移动原 source held41。实现的 supervisorSourceTIP 和各新源文件 SHA 独立记录；它们不取代 deployedToolTIP=`2822441791b59a021556c7e4eb24715df9d5b277`，也不更新已部署产品。

集成接口固定为 `load_sealed_r4(dependency_seal, *, io)`、`validate_r5_history(history_record, *, read_record)`、`validate_r5_admission(r5_attempt, legacy_context, history, *, observation, wall, monotonic)`、`run_one_attempt(r5_attempt_path, r5_attempt_sha256, *, io, wall, monotonic, check_only=False)`，CLI 增加 `--check-only`。`io/read_record/observation` 是边界适配器；fixture 执行新增代码的实际方法，可在明确标出的外部 legacy-gate 调用边界 fake，不能把该结果称为完整 actual R4 chain pure PASS。生产 entry 明确构造真实依赖，import 时不构造运行观测；实际 R4 attempt_context/ready_context/current_gate 保留真实引用。

R4 `sequence()` 要求 folder.parent==R，并严格校验三条 failedHistory；`attempt_context()` 继续验证准备结果、decision、reservation、runtime/source/readiness 绑定。不能把目录复制到新 root 再重绑，也不能全局替换 FAILURES。使用新 outer R5 私有 root，按固定 absolute 路径只读加载 sealed R4 定义；如 root 日后决定运行，可由原 prepare-frontend-sequence/prepare-attempt 创建 **全新** R4 legacy sequence/attempt 目录，outer R5 再强绑定这些新 ID 和全部新增历史。旧目录、旧 markers、frozen 文件均不改。

loader 必须在任何 R4 导入前验证 package manifest、所需 transitive import 文件 SHA/mode/regular-file/no-symlink 边界和 SUP/module35 pins；不能只校验三个入口。仅执行定义的导入路径，不运行 `__main__`。对 bare imports 使用受控临时 import 环境，拒绝已缓存的同名外来模块，核对 `__file__` 与 hash closure，结束后恢复 sys.path/sys.modules；不得在共享已加载 R4 module 上 monkeypatch。fixture 必须检验同名污染和 closure 漂移失败。如果不能做到独立受控加载，停止集成，不退化成复制包或宽泛 AST 改写。

新调用命名空间仅绑定三个窄接口：`instrument_registry`（worker 用新 producer，sample 保持原实现）、`validate_owned_coverage`（worker 新 consumer，sample 保持原严格规则），以及 `source_pins`。前两项实现覆盖策略；第三项只追加启动准入：**每次先无条件调用真实原 source_pins(args, m)，在 main 启动前的首次调用成功后，再复核 R5 exact known-list 和 root decision freshness≤60 秒**，并检查 wall/monotonic 不倒退。任何一项失败向上传播，禁止替换、跳过或弱化原 source 验证。`current_gate` 完全保持原函数引用和 main 原有两次调用；它后面仍有可能耗时的 source_pins/attempt_context，所以不能在 current_gate 返回时提前完成最终 freshness 检查。

只用每次新命名空间内部的首次 source_pins 状态和原 legacy `qualification-started.json` 的一用一次生命周期，区分启动与 final：首次调用必须处在该 attempt 未写 legacy marker 的启动位置，完成 source 验证和 fresh 检查后才记为已检查；随后 final 调用必须匹配该次 main 写出的 marker/attempt 绑定，仍无条件执行原 source 验证，但不要求已消费的启动 decision 在 300/10800 秒后仍≤60 秒。未知次序、额外调用或 marker 归属不明均拒绝；不得接受 caller 提供的布尔值跳过启动检查。预存在的旧 legacy marker 仍由原 main consumed check 拒绝，R5 outer marker/ID 也保持独占。启动 source_pins hook 成功后按原 main 的 tempdir→legacy marker→worker 次序继续，不插入额外等待；外层提前检查不能替代此处准入。

所有其他 main/Rows/registration/worker loop/cleanup/validation stages 使用原函数定义。sample 可通过真实纯 legacy coverage validator 对同一个 sample ownership 作两参数校验；先确认它无副作用且两参数对称，不能用伪造 clean worker 填位。若接口不同，采用等价只读委托并写下 review 证据，禁止放宽 sample。

outer entry 先调用真实 R4 `attempt_context(args, admission=True)`，再校验 R5 history/admission。正常 run 在调用 main 前消费一个 exclusive one-use R5 marker，再执行 main；check-only 不进入 main 的运行/写入路径、不消费任何 marker。它不替换原 attempt_context 的结果或跳过 run 中的重复检查。新 proof/assessment 与原 main 产生的**新** legacy result 分开落盘，用 SHA 强绑定；原 result 的 raw 字段保留。outer R5 result 明示 prospective policy、生效代码/依赖 SHA、legacy result SHA、proof SHA、完整新 history、validation 与 classification；缺少 outer result、任一失败或 legacy 非成功时，R5 不成功。后续情景必须同时检查同序列的 legacy 和 R5 predecessor，不能只凭 legacy classification 前进。

Task 2 最终 review 已确认 predecessor 场景交叉绑定 P2：仅保证 prior outer result 与 legacy result 场景一致、prior attempt 与 root decision 场景一致不够。必须要求 **prior outer result / legacy result / prior attempt / root decision / started marker 五者 scenario 严格相等，且等于当前场景的 expected previous scenario**。prior attempt、started marker 必须校验各自 exact schema、kind、schemaVersion；原全部 identity/ref/clock/proof 绑定继续执行，不得以新增场景校验替代或放松。baseline 结果指向 continuity prior attempt/root decision 的混合记录必须被实际新增 validator 拒绝，包括 next within-grace 的 check-only 路径；此已确认 P2 与缓存问题一并纳入 Task 2 fix round 1，不增加 hook、不修改 old main。

`--check-only` 是独立真实只读集成入口：执行真实 R4 完整 gate（含 attempt_context/ready_context 路径），独立调用真实 current_gate 和真实 source_pins，**最后**追加 R5 exact known-list/root decision≤60 秒与时钟检查；不借用 main 的首次/final hook 状态。它对当前 FS、metadata、Git、known process、HTTP 做原有有界只读检查，不调用 main、不启动 worker/browser/sample、不修改服务、不写 operational marker/result、不生成 qualification 或消费 one-use；仅 stdout 输出 ≤32768 UTF-8 bytes 的脱敏诊断，root 可另存真实输出。失败返回非零；成功只表示当时只读集成通过。

### 四次失败、reload 与已知身份

R4 三个 failedHistory 固定为：

1. `2f0f2a2a0774b15f8b62adef72bb997d5deeae298a06640e71583d2d3cd33242`
2. `af76a8dbeb32083ec9f8c630d7138362b3cd45d0f60ad16ad75d1a95fa025cd6`
3. `5ef3358f1a1ee0bb5ef72e816952c5874d0826c8795c67616ba0a85ff73a42b9`

R5 外层另加第四失败 `5ebf46ff9919847f0be320f7f55df255928b6e4b8c9b22c0f9059364909f0dfd`，绑定 sequence/attempt、attempt manifest、runtime manifest、started marker、result 的真实 path/SHA 链；不能只附四个摘要字符串。第四 started SHA=`61a1875a020f325d4609509a7f9570e740ee3c825af702efad4b20ecafdd1f5e`，attempt SHA=`d72f626c88d68766a5d62bdfd0243596f2298b2b96476e6378bf476728e4ef3d`，runtime SHA=`2002654ee48a6aa1485e670181dee94af59ca71963a845beb5b35bd75f23ae83`。

同时绑定 R4 deployment 的 reload started/result 与 readiness。reload result `ff6ff0b8b356c1f889dea3e0b1d39d68c527678066390711c4f28f41907b410f` 保持 FAIL/lifecycleAcceptable=false；六个 helper identities exited/no signals 与唯一 observation-unavailable 只满足已有 `reconcilable_helper` 的窄 readiness 规则。readiness `1064eeaa41ac546ad9bd22d3ee05f5042be75f2423edda82f3f0137f0e60a74c` 可作已加载部署 lineage，不是 fresh idle，也不向 qualification 扩展该 reconciliation。

从全部 pinned 历史结果**推导** `(PID,birth)` union，保留多来源 provenance 并拒绝矛盾。预期旧三次 21 + 第四次 7 + reload helper 6 = 34 个独立身份；34 是预期核对值，不能硬造集合或只检查数量。已知新增值为：

| 来源 | PID/birth |
| --- | --- |
| 第四次 | 36474/1792348649.06148；36475/1792348649.381747；36476/1792348650.059264；36477/1792348650.247472；36478/1792348650.253278；36479/1792348650.309118；36482/1792348652.844396 |
| reload helper | 33161/1792348309.54818；33163/1792348309.916294；33165/1792348310.1486；33169/1792348310.517254；33183/1792348311.820681；33311/1792348322.363265 |

root 新 decision/sequence/attempt/runNonce 必须排除所有历史标识，包括第四次 sequence/attempt 及历史 nonce `0acf96f1...` 的**完整值**（从 pinned runtime 读取，不接受此前缀作为值）。新的 baseline previousResult=null，outer immediatePriorFailure 为第四失败；legacy priorFailure/三历史仍按原 schema，不改写两层含义。

准入要求对同一精确 union 的 fresh known-quiescence：gone、same-birth zombie、稳定不同 birth 仅证明旧身份已静默；alive-matching/unknown/不完整观测拒绝。每个观察均有 provenance、时钟与原 identity；TTL **≤60 秒**、wall/monotonic 无倒退，临运行立即再次核查相同 known-list。服务身份单独检查活性，不能纳入 quiescence 或获得信号权限。保留 strict idle 的 viewer=0/relay=0 和 lsof **5 秒**有界检查。任何未关闭历史、新旧 ID 混用、来源缺失、过期或 runtime drift 均在 Popen 前拒绝。

Task 2 的 known-quiescence 也必须使用同 PID 的两个独立 fresh handle：第一 handle 取 birth/status，第二次 raw factory resolve 得到第二 handle 后取 birthAgain；同 handle 的 cached create_time 双读不证明 stable-nonmatching。initial resolve absent 仍仅1次 resolve；present 最多2 resolves + 2 birth reads + 1 status，构造器隐含 OS 读取计入观测语义。第二 handle 的任何读取错误（含 NoSuchProcess/AccessDenied/OSError）、unknown 或 birth 不稳定均为 unknown 并由 validator 拒绝，不能转为 gone/reused。禁止 `_proc` 绕过、清缓存、重试、其他 PID/children；schema、既有 freshness/超时门槛不变。

### 运行与变更边界

文档/两个实现任务不 copy/build/reload、不启动浏览器/worker/sample、不网络或进程查询、不重启服务。root 在代码、纯测试与 fresh most-capable 全分支 review 完成后，必须先独立执行上述真实 `--check-only` 才可决定 run；该阶段允许正常 Git/known-process/HTTP 只读检查，禁止任何运行/服务 mutation。只读成功后 root 另建 fresh run decision，实际 run 重跑全部原 gate 和 R5 gate；check-only 不是 runtime qualification，也不豁免 60 秒 TTL 或启动 source_pins 返回后的 fresh 检查。每个 scenario 保留独立 root decision、一用一次、fresh strict idle；不自动 retry/next/clear。baseline/within-grace/after-grace/continuity 的预算分别 **300/390/390/10800 秒**，原 worker deadline=duration+128 及 cleanup 上限不变；within/after 的**整个恢复场景**禁止 Host sample。质量、FPS、codec、network、grace、deadline、阈值不变。

部署 pins 保留：source=`41c7b0998859a7e9d088cefcc0f3a1eeab190684`；Viewer=`fefc555aea9640b563bfd22f5b36b6b8ca6365ec`；tools=`2822441791b59a021556c7e4eb24715df9d5b277`；backend=`dfb15434e79da90b803b763c533836e16c080c71`；module35 原字节。旧 source worktree `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop` 的 HEAD held41 不动；primary `/Users/macstudio1/AI/Claude/WebRemoteDesktop` 的 HEAD/index/4 份既有 dirty docs 和 1016 known-map 不动。source/assets/modes/component/service/preserved/tunnel/watcher/quick-file 全部原门槛保留。

当前简报所载 Signal=33179/1792348311.587397、Host=36877/1792322600.528357、Viewer build=`a3671ba674ad7516`/builtAt=1792348315201、current core=`23d4e5e6416b1792` 只是后续核对锚点。root 在 epoch1792349122.91 观察 health/status=200、Host 在线、viewer=relay=0，并不能解释更早 currentReadiness RuntimeError 的原因；不得据此断言 disconnect grace，或免除下一次 fresh admission。Host/tunnel/watcher 不动。

## 验证、review 与交付

两个任务分别 RED→GREEN、root systematic review、独立 commit；最终新鲜、最强可用 reviewer 审全分支。只运行新增、具有实际方法与 IO fake 的 fixture 测试，不重跑既有已过 561/166/19 套件。不以把 operational core 改成成功 stub 的测试声称全链路成功。

本次修订由 root 顺序执行 **Task 1 fix round 2 → 独立复审 approved/commit → Task 2 fix round 1 → review/commit**，不得并行；仍分别只改各任务原定的实现/测试两文件，不增加 API/schema/框架。缓存忠实 fake 必须使同 handle create_time 永远返回自身缓存值，在 status 期间把底层 birth 从20改为30，第二个 fresh handle 才可见30。用实际 producer+consumer 及实际 observe_known+validator 在旧实现产生行为 RED，再验证新实现拒绝；同时保留 stable-zombie/stable-reused 局部正例（Task 1 persistent final reused 仍拒绝）、normal call parity、initial absent=1 resolve/present=2 resolves、原 pending/event/gap 和原 exception 不变。已确认的 predecessor 场景绑定 P2 在同一 Task 2 fix round 1 解决，补实际新增 validator 的下游拒绝反例。此次文档修订未运行这些测试，修复轮次状态由 root ledger 记录，不据此追补历史资格。

Task 1 要覆盖 actual Registry AST + actual module35 + producer/consumer，包括正常调用 parity、原异常对象、raw gap 不变、absent/zombie 正例、persistent reused/unknown/alive/错误操作/metadata/时钟/overflow/孤立或缺失 proof 反例与下游拒绝。Task 2 用实际新增方法 + IO fakes 覆盖 history/known union/schema/loader/producer-consumer/main wiring，检验三接口次序和 check-only 无写入/无启动。允许明确的外部 legacy-gate 边界 fake；增加静态/函数 identity 断言，确保 attempt_context/ready_context/current_gate 完全原引用、source_pins hook 每次先调用原定义，及可独立验证的真实局部入口负例。必测 current_gate 时新鲜但 source_pins 完成后过期拒绝，以及 final source 验证保留而不再次要求启动 decision 年轻；未知调用次序/任意跳过标志均拒绝。

不要求重建旧 84 receipt、1016 FS/source-Git 历史的完整成功 fixture；未覆盖的 actual R4 完整成功链标为 **NOT_CLOSED**，不得以 fake 成功代替真实准入。全分支 review 后由 root 的真实只读 check-only 补上当前组合检查；其输出与 fixture 证据分开记录。

所有测试与运行在本设计阶段为 **NOT_RUN**。实现后仅把实际执行结果写入审查记录；纯测试成功不等于部署加载、运行资格、完整进程树闭合、原生业务效果或长期会话验收。
