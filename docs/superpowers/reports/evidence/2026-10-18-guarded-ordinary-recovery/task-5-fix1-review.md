# Task 5 fix round 1 review

## Spec compliance

- ✅ **P2 ADDRESSED; Task 5 spec gate approved.** The root ruling is consistently recorded in `docs/superpowers/specs/2026-10-18-guarded-ordinary-recovery-design.md:169` and `docs/superpowers/plans/2026-10-18-guarded-ordinary-recovery-plan.md:309`: missing main default-manager runtime retains Task 4's `runtime-dependency-unavailable` precedence; missing adapter module or scenario-specific public capability yields `fault-capability-unavailable`. Injecting a manager skips only the main-manager import. This resolves the prior conflict without changing the established runtime ordering.
- ✅ The new regression at `scripts/test_ordinary_recovery_fault.py:438` runs the actual runner with `manager_factory=None` for both within-grace and after-grace, using refreshed, pinned valid manifests and denied Playwright imports. It asserts the exact attempted import, exit1, manifest presence, NOT_RUN, fixed preflight reason, untouched fault capability/count, and absence of the private exception canary. Browser start, status, admission observation, and adapter load are individually asserted uncalled.
- ✅ The existing injected-manager missing-routing-capability regression remains unchanged at `scripts/test_ordinary_recovery_fault.py:472`; together the two tests distinguish the required branches.

## Quality and new-breakage check

- **Approved.** No new actionable issue found in the scoped patch. It changes only the two contract paragraphs and the 34-line regression test; runner and adapter implementation remain unchanged. The regression checks actual branch behavior rather than replacing the runner's result.
- The original Task 5 implementation quality approval remains in force. This re-review does not reopen the broad review or promote pure-source evidence to runtime qualification. Deployment, browser/process provenance and real qualification remain separate root-owned gates.

## Evidence reviewed

- Read canonical `review-0133016..569b43c.diff` covering `73d77d9` and `569b43c`, the appended fix-round implementation report, and `task-5-r1-focused.log` directly.
- Focused recorded result: **2 tests in 0.045 seconds; OK; pristine output**, covering both default-manager scenarios and the retained injected-manager case.
- No tests, imports, Node VM children, browser/network/service/native operations, source edits or Git/index operations were performed during re-review. Only this requested private review report was written. The unchanged 104-test suite was not rerun.
