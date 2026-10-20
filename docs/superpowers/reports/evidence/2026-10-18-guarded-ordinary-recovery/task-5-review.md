# Task 5 independent review

## Spec compliance

- ⚠️ One plan-contract/integration conflict needs root's ruling: a missing Playwright module on the default recovery-run path is classified as `runtime-dependency-unavailable`, consistent with Task 4's runtime-dependency rule, before the adapter can produce the `fault-capability-unavailable` required by a literal reading of Task 5's missing-module rule. See Important finding below. No other spec discrepancy was found.
- ✅ The remaining Task 5 implementation matches the reviewed contract: original-constructor/original-close capture and exact current target (`scripts/ordinary_recovery_fault.py:58`, `:75`, `:99`, `:101`); explicitly routed wrapper stimulus (`:108`); supported page-local routing, fixed 12-second block and combined 32-attempt limit (`:188`, `:203`, `:221`, `:229`, `:239`); owned asynchronous work and disarm (`:170`, `:249`); sticky finite failure evidence and late PASS veto (`scripts/ordinary_session_recovery.py:1125`, `:1213`, `:1379`).
- ✅ Root's versioned clarification is present in the package at `docs/superpowers/specs/2026-10-18-guarded-ordinary-recovery-design.md:173` and the Task 5 plan. It does not widen the persisted snapshot or infer server failure causes.
- ⚠️ Source promotion, actual deployed provenance, native browser behavior, owned-process exit, and real baseline/recovery/10800-second qualification remain outside this source review. The pure VM/fake evidence does not establish those results; all real qualification gates remain root-owned and NOT_RUN.

## Strengths

- The native path captures both original references, checks they remain unchanged, reconciles client/socket/engine/transport identities after observation getters, and calls captured close on exactly the current socket. It does not invoke product recovery methods. Actual generated JavaScript is tested in bounded fake-only Node VM contexts, including replacement constructors/prototypes, an overridden instance close, and target changes (`scripts/ordinary_recovery_fault.py:50`; `scripts/test_ordinary_recovery_fault.py:350`).
- The routed path uses the public wrapper and supported synchronous `connect_to_server()` semantics without message/close overrides. Blocked WS attempts are explicitly closed without upstream connection; polling is aborted; deadline retries do not extend the block; overflow preserves a maximum projected count of 32 (`scripts/ordinary_recovery_fault.py:221`; `scripts/test_ordinary_recovery_fault.py:199`, `:206`, `:222`). Static installed-API evidence explicitly distinguishes Python Playwright 1.59.0 from bundled driver 1.59.1 and explains synthetic close metadata.
- Cancellation/noncooperation remains tracked, failure clears blocking, and disarm retains failure while removing only the saved HTTP matcher/handler. Tests exercise release/reaping of noncooperative work and exact unroute identity (`scripts/ordinary_recovery_fault.py:164`, `:170`, `:249`; `scripts/test_ordinary_recovery_fault.py:163`, `:255`, `:265`, `:276`).
- Scope tests reject promotion and instrumentation mismatch, and complete fake runner executions exercise success plus tick/disarm/post-browser-close failures and first-failure preservation (`scripts/test_ordinary_recovery_fault.py:375`, `:394`, `:426`, `:452`). The new integration is narrow and leaves parent lifecycle deadlines unchanged.

## Issues

### Critical

- None found.

### Important

- **P2 — Resolve and test the main-runtime versus adapter-capability error precedence (plan-contract/integration item).** `scripts/ordinary_session_recovery.py:1304` imports `playwright.async_api.async_playwright` and `:1307` translates ImportError to `runtime-dependency-unavailable`; the adapter is only loaded at `:1310`. Thus, with a valid recovery manifest and otherwise valid configuration, a missing Playwright package never reaches the constructor's `fault-capability-unavailable` mapping at `scripts/ordinary_recovery_fault.py:126`. Task 4 explicitly requires “Runtime dependency absence maps to runtime-dependency-unavailable” (`.superpowers/sdd/2026-10-18-guarded-ordinary-recovery-plan/task-4-brief.md:24`), while Task 5 states “Missing module or capability yields fault-capability-unavailable/NOT_RUN before browser creation” (`docs/superpowers/specs/2026-10-18-guarded-ordinary-recovery-design.md:169`; Task 5 brief interface paragraph). The current ordering meets the former and conflicts with the broad reading of the latter. It fails closed and creates no browser; this is not a false PASS or unauthorized-action defect. Root should explicitly distinguish missing main Playwright runtime from missing adapter/public capability, or choose a scenario-specific precedence and minimally adjust the code accordingly. Do not reorder imports unilaterally: that would change Task 4's rule. Lock the chosen distinction with a pure run-level missing-Playwright case using `manager_factory=None`; the new test at `scripts/test_ordinary_recovery_fault.py:438` supplies a manager factory and removes only `route_web_socket`, so it cannot settle this branch.

### Minor

- None found.

## Assessment and checks

- **Task quality: Approved** for the reviewed implementation. The adapter and minimal runner integration are appropriately separated, bounded, privacy-preserving, and meaningfully tested. **The integration/spec gate remains pending** the Important contract-precedence ruling and its focused test; the conflicting requirements do not establish an independent code-quality defect.
- Read the canonical `review-55e006d..0133016.diff` (commits `9ff82ef` and `0133016`), brief, integration/shared/global contracts, implementation report, current design adapter section, reviewer prompt, and supplied installed-API evidence. After root identified the predecessor requirement, read Task 4's brief directly and reconciled both requirements in the finding. No git command was run.
- One focused changed-file continuation was necessary because the runner diff hunks stop inside `run()`: inspected `scripts/ordinary_session_recovery.py:1133–1394` to check the named cross-cutting risks of capability-before-browser ordering and final-failure-before-persistence ordering. This established the issue above and confirmed the final snapshot is checked after cleanup and before export/exit. No broader source crawl or runtime inspection occurred.
- Read `task-5-final-after-selfreview.log` directly: **104 tests in 20.207 seconds; OK; pristine output**. The test source contains two bounded Node VM children covering 20 native and 7 routed fake contexts. No tests were rerun, optional runtime packages imported, or browser/network/service/native/process/build/npm operations performed during review.
- Only this requested private review report was written. Source, index and Git state were not changed.
