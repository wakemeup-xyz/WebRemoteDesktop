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
