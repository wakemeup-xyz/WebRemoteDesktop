# Task 4 WIP handback — producer correction pause

Status: NEEDS_CONTEXT / paused at root direction. Source and index ownership explicitly returned to root. No stage, commit, service, browser, network, status, process, install/build or optional runtime invocation performed. Only owned source/test paths changed; four pre-existing dirty documents and node_modules left untouched.

## Context and rulings

Read task-4-brief first, global constraints, shared exact contracts, integration context and implementer template. Read relevant binding spec startup/lifecycle/origin/classification sections and actual predecessor helper and product read-only field names. Root accepted expected approximately 1100–1350 cohesive runner lines (not hard limit), with pure helper reuse and no unowned split/framework. Root later paused dependent work to repair producer correlation (rebind events must carry actual server session and be retained when previous socket matches before new socket is observed). Root ruling: no inferred session or hidden reason; projected rebind-failed uses generic recovery-gates-unmet, FAIL only with complete current matched Server/Host/owner evidence, otherwise INCOMPLETE. That ruling is NOT yet applied to WIP reducer.

## WIP implementation (not complete / not runtime ready)

- Existing direct-import compatibility switched to package-aware unchanged passive helper import; standard-library imports only.
- Type-strict transport byte/frame counts retain 9999999999999 bound (large byte count accepted).
- Added manifest pin/exact schema/file metadata/time/origin/log identity validation, in-memory PinnedManifest, private-safe projection and bounded mutation check.
- Added OwnedBrowserLifecycle partial-start ownership and fixed record/snapshot, cleanup one deadline and independent manager stop, preclose diagnostic first-event retention. Not yet integrated run/repeated cancellation coordinator.
- Added fixed reasons/scopes, provisional OrdinaryRecoverySummary with imported ContinuitySummary, gate checks, phase graph, ordered recovery classifier and lifecycle validation.
- Startup UI observer, run orchestration, summary validation, tick/status integration, CLI and many required edge tests are still outstanding. No live PASS claims.

## TDD

RED command: `/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest scripts.test_ordinary_session_recovery.ManifestTests scripts.test_ordinary_session_recovery.ClassifierTests scripts.test_ordinary_session_recovery.LifecycleTests`
- Log: `.superpowers/sdd/2026-10-18-guarded-ordinary-recovery-plan/task-4-red.log`
- Actual unittest exit 1; 11 tests in 0.146 s; failures=1, errors=29 (subtests). Expected missing new APIs plus existing fractional transport counters accepted. Shell wrapper displayed log and returned 0; unittest status is preserved in logged FAILED output.

Focused intermediate GREEN attempt same command:
- Log: `.superpowers/sdd/2026-10-18-guarded-ordinary-recovery-plan/task-4-green-core.log`
- Actual unittest exit 1; 11 tests in 3.989 s; 10 passed / 1 failed. Failure: successful recovery fixture skips sampled 302 tick (301 -> 303) and correctly hits sampling-gap; test must include required pre-fault observation. Do not weaken sticky gap detection.
- Final combined test suite has NOT RUN; implementation is intentionally incomplete at this handback.

## Changed owned paths

- `scripts/ordinary_session_recovery.py` (812 lines current; +386/-6 approximate diff)
- `scripts/test_ordinary_session_recovery.py` (729 lines current; +230)

Private orchestration report/log files only otherwise. Index unchanged. No commits created.

## Self-review / pending concerns

WIP is not reviewable as completed Task 4. Root producer correlation correction is load-bearing; no workaround implemented. Reducer rebind-failed currently provisional rebind-rejected must be changed to root generic reason with matched evidence check after producer fix. Pure success fixture needs continuous ticks. Cleanup repeated cancellation integration, owned startup observations, exact summary schema and all budget/privacy edge cases remain pending. Resume only after root explicitly reassigns source ownership on reviewed producer base; do not discard WIP.

# Task 4 completion — resumed on approved ad0b723

Status: DONE. Exclusive source/index ownership returned to root at this handback. No commits or staging performed; `git diff --cached --name-only` is empty. Only the two assigned source/test files were edited, plus this private report and named private test logs. The four pre-existing dirty documentation paths and node_modules remain untouched by this worker. No browser, network, service/status, Host/native/proof, build/npm/install, broad tests, tunnel, strict helper, sampler or SUP actions occurred.

## Resume and binding rulings

- Re-read the refreshed Task 4 brief first, integration context, exact shared contracts, global constraints and WIP report.
- Applied only the WIP module hunk onto the reviewed producer correction, then appended the WIP tests after the new reviewed Task 3 tests. Did not overwrite either reviewed file with an old full copy and did not stage via a three-way merge.
- Kept ad0b723's actual server-session correlation, known-previous rebind selection, one-shot cursor, HTTP ownership/settlement and privacy tests intact.
- Applied root's projected-failure ruling: a current matched rebind-failed event uses only recovery-gates-unmet; raw timeout/rejected/cancelled causes all project to that generic outcome. Complete current server/Host/owner evidence permits FAIL; incomplete observation remains INCOMPLETE; stale/foreign events do not bind.
- Applied root's recovery freshness ruling: retained lifetime frame-gap evidence is not reset or rewritten. Recovery readiness checks the current frame age using the unchanged 5-second threshold, full gates and actual selected path. The 30-second stability window requires continuing callback/relay-sequence progress and stable recovered identities/path. This is sampled stability evidence, not proof about every inter-frame instant.
- Adapter contract agreed with root: synchronous `BrowserLocalFault(scenario=scenario)` before browser creation; asynchronous install(page, origin, scenario=scenario), trigger_once(page), disarm(); synchronous exact snapshot(). Task 4 supplies only lazy loading and fail-closed composition. No-fault runs never import or construct the adapter. Task 5 remains responsible for its concrete implementation/capability validation.
- Root accepted one cohesive module growing beyond the initial estimate rather than splitting unowned files or copying the old runner. Final module is 1391 lines, including the existing approximately 456-line reviewed primitive implementation. No general harness/framework was introduced.

## Implemented behavior

- Direct script and package imports both work without sys.path/PYTHONPATH changes. Optional dotenv and Playwright imports occur only after manifest validation; injecting a synchronous manager factory avoids importing Playwright, and an injected status reader never invokes the default network reader.
- Exact hash-pinned runtime manifest validation checks strict duplicate-free UTF-8 JSON, exact nested keys, finite/non-bool types, sizes, origin/scenario/mode, creation/validity budget, private file mode/current UID/no-follow regular-file identity and actual Signal-log inode/device. The bounded in-memory pin is rechecked before the fault and at final export, including clock reversal and inode substitution. Persisted projection is explicitly root-attested and excludes log paths and manifest contents.
- Ordinary startup logs in through existing form selectors, waits for the ordinary query-stripping redirect and then navigates to the exact guarded Viewer URL. The page-local read-only closure keeps auth token/generation references private, verifies equality and core/shell identity, observes selector/proof/freshness, and returns only bounded state/identity fields. One actual actionable Start click must produce exactly one guarded API request/response and one Start mark; all later auth/Start/API/selector changes terminate without retry/reclaim.
- Owned startup observation continues while the real UI action awaits readiness. One page sample and one status request are owned concurrently in each 2-second tick; the status reader retains its total 750ms budget and 75ms settlement. Failures cancel and settle the other child; noncooperation poisons subsequent observation rather than starting another reader during teardown. Sticky Host/log alarms are consumed even if the page/sample is rejected.
- The pinned log opens before the first Host status read. Status is observed before Start, throughout startup, baseline, recovery/stability/continuity, immediately before the fault and during final export. Final status/sample/diagnostic work shares the existing single 1-second export budget, before browser close.
- The explicit source phase graph is preflight -> startup -> baseline/continuity; recovery takes baseline -> fault -> recovering -> recovered-stability; all paths can end at terminal and cannot restart. A one-second row need not expose the brief fault phase, but the actual transition occurs.
- Baseline/continuity reuse the unchanged ContinuitySummary with qualification beginning only after complete owner/auth/build/path/full-gate readiness and new frame progress. A triggered recovery permanently interrupts its continuity result. Recovery classification requires directly matched ordered server events, the correct lease/reset binding, current owner/session and fresh media; a retained old frame alone cannot pass. New failures at the end of stability/final export still veto PASS.
- OwnedBrowserLifecycle owns factory/start/launch/context/page, service_workers=block and bounded independent browser/manager teardown. Manager construction is inside the owned try/finally after preliminary evidence writes. Partial start, factory errors, timeouts, noncooperation, repeated cancellation and write failures remain visible. One shielded coordinator preserves a single cleanup deadline and reserves managerStop allowance. Successful browserClose is closed, successful manager stages are ok, and outer completion remains api-finished-exit-unknown with ownedProcessExitEvidence not-observed.
- Final export preserves the earliest preclose terminal diagnostic even if a final sampler delta/export loses it. Exact summary/lifecycle/fault schemas, finite reasons, private wrappers and caps are validated before persistence. Output directories/files use 0700/0600, rows/summary/lifecycle are each bounded to 32768 bytes, and the stream reserves three row budgets for summary/lifecycle/one atomic temporary file within 64 MiB.
- Transport bytesReceived/framesDecoded/framesDropped are type-strict integer counters while retaining the existing 9999999999999 maximum, including legitimate bytesReceived above one billion.

## Parent collector integration facts

- Startup observations **are persisted** as wrapper rows with phase startup; they do not count toward qualified baseline/continuity time.
- Successfully completed startup observations contain an actual validated private sampler row. A failed/missing sample can be persisted as sample:null and terminates qualification; no fake zero-valued metrics are inserted. Before the sampler is installed there are no wrapper rows.
- During startup, sessionHash/socketHash/admissionHash may individually be null until their actual identities exist. The admission hash is derived only from the ordinary resume generation; no ticket crosses the projection. During a recovery outage socketHash can be null while the private log cursor retains the last validated known socket IDs for correlation. A baseline begins only with all three nonnull hashes.
- Wrapper elapsedSeconds uses one monotonic anchor established when observation begins, continues through startup -> baseline -> recovery/continuity, and is never reset or used to rewrite prior rows. Qualified duration is tracked separately from the first fully ready baseline/continuity observation. Final export can persist an additional row but does not advance qualified baseline/stability duration.
- Before/without a confirmed fault, requested recovery output is NOT_RUN; the absent concrete adapter currently fails before browser creation with fault-capability-unavailable. BusinessInput, visibleEffect, physical and nativeAfterGraceQualification remain NOT_RUN for every scenario.

## TDD and validation evidence

All Python invocations used `/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11` for execution of tests/runtime checks. Edits before the initial pause used small local text-edit scripts; no optional/runtime imports were executed by those edits. No Node test ran alongside the scheduling-sensitive Python suite.

1. Initial RED (already recorded above): 11 tests / 0.146s, failure 1 + 29 subtest errors, unittest exit 1. Missing manifest/lifecycle/reducer APIs and wrongly accepted fractional counters. Initial intermediate core implementation: 11 tests / 3.989s, 10 pass / 1 failure caused by a missing pre-fault fixture tick. Corrected the fixture to include tick 302; did not weaken sampling-gap detection.
2. UI/ownership/run RED:
   - Command: `python3.11 -m unittest scripts.test_ordinary_session_recovery.GuardedUiTests scripts.test_ordinary_session_recovery.OwnedObservationTests scripts.test_ordinary_session_recovery.RunPreflightTests`
   - Log `task-4-red-integration.log`: 6 tests / 0.255s, 18 expected missing-API subtest errors, unittest exit 1. The surrounding zsh command initially attempted to assign reserved status after unittest; that wrapper error did not change the logged actual RED result. Subsequent commands used run_exit.
3. Intermediate focused integration command selecting ManifestTests, ClassifierTests, LifecycleTests, GuardedUiTests, OwnedObservationTests, RunPreflightTests:
   - `task-4-green-integration.log`: 17 tests / 1.260s, 16 pass / 1 failure. The cancellation fixture initially expected a coroutine finally block to execute even when cancelled before first scheduling. Corrected the fixture to observe entry before injecting failure; actual owned cancellation semantics were retained.
4. Recovery/real run boundaries GREEN:
   - Command: `python3.11 -m unittest scripts.test_ordinary_session_recovery.RecoveryBoundaryTests scripts.test_ordinary_session_recovery.RuntimeRunTests scripts.test_ordinary_session_recovery.OwnedObservationTests`
   - `task-4-boundaries.log`: 13 tests / 1.509s, exit 0, OK.
5. Self-review terminal safety RED:
   - Command: `python3.11 -m unittest scripts.test_ordinary_session_recovery.TerminalSafetyTests`
   - `task-4-red-terminal.log`: 5 tests / 0.158s, failures 3 + errors 1, exit 1. Exposed first-close loss during a mutating export, incomplete summary cross-field validation, late expiry/path-change admission, and status timeout being surfaced as a generic timeout.
   - Fixed those actual boundaries and added no-cooperative-close, fallback manager ownership, startup gap, final status/capture settlement, pin mutation, missing adapter and direct CLI checks.
6. Focused terminal GREEN:
   - Command: `python3.11 -m unittest scripts.test_ordinary_session_recovery.TerminalSafetyTests scripts.test_ordinary_session_recovery.AdditionalOwnershipTests scripts.test_ordinary_session_recovery.MoreRuntimeTests scripts.test_ordinary_session_recovery.CliTests`
   - `task-4-green-terminal.log`: 11 tests / 0.640s, exit 0, OK.
7. Combined scoped suite initially passed: `task-4-final-tests.log`, 132 tests / 17.183s, exit 0. Final import-boundary audit then replaced the old async login helper call with the same three local form UI operations, keeping only the allowed helper reuse. Root was notified before that small last edit.
8. **Final actual-source command after every edit:**
   - `/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest scripts.test_ordinary_session_recovery scripts.test_passive_session_soak`
   - Log `.superpowers/sdd/2026-10-18-guarded-ordinary-recovery-plan/task-4-final-after-import-audit.log`
   - **132 tests / 16.210s / exit 0 / OK; output pristine, no warnings.** This is the final source verification; no code edits followed it.
9. `git diff --check -- scripts/ordinary_session_recovery.py scripts/test_ordinary_session_recovery.py`: exit 0, no output. Direct --help and invalid-manifest CLI-before-runtime checks are covered by CliTests in the final suite.

## Final changed paths and self-review

- `scripts/ordinary_session_recovery.py` — 1391 lines at handback; the owned delta is approximately +944/-5 relative to reviewed ad0b723.
- `scripts/test_ordinary_session_recovery.py` — 1286 lines; +704 lines. Reviewed predecessor tests remain present.
- Private report/logs in the task's existing `.superpowers/sdd/...` directory only otherwise.

Self-review checked the actual phase transitions, first-failure preservation, startup observation ownership, status/log correlation, final preclose gating, optional import order, type-strict caps, direct CLI imports, private evidence surface, exact manager lifecycle statuses and cleanup deadline ownership. The new terminal-safety REDs led to concrete fixes before the final suite. No raw IDs, token/password values, exception bodies, arbitrary URLs or manifest/log paths appear in artifacts. The pure suite validates fake browser/UI decisions and reducer evidence only; it does not simulate or claim a live PASS.

No known unresolved Task 4 correctness ambiguity remains. Review/Task 5/live deployment and real qualification remain root-owned later gates. The larger cohesive module is the review-surface concern explicitly accepted by root; no source architecture split or unrelated edits were performed.

# Fix round 1 — Important I1, base b6570f7

Status: DONE. Source/index ownership explicitly returned to root. Only `scripts/ordinary_session_recovery.py` (+9/-1) and `scripts/test_ordinary_session_recovery.py` (+75) changed. No staging/commit/index edits, concrete fault adapter edits, helper/sampler/SUP edits, subagents, Node/broad tests, runtime dependency imports, browser/network/service/status/build operations. The existing private report and named test logs are the only other writes. `git diff --cached --name-only` is empty; scoped `git diff --check` exited 0 with no output.

## Review finding and fix

Read the full `task-4-review.md` before editing. I1 correctly identified that final no-fault export used a new one-sample readiness probe and skipped the qualified reducer history, so a terminal PC/attempt/generation/lease/path change or frame-counter regression could escape the continuity contract.

The final no-fault branch now makes a shallow copy of the existing unchanged `ContinuitySummary`, observes the actual final private sample at the **already qualified elapsed duration**, and requires that validation-only reducer result to remain PASS. The unchanged reducer performs the original identity and historical counter comparisons. Its current state contains only immutable/scalar state relevant to these updates, and its observe method assigns those attributes without modifying shared state; the original qualified reducer is untouched. The run's qualified duration, sample count, identity and counter baselines therefore do not advance during cleanup. An invalid terminal observation raises the existing fixed baseline-failed reason; existing first-failure guards remain in place. Full current gates, owner/auth/build/Host/log checks still run.

## Additional necessary existing-contract correction (root authorized)

The initial realistic floating-clock fake run exposed a masking validator bug: `validate_summary` built its schema template with `ContinuitySummary.result(elapsed_s=0)`, inferring integer-only elapsedSeconds. Actual qualified duration is a float, so final persistence was rejected and the preliminary summary remained at elapsedSeconds 0. Root explicitly authorized the minimal `elapsed_s=0.0` template correction as implementation of the existing finite-seconds contract, not a schema/authority expansion.

A focused test now accepts legitimate fractional elapsedSeconds 300.125 while retaining integer-only samples/missingSamples/failedObservations/identityChangeObservations. This correction does not relax counters or change emitted fields.

## Behavioral tests

The new full fake-run test exercises the real runner orchestration, reducer, 300 one-second baseline observations, final export, files and cleanup. It advances only the runner's scheduling clock and uses injected fake page/status/manager implementations. It does not preseed a qualified model, reduce the duration, replace the classifier, or inject PASS. The fake actual UI click still emits the observed request/response; all results are offline test evidence, never a claimed live qualification.

Seven cases share the same fully qualified baseline and differ only in the final-export sample: unchanged success control; changed lease; changed selected path; regressed frame callback counter; changed PC identity; changed attempt; changed generation. The test checks original elapsedSeconds remains 300, qualified sample count remains unchanged, one actual fake UI click, normal teardown, recovery NOT_RUN, unchanged exit 0/PASS and changed exit 1/baseline-failed. Existing full-suite tests continue to cover preservation of earlier failures.

## RED/GREEN commands and outcomes

All commands below use `/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11`.

1. **Genuine initial RED exposing the masking finite-seconds bug**, before any source edit:
   - Command: `python3.11 -m unittest scripts.test_ordinary_session_recovery.FinalQualifiedContinuityTests`
   - Log `task-4-r1-red.log`.
   - 1 test, 7 failing subtests, 8.125 s, exit 1.
   - Each fully sampled floating-clock run reached the final path but final summary persistence rejected float elapsedSeconds; the artifact retained preliminary elapsedSeconds 0. The failure was `AssertionError: 0 != 300`, not yet the I1 assertion.
2. Supplemental isolation with an integer-valued scheduling clock, still before source edits (launched while awaiting root's validator ruling):
   - Same command, log `task-4-r1-red-final-boundary.log`.
   - 1 test, 6 failing negative subtests, 7.774 s, exit 1; unchanged control passed.
   - This clock avoided the independent float-schema defect and exposed I1 directly: final-only changes still returned 0 where 1 was required. This does **not** claim a normal floating-clock run passed on the unchanged source.
3. **I1 RED after only the root-approved finite-seconds template correction**, with fractional scheduling clock restored and the new fractional/count schema test added:
   - Same command, log `task-4-r1-red-after-seconds-fix.log`.
   - 2 tests, 6 failing negative subtests, 8.937 s, exit 1.
   - Fractional/count schema test and unchanged fully qualified success control passed. Lease/path/counter/PC/attempt/generation final-only changes still returned exit 0 (`AssertionError: 0 != 1`). The final-export path was otherwise unchanged at this RED.
4. **Final GREEN after both fixes, actual final source**:
   - Command: `/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest scripts.test_ordinary_session_recovery scripts.test_passive_session_soak`
   - Log `.superpowers/sdd/2026-10-18-guarded-ordinary-recovery-plan/task-4-r1-final-green.log`.
   - **134 tests, 24.630 s, exit 0, OK.** No code edits followed this run.
   - Output includes one asyncio debug slow-task diagnostic for the new fake-run test step taking 0.104 seconds. It is not a test failure, timeout, lost observation, or runtime/browser event. Unlike the prior 132-test log, this output is therefore not claimed pristine. No rerun was made merely to obtain quieter output.

Self-review confirmed the only runner changes are the stdlib copy import, finite-seconds template correction and seven-line final-history validation. The unchanged reducer still defines continuity identity/path/counter semantics, avoiding a second manually maintained comparison list. No unresolved source correctness issue from I1 remains; independent re-review remains root-owned.
