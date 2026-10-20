# W4b implementation and offline review — 2026-10-17

Baseline: `60ccbbe` (W4a), including I1 fixture commit `3bcb5d6`. This task changes only final Viewer rendering; the root task owns deployment, service acceptance, requirements/runbook integration and independent review.

## Implementation

- `web-client/js/chrome-layout.js`: derive a mounted-node map of fixed DOM fields (`disabled`, `hidden`, `title`, ARIA disabled, modal/loading classes and pointer events), then compare each field with the last per-root render in a `WeakMap`. Replacement nodes render afresh; a released root can be collected. No PC/media object serialization or timestamp/frame-based render key.
- `ChromeLayout.invalidate(root, reason)` discards only the render projection. Existing fullscreen, visualViewport/window/virtual-keyboard, dock/status ResizeObserver and Terminal/layout mutation routes invalidate it and retain the existing scheduled layout batch. Root class/data-theme changes also invalidate. No input geometry cache or changed coordinate mapping is introduced.
- `web-client/js/input.js`: the keyboard label, mobile editor controls, recovery notice and virtual modifiers compare derived display fields with DOM before writing. Gate, recovery, draft and controller derivation still runs every call. `Input.setActive` is unchanged, including same-value automatic recovery and lease-epoch observation.
- `web-client/js/webrtc.js`: loading/HUD classes and connection status compare final visible fields before writing. `markMediaAttemptReady`, the authority path in `setUiPhase`, the full rVFC callback and `observePaintFrame` remain unchanged. No M2 identity, observer, trace gate or sampling changes.
- Behavioral tests: `chrome-layout.test.js`, `input-signaling-continuity.test.js`, `webrtc.test.js`.

## RED → GREEN evidence

All commands used direct `node --test`; no npm pretest, dependency installation, dist build, browser, network, capture or native input.

1. Real ChromeLayout and counting refresh-only DOM: initial render 3 writes; 200 repeated fresh snapshots produced 603 writes before the implementation (RED), and remain at 3 after it (GREEN). Epoch/frame fields vary without changing the derived projection. The original ChromeLayout suite plus these initial tests passed 41/41; final mobile/theme/root-isolation additions bring this file to 43 tests.
2. Real Input same-value activation: initial 20 counted writes became 4,020 before final UI guards (RED), and remain at 20 across the 200 repeated activations (GREEN). The recovery entry runs 201/201 times. A changed lease epoch is subsequently observed with the same active value; keyboard RESET_REQUIRED, recovery WAITING, uncertain draft and node replacement each update their respective UI.
3. Production rVFC path with real ChromeLayout, mounted counting nodes and a verified receiver track/SSRC: initial 62 writes became 1,662 after 200 more frames before loading/status guards (RED), and remain at 62 after them (GREEN). The same test asserts 201 frame-sequence advances, activations, LatencyMonitor observations, frame-trace observations, input-frame observations and resume-barrier observations. M observations retain the actual last callback time 3,200 and RTP timestamp 300; paint observation records all 200 intervals. Session media transitions execute at least once per callback. A retained callback from an older attempt performs no further advance.

Final targeted command:

```sh
node --test --test-concurrency=1 web-client/js/chrome-layout.test.js web-client/js/webrtc.test.js web-client/js/input-signaling-continuity.test.js
```

Result: **310/310 PASS** (18.5 s). The final lease/keyboard assertions were then additionally run with `node --test web-client/js/input-signaling-continuity.test.js`: **33/33 PASS**.

Additional UI/recovery regression command:

```sh
node --test --test-concurrency=1 web-client/js/input.test.js web-client/js/input-recovery.test.js web-client/js/terminal-input-gate.test.js web-client/js/mobile-text-input.test.js
```

Result: **206/206 PASS** (9.7 s). `git diff --check`: PASS.

Ephemeral local evidence: `/tmp/wrd-w4b-chrome-red.txt`, `/tmp/wrd-w4b-chrome-green.txt`, `/tmp/wrd-w4b-input-red.txt`, `/tmp/wrd-w4b-input-green.txt`, `/tmp/wrd-w4b-rvfc-red.txt`, `/tmp/wrd-w4b-rvfc-green.txt`, `/tmp/wrd-w4b-targeted-green.txt`, `/tmp/wrd-w4b-ui-regression.txt`.

## Self-review and specification mapping

- C authority/input recovery: no early return added around `Input.setActive`, session mutation, ACKs, grant/revoke, reset, media readiness or fresh-frame barrier. Same-value/epoch behavior and real continuity/reset tests remain covered. Existing old-attempt and old-PC callback tests stay green.
- M observation: no rVFC downsampling, omitted frame sequence, rewritten timestamp, inferred one-way time, changed join identity or trace gating. The new counting adapters delegate to real session mutation and observe every verified frame. Existing five-second geometry/paint aggregation and frame-join fixtures stay green.
- W4b render contract: fixed derived fields only, per-root weak cache, mounted node replacement, explicit invalidation, Terminal/modal state, touch keyboard/viewport and latched-modifier release are covered. Input UI equality checks inspect DOM fields only and execute after all state derivation.
- Global constraints and spec §8: this narrow rendering task preserves authentication/deferred-loader, release assets, probe/watcher and entry recovery boundaries. It does not claim new coverage of those independent §8 mechanisms; root integration tracks their tasks. No network-mode, TURN, URL, quality-lock or chosen-resolution mutation. No persistence of input IDs, text, coordinates, credentials or URLs is added.
- M1 signatures, metric names, scope outcomes and M3 queues are untouched. No timers, queues, runtime dependencies, diagnostic payload fields or new asynchronous business callbacks are added.
- Change scope: six Viewer source/test files and this report. Pre-existing or concurrent README, runbook, requirements, execution ledger, archive and M4/M5 changes are excluded.

## Limits and remaining acceptance

These are deterministic **offline PASS** results for DOM writes and preserved call/observation counts. Per-frame business derivation still runs; reduced DOM writes are not a measured reduction in total input or presentation processing time.

**NOT RUN:** production dist rebuild/deployment, real Viewer or service restart, real public cold-start P95, browser CPU/long-task profile, cross-deployment login acceptance, mobile device acceptance, at least three-hour Viewer session, physical visible-effect/optical latency. Existing services and tunnel were not touched by W4b. The root task owns any separately authorized acceptance.

## R1 — reconcile intervening production DOM writers

Independent review found one P2 in `e5e086d`: the Chrome cache assumed it exclusively owned mounted fields. A second real `WebRTC.updateControlUI('只读')` changed the Terminal request-control button back to `disabled=false`, while the cached model and `aria-disabled` still said `true`. The original implementation's claim of preserved Terminal state was incomplete until this repair. The ignored review and counterexample remain under `.superpowers/sdd/2026-10-17-reliability-latency-remediation-plan/`.

Exact new integration RED: `node --test --test-name-pattern='real control writer|real mobile and port-search writers' web-client/js/webrtc.test.js` failed both tests before R1. The real control-writer test fails on its second update (`false !== true`), matching the independent counterexample. The real Input test also exposes its mobile-button writer restoring a Terminal-hidden button. This uses real production writers and ChromeLayout, with the existing offline VM/DOM fixture.

R1 changes:

- Chrome's final fixed-field comparison now reads the mounted DOM value. Even an unchanged cached model repairs fields changed by another writer; only mismatched fields are written. Cache/model equality is used as fallback for write-only DOM shims, where a getter is unavailable. Node replacement and explicit invalidation still render afresh.
- Mobile support, Input activation and capability/Terminal gates now derive compatible final mobile-button values in Chrome and Input. Input also synchronizes `aria-disabled`. This avoids alternating writes between two renderers on stable frames.
- The port controller owns its explanatory title and loader/retry decision. Its disabled decision becomes an explicit derived Chrome snapshot boolean; the final projection combines it with capability/Terminal gates. `renderPortSearchStatus` finishes with capability reconciliation, so a tool retry cannot reopen a Terminal-gated button, and an allowed loading tool remains disabled with matching ARIA.
- No control business update is suppressed. `updateControlUI`, same-value `Input.setActive`, session transitions, recovery, frame identity, rVFC, latency observations and resume barriers continue to execute. Added snapshot values are bounded UI booleans only; M1/M2/M3 interfaces and metrics are unchanged.

The request-control and mobile/port integration regressions now pass. A counting-DOM test repairs exactly the three externally changed disabled/hidden/ARIA fields, followed by 200 stable calls with no further writes. The production rVFC fixture now runs twice, including **real Input** instead of only the activation stub. Both variants assert no extra DOM writes over 200 stable frames, all 201 C/M observations and the old-attempt callback veto. Audit covers pointer-only mobile support, touch Terminal veto, port loading, failed-tool retry, ready-tool state and Terminal retry closure.

R1 focused verification: **4/4 PASS** for both rVFC variants and the two production-writer integrations; ChromeLayout **44/44 PASS**. Final combined offline command:

```sh
node --test --test-concurrency=1 web-client/js/chrome-layout.test.js web-client/js/webrtc.test.js web-client/js/input-signaling-continuity.test.js web-client/js/input.test.js web-client/js/input-recovery.test.js web-client/js/terminal-input-gate.test.js web-client/js/mobile-text-input.test.js
```

Result: **520/520 PASS**, 29.5 s; scoped `git diff --check`: PASS. Ephemeral evidence: `/tmp/wrd-w4b-r1-red.txt`, `/tmp/wrd-w4b-r1-green.txt`, `/tmp/wrd-w4b-r1-chrome.txt`, `/tmp/wrd-w4b-r1-regression.txt`.

R1 scope: `chrome-layout.js`, `chrome-layout.test.js`, `input.js`, `webrtc.js`, `webrtc.test.js`, and this report. No unrelated integration/M4/M5 changes staged. Self-review checked every shared field and every new dependency against the final projection; no whole-model early return, performance-clock key, whole-PC serialization or blanket per-frame write was added. All real deployment/device/browser-profile/public-network/long-session acceptance listed above remains **NOT RUN** for W4b. Root arranges independent R1 review after the scoped commit.
