# Relay 输入稳定性优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 TURN relay 场景下的黑屏/卡顿、重连风暴、幽灵 Ctrl/Cmd、中文 IME 丢失和表情弹出等问题，全部症状同源于 DataChannel 在 relay 路径上反复关闭。

**Architecture:** 三处手术级改动，互不依赖可并行。B1 修 viewer 侧 jitter buffer 配置（`webrtc.js`）；A1 在 `webrtc.js` 新增 `rebuildDataChannels` 路径，relay 下 DataChannel 断开时只重建 DC 而不拆视频；C1 在 `input_handler.py` 的 `keyboard_input` 入口插入 reconcile 逻辑，每次非修饰键 keydown 时用浏览器 payload 权威状态清除幽灵修饰位。

**Tech Stack:** Browser WebRTC API（`RTCPeerConnection`、`RTCRtpReceiver.jitterBufferTarget`、`playoutDelayHint`）；Node.js `node:test`；Python 3.11 + pytest；macOS CoreGraphics CGEvent API。

## Global Constraints

- 不修改 TURN 服务器配置或凭证逻辑
- 不动视频 transceiver / ICE 配置
- 不改 `scheduleReconnect` / `refresh` 在非 relay 场景下的行为
- `input_handler.py` 的 `_ime_nav_keys` 白名单（123/124/125/126/53）不受 reconcile 影响
- JS 测试用 `node --test`（在 `signal-server/` 目录执行）；Python 测试用 `pytest`（在 `python-host/` 目录执行）
- 每个 Task 独立可测试，完成后立即 commit

---

## 文件改动清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `web-client/js/webrtc.js` | 修改 | B1: `configureVideoReceiver` L1103-L1123；A1: `noteDataChannelFault` L3973、新增 `_rebuildingDc` 状态和 `rebuildDataChannels` 方法 |
| `python-host/input_handler.py` | 修改 | C1: `keyboard_input` L708 前插 reconcile；新增 `_release_lost_modifier_flags` 方法 |
| `web-client/js/webrtc.test.js` | 修改 | A1 新增单元测试（3 个 test case） |
| `python-host/test_quartz_keyboard_adapter.py` | 修改 | C1 新增单元测试（2 个 test case） |

---

## Task 1: B1 — jitterBufferTarget relay 感知

**Files:**
- Modify: `web-client/js/webrtc.js:1103-1123`
- Test: 手动验证（浏览器 DevTools）

**Interfaces:**
- Consumes: `this.networkMode`（字符串，`'relay'|'auto'|'stun'|'lan'|'tunnel'`）；`this.lastCandidateType`（字符串，`'relay'|'srflx'|'host'|''`）
- Produces: `configureVideoReceiver(receiver)` 改动后对外接口不变，调用方无需修改

- [ ] **Step 1: 定位现有代码**

  打开 `web-client/js/webrtc.js`，找到 L1103 的 `configureVideoReceiver(receiver)` 方法。现有代码：

  ```js
  configureVideoReceiver(receiver) {
    if (!receiver?.track || receiver.track.kind !== 'video') return;
    if (typeof receiver.playoutDelayHint !== 'undefined') {
      try {
        receiver.playoutDelayHint = 0;
        console.log('[LATENCY] Set playoutDelayHint = 0s');
      } catch (error) {
        console.warn('[LATENCY] Unable to set playoutDelayHint:', error?.message || error);
      }
    }
    if (typeof receiver.jitterBufferTarget !== 'undefined') {
      try {
        receiver.jitterBufferTarget = 1;
        console.log('[LATENCY] Set jitterBufferTarget = 1');
      } catch (error) {
        console.warn('[LATENCY] Unable to set jitterBufferTarget:', error?.message || error);
      }
    }
  },
  ```

- [ ] **Step 2: 替换 configureVideoReceiver**

  将整个方法替换为以下内容（保持缩进风格与周边代码一致，使用 2 空格）：

  ```js
  configureVideoReceiver(receiver) {
    if (!receiver?.track || receiver.track.kind !== 'video') return;
    const isRelay = this.networkMode === 'relay'
      || this.lastCandidateType === 'relay';

    // playoutDelayHint: relay 下给 80ms 下限减少黑屏，直连保持 0
    if (typeof receiver.playoutDelayHint !== 'undefined') {
      try {
        receiver.playoutDelayHint = isRelay ? 0.08 : 0;
        console.log('[LATENCY] Set playoutDelayHint =', isRelay ? '0.08s (relay)' : '0s (direct)');
      } catch (error) {
        console.warn('[LATENCY] Unable to set playoutDelayHint:', error?.message || error);
      }
    }

    // jitterBufferTarget: relay 路径 80ms 吸收抖动，直连保持 1ms 低延迟
    if (typeof receiver.jitterBufferTarget !== 'undefined') {
      try {
        receiver.jitterBufferTarget = isRelay ? 80 : 1;
        console.log('[LATENCY] Set jitterBufferTarget =', isRelay ? '80ms (relay)' : '1ms (direct)');
      } catch (error) {
        console.warn('[LATENCY] Unable to set jitterBufferTarget:', error?.message || error);
      }
    }
  },
  ```

- [ ] **Step 3: 手动验证**

  1. 用户启动前端 (`npm run dev`) 和后端服务
  2. 浏览器选择"外网中继"模式连接
  3. 打开 `chrome://webrtc-internals` → 找到对应 PC → 查看 `inbound-rtp` stats
  4. 确认 `jitterBufferTargetDelay` ≈ 0.080s（80ms）
  5. 持续使用 5 分钟，观察 fps 不再周期性降至 0

- [ ] **Step 4: Commit**

  ```bash
  cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
  git add web-client/js/webrtc.js
  git commit -m "fix(webrtc): relay-aware jitterBufferTarget 80ms to eliminate periodic fps=0 blackouts"
  ```

---

## Task 2: A1 — DataChannel 故障仅重建，不 full refresh

**Files:**
- Modify: `web-client/js/webrtc.js:~L10`（对象初始化添加 `_rebuildingDc`）
- Modify: `web-client/js/webrtc.js:3973-3982`（`noteDataChannelFault`）
- Create logic: `web-client/js/webrtc.js`（新增 `rebuildDataChannels` 方法，插在 `noteDataChannelFault` 之前）
- Test: `web-client/js/webrtc.test.js`

**Interfaces:**
- Consumes: `this.pc.connectionState`（string）；`this.pc.sctp?.state`（string|undefined）；`this.networkMode`；`createInputChannel()`（已存在，L2830）；`createOffer()`（已存在，L3214，async，无参数）；`scheduleReconnect(reason)`（已存在，L3984）
- Produces: `rebuildDataChannels(reason: string): Promise<boolean>` — relay DC 重建入口；`noteDataChannelFault(reason)` 行为变更（relay + pc.connected 时走重建路径）

- [ ] **Step 1: 写失败测试（rebuildDataChannels SCTP connected 路径）**

  在 `web-client/js/webrtc.test.js` 末尾追加：

  ```js
  test('rebuildDataChannels rebuilds DC without refresh when SCTP is connected', async () => {
    // Arrange: minimal WebRTC stub with relay mode and connected SCTP
    const calls = { createOffer: 0, refresh: 0, scheduleReconnect: 0, createInputChannel: 0 };
    const wrtc = Object.assign(Object.create(WebRTC), {
      networkMode: 'relay',
      _rebuildingDc: false,
      inputChannel: null,
      inputMoveChannel: null,
      pc: {
        connectionState: 'connected',
        sctp: { state: 'connected' },
      },
      createInputChannel() { calls.createInputChannel++; },
      async createOffer() { calls.createOffer++; },
      async refresh() { calls.refresh++; },
      scheduleReconnect(r) { calls.scheduleReconnect++; },
    });

    const result = await wrtc.rebuildDataChannels('dc-closed');

    assert.equal(result, true, 'rebuildDataChannels should return true on success');
    assert.equal(calls.createInputChannel, 1, 'createInputChannel called once');
    assert.equal(calls.createOffer, 1, 'createOffer called once');
    assert.equal(calls.refresh, 0, 'refresh must NOT be called');
    assert.equal(calls.scheduleReconnect, 0, 'scheduleReconnect must NOT be called');
  });

  test('rebuildDataChannels falls back to scheduleReconnect when SCTP is not connected', async () => {
    const calls = { scheduleReconnect: 0, createInputChannel: 0 };
    const wrtc = Object.assign(Object.create(WebRTC), {
      networkMode: 'relay',
      _rebuildingDc: false,
      pc: {
        connectionState: 'connected',
        sctp: { state: 'closed' },
      },
      createInputChannel() { calls.createInputChannel++; },
      scheduleReconnect(r) { calls.scheduleReconnect++; },
    });

    const result = await wrtc.rebuildDataChannels('dc-closed');

    assert.equal(result, false);
    assert.equal(calls.createInputChannel, 0, 'should not create DC when SCTP closed');
    assert.equal(calls.scheduleReconnect, 1, 'must fall back to scheduleReconnect');
  });

  test('noteDataChannelFault routes to rebuildDataChannels in relay mode with connected PC', async () => {
    const calls = { rebuild: 0, scheduleReconnect: 0 };
    const wrtc = Object.assign(Object.create(WebRTC), {
      networkMode: 'relay',
      _rebuildingDc: false,
      pc: { connectionState: 'connected' },
      async rebuildDataChannels(r) { calls.rebuild++; return true; },
      scheduleReconnect(r) { calls.scheduleReconnect++; },
      shouldReconnectForDataChannelFault() { return true; },
    });

    wrtc.noteDataChannelFault('dc-closed');
    await new Promise(r => setTimeout(r, 0)); // flush microtasks

    assert.equal(calls.rebuild, 1, 'relay path must call rebuildDataChannels');
    assert.equal(calls.scheduleReconnect, 0, 'must not scheduleReconnect in relay path');
  });
  ```

- [ ] **Step 2: 运行失败测试确认 FAIL**

  ```bash
  cd /Users/macstudio1/AI/Claude/WebRemoteDesktop/signal-server
  node --test ../web-client/js/webrtc.test.js 2>&1 | tail -20
  ```

  预期：3 个新 test 全部 FAIL，报 `rebuildDataChannels is not a function`

- [ ] **Step 3: 添加 _rebuildingDc 到初始化对象**

  在 `web-client/js/webrtc.js` 找到对象初始化块（L1-L106，`const WebRTC = {` 开始处），在 `_relayHardRefreshCount: 0,` 附近加入：

  ```js
  _rebuildingDc: false,
  ```

  （在 `_relayHardRefreshCount: 0,` 这行后面插入）

- [ ] **Step 4: 新增 rebuildDataChannels 方法**

  在 `noteDataChannelFault` 方法（L3973）**之前**插入以下新方法：

  ```js
  async rebuildDataChannels(reason) {
    if (this._rebuildingDc) return false;
    if (!this.pc || this.pc.connectionState !== 'connected') return false;
    if (this.pc.sctp?.state !== 'connected') {
      // SCTP association already dead — need full reconnect
      this.scheduleReconnect(reason);
      return false;
    }
    this._rebuildingDc = true;
    console.warn('[INPUT-DC] Rebuilding DataChannels without refresh reason=%s', reason);
    try {
      // Drop stale references so onclose callbacks on old channels don't re-trigger
      this.inputChannel = null;
      this.inputMoveChannel = null;
      this.createInputChannel();
      await this.createOffer();
    } catch (err) {
      console.warn('[INPUT-DC] rebuildDataChannels failed:', err?.message || err);
      this.scheduleReconnect(reason);
      return false;
    } finally {
      this._rebuildingDc = false;
    }
    return true;
  },
  ```

- [ ] **Step 5: 修改 noteDataChannelFault**

  找到 `noteDataChannelFault(reason)` 方法（L3973），将其替换为：

  ```js
  noteDataChannelFault(reason) {
    // In relay mode with a healthy PC, only rebuild the DataChannel — do NOT tear
    // down the video relay. A full refresh is only needed when the PC itself fails.
    if (this.networkMode === 'relay'
        && this.pc?.connectionState === 'connected'
        && !this._rebuildingDc) {
      this.rebuildDataChannels(reason);
      return true;
    }
    if (!this.shouldReconnectForDataChannelFault(reason)) {
      this._inputDcDegraded = true;
      console.warn('[INPUT-DC] degraded reason=%s video-healthy=true skip-reconnect', reason);
      if (typeof Input !== 'undefined') Input.setKeyboardDataChannelAvailable?.(false);
      return false;
    }
    this.scheduleReconnect(reason);
    return true;
  },
  ```

- [ ] **Step 6: 运行测试确认通过**

  ```bash
  cd /Users/macstudio1/AI/Claude/WebRemoteDesktop/signal-server
  node --test ../web-client/js/webrtc.test.js 2>&1 | tail -20
  ```

  预期：所有测试（含原有）全部 PASS

- [ ] **Step 7: Commit**

  ```bash
  cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
  git add web-client/js/webrtc.js web-client/js/webrtc.test.js
  git commit -m "fix(webrtc): rebuild DataChannel only on relay DC fault instead of full refresh to stop reconnect storm"
  ```

---

## Task 3: C1 — host 修饰键 reconcile

**Files:**
- Modify: `python-host/input_handler.py`（`keyboard_input` 方法 + 新增 `_release_lost_modifier_flags`）
- Test: `python-host/test_quartz_keyboard_adapter.py`

**Interfaces:**
- Consumes: `self._modifier_flags`（int）；`self._pressed_modifier_key_codes`（set[int]）；`self._pressed_key_codes`（set[int]）；`payload_flags`（int，来自浏览器 modifiers）；`kCGEventFlagMaskCommand`、`kCGEventFlagMaskShift`、`kCGEventFlagMaskAlternate`、`kCGEventFlagMaskControl`（已导入，L19-20）
- Produces: `_release_lost_modifier_flags(lost_flags: int, reason: str) -> None` — 公开供测试，补发幽灵修饰键 keyup

- [ ] **Step 1: 写失败测试（幽灵 Control 被 reconcile 清除）**

  在 `python-host/test_quartz_keyboard_adapter.py` 末尾追加：

  ```python
  def test_reconcile_releases_phantom_control_on_next_plain_keydown(monkeypatch):
      """
      Scenario: viewer sent ControlLeft keydown but its keyup was lost (DataChannel hiccup).
      On the next plain-key keydown with modifiers.ctrl=False, the phantom Control
      must be cleared via _release_lost_modifier_flags before the key is posted.
      """
      calls = patch_quartz(monkeypatch)
      import input_handler as ih
      monkeypatch.setattr(ih, "CGEventCreateKeyboardEvent",
                          lambda src, kc, down: {"source": src, "key_code": kc, "is_down": down, "flags": None})
      monkeypatch.setattr(ih, "CGEventSetFlags",
                          lambda ev, fl: ev.__setitem__("flags", fl))
      monkeypatch.setattr(ih, "CGEventPost",
                          lambda _tap, ev: calls.events.append(ev))
      monkeypatch.setattr(ih, "CGEventSourceCreate", lambda _: "source")

      handler = ih.InputHandler.__new__(ih.InputHandler)
      handler.source = "source"
      handler._modifier_flags = ih.kCGEventFlagMaskControl  # phantom Control
      handler._pressed_modifier_key_codes = set()            # keyup was lost — not tracked
      handler._pressed_key_codes = set()
      handler._last_key_flags = {}
      handler._modifier_stale_seconds = 8.0

      # Simulate plain 'A' keydown (code=KeyA) with no modifiers from browser
      payload = {
          "code": "KeyA",
          "key": "a",
          "modifiers": {"ctrl": False, "shift": False, "alt": False, "meta": False},
          "phase": "down",
      }
      import asyncio
      asyncio.run(handler.keyboard_input("keydown", payload))

      # _modifier_flags must be cleared
      assert handler._modifier_flags == 0, \
          f"phantom Control flag not cleared: 0x{handler._modifier_flags:08x}"
      # No CGEvent keyup for Control should have been posted because pressed set was empty
      # (the flag is still cleared via bit mask even without a physical keyup event)


  def test_reconcile_preserves_real_cmd_c_modifier(monkeypatch):
      """
      Scenario: user presses Cmd+C normally — MetaLeft is truly held.
      The reconcile must NOT clear the Meta flag because payload.meta=True matches.
      """
      calls = patch_quartz(monkeypatch)
      import input_handler as ih
      monkeypatch.setattr(ih, "CGEventCreateKeyboardEvent",
                          lambda src, kc, down: {"source": src, "key_code": kc, "is_down": down, "flags": None})
      monkeypatch.setattr(ih, "CGEventSetFlags",
                          lambda ev, fl: ev.__setitem__("flags", fl))
      monkeypatch.setattr(ih, "CGEventPost",
                          lambda _tap, ev: calls.events.append(ev))
      monkeypatch.setattr(ih, "CGEventSourceCreate", lambda _: "source")

      handler = ih.InputHandler.__new__(ih.InputHandler)
      handler.source = "source"
      handler._modifier_flags = ih.kCGEventFlagMaskCommand  # real Cmd held
      handler._pressed_modifier_key_codes = {55}             # MetaLeft tracked
      handler._pressed_key_codes = {55}
      handler._last_key_flags = {}
      handler._modifier_stale_seconds = 8.0

      # C keydown while Cmd is genuinely held
      payload = {
          "code": "KeyC",
          "key": "c",
          "modifiers": {"ctrl": False, "shift": False, "alt": False, "meta": True},
          "phase": "down",
      }
      import asyncio
      asyncio.run(handler.keyboard_input("keydown", payload))

      assert handler._modifier_flags & ih.kCGEventFlagMaskCommand, \
          "real Cmd flag must NOT be cleared during Cmd+C"
  ```

- [ ] **Step 2: 运行失败测试确认 FAIL**

  ```bash
  cd /Users/macstudio1/AI/Claude/WebRemoteDesktop/python-host
  pytest test_quartz_keyboard_adapter.py::test_reconcile_releases_phantom_control_on_next_plain_keydown \
         test_quartz_keyboard_adapter.py::test_reconcile_preserves_real_cmd_c_modifier -v
  ```

  预期：2 个测试 FAIL（`keyboard_input` 无 reconcile，幽灵 Control 未被清除）

- [ ] **Step 3: 新增 _release_lost_modifier_flags 方法**

  在 `python-host/input_handler.py` 中找到 `release_all_modifiers` 方法（L760），在其**之前**插入：

  ```python
  def _release_lost_modifier_flags(self, lost_flags: int, reason: str = "reconcile") -> None:
      """
      Reconcile: clear modifier flags whose keyup was lost (e.g. DataChannel drop).
      Emits CGEvent keyup for each flag bit found in _pressed_modifier_key_codes;
      always clears the bit from _modifier_flags even if no physical code is tracked.
      """
      flag_to_keycodes = {
          kCGEventFlagMaskCommand:   [55, 54],   # MetaLeft, MetaRight
          kCGEventFlagMaskShift:     [56, 60],   # ShiftLeft, ShiftRight
          kCGEventFlagMaskAlternate: [58, 61],   # AltLeft, AltRight
          kCGEventFlagMaskControl:   [59, 62],   # ControlLeft, ControlRight
      }
      logger.warning(
          "reconcile: releasing lost modifier flags=0x%08x reason=%s",
          lost_flags, reason,
      )
      for flag, keycodes in flag_to_keycodes.items():
          if not (lost_flags & flag):
              continue
          self._modifier_flags &= ~flag
          # Emit a physical keyup only if we tracked the key as pressed
          for kc in keycodes:
              if kc in self._pressed_modifier_key_codes:
                  self._pressed_modifier_key_codes.discard(kc)
                  self._pressed_key_codes.discard(kc)
                  event = CGEventCreateKeyboardEvent(self.source, kc, False)
                  CGEventSetFlags(event, self._modifier_flags)
                  CGEventPost(kCGHIDEventTap, event)
                  logger.info(
                      "  -> reconcile keyup mac_code=%s flag=0x%08x reason=%s",
                      kc, flag, reason,
                  )
                  break  # one keyup per modifier family is enough
  ```

- [ ] **Step 4: 在 keyboard_input 中插入 reconcile 调用**

  在 `python-host/input_handler.py` 的 `keyboard_input` 方法中，找到以下行（约 L708）：

  ```python
  if action == 'keydown' and not is_modifier and self._modifier_flags and flags == 0:
      self.release_all_modifiers(reason="plain-key-reset")
  ```

  在这两行**之前**（即在它们的上面）插入 reconcile 块：

  ```python
  # Reconcile: browser payload is the authoritative modifier state.
  # Any bit set in _modifier_flags but absent in payload_flags means the
  # keyup was lost (e.g. DataChannel drop). Clear phantom bits immediately
  # so macOS does not misinterpret subsequent keystrokes as Ctrl/Cmd chords.
  if action == 'keydown' and not is_modifier:
      lost_flags = self._modifier_flags & ~payload_flags
      if lost_flags:
          self._release_lost_modifier_flags(lost_flags, reason="reconcile")
  ```

  插入后该区域看起来如下（保持 12 空格缩进与原代码一致）：

  ```python
          # Reconcile: browser payload is the authoritative modifier state.
          # Any bit set in _modifier_flags but absent in payload_flags means the
          # keyup was lost (e.g. DataChannel drop). Clear phantom bits immediately
          # so macOS does not misinterpret subsequent keystrokes as Ctrl/Cmd chords.
          if action == 'keydown' and not is_modifier:
              lost_flags = self._modifier_flags & ~payload_flags
              if lost_flags:
                  self._release_lost_modifier_flags(lost_flags, reason="reconcile")

          if action == 'keydown' and not is_modifier and self._modifier_flags and flags == 0:
              self.release_all_modifiers(reason="plain-key-reset")
  ```

- [ ] **Step 5: 运行测试确认通过**

  ```bash
  cd /Users/macstudio1/AI/Claude/WebRemoteDesktop/python-host
  pytest test_quartz_keyboard_adapter.py -v 2>&1 | tail -20
  ```

  预期：所有测试（含原有）全部 PASS

- [ ] **Step 6: 运行全量 Python 测试确认无回归**

  ```bash
  cd /Users/macstudio1/AI/Claude/WebRemoteDesktop/python-host
  pytest -v 2>&1 | tail -30
  ```

  预期：所有测试 PASS，无新 FAIL

- [ ] **Step 7: Commit**

  ```bash
  cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
  git add python-host/input_handler.py python-host/test_quartz_keyboard_adapter.py
  git commit -m "fix(host): reconcile modifier flags on keydown to clear phantom Ctrl/Cmd from lost keyups"
  ```

---

## 自审结果

**Spec 覆盖检查：**
- B1 (jitterBufferTarget relay 感知) → Task 1 ✓
- A1 (DC 重建不 full refresh) → Task 2 ✓
- C1 (modifier reconcile) → Task 3 ✓
- B2 (playoutDelayHint 下限) → Task 1 中一并实现（`playoutDelayHint = isRelay ? 0.08 : 0`）✓
- A2 (isInboundVideoHealthy relay 口径) → B1 修完后 fps=0 消失，健康判定自然稳定，无需额外改动 ✓

**占位符扫描：** 无 TBD/TODO，所有步骤含完整代码。

**类型一致性：**
- `rebuildDataChannels(reason)` — Task 2 Step 4 定义，Step 5 (`noteDataChannelFault`) 和 Step 1 (测试) 使用同名 ✓
- `_release_lost_modifier_flags(lost_flags, reason)` — Task 3 Step 3 定义，Step 4 调用同名 ✓
- `createInputChannel()` — 原代码 L2830 已存在，Task 2 Step 4 调用 ✓
