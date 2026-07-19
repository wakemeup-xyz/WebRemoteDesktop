# Manual STUN Port Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manually triggered, cancellable STUN port-search loop that rebuilds WebRTC connections up to 500 times and reports observed Viewer/Host UDP ports in the UI.

**Architecture:** A pure `StunPortSearchController` owns search state, attempt limits, port deduplication, and three-sample media success detection. `WebRTC` owns browser/Socket.IO integration, generation-safe PeerConnection replacement, timers, and UI text. Existing signaling and Host offer handling remain the transport boundary and require no new event.

**Tech Stack:** Vanilla JavaScript, browser WebRTC, Socket.IO, Node.js built-in test runner, Playwright/browser acceptance.

**Spec Coverage:** Full coverage of `docs/superpowers/specs/2026-07-20-manual-stun-port-search-design.md`.

**Truth Source:** `StunPortSearchController` is the canonical source for active/status/attempt/port/stability state; `WebRTC` is the canonical source for the live PeerConnection and UI projection.

**Compatibility Notes:** Existing automatic Strict STUN recovery remains unchanged when search is inactive. No `aioice` patch, fixed-port promise, new signaling event, TURN fallback, or tunnel fallback is introduced.

**Impact Map:**
- **Truth Source:** New controller module owns bounded manual-search state; `WebRTC` owns connection generation and live candidate events.
- **Backend:** Not applicable; existing offer forwarding already causes Host `on_offer` to recreate its PeerConnection.
- **Frontend:** New search controller, WebRTC lifecycle integration, button, candidate status projection, and diagnostic snapshot.
- **Runtime Proof:** Node tests, focused WebRTC tests, full frontend unit suite, and Playwright start/stop/success/exhaustion checks against the local viewer.
- **Docs/Skills:** Add spec/plan artifacts, update strict-STUN design/runbook/requirements language, and preserve the existing warning that ports are system-assigned.
- **Commit Boundary:** One feature slice containing the controller, Viewer wiring/UI, focused tests, and synchronized active docs; unrelated dirty files remain unstaged.

**Definition of Done:**
- The 500-round loop starts only from the search button, can be stopped, and never starts from ordinary WebRTC failure handling.
- Each round creates a fresh Viewer PeerConnection, reports candidate ports without IPs, and succeeds only after a selected pair plus three consecutive decoded-video samples.
- Search timers/generations are cleaned on success, stop, mode change, disconnect, logout, and exhaustion; existing Strict STUN fallback behavior and tests remain valid.
- Focused tests, the relevant full test suites, and browser acceptance pass; active docs describe the new manual behavior accurately.

---

### Task 1: Add the deterministic search controller

**Files:**
- Create: `web-client/js/stun-port-search-controller.js`
- Test: `web-client/js/stun-port-search-controller.test.js`

- [ ] **Step 1: Write failing controller tests**

Create tests using `node:test` and `node:assert/strict` for these exact behaviors:

```js
test('starts at zero and caps attempts at 500', () => {
  const search = StunPortSearchController.create({ limit: 500 });
  assert.equal(search.start().status, 'searching');
  assert.equal(search.beginAttempt('manual').attempt, 1);
  for (let index = 1; index < 500; index += 1) search.beginAttempt('retry');
  assert.equal(search.snapshot().attempt, 500);
  assert.equal(search.beginAttempt('overflow').accepted, false);
  assert.equal(search.snapshot().status, 'exhausted');
});

test('deduplicates valid viewer and host ports while retaining side-specific current ports', () => {
  const search = StunPortSearchController.create();
  search.start();
  search.beginAttempt('manual');
  assert.equal(search.recordPort('viewer', 53114), true);
  assert.equal(search.recordPort('viewer', 53114), false);
  assert.equal(search.recordPort('host', 49702), true);
  assert.equal(search.recordPort('viewer', 0), false);
  assert.equal(search.recordPort('host', 70000), false);
  assert.deepEqual(search.snapshot().current.viewerPorts, [53114]);
  assert.deepEqual(search.snapshot().current.hostPorts, [49702]);
  assert.equal(search.snapshot().uniquePortCount, 2);
});

test('requires three consecutive selected-pair video samples and resets on a gap', () => {
  const search = StunPortSearchController.create();
  search.start();
  search.beginAttempt('manual');
  const good = { selectedCandidateType: 'srflx', framesDecoded: 12, fps: 12 };
  assert.equal(search.observeMedia(good).status, 'searching');
  assert.equal(search.observeMedia({ ...good, framesDecoded: 0, fps: 0 }).stableMediaSamples, 0);
  assert.equal(search.observeMedia(good).stableMediaSamples, 1);
  assert.equal(search.observeMedia(good).stableMediaSamples, 2);
  assert.equal(search.observeMedia(good).status, 'succeeded');
});

test('stop prevents later failures or samples from advancing the search', () => {
  const search = StunPortSearchController.create();
  search.start();
  search.beginAttempt('manual');
  search.stop('user');
  assert.equal(search.failAttempt('ice-failed').accepted, false);
  assert.equal(search.observeMedia({ selectedCandidateType: 'srflx', framesDecoded: 30, fps: 30 }).status, 'stopped');
});
```

- [ ] **Step 2: Run the controller tests and verify the intended failure**

Run: `node --test web-client/js/stun-port-search-controller.test.js`

Expected: FAIL because `web-client/js/stun-port-search-controller.js` does not exist.

- [ ] **Step 3: Implement the minimal controller**

Implement `StunPortSearchController.create({ limit = 500 })` with:

1. `start`, `beginAttempt`, `recordPort`, `observeMedia`, `failAttempt`, `stop`, and `snapshot` methods matching the tests.
2. `beginAttempt` clears only current-round ports and increments until `limit`.
3. `recordPort` accepts only side `viewer|host` and integer ports `1..65535`, deduplicates current and historical ports, and never stores addresses.
4. `observeMedia` requires a selected candidate type and positive decoded frames/fps for three consecutive samples; any gap resets the counter.
5. All methods are no-ops after `succeeded`, `stopped`, or `exhausted` except `snapshot`.
6. Export with `module.exports` and leave a global `StunPortSearchController` for the browser.

- [ ] **Step 4: Run the controller tests**

Run: `node --test web-client/js/stun-port-search-controller.test.js`

Expected: PASS.

- [ ] **Step 5: Commit the isolated controller slice**

```bash
git add web-client/js/stun-port-search-controller.js web-client/js/stun-port-search-controller.test.js
git commit -m "feat(viewer): add bounded stun port search state"
```

### Task 2: Wire the controller into the Viewer and collect ports

**Files:**
- Modify: `web-client/viewer.html`
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/js/webrtc.test.js`

- [ ] **Step 1: Add failing WebRTC integration tests**

Add tests that inject a fake `StunPortSearchController` or load the real module and assert:

```js
test('manual port search starts only when explicitly requested in stun mode', () => {
  const { WebRTC } = loadWebRTC();
  const actions = [];
  WebRTC.networkMode = 'stun';
  WebRTC.socket = { connected: true };
  WebRTC.controlState = { hostOnline: true, controller: true, state: 'ACTIVE', lease: { leaseId: 'lease-000000000001', leaseEpoch: 1 } };
  WebRTC.refresh = () => actions.push('refresh');
  WebRTC.startPortSearch();
  assert.equal(WebRTC.isPortSearchActive(), true);
  assert.equal(actions.length, 1);
  WebRTC.stopPortSearch('test');
  assert.equal(WebRTC.isPortSearchActive(), false);
});

test('active port search uses full refresh and does not call restartIce or tunnel fallback', () => {
  const { WebRTC } = loadWebRTC();
  const actions = [];
  WebRTC.networkMode = 'stun';
  WebRTC.socket = { connected: true };
  WebRTC.startPortSearch();
  WebRTC.pc = { restartIce() { actions.push('restartIce'); }, close() {} };
  WebRTC.refresh = () => actions.push('refresh');
  WebRTC.scheduleReconnect('ice-failed');
  assert.equal(actions.includes('restartIce'), false);
  assert.equal(actions.includes('refresh'), true);
});

test('port status renders ports and never renders candidate IP addresses', () => {
  const { WebRTC, context } = loadWebRTC();
  WebRTC.networkMode = 'stun';
  WebRTC.startPortSearch();
  WebRTC.recordPortSearchCandidate('viewer', { candidate: 'candidate:1 1 udp 1 192.168.1.10 53114 typ host' });
  WebRTC.recordPortSearchCandidate('host', { candidate: 'candidate:2 1 udp 1 203.0.113.10 49702 typ srflx' });
  const text = context.document.getElementById('candidateDisplay').textContent;
  assert.match(text, /53114/);
  assert.match(text, /49702/);
  assert.equal(text.includes('192.168.1.10'), false);
  assert.equal(text.includes('203.0.113.10'), false);
});
```

- [ ] **Step 2: Run the focused WebRTC tests and verify failure**

Run: `node --test web-client/js/webrtc.test.js --test-name-pattern="port search"`

Expected: FAIL because the WebRTC methods and script dependency do not exist.

- [ ] **Step 3: Load the controller and add WebRTC search state**

Add `<script src="js/stun-port-search-controller.js"></script>` immediately before `webrtc.js`. Add fields for the controller, round timer, search generation, and 10,000 ms deadline. Add methods with these contracts:

```js
isPortSearchActive() -> Boolean
startPortSearch() -> Boolean
stopPortSearch(reason = 'user') -> void
recordPortSearchCandidate(side, candidateLike) -> void
schedulePortSearchRetry(reason) -> void
handlePortSearchMedia(stats) -> void
renderPortSearchStatus() -> void
```

`startPortSearch` must reject modes other than `auto|stun`, disconnected signaling, or offline Host; reset the controller, increment the search generation, and call `refresh()` once. `stopPortSearch` clears the timer and increments the generation. `schedulePortSearchRetry` must use one 10-second deadline plus a 250 ms delay, capture the generation and current `pc`, and ignore stale callbacks.

- [ ] **Step 4: Record local and remote candidates without IP display**

In the existing `pc.onicecandidate`, call `recordPortSearchCandidate('viewer', event.candidate)` before normal candidate forwarding. In the existing `ice-candidate` socket listener, call `recordPortSearchCandidate('host', data.candidate)` before `addIceCandidate`. Parse the candidate port from the structured `port` property first and the candidate SDP token at index 5 second. Render only side labels and numeric ports.

- [ ] **Step 5: Route active-search failures through full PeerConnection replacement**

At the top of `scheduleReconnect`, after manual-disconnect guards, branch to `schedulePortSearchRetry(reason)` when the search is active. Do not call `restartIce`, `Diagnostic.autoSendFailure`, `startTunnelRelay`, or mode fallback for individual search rounds. The retry callback invokes the existing `refresh()` so Host receives a new offer and closes/recreates its aiortc PeerConnection.

- [ ] **Step 6: Detect three stable media samples and stop on success**

After `processStatsSnapshot` derives `selectedCandidateType`, `framesDecoded`, and `fps`, call `handlePortSearchMedia`. On controller success, clear the deadline, mark the search successful, update the status text with the current round and ports, restore the button label, and leave the connected PeerConnection open. On each PeerConnection `connected` event, keep existing initialization and start the deadline; do not mark search successful until stats prove three samples.

- [ ] **Step 7: Add the button and lifecycle cancellation**

Add a `portSearchBtn` button next to `networkModeBtn` in the control bar. Bind one click handler in `DOMContentLoaded`: click starts or stops search. Update disabled/label state from `renderPortSearchStatus`. Cancel search in `setNetworkMode`, `refresh` when invoked by the normal refresh button, `disconnect`, and logout teardown. Keep normal reconnect behavior unchanged when inactive.

- [ ] **Step 8: Add the diagnostic snapshot**

Include `stunPortSearch: this.portSearchController?.snapshot() || null` in `collectNetworkSnapshot()`. Do not include candidate IPs or unbounded historical arrays.

- [ ] **Step 9: Run focused tests**

Run: `node --test web-client/js/stun-port-search-controller.test.js web-client/js/webrtc.test.js`

Expected: PASS, including the existing tests that assert inactive STUN recovery still tries the existing ICE restart path.

### Task 3: Synchronize active documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-06-29-strict-stun-resilience-optimization.md`
- Modify: `docs/runbook-safe-startup.md`
- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md`

- [ ] **Step 1: Write documentation assertions/checks first**

Use a shell check that fails until all three active docs mention the manual-only trigger, 500-round limit, and system-assigned-port limitation:

```bash
for file in docs/superpowers/specs/2026-06-29-strict-stun-resilience-optimization.md docs/runbook-safe-startup.md docs/需求文档/WebRemoteDesktop-需求文档.md; do
  rg -q "500" "$file" || exit 1
  rg -q "手动" "$file" || exit 1
  rg -q "端口" "$file" || exit 1
done
```

- [ ] **Step 2: Update the documents**

Document that the button is the only trigger for the 500-round search, success requires stable media, the UI shows numeric ports only, and the feature does not guarantee a unique port or override Strict STUN fallback policy. Replace any wording that says only one recovery attempt remains the sole path without distinguishing manual search.

- [ ] **Step 3: Verify documentation consistency**

Run the shell check above and `git diff --check` on all changed docs.

### Task 4: Full verification and browser proof

**Files:**
- No new files; verify the Task 1-3 changes.

- [ ] **Step 1: Run all relevant Node tests**

Run: `node --test web-client/js/stun-port-search-controller.test.js web-client/js/webrtc-stats.test.js web-client/js/webrtc.test.js web-client/js/diagnostic.test.js`

Expected: all tests pass with exit code 0.

- [ ] **Step 2: Run syntax and diff checks**

Run:

```bash
node --check web-client/js/stun-port-search-controller.js
node --check web-client/js/webrtc.js
git diff --check
```

- [ ] **Step 3: Run browser acceptance against the local service**

With the user-started local service at `http://127.0.0.1:8080`, use Playwright to verify:

1. `portSearchBtn` exists and initially reads `搜索端口`.
2. Clicking it changes the label to `停止搜索` and the candidate status contains `端口搜索 1/500` or `分配中`.
3. Clicking again restores `搜索端口` and no additional refresh occurs.
4. During a simulated candidate event, status shows UDP port numbers and no IP address.
5. A connected stream with three positive stats samples restores the idle button and leaves the video connected.

If the local service is not running, report that the browser proof could not run and do not start services automatically.

- [ ] **Step 4: Review scope and staged closure**

Run `git status --short`, confirm unrelated existing dirty files are not staged, and inspect `git diff --stat` plus the full focused diff. Do not claim the feature complete until tests and available browser proof are recorded.

- [ ] **Step 5: Commit the coherent feature slice**

```bash
git add web-client/js/stun-port-search-controller.js web-client/js/stun-port-search-controller.test.js web-client/js/webrtc.js web-client/js/webrtc.test.js web-client/viewer.html docs/superpowers/specs/2026-07-20-manual-stun-port-search-design.md docs/superpowers/plans/2026-07-20-manual-stun-port-search-plan.md docs/superpowers/specs/2026-06-29-strict-stun-resilience-optimization.md docs/runbook-safe-startup.md docs/需求文档/WebRemoteDesktop-需求文档.md
git diff --cached --check
git commit -m "feat(viewer): add manual stun port search"
```
