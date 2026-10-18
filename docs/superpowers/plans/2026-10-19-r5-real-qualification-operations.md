# R5 root 操作配方（2026-10-19；仅待执行说明）

本文件不是执行授权、审查批准或运行证据。仅在最终全分支审查通过、root 核对实际最终提交且仍具有本轮运行授权后按次执行。编写此文件时未运行准备器、未创建 ID/nonce/decision/receipt、未执行代码加载或运行观测。下列命令、文件读取、SHA/mode/stat 核对与目录创建均为 root 的未来步骤。

## 1. 固定路径和不可混淆的来源

下列 shell 变量名只是后续命令的路径缩写，不能替换系统 HOME/CODEX_HOME：

```sh
R5_EXEC=/Users/macstudio1/.codex/worktrees/terminal-scan-exit/WebRemoteDesktop
R4_ROOT=/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm
R4_DEPLOY="$R4_ROOT/deployment-1a71096791fb71844ae08c95c50fb9cc"
R4_RECEIPTS=/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-guarded-recovery-root-private-20261018-_43p8cug
umask 077
```

- R4 package manifest：`$R4_ROOT/SHA256SUMS.json`，SHA256 `bcd09baaa0b0936e7424cd0dea5e51fb067503399ca49d3a236e789fc0fa6861`。
- frozen：`$R4_DEPLOY/frozen.json`，SHA256 `e5dfd7c1b9ef5a8f3a1f342268bd5784ce37d518a6e72b6b04384a0b9c957618`。
- 已加载 readiness：`$R4_DEPLOY/readiness-result.json`，SHA256 `1064eeaa41ac546ad9bd22d3ee05f5042be75f2423edda82f3f0137f0e60a74c`。
- asset review：`$R4_RECEIPTS/STARTUP-JOIN-R4F1-ASSET-REVIEW.json`，SHA256 `30bf20addd4a6afae627266b3b214037467dd4ab31ab2d5ed307c2f885cd6d97`。
- reusable offline integration envelope：`$R4_RECEIPTS/STARTUP-JOIN-R4F1-REUSED-ACTUAL-OFFLINE-INTEGRATION.json`，SHA256 `b63020856af50db03d7a16b2ff732d07491f7d2a6952158b79d41ea3b1b94b2c`。

该 offline envelope 的现存三个关联记录为：

| 字段 | 原绝对路径 | SHA256 |
|---|---|---|
| checker | `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm/mixed-native-integration.py` | `06ccee3f1cfeaa6a41c9d5ddbb3c1e37e581d8e17155d36ff59cad70b1646423` |
| independentReview | `/tmp/wrd-startup-join-r4f1-actual-assets-review-20261019.md` | `e055f48a0821ba07562fae66f5dd236ed46d50cc278a37eb44c4136b200325d5` |
| result | `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-guarded-recovery-root-private-20261018-_43p8cug/STARTUP-JOIN-R3B-MIXED-INTEGRATION-RESULT.json` | `cf484d747f310c4699535a035c68c0dd7b20bf6cf0a0c254cf1a262a8f86155b` |

原 `continuation_common.integration(reference, ref)` 确实要求 independentReview/checker/result refs 可读且 SHA 正确，checker SHA 等于原 package checker，result 精确为 `result=pure-native-startup-integration-only, methods=4, accepted=2, rejected=10, rows=1262` 且来源/componentPins/buildId 匹配。现存 envelope 的 buildId 是 `a3671ba674ad7516`，classification 是 `passed-offline-only`。root 应核对这条原独立审查仍适用于原 R4 资产与已加载 readiness 后，原样引用；不得把本次 R5 源码审查替换进这个旧 envelope，也不需为伪造“新鲜”而改写离线结果。若现存记录缺失、漂移或不适用，停下报告，不能凭本配方补签或替 root 决定可复用。

这份历史离线收据不证明本次真实原门禁链已经通过。R5 真实 `--check-only` 仍须执行。

## 2. 先准备静态材料，最后才签发 60 秒决策

建议顺序：最终 review/commit 固定 → 核对历史/完整 seal/codePins → 建私有外层目录骨架和 history → root 新 R4 sequence 决策并 prepare sequence → root 新 baseline attempt 决策并 prepare attempt → 构造 check-only 输入的静态字段 → 最后采真实 wall/monotonic 签发 check-only R5 决策 → 立即 check-only → root 独立判断 → 新 run root/新 R5 决策/新输入 → 单次 baseline。

root 将实际最终审查覆盖的完整 40 位 HEAD 写入 `codePins.supervisorSourceTIP`。不要把缩写 `55ceb32`、旧 held source `41c7b...`、工具 `282244...` 或臆测的最终提交填进去。两个文件的工作树 bytes SHA 必须等于该最终 commit 的 Git blob bytes SHA：

```json
{"supervisorSourceTIP":"<root 核对后的最终完整 HEAD>","files":{"scripts/guarded_terminal_scan_continuation.py":"<实际 SHA256>","scripts/terminal_scan_proof.py":"<实际 SHA256>"}}
```

`ProductionIO.verify_code(pins)` 将在运行时再次核验实际 execution worktree HEAD 和这两个文件；测试文件不进此 map。只 pin 新执行 worktree，原 primary/held source 和 R4 原 package 均保持不变。不要为配合 pin 改 primary、复制新工具到原 R4 或修改原 manifest。

从真实 check-only 开始至整条 baseline/within-grace/after-grace/continuity 序列关闭，冻结这个 execution HEAD 和两个 production 文件；期间连 docs-only commit 也不做。实际运行证据和进度先保存在独立私有 root，序列关闭后再归档提交；其他后续实现另用 checkout，不能使当前序列的 codePins 漂移。

所有 JSON 必须有限、有界、无 duplicate key、无原始输入/密码/token。统一使用现有 `compact(value)` 规则（sort_keys=True，separators=(',',':')，ensure_ascii=False，allow_nan=False，UTF-8）能避免 raw SHA 和 canonical SHA 混淆。普通 `{path,sha256}` 的 SHA 总是完整原始文件 bytes 的 SHA；historySHA256 和 dependencySealSHA256 是各自 parsed object 的 `sha(compact(...))`。

root 创建新的规范绝对私有路径，目录 0700、记录 0600、owned regular/no symlink；新文件用 O_EXCL，不覆盖。macOS 外层目录须使用 canonical `/private/tmp/...` 或 canonical `/private/var/...`，不能用 `/tmp/...` 字面目录传给 `check_directory`。旧 ref 中固有 `/tmp/`/`/var/` 路径保留原样，`read_file` 支持这些已知别名。

## 3. dependencySeal 的准确构造方法

无 `build_seal()` 之类现成 API。root 应从原 pinned manifest 和原源码 bytes 派生，不能用 fixture 或手抄不完整清单。

1. 核对原 R4 根目录 0700；核对原 `SHA256SUMS.json` SHA；读取 manifest 的全部 entry（最多 64），每个文件必须 0600 且 SHA 与 manifest 一致。
2. 对所有 `.py` entry 以去后缀名建 sources 表；AST 遍历必须使用 `ast.walk`，包括函数内部 import。
3. 从 `ordinary-continuation-supervisor`、`readiness_records`、`owned_reload` 三个入口递归；`ast.Import` 遍历 aliases，`ast.ImportFrom` 要求 level=0；只有名字存在 sources 表的 import 进入闭包。不可只检查顶层 import。
4. `files` 精确等于闭包的 `name+'.py' -> {sha256:manifest[name+'.py'],mode:384}`，不多不少。
5. 两个外部定义文件真实 mode 由 root 只读 stat 核对后填入（只能 384/420/493，即 0600/0644/0755），不能猜 mode：

```text
supervisor.path = /tmp/wrd-owned-turn-probe-private/supervisor.py
supervisor.sha256 = d03cc2025f41d26c0079d3f820fdb2cd5479ae14448fb1c6f91c4589d6bd5c7b
passive.path = /Users/macstudio1/AI/Claude/WebRemoteDesktop/scripts/passive_session_soak.py
passive.sha256 = b0a15095651c9147eb451b27eb815ec4ea4cc984f2d293d3617c4cee89a15426
```

seal 精确字段为 `root,manifestSHA256,files,supervisor,passive`；root 是上述原 R4 根，manifestSHA256 是固定值；supervisor/passive 各只有 `path,sha256,mode`。

现有验证接口是 `load_sealed_r4(dependency_seal, *, io)`。这会校验后编译原定义，不是纯 JSON builder；正式 CLI 自动调用即可。用全新 Python 进程，不能先加载原 R4 同名模块或测试 fixture；loader 会拒绝同名 `sys.modules` 污染。无需修改 sys.path/modules 来“修复”此检查。

## 4. 完整四条失败 history + reload + 34 身份

失败 SHA 按顺序固定：

```text
F1=2f0f2a2a0774b15f8b62adef72bb997d5deeae298a06640e71583d2d3cd33242
F2=af76a8dbeb32083ec9f8c630d7138362b3cd45d0f60ad16ad75d1a95fa025cd6
F3=5ef3358f1a1ee0bb5ef72e816952c5874d0826c8795c67616ba0a85ff73a42b9
F4=5ebf46ff9919847f0be320f7f55df255928b6e4b8c9b22c0f9059364909f0dfd
```

从原 manifest 所 pin 的三个 JSON 取 ref，保留它们原绝对路径和 SHA：

- B = `$R4_ROOT/legacy-deployed-reference.json` 的 `historical`。
- S = `$R4_ROOT/legacy-tool-history.json` 的 `records`。
- T = `$R4_ROOT/deployment-history.json` 的 `records`。

history object 只有 `schemaVersion:1, failures:[...], reload:{...}, knownIdentities:[...]`。

| failures 下标 | 精确 ref 字段与来源 |
|---|---|
| 0 | `frozen=B.frozen; started=B.oldMarker; runtime=B.oldRuntimeManifest; result=B.oldFailure; sourcePins={path:parent(B.oldFailure.path)/baseline-source-pins.json, sha256:读取 oldMarker/oldFailure 中相等的 sourcePinsSHA256}` |
| 1 | `sequence=S.toolSequence; attempt=S.secondAttempt; started=S.secondMarker; result=S.secondFailure; runtime={path:parent(S.secondAttempt.path)/runtime-manifest.json, sha256:第二 attempt.runtimeManifestSHA256}` |
| 2 | `sequence=T.thirdSequence; attempt=T.thirdAttempt; started=T.thirdMarker; runtime=T.thirdRuntimeManifest; result=T.thirdFailure` |
| 3 | 以下固定第四链 |

第一条实际 legacy schema 没有 sequence/attempt，绝不补造；其 frozen/sourcePins/started/runtime/result 与完整 runNonce 均受验证。第二、三条也从实际 record 读完整 IDs/nonce，不截断。所有实际存在的历史 ID 和 nonce 都进入 deny-set。

第四链原目录：
`/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm/sequence-ff601377b608c2c4b1b51e55123e2f20/attempts/f6e5f8e72e4195767164f168bcbe3550`

| 字段 | 文件（相对于上述目录） | SHA256 |
|---|---|---|
| sequence | `../../sequence.json`（在 ref 中展开为规范绝对路径，不能保留 `..`） | `dd8ae684c448549c1dc97052b9bc253b616eefd04ee5e8d3de608b157bf478be` |
| attempt | `attempt.json` | `d72f626c88d68766a5d62bdfd0243596f2298b2b96476e6378bf476728e4ef3d` |
| started | `qualification-started.json` | `61a1875a020f325d4609509a7f9570e740ee3c825af702efad4b20ecafdd1f5e` |
| runtime | `runtime-manifest.json` | `2002654ee48a6aa1485e670181dee94af59ca71963a845beb5b35bd75f23ae83` |
| result | `qualification-result.json` | F4 |

完整第四 runNonce `0acf96f102fcd33e8f17b884a75e93f7`；不得重用其 sequenceId/attemptId/nonce。

reload 四 ref 都在 `$R4_DEPLOY`：

| 字段 | 文件名 | SHA256 |
|---|---|---|
| started | reload-started.json | `9bf76ef5f8ce07a547b5602cc01844022591200d2aa7199a5351f7f3a91fb252` |
| result | reload-result.json | `ff6ff0b8b356c1f889dea3e0b1d39d68c527678066390711c4f28f41907b410f` |
| readinessStarted | readiness-started.json | `e7a0c4b040439acdc1f2386393b5297e4af162697b729588000a05615998ab3d` |
| readiness | readiness-result.json | `1064eeaa41ac546ad9bd22d3ee05f5042be75f2423edda82f3f0137f0e60a74c` |

knownIdentities 的派生顺序必须与真实 validator 一致：按 failures 顺序，对各 result 先取 `owned.identities`（role=worker），后取 `sampleOwned.identities`（role=sample）；最后取 reload result 的 `helper.ownership.identities`（role=reload-helper）。按 `(pid,birth)` union，保留 `parent,firstObservedEpoch,lastObservedEpoch`，冲突拒绝；每个来源追加 `{resultSHA256:<对应 result SHA>,role:<role>}`，不可丢来源或重复相同来源；最后按 `(pid,birth)` 排序。每行只有 `pid,birth,parent,firstObservedEpoch,lastObservedEpoch,sources`。原三次 union=21，第四=7，reload helpers=6，精确 union=34；只检查数量不够。

可在未来 root 构造阶段调用现有纯内容验证接口：

```python
# G 为从新执行 worktree scripts 导入的 guarded_terminal_scan_continuation；
# 不加载原 main，不使用 fixture；此段是未来说明，当前未执行。
io = G.ProductionIO()
validated = G.validate_r5_history(history_record, read_record=io.read_record)
# validated['deniedIds'] 用于新 ID 全量排除；
# validated['historySHA256'] 用于 R5 决策，
# history ref.sha256 另对实际持久化 bytes 计算。
```

真实函数签名：`validate_r5_history(history_record, *, read_record)`；不存在自动收集 history 的 production builder。上表给出了 root 组装来源。`read_ref(ref, read_record)` 才核验 ref SHA；单独 `io.read_record(ref)` 只负责私有文件 bytes/mode。

历史四次 FAIL、reload FAIL/helperLifecycleAcceptable=false、所有 raw gap 和 `fullProcessTreeExit=unknown` 全保留。readiness 只证明已加载上下文，不能代替本次新鲜 admission。

## 5. 新建 legacy sequence（原 R4 CLI）

root 现在才为新 legacy sequence/attempt/nonce 各产生不同完整 32 位小写十六进制随机值，排除 validated.deniedIds、所有已占用的新路径；本配方没有生成任何值。以下以 NEW_SEQ、NEW_ATTEMPT、NEW_NONCE 表示 root 后续实际值。

在新 root 私有准备目录写独立 sequence decision 0600（例如变量 R5_PREP_SEQ_DECISION 指向新文件），精确 schema：

```text
schemaVersion=1
kind="root-new-frontend-context-sequence"
sequenceId=NEW_SEQ
packageManifestSHA256=固定原 R4 manifest SHA
sourceTIP="41c7b0998859a7e9d088cefcc0f3a1eeab190684"
toolTIP="2822441791b59a021556c7e4eb24715df9d5b277"
deployment={frozen_dir:R4_DEPLOY, frozen_sha256:上表 frozen SHA,
            asset_review:上表原 asset review 绝对路径, asset_review_sha256:上表 SHA}
readinessSHA256=上表 readiness SHA
offlineIntegrationEvidence={path:上表 reusable envelope 绝对路径,sha256:上表 envelope SHA}
failedHistory=[F1,F2,F3]
automaticLaunch=false
```

不能重用原 `STARTUP-JOIN-R4F1-SEQUENCE-DECISION.json`，不能把 F4 插入原 R4 failedHistory。将新 decision raw SHA 放入 R5_PREP_SEQ_DECISION_SHA，执行一次：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B "$R4_ROOT/prepare-frontend-sequence.py" \
  --frozen-dir "$R4_DEPLOY" \
  --frozen-sha256 e5dfd7c1b9ef5a8f3a1f342268bd5784ce37d518a6e72b6b04384a0b9c957618 \
  --asset-review "$R4_RECEIPTS/STARTUP-JOIN-R4F1-ASSET-REVIEW.json" \
  --asset-review-sha256 30bf20addd4a6afae627266b3b214037467dd4ab31ab2d5ed307c2f885cd6d97 \
  --readiness-sha256 1064eeaa41ac546ad9bd22d3ee05f5042be75f2423edda82f3f0137f0e60a74c \
  --decision "$R5_PREP_SEQ_DECISION" --decision-sha256 "$R5_PREP_SEQ_DECISION_SHA" \
  --integration-evidence "$R4_RECEIPTS/STARTUP-JOIN-R4F1-REUSED-ACTUAL-OFFLINE-INTEGRATION.json" \
  --integration-evidence-sha256 b63020856af50db03d7a16b2ff732d07491f7d2a6952158b79d41ea3b1b94b2c
```

成功输出的 `sequenceDirectory` 和 `sequenceSHA256` 才是后续输入，记作 R5_LEGACY_SEQUENCE_DIR/SHA。目录应为 `$R4_ROOT/sequence-NEW_SEQ`。该原程序读取历史/deployment/readiness/离线证据并执行 real deployed_gate；它创建 sequence 元数据，既不是纯 fixture 也不是 qualification。失败保留现场，不覆盖重试。

## 6. 新建 baseline legacy attempt（原 R4 CLI）

在独立新 0600 文件写 root attempt decision，精确 schema：

```text
schemaVersion=1
kind="root-one-scenario-attempt"
sequenceId=NEW_SEQ
attemptId=NEW_ATTEMPT
runNonce=NEW_NONCE
scenario="baseline"
mode="relay"
origin="https://link.stockhub.wiki"
productTIP="dfb15434e79da90b803b763c533836e16c080c71"
toolTIP="2822441791b59a021556c7e4eb24715df9d5b277"
priorFailureSHA256=F3
failedHistory=[F1,F2,F3]
sourceTIP="41c7b0998859a7e9d088cefcc0f3a1eeab190684"
previousResult=null
```

使用新 decision path/raw SHA，不能重用原 `STARTUP-JOIN-R4F1-BASELINE-DECISION.json`：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B "$R4_ROOT/prepare-attempt.py" \
  --sequence-dir "$R5_LEGACY_SEQUENCE_DIR" \
  --sequence-sha256 "$R5_LEGACY_SEQUENCE_SHA" \
  --decision "$R5_PREP_ATTEMPT_DECISION" \
  --decision-sha256 "$R5_PREP_ATTEMPT_DECISION_SHA"
```

成功必须 actual exit 0、errorClass=null，且新 attempt `preparation-result.json` 是 attempt-prepared-not-run。保存输出的 attemptDirectory/attemptSHA256（R5_LEGACY_ATTEMPT_DIR/SHA），后续 `legacyAttempt.path` 为该目录的 `attempt.json`。

关键：原准备器先执行 sequence(...)（含 readiness/asset/source/history 校验）和 decision_and_predecessor(...)，这些前置步骤失败时尚未调用 reserve_attempt，也可能没有 preparation-result。只有 reserve_attempt 成功后，sequence 下 `attempt-baseline.json` reservation 才已消费，其后才继续本地/public/HTTP 等检查和证据准备。失败后必须按真实到达阶段与实际 reservation/attempt/preparation-result 文件判断，不能一概声称已消费或未消费；无论何种失败都保留原件，不删除、改写或自动重试。prepare 不运行 worker，但会核验 Host/idle、health、viewer HTML、当前 core SHA、源与资产等，并产生新的 origin/deployment/runtime evidence。

原 HTTP fetch 保持 User-Agent `Mozilla/5.0`、timeout=5、no redirect。root 先前诊断的 formal UA 403/1010 与 browser UA 200 不能用于跳过门禁或替换 receipt；如果正式 preparer 拒绝，按其真实失败停止，不更改 UA/Cloudflare/策略/tunnel，不生成“通过”收据。

runtime manifest 由原 preparer 真实签发，初始 6 小时 validity；原 admission 还要求创建距今 <=15 分钟，剩余 >= scenario budget+120 秒。不能通过编辑时间复用过期 runtime receipt；过期就停止，由 root 重新评估后续合法新 sequence，不自动循环准备。

## 7. 构造 check-only 外层目录、输入、决策

在 R4 外创建全新 canonical private `R5_CHECK_ROOT`，结构：

```text
R5_CHECK_ROOT/                              0700
  history.json                            0600（可引用事先在独立私有目录写好的 immutable history）
  NEW_SEQ/                                0700
    NEW_ATTEMPT/                          0700
      root-decision.json                  0600（最后才写）
      r5-attempt.json                      0600（引用该 decision 的 raw SHA）
```

`rootDirectory` 是实际 R5_CHECK_ROOT 绝对路径。basename 不充当身份，NEW_SEQ/NEW_ATTEMPT/NEW_NONCE 与刚准备的新 legacy 完全一致。外层不另造一套和 legacy 不同的身份。

共同 deployedPins 精确为：

```json
{"sourceTIP":"41c7b0998859a7e9d088cefcc0f3a1eeab190684","viewerSourceTIP":"fefc555aea9640b563bfd22f5b36b6b8ca6365ec","deployedToolTIP":"2822441791b59a021556c7e4eb24715df9d5b277","productTIP":"dfb15434e79da90b803b763c533836e16c080c71"}
```

外层 `r5-attempt.json` 只有以下字段：

```text
schemaVersion=1
kind="r5-terminal-scan-attempt"
rootDirectory=R5_CHECK_ROOT
sequenceId=NEW_SEQ
attemptId=NEW_ATTEMPT
runNonce=NEW_NONCE
scenario="baseline"
legacyAttempt={path:R5_LEGACY_ATTEMPT_DIR+"/attempt.json",sha256:R5_LEGACY_ATTEMPT_SHA}
history={path:实际 immutable history 路径,sha256:该文件 raw SHA}
dependencySeal=第3节完整 object
codePins=第2节完整 object
rootDecision={path:同目录 root-decision.json,sha256:新 decision raw SHA}
previousResult=null
immediatePriorFailureSHA256=F4
deployedPins=上述固定 object
```

先完成除 rootDecision 以外的静态数据、目录和核对。最后在同一次短 root 操作中读取真实 `time.time()` 和 `time.monotonic()`，写新 root decision（不复用任何先前 clock），计算其 raw SHA，立即写引用它的新 input 并启动 check-only。

root-decision.json 精确字段：

```text
schemaVersion=1
kind="root-r5-one-scenario"
rootDirectory,sequenceId,attemptId,runNonce,scenario,legacyAttempt,
codePins,previousResult,immediatePriorFailureSHA256,deployedPins
    = 与上述外层 input 完全相等的对应值
historySHA256=sha(compact(parsed history))
dependencySealSHA256=sha(compact(dependencySeal))
issued={wall:真实 time.time() 值,monotonic:真实 time.monotonic() 值}
automaticLaunch=false
```

automaticLaunch=false 不阻止 root 明确单次 CLI；它禁止隐式继续。不要加“approvalId”、expires、scenario 到 marker 等新字段；现有 exact schema 会拒绝。

## 8. 真实 check-only：无 marker/result/worker，仍执行完整真实门禁

变量 R5_CHECK_INPUT 指向上述规范路径，R5_CHECK_INPUT_SHA 是文件 raw SHA。执行一次：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B "$R5_EXEC/scripts/guarded_terminal_scan_continuation.py" \
  --r5-attempt "$R5_CHECK_INPUT" --r5-attempt-sha256 "$R5_CHECK_INPUT_SHA" --check-only
```

需保留 exit code 和有限 JSON stdout；若落盘，用新独立 0600 exclusive 诊断路径，不能覆盖任何输入或 decision。CLI 成功摘要为 classification=read-only-integration-passed、checkOnly=true、qualification=NOT_RUN、fullProcessTreeExit=unknown。函数返回还包含 oneUseConsumed=false，但 CLI 摘要不输出该字段。

真实调用顺序含 sealed full closure/原 definitions、新代码 Git pin、原 `attempt_context(..., admission=True)`、完整 history、R5 admission/34 known quiescence，再原 `current_gate` 与原 `source_pins`，最后再次 R5 fresh admission。它有真实只读 FS/Git/process/network 成本，不能称为“零观测”；零操作仅指不运行 scenario、不写 marker/result/proof、不消费 one-use、不拉 worker/sample。

60 秒是从 root decision 的 issued 到最后 fresh admission 完成，wall 与 monotonic 都必须满足且不倒退；包括 preceding expensive source/asset checks 消耗的时间。不能先花很久跑真实门禁，再把旧 decision 时间解释成新鲜，也不能绕过 source_pins 后的最终校验。lsof 原 timeout=5 保持。若 60 秒不足，失败即保留材料；不能调 TTL、伪时钟、缓存新鲜观测或靠 fixture 通过。root 可据失败定位耗时，再独立决定是否建立新的未消费外层决策；不是自动 retry loop。

## 9. check-only 通过后，独立新 run root + 新 decision + 单次 baseline

check-only 成功不自动授权/启动运行。root 重新确认最终审查、当前条件和授权，核对 legacy attempt 仍未有 `qualification-started.json`/`qualification-result.json`，runtime 仍满足原 15 分钟/剩余预算等全门禁。

- 创建全新 canonical `R5_RUN_ROOT` 0700 和 `NEW_SEQ/NEW_ATTEMPT` 0700；与 check root 分离。
- 可以引用同一份未消费的新 legacy attempt（同 NEW_SEQ/NEW_ATTEMPT/NEW_NONCE）、同 immutable history/seal/codePins；不能使用第四次历史失败 attempt。
- 新 run input 的 rootDirectory 改为 R5_RUN_ROOT；rootDecision 引用新 run decision 文件，decision 的 rootDirectory 同步改变。baseline previousResult 仍 null。
- 最后采新的真实 wall/monotonic，写全新 run root-decision.json0600 和新 r5-attempt.json0600；全部 refs/hash 重算相应新 bytes。不能覆盖 check-only input、decision 或诊断输出，不能复用旧 issued。
- 立即运行唯一 baseline CLI，不带 --check-only：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B "$R5_EXEC/scripts/guarded_terminal_scan_continuation.py" \
  --r5-attempt "$R5_RUN_INPUT" --r5-attempt-sha256 "$R5_RUN_INPUT_SHA"
```

run 会重新执行完整检查，不沿用 check-only 观测。在调用原 main 前 exclusive 写 `r5-started.json`；原 main 会在其原 gate/source_pins 后写 legacy `qualification-started.json`。source_pins 包装始终调用原函数，每次原函数返回后才做对应检查；startup fresh admission 在 expensive source validation 后完成。最终 source_pins 区分已开始 marker 状态，不要求长 scenario 全程维持 60 秒启动 TTL。

一旦外层 started 存在即 one-use 已消费，即使原 main 尚未写 marker或随后失败，也不能删除/重试相同外层。原 marker、result、proof 路径不可覆盖。结果 `r5-result.json`、可用时 `terminal-proof.json` 均 exclusive0600；没有 proof 或 legacy 失败不能包装成成功。只根据 actual exit/完整结果归类；stdout 不代替原 result 与 proof 审核。

只跑 baseline（原 budget 300 秒），本步骤不自动执行 within-grace/after-grace/continuity。它们的原 390/390/10800 秒预算、worker deadlines、sample 约束和所有阈值保持。后续若另获 root 每次决策，应继续使用成功 run root 的同一 sequence：outer previousResult 指向该 root 内准确前一 scenario 的 r5-result；legacy decision.previousResult 指向对应原 qualification-result。五条显式 scenario 记录（outer result、legacy result、prior outer input、root decision、原 legacy qualification-started）都必须等于预期前一 scenario。外层 r5-started 原 schema 无 scenario，仍完整验证 kind/version/exact keys/oneUse/hash绑定，不能跳过或加字段。

## 10. 完成边界与接口速查

现有 public interfaces（按源码原签名）：

```python
load_sealed_r4(dependency_seal, *, io)
validate_r5_history(history_record, *, read_record)
validate_r5_admission(r5_attempt, legacy_context, history, *, observation, wall, monotonic)
run_one_attempt(r5_attempt_path, r5_attempt_sha256, *, io, wall, monotonic, check_only=False)
```

root 操作应以现有原 preparer CLI + 新 CLI 为主，不自造第四 hook、替代原 main、假 legacy_context 或预制 admission receipt。原 current_gate/attempt_context/ready_context 和所有质量门禁仍是原引用。

任何历史失败不改判，任何未测项保持 NOT_RUN/unknown。成功的新 terminal proof 只支持前瞻性窄 policy，不是 complete process-tree exit 证明。运行不需要且不授权改 primary/held source、build、重启 Host/Signal、watch/tunnel 或 Cloudflare policy。

若正式 preparer/check-only/启动门禁失败，保留 exact 新路径与有限错误摘要，明确到达步骤和 one-use 是否已消费，交由 root 判断；本配方不预先给出运行通过结论。
