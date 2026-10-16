# Final integration fixes — Host timing and verified frame freshness

Date: 2026-10-17. Base: `5b4baca`. Scope: the two P2 findings in the final branch integration review; no design expansion. Implementation and targeted offline checks are complete. Independent scoped re-review and controlled deployment remain owned by the root coordinator.

## Changes and contract

1. `InputTiming` starts its queue substage at construction inside adapter entry. It no longer inherits M3's earlier admission timestamp. Host continues measuring adapter entry→return, internal queue→native start, and native start→finish; no wire field, whitelist, queue limit, authority or ACK contract changes. Existing queue telemetry remains intact. Outer admission wait is currently outside these three stages, so business RTT minus adapter await is not a pure network residual.
2. The real M2 collector carries its already-validated fresh/after-applied provenance into the matched row. `onPostApplyFrame` updates freshness only for a successfully associated input and valid current-scope video capture. It uses the original Viewer rVFC clock, never late-binding arrival time. One bounded captureSeq high-water per current scope/video stream prevents older/repeated captures from refreshing even if the sparse collector is recreated. Pauses clear the gauge and retain this high-water; scope changes clear both. Presentation timestamps at/before the latest pause/resume or scope boundary cannot restore freshness.
3. `recordStage('freshFrameAgeMs', scalar)` now rejects the unverified value. This is the freshness-specific trusted-entry exception; all other stage recording remains unchanged. Repository search found no production callers of that scalar setter; the existing pause test now supplies a provenance-bearing matched row. Unassociated paint, ACK, frame_timing, reused/unknown/expired/wrong-stream bindings remain unavailable. M/W observation does not grant C authority, settle ACK or create visible-effect evidence.

Media spec §3 and the requirements' appended measurement-boundary note match the implementation. Pre-existing README/runbook/requirements/execution/review-anchor edits are excluded; only this task's requirements addition is staged.

## RED → GREEN evidence

- RED: `python3 -B -m unittest discover -s python-host -p test_input_timing_contract.py -v` — 4 passed, 1 failed. Actual AST-loaded Host `on_input`/`_execute_input`/`_send_input_ack`, real `InputAdmissionQueue` and `InputTiming`, fake native adapter/clock: input 2 enters at 10ms, dequeues at 100ms, internally waits 5ms and applies for 10ms. Real ACK had `hostAdapterAwaitMs=15`, `hostQueueMs=95`, `hostApplyMs=10`; expected internal queue is 5ms. After the fix all 5 passed and queue+apply are enclosed by adapter await (floating-point tolerance only).
- RED: `node --test web-client/js/webrtc.frame-trace.test.js` — 16 passed, 3 failed. The real `ensureInputFrameCollector` → `observeVideoFrame`/`acceptBinding` → `consumeInputFrameMatches` → real monitor path returned null freshness for rVFC100/late binding800, expected 700; positive refresh cases also failed.
- GREEN final: `python3 -B -m pytest python-host/test_input_timing_contract.py python-host/test_input_admission_queue.py -q` — **11 passed**. Includes the integrated regression plus real keyboard worker timing and queue regressions.
- GREEN final: `node --test web-client/js/latency-monitor.test.js web-client/js/webrtc.frame-trace.test.js` — **44 passed**. Includes 6 new integrated cases for original timestamp, capture high-water, sparse collector recreation, pause/resume, scope changes, stale/unknown/reused/expired/wrong-stream evidence and rejected scalar freshness.
- `git diff --check` passed. The earlier broad I1 suites were not rerun; this is targeted verification only.

## Self-review and limits

Read the final review, total Global Constraints, media spec §3, production Host/queue/adapter/ACK and collector/consumer interfaces. Checked that adapter timing stays enclosed under nonzero outer wait, freshness state is constant-size, no cross-clock subtraction is introduced, and the successful observation path never changes C state. Existing raw input IDs remain only in already-established in-memory association paths; no new logs or diagnostic payload fields were added.

No service, Viewer, network, tunnel, native input/capture, real codec, dependency install or production dist operation was run. Real browser playback, public-path latency, hardware/optical effects, pressured resources and three-hour continuity remain **NOT RUN** for this fix wave. Fake-clock/VM success is not production acceptance. Root-controlled deployment occurs only after independent final scoped review passes.
