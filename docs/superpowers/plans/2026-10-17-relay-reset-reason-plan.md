# Relay Reset Reason Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Ensure M6 media invalidation emits an existing valid keyboard reset while retaining local diagnostic reasons.

**Architecture:** Add one optional local Input.setActive metadata value; adapt only M6 invalidation's two reset paths. Keep strict Signal/Host protocol and existing reset/media gates.

**Tech Stack:** Existing browser JS, Node VM/node:test and pure Signal validator.

**Spec:** `docs/superpowers/specs/2026-10-17-relay-reset-reason-design.md`.

## Global Constraints

- Worktree only; no browser, network, native input, service, tunnel, dependency, build/pretest or primary-checkout action.
- Production scope is only `web-client/js/input.js` and `web-client/js/webrtc.js`; tests in existing Input/M6 suites. No whitelist/schema, timeout, queue, quality, admission or business replay changes.
- Preserve all unrelated dirty docs and the node_modules symlink; stage only owned files. Controller serializes index ownership and deployment.

### Task 1: Preserve diagnostics and emit valid reset protocol

**Files:** `web-client/js/input.js`, `web-client/js/webrtc.js`, `web-client/js/input-signaling-continuity.test.js`; add targeted assertions to an existing Input/M6 suite only if needed for an otherwise uncovered branch. Validator source is read-only `signal-server/lib/remote-input-contract.js`.

- [x] Reproduce invalid keyboard reset from real M6 stale timer and relay-start invalidation using actual Input/KeyboardTransport. Assert the emitted wire envelope fails existing `validateRemoteInput` with INVALID_RESET_REASON before the patch; the desired accepted assertion must be RED.
- [x] Change only the resetKeyboard call inside Input.setActive to use `meta.keyboardResetReason || reason`. Leave pointer and active lifecycle reasons as `reason`/meta.reason and preserve resetKeyboard:false/default policy.
- [x] In WebRTC.invalidateRelayInputProof, pass `keyboardResetReason:'deactivated'` while retaining original `reason`; map its already-inactive required-reset fallback to `Input.resetKeyboard('deactivated')`. No unconditional extra reset when inactive and ready.
- [x] Verify actual emitted envelopes through the unchanged pure Signal validator, removing only fixture-only channel metadata before validation. Cover active stale, relay-start, inactive pressed/RESET_REQUIRED, and inactive clean no-op. Use actual current-scope relay ACK and image onload; preserve exact lease/seq/inputIds.
- [x] Verify stale gate remains closed after reset ACK until current fresh image; current fresh image before reset ACK remains blocked; old reset ACK/identity cannot clear current barrier. Confirm media/UI/lifecycle reason retains relay-frame-stale or relay-start and non-M6/default callers unchanged. No simulated native input needed.
- [x] Run targeted RED/GREEN, complete continuity suite, and `node --test web-client/js/input.test.js web-client/js/keyboard-transport.test.js web-client/js/webrtc.test.js web-client/js/input-backpressure.test.js web-client/js/input-recovery.test.js web-client/js/input-signaling-continuity.test.js`. Run production syntax checks and diff check; do not npm test/pretest.
- [x] Self-review; commit only owned source/tests; write exact commands/results, protocol boundary and source hash to controller-provided ignored task report. Return source/index ownership.

### Task 2: Review and controller-owned delivery

- [x] Independent spec/quality review of Task1 exact diff d057853; no findings. Task3 separately requires review.
- [ ] Rebuild frozen reviewed frontend to temporary output, preserving retained assets; disregard the older pre-fix candidate build. Sync only reviewed increment against verified primary baseline and preserve HEAD/index/tunnel/watcher identities.
- [ ] Authorized local reload, actual build/source/health/Host verification and credentials report; new proof-guarded real UI short TURN/JPEG sessions.
- [ ] Investigate remaining media gaps from actual evidence. Preserve earlier failures and native visible-effect NOT RUN. Begin long qualification only after short gates pass; no guarantee from final online snapshot alone.

### Task 3: Correct adjacent control teardown wire reasons

**Files:** `web-client/js/webrtc.js` only production; existing `web-client/js/input-signaling-continuity.test.js` and `web-client/js/webrtc.test.js` tests as needed. No Input/Signal/Host production changes.

**Evidence:** `docs/superpowers/reports/2026-10-17-keyboard-reset-reason-adjacent-review.md`. This is a narrow protocol correctness followup, not a claim of a separate permanent-control failure.

- [ ] Reproduce actual control-button UI handler release with real Input/Controller/Transport; desired validator success is RED due input-recovery-user. Include real freezeControl host-offline or control-heartbeat-rejected and default fallback reason; do not rely on reset method stubs alone.
- [ ] Inside freezeControl's existing non-suspended/reset branch call `Input.resetKeyboard?.('control-revoked')`. Inside releaseControl's existing !preserveAcquireIntent branch call `Input.resetKeyboard?.('deactivated')`. Change no branch conditions, ordering, release payload, scope, timers or other reason consumers.
- [ ] Assert unchanged pure Signal validator accepts actual emitted keyboard reset with exact original lease/seq/inputIds. Control UI reset precedes control-release; control-release and lifecycle/pointer reasons remain original. After revoked/lease cleared, old ACK cannot restore control. Check existing signal-disconnect parked lease, reset=false and preserveAcquireIntent still skip/reset exactly as before.
- [ ] Preserve M6 two-prerequisite gates and wire reasons from d057853. Run targeted RED/GREEN, full continuity and `node --test web-client/js/input.test.js web-client/js/keyboard-transport.test.js web-client/js/webrtc.test.js web-client/js/input-backpressure.test.js web-client/js/input-recovery.test.js web-client/js/input-signaling-continuity.test.js`; syntax and diff check. Only update old test expectations when they assert the intentionally changed wire reason; retain diagnostic reason checks.
- [ ] Self-review; commit only owned source/tests; full report to controller-provided ignored path; release source/index. Independent review required before controller Task2 deployment; no native/browser/network/runtime actions.
