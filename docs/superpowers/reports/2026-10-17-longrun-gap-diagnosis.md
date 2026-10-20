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


# Finalized run and second threshold event — supersedes earlier ACTIVE status

The run is now stopped and finalized INCOMPLETE. Final summary: requested10800s, elapsed1922.498895s,1922samples (ticks0–1921),0missing,0late,0identity changes,97failedObservations, maximum no-progress5149.8ms. Root's stop record `/tmp/wrd-c5-rollout-private-ilovzfv1/longrun-owned-stop.json` records SIGINT to the owned soak PID19194 after verifying its script/output/start identity. Failure category is sampling/runtime/cancelled. This review performed no process action. Three-hour continuity was not met. Active control/visible effect/physical display remain NOT_RUN.

The97failedObservations are not97distinct stalls. In the newly inspected212rows1710–1921, tick1825 first crosses the5000ms limit with an unfinished frame age5132.1ms. Tick1826 first contains the completed5149.8ms gap. That cumulative maximum remains above threshold through1921: one open-gap failure at1825 plus96subsequent repeated cumulative-maximum failures equals97. The collector's continued sampling is not evidence of a false PASS. Per the caller's implementation check, ContinuitySummary correctly records the gap failure while collect_samples only auto-aborts missing/session-disconnect categories. The terminal INCOMPLETE does not satisfy continuity acceptance regardless of its later recovered frame progress.

## Second bounded evidence window

Read sample ticks1710–1921 inclusive and the final existing summary/lifecycle/owned-stop artifacts. Host log was read from the same verified inode42866929/long-run saved offset8,207,482, a bounded~1.53MB tail, then filtered to12:10:35–12:14:24 CST inclusive:698lines,42event-loop summaries,46encoder samples,45capture windows,224VIEWER_STATS and0sender frame traces. No source/index/runtime/service/network/browser/native/dependency operations occurred.

| Tick | Browser now ms | Decoder / callback totals | Received bytes | Frame age ms | Completed max gap ms | Buffer last / age ms |
|---:|---:|---:|---:|---:|---:|---:|
|1820|1834919.9|32879 /32484|4077731|126.9|4033.276|26.4 /494.5|
|1821|1835916.5|32879 /32484|4077731|1123.5|4033.276|19.6 /494.4|
|1822|1836918.4|32879 /32484|4077731|2125.4|4033.276|19.6 /1494.5|
|1823|1837918.1|32879 /32484|4077731|3125.1|4033.276|19.6 /2495.9|
|1824|1838980.9|32879 /32484|4077731|4187.9|4033.276|19.6 /3558.8|
|1825|1839925.1|32879 /32484|4077731|5132.1|4033.276|19.6 /4501.5|
|1826|1840917.7|32884 /32489|4086471|8.3|5149.8|0.5 /486.3|

The browser's last pre-gap callback is1834793ms; first recovery is inferred at1839942.8ms from that plus the completed5149.8ms maximum. Browser-clock stall duration is valid without wall-clock alignment. Tick1826 has five recovered callbacks ending1840909.4ms. As in the first event, bytes/decode/callbacks are all flat during the stall. Buffer/decode last values age rather than representing ongoing delivery.

All212rows retain stable Scope/Socket/PC/control/path: PCidentity1, generation1, leaseEpoch3, active/inputAllowed true, buildc30530f331a4def5, relay/relay UDP path-1. No identity transition is evidenced. All212statuses areobserved; maximum external lateness54.824ms. Diagnostic deltas contain only tx/flush/ping/pong, with no lifecycle transition events in this window.

Browser throughput before/after this event varies: ticks1710→1819 yield13.055decoded/s and12.835callbacks/s;1820→1826 only5decoded/5callbacks in5.9978s;1826→1840 recover to17.360/s each;1840→1921 yield18.741decoded/s and18.543callbacks/s. This is a later recovery, not removal of the failed gap. Final sampled frame age is10.4ms.

The now-finalized browser lifecycle reports visibility=visible, focus/online=true, hide/show/freeze/resume0, no disconnect event, maximum sampled main-thread lag88ms across1932probes, missedIntervals0. Coverage remains partial and old ring events are dropped. These are positive lifecycle/sampled-scheduling observations; they do not supply per-frame optical presentation or exclude sub-probe scheduling gaps. They supersede the earlier report's unavailable final client-lag/visibility information.

## Wall-clock discontinuity: do not align stages by subtraction

Final lifecycle supplies browserTimeOrigin1792208521258ms. A naive projection labels the second callback gap12:12:36.051–12:12:41.2008 CST. However Host log file order explicitly runs from encoder timestamp12:12:35.732 backwards to VIEWER_STATS12:12:31.801, and the subsequent matched buffer/RTT sequence continues on that earlier wall timeline. The matching Host zero-frame records are12:12:33.987/.34.791/.36.079/.36.937 and recovery12:12:37.855. The Host loop records also move from12:12:33.561 to12:12:35.324 while their resource/probe progression is consistent with a longer interval.

This is an observed wall-timestamp chronology discontinuity around the event. It is consistent with a wall-clock adjustment and/or record scheduling effects, but this review did not read OS time-change evidence and does not assert its mechanism. The fixed browser timeOrigin must therefore not be used as an exact contemporaneous Host wall-clock mapping across this interval. Do not calculate a negative pipeline time, treat an encoder window as preceding/following a callback solely by these wall labels, or use local log wall differences as a reliable window duration here. Monotonic browser durations remain the basis for5149.8ms and browser throughput.

CAPTURE's affected reported FPS/sleep/window durations consequently should be treated as reported values without interpreting them as a verified monotonic stage trace; this is a timing-observation question, not a source defect established by this review. No source formula was inspected in this new task.

## Host second-event evidence differs from the first event

Around the matched second stall, Host encoder/output metrics degrade again:

- Encoder12:12:35.732:98calls, mean4.961ms,max17.251ms; next12:12:36.908:only6calls, mean113.151ms,max/p95658.18ms; next12:12:42.037:68calls,mean16.492ms,max485.482ms, one media-stalled recovery IDR. The ordering of these records is preserved even though their wall labels have a discontinuity. These timings cover calls, not executor waits or RTP-send awaits; six slow calls alone cannot account for the full5.15s gap.
- CAPTURE12:12:37.036 reports87outputs/35reuse,FPS16.0,sleep82.5ms,convert4.2ms,recv_total95.1ms;12:12:42.047 reports68outputs/21reuse,FPS13.6,convert6.4ms,recv_total51.8ms. The excess reported sleep/recv averages are evidence to inspect alongside monotonic stage timings, not proof of a particular sleep/clock implementation bug.
- Nearby latest Host event-loop lags are0.327ms at12:12:33.561,5.676ms at12:12:35.324 and1.933ms at12:12:41.320. Their rolling max578.748→135.296ms and missedSampleCount0 do not show another2.7s main-loop stall at this event. The earlier first-gap mechanism cannot simply be assigned to the second gap. Across the wider new Host window, latest lag max578.748ms and rolling missed counts up to2 reflect other/overlapping events, not a measured5s block at the second event.
- CaptureSeq17490→17546→17598 across these loop records proves captures continue at the coarse probe boundaries. Because wall chronology changes and actual grab completion gaps are absent, no reliable per-second capture rate or allocation of the5s stall is inferred for this specific interval. It remains possible to have a capture gap inside a progressing coarse interval.

Resource evidence here has both fresh and stale samples. At12:12:35.324 a successful resource sample has elapsed5078.33ms, age884.73ms, swap-in256,453,619B/s (~244.57MiB/s),swap-out59,927,739B/s (~57.15MiB/s),RSS200.06MiB versus330.08MiB in the preceding12:12:33.561 record. At12:12:41.320 an independently refreshed successful sample has elapsed4947.97ms,age1932.93ms,swap-in375,628,684B/s (~358.23MiB/s),swap-out353,624,572B/s (~337.24MiB/s),RSS221.16MiB. System load1 remains62.933/66.301. These are coarse resource intervals near this incident, not instantaneous samples of a specific frame. memoryPressure isunknown. An earlier12:11:39.137 timeout has available=false and all resource rate/RSS valuesnull,age10201.95ms; those unknowns must remain unknown. No specific unrelated application is blamed for system swap/load.

The wider224VIEWER_STATS records report lost/dropped0 and total NACKincrement1; the matched five-second outage itself has zero received/decoded/packets and null buffer, then PLI/recovery. This again lacks a receiver lost/NACK burst explaining the event. Stable candidate path does not prove constant network quality. Encoder/resource degradation provides a local contributor candidate; absent sender timing and exact shared clock boundaries, additional network/receiver effects are unresolved.

## What actual evidence should come next

1. First preserve a monotonic boundary record for each relevant existing stage: real MSS grab start/completion/duration and exceptions; capture sequence completion gaps; fresh/reused output; executor submit/start/complete; encoder duration; RTP send start/finish/await duration. Use bounded aggregate windows and retain missingness. A wall-clock/monotonic anchor pair per window is necessary to recognize the chronology discontinuity; avoid changing media policy while measuring. Existing logs lack the real grab and sender-stage data, so another uninstrumented long run would repeat the same attribution limit.
2. A safe profiler is an optional complementary discriminator when the next authorized observation can capture the degraded interval: use a short bounded sample of the owned Host PID only, with aggregate stacks/timing and no screen/input/environment capture. It can distinguish time in native grab/encode, runnable/scheduling delay or waits; a profile missing the event cannot prove absence. Avoid profiling every application or allocating large continuous traces under existing resource pressure. No profiler was run in this review.
3. Choose a code fix only after a reproducible blocking boundary or erroneous timing/pacing decision is established. The first event proves a2.7s Host loop delay; the second proves a5.15s delivery gap plus slow encoder/resource variation without a matching multi-second loop probe. A general off-process redesign, capture-isolation repeat, FPS/bitrate/encoder change, or TURN change is not justified from these artifacts alone. Existing M3/M4 isolation and other-app ownership remain respected.

The result is a failed continuity criterion in an INCOMPLETE canceled run, with recovery afterward and concrete diagnostic gaps. It is neither a successful three-hour run nor97separate stalls, and it is not evidence of a false-PASS implementation defect.
