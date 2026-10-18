# Task 1 report: zero-Viewer cleanup ordering

Status: DONE_WITH_CONCERNS (source complete; minor test-runner sequencing deviation recorded below). Independent concurrency review remains root-owned.

## Baseline, commit and ownership

- Worktree: `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`.
- TaskBASE: `a45d6cd4b1a7ed9ab751ae9959f09ec6df32d109` (verified before editing).
- Owned commit: `58fd7af64c97b7a77ad307bc51fd039b37a31022`, `fix(host): order zero-viewer cleanup after trusted reset`.
- Exactly two committed paths: `python-host/host.py` and `python-host/test_control_transition_status_ordering.py`.
- Host diff: 36 inserted / 6 removed lines, entirely within `on_viewer_status`. New test file: 587 lines, 15 unittest methods plus deterministic subcases.
- The four preexisting dirty docs and untracked `signal-server/node_modules` remain present and unstaged. Final index empty; both owned paths pristine against HEAD.
- Source/index ownership is returned to root with this report. No subagents or reviewers dispatched.

## Behavior implemented

Zero-Viewer status captures its entry Signal generation, immutable complete authority tuple and exact operation before its first await, obtains the same lazy `_control_transition_lock` used by control transitions, and keeps that lock across the decision and fallback cleanup. Its first action inside the lock rejects stale Signal/full-authority callbacks.

It coalesces only a valid positive-integer three-tuple pending reset that has become the same applied reset while the Signal/full authority still match, active binding and current Viewer are exactly None, and all eight resource references are exactly None: `relay_streamer`, `pc`, `screen_track`, `video_sender`, `_input_datachannel`, `_input_move_datachannel`, `media_sender`, `capture_adapter`. Missing legacy attributes count as absent; falsey present objects do not. Coalescing retains the overlay update.

Current-scope fallback captures the relay locally, preserves the original `if relay` stop condition, and rechecks Signal/full authority after the relay await before closing current resources. Ordinary errors retain the prior logging path; cancellation propagates and releases the lock. Positive status retains its prior overlay path.

No changes to authority helpers, reset, ACK emission, peer cleanup, offer, disconnect, Signal, diagnostics, input adapters, policy, timers, retry, media quality or encoding.

## Actual predecessor behavioral RED

Working directory: worktree `python-host`.

```sh
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest test_control_transition_status_ordering.StatusOrderingTest.test_detached_peer_reset_gets_first_applied_ack_after_both_resources_return
```

The new test ran against the unmodified TaskBASE Host. The actual trusted reset detached old PC and waited in its close. Zero-Viewer status then performed another cleanup. After old PC close and track shutdown both returned, the expected first applied ACK was absent:

```text
FAIL: test_detached_peer_reset_gets_first_applied_ack_after_both_resources_return
AssertionError: Lists differ: [] != [{'leaseEpoch': 8, 'status': 'applied'}]
Ran 1 test in 0.325s
FAILED (failures=1)
```

Child exit: 1. This is the behavioral RED, asserting first-ACK outcome rather than a helper name or source text. No retry or timer was used to obtain the outcome.

## Setup mistakes and iteration, excluded from RED

1. The first test-file creation command used `python-host/test_control_transition_status_ordering.py` while already in `python-host`. The shell reported no such directory; the following unittest import failed. Corrected the path. This was setup failure, not behavioral RED.
2. An expanded cancellation case attached a gate as `peer_gate` instead of the fixture's `pc_gate`. Its event therefore never entered. Interrupted only that launched test run; it completed 34 tests with one cancellation error in 43.528s, exit 1. Corrected the fixture mapping and replaced unbounded expected-stage waits with a one-event-loop-turn assertion so a missing gate fails promptly. This was a test fixture error, not a product failure or another RED.
3. Initial fixture parsing inside the asynchronous test caused an asyncio slow-callback diagnostic in the one-test RED and first one-test GREEN. Source extraction/compilation now happens once at module load, with a fresh namespace for each fixture. No source method bodies are edited. Final runs below have pristine unittest output.

A subsequent scoped run before the final bounded-output refinements passed 34 tests in 7.648s, exit 0. These are overlapping executions, not extra coverage to add to final counts.

## Final GREEN and verification

All final source/test edits were complete before these commands. Working directory: worktree `python-host`.

Focused command:

```sh
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest test_control_transition_status_ordering test_peer_cleanup_observation
```

Complete combined child output:

```text
..................................
----------------------------------------------------------------------
Ran 34 tests in 9.369s

OK
```

Child exit: 0. No warnings, tracebacks or extra diagnostic lines.

Required affected command, run exactly once after final edits:

```sh
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest test_control_transition_status_ordering test_peer_cleanup_observation test_capture_resource_owner test_capture_shutdown_contract test_capture_cadence test_capture_observation test_runtime_observability
```

Complete combined child output:

```text
......................................................................................................................
----------------------------------------------------------------------
Ran 118 tests in 17.331s

OK
```

Child exit: 0. No warnings, tracebacks or extra diagnostic lines. The current affected total is 118; the predecessor 103 remains historical, with 15 new unittest methods. Do not add the 34 focused tests or earlier overlapping runs to this total.

Test-runner sequencing deviation: the focused exec yielded a running-session handle at its 10-second output boundary; the affected command was then started before that focused session was reaped. Both child processes subsequently completed successfully, and may have briefly overlapped. These suites are pure and did not mutate source/runtime, but the ideal sequence would reap the focused child before starting the affected child. The required affected set was not repeated.

Additional checks, exit 0:

- `git diff --check` and `git diff --cached --check`.
- AST comparison with TaskBASE proved `on_viewer_status` was the only changed Host method and all other module/class AST bodies were identical.
- Exact staged-path assertion before commit allowed only the two owned files.
- Post-commit `git diff --exit-code HEAD -- python-host/host.py python-host/test_control_transition_status_ordering.py` and `git diff --cached --exit-code`.

## Behavioral coverage

- Observed detached-PC race: first applied ACK appears once, only after both old PC and track return; single native reset, PC close, track shutdown; unchanged captured authority; no retry/timer; overlay retained.
- Earlier trusted-reset relay-stop and native-reset waits: status waits, resources close once and the first ACK survives.
- Every full authority binding field is mutated in place while status waits: Viewer, lease ID, epoch, attempt ID, attempt sequence, connection generation; also authority revision and Signal generation independently fence stale callbacks.
- Actual disconnect, direct superseding cleanup and authority replacement suppress old ACK; old PC/track still close once; replacement PC/track/relay survive. Existing peer-cleanup overlap suite remains unchanged.
- Each of eight present resources is tested both truthy and falsey; each forces fallback. Falsey relay preserves the original skip-stop operational guard.
- Invalid/malformed/zero/boolean/negative epochs, wrong operation tuple shape/kind/outcome and different applied epoch do not coalesce. Empty binding dict and falsey Viewer ID also prevent coalescing. Missing legacy attributes can coalesce.
- Native reset rejection, native exception and PC-close exception produce only rejected ACK and current-scope fallback; no false applied ACK.
- Cancellation during relay stop, native reset, detached PC close and track shutdown allows current-scope fallback without false applied ACK. Detached cancelled releases retain honest cancellation/unknown facts and do not get counted as successful resource return.
- Ordinary zero and positive counts, overlay payloads and lock laziness; already-applied operation at status entry still uses ordinary cleanup.
- Grant in flight publishes binding under the same barrier; waiting stale status cannot tear it down.
- Signal/revision/attempt replacement during fallback relay stop preserves all replacement resources.
- Fallback relay/native errors retain logging; fallback relay/native cancellation and cancellation while waiting release their owned locks and propagate cancellation.

## Self-review

Completeness: all required orchestration paths and exact absence predicates are represented. Actual Host AST methods include the specified transitions/status/cleanup plus real authority, native-reset, binding and disconnect orchestration. Fakes cover logger/SIO/overlay, input reset, queue, relay, PC and track; output stores are bounded. Pure `PeerCleanupObservation` is imported directly. No AST decisions are replaced.

Quality: code reuses the existing lock and fences, has no new public API/background work, and makes success depend on the actual completed reset operation plus resource absence. Presence checks use `is None`. Relay stop ownership is local. Error/cancellation semantics remain explicit. The extensive tests use deterministic asyncio event gates, no timing sleeps or retry assumptions.

Discipline: only the two owned paths were staged/committed; no unrelated files were modified by this worker. The git-commit skill was read/applied for the conventional owned commit. No subagents, broad npm/pretest/install operations, Host/native imports, real native threads/sockets/subprocess tests, wall-clock sleeps, business input, browser/network/service/primary/proof/tunnel/watcher operations occurred. Shell child processes only ran the authorized Python unit suites and source/Git/file verification.

Testing: valid predecessor behavioral RED is distinct from both setup mistakes. Final focused and affected suites passed with pristine output and exit 0. The affected set ran once after final edits. Minor runner overlap is disclosed above.

Concerns: no known remaining source defect from self-review. The two setup mistakes are fixed. Brief possible test-process overlap is a process deviation, not evidence of a runtime defect. Independent concurrency review is pending under root. Runtime behavior remains unqualified by this source-only task.

## Scope and operational limits

No services were loaded, restarted, queried or changed; no deployment occurred. Production remains the old Host c239482/e5927c7 (PID76982) and Signal45287/build79 as stated by the handoff, without this worker independently querying them. The source correction does not establish the initiating WS1006 cause, prove ordinary recovery/native input, or qualify a real long session. Code loaded, actual first reset ACK, ordinary rebind and physical/visible input remain separate future acceptance work.
