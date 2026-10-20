# M2 applied-input / fresh-frame causal observation implementation

Date: 2026-10-17. Base task 8112d3e; shared tree includes approved M1/C2/C3/M3 and C4 5382607. Viewer ownership released by root before edits. No services, tunnel, real capture/input, browser connection, network, dependencies or production build used.

## Implemented and spec mapping

- Spec 4.1: `InputFrameCausality` implements all five required methods with a lock, 512 candidates, 10-second TTL, maximum 128 ASCII characters per identifier, 64 IDs per reservation, four reservations. Retained identifier/scalar metadata stays below the 256-KiB serialized budget by construction; no pixels or payloads retained. Overflow and expiration count unmatched. Failed sends release reservations without consuming candidates.
- Host records only actual successful adapter results after the existing captured-authority recheck. Only mouse/move unordered success normalizes to applied. Rejections, duplicates and exceptions create no candidate. No input envelope or input authority fields changed. Existing reset/quiescence remains intact.
- Observation scope generation is **connectionAttemptSequence**, matching existing M1 Viewer latency/trace scope; it is not media-profile generation. Capture/target generation checks remain independent. Suspend, target change, shutdown invalidate current track reservations; authority changes clear observation scope. Old sender cannot claim current sender's reserved timestamps.
- Capture grab start/end/sequence tuple is copied under capture lock at screenshot selection, before worker dispatch. Post-worker reservation uses that immutable tuple. Old/reused frames never take newer inputs.
- Spec 4.2: `send_with_observation` prepares header token, awaits actual transport, then commits first accepted packet. Send errors propagate and reject observations; observer failures disable only observation and never alter the send result. Actual NEW aiortc DTLS transport rejection before SRTP protection produces zero registry coverage. Encoder failure releases pending capture reservations. Private ABI compatibility remains enforced.
- Host capability `inputFrameCorrelationVersion:1` passes Signal's explicit normalization whitelist. `input_frame_binding` v1 is a separate strict message carrying scope, stream/capture/encoder/wire/SSRC identity, fresh/after-apply facts and bounded input IDs. Existing strict `frame_trace_batch` v1 row fields and stage names are unchanged.
- Spec 4.2/4.3: Viewer joins by attempt/generation/stream/SSRC/wire RTP timestamp. SSRC comes from one current PC receiver matching the actual video element track and exactly one synchronization source; absence/ambiguity cannot approximate a next-frame join. Late metadata preserves the saved callback time. Basic collector exists only for known capability and pending/ACKed-but-unmatched input observations. Detailed tracing activates on detail metadata or explicit existing Lab marker/loss configuration.
- Pending join maps ≤256/2 seconds; seen ≤2048/30 seconds; matched ≤128/2 seconds. Capacity drops observations without permanently closing the stream. Foreign scopes are dropped without poisoning current scope; conflicting same-key data fails closed for that observation scope. Matched rows sort by original presentation time for correct expiration.
- Latency monitor records inputToPostApplyFrameMs using original Viewer presentation time; frame timing and post-apply evidence never settle ACK. It does not produce visible-effect samples without the separate existing controlled producer path. No RTT/2, Host wall clock or fake one-way latency added.
- Scene consumer already used exact `viewerClockMs`; tightened clock validation to reject negative/missing/coerced values. Existing real input guard and content-marker proof checks are unchanged. `media_stage_metrics.py` intentionally reused existing FrameKey/registry interfaces unchanged: bind_wire is now called only after successful send, so no metric schema change is necessary.

## Red evidence

1. `python3 -B -m unittest discover -s python-host -p test_input_frame_causality.py -v`: expected new-helper absence, ModuleNotFoundError input_frame_causality.
2. Same command for test_rtp_send_boundary.py: expected new send_with_observation absence. This is missing task implementation, not a missing runtime dependency.
3. `node --test --test-name-pattern='late trace keeps original' web-client/js/webrtc.frame-trace.test.js`: genuine behavior red, `800 !== 100`, one failed test.
4. Final strict-validator check caught an intermediate overbroad stale-identity check (empty/negative identity was ignored); tightened valid identity preconditions and reran five relevant tests green.

## Green commands / output

- `python3 -B -m pytest python-host/test_rtp_frame_observer.py python-host/test_frame_worker.py python-host/test_host_input_admission.py -q`: 23 passed, 4.83s (initial compatibility checkpoint).
- `python3 -B -m pytest python-host/test_input_frame_causality.py python-host/test_rtp_send_boundary.py python-host/test_rtp_frame_observer.py python-host/test_frame_worker.py python-host/test_host_input_admission.py -q`: 30 passed, 4.32s (before final added sparse end-to-end unit case).
- Final `python3 -B -m unittest discover -s python-host -p test_input_frame_causality.py -v`: 5 passed, 4.110s. Includes real bare_track.recv barrier, old selected capture publisher mutation, reuse, fresh capture, actual Host adapter applied/sequence-gap/execution-failed, stale sender, failed then successful sparse binding.
- Final `python3 -B -m unittest discover -s python-host -p test_rtp_send_boundary.py -v`: 3 passed, 0.619s. Includes real installed aiortc NEW transport, synthetic RTP, no network/SRTP operation.
- `node --test web-client/js/webrtc.frame-trace.test.js web-client/js/latency-monitor.test.js signal-server/websocket/runtime-context.test.js`: 42 passed, 2.934s. Includes 18,000 frames across 15 fake minutes and RTP wrap, continuous matching, bounded indexes, strict v1, late callback preservation, capability whitelist, frame notice not ACK.
- Additional unique-receiver/capability-off and late-post-apply tests: 2 passed. Final pattern `late trace keeps original|stale scope|schema v1|binding is separate|receiver SSRC`: 5 passed, 0.245s after final validator/expiry changes.
- `python3 -B -m pytest scripts/test_turn_controlled_scene.py -q`: 21 passed, 2.41s. Tests are pytest functions, so unittest discover would collect zero; pytest is the effective equivalent.
- `node --test web-client/js/media-activity-lifecycle.test.js`: 5 passed. An earlier invocation used nonexistent webrtc.lifecycle/media-state filenames and reported file-not-found; no code failure, corrected to the real lifecycle filename.
- `python3 -B -m py_compile python-host/input_frame_causality.py python-host/rtp_frame_observer.py python-host/host.py`: passed.
- `git diff --check`: passed; explicit staged diff checked before commit.

## Self-review and limits

No new input authorization, no input replay, no C recovery gate reading latency, no mode/TURN/quality changes. Observation exceptions cannot withhold ACK or stop media. Successful first packet is only API acceptance, not full-frame send or screen visibility. Detailed stage schema and native producer proof remain strict. Logs added by this task contain no input IDs/payloads/coordinates/tokens/URLs; identifiers exist only in bounded ephemeral correlation and the authorized protocol message.

Real public-network session, physical/device/optical test and long-duration wall-clock run: **NOT RUN**. Fake 15-minute stream proves bounded algorithms only. Browser receiver synchronization-source availability requires later controlled integration acceptance; absent or ambiguous mapping intentionally leaves evidence unavailable. No dependency installation or dist/pretest invocation.

The requested .superpowers report path is gitignored; do not force-add. A matching versioned copy is placed at docs/superpowers/reports/2026-10-17-media-causality-implementation.md so implementation review evidence is retained in the repository.

## R1 review remediation: original production rVFC clock

Fix package base: 6924d96. The independent M2 review correctly identified that the production callback passed its original `now` to LatencyMonitor but omitted it from both collectors, allowing receiver/marker processing overhead into saved presentation time.

Changed only Viewer implementation, direct collector test fixtures and this report's versioned copy. `observeVideoFrame(identity, roi, callbackAtMs)` now requires a finite, nonnegative numeric clock; both production call sites pass the original rVFC `now`, and immediate matches and buffered frames retain that exact clock. Expiry still uses the collector's current clock independently. No Host, wire format, control, stage metric, native producer, service or build changes.

Red: `node --test --test-name-pattern='production callback preserves original' web-client/js/webrtc.frame-trace.test.js` failed both trace-first and frame-first cases with **130 !== 100**. The real VM-loaded `startVideoFrameTracking` callback runs actual receiver mapping, advances fake clock 100→110 during receiver lookup and →130 during marker work, and checks both controlled visual evidence and sparse post-apply evidence. Frame-first metadata arrives at 800; both paths must still report100.

Green: `node --test web-client/js/webrtc.frame-trace.test.js web-client/js/latency-monitor.test.js` **37 passed, 10.922s**, including both callback bridge regressions, explicit invalid/missing/negative clock rejection for both arrival orders, original late join, strict v1 and 18,000-frame bounded fake stream. Existing direct tests now provide their simulated callback time explicitly.

One additional direct invocation in the existing Lab loss-tap fixture lacked SSRC as well as the new clock argument. Its single line now supplies fixture SSRC1 and clock0. `node --test --test-name-pattern='Lab-only loss taps retain' web-client/js/webrtc.test.js` **1 passed, 1.469s**; fixture fetch/stats are local fakes, no network. `git diff --check` passed. Real browser/public-network/device/optical acceptance remains **NOT RUN**.
