# R5 actual baseline cleanup failure — read-only assessment

**Finding [P1]: the ordinary runner removes protocol-backed admission listeners after stopping Playwright.** This is a real tool teardown-order defect at `scripts/ordinary_session_recovery.py:1367`–`:1377`, and the fixed run evidence strongly supports it as this attempt's cleanup failure. The exact caught runtime exception was not persisted, so its precise type/message is not proved by the artifact. This is not evidence of a Viewer/media failure, nor proof of full process-tree exit.

## Fixed attempt and observed outcome

Attempt directory: `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-frontend-move-context-operations-private-r5-wive_sjb/sequence-93750d2ec1ca42f35e838a96e58c6708/attempts/ba047879c33f00f14b603780026ba53a`.

Session: `ordinary-baseline-osu_l091/session`. Source identity is c802a68362459b46b84593c7e8921575e0783394, tool identity59bca14209eed299b0e94da58decb8b85e5ce70c, Viewer build bb581651b422e400. No source was changed or executed by this assessment.

The retained result is correctly failed-or-indeterminate: workerExitCode=1, timedOut=false, outer cleanupErrorClasses empty, first failed validation stage=worker. Later stages, including terminal evidence/runtime integrity, were not evaluated. It must not be promoted to a completed baseline from the healthy sampling portion.

The314 fixed rows comprise13 startup and301 baseline rows. Summary reports300.27650961698964 qualified elapsed seconds,301 continuity samples, zero missing/late/failed/identity-change observations, maximum observed no-progress183.30000000001746ms and progressAfterBaseline=true. The last preclose row still has connected PC, inputAllowed=true, complete stable Host observation and current callbacks. captureStatus and writeStatus are both ok. These are bounded passive observations; they do not establish business input or visible/physical effect.

Lifecycle ordering is particularly diagnostic:

| Evidence | startedMs | finishedMs | status |
| --- | ---: | ---: | --- |
| browserClose |1489494298 |1489494340 |closed |
| managerStop |1489494340 |1489494353 |ok |
| first failureDetectedMs |1489494354 |— |cleanup-incomplete |

The first failure is recorded1ms after managerStop finished. Browser close took42ms and manager stop13ms. This is inconsistent with blaming their configured5s/3s timeouts or the total8s cleanup cap. The final export succeeded (`captureStatus=ok`). `ownedProcessExitEvidence=not-observed` is the intended API-only lifecycle contract, not by itself a failure.

## Concrete source and installed-library path

1. `OwnedBrowserLifecycle.cleanup` (`ordinary_session_recovery.py:624`–`:657`) performs final export, browser.close and manager stop in that order, then sets api-finished-exit-unknown if these succeeded. With a real page, capture ok and both tracked close/stop statuses successful, the normal cleanup body has no remaining failure-producing step after stop.
2. The outer `run` finally starts and awaits that coordinator (`:1367`–`:1374`), then calls `guard.detach()` (`:1375`–`:1377`). detach at`:955`–`:956` calls Page.remove_listener for request and response. This occurs after Playwright has been stopped.
3. Installed async Playwright `_impl/_async_base.py:88`–`:90` forwards remove_listener to the implementation. `_impl/_connection.py:214`–`:217` removes the handler, then calls `_update_subscription(event,False)` when it was the last listener. Page request and response are mapped subscription events (`_impl/_page.py:262`–`:268`). This is not a purely local list operation.
4. `_update_subscription` (`_connection.py:197`–`:207`) uses the channel's send_no_reply (`:89`–`:107`), which calls `_send_message_to_server`. Playwright stop_async calls cleanup (`:322`–`:325`); cleanup assigns `_closed_error=TargetClosedError` (`:327`–`:328`). `_send_message_to_server` checks and raises that closed error before sending (`:354`–`:358`). The async manager context exit actually awaits this stop_async (`async_api/_context_manager.py:53`–`:57`).
5. The runner catches any Exception from detach and overwrites lifecycle cleanupStatus with incomplete, emitting only generic cleanup-incomplete (`ordinary_session_recovery.py:1377`). `OrdinaryRecoverySummary.result` preserves that as failure and interrupts continuity (`:828`–`:841`); the runner returns1 (`:1397`–`:1399`). This exactly explains how successful final capture/close/stop can coexist with cleanup-incomplete.

Given the installed code, the expected static failure is a closed-connection TargetClosedError, possibly rewritten by wrap_api_call_sync. It is not justified to assert the specific message "Event loop is closed" from these artifacts. No original exception class, traceback or listenerDetach stage was saved; the supervisor intentionally launches the worker with stdout/stderr discarded. I did not reproduce the exception or import Playwright. The ordering bug is established statically; assignment of this exact runtime failure to that path remains a strong source/evidence inference rather than a retained exception trace.

## Minimal correction and verification recommendation

Make a new narrowly reviewed tool increment, preserving the failed attempt and existing frozen packages:

- Move admission listener detachment into the same existing cleanup coordinator, **after final export and before browser.close/Playwright stop**. Preserve monitoring through the final observation and its checks. Execute detachment even when export fails, then independently attempt browser close and manager stop under the existing one-coordinator/total8s budget. Remove the post-stop detach call. A narrow preclose callback/owned cleanup hook is preferable to swallowing stopped-connection exceptions.
- Keep real detachment failures as cleanup failures. Do not lower the terminal validator, treat not-observed as exited, replace incomplete with success after the fact, or grant the failed run qualification credit.
- Preserve a bounded cleanup stage/reason or exception-class field for listener detachment/coordinator failure if diagnostics are extended. Do not persist raw Playwright error strings, URLs, arguments, request bodies or credentials. Existing generic catch at`:1377` is why the exact runtime cause cannot now be proved.

Meaningful regression validation should use the actual runner finalization path with the existing fake clock/manager/page facilities. Current FakePage.remove_listener (`scripts/test_ordinary_session_recovery.py:827`–`:828`) only removes a Python list item and continues to work after fake stop, so existing successful baseline tests omit this real lifecycle constraint. Introduce a strict fake subscription connection that raises on listener updates after stop and records ordering. Establish RED with the current production runner, then GREEN proving final-export→request/response-detach→browser-close→manager-stop and successful api-finished-exit-unknown while ownedProcessExitEvidence remains not-observed. Also verify detach failure, final-export failure and repeated cancellation still independently close/stop once, retain the first failure and original deadlines, and leave no unowned task. Reuse the existing full fake300-second baseline flow rather than injecting PASS or shortening the contract. Then run the affected tool/strict-consumer tests once; any schema diagnostic addition requires its consumer/fixture updates. No such tests were run here.

After independent review and new exact tool/source/package pins, a new actual baseline must start from zero with new records and fresh admission. Do not reuse this attempt's marker, rows or time as qualification. This recommendation does not authorize implementation, redeployment or a run by this reviewer.

## Separate evidence boundaries

The outer Registry records seven known identities exited with zero signals and only its inherent polling/check-to-signal/no-CDP gaps. That is useful recorded-child coverage. completeProcessTreeExitEstablished remains false and fullProcessTreeExit unknown; it neither substitutes for the worker's cleanup API contract nor establishes that every possible descendant exited. The failing outer worker stage prevented later coverage/signals stages from being evaluated as formal qualification gates, even though their recorded raw values are available.

Historical currentReadiness.health=null/errors.health=RuntimeError is a separate final observation. R5 core.health uses require_idle=true by default and collapses several possible causes into RuntimeError: curl/read/parse problems, online/healthy checks or nonzero occupancy. The result does not preserve the route bodies or exact reason, so it cannot establish Host offline, non-idle occupancy or an HTTP failure specifically. It is recorded after the worker failure and does not cause the worker's earlier cleanup-incomplete. Root is separately assessing present health; I performed no health/status/network/process observation. A present healthy observation would not retroactively clear this failed attempt.

Native/business/visible/physical evidence remains NOT_RUN. The pacing diagnostic remains gated on a future successful uninstrumented baseline; this failed attempt cannot satisfy it.

## Evidence hashes and review scope

- qualification-result.json: `5ef3358f1a1ee0bb5ef72e816952c5874d0826c8795c67616ba0a85ff73a42b9`
- session/summary.json: `14d35f6191e252e13b6270bd8dd6af73109682c7673b92b16f413396fdb61fe5`
- session/lifecycle.json: `15cbcb1ac9b694cf82598f3fc17248a5ea712d195b296e8f8734d5fe0fb41621`
- session/samples.jsonl: `f879a98fa679a125fd8fbd3e3be6875d11ead9dc25af933cc415f6e06113ca73`

Read-only fixed evidence parsing and source/library inspection only. No operational imports, tests, builds, current logs, process/status/health/network/browser/native/service actions, source/package edits or subagents. Only this assessment file was written. An older R6 baseline-command record discovered during filename search was excluded because it is not this R5 attempt.
