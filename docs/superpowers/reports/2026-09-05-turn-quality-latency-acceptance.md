# TURN quality and latency acceptance ledger

**Date:** 2026-09-05
**Scope:** relay media only; this ledger does not authorize service, tunnel, or encoder-parameter changes.

## Frozen legacy observations

The following values are extracted from the existing runtime-log windows recorded in
`docs/superpowers/reports/2026-09-05-turn-quality-latency-review.md`. They are
observations from different time windows, not a controlled 720p-versus-1080p A/B
comparison: content, network conditions, and machine load may differ.

| Metric | 720p-class window | 1080p window |
|---|---:|---:|
| Actual encoded resolution | 1152x720 | 1728x1080 |
| Sampling window / samples | 15:45:34-15:46:16 / 43 | 15:50:00-15:59:30 / 571 |
| Decoded frames per roughly 1Hz sample, median | 19 | 12 |
| RTT median / p95 | 76 / 241ms | 83 / 150ms |
| Maximum sampled playback buffer | 325.8ms | 806.1ms |
| Samples with no decoded-frame growth | 2 | 17 |
| Browser freeze increments | 2 | 40 |
| Packet-loss increment / received-packet increment | 4 / 5,215 | 53 / 74,680 |
| Dropped-frame increments | 59 | 316 |
| IDR period median | 1.02s | 1.50s |

The read-only offline command is the reproducible encoding baseline. It fixes its
synthetic static-text input, random seed, frame count, time base, font fallback,
and policy ID; it records PyAV/aiortc versions and machine metadata with each JSON
artifact. Its timing fields remain machine-load context, not a cross-machine speed
claim.

```bash
/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 scripts/eval-turn-encoder-quality.py \
  --policy relay-legacy-v1 --output /tmp/wrd-relay-legacy-v1.json
```

## Acceptance gates

All gates begin unaccepted. `PENDING` needs the relevant implementation and
repeatable evidence. `NOT RUN` needs an actual relay/browser/device path and must
not be inferred from local health checks or an offline probe.

| Gate | Required evidence | Initial status |
|---|---|---|---|
| Legacy offline evidence format | Valid JSON with policy, resolution, bitrate, VBV, GOP, per-frame bytes/IDR/PSNR/changeMAE/encode time, versions, and machine metadata | PENDING |
| Legacy one-second quality pulse | Fixed synthetic static text reproduces the periodic forced-IDR pulse near the current 20-frame cadence | PENDING |
| RTP timeline | 20FPS adjacent frames advance 4,500 90kHz ticks; monotonic/pause/new-track cases pass | PENDING |
| Policy contract | Codec no longer follows GOP implicitly; legacy/v2 resolution, bitrate clamp, generation, and apply-truth tests pass | PENDING |
| Healthy-scene pulse removal | No 0.8-1.5s forced-IDR quality pulse in a healthy static 60-second window | PENDING |
| Periodic-IDR quality | If periodic IDR remains, static-frame IDR `changeMAE <= 3.0`; if on-demand only, no application-forced periodic IDR in 60 seconds | PENDING |
| On-demand-IDR quality | 720p and 1080p synthetic-text IDR PSNR each at least 28dB, followed by real text readability observation | PENDING |
| Offline encode budget | 720p p95 at most 25ms and 1080p p95 at most 45ms on the recorded machine state | PENDING |
| Viewer buffer and decode continuity | Real selected relay pair has no IDR burst above 300ms playback buffer and no continuous one-second no-decode interval | NOT RUN |
| Host responsiveness | Real relay proof records Host event-loop-lag p95 at most 50ms and remote-input-ack p95 at most 150ms | NOT RUN |
| Loss recovery | Controlled finite loss recovers within two seconds through bounded on-demand keyframe without PC rebuild or resolution change | NOT RUN |
| Full automated regression | Python and Node suites, including canonical FPS and merged keyframe-request behavior, pass | PENDING |
| Local relay browser acceptance | `http://127.0.0.1:8080` session manually selects external relay and proves selected candidate pair is relay | NOT RUN |
| Public and physical-device acceptance | Formal public entry plus real device/browser media, paint, input, and recovery observations | NOT RUN |

## Task 6 offline relay matrix (2026-09-06)

The reproducible matrix is stored in
`docs/superpowers/reports/evidence/2026-09-05-turn-quality/relay-balanced-v2-matrix.json`.
It used only the deterministic synthetic text encoder probe; it did not start a
Host, open a browser, allocate TURN, inject packet loss, or generate an input
ack. The JSON therefore records every real relay/runtime gate as `NOT RUN`.

The matrix now first runs seven single-variable controls from the legacy
baseline: 2/4/10-second GOP, on-demand-only GOP removal, 150/200ms VBV, and
the per-resolution bitrate cap. Each subsequent §6.5 combination still runs as
an independent measurement, but is eligible for selection only when its own
offline gates and every listed control dependency pass.

| Candidate | Dependencies | 1152x720 / 1728x1080 result | Eligible |
|---|---|---|
| `gop-2s-current-bitrate-vbv100` | GOP-2s | FAIL / FAIL | no |
| `gop-2s-current-bitrate-vbv150` | GOP-2s, VBV-150 | FAIL / FAIL | no |
| `gop-2s-cap-bitrate-vbv150` | GOP-2s, VBV-150, bitrate-cap | FAIL / FAIL | no |
| `gop-2s-cap-bitrate-vbv200` | GOP-2s, VBV-200, bitrate-cap | FAIL / FAIL | no |
| `gop-4s-cap-bitrate-vbv200` | GOP-4s, VBV-200, bitrate-cap | FAIL / FAIL | no |
| `gop-10s-cap-bitrate-vbv200` | GOP-10s, VBV-200, bitrate-cap | FAIL / FAIL | no |
| `on-demand-cap-bitrate-vbv200` | GOP removal, VBV-200, bitrate-cap | FAIL / FAIL | no |

Every periodic row removed the 0.8-1.5-second pulse and met its local encoding
budget, but failed periodic-IDR `changeMAE` and forced-IDR PSNR at both
resolutions. The on-demand row passed its 60-second scheduler check with no
application periodic IDR and passed its local encoding budget, but its forced-IDR
PSNR remained below 28dB at both resolutions. The JSON records per-resolution
IDR and P-frame encoded-byte averages/maxima plus `idrToPAvgBurstRatio`; these
are local byte summaries only and do not substitute for the Viewer buffer gate.

Every single-variable control failed its own offline gates, so no combination
can become eligible even if a future combination's aggregate metric happens to
pass. There is therefore no offline winner. Selection is `no-offline-winner`,
`relay-balanced-v2` has no selected constants, and `relay-legacy-v1` remains the
default. This is a stop result, not a claim that the periodic quality issue is
fixed.

The Viewer buffer/decode-continuity, Host event-loop/input-ack, and finite-loss
recovery gates remain `NOT RUN` pending the Task 9 real selected-relay path.

## Task 7 capture-cost probe (2026-09-06)

`scripts/benchmark-turn-capture.py` was run on the local 1792x1120 desktop,
scaled to the relay-default 1152x720 output, with a 20 FPS target and four
seconds per capture cadence. It opened MSS only: it did not start Host, a
browser, a relay/tunnel, or an encoder. Environment: macOS 13.7.6, Python
3.11.15, OpenCV 4.12.0, and PyAV 16.1.0.

| Capture multiplier | Capture FPS | Target availability | Cost per target frame | grab p50/p95 | resize p50/p95 | BGRA frame p50/p95 | Downstream BGRA→YUV420 proxy p50/p95 (excluded) |
|---|---:|---:|---:|---:|---:|---:|---:|
| legacy 2.0x | 40 | 1.000 | 63.313ms | 25.157 / 28.344ms | 1.773 / 2.573ms | 1.365 / 3.571ms | 2.410 / 3.355ms |
| 1.0x | 20 | 1.000 | 29.175ms | 23.566 / 25.318ms | 1.855 / 2.668ms | 1.342 / 1.525ms | 2.326 / 3.263ms |
| 1.25x | 25 | 1.000 | 36.861ms | 23.632 / 26.386ms | 1.850 / 2.790ms | 1.332 / 1.479ms | 2.309 / 3.282ms |
| 1.5x | 30 | 1.000 | 45.301ms | 24.166 / 26.053ms | 1.905 / 2.945ms | 1.344 / 1.546ms | 2.331 / 3.276ms |

All three candidates supplied the requested 80 capture frames. 1.0x is the
lowest such cadence and lowers the measured capture-stage cost from 63.313ms to
29.175ms per target frame, so `ScreenCaptureTrack` now captures at the target
FPS. This is a capture-stage decision only. Browser paint FPS is `NOT RUN`, and
the result makes no statement about periodic-IDR quality or any relay runtime
acceptance gate.

| Resize interpolation | resize p50/p95 | Downstream BGRA→YUV420 proxy p50/p95 (excluded) | Round-trip PSNR | Edge retention | Decision |
|---|---:|---:|---:|---:|---|
| INTER_LINEAR | 1.622 / 2.311ms | 2.339 / 3.403ms | 45.504dB | 0.56853 | retained |
| INTER_AREA | 4.079 / 4.612ms | 2.316 / 3.259ms | 45.018dB | 0.52629 | rejected |

`INTER_AREA` was inside the 25ms resize budget but reduced both local quality
proxies, so the existing `INTER_LINEAR` setting remains. The BGRA→YUV420 timing
is a PyAV `VideoFrame` reformat measurement; no buffer-reuse, capture-Adapter,
codec, GOP, bitrate, VBV, or Quality Lock change was made.

### Task 7 review correction: production cadence remains legacy 2.0x (2026-09-06)

The preceding capture result used one serial loop and incorrectly treated its
local frame supply as authorization to reduce the production cadence. That
measurement did not model the Host's independent latest-frame producer and
target-FPS consumer, so its 1.0x application is superseded and reverted.

The replacement probe has a producer thread that only runs MSS `grab()` at the
candidate cadence. A separate 20-FPS consumer takes and clears the latest
sequence; only a fresh-consumed sequence receives resize, BGRA `VideoFrame`,
and BGRA→YUV420 work. It records producer/consumer inter-arrival p50/p95/max,
produced, fresh-consumed, reuse, initial blanks, overwritten/dropped frames,
and the real per-stage call totals. It runs aligned, consumer-first with a fixed
jitter sequence, and a controlled 8ms slow-grab case for every multiplier.

| Multiplier | aligned fresh/reuse/blank/drop | consumer-first+jitter | slow-grab | Offline status |
|---|---:|---:|---:|---|
| legacy 2.0x | 79 / 0 / 1 / 80 | 79 / 0 / 1 / 78 | 79 / 0 / 1 / 30 | `LOCAL_CAPTURE_ONLY` |
| 1.0x | 79 / 0 / 1 / 0 | 77 / 2 / 1 / 1 | 78 / 1 / 1 / 1 | `LOCAL_CAPTURE_ONLY` |
| 1.25x | 79 / 0 / 1 / 20 | 79 / 0 / 1 / 19 | 79 / 0 / 1 / 19 | `LOCAL_CAPTURE_ONLY` |
| 1.5x | 79 / 0 / 1 / 40 | 79 / 0 / 1 / 39 | 79 / 0 / 1 / 35 | `LOCAL_CAPTURE_ONLY` |

Every multiplier, including legacy 2.0x, has `runtimePaintGate=PENDING`; none
is an online eligibility or a production selection. The script records
`selection.captureMultiplier = {applied:false, value:2.0}`. Local grab and
processing results cannot establish that browser paint FPS does not regress.
Task 9 must perform the selected-relay browser A/B before any cadence change is
considered. `INTER_LINEAR` remains unchanged; its local proxy is likewise
`runtimePaintGate=PENDING`.

### Task 7 review correction, round 2: account for every consumer path (2026-09-06)

The producer/consumer probe now mirrors all three `recv()` input paths. Fresh
frames record from-buffer and resize work; reused frames record `last_img.copy()`;
initial blanks record BGRA allocation. Every consumer tick, including reuse and
blank ticks, records `VideoFrame.from_ndarray` and BGRA→YUV420 `reformat`.
`costModel` totals the calls actually made in each path and does not multiply
resize, copy, or conversion by producer cadence.

Consumer phase, fixed jitter, and controlled delay are crossed with independent
producer stable/jitter/slow-grab controls (six scenarios per multiplier). The
JSON records the following conservation laws for every scenario:
`produced = freshConsumed + overwrittenDropped + unconsumedAtStop`, and
`consumerTicks = freshConsumed + reused + initialBlank`. It also records
producer and consumer inter-arrival p50/p95/max.

At 20 FPS / 1152x720, the 1.0x candidate produced reuse under the newly covered
consumer conditions: stable producer plus phase/jitter/delay had 77 fresh and 2
reused frames; producer jitter plus aligned consumer had 78 fresh and 1 reused;
slow-grab plus phase/jitter/delay had 71 fresh and 7 reused frames. The matching
`reuse.copy` call counts were 2, 1, and 7. In every row, `fromNdarray` and
`reformat` call counts equalled the 79 or 80 consumer ticks actually run.

This makes the local probe more faithful, but does not create a cadence winner:
legacy 2.0x and all 1.0x/1.25x/1.5x rows retain
`offlineEligibility=LOCAL_CAPTURE_ONLY` and `runtimePaintGate=PENDING`. The
production selection remains `{applied:false, value:2.0}` pending Task 9's
selected-relay browser paint A/B.

### Task 7 review correction, round 3: separate downstream YUV proxy (2026-09-06)

Production `ScreenCaptureTrack.recv()` creates a BGRA `VideoFrame`; it does not
call `frame.reformat("yuv420p")`. The probe now excludes reformat from
`pathCosts` and `costModel`: production cost contains only actual MSS grab,
fresh from-buffer/resize, reuse copy, blank allocation, and every-tick
`VideoFrame.from_ndarray`. BGRA→YUV420 remains in a separate
`downstreamExploratoryProxy` with `includedInProductionCost=false`, so it cannot
participate in multiplier comparison or selection.

The test suite now executes, rather than merely enumerates, deterministic
producer/consumer fixtures where both schedulers carry independent nonzero
phase, jitter, and consumer delay. A fast producer fixture proves initial blank
and overwrite/drop; a stalled producer fixture proves initial blank and reuse.
Both assert producer and consumer conservation equations plus producer/consumer
inter-arrival sample counts. The full local matrix reported every exploratory
proxy row as `includedInProductionCost=false` and retained
`runtimePaintGate=PENDING` for legacy 2.0x and all candidates.

### Task 7 review correction, round 4: make YUV proxy schema-exclusive (2026-09-06)

The scenario-level `consumerBgraToYuv420` and interpolation-level
`bgraToYuv420` fields are now emitted only beneath their respective
`downstreamExploratoryProxy` objects. Each proxy and every scenario proxy-path
row carries `includedInProductionCost=false`. Production `pathCosts` and
`costModel` remain limited to MSS grab, from-buffer, resize, reuse copy, blank
allocation, and BGRA `VideoFrame.from_ndarray`; neither production selection
consumes the exploratory envelope.

Fresh offline evidence was generated at `/tmp/wrd-turn-capture-round4.json`.
It has no scenario-level `consumerBgraToYuv420` or interpolation-level
`bgraToYuv420`; their retained measurements are nested in the labelled proxies.
The fresh output preserves `selection.captureMultiplier={applied:false,
value:2.0}` and `runtimePaintGate=PENDING`.

## Task 8 full automation status (2026-09-06)

The full Viewer suite passed 566 tests, and the Signal Server suite passed 339
tests after rebuilding the Viewer bundle. The standalone Viewer build, tracked
shell/MJS syntax checks, and tracked JSON parsing also passed.

Fix round 1 made the RTP encoder-boundary test select the explicit relay libx264
policy, so it still crosses the real PyAV/aiortc encoder boundary without
depending on local VideoToolbox availability. The decoder-refresh test now
requires the current attempt/generation/profile, a matching causal IDR request
acknowledgement, and two consecutive decoder-stalled samples; a positive current
decoded delta resets that episode. The full Python suite now passes 253 tests
with one pre-existing MSS deprecation warning.

This does not change any runtime gate: real selected-relay continuity, loss
recovery, formal public-entry, and physical-device evidence remain `NOT RUN`.

## Task 9 runtime preflight and acceptance record (2026-09-06)

This is a documentation-only runtime record. The operator's preflight found an
active local human Viewer (`viewerCount=1`), so Task 9 did not start a headless
Viewer, restart local services, restart Host, change `.env`, read credentials,
or operate either tunnel. A later read-only API snapshot returned
`viewerCount=0`; it does not retroactively authorize an automated proof after
the active-human-Viewer stop condition was observed.

The existing local origin returned `/health` `status: ok` and `/api/status`
`hostOnline: true`. This is **pre-existing runtime observed**, not proof that
these processes have loaded this worktree's `de8edb0` code or policy. The
service helper's recorded signal PID was absent while the HTTP origin was
healthy; no process action was taken to reconcile that discrepancy.

`/tmp/wrd-safe-current-url.txt` was present and readable. Its content was not
changed and is intentionally not written to this versioned report. Because no
restart occurred, this record does not make a before/after URL-stability claim.

| Spec §11 gate | Status | Reason / evidence boundary |
|---|---|---|
| 11.1 automated regression | PASS (Task 8 evidence) | Full Python, Viewer, and Signal Server suites passed; this is not a live relay result. |
| 11.2 offline quality and timing | `no-offline-winner` | The Task 6 matrix selected no v2 constants; legacy remains default. This does not prove the periodic pulse is fixed. |
| 11.3 selected relay pair | NOT RUN | Active human Viewer stop condition prohibited the headless proof; no manual relay session was performed. |
| 11.3 720p, 10-minute run | NOT RUN | No controlled selected-relay session; pre-existing health cannot establish paint, buffer, pulse, or geometry gates. |
| 11.3 1080p, 5-minute run | NOT RUN | No controlled selected-relay session; no automatic resolution change was made. |
| 11.3 paint, pause/resume, refresh, and input | NOT RUN | No browser interaction occurred; Host lag and input-ack gates have no new evidence. |
| 11.3 finite-loss recovery | NOT RUN | No loss injection or selected-relay recovery observation occurred. |
| Legacy-versus-v2 A/B | NOT RUN | `relay-balanced-v2` has no offline winner or selected constants, so there is no authorized v2 runtime candidate. |
| 11.4 public and physical-device acceptance | NOT RUN | No formal-public external operator, network, or physical-device observation was performed. |

The approximately one-second quality/clarity pulse remains unclosed. No `FAIL`
status is inferred from these unexecuted gates; they remain `NOT RUN` pending a
new operator-scheduled window with no active human Viewer and an eligible v2
candidate, if one is established by the offline gates.
