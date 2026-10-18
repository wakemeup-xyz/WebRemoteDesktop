# Reset ACK and Ordinary Viewer Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Direct execution is already authorized; no repeated workflow questions.

**Goal:** Remove first reset-ACK suppression, restore ordinary after-grace control acquisition and retire stale signaling watchdogs, preserving all true supersession fences.
**Architecture:** Serialize only zero-Viewer cleanup using the existing transition lock; immutable Signal/authority/operation entry evidence determines stale/coalesced/fallback outcomes. No new controller/lock/task.
**Tech Stack:** CPython3.11 deterministic unittest, actual AST-extracted methods and pure cleanup recorder.
**Spec:** ../specs/2026-10-18-reset-ack-ordering-design.md

## Global Constraints

Source worktree /Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop, branchcodex/reliability-latency-remediation, baseline38bfd6b23460596f10744ba267ad47052720b9c5. ProductHostc239482/e5927c7 remains loaded as76982; Signal45287/build79 unchanged. Preserve4 dirtydocs README.md, docs/archive/worklogs/review-anchors.md, docs/runbook-safe-startup.md, docs/需求文档/WebRemoteDesktop-需求文档.md and untracked signal-server/node_modules. Root is sole source/index writer except explicit one-worker handoff. Worker stages/commits only owned paths and spawns no subagents. No native/Host imports, realthreads/sockets/subprocess tests, wall-clock sleeps, businessinput, browser/network/service/primary/proof/tunnel/watcher operations. No policy/authority weakening, deadlines/grace/retry/quality/FPS/codec/resolution/bitrate changes. Do not run broad tests/npm/pretest/install. Python /Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11.

### Task 1: Order zero-Viewer cleanup with the actual trusted reset

**Files:** Modify python-host/host.py only on_viewer_status. Create python-host/test_control_transition_status_ordering.py. Do not change existing authority/reset/close/offer/Signal methods or diagnostic schemas. Existing test_peer_cleanup_observation stays unchanged.
**Interface:** No new public API. Reuse `_control_transition_lock`, `_signal_generation`, `_capture_authority`, `_authority_matches`, `_control_operation`. The full3-tuple pending→applied reset and exact resource-absence list are fixed by the spec.

- [x] Build pure AST fixture using actual authority helpers, on_control_transition, _apply_control_transition, on_viewer_status, _close_peer_connection (and on_disconnect if needed), bounded fake logger/SIO/overlay, fake input reset/queue/PC/track/relay and pure PeerCleanupObservation. No AST edits of method bodies or replaced decisions under test. Capture a valid predecessor behavioral RED: resetA waits in oldPC.close after detach, statusB runs, first appliedACK lost. Assert first-ACK outcome, not presence of a new helper/source string. Gate setup failures are not RED.
- [x] For zero count capture immutable entry Signal generation/full authority/exact operation before first await. Lazily get the same transition lock and enter it. Check entry Signal+full authority before any cleanup. Coalesce only validpositiveepoch pendingreset→sameappliedreset with current Viewer/binding and all eight resource references exactly None. Keep overlay update on coalescing. Positive count path remains unchanged.
- [x] Otherwise ordinary current-scope cleanup runs under the lock; capture relay locally and preserve its original operational stop condition. Recheck Signal+fullauthority after relay.stop before closing current resources. Preserve errors/cancellation and lock release. Do not relax any existing transition/peer fence or ACK before cleanup.
- [x] Behavioral tests cover observedPC race, earlierrelaystop, earliernativereset, Signalgeneration change, fullauthority/binding/attempt changes and replacementpeer, reject/error/cancel fallback with nofalseapplied, eachof8 nonempty resources (includingfalseyfixture), ordinaryzero/positiveoverlay, grantinflight and replacementduringfallbackrelaystop. Confirm supersedingcleanup stillsuppressesoldACK, originalresourceclosureexactonce and no timer/retry needed for successful same-scope reset. Cancellation leaves unknown detached release honest.
- [x] Run focused command after edit, then final affected command once. Self-review actual source+test scope and owned-only commit. Report behavioral RED/GREEN, commands/counts/childexit, commit/paths, no production claims. Root independent concurrency taskreview; original implementer handles any fixes before Task2.

```bash
cd python-host
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest test_control_transition_status_ordering test_peer_cleanup_observation
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest test_control_transition_status_ordering test_peer_cleanup_observation test_capture_resource_owner test_capture_shutdown_contract test_capture_cadence test_capture_observation test_runtime_observability
```

### Task 2: Ordinary after-grace acquire intent and current watchdog ownership

**Files:** Modify web-client/js/webrtc.js only requestControl, quiesceDisconnectedSocket and scheduleSignalingRecovery (tiny shared timer-retirement helper only if necessary). Extend web-client/js/input-signaling-continuity.test.js and web-client/js/webrtc.test.js. No Host/Signal source, admission API/proof, input/media/grant policy or unrelated refactor.
**Interfaces:** Existing current-socket acquire intent waiting/remaining and existing signaling timer handle/startedAt/pending; no public API. Consume Task1 reviewed source without edits. Node /Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node. Workers run actual VM/in-memory handler tests only; no sockets/services/browser/native/process tests or npm hooks. One source/index writer handoff and owned-only commit.

- [ ] Actual P1 predecessor RED: start an ordinary ACTIVE Viewer, drive actual disconnect freeze (retain ACTIVE/noncontroller), expire server grace and apply Host reset while offline, resume exact ordinary owner generation, deliver actual connected→FREE order through real socket handlers. No forced localFREE before welcome. Assert one control-acquire takeover:false, no admission API, no early input. Current source emits zero. Cover same SocketIO object/new socket ID and watchdog replacement using actual listener ownership; integration fixture must not stub requestControl/_resume/freeze/handleState decisions.
- [ ] In existing automatic ACTIVE/noncontroller refusal mark existing intent.waiting=true, then retain false return. Do not change localstate/remaining, send takeover, request ticket or grant input. Later authoritative FREE can spend only existing one retry. Keep actual occupiedACTIVE non-acquiring untilFREE; manualrelease/superseded/hostoffline/auth/start cancellation/stale socket cannot reacquire. Retain reset/media/barrier and pending/uncertain input no-replay behavior.
- [ ] Actual P2 predecessor RED: schedule A real recovery watchdog; real disconnected setNetworkMode→quiesce/init waits config; let A timer fire either before or after B creation, deliver B connect_error; advance unchanged max-wait and require current watchdog socket recreation. Current source retains spent A handle and recreates zero. Use deterministic fake clock, no wall-clock sleep. Keep old staleconnect cannot createPC assertion.
- [ ] Retire A timer at quiesce while preserving existing startedAt/pending; callback retires only its captured ownhandle before stale socket/episode return. A queued cancelled callback cannot clear a newer B timer or perform actions. B error re-arms using original elapsed budget; no deadline reset/infinite rearm/old owner authorization. Test A-expiry during config, Berror before/after A-expiry, queuedAafterBtimer, successfulconnect cleanup, manualdisconnect/superseded/retired episode and no network-mode/policy changes.
- [ ] Focused RED/GREEN selections first, then direct two-file affected command once after final edits. Self-review and owned-only commit/report. Distinguish expected existing fixtureconsole messages from new warnings/unhandled errors; no silent test warnings. Root independent spec+quality concurrency review, originalworkerfixloop. No production claims; source-only Task3 final wholeincrement review follows.

```bash
/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test web-client/js/input-signaling-continuity.test.js web-client/js/webrtc.test.js
```

### Task 3: Final source review and explicit runtime handoff

**Files:** Create docs/superpowers/reports/2026-10-18-reset-ack-ordering-execution.md and evidence/2026-10-18-reset-ack-ordering/ source review/test facts. Modify this plan marks only. No source changes in root task; any review fix returns to the original owning Task1 or Task2 worker.
**Consumes:** Exact Task1 and Task2 BASE→TIP ranges, actual tests and independent spec+quality verdicts. Runtime stillc239482/e5927c7, not this source. Currentprimarydocs38bfd delivery preserved.

- [ ] Read both full task reports and independent concurrency reviews, record exact range/hash/RED/GREEN and any original-worker fix loop. Archive bounded reviewed facts, not raw input/credentials. Distinguish code fixed from runtime not loaded.
- [ ] Most-capable whole-increment final source review against this spec and existing fullauthority/Signal/grant/close contracts; final findings use original implementer + scoped rereview, not root code patch. Archive reviews and source-only status with no productionPASS.
- [ ] Handoff exact reviewed commit/files/tests/limits to separately specified guarded ordinary-recovery release. This plan performs no service/source promotion. Broad user objective remains active: next plan implements safe ordinary qualification and later combines guarded rollout, actual firstACK observation, fresh300/10800s, health/Hostonline/serviceavailable. Keep proof/native/tunnel constraints, fourdirtydocs/worktree/branch; no merge/push. Do not repeat old R1/R2 runtime wrappers on changed primarydocs.
