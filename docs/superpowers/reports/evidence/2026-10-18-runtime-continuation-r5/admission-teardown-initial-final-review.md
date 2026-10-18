# Final independent increment review — ordinary admission teardown

**Verdict: Changes requested. One actionable P2 correctness/contract finding.** No other actionable architecture, privacy, bounded-lifecycle, or documentation finding was identified. This is a source and archived-evidence review, not runtime qualification or operational approval.

## Finding 1 — [P2] Preserve detach failure before later log-finalization failures

Location: `scripts/ordinary_session_recovery.py:650–654`, consumed by `:1381–1393`.

The new detach exception handler only sets local `failed=True`. It does not latch the run's first failure. After the coordinator finishes, `run` closes the server log and evaluates its reason before it finally calls `fail(cleanup-incomplete)`. This changes the previous detach failure priority: at c802a68, the removed post-stop detach handler called `fail(cleanup-incomplete)` immediately, before log close and fault-finalization checks.

There is a concrete existing path requiring no invented exception type: a final `ServerRecoveryEvidence.read_tick` can retain an incomplete trailing line (`:228–230`) without failing the observation. `ServerRecoveryEvidence.close` then changes its reason to `server-log-gap` (`:190–195`). Given a qualified run, successful final export, a detach exception, and that retained partial line, the new code records `server-log-gap` at `:1386`; `OrdinaryRecoverySummary.fail` is first-wins (`:728–732`), so the earlier detach failure never becomes the primary failure. The old detach handler recorded `cleanup-incomplete` before discovering that log gap. A log-close OSError similarly changes the primary reason to `server-log-unavailable`.

The run still fails, so this is not a false PASS. It is a regression in the requested unchanged error priority and first-failure evidence: a later cleanup issue masks the earlier admission-detach defect, and failureDetectedMs is deferred to that later issue. The supplied ledger contains no intentional priority-change ruling. The retained task review's statement that fail-first semantics are unchanged is too broad for this combination.

Preserve the detach failure in the existing first-failure path before subsequent log/fault finalization, while keeping prior export/business/cancellation failure intact. Keep captureStatus independent, no new public evidence schema or raw error strings, and the same independent close/stop and original deadline. Add a meaningful actual-run fake regression combining successful qualified export, detach failure and a trailing partial log (or log-close failure), alongside a control showing log failure remains primary when detachment succeeds. The existing prior-human-priority and isolated-detach tests do not cover this combination. I did not execute a reproduction or rerun tests; the finding follows directly from the old/new control flow and actual log implementation.

## Exact scope and integrity

Reviewed the full 1,809-line, 191,925-byte package `.superpowers/sdd/2026-10-18-ordinary-admission-teardown-plan/review-c802a68..3662573.diff`, all 24 changed paths, current linked spec/plan, task brief/report/ledger, independent task review, relevant runner/guard/model/log and lifecycle helper code, and retained RED/adjustment/GREEN/affected evidence.

Exact range: `c802a68362459b46b84593c7e8921575e0783394..3662573fc8a6c4c6561f427d8f80f0491fa373c0`. HEAD resolves to the latter. The package's embedded diff exactly matches `git diff --unified=10` for that range. Package SHA256: `1d3e5c53104b00b9e56d33c3f0ba11d0f3f2b739b915c651481413328c1e3cd3`.

All 18 evidence-index payloads match their declared byte sizes and SHA256 values. The whole-range diff whitespace check reports two intentional Markdown hard-break trailing spaces in the exact archived move-task-report, not a production or actionable documentation defect. Do not silently edit immutable archived evidence to normalize those spaces.

## Otherwise satisfactory boundaries

- One narrow optional callback remains owned by the existing lifecycle. Final export and admission validation precede detach; browser close and manager stop follow independently, including export/detach failure. No generic framework, duplicate teardown owner, transport exception waiver or retry is added.
- Cleanup still fixes one total 8-second deadline. The additional stage uses the existing 1-second export cap against remaining total time; close retains its 5-second maximum and reserved 3-second manager-stop allowance. This does not promise forcible settlement of arbitrary uncooperative callbacks or defeat OS scheduling; those existing limits remain.
- The idempotent coordinator and shielding retain exactly-once attempts under repeated external cancellation. Partial startup without a guard leaves no callback. Snapshot/result/CLI schemas, admission authority, qualification gates, quality controls and process-exit evidence are unchanged. ownedProcessExitEvidence remains not-observed; full-tree exit is not proved.
- Strict fake subscription state and actual full-duration reducer coverage meaningfully expose post-stop listener removal. Tests preserve the existing final-observation negative cases, successful capture followed by detach failure, export failure, async timeout, idempotence, independent stop after close failure, earlier human-priority failure and repeated cancellation. The missing combined-failure case is Finding 1.

## Archived evidence and documentation

The active spec/plan accurately describe the intended order, original budget, unchanged schema and no runtime credit; Finding 1 prevents full first-failure compliance. Historical reviews are explicitly archived checkpoints. The latest report and root closure correctly distinguish source 380e4e4 from deployed Viewer c802/build bb581, backend dfb1543, and pending exact tool promotion/new baseline.

Read-only checks of the fixed R5 apply/reload/readiness records confirmed source-applied/completed/runtime-ready-observed, Signal33747/birth1792336141.182036, Host36877/birth1792322600.528357, build bb581651b422e400, builtAt1792336142126 and separate Viewer/backend/tool identities. These are historical recorded observations, not a new claim that services are currently healthy.

The fixed qualification-result, summary, lifecycle and samples hashes match the report: `5ef3358f…`, `14d35f61…`, `15cbcb1a…`, `f879a98f…`. The actual result remains failed-or-indeterminate, workerExit1, 314 rows, continuity INCOMPLETE despite 300.2765096 observed seconds, successful capture and incomplete cleanup. Seven recorded identities exited with no signals; completeProcessTreeExitEstablished is false. No later health observation or fake integration can clear this failed attempt.

Performance summaries distinguish callback/output throughput from fresh capture and source-pixel age, retain overlapping-window and causal-attribution limitations, and leave all six input metrics unavailable/null/NOT_RUN. Earlier baseline/checker failures, native/business/visible/physical NOT_RUN, missing three-hour/recovery qualification and pacing's fresh-successful-baseline prerequisite remain explicit. No credentials, raw input, clipboard or coordinates were added by this increment. I verified fixed records and summaries; I did not independently recompute every historical Host performance scalar or re-review all older operational packages.

## Retained verification and limits

Existing logs were read and hashed, not rerun:

| Evidence | Result | Elapsed |
| --- | --- | ---: |
| Required RED | 1 actual behavior failure plus 8 secondary ordering errors | 10.634s |
| Fixture adjustment | 1 incorrect capture-status expectation among 8 tests | 10.074s |
| Focused GREEN | 8 PASS | 9.961s |
| Affected suites, once | 166 PASS | 37.357s |

Their SHA256 values match the task report. Current runner SHA256 is `bf83666bf856ddb092718a8ce4ccf8fab97efb0e96f2c1d7bbb5eb2b6ce92e89`; test SHA256 is `707285c8917732f7326d08f81e9c280cc9e602132b7433c53759f605d65844b6`.

Review coverage is complete for this increment, with Finding 1 unresolved and no parked minor implementation findings. Resolve it and obtain focused follow-up review before treating this source as clean for promotion preparation. This report supplies no actual-runtime, browser/native, full-process-tree or input-to-picture acceptance. Source approval cannot reuse the failed R5 nonce, rows or duration.

Used the commit-history-review correctness/architecture/docs-sync standard within the explicitly delegated read-only scope. Only this private report was written. No project/operational imports, tests, builds, network/process/status/health/service/browser/native operations, source/package/index edits, commits or subagents were performed. Standard-library text/JSON/hash parsing and read-only Git supplied the checks. Root owns repository persistence and anchor updates; the four pre-existing dirty documents and node_modules were left untouched.
