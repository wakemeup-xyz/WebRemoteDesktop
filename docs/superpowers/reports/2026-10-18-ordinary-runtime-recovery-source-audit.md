# Ordinary Viewer runtime recovery — focused source audit

2026-10-18. Read-only production Viewer/Signal source inspection in `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`. Parent supplied Viewer build `79bf9a5afea0458e` and unchanged Viewer source through the current documentation/Host work; this audit does not independently prove deployment. Read both requested prior assessments first. No tracked/index edits, tests, builds, browser, network, service or native operations. Did not inspect the mutable Host patch. Only this requested `/tmp` report was written.

## Findings

### P1 — Reconnect after completed grace reset never requests its replacement control lease

**Primary location:** `web-client/js/webrtc.js:4045-4047` (`requestControl`, automatic ACTIVE/noncontroller return). Related exact anchors: `:3994-3996`, `:4003-4010`, `:3803-3816`, `:4101-4134`, `:4213-4234`; server `signal-server/websocket/signaling.js:1104-1128`.

Concrete ordinary scenario:

1. A human ordinary Viewer has ACTIVE control, then its signaling connection drops. `freezeControl('signal-disconnect')` cancels acquire intent and clears `controller`/`lease`, **but preserves `controlState.state === 'ACTIVE'`** (`:4215-4216`, `:4234`). Input correctly closes.
2. The original socket's grace expires while the client is offline. Host completes the existing reset-only barrier, leaving the server FREE before the same current ordinary admission generation resumes. This is an explicitly supported path in requirements `docs/需求文档/WebRemoteDesktop-需求文档.md:564-566`; no new ticket or takeover is involved.
3. With the old Viewer already removed there is no rebind or superseded Viewer to broadcast a state before welcome. Server sends `connected` first (`signaling.js:1115`), then current FREE `control-state` (`:1125`).
4. On welcome the client stores its valid ordinary generation and calls `requestControl({ allowTakeover: false })` (`webrtc.js:3804-3816`). The stale local ACTIVE/noncontroller state causes the return at `:4046-4047`. The newly remembered acquire intent remains `waiting:false` (`:3994-3996`); no `control-acquire` goes over the wire.
5. The following authoritative FREE state reaches `handleControlState`, which calls `_resumeControlAcquireIntent` (`:4134`). That helper refuses the non-waiting intent (`:4005`), so no replacement grant can start. Server intentionally never auto-acquires for a newly admitted socket (`signaling.js:1105`). A surviving media peer may continue displaying while input stays disabled indefinitely; periodic FREE truth also cannot change this non-waiting intent. Ordinary media refresh does not supply the missing control acquisition.

The outcome depends on reconnect arriving **after reset completes**. Reconnecting while REVOKING is still observable can mark the intent waiting and avoid it; successful in-grace Host rebind independently sends a grant and also avoids it. This timing distinction explains why standalone server rebind tests or short reconnect observations can miss the failure. This is a source-established product bug, not a claim about the strict proof run's 75 ms post-close window.

**Targeted behavioral RED recommendation (not executed):** drive the actual Viewer socket handlers from an established ACTIVE ordinary session, emit its disconnect, then reconnect with the server's actual `connected(hostOnline:true, same ordinary generation)` → `control-state(FREE, controller:false)` ordering after the grace/reset fixture reaches FREE. Assert exactly one bounded `control-acquire` with `takeover:false`, no admission HTTP request, and continued disabled input until the existing Host grant/reset/media conditions hold. Current code emits zero acquires. Cover both the same Socket.IO object with a new socket ID and watchdog replacement. Countercases must keep newer human ownership, superseded/manual-release/cancel and stale socket callbacks unable to acquire or reopen input. Preserve all server admission and Host reset barriers; do not solve by enabling takeover or pregranting control.

### P2 — Socket replacement can leave a spent signaling-watchdog handle permanently blocking rearming

**Primary location:** `web-client/js/webrtc.js:6872-6874` (ownership return precedes handle retirement). Related exact anchors: `:6863-6865`, `:2805-2817`, `:2820-2845`, `:5894-5900`, `:3790-3800`.

Concrete supported UI path:

1. A disconnected ordinary socket A already has `_signalRecoveryTimer` scheduled by its disconnect handler.
2. While it is still disconnected the user switches network mode. `setNetworkMode` calls `quiesceDisconnectedSocket()` and async `init()` (`:5899-5900`). Quiesce makes `this.socket=null` but does not retire/transfer the signaling recovery timer (`:2811`). Init eventually creates socket B.
3. A's timer fires either during the config await (`this.socket===null`) or after B replaces it. The identity guard returns at `:6873` **without clearing the stored handle** at `:6874`. The timer has finished but `_signalRecoveryTimer` remains non-null.
4. A B `connect_error` correctly calls `scheduleSignalingRecovery`, but its non-null-handle guard (`:6865`) treats that finished timer as live. Subsequent errors behave the same. Until a successful connection or another unrelated explicit cleanup, the 12-second manager-recreation fallback never runs. Socket.IO's own retries may still recover; if its manager is in the dead-transport condition the watchdog explicitly exists to resolve (`:6883-6885`), the Viewer remains disconnected despite user mode change and connection-error notifications.

This is a bounded lifecycle bug in the recovery watchdog, not evidence that every ordinary automatic retry fails. It is especially relevant to the requested quiesce/init audit and attempts to recover a failing connection by using the existing network UI.

**Targeted behavioral RED recommendation (not executed):** fake-clock the real disconnect handler → real disconnected `setNetworkMode`/config-await path, let A's timer run while socket identity is retired, then create B and deliver B `connect_error`. Advance past the unchanged existing recovery max-wait and require one current-socket recreation, with old callbacks unable to create a peer, replace B, or clear a newer timer. Current code leaves the expired A handle and performs zero watchdog recreations. Include config resolving before and after A's timer. Fix timer-handle ownership/transfer and current-owner scheduling without weakening socket/episode fences or extending deadlines.

## Checked behavior and boundaries

- Ordinary explicit admission is requested only by Start/reclaim; response publication checks startup episode, request sequence, auth token/generation and verified state (`webrtc.js:2859-2878`). Server owner generation survives grace/ticket expiry independently (`signal-server/lib/viewer-admission.js:35-56`). Welcome updates both in-memory admission and the active Socket.IO auth object (`webrtc.js:3803-3807`); replacement sockets use that admission (`:2981-2996`). No automatic remint path found.
- Rejected old-owner admission exits before map/proof/lease changes (`signaling.js:1082-1099`). Client rejection retires through superseded handling (`webrtc.js:3901-3907`). This human priority must remain unchanged.
- Current socket and startup episode guard socket listeners (`webrtc.js:3744-3750`). Startup retirement invalidates before producer cleanup (`:2499-2526`); peer-owner callbacks retain episode/attempt/sequence constraints. Established peer retention deliberately differs from pending-start socket transfer (`:2399-2408`, `:6793-6857`). No independent startup/auth race finding established in this inspection.
- In-grace migration gates the new server socket pending exact Host ACK; operation/socket/Host/lease/attempt identity checks and timeout/reject reset path are present (`signaling.js:435-570`). Client suspends input and retains sequence ownership during signaling loss (`input.js:427-440`), then rebinds/reset-recovers through the existing grant path. This review did not inspect changing Host code or claim end-to-end in-grace correctness from server inspection alone.
- Stale answer/ICE handling lacks a full wire attempt identifier at the Signal forwarding boundary (`signaling.js:1355-1383`); the Viewer checks current socket/episode and local signaling state, with post-await ownership checks for answers (`webrtc.js:3862-3897`). Without inspecting mutable Host emission/retirement behavior, this audit does **not** promote that observation into a confirmed persistent-recovery bug.
- Strict proof nonresumability is intentional. LongA WebSocket 1006 plus live media establishes an interruption, not ordinary recovery failure. Its strict continuity result remains INCOMPLETE and cannot be repaired by these findings or later successful recovery.

## Diagnostics relevant to the findings

Current source has the server disconnect event with normalized reason (`signaling.js:1961-1969`), grace/rebind/reset events, client disconnect/connect-error console entries and watchdog recreation messages. It lacks a concise bounded client recovery transition explaining why welcome did not send acquire: socket-generation-local old control state, authoritative welcome/state ordering, acquire-intent waiting/budget and early-return reason. Finding 1 therefore looks like healthy media plus permanently disabled input without an explicit failed control acquisition. Finding 2's stale timer branch is silent and does not distinguish scheduled, fired-stale and retired timer ownership.

For any later authorized diagnostic increment, use bounded enums/counters and salted equality identities to record disconnect → resumed welcome → current control snapshot → acquire decision → rebind/reset/grant → reset/fresh-frame/input gate outcome, plus watchdog scheduled/fired-stale/replaced/cleared status. Do not log raw admissions/session IDs/tokens/input/coordinates. Transport 1006 still cannot identify its upstream cause, and media/gate readiness cannot substitute for real business-input or visible-effect measurements.

## Minimal correction and existing test homes (parent-requested follow-up)

For P1, the bounded candidate is to preserve the existing automatic ACTIVE/noncontroller early return **and mark its already-created current-socket acquire intent `waiting=true`** before returning. Do not flip local control state, emit takeover, acquire while ACTIVE, replenish `remaining`, or alter admission. A subsequent authoritative FREE can then spend the existing single retry through `_resumeControlAcquireIntent`; real ACTIVE other-owner state remains non-acquiring. Verify manual release, superseded, socket replacement and repeated FREE against the same existing cancellation/budget logic. This small production correctness fix should precede broader ordinary-runtime qualification tooling.

Existing targeted VM homes found by read-only inspection:

- `web-client/js/input-signaling-continuity.test.js:350-395`, `reconnectBridge()`, already connects actual Signal handlers with the Viewer VM and actual control-result/state/grant methods. **At line 388 it explicitly overwrites the post-disconnect Viewer state with FREE before welcome**, hiding P1's preserved ACTIVE/noncontroller precondition. Extend this fixture or add a focused sibling which retains the actual freeze result, processes grace expiry and Host reset while offline, then delivers actual `connected` → FREE events. Do not reuse that forced-FREE assignment in the RED. Its `:398-442` tests already cover Host rebind rejection/timeout, cancellation and duplicate-FREE budget; retain these.
- `web-client/js/webrtc.test.js:2187-2309` has `loadWebRTC()` socket-handler recovery tests and `:2672-2724` has the real dead-socket mode switch/config-await path. The latter asserts stale connect cannot create a PC but does not arm/fire A's signaling recovery timer. Extend it with fake timers plus B `connect_error` and the unchanged watchdog deadline for P2; keep its old-PC assertion.
- `web-client/js/webrtc.signaling-fallback.test.js:46-58` is another real `setupSocketListeners()` VM fixture, but its routine recovery spy is insufficient for P2 unless real recovery scheduling is restored. Prefer `webrtc.test.js` for that lifecycle regression.

No test module was imported or executed. These are concrete existing fixture paths, not claims of RED results.
