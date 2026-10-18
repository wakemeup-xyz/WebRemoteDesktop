# Independent Task1 review — startup configuration/control join

**Findings: none. Spec compliance: Approved. Code quality: Approved.** No actionable correctness, architecture, privacy or documentation-sync defect was found in this task increment.

Exact implementation range: `9deab6e..fefc555aea9640b563bfd22f5b36b6b8ca6365ec`. HEAD resolves to the latter. Read the brief first, linked spec/plan/ledger, worker report, full 20,761-byte diff package, relevant actual startup/admission/grant/Input/offer/recovery methods and existing fixtures, and retained verification evidence. The embedded diff matches `git diff --unified=10` for the exact range byte-for-byte. Range diff-check is clean. Only web-client/js/webrtc.js and web-client/js/webrtc.test.js change (+159/-15).

## Spec compliance — Approved

- Configured init and valid grant converge through `reconcileConfiguredControlMedia`. Both actual media-entry methods, createPeerConnection and createOffer, reject current deferred configuration. Existing signaling/config overlap, ordinary admission and grant processing remain. Init retains allocation of a configured peer before control, which the spec/ledger explicitly permits, and resumes an eligible earlier grant without requiring another grant.
- The reconciliation checks current startup eligibility, configuration deferral, active control and non-tunnel mode before its media effects. It reads Input's existing accepted lease identity, reacquire flag and keyboard-transport reacquire state. It never replays setControlLease or clears recovery state. Ineligible Input uses existing requestControlRecovery. The original grant-side Input.init/setControlLease false-return gate remains before the grant media tail; WebRTC ACTIVE alone is not treated as Input acceptance.
- Duplicate suppression requires have-local-offer, actual local offer SDP, a peer-owned emitted-offer record matching current socket/attempt/sequence, and current peer attempt/lease. The record is written only after actual socket.emit returns and ownsOffer still holds. This is bounded correlation on the owned peer, not a grant cache or new authority. Replacing the peer retires the record; changed identity does not match. The transient in-progress lock still protects simultaneous duplicate callbacks.
- The existing createOffer epoch/peer/socket/attempt/lease/episode fences remain before and after its awaits. A stale completion cannot mark a replacement peer or clear a newer offer lock. The answer guard is unchanged. Auth/config continuation ownership, cancellation and supersession paths remain in the original startup owner.
- Suppression is confined to the shared join and pending matching local offer. Stable answered peers remain eligible for regrant negotiation; direct createOffer, refresh and other recovery entrypoints retain their existing semantics. Refresh creates a new attempt/peer; signaling recovery refreshes an unhealthy peer and preserves a genuinely healthy one. The existing live-connected-peer fast path remains.
- Tunnel/JPEG grant tail remains outside the non-tunnel join; init's tunnel branch remains excluded. No change to network selection, ICE/TURN configuration, 8/72/12-second startup budgets, reset/lease/quality policy, pause intent, retries or input replay was introduced. The added record is not persisted or logged and introduces no payload/credential disclosure.

## Code quality and architecture — Approved

The fix addresses the missing join rather than serializing signaling, replaying grants or weakening answer validation. One narrow reconciliation method owns the shared eligibility/duplicate decision. Its use of existing Input acceptance state is necessary because the grant handler updates WebRTC control before Input may reject the lease. Calling Input.setControlLease again from init would have mixed authorization and recovery mutation; the read-only eligibility check avoids that.

The peer-local emission record has a defined success boundary and natural lifetime. LocalDescription alone would only prove local SDP installation, not emission, while offerInProgress ends before a later duplicate grant. The implementation combines existing state with the minimal emitted identity rather than globally disabling renegotiation. Existing identity fencing around asynchronous operations remains the authority for recording success.

The two historical Input mocks that expected offers previously modeled setControlLease as a no-op. Updating their accepted lease state and returning true makes them match the production API now consumed by the shared join. Updating the adjacent live-peer mock prevents that test from passing solely because the new Input gate rejects an incomplete mock. This does not replace real Input in the new regression cases or relax a production assertion.

Active tracked spec/plan match the chosen boundaries and permitted peer-owned marker; the worker report explains its API, lifetime and Input choice. The unchecked plan template is not interpreted as an execution result. Root's concurrent untracked documentation work is outside this review.

## Test quality and retained evidence

The new fixture uses real Input/keyboard transport/controller, real bootstrap, admission and changed WebRTC methods. Platform DOM/Auth/fetch/RTC/socket/timers are fake. Entry wrappers only record and delegate. No product readiness/lease/epoch field is assigned to manufacture the positive ordering, no fake frame opens the input gate, and no server or browser entrypoint runs.

The desired-invariant RED is meaningful: ready-config control passes; delayed-config startup fails because a peer exists while deferred. This is distinct from the earlier exit0 characterization that asserted the bad behavior. GREEN verifies both orders, duplicate grant during and after the offer lock, one matching peer/offer/answer, and subsequent stable-peer regrant negotiation. The real Input negative drives keyboardTransport.acceptAck(invalid-input), then the real grant/setControlLease false-return recovery path before configuration resumes. No-control and cancelled/superseded/auth-changed continuations remain unable to emit.

The new stable-peer check proves local answered-signaling regrant compatibility; it is not a completed real-media-session test. Existing affected tests cover refresh, live-peer retention, tunnel/JPEG and stale async ownership. No actual media, native input or runtime success is inferred from those tests.

I read/hash-checked retained logs; no tests were rerun:

| Run | Actual result | Duration ms |
| --- | --- | ---: |
| Retained first DOM fixture attempt | 0/2; window.addEventListener fixture errors | 735.608451 |
| Behavioral RED | 1/2; delayed peer fence failure, ready control PASS | 731.749519 |
| Focused GREEN | 7/7 PASS | 987.837896 |
| First affected run | 559/561; two incomplete Input-mock failures | 31390.601960 |
| Required rerun after mock correction | 561/561 PASS | 39337.239884 |

All final runs report zero cancelled/skipped/todo cases. The report also discloses a later querySelectorAll fixture-shape error; only the first fixture-error log is retained here, so I do not claim separate log verification of that intermediate error. It does not supply behavioral RED evidence. The first affected failure is retained and the subsequent run is justified by the fixture correction; no repeat after final PASS is claimed.

Verified SHA256:

- Package: `52e9da1b22df69d4a7bec73c2bf5a4498373be243ad162cc4541f8c2de9658bf`.
- Fixture-error log: `bce91ba28db60b7a602b82178278f54e34aca54a48939390bc155ff2ac7c6683`.
- RED: `5155d645ffcd45bac4596c822f18ef7a8c4bfd20cbe0c962738fd580726b0c08`.
- GREEN: `79badc5515ded8ebb605d6231db87d0e6e18d88db9e0061ee254d2a66356d393`.
- Initial affected: `44b5aa583f4f6cd0997b509aefb4c1dec74712e29452de5563134bafde316433`.
- Final affected: `3319b27c218685e0c201cf5962a5a9f74846a1c3a2a121730361af69db4410f2`.
- webrtc.js: `4fde802193ca0057203a6fdf40a0c9a37ef64626444cb33bcde6bb8f82052924`.
- webrtc.test.js: `014419a505c6f2170bb3d91fc3f53e00e31bcb1ad5d86398eb66b0f2200eff8c`.

## Limits and handoff

Task review coverage is complete, with no deferred minor implementation finding. This closes the task's spec and quality gates only. Root still owns final whole-increment review, new asset/source/tool bindings and any rollout. Source approval is not deployed-Viewer evidence, runtime qualification, permanent-stall proof, historical R5 attribution or a startup latency improvement measurement. The inert-timer fixture does not verify real timeout scheduling; budgets were checked statically as unchanged. Native/business/visible/physical outcomes and all six input metrics remain NOT_RUN/null.

Only this private report was written. No project/operational imports, tests, builds, runtime/process/status/service/network/browser/native actions, source/index/package edits, commits or subagents were performed. Root owns archival and review anchors. Pre-existing dirty documents and node_modules were untouched.
