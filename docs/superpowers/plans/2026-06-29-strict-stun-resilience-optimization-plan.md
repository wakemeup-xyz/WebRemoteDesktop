# Strict STUN Resilience Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Strict STUN adaptive media degradation and proactive ICE recovery so weak direct UDP paths are stabilized before failure without automatically switching to TURN or media tunnel.

**Architecture:** Viewer owns quality scoring and recovery decisions because only the browser has detailed receiver stats. Signal Server relays a constrained `media-profile-change` command from viewer to host. Host applies profile changes to capture resolution/FPS and encoder bitrate where supported, then logs the applied profile for diagnostics.

**Tech Stack:** Vanilla JavaScript, Socket.IO, Node.js test runner, Python asyncio/logging, aiortc-based Host

---

## 文件结构

| 文件 | 责任 |
|------|------|
| `web-client/js/link-quality-controller.js` | **新建** 纯函数/小状态机：从 stats 判断 `good/degraded/critical/dead`，选择媒体档位和恢复动作 |
| `web-client/js/webrtc.js` | 接入质量控制器，发送 `media-profile-change`，触发 proactive ICE restart，Strict STUN 下禁止自动 tunnel |
| `web-client/js/diagnostic.js` | 将 `adaptiveMedia` 摘要合入 schemaVersion 2 诊断 payload |
| `web-client/viewer.html` | 在 `webrtc.js` 前加载 `link-quality-controller.js` |
| `web-client/js/webrtc.test.js` | 覆盖降载、proactive ICE restart、禁止 auto tunnel |
| `web-client/js/diagnostic.test.js` | 覆盖 `adaptiveMedia` payload |
| `signal-server/websocket/signaling.js` | 转发并校验 `media-profile-change` viewer -> host |
| `signal-server/websocket/signaling.test.js` | 覆盖媒体档位事件权限和 payload 限制 |
| `python-host/host.py` | 接收并应用媒体档位，输出 `WRD_MEDIA_PROFILE` |
| `python-host/test_media_profile.py` | 覆盖 Host 媒体档位校验、状态更新和日志 |
| `README.md` | 更新 Strict STUN 优化、手动 TURN/tunnel、家庭端口转发边界 |
| `docs/runbook-safe-startup.md` | 补充媒体失败排障和 quick tunnel 非媒体路径说明 |
| `docs/需求文档/WebRemoteDesktop-需求文档.md` | 更新需求层网络策略和诊断说明 |

---

### Task 1: Viewer Link Quality Controller

**Files:**
- Create: `web-client/js/link-quality-controller.js`
- Modify: `web-client/viewer.html`
- Modify: `web-client/js/webrtc.test.js`

- [ ] **Step 1: Write failing tests for quality scoring and media profile transitions**

Append tests to `web-client/js/webrtc.test.js` that load `link-quality-controller.js` in a VM and assert:

```js
test('LinkQualityController requires two degraded samples before requesting medium profile', () => {
  const { LinkQualityController } = loadLinkQualityController();
  const controller = LinkQualityController.create();

  let result = controller.observe({
    fps: 4,
    rttMs: 92,
    jitterBufferMs: 8,
    packetsLost: 54,
    framesDecoded: 121,
    framesReceived: 121,
    selectedCandidateType: 'prflx',
  });
  assert.equal(result.action, 'hold');
  assert.equal(result.profile, 'high');

  result = controller.observe({
    fps: 4,
    rttMs: 140,
    jitterBufferMs: 180,
    packetsLost: 80,
    framesDecoded: 130,
    framesReceived: 130,
    selectedCandidateType: 'prflx',
  });
  assert.equal(result.action, 'degrade');
  assert.equal(result.profile, 'medium');
  assert.equal(result.reason, 'packet-loss');
});

test('LinkQualityController enters critical recovery after repeated zero fps with selected pair', () => {
  const { LinkQualityController } = loadLinkQualityController();
  const controller = LinkQualityController.create();

  controller.observe({
    fps: 0,
    rttMs: 90,
    jitterBufferMs: 250,
    packetsLost: 10,
    framesDecoded: 199,
    framesReceived: 199,
    selectedCandidateType: 'prflx',
  });
  const result = controller.observe({
    fps: 0,
    rttMs: 95,
    jitterBufferMs: 270,
    packetsLost: 10,
    framesDecoded: 199,
    framesReceived: 199,
    selectedCandidateType: 'prflx',
  });

  assert.equal(result.action, 'critical');
  assert.equal(result.profile, 'survival');
  assert.equal(result.shouldRestartIce, true);
});
```

Add a helper in the test file:

```js
function loadLinkQualityController() {
  const context = { console, setTimeout, clearTimeout };
  context.globalThis = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, 'link-quality-controller.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__LQC = LinkQualityController;`, context);
  return { LinkQualityController: context.__LQC, context };
}
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
node --test web-client/js/webrtc.test.js
```

Expected: FAIL with missing `link-quality-controller.js` or `LinkQualityController`.

- [ ] **Step 3: Implement the controller**

Create `web-client/js/link-quality-controller.js`:

```js
const LinkQualityController = {
  profiles: {
    high: { name: 'high', width: 1280, height: 720, fps: 20, bitrateKbps: 2500 },
    medium: { name: 'medium', width: 960, height: 540, fps: 15, bitrateKbps: 1400 },
    low: { name: 'low', width: 854, height: 480, fps: 12, bitrateKbps: 900 },
    survival: { name: 'survival', width: 640, height: 360, fps: 8, bitrateKbps: 500 },
  },

  create(options = {}) {
    const order = ['high', 'medium', 'low', 'survival'];
    return {
      currentProfile: options.initialProfile || 'high',
      degradedCount: 0,
      criticalCount: 0,
      lastPacketsLost: null,
      lastFramesDecoded: null,
      iceRestartAttempted: false,
      profileChanges: [],

      observe(stats) {
        const packetsLostDelta = this.lastPacketsLost == null
          ? Number(stats.packetsLost || 0)
          : Math.max(0, Number(stats.packetsLost || 0) - this.lastPacketsLost);
        const decodedDelta = this.lastFramesDecoded == null
          ? Number(stats.framesDecoded || 0)
          : Math.max(0, Number(stats.framesDecoded || 0) - this.lastFramesDecoded);

        this.lastPacketsLost = Number(stats.packetsLost || 0);
        this.lastFramesDecoded = Number(stats.framesDecoded || 0);

        const hasSelectedPair = Boolean(stats.selectedCandidateType);
        const zeroFps = Number(stats.fps || 0) === 0;
        const highRtt = Number(stats.rttMs || 0) >= 120;
        const veryHighRtt = Number(stats.rttMs || 0) >= 300;
        const highJitter = Number(stats.jitterBufferMs || 0) >= 150;
        const highLoss = packetsLostDelta >= 20;
        const mediaStalled = hasSelectedPair && zeroFps && decodedDelta === 0;

        const reason = highLoss ? 'packet-loss'
          : veryHighRtt || highRtt ? 'high-rtt'
          : highJitter ? 'jitter'
          : mediaStalled ? 'media-stalled'
          : 'quality';

        if (!hasSelectedPair) {
          this.degradedCount = 0;
          this.criticalCount = 0;
          return { action: 'hold', profile: this.currentProfile, reason: 'no-selected-pair' };
        }

        if (mediaStalled || veryHighRtt) {
          this.criticalCount += 1;
        } else {
          this.criticalCount = 0;
        }

        if (zeroFps || highRtt || highJitter || highLoss) {
          this.degradedCount += 1;
        } else {
          this.degradedCount = 0;
          return { action: 'hold', profile: this.currentProfile, reason: 'good' };
        }

        if (this.criticalCount >= 2) {
          return this.setProfile('survival', reason, {
            action: 'critical',
            shouldRestartIce: !this.iceRestartAttempted,
          });
        }

        if (this.degradedCount >= 2) {
          const currentIndex = order.indexOf(this.currentProfile);
          const nextProfile = order[Math.min(order.length - 1, currentIndex + 1)];
          if (nextProfile !== this.currentProfile) {
            return this.setProfile(nextProfile, reason, { action: 'degrade' });
          }
        }

        return { action: 'hold', profile: this.currentProfile, reason };
      },

      markIceRestartAttempted() {
        this.iceRestartAttempted = true;
      },

      setProfile(profile, reason, extra = {}) {
        const from = this.currentProfile;
        this.currentProfile = profile;
        if (from !== profile) {
          this.profileChanges.push({
            at: Date.now(),
            from,
            to: profile,
            reason,
          });
        }
        return {
          action: extra.action || 'degrade',
          profile,
          from,
          reason,
          profileConfig: LinkQualityController.profiles[profile],
          shouldRestartIce: Boolean(extra.shouldRestartIce),
        };
      },

      snapshot() {
        return {
          enabled: true,
          currentProfile: this.currentProfile,
          profileChanges: this.profileChanges.slice(-10),
          iceRestart: {
            proactiveAttempted: this.iceRestartAttempted,
            attempts: this.iceRestartAttempted ? 1 : 0,
          },
        };
      },
    };
  },
};

if (typeof module !== 'undefined') {
  module.exports = { LinkQualityController };
}
```

Modify `web-client/viewer.html` to load the new script before `webrtc.js`:

```html
<script src="js/link-quality-controller.js"></script>
```

- [ ] **Step 4: Re-run the tests**

Run:

```bash
node --test web-client/js/webrtc.test.js
```

Expected: PASS for the new controller tests and existing WebRTC tests.

- [ ] **Step 5: Commit**

```bash
git add web-client/js/link-quality-controller.js web-client/viewer.html web-client/js/webrtc.test.js
git commit -m "feat: add strict stun link quality controller"
```

---

### Task 2: Viewer Adaptive Degradation and Strict Recovery

**Files:**
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/js/webrtc.test.js`

- [ ] **Step 1: Write failing WebRTC integration tests**

Add tests to `web-client/js/webrtc.test.js`:

```js
test('WebRTC applies degraded media profile without starting tunnel in auto mode', () => {
  const emitted = [];
  const { WebRTC } = loadWebRTC({
    LinkQualityController: {
      create() {
        return {
          observe() {
            return {
              action: 'degrade',
              profile: 'medium',
              reason: 'packet-loss',
              profileConfig: { name: 'medium', width: 960, height: 540, fps: 15, bitrateKbps: 1400 },
            };
          },
          snapshot() { return { currentProfile: 'medium', profileChanges: [] }; },
        };
      },
    },
  });

  WebRTC.networkMode = 'auto';
  WebRTC.socket = { connected: true, emit(event, payload) { emitted.push({ event, payload }); } };
  let tunnelStarted = false;
  WebRTC.startTunnelRelay = () => { tunnelStarted = true; };
  WebRTC.requestResolution = () => {};
  WebRTC.ensureLinkQualityController();

  WebRTC.handleReceiverStats({
    fps: 4,
    rttMs: 140,
    jitterBufferMs: 180,
    packetsLost: 80,
    framesDecoded: 130,
    framesReceived: 130,
    bytesReceived: 1000,
    codec: 'video/H264',
    selectedCandidateType: 'prflx',
  });

  assert.equal(tunnelStarted, false);
  assert.equal(emitted.some((entry) => entry.event === 'media-profile-change'), true);
  assert.equal(emitted.find((entry) => entry.event === 'media-profile-change').payload.profile, 'medium');
});

test('WebRTC proactive ICE restart happens once on critical media quality', () => {
  const { WebRTC } = loadWebRTC({
    LinkQualityController: {
      create() {
        return {
          markIceRestartAttemptedCalled: false,
          observe() {
            return {
              action: 'critical',
              profile: 'survival',
              reason: 'media-stalled',
              shouldRestartIce: true,
              profileConfig: { name: 'survival', width: 640, height: 360, fps: 8, bitrateKbps: 500 },
            };
          },
          markIceRestartAttempted() { this.markIceRestartAttemptedCalled = true; },
          snapshot() { return { currentProfile: 'survival', iceRestart: { attempts: 1 } }; },
        };
      },
    },
  });

  let restartCalls = 0;
  WebRTC.networkMode = 'stun';
  WebRTC.socket = { connected: true, emit() {} };
  WebRTC.pc = {
    restartIce() { restartCalls += 1; },
    connectionState: 'connected',
    iceConnectionState: 'connected',
  };
  WebRTC.createOffer = () => {};
  WebRTC.requestResolution = () => {};
  WebRTC.ensureLinkQualityController();

  WebRTC.handleReceiverStats({
    fps: 0,
    rttMs: 90,
    jitterBufferMs: 270,
    packetsLost: 10,
    framesDecoded: 199,
    framesReceived: 199,
    selectedCandidateType: 'prflx',
  });
  WebRTC.handleReceiverStats({
    fps: 0,
    rttMs: 90,
    jitterBufferMs: 270,
    packetsLost: 10,
    framesDecoded: 199,
    framesReceived: 199,
    selectedCandidateType: 'prflx',
  });

  assert.equal(restartCalls, 1);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
node --test web-client/js/webrtc.test.js
```

Expected: FAIL because `ensureLinkQualityController()` and `handleReceiverStats()` do not exist.

- [ ] **Step 3: Implement WebRTC adaptive hooks**

Add these properties to `WebRTC` in `web-client/js/webrtc.js`:

```js
linkQualityController: null,
adaptiveMediaEnabled: true,
```

Add methods:

```js
ensureLinkQualityController() {
  if (!this.linkQualityController && typeof LinkQualityController !== 'undefined') {
    this.linkQualityController = LinkQualityController.create();
  }
  return this.linkQualityController;
},

handleReceiverStats(stats) {
  const controller = this.ensureLinkQualityController();
  if (!controller || !this.adaptiveMediaEnabled) return;
  if (this.networkMode === 'tunnel' || this.networkMode === 'relay') return;

  const result = controller.observe({
    ...stats,
    selectedCandidatePair: this.selectedCandidatePair,
  });
  if (!result || result.action === 'hold') return;

  if (result.profileConfig) {
    this.applyMediaProfile(result.profileConfig, result.reason);
  }

  if (result.shouldRestartIce) {
    this.proactiveIceRestart(result.reason);
  }
},

applyMediaProfile(profile, reason) {
  console.warn(`[MEDIA] applying profile ${profile.name} size=${profile.width}x${profile.height} fps=${profile.fps} bitrate=${profile.bitrateKbps}kbps reason=${reason}`);
  this.currentResolution = { width: profile.width, height: profile.height, label: `${profile.width}x${profile.height}` };
  if (this.socket && this.socket.connected) {
    this.socket.emit('media-profile-change', {
      profile: profile.name,
      width: profile.width,
      height: profile.height,
      targetFps: profile.fps,
      videoBitrateKbps: profile.bitrateKbps,
      reason,
      mediaPolicy: 'strict-stun',
    });
  }
  if (typeof ConnectionTrace !== 'undefined' && ConnectionTrace.record) {
    ConnectionTrace.record('media-profile-change', { profile: profile.name, reason });
  }
},

proactiveIceRestart(reason) {
  if (!this.pc || typeof this.pc.restartIce !== 'function') return;
  if (this._iceRestartAttempts >= 1) return;
  this._iceRestartAttempts += 1;
  if (this.linkQualityController?.markIceRestartAttempted) {
    this.linkQualityController.markIceRestartAttempted();
  }
  console.warn(`[RECOVERY] proactive ICE restart reason=${reason}`);
  if (typeof ConnectionTrace !== 'undefined' && ConnectionTrace.record) {
    ConnectionTrace.record('ice-restart', { reason, proactive: true });
  }
  this.pc.restartIce();
  this.createOffer();
},
```

Inside `startStats()`, after computing the receiver stats and before emitting `viewer-stats`, call:

```js
this.handleReceiverStats({
  fps,
  rttMs: latencyMs,
  jitterBufferMs: Number(jitterBufferDelay) || 0,
  framesReceived,
  framesDecoded,
  packetsLost,
  bytesReceived,
  codec,
  selectedCandidateType,
});
```

Update `scheduleReconnect()` so `auto` / `stun` no longer call `startTunnelRelay()` automatically when strict policy is active. Replace the auto fallback branches with terminal failure UI/logging:

```js
if ((this.networkMode === 'auto' || this.networkMode === 'stun') && this._autoFailCount >= 2) {
  console.warn('[RECOVERY] strict-stun exhausted, not using tunnel');
  this.updateNetworkUI('Strict STUN 直连失败，未自动切换 TURN 或媒体隧道。', 'danger');
  updateLoadingText('直连失败，诊断日志已发送。');
  if (typeof Diagnostic !== 'undefined' && Diagnostic.autoSendFailure) {
    Diagnostic.autoSendFailure('strict-stun-exhausted');
  }
  return;
}
```

- [ ] **Step 4: Re-run WebRTC tests**

Run:

```bash
node --test web-client/js/webrtc.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web-client/js/webrtc.js web-client/js/webrtc.test.js
git commit -m "feat: adapt media quality before stun failure"
```

---

### Task 3: Diagnostic Payload Includes Adaptive Media Summary

**Files:**
- Modify: `web-client/js/diagnostic.js`
- Modify: `web-client/js/diagnostic.test.js`

- [ ] **Step 1: Write failing diagnostic test**

Add to `web-client/js/diagnostic.test.js`:

```js
test('buildConnectionDiagnostic includes adaptive media summary from WebRTC', () => {
  const { context } = createDiagnosticContext();
  context.WebRTC.linkQualityController = {
    snapshot() {
      return {
        enabled: true,
        currentProfile: 'survival',
        profileChanges: [{ from: 'high', to: 'medium', reason: 'packet-loss' }],
        iceRestart: { proactiveAttempted: true, attempts: 1, reason: 'critical-media-quality' },
      };
    },
  };
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');

  const payload = Diagnostic.buildConnectionDiagnostic({ trigger: 'auto-failure', reason: 'strict-stun-exhausted' });

  assert.equal(payload.adaptiveMedia.enabled, true);
  assert.equal(payload.adaptiveMedia.currentProfile, 'survival');
  assert.equal(payload.adaptiveMedia.profileChanges.length, 1);
  assert.equal(payload.adaptiveMedia.iceRestart.attempts, 1);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
node --test web-client/js/diagnostic.test.js
```

Expected: FAIL because `adaptiveMedia` is not added.

- [ ] **Step 3: Implement adaptive media payload**

In `Diagnostic.buildConnectionDiagnostic()`, after building the base payload, add:

```js
const adaptiveMedia = (typeof WebRTC !== 'undefined'
  && WebRTC.linkQualityController
  && typeof WebRTC.linkQualityController.snapshot === 'function')
  ? WebRTC.linkQualityController.snapshot()
  : { enabled: false };

payload.adaptiveMedia = adaptiveMedia;
```

Keep the field summary-only: no raw SDP, no endpoints, no input data.

- [ ] **Step 4: Re-run diagnostic tests**

Run:

```bash
node --test web-client/js/diagnostic.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web-client/js/diagnostic.js web-client/js/diagnostic.test.js
git commit -m "feat: include adaptive media diagnostics"
```

---

### Task 4: Signal Server Media Profile Relay

**Files:**
- Modify: `signal-server/websocket/signaling.js`
- Modify: `signal-server/websocket/signaling.test.js`

- [ ] **Step 1: Write failing signaling tests**

Add tests to `signal-server/websocket/signaling.test.js`:

```js
test('viewer media-profile-change is sanitized and forwarded to host', () => {
  const { sockets, hostSocket, viewerSocket } = setupSignalingHarness();
  hostSocket.trigger('register', { role: 'host' });
  viewerSocket.trigger('register', { role: 'viewer' });

  viewerSocket.trigger('media-profile-change', {
    profile: 'medium',
    width: 960,
    height: 540,
    targetFps: 15,
    videoBitrateKbps: 1400,
    reason: 'packet-loss',
    extra: 'drop-me',
  });

  const event = hostSocket.emitted.find((entry) => entry.event === 'media-profile-change');
  assert.equal(event.payload.profile, 'medium');
  assert.equal(event.payload.width, 960);
  assert.equal(event.payload.height, 540);
  assert.equal(event.payload.targetFps, 15);
  assert.equal(event.payload.videoBitrateKbps, 1400);
  assert.equal(event.payload.extra, undefined);
});

test('non-viewer media-profile-change is ignored', () => {
  const { hostSocket } = setupSignalingHarness();
  hostSocket.trigger('register', { role: 'host' });
  hostSocket.trigger('media-profile-change', { profile: 'survival' });
  assert.equal(hostSocket.emitted.some((entry) => entry.event === 'media-profile-change'), false);
});
```

Use the existing harness helpers in the test file. If names differ, adapt to the current helper names rather than creating a second harness.

- [ ] **Step 2: Run signaling tests and verify they fail**

Run:

```bash
node --test signal-server/websocket/signaling.test.js
```

Expected: FAIL because the event is not relayed.

- [ ] **Step 3: Implement sanitized relay**

In `signal-server/websocket/signaling.js`, add a viewer-only handler:

```js
socket.on('media-profile-change', (payload = {}) => {
  if (role !== 'viewer') {
    return;
  }
  const allowedProfiles = new Set(['high', 'medium', 'low', 'survival']);
  const profile = allowedProfiles.has(payload.profile) ? payload.profile : 'medium';
  const sanitized = {
    viewerId: socket.id,
    profile,
    width: clampInt(payload.width, 320, 1920, 960),
    height: clampInt(payload.height, 180, 1080, 540),
    targetFps: clampInt(payload.targetFps, 5, 30, 15),
    videoBitrateKbps: clampInt(payload.videoBitrateKbps, 250, 5000, 1400),
    reason: String(payload.reason || 'quality').slice(0, 80),
    mediaPolicy: payload.mediaPolicy === 'strict-stun' ? 'strict-stun' : 'unknown',
  };
  if (hostSocketId && io.sockets.sockets.get(hostSocketId)) {
    io.to(hostSocketId).emit('media-profile-change', sanitized);
  }
});
```

Add a small local helper in the same module:

```js
function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
```

- [ ] **Step 4: Re-run signaling tests**

Run:

```bash
node --test signal-server/websocket/signaling.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add signal-server/websocket/signaling.js signal-server/websocket/signaling.test.js
git commit -m "feat: relay adaptive media profile changes"
```

---

### Task 5: Host Applies Media Profiles

**Files:**
- Modify: `python-host/host.py`
- Create: `python-host/test_media_profile.py`

- [ ] **Step 1: Write failing Host tests**

Create `python-host/test_media_profile.py`:

```python
import logging

from host import WebRemoteHost


class ListHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        self.records.append(record)


def test_media_profile_change_updates_host_state_and_logs():
    host = object.__new__(WebRemoteHost)
    host.media_profile = {"profile": "high", "width": 1280, "height": 720, "target_fps": 20, "video_bitrate_kbps": 2500}
    host.screen_track = None

    handler = ListHandler()
    logger = logging.getLogger("host")
    original_level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

    try:
        host.on_media_profile_change({
            "viewerId": "viewer-1",
            "profile": "low",
            "width": 854,
            "height": 480,
            "targetFps": 12,
            "videoBitrateKbps": 900,
            "reason": "packet-loss",
        })
    finally:
        logger.removeHandler(handler)
        logger.setLevel(original_level)

    assert host.media_profile["profile"] == "low"
    assert host.media_profile["width"] == 854
    assert host.media_profile["height"] == 480
    assert host.media_profile["target_fps"] == 12
    assert host.media_profile["video_bitrate_kbps"] == 900
    assert any("WRD_MEDIA_PROFILE viewer=viewer-1 profile=low" in record.getMessage() for record in handler.records)


def test_invalid_media_profile_is_clamped():
    host = object.__new__(WebRemoteHost)
    host.media_profile = {"profile": "high", "width": 1280, "height": 720, "target_fps": 20, "video_bitrate_kbps": 2500}
    host.screen_track = None

    host.on_media_profile_change({
        "viewerId": "viewer-1",
        "profile": "invalid",
        "width": 99999,
        "height": 1,
        "targetFps": 99,
        "videoBitrateKbps": 99999,
        "reason": "bad",
    })

    assert host.media_profile["profile"] == "medium"
    assert host.media_profile["width"] == 1920
    assert host.media_profile["height"] == 180
    assert host.media_profile["target_fps"] == 30
    assert host.media_profile["video_bitrate_kbps"] == 5000
```

- [ ] **Step 2: Run Host tests and verify they fail**

Run:

```bash
PYTHONPATH=python-host python -m pytest -q python-host/test_media_profile.py
```

Expected: FAIL because `on_media_profile_change()` does not exist.

- [ ] **Step 3: Implement Host profile application**

In `python-host/host.py`, add helpers near existing config helpers:

```python
MEDIA_PROFILE_DEFAULT = {
    "profile": "high",
    "width": 1280,
    "height": 720,
    "target_fps": 20,
    "video_bitrate_kbps": 2500,
}


def clamp_int(value, minimum, maximum, fallback):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, parsed))
```

Initialize in `WebRemoteHost.__init__`:

```python
self.media_profile = dict(MEDIA_PROFILE_DEFAULT)
```

Register the Socket.IO handler after other handlers:

```python
self.sio.on('media-profile-change', self.on_media_profile_change)
```

Add method:

```python
def on_media_profile_change(self, data):
    allowed_profiles = {"high", "medium", "low", "survival"}
    profile = data.get("profile") if data.get("profile") in allowed_profiles else "medium"
    next_profile = {
        "profile": profile,
        "width": clamp_int(data.get("width"), 320, 1920, 960),
        "height": clamp_int(data.get("height"), 180, 1080, 540),
        "target_fps": clamp_int(data.get("targetFps"), 5, 30, 15),
        "video_bitrate_kbps": clamp_int(data.get("videoBitrateKbps"), 250, 5000, 1400),
    }
    self.media_profile = next_profile
    viewer_id = data.get("viewerId", "-")
    reason = str(data.get("reason", "quality"))[:80]
    logger.info(
        "WRD_MEDIA_PROFILE viewer=%s profile=%s size=%sx%s fps=%s bitrate_kbps=%s reason=%s",
        viewer_id,
        next_profile["profile"],
        next_profile["width"],
        next_profile["height"],
        next_profile["target_fps"],
        next_profile["video_bitrate_kbps"],
        reason,
    )
    if self.screen_track and hasattr(self.screen_track, "apply_media_profile"):
        self.screen_track.apply_media_profile(next_profile)
```

When creating `ScreenCaptureTrack`, use the current profile:

```python
self.screen_track = ScreenCaptureTrack(
    monitor=self.monitor,
    target_fps=self.media_profile["target_fps"],
    max_width=self.media_profile["width"],
    max_height=self.media_profile["height"],
    video_bitrate_kbps=self.media_profile["video_bitrate_kbps"],
)
```

If constructor names differ, adapt to existing `ScreenCaptureTrack.__init__` arguments and add `video_bitrate_kbps` only if the class supports it.

- [ ] **Step 4: Re-run Host tests**

Run:

```bash
PYTHONPATH=python-host python -m pytest -q python-host/test_media_profile.py python-host/test_connection_diagnostics.py
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add python-host/host.py python-host/test_media_profile.py
git commit -m "feat: apply adaptive media profiles on host"
```

---

### Task 6: Documentation and Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/runbook-safe-startup.md`
- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md`

- [ ] **Step 1: Update docs**

Add a section to `README.md` under WebRTC failure guidance:

```markdown
### Strict STUN 自适应优化

`auto` / `stun` 模式会在直连媒体链路恶化时先自动降载：720p/20fps -> 540p/15fps -> 480p/12fps -> 360p/8fps。若连续 0 FPS、丢包或 RTT/Jitter 异常仍未恢复，Viewer 会主动尝试一次 ICE restart。

该优化不会自动切 TURN，也不会自动走 Cloudflare/Socket.IO 媒体 tunnel。恢复预算耗尽后页面会明确显示 Strict STUN 失败，并自动发送诊断日志。
```

Add a TP-LINK/端口转发 note:

```markdown
家庭路由器“虚拟服务器/端口转发”只有在 Host 侧 WebRTC UDP 端口范围可控时才有稳定意义。当前 aiortc/aioice 默认随机绑定本地 UDP 端口，`RTCConfiguration` 不提供标准端口范围字段，因此不能只填一个端口就保证 Strict STUN 可达。后续如引入 `WRD_ICE_UDP_PORT_RANGE`，才适合配合路由器转发固定 UDP 范围。
```

Update `docs/runbook-safe-startup.md` to say quick tunnel reachability does not prove media reachability, and Strict STUN failures should be diagnosed through adaptive media logs.

Update `docs/需求文档/WebRemoteDesktop-需求文档.md` to add adaptive degradation and proactive ICE restart as product behavior.

- [ ] **Step 2: Run full targeted verification**

Run:

```bash
node --test web-client/js/webrtc.test.js web-client/js/diagnostic.test.js
node --test signal-server/websocket/signaling.test.js
PYTHONPATH=python-host python -m pytest -q python-host/test_media_profile.py python-host/test_connection_diagnostics.py
```

Expected: all targeted tests PASS.

- [ ] **Step 3: Check git diff**

Run:

```bash
git diff --stat
git status --short
```

Expected: only files from this plan are modified, aside from pre-existing dirty terminal files if still present.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/runbook-safe-startup.md docs/需求文档/WebRemoteDesktop-需求文档.md
git commit -m "docs: document strict stun resilience behavior"
```

---

## Self-Review

Spec coverage:

1. 提前降载：Task 1, Task 2, Task 5, Task 6.
2. 更聪明的 ICE 恢复：Task 2, Task 3.
3. 家庭侧可达性优化和端口范围事实边界：Task 6.
4. 不自动 TURN/tunnel：Task 2 tests and docs.
5. 日志/诊断完善：Task 3, Task 5.

No placeholders remain. Function names are introduced before later tasks use them: `LinkQualityController.create`, `WebRTC.handleReceiverStats`, `WebRTC.applyMediaProfile`, `WebRTC.proactiveIceRestart`, `WebRemoteHost.on_media_profile_change`.
