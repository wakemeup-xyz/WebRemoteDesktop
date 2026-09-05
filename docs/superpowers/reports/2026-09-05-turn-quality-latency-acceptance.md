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
|---|---|---|
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

The first conservative row changed only the periodic-IDR cadence from the legacy
20 frames to 40 frames (two seconds), while retaining the current per-resolution
bitrates and 100ms VBV:

| Resolution | 0.8-1.5s pulse | Periodic IDR `changeMAE <= 3.0` | On-demand IDR PSNR >=28dB | Encode p95 budget |
|---|---|---|---|---|
| 1152x720 | PASS (IDR at frame 40) | FAIL (17.372) | FAIL (17.540dB) | PASS (6.794ms / <=25ms) |
| 1728x1080 | PASS (IDR at frame 40) | FAIL (11.496) | FAIL (19.298dB) | PASS (13.666ms / <=45ms) |

Because that row failed the two image-quality gates, the matrix stops there.
The 150/200ms VBV, cap-bitrate, 4/10-second GOP, and on-demand-only rows are
recorded with their exact parameters and `NOT RUN` stop reasons; no failed value
was compounded into another candidate. `relay-balanced-v2` has no selected
parameter set, and `relay-legacy-v1` remains the default. This is a stop result,
not a claim that the periodic quality issue is fixed.

The Viewer buffer/decode-continuity, Host event-loop/input-ack, and finite-loss
recovery gates remain `NOT RUN` pending the Task 9 real selected-relay path.
