# Input Recovery and Observability Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. Steps use superpowers:test-driven-development. Implementers: `gpt-5.6-luna / max`, as requested by the user; primary agent performs final acceptance.

**Goal:** 修复暂停恢复后的本地输入锁，并用脱敏关联证据定位 DOM、门禁、传输、Host 和 ACK 故障。

**Architecture:** Input 是恢复状态唯一所有者，MobileTextInput 保留草稿安全语义；InputTrace module 集中处理有界采样/脱敏/异步关联。Diagnostic 统一上传快照，Signal/Host 使用现有 inputIds 的 SHA-256 摘要关联，不改变输入 wire schema。

**Tech Stack:** Vanilla JS / Node test + VM，Socket.IO / Express，Python pytest，离线 Python Playwright Chromium。

**Spec:** `docs/superpowers/specs/2026-09-07-input-recovery-observability-design.md`

**Baseline:** `39fa1ea`。隔离分支 `codex/input-recovery-observability`；工作树 `.worktrees/input-recovery-observability`。已重新运行基线 Viewer 离线全量，exit 0；历史探针的四个失败反例是本次 RED 场景来源，不是修复验收。

## Global Constraints

- 不修改 main 的 dirty 文件，不合并、不 push、不重启/启动本地服务或 tunnel，不新建连接现场服务的 Viewer；只运行隔离离线测试/构建。
- input v2 与 ACK wire schema 不变；不增加 traceId/raw诊断字段，不改变控制授权，不自动夺取/释放控制权或重建 PeerConnection。
- 自动恢复只解锁当前 lease/attempt 的新操作；需要本轮 mouse reset 与 keyboard reset 的拥有者 ID、seq 和正向 ACK。旧手势、旧 attempt、仅 READY/新帧/同 lease 重绑不能解锁。
- 无草稿可在安全确认后恢复；有草稿/组合输入保留内容、不自动重发或清空。tracked keyup 与 mouse up/reset 保留安全释放通路。
- 每代故障一次自动周期、3000ms deadline、mouse sequence-gap 最多一次 reset-only 重试；失败须可见，用户可显式重试，不能无限循环。
- 不记录 key/code/keyCode、正文、payload、坐标、DOM label/value、token/password/raw leaseId/raw inputIds。相关字段严格 allowlist，不透传任意对象。
- inputIds 关联哈希为 SHA-256 UTF-8 join('\x1f') 前16位 hex；256条/64 KiB trace，64个待哈希，256个/10秒 ACK 等待；move/wheel 只计数。RTT 与 Host 本地执行时间分开。
- 自动/手动诊断共用安全 inputState/inputTrace；复用15000ms cooldown/已有队列；只复用已有 Socket 或认证 HTTP，不创建临时 Viewer Socket。
- 自动化通过不等于真机、Quartz、正式公网、系统 IME 或 watcher 故障恢复通过；验收报告分别写明 PASS / FAIL / NOT RUN。
- 每个实现任务先观察真实 RED，再实现 GREEN，局部迭代、提交前跑该任务全量。仅 stage 本任务明确文件，使用 conventional commit；不得自派 subagent/reviewer。主线程派独立 reviewer 并验收。

## Task sequencing

Task 1 → Task 2 → Task 3 → Task 4。共享 Input/diagnostic 接口必须串行；review 与主线程的只读核对可并行。任务提交之后做独立 spec+quality review，全部关闭后进入下一个任务。

### Task 1: 修复恢复所有权、草稿保留与可达 UI

**Files:** 修改 `web-client/js/input.js`, `input.test.js`, `keyboard-transport.js`, `keyboard-transport.test.js`, `mobile-text-input.js`, `mobile-text-input.test.js`, `webrtc.js`, `webrtc.test.js`, `web-client/viewer.html`, `web-client/css/viewer.css`。新增 `web-client/js/input-recovery.test.js`（真实模块交叉生命周期）。不要改 Terminal 或 Host 行为。

**Interfaces:** 产出 `Input.getEffectiveInputGate() -> { allowed, blockedReasons, recovery }`，`Input.requestInputRecovery({ source: 'auto'|'user' }) -> boolean`；`KeyboardTransport.getPendingReset() -> { inputId, seq, leaseEpoch, connectionAttemptId } | null`，create新增可选 `getConnectionAttemptId`（缺省返回null），在实际send时捕获reset归属。字段显式可见，不用non-enumerable属性；内部raw ID不进入getDiagnosticState。`MobileTextInput.invalidateContext(reason)` 和 `confirmEmptyContextRecovery() -> boolean`。恢复cycle和gate的语义按Spec §3，供Task 2调用。

- [ ] Step 1: 从诊断反例提取可复用的真实 Input/KeyboardTransport/Controller/MobileTextInput/MediaActivityRuntime fixture，DOM/clock/transport 仅替代外部依赖。建立 RED：click未齐ACK后blur、drag取消、ACK超时、touch hidden/visible，reset确认后必须有实际新 mouse down/up 和 key down/up。两正常对照继续断言无多余复位。
- [ ] Step 2: RED 覆盖 reset的两个ACK顺序、错误ID/seq/epoch/type、旧attempt、迟到gesture ACK、重入focus/ready不加预算、3000ms失败停止、用户重试、mouse sequence-gap reset-only重试、DC closed Socket可用/全断；同lease不能洗白已expired transport，newlease可以重新建立序号。执行 `node --test web-client/js/input-recovery.test.js`，报告预期失败断言。
- [ ] Step 3: 实现 Spec §3：恢复 owner/cycle 使用真实 reset ID；在 Input 的focus/visible/active/DC和WebRTC lease/attempt重绑入口协调且幂等。只在安全确认后清 surface；不同身份撤销旧周期。transport 保留失效身份防止同lease绕过 reacquire；新身份清理仍按原隔离约束。
- [ ] Step 4: lifecycle reset/park 使用 invalidateContext 保留 draft，不把普通“隐藏输入框”与“清内容”绑定。confirmEmptyContextRecovery 必须拒绝 pending/composing；真实新操作恢复与草稿不重放分开断言。保留旧失败 surface 不可直接发送文本的回归，按新“明确双reset才可解锁”补充期望，不删除安全断言。
- [ ] Step 5: body fixed的 `inputRecoveryNotice`, `inputRecoveryRetryBtn`, `inputRecoveryDraftBtn` 实现真实按钮handler、role/status和隐藏规则；接入effective gate状态文案，桌面/mobile/fullscreen可达且不影响退出按钮和Terminal焦点。恢复失败指引现有控制操作，不自动调用夺取控制。测试点击事件带来的状态/发送结果，不只查HTML字符串。
- [ ] Step 6: 运行 `node --test web-client/js/input-recovery.test.js web-client/js/input.test.js web-client/js/keyboard-transport.test.js web-client/js/mobile-text-input.test.js web-client/js/webrtc.test.js`，再运行 `node --test web-client/js/*.test.js web-client/css/*.test.js`。记录 RED/GREEN 命令、数量、实际输出、未跑物理边界；自审并提交 `fix(input): recover current-session controls after lifecycle reset`。

核心 RED 的可执行形状（`fixture()` 取自本仓诊断 `reproduce.cjs` 的真实模块fixture，复制为本测试文件的本地 helper，保留其 pointer/inputs/ack/resume/document 接口；不执行旧脚本的顶层反例）：

```js
test('blur before click ACKs recovers new mouse and keyboard writes only after owned resets', () => {
  const h = fixture();
  h.pointer('pointerdown');
  h.pointer('pointerup');
  h.window.dispatch('blur');
  h.inputs().forEach(message => h.ack(message));
  h.resume();
  h.inputs().filter(message => message.action === 'reset').forEach(message => h.ack(message));
  const before = h.inputs().length;
  h.pointer('pointerdown');
  h.pointer('pointerup');
  h.inputs().slice(before).forEach(message => h.ack(message));
  h.keydown();
  h.document.dispatch('keyup', { target: h.video, code: 'KeyA', key: 'a', location: 0 });
  assert.deepEqual(h.inputs().slice(before).map(message =>
    `${message.type}:${message.action}:${message.payload.phase || ''}`),
  ['mouse:down:', 'mouse:up:', 'keyboard:key:down', 'keyboard:key:up']);
});
```

实现中的 ACK 判定需具有以下必要条件（在实际 owner 内使用，不创建通用框架；调用者还检查 generation/current attempt 及 transport 接受结果）：

```js
function isOwnedResetAck(ack, reset, inputType, leaseEpoch) {
  return Boolean(reset && ack?.schemaVersion === 2
    && ack.inputType === inputType && ack.leaseEpoch === leaseEpoch
    && Array.isArray(ack.inputIds) && ack.inputIds.includes(reset.inputId)
    && ['applied', 'duplicate'].includes(ack.status)
    && Number.isSafeInteger(ack.appliedSeq) && ack.appliedSeq >= reset.seq);
}
```

### Task 2: Viewer 有界输入轨迹与真实门禁打点

**Files:** 新增 `web-client/js/input-trace.js`, `input-trace.test.js`；修改 `input.js`, `input.test.js`, `input-recovery.test.js`, `mobile-text-input.js`, `mobile-text-input.test.js`, `diagnostic-core.js`, `diagnostic.test.js`, `webrtc.js`, `webrtc.test.js`, `web-client/viewer.html`, `signal-server/scripts/web-asset-graph.js`。只有为记录ACK deadline确需 transport hook 时才修改 `keyboard-transport.js` 和对应测试，必须在报告说明。

**Interfaces:** 消费 Task 1 的有效gate与恢复snapshot；产出 `InputTrace.create({ now, hashInputIds, setTimeoutFn, clearTimeoutFn, onIncident }) -> { record(stage, meta), snapshot() }`（参数可选，默认环境时钟/WebCrypto/timer/noop）。record的DOM阶段返回新eventId，其他阶段返回关联eventId或null；snapshot为 `{ schemaVersion: 1, events, counters }`。最多一个deadline计时器，`onIncident(reason, { connectionAttemptId, leaseEpoch })`传有限reason和触发报文归属；core按当前身份匹配、可见/active/有权条件决定上报，旧attempt/epoch超时只留轨迹不误报新连接。Diagnostic core 暴露 `recordInputTrace(stage, meta)` 与 `getInputTraceSnapshot()`（同一 collector 不因deferred加载替换）。Input.getDiagnosticState 产出 Spec §4.2 的安全 inputState，供 Task 3 原样经严格 allowlist处理。record stage、focusKind/visibility和数值上限按Spec §4.1。

- [ ] Step 1: RED 测试固定 inputIds 的已知SHA256 hash、异步回填、无crypto/摘要失败、超64待摘要、256条/64KiB/256个ACK/10秒等待上限；敏感字段用唯一金丝雀，序列化snapshot中必须完全不存在。move/wheel大量输入只能增加聚合计数，不逐条hash。
- [ ] Step 2: 实现独立collector。record不得等待hash或抛出影响业务的异常；snapshot不得泄漏内部raw IDs或DOM对象；哈希淘汰/失败计数明确。真实Input发送旁路记录DOM eventId→现有inputIds，keyboard与pointer/text入口覆盖，IME异步事件另设准确关联。
- [ ] Step 3: gate接受/拒绝记录effective原因、真实transport enqueue结果（含fallback/失败）、ACK接受/拒绝/timeout、生命周期与recovery。只在真实用户输入并且媒体active/可见/有权的unexpected不确定门禁，或可靠ACK deadline触发autoSendFailure；正常draft/只读/Terminal/manual-pause不触发。不要逐move/wheel触发故障。
- [ ] Step 4: collector 放入critical graph且早于Input，Diagnostic core晚加载handoff保持既有轨迹。测试真实gate拒绝只产生DOM+gate不产生发送；DC和Socket各实际记录正确transport，迟到ACK不伪造成功，一次失败的3000ms计时与恢复不互相刷无限重试。
- [ ] Step 5: 运行 `node --test web-client/js/input-trace.test.js web-client/js/input-recovery.test.js web-client/js/input.test.js web-client/js/diagnostic.test.js web-client/js/webrtc.test.js`，再运行Viewer全量；记录红绿与隐私/压力结果，提交 `feat(diagnostics): trace sanitized viewer input decisions`。

`snapshot()` 的接口为 `{ schemaVersion: 1, events, counters }`。条目包含允许的 stage/eventId/meta字段与本地相对时间；计数在counters下（包括pendingHashCount），JSON整体也受64KiB上限。固定向量测试使用真实Node WebCrypto，不用返回固定字符串的假hash：

```js
const { webcrypto } = require('node:crypto');
async function hashInputIds(ids) {
  const bytes = new TextEncoder().encode(ids.join('\x1f'));
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(digest).toString('hex').slice(0, 16);
}
test('correlates input IDs without retaining secret payload fields', async () => {
  const trace = InputTrace.create({ now: () => 10, hashInputIds });
  trace.record('transport-send', { inputType: 'keyboard', action: 'key',
    accepted: true, inputIds: ['kbd_fixture_1'], seq: 1, leaseEpoch: 7,
    key: 'KEY_CANARY', payload: { text: 'TEXT_CANARY' }, leaseId: 'LEASE_CANARY' });
  for (let turn = 0; turn < 100 && trace.snapshot().counters.pendingHashCount; turn += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  const snapshot = trace.snapshot();
  assert.equal(snapshot.events[0].inputIdHash, '3e9fd6a21afbb55b');
  const json = JSON.stringify(snapshot);
  for (const secret of ['kbd_fixture_1', 'KEY_CANARY', 'TEXT_CANARY', 'LEASE_CANARY']) {
    assert.equal(json.includes(secret), false);
  }
});
```

默认实现以同样UTF-8/WebCrypto摘要逻辑返回前16位hex；没有subtle时返回null并计数。调用方用`record`提交allowlist元数据，不在Input中自行散落JSON序列化/哈希代码。

### Task 3: 统一上传、Signal/Host关联与准确处理结果

**Files:** 修改 `web-client/js/diagnostic.js`, `diagnostic.test.js`, `signal-server/lib/diagnostic.js`, `signal-server/test/diagnostic.test.js`, `signal-server/websocket/signaling.js`, `signaling.test.js`, `python-host/observability.py`, `test_observability.py`, `python-host/host.py`, `test_connection_diagnostics.py`；可新增 `signal-server/lib/observability/input.js` 与对应focused测试集中可靠输入摘要。需要其他代码应先向controller报告具体seam，不顺带重构控制面。

**Interfaces:** 消费 Task2 的inputState/inputTrace；manual/auto `buildConnectionDiagnostic()` 都带同样安全快照；`sendLogs()` 返回/等待 `sendConnectionDiagnostic()` 的真实结果。Signal event使用logger已支持 `{ domain, event, message, correlation, meta }`；Host输出 `host_input_received / host_input_rejected / host_input_result / host_input_ack_sent`，meta包括status/appliedSeq/hash，ACK sent表达队列接受，不声称客户端收到。

- [ ] Step 1: RED manual与auto都带surface/draft/effectivegate/pendingMouseReset/desktopWriteRecovery与trace；核心→deferred历史不丢。手动socket断开时只发认证HTTP，断言io未调用、不改变Viewer连接/控制状态；HTTP失败入队/消息不假报成功，cooldown/replay上限保持。
- [ ] Step 2: 实现公共安全snapshot构建，删除临时Viewer Socket fallback。Signal对所有新nested字段枚举/数字/哈希长度/记录数/字节重新白名单裁剪，未知/恶意字段与金丝雀不得进入持久化或summary；summary默认保留安全gate/recovery和丢弃计数。
- [ ] Step 3: RED跨语言hash fixture（相同 inputIds 给JS/Node/Python手算期望），Signal input validation/auth拒绝和relay；Host DC binding拒绝、Socket stalelease、真实adapter返回duplicate/execution-failed/applied、ACK发送false/成功都输出正确stage/status。mock在native/socket外部操作，不能mock掉待审的host.on_input或摘要函数。
- [ ] Step 4: 实现Host/Signal安全日志。保留当前业务拒绝、reset、安全释放、ACK和seq原语义；不为未授权数据新增业务ACK。移除误导性unconditional executed成功表述，高频路径聚合。所有日志不得包含payload、键值或原始输入ID。
- [ ] Step 5: 使用现有依赖（可给worktree单独设置NODE_PATH指向main已安装node_modules，禁止修改其内容）：`node --test web-client/js/diagnostic.test.js signal-server/test/diagnostic.test.js signal-server/websocket/signaling.test.js`；`python3 -m pytest -q python-host/test_observability.py python-host/test_connection_diagnostics.py python-host/test_input_handler.py python-host/test_remote_keyboard_state.py python-host/test_remote_desktop_write_state.py`。运行 `npm --prefix signal-server test`（构建仅worktree dist），记录完整结果；提交 `fix(diagnostics): correlate input outcomes without viewer takeover`。

跨语言固定测试向量与接收边界的RED形状：

```python
def test_input_hash_matches_viewer_fixture():
    from observability import hash_input_ids
    assert hash_input_ids(["kbd_fixture_1"]) == "3e9fd6a21afbb55b"
    assert hash_input_ids(["inp_fixture_a", "inp_fixture_b"]) == "1721100bdad63938"
```

```js
test('diagnostic ingestion strips nested input secrets but preserves final gate', () => {
  const clean = redactDiagnosticPayload({ inputState: {
    isActive: true, hasLease: true, leaseEpoch: 7,
    effectiveGate: { allowed: false, blockedReasons: ['surface-uncertain'], key: 'GATE_CANARY' },
    surface: { state: 'uncertain', generation: 2 },
    draft: { hasPending: false, composing: false, deliveryUncertain: true, text: 'TEXT_CANARY' },
    leaseId: 'LEASE_CANARY',
  } });
  assert.equal(clean.inputState.effectiveGate.allowed, false);
  assert.equal(clean.inputState.surface.state, 'uncertain');
  for (const secret of ['GATE_CANARY', 'TEXT_CANARY', 'LEASE_CANARY']) {
    assert.equal(JSON.stringify(clean).includes(secret), false);
  }
});
```

在公共diagnostic payload返回对象中增加以下两项，manual不再重新组装删字段的inputState；服务器必须对应过滤并保留两项到report，不能只在redactor里保留：

```js
inputState: typeof Input !== 'undefined' ? Input.getDiagnosticState() : null,
inputTrace: this.getInputTraceSnapshot?.() || null,
```

### Task 4: 离线交互验收与文档闭环

**Files:** 修改 `scripts/mobile_input_interaction_acceptance.py` 及其现有对应测试（若存在），或新增独立 `scripts/input_recovery_acceptance.py`（复用离线fixture，不复制整套大harness）；更新 `README.md`, `docs/需求文档/WebRemoteDesktop-需求文档.md`，新增 `docs/superpowers/reports/2026-09-07-input-recovery-observability-acceptance.md` 和 `reports/evidence/2026-09-07-input-recovery-observability/` 下安全测试摘要。只更新本次输入口径，不改TURN/Terminal/watch历史结论。

**Interfaces:** 消费全部生产模块和body恢复UI；报告记录基线SHA、分支HEAD、测试命令/结果/证据路径，区分测试级别。新脚本若有则支持 `--out PATH --browser chromium`，不读凭据、不访问网络/现场origin，不生成真实键值截图。

- [ ] Step 1: 先运行既有脚本 `python3 scripts/mobile_input_interaction_acceptance.py --help`。通过真实浏览器DOM交互补上click→blur→reset ACK→resume→真实新click/keydown行为、草稿保留、失败retry按钮、无触控桌面入口、窄屏入口、原生root fullscreen入口可见且statusBar/chromeDocks仍隐藏、Terminal无焦点/按键穿透。先让当前缺失的验收断言失败，再最小完善fixture/脚本；若发现生产缺陷报告controller交回相应实现者，不在验收脚本伪造正确状态。
- [ ] Step 2: 新/既有离线Chromium脚本全部跑到PASS；禁止只因脚本exit0就把NOT RUN判PASS。输出schema标记 offline-synthetic，必须验证scenario全执行/全部PASS、无网络请求，无敏感payload。
- [ ] Step 3: 最终运行Viewer全量、Signal全量（含worktree构建）、Python输入/媒体/诊断回归；检查build graph与built Viewer无缺失模块。所有额外失败区分基线/新增，失败不能静默忽略。控制恢复专项测试需确实发送新的输入，而不只测active/READY。
- [ ] Step 4: 文档说明现行恢复规则、用户看得懂的状态、重试/草稿按钮、诊断六阶段排查方式与DataChannel绕过Signal的事实；解释enqueued/applied/ACK/人眼效果的不同。交付报告逐项列PASS与真机/Quartz/公网/系统IME仍NOT RUN，明确尚未合main/push/restart。本报告与Spec/Plan相互链接，不覆盖早期诊断反例。
- [ ] Step 5: 自审文档链接、隐私金丝雀与 `git diff --check`，提交 `test(input): verify recovery interaction and document diagnostics`。根线程随后做whole-branch独立review与自己的验收，保留分支等待后续集成授权。

浏览器验收复用`OfflineFixture`，只以真实locator动作和实际wire副作用判定；用可触发页面click的真实事件进入root fullscreen：

```python
page.locator('#inputRecoveryRetryBtn').click()
fixture.settle()
page.locator('#remoteVideo').click(position={"x": 100, "y": 100})
fixture.settle()
before_keys = wire_counts(page)["keyboardKeys"]
page.keyboard.press('a')
fixture.settle()
assert wire_counts(page)["keyboardKeys"] == before_keys + 2
assert page.locator('#inputRecoveryNotice').is_hidden()
```

上下文setup必须先以真实pointer/blur或受控外部ACK失败制造notice（不得直接写production recovery状态让测试通过）。写入JSON后独立核对：

```python
assert report["scope"] == "offline-synthetic"
assert len(report["scenarios"]) >= 12
assert all(item["status"] == "PASS" for item in report["scenarios"])
assert all(all(item["checks"].values()) for item in report["scenarios"])
```
