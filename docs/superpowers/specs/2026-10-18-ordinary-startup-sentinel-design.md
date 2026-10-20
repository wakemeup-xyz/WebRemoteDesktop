# Ordinary startup sentinel compatibility correction

2026-10-18. Corrective increment after the first guarded ordinary baseline of deployed `dfb15434e79da90b803b763c533836e16c080c71` ended before Start with `startup/schema-rejected` and zero qualified rows. The failed attempt and its one-use operational marker remain immutable.

## Evidence and intent

The fresh Viewer initializes `currentConnectionAttemptId` to `''`; `latencyScope()` and the unchanged native sampler preserve it. The ordinary runner rejects that non-null empty string before creating its sole UI Start action. Existing injected runtime fixtures supply an already-ready nonempty attempt at this boundary. This is a demonstrated producer/consumer incompatibility. The failed run did not preserve the rejected raw sample, so exclusive field-level attribution to that run remains unproven. It is not evidence of an actual Host disconnect or failed recovery after admission.

The user has authorized continued fixes and acceptance, with brainstorming and writing-plans without repeated planning approval. This is a bounded correction within that scope. Source changes affect only the ordinary runner and its focused tests; deployed Signal, Host and Viewer code/assets do not need to change or restart for this correction.

## Selected design

Normalize exactly the native sampler's empty-string no-attempt sentinel to `None` at the ordinary runner's raw-sample boundary, before calling the unchanged `passive.private_row`. Copy the dictionary when normalizing; do not modify an injected producer object. Existing null remains absent. Nonempty bounded UTF-8 IDs retain their current validation and salted hash. Non-string, overlength and invalid-encoding values remain rejected. Do not hash the empty string into an apparent attempt identity.

The boundary accepts the producer representation in every observation phase. An absent attempt never meets existing qualification gates; after Start it cannot preserve or manufacture a valid baseline/recovery identity. Do not make source readiness assumptions to skip the initial observation, omit rows, advance qualified time early, create Start twice, or alter any lifecycle/schema/continuity threshold.

Rejected alternatives: changing the shared sampler or strict proof helper expands scope and invalidates their pinned evidence; skipping the first tick hides startup coverage; replacing the fake's initial state with another ready state repeats the test gap; globally accepting invalid IDs weakens privacy/schema checks.

## Verification

Add a production-shaped pre-Start fixture: installed core, authenticated fresh shell, exact guarded selector, no socket/PC/attempt/ordinary IDs, attempt `''`, generation/lease0, zero callbacks, null frame ages, unavailable transport and blocked gates. The initial observation must be retained, hash absent, qualified duration/count unchanged and exactly one UI Start reachable. Then use legitimate UI verification and ready observations to qualify the existing baseline. Cover the core-not-yet-installed/null-attempt state and malformed attempt negatives. An absent attempt in an otherwise ready later sample must not yield PASS. Keep raw identity canaries absent from persisted artifacts.

Demonstrate behavioral RED on the pre-fix boundary and GREEN after the correction, then run the ordinary runner and fault-adapter focused Python suites once. Pure injected fakes may run; no real browser/network/process/service operations by the implementer. Existing bounded Node-VM children are allowed only if those assigned suites invoke their established helper. Root alone owns live acceptance.

## Operational and evidence boundary

Independently review this delta before tool-only promotion. A fresh reviewed operational continuation must bind actual deployed product source/build/PIDs separately from the corrected runner revision, preserve the prior failed attempt, verify fresh vacancy/human priority, and issue a distinct one-use attempt record. Do not reset or replay the R6 marker, reuse the obsolete pre-deployment freeze/apply baseline, or restart services just to change the runner.

The original immutable supervisor and its conservative ownership/coverage semantics stay unchanged. Seven recorded identities exited without signals in the failed run, but `observation-unavailable` prevents complete cleanup coverage; this must not be reclassified as inherent polling uncertainty or a proven leak. A bounded diagnostic extension requires separate review and may not suppress any coverage failure.

All existing row/run/cleanup/startup deadlines, full media/input readiness gates, ordinary authority/resume rules and proof nonresumability remain. Business input, visible effect and physical qualification stay NOT_RUN. Four pre-existing dirty documents, node_modules link, primary index, W2, tunnel/watch and prior evidence remain untouched.
