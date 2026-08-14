# Tab 恢复重连环实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 堵住「回到标签页后多条恢复路径互相拆刚连上的 PC」这条环。用户离开再回来最多一次全量重连，不再 1–2 秒一轮闪屏/黑屏。

**Architecture:** 单一 `refresh` 门闸 + grant 不再当重连 + `_refreshing` 覆盖到新连接落地 + 熔断计数只在稳定后清零 + tab 回来先 rebuild DC + Host 对已关闭 PC 的 resume 立刻失败。不改 TURN/ICE/编码。

**Tech Stack:** 浏览器 WebRTC API；Node.js `node:test`（在仓库根目录执行 `node --test web-client/js/webrtc.test.js`）；Python 3.11 + pytest（在 `python-host/` 执行）。

**Spec:** `docs/superpowers/specs/2026-08-14-tab-resume-reconnect-loop-design.md`

## Global Constraints

- 只改本计划列出的文件。禁止顺手重构 `webrtc.js` 其它子系统。
- 现有 `webrtc.test.js` / `test_media_suspension.py` 必须继续通过。若旧测试与本设计冲突，只允许改「brief-connect 清零熔断」这类被本 spec 明确废止的断言，并在 commit message 写明。
- 「刷新画面」必须继续能强制 refresh；网络模式 / TURN 手动切换同理。
- tunnel 分支（`handleControlGrant` 的 tunnel 路径、`startTunnelRelay`）不改行为。
- 每个 Task 先写失败测试再改产品代码。Task 完成后立即 commit。
- 重启 Host 必须用 `./scripts/restart-host.sh`。重启 signal 用现有 `node server.js` / `npm start` 方式，**不要**重建 cloudflared / quick tunnel。
- 不要额外启动 `web-client` Vite。正式入口是 `http://127.0.0.1:8080`（signal 构建 `web-client/dist/`）。

---

## 文件改动清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `web-client/js/webrtc.js` | 修改 | 门闸、grant、`_refreshing` 生命周期、稳定清零、visibility |
| `web-client/js/webrtc.test.js` | 修改 | 新增 Task 1–5 测试；必要时微调被废止的旧断言 |
| `python-host/host.py` | 修改 | resume 时 PC 已关闭则立刻 `applied=false` |
| `python-host/test_media_suspension.py` | 修改 | Task 6 新测试 |

---

## Task 1: refresh 门闸

**Files:**
- Modify: `web-client/js/webrtc.test.js`
- Modify: `web-client/js/webrtc.js`（`refresh()`、刷新按钮、`canBeginRefresh`）

**Why:** 今天风暴走 `refresh()` 直调，`scheduleReconnect` 的 3s 冷却根本碰不到。

- [ ] **Step 1: 写失败测试**

  在 `webrtc.test.js` 追加两个测试（沿用 `loadWebRTC()`）：

  ```js
  test('recovery refresh is suppressed within 3s of last refresh', async () => {
    const { WebRTC } = loadWebRTC();
    let closed = 0;
    WebRTC.socket = { connected: true };
    WebRTC.networkMode = 'relay';
    WebRTC.hasTurnConfigured = () => true;
    WebRTC.stopTunnelRelay = () => {};
    WebRTC.createPeerConnection = () => { WebRTC.pc = { close() {} }; };
    WebRTC.createOffer = () => {};
    WebRTC.pc = { close() { closed += 1; } };
    WebRTC._lastRefreshAt = Date.now();
    await WebRTC.refresh({ reason: 'dc-dead-on-resume' });
    assert.equal(closed, 0);
  });

  test('manual refresh bypasses recovery cooldown', async () => {
    const { WebRTC } = loadWebRTC();
    let closed = 0;
    WebRTC.socket = { connected: true };
    WebRTC.networkMode = 'relay';
    WebRTC.hasTurnConfigured = () => true;
    WebRTC.stopTunnelRelay = () => {};
    WebRTC.createPeerConnection = () => { WebRTC.pc = { close() {} }; };
    WebRTC.createOffer = () => {};
    WebRTC.pc = { close() { closed += 1; } };
    WebRTC._lastRefreshAt = Date.now();
    await WebRTC.refresh({ reason: 'manual' });
    assert.equal(closed, 1);
  });
  ```

  若现有 `refresh()` 在冷却期内仍 close PC，第一个测试必须失败。

- [ ] **Step 2: 跑测试确认失败**

  ```bash
  node --test web-client/js/webrtc.test.js --test-name-pattern 'recovery refresh|manual refresh'
  ```

  Expected: 第一个 FAIL（`closed` 为 1），第二个视现有行为可能 PASS。

- [ ] **Step 3: 实现门闸**

  在 `WebRTC` 对象上新增：

  ```js
  RECOVERY_REFRESH_COOLDOWN_MS: 3000,
  isForcedRefreshReason(reason) {
    return reason == null
      || reason === 'manual'
      || reason === 'manual-mode-switch'
      || reason === 'manual-turn-switch';
  },
  canBeginRefresh(reason) {
    if (this.isForcedRefreshReason(reason)) return true;
    if (Date.now() - (this._lastRefreshAt || 0) < this.RECOVERY_REFRESH_COOLDOWN_MS) {
      console.warn('[RECOVERY] Suppressing refresh reason=%s', reason);
      return false;
    }
    return true;
  },
  ```

  **精确约定：**
  - `refresh()` 无参数 / `reason == null`：强制（兼容现有测试）。
  - `reason` 为 `manual` | `manual-mode-switch` | `manual-turn-switch`：强制。
  - 其它非空 reason：冷却。

  `refresh()` 开头、改任何状态之前：

  ```js
  refresh(options = {}) {
    const reason = options && options.reason;
    if (!this.canBeginRefresh(reason)) return;
    // 现有逻辑……
  }
  ```

  把「刷新画面」按钮从 `WebRTC.refresh()` 改为 `WebRTC.refresh({ reason: 'manual' })`（约 L4603）。

  `setNetworkMode` 里的 `this.refresh()` 改为 `this.refresh({ reason: 'manual-mode-switch' })`。
  手动 TURN 切换里的 `this.refresh()` 改为 `this.refresh({ reason: 'manual-turn-switch' })`。

- [ ] **Step 4: 跑测试确认通过**

  ```bash
  node --test web-client/js/webrtc.test.js --test-name-pattern 'recovery refresh|manual refresh|refresh clears stuck|refresh resets ICE'
  ```

  Expected: PASS。

- [ ] **Step 5: Commit**

  ```bash
  git add web-client/js/webrtc.js web-client/js/webrtc.test.js
  git commit -m "$(cat <<'EOF'
  fix(webrtc): gate recovery refresh with 3s cooldown

  Direct refresh() calls (dc-dead-on-resume, media timeout) bypassed
  scheduleReconnect cooldown and tore down healthy PCs every ~1s.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 2: grant 不再发 offer

**Files:**
- Modify: `web-client/js/webrtc.test.js`
- Modify: `web-client/js/webrtc.js` `handleControlGrant`

- [ ] **Step 1: 写失败测试**

  ```js
  test('control grant does not createOffer when PC and DC are already live', () => {
    const { WebRTC, context } = loadWebRTC();
    let offers = 0;
    context.Input = { init() {}, setControlLease() {}, setActive() {} };
    WebRTC.startControlHeartbeat = () => {};
    WebRTC.updateControlUI = () => {};
    WebRTC.createOffer = () => { offers += 1; };
    WebRTC.createPeerConnection = () => {};
    WebRTC.bindCurrentConnectionAttempt = () => false;
    WebRTC.replayMediaActivityIntent = () => false;
    WebRTC.ensureMediaActiveIfVisible = () => false;
    WebRTC.networkMode = 'relay';
    WebRTC.pc = { connectionState: 'connected' };
    WebRTC.inputChannel = { readyState: 'open' };
    WebRTC.handleControlGrant({ controller: true, leaseId: 'lease-000000000001', leaseEpoch: 1 });
    assert.equal(offers, 0);
  });

  test('control grant still creates offer when PC is missing', () => {
    const { WebRTC, context } = loadWebRTC();
    let offers = 0;
    context.Input = { init() {}, setControlLease() {}, setActive() {} };
    WebRTC.startControlHeartbeat = () => {};
    WebRTC.updateControlUI = () => {};
    WebRTC.createOffer = () => { offers += 1; };
    WebRTC.createPeerConnection = () => { WebRTC.pc = { connectionState: 'new' }; };
    WebRTC.bindCurrentConnectionAttempt = () => false;
    WebRTC.replayMediaActivityIntent = () => false;
    WebRTC.ensureMediaActiveIfVisible = () => false;
    WebRTC.networkMode = 'relay';
    WebRTC.pc = null;
    WebRTC.inputChannel = null;
    WebRTC.handleControlGrant({ controller: true, leaseId: 'lease-000000000001', leaseEpoch: 1 });
    assert.equal(offers, 1);
  });
  ```

- [ ] **Step 2: 跑测试确认失败**

  ```bash
  node --test web-client/js/webrtc.test.js --test-name-pattern 'control grant does not createOffer|control grant still creates'
  ```

  Expected: 第一个 FAIL（offers === 1）。

- [ ] **Step 3: 改 handleControlGrant**

  非 tunnel 分支替换为：

  ```js
  const pcState = this.pc?.connectionState;
  const dcOpen = this.inputChannel?.readyState === 'open';
  const live = pcState === 'connected' && (dcOpen || this._refreshing);
  if (!live) {
    if (!this.pc || ['failed', 'closed', 'disconnected'].includes(pcState)) {
      this.createPeerConnection();
    }
    this.createOffer();
  }
  this.replayMediaActivityIntent('control-regrant');
  ```

  tunnel 分支一字不改。lease 绑定、心跳、`ensureMediaActiveIfVisible` 仍在前面执行。

- [ ] **Step 4: 跑测试**

  ```bash
  node --test web-client/js/webrtc.test.js --test-name-pattern 'control grant'
  ```

  Expected: 新旧 grant 测试全 PASS。

- [ ] **Step 5: Commit**

  ```bash
  git add web-client/js/webrtc.js web-client/js/webrtc.test.js
  git commit -m "$(cat <<'EOF'
  fix(webrtc): do not renegotiate on control-grant when PC is live

  Host treats every new offer as full teardown. Re-grant after tab
  return was destroying a just-connected relay PC.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 3: `_refreshing` 覆盖到新连接落地

**Files:**
- Modify: `web-client/js/webrtc.js`（`refresh`、`markRefreshSettled`、connected 处理）
- Modify: `web-client/js/webrtc.test.js`

- [ ] **Step 1: 写失败测试**

  ```js
  test('refresh keeps _refreshing true until settled', async () => {
    const { WebRTC } = loadWebRTC();
    WebRTC.socket = { connected: true };
    WebRTC.networkMode = 'relay';
    WebRTC.hasTurnConfigured = () => true;
    WebRTC.stopTunnelRelay = () => {};
    WebRTC.createPeerConnection = () => { WebRTC.pc = { close() {}, connectionState: 'connecting' }; };
    WebRTC.createOffer = () => {};
    WebRTC.pc = { close() {} };
    await WebRTC.refresh({ reason: 'manual' });
    assert.equal(WebRTC._refreshing, true);
    WebRTC.markRefreshSettled('test');
    assert.equal(WebRTC._refreshing, false);
  });

  test('scheduleReconnect is a no-op while _refreshing', () => {
    const { WebRTC } = loadWebRTC();
    let refreshes = 0;
    WebRTC.manualDisconnect = false;
    WebRTC._refreshing = true;
    WebRTC.reconnectTimer = null;
    WebRTC.isMediaHealthSuppressed = () => false;
    WebRTC.isPortSearchActive = () => false;
    WebRTC.refresh = () => { refreshes += 1; };
    WebRTC.scheduleReconnect('ice-closed');
    assert.equal(refreshes, 0);
    assert.equal(WebRTC.reconnectTimer, null);
  });
  ```

  第二个测试现在就应该 PASS（`scheduleReconnect` 已检查 `_refreshing`）。第一个必须 FAIL（当前 `refresh` 末尾把 `_refreshing` 同步放下）。

- [ ] **Step 2: 跑测试确认第一个失败**

  ```bash
  node --test web-client/js/webrtc.test.js --test-name-pattern 'refresh keeps _refreshing|scheduleReconnect is a no-op while'
  ```

- [ ] **Step 3: 实现生命周期**

  新增：

  ```js
  markRefreshSettled(_reason) {
    if (this._refreshSettleTimer) {
      clearTimeout(this._refreshSettleTimer);
      this._refreshSettleTimer = null;
    }
    this._refreshing = false;
  },
  ```

  在 `refresh()` 里：
  - 删掉函数中段的 `this._refreshing = false;`
  - 开工时 `_refreshing = true` 后设 8000ms 安全定时器。必须 `timer.unref?.()`，否则 `node --test` 会等每个 refresh 测试的 8s 定时器。
  - 若已有旧 timer 先 clear

  在 `inputChannel.onopen`（确认 `this.inputChannel === inputChannel` 之后）若 `_refreshing`，调用 `markRefreshSettled('dc-open')`。

  在 `pc.onconnectionstatechange` 的 `connected` 分支：若 `_refreshing` 且 DC 已 open，立刻 settle；否则 2000ms 后 `markRefreshSettled('pc-connected-dc-wait')`。

  `disconnect()` / `enterUnavailableRelayState` 也要 `markRefreshSettled`，避免卡死。

- [ ] **Step 4: 跑测试**

  ```bash
  node --test web-client/js/webrtc.test.js --test-name-pattern 'refresh keeps _refreshing|scheduleReconnect is a no-op while|refresh clears stuck|refresh resets ICE'
  ```

  Expected: PASS。

- [ ] **Step 5: Commit**

  ```bash
  git add web-client/js/webrtc.js web-client/js/webrtc.test.js
  git commit -m "$(cat <<'EOF'
  fix(webrtc): keep _refreshing until the new PC/DC actually lands

  Clearing the flag synchronously let ice-closed/dc-dead fire another
  teardown before ICE finished.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 4: 熔断计数只在稳定后清零

**Files:**
- Modify: `web-client/js/webrtc.js` `onconnectionstatechange` connected 分支
- Modify: `web-client/js/webrtc.test.js`

**Why:** brief-connect 把 `_reconnectAttempt` 和 `_mediaResumeRefreshFallbackUsed` 清零，冷却/「只硬刷新一次」全部失效。

- [ ] **Step 1: 写失败测试**

  需要把 `createPeerConnection` 里注册的 `onconnectionstatechange` 跑起来。更省事的做法：抽 `onPeerConnected()` 并单测它。若不想抽函数，直接调已绑好的 handler：

  ```js
  test('brief PC connect does not reset recovery circuit breakers', () => {
    const { WebRTC } = loadWebRTC();
    WebRTC._reconnectAttempt = 3;
    WebRTC._relayHardRefreshCount = 2;
    WebRTC._mediaResumeRefreshFallbackUsed = true;
    WebRTC._mediaResumeSoftRecoverUsed = true;
    WebRTC.pc = {
      connectionState: 'connected',
      iceConnectionState: 'completed',
    };
    // 调用将要抽出的方法
    WebRTC.onPeerConnected();
    assert.equal(WebRTC._reconnectAttempt, 3);
    assert.equal(WebRTC._relayHardRefreshCount, 2);
    assert.equal(WebRTC._mediaResumeRefreshFallbackUsed, true);
    assert.equal(WebRTC._mediaResumeSoftRecoverUsed, true);
  });
  ```

  实现时把 connected 分支主体抽成 `onPeerConnected()`，`onconnectionstatechange` 在 `connectionState === 'connected'` 时调用它。现有副作用（startStats、ensureMediaActiveIfVisible 等）留在 `onPeerConnected`，测试里把那些方法 stub 成空函数以免碰 DOM。

- [ ] **Step 2: 跑测试确认失败**（抽函数前先写测试会 ReferenceError；允许先抽空壳 `onPeerConnected` 把当前清零逻辑原样搬进去，此时测试 FAIL 在断言，不是缺方法）

- [ ] **Step 3: 实现**

  从 `onPeerConnected` 删除这四行清零：

  ```js
  this._reconnectAttempt = 0;
  this._relayHardRefreshCount = 0;
  this._mediaResumeSoftRecoverUsed = false;
  this._mediaResumeRefreshFallbackUsed = false;
  ```

  新增：

  ```js
  STABLE_RECOVERY_RESET_MS: 5000,
  armStableRecoveryReset() {
    if (this._stableResetTimer) clearTimeout(this._stableResetTimer);
    this._stableResetTimer = setTimeout(() => {
      this._stableResetTimer = null;
      if (this.pc?.connectionState !== 'connected') return;
      this._reconnectAttempt = 0;
      this._relayHardRefreshCount = 0;
      this._mediaResumeSoftRecoverUsed = false;
      this._mediaResumeRefreshFallbackUsed = false;
    }, this.STABLE_RECOVERY_RESET_MS);
  },
  ```

  `onPeerConnected` 末尾（在 startStats 等之后）调用 `this.armStableRecoveryReset()`。
  PC disconnected/failed/closed 分支 clear 这个 timer。
  `refresh()` / `disconnect()` 也 clear。

  **不要改** `beginConnectionAttempt('viewer-open' | 'manual-mode-switch')` 里现有的清零。现有测试 `fresh-frame hard refresh inherits resume budget and does not loop` 必须继续过。

- [ ] **Step 4: 再加一个稳定清零测试**

  ```js
  test('stable window resets circuit breakers after 5s connected', () => {
    const timers = [];
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    global.setTimeout = (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    };
    global.clearTimeout = (handle) => { if (handle) handle.cleared = true; };
    try {
      const { WebRTC } = loadWebRTC();
      WebRTC._reconnectAttempt = 3;
      WebRTC.pc = { connectionState: 'connected' };
      WebRTC.startStats = () => {};
      WebRTC.startVideoFrameTracking = () => {};
      WebRTC.syncMediaProfile = () => {};
      WebRTC.clearFailureRecommendation = () => {};
      WebRTC.updateNetworkUI = () => {};
      WebRTC.ensureMediaActiveIfVisible = () => {};
      WebRTC.syncDesktopInputGate = () => {};
      WebRTC.onPeerConnected();
      const stable = timers.find((t) => t.ms === 5000);
      assert.ok(stable);
      stable.fn();
      assert.equal(WebRTC._reconnectAttempt, 0);
    } finally {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
    }
  });
  ```

- [ ] **Step 5: 跑测试**

  ```bash
  node --test web-client/js/webrtc.test.js --test-name-pattern 'brief PC connect|stable window resets|fresh-frame hard refresh inherits'
  ```

  Expected: PASS。

- [ ] **Step 6: Commit**

  ```bash
  git add web-client/js/webrtc.js web-client/js/webrtc.test.js
  git commit -m "$(cat <<'EOF'
  fix(webrtc): reset reconnect breakers only after a stable 5s window

  Brief PC connect was zeroing _reconnectAttempt and the media-resume
  hard-refresh flag, which re-armed the 1.5s teardown loop.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 5: tab 回来先 rebuild DC

**Files:**
- Modify: `web-client/js/webrtc.js` `bindControlLifecycle` visibility 分支
- Modify: `web-client/js/webrtc.test.js`

- [ ] **Step 1: 写失败测试**

  visibility handler 是在 `bindControlLifecycle` 里用 `document.addEventListener` 注册的。`loadWebRTC` 的 `document.addEventListener` 默认是空函数。测试里传入可记录的 document：

  ```js
  test('tab return rebuilds DataChannels instead of full refresh when SCTP is live', () => {
    const listeners = {};
    const { WebRTC } = loadWebRTC({
      document: {
        hidden: false,
        body: makeElement(),
        addEventListener(type, fn) { listeners[type] = fn; },
        getElementById() { return makeElement(); },
        querySelector: () => null,
      },
    });
    let refreshes = 0;
    let rebuilds = 0;
    WebRTC._controlLifecycleBound = false;
    WebRTC.bindControlLifecycle();
    WebRTC.pc = { connectionState: 'connected', sctp: { state: 'connected' } };
    WebRTC.inputChannel = { readyState: 'closing' };
    WebRTC.manualDisconnect = false;
    WebRTC._refreshing = false;
    WebRTC.hasActiveControl = () => false;
    WebRTC.ensureMediaActiveIfVisible = () => false;
    WebRTC.refresh = () => { refreshes += 1; };
    WebRTC.rebuildDataChannels = () => { rebuilds += 1; return true; };
    listeners.visibilitychange();
    assert.equal(rebuilds, 1);
    assert.equal(refreshes, 0);
  });
  ```

  `makeElement` 已在测试文件顶部。若 `loadWebRTC` 对自定义 document 缺字段导致启动期炸掉，补齐最小字段，不要改产品代码去迁就测试。

- [ ] **Step 2: 跑测试确认失败**

  当前实现是直接 `refresh({reason:'dc-dead-on-resume'})`，`rebuilds === 0`。

- [ ] **Step 3: 改 visibility 可见分支**

  替换 DC-dead 那段：

  ```js
  if (this._refreshing || this.manualDisconnect) {
    if (this.hasActiveControl()) this.syncDesktopInputGate();
    this.ensureMediaActiveIfVisible('visibility-visible');
    return;
  }
  if (this.pc?.connectionState === 'connected' && this.inputChannel?.readyState !== 'open') {
    const rebuilt = this.pc.sctp?.state === 'connected'
      ? this.rebuildDataChannels('dc-dead-on-resume')
      : false;
    if (!rebuilt) this.refresh({ reason: 'dc-dead-on-resume' });
    return;
  }
  if (this.hasActiveControl()) this.syncDesktopInputGate();
  this.ensureMediaActiveIfVisible('visibility-visible');
  ```

  `rebuildDataChannels` 现是 async。可见分支里用：

  ```js
  Promise.resolve(this.rebuildDataChannels('dc-dead-on-resume')).then((ok) => {
    if (!ok && !this._refreshing) this.refresh({ reason: 'dc-dead-on-resume' });
  });
  return;
  ```

  SCTP 非 connected 时直接 `refresh({reason:'dc-dead-on-resume'})`（过 Task 1 门闸）。

- [ ] **Step 4: 跑测试**

  ```bash
  node --test web-client/js/webrtc.test.js --test-name-pattern 'tab return rebuilds'
  ```

  Expected: PASS。

- [ ] **Step 5: Commit**

  ```bash
  git add web-client/js/webrtc.js web-client/js/webrtc.test.js
  git commit -m "$(cat <<'EOF'
  fix(webrtc): rebuild DataChannels on tab return before full refresh

  dc-dead-on-resume was a guaranteed full teardown even when SCTP
  was still up, which started the new-offer storm.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 6: Host resume 在 PC 已关闭时立刻失败

**Files:**
- Modify: `python-host/test_media_suspension.py`
- Modify: `python-host/host.py` `on_media_activity_change`

- [ ] **Step 1: 写失败测试**

  仿照 `test_media_resume_fails_closed_on_fresh_capture_timeout`，新增：

  ```python
  @pytest.mark.asyncio
  async def test_media_resume_fails_closed_immediately_when_pc_missing():
      # pc is None → must NOT call wait_for_fresh_capture
      called = {"wait": 0}

      class Track:
          def set_suspended(self, flag):
              return 0
          def wait_for_fresh_capture(self, after_seq, timeout=0.5):
              called["wait"] += 1
              return True

      # 按文件里现有 host fixture / 构造方式挂上 screen_track=Track(), pc=None
      # ack applied is False and reason contains "closed"
      assert called["wait"] == 0
  ```

  构造 Host 的方式必须抄同文件已有测试，不要自创另一套 mock。读 `test_media_resume_fails_closed_on_fresh_capture_timeout` 再写。

- [ ] **Step 2: 跑测试确认失败**

  ```bash
  cd python-host && python -m pytest test_media_suspension.py::test_media_resume_fails_closed_immediately_when_pc_missing -q
  ```

- [ ] **Step 3: 改 host.py**

  在 `on_media_activity_change` 的 resume 分支、`wait_for_fresh_capture` 之前：

  ```python
  pc = getattr(self, "pc", None)
  pc_state = None
  try:
      pc_state = getattr(pc, "connectionState", None) or getattr(pc, "iceConnectionState", None)
  except Exception:
      pc_state = None
  if pc is None or pc_state in {"closed", "failed"}:
      step_ok["sender"] = False
      capture_failed_reason = "closed"
      # 跳过 wait_for_fresh_capture / sender.resume
  ```

  走现有 `applied=false` + `host_media_resume_failed` 路径。不要新造事件名。

  Viewer `handleMediaRequestFailure`：若 `reason === 'closed'`，只允许 `replayMediaActivityIntent`，禁止 `refresh()`。

- [ ] **Step 4: 跑测试**

  ```bash
  cd python-host && python -m pytest test_media_suspension.py -q
  ```

  Expected: 全 PASS。

- [ ] **Step 5: Commit**

  ```bash
  git add python-host/host.py python-host/test_media_suspension.py web-client/js/webrtc.js web-client/js/webrtc.test.js
  git commit -m "$(cat <<'EOF'
  fix(host): fail media resume immediately when PC is already closed

  wait_for_fresh_capture(2s) was racing viewer teardown and reporting
  resume on a dead PC, which re-armed another refresh.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

  若 Step 3 的 viewer 小改没有发生（现有 `handleMediaRequestFailure` 已不会对 `closed` refresh），不要把 `webrtc.js` 硬加进这次 commit。

---

## Task 7: 全量测试 + 重启服务

- [ ] **Step 1: 跑 JS 全量**

  ```bash
  node --test web-client/js/webrtc.test.js web-client/js/remote-keyboard-controller.test.js web-client/js/keyboard-transport.test.js
  ```

  Expected: 全部 pass，0 fail。

- [ ] **Step 2: 跑 Host 相关 pytest**

  ```bash
  cd python-host && python -m pytest test_media_suspension.py test_offer_epoch.py -q
  ```

  Expected: 全部 pass。

- [ ] **Step 3: 读启动文档后重启**

  先读 `README.md` 与 `docs/runbook-safe-startup.md`（本次已要求）。然后：

  1. Host：仓库根目录 `./scripts/restart-host.sh`（禁止 `kill` host.py）。
  2. Signal：当前是 `node server.js` 在跑，它启动时构建 `web-client/dist/`。必须重启 signal 才能让远程 viewer 吃到新 JS。不要动 cloudflared。
  3. 用 `/health` 和 `/api/status` 确认 `hostOnline: true`。
  4. 不要启动 Vite `15173`。

- [ ] **Step 4: 冒烟**

  看 `back-debug.log` 尾部：Host 起来、没有立刻 `WebRTC FAILED`。告诉用户：远程页面 **强制刷新** 后再试「离开标签页 ≥ 30s 再回来」，60s 内 `new-offer` 不应连打。

---

## 完成定义

- 六个实现 Task 都已 commit
- JS / pytest 全绿
- Host 经 `restart-host.sh` 起来，signal 已重建 dist
- spec 第 3 节成功标准可在用户下一次 tab 切换中验证
