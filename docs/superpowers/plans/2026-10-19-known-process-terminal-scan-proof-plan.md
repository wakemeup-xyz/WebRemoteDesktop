# Known-process terminal scan proof implementation plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. Dispatch exactly the two bounded tasks below, review each before advancing, and use a fresh most-capable reviewer for the final whole-branch review. Do not delegate real runtime operations as part of these tasks.

**Goal:** 对未来已登记父进程的直接 children NoSuchProcess 产生即时终态证明，并以严格独立 consumer 接纳完整对应的局部竞态；保留所有原始 gap、旧 FAIL 与最终 exited/no-signals 门槛。

**Architecture:** Task 1 是只读证明 producer + pure consumer；Task 2 是版本化 R5 outer continuation，固定依赖原 sealed R4 定义，绑定两个覆盖策略接口和一个仅追加准入的 current_gate 接口，并在原三历史契约之外绑定第四失败、reload/readiness 与 fresh known-quiescence。原 SUP/module35/R4 文件和部署源码不变。

**Tech Stack:** Python 3、unittest、stdlib ast/importlib/hashlib/json/pathlib、注入 psutil-compatible IO/clock fakes、真实不变 Registry 与 module35/R4 definitions。

**Spec:** `docs/superpowers/specs/2026-10-19-known-process-terminal-scan-proof-design.md`。

**Global Constraints:** 当前实现和测试均 **NOT_RUN**。root 先 review/commit 本 spec/plan，之后才 dispatch 实施。planning 工作目录 `/Users/macstudio1/.codex/worktrees/terminal-scan-exit/WebRemoteDesktop`，planning branch `codex/terminal-scan-exit-observation`，base `41c7b0998859a7e9d088cefcc0f3a1eeab190684`。root 可从已提交文档 base 创建 execution branch，实际分支/commit 写入 ledger。不改旧 source worktree held41、primary HEAD/index/4 旧 dirty docs、1016 known-map、product/Viewer/tools/backend/module35；不改旧包/记录。两个实现任务不 process/network/browser/sample/build/copy/reload/restart，不影响 Host/tunnel/watcher。只运行新增 pure fixture 测试，不重跑 561/166/19 历史套件。全分支 review 后 root 单独执行真实只读 check-only（可正常 Git/known-process/HTTP 读取），之后另决策实际 run。无自动重试/下一场景/清 marker。

## Task 1 — 终态证明 producer 与独立 coverage consumer

**Files**

- Create: `scripts/terminal_scan_proof.py`
- Create: `scripts/test_terminal_scan_proof.py`

**Consumes:** spec；版本化 `docs/superpowers/reports/evidence/2026-10-19-runtime-startup/immutable-registry-supervisor.py` 的完整字节（先验证 SUP SHA `d03cc2025f41d26c0079d3f820fdb2cd5479ae14448fb1c6f91c4589d6bd5c7b`），再提取实际 Registry AST；原 module35 `scripts/process_observation_diagnostics.py`（部署 SHA `00bd2366d770b9e65b272acadf54027c77cde48050b12106a2fd79338059f82b`）。portable 测试不依赖 `/tmp`；原 `/tmp` SUP 仅保留运行源引用。只读有界定义，不 import operational supervisor，不查真进程。

**Produces:** 以下公开接口及真实方法 fixture 测试；原 ownership 与 diagnostics 不变，单独有界 proof snapshot / coverageAssessment。

```python
class TerminalCoverageError(RuntimeError): ...

def instrument_terminal_registry(registry_type, diagnostic, *, wall, monotonic):
    """Return Registry with terminal_proof_snapshot(); worker role only."""

def validate_terminal_coverage(ownership, diagnostic_snapshot, proof_snapshot):
    """Return prospective assessment or raise TerminalCoverageError."""
```

**Steps**

- [ ] 建立 portable fixture：优先读取上述版本化 supervisor 归档，校验完整 SUP 字节 SHA，再仅编译实际 Registry class AST，绝不执行 main；用 fake psutil classes/STATUS_ZOMBIE 和假时钟执行。加载 actual module35，构造有调用账本的 fake Process；Registry.state/scan/result/cleanup 不替换为 stub。支持 scripted resolve/create_time/status/children/ppid 返回/异常与 entry 变化。
- [ ] 写首个 RED：已登记 birth alive → children 抛 exact-PID NoSuchProcess → immediate resolve 同 PID NoSuchProcess。断言 raw observation-unavailable 仍在，诊断 event/gap 存在，consumer 成功且返回 policy。另写同 PID 仍 alive 的负例，证明即便稍后最终 exited 也不接受。先运行下列单测，记录实际失败原因；不能把语法/fixture 失败当行为 RED。

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s scripts -p 'test_terminal_scan_proof.py' -v
```

- [ ] 实现 producer：沿 actual state 读取捕获 fresh same-scan before，绑定紧邻直接 children 调用；只在 exact injected NoSuchProcess/error.pid 匹配时追加一次同 PID resolve + birth/status/birth（或 resolve absent）。重新抛出相同 exception object。保留原 diagnostic pending token，gap 后完成关联。正常路径原 process-call parity；异常路径不再查其他 PID、不枚举子树、不发信号。
- [ ] 固定限制：32 proofs、整个 compact UTF-8 snapshot ≤32768 bytes、before→gap monotonic ≤1.000s、全部 wall/monotonic 不倒退；已进入 proof 候选时缺测/异常/嵌套归属不明/entry 变化/容量满均 sticky failure，禁止裁剪后接受。gap 用原 snapshot 的 gapIndex + role/scanId/eventId/full metadata，不改 module35 schema。未进入候选的 before token 无效不新增 veto，保留原 state=unknown 的 skip。
- [ ] 实现独立 consumer：exact schema、真实 clocks/identity/provenance、original diagnostics 完整性、coverage/gaps/proofs 一对一双向校验；原三 INHERENT 不变。保持原逐身份 exited、allRecordedIdentitiesExited=true、signals=[]、completeProcessTreeExitEstablished=false；输出单独 assessment，raw unexpected reason 仍保留。
- [ ] 精确限制 event 处理：“未关联异常 event 拒绝”仅限新增 scan/children 证明域；原支持的无 gap state AccessDenied/OSError→unknown/skip event 原样保留、无 proof 资格，不新增全局 veto。所有原 observation-unavailable gap 仍逐一要求 children/NoSuchProcess proof，其他操作/错误 gap 拒绝；原 diagnostic.failed/dropped/overflow、coverage/signals/final status 规则照旧。
- [ ] 扩展下表 positive/negative matrix；每个反例必须走 actual consumer 并断言拒绝，不能只检查内部 flag。测试借用的名称是 fixture API，由本任务实现，不能用假 PASS receipt 填充：

```python
def test_direct_children_absent_keeps_raw_gap(self):
    case = self.scan_case(after="absent")  # actual Registry + module35 + adapter
    ownership, diagnostics, proofs = case.finish_exited()
    before = self.canonical((ownership, diagnostics))
    result = validate_terminal_coverage(ownership, diagnostics, proofs)
    self.assertEqual(result["policy"], "prospective-terminal-race-v1")
    self.assertIn("observation-unavailable", ownership["coverage"])
    self.assertEqual(before, self.canonical((ownership, diagnostics)))
    self.assertEqual(case.original_children_call_count, 1)
    self.assertEqual(case.extra_observed_pids, [case.registered_pid])
    self.assertEqual(case.signal_calls, [])

def test_one_proof_cannot_cover_second_gap(self):
    case = self.scan_case(after="absent", second_gap="child-ppid")
    owner, diag, proof = case.finish_exited()
    with self.assertRaises(TerminalCoverageError):
        validate_terminal_coverage(owner, diag, proof)

def test_reused_does_not_bypass_final_exited(self):
    case = self.scan_case(after="stable-reused")
    owner, diag, proof = case.finish_with_final_state("reused")
    self.assertFalse(owner["allRecordedIdentitiesExited"])
    with self.assertRaises(TerminalCoverageError):
        validate_terminal_coverage(owner, diag, proof)
```

| 组 | 必须验证的真实路径 |
| --- | --- |
| 允许局部 proof | absent、同 birth zombie；0 gap/0 proof 正常路径；全部后续 ownership 门槛成立 |
| 终态拒绝 | final persistent reused；same-birth alive；unknown；double birth change；entry/parent drift；登记信息缺失 |
| 操作边界 | scan resolve、child create_time/ppid/_add、未注册 child；children 或 after 的 AccessDenied/OSError/unsupported；error.pid 缺失/错 PID；候选无 fresh alive-before |
| 关联与有界 | wrong role/stage/scan/event/gapIndex、duplicate/orphan/extra proof、第二未证明 gap、未关联 event、32/33、32768/32769 bytes、倒退/NaN/bool/缺钟、1s/超1s、diagnostic failed/dropped/overflow |
| 保留行为 | 正常调用 parity；异常路径精确新增调用；same exception object rethrow；raw event/gap/coverage 字节内容不变；original cleanup/signal/result 决定与 deadlines 不变；单独 state AccessDenied/OSError→unknown/skip、无 gap、后来 exited 的行为与原版一致，不新增全局 veto |
| 历史拒绝 | 第四次真实形状缺 proof 即拒绝；最终七 exited、worker0 不足以改判 |

- [ ] GREEN：重跑本文件测试，检查失败都被修正且不是通过删反例。正常/异常路径日志仅有 fake 调用。测试报告标明 pure fixtures，真实运行仍 NOT_RUN。
- [ ] root systematic review Task 1：查 bug、边界和 spec 一致；特别检查原 state 捕获 freshness、原 gap 不变、consumer 不信任 resolved flag、persistent reused 与原 catch 范围。修复实际发现后仅重跑受影响新测试。
- [ ] root 只提交这两个实现/测试文件；建议 commit `feat(diagnostics): prove bounded known-process terminal scan races`。记录实际 commit SHA 与 review 结论后才进入 Task 2；不移动旧 source held41。

## Task 2 — 固定 R4 依赖的 R5 continuation 与双层准入

**Files**

- Create: `scripts/guarded_terminal_scan_continuation.py`
- Create: `scripts/test_guarded_terminal_scan_continuation.py`
- Read only: `scripts/terminal_scan_proof.py` 与 spec 指定 R4 fixed absolute directory 的受 seal 保护定义。

**Consumes:** Task 1 已 review commit；原 R4 ordinary supervisor/continuation_common/owned_reload/reconcilable_helper、actual package import closure/manifest；全部四个失败的完整 pinned lineage；reload result `ff6ff0b8b356c1f889dea3e0b1d39d68c527678066390711c4f28f41907b410f`、readiness `1064eeaa41ac546ad9bd22d3ee05f5042be75f2423edda82f3f0137f0e60a74c`。实现期只使用 bounded fixture IO，不产生实际 preparation/decision/nonce/receipt。

**Produces:** 版本化 wrapper/CLI 和 outer record schema；新增实际方法/IO fakes 的 integration 测试。接口固定为 `load_sealed_r4(dependency_seal, *, io)`、`validate_r5_history(history_record, *, read_record)`、`validate_r5_admission(r5_attempt, legacy_context, history, *, observation, wall, monotonic)`、`run_one_attempt(r5_attempt_path, r5_attempt_sha256, *, io, wall, monotonic, check_only=False)`。CLI 接 `--r5-attempt`、`--r5-attempt-sha256` 与可选 `--check-only`；所有 dependency、legacy 路径/哈希、decision/history/clock/one-use 信息由 exact schema 提供。fixture 可 fake 明确的外部 legacy-gate 边界，但生产保留并执行真实 attempt_context/ready_context/current_gate；不声称完整旧链 pure PASS。默认 import 和无参数执行不得运行场景。

**Steps**

- [ ] 先为新增 loader/history/known-list/schema/admission/producer-consumer/main wiring 实际方法写 RED，使用 temporary files 与 IO/clock/Popen/psutil fakes。允许在明确标注的外部 legacy-gate 调用边界 fake，测试名称/报告须声明范围；不要求伪造旧 84 receipt、1016 FS/source-Git 历史完整成功 fixture。生产 actual attempt_context/ready_context/current_gate 必须保留真实引用，以静态/函数 identity 断言保证调用原定义；补可验证的真实局部入口负例。完整旧链成功 fixture 为 NOT_CLOSED。
- [ ] 从原 package manifest 解析封闭 dependency 集合，验证内容/mode/regular-file/no-symlink 与固定根；用独立命名空间受控加载原定义、核对 imports 的实际来源，拒绝同名 sys.modules 污染、缺失或改动依赖。不得复制原 package、修改 R4 文件、共享 module monkeypatch、改变 R4 `R` 或其 `folder.parent==R` 约束。
- [ ] 实现 `validate_r5_history`：保留 legacy 三 failedHistory 及 priorFailure；outer 增加第四失败 SHA `5ebf46ff9919847f0be320f7f55df255928b6e4b8c9b22c0f9059364909f0dfd` 和实际 started/attempt/runtime/result 链；绑定 reload started/result/readiness 完整链。原 FAIL 与 lifecycleAcceptable=false 不改判；已有 reconcilable_helper 仅用于 readiness。
- [ ] 从 pinned ownership records 推导 exact PID/birth union，核对预期 21+7+6=34，同时比较完整集合与 provenance、拒绝冲突，不能仅 count=34。加载完整旧 sequence/attempt/nonce deny-set；不得把 `0acf96f1...` 等前缀当完整 ID。
- [ ] 实现 exact outer schema 与准入：root decision 强绑定新 legacy sequence/attempt/nonce、fourth immediatePriorFailure、baseline previousResult=null、已部署 pins、新 supervisorSourceTIP/源 SHA、dependency seal、fresh strict-idle 与 known-quiescence。原 attempt_context(args, admission=True) 的真实返回须再次对应 outer 所绑定值。
- [ ] 保持 60s freshness、wall/monotonic 不倒退、lsof 5s 上限、viewer=relay=0、紧邻运行的同一 known-list 再核查。对 gone/zombie/stable-nonmatching birth 只证明旧身份静默；same-birth alive/unknown 拒绝。service identities 是独立保护活性，不是 quiescence 目标。
- [ ] 实现 main 的三接口绑定：worker instrument_registry→Task 1，sample→original；validate_owned_coverage→worker strict new consumer + sample original strict consumer；current_gate→先无条件调用真实原 current_gate(args, expected)，成功后追加 exact known-list/root decision≤60s、无时钟倒退检查。前两项改变覆盖策略，第三项只追加准入，不替换/弱化原 gate。最后一次 current_gate 成功后 main 按原次序 source_pins、marker、worker，不插入额外等待。测试调用次序、原 gate 失败传播及“前次新鲜、最后一次过期”拒绝。其余函数/validation stages/deadlines 不变；sample 委托用实际纯 consumer 检验，不伪造 ownership。
- [ ] 在通过全部 admission 后 exclusive 创建 outer one-use started marker，调用真实 legacy main；捕获 producer snapshots、consumer assessments 并写 bounded 新 outer result，SHA 绑定新 legacy result、proof、R5 history/code pins。legacy raw `owned.coverage`、`processDiagnostics`、`observedUnexpectedCoverage` 全保留。任何未完成/错误/结果缺失均失败，禁止自动 retry/next/clear。
- [ ] 实现 check_only=True/CLI --check-only 分支：执行真实 R4 完整只读 gate、R5 history/known-list/freshness/source pins，对当前 FS/metadata/Git/known-process/HTTP 使用原有有界检查；不进入 main 运行/写入路径、不启动 worker/browser/sample、不修改服务、不写 operational marker/result、不消费 one-use，仅 stdout 输出≤32768 UTF-8 bytes 的脱敏诊断。失败非零，成功只标只读集成通过。fixture 断言写入/启动调用账本为空；真实组合检查由 root review 后执行。
- [ ] 后续场景验证同序列 legacy **及** R5 predecessor，保留独立 root decision。整个 within/after 恢复场景无 sample；baseline/within/after/continuity=300/390/390/10800，worker deadline=duration+128、cleanup 原值不动；不改变 quality/FPS/codec/network/grace/阈值。
- [ ] 将下面有真实新增下游拒绝的 fixture 例子具体化。fixture 写新增 schema 所需 pinned JSON 并运行新增 actual validators；显式 legacy-gate 边界 fake 只服务 wiring 测试，不能据此宣布完整 R4 链成功。断言 Popen/写入账本与 original gate 函数 identity：

```python
def test_missing_fourth_identity_fails_before_worker(self):
    case = self.sealed_r5_case(legacy_gate_boundary="explicit-fake")
    case.remove_known_identity(pid=36482, birth=1792348652.844396)
    case.reseal_outer_fixture_only()  # no operational/history-source rewrite
    with self.assertRaises(RuntimeError):
        case.run_actual_entry()
    self.assertEqual(case.popen_calls, [])

def test_proof_acceptance_does_not_erase_legacy_gap(self):
    case = self.sealed_r5_case(worker_exit_race="absent",
                               legacy_gate_boundary="explicit-fake")
    result = case.run_actual_entry()
    self.assertEqual(result["classification"], "observed-qualification-completed")
    self.assertIn("observation-unavailable", case.legacy_result()["owned"]["coverage"])
    self.assertEqual(result["fullProcessTreeExit"], "unknown")
    self.assertEqual(case.sample_launches, [])
    with self.assertRaises(RuntimeError):
        case.run_actual_entry()  # exclusive marker: no second worker
    self.assertEqual(len(case.worker_launches), 1)

def test_legacy_pass_without_r5_predecessor_is_not_admission(self):
    case = self.sealed_r5_case(scenario="within-grace",
                               legacy_gate_boundary="explicit-fake")
    case.omit_outer_predecessor()
    with self.assertRaises(RuntimeError):
        case.run_actual_entry()
    self.assertEqual(case.popen_calls, [])

def test_check_only_does_not_consume_or_launch(self):
    case = self.sealed_r5_case(legacy_gate_boundary="explicit-fake")
    case.run_actual_entry(check_only=True)
    self.assertEqual(case.operational_writes, [])
    self.assertEqual(case.popen_calls, [])
    self.assert_original_gate_function_identities(case)
```

- [ ] 加入新增逻辑反例：旧 sequence/attempt/nonce、四历史顺序/缺失/未闭合、六 helper 缺失、count 相同但 identity 错误、reload/readiness 不一致、错误 root/import pollution/SHA drift、过期/clock reversal、missing proof/extra gap、sample coverage 异常、legacy成功但 outer缺失。main wiring 对原 gate 的 occupied/source/runtime/worker/terminal 失败须传播；可用明确边界注入这些失败，不能声称已纯测试实际全部 legacy 验证器。无 gap/完整 proof 的成功 fixture 仅验证新增组合与 main wiring，原完整成功链保持 NOT_CLOSED，交给独立真实 check-only。
- [ ] GREEN：仅运行新增测试，记录实际结果与 fixture 范围，不生成运行 receipt：

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s scripts -p 'test_terminal_scan_proof.py' -v
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s scripts -p 'test_guarded_terminal_scan_continuation.py' -v
```

- [ ] root systematic review Task 2：检查 loader/import closure、无旧目录修改、双层历史不混写、actual attempt_context/ready_context/current_gate 引用与调用次序、known union 精确性、最后一次 current_gate 的 one-use/TTL/strict idle 前置边界、proof到最终record链、check-only 无写入/无启动，以及 fixture 范围/NOT_CLOSED 是否诚实。修复 review findings 后重跑受影响新增测试。
- [ ] root 只提交这两个集成/测试文件；建议 commit `feat(qualification): bind terminal scan proof to guarded R5 continuation`。新 supervisorSourceTIP 从此实现分支实际 Git 版本绑定，不伪装成 deployedToolTIP282。
- [ ] root 安排新鲜、最强可用 agent 审全分支：bugs、architecture、docs sync、producer/consumer与运行准入组合；没有 reviewer 结论前不得实际运行。review 记录应按仓库 reports 约定版本化；本计划编写阶段不伪造该记录。

## Root 操作契约与完成条件

运行操作不是上述两任务的默认验收。root 完成代码/fixture/全分支 review 后，建立所需新 R5 private root 与显式 decision；可调用原 R4 prepare 工具在原 R 下创建新 legacy dirs，不能继续第四失败的 sequence。然后必须独立执行 CLI `--check-only`，用真实 R4 完整 gate 检查当前 FS/metadata/Git/known-process/HTTP；不 worker/browser/sample/service mutation、不消费 marker、不写 operational result，只有有界 stdout 诊断，root 可另存实际输出。该步骤补充完整旧链在 fixture 中 NOT_CLOSED 的真实组合检查。

check-only 通过后，root 另建 fresh run decision，再决定实际 run；实际 run 重跑全部原 gate、R5 gate，以及 main 最后一次 current_gate 的 exact known-list/root decision≤60s 检查。只读 preflight 不是 runtime qualification，也不豁免 TTL。额外 outer binding 保留四失败、reload/readiness、exact union 和 code pins；新 baseline 从头开始。每个场景只运行一次，下一场景重新 root 决策与 fresh strict-idle。旧 readiness 只证明历史已加载上下文，不能替代 fresh admission。

旧 source held41、Viewer fefc555、tools2822441、backenddfb154、module35、primary 1016 known-map 与四 dirty docs 不变；不再 sourcecopy/build/restart。任何实际操作都必须保留 5s lsof、60s freshness、300/390/390/10800 和原 grace/deadline，整个 recovery 无 sample。Host/tunnel/watcher 不动，不能用历史 RuntimeError 推断 grace 原因。

交付报告分别写明：spec/plan 已 review/提交、Task 1 fixture、Task 2 fixture（完整旧成功链 NOT_CLOSED）、全分支 review、root 真实只读 check-only、实际运行状态。当前实现测试、review、check-only 与运行均 **NOT_RUN**；pacing **NOT_ELIGIBLE**；fullProcessTreeExit 始终 unknown。不得把纯测试、代码提交、只读 preflight、旧 passive PASS 或后续 health=200 写成整体验收通过。
