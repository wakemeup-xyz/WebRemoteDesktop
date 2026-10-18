# Startup configuration and control-grant ordering

**Status:** bounded implementation design, 2026-10-19. Source base a68b040; deployed Viewer remains c802/buildbb581 until a later separately recorded rollout. Existing user implementation/maintenance instruction applies; no further planning-path approval is requested.

## Confirmed problem

Actual-method offline characterization and independent review confirm P2: authenticated ordinary start opens signaling while bootstrap is pending. A fast valid control grant creates PC1 and emits its offer despite _deferPeerUntilConfig=true. After configuration arrives, init closes PC1 and creates PC2 without a matching offer; the correct answer listener rejects the later answer on stable PC2. Ready-bootstrap control creates one peer/offer and applies its synthetic answer.

Evidence: /tmp/wrd-startup-pc-ordering-characterization-20261019.md and /tmp/wrd-startup-pc-ordering-characterization-independent-review-20261019.md. Characterization script SHAed8a09bc05f951807f09cd5ac9ec14fee48304b66d8411bcdb58f5ee62e672bd, result SHA3eb894e5ec9d6ad08f3260a8422697e79366cfc57443fb384c88269beff83938. Exit0 asserts defective behavior, not the desired invariant. First DOM fixture error is separately retained. Input was absent in that characterization, so implementation regressions must additionally cover real Input acceptance and its unavailable/recovery branch.

This establishes a local ordering defect, not permanent stall, frequency, real Host acceptance, historical R5 cause or measured latency saving. R5 bootstrap completed before signaling and remains failed/cleanup-incomplete.

## Selected design

Keep configuration fetch and signaling parallel. Join current configuration readiness and current accepted control authority at the two existing points: initialized configuration/peer completion, and valid control grant. Use one narrow shared non-tunnel media reconciliation method in WebRTC, rather than replaying the grant or introducing another state owner. It must consume existing current episode/auth/socket/attempt/lease and Input checks; a remembered grant is not new authority.

Reject serializing all signaling behind configuration: it sacrifices existing overlap and conceals the missing readiness fence. Reject retaining the pre-config peer: its ICE/config and attempt may be stale. Reject a grant-only early return: init currently would never negotiate an already granted peer. Reject an unconditional init offer or removing the answer guard: both can violate authority or duplicate negotiation.

## Required invariants

- For ordinary non-tunnel initial startup, no PeerConnection creation or offer emission while the current configuration is deferred. Apply the fence at the actual media entry points as needed so a different socket callback cannot bypass it. Existing admission, control-acquire, grant validation and lease heartbeat may proceed.
- Configuration first then grant, or grant first then configuration, converges to one configured current peer and one matching initial offer. Neither needs a second grant or an automatic retry. A completed/in-flight matching initial offer is not emitted twice merely because init and a duplicate/current grant both reconcile. The transient offerInProgress flag alone is insufficient after it clears.
- Init reconciliation must retain the existing Input.setControlLease false-return/recovery gate; hasActiveControl alone is insufficient because WebRTC controlState is updated before the Input gate. Use the existing current Input API/state and existing requestControlRecovery path. Do not fabricate a grant, clear reacquire-required/reset state, enable input, or introduce an authority cache. Validate the real fresh-lease Input path.
- Preserve createOffer ownsOffer epoch/PC/socket/attempt/lease/episode checks across every await and existing stale-answer guard. Cancelled, superseded, changed-auth/changed-lease configurations or offers remain inert. A stale asynchronous offer must not mark a replacement peer as offered.
- Limit initial-offer duplicate suppression to the current matching startup peer/attempt/lease. Preserve legitimate later renegotiation, same-session recovery, refresh, port search and completed-session regrant behavior; do not globally disable createOffer after a localDescription exists. Prefer existing local SDP/signaling/ownership state over another registry. Any narrow private marker must have explicit identity, success boundary and invalidation and be justified by tests.
- Preserve tunnel/JPEG behavior, manual network selection, ICE/TURN policy, 8/72/12-second startup budgets, reset/lease/quality gates, media pause intent and no-input-replay behavior. No retry/grace/deadline extension. No new logging of payload/credentials/SDP/IDs or generic telemetry subsystem.

## Scope and verification

Modify web-client/js/webrtc.js and its existing webrtc.test.js only; if a distinct existing test file is necessary root reviews the exact addition first. Reuse actual startViewer/admission/bootstrap/socket/grant/init/peer/offer/answer methods with fake platform transports/auth/RTC/clocks, and real Input for the positive current-grant path. Do not assign product fields to manufacture the disputed ordering or replace changed methods with no-op models.

Required behavioral RED asserts zero peers/offers before applied config and one matching peer/offer/answer after both prerequisites; old production must fail. GREEN matrix includes delayed config/fast grant, ready config/late grant, duplicate grant, in-flight offer/duplicate callbacks, cancellation/supersession/auth change before config resolution, Input unavailable/recovery, no control, and completed-session recovery compatibility. Fake media is not visible/native acceptance; gate may remain closed without real frames.

Run focused cases then affected WebRTC/Input/bootstrap/sampler suites once. Independent task spec+quality review and final whole-increment review precede any new assets/rollout. Old a68 tool-only draft was stopped unsealed/unexecuted, so no partial runtime mutation needs repair. New Viewer assets and exact source/tool context are required later; no source commit/build/offline PASS qualifies actual runtime.
