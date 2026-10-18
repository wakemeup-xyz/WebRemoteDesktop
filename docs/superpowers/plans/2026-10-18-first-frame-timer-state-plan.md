# Explicit Viewer first-frame timer state implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the production Viewer's legacy first-frame timer state explicit so the unchanged observer can distinguish no timer from missing state.

**Architecture:** Initialize the existing WebRTC state property to null. Use the existing Node VM harness and unchanged passive sampler to verify fresh, startup-budget, armed and cleared states without changing any qualification gate.

**Tech Stack:** Browser JavaScript, Node.js node:test and vm; existing offline fixtures.

**Spec:** `docs/superpowers/specs/2026-10-18-first-frame-timer-state-design.md`

## Global Constraints

- Change only `web-client/js/webrtc.js` and `web-client/js/webrtc.test.js` for the implementation task; this spec and its plan are separate root-owned documents.
- Keep the passive sampler, ordinary runner, immutable supervisor and all readiness/continuity/cleanup predicates byte-for-byte unchanged.
- Keep authority, admission, resume/proof restrictions, timeout/retry budgets, quality, codec, resolution, FPS, bitrate and network policy unchanged.
- Preserve both actual failed attempts and their one-use markers. A later real attempt requires a distinct reviewed deployment and operational context.
- Run only offline Node VM tests for this task. No browser, network, native input, process inspection, service/build/install or runtime configuration operations by workers.
- Preserve the four pre-existing dirty documents, node_modules link, primary index, W2 files, tunnel/watch and prior evidence.
- Business input, native visible effect and physical qualification remain NOT_RUN; no numeric input-to-picture latency may be inferred from RTT or video FPS.

---

### Task 1: Initialize and verify the production timer state

**Files:**
- Modify: `web-client/js/webrtc.js` (existing object state near `hasPaintedFrame`).
- Modify/test: `web-client/js/webrtc.test.js` (existing `loadWebRTC` VM harness and first-frame tests).
- Read unchanged consumer: `scripts/passive_session_sampler.js`.

**Interfaces:**
- Consumes: `loadWebRTC(overrides)`, real `WebRTC.beginFirstFrameDeadline(attemptId, timeoutMs)`, `clearFirstFrameDeadline()`, and the unchanged sampler's `window.__wrdPassiveSampler.sample()`/`stop()`.
- Produces: an own `_firstFrameTimer` initialized to null; unchanged actual timer handle while armed and null after cancellation. No new production API.

- [ ] **Step 1: Add production/consumer regression tests.** Extend the existing VM fixture only enough to evaluate the unchanged sampler in its actual context, using fake DOM/stats/time. Do not prepopulate `_firstFrameTimer`. Cover fresh source own/null and sample false; delegate startup with `startupPending:()=>true`, non-tunnel mode and a counted `startStartupMediaBudget`, then verify null/false without scheduling a legacy timer; exercise the actual legacy arm and clear with fake timers, sample true then false; delete the property only for a negative sampler-null control. Always stop the sampler and clear fixture timers. Core assertions include:

```javascript
assert.equal(Object.hasOwn(WebRTC, '_firstFrameTimer'), true);
assert.equal(WebRTC._firstFrameTimer, null);
assert.equal((await sampler.sample()).inputGate.firstFrameTimerHandlePresent, false);
```

- [ ] **Step 2: Demonstrate RED before production edit.** Run the added tests by a precise name pattern with `/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test --test-name-pattern='explicit first-frame timer' web-client/js/webrtc.test.js`. Preserve output and exit status; failure must be the real absent property, not a fixture exception. Refine the harness before recording RED if necessary.

- [ ] **Step 3: Make the minimal product change.** Add exactly the existing-state declaration:

```javascript
  _firstFrameTimer: null,
```

Keep timer methods and all consumers unchanged. If tests expose an additional requirement, report it to root before expanding scope.

- [ ] **Step 4: Run GREEN and affected suites.** Re-run the precise regression, then once run `/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test web-client/js/webrtc.test.js scripts/passive-session-sampler.test.js`. Retain logs, exit codes and counts. No broader runtime test by worker.

- [ ] **Step 5: Self-review and hand off.** Inspect exact two-file diff, verify unchanged sampler/helper/runner, and write report with RED/GREEN/full affected command/results and limitations. Root stages/commits exact paths, generates the range review package, then dispatches fresh task and final increment reviewers. Workers do not stage, commit or dispatch reviewers.

Root then prepares a new reviewed product deployment and fresh acceptance sequence; this implementation task never publishes or restarts services.
