# 远程桌面控制连续性修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让已合入的移动端遥控和可靠桌面写入在真机上真正可用：触控坐标、虚拟键命中、seq/lease/ACK、断连切模式、loading 遮挡、媒体暂停、刷新后出画门闩、冷启动 SPS，以及文档状态与代码一致。
**Current status:** Tasks 1–4b are implemented and automated-tested; Task 5 documentation sync is recorded below. Real-device geometry, physical Quartz input, and public-path acceptance remain `NOT RUN`.

**Architecture:** 不新增协议。`Input` 仍是唯一发送入口；Host `ReliableDesktopWriteState` 改为执行成功后提交；lease 失配的 mouse up/reset 绕过 write-state 做安全释放。测试先用真实 PointerEvent/不可枚举 getter 替换假绿夹具。

**Tech Stack:** Vanilla JS、Node `node:test`、Python pytest、现有 v2 envelope / DesktopControlLease。

**Spec:** `docs/superpowers/specs/2026-09-03-remote-desktop-control-continuity-remediation-design.md`

## Global Constraints

- 不新增网络模式、信令协议、npm 依赖或第二套 DesktopControlLease。
- 不启动、停止、重启或重建 Cloudflare tunnel。
- 真机/公网无操作者证据时标 `NOT RUN`，不得用 Playwright 桌面模拟冒充。
- 提交前 `git diff --cached --name-only` 与 `git diff --cached --check`；不把无关 dirty 文件打进提交。
- 现有全量 JS/Python 测试必须保持通过。

## 文件责任表

| 文件 | 责任 |
|---|---|
| `web-client/js/input.js` | PointerEvent 几何拷贝、seq 发送成功后占用、lease 重获清 mouse reset |
| `web-client/js/input.test.js` | 不可枚举坐标、seq 不烧毁、lease 清屏障 |
| `web-client/js/touch-input-adapter.test.js` | 真实 PointerEvent 夹具 |
| `web-client/css/viewer.css` | `#mobileKeySurface` pointer-events；loading 非 signaling 不拦截 |
| `web-client/css/viewer-layout.test.js` | 虚拟键命中与 loading pointer-events 契约 |
| `web-client/js/webrtc.js` | ACK 隔离、setNetworkMode 断连重连、媒体暂停不 resetKeyboard、setUiPhase 不假 fresh-frame、刷新清 paint 基线 |
| `web-client/js/webrtc.test.js` | 改掉 keyboard ACK 清 mouse reset；补断连切模式、暂停、refresh paint 基线 |
| `web-client/js/chrome-layout.js` | loading 仅 signaling 拦截 |
| `python-host/input_handler.py` | 执行成功后提交 seq |
| `python-host/host.py` | stale-lease 安全释放；offer 调 `transition_desktop_writes`；冷启动不 armed SPS refresh |
| `python-host/test_input_handler.py` / `test_remote_desktop_write_state.py` / `test_offer_epoch.py` | Host 契约 |
| `docs/superpowers/specs/*.md`、`docs/需求文档/WebRemoteDesktop-需求文档.md` | 状态与入口口径 |

---

### Task 1: 真机触控坐标与虚拟键命中

**Files:**
- Modify: `web-client/js/input.js`
- Modify: `web-client/js/input.test.js`
- Modify: `web-client/js/touch-input-adapter.test.js`
- Modify: `web-client/css/viewer.css`
- Modify: `web-client/css/viewer-layout.test.js`

**Interfaces:**
- Consumes: `Input.getRelativeCoords(event, allowOutside)`
- Produces: `mapPoint` 对真实 PointerEvent 返回有限 `relX/relY`；`#mobileKeySurface` 可点

- [x] **Step 1: 写失败测试——不可枚举 clientX 仍能映射**

在 `web-client/js/input.test.js` 增加：

```javascript
function hiddenPointer(clientX, clientY) {
  const event = { currentTarget: null, pointerType: 'touch', pointerId: 1, preventDefault() {} };
  Object.defineProperty(event, 'clientX', { value: clientX, enumerable: false });
  Object.defineProperty(event, 'clientY', { value: clientY, enumerable: false });
  return event;
}

test('touch mapPoint keeps PointerEvent prototype geometry', () => {
  const { Input, context } = loadInput();
  activate(Input, context);
  const video = context.document.getElementById('remoteVideo');
  Input.refreshGeometry = () => ({ left: 0, top: 0, width: 200, height: 100 });
  const adapter = Input.bindTouchAdapter(video);
  const point = adapter && Input.getRelativeCoords(
    Object.assign(hiddenPointer(40, 25), { currentTarget: video }),
    false,
  );
  assert.equal(Number.isFinite(point?.relX), true);
  assert.equal(Number.isFinite(point?.relY), true);
});
```

同时把 `touch-input-adapter.test.js` 的 dispatch 改为带不可枚举 getter 的事件（或 `new PointerEvent` 若 jsdom/node 可用）。

- [x] **Step 2: 写失败测试——虚拟键恢复命中**

在 `viewer-layout.test.js` 断言 CSS 包含：

```css
#mobileKeySurface,
#mobileKeySurface .mobile-key-btn {
  pointer-events: auto;
}
```

- [x] **Step 3: 跑测试确认当前失败**

Run: `node --test web-client/js/input.test.js web-client/css/viewer-layout.test.js`
Expected: 新断言 FAIL。

- [x] **Step 4: 最小实现**

`input.js` `mapPoint` 改为：

```javascript
mapPoint: (event, allowOutside) => {
  const point = this.getRelativeCoords({
    currentTarget: element,
    clientX: event.clientX,
    clientY: event.clientY,
    pointerId: event.pointerId,
    timeStamp: event.timeStamp,
    button: event.button,
    buttons: event.buttons,
    pointerType: event.pointerType,
  }, allowOutside);
  if (point) this._lastTouchAdapter = adapter;
  return point;
},
```

`viewer.css` 在 `#mobileKeySurface` 规则增加 `pointer-events: auto`，按钮同样。

- [x] **Step 5: 再跑测试确认通过并提交**

```bash
node --test web-client/js/input.test.js web-client/js/touch-input-adapter.test.js web-client/css/viewer-layout.test.js
git add web-client/js/input.js web-client/js/input.test.js web-client/js/touch-input-adapter.test.js web-client/css/viewer.css web-client/css/viewer-layout.test.js
git commit -m "fix(viewer): map real pointer geometry and restore mobile key hits"
```

---

### Task 2: Viewer 可靠写入 seq 与 mouse reset 屏障

**Files:**
- Modify: `web-client/js/input.js`
- Modify: `web-client/js/input.test.js`
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/js/webrtc.test.js`

**Interfaces:**
- Consumes: `WebRTC.sendInput(data) -> boolean`，socket.emit
- Produces: 失败不占 seq；`acceptMouseAck` 仅 mouse；lease 重获清失败屏障

- [x] **Step 1: 写失败测试——无 transport 的 down 不占 seq**

```javascript
test('failed reliable mouse write does not consume desktop seq', () => {
  const { Input, context } = loadInput();
  activate(Input, context);
  Input.socket = { connected: false, emit() {} };
  context.WebRTC.socket.connected = false;
  context.WebRTC.sendInput = () => false;
  assert.equal(Input.sendInput('mouse', 'down', {
    relX: 0.2, relY: 0.3, button: 'left', clickCount: 1, buttons: 1,
  }), null);
  assert.equal(Input._desktopWriteSequence, 0);
  context.WebRTC.socket.connected = true;
  Input.socket = context.WebRTC.socket;
  const id = Input.sendInput('mouse', 'down', {
    relX: 0.2, relY: 0.3, button: 'left', clickCount: 1, buttons: 1,
  });
  assert.ok(id);
  assert.equal(Input._desktopWriteSequence, 1);
});
```

- [x] **Step 2: 写失败测试——键盘 ACK 不能清 mouse reset；lease 重获能清**

```javascript
test('keyboard acknowledgement does not clear pending mouse reset', () => {
  const { Input } = loadInput();
  Input._pendingMouseReset = true;
  Input._pendingMouseResetId = 'inp_reset';
  assert.equal(Input.acceptMouseAck({
    inputType: 'keyboard', status: 'applied', inputIds: ['inp_reset'],
  }).status, 'stale');
  assert.equal(Input._pendingMouseReset, true);
});

test('new active lease clears a failed mouse reset barrier', () => {
  const { Input, context } = loadInput();
  activate(Input, context);
  Input._pendingMouseReset = true;
  Input._pendingMouseResetId = null;
  Input.setControlLease({ leaseId: 'lease-000000000099', leaseEpoch: 9 });
  assert.equal(Input._pendingMouseReset, false);
});
```

把 `webrtc.test.js` 中 `inputType: 'keyboard'` 同时清 mouse reset 的断言改为：键盘 ACK 只清 keyboard pending，mouse 屏障仍在，直到 mouse ACK。

- [x] **Step 3: 跑测试确认失败**

Run: `node --test web-client/js/input.test.js web-client/js/webrtc.test.js`

- [x] **Step 4: 最小实现**

`sendInput`：先组 envelope 但不 `++seq`；DC 或 socket 成功后再：

```javascript
if (type !== 'mouse' || action !== 'move') data.seq = ++this._desktopWriteSequence;
```

若必须在 send 前放入 JSON，则先拷贝 payload，成功后再赋 seq 并发送；失败不递增。

`acceptMouseAck` 开头：

```javascript
if (ack?.inputType && ack.inputType !== 'mouse') return { status: 'stale' };
```

`setControlLease` 在 leaseId/epoch 变化且 `nextLease` 有效时：

```javascript
this._pendingMouseReset = false;
this._pendingMouseResetId = null;
this._desktopWriteSequence = 0;
```

`webrtc.js` 保持 keyboard ACK 的 `inputType === 'keyboard'` 过滤。

- [x] **Step 5: 测试通过并提交**

```bash
node --test web-client/js/input.test.js web-client/js/webrtc.test.js
git commit -m "fix(viewer): assign desktop seq after send and isolate mouse reset acks"
```

---

### Task 3: Host 执行后提交 seq、stale-lease 安全释放、offer 绑定 desktop writes

**Files:**
- Modify: `python-host/input_handler.py`
- Modify: `python-host/host.py`
- Modify: `python-host/remote_desktop_write_state.py`（如需 `peek`/`commit` 分离则改；否则 handler 内延迟 apply）
- Modify: `python-host/test_input_handler.py`
- Modify: `python-host/test_offer_epoch.py`

**Interfaces:**
- Consumes: `ReliableDesktopWriteState.validate/apply/transition`
- Produces: Quartz 成功后才 `last_applied_seq`；lease 失配 reset 仍释放按钮；offer 调 `transition_desktop_writes`

- [x] **Step 1: 写失败测试**

`test_input_handler.py`：

```python
@pytest.mark.asyncio
async def test_failed_mouse_execute_does_not_commit_seq():
    handler = InputHandler(keyboard_adapter=RecordingAdapter())
    handler._running = True
    handler.transition_desktop_writes(lease_id=LEASE_ID, lease_epoch=1)
    def boom(action, payload):
        raise RuntimeError("quartz")
    handler._handle_mouse = boom
    with pytest.raises(RuntimeError):
        await handler.handle_input(desktop_envelope(
            action="down", seq=1, input_id="down-1",
            payload={"relX": 0.2, "relY": 0.3, "button": "left", "clickCount": 1, "buttons": 1},
        ))
    assert handler._desktop_writes.snapshot().last_applied_seq == 0
```

若 `handle_input` 吞异常，则断言返回 `execution-failed` 且 `last_applied_seq==0`。

再测：`monitor is None` 的 down 不得 `status==applied`。

`test_offer_epoch.py` 或 host 测试：`on_offer` 成功路径调用 `transition_desktop_writes`。

Host 安全释放：lease 失配的 v2 reset 仍调用 `release_all_mouse_buttons`。

- [x] **Step 2: 跑 pytest 确认失败**

Run: `cd python-host && PYTHONPATH=. python3 -m pytest -q test_input_handler.py test_offer_epoch.py`

- [x] **Step 3: 最小实现**

推荐把 `ReliableDesktopWriteState.apply` 拆成校验+`commit(seq)`；`handle_input` 流程：

1. `validate_desktop_write`
2. lease 匹配检查
3. 可靠写入：若 `seq != last+1` 返回 gap/duplicate，**不执行**
4. 执行 `_handle_mouse` / `_handle_command`
5. 成功后 `commit(seq)` 再 ACK `applied`

`host.py` lease 失配：

```python
if input_type == "mouse" and action in ("up", "reset"):
    self.input_handler.release_all_mouse_buttons(reason="stale-lease-safety")
    return
```

不要再 `await handle_input(data)`。

`on_offer` 在 `transition_keyboard` 成功后：

```python
desktop_result = self.input_handler.transition_desktop_writes(
    lease_id=binding["leaseId"], lease_epoch=binding["leaseEpoch"],
)
if desktop_result.status != "applied":
    logger.warning("Ignoring offer with rejected desktop write binding")
    return
```

- [x] **Step 4: pytest 通过并提交**

```bash
cd python-host && PYTHONPATH=. python3 -m pytest -q
git commit -m "fix(host): commit desktop seq after execute and honor stale mouse reset"
```

---

### Task 3b: v2 修饰键权威状态与 DC close 用当前 lease

**Files:**
- Modify: `python-host/remote_keyboard_state.py`
- Modify: `python-host/test_remote_keyboard_state.py`
- Modify: `python-host/host.py`
- Modify: `python-host/test_offer_epoch.py` 或现有 DC close 测试

- [x] **Step 1: 写失败测试**

```python
def test_v2_plain_key_releases_lost_control_before_letter():
    adapter = RecordingAdapter()
    state = RemoteKeyboardState(adapter=adapter)
    state.transition(connection_generation=1, lease_id=LEASE_ID, lease_epoch=1)
    assert state.apply(key_envelope(seq=1, phase="down", code="ControlLeft")).status == "applied"
    letter = key_envelope(seq=2, phase="down", code="KeyA")
    letter["payload"]["modifiers"] = {
        "altKey": False, "ctrlKey": False, "metaKey": False, "shiftKey": False,
    }
    assert state.apply(letter).status == "applied"
    assert adapter.events[-2][:2] == ("ControlLeft", False)
    assert adapter.events[-1][:2] == ("KeyA", True)
```

DC close：channel 打开时 binding epoch=1，之后 `_active_input_binding.epoch=2`，close 仍必须 `reset_keyboard`。

- [x] **Step 2: 跑测试确认失败**

- [x] **Step 3: 最小实现**

`_apply_key` 在非修饰 down 前用 payload.modifiers 对账；IME 导航键不带 phantom mask。`on_close` 用当前 `_active_input_binding`，channel 仍是 `_input_datachannel` 则必须 reset。

- [x] **Step 4: 提交**

```bash
cd python-host && PYTHONPATH=. python3 -m pytest -q test_remote_keyboard_state.py
git commit -m "fix(host): honor v2 modifier payload and reset on live datachannel close"
```

---

### Task 4: 断连切模式、loading 遮挡、媒体暂停、session fresh-frame

**Files:**
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/js/webrtc.test.js`
- Modify: `web-client/js/chrome-layout.js`
- Modify: `web-client/js/chrome-layout.test.js`
- Modify: `web-client/css/viewer.css`

**Interfaces:**
- Consumes: `ChromeLayout.getCapabilities`、`Input.setActive`/`parkKeyboard`
- Produces: 断连切模式会重连；非 signaling overlay 不拦截；暂停不开键盘 reset barrier；假 connected 不把 media 置 live

- [x] **Step 1: 写失败测试**

```javascript
test('disconnected mode switch reconnects when socket is down', () => {
  const { WebRTC } = loadWebRTC();
  WebRTC.uiPhase = 'disconnected';
  WebRTC.socket = { connected: false };
  let inits = 0;
  WebRTC.refresh = () => { throw new Error('must not refresh'); };
  WebRTC.connectSignaling = () => { inits += 1; };
  // 实现可复用现有 init/createSocket；测试断言 refresh 不被调用且发起了信令连接
  WebRTC.setNetworkMode('relay');
  assert.equal(WebRTC.networkMode, 'relay');
  assert.equal(inits, 1);
});

test('media suspend does not open a keyboard reset barrier', () => {
  const { WebRTC, context } = loadWebRTC({ realInput: true });
  const calls = [];
  context.__Input.resetKeyboard = (reason) => { calls.push(reason); };
  context.__Input.setActive = () => {};
  WebRTC.applyMediaActivity({ state: 'suspended', generation: 1, reasons: ['page-hidden'] });
  assert.equal(calls.includes('media-suspended'), false);
});
```

chrome-layout：非 signaling 时 `#loading` 有 `hidden` 或等价 `pointer-events: none`。

session：`hasPaintedFrame===false` 时 `setUiPhase('connected')` 后 `snapshot().media !== 'live'`。若产品不允许未出画 connected，改为保持 `media-pending`。

`syncDesktopInputGate`：`uiPhase === 'media-stalled'` 时 `Input.setActive(false)`；瞬时 `session.media==='stalled'` 但 `uiPhase` 仍为 `connected` 时保持输入（TURN ≤2s 追帧）。

- [x] **Step 2: 跑测试确认失败**

- [x] **Step 3: 最小实现**

`setNetworkMode`：

```javascript
if (this.socket && this.socket.connected) {
  this.refresh({ reason: 'manual-mode-switch' });
} else {
  this.init(); // 或现有 createSocket/connect 入口，不得只 beginConnectionAttempt
}
```

`applyCapabilities`：`loading.classList.toggle('hidden', snapshot.uiPhase !== 'signaling' && snapshot.uiPhase !== 'idle')` 需与 Start 按钮可见性一起设计：idle 仍显示 CTA；disconnected 显示 overlay 文案但 `pointer-events: none` 于视频，按钮自身 `pointer-events: auto`。优先 CSS：

```css
.stream-placeholder:not(.is-connecting):not(.idle-cta) {
  pointer-events: none;
}
.stream-placeholder .start-btn,
.stream-placeholder #coreRetryBtn {
  pointer-events: auto;
}
```

idle CTA 仍可点开始。

删除 `Input.resetKeyboard?.('media-suspended')`。

`setUiPhase` connected 分支：

```javascript
if (this.hasPaintedFrame === true) {
  session.applyMedia({ attemptId: this.currentConnectionAttemptId, event: 'fresh-frame', fresh: true });
} else {
  session.applyMedia({ attemptId: this.currentConnectionAttemptId, state: 'pending' });
}
```

- [x] **Step 4: 测试通过并提交**

```bash
node --test web-client/js/webrtc.test.js web-client/js/chrome-layout.test.js web-client/css/viewer-layout.test.js
git commit -m "fix(viewer): recover disconnected mode switch and stop overlay from eating clicks"
```

---

### Task 4b: 刷新 paint 基线与冷启动 SPS

**Files:**
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/js/webrtc.test.js`
- Modify: `python-host/host.py`
- Modify: `python-host/test_connection_diagnostics.py` 或新增 focused stall-refresh 测试

**Interfaces:**
- Consumes: `beginConnectionAttempt`、`notePaintStats`、`_refresh_decoder_on_stall`
- Produces: 新 PC `framesDecoded` 从 0 可出画；无健康 FPS 样本前不 `request_decoder_refresh`

- [x] **Step 1: 写失败测试**

```javascript
test('refresh attempt compares paint growth against a zero inbound baseline', () => {
  const { WebRTC } = loadWebRTC();
  WebRTC._lastInboundFramesDecoded = 400;
  WebRTC.hasPaintedFrame = true;
  WebRTC.beginConnectionAttempt('refresh');
  assert.equal(WebRTC.hasPaintedFrame, false);
  assert.equal(WebRTC._paintDecodedBaseline, 0);
  assert.equal(WebRTC._lastInboundFramesDecoded, 0);
  WebRTC.notePaintStats({ videoWidth: 1280, framesDecoded: 2, framesReceived: 2, fps: 20 });
  assert.equal(WebRTC.hasPaintedFrame, true);
});
```

Host：构造从未有过 8–25 FPS 的 stats `fps=0, framesReceived=10`，断言 `request_decoder_refresh` 不被调用；先喂 `fps=20` 再 `fps=0` 才允许 refresh。

- [x] **Step 2: 跑测试确认失败**

- [x] **Step 3: 最小实现**

`beginConnectionAttempt`：

```javascript
this.hasPaintedFrame = false;
this._lastInboundFramesDecoded = 0;
this._paintDecodedBaseline = 0;
```

`_refresh_decoder_on_stall` 初始 `armed=False`；`last==0` 且从未健康过则 return False。

- [x] **Step 4: 测试通过并提交**

```bash
node --test web-client/js/webrtc.test.js
cd python-host && PYTHONPATH=. python3 -m pytest -q test_connection_diagnostics.py
git commit -m "fix(media): reset paint baseline on refresh and arm stall SPS only after healthy fps"
```

在同一任务或紧随其后补刷新互斥：

```javascript
test('stale pc-connected dc-wait timer cannot clear a newer refresh', async () => {
  const { WebRTC } = loadWebRTC();
  WebRTC._refreshing = true;
  WebRTC.inputChannel = { readyState: 'connecting' };
  WebRTC.onPeerConnected();
  WebRTC._refreshing = true; // simulate a second refresh starting
  // fire the first wait timer
  await new Promise((r) => setTimeout(r, 2100));
  assert.equal(WebRTC._refreshing, true);
});

test('non-forced refresh is ignored while _refreshing', () => {
  const { WebRTC } = loadWebRTC();
  WebRTC._refreshing = true;
  WebRTC._lastRefreshAt = 0;
  let closed = 0;
  WebRTC.pc = { close() { closed += 1; } };
  WebRTC.refresh({ reason: 'media-request-failed' });
  assert.equal(closed, 0);
  assert.equal(WebRTC._refreshing, true);
});
```

实现：把 wait timer 存到 `this._refreshDcWaitTimer`；`markRefreshSettled`/`refresh` 开头 clear；`canBeginRefresh` 增加 `if (this._refreshing && !this.isForcedRefreshReason(reason)) return false`。

---

### Task 5: 文档同步与验收记录

**Files:**
- Modify: 本 spec 列出的 design/plan/需求文档
- Create: `docs/superpowers/reports/2026-09-03-remote-desktop-control-continuity-acceptance.md`

- [x] **Step 1: 把已合入设计的状态从「待实施」改为「已实施；真机 NOT RUN」**（见 spec 2.9 表）
- [x] **Step 2: 需求文档 §5 正式入口改为 `https://link.stockhub.wiki`，trycloudflare 仅排障**
- [x] **Step 3: 跑全量自动化并写入 acceptance 表；几何/真机/公网标 NOT RUN**

```bash
node --test web-client/js/*.test.js web-client/css/*.test.js
cd signal-server && npm test
cd python-host && PYTHONPATH=. python3 -m pytest -q
```

- [x] **Step 4: 本 spec 状态改为已实施（自动化范围内），提交**

```bash
git commit -m "docs: sync control-continuity status and record acceptance"
```

---

### Task 6: 范围自检

- [x] **Step 1:** `git diff --cached --name-only` 只含本任务列明的 docs/spec/plan/report 文件
- [x] **Step 2:** 确认未改 SPS/jitter/TURN/tunnel 脚本
- [x] **Step 3:** 确认没有把 `NOT RUN` 改成 PASS

Physical/public acceptance (remain unchecked):

- [ ] **Real Android/iOS/iPad browser, narrow-screen geometry, macOS Quartz input, and formal public-path acceptance — NOT RUN**

---

## Spec coverage

| Spec 节 | Task |
|---|---|
| 2.1 触控/虚拟键 | Task 1 |
| 2.2 可靠写入 | Task 2 + 3 |
| 2.3 reset/ACK | Task 2 |
| 2.4 断连/loading | Task 4 |
| 2.5 暂停/session | Task 4 |
| 2.6 刷新基线 / 冷启动 SPS | Task 4b |
| 2.7 刷新互斥 / DC wait timer | Task 4b |
| 2.8 v2 修饰键 / DC close | Task 3b |
| 2.9 文档 | Task 5 |
| 4 测试清单 | 各 Task Step 1 |
| 5 运行约束 | Global + Task 6 |
