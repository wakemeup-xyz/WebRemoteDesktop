# Startup configuration/control join implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** negotiate one current configured peer after both startup configuration and accepted control are ready, in either arrival order.

**Architecture:** a narrow shared reconciliation at init and valid-grant join points, with configuration deferral at media entry boundaries and existing authority/offer ownership checks. Keep parallel startup and completed-session recovery behavior.

**Tech Stack:** browser JavaScript; Node node:test/VM with fake platform RTC/socket/auth/clock and real production Input/bootstrap methods.

**Spec:** docs/superpowers/specs/2026-10-19-startup-config-grant-ordering-design.md

## Global Constraints

- Preserve admission/current lease/Input recovery, all offer ownership checks and stale-answer validation. No grant synthesis, reset/authority bypass, input enable or replay.
- Same parallel signaling/config, tunnel/JPEG, ICE/network/quality policy and 8/72/12s budgets; no new retry/deadline/grace.
- One configured peer/matching initial offer after both prerequisites; no peer/offer while config deferred. Do not suppress legitimate completed-session renegotiation.
- Source-only fakes; no services/build/rollout/browser/native/network. Six input metrics and visible/physical acceptance remain NOT_RUN.
- Root owns index/commits/runtime. Preserve four dirty docs and node_modules symlink.

### Task1: Join configured startup with current accepted control

**Files:** modify web-client/js/webrtc.js; extend web-client/js/webrtc.test.js.

**Interfaces:** consume startViewer/init/applyBootstrapSnapshot, _deferPeerUntilConfig, startupAllowed, actual Input.setControlLease gate, current controlState, createPeerConnection/createOffer and ownsOffer fences. Produce one narrow WebRTC reconciliation method called from configured init and valid grant. It returns without media effects unless configuration and current control/Input eligibility hold. Method naming may follow current code, but report its exact API and why duplicate suppression preserves recovery. No generic framework or new authority owner.

- [ ] Step1: Read spec plus characterization/review and actual Input gate/offer ownership code. Extend existing fixture with real bootstrap controller and fake deferred fetch/RTC transitions. Reuse helpers and actual production bodies; suppress only automatic DOM boot through readyState=loading. Add desired-invariant regression and ready-config control, including real Input fresh lease path.

```javascript
assert.equal(peers.length, 0); // after real early grant, before config settles
assert.equal(socket.emitted.filter(e => e.event === 'offer').length, 0);
resolveConfiguration(snapshot);
await settleStartup();
assert.equal(peers.length, 1);
assert.equal(socket.emitted.filter(e => e.event === 'offer').length, 1);
await deliverCurrentAnswer();
assert.equal(peers[0].remoteDescriptionApplications, 1);
```

Fixture names are local test helpers, not product methods. They must delegate to actual bootstrap resolution/socket listener and report scalar state only.

- [ ] Step2: Run new focused tests RED against unchanged production, retain exact command/count/exit/log. Fixture failures are separate. Do not accept old characterization exit0 as this RED.
- [ ] Step3: Implement the narrow join. Shared reconciliation preserves existing media tail and checks current configuration deferral, episode, control and Input eligibility; init resumes a valid early grant without a second grant. Add actual media-entry deferral fence so other callbacks cannot create a pre-config peer/offer. Suppress matching duplicate initial offers using existing peer SDP/signaling/ownership where possible; do not globally block later createOffer calls.

```javascript
// Required earliest reconciliation predicates, before any media side effect:
if (!this.startupAllowed() || this._deferPeerUntilConfig || !this.hasActiveControl()) return false;
// Input eligibility must also remain validated through its existing API/path.
```

Spec invariants bind the implementation: if literal sharing would bypass Input or suppress recovery, keep the public contracts and use the smallest explicit private identity check. Document that choice in the task report; do not add a generic cache/router.

- [ ] Step4: Add GREEN matrix: both arrival orders; duplicate grants during/after initial offer; old async offer cancelled by new owner; cancelled/superseded/auth-changed pending config; Input false/reacquire gate and no-control; tunnel path; completed-session regrant/refresh compatibility. Preserve real ownership and no fake frames/gate success.
- [ ] Step5: Run focused GREEN then affected suites once:

```bash
/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test web-client/js/webrtc.test.js web-client/js/input.test.js web-client/js/input-recovery.test.js web-client/js/bootstrap-controller.test.js scripts/passive-session-sampler.test.js
```

If a named existing suite path differs, resolve via rg --files and report exact actual command, without installing dependencies. No broad repeats after PASS unless new code/failure justifies them.
- [ ] Step6: Report commands/counts/exit/wall/hash/exact modified paths and self-review. Root commits only two source/test paths; independent task spec+quality review then final most-capable increment review. Resolve findings before new source/assets/operations.

## Runtime follow-up

A later fresh context combines reviewed new Viewer with unchanged backenddfb/Host36877 and reviewed tools282; actual source pins, assets, old failed histories and new one-use records remain separate. Signal-only rebuild/reload is sufficient if component trees remain unchanged; no tunnel/watch action. Re-run new baseline fromzero, grace recoveries and three-hour continuity. Native/business/visible/physical needs its independent guarded target and remains unqualified.
