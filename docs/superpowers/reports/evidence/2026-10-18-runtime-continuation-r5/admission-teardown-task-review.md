# Independent task review — ordinary admission teardown

**Findings: none. Spec compliance: Approved. Code quality: Approved.** No actionable correctness, architecture or documentation-sync issue was found in this task increment.

Reviewed exact range: `c54a352d621aeaf8946ffbd1d15fdd062f831223..380e4e432e76a4dca63a816323f553f8a00d0fce`, in `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`. HEAD resolves to the latter commit. The supplied review-c54a352..380e4e4.diff matches the actual range's `git diff --unified=10` byte-for-byte. Only scripts/ordinary_session_recovery.py and scripts/test_ordinary_session_recovery.py change (+71/-13).

Read the task brief, linked progress/spec/plan, worker report, exact diff, relevant cleanup helpers and existing run/failure/cancellation paths, and retained RED/adjustment/GREEN/affected logs. The original assessment of the R5 failure was already independently produced by this reviewer; the task fixes its concrete teardown-order finding. No tests or operational entrypoints were imported/executed during this review.

## Spec compliance — Approved

- `scripts/ordinary_session_recovery.py:595` adds only one optional narrow no-argument admission callback. The actual guard is bound immediately after construction at`:1324`–`:1325`; a partial start that never creates a guard leaves the hook absent. There is no new owner or generic cleanup framework.
- Existing disarm/final_capture and final admission validation are retained (`:631`–`:649`). The callback executes only after that export attempt and before browser close/manager stop (`:650`–`:661`). The post-stop detach is removed from run's finally. This directly corrects the invalid stopped-transport subscription update while keeping final evidence monitored.
- Export failure is caught before the callback, so it does not skip detach. The existing `_cleaned` guard (`:625`–`:626`) keeps invocation to one cleanup attempt. Any detach exception sets the existing failed flag; close and stop remain separate independently attempted operations. Successful captureStatus is not overwritten by a detach error, and no raw exception or new schema field is persisted.
- The original total deadline is still created once at`:627`. The added stage uses existing lifecycle_stage and remaining('export') (`:652`–`:653`): at most the existing1s per-stage cap, clipped by the same total8s deadline. It does not create or reset a cleanup deadline. Unchanged cleanup_allowance preserves5s close maximum and3s manager-stop reservation; when export/detach consume time, the available close allowance shrinks rather than extending the total budget. The synchronous production callback performs the existing non-awaiting protocol subscription updates; no new blocking operation was introduced.
- The original shielded one-coordinator repeated-cancellation path remains (`:1372`–`:1380`). Existing fail-first model semantics and final cleanup veto (`:1393`) are unchanged. A prior export/business-observation/cancellation failure cannot be cleared by later successful detachment or API teardown.
- Snapshot/record/CLI/result schemas, guards, admission policy, privacy, quality controls and NOT_RUN claims are unchanged. ownedProcessExitEvidence remains not-observed (`:666`); no process-tree exit claim or outer-coverage substitution is introduced. Failed R5 evidence remains outside this increment and receives no credit.

## Code quality — Approved

The production change is small and assigns all teardown of the guard to the existing lifecycle owner. Its location expresses the required ordering directly, using existing exception bookkeeping and bounded-stage primitives rather than adding competing cleanup ownership. The run method only binds the existing detach method; no transport-specific library error is swallowed to force success.

The tests strengthen the shared fake manager/page so listener removal after stop raises, which models the previously missing subscription boundary. They reuse the existing actual full300-second reducer/fake scheduling-clock fixture rather than copying a runner or injecting successful qualification. Ordering assertions cover final-export→detach-request/response→browser-close→manager-stop. The original negative final lease/path/counter/PC/attempt/generation cases remain. Detach-failure and export-failure cases still fail, close and stop run, capture semantics stay independent, and process-exit evidence stays not-observed.

Additional cases exercise async detach timeout, cleanup idempotence, independent stop after close failure, retained earlier human-priority failure, exactly-once removal under repeated cancellation and existing no-guard partial-start coverage. The timeout case uses the actual lifecycle helper and checks the original cap map. These are meaningful behavioral checks for this change, without claiming real Playwright/native validation.

The tracked active spec and plan under docs/superpowers accurately describe the final callback, ordering, deadlines, unchanged schema and execution limits. No additional API/process-documentation change is required for this internal correction. Pre-existing dirty documents, untracked runtime evidence and node_modules are outside the reviewed commit and were not modified by this reviewer.

## Retained verification evidence

I checked the actual logs and their hashes; I did not rerun them.

| Run | Actual result | Elapsed |
| --- | --- | ---: |
| Required RED |1 test,1 behavior failure plus8 secondary ordering errors |10.634s |
| Expanded covering fixture adjustment |8 tests,1 incorrect capture-status expectation |10.074s |
| Focused GREEN |8 tests PASS |9.961s |
| Affected suites, once |166 tests PASS |37.357s |

The required RED's unchanged qualified baseline returns1 instead of0 (`AssertionError: 1 != 0`). Its other eight subcase errors are missing detach-request ordering entries because the strict fake rejects removal after manager stop before recording it; they are not eight additional independent behavioral reproductions. The report describes this honestly.

The intermediate adjustment log contains unavailable versus expected ok for the existing human-priority poisoned final observation. Removing that incorrect assertion does not weaken the actual qualified detach-failure coverage: the full qualified fixture separately asserts captureStatus=ok with cleanup failure. GREEN then covers both retained earlier failure and successful capture followed by detach failure.

Verified SHA-256:

- task-1-red.log: `d64aef4fd7fdaf91e2b23c74cdde08ada4c195e8e707d941fae3be456175fd3d`
- task-1-fixture-adjustment.log: `993600335238693dbf481f96b93aafe5bbefdec9a64ad84aa5d41aae9c630d6c`
- task-1-green.log: `e586ba9efad99ef1b7ef08fbc189ed265bea38a3318ec4bcedf7522eeb6c6ad7`
- task-1-affected.log: `191cf7de4a0c51015ad9cb77082168edd2b9735d64ac6a1ff2b0dd37a70ad633`
- ordinary_session_recovery.py: `bf83666bf856ddb092718a8ce4ccf8fab97efb0e96f2c1d7bbb5eb2b6ce92e89`
- test_ordinary_session_recovery.py: `707285c8917732f7326d08f81e9c280cc9e602132b7433c53759f605d65844b6`

## Limits and handoff

Review coverage is complete for this task's source/spec/quality scope. Offline fake tests do not establish actual browser API completion, runtime qualification, native IO, process-tree exit or input-to-picture behavior. Existing cooperative-cancellation and OS scheduling limits remain; no async primitive can force an arbitrary uncooperative callback to settle. Native/business/visible/physical acceptance remains NOT_RUN.

Root still owns final increment review, new exact source/tool/package pins, any promotion and fresh zero-time baseline admission. This report supplies no deployment or execution approval and cannot convert the immutable failed R5 attempt into a pass.

Only this report was written. No operational imports, test reruns, builds, process/status/health/network/service/browser/native actions, package/source edits, staging/commits or subagents were used. Repository review records and anchors remain root-owned under the requested read-only scope.
