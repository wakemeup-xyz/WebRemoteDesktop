# Task 1 — Viewer local duration clocks

Status: implementation complete; offline required suites GREEN. Independent review, build/deployment and browser/native/long-session acceptance are NOT RUN by this worker.

- Worktree: `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`.
- Base: `836dccd22d501134dcffd2651303f502f94740a8`.
- Source commit: `3ca62fedb26dcf3f4dc53497af5a84af4dae622f` — `fix(control): use monotonic clocks for local recovery deadlines`.
- Specification: `docs/superpowers/specs/2026-10-17-viewer-control-clock-design.md`.
- Installed Node: `v24.15.0`.
- Read AGENTS, task brief and linked spec; did not read accumulated remediation plan. No subagents dispatched, per direct task instruction.

## Changed files and clock inventory

Only these five source/test files are in the source commit:

| File | Change |
| --- | --- |
| `web-client/js/input.js` | `_desktopWritePending` producer `sentAt` and oldest deadline consumer both use `performance.now()`. Mobile `downDeadline` and `upDeadline` producers, earliest-edge scheduling/rearm, and ACK late comparison all use the same page clock. |
| `web-client/js/webrtc.js` | `_signalRecoveryStartedAt` initialization/reset is `null`, and creation, elapsed scheduling, retry callback and post-recreate origin use `performance.now()`. `_lastInboundFramesDecodedAt` initialization/attempt reset is `null`; positive decoded progress records page time and finite numeric origins, including zero, participate in freshness. `_lastRefreshAt` initializes `null`; actual refresh and both refresh/reconnect cooldown consumers use page time. `_lastKeyframeRequestAt` initializes/resets `null`; generation reset and finite-origin cooldown support a first request at zero and reject an immediate duplicate. |
| `web-client/js/input.test.js` | VM explicitly supplies Performance API; accepts fixture overrides. Eight tests use independent wall and page clocks with a page-time timer queue on real Input methods. |
| `web-client/js/webrtc.test.js` | Seven tests use independent wall and page clocks and actual signaling/freshness/cooldown methods. Existing private-field fixtures now use their explicit VM page clock or `null` for unset. |
| `web-client/js/input-backpressure.test.js` | One-line explicit `performance.now: () => now` fixture addition. This fixture invokes the changed real `_sendInput` and deadline methods, but previously supplied only Date. This is the task brief's permitted additional VM fixture adjustment; no production fallback was added. |

The pending maps still clear/delete through their existing owners. Mobile up deadline remains `null` before up exists. All selected producers and consumers were enumerated with `rg` and reviewed. `Number.isFinite` rejects null, undefined, non-numeric and non-finite freshness/cooldown origins without rejecting zero.

## Assertion-based RED before production edits

Exact test invocation (output redirected to local evidence):

```sh
node --test --test-name-pattern='duration clock:' web-client/js/input.test.js web-client/js/webrtc.test.js > /tmp/wrd-viewer-clock-red.log 2>&1
```

Result: **15 tests; 1 passed; 14 failed**, all failing new tests reached assertions (`ERR_ASSERTION`), not imports or fixture initialization errors. Production files were still at BASE. The obsolete-scope guard was already correct and passed.

Observed examples:

- After real 100ms, second reliable write rearm produced **62900ms** after -60000ms wall step and **0ms** after +60000ms, instead of **2900ms**.
- Backward wall step prevented the expected real 3000ms timeout; forward wall step caused recovery before real 2999ms.
- Mobile rearm produced **3000ms** or **0ms** instead of earliest **2900ms**; genuinely late ACK remained `pending` under the backward wall step.
- Signaling origin was the wall epoch `1792208500000` instead of page zero. Freshness/cooldown unset origins and recovery clearing yielded zero rather than required null.

The mobile/refresh fixtures were subsequently configured for their intended supported paths (relay cooldown test supplies an explicit fake TURN configuration). No production behavior was broadened to accommodate a fixture.

## GREEN and checks

Targeted tests after production migration:

```sh
node --test --test-reporter=tap --test-name-pattern='duration clock:' web-client/js/input.test.js web-client/js/webrtc.test.js > /tmp/wrd-viewer-clock-targeted.log 2>&1
```

Result: **15 passed, 0 failed**, exit 0.

Required exact suite invocation:

```sh
node --test web-client/js/input.test.js web-client/js/keyboard-transport.test.js web-client/js/webrtc.test.js > /tmp/wrd-viewer-clock-exact-green.log 2>&1
```

Result: **427 passed, 0 failed**, exit 0. No cancelled/skipped/todo tests. Earlier equivalent TAP invocation also passed 427/427 after three existing WebRTC fixture assumptions were reconciled. The initial full-suite run before fixture reconciliation had 424 passes/3 failures; those were the old freshness epoch, positive-delta Date fixture and unset-zero refresh fixture, not independent production failures.

Checks:

```sh
node --check web-client/js/input.js
node --check web-client/js/webrtc.js
git diff --check
git diff --cached --check
```

All exit 0; syntax checks and diff checks are clean. Staged paths were inspected before commit and contained only the five files above.

Coverage includes:

- Two reliable pending writes, +/-60000ms wall steps, 2900ms earliest remaining deadline at real 100ms, ACK removal advancing to second origin, real timeout at 3000ms, real guarded automatic recovery generation/reset exactly once, and obsolete lease/attempt unable to recover.
- Real mobile down/up sends, ACKs and rearm; stale gesture IDs and insufficient sequence cannot confirm current edge; true late ACK remains uncertain.
- Actual signaling callbacks from page zero through 1500ms, 11999ms, 12000ms and 13500ms; recreate only at threshold and preserve original zero until then. Success/manual disconnect/supersede cancel timers and clear origin to null; fake queue after cancellation cannot reconnect.
- Actual decoded-progress producer at zero, freshness through 5000ms and expiry at 5001ms; zero decoded progress cannot refresh its origin.
- Actual refresh at zero, first keyframe allowed from unset, immediate duplicate blocked, 999/1000ms keyframe cooldown, refresh/reconnect 3000ms boundary, and new keyframe generation admission.

## Adjacent suites and known baseline failures

Because the producer/consumer inventory found another real Input VM fixture, the following bounded adjacent test command was run:

```sh
node --test --test-reporter=tap web-client/js/input-backpressure.test.js web-client/js/input-recovery.test.js web-client/js/input-signaling-continuity.test.js web-client/js/webrtc.frame-trace.test.js web-client/js/diagnostic.test.js > /tmp/wrd-viewer-clock-adjacent.log 2>&1
```

Result: **154 passed, 2 failed**, exit 1. Both failures are in untouched `input-signaling-continuity.test.js`:

1. `relay image load retained across attempt or producer replacement has no authority`: `TypeError: load is not a function`.
2. `real tunnel refresh establishes local relay and waits for current ACK plus loaded frame`: expected `active`, actual `resuming`.

Confirmed both are pre-existing against BASE: a temporary `/tmp/wrd-viewer-clock-baseline.cjs` preload contains `git show 836dccd22d501134dcffd2651303f502f94740a8:web-client/js/input.js` and `...:web-client/js/webrtc.js` source strings and substitutes only those two `fs.readFileSync` results while the original test file runs. It neither edits worktree files nor changes running processes.

```sh
node --require /tmp/wrd-viewer-clock-baseline.cjs --test --test-reporter=tap --test-name-pattern='relay image load retained|real tunnel refresh establishes' web-client/js/input-signaling-continuity.test.js > /tmp/wrd-viewer-clock-baseline-adjacent.log 2>&1
```

Baseline result: **0 passed, same 2 failed**, exit 1, with the identical TypeError and assertion. These relay fixtures/code were not changed under this task. Do not describe all adjacent tests as green.

## Self-review

- No new dependencies, shared modules, timers, external signatures, wire timestamps, timeout values, network/quality policy or business replay were introduced.
- Existing reliable admission, scope/lease/attempt/socket fences, callback ownership, automatic recovery budget, cancellation and proof authority remain intact. Existing required tests, including KeyboardTransport, pass.
- `Date.now()` is preserved for opaque input/request/attempt IDs, diagnostics/log epoch fields, control-clock synchronization, non-selected unordered hints and wheel/UI bookkeeping; `_recoveryCycle.deadline` remains outside scope. KeyboardTransport production code is unchanged.
- `_lastKeyframeRequestAt` also appears in diagnostics as a request-presence indicator; actual requests still set `_keyframeRequested`, so a valid timestamp zero remains visible through that existing flag. No diagnostic production change is needed.
- No browser, real input, native events, network/service/tunnel, build/dependency or primary-checkout actions were performed. The node_modules symlink and unrelated dirty README/runbook/requirements/review-anchor files were not edited/staged by this worker. Root has concurrent documentation work; its changes are excluded from the source commit.
- Source commit and offline verification do not prove deployment or real visible input effectiveness; those remain controller-owned acceptance work.
- No actionable issue found within the final Task 1 production diff. Known adjacent relay fixture failures remain explicitly recorded above.

This report is intentionally written only to the requested ignored task directory. Root will create the versioned report mirror and update plan/spec/review records centrally. Worker index ownership ends when this report and commit are handed back.
