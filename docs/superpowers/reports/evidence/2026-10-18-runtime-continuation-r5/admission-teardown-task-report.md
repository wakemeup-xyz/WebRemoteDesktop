# Task1 implementation report

Base: c54a352. Allowed implementation completed in this worktree only; root owns review, staging, commits and runtime. No index/commits, operational imports, browser/network/native/service/process actions or primary edits were performed. Existing failed R5 is unchanged and receives no credit.

The owned lifecycle now binds one optional admission-detach callback, runs it after final export even on failure, then independently closes browser and stops manager. It uses the existing export allowance and lifecycle_stage on the original cleanup deadline. Existing schema, capture semantics, failure priority, caps (8s total / 1s export-detach / 5s close / 3s stop reservation), cancellation settlement and process-exit evidence are preserved.

Tests strengthen the shared fake subscription boundary to reject removal after stop and reuse the actual full 300-second reducer fixture/scheduling clock. Success ordering, detach/export failure, retained earlier failure, repeated cancellation, async timeout/idempotence and no-guard partial-start coverage pass.

## Commands and evidence

### red

Command: `/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -B -m unittest scripts.test_ordinary_session_recovery.FinalQualifiedContinuityTests.test_fully_qualified_baseline_final_export_must_keep_continuity`

Exit 1; 1 test in 10.634s. One actual behavior failure: unchanged qualified baseline returned 1 instead of 0. Eight additional ordering assertion errors arise because the strict fake rejects removal after manager stop before recording detach; these are secondary errors, not eight independent behavior failures.

Log: `task-1-red.log`; SHA256 `d64aef4fd7fdaf91e2b23c74cdde08ada4c195e8e707d941fae3be456175fd3d`. Timing is unittest-reported elapsed wall time.

### green

Command: `/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -B -m unittest scripts.test_ordinary_session_recovery.FinalQualifiedContinuityTests scripts.test_ordinary_session_recovery.RuntimeRunTests.test_repeated_cancel_keeps_one_cleanup_coordinator_and_original_deadline scripts.test_ordinary_session_recovery.RuntimeRunTests.test_detach_failure_preserves_prior_failure_and_stops_once scripts.test_ordinary_session_recovery.LifecycleTests`

Exit 0; 8 tests in 9.961s; all passed.

Log: `task-1-green.log`; SHA256 `e586ba9efad99ef1b7ef08fbc189ed265bea38a3318ec4bcedf7522eeb6c6ad7`. Timing is unittest-reported elapsed wall time.

### affected

Command: `/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -B -m unittest scripts.test_ordinary_session_recovery scripts.test_ordinary_recovery_fault scripts.test_passive_session_soak`

Exit 0; 166 tests in 37.357s; all passed. Affected suites executed once.

Log: `task-1-affected.log`; SHA256 `191cf7de4a0c51015ad9cb77082168edd2b9735d64ac6a1ff2b0dd37a70ad633`. Timing is unittest-reported elapsed wall time.

Intermediate expanded covering run: exit1, 8 tests in 10.074s, one test expectation incorrectly assumed successful final capture after the existing human-priority poisoned observation. Removed that assertion; full qualified detach-failure case separately proves successful capture remains ok. This is a test expectation adjustment, not production RED. Retained log `task-1-fixture-adjustment.log`, SHA256 `993600335238693dbf481f96b93aafe5bbefdec9a64ad84aa5d41aae9c630d6c`.

`git diff --check -- scripts/ordinary_session_recovery.py scripts/test_ordinary_session_recovery.py`: exit0.

## Exact modified source files

- scripts/ordinary_session_recovery.py
- scripts/test_ordinary_session_recovery.py

Task report and task-1 logs are additional evidence files under this task workspace. Pre-existing dirty documents and node_modules symlink were not modified. No runtime acceptance is claimed; native/business/visible/physical remain NOT_RUN and schema/input metrics unchanged.
