# Task 1 implementation report

Status: DONE. No staging or commits performed. Root owns integration, independent reviews, real-Registry parity and all operational work.

## Scope and source review

Created only the two requested implementation/test files:

- `scripts/process_observation_diagnostics.py`
- `scripts/test_process_observation_diagnostics.py`

Task evidence is confined to this SDD workspace: this report, `task-1-red.log`, and `task-1-green.log`. Read task brief, design, plan and progress ledger. At root's explicit direction, read `/tmp/wrd-owned-turn-probe-private/supervisor.py` lines 26–105 for the actual Registry interface; did not import or execute that file. The tests use a callback-dispatching fake base, not copied Registry logic.

No process API, real subprocess, network, browser, native input, service/status, build, install, runtime configuration or project runtime import was used. The immutable supervisor, primary checkout/index, existing dirty documents, dependencies, W2, tunnel/watch and old results were untouched.

## Actual TDD evidence

Working directory for both runs:

`/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`

Exact unittest command, unchanged between RED and GREEN:

```bash
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -B -m unittest discover -s scripts -p test_process_observation_diagnostics.py -v
```

The RED command was run after creating the test file and before creating the implementation module. Output was redirected to `task-1-red.log` in this workspace. Actual exit: **1**. Actual result: **1 loader test, 1 error**, `ModuleNotFoundError: No module named 'process_observation_diagnostics'`.

After implementation, the exact command was run once with output redirected to `task-1-green.log`. Actual exit: **0**. Actual result: **25 tests in 0.012s, OK**. No unrelated suite was run.

The tests include the core regression: forty state-context NoSuchProcess resolutions produce forty fixed stage counts and no event-pool pressure; a following direct scan failure remains the sole exceptional event and the following gap links to that event and scan ID.

## API and delegation

`Diagnostics(factory, supported, role, *, monotonic, wall, limit=32)` accepts an injected factory, an ordered three-class tuple `(NoSuchProcessClass, AccessDeniedClass, OSErrorClass)`, worker/sample role and two injected clocks. Construction calls neither the factory nor the clocks. Supported exception classification uses ordered `isinstance`, including subclasses/multiple inheritance; exception names and text do not determine classification.

Public methods/properties are `process(pid)`, `set_stage(stage)`, `context(name, *, registry=None, pid=None)`, read-only sticky `failed`, and detached `snapshot()`. The three coarse stages are `worker-loop`, `cleanup`, and `result`; the default stage is `worker-loop`. Invalid enum/clock/numeric metadata marks diagnostics failed and is not persisted verbatim.

`instrument_registry(registry_type, diagnostic)` constructs a generated subclass with `process=diagnostic.process`. It inherits initialization and all other logic and overrides exactly `state(pid)`, `scan()`, `signal(kind)`, and `note(reason)`. Each wrapper makes exactly one corresponding super call with the original argument and preserves its return or raised exception object. The note observer runs only after successful super delegation and cannot replace that return with a diagnostic failure.

The proxy exposes only `pid`, `create_time()`, `status()`, `children(recursive=False)`, `ppid()`, `terminate()`, and `kill()`. Each underlying requested read/call occurs once, with no eager process-property lookup. Factory-requested PID is known metadata; a child proxy begins with `pid=null` and `birth=null`. An actual create-time read may cache birth; an actual PID read may cache PID. Process return values remain unchanged except the necessary wrapping of the returned children list elements. The registry parameter is reserved context metadata and is not dereferenced; no ledger identity is inferred or copied.

Delegated exceptions are re-raised with bare `raise`, preserving object identity. Diagnostic failures set sticky `failed` and never replace those business exceptions. Unsupported exception classes are retained only as the fixed `Unsupported` classification, set `failed`, and propagate unchanged.

## Schema 2 and bounds

Snapshot top-level fields:

| Field | Meaning |
|---|---|
| `schemaVersion` | fixed integer `2` |
| `scope` | fixed `diagnostic-only` |
| `role` | `worker` or `sample`; null on invalid input with failure |
| `events` | retained exceptional-event pool |
| `dropped` | saturated count of exceptional events lost to pool capacity |
| `failed` | sticky diagnostic failure; consumers must retain the existing veto |
| `expectedStateExitCounts` | exactly the three coarse-stage keys |
| `gaps` | retained observation-unavailable notes, including explicitly unassociated records |
| `gapsDropped` | saturated count of gaps lost to pool capacity |
| `overflow` | fixed booleans `events`, `gaps`, `contexts`, `counters` |
| `limits` | event/gap pool limits, contextDepth `8`, counter `2147483647` |

Events contain `eventId`, `scanId`, `role`, `stage`, `context`, `operation`, `pid`, `birth`, canonical `exception`, numeric-or-null `errno`, `monotonic` and `wall`. Context is state/scan/signal/outside. Operations are resolve/pid/create_time/status/children/ppid/terminate/kill. No raw exception messages, arbitrary class names, argv, environment, passwords, tokens, inputs or coordinates are formatted or retained.

Gaps contain `scanId`, `eventId`, association `direct-scan-error` or `unassociated`, fixed reason `observation-unavailable`, role, stage and both clocks. Only a direct scan-context error can create a pending token. Nested state errors cannot create, consume or overwrite an outer scan token. Each observation-unavailable note consumes a direct token at most once; other fixed reasons leave it intact. A newer dropped scan error invalidates the previous pending token, preventing linkage to an earlier retained error. Scan entry/exit and reentrancy retain separate frame ownership and finally restoration. A gap without a matching token retains null event ID and explicit unassociated status; no timing inference occurs.

Both retained pools have maximum capacity 32; `limit` may reduce it to 1–32. Context storage never exceeds eight frames; deeper scopes disable attribution and set failure instead of inheriting a misleading state context. All diagnostic counters saturate at 2147483647. Exhausted event/scan sequences yield null IDs instead of reusing saturated IDs for linkage. Capacity loss, context overflow, counter overflow and recorder errors are visible and fail diagnostics.

The full-pool fixture fills 32 event and 32 gap slots, drops eight of each, asserts their exact drop counts and overflow/failure flags, and asserts UTF-8 serialized JSON is below 32768 bytes for that fixture. This is a fixture-size assertion, not a new operational file cap or a universal byte cap. Separate tests verify context and counter overflow flags, enum/privacy canaries, strict JSON serialization without NaN, and detached event/gap/counter snapshots. Existing operational caps were not changed.

## Self-review and remaining work

Read both complete two-file `git diff --no-index -- /dev/null <file>` outputs after GREEN. Checked imports (contextlib/copy/math only in production module), every proxy delegation, exact Registry wrapper signatures, canonical metadata fields, pending-token invalidation, finally restoration, fixed pools/counters and exception-identity rethrows. No stack inspection, general attribute forwarding, process discovery, psutil import or Registry logic copy is present.

Pure tests establish the fake base's delegation contract and the diagnostic behavior. **Real immutable Registry parity is NOT RUN and is not claimed.** Root must separately hash-pin this exact module and run the planned pure producer/consumer parity schedules against the actual immutable Registry before any fresh live attempt. This increment performs no deployment, no live acceptance and no reassessment of either prior failed baseline. Full process-tree exit remains UNKNOWN; every unexplained observation-unavailable reason remains disqualifying.

Return contract: **DONE**; no implementation blocker. The required independent task/final reviews and real-Registry parity remain root-owned next steps.

## Fix round 1 — reentrant callback pool commitment

Status: DONE against source base `2ccb4ce`. Reviewed the Important finding in `/tmp/wrd-process-observation-context-task-review-20261018.md`. Scope remains the same two Python source paths and this SDD report/log workspace. No staging, commits, runtime actions, service operations, other suites or real-Registry parity were performed.

The original code checked a pool's capacity before invoking clocks, then appended after the callbacks returned. An injected clock could reenter the recorder, fill the final available slot, and let the outer append create record 33 without an overflow veto. Both new boundary regressions reproduced **33 != 32** before changing production code.

The fix reserves a complete finite record shape and commits its pool slot before invoking exception-metadata or clock callbacks. For events, it also commits the pending token before callbacks. Completion only fills the reserved record's nullable fields; it does not append again or reset the pending token. A retained newer nested direct scan error therefore keeps its newer pending token. A nested error dropped at capacity clears the outer token, so a subsequent gap is explicitly unassociated rather than falsely linked to the older retained event. Gaps consume their pending token once and reserve their slot before clocks, so nested gap notes cannot claim that token or overfill the pool.

During callback execution a reserved event has the existing schema with nullable `errno`, `monotonic` and `wall`; a reserved gap has nullable `monotonic` and `wall`. A small boolean guard is restored in finally across callback nesting. If a callback requests `snapshot()` before completion, the snapshot operation sets **sticky failed=true** and returns a detached JSON-safe finite shape containing the reserved record. It does not present incomplete clock observations as successful diagnostics. Later clock completion updates only the internal record; the captured snapshot remains detached with its null fields, and failed remains true. No schema fields or operational byte caps were added.

Four new tests cover the fix:

- `test_reentrant_clock_event_boundary_preserves_bound_and_invalidates_lost_token`: begin with 31 events; nested supported failure is dropped after the outer reserves slot 32; exact drop/overflow/failure and unassociated gap are checked.
- `test_reentrant_clock_gap_boundary_preserves_bound_and_consumes_token_once`: begin with 31 gaps; outer linked gap reserves slot 32; nested and repeated gaps drop, preserving one-time token consumption and exact drop count.
- `test_reentrant_clock_newer_direct_scan_error_keeps_pending_token`: without overflow, retained events remain ordered outer then nested, both business exceptions preserve object identity, and the following gap links to the newer nested event while failed remains false.
- `test_reentrant_clock_snapshot_of_reserved_event_or_gap_fails_closed`: both pool variants validate the nested snapshot's reserved nullable shape using strict JSON serialization, sticky failure, later internal clock completion, and snapshot detachment. Assertions about captured snapshots run after callbacks return.

All commands below ran in the worktree directory documented above, before/after the production fix as indicated; stdout/stderr were redirected to the named log in this SDD workspace.

Initial boundary RED, before the production fix:

```bash
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -B -m unittest discover -s scripts -p test_process_observation_diagnostics.py -k reentrant_clock -v
```

`task-1-fix1-red.log`: exit **1**, **2 tests in 0.003s**, **2 failures**, each reporting **33 != 32**. This run contained only the two boundary tests then present.

After adding the snapshot boundary, the same exact RED command was run again before the production fix. `task-1-fix1-red-inflight.log`: exit **1**, **3 tests in 0.007s**, **4 failures** (the two bounds plus event/gap snapshot subtests). Snapshot assertions were then moved outside the callback so the captured failed flag was checked directly rather than testing through the clock exception guard. The dedicated pre-fix command was:

```bash
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -B -m unittest discover -s scripts -p test_process_observation_diagnostics.py -k reentrant_clock_snapshot -v
```

`task-1-fix1-red-snapshot.log`: exit **1**, **1 test in 0.003s**, **2 subtest failures**, each **False is not true** for the captured snapshot's failed flag.

Scoped GREEN after the production fix:

```bash
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -B -m unittest discover -s scripts -p test_process_observation_diagnostics.py -k reentrant_clock -k bounded_pools -k pending_token -k nested_state -k lost_scan_event -k counter_saturation -k clock_exceptions -k invalid_clocks -k context_restoration -k expected_exit_flood -k snapshot_is_detached -k context_depth -k recorder_failure -v
```

`task-1-fix1-green.log`: exit **0**, **16 tests in 0.016s, OK**. Exact executed names appear in the log: the three reentrant tests then present plus bounded pools, clock exceptions, context depth/restoration, counter saturation, expected-exit flood, invalid clocks, lost scan event, nested scan/state tokens, pending-token consumption, recorder failure and detached snapshot tests.

After adding the final retained-newer-token regression, its focused command was:

```bash
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -B -m unittest discover -s scripts -p test_process_observation_diagnostics.py -k reentrant_clock_newer_direct_scan_error -v
```

`task-1-fix1-green-token.log`: exit **0**, **1 test in 0.002s, OK**.

Root then explicitly authorized one full run of this pure unit file because the core record commitment path changed. Final command on the final revision:

```bash
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -B -m unittest discover -s scripts -p test_process_observation_diagnostics.py -v
```

`task-1-fix1-green-full.log`: exit **0**, **29 tests in 0.077s, OK**. This final count is the original **25** plus the **4** new tests; no other suite was run.

Read the complete scoped `2ccb4ce` diff for both source paths after final GREEN. The source change only moves record commitment ahead of callbacks, restores the recording guard in finally, and fails closed for snapshots of incomplete reserved records. Existing Registry super calls and delegated process calls/returns/exception identity remain covered and unchanged. Real immutable Registry parity is still **NOT RUN**, and all prior operational limitations and root-owned reviews remain in force.

Fix return contract: **DONE**, no unresolved implementation concern; ready for scoped independent rereview.
