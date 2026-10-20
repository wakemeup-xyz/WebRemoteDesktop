# Adjacent relay fixture synchronization report

Status: implementation and self-review complete; independent review pending with parent. No final task acceptance claimed.

Base: 509220db01c04cccbe9696322a3dc8639672d08d.
Commit: cae6650 (test(viewer): align continuity relay fixtures with M6 scope).
Owned tracked file: web-client/js/input-signaling-continuity.test.js only.

## Changes

Added a relay-only fixture helper carrying version 1 and the exact five-field relay scope. It authenticates origins through actual handleMediaActivityAck and delivers frames through actual handleRelayFrame. Non-relay helpers are unchanged. Neither selected scenario uses ordinary start; the refresh exercises its actual explicit media-control replay request, whose generation supplies the replacement scope. No pending start ACK is synthesized.

Retained-load regression now captures genuine installed onload handlers after scope acceptance, then replaces attempt and producer before invoking the old handlers. Existing resuming and absent rendered-frame assertions remain. The positive replacement requires an authenticated new scope and genuine image onload.

Refresh establishes initial scoped ACK plus loaded image, invokes actual refresh, rejects old ACK and frame, rejects a current frame before authentication, accepts current ACK while remaining resuming, then requires a current scoped image load for active. Assertions also require frame arrival alone to remain resuming.

## Exact RED / GREEN

RED command before edits:
`node --test --test-name-pattern='relay image load retained|real tunnel refresh' web-client/js/input-signaling-continuity.test.js`
Result: 2 tests, 0 pass, 2 fail. Retained load: TypeError load is not a function at original line 632 because legacy frame was rejected. Refresh: resuming != active at original line 673 because legacy ACK lacked M6 scope. Neither was an import/setup failure.

GREEN same targeted command: 2/2 pass, 0 fail/skipped/cancelled/todo.

`node --test web-client/js/input-signaling-continuity.test.js`
Result: 33/33 pass, 0 fail/skipped/cancelled/todo. Log: /tmp/wrd-relay-fixture-continuity.log.

`node --test web-client/js/input-backpressure.test.js web-client/js/input-recovery.test.js web-client/js/input-signaling-continuity.test.js web-client/js/webrtc.frame-trace.test.js web-client/js/diagnostic.test.js`
Result: 156/156 pass, 0 fail/skipped/cancelled/todo. Log: /tmp/wrd-relay-fixture-adjacent.log.

`git diff --check`: success before commit.

## Review and boundaries

Self-review: the diff changes only the named test and keeps original negative identity/freshness assertions. Scope has exactly producerId, productionGeneration, connectionAttemptId, mediaGeneration, leaseEpoch. Old callbacks are actual installed production handlers. No generic noteMediaRenderedFrame injection is used by either repaired relay test. No production validation, thresholds, or success criteria changed.

Independent review: pending; parent must record/review before marking complete. No subagents spawned.

Preserved all pre-existing dirty documents and unrelated untracked node_modules entry. No product/primary/runtime/browser/native/network/build/dependency/service/tunnel operation performed. Git index released to parent after this report. These offline tests do not establish deployment or real-session acceptance.
