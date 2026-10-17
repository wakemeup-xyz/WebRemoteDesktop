# Active long-run first 4s media gap — bounded read-only diagnosis

The first completed 4033.276ms rVFC gap appears at tick802, not tick814. The browser decoder, received-byte counter and rVFC counters stop advancing during ticks798–801 while Socket/PC/control/path identities remain stable. Strong concurrent Host evidence establishes local degradation: a latest event-loop lag of2710.327ms with two missed samples at11:55:37.271, reduced capture/output progress, and subsequent encoder calls up to928.125ms. This is materially stronger than the earlier five-minute report's resource correlation. It does not identify the blocking source or prove all4033ms come from one Host stage. Network-only attribution is unsupported; OS pressure versus application blocking versus additional transport effects remains unresolved.

The three-hour run remains ACTIVE according to the caller. This review neither stopped nor connected to it. Its final continuity verdict is not available; no PASS is claimed. Input, visible effect and optical/physical display remain NOT_RUN.

## Read boundary

Read the existing samples ticks740–840 inclusive only (101 observations, Python elapsed740.000335–840.001236s, browser performance.now754916.5–854917.0ms). Read the long-run start-offset file `/tmp/wrd-c5-rollout-private-ilovzfv1/heartbeat-longrun-start.json` and existing placeholder lifecycle/summary files. These last two are not finalized: lifecycle captureStatus=not-started, wall anchors=null, and summary remains its initial INCOMPLETE/zero-sample placeholder. They cannot supply a current main-thread-lag/visibility state or terminal result.

Read Host log after verified inode42866929/offset8,207,482, bounded to a tail under1MB, and then restricted metrics to11:54:30–11:56:20 CST inclusive. The focused interval contains332 log lines:20 event-loop records,22 encoder samples,21 capture windows and111 VIEWER_STATS lines;0 sender WRD_FRAME_TRACE records. Sample/Host association uses matching RTT/buffer/counter patterns, not a shared clock anchor. Browser gap endpoints below remain in the browser's clock; Host records retain Host timestamps. No cross-clock subtraction is used as latency or exact causal alignment.

No source/index/runtime/network/browser/native/service/tunnel/dependency operations were performed. Only this0600 private report was written.

## Exact first gap and recovery

| Tick | Browser now ms | Decoded total | rVFC total | Frame age ms | Max completed gap ms | Buffer last / sample age ms |
|---:|---:|---:|---:|---:|---:|---:|
|797|811916.1|15019|14865|65.5|583.3|7.5 /493.8|
|798|812918.7|15023|14870|784.8|583.3|4.7 /477.1|
|799|813917.8|15023|14870|1783.9|583.3|4.7 /1477.6|
|800|814917.1|15023|14870|2783.2|583.3|4.7 /2477.0|
|801|815922.6|15023|14870|3788.7|583.3|4.7 /3482.3|
|802|816916.6|15030|14877|16.2|4033.276|0 /492.2|
|814|828940.8|15123|14965|24.2|4033.276|0.2 /518.5|

Last callback at ticks798–801 is812133.9ms. With the newly completed4033.276ms maximum, the first recovery callback is inferred near816167.176ms; tick802 subsequently contains seven callbacks ending at816900.4ms. The observer stores no per-callback metadata, so the inference is limited to these counters/maximum and rounding. In particular, the old583.3ms maximum remains unchanged while the current unfinished gap grows; it is not a measure of the still-open gap.

Received bytes are1,816,103 throughout ticks798–801; decoded15023 and callbacks14870 are unchanged. This is not simply continuing decoder output with fewer callbacks. Tick802 bytes recover to1,830,062. framesDropped stays0 throughout740–840. Zero dropped/lost counts cannot prove delivery continued when no packets arrive.

The low4.7ms buffer value during the stall is stale, as its sample age grows by about1s each tick. Host receives the corresponding zero-frame intervals with jitter_buffer=nullms around11:55:37.612/.698/.707. Therefore neither the stale4.7 nor later0.2ms value demonstrates a short end-to-end latency during the outage. Buffer averages for delivered units cannot measure intervals with no delivered frames.

| Browser sample span | Decoder rate | Callback rate |
|---|---:|---:|
|740→797,56.9996s|19.0528/s|18.9475/s|
|797→802,5.0005s|2.1998/s|2.3998/s|
|802→818,16.0069s|8.1215/s|7.6842/s|
|818→840,21.9935s|18.0963/s|17.9144/s|

This shows recovery followed by a roughly16s degraded phase, then improved delivery in the remaining bounded window. It is not a statement about later run health.

## Identity, client scheduling and visibility

All101 samples: scopeStable=true, Socket connected, PC connected/identity1, generation1, leaseEpoch3, mediaPhase active, inputAllowed=true; buildc30530f331a4def5. All path identities remainpath-1, relay/relay, UDP/UDP, relayProtocol UDP. No reconnect/identity/reset/lease change is evidenced.

All101 statuses are observed; external schedule lateness max2.371ms. Browser now advances and incremental Socket tx/flush diagnostic events continue during ticks798–801. This weighs against a continuous four-second main-thread stop covering the whole observed gap. It does not exclude shorter pauses or video/compositor-specific scheduling effects.

Across740–840 diagnostic deltas contain141tx/141flush,4rx/4ping/4pong events and no visibility/hide/show/freeze/resume/disconnect transition events. Their cursors report gap0/truncated=false but coverage remainspartial and the ring has discarded earlier events. There is no current exported visibility/focus state or client event-loop lag aggregate because lifecycle has not been finalized. Absence of a visibility event is not a verified visible-state measurement.

Browser candidate-RTT snapshot last ranges38–1272ms, buffer last0–38.1ms, decode interval mean0.565–2.1444ms. Buffer/decode sample age reaches3482.3ms. These are ranges of snapshot last values; their overlapping five-second p95s are not whole-run percentiles. The independent transport readout sometimes differs from the last application metric because they sample independently (e.g.tick802 transportRTT481ms versus metric last1272ms). None is input latency.

## Host proof of local degradation

| Host time CST | Evidence |
|---|---|
|11:55:28.798|CAPTURE output18.9fps; convert2.3ms; recv_total45.2ms|
|11:55:31.238|Encoder96calls, mean4.856ms,max26.381ms|
|11:55:31.553|Latest loop lag0.859ms; rolling max94.27ms; missed0; captureSeq7668|
|11:55:37.239|CAPTURE90outputs/40reuse,10.7fps; prior capture window ended11:55:28.798, so this window stretched~8.441s; recv_total86.5ms|
|11:55:37.271|Latest loop lag2710.327ms; missedSampleCount2; captureSeq7694|
|11:55:37.371|Encoder42calls, mean7.625ms,max109.791ms|
|11:55:42.244|CAPTURE68outputs/18reuse,13.6fps; convert8.4ms|
|11:55:42.640|Latest loop lag86.699ms; captureSeq7753|
|11:55:42.650|Encoder69calls, mean19.287ms,p9561.187ms,max116.49ms; one media-stalled recovery IDR|
|11:55:48.270|Latest loop lag716.784ms; captureSeq7765|
|11:55:48.288|CAPTURE11outputs/2reuse,1.8fps; convert116.4ms,recv_total408.6ms|
|11:55:48.447|Encoder10calls, mean117.686ms,p95/max928.125ms; one media-stalled recovery IDR|
|11:55:53.450|Encoder51calls, mean22.26ms,max363.912ms|
|11:55:53.553|Latest loop lag0.357ms; captureSeq7816; rolling max remains2710.327ms|

CaptureSeq7668→7694 is26new successful captures/5.718s (~4.55/s);7753→7765 is12/5.630s (~2.13/s). Thus Host capture/output degradation is also measured, rather than being inferred from rVFC alone. There is no actual MSS grab-duration/completion-gap/error aggregate in these logs. CAPTURE capture_wait=0 remains a placeholder, convert measures construction rather than screenshot acquisition, and recv_total includes pacing; none can locate the exact blocking operation.

The2710ms event is the latest lag at11:55:37.271, not merely an old rolling maximum. Later repetition of2710.327 in60s summaries is the same overlapping-window evidence and must not be counted as repeated2.7s stalls. The716.784ms latest lag at11:55:48.270 is a separate measured lag. Encoder timing includes encode/packetization, not executor wait or RTP send await; no sender stage trace was present. These logs establish local scheduling/media disruption but cannot sum stages into4033ms of browser delay.

## Resource and transport limits

The resource record attached to the first2710ms Host event is stale: age8679.98ms, with prior sample's swap counters retained. At11:55:42.640, a refreshed10.150s resource interval reports swap-in198,392,093.84B/s (~189.20MiB/s), swap-out111,423,723.09B/s (~106.26MiB/s), RSS212.88MiB versus392.34MiB at11:55:31.553. At11:55:48.270 it is retained with status=timeout and age9528.66ms, so these values must not be treated as a new independent current sample. At11:55:53.553 a10.009s interval reports swap-in350,143,623.54B/s (~333.92MiB/s), swap-out288,975,827.91B/s (~275.59MiB/s), RSS166.71MiB. At11:55:59.555 swap-out489,761,292.80B/s (~467.07MiB/s). memoryPressure isunknown throughout. These system resource counters and RSS changes support significant coincident pressure/variation but do not identify which process initiated it or prove the Host pause's cause.

Matched VIEWER_STATS around11:55:37 show zero decoded/received/packets and null buffer, followed by one decoded frame withRTT1272ms at11:55:38.076, thenRTT481ms at11:55:39.150. Later intervals reportRTT740/335/593ms and very low received-frame counts while Host output/encoder metrics are degraded. No lost/NACK burst accompanies the focused first-gap sequence; the zero-frame interval includes a PLI and two later encoder windows contain media-stalled IDRs. Those recovery actions follow the degradation; these data do not show an IDR storm preceding it. A delayed Host or endpoint can also accompany elevated WebRTC RTT; candidate RTT does not isolate network propagation.

## Actionable conclusion

A new source-code defect is not proved. Local Host disruption is now directly proved and is a necessary part of the diagnosis; treating the episode purely as TURN packet loss or a browser callback artifact would ignore that evidence. The strongest remaining discrimination is application/OS scheduling and memory pressure versus a blocking Host operation, plus any additional network delay. Stable identity only excludes observed path/PC replacement, not changing transport performance.

The next useful authorized observation is bounded Host call-stack/scheduler evidence or existing stage timing aligned within the Host clock, real screenshot duration/completion-gap/error aggregates and fresh/reused output counters, while retaining resource age/status and browser per-callback metadata. The current data support this investigation, not an untested FPS/bitrate/encoder/TURN change. The running session was preserved.
