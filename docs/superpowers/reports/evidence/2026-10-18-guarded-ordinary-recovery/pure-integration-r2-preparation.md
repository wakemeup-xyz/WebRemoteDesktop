# Private pure collector checker R2 — scoped lifecycle fix, NOT EXECUTED

Prepared 2026-10-18. Root must read the complete R2 script and this report, then obtain independent scoped review before any execution. Actual Task5 source is finished but unreviewed; the final reviewed combined TIP remains pending. This preparation grants no execution or operational permission.

New files only:

- `/tmp/wrd-pure-collector-integration-20261018-r2.py`: 127 lines, mode0600, SHA256 `3d3236e222989b9fe582c890d0cc2d674542af97cd3beba7ebf72c09f21da0e8`.
- This focused preparation report, mode0600.

Read the complete independent review `/tmp/wrd-pure-collector-integration-independent-review-20261018.md`, SHA256 `57eb27523001a57aeff2c0ea8226f44b71d7adfbfde6321fba0f4c53c2ae0655`. Its P1 is valid: direct calls did not initialize IsolatedAsyncioTestCase._asyncioRunner, so the registered cleanups could not execute through the official async cleanup dispatcher. No original checker run was performed.

The only executable changes are one stdlib TestResult import and replacement of the direct setUp/asyncio.run/doCleanups block by `case.run(result)` with a silent explicit TestResult. R2 requires exactly one test, result.wasSuccessful(), and no errors, failures, skipped cases, expected failures or unexpected successes. The official selected-case lifecycle owns async-runner initialization/closure, setup, teardown, registered cleanups and partial-setup failure cleanup. No discovered or broader suite is selected. Existing module/import/runner/status/environment patches and audit guard remain active across the complete case.run lifecycle and result checks. Cleanup errors remain visible in TestResult and reject success.

All other bytes are preserved, including source HEAD/TIP/Git-blob checks, fixed R6 manifest/full-entry checks, passive helper pin, scoped compiled module mapping and exact need shim, actual runner/writer capture, fake injection checks, runtime-config read deny, network/process/optional-dependency deny guards, unchanged seven-case fixture method and ordered names,300-second duration/count assertions, actual rows/summary/lifecycle passed to R6, one acceptance/six rejections, canary checks and bounded output. A static reverse transformation independently reproduced the original script bytes exactly; AST parsing of R2 succeeded. No reviewed module was imported or called, and no executable test/mock or checker run occurred.

The original script and report remain byte-for-byte unchanged:

- Original script SHA256: `46b8972da42e656d545ca04fe4cd42b047a2656f9312958cb807acbdfc489fb0`.
- Original preparation report SHA256: `7c7141f95e2e6c580e9514098c66716aa985f0511c28c6157dd133155bd6e3cd`.

R2 supersedes the original report's direct-invocation/cleanup description. The original checker remains rejected and must not execute. Other original report boundaries/dependencies remain applicable: stdlib Python3.11 with -B, /usr/bin/git for initial read-only binding, quiescent final source, unchanged fake fixtures/helper/sampler, immutable R6 package, private fixture-owned temporary artifacts with official cleanup, no sys.path/PYTHONPATH/environment mutation or source/index/primary writes. The guards supplement the reviewed fake path; they are not a hostile-code sandbox. Fake integration success would establish only offline seven-case producer/consumer evidence, never live qualification, real browser/media/control/native behavior or process-tree exit. No acceptance/count/execution receipt is asserted now.

After final source approval and full root/independent R2 review, the intended command is below. Root must replace FINAL_REVIEWED_40_HEX_TIP with the actual approved immutable40hex value, never a shell-computed HEAD. This is not current authorization:

```sh
cd /Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -B /tmp/wrd-pure-collector-integration-20261018-r2.py --tip FINAL_REVIEWED_40_HEX_TIP --r6-manifest-sha256 4b0ea13281c859ef38ac6ddb62a3bf3f642b3fba14abc61ef6993c0fda0d30b8
```

The R6 binding is unchanged at `4b0ea13281c859ef38ac6ddb62a3bf3f642b3fba14abc61ef6993c0fda0d30b8`. Prior source hashes remain inspected Task4 reference evidence only; no new Task5 source review or approval was attempted. Root owns review, any later execution/evidence retention and eventual removal of these private /tmp outputs. The preparer performed only static reads, hashes, AST/string comparison and the two new specified /tmp writes; no source/index write, imports of reviewed code, runtime functions, mocks/tests, process inspection/control, status/network/browser/service/tunnel/build action or subagent occurred.
