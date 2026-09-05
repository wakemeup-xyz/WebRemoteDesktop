# 手机 / iPad 输入交互整改 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复移动输入报告 F1–F7，完成持续文本输入、正确触控拖拽、手机/iPad键盘避让与完整操控全屏的自动化闭环。

**Architecture:** 保留 Input、MobileTextInput、RemoteKeyboardController、KeyboardTransport 和 ChromeLayout。焦点从媒体门禁中解耦，文本适配器统一管理草稿/游标/外部动作，ChromeLayout 单点计算键盘遮挡；不引入新移动协议。

**Tech Stack:** Vanilla JavaScript、Node `node:test`、CSS、Python Playwright（离线 Chromium，WebKit 可用时单独运行）。

**Spec:** `docs/superpowers/specs/2026-09-06-mobile-input-interaction-remediation-design.md`

**Status:** 计划待实施；当前生产基线 `000547ff37dc1a05c3b5b953954af81e9ed7d43a`。本轮规划结束时将本spec/plan及支持报告纳入窄范围文档提交；文档提交不代表代码已经实施。

**Review:** 主线程复审新增R9/R10(P1)、R11(P2)，此前整体PASS不再有效；已将修订契约并入Task4和Task7，实施与最终主线程review待完成。见[审查记录](../reports/2026-09-06-mobile-input-interaction-remediation-plan-review.md)。

## Global Constraints

- 不新增移动协议、控制租约、Host API 或并行可靠传输队列；鼠标与键盘沿用各自现有 seq/ACK/reset。
- 不修改 Terminal/PTY、媒体编码、SPS、jitter、TURN、formal watcher 或 tunnel 生命周期。
- 不自动启动/停止/重启服务，不操作 cloudflared，不更换公网地址；部署、merge/push 与服务操作另按用户明确指令执行。
- 不记录或持久化用户文本、按键、坐标、剪贴板、密码、token；草稿仅保存在当前页面内存。
- 真实 Android/iPhone/iPad、系统软键盘、Quartz、公网与 live watcher 无实际证据时保持 NOT RUN；离线模拟不得替代。
- 保留既有可靠控制/安全释放规则、虚拟 modifier 的 pressed truth、输入 DOM 去重及 4096 Unicode scalar 的 Host 单条限制。

## 执行前准备与文件职责

执行者先读新 spec、F1–F7 报告、旧移动设计和根 AGENTS.md。使用隔离 worktree；当前主工作树含用户原有脏文件，禁止整体 stash、git add . 或覆盖。

规划产物须纳入版本管理：本轮结束仅提交新spec/plan/review、前一轮本任务的问题报告/证据及已知属于本任务的文档同步；排除用户原有review-anchors、日志、图片和TURN质量计划。实现worktree从该文档提交创建。生产代码需确认仍基于 `000547f` 或完成新HEAD差异审阅；不对已修复项重复实施。

| 路径 | 本计划职责 |
|---|---|
| `web-client/js/input.js` | 焦点策略、移动动作编排、transport状态桥接 |
| `web-client/js/mobile-text-input.js` | 草稿、diff、游标、重试、generation取消 |
| `web-client/js/touch-input-adapter.js` | down起点、首触点门禁、几何失效后的reset |
| `web-client/js/chrome-layout.js` | 遮挡纯函数、CSS写入、compact/idle |
| `web-client/js/ui.js` | documentElement全屏与失败UI |
| `web-client/viewer.html` / `web-client/css/viewer.css` | retry/discard/status、手机/iPad排布、全屏退出入口 |
| 原有同名 `.test.js`；新增 `web-client/js/ui.test.js` | 各模块回归 |
| 新增 `scripts/mobile_input_interaction_acceptance.py` | 无网络的浏览器集成验收，不能调用服务启动器 |
| 新增 `scripts/mobile-input-interaction-acceptance.test.js` | 验收CLI/隐私/结果判定测试 |

## 顺序与 review gate

默认顺序 **Task1 → Task2 → Task3 → Task4 → Task5 → Task6 → Task7**。多个任务都改input.js/HTML/CSS，禁止多个实现agent同时编辑这些文件。可并行只读审查和已完成任务测试；review不拥有写入权限。按用户最新指令，执行subagent使用`gpt-5.6-luna`、`max`，最终whole-branch review由主线程本人进行，不以subagent的PASS替代。

每个任务先记录旧代码上的失败断言，再实现、跑绿并做 spec/代码双审查；未解决 P1/P2 不进入最终交付。以下测试代码添加到对应测试文件，使用其既有 harness；需扩展 harness 时在该任务内定义，不能引用不存在的跨任务测试工具。

### Task 1: 门禁幂等与焦点策略（F1）

**Files:** Modify `web-client/js/input.js`, `web-client/js/ui.js`, `web-client/js/chrome-layout.js`; Test `web-client/js/input.test.js`, `web-client/js/webrtc.test.js`, `web-client/js/chrome-layout.test.js`。

**Interfaces:** Consumes `Input.setActive(active, meta)`、现有 DOM/adapter snapshot；Produces `Input.focusDesktopSurface(element, reason) -> boolean`（reason=`surface-user|initial-ready|restore`）。MobileTextInput.show/hide 的旧接口保持。

- [ ] **Step 1:** 在 input.test.js 用既有 loadInput/activate 建焦点回归；fake element.focus 必须更新 document.activeElement，不能留 noop。

```js
test('repeated active gate preserves the mobile textarea focus', () => {
  const {Input, context, elements} = loadInput();
  activate(Input, context);
  Input.setupTextInput();
  const video = elements.get('remoteVideo');
  const field = elements.get('mobileTextInput');
  video.focus = () => { context.document.activeElement = video; };
  field.focus = () => { context.document.activeElement = field; };
  Input.mobileTextInputAdapter.show();
  for (let i = 0; i < 120; i++) Input.setActive(true);
  assert.equal(context.document.activeElement, field);
});
```

- [ ] **Step 2:** Run `node --test web-client/js/input.test.js`，确认上述断言在旧代码失败。
- [ ] **Step 3:** 移除 setActive 的无条件 focus，把 click/pointerdown/playing/fullscreenchange 的 focus 汇总到受控方法；playing 和重复门禁不调用 focus，显式surface-user前置门禁由Task4接入。不要删除 WebRTC 每帧的媒体ready更新。

```js
// setActive 只保留原门禁与释放逻辑末尾：
this.isActive = next;
this.updateKeyboardUI();
// focusDesktopSurface 的早退条件：
if (!this.isActive || !element?.isConnected) return false;
const active = document.activeElement;
const terminal = document.getElementById('terminalPanel');
const editing = active?.matches?.('input,textarea,select,[contenteditable="true"]')
  || active?.closest?.('.modal')
  || (terminal && !terminal.hidden && !terminal.classList.contains('hidden'));
if (reason !== 'surface-user' && editing) return false;
element.focus();
return document.activeElement === element;
```

- [ ] **Step 4:** 在 setupTextInput 增加 returnFocus 记录/条件恢复：用户普通关闭时才恢复，reset/park 不恢复；return target失效时不聚焦。给 webrtc.test.js 增加生产frame回调→sync链路断言；给 chrome-layout.test.js 加 mobileInputMode=visible/composing/pending 时 shouldIdle=false。Task3 状态接线未到位前以适配器现有 shown/composing 判断。
- [ ] **Step 5:** Run `node --test web-client/js/input.test.js web-client/js/webrtc.test.js web-client/js/chrome-layout.test.js`。检查 modal、Terminal、relay、首次激活、explicit画面点击和120帧 focus 保持均通过。
- [ ] **Step 6:** 仅暂存上述文件，`git diff --cached --check` 后提交 `fix(viewer): preserve text focus across media updates`。

### Task 2: 拖拽起点及几何变化释放（F4）

**Files:** Modify `web-client/js/touch-input-adapter.js`, `web-client/js/input.js`; Test `web-client/js/touch-input-adapter.test.js`, `web-client/js/input.test.js`。

**Interfaces:** Consumes现有mapPoint/sendMouse/reset；Produces pointer record startPoint和`beforeGesture?:()=>boolean`（只读预检，默认true）、`commitGesture?:(send:()=>boolean)=>boolean`（默认send()）、`validateGeometry?:()=>boolean`（默认true）。Input使用现有releasePointer，不新增wire字段。Task2实现callback调用点，Task4接文本事务。

- [ ] **Step 1:** 添加现有makeTouchHarness下的实际坐标断言，以及 beforeGesture=false 时不capture、不发down。

```js
test('drag presses the initial contact before moving', () => {
  const h = makeTouchHarness();
  h.pointer('pointerdown', {pointerId:1,clientX:10,clientY:10});
  h.pointer('pointermove', {pointerId:1,clientX:19,clientY:10});
  h.pointer('pointerup', {pointerId:1,clientX:30,clientY:10});
  const down = h.mouse.find(e => e.action === 'down');
  assert.equal(down.payload.relX, 10 / 160);
  assert.deepEqual(h.mouse.map(e => e.action), ['down','move','up']);
});
```

- [ ] **Step 2:** Run `node --test web-client/js/touch-input-adapter.test.js` 确认旧坐标断言FAIL。
- [ ] **Step 3:** pointerdown存startPoint；pointermove只更新point；跨阈值down使用startPoint，成功后才queueMove。首触点beforeGesture不改文本历史。每次真实首down（tap/drag/long-press）由commitGesture包装sendMouse，Input返回boolean而adapter保留其真实inputId用于既有屏障。callback不被调用代表本地拒绝，不发reset；真实sendMouse失败仅reset一次。任一down拒绝即consume：清timer/队列/pointer/capture/primaryId/activeButton、generation++，同一pointer后续move/up忽略，不能因reset成功重试down。
- [ ] **Step 4:** 几何签名固定为rect left/top/width/height、源width/height、object-fit/scale。Input提供validateGeometry，签名变化releasePointer一次并返回false；adapter在move/up映射前、long-press与rAF flush前检查false即return，mapPoint后还要检查入口保存的generation以防重入reset。reset不刷新几何，递增generation使旧callback失效。mouse/pen同样pre-map abort。新增down→resize→up、contain→cover、源尺寸改变、“failed down→reset接受→重复move→enabled恢复→up”断言：仅一次reset、无旧坐标move、无补发down，新pointer且屏障解除才能恢复。
- [ ] **Step 5:** Run `node --test web-client/js/touch-input-adapter.test.js web-client/js/input.test.js`，复查tap/long-press/reset/two-finger回归。
- [ ] **Step 6:** 暂存本任务文件并check，提交 `fix(viewer): anchor touch drag to initial contact`。

### Task 3: 草稿状态、有限重试与UI（F5）

**Files:** Modify `web-client/js/mobile-text-input.js`, `web-client/js/input.js`, `web-client/viewer.html`, `web-client/css/viewer.css`; Test `web-client/js/mobile-text-input.test.js`, `web-client/js/input.test.js`。

**Interfaces:** Produces `retryPending():boolean`、`discardPending():void`、`onTransportState(state):void`、`refreshDeliveryState():void`；config增加 `onStateChange(snapshot)` 与 `isDeliverySettled():boolean`；snapshot增加hasPending/retryable/deliveryUncertain/status。sendText/sendKey仍返回boolean，不以此宣称Host应用成功。

- [ ] **Step 1:** 扩展 makeTextHarness 参数 `sendTextResult=true` 为可由返回对象 `setSendAccepted(boolean)` 动态调整的变量；sent只记录被接受内容，failedAttempts另计元数据；注入isDeliverySettled（单元harness默认true，另提供setDeliverySettled切换）。新test输入a成功、b拒绝、再输入c、恢复显式重试只发bc，且 beforeinput 不清草稿。

```js
test('rejected draft survives the next edit and retries only unsent text', () => {
  const h = makeTextHarness(); // 本任务扩展 setSendAccepted/failedAttempts
  h.input.value = 'a'; h.emit('input');
  h.setSendAccepted(false);
  h.input.value = 'ab\u200b'; h.emit('input');
  h.emit('beforeinput', {inputType:'insertText',preventDefault(){}});
  assert.equal(h.input.value, 'ab\u200b');
  h.input.value = 'abc\u200b'; h.emit('input');
  h.setSendAccepted(true);
  assert.equal(h.adapter.retryPending(), true);
  assert.deepEqual(h.sent.filter(x=>x.kind==='text').map(x=>x.value), ['a','bc']);
});
```

- [ ] **Step 2:** Run `node --test web-client/js/mobile-text-input.test.js` 记录失败，不以仅新增方法不存在作为唯一red证据；先记录旧beforeinput清草稿断言失败。
- [ ] **Step 3:** 在现有adapter内部区分acceptedValue/draftValue与generation。保留最长公共前后缀diff；beforeinput只阻止已接受历史的无效编辑，失败草稿属于可编辑区。推进公式和停止点如下：

```js
// 本地helper；调用方完成diff删除阶段后传入待插入串和目标前缀。
function applyInsertion(inserted, nextAcceptedValue) {
  const stepGeneration = generation;
  const sent = sendText(inserted);
  if (stepGeneration !== generation) return false;
  if (sent === false || sent === null) {
    status = 'pending';
    // 保留draftValue与选区；禁止restoreBuffer覆盖用户草稿。
    notifyState();
    return false;
  }
  acceptedValue = nextAcceptedValue;
  return true;
}
// 随后从最新draft继续计算，不把transport接受写成Host已应用。
```

- [ ] **Step 4:** 为部分删除实现串行事务：每轮≤16个Backspace；全成功仍有剩余才setTimeout0继续，任一拒绝立即停止；保存原target与下一步游标。reset/detach/generation变化取消定时器。加入18次删除、第3次拒绝、继续编辑、reset后旧回调不能发送的fake-timer测试。
- [ ] **Step 5:** 实现retryPending/discardPending/onTransportState/refreshDeliveryState。Input注入isDeliverySettled为keyboardTransport.getSnapshot的state=ready且pendingCount=0；acceptKeyboardAck处理后调用refreshDeliveryState，因为普通ACK不总触发subscribeState。Input仅新增一个直接transport订阅，原样转小写ready/blocked/reacquire-required；controller大写READY只用于isEnabled，原controller订阅与UI通知不重复通知adapter。持有unsubscribe，重建/拆除时调用，adapter晚创建时立即同步snapshot。两类通知均不自动发送。blocked/reacquire禁重试；reset/park清空。Input.setControlLease比较id/epoch，改变时先adapter.reset('lease-changed')、generation++/清drain草稿/隐藏，再controller.setLease；null后传revoked。同lease幂等不清草稿。测试初始同步/重复init/ACK/blocked/reacquire/reset；真实Transport的a接受未ACK→b被拒→重试禁→a合法ACK→仅解锁→显式retry只发b。另测非空lease直接替换、epoch变更、撤销再授予、相同lease，旧callback/显式retry均不得跨lease发送。
- [ ] **Step 5a（实施接口回填）:** `onTransportState(state, options?:{resetAcknowledged?:boolean})` 的确认参数仅由Input在匹配本次owned keyboard reset的applied/duplicate ACK、既有transport解除屏障回ready后设置。旧草稿在reset入口清空；ACK不再次reset、不自动发送，期间新草稿保留并显式retry。普通ready/旧或失败ACK/无关blocked不得重建上下文；lease与park取消旧关联，park不得发reset。保留实际Input+Controller+Transport的成功/失败/旧ACK、ACK前新草稿、park no-wire回归。
- [ ] **Step 6:** 添加 `mobileInputStatus`（role=status，文本枚举）、`mobileInputRetryBtn`、`mobileInputDiscardBtn` 到原mobileInputDock，绑定一次；无待发且无投递不确定性时隐藏，空diff但uncertain仍显示状态和放弃入口。pending→“有未发送内容”；blocked→“暂不可输入”；uncertain→“输入位置或连接已变化，请核对远端后放弃本地草稿”。禁止把内容写日志或snapshot。
- [ ] **Step 7:** 字符边界：测试Emoji、不完整surrogate拒绝/保留、ZWJ完整发送、4096scalar限制与DOM maxlength区别；已接受历史与pending总内存有界。调用方仍使用既有sendText布尔接口。
- [ ] **Step 8:** Run `node --test web-client/js/mobile-text-input.test.js web-client/js/input.test.js web-client/js/remote-keyboard-controller.test.js web-client/js/keyboard-transport.test.js`；检查旧composition重复input仍只提交一次。
- [ ] **Step 9:** 暂存本任务路径并check，提交 `fix(viewer): preserve unsent mobile drafts and bound retries`。

### Task 4: 文本导航与外部动作编排（F3）

**Files:** Modify `web-client/js/mobile-text-input.js`, `web-client/js/input.js`; Test `web-client/js/mobile-text-input.test.js`, `web-client/js/input.test.js`。

**Interfaces:** ConsumesTask2 beforeGesture/commitGesture、Task3草稿状态；Produces `MobileTextInput.sendControlKey(code,modifiers?):boolean`、`runExternalAction(kind,send):boolean`和`Input.runMobileEditingAction(action,send):boolean`。modifiers为四个shiftKey/ctrlKey/altKey/metaKey布尔flags，config.sendKey同样扩展；缺省均false。

新增只读config `hasVirtualModifiers():boolean`，默认false，Input读取既有controller snapshot.virtualModifiers.length>0；只判定本地context-change，不改变controller pressed状态或产生modifier报文。保留Task3的owned-reset确认参数；surface不确定性不能被键盘reset确认绕过。

- [ ] **Step 1:** 以生产setupActionButtons创建“左”按钮，使用loadInput真实controller/transport，输入abc→按钮左→输入X；断言本地value为abXc，传输只发abc/ArrowLeft/X。另测shift+left走context-change而非cursor--；未发送草稿时按钮不发事件。

```js
// 适配器级回归；makeTextHarness沿用现有sent/input/emit。
test('public navigation updates the same cursor used by IME', () => {
  const h = makeTextHarness();
  h.input.value = 'abc'; h.emit('input');
  assert.equal(h.adapter.sendControlKey('ArrowLeft'), true);
  assert.equal(h.input.selectionStart, 2);
  h.input.value = 'abXc\u200b'; h.emit('input');
  assert.equal(h.input.value, 'abXc\u200b');
  assert.deepEqual(h.sent.map(x=>x.value), ['abc','ArrowLeft','X']);
});
```

- [ ] **Step 2:** Run `node --test web-client/js/mobile-text-input.test.js web-client/js/input.test.js` 确认当前toolbar路径与新接口测试FAIL。
- [ ] **Step 3:** 公开sendControlKey，加入pending/composing/uncertain门禁。textarea onKeydown传四flags，Input的sendKey调用sendChord({code,modifiers:{shift:Boolean(flags.shiftKey),ctrl:Boolean(flags.ctrlKey),alt:Boolean(flags.altKey),meta:Boolean(flags.metaKey)}})；controller现有pressed自动合并虚拟modifier。含modifier走context-change，无modifier更新cursor。新modifier down不单发，但config新增releaseTrackedKey(event):boolean，Input注入controller.handleDomEvent，adapter.onKeyup先调用再stopPropagation：释放画面原已跟踪key，未跟踪keyup不发送。composition/pending/unsupported/停用均不得阻断安全释放。测试真实textarea Shift+Arrow平衡chord、无额外up；画面Shift或KeyA down→show→textarea up后pressed=0且sendText恢复。其余操作使用callback事务：

```js
function runExternalAction(kind, send) {
  if (composing || hasPending || deliveryUncertain) return false;
  if (send() !== true) return false;
  // 只失效化已接受历史，建立新游标上下文，不发送删除或文本。
  resetAcceptedHistory();
  return true;
}
```

`resetAcceptedHistory()` 在本任务定义为取消当前drain、generation++、acceptedValue/draftValue=哨兵、cursor=0、contextValid=true；只能在无pending且允许的外部动作成功后调用。

- [ ] **Step 3a（R12）:** sendControlKey以四flags或hasVirtualModifiers()为true判断带修饰导航；toolbar也传click事件的物理flags。加真实controller测试virtual Shift锁定→textarea ArrowLeft四flags全false：chord保持Shift且无多余modifier down/up，移动历史失效而非cursor--，virtual pressed truth不变；既有释放仍可用。
- [ ] **Step 4:** 原action-bar和mobile-key-row使用同一编排。touch beforeGesture只读取草稿门禁；commitGesture接runExternalAction('context-change',send)，实际down接受才清历史。非touch实际down同样包装。up/reset永远流通，已接受手势的move/up不重复门禁。测试触点开始历史不变、成功down历史归零、failed down历史保留、long-press等待期间出现pending则不发送并consume；不以虚拟send()=>true代替真实sendMouse返回值。
- [ ] **Step 4a (R10):** 按spec§5.1在Input集中增加surface settled/pending/uncertain+generation门禁，复用已有_desktopWritePending/acceptMouseAck。getMobileSurfaceContextSnapshot()仅state/generation；首down接受设pending，手势结束且down/up可靠ACK成功才settled。匹配失败ACK或3000ms超时设uncertain并adapter.onTransportState('reacquire-required')，不改lease；迟到ACK不解锁。isDeliverySettled叠加surface settled，文本等待时只存草稿，成功只刷UI、显式retry；安全up/reset/keyup永不阻断。reset/lease/park取消timer；discard清本地等待并提示核对，绝不补发。覆盖touch/mouse/pen/rightClick，测试down-ACK先于up、up后ACK、失败ACK、超时/迟到/旧leaseACK、控制安全释放、等待期间输入与确认后显式重试。确认正常连续文本不会仅因普通键盘ACK在途被迫每字手动retry。
- [ ] **Step 4a补充:** 目标down的历史失效和surface pending作为同一次本地事务提交，不能被刚关闭的isEnabled门禁反向拒绝。surface进入uncertain时取消无关owned keyboard reset的重建许可，或保留独立surface否决；加鼠标失败/timeout后到达键盘reset成功ACK仍不允许文本/自动重试的交叉ACK回归。
- [ ] **Step 4a审查补充:** down/up确认乱序且pending累计清理后仍正确关联；3000ms只计算已发送未确认的边，down已确认的长拖拽不误超时，up另启等待，迟到/旧代仍失败关闭。document真实keydown监听器读取新写入门禁，keyup不受阻；VM夹具需保留同type多个监听器，不能被modal Escape监听器覆盖制造假绿。虚拟modifier关闭读取controller pressed真相并调用原setVirtualModifier(false)，门禁仅阻止新按下，不阻断已有释放，不手造报文。
- [ ] **Step 4b (R11):** 普通文本modal打开先过移动草稿/composition/uncertain/surface门禁；开/取消不清历史。submit和compositionend共用runMobileEditingAction('context-change',()=>controller.sendText(text))；接受才清移动历史并关modal，false保留草稿且不关闭。测试移动abc→modal X→移动left/Y不沿用旧cursor、pending禁开、取消/失败保留、compositionend与click不重复、unsupported禁发。
- [ ] **Step 5:** 对按钮pointerdown保留文本焦点；composition时显式拒绝导航并提示，不blur触发隐式提交。把移动编辑snapshot传给ChromeLayout idle/capability，明确visible/composing/pending/blocked状态与按钮enabled对应关系。
- [ ] **Step 5审查补充:** public sendControlKey覆盖compositionstart但value尚未变化；surface-user helper及实际video/relay pointer/click在composing/pending/uncertain时先预检并阻止默认抢焦点，不能仅阻止down报文。
- [ ] **Step 6:** Run `node --test web-client/js/mobile-text-input.test.js web-client/js/input.test.js web-client/js/touch-input-adapter.test.js web-client/js/chrome-layout.test.js`；补tap重新选目标、paste/selectAll、失败callback不清基线、modifier保留、安全释放不受阻、重复init不重复listener的断言。
- [ ] **Step 7:** 暂存并check，提交 `fix(viewer): synchronize mobile navigation and text context`。

### Task 5: 键盘避让与宽屏iPad（F2/F6）

**Files:** Modify `web-client/js/chrome-layout.js`, `web-client/js/input.js`, `web-client/css/viewer.css`, `web-client/viewer.html`; Test `web-client/js/chrome-layout.test.js`, `web-client/js/input.test.js`, `web-client/css/viewer-layout.test.js`。

**Interfaces:** Produces `ChromeLayout.computeMobileLayout(input)`，字段/输出严格按spec §7；Input新增 `setViewportInputSupported(supported:boolean)`，默认true，只保存派生布局门禁；Consumes adapter状态及真实Dock/textDock测量。

- [ ] **Step 1:** 新建纯函数测试，覆盖overlay键盘与visualViewport缩小两条路线，二者均得到512可用高度而非212。

```js
test('keyboard inset is consumed once', () => {
  const base = {layoutHeight:812,visualHeight:512,offsetTop:0,
    keyboardRectHeight:300,keyboardOverlay:true,safeBottom:0,
    chromeTop:44,dockContentHeight:44,textDockHeight:80,textVisible:true,touchSupported:true};
  const overlay = ChromeLayout.computeMobileLayout(base);
  const resize = ChromeLayout.computeMobileLayout({...base,keyboardOverlay:false});
  assert.equal(overlay.availableHeight,512);
  assert.equal(resize.availableHeight,512);
  assert.equal(overlay.viewerHeight,336);
});
```

- [ ] **Step 2:** Run `node --test web-client/js/chrome-layout.test.js` 确认FAIL；记录旧CSS在375/768/1024三种尺寸的离线几何失败（原report evidence为缺陷快照，不改其输出）。
- [ ] **Step 3:** 在ChromeLayout内实现纯计算，用finite/clamp处理undefined、NaN与负数；overlay只在overlaysContent生效且rect有效时启用，其余走visualViewport。

```js
// 先把所有输入转为有限非负数，再使用同一clamp helper。
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const visibleTop = keyboardOverlay ? 0 : clamp(offsetTop, 0, layoutHeight);
const visibleBottom = keyboardOverlay
  ? layoutHeight - clamp(keyboardRectHeight, 0, layoutHeight)
  : clamp(visualHeight + visibleTop, visibleTop, layoutHeight);
const availableHeight = Math.max(0, visibleBottom - visibleTop);
const bottomInset = Math.max(0, layoutHeight - visibleBottom);
const textReserve = textVisible ? textDockHeight : 0;
const dockBottom = bottomInset + safeBottom + textReserve + 8;
const viewerTop = visibleTop + chromeTop;
const viewerHeight = Math.max(0, availableHeight - chromeTop - safeBottom
  - textReserve - dockContentHeight - 8);
```

- [ ] **Step 4:** 移除mobileKeySurface键盘padding。仅touch且desktop tab启用body.mobile-layout-managed：body padding-top=0；viewer fixed top=--mobile-viewer-top、height=--mobile-viewer-height、margin=0；statusBar top=--mobile-visible-top；chromeDocks bottom=--mobile-dock-bottom且无idle translateY；textDock bottom=--mobile-text-bottom。属性分别由spec§7.1的同名输出与bottomInset+safeBottom写入px。旧899px flow/dvh/reserve公式不得叠加；退出managed模式移除派生覆盖，Terminal与非触控桌面原样。静态加入aria-hidden的mobileSafeAreaProbe，CSS padding-bottom=env(safe-area-inset-bottom,0px)，fixed零尺寸/不可交互/visibility:hidden，从computedStyle读取有限px，无值0。
- [ ] **Step 5:** 依spec实现compact/ultraCompact。两条mobile-key-row保留DOM与role，各为flex:0 0 auto/nowrap/高44px；mobileKeySurface为高44px的单行flex nowrap横向滚动，两组在同一行，所有快捷键滑动可达，不复制按钮或监听器。顶部必要动作和“更多”，普通action/control bar通过更多overlay显示、不计导航行高度；实际测量含retry UI的textDock。ultraCompact三个44px行及8px间距，低于140+safeBottom时unsupportedViewport=true，仅派生门禁停止新写入，up/reset可发、恢复不重放。测试父高44、两组末键scrollIntoView可点击、快捷键每click只发一次，不缩小触控目标。
- [ ] **Step 6:** mode先按touchSupported/textVisible/availableHeight选择，ultraCompact阈值固定availableHeight<360，不依赖修改后的viewerHeight；ResizeObserver测量在一帧内归并，值相同不写。测试offsetTop=100/visualHeight=400时availableHeight=400、visibleBottom=500，不能算500px可见高度；顶部chrome随visibleTop定位。再覆盖safe-area、VK未生效、899px跨界、关闭恢复与20帧稳定。更新旧CSS regex测试，删除要求重复padding的断言。
- [ ] **Step 7:** Run `node --test web-client/js/chrome-layout.test.js web-client/js/input.test.js web-client/css/viewer-layout.test.js`。补充unsupported时阻止新text/down/toolbar/物理keydown但keyup/up/reset可发送、草稿保留、恢复尺寸不重放。Task7浏览器必须再验证≥120px画面和控件可达，不以pure function PASS完成整个F2/F6验收。
- [ ] **Step 8:** 暂存并check，提交 `fix(viewer): unify keyboard avoidance on phones and tablets`。

### Task 6: 完整Viewer全屏（F7）

**Files:** Modify `web-client/js/ui.js`, `web-client/viewer.html`, `web-client/css/viewer.css`; Create `web-client/js/ui.test.js`; Test `web-client/css/viewer-layout.test.js`。

**Interfaces:** ConsumesTask1焦点策略和Task5布局；UI保留setupControlButtons，对外按钮ID保持；全屏目标固定document.documentElement。

- [ ] **Step 1:** 新建ui.test.js，以vm载入真实ui.js并在源尾导出`globalThis.__UI=UI`。DOM提供getElementById/querySelector、event listeners、documentElement.requestFullscreen计数；给fullscreenBtn listener模拟点击，断言请求目标是documentElement。拒绝promise时断言可见提示且未修改焦点/草稿。

```js
// 测试核心期望；h 在此文件定义为上述真实UI的DOM fixture。
await h.click('fullscreenBtn');
assert.equal(h.requestedTarget, h.document.documentElement);
h.document.fullscreenElement = h.document.documentElement;
h.dispatchDocument('fullscreenchange');
assert.equal(h.videoFocusCount, 0);
```

- [ ] **Step 2:** Run `node --test web-client/js/ui.test.js`，旧实现应请求viewerContainer而失败。
- [ ] **Step 3:** 改UI requestFullscreen与fullscreenchange比较目标，移除直接focus；无API/reject走可见status提示，保持普通视图。CSS按html:fullscreen选中画面和退出入口，不再只匹配viewer-container:fullscreen。
- [ ] **Step 4:** 静态HTML把唯一exitFullscreenBtn从viewer-container移到`#statusBar .status-actions`，保留ID与已有监听器；fullscreenBtn仍为原启动入口。仅在documentElement全屏时显示退出按钮，任何tab/compact/idle状态均可见且不受桌面ACTIVE租约门禁；不复制ID、不重挂载textarea。测试enter→exit→enter、resize、Terminal tab、控制权失效仍可退出、保存焦点；不修改Terminal/PTY实现。
- [ ] **Step 5:** Run `node --test web-client/js/ui.test.js web-client/js/input.test.js web-client/js/terminal.test.js web-client/css/viewer-layout.test.js`。
- [ ] **Step 6:** 暂存并check，提交 `fix(viewer): retain mobile controls in fullscreen`。

### Task 7: 浏览器集成、构建与文档闭环

**Files:** Create `scripts/mobile_input_interaction_acceptance.py`, `scripts/mobile-input-interaction-acceptance.test.js`, `docs/superpowers/reports/2026-09-06-mobile-input-interaction-remediation-acceptance.md`; Modify README、需求§3.4、新spec/plan状态、旧移动设计/验收的后续状态链接。

**Interfaces:** CLI `python3 scripts/mobile_input_interaction_acceptance.py --out PATH [--browser chromium|webkit]`；默认chromium；结果`scope=offline-synthetic`，每场景PASS/FAIL/NOT RUN，FAIL进程exit1，缺browser运行依赖exit2且写NOT RUN。

- [ ] **Step 1:** 建Node测试启动CLI `--help`与结果解析：不得读取.env/password，不提供base-url参数，不启动服务；历史证据脚本保持不变，新脚本断言修复后的期望。
- [ ] **Step 2:** Playwright只加载本地源码，去除script/link远程引用，route.abort所有请求；注入现有KeyboardTransport/Controller/Input/ChromeLayout/UI与fake socket。允许日志只有场景名/状态/计数，正文/事件坐标/用户数据不写artifact；布局输出布尔覆盖关系和safe摘要。

```python
# 场景核心（page由本地fixture创建，不连接实际Host）：
page.evaluate("Input.mobileTextInputAdapter.show()")
page.evaluate("for(let i=0;i<120;i++) Input.setActive(true)")
assert page.evaluate("document.activeElement.id") == 'mobileTextInput'
assert page.evaluate("document.documentElement.contains(document.getElementById('mobileInputDock'))")
```

- [ ] **Step 3:** 加动作组合：真实DOM组合输入→120帧→工具栏left→继续输入→局部失败→retry→reset取消任务；使用虚拟远端字符串模型只在内存核对，不打印字符串。加drag起点、up/reset、第二指切滚动及新lease未重放测试。
- [ ] **Step 3a:** 加R9–R11跨模块验收：已跟踪physical key跨焦点keyup、鼠标down/up确认与失败/timeout阻止文本、modal提交后的移动基线失效。使用真实Input/adapter/controller及fake ACK，断言待确认期间无远端文本，确认不自动重放、显式retry恰好一次。
- [ ] **Step 4:** 浏览器布局矩阵375×812、768×1024、1024×1366、1440×900使用inset=0/300；568×320用inset=0/160覆盖ultraCompact，inset300仅测unsupportedViewport降级。触控true/false、overlay/resize两模式。前三种compact画面≥120，导航/retry/退出≥44×44且在键盘之上；实际rect误差≤1px：viewer.top=viewerTop、viewer.bottom<=dock.top、dock.bottom=visibleBottom-safeBottom-textReserve-8、text.bottom=visibleBottom-safeBottom、顶栏bottom<=viewer.top。测safeProbe注入、offsetTop非零、两组末键滚动可达；unsupported不假计全控件可达。真实DOM点全屏按钮，支持时验证fullscreenElement及可见可点；不支持明确NOT RUN原生全屏并测fallback。
- [ ] **Step 5:** 先运行新CLI与单测红/绿，再进行最终命令（每条按对应目录执行，不能把cd串错）：

```bash
node --test web-client/js/*.test.js web-client/css/*.test.js
node --test scripts/mobile-input-interaction-acceptance.test.js
python3 scripts/mobile_input_interaction_acceptance.py --out /tmp/wrd-mobile-interaction-chromium.json
python3 scripts/mobile_input_interaction_acceptance.py --browser webkit --out /tmp/wrd-mobile-interaction-webkit.json
```

signal-server目录：`npm run build:web`，然后`npm test`。本计划未改Host，不要求为文档/前端改动反复全跑Host；如果发生协议/Host疑点，停止扩大改动并先补证据。依赖缺失先用现有已安装依赖的路径解决，不擅改lockfile或把缺依赖计成PASS。

- [ ] **Step 6:** 写acceptance，逐F编号标`代码修复/自动化PASS/真实设备NOT RUN`。记录所有命令退出码和测试数；WebKit缺依赖与真机缺失分别写原因。保留原7项报告为历史发现并补后续链接，不能改历史缺陷脚本为假绿。
- [ ] **Step 7:** 最终独立review新diff，检查所有F编号、草稿不重复/不串lease、focus不抢、layout仅算一次、全屏实际contain与构建装配。修完发现才勾对应完成项。
- [ ] **Step 8:** `git diff --check`，逐路径暂存本次代码/测试/文档；审阅`git diff --cached --name-only`和`git diff --cached --check`后提交 `test(viewer): verify mobile interaction remediation`。本计划不会自动授权main merge、push或服务重启。

## Spec Coverage / 完成门槛

| Spec / 报告 | 实施任务 | 自动化证据 |
|---|---|---|
| §3 / F1 | 1、7 | 连续frame不抢焦点、modal/Terminal、show/hide |
| §4 / F5 | 3、7 | 未发草稿、局部成功、unknown不重试、16步取消 |
| §5 / F3 | 4、7 | toolbar/textarea同游标、context-change、安全释放 |
| §6 / F4 | 2、7 | 初始down坐标、几何改变reset |
| §7 / F2/F6 | 5、7 | overlay/resize单计数、窄/宽/极小屏实际矩形 |
| §8 / F7 | 6、7 | documentElement全屏、退出、reject、Terminal切换 |
| §2/§9 全局 | 全部、7 | scope检查、build、privacy、NOT RUN分类 |

完成判断：F1–F7代码及必要自动化均通过、独立review无未解决P1/P2，才可称“代码整改完成”；缺少实机/公网仍不能称“移动端全链路验收完成”。
