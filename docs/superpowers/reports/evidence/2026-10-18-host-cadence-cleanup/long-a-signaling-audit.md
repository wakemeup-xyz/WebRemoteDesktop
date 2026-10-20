# Long-run A bounded signaling and Host audit

Run `host-cadence-long-20261018a` remains INCOMPLETE. The selected origin evidence does not establish a server heartbeat expiry as the initiating fault. It records one Viewer transport close at **15:01:15.853 CST**, 268 ms after the supplied failureGate timestamp, 163 ms after browser.close began and 41 ms after its supplied completion. Cloudflare causation cannot be inferred from a browser 1006 or this generic transport-close reason.

## Evidence window and filtering

Start/end metadata: `/tmp/wrd-c5-rollout-private-ilovzfv1/host-cadence-long-20261018a-start.json` and corresponding `-end.json`. Window: **2026-10-18 06:59:46.652132–07:03:29.437530 UTC**, 222.785388 s. Only the fixed byte increments below were read; inode/device matched both metadata boundaries. No rotation join, cap or missing selected bytes. Every offset was nonzero, so the first unknown line was conservatively dropped. Trailing newlines were complete. Unchanged rotated Host logs were not read. `/tmp/wrd-structured/host.jsonl` is absent at both boundaries; Host structured events are embedded in back-debug.log.

| Log | Selected bytes [start,end) | SHA-256 | Dropped first bytes / retained lines |
|---|---:|---|---:|
| /tmp/signal-server.log | [2979760,2987157) | fe7344868864003d3bc06e4d3cd7eb7f41a36b3212afce631098c52a9dc94a3c | 2 / 266 |
| /tmp/wrd-structured/signal-server.jsonl | [2990289,3004089) | a6c58a5d38d9994ff9abf1dc3e379cefca6afb6f379031ce271543b5867fc9d6 | 2920 / 10 |
| /Users/macstudio1/AI/Claude/WebRemoteDesktop/back-debug.log | [2757506,2901041) | e505c4cec01ce8c56617d2500ad8f579d8ed7ea62aab3694ac76c3f437091e87 | 2520 / 204 |

Human records were classified into fixed categories; structured JSON was projected to known events, fixed enums and bounded numeric/boolean values. Raw Viewer/session/attempt identities were compared only in memory and excluded from both outputs, together with input, coordinates, tokens, raw log templates and unknown exception text. The separate JSON contains exact selected-byte provenance, compact samples and source hashes.

## Chronology (CST, UTC+8)

- **15:00:26.454**: bootstrap served with Host online. Human Signal records contain one Viewer connection, one forwarded offer and later one Viewer disconnect; no Host connection/disconnect. One completed entry window reports one namespace acceptance, zero missing/invalid authentication. No subsequent reconnect acceptance appears before end.
- **15:00:32.969 (derived)**: heartbeat observer enrollment (`close wall - duration`). It is a proof Viewer with Engine observation attached. This is observer enrollment, not independently logged transport-open time.
- **15:00:35.276**: connection attempt bound, sequence 1, rebound true. **15:00:35.427**: Host receives offer; initial no-peer cleanup returns after 24.038 ms. **15:00:35.454**: Host presentation selected. In-memory equality confirms connected, disconnected, Host-offer and structured-bound/grace identities agree.
- **15:00:56.316 (derived from age)**: only server ping created/flushed. **15:00:57.142 (derived)**: one pong received; ring offsets have floor precision. No ring drops.
- **15:01:15.022**: last pre-failure Host sample remains grabbing/active, 387 attempted / 386 completed / 0 failed; last completion age34.807ms, last grab85.192ms, maximum grab407.989ms. Capture cadence385 intervals, rate9.77493Hz; maximum interval411.605645ms, of which grab407.988922ms. Sampled loop lag4.092ms, rolling maximum98.806ms, missed0.
- **15:01:15.585**: root-supplied failureGate observes socket/lease/input false while painted/ready true. **15:01:15.690–15.812**: root-supplied browser.close begins/completes.
- **15:01:15.853**: Signal structured Viewer disconnect reason **transport close**. Matching heartbeat finalizes from Engine source, not ping timeout. Counts: ping created/flushed/pong1/1/1; message incoming57/created9, flush9. Ping age19537ms, pong age18711ms; closed websocket, writable true, buffer0. Node snapshot age1699ms;60 samples, last1ms/max65ms/p954ms/missed0. Coverage partial with Engine true; no scan limit, invalid value, clipped counter or dropped ring.
- **15:01:15.854**: normal Viewer disconnect grace starts,8000ms. **15:01:21.018**: Host still grabbing,465 attempted /464 completed /0 failed, cadence10.20161Hz. This post-failure activity rules out immediate Host capture termination at failure, without proving every frame was sent or displayed.
- **15:01:23.856**: controller-disconnect reset-only barrier, lease epoch10. `control_transition_failed_closed` is a historical event name for normal barrier entry, not a timeout/failure assertion.
- **15:01:23.862**: Host cleanup sequence9 starts for control-transition with peer/track/sender present. **15:01:23.865–23.867**: overlapping sequence10 viewer-disconnected cleanup has no detached peer/track/sender and returns2.071ms with input reset applied. **15:01:23.920**: sequence9 returns57.565ms; peer closed, capture thread stopped, capture resource closed, join returned, executor shutdown requested. Its authorityCurrent is false; senderReleaseConfirmed remains null.
- **15:01:24.856**: first reset retry, same epoch10. **15:01:24.861**: reset completed applied/FREE. **15:01:27.018** onward: capture unavailable after the selected peer was removed.

## Findings and limits

Signal and Host remain the same processes/build in start/end metadata; both health checks are true, Host online, Viewer count0. Viewer epoch advances4→5. No selected Host ERROR/CRITICAL or traceback line;39 periodic Host loop summaries span14:59:52.017–15:03:24.156. All report missed0; whole-window rolling maximum136.332ms occurs well after cleanup. Active capture rolling loop maximum98.806ms. Samples are roughly5–6s apart with rolling60s loop windows; they cannot exclude a brief unsampled event or supply a complete frame latency distribution.

Capture is below target20fps in this session: nine active samples show roughly5.98–10.35Hz. Maximum sampled interval411.606ms is mostly grab408ms, with pacing requested/actual zero for that maximum interval. This supports capture cost as a performance issue, not a demonstrated signaling-close cause. No policy, quality or code change is attributed between the supplied successful B short run and this failure.

Engine.IO server options do not override ping defaults; the installed dependency source uses25000ms interval and20000ms timeout. Final server ping age19537ms is below that timeout, and the actual reason is transport close. The recorder records a ping flush, not network delivery. Browser receive timing and the initiating closure remain outside this audit.

A separate cleanup ownership risk is supported by exact source and sequence9/10 observations. `removeDesktopViewer` dispatches reset then emits zero-viewer status; Host control transition awaits detached-resource cleanup with preserved authority, while the zero-viewer-status handler invokes another cleanup that advances authority. The first invocation consequently records authorityCurrent=false, and `_apply_control_transition` can return before its first ACK. The observed retry reaches FREE. This secondary race cannot explain the failure8s earlier.

## Focused unchanged-code checks and next check

Read-only checks covered only heartbeat instrumentation, Signal disconnect/grace/reset dispatch, lease expiry semantics, Host cleanup/authority checks and installed Engine.IO defaults. The five product files listed in JSON have identical SHA-256 in primary/source worktrees. Relevant locations: viewer-heartbeat.js145–177 and196–211; signaling.js178–183,329–335,574–624,1961–2000; desktop-control-lease.js127–132,255–267; host.py3413–3489,3493–3644,5633–5646. No code changed and no test/build/import/service/process/network/browser/proof/tunnel action ran.

Next first check: correlate the browser Engine.IO heartbeat receipt/send and first close record **before failureGate** with the server ring; preserve bounded enum/timing evidence only. Separately validate the normal reset-plus-zero-status interleaving for first ACK suppression and detached-resource cleanup ownership. Do not treat the historical failed_closed event as a transition failure or rebuild a tunnel from this evidence.
