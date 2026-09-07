# 输入恢复与诊断验收报告（Task 4）

日期：2026-09-08
范围：`codex/input-recovery-observability` 的离线交互验收、当前输入恢复/诊断文档和安全证据摘要。
基线 SHA：`39fa1eadc89b00546e2bf66f1ed1d1e6f892ca42`。
Task 4 已提交测试实现版本（delivery commit）：`2ddbc15a4a8a11f5a3d58a1cd0b473e882be7d6e`；它以 Task 4 开始时的实现 HEAD `cbefccbacb3c036c2a4cdc5cf1c3cfbde2bfabae` 为父提交。本轮仅作永久文档 provenance/link 修正，起点为 `FIX_BASE=2ddbc15a4a8a11f5a3d58a1cd0b473e882be7d6e`，不在自身报告中预写尚未产生的 docs-only commit hash。

本报告与 [输入恢复与诊断设计 Spec](../specs/2026-09-07-input-recovery-observability-design.md)、[执行计划的 Task 4 锚点](../plans/2026-09-07-input-recovery-observability-plan.md#task-4-acceptance) 相互对应。安全摘要见 [offline-chromium-summary.md](evidence/2026-09-07-input-recovery-observability/offline-chromium-summary.md) 和 [browser-ingestion-summary.md](evidence/2026-09-07-input-recovery-observability/browser-ingestion-summary.md)。早期反例仍保留在 [resume-input-diagnosis](2026-09-07-overall-completion-and-resume-input-diagnosis.md)、[2026-09-05 mobile review](2026-09-05-mobile-touch-keyboard-logic-review.md) 和 [2026-09-06 remediation report](2026-09-06-mobile-input-interaction-remediation-acceptance.md)，没有被本报告改写为新代码的 PASS。

## 结论与边界

- 严格离线 Chromium 运行产出 `scope=offline-synthetic`，20/20 场景 `PASS`，每个场景的每个 check 均为 `true`，进程 exit 0。
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

最终离线脚本：

```text
python3 scripts/mobile_input_interaction_acceptance.py --browser chromium \
  --out /tmp/task4-final.json
```

独立解析 JSON 的结果：

```text
scope=offline-synthetic browser=chromium scenarios=20
network.requests=0 network.sensitivePayloads=0
all_status_pass=True all_checks_true=True
exit=0
```

缺运行时和启动后异常仍由脚本区分：缺 Chromium/WebKit runtime 写 `NOT RUN` 并 exit 2；浏览器已经启动但场景异常写 `FAIL` 并 exit 1。严格测试还断言每个 scenario 都是 `PASS`，而不是只看 exit code。

## 离线场景逐项结果

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
| `layout-matrix` | PASS | 44 个矩阵页面、913 个安全布局/交互 checks 通过 |
| `terminal-lifecycle` | PASS | Terminal 按需加载、无 admin credential 时不建 socket，切回 desktop 保持既有焦点/布局语义 |
| `fullscreen-native-containment` | PASS | wide/narrow、带文本、Terminal、lease loss 等 root `documentElement` fullscreen containment 通过 |
| `fullscreen-fallback-focus` | PASS | API 缺失/拒绝保留普通视图、焦点、composition/draft，并显示不冒充成功的提示 |

`terminal-lifecycle` 与 fullscreen 场景只验证本地 DOM/状态和无凭据副作用；没有启动 Terminal service 或真实 PTY。因此它们不改变 Terminal 运行时/公网结论。

## Browser → Signal 安全边界证据

保留并重跑的 primary seed：

```text
python3 .superpowers/sdd/2026-09-07-input-recovery-observability-plan/root-browser-ingestion-probe.py
{"scope":"offline-synthetic","accepted":true,"matchedSends":5,
 "recoveryState":"waiting","finalGateAllowed":false,"traceEvents":18,
 "persistenceEnabled":false}
exit=0
```

这条 probe 由真实离线 DOM click → blur/focus 生产 Input/collector 事件，再调用实际 Signal `ingestDiagnosticPayload`，持久化明确关闭；它不是 live Socket、正式 origin 或 public path 证明。可选 `inputIdHash`/reason 遗漏或 `null` 仍表示 unavailable，不被强制成固定对象 shape。DataChannel 输入绕过 Signal，Signal 没有 relay 记录不能单独证明 DataChannel 丢包；Socket fallback 和诊断上传才经过 Signal。

## Required final matrices and built graph

Viewer full suite:

```text
set -o pipefail; node --test --test-reporter=dot web-client/js/*.test.js web-client/css/*.test.js
```

Exit `0`; the dot reporter produced **784 dots**, with no failure/cancel markers (`784/784` pass).

Signal build and full suite:

```text
NODE_PATH=/Users/macstudio1/AI/Claude/WebRemoteDesktop/signal-server/node_modules \
  npm --prefix signal-server run build:web
# build_exit=0

NODE_PATH=/Users/macstudio1/AI/Claude/WebRemoteDesktop/signal-server/node_modules \
  npm --prefix signal-server test
```

Build exit `0`; Signal output reported `346` tests, `346` pass, `0` fail, `0` cancelled, exit `0`. The pretest build used the existing installed dependency tree; no dependency was installed or edited.

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

## 四项 Controller Rulings（及成本）

以下四项 Ruling 原文含义与成本均保留：

1. Extend the internal KeyboardTransport reset seam with explicit nullable `connectionAttemptId` and a `getConnectionAttemptId` provider; do not use a non-enumerable hidden property — send-time attempt ownership is required by the spec, and the original three-field shape omitted necessary attribution; diagnostics use an explicit allowlist anyway — cost if wrong: one extra internal coupling/field to migrate, contained by contract tests and no wire change.
2. Include safe triggering `connectionAttemptId`/`leaseEpoch` in the InputTrace `onIncident` callback and require current identity matching before auto upload — a reason-only callback cannot distinguish a previous connection's timeout from a current fault — cost if wrong: one extra internal callback argument and tests; no wire protocol or upload policy expansion.
3. Extend Task2's allowed files to `touch-input-adapter.js` and its focused tests for diagnostic attribution only — the actual touch gesture/deferred-send owner otherwise has no way to preserve the spec-required user-event identity and reliable ACK incident eligibility — cost if wrong: an extra internal observation seam with cancellation/at-most-once test maintenance; gesture recognition, business input results and wire schema remain unchanged.
4. Extend Task3's allowed files to InputHandler and focused tests for actual input-chain exception logging only — real Host->InputAdapter->InputHandler execution catches and logs exceptions before the new outer boundary, so its existing traceback defeats this task's end-to-end privacy requirement — cost if wrong: reduced raw-stack debugging detail and extra integration-test maintenance; native execution, results, sequencing, ACK and startup behavior must remain unchanged.

## Task 4 implementation files

- `scripts/mobile_input_interaction_acceptance.py`: reused `OfflineFixture`; corrected its external media snapshot to the current production shape; added opt-in trace/diagnostic loading without double-loading classic declarations; added eight real-interaction scenarios, observed network counters, exact timeout/deferred/release assertions, and safe artifact refresh.
- `scripts/mobile-input-interaction-acceptance.test.js`: strengthened the existing real CLI test to require the 20-scenario contract, all-PASS/all-checks, offline scope and observed network fields. It reuses the one browser run instead of launching a second browser suite solely to inspect the same artifact.
- `README.md`: updated current mobile acceptance, reset/park/retry/draft semantics, diagnostic six-stage workflow, DataChannel/Signal boundary and enqueue/applied/ACK/visual-feedback distinction while preserving formal-domain, TURN, Terminal and watcher history.
- `docs/需求文档/WebRemoteDesktop-需求文档.md`: synchronized current lifecycle, input/recovery, diagnostic and privacy wording; explicitly separated business ACK correlation fields from log/diagnostic redaction.
- `docs/superpowers/reports/evidence/2026-09-07-input-recovery-observability/`: safe summaries only; no raw event data.

## Remaining concerns / NOT RUN

- `root-empty-context-ui-probe.py` remains a known final-review Minor: with empty draft and DC closed, a visible recovery notice can still have blank text and no buttons. This report does not alter production or disguise that finding.
- Repeated stable lifecycle records and Signal reason/drop accounting Minors remain deferred final-review findings; nullable hash/reason values remain unavailable when omitted/null. Existing WebRTC VM `fetch is not defined` STUN fallback warnings remain baseline noise.
- Real Android Chrome, iPhone Safari, iPad Safari, system IME/Emoji, native Quartz effect, public Viewer/tunnel, live Signal/Host recovery, watcher fault, and Terminal real PTY acceptance remain `NOT RUN`.
- No service/tunnel/native process was started or restarted; no credentials, live URL, main checkout, dependency tree, push or merge was touched. The parent must still perform independent whole-branch review and acceptance before any integration authorization.
