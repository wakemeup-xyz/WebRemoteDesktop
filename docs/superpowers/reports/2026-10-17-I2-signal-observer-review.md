# I2 signal observer independent review

Date: 2026-10-17 (Asia/Shanghai).
Verdict: **CHANGES REQUESTED** — 0 Critical, 2 Important, 0 Minor findings.

## Findings

### Important / P2 — Startup-summary failure can still end in PASS

Locations: `scripts/passive_session_soak.py:125–143`, `scripts/passive_session_soak.py:846–853`; coverage gap at `scripts/test_passive_session_soak.py:641–651`.

On the normal post-media startup path, `startup_summary()` catches an evaluate exception or timeout and returns the fixed fallback dictionary. The caller stores that dictionary without recording a failure or keeping `interrupted` true. If subsequent samples and cleanup succeed, line 853 clears `interrupted` and the final result can be PASS. Thus a startup-summary failure is neither preserved as a stage outcome nor prevented from passing, contrary to the brief's explicit startup-summary exception/timeout requirement.

The existing error-loop test uses `Rig(disconnected=True)` by default. Its startup-summary case becomes INCOMPLETE because the next sample disconnects, so it does not establish that the startup-summary error itself is handled correctly. This is a static, deterministic path finding; no test was rerun.

Requested narrow fix: return or propagate a fixed startup-summary failure status, preserve it as the first failure on the normal path, and route through the existing finalizer. Keep cleanup-time startup-summary collection best-effort when an earlier failure already exists. Add actual-run fake cases with `disconnected=False` for startup-summary error and cooperative timeout; assert INCOMPLETE, the fixed original stage/reason, both artifacts, and unchanged single-proof/single-Start counts.

### Important / P2 — Failed initial evidence writes do not prevent connection startup

Locations: `scripts/passive_session_soak.py:706–724`, `scripts/passive_session_soak.py:814–820`.

`persist(initial=True)` catches an `OSError`/`ValueError`, sets `write_status='error'` and calls `fail()`, but it reports no failure to its caller. `run()` then unconditionally constructs and starts the manager and proceeds toward UI authentication/proof/Start. For example, failure to create either initial artifact leaves that file absent (or a failed initial direct write may leave it partial), yet the guarded session is still established. The final status cannot become PASS, but the required two committed initial evidence files do not actually precede manager startup in this path. A persistent storage failure can therefore produce the very acceptance run without durable failure evidence that the outer-finalizer design was intended to prevent.

Requested narrow fix: make initial persistence return success or raise a fixed local error after attempting both artifacts; abort before manager construction if either initial commit failed, while retaining the existing outer finalization attempts and first `evidence-write-failed` cause. Add an actual-run fake with an initial write failure for each filename, asserting that no manager factory/start, login, proof or Start occurs and that any successfully committed artifact is retained. No process-management change is needed.

## Reviewed scope and evidence

- Frozen package: `review-1772a51..1e34602.diff`, base `1772a5156078aa1f80a466c4bc28970fcd0f3883`; implementation `10d4146b274f6ac761fafa413b44eebf643ff282`, report `1e34602`.
- Reviewed I2's four scripts and its report against `task-I2-signal-observer-brief.md`, including the finalizer, observer schema, new VM/fake-run tests and unchanged admission/continuity path. The unrelated M6 tooltip commit `966890b` in the combined package was excluded.
- Existing reported evidence: JavaScript 20 passed; Python 39 passed; py_compile and diff-check passed. These are implementation evidence, not reviewer reruns. No tests, runtime/network/native/browser/service/tunnel operations, builds or dependency changes were performed during this review.
- Only this review report was written. Existing dirty files, source, index and primary checkout were not changed.

## Positive checks and limits

The observer retains a compact, bounded ring and a separate first terminal record; fixed reasons and run-local labels avoid payloads, error messages and real transport IDs. Product-first object replacement preserves an enrolled terminal event with `c=false`. Exact own listener removal, one scheduler and arithmetic lag accounting remain isolated from product connection behavior. Python validates observer fields and byte budgets, and the sample reserve accounts for both final artifacts.

The outer evidence owner covers manager construction/start, launch and teardown; pre-close export precedes browser close, preliminary artifacts precede close, and final attempts follow teardown. Original sampling failure is retained across later cleanup failures. The single proof/Start and first disconnected-sample/identity-change termination remain intact; no business input or recovery qualification was added.

The report correctly limits cleanup evidence to cooperative API behavior and leaves owned-process exit `not-observed`. This review does not require or infer a hard real-process termination guarantee, and requests no worker/process supervisor. Partial attachment coverage and unknown initiating cause remain explicit. After the two harness defects are corrected and narrowly verified/reviewed, a separately authorized passive first-close diagnosis can proceed; no runtime diagnosis or durable-usability qualification was performed here.

## R1 scoped re-review — APPROVED

Date: 2026-10-17 (Asia/Shanghai). This R1 verdict supersedes the initial changes-requested verdict for the two findings above. **Both Important findings are closed; 0 Critical / 0 Important / 0 Minor remain in this scoped re-review.**

Reviewed frozen package `review-70789fa..ebb7525.diff`, correction commit `0f0e902612a692fdae06487453b0fd1c8e9085b2`, report commit `ebb7525feda045caeb41f3eb20e630a88ec46c90`, and the corresponding current lines. Scope was only the two prior Important findings, their regressions and the updated implementation report.

1. **Startup-summary failure: closed.** `scripts/passive_session_soak.py:142–147` now propagates fixed unavailable/deadline reasons when required. The normal path sets the allowlisted `startup-summary` stage and calls `required=True` at lines 855–856, so an error exits before sampling and cannot reach the success assignment. Cleanup collection retains the default best-effort behavior and cannot replace the first cause. The actual-run test at `scripts/test_passive_session_soak.py:772–790` uses a healthy connected fake with no terminal event, covers exception and cooperative timeout, and checks INCOMPLETE, exact first cause, zero collected samples, both artifacts, one proof/Start and no surviving fake tasks.
2. **Initial write gate: closed.** `scripts/passive_session_soak.py:724–732` attempts both files and returns their combined commit outcome. Lines 824–827 raise the fixed failure before manager construction if either commit fails, with the existing outer finalizer still active. The per-filename actual-run test at `scripts/test_passive_session_soak.py:792–827` verifies no factory/start/login/proof/Start, both initial attempts, the valid retained companion artifact and the original write-failure cause.

The report records RED reproduction of all four relevant subcases and GREEN for five focused test methods covering the fixes plus adjacent success, cleanup and final-write preservation. It also records passing py_compile and diff-check. These existing results were assessed with the code; no tests were rerun, and the earlier broad-suite evidence remains explicitly pre-R1. No source/index/product/runtime/browser/native/network/service/tunnel/dependency/build changes were made by this reviewer; only this report was appended.

The I2 implementation review gate is clear for the separately authorized acceptance-script deployment and passive first-signal-close capture. This approval does not establish a runtime cause, durable-session qualification or hard process-exit guarantee. The previous partial-observation, cooperative-cleanup and `ownedProcessExitEvidence=not-observed` limits remain unchanged.
