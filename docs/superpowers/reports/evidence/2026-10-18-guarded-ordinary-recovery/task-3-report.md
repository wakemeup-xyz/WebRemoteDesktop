# Task 3 implementation report

Status: DONE. No commit or staging performed; source and index ownership handed back to root at final response.

## Implemented

Only the four assigned source paths changed:

- `signal-server/websocket/signaling.js`: existing identity-checked 8000ms grace callback invokes the existing removal once, then snapshots the resulting lease and best-effort emits `viewer_disconnect_grace_expired`. Its added observation is caught locally. The existing confirmed-rebind event gains the active lease epoch only after applied Host ACK, successful renewal, gate clearing and grant; ACK validation/order/authority remain intact.
- `signal-server/websocket/viewer-admission.integration.test.js`: logger injection and three tests exercise the actual registered grace callback with its existing fake scheduler, stale callback silence, resulting lease/map state despite throwing logger, and epoch/before-ACK barrier.
- `scripts/ordinary_session_recovery.py`: stdlib plus pure exports of unchanged `passive_session_soak`; no optional/browser/native imports. Implements `hash_identity`, `ServerRecoveryEvidence`, `HostContinuityObserver`, fixed `read_local_host_status`, and exact new-wrapper/private-sampler validation.
- `scripts/test_ordinary_session_recovery.py`: 27 pure tests; temporary local files and fake `asyncio.open_connection` only.

The log reader opens a regular no-symlink file read-only/nonblocking at current EOF; retains one descriptor and private device/inode/offset. It caps each tick at65536 bytes, partial/complete lines at16384 bytes (including newline for complete lines), and selected events at1024. It validates the actual current JSONL envelope and exact selected correlation/meta shapes, retains only allowlisted hashes/event projections, rejects selected malformation/rotation/truncation/capacity/time regression, and records incomplete coverage if closed with a partial line. Missing or malformed Host role fails closed; Host disconnect selection works before Viewer identity is known. Reset-only completion requires the preceding exact matched expiry epoch; a competing correlation or different pending expiry epoch fails coverage. Duplicate unbound reset completions are ignored.

Host observation stores only its private first validated ID plus bounded projection/state; replacement (including while offline), unavailable response/online=false, late/reversed/invalid tick, cap, and Host disconnect remain sticky. Changed status dominates later unavailable/same-ID observations. Fixed private `.reason` attributes carry existing finite reason codes; snapshots add no fields. Opened log `_device` and `_inode` remain private for Task4 manifest comparison.

HTTP sends the exact fixed GET to127.0.0.1:8080 with no credentials, arbitrary target, environment proxy, redirects, worker or thread. It enforces8192 header bytes/32 headers/1024 per line, JSON type, identity encoding, single bounded Content-Length, no Transfer-Encoding,16384 body bytes, strict UTF-8/duplicate-key JSON and required status types; unrelated fields are discarded. It uses `lifecycle_stage(owned_task,0.75,settlement=0.075)` with the full750ms total stage; writer close/wait are owned in its finally and limited to remaining stage deadline. Concurrent calls are refused. The private request reference is retained during a noncooperative cancellation (hard gate failure), and released when done so completed response IDs are not retained there.

Root clarification was applied: private identities are exactly `{sessionId,socketId,previousSocketId}`, null or1..128 valid UTF-8 strings; known stable session cannot change. Wrapper validation supplements the old additive validator with actual unchanged sampler/private-row exact keys, nested transport/metrics/gates/marks/diagnostic types and limits. Raw `attempt` is forbidden; only bounded `attemptHash` is accepted. Scope is fixed by scenario, and every wrapper remains<=32768 bytes.

## TDD and commands

Working directory for every command: `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`.

1. RED, actual predecessor server behavior, before editing signaling.js:

   `/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test --test-name-pattern='grace expiry observes|rebind evidence requires' signal-server/websocket/viewer-admission.integration.test.js`

   Exit1;3 tests,0 pass,3 fail;613.452988ms. Both expiry cases observed0 versus expected1; confirmed rebind epoch was undefined versus expected1. Captured in `task-3-node-red.log`. This invokes the existing registered timer callback, not a replacement implementation, using only the in-memory fake scheduler/Host ACK.

2. RED, before creating the new Python module:

   `/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest scripts.test_ordinary_session_recovery`

   Exit1; one loader error in0.000s, `ModuleNotFoundError: No module named 'scripts.ordinary_session_recovery'`; captured in `task-3-python-red.log`. The first13 behavior tests existed before implementation but could not import the absent API. This is an absent-module RED, not a claim of13 individually executed failures.

3. Initial Python implementation run:13 tests in1.706s, exit1 (one assertion failure/two errors). Tightened tests to expect terminal exceptions, corrected exact foreign-identity filtering, and used a new reader for the symlink startup fixture. Logs: `task-3-python-green-initial.log`. Next13-test run passed in1.700s (`task-3-python-green-second.log`). Expanded19-test matrix passed in2.492s (`task-3-python-expanded.log`).

4. Final scoped Python GREEN:

   `/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest scripts.test_ordinary_session_recovery`

   Exit0;27 tests in2.519s; `OK`, no warnings. Full output `task-3-python-green.log`.

5. Final scoped Node GREEN:

   `/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test signal-server/websocket/viewer-admission.integration.test.js`

   Exit0;29 tests/29 pass,0 fail/cancelled/skipped/todo;474.722304ms. Full output `task-3-node-green.log`. Existing fixture connection messages are expected; no runtime service was contacted.

6. `git diff --check`: exit0, no output. `git diff --cached --name-only`: exit0, empty; index untouched.

Coverage includes EOF exclusion, exact matching, deterministic hashes and raw-ID/path/token/URL/error canaries, duplicate/irrelevant reset events, matched expiry/reset and competing/ambiguous epochs, role=host alarm, selected/envelope malformation, rotation/truncation/symlink, partial lines/final incomplete partial, byte/line/event caps, strict wrapper/nested schemas and32768 row limit, status changed while offline, online bool/invalid/missed/late tick,12000 sample cap, same final Host ID after disconnect, unchanged final good Viewer owner/build/media/control gate fields after replacement/disconnect, fixed loopback request with proxy environment, redirects/HTTP/schema/duplicate length/content encoding/framing/header/body/UTF-8 limits, exact16384-byte body, timeout and cancellation before open/during read/during writer close, writer-close timeout, one outstanding request, and noncooperative cancellation remaining explicit with no retry. The noncooperative fake is explicitly released by its test after asserting the hard failure; it is never treated as successful cleanup.

## Self-review and integration boundaries

Read the complete added module/tests and focused server diff. Corrected production disconnect reason vocabulary to the actual `normalizeDisconnectReason` output, rejected null required epochs/state, prevented malformed unhashable selected values from escaping fixed errors, validated UTF-8 identity strings, bounded final partial coverage, and disallowed different pending expiry epochs. No grace/lease/reset/rebind/input/media/network/codec/replay policy changed. No other source path, dirty documentation, strict helper, sampler, SUP, node_modules or index was written.

Task4 owns actual sample+status concurrent2-second ticks, final1-second export, manifest comparison, status_reader injection into run, run result/classification and lifecycle composition. This task intentionally creates no second runner/qualification loop. Primitive Host tests retain sticky incomplete projection even with final good Viewer fields, but do not claim a live run or a Task4 `ordinaryRecovery` result. Current Signal has no structured generic Viewer-admission event; the primitive conservatively rejects foreign Viewer/session correlations observed during a pending reset. Task4 must also enforce unchanged owner/admission and Host gates; log evidence alone does not prove exclusive ownership. No service/status/API/network/browser/native/build/npm/install/broad test or live qualification ran. All business input/visible effect/physical acceptance remains NOT_RUN.

No unresolved implementation concern. Remaining integration and runtime acceptance are explicitly outside Task3. Root alone stages/commits and reviews before any runtime use.

## Fix round 1 — two Important review findings

Base: `710cf04ebac03787c360fc342737e7f591456118`. Read the full `task-3-review.md`. Status: DONE; the following fix evidence supersedes the original unresolved-concerns statement for the reviewed predecessor.

1. **One-shot log cursor.** `ServerRecoveryEvidence.start()` now requires status `not-started` (and no descriptor). A previously closed-complete, closed-incomplete or failed instance cannot reopen, seek past an intervening Host disconnect, or regain complete coverage. Rejected reuse closes nothing new and fails coverage; an existing first `server-log-gap` reason remains sticky. A separate run requires a fresh instance, which does not repair the old instance's gap. The tests retain the earlier selected event list and verify no descriptor is reopened.
2. **HTTP request ownership through wrapper settlement.** The primitive keeps its own `owned_task` local, passes that local to the unchanged750ms lifecycle stage, and clears the global slot only when the local child is done **and** the global slot still identifies that exact local task. Any occupied slot is refused, even if its child has already completed, until its wrapper's finally settles. Noncooperative cancellation still leaves the owned slot reserved and raises the unchanged hard gate error; no retry within the run becomes eligible. No HTTP budget, cancellation deadline, framing, cleanup or privacy rule was relaxed.

Added deterministic scheduling coverage pauses the lifecycle waiter **after the real child and writer close have finished, before the first wrapper resumes**. A second call must return only the fixed `host-observation-unavailable`, must not open a second connection, and must not replace ownership. Releasing or cancelling the paused first wrapper must yield its valid first result or CancelledError respectively, clear its own slot and leave no tasks. The fake uses events rather than sleeps/time races.

### Behavioral RED on unchanged predecessor implementation

Working directory: `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`.

Command:

`/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest scripts.test_ordinary_session_recovery.OneShotLogTests scripts.test_ordinary_session_recovery.SettlingHttpOwnershipTests`

Run after adding tests and before editing implementation. Exit1;3 test methods in0.088s;4 failures (two log methods plus the two completion/cancellation subcases). Full output: `task-3-fix1-red.log`.

Actual old-source failures:

- Closed-complete restart: `AssertionError: ValueError not raised`.
- Closed-incomplete restart: `AssertionError: ValueError not raised`.
- Both done-child/not-yet-settled overlap subcases: second call unexpectedly returned a valid Host projection; first result was `AttributeError("'NoneType' object has no attribute 'done'")`. This reproduced the reported ownership bug without network, real HTTP or artificial service behavior.

### One final affected-suite GREEN after final source/test edits

Command:

`/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest scripts.test_ordinary_session_recovery`

Exit0;30 tests in3.840s; `OK`; no warnings. Full output: `task-3-fix1-green.log`. Existing timeout/cancellation/noncooperation, bounds/schema/privacy and log/Host coverage tests remain green. No Node rerun: Signal/event sites were untouched by this fix round. `git diff --check`: exit0, no output.

### Scope and self-review

The complete focused diff was read after GREEN: only `scripts/ordinary_session_recovery.py` and `scripts/test_ordinary_session_recovery.py` changed, plus this permitted report/log append. The implementation diff changes only cursor reuse gating and HTTP task/slot ownership. No new output schema/status/reason or authority change. No staging, commit, index edit, other source edit, service/status/network/API/browser/native/build/npm/subagent operation. Existing dirty docs, strict helper, sampler, SUP, W2 and runtime state remain untouched.

The review's **Minor** transport frame-counter fractional typing finding is explicitly deferred/forwarded to Task4 by root's fix-round instruction; it remains unchanged in this focused round and is not claimed fixed. No unresolved Important finding remains. Source and index ownership handed back to root at final response; no further writes planned.

## Integration correction — direct rebind session correlation

Base: `550ec9f`. Read the complete `task-3-correlation-correction.md`, amended shared contracts, global constraints and existing report before edits. Status: DONE.

### Change and ownership boundary

At all three actual server observation sites (confirmed, cancelled failure, rejected/timeout failure), pass the existing local server-owned `sessionId` to the existing `emitControlEvent`; its unchanged mapping emits `browserSessionId`. Rebind correlation is now exactly `{viewerId,previousViewerId,browserSessionId}`. No lease/admission/reset/ACK/timer/event order or authority call changed; only the arguments to those three observations changed in Signal.

The log primitive validates the exact rebind correlation and bounded identity strings before matching. A directly logged rebind may retain a current viewer that the browser has not yet returned only when its logged session equals the already-known stable session and its previous viewer is in the caller's current/previous socket set. Its sessionHash comes from the logged `browserSessionId`; missing correlation is rejected, never inferred. Foreign session, unknown previous socket and unknown stable session cannot establish a transition. The direct rebind exception applies only to rebind event kinds (including the existing pending-reset competing-correlation check); the caller's socket identities remain unchanged. A subsequent different event for that new socket is still filtered until the browser itself observes it. Projected event schema and fixed failure reasons remain unchanged. Task4's generic failure classifier/WIP were not implemented or restored.

The one-shot cursor and owned local HTTP-task/slot fixes from3c41 remain unchanged, as do EOF/device/inode/caps/privacy/sticky Host coverage safeguards.

### Behavioral RED before implementation edits

Both commands ran from `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`, after adding/updating tests but before changing either implementation. They ran concurrently as independent scoped checks; no API/network/browser/service operation occurred.

1. `/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test signal-server/websocket/viewer-admission.integration.test.js`

   Exit1;32 tests,28 pass,4 fail;2308.956109ms. The success and all three failure-outcome cases reported actual correlation missing `browserSessionId`. Cancelled failure genuinely exercises the actual first failure branch: a same-ID Host object is connected through the handler while the active lease remains, then the old Host ACK reaches the object-identity guard. Rejected and timeout reach the other actual failure observation site. Full output: `task-3-correlation-node-red.log`.

2. `/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest scripts.test_ordinary_session_recovery`

   Exit1;35 test methods in4.881s;18 assertion/subtest failures and2 errors. Server-before-browser confirmed/failed rows were discarded; the actual new known-current correlation was rejected under the old two-key shape; missing/unknown matching correlation cases failed to reject. Full output: `task-3-correlation-python-red.log`. These are exercised behavior failures against the existing implementation, not import errors.

### Final scoped GREEN after implementation/test edits

1. `/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test signal-server/websocket/viewer-admission.integration.test.js`

   Exit0;32/32 pass;0 fail/cancelled/skipped/todo;2618.122531ms. Full output: `task-3-correlation-node-green.log`. Existing fixture connection output is expected.

2. `/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest scripts.test_ordinary_session_recovery`

   Exit0;35 tests in5.318s;`OK`. Full output: `task-3-correlation-python-green.log`. Output includes one asyncio debug slow-task scheduling diagnostic (`took 0.106 seconds`) during the existing fake HTTP request test; No tests failed. No timeout budget was widened and no warning was suppressed; no production work occurred. Both suites were run concurrently, so timings include shared scheduling load. This log is retained as actually produced.

3. `git diff --check`: exit0, no output. `git diff --cached --name-only`: empty; index untouched.

### Coverage and self-review

Node verifies direct session correlation on success only after the applied ACK and on all three existing failure reasons from both real handler branches. Failed rebinds remain REVOKING, never send a grant and clear their pending gate. Existing stale timer and post-ACK epoch tests remain passing.

Python adds five test methods covering server-before-browser ordering, exact direct session/viewer hashes, no implicit socket adoption for other event kinds, known-current direct session, all failure reasons, foreign session and unknown previous socket both with known and unknown current viewer, unknown stable session, missing/malformed selected correlation, unhashable malformed identities, exact unknown-field rejection and ID/path/URL/token privacy canaries. The older valid rebind fixture was updated to the actual three-field producer shape. Missing session and foreign session cannot borrow the coordinator's session hash. Existing30 primitive tests (including one-shot complete/incomplete close and deterministic done-child/wrapper ownership interleavings) remain passing.

Read the full focused source/test diff after edits. Only the four authorized source paths changed:

- `signal-server/websocket/signaling.js`
- `signal-server/websocket/viewer-admission.integration.test.js`
- `scripts/ordinary_session_recovery.py`
- `scripts/test_ordinary_session_recovery.py`

This permitted report/log append is the only additional artifact write. No source outside those paths, index, commits, Task4 WIP, dirty docs, strict helper, sampler, SUP, node_modules, W2, tunnel or runtime state was changed. No network/browser/build/services/npm/subagent work ran. No runtime/qualification claim is made; business input/visible effect/physical remain NOT_RUN. Minor fractional transport-counter typing remains deferred to Task4 by the prior ruling. No unresolved correction concern. Explicit source/index ownership handback occurs in the final response; no further writes planned.
