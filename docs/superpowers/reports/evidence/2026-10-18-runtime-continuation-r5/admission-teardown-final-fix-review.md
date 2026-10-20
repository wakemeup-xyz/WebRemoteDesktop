# Final scoped fix review — admission teardown first-failure priority

**Finding 1: ADDRESSED. Verdict: Approved. No new actionable findings in the scoped fix.**

Reviewed only the prior P2 and new-breakage risk of `3662573fc8a6c4c6561f427d8f80f0491fa373c0..2822441791b59a021556c7e4eb24715df9d5b277`. HEAD resolves to the latter. Read the complete 11,461-byte review package, final-fix brief, appended task report, actual relevant runner/model/log and fixture code, and all three retained fix logs. The package embedded diff matches `git diff --unified=10` for this range byte-for-byte; range diff-check is clean. Only the runner and its tests change (+17/-7). Concurrent planning/archive files are outside this scoped review.

## Finding 1 closure

The lifecycle initializes one private boolean `_admission_detach_failed`, latches it in the detach-stage exception handler, and leaves it latched through independently attempted browser close and manager stop. Immediately after the one cleanup coordinator settles, the run owner consumes that latch through its existing `fail(ValueError('cleanup-incomplete'))`, before log close/reason handling and fault finalization.

This restores the previously lost ordering: a detach error is recorded before a trailing partial server-log line becomes `server-log-gap`, or log close raises `server-log-unavailable`. The existing first-wins model and failure-timestamp guard preserve an already recorded export/business/cancellation failure. The fix does not move or duplicate detachment and does not call failure handling from an additional cleanup owner. Detection is still recorded by the run owner after coordinator settlement, as in the pre-increment outer-detach path; it does not claim a new precise timestamp for the earlier internal detach stage.

The new regression uses the actual full 300-second reducer and actual runner finalization. At final export the fake page writes an actual incomplete line into the existing temporary server-log fixture, allowing the real reader to retain it and real close to declare the gap. The combined case injects detach failure and requires primary cleanup-incomplete; the successful-detach control requires server-log-gap. Both require captureStatus=ok and incomplete server coverage. This exercises the reported control-flow interaction rather than manufacturing a failure reason or replacing the log consumer. Resetting the empty log before each subcase prevents cross-case contamination and retains the pinned regular-file identity.

The original qualified success and final lease/path/counter/PC/attempt/generation rejection cases remain, as do isolated detach/export failures and teardown ordering checks. Retained GREEN also includes earlier-human-priority failure, repeated cancellation, partial-start/no-guard and lifecycle timeout/idempotence cases.

## New-breakage assessment

No actionable regression was found in the narrow delta. The private latch is not emitted through snapshot, record, result or CLI schemas and carries no exception details. Capture status remains independent of detach failure. The existing 8-second coordinator deadline, 1-second detach cap, 5-second close maximum, 3-second stop maximum/reservation, cancellation settlement, idempotence and independent close/stop are unchanged. Admission monitoring still covers final export. No gates, quality settings, retry behavior or runtime authority are relaxed. ownedProcessExitEvidence remains not-observed; full-process-tree exit is not established.

The correction implements the existing spec/plan's first-failure intent and does not require a public contract change. The appended worker report accurately describes the new code and retained runs. The prior request-changes review remains historical evidence, with its one finding closed by this report; no deferred minor implementation finding remains from that review.

## Retained test evidence

Read and independently hashed existing logs; no test was rerun.

| Run | Actual result | Elapsed | SHA256 |
| --- | --- | ---: | --- |
| final-fix-red.log | 1 behavioral failure, combined case returned server-log-gap instead of cleanup-incomplete; no fixture errors | 52.734s | 67356b94cdb26d16486d43a5fd325a219c6f276060b67720a259e583f058327a |
| final-fix-green.log | 8 PASS | 64.663s | f31b99ae132c14d208e1a76aae087ad7d815d4e7fcdeaa2d12fc3cd7b9c970f4 |
| final-fix-affected.log | 166 PASS; one reported affected-suite execution on new code | 168.873s | f942a53a62c48d7a7c8f3b33a8b0736af2992b9bb391e35f3bc11f44039b1b4e |

The passing logs retain asyncio slow-task diagnostic messages; those do not change their recorded PASS, establish a production performance issue, or qualify runtime performance.

Package SHA256: `7c908e8760567011affcaaf76966d75e641223012003bd3db10ba1843322114f`.

Current runner SHA256: `0203396cad0a65871f97604a3dbf275f95331939e4e42bc07e392a248fd85341`.

Current test SHA256: `8687334287d8810942b5d240cd5eb2ebc0be8bfb010e828e540d15f9b46c1170`.

## Limits and handoff

This completes the one scoped fix re-review and closes the original P2. It does not rerun or expand the whole historical review, independently qualify actual browser behavior, authorize an operational package, or establish deployed tool identity. Tool promotion remains unperformed; the actual failed R5 baseline cannot gain qualification credit. A future exact reviewed context and fresh zero-time baseline remain necessary. Native/business/visible/physical acceptance and missing input metrics remain NOT_RUN/null.

Only this report was written. No project/operational imports, tests, builds, runtime/process/status/network/service/browser/native actions, source/package/index changes, commits or subagents were performed. Verification used read-only text, standard-library hash parsing and Git inspection. Root owns any repository archival and subsequent scoped provenance review.
