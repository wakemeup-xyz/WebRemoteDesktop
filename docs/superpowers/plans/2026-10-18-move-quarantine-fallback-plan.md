# Mouse move quarantine fallback implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep mouse moves out of an already quarantined selected DataChannel and reuse existing Socket.IO fallback.

**Architecture:** Select the existing dedicated-move/reliable channel as before, then reject that exact object if quarantined. Exercise actual production methods through the existing recovery VM, retaining all input authority and loss policies.

**Tech Stack:** Browser JavaScript, Node.js node:test/vm, fake transport/clock fixtures.

**Spec:** docs/superpowers/specs/2026-10-18-move-quarantine-fallback-design.md

## Global Constraints

- Implementation modifies only web-client/js/webrtc.js and web-client/js/input-recovery.test.js. Root owns this spec, its plan and review records.
- Use actual Input and WebRTC methods in the existing VM fixture with fake channel/socket/clock only. No browser, network, native input, process inspection, service/build/install or runtime configuration actions by workers.
- Preserve sampler/ordinary runner/supervisor/qualification predicates and all recovery budgets, quality, codec, FPS, resolution, bitrate and network policy.
- Preserve the four pre-existing dirty documents, node_modules metadata/link, primary index, W2 four paths, tunnel/watch/quick URL and every earlier failed attempt and marker.
- Source F and R3 operations remain immutable historical artifacts. No R3 execution is allowed for later source; root must derive and independently review a new frozen source/operations context.
- Native/business/visible/physical acceptance remains NOT_RUN. Offline fake inputs do not establish real input-to-picture latency.

---

### Task 1: Reject a quarantined selected channel for movement

**Files:**
- Modify: web-client/js/webrtc.js, WebRTC.sendInput selected-channel check.
- Modify/test: web-client/js/input-recovery.test.js, loadRecoveryFixture and existing open-but-silent recovery neighborhood.
- Read: web-client/js/input.js existing Socket fallback, pending and sequence/latency ledgers; requirements move-drop rules.

**Interfaces:**
- Consumes: loadRecoveryFixture(), h.pointer, h.advance, h.ack, h.sent, h.inputs, h.Input.sendInput, h.WebRTC.sendInput and existing state accessors.
- Produces: unchanged boolean/null dispatch interface, with quarantined selected DC returning false; no new API or timers.

- [ ] **Step 1: Reproduce the missed recovery move using real methods.** Extend the existing silent-reliable scenario or a small shared test helper without substituting sendInput. Preserve its actual timeout and sequence-gap/reset ACK path. The core additional assertions are:

```js
const start = h.sent.length;
h.WebRTC.inputMoveChannel = { readyState: 'closed', bufferedAmount: 0 };
const id = h.Input.sendInput('mouse', 'move', { relX: .25, relY: .5, buttons: 0 });
assert.ok(id);
assert.equal(h.sent.slice(start).filter(x => x.event === 'dc').length, 0);
const writes = h.sent.slice(start).filter(x => x.event === 'input');
assert.equal(writes.length, 1);
assert.equal(writes[0].payload.action, 'move');
assert.equal(writes[0].payload.seq, undefined);
```

Verify gate allowed and quarantine identity before this action. Check pending/sequence counters before/after using actual existing state, so the test cannot pass by blocking all input. Parameterize absent, closed and alias cases and buffer0/4097; preserve the genuine timeout at least once. Other cases may explicitly invoke the actual quarantine method to avoid copying recovery setup. Cover no Socket with null/no new pending/latency result, current replacement B, independent healthy move channel, healthy reliable fallback, and existing intentional healthy >4096 drop. Tests must observe original methods, not duplicate the selection logic.

- [ ] **Step 2: Run focused RED on unchanged production.**

```sh
/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test --test-name-pattern='quarantined|silent reliable|move fallback' web-client/js/input-recovery.test.js
```

Keep actual log/hash and failure assertions. A harness error is not the required behavior failure; correct only the test harness before continuing.

- [ ] **Step 3: Make the minimal selected-object correction.** Keep the reset guard and selector; remove the earlier non-move-only quarantine guard, and change the common rejection to:

```js
const channel = isMouseMove && this.inputMoveChannel?.readyState === 'open'
  ? this.inputMoveChannel
  : this.inputChannel;
if (!channel || channel.readyState !== 'open'
    || channel === this._quarantinedInputChannel) {
  return false;
}
```

Leave both buffer thresholds, drop return, send envelope, quarantine method and caller unchanged. Add only a concise explanatory comment if needed.

- [ ] **Step 4: Run focused GREEN then affected suites once.**

```sh
/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test --test-name-pattern='quarantined|silent reliable|move fallback' web-client/js/input-recovery.test.js
/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test web-client/js/input-recovery.test.js web-client/js/webrtc.test.js web-client/js/input.test.js web-client/js/input-backpressure.test.js scripts/passive_session_sampler.test.js
```

Retain full output privately, report actual counts/elapsed/status/hash and expected diagnostic noise. If the exact sampler test filename differs, use rg --files and record the actual existing filename; do not create an empty substitute. No further suite reruns without a change/failure justifying them.

- [ ] **Step 5: Self-review and hand back without commit/staging.** Verify only the two allowed implementation paths changed and pre-existing changes untouched. Write the task report containing RED/GREEN evidence, changed behavior, limits and concern status. Root alone stages/commits these exact paths, generates the task review package, dispatches spec+quality review, then final increment review. No worker subagents. No build/reload/live acceptance in this task.
