# Task 2 implementation report

Status: DONE. Source-only implementation and verification complete; independent review remains root-owned.

Worktree: `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`

Task base: `72c437d3c9ce14752e049a86890855caa28a5373`

Owned commit: `3046fdd` — `fix(viewer): retain ordinary recovery intent and watchdog ownership`.

## Actual source changes

Only three existing methods in `web-client/js/webrtc.js` changed:

- `requestControl`: the existing automatic ACTIVE/noncontroller refusal marks the current socket's already-created intent `waiting = true` and still returns false. It does not alter local state, acquire while occupied, request a ticket, enable takeover, replenish the one retry, or grant input. Later authoritative FREE consumes the existing retry through the unchanged `_resumeControlAcquireIntent`.
- `quiesceDisconnectedSocket`: clears and retires the stored recovery timer before socket quiescence, preserving `_signalRecoveryStartedAt` and `_signalRecoveryPending`.
- `scheduleSignalingRecovery`: captures its timer handle; a callback returns unless it still owns the stored handle, then retires only that handle before stale socket/episode checks. Existing socket/episode/manual/supersession guards still precede recovery actions. Retry and maximum wait remain 1500/12000 ms, including the existing origin reset only after actual maximum-wait recreation.

No shared helper or protocol/interface change was needed.

## Actual behavioral tests

`web-client/js/input-signaling-continuity.test.js` adds nine tests using the real VM Viewer/Input methods and actual in-memory Signal handlers. The bridge obtains ordinary explicit admission from the actual in-memory runtime, consumes actual welcome's resume generation, initially acquires through actual control transition/grant, then drives the actual disconnect listener and preserves ACTIVE/noncontroller. The server's 8000 ms grace expires and its reset-only transition receives a fake applied Host ACK while the client remains offline. Actual server welcome then precedes authoritative FREE. Both same Socket.IO object/new ID and actual recovery-watchdog-created replacement acquire exactly once with takeover false and the exact current-owner generation, with no admission fetch and no input before grant/current media. Duplicate FREE cannot replenish the budget. Actual release, host-offline, supersession, auth retirement, new Start and stale socket lifecycles fence the waiting intent. Occupied ACTIVE remains non-acquiring until FREE.

The original `reconnectBridge` compatibility fixture is unchanged. The new fixture does not force FREE after disconnect and does not stub requestControl, `_resumeControlAcquireIntent`, freezeControl, handleControlState, or listener ownership. Only initial admission starts FREE. Its synthetic Host ACK is not a native-reset qualification.

`web-client/js/webrtc.test.js` adds nine tests using a deterministic monotonic clock, real disconnected `setNetworkMode` -> `quiesceDisconnectedSocket` -> `init` configuration wait, real signaling construction/listeners and real recovery scheduling. Only platform socket/peer/configuration and unrelated UI/media effects are faked. Four orderings cover A expiry during config, B error before A expiry, B error after A expiry, and a queued cancelled A callback after B has its own timer. They require current socket recreation at original elapsed 12000 ms, preserve origin/pending, reject stale A connect peer creation, and prove queued A cannot clear B's timer. Actual successful connect, manual disconnect, supersession and retired-episode cleanup fence queued timers. A separate test proves a currently owned spent handle retires before stale socket or retired episode return, even without quiesce.

Existing affected-file regressions for in-grace Host rebind rejection/timeout, no reset ACK, duplicate FREE, reset/media barriers, pending/uncertain input and no replay were retained and passed.

## RED history and setup failures

All commands ran directly with `/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node` from this worktree. Every test process completed/reaped before another test command started. Logs are private alongside this report.

1. `node --test --test-name-pattern='ordinary after-grace' web-client/js/input-signaling-continuity.test.js` — first development run: 0 pass / 2 fail due to a fixture assertion using nonexistent transition `mode`. This was a setup assertion, not a valid behavior RED; excluded. That initial shell wrapper ended in `tail` and returned 0 despite the failed test summary. The assertion was corrected to actual reset-only absence of `viewerId`; subsequent wrappers preserve the Node exit code.
2. The same P1 command on unchanged predecessor source: 0 pass / 2 fail, exit 1 (`task-2-p1-red.log`). Both fail at expected acquire count: actual 0 vs expected 1 after real connected -> FREE. These are valid behavior REDs, with ACTIVE freeze, real ordinary generation and server grace/reset already established. The replacement test initially invoked actual createSignalingSocket directly; final coverage strengthens it to actual watchdog expiry invoking that same creation path.
3. `node --test --test-name-pattern='mode-switch watchdog ownership' web-client/js/webrtc.test.js` — first P2 development run: 3 pass / 5 fail, exit 1 (`task-2-p2-red.log`). Four valid behavior REDs require 3 constructed sockets after 12000 ms but observe 2 (zero current watchdog recreation). One extra failure was fixture misuse of retirement without an episode/cleanup; excluded from behavior claims.
4. The same P2 command after fixing episode fixture setup, still on unchanged predecessor source: 4 pass / 4 fail, exit 1 (`task-2-p2-red-final.log`). All four failures are the same actual current-watchdog 2 vs 3 construction assertion at original max wait. Lifecycle cases pass. This is the clean P2 RED.

There were no cwd/import/setup-tool failures. An intermediate unexecuted patch selected the wrong loop while adding an optional episode argument; it was corrected by inspection before any test run.

## GREEN commands and results

1. `node --test --test-name-pattern='ordinary after-grace|mode-switch watchdog ownership' web-client/js/input-signaling-continuity.test.js web-client/js/webrtc.test.js`: 10 tests, 10 pass, 0 fail/cancel/skip/todo, exit 0 (`task-2-focused-green.log`).
2. Expanded edge selection `node --test --test-name-pattern='ordinary after-grace|mode-switch watchdog ownership|signaling watchdog retires' web-client/js/input-signaling-continuity.test.js web-client/js/webrtc.test.js`: 18 tests, 18 pass, exit 0 (`task-2-focused-edges.log`). The same expanded selection after actual-watchdog and admission/socket-input observation refinements passed 18/18; final repeated selection after the last test edit passed 18/18, 0 fail/cancel/skip/todo, exit 0 (`task-2-focused-final.log`). These are overlapping runs, not additive totals.
3. Required final direct affected command, run once after the last source/test edit:

   `/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test web-client/js/input-signaling-continuity.test.js web-client/js/webrtc.test.js`

   Result: **392 tests, 392 pass, 0 fail/cancel/skip/todo, exit 0**, 25424.700147 ms (`task-2-affected.log`). Process session 57980 completed and was reaped before subsequent work. No npm/pretest/install or broader test command ran.

`git diff --check` and staged diff check passed. Only the three owned Viewer files were staged and committed.

## Warnings and output

New bridge tests capture and assert their exact expected warnings: actual 12000 ms signaling recreation where requested and actual supersession in its cancellation case. New mode/watchdog tests assert expected timeout classification, exact 12000 ms recreation, and supersession warning where applicable; stale-handle cases emit no warning. Unexpected warnings fail those assertions rather than disappearing silently.

The final affected output retains existing synthetic diagnostics: config HTTP 500 fallback from the existing `status: 500` config fixture, DataChannel error `{}` / `offline-error-fixture`, stale Host replacement/ignored disconnect, supersession/admission rejection and normal recovery/fallback messages. These are intentional existing fixture outputs. The new mode-switch tests also emit normal paint-gate/config log messages, including existing first-frame-timeout log paths under fake time. No Node `Warning:`, unhandled rejection, unhandled error, ERR_ output, or new unexpected warning was found.

## Self-review and boundaries

Completeness: both specified defects have valid predecessor REDs and actual-decision GREENs; focused edge coverage plus the required two-file command passed. Authority/input/reset/media barriers and cancellation ownership remain in the unchanged decision methods and affected regressions.

Quality: the production diff is 12 added / 2 removed lines across the three allowed methods. Existing intent/retry state is reused. Timer identity gates both retirement and action, and quiesce preserves the original elapsed budget. No new loop, timer policy, grace, network-mode policy, deadline, public API or unrelated refactor was introduced.

Discipline: no Host/Signal source edit, no primary/build operation, browser/network/API server, service/restart/tunnel, proof/watchers, native input/import, subprocess/thread/socket test, broad npm/test/install, subagent or reviewer dispatch. The only Signal execution was its existing actual handlers with in-memory FakeSocket adapters. Four preexisting dirty docs and the untracked `signal-server/node_modules` symlink remain outside the owned commit. Host Task1 remains unchanged from Task2 base. Final status has those original dirty docs and symlink only; no owned dirty or staged paths.

Limits/concerns: source-only qualification. Production Host c239482/e5927c7 and Signal45287/build79 remain untouched; deployment, ordinary real runtime recovery, first real reset ACK, long-session continuity, initiating WS1006 cause and real visible/physical input are unqualified. No implementation concern found in self-review. Root still owns independent Task2 review and final whole-increment review.
