# I2 first signaling close observer implementation

Date: 2026-10-17 (Asia/Shanghai).
Implementation commit: `10d4146b274f6ac761fafa413b44eebf643ff282` (`feat(acceptance): observe first signaling close and cleanup lifecycle`).
Starting implementation base: `1772a5156078aa1f80a466c4bc28970fcd0f3883`; the independent M6 tooltip correction `966890b83521915721f9e2a64c28a2b402062082` landed while I2 temporarily released the index. That correction is outside I2 ownership.

## Changes and preserved contracts

Only four implementation/test files changed: `scripts/passive_session_sampler.js`, `scripts/passive_session_soak.py`, `scripts/passive-session-sampler.test.js`, and `scripts/test_passive_session_soak.py`.

The actual browser sampler now passively enrolls the existing Socket, Manager, and current Engine.IO object, observes fixed lifecycle and heartbeat event types, and retains a 128-event ring plus a separately preserved first terminal event. It emits run-local labels, exact currentness booleans, allowlisted reasons, fixed counters and browser state; it never reads real socket/engine IDs, packet payloads, arbitrary error messages, descriptions, addresses or URLs. A copied old-object callback remains observable with currentness false. The observer uses one cancellable 1s scheduler and at most 16 events per sample delta. Stop removes exact own callbacks, DOM listeners, scheduler, rVFC and relay load listeners, and permits a sanitized snapshot without reenrollment. The final browser operation scans existing references, appends preclose, snapshots and stops in one evaluate.

Python validates every observer key/type/enum, integer bound, event order, cursor/gap/truncation metadata and allocation before persistence. Both initial artifacts precede manager construction/start, both preliminary artifacts precede browser.close, and outer-finally replacement follows manager teardown. Initial and replacement files use exclusive 0600 creation, a 0700 output directory and same-directory atomic replacement. Samples reserve two 32768-byte final files within the existing 64MiB logical run budget. File and envelope caps count compact ASCII bytes, including event-key envelope punctuation.

The same single admission, authenticated UI login and exactly one normal Start remain in force. The observer installs after login and before Start. First disconnected sample or identity change still ends strict continuity; original failure/cancellation survives subsequent teardown failure. Heartbeat created/flush observations make no wire-delivery, remote acknowledgement or RTT claim. Cause remains unknown. Active control and visible effect remain NOT_RUN.

Manager start is capped at 10s and launch at 15s. One cleanup coordinator uses a total 8s monotonic allowance, with export at most 1s, browser.close at most 3s, and manager stop at most 3s; cancellation settlement uses the same remaining allowance. Synchronous final evidence attempts still execute after asynchronous cleanup. API outcomes and owned-process exit proof are distinct; ownedProcessExitEvidence is always not-observed in this implementation.

## RED / GREEN validation

RED before implementation:

- `node --test scripts/passive-session-sampler.test.js`: exit 1, 10 passed / 1 failed; new diagnosticSnapshot API assertion reported undefined.
- `python3 -m unittest scripts.test_passive_session_soak.LifecycleSchemaTest`: exit 1; new initial schema test reported missing empty_diagnostic.

Final GREEN after all implementation changes, run without browser/network/native/service operations:

- `node --test scripts/passive-session-sampler.test.js`: exit 0, 20 passed, 0 failed.
- `python3 -m unittest scripts.test_passive_session_soak`: exit 0, 39 tests passed.
- `python3 -m py_compile scripts/passive_session_soak.py`: exit 0.
- `git diff --check`: exit 0.

The JavaScript tests execute the real sampler source in VM fixtures using fake EventEmitters, fake DOM targets and a fake monotonic clock/timer. They cover reason and typed-error normalization, throwing payload/message getters, heartbeat sequence semantics, product-first replacement, copied callbacks, exact listener removal, absent APIs, ring flooding/eviction, binding capacity, schema byte maxima, scheduler suspension, wall-clock jumps, lifecycle state and idempotent stop. The Python tests include real run/finalizer paths for manager entry/start, launch, export, close and stop errors/deadlines/cancellation; repeated cancellation; no surviving cooperative fake tasks; preclose artifact ordering; original strict failure; partial observer availability; malformed canaries; actual JS snapshot/delta validation across the Python boundary; reserved bytes and file modes; final replacement failure preserving preliminary files; and successful sampling that cannot publish PASS before cleanup completes. Existing frame, identity, relay/STUN/tunnel, schedule and single-use proof tests remain green.

## Self-review and concerns

Self-review checked the four-path diff against the R1 brief: privacy boundary, enrolled old-object semantics, compact schemas and exact outside-array budgets, final snapshot before cleanup, outer manager failure coverage, original-cause preservation, private atomic files and untouched one-use Start protocol. Fixed issues found during self-review included post-stop transport reads, final snapshot reenrollment ordering, incomplete preclose summary status, first-terminal fallback preservation, precise envelope byte accounting, swallowed cancellation-cooperation failures and preserving original failures when the cleanup coordinator itself throws.

Explicit limitation: arbitrary cancellation-resistant awaitables cannot be forcibly terminated by in-process asyncio. Such a stage raises CancellationCooperationError as an implementation gate failure and does not return normal harness success. The hostile fake is explicitly owned and released by its test after asserting that gate; the test does not prove settlement of an arbitrary real backend. All cooperative actual-run fake paths prove no pending fake stage/coordinator remains. No hard real Playwright cancellation, no-owned-processes-left, OS process-exit or bounded OS-write guarantee is claimed. A noncooperative real API requires separate scoped review of an owned process boundary; this task adds no worker/process supervisor. A successful close/stop remains only API evidence, with process exit not-observed.

Observation coverage remains partial: a newly assigned engine can fail between the single 1s scan and existing event hooks. Missing events do not prove that no disconnect, ping or probe occurred. No initiating fault has been fixed or attributed by this change, and no durable remote usability or long-session qualification has been performed.

No product/dependency/dist/runtime/config/service/tunnel changes or live runs were made by this task. Existing dirty README, runbook, requirements and review-anchor changes and the node_modules symlink were preserved and excluded from I2 commits. Root independent review and any separately authorized live acceptance remain outstanding.

## R1 corrections after independent review

Review: `task-I2-signal-observer-review.md`, two Important findings accepted. Correction base: `70789fa`. Code correction commit: `0f0e902612a692fdae06487453b0fd1c8e9085b2` (`fix(acceptance): stop on startup evidence failures`). Only `scripts/passive_session_soak.py` and `scripts/test_passive_session_soak.py` changed for R1; the JavaScript observer remains unchanged.

Normal post-media startup summary collection is now required. Its exception/schema failure becomes fixed `startup-summary-unavailable`, and its cooperative timeout becomes fixed `startup-summary-deadline`, both at stage `startup-summary`. The existing finalizer preserves that first cause and emits INCOMPLETE. Cleanup-time startup-summary collection remains best-effort after an earlier failure. The healthy fake now represents a connected socket with no terminal event; this avoids the previous test fixture's disconnect masking the summary failure. Actual-run regressions assert both artifacts, no sampling after the failure, one proof/one Start, successful close/stop and no pending cooperative fake tasks.

Persistence now returns whether both artifact commits succeeded. Initial persistence still attempts both filenames, but any failed commit raises fixed `evidence-write-failed` before manager construction. The outer finalizer retains its later persistence attempts. Per-filename persistent write-failure regressions assert zero manager factory/start, zero login/proof/Start, an empty samples file, a retained valid 0600 companion artifact and the original failure in summary evidence/attempts.

R1 RED: the two new actual-run test methods failed in all four subcases before the correction. Healthy startup-summary exception and timeout incorrectly returned success (`0 != 1`); initial lifecycle and summary write failures each still invoked the manager factory.

R1 GREEN: the following targeted command passed 5 test methods (including the two new methods' four subcases), exit 0:

```text
python3 -m unittest scripts.test_passive_session_soak.LifecycleRunTest.test_healthy_session_startup_summary_error_and_timeout_cannot_pass scripts.test_passive_session_soak.LifecycleRunTest.test_initial_artifact_failure_aborts_before_manager_factory_and_keeps_other_artifact scripts.test_passive_session_soak.LifecycleRunTest.test_successful_sampling_still_waits_for_cleanup_before_final_pass scripts.test_passive_session_soak.LifecycleRunTest.test_outer_start_launch_entry_export_close_and_stop_errors_keep_evidence scripts.test_passive_session_soak.LifecycleRunTest.test_final_write_failure_keeps_committed_preclose_failure_artifacts
```

`python3 -m py_compile scripts/passive_session_soak.py` and `git diff --check` also passed. Broader suites were not repeated because the affected Python control-flow branches and adjacent preservation/success paths are covered by this targeted run; the earlier full-suite results above remain historical pre-R1 evidence. Self-review checked that the initial gate is before the manager factory, both write attempts still occur, startup exceptions retain fixed private-safe reasons, healthy success remains possible, and cleanup-time collection cannot overwrite the original cause. No runtime, native, network, live browser, service, tunnel, dependency or build actions were performed; unrelated concurrent product/tests and pre-existing dirty documents remain untouched. Cooperative-bound and not-observed process-exit limitations are unchanged. R1 independent re-review remains outstanding.
