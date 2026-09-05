# Task 7: evidence-based capture-cost optimization

## Scope and guardrails

This task changed only `ScreenCaptureTrack.capture_fps_for_target()` and added
an offline local capture probe. It did not start Host, Signal Server, a browser,
TURN, or Cloudflare. It did not change codec choice, GOP/IDR behaviour, bitrate,
VBV, Quality Lock, capture Adapter ownership, or RTP sender code.

Task 6 remains `no-offline-winner`; `relay-legacy-v1` remains the default. This
capture result does not claim that the periodic quality pulse is fixed.

## Benchmark environment and raw summary

Command:

```bash
/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 \
  scripts/benchmark-turn-capture.py --output /tmp/wrd-turn-capture.json
```

Environment: macOS 13.7.6 x86_64, Python 3.11.15, OpenCV 4.12.0, PyAV 16.1.0.
The active desktop was 1792x1120; the probe scaled to 1152x720, targeted 20
FPS, and ran each cadence for four seconds. `targetFrameAvailability` was 1.000
for all rows (80 target frames).

| Multiplier | capture FPS | frames | cost/target frame | grab p50/p95 | resize p50/p95 | BGRA frame p50/p95 | BGRA→YUV420 p50/p95 |
|---|---:|---:|---:|---:|---:|---:|---:|
| legacy 2.0x | 40 | 113 | 63.313ms | 25.157 / 28.344ms | 1.773 / 2.573ms | 1.365 / 3.571ms | 2.410 / 3.355ms |
| 1.0x | 20 | 80 | 29.175ms | 23.566 / 25.318ms | 1.855 / 2.668ms | 1.342 / 1.525ms | 2.326 / 3.263ms |
| 1.25x | 25 | 100 | 36.861ms | 23.632 / 26.386ms | 1.850 / 2.790ms | 1.332 / 1.479ms | 2.309 / 3.282ms |
| 1.5x | 30 | 120 | 45.301ms | 24.166 / 26.053ms | 1.905 / 2.945ms | 1.344 / 1.546ms | 2.331 / 3.276ms |

| Interpolation | resize p50/p95 | BGRA→YUV420 p50/p95 | PSNR proxy | edge-retention proxy |
|---|---:|---:|---:|---:|
| INTER_LINEAR | 1.622 / 2.311ms | 2.339 / 3.403ms | 45.504dB | 0.56853 |
| INTER_AREA | 4.079 / 4.612ms | 2.316 / 3.259ms | 45.018dB | 0.52629 |

The raw JSON is intentionally written to `/tmp/wrd-turn-capture.json`; it
contains the machine metadata, every p50/p95/mean sample summary, inputs,
selection, and limitations. It is not a reusable cross-machine speed claim.

## Decision and application

Applied the measured 1.0x capture multiplier: 20 FPS media now requests 20 FPS
capture instead of legacy 40 FPS. It was the lowest measured cadence that
supplied the target frames and reduced the local cost per target frame by 53.9%
against the 2.0x baseline.

Kept `INTER_LINEAR`. `INTER_AREA` met the 25ms resize p95 budget but made both
local resize quality proxies worse, so it did not meet the required combined
quality-and-cost gate.

BGRA→YUV420 was measured through PyAV reformat only. No buffer reuse or copy
elimination was applied without a separate design and evidence.

## Verification

```text
pytest -q python-host/test_media_profile.py -k capture_fps  -> 1 passed
scripts/benchmark-turn-capture.py --output /tmp/wrd-turn-capture.json -> selected 1.0x; retained INTER_LINEAR
```

The final verification must also run the focused Python suite, `py_compile`,
and `git diff --check` after all Task 7 files are staged.

## Limits

- Browser paint FPS and real selected-relay acceptance are `NOT RUN`.
- The probe does not encode, so it cannot validate periodic-IDR quality.
- Results are local-machine measurements and do not prove a cross-machine CPU
  or end-to-end latency improvement.

## Review correction, round 1/5 (2026-09-06)

The previous serial-loop probe and its 1.0x production change were rejected.
It had measured `grab`, resize, and conversion inside one pacing loop, which
does not model `ScreenCaptureTrack`'s producer thread plus target-FPS consumer.
The production capture method is restored to legacy 2.0x (`target_fps * 2`,
capped at 60); no offline result may change it.

The replacement probe uses a producer thread that only performs MSS `grab()`
and publishes a latest sequence. Its independent consumer runs at the media
target rate, clears the latest slot, and runs resize/BGRA VideoFrame/YUV420 only
for a fresh sequence. It reports produced, freshConsumed, reused,
initialBlank, overwrittenDropped, producer/consumer inter-arrival p50/p95/max,
and separate producer-grab versus fresh-processing totals. The cost model does
not multiply processing work by every producer call.

Benchmark command and environment remain the same as above. The replacement
used a 1792x1120 desktop, 1152x720 output, 20 FPS consumer, four seconds per
scenario, macOS 13.7.6, Python 3.11.15, OpenCV 4.12.0, and PyAV 16.1.0. For
each of legacy 2.0x, 1.0x, 1.25x, and 1.5x it ran aligned, consumer-first with
fixed `0/+2/-1ms` producer jitter, and a controlled 8ms slow-grab scenario.

| Multiplier | aligned fresh/reuse/blank/drop | consumer-first+jitter | slow-grab | Offline output |
|---|---:|---:|---:|---|
| legacy 2.0x | 79 / 0 / 1 / 80 | 79 / 0 / 1 / 78 | 79 / 0 / 1 / 30 | `LOCAL_CAPTURE_ONLY` |
| 1.0x | 79 / 0 / 1 / 0 | 77 / 2 / 1 / 1 | 78 / 1 / 1 / 1 | `LOCAL_CAPTURE_ONLY` |
| 1.25x | 79 / 0 / 1 / 20 | 79 / 0 / 1 / 19 | 79 / 0 / 1 / 19 | `LOCAL_CAPTURE_ONLY` |
| 1.5x | 79 / 0 / 1 / 40 | 79 / 0 / 1 / 39 | 79 / 0 / 1 / 35 | `LOCAL_CAPTURE_ONLY` |

The JSON selection is intentionally fixed at
`captureMultiplier={applied:false, value:2.0, runtimePaintGate:"PENDING"}`.
It records no offline winner. `INTER_LINEAR` remains the production
interpolation; its local PSNR/edge proxy is also only `PENDING` until a
selected-relay browser paint A/B. Task 9 is the required path for that A/B.

### Round-1 verification

```text
pytest -q python-host/test_capture_benchmark.py python-host/test_media_profile.py python-host/test_latency_timing.py -> 13 passed
scripts/benchmark-turn-capture.py --output /tmp/wrd-turn-capture.json -> production value 2.0, runtimePaintGate PENDING
```

## Review correction, round 2/5 (2026-09-06)

Round 1 still undercounted consumer work: production calls `last_img.copy()` for
reuse and calls `VideoFrame.from_ndarray` for every `recv()` return, including
reuse and initial blanks. The benchmark now measures path-local copy,
from-buffer, resize, blank allocation, `from_ndarray`, and BGRA→YUV420
`reformat` p50/p95/max for `fresh`, `reused`, and `initialBlank` separately.
Its total is the sum of actual calls, not a producer-cadence multiplier.

Consumer phase/jitter/delay is now independent of producer phase/jitter/slow
grab. The default benchmark crosses three producer conditions with two consumer
conditions, yielding six four-second scenarios for each multiplier. It reports
and tests both conservation identities:

```text
produced == freshConsumed + overwrittenDropped + unconsumedAtStop
consumerTicks == freshConsumed + reused + initialBlank
```

The deterministic test fixtures prove all relevant boundary observations:

- producer faster than the consumer produces an overwrite/drop and initial blank;
- a stalled producer produces reuse and initial blank;
- `reuse.copy` calls equal reuse count;
- every consumer tick has one `fromNdarray` and one `reformat` call;
- producer/consumer inter-arrival sample counts are `events - 1`.

Raw run summary (20 FPS consumer, 1152x720, default four-second scenarios):

| 1.0x scenario | fresh | reuse | initial blank | overwritten/drop | `reuse.copy` calls | frame/reformat calls |
|---|---:|---:|---:|---:|---:|---:|
| producer stable + consumer aligned | 79 | 0 | 1 | 0 | 0 | 80 / 80 |
| producer stable + consumer phase/jitter/delay | 77 | 2 | 0 | 3 | 2 | 79 / 79 |
| producer jitter + consumer aligned | 78 | 1 | 1 | 0 | 1 | 80 / 80 |
| producer jitter + consumer phase/jitter/delay | 76 | 2 | 1 | 3 | 2 | 79 / 79 |
| producer slow-grab + consumer aligned | 77 | 2 | 1 | 2 | 2 | 80 / 80 |
| producer slow-grab + consumer phase/jitter/delay | 71 | 7 | 1 | 8 | 7 | 79 / 79 |

This is local scheduling evidence only. All capture multiplier rows retain
`LOCAL_CAPTURE_ONLY` / `runtimePaintGate=PENDING`; the output and production
selection remain `applied:false, value:2.0`. Only Task 9's selected-relay
browser paint A/B may reconsider that value.

### Round-2 verification

```text
pytest -q python-host/test_capture_benchmark.py python-host/test_media_profile.py python-host/test_latency_timing.py -> 15 passed
scripts/benchmark-turn-capture.py --output /tmp/wrd-turn-capture.json -> production value 2.0, all runtime paint gates PENDING
```

## Review correction, round 3/5 (2026-09-06)

The previous probe still treated BGRA→YUV420 `reformat` as a production
consumer cost. That is false for `ScreenCaptureTrack.recv()`: it constructs a
BGRA `VideoFrame` and returns it; reformat is a downstream encoder-path
question. The benchmark now labels per-path reformat measurements as
`downstreamExploratoryProxy`, sets `includedInProductionCost:false`, and removes
them from both `pathCosts` and all `costModel` totals. Production cost now covers
only observed MSS grab, fresh from-buffer/resize, reuse copy, blank allocation,
and every-tick `VideoFrame.from_ndarray`.

The scheduler test now executes two controlled dual-scheduler fixtures. Both
have independent producer and consumer phase/jitter/delay controls. The fast
producer fixture proves `initialBlank >= 1` and `overwrittenDropped >= 1`; the
stalled producer fixture proves `initialBlank >= 1` and `reused >= 1`. Both
assert:

```text
produced == freshConsumed + overwrittenDropped + unconsumedAtStop
consumerTicks == freshConsumed + reused + initialBlank
producerInterArrival.count == produced - 1
consumerInterArrival.count == consumerTicks - 1
```

The full matrix wrote `includedInProductionCost=false` on all exploratory YUV
rows. Its production selection remains `applied:false, value:2.0`, and every
legacy/candidate row remains `runtimePaintGate=PENDING`. The local reformat
measurements are retained only for a possible later downstream study; they are
not candidate evidence.

### Round-3 verification

```text
pytest -q python-host/test_capture_benchmark.py python-host/test_media_profile.py python-host/test_latency_timing.py -> 16 passed
scripts/benchmark-turn-capture.py --output /tmp/wrd-turn-capture.json -> production value 2.0, all YUV proxies excluded from production cost
```
