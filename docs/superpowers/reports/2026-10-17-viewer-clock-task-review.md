# Spec Compliance

- ✅ Spec compliant for the selected local-duration migration at source `3ca62fedb26dcf3f4dc53497af5a84af4dae622f` against `836dccd22d501134dcffd2651303f502f94740a8`.
- Input producer/consumer pairs now share `performance.now()` (`web-client/js/input.js:630`, `:1380`, `:1435`, `:1455`, `:1488`, `:2539`). WebRTC origins and resets use `null`; finite numeric zero remains usable for freshness/cooldown (`web-client/js/webrtc.js:465`, `:501`, `:517`, `:518`, `:1373`, `:1380`, `:2093`, `:6025`, `:6271`, `:6294`, `:6331`, `:6404`, `:6486`, `:6561`). No wall-clock or fixed-zero production fallback was introduced.
- The diff leaves timer values, ACK identity/scope checks, manual/superseded guards, business replay policy, protocol fields, and KeyboardTransport production code unchanged. The additional VM Performance API in `web-client/js/input-backpressure.test.js:14` is justified because its real Input calls reach the migrated deadline methods.
- ⚠️ Deployment, browser/native input, long-session behavior and the complete unchanged admission/proof machinery are outside this task gate. They are not established by the offline suite or this review.

# Strengths

- Actual Input regressions exercise two pending writes, oldest-deadline rearm, ACK removal, true timeout and once-only guarded recovery, ±60000ms wall jumps, mobile edges, stale scope/sequence and genuinely late ACK (`web-client/js/input.test.js:3087`, `:3104`, `:3120`, `:3141`, `:3155`).
- Actual WebRTC methods cover zero-origin signaling at 1500/12000/13500ms, decoded progress/freshness, first and repeated refresh/keyframe requests, generation reset and cancellation (`web-client/js/webrtc.test.js:7659`, `:7677`, `:7695`, `:7732`). Explicit fake page clocks keep wall changes independent of timer scheduling.
- Existing fixture updates preserve their original behavioral assertions while adapting timestamp setup to the new clock. The production patch remains small and uses existing owners.

# Issues

## Critical

- None in the clock task.

## Important

- None in the clock task. The two pre-existing relay fixture failures below remain a separate adjacent-suite repair item and must not be counted as passing acceptance or clock regressions.

## Minor

- `web-client/js/webrtc.test.js:7636`: the new duration fixture inherits the live console, so intentionally triggered recovery paths emit warning/log noise into passing evidence (`/tmp/wrd-viewer-clock-exact-green.log:3384`, `:3409`, `:3413`). This is expected simulated behavior, not a production failure. Capture console messages in the fixture (and assert any relevant ones) to keep successful test output clean. Existing unrelated suite noise is also present, e.g. the deliberate HTTP 500 path at log line 722.

# Adjacent relay fixture classification

- **Both are stale fixtures missing the current M6 authenticated relay scope contract; the reported failures do not identify a production bug.** Baseline evidence `/tmp/wrd-viewer-clock-baseline-adjacent.log` reproduces the identical two failures with BASE Input/WebRTC sources. Static inspection establishes why they fail; no suite rerun was needed.
- `web-client/js/input-signaling-continuity.test.js:628` submits a legacy frame with no `relayFrameSchemaVersion` or `relayScope`, and no accepted relay origin. `web-client/js/webrtc.js:4945` rejects it before installing `onload`; therefore calling the captured value at test line 632 raises `TypeError`. The current contract requires version 1 and an accepted exact scope (`:4595`, `:4656`); schema-valid active media ACKs accept the scope (`:1062`, `:1104`), while ordinary relay starts use the correlated start ACK (`:4691`).
- `web-client/js/input-signaling-continuity.test.js:672` calls the generic `h.ack(8)` helper, defined at `:524` without any M6 fields. With relay active, `web-client/js/webrtc.js:1064` rejects that ACK, so the assertion at test line 673 correctly remains `resuming`. Its later ACKs and frame at test line 682 have the same outdated shape. A generic `noteMediaRenderedFrame` injection is also not a substitute for testing real qualified image loading.
- Narrow fixture repair: introduce a relay-only scope/ACK/frame helper with exactly `{producerId, productionGeneration, connectionAttemptId, mediaGeneration, leaseEpoch}` and `relayFrameSchemaVersion: 1`; authenticate each new origin through real `handleMediaActivityAck` before delivering its frames. For ordinary starts, echo the actual pending start request ID and generation through `relayControlKind: 'start'` ACK. Existing helpers in `web-client/js/webrtc.test.js:5265` and `:5271` demonstrate the required envelope. Keep non-relay helpers unchanged.
- For the stale-load case, capture an actual valid image callback, replace attempt or producer, then invoke the retained callback and assert it cannot activate the replacement; authenticate the replacement scope before delivering its current frame. For the refresh case, apply a scoped initial ACK and loaded frame, refresh, reject the old-attempt ACK/frame, apply the current scoped ACK, assert ACK alone stays `resuming`, then load a matching current frame and assert `active`. The old frame-before-unauthenticated-ACK ordering is no longer a valid success path. Do not weaken production scope validation to preserve it.

# Checks and Evidence

- Read the task brief, linked clock spec, implementation report and provided review diff. The tool truncated one combined output; recovered only the omitted diff range. No git commands, builds, suite reruns, browser/network/service/native actions, dependencies or subagents were used.
- Named risk: a missed timestamp consumer could mix epoch and page clocks or leak a changed value. A focused selected-field reference inventory across production JS found only the expected owners plus the unchanged boolean presence diagnostic at `web-client/js/diagnostic.js:430`; the corresponding request still sets `_keyframeRequested` (`web-client/js/webrtc.js:2106`), so valid page zero is represented. No added wire timestamp exists in the diff.
- Named risk: the adjacent failures might indicate a production regression rather than old fixture setup. Inspected only their fixture/test blocks and the relevant unchanged relay ACK/scope/load path, plus existing M6 helper examples. These reads are outside the clock diff and were necessary to classify the explicitly assigned adjacent failures.
- Read existing logs: `/tmp/wrd-viewer-clock-red.log` reports 15 tests, 1 pass and 14 assertion failures; `/tmp/wrd-viewer-clock-targeted.log` reports 15/15 passing; `/tmp/wrd-viewer-clock-exact-green.log` reports 427/427 passing with no skipped/cancelled/todo; `/tmp/wrd-viewer-clock-adjacent.log` reports 154 pass, 2 fail; baseline evidence reports the same 2 failures. Syntax/diff-check success is reported by the implementer and was not redundantly rerun.

# Assessment

**Task quality: Approved.** No actionable clock correctness or scope violation was found. The new behavioral tests substantiate the selected migration; adjacent M6 fixture updates should be handled separately, preserving current production admission checks.
