# Bounded reuse of a completed Viewer preload

## Problem and evidence

The formal short run loaded bootstrap twice, while click→bootstrap-ready took1678.1ms and click→first frame9156.8ms. Current bootstrap-controller.js deduplicates only inflight loads, discarding reuse eligibility when a successful preload settles. The original fast-bootstrap design intended warmup and Start not to duplicate requests. This does not establish that every historical failed connection or all startup delay came from this gap. Host ICE gathering in that run was only about219ms, so a presumed5s Host gather timeout is unsupported.

## Selected approach and alternatives

Keep one successful ready snapshot eligible for reuse for strictly less than3000ms after completion, keyed by exact mode, requested TURN ID and current authentication generation. This removes a redundant fresh-page request while bounding configuration staleness. Remove preload would avoid duplication but place the whole request on Start; indefinite caching would retain stale Host/TURN configuration. Neither alternative is selected. An inflight identical request continues sharing its promise.

## Contract

- Controller options add now (monotonic milliseconds), getScope (opaque comparable identity), cacheMaxAgeMs(default3000, finite0..3000;0 disables). Existing callers without options remain compatible.
- Exactly one fixed cache slot, only successful ready, exact mode/TURN/scope. A cache hit neither fetches nor renews completion time. Age must be finite, nonnegative and strictly below the configured limit; rollback/invalid clocks miss. No storage, timer, queue or cross-page cache.
- Loading a different key/scope, forced retry, cancel, failed/auth-required/degraded result invalidates prior eligibility. Stale late completions cannot publish or cache for a new generation/scope; preserve current supersession contract where compatible.
- Actual Viewer passes Auth.getGeneration as getScope; successful network response also rechecks captured token/generation before returning. Existing Start pre/post verified token+generation guards, fresh viewer admission, proof-only admission and current Signal/Host checks remain unchanged. No authentication/grant/ticket/proof is cached or bypassed. Existing startup retirement cancels the controller, so failure/manual retry cannot resurrect a retired cached result.
- Config remains in memory and includes the already existing TURN data; no values or scope keys enter diagnostics/logs. Cache key/scope/time are private controller state. No new public startup mark or protocol field.
- No media/network/TURN selection, first-frame/outer startup deadlines, input/reset authority or UI flow changes.

## Verification and rollout

Behavioral RED: preload resolves successfully; within fake clock budget identical Start must return that result with exactly one fetch, current implementation performs a second. Fake deterministic tests cover expiry at3000ms, no TTL renewal, disabled/invalid/rollback clock, mode/TURN/auth-generation mismatch, force/cancel, failed/degraded/auth-invalid, late old scope and existing inflight sharing. Integration exercises real controller with Auth/WebRTC harness: verified Start after completed warmup skips duplicate config fetch; fresh admission and existing Auth guards remain. Run direct Node pure suites for changed boundaries, no npm/pretest/live builds. Static review checks actual applyBootstrapSnapshot caller for config mutation/cache interactions.

Root final review, exact source freeze and temporary output build precede guarded primary sync/Signal-only reload; Host process and tunnel remain untouched. Report both local passwords after reload outside versioned files. Fresh normal UI Start under existing supervisor,300s formal qualification, then new10800s run. User has no time for manual testing and asked continued optimization; actual input/visible effect staysNOT RUN without fabricated evidence.

## Production defer-order follow-up

The loaded8675e85/6b2ad956f6a6cdd8 short run passed301 observations over300.001086s, but Signal still served bootstrap twice. Its single-page click deltas were846.6/2812.8/7949.5ms for bootstrap/signaling/first frame; these are not a percentile or proof of a cache hit or causal improvement.

Production desktop-core is deferred. Auth registers its init on DOMContentLoaded, while WebRTC can queue bootViewerShell as an interactive-state microtask before that event. An immediate warmup can therefore capture generation0, followed by Auth.init advancing generation1; the correct scope fence discards that preload. The old integration harness uses loading state and invokes Auth's listener before boot, so it does not cover this ordering. Runtime logs do not expose cache disposition or prove that this explains every repeated request.

Gate the page's one automatic warmup on its first current verified Auth check. Use the existing Auth subscription and recheck the current state once the controller is constructed so an already-verified page is also covered. No request may start merely because a token exists or Auth is unavailable. Read current mode/TURN at warmup time. Repeated verified notifications must not create more automatic warmups. Keep the controller's strict3s lifetime, generation/token fences, Start's fresh admission and all deadlines unchanged. Starting while verification completes must share the warmup request; retry/changed identity still follows existing invalidation. Do not trigger Auth.init/verify from preload or create a second auth owner.

The behavioral regression must reproduce production interactive/defer ordering: queue boot after bundle declarations but before DOMContentLoaded; show zero bootstrap requests while verification is pending, then one current-generation warmup and no second fetch on an immediate verified Start. Cover loading state, already-verified boot, repeated verified publication, unavailable/unauthorized checks, delayed verification and fresh ordinary/proof admission. Platform/media effects may remain stubbed; the real Auth/controller/boot/Start paths must execute. Compare eager-preload removal and TTL expansion: removing preload loses overlap, and expanding TTL weakens freshness without fixing scope. Neither is selected.
