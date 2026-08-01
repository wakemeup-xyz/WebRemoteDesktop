# TURN Relay 重连稳定性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 relay 模式下 media-resume 1.5s refresh 死循环与 DC 误杀，并使 Host 在 `mode=relay` 时只使用 TURN relay 候选，让外网中继可稳定建连与保活。

**Architecture:** Viewer 在 `webrtc.js` 内聚 ResumeRecovery（arm 时机、soft/hard 预算、跨 fresh-frame refresh 继承 flag）与 LinkRecovery（DC/视频解耦、指数退避、relay 熔断）；Host 用纯函数过滤 ICE/SDP，并在 `build_ice_servers('relay')` 去掉 STUN。不改 coturn、不改 lease/port-search 真相源。

**Tech Stack:** 浏览器 WebRTC（vanilla JS）、Node test runner、Python 3.11、aiortc/aioice、pytest。

**Spec:** `docs/superpowers/specs/2026-08-01-turn-relay-reconnect-stability-design.md`

**Truth Source:**
- 媒体 desired/phase：`MediaActivityController` + `MediaActivityRuntime`
- 网络模式：Viewer `networkMode` / Host offer `networkMode`
- TURN 配置：既有 `TURN_*` / `turn.json`（本 plan 不改加载器）

**Compatibility:**
- Strict STUN 不自动切 TURN
- tunnel fresh-frame 仍不换 `connectionAttemptId`
- 无 TURN 时 relay 仍不可用（既有行为）

**Definition of Done:**
- 相关单测 GREEN
- relay 下第 1 次 fresh-frame 超时不 `refresh()`；因 fresh-frame 的 hard refresh 不会重置预算导致套娃
- `dc-error` + 视频健康不 full reconnect
- Host relay answer/candidate 无 host/srflx
- 运行：5 分钟无 ~2s offer 风暴（用户启服务后验证）

---

## File Structure

| 文件 | 责任 |
|------|------|
| `python-host/host.py` | `build_ice_servers`、ICE/SDP 过滤、on_icecandidate/answer 挂载 |
| `python-host/test_ice_relay_filter.py` | Host 纯函数单测（新） |
| `web-client/js/webrtc.js` | ResumeRecovery、DC 策略、backoff、refresh reason |
| `web-client/js/webrtc.test.js` | Viewer 不变量；改写过时 fresh-frame 契约 |

---

### Task 1: Host ICE relay 过滤纯函数 + 单测

**Files:**
- Create: `python-host/test_ice_relay_filter.py`
- Modify: `python-host/host.py`（在 `parse_ice_candidate` 附近新增纯函数；调整 `build_ice_servers`）

- [ ] **Step 1: 写失败单测**

```python
# python-host/test_ice_relay_filter.py
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from host import (
    build_ice_servers,
    filter_sdp_ice_candidates,
    should_emit_ice_candidate,
)


HOST_LINE = "candidate:1 1 udp 2122260223 192.168.0.106 54321 typ host"
SRFLX_LINE = "candidate:2 1 udp 1686052607 120.229.11.141 12345 typ srflx raddr 192.168.0.106 rport 54321"
RELAY_LINE = "candidate:3 1 udp 41819902 144.225.130.238 60000 typ relay raddr 192.168.0.106 rport 54321"


def test_should_emit_relay_mode_keeps_only_relay():
    assert should_emit_ice_candidate("relay", HOST_LINE) is False
    assert should_emit_ice_candidate("relay", SRFLX_LINE) is False
    assert should_emit_ice_candidate("relay", RELAY_LINE) is True
    assert should_emit_ice_candidate("relay", "candidate:" + RELAY_LINE) is True


def test_should_emit_non_relay_mode_keeps_all():
    assert should_emit_ice_candidate("auto", HOST_LINE) is True
    assert should_emit_ice_candidate("stun", SRFLX_LINE) is True


def test_filter_sdp_ice_candidates_relay_drops_host_srflx():
    sdp = "\r\n".join(
        [
            "v=0",
            "a=group:BUNDLE 0",
            f"a={HOST_LINE}",
            f"a={SRFLX_LINE}",
            f"a={RELAY_LINE}",
            "a=end-of-candidates",
            "",
        ]
    )
    filtered = filter_sdp_ice_candidates("relay", sdp)
    assert "typ host" not in filtered
    assert "typ srflx" not in filtered
    assert "typ relay" in filtered
    assert "a=end-of-candidates" in filtered
    assert "a=group:BUNDLE 0" in filtered


def test_build_ice_servers_relay_omits_stun(monkeypatch):
    monkeypatch.setenv("STUN_URLS", "stun:stun.l.google.com:19302")
    monkeypatch.setenv("TURN_URLS", "turn:144.225.130.238:3478?transport=udp")
    monkeypatch.setenv("TURN_USERNAME", "u")
    monkeypatch.setenv("TURN_CREDENTIAL", "p")
    servers = build_ice_servers("relay")
    urls = []
    for server in servers:
        raw = server.urls if hasattr(server, "urls") else server.get("urls")
        if isinstance(raw, (list, tuple)):
            urls.extend(raw)
        else:
            urls.append(raw)
    joined = " ".join(str(u) for u in urls)
    assert "turn:" in joined
    assert "stun:" not in joined
    assert len(servers) == 1
```

同时在本 Task 更新既有断言（否则全量 pytest 会红）：

`python-host/test_connection_diagnostics.py::test_turn_env_is_included_for_relay_even_under_strict_stun`

```python
ice_servers = build_ice_servers("relay")
assert len(ice_servers) == 1  # TURN only; no STUN in relay mode
assert any("turn:" in repr(server) for server in ice_servers)
assert all("stun:" not in repr(server) for server in ice_servers)
```

- [ ] **Step 2: RED**

```bash
cd python-host && python -m pytest test_ice_relay_filter.py test_connection_diagnostics.py::test_turn_env_is_included_for_relay_even_under_strict_stun -v
```

Expected: FAIL（函数未定义或 `build_ice_servers` 仍含 stun / 旧 `len >= 2` 断言先改成新契约后会因仍返回 2 而 FAIL）

- [ ] **Step 3: 最小实现**

在 `host.py` 的 `parse_ice_candidate` 旁加入：

```python
def ice_candidate_type_from_sdp(candidate_sdp: str) -> str:
    text = str(candidate_sdp or "").strip()
    if text.startswith("candidate:"):
        text = text[len("candidate:"):]
    parts = text.split()
    if "typ" in parts:
        idx = parts.index("typ")
        if idx + 1 < len(parts):
            return str(parts[idx + 1]).lower()
    return ""


def should_emit_ice_candidate(mode, candidate_sdp: str) -> bool:
    normalized = normalize_network_mode(mode) or "auto"
    if normalized != "relay":
        return True
    return ice_candidate_type_from_sdp(candidate_sdp) == "relay"


def filter_sdp_ice_candidates(mode, sdp: str) -> str:
    normalized = normalize_network_mode(mode) or "auto"
    if normalized != "relay" or not sdp:
        return sdp
    lines = str(sdp).splitlines()
    kept = []
    for line in lines:
        if line.startswith("a=candidate:"):
            candidate = line[len("a="):]
            if not should_emit_ice_candidate(normalized, candidate):
                continue
        kept.append(line)
    # Preserve whether original ended with a trailing newline.
    body = "\r\n".join(kept)
    if str(sdp).endswith("\n"):
        return body + ("\r\n" if "\r\n" in str(sdp) else "\n")
    return body
```

修改 `build_ice_servers`：

```python
def build_ice_servers(mode="auto"):
    ice_servers = []
    normalized_mode = normalize_network_mode(mode) or "auto"
    stun_urls = split_env_list(
        os.environ.get("STUN_URLS", "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302")
    )
    # relay mode: TURN only — avoid host/srflx distraction (no iceTransportPolicy in aiortc).
    if stun_urls and normalized_mode != "relay":
        ice_servers.append(RTCIceServer(urls=stun_urls))
    # ... existing TURN include logic unchanged ...
```

- [ ] **Step 4: GREEN**

```bash
cd python-host && python -m pytest test_ice_relay_filter.py test_connection_diagnostics.py::test_turn_env_is_included_for_relay_even_under_strict_stun -v
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add python-host/host.py python-host/test_ice_relay_filter.py python-host/test_connection_diagnostics.py
git commit -m "$(cat <<'EOF'
fix(host): filter ICE to relay-only in relay mode helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Host 挂载候选/SDP 过滤到 offer 路径

**Files:**
- Modify: `python-host/host.py`（`on_offer` 内 `on_icecandidate`、发送 answer 前）

- [ ] **Step 1: 在创建 PC 时捕获 `network_mode` 供回调使用**

`on_offer` 已有：

```python
network_mode = data.get("networkMode") or data.get("iceMode") or "auto"
config = RTCConfiguration(iceServers=build_ice_servers(network_mode))
```

确保该 `network_mode` 闭包变量在 handlers 中可用（已在同一函数作用域即可）。

- [ ] **Step 2: 过滤 trickle**

```python
@self.pc.on("icecandidate")
async def on_icecandidate(candidate):
    if candidate and viewer_id:
        if not should_emit_ice_candidate(network_mode, candidate.sdp):
            logger.info(
                "WRD_POLICY_INFO ice_candidate_dropped mode=%s sdp=%s",
                normalize_network_mode(network_mode) or network_mode,
                (candidate.sdp or "")[:60],
            )
            return
        # existing emit ...
```

- [ ] **Step 3: 过滤 answer SDP**

在 `await asyncio.wait_for(ice_complete.wait()...)` 之后、`sio.emit('answer'...)` 之前：

```python
local_description = self.pc.localDescription or answer
answer_sdp = filter_sdp_ice_candidates(network_mode, local_description.sdp)
self._log_video_codecs("host-answer", answer_sdp)
self._log_ice_candidate_summary("host-answer", answer_sdp)
await self.sio.emit('answer', {
    'answer': {
        'type': local_description.type,
        'sdp': answer_sdp,
    },
    'viewerId': viewer_id,
})
```

若原路径在 setLocalDescription 后立即 `_log_video_codecs("host-answer", ...)`，改为只对**过滤后** SDP 记 candidate summary，避免日志仍显示 host/srflx。

- [ ] **Step 4: 回归相关 host 测试**

```bash
cd python-host && python -m pytest test_ice_relay_filter.py test_connection_diagnostics.py test_offer_epoch.py test_media_suspension.py -v --tb=short
```

Expected: PASS（无行为冲突）

- [ ] **Step 5: Commit**

```bash
git add python-host/host.py
git commit -m "$(cat <<'EOF'
fix(host): emit relay-only ICE in relay network mode

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Viewer — ResumeRecovery（arm 门闩 + soft/hard + flag 继承）

> Plan review 修正：原 Task 3/4 拆分会导致 Task 3 GREEN 时旧 fresh-frame 测试与尚未落地的 `onMediaResumeFrameTimeout` 冲突。本 Task **一次做完** arm + soft/hard + budget 继承，单次 GREEN。

**Files:**
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/js/webrtc.test.js`

- [ ] **Step 1: 写/改失败测试（同一提交批次）**

**A. 未 connected 不 arm；connected 后 arm 且 relay timeout=12000**

```js
test('media resume fallback does not arm before PC is connected on webrtc paths', () => {
  const timers = [];
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  global.setTimeout = (fn, ms) => {
    const handle = { fn, ms, cleared: false };
    timers.push(handle);
    return handle;
  };
  global.clearTimeout = (handle) => {
    if (handle && typeof handle === 'object') handle.cleared = true;
  };
  try {
    const { WebRTC, context } = loadWebRTC();
    const runtimeSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'media-activity-runtime.js'), 'utf8');
    require('node:vm').runInContext(runtimeSource, context);
    WebRTC.socket = { connected: true, emit() {}, on() {} };
    WebRTC.controlState = {
      state: 'ACTIVE', controller: true, hostOnline: true,
      lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
    };
    WebRTC.currentConnectionAttemptId = 'attempt-arm';
    WebRTC.networkMode = 'relay';
    WebRTC.pc = { connectionState: 'connecting', iceConnectionState: 'checking' };
    WebRTC.mediaActivityRuntime = context.MediaActivityRuntime.create({ requestTimeoutMs: 1500 });
    context.Input = { setActive() {}, resetKeyboard() {}, setControlLease() {} };

    WebRTC.applyMediaActivity({ state: 'active', reasons: [], generation: 1 });
    for (const timer of timers) timer.cleared = true;
    WebRTC.handleMediaActivityAck({
      state: 'active', generation: 1, connectionAttemptId: 'attempt-arm', applied: true,
    });
    assert.equal(WebRTC.getMediaAppliedPhase(), 'resuming');
    assert.equal(timers.filter((t) => !t.cleared).length, 0);
    assert.equal(WebRTC._mediaResumeArmPending, true);

    WebRTC.pc.connectionState = 'connected';
    WebRTC.pc.iceConnectionState = 'connected';
    WebRTC.ensureMediaResumeFallbackArmed('pc-connected');
    const live = timers.filter((t) => !t.cleared);
    assert.equal(live.length, 1);
    assert.equal(live[0].ms, 12000);
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});
```

**B. 改写** `fresh-frame fallback cancels prior timer and runs refresh only once`：

- PC 置 `connected`，mode=`relay`
- re-arm 只保留一个 timer
- 第 1 次 `fn()`：`refreshes === 0`，`_mediaResumeSoftRecoverUsed === true`
- 第 2 次 live timer `fn()`：`refreshes === 1`

**C. budget 继承（完整断言，非注释 stub）**

```js
test('fresh-frame hard refresh inherits resume budget and does not loop', () => {
  const { WebRTC, context } = loadWebRTC();
  const runtimeSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'media-activity-runtime.js'), 'utf8');
  require('node:vm').runInContext(runtimeSource, context);
  WebRTC.socket = { connected: true, emit() {}, on() {} };
  WebRTC.controlState = {
    state: 'ACTIVE', controller: true, hostOnline: true,
    lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 },
  };
  WebRTC.networkMode = 'relay';
  WebRTC.currentConnectionAttemptId = 'attempt-1';
  WebRTC._mediaResumeRefreshFallbackUsed = true;
  WebRTC._refreshReason = 'fresh-frame-timeout';
  WebRTC.beginConnectionAttempt('refresh');
  assert.equal(WebRTC._mediaResumeRefreshFallbackUsed, true);
  assert.notEqual(WebRTC.currentConnectionAttemptId, 'attempt-1');

  WebRTC._refreshReason = 'manual';
  WebRTC.beginConnectionAttempt('viewer-open');
  assert.equal(WebRTC._mediaResumeRefreshFallbackUsed, false);
});
```

- [ ] **Step 2: RED**

```bash
node --test web-client/js/webrtc.test.js
```

Expected: 上述新/改测试 FAIL

- [ ] **Step 3: 一次实现 ResumeRecovery**

对象字段：

```js
_mediaResumeArmPending: false,
_mediaResumeSoftRecoverUsed: false,
_refreshReason: null,
_reconnectAttempt: 0,
_relayHardRefreshCount: 0,
_inputDcDegraded: false,
```

`_relayHardRefreshCount` **只**在 `refresh({ reason: 'fresh-frame-timeout' })` 且 `networkMode==='relay'` 时 +1；`scheduleReconnect` 的熔断读同一计数（Task 6）。成功 `pc=connected` 时清零 soft/hard resume 标志与该计数。

常量与方法：

```js
const MEDIA_RESUME_FRAME_TIMEOUT_MS = {
  tunnel: 2500,
  relay: 12000,
  auto: 8000,
  stun: 8000,
  lan: 6000,
  default: 8000,
};
```

```js
isWebRtcMediaPathConnected() { /* connectionState connected || ice connected|completed */ },
mediaResumeTimeoutMs() { /* tunnel/relay/default map */ },
ensureMediaResumeFallbackArmed(reason = 'ack') { /* tunnel arm; else defer until connected */ },
armMediaResumeFallback() {
  this.clearMediaResumeFallback();
  if (this._mediaResumeRefreshFallbackUsed || this._mediaIntent?.state !== 'active') return;
  if (this.getMediaAppliedPhase() !== 'resuming') return;
  const timeoutMs = this.mediaResumeTimeoutMs();
  this._mediaResumeFrameTimer = setTimeout(() => {
    this._mediaResumeFrameTimer = null;
    this.onMediaResumeFrameTimeout();
  }, timeoutMs);
},
onMediaResumeFrameTimeout() {
  if (this.getMediaAppliedPhase() !== 'resuming' || this._mediaResumeRefreshFallbackUsed) return;
  if (this.networkMode === 'tunnel' || this.tunnelRelayActive) {
    this._mediaResumeRefreshFallbackUsed = true;
    this.recoverTunnelMediaOnCurrentAttempt('fresh-frame-timeout');
    return;
  }
  if (!this._mediaResumeSoftRecoverUsed) {
    this._mediaResumeSoftRecoverUsed = true;
    // Minimal soft action (no bare requestKeyframe API required):
    try {
      if (this.pc && typeof this.pc.restartIce === 'function' && this.isWebRtcMediaPathConnected()) {
        this.pc.restartIce();
      }
    } catch (err) { /* log */ }
    this.replayMediaActivityIntent('fresh-frame-soft');
    // Spec: must re-arm while still resuming so hard path can fire.
    this._mediaResumeArmPending = false;
    this.armMediaResumeFallback();
    return;
  }
  this._mediaResumeRefreshFallbackUsed = true;
  this.refresh({ reason: 'fresh-frame-timeout' });
},
```

`handleMediaActivityAck`：`ensureMediaResumeFallbackArmed('media-ack')`。  
`onconnectionstatechange` / ice connected：若 `_mediaResumeArmPending` 则 `ensureMediaResumeFallbackArmed`。  
`beginConnectionAttempt` / `refresh(options)`：按上文 inherit 语义（见原草案，`fresh-frame-timeout` 继承 hard flag）。

- [ ] **Step 4: GREEN**

```bash
node --test web-client/js/webrtc.test.js
```

Expected: 全文件 PASS（含 tunnel fresh-frame 保持不换 attempt）

- [ ] **Step 5: Commit**

```bash
git add web-client/js/webrtc.js web-client/js/webrtc.test.js
git commit -m "$(cat <<'EOF'
fix(viewer): gate and soft-then-hard media resume recovery on relay

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: （已合并入 Task 3 — 保留编号占位避免外链错乱）

本编号不再单独实施。后续 Task 5=原 DC 解耦，Task 6=原退避，Task 7=原回归。

---

### Task 5: Viewer — DC 与视频健康解耦

> `isInboundVideoHealthy`：仅当 **framesDecoded 较上次采样发生增长** 时更新 `_lastInboundFramesDecodedAt`；stats 滴答但帧数未增不刷新时间戳。无采样或过期 → **不健康**（未知 ≠ healthy），避免冻屏仍抑制 DC 恢复。

**Files:**
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/js/webrtc.test.js`

- [ ] **Step 1: 测试**

```js
test('dc-error does not schedule full reconnect when inbound video is healthy', () => {
  const { WebRTC } = loadWebRTC();
  WebRTC.manualDisconnect = false;
  WebRTC._refreshing = false;
  WebRTC.reconnectTimer = null;
  WebRTC.pc = { connectionState: 'connected', iceConnectionState: 'connected' };
  WebRTC._lastInboundFramesDecoded = 10;
  WebRTC._lastInboundFramesDecodedAt = Date.now();
  let scheduled = 0;
  const original = WebRTC.scheduleReconnect.bind(WebRTC);
  WebRTC.scheduleReconnect = (reason) => { scheduled += 1; return original(reason); };
  // invoke the same policy helper used by inputChannel.onerror
  assert.equal(WebRTC.shouldReconnectForDataChannelFault('dc-error'), false);
  WebRTC.noteDataChannelFault('dc-error');
  assert.equal(scheduled, 0);
  assert.equal(WebRTC._inputDcDegraded, true);
});
```

- [ ] **Step 2: 实现**

在 stats 更新 `_lastInboundFramesDecoded` 处同时：

```js
this._lastInboundFramesDecodedAt = Date.now();
```

```js
isInboundVideoHealthy(maxAgeMs = 5000) {
  const at = Number(this._lastInboundFramesDecodedAt) || 0;
  const frames = Number(this._lastInboundFramesDecoded) || 0;
  if (frames <= 0 || !at) return false;
  return (Date.now() - at) <= maxAgeMs;
},

shouldReconnectForDataChannelFault(reason) {
  if (this.manualDisconnect || this._refreshing) return false;
  if (this.pc && this.pc.connectionState === 'connected' && this.isInboundVideoHealthy()) {
    return false;
  }
  return true;
},

noteDataChannelFault(reason) {
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

`inputChannel.onerror` / `onclose` 延迟回调改为调用 `noteDataChannelFault('dc-error'|'dc-closed')`，不再无条件 `scheduleReconnect`。

`dc-stuck` 在 pc connected + healthy 时同样 skip。

- [ ] **Step 3: GREEN + Commit**

```bash
node --test web-client/js/webrtc.test.js
git add web-client/js/webrtc.js web-client/js/webrtc.test.js
git commit -m "$(cat <<'EOF'
fix(viewer): keep media up when input datachannel fails but video is healthy

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Viewer — reconnect 退避与 relay 熔断

**Files:**
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/js/webrtc.test.js`

- [ ] **Step 1: 测试**

```js
test('scheduleReconnect uses exponential backoff and exhausts relay hard refreshes', () => {
  const timers = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => {
    const handle = { fn, ms, cleared: false };
    timers.push(handle);
    return handle;
  };
  try {
    const { WebRTC } = loadWebRTC();
    WebRTC.manualDisconnect = false;
    WebRTC.networkMode = 'relay';
    WebRTC.socket = { connected: true };
    WebRTC.pc = null;
    WebRTC._iceRestartAttempts = 99; // force full refresh path
    WebRTC.hasTurnConfigured = () => true;
    WebRTC.getTurnServers = () => [{ urls: 'turn:example' }];
    WebRTC.refresh = () => {};
    WebRTC.isPortSearchActive = () => false;
    WebRTC.isMediaHealthSuppressed = () => false;
    WebRTC._relayHardRefreshCount = 0;

    WebRTC.scheduleReconnect('pc-failed');
    assert.equal(timers.at(-1).ms, 1500);
    WebRTC.reconnectTimer = null;
    WebRTC.scheduleReconnect('pc-failed');
    assert.equal(timers.at(-1).ms, 3000);

    WebRTC.reconnectTimer = null;
    WebRTC._relayHardRefreshCount = 5;
    const before = timers.length;
    WebRTC.scheduleReconnect('pc-failed');
    assert.equal(timers.length, before); // exhausted: no new timer
  } finally {
    global.setTimeout = realSetTimeout;
  }
});
```

- [ ] **Step 2: 实现 `scheduleReconnect` 尾部**

在通过分类/门闩后、创建 timer 前：

```js
if (this.networkMode === 'relay' && (Number(this._relayHardRefreshCount) || 0) >= 5) {
  console.warn('[RECOVERY] relay-reconnect-exhausted');
  if (typeof Diagnostic !== 'undefined' && typeof Diagnostic.autoSendFailure === 'function') {
    Diagnostic.autoSendFailure('relay-reconnect-exhausted');
  }
  this.updateNetworkUI('外网中继多次重连失败，请手动刷新或切换隧道中继。', 'danger');
  updateLoadingText('中继重连已停止，请手动重试');
  document.getElementById('loading')?.classList.remove('hidden');
  return;
}

const attempt = Number(this._reconnectAttempt) || 0;
const delay = Math.min(1500 * (2 ** attempt), 15000);
this._reconnectAttempt = attempt + 1;
console.warn('[RECOVERY] Scheduling WebRTC reconnect after %s in %sms', reason, delay);
// ... existing Diagnostic.autoSendFailure ...
this.reconnectTimer = setTimeout(() => {
  this.reconnectTimer = null;
  // existing guards ...
  this.refresh({ reason: `reconnect:${reason}` });
}, delay);
```

注意：既有函数前半段已有 `console.warn` 与 1500ms timer；替换为上述逻辑，避免双 timer。ICE restart 短路径可保持 1500ms 一次机会，不增加 `_reconnectAttempt` 或按 spec 轻触。

- [ ] **Step 3: GREEN + Commit**

```bash
node --test web-client/js/webrtc.test.js
git add web-client/js/webrtc.js web-client/js/webrtc.test.js
git commit -m "$(cat <<'EOF'
fix(viewer): exponential reconnect backoff and relay exhaust brake

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 全量相关回归 + 文档锚点

**Files:**
- Modify (optional short note): `docs/project-memory.md` 或 `docs/runbook-safe-startup.md` 增加 5–10 行 relay 验收要点
- 不改凭据文件

- [ ] **Step 1: 跑测试矩阵**

```bash
node --test web-client/js/webrtc.test.js
cd python-host && python -m pytest test_ice_relay_filter.py test_connection_diagnostics.py test_offer_epoch.py test_media_suspension.py -v --tb=short
```

Expected: all PASS

- [ ] **Step 2: 运行验收清单写入 plan 末尾 worklog 或 `docs/superpowers/reports/`（若用户已启服务）**

清单：

1. 手动模式「外网中继」
2. 观察 5 分钟 Host `Received offer` 频率（不应再 ~2s 一次）
3. `WRD_CANDIDATE_SUMMARY side=host-answer` 无 host/srflx
4. 有 `ICE connection: completed` 与持续采集日志

Agent **不**擅自重启 Host/tunnel；需要时请用户按 `README.md` + `docs/runbook-safe-startup.md` 操作。

- [ ] **Step 3: Commit docs（若有）**

```bash
git add docs/superpowers/specs/2026-08-01-turn-relay-reconnect-stability-design.md \
  docs/superpowers/plans/2026-08-01-turn-relay-reconnect-stability-plan.md \
  docs/project-memory.md  # if touched
git commit -m "$(cat <<'EOF'
docs(remote): add TURN relay reconnect stability spec and plan

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

（若 design/plan 已在更早单独提交，本步只补 runbook/memory。）

---

## Self-Review (author)

| Spec 要求 | Task |
|-----------|------|
| Arm 仅 connected 后 | Task 3 |
| relay 12s / soft then hard / re-arm | Task 3 |
| fresh-frame refresh 继承 budget | Task 3 |
| DC + healthy video 不 refresh | Task 5 |
| backoff + relay exhaust | Task 6 |
| Host TURN-only servers + relay candidates | Task 1–2 |
| 更新 `test_connection_diagnostics` relay 断言 | Task 1 |
| 单测 + 运行验收 | Task 1–7 |
| Non-goal: coturn / auto STUN→TURN | 无任务越界 |

**Plan review fixes applied:** Task 3+4 合并为可 GREEN 的单任务；补 `test_connection_diagnostics`；inherit 测试具体化；video healthy 仅 frames 增长时刷新时间戳。  
**Placeholder scan:** 无 TBD。  
**类型一致性:** `refresh({ reason })`、`_refreshReason`、`ensureMediaResumeFallbackArmed`、`should_emit_ice_candidate` 命名前后一致。

---

## Execution

实施时使用 **subagent-driven-development**：每 Task 一个实现 subagent → spec 审查 → 质量审查 → 下一 Task。
