# R5 actual baseline performance assessment — 2026-10-18

Classification: FAILED / cleanup-incomplete. Passive continuity status INCOMPLETE. This is not a qualification PASS. Owned-process exit evidence not-observed; browser-close and manager-stop status alone do not establish process exit.

Read-only analysis of fixed evidence; no service, network, browser, native-input, or test action. No repository changes.

## Evidence integrity

Session directory: `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-frontend-move-context-operations-private-r5-wive_sjb/sequence-93750d2ec1ca42f35e838a96e58c6708/attempts/ba047879c33f00f14b603780026ba53a/ordinary-baseline-osu_l091/session`

- samples.jsonl: bytes=1172174; SHA256=f879a98fa679a125fd8fbd3e3be6875d11ead9dc25af933cc415f6e06113ca73

- summary.json: bytes=2399; SHA256=14d35f6191e252e13b6270bd8dd6af73109682c7673b92b16f413396fdb61fe5

- lifecycle.json: bytes=8413; SHA256=15cbcb1ac9b694cf82598f3fc17248a5ea712d195b296e8f8734d5fe0fb41621

Host append-only snapshot identity and byte cap: `{"path": "/Users/macstudio1/AI/Claude/WebRemoteDesktop/back-debug.log", "dev": 16777220, "inode": 45696663, "capBytes": 6493640, "prefixSha256": "d82565cc60747b768f4b134e9ed03078339574738e301f4b97afb233987c1208", "selectedSha256": "207186992a41f938e4447f75f4859691a58287cef1572b3ebd678407c464eb73", "selectedLines": 953}`

Private frozen selected lines: /tmp/wrd-r5-host-private-frozen.log (0600). Selection predicate: local timestamps >=2026-10-18 23:18:00 and <23:24:01 CST; actual selected timestamp span 2026-10-18 23:18:00,437 through 2026-10-18 23:23:59,779. Prefix hash covers byte range [0, capBytes); later appends are excluded. Selected text remains private; report includes only safe scalars.

Frozen source reference c802a68362459b46b84593c7e8921575e0783394. Manifest separately attests Signal/Host dfb15434e79da90b803b763c533836e16c080c71, Viewer c802a68362459b46b84593c7e8921575e0783394, build bb581651b422e400; source reference is not proof Host runs viewer commit.

## Browser coverage

Total 314 samples; phases {'startup': 13, 'baseline': 301}. Baseline 301 samples; elapsed boundary 11.304359–310.598573s; delta=299.294215s. Summary requested 300s, elapsed 300.276510s; missing/late/failed/identity-change observations all zero. Host observation 314 samples complete/stable, no disconnect observed. Three-hour continuity false; recovery, business inputs, visible effect and physical display NOT_RUN.

Startup marks use browser performance clock only; no subtraction across Python/browser clocks.

Marks ms: {"start-click": 3082.6, "bootstrap-start": 3083.1, "bootstrap-ready": 3993.1, "bootstrap-degraded": null, "signal-connected": 7660.4, "first-frame": 10963.4, "active": 10963.4}

- start-click → bootstrap-start: 0.500 ms

- bootstrap-start → bootstrap-ready: 910.000 ms

- start-click → signal-connected: 4577.800 ms

- signal-connected → first-frame: 3303.000 ms

- start-click → first-frame: 7880.800 ms

- first-frame → active: 0.000 ms

callbacks: n=301, min=41.000000, max=5845.000000, arithmetic mean=2959.016611

frameAgeMs: n=301, min=1.200000, max=118.900000, arithmetic mean=29.893415

maxFrameGapMs: n=301, min=66.700000, max=183.300000, arithmetic mean=156.419934

Callback boundary delta=5804; rate=delta/browserNow delta=19.393068Hz over 299.282200s. Callback frames and decode counters have different boundaries and may differ.

transport.framesDecoded: n=301, min=41.000000, max=5885.000000, arithmetic mean=2972.976744

transport.framesDropped: n=301, min=0.000000, max=0.000000, arithmetic mean=0.000000

transport.rttMs: n=301, min=30.000000, max=153.000000, arithmetic mean=36.196013

State counts: {"scopeStable": {"True": 301}, "socketConnected": {"True": 301}, "pcState": {"connected": 301}, "inputAllowed": {"True": 301}, "generation": {"1": 301}, "leaseEpoch": {"1": 301}, "tunnelRelayActive": {"False": 301}}

Input gate allowed is readiness evidence only. Six input metrics (inputAckRttMs,inputToPostApplyFrameMs,inputToVisibleEffectMs,hostQueueMs,hostApplyMs,hostAdapterAwaitMs) have no available samples: True. Values remain null / NOT_RUN; no native business inputs.

Metric inputAckRttMs: availability 0/301; last-value observations null / NOT_RUN; five-second window p95 observations null / NOT_RUN

Metric inputToPostApplyFrameMs: availability 0/301; last-value observations null / NOT_RUN; five-second window p95 observations null / NOT_RUN

Metric inputToVisibleEffectMs: availability 0/301; last-value observations null / NOT_RUN; five-second window p95 observations null / NOT_RUN

Metric hostQueueMs: availability 0/301; last-value observations null / NOT_RUN; five-second window p95 observations null / NOT_RUN

Metric hostApplyMs: availability 0/301; last-value observations null / NOT_RUN; five-second window p95 observations null / NOT_RUN

Metric hostAdapterAwaitMs: availability 0/301; last-value observations null / NOT_RUN; five-second window p95 observations null / NOT_RUN

Metric paintIntervalMs: availability 301/301; last-value observations n=301, min=16.600000, max=133.300000, arithmetic mean=50.444133; five-second window p95 observations n=301, min=66.600000, max=100.000000, arithmetic mean=67.202618

Metric freshFrameAgeMs: availability 0/301; last-value observations null / NOT_RUN; five-second window p95 observations null / NOT_RUN

Metric candidateRttMs: availability 301/301; last-value observations n=301, min=30.000000, max=153.000000, arithmetic mean=35.674419; five-second window p95 observations n=301, min=31.000000, max=153.000000, arithmetic mean=41.710963

Metric jitterBufferMs: availability 301/301; last-value observations n=301, min=3.000000, max=15.600000, arithmetic mean=8.869767; five-second window p95 observations n=301, min=8.100000, max=15.600000, arithmetic mean=10.618937

Metric decodeMs: availability 301/301; last-value observations n=301, min=0.463700, max=1.008053, arithmetic mean=0.778577; five-second window p95 observations n=301, min=0.547050, max=1.008053, arithmetic mean=0.859473

Metric encoderMs: availability 0/301; last-value observations null / NOT_RUN; five-second window p95 observations null / NOT_RUN

Metric relayFrameAckRttMs: availability 0/301; last-value observations null / NOT_RUN; five-second window p95 observations null / NOT_RUN

No whole-run p95 is reconstructed from overlapping five-second windows. frameAge is time since callback, not source-pixel age; requestVideoFrameCallback is not optical visible-effect verification. Relay refers to WebRTC UDP relay candidates; tunnelRelayActive false.

Lifecycle diagnostics coverage partial; missingReferences=7, droppedEvents=765. Event absence cannot prove exhaustive transport history. Browser event-loop lag count=310, missedIntervals=0, last=3ms, max=4ms.

## Host fixed window

Loop-lag records=66; capture-present records=55 (2026-10-18T15:19:00.439821+00:00–2026-10-18T15:23:59.445111+00:00); encoder records=60; CAPTURE_STATS records=60. Idle prefix is retained but excluded from active capture range. Rolling windows overlap and are never added together.

lagMs: n=55, min=0.109000, max=7.116000, arithmetic mean=1.588364

maxLagMs: n=55, min=4.008000, max=68.533000, arithmetic mean=19.667891

processCpuSeconds: n=55, min=75.570000, max=163.578000, arithmetic mean=119.405909

currentRssMiB: n=55, min=48.207031, max=360.593750, arithmetic mean=303.969105

peakRssMiB: n=55, min=334.843750, max=368.250000, arithmetic mean=337.272656

systemLoad1: n=55, min=2.533000, max=3.897000, arithmetic mean=3.118836

eventLoop.count: n=55, min=60.000000, max=61.000000, arithmetic mean=60.272727

eventLoop.last: n=55, min=0.108840, max=7.116123, arithmetic mean=1.588333

eventLoop.max: n=55, min=4.007524, max=68.533223, arithmetic mean=19.667901

eventLoop.p50: n=55, min=0.508174, max=4.294085, arithmetic mean=1.313895

eventLoop.p95: n=55, min=2.266314, max=4.530702, arithmetic mean=3.450519

eventLoop.p99: n=55, min=4.007524, max=68.533223, arithmetic mean=19.667901

eventLoop.missedSampleCount: n=55, min=0.000000, max=0.000000, arithmetic mean=0.000000

Process CPU boundary delta=88.008000s / wall=299.005290s = 29.434% of one CPU core (process aggregate, not system CPU or GIL attribution).

capture.lastDurationMs: n=55, min=21.079000, max=42.815000, arithmetic mean=28.342855

capture.maxDurationMs: n=55, min=57.777000, max=122.610000, arithmetic mean=65.910236

capture.lastThreadCpuMs: n=55, min=5.583000, max=13.578000, arithmetic mean=7.840327

capture.lastNonCpuMs: n=55, min=15.424000, max=33.588000, arithmetic mean=20.502709

capture.maxDurationThreadCpuMs: n=55, min=9.310000, max=13.303000, arithmetic mean=10.904764

capture.maxDurationNonCpuMs: n=55, min=44.474000, max=110.931000, arithmetic mean=55.004909

capture.completed: n=55, min=21.000000, max=1884.000000, arithmetic mean=964.800000

capture.failed: n=55, min=0.000000, max=0.000000, arithmetic mean=0.000000

cadence.activeIntervalRateHz: n=55, min=6.025012, max=7.664022, arithmetic mean=6.285591

cadence.activeIntervalCoveredMs: n=55, min=2609.595923, max=59882.274377, arithmetic mean=53856.232333

cadence.intervalCount: n=55, min=20.000000, max=395.000000, arithmetic mean=336.690909

Last rolling closed-cycle window safe scalars: {"scope": "rolling-60s-completion-buckets", "state": "active", "phase": "pacing", "phaseAgeMs": 40.811444, "intervalCount": 367, "activeIntervalCoveredMs": 59697.939234, "activeIntervalRateHz": 6.147615892760684, "lastInterval": {"intervalMs": 199.999668, "grabMs": 22.796142, "postGrabMs": 0.284099, "pacingActualMs": 176.824832, "otherMs": 0.094595, "minIntervalMs": 50.0, "pacingRequestedMs": 26.919759, "pacingExcessMs": 149.905073, "publishLockWaitMs": 0.003566, "publishCriticalMs": 0.003827}, "maxInterval": {"intervalMs": 213.268869, "grabMs": 20.753108, "postGrabMs": 0.380892, "pacingActualMs": 192.006274, "otherMs": 0.128595, "minIntervalMs": 50.0, "pacingRequestedMs": 28.866, "pacingExcessMs": 163.140274, "publishLockWaitMs": 0.003575, "publishCriticalMs": 0.004401}, "stages": {"interval": {"count": 367, "sumMs": 59697.939234, "meanMs": 162.6646845613079, "maxMs": 213.268869}, "grab": {"count": 367, "sumMs": 10351.83384, "meanMs": 28.206631716621253, "maxMs": 122.609561}, "postGrab": {"count": 367, "sumMs": 133.827801, "meanMs": 0.36465340871934604, "maxMs": 2.521276}, "pacingActual": {"count": 367, "sumMs": 49156.192869, "meanMs": 133.94058002452314, "maxMs": 192.006274}, "other": {"count": 367, "sumMs": 56.084724, "meanMs": 0.15281941144414168, "maxMs": 0.521525}, "minInterval": {"count": 367, "sumMs": 18350.0, "meanMs": 50.0, "maxMs": 50.0}, "pacingRequested": {"count": 367, "sumMs": 7979.462264, "meanMs": 21.74240398910082, "maxMs": 30.308007}, "pacingExcess": {"count": 367, "sumMs": 41176.730605, "meanMs": 112.19817603542234, "maxMs": 163.140274}, "publishLockWait": {"count": 367, "sumMs": 1.386969, "meanMs": 0.003779207084468665, "maxMs": 0.011771}, "publishCritical": {"count": 367, "sumMs": 11.310589, "meanMs": 0.030819043596730242, "maxMs": 2.12527}}, "published": 367, "discarded": 0, "error": 0, "discontinuous": 0, "invalidTiming": 0, "clipped": false}

Closed-cycle formula: interval=grab+postGrab+pacingActual+other; pacingExcess=pacingActual−pacingRequested. Last window sums close to rounding: residual ms=0.0. Mean interval 162.665ms vs configured minimum 50ms; mean pacingActual 133.941ms vs requested 21.742ms, excess 112.198ms. This identifies elapsed pacing delay as dominant measured stage, not its unique cause. Non-CPU wall time includes waiting/descheduling/native work and is not proof of GIL contention.

Output CAPTURE_STATS fps: n=60, min=16.500000, max=19.700000, arithmetic mean=19.473333

Output aggregate completed reporting windows: frames=5871, reused=4019, reused/frame=68.455118%. Output windows are separate from rolling cadence and not exactly coextensive with baseline samples. ~20Hz encoded/output cadence does not imply ~20Hz fresh screenshot capture; last fresh capture rolling rate 6.147616Hz.

encoder.encode.avgMs: n=60, min=3.067000, max=5.220000, arithmetic mean=3.905050

encoder.encode.maxMs: n=60, min=6.547000, max=138.295000, arithmetic mean=15.150850

encoder.encode.p95Ms: n=60, min=4.561000, max=8.882000, arithmetic mean=6.132967

encoder.encode.count: n=60, min=96.000000, max=100.000000, arithmetic mean=98.066667

Encoding weighted mean across disjoint emitted windows=sum(avgMs×count)/sum(count)=3.9048863018354867ms; counts=5884. Window p95 ranges are not full-run p95.

## Limits and warnings

No sustained three-hour test, fault recovery, native action, application-after-input frame, physical visibility or source-pixel-age measurement. Host cadence rolling windows overlap; per-window means/maxima cannot yield per-frame full-run percentiles. Process/resource snapshots are sampled; no profiler/thread scheduling/GIL trace or controlled competing cause experiment exists. Existing warning text outside selected window is excluded; no global warning-free claim. Actual baseline still failed cleanup-incomplete regardless of passive media continuity.

Selected window severity WARNING/ERROR/CRITICAL lines: 12. This count is limited to frozen timestamp-matched lines, not an exhaustive lifetime claim.

Warnings: 1 candidate-buffering-before-PC-readiness record plus 11 sampled host_event_loop_lag warning records (23:19:00–23:19:56 CST). The repeated maxLagMs=68.533 is a retained window maximum, not 11 independently established 68.533ms stalls. No ERROR/CRITICAL timestamp-matched records.
