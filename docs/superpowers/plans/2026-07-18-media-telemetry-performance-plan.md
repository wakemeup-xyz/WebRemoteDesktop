# Media Telemetry and Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Do not delegate because this session does not authorize subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace misleading media timing and duplicated stats work with one bounded sampler, accurate candidate selection, recoverable quality profiles, and target-aware capture pacing.

**Architecture:** `web-client/js/webrtc-stats.js` becomes the only interpreter of `RTCPeerConnection.getStats()`. `WebRTC` owns exactly one sampler and one video callback per PC; LatencyMonitor consumes snapshots and the Host emits a v2 timing schema that names only measured boundaries.

**Tech Stack:** Browser JavaScript, WebRTC stats API, Node.js test runner, Python 3.11, aiortc, pytest.

**Spec Coverage:** Batch C of `docs/superpowers/specs/2026-07-18-remote-desktop-reliability-latency-remediation-design.md`.

**Truth Source:** `webrtc-stats.js` for selected pair and interval media values; `ScreenCaptureTrack` for capture pacing and measured Host timing fields.

**Compatibility Notes:** Candidate diagnostics retain the current shape. Timing schema v1 may be read for display compatibility, but all new Host messages are v2 and unmeasured encoder/RTP/end-to-end fields are `null`.

**Impact Map:**
- **Truth Source:** One stats sampler snapshot and one timing schema.
- **Backend:** Host capture loop uses the live target FPS and emits honest timing fields.
- **Frontend:** WebRTC, latency panel, candidate UI, and adaptive quality consume shared interval snapshots.
- **Runtime Proof:** One `getStats()` per interval, callback count remains one after 50 refreshes, actual selected pair is displayed, and survival capture rate is at most 16 FPS.
- **Docs/Skills:** Requirement and diagnostic report follow-up describe unavailable timing fields.
- **Commit Boundary:** Stats/timing/adaptation/capture modules and tests only.

**Definition of Done:**
- Reconnect and refresh cannot accumulate sampler timers or video callbacks.
- Transport `selectedCandidatePairId` wins over other succeeded candidate pairs.
- No UI labels pre-encode work as encoder or packet send time.
- Ten good samples with cooldown cause one-step recovery; poor samples retain existing downshift behavior.
- Capture pacing recalculates from the current target FPS.

---

### Task 1: Build the canonical WebRTC stats sampler

**Files:**
- Create: `web-client/js/webrtc-stats.js`
- Create: `web-client/js/webrtc-stats.test.js`
- Modify: `web-client/viewer.html`

- [x] **Step 1: Write failing pure tests**

Cover transport-selected pair, nominated fallback, multiple succeeded pairs, local/remote candidate lookup, counter reset, and interval jitter/FPS/loss deltas.

```javascript
const selected = WebRtcStats.selectActiveCandidatePair(stats);
assert.equal(selected.pair.id, 'pair-selected');
assert.equal(selected.local.type, 'srflx');

const interval = WebRtcStats.deriveIntervalMediaStats(previous, current);
assert.equal(interval.framesDecoded, 20);
assert.equal(interval.packetsLost, 2);
```

- [x] **Step 2: Verify RED**

Run: `node --test web-client/js/webrtc-stats.test.js`

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement sampler lifecycle**

`createWebRtcStatsSampler({ getStats, now, setTimer, clearTimer, intervalMs: 1000 })` exposes `start()`, `stop()`, `sampleNow()`, and `snapshot()`. It prevents concurrent samples, keeps only the previous normalized counters plus the latest snapshot, and never owns more than one timer.

- [x] **Step 4: Verify GREEN**

Run: `node --test web-client/js/webrtc-stats.test.js`

Expected: selection, interval, and lifecycle tests pass.

### Task 2: Integrate one sampler and bounded video callbacks

**Files:**
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/js/webrtc.test.js`
- Modify: `web-client/js/latency-monitor.js`
- Create: `web-client/js/latency-monitor.test.js`

- [x] **Step 1: Add failing integration tests**

Use fake timers, `getStats` counters, and video callback IDs. Assert 50 start/stop cycles leave zero timers/callbacks, one connected PC causes at most one stats call per interval, and stop invokes `cancelVideoFrameCallback` with the saved ID.

- [x] **Step 2: Verify RED**

Run: `node --test web-client/js/webrtc-stats.test.js web-client/js/latency-monitor.test.js web-client/js/webrtc.test.js`

Expected: FAIL because current frame callbacks are not cancellable and LatencyMonitor calls `pc.getStats()` directly.

- [x] **Step 3: Make WebRTC the lifecycle owner**

Add `_statsSampler` and `_videoFrameCallbackId`. `startStats()` creates/starts one sampler for the current PC; teardown stops it and cancels the callback. Existing diagnostics and `collectNetworkSnapshot()` read `sampler.snapshot()` rather than re-enumerating stats.

- [x] **Step 4: Make LatencyMonitor a snapshot consumer**

Delete `_estimatePlayoutBuffer()` and every direct `getStats()` call. Add `onMediaStats(snapshot)` to record interval `jitterBufferMs`; `onVideoFrame()` records paint gaps only. Keep v1 timing parsing read-only for compatibility.

- [x] **Step 5: Verify GREEN**

Run: `node --test web-client/js/webrtc-stats.test.js web-client/js/latency-monitor.test.js web-client/js/webrtc.test.js`

Expected: lifecycle and single-sampler tests pass.

### Task 3: Replace false Host timing boundaries with schema v2

**Files:**
- Modify: `python-host/host.py`
- Modify: `python-host/test_latency_timing.py`
- Modify: `web-client/js/latency-monitor.js`
- Modify: `web-client/js/latency-monitor.test.js`

- [x] **Step 1: Add failing schema tests**

Assert Host timing messages contain:

```python
assert message["schemaVersion"] == 2
assert set(message["timings"]) >= {
    "capturePrepareMs", "frameConvertMs", "encoderMs", "rtpSendMs", "endToEndVideoMs"
}
assert message["timings"]["encoderMs"] is None
assert "encodeEnd" not in message["timings"]
assert "packetSend" not in message["timings"]
```

- [x] **Step 2: Verify RED**

Run: `python3 -m pytest python-host/test_latency_timing.py -q && node --test web-client/js/latency-monitor.test.js`

Expected: FAIL because Host emits v1 pseudo timestamps and Viewer derives fake encode/network values.

- [x] **Step 3: Emit and render only measured values**

Calculate Host durations from monotonic timestamps inside `recv()`. Emit `encoderMs`, `rtpSendMs`, and `endToEndVideoMs` as `null`; retain independent input execute durations. Viewer stores unavailable values as `null` and does not invent a network phase from DataChannel arrival.

- [x] **Step 4: Verify GREEN**

Run: `python3 -m pytest python-host/test_latency_timing.py -q && node --test web-client/js/latency-monitor.test.js`

Expected: schema and display semantics pass.

### Task 4: Add adaptive quality recovery with hysteresis

**Files:**
- Modify: `web-client/js/link-quality-controller.js`
- Modify: `web-client/js/webrtc.test.js`

- [x] **Step 1: Add failing recovery tests**

Inject `now()`. From `survival`, ten good samples before 15 seconds hold; after cooldown the next qualifying sample upgrades to `low`. A degraded sample resets good count, and each decision upgrades at most one step.

- [x] **Step 2: Verify RED**

Run: `node --test web-client/js/webrtc.test.js`

Expected: FAIL because good samples never upgrade.

- [x] **Step 3: Implement `goodCount` and cooldown**

Store `lastProfileChangeAt`, use injected `now`, reset good count on any degraded/critical/no-pair sample, and return `{ action: 'upgrade', profileConfig }` only after ten good samples and 15 seconds since the last change.

- [x] **Step 4: Verify GREEN**

Run: `node --test web-client/js/webrtc.test.js`

Expected: existing degradation plus new recovery tests pass.

### Task 5: Pace screen capture from live target FPS

**Files:**
- Modify: `python-host/host.py`
- Modify: `python-host/test_media_profile.py`

- [x] **Step 1: Add failing pacing tests**

Extract or expose `capture_fps_for_target(target_fps)` and assert `20 -> 40`, `15 -> 30`, `12 -> 24`, `8 -> 16`, with the result capped at 60 and never below target FPS.

- [x] **Step 2: Verify RED**

Run: `python3 -m pytest python-host/test_media_profile.py -q`

Expected: FAIL because `_capture_loop()` freezes a 60 FPS interval at startup.

- [x] **Step 3: Recompute pacing each capture iteration**

Under the existing lock read `_target_fps`, compute `min(60, max(target_fps * 2, target_fps + 5))`, and derive the current sleep interval. Do not restart the capture thread when profiles change.

- [x] **Step 4: Verify GREEN and Batch C regression**

Run: `python3 -m pytest python-host/test_latency_timing.py python-host/test_media_profile.py -q && node --test web-client/js/webrtc-stats.test.js web-client/js/latency-monitor.test.js web-client/js/webrtc.test.js`

Expected: all focused tests pass.

### Task 6: Synchronize media observability documentation

**Files:**
- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md`
- Modify: `docs/superpowers/reports/2026-07-18-remote-desktop-connection-interaction-performance-diagnostic.md`

- [x] **Step 1: Record v2 semantics and remediation status**

Document one sampler per PC, selected-pair precedence, measured timing fields, unavailable encoder/RTP values, adaptive recovery, and capture pacing.

- [x] **Step 2: Run scope checks**

Run: `git diff --check && rg -n 'schemaVersion.*2|selectedCandidatePairId|encoderMs|capture.*FPS' docs/需求文档/WebRemoteDesktop-需求文档.md docs/superpowers/reports/2026-07-18-remote-desktop-connection-interaction-performance-diagnostic.md`

Expected: current docs no longer imply pseudo encode/send timing is valid.
