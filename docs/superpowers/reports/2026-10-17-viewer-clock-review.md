# Viewer local control deadline clock review

2026-10-17. Narrow read-only review of current worktree /Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop. Scope: reliable mouse/reset ACK, mobile surface ACK, signaling recovery/reconnect and the local lease boundary. Independent of the Host media-clock implementation. No code/index/runtime/dependency/service/network/browser/native input change. Four original methods were evaluated in an isolated Node VM with fake Date.now and fake timer/callback objects, no DOM or real socket/timer. Only this private0600report is written.

## Important findings and repair boundary

1. input.js:1366–1380 _scheduleDesktopWriteDeadline recomputes oldest mouse/command/reset ACK remaining time using Date.now and the pending record's wall sentAt. Every new reliable send (2539–2541), ACK reconciliation and pending cleanup can clear/rearm this oldest timer. A forward wall step can immediately trigger a false ACK timeout; a backward step can postpone it. This reaches actual _onReliableAckTimeout behavior: reliable DC quarantine, dual-reset recovery, reset reacquire-required and uncertainty states, while existing identity/lease/socket checks remain intact. It is an availability/recovery correctness defect, not a lease bypass. The safe fix boundary is this private pending timestamp producer plus every consumer of that SAME private timestamp, not wholesale replacement of timestamps.
2. input.js:1435/1455/1488–1495 mobile down/up deadlines use Date.now; _handleMobileSurfaceAck explicitly compares current wall time even before a relative timer fires. A correct same-lease ACK received shortly after send can be labelled late after a forward adjustment. _scheduleMobileSurfaceTimer at603–630 rearms the earliest edge using those same wall deadlines, so wall rollback/forward also changes future waits. Move the local creation/check/rearm boundaries together. Preserve all gesture generation, lease epoch/identity, ACK status/appliedSeq, uncertainty and one-recovery-budget conditions.
3. webrtc.js:6326–6355 scheduleSignalingRecovery measures its12000ms dead-socket recreation threshold with Date.now. Forward steps allow premature Socket recreation at the next1500ms callback; backward steps postpone the intended fallback for the size of the rollback. Socket.IO's own reconnect machinery may still work; this defect is specifically the application's stuck-transport fallback, not proof every reconnect fails. Move _signalRecoveryStartedAt creation/read/reset together to a same-page monotonic source; keep manualDisconnect/superseded checks, resume admission and healthy-PC preservation unchanged.

These are confirmed code-level effects under fake wall adjustments. No evidence from this review establishes an actual wall adjustment during the remote media incident, and no claim is made that fixing them resolves that incident. Host pacing and this Viewer scope should be separate changes/reviews.

## Reproduced original-function counterexamples

The VM extracted the exact current method text between adjacent object methods and supplied original3000ms constants where needed. It did not implement equivalent pseudocode instead. Callbacks that would touch the application were replaced by local record-only stubs. Fake wall base100000ms, real elapsed100ms:

| Original method/scenario | Observed result |
| --- | --- |
| _scheduleDesktopWriteDeadline, wall100100 | delay2900ms |
| same real age, wall jumps forward60s to160100 | delay0ms |
| same real age, wall rolls back60s to40100 | delay62900ms |
| _handleMobileSurfaceAck, valid applied ACK at wall100100 | downAck=true; no uncertainty |
| same valid ACK/real age, wall160100 | downAck=false; uncertainty late-ack |
| scheduleSignalingRecovery callback at real13.5s, wall113500 | recreateSocket once |
| callback at real1.5s, wall161500 | recreateSocket once, prematurely |
| callback at real13.5s, wall53500 after rollback | no recreation yet |
| isInboundVideoHealthy with stored wall100000/current70000 | negative age still returns healthy=true |

The final row is an adjoining recovery health defect, described below. Relative setTimeout/setInterval are NOT themselves continuously driven by Date.now. An already armed3000ms timer is not magically retimed by changing Date.now; the demonstrated mouse/mobile risks occur on rearm or explicit late checks, and signaling recovery reevaluates wall elapsed in its callback. Browser suspension/main-thread delay remains a separate cause of late timer callbacks even after monotonic conversion.

## Private local fields versus protocol/persistence

| Field and producer | Consumers/visibility | Minimal clock treatment |
| --- | --- | --- |
| Input._desktopWritePending record.sentAt, input.js2539 | Read by _scheduleDesktopWriteDeadline1380; map is page-local. Wire data is a separate envelope; pending metadata is never spread into send payload. _captureMouseReset1143–1157 explicitly returns identity/seq/socket metadata without sentAt. No inspected diagnostic/persistence export serializes this record/time. | Can rename to sentAtMonoMs or keep name with clear unit; update its producer and scheduling consumers together. Do not change wire input IDs/seq/lease. |
| Input._mobileSurfaceGesture.downDeadline/upDeadline,1435/1455 | Only local _scheduleMobileSurfaceTimer and _handleMobileSurfaceAck read them. Public getMobileSurfaceContextSnapshot1510 returns state/generation only; the gesture itself is not sent/persisted by inspected paths. | Local monotonic deadlines; migrate both creators and both consumers atomically. |
| Input._recoveryCycle.deadline,1289 | Assigned at cycle creation/reset but no active comparison/reader of this deadline was found in input.js or the relevant export paths. Actual overall dual-reset cycle uses direct setTimeout(INPUT_RECOVERY_TIMEOUT_MS) at1327–1334. | This wall field is not currently the cause of the cycle timer expiring; remove/rename/align only if consistency warrants it, not as the claimed fix. Do not broaden into changing retry budget. |
| KeyboardTransport pending record.sentAt,keyboard-transport.js255 | PRIVATE transport map; defaults to performance.now at32–33. getSnapshot/getPendingReset omit sentAt. The Input timeout callback receives the record but does not subtract its sentAt. Input's desktop deadline scheduler reads only its OWN mouse map. | Already monotonic and separate despite same property name. Do not rewrite or mix it with mouse wall times. |
| Input._unorderedTraceSends.sentAt,746 | Private bounded action-hint map, pruning899 and late hint931; evidence-only, never reliable ACK authority. | Outside immediate fix. Leaving its wall diagnostic expiry does not prevent the three control fixes. Do not mix its sentAt with pending mouse timestamps. |
| WebRTC._signalRecoveryStartedAt,6329/6350 | Page-private application fallback origin; only recovery elapsed/reset/clear paths use it. No send/persistence field. | Local monotonic origin with null sentinel, not falsy0, because performance.now0 is valid in tests/early page lifecycle. |
| _lastInboundFramesDecodedAt (6024),_lastRefreshAt (6402),_lastKeyframeRequestAt (2100) | Private local freshness and retry/cooldown policies, not Host timestamps. | Adjacent optional narrow recovery work; all producers/consumers for each field must migrate together if included. No mass replacement. |

Source checks were limited to these ownership/export paths, input trace/diagnostic collectors and the named transport/recovery objects; this is not a promise that arbitrary external console access cannot serialize private state. Existing raw protocol envelopes are separately assembled in _sendInput and KeyboardTransport sendPayload; no duration timestamp is added by this proposal.

## Lease, reset and admission boundaries that must stay unchanged

WebRTC.hasActiveControl at3611 checks controller/state/lease; activeLeaseEnvelope sends schemaVersion,leaseId,leaseEpoch only. Viewer does not calculate server lease expiration from its wall clock. startControlHeartbeat3898 sends that identity immediately then every3000ms with setInterval; no Date.now decision there. A browser wall step does not advance leaseEpoch or authorize a new lease. Signal remains expiry/grant authority; server-side clock choices were not expanded into this Viewer review.

leaseEpoch, connectionAttemptSequence, recovery generation and appliedSeq are ordering/fencing counters, NOT epoch timestamps. Do not convert them. Input IDs, request IDs and fallback session/attempt IDs contain Date.now text as opaque identity components; they are not elapsed-time values and need no change for this deadline fix. Keep uniqueness and anti-replay semantics. The existing same-socket/DataChannel ownership, current attempt and same-lease ACK checks must remain exactly as strict.

Ordinary Viewer admission is a server-issued explicit ticket followed by server-confirmed resume generation. Client stores mode/ticket or mode/generation, not a private monotonic expiration that can replace server validation. Proof remains one-use and cannot be re-minted/upgraded to survive a timeout. Cross-end auth expiry/UTC timestamps, logs and Host clock-sync h0/h1 cannot be replaced by performance.now: that number is per-page and not comparable with server wall time. Any future protocol timestamp change needs an explicit versioned protocol plan; this local repair requires none.

## Adjacent recovery checks worth a bounded follow-up

isInboundVideoHealthy6483–6488 subtracts Date.now from _lastInboundFramesDecodedAt and accepts ANY value<=maxAge, including negative. A wall rollback therefore treats old media as fresh until wall catches up, potentially suppressing DataChannel full reconnect; forward jumps can mark fresh media unhealthy and lead to unnecessary recovery. Same-field producer at6024 must move with its freshness consumer; simply adding negative-age rejection avoids one false-health case but then creates false-unhealthy behavior on clock rollback instead of fixing the duration clock. This does not bypass lease/ACK gates, and a painted-frame fallback elsewhere is an independent existing policy.

canBeginRefresh6270 and rebuildDataChannels cooldown6559 compare Date.now against _lastRefreshAt6402; backward jumps suppress recovery longer, forward jumps can bypass cooldown. requestKeyframe2093–2101 similarly uses a one-second wall cooldown; rollback suppresses keyframe recovery, forward permits another early request. These fields are local durations and could share the same local monotonic accessor if this follow-up is explicitly included. The initial implementation need not touch receiver metrics/UI/stall classification, tuning, tunnel locks, wheel batching, DOM timestamp fallbacks or log timestamps.

Do not merge a broad Date.now cleanup: _stallSince UI state, desktop-session lastTransitionAt, input IDs, diagnostic hints and wall log correlation serve different purposes. None is necessary to reproduce/fix the direct ACK/mobile/signal fallback defects above.

## Reusable local clock and existing test seams

There is no currently exported shared monotonic-control helper for Input and WebRTC. KeyboardTransport.create(options.now) is an existing injectable pattern, default performance.now (fallback0 when absent); Input.initKeyboardController does NOT override it, so this live path already gets the monotonic default. LatencyMonitor create also accepts an injectable performance clock. InputTrace has a guarded performance.now fallback to Date.now, but it is a private diagnostics clock and its wall fallback is unsuitable as a control-deadline guarantee. Do not reach into a diagnostic collector to obtain control time.

Smallest implementation shape: a local injectable same-page nowMs accessor per owner (or one tiny already-loaded utility if repository architecture prefers), default performance.now with an explicit invalid/unavailable policy, used only for the private control durations selected above. Modern supported browsers expose performance.now; headless unit fixtures should inject a clock rather than silently depending on Date.now. A Date.now fallback or a nondecreasing clamp still allows forward wall jumps and does not solve false timeout; fallback0 can freeze conditional elapsed checks, so unsupported-clock behavior needs a declared fail-closed/relative-timer policy and a small test. No new network message, global Date override, main-loop timer or per-event diagnostic is needed.

Existing tests to extend in a later implementation:

- input.test.js loadInput fixture already evaluates actual Input/KeyboardTransport objects and owns fake document/timer hooks. Add one injected monotonic now and separate mutable wall clock. Exercise TWO pending mouse writes so rearming oldest cannot be affected by wall changes; use actual ACK/timeout/recovery handlers, not stubs, for the fix regression. Preserve3000ms, earliest-deadline, exact socket/attempt/lease guards, no auto-replay and at most one recovery cycle.
- Existing mobile surface tests around1535/1787 cover cumulative late down ACK and already-uncertain timeout; add down/up rearm before wall jumps and real100ms ACK. Verify generation/seq checks and no rejected ACK becomes accepted just because clocks changed. Test expiration at monotonic deadline and callback delay separately.
- keyboard-transport.test.js:392–409 already has options.now/fake-timer earliest pending deadline and lease-cancel tests; leave behavior unchanged and run as parity coverage rather than reimplementing it.
- webrtc.test.js:2269 has direct signaling recovery/manual disconnect, later tests preserve healthy peer/UI, and the current-generation admission/superseded suites remain relevant. Add fake monotonic ages at1.5/12/13.5s with independent ±60s wall steps; only12s elapsed controls fallback. Test null origin sentinel, reconnect success clearing owner timer, pending callback after supersede/manual-disconnect inert, no new explicit ticket/proof mint.
- If adjoining freshness/cooldown scope is chosen, existing webrtc.test.js:1134–1181 and5944–5967 seed _lastInboundFramesDecodedAt with Date.now; change those fixtures/producers to the selected clock consistently. No cross-page/Host timestamp comparison.

Suggested later commands, no browser or service:

    node --test web-client/js/input.test.js web-client/js/keyboard-transport.test.js web-client/js/webrtc.test.js
    node --check web-client/js/input.js
    node --check web-client/js/webrtc.js
    git diff --check

This review ran only the small no-DOM original-method counterexamples above, not the full tests or a browser. It identifies narrow important defects and implementation seams; it neither modifies nor validates the ongoing Host media-clock fix or production recovery behavior.
