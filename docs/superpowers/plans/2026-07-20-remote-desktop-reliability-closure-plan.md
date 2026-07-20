# Remote Desktop Reliability Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Track every step with the checkboxes below.

**Goal:** Close the reset-barrier fail-open, require an active control lease for manual STUN port search, complete media suspension across WebRTC and tunnel, stabilize tunnel rendering, and collect honest runtime evidence.

**Architecture:** Keep `DesktopControlLease`, `StunPortSearchController`, and `MediaActivityController` as separate canonical truth sources. Signal owns authority and transition barriers, Viewer owns desired media demand and search progress, and Host owns applied keyboard/media state. A new Viewer runtime adapter may track applied media phase, but must never duplicate desired reasons.

**Tech Stack:** Node.js, Socket.IO, browser WebRTC/DOM, JavaScript, Python, asyncio, aiortc, MSS, Node test runner, pytest, Python Playwright.

**Spec Coverage:** `docs/superpowers/specs/2026-07-20-remote-desktop-reliability-closure-design.md`.

## Execution contract

- [ ] Work in a clean isolated worktree based on the latest target branch. Do not implement in a checkout containing staged changes, conflicts, or unrelated dirty files.
- [ ] Before changing code, record `git status --short --branch`, `git rev-parse HEAD`, and the target upstream ref in the worklog.
- [ ] Do not merge or cherry-pick the old `feat/remote-desktop-media-suspension` branch wholesale. It is reference-only because it predates keyboard v2, Terminal hardening, and the current port-search baseline.
- [ ] Execute tasks in order. Reset safety closes before port-search authorization; both close before media runtime work; all automated gates close before runtime acceptance.
- [ ] Every behavior change starts with a failing test, records the RED output, receives the minimum implementation, and records the GREEN output.
- [ ] Keep commits narrow. Never stage runtime credentials, logs, screenshots with secrets, `task_plan.md`, `findings.md`, `progress.md`, or unrelated changes.
- [ ] Do not start, stop, restart, rebuild, or rotate Cloudflare tunnel. `/tmp/wrd-safe-current-url.txt` is the only source of the current public URL. An unreachable URL blocks tunnel acceptance; it does not authorize tunnel mutation.
- [ ] Starting or restarting local services is not part of implementation. If runtime acceptance needs it, first read `README.md` and `docs/runbook-safe-startup.md`, ask the user to start them, and preserve the current tunnel.
- [ ] Do not report synthetic Playwright keyboard injection as physical keyboard or OS-reserved-shortcut acceptance.

## Task 1: Make transition failure fail-closed in the lease state machine

**Files:**

- Modify: `signal-server/lib/desktop-control-lease.js`
- Modify: `signal-server/lib/desktop-control-lease.test.js`
- Modify: `signal-server/websocket/signaling.test.js`

- [ ] Add failing unit cases for all unknown Host outcomes:

  1. A candidate `GRANTING` transition rejected by Host discards its candidate token, increments the epoch once, and enters reset-only `REVOKING`.
  2. A reset-only `REVOKING` rejection stays on the same epoch and does not enter `FREE`.
  3. A candidate transition timeout follows the same candidate-to-reset-only path.
  4. A reset-only timeout stays behind the same barrier.
  5. A stale epoch has no state mutation.
  6. A reset-only `applied` ack is the only ack path into `FREE`.

- [ ] Replace the integration expectation that currently treats Host `reset-failed` as `FREE`; assert `REVOKING`, `pendingViewerId: null`, no active token, and rejection of a new `control-acquire`.

- [ ] Run the RED gate and save the exact failing assertions in the worklog:

  ```bash
  node --test \
    signal-server/lib/desktop-control-lease.test.js \
    signal-server/websocket/signaling.test.js
  ```

  Expected RED: current `rejectTransition()` and timeout behavior expose `FREE`. Failures must be limited to the new assertions.

- [ ] Add `DesktopControlLease.failTransition({ leaseEpoch, reason = 'transition-failed' })` with these invariants:

  ```javascript
  // stale epoch: return stale-transition without mutation
  // reset-only pending: remain REVOKING on the same epoch
  // candidate pending: discard candidate, increment epoch, create reset-only REVOKING
  // never manufacture an ACTIVE token and never enter FREE
  ```

- [ ] Route explicit rejection, malformed/unsupported ack, and transition timeout through `failTransition()`. Keep `applyTransition()` as the sole successful transition path. Do not retain `rejectTransition()` as a competing state transition; if compatibility requires the name temporarily, make it a thin alias and remove all direct callers in this task.

- [ ] Assert the snapshot contains enough non-secret information for the UI and retry layer: `state`, `leaseEpoch`, `pendingViewerId`, and a bounded enum reason such as `reset-failed`, `transition-timeout`, or `execution-failed`. Never expose the lease token.

- [ ] Run the GREEN gate:

  ```bash
  node --test \
    signal-server/lib/desktop-control-lease.test.js \
    signal-server/websocket/signaling.test.js
  ```

  Expected GREEN: every state-machine and signaling case passes; no failed or timed-out Host transition yields `FREE`.

- [ ] Commit only Task 1:

  ```bash
  git add signal-server/lib/desktop-control-lease.js \
    signal-server/lib/desktop-control-lease.test.js \
    signal-server/websocket/signaling.test.js
  git diff --cached --check
  git commit -m "fix(control): keep failed resets behind barrier"
  ```

## Task 2: Add bounded, generation-safe reset recovery and blocked-state UI

**Files:**

- Create: `signal-server/lib/control-transition-retry.js`
- Create: `signal-server/lib/control-transition-retry.test.js`
- Modify: `signal-server/websocket/signaling.js`
- Modify: `signal-server/websocket/signaling.test.js`
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/js/webrtc.test.js`

- [ ] Write a pure scheduler test suite using injected `setTimeout`, `clearTimeout`, and clock functions. Cover delays `[1000, 2000, 4000]`, same-epoch payload reuse, single live timer, cancellation after applied ack, stale-generation callback suppression, Host disconnect cancellation, and exactly one `onBlocked` callback after the third retry.

- [ ] Run the scheduler RED gate:

  ```bash
  node --test signal-server/lib/control-transition-retry.test.js
  ```

  Expected RED: module is absent.

- [ ] Implement `ControlTransitionRetry` as a transport-independent adapter. It may schedule/re-emit the current reset-only effect, but it must not decide lease state, increment epochs, or synthesize success.

- [ ] Integrate the adapter in `signal-server/websocket/signaling.js`:

  - Start retries only for the current reset-only `REVOKING` transition.
  - Re-emit the same epoch and a tokenless Host payload.
  - Cancel on matching applied ack, newer transition generation, Host disconnect, or server teardown.
  - After three unsuccessful retries, keep the lease `REVOKING` and broadcast `reset-blocked`.
  - On Host reconnect, issue the unconditional current reset transition before permitting offers, inputs, media activity, or a new controller.
  - Never drain `pendingOffers` or `pendingInputs` until a successful applied transition establishes `ACTIVE`.

- [ ] Add integration tests proving a blocked reset cannot grant a queued/new Viewer, a stale timer cannot affect a newer epoch, reconnect recovery requires a fresh applied ack, and repeated failures do not create an infinite timer storm.

- [ ] Add Viewer rendering for transition states without creating another authority source:

  - `GRANTING` / ordinary `REVOKING`: “控制权正在切换”。
  - `reset-blocked`: “Host 输入复位未确认，控制已安全锁定”。
  - Disable request-control, desktop input, and port-search affordances while blocked.
  - Render exclusively from the Signal control snapshot/reason.

- [ ] Run Task 2 GREEN gates:

  ```bash
  node --test \
    signal-server/lib/control-transition-retry.test.js \
    signal-server/lib/desktop-control-lease.test.js \
    signal-server/websocket/signaling.test.js
  node --test web-client/js/webrtc.test.js
  ```

- [ ] Record structured events with bounded fields only: `control_transition_failed_closed`, `control_reset_retry`, and `control_reset_blocked`; include epoch, retry index, and enum reason, but not lease token, input payload, SDP, or candidate address.

- [ ] Commit only Task 2:

  ```bash
  git add signal-server/lib/control-transition-retry.js \
    signal-server/lib/control-transition-retry.test.js \
    signal-server/websocket/signaling.js \
    signal-server/websocket/signaling.test.js \
    web-client/js/webrtc.js \
    web-client/js/webrtc.test.js
  git diff --cached --check
  git commit -m "feat(control): recover reset barriers safely"
  ```

## Task 3: Require the current ACTIVE lease for manual STUN port search

**Files:**

- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/js/webrtc.test.js`
- Modify: `web-client/js/stun-port-search-controller.test.js` only if progress-state coverage is missing; do not move authority into the controller

- [ ] Add failing Viewer tests for `startPortSearch()` in each disallowed state: no lease, read-only `ACTIVE`, `FREE`, `GRANTING`, `REVOKING`, `reset-blocked`, Host offline, Socket disconnected, manual disconnect, suspended media, and unsupported network mode.

- [ ] For every disallowed case, assert all side effects remain zero:

  ```text
  StunPortSearchController.create/start = 0
  clearTimeout/setTimeout              = 0
  peerConnection.close                = 0
  refresh/createOffer                 = 0
  socket.emit('control-acquire')       = 0
  ```

- [ ] Add failing tests that control loss during an active search invokes `stopPortSearch('control-lost')`, cancels both timers, increments the generation, and prevents stale round/retry callbacks from refreshing or recording candidates. Exercise revocation, takeover, Host offline, socket disconnect, and media suspension.

- [ ] Run RED:

  ```bash
  node --test \
    web-client/js/stun-port-search-controller.test.js \
    web-client/js/webrtc.test.js
  ```

  Expected RED: current mode/socket/Host checks allow a Viewer without the active lease to call `refresh()`.

- [ ] Add one `canStartPortSearch()` predicate in `web-client/js/webrtc.js`:

  ```javascript
  canStartPortSearch() {
    return ['auto', 'stun'].includes(this.networkMode)
      && Boolean(this.socket?.connected)
      && Boolean(this.controlState?.hostOnline)
      && this.controlState?.state === 'ACTIVE'
      && this.controlState?.controller === true
      && Boolean(this.activeLeaseEnvelope())
      && !this.manualDisconnect
      && this.getMediaActivitySnapshot().state === 'active';
  }
  ```

  Use the repository's actual lease accessor name if it differs; do not add a duplicate lease cache.

- [ ] Call the predicate before creating/mutating any search object in `startPortSearch()`. Use the same predicate to render the button enabled state and a specific reason: “需要控制权”, “控制权正在切换”, “媒体已暂停”, “Host 离线”, or “当前模式不支持”.

- [ ] In the existing control-snapshot, socket, Host, and media-change handlers, stop an active search immediately when the predicate changes from true to false. This stop is cleanup only and must never call `requestControl()`, `createOffer()`, or `refresh()`.

- [ ] Run GREEN:

  ```bash
  node --test \
    web-client/js/stun-port-search-controller.test.js \
    web-client/js/webrtc.test.js
  ```

  Expected GREEN: only the current active controller can search; read-only invocation is a strict no-op; all control-loss paths cancel stale work.

- [ ] Commit only Task 3:

  ```bash
  git add web-client/js/webrtc.js \
    web-client/js/webrtc.test.js \
    web-client/js/stun-port-search-controller.test.js
  git diff --cached --check
  git commit -m "fix(viewer): require control lease for port search"
  ```

## Task 4: Define and enforce the lease-bound media-activity contract

**Files:**

- Create: `signal-server/lib/media-activity-contract.js`
- Create: `signal-server/lib/media-activity-contract.test.js`
- Modify: `signal-server/websocket/signaling.js`
- Modify: `signal-server/websocket/signaling.test.js`
- Modify: `python-host/host.py`
- Modify: `python-host/test_offer_epoch.py`

- [ ] Add contract tests accepting only this versioned Viewer request shape:

  ```json
  {
    "schemaVersion": 1,
    "state": "active|suspended",
    "reasons": [],
    "generation": 12,
    "connectionAttemptId": "wrd-...",
    "leaseId": "...",
    "leaseEpoch": 42
  }
  ```

  Reject unknown schema, invalid state, unbounded/unknown reasons, missing generation/attempt/lease fields, oversized payload, and extra fields that could become covert input. Redact the leaseId from logs.

- [ ] Add Signal integration tests proving only the current `ACTIVE` controller's exact lease envelope can send `media-activity-change`; read-only, stale epoch/token, pending transition, disconnected, and legacy/unversioned requests are rejected and never forwarded. Signal must inject trusted `viewerId` rather than trust a client-supplied identity.

- [ ] Add ordering tests: Signal forwards only monotonically newer generation for the active `connectionAttemptId`; takeover/revoke/disconnect emits or applies suspension for the old controller before a new controller can write; late ack from an old attempt cannot change the new attempt.

- [x] Post-review: tunnel `connection-attempt-bind` with monotonic `connectionAttemptSequence`; split attempt binding from generation progress so `applied:false` only reopens one generation replay; Direct offer and tunnel bind share one Signal authority record.


- [ ] Run Node RED:

  ```bash
  node --test \
    signal-server/lib/media-activity-contract.test.js \
    signal-server/websocket/signaling.test.js
  ```

  Expected RED: the contract module and authorized route do not exist.

- [ ] Implement validation as a pure module, then add the Signal route. Keep `DesktopControlLease` as the only authority query; `media-activity-contract` validates shape, not ownership. Forward only validated normalized fields plus trusted Viewer identity.

- [ ] Add Host RED tests in `python-host/test_offer_epoch.py` for stale lease, stale generation, wrong attempt, read-only Viewer, suspend-before-offer, and ack payload. Assert invalid requests do not touch capture, sender, relay, or input state.

- [ ] Run Python RED:

  ```bash
  python3 -m pytest -q python-host/test_offer_epoch.py
  ```

- [ ] Add the Host event entrypoint and per-offer media binding. The Host must validate Signal-provided viewer/attempt/generation against its current active offer and control binding, serialize application under an asyncio lock, and return:

  ```json
  {
    "schemaVersion": 1,
    "state": "suspended",
    "generation": 12,
    "connectionAttemptId": "wrd-...",
    "applied": true
  }
  ```

  A rejected or stale request returns a bounded status but must not echo the leaseId.

- [ ] Run Task 4 GREEN:

  ```bash
  node --test \
    signal-server/lib/media-activity-contract.test.js \
    signal-server/websocket/signaling.test.js
  python3 -m pytest -q python-host/test_offer_epoch.py
  ```

- [ ] Commit only Task 4:

  ```bash
  git add signal-server/lib/media-activity-contract.js \
    signal-server/lib/media-activity-contract.test.js \
    signal-server/websocket/signaling.js \
    signal-server/websocket/signaling.test.js \
    python-host/host.py python-host/test_offer_epoch.py
  git diff --cached --check
  git commit -m "feat(media): authorize activity by control lease"
  ```

## Task 5: Suspend aiortc sending and screen capture at the Host

**Files:**

- Create: `python-host/aiortc_media_sender.py`
- Create: `python-host/test_aiortc_media_sender.py`
- Modify: `python-host/host.py`
- Create: `python-host/test_media_suspension.py`
- Modify: `python-host/test_media_profile.py`

- [ ] Write adapter tests for a small `AiortcMediaSender` boundary. Verify suspend disables the video sender without closing the transceiver/PC, resume re-enables it and requests exactly one keyframe, repeated same-state calls are idempotent, and a replaced/stopped sender invalidates stale work.

- [ ] Isolate aiortc version-specific or private keyframe behavior inside this adapter only. Feature-detect the private hook; if unavailable, resume remains correct and reports `keyframeRequested:false` instead of reaching into aiortc elsewhere.

- [ ] Run adapter RED:

  ```bash
  python3 -m pytest -q python-host/test_aiortc_media_sender.py
  ```

- [ ] Implement the minimal adapter and run it GREEN. Do not renegotiate, restart ICE, remove the track, or close DataChannels when suspending.

- [ ] Write `ScreenCaptureTrack` RED tests using fake capture/clock/condition dependencies. Cover:

  - suspend wakes `recv()` and prevents a new MSS grab;
  - pending frame/input timing buffers are cleared once;
  - 15 seconds suspended produces `captureSeq` delta 0, allowing at most one already in-flight frame at transition;
  - resume waits for and returns a freshly captured frame, not the pre-suspend frame;
  - repeated suspend/resume is idempotent;
  - stop/shutdown wakes blocked waiters and does not leak a thread/task.

- [ ] Run capture RED:

  ```bash
  python3 -m pytest -q \
    python-host/test_media_suspension.py \
    python-host/test_media_profile.py
  ```

- [ ] Add a condition-backed `ScreenCaptureTrack.set_suspended(bool)` and a monotonic capture generation. Suspension must gate before MSS capture, resize/conversion, VideoFrame allocation, encode handoff, and capture-sequence increment. Resume must notify waiters and demand a new frame. Stop must notify all waiters.

- [ ] Apply Host state in this order:

  1. disable desktop input for the attempt;
  2. suspend sender;
  3. suspend capture and clear pending buffers;
  4. stop tunnel relay production if that adapter is active;
  5. emit `media-activity-ack` only after every applicable step succeeds.

  Resume in dependency order: capture ready, sender enabled/keyframe requested, then ack. Viewer input remains disabled until the Viewer receives the matching ack and renders a fresh frame.

- [ ] Add failure tests: any failed step yields `applied:false`, remains safe/suspended, and does not partially re-enable input. A newer generation supersedes the failure; stale completion cannot acknowledge success.

- [ ] Run Task 5 GREEN:

  ```bash
  python3 -m pytest -q \
    python-host/test_aiortc_media_sender.py \
    python-host/test_media_suspension.py \
    python-host/test_media_profile.py \
    python-host/test_offer_epoch.py
  ```

- [ ] Add bounded structured events `host_media_suspended` and `host_media_resumed` with generation, attemptId, mode, captureSeq, sender-enabled flag, and keyframe-requested flag. Exclude images, candidate addresses, lease token, and input contents.

- [ ] Commit only Task 5:

  ```bash
  git add python-host/aiortc_media_sender.py \
    python-host/test_aiortc_media_sender.py \
    python-host/host.py \
    python-host/test_media_suspension.py \
    python-host/test_media_profile.py \
    python-host/test_offer_epoch.py
  git diff --cached --check
  git commit -m "feat(host): suspend media capture and sender"
  ```

## Task 6: Apply media state in the Viewer without duplicating desired truth

**Files:**

- Create: `web-client/js/media-activity-runtime.js`
- Create: `web-client/js/media-activity-runtime.test.js`
- Modify: `web-client/viewer.html`
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/js/webrtc.test.js`
- Modify: `web-client/js/input.js`
- Modify: `web-client/js/input.test.js`
- Modify: `web-client/js/latency-monitor.js`
- Modify: `web-client/js/latency-monitor.test.js`

- [ ] Write pure runtime-state tests for exactly four applied phases:

  ```text
  active -> suspending -> suspended -> resuming -> active
  ```

  `MediaActivityRuntime` may own applied phase, attemptId, generation, request timeout, and last ack. It must not store/recompute manual, Terminal, lifecycle, hidden, or disconnected reasons; those remain solely in `MediaActivityController`.

- [ ] Cover same-generation idempotency, newer desired generation, stale ack, wrong attempt, timeout, disconnect/reset, and mode switch. A late suspended ack must not override a newer resuming request.

- [ ] Run runtime RED:

  ```bash
  node --test web-client/js/media-activity-runtime.test.js
  ```

- [ ] Implement the pure runtime and load it before `webrtc.js` in `viewer.html`. Use injected timers and callbacks so tests are deterministic.

- [ ] Add `webrtc.js` RED cases for `applyMediaActivity(snapshot)`:

  - desired suspend immediately moves to `suspending`, disables desktop input, stops port search, clears media-health timers/samplers, and sends one lease-bound request through the adapter selected by `networkMode`;
  - matching Host ack moves to `suspended`;
  - desired active moves to `resuming` but leaves input disabled;
  - matching active ack plus the first newly rendered frame moves to `active` and only then enables input;
  - stale/wrong attempt ack and pre-resume frame are ignored;
  - Terminal Socket/session stays connected throughout;
  - pause does not close the PC, ICE, main Socket, DataChannels, or Terminal.

- [ ] Add one canonical `isMediaHealthSuppressed()` predicate covering `suspending`, `suspended`, and `resuming`. Route every zero-FPS, frozen-frame, degraded-quality, media-stalled, retry, ICE-refresh, port-search, reconnect, and adaptive recovery decision through it. Use `rg` to enumerate and log every guarded callsite before implementation:

  ```bash
  rg -n "0.?FPS|media-stalled|degrad|reconnect|refresh\(|startPortSearch|setInterval|setTimeout|frozen|jitter" \
    web-client/js/webrtc.js web-client/js/latency-monitor.js
  ```

- [ ] Add one `canEnableDesktopInput()` predicate requiring all of: current active control lease, applied runtime phase `active`, current connection attempt, and a post-resume rendered frame. Make `input.js` obey that predicate for keyboard, mouse, double-click, drag, wheel, command, and synthetic release paths. Suspending must still allow local cleanup/release bookkeeping while suppressing remote writes.

- [ ] Add `latency-monitor` tests proving intentional suspension neither records false 0-FPS incidents nor degrades the profile/reconnects; on resume, baselines reset before new samples.

- [ ] Run Task 6 GREEN:

  ```bash
  node --test \
    web-client/js/media-activity-controller.test.js \
    web-client/js/media-activity-lifecycle.test.js \
    web-client/js/media-activity-runtime.test.js \
    web-client/js/webrtc.test.js \
    web-client/js/input.test.js \
    web-client/js/latency-monitor.test.js
  ```

- [ ] Emit `media_activity_requested` and `media_resume_timeout` with phase, desired generation, attemptId, mode, and bounded reason enums. Do not log leaseId, text, keys, SDP, or candidate IPs.

- [ ] Commit only Task 6:

  ```bash
  git add web-client/js/media-activity-runtime.js \
    web-client/js/media-activity-runtime.test.js \
    web-client/viewer.html \
    web-client/js/webrtc.js web-client/js/webrtc.test.js \
    web-client/js/input.js web-client/js/input.test.js \
    web-client/js/latency-monitor.js web-client/js/latency-monitor.test.js
  git diff --cached --check
  git commit -m "feat(viewer): apply media suspension lifecycle"
  ```

## Task 7: Suspend tunnel production and stabilize the rendered viewport

**Files:**

- Modify: `python-host/host.py`
- Modify: `python-host/test_tunnel_relay.py`
- Modify: `signal-server/websocket/signaling.js`
- Modify: `signal-server/websocket/signaling.test.js`
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/js/webrtc.test.js`
- Modify: `web-client/css/viewer.css`

- [ ] Write Host relay RED tests proving suspended tunnel mode performs no new MSS capture, resize, JPEG encode, or `relay-frame` emission; clears/invalidates pending frame state; tolerates one frame already in flight; preserves relay ack, main Socket, control lease, and Terminal; and resumes with a fresh frame.

- [ ] Add Signal RED tests that stale or unauthorized media activity cannot stop/start relay production, and old-controller `relay-frame` is not delivered after takeover. Verify the forwarded event is tied to trusted Viewer identity and current attempt.

- [ ] Add Viewer RED tests that suspension revokes pending `relayImage.onload`, object URLs, FPS sampler state, and delayed acks without removing the persistent rendered box. Resume accepts only a fresh generation frame and sends the matching frame ack.

- [ ] Run RED:

  ```bash
  python3 -m pytest -q python-host/test_tunnel_relay.py
  node --test \
    signal-server/websocket/signaling.test.js \
    web-client/js/webrtc.test.js
  ```

- [ ] Gate the relay producer before capture/encode and generation-tag all frame work. On suspend, stop new production and invalidate queued work; do not merely hide the image or drop it after encoding. On resume, reset relay timing/backpressure baseline and produce a new frame immediately within the existing adaptive profile.

- [ ] Use `networkMode` as the single adapter selector. A desired transition sends either the WebRTC media contract or tunnel relay control for that attempt, never both. A mode change cancels the old adapter generation before applying the new one.

- [ ] Fix viewport resizing at the Viewer layout boundary. Preserve the outer media container dimensions while adaptive source frames change between 960×540, 640×360, and 480×270. Apply the same containment rules to both renderers:

  ```css
  #remoteVideo,
  #relayImage {
    width: 100%;
    height: 100%;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  ```

  Preserve the user's existing `contain` / `cover` / `fill` mode classes by giving those classes intentional, tested overrides. Do not use intrinsic image size to size the container. Do not disable Host adaptive tunnel resolution, because that would trade visual stability for latency/bandwidth regression.

- [ ] Add a DOM geometry test in `web-client/js/webrtc.test.js`: inject three differently sized relay frames and assert the renderer/container bounding box is unchanged, pointer normalization still uses the rendered content rectangle, and no resize triggers reconnection or an offer.

- [ ] Run Task 7 GREEN:

  ```bash
  python3 -m pytest -q python-host/test_tunnel_relay.py
  node --test \
    signal-server/websocket/signaling.test.js \
    web-client/js/webrtc.test.js \
    web-client/js/input.test.js
  ```

- [ ] Commit only Task 7:

  ```bash
  git add python-host/host.py python-host/test_tunnel_relay.py \
    signal-server/websocket/signaling.js signal-server/websocket/signaling.test.js \
    web-client/js/webrtc.js web-client/js/webrtc.test.js \
    web-client/js/input.test.js web-client/css/viewer.css
  git diff --cached --check
  git commit -m "feat(tunnel): suspend relay and stabilize viewport"
  ```

## Task 8: Close automated regression, observability, and active documentation

**Files:**

- Modify: `README.md`
- Modify: `docs/runbook-safe-startup.md`
- Modify: relevant files under `docs/需求文档/` found with `rg -n "控制权|端口搜索|媒体暂停|tunnel|远程桌面" docs/需求文档`
- Modify: `docs/superpowers/reports/2026-07-18-remote-desktop-connection-interaction-performance-diagnostic.md`
- Create: `docs/superpowers/reports/2026-07-20-remote-desktop-reliability-closure-evidence.md`

- [ ] Run the full targeted automated matrix and capture command, commit hash, timestamp, pass/fail count, and failures in the evidence report:

  ```bash
  node --test \
    signal-server/lib/desktop-control-lease.test.js \
    signal-server/lib/control-transition-retry.test.js \
    signal-server/lib/media-activity-contract.test.js \
    signal-server/lib/remote-input-contract.test.js \
    signal-server/websocket/signaling.test.js \
    web-client/js/stun-port-search-controller.test.js \
    web-client/js/media-activity-controller.test.js \
    web-client/js/media-activity-lifecycle.test.js \
    web-client/js/media-activity-runtime.test.js \
    web-client/js/remote-keyboard-controller.test.js \
    web-client/js/keyboard-transport.test.js \
    web-client/js/input.test.js \
    web-client/js/latency-monitor.test.js \
    web-client/js/webrtc-stats.test.js \
    web-client/js/webrtc.test.js

  python3 -m pytest -q \
    python-host/test_remote_keyboard_state.py \
    python-host/test_input_handler.py \
    python-host/test_offer_epoch.py \
    python-host/test_aiortc_media_sender.py \
    python-host/test_media_suspension.py \
    python-host/test_media_profile.py \
    python-host/test_tunnel_relay.py \
    python-host/test_connection_diagnostics.py
  ```

- [ ] Run broader repository gates exposed by `package.json`, Signal package scripts, and Python test configuration. Record unavailable dependencies as blockers; do not silently narrow the result. At minimum run `npm test` when it is the repository's defined test gate.

- [ ] Verify log safety with a targeted search and a test that captures structured event output. No event may contain lease token, password, input text, key value, Terminal IO, SDP, image payload, or ICE candidate address.

- [ ] Update active docs to state:

  - unknown reset outcome is fail-closed and can display reset-blocked;
  - manual port search is controller-only and never requests control;
  - pause stops capture/encode/payload/input but preserves signaling, ICE/DataChannel, and Terminal;
  - tunnel viewport is stable while the Host adaptive profile remains enabled;
  - no TURN, VPS, Viewer native client, or fixed UDP port is introduced;
  - local restart never restarts/rebuilds tunnel.

- [ ] In the diagnostic ledger, mark only automated items as automated-closed. Leave dual Viewer, real Host video, ordinary-browser keyboard, physical/system shortcuts, mouse, Terminal, and public tunnel rows as runtime pending until Task 9 produces evidence.

- [ ] Commit Task 8 only after `git diff --check` and docs/code consistency review:

  ```bash
  git add README.md docs/runbook-safe-startup.md docs/需求文档 \
    docs/superpowers/reports/2026-07-18-remote-desktop-connection-interaction-performance-diagnostic.md \
    docs/superpowers/reports/2026-07-20-remote-desktop-reliability-closure-evidence.md
  git diff --cached --check
  git commit -m "docs(remote): record reliability closure gates"
  ```

## Task 9: Perform staged runtime acceptance with two real Viewer contexts

**Prerequisites:** Tasks 1–8 are GREEN and committed. Runtime services are started by the user. Before checking them, read `README.md`, `docs/runbook-safe-startup.md`, and the `webremote-service` skill. Use the `webapp-testing` skill for browser automation. Do not restart or rebuild tunnel.

**Evidence target:**

- Modify: `docs/superpowers/reports/2026-07-20-remote-desktop-reliability-closure-evidence.md`
- Store redacted screenshots/traces only under the repo's existing accepted evidence directory; otherwise reference local artifact paths without committing them

- [ ] Establish live truth before opening browsers:

  ```bash
  ./scripts/status-safe-wrd.sh
  test -f /tmp/wrd-safe-current-url.txt && sed -n '1p' /tmp/wrd-safe-current-url.txt
  ```

  Record Host and Signal PIDs/status, current URL-file presence/value, local Viewer HTTP result, public DNS/HTTP result, current commit, timestamp, browser version, screen size, network mode, and whether the Host has Screen Recording and Accessibility permissions. Read passwords only from runtime configuration when login is required; never put them in the report, trace, screenshot, or console capture.

- [ ] If local services are not running, stop and ask the user to start them. If the public URL is unreachable, mark only tunnel acceptance blocked and continue all local/direct evidence that remains possible. Never invoke `scripts/run-safe-quicktunnel.sh`, `cloudflared`, or `stop-safe-wrd.sh`.

### Gate 9A: Real dual-Viewer ownership and reset safety

- [ ] Launch two independent ordinary Chrome contexts (A and B), not two pages sharing one storage/session context. Authenticate both through the normal Viewer page.
- [ ] Acquire control in A. Confirm A is the only writer and B is read-only. Capture Signal control snapshot and Host active binding without recording lease tokens.
- [ ] In B, invoke the port-search UI and the exposed method. Assert no `control-acquire`, no offer/PC close, no refresh, no search timer, and no Host candidate activity.
- [ ] Start a search in A, then explicitly take over from B. Assert A's search stops as `control-lost`, stale callbacks do nothing, A's keyboard/mouse/command/media/search writes fail, and only B can write after the Host transition ack.
- [ ] Exercise a reset failure in a controlled test hook or fault-injection path that does not corrupt the real Host. Assert both Viewers show safe lock/reset-blocked, neither can write or acquire, retries are 1s/2s/4s on one epoch, and successful Host reset ack is required before recovery. If no safe runtime fault hook exists, record this row as automated-only and do not kill or modify the Host to simulate it.
- [ ] Repeat takeover once in the opposite direction and once with the old controller tab closing during the transition. At every observation point the number of active writers must be exactly zero during barrier or one after applied ack, never two.

### Gate 9B: WebRTC media, input, and performance

- [ ] Confirm the selected candidate pair from `RTCPeerConnection.getStats()`: local/remote candidate types, protocol, and relay/direct classification. Redact addresses. The current architecture expects host/srflx without TURN; a relay candidate is a finding, not something to conceal.
- [ ] From connect start, measure first decoded frame and first non-black rendered frame. Record FPS, jitter, packets lost, frames decoded/dropped, inbound payload bytes, RTT where available, render dimensions, and 30-second stability.
- [ ] Suspend for 15 seconds. Required evidence: Host `captureSeq` delta 0 (allow at most one already in-flight frame), RTP video payload bytes do not grow, and no new frame renders. Exclude RTCP/ICE/DTLS keepalive from the payload assertion. Confirm Signal/ICE/DataChannels/Terminal stay connected and no reconnect/ICE restart/media-stalled/profile degradation fires.
- [ ] Resume 20 times. For each run measure request-to-matching-ack and request-to-first fresh rendered frame. WebRTC first rendered frame P95 must be at most 1500 ms. Input remains disabled until the fresh frame; after it renders, mouse/keyboard recover without reconnect.
- [ ] Verify mouse double-click and drag release on the real Host: double-click opens/selects exactly once; drag continues while held and ends immediately on release; release outside video, blur, and control takeover produce no stuck button.

### Gate 9C: Ordinary-browser keyboard and Terminal

- [ ] In ordinary Chrome with the real Host, execute the keyboard matrix from `docs/superpowers/specs/2026-07-19-remote-keyboard-state-reliability-design.md`, K-01 through K-13. Include left/right modifiers, repeated keydown, long hold, keyup after blur, reconnect, takeover, `Ctrl/Cmd/Alt/Shift` combinations, CapsLock/NumLock where supported, composition/IME boundaries, and browser-reserved shortcuts.
- [ ] Separate evidence labels:

  - `browser-protocol`: Playwright/CDP dispatched key events and Host telemetry;
  - `physical-keyboard`: user physically pressed the key;
  - `os-reserved`: the OS/browser may intercept before the page.

  Do not close `physical-keyboard` or `os-reserved` rows from synthetic dispatch. Any shortcut that navigates/closes the Viewer must prove the Host receives releases or Signal/Host cleanup clears pressed state.
- [ ] For each case assert the Host pressed-key set returns to zero, modifier mask clears, no duplicate command occurs, and the old Viewer cannot write after takeover. Never log actual printable key content or passwords.
- [ ] Open Terminal through the normal UI. Verify password entry is not echoed into diagnostics, Enter submits once, Ctrl-C works, an alternate-screen program enters/exits cleanly, resize remains aligned, desktop pause does not disconnect Terminal, takeover obeys Terminal's documented authority boundary, and no stuck keyboard state leaks between Terminal and desktop.

### Gate 9D: Public tunnel media and stable viewport

- [ ] Open the exact URL from `/tmp/wrd-safe-current-url.txt` in an ordinary Chrome context. Record DNS/HTTP and page-load evidence. Do not substitute a newly generated URL.
- [ ] Force/observe tunnel fallback through the product's existing mode selector. Confirm first non-black frame, FPS, frame-ack/backpressure, input ack, and 30-second stability.
- [ ] Suspend for 15 seconds. Required evidence: no new Host capture/JPEG encode, no new `relay-frame`, no new render, Signal/Terminal remain connected, and no automatic WebRTC/tunnel churn occurs because intentional suspension is not failure.
- [ ] Resume 20 times. Tunnel first rendered frame P95 must be at most 2500 ms. Confirm the first frame is fresh and no stale object URL/frame overwrites it.
- [ ] Observe adaptive frames at 960×540, 640×360, and 480×270, or use the product's safe test fixture if live adaptation does not visit all three. Assert the outer rendered viewport remains the same CSS size, aspect-preserving content is letterboxed/cropped according to the selected scale mode, pointer mapping stays correct, and no source-size change triggers offer/reconnect.

- [ ] For every runtime row, record one of `PASS`, `FAIL`, `BLOCKED`, or `NOT RUN`, plus timestamp, commit, mode, evidence pointer, and reason. A missing Viewer, unavailable browser automation, missing permission, dead public URL, or lack of physical-keyboard assistance is a blocker—not a pass.

- [ ] Stop only browser contexts/processes created by this acceptance. Leave user services and tunnel untouched. Verify the URL-file value is unchanged before/after.

- [ ] Commit the redacted runtime evidence only when it contains no secrets and accurately distinguishes automatic, ordinary-browser, and physical evidence:

  ```bash
  git add docs/superpowers/reports/2026-07-20-remote-desktop-reliability-closure-evidence.md
  git diff --cached --check
  git commit -m "test(remote): record live reliability acceptance"
  ```

## Task 10: Final architecture review, closure decision, and push

- [ ] Review the complete implementation range against the design. Findings come first and must cover correctness, security/privacy, single-truth ownership, stale generation/epoch handling, timer/task cleanup, WebRTC semantics, tunnel semantics, keyboard v2 preservation, Terminal preservation, docs sync, and regression risk.
- [ ] Re-run all Task 8 automated gates on the exact final commit. Do not rely on earlier output after runtime-evidence edits or conflict resolutions.
- [ ] Verify repository hygiene:

  ```bash
  git status --short
  git diff --check
  git log --oneline --decorate -12
  git rev-list --left-right --count @{upstream}...HEAD
  ```

- [ ] Closure rules:

  - The three implementation items close only if all targeted automated tests pass and the code review has no open P0/P1 finding.
  - Dual Viewer, ordinary-browser keyboard, mouse, Terminal, direct media, and tunnel rows close only from Task 9 evidence.
  - Any FAIL remains in the remediation ledger with owner, exact reproduction, severity, and next action.
  - Any BLOCKED/NOT RUN remains explicitly open; do not rewrite it as “验收通过”.

- [ ] Update the evidence report and the 2026-07-18 diagnostic ledger with final status and exact commit hashes. Ensure no duplicated roadmap branch is created.
- [ ] Use the `superpowers:verification-before-completion`, `superpowers:requesting-code-review`, and `git-commit` skills before the final commit/push. Stage only the intended final docs if they changed.
- [ ] Fetch and prove the push is fast-forward; never force:

  ```bash
  git fetch origin
  git rev-list --left-right --count origin/feat/single-public-entry-manual-fallback...HEAD
  git push origin HEAD:feat/single-public-entry-manual-fallback
  git ls-remote --heads origin feat/single-public-entry-manual-fallback
  ```

  Push only when the remote target is an ancestor of `HEAD` and the output is not a non-fast-forward rejection. If it diverged, stop and report both tips; do not merge unrelated work or force-push without user direction.

## Definition of done

- [ ] Host transition rejection, timeout, malformed ack, and lost ack never expose `FREE` while Host input state is unknown.
- [ ] Reset retries are same-epoch, generation-safe, bounded to 1s/2s/4s, and end in observable fail-closed `reset-blocked`.
- [ ] Manual STUN port search requires the current ACTIVE lease, cannot request/take control, and cancels all stale work on control loss.
- [ ] Media suspension stops desktop input, capture, resize/conversion, WebRTC encode/payload, tunnel JPEG encode/frame emission, and false health recovery while preserving signaling, ICE/DataChannels, and Terminal.
- [ ] Resume uses matching attempt/generation ack plus a fresh rendered frame before input; P95 is ≤1500 ms WebRTC and ≤2500 ms tunnel.
- [ ] Tunnel source resolution may adapt without changing the outer Viewer viewport or pointer geometry.
- [ ] Two Viewer contexts demonstrate exactly one writer, old-controller write rejection, explicit takeover, and safe transition barriers.
- [ ] Keyboard K-01–K-13, mouse, Terminal, first/non-black frame, selected candidate pair, FPS/jitter, and tunnel acceptance have honest evidence labels; unperformed physical/system cases remain open.
- [ ] No TURN, VPS, native Viewer client, fixed UDP port, or Cloudflare tunnel mutation is introduced.
- [ ] Code, active requirements, runbook, diagnostic ledger, evidence report, commits, and remote branch agree on the final state.
