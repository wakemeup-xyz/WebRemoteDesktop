# Bounded current runtime log summary — 2026-10-19

The valid Host tail contains251 host_event_loop_lag root records inside the anchored requested hour:195 warning and56 info. Signal connection/control/grace/error counts are UNKNOWN because its text format did not match the root-object parser. Direct lagMs, rolling maxLagMs and rolling p95LagMs numerical summaries are each missing and remain null; no mixed extrema are used as a latency metric.

## Version, window and budget

Parent supplied the current version context: prior live Signal33747/Host36877; fefc/282 changes are not loaded. This task performed no process/source queries, so exact live commit/hash is null.

Sampling reference UTC: 2026-10-18T18:18:12.944571+00:00; Asia/Shanghai: 2026-10-19T02:18:12.944571+08:00. The requested hour starts 2026-10-18T17:18:12.944571+00:00. Capture/analysis completed 2026-10-18T18:18:47.390434+00:00.

The first attempt consumed one tail read per file at UTC18:11:34.465739 but retained only inode/offset metadata when stdin closure ended the memory-only analysis process. It is explicitly recorded as failed analysis, not a successful first sample. Parent then granted exactly one additional tail read per file, each at most1MiB; those supplemental reads were performed once and no further content read followed. Raw tails were never written to disk.

Signal capture/analysis preceded Host acquisition. Five Host records later than the reference instant were excluded from the anchored-hour counts; that is sequential acquisition, not demonstrated clock skew.

## Exact bounded file reads

| Log | Inode | Captured size | Read offset | Captured bytes | First complete-line offset | Complete bytes |
| --- | --- | --- | --- | --- | --- | --- |
| signal | 31830923 | 3694039 | 2645463 | 1048576 | 2645468 | 1048571 |
| host | 46264698 | 650354 | 0 | 650354 | 0 | 650354 |

Signal: /tmp/signal-server.log. Host: /Users/macstudio1/AI/Claude/WebRemoteDesktop/back-debug.log. Both inodes stayed stable and the paths still pointed to them after reading. No short read or UTF-8 replacement was observed. Signal dropped5 initial partial-line bytes; Host dropped0. Both dropped0 trailing partial-line bytes. Complete-line counts43357/256 are framing metadata and are not event counts. No historical prefix was scanned; Host was smaller than1MiB.

## Host observations: root counts and separate metric gaps

All256 valid captured Host JSON roots span 2026-10-18T17:54:50.702344+00:00–2026-10-18T18:18:41.499315+00:00. Exactly251 fall inside the anchored hour: 2026-10-18T17:54:50.702344+00:00–2026-10-18T18:18:12.715562+00:00. The leading2197.758 seconds of the requested hour are outside this timestamp extent. This tail covers about23 minutes; it is not a full-hour or long-session sample.

All251 accepted roots have event host_event_loop_lag, with195 warning/56 info levels. Those are root log-record counts, not251 lag samples, unique critical episodes or user-visible failures. The tail only contains this type of root event; it cannot show that the rest of the hour or another log had no input/control error. Whole-hour input-error, control-grace and connection-failure conclusions remain null.

| Metric | Meaning | Per-field count | Per-field max | Valid metric window |
| --- | --- | --- | --- | --- |
| lagMs | Direct instantaneous lag | null | null | null |
| maxLagMs | Rolling maximum lag | null | null | null |
| p95LagMs | Rolling percentile lag | null | null | null |

The initial extractor retained mixed lagMs/maxLagMs extrema and each root’s mixed maximum. Because it did not retain separate field counts/extrema/windows and the raw tail/process memory is gone, those values cannot be reconstructed within the exhausted budget. They have been removed from the numeric conclusions. This is an explicit observability/extraction gap. Repeated rolling values must never be counted as independent fresh spikes or combined with direct lagMs as one sample population. No per-field p95, distribution or independent-episode count is claimed.

Host event-loop-lag warnings are consistent with a scheduling-risk path that can delay ACK, reset/rebind and connection timers. They do not establish a numeric latency magnitude here, a specific user incident, whether that incident occurred during a session, or a sole cause.

## Signal format/parser mismatch

The Signal tail yielded0 accepted structured roots and7059 failed JSON candidates. Its text/root format was not supported by this parser. Date grouping found4022 unvalidated groups,179 inside the anchored hour; neither count is an event count. Token-only in-hour extent 2026-10-18T17:19:05.128000+00:00–2026-10-18T18:18:06.767000+00:00 is retained only as a parsing aid, not established event coverage. All Signal event/severity/connection/control-grace/error/unique-incident counts are null. This format mismatch is an observability gap. No second supplemental read or silent fallback to zero was performed.

## Attribution and six input-to-visible stages

Session occupancy and actor/trigger evidence are missing. A prior zero-viewer observation cannot establish a wholly idle hour, and cadence cannot establish automatic maintenance. User session, automatic maintenance and other workload attribution therefore remain unknown. Unloaded changes cannot be described as active or effective.

All six fields remain null: ACK round trip, Host queue, Host execution, applied-to-fresh-frame, browser frame presentation and true input-to-visible effect. These tails do not supply matched input correlation, browser paint or physical visible observation; lag, health or ACK must not substitute for another stage.

The parser checked synthetic framing before opening logs and filtered dated records against the anchored hour. JSON objects and plain continuations were grouped rather than counted by printing lines; only valid Host roots are used for event counts. No-zone timestamps were treated as Asia/Shanghai. Aggregate counters and nested diagnostics were not expanded into runtime event totals.

No raw messages, inputs, coordinates, Host IDs, passwords or diagnostic bodies were persisted. No lsof/netstat/ps/global process sampling, service or network command, source/index mutation, or historical-prefix read occurred. All permitted tail-read budgets are exhausted.

Detailed bounded JSON: /tmp/wrd-current-runtime-log-summary-20261019.json. Both artifacts are private0600.
