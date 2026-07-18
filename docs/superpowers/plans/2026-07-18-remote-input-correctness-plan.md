# Remote Input Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Do not delegate because this session does not authorize subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mouse coordinates, click counts, drag release, and transport outcomes correct across direct WebRTC and manual tunnel modes.

**Architecture:** Keep `Input` as the browser-side lifecycle owner, extract object-fit geometry into a pure module, and extend the existing Host input action contract with idempotent `mouse/reset` plus click-state metadata. All release paths converge on one method and existing event names remain compatible except the redundant `mouse/dblclick` producer is removed.

**Tech Stack:** Browser JavaScript, Node.js test runner, Python 3.11, pytest, Quartz input events.

**Spec Coverage:** Batch B of `docs/superpowers/specs/2026-07-18-remote-desktop-reliability-latency-remediation-design.md`.

**Truth Source:** `web-client/js/input-geometry.js` for coordinate math; `Input.releasePointer()` for Viewer pointer state; `InputHandler._pressed_mouse_button` for Host pressed-button state.

**Compatibility Notes:** Existing `mouse/down`, `mouse/up`, `mouse/move`, and `mouse/wheel` events stay valid. Host may keep accepting legacy `mouse/dblclick` temporarily, but the Viewer no longer emits it.

**Impact Map:**
- **Truth Source:** Pure geometry mapping and one pointer release path.
- **Backend:** Host accepts `mouse/reset` and applies `clickCount` to Quartz down/up events.
- **Frontend:** Pointer Events replace element-local mouse down/up; transport failures return `null`.
- **Runtime Proof:** Double-click produces exactly two down/up pairs; drag-out release clears Host state; contain/cover/fill grid hits expected source points.
- **Docs/Skills:** Remote desktop requirement document records the action contract and display-mode mapping.
- **Commit Boundary:** Viewer input modules/tests, Host input handler/tests, and matching requirement text only.

**Definition of Done:**
- A DOM double-click sequence produces four messages total, with the second pair carrying `clickCount=2`.
- Pointer cancel, blur, hidden document, deactivation, and WebRTC disconnect all issue one idempotent reset when needed.
- Nine-point geometry tests pass for contain, cover, and fill, including contain letterbox rejection.
- No transport returns `null` and creates no latency-pending record.

---

### Task 1: Establish object-fit geometry as a pure contract

**Files:**
- Create: `web-client/js/input-geometry.js`
- Create: `web-client/js/input-geometry.test.js`
- Modify: `web-client/viewer.html`

- [x] **Step 1: Write failing table tests**

Test `fill` direct scaling, `contain` letterbox rejection and center/corners, and `cover` source cropping. The expected API is:

```javascript
const result = InputGeometry.mapClientPoint({
  clientX: 500,
  clientY: 250,
  rect: { left: 0, top: 0, width: 1000, height: 500 },
  sourceWidth: 1000,
  sourceHeight: 1000,
  objectFit: 'cover',
});
assert.deepEqual(result, { relX: 0.5, relY: 0.5, inside: true });
```

- [x] **Step 2: Verify RED**

Run: `node --test web-client/js/input-geometry.test.js`

Expected: FAIL because `input-geometry.js` does not exist.

- [x] **Step 3: Implement the three formulas**

Normalize unknown values to `contain`, reject invalid dimensions, clamp returned normalized coordinates, and compute `inside=false` only when the displayed point is outside actual contain content.

```javascript
function mapClientPoint({ clientX, clientY, rect, sourceWidth, sourceHeight, objectFit = 'contain' }) {
  // fill: display rect maps directly; contain/cover use min/max scale.
  // Return normalized source coordinates so Host monitor dimensions stay authoritative.
}
```

Export through both `window.InputGeometry` and CommonJS, and load it before `input.js` in `viewer.html`.

- [x] **Step 4: Verify GREEN**

Run: `node --test web-client/js/input-geometry.test.js`

Expected: all geometry cases pass.

### Task 2: Converge browser pointer lifecycle and double-click semantics

**Files:**
- Modify: `web-client/js/input.js`
- Modify: `web-client/js/input.test.js`
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/js/webrtc.test.js`

- [x] **Step 1: Add failing behavior tests**

Use event-capable fake elements to assert:

```javascript
pointerdown({ pointerId: 7, button: 0, detail: 1 });
pointerup({ pointerId: 7, button: 0, detail: 1 });
pointerdown({ pointerId: 7, button: 0, detail: 2 });
pointerup({ pointerId: 7, button: 0, detail: 2 });
assert.deepEqual(actions, ['down:1', 'up:1', 'down:2', 'up:2']);
assert.equal(actions.includes('dblclick'), false);
```

Also assert `setPointerCapture(7)`, release on `pointercancel`, and one `mouse/reset` on blur/disconnect while a button is active.

- [x] **Step 2: Verify RED**

Run: `node --test web-client/js/input.test.js web-client/js/webrtc.test.js`

Expected: FAIL because current code uses mousedown/up, emits `dblclick`, and has no pointer reset.

- [x] **Step 3: Implement one pointer state machine**

Add `_activePointer`, `_pressedMouseButtons`, and `_pendingMouseReset`. `bindMouseEvents()` uses `pointerdown`, `pointermove`, `pointerup`, and `pointercancel`; down calls `setPointerCapture()`. `releasePointer(reason)` sends one `mouse/reset`, clears local state, and keeps `_pendingMouseReset=true` if no transport accepted the reset. Before the next new pointer action, flush a pending reset first.

Pause, blur, hidden document, `setActive(false)`, and `WebRTC.disconnect()` call the same release method. Remove all Viewer `dblclick` send listeners. Down/up payloads include `clickCount: Math.max(1, Number(event.detail) || 1)`.

- [x] **Step 4: Route all coordinates through geometry**

`getRelativeCoords(event, element)` obtains source dimensions from the active video/image and `getComputedStyle(element).objectFit`, calls `InputGeometry.mapClientPoint()`, and returns `null` when `inside=false`. Pointer handlers do not send when coordinates are outside contain content.

- [x] **Step 5: Verify GREEN**

Run: `node --test web-client/js/input-geometry.test.js web-client/js/input.test.js web-client/js/webrtc.test.js`

Expected: pointer lifecycle, double-click, geometry integration, and reconnect tests pass.

### Task 3: Make transport results honest

**Files:**
- Modify: `web-client/js/input.js`
- Modify: `web-client/js/input.test.js`

- [x] **Step 1: Add failing no-transport tests**

Assert `sendInput()` returns `null`, never calls `LatencyMonitor.recordInputSend`, and records an `input-not-sent` diagnostic when both DataChannel and Socket.IO are unavailable. Assert accepted DataChannel and Socket.IO sends still return IDs.

- [x] **Step 2: Verify RED**

Run: `node --test web-client/js/input.test.js`

Expected: FAIL because current code returns an ID after both transports reject the input.

- [x] **Step 3: Move latency registration after acceptance**

Generate the ID before serialization, but call `recordInputSend(inputId)` and return the ID only after `WebRTC.sendInput(data) === true` or connected Socket.IO emit. Return `null` after recovery scheduling when neither accepts the payload.

- [x] **Step 4: Verify GREEN**

Run: `node --test web-client/js/input.test.js`

Expected: transport truth tests pass.

### Task 4: Extend Host input action contract

**Files:**
- Modify: `python-host/input_handler.py`
- Modify: `python-host/test_input_handler.py`

- [x] **Step 1: Add failing Host tests**

Assert `mouse/reset` posts one mouse-up for the tracked button and is idempotent. Patch Quartz and assert down/up calls apply `kCGMouseEventClickState=2` for `clickCount=2`. Assert a normal down/up pair still works.

- [x] **Step 2: Verify RED**

Run: `python3 -m pytest python-host/test_input_handler.py -q`

Expected: FAIL because reset and click-state metadata are absent.

- [x] **Step 3: Implement reset and click state**

Validate `clickCount` to integer range 1..3. After `CGEventCreateMouseEvent`, call `CGEventSetIntegerValueField(event, kCGMouseEventClickState, click_count)` for down/up. Add a reset branch that posts an up event for `_pressed_mouse_button`, clears it in `finally`, and succeeds when already clear.

- [x] **Step 4: Verify GREEN and Batch B regression**

Run: `python3 -m pytest python-host/test_input_handler.py -q && node --test web-client/js/input-geometry.test.js web-client/js/input.test.js web-client/js/webrtc.test.js`

Expected: all focused tests pass.

### Task 5: Synchronize the input contract documentation

**Files:**
- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md`

- [x] **Step 1: Document pointer reset, clickCount, and object-fit mapping**

State that `dblclick` is not a separate wire action, that release/reset is idempotent, and that contain/cover/fill coordinates are based on the visible media geometry.

- [x] **Step 2: Run scope checks**

Run: `git diff --check && rg -n 'mouse/reset|clickCount|contain|cover|fill' docs/需求文档/WebRemoteDesktop-需求文档.md`

Expected: updated contract is discoverable and there are no whitespace errors.
