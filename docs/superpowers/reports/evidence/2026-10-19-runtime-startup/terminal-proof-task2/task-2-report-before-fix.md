# Task 2 implementer report

Status: DONE for scoped implementation and pure fixtures. Root owns all Git/index/commits; no Git command was executed by this implementer and no commit was created. Task 1 files were read only and its suite was not rerun. Files written were exactly the two authorized new scripts and this ignored report.

## Implementation

- `scripts/guarded_terminal_scan_continuation.py`: four required public functions, exact outer attempt/decision/result schemas, explicit ProductionIO boundary, and CLI `--r5-attempt PATH --r5-attempt-sha256 SHA [--check-only]`. Import and no-argument execution never enter a scenario.
- `scripts/test_guarded_terminal_scan_continuation.py`: 38 focused tests using actual new validators, original sealed R4 definitions, actual immutable main code, actual immutable Registry AST, actual module35 and Task 1 producer/consumer, with declared external legacy-gate/process/filesystem/clock/Git boundaries replaced by fakes.
- Entire original manifest is checked before private code execution. Manifest SHA is `bcd09baaa0b0936e7424cd0dea5e51fb067503399ca49d3a236e789fc0fa6861`. The loader discovers nested and top-level imports from original AST, verifies an exact closure and external SUP/passive pins, then compiles the original complete bytes. AST is not used to rewrite algorithms. Each load has a private module graph and custom per-module import function; no global sys.path/sys.modules mutation, no shared R4 module patch, and no R reassignment occurs. Cached same-name package modules are rejected. Actual module `__file__` and SHA are checked.
- Original `attempt_context`, `ready_context`, and `current_gate` references remain intact. The new main has the identical original code object and only three changed global bindings: worker producer/sample original instrumenter; worker strict new consumer/sample actual original pure coverage validator; source_pins additive startup gate. The original coverage validator is variadic and pure, so the actual sample is passed as its sole argument, without a fabricated clean worker.
- source_pins always invokes the original function before examining wrapper state. Startup checks marker absence and repeats exact known-list/strict idle/root-decision freshness only after expensive original source validation. Final requires the main's exact marker schema, sources/history/attempt/runtime/epoch/output-directory binding, still calls original source validation, and does not replay startup TTL. Extra calls, missing/foreign markers, source failures and clock reversal fail closed.
- Four immutable failed lineages plus reload started/result/readiness-started/readiness are bound. All result classifications remain unchanged. Full historical nonce/attempt/sequence values are read from pinned records, not reconstructed from prefixes. Exact 21+7+6 identities, parent/observation provenance and source SHA/role provenance are derived and compared as a full ordered union.
- First failed lineage has no sequenceId/attemptId/attempt.json. Root explicitly approved preserving its actual variant: frozen/sourcePins/started/runtime/result, plus its full runNonce. The subsequent three lineages bind sequence/attempt/started/runtime/result. No nonexistent historical IDs were invented.
- Admission records include bounded per-identity observations, both clocks and provenance; strict idle remains viewer=relay=0, original service_set retains its 5-second listener command. Gone, same-birth zombie and stable nonmatching birth prove only old identity quiescence. Services are a separate active identity set. The outer started record saves initial admission; the result saves the separate post-source startup admission.
- Actual run creates an exclusive outer started marker, invokes the original main, preserves original legacy result bytes, and separately writes proof/result. Available partial proof/assessment is retained even when a later legacy stage fails; classification stays failed. Success requires legacy success, two correctly ordered source validations, a persisted matching proof/assessment and exact result binding. Missing results never imply success.
- Later scenarios walk the bounded outer + legacy predecessor chain back to the new baseline, checking outer input, one-use marker, root decision, saved fresh admission, proof and legacy result references. No automatic next attempt/retry/clear exists.
- All original budgets/deadlines/quality checks remain in original main: 300/390/390/10800 seconds, worker duration+128, original cleanup and sample behavior. Tests confirm both complete recovery scenarios have no sample launch.
- check-only invokes real production attempt_context (and hence ready_context), independent real current_gate and original source_pins, then the final new admission check. It never invokes main, creates operational output or consumes markers. CLI emits a small sanitized JSON summary only; exceptions expose class, never arbitrary error messages. Run progress is discarded in a bounded sink without creating a new operational rejection from progress volume.

## TDD and verification evidence

Working directory for every command:
`/Users/macstudio1/.codex/worktrees/terminal-scan-exit/WebRemoteDesktop`

Command used for every focused run:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s scripts -p 'test_guarded_terminal_scan_continuation.py' -v
```

RED before freshness implementation: 2 tests, 0.001s, `FAILED (failures=2)`; both actual `_clock_window` behavior assertions failed with `AssertionError: RuntimeError not raised`. The missing behaviors were expiry after source validation and monotonic reversal. This was a behavioral RED, not an import/syntax/fixture failure.

During expansion, the loader correctly rejected a fixture that had imported Task 1's test module, which cached same-name module35. That fixture setup was changed to its own bounded immutable Registry AST loader; the production pollution rejection was not weakened. This setup failure is not claimed as additional behavioral RED.

Intermediate focused GREENs after additional matrix coverage: 18/18 in 4.629s; 26/26 in 9.195s; 34/34 in 14.811s; 34/34 in 14.053s after review tightening; 36/36 in 16.503s. The 26-test iteration printed only fake in-memory legacy summaries, then the fixture's stdout was captured for clean output.

Final GREEN after all implementation and tests:

```text
Ran 38 tests in 15.900s
OK
```

Final output was clean unittest output without legacy summaries/warnings. No old suite or Task 1 suite was rerun. A separate `shasum` utility call emitted a locale warning; this was outside the test run and did not modify files or affect tests.

Coverage includes:

- original function identities/private module graph/actual source location; wrong root, closure loss, byte/mode/SUP drift, cached module pollution; real local attempt_context negative before external gates;
- actual pinned four-history parsing, full nonce deny-set, missing fourth PID36482, six helpers missing, same-count wrong identity, provenance mismatch, order/missing chain/runtime/readiness mismatch;
- exact outer schemas, fresh/expired/reversed/nonfinite/bool clocks, known observation alive/unknown/birth-race/missing/wrong identity, occupied state and listener bound;
- check-only call order, no writes/no starts/no consumption, source validation expiry/failure, sanitized bounded CLI and no-argument refusal;
- unchanged main code executing with fake IO and explicit external legacy gate boundaries; actual producer/consumer absent race and no-gap cases; unchanged raw gap and observedUnexpectedCoverage; missing proof/extra gap/sample gap downstream rejection;
- original occupied/source/runtime/worker/terminal failure propagation, late final source failure retaining partial assessment but failing overall, +10800-second final source call without startup TTL replay, preexisting/missing/foreign marker and extra hook call rejection;
- exclusive one-use, missing legacy result, missing predecessor result/proof/started, full baseline/within/after/continuity predecessor chain, original budgets and no recovery sample;
- actual ProductionIO regular-file/mode/symlink/exclusive behavior only on generic temporary fixture files; actual code-pin method with fake Git/file IO; actual known observation adapter with fake exact-PID Process and service boundary.

## Honest scope and unchanged operations

The complete actual old successful gate chain is **NOT_CLOSED by fixtures**. The fake boundaries explicitly cover legacy FS/source-Git/HTTP/business-evidence gates, Rows/terminal evidence and process/file operations. No receipt purporting to pass the original 84-receipt/1016-file live chain was fabricated. The actual main control flow and the new admission/proof/one-use logic run in tests, but the legacy success boundary is explicitly fake.

Root's real read-only `--check-only` is **NOT_RUN by this task**, and must follow independent review. Actual qualification is **NOT_RUN**. No worker/browser/sample/service/tunnel/watch/Host/network/Git observation or mutation was executed. Existing original packages, source held41, primary and Task 1 files were not written. No actual preparation, decision ID, nonce, marker or receipt was generated; fixture IDs are obvious fixed synthetic values and operational-shaped fixture files remain in memory. Generic temporary file IO tests write only `{}` into temporary files and remove them.

Old FAILs are immutable. The policy is prospective. Full process-tree exit remains unknown and no complete tree claim is introduced. Pacing remains NOT_ELIGIBLE pending real qualification. Formal-UA versus browser-UA/Cloudflare behavior is not changed by this task.

## Exact record construction contract for root

Production records are private regular owned files, mode 0600, with absolute canonical paths (use `/private/...` for temporary roots); outer root, sequence and attempt directories are owned plain directories mode 0700. References are exact `{path, sha256}` and hashes refer to complete raw bytes. JSON rejects duplicate keys and nonfinite numbers.

The outer input path is:
`<rootDirectory>/<sequenceId>/<attemptId>/r5-attempt.json`

Outer `ATTEMPT_KEYS`:
`schemaVersion, kind, rootDirectory, sequenceId, attemptId, runNonce, scenario, legacyAttempt, history, dependencySeal, codePins, rootDecision, previousResult, immediatePriorFailureSHA256, deployedPins`.

Values: schemaVersion=1; kind=`r5-terminal-scan-attempt`; IDs equal the *new* prepared legacy IDs; legacyAttempt references that legacy attempt.json under original R; previousResult=null for baseline and references the prior R5 result for later scenarios; immediatePriorFailureSHA256 is fourth FAIL; deployedPins equals the fixed module `PINS` dictionary.

`dependencySeal` exact keys: `root, manifestSHA256, files, supervisor, passive`. Root/manifest are fixed constants. `files` maps precisely the discovered transitive `.py` closure to `{sha256, mode}` (mode decimal 384 / octal 0600); every manifest file is verified independently as well. `supervisor` and `passive` are `{path, sha256, mode}` for the original fixed sources. Their modes must be actual current pinned file modes, not guessed.

`codePins` exact keys: `supervisorSourceTIP, files`. The TIP must be the actual new wrapper repository HEAD (40 hex), separate from all deployed pins. `files` maps exactly the two production paths in `CODE_FILES` to their actual SHA256. Production verifies HEAD, live file bytes and `git --no-replace-objects show TIP:path` bytes. Root must bind its final chosen commit, not the old deployedToolTIP or held41.

History exact keys: `schemaVersion, failures, reload, knownIdentities`. Failures are four ordered dictionaries: first `{frozen, sourcePins, started, runtime, result}`, next three `{sequence, attempt, started, runtime, result}`. Each value is a reference. Reload is `{started, result, readinessStarted, readiness}`. knownIdentities is the sorted exact derived union; each row contains `pid,birth,parent,firstObservedEpoch,lastObservedEpoch,sources`, with `sources` entries `{resultSHA256,role}`. The original package's legacy-deployed-reference.json, legacy-tool-history.json and deployment-history.json pin the first three; fourth/reload paths and SHAs are module constants. `validate_r5_history` validates and returns the canonical history digest.

`rootDecision` points to a separate explicit root decision with exact `DECISION_KEYS`:
`schemaVersion, kind, rootDirectory, sequenceId, attemptId, runNonce, scenario, legacyAttempt, historySHA256, dependencySealSHA256, codePins, previousResult, immediatePriorFailureSHA256, deployedPins, issued, automaticLaunch`.

Values: schemaVersion=1; kind=`root-r5-one-scenario`; automaticLaunch=false; shared bindings exactly equal input; issued=`{wall,monotonic}` from real contemporaneous clocks. The two structured hashes are SHA256 of `compact(parsed history)` and `compact(dependencySeal)` respectively: sorted keys, UTF-8, ensure_ascii=false, compact comma/colon separators, allow_nan=false. These structured hashes are distinct from reference hashes over possibly pretty-printed file bytes. Each observation and the final post-source check must remain within 60 seconds in both clocks; do not backdate or refresh clock fields in an existing decision.

To preserve check-only inputs while preparing a later independent run decision: use one private rootDirectory for the immutable check-only input/decision and a **different** fresh private rootDirectory for run input/decision, referencing the same still-unconsumed *new* legacy attempt. The rootDirectory is itself decision-bound. Do not overwrite the old input/decision/output; check-only creates no markers. The run still repeats every gate. After run starts, subsequent scenarios use that same run root to preserve predecessor path bindings. This exact workflow is covered by a fixture that checks the check-only input and decision bytes remain unchanged.

For each actual run, output filenames are fixed: `r5-started.json`, `terminal-proof.json` when a producer snapshot is available, and `r5-result.json`. All are exclusive creates. No cleanup/retry/reset facility exists. An unavailable or incomplete output stays failure/unknown.

## Self-review

Reviewed the new files directly without Git. Tightened marker schema/source binding; preserved partial failed-run proof/assessment; added complete bounded outer predecessor tracing and persisted post-source fresh observation; checked per-row and across-stage clock ordering; prevented a stdout quota from changing original runtime acceptance; tested immutable check-only/run inputs and decisions separately. No unresolved implementation defect is known. Expected remaining validation is independent review and root's actual read-only integration; neither is represented as completed here.
