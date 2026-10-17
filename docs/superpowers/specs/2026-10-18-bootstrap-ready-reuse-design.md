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
