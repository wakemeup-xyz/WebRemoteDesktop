# Viewer Control Clock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Make private ACK, signaling recovery, freshness and cooldown durations independent of wall-clock adjustments.

**Architecture:** Keep existing Input/WebRTC owners and lifecycle. Migrate only selected private timestamp producer/consumer pairs to performance.now; represent unset origins with null so monotonic zero remains valid.

**Tech Stack:** Existing browser JavaScript and Node VM/node:test fixtures.

**Spec:** `docs/superpowers/specs/2026-10-17-viewer-control-clock-design.md`

## Global Constraints

- No new dependency, shared script/module, timer, wire field, timeout value, quality/network policy or native interaction.
- Keep ACK identity and admission fences, no business replay, manual/superseded cancellation and one-use proof unchanged.
- Preserve wall epoch protocol/identity/log fields; do not replace all Date.now calls.
- Production time source is performance.now, without Date.now/fixed-zero fallback. Existing supported browser API; offline fixtures provide a clock explicitly.
- No browser/network/service/tunnel/dependency operations; no primary checkout writes. Preserve unrelated dirty docs and stage only owned changes.

### Task 1: Migrate local input and recovery duration clocks

**Files:** `web-client/js/input.js`, `web-client/js/webrtc.js`; tests `web-client/js/input.test.js`, `web-client/js/webrtc.test.js`. Modify another VM fixture only when it invokes these changed real methods or sets a changed private field, with reason in report. KeyboardTransport production code is outside scope.

**Interfaces:** Private mouse pending sentAt, mobile down/up deadlines, WebRTC signal-start/inbound-progress/last-refresh/last-keyframe origins. No external signature change; all producers/consumers of each selected field use one clock. Existing null-safe reset/clear and callbacks retain ownership checks.

- [ ] Add actual Input regressions with two pending reliable writes and distinct wall/mono clocks. Assert oldest remaining2900ms after real100ms with ±60000ms wall steps, true3000ms timeout still invokes guarded recovery once, ACK removal advances to next oldest, obsolete scope cannot recover. Add mobile down/up ACK and rearm cases, true-late ACK and stale gesture/seq rejection.

```javascript
let mono = 0;
let wall = 1792208500000;
// VM performance.now: () => mono; independent Date.now: () => wall.
// Send through real Input methods and advance their fake timer queue.
mono = 100;
wall += 60100;
// After second write rearms oldest, expected remaining deadline = 2900.
// A valid first edge ACK at mono100 must not become late due to wall.
```

- [ ] Add actual WebRTC signaling recovery callbacks at mono0/1500/12000/13500 with wall ±60000. Preserve initial0 origin, recreate only at threshold, and clear/cancel on success/manualDisconnect/superseded. Add media freshness and refresh/keyframe cooldown checks with valid0 and unsetnull, real elapsed expiration, and wall jumps.
- [ ] Run named new tests before production edit, record assertion-based RED. Fixture/import failures do not count.
- [ ] Replace selected clocks and matching resets atomically. Representative code shape (adapt owner field names consistently):

```javascript
const now = performance.now();
if (this._signalRecoveryStartedAt == null) this._signalRecoveryStartedAt = now;
const elapsed = now - this._signalRecoveryStartedAt;
// For freshness/cooldown: test an explicitly set finite numeric origin,
// including zero, before subtracting; unset null never becomes a fake sample.
```

- [ ] Preserve first refresh/keyframe admission when origin is unset; after a request at mono0 the immediate duplicate remains cooled down. Do not change retry thresholds, epoch payload fields, keyboard owner or no-replay behavior. Update changed private-field fixtures from Date.now to their fake monotonic clock.
- [ ] Run `node --test web-client/js/input.test.js web-client/js/keyboard-transport.test.js web-client/js/webrtc.test.js`; syntax-check two production files and `git diff --check`. Use installed Node; do not npm test/pretest/build/dependency install.
- [ ] Self-review producer/consumer inventory, exact tests and no new wire timestamps; commit only owned files `fix(control): use monotonic clocks for local recovery deadlines`. Write full report with RED/GREEN commands/results and source commit.

### Task 2: Independent review and controller-owned delivery

- [ ] Package exact task diff; independent spec/quality review before deploy, resolve all important findings.
- [ ] Build reviewed frontend in temporary output, preserve current and previous retained assets; verify frozen source/manifest. Deploy only reviewed increment with fresh zeroViewer proof and baseline/hash checks.
- [ ] Restart only the authorized local component needed by deployment; never tunnel. Verify actual build, Host online, formal normal-browser login and current credentials.
- [ ] New proof-guarded TURN/JPEG sessions must use real UI Start and final report their actual durations, identities, frame gaps and signal events. Keep earlier failed runs and native input-to-visible NOT RUN explicit; proceed to long-run qualification after short cases pass.
