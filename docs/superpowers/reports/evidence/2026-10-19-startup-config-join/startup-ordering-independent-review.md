# Independent review — bounded startup PC ordering characterization

**Characterization verdict: valid for the bounded Viewer ordering claim. One actionable source finding [P2] is confirmed. No implementation was performed.** The evidence does not establish a permanent stall, real Host/Signal acceptance, startup latency distribution, or causation of historical R5.

## [P2] Early current control grant can negotiate a peer that bootstrap init immediately replaces

Locations: `web-client/js/webrtc.js:3826–3840`, `:4224–4233`, and `:2593–2600`.

`startViewer` deliberately opens signaling while bootstrap configuration is pending and sets `_deferPeerUntilConfig=true` (`:2735–2744`). The socket connect and host-status paths honor that deferral. Application welcome, however, requests control when Host is online, and a valid current grant creates a PeerConnection and calls `createOffer` without checking the configuration deferral. The real offer path's current lease/socket/attempt/epoch/episode checks can all succeed in this state; it has no configuration-readiness check.

After bootstrap resolves, real `init` applies the snapshot, starts/binds the initialized attempt, reuses the socket, and unconditionally calls `createPeerConnection` for non-tunnel mode. That method closes the previous peer and creates a replacement, but does not negotiate it. Since the fast grant has already been consumed, this startup path supplies no replacement offer. A later answer to the previously emitted offer reaches a current peer in stable signaling state and is correctly rejected by the existing stale-answer guard (`:3884–3908`). Removing that guard would be incorrect.

The consequence established here is loss of the current matching offer/peer and an unnegotiated replacement at the end of the observed startup path. This is a real conditional startup correctness defect, not merely redundant allocation or gate=false before first frame. It can delay or prevent ordinary initial media establishment until another recovery action intervenes. P2 is appropriate: the triggering order is plausible and the local state defect is concrete, but frequency and eventual live recovery/failure have not been measured. It is not established as an unconditional startup failure or security bypass.

## Fixture and source validation

I read the entire supplied report, standalone characterization script and result, the exact helper declarations extracted from `webrtc.test.js`, real bounded-request/bootstrap code, relevant startup/admission/socket/grant/peer/offer/answer code, and the necessary Input and server authority boundary code. No script, test, repository module or operational entrypoint was imported or executed during this review.

Source HEAD is `a68b0408012fabf8e51ca2e4dd18eecaaeae8a1b`. Current webrtc.js, webrtc.test.js and bootstrap-controller.js are byte-identical to their c802a68 Git blobs. This confirms source continuity, not new deployed-state observation.

The extracted helper slice contains only makeElement/loadWebRTC definitions. Its VM evaluates actual production modules. The seven entry wrappers transparently record then invoke the originals with unchanged arguments and receiver. There is no replacement of the questioned production bodies, assignment of product lease/config/attempt fields to force success, fake qualification result, or fake painted frame.

The final DOM's readyState=loading suppresses automatic module shell boot; explicit startViewer is the sole intended startup entry. The real admission request and bounded JSON handling execute against a synthetic successful platform response, with no proof credential. The fake welcome is followed by an assertion that actual control-acquire was emitted before the valid synthetic grant. Real grant validation and ownership checks therefore execute. The controller itself is real: only its fetchSnapshot promise, clock and timers are supplied by the platform fixture. The ready control primes its real matching cache rather than directly assigning Viewer configuration.

The fake RTC operations model the relevant signaling transition stable → have-local-offer → stable and close. Socket dispatch reaches the registered production listeners; emitted offers are counted from the actual production emit. The delayed case allows offer awaits to settle before releasing config, which is a valid ordering to characterize. The ready control demonstrates that the same fixture can apply an answer when the peer remains matched.

Important scope detail: the harness does not load the Input module, so optional Input.init/setControlLease hooks are absent. This is not full input-stack integration evidence. Source inspection shows hasActiveControl depends on the current controlState lease, and normal Input.setControlLease accepts a valid fresh lease; its false-return recovery gate is conditional on reacquire-required. There is no unconditional Input/config barrier that makes the characterized healthy-grant Viewer path impossible. Any later implementation should retain and test that existing conditional Input gate rather than treating this fixture as its coverage.

The fake grant represents a successful external authority outcome; it does not execute the server lease-transition/Host-reset procedure. Server sendGrant uses the same controller/lease shape, while forwarding actual v2 offers separately requires authorization and valid attempt binding. A real server might reject an early offer under some state. That does not invalidate this finding: the Viewer still emitted an offer against PC1, discarded PC1 on configuration completion, and failed to offer PC2. Real early-offer acceptance is not required to prove that local defect. The synthetic answer verifies only local listener behavior, not remote negotiation success.

## Evidence and interpretation

The retained result agrees with the script and inspected production branches:

| Observation | Delayed config / fast grant | Config-ready control |
| --- | --- | --- |
| Admission/socket count | 1 / 1 | 1 / 1 |
| Peer count after startup | 2 | 1 |
| Actual offer emits | 1 | 1 |
| Current peer before answer | PC2, stable | PC1, have-local-offer |
| Old peer closed | yes | not applicable |
| Answer applications | [0, 0] | [1] |
| Real stale-answer warning | present | absent |

Exit0 means the characterization asserted the existing defective behavior successfully. It is not a passing desired-invariant regression; a later fix test must assert no premature configured-media start and matching negotiation once both prerequisites hold. The first DOM-fixture failure is separately retained and is not a behavioral RED. Comparing the preserved failed fixture with the final script confirms the substantive fixture repair is the explicit DOM, with added scalar/warning observation and assertions. Those changes do not replace the production methods.

Independently verified supplied SHA256 values:

- Report: `4adce97d74ac23d4d9979d69d49a90e935e01342b25243e4a2b0117fa56e9d1a`.
- Script: `ed8a09bc05f951807f09cd5ac9ec14fee48304b66d8411bcdb58f5ee62e672bd`.
- Result: `3eb894e5ec9d6ad08f3260a8422697e79366cfc57443fb384c88269beff83938`.

I did not independently rerun the script or verify its reported wall durations. The result is retained offline evidence supported by static source inspection.

## Minimal invariant and later verification

For the current ordinary non-tunnel startup episode, media peer creation/offer must wait until that episode's authenticated configuration has been applied. Once current configuration and a valid current control grant are both available, their order must converge on one current configured peer with one matching initial offer, without waiting for another grant. Stale, superseded, cancelled or changed-auth continuations must remain inert.

A narrow shared reconciliation at configuration completion and valid grant is a reasonable direction. Only returning early from handleControlGrant while deferred is insufficient because init currently does not offer after an earlier grant. Unconditionally adding an offer to init is also insufficient: it must preserve current lease, Input recovery gate, socket, episode/auth and PC/attempt ownership and prevent duplicate initial offers. offerInProgress alone is an async lock, not evidence that this configured peer has already been offered. Preserve legitimate later renegotiation/recovery semantics and all existing offer ownership fencing.

Later regression coverage should include both orderings, in-flight offer/config completion, duplicate/current grant, superseded/cancelled/auth-changed configuration completion, and existing unavailable-control/Input-recovery cases. No change to admission authority, Host reset, quality, ICE policy, deadlines or automatic retry budget is required to fix this ordering. This report is not an implementation plan or an authorization to release the source hold.

## Limits

Timers are inert and the fake clock reaches only900ms. Returning0 timer handles also does not exercise browser timer-handle lifecycle. Therefore no elapsed timeout, permanent stall, eventual recovery, long-session or performance conclusion follows. The local gate remains false in both scenarios because no media frame was supplied. Neither that gate value nor the fake answer count measures visible or physical success.

The recorded R5 ordering has bootstrap readiness before signaling connection, so this specific characterization does not explain that failed run. R5 remains failed/cleanup-incomplete; all six input metrics and native/business/visible/physical outcomes remain null/NOT_RUN. QoS/pacing attribution remains separate and unresolved. The earlier tool-fix approval is unaffected.

Only this private review file was written. No source/index/package edits, tests, operational imports, runtime/process/status/service/network/browser/native actions or subagents occurred. The held source and paused tool-operation preparation remain untouched. Root owns subsequent source-hold release, planning and any implementation decision.
