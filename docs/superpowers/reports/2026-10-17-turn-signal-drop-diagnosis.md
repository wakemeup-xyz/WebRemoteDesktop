# TURN passive run: first signaling disconnect diagnosis

Recorded 2026-10-17, Asia/Shanghai (+08:00). Read-only investigation. No production request, browser, Viewer, native input, service/config, tunnel or Git change was made. README, safe-startup runbook, webremote-service skill and relevant requirements were read. This file contains bounded summaries only.

## Conclusion

First observed failure is a Viewer signaling disconnect while TURN media remains live. Its initiating cause remains UNKNOWN. The current run does not establish a TURN transport failure, a server heartbeat timeout, or an ordinary-user automatic recovery defect. The 300-second run is INCOMPLETE at 173.094 seconds; three-hour continuity, active input and physical visible-effect acceptance remain NOT RUN.

Runtime/build supplied by parent investigation: reviewed runtime 8e375fa; sampled frontend build b73325b8166441a6. This investigation did not independently reconstruct historical executable versions from log lines. Current source was read only to explain concrete lifecycle paths.

## Evidence and ordering

Sources: /tmp/wrd-public-proof-timing-turn-20261017a/{summary.json,samples.jsonl}, primary back-debug.log, /tmp/signal-server.log, /tmp/wrd-fixed-domain.log, /tmp/wrd-fixed-watch.log and launch log. Source line numbers below refer to the files at inspection time.

- Host offer: 09:46:02.381; TURN allocation 09:46:03.179; ICE completed 09:46:04.736; PC connected 09:46:05.886; input channels received 09:46:06.090–06.093. These are establishment evidence, not successful active-control acceptance.
- Summary mtime 09:49:02.137701; samples mtime 09:49:02.050262. Summary elapsed includes final browser shutdown. Subtracting reported elapsed gives approximately 09:46:09.044 for the sampling baseline; this is an inferred wall-clock anchor, not an independently recorded start timestamp. Host's 09:46:09.338 stats report first nonzero decoding in this same neighborhood.
- Ticks 0–172 had signaling connected. Tick 172 at elapsed 172.0016s: callback count 1932, frame age 24.5ms, lease epoch 15.
- Tick 173 at elapsed 173.0009s: signaling disconnected, lease epoch 0 and inputAllowed false. PC identity, attempt hash equality, generation and selected relay path remain unchanged. PC still connected; callback count 1938; frame age 7.5ms; 3376 frames decoded; dropped frames 0; relay on both ends, UDP, latest candidate RTT 31ms. No raw identities are copied here.
- All 174 samples were obtained, with zero missing or late observations. Run-wide maximum frame gap 1899.9ms is not a measurement confined to the disconnect instant. It stayed below the proof's 5000ms threshold.
- Signal lines 66863–66874: 09:49:02.126 server records signal_socket_disconnected, role viewer, reason transport close. Line 66876 block: 09:49:02.128 viewer_disconnect_grace_started, graceMs 8000.
- Signal 09:49:10.132: control_transition_failed_closed, controller-disconnect, lease epoch advanced; 09:49:11.132 reset retry. Host 09:49:10.137 closes peer, 09:49:10.151 channels close, 09:49:10.167 TURN allocation deleted. This later media teardown follows grace expiry; it is not the initiating TURN failure.
- startupSummary controlState ACTIVE is stale/incomplete as an authority statement: the same end sample has lease epoch cleared and input disallowed. It cannot establish usable control after disconnect.

Important chronology limit: the final sample row was flushed before browser.close, and sample/summary read socketConnected false before that cleanup (scripts/passive_session_soak.py lines 331–348, 419–433). Thus the script did observe a disconnect before its intentional browser closure. However the server's transport-close timestamp falls within the same roughly 100ms ending/cleanup window; without browser event timestamps, this server record cannot independently distinguish the initial close from cleanup after a client-side timeout. Server transport close does not rule out a client ping timeout.

## Server, Host and formal entry window

There is no Host disconnect or new Viewer connection logged in the 09:46:00–09:49:11 Signal window. The only recorded Viewer disconnect in that window is the one above. Heartbeat ping/pong packets and a contemporaneous Node event-loop snapshot were not persisted in these inspected logs. Node's current engine.io defaults are pingInterval 25000ms/pingTimeout 20000ms; server.js does not override them. Defaults are configuration facts, not observed successful heartbeats.

Host's 09:48:35–09:49:04 sampled event-loop maxima are approximately 9.825–10.185ms, with normal severity and continued capture. Task/thread counts stay roughly 13–14 / 5; RSS approximately 340–348MiB. Earlier warmup windows had a 161.35ms rolling maximum and critical severity; that is not seconds-long blocking at disconnect. System load rose to 12.632 at 09:48:41 and was 10.492 at 09:48:59. It is a resource concern, but these values do not prove browser or Signal scheduling starvation. Host CPU-percentage resource values in this log are implausibly large and are not used as causal measurements. Host loop evidence cannot stand in for Signal or Chromium loop evidence.

Media had short decode stalls and recovery before the close: Host keyframe request/emission at 09:48:55 and 09:49:01; decoded progress and fresh callbacks resume. They show imperfect media continuity, but no demonstrated causal link to signaling closure.

Formal watcher: 09:45:02 formal-down/origin-up, action none; then 09:46:14, 09:47:20, 09:48:28 and 09:49:30 healthy, action none. The isolated failure precedes establishment, and sparse HTTP health successes neither verify nor exclude a transient WebSocket failure. No watcher restart is shown during this run. The active formal connector stdout/stderr both target /tmp/wrd-fixed-domain.log, whose mtime is 07:40:58.813951; it has no same-window records. Its old abrupt-request messages cannot be attributed to this incident.

## Recovery proof boundary

The passive runner aborts at the first identity change or socketDisconnected observation, then captures startupSummary and closes its own browser. The identity change count here is explained by lease epoch 15 to 0; it does not establish a new PC or new peer.

The page uses one-use proof admission. runtime-context.js lines 82–101 deletes its token at initial admission; signaling.js lines 1039–1049 rejects a replay. webrtc.js lines 2582–2595 retains proof-bearing page semantics, and buildSignalingSocketOptions sends the proof instead of an ordinary resume admission. A proof reconnect is therefore not equivalent to an ordinary authorized user's recovery. This run terminated before an 8-second recovery window could be observed anyway. Do not change product recovery or increase timeouts on this evidence alone.

Historical server ping-timeout records exist from 07:37:16 through 09:03:07 +08:00. They are earlier incidents and lack independently correlated browser/build/runtime identities in this investigation. They are not classified as the same failure and cannot explain the first close at 09:49:02.

## Smallest next evidence requirement

Before another already-authorized passive run, augment the local harness only with a bounded, redacted lifecycle ring. Capture browser monotonic and wall-clock anchor timestamps for Socket.IO disconnect reason, current Engine.IO transport type, engine close reason/details normalized to a fixed vocabulary, ping/pong freshness, reconnect_attempt/result, page visibility/freeze/resume and intentional harness-close boundary. Never persist URL, packet body, token, raw exception, socket/attempt ID or screen/input content. Save this ring before browser.close and record an explicit cleanup timestamp. Retain existing fail-on-first-disconnect semantics for a strict continuity proof.

If automatic user recovery is to be tested, it needs a distinct explicitly scoped ordinary-user recovery acceptance design, or a separately reviewed proof-specific non-takeover resume contract. Re-minting proof or silently escalating to ordinary human admission would defeat the current occupancy guard. Observe recovery separately from strict continuity; a successful recovery cannot retroactively make uninterrupted continuity pass.

Read-only companion evidence for that future run should correlate existing Signal observer metrics and both sides' heartbeat/transport lifecycle at disconnect using bounded summaries, plus connector events when available. Existing HTTP health alone is insufficient. Current evidence does not support a specific production fix; no restart, tunnel replacement, timeout increase, media-policy change or fail-open lease behavior is justified by this diagnosis.
