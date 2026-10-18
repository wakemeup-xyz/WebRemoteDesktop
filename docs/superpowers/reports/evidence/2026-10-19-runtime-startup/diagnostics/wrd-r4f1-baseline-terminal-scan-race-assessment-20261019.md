# R4F1 baseline terminal scan race: bounded read-only assessment

Status: ASSESSMENT ONLY. No derivative implemented; no pure tests or operational methods run in this assessment. Pacing integration preparation is paused. No new qualification, diagnostic, receipt, decision, nonce, process lookup, Git command, network call, browser, sample, build, copy, restart, service change, source/index write, or old-package/record edit occurred. Only necessary bounded existing JSON/code files were read; no samples.jsonl or large logs were rescanned. This new report is private mode 0600. The previously completed pacing eligibility report remains unchanged; its actual interface integration remains NOT_CLOSED and pacing remains NOT ELIGIBLE.

## Actual outcome and evidence boundary

The fourth actual qualification result is immutable failed-or-indeterminate, SHA256 5ebf46ff9919847f0be320f7f55df255928b6e4b8c9b22c0f9059364909f0dfd. Worker exit is 0, registration succeeded, timeout false, execution/cleanup errors absent. Rows and worker stages passed; coverage failed. Signals, diagnostics, source-pins, manifest, runtime-integrity, sticky-observation and terminal-evidence stages were not evaluated. Qualification and finalRuntimeIntegrity are null. CurrentReadiness.health is null with RuntimeError. Therefore neither worker success nor the summary's PASS proves overall qualification or current idle readiness. Do not reuse this baseline for pacing or advance this sequence.

The worker summary separately reports 300.40683215111494 seconds, 301 continuity samples, zero missing/late/failed/identity-change observations, maxObservedNoProgressMs 533.3119999999981, stable Host observation with 312 samples, and no summary failure. This is a bounded producer report read, not a new validation of all 312 rows. Six input/effect metrics remain unmeasured/NOT_RUN; passive frame progress is not active-control, physical-display, ACK, queue/execution or visible-input-effect acceptance. sampleTriggered=false and no sample identities are recorded.

The only worker diagnostic event is eventId 1, scanId 457, worker-loop / scan / children / PID 36482 / NoSuchProcess, monotonic 1501423.362168074, wall 1792348969.156626. The event has birth=null. Its directly associated gap is observation-unavailable, monotonic 1501423.362258186, wall 1792348969.156712. There are no drops/overflows and diagnostic failed=false. The seven registered identities eventually report exited, no signals, completeProcessTreeExitEstablished=false. Thus this is a localized children-enumeration coverage failure, not a registration failure or evidence of a still-running known child.

PID 36482's stored birth is 1792348652.844396, registered parent PID 36476 / birth 1792348650.059264. LastObservedEpoch is 1792348968.989262, about 0.167364 seconds before the exception. This value is last successful registration/discovery bookkeeping, not a timestamped terminal-state proof. BrowserClose reports monotonic milliseconds 1501423219–1501423335 with status closed; managerStop 1501423335–1501423364 status ok. The exception is about 27 ms after reported browserClose completion and within managerStop. Millisecond lifecycle clocks and separate observation calls do not establish precise kernel exit ordering.

These facts are consistent with a normal shutdown race between the scan's initial alive check and children enumeration. They do not uniquely establish it: there is no immediate post-exception identity proof, error.pid was not retained, and no evidence establishes the last missing children list. Do not retrospectively classify the failure as harmless or overwrite it.

## Exact static mechanism

Original immutable supervisor.py Registry.scan iterates registered PIDs, calls state(pid), and skips non-alive entries. For an alive entry it separately resolves process(pid).children(recursive=False). The surrounding catch also covers child.create_time, child.ppid, later state checks and _add; any NoSuchProcess / AccessDenied / OSError becomes note('observation-unavailable'). Coverage is a deduplicated reason list. Later state(pid) may return exited but never removes the earlier reason. result() requires every registered state exactly exited; reused does not satisfy allRecordedIdentitiesExited.

Module35 Diagnostics and instrument_registry preserve these decisions, exception propagation and process calls. The children proxy records the requested parent PID, but its new proxy has not called create_time, explaining birth=null without proving identity was absent. The direct-scan-error token distinguishes this children error from unrelated state errors. State-context NoSuchProcess increments expected counters instead of events; state AccessDenied/OSError may return unknown without automatically adding a coverage reason. Existing behavior must not be described as a universal unknown-error veto.

ordinary-continuation-supervisor validates raw Registry coverage before all later acceptance stages. bindings.validate_owned_coverage rejects any reason beyond unchanged INHERENT. Adding observation-unavailable to INHERENT or treating all eventual-exited trees as successful would discard materially different failures and is not acceptable.

## Recommended prospective change and explicit epistemic cost

A fresh private ordinary-worker-only adapter may record an immediate bounded terminal-race proof for the exact registered parent whose direct children(recursive=False) call raised the injected psutil.NoSuchProcess. Preserve the original exception object, Registry scan/note/cleanup/signal decisions, raw coverage, module35 events/gaps and original SUP bytes. Do not change helper/build/sample acceptance. No service signals or extra child/process enumeration.

A suitable minimal interface is an outer read proxy plus a separate proof recorder and a strict qualification consumer. The proxy delegates each original requested operation exactly once. Immediately before the actual children call, it snapshots only the already-held registry entry's exact PID, birth, registered parent and scan association (no extra lookup). On that call's NoSuchProcess only, it may perform one finite exact-PID identity observation before immediately rethrowing the same exception. The unchanged Registry then records its original gap. The recorder must not swallow an error or synthesize an empty children list.

Proposed proof fields: version/scope/role; unique bounded proof ID; exact scan/event/gap IDs; operation='children', recursive=false; captured registered PID/birth/parent; safe error PID (require it to match the requested PID, otherwise no admissible proof); exception class; monotonic/wall start/end; post-observation operation/outcome/birth/status; unchanged-entry check; and disposition. No argv, environment, command line, raw error message or discovery. Capture raw safe exception identity in this future adapter because the old diagnostic event alone cannot establish it. If supported backend semantics cannot supply a matching error PID, fail closed rather than infer it.

Post-observation uses only that known PID: resolution NoSuchProcess may prove old identity gone; a matching stable birth/status zombie may prove it terminal; a stable different birth proves old identity reused. Read birth/status/birth for present processes and reject inconsistent reads, malformed values, clock reversal, unknown status, AccessDenied/OSError or unsupported errors. The original Registry.state may help categorize, but a bare 'exited' string is insufficient to retain operation/birth/timing detail. No wait, second retry or extra deadline; perform at most one proof attempt per direct error, maximum 32 total records, within the existing worker and cleanup bounds. The finite call count is not a hard kernel-call latency guarantee. Capacity/clock/schema/attribution failure remains sticky rejection. Do not classify scan resolve/create_time/ppid, unregistered child errors, nonmatching exceptions, another PID's error, or arbitrary terminal results under this exception.

The proof must be associated one-to-one with the actual module35 event and resulting gap, not merely the latest record. Snapshot/validate diagnostics before acceptance; zero dropped events/gaps, no overflow/diagnostic failure, every observation-unavailable gap accounted for, no orphan/duplicate proof, and no other unexpected coverage. Preserve raw ownership.coverage and observedUnexpectedCoverage; add a separately named bounded terminalRaceEvidence/coverageAssessment with exact checked IDs. Do not delete raw reasons or present raw coverage as clean. A new qualification consumer can allow only explicitly proven cases while preserving all other gates, especially allRecordedIdentitiesExited and no signals. A reused proof by itself therefore cannot produce PASS under the old all-exited rule; it is useful evidence only. Root must explicitly approve any further reused-state acceptance, which is outside this recommendation.

Crucial limitation: proof that the parent exited does NOT prove it had no undiscovered live child before exiting. A child can be spawned/reparented in the same polling gap. The original INHERENT already admits polling may miss fast orphans, and completeProcessTreeExitEstablished must remain false/fullProcessTreeExit unknown, but accepting this newly proven case is a narrow prospective policy change, not logically equivalent proof of complete coverage. If root requires proof no orphan was missed, this minimal approach cannot supply it; stronger OS ownership/job instrumentation would be a different scope. No historical result, including this fourth failure or the prior reload failure, qualifies for the new rule.

## Fresh continuation on the already loaded deployment

No source copy/build/reload is needed for a private supervisor acceptance adapter. Keep source 41c7b0998859a7e9d088cefcc0f3a1eeab190684, Viewer fefc555aea9640b563bfd22f5b36b6b8ca6365ec, tools 2822441791b59a021556c7e4eb24715df9d5b277, backend dfb15434e79da90b803b763c533836e16c080c71 and diagnostics35 unchanged. Existing deployment readiness1064eeaa... remains a historical loaded-context anchor, not fresh idle evidence. The original reload ff6ff0... remains failed; its existing narrow readiness reconciliation is not extended to qualification.

Do not clone the package and globally replace FAILURES: old frozen manifests, source review, deployed package manifest, historical quiescence, readiness and reload consumer explicitly bind the original three-failure history and old package root. Such replacement invalidates truthful deployed lineage. Prefer a small new continuation layer that verifies/pins the sealed R4F1 payload and invokes its unchanged read-only deployed-context validators under their original package root/constants; independently bind a NEW history/sequence with fourth failure and reload-helper closure. Its new files live under a new private root, while it consumes old deployment records only as immutable evidence. Do not call old freeze/apply/reload entrypoints or recreate any old markers.

New history must bind exact fourth sequence/attempt/runtime/marker/result SHA chain, original three failures, and reload started/result/readiness references. Derive 21 historical attempt identities + 7 new attempt identities + 6 helper identities = expected 34 distinct PID/birth pairs (validate exact union/duplicates against full pinned history when preparing). Keep registry provenance labels, not PID alone. Service identities are separate protected liveness checks, not quiescence targets. The six helper records do not grant authority over unrecorded launchctl-managed services. Require a fresh no-active-known-attempt observation of the exact union; gone/zombie/stable nonmatching birth acceptable only for old-identity quiescence, alive-matching/unknown rejects. Retain 60-second/no-clock-reversal TTL and immediate same-known-list check at admission. No ambient discovery, signals, PID reclaim or full-tree assertion.

Use a new root-approved sequence ID, attempt ID and runNonce, rejecting every prior sequence/attempt/nonce including ff601377..., f6e5f8e7..., 0acf96f1.... A new baseline starts from scratch; its previousResult is null and its immediate prior failure is 5ebf46ff..., with all four failures retained. Separate root decisions and fresh strict idle preflight remain mandatory for each baseline300 / within390 / after390 / continuity10800 case. Source/assets/1016 known-map bytes/modes/HEAD/index/component/service/preserved/tunnel/watch/quick-file gates and original deadlines remain unchanged. No automatic next case, retry, old-sequence continuation or pacing qualification inferred.

## Required independent verification before implementation use

Future pure tests should execute the actual unchanged Registry AST with injected process/clock and actual module35, plus the new minimal adapter and consumer: direct registered-parent children NoSuch + immediate gone/zombie; reused remains rejected by final all-exited; alive/unknown/double-birth-change; mismatched/missing error PID; unregistered and child-method failures; scan resolve/create_time/ppid errors; AccessDenied/OSError/unsupported; absent/duplicate/stale/misassociated proofs; multiple gaps with only one proof; caps/overflow/clock reversal; diagnostics failed; raw coverage retained; no extra enumeration/signals and identical rethrow; normal path call parity; unchanged cleanup/deadlines. History tests must cover exact34 union, all four closed histories, six helper identities, rejected old IDs, missing/unclosed records and fresh idle admission. No tests have been run for this assessment and no implementation authority is inferred.

The practical next decision is whether root accepts that explicit narrow residual polling uncertainty. After an implementation dispatch, a fresh private package plus independent review is needed before any new real sequence. This report alone authorizes nothing operational.

## Recorded identities newly relevant to continuation

These are historical records only, not a current process observation.

| Origin | PID | Birth epoch | Recorded final state |
|---|---:|---:|---|
| fourth attempt | 36474 | 1792348649.06148 | exited |
| fourth attempt | 36475 | 1792348649.381747 | exited |
| fourth attempt | 36476 | 1792348650.059264 | exited |
| fourth attempt | 36477 | 1792348650.247472 | exited |
| fourth attempt | 36478 | 1792348650.253278 | exited |
| fourth attempt | 36479 | 1792348650.309118 | exited |
| fourth attempt | 36482 | 1792348652.844396 | exited |
| reload helper | 33161 | 1792348309.54818 | exited |
| reload helper | 33163 | 1792348309.916294 | exited |
| reload helper | 33165 | 1792348310.1486 | exited |
| reload helper | 33169 | 1792348310.517254 | exited |
| reload helper | 33183 | 1792348311.820681 | exited |
| reload helper | 33311 | 1792348322.363265 | exited |

## Bounded evidence references

- `/tmp/wrd-owned-turn-probe-private/supervisor.py`
  SHA256 `d03cc2025f41d26c0079d3f820fdb2cd5479ae14448fb1c6f91c4589d6bd5c7b` (18141 bytes).
- `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm/process_observation_diagnostics.py`
  SHA256 `00bd2366d770b9e65b272acadf54027c77cde48050b12106a2fd79338059f82b` (14504 bytes).
- `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm/ordinary-continuation-supervisor.py`
  SHA256 `b485f982befac8e284861af24e6684b006850b67c43847219a5503ec234308df` (13626 bytes).
- `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm/bindings.py`
  SHA256 `01d0891a4122ae797c2ec2192e358d8d52206e138bf4ba85e8ea5c47153bff70` (13567 bytes).
- `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm/continuation_common.py`
  SHA256 `d0fe02e028f6c5ba3b27f67628639f99d7c4d835f8eaeaf7ed569bf36870c897` (13902 bytes).
- `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm/known_attempt_quiescence.py`
  SHA256 `a64687c3a220a8b995e86c44296ccee19923663c64e4e23d8e0a6fbdbd6e38e0` (10667 bytes).
- `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm/sequence-ff601377b608c2c4b1b51e55123e2f20/attempts/f6e5f8e72e4195767164f168bcbe3550/qualification-result.json`
  SHA256 `5ebf46ff9919847f0be320f7f55df255928b6e4b8c9b22c0f9059364909f0dfd` (7662 bytes).
- `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm/sequence-ff601377b608c2c4b1b51e55123e2f20/attempts/f6e5f8e72e4195767164f168bcbe3550/qualification-started.json`
  SHA256 `61a1875a020f325d4609509a7f9570e740ee3c825af702efad4b20ecafdd1f5e` (1172 bytes).
- `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm/sequence-ff601377b608c2c4b1b51e55123e2f20/attempts/f6e5f8e72e4195767164f168bcbe3550/ordinary-baseline-3eire5u_/session/summary.json`
  SHA256 `5898c37279fb3105301d53ab6b3426016055450605fd16c37bb266bf1e246e4d` (2361 bytes).
- `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm/sequence-ff601377b608c2c4b1b51e55123e2f20/attempts/f6e5f8e72e4195767164f168bcbe3550/ordinary-baseline-3eire5u_/session/lifecycle.json`
  SHA256 `b5e38c4708772a2f1381b36941670d1249c181ec66c564c9de4e8f0f50ab77d0` (8412 bytes).
- `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm/deployment-1a71096791fb71844ae08c95c50fb9cc/reload-result.json`
  SHA256 `ff6ff0b8b356c1f889dea3e0b1d39d68c527678066390711c4f28f41907b410f` (8470 bytes).
- `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm/deployment-1a71096791fb71844ae08c95c50fb9cc/readiness-result.json`
  SHA256 `1064eeaa41ac546ad9bd22d3ee05f5042be75f2423edda82f3f0137f0e60a74c` (5337 bytes).
