# Task 4 fix-round 1 review — b6570f7..55e006d

## Spec compliance

- ✅ **I1 ADDRESSED.** `scripts/ordinary_session_recovery.py:1238–1244` validates the final no-fault sample through a copy of the existing qualified ContinuitySummary. It therefore retains historical identity/path/counter comparisons instead of accepting an independent one-sample probe. The check uses the existing qualified elapsed duration and does not mutate the original reducer's sample count, timing or baselines. Existing first-failure guards and final owner/build/Host/log/current-gate checks remain in place.
- ✅ **Authorized finite-seconds correction is compliant.** `scripts/ordinary_session_recovery.py:1110` initializes the validation template with elapsed_s=0.0, so legitimate floating elapsedSeconds is accepted while integer counters remain integer-only. This implements the existing contract without adding output fields or weakening counter checks.
- ✅ No new correctness or ownership breakage found in this scoped delta. The shallow copy is sufficient for the unchanged reducer reviewed in round 0: its observed identity is an immutable tuple and its updated history/counters are scalar attributes, with no shared mutable collection modified by observe().
- ⚠️ The earlier root-owned browser/parent-consumer integration, Task 5 adapter, deployment and real qualification limitations remain unchanged. This re-review does not reopen or resolve them.

## Strengths

- `scripts/test_ordinary_session_recovery.py:1294–1353` exercises the actual full runner/reducer/final-export path with every baseline observation, an unchanged success control, and final-only lease/path/counter/PC/attempt/generation mutations. It checks exit status, unchanged qualified duration/count, first failure, one Start and cleanup rather than preloading PASS state.
- `scripts/test_ordinary_session_recovery.py:1355–1361` separately checks fractional elapsedSeconds acceptance and fractional integer-counter rejection.
- The appended report distinguishes the initial masking finite-seconds RED, the integer-clock isolation, and the floating-clock I1 RED after only the approved template correction. It does not misrepresent the first failure as directly demonstrating I1.

## Issues

### Critical

None.

### Important

None. Original I1 is addressed.

### Minor

**M1 — Final test output contains a slow-task diagnostic.** `scripts/test_ordinary_session_recovery.py:1333`; `.superpowers/sdd/2026-10-18-guarded-ordinary-recovery-plan/task-4-r1-final-green.log:1`.

The retained final log reports one asyncio debug step taking 0.104 seconds. This is test-output noise and is not pristine output; it does not demonstrate a runner deadline or observation failure, and all tests pass. The report accurately discloses it. Preserve this evidence; if the fixture is optimized later, reduce synchronous fixture work without suppressing asyncio diagnostics. No rerun merely to obtain quieter output is warranted for this review.

## Assessment

**Spec compliance:** Approved for this scoped fix.

**Task quality:** Approved with the Minor test-output observation above.

## Checks and boundaries

- Read the 11304-byte canonical package `review-b6570f7..55e006d.diff`, the appended fix-round 1 report and the original I1 review context.
- Read the final log: 134 tests, 24.630 seconds, OK, with the single disclosed 0.104-second diagnostic; report records exit 0. Read the post-template-only RED tail: 2 tests, 8.937 seconds, six final-only failures (`0 != 1`).
- No tests rerun, no broadened source inspection, no source/index/git mutations, optional runtime imports, browser/network/service/status/build operations or subagents. Only this requested private re-review report was written.
