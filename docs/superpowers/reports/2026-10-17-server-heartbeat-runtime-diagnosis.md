# Server heartbeat observer: finalized300-second runtime diagnosis

2026-10-17, Asia/Shanghai(+08:00). Private read-only analysis of /tmp/wrd-public-server-heartbeat-turn-20261017a after parent notification of completion. No source/index/Git/runtime/browser/network/input/native/service/tunnel changes, extra probe, test server, subagent or polling loop. This report alone is written0600.

## Result and decision boundary

PASS for this300-second passive TURN continuity run only. Artifact summary elapsed is300.2120814549271s,301samples,0missing/late/failed/identity-change observations. Parent runner-reported300.212893s differs by under1ms; the artifact value is used here. Every sample has inputAllowed=true, but no active input was performed, so that is gate state rather than usable-input acceptance. Three-hour continuity is false; ordinary-user recovery, active control, physical display and visible-effect remain NOT RUN.

No evidence in this window blocks proceeding to a separately authorized longer passive run. It does not establish that the prior missing-heartbeat cause was repaired: S1 adds observability, and this window did not reproduce the failure. No recovery path was exercised. Do not describe the earlier93s client ping timeout as fixed on the strength of this pass.

## Runtime and evidence coverage

Parent-supplied implementation d1166ab, primary synced58ad766, local restart14.906s; expected Signal15135/Host15287 and unchanged connector84671/watch897. All301samples actually show buildc30530f331a4def5. This diagnosis makes no independent binary provenance claim beyond those observations.

Start checkpoint /tmp/wrd-c5-rollout-private-ilovzfv1/heartbeat-run-start.json has epochMs1792208067147, approximately11:34:27.147. All three current log inodes match and sizes exceed recorded offsets, so no rotation/truncation gap is observed. New bytes at analysis: Signal4104; connector0; Host258909 including post-cleanup telemetry. Correlation uses only offset-following Signal/Host records and same-window watcher entries; it does not combine earlier-runtime close events.

Client lifecycle coverage is partial at startup because socket/Manager/engine references did not exist until observer t1814. There is no schema failure, capacity marker or binding replacement; three bindings are initial enrollment. Existing periodic sampling/drains and final first-terminal sentinel are consistent with no close during the measured run. Final ring overwrote763 older event entries; counters and sample deltas retain the run evidence. Do not call the tail ring alone a complete event transcript.

## Client continuity and intentional cleanup

Last observed sample tick300 at elapsed300.000368s: socketConnected=true, PC connected, stable generation1/leaseEpoch1/attempt and relay path, input gate true, rVFC5377, framesDecoded5466,0droppedFrames, fresh-frame age13.1ms, relay candidates at both ends overUDP, latest candidate RTT28ms. Render callbacks advanced5374 after baseline. Run-wide max gap1000ms, below5000ms threshold; it is not an end-to-end visible-effect or input latency measurement.

Final observer firstDisconnectEvent=null; Socket disconnect/Engine close/Manager close counters all0; connect/reconnect errors and reconnect attempts0. Browser stays visible/online/focused, scheduler max lag10ms across309one-second callbacks,0missed intervals. Browser received11pings, created11pongs, with last ping/pong at observer t289287.

The preclose marker is t309918. This was recorded after successful sampling while the socket still read connected; the ordered final browser evaluation then stopped observer listeners before intentional browser.close. Its anchor1792208084787 associates preclose with approximately11:39:54.705. This is wall-time association only, not cross-clock latency. Python browser.close API returned closed in126ms; manager.stop returned ok in27ms. Cleanup status is api-finished-exit-unknown and ownedProcessExitEvidence=not-observed. Parent reports external runner session exited0, but API completion/runner exit alone is not adopted as ownership-linked proof of every browser child process exiting.

## The one new server close record

The offset-following Signal log contains exactly ONE WRD_SIGNAL_HEARTBEAT record, wallMs1792208395120 (11:39:55.120), source engine, reason transport-close, current=true, proof=true, observed duration305116ms. It is consistent with intentional browser teardown after the measured run, not an earlier heartbeat failure: the client observed no terminal event before its own preclose/stop and all final samples were connected. Server/client wall association differs by roughly415ms at this boundary; that number is not asserted as network latency or precise cross-clock ordering.

Server coverage: state partial (post-admission), engine=true, flushScanLimited=false, valueInvalid=false, counterClipped=false. Counts pingCreated11, pingInFlush11, pongReceived11, incoming messages408, created messages9, flush batches19. At terminal capture: WebSocket writable=true, writeBuffer length0, Engine readyState closed. The buffer was captured at terminal observation, not reconstructed from later cleanup.

At close, last pingCreated age21493ms, pingInFlush age21493ms, last received pong age20593ms. Under the unchanged25000ms post-pong interval, approximately4407ms remained before the next scheduled ping; absence of a twelfth ping at intentional close is expected and is not a missing-ping failure.

Server ring contains32of33heartbeat events (one oldest pc overwritten). Its first retained event is pf at t24177 followed by pr25055. The next TEN retained pc/pf pairs have equal floored millisecond times, and each is followed by a pr. Following received-pong-to-next-created-ping gaps are24999..25006ms across10intervals, consistent with the configured25000ms timer and timestamp flooring. Counts retain the eleventh initial pc even though its ring entry was overwritten. The last retained triplet is pc283622,pf283622,pr284522, all in this server observer's own monotonic domain.

Meaning is deliberately bounded: pc proves ping creation, pf proves inclusion in a flush batch BEFORE transport.send, and pr proves a pong reached this Engine callback. pf is handoff intent, not wire delivery; no cross-clock or nonce-matched RTT is claimed. Aggregate equal counts and observed ordering show the normal heartbeat boundary operating in this run, not elimination of intermittent path failures.

The same close record reused the existing Node observer: status ok, snapshot age3862ms,60samples, last lag1ms, maximum84ms, p95lag53ms, missed0. This is a fresh rolling Node scheduling window near close, not a full300-second trace and not proof that every heartbeat timer was perfectly punctual. It supplies no evidence of multi-second Node starvation at cleanup.

Signal records matching Viewer transport-close at11:39:55.120; grace8000ms begins11:39:55.121. Controller-disconnect cleanup at11:40:03.125 and reset retry11:40:04.126 follow the deliberate client departure. Host closes peer11:40:03.139, reports0Viewers11:40:03.143 and closes both input channels11:40:03.171. These later events are expected session cleanup, not acceptance failures inside the300s sample window. Host had301Viewer-stat reports from11:34:54.510 through11:39:54.370.

## Formal connector correlation and limits

Connector log inode is unchanged and has ZERO new bytes after the start offset: no new connector edge loss/re-registration/error event is recorded for this run. This is absence of logged events, not a continuously measured transport guarantee. Existing formal watcher samples at11:34:22,11:35:27,11:36:31,11:37:36,11:38:41 and11:39:47 all show origin_ok1/formal_ok1/actionnone;11:40:53 remains healthy after cleanup. Discrete HTTP health is additional context and does not substitute for the real observed Viewer continuity.

Previous I2's93.094s client ping timeout,45.003s missing inbound ping and coincident connector edge losses remain a different build/runtime/window. There was no S1 server heartbeat record for that failure. Today's normal pc/pf/pr sequence cannot retroactively decide whether its next ping was ungenerated, unflushed or lost downstream. The exact historical missing-ping origin/delivery boundary is still UNKNOWN.

For a longer authorized run, retain this same strict first-discontinuity rule, proof fencing and observer fields. A future failure now has server pc/pf/pr/coverage/transport/Node evidence available for boundary comparison. This pass justifies continuing evidence collection; it does not justify timer, transport, IP-family, tunnel, recovery or authority changes.
