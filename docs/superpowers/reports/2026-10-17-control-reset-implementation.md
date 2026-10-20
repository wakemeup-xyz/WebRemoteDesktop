# Control teardown reset implementation report

Completed 2026-10-17 in the delegated reliability-latency worktree. Read the task brief, linked spec/addendum and adjacent audit before changes.

Commit: c3abb21 (`fix(input): normalize control teardown keyboard reset reasons`). Only web-client/js/webrtc.js and web-client/js/input-signaling-continuity.test.js are committed. Source and index ownership released to controller after this report; index is clean. Existing README/runbook/requirements/review-anchor modifications and node_modules symlink remain untouched.

## Implementation

Exactly two production argument changes: freezeControl's existing reset/non-suspended branch calls resetKeyboard('control-revoked'); releaseControl's existing non-preserveAcquireIntent branch calls resetKeyboard('deactivated'). No condition, ordering, lifecycle/pointer/control-release reason, scope, timeout, lease handling or M6 gates changed. d057853 remains present and intact.

The real existing continuity VM fixture now captures DOM event handlers. New tests execute the actual recovery control button click through real Input, RemoteKeyboardController and KeyboardTransport; actual host-offline, control-heartbeat-rejected and default freeze paths; and suspension/reset=false/preserveAcquireIntent skip paths. Emitted keyboard envelopes go through the unchanged Signal pure validator. Tests verify original lease/epoch, exact initial seq=1, single generated inputId preserved between Socket emission and captured envelope, reset-before-control-release ordering, original lifecycle/pointer/control-release reasons, revoked/null-lease state, stale late ACK and closed input/control gate. Pointer instrumentation delegates to real releasePointer (no reset-method stubs). Signal disconnect keeps the parked lease and ready keyboard sequence context.

## Verification

Targeted RED: `node --test --test-name-pattern='control reset protocol' web-client/js/input-signaling-continuity.test.js`: four producer cases fail with INVALID_RESET_REASON, skip-policy case passes (4 failed/1 passed). First test draft incorrectly expected a suspended transport state; corrected test to existing ready state plus parked lease check before final RED. First GREEN draft incorrectly expected a clean pointer to emit a reset; corrected to instrument/delegate actual releasePointer call and preserve reason assertion. These were fixture assertions, not production changes.

Targeted GREEN: same command, 5/5 pass. Full requested suite:
`node --test web-client/js/input.test.js web-client/js/keyboard-transport.test.js web-client/js/webrtc.test.js web-client/js/input-backpressure.test.js web-client/js/input-recovery.test.js web-client/js/input-signaling-continuity.test.js`
534/534 pass, 0 failed/skipped, ~26.65s. Includes full continuity and prior M6 two-prerequisite ordering/real validator coverage. `node --check` both changed files and `git diff --check` pass. Local temporary logs: /tmp/wrd-control-red.log, /tmp/wrd-control-green.log, /tmp/wrd-control-suite.log.

## Self-review and limits

Production diff is precisely the specified two string arguments. No Input/Signal/Host production change, protocol enlargement, reset ACK waiting, pending-barrier or formal release alteration. No native/browser/network/service/tunnel/build/dependency or primary-checkout operation. This corrects accepted wire reasons without claiming lasting input failure, resolving earlier media pause, loading production or native input verification. Independent review is still required before controller Task 2 deployment. No known unresolved implementation concern.
