# Task 1 implementation report — nullable media latency

Date: 2026-10-17. Base: `70789fac4118a4bb9d00bb01892d587fe6adfda8`.
Source/test commit: `9e57bf470ceb8a8e47c15802c401e28665a64c62` (`fix(media): preserve nullable latency through consumers`).

## Scope and result

Implemented the existing M1 nullable-duration contract for only `rttMs` and `jitterBufferMs`. JavaScript accepts finite nonnegative numbers; Python accepts finite nonnegative int/float and rejects bool. Missing, null, strings, booleans, objects, NaN, infinities and negative values become null/None. Actual numeric zero and positive fractional values retain their payload values.

Five production files changed:

- `web-client/js/webrtc.js`: canonical nullable fields, real receiver/controller and outbound stats chain, nullable paint-cache buffer, selected-pair RTT normalization/default null, independent RTT/buffer UI and zero-safe network guidance. LatencyMonitor receives the original sample with only these two fields normalized, preserving unrelated legacy counter semantics.
- `web-client/js/link-quality-controller.js`: strict normalization for direct callers; known-only latency comparisons; missing latency breaks the good/degraded/critical streak when no measured bad signal exists. Known high RTT/jitter, real loss and measured decoder/media stalls retain the existing path-specific and Quality Lock decisions.
- `web-client/js/diagnostic.js`: nullable buffer in actual connection diagnostic, preserving zero without coercion.
- `signal-server/websocket/signaling.js`: normalize only these two forwarded scalars after existing viewer/activity/recovery admission, following the data spread and preceding existing authoritative recovery/viewer overrides.
- `python-host/host.py`: both existing stats logs consume normalized local latency values and emit fixed `null` for unknown; recovery identity, counter parsing, stall thresholds and decoder observer order are untouched.

No production change to redactor, stats producer, monitor, input protocol, encoding/capture policy, thresholds, tunnel or runtime. Existing M6 RTT-tooltip behavior remains and its tests pass. No primary checkout, service, browser, network, native capture/input, dependency installation, dist build, npm test/pretest or tunnel action occurred.

## Behavioral evidence

- Real processStatsSnapshot -> handleReceiverStats -> real controller, fake connected socket recorder and DOM: unknown matrices independently/mixed across both fields, default/provided selected-pair RTT, valid zero/positive fractions, UI text/title, paint cache, controller goodCount, outbound fields, real LatencyMonitor values and unchanged connected phase.
- Real controller observe: direct/relay and Quality Lock on/off; near-upgrade streak interrupted by every unknown form, repeated unknown samples cannot upgrade/request keyframe/restart ICE/degrade; actual zero permits a fresh ten-sample upgrade. Known congestion remains actionable with the other latency unknown. Actual decoder-stall results match known-latency results sample-by-sample.
- Host/prflx/relay guidance distinguishes `RTT 0 ms` from unavailable.
- Actual diagnostic builder preserves nullable buffer and unrelated M1 window/count/last values. Runtime-v3 redactor plus ingest omits unknown optional buffer and retains actual zero/positive values. The initial redactor test mistakenly used a legacy-shaped payload, was corrected to a full actual runtimeFixture; production redactor already satisfied this contract.
- Registered FakeSocket signaling viewer-stats handler covers unknown/missing/scalar matrix and numeric zero/positives; retained aliases and authoritative identity; non-viewer, stale attempt and disconnected viewer stay rejected.
- Real async Host handler with object.__new__ fixtures logs unknown safely for legacy and bound identities. Existing causal IDR recovery sequence is parameterized for known, null, string, bool and NaN latency and retains identical recovery/stall-count expectations and stale identity rejection. Autouse barriers forbid host MSS/InputHandler construction before any test handler runs.

## Commands and outcomes

All commands below ran from `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`.

Initial regression evidence before production edits:

```sh
node --test --test-name-pattern='nullable media latency|unknown latency|unknown peer latency|connection diagnostic keeps nullable' web-client/js/webrtc.test.js web-client/js/link-quality-controller.test.js web-client/js/diagnostic.test.js
```

7 selected tests: 1 passed, 6 failed as expected (false good streak / zero coercion).

```sh
node --test --test-name-pattern='viewer-stats normalizes|nullable buffer redactor' signal-server/websocket/signaling.test.js signal-server/test/diagnostic.test.js
```

2 selected tests failed: signaling exposed missing->undefined forwarding; redactor fixture issue described above.

```sh
PYTHONPATH=python-host /Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m pytest python-host/test_quality_lock.py -k nullable_latency -q
```

22 failed, 6 passed, 22 deselected before production correction; unknown logs contained raw invalid values/defaults.

Final regression commands:

```sh
node --test web-client/js/webrtc.test.js web-client/js/link-quality-controller.test.js web-client/js/diagnostic.test.js web-client/js/latency-monitor.test.js web-client/js/webrtc-stats.test.js
node --test signal-server/websocket/signaling.test.js
node --test --test-name-pattern='^(?!POST |GET |admin observability)' signal-server/test/diagnostic.test.js
PYTHONPATH=python-host /Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m pytest python-host/test_quality_lock.py python-host/test_stall_decoder_refresh.py -q
git diff --check
```

Final Viewer run passed 359/359. Final Signal FakeSocket suite passed 109/109. Offline diagnostic subset passed 25/25. Python passed 51/51. Diff whitespace check passed. All final commands exited zero. Before commit, the staged diff contained exactly the five production files and seven named test files; after commit, the index was empty and all owned source/test paths were clean.

The diagnostic name filter excludes seven existing real-listen HTTP/admin cases. They were NOT RUN because this task forbids network/service startup; it runs actual redactor/ingest and in-memory socket cases without starting a server. No production dist was rebuilt.

## Limits and handoff

Offline source/test acceptance only. Production loading, refreshed Viewer compatibility and real media/long-session/optical latency acceptance remain NOT RUN for this task. Old Viewer-synthesized numeric zero cannot be distinguished from actual zero; refreshed Viewer is needed for full unknown propagation. This change does not claim to solve TURN jitter. Existing unrelated dirty README/runbook/requirements/review anchor and all other agent files remain outside the commit.

The requested SDD report stays private/ignored per root instruction; root will archive it to tracked docs in the final documentation commit. Root exclusively handed the index to this task before staging. The scoped commit is complete; the empty index is released to root. No further source or index writes are planned during root review.
