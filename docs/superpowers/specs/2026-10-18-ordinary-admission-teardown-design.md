# Ordinary admission-listener teardown correction

**Status:** implementation design; actual R5 failed attempt is retained. This is a bounded acceptance-tool fix under the existing implementation and maintenance instruction, with no service restart.

## Problem and evidence

The deployed Viewer c802/build bb581 sustained 300.2765 seconds of passive continuity in R5 attempt ba047879c33f00f14b603780026ba53a. Its worker nevertheless exited1 with cleanup-incomplete. Final capture succeeded; browser close and manager stop succeeded; failure was recorded1ms after stop. The attempt remains failed-or-indeterminate, not baseline qualification. Its result SHA256 is 5ef3358f1a1ee0bb5ef72e816952c5874d0826c8795c67616ba0a85ff73a42b9.

The ordinary runner removes request/response listeners after OwnedBrowserLifecycle.cleanup has stopped Playwright. Installed Playwright performs protocol subscription updates during remove_listener, and stopped connections reject them. This is a concrete static teardown defect and a strongly supported explanation of this actual failure. The original caught exception was not retained, so the exact runtime exception is unknown. The independent assessment is /tmp/wrd-r5-baseline-cleanup-failure-assessment-20261018.md and must be archived with the execution report.

## Selected change and alternatives

Move the one admission detachment into OwnedBrowserLifecycle's existing cleanup coordinator, after the final export/observation and before browser close/manager stop. Expose one narrow optional no-argument callback on the owned lifecycle; production binds the existing guard.detach method. The callback removes only those two owned listeners. No new owner, listener, retry, service operation, browser session, or generic cleanup framework is required.

Removing listeners before final export would leave the final observation without admission monitoring; retaining post-stop removal while swallowing its exception would conceal a real cleanup failure. Both are rejected.

## Required lifecycle contract

1. Preserve disarm → final observation/export → admission detach → browser close → manager stop. Existing fault disarm and final evidence validation stay unchanged.
2. Detach executes exactly once through the existing idempotent cleanup coordinator, including after export/disarm failure. If no guard was created, it is absent. Detach errors remain cleanup-incomplete; never convert an already failed run into PASS. Attempt both close and stop independently after any detach failure.
3. Await an awaitable callback only through existing lifecycle_stage with at most the existing1s export-stage cap and the same original total8s cleanup deadline; reuse cleanup_allowance without adding a deadline, grace period or resetting clocks. Existing5s close/3s stop maxima and reserved manager-stop allowance remain. Synchronous production remove_listener calls do not introduce blocking I/O.
4. Delete post-stop guard.detach. The existing snapshot and lifecycle schema remain unchanged; captureStatus continues to describe final export independently of detach failure. No raw error/URLs/request bodies are persisted. ownedProcessExitEvidence remains not-observed and full process-tree exit remains unknown.
5. A failed export remains the first failure. Repeated cancellation cannot cause duplicate detach/close/stop or bypass existing cancellation settlement.

## Verification and operational boundaries

Add a strict fake page/manager subscription boundary that rejects listener updates after stop. Use the actual runner finalization path and its real300-second reducer with a fake scheduling clock, preserving qualified durations/counts. Establish RED on old production code and GREEN for success ordering, detach failure, final-export failure, repeated cancellation and no-guard startup failure. Existing runtime/baseline/strict-consumer suites run once after covering tests pass. No new native input, service/network/browser run is part of the implementation tests.

Acceptance needs new reviewed tool/source pins, fresh idle/admission and a new zero-time baseline. Keep R5 rows/result/markers immutable. No replay, reminting the old attempt, clearing ownership, relaxed terminal gate or crediting its300 seconds. Existing Viewer/Signal/Host and tunnel remain running. Business/native/visible/physical remain NOT_RUN and all six input metrics remain null until separately supported.
