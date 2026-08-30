# 移动端远程桌面操控实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在手机和平板普通浏览器中增加可靠的远程点击、拖动、滚动、右键、软键盘文本输入和虚拟控制键，同时复用现有 lease、transport、Host 输入协议。

**Architecture:** 新增 `TouchInputAdapter` 和 `MobileTextInputAdapter` 两个 Viewer 内部 seam。`Input` 负责装配，`InputGeometry`、`RemoteKeyboardController`、`KeyboardTransport`、`DesktopControlLease` 和 Host Quartz 继续保持唯一真相；移动 UI 只消费既有 capability snapshot。

**Tech Stack:** Vanilla JavaScript、HTML/CSS、Node built-in test runner、Python Host 既有 pytest、Playwright/真实 Android Chrome、iOS Safari 和 iPad Safari。

**Spec:** `docs/superpowers/specs/2026-08-30-mobile-remote-control-design.md`

Touch and IME are separate browser adapters, but they are intentionally kept in
one delivery plan: either adapter without the shared `Input`/capability/reset
integration leaves the mobile control workflow incomplete and cannot be
accepted independently.

## Global Constraints

- 不引入 npm 依赖、原生移动端项目、第二套信令协议或第二个 DesktopControlLease。
- 触控坐标唯一使用 `InputGeometry.mapClientPoint()`；不在 adapter 内复制 contain/cover/fill 公式。
- 点击、释放、滚轮、键盘、文本和 reset 不得静默丢失；高频 move 可 rAF 合并并在 buffer 超限时丢弃中间点。
- 物理键使用 `KeyboardEvent.code`；软键盘提交使用 Unicode text；禁止用 `keyCode` 猜测 Quartz code。
- 长按阈值固定为 550ms，移动阈值固定为 8 CSS px；短 tap、双指滚动和显式右键语义按 spec 实现。
- 所有输入必须经过 ACTIVE lease、既有 v2 envelope、ACK、序列和 reset barrier。
- 不记录原始文本、按键、剪贴板或坐标；日志只记录脱敏摘要。
- 不启动、重启或重建 signal-server、Host 或 Cloudflare tunnel；真实运行验收由操作者在现有服务上执行。
- 当前工作树中已有的 `web-client/js/webrtc.js`、`web-client/viewer.html`、`desktop-session-*` 和 `signal-server/scripts/web-asset-graph.js` 改动属于外部工作；实现时必须基于其当前内容合并，只追加移动接线，不回滚或覆盖。
- 任务提交前必须用 `git diff --cached --name-only` 和 `git diff --cached --check` 核对范围；对已有 dirty 文件使用 `git add -p` 仅暂存移动改动，禁止把外部 hunks 一并提交。若无法可靠分离，先停在该任务的本地测试结果，不创建提交。

## 文件责任表

| 文件 | 责任 |
|---|---|
| `web-client/js/touch-input-adapter.js` | Pointer/touch 状态机和 mouse action 适配 |
| `web-client/js/touch-input-adapter.test.js` | 触控状态机的纯自动化测试 |
| `web-client/js/mobile-text-input.js` | textarea、IME、input diff 和移动键盘生命周期 |
| `web-client/js/mobile-text-input.test.js` | 文本/IME/browser fallback 测试 |
| `web-client/js/input.js` | 装配 adapter、统一 reset、mouse reset ACK 屏障和现有桌面输入兼容 |
| `web-client/js/input.test.js` | 桌面输入回归与 adapter 装配测试 |
| `web-client/viewer.html` | 移动 textarea、虚拟键盘按钮、语义属性 |
| `web-client/css/viewer.css` | touch-action、键盘 inset、移动 Dock 和控件样式 |
| `web-client/js/chrome-layout.js` | 移动 capability 和 keyboard viewport 变量 |
| `web-client/js/webrtc.js` | 仅接入既有 capability/reset 回调，不新增协议 |
| `web-client/js/webrtc.test.js` | lease、transport、ACK 和移动生命周期回归 |
| `web-client/css/viewer-layout.test.js` | CSS/布局契约测试 |
| `signal-server`、`python-host` | 只有协议冲突或真实验收发现 bug 时才修改；默认不改 |
| `docs/需求文档/WebRemoteDesktop-需求文档.md` | 功能状态、触控和软键盘约束同步 |
| `docs/superpowers/reports/2026-08-30-mobile-remote-control-acceptance.md` | 自动化、真实设备和未执行项的证据记录 |

## Task 1: Freeze contracts and test fixtures

**Files:**
- Create: `web-client/js/touch-input-adapter.test.js`
- Create: `web-client/js/mobile-text-input.test.js`
- Modify: `web-client/js/input.test.js`
- Modify: `web-client/css/viewer-layout.test.js`

**Interfaces:**
- Consumes: spec thresholds, `InputGeometry.mapClientPoint`, existing `Input.sendInput`, `RemoteKeyboardController.sendText/sendChord`.
- Produces: named tests that later tasks must satisfy without changing the v2 envelope. No shared protocol fixture is added because the envelope is unchanged.

- [ ] **Step 1: Write failing touch state tests**

Add `makeTouchHarness()` before the tests. It must provide a fake element with
`addEventListener`, `dispatch`, `setPointerCapture`, `releasePointerCapture` and
`hasPointerCapture`; inject `setTimer`/`clearTimer` so `advance(550)` executes
the long-press callback without sleeping; map a 160x120 fixture to
`relX=clientX/160`, `relY=clientY/120`; and return `pointer()`, `tap()`,
`advance()`, and `flushAnimationFrame()` helpers plus the captured `mouse` list.
`tap(pointerId, atMs)` advances the fake clock to the absolute timestamp
`atMs` before dispatching its down/up pair, so the double-click test is
deterministic.
The helper dispatches `{pointerType:'touch', preventDefault(){}, currentTarget:element}`
and preserves every override passed by a test.

```javascript
function makeTouchHarness() {
  const listeners = new Map(); const mouse = []; let now = 0; let timer = null; let frame = null; let lastTap = -Infinity;
  const element = {
    addEventListener(type, fn) { listeners.set(type, fn); },
    dispatch(type, event = {}) { listeners.get(type)?.({...event, type, currentTarget: element}); },
    setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture() { return false; },
  };
  const adapter = TouchInputAdapter.create({
    element, mapPoint: (event) => ({relX: event.clientX / 160, relY: event.clientY / 120}),
    sendMouse: (action, payload) => { mouse.push({action, payload}); return `mouse-${mouse.length}`; },
    isEnabled: () => true, getClickCount: () => { const count = now - lastTap <= 500 ? 2 : 1; lastTap = now; return count; }, clock: () => now,
    setTimer: (fn, ms) => (timer = {fn, at: now + ms}), clearTimer: (id) => { if (timer === id) timer = null; },
  });
  global.requestAnimationFrame = (fn) => { frame = fn; return 1; };
  adapter.bind();
  const pointer = (type, overrides = {}) => element.dispatch(type,
    {pointerType: 'touch', isPrimary: true, preventDefault() {}, ...overrides});
  const advance = (ms) => { now += ms; if (timer && timer.at <= now) { const due = timer; timer = null; due.fn(); } };
  return {
    element, mouse, pointer,
    tap: (pointerId, atMs) => { advance(atMs - now); pointer('pointerdown', {pointerId, clientX: 40, clientY: 30, buttons: 1}); pointer('pointerup', {pointerId, clientX: 40, clientY: 30, buttons: 0}); },
    advance,
    flushAnimationFrame: () => { const due = frame; frame = null; due?.(); },
  };
}
```

```javascript
test('short touch emits one left click using mapped coordinates', () => {
  const h = makeTouchHarness();
  h.pointer('pointerdown', {pointerId: 1, clientX: 40, clientY: 30, buttons: 1});
  h.pointer('pointerup', {pointerId: 1, clientX: 40, clientY: 30, buttons: 0});
  assert.deepEqual(h.mouse.map(({action, payload}) => [action, payload.button, payload.clickCount]),
    [['down', 'left', 1], ['up', 'left', 1]]);
  assert.deepEqual({relX: h.mouse[0].payload.relX, relY: h.mouse[0].payload.relY},
    {relX: 0.25, relY: 0.25});
});

test('second tap within 500ms emits clickCount 2 without a third click', () => {
  const h = makeTouchHarness();
  h.tap(1, 10); h.tap(1, 200);
  assert.deepEqual(h.mouse.filter((event) => event.action === 'down').map((event) => event.payload.clickCount), [1, 2]);
  assert.equal(h.mouse.length, 4);
});

test('movement beyond 8 CSS px starts one drag and releases it', () => {
  const h = makeTouchHarness();
  h.pointer('pointerdown', {pointerId: 1, clientX: 10, clientY: 10, buttons: 1});
  h.pointer('pointermove', {pointerId: 1, clientX: 19, clientY: 10, buttons: 1});
  h.pointer('pointerup', {pointerId: 1, clientX: 30, clientY: 10, buttons: 0});
  assert.deepEqual(h.mouse.map(({action}) => action), ['down', 'move', 'up']);
});

test('550ms stationary touch emits right down/up', () => {
  const h = makeTouchHarness();
  h.pointer('pointerdown', {pointerId: 1, clientX: 10, clientY: 10, buttons: 1});
  h.advance(550);
  h.pointer('pointerup', {pointerId: 1, clientX: 10, clientY: 10, buttons: 0});
  assert.deepEqual(h.mouse.map(({action, payload}) => [action, payload.button]), [['down', 'right'], ['up', 'right']]);
});

test('second pointer resets a pending drag and emits coalesced wheel', () => {
  const h = makeTouchHarness();
  h.pointer('pointerdown', {pointerId: 1, clientX: 10, clientY: 10, buttons: 1});
  h.pointer('pointermove', {pointerId: 1, clientX: 20, clientY: 10, buttons: 1});
  h.pointer('pointerdown', {pointerId: 2, clientX: 30, clientY: 30, buttons: 1});
  h.pointer('pointermove', {pointerId: 2, clientX: 30, clientY: 42, buttons: 1});
  h.flushAnimationFrame();
  assert.equal(h.mouse.filter(({action}) => action === 'reset').length, 1);
  assert.equal(h.mouse.filter(({action}) => action === 'wheel').length, 1);
});

test('pointercancel and lostpointercapture emit one idempotent reset', () => {
  const h = makeTouchHarness();
  h.pointer('pointerdown', {pointerId: 1, clientX: 10, clientY: 10, buttons: 1});
  h.pointer('pointermove', {pointerId: 1, clientX: 20, clientY: 10, buttons: 1});
  h.pointer('pointercancel', {pointerId: 1});
  h.element.dispatch('lostpointercapture', {pointerId: 1});
  assert.equal(h.mouse.filter(({action}) => action === 'reset').length, 1);
});
```

- [ ] **Step 2: Run the new touch tests to verify they fail**

Run: `node --test web-client/js/touch-input-adapter.test.js`

Expected: FAIL because `touch-input-adapter.js` does not yet exist.

- [ ] **Step 3: Write failing mobile text tests**

Add `makeTextHarness({enabled=true}={})` before the tests. It must create a
fake textarea whose `addEventListener` handlers are invoked by `emit(type)`;
inject `sendText`, `sendKey` and `isEnabled: () => enabled`; and return the
textarea as `input` plus a `sent` list containing `{kind:'text'|'key', value}`.
The fake event must set `target` to the textarea and expose `inputType` for
`beforeinput` cases, so the tests exercise the same target and gate checks as
the browser adapter.

```javascript
test('plain input diff sends inserted Unicode as one text action', () => {
  const h = makeTextHarness(); h.input.value = 'hello'; h.emit('input');
  assert.deepEqual(h.sent, [{kind: 'text', value: 'hello'}]);
});

test('compositionend sends committed CJK text once despite the following input', () => {
  const h = makeTextHarness(); h.emit('compositionstart'); h.input.value = '中文';
  h.emit('compositionend'); h.emit('input');
  assert.deepEqual(h.sent, [{kind: 'text', value: '中文'}]);
});

test('deleteContentBackward sends bounded Backspace actions', () => {
  const h = makeTextHarness(); h.input.value = 'abcdefghijklmnopq'; h.emit('input'); h.sent.length = 0;
  h.input.value = 'a'; h.emit('beforeinput', {inputType: 'deleteContentBackward'}); h.emit('input');
  assert.equal(h.sent.filter((item) => item.value === 'Backspace').length, 16);
});

test('surrogate-pair Emoji is not split into invalid text', () => {
  const h = makeTextHarness(); h.input.value = '🙂'; h.emit('input');
  assert.deepEqual(h.sent, [{kind: 'text', value: '🙂'}]);
});

test('beforeinput absence still works through input diff', () => {
  const h = makeTextHarness(); h.input.value = 'fallback'; h.emit('input');
  assert.deepEqual(h.sent, [{kind: 'text', value: 'fallback'}]);
});

test('blocked lease preserves value and does not send text', () => {
  const h = makeTextHarness({enabled: false}); h.input.value = 'keep me'; h.emit('input');
  assert.deepEqual(h.sent, []); assert.equal(h.input.value, 'keep me');
});
```

- [ ] **Step 4: Add static layout assertions**

Run `node --test web-client/css/viewer-layout.test.js` with a fixture that reads
`viewer.html` and `viewer.css`; assert the literal `#mobileTextInput`,
`inputmode="text"`, `touch-action: none`, `env(safe-area-inset-bottom`,
`keyboard-inset-height`, and `min-height: var(--touch-min)` declarations are
present. The test must fail before the DOM/CSS changes are made.

- [ ] **Step 5: Run the focused failing tests**

Run: `node --test web-client/js/touch-input-adapter.test.js web-client/js/mobile-text-input.test.js web-client/css/viewer-layout.test.js`

Expected: the new behavior tests fail while existing layout tests remain unchanged.

## Task 2: Implement the touch input adapter

**Files:**
- Create: `web-client/js/touch-input-adapter.js`
- Modify: `web-client/js/input.js:108-143,337-398`
- Modify: `web-client/viewer.html` script list
- Test: `web-client/js/touch-input-adapter.test.js`

**Interfaces:**
- Consumes: `{element, mapPoint, sendMouse, isEnabled, getClickCount, clock, setTimer, clearTimer}`.
- Produces: `create(options) -> { bind, unbind, reset(reason), clickButton(button, coords?), getSnapshot }`; calls `sendMouse('down'|'up'|'move'|'wheel'|'reset', payload)` only and calls `getClickCount({button: 0, timeStamp, clientX, clientY})` only for a committed tap. `isEnabled()` must include the existing ACTIVE gate and `!Input._pendingMouseReset`.

- [ ] **Step 1: Implement the adapter factory and internal state**

Track `IDLE`, `PRESSED`, `DRAGGING`, `SCROLLING`, `RESETTING`; a `Map` of active touch pointers; one primary pointer; `pressTimer`; last coordinates; and `resetSent`. Read timers from injected `setTimer`/`clearTimer` options (defaulting to `setTimeout`/`clearTimeout`) so the state machine is deterministic in tests.

- [ ] **Step 2: Implement short tap and double tap**

On touch `pointerup` without drag or long press, call `getClickCount({button: 0, timeStamp, clientX, clientY})`, then send left `down` and `up` with the same mapped coordinates and click count. This normalization is required because touch `pointerup.button` is commonly `-1`; the adapter must not create a second double-click policy.

- [ ] **Step 3: Implement drag and long-press right click**

Use 8 CSS px as the movement threshold and 550ms as the long-press timer. Long press sends right `down`; drag sends left/right move based on the active button; all release paths send the matching `up`.

- [ ] **Step 4: Implement two-finger scrolling**

When a second touch arrives, clear the timer, send one reset if a remote button was sent, compute the centroid, and emit at most one wheel event per animation frame. End all touch pointers by returning to `IDLE`.

- [ ] **Step 5: Implement cancel, capture loss and lifecycle reset**

`pointercancel`, `lostpointercapture`, `blur`, `visibility-hidden`, `control-revoked` and `disconnect` call the same idempotent `reset(reason)`. Reset clears timers, pointer map, local button state and pending move. If a `down` or `up` send returns `null`, immediately attempt one `mouse/reset`; while that reset is unacknowledged, `Input._pendingMouseReset` blocks new touch writes.

- [ ] **Step 6: Integrate without changing desktop semantics**

Instantiate exactly one adapter per media element in `Input.init()`. Keep existing mouse listeners for non-touch pointers; route touch events to the adapter and retain `Input.sendInput` as the only envelope sender. Add `Input.acceptMouseAck(ack)` that clears `_pendingMouseReset` only for an `applied`/`duplicate` ACK containing the tracked reset input id; leave it blocked for stale or failed ACKs.

- [ ] **Step 7: Run focused tests**

Run: `node --test web-client/js/touch-input-adapter.test.js web-client/js/input.test.js`

Expected: all new touch tests and all existing input tests pass.

- [ ] **Step 8: Commit the self-contained touch slice**

```bash
git add web-client/js/touch-input-adapter.js web-client/js/touch-input-adapter.test.js web-client/js/input.js web-client/js/input.test.js web-client/viewer.html
git commit -m "feat(viewer): add touch pointer input adapter"
```

## Task 3: Implement mobile text and IME input

**Files:**
- Create: `web-client/js/mobile-text-input.js`
- Modify: `web-client/viewer.html` near `textInputModal`
- Modify: `web-client/js/input.js:29-39,444-479`
- Test: `web-client/js/mobile-text-input.test.js`, `web-client/js/input.test.js`

**Interfaces:**
- Consumes: `{element, sendText, sendKey, isEnabled}`.
- Produces: `attach`, `detach`, `show`, `hide`, `reset(reason)`, `getSnapshot`; only invokes `sendText(string)` or `sendKey('Backspace'|'Enter'|'Escape'|'Arrow...')`.

- [ ] **Step 1: Add the dedicated textarea and mobile input toggle**

Add `#mobileTextInput` with `inputmode`, autocomplete, autocapitalize, spellcheck, enterkeyhint and `aria-label`. Add a `移动键盘` toggle beside existing text input controls, hidden when touch is unsupported and disabled without active control.

- [ ] **Step 2: Implement sentinel baseline and safe diff**

Keep `lastValue`, `observedValue`, and `compositionBaseValue`; calculate common prefix/suffix on each non-composition `input`; submit inserted Unicode by code point and deletion as Backspace count. During composition only update `observedValue`; at `compositionend` flush once against `lastValue` and update `lastValue` before the browser's duplicate post-composition `input` can flush again. Never split a UTF-16 surrogate pair.

- [ ] **Step 3: Implement composition lifecycle**

Set `composing` and `compositionBaseValue` on `compositionstart`; update only `observedValue` on `compositionupdate` and composition-time `input`; on `compositionend` call the idempotent `flushDiff()` once and update `lastValue`; run the same `flushDiff()` fallback on ordinary `input` when a browser omits `beforeinput`.

- [ ] **Step 4: Route control keys and enforce gates**

Handle Enter, Backspace and arrows only when the event target is the dedicated textarea and no composition is active. Refuse new text while lease, transport or keyboard state is blocked; retain value for retry.

- [ ] **Step 5: Add Virtual Keyboard/Visual Viewport progressive enhancement**

Feature-detect `navigator.virtualKeyboard`; when available, set `overlaysContent` and listen for `geometrychange`. Always provide `visualViewport` and `resize` fallback, writing only `--mobile-keyboard-bottom`.

- [ ] **Step 6: Wire reset and lifecycle ownership**

`Input.resetKeyboard`, `Input.parkKeyboard`, `WebRTC.freezeControl`, visibility changes and disconnect must call adapter reset. Reset hides the keyboard, clears composition and does not send raw value to diagnostics.

- [ ] **Step 7: Run focused tests**

Run: `node --test web-client/js/mobile-text-input.test.js web-client/js/input.test.js web-client/js/remote-keyboard-controller.test.js web-client/js/keyboard-transport.test.js`

Expected: new IME tests and existing keyboard/transport tests pass.

- [ ] **Step 8: Commit the text slice**

```bash
git add web-client/js/mobile-text-input.js web-client/js/mobile-text-input.test.js web-client/js/input.js web-client/viewer.html
git commit -m "feat(viewer): support mobile IME text input"
```

## Task 4: Add the mobile virtual key surface

**Files:**
- Modify: `web-client/viewer.html` action/control docks
- Modify: `web-client/js/input.js:430-442`
- Modify: `web-client/js/ui.js` capability rendering
- Modify: `web-client/js/remote-keyboard-controller.js` virtual modifier API
- Modify: `web-client/css/viewer.css`
- Test: `web-client/js/input.test.js`, `web-client/js/remote-keyboard-controller.test.js`, `web-client/css/viewer-layout.test.js`

**Interfaces:**
- Consumes: `RemoteKeyboardController.sendChord`, `RemoteKeyboardController.setVirtualModifier`, `Input.sendInput('mouse', ...)`, existing capability snapshot.
- Produces: buttons with `data-mobile-action`, `aria-pressed`, `aria-label`, and no direct transport access.

- [ ] **Step 1: Add navigation, modifier, shortcut and right-click buttons**

Use existing action definitions for Enter, arrows and shortcuts. Add Esc, Tab, Backspace, Shift, Control, Alt, Command and right-click. Every shortcut calls one `sendChord`; right-click calls `TouchInputAdapter.clickButton('right')`, using the adapter's last mapped point. Add a test that clicks a modifier twice and asserts one `keyboard/key` down, one `keyboard/key` up, and no direct `WebRTC.sendInput` call from the button handler.

- [ ] **Step 2: Implement modifier latch rendering**

Add `RemoteKeyboardController.setVirtualModifier(name, pressed)`; it emits one real modifier `down` when `pressed=true`, one real `up` when `pressed=false`, keeps the code in the controller's pressed map while latched, and uses the existing reset barrier. The button only toggles `aria-pressed` after the controller accepts the transition. Clear it after text commit, reset, hidden, lease revoke or disconnect.

- [ ] **Step 3: Apply capability gates**

Use `canSendDesktopInput`, `activeControl`, `streamReady` and `controlTransition` from the existing chrome capability seam. Do not add a second lease or `isActive` flag.

- [ ] **Step 4: Add mobile layout CSS**

Keep each target at least `var(--touch-min)` (44px), allow horizontal scrolling for the compact key row, keep the right-click button discoverable, and reserve `safe-area`/keyboard inset space. Use `touch-action: manipulation` on buttons and `none` on the remote surface.

- [ ] **Step 5: Run focused tests**

Run: `node --test web-client/js/input.test.js web-client/css/viewer-layout.test.js web-client/js/chrome-layout.test.js`

Expected: all action, accessibility and layout assertions pass.

- [ ] **Step 6: Commit the virtual controls slice**

```bash
git add web-client/viewer.html web-client/js/input.js web-client/js/ui.js web-client/js/remote-keyboard-controller.js web-client/css/viewer.css web-client/js/input.test.js web-client/js/remote-keyboard-controller.test.js web-client/css/viewer-layout.test.js
git commit -m "feat(viewer): add mobile virtual controls"
```

## Task 5: Integrate viewport, full-screen and capability behavior

**Files:**
- Modify: `web-client/js/chrome-layout.js`
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/css/viewer.css`
- Test: `web-client/js/chrome-layout.test.js`, `web-client/js/webrtc.test.js`, `web-client/css/viewer-layout.test.js`

**Interfaces:**
- Consumes: existing WebRTC media/control state and `ResizeObserver` chrome layout seam.
- Produces: one read-only mobile capability snapshot and `--mobile-keyboard-bottom` CSS variable.

- [ ] **Step 1: Add device and keyboard viewport snapshot tests**

Assert touch detection, Virtual Keyboard unsupported fallback, visualViewport height calculation, keyboard inset clamping to `0..viewportHeight`, and reset on hide.

- [ ] **Step 2: Implement feature-detected viewport observer**

Register `navigator.virtualKeyboard.geometrychange` only when
`navigator.virtualKeyboard` exists; register `visualViewport.resize` and
`visualViewport.scroll` only when `window.visualViewport` exists; always
register `window.resize`. Store each `(target, type, handler)` tuple and remove
the exact tuples in layout teardown, so unsupported APIs never become hard
dependencies.

- [ ] **Step 3: Keep the media box and Dock non-overlapping**

Use existing `--chrome-top`, `100dvh`/`100vh`, safe-area and Dock wrapper. On
narrow viewports keep the action row single-line with `overflow-x:auto` and
stable 44px item widths; the control row may wrap, but the remote surface
retains a stable geometry box for `InputGeometry`.

- [ ] **Step 4: Preserve full-screen controls**

Keep the exit-fullscreen control inside `.viewer-container`; do not rely on iOS native video fullscreen for the interactive path. On `fullscreenchange`, recalculate chrome and input geometry.

- [ ] **Step 5: Run focused and build tests**

Run: `node --test web-client/js/chrome-layout.test.js web-client/js/webrtc.test.js web-client/css/viewer-layout.test.js`

Then run: `cd signal-server && npm run build:web && node --test test/web-asset-build.test.js`

Expected: existing asset graph and WebRTC tests pass with both new scripts included once.

- [ ] **Step 6: Commit the viewport slice**

```bash
git add web-client/js/chrome-layout.js web-client/js/chrome-layout.test.js web-client/js/webrtc.js web-client/js/webrtc.test.js web-client/css/viewer.css web-client/css/viewer-layout.test.js
git commit -m "feat(viewer): adapt mobile keyboard viewport"
```

## Task 6: Cross-layer regression and browser acceptance harness

**Files:**
- Modify: `web-client/js/webrtc.test.js`, `web-client/js/input.test.js`
- Create: `scripts/mobile_viewer_acceptance.py`
- Create: `docs/superpowers/reports/2026-08-30-mobile-remote-control-acceptance.md`
- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md`

**Interfaces:**
- Consumes: final Viewer build, existing local origin, current password/config injection, existing diagnostic snapshots.
- Produces: immutable JSON acceptance artifact with SHA-256, screenshots, and explicit unexecuted-device entries.

- [ ] **Step 1: Add cross-layer transport tests**

Assert touch click/scroll and mobile text both use the same v2 lease fields; DataChannel close causes Socket.IO reset barrier; `WebRTC` forwards each ACK to `Input.acceptMouseAck()` and the keyboard transport without duplicating effects; keyboard ACK status updates the existing controller while mouse ACK RTT is recorded only by `LatencyMonitor`; no raw input appears in diagnostics and mouse move never enters keyboard pending.

- [ ] **Step 2: Add browser acceptance scenarios**

Implement `scripts/mobile_viewer_acceptance.py --base-url URL --password-env VIEWER_ACCESS_PASSWORD --out artifacts/mobile-viewer-acceptance.json`; each scenario runs in a fresh Playwright context and writes only action names, transport, ACK status/RTT, pressed counts and bounding boxes. Write the JSON atomically and create `artifacts/mobile-viewer-acceptance.json.sha256` with `hashlib.sha256` after the final rename. The scenario list is: active control click, double click, long press right-click, drag with pointercancel, two-finger wheel, text input, CJK composition, Emoji, modifier latch, visibility hide, transport fallback, control revoke and reconnect.

- [ ] **Step 3: Capture geometry and state evidence**

For `375x812`, `768x1024`, `1024x1366`, and `1440x900`, record status bar, viewer surface, Dock, mobile keyboard and fullscreen bounding boxes; assert no overlap and `pressedKeyCount == 0`/mouse reset after teardown.

- [ ] **Step 4: Execute device matrix where hardware exists**

Use Android Chrome, iPhone Safari and iPad Safari. If a device/browser is unavailable, write `NOT RUN` with the reason; do not infer it from desktop emulation.

- [ ] **Step 5: Run complete automated suites**

```bash
node --test web-client/js/*.test.js web-client/css/*.test.js
cd signal-server && npm test
cd ../python-host && PYTHONPATH=. python3 -m pytest -q
```

Expected: no new failures. Existing baseline warnings remain separately listed.

- [ ] **Step 6: Update requirements and acceptance report**

Mark only automated and real-device cases with evidence. Keep tunnel/public path and physical keyboard cases separate from local unit-test results.

- [ ] **Step 7: Run final diff checks**

Run: `git diff --check` and `git status --short`; verify unrelated pre-existing worktree changes remain untouched.

- [ ] **Step 8: Commit docs and acceptance harness**

```bash
git add scripts/mobile_viewer_acceptance.py docs/需求文档/WebRemoteDesktop-需求文档.md docs/superpowers/reports/2026-08-30-mobile-remote-control-acceptance.md web-client/js/input.test.js web-client/js/webrtc.test.js
git commit -m "docs(viewer): specify mobile remote control acceptance"
```

## Plan Self-Review

### Spec coverage

- Touch tap/double tap/drag/right-click/scroll/reset: Tasks 1-2.
- Mobile IME, Unicode, composition, deletion and viewport: Tasks 1, 3 and 5.
- Virtual controls and modifier latch: Task 4.
- Lease, transport, ACK, reset, privacy and regression: Tasks 3-6.
- Android/iOS/iPad and responsive geometry: Tasks 5-6.
- Documentation and evidence separation: Task 6.

### Placeholder scan

No unresolved placeholder markers or unbounded edge-case steps remain. Every behavior has a named file, interface, test, command and expected result.

### Type and interface consistency

- `TouchInputAdapter.create()` produces `bind/unbind/reset/clickButton/getSnapshot` and consumes the exact callbacks used by `Input`.
- `MobileTextInput.create()` produces `attach/detach/show/hide/reset/getSnapshot` and calls only `sendText/sendKey`.
- Both adapters are assembled by `Input`; neither owns lease or transport.
- Existing `RemoteKeyboardController.sendText/sendChord/setVirtualModifier` and `Input.sendInput('mouse', action, payload)` remain the only downstream interfaces.

### Architecture and interaction review gate

Before implementation is declared complete, the reviewer must answer “yes” to all of the following:

1. Does every mobile input path pass through the existing lease and v2 ACK/reset semantics?
2. Can a touch cancel, visibility change, transport switch or control revoke leave zero Host pressed keys/buttons?
3. Does CJK/Emoji input use committed Unicode rather than guessed physical keys?
4. Are `touch-action`, pointer capture, safe-area, visualViewport and keyboard fallback implemented?
5. Are virtual controls discoverable and at least 44px without covering the remote screen?
6. Are real Android/iOS/iPad results distinguished from desktop emulation and unit tests?

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-30-mobile-remote-control-plan.md`. Execute task-by-task with `superpowers:subagent-driven-development` or in one session with `superpowers:executing-plans`; each task has its own test and commit gate.
