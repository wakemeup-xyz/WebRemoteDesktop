# Rolling 72-hour runtime evidence review — fixed at 2026-10-18 17:14:25 CST

## Findings first

1. **This is a newly calculated rolling window, but Host raw coverage is incomplete.** The fixed half-open window is **2026-10-15 17:14:25.468 CST ≤ t < 2026-10-18 17:14:25.468 CST**, exactly 72 hours. Current Host plus three rotations retain only **2026-10-17 13:03:07.051 CST–2026-10-18 17:14:25.031 CST**: the first **43h48m41.583s** (157721.582524s) of requested raw Host history is absent, with a 0.437476s suffix after the final retained row. Historical sanitized reports preserve some earlier evidence, but cannot reconstruct the missing raw period or support a full-window Host incident rate/P95. This replaces neither the older fixed three-day audit nor the unchanged 15:03–16:24 audit.
2. **No new Viewer/Host socket close or restart event is observed after 15:03 through this window's upper bound.** Signal's last structured socket close is 15:01:15.853. The 1,416 later Host lag summaries remain idle: PC none, capture sequence/input count/waiters zero and JPEG relay false. Direct last-sample lag now reaches **415.563ms at 16:25:48.453**; rolling maximum reaches **468.805ms at 16:26:39.202**. The prior audit's 187.090/346.185ms maxima remain correct for its earlier cutoff. This is passive log evidence, with no new live health claim.
3. **Historical stalls in the selected retained suffix remain substantial and cross active/idle states.** Among 18,090 distinct retained Host lag rows, 202 direct `lagMs` reports reach one second (191 on Oct17, 11 on Oct18). Maximum is **40,126.976ms at Oct17 13:41:26.475**, with PC none, capture sequence0, JPEG relay false and input waiters0. This supports that active media/input queues were not necessary for that particular stall. It does not identify OS/GIL/I/O/native causality. The later combined interval since Oct18 03:29:32 has 8,878 summaries, maximum direct/rolling lag883.333ms and no direct one-second report; versions and system workload changed, so this is not a controlled performance comparison.
4. **There are real later infrastructure events, separate from the first 15:01 close.** At Oct18 **16:20:22–16:20:27**, seven connector rows describe one lower-level edge connection loss/serve error/retry/termination and HTTP/2 registration, without a process-start or whole-tunnel restart marker. At **16:23:13**, a formal HTTP probe fails while origin succeeds; the next tick **16:24:21** is healthy, action none throughout. The connector previously had no events after12:56:05, so these later events do not establish the cause or hop of the earlier15:01 WebSocket close. The full rolling watcher selection has **3,927 unique primary status ticks**, 88 formal-failure observations (86 formal-down plus two historical restart-candidate ticks), and two origin-down observations. Counts describe samples, not user outages or an SLA.
5. **Control failures, expected cleanup and uncertain ownership must remain separate.** After exact record deduplication, Signal has114 structured socket-disconnect records:86 Viewer,28 Host. It also has eight reset-blocked records (last Oct17 13:24:59.086), two rebind-rejected records (Oct17 00:21:13.968/03:00:06.584), and nine positive reset-completed/applied/FREE records (Oct18 02:51:23.113–15:01:24.861). Existing authorized probes and maintenance account for some events, but the general log lacks sufficient per-session ownership evidence to classify all of them as human or probe. These are not114 user incidents. No new blocked reset or failed rebind is present in the later currently loaded Host interval.
6. **Input latency evidence is limited and cannot be replaced by media or heartbeat timing.** A retained Oct17 13:09:46.010 `Input timing` row reports total **8,647.0ms**, lock-wait0.0ms and `to_thread`8,646.9ms; this identifies the measured worker-await bracket, not pure network or native CPU. Separately103 structured Host input-result rows contain101 applied and two sequence-gap outcomes, with maximum adapter-await1,791.200ms and explicit queue-inclusive scope. Their different populations/boundaries must not be added. No new business ACK RTT, queue/apply split, applied fresh-frame, content-causal visible-effect or physical display measurement is available for the current idle interval; those remain null/NOT RUN.

## Selection, caps and source availability

The upper bound was fixed by the first command of this task at **2026-10-18T17:14:25.468476+08:00**; lower bound is **2026-10-15T17:14:25.468476+08:00**. Later-appended rows were excluded by timestamp even if included in the hashed file prefix. Files are mutable; source hashes below identify the exact first-pass byte prefixes, not current file hashes. No gzip/decompression was used.

Only exact documented paths were opened, using `O_NOFOLLOW` and regular-file checks. Source inventory was limited to explicit Host/Signal rotation candidates and `rg --files -g '*.json' /tmp/wrd-diag`. Signal `.1/.2/.3` candidates were absent; this alone does not establish lost Signal history because the existing Signal file starts before the requested window. No broad filesystem crawl, config/credential read, service/status command, endpoint, browser, native OS search, build, test or subagent was used.

The first full log pass streamed **50,729,229 bytes**. Accounted bounded analysis/re-read passes total **197,109,717 bytes**; a separate8MiB conservative allowance covers schema/metadata inspections, giving **≤205,498,325 bytes** total, below256MiB. The largest accumulated known file read is five10,485,726-byte Host-rotation prefixes (52,428,630bytes), below64MiB/file; no single snapshot exceeds10,485,726bytes. No source cap was reached. Coverage remains incomplete because of retention and observation semantics, not because the selected current files were capped.

| Source | Exact hashed prefix bytes `[0,n)` | Selected dated rows | First–last selected timestamp (CST) | SHA-256 |
|---|---:|---:|---|---|
| `/Users/macstudio1/AI/Claude/WebRemoteDesktop/back-debug.log.3` | 10484593 | 18318 | 10-17 13:03:07.051 – 10-17 23:56:20.554 | `16bc0154f1f21bc3a032f0c6f0d9c86d27432fe1d0cf5389767f880915b2ceea` |
| `/Users/macstudio1/AI/Claude/WebRemoteDesktop/back-debug.log.2` | 10485726 | 24327 | 10-17 23:56:26.065 – 10-18 06:17:52.248 | `e96edc5f57ada28ccaf7c4eb06d6de65ad83c136c769912a28c4932f00b488b6` |
| `/Users/macstudio1/AI/Claude/WebRemoteDesktop/back-debug.log.1` | 10485058 | 21262 | 10-18 06:17:52.371 – 10-18 12:59:02.806 | `f0b10f8a840c26133e31c372b34aeea5e3c7e41b23bc379854a9623d2aa1e91c` |
| `/Users/macstudio1/AI/Claude/WebRemoteDesktop/back-debug.log` | 6552312 | 4813 | 10-18 12:59:07.806 – 10-18 17:14:25.031 | `267a9e454fefba844d605379b02069af591723a49fb2c2ee15379c1ead21a460` |
| `/tmp/signal-server.log` | 3124413 | 3439 | 10-15 17:34:25.052 – 10-18 17:14:14.835 | `ce7708437bef8a2b3cac09a775ab841060382b6fba53d1d8e13ec0a2d180b5fa` |
| `/tmp/wrd-fixed-domain.log` | 548908 | 406 | 10-15 23:23:12.000 – 10-18 16:20:27.000 | `10dc6d711dab44cbc147b7dc45ed4be1042bed5ca16cd1387e8883756a145256` |
| `/tmp/wrd-fixed-watch.log` | 1903458 | 3929 | 10-15 17:15:24.000 – 10-18 17:13:22.000 | `5aed9645fbb51aee2ad8d8c71524a80b2c72e1dc068016c475fa6c48bd2eb1dc` |
| `/tmp/wrd-fixed-watch-launch.log` | 7144761 | 3969 | 10-15 17:15:24.000 – 10-18 17:13:22.000 | `37a6db9b87d9ffbc58220d3ba9e999316c9adefa7f57584b6dcf20f0042bc8ae` |

Host raw line hashes remove23 exact duplicates, leaving **68,697 distinct dated rows**; equivalent facts in plain text and structured JSON are still overlapping views and are not added as incidents. Signal projection uses explicit top-level inspected-object `ts/event` fields and limits each record at its top-level closing brace. It selects3,439 raw structured records and3,431 exact record fingerprints, removing eight repeated objects. Nested historical coverage timestamps are not treated as new event time. Unknown event rows remain98 after deduplication; earlier reason logging was less complete.

Host raw file prefix missing from this rolling window is **43h48m41.583s**. The earlier tracked three-day report contains sanitized Host evidence overlapping the beginning of this new window through Oct17 02:15; its old whole-window counts cannot be reused as counts for this new lower bound. Later follow-up reports preserve bounded observations from parts of Oct17 02:15–13:03, including severe load/lag; no complete replacement raw stream is claimed for that gap. A dated first/last event in Signal/connector is an event span, not continuous sampling coverage. Watcher is a discrete HTTP stream with explicit inter-tick gaps; the largest is398s across the historical recovery action.

## Connectivity/control counts and interpretation

| Role | Origin-observed close reason | Distinct timestamped records |
|---|---|---:|
| viewer | transport close | 30 |
| viewer | ping timeout | 46 |
| viewer | server namespace disconnect | 8 |
| host | transport close | 9 |
| viewer | transport error | 2 |
| host | ping timeout | 18 |
| host | transport error | 1 |

Host ping-timeout records end **Oct18 00:04:08.169**, which the existing signaling-fallback report independently associates with a failed authorized passive probe. Later Host transport-close rows at02:44:19.128,03:29:32.513 and14:32:28.381 align documented local reload windows. Time alignment is supporting context; this audit did not verify live process ownership or retroactively label every socket. The older cluster of18 Host ping-timeout records spans several loaded versions and is distinct from the newest15:01 Viewer transport-close, which was not a ping-timeout classification.

Signal also records253 `control_transition_failed_closed` events:149 lease-expired,45 released,34 controller-disconnect,22 transition-timeout,2 rebind-rejected and1 stale-transition. There are123 exact retry records, eight blocked records and nine positive completions. A fail-closed transition is a safety state transition and can precede successful reset; it is not a permanent-failure count. Retry attempts and overlapping cleanup are not separate user incidents. Recorded epoch values restart/reuse across process lifetimes; this report therefore does not convert global distinct numeric epoch counts into session/incident counts.

Reset-blocked timestamps (CST): Oct16 02:17:51.244; Oct17 01:09:52.948,03:06:16.684,03:31:29.078,03:34:51.681,03:42:34.774,13:17:46.606,13:24:59.086. Rebind confirmations total8 and failed rebinds2, with event fingerprints deduplicated. No claim is made that eight confirmations represent eight unique human users.

The tracked latest executions prove which short/long probe runs were authorized. In particular, Oct18 current-Host shortA INCOMPLETE (browser-close timeout), shortB PASS and longA approximately36seconds INCOMPLETE are known owned runs; the longA first abnormal browser close preceded cleanup. Their subsequent8-second grace/reset retry is not a new unowned disconnect. The earlier version's separate3-hour PASS is retained only for that version. General rows outside such established provenance remain **ownership unknown**.

## HTTP watcher and connector observations

| Date (partial first/last day) | healthy | formal-down | historical restart candidate | origin-down |
|---|---:|---:|---:|---:|
| 2026-10-15 | 377 | 2 | 0 | 0 |
| 2026-10-16 | 1321 | 7 | 2 | 0 |
| 2026-10-17 | 1190 | 75 | 0 | 2 |
| 2026-10-18 | 949 | 2 | 0 | 0 |

There are3,927 primary status samples, two separate recovery-end lines and72 contiguous *sampled formal-failure groups*, maximum five consecutive failed ticks. Those groups are not outage counts or measured downtime. The LaunchAgent log duplicates all3,927 primary status projections, repeats six of its own projected rows and contains one additional unmatched status row plus other dated command output; it is not added to the primary probe denominator. The unmatched historical row does not establish a new HTTP probe.

Two `action=restart` records at Oct16 19:37:46 and19:44:24 belong to the previously installed watcher. This task did not invoke them or any lifecycle action. Two origin-down ticks occur Oct17 03:45:03 and13:45:10; they do not authorize or prove a tunnel fault. The formal16:23:13 failed observation is followed by healthy16:24:21; actual outage duration and HTTP/DNS/proxy cause are unavailable in this old watcher schema. HTTP success cannot establish persistent WebSocket survival, control ACKs or fresh desktop content.

The connector has406 selected dated event rows. Fixed phrase counts include41 registrations,29 edge-loss lines,35 serve-error/retry/termination lines each,20 origin-refused lines, and two process-start markers; multiple lines can describe the same lower-level event. This audit does not sum them into failures. Some origin-refused rows coincide with documented local maintenance; absence of a refusal or DNS error does not prove continuous path health. The newest16:20 reconnection covers one lower-level connection, not all connector capacity or the whole site. No new affirmative evidence attributes the earlier15:01 close to Cloudflare, sleep, a particular network hop or a heartbeat expiry.

## Host performance and input-to-picture limits

The retained raw Host suffix contains18,090 lag summaries, not all1Hz tick values. Direct current-lag samples are kept separate from rolling60-second maximum/P95 fields; repeated maxima are not independent stalls. Maxima and selected counts by date are:

| Raw retained date | Lag rows | Direct reports≥1s | Maximum direct lag |
|---|---:|---:|---:|
| Oct17 (from13:03) | 6,960 | 191 |40,126.976ms |
| Oct18 (to17:14:25) |11,130|11|7,641.923ms |

After03:29:32 across the later loaded intervals,8,878 rows show no direct≥1s report; maximum883.333ms is at13:13:32.699. In the current Host interval from14:32:28,1,739 rows have direct max554.212ms (14:41:05.558), rolling max690.282ms, no direct≥1s, and no nonzero input count/waiters. This contains120 active/connecting capture rows from the owned probes; after15:03 all1,416 selected rows are idle. These comparisons retain version/load confounding and are not an SLO or causal effect of a single fix.

There are3,284 logged capture-stat windows from Oct17 13:09:46.167 to Oct18 15:01:20.743, reporting288,965 outputs and165,442 reused outputs (**57.253%** of those reported outputs). These are mixed-version window counters, not unique physical fresh desktop captures. Maximum window-mean `recv_total` is16,072.9ms at Oct17 13:40:16.771; this bracket includes pacing/waiting and is not pure grab/encode/network time. Independent capture observation maxima are5,137.551ms current in-flight age,5,060.568ms last completed duration and5,938.428ms rolling/lifetime maximum; repeated maxima are not additional capture stalls.

The current-cadence raw fields retain a maximum paired interval1,595.024ms and grab1,586.578ms, consistent with the already tracked shortA; they are not a new distinct stall or a full-session percentile. Logged output reuse and uninterrupted rVFC do not prove20 fresh desktop changes per second. Current idle periods have no active capture, so no capture-rate benchmark is derived from them.

Input timing remains separated by boundary:

| Boundary | New rolling selection can establish | Cannot establish / missing |
|---|---|---|
| Business ACK RTT | Earlier preserved paired examples lie within the new window, but this audit has no new complete per-input Viewer ACK stream | Current version last/P95=null; no pure one-way network time or overall72h ACK distribution |
| Host adapter-await |103 structured result rows (Oct17 13:09:34.386–13:38:24.715):101 applied/2 sequence-gap,89 DC/14 Socket; maximum1,791.200ms, queue-inclusive | Different population from210 plain timing rows; not pure native CPU and not added to them |
| Plain Host input timing |210 rows, lock-wait max0.0ms; total max8,647.0ms and worker-await max8,646.9ms at13:09:46.010 | Zero observed lock-wait does not prove zero event-loop/worker queueing or exclude the older lost minute-level backlog |
| Host queue vs apply | Structured old adapter bracket says it includes queue wait | No trustworthy current per-input split; values null |
| Applied fresh-frame | Existing reports describe controlled metadata/capture boundaries, but the latest passive runs sent no business input | Current causal applied-input→fresh-frame samples0; null/NOT RUN |
| Content-causal visible effect | No new controlled-content evidence | null/NOT RUN; a frame callback alone is insufficient |
| Physical display effect | No optical evidence | null/NOT RUN |

Ownership of the Oct17 input rows is unknown from this selection; resets/moves/keys in a Host log do not prove human use or a completed native-input qualification. The two sequence-gap results must not be treated as successful application. No phase percentiles are summed, candidate RTT is not paired to a different historical input, and threshold rows are not used to invent an overall latency distribution.

## Diagnostic receipts and missing detail

Bounded inventory found **three JSON files** in `/tmp/wrd-diag`,15,681bytes total: **two full receipts** and **one derived ended-scope snapshot**, which was excluded as an additional receipt. Current full receipts are Oct17 22:07:43.434 (manual) and22:09:27.004 (dc-stuck), with distinct in-memory diagnostic identities. No raw identities or filenames are retained. The old sanitized Viewer report contributes62 in-window records after its source-hash deduplication. Receipt time ranges do not overlap, giving **64 retained receipt records**, not64 incidents: paint-pending19,input-ACK-timeout23,pc-failed3,dc-error4,ice-disconnected4,dc-stuck8,unspecified3.

Retained receipt timestamps span Oct15 17:34:47.523–Oct17 22:09:27.004; there is no retained receipt for the final **19h04m58.464s** of this window. This is missing receipt detail, not proof that no reports were attempted, users were absent or the site was healthy. Signal records357 upload-summary events without a usable diagnostic identity in that schema; they cannot be deduplicated into357 unique reports or added to64 receipts. One new-format current receipt's six business-input metrics all have count0 and last/P50/P95 null; the manual receipt has no such metrics. Old diagnosis reasons/metrics are not relabeled as new incidents or current-version performance.

## Loaded-version anchors, not current Git TIP

The following are **documented runtime anchors**, not a claim of complete version identification between every event. Boundaries that the records do not identify remain unknown. All timing/counts above span versions unless explicitly sliced.

| Documented CST anchor / interval | Actually recorded loaded code/build | Interpretation |
|---|---|---|
| Oct15 lower bound through early Oct17 | Full per-event loaded identity unavailable in old retained diagnostics; old reports document maintenance/fixes | Do not assign today's Host/build or branch TIP to these rows |
| Oct17 ~07:33/07:56,08:53,10:39 | Reviewed initial rollout then Host startup fix; builds7cdeb3e918582f7c → b73325b8166441a6 → f5c2a9203e47f9e5; subsequent c30530f331a4def5 | Several known local reloads; exact intermediate intervals are documented incompletely here |
| Oct17 14:47 /15:15 | Hoste279060 then auth/image-epoch packageafd598a, Host83c513e/Signale996467; builda6e8b15122bde656 | Earlier long-run failures belong to these loaded versions, not current c239482 |
| Oct17 22:06:22/28 | Reviewed evidence incrementdb5d2b1; build067dfc41e8374b4e | Entry/capture/receipt schema changed, old/new event rates not directly comparable |
| Oct17 23:58:09 | Signal-only f4202b7 (productd27dbb2); build07ad960b331ccc4b; same earlier Host | Host00:04:08 heartbeat failure was observed on this interval |
| Oct18 02:44:12/19 |93f3908, builded92d1313adb54f6, local Signal/Host reload | Known short run INCOMPLETE from browser-close timeout; frame-gap evidence remains separate |
| Oct18 03:29:32 →14:32:28 Host | Reviewedc583250 resource-isolation candidate; Host retained through later Signal-only reloads | Later combined raw lag suffix has no direct≥1s reports; causal attribution remains unproved |
| Oct18 04:13:16 →04:40:06 Viewer/Signal | bootstrap-ready build6b2ad956f6a6cdd8 | First reload stayed INDETERMINATE; not upgraded by later readiness |
| Oct18 04:40:06 →window upper Viewer/Signal |53ed5d7/build79bf9a5afea0458e | Separate old-Host3-hour passive PASS; real input/ordinary recovery unqualified |
| Oct18 14:32:28 →window upper Host | Loaded productc239482, runtime packagee5927c7; samebuild79 | shortA INCOMPLETE, shortB PASS, longA~36s INCOMPLETE; new source fixes under development are **not deployed evidence** |

Existing clean references: `2026-10-17-three-day-review-and-solution.md` and its `evidence/2026-10-17-three-day-review/{summary,host,signal-entry,viewer}.json`; `2026-10-17-remediation-execution.md`; `2026-10-17-evening-connectivity-followup.md`; `2026-10-17-signaling-timeout-fallback-review.md`; `2026-10-18-slow-start-idle-io-rollout.md`; `2026-10-18-resource-isolation-execution.md`; `2026-10-18-bootstrap-ready-execution.md`; `2026-10-18-verified-warmup-execution.md`; `2026-10-18-host-cadence-cleanup-execution.md`; and `2026-10-17-transport-input-to-frame-diagnosis.md`, all under `docs/superpowers/reports/`. Their original fixed windows, failures, uncertainty and NOT RUN statuses remain intact.

Only `/tmp/wrd-rolling-72h-runtime-review-20261018.md` and its whitelisted summary JSON were written. No repo/source/index or previous audit file was modified. This report establishes observed evidence and gaps, with **no live health, full72h uptime, current-input performance or first-WS root-cause claim**.
