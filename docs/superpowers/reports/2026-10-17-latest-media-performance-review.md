# Latest PASS300s media performance review — 2026-10-17

The latest bounded TURN/relay run passed passive continuity for 300.212s with 301 observations, no missing/late/failed or identity-change observations, and a maximum observed rVFC callback gap of 1000ms. This establishes this five-minute passive scope only. Active control, input-to-visible-effect, physical display and three-hour continuity remain NOT_RUN / not yet met. The independent long run was not opened or touched.

## Evidence and boundaries

Read only the completed `/tmp/wrd-public-server-heartbeat-turn-20261017a/{summary.json,samples.jsonl,lifecycle.json}`, `/tmp/wrd-c5-rollout-private-ilovzfv1/heartbeat-run-start.json`, the prior repository report `docs/superpowers/reports/2026-10-17-turn-media-performance-diagnosis.md`, and the bounded Host log tail. No source, index, running process, browser, service, tunnel, network or dependency operations were performed. Only this private report was written, mode 0600.

All 301 samples report build c30530f331a4def5; generation/leaseEpoch 1, PC identity 1, relay/relay UDP path identity path-1, connected and active throughout. Source 58ad766 was supplied by the caller and was not independently verified in this read-only data review.

The browser sampling span is performance.now 16450.799999952–316450.700000048ms, a duration of 299.999900000s; Python elapsed 0.000091063–300.000367958s. The browser wall anchor/timeOrigin maps that span to approximately 11:34:54.697–11:39:54.697 CST, subject to the browser wall clock's own reliability. This mapping labels the interval; no cross-clock subtraction was used to infer network or end-to-end delay.

Host reads began at the saved byte offset 7,938,534 after verifying inode 42866929. The captured tail was about 310KB, then filtered to log timestamps from 11:34:27 through 11:39:55 CST inclusive. This yielded 907 lines and only metric aggregates were analyzed: 59 host_event_loop_lag records (11:34:27.553–11:39:55.547), 60 CAPTURE_STATS (11:34:57.448–11:39:54.689), 59 WRD_ENCODER_SAMPLE (11:34:59.729–11:39:51.324), and 301 VIEWER_STATS (11:34:54.510–11:39:54.370). Zero WRD_FRAME_TRACE_SUMMARY records were present. Samples before/after this time window were excluded from conclusions.

## Three distinct rates

| Evidence | Latest measurement | Prior report |
|---|---|---|
| Decoder counter | 3→5466, +5463 / 299.9999s = 18.2100 decoded frames/s | 19.3894/s |
| rVFC callback counter | 3→5377, +5374 / 299.9999s = 17.9133 callbacks/s | 11.1801/s |
| Successful new capture sequence, wholly inside sampling span | 30→2894 over 11:34:55.539–11:39:49.560 = +2864 / 294.021s = 9.7408/s | 8.835/s |
| Capture sequence across the full permitted Host interval | 30→2966 over 11:34:55.539–11:39:55.547 = +2936 / 300.008s = 9.7864/s; last Host point is ~0.85s beyond last browser sample | — |
| Cached output reuse | 2687/5468 = 49.1405% across 60 capture windows | 54.80%, excluding its startup window |

For a startup-window-excluded comparison, latest 59 windows contain 5439 output frames, 2677 reuses (49.2186%) and 2762 non-reused output candidates. Their boundary-to-boundary duration is 297.241s, giving about 9.2921 non-reused outputs/s. CaptureSeq and non-reused output are different counts: the latest-slot design can skip captures. Neither count measures optical content changes. Encoded cached frames have advancing output timestamps, so decoder and rVFC progress do not establish fresh capture progress.

All 300 adjacent decoder differences are positive, range 3–22, median 19; callback differences range 3–21, median 19, none zero. framesDropped remains 0. The callback gap accumulated to 600.02ms by tick6, then first increased to 1000ms at tick260. Snapshot frame age ranges 2.2–401.9ms, median 25.8ms. Snapshot cadence can straddle a 1s gap while still seeing progress in both adjacent observation intervals. The sampler supplies callback counts, not presentedFrames metadata, presentationTime or optical evidence; a decoder/callback count difference is not a proven dropped-frame percentage.

## Browser metric snapshots

These are ranges and medians of snapshot `last` values, and ranges of the application's overlapping five-second `p95` windows. They are not whole-run percentiles, frame-weighted percentiles or additive end-to-end stages. Some snapshots can repeat prior `last` values.

| Metric | Valid / total snapshot last | Last min / median / max (ms) | Five-second p95 window min / max (ms) |
|---|---:|---:|---:|
| Candidate RTT | 301/301 | 27 / 29 / 218 | 28 / 218 |
| Jitter buffer interval mean | 299/301 | 0 / 7.9 / 121.7 | 4.6 / 121.7 |
| Decode interval mean | 299/301 | 0.5213 / 0.6232 / 1.1736 | 0.5894 / 1.1736 |
| rVFC interval (`paintIntervalMs`) | 300/301 | 16.6 / 50 / 249.9 | 66.6 / 433.3 |

Buffer/decode remain null in the first two observations; the first rVFC-interval metric is also null. Their valid latest-sample ages are 611.5–755.1ms (median 681.5ms); rVFC metric ages are 2.0–401.4ms. The sampled maxima therefore do not guarantee capture of every transient.

Only ticks4 and6 have buffer last >=100ms, respectively 114.1 and121.7ms. After tick10 the range is 0–70.4ms, median7.8ms. Later 60s segments (ticks60–119 /120–179 /180–239 /240–300) have maxima13.1/11.2/10.8/15.3ms. This differs from the prior recurring late peaks up to725.1ms and full gap1899.9ms. The two runs differ in time, build and runtime state, so this is a measurement comparison without a causal improvement claim.

All 301 snapshots keep inputAckRttMs, inputToPostApplyFrameMs, inputToVisibleEffectMs, hostQueueMs, hostApplyMs, hostAdapterAwaitMs, freshFrameAgeMs, encoderMs and relayFrameAckRttMs unavailable with null last/p95. RTT does not substitute for any input or visible-effect metric.

## Host and transport evidence

The 60 CAPTURE_STATS windows output FPS ranges5.6–19.7 (median18.9); excluding startup,10.2–19.7. Their reported convert averages range1.9–19.4ms, recv_total43.2–77.4ms. Per the prior semantic audit, these are not MSS grab durations: capture_wait=0 is a placeholder, recv_total includes pacing, and convert is construction. No actual screenshot-duration, capture-completion-gap or capture-exception aggregate was available. The ~9.7 successful captures/s remains evidenced, its cause remains unknown.

Across 59 encoder windows there are 5408 encode calls, count-weighted mean5.4732ms, window average3.711–33.236ms, window p95 5.537–182.075ms, and maximum448.357ms. Excluding the first two windows (explicitly a startup exclusion, not a whole-run metric) gives5293 calls, mean5.1966ms, window average3.711–11.792ms, window p95 5.537–42.356ms, and maximum257.394ms. Latest overall encoder mean and spikes exceed the prior4.5086ms/165.753ms. These timings cover encoder.encode including packetization, not executor queue waits or RTP send awaits. There is one H.264 encoder Opening record, VideoToolbox1152x720,target20,3.2Mbps. The 59 sampled windows contain one safety-net IDR and no periodic/PLI/forced IDR counts. No reopen storm is evidenced.

The 59 event-loop summaries report latest lag0.147–108.441ms (median1.53ms), rolling 60s max70.872–312.539ms, severity47 critical/12 warning, missedSampleCount0. These overlap and can repeatedly describe one event; they are not59 independent long stalls. The latest run's lag windows are materially worse than the prior report's later normal windows. Browser lifecycle independently reports max sampled main-thread lag10ms across309 probe samples and0 missed intervals; its1s probe cannot rule out shorter stalls or explain video delivery by itself.

The Host resource summaries report swap-in4,789,085.97–337,933,320.77B/s (~4.57–322.28MiB/s), median~44.01MiB/s; swap-out0–753,524,696.86B/s (~718.62MiB/s). RSS103.29–429.84MiB; resource sample age0.963–4.988s; memoryPressure remains unknown. System load1 is elevated and reaches41.069 around11:39:15.559. These are evidence of concurrent resource variation, not attribution of system swapping to this Host or proof that swapping causes each video gap.

The late1000ms callback gap first appears at tick260 (~11:39:14.697 browser wall label); nearby Host windows show output14.1fps at11:39:14.540, encoder mean11.792ms/p9534.709ms at11:39:16.027, and system load41.069. This is temporal coexistence within coarse windows, not a sender-to-browser stage trace or causal proof. Another late output window falls to12.1fps at11:39:49.644 with encoder maximum257.394ms in its preceding11:39:46.270 window.

The 301 VIEWER_STATS lines have reported lost=0 and dropped=0 throughout; sum of reported nack increments is1 (11:38:32.379), and freeze increments total29. These are receiver interval diagnostics, not a physical display test. The prior report had repeated lost/NACK bursts (positive sums1084/1229) coincident with high buffer and zero decoded intervals; that pattern is absent here. This run does not support a current persistent TURN-loss explanation. It also does not prove every transport segment healthy: report timestamps/identity, sender-stage boundaries and network trace remain unavailable.

## Actionability

No new implementation defect is established by these latest measurements. The earlier directly observed null-to-zero logging defect is not reproduced in the latest Host startup statistics, which explicitly log jitter_buffer=nullms. This is evidence of retained missingness for those records, not a source audit certifying every metric path. The remaining measurable limits are ~9.7 successful captures/s, ~49% reused output, resource/encoding spikes and a1s callback gap; present data cannot distinguish screenshot duration, capture-thread scheduling/failures, executor waits, send pacing or downstream presentation/transport mechanisms.

A future authorized bounded observation can reduce these unknowns using successful/failed grab duration and completion gaps, fresh/reused output counters, sender executor/encode/send stage timing and rVFC presentedFrames/mediaTime metadata with inbound report identity/timestamp. No FPS, bitrate, TURN or encoder-policy implementation change is justified solely by this run. No changes were made. The five-minute PASS, a long-run result, and input/optical acceptance remain separate.
