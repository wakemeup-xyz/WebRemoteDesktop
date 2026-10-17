# M6.1–M6.3 implementation report

Status: implemented and offline verified; independent review and M6.4 deployment/live acceptance remain with root. Base: `86c2e343870738cfb6c984d3fe93c348bdc875b5`. One coherent runtime protocol commit: `5e6c26c5ca46adc89311f5caafbeb30f19ef5ff8` (`fix(media): recover stalled JPEG relay with scoped frame proof`).

## Changes

- Host retires slots at `now_ms - sent_at_ms >= 2000`, before admission, after wait timeouts and before ACK matching. Matched ACKs release exactly their own slot and wake before updating a max watermark. Expired/foreign/duplicate ACKs cannot create RTT/quality samples. Emit failures wake and release immediately. TTL retirement adds no quality downshift; historical timeout/valid-ACK adaptation remains.
- Each real successful start gets a new UUID producer. Capture requests and inflight metadata retain the complete immutable origin; current authority, generation and scope fence worker completion and emit. Ordinary strict start validates the actual active authority/media binding under the existing media lock, including legal initial media generation zero. Its separate random request ID is echoed in a `relayControlKind: start` ACK. Positive explicit media controls preserve the existing runtime path and expose current producer scope for suspend/resume.
- Signal validates ordinary strict start without inventing attempt authority or incrementing media generations. Existing dual ACK routes retain the new source/request fields. Actual frame/ACK/feedback handlers retain original scope, route only under current Host/current owner authority and preserve legacy companion admission. Feedback is explicitly whitelisted, including `coalescedCount`; raw lease IDs and other arbitrary fields are discarded from feedback.
- Viewer ordinary start synchronously clears painted/attempt-ready/origin/load proof and invokes the existing safe Input release/reset path. Pending start, accepted start ACK without image load, old scope, replaced image callback and old socket cannot enable business input. Qualified onload checks the complete scope and an image request token again, echoes the original origin in its ACK and updates readiness using existing media/reset state.
- One token-fenced current-scope timer uses Viewer monotonic time. At JPEG image load age >=5000 ms, it sets `media-stalled`, closes input and calls existing keyboard/pointer release/reset paths, including already-inactive pressed/RESET_REQUIRED keyboard state. Fresh load can restore media only; current C3 reset identities still own business admission. The same timer expires the RTT UI sample even if images have already stalled. Qualified-load FPS uses a short window and becomes zero on stale transition.
- Host produces at most one feedback per scope per second from the real loop's shared admission/wait tick, with one latest unsent matched RTT sample, bounded counters and nullable Host-clock ages. Full-scope counters/sequences reset on origin change; counters saturate, sequence exhaustion disables that observation. Viewer validates source and two separate high watermarks, records through real `LatencyMonitor.recordStage`, and uses full canonical origin SHA-256 plus sample sequence as its bounded key. Hashing is optional diagnostics and never awaited for media. Current-origin UI state is independent of still-valid earlier producer samples in the same collector scope.
- Removed relay `Date.now() - timestamp`, `renderedAt`, client `latencyMs` and the approximate-one-way-delay copy. UI identifies JPEG feedback RTT and its TTL/latest-per-interval selection limits. ±1-day image timestamp tests leave measured RTT unchanged.

## RED evidence

1. Before implementation, from `python-host/`:

   `python3 -B -m pytest test_tunnel_relay.py -q`

   **2 failed, 9 passed**: ACK 99 then 98 retained slot 98; `expire_inflight` did not exist.

2. The newly added integration tests were also executed against the immutable base's source (no checkout mutation). Base `webrtc.js` and `signaling.js` were materialized with `git show 86c2e343870738cfb6c984d3fe93c348bdc875b5:<path>` into `/tmp/m6-baseline-{webrtc,signaling}.js`. `/tmp/m6-baseline-loader.cjs` intercepts only the selected source file's `fs.readFileSync` in that test process and otherwise delegates to the original reader. It does not change tests or production files.

   `M6_BASELINE=viewer node --require /tmp/m6-baseline-loader.cjs --test --test-reporter=tap --test-name-pattern='pending JPEG|ordinary generation-zero' web-client/js/webrtc.test.js`

   **3 failed, 0 passed**. Actual pending-start fallback retained painted proof (`true !== false`); ordinary start lacked legal generation-zero request fields (`undefined !== 0`).

   `M6_BASELINE=signal node --require /tmp/m6-baseline-loader.cjs --test --test-reporter=tap --test-name-pattern='strict ordinary|registered relay' signal-server/websocket/signaling.test.js`

   **2 failed, 0 passed**. The base dropped scoped ACK fields and had no feedback route.

Bounded test outputs: `/tmp/m6-viewer-red.log`, `/tmp/m6-signal-red.log`. These are offline fixture data; no production input or screen data was persisted.

## Final GREEN evidence

From the assigned worktree root:

`python3 -B -m pytest python-host/test_tunnel_relay.py python-host/test_relay_frame_worker.py python-host/test_offer_epoch.py python-host/test_viewer_session_rebind.py -q`

**106 passed in 4.72 s, no warnings.** Output `/tmp/m6-python-final.log`.

`node --test --test-reporter=tap web-client/js/webrtc.test.js web-client/js/latency-monitor.test.js web-client/js/media-activity-runtime.test.js web-client/js/input-recovery.test.js signal-server/websocket/signaling.test.js`

**457 passed, 0 failed, 0 skipped, 24.824 s.** Output `/tmp/m6-node-final.log`.

`git diff --check` passed. No npm test/pretest, install, build, browser, live network, service, tunnel or primary-checkout operation was used.

Actual integration coverage includes: real `_run` no-feedback production through 12 seconds and 15 minutes of fake time, third distinct capture within four wait timeouts, one worker and bounded one/two slots; reordered/11-second/TTL boundary ACKs, failed emit, producer ID reuse, scope change during worker completion, safe integer boundaries and telemetry exhaustion; actual generation-zero Viewer→registered Signal→real Host→Signal→Viewer handshake using one canonical JSON request/ACK dictionary; ordinary restart and WebRTC fallback from actual prior input-enabled sessions; pre-ACK/foreign/replaced onload cases; real held keyboard/pointer reset and current-reset-ACK convergence, including rejected/timeout and already-inactive cases; real collector preserving producer A/sample1, B/sample1 and resumed B/sample1 plus independent input metrics; full 128-character attempt/64-character producer canonical digest, late/absent hash and stale socket suppression; TTL/latest-sample coalescing; shared image/RTT timer expiration and counter/null semantics.

## Offline fixture boundary incident and containment

During an intermediate run of `test_two_real_starts_get_distinct_producers_despite_reused_frame_and_generation`, the fixture started two real streamer tasks and awaited `first.stop()` before cancelling the second. That await allowed the second task's JPEG worker to enter the real `RelayJpegProcessor.__call__`. Pytest reported one `DeprecationWarning` at `host.py:606`, `self.sct = MSS()` (106 passed, 1 warning). This was an unintended violation of the fake-capture-only boundary and was reported immediately to root.

What is proven: the real processor callable reached the MSS construction call. That run did not instrument MSS construction completion, `grab`, processing completion or JPEG delivery, so **whether a real grab/process completed is unknown**; this report does not claim that no real capture occurred. No service or production connection was started. No screenshot/JPEG from that execution was persisted as an artifact. Its `finally` awaited both `stop()` calls; the run completed without pending-task diagnostics. Exact native-close instrumentation was absent, so original native resource closure is supported by the normal `stop`/worker-finally close path rather than a separate captured close event.

Correction: that test now injects an explicit offline processor **before either start**, cancels both streamer tasks before its first teardown await, awaits both real stop methods, and asserts both task references and worker references are cleared and the fake processor had zero calls. Every relay pytest also has an autouse native-MSS guard that raises and records any attempted native capture, with a teardown assertion. The cross-language CLI fixture injects its fake processor before invoking real handlers. The final 106-test run passes cleanly with these guards; no warning was ignored or suppressed.

## Self-review and remaining boundaries

Self-review found and fixed: scope binding on suspended as well as active media control; accidental duplicated test protocol declarations introduced by a broad fixture edit (original existing Signal tests restored unchanged); 5-second RTT UI expiry after an image stall; token fencing of stale same-scope timer callbacks; strict ASCII rejection including trailing newline; and duplicate start input invalidation. Tests continued to assert actual business dispatch, not only UI or `Input.isActive`.

Scope counters do not reset the latency collector. SHA-256 availability never affects media. No reset/authority barriers were cleared by implementation or test helpers. Legacy frames cannot be strict proof. No new dependencies, controller, mode changes, resolution/Quality Lock changes or unbounded frame/sample/task history were introduced.

Live JPEG/TURN acceptance, actual deployed identity, true input-visible effect and 3-hour continuity are **NOT RUN by this implementer** and remain root-owned M6.4. The accidental native fixture incident is not acceptance evidence. Browser timer scheduling may delay the 5000-ms check; report observed age rather than promising execution while the browser is frozen. RTT population remains right-truncated by the 2000-ms slot TTL and then latest-per-interval selected.

## Root observer field map (read-only, no new product API)

- `WebRTC._relayExpectedScope`: complete ACK-accepted producer origin.
- `WebRTC._lastRenderedRelayFrame.relayScope`: complete origin of the last qualified loaded image; `frameId` and `frameSeq` are distinct. Its older `.scope` field is the existing local media baseline and contains private objects/lease data; do not persist it.
- `WebRTC._relayLastLoadedAtMs`: Viewer `performance.now()` clock of the last qualified image load; use Viewer same-clock subtraction and name it JPEG image load age.
- `WebRTC._relayFrameStale`, `_relayFreshnessTimer`: stale flag and the sole current-scope timer handle; inspect existence only for the timer.
- `WebRTC._relayFeedbackSummary`: `{relayScope, receivedAtMs, feedbackSequence, pendingCount, oldestPendingAgeMs, expiredCount, unmatchedAckCount, timeoutCount, coalescedCount, lastSentAgeMs, lastAckAgeMs}`.
- `WebRTC._relayRttView`: current origin UI cache `{value, receivedAtMs}` or null. Only available while same-clock age <5000 ms.
- `WebRTC._relayFeedbackSequence` / `_relaySampleSequence`: current origin de-duplication high watermarks.
- `WebRTC._relayPendingStart`: pending existence/request binding; raw object includes socket and leaseId, so sanitize rather than serializing it. `_relayAcceptedStartRequestId` is diagnostic identity only, not readiness.

Index ownership is released after the source/test commit. Root's existing and concurrent README/runbook/requirements/review-anchor/report changes and node_modules symlink are preserved unstaged.
