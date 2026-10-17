# Existing trace fixture failure classification

Scope: read-only analysis of `python-host/test_latency_timing.py::TestFrameTiming::test_real_capture_encoder_rtp_datachannel_and_viewer_trace_wiring_preserves_legacy_timing` in `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`. No repository source/index changed. No production service/browser/tunnel, network, screenshot or native input used. Host import/real encode ran only in an independent process, using the test's synthetic 16x16 zero-array Screenshot and fake RTP transport.

## Conclusion

**Stale/incomplete Viewer fixture, with two independent missing prerequisites; no production defect demonstrated by this failure.** The current diagnostic-admission change does not explain the empty match. Implementer's baseline substitution of original `8b8c0dc` Host methods already reproduced the same failure (task-1-report.md, Baseline failure / concern).

1. `python-host/test_latency_timing.py:281`: fixture PC has no `getReceivers`; video has no `srcObject.getVideoTracks`; no receiver `getSynchronizationSources` supplies SSRC 7. `web-client/js/webrtc.js:5736-5743` requires exactly one current-PC video receiver matching the displayed video track and exactly one synchronization source. Consequently `verifiedVideoFrameIdentity` returns null, so callback never reaches collector observation (`5659-5684`). This deliberate identity verification prevents guessing SSRC.
2. `python-host/test_latency_timing.py:282`: fixture invokes its only rVFC before delivering its first trace batch. `webrtc.js:5679` records detailed frames only when `_frameTraceEnabled`, controlled ROI, or loss Lab is active. None is enabled. `_frameTraceEnabled` becomes true only on `acceptFrameTraceBatch` (`5769-5771`), too late for that one callback. Receiver mapping alone therefore does not fix the fixture.

## Controlled verification

A pure Node VM probe reused the test's exact `viewer_script`, with a contract-valid synthetic trace; no browser. Outcomes are recorded in `/tmp/wrd-existing-trace-fixture-probe.json` (0600):

| Receiver/track/SSRC mapped | Detail enabled before callback | matched | pending traces |
| --- | --- | --- | --- |
| no | no | 0 | 1 |
| yes | no | 0 | 1 |
| no | yes | 0 | 1 |
| yes | yes | 1 | 0 |

All four have invalidBatchCount=staleTraceCount=conflictingTraceCount=0. Successful row has captureSeq=1, rtpTimestamp=wireTimestamp=77 and viewerClockMs=10. `performance.now()=0`, callback=10 does not cause this failure: no expiry threshold is crossed and the collector preserves callback time.

Then ran the complete existing Python test method in a separate Python 3.11 process, intercepting only the Node `subprocess.run` argument **in memory** to add both prerequisites before `beginConnectionAttempt`. All original assertions passed, without changing/skipping/widening any assertion. Real Host-emitted trace identity was:

`attemptId=attempt-live, generation=7, streamId=video, captureSeq=1, encoderTimestamp=9000, wireTimestamp=77, ssrc=7`.

Thus attempt/generation matches `beginConnectionAttempt` sequence 6→7; unrelated `_mediaIntent.generation=99` is correctly ignored. Schema, stages, Host wire timestamp, legacy timing fields, and callback clock need no repair for this test.

## Minimal follow-up recommendation (not implemented)

Update only this Node fixture to supply `video.srcObject.getVideoTracks() => [{id:'v'}]` and current PC `getReceivers() => [{track:{kind:'video',id:'v'}, getSynchronizationSources:()=>[{source:7}]}]`, and activate detailed tracing (`WebRTC._frameTraceEnabled=true`) before the frame-first callback. Keep its existing frame-first order and every legacy timing / captureSeq / RTP / PENDING assertion. Optionally add an explicit matched length assertion before indexing to clarify future failures; do not weaken matching.

Existing `web-client/js/webrtc.frame-trace.test.js:260-279` verifies unique receiver mapping / rejection; `281-325` already models both arrival orders with mapping, enabled diagnostic state and explicit clock. The old integration fixture should conform to this newer production contract.

A real first video frame arriving before diagnostics are activated may intentionally be unobserved; subsequent enabled, verified frames can join. Unsupported/ambiguous receiver mapping intentionally remains unaligned. These bounded omissions are not evidence of a production latency/correlation regression. No live-browser or long-session acceptance is claimed.
