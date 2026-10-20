# Independent private pure-collector integration checker review

2026-10-18. Static review only; the checker and fixtures were not executed or imported.

## Findings

### P1 — Direct unittest invocation makes every cleanup fail and prevents successful completion

File: `/tmp/wrd-pure-collector-integration-20261018.py`, lines 110–116 (particularly 112–116).

`FinalQualifiedContinuityTests` derives from `unittest.IsolatedAsyncioTestCase`. Its constructor leaves `_asyncioRunner = None`; the proposed checker calls `setUp()` and the test method directly through an unrelated `asyncio.run()`, so it never initializes the case's runner. In the configured Python 3.11 standard library, `IsolatedAsyncioTestCase._callCleanup()` delegates even synchronous cleanup callbacks to `_callMaybeAsync()`, which unconditionally asserts that `_asyncioRunner` is initialized. `TestCase.doCleanups()` pops each registered callback, catches each assertion as a test failure, and returns false.

Consequently the fixture's registered dotenv patch restoration and temporary-directory cleanup callbacks do not execute, and `require(case.doCleanups())` raises even if all seven producer/consumer cases passed. The script cannot emit its intended success record. The outer module patch and temporary-directory finalizer may eventually restore/remove some state, but they do not establish the promised explicit fixture cleanup. If the test already failed, this new cleanup failure also replaces the propagating failure. Additionally, `case.setUp()` is outside the inner try/finally, so a partial setup failure does not reach even the attempted `doCleanups()` path.

Fix: invoke only this selected case through its official `case.run()` lifecycle with an explicit, silent `unittest.TestResult`; require exactly one test, no errors/failures/skips/expected-failure outcomes and successful completion, in addition to the existing seven-case counters. This initializes and closes the case runner, preserves the original setup/teardown/cleanup semantics, and handles partial setup failures. Keep the existing scoped patches and audit guard active across the entire case lifecycle. Do not combine an uninitialized case with external `asyncio.run()`, and do not use a broad discovered suite. Review the resulting result-check and cleanup paths before execution.

Static evidence: configured stdlib `/Users/macstudio1/.homebrew/opt/python@3.11/Frameworks/Python.framework/Versions/3.11/lib/python3.11/unittest/async_case.py`, lines 35–38, 98–117 and 119–133; `unittest/case.py`, lines 652–663. Fixture `RuntimeRunTests.setUp`, lines 1029–1037, registers both cleanup callbacks; `FinalQualifiedContinuityTests`, lines 1289–1294, aliases that setup and inherits the asynchronous case class.

## Verdict

**CHANGES REQUIRED** for the finding above. No other actionable defect found in this narrowly scoped checker review. Do not execute these current bytes. This does not reopen the R6 consumer implementation or prior operational-package approvals.

## Reviewed execution boundary and assertions

Read all 126 checker lines and the complete preparation report. Independently verified both supplied file digests and parsed the checker with `ast.parse`. Read relevant actual source imports/top-level behavior, fixture setup/fakes/seven-case method, runner injection/config/sampler/output paths, R6 need definition and pure validator call graph, and the configured Python 3.11 unittest lifecycle implementation. No reviewed code was loaded as a module or called.

The checker binds all four listed source files to the supplied exact 40-hex TIP and requires HEAD equality before source module execution. Compilation uses the already checked Python bytes. The final TIP remains a root-supplied future prerequisite; these checks do not themselves constitute source approval. The sampler is subsequently read from disk by the unchanged runner, so the declared quiescent-source requirement remains necessary.

The manifest SHA is fixed to R6 and every listed package entry is rehashed. Independently confirmed all 49 R6 entries currently match. The shim compiles only the pinned `prep_common.need` function, exposes `re`, and avoids executing the operational modules. The selected consumer paths use that shim and the unchanged passive helper's pure validators; the runtime loader and operational wrappers are not called. Synthetic modules use non-main names and an empty synthetic scripts package path.

For the inspected selected fixture, the actual runner receives the fake manager and exactly identified fake status method. The default live status function is replaced with a raising sentinel; the runner sees an empty password environment and the fixture's in-memory dotenv substitute. The audit hook is installed before source compilation and denies its specified subprocess, shell/spawn and network connect/bind/DNS operations; the import guard rejects the specified optional live dependencies. Runtime-config path reads are denied after capture registers that path. These guards supplement the reviewed fake code path; they are not a general hostile-code sandbox or a complete filesystem policy. The inspected path needs no live service, browser, Registry or build.

The capture wraps the actual runner and reads its actual persisted fake samples, summary and lifecycle before fixture cleanup. Each row goes through R6 ObservationGate, followed by terminal_valid with the actual fake manifest projection. Ordered case names, one accepted unchanged result, six rejected changed results, runner return codes, row bounds and 300-second continuity are asserted; the fixture's additional source assertions remain in the selected test method. No replacement PASS, shortened qualification, synthetic replacement row or count adjustment appears. Rejections are integration evidence for the actual failed artifacts, not a separate proof that every consumer predicate independently detects every final mutation. Actual acceptance and exact count compatibility remain unobserved until an authorized execution succeeds.

The checker has bounded own stdout result fields and suppresses exception details in its top-level failure path. Canary checks cover the inspected fake identity/password strings and config path in captured artifacts. The fixture's outputs are private temporary files. The claimed deterministic cleanup is currently broken by the finding and must not be inferred from process exit or garbage collection.

## Digests and limits

- Checker SHA256: `46b8972da42e656d545ca04fe4cd42b047a2656f9312958cb807acbdfc489fb0`
- Preparation report SHA256: `7c7141f95e2e6c580e9514098c66716aa985f0511c28c6157dd133155bd6e3cd`
- R6 manifest SHA256: `4b0ea13281c859ef38ac6ddb62a3bf3f642b3fba14abc61ef6993c0fda0d30b8` (49/49 entries matched)
- Inspected runner SHA256: `2aef30f8123e757dec2f29377cc43c8ad070ab213e40a254b41c4ffbe5cc0f9d`
- Inspected fixture SHA256: `71250c3b2bc04c94c68142c1d0557b1935410467f213de80929e1c11b4e587fa`
- Original passive helper SHA256: `b0a15095651c9147eb451b27eb815ec4ea4cc984f2d293d3617c4cee89a15426`
- Original sampler SHA256: `f862b739cbe7eb543ccab304203c71c62a43014530fa2da9a7655cba293665d3`

Only static reads/searches, hashes, AST inspection and this report write occurred. No tests/mocks, reviewed package imports/functions, operations, status/process inspection, network/browser/services/build, source/index mutations or subagents occurred. A later successful checker run would be offline seven-case producer/consumer evidence only; it cannot authorize live operations or establish real qualification, native-fault behavior, process-tree exit, or the remaining final source gates.
