# Capture pacing v2 — independent fix-round1 review

**Findings: none in the scoped fix delta. Verdict: Approved for Findings1+2 closure. Finding1: ADDRESSED. Finding2: ADDRESSED.** This is static package review, not execution approval or R4 integration approval.

## Finding1 — ADDRESSED

`run-experiment.py:131` fixes the original428-second deadline before Popen at`:132`, before process observation or Registry registration. The exact returned Popen is passed to the new `register_worker` at`:133`.

`register_worker` (`run-experiment.py:81`–`:94`) retains the registration exception class and polls only that created Popen when registration fails. It observes either exit or the same deadline, using sleeps no longer than250ms or the remaining budget. It performs no process discovery, replacement selection, ownership inference, signal, registration retry or deadline extension. Both exit and unresolved-at-deadline outcomes are explicit. The main path records unresolvedChild as timedOut and always retains worker-registration-failed when registration failed (`:134`); later exit or final health cannot convert it to success. Original Registry cleanup authority and budgets remain unchanged.

The added tests AST-execute the actual main creation block with fake Popen, Registry, process factory and clock/sleep. They establish successful creation followed by failing add_root, then eventual exit and still-live-at-original-deadline paths. Static review also confirms that the original failure path remains latched through finalization and result persistence. The fix satisfies the requested lifecycle correction without signalling unknown PIDs.

## Finding2 — ADDRESSED

`pacing.py:79`–`:82` counts newer validated intervals independently of usable10–60-second observations and excess threshold. A usable interval retains the existing fresh event/Viewer, completion-age and stable-window checks. A fresh below100ms interval therefore establishes observation coverage without consuming the sample token.

`coverage_failure` (`pacing.py:84`–`:88`) distinguishes no seed, no strictly newer interval, and no usable eligible-window observation. Finalization applies it only when an earlier diagnostic failure is absent (`run-experiment.py:195`), preserving prior errors. The unchanged classification expression consequently returns INCONCLUSIVE for missing coverage, while adequate below-threshold coverage can yield NOT_TRIGGERED. Result hostCoverage separately records counts and missing reason (`:196`). No interval is inferred, no threshold/log budget changes, and no additional sample is allowed.

Tests cover zero events, seed-only, stale Host, stale Viewer, outside usable window and fresh newer99ms observations. The amended tests AST-execute the actual final coverage assignment and classification expression, asserting INCONCLUSIVE versus NOT_TRIGGERED.

## New breakage review

No actionable new regression was found in the four-file executable/contract delta. The sample command, original SUP ownership/timeout/resource limits, qualification consumer and input gates are unchanged. The new result fields contain bounded status/count/error-class data. Diagnostic-only kind, qualificationCreditSeconds=0, unknown native capture TID, unestablished GIL/kernel attribution, no automatic second sampling and NOT_RUN input/visible metrics remain intact. CONTRACT.md matches the fixes.

## Exact artifacts and retained evidence

Package: `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-capture-pacing-private-v2-fgbxntxg`.

- Verified manifest SHA-256: `fd58e215e2218e2b33a04932c14ed16f36001e191882280040431766a86283a1`; all16 manifested files match and are0600.
- Verified handback SHA-256: `ae96cad73df404078879ae167a775d9c87aad741a3fa7d10f7a4bdbee38cc583`.
- Verified focused diff SHA-256: `1ecd2816996332d5d5d5f0ec302e7a73a9046627323ca3ae21058c31d86eface`. It matches the actual v1→v2 changes to pacing.py, run-experiment.py, test_pacing.py and CONTRACT.md exactly.
- Rehashed frozen v1: all11 manifested files and its manifest remain unchanged (`c5851cd99cd2d348590a4fa278c1141cb5d0cbcbd1a2d8874f214594cc160b27`).
- Actual behavioral RED log contains two worker failures: fake time remains100 immediately after creation/registration failure, demonstrating absent supervision in v1. The four coverage cases were missing-method errors, not claimed as behavioral classification failures. The separate initial six-interface-error RED log remains historical evidence.
- Retained focused GREEN: **6/6 PASS,0.027s**, SHA `9cf62c75f2b0e3d8533d496cd2e3304fd4ae9908f870a48f7dbf9afdaf29fd38`.
- Retained amended full GREEN: **23/23 PASS,0.191s**, SHA `91c2ba95e92bfca879c1a6e1d78c1c670886913bd7f86a83d861f8d765257fd0`. I checked its contents and hash; no tests were rerun.

## Scope and remaining gate

Read only the requested v2 report, actual diff, relevant corrected code/tests and retained logs, plus hashes for artifact integrity. No driver entrypoint or tests were imported/executed; no runtime/process/status/network/browser/native/build/service/source operation occurred. The only write is this report. Source/product/R4 were not re-reviewed or changed.

Whole-driver/native IO execution and low-level PID-file IO remain unexecuted limitations. Actual approved final R4 definition/interface compatibility, exact deployment/component/build pins, a fresh successful uninstrumented baseline, and new root decision/runtime/execution-review records remain separate pending pre-execution gates. This review neither assumes those exist nor authorizes execution. Core deployment status is independent of this diagnostic-tool fix review.
