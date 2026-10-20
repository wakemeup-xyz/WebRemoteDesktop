# Task 1 implementation report

Status: DONE; ready for independent controller review. No live run performed.

Read task brief, binding owned-turn-long spec/plan Global Constraints and /tmp/wrd-owned-turn-probe-review.md before edits. Only private supervisor/tests and this report edited; no repository source/index/commit/service changes.

## Changes

- CLI requires explicit positive --host-pid; both existing PID files and process birth validation retained. Duration choices are exactly 300 and 10800; direct execute also rejects invalid duration/PID.
- Original hash-pinned helper receives selected duration unchanged; worker cap is duration+300. Relay/origin restrictions and original helper/proof/artifact ownership untouched.
- Short threshold remains >2000ms; long threshold is >=5000ms, one latched attempt from complete finite numeric helper rows. Invalid/null/bool/NaN ignored. Host snapshot recheck precedes sample.
- Preflight records kind, duration, cap, threshold/comparison; final repeats mode metadata and sampleTriggered (true only if sample Popen returned). Original artifacts remain untouched.
- Existing cleanup, identity checks, sample limits/output budgets and no complete-tree-exit claim preserved.
- P3 fixtures now stay under private root with explicit 0600. Added fake execute tests for exact sample argv/DEVNULL/session/limits hook and 10-second external sample timeout reached while worker cleanup is active; mock RLIMIT verifies both 8MiB file limits and zero core.

## Validation

Initial RED: threshold mode and positive PID tests failed against prior implementation (2 errors, 13 tests). Final command: python3 -B /tmp/wrd-owned-turn-probe-private/test_supervisor.py — 16 tests PASS in 1.001s.

Includes prior 10 regressions, both duration forwarding and cap branches, required/positive PID and arbitrary duration rejection, matching/mismatching PID files, long 4999/5000 boundary and single latch, short 2000/2001 boundary, sample timeout during cleanup, RLIMIT, private fixture file permissions, original helper artifact preservation. Only real process created/terminated was the original directly owned harmless sleeping Python child. All supervisor execute cases use fake Popen/process/clock. No live browser/network/Host sample/input/service/install actions.

## Exact SHA256

- supervisor.py: 4d96c8b0cbd9ae21056f02741e7193db82e7659e2a0e416583c65af7bfcb0492
- test_supervisor.py: 213781bdbaf7ea90489426be7501874e4709d10cb6ea6b8e1452c53763a274a0
- Production helper pin unchanged: 2dfc5ee1e669c7f60662eb4b8cd17c1596bc146d3641845cfb12fd55d98592ed
- Production sampler pin unchanged: b47bfa435806b1c30a15e6d743f594f70ba17a4b73cbe10e6230ab36e9d53594

Self-review: no new blocker identified. SampleTriggered describes actual process creation, whereas sampleTrigger describes the latched observed row (including Host refusal). Live macOS sample behavior, actual three-hour continuity and complete process-tree exit remain NOT RUN/unproven. Existing polling omissions, scheduling latency, check-to-signal race and startup-before-row coverage limits remain unchanged. Controller owns independent review and any future live invocation.
