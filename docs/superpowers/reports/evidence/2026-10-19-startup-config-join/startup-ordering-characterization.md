# Startup PC ordering — private offline characterization, 2026-10-19

## Result

RED: the conditional Viewer ordering defect reproduces using actual production methods. With authenticated ordinary admission and bootstrap still pending, fast namespace connect → application welcome → control grant creates PC1 and emits its offer while `_deferPeerUntilConfig === true`. Resolving bootstrap then enters actual `init`, closes PC1, creates PC2, and emits no replacement offer on this tested path. A subsequent synthetic answer is ignored by the actual answer listener because PC2 has signalingState `stable`, rather than `have-local-offer`.

Control scenario with bootstrap already ready creates only PC1, emits one offer, and applies the synthetic answer once. This is a bounded offline reproduction of source ordering, not a claim that R5 experienced this race, a live Host acceptance result, or a measured startup optimization.

## Reproducible artifacts and execution

- `/tmp/wrd-startup-pc-ordering-characterization-20261019.test.js`: final standalone offline characterization.
- `/tmp/wrd-startup-pc-ordering-characterization-20261019.result.json`: final safe scalar/call-order output.
- `/tmp/wrd-startup-pc-ordering-characterization-20261019.failed-fixture.js`: preserved initial fixture, intentionally distinguished below.

Final command: `node /tmp/wrd-startup-pc-ordering-characterization-20261019.test.js`. Exit 0 means assertions successfully characterized the RED production ordering, not that the startup invariant passes. Final execution tool wall time 0.866 s; preceding characterization run 0.801 s and initial failed fixture 0.504 s, all well below 60 s. No runtime services, browser, network, native operations, repository changes or subagents. VM production timers use a fake scheduler that never fires; platform fetch/io/RTC are entirely private fakes. The script imports only Node builtins for filesystem/VM/assertion support; it executes repository source text offline, not repository service entrypoints or test suites.

Source read from `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`, held HEAD a68b0408012fabf8e51ca2e4dd18eecaaeae8a1b. Prior read-only comparison established inspected Viewer methods match deployed c802/buildbb581 and Signal/Host paths match dfb. No source/index/docs/package write or configuration change occurred.

## Fixture validity

The existing `makeElement` and `loadWebRTC` helper declarations are extracted from `web-client/js/webrtc.test.js` as text and evaluated in a private VM. No repository tests execute. The final document has `readyState: loading`, so automatic shell boot is not dispatched; startup is invoked explicitly using `startViewer`. This isolates the questioned startup ordering from fixture auto-boot.

The final harness executes real `bounded-request.js`, desktop session state, presentation budget, port-search controller, runtime diagnostic, `webrtc.js`, and real `bootstrap-controller.js`. Auth is an already-verified browser-platform fake with current token/generation and fulfilled `whenReady`. Ordinary admission is real `requestExplicitViewerAdmission` and real bounded JSON request processing against a fake fetch returning a valid admission ticket. No proof admission is present. Exactly one admission request is observed per case.

Real production bodies execute for `startViewer`, `requestExplicitViewerAdmission`, `createSignalingSocket`, `init`, `setupSocketListeners`, `handleControlGrant`, `createPeerConnection`, `createInputChannel`, `createOffer`, and the answer listener. Seven questioned methods have transparent entry-recording wrappers that immediately call their original bodies with unchanged `this` and arguments. None is replaced by a no-op. No product state field is assigned to force the race.

`createViewerBootstrap` runs unmodified. Its platform `fetchSnapshot` returns a controlled deferred promise; resolving it supplies an inert snapshot. The ready control first preloads the matching real controller cache, then runs the same startup.

The fake Socket.IO platform records emitted event names and dispatches real registered listeners. After actual ordinary admission creates the socket, the harness sets the fake socket transport to connected and dispatches namespace `connect`, application `connected` with hostOnline=true, then a valid `control-grant`. Welcome must first produce an actual `control-acquire` emit (asserted). The synthetic grant uses the valid shape actually accepted by `handleControlGrant`: controller=true, string leaseId, integer leaseEpoch. The server's control transition/Host reset is not bypassed in production; the fake platform models its successful grant response and does not execute server/Host authority logic.

The fake browser RTCPeerConnection supports createDataChannel/getTransceivers/addTransceiver/createOffer/setLocalDescription/setRemoteDescription/close and ordinary signaling state transitions. Offer and answer payloads are synthetic inert strings. Fake createOffer/local-description awaits settle before releasing delayed bootstrap, which models a fast local offer plus a slower configuration request. No SDP, credentials or source/runtime user payloads are exported.

## Observed cases

| Safe fact | Delayed bootstrap + fast grant | Ready bootstrap control |
|---|---:|---:|
| Admission requests | 1 | 1 |
| Socket instances | 1 | 1 |
| PC count before releasing delayed bootstrap / corresponding control point | 1 | 1 |
| Deferred config flag at that point | true | false |
| Offers already emitted | 1 | 1 |
| PC signaling at that point | have-local-offer | have-local-offer |
| PC count after startup settles | 2 | 1 |
| Total offers after startup settles | 1 | 1 |
| Current PC signaling before synthetic answer | stable | have-local-offer |
| PC1 closed by real production replacement | true | n/a |
| Answer applications by PC ordinal | [0, 0] | [1] |
| Actual answer listener stale-answer warning | yes | no |
| Desktop gate before answer | false | false |
| Episode before answer | pending | pending |
| Product console error records | 0 | 0 |

Both configurations contained one ICE server entry, so entry count is not proof that early and applied configs were identical. No endpoint strings are persisted. Internal attemptSequence was 0 at early grant/offer and 2 after init/replacement; ready control was 1. The emitted offer uses production's sequence fallback, not a fixture-assigned product epoch. These observations demonstrate sequencing; they do not measure network negotiation time.

Delayed call order: real startViewer → real ordinary admission → real socket creation → welcome emits control-acquire → real grant → PC1 → real offer/local-description → socket offer emit → bootstrap resolve → real init → real socket reuse → real createPeerConnection closes PC1 and creates PC2. No second `createOffer` follows within the observed settled microtasks. Feeding an answer then executes the real stable-state rejection. Thus an offer has actually been emitted by Viewer and lost its matching current PC; the effect is beyond merely allocating an unused fake PC.

Ready call order: real startViewer → admission → socket creation → real init/PC1 → welcome/control-acquire → real grant → offer/local-description/emit → synthetic answer applies to PC1. This control confirms the fixture can negotiate an answer when the ordering preserves the PC.

## Source explanation

- `webrtc.js:2735–2744`: create signaling with `_deferPeerUntilConfig=true` before awaiting bootstrap.
- `webrtc.js:3799` and `3854–3864`: connect/host-status contain some defer checks.
- `webrtc.js:3826–3840`: application welcome calls `requestControl` when Host is online without the same defer check.
- `webrtc.js:4161–4233`: valid `handleControlGrant` creates a PC and calls createOffer, without checking `_deferPeerUntilConfig`.
- `webrtc.js:5577–5650`: actual createOffer has active-control, ownership and epoch guards, but no config-defer guard; it can emit before bootstrap settles.
- `webrtc.js:2566–2600`: init applies the snapshot, begins the attempt, reuses socket and calls createPeerConnection unconditionally for non-tunnel mode.
- `webrtc.js:4584–4630`: actual createPeerConnection closes and replaces the previous peer and advances attempt binding where needed. It does not itself call createOffer.
- `webrtc.js:3884–3908`: answer listener ignores answers when the current PC is not `have-local-offer`. This guard is correct for stale answers but cannot recover a missing replacement offer.

No internal guard excluded this particular ordering. No fix was implemented. A future fix should be designed around configuration/authority ownership and tested with this ordering; this report does not authorize moving/removing control barriers or changing network/deadline policies.

## Failed fixture versus final result

The first private script left document.readyState unspecified, matching the base helper's permissive DOM. That caused real module auto-boot to run immediately without a bootstrap-controller global, generating an extra fake configuration request before explicit startup. Its `requests === ['admission']` assertion failed with `['unexpected','admission']`; exit 1 is a fixture setup failure, not evidence for or against the PC race. The failed file is retained. The final harness fixes only the platform DOM to `readyState: loading`, preventing unintended auto-boot; the questioned production methods are unchanged. The corrected run and subsequent additional-warning assertions both exited 0 and reproduced the same ordering.

## Limits and relationship to R5

Only the Viewer production path is executed. No real Socket.IO Manager timing, Signal server, Host, ICE, DTLS, decoder, media, physical display or native input is exercised. Fake callbacks deliver a successful Host/control grant and a later answer; this is sufficient to test the Viewer ordering but not to prove a real Host would accept/answer this early offer in every state. Source server `forwardOffer` has authority/attempt binding checks; real acceptance remains unmeasured. A fake-answer acceptance count is local method coverage, not live media success.

Timers do not fire and clock only advances to 900 ms. No claim of permanent stall, elapsed recovery deadline, eventual failure or recovery success is made. The observed post-init PC has no offer and rejects the supplied answer; gate=false alone is not the defect, because both cases have no media frames. No fake frames were supplied to force gate success. Existing recovery paths may later act, outside this bounded observation.

This does not explain fixed R5: its bootstrap-ready 3993.1 precedes signal-connected 7660.4, whereas this reproducer requires fast socket/control completion before bootstrap readiness. R5 remains FAILED / cleanup-incomplete, no P95/nonblack/native proof, and the QoS/pacing root cause remains unresolved.

All six input metrics remain null / NOT_RUN: inputAckRttMs, inputToPostApplyFrameMs, inputToVisibleEffectMs, hostQueueMs, hostApplyMs, hostAdapterAwaitMs. No quality/ICE/network/grace/deadline/authority setting was changed.

## Minimal correction direction for a later bounded change (no implementation)

Preserve admission and control grant semantics. Make starting media conditional on configuration being applied for the current startup episode, regardless of whether init or grant arrives first. Existing interfaces are `_deferPeerUntilConfig`, `_pendingBootstrapConfig`, `startupAllowed(episode)`, the guarded bootstrap continuation/applyBootstrapSnapshot, `hasActiveControl()`, `controlState.lease`, and the ownership guards in createOffer. Merely adding a return in handleControlGrant while deferred is insufficient: real init currently creates a PC without calling createOffer, so init must also reconcile a grant that arrived earlier. Merely calling createOffer unconditionally from init is also insufficient: it must respect the current lease, auth/episode identity and config ownership, and avoid duplicating a grant-triggered offer when grant arrives later.

A small shared reconciliation step at the two existing join points (after config/PC initialization and after valid grant) should produce at most one offer for the current configured PC/attempt. Use actual current PC/attempt/lease identity plus existing `offerInProgress` and `_offerEpoch`/ownsOffer fencing; `offerInProgress` alone is a temporary async lock, not a persistent 'already offered this PC' marker. Do not clear/rewrite authority merely to permit an offer. Preserve normal delayed-control, ready-bootstrap, superseded/cancelled episode and in-flight offer ownership handling. The minimal intended invariant is: no PC/offer before current config is applied; after both current config and current control grant, one matching PC/offer exists. This is a design direction, not a verified fix, and no deadlines, network policy or services are changed here.
