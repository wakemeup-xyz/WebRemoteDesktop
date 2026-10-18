# Current bounded runtime log summary v2 — 2026-10-19

The last authorized v2 sample now resolves both supported formats. Signal has60 complete entry_window/info roots during its selected hour. Host has373 complete loop-lag roots across about35 minutes:317 warning/56 info. Direct lagMs latest4.065ms and observed maximum3733.163ms are separate from rolling maxLagMs latest186.005ms and maximum3733.163ms. Exact p95LagMs is missing. Whole-hour connection/control failures, actor attribution and six true input-to-visible stages remain unproved.

This v2 uses complete standalone Node inspect objects and complete timestamp-framed Host JSON tails. All pure fixtures passed before the two new log-tail reads. Earlier failed/insufficient reports remain unchanged; this is a new final-budget sample. Root-record counts are not physical lines, native lag ticks, independent incidents or full-session acceptance.

Reference framer SHA256: f5cf60da046d4a512a43a22e34c676c47f82de5ebe164259f6cb9b4d076c6cba. Its code was read as source only; the old72h prefix reader was not executed. Runtime version context comes from parent: old Signal33747/Host36877 remains live, fefc/282 not loaded; exact live commit is unverified.

## signal

Status: BOUNDED_WHITELIST_SUMMARY. Path: /tmp/signal-server.log.

Device 16777220, inode 31830923, size before/after 3705391/3705391, read offset 2656815, bytes 1048576, first complete-line offset 2656820. Head/tail partial bytes discarded 5/0. Opened/path identity unchanged: True/True.

Requested per-log hour: 2026-10-18T17:29:39.598924+00:00–2026-10-18T18:29:39.598924+00:00. Selected complete roots: 60, observed 2026-10-18T17:30:05.621000+00:00–2026-10-18T18:29:08.319000+00:00. Leading requested-hour seconds outside the captured timestamp extent: 0. Timestamp extent is not proof of continuous event capture.

Event-name root counts: {"entry_window": 60}. Level counts: {"info": 60}.

Framing fragments: {"orphan_physical_lines": 60}. Missing/invalid record or field counters: {}. Physical lines are framing diagnostics only.

Whitelisted rows: /tmp/wrd-current-runtime-log-summary-v2-20261019-signal-whitelist.jsonl. Last allowlisted context: {"event": "entry_window", "level": "info", "meta": {}, "ts": "2026-10-18T18:29:08.319000+00:00"}.
## host

Status: BOUNDED_WHITELIST_SUMMARY. Path: /Users/macstudio1/AI/Claude/WebRemoteDesktop/back-debug.log.

Device 16777220, inode 46264698, size before/after 948666/948666, read offset 0, bytes 948666, first complete-line offset 0. Head/tail partial bytes discarded 0/0. Opened/path identity unchanged: True/True.

Requested per-log hour: 2026-10-18T17:29:40.268731+00:00–2026-10-18T18:29:40.268731+00:00. Selected complete roots: 373, observed 2026-10-18T17:54:50.703000+00:00–2026-10-18T18:29:39.518000+00:00. Leading requested-hour seconds outside the captured timestamp extent: 1510.434269. Timestamp extent is not proof of continuous event capture.

Event-name root counts: {"host_event_loop_lag": 373}. Level counts: {"info": 56, "warning": 317}.

Framing fragments: {}. Missing/invalid record or field counters: {"host_timestamp_block_without_complete_json": 2}. Physical lines are framing diagnostics only.

Whitelisted rows: /tmp/wrd-current-runtime-log-summary-v2-20261019-host-whitelist.jsonl. Last allowlisted context: {"event": "host_event_loop_lag", "level": "warning", "meta": {"captureSeq": 0, "iceState": "none", "inputEventCount": 0, "inputWaiters": 0, "lagMs": 4.065, "maxLagMs": 186.005, "pcState": "none", "relayRunning": false, "sampleCount": 61}, "ts": "2026-10-18T18:29:39.518000+00:00"}.

| Metric | Kind | Field-bearing root count | Max observed ms | Latest ms | First / last observed UTC |
| --- | --- | --- | --- | --- | --- |
| lagMs | direct value at the emission; latest and max over observed direct emissions only | 373 | 3733.163 | 4.065 | 2026-10-18T17:54:50.703000+00:00 / 2026-10-18T18:29:39.518000+00:00 |
| maxLagMs | rolling maximum carried by each log record; repeated values are not independent new spikes | 373 | 3733.163 | 186.005 | 2026-10-18T17:54:50.703000+00:00 / 2026-10-18T18:29:39.518000+00:00 |
| p95LagMs | rolling percentile carried by each log record; cannot stand for the full direct-sample distribution | 0 | None | None | None / None |

## Limits and retained failures

The initial18:11 read retained metadata only because stdin closure ended its process; the renewed18:18 sample retained Host event types but mixed direct/rolling fields and could not parse Signal inspect objects. Those shortcomings and their consumed reads are preserved in the earlier artifacts and this JSON provenance. No old result was silently replaced. This final explicit budget performs one new tail read per current log, at most1MiB each, with no automatic retry.

Node framing runs from an unindented standalone opening brace to an unindented standalone closing brace; only exact two-space ts/event/level and exact four-space allowlisted meta fields are extracted. Nested/quoted braces and nested fake fields were fixture-tested. Host authority is its outer timestamp; its JSON tail must parse completely. Truncated head/tail fragments and unsupported rows remain unknown. Only ts/event/level and the explicitly approved Host/Node meta fields are persisted; messages, inputs, coordinates, Host IDs, tokens and unknown fields are excluded.

Direct lagMs and rolling maxLagMs/p95LagMs are separate emitted-field populations. Rolling values can repeat across many roots and cannot be counted as independent spikes or used as a full direct-delay distribution. Missing values remain null. Host context can establish only the reported states at those instants; empty/no-peer states do not establish an entirely idle hour. Event-name selectors describe matching log roots, not actual user incident counts or automatic-maintenance attribution. Error-level or grace records require correlation before inferring visible control failure.

The six ACK/Host-queue/Host-execution/applied-to-frame/browser-presentation/true-visible fields all remain null: these logs do not provide correlated browser/physical visible observations. Scheduling lag can be a delay mechanism, but root records cannot prove sole cause or that unloaded fixes are active.

No health/ps/lsof/netstat query, service action, other log/config read, historical-prefix scan or source/index mutation occurred. Every artifact is private0600. Detailed finite JSON: /tmp/wrd-current-runtime-log-summary-v2-20261019.json.

## Final interpretation and finite artifact checks

Event counts and per-field count/max/latest were independently recomputed from the already saved whitelisted rows, without reopening either source log. Each saved row has only ts/event/level/meta, with exactly the approved per-source meta-key set; file sizes, hashes and private0600 modes matched. No message, input, coordinate, Host ID or token field was retained.

Six published direct lagMs observations reached at least1000ms;52 rolling maxLagMs emissions reached that threshold. These are two different populations and neither count is a count of unique real failures. The native tick/sample population and underlying rolling-window duration remain null. The p95LagMs field had0 valid numeric observations, so percentile value and observation window remain null rather than being inferred from another field.

Latest Host context at02:29:39.518 Asia/Shanghai has pcState/iceState none, inputEventCount0,relayRunning=false,captureSeq0,inputWaiters0. That supports only the reported instant’s peer/media/input state; it does not prove an idle hour or distinguish all user traffic from automated maintenance. Periodic entry_window telemetry is not60 connections.

Signal retains60 orphan physical boundary/framing lines; Host retains2 timestamp blocks without supported complete JSON. Those are unknown fragments/records, not counted as success or silently zeroed. Selected complete roots contained no matching connection, control-grace or input-processing-error event names, but unknown fragments, unmatched event vocabulary and Host’s missing leading25.17 minutes prevent a whole-hour negative claim.

The direct seconds-scale lag is a plausible source of delayed input ACK, reset/rebind or connection timers. These roots cannot establish a specific failed user session, identify the responsible workload, prove one sole cause, or certify the still-unloaded fefc/282 changes. All read budgets are exhausted; no further source-log or runtime read is performed.
