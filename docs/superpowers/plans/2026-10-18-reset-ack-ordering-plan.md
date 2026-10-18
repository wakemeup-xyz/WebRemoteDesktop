# Reset ACK Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Direct execution is already authorized; no repeated workflow questions.

**Goal:** Remove the confirmed redundant zero-Viewer cleanup race that suppresses the first trusted reset ACK, preserving all true supersession fences.
**Architecture:** Serialize only zero-Viewer cleanup using the existing transition lock; immutable Signal/authority/operation entry evidence determines stale/coalesced/fallback outcomes. No new controller/lock/task.
**Tech Stack:** CPython3.11 deterministic unittest, actual AST-extracted methods and pure cleanup recorder.
**Spec:** ../specs/2026-10-18-reset-ack-ordering-design.md

## Global Constraints

Source worktree /Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop, branchcodex/reliability-latency-remediation, baseline38bfd6b23460596f10744ba267ad47052720b9c5. ProductHostc239482/e5927c7 remains loaded as76982; Signal45287/build79 unchanged. Preserve4 dirtydocs README.md, docs/archive/worklogs/review-anchors.md, docs/runbook-safe-startup.md, docs/需求文档/WebRemoteDesktop-需求文档.md and untracked signal-server/node_modules. Root is sole source/index writer except explicit one-worker handoff. Worker stages/commits only owned paths and spawns no subagents. No native/Host imports, realthreads/sockets/subprocess tests, wall-clock sleeps, businessinput, browser/network/service/primary/proof/tunnel/watcher operations. No policy/authority weakening, deadlines/grace/retry/quality/FPS/codec/resolution/bitrate changes. Do not run broad tests/npm/pretest/install. Python /Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11.

### Task 1: Order zero-Viewer cleanup with the actual trusted reset

**Files:** Modify python-host/host.py only on_viewer_status. Create python-host/test_control_transition_status_ordering.py. Do not change existing authority/reset/close/offer/Signal methods or diagnostic schemas. Existing test_peer_cleanup_observation stays unchanged.
**Interface:** No new public API. Reuse `_control_transition_lock`, `_signal_generation`, `_capture_authority`, `_authority_matches`, `_control_operation`. The full3-tuple pending→applied reset and exact resource-absence list are fixed by the spec.

- [ ] Build pure AST fixture using actual authority helpers, on_control_transition, _apply_control_transition, on_viewer_status, _close_peer_connection (and on_disconnect if needed), bounded fake logger/SIO/overlay, fake input reset/queue/PC/track/relay and pure PeerCleanupObservation. No AST edits of method bodies or replaced decisions under test. Capture a valid predecessor behavioral RED: resetA waits in oldPC.close after detach, statusB runs, first appliedACK lost. Assert first-ACK outcome, not presence of a new helper/source string. Gate setup failures are not RED.
- [ ] For zero count capture immutable entry Signal generation/full authority/exact operation before first await. Lazily get the same transition lock and enter it. Check entry Signal+full authority before any cleanup. Coalesce only validpositiveepoch pendingreset→sameappliedreset with current Viewer/binding and all eight resource references exactly None. Keep overlay update on coalescing. Positive count path remains unchanged.
- [ ] Otherwise ordinary current-scope cleanup runs under the lock; capture relay locally and preserve its original operational stop condition. Recheck Signal+fullauthority after relay.stop before closing current resources. Preserve errors/cancellation and lock release. Do not relax any existing transition/peer fence or ACK before cleanup.
- [ ] Behavioral tests cover observedPC race, earlierrelaystop, earliernativereset, Signalgeneration change, fullauthority/binding/attempt changes and replacementpeer, reject/error/cancel fallback with nofalseapplied, eachof8 nonempty resources (includingfalseyfixture), ordinaryzero/positiveoverlay, grantinflight and replacementduringfallbackrelaystop. Confirm supersedingcleanup stillsuppressesoldACK, originalresourceclosureexactonce and no timer/retry needed for successful same-scope reset. Cancellation leaves unknown detached release honest.
- [ ] Run focused command after edit, then final affected command once. Self-review actual source+test scope and owned-only commit. Report behavioral RED/GREEN, commands/counts/childexit, commit/paths, no production claims. Root independent concurrency taskreview; original implementer handles any fixes before Task2.

```bash
cd python-host
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest test_control_transition_status_ordering test_peer_cleanup_observation
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest test_control_transition_status_ordering test_peer_cleanup_observation test_capture_resource_owner test_capture_shutdown_contract test_capture_cadence test_capture_observation test_runtime_observability
```

### Task 2: Final source review and explicit runtime handoff

**Files:** Create docs/superpowers/reports/2026-10-18-reset-ack-ordering-execution.md and evidence/2026-10-18-reset-ack-ordering/ source review/test facts. Modify this plan marks only. No source changes in root task; any review fix returns to Task1 worker.
**Consumes:** Exact Task1BASE→TIP, actual tests and independent spec+quality verdict. Runtime stillc239482/e5927c7, not this source. Currentprimarydocs38bfd delivery preserved.

- [ ] Read full task report and independent concurrency review, record exact range/hash/RED/GREEN and any original-worker fix loop. Archive bounded reviewed facts, not raw input/credentials. Distinguish code fixed from runtime not loaded.
- [ ] Most-capable whole-increment final source review against this spec and existing fullauthority/Signal/grant/close contracts; final findings use original implementer + scoped rereview, not root code patch. Archive reviews and source-only status with no productionPASS.
- [ ] Handoff exact reviewed commit/files/tests/limits to separately specified guarded ordinary-recovery release. This plan performs no service/source promotion. Broad user objective remains active: next plan implements safe ordinary qualification and later combines guarded rollout, actual firstACK observation, fresh300/10800s, health/Hostonline/serviceavailable. Keep proof/native/tunnel constraints, fourdirtydocs/worktree/branch; no merge/push. Do not repeat old R1/R2 runtime wrappers on changed primarydocs.
