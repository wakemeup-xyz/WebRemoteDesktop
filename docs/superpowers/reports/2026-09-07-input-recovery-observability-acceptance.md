# 输入恢复与诊断验收报告

日期：2026-09-08
范围：`codex/input-recovery-observability` 的输入恢复、离线交互验收、R4 继续修正与用户授权的 main 集成/本地服务发布。
基线 SHA：`39fa1eadc89b00546e2bf66f1ed1d1e6f892ca42`。
Task 4 历史交付版本：`2ddbc15a4a8a11f5a3d58a1cd0b473e882be7d6e`；它以 `cbefccbacb3c036c2a4cdc5cf1c3cfbde2bfabae` 为父提交，随后 `0c05d6181df4acbd1ce82192a8af33bf9eedf748` 完成文档 provenance/link 修正。
本报告随后记录的 ONE final fix wave（R1-R8）实现提交为：`cc9ef32915c2988215cf655f68efdcca329d1bf1`（`fix(input): close pause resume observability findings`）。该提交只包含 brief 允许的 Viewer/Signal/离线 acceptance 代码与 focused tests；本报告和 evidence 更新在该实现提交之后完成。

本报告与 [输入恢复与诊断设计 Spec](../specs/2026-09-07-input-recovery-observability-design.md)、[执行计划的 Task 4 锚点](../plans/2026-09-07-input-recovery-observability-plan.md#task-4-acceptance) 相互对应。安全摘要见 [offline-chromium-summary.md](evidence/2026-09-07-input-recovery-observability/offline-chromium-summary.md) 和 [browser-ingestion-summary.md](evidence/2026-09-07-input-recovery-observability/browser-ingestion-summary.md)。早期反例仍保留在 [resume-input-diagnosis](2026-09-07-overall-completion-and-resume-input-diagnosis.md)、[2026-09-05 mobile review](2026-09-05-mobile-touch-keyboard-logic-review.md) 和 [2026-09-06 remediation report](2026-09-06-mobile-input-interaction-remediation-acceptance.md)，没有被本报告改写为新代码的 PASS。

## 当前裁定：R4 关闭，已合入 main、push 并重启本地服务

用户于 2026-09-08 明确要求“解决残余问题，合入main push。重启服务”，因此本次只续做此前未关闭的 R4，不重做已经接受的七项修正。`gpt-5.6-luna / max` 交付 `22771b62ea9cbea0cc6e93cfde6a67a1622fa36e`，`Input.setupTextInput` 的 submit click 与 `compositionend` 共用 `commitWithTrace`，原自动提交与业务门禁不变。

主线程在该代码上验证：Viewer **794/794**、Signal **349/349 + build**、Python **99/99**、CLI **4/4**／离线 Chromium **23/23 场景**；checks 非空且全 true、网络请求为零。原保留反例未改动，结果转为 **1 send / originating DOM true / 1 timeout / 1 incident**；再次确认上下文清理和敏感金丝雀不外泄。实现 commit 的五个文件 blob 与主线程测试时一致。

新增 durable `modal-composition-trace` 场景覆盖自动提交、send/timeout 的来源事件、只产生一份 incident、清理、关闭、后续 submit 不重放和隐私。主线程另用真实 Chromium DOM 检查立即 submit、不支持 viewport 拒绝保留草稿、观察器异常不影响单次发送、普通本地输入不发送，四项全部通过。详细命令和安全结果见 [R4 closure evidence](evidence/2026-09-07-input-recovery-observability/r4-closure-summary.md)。

独立 scoped re-review（`gpt-5.6-sol / high`，依据小范围复审的模型分级）完整审查 `a00a4c4..22771b6`：**R4 ADDRESSED，无新增 Critical/Important/Minor 破坏**；主线程核对真实代码、测试版本及独立反例后接受，原八项发现全部关闭。Reviewer 注意到旧 CLI 总数门槛仍为 `>=22`；新第23项名称有独立必需断言，主线程实际核对23项全部执行，故不是 R4 遗漏或新增破坏，不扩展本次范围。随后已完成下述 main 合并、push 和本地服务发布。真机、系统 IME、Quartz、实际公网 Viewer 输入、live watcher 故障验收仍是 **NOT RUN**。

## main 集成与本地发布验证（2026-09-08）

合并提交为 `83a9f79f5b7385706463026479e6c55ac3a7d19c`，父提交分别为原 main `39fa1eadc89b00546e2bf66f1ed1d1e6f892ca42` 和已验收分支 `c02de732aafde1c2e07b5d4ebd3f673a4ec875e5`；后者包含 R4 实现 `22771b6` 与验收文档。合并后的 tracked tree 与被审分支完全一致。`git push origin main` 成功，远端 main 已到达该合并提交；本节发布记录在其后的独立 docs-only 提交中补齐，不再改变已发布的生产代码。

### 合并后主线程重新验证

| 层级 | 合并后实际命令/验证 | 结果 |
|---|---|---|
| Viewer | `node --test --test-reporter=dot web-client/js/*.test.js web-client/css/*.test.js` | 794/794，exit 0 |
| Signal | 在 `signal-server` 目录执行 `node --test --test-reporter=dot` | 349/349，exit 0 |
| Build | 使用仓库导出的 `buildWebClient`，读取 main 的 `web-client`，输出到独立临时目录 | 构建成功，33 源文件/5 资源，core hash 与已审分支相同 |
| Python | 与 R4 evidence 相同的六文件 `python3 -m pytest -q` 命令 | 99/99，2.70s，exit 0 |
| Browser CLI | `node --test scripts/mobile-input-interaction-acceptance.test.js` | 4/4，95.802s；Chromium 23/23，checks 非空且全 true，network 0 |
| 原始 R4 反例 | 不变的 `reproduce-modal-composition.py` | 1 send / originating DOM true / 1 timeout / 1 incident；清理与隐私通过，exit 0 |

合并后没有提前在正在服务的 main 上运行 `npm test` 的 pretest 以替换线上资源：Signal 全套 Node 测试与临时输出构建分别执行，正式资源由授权的 restart-local 流程构建交付。离线测试不读取运行凭据、不连接现场 Viewer，也不调用 Quartz。CLI 的一次产物经独立解析核对，不为读取结果重复启动浏览器。

### 重启与 HTTP/进程证据

从 main 执行 `python3 skills/webremote-service/scripts/wrd_service.py restart-local`，exit 0；仅重启本地 Signal/Host，Host 由既有 `scripts/restart-host.sh` 管理。2026-09-08 16:07（Asia/Shanghai）后的检查结果：

- Signal PID 从 `30999` 更新为 `31404`，Host 从 `31059` 更新为 `31455`；新进程 cwd 分别是 main 的 `signal-server` 和 `python-host`。旧进程已退出，唯一 overlay PID `31517` 的父进程是新 Host，无残留孤儿 overlay。
- `/health` HTTP 200、`status=ok`；`/api/status` HTTP 200、`hostOnline=true`。服务状态命令确认两个本地进程与健康检查均正常。
- Viewer HTML HTTP 200，引用 `assets/desktop-core.d6d92baf5dae0695.js`；实际经 HTTP 返回的五个 manifest 资源全部 200 且与 main 新构建逐字节一致。core SHA-256：`d6d92baf5dae06953af3985685fcc076ff570688f50e468ea3a27c7a05d5af47`。HTML 使用重新验证缓存策略，hash 资源使用 immutable 策略。
- Viewer 与 Terminal admin 的登录及认证验证均 HTTP 200 且成功；仅验证角色认证，未新建 Viewer Socket、实际输入或 PTY。密码从本机运行配置读取并单独向用户交付，不写入本文或证据文件。
- 正式入口 `https://link.stockhub.wiki` 经 `scripts/wrd_entry_health.py` 检查为 `state=deliverable`、HTTP 200、`reason=ok`；当前 safe URL 可达。此为 HTTP/服务就绪证据，**不是公网 Viewer 输入、媒体、Quartz 或 watcher 故障验收**。
- `/tmp/wrd-safe-current-url.txt` 在前后均为 53 bytes，SHA-256 始终为 `be9045369c7a88a7cb2807b4792546c1a5f20d3a3ce7cc1ff767417e9c0ac166`。quick tunnel PID `3618` 及另一个既有 cloudflared PID `78259` 的 PID/启动时间均未变；没有停止、重启或重建任何 tunnel。

helper 在已停止旧 LaunchAgent 后打印两条旧 Signal PID 的 `No such process`；以上新进程、健康和实际资源检查均通过，因此这是清理旧 PID 的非阻断提示，不是忽略启动失败。已有 Viewer 页面仍需用户刷新才能加载新 JS；服务重启不替换旧标签页内存中的代码。后续仅补文档，无需第二次重启。

### 用户工作区保护

main 原有 dirty 的 `docs/archive/worklogs/review-anchors.md` 保持逐字节不变，未纳入本次提交。四份原 untracked 诊断文件与待合入文件完全一致；先备份并逐字节验证，Git 因 untracked 覆盖保护拒绝第一次合并后，仅把这四份原件移入 `/tmp/wrd-main-input-preserve.8WeMbI/originals/`，再正常合并，并验证合并所得四文件与原件相同。备份及 dirty 文件副本可恢复；其余原有未跟踪证据、图片和浏览器产物未纳入提交。服务日志允许正常轮转，不宣称日志备份字节不变。

本计划的 79 个 ignored 审计文件（含 scratch 排除规则）已归档至 `/tmp/wrd-main-input-preserve.8WeMbI/input-recovery-observability-audit.tar.gz`，逐文件与归档内容比对一致，且检查不含运行密码；归档 SHA-256 为 `ceb708ea513437bc9ac5f6a77df712ba1466dcab35fb8af8089741e0b2c5f1bf`。随后以普通 `git worktree remove` 和 `git branch -d` 清理本次 clean、已合并的工作树/分支；其提交保留在 main 历史，审计可从本机临时归档恢复，必要的长期安全证据与全部五项 Rulings 已留在版本化报告中。未清理其他工作树或用户产物。

## 历史裁定：上一轮未通过（R4 Important/P2）

2026-09-08 主线程与独立 reviewer 对最终修正交付 `2b49d5918063ead78f0a52cc6941df0a09448de4` 的结论一致：R1、R2、R3、R5、R6、R7、R8 已关闭；R4 的 toolbar/submit click 已修，但 **文本弹窗 `compositionend` 自动提交仍缺少 originating DOM eventId，ACK timeout 不触发 incident**。`web-client/js/input.js:2714` 仍直接调用 `commit()`。这不是新发现的范围外需求，而是原 R4 的遗漏入口。

因此：输入恢复主干及诊断主体已实现，规定套件均通过，但**最终验收 FAIL，不标记完成或可合并**。没有合入 main、push、重启/启动服务或 tunnel，也未读取凭据、连接现场 Viewer。主线程只读复核 main 仍为基线 `39fa1ea`，原 dirty/untracked 文件保持未动。

完整审查采用 `39fa1ea..0c05d61`，一次最终修正采用 `0c05d61..2b49d59`；独立 scoped re-review 完整读取后者 1919 行，未发现新 fix-induced breakage 或范围外问题。Reviewer 实际模块探针与主线程独立 Chromium 反例均证明同一残余。按 `superpowers:subagent-driven-development` 的一次最终修正上限，本轮记录未关闭问题并保留分支/scratch，不再追加第二个修正波次；这不是将 P2 豁免为可接受完成。

### 主线程独立验证

下列 fresh runs 使用 `cc9ef32915c2988215cf655f68efdcca329d1bf1` 的已提交代码；已核对它到最终被审交付 `2b49d59` 仅变更两份文档，因此代码/测试版本一致。最终报告收尾也不修改生产代码。

| 层级 | 基线 | 本轮主线程结果 | 边界 |
|---|---:|---:|---|
| Viewer Node | 718 | 791/791 PASS | 37 个 test 文件，dot 无失败/取消标记，exit 0 |
| Signal Node + build | 339 | 349/349 PASS | 0 fail/cancel/skip，25.436s；本地 pretest build 成功 |
| Python 输入/媒体/诊断 | 84 | 99/99 PASS | 2.78s，native/socket 外部边界替代，不是 Quartz 实效 |
| 完整浏览器 CLI | 12 场景 | 4/4 tests，22/22 场景 PASS | 93.357s；checks 非空且全 true；network 0 |
| 补充 modal compositionend | 未覆盖 | FAIL | 1 send / 1 timeout / 0 incident，eventId 缺失 |

完整命令见下方 Required matrices；CLI 命令为 `node --test scripts/mobile-input-interaction-acceptance.test.js`，复用其一次实际浏览器运行核对 artifact，不为读取 artifact 再运行一套浏览器。

主线程另外重新验证：Socket 断开/异常各一条失败 enqueue、无新 ACK waiter；五类 toolbar/submit 操作正确关联并仅生成一个 incident；合法 reset 失败原因经过 Input/trace/Signal/UI 保留；viewport veto 保留；空上下文提示非空、正常 composition 静默、失败草稿不重放；mouse/key/touch 的 release-only 丢 ACK 各为 2 sends/1 down ACK/1 timeout/1 incident；真实 blocked-gate 用户输入产生一次异常诊断且不发送；旧 cumulative ACK 不清理新 reset，双 owned ACK 后允许新输入；实际 Viewer reset 通过真实 Node/Python wire validators。

本地 built graph 33 个文件、manifest 5 个 asset 均存在，InputTrace 早于 Input，critical recovery、deferred Diagnostic、Terminal FSM、body recovery UI 和单一 external script 均验证通过。此项不证明线上资产已更新。既有 STUN `fetch is not defined` 与 Signal negative-path console 是基线噪音；新 counterexample FAIL 单独列出，不以绿测覆盖。

### 上一轮唯一未关闭项的保留复现

[reproduce-modal-composition.py](evidence/2026-09-07-input-recovery-observability/reproduce-modal-composition.py) 复用现有 OfflineFixture，不复制浏览器 harness。它驱动实际 modal 打开、DOM compositionstart/fill/compositionend，扣留 ACK 3300ms；没有直接改生产 recovery 状态，也不取消自动提交行为。此处是 Chromium DOM 事件处理验证，**不是系统 IME 真机验收**。

从仓库根目录执行：

```text
python3 docs/superpowers/reports/evidence/2026-09-07-input-recovery-observability/reproduce-modal-composition.py
scope=offline-synthetic case=modal-compositionend
writes=1 originatingDom=false timeouts=1 incidents=0
contextCleared=true artifactSafe=true network.requests=0 network.sensitivePayloads=0
exit=1
```

后续最小修正应让 submit click 与 `compositionend` 共用真实提交归属和 finally 清理，保留已有自动提交、至多一次业务发送、草稿/Terminal/旧身份排除规则；将此反例转为 GREEN 并增加对应 durable 回归，再跑受影响测试及 scoped review。不得通过删除/跳过本反例、取消自动提交或放宽 privacy/gate 来声称关闭。

## 历史离线交付的结论与边界

- 原 Task 4 delivery 的严格离线 Chromium 运行产出 `scope=offline-synthetic`，20/20 场景 `PASS`；本轮 final-fix 提交后的最新 durable 运行扩展为 22/22 场景 `PASS`，每个场景的每个 check 均为 `true`，进程 exit 0。
- 离线页面只加载仓库源码；所有浏览器外发请求由 deny-by-default route abort，最终观察到 `network.requests=0`、`network.sensitivePayloads=0`。后一个字段只是请求 URL/body 的有界敏感标记计数，不是通用秘密检测；artifact 的隐私结论来自 allowlist 场景摘要测试和唯一敏感金丝雀不出现在序列化结果中的断言。
- 所有新增场景都通过真实 locator、真实 DOM 事件和实际 `__offlineWire` 副作用驱动；没有直接写生产 recovery 状态，也没有用模拟成功状态替代 ACK、timeout 或 incident。
- 这不是 physical device、系统 IME、Quartz native effect、live/public Viewer、正式 tunnel、watcher fault、merge/push/restart/deployment 验收。它们保持 `NOT RUN`，不因 exit 0 或 VM/单测通过而升级为完成。

## Task 4 RED → GREEN

先运行既有脚本帮助：

```text
python3 scripts/mobile_input_interaction_acceptance.py --help
usage: mobile_input_interaction_acceptance.py [-h] --out OUT
                                              [--browser {chromium,webkit}]
```

先在既有 CLI 测试上加入本任务的严格 contract，再运行：

```text
node --test --test-name-pattern='writes safe scenario summaries' scripts/mobile-input-interaction-acceptance.test.js
```

RED 观察：既有 fixture 只有 12 个场景，新断言 `assert.ok(artifact.scenarios.length >= 20)` 失败；这证明新增 acceptance 尚未被旧 artifact 误报覆盖。此前直接运行扩展前的浏览器脚本也在真实生产 shape 校正前暴露了 `getDesktopInputGateSnapshot` 旧 `{active:true}` fixture 与已过期 `resetCancelsDraft` 断言，未通过绕过生产 gate 的方式隐藏。

GREEN 的同一 CLI 测试（没有第二次启动同一浏览器套件来检查 artifact）：

```text
node --test --test-name-pattern='writes safe scenario summaries' scripts/mobile-input-interaction-acceptance.test.js
✔ offline acceptance CLI writes safe scenario summaries without secrets or payloads
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

该 Node 测试把一次真实 CLI 运行作为验收测试本身；随后只为记录最终
`traceEvents` 快照计数修正后的当前 artifact 运行了一次直接 CLI 命令，没有
再启动浏览器套件来重复检查同一 artifact。最终 artifact 的所有 scenario
`checks` 非空且全为 `true`，由下方独立 JSON 解析核对。

Task 4 delivery 的历史离线脚本：

```text
python3 scripts/mobile_input_interaction_acceptance.py --browser chromium \
  --out /tmp/task4-final.json
```

独立解析 JSON 的结果：

```text
scope=offline-synthetic browser=chromium scenarios=20 (historical delivery run)
network.requests=0 network.sensitivePayloads=0
all_status_pass=True all_checks_true=True
exit=0
```

缺运行时和启动后异常仍由脚本区分：缺 Chromium/WebKit runtime 写 `NOT RUN` 并 exit 2；浏览器已经启动但场景异常写 `FAIL` 并 exit 1。严格测试还断言每个 scenario 都是 `PASS`，而不是只看 exit code。

## 历史 ONE final fix wave：R1-R8

本轮先以 base `0c05d6181df4acbd1ce82192a8af33bf9eedf748` 的真实离线 Chromium/module seam 建立 RED，再在 `cc9ef32915c2988215cf655f68efdcca329d1bf1` 工作树验证 GREEN。所有探针只输出布尔值/计数；scratch probes 不属于交付命令，也未被提交。

| Finding | GREEN evidence in this wave |
|---|---|
| R1 failed enqueue | `root-final-enqueue-probe.py`：disconnected/throwing Socket 各 `failedEnqueues=1`，`acceptedWrites=0`、`pendingAcks=0`，emit `0/1`，无敏感 artifact；focused Input tests also cover missing/throwing DataChannel and generic mouse/command exceptions with original returns/rethrows. |
| R2 reason/UI parity | `root-final-reason-probe.py`：真实 mouse reset `execution-failed` 的 producer/trace/Signal reason 与 UI execution explanation 均 `true`；真实 viewport veto 在 producer/receiver 均保留；新增 finite `unsupported-code`/reset-ACK mappings and suffix/object/list canaries are rejected. |
| R3 lifecycle history | focused `input-recovery.test.js` drives real `markMediaAttemptReady` after click/ACK, repeats unchanged readiness 99 times without lifecycle flood or DOM-history eviction, then observes changed reason/attempt/state. |
| R4 remote ownership — PARTIAL | `root-final-remote-action-probe.py`：showDock/copy/enter/modal submit 各 1 write/1 timeout/1 incident，rightClick 2/2/1；这些入口正确关联。最终新增的 actual compositionend 反例仍为 1/1/0、eventId 缺失，R4 未关闭，见最终裁定。 |
| R5 empty context | `root-empty-context-ui-probe.py`：empty draft remains fail-closed, notice visible with `textLength=17`，retry/draft controls hidden；message is passive and does not request an unavailable button. |
| R6 receiver drops | Signal focused tests prove 300 in → 256 out adds 44 receiver drops to client 7 (`51`), valid byte clipping increments actual drops while keeping `<256` events and `<=64 KiB`, and the counter saturates at `0x7fffffff`. |
| R7 durable ingestion | `python3 scripts/mobile_input_interaction_acceptance.py --browser chromium --out /tmp/wrd-input-final-fix-cli-v2.json` includes a real producer→`ingestDiagnosticPayload` scenario with persistence disabled and deny-by-default network. Latest scenario: 5/5 accepted sends correlated, 18/18 trace events retained, recovery waiting/gate blocked and surface state preserved, `network.requests=0`, `sensitivePayloads=0`. |
| R8 exact draft | The same durable CLI compares the exact in-browser draft before reset, after reset, and after four canceled-drain frames; latest result has `deletionBatches=16`, equality/no-replay/fail-closed checks all `true`, with no raw text exported. |

Targeted GREEN outputs included:

```text
node --test --test-name-pattern='diagnostic reason allowlist|reset ACK rejection reasons' web-client/js/input.test.js
2 pass, 0 fail
node --test --test-name-pattern='owned reset rejection ACK' web-client/js/input-recovery.test.js
1 pass, 0 fail
node --test --test-name-pattern='finite reset ACK reasons' web-client/js/input-trace.test.js
1 pass, 0 fail
NODE_PATH=/Users/macstudio1/AI/Claude/WebRemoteDesktop/signal-server/node_modules \
  node --test --test-name-pattern='diagnostic reason sanitizer' signal-server/test/diagnostic.test.js
1 pass, 0 fail
```

Required final matrices on the implementation commit:

```text
node --test --test-reporter=spec web-client/js/*.test.js web-client/css/*.test.js
791 pass, 0 fail, 0 cancelled, exit 0
NODE_PATH=/Users/macstudio1/AI/Claude/WebRemoteDesktop/signal-server/node_modules \
  npm --prefix signal-server test
349 pass, 0 fail, 0 cancelled, exit 0 (pretest build:web exit 0)
node --test scripts/mobile-input-interaction-acceptance.test.js
4 pass, 0 fail, 0 cancelled, exit 0
```

The final-fix implementer did not rerun unchanged Python. The primary later
freshly ran the complete 99/99 Python matrix on the same committed code, as
recorded in the final ruling above. No service, tunnel, native action, live
Socket, or public path was used.

## 历史 22 个离线场景结果

本轮新增第 23 项 `modal-composition-trace`：实际 `compositionend` 产生 1 次发送、1 次超时、1 份 incident，send/timeout 均保留 originating DOM，后续 submit 无重放。其余下列 22 项已在本轮完整 CLI 中重新运行通过。

| 场景 | 结果 | 关键实际证据 |
|---|---|---|
| `focus-continuity` | PASS | 120 帧内焦点/组合态/门禁保持，工具栏导航实际成功 |
| `text-edit-transaction` | PASS | 正常 composition 不显示恢复提示；部分失败保留草稿；16 步删除事务可取消且 reset 不重放 |
| `physical-keyup-release` | PASS | 物理 modifier down/up、textarea batch 与 tracked keyup 实际平衡 |
| `surface-confirmation-gate` | PASS | surface down/up ACK、几何 reset、失败草稿和显式 retry 均由实际 wire 结果确认 |
| `modal-context-change` | PASS | modal 提交/取消、compositionend 和失败值保留均实际驱动 |
| `collapse-reopen-context` | PASS | 收起/重开不重放旧文本，新基线后实际输入成功 |
| `virtual-modifier-release` | PASS | 虚拟修饰键、composition/pending/uncertain 三种释放边界均清除一次 |
| `unsupported-viewport-continuity` | PASS | 已开始手势在窄视口继续，新的不支持输入被拒绝且草稿可显式重试 |
| `recovery-layout` | PASS | 1440x900 desktop、390x844 phone、1024x768 root fullscreen 均显示可读且在视口内的 waiting 提示；每种布局均实际 fresh mouse down/up 与 keyboard down/up，root fullscreen 下 status/chrome docks 隐藏 |
| `retry-button` | PASS | 狭窄 phone 的实际 retry locator 在 3200ms 失败后发 exactly two owned resets、无普通输入重放，实际新 click/key 为 1/1/2 |
| `trace-observability` | PASS | 同一生产 `Input`/collector；DOM pointer/keyboard、4 个 send/ACK 关联、allowlist、bounded hash、无 pending ACK 均通过 |
| `timeout-incident-eligibility` | PASS | physical=2 writes/2 timeouts/1 incident；touch=2/2/1；IME=1/1/1；每个 delayed write 都有 originating event identity |
| `deferred-incident-eligibility` | PASS | long-press=1 send/1 timeout/1 incident/0 ACK；drag-start=1/1/1/0；17-step delete drain=17 sends/1 timeout/1 incident，前 16 个同步 ACK，最后一个延后写超时；每个 send 有 originating event identity |
| `blocked-gate-incident` | PASS | toolbar `resync-required` ACK 后真实 video keydown fail-closed，无新 wire、无 draft/uncertainty，并留下 `input-gate-unexpected` |
| `release-ack-loss` | PASS | mouse-up、physical key-up、touch-up 各 2 sends，仅 down ACK 1，release timeout 1，incident 1 |
| `desktop-draft-entry` | PASS | non-touch desktop 初始隐藏移动 dock；实际点击固定 draft entry 后打开编辑器，保留 pending/uncertain，textWrites=0 且无额外 wire |
| `browser-signal-ingestion` | PASS | actual click→blur/focus，5 sends/18 events 在 Signal 同数关联，waiting/gate blocked/surface 保留，禁持久化、network 0 |
| `draft-retention-exactness` | PASS | reset 前后及取消 drain 后精确内容一致，16 batches 后无重放；仅导出布尔/计数 |
| `layout-matrix` | PASS | 44 个矩阵页面、913 个安全布局/交互 checks 通过 |
| `terminal-lifecycle` | PASS | Terminal 按需加载、无 admin credential 时不建 socket，切回 desktop 保持既有焦点/布局语义 |
| `fullscreen-native-containment` | PASS | wide/narrow、带文本、Terminal、lease loss 等 root `documentElement` fullscreen containment 通过 |
| `fullscreen-fallback-focus` | PASS | API 缺失/拒绝保留普通视图、焦点、composition/draft，并显示不冒充成功的提示 |

`terminal-lifecycle` 与 fullscreen 场景只验证本地 DOM/状态和无凭据副作用；没有启动 Terminal service 或真实 PTY。因此它们不改变 Terminal 运行时/公网结论。

## Browser → Signal 安全边界证据

当前可交付的 durable acceptance command：

```text
python3 scripts/mobile_input_interaction_acceptance.py --browser chromium \
  --out /tmp/wrd-input-final-fix-cli-v2.json
browser-signal-ingestion: PASS
producerAcceptedSends=5 ingestedAcceptedSends=5
producerTraceEvents=18 ingestedTraceEvents=18
recoveryWaiting=true effectiveGateBlocked=true
network.requests=0 network.sensitivePayloads=0
persistenceEnabled=false
exit=0
```

该 durable scenario 由真实离线 DOM click → blur/focus 生产 Input/collector 事件，再调用实际 Signal `ingestDiagnosticPayload`，并比较 producer/receiver 的安全 gate、recovery、surface 和 accepted-send 关联；持久化明确关闭。此前的 `root-browser-ingestion-probe.py` 仅作为历史 RED/GREEN seed 保留在 ignored scratch，不再是交付复现入口。该 evidence 不是 live Socket、正式 origin 或 public path 证明。可选 `inputIdHash`/reason 遗漏或 `null` 仍表示 unavailable，不被强制成固定对象 shape。DataChannel 输入绕过 Signal，Signal 没有 relay 记录不能单独证明 DataChannel 丢包；Socket fallback 和诊断上传才经过 Signal。

## Required final matrices and built graph

Viewer full suite:

```text
set -o pipefail; node --test --test-reporter=dot web-client/js/*.test.js web-client/css/*.test.js
```

此前 delivery run 的 dot reporter 产生 **784 dots**；本轮实现提交上的 fresh full Viewer run 为 **791/791 pass**, with no failure/cancel markers.

Signal build and full suite:

```text
NODE_PATH=/Users/macstudio1/AI/Claude/WebRemoteDesktop/signal-server/node_modules \
  npm --prefix signal-server run build:web
# build_exit=0

NODE_PATH=/Users/macstudio1/AI/Claude/WebRemoteDesktop/signal-server/node_modules \
  npm --prefix signal-server test
```

Build exit `0`;此前 delivery run reported `346` tests, while the final-fix implementation commit reports `349` tests, `349` pass, `0` fail, `0` cancelled, exit `0`. The pretest build used the existing installed dependency tree; no dependency was installed or edited.

Python input/media/diagnostics regression:

```text
python3 -m pytest -q python-host/test_observability.py \
  python-host/test_connection_diagnostics.py python-host/test_input_handler.py \
  python-host/test_remote_keyboard_state.py python-host/test_remote_desktop_write_state.py \
  python-host/test_media_suspension.py
........................................................................ [ 72%]
...........................                                              [100%]
99 passed in 2.18s
exit=0
```

The built graph check loaded `signal-server/scripts/web-asset-graph.js`, verified all **33** graph files exist, and checked that the built critical/deferred/Terminal assets exist and include the trace/Input, diagnostic, and Terminal FSM code paths:

```text
{"graphFiles":33,"missingGraphFiles":[],"criticalAssetExists":true,
 "deferredAssetExists":true,"terminalAssetExists":true,
 "criticalIncludesTrace":true,"criticalIncludesInput":true,
 "deferredIncludesDiagnostic":true,"terminalIncludesFsm":true}
```

This confirms graph inclusion and local build output only; it does not claim a live server or public asset delivery.

## 当前恢复与诊断契约

### 用户可见恢复

失焦/隐藏时，若 DataChannel 可用，Viewer 发出当前控制上下文的 keyboard reset；不可用时 park 本地键盘状态，不把短暂失焦升级为不可恢复 barrier。恢复周期只等待本次 lease/connection attempt 所拥有的 mouse reset 与 keyboard reset 正向 ACK。UI 依次表达等待确认、恢复失败和已恢复；失败不会无限重试。

无草稿且两个 reset 被确认后，下一次真实新输入可以清除恢复等待。存在未发送或 delivery-uncertain 草稿时，内容留在当前页，不自动重放，也不静默清空；用户核对远端状态后使用固定重试/草稿入口显式继续。跟踪过的 keyup、mouse up/reset 仍保留安全释放通路。正常 composition 在结束前不是恢复故障，普通 ACK 在途也不自动触发 incident。

### 六阶段诊断

按以下阶段排查同一 bounded trace：

1. `dom-received`：真实 keyboard/pointer/text/control DOM 事件是否到达。
2. `gate`：当时是否 visible、media active、持有控制权，及 surface/recovery 的有限阻断原因。
3. `transport-send`：Viewer 是否接受本地 enqueue，实际走 DataChannel、Socket fallback 还是明确失败。
4. `ack` / `ack-timeout`：接收端是否返回业务结果；status/applied 与 `accepted` 分开保留。
5. `lifecycle` / `recovery`：focus、blur、visibility、park、reset 和当前恢复 state 是否属于本次 attempt。
6. incident/diagnostic eligibility：只有当前身份、可见、active、有权且确属异常的可靠写入 deadline 或 blocked user action 才进入现有自动诊断资格；draft、Terminal、manual pause、正常 ACK 在途不应制造 incident。

`enqueued` 只表示 Viewer 本地接受排队；Host `applied` 表示 native adapter 返回成功；业务 ACK 表示既有输入关联的接收结果；三者都不等于操作者已经在人眼看到系统效果。下一帧 `visualFeedback` 独立记录，不混入 Viewer 本地 input RTT。日志和诊断只保留有界字段；业务 ACK 为既有 wire correlation 仍带原有关联字段，但 raw input IDs 不进入 trace/日志/诊断持久化。

## 既有 Task 2 证据的保留摘要

本节在删除本计划临时 scratch `task-2-report.md` 前，保留其审计证据；没有复制原始 input IDs、payload、坐标、文本、凭据或 console bundle。

- Task 2 初始 RED：collector 不存在时 `node --test web-client/js/input-trace.test.js` 的安全 fallback 测试失败；diagnostic deferred handoff/真实 classic `Input` 解析缺口、trace hook send-then-throw 重复业务调用、ring/hash bound 与 receiver `accepted=false` 误判均被实际测试/探针暴露。
- Task 2 首轮修复：focused trace/recovery/input/diagnostic/WebRTC 373/373、mobile/touch 57/57、asset build 5/5；full Viewer 771/771。真实 trace browser probe 恢复四组 DOM send/ACK 关联和 pendingAck=0；physical/touch/IME 分别为 2/2/1、2/2/1、1/1/1（writes/timeouts/incidents）。
- Task 2 deferred RED：原始 `root-deferred-incident-probe.py` 在 long-press 1/1/0、drag-start 1/1/0、17-step drain 17/1/0 时失败；修复后 focused deferred 4/4、adapter 1/1、组合 focused 193/193，探针变为 long-press 1/1/1、drag-start 1/1/1、drain 17/1/1。当前 Task4 又以 durable acceptance 复核了前 16 个同步 ACK、最后一个 timeout 和 originating event identity。
- Task 2 三轮 bounded attribution 交付为 `2cf8743`、`53ad8bd`、`8363b79`、`c408d1d` 及对应报告 commits；范围始终是 Viewer collector/Input/mobile/diagnostic hooks 和安全 trace，未修改 Signal relay、Host behavior、wire envelope、lease authorization 或上传策略。

这份摘要保留 Task 2 report 的 RED/GREEN、review 修复顺序和边界，早期诊断反例仍以历史报告为准；不把离线/VM 结果扩展成 physical/Quartz/live 结论。

## Controller Rulings（按时间顺序，及成本）

前四项内部接口决定及其成本完整保留；第五项为上一轮残余问题裁定。本次用户的新明确授权允许继续修正，不把上一轮 FAIL 改写为当时已通过：

1. Extend the internal KeyboardTransport reset seam with explicit nullable `connectionAttemptId` and a `getConnectionAttemptId` provider; do not use a non-enumerable hidden property — send-time attempt ownership is required by the spec, and the original three-field shape omitted necessary attribution; diagnostics use an explicit allowlist anyway — cost if wrong: one extra internal coupling/field to migrate, contained by contract tests and no wire change.
2. Include safe triggering `connectionAttemptId`/`leaseEpoch` in the InputTrace `onIncident` callback and require current identity matching before auto upload — a reason-only callback cannot distinguish a previous connection's timeout from a current fault — cost if wrong: one extra internal callback argument and tests; no wire protocol or upload policy expansion.
3. Extend Task2's allowed files to `touch-input-adapter.js` and its focused tests for diagnostic attribution only — the actual touch gesture/deferred-send owner otherwise has no way to preserve the spec-required user-event identity and reliable ACK incident eligibility — cost if wrong: an extra internal observation seam with cancellation/at-most-once test maintenance; gesture recognition, business input results and wire schema remain unchanged.
4. Extend Task3's allowed files to InputHandler and focused tests for actual input-chain exception logging only — real Host->InputAdapter->InputHandler execution catches and logs exceptions before the new outer boundary, so its existing traceback defeats this task's end-to-end privacy requirement — cost if wrong: reduced raw-stack debugging detail and extra integration-test maintenance; native execution, results, sequencing, ACK and startup behavior must remain unchanged.
5. Keep final R4 modal compositionend diagnostic ownership open as Important/P2 and mark final acceptance FAIL after the single final fix wave; preserve the branch and durable RED evidence without a second fix dispatch or integration — independent actual-module and Chromium probes confirm an original required entrypoint remains uncovered, and the SDD final-wave cap requires explicit residual adjudication — cost if wrong: an additional narrow follow-up is needed before delivery; this entrypoint still lacks event correlation and automatic timeout reporting, so this is not waived as acceptable completion.

## Task 4 implementation files

- `scripts/mobile_input_interaction_acceptance.py`: reused `OfflineFixture`; corrected its external media snapshot to the current production shape; added opt-in trace/diagnostic loading without double-loading classic declarations; added eight real-interaction scenarios, observed network counters, exact timeout/deferred/release assertions, and safe artifact refresh.
- `scripts/mobile-input-interaction-acceptance.test.js`: strengthened the existing real CLI test to require the 20-scenario contract, all-PASS/all-checks, offline scope and observed network fields. It reuses the one browser run instead of launching a second browser suite solely to inspect the same artifact.
- `README.md`: updated current mobile acceptance, reset/park/retry/draft semantics, diagnostic six-stage workflow, DataChannel/Signal boundary and enqueue/applied/ACK/visual-feedback distinction while preserving formal-domain, TURN, Terminal and watcher history.
- `docs/需求文档/WebRemoteDesktop-需求文档.md`: synchronized current lifecycle, input/recovery, diagnostic and privacy wording; explicitly separated business ACK correlation fields from log/diagnostic redaction.
- `docs/superpowers/reports/evidence/2026-09-07-input-recovery-observability/`: safe summaries only; no raw event data.

The ONE final fix wave implementation files are the eleven paths in commit
`cc9ef32915c2988215cf655f68efdcca329d1bf1`: Viewer Input/trace/touch seams and
focused tests, Signal diagnostic redaction and tests, and the existing offline
acceptance script plus its CLI test. No Host, Terminal, media business logic,
lease authorization, protocol schema or service code was changed.

## 历史收尾边界（a00a4c4；当前进展见报告顶部）

- Final review closed R1/R2/R3/R5/R6/R7/R8; R4 remains Important/P2 at `2b49d59`. The green 22-scenario suite does not exercise this modal compositionend attribution failure. Final acceptance is FAIL, not complete or merge-ready. Nullable hash/reason values remain unavailable when omitted/null, by design; baseline warnings remain separately disclosed.
- Real Android Chrome, iPhone Safari, iPad Safari, system IME/Emoji, native Quartz effect, public Viewer/tunnel, live Signal/Host recovery, watcher fault, and Terminal real PTY acceptance remain `NOT RUN`.
- No service/tunnel/native process was started or restarted; no credentials, live URL, main checkout, dependency tree, push or merge was touched. Independent whole-branch review, one scoped re-review and primary acceptance are complete as review activities, but their final verdict is NOT PASS due to R4. The branch and this plan's audit scratch are retained for the remaining fix; integration is not authorized by this report.
