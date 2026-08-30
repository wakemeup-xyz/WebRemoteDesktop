# Relay 出画连续性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 外网中继默认 720p 稳态可看（60s 内无 ≥3s 黑屏；≤2s 追帧可多次）；未真正出画不得显示「已连接」；IDR 与会话分辨率可从日志复盘。60s 无 ≥1s 0-FPS 是隧道 SLA。

**Architecture:** 会话级 `sessionPresentation = min(userPreference, pathCap)` 覆盖 Host 进程里陈旧的 `_user_resolution`。Encoder 按 path 设 GOP（relay 1s），`force_keyframe` 必须检出 IDR，失败则 codec recreate 一次。Viewer 出画四态门闩 + 顾问提示 + 同一 `connectionAttemptId` 诊断。演进现有 `webrtc.js` / `host.py` / `h264_videotoolbox_encoder.py`，不新造第二套媒体状态机，不自动切隧道。

**Tech Stack:** Viewer JS（`node --test` via `signal-server`）、python-host（pytest）、aiortc + VideoToolbox H.264、既有 Socket.IO 信令与 Diagnostic 通道。

**Spec:** `docs/superpowers/specs/2026-08-29-relay-paint-continuity-design.md`

## Global Constraints

- Quality Lock 仍禁止因 stall / structural RTT / jitter 自动改 size；路径 cap **只**在新 attempt、切模式、改面板时计算。
- 不自动切 TURN / tunnel；顾问可建议「隧道中继」。
- 不重建 Cloudflare tunnel；需要新 Host 进程时只用 `./scripts/restart-host.sh`。
- Keyframe ≤1/s；force 失败最多 recreate codec **一次**。
- 日志不打印 TURN 密码、完整 SDP、帧像素。
- Phase 1+2（Task 1–4）必须同一 PR 合并；只改 UI 或只改 GOP 不得宣称完成。
- 离散分辨率档位仅：`960x540` / `1280x720` / `1600x900` / `1920x1080`。Lock 下拒绝梯子尺寸 `640x360`、`854x480`。
- 测试命令：
  - Viewer：`cd signal-server && node --test ../web-client/js/<file>.test.js`
  - Host：`cd python-host && python3 -m pytest <file> -q`

---

## File map

| 文件 | 职责 |
|---|---|
| Create `web-client/js/presentation-budget.js` | pathCap / sessionPresentation 纯函数 |
| Create `web-client/js/presentation-budget.test.js` | 预算单测 |
| Modify `web-client/js/webrtc.js` | 应用预算、offer 带 size、四态门闩、顾问文案、禁止采集 FPS 冒充已连接 |
| Modify `web-client/js/webrtc.test.js` | 门闩 / stall / cap 测试 |
| Modify `web-client/js/diagnostic.js` | 诊断字段 |
| Modify `web-client/js/diagnostic.test.js` | 诊断断言 |
| Modify `web-client/js/diagnostic-core.js` | 仅当 autoSend 需要新 reason 时 |
| Modify `python-host/host.py` | attempt 绑定 size、GOP 会话、两段式 keyframe、stall 聚合日志 |
| Modify `python-host/h264_videotoolbox_encoder.py` | GOP、IDR 检测、recreate |
| Create `python-host/test_h264_idr.py` | encoder 单测 |
| Modify `python-host/test_quality_lock.py` | 采纳 720p / 拒绝 survival |
| Modify `README.md` 故障排查短节 | 黑屏排障指针 |
| Modify `docs/runbook-safe-startup.md` 场景 1b | 已连接黑屏 |

不改：`link-quality-controller.js` 梯子（stall 仍只 keyframe）、coturn、tunnel 启动脚本、LaunchAgent。

---

### Task 1: Presentation budget 纯函数

**Files:**
- Create: `web-client/js/presentation-budget.js`
- Create: `web-client/js/presentation-budget.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `PRESENTATION_RUNGS: Array<{width:number,height:number,label:string}>`
  - `nearestPresentationRung(width:number, height:number) => {width,height,label}`
  - `pathCapForMode(networkMode:string, lastCandidateType?:string) => {width,height,label}`
  - `computeSessionPresentation({ userPreference:{width,height}, networkMode:string, lastCandidateType?:string, explicitOverride1080?:boolean }) => { width, height, label, capped:boolean, pathCap, userPreference, explicitOverride1080:boolean }`

- [ ] **Step 1: Write the failing tests**

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  nearestPresentationRung,
  pathCapForMode,
  computeSessionPresentation,
} = require('./presentation-budget.js');

test('pathCap relay is 720p even if last candidate is empty', () => {
  assert.deepEqual(pathCapForMode('relay'), { width: 1280, height: 720, label: '1280x720' });
});

test('pathCap stun/auto/lan is 1080p', () => {
  assert.equal(pathCapForMode('stun').height, 1080);
  assert.equal(pathCapForMode('auto').width, 1920);
  assert.equal(pathCapForMode('lan').width, 1920);
});

test('pathCap treats lastCandidateType=relay as relay cap', () => {
  assert.equal(pathCapForMode('auto', 'relay').height, 720);
});

test('session presentation caps 1080p pref on relay', () => {
  const out = computeSessionPresentation({
    userPreference: { width: 1920, height: 1080 },
    networkMode: 'relay',
  });
  assert.equal(out.width, 1280);
  assert.equal(out.height, 720);
  assert.equal(out.capped, true);
  assert.equal(out.explicitOverride1080, false);
});

test('explicit 1080p override on relay keeps 1080p', () => {
  const out = computeSessionPresentation({
    userPreference: { width: 1920, height: 1080 },
    networkMode: 'relay',
    explicitOverride1080: true,
  });
  assert.equal(out.width, 1920);
  assert.equal(out.height, 1080);
  assert.equal(out.capped, false);
  assert.equal(out.explicitOverride1080, true);
});

test('user 540p on relay is not raised', () => {
  const out = computeSessionPresentation({
    userPreference: { width: 960, height: 540 },
    networkMode: 'relay',
  });
  assert.equal(out.width, 960);
  assert.equal(out.height, 540);
  assert.equal(out.capped, false);
});

test('nearest rung snaps 1728x1080 to 1080p', () => {
  const rung = nearestPresentationRung(1728, 1080);
  assert.equal(rung.width, 1920);
  assert.equal(rung.height, 1080);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd signal-server && node --test ../web-client/js/presentation-budget.test.js`  
Expected: FAIL cannot find module `presentation-budget.js`

- [ ] **Step 3: Implement `presentation-budget.js`**

```js
'use strict';

const PRESENTATION_RUNGS = Object.freeze([
  Object.freeze({ width: 960, height: 540, label: '960x540' }),
  Object.freeze({ width: 1280, height: 720, label: '1280x720' }),
  Object.freeze({ width: 1600, height: 900, label: '1600x900' }),
  Object.freeze({ width: 1920, height: 1080, label: '1920x1080' }),
]);

function nearestPresentationRung(width, height) {
  const pixels = Math.max(1, Number(width) * Number(height) || 1);
  let best = PRESENTATION_RUNGS[1];
  let bestDelta = Infinity;
  for (const rung of PRESENTATION_RUNGS) {
    const delta = Math.abs(rung.width * rung.height - pixels);
    if (delta < bestDelta) {
      best = rung;
      bestDelta = delta;
    }
  }
  return { ...best };
}

function pathCapForMode(networkMode, lastCandidateType) {
  const relay = networkMode === 'relay' || lastCandidateType === 'relay';
  return relay
    ? { width: 1280, height: 720, label: '1280x720' }
    : { width: 1920, height: 1080, label: '1920x1080' };
}

function computeSessionPresentation({
  userPreference,
  networkMode,
  lastCandidateType,
  explicitOverride1080 = false,
} = {}) {
  const pref = nearestPresentationRung(
    Number(userPreference?.width) || 1280,
    Number(userPreference?.height) || 720,
  );
  const cap = pathCapForMode(networkMode, lastCandidateType);
  const override = explicitOverride1080 === true && pref.width >= 1920;
  if (override || pref.width * pref.height <= cap.width * cap.height) {
    return {
      ...pref,
      capped: false,
      pathCap: cap,
      userPreference: pref,
      explicitOverride1080: override,
    };
  }
  return {
    ...cap,
    capped: true,
    pathCap: cap,
    userPreference: pref,
    explicitOverride1080: false,
  };
}

module.exports = {
  PRESENTATION_RUNGS,
  nearestPresentationRung,
  pathCapForMode,
  computeSessionPresentation,
};
```

在 `webrtc.js` 顶部用现有脚本加载方式暴露到全局（viewer 是非 bundler IIFE 环境）。**同时**保留 `module.exports` 给 node:test。模式：

```js
(function (root) {
  const api = { PRESENTATION_RUNGS, nearestPresentationRung, pathCapForMode, computeSessionPresentation };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PresentationBudget = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

把纯函数放进 IIFE，测试 `require` 仍可用。

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd signal-server && node --test ../web-client/js/presentation-budget.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web-client/js/presentation-budget.js web-client/js/presentation-budget.test.js
git commit -m "feat(media): add relay presentation budget helper"
```

---

### Task 2: Viewer 应用预算并写入 offer / profile / resolution

**Files:**
- Modify: `web-client/js/webrtc.js`（`currentResolution`、`applyMediaProfile`、`createOffer` emit、`requestResolution`、`beginConnectionAttempt`）
- Modify: `web-client/viewer.html` 确认 `presentation-budget.js` 在 `webrtc.js` 之前加载（`<!-- WRD_BUILD_HEAD -->` 构建列表若有脚本清单一并加）
- Modify: `web-client/js/webrtc.test.js`
- Check: `signal-server/scripts/build-web-client.js` 是否要加入新 JS 入口

**Interfaces:**
- Consumes: `PresentationBudget.computeSessionPresentation`
- Produces:
  - `WebRTC.getUserPreference() => {width,height,label}`
  - `WebRTC.getSessionPresentation() => computeSessionPresentation result`
  - `WebRTC._explicitOverride1080: boolean`（默认 false；`requestResolution` 在 1920x1080 时 true）
  - `beginConnectionAttempt(trigger)` 仅在 `viewer-open` / `manual-mode-switch` 时清 `_explicitOverride1080`；`refresh` 同会话保留 override（spec §6.4）
  - offer / `media-profile-change` / `resolution-change` 的 `width`/`height` = sessionPresentation

先查 `build-web-client.js` 如何收集 `web-client/js/*.js`。若是扫目录或 HTML 脚本标签，把 `presentation-budget.js` 加到 `viewer.html` 里 `webrtc.js` 之前。

- [ ] **Step 1: Write failing tests in `webrtc.test.js`**

在现有 `loadWebRTC` 里 `vm.runInContext` 之前加载 `presentation-budget.js`（与 stun controller 相同）。

```js
test('relay applyMediaProfile uses 720p cap when pref is 1080p', () => {
  const { WebRTC, context } = loadWebRTC();
  WebRTC.networkMode = 'relay';
  WebRTC._explicitOverride1080 = false;
  WebRTC.currentResolution = { width: 1920, height: 1080, label: '1920x1080' };
  WebRTC.socket = { connected: true, emit(event, payload) { context._last = [event, payload]; } };
  WebRTC.controlState = { lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 } };
  WebRTC.activeLeaseEnvelope = () => WebRTC.controlState.lease;
  WebRTC.applyMediaProfile({ name: 'high', width: 1280, height: 720, fps: 20, bitrateKbps: 2500 }, 'connection-sync');
  assert.equal(context._last[0], 'media-profile-change');
  assert.equal(context._last[1].width, 1280);
  assert.equal(context._last[1].height, 720);
  assert.equal(context._last[1].adaptiveResolution, false);
});

test('beginConnectionAttempt viewer-open clears 1080p override', () => {
  const { WebRTC } = loadWebRTC();
  WebRTC._explicitOverride1080 = true;
  WebRTC.beginConnectionAttempt('viewer-open');
  assert.equal(WebRTC._explicitOverride1080, false);
});

test('refresh attempt keeps 1080p override', () => {
  const { WebRTC } = loadWebRTC();
  WebRTC._explicitOverride1080 = true;
  WebRTC.beginConnectionAttempt('refresh');
  assert.equal(WebRTC._explicitOverride1080, true);
});

test('requestResolution 1080p on relay sets override flag', () => {
  const { WebRTC } = loadWebRTC();
  WebRTC.networkMode = 'relay';
  WebRTC.socket = { connected: true, emit() {} };
  WebRTC.controlState = { lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 } };
  WebRTC.activeLeaseEnvelope = () => WebRTC.controlState.lease;
  WebRTC.requestResolution(1920, 1080);
  assert.equal(WebRTC._explicitOverride1080, true);
  const pres = WebRTC.getSessionPresentation();
  assert.equal(pres.width, 1920);
});
```

若 `beginConnectionAttempt` / `applyMediaProfile` 测试 harness 缺 lease，按文件中 `preparePortSearch` 同样补 `activeLeaseEnvelope`。

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd signal-server && node --test ../web-client/js/webrtc.test.js`  
Expected: FAIL `getSessionPresentation` undefined 或 width 仍 1920

- [ ] **Step 3: Minimal implementation**

1. `viewer.html` 在 `webrtc.js` 前加 `<script src="js/presentation-budget.js"></script>`（构建器若从 HTML 收集则足够）。
2. `webrtc.js` 增加：

```js
_explicitOverride1080: false,

getUserPreference() {
  const cur = this.currentResolution || { width: 1280, height: 720 };
  return (typeof PresentationBudget !== 'undefined'
    ? PresentationBudget.nearestPresentationRung(cur.width, cur.height)
    : { width: 1280, height: 720, label: '1280x720' });
},

getSessionPresentation() {
  const budget = typeof PresentationBudget !== 'undefined'
    ? PresentationBudget.computeSessionPresentation({
      userPreference: this.getUserPreference(),
      networkMode: this.networkMode,
      lastCandidateType: this.lastCandidateType,
      explicitOverride1080: this._explicitOverride1080 === true,
    })
    : { width: 1280, height: 720, label: '1280x720', capped: false, pathCap: { width: 1280, height: 720 }, explicitOverride1080: false };
  return budget;
},
```

3. `applyMediaProfile`：Lock 时 `width/height` 改为 `this.getSessionPresentation()` 的宽高，而不是 raw `currentResolution`。码率地板用 **session** size 调 `qualityFloorsForResolution`。
4. `createOffer` 的 `socket.emit('offer', …)` 增加 `width` / `height`（sessionPresentation）。
5. `requestResolution(width,height)`：先写入 `currentResolution`，若 `width>=1920 && height>=1080` 则 `_explicitOverride1080=true`，否则 false；emit 的 size 用 `getSessionPresentation()`。
6. `beginConnectionAttempt(trigger)`：仅 `viewer-open`、`manual-mode-switch`（以及新 viewer 登录）把 `_explicitOverride1080 = false`。`refresh` / `fresh-frame-timeout` / ICE restart **保留** override，offer 仍带本会话 1080p。切回 720p 走 `requestResolution(1280,720)` 自行把 flag 置 false。

1080p 警告 UI 放 Task 6，本任务只设 flag。

- [ ] **Step 4: Re-run webrtc + budget tests**

Run:

```
cd signal-server && node --test ../web-client/js/presentation-budget.test.js ../web-client/js/webrtc.test.js
```

Expected: PASS（不得破坏既有 Lock / port-search 测试）

- [ ] **Step 5: Commit**

```bash
git add web-client/js/webrtc.js web-client/js/webrtc.test.js web-client/viewer.html signal-server/scripts/build-web-client.js
git commit -m "feat(viewer): cap relay session presentation at 720p"
```

---

### Task 3: Host 按 attempt 采纳 session size

**Files:**
- Modify: `python-host/host.py`（`on_offer`、`on_media_profile_change`、`_locked_user_size` 附近）
- Modify: `python-host/test_quality_lock.py`
- Modify: `python-host/test_media_profile.py` 仅当现有断言冲突

**Interfaces:**
- Consumes: offer/profile 上的 `width`/`height`/`networkMode`/`connectionAttemptId`
- Produces:
  - `LOCK_AUTO_SHRINK_SIZES = {(640, 360), (854, 480)}`
  - `is_lock_rejected_size(width, height) -> bool`
  - `on_offer` 调用 `_bind_session_presentation(data)`
  - `WRD_SESSION_PRESENTATION` structured event（`emit_host_event`）
  - `set_session_gop_size` 在 Task 4 接；本任务可先按 mode 调 encoder 模块函数（若 Task 4 未合入，先留调用点会 ImportError——**因此本任务在 Task 4 之后实施，或本任务只做 size，GOP 调用放到 Task 4**）

本任务 **只做 size 绑定**，GOP 调用留给 Task 4，避免未定义符号。

- [ ] **Step 1: Write failing tests**

在 `test_quality_lock.py` 追加（保留现有 survival 拒绝测试）：

```python
def test_lock_adopts_720p_connection_sync_over_stale_1080p():
    host = _make_host(1920, 1080)
    host.on_media_profile_change({
        "viewerId": "viewer-1",
        "profile": "high",
        "width": 1280,
        "height": 720,
        "targetFps": 20,
        "videoBitrateKbps": 2500,
        "reason": "connection-sync",
        "adaptiveResolution": False,
        "connectionAttemptId": "wrd-new",
    })
    assert host.media_profile["width"] == 1280
    assert host.media_profile["height"] == 720
    assert host._user_resolution == {"width": 1280, "height": 720}


def test_lock_still_rejects_survival_auto_size():
    host = _make_host(1280, 720)
    host.on_media_profile_change({
        "viewerId": "viewer-1",
        "profile": "survival",
        "width": 640,
        "height": 360,
        "targetFps": 8,
        "videoBitrateKbps": 500,
        "reason": "packet-loss",
        "adaptiveResolution": False,
    })
    assert host.media_profile["width"] == 1280
    assert host.media_profile["height"] == 720
```

将旧测试 `test_adaptive_resolution_false_ignores_smaller_size` **保留**（它就是 survival 拒绝）。不要改它的名字语义。

再加 offer 绑定测试（可用 `object.__new__` + 假 sio，或抽 `_bind_session_presentation` 纯方法）：

```python
def test_bind_session_presentation_resets_stale_user_resolution():
    host = _make_host(1920, 1080)
    host._bind_session_presentation({
        "width": 1280,
        "height": 720,
        "networkMode": "relay",
        "connectionAttemptId": "wrd-1",
        "viewerId": "v1",
    })
    assert host._user_resolution == {"width": 1280, "height": 720}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd python-host && python3 -m pytest test_quality_lock.py -q`  
Expected: `test_lock_adopts_720p_connection_sync_over_stale_1080p` FAIL（仍 1920）

- [ ] **Step 3: Implement**

`host.py` 增加：

```python
LOCK_AUTO_SHRINK_SIZES = {(640, 360), (854, 480)}
PRESENTATION_RUNGS = {(960, 540), (1280, 720), (1600, 900), (1920, 1080)}

def is_lock_rejected_size(width, height) -> bool:
    return (int(width), int(height)) in LOCK_AUTO_SHRINK_SIZES
```

`WebRemoteHost._bind_session_presentation(self, data)`：

```python
def _bind_session_presentation(self, data):
    width = clamp_int(data.get("width"), 320, 1920, MEDIA_PROFILE_DEFAULT["width"])
    height = clamp_int(data.get("height"), 180, 1080, MEDIA_PROFILE_DEFAULT["height"])
    prev = dict(getattr(self, "_user_resolution", None) or {})
    adopted = self._set_user_resolution(width, height)
    emit_host_event(
        logger,
        event="host_session_presentation",
        message="Session presentation bound",
        correlation={"connectionAttemptId": data.get("connectionAttemptId")},
        meta={
            "width": adopted[0],
            "height": adopted[1],
            "networkMode": data.get("networkMode") or data.get("iceMode"),
            "previousUserResolution": prev,
            "adopted": True,
            "path": data.get("networkMode") or data.get("iceMode"),
        },
    )
    logger.info(
        "WRD_SESSION_PRESENTATION size=%sx%s path=%s previous=%s adopted=true attempt=%s",
        adopted[0], adopted[1],
        data.get("networkMode") or "-",
        prev,
        data.get("connectionAttemptId") or "-",
    )
    return adopted
```

在 `on_offer` 里，`self._active_input_binding = binding` 之后、创建 PC 之前：若 `data` 含正 width/height，调用 `_bind_session_presentation(data)`。

改 `on_media_profile_change` Lock 分支（当前 `_locked_user_size()` 否决一切更小请求）：

```python
if adaptive_resolution:
    width, height = requested_width, requested_height
    self._set_user_resolution(width, height)
else:
    if is_lock_rejected_size(requested_width, requested_height):
        width, height = self._locked_user_size()
        # keep existing size-locked log
    elif (requested_width, requested_height) in PRESENTATION_RUNGS:
        width, height = self._set_user_resolution(requested_width, requested_height)
    else:
        width, height = self._locked_user_size()
```

`reason=connection-sync` 的 1280x720 必须走 adopt 分支。

- [ ] **Step 4: Run tests**

Run: `cd python-host && python3 -m pytest test_quality_lock.py test_media_profile.py -q`  
Expected: PASS，含旧 survival 测试

- [ ] **Step 5: Commit**

```bash
git add python-host/host.py python-host/test_quality_lock.py python-host/test_media_profile.py
git commit -m "fix(host): bind presentation size to each viewer attempt"
```

---

### Task 4: 可验证 IDR + relay GOP 1s

**Files:**
- Modify: `python-host/h264_videotoolbox_encoder.py`
- Create: `python-host/test_h264_idr.py`
- Modify: `python-host/host.py`（`on_offer` 设 GOP；`_request_keyframe` 两段日志）
- Modify: `python-host/test_quality_lock.py` 或新 `test_keyframe_log.py` 断言日志字段

**Interfaces:**
- Consumes: `networkMode` from offer
- Produces:
  - `set_session_gop_size(gop: int) -> int`
  - `get_session_gop_size() -> int`
  - `bitstream_contains_idr(data: bytes) -> bool`
  - `H264VideoToolboxEncoder.last_force_emitted_idr: bool`
  - `H264VideoToolboxEncoder.last_idr_recreated: bool`
  - Host: `WRD_KEYFRAME requested=true emitted=<bool|pending>`
  - Host: `WRD_IDR_RECREATE`

- [ ] **Step 1: Write failing encoder tests**

```python
# python-host/test_h264_idr.py
from h264_videotoolbox_encoder import (
    bitstream_contains_idr,
    set_session_gop_size,
    get_session_gop_size,
    H264VideoToolboxEncoder,
)

def test_idr_detects_annexb_type5():
    nal = bytes([0, 0, 0, 1, 0x65, 0, 1, 2])  # nal_ref_idc=3, type=5
    assert bitstream_contains_idr(nal) is True

def test_idr_detects_fu_a_idr():
    # FU-A indicator type 28, start bit, original type 5
    fu = bytes([0, 0, 0, 1, 0x7C, 0x85, 0, 1])
    assert bitstream_contains_idr(fu) is True

def test_non_idr_slice_false():
    nal = bytes([0, 0, 0, 1, 0x41, 0, 1])  # type 1
    assert bitstream_contains_idr(nal) is False

def test_set_session_gop_clamps():
    assert set_session_gop_size(20) == 20
    assert get_session_gop_size() == 20
    assert set_session_gop_size(1) == 10
    set_session_gop_size(40)
```

再写一个不依赖真实 VT 的 force 路径测试：给 encoder 注入假 codec。

```python
class FakePacket:
    def __init__(self, data):
        self._data = data
    def __bytes__(self):
        return self._data

class FakeCodec:
    def __init__(self, payloads):
        self.width = 16
        self.height = 16
        self._payloads = list(payloads)
        self.closed = False
    def encode(self, frame):
        if not self._payloads:
            return []
        return [FakePacket(self._payloads.pop(0))]

def test_force_keyframe_recreates_when_first_encode_has_no_idr(monkeypatch):
    enc = H264VideoToolboxEncoder()
    p_slice = bytes([0, 0, 0, 1, 0x41, 0])
    idr = bytes([0, 0, 0, 1, 0x65, 0])
    calls = {"create": 0}
    codecs = [FakeCodec([p_slice]), FakeCodec([idr])]
    def fake_create(self, frame, codec_name):
        calls["create"] += 1
        return codecs.pop(0)
    monkeypatch.setattr(H264VideoToolboxEncoder, "_create_codec", fake_create)
    import av
    frame = av.VideoFrame.from_ndarray(
        __import__("numpy").zeros((16, 16, 3), dtype="uint8"), format="rgb24"
    )
    frame.pts = 0
    frame.time_base = "1/20"
    list(enc._encode_frame(frame, force_keyframe=True))
    assert calls["create"] == 2
    assert enc.last_force_emitted_idr is True
    assert enc.last_idr_recreated is True
```

若 `av.VideoFrame.from_ndarray` 在 CI 环境不可用，改用 `MagicMock` frame：`width=16, height=16`，并让 `_encode_frame` 在 `self.codec is None` 时走 `_create_codec`。

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd python-host && python3 -m pytest test_h264_idr.py -q`  
Expected: FAIL import `bitstream_contains_idr`

- [ ] **Step 3: Implement encoder helpers**

在 `h264_videotoolbox_encoder.py`：

```python
NAL_TYPE_IDR = 5
_session_gop_size = 40

def set_session_gop_size(gop: int) -> int:
    global _session_gop_size
    _session_gop_size = max(10, min(int(gop), 120))
    return _session_gop_size

def get_session_gop_size() -> int:
    return _session_gop_size

def bitstream_contains_idr(data: bytes) -> bool:
    if not data:
        return False
    for nal in H264VideoToolboxEncoder._split_bitstream(data if data.startswith(b"\x00\x00") else b"\x00\x00\x00\x01" + data):
        if not nal:
            continue
        nal_type = nal[0] & 0x1F
        if nal_type == NAL_TYPE_IDR:
            return True
        if nal_type == NAL_TYPE_FU_A and len(nal) >= 2:
            if (nal[1] & 0x1F) == NAL_TYPE_IDR:
                return True
        if nal_type == NAL_TYPE_STAP_A:
            pos = 1
            while pos + 2 <= len(nal):
                length = int.from_bytes(nal[pos:pos + 2], "big")
                pos += 2
                if pos + length > len(nal):
                    break
                unit = nal[pos:pos + length]
                pos += length
                if unit and (unit[0] & 0x1F) == NAL_TYPE_IDR:
                    return True
    return False
```

`H264VideoToolboxEncoder.__init__`：`self.gop_size = get_session_gop_size()`；`last_force_emitted_idr = False`；`last_idr_recreated = False`。

`_create_codec`：`codec.gop_size = int(getattr(self, "gop_size", None) or get_session_gop_size())` 替代写死 `MAX_FRAME_RATE * 2`。

`_encode_frame` 在 `force_keyframe` 时：

```python
self.last_force_emitted_idr = False
self.last_idr_recreated = False
# existing pict_type I + encode
if force_keyframe:
    if bitstream_contains_idr(data_to_send):
        self.last_force_emitted_idr = True
    else:
        self.codec = None
        self.codec = self._create_codec(frame, self.codec_name)
        self.last_idr_recreated = True
        data_to_send = b""
        for package in self.codec.encode(frame):
            data_to_send += bytes(package)
        self.last_force_emitted_idr = bitstream_contains_idr(data_to_send)
```

Host `on_offer` 在 bind presentation 之后：

```python
from h264_videotoolbox_encoder import set_session_gop_size, get_session_gop_size
gop = 20 if (data.get("networkMode") or data.get("iceMode")) == "relay" else 40
set_session_gop_size(gop)
```

并把 gop 写入 `WRD_SESSION_PRESENTATION` 日志（Task 3 的 logger.info 增加 `gop=`）。

`_request_keyframe`：

```python
ok = ... existing hook ...
emitted = None
# 无法同步等到下一帧时先 pending
logger.info(
    "WRD_KEYFRAME requested=true emitted=%s reason=%s viewer=%s codec=%s gop=%s size=%sx%s",
    "pending" if ok else "false",
    reason_s, viewer_s,
    getattr(getattr(self, "media_sender", None), "codec_name", "-"),
    get_session_gop_size(),
    (self._user_resolution or {}).get("width"),
    (self._user_resolution or {}).get("height"),
)
```

Encoder 侧 recreate 时 Host 看不到 `last_idr_recreated`，除非在下一轮 stats 或在 `request_keyframe` 后短延迟读 encoder。最小实现：在 `_patched_get_encoder` 把 encoder 实例存到 `host._video_encoder` 做不到（patch 无 host 引用）。

改用 **模块级 last-encode 标志**：

```python
_last_encode_flags = {"emitted": False, "recreated": False}

def consume_last_force_flags() -> dict:
    flags = dict(_last_encode_flags)
    return flags
```

`_encode_frame` 写 `_last_encode_flags`。Host `_request_keyframe` 在调用 hook 后 `consume_last_force_flags()` **可能仍是上一帧**。这不够。

更稳：Host 不声称同步 `emitted`。改为：

1. 立即 `requested=true emitted=pending`
2. Encoder `_encode_frame` 自己打 `WRD_IDR_RECREATE` / `WRD_KEYFRAME emitted=true|false`（encoder logger `__name__`）

计划采用 **encoder 自己打 emitted 日志**，Host 打 `requested`。两条都能 grep。Spec 的两段式由此满足。

```python
# in _encode_frame after force path
logger.info(
    "WRD_KEYFRAME requested=true emitted=%s recreated=%s gop=%s size=%dx%d",
    self.last_force_emitted_idr,
    self.last_idr_recreated,
    getattr(self, "gop_size", get_session_gop_size()),
    frame.width, frame.height,
)
if self.last_idr_recreated:
    logger.info("WRD_IDR_RECREATE success=%s codec=%s", self.last_force_emitted_idr, self.codec_name)
```

非 force 帧不要刷屏。

- [ ] **Step 4: Run tests**

Run:

```
cd python-host && python3 -m pytest test_h264_idr.py test_quality_lock.py -q
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add python-host/h264_videotoolbox_encoder.py python-host/test_h264_idr.py python-host/host.py python-host/test_quality_lock.py
git commit -m "fix(host): emit verifiable IDR on stall and shorten relay GOP"
```

---

### Task 5: Paint gate 四态 UI

**Files:**
- Modify: `web-client/js/webrtc.js`（`ontrack` hideLoading、`onPeerConnected`、`processStatsSnapshot`、`updateConnectionStatus`、capture_stats 分支）
- Modify: `web-client/css/viewer.css`（`.status.media-pending` / `.status.media-stalled` 颜色）
- Modify: `web-client/js/webrtc.test.js`

**Interfaces:**
- Consumes: stats `framesDecoded` / `framesReceived` / `fps`
- Produces:
  - `WebRTC.uiPhase: 'signaling'|'media-pending'|'connected'|'media-stalled'`
  - `WebRTC.hasPaintedFrame: boolean`
  - `WebRTC._paintDecodedBaseline: number`
  - `WebRTC.notePaintStats(stats)`
  - `WebRTC.setUiPhase(phase, {reason})`
  - `updateConnectionStatus` 文案：`正在出画` / `已连接` / `画面卡顿`

- [ ] **Step 1: Write failing tests**

```js
test('ontrack with paused=false and readyState=0 does not mark connected', () => {
  const { WebRTC, elements, context } = loadWebRTC();
  document.body = context.document.body;
  const video = elements.get('remoteVideo') || context.document.getElementById('remoteVideo');
  video.readyState = 0;
  video.paused = false;
  video.videoWidth = 0;
  video.videoHeight = 0;
  WebRTC.uiPhase = 'signaling';
  WebRTC.hasPaintedFrame = false;
  WebRTC.markRemoteTrack({ readyState: 0, paused: false }); // 若无此方法，测试直接调即将抽出的 hideLoading 条件函数
  assert.notEqual(elements.get('connectionStatus').textContent, '已连接');
  assert.equal(WebRTC.uiPhase, 'media-pending');
});

test('framesDecoded growth sets connected', () => {
  const { WebRTC, elements } = loadWebRTC();
  WebRTC.uiPhase = 'media-pending';
  WebRTC._paintDecodedBaseline = 0;
  WebRTC.hasPaintedFrame = false;
  WebRTC.notePaintStats({ framesDecoded: 1, framesReceived: 1, fps: 12, videoWidth: 1280, videoHeight: 720 });
  assert.equal(WebRTC.uiPhase, 'connected');
  assert.equal(WebRTC.hasPaintedFrame, true);
  assert.equal(elements.get('connectionStatus').textContent, '已连接');
});

test('stall 1s with received>0 does not scheduleReconnect', () => {
  const { WebRTC } = loadWebRTC();
  const reconnects = [];
  WebRTC.scheduleReconnect = (reason) => reconnects.push(reason);
  WebRTC.uiPhase = 'connected';
  WebRTC.hasPaintedFrame = true;
  WebRTC._stallSince = Date.now() - 1000;
  WebRTC.notePaintStats({ framesDecoded: 40, framesReceived: 19, fps: 0, videoWidth: 1280, videoHeight: 720 });
  assert.equal(WebRTC.uiPhase, 'media-stalled');
  assert.deepEqual(reconnects, []);
});
```

为了可测，把门闩抽成 `notePaintStats` / `shouldHideLoading({readyState, paused, hasPaintedFrame})`，不要把逻辑只藏在 DOM 事件里。

```js
function shouldHideLoading({ hasPaintedFrame }) {
  return hasPaintedFrame === true;
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd signal-server && node --test ../web-client/js/webrtc.test.js`  
Expected: FAIL `notePaintStats` undefined

- [ ] **Step 3: Implement**

`updateConnectionStatus`：

```js
const statusText = {
  connecting: '连接中',
  'media-pending': '正在出画',
  connected: '已连接',
  'media-stalled': '画面卡顿',
  disconnected: '已断开',
};
```

CSS：`.status.media-pending { color: var(--accent-warning); }` `.status.media-stalled { color: var(--accent-warning); }`（沿用已有 token，没有就用 `#fbbf24`）。

`ontrack` 的 `hideLoading`：**删除** `paused===false` 立即隐藏。改为：

```js
const tryPaintGate = () => {
  if (videoElement.videoWidth > 0 && videoElement.videoHeight > 0 && videoElement.readyState >= 2) {
    this.notePaintStats({
      framesDecoded: this._lastInboundFramesDecoded || 0,
      framesReceived: 0,
      fps: 0,
      videoWidth: videoElement.videoWidth,
      videoHeight: videoElement.videoHeight,
      source: 'video-element',
    });
  }
};
```

metadata / playing 只更新尺寸，**不** `updateConnectionStatus('connected')`。

`onPeerConnected` 安全网改为 `setUiPhase('media-pending')`，**禁止** `updateConnectionStatus('connected')`。

`processStatsSnapshot` 末尾调 `notePaintStats({...stats, videoWidth, videoHeight})`。

`notePaintStats` 逻辑：

```
if videoWidth>0 && framesDecoded > baseline → hasPaintedFrame=true, phase=connected, hide loading
else if pc/ice connected && !hasPaintedFrame → phase=media-pending
else if hasPaintedFrame && fps===0 && framesReceived>0:
     if !_stallSince: _stallSince=now
     if now-_stallSince>=1000: phase=media-stalled
else: _stallSince=null; if hasPaintedFrame: phase=connected
```

8s fallback：若仍无 `hasPaintedFrame`，保持 media-pending，**不要**绿灯。可触发 Task 6/7 的诊断。

`capture_stats` 分支：只更新内部 `_hostCaptureFps`，**不得**写 `#fpsDisplay` 把采集 FPS 显示成播放 FPS。

- [ ] **Step 4: Run tests**

Run: `cd signal-server && node --test ../web-client/js/webrtc.test.js`  
Expected: PASS。检查既有 `assert.equal(..., '已连接')` 的测试：给它们补一次 `notePaintStats` 增长，或改断言为新语义。

- [ ] **Step 5: Commit**

```bash
git add web-client/js/webrtc.js web-client/js/webrtc.test.js web-client/css/viewer.css
git commit -m "fix(ui): gate 已连接 on decoded frame growth"
```

---

### Task 6: 可行动提示

**Files:**
- Modify: `web-client/js/webrtc.js`（`updateNetworkUI` 调用点）
- Modify: `web-client/js/webrtc.test.js`

**Interfaces:**
- Consumes: `uiPhase`、`getSessionPresentation()`、`_explicitOverride1080`
- Produces: 顾问文案常量；`nextSuggestedMode: 'tunnel'` **仅建议**
- 不调用自动 `enforceSupportedNetworkMode('tunnel')`

文案（中文，固定字符串便于测）：

| 条件 | `updateNetworkUI(text, severity)` |
|---|---|
| media-pending 3s | `链路已通，正在等待第一帧。` warning |
| media-pending 8s | `第一帧仍未到达，请点击「刷新画面」。` warning |
| media-stalled + relay | `外网中继正在追帧，画面可能短暂发黑。若反复出现，请改用 720p 或手动切换「隧道中继」。` warning |
| explicit 1080p + relay | `外网中继上 1080p 容易卡顿，建议改回 720p 或改用隧道中继。` warning |
| stalled ≥6s | `当前中继出画不稳定，请手动切换「隧道中继」。` danger + `setFailureRecommendation('relay-failed-suggest-tunnel', 'danger')` |

- [ ] **Step 1: Failing test**

```js
test('relay stall copy suggests tunnel without switching mode', () => {
  const { WebRTC } = loadWebRTC();
  const modes = [];
  WebRTC.networkMode = 'relay';
  WebRTC.enforceSupportedNetworkMode = (m) => modes.push(m);
  WebRTC.updateNetworkUI = (text) => { WebRTC._ui = text; };
  WebRTC.announcePaintIssue('media-stalled');
  assert.match(WebRTC._ui, /隧道中继/);
  assert.deepEqual(modes, []);
  assert.equal(WebRTC.networkMode, 'relay');
});
```

- [ ] **Step 2: RED** `announcePaintIssue` missing

- [ ] **Step 3: Implement `announcePaintIssue(kind)`** 并在 `setUiPhase` / `requestResolution` 调用。3s/8s 用 `setTimeout`，`beginConnectionAttempt` 时 clear。

- [ ] **Step 4: PASS tests**

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(ui): explain relay paint stalls with next-step copy"
```

---

### Task 7: 诊断字段与自动上送

**Files:**
- Modify: `web-client/js/diagnostic.js` `buildConnectionDiagnostic`
- Modify: `web-client/js/diagnostic.test.js`
- Modify: `web-client/js/webrtc.js`（8s pending / 3s stall / emitted=false 时 `Diagnostic.autoSendFailure`）
- Modify: `python-host/host.py` VIEWER_STATS 聚合 `WRD_STALL_SAMPLE`（可选轻量：连续 decoded=0 且 received>0 每 5s 一条）

**Interfaces:**
- Produces `traceSummary` 增补（保留 schemaVersion 3）：
  - `uiPhase`, `hasPaintedFrame`, `userPreference`, `pathCap`, `sessionPresentation`, `explicitOverride1080`
  - `videoWidth`, `videoHeight`, `readyState`, `framesReceived`, `framesDecoded`, `fps`, `jitterBufferMs`, `bytesReceived`
  - `keyframeRequested`, `keyframeEmitted`

- [ ] **Step 1: Failing diagnostic test**

```js
test('buildConnectionDiagnostic includes paint continuity fields', () => {
  const { context, Diagnostic } = createDiagnosticContext();
  context.WebRTC.getSessionPresentation = () => ({
    width: 1280, height: 720, label: '1280x720',
    capped: true,
    pathCap: { width: 1280, height: 720 },
    userPreference: { width: 1920, height: 1080 },
    explicitOverride1080: false,
  });
  context.WebRTC.uiPhase = 'media-stalled';
  context.WebRTC.hasPaintedFrame = true;
  context.WebRTC._lastInboundFramesDecoded = 0;
  const payload = Diagnostic.buildConnectionDiagnostic({ trigger: 'auto-failure', reason: 'media-stalled' });
  assert.equal(payload.traceSummary.uiPhase, 'media-stalled');
  assert.equal(payload.traceSummary.sessionPresentation.width, 1280);
  assert.equal(payload.traceSummary.pathCap.height, 720);
  assert.equal(payload.traceSummary.hasPaintedFrame, true);
});
```

`createDiagnosticContext` 已有 `WebRTC` stub，按需补方法。

- [ ] **Step 2: RED**

- [ ] **Step 3: Implement** `buildConnectionDiagnostic` 从 `WebRTC.getSessionPresentation()` / `uiPhase` 填 `traceSummary`。`setUiPhase('media-pending')` 启动 8s timer → `Diagnostic.autoSendFailure('paint-pending-timeout')`。stall 持续 3s → `'media-stalled'`。

Host：在 `on_viewer_stats` 若 `fps==0 and received>0`，计数；每 5 样本：

```python
logger.info("WRD_STALL_SAMPLE count=%s received=%s decoded=%s viewer=%s", ...)
```

- [ ] **Step 4: PASS** `diagnostic.test.js` + `webrtc.test.js`

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(diag): record presentation and paint-phase on stall"
```

---

### Task 8: 文档对齐

**Files:**
- Modify: `README.md`「WebRTC 连接失败」节追加「已连接但黑屏」
- Modify: `docs/runbook-safe-startup.md` 场景 1b 追加同样条目
- 不改 Quality Lock spec 正文（本设计已单独成文）；可在 Quality Lock spec 末尾加一行「relay 默认 cap 见 2026-08-29」——**可选**，若改则只加关联链接，不改契约段落。

文案要点：

1. 先看 `WRD_SESSION_PRESENTATION` 是否 1280x720
2. 再看 `WRD_KEYFRAME emitted=`
3. Viewer 状态应是「正在出画」直到第一帧
4. 不要重建 tunnel；Host 用 `./scripts/restart-host.sh`

- [ ] **Step 1: Edit docs**（无单测）
- [ ] **Step 2: Commit**

```bash
git commit -m "docs: document connected-black paint continuity triage"
```

---

### Task 9: 本机运行验收（不重建 tunnel）

**Files:** 无代码。执行者在用户常驻环境做。

- [ ] **Step 1:** `./scripts/restart-host.sh`（使 encoder/GOP/size 绑定生效）。不要跑 `start-safe-wrd.sh` / 不要动 cloudflared。
- [ ] **Step 2:** 打开 `http://127.0.0.1:8080`，模式「外网中继」，分辨率保持默认 720p，开始连接。
- [ ] **Step 3:** 断言 UI：第一帧前状态栏为「正在出画」，出画后「已连接」。
- [ ] **Step 4:** `rg WRD_SESSION_PRESENTATION back-debug.log | tail` 含 `1280x720` 或 `960x540`，**不是** `1728x1080`。
- [ ] **Step 5:** 观察 60s：不得出现 ≥3s 的 0 FPS 黑屏。「画面卡顿」可在 ≤2s 追帧时短暂出现；≤2s 追帧次数只记不挂。
- [ ] **Step 6:** 手选 1080p：出现警告文案。
- [ ] **Step 7:** 点「发送日志到服务端」，确认 signal 日志 / `/tmp/wrd-diag/`（若 `WRD_ENABLE_DIAG_PERSIST=1`）含 `sessionPresentation` 与 `uiPhase`。
- [ ] **Step 8:** 若验收失败：不要再叠第四个修复；回到对应 Task 的测试补证据。

本任务不自动 commit。验收通过后由执行者把剩余文档/微调一并提交。

---

## Self-review vs spec

| Spec 条款 | Task |
|---|---|
| §6 pathCap / sessionPresentation / 离散档 | Task 1–2 |
| §6.2 1080p override 作用域 | Task 2：`viewer-open` / 切模式清 flag；`refresh` 保留 |
| §6.3 Host 不再否决合法 720p | Task 3 |
| §6.3 仍拒 survival 640×360 | Task 3 保留旧测试 |
| §7 GOP 1s relay | Task 4 |
| §7 IDR 检测 + 一次 recreate | Task 4 |
| §7 两段式 KEYFRAME | Task 4 encoder emitted 日志 + Host requested |
| §8 四态 / 禁 paused 绿灯 / 禁 capture_stats 冒充 | Task 5 |
| §8 stall 不拆 PC | Task 5 |
| §9 顾问文案、不自动切隧道 | Task 6 |
| §10 诊断字段 / autoSend / WRD_STALL_SAMPLE | Task 7 |
| §11.2 本机 60s | Task 9 |
| README/runbook | Task 8 |
| 不重建 tunnel | Global + Task 9 |
| Phase 1+2 同 PR | Global Constraints |

无 TBD。函数名前后一致：`computeSessionPresentation`、`getSessionPresentation`、`_bind_session_presentation`、`set_session_gop_size`、`bitstream_contains_idr`、`notePaintStats`、`announcePaintIssue`。

已知耦合：Task 2 的 `loadWebRTC` 必须先 `runInContext` `presentation-budget.js`，否则 Task 2 测试会假红。
