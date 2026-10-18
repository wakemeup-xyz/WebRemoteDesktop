# Guarded ordinary recovery：源码与回归记录

2026-10-18；Task 6 初次交接。核对源码 HEAD `c78a26ef53472c7d1328d475fe878e4dc377709c`，目录 `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`。**组合源码门禁未通过：本次 Node 回归 608 项中 24 失败；Python 160 项通过。** 新增 source/工具尚未部署；实际恢复和新三小时连续性均 `NOT_RUN`。

## 范围、前提与证据位置

本 worker 仅新建本报告、更新 [C5 addendum](../specs/2026-10-17-viewer-admission-recovery-addendum.md)，执行已分配的纯回归并作只读源代码/证据映射。未修改产品或测试、暂存/提交、操作主 checkout/W2/node_modules、检查运行进程或服务、访问网络/API、构建/npm、启动浏览器、执行真实 proof/Host/native 输入或调用子 agent。唯一测试子进程例外是既有 adapter 测试的两个有界 Node VM child：固定 Node、`subprocess.run`、5 秒 timeout、无 shell/grandchildren、VM 每次求值500ms，仅 fake browser globals。27 个 VM 场景不等于27个 unittest 方法。

绑定依据：[设计](../specs/2026-10-18-guarded-ordinary-recovery-design.md)、[计划](../plans/2026-10-18-guarded-ordinary-recovery-plan.md) Task 6，以及私有 `task-6-brief.md`、`global-constraints.md`、`task-6-integration-context.md`、`task-6-latest-log-context.md`。本次文档/既有回归任务没有新行为实现，未制造新的 RED，也未为取得更干净输出重复已通过测试。

此前单独前提是 Host reset-ACK `58fd7af`、Viewer ordinary acquire-intent/watchdog `3046fdd`；其 [final source review](evidence/2026-10-18-reset-ack-ordering/final-source-review.md) 对 `38bfd6b23460596f10744ba267ad47052720b9c5..e393699396f3f10a373d83c1237ccf46c71e3298` 判定源码 PASS。它们保留现有 ACK/authority/预算，不等于已部署或实际恢复通过。

本增量前五项的 canonical diff、实现/独立 review/修复复审及静态操作材料在 [evidence 目录](evidence/2026-10-18-guarded-ordinary-recovery/)；[source-evidence-index.json](evidence/2026-10-18-guarded-ordinary-recovery/source-evidence-index.json) 的37项 `artifacts` 已逐项核对 byte length/SHA256，零不一致。归档 immutable，未改写 `.patch`、规范化其历史 EOF whitespace warning 或抹除失败。早期 RED、loader/fixture 错误与后续真正行为失败分别保留，不能相加为独立覆盖总数。

| 项 | 已完成的独立源码证据 | 保留限制 |
|---|---|---|
| Task 1 | [review](evidence/2026-10-18-guarded-ordinary-recovery/task-1-review.md)：guard issue/consume、人类优先、真实内存 handler ACK 屏障 | 该历史 review 的 API NOT_RUN 保留原时点含义；本次最终 API 仍由 root 执行 |
| Task 2 | [review](evidence/2026-10-18-guarded-ordinary-recovery/task-2-review.md)：selector/proof/auth/episode 响应竞态、普通 resume、草稿保留 | 本次宽于旧变更范围的既有 WebRTC suite 暴露 fixture 缺失，见下文 |
| Task 3 | [原 review](evidence/2026-10-18-guarded-ordinary-recovery/task-3-review.md)、[fix1](evidence/2026-10-18-guarded-ordinary-recovery/task-3-fix1-review.md)、[correlation review](evidence/2026-10-18-guarded-ordinary-recovery/task-3-correlation-review.md) | closed cursor 重开、HTTP wrapper ownership 已修；直接 session correlation 已修；保留一次0.106秒 asyncio diagnostic |
| Task 4 | [原 review](evidence/2026-10-18-guarded-ordinary-recovery/task-4-review.md)、[fix1](evidence/2026-10-18-guarded-ordinary-recovery/task-4-fix1-review.md) | 最终 no-fault export 的身份/counter 退化 veto 已修；134项历史 GREEN 的0.104秒 diagnostic 不删除 |
| Task 5 | [原 review](evidence/2026-10-18-guarded-ordinary-recovery/task-5-review.md)、[fix1](evidence/2026-10-18-guarded-ordinary-recovery/task-5-fix1-review.md) | main runtime dependency 与 adapter capability 缺失的优先级已由 root 裁定并测试；native/routed 范围不提升 |

## 本次顺序回归：确切命令和结果

命令均在上述 source cwd 运行；先 Node 完整退出，再运行 Python；未并发、无 API/network suite。`/usr/bin/time -p` 附在私有日志末尾，reported duration 与 wall-clock 分开记录。

```bash
/usr/bin/time -p /Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test --test-concurrency=1 signal-server/lib/viewer-admission.test.js signal-server/lib/desktop-control-lease.test.js signal-server/lib/control-transition-retry.test.js signal-server/websocket/viewer-admission.integration.test.js web-client/js/auth-start-integration.test.js web-client/js/input-signaling-continuity.test.js web-client/js/input-recovery.test.js web-client/js/input-backpressure.test.js web-client/js/media-activity-runtime.test.js web-client/js/media-activity-controller.test.js web-client/js/media-activity-lifecycle.test.js web-client/js/webrtc.test.js > .superpowers/sdd/2026-10-18-guarded-ordinary-recovery-plan/task-6-node.log 2>&1
```

```bash
WRD_TEST_NODE=/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node /usr/bin/time -p /Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest scripts.test_ordinary_session_recovery scripts.test_ordinary_recovery_fault scripts.test_passive_session_soak > .superpowers/sdd/2026-10-18-guarded-ordinary-recovery-plan/task-6-python.log 2>&1
```

| 私有日志（相对于 `.superpowers/sdd/2026-10-18-guarded-ordinary-recovery-plan/`） | exit / 实际统计 | 耗时 | bytes / SHA256 |
|---|---|---|---|
| `task-6-node.log` | **1；608 tests，584 pass，24 fail，0 cancelled/skipped/todo** | Node31193.301565ms；real31.29s | 192444 / `57045a6bf134eb8cc8d89bd185588f612886654314119951bf7b8c983bd65f16` |
| `task-6-python.log` | **0；160 tests，OK** | unittest40.746s；real40.98s | 292 / `031496eff09d227ca2b70b22ef7561664244a9d35c2c49ebd608524934bcfb71` |

Python 实际160项对应79个 ordinary runner、26个 adapter、55个 passive helper 测试方法；这里只按这次日志总数报告，不将27个 VM场景或前序多轮重复执行再计为新增 tests。本次 Python 输出无 warning/slow-task diagnostic；此前带 diagnostic 的历史 GREEN 仍然保留。Node 有既有 fake handler/业务诊断输出和24个失败，不能称 pristine/PASS。原始测试日志仅在私有 task 目录，未复制到版本化报告。

## 必须修正的组合回归 finding

**F1：既有 `webrtc.test.js` VM 缺少新 selector 解析器的浏览器全局依赖，24项失败。**

只读定位：`web-client/js/webrtc.test.js:93` 的 `loadWebRTC` 在 `:114` 构造 sandbox，列举 AbortController/timers 等但没有 `URLSearchParams`，`:154` 的 location 只有 origin；`:201` 直接求值完整 `webrtc.js`。这不是方法抽取遗漏。产品 `web-client/js/webrtc.js:2864` 的 `readInitialAdmissionPolicy` 使用全局 `new URLSearchParams(window.location.search)`，`:2871` 将不可读情况转成 `invalid-initial-policy`，`:2875` 在请求前调用它。因此这个 VM 在尚未 fetch/创建 socket 前失败，后续断言表现为0请求、缺少 socket/延迟回调或未清 superseded 状态。`admissionViewerFixture` (`webrtc.test.js:6870`) 复用该 loader且未补依赖。已通过的 `auth-start-integration.test.js:36` fixture 则明确提供 `URLSearchParams`。仅缺少 `.search` 不是决定性原因，因为标准 constructor 接受 undefined 得到空查询。

失败均来自 `web-client/js/webrtc.test.js`：reclaim/Start warmup（5200、5215）、admission/proof/auth/bootstrap（6909、6936、6961、6974、6990、7000两项、7030、7053两项、7092）、signaling-session（7943、7972、7990两项）以及 startup/reclaim ownership（8003、8024、8044、8057、8074、8090两项）。日志保存每个实际 test 名、断言和堆栈。此静态定位支持 fixture omission，未建立真实浏览器产品缺陷；仍需原实现范围独占修正和限定 WebRTC suite 的真实 GREEN，不能以解释替代门禁。

已向 root 报告；本 worker 未改 unowned fixture/source，未重新运行 Node。root 将交回原 Task2 owner或限定实现者修正该单一路径，再做相应 review和受影响测试。本报告保持这次初始 FAIL，不覆盖它。

## 源码合同映射与文档自查

| 必查合同 | 当前源码与测试映射 | 本次判读 |
|---|---|---|
| 人工保留 owner；pending human 与 guard fence 分离 | `signal-server/lib/viewer-admission.js:35`、`:47`、`:81`；同文件 test 的 human-owner、older-pending、TTL、same-session/new-generation cases；handler `:275` | owner不随 grace/TTL 消失；guard不推进人工 fence；后来接纳 human 永久击败旧恢复 |
| 后续人工容量优先、有效 consumed evidence 不驱逐 | admission `:55`、`:63`；`viewer-admission.test.js:153`、`:174` | 先验证和有效容量计算，成功时仅撤未消费 guard；失败不修改 fence/记录；consumed 当前代次不重铸 |
| proof 双向交错、拒绝零副作用 | runtime-context `:114`、`:120`；signaling `:1096` 至 claim；handler `:66`、`:234`、`:246`、`:257`、`:305` | 同步 snapshot→验票→epoch/map claim；无 await/I/O；拒绝保留map/lease/Host events/epoch/proof，guard issue本身不消费 proof |
| 同一真实 handler 的 within/after-grace | handler `:81` 对 human/guard分别循环 grace内外；`:323` 旧操作/current Host ACK拒绝 | 本次该回归通过；Host applied前无grant、过grace先reset/FREE再新grant；offline ACK是fake边界，不是native验收 |
| selector/auth/episode/普通resume边界 | `webrtc.js:2864`；`auth-start-integration.test.js:346`及 input-recovery尾部guard用例 | 受限值及 proof冲突、迟到响应、拒绝与草稿门禁已覆盖；F1仍阻止组合门禁关闭 |
| 单例HTTP/日志/浏览器清理 ownership | runner `:162` one-shot cursor、`:327`和`:330` local task identity、`:587` OwnedBrowserLifecycle；对应 runner ownership/cancellation/final-export测试 | wrapper settlement前不换owner；无catch-up并行请求；一份cleanup deadline，browser/manager独立尝试，不将API完成说成进程退出 |
| 不提升native/routed范围和最终PASS | fault `:124`、`:150`、`:203`、`:239`；runner `:1048`、`:1063`、最终snapshot检查；adapter/runner scope和late-failure测试 | constructor scenario固定；native direct与routed public wrapper明确；失败sticky，after-grace绝不变native资格 |
| 输出隐私、有界、缺测诚实 | runner `:441`、`:536`、`:852`、`:1063` exact-key validators；salted identities、固定error/schema/privacy-canary测试 | 不保存原始ID/token/ticket/password/input/URL或异常内容；manifest仅投影，Host/Signal源码注明root-attested；缺测保持null/NOT_RUN |

本次只读检查确认唯一普通 owner/map 和现有 lease沿用，没有新authority或恢复协议。对最终no-fault身份/counter与recovery当前freshness采用不同且明确的规则；旧lifetime gap不清零。当前matched rebind-failed仅投影generic `recovery-gates-unmet`；不从删掉的raw reason推断timeout/rejected/cancelled。旧schema/日志/owner缺口不补造成功。

本任务新增/修改文档仅记录合同和观察；完整spec已有 constructor/failure_reason/main dependency优先级及direct server session correlation裁定，不再另行改变它。README、runbook、requirements和review-anchors四个预存dirty文档不更新、不暂存。strict helper与sampler本次前后hash一致；original SUP没有编辑，历史hash/操作证明仍由root的独立门禁保管。新私有日志只做有界检查；本次两个私有日志的credential变量赋值/JWT/Bearer模式扫描零命中，这不是完整secret审计。root另报告对57份changed versioned docs和48份private pure logs执行当前配置secret的精确匹配扫描，零命中；该受限扫描不等于已扫描所有生产日志。

## 历史运行证据和仍未完成的门禁

[rolling72h.md](evidence/2026-10-18-guarded-ordinary-recovery/rolling72h.md) / [summary](evidence/2026-10-18-guarded-ordinary-recovery/rolling72h-summary.json) 记录固定半开CST窗口 `2026-10-15 17:14:25.468476` 至 `2026-10-18 17:14:25.468476`。Host原始前缀缺43h48m41.583s，不能算完整72h事故率/P95；114条结构化close为86Viewer/28Host，跨版本/维护/探针/未知归属，不能写成114次用户故障。历史direct max40126.976ms、worker-await8646.9ms仍为历史量测区间，非当前source性能或唯一OS/网络病因。Task6没有扩大采样或查询运行状态。

后续idle统计和16:20:22–27的7条connector记录只支持一次低层连接恢复，不能视为whole-process restart或解释15:01的first WS close hop。357条upload summaries不能去重成357份报告；64条保留receipt来自较早raw+sanitized来源，尾部19h04m58.464s无receipt。Input ACK、当前Host queue/apply、应用后新帧、content-causal visible/physical指标仍缺测。当前idle观察不建立控制稳定性或输入延迟。

先前longA在native WS1006后约36秒结束，严格连续性 **INCOMPLETE**，第一跳 **UNKNOWN**；先前shortB PASS和旧53ed系列三小时PASS均不能资格化这次未部署组合release。失败/不确定维护及全进程树退出UNKNOWN继续保留。此前执行记录所述生产Host `c239482/e5927c7`、Signal `53ed5d7`/Viewer build `79bf9a5afea0458e`与本次source HEAD分开；这里未查询或重新证明生产加载。

| 后续门禁 | 本次状态 / 责任 |
|---|---|
| F1单一路径fixture correction、限定WebRTC GREEN与review | **PENDING；root重新分配** |
| 最终 `signal-server/test/viewer-admission-api.test.js`、`signal-server/test/proof-admission.test.js` ephemeral-loopback检查 | **PENDING；root alone**；旧Task1 API evidence不冒充本次final run |
| 当前CLI/schema/count/startup与已批准purecollector的实际连接 | **PENDING；root**；[pure-integration-r2](evidence/2026-10-18-guarded-ordinary-recovery/pure-integration-r2-review.md)是静态批准、NOT_EXECUTED |
| 最有能力reviewer的whole-increment source/tool-boundary review、最终文档核对与提交 | **PENDING；root**；此文是worker自查，不替代独立final review |
| combined部署/实际source+assets、健康/Host/tunnel保持、密码私下回报 | **NOT_RUN；root operations**；[ops-r6](evidence/2026-10-18-guarded-ordinary-recovery/ops-r6-review.md)静态Approved不等于已执行 |
| baseline300、native-direct within-grace、playwright-routed after-grace、fresh route-free10800 continuity | **NOT_RUN**；依次完整清理，终止失败/人工到达后不自动继续 |
| native after-grace、真实business input、visible effect、physical | **NOT_RUN**；本runner不会提升这些标签 |

本次文档自查：相对链接全部有效、C5 scoped `git diff --check` exit0、staged paths为空。四份预存dirty文档、strict helper、sampler的前后SHA256及node_modules symlink一致；检查记录留在私有task目录。仅两份指定文档发生新的版本化路径变化。

本次Task6 worker工作已交接，组合source gate仍因F1及后续root门禁待定。后续实际操作另建execution报告；任何后续GREEN应追加其确切修正revision/命令/结果，保留本次FAIL与历史运行限制。
