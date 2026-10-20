# After-grace recovery failure: read-only source assessment

Date: 2026-10-19, Asia/Shanghai. No implementation or service operation performed.

## Conclusion

The recorded failure is not explained by an unmatched Host reset alone. The projected server reset events satisfy the runner's after-grace reset/lease relation, while a new peer receives/decodes video and the product itself keeps its media/input gate closed. A specific source defect is reachable and closely matches the observed generation/peer transition: an unleased peer created during recovery retains callbacks from the preceding attempt when a changed control lease advances the attempt. Its ontrack and connection callbacks then reject themselves as stale. This is a concrete static lifecycle defect and the leading explanation for this run; the projection does not capture callback owner fields, ontrack execution, video.srcObject identity, paused/readyState or play outcome, so its occurrence in this particular live run remains inferred rather than directly instrumented.

Do not relabel this qualification PASS, relax its frame/gate requirements, reinterpret decoded frames as displayed frames, or continue the failed sequence. A new independent regression and reviewed fix should precede another fresh qualification.

## Evidence boundary and integrity

Read only the root's existing sanitized projection and audit, plus selected current primary Viewer/runner/sampler source and directly relevant existing test excerpts. No raw samples, Host/Signal logs, service/network requests, process operations, source/index/HEAD changes, or subagents.

- Projection: after-grace-failure-metadata-projection.json, 145855 bytes; verified SHA256 bca5b6a239976b2f2a5de26bb215e76674db1f28aa5909c702a72998a5206138.
- Audit: actual-after-grace-failure-audit.json, 6010 bytes; verified SHA256 72bb91719c2e9c472288d4a7ddf09f6dbb2a345d58c5d061019f7df4ce54c173.
- Source base: /Users/macstudio1/AI/Claude/WebRemoteDesktop. Viewer version fefc555 was supplied by root's deployment evidence; this task did not rerun Git/deployment gates.
- Audit worker exit 1, outer CLI exit 2, classification failed-or-indeterminate, no timeout, seven recorded worker identities exited and no signals. Native input/physical/visible effect remain NOT_RUN.
- The audit's earlier currentReadiness.health is null with RuntimeError; it must remain so. Root's subsequently reported fresh local/formal 200 and unchanged protected identities are a separate later observation, not a correction of the audit.

## Observed timeline from existing projection

The tail is sufficient for the following facts; times are runner elapsed seconds, not synchronized server/client duration measurements.

| Time | Generation / peer | Lease | Product state | Frame evidence |
|---|---|---|---|---|
| 309.198 | generation 1 / PC1 connected | 7 | connected, input allowed | callbacks 5866; decoded 5889 |
| 310.200 | generation 1 / PC1 connected | 0 | disconnected, input blocked | callbacks 5885; old media initially continues |
| 318.210 | generation 1 / PC1 connected | 0 | disconnected | callbacks 6033; decoded 6056 |
| 325.218 | generation 2 / PC2 new | 0 | signaling, input blocked | callbacks 6034; no new-PC decoded value yet |
| 326.219 | generation 3 / SAME PC2 new | 9 | signaling, input blocked | callbacks unchanged 6034 |
| 327.220 | generation 3 / SAME PC2 connected | 9 | still signaling | decoded 4; callbacks unchanged |
| 369.286 terminal | generation 3 / SAME PC2 connected | 9 | hasActiveControl=true, hasInputLease=true, keyboard READY/ready, desired/applied media active; hasPaintedFrame=false, currentAttemptReady=false, inputActive/allowed=false | decoded 823; callbacks still 6034; last callback age 44517.372ms |

The final product blockedReasons are inactive and media-not-ready-for-attempt. This is a real application gate state observed by the sampler, rather than only a qualification reducer verdict. Decoded frames establish receiver/decode progress; they do not establish that the HTML video adopted or displayed the new stream.

Server event projection, in event order:
1. n=1 grace-started, original session/viewer hashes.
2. n=2 grace-expired, same original session/viewer hashes, leaseEpoch=8, state=REVOKING.
3. n=3 reset-completed, leaseEpoch=8, state=FREE.

## Runner reset matching and diagnostic naming

scripts/ordinary_session_recovery.py:811-817 selects the original viewer's grace-expired event, then reset-completed with n greater than expiry.n, the same leaseEpoch and FREE state. It separately requires the sample leaseEpoch to exceed both expiry lease and baseline lease.

For the projected events/new lease, those relations hold: 3 > 2, reset lease8 == expiry lease8, FREE; new lease9 > expiry8 and baseline7. Reset-completed has null viewer/session hashes by design; the reducer does not require those hashes on the reset event. No evidence here supports a reset-event viewer-hash mismatch bug.

However, lines823-826 also require callback progress beyond fault_sample and every product/media/path gate. _gates at lines676-700 explicitly requires painted/current-attempt readiness, connected UI, active input, and fresh frame age. Those do not hold. expire at lines830-832 calls any unsuccessful after-grace recovery reset-unconfirmed after 60 seconds, even when the reset event itself was confirmed. Thus the current failure label conflates reset acknowledgement with subsequent media/input readiness failure. Improving failure detail is useful, but it must preserve the failed result and all existing thresholds.

scripts/passive_session_sampler.js:195-210 independently attaches requestVideoFrameCallback to remoteVideo, rearming by video-element identity rather than WebRTC startup owner. It does not use the product's generation token. Consequently, a stale product rVFC owner alone cannot stop this independent sampler counter if frames continue to be presented by that same video element. A suppressed ontrack/stream attachment is consistent with both the product and independent callback stall. Sampler callback persistence across a browser srcObject transition is not directly evidenced here; retain it as an observational limitation.

## Provable source lifecycle defect

All paths below are current primary web-client/js/webrtc.js.

1. A signaling loss calls freezeControl('signal-disconnect') at lines3951-3953. freezeControl preserves _mediaControlLease correlation but clears controlState.lease at line4286. Thus the old lease identity remains available for detecting a later grant change while a newly created peer can legitimately have no lease.
2. handleSignalingRecoveryConnected can refresh an unhealthy retained peer at lines6888-6893. refresh advances the attempt at line7003, closes/removes the old peer at lines7043-7053, then creates another peer and tries createOffer at lines7076-7077. At createOffer lines5609-5611, lack of active control requests control and returns; it does not offer yet.
3. createPeerConnection lines4645-4649 creates that new peer and snapshots controlState.lease into peer._wrdControlLease, which is null in the no-lease case. It binds peer callbacks at line4657. bindPeerCallbacks line4662 captures startup owner including current attempt and sequence.
4. captureStartupOwner lines2399-2402 captures peer/socket/attempt/sequence. ownsStartupOwner lines2404-2409 requires exact current attempt and sequence in addition to peer/episode identity.
5. handleControlGrant lines4179-4183 compares the retained _mediaControlLease with the new lease. When lease7 becomes lease9, mediaLeaseChanged is true. The peer retirement branch only executes for a truthy differentPeerLease; null peer._wrdControlLease does not enter it. The existing newly created unleased peer is therefore retained.
6. handleControlGrant line4203 calls beginConnectionAttempt('control-identity-changed'), advancing attempt/sequence at lines1351-1352, clearing current-attempt readiness at line1366 and hasPaintedFrame at line1378. It does not rebind the retained peer callbacks. This directly creates the generation2 owner / generation3 current-peer mismatch.
7. reconcileConfiguredControlMedia lines4247-4261 retains a new/connecting peer and calls createOffer. createOffer lines5634-5643 snapshots current generation3/lease9 for offer ownership and sets peer._wrdControlLease. This allows offer/answer/media decode to proceed without renewing the peer's existing generation2 callback owner. There are only two direct bindPeerCallbacks call sites in the inspected source: createPeerConnection and transferRetainedStartupPeer; handleControlGrant/createOffer do not call it.
8. onconnectionstatechange rejects the stale owner at lines4709-4710 before onPeerConnected, so startStats/startVideoFrameTracking at lines4551-4552 and the media-pending transition at lines4588-4591 are skipped. ontrack rejects the same stale owner at lines4753-4754 before assigning video.srcObject at line4759, video.play at line4768 or metadata/playing hooks at line4779. Therefore a connected peer can decode while UI remains signaling and video remains attached to old media.
9. Product rVFC itself also correctly rejects an old owner/attempt/PC at lines6205-6207, without rearming it. Relaxing that guard would reauthorize stale frames and is not an acceptable fix. startStats has the corresponding owner gate at line6176; decoded-frame paint fallback at lines2041-2053 cannot help if the new stats producer was never started or was invalidated.

The projected PC2/gen2 -> SAME PC2/gen3 before connected, followed by decoded growth and unchanged signaling, is a particularly close match to this chain. The projection does not reveal peer._wrdControlLease or captured callback sequence, so retain the distinction between this proven reachable bug and live root-cause inference.

## Stream reuse, video.play, rVFC and visibility alternatives

- ontrack sets remoteStream=event.streams[0] and assigns video.srcObject directly (4756-4759); there is no streamless-track fallback. If streams is empty, remoteStream is undefined and subsequent getTracks at4781 would fail. No projection evidence establishes an empty-stream event in this run.
- play rejection at4768-4772 is logged only; no bounded retry/recovery signal is emitted there. A rejection is another possible black-frame cause, but the projection has no play result/paused/readyState and must not assert rejection occurred. In the owner mismatch path play is not called at all.
- captureLastFrameHold at6767-6783 only draws a canvas and toggles its class; it does not pause video, replace srcObject or cancel the sampler callback. There is no static support for blaming the hold operation itself for stopping video callbacks.
- An rVFC callback may also be suppressed by browser rendering/visibility behavior. The present projection does not include enough per-video/render state to exclude it. It does not explain away the separate demonstrable stale-owner lifecycle defect.
- Startup transferRetainedStartupPeer at6848 returns when startupPending is false; a completed five-minute baseline has established recovery rather than pending startup. It is not a general repair path for this control-lease attempt change.

## Minimal remediation options for a separate reviewed code task

Preferred narrowly scoped direction: when a changed lease advances the attempt, retire/recreate a pre-existing unleased peer as well as a peer carrying a different lease, and bind every new producer only after the new attempt identity is final. This avoids authorizing a peer and callbacks captured for an earlier attempt. Do not discard a matching leased healthy peer merely on duplicate grant; preserve within-grace lease/peer reuse.

Alternative: explicitly retire and recreate all owner-bound producers for a safely retained same-PC attempt transfer (peer callbacks, input/DC callbacks/watchdog, stats, rVFC and video event hooks), with immutable old owner records and an explicit receive-track adoption policy if ontrack already fired. This has wider invariants and more reentrancy/race risk than recreating the unleased peer; merely rebinding ontrack or mutating owner.sequence is insufficient.

Likely product change scope: web-client/js/webrtc.js plus focused source tests. No Host/tunnel/backend changes are indicated by this source finding. Any future runner diagnostic improvement should be a separate small change in ordinary_session_recovery.py and its tests; it must not expand this run's evidence or alter grace/recovery budgets.

## Minimum meaningful regression tests before implementation acceptance

1. Establish completed startup and old media lease; freeze control; run real refresh path without active control to create an unleased peer at attempt N; then deliver changed lease at attempt N+1. Do not stub handleControlGrant/beginConnectionAttempt/createPeerConnection/createOffer/bindPeerCallbacks. Assert the final peer has fresh callback ownership; invoke real ontrack/connection callbacks; new srcObject is attached, play called, current stats/rVFC start, and a fresh current frame opens input only with the valid new lease.
2. Retain callbacks queued before grant/retirement and invoke them afterward. They must not attach old streams, paint, grant input, restart timers or replace current stats/rVFC. Include old play-promise/fallback completion cases.
3. Duplicate same-lease grant and within-grace same-lease recovery preserve one current producer/peer and do not create gratuitous peers/offers or reset an already-proven frame gate.
4. Cover both event orders: grant before peer connected/ontrack and connection/ontrack before grant; include pending/complete startup state. If a retained-PC design is chosen, explicitly test tracks whose ontrack fired before transfer and play rejection.
5. Runner fixture with grace-expired8/reset-completed8/FREE/new lease9 but callbacks stalled and product ready=false must remain FAIL. A separate fixture with the same reset events and fresh current callbacks/all gates true can recover and needs unchanged 30s stability. Any refined reason must distinguish confirmed reset + media/input blocked from missing reset, without relaxing the 60s deadline.
6. After focused tests and independent review, a newly generated full ordinary sequence must run baseline -> within-grace -> after-grace -> continuity under the original guards. This failed sequence is closed and cannot resume or be repaired by new code.

## Unmeasured and deliberately not claimed

This analysis does not establish physical photons, actual keyboard/mouse execution, real business input, all-device/network reliability, or three-hour continuity. It does not prove the play promise failed, the server reset failed, or that the known source defect is the only recovery bug. Existing raw failures and health-read errors remain immutable. No services or protected worktrees were modified.
